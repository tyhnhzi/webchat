const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const dotenv = require('dotenv');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { db, Message, User, TempFile, Notification } = require('./db');
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

// Upload folders
const tempDir = path.join(__dirname, 'temp');
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
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB for images
  fileFilter: (req, file, cb) => {
    // Only allow images for temp
    if (file.fieldname === 'file' && req.path === '/api/upload/temp') {
      if (file.mimetype.startsWith('image/')) {
        cb(null, true);
      } else {
        cb(new Error('Only image files are allowed for /api/upload/temp'));
      }
    } else if (file.fieldname === 'file' && req.path === '/api/upload/video') {
      // Videos up to 200MB
      cb(null, true);
    } else if (file.fieldname === 'file' && req.path === '/api/upload/voice') {
      // Audio files up to 50MB
      cb(null, true);
    } else {
      cb(null, true);
    }
  }
});

const uploadLarge = multer({ 
  storage: tempStorage, 
  limits: { fileSize: 200 * 1024 * 1024 } // 200MB for videos and large files
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
    db.all(query + ' ORDER BY timestamp DESC LIMIT 2000', [], (err, rows) => {
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

// Upload temporary video (videos, max 7 days, max 200MB)
app.post('/api/upload/video', uploadLarge.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  
  // Check if file is video
  if (!req.file.mimetype.startsWith('video/')) {
    fs.unlink(req.file.path, () => {});
    return res.status(400).json({ error: 'File must be a video' });
  }

  const { username } = req.body;
  const expiryDays = 7;
  const expiresAt = new Date(Date.now() + expiryDays * 24 * 60 * 60 * 1000);

  db.run(
    'INSERT INTO temp_files (filename, originalName, fileType, size, uploadedBy, expiresAt) VALUES (?, ?, ?, ?, ?, ?)',
    [req.file.filename, req.file.originalname, req.file.mimetype, req.file.size, username, expiresAt.toISOString()],
    (err) => {
      if (err) console.log('Video upload DB error:', err.message);
    }
  );

  TempFile.create({
    filename: req.file.filename,
    originalName: req.file.originalname,
    fileType: req.file.mimetype,
    size: req.file.size,
    uploadedBy: username,
    expiresAt: expiresAt
  }).catch(e => console.log('MongoDB video error (non-critical):', e.message));

  res.json({ 
    filename: req.file.filename,
    url: `/temp/${req.file.filename}`,
    expiresAt: expiresAt.toISOString(),
    expiryDays: expiryDays,
    size: req.file.size
  });
});

// Upload temporary voice message (audio, max 7 days, max 50MB)
app.post('/api/upload/voice', uploadTemp.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  
  // Check if file is audio
  if (!req.file.mimetype.startsWith('audio/')) {
    fs.unlink(req.file.path, () => {});
    return res.status(400).json({ error: 'File must be an audio file' });
  }

  const { username, duration } = req.body;
  const expiryDays = 7;
  const expiresAt = new Date(Date.now() + expiryDays * 24 * 60 * 60 * 1000);

  db.run(
    'INSERT INTO temp_files (filename, originalName, fileType, size, uploadedBy, expiresAt) VALUES (?, ?, ?, ?, ?, ?)',
    [req.file.filename, req.file.originalname, req.file.mimetype, req.file.size, username, expiresAt.toISOString()],
    (err) => {
      if (err) console.log('Voice upload DB error:', err.message);
    }
  );

  TempFile.create({
    filename: req.file.filename,
    originalName: req.file.originalname,
    fileType: req.file.mimetype,
    size: req.file.size,
    uploadedBy: username,
    expiresAt: expiresAt
  }).catch(e => console.log('MongoDB voice error (non-critical):', e.message));

  res.json({ 
    filename: req.file.filename,
    url: `/temp/${req.file.filename}`,
    expiresAt: expiresAt.toISOString(),
    expiryDays: expiryDays,
    size: req.file.size,
    duration: duration || 0
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
      res.json(rows || []);
    }
  );
});

// Mark notification as read
app.post('/api/notification/:id/read', (req, res) => {
  const { id } = req.params;
  db.run('UPDATE notifications SET isRead = 1 WHERE id = ?', [id], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    
    Notification.updateOne({ _id: id }, { isRead: true })
      .catch(e => console.log('MongoDB notification update error:', e.message));
    
    res.json({ success: true });
  });
});

// Send notification to user
app.post('/api/notification/send', (req, res) => {
  const { username, message, type = 'info' } = req.body;
  
  if (!username || !message) {
    return res.status(400).json({ error: 'Username and message required' });
  }

  db.run(
    'INSERT INTO notifications (username, message, type) VALUES (?, ?, ?)',
    [username, message, type],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      
      const notif = {
        id: this.lastID,
        username,
        message,
        type,
        isRead: 0,
        createdAt: new Date().toISOString()
      };

      Notification.create(notif)
        .catch(e => console.log('MongoDB notification error:', e.message));

      io.emit('notification-received', notif);
      res.json({ success: true, notificationId: this.lastID });
    }
  );
});

