<script setup lang="ts">
import { RouterView } from 'vue-router'
import { useMarketStore } from '@/stores/market'
import { useAuthStore } from '@/stores/auth'
import { computed } from 'vue'

const authStore = useAuthStore()
const marketStore = useMarketStore()

const balance = computed(() => marketStore.currentMember?.balance ?? null)
const balanceDisplay = computed(() => {
  if (balance.value === null) return null
  return `$${balance.value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
})
</script>

<template>
  <v-app>
    <v-app-bar density="compact" color="primary">
      <v-app-bar-title>
        <router-link to="/" class="text-white text-decoration-none">Friends Polymarket</router-link>
      </v-app-bar-title>
      <template #append>
        <span
          v-if="authStore.isAuthenticated && balanceDisplay !== null"
          class="text-body-2 mr-3"
          :class="balance! < 0 ? 'text-red-lighten-3' : 'text-white'"
        >
          {{ balanceDisplay }}
        </span>
      </template>
    </v-app-bar>
    <v-main>
      <RouterView />
    </v-main>
  </v-app>
</template>
