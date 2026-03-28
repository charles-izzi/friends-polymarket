import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { collection, doc, onSnapshot, orderBy, query } from 'firebase/firestore'
import { getFunctions, httpsCallable } from 'firebase/functions'
import { db } from '@/firebase'
import { useMarketStore } from '@/stores/market'
import { useAuthStore } from '@/stores/auth'
import { calcPrices } from '@/utils/lmsr'
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

  const openBets = computed(() => bets.value.filter((m) => m.status === 'open'))
  const closedBets = computed(() => bets.value.filter((m) => m.status !== 'open'))

  /** Get LMSR prices for a bet */
  function getPrices(bet: Bet): number[] {
    return calcPrices(bet.sharesSold, bet.liquidityParam)
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
        },
        { betId: string }
      >(functions, 'createBet')

      const result = await fn({
        marketId: marketStore.market.id,
        ...data,
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
        { marketId: string; betId: string; outcomeIndex: number; shares: number },
        { tradeId: string; cost: number; newBalance: number; priceAfter: number[] }
      >(functions, 'executeTrade')

      const result = await fn({
        marketId: marketStore.market.id,
        ...data,
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
    unsubBets = null
    unsubPosition = null
    unsubTrades = null
    bets.value = []
    currentPosition.value = null
    trades.value = []
  }

  async function resolveBet(betId: string, outcomeIndex: number) {
    const marketStore = useMarketStore()
    if (!marketStore.market) throw new Error('No market')

    error.value = ''
    try {
      const fn = httpsCallable<
        { marketId: string; betId: string; outcomeIndex: number },
        { success: boolean }
      >(functions, 'resolveBet')

      await fn({
        marketId: marketStore.market.id,
        betId,
        outcomeIndex,
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
      const fn = httpsCallable<{ marketId: string; betId: string }, { success: boolean }>(
        functions,
        'cancelBet',
      )

      await fn({
        marketId: marketStore.market.id,
        betId,
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
