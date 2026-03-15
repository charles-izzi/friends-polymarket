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
  <v-container class="fill-height d-flex align-center justify-center">
    <v-card max-width="400" width="100%" class="pa-4">
      <v-card-title class="text-h5 text-center">
        {{ isRegistering ? 'Create Account' : 'Sign In' }}
      </v-card-title>

      <v-card-text>
        <v-btn variant="outlined" block class="mb-4" @click="handleGoogleSignIn">
          <template #prepend>
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
          </template>
          Continue with Google
        </v-btn>

        <div class="d-flex align-center my-4">
          <v-divider />
          <span class="mx-3 text-body-2 text-medium-emphasis">or</span>
          <v-divider />
        </div>

        <v-form @submit.prevent="handleEmailSubmit">
          <v-text-field
            v-model="email"
            type="email"
            label="Email"
            required
            autocomplete="email"
            variant="outlined"
            density="comfortable"
            class="mb-1"
          />
          <v-text-field
            v-model="password"
            type="password"
            label="Password"
            required
            :minlength="6"
            autocomplete="current-password"
            variant="outlined"
            density="comfortable"
            class="mb-1"
          />
          <v-btn type="submit" color="primary" block size="large">
            {{ isRegistering ? 'Create Account' : 'Sign In' }}
          </v-btn>
        </v-form>

        <v-alert v-if="authStore.error" type="error" variant="tonal" class="mt-4">
          {{ authStore.error }}
        </v-alert>

        <p class="text-body-2 text-medium-emphasis text-center mt-4">
          {{ isRegistering ? 'Already have an account?' : "Don't have an account?" }}
          <a
            href="#"
            class="text-primary text-decoration-none"
            @click.prevent="isRegistering = !isRegistering"
          >
            {{ isRegistering ? 'Sign In' : 'Create Account' }}
          </a>
        </p>
      </v-card-text>
    </v-card>
  </v-container>
</template>
