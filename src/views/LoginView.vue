<script setup lang="ts">
import { ref } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { useAuthStore } from '@/stores/auth'

const authStore = useAuthStore()
const router = useRouter()
const route = useRoute()

const email = ref('')
const password = ref('')
const isRegistering = ref(false)

const redirectTo = (route.query.redirect as string) || '/'

async function handleEmailSubmit() {
  if (isRegistering.value) {
    await authStore.registerWithEmail(email.value, password.value)
  } else {
    await authStore.loginWithEmail(email.value, password.value)
  }
  if (authStore.isAuthenticated) {
    router.replace(redirectTo)
  }
}

async function handleGoogleSignIn() {
  await authStore.loginWithGoogle()
  if (authStore.isAuthenticated) {
    router.replace(redirectTo)
  }
}
</script>

<template>
  <div class="login-container">
    <div class="login-card">
      <h1>{{ isRegistering ? 'Create Account' : 'Sign In' }}</h1>

      <button class="google-btn" @click="handleGoogleSignIn">
        <svg viewBox="0 0 24 24" width="18" height="18" xmlns="http://www.w3.org/2000/svg">
          <path
            d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"
            fill="#4285F4"
          />
          <path
            d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
            fill="#34A853"
          />
          <path
            d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
            fill="#FBBC05"
          />
          <path
            d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
            fill="#EA4335"
          />
        </svg>
        Continue with Google
      </button>

      <div class="divider"><span>or</span></div>

      <form @submit.prevent="handleEmailSubmit">
        <input v-model="email" type="email" placeholder="Email" required autocomplete="email" />
        <input
          v-model="password"
          type="password"
          placeholder="Password"
          required
          minlength="6"
          autocomplete="current-password"
        />
        <button type="submit" class="submit-btn">
          {{ isRegistering ? 'Create Account' : 'Sign In' }}
        </button>
      </form>

      <p v-if="authStore.error" class="error">{{ authStore.error }}</p>

      <p class="toggle">
        {{ isRegistering ? 'Already have an account?' : "Don't have an account?" }}
        <a href="#" @click.prevent="isRegistering = !isRegistering">
          {{ isRegistering ? 'Sign In' : 'Create Account' }}
        </a>
      </p>
    </div>
  </div>
</template>

<style scoped>
.login-container {
  display: flex;
  justify-content: center;
  align-items: center;
  min-height: 100vh;
  padding: 1rem;
}

.login-card {
  width: 100%;
  max-width: 400px;
  padding: 2rem;
  border: 1px solid #e0e0e0;
  border-radius: 8px;
  background: #fff;
}

h1 {
  margin: 0 0 1.5rem;
  text-align: center;
  font-size: 1.5rem;
}

.google-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  width: 100%;
  padding: 0.75rem;
  border: 1px solid #dadce0;
  border-radius: 4px;
  background: #fff;
  font-size: 0.95rem;
  cursor: pointer;
}

.google-btn:hover {
  background: #f7f8f8;
}

.divider {
  display: flex;
  align-items: center;
  margin: 1.25rem 0;
  color: #999;
  font-size: 0.85rem;
}

.divider::before,
.divider::after {
  content: '';
  flex: 1;
  border-bottom: 1px solid #e0e0e0;
}

.divider span {
  margin: 0 0.75rem;
}

form {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

input {
  padding: 0.75rem;
  border: 1px solid #dadce0;
  border-radius: 4px;
  font-size: 0.95rem;
}

.submit-btn {
  padding: 0.75rem;
  border: none;
  border-radius: 4px;
  background: #1a73e8;
  color: #fff;
  font-size: 0.95rem;
  cursor: pointer;
}

.submit-btn:hover {
  background: #1557b0;
}

.error {
  margin-top: 1rem;
  color: #d93025;
  font-size: 0.85rem;
  text-align: center;
}

.toggle {
  margin-top: 1rem;
  text-align: center;
  font-size: 0.9rem;
  color: #666;
}

.toggle a {
  color: #1a73e8;
  text-decoration: none;
}
</style>
