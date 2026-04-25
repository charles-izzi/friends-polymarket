<script setup lang="ts">
import { onMounted, onUnmounted, computed, ref, watch } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { useSmartBack } from '@/composables/useSmartBack'
import { useStatsStore } from '@/stores/stats'
import { useMarketStore } from '@/stores/market'
import { useAuthStore } from '@/stores/auth'
import { useBetsStore } from '@/stores/bets'
import SvgLineChart from '@/components/SvgLineChart.vue'
import type { ChartSeries } from '@/components/SvgLineChart.vue'
import type { UserStats } from '@/types'

const router = useRouter()
const route = useRoute()
const statsStore = useStatsStore()
const marketStore = useMarketStore()
const authStore = useAuthStore()
const betsStore = useBetsStore()
const { goBack } = useSmartBack(`/${marketStore.market?.id ?? ''}`)

const targetUserId = computed(() => (route.params.userId as string) || authStore.user?.uid || '')
const isOwnProfile = computed(() => targetUserId.value === authStore.user?.uid)
const playerName = computed(() => {
  if (isOwnProfile.value) return 'My Stats'
  const member = marketStore.members.find((m) => m.userId === targetUserId.value)
  return member ? `${member.displayName}'s Stats` : 'Player Stats'
})

onMounted(() => {
  statsStore.listenToStats(targetUserId.value)
  statsStore.loadAllStats()
  betsStore.listenToBets()
})

watch(targetUserId, (newId) => {
  statsStore.listenToStats(newId)
})

onUnmounted(() => {
  statsStore.cleanup()
})

const stats = computed(() => statsStore.myStats)
const hasData = computed(() => (stats.value?.totalResolved ?? 0) > 0)
const pageLoading = computed(
  () => statsStore.loading || betsStore.loading || !betsStore.positionsReady,
)

// --- Cumulative P&L Chart ---
const pnlSeries = computed<ChartSeries[]>(() => {
  const data = statsStore.cumulativePnL
  if (data.length === 0) return []
  return [{ label: 'P&L', color: '#5b8fa8', data }]
})

