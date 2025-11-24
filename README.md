# 📱 Tin Nhắn Thời Gian Thực

Ứng dụng web chia sẻ tin nhắn/status theo thời gian thực với lưu trữ kép (SQLite + MongoDB) và thông báo Telegram.

## 🎯 Tính năng

✅ **Hiển thị tin nhắn theo thời gian thực** - Socket.io  
✅ **Lưu trữ kép** - SQLite + MongoDB 
✅ **Nhóm theo tháng** - Sidebar hiển thị danh sách tháng  
✅ **Lưu IP + Tên** - Theo dõi người dùng tự động  
✅ **Telegram Bot** - Thông báo khi có hoạt động  
✅ **Responsive Design** - Mobile friendly  
✅ **Giao diện hiện đại** - Dark theme với gradient  

## 📦 Yêu cầu

- **Node.js** v14+
- **MongoDB** (tùy chọn, nhưng khuyến khích)
- **Telegram Bot Token**

## 🚀 Cài đặt & Chạy

### 1. Cài đặt dependencies
```bash
npm install
```

### 2. Cấu hình .env
```env
TELEGRAM_TOKEN=YOUR_TELEGRAM_BOT_TOKEN_HERE
TELEGRAM_CHAT_ID=YOUR_CHAT_ID_HERE
MONGODB_URI=mongodb://localhost:27017/
PORT=5555
```

### 3. Chạy server
```bash
npm start
# Hoặc dev mode
npm run dev
```

### 4. Truy cập
```
http://localhost:5555
```

## 🔧 Lấy Telegram Chat ID

1. Cho bot quyền Admin trong group hoặc tạo private chat
2. Gửi `/start` cho bot
3. Truy cập: `https://api.telegram.org/bot<TOKEN>/getUpdates`
4. Tìm `"id"` trong phần `"chat"`
5. Cập nhật `TELEGRAM_CHAT_ID` trong `.env`

## 📁 Cấu trúc Thư Mục

```
.
├── server.js           # Server chính (Express + Socket.io)
├── db.js              # SQLite + MongoDB configuration
├── telegram.js        # Telegram Bot
├── public/
│   ├── index.html     # Frontend
│   ├── style.css      # Styling
│   └── script.js      # Client-side logic
├── package.json
└── .env              # Environment variables
```

## 🔐 Lưu trữ Dữ liệu

### SQLite (Local)
- File: `messages.db`
- Tables: `messages`, `users`
- Persistent, không cần server bên ngoài

### MongoDB (Cloud)
- Backup tự động của tất cả dữ liệu
- Có thể query từ web app khác
- Nếu SQL lỗi, dữ liệu vẫn an toàn

## 🎨 Tính năng Giao Diện

- **Dark Theme** với gradient màu tím-xanh
- **Sidebar** hiển thị tháng, click để chọn tháng
- **Real-time Animation** khi nhận tin nhắn
- **User Info** hiển thị tên hiện tại
- **Responsive** - Tự động trên mobile
- **Keyboard Shortcut** - Shift+Enter để xuống dòng, Enter để gửi

## 📞 Telegram Notifications

Bot sẽ gửi thông báo khi:
- ✅ Người dùng mới tham gia
- ✅ Có tin nhắn mới

Format thông báo:
```
📨 Tin nhắn mới!
👤 Người dùng: [username]
🌐 IP: [ip_address]
⏰ Lúc: [timestamp]
```

## 🐛 Troubleshooting

### MongoDB không kết nối
- Vẫn hoạt động, chủ yếu lưu ở SQL
- Kiểm tra connection string trong `.env`

### Telegram không gửi notification
- Kiểm tra `TELEGRAM_TOKEN` và `TELEGRAM_CHAT_ID`
- Đảm bảo bot có quyền gửi message

### Lỗi Port 5555 đã dùng
```bash
# Windows
netstat -ano | findstr :5555
taskkill /PID [PID] /F

# Linux/Mac
lsof -i :5555
kill -9 [PID]
```

## 📊 API Endpoints

### GET /api/messages
Lấy tất cả tin nhắn hoặc theo tháng
```bash
# Tất cả
curl http://localhost:5555/api/messages

# Theo tháng
curl "http://localhost:5555/api/messages?month=Tháng 11, 2025"
```

### GET /api/months
Lấy danh sách tháng có tin nhắn
```bash
curl http://localhost:5555/api/months
```

### POST /api/user
Đăng ký người dùng
```bash
curl -X POST http://localhost:5555/api/user \
  -H "Content-Type: application/json" \
  -d '{"username": "Tên của bạn"}'
```

## 🚀 Deploy

### Vercel/Netlify (Frontend)
- Copy folder `public` lên static hosting

### Heroku/Railway (Backend)
```bash
# Deploy with MongoDB Atlas
heroku create
git push heroku main
```

### Docker (Đơn giản)
```dockerfile
FROM node:18
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
EXPOSE 5555
CMD ["npm", "start"]
```

## 📝 License

MIT - Tự do sử dụng, sửa đổi, phát hành

## 💬 Support

Có vấn đề hoặc cải tiến? Tạo issue hoặc liên hệ!

---
**Made with Tyhnhzi❤️ for real-time communication**
