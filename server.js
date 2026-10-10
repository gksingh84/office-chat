const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 2e7 // 20MB payload limit for ephemeral media sharing
});

// Master passkey for app access
const APP_PASSKEY = process.env.PASSKEY || 'passkey4321';
const PORT = process.env.PORT || 3000;

// HTTP Security Headers Middleware
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "frame-ancestors 'self' chrome-extension://* moz-extension://* http://localhost:* https://*.onrender.com");
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

// Serve static frontend files
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '20mb' }));

// Anti-Bruteforce IP Rate Limiter for Passkey Verification
const passkeyAttempts = new Map(); // IP -> { count, firstAttempt, blockedUntil }

app.post('/api/verify-passkey', (req, res) => {
  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  const now = Date.now();

  let attempt = passkeyAttempts.get(clientIp);
  if (attempt && attempt.blockedUntil && now < attempt.blockedUntil) {
    const remainingSec = Math.ceil((attempt.blockedUntil - now) / 1000);
    return res.status(429).json({ 
      success: false, 
      message: `Too many failed attempts. Locked out for ${remainingSec}s.` 
    });
  }

  const { passkey } = req.body;
  if (passkey === APP_PASSKEY) {
    passkeyAttempts.delete(clientIp);
    return res.json({ success: true, message: 'Access granted' });
  }

  // Record failed attempt
  if (!attempt || (now - attempt.firstAttempt > 60000)) {
    attempt = { count: 1, firstAttempt: now, blockedUntil: 0 };
  } else {
    attempt.count += 1;
    if (attempt.count >= 5) {
      attempt.blockedUntil = now + 5 * 60 * 1000; // 5-minute lockout
    }
  }
  passkeyAttempts.set(clientIp, attempt);

  return res.status(401).json({ success: false, message: 'Invalid secret passkey' });
});

// Permanent Username Registry File Persistence
const REGISTRY_FILE = path.join(__dirname, 'registered_users.json');
const registeredUsers = new Map(); // key -> { username, userTokens: [], pinHash, createdAt, lastLoginAt }

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000; // 30 days inactivity limit

function loadRegisteredUsers() {
  try {
    if (fs.existsSync(REGISTRY_FILE)) {
      const raw = fs.readFileSync(REGISTRY_FILE, 'utf8');
      const data = JSON.parse(raw);
      for (const [k, v] of Object.entries(data)) {
        registeredUsers.set(k.toLowerCase(), v);
      }
      console.log(`[+] Loaded ${registeredUsers.size} registered usernames.`);
    }
  } catch (e) {
    console.error('[-] Error loading registered_users.json:', e.message);
  }
}

function saveRegisteredUsers() {
  try {
    const obj = {};
    for (const [k, v] of registeredUsers.entries()) {
      obj[k] = v;
    }
    fs.writeFileSync(REGISTRY_FILE, JSON.stringify(obj, null, 2), 'utf8');
  } catch (e) {
    console.error('[-] Error saving registered_users.json:', e.message);
  }
}

function pruneIdleUsernames() {
  const now = Date.now();
  let count = 0;
  for (const [key, reg] of registeredUsers.entries()) {
    const lastActive = reg.lastLoginAt || reg.createdAt;
    if (lastActive && (now - new Date(lastActive).getTime() >= THIRTY_DAYS_MS)) {
      registeredUsers.delete(key);
      count++;
    }
  }
  if (count > 0) {
    console.log(`[+] Auto-pruned ${count} idle usernames (inactive for 30+ days).`);
    saveRegisteredUsers();
  }
}

loadRegisteredUsers();
pruneIdleUsernames();
setInterval(pruneIdleUsernames, 24 * 60 * 60 * 1000);

// In-memory data store (NO database, strictly in RAM)
const users = new Map();
const rooms = new Map();

// Persistent User Sessions Map to track room state & suppress F5 page refresh leave/join notices
const userSessions = new Map(); // Key: username.toLowerCase() -> { username, lastRoom, disconnectTimer, isExplicitLogout }

// Helper to sanitize room names
function getRoomId(name) {
  return name.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-');
}

// Create default lobby room if not exists
rooms.set('lobby', {
  id: 'lobby',
  name: 'Main Lounge',
  isPrivate: false,
  passkey: '',
  createdBy: 'System',
  messages: []
});

