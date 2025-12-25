let socket = null;
let currentUser = null;
let currentUserIp = null;
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

  loadBackground();
  connectSocket();
  loadNotifications();
  
  // Request push notification permission
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }
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
    showNotification(`${data.username} đã tham gia! `, 'info');
  });

  socket.on('users-online', (users) => {
    document.getElementById('onlineCount').textContent = `🟢 ${users.length} online`;
  });

  socket.on('new-notification', (notif) => {
    sendPushNotification(notif.message, notif.type);
  });

  socket.on('notification-received', (notif) => {
    sendPushNotification(notif.message, notif.type);
  });

  socket.on('message-notification', (data) => {
    // Gửi push notification khi offline, hiển thị thông báo khi online
    if (data.from !== currentUser) {
      sendPushNotification(data.message, 'message');
    }
  });

  socket.on('background-updated', (data) => {
    // Sync background khi có người thay đổi
    if (data.imageData) {
      applyBackground(data.imageData);
      showNotification('🖼️ Background đã được cập nhật', 'info');
    }
  });

  socket.on('background-removed', () => {
    // Xoá background và trở về theme mặc định
    const chatArea = document.querySelector('.chat-area');
    if (chatArea) {
      chatArea.style.backgroundImage = '';
      chatArea.style.backgroundColor = ''; // Reset về màu theme
    }
    localStorage.removeItem('bgImage');
    showNotification('🗑️ Background đã bị xoá, trở về theme mặc định', 'info');
  });

  socket.on('disconnect', () => {
    console.log('✗ Disconnected from server');
    showNotification('Mất kết nối server!', 'error');
  });

  // Profile updates (moved from global scope to avoid null socket)
  socket.on('profile-updated', (data) => {
    if (data.username === currentUser) {
      showNotification('✅ Trang cá nhân đã được cập nhật', 'info');
    }
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

// Upload Video (Temporary - 7 days, max 200MB)
function uploadVideo() {
  const input = document.getElementById('videoInput');
  const file = input.files[0];
  
  if (!file) return;

  // Check file size (200MB limit for video)
  if (file.size > 200 * 1024 * 1024) {
    showNotification('❌ Video quá lớn! (Max 200MB)', 'error');
    return;
  }

  const formData = new FormData();
  formData.append('file', file);
  formData.append('username', currentUser);

  showNotification('🎥 Đang tải video...', 'info');

  fetch(`${API_BASE}/api/upload/video`, {
    method: 'POST',
    body: formData
  })
  .then(res => res.json())
  .then(data => {
    socket.emit('video-message', {
      username: currentUser,
      videoUrl: data.url,
      fileSize: data.size
    });
    input.value = '';
    showNotification(`✅ Video đã được gửi! (Lưu ${data.expiryDays} ngày)`, 'success');
  })
  .catch(err => {
    console.error('Upload Error:', err);
    showNotification('❌ Lỗi tải video!', 'error');
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
        <span class="message-username clickable" onclick="openProfile('${escapeHtml(msg.username)}')">${escapeHtml(msg.username)}</span>
        <span class="message-time">${new Date(msg.timestamp).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })}</span>
      </div>
      <div class="message-deleted">💨 Tin nhắn đã bị xoá</div>
    `;
    container.appendChild(msgEl);
    return;
  }

  const time = new Date(msg.timestamp).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Ho_Chi_Minh' });
  const date = new Date(msg.timestamp).toLocaleDateString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });

  let content = '';
  if (msg.type === 'image') {
    const imgPath = msg.content.startsWith('http') ? msg.content : msg.content;
    content = `<img src="${imgPath}" class="message-image" alt="Image" loading="lazy">`;
  } else if (msg.type === 'video') {
    const videoPath = msg.content.startsWith('http') ? msg.content : msg.content;
    content = `<video class="message-video" controls style="max-width: 100%; max-height: 300px; border-radius: 8px;"><source src="${videoPath}" type="video/mp4"></video>`;
  } else if (msg.type === 'voice') {
    const voicePath = msg.content.startsWith('http') ? msg.content : msg.content;
    const duration = msg.duration ? `${Math.floor(msg.duration)}s` : '';
    content = `<div class="voice-message"><audio controls style="width: 100%; max-width: 300px;" src="${voicePath}"></audio><span class="voice-duration">🎤 ${duration}</span></div>`;
  } else {
    // Linkify plain text so URLs are clickable
    content = `<div class="message-content">${linkify(escapeHtml(msg.content))}</div>`;
  }

  const isOwnMsg = msg.username === currentUser;
  const canRevoke = isOwnMsg;

  let actionBtn = '';
  if (canRevoke) {
    actionBtn += `<button class="msg-action" onclick="revokeMessage(${msg.id})" title="Thu hồi">↩️</button>`;
  }

  msgEl.innerHTML = `
    <div class="message-header">
      <span class="message-username clickable" onclick="openProfile('${escapeHtml(msg.username)}')">${escapeHtml(msg.username)}</span>
      <span class="message-time">${time}</span>
      <div class="msg-actions">${actionBtn}</div>
    </div>
    ${content}
    <small class="message-date">${date}</small>
  `;

  container.appendChild(msgEl);
  container.scrollTop = container.scrollHeight;
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
      if (Array.isArray(notifications)) {
        notifications.forEach(notif => {
          if (!notif.isRead) {
            showNotification(notif.message, notif.type || 'info');
            markNotificationAsRead(notif.id);
          }
        });
      }
    })
    .catch(err => console.log('Notifications Error:', err));
}

// Mark notification as read
function markNotificationAsRead(notificationId) {
  fetch(`${API_BASE}/api/notification/${notificationId}/read`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  }).catch(err => console.log('Mark read error:', err));
}

// Send notification to user
function sendNotificationToUser(username, message, type = 'info') {
  fetch(`${API_BASE}/api/notification/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, message, type })
  })
  .then(res => res.json())
  .then(data => {
    if (data.success) {
      showNotification('✅ Thông báo đã gửi!', 'success');
    }
  })
  .catch(err => {
    console.error('Send notification error:', err);
    showNotification('❌ Lỗi gửi thông báo!', 'error');
  });
}

