import { computed } from 'vue'
import { useBetsStore } from '@/stores/bets'
import { useAuthStore } from '@/stores/auth'
import type { Bet } from '@/types'

const FILTERS_KEY = 'betListFilters'
const STATUS_VALUES = ['open', 'closed', 'resolved', 'cancelled']

function effectiveStatus(bet: Bet): string {
  if (bet.status !== 'open') return bet.status
  if (bet.closesAt.toDate().getTime() <= Date.now()) return 'closed'
  return 'open'
}

/**
 * Returns the sorted+filtered bet list matching the persisted BetListView filters.
 * Accepts an optional search query for the list view; detail view can omit it.
 */
export function useFilteredBets(searchQuery?: () => string) {
  const betsStore = useBetsStore()
  const authStore = useAuthStore()

  function getFilters(): string[] {
    try {
      const raw = localStorage.getItem(FILTERS_KEY)
      return raw ? JSON.parse(raw) : ['open', '!stake']
    } catch {
      return ['open', '!stake']
    }
  }

  function filterState(filters: string[], value: string): 'off' | 'include' | 'exclude' {
    if (filters.includes(value)) return 'include'
    if (filters.includes(`!${value}`)) return 'exclude'
    return 'off'
  }

  function hasStake(bet: Bet): boolean {
    const uid = authStore.user?.uid
    if (!uid) return false
    const positions = betsStore.allPositions[bet.id]
    const myPos = positions?.find((p) => p.userId === uid)
    return !!myPos && myPos.shares.some((s) => s > 0)
  }

  const sortedBets = computed(() => {
    const filters = getFilters()

    const filtered = betsStore.bets.filter((bet) => {
      if (filters.length === 0) return true

      const status = effectiveStatus(bet)

      const statusFilters = filters.filter((f) => STATUS_VALUES.includes(f))
      const hasStatusFilter = statusFilters.length > 0
      const matchesStatus = !hasStatusFilter || statusFilters.includes(status)

      const matchesStake =
        filterState(filters, 'stake') === 'off'
          ? true
          : filterState(filters, 'stake') === 'include'
            ? hasStake(bet)
            : !hasStake(bet)
      const matchesCreator =
        filterState(filters, 'creator') === 'off'
          ? true
          : filterState(filters, 'creator') === 'include'
            ? bet.createdBy === authStore.user?.uid
            : bet.createdBy !== authStore.user?.uid
      const matchesComments =
        filterState(filters, 'comments') === 'off'
          ? true
          : filterState(filters, 'comments') === 'include'
            ? (bet.commentCount ?? 0) > 0
            : (bet.commentCount ?? 0) === 0

      const q = searchQuery ? searchQuery().trim().toLowerCase() : ''
      const matchesSearch = !q || bet.question.toLowerCase().includes(q)

      return matchesStatus && matchesStake && matchesCreator && matchesComments && matchesSearch
    })

    return [...filtered].sort((a, b) => {
      const aOpen = effectiveStatus(a) === 'open' ? 0 : 1
      const bOpen = effectiveStatus(b) === 'open' ? 0 : 1
      if (aOpen !== bOpen) return aOpen - bOpen

      return (
        a.closesAt.toMillis() - b.closesAt.toMillis() ||
        b.createdAt.toMillis() - a.createdAt.toMillis()
      )
    })
  })

  return { sortedBets, effectiveStatus }
}
