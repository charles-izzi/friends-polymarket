import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
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
  const user = ref<User | null>(null)
  const loading = ref(true)
  const error = ref('')

  const isAuthenticated = computed(() => !!user.value)

  function init() {
    return new Promise<void>((resolve) => {
      onAuthStateChanged(auth, (firebaseUser) => {
        user.value = firebaseUser
        loading.value = false
        resolve()
      })
    })
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
    loginWithGoogle,
    loginWithEmail,
    registerWithEmail,
    logout,
  }
})
