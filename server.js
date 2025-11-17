const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const dotenv = require('dotenv');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { db, Message, User, Notification, TempFile, VoiceMessage } = require('./db');
const { notifyActivity } = require('./telegram');

dotenv.config();

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb' }));
app.use(express.static('public'));

// Serve temp files (images)
app.use('/temp', express.static('temp'));

// Serve uploads (voice)
app.use('/uploads', express.static('uploads'));

// Upload folders
const uploadDir = path.join(__dirname, 'uploads');
const tempDir = path.join(__dirname, 'temp');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);
if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);

// Multer config - Temp files
const tempStorage = multer.diskStorage({
  destination: tempDir,
  filename: (req, file, cb) => {
    cb(null, Date.now() + '-' + file.originalname);
  }
});
const uploadTemp = multer({ 
  storage: tempStorage, 
  limits: { fileSize: 50 * 1024 * 1024 } // 50MB for audio/video
});

// Multer config - Permanent files
const permanentStorage = multer.diskStorage({
  destination: uploadDir,
  filename: (req, file, cb) => {
    cb(null, Date.now() + '-' + file.originalname);
  }
});
const uploadPermanent = multer({ 
  storage: permanentStorage, 
  limits: { fileSize: 500 * 1024 * 1024 } // 500MB
});

const PORT = process.env.PORT || 5555;

// Cleanup expired temp files every hour
setInterval(() => {
  const now = new Date();
  db.all('SELECT filename FROM temp_files WHERE expiresAt < ?', [now.toISOString()], (err, files) => {
    if (err) return console.log('Cleanup error:', err.message);
    
    files?.forEach(file => {
      const filePath = path.join(tempDir, file.filename);
      fs.unlink(filePath, (err) => {
        if (err) console.log(`Failed to delete ${file.filename}:`, err.message);
        else console.log(`🗑️ Deleted expired file: ${file.filename}`);
      });

      db.run('DELETE FROM temp_files WHERE filename = ?', [file.filename]);
      TempFile.deleteOne({ filename: file.filename }).catch(e => console.log('MongoDB cleanup error:', e.message));
    });
  });
}, 60 * 60 * 1000); // Run every hour

console.log('✓ Temp file cleanup scheduled (1 hour interval)');

// Lấy IP từ request hoặc socket
const getClientIp = (reqOrSocket) => {
  if (reqOrSocket.handshake) {
    return reqOrSocket.handshake.headers['x-forwarded-for']?.split(',')[0].trim() || 
           reqOrSocket.handshake.address ||
           reqOrSocket.request.connection?.remoteAddress ||
           'unknown';
  }
  return reqOrSocket.headers['x-forwarded-for']?.split(',')[0].trim() || 
         reqOrSocket.socket?.remoteAddress ||
         reqOrSocket.connection?.remoteAddress ||
         'unknown';
};

// ===== REST API =====

// Get messages
app.get('/api/messages', (req, res) => {
  const month = req.query.month;
  const query = 'SELECT * FROM messages WHERE isDeleted = 0';
  const params = [];

  if (month) {
    db.all(query + ' AND month = ? ORDER BY timestamp DESC', [month], (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    });
  } else {
    db.all(query + ' ORDER BY timestamp DESC LIMIT 200', [], (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    });
  }
});

// Get months
app.get('/api/months', (req, res) => {
  db.all('SELECT DISTINCT month FROM messages WHERE isDeleted = 0 ORDER BY month DESC', (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows.map(r => r.month));
  });
});

// Check if admin
app.post('/api/check-admin', (req, res) => {
  const { username, ip } = req.body;
  db.get('SELECT isAdmin FROM users WHERE username = ? AND ip = ?', [username, ip], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ isAdmin: row?.isAdmin || 0 });
  });
});

