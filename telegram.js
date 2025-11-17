const TelegramBot = require('node-telegram-bot-api');
const dotenv = require('dotenv');

dotenv.config();

const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: false });

const sendNotification = async (message) => {
  try {
    if (process.env.TELEGRAM_CHAT_ID) {
      await bot.sendMessage(process.env.TELEGRAM_CHAT_ID, message, { parse_mode: 'HTML' });
    }
  } catch (err) {
    console.log('Telegram Notification Error:', err.message);
  }
};

const notifyNewMessage = (username, ip) => {
  const msg = `
📨 <b>Tin nhắn mới!</b>
👤 Người dùng: <code>${username}</code>
🌐 IP: <code>${ip}</code>
⏰ Lúc: ${new Date().toLocaleString('vi-VN')}
  `;
  sendNotification(msg);
};

const notifyNewUser = (username, ip) => {
  const msg = `
👋 <b>Người dùng mới!</b>
👤 Tên: <code>${username}</code>
🌐 IP: <code>${ip}</code>
⏰ Lúc: ${new Date().toLocaleString('vi-VN')}
  `;
  sendNotification(msg);
};

const notifyActivity = (type, data) => {
  if (type === 'message') notifyNewMessage(data.username, data.ip);
  if (type === 'user') notifyNewUser(data.username, data.ip);
};

module.exports = { bot, sendNotification, notifyActivity, notifyNewMessage, notifyNewUser };
