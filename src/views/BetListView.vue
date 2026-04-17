<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useSmartBack } from '@/composables/useSmartBack'
import { useBetsStore } from '@/stores/bets'
import { useMarketStore } from '@/stores/market'
import { useAuthStore } from '@/stores/auth'
import { useCommentsStore } from '@/stores/comments'
import type { Bet } from '@/types'

const router = useRouter()
const betsStore = useBetsStore()
const marketStore = useMarketStore()
const authStore = useAuthStore()
const commentsStore = useCommentsStore()
const { goBack } = useSmartBack(`/${marketStore.market?.id ?? ''}`)

const OUTCOME_COLORS = [
  '#5b8fa8',
  '#c47a6a',
  '#b5944f',
  '#7a9a6d',
  '#9b7db8',
  '#6a8f6d',
  '#a87b5b',
  '#7b8fb8',
  '#b85b7d',
  '#5ba8a0',
]

onMounted(() => {
  betsStore.listenToBets()
})

function getPriceLabel(bet: Bet, index: number): string {
  const prices = betsStore.getPrices(bet)
  return `${((prices[index] ?? 0) * 100).toFixed(0)}%`
}

function topOutcome(bet: Bet): { label: string; pct: string } {
  const prices = betsStore.getPrices(bet)
  let maxIdx = 0
  for (let i = 1; i < prices.length; i++) {
    if ((prices[i] ?? 0) > (prices[maxIdx] ?? 0)) maxIdx = i
  }
  return {
    label: bet.outcomes[maxIdx] ?? '',
    pct: `${((prices[maxIdx] ?? 0) * 100).toFixed(0)}%`,
  }
}

function effectiveStatus(bet: Bet): string {
  if (bet.status !== 'open') return bet.status
  if (bet.closesAt.toDate().getTime() <= Date.now()) return 'closed'
  return 'open'
}

function timeRemaining(bet: Bet): string {
  if (effectiveStatus(bet) !== 'open') return ''
  const diff = bet.closesAt.toDate().getTime() - Date.now()
  if (diff <= 0) return ''
  const years = Math.floor(diff / 31536000000)
  const months = Math.floor((diff % 31536000000) / 2592000000)
  const days = Math.floor((diff % 2592000000) / 86400000)
  const hours = Math.floor((diff % 86400000) / 3600000)
  const minutes = Math.floor((diff % 3600000) / 60000)
  const parts: string[] = []
  if (years > 0) parts.push(`${years}y`)
  if (months > 0) parts.push(`${months}mo`)
  if (days > 0) parts.push(`${days}d`)
  if (hours > 0) parts.push(`${hours}h`)
  if (minutes > 0) parts.push(`${minutes}m`)
  return parts.length > 0 ? `${parts.slice(0, 2).join(' ')} left` : ''
}

function statusColor(bet: Bet): string {
  switch (effectiveStatus(bet)) {
    case 'open':
      return 'success'
    case 'closed':
      return 'warning'
    case 'resolved':
      return 'info'
    case 'cancelled':
      return 'error'
    default:
      return 'default'
  }
}

function hasStake(bet: Bet): boolean {
  const uid = authStore.user?.uid
  if (!uid) return false
  const positions = betsStore.allPositions[bet.id]
  const myPos = positions?.find((p) => p.userId === uid)
  return !!myPos && myPos.shares.some((s) => s > 0)
}

const searchQuery = ref('')

const FILTERS_KEY = 'betListFilters'
const savedFilters = localStorage.getItem(FILTERS_KEY)
const filters = ref<string[]>(savedFilters ? JSON.parse(savedFilters) : ['open', '!stake'])

const TRISTATE_FILTERS = ['stake', 'creator', 'comments']
const STATUS_VALUES = ['open', 'closed', 'resolved', 'cancelled']

function filterState(value: string): 'off' | 'include' | 'exclude' {
  if (filters.value.includes(value)) return 'include'
  if (filters.value.includes(`!${value}`)) return 'exclude'
  return 'off'
}

function toggleFilter(value: string) {
  if (TRISTATE_FILTERS.includes(value)) {
    const state = filterState(value)
    const cleaned = filters.value.filter((f) => f !== value && f !== `!${value}`)
    if (state === 'off') {
      filters.value = [...cleaned, value]
    } else if (state === 'include') {
      filters.value = [...cleaned, `!${value}`]
    } else {
      filters.value = cleaned
    }
  } else if (STATUS_VALUES.includes(value)) {
    const otherFilters = filters.value.filter((f) => !STATUS_VALUES.includes(f))
    if (filters.value.includes(value)) {
      filters.value = otherFilters
    } else {
      filters.value = [...otherFilters, value]
    }
  }
  localStorage.setItem(FILTERS_KEY, JSON.stringify(filters.value))
}