// Upload background image
app.post('/api/background/upload', express.json({ limit: '10mb' }), (req, res) => {
  const { imageData } = req.body;
  
  if (!imageData) {
    return res.status(400).json({ error: 'No image data provided' });
  }

  // Save to file
  const bgPath = path.join(__dirname, 'public', 'background.txt');
  fs.writeFile(bgPath, imageData, (err) => {
    if (err) {
      console.log('Error saving background:', err.message);
      return res.status(500).json({ error: 'Failed to save background' });
    }

    // Broadcast to all users
    io.emit('background-updated', { imageData });
    res.json({ success: true });
  });
});

// Remove background
app.delete('/api/background/remove', (req, res) => {
  const bgPath = path.join(__dirname, 'public', 'background.txt');
  
  fs.unlink(bgPath, (err) => {
    if (err && err.code !== 'ENOENT') {
      console.log('Error deleting background:', err.message);
      return res.status(500).json({ error: 'Failed to delete background' });
    }

    // Broadcast to all users
    io.emit('background-removed');
    res.json({ success: true });
  });
});

// Get current background
app.get('/api/background', (req, res) => {
  const bgPath = path.join(__dirname, 'public', 'background.txt');
  
  fs.readFile(bgPath, 'utf8', (err, data) => {
    if (err) {
      return res.json({ imageData: null });
    }
    res.json({ imageData: data });
  });
});

// Get user profile
app.get('/api/profile/:username', (req, res) => {
  const { username } = req.params;
  
  db.get('SELECT * FROM users WHERE username = ?', [username], (err, user) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!user) return res.status(404).json({ error: 'User not found' });
    
    // Get message count
    db.get('SELECT COUNT(*) as count FROM messages WHERE username = ? AND isDeleted = 0', [username], (err, result) => {
      if (err) return res.status(500).json({ error: err.message });
      
      res.json({
        ...user,
        messageCount: result.count
      });
    });
  });
});

// Update user profile
app.put('/api/profile/:username', express.json(), (req, res) => {
  const { username } = req.params;
  const { avatar, bio, status } = req.body;
  
  db.run(
    'UPDATE users SET avatar = ?, bio = ?, status = ? WHERE username = ?',
    [avatar, bio, status, username],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      
      // Broadcast profile update to all users
      io.emit('profile-updated', { username, avatar, bio, status });
      
      res.json({ success: true });
    }
  );
});