io.on('connection', (socket) => {
  console.log(`[+] New socket connection: ${socket.id}`);

  // 1. Authenticate with Master Passkey & Hybrid Username Ownership Verification
  socket.on('authenticate', ({ passkey, username, userToken, userPin, publicKey }, callback) => {
    if (passkey !== APP_PASSKEY) {
      if (typeof callback === 'function') {
        callback({ success: false, error: 'Incorrect Passkey! Access Denied.' });
      }
      return;
    }

    const cleanUsername = (username || 'Anonymous').trim().slice(0, 20);
    if (!cleanUsername || cleanUsername.length < 2) {
      if (typeof callback === 'function') {
        callback({ success: false, error: 'Username must be at least 2 characters long.' });
      }
      return;
    }

    const key = cleanUsername.toLowerCase();

    // 1. Enforce Unique Active Username across all online users
    for (const [sId, u] of users.entries()) {
      if (sId !== socket.id && u && u.authenticated && u.username && u.username.trim().toLowerCase() === key) {
        if (typeof callback === 'function') {
          callback({ 
            success: false, 
            error: `Username "${cleanUsername}" has already been taken. Choose another unique username.` 
          });
        }
        return;
      }
    }

    // 2. Permanent Username Reservation & Verification (Auto-expires after 30 days of inactivity)
    let reg = registeredUsers.get(key);

    if (reg) {
      const lastActive = reg.lastLoginAt || reg.createdAt;
      const isExpired = lastActive && (Date.now() - new Date(lastActive).getTime() >= THIRTY_DAYS_MS);

      if (isExpired) {
        console.log(`[+] Username "${cleanUsername}" auto-expired due to 30+ days of inactivity. Freeing up for new registration.`);
        registeredUsers.delete(key);
        reg = null;
      }
    }

    if (reg) {
      // Username is already permanently registered! Verify ownership token or PIN
      const isTokenValid = userToken && Array.isArray(reg.userTokens) && reg.userTokens.includes(userToken);
      const incomingPinHash = userPin ? crypto.createHash('sha256').update(String(userPin).trim()).digest('hex') : null;
      const isPinValid = reg.pinHash && incomingPinHash && (reg.pinHash === incomingPinHash);

      if (!isTokenValid && !isPinValid) {
        const needsPin = !!reg.pinHash;
        if (typeof callback === 'function') {
          callback({
            success: false,
            error: needsPin 
              ? `Username "${cleanUsername}" has already been taken. Enter your Personal PIN if this is your reserved alias on a new device.`
              : `Username "${cleanUsername}" has already been taken. Choose another unique username.`,
            requiresPin: needsPin,
            isReserved: true
          });
        }
        return;
      }

      // If logging in via valid PIN from a new device, link new userToken
      if (userToken && Array.isArray(reg.userTokens) && !reg.userTokens.includes(userToken)) {
        reg.userTokens.push(userToken);
      }
      // If setting/updating PIN for first time on existing registered user
      if (userPin && !reg.pinHash) {
        reg.pinHash = crypto.createHash('sha256').update(String(userPin).trim()).digest('hex');
      }

      reg.lastLoginAt = new Date().toISOString();
      registeredUsers.set(key, reg);
      saveRegisteredUsers();
    } else {
      // First time registration! Permanently claim this username for this user/device
      const initialToken = userToken || ('dev_token_' + Date.now() + '_' + Math.random().toString(36).substring(2, 10));
      const pinHash = userPin ? crypto.createHash('sha256').update(String(userPin).trim()).digest('hex') : null;

      reg = {
        username: cleanUsername,
        userTokens: [initialToken],
        pinHash: pinHash,
        createdAt: new Date().toISOString(),
        lastLoginAt: new Date().toISOString()
      };

      registeredUsers.set(key, reg);
      saveRegisteredUsers();
    }

    let session = userSessions.get(key);
    if (session) {
      if (session.disconnectTimer) {
        clearTimeout(session.disconnectTimer);
        session.disconnectTimer = null;
      }
    } else {
      session = {
        username: cleanUsername,
        lastRoom: null,
        disconnectTimer: null,
        isExplicitLogout: false,
        isNewLogin: true
      };
      userSessions.set(key, session);
    }

    session.isExplicitLogout = false;

    users.set(socket.id, {
      id: socket.id,
      username: cleanUsername,
      currentRoom: session.lastRoom,
      authenticated: true,
      publicKey: publicKey || null
    });

    if (typeof callback === 'function') {
      callback({
        success: true,
        user: { id: socket.id, username: cleanUsername },
        roomsList: getPublicRoomsList()
      });
    }

    broadcastOnlineUsers();
  });

  // Listener to update/publish user's ECDH public key for E2EE DMs
  socket.on('publish_public_key', ({ publicKey }) => {
    const u = users.get(socket.id);
    if (u && u.authenticated) {
      u.publicKey = publicKey || null;
      users.set(socket.id, u);
      broadcastOnlineUsers();
    }
  });

  // Middleware guard for authenticated sockets
  const isAuthenticated = () => {
    const u = users.get(socket.id);
    return u && u.authenticated;
  };

  // 2. Join or Create a Chat Room
  socket.on('join_room', ({ roomId, roomName, roomPasskey }, callback) => {
    if (!isAuthenticated()) return;

    const user = users.get(socket.id);
    const key = user.username.toLowerCase();
    const session = userSessions.get(key);

    const targetRoomId = roomId ? getRoomId(roomId) : getRoomId(roomName || 'lobby');
    
    let room = rooms.get(targetRoomId);

    if (!room) {
      // Create new private/public room
      room = {
        id: targetRoomId,
        name: roomName || targetRoomId,
        isPrivate: !!roomPasskey,
        passkey: roomPasskey || '',
        createdBy: user.username,
        messages: []
      };
      rooms.set(targetRoomId, room);
      io.emit('room_created', getPublicRoomsList());
    } else if (room.isPrivate && room.passkey !== roomPasskey) {
      if (typeof callback === 'function') {
        callback({ success: false, error: 'Incorrect room passkey' });
      }
      return;
    }

    const previousRoom = user.currentRoom;

    // Leave previous socket room if switching
    if (previousRoom && previousRoom !== targetRoomId) {
      socket.leave(previousRoom);
      broadcastRoomUsers(previousRoom);
    }

    // Join target socket room
    socket.join(targetRoomId);
    user.currentRoom = targetRoomId;
    if (session) session.lastRoom = targetRoomId;
    users.set(socket.id, user);

    if (typeof callback === 'function') {
      callback({
        success: true,
        room: {
          id: room.id,
          name: room.name,
          isPrivate: room.isPrivate,
          messages: room.messages
        }
      });
    }

    // Notify members in room ONLY on initial new login (suppress on F5 refresh and room browsing)
    if (session && session.isNewLogin) {
      session.isNewLogin = false;
      socket.to(targetRoomId).emit('user_joined_room', {
        userId: user.id,
        username: user.username,
        roomId: targetRoomId
      });
    }

    broadcastRoomUsers(targetRoomId);
  });

  // Socket Message Rate Limiter Map (socketId -> { lastMsgTime, msgCount })
  const socketRateLimits = new Map();

  function isSafeMediaPayload(mediaData) {
    if (!mediaData) return true;
    if (typeof mediaData !== 'string') return false;
    const lower = mediaData.toLowerCase().trim();
    
    // Reject malicious script schemes or raw text/html data URLs
    if (lower.startsWith('javascript:') || lower.startsWith('vbscript:') || lower.startsWith('data:text/html')) {
      return false;
    }

    const safePrefixes = [
      'data:image/', 'data:audio/', 'data:video/',
      'data:application/pdf',
      'data:application/vnd.ms-excel', 'data:application/vnd.openxmlformats-officedocument.spreadsheetml', 'data:text/csv',
      'data:application/msword', 'data:application/vnd.openxmlformats-officedocument.wordprocessingml',
      'data:application/vnd.ms-powerpoint', 'data:application/vnd.openxmlformats-officedocument.presentationml',
      'data:text/plain', 'data:text/markdown', 'data:application/json'
    ];
    return safePrefixes.some(prefix => lower.startsWith(prefix));
  }

  // 3. Send Message (Room or Direct 1-on-1)
  socket.on('send_message', ({ text, media, mediaType, mediaName, encryptedPayload, recipientId }, callback) => {
    if (!isAuthenticated()) return;

    const user = users.get(socket.id);
    if (!user) return;

    // Socket Rate Limiting (max 5 messages per second)
    const now = Date.now();
    let rate = socketRateLimits.get(socket.id);
    if (!rate || (now - rate.lastMsgTime > 1000)) {
      rate = { lastMsgTime: now, msgCount: 1 };
    } else {
      rate.msgCount += 1;
      if (rate.msgCount > 5) {
        if (typeof callback === 'function') callback({ success: false, error: 'Slow down! Message rate limit exceeded.' });
        return;
      }
    }
    socketRateLimits.set(socket.id, rate);

    // Media Security Verification
    if (media && !isSafeMediaPayload(media)) {
      if (typeof callback === 'function') callback({ success: false, error: 'Unsafe attachment rejected.' });
      return;
    }

    const msgObj = {
      id: 'msg_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7),
      senderId: user.id,
      senderName: user.username,
      text: (text || '').slice(0, 2000),
      media: media || null,
      mediaType: mediaType ? String(mediaType).slice(0, 30) : null,
      mediaName: mediaName ? String(mediaName).slice(0, 100) : null,
      encryptedPayload: encryptedPayload || null,
      timestamp: new Date().toISOString(),
      reactions: {}
    };

    if (recipientId) {
      // Direct Message (Private 1-on-1)
      const targetKey = String(recipientId).trim().toLowerCase();
      let recipient = null;
      
      for (const [sId, u] of users.entries()) {
        if (sId === recipientId || u.id === recipientId || (u.username && u.username.trim().toLowerCase() === targetKey)) {
          recipient = u;
          break;
        }
      }

      msgObj.isDirect = true;
      msgObj.recipientName = recipient ? recipient.username : recipientId;

      if (recipient) {
        msgObj.recipientId = recipient.id;
        io.to(recipient.id).emit('new_message', msgObj);
        if (socket.id !== recipient.id) {
          socket.emit('new_message', msgObj);
        }
      } else {
        // Recipient reconnecting / offline: still send back to sender so sender UI stays smooth
        socket.emit('new_message', msgObj);
      }
      
      if (typeof callback === 'function') callback({ success: true, message: msgObj });
    } else {
      // Room Message
      const roomId = user.currentRoom;
      if (!roomId || !rooms.has(roomId)) return;

      const room = rooms.get(roomId);
      room.messages.push(msgObj);
      
      // Limit in-memory message history buffer (max 100 per room)
      if (room.messages.length > 100) room.messages.shift();

      io.to(roomId).emit('new_message', msgObj);
      if (typeof callback === 'function') callback({ success: true, message: msgObj });
    }
  });

  // 4. Message Reaction
  socket.on('add_reaction', ({ messageId, emoji }) => {
    if (!isAuthenticated()) return;
    const user = users.get(socket.id);
    const roomId = user?.currentRoom;
    if (!roomId || !rooms.has(roomId)) return;

    const room = rooms.get(roomId);
    const msg = room.messages.find(m => m.id === messageId);
    if (msg) {
      if (!msg.reactions[emoji]) msg.reactions[emoji] = [];
      const userIndex = msg.reactions[emoji].indexOf(user.username);
      if (userIndex > -1) {
        msg.reactions[emoji].splice(userIndex, 1);
        if (msg.reactions[emoji].length === 0) delete msg.reactions[emoji];
      } else {
        msg.reactions[emoji].push(user.username);
      }
      io.to(roomId).emit('reaction_updated', { messageId, reactions: msg.reactions });
    }
  });

  // 5. Typing Status Indicator
  socket.on('typing', ({ isTyping, recipientId }) => {
    if (!isAuthenticated()) return;
    const user = users.get(socket.id);
    if (!user) return;

    if (recipientId) {
      let recipientSocketId = null;
      for (const [sId, u] of users.entries()) {
        if (sId === recipientId || u.username.trim().toLowerCase() === String(recipientId).trim().toLowerCase()) {
          recipientSocketId = sId;
          break;
        }
      }
      if (recipientSocketId) {
        socket.to(recipientSocketId).emit('user_typing', { userId: user.id, username: user.username, isTyping, isDirect: true });
      }
    } else if (user.currentRoom) {
      socket.to(user.currentRoom).emit('user_typing', { userId: user.id, username: user.username, isTyping, isDirect: false });
    }
  });

  // 6. Delete Message / Attachment
  socket.on('delete_message', ({ messageId, recipientId }) => {
    if (!isAuthenticated()) return;
    const user = users.get(socket.id);
    if (!user || !messageId) return;

    const deleterName = user.username;

    if (recipientId) {
      // Direct Message Deletion
      const targetKey = String(recipientId).trim().toLowerCase();
      const myKey = user.username.trim().toLowerCase();
      const payload = { messageId, deletedBy: deleterName, isDirect: true };

      for (const [sId, u] of users.entries()) {
        if (u && u.username) {
          const uKey = u.username.trim().toLowerCase();
          if (uKey === targetKey || uKey === myKey || sId === recipientId) {
            io.to(sId).emit('message_deleted', payload);
          }
        }
      }
    } else {
      // Room Message Deletion
      const roomId = user.currentRoom;
      if (roomId && rooms.has(roomId)) {
        const room = rooms.get(roomId);
        const index = room.messages.findIndex(m => m.id === messageId);
        if (index > -1) {
          room.messages.splice(index, 1);
        }
      }
      const targetRoom = user.currentRoom || 'lobby';
      io.to(targetRoom).emit('message_deleted', { messageId, deletedBy: deleterName, roomId: targetRoom, isDirect: false });
    }
  });

  // 7. Edit Message Text
  socket.on('edit_message', ({ messageId, newText, recipientId }) => {
    if (!isAuthenticated()) return;
    const user = users.get(socket.id);
    if (!user) return;

    const sanitizedText = (newText || '').slice(0, 2000).trim();
    if (!sanitizedText) return;

    if (recipientId) {
      // Direct Message Edit
      const targetKey = String(recipientId).trim().toLowerCase();
      let recipientSocketId = null;
      for (const [sId, u] of users.entries()) {
        if (sId === recipientId || u.username.trim().toLowerCase() === targetKey) {
          recipientSocketId = sId;
          break;
        }
      }

      const payload = { messageId, newText: sanitizedText, isEdited: true };
      if (recipientSocketId) {
        io.to(recipientSocketId).emit('message_edited', payload);
      }
      socket.emit('message_edited', payload);
    } else {
      // Room Message Edit
      const roomId = user.currentRoom;
      if (!roomId || !rooms.has(roomId)) return;

      const room = rooms.get(roomId);
      const msg = room.messages.find(m => m.id === messageId);
      if (msg && msg.senderName.toLowerCase() === user.username.toLowerCase()) {
        msg.text = sanitizedText;
        msg.edited = true;
        io.to(roomId).emit('message_edited', { messageId, newText: sanitizedText, isEdited: true, roomId });
      }
    }
  });

  // 8. Burn Room / Wipe Chat History Immediately
  socket.on('burn_room', () => {
    if (!isAuthenticated()) return;
    const user = users.get(socket.id);
    const roomId = user?.currentRoom;
    if (!roomId || !rooms.has(roomId)) return;

    const room = rooms.get(roomId);
    room.messages = [];
    
    io.to(roomId).emit('room_burned', { roomId, burnedBy: user.username });
  });

  // 9. Burn Direct Message / Wipe 1-on-1 DM Chat History for both participants
  socket.on('burn_dm', ({ recipientId }) => {
    if (!isAuthenticated()) return;
    const user = users.get(socket.id);
    if (!user || !recipientId) return;

    const targetKey = String(recipientId).trim().toLowerCase();

    let recipientSocketId = null;
    let recipientUsername = recipientId;
    for (const [sId, u] of users.entries()) {
      if (sId === recipientId || (u.username && u.username.trim().toLowerCase() === targetKey)) {
        recipientSocketId = sId;
        recipientUsername = u.username;
        break;
      }
    }

    if (recipientSocketId) {
      io.to(recipientSocketId).emit('dm_burned', { peerName: user.username, burnedBy: user.username });
    }
    socket.emit('dm_burned', { peerName: recipientUsername, burnedBy: user.username });
  });

  // 7. Explicit Logout (Fired when user clicks Logout button)
  socket.on('explicit_logout', () => {
    const user = users.get(socket.id);
    if (user) {
      const key = user.username.trim().toLowerCase();
      const session = userSessions.get(key);
      const currentRoom = user.currentRoom || (session ? session.lastRoom : null);

      if (session) {
        session.isExplicitLogout = true;
        if (session.disconnectTimer) {
          clearTimeout(session.disconnectTimer);
          session.disconnectTimer = null;
        }
        userSessions.delete(key);
      }

      if (currentRoom) {
        socket.leave(currentRoom);
        io.to(currentRoom).emit('user_left_room', {
          username: user.username,
          roomId: currentRoom
        });
        broadcastRoomUsers(currentRoom);
      }

      users.delete(socket.id);
      broadcastOnlineUsers();
      io.emit('room_created', getPublicRoomsList());
    }
  });

  // 8. Disconnect Handler (Suppresses F5 page refresh notices, delays broadcast by 10s for true tab close)
  socket.on('disconnect', () => {
    socketRateLimits.delete(socket.id);
    const user = users.get(socket.id);
    if (!user) return;

    console.log(`[-] Socket disconnected: ${user.username} (${socket.id})`);
    const key = user.username.trim().toLowerCase();
    const session = userSessions.get(key);
    const lastRoom = user.currentRoom || (session ? session.lastRoom : null);

    users.delete(socket.id);
    broadcastOnlineUsers();
    if (lastRoom) broadcastRoomUsers(lastRoom);

    if (session && !session.isExplicitLogout) {
      // Check if user has any remaining socket connections
      let hasOtherSocket = false;
      for (const u of users.values()) {
        if (u.username.trim().toLowerCase() === key) {
          hasOtherSocket = true;
          break;
        }
      }

      if (!hasOtherSocket) {
        if (session.disconnectTimer) clearTimeout(session.disconnectTimer);

        // 10-second grace period for F5 refresh or momentary disconnect
        session.disconnectTimer = setTimeout(() => {
          let reconnected = false;
          for (const u of users.values()) {
            if (u.username.trim().toLowerCase() === key) {
              reconnected = true;
              break;
            }
          }

          if (!reconnected) {
            const targetRoom = session.lastRoom || lastRoom;
            if (targetRoom) {
              io.to(targetRoom).emit('user_left_room', {
                username: session.username,
                roomId: targetRoom
              });
              broadcastRoomUsers(targetRoom);
            }
            userSessions.delete(key);
            broadcastOnlineUsers();
          }
        }, 10000);
      }
    }
  });
});