const filteredBets = computed(() => {
  return betsStore.bets.filter((bet) => {
    const active = filters.value
    if (active.length === 0) return true

    const status = effectiveStatus(bet)

    const statusFilters = active.filter((f) =>
      ['open', 'closed', 'resolved', 'cancelled'].includes(f),
    )
    const hasStatusFilter = statusFilters.length > 0
    const matchesStatus = !hasStatusFilter || statusFilters.includes(status)

    const matchesStake =
      filterState('stake') === 'off'
        ? true
        : filterState('stake') === 'include'
          ? hasStake(bet)
          : !hasStake(bet)
    const matchesCreator =
      filterState('creator') === 'off'
        ? true
        : filterState('creator') === 'include'
          ? bet.createdBy === authStore.user?.uid
          : bet.createdBy !== authStore.user?.uid
    const matchesComments =
      filterState('comments') === 'off'
        ? true
        : filterState('comments') === 'include'
          ? (bet.commentCount ?? 0) > 0
          : (bet.commentCount ?? 0) === 0

    const q = (searchQuery.value ?? '').trim().toLowerCase()
    const matchesSearch = !q || bet.question.toLowerCase().includes(q)

    return matchesStatus && matchesStake && matchesCreator && matchesComments && matchesSearch
  })
})

const sortedBets = computed(() => {
  return [...filteredBets.value].sort((a, b) => {
    const aOpen = effectiveStatus(a) === 'open' ? 0 : 1
    const bOpen = effectiveStatus(b) === 'open' ? 0 : 1
    if (aOpen !== bOpen) return aOpen - bOpen

    return (
      a.closesAt.toMillis() - b.closesAt.toMillis() ||
      b.createdAt.toMillis() - a.createdAt.toMillis()
    )
  })
})
</script>

