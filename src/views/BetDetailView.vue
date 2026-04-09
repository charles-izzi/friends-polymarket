<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useBetsStore } from '@/stores/bets'
import { useMarketStore } from '@/stores/market'
import { useAuthStore } from '@/stores/auth'
import { calcCost, calcEffectiveB, calcPrices } from '@/utils/lmsr'
import SvgLineChart from '@/components/SvgLineChart.vue'
import type { ChartSeries } from '@/components/SvgLineChart.vue'
import type { Bet } from '@/types'

const route = useRoute()
const router = useRouter()
const betsStore = useBetsStore()
const marketStore = useMarketStore()
const authStore = useAuthStore()

const betId = computed(() => route.params.id as string)
const bet = computed(() => betsStore.bets.find((m) => m.id === betId.value) ?? null)
const prices = computed(() => (bet.value ? betsStore.getPrices(bet.value) : []))
const position = computed(() => betsStore.currentPosition)

const submitting = ref(false)
const resolveOutcome = ref(0)
const showResolveDialog = ref(false)
const showCancelDialog = ref(false)
const resolving = ref(false)
const detailTab = ref('chart')

const now = ref(Date.now())
let nowInterval: ReturnType<typeof setInterval> | null = null

const effectiveStatus = computed(() => {
  if (!bet.value) return 'open'
  if (bet.value.status !== 'open') return bet.value.status
  if (bet.value.closesAt.toDate().getTime() <= now.value) return 'closed'
  return 'open'
})

const isCreator = computed(() => bet.value?.createdBy === authStore.user?.uid)

const isExcluded = computed(() => bet.value?.excludedMembers.includes(authStore.user?.uid ?? ''))

const canTrade = computed(() => {
  if (!bet.value || effectiveStatus.value !== 'open' || isExcluded.value) return false
  return true
})

// Per-outcome desired share counts (sliders)
const desiredShares = ref<number[]>([])
const userEdited = ref(false)

function syncDesiredShares() {
  if (!bet.value) return
  desiredShares.value = bet.value.outcomes.map((_, i) => position.value?.shares[i] ?? 0)
}

// Compute the delta per outcome
const tradeDiffs = computed(() => {
  if (!bet.value) return []
  return bet.value.outcomes.map((_, i) => {
    const current = position.value?.shares[i] ?? 0
    const desired = desiredShares.value[i] ?? 0
    return desired - current
  })
})

const hasPendingTrades = computed(() => tradeDiffs.value.some((d) => d !== 0))

// Sync sliders from position, but only if user hasn't manually edited
watch(
  [bet, position],
  () => {
    if (!userEdited.value) {
      syncDesiredShares()
    }
  },
  { immediate: true },
)

// Compute cost for each changed outcome
const tradeCosts = computed(() => {
  if (!bet.value) return []
  const b = calcEffectiveB(bet.value.totalVolume ?? 0, bet.value.liquidityParam)
  return tradeDiffs.value.map((diff, i) => {
    if (diff === 0) return 0
    return calcCost(bet.value!.sharesSold, i, diff, b)
  })
})

const totalCost = computed(() => tradeCosts.value.reduce((sum, c) => sum + c, 0))

const projectedPrices = computed(() => {
  if (!bet.value || !hasPendingTrades.value) return prices.value
  const newSharesSold = [...bet.value.sharesSold]
  for (let i = 0; i < tradeDiffs.value.length; i++) {
    newSharesSold[i] = (newSharesSold[i] ?? 0) + (tradeDiffs.value[i] ?? 0)
  }
  const b = calcEffectiveB(bet.value.totalVolume ?? 0, bet.value.liquidityParam)
  return calcPrices(newSharesSold, b)
})

const profitPotential = computed(() => {
  if (!bet.value) return 0
  return Math.max(...tradeDiffs.value.map((d, i) => d - totalCost.value))
})

const tradeActionLabel = computed(() => {
  const buys = tradeDiffs.value.filter((d) => d > 0).length
  const sells = tradeDiffs.value.filter((d) => d < 0).length
  if (buys > 0 && sells > 0) return 'Trade'
  if (sells > 0) return 'Sell'
  return 'Buy'
})

