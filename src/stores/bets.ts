import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { collection, doc, onSnapshot, orderBy, query } from 'firebase/firestore'
import { getFunctions, httpsCallable } from 'firebase/functions'
import { db, dbName } from '@/firebase'
import { useMarketStore } from '@/stores/market'
import { useAuthStore } from '@/stores/auth'
import { calcPrices, calcEffectiveB } from '@/utils/lmsr'
import type { Bet, Position, Trade } from '@/types'

export const useBetsStore = defineStore('bets', () => {
  const bets = ref<Bet[]>([])
  const currentPosition = ref<Position | null>(null)
  const trades = ref<Trade[]>([])
  const loading = ref(false)
  const error = ref('')

  const functions = getFunctions()
  let unsubBets: (() => void) | null = null
  let unsubPosition: (() => void) | null = null
  let unsubTrades: (() => void) | null = null
  const allPositions = ref<Record<string, Position[]>>({})
  const positionUnsubs = new Map<string, () => void>()

  const openBets = computed(() => bets.value.filter((m) => m.status === 'open'))
  const closedBets = computed(() => bets.value.filter((m) => m.status !== 'open'))

  const memberShares = computed(() => {
    const result: Record<string, number> = {}
    for (const positions of Object.values(allPositions.value)) {
      for (const pos of positions) {
        const total = pos.shares.reduce((sum, s) => sum + s, 0)
        result[pos.userId] = (result[pos.userId] ?? 0) + total
      }
    }
    return result
  })

  /** Get LMSR prices for a bet */
  function getPrices(bet: Bet): number[] {
    const b = calcEffectiveB(bet.totalVolume ?? 0, bet.liquidityParam)
    return calcPrices(bet.sharesSold, b)
  }

  function syncPositionListeners() {
    const marketStore = useMarketStore()
    if (!marketStore.market) return
    const mid = marketStore.market.id

    const unresolvedIds = new Set(
      bets.value.filter((b) => b.status === 'open' || b.status === 'closed').map((b) => b.id),
    )

    for (const [betId, unsub] of positionUnsubs) {
      if (!unresolvedIds.has(betId)) {
        unsub()
        positionUnsubs.delete(betId)
        const { [betId]: _, ...rest } = allPositions.value
        allPositions.value = rest
      }
    }

    for (const betId of unresolvedIds) {
      if (!positionUnsubs.has(betId)) {
        const posRef = collection(db, 'markets', mid, 'bets', betId, 'positions')
        const unsub = onSnapshot(posRef, (snap) => {
          const positions = snap.docs.map((d) => ({ userId: d.id, ...d.data() }) as Position)
          allPositions.value = { ...allPositions.value, [betId]: positions }
        })
        positionUnsubs.set(betId, unsub)
      }
    }
  }

  function listenToBets() {
    const marketStore = useMarketStore()
    if (!marketStore.market) return

    cleanup()
    loading.value = true

    const betsRef = collection(db, 'markets', marketStore.market.id, 'bets')
    const q = query(betsRef, orderBy('createdAt', 'desc'))

    unsubBets = onSnapshot(q, (snap) => {
      bets.value = snap.docs.map((d) => ({ id: d.id, ...d.data() }) as Bet)
      loading.value = false
      syncPositionListeners()
    })
  }

  async function createBet(data: {
    question: string
    type: 'binary' | 'multiple_choice'
    outcomes: string[]
    excludedMembers: string[]
    closesAt: string
  }) {
    const marketStore = useMarketStore()
    if (!marketStore.market) throw new Error('No market')

    error.value = ''
    try {
      const fn = httpsCallable<
        {
          marketId: string
          question: string
          type: string
          outcomes: string[]
          excludedMembers: string[]
          closesAt: string
          database: string
        },
        { betId: string }
      >(functions, 'createBet')

      const result = await fn({
        marketId: marketStore.market.id,
        ...data,
        database: dbName,
      })
      return result.data.betId
    } catch (e: unknown) {
      error.value = e instanceof Error ? e.message : 'Failed to create bet'
      throw e
    }
  }

  function listenToBet(betId: string) {
    const marketStore = useMarketStore()
    const authStore = useAuthStore()
    if (!marketStore.market || !authStore.user) return

    const mid = marketStore.market.id
    const uid = authStore.user.uid

    // Listen to user's position
    unsubPosition?.()
    unsubPosition = onSnapshot(doc(db, 'markets', mid, 'bets', betId, 'positions', uid), (snap) => {
      currentPosition.value = snap.exists()
        ? ({ userId: snap.id, ...snap.data() } as Position)
        : null
    })

    // Listen to recent trades
    unsubTrades?.()
    const tradesRef = collection(db, 'markets', mid, 'bets', betId, 'trades')
    const tradesQuery = query(tradesRef, orderBy('createdAt', 'desc'))
    unsubTrades = onSnapshot(tradesQuery, (snap) => {
      trades.value = snap.docs.map((d) => ({ id: d.id, ...d.data() }) as Trade)
    })
  }

  function stopListeningToBet() {
    unsubPosition?.()
    unsubTrades?.()
    unsubPosition = null
    unsubTrades = null
    currentPosition.value = null
    trades.value = []
  }

  async function executeTrade(data: { betId: string; outcomeIndex: number; shares: number }) {
    const marketStore = useMarketStore()
    if (!marketStore.market) throw new Error('No market')

    error.value = ''
    try {
      const fn = httpsCallable<
        { marketId: string; betId: string; outcomeIndex: number; shares: number; database: string },
        { tradeId: string; cost: number; newBalance: number; priceAfter: number[] }
      >(functions, 'executeTrade')

      const result = await fn({
        marketId: marketStore.market.id,
        ...data,
        database: dbName,
      })
      return result.data
    } catch (e: unknown) {
      error.value = e instanceof Error ? e.message : 'Trade failed'
      throw e
    }
  }

  function cleanup() {
    unsubBets?.()
    unsubPosition?.()
    unsubTrades?.()
    for (const unsub of positionUnsubs.values()) unsub()
    positionUnsubs.clear()
    unsubBets = null
    unsubPosition = null
    unsubTrades = null
    bets.value = []
    currentPosition.value = null
    trades.value = []
    allPositions.value = {}
  }

  async function resolveBet(betId: string, outcomeIndex: number) {
    const marketStore = useMarketStore()
    if (!marketStore.market) throw new Error('No market')

    error.value = ''
    try {
      const fn = httpsCallable<
        { marketId: string; betId: string; outcomeIndex: number; database: string },
        { success: boolean }
      >(functions, 'resolveBet')

      await fn({
        marketId: marketStore.market.id,
        betId,
        outcomeIndex,
        database: dbName,
      })
    } catch (e: unknown) {
      error.value = e instanceof Error ? e.message : 'Failed to resolve bet'
      throw e
    }
  }

  async function cancelBet(betId: string) {
    const marketStore = useMarketStore()
    if (!marketStore.market) throw new Error('No market')

    error.value = ''
    try {
      const fn = httpsCallable<
        { marketId: string; betId: string; database: string },
        { success: boolean }
      >(functions, 'cancelBet')

      await fn({
        marketId: marketStore.market.id,
        betId,
        database: dbName,
      })
    } catch (e: unknown) {
      error.value = e instanceof Error ? e.message : 'Failed to cancel bet'
      throw e
    }
  }

  return {
    bets,
    currentPosition,
    trades,
    loading,
    error,
    openBets,
    closedBets,
    memberShares,
    getPrices,
    listenToBets,
    listenToBet,
    stopListeningToBet,
    createBet,
    executeTrade,
    resolveBet,
    cancelBet,
    cleanup,
  }
})
