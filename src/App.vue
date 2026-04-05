<script setup lang="ts">
import { RouterView, useRouter } from 'vue-router'
import { useMarketStore } from '@/stores/market'
import { useAuthStore } from '@/stores/auth'
import { computed, ref } from 'vue'

const authStore = useAuthStore()
const marketStore = useMarketStore()
const router = useRouter()

const drawer = ref(false)
const userMenu = ref(false)

async function handleLogout() {
  marketStore.cleanup()
  await authStore.logout()
  router.replace('/login')
}

const balance = computed(() => marketStore.currentMember?.balance ?? null)
const balanceDisplay = computed(() => {
  if (balance.value === null) return null
  return `$${balance.value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
})
</script>

<template>
  <v-app>
    <v-app-bar density="compact" color="primary">
      <v-app-bar-nav-icon v-if="authStore.isAuthenticated" @click="drawer = !drawer" />
      <v-app-bar-title style="margin-left: 0">
        <router-link to="/" class="text-decoration-none" style="color: #4a4a4a"
          >Polymarket with Friends</router-link
        >
      </v-app-bar-title>
      <template #append>
        <span
          v-if="authStore.isAuthenticated && balanceDisplay !== null"
          class="text-body-2 mr-3"
          :class="balance! < 0 ? 'text-error' : 'text-white'"
        >
          {{ balanceDisplay }}
        </span>
        <v-menu v-if="authStore.isAuthenticated" v-model="userMenu" location="bottom end">
          <template #activator="{ props }">
            <v-btn icon v-bind="props">
              <v-avatar size="28" color="white">
                <v-img v-if="authStore.user?.photoURL" :src="authStore.user.photoURL" />
                <v-icon v-else icon="mdi-account" color="primary" />
              </v-avatar>
            </v-btn>
          </template>
          <v-list density="compact">
            <v-list-item :title="authStore.user?.displayName ?? 'User'" disabled />
            <v-divider />
            <v-list-item prepend-icon="mdi-logout" title="Sign Out" @click="handleLogout" />
          </v-list>
        </v-menu>
      </template>
    </v-app-bar>

    <v-navigation-drawer v-if="authStore.isAuthenticated" v-model="drawer" temporary>
      <v-list density="compact" nav>
        <v-list-subheader class="text-uppercase font-weight-bold">
          {{ marketStore.market?.name ?? 'Market' }}
        </v-list-subheader>
        <v-list-item prepend-icon="mdi-store" title="Market" to="/" @click="drawer = false" />
        <v-list-item
          class="ml-4"
          prepend-icon="mdi-chart-line"
          title="Bets"
          to="/bets"
          @click="drawer = false"
        />
        <v-list-item
          class="ml-4"
          prepend-icon="mdi-plus"
          title="Create Bet"
          to="/bets/create"
          @click="drawer = false"
        />
      </v-list>
    </v-navigation-drawer>

    <v-main>
      <RouterView />
    </v-main>
  </v-app>
</template>