const tradeSummaryLines = computed(() => {
  if (!bet.value) return []
  const lines: string[] = []
  tradeDiffs.value.forEach((diff, i) => {
    if (diff === 0) return
    const cost = tradeCosts.value[i] ?? 0
    if (diff > 0) {
      lines.push(`Buy ${diff} "${bet.value!.outcomes[i]}" for $${cost.toFixed(2)}`)
    } else {
      lines.push(
        `Sell ${Math.abs(diff)} "${bet.value!.outcomes[i]}" for $${Math.abs(cost).toFixed(2)}`,
      )
    }
  })
  return lines
})

const limitWarnings = ref<Record<number, boolean>>({})

function onSliderUpdate(index: number, val: number) {
  userEdited.value = true
  if (val > 100) {
    desiredShares.value[index] = 100
    limitWarnings.value[index] = true
    setTimeout(() => (limitWarnings.value[index] = false), 2000)
  } else {
    desiredShares.value[index] = val
    limitWarnings.value[index] = false
  }
}

function resetSliders() {
  userEdited.value = false
  syncDesiredShares()
}

const timeRemaining = computed(() => {
  if (!bet.value || effectiveStatus.value !== 'open') return ''
  const diff = bet.value.closesAt.toDate().getTime() - now.value
  if (diff <= 0) return ''
  const days = Math.floor(diff / 86400000)
  const hours = Math.floor((diff % 86400000) / 3600000)
  const minutes = Math.floor((diff % 3600000) / 60000)
  if (days > 0) return `${days}d ${hours}h ${minutes}m left`
  if (hours > 0) return `${hours}h ${minutes}m left`
  return `${minutes}m left`
})

function memberName(userId: string): string {
  return marketStore.members.find((m) => m.userId === userId)?.displayName ?? 'Unknown'
}

async function handleTrades() {
  if (!hasPendingTrades.value || submitting.value) return
  submitting.value = true
  try {
    for (let i = 0; i < tradeDiffs.value.length; i++) {
      const diff = tradeDiffs.value[i] ?? 0
      if (diff === 0) continue
      await betsStore.executeTrade({
        betId: betId.value,
        outcomeIndex: i,
        shares: diff,
      })
    }
    userEdited.value = false
  } finally {
    submitting.value = false
  }
}

async function handleResolve() {
  resolving.value = true
  try {
    await betsStore.resolveBet(betId.value, resolveOutcome.value)
    showResolveDialog.value = false
  } finally {
    resolving.value = false
  }
}

async function handleCancel() {
  resolving.value = true
  try {
    await betsStore.cancelBet(betId.value)
    showCancelDialog.value = false
  } finally {
    resolving.value = false
  }
}