// Show Notification Toast
function showNotification(message, type = 'info') {
  const container = document.getElementById('notificationContainer');
  const notif = document.createElement('div');
  notif.className = `notification notification-${type}`;
  notif.innerHTML = `<span>${message}</span>`;
  container.appendChild(notif);

  setTimeout(() => {
    notif.classList.add('show');
  }, 10);

  const timeout = setTimeout(() => {
    notif.classList.remove('show');
    setTimeout(() => notif.remove(), 300);
  }, 4000);
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

// Convert URLs in text to clickable links
function linkify(text) {
  const urlRegex = /(?:https?:\/\/|www\.)[^\s<]+/gi;
  return text.replace(urlRegex, (url) => {
    let href = url;
    if (!/^https?:\/\//i.test(href)) {
      href = 'http://' + href; // ensure proper protocol
    }
    return `<a href="${href}" target="_blank" rel="noopener noreferrer">${url}</a>`;
  });
}

// Send Web Push Notification
function sendPushNotification(message, type = 'message') {
  if (!('serviceWorker' in navigator) || !('Notification' in window)) {
    return;
  }

  if (Notification.permission === 'granted') {
    navigator.serviceWorker.ready.then(registration => {
      registration.showNotification('💬 Tin nhắn mới', {
        body: message,
        icon: '/favicon.ico',
        badge: '/favicon.ico',
        tag: 'message-notification',
        requireInteraction: false
      });
    });
  } else if (Notification.permission !== 'denied') {
    Notification.requestPermission().then(permission => {
      if (permission === 'granted') {
        sendPushNotification(message, type);
      }
    });
  }
}

// Background Image Upload & Crop
let cropperInstance = null;

function openBackgroundUploader() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (evt) => {
        showImageCropper(evt.target.result);
      };
      reader.readAsDataURL(file);
    }
  });
  input.click();
}

