<script setup lang="ts">
import { RouterView, useRouter } from 'vue-router'
import { useMarketStore } from '@/stores/market'
import { useAuthStore } from '@/stores/auth'
import { useBetsStore } from '@/stores/bets'
import { computed, ref } from 'vue'
import { useDevDb } from '@/firebase'

const authStore = useAuthStore()
const marketStore = useMarketStore()
const betsStore = useBetsStore()
const router = useRouter()

const drawer = ref(false)
const userMenu = ref(false)
const devDb = ref(useDevDb)

function toggleDevDb() {
  localStorage.setItem('useDevDb', String(devDb.value))
  window.location.reload()
}

async function handleLogout() {
  marketStore.cleanup()
  await authStore.logout()
  router.replace('/login')
}

const leaveConfirm = ref(false)
const leaving = ref(false)

async function handleLeaveMarket() {
  leaving.value = true
  try {
    await marketStore.leaveMarket()
    router.replace('/join')
  } finally {
    leaving.value = false
    leaveConfirm.value = false
  }
}

const balance = computed(() => marketStore.currentMember?.balance ?? null)
const balanceDisplay = computed(() => {
  if (balance.value === null) return null
  const sign = balance.value < 0 ? '-' : ''
  return `${sign}$${Math.abs(balance.value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
})
const currentUserShares = computed(() => {
  if (!authStore.user) return 0
  return betsStore.memberShares[authStore.user.uid] ?? 0
})
</script>

<template>
  <v-app>
    <v-app-bar density="compact" color="primary">
      <v-app-bar-nav-icon v-if="authStore.isAuthenticated" @click="drawer = !drawer" />
      <v-app-bar-title :style="{ marginLeft: authStore.isAuthenticated ? '0' : '16px' }">
        <router-link to="/" class="text-decoration-none" style="color: #4a4a4a"
          >Polymarket with Friends</router-link
        >
      </v-app-bar-title>
      <template #append>
        <div
          v-if="authStore.isAuthenticated && balanceDisplay !== null"
          class="d-flex flex-column align-end mr-3"
        >
          <span class="text-body-2" :class="balance! < 0 ? 'text-error' : 'text-white'">
            {{ balanceDisplay }}
          </span>
          <span class="text-caption text-white" style="opacity: 0.7; line-height: 1.1">
            {{ currentUserShares }} shares
          </span>
        </div>
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
            <v-list-item
              v-if="marketStore.hasMarket"
              prepend-icon="mdi-exit-run"
              title="Leave Market"
              @click="leaveConfirm = true"
            />
            <v-list-item prepend-icon="mdi-logout" title="Sign Out" @click="handleLogout" />
          </v-list>
        </v-menu>

        <v-dialog v-model="leaveConfirm" max-width="400">
          <v-card>
            <v-card-title>Leave Market?</v-card-title>
            <v-card-text>
              Are you sure you want to leave
              <strong>{{ marketStore.market?.name }}</strong
              >?
            </v-card-text>
            <v-card-actions>
              <v-spacer />
              <v-btn @click="leaveConfirm = false">Cancel</v-btn>
              <v-btn color="error" :loading="leaving" @click="handleLeaveMarket">Leave</v-btn>
            </v-card-actions>
          </v-card>
        </v-dialog>
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

      <template #append>
        <v-divider />
        <div class="d-flex align-center justify-space-between px-4 py-2">
          <span class="text-body-2">Use Dev DB</span>
          <v-switch
            v-model="devDb"
            color="warning"
            density="compact"
            hide-details
            @change="toggleDevDb"
          />
        </div>
      </template>
    </v-navigation-drawer>

    <v-main>
      <RouterView />
    </v-main>
  </v-app>
</template>
