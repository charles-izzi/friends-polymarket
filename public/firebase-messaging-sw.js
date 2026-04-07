importScripts('https://www.gstatic.com/firebasejs/12.10.0/firebase-app-compat.js')
importScripts('https://www.gstatic.com/firebasejs/12.10.0/firebase-messaging-compat.js')

// Firebase config is injected automatically via firebase init in the hosting environment.
// For local dev, the service worker only needs messagingSenderId to receive push.
// The actual config values are populated at build time via the hosting __/firebase/init.js,
// but for the SW we initialize with minimal config below.
// These will be overridden by the actual push subscription which uses the VAPID key.
firebase.initializeApp({
  apiKey: 'placeholder',
  projectId: 'placeholder',
  messagingSenderId: 'placeholder',
  appId: 'placeholder',
})

const messaging = firebase.messaging()

// Handle background messages (app not in focus)
messaging.onBackgroundMessage((payload) => {
  const data = payload.data || {}
  const title = payload.notification?.title || data.title || 'New notification'
  const body = payload.notification?.body || data.body || ''

  self.registration.showNotification(title, {
    body,
    icon: '/logo-192.png',
    data: { betId: data.betId, type: data.type },
  })
})

// Handle notification click — open or focus the app at the bet detail page
self.addEventListener('notificationclick', (event) => {
  event.notification.close()

  const betId = event.notification.data?.betId
  const url = betId ? `/bets/${betId}` : '/'

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      // If an existing window is open, focus it and navigate
      for (const client of clientList) {
        if ('focus' in client) {
          client.focus()
          client.postMessage({ type: 'NOTIFICATION_CLICK', url })
          return
        }
      }
      // Otherwise open a new window
      return self.clients.openWindow(url)
    }),
  )
})
