import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { doc, collection, onSnapshot, getDocs } from 'firebase/firestore'
import { db } from '@/firebase'
import { useMarketStore } from '@/stores/market'
import { useAuthStore } from '@/stores/auth'
import type { UserStats } from '@/types'

export const useStatsStore = defineStore('stats', () => {
  const myStats = ref<UserStats | null>(null)
  const allMemberStats = ref<Record<string, UserStats>>({})
  const loading = ref(false)
  const allStatsLoading = ref(false)

  let unsubMyStats: (() => void) | null = null

  function listenToStats(userId?: string) {
    cleanup()
    const marketStore = useMarketStore()
    const authStore = useAuthStore()
    if (!marketStore.market) return
    const uid = userId || authStore.user?.uid
    if (!uid) return

    loading.value = true
    const statsRef = doc(db, 'markets', marketStore.market.id, 'stats', uid)

    unsubMyStats = onSnapshot(statsRef, (snap) => {
      myStats.value = snap.exists() ? (snap.data() as UserStats) : null
      loading.value = false
    })
  }

  async function loadAllStats() {
    const marketStore = useMarketStore()
    if (!marketStore.market) return

    allStatsLoading.value = true
    allMemberStats.value = {}
    try {
      const statsCol = collection(db, 'markets', marketStore.market.id, 'stats')
      const snap = await getDocs(statsCol)
      const result: Record<string, UserStats> = {}
      for (const d of snap.docs) {
        result[d.id] = d.data() as UserStats
      }
      allMemberStats.value = result
    } finally {
      allStatsLoading.value = false
    }
  }

  const cumulativePnL = computed(() => {
    if (!myStats.value?.resolvedBets.length) return []
    let running = 0
    const result = [0]
    for (const r of myStats.value.resolvedBets) {
      running += r.profit
      result.push(running)
    }
    return result
  })

  /** For each resolved-bet timestamp, compute rank of each member by balanceAfter */
  const leaderboardRankHistory = computed(() => {
    const allStats = allMemberStats.value
    const userIds = Object.keys(allStats)
    if (userIds.length === 0)
      return { labels: [] as string[], ranks: {} as Record<string, number[]> }

    // Collect all unique resolution timestamps across all users, sorted chronologically

    // Build a timeline: for each user, walk their resolvedBets and record balanceAfter at each step
    // We'll merge these into a unified timeline
    const userTimelines = new Map<string, { ts: number; balance: number }[]>()
    for (const [uid, stats] of Object.entries(allStats)) {
      userTimelines.set(
        uid,
        stats.resolvedBets.map((r) => ({
          ts:
            typeof r.resolvedAt === 'number'
              ? r.resolvedAt
              : (r.resolvedAt as { seconds: number }).seconds * 1000,
          balance: r.balanceAfter,
        })),
      )
    }

    // Merge all timestamps and sort
    const allTimestamps = new Set<number>()
    for (const timeline of userTimelines.values()) {
      for (const pt of timeline) allTimestamps.add(pt.ts)
    }
    const sortedTs = [...allTimestamps].sort((a, b) => a - b)

    // At each timestamp, get latest known balance per user, then rank
    const lastKnown = new Map<string, number>()
    const ranks: Record<string, number[]> = {}
    for (const uid of userIds) ranks[uid] = []
    const labels: string[] = []

    for (const ts of sortedTs) {
      // Update lastKnown for any user who has a record at this timestamp
      for (const [uid, timeline] of userTimelines) {
        const pt = timeline.find((p) => p.ts === ts)
        if (pt) lastKnown.set(uid, pt.balance)
      }

      // Rank users by balance (descending)
      const entries = userIds
        .filter((uid) => lastKnown.has(uid))
        .map((uid) => ({ uid, balance: lastKnown.get(uid)! }))
        .sort((a, b) => b.balance - a.balance)

      const rankMap = new Map<string, number>()
      entries.forEach((e, i) => rankMap.set(e.uid, i + 1))

      for (const uid of userIds) {
        ranks[uid]!.push(rankMap.get(uid) ?? userIds.length)
      }

      const d = new Date(ts)
      labels.push(`${d.getMonth() + 1}/${d.getDate()}`)
    }

    return { labels, ranks }
  })

  function cleanup() {
    if (unsubMyStats) {
      unsubMyStats()
      unsubMyStats = null
    }
    myStats.value = null
    allMemberStats.value = {}
  }

  return {
    myStats,
    allMemberStats,
    loading,
    allStatsLoading,
    listenToStats,
    loadAllStats,
    cumulativePnL,
    leaderboardRankHistory,
    cleanup,
  }
})