function getPublicRoomsList() {
  const list = [];
  for (const [id, room] of rooms.entries()) {
    list.push({
      id: room.id,
      name: room.name,
      isPrivate: room.isPrivate,
      userCount: io.sockets.adapter.rooms.get(id)?.size || 0
    });
  }
  return list;
}

function broadcastOnlineUsers() {
  const activeUsersMap = new Map();
  for (const u of users.values()) {
    if (u && u.authenticated && u.username) {
      activeUsersMap.set(u.username.trim().toLowerCase(), {
        id: u.id,
        username: u.username.trim(),
        currentRoom: u.currentRoom,
        publicKey: u.publicKey || null
      });
    }
  }
  io.emit('online_users', Array.from(activeUsersMap.values()));
}

function broadcastRoomUsers(roomId) {
  const roomSockets = io.sockets.adapter.rooms.get(roomId);
  const roomUserList = [];
  if (roomSockets) {
    for (const socketId of roomSockets) {
      const u = users.get(socketId);
      if (u) roomUserList.push({ id: u.id, username: u.username });
    }
  }
  io.to(roomId).emit('room_users', { roomId, users: roomUserList });
}

server.listen(PORT, () => {
  console.log(`\n==================================================`);
  console.log(`🚀 Ephemeral Passkey Chat Server is running!`);
  console.log(`🔗 Local URL: http://localhost:${PORT}`);
  console.log(`🔑 Default Secret Passkey: ${APP_PASSKEY}`);
  console.log(`==================================================\n`);
});