function showImageCropper(imageSrc) {
  // Create modal
  const modal = document.createElement('div');
  modal.id = 'cropperModal';
  modal.className = 'modal show';
  modal.innerHTML = `
    <div class="modal-content" style="max-width: 600px;">
      <div style="text-align: center; margin-bottom: 16px;">
        <h2>🖼️ Tuỳ Chỉnh Background</h2>
      </div>
      <div style="position: relative; width: 100%; max-height: 400px; background: #000;">
        <img id="cropperImage" src="${imageSrc}" style="max-width: 100%; max-height: 400px;">
      </div>
      <div style="display: flex; gap: 8px; margin-top: 16px; justify-content: center;">
        <button onclick="applyCrop()" style="padding: 10px 20px; background: var(--success); color: white; border: none; border-radius: 8px; cursor: pointer;">✅ Áp Dụng</button>
        <button onclick="document.getElementById('cropperModal').remove()" style="padding: 10px 20px; background: var(--danger); color: white; border: none; border-radius: 8px; cursor: pointer;">❌ Huỷ</button>
      </div>
    </div>
  `;
  
  document.body.appendChild(modal);
  
  // Initialize cropper
  const image = document.getElementById('cropperImage');
  cropperInstance = new Cropper(image, {
    aspectRatio: 16 / 9,
    autoCropArea: 1,
    responsive: true,
    restore: true,
    guides: true,
    center: true,
    highlight: true,
    cropBoxMovable: true,
    cropBoxResizable: true,
    toggleDragModeOnDblclick: true
  });
}

function applyCrop() {
  if (!cropperInstance) return;
  
  const canvas = cropperInstance.getCroppedCanvas();
  const bgImage = canvas.toDataURL();
  
  // Upload to server để đồng bộ
  fetch(`${API_BASE}/api/background/upload`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ imageData: bgImage })
  })
  .then(res => res.json())
  .then(data => {
    if (data.success) {
      // Apply background locally
      applyBackground(bgImage);
      showNotification('✅ Background đã đồng bộ cho mọi người!', 'success');
    }
  })
  .catch(err => {
    console.error('Upload background error:', err);
    // Fallback: save locally nếu server lỗi
    localStorage.setItem('bgImage', bgImage);
    applyBackground(bgImage);
    showNotification('⚠️ Background chỉ lưu trên thiết bị này', 'warning');
  });
  
  // Close modal
  document.getElementById('cropperModal').remove();
  cropperInstance.destroy();
  cropperInstance = null;
}

function applyBackground(bgImage) {
  const chatArea = document.querySelector('.chat-area');
  if (chatArea) {
    chatArea.style.backgroundImage = `url('${bgImage}')`;
    chatArea.style.backgroundSize = 'cover';
    chatArea.style.backgroundPosition = 'center';
    chatArea.style.backgroundAttachment = 'fixed';
  }
}

// Load background on page load
function loadBackground() {
  // Tải background từ server (đồng bộ)
  fetch(`${API_BASE}/api/background`)
    .then(res => res.json())
    .then(data => {
      if (data.imageData) {
        applyBackground(data.imageData);
      } else {
        // Fallback: tải từ localStorage
        const localBg = localStorage.getItem('bgImage');
        if (localBg) {
          applyBackground(localBg);
        }
      }
    })
    .catch(err => {
      console.log('Load background error:', err);
      // Fallback: tải từ localStorage
      const localBg = localStorage.getItem('bgImage');
      if (localBg) {
        applyBackground(localBg);
      }
    });
}

// Remove background
function removeBackground() {
  if (!confirm('Xoá background và trở về theme mặc định cho mọi người?')) return;
  
  fetch(`${API_BASE}/api/background/remove`, {
    method: 'DELETE'
  })
  .then(res => res.json())
  .then(data => {
    if (data.success) {
      const chatArea = document.querySelector('.chat-area');
      if (chatArea) {
        chatArea.style.backgroundImage = '';
        chatArea.style.backgroundColor = ''; // Reset về màu theme
      }
      localStorage.removeItem('bgImage');
      showNotification('✅ Background đã xoá, trở về theme mặc định!', 'success');
    }
  })
  .catch(err => {
    console.error('Remove background error:', err);
    showNotification('❌ Lỗi xoá background!', 'error');
  });
}