<template>
  <v-container class="pt-0">
    <div class="d-flex align-center justify-space-between mb-0">
      <div class="d-flex align-center ga-2">
        <v-btn icon="mdi-arrow-left" variant="text" @click="goBack()" />
        <h1 class="text-h6">Bets</h1>
      </div>
      <v-btn
        color="primary"
        prepend-icon="mdi-plus"
        @click="router.push(`/${marketStore.market!.id}/bets/create`)"
      >
        New Bet
      </v-btn>
    </div>

    <div v-if="betsStore.bets.length > 5" class="d-flex flex-wrap align-center ga-2 my-2">
      <v-text-field
        v-model="searchQuery"
        placeholder="Search"
        prepend-inner-icon="mdi-magnify"
        density="compact"
        variant="outlined"
        hide-details
        clearable
        style="min-width: 150px; max-width: 150px"
        rounded="pill"
      />
      <v-chip
        v-for="filter in [
          { value: 'stake', label: 'My Stakes', icon: 'mdi-circle-multiple' },
          { value: 'creator', label: 'Created by Me', icon: 'mdi-gavel' },
          { value: 'comments', label: 'Has Comments', icon: 'mdi-message-text' },
        ]"
        :key="filter.value"
        :prepend-icon="filter.icon"
        :variant="filterState(filter.value) !== 'off' ? 'flat' : 'outlined'"
        :color="
          filterState(filter.value) === 'include'
            ? 'success'
            : filterState(filter.value) === 'exclude'
              ? 'error'
              : undefined
        "
        size="small"
        @click="toggleFilter(filter.value)"
      >
        {{ filter.label }}
      </v-chip>
      <div class="status-filter-group d-flex align-center ga-1 px-2 py-1">
        <span class="status-filter-label">Status</span>
        <v-chip
          v-for="filter in [
            { value: 'open', label: 'Open', icon: 'mdi-lock-open-variant-outline' },
            { value: 'closed', label: 'Closed', icon: 'mdi-lock-outline' },
            { value: 'resolved', label: 'Resolved', icon: 'mdi-check-circle-outline' },
            { value: 'cancelled', label: 'Cancelled', icon: 'mdi-cancel' },
          ]"
          :key="filter.value"
          :prepend-icon="filter.icon"
          :variant="filters.includes(filter.value) ? 'flat' : 'outlined'"
          :color="filters.includes(filter.value) ? 'primary' : undefined"
          size="small"
          @click="toggleFilter(filter.value)"
        >
          {{ filter.label }}
        </v-chip>
      </div>
    </div>

    <v-progress-linear
      v-if="betsStore.loading || !betsStore.positionsReady"
      indeterminate
      class="mb-4"
    />

    <div
      v-if="!betsStore.loading && betsStore.bets.length === 0 && betsStore.positionsReady"
      class="text-center py-8"
    >
      <v-icon icon="mdi-chart-line" size="64" color="grey-lighten-1" class="mb-4" />
      <p class="text-h6 text-medium-emphasis">No bets yet</p>
      <p class="text-body-2 text-medium-emphasis mb-4">Create the first one!</p>
      <v-btn color="primary" @click="router.push(`/${marketStore.market!.id}/bets/create`)"
        >Create a Bet</v-btn
      >
    </div>

    <template v-if="betsStore.positionsReady">
      <v-card
        v-for="bet in sortedBets"
        :key="bet.id"
        class="mb-3 cursor-pointer"
        variant="outlined"
        hover
        @click="router.push(`/${marketStore.market!.id}/bets/${bet.id}`)"
      >
        <v-card-text>
          <div class="d-flex align-center ga-4 mb-2">
            <div class="flex-grow-1">
              <p class="text-subtitle-1 font-weight-medium">{{ bet.question }}</p>
            </div>
            <div class="d-flex flex-column align-end justify-center ga-1 flex-shrink-0">
              <v-chip :color="statusColor(bet)" size="small" variant="tonal">
                {{ effectiveStatus(bet) }}
              </v-chip>
              <span class="text-caption text-medium-emphasis">
                <template v-if="effectiveStatus(bet) === 'open'">{{ timeRemaining(bet) }}</template>
                <template
                  v-else-if="effectiveStatus(bet) === 'resolved' && bet.resolvedOutcome !== null"
                >
                  Winner: {{ bet.outcomes[bet.resolvedOutcome] }}
                </template>
                <template v-else-if="effectiveStatus(bet) === 'cancelled'">Refunded</template>
                <template
                  v-else-if="
                    effectiveStatus(bet) === 'closed' && bet.createdBy === authStore.user?.uid
                  "
                >
                  <v-icon icon="mdi-alert-circle" size="x-small" color="warning" class="mr-1" />
                  Needs resolution
                </template>
              </span>
            </div>
          </div>

          <div
            :style="{
              height: '20px',
              borderRadius: '4px',
              overflow: 'hidden',
              display: 'flex',
            }"
          >
            <div
              v-for="(outcome, i) in bet.outcomes"
              :key="i"
              :style="{
                width: (betsStore.getPrices(bet)[i] ?? 0) * 100 + '%',
                backgroundColor: OUTCOME_COLORS[i % OUTCOME_COLORS.length],
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }"
            >
              <span
                v-if="(betsStore.getPrices(bet)[i] ?? 0) >= 0.1"
                class="text-caption font-weight-bold"
                style="color: white; text-shadow: 0 1px 2px rgba(0, 0, 0, 0.4); font-size: 11px"
              >
                {{ getPriceLabel(bet, i) }}
              </span>
            </div>
          </div>
          <div class="d-flex align-center mt-1">
            <div class="d-flex flex-wrap ga-2 flex-grow-1">
              <div v-for="(outcome, i) in bet.outcomes" :key="i" class="d-flex align-center ga-1">
                <div
                  :style="{
                    width: '10px',
                    height: '10px',
                    borderRadius: '2px',
                    backgroundColor: OUTCOME_COLORS[i % OUTCOME_COLORS.length],
                  }"
                />
                <span class="text-caption">{{ outcome }}</span>
              </div>
            </div>
            <v-tooltip
              v-if="bet.createdBy === authStore.user?.uid"
              text="You created this bet"
              location="top"
            >
              <template #activator="{ props }">
                <v-icon
                  v-bind="props"
                  icon="mdi-gavel"
                  size="small"
                  color="info"
                  class="ml-2 mt-1"
                  @click.stop
                />
              </template>
            </v-tooltip>
            <v-tooltip v-if="hasStake(bet)" text="You have a stake in this bet" location="top">
              <template #activator="{ props }">
                <v-icon
                  v-bind="props"
                  icon="mdi-circle-multiple"
                  size="small"
                  color="warning"
                  class="ml-2 mt-1"
                  @click.stop
                />
              </template>
            </v-tooltip>
            <v-tooltip v-if="(bet.commentCount ?? 0) > 0" text="Has comments" location="top">
              <template #activator="{ props }">
                <v-badge
                  v-if="commentsStore.isUnseen(bet.id)"
                  dot
                  color="error"
                  offset-x="-2"
                  offset-y="-2"
                >
                  <v-icon
                    v-bind="props"
                    icon="mdi-message-text"
                    size="small"
                    color="secondary"
                    class="ml-2 mt-1"
                    @click.stop
                  />
                </v-badge>
                <v-icon
                  v-else
                  v-bind="props"
                  icon="mdi-message-text"
                  size="small"
                  color="secondary"
                  class="ml-2 mt-1"
                  @click.stop
                />
              </template>
            </v-tooltip>
          </div>
        </v-card-text>
      </v-card>
    </template>
  </v-container>
</template>

<style scoped>
.status-filter-group {
  border: thin solid rgba(var(--v-theme-on-surface), 0.38);
  border-radius: 8px;
  position: relative;
}

.status-filter-label {
  position: absolute;
  top: -8px;
  left: 8px;
  font-size: 10px;
  line-height: 1;
  padding: 0 4px;
  background: rgb(var(--v-theme-background));
  color: rgba(var(--v-theme-on-surface), 0.6);
}
</style>
