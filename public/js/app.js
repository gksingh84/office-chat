/**
 * Office-ChatBox — Ephemeral Web Chat Application Logic
 * Pure ES6 Vanilla JavaScript + Socket.io Client
 */

document.addEventListener('DOMContentLoaded', () => {
  // Socket.io Instance
  let socket = null;

  // App State
  let currentUser = { id: null, username: null, passkey: null };
  let activeTarget = { type: 'room', id: 'lobby', name: 'Main Lounge' };
  let onlineUsers = [];
  let availableRooms = [];
  let typingTimer = null;
  let isRecordingAudio = false;
  let mediaRecorder = null;
  let audioChunks = [];
  let currentMediaAttachment = null;
  let currentRoomPasskey = '';

  // Client-side Storage for 1-on-1 Direct Messages (Persists on F5 refresh, wiped when tab closes)
  const dmStore = new Map(); // Key: lowerCasePeerUsername -> Array of msgObj
  const unreadDMs = new Map(); // Key: lowerCasePeerUsername -> count

  const SESSION_STORAGE_KEY = 'office_chatbox_session';
  const DM_STORAGE_KEY = 'office_chatbox_dm_store';

  const saveDMStore = () => {
    try {
      const obj = {};
      for (const [key, val] of dmStore.entries()) {
        obj[key] = val;
      }
      sessionStorage.setItem(DM_STORAGE_KEY, JSON.stringify(obj));
    } catch(e) {}
  };

  const loadDMStore = () => {
    try {
      const saved = sessionStorage.getItem(DM_STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        for (const [key, val] of Object.entries(parsed)) {
          dmStore.set(key, val);
        }
      }
    } catch(e) {}
  };

  loadDMStore();

  // Audio Synth Pop for incoming messages
  const playPopSound = () => {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(587.33, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.1);
      gain.gain.setValueAtTime(0.15, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.1);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.1);
    } catch (e) {}
  };

  // DOM Elements
  const authModal = document.getElementById('auth-modal');
  const authForm = document.getElementById('auth-form');
  const passkeyInput = document.getElementById('passkey-input');
  const usernameInput = document.getElementById('username-input');
  const authError = document.getElementById('auth-error');
  const errorText = document.getElementById('error-text');
  const togglePassBtn = document.getElementById('toggle-pass-btn');
  const btnLaunchPopoutLogin = document.getElementById('btn-launch-popout-login');

  const appContainer = document.getElementById('app-container');
  const sidebar = document.getElementById('sidebar');
  const mobileToggleSidebar = document.getElementById('mobile-toggle-sidebar');
  const btnPopoutApp = document.getElementById('btn-popout-app');
  const displayUserName = document.getElementById('display-user-name');
  const currentUserAvatar = document.getElementById('current-user-avatar');
  const onlineCount = document.getElementById('online-count');
  const roomsList = document.getElementById('rooms-list');
  const usersList = document.getElementById('users-list');

  const chatTitle = document.getElementById('chat-title');
  const chatSubtitle = document.getElementById('chat-subtitle');
  const chatTargetIcon = document.getElementById('chat-target-icon');
  const chatMessages = document.getElementById('chat-messages');

  const messageForm = document.getElementById('message-form');
  const messageInput = document.getElementById('message-input');
  const btnEmojiTrigger = document.getElementById('btn-emoji-trigger');
  const emojiPicker = document.getElementById('emoji-picker');
  const imageUpload = document.getElementById('image-upload');
  const btnVoiceRecord = document.getElementById('btn-voice-record');
  const mediaPreviewBar = document.getElementById('media-preview-bar');
  const previewImg = document.getElementById('preview-img');
  const previewAudio = document.getElementById('preview-audio');
  const previewFilename = document.getElementById('preview-filename');
  const btnCancelMedia = document.getElementById('btn-cancel-media');

  const typingIndicator = document.getElementById('typing-indicator');
  const typingText = document.getElementById('typing-text');
  const btnBurnChat = document.getElementById('btn-burn-chat');
  const btnLogout = document.getElementById('btn-logout');

  const createRoomModal = document.getElementById('create-room-modal');
  const btnCreateRoomModal = document.getElementById('btn-create-room-modal');
  const createRoomForm = document.getElementById('create-room-form');
  const newRoomName = document.getElementById('new-room-name');
  const newRoomPasskey = document.getElementById('new-room-passkey');

  const roomPasskeyModal = document.getElementById('room-passkey-modal');
  const roomPasskeyForm = document.getElementById('room-passkey-form');
  const targetRoomIdInput = document.getElementById('target-room-id');
  const inputRoomPasskey = document.getElementById('input-room-passkey');
  const roomPasskeyError = document.getElementById('room-passkey-error');

  // Pop-out Floating Window Launcher Logic
  const launchPopoutWindow = () => {
    const width = 430;
    const height = 720;
    const left = window.screen.width - width - 80;
    const top = 100;
    window.open(
      window.location.href,
      'OfficeChatBoxMiniWindow',
      `width=${width},height=${height},left=${left},top=${top},resizable=yes,scrollbars=no,status=no,toolbar=no,menubar=no`
    );
  };

  if (btnLaunchPopoutLogin) btnLaunchPopoutLogin.addEventListener('click', launchPopoutWindow);
  if (btnPopoutApp) btnPopoutApp.addEventListener('click', launchPopoutWindow);

  // Register PWA Service Worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }

  // PWA Installation Prompt Handler
  let deferredPrompt = null;
  const btnPWAInstall = document.getElementById('btn-pwa-install');

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    if (btnPWAInstall) btnPWAInstall.classList.remove('hidden');
  });

  if (btnPWAInstall) {
    btnPWAInstall.addEventListener('click', async () => {
      if (deferredPrompt) {
        deferredPrompt.prompt();
        const { outcome } = await deferredPrompt.userChoice;
        if (outcome === 'accepted') {
          btnPWAInstall.classList.add('hidden');
        }
        deferredPrompt = null;
      }
    });
  }

  // Check if running inside small window or PWA mode
  if (window.innerWidth <= 600 || window.matchMedia('(display-mode: standalone)').matches) {
    document.body.classList.add('mini-window-mode');
  }

  // Toggle Password Visibility
  togglePassBtn.addEventListener('click', () => {
    const isPass = passkeyInput.type === 'password';
    passkeyInput.type = isPass ? 'text' : 'password';
    togglePassBtn.innerHTML = isPass ? '<i class="fa-solid fa-eye-slash"></i>' : '<i class="fa-solid fa-eye"></i>';
  });

  // Mobile/Mini Sidebar Drawer Toggle
  mobileToggleSidebar.addEventListener('click', () => {
    sidebar.classList.toggle('open');
  });

  // Sidebar Tab Navigation
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      btn.classList.add('active');
      const targetTab = btn.dataset.tab;
      document.getElementById(targetTab).classList.add('active');

      if (targetTab === 'tab-rooms') {
        if (availableRooms.length > 0) {
          const firstRoom = availableRooms[0];
          if (!firstRoom.isPrivate && (activeTarget.type !== 'room' || activeTarget.id !== firstRoom.id)) {
            joinRoom(firstRoom.id);
          }
        }
      } else if (targetTab === 'tab-users') {
        if (onlineUsers.length > 0) {
          const firstUser = onlineUsers[0];
          if (activeTarget.type !== 'user' || activeTarget.name !== firstUser.username) {
            startDirectMessage(firstUser);
          }
        }
      }
    });
  });

  // Close Modals
  document.querySelectorAll('.closeModal').forEach(btn => {
    btn.addEventListener('click', () => {
      createRoomModal.classList.remove('active');
      roomPasskeyModal.classList.remove('active');
    });
  });

  // 1. AUTHENTICATION & SESSION PERSISTENCE (PERSISTS ON REFRESH)
  authForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const passkey = passkeyInput.value.trim();
    const username = usernameInput.value.trim();

    if (!passkey || !username) return;

    authError.classList.add('hidden');
    initSocketConnection(passkey, username);
  });

  // Check for active saved session on Page Refresh or Reopen
  const getSavedSessionData = () => {
    try {
      const saved = localStorage.getItem(SESSION_STORAGE_KEY) || sessionStorage.getItem(SESSION_STORAGE_KEY);
      return saved ? JSON.parse(saved) : null;
    } catch (e) {
      return null;
    }
  };

  const savedSessionData = getSavedSessionData();
  if (savedSessionData && savedSessionData.passkey && savedSessionData.username) {
    passkeyInput.value = savedSessionData.passkey;
    usernameInput.value = savedSessionData.username;
    initSocketConnection(savedSessionData.passkey, savedSessionData.username);
  }

  async function initSocketConnection(passkey, username) {
    if (socket) socket.disconnect();

    const pubKeyJWK = await E2EE.initIdentityKeyPair(username);

    socket = io({
      reconnectionAttempts: 5,
      timeout: 10000
    });

    socket.on('connect', () => {
      socket.emit('authenticate', { passkey, username, publicKey: pubKeyJWK }, (res) => {
        if (res.success) {
          currentUser = { id: res.user.id, username: res.user.username, passkey };
          
          const saved = getSavedSessionData();
          let targetRoom = 'lobby';
          let targetPasskey = '';
          if (saved) {
            if (saved.roomId) targetRoom = saved.roomId;
            if (saved.roomPasskey) targetPasskey = saved.roomPasskey;
          }

          const sessionPayload = JSON.stringify({
            passkey,
            username,
            roomId: targetRoom,
            roomPasskey: targetPasskey
          });

          localStorage.setItem(SESSION_STORAGE_KEY, sessionPayload);
          sessionStorage.setItem(SESSION_STORAGE_KEY, sessionPayload);

          displayUserName.textContent = currentUser.username;
          currentUserAvatar.textContent = currentUser.username.charAt(0).toUpperCase();

          authModal.classList.remove('active');
          appContainer.classList.remove('hidden');

          availableRooms = res.roomsList;
          renderRoomsList();
          joinRoom(targetRoom, targetPasskey);
        } else {
          localStorage.removeItem(SESSION_STORAGE_KEY);
          sessionStorage.removeItem(SESSION_STORAGE_KEY);
          showAuthError(res.error || 'Authentication Failed');
          socket.disconnect();
        }
      });
    });

    socket.on('connect_error', () => {
      showAuthError('Unable to connect to server');
    });

    setupSocketListeners();
  }

  function showAuthError(msg) {
    document.documentElement.classList.remove('has-saved-session');
    errorText.textContent = msg;
    authError.classList.remove('hidden');
    authModal.classList.add('active');
    appContainer.classList.add('hidden');
  }

  // Helper: E2EE Decryption for Incoming / History Messages
  async function processDecryption(msg) {
    if (!msg || !msg.encryptedPayload || !E2EE.isSupported) return msg;
    if (msg._isDecrypted) return msg;

    try {
      let key = null;
      if (msg.isDirect) {
        const isMyMsg = (msg.senderId === socket.id) || 
                        (currentUser.username && msg.senderName.toLowerCase() === currentUser.username.toLowerCase());
        const peerName = isMyMsg ? msg.recipientName : msg.senderName;
        if (peerName) {
          let peerPubKey = null;
          const peerUser = onlineUsers.find(u => u.username && u.username.toLowerCase() === peerName.toLowerCase());
          if (peerUser && peerUser.publicKey) {
            peerPubKey = peerUser.publicKey;
          } else {
            peerPubKey = await ChatDB.getPeerPublicKey(peerName);
          }

          if (peerPubKey) {
            key = await E2EE.getDMKey(peerName, peerPubKey);
          }
        }
      } else {
        const roomId = msg.targetKey || (activeTarget.type === 'room' ? activeTarget.id : (socket.currentRoomId || 'lobby'));
        key = await E2EE.getRoomKey(roomId, currentRoomPasskey, currentUser.passkey || 'passkey4321');
      }

      if (key) {
        const decrypted = await E2EE.decryptPayload(key, msg.encryptedPayload);
        if (decrypted) {
          msg.text = decrypted.text;
          msg.media = decrypted.media;
          msg.mediaType = decrypted.mediaType;
          msg.mediaName = decrypted.mediaName;
          msg.isE2EE = true;
          msg._isDecrypted = true;
        }
      }
    } catch (e) {
      console.warn('[E2EE] Decryption error:', e);
    }
    return msg;
  }

  // 2. SOCKET EVENT LISTENERS
  function setupSocketListeners() {
    socket.on('online_users', (users) => {
      onlineUsers = users.filter(u => u && u.username && u.username.trim().toLowerCase() !== (currentUser.username || '').trim().toLowerCase());
      onlineCount.textContent = onlineUsers.length;
      renderUsersList();

      // Cache colleagues' ECDH Public Keys in IndexedDB for offline DM decryption
      onlineUsers.forEach(u => {
        if (u.username && u.publicKey) {
          ChatDB.savePeerPublicKey(u.username, u.publicKey);
        }
      });
    });

    socket.on('room_created', (rooms) => {
      availableRooms = rooms;
      renderRoomsList();
    });

    socket.on('new_message', async (msg) => {
      await processDecryption(msg);

      if (msg.isDirect) {
        // Determine peer name
        const isMyMessage = (msg.senderId === socket.id) || 
                            (currentUser.username && msg.senderName.toLowerCase() === currentUser.username.toLowerCase());
        
        const peerName = isMyMessage ? msg.recipientName : msg.senderName;
        if (!peerName) return;

        const key = peerName.toLowerCase();
        await ChatDB.saveMessage(msg, key);

        if (!dmStore.has(key)) {
          dmStore.set(key, []);
        }

        const list = dmStore.get(key);
        if (!list.some(m => m.id === msg.id)) {
          list.push(msg);
          saveDMStore();
        }

        const isViewingThisDM = activeTarget.type === 'user' && 
          activeTarget.name.toLowerCase() === key;

        if (isViewingThisDM) {
          if (!chatMessages.querySelector(`[data-id="${msg.id}"]`)) {
            appendMessage(msg);
          }
          if (!isMyMessage) playPopSound();
        } else {
          const currentCount = unreadDMs.get(key) || 0;
          unreadDMs.set(key, currentCount + 1);
          renderUsersList();
          if (!isMyMessage) playPopSound();
        }
      } else {
        // Room Message Routing
        const roomId = msg.roomId || socket.currentRoomId || 'lobby';
        await ChatDB.saveMessage(msg, roomId);

        const isForCurrentRoom = activeTarget.type === 'room' && activeTarget.id === socket.currentRoomId;
        if (isForCurrentRoom) {
          if (!chatMessages.querySelector(`[data-id="${msg.id}"]`)) {
            appendMessage(msg);
          }
          if (msg.senderId !== socket.id && msg.senderName.toLowerCase() !== currentUser.username.toLowerCase()) {
            playPopSound();
          }
        }
      }
    });

    socket.on('message_deleted', ({ messageId, deletedBy }) => {
      ChatDB.deleteMessage(messageId);

      const msgGroup = chatMessages.querySelector(`[data-id="${messageId}"]`);
      if (msgGroup) {
        msgGroup.style.transition = 'opacity 0.25s ease, transform 0.25s ease';
        msgGroup.style.opacity = '0';
        msgGroup.style.transform = 'scale(0.85)';
        setTimeout(() => msgGroup.remove(), 250);
      }

      for (const [peer, list] of dmStore.entries()) {
        const filtered = list.filter(m => m.id !== messageId);
        dmStore.set(peer, filtered);
      }
      saveDMStore();
    });

    socket.on('message_edited', ({ messageId, newText }) => {
      const msgGroup = chatMessages.querySelector(`[data-id="${messageId}"]`);
      if (msgGroup) {
        const bubble = msgGroup.querySelector('.msg-bubble');
        if (bubble) {
          bubble.classList.remove('editing');

          const mediaImg = bubble.querySelector('img.msg-media');
          const mediaAudio = bubble.querySelector('audio.msg-media');
          
          let mediaHTML = '';
          if (mediaImg) {
            mediaHTML = `<img src="${mediaImg.src}" alt="Attachment" class="msg-media">`;
          } else if (mediaAudio) {
            mediaHTML = `<audio src="${mediaAudio.src}" controls class="msg-media"></audio>`;
          }

          const isEmojiOnly = newText && !mediaHTML && /^[\p{Extended_Pictographic}\s\u200d\ufe0f]+$/u.test(newText.trim());

          let inner = `<span class="msg-text">${escapeHTML(newText)} <span class="edited-tag">(edited)</span></span>`;
          if (mediaHTML) inner += mediaHTML;

          bubble.className = `msg-bubble ${isEmojiOnly ? 'emoji-only' : ''}`;
          bubble.innerHTML = inner;
        }
      }

      for (const [peer, list] of dmStore.entries()) {
        const item = list.find(m => m.id === messageId);
        if (item) {
          item.text = newText;
          item.edited = true;
        }
      }
      saveDMStore();
    });

    socket.on('reaction_updated', ({ messageId, reactions }) => {
      updateMessageReactionsUI(messageId, reactions);
    });

    socket.on('user_typing', ({ userId, username, isTyping, isDirect }) => {
      if (isDirect && activeTarget.type === 'user' && activeTarget.name.toLowerCase() === username.toLowerCase()) {
        toggleTypingUI(isTyping, `${username} is typing...`);
      } else if (!isDirect && activeTarget.type === 'room') {
        toggleTypingUI(isTyping, `${username} is typing...`);
      }
    });

    socket.on('room_burned', ({ roomId, burnedBy }) => {
      ChatDB.clearTargetMessages(roomId);
      if (activeTarget.type === 'room' && activeTarget.id === roomId) {
        chatMessages.innerHTML = '';
        appendSystemNotice(`Room History Burned by ${burnedBy}`);
        playPopSound();
      }
    });

    socket.on('dm_burned', ({ peerName, burnedBy }) => {
      if (!peerName) return;
      const key = peerName.toLowerCase();

      dmStore.set(key, []);
      saveDMStore();
      ChatDB.clearTargetMessages(key);

      if (activeTarget.type === 'user' && activeTarget.name.toLowerCase() === key) {
        chatMessages.innerHTML = '';
        appendSystemNotice(`Direct Chat History Burned by ${burnedBy}`);
        playPopSound();
      }
    });

    socket.on('user_joined_room', ({ username }) => {
      if (currentUser.username && username && username.trim().toLowerCase() === currentUser.username.trim().toLowerCase()) return;
      appendSystemNotice(`${username} joined the chat`);
    });

    socket.on('user_left_room', ({ username }) => {
      if (currentUser.username && username && username.trim().toLowerCase() === currentUser.username.trim().toLowerCase()) return;
      appendSystemNotice(`${username} left the chat`);
    });
  }

  // 3. ROOM & PRIVATE USER SWITCHING
  function renderRoomsList() {
    roomsList.innerHTML = '';
    availableRooms.forEach(room => {
      const el = document.createElement('div');
      el.className = `list-item ${activeTarget.type === 'room' && activeTarget.id === room.id ? 'active' : ''}`;
      el.innerHTML = `
        <div class="item-info">
          <div class="item-icon">
            <i class="fa-solid ${room.isPrivate ? 'fa-lock' : 'fa-hashtag'}"></i>
          </div>
          <div>
            <div class="item-name">${escapeHTML(room.name)}</div>
            <div class="item-meta">${room.userCount || 0} online</div>
          </div>
        </div>
      `;
      el.addEventListener('click', () => {
        if (room.isPrivate) {
          targetRoomIdInput.value = room.id;
          inputRoomPasskey.value = '';
          roomPasskeyError.classList.add('hidden');
          roomPasskeyModal.classList.add('active');
        } else {
          joinRoom(room.id);
        }
      });
      roomsList.appendChild(el);
    });
  }

  function renderUsersList() {
    usersList.innerHTML = '';
    if (onlineUsers.length === 0) {
      usersList.innerHTML = `<div class="item-meta" style="padding:10px;">No other colleagues online right now.</div>`;
      return;
    }

    onlineUsers.forEach(u => {
      const key = u.username.toLowerCase();
      const unreadCount = unreadDMs.get(key) || 0;
      const isActive = activeTarget.type === 'user' && activeTarget.name.toLowerCase() === key;

      const el = document.createElement('div');
      el.className = `list-item ${isActive ? 'active' : ''}`;
      el.innerHTML = `
        <div class="item-info">
          <div class="avatar" style="width:32px;height:32px;font-size:13px;">${u.username.charAt(0).toUpperCase()}</div>
          <div>
            <div class="item-name">${escapeHTML(u.username)}</div>
            <div class="item-meta"><span class="status-indicator"><span class="dot"></span> Online</span></div>
          </div>
        </div>
        ${unreadCount > 0 
          ? `<span class="badge" style="background:var(--danger);">${unreadCount}</span>` 
          : `<i class="fa-solid fa-comment-dots" style="color: var(--text-dim);"></i>`
        }
      `;
      el.addEventListener('click', () => {
        startDirectMessage(u);
      });
      usersList.appendChild(el);
    });
  }

  function joinRoom(roomId, passkey = '') {
    currentRoomPasskey = passkey;
    socket.emit('join_room', { roomId, roomPasskey: passkey }, async (res) => {
      if (res.success) {
        socket.currentRoomId = res.room.id;
        activeTarget = { type: 'room', id: res.room.id, name: res.room.name };

        // Save active room to sessionStorage for refresh retention
        sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({
          passkey: currentUser.passkey,
          username: currentUser.username,
          roomId: res.room.id,
          roomPasskey: passkey
        }));

        document.title = 'Office-ChatBox';
        chatTitle.textContent = res.room.name;
        chatSubtitle.textContent = '';
        chatTargetIcon.innerHTML = `<i class="fa-solid ${res.room.isPrivate ? 'fa-lock' : 'fa-hashtag'}"></i>`;

        chatMessages.innerHTML = '';

        // 1. Load persistent history from local IndexedDB
        const localHistory = await ChatDB.getMessagesForTarget(res.room.id);
        for (const msg of localHistory) {
          await processDecryption(msg);
          if (!chatMessages.querySelector(`[data-id="${msg.id}"]`)) {
            appendMessage(msg);
          }
        }

        // 2. Merge incoming room buffer from server
        if (res.room.messages) {
          for (const msg of res.room.messages) {
            await processDecryption(msg);
            await ChatDB.saveMessage(msg, res.room.id);
            if (!chatMessages.querySelector(`[data-id="${msg.id}"]`)) {
              appendMessage(msg);
            }
          }
        }

        renderRoomsList();
        renderUsersList();
        roomPasskeyModal.classList.remove('active');
        sidebar.classList.remove('open');
      } else {
        roomPasskeyError.textContent = res.error || 'Access Denied';
        roomPasskeyError.classList.remove('hidden');
      }
    });
  }

  async function startDirectMessage(user) {
    activeTarget = { type: 'user', id: user.id, name: user.username };

    // Reset unread count for this peer
    const key = user.username.toLowerCase();
    unreadDMs.set(key, 0);
    renderUsersList();

    document.title = 'Office-ChatBox';
    chatTitle.textContent = `@${user.username}`;
    chatSubtitle.textContent = '';
    chatTargetIcon.innerHTML = `<div class="avatar" style="width:36px;height:36px;font-size:14px;">${user.username.charAt(0).toUpperCase()}</div>`;

    chatMessages.innerHTML = '';

    // Load DM History from local IndexedDB
    const localHistory = await ChatDB.getMessagesForTarget(key);
    for (const msg of localHistory) {
      await processDecryption(msg);
      if (!chatMessages.querySelector(`[data-id="${msg.id}"]`)) {
        appendMessage(msg);
      }
    }

    sidebar.classList.remove('open');
  }

  // 4. CREATE ROOM & PROTECTED ROOM HANDLERS
  btnCreateRoomModal.addEventListener('click', () => {
    newRoomName.value = '';
    newRoomPasskey.value = '';
    createRoomModal.classList.add('active');
  });

  createRoomForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = newRoomName.value.trim();
    const passkey = newRoomPasskey.value.trim();
    if (!name) return;

    joinRoom(name, passkey);
    createRoomModal.classList.remove('active');
  });

  roomPasskeyForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const roomId = targetRoomIdInput.value;
    const passkey = inputRoomPasskey.value.trim();
    joinRoom(roomId, passkey);
  });

  // 5. MESSAGE SENDING & MEDIA ATTACHMENTS (WITH E2EE ENCRYPTION)
  messageForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = messageInput.value.trim();

    if (!text && !currentMediaAttachment) return;

    const recipient = activeTarget.type === 'user' ? activeTarget.name : null;

    const payloadObject = {
      text,
      media: currentMediaAttachment ? currentMediaAttachment.data : null,
      mediaType: currentMediaAttachment ? currentMediaAttachment.type : null,
      mediaName: currentMediaAttachment ? currentMediaAttachment.name : null
    };

    let encryptedPayload = null;
    if (E2EE.isSupported) {
      if (activeTarget.type === 'user') {
        const peerUser = onlineUsers.find(u => u.username && u.username.toLowerCase() === activeTarget.name.toLowerCase());
        if (peerUser && peerUser.publicKey) {
          const dmKey = await E2EE.getDMKey(activeTarget.name, peerUser.publicKey);
          if (dmKey) {
            encryptedPayload = await E2EE.encryptPayload(dmKey, payloadObject);
          }
        }
      } else if (activeTarget.type === 'room') {
        const roomKey = await E2EE.getRoomKey(activeTarget.id, currentRoomPasskey, currentUser.passkey || 'passkey4321');
        if (roomKey) {
          encryptedPayload = await E2EE.encryptPayload(roomKey, payloadObject);
        }
      }
    }

    const payload = {
      text: encryptedPayload ? '[🔒 E2EE Encrypted Message]' : text,
      media: encryptedPayload ? null : (currentMediaAttachment ? currentMediaAttachment.data : null),
      mediaType: encryptedPayload ? null : (currentMediaAttachment ? currentMediaAttachment.type : null),
      mediaName: encryptedPayload ? null : (currentMediaAttachment ? currentMediaAttachment.name : null),
      encryptedPayload: encryptedPayload,
      recipientId: recipient
    };

    socket.emit('send_message', payload, async (res) => {
      if (res.success) {
        if (res.message) {
          await processDecryption(res.message);
          const targetKey = activeTarget.type === 'user' ? activeTarget.name : activeTarget.id;
          await ChatDB.saveMessage(res.message, targetKey);
        }

        messageInput.value = '';
        messageInput.style.height = '46px';
        clearMediaAttachment();
        emojiPicker.classList.add('hidden');
        sendTypingStatus(false);
      } else {
        appendSystemNotice(`Notice: ${res.error || 'Unable to send message'}`);
        messageInput.value = '';
        messageInput.style.height = '46px';
        clearMediaAttachment();
      }
    });
  });

  // Allowed file extensions helper (Excel, PDF, Word, PowerPoint, Image, Text, Audio, Video)
  const ALLOWED_DOC_EXTENSIONS = [
    'xls', 'xlsx', 'csv',
    'pdf',
    'doc', 'docx',
    'ppt', 'pptx',
    'jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp',
    'txt', 'log', 'md', 'json',
    'mp3', 'wav', 'ogg', 'm4a', 'aac',
    'mp4', 'webm', 'mov', 'avi', 'mkv'
  ];

  function getFileTypeCategory(filename, mimeType = '') {
    const ext = (filename.split('.').pop() || '').toLowerCase();
    
    if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp'].includes(ext) || mimeType.startsWith('image/')) {
      return 'image';
    }
    if (['mp3', 'wav', 'ogg', 'm4a', 'aac'].includes(ext) || mimeType.startsWith('audio/')) {
      return 'audio';
    }
    if (['mp4', 'webm', 'mov', 'avi', 'mkv'].includes(ext) || mimeType.startsWith('video/')) {
      return 'video';
    }
    if (ext === 'pdf' || mimeType.includes('pdf')) {
      return 'pdf';
    }
    if (['xls', 'xlsx', 'csv'].includes(ext) || mimeType.includes('excel') || mimeType.includes('spreadsheet') || mimeType.includes('csv')) {
      return 'excel';
    }
    if (['doc', 'docx'].includes(ext) || mimeType.includes('word') || mimeType.includes('officedocument.wordprocessingml')) {
      return 'word';
    }
    if (['ppt', 'pptx'].includes(ext) || mimeType.includes('powerpoint') || mimeType.includes('presentationml')) {
      return 'powerpoint';
    }
    if (['txt', 'log', 'md', 'json'].includes(ext) || mimeType.startsWith('text/')) {
      return 'text';
    }
    return null;
  }

  // Attachment File Handler
  imageUpload.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const ext = (file.name.split('.').pop() || '').toLowerCase();
    const category = getFileTypeCategory(file.name, file.type);

    if (!category || !ALLOWED_DOC_EXTENSIONS.includes(ext)) {
      alert('Not Allowed to send this file.');
      imageUpload.value = '';
      clearMediaAttachment();
      return;
    }

    if (file.size > 10 * 1024 * 1024) {
      alert('File too large. Maximum size is 10MB.');
      imageUpload.value = '';
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      currentMediaAttachment = { data: reader.result, type: category, name: file.name };

      if (category === 'image') {
        previewImg.src = reader.result;
        previewImg.classList.remove('hidden');
        previewAudio.classList.add('hidden');
      } else {
        previewImg.classList.add('hidden');
        previewAudio.classList.add('hidden');
      }
      previewFilename.textContent = file.name;
      mediaPreviewBar.classList.remove('hidden');
    };
    reader.readAsDataURL(file);
  });

  // Voice Note Recorder Handler
  btnVoiceRecord.addEventListener('click', async () => {
    if (!isRecordingAudio) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        mediaRecorder = new MediaRecorder(stream);
        audioChunks = [];

        mediaRecorder.ondataavailable = (e) => audioChunks.push(e.data);
        mediaRecorder.onstop = () => {
          const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
          const reader = new FileReader();
          reader.onload = () => {
            currentMediaAttachment = { data: reader.result, type: 'audio', name: 'Voice Note' };
            previewAudio.src = reader.result;
            previewAudio.classList.remove('hidden');
            previewImg.classList.add('hidden');
            previewFilename.textContent = 'Voice Note Audio';
            mediaPreviewBar.classList.remove('hidden');
          };
          reader.readAsDataURL(audioBlob);

          stream.getTracks().forEach(track => track.stop());
        };

        mediaRecorder.start();
        isRecordingAudio = true;
        btnVoiceRecord.style.color = 'var(--danger)';
        btnVoiceRecord.title = 'Click to Stop Recording';
      } catch (err) {
        alert('Microphone access denied or not supported.');
      }
    } else {
      if (mediaRecorder) {
        mediaRecorder.stop();
      }
      isRecordingAudio = false;
      btnVoiceRecord.style.color = 'var(--text-muted)';
      btnVoiceRecord.title = 'Hold/Click to Record Voice Note';
    }
  });

  btnCancelMedia.addEventListener('click', clearMediaAttachment);

  function clearMediaAttachment() {
    currentMediaAttachment = null;
    imageUpload.value = '';
    previewImg.src = '';
    previewAudio.src = '';
    mediaPreviewBar.classList.add('hidden');
  }

  // Emoji & Sticker Picker Logic
  btnEmojiTrigger.addEventListener('click', () => {
    emojiPicker.classList.toggle('hidden');
  });

  // Tab switching inside Emoji Picker
  emojiPicker.querySelectorAll('.emoji-tab-btn').forEach(tabBtn => {
    tabBtn.addEventListener('click', () => {
      emojiPicker.querySelectorAll('.emoji-tab-btn').forEach(b => b.classList.remove('active'));
      emojiPicker.querySelectorAll('.emoji-category').forEach(c => c.classList.remove('active'));
      
      tabBtn.classList.add('active');
      const category = tabBtn.dataset.category;
      const targetCat = emojiPicker.querySelector(`#emoji-${category}`);
      if (targetCat) targetCat.classList.add('active');
    });
  });

  // Handle clicking on smileys or sticker chips
  emojiPicker.querySelectorAll('.emoji-grid span, .sticker-chip').forEach(item => {
    item.addEventListener('click', () => {
      messageInput.value += item.textContent + ' ';
      messageInput.focus();
    });
  });

  // Handle Enter to Send & Shift+Enter for New Line
  messageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (typeof messageForm.requestSubmit === 'function') {
        messageForm.requestSubmit();
      } else {
        messageForm.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
      }
    }
  });

  // Typing Indicator Debounce & Auto-expand Textarea Height
  messageInput.addEventListener('input', () => {
    messageInput.style.height = 'auto';
    messageInput.style.height = Math.min(messageInput.scrollHeight, 120) + 'px';

    sendTypingStatus(true);
    clearTimeout(typingTimer);
    typingTimer = setTimeout(() => sendTypingStatus(false), 2000);
  });

  function sendTypingStatus(isTyping) {
    if (!socket) return;
    socket.emit('typing', {
      isTyping,
      recipientId: activeTarget.type === 'user' ? activeTarget.name : null
    });
  }

  function toggleTypingUI(show, text = '') {
    if (show) {
      typingText.textContent = text;
      typingIndicator.classList.remove('hidden');
    } else {
      typingIndicator.classList.add('hidden');
    }
  }

  // 6. RENDER MESSAGE BUBBLE IN DOM
  function appendMessage(msg) {
    const isOutgoing = (msg.senderId === socket.id) || 
                       (currentUser.username && msg.senderName.toLowerCase() === currentUser.username.toLowerCase());

    const group = document.createElement('div');
    group.className = `msg-group ${isOutgoing ? 'outgoing' : 'incoming'}`;
    group.dataset.id = msg.id;

    const timeStr = new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    let mediaHTML = '';
    if (msg.media) {
      const fileName = escapeHTML(msg.mediaName || 'Attachment');
      if (msg.mediaType === 'image') {
        mediaHTML = `<img src="${msg.media}" alt="Attachment" class="msg-media">`;
      } else if (msg.mediaType === 'audio') {
        mediaHTML = `<audio src="${msg.media}" controls class="msg-media"></audio>`;
      } else if (msg.mediaType === 'video') {
        mediaHTML = `<video src="${msg.media}" controls class="msg-media" style="max-width:100%; max-height:280px; border-radius:12px; margin-top:8px;"></video>`;
      } else if (msg.mediaType === 'pdf') {
        mediaHTML = `<div class="doc-attachment-card"><div class="doc-icon pdf"><i class="fa-solid fa-file-pdf"></i></div><div class="doc-info"><span class="doc-name">${fileName}</span><a href="${msg.media}" download="${fileName}" class="doc-download-btn"><i class="fa-solid fa-download"></i> Download PDF</a></div></div>`;
      } else if (msg.mediaType === 'excel') {
        mediaHTML = `<div class="doc-attachment-card"><div class="doc-icon excel"><i class="fa-solid fa-file-excel"></i></div><div class="doc-info"><span class="doc-name">${fileName}</span><a href="${msg.media}" download="${fileName}" class="doc-download-btn"><i class="fa-solid fa-download"></i> Download Excel</a></div></div>`;
      } else if (msg.mediaType === 'word') {
        mediaHTML = `<div class="doc-attachment-card"><div class="doc-icon word"><i class="fa-solid fa-file-word"></i></div><div class="doc-info"><span class="doc-name">${fileName}</span><a href="${msg.media}" download="${fileName}" class="doc-download-btn"><i class="fa-solid fa-download"></i> Download Word</a></div></div>`;
      } else if (msg.mediaType === 'powerpoint') {
        mediaHTML = `<div class="doc-attachment-card"><div class="doc-icon ppt"><i class="fa-solid fa-file-powerpoint"></i></div><div class="doc-info"><span class="doc-name">${fileName}</span><a href="${msg.media}" download="${fileName}" class="doc-download-btn"><i class="fa-solid fa-download"></i> Download PPT</a></div></div>`;
      } else if (msg.mediaType === 'text') {
        mediaHTML = `<div class="doc-attachment-card"><div class="doc-icon text"><i class="fa-solid fa-file-lines"></i></div><div class="doc-info"><span class="doc-name">${fileName}</span><a href="${msg.media}" download="${fileName}" class="doc-download-btn"><i class="fa-solid fa-download"></i> Download Text File</a></div></div>`;
      } else {
        mediaHTML = `<div class="doc-attachment-card"><div class="doc-icon text"><i class="fa-solid fa-file"></i></div><div class="doc-info"><span class="doc-name">${fileName}</span><a href="${msg.media}" download="${fileName}" class="doc-download-btn"><i class="fa-solid fa-download"></i> Download File</a></div></div>`;
      }
    }

    let bubbleInner = '';
    if (msg.text) {
      bubbleInner += `<span class="msg-text">${escapeHTML(msg.text)}${msg.edited ? ' <span class="edited-tag">(edited)</span>' : ''}</span>`;
    }
    if (mediaHTML) {
      bubbleInner += mediaHTML;
    }

    const metaSender = !isOutgoing ? `<span class="msg-sender">${escapeHTML(msg.senderName)}</span>` : '';

    const isEmojiOnly = msg.text && !msg.media && /^[\p{Extended_Pictographic}\s\u200d\ufe0f]+$/u.test(msg.text.trim());

    let actionsHTML = '';
    if (isOutgoing) {
      actionsHTML = `
        <div class="msg-actions">
          ${msg.text ? `<button type="button" class="msg-act-btn btn-edit" title="Edit Message"><i class="fa-solid fa-pen"></i></button>` : ''}
          <button type="button" class="msg-act-btn btn-delete" title="Delete Message / Attachment"><i class="fa-solid fa-trash-can"></i></button>
        </div>
      `;
    }

    const isE2EE = !!(msg.encryptedPayload || msg.isE2EE);
    const e2eeTag = isE2EE ? `<i class="fa-solid fa-lock message-e2ee-tag" title="End-to-End Encrypted (AES-256-GCM)"></i>` : '';

    group.innerHTML = `<div class="msg-meta">${metaSender}<span>${timeStr}</span>${e2eeTag}</div><div class="msg-bubble-wrapper">${actionsHTML}<div class="msg-bubble ${isEmojiOnly ? 'emoji-only' : ''}">${bubbleInner}</div></div><div class="reactions-bar"></div>`;

    if (isOutgoing) {
      const btnDelete = group.querySelector('.btn-delete');
      if (btnDelete) {
        btnDelete.addEventListener('click', () => {
          if (confirm('Delete this message for everyone?')) {
            socket.emit('delete_message', {
              messageId: msg.id,
              recipientId: activeTarget.type === 'user' ? activeTarget.name : null
            });
          }
        });
      }

      const btnEdit = group.querySelector('.btn-edit');
      if (btnEdit) {
        btnEdit.addEventListener('click', () => {
          startInlineEdit(group, msg);
        });
      }
    }

    group.querySelector('.msg-bubble').addEventListener('dblclick', () => {
      socket.emit('add_reaction', { messageId: msg.id, emoji: '❤️' });
    });

    chatMessages.appendChild(group);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  function startInlineEdit(group, msg) {
    const bubble = group.querySelector('.msg-bubble');
    if (!bubble || bubble.querySelector('.inline-edit-box')) return;

    const originalText = msg.text || '';
    
    bubble.classList.add('editing');
    bubble.innerHTML = `
      <div class="inline-edit-box">
        <textarea class="edit-textarea" rows="2">${escapeHTML(originalText)}</textarea>
        <div class="edit-btn-row">
          <button type="button" class="btn-edit-save"><i class="fa-solid fa-check"></i> Save</button>
          <button type="button" class="btn-edit-cancel"><i class="fa-solid fa-xmark"></i> Cancel</button>
        </div>
      </div>
    `;

    const textarea = bubble.querySelector('.edit-textarea');
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);

    const saveEdit = () => {
      const newText = textarea.value.trim();
      if (newText && newText !== originalText) {
        socket.emit('edit_message', {
          messageId: msg.id,
          newText,
          recipientId: activeTarget.type === 'user' ? activeTarget.name : null
        });
      } else {
        cancelEdit();
      }
    };

    const cancelEdit = () => {
      msg.text = originalText;
      bubble.classList.remove('editing');
      const isEmojiOnly = originalText && !msg.media && /^[\p{Extended_Pictographic}\s\u200d\ufe0f]+$/u.test(originalText.trim());
      
      let mediaHTML = '';
      if (msg.media) {
        if (msg.mediaType === 'image') mediaHTML = `<img src="${msg.media}" alt="Attachment" class="msg-media">`;
        else if (msg.mediaType === 'audio') mediaHTML = `<audio src="${msg.media}" controls class="msg-media"></audio>`;
      }
      
      let inner = `<span class="msg-text">${escapeHTML(originalText)}${msg.edited ? ' <span class="edited-tag">(edited)</span>' : ''}</span>`;
      if (mediaHTML) inner += mediaHTML;

      bubble.className = `msg-bubble ${isEmojiOnly ? 'emoji-only' : ''}`;
      bubble.innerHTML = inner;
    };

    bubble.querySelector('.btn-edit-save').addEventListener('click', saveEdit);
    bubble.querySelector('.btn-edit-cancel').addEventListener('click', cancelEdit);

    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        saveEdit();
      } else if (e.key === 'Escape') {
        cancelEdit();
      }
    });
  }

  function updateMessageReactionsUI(messageId, reactions) {
    const msgEl = chatMessages.querySelector(`[data-id="${messageId}"] .reactions-bar`);
    if (!msgEl) return;

    msgEl.innerHTML = '';
    for (const [emoji, users] of Object.entries(reactions)) {
      if (users.length > 0) {
        const pill = document.createElement('span');
        pill.className = `reaction-pill ${users.includes(currentUser.username) ? 'active' : ''}`;
        pill.innerHTML = `${emoji} ${users.length}`;
        pill.addEventListener('click', () => {
          socket.emit('add_reaction', { messageId, emoji });
        });
        msgEl.appendChild(pill);
      }
    }
  }

  function appendSystemNotice(text) {
    const el = document.createElement('div');
    el.style.textAlign = 'center';
    el.style.fontSize = '11px';
    el.style.color = 'var(--text-dim)';
    el.style.margin = '4px 0';
    el.textContent = `— ${text} —`;
    chatMessages.appendChild(el);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  // 7. BURN CHAT & EXPLICIT LOGOUT HANDLER
  btnBurnChat.addEventListener('click', () => {
    if (activeTarget.type === 'room') {
      if (confirm(`Burn all messages in "${activeTarget.name}" for everyone?`)) {
        socket.emit('burn_room');
      }
    } else if (activeTarget.type === 'user') {
      if (confirm(`Burn all direct messages with @${activeTarget.name} for both of you?`)) {
        socket.emit('burn_dm', { recipientId: activeTarget.name });
      }
    }
  });

  if (btnLogout) {
    btnLogout.addEventListener('click', () => {
      if (confirm('Are you sure you want to log out?')) {
        if (socket) socket.emit('explicit_logout');
        document.documentElement.classList.remove('has-saved-session');
        localStorage.removeItem(SESSION_STORAGE_KEY);
        sessionStorage.removeItem(SESSION_STORAGE_KEY);
        sessionStorage.removeItem(DM_STORAGE_KEY);
        dmStore.clear();
        if (socket) socket.disconnect();
        appContainer.classList.add('hidden');
        authModal.classList.add('active');
        usernameInput.value = '';
      }
    });
  }

  function escapeHTML(str) {
    return (str || '').replace(/[&<>'"]/g, 
      tag => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[tag] || tag)
    );
  }

  window.addEventListener('beforeunload', () => {
    if (socket) socket.disconnect();
  });
});
