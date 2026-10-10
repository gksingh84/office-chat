/**
 * Office-ChatBox — Client-side Encrypted Persistent Storage (IndexedDB)
 * Stores chat history & ECDH identity keypairs locally on the user's device.
 * 
 * Privacy & Security Guarantee:
 * - History persists inside the user's browser database (IndexedDB).
 * - Messages remain encrypted with AES-256-GCM keys.
 * - Zero server storage required. History is deleted only when the user explicitly clicks "Burn" or "Clear".
 */

const ChatDB = (() => {
  const DB_NAME = 'OfficeChatBox_DB';
  const DB_VERSION = 1;
  let dbPromise = null;

  function initDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = (e) => {
        const db = e.target.result;

        // 1. Messages Store
        if (!db.objectStoreNames.contains('messages')) {
          const msgStore = db.createObjectStore('messages', { keyPath: 'id' });
          msgStore.createIndex('targetKey', 'targetKey', { unique: false });
          msgStore.createIndex('timestamp', 'timestamp', { unique: false });
        }

        // 2. User Keys Store (ECDH KeyPair retention per username)
        if (!db.objectStoreNames.contains('userKeys')) {
          db.createObjectStore('userKeys', { keyPath: 'username' });
        }
      };

      request.onsuccess = (e) => resolve(e.target.result);
      request.onerror = (e) => {
        console.error('[ChatDB] IndexedDB opening error:', e.target.error);
        reject(e.target.error);
      };
    });
    return dbPromise;
  }

  // Save or update a single message
  async function saveMessage(msg, targetKey) {
    try {
      const db = await initDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction('messages', 'readwrite');
        const store = tx.objectStore('messages');
        const item = { ...msg, targetKey: String(targetKey).toLowerCase() };
        const req = store.put(item);
        req.onsuccess = () => resolve(true);
        req.onerror = () => reject(req.error);
      });
    } catch (e) {
      console.error('[ChatDB] Failed to save message:', e);
    }
  }

  // Save batch of messages
  async function saveMessagesBatch(messages, targetKey) {
    try {
      const db = await initDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction('messages', 'readwrite');
        const store = tx.objectStore('messages');
        const cleanTarget = String(targetKey).toLowerCase();
        messages.forEach(m => store.put({ ...m, targetKey: cleanTarget }));
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => reject(tx.error);
      });
    } catch (e) {
      console.error('[ChatDB] Failed batch save:', e);
    }
  }

  // Retrieve stored messages for a specific room or DM target
  async function getMessagesForTarget(targetKey) {
    try {
      const db = await initDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction('messages', 'readonly');
        const store = tx.objectStore('messages');
        const index = store.index('targetKey');
        const cleanTarget = String(targetKey).toLowerCase();
        const req = index.getAll(cleanTarget);
        req.onsuccess = () => {
          const list = req.result || [];
          list.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
          resolve(list);
        };
        req.onerror = () => reject(req.error);
      });
    } catch (e) {
      console.error('[ChatDB] Failed to get messages:', e);
      return [];
    }
  }

  // Delete a message by ID
  async function deleteMessage(id) {
    try {
      const db = await initDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction('messages', 'readwrite');
        const store = tx.objectStore('messages');
        const req = store.delete(id);
        req.onsuccess = () => resolve(true);
        req.onerror = () => reject(req.error);
      });
    } catch (e) {
      console.error('[ChatDB] Failed to delete message:', e);
    }
  }

  // Clear messages for a room/DM target (when user clicks "Burn History")
  async function clearTargetMessages(targetKey) {
    try {
      const list = await getMessagesForTarget(targetKey);
      const db = await initDB();
      const tx = db.transaction('messages', 'readwrite');
      const store = tx.objectStore('messages');
      list.forEach(m => store.delete(m.id));
    } catch (e) {
      console.error('[ChatDB] Failed to clear target messages:', e);
    }
  }

  // Wipe all stored local history
  async function clearAllHistory() {
    try {
      const db = await initDB();
      const tx = db.transaction(['messages'], 'readwrite');
      tx.objectStore('messages').clear();
    } catch (e) {
      console.error('[ChatDB] Failed to clear all history:', e);
    }
  }

  // Save persistent ECDH keypair per user
  async function saveUserKeys(username, keyPairJWK) {
    try {
      const db = await initDB();
      const tx = db.transaction('userKeys', 'readwrite');
      tx.objectStore('userKeys').put({ username: String(username).toLowerCase(), keyPairJWK });
    } catch (e) {}
  }

  // Get persistent ECDH keypair per user
  async function getUserKeys(username) {
    try {
      const db = await initDB();
      return new Promise((resolve) => {
        const tx = db.transaction('userKeys', 'readonly');
        const req = tx.objectStore('userKeys').get(String(username).toLowerCase());
        req.onsuccess = () => resolve(req.result ? req.result.keyPairJWK : null);
        req.onerror = () => resolve(null);
      });
    } catch (e) {
      return null;
    }
  }

  return {
    saveMessage,
    saveMessagesBatch,
    getMessagesForTarget,
    deleteMessage,
    clearTargetMessages,
    clearAllHistory,
    saveUserKeys,
    getUserKeys
  };
})();
