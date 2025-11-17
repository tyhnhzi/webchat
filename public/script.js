let socket = null;
let currentUser = null;
let currentUserIp = null;
let isAdmin = false;
let currentFilter = 'all';
const API_BASE = window.location.origin;

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  // Load theme
  const savedTheme = localStorage.getItem('theme') || 'dark';
  setTheme(savedTheme);

  const savedUser = localStorage.getItem('username');
  if (savedUser) {
    initApp(savedUser);
  }

  // Enter key to send message
  document.getElementById('messageInput')?.addEventListener('keypress', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  // Prevent body scroll when modal open
  document.addEventListener('touchmove', (e) => {
    if (document.getElementById('setupModal').style.display !== 'none') {
      e.preventDefault();
    }
  }, { passive: false });
});

// Setup User
function setupUser() {
  const username = document.getElementById('usernameInput').value.trim();
  if (!username) {
    showNotification('Vui lòng nhập tên!', 'error');
    return;
  }

  fetch(`${API_BASE}/api/user`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username })
  })
  .then(() => {
    localStorage.setItem('username', username);
    initApp(username);
  })
  .catch(err => {
    console.error('Setup Error:', err);
    showNotification('Lỗi đăng ký!', 'error');
  });
}

// Initialize App
function initApp(username) {
  currentUser = username;
  document.getElementById('setupModal').style.display = 'none';
  document.getElementById('mainContent').style.display = 'flex';
  document.getElementById('usernameDisplay').textContent = `👤 ${username}`;

  connectSocket();
  checkAdmin();
  loadNotifications();
  
  // Load messages will be called after socket connects
}

