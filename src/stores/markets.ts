import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { collection, doc, onSnapshot, orderBy, query } from 'firebase/firestore'
import { getFunctions, httpsCallable } from 'firebase/functions'
import { db } from '@/firebase'
import { useServerStore } from '@/stores/server'
import { useAuthStore } from '@/stores/auth'
import { calcPrices } from '@/utils/lmsr'
import type { Market, Position, Trade } from '@/types'

export const useMarketsStore = defineStore('markets', () => {
  const markets = ref<Market[]>([])
  const currentPosition = ref<Position | null>(null)
  const trades = ref<Trade[]>([])
  const loading = ref(false)
  const error = ref('')

  const functions = getFunctions()
  let unsubMarkets: (() => void) | null = null
  let unsubPosition: (() => void) | null = null
  let unsubTrades: (() => void) | null = null

  const openMarkets = computed(() => markets.value.filter((m) => m.status === 'open'))
  const closedMarkets = computed(() => markets.value.filter((m) => m.status !== 'open'))

  /** Get LMSR prices for a market */
  function getPrices(market: Market): number[] {
    return calcPrices(market.sharesSold, market.liquidityParam)
  }

  function listenToMarkets() {
    const serverStore = useServerStore()
    if (!serverStore.server) return

    cleanup()
    loading.value = true

    const marketsRef = collection(db, 'servers', serverStore.server.id, 'markets')
    const q = query(marketsRef, orderBy('createdAt', 'desc'))

    unsubMarkets = onSnapshot(q, (snap) => {
      markets.value = snap.docs.map((d) => ({ id: d.id, ...d.data() }) as Market)
      loading.value = false
    })
  }

  async function createMarket(data: {
    question: string
    type: 'binary' | 'multiple_choice'
    outcomes: string[]
    excludedMembers: string[]
    closesAt: string
  }) {
    const serverStore = useServerStore()
    if (!serverStore.server) throw new Error('No server')

    error.value = ''
    try {
      const fn = httpsCallable<
        {
          serverId: string
          question: string
          type: string
          outcomes: string[]
          excludedMembers: string[]
          closesAt: string
        },
        { marketId: string }
      >(functions, 'createMarket')

      const result = await fn({
        serverId: serverStore.server.id,
        ...data,
      })
      return result.data.marketId
    } catch (e: unknown) {
      error.value = e instanceof Error ? e.message : 'Failed to create market'
      throw e
    }
  }

  function listenToMarket(marketId: string) {
    const serverStore = useServerStore()
    const authStore = useAuthStore()
    if (!serverStore.server || !authStore.user) return

    const sid = serverStore.server.id
    const uid = authStore.user.uid

    // Listen to user's position
    unsubPosition?.()
    unsubPosition = onSnapshot(
      doc(db, 'servers', sid, 'markets', marketId, 'positions', uid),
      (snap) => {
        currentPosition.value = snap.exists()
          ? ({ userId: snap.id, ...snap.data() } as Position)
          : null
      },
    )

    // Listen to recent trades
    unsubTrades?.()
    const tradesRef = collection(db, 'servers', sid, 'markets', marketId, 'trades')
    const tradesQuery = query(tradesRef, orderBy('createdAt', 'desc'))
    unsubTrades = onSnapshot(tradesQuery, (snap) => {
      trades.value = snap.docs.map((d) => ({ id: d.id, ...d.data() }) as Trade)
    })
  }

  function stopListeningToMarket() {
    unsubPosition?.()
    unsubTrades?.()
    unsubPosition = null
    unsubTrades = null
    currentPosition.value = null
    trades.value = []
  }

  async function executeTrade(data: { marketId: string; outcomeIndex: number; shares: number }) {
    const serverStore = useServerStore()
    if (!serverStore.server) throw new Error('No server')

    error.value = ''
    try {
      const fn = httpsCallable<
        { serverId: string; marketId: string; outcomeIndex: number; shares: number },
        { tradeId: string; cost: number; newBalance: number; priceAfter: number[] }
      >(functions, 'executeTrade')

      const result = await fn({
        serverId: serverStore.server.id,
        ...data,
      })
      return result.data
    } catch (e: unknown) {
      error.value = e instanceof Error ? e.message : 'Trade failed'
      throw e
    }
  }

  function cleanup() {
    unsubMarkets?.()
    unsubPosition?.()
    unsubTrades?.()
    unsubMarkets = null
    unsubPosition = null
    unsubTrades = null
    markets.value = []
    currentPosition.value = null
    trades.value = []
  }

  async function resolveMarket(marketId: string, outcomeIndex: number) {
    const serverStore = useServerStore()
    if (!serverStore.server) throw new Error('No server')

    error.value = ''
    try {
      const fn = httpsCallable<
        { serverId: string; marketId: string; outcomeIndex: number },
        { success: boolean }
      >(functions, 'resolveMarket')

      await fn({
        serverId: serverStore.server.id,
        marketId,
        outcomeIndex,
      })
    } catch (e: unknown) {
      error.value = e instanceof Error ? e.message : 'Failed to resolve market'
      throw e
    }
  }

  async function cancelMarket(marketId: string) {
    const serverStore = useServerStore()
    if (!serverStore.server) throw new Error('No server')

    error.value = ''
    try {
      const fn = httpsCallable<{ serverId: string; marketId: string }, { success: boolean }>(
        functions,
        'cancelMarket',
      )

      await fn({
        serverId: serverStore.server.id,
        marketId,
      })
    } catch (e: unknown) {
      error.value = e instanceof Error ? e.message : 'Failed to cancel market'
      throw e
    }
  }

  return {
    markets,
    currentPosition,
    trades,
    loading,
    error,
    openMarkets,
    closedMarkets,
    getPrices,
    listenToMarkets,
    listenToMarket,
    stopListeningToMarket,
    createMarket,
    executeTrade,
    resolveMarket,
    cancelMarket,
    cleanup,
  }
})
