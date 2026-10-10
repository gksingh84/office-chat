/**
 * Office-ChatBox — End-to-End Encryption (E2EE) Module
 * Powered by browser Web Crypto API (SubtleCrypto)
 * 
 * Cryptography Architecture:
 * - Room Chat: AES-256-GCM derived via PBKDF2 (100,000 iterations, SHA-256 salt)
 * - 1-on-1 Direct Messaging: ECDH (Elliptic-Curve Diffie-Hellman P-256) + AES-256-GCM
 * 
 * Zero Plaintext on Server: All text, images, and voice notes are encrypted
 * in the user's browser before being transmitted over Socket.io.
 */

const E2EE = (() => {
  const isSupported = !!(window.crypto && window.crypto.subtle);

  // Key Caches (In-Memory Only)
  const roomKeys = new Map(); // cacheKey -> CryptoKey (AES-GCM)
  const dmKeys = new Map();   // peerUsername (lowercase) -> CryptoKey (AES-GCM)
  
  let myKeyPair = null;       // { publicKey: CryptoKey, privateKey: CryptoKey }
  let myPublicKeyJWK = null;  // Exported JWK format sent to server for online colleagues

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  // Helper: Convert ArrayBuffer <-> Base64
  function bufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  function base64ToBuffer(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
  }

  // Helper: SHA-256 digest for deterministic salt
  async function sha256Bytes(text) {
    const data = encoder.encode(text);
    const hashBuffer = await window.crypto.subtle.digest('SHA-256', data);
    return new Uint8Array(hashBuffer);
  }

  /**
   * Initialize local ECDH P-256 Identity KeyPair for 1-on-1 Direct Messaging (Persisted per user)
   */
  async function initIdentityKeyPair(username = 'default') {
    if (!isSupported) return null;
    try {
      if (window.ChatDB && username) {
        const savedJWKs = await ChatDB.getUserKeys(username);
        if (savedJWKs && savedJWKs.publicJWK && savedJWKs.privateJWK) {
          const pubKey = await window.crypto.subtle.importKey(
            'jwk', savedJWKs.publicJWK, { name: 'ECDH', namedCurve: 'P-256' }, true, []
          );
          const privKey = await window.crypto.subtle.importKey(
            'jwk', savedJWKs.privateJWK, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveKey']
          );
          myKeyPair = { publicKey: pubKey, privateKey: privKey };
          myPublicKeyJWK = savedJWKs.publicJWK;
          return myPublicKeyJWK;
        }
      }

      myKeyPair = await window.crypto.subtle.generateKey(
        { name: 'ECDH', namedCurve: 'P-256' },
        true, // exportable public key
        ['deriveKey']
      );
      myPublicKeyJWK = await window.crypto.subtle.exportKey('jwk', myKeyPair.publicKey);
      const privJWK = await window.crypto.subtle.exportKey('jwk', myKeyPair.privateKey);

      if (window.ChatDB && username) {
        await ChatDB.saveUserKeys(username, { publicJWK: myPublicKeyJWK, privateJWK: privJWK });
      }
      return myPublicKeyJWK;
    } catch (e) {
      console.error('[E2EE] Failed to generate ECDH identity keypair:', e);
      return null;
    }
  }

  function getMyPublicKeyJWK() {
    return myPublicKeyJWK;
  }

  /**
   * Derive AES-256-GCM Key for a Chat Room using PBKDF2
   */
  async function getRoomKey(roomId, roomPasskey = '', appPasskey = 'passkey4321') {
    if (!isSupported) return null;
    const cleanRoomId = String(roomId || 'lobby').trim().toLowerCase();
    const cacheKey = `${cleanRoomId}:${roomPasskey}:${appPasskey}`;
    if (roomKeys.has(cacheKey)) return roomKeys.get(cacheKey);

    try {
      const passphrase = `room-secret:${appPasskey}:${roomPasskey}:${cleanRoomId}`;
      const salt = await sha256Bytes(`salt:${cleanRoomId}`);

      const baseKey = await window.crypto.subtle.importKey(
        'raw',
        encoder.encode(passphrase),
        'PBKDF2',
        false,
        ['deriveKey']
      );

      const aesKey = await window.crypto.subtle.deriveKey(
        {
          name: 'PBKDF2',
          salt: salt,
          iterations: 100000,
          hash: 'SHA-256'
        },
        baseKey,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt']
      );

      roomKeys.set(cacheKey, aesKey);
      return aesKey;
    } catch (e) {
      console.error(`[E2EE] Failed to derive PBKDF2 key for room ${roomId}:`, e);
      return null;
    }
  }

  /**
   * Derive Shared Secret AES-256-GCM Key for 1-on-1 Direct Messages using ECDH
   */
  async function getDMKey(peerUsername, peerPublicKeyJWK) {
    if (!isSupported || !myKeyPair || !peerPublicKeyJWK) return null;
    const cleanPeer = String(peerUsername).toLowerCase().trim();
    if (dmKeys.has(cleanPeer)) return dmKeys.get(cleanPeer);

    try {
      const importedPeerPublicKey = await window.crypto.subtle.importKey(
        'jwk',
        peerPublicKeyJWK,
        { name: 'ECDH', namedCurve: 'P-256' },
        false,
        []
      );

      const sharedAesKey = await window.crypto.subtle.deriveKey(
        {
          name: 'ECDH',
          public: importedPeerPublicKey
        },
        myKeyPair.privateKey,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt']
      );

      dmKeys.set(cleanPeer, sharedAesKey);
      return sharedAesKey;
    } catch (e) {
      console.error(`[E2EE] Failed to derive ECDH DM key for ${peerUsername}:`, e);
      return null;
    }
  }

  /**
   * Encrypt Payload Object { text, media, mediaType, mediaName } -> { ciphertext, iv, isEncrypted, algo }
   */
  async function encryptPayload(key, payloadObj) {
    if (!isSupported || !key) return null;
    try {
      const iv = window.crypto.getRandomValues(new Uint8Array(12)); // 96-bit IV for AES-GCM
      const jsonString = JSON.stringify(payloadObj);
      const encodedData = encoder.encode(jsonString);

      const encryptedBuffer = await window.crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: iv },
        key,
        encodedData
      );

      return {
        ciphertext: bufferToBase64(encryptedBuffer),
        iv: bufferToBase64(iv),
        isEncrypted: true,
        algo: 'AES-256-GCM'
      };
    } catch (e) {
      console.error('[E2EE] Encryption failed:', e);
      return null;
    }
  }

  /**
   * Decrypt Payload { ciphertext, iv } -> { text, media, mediaType, mediaName }
   */
  async function decryptPayload(key, encryptedPayload) {
    if (!isSupported || !key || !encryptedPayload || !encryptedPayload.ciphertext || !encryptedPayload.iv) {
      return null;
    }
    try {
      const ciphertextBuffer = base64ToBuffer(encryptedPayload.ciphertext);
      const ivBytes = new Uint8Array(base64ToBuffer(encryptedPayload.iv));

      const decryptedBuffer = await window.crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: ivBytes },
        key,
        ciphertextBuffer
      );

      const jsonString = decoder.decode(decryptedBuffer);
      return JSON.parse(jsonString);
    } catch (e) {
      console.warn('[E2EE] Decryption failed (key mismatch or corrupt data):', e);
      return null;
    }
  }

  return {
    isSupported,
    initIdentityKeyPair,
    getMyPublicKeyJWK,
    getRoomKey,
    getDMKey,
    encryptPayload,
    decryptPayload
  };
})();