// Check Admin Status
function checkAdmin() {
  fetch(`${API_BASE}/api/check-admin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: currentUser, ip: currentUserIp || '127.0.0.1' })
  })
  .then(res => res.json())
  .then(data => {
    isAdmin = !!data.isAdmin;
    if (isAdmin) {
      document.getElementById('adminBadge').style.display = 'inline';
    }
  })
  .catch(err => console.log('Admin check error:', err));
}

// Socket.io Connection
function connectSocket() {
  socket = io({
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    reconnectionAttempts: 5
  });

  socket.on('connect', () => {
    console.log('✓ Connected to server');
    socket.emit('join', { username: currentUser });
    showNotification('Đã kết nối server', 'success');
    
    // Load messages sau khi connect
    loadMessages();
    loadMonths();
  });

  socket.on('new-message', (data) => {
    // Only display if not filtering or matches current filter
    const messageMonth = data.month;
    if (currentFilter === 'all' || currentFilter === messageMonth) {
      displayMessage(data);
    }
    loadMonths(); // Update month list
  });

  socket.on('message-deleted', (data) => {
    const msgEl = document.querySelector(`[data-msg-id="${data.messageId}"]`);
    if (msgEl) {
      msgEl.style.opacity = '0.5';
      msgEl.innerHTML = '<div class="message-deleted">💨 Tin nhắn đã bị xoá</div>';
    }
  });

  socket.on('user-joined', (data) => {
    showNotification(`${data.username} đã tham gia! 👋`, 'info');
  });

  socket.on('users-online', (users) => {
    document.getElementById('onlineCount').textContent = `🟢 ${users.length} online`;
  });

  socket.on('new-notification', (notif) => {
    showNotification(notif.message, notif.type);
  });

  socket.on('incoming-call', (data) => {
    handleIncomingCall(data);
  });

  socket.on('disconnect', () => {
    console.log('✗ Disconnected from server');
    showNotification('Mất kết nối server!', 'error');
  });
}

// Send Message
function sendMessage() {
  const input = document.getElementById('messageInput');
  const content = input.value.trim();

  if (!content) {
    showNotification('Vui lòng nhập tin nhắn!', 'error');
    return;
  }

  if (!currentUser) {
    showNotification('Vui lòng nhập tên trước!', 'error');
    return;
  }

  if (!socket || !socket.connected) {
    showNotification('Chưa kết nối server!', 'error');
    return;
  }

  socket.emit('message', {
    username: currentUser,
    content: content
  });

  input.value = '';
  input.focus();
}

// Upload Image (Temporary - 7 days)
function uploadImage() {
  const input = document.getElementById('imageInput');
  const file = input.files[0];
  
  if (!file) return;

  // Check file size (50MB limit for temp)
  if (file.size > 50 * 1024 * 1024) {
    showNotification('❌ Ảnh quá lớn! (Max 50MB)', 'error');
    return;
  }

  const formData = new FormData();
  formData.append('file', file);
  formData.append('username', currentUser);

  showNotification('📤 Đang tải ảnh...', 'info');

  fetch(`${API_BASE}/api/upload/temp`, {
    method: 'POST',
    body: formData
  })
  .then(res => res.json())
  .then(data => {
    socket.emit('image-message', {
      username: currentUser,
      imageUrl: data.url
    });
    input.value = '';
    showNotification(`✅ Ảnh đã được gửi! (Lưu ${data.expiryDays} ngày)`, 'success');
  })
  .catch(err => {
    console.error('Upload Error:', err);
    showNotification('❌ Lỗi tải ảnh!', 'error');
  });
}

// Display Message
function displayMessage(msg) {
  const container = document.getElementById('messagesContainer');

  if (container.querySelector('.empty-state')) {
    container.innerHTML = '';
  }

  const msgEl = document.createElement('div');
  msgEl.className = `message ${msg.username === currentUser ? 'own' : ''}`;
  msgEl.setAttribute('data-msg-id', msg.id);

  // Check if deleted
  if (msg.isDeleted) {
    msgEl.style.opacity = '0.5';
    msgEl.innerHTML = `
      <div class="message-header">
        <span class="message-username">${escapeHtml(msg.username)}</span>
        <span class="message-time">${new Date(msg.timestamp).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })}</span>
      </div>
      <div class="message-deleted">💨 Tin nhắn đã bị xoá</div>
    `;
    container.appendChild(msgEl);
    return;
  }

  const time = new Date(msg.timestamp).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
  const date = new Date(msg.timestamp).toLocaleDateString('vi-VN');

  let content = '';
  if (msg.type === 'image') {
    // Image with proper path handling
    const imgPath = msg.content.startsWith('http') ? msg.content : msg.content;
    content = `<img src="${imgPath}" class="message-image" alt="Image" loading="lazy">`;
  } else {
    content = `<div class="message-content">${escapeHtml(msg.content)}</div>`;
  }

  const isOwnMsg = msg.username === currentUser;
  const canDelete = isAdmin;
  const canRevoke = isOwnMsg;

  let actionBtn = '';
  if (canDelete || canRevoke) {
    if (canDelete) {
      actionBtn = `<button class="msg-action" onclick="deleteMessage(${msg.id})" title="Xoá">🗑️</button>`;
    }
    if (canRevoke) {
      actionBtn += `<button class="msg-action" onclick="revokeMessage(${msg.id})" title="Thu hồi">↩️</button>`;
    }
  }

  msgEl.innerHTML = `
    <div class="message-header">
      <span class="message-username">${escapeHtml(msg.username)}</span>
      <span class="message-time">${time}</span>
      <div class="msg-actions">${actionBtn}</div>
    </div>
    ${content}
    <small class="message-date">${date}</small>
  `;

  container.appendChild(msgEl);
  container.scrollTop = container.scrollHeight;
}

// Delete Message (Admin)
function deleteMessage(messageId) {
  if (!confirm('Xoá tin nhắn này?')) return;

  socket.emit('delete-message', {
    messageId: messageId,
    username: currentUser
  });

  showNotification('Tin nhắn đã được xoá', 'success');
}

// Revoke Message (User)
function revokeMessage(messageId) {
  if (!confirm('Thu hồi tin nhắn này?')) return;

  socket.emit('revoke-message', {
    messageId: messageId,
    username: currentUser
  });

  showNotification('Tin nhắn đã được thu hồi', 'success');
}

// Load Messages
function loadMessages(month = 'all') {
  const url = month === 'all' 
    ? `${API_BASE}/api/messages`
    : `${API_BASE}/api/messages?month=${encodeURIComponent(month)}`;

  fetch(url)
    .then(res => res.json())
    .then(messages => {
      const container = document.getElementById('messagesContainer');
      container.innerHTML = '';

      if (messages.length === 0) {
        container.innerHTML = '<div class="empty-state">Không có tin nhắn 📭</div>';
        return;
      }

      messages.reverse().forEach(msg => {
        displayMessage(msg);
      });
    })
    .catch(err => console.error('Load Error:', err));
}

// Load Months
function loadMonths() {
  fetch(`${API_BASE}/api/months`)
    .then(res => res.json())
    .then(months => {
      const monthList = document.getElementById('monthList');
      monthList.innerHTML = '';

      const allItem = document.createElement('div');
      allItem.className = `month-item ${currentFilter === 'all' ? 'active' : ''}`;
      allItem.textContent = '🔥 Tất cả';
      allItem.onclick = function() { filterMessages('all', this); };
      monthList.appendChild(allItem);

      months.forEach(month => {
        const item = document.createElement('div');
        item.className = `month-item ${currentFilter === month ? 'active' : ''}`;
        item.textContent = `📅 ${month}`;
        item.onclick = function() { filterMessages(month, this); };
        monthList.appendChild(item);
      });
    })
    .catch(err => console.error('Load Months Error:', err));
}

// Filter Messages by Month
function filterMessages(month, element = null) {
  currentFilter = month;
  
  document.querySelectorAll('.month-item').forEach(item => {
    item.classList.remove('active');
  });
  if (element) element.classList.add('active');

  loadMessages(month);
}

// Load Notifications
function loadNotifications() {
  fetch(`${API_BASE}/api/notifications/${currentUser}`)
    .then(res => res.json())
    .then(notifications => {
      notifications.forEach(notif => {
        if (!notif.read) {
          showNotification(notif.message, notif.type);
        }
      });
    })
    .catch(err => console.log('Notifications Error:', err));
}

// Show Notification Toast
function showNotification(message, type = 'info') {
  const container = document.getElementById('notificationContainer');
  const notif = document.createElement('div');
  notif.className = `notification notification-${type}`;
  notif.textContent = message;
  container.appendChild(notif);

  setTimeout(() => {
    notif.classList.add('show');
  }, 10);

  setTimeout(() => {
    notif.classList.remove('show');
    setTimeout(() => notif.remove(), 300);
  }, 3000);
}

// Theme Management
function setTheme(themeName) {
  document.documentElement.setAttribute('data-theme', themeName);
  localStorage.setItem('theme', themeName);

  // Update active button
  document.querySelectorAll('.theme-btn').forEach(btn => {
    btn.classList.remove('active');
  });
  document.querySelector(`.theme-${themeName}`)?.classList.add('active');
}

// Logout
function logout() {
  localStorage.removeItem('username');
  if (socket) socket.disconnect();
  location.reload();
}

// Utility Functions
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}



// Auto-reconnect
setInterval(() => {
  if (!socket || !socket.connected) {
    console.log('⚠ Attempting to reconnect...');
    if (currentUser) {
      setTimeout(() => connectSocket(), 2000);
    }
  }
}, 10000);
