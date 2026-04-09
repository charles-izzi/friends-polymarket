<script setup lang="ts">
import { onMounted, onUnmounted, computed } from 'vue'
import { useRouter } from 'vue-router'
import { useStatsStore } from '@/stores/stats'
import { useMarketStore } from '@/stores/market'
import { useAuthStore } from '@/stores/auth'
import SvgLineChart from '@/components/SvgLineChart.vue'
import type { ChartSeries } from '@/components/SvgLineChart.vue'

const router = useRouter()
const statsStore = useStatsStore()
const marketStore = useMarketStore()
const authStore = useAuthStore()

onMounted(() => {
  statsStore.listenToMyStats()
  statsStore.loadAllStats()
})

onUnmounted(() => {
  statsStore.cleanup()
})

const stats = computed(() => statsStore.myStats)
const hasData = computed(() => (stats.value?.totalResolved ?? 0) > 0)

// --- Cumulative P&L Chart ---
const pnlSeries = computed<ChartSeries[]>(() => {
  const data = statsStore.cumulativePnL
  if (data.length === 0) return []
  return [{ label: 'P&L', color: '#5b8fa8', data }]
})

const pnlLabels = computed(() => {
  if (!stats.value?.resolvedBets.length) return []
  return stats.value.resolvedBets.map((r) => {
    const ts =
      typeof r.resolvedAt === 'number'
        ? r.resolvedAt
        : (r.resolvedAt as { seconds: number }).seconds * 1000
    const d = new Date(ts)
    return `${d.getMonth() + 1}/${d.getDate()}`
  })
})

const pnlYMin = computed(() => {
  const data = statsStore.cumulativePnL
  if (data.length === 0) return 0
  return Math.min(0, Math.min(...data))
})
const pnlYMax = computed(() => {
  const data = statsStore.cumulativePnL
  if (data.length === 0) return 0
  return Math.max(0, Math.max(...data))
})

// --- Leaderboard Rank Chart ---
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

// --- Formatters ---
function fmtDollars(v: number): string {
  const sign = v < 0 ? '-' : ''
  return `${sign}$${Math.abs(v).toFixed(2)}`
}

function fmtPct(v: number): string {
  return `${(v * 100).toFixed(0)}%`
}
</script>

