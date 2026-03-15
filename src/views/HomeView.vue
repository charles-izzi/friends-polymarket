<script setup lang="ts">
import { useAuthStore } from '@/stores/auth'
import { useRouter } from 'vue-router'

const authStore = useAuthStore()
const router = useRouter()

async function handleLogout() {
  await authStore.logout()
  router.replace('/login')
}
</script>

<template>
  <v-container>
    <h1 class="text-h4 mb-4">You did it!</h1>
    <p class="text-body-1 mb-2">
      Visit <a href="https://vuejs.org/" target="_blank" rel="noopener">vuejs.org</a> to read the
      documentation
    </p>
    <p class="text-body-1 mb-4">
      Signed in as {{ authStore.user?.email || authStore.user?.displayName }}
    </p>
    <v-btn color="primary" variant="outlined" @click="handleLogout">Sign Out</v-btn>
  </v-container>
</template>
