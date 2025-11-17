const sqlite3 = require('sqlite3').verbose();
const mongoose = require('mongoose');
const path = require('path');

// SQLite Database
const db = new sqlite3.Database(path.join(__dirname, 'messages.db'), (err) => {
  if (err) console.error('SQLite Error:', err);
  else console.log('✓ SQLite Connected');
});

db.serialize(() => {
  // Check if table exists and add column if needed
  db.run(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL,
      content TEXT NOT NULL,
      type TEXT DEFAULT 'text',
      ip TEXT NOT NULL,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      month TEXT NOT NULL,
      isDeleted INTEGER DEFAULT 0,
      deletedBy TEXT,
      deletedAt DATETIME
    )
  `, (err) => {
    if (err) console.error('Create table error:', err.message);
    
    // Add type column if it doesn't exist
    db.run(`ALTER TABLE messages ADD COLUMN type TEXT DEFAULT 'text'`, (err) => {
      if (err && !err.message.includes('duplicate column')) {
        console.log('✓ Type column added or already exists');
      }
    });
  });

  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      ip TEXT NOT NULL,
      isAdmin INTEGER DEFAULT 0,
      joinedAt DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL,
      type TEXT NOT NULL,
      message TEXT NOT NULL,
      data TEXT,
      read INTEGER DEFAULT 0,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS temp_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT NOT NULL,
      originalName TEXT NOT NULL,
      fileType TEXT NOT NULL,
      size INTEGER,
      uploadedBy TEXT NOT NULL,
      expiresAt DATETIME NOT NULL,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS voice_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL,
      duration INTEGER,
      fileUrl TEXT NOT NULL,
      ip TEXT NOT NULL,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      month TEXT NOT NULL
    )
  `);
});

// MongoDB Schemas
const messageSchema = new mongoose.Schema({
  username: String,
  content: String,
  type: { type: String, default: 'text' },
  ip: String,
  timestamp: { type: Date, default: Date.now },
  month: String,
  isDeleted: { type: Boolean, default: false },
  deletedBy: String,
  deletedAt: Date
});

const userSchema = new mongoose.Schema({
  username: { type: String, unique: true },
  ip: String,
  isAdmin: { type: Boolean, default: false },
  joinedAt: { type: Date, default: Date.now }
});

const notificationSchema = new mongoose.Schema({
  username: String,
  type: String,
  message: String,
  data: mongoose.Schema.Types.Mixed,
  read: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
});

const Message = mongoose.model('Message', messageSchema);
const User = mongoose.model('User', userSchema);
const Notification = mongoose.model('Notification', notificationSchema);

const tempFileSchema = new mongoose.Schema({
  filename: String,
  originalName: String,
  fileType: String,
  size: Number,
  uploadedBy: String,
  expiresAt: Date,
  createdAt: { type: Date, default: Date.now }
});

const voiceMessageSchema = new mongoose.Schema({
  username: String,
  duration: Number,
  fileUrl: String,
  ip: String,
  timestamp: { type: Date, default: Date.now },
  month: String
});

const TempFile = mongoose.model('TempFile', tempFileSchema);
const VoiceMessage = mongoose.model('VoiceMessage', voiceMessageSchema);

// MongoDB Connection
mongoose.connect(process.env.MONGODB_URI || 'mongodb+srv://')
  .then(() => console.log('✓ MongoDB Connected'))
  .catch(err => console.log('⚠ MongoDB Connection Error (non-critical):', err.message));

module.exports = { db, Message, User, Notification, TempFile, VoiceMessage };
