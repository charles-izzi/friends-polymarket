import { computed, ref, watch } from 'vue'
import { useBetsStore } from '@/stores/bets'
import { useAuthStore } from '@/stores/auth'
import type { Bet } from '@/types'

const FILTERS_KEY = 'betListFilters'
const SEARCH_KEY = 'betListSearch'
const STATUS_VALUES = ['open', 'closed', 'resolved', 'cancelled']

const searchQuery = ref(localStorage.getItem(SEARCH_KEY) ?? '')
watch(searchQuery, (v) => {
  localStorage.setItem(SEARCH_KEY, v ?? '')
})

function effectiveStatus(bet: Bet): string {
  if (bet.status !== 'open') return bet.status
  if (bet.closesAt.toDate().getTime() <= Date.now()) return 'closed'
  return 'open'
}

/**
 * Returns the sorted+filtered bet list matching the persisted BetListView filters.
 * Search query is persisted in localStorage and shared across views.
 */
export function useFilteredBets() {
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
    const statusFilters = filters.filter((f) => STATUS_VALUES.includes(f))
    const hasStatusFilter = statusFilters.length > 0

    const filtered = betsStore.bets.filter((bet) => {
      const q = (searchQuery.value ?? '').trim().toLowerCase()
      const matchesSearch = !q || bet.question.toLowerCase().includes(q)

      if (filters.length === 0) return matchesSearch

      const status = effectiveStatus(bet)
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
      const matchesExcluded =
        filterState(filters, 'excluded') === 'off'
          ? true
          : filterState(filters, 'excluded') === 'include'
            ? (bet.excludedMembers ?? []).includes(authStore.user?.uid ?? '')
            : !(bet.excludedMembers ?? []).includes(authStore.user?.uid ?? '')

      return (
        matchesStatus &&
        matchesStake &&
        matchesCreator &&
        matchesComments &&
        matchesExcluded &&
        matchesSearch
      )
    })

    const showingPast =
      statusFilters.length > 0 && statusFilters.every((f) => f !== 'open')

    return [...filtered].sort((a, b) => {
      const aOpen = effectiveStatus(a) === 'open' ? 0 : 1
      const bOpen = effectiveStatus(b) === 'open' ? 0 : 1
      if (aOpen !== bOpen) return aOpen - bOpen

      const dir = showingPast ? -1 : 1
      return (
        dir * (a.closesAt.toMillis() - b.closesAt.toMillis()) ||
        b.createdAt.toMillis() - a.createdAt.toMillis()
      )
    })
  })

  return { sortedBets, effectiveStatus, searchQuery }
}
