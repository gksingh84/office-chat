const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 1e7 // 10MB payload limit for ephemeral image/audio sharing
});

// Master passkey for app access
const APP_PASSKEY = process.env.PASSKEY || 'passkey4321';
const PORT = process.env.PORT || 3000;

// Serve static frontend files
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// API endpoint to verify passkey before socket connection
app.post('/api/verify-passkey', (req, res) => {
  const { passkey } = req.body;
  if (passkey === APP_PASSKEY) {
    return res.json({ success: true, message: 'Access granted' });
  }
  return res.status(401).json({ success: false, message: 'Invalid secret passkey' });
});

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

  // 1. Authenticate with Master Passkey
  socket.on('authenticate', ({ passkey, username }, callback) => {
    if (passkey !== APP_PASSKEY) {
      if (typeof callback === 'function') {
        callback({ success: false, error: 'Incorrect Passkey! Access Denied.' });
      }
      return;
    }

    const cleanUsername = (username || 'Anonymous').trim().slice(0, 20);
    const key = cleanUsername.toLowerCase();

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
        isExplicitLogout: false
      };
      userSessions.set(key, session);
    }

    session.isExplicitLogout = false;

    users.set(socket.id, {
      id: socket.id,
      username: cleanUsername,
      currentRoom: session.lastRoom,
      authenticated: true
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

    const previousRoom = user.currentRoom || (session ? session.lastRoom : null);
    const isSameRoomReconnect = (previousRoom === targetRoomId);

    // Leave current room if switching rooms
    if (previousRoom && previousRoom !== targetRoomId) {
      socket.leave(previousRoom);
      socket.to(previousRoom).emit('user_left_room', {
        userId: user.id,
        username: user.username,
        roomId: previousRoom
      });
    }

    // Join target room
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

    // Notify members in room ONLY if user wasn't already in this room before reconnecting
    if (!isSameRoomReconnect) {
      socket.to(targetRoomId).emit('user_joined_room', {
        userId: user.id,
        username: user.username,
        roomId: targetRoomId
      });
    }

    broadcastRoomUsers(targetRoomId);
  });

  // 3. Send Message (Room or Direct 1-on-1)
  socket.on('send_message', ({ text, media, mediaType, mediaName, recipientId }, callback) => {
    if (!isAuthenticated()) return;

    const user = users.get(socket.id);
    if (!user) return;

    const msgObj = {
      id: 'msg_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7),
      senderId: user.id,
      senderName: user.username,
      text: (text || '').slice(0, 2000),
      media: media || null, // Base64 data URL for ephemeral image/audio/document
      mediaType: mediaType || null,
      mediaName: mediaName || null,
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
    if (!user) return;

    const deleterName = user.username;

    if (recipientId) {
      // Direct Message Deletion
      const targetKey = String(recipientId).trim().toLowerCase();
      let recipientSocketId = null;
      for (const [sId, u] of users.entries()) {
        if (sId === recipientId || u.username.trim().toLowerCase() === targetKey) {
          recipientSocketId = sId;
          break;
        }
      }
      const payload = { messageId, deletedBy: deleterName, isDirect: true };
      if (recipientSocketId) {
        io.to(recipientSocketId).emit('message_deleted', payload);
      }
      socket.emit('message_deleted', payload);
    } else {
      // Room Message Deletion
      const roomId = user.currentRoom;
      if (!roomId || !rooms.has(roomId)) return;

      const room = rooms.get(roomId);
      const index = room.messages.findIndex(m => m.id === messageId);
      if (index > -1) {
        const msg = room.messages[index];
        if (msg.senderName.toLowerCase() === user.username.toLowerCase()) {
          room.messages.splice(index, 1);
          io.to(roomId).emit('message_deleted', { messageId, deletedBy: deleterName, roomId, isDirect: false });
        }
      }
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
      }

      users.delete(socket.id);
      broadcastOnlineUsers();
      io.emit('room_created', getPublicRoomsList());
    }
  });

  // 8. Disconnect Handler (Suppresses F5 page refresh notices, delays broadcast by 10s for true tab close)
  socket.on('disconnect', () => {
    const user = users.get(socket.id);
    if (!user) return;

    console.log(`[-] Socket disconnected: ${user.username} (${socket.id})`);
    const key = user.username.trim().toLowerCase();
    const session = userSessions.get(key);

    users.delete(socket.id);
    broadcastOnlineUsers();

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
            if (session.lastRoom) {
              io.to(session.lastRoom).emit('user_left_room', {
                username: session.username,
                roomId: session.lastRoom
              });
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
        currentRoom: u.currentRoom
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