// Register user
app.post('/api/user', (req, res) => {
  const { username } = req.body;
  const ip = getClientIp(req);

  db.run('INSERT OR IGNORE INTO users (username, ip) VALUES (?, ?)', [username, ip], function(err) {
    if (err && err.code !== 'SQLITE_CONSTRAINT') {
      return res.status(500).json({ error: err.message });
    }
    
    User.findOneAndUpdate(
      { username },
      { username, ip, joinedAt: new Date() },
      { upsert: true, new: true }
    ).catch(e => console.log('MongoDB User Error (non-critical):', e.message));

    notifyActivity('user', { username, ip });
    res.json({ success: true });
  });
});

// Delete message (Admin)
app.post('/api/message/:id/delete', (req, res) => {
  const { username, ip } = req.body;
  const msgId = req.params.id;

  // Check if admin
  db.get('SELECT isAdmin FROM users WHERE username = ? AND ip = ?', [username, ip], (err, user) => {
    if (err || !user?.isAdmin) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    db.run(
      'UPDATE messages SET isDeleted = 1, deletedBy = ?, deletedAt = DATETIME("now") WHERE id = ?',
      [username, msgId],
      (err) => {
        if (err) return res.status(500).json({ error: err.message });
        
        Message.updateOne(
          { _id: msgId },
          { isDeleted: true, deletedBy: username, deletedAt: new Date() }
        ).catch(e => console.log('MongoDB Delete Error:', e.message));

        io.emit('message-deleted', { messageId: msgId });
        res.json({ success: true });
      }
    );
  });
});

// Revoke message (User)
app.post('/api/message/:id/revoke', (req, res) => {
  const { username } = req.body;
  const msgId = req.params.id;

  db.get('SELECT username FROM messages WHERE id = ?', [msgId], (err, msg) => {
    if (err || msg?.username !== username) {
      return res.status(403).json({ error: 'Can only revoke your own message' });
    }

    db.run(
      'UPDATE messages SET isDeleted = 1, deletedBy = ?, deletedAt = DATETIME("now") WHERE id = ?',
      [username, msgId],
      (err) => {
        if (err) return res.status(500).json({ error: err.message });
        
        Message.updateOne(
          { _id: msgId },
          { isDeleted: true, deletedBy: username, deletedAt: new Date() }
        ).catch(e => console.log('MongoDB Revoke Error:', e.message));

        io.emit('message-deleted', { messageId: msgId });
        res.json({ success: true });
      }
    );
  });
});

// Upload temporary file (images, max 7 days)
app.post('/api/upload/temp', uploadTemp.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  
  const { username } = req.body;
  const expiryDays = 7;
  const expiresAt = new Date(Date.now() + expiryDays * 24 * 60 * 60 * 1000);

  db.run(
    'INSERT INTO temp_files (filename, originalName, fileType, size, uploadedBy, expiresAt) VALUES (?, ?, ?, ?, ?, ?)',
    [req.file.filename, req.file.originalname, req.file.mimetype, req.file.size, username, expiresAt.toISOString()],
    (err) => {
      if (err) console.log('Temp file DB error:', err.message);
    }
  );

  TempFile.create({
    filename: req.file.filename,
    originalName: req.file.originalname,
    fileType: req.file.mimetype,
    size: req.file.size,
    uploadedBy: username,
    expiresAt: expiresAt
  }).catch(e => console.log('MongoDB temp file error (non-critical):', e.message));

  res.json({ 
    filename: req.file.filename,
    url: `/temp/${req.file.filename}`,
    expiresAt: expiresAt.toISOString(),
    expiryDays: expiryDays
  });
});

// Upload permanent file (voice messages)
app.post('/api/upload/permanent', uploadPermanent.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  
  res.json({ 
    filename: req.file.filename,
    url: `/uploads/${req.file.filename}`
  });
});

// Get notifications
app.get('/api/notifications/:username', (req, res) => {
  const { username } = req.params;
  db.all(
    'SELECT * FROM notifications WHERE username = ? ORDER BY createdAt DESC LIMIT 50',
    [username],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    }
  );
});

