import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { collection, doc, onSnapshot, orderBy, query } from 'firebase/firestore'
import { getFunctions, httpsCallable } from 'firebase/functions'
import { db, dbName } from '@/firebase'
import { useMarketStore } from '@/stores/market'
import { useAuthStore } from '@/stores/auth'
import { useNotificationsStore } from '@/stores/notifications'
import { calcPrices, calcEffectiveB } from '@/utils/lmsr'
import type { Bet, Position, Trade } from '@/types'

export const useBetsStore = defineStore('bets', () => {
  const bets = ref<Bet[]>([])
  const currentPosition = ref<Position | null>(null)
  const trades = ref<Trade[]>([])
  const loading = ref(false)
  const positionsReady = ref(false)
  const error = ref('')

  const functions = getFunctions()
  let unsubBets: (() => void) | null = null
  let unsubPosition: (() => void) | null = null
  let unsubTrades: (() => void) | null = null
  const allPositions = ref<Record<string, Position[]>>({})
  const positionUnsubs = new Map<string, () => void>()

  // Notification diff tracking
  const previousBetsMap = new Map<string, Bet>()
  let isFirstSnapshot = true
  const selfActedBetIds = new Set<string>()

  // Resolution-needed tracking
  const resolutionNotifiedIds = new Set<string>()
  let resolutionCheckInterval: ReturnType<typeof setInterval> | null = null

  const openBets = computed(() => bets.value.filter((m) => m.status === 'open'))
  const closedBets = computed(() => bets.value.filter((m) => m.status !== 'open'))

  const memberShares = computed(() => {
    const activeBetIds = new Set(
      bets.value
        .filter((b) => b.status !== 'resolved' && b.status !== 'cancelled')
        .map((b) => b.id),
    )
    const result: Record<string, number> = {}
    for (const [betId, positions] of Object.entries(allPositions.value)) {
      if (!activeBetIds.has(betId)) continue
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

    const activeIds = new Set(bets.value.map((b) => b.id))

    for (const [betId, unsub] of positionUnsubs) {
      if (!activeIds.has(betId)) {
        unsub()
        positionUnsubs.delete(betId)
        const { [betId]: _, ...rest } = allPositions.value
        allPositions.value = rest
      }
    }

    const newBetIds: string[] = []
    for (const betId of activeIds) {
      if (!positionUnsubs.has(betId)) {
        newBetIds.push(betId)
      }
    }

    if (newBetIds.length > 0) {
      positionsReady.value = false
      let pending = newBetIds.length
      for (const betId of newBetIds) {
        let firstSnapshot = true
        const posRef = collection(db, 'markets', mid, 'bets', betId, 'positions')
        const unsub = onSnapshot(posRef, (snap) => {
          const positions = snap.docs.map((d) => ({ userId: d.id, ...d.data() }) as Position)
          allPositions.value = { ...allPositions.value, [betId]: positions }
          if (firstSnapshot) {
            firstSnapshot = false
            pending--
            if (pending === 0) positionsReady.value = true
          }
        })
        positionUnsubs.set(betId, unsub)
      }
    } else {
      positionsReady.value = true
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
      const newBets = snap.docs.map((d) => ({ id: d.id, ...d.data() }) as Bet)
      bets.value = newBets
      loading.value = false
      syncPositionListeners()

      if (isFirstSnapshot) {
        // Populate the map on first load — no notifications
        for (const bet of newBets) previousBetsMap.set(bet.id, bet)
        isFirstSnapshot = false
        startResolutionCheckTimer()
        return
      }

      processSnapshotDiff(newBets)
    })
  }

  function processSnapshotDiff(newBets: Bet[]) {
    const authStore = useAuthStore()
    const marketStore = useMarketStore()
    const notificationsStore = useNotificationsStore()
    const uid = authStore.user?.uid
    if (!uid) return

    for (const bet of newBets) {
      const prev = previousBetsMap.get(bet.id)

      if (!prev) {
        // New bet — notify everyone except creator
        if (bet.createdBy !== uid && !selfActedBetIds.has(bet.id)) {
          const creatorName =
            marketStore.members.find((m) => m.userId === bet.createdBy)?.displayName ?? 'Someone'
          const timeLeft = formatTimeRemaining(bet.closesAt.toDate().getTime() - Date.now())
          notificationsStore.push({
            type: 'bet_created',
            betId: bet.id,
            title: `${creatorName} created a bet`,
            body: `${bet.question}${timeLeft ? ` · ${timeLeft}` : ''}`,
          })
        }
      } else if (prev.status !== bet.status) {
        // Status changed
        if (
          bet.status === 'resolved' &&
          bet.resolvedOutcome !== null &&
          !selfActedBetIds.has(bet.id)
        ) {
          // Check if user has a stake
          const positions = allPositions.value[bet.id]
          const myPos = positions?.find((p) => p.userId === uid)
          if (myPos && myPos.totalCost > 0) {
            const payout = myPos.shares[bet.resolvedOutcome] ?? 0
            const profit = payout - myPos.totalCost
            const profitStr = `${profit >= 0 ? '+' : ''}$${profit.toFixed(2)}`
            notificationsStore.push({
              type: 'bet_resolved',
              betId: bet.id,
              title: `Resolved: "${bet.outcomes[bet.resolvedOutcome]}" won!`,
              body: `Cost: $${myPos.totalCost.toFixed(2)} · Payout: $${payout.toFixed(2)} · Profit: ${profitStr}`,
            })
          }
        } else if (bet.status === 'cancelled' && !selfActedBetIds.has(bet.id)) {
          const positions = allPositions.value[bet.id]
          const myPos = positions?.find((p) => p.userId === uid)
          if (myPos && myPos.totalCost > 0) {
            notificationsStore.push({
              type: 'bet_cancelled',
              betId: bet.id,
              title: `Bet cancelled`,
              body: `"${bet.question}" · Refunded: $${myPos.totalCost.toFixed(2)}`,
            })
          }
        }
      }

      previousBetsMap.set(bet.id, bet)
    }

    selfActedBetIds.clear()
  }

  function formatTimeRemaining(diffMs: number): string {
    if (diffMs <= 0) return ''
    const days = Math.floor(diffMs / 86400000)
    const hours = Math.floor((diffMs % 86400000) / 3600000)
    const minutes = Math.floor((diffMs % 3600000) / 60000)
    if (days > 0) return `${days}d ${hours}h left`
    if (hours > 0) return `${hours}h ${minutes}m left`
    return `${minutes}m left`
  }

  function checkResolutionNeeded() {
    const authStore = useAuthStore()
    const notificationsStore = useNotificationsStore()
    const uid = authStore.user?.uid
    if (!uid) return

    const now = Date.now()
    for (const bet of bets.value) {
      if (
        bet.createdBy === uid &&
        (bet.status === 'open' || bet.status === 'closed') &&
        bet.closesAt.toDate().getTime() <= now &&
        !resolutionNotifiedIds.has(bet.id)
      ) {
        resolutionNotifiedIds.add(bet.id)
        notificationsStore.push({
          type: 'resolution_needed',
          betId: bet.id,
          title: 'Betting closed',
          body: `"${bet.question}" needs resolution`,
        })
      }
    }
  }

  function startResolutionCheckTimer() {
    checkResolutionNeeded()
    resolutionCheckInterval = setInterval(checkResolutionNeeded, 60000)
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
      selfActedBetIds.add(result.data.betId)
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
    previousBetsMap.clear()
    isFirstSnapshot = true
    selfActedBetIds.clear()
    resolutionNotifiedIds.clear()
    if (resolutionCheckInterval) {
      clearInterval(resolutionCheckInterval)
      resolutionCheckInterval = null
    }
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

      selfActedBetIds.add(betId)
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

      selfActedBetIds.add(betId)
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

  async function editBet(
    betId: string,
    data: {
      question?: string
      outcomes?: string[]
      excludedMembers?: string[]
      closesAt?: string
    },
  ) {
    const marketStore = useMarketStore()
    if (!marketStore.market) throw new Error('No market')

    error.value = ''
    try {
      const fn = httpsCallable<
        {
          marketId: string
          betId: string
          question?: string
          outcomes?: string[]
          excludedMembers?: string[]
          closesAt?: string
          database: string
        },
        { success: boolean }
      >(functions, 'editBet')

      await fn({
        marketId: marketStore.market.id,
        betId,
        ...data,
        database: dbName,
      })
    } catch (e: unknown) {
      error.value = e instanceof Error ? e.message : 'Failed to edit bet'
      throw e
    }
  }

  return {
    bets,
    currentPosition,
    trades,
    loading,
    positionsReady,
    error,
    openBets,
    closedBets,
    memberShares,
    allPositions,
    getPrices,
    listenToBets,
    listenToBet,
    stopListeningToBet,
    createBet,
    executeTrade,
    resolveBet,
    cancelBet,
    editBet,
    cleanup,
  }
})
