// FlexPulse Background Service Worker for Offline Calls & Chat Messages
self.addEventListener('install', function(event) {
  self.skipWaiting();
});

self.addEventListener('activate', function(event) {
  event.waitUntil(self.clients.claim());
});

// 1. Listen for background push notifications
self.addEventListener('push', function(event) {
  let data = {};
  if (event.data) {
    try {
      data = event.data.json();
    } catch (_) {
      data = { body: event.data.text() };
    }
  }

  const isMessage = data.type === 'message';
  const title = data.title || (isMessage ? '💬 New Message' : '📞 Incoming Voice Call');
  
  const options = {
    body: data.body || (isMessage ? 'You received a new message on FlexPulse.' : 'User is calling you on FlexPulse Cloud. Click to answer.'),
    icon: '/favicon.ico',
    badge: '/favicon.ico',
    tag: data.tag || (isMessage ? `msg-${Date.now()}` : 'voice-call-alert'),
    renotify: true,
    requireInteraction: !isMessage, // Calls stay until interacted with; messages follow standard notification behavior
    vibrate: isMessage ? [200, 100, 200] : [300, 100, 300, 100, 300, 200, 500],
    data: {
      url: data.url || '/messages',
      sessionId: data.sessionId,
      chatCode: data.chatCode,
      senderEmail: data.senderEmail,
      type: data.type || 'call'
    },
    actions: isMessage
      ? [{ action: 'open_chat', title: '💬 Open Chat' }]
      : [
          { action: 'answer', title: '📞 Answer Call' },
          { action: 'decline', title: '✕ Decline' }
        ]
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

// 2. Handle notification click (Answer, Open Chat, or Focus)
self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  const notifData = event.notification.data || {};
  const targetUrl = notifData.url || '/messages';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(clientList) {
      // If a window is already open, focus it and post action message
      for (let i = 0; i < clientList.length; i++) {
        const client = clientList[i];
        if ('focus' in client) {
          if (notifData.sessionId) {
            client.postMessage({
              type: 'INCOMING_CALL_ACTION',
              action: event.action || 'answer',
              sessionId: notifData.sessionId
            });
          }
          if (notifData.type === 'message' && notifData.chatCode) {
            client.postMessage({
              type: 'OPEN_CHAT',
              chatCode: notifData.chatCode
            });
          }
          return client.focus();
        }
      }
      // If no window is open, open a new window pointing to targetUrl
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
    })
  );
});
