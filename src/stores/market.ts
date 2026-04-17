import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import {
  collection,
  doc,
  query,
  where,
  collectionGroup,
  onSnapshot,
  getDoc,
  getDocs,
} from 'firebase/firestore'
import { getFunctions, httpsCallable } from 'firebase/functions'
import { db, dbName, requestPushPermission } from '@/firebase'
import { useAuthStore } from '@/stores/auth'
import type { Market, Member } from '@/types'

const ACTIVE_MARKET_KEY = 'activeMarketId'

export const useMarketStore = defineStore('market', () => {
  const markets = ref<Market[]>([])
  const activeMarketId = ref<string | null>(localStorage.getItem(ACTIVE_MARKET_KEY))
  const members = ref<Member[]>([])
  const loading = ref(true)
  const error = ref('')

  const functions = getFunctions()

  const market = computed(() => markets.value.find((m) => m.id === activeMarketId.value) ?? null)
  const hasMarket = computed(() => markets.value.length > 0)
  const hasMultipleMarkets = computed(() => markets.value.length > 1)
  const currentMember = computed(() => {
    const authStore = useAuthStore()
    return members.value.find((m) => m.userId === authStore.user?.uid) ?? null
  })

  let unsubMarket: (() => void) | null = null
  let unsubMembers: (() => void) | null = null

  async function loadUserMarkets() {
    const authStore = useAuthStore()
    if (!authStore.user) {
      markets.value = []
      members.value = []
      activeMarketId.value = null
      loading.value = false
      return
    }

    loading.value = true
    error.value = ''

    try {
      // Find all markets this user belongs to via collectionGroup query
      const memberQuery = query(
        collectionGroup(db, 'members'),
        where('userId', '==', authStore.user.uid),
      )
      const memberSnap = await getDocs(memberQuery)

      if (memberSnap.empty) {
        markets.value = []
        members.value = []
        activeMarketId.value = null
        loading.value = false
        return
      }

      // Load all market docs
      const marketIds = memberSnap.docs.map((d) => d.ref.parent.parent!.id)
      const marketDocs = await Promise.all(marketIds.map((id) => getDoc(doc(db, 'markets', id))))
      markets.value = marketDocs
        .filter((d) => d.exists())
        .map((d) => ({ id: d.id, ...d.data() }) as Market)

      // If saved activeMarketId not in the list, pick the first one
      if (!activeMarketId.value || !marketIds.includes(activeMarketId.value)) {
        activeMarketId.value = marketIds[0] ?? null
      }

      if (activeMarketId.value) {
        localStorage.setItem(ACTIVE_MARKET_KEY, activeMarketId.value)
        await listenToActiveMarket(activeMarketId.value)
      }

      // Register/refresh push token on every load
      if (typeof Notification !== 'undefined' && Notification.permission !== 'denied') {
        requestPushPermission()
      }
    } catch (e: unknown) {
      error.value = e instanceof Error ? e.message : 'Failed to load markets'
    } finally {
      loading.value = false
    }
  }

  /** Set up realtime listeners for a specific market's doc and members */
  async function listenToActiveMarket(marketId: string) {
    // Tear down previous listeners
    unsubMarket?.()
    unsubMembers?.()

    const marketRef = doc(db, 'markets', marketId)
    const marketReady = new Promise<void>((resolve) => {
      unsubMarket = onSnapshot(marketRef, (snap) => {
        if (snap.exists()) {
          const data = { id: snap.id, ...snap.data() } as Market
          // Update in the markets array too
          const idx = markets.value.findIndex((m) => m.id === snap.id)
          if (idx >= 0) {
            markets.value = markets.value.map((m, i) => (i === idx ? data : m))
          }
        }
        resolve()
      })
    })

    const membersReady = new Promise<void>((resolve) => {
      unsubMembers = onSnapshot(collection(db, 'markets', marketId, 'members'), (snap) => {
        members.value = snap.docs.map((d) => ({ userId: d.id, ...d.data() }) as Member)
        resolve()
      })
    })

    await Promise.all([marketReady, membersReady])
  }

  async function switchMarket(marketId: string) {
    if (marketId === activeMarketId.value) return
    if (!markets.value.find((m) => m.id === marketId)) return

    activeMarketId.value = marketId
    localStorage.setItem(ACTIVE_MARKET_KEY, marketId)
    members.value = []
    await listenToActiveMarket(marketId)
  }

  async function createMarket(name: string): Promise<string> {
    error.value = ''
    try {
      const fn = httpsCallable<
        { name: string; database: string },
        { marketId: string; inviteCode: string }
      >(functions, 'createMarket')
      const result = await fn({ name, database: dbName })
      const newMarketId = result.data.marketId
      await loadUserMarkets()
      await switchMarket(newMarketId)
      requestPushPermission()
      return newMarketId
    } catch (e: unknown) {
      error.value = e instanceof Error ? e.message : 'Failed to create market'
      throw e
    }
  }

  async function joinMarket(inviteCode: string): Promise<string> {
    error.value = ''
    try {
      const fn = httpsCallable<{ inviteCode: string; database: string }, { marketId: string }>(
        functions,
        'joinMarket',
      )
      const result = await fn({ inviteCode, database: dbName })
      const newMarketId = result.data.marketId
      await loadUserMarkets()
      await switchMarket(newMarketId)
      requestPushPermission()
      return newMarketId
    } catch (e: unknown) {
      error.value = e instanceof Error ? e.message : 'Failed to join market'
      throw e
    }
  }

  async function leaveMarket() {
    error.value = ''
    try {
      const fn = httpsCallable<{ marketId: string; database: string }, { success: boolean }>(
        functions,
        'leaveMarket',
      )
      const leftMarketId = market.value!.id
      await fn({ marketId: leftMarketId, database: dbName })

      // Remove from local list
      markets.value = markets.value.filter((m) => m.id !== leftMarketId)

      if (markets.value.length > 0) {
        // Switch to another market
        const nextId = markets.value[0]!.id
        activeMarketId.value = nextId
        localStorage.setItem(ACTIVE_MARKET_KEY, nextId)
        await listenToActiveMarket(nextId)
      } else {
        // No markets left
        cleanupListeners()
        activeMarketId.value = null
        localStorage.removeItem(ACTIVE_MARKET_KEY)
        members.value = []
      }
      loading.value = false
    } catch (e: unknown) {
      error.value = e instanceof Error ? e.message : 'Failed to leave market'
      throw e
    }
  }

  function cleanupListeners() {
    unsubMarket?.()
    unsubMembers?.()
    unsubMarket = null
    unsubMembers = null
  }

  function cleanup() {
    cleanupListeners()
    markets.value = []
    market // computed, no reset needed
    members.value = []
    activeMarketId.value = null
    loading.value = true
  }

  return {
    market,
    markets,
    activeMarketId,
    members,
    loading,
    error,
    hasMarket,
    hasMultipleMarkets,
    currentMember,
    loadUserMarkets,
    switchMarket,
    createMarket,
    joinMarket,
    leaveMarket,
    cleanup,
  }
})
