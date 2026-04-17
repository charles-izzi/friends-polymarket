<script setup lang="ts">
import { useMarketStore } from '@/stores/market'
import { useBetsStore } from '@/stores/bets'
import { useStatsStore } from '@/stores/stats'
import { useAuthStore } from '@/stores/auth'
import { useRouter } from 'vue-router'
import { computed, ref, watch, onMounted, onUnmounted } from 'vue'
import type { Bet } from '@/types'
import SvgLineChart from '@/components/SvgLineChart.vue'
import type { ChartSeries } from '@/components/SvgLineChart.vue'

const marketStore = useMarketStore()
const betsStore = useBetsStore()
const statsStore = useStatsStore()
const authStore = useAuthStore()
const router = useRouter()

const leaderboardTab = ref('current')

const now = ref(Date.now())
let nowInterval: ReturnType<typeof setInterval> | null = null

function refreshMarketData() {
  betsStore.listenToBets()
  statsStore.loadAllStats()
}

onMounted(() => {
  refreshMarketData()
  nowInterval = setInterval(() => (now.value = Date.now()), 30_000)
})

onUnmounted(() => {
  if (nowInterval) clearInterval(nowInterval)
})

// Re-fetch when the active market changes (e.g. switching via sidebar)
watch(() => marketStore.market?.id, (newId, oldId) => {
  if (newId && newId !== oldId) refreshMarketData()
})

function effectiveStatus(bet: Bet): Bet['status'] {
  if (bet.status !== 'open') return bet.status
  if (bet.closesAt.toDate().getTime() <= now.value) return 'closed'
  return 'open'
}

const copied = ref(false)
const inviteUrl = computed(() => {
  const code = marketStore.market?.inviteCode ?? ''
  return `${window.location.origin}/invite/${code}`
})

const topBets = computed(() =>
  [...betsStore.bets]
    .filter((b) => effectiveStatus(b) === 'open')
    .sort((a, b) => (b.totalVolume ?? 0) - (a.totalVolume ?? 0))
    .slice(0, 3),
)

