<script setup lang="ts">
import { RouterView, useRouter } from 'vue-router'
import { useMarketStore } from '@/stores/market'
import { useAuthStore } from '@/stores/auth'
import { useBetsStore } from '@/stores/bets'
import { useNotificationsStore } from '@/stores/notifications'
import { computed, ref, onMounted, onUnmounted } from 'vue'
import { useDevDb } from '@/firebase'

const authStore = useAuthStore()
const marketStore = useMarketStore()
const betsStore = useBetsStore()
const notificationsStore = useNotificationsStore()
const router = useRouter()

const drawer = ref(false)
const userMenu = ref(false)
const devDb = ref(useDevDb)

// PWA Install banner
const deferredPrompt = ref<Event | null>(null)
const installDismissed = ref(localStorage.getItem('pwa-install-dismissed') === 'true')
const isIos = /iPad|iPhone|iPod/.test(navigator.userAgent)
const isInStandaloneMode =
  window.matchMedia('(display-mode: standalone)').matches ||
  ('standalone' in navigator && (navigator as unknown as { standalone: boolean }).standalone)
const showInstallBanner = computed(
  () =>
    authStore.isAuthenticated &&
    !installDismissed.value &&
    !isInStandaloneMode &&
    (deferredPrompt.value !== null || isIos),
)

function handleBeforeInstallPrompt(e: Event) {
  e.preventDefault()
  deferredPrompt.value = e
}

async function installApp() {
  const prompt = deferredPrompt.value as {
    prompt: () => void
    userChoice: Promise<{ outcome: string }>
  } | null
  if (!prompt) return
  prompt.prompt()
  const { outcome } = await prompt.userChoice
  if (outcome === 'accepted') {
    deferredPrompt.value = null
    installDismissed.value = true
    localStorage.setItem('pwa-install-dismissed', 'true')
  }
}

function dismissInstallBanner() {
  installDismissed.value = true
  localStorage.setItem('pwa-install-dismissed', 'true')
}

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

const showSnackbar = computed({
  get: () => !!notificationsStore.current,
  set: (val: boolean) => {
    if (!val) notificationsStore.dismiss()
  },
})

function onNotificationClick() {
  const n = notificationsStore.current
  if (n) {
    router.push(`/bets/${n.betId}`)
    notificationsStore.dismiss()
  }
}

// Handle navigation from service worker notification clicks
function handleSwNavigation(e: Event) {
  const url = (e as CustomEvent).detail?.url
  if (url) router.push(url)
}

onMounted(() => {
  window.addEventListener('notification-navigate', handleSwNavigation)
  window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt)
  window.addEventListener('appinstalled', () => {
    deferredPrompt.value = null
    installDismissed.value = true
    localStorage.setItem('pwa-install-dismissed', 'true')
  })
  notificationsStore.initForegroundListener()
})

onUnmounted(() => {
  window.removeEventListener('notification-navigate', handleSwNavigation)
  window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt)
})
</script>

<template>
  <v-app>
    <v-app-bar density="compact" color="primary">
      <v-app-bar-nav-icon v-if="authStore.isAuthenticated" @click="drawer = !drawer" />
      <v-app-bar-title :style="{ marginLeft: authStore.isAuthenticated ? '0' : '16px' }">
        <router-link to="/" class="text-decoration-none" style="color: #4a4a4a"
          >Friendly Bet</router-link
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
          <span class="text-caption" style="color: #4a4a4a; line-height: 1.1">
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
            <v-list-item
              :title="authStore.user?.displayName || authStore.user?.email || 'User'"
              disabled
            />
            <v-divider />
            <v-list-item
              prepend-icon="mdi-chart-box"
              title="My Stats"
              to="/stats"
              @click="userMenu = false"
            />
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
        <v-list-item
          class="ml-4"
          prepend-icon="mdi-chart-box"
          title="My Stats"
          to="/stats"
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
      <v-banner
        v-if="showInstallBanner"
        icon="mdi-cellphone-arrow-down"
        lines="two"
        color="primary"
        class="mb-2"
      >
        <template v-if="isIos">
          <v-banner-text>
            Install Friendly Bet for notifications: tap
            <v-icon icon="mdi-export-variant" size="small" /> then
            <strong>Add to Home Screen</strong>.
          </v-banner-text>
        </template>
        <template v-else>
          <v-banner-text> Install Friendly Bet for push notifications. </v-banner-text>
        </template>
        <template #actions>
          <v-btn text="Dismiss" @click="dismissInstallBanner" />
          <v-btn v-if="!isIos" color="white" variant="flat" text="Install" @click="installApp" />
        </template>
      </v-banner>
      <RouterView />
    </v-main>

    <v-snackbar
      v-model="showSnackbar"
      :timeout="7000"
      location="bottom"
      :color="
        notificationsStore.current
          ? notificationsStore.getColor(notificationsStore.current.type)
          : undefined
      "
      @click="onNotificationClick"
      style="cursor: pointer"
    >
      <div class="d-flex align-center">
        <v-icon
          v-if="notificationsStore.current"
          :icon="notificationsStore.getIcon(notificationsStore.current.type)"
          class="mr-3"
        />
        <div>
          <div class="text-subtitle-2">{{ notificationsStore.current?.title }}</div>
          <div class="text-caption" style="opacity: 0.9">
            {{ notificationsStore.current?.body }}
          </div>
        </div>
      </div>
      <template #actions>
        <v-btn
          icon="mdi-close"
          size="small"
          variant="text"
          @click.stop="notificationsStore.dismiss()"
        />
      </template>
    </v-snackbar>
  </v-app>
</template>
