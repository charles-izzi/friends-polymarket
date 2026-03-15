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
  <div>
    <h1>You did it!</h1>
    <p>
      Visit <a href="https://vuejs.org/" target="_blank" rel="noopener">vuejs.org</a> to read the
      documentation
    </p>
    <p>Signed in as {{ authStore.user?.email || authStore.user?.displayName }}</p>
    <button @click="handleLogout">Sign Out</button>
  </div>
</template>