// ===== PROFILE FUNCTIONS =====

// Open user profile
async function openProfile(username) {
  try {
    const response = await fetch(`${API_BASE}/api/profile/${encodeURIComponent(username)}`);
    const data = await response.json();
    
    if (response.ok) {
      document.getElementById('profileAvatar').textContent = data.avatar || '👤';
      document.getElementById('profileUsername').textContent = data.username;
      document.getElementById('profileBio').textContent = data.bio || 'Chưa có giới thiệu';
      document.getElementById('profileMessageCount').textContent = data.messageCount || 0;
      document.getElementById('profileJoinDate').textContent = new Date(data.joinedAt).toLocaleDateString('vi-VN');
      
      // Status emoji
      const statusEmojis = {
        online: '🟢 Hoạt động',
        away: '🟡 Vắng mặt', 
        busy: '🔴 Bận',
        offline: '⚫ Ẩn'
      };
      document.getElementById('profileStatus').textContent = statusEmojis[data.status] || '🟢 Hoạt động';
      
      // Show edit button only for own profile
      if (username === currentUser) {
        document.getElementById('editSection').style.display = 'block';
      } else {
        document.getElementById('editSection').style.display = 'none';
      }
      
      document.getElementById('profileModal').style.display = 'flex';
    } else {
      showNotification('❌ Không tìm thấy người dùng', 'error');
    }
  } catch (error) {
    console.error('Error loading profile:', error);
    showNotification('❌ Lỗi tải trang cá nhân', 'error');
  }
}

function closeProfileModal() {
  document.getElementById('profileModal').style.display = 'none';
}

// Open edit profile modal
async function openEditProfile() {
  try {
    const response = await fetch(`${API_BASE}/api/profile/${encodeURIComponent(currentUser)}`);
    const data = await response.json();
    
    if (response.ok) {
      document.getElementById('editAvatar').value = data.avatar || '👤';
      document.getElementById('editBio').value = data.bio || '';
      document.getElementById('editStatus').value = data.status || 'online';
      
      document.getElementById('profileModal').style.display = 'none';
      document.getElementById('editProfileModal').style.display = 'flex';
    }
  } catch (error) {
    console.error('Error loading profile for edit:', error);
    showNotification('❌ Lỗi tải thông tin', 'error');
  }
}

function closeEditProfileModal() {
  document.getElementById('editProfileModal').style.display = 'none';
}

