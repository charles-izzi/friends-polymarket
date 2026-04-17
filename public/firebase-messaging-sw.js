// ── Push handler ────────────────────────────────────────────────────
// Registered BEFORE Firebase SDK imports so it works even if the CDN
// scripts fail to load (common on mobile when the SW wakes with no
// network). Calls showNotification directly for full reliability.
self.addEventListener('push', (event) => {
  if (!event.data) return

  let title = 'New notification'
  let body = ''
  let pushData = {}

  try {
    const raw = event.data.json()

    // FCM payload format: { notification: {...}, data: {...} }
    if (raw.notification) {
      title = raw.notification.title || title
      body = raw.notification.body || body
      pushData = raw.data || {}
      // Wrapped format: { data: { FCM_MSG: ... } }
    } else if (raw.data?.FCM_MSG) {
      let msg = raw.data.FCM_MSG
      if (typeof msg === 'string') msg = JSON.parse(msg)
      title = msg.notification?.title || title
      body = msg.notification?.body || body
      pushData = msg.data || {}
      // Data-only: { data: { title, body, ... } }
    } else {
      pushData = raw.data || raw
      title = pushData.title || title
      body = pushData.body || body
    }
  } catch {
    // unparseable push – show generic notification
  }

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      // App is in the foreground — skip; in-app toast handles it
      if (windowClients.some((c) => c.visibilityState === 'visible')) return

      return self.registration.showNotification(title, {
        body,
        icon: '/logo-192.png',
        data: { betId: pushData.betId, marketId: pushData.marketId, type: pushData.type },
      })
    }),
  )

  // Prevent Firebase SDK's handler from also processing (avoids duplicates)
  event.stopImmediatePropagation()
})

// ── Firebase SDK (non-critical) ─────────────────────────────────────
// Kept for internal token management. Push display is handled above.
try {
  importScripts('https://www.gstatic.com/firebasejs/12.10.0/firebase-app-compat.js')
  importScripts('https://www.gstatic.com/firebasejs/12.10.0/firebase-messaging-compat.js')

  firebase.initializeApp({
    apiKey: 'AIzaSyB4d48uGba1sqDOkTyd0P7GYc9SEi-giNk',
    projectId: 'internal-polymarket',
    messagingSenderId: '677024348338',
    appId: '1:677024348338:web:761fa4824418256013f1ab',
  })

  firebase.messaging()
} catch (e) {
  // Firebase SDK load failure is non-critical — push handling works without it
}

// ── Notification click ──────────────────────────────────────────────
self.addEventListener('notificationclick', (event) => {
  event.notification.close()

  const betId = event.notification.data?.betId
  const marketId = event.notification.data?.marketId
  const url = betId && marketId ? `/${marketId}/bets/${betId}` : '/'

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