const pnlLabels = computed(() => {
  if (!stats.value?.resolvedBets.length) return []
  const member = marketStore.members.find((m) => m.userId === targetUserId.value)
  let startLabel = 'Start'
  if (member?.joinedAt) {
    const jts =
      typeof member.joinedAt === 'number'
        ? member.joinedAt
        : (member.joinedAt as { seconds: number }).seconds * 1000
    const jd = new Date(jts)
    startLabel = `${jd.getMonth() + 1}/${jd.getDate()}`
  }
  const labels = [startLabel]
  for (const r of stats.value.resolvedBets) {
    const ts =
      typeof r.resolvedAt === 'number'
        ? r.resolvedAt
        : (r.resolvedAt as { seconds: number }).seconds * 1000
    const d = new Date(ts)
    labels.push(`${d.getMonth() + 1}/${d.getDate()}`)
  }
  return labels
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

// --- Current Holdings ---
const currentHoldings = computed(() => {
  const uid = targetUserId.value
  const activeBets = betsStore.bets.filter((b) => b.status === 'open' || b.status === 'closed')
  const holdings: {
    betId: string
    question: string
    outcome: string
    shares: number
    value: number
  }[] = []
  for (const bet of activeBets) {
    const positions = betsStore.allPositions[bet.id] ?? []
    const pos = positions.find((p) => p.userId === uid)
    if (!pos) continue
    const prices = betsStore.getPrices(bet)
    for (let i = 0; i < pos.shares.length; i++) {
      if ((pos.shares[i] ?? 0) > 0.001) {
        holdings.push({
          betId: bet.id,
          question: bet.question,
          outcome: bet.outcomes[i] ?? `Outcome ${i + 1}`,
          shares: pos.shares[i]!,
          value: pos.shares[i]! * (prices[i] ?? 0),
        })
      }
    }
  }
  return holdings
})

// --- Leaderboard ---
type StatKey =
  | 'winRate'
  | 'totalBets'
  | 'streak'
  | 'avgBet'
  | 'favoriteRate'
  | 'totalPnL'
  | 'accuracy'

const leaderboardStat = ref<StatKey | null>(null)

const statLabels: Record<StatKey, string> = {
  winRate: 'Win Rate',
  totalBets: 'Total Bets',
  streak: 'Streak',
  avgBet: 'Avg Bet',
  favoriteRate: 'Favorite %',
  totalPnL: 'Total P&L',
  accuracy: 'Accuracy',
}

interface LeaderboardEntry {
  userId: string
  name: string
  value: number
  formatted: string
  isCurrentUser: boolean
}

function getStatValue(s: UserStats, key: StatKey): number {
  switch (key) {
    case 'winRate':
      return s.totalResolved > 0 ? s.wins / s.totalResolved : 0
    case 'totalBets':
      return s.totalResolved
    case 'streak':
      return s.currentStreak.type === 'win' ? s.currentStreak.count : -s.currentStreak.count
    case 'avgBet':
      return s.avgBetSize
    case 'favoriteRate':
      return s.favoriteRate
    case 'totalPnL':
      return s.totalProfit
    case 'accuracy':
      return s.totalResolved > 0 ? s.totalProfit / s.totalResolved : 0
  }
}

function formatStatValue(v: number, key: StatKey): string {
  switch (key) {
    case 'winRate':
      return fmtPct(v)
    case 'totalBets':
      return String(v)
    case 'streak':
      return v >= 0 ? `${v}W` : `${Math.abs(v)}L`
    case 'avgBet':
      return `$${v.toFixed(0)}`
    case 'favoriteRate':
      return fmtPct(v)
    case 'totalPnL':
      return fmtDollars(v)
    case 'accuracy':
      return fmtDollars(v)
  }
}

const leaderboard = computed<LeaderboardEntry[]>(() => {
  const key = leaderboardStat.value
  if (!key) return []
  const allStats = statsStore.allMemberStats
  const entries: LeaderboardEntry[] = []
  for (const [userId, s] of Object.entries(allStats)) {
    if (s.totalResolved === 0) continue
    const member = marketStore.members.find((m) => m.userId === userId)
    const val = getStatValue(s, key)
    entries.push({
      userId,
      name: member?.displayName ?? userId.slice(0, 8),
      value: val,
      formatted: formatStatValue(val, key),
      isCurrentUser: userId === targetUserId.value,
    })
  }
  entries.sort((a, b) => b.value - a.value)
  return entries
})

function openLeaderboard(key: StatKey) {
  leaderboardStat.value = key
}

function goToUserStats(userId: string) {
  router.push(`/${marketStore.market!.id}/stats/${userId}`)
  showLeaderboard.value = false
}

const showLeaderboard = computed({
  get: () => leaderboardStat.value !== null,
  set: (v: boolean) => {
    if (!v) leaderboardStat.value = null
  },
})

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
      <v-btn icon="mdi-arrow-left" variant="text" @click="goBack()" />
      <h1 class="text-h6 ml-2">{{ playerName }}</h1>
    </div>

    <template v-if="pageLoading">
      <v-progress-linear indeterminate />
    </template>

    <template v-else-if="!hasData && currentHoldings.length === 0">
      <v-card variant="outlined" class="pa-6 text-center">
        <v-icon icon="mdi-chart-box-outline" size="48" color="medium-emphasis" class="mb-3" />
        <p class="text-body-1 text-medium-emphasis">
          No resolved bets yet. Stats will appear after your first bet resolves.
        </p>
      </v-card>
    </template>

    <template v-else>
      <!-- Current Holdings -->
      <v-card v-if="currentHoldings.length > 0" variant="outlined" class="mb-4">
        <div class="text-caption text-medium-emphasis pa-3 pb-0">Current Holdings</div>
        <v-table density="compact" class="mt-2 mx-3 mb-3">
          <thead>
            <tr>
              <th class="text-left">Bet</th>
              <th class="text-center" style="width: 80px">Position</th>
              <th class="text-right" style="width: 70px">Shares</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="h in currentHoldings"
              :key="`${h.betId}-${h.outcome}`"
              class="clickable-row"
              @click="router.push(`/${marketStore.market!.id}/bets/${h.betId}`)"
            >
              <td class="text-body-2" style="max-width: 180px">
                <span class="d-inline-block text-truncate" style="max-width: 100%">
                  {{ h.question }}
                  <v-tooltip activator="parent" location="top">{{ h.question }}</v-tooltip>
                </span>
              </td>
              <td class="text-center text-caption" style="max-width: 80px">
                <span class="line-clamp-2">
                  {{ h.outcome }}
                  <v-tooltip activator="parent" location="top">{{ h.outcome }}</v-tooltip>
                </span>
              </td>
              <td class="text-right text-body-2">{{ h.shares.toFixed(1) }}</td>
            </tr>
          </tbody>
        </v-table>
      </v-card>

      <template v-if="hasData">
        <!-- Resolved Bets -->
        <v-card variant="outlined" class="mb-4">
          <div class="text-caption text-medium-emphasis pa-3 pb-0">Resolved Bets</div>
          <v-table density="compact" class="mt-2 mx-3 mb-3">
            <thead>
              <tr>
                <th class="text-left">Bet</th>
                <th class="text-center" style="width: 80px">Result</th>
                <th class="text-right" style="width: 80px">
                  <span class="d-inline-flex align-center justify-end">
                    <v-btn icon size="x-small" variant="text" class="mr-1">
                      <v-icon size="14">mdi-information-outline</v-icon>
                      <v-tooltip activator="parent" location="top">
                        The total profit and loss for this bet.
                      </v-tooltip>
                    </v-btn>
                    P/L
                  </span>
                </th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="r in stats!.resolvedBets"
                :key="r.betId"
                class="clickable-row"
                @click="router.push(`/${marketStore.market!.id}/bets/${r.betId}`)"
              >
                <td class="text-body-2" style="max-width: 200px">
                  <span class="d-inline-block text-truncate" style="max-width: 100%">
                    {{ r.question }}
                    <v-tooltip activator="parent" location="top">{{ r.question }}</v-tooltip>
                  </span>
                </td>
                <td class="text-center">
                  <span class="text-caption">
                    {{
                      betsStore.bets.find((b) => b.id === r.betId)?.outcomes[r.winningOutcome] ??
                      (r.primaryOutcome === r.winningOutcome ? 'Won' : 'Lost')
                    }}
                  </span>
                </td>
                <td
                  class="text-right text-body-2 font-weight-medium"
                  :class="r.profit >= 0 ? 'text-success' : 'text-error'"
                >
                  {{ fmtDollars(r.profit) }}
                </td>
              </tr>
            </tbody>
          </v-table>
        </v-card>

        <!-- Cumulative P&L Chart -->
        <v-card variant="outlined" class="mb-4 pa-3">
          <div class="d-flex align-center mb-2">
            <span class="text-caption text-medium-emphasis">Cumulative P&amp;L</span>
            <v-btn icon size="x-small" variant="text" class="ml-1">
              <v-icon size="16">mdi-information-outline</v-icon>
              <v-tooltip activator="parent" location="top">
                Your cumulative profit and loss from resolved bets, starting from $0
              </v-tooltip>
            </v-btn>
          </div>
          <SvgLineChart
            class="mt-2"
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
            <v-card
              variant="outlined"
              class="pa-3 text-center stat-card"
              style="height: 100%"
              @click="openLeaderboard('winRate')"
            >
              <div class="d-flex align-center justify-center">
                <span class="text-caption text-medium-emphasis">Win Rate</span>
                <v-btn icon size="x-small" variant="text" class="ml-1" @click.stop>
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
            <v-card
              variant="outlined"
              class="pa-3 text-center stat-card"
              style="height: 100%"
              @click="openLeaderboard('totalBets')"
            >
              <div class="d-flex align-center justify-center">
                <span class="text-caption text-medium-emphasis">Total Bets</span>
                <v-btn icon size="x-small" variant="text" class="ml-1" @click.stop>
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
            <v-card
              variant="outlined"
              class="pa-3 text-center stat-card"
              style="height: 100%"
              @click="openLeaderboard('streak')"
            >
              <div class="d-flex align-center justify-center">
                <span class="text-caption text-medium-emphasis">Streak</span>
                <v-btn icon size="x-small" variant="text" class="ml-1" @click.stop>
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
                {{ stats!.currentStreak.count
                }}{{ stats!.currentStreak.type === 'win' ? 'W' : 'L' }}
              </p>
            </v-card>
          </v-col>

          <!-- Average Bet Size -->
          <v-col cols="6" sm="3">
            <v-card
              variant="outlined"
              class="pa-3 text-center stat-card"
              style="height: 100%"
              @click="openLeaderboard('avgBet')"
            >
              <div class="d-flex align-center justify-center">
                <span class="text-caption text-medium-emphasis">Avg Bet</span>
                <v-btn icon size="x-small" variant="text" class="ml-1" @click.stop>
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
            <v-card
              variant="outlined"
              class="pa-3 text-center stat-card"
              style="height: 100%"
              @click="openLeaderboard('favoriteRate')"
            >
              <div class="d-flex align-center justify-center">
                <span class="text-caption text-medium-emphasis">Favorite %</span>
                <v-btn icon size="x-small" variant="text" class="ml-1" @click.stop>
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
            <v-card
              variant="outlined"
              class="pa-3 text-center stat-card"
              style="height: 100%"
              @click="openLeaderboard('totalPnL')"
            >
              <div class="d-flex align-center justify-center">
                <span class="text-caption text-medium-emphasis">Total P&amp;L</span>
                <v-btn icon size="x-small" variant="text" class="ml-1" @click.stop>
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

          <!-- Accuracy (Avg P/L per bet) -->
          <v-col cols="6" sm="3">
            <v-card
              variant="outlined"
              class="pa-3 text-center stat-card"
              style="height: 100%"
              @click="openLeaderboard('accuracy')"
            >
              <div class="d-flex align-center justify-center">
                <span class="text-caption text-medium-emphasis">Accuracy</span>
                <v-btn icon size="x-small" variant="text" class="ml-1" @click.stop>
                  <v-icon size="14">mdi-information-outline</v-icon>
                  <v-tooltip activator="parent" location="top">
                    Average profit or loss per resolved bet
                  </v-tooltip>
                </v-btn>
              </div>
              <p
                class="text-h5 font-weight-bold mt-1"
                :class="
                  stats!.totalProfit / stats!.totalResolved >= 0 ? 'text-success' : 'text-error'
                "
              >
                {{ fmtDollars(stats!.totalProfit / stats!.totalResolved) }}
              </p>
            </v-card>
          </v-col>
        </v-row>

        <!-- Notable Bets -->
        <div class="mb-4">
          <span class="text-caption text-medium-emphasis">Notable Bets</span>

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
            <p
              class="text-body-2 font-weight-bold"
              :class="stats!.worstBet.profit >= 0 ? 'text-success' : 'text-error'"
            >
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
      </template>
    </template>
    <!-- Leaderboard Dialog -->
    <v-dialog v-model="showLeaderboard" max-width="360" :scrim="true">
      <v-card v-if="leaderboardStat">
        <v-card-title class="d-flex align-center">
          <v-icon size="20" class="mr-2">mdi-podium</v-icon>
          {{ statLabels[leaderboardStat] }}
          <v-spacer />
          <v-btn icon size="small" variant="text" @click="showLeaderboard = false">
            <v-icon>mdi-close</v-icon>
          </v-btn>
        </v-card-title>
        <v-divider />
        <v-list density="compact">
          <v-list-item
            v-for="(entry, idx) in leaderboard"
            :key="entry.userId"
            :class="{ 'bg-surface-variant': entry.isCurrentUser }"
            @click="goToUserStats(entry.userId)"
          >
            <template #prepend>
              <span
                class="text-body-2 font-weight-bold mr-3"
                style="min-width: 24px; text-align: right"
              >
                {{ idx + 1 }}
              </span>
            </template>
            <v-list-item-title class="text-body-2">
              {{ entry.name }}
            </v-list-item-title>
            <template #append>
              <span class="text-body-2 font-weight-medium">{{ entry.formatted }}</span>
            </template>
          </v-list-item>
          <v-list-item v-if="leaderboard.length === 0">
            <v-list-item-title class="text-body-2 text-medium-emphasis text-center">
              No data yet
            </v-list-item-title>
          </v-list-item>
        </v-list>
      </v-card>
    </v-dialog>
  </v-container>
</template>

<style scoped>
.clickable-row {
  cursor: pointer;
}
.clickable-row:hover {
  background: rgba(var(--v-theme-on-surface), 0.04);
}
.stat-card {
  cursor: pointer;
  position: relative;
}
.stat-card::after {
  content: '\F0D25';
  font-family: 'Material Design Icons';
  position: absolute;
  bottom: 4px;
  right: 6px;
  font-size: 12px;
  opacity: 0.25;
}
.stat-card:hover {
  background: rgba(var(--v-theme-on-surface), 0.04);
}
.line-clamp-2 {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
</style>