// --- Chart ---
const OUTCOME_COLORS = [
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

function getOutcomeColor(index: number): string {
  return OUTCOME_COLORS[index % OUTCOME_COLORS.length]!
}

const chartSeries = computed<ChartSeries[]>(() => {
  if (!bet.value) return []
  const n = bet.value.outcomes.length

  // Build chronological price points per outcome
  const points: number[][] = Array.from({ length: n }, () => [])

  // Initial equal prices
  for (let i = 0; i < n; i++) points[i]!.push((1 / n) * 100)

  // Trades are stored DESC — iterate in reverse for chronological order
  const trades = betsStore.trades
  for (let t = trades.length - 1; t >= 0; t--) {
    const trade = trades[t]!
    for (let i = 0; i < n; i++) {
      points[i]!.push((trade.priceAfter[i] ?? 0) * 100)
    }
  }

  return bet.value.outcomes.map((label, i) => ({
    label,
    color: getOutcomeColor(i),
    data: points[i]!,
  }))
})

const chartLabels = computed(() => {
  if (!bet.value) return []
  const count = chartSeries.value[0]?.data.length ?? 0
  return Array.from({ length: count }, (_, i) => (i === 0 ? 'Start' : `#${i}`))
})

onMounted(() => {
  if (!betsStore.bets.length) {
    betsStore.listenToBets()
  }
  betsStore.listenToBet(betId.value)
  nowInterval = setInterval(() => (now.value = Date.now()), 60000)
})

onUnmounted(() => {
  betsStore.stopListeningToBet()
  if (nowInterval) clearInterval(nowInterval)
})
</script>

<template>
  <v-container max-width="700" class="pt-0">
    <div class="d-flex align-center mb-0">
      <v-btn icon="mdi-arrow-left" variant="text" @click="router.push('/bets')" />
      <h1 class="text-h6 ml-2 flex-grow-1">Bet Detail</h1>
      <template
        v-if="isCreator && bet && (effectiveStatus === 'open' || effectiveStatus === 'closed')"
      >
        <v-btn
          icon="mdi-gavel"
          color="primary"
          variant="tonal"
          size="small"
          :class="['ml-1', { 'pulse-shadow': effectiveStatus === 'closed' }]"
          @click="showResolveDialog = true"
        >
          <v-icon>mdi-gavel</v-icon>
          <v-tooltip activator="parent" location="bottom">
            {{ effectiveStatus === 'closed' ? 'Betting closed — Resolve now!' : 'Resolve Bet' }}
          </v-tooltip>
        </v-btn>
        <v-btn
          icon="mdi-cancel"
          color="error"
          variant="tonal"
          size="small"
          class="ml-1"
          @click="showCancelDialog = true"
        >
          <v-icon>mdi-cancel</v-icon>
          <v-tooltip activator="parent" location="bottom">Cancel Bet</v-tooltip>
        </v-btn>
      </template>
    </div>

    <template v-if="!bet">
      <v-progress-linear indeterminate />
    </template>

    <template v-else>
      <!-- Question + status row -->
      <div class="d-flex align-center ga-4 mb-2" style="margin-top: -4px">
        <div class="flex-grow-1">
          <p class="text-h6 font-weight-medium">{{ bet.question }}</p>
          <v-chip v-if="isExcluded" color="error" size="small" variant="tonal" class="mt-1">
            You are excluded
          </v-chip>
        </div>
        <div class="d-flex flex-column align-end justify-center ga-1 flex-shrink-0">
          <v-chip
            :color="
              effectiveStatus === 'open'
                ? 'success'
                : effectiveStatus === 'resolved'
                  ? 'info'
                  : effectiveStatus === 'cancelled'
                    ? 'error'
                    : 'warning'
            "
            size="small"
            variant="tonal"
          >
            {{ effectiveStatus }}
          </v-chip>
          <span v-if="timeRemaining" class="text-caption text-medium-emphasis">{{
            timeRemaining
          }}</span>
        </div>
      </div>

      <!-- Resolved banner -->
      <v-alert
        v-if="bet.status === 'resolved' && bet.resolvedOutcome !== null"
        type="success"
        variant="tonal"
        class="mb-4"
      >
        <strong>Resolved:</strong> "{{ bet.outcomes[bet.resolvedOutcome] }}" won!
        <table
          v-if="position && position.totalCost > 0"
          class="text-body-2 mt-2"
          style="border-collapse: collapse"
        >
          <tbody>
            <tr>
              <td class="pr-4 text-medium-emphasis">Cost</td>
              <td class="text-right">${{ position.totalCost.toFixed(2) }}</td>
            </tr>
            <tr>
              <td class="pr-4 text-medium-emphasis">Payout</td>
              <td class="text-right">
                ${{ (position.shares[bet.resolvedOutcome] ?? 0).toFixed(2) }}
              </td>
            </tr>
            <tr>
              <td class="pr-4 text-medium-emphasis font-weight-bold">Profit</td>
              <td
                class="text-right font-weight-bold"
                :class="
                  (position.shares[bet.resolvedOutcome] ?? 0) - position.totalCost >= 0
                    ? 'text-success'
                    : 'text-error'
                "
              >
                {{
                  (position.shares[bet.resolvedOutcome] ?? 0) - position.totalCost >= 0 ? '+' : ''
                }}${{
                  ((position.shares[bet.resolvedOutcome] ?? 0) - position.totalCost).toFixed(2)
                }}
              </td>
            </tr>
          </tbody>
        </table>
      </v-alert>

      <!-- Cancelled banner -->
      <v-alert v-if="bet.status === 'cancelled'" type="warning" variant="tonal" class="mb-4">
        This bet was cancelled. All positions have been refunded at cost basis.
      </v-alert>

      <!-- Chart / Trades tabs -->
      <v-tabs v-model="detailTab" density="compact" class="mb-2">
        <v-tab value="chart">
          <v-icon>mdi-chart-line</v-icon>
        </v-tab>
        <v-tab value="trades">
          <v-icon>mdi-swap-horizontal</v-icon>
        </v-tab>
      </v-tabs>

      <v-window v-model="detailTab">
        <v-window-item value="chart">
          <div class="mb-4">
            <SvgLineChart
              :series="chartSeries"
              :labels="chartLabels"
              :y-min="0"
              :y-max="100"
              :y-format="(v: number) => `${v.toFixed(0)}%`"
            />
          </div>
        </v-window-item>

        <v-window-item value="trades">
          <table
            v-if="betsStore.trades.length > 0"
            class="text-body-2"
            style="width: 100%; border-collapse: collapse"
          >
            <thead>
              <tr
                class="text-caption text-medium-emphasis"
                style="
                  border-bottom: thin solid rgba(var(--v-border-color), var(--v-border-opacity));
                "
              >
                <th class="text-left py-1">User</th>
                <th class="text-left py-1">Action</th>
                <th class="text-right py-1">Shares</th>
                <th class="text-right py-1">Amount</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="trade in betsStore.trades"
                :key="trade.id"
                style="
                  border-bottom: thin solid rgba(var(--v-border-color), var(--v-border-opacity));
                "
              >
                <td class="py-1">{{ memberName(trade.userId) }}</td>
                <td class="py-1">
                  <span :class="trade.shares > 0 ? 'text-success' : 'text-error'">
                    {{ trade.shares > 0 ? 'Buy' : 'Sell' }}
                  </span>
                  "{{ bet.outcomes[trade.outcomeIndex] }}"
                </td>
                <td class="text-right py-1">{{ Math.abs(trade.shares).toFixed(1) }}</td>
                <td class="text-right py-1">${{ Math.abs(trade.cost).toFixed(2) }}</td>
              </tr>
            </tbody>
          </table>
          <p v-else class="text-body-2 text-medium-emphasis">No trades yet</p>
        </v-window-item>
      </v-window>
      <!-- Outcome prices -->
      <div class="mb-4">
        <div
          class="outcome-spectrum"
          :style="{
            height: '28px',
            borderRadius: '6px',
            overflow: 'hidden',
            display: 'flex',
            position: 'relative',
          }"
        >
          <div
            v-for="(outcome, i) in bet.outcomes"
            :key="i"
            :style="{
              width: (prices[i] ?? 0) * 100 + '%',
              backgroundColor: OUTCOME_COLORS[i % OUTCOME_COLORS.length],
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              position: 'relative',
            }"
          >
            <span
              v-if="(prices[i] ?? 0) >= 0.08"
              class="text-caption font-weight-bold"
              style="color: white; text-shadow: 0 1px 2px rgba(0, 0, 0, 0.4)"
            >
              {{ ((prices[i] ?? 0) * 100).toFixed(1) }}%
            </span>
          </div>
        </div>
        <div class="d-flex flex-wrap ga-3 mt-2">
          <div v-for="(outcome, i) in bet.outcomes" :key="i" class="d-flex align-center ga-1">
            <div
              :style="{
                width: '12px',
                height: '12px',
                borderRadius: '3px',
                backgroundColor: OUTCOME_COLORS[i % OUTCOME_COLORS.length],
              }"
            />
            <span class="text-caption">{{ outcome }}</span>
          </div>
        </div>
      </div>

      <!-- Your Positions -->
      <v-card v-if="canTrade || position" class="mb-4" variant="outlined">
        <v-card-title class="text-subtitle-1">Your Positions</v-card-title>
        <v-card-text>
          <div v-for="(outcome, i) in bet.outcomes" :key="i" class="mb-4">
            <div class="d-flex align-center ga-2 mb-1">
              <div
                :style="{
                  width: '10px',
                  height: '10px',
                  borderRadius: '2px',
                  backgroundColor: OUTCOME_COLORS[i % OUTCOME_COLORS.length],
                }"
              />
              <span class="text-body-2 font-weight-medium">{{ outcome }}</span>
              <div class="ml-auto d-flex flex-column align-end" style="line-height: 1.2">
                <div class="d-flex align-baseline ga-2">
                  <span class="text-caption text-medium-emphasis">
                    {{ (1 / (prices[i] ?? 1)).toFixed(2) }}x
                  </span>
                  <span class="font-weight-bold" style="font-size: 15px">
                    {{ ((prices[i] ?? 0) * 100).toFixed(0) }}%
                  </span>
                </div>
                <div v-if="(tradeDiffs[i] ?? 0) !== 0" class="d-flex align-baseline ga-2">
                  <span
                    class="text-caption font-weight-bold"
                    :style="{
                      color:
                        1 / (projectedPrices[i] ?? 1) >= 1 / (prices[i] ?? 1)
                          ? '#4caf50'
                          : '#ef5350',
                    }"
                  >
                    {{ (1 / (projectedPrices[i] ?? 1)).toFixed(2) }}x
                  </span>
                  <span
                    class="text-caption font-weight-bold"
                    :style="{
                      color: (projectedPrices[i] ?? 0) >= (prices[i] ?? 0) ? '#4caf50' : '#ef5350',
                    }"
                  >
                    {{ ((projectedPrices[i] ?? 0) * 100).toFixed(0) }}%
                  </span>
                </div>
              </div>
            </div>

            <v-slider
              v-if="canTrade"
              :model-value="desiredShares[i] ?? 0"
              @update:model-value="(val: number) => onSliderUpdate(i, val)"
              :min="0"
              :max="100"
              :step="1"
              density="compact"
              hide-details
            />

            <p
              v-if="limitWarnings[i]"
              class="text-caption text-center"
              style="color: #ef5350; margin-top: -4px"
            >
              You can't wager more than 100 shares per bet
            </p>

            <div class="text-caption text-medium-emphasis" style="margin-top: 2px">
              {{ (position?.shares[i] ?? 0).toFixed(0) }} shares held
              <span v-if="(tradeDiffs[i] ?? 0) !== 0" class="ml-1">
                &rarr;
                <span
                  :style="{
                    color: (tradeDiffs[i] ?? 0) > 0 ? '#4caf50' : '#ef5350',
                    marginLeft: '3px',
                  }"
                >
                  ({{ (tradeDiffs[i] ?? 0) > 0 ? '+' : '' }}{{ tradeDiffs[i] ?? 0 }})
                </span>

                <span
                  :style="{
                    color: (tradeCosts[i] ?? 0) <= 0 ? '#4caf50' : '#ef5350',
                    marginLeft: '3px',
                  }"
                >
                  ({{ (tradeCosts[i] ?? 0) <= 0 ? '+' : '-' }}${{
                    Math.abs(tradeCosts[i] ?? 0).toFixed(2)
                  }})
                </span>
              </span>
            </div>
          </div>

          <!-- Trade summary -->
          <template v-if="hasPendingTrades">
            <v-divider class="mb-3" />

            <div class="mb-3">
              <div
                v-for="(outcome, i) in bet.outcomes"
                :key="'summary-' + i"
                v-show="(tradeDiffs[i] ?? 0) !== 0"
                class="d-flex align-center justify-space-between text-body-2 py-1"
                style="
                  border-bottom: thin solid rgba(var(--v-border-color), var(--v-border-opacity));
                "
              >
                <span>
                  <span :class="(tradeDiffs[i] ?? 0) > 0 ? 'text-success' : 'text-error'">
                    {{ (tradeDiffs[i] ?? 0) > 0 ? 'Buy' : 'Sell' }}
                  </span>
                  "{{ outcome }}"
                </span>
                <span class="d-flex ga-2">
                  <span :style="{ color: (tradeDiffs[i] ?? 0) > 0 ? '#4caf50' : '#ef5350' }">
                    ({{ (tradeDiffs[i] ?? 0) > 0 ? '+' : '' }}{{ tradeDiffs[i] ?? 0 }})
                  </span>
                  <span :style="{ color: (tradeCosts[i] ?? 0) <= 0 ? '#4caf50' : '#ef5350' }">
                    ({{ (tradeCosts[i] ?? 0) <= 0 ? '+' : '-' }}${{
                      Math.abs(tradeCosts[i] ?? 0).toFixed(2)
                    }})
                  </span>
                </span>
              </div>
              <div
                class="d-flex align-center justify-space-between text-body-2 font-weight-bold mt-2"
              >
                <span>Net cost</span>
                <span :style="{ color: totalCost <= 0 ? '#4caf50' : '#ef5350' }">
                  {{ totalCost <= 0 ? '+' : '-' }}${{ Math.abs(totalCost).toFixed(2) }}
                </span>
              </div>
              <div
                class="d-flex align-center justify-space-between text-body-2 font-weight-bold mt-1"
              >
                <span>Profit potential</span>
                <span :style="{ color: profitPotential >= 0 ? '#4caf50' : '#ef5350' }">
                  {{ profitPotential >= 0 ? '+' : '' }}${{ profitPotential.toFixed(2) }}
                </span>
              </div>
            </div>

            <div class="d-flex ga-2">
              <v-btn
                color="primary"
                :loading="submitting"
                :disabled="submitting"
                @click="handleTrades"
                class="flex-grow-1"
              >
                {{ tradeActionLabel }}
              </v-btn>
              <v-btn variant="text" @click="resetSliders" :disabled="submitting"> Reset </v-btn>
            </div>
          </template>

          <v-alert v-if="betsStore.error" type="error" variant="tonal" class="mt-3">
            {{ betsStore.error }}
          </v-alert>
        </v-card-text>
      </v-card>

      <!-- Resolve dialog -->
      <v-dialog v-model="showResolveDialog" max-width="400">
        <v-card>
          <v-card-title>Resolve Bet</v-card-title>
          <v-card-text>
            <p class="text-body-2 mb-3">Select the winning outcome:</p>
            <v-radio-group v-model="resolveOutcome">
              <v-radio v-for="(outcome, i) in bet.outcomes" :key="i" :label="outcome" :value="i" />
            </v-radio-group>
          </v-card-text>
          <v-card-actions>
            <v-spacer />
            <v-btn variant="text" @click="showResolveDialog = false">Cancel</v-btn>
            <v-btn color="primary" :loading="resolving" @click="handleResolve">
              Confirm Resolution
            </v-btn>
          </v-card-actions>
        </v-card>
      </v-dialog>

      <!-- Cancel dialog -->
      <v-dialog v-model="showCancelDialog" max-width="400">
        <v-card>
          <v-card-title>Cancel Bet</v-card-title>
          <v-card-text>
            <p class="text-body-2">
              Are you sure? All positions will be refunded at cost basis. This cannot be undone.
            </p>
          </v-card-text>
          <v-card-actions>
            <v-spacer />
            <v-btn variant="text" @click="showCancelDialog = false">Go Back</v-btn>
            <v-btn color="error" :loading="resolving" @click="handleCancel"> Cancel Bet </v-btn>
          </v-card-actions>
        </v-card>
      </v-dialog>

      <!-- Recent trades removed - now in tabs above -->
    </template>
  </v-container>
</template>

<style scoped>
.slider-shake {
  animation: shake 0.3s ease;
}

@keyframes shake {
  0%,
  100% {
    transform: translateX(0);
  }
  25% {
    transform: translateX(-4px);
  }
  50% {
    transform: translateX(4px);
  }
  75% {
    transform: translateX(-2px);
  }
}

.pulse-shadow {
  animation: pulse-glow 1.5s ease-in-out infinite;
  border-radius: 50%;
}

@keyframes pulse-glow {
  0%,
  100% {
    box-shadow: 0 0 0 0 rgba(255, 152, 0, 0.6);
  }
  50% {
    box-shadow: 0 0 8px 4px rgba(255, 152, 0, 0.4);
  }
}
</style>
