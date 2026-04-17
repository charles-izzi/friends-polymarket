<script setup lang="ts">
import { RouterView, useRouter } from 'vue-router'
import { useMarketStore } from '@/stores/market'
import { useAuthStore } from '@/stores/auth'
import { useBetsStore } from '@/stores/bets'
import { useNotificationsStore } from '@/stores/notifications'
import { useCommentsStore } from '@/stores/comments'
import { computed, ref, onMounted, onUnmounted } from 'vue'
import { useDevDb } from '@/firebase'
import type { Comment } from '@/types'

const authStore = useAuthStore()
const marketStore = useMarketStore()
const betsStore = useBetsStore()
const notificationsStore = useNotificationsStore()
const commentsStore = useCommentsStore()
const router = useRouter()

const drawer = ref(false)
const userMenu = ref(false)
const devDb = ref(useDevDb)

// --- New Messages drawer ---
const messagesDrawer = ref(false)
const drawerBetIds = ref<string[]>([])
const drawerComments = ref<Record<string, Comment[]>>({})
const drawerLastSeenAt = ref<Record<string, number>>({})
const drawerExpanded = ref<Record<string, boolean>>({})
const drawerLoading = ref(false)

const showFab = computed(
  () => authStore.isAuthenticated && marketStore.hasMarket && commentsStore.unseenCount > 0,
)

async function openMessagesDrawer() {
  const betIds = [...commentsStore.unseenBetIds]
  // Snapshot the lastSeenAt before marking all seen
  const seenSnapshot: Record<string, number> = {}
  for (const id of betIds) {
    seenSnapshot[id] = commentsStore.getLastSeenAt(id)
  }
  drawerLastSeenAt.value = seenSnapshot
  drawerBetIds.value = betIds
  drawerExpanded.value = {}

  // Mark all as read immediately
  commentsStore.markAllSeen()

  // Open drawer and fetch recent comments
  messagesDrawer.value = true
  drawerLoading.value = true
  const results: Record<string, Comment[]> = {}
  await Promise.all(
    betIds.map(async (betId) => {
      results[betId] = await commentsStore.fetchRecentComments(betId, 3)
    }),
  )
  drawerComments.value = results
  drawerLoading.value = false
}

async function expandBetComments(betId: string) {
  const all = await commentsStore.fetchAllComments(betId)
  drawerComments.value = { ...drawerComments.value, [betId]: all }
  drawerExpanded.value = { ...drawerExpanded.value, [betId]: true }
}

function collapseBetComments(betId: string) {
  drawerExpanded.value = { ...drawerExpanded.value, [betId]: false }
}

function isNewComment(betId: string, comment: Comment): boolean {
  if (!comment.createdAt) return false
  const seenAt = drawerLastSeenAt.value[betId] ?? 0
  return comment.createdAt.toDate().getTime() > seenAt
}