// Save profile changes
async function saveProfile() {
  const avatar = document.getElementById('editAvatar').value.trim();
  const bio = document.getElementById('editBio').value.trim();
  const status = document.getElementById('editStatus').value;
  
  try {
    const response = await fetch(`${API_BASE}/api/profile/${encodeURIComponent(currentUser)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ avatar, bio, status })
    });
    
    if (response.ok) {
      closeEditProfileModal();
      showNotification('✅ Đã cập nhật trang cá nhân!', 'success');
    } else {
      showNotification('❌ Lỗi cập nhật', 'error');
    }
  } catch (error) {
    console.error('Error saving profile:', error);
    showNotification('❌ Lỗi lưu thông tin', 'error');
  }
}

// (Profile update listener now bound inside connectSocket)

// Auto-reconnect
setInterval(() => {
  if (!socket || !socket.connected) {
    console.log('⚠ Attempting to reconnect...');
    if (currentUser) {
      setTimeout(() => connectSocket(), 2000);
    }
  }
}, 10000);

// ===== VOICE RECORDING =====

// Use var to avoid TDZ issues when referenced before declaration
var mediaRecorder = null;
let audioChunks = [];
let voiceStartTime = 0;

// Toggle voice recorder modal
function toggleVoiceRecorder() {
  const modal = document.getElementById('voiceRecorderModal');
  if (modal.style.display === 'none') {
    modal.style.display = 'flex';
    // Reset UI state when opening the recorder
    resetVoiceRecorderUI();
  } else {
    closeVoiceRecorder();
  }
}

// Close voice recorder
function closeVoiceRecorder() {
  const modal = document.getElementById('voiceRecorderModal');
  modal.style.display = 'none';
  
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }
  audioChunks = [];
  resetVoiceRecorderUI();
}

// Start voice recording
async function startVoiceRecording() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    // Explicitly set mimeType to ensure consistent encoding
    mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
    audioChunks = [];
    voiceStartTime = Date.now();

    mediaRecorder.ondataavailable = (e) => {
      audioChunks.push(e.data);
    };

    mediaRecorder.onstop = () => {
      const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
      const duration = Math.round((Date.now() - voiceStartTime) / 1000);
      playVoiceRecording(audioBlob, duration);
      
      // Stop all tracks
      stream.getTracks().forEach(track => track.stop());
    };

    mediaRecorder.start();
    document.getElementById('startRecordBtn').style.display = 'none';
    document.getElementById('stopRecordBtn').style.display = 'block';
    startVoiceTimer();

    showNotification('🎤 Ghi âm đang bắt đầu...', 'info');
  } catch (error) {
    console.error('Recording Error:', error);
    showNotification('❌ Lỗi truy cập microphone!', 'error');
  }
}

// Stop voice recording
function stopVoiceRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
    document.getElementById('startRecordBtn').style.display = 'block';
    document.getElementById('stopRecordBtn').style.display = 'none';
    stopVoiceTimer();
  }
}

// Play voice recording
function playVoiceRecording(audioBlob, duration) {
  const audioUrl = URL.createObjectURL(audioBlob);
  const audioElement = document.getElementById('voiceAudio');
  audioElement.src = audioUrl;
  
  document.getElementById('voicePlayback').style.display = 'block';
  
  // Store blob for sending
  window.voiceBlob = audioBlob;
  window.voiceDuration = duration;
}

// Send voice message
async function sendVoiceMessage() {
  if (!window.voiceBlob) {
    showNotification('❌ Không có bản ghi âm!', 'error');
    return;
  }

  const formData = new FormData();
  formData.append('file', window.voiceBlob, 'voice.webm');
  formData.append('username', currentUser);
  formData.append('duration', window.voiceDuration);

  showNotification('🎤 Đang tải tin nhắn thoại...', 'info');

  try {
    const response = await fetch(`${API_BASE}/api/upload/voice`, {
      method: 'POST',
      body: formData
    });

    const data = await response.json();
    
    socket.emit('voice-message', {
      username: currentUser,
      voiceUrl: data.url,
      duration: window.voiceDuration,
      fileSize: data.size
    });

    closeVoiceRecorder();
    showNotification(`✅ Tin nhắn thoại đã gửi! (${window.voiceDuration}s)`, 'success');
  } catch (err) {
    console.error('Upload Error:', err);
    showNotification('❌ Lỗi tải tin nhắn thoại!', 'error');
  }
}

// Re-record voice
function reRecordVoice() {
  resetVoiceRecorderUI();
  audioChunks = [];
  window.voiceBlob = null;
  document.getElementById('voicePlayback').style.display = 'none';
}

// Voice timer
let voiceTimerInterval = null;

function startVoiceTimer() {
  let seconds = 0;
  const maxDuration = 300; // 5 minutes max

  voiceTimerInterval = setInterval(() => {
    seconds++;
    const display = `${Math.floor(seconds / 60)}:${(seconds % 60).toString().padStart(2, '0')}`;
    document.getElementById('recorderTime').textContent = display;

    if (seconds >= maxDuration) {
      stopVoiceRecording();
      showNotification('⏱️ Đã đạt giới hạn thời gian ghi âm (5 phút)', 'warning');
    }
  }, 1000);
}

function stopVoiceTimer() {
  if (voiceTimerInterval) {
    clearInterval(voiceTimerInterval);
    voiceTimerInterval = null;
  }
}

function resetVoiceRecorderUI() {
  document.getElementById('recorderTime').textContent = '00:00';
  document.getElementById('startRecordBtn').style.display = 'block';
  document.getElementById('stopRecordBtn').style.display = 'none';
  document.getElementById('voicePlayback').style.display = 'none';
  stopVoiceTimer();
}
