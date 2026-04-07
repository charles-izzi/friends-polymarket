import { defineStore } from 'pinia'
import { ref, computed, watch } from 'vue'
import { setupForegroundMessaging } from '@/firebase'
import type { AppNotification, NotificationType } from '@/types'

export const useNotificationsStore = defineStore('notifications', () => {
  const notifications = ref<AppNotification[]>([])
  let dismissTimer: ReturnType<typeof setTimeout> | null = null

  const current = computed(() => notifications.value[0] ?? null)

  function push(notification: Omit<AppNotification, 'id' | 'createdAt'>) {
    notifications.value.push({
      ...notification,
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      createdAt: Date.now(),
    })
  }

  function dismiss(id?: string) {
    if (id) {
      notifications.value = notifications.value.filter((n) => n.id !== id)
    } else if (notifications.value.length > 0) {
      notifications.value.shift()
    }
    resetTimer()
  }

  function resetTimer() {
    if (dismissTimer) {
      clearTimeout(dismissTimer)
      dismissTimer = null
    }
  }

  // Auto-dismiss current notification after 7s
  watch(current, (n) => {
    resetTimer()
    if (n) {
      dismissTimer = setTimeout(() => dismiss(), 7000)
    }
  })

  // Icon and color helpers for the toast UI
  function getIcon(type: NotificationType): string {
    switch (type) {
      case 'bet_created':
        return 'mdi-plus-circle'
      case 'bet_resolved':
        return 'mdi-gavel'
      case 'bet_cancelled':
        return 'mdi-cancel'
      case 'resolution_needed':
        return 'mdi-alert-circle'
    }
  }

  function getColor(type: NotificationType): string {
    switch (type) {
      case 'bet_created':
        return 'primary'
      case 'bet_resolved':
        return 'success'
      case 'bet_cancelled':
        return 'warning'
      case 'resolution_needed':
        return 'warning'
    }
  }

  // Set up foreground FCM listener — converts incoming push payloads to in-app toasts
  // (suppresses system notification when app is in foreground)
  async function initForegroundListener() {
    await setupForegroundMessaging((payload) => {
      const data = payload.data ?? {}
      if (!data.betId || !data.type) return
      push({
        type: data.type as NotificationType,
        betId: data.betId,
        title: data.title ?? payload.notification?.title ?? '',
        body: data.body ?? payload.notification?.body ?? '',
      })
    })
  }

  // Listen for notification click messages from service worker
  if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (event) => {
      if (event.data?.type === 'NOTIFICATION_CLICK' && event.data.url) {
        // The router will handle this via the App.vue component
        window.dispatchEvent(
          new CustomEvent('notification-navigate', { detail: { url: event.data.url } }),
        )
      }
    })
  }

  return {
    notifications,
    current,
    push,
    dismiss,
    getIcon,
    getColor,
    initForegroundListener,
  }
})
