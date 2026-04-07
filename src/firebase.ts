import { initializeApp } from 'firebase/app'
import { getAuth } from 'firebase/auth'
import { getFirestore } from 'firebase/firestore'
import {
  getMessaging,
  getToken,
  isSupported,
  onMessage,
  type MessagePayload,
} from 'firebase/messaging'
import { getFunctions, httpsCallable } from 'firebase/functions'

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
}

const stored = localStorage.getItem('useDevDb')
const envDb = import.meta.env.VITE_FIRESTORE_DATABASE ?? '(default)'
// Default to dev DB only in dev mode; production builds default to (default) DB
export const useDevDb =
  stored !== null ? stored === 'true' : import.meta.env.DEV && envDb !== '(default)'

export const dbName = useDevDb ? 'staging' : '(default)'

const app = initializeApp(firebaseConfig)
export const auth = getAuth(app)
export const db = useDevDb ? getFirestore(app, 'staging') : getFirestore(app)

// FCM — lazily initialized since messaging isn't supported in all browsers
let messagingInstance: ReturnType<typeof getMessaging> | null = null

async function getMessagingInstance() {
  if (messagingInstance) return messagingInstance
  const supported = await isSupported()
  if (!supported) return null
  messagingInstance = getMessaging(app)
  return messagingInstance
}

export async function requestPushPermission(): Promise<string | null> {
  try {
    const messaging = await getMessagingInstance()
    if (!messaging) return null

    const vapidKey = import.meta.env.VITE_FIREBASE_VAPID_KEY
    if (!vapidKey) return null

    const permission =
      Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission()
    if (permission !== 'granted') return null

    const token = await getToken(messaging, {
      vapidKey,
      serviceWorkerRegistration: await navigator.serviceWorker.register(
        '/firebase-messaging-sw.js',
      ),
    })

    // Store token server-side
    const functions = getFunctions()
    const registerFn = httpsCallable(functions, 'registerFcmToken')
    await registerFn({ token, database: dbName })

    return token
  } catch {
    return null
  }
}

export async function setupForegroundMessaging(
  onNotification: (payload: MessagePayload) => void,
): Promise<(() => void) | null> {
  const messaging = await getMessagingInstance()
  if (!messaging) return null
  return onMessage(messaging, onNotification)
}