async function copyInviteLink() {
  await navigator.clipboard.writeText(inviteUrl.value)
  copied.value = true
  setTimeout(() => (copied.value = false), 2000)
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

const memberPnL = computed(() => {
  const map: Record<string, number> = {}
  for (const [uid, s] of Object.entries(statsStore.allMemberStats)) {
    map[uid] = s.totalProfit
  }
  return map
})

const sortedMembers = computed(() =>
  [...marketStore.members].sort(
    (a, b) =>
      (memberPnL.value[b.userId] ?? 0) - (memberPnL.value[a.userId] ?? 0) ||
      a.displayName.localeCompare(b.displayName),
  ),
)

// --- Leaderboard Rank Over Time ---
const MEMBER_COLORS = [
  '#5b8fa8',
  '#c47a6a',
  '#b5944f',
  '#7a9a6d',
  '#9b7db8',
  '#6a8f6d',
  '#7b8fb8',
  '#b85b7d',
  '#5ba8a0',
]

const rankSeries = computed<ChartSeries[]>(() => {
  const { ranks } = statsStore.leaderboardRankHistory
  const members = marketStore.members
  return Object.entries(ranks).map(([uid, data], i) => {
    const member = members.find((m) => m.userId === uid)
    return {
      label: member?.displayName ?? uid.slice(0, 6),
      color:
        uid === authStore.user?.uid ? '#5b8fa8' : MEMBER_COLORS[(i + 1) % MEMBER_COLORS.length]!,
      data,
    }
  })
})

const rankLabels = computed(() => statsStore.leaderboardRankHistory.labels)
const rankYMax = computed(() => marketStore.members.length || 2)
</script>

<template>
  <v-container class="pt-0">
    <div class="d-flex align-center mb-0">
      <h1 class="text-h6 flex-grow-1">{{ marketStore.market?.name }}</h1>
      <v-btn
        :icon="copied ? 'mdi-check' : 'mdi-account-plus'"
        :color="copied ? 'success' : 'primary'"
        variant="text"
        @click="copyInviteLink"
      >
        <v-icon>{{ copied ? 'mdi-check' : 'mdi-account-plus' }}</v-icon>
        <v-tooltip activator="parent" location="bottom">
          {{ copied ? 'Invite link copied!' : 'Copy invite link' }}
        </v-tooltip>
      </v-btn>
    </div>

    <v-card class="mb-6">
      <v-card-title class="d-flex align-center">
        <span class="text-h6 flex-grow-1">Top Bets</span>
        <v-btn
          variant="text"
          color="primary"
          size="small"
          append-icon="mdi-arrow-right"
          @click="router.push(`/${marketStore.market!.id}/bets`)"
        >
          See all
        </v-btn>
      </v-card-title>

      <v-card-text v-if="betsStore.loading" class="text-center py-4">
        <v-progress-circular indeterminate size="24" />
      </v-card-text>

      <v-list v-else-if="topBets.length" lines="two" density="comfortable">
        <template v-for="(bet, idx) in topBets" :key="bet.id">
          <v-divider v-if="idx > 0" />
          <v-list-item
            class="cursor-pointer pr-2"
            @click="router.push(`/${marketStore.market!.id}/bets/${bet.id}`)"
          >
            <v-list-item-title class="text-body-2 font-weight-medium" style="margin-right: 12px">
              {{ bet.question }}
            </v-list-item-title>
            <v-list-item-subtitle class="text-caption" style="margin-right: 12px">
              {{ topOutcome(bet).label }} at {{ topOutcome(bet).pct }}
            </v-list-item-subtitle>
            <template #append>
              <v-chip :color="statusColor(bet)" size="x-small" variant="tonal">
                {{ effectiveStatus(bet) }}
              </v-chip>
            </template>
          </v-list-item>
        </template>
      </v-list>

      <v-card-text v-else class="text-center text-medium-emphasis py-4"> No bets yet </v-card-text>
    </v-card>

    <v-card variant="flat">
      <v-card-title class="text-h6">Leaderboard</v-card-title>
      <v-tabs v-model="leaderboardTab" density="compact">
        <v-tab value="current">Current</v-tab>
        <v-tab value="history">Over Time</v-tab>
      </v-tabs>
      <v-window v-model="leaderboardTab">
        <v-window-item value="current">
          <div
            v-if="statsStore.allStatsLoading && !Object.keys(statsStore.allMemberStats).length"
            class="text-center py-4"
          >
            <v-progress-circular indeterminate size="24" />
          </div>
          <v-list v-else>
            <v-list-item density="compact" class="text-caption text-medium-emphasis">
              <template #prepend>
                <span class="mr-6 ml-3" style="min-width: 16px">#</span>
              </template>
              <span>Player</span>
              <template #append>
                <span class="d-inline-flex align-center">
                  <v-btn icon size="x-small" variant="text" class="mr-1">
                    <v-icon size="14">mdi-information-outline</v-icon>
                    <v-tooltip activator="parent" location="top">
                      Profit or loss across all resolved bets
                    </v-tooltip>
                  </v-btn>
                  P/L
                </span>
              </template>
            </v-list-item>
            <v-divider />
            <v-list-item
              v-for="(member, index) in sortedMembers"
              :key="member.userId"
              :title="member.displayName"
              class="cursor-pointer"
              @click="router.push(`/${marketStore.market!.id}/stats/${member.userId}`)"
            >
              <v-list-item-subtitle>
                <span>
                  {{ member.balance < 0 ? '-' : '' }}${{
                    Math.abs(member.balance).toLocaleString(undefined, {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2,
                    })
                  }}
                </span>
                <span class="text-medium-emphasis mx-1">·</span>
                <span>{{ betsStore.memberShares[member.userId] ?? 0 }} shares</span>
              </v-list-item-subtitle>
              <template #prepend>
                <span class="text-body-2 font-weight-bold mr-6 ml-3">{{ index + 1 }}</span>
              </template>
              <template #append>
                <span
                  class="text-body-2 font-weight-medium"
                  :class="(memberPnL[member.userId] ?? 0) >= 0 ? 'text-success' : 'text-error'"
                >
                  {{ (memberPnL[member.userId] ?? 0) < 0 ? '-' : '' }}${{
                    Math.abs(memberPnL[member.userId] ?? 0).toLocaleString(undefined, {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2,
                    })
                  }}
                </span>
              </template>
            </v-list-item>
          </v-list>
        </v-window-item>
        <v-window-item value="history">
          <div v-if="rankSeries.length > 0 && rankLabels.length >= 2" class="pa-3">
            <SvgLineChart
              :series="rankSeries"
              :labels="rankLabels"
              :y-min="1"
              :y-max="rankYMax"
              :y-format="(v: number) => `#${v.toFixed(0)}`"
              :invert-y="true"
            />
            <div class="d-flex flex-wrap ga-3 mt-2">
              <div v-for="s in rankSeries" :key="s.label" class="d-flex align-center ga-1">
                <div
                  :style="{
                    width: '10px',
                    height: '10px',
                    borderRadius: '2px',
                    backgroundColor: s.color,
                  }"
                />
                <span class="text-caption">{{ s.label }}</span>
              </div>
            </div>
          </div>
          <div v-else class="pa-4 text-center text-medium-emphasis">
            Not enough data yet. Rank history appears after at least 2 bets are resolved.
          </div>
        </v-window-item>
      </v-window>
    </v-card>
  </v-container>
</template>