// Get all users with stats
app.get('/api/users', (req, res) => {
  db.all('SELECT username, avatar, status, joinedAt FROM users ORDER BY joinedAt DESC', [], (err, users) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(users);
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
    const month = timestamp.toLocaleString('vi-VN', { month: 'long', year: 'numeric', timeZone: 'Asia/Ho_Chi_Minh' });

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
        
        // Send notification to other users
        const notificationMessage = `💬 ${messageData.username}: ${messageData.content.substring(0, 50)}${messageData.content.length > 50 ? '...' : ''}`;
        io.emit('message-notification', {
          from: messageData.username,
          message: notificationMessage,
          type: 'message',
          timestamp: messageData.timestamp
        });
        
        notifyActivity('message', { username: data.username, ip: messageData.ip });
      }
    );
  });

  // Image message
  socket.on('image-message', (data) => {
    console.log(`🖼️ Image from ${data.username}: ${data.imageUrl}`);
    
    const timestamp = new Date();
    const month = timestamp.toLocaleString('vi-VN', { month: 'long', year: 'numeric', timeZone: 'Asia/Ho_Chi_Minh' });

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
        
        // Send notification for image
        const notificationMessage = `🖼️ ${messageData.username} đã gửi ảnh`;
        io.emit('message-notification', {
          from: messageData.username,
          message: notificationMessage,
          type: 'image',
          timestamp: messageData.timestamp
        });
      }
    );
  });

  // Video message
  socket.on('video-message', (data) => {
    console.log(`🎥 Video from ${data.username}: ${data.videoUrl}`);
    
    const timestamp = new Date();
    const month = timestamp.toLocaleString('vi-VN', { month: 'long', year: 'numeric', timeZone: 'Asia/Ho_Chi_Minh' });

    const messageData = {
      username: data.username,
      content: data.videoUrl,
      type: 'video',
      ip: getClientIp(socket),
      timestamp: timestamp.toISOString(),
      month: month,
      fileSize: data.fileSize || 0
    };

    db.run(
      'INSERT INTO messages (username, content, type, ip, month, fileSize) VALUES (?, ?, ?, ?, ?, ?)',
      [messageData.username, messageData.content, messageData.type, messageData.ip, messageData.month, messageData.fileSize],
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
        msg.save().catch(e => console.log('MongoDB Video Error (non-critical):', e.message));

        io.emit('new-message', messageData);
        
        // Send notification for video
        const notificationMessage = `🎥 ${messageData.username} đã gửi video`;
        io.emit('message-notification', {
          from: messageData.username,
          message: notificationMessage,
          type: 'video',
          timestamp: messageData.timestamp
        });
      }
    );
  });

  // Voice message
  socket.on('voice-message', (data) => {
    console.log(`🎤 Voice from ${data.username}: ${data.voiceUrl} (${data.duration}s)`);
    
    const timestamp = new Date();
    const month = timestamp.toLocaleString('vi-VN', { month: 'long', year: 'numeric', timeZone: 'Asia/Ho_Chi_Minh' });

    const messageData = {
      username: data.username,
      content: data.voiceUrl,
      type: 'voice',
      ip: getClientIp(socket),
      timestamp: timestamp.toISOString(),
      month: month,
      duration: data.duration || 0,
      fileSize: data.fileSize || 0
    };

    db.run(
      'INSERT INTO messages (username, content, type, ip, month, duration, fileSize) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [messageData.username, messageData.content, messageData.type, messageData.ip, messageData.month, messageData.duration, messageData.fileSize],
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
        msg.save().catch(e => console.log('MongoDB Voice Error (non-critical):', e.message));

        io.emit('new-message', messageData);
        
        // Send notification for voice
        const notificationMessage = `🎤 ${messageData.username} đã gửi tin nhắn thoại`;
        io.emit('message-notification', {
          from: messageData.username,
          message: notificationMessage,
          type: 'voice',
          timestamp: messageData.timestamp
        });
      }
    );
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

  socket.on('disconnect', () => {
    connectedUsers.delete(socket.id);
    io.emit('users-online', Array.from(connectedUsers.values()));
    console.log(`✗ Client Disconnected: ${socket.id}`);
  });
});

server.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════╗
║  📱 MESSAGE BOARD SERVER RUNNING       ║
║  🌐 http://localhost:${PORT}           ║
║  🗄️  SQLite + MongoDB (Redundancy)     ║
║  📬 Telegram Notifications Enabled     ║
║  📸 Image Upload Support               ║
╚════════════════════════════════════════╝
  `);
});