function drawerCommentTimeAgo(ts: import('firebase/firestore').Timestamp): string {
  const diff = Date.now() - ts.toDate().getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

function drawerMemberName(userId: string): string {
  return marketStore.members.find((m) => m.userId === userId)?.displayName ?? 'Unknown'
}

function navigateToBet(betId: string) {
  messagesDrawer.value = false
  router.push(`/${marketStore.market?.id}/bets/${betId}`)
}

function betQuestion(betId: string): string {
  return betsStore.bets.find((b) => b.id === betId)?.question ?? 'Unknown bet'
}

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
    if (marketStore.hasMarket) {
      router.replace(`/${marketStore.market!.id}`)
    } else {
      router.replace('/join')
    }
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
    router.push(`/${marketStore.market?.id}/bets/${n.betId}`)
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
              :to="marketStore.market ? `/${marketStore.market.id}/stats` : '/'"
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
        <template v-if="marketStore.hasMultipleMarkets">
          <v-list-subheader class="text-uppercase font-weight-bold"> Markets </v-list-subheader>
          <v-list-item
            v-for="m in marketStore.markets"
            :key="m.id"
            :title="m.name"
            :active="m.id === marketStore.activeMarketId"
            prepend-icon="mdi-store"
            :to="`/${m.id}`"
            @click="drawer = false"
          />
          <v-divider class="my-1" />
        </template>
        <v-list-subheader class="text-uppercase font-weight-bold">
          {{ marketStore.market?.name ?? 'Market' }}
        </v-list-subheader>
        <v-list-item
          prepend-icon="mdi-store"
          title="Market"
          :to="marketStore.market ? `/${marketStore.market.id}` : '/'"
          @click="drawer = false"
        />
        <v-list-item
          class="ml-4"
          prepend-icon="mdi-chart-line"
          title="Bets"
          :to="marketStore.market ? `/${marketStore.market.id}/bets` : '/'"
          @click="drawer = false"
        />
        <v-list-item
          class="ml-4"
          prepend-icon="mdi-plus"
          title="Create Bet"
          :to="marketStore.market ? `/${marketStore.market.id}/bets/create` : '/'"
          @click="drawer = false"
        />
        <v-list-item
          class="ml-4"
          prepend-icon="mdi-chart-box"
          title="My Stats"
          :to="marketStore.market ? `/${marketStore.market.id}/stats` : '/'"
          @click="drawer = false"
        />
        <v-divider class="my-1" />
        <v-list-item
          prepend-icon="mdi-plus-circle-outline"
          title="Join / Create Market"
          to="/join"
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
            Install Friendly Bet for quick access: tap
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

    <!-- New Messages FAB -->
    <v-btn
      v-if="showFab"
      icon
      color="secondary"
      size="large"
      style="position: fixed; bottom: 24px; right: 24px; z-index: 1000"
      @click="openMessagesDrawer"
    >
      <v-badge :content="commentsStore.unseenCount" color="error" floating>
        <v-icon>mdi-message-text</v-icon>
      </v-badge>
    </v-btn>

    <!-- New Messages Drawer -->
    <v-navigation-drawer v-model="messagesDrawer" location="right" temporary width="360">
      <v-list-subheader class="text-uppercase font-weight-bold px-4 pt-3">
        New Messages
      </v-list-subheader>

      <v-progress-linear v-if="drawerLoading" indeterminate class="mb-2" />

      <div
        v-if="drawerBetIds.length === 0 && !drawerLoading"
        class="pa-4 text-center text-medium-emphasis"
      >
        No new messages
      </div>

      <div v-for="betId in drawerBetIds" :key="betId" class="px-3 mb-2">
        <v-card variant="outlined" class="pa-0">
          <div
            class="d-flex align-center px-3 py-2 cursor-pointer"
            style="border-bottom: thin solid rgba(var(--v-border-color), var(--v-border-opacity))"
            @click="navigateToBet(betId)"
          >
            <div class="flex-grow-1" style="min-width: 0">
              <p class="text-caption font-weight-medium text-truncate">{{ betQuestion(betId) }}</p>
            </div>
            <v-icon icon="mdi-chevron-right" size="small" class="ml-2 flex-shrink-0" />
          </div>

          <div class="px-3 py-2">
            <div
              v-if="
                !drawerExpanded[betId] &&
                (betsStore.bets.find((b) => b.id === betId)?.commentCount ?? 0) >
                  (drawerComments[betId]?.length ?? 0)
              "
              class="d-flex justify-center mb-1"
            >
              <v-btn
                variant="text"
                size="x-small"
                prepend-icon="mdi-chevron-up"
                @click.stop="expandBetComments(betId)"
              >
                Load earlier comments
              </v-btn>
            </div>

            <div
              v-for="comment in drawerComments[betId] ?? []"
              :key="comment.id"
              class="d-flex align-start ga-1 mb-1"
            >
              <div
                v-if="isNewComment(betId, comment)"
                style="
                  width: 6px;
                  height: 6px;
                  border-radius: 50%;
                  background-color: rgb(var(--v-theme-info));
                  flex-shrink: 0;
                  margin-top: 9px;
                  margin-right: 4px;
                "
              />
              <div v-else style="width: 6px; flex-shrink: 0; margin-right: 4px" />
              <div class="flex-grow-1" style="min-width: 0">
                <div class="d-flex align-center justify-space-between">
                  <span class="text-caption text-medium-emphasis" style="opacity: 0.6">{{
                    drawerMemberName(comment.userId)
                  }}</span>
                  <span class="text-caption text-medium-emphasis" style="opacity: 0.6">
                    {{ comment.createdAt ? drawerCommentTimeAgo(comment.createdAt) : '' }}
                  </span>
                </div>
                <p
                  class="text-body-2 ml-2"
                  style="white-space: pre-wrap; word-break: break-word; margin-top: -1px"
                >
                  {{ comment.text }}
                </p>
              </div>
            </div>
          </div>
        </v-card>
      </div>
    </v-navigation-drawer>
  </v-app>
</template>
