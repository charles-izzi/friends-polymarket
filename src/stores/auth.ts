import { defineStore } from 'pinia'
import { shallowRef, ref, computed, markRaw } from 'vue'
import {
  onAuthStateChanged,
  signInWithPopup,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  GoogleAuthProvider,
  type User,
} from 'firebase/auth'
import { auth } from '@/firebase'

export const useAuthStore = defineStore('auth', () => {
  const user = shallowRef<User | null>(null)
  const loading = ref(true)
  const error = ref('')

  const isAuthenticated = computed(() => !!user.value)

  let initPromise: Promise<void> | null = null

  function init() {
    if (!initPromise) {
      initPromise = new Promise<void>((resolve) => {
        onAuthStateChanged(auth, (firebaseUser) => {
          user.value = firebaseUser ? markRaw(firebaseUser) : null
          loading.value = false
          resolve()
        })
      })
    }
    return initPromise
  }

  function ready() {
    return initPromise ?? init()
  }

  async function loginWithGoogle() {
    error.value = ''
    try {
      await signInWithPopup(auth, new GoogleAuthProvider())
    } catch (e: unknown) {
      error.value = e instanceof Error ? e.message : 'Google sign-in failed'
    }
  }

  async function loginWithEmail(email: string, password: string) {
    error.value = ''
    try {
      await signInWithEmailAndPassword(auth, email, password)
    } catch (e: unknown) {
      error.value = e instanceof Error ? e.message : 'Login failed'
    }
  }

  async function registerWithEmail(email: string, password: string) {
    error.value = ''
    try {
      await createUserWithEmailAndPassword(auth, email, password)
    } catch (e: unknown) {
      error.value = e instanceof Error ? e.message : 'Registration failed'
    }
  }

  async function logout() {
    await signOut(auth)
  }

  return {
    user,
    loading,
    isAuthenticated,
    error,
    init,
    ready,
    loginWithGoogle,
    loginWithEmail,
    registerWithEmail,
    logout,
  }
})