// Mark notification as read
app.post('/api/notification/:id/read', (req, res) => {
  const { id } = req.params;
  db.run('UPDATE notifications SET read = 1 WHERE id = ?', [id], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

// ===== SOCKET.IO =====

const connectedUsers = new Map();

io.on('connection', (socket) => {
  console.log(`✓ Client Connected: ${socket.id}`);

  socket.on('join', (userData) => {
    socket.username = userData.username;
    socket.ip = getClientIp(socket);
    connectedUsers.set(socket.id, { username: userData.username, ip: socket.ip });
    
    console.log(`👤 ${socket.username} (${socket.ip}) joined`);
    socket.broadcast.emit('user-joined', userData);
    io.emit('users-online', Array.from(connectedUsers.values()));
  });

  // Regular message
  socket.on('message', (data) => {
    console.log(`📝 Message from ${data.username}: "${data.content}"`);
    
    const timestamp = new Date();
    const month = timestamp.toLocaleString('vi-VN', { month: 'long', year: 'numeric' });

    const messageData = {
      username: data.username,
      content: data.content,
      type: 'text',
      ip: getClientIp(socket),
      timestamp: timestamp.toISOString(),
      month: month
    };

    // Save to SQLite
    db.run(
      'INSERT INTO messages (username, content, type, ip, month) VALUES (?, ?, ?, ?, ?)',
      [messageData.username, messageData.content, messageData.type, messageData.ip, messageData.month],
      function(err) {
        if (err) {
          console.log('❌ SQLite Error:', err.message);
          return;
        }
        console.log(`✅ Message saved to SQLite (ID: ${this.lastID})`);
        messageData.id = this.lastID;
        
        // Save to MongoDB (separate object without id field)
        const mongoData = {
          username: messageData.username,
          content: messageData.content,
          type: messageData.type,
          ip: messageData.ip,
          timestamp: messageData.timestamp,
          month: messageData.month
        };
        const msg = new Message(mongoData);
        msg.save().catch(e => console.log('MongoDB Message Error (non-critical):', e.message));

        // Broadcast
        io.emit('new-message', messageData);
        notifyActivity('message', { username: data.username, ip: messageData.ip });
      }
    );
  });

  // Image message
  socket.on('image-message', (data) => {
    console.log(`🖼️ Image from ${data.username}: ${data.imageUrl}`);
    
    const timestamp = new Date();
    const month = timestamp.toLocaleString('vi-VN', { month: 'long', year: 'numeric' });

    const messageData = {
      username: data.username,
      content: data.imageUrl,
      type: 'image',
      ip: getClientIp(socket),
      timestamp: timestamp.toISOString(),
      month: month
    };

    db.run(
      'INSERT INTO messages (username, content, type, ip, month) VALUES (?, ?, ?, ?, ?)',
      [messageData.username, messageData.content, messageData.type, messageData.ip, messageData.month],
      function(err) {
        if (err) return console.log('SQLite Error:', err.message);
        messageData.id = this.lastID;
        
        const mongoData = {
          username: messageData.username,
          content: messageData.content,
          type: messageData.type,
          ip: messageData.ip,
          timestamp: messageData.timestamp,
          month: messageData.month
        };
        const msg = new Message(mongoData);
        msg.save().catch(e => console.log('MongoDB Image Error (non-critical):', e.message));

        io.emit('new-message', messageData);
      }
    );
  });

  // Voice message
  socket.on('voice-message', (data) => {
    const timestamp = new Date();
    const month = timestamp.toLocaleString('vi-VN', { month: 'long', year: 'numeric' });

    const voiceData = {
      username: data.username,
      duration: data.duration,
      fileUrl: data.voiceUrl,
      ip: getClientIp(socket),
      timestamp: timestamp.toISOString(),
      month: month
    };

    db.run(
      'INSERT INTO voice_messages (username, duration, fileUrl, ip, month) VALUES (?, ?, ?, ?, ?)',
      [voiceData.username, voiceData.duration, voiceData.fileUrl, voiceData.ip, voiceData.month],
      function(err) {
        if (err) return console.log('SQLite Voice Error:', err.message);
        voiceData.id = this.lastID;
        
        const mongoData = {
          username: voiceData.username,
          duration: voiceData.duration,
          fileUrl: voiceData.fileUrl,
          ip: voiceData.ip,
          timestamp: voiceData.timestamp,
          month: voiceData.month
        };
        const voice = new VoiceMessage(mongoData);
        voice.save().catch(e => console.log('MongoDB Voice Error (non-critical):', e.message));

        io.emit('new-voice-message', voiceData);
        notifyActivity('message', { username: data.username, ip: voiceData.ip });
      }
    );
  });

  // Delete message
  socket.on('delete-message', (data) => {
    const { messageId, username } = data;

    db.get('SELECT isAdmin FROM users WHERE username = ?', [username], (err, user) => {
      if (!err && user?.isAdmin) {
        db.run(
          'UPDATE messages SET isDeleted = 1, deletedBy = ?, deletedAt = DATETIME("now") WHERE id = ?',
          [username, messageId],
          (err) => {
            if (!err) {
              io.emit('message-deleted', { messageId });
              console.log(`🗑️ Message ${messageId} deleted by admin ${username}`);
            }
          }
        );
      }
    });
  });

  // Revoke message
  socket.on('revoke-message', (data) => {
    const { messageId, username } = data;
    console.log(`↩️ Revoke request: Message ${messageId} by ${username}`);

    db.get('SELECT username FROM messages WHERE id = ?', [messageId], (err, msg) => {
      if (err) {
        console.log(`❌ Error querying message: ${err.message}`);
        return;
      }
      
      if (!msg) {
        console.log(`❌ Message ${messageId} not found`);
        return;
      }
      
      if (msg.username !== username) {
        console.log(`❌ User ${username} cannot revoke message by ${msg.username}`);
        return;
      }
      
      db.run(
        'UPDATE messages SET isDeleted = 1, deletedBy = ?, deletedAt = DATETIME("now") WHERE id = ?',
        [username, messageId],
        (err) => {
          if (err) {
            console.log(`❌ Revoke error: ${err.message}`);
            return;
          }
          console.log(`✅ Message ${messageId} revoked by ${username}`);
          io.emit('message-deleted', { messageId });
        }
      );
    });
  });

  // Send notification
  socket.on('send-notification', (data) => {
    const { toUser, type, message, notificationData } = data;
    
    const notif = {
      username: toUser,
      type: type,
      message: message,
      data: notificationData
    };

    db.run(
      'INSERT INTO notifications (username, type, message, data) VALUES (?, ?, ?, ?)',
      [notif.username, notif.type, notif.message, JSON.stringify(notificationData)],
      (err) => {
        if (!err) {
          io.to(socket.id).emit('new-notification', notif);
        }
      }
    );
  });

  // Voice/Video call
  socket.on('call-user', (data) => {
    const { toUsername, callType } = data;
    
    for (let [socketId, user] of connectedUsers) {
      if (user.username === toUsername) {
        io.to(socketId).emit('incoming-call', {
          from: socket.username,
          callType: callType,
          callerId: socket.id
        });
        break;
      }
    }
  });

  socket.on('call-accepted', (data) => {
    io.to(data.callerId).emit('call-accepted', {
      acceptedBy: socket.username,
      socketId: socket.id
    });
  });

  socket.on('call-rejected', (data) => {
    io.to(data.callerId).emit('call-rejected', {
      rejectedBy: socket.username
    });
  });

  socket.on('ice-candidate', (data) => {
    io.to(data.to).emit('ice-candidate', data.candidate);
  });

  socket.on('offer', (data) => {
    io.to(data.to).emit('offer', data.offer);
  });

  socket.on('answer', (data) => {
    io.to(data.to).emit('answer', data.answer);
  });

  socket.on('disconnect', () => {
    connectedUsers.delete(socket.id);
    io.emit('users-online', Array.from(connectedUsers.values()));
    console.log(`✗ Client Disconnected: ${socket.id}`);
  });
});

server.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════╗
║  📱 MESSAGE BOARD SERVER RUNNING      ║
║  🌐 http://localhost:${PORT}          ║
║  🗄️  SQLite + MongoDB (Redundancy)    ║
║  📬 Telegram Notifications Enabled    ║
║  📸 Image Upload Support              ║
║  🎤 Voice/Video Call Support          ║
╚════════════════════════════════════════╝
  `);
});
