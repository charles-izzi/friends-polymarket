import { initializeApp } from 'firebase/app'
import { getAuth } from 'firebase/auth'
import { getFirestore } from 'firebase/firestore'

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
export const useDevDb = stored !== null ? stored === 'true' : import.meta.env.DEV && envDb !== '(default)'

export const dbName = useDevDb ? 'staging' : '(default)'

const app = initializeApp(firebaseConfig)
export const auth = getAuth(app)
export const db = useDevDb ? getFirestore(app, 'staging') : getFirestore(app)