<template>
  <v-container max-width="700" class="pt-0">
    <div class="d-flex align-center mb-2">
      <v-btn icon="mdi-arrow-left" variant="text" @click="router.push('/')" />
      <h1 class="text-h6 ml-2">My Stats</h1>
    </div>

    <template v-if="statsStore.loading">
      <v-progress-linear indeterminate />
    </template>

    <template v-else-if="!hasData">
      <v-card variant="outlined" class="pa-6 text-center">
        <v-icon icon="mdi-chart-box-outline" size="48" color="medium-emphasis" class="mb-3" />
        <p class="text-body-1 text-medium-emphasis">
          No resolved bets yet. Stats will appear after your first bet resolves.
        </p>
      </v-card>
    </template>

    <template v-else>
      <!-- Cumulative P&L Chart -->
      <v-card variant="outlined" class="mb-4 pa-3">
        <div class="d-flex align-center mb-2">
          <span class="text-subtitle-2 font-weight-medium">Cumulative P&amp;L</span>
          <v-btn icon size="x-small" variant="text" class="ml-1">
            <v-icon size="16">mdi-information-outline</v-icon>
            <v-tooltip activator="parent" location="top">
              Your cumulative profit and loss from resolved bets, starting from $0
            </v-tooltip>
          </v-btn>
        </div>
        <SvgLineChart
          :series="pnlSeries"
          :labels="pnlLabels"
          :y-min="pnlYMin"
          :y-max="pnlYMax"
          :y-format="(v: number) => `$${v.toFixed(0)}`"
        />
      </v-card>

      <!-- Key Stats Grid -->
      <v-row dense class="mb-4">
        <!-- Win Rate -->
        <v-col cols="6" sm="3">
          <v-card variant="outlined" class="pa-3 text-center" style="height: 100%">
            <div class="d-flex align-center justify-center">
              <span class="text-caption text-medium-emphasis">Win Rate</span>
              <v-btn icon size="x-small" variant="text" class="ml-1">
                <v-icon size="14">mdi-information-outline</v-icon>
                <v-tooltip activator="parent" location="top">
                  Percentage of resolved bets where you earned a profit
                </v-tooltip>
              </v-btn>
            </div>
            <p class="text-h5 font-weight-bold mt-1">
              {{ fmtPct(stats!.wins / stats!.totalResolved) }}
            </p>
          </v-card>
        </v-col>

        <!-- Total Bets -->
        <v-col cols="6" sm="3">
          <v-card variant="outlined" class="pa-3 text-center" style="height: 100%">
            <div class="d-flex align-center justify-center">
              <span class="text-caption text-medium-emphasis">Total Bets</span>
              <v-btn icon size="x-small" variant="text" class="ml-1">
                <v-icon size="14">mdi-information-outline</v-icon>
                <v-tooltip activator="parent" location="top">
                  Number of resolved bets you participated in
                </v-tooltip>
              </v-btn>
            </div>
            <p class="text-h5 font-weight-bold mt-1">{{ stats!.totalResolved }}</p>
          </v-card>
        </v-col>

        <!-- Current Streak -->
        <v-col cols="6" sm="3">
          <v-card variant="outlined" class="pa-3 text-center" style="height: 100%">
            <div class="d-flex align-center justify-center">
              <span class="text-caption text-medium-emphasis">Streak</span>
              <v-btn icon size="x-small" variant="text" class="ml-1">
                <v-icon size="14">mdi-information-outline</v-icon>
                <v-tooltip activator="parent" location="top">
                  Your current consecutive winning or losing streak
                </v-tooltip>
              </v-btn>
            </div>
            <p
              class="text-h5 font-weight-bold mt-1"
              :class="stats!.currentStreak.type === 'win' ? 'text-success' : 'text-error'"
            >
              {{ stats!.currentStreak.count }}{{ stats!.currentStreak.type === 'win' ? 'W' : 'L' }}
            </p>
          </v-card>
        </v-col>

        <!-- Average Bet Size -->
        <v-col cols="6" sm="3">
          <v-card variant="outlined" class="pa-3 text-center" style="height: 100%">
            <div class="d-flex align-center justify-center">
              <span class="text-caption text-medium-emphasis">Avg Bet</span>
              <v-btn icon size="x-small" variant="text" class="ml-1">
                <v-icon size="14">mdi-information-outline</v-icon>
                <v-tooltip activator="parent" location="top">
                  Average amount wagered per bet
                </v-tooltip>
              </v-btn>
            </div>
            <p class="text-h5 font-weight-bold mt-1">${{ stats!.avgBetSize.toFixed(0) }}</p>
          </v-card>
        </v-col>

        <!-- Favorite Outcome Rate -->
        <v-col cols="6" sm="3">
          <v-card variant="outlined" class="pa-3 text-center" style="height: 100%">
            <div class="d-flex align-center justify-center">
              <span class="text-caption text-medium-emphasis">Favorite %</span>
              <v-btn icon size="x-small" variant="text" class="ml-1">
                <v-icon size="14">mdi-information-outline</v-icon>
                <v-tooltip activator="parent" location="top">
                  How often you bet on the most popular outcome at time of entry
                </v-tooltip>
              </v-btn>
            </div>
            <p class="text-h5 font-weight-bold mt-1">
              {{ fmtPct(stats!.favoriteRate) }}
            </p>
          </v-card>
        </v-col>

        <!-- Total Profit -->
        <v-col cols="6" sm="3">
          <v-card variant="outlined" class="pa-3 text-center" style="height: 100%">
            <div class="d-flex align-center justify-center">
              <span class="text-caption text-medium-emphasis">Total P&amp;L</span>
              <v-btn icon size="x-small" variant="text" class="ml-1">
                <v-icon size="14">mdi-information-outline</v-icon>
                <v-tooltip activator="parent" location="top">
                  Your total profit or loss across all resolved bets
                </v-tooltip>
              </v-btn>
            </div>
            <p
              class="text-h5 font-weight-bold mt-1"
              :class="stats!.totalProfit >= 0 ? 'text-success' : 'text-error'"
            >
              {{ fmtDollars(stats!.totalProfit) }}
            </p>
          </v-card>
        </v-col>
      </v-row>

      <!-- Notable Bets -->
      <div class="mb-4">
        <span class="text-subtitle-2 font-weight-medium">Notable Bets</span>

        <!-- Best Bet -->
        <v-card v-if="stats!.bestBet" variant="outlined" class="mt-2 pa-3">
          <div class="d-flex align-center">
            <v-icon color="success" size="20" class="mr-2">mdi-trophy</v-icon>
            <span class="text-caption text-medium-emphasis flex-grow-1">Best Bet</span>
            <v-btn icon size="x-small" variant="text">
              <v-icon size="14">mdi-information-outline</v-icon>
              <v-tooltip activator="parent" location="top">
                The resolved bet where you earned the most profit
              </v-tooltip>
            </v-btn>
          </div>
          <p class="text-body-2 mt-1">{{ stats!.bestBet.question }}</p>
          <p class="text-body-2 font-weight-bold text-success">
            +${{ stats!.bestBet.profit.toFixed(2) }}
          </p>
        </v-card>

        <!-- Worst Bet -->
        <v-card v-if="stats!.worstBet" variant="outlined" class="mt-2 pa-3">
          <div class="d-flex align-center">
            <v-icon color="error" size="20" class="mr-2">mdi-emoticon-sad</v-icon>
            <span class="text-caption text-medium-emphasis flex-grow-1">Worst Bet</span>
            <v-btn icon size="x-small" variant="text">
              <v-icon size="14">mdi-information-outline</v-icon>
              <v-tooltip activator="parent" location="top">
                The resolved bet where you lost the most money
              </v-tooltip>
            </v-btn>
          </div>
          <p class="text-body-2 mt-1">{{ stats!.worstBet.question }}</p>
          <p class="text-body-2 font-weight-bold text-error">
            {{ fmtDollars(stats!.worstBet.profit) }}
          </p>
        </v-card>

        <!-- Biggest Upset -->
        <v-card v-if="stats!.biggestUpset" variant="outlined" class="mt-2 pa-3">
          <div class="d-flex align-center">
            <v-icon color="warning" size="20" class="mr-2">mdi-lightning-bolt</v-icon>
            <span class="text-caption text-medium-emphasis flex-grow-1">Biggest Upset</span>
            <v-btn icon size="x-small" variant="text">
              <v-icon size="14">mdi-information-outline</v-icon>
              <v-tooltip activator="parent" location="top">
                Your most profitable winning bet where you bought in at the lowest probability
              </v-tooltip>
            </v-btn>
          </div>
          <p class="text-body-2 mt-1">{{ stats!.biggestUpset.question }}</p>
          <div class="d-flex ga-3 text-body-2 mt-1">
            <span class="text-medium-emphasis">
              Entry: {{ fmtPct(stats!.biggestUpset.entryProbability) }}
            </span>
            <span class="font-weight-bold text-success">
              +${{ stats!.biggestUpset.profit.toFixed(2) }}
            </span>
          </div>
        </v-card>
      </div>

      <!-- Leaderboard Rank Over Time -->
      <v-card
        v-if="rankSeries.length > 0 && rankLabels.length >= 2"
        variant="outlined"
        class="mb-4 pa-3"
      >
        <div class="d-flex align-center mb-2">
          <span class="text-subtitle-2 font-weight-medium">Leaderboard Rank Over Time</span>
          <v-btn icon size="x-small" variant="text" class="ml-1">
            <v-icon size="16">mdi-information-outline</v-icon>
            <v-tooltip activator="parent" location="top">
              Your ranking among friends over time based on balance after each resolved bet
            </v-tooltip>
          </v-btn>
        </div>
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
      </v-card>
    </template>
  </v-container>
</template>
