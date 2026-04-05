<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useBetsStore } from '@/stores/bets'
import { useMarketStore } from '@/stores/market'
import { useAuthStore } from '@/stores/auth'
import { calcCost, calcEffectiveB } from '@/utils/lmsr'
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
  <v-container max-width="700">
    <div class="d-flex align-center mb-2">
      <v-btn icon="mdi-arrow-left" variant="text" @click="router.push('/bets')" />
      <h1 class="text-h5 ml-2">Bet Detail</h1>
    </div>

    <template v-if="!bet">
      <v-progress-linear indeterminate />
    </template>

    <template v-else>
      <!-- Question + status row -->
      <div class="d-flex align-start ga-4 mb-4">
        <div class="flex-grow-1">
          <p class="text-h6 font-weight-medium">{{ bet.question }}</p>
          <v-chip v-if="isExcluded" color="error" size="small" variant="tonal" class="mt-2">
            You are excluded
          </v-chip>
        </div>
        <div class="d-flex flex-column align-end ga-1 flex-shrink-0">
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
        <span v-if="position && (position.shares[bet.resolvedOutcome] ?? 0) > 0">
          You won
          <strong>{{ (position.shares[bet.resolvedOutcome] ?? 0).toFixed(2) }}</strong> dollars!
        </span>
      </v-alert>

      <!-- Cancelled banner -->
      <v-alert v-if="bet.status === 'cancelled'" type="warning" variant="tonal" class="mb-4">
        This bet was cancelled. All positions have been refunded at cost basis.
      </v-alert>

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
              backgroundColor:
                i === 0
                  ? 'rgb(var(--v-theme-primary))'
                  : i === 1
                    ? 'rgb(var(--v-theme-error))'
                    : 'rgb(var(--v-theme-warning))',
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
                backgroundColor:
                  i === 0
                    ? 'rgb(var(--v-theme-primary))'
                    : i === 1
                      ? 'rgb(var(--v-theme-error))'
                      : 'rgb(var(--v-theme-warning))',
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
                  backgroundColor:
                    i === 0
                      ? 'rgb(var(--v-theme-primary))'
                      : i === 1
                        ? 'rgb(var(--v-theme-error))'
                        : 'rgb(var(--v-theme-warning))',
                }"
              />
              <span class="text-body-2 font-weight-medium">{{ outcome }}</span>
              <span class="text-caption text-medium-emphasis ml-auto">
                {{ ((prices[i] ?? 0) * 100).toFixed(1) }}%
              </span>
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
                &rarr; {{ (desiredShares[i] ?? 0).toFixed(0) }}
                <span :style="{ color: (tradeDiffs[i] ?? 0) > 0 ? '#4caf50' : '#ef5350' }">
                  ({{ (tradeDiffs[i] ?? 0) > 0 ? '+' : '' }}{{ tradeDiffs[i] ?? 0 }})
                </span>
              </span>
            </div>
          </div>

          <!-- Trade summary -->
          <template v-if="hasPendingTrades">
            <v-divider class="mb-3" />

            <div class="mb-3">
              <p v-for="(line, idx) in tradeSummaryLines" :key="idx" class="text-body-2">
                {{ line }}
              </p>
              <p class="text-body-2 font-weight-bold mt-1">
                Net cost: {{ totalCost >= 0 ? '' : '-' }}${{ Math.abs(totalCost).toFixed(2) }}
              </p>
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

      <!-- Creator actions: resolve or cancel -->
      <v-card
        v-if="isCreator && (effectiveStatus === 'open' || effectiveStatus === 'closed')"
        class="mb-4"
        variant="outlined"
        color="warning"
      >
        <v-card-title class="text-subtitle-1">Creator Actions</v-card-title>
        <v-card-text>
          <div class="d-flex ga-3">
            <v-btn color="primary" variant="elevated" @click="showResolveDialog = true">
              Resolve Bet
            </v-btn>
            <v-btn color="error" variant="outlined" @click="showCancelDialog = true">
              Cancel Bet
            </v-btn>
          </div>
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

      <!-- Recent trades -->
      <v-card variant="outlined">
        <v-card-title class="text-subtitle-1">
          Recent Trades ({{ betsStore.trades.length }})
        </v-card-title>
        <v-list v-if="betsStore.trades.length > 0" density="compact">
          <v-list-item v-for="trade in betsStore.trades" :key="trade.id">
            <template #prepend>
              <v-icon
                :icon="trade.shares > 0 ? 'mdi-arrow-up-bold' : 'mdi-arrow-down-bold'"
                :color="trade.shares > 0 ? 'success' : 'error'"
                size="small"
              />
            </template>
            <v-list-item-title class="text-body-2">
              {{ memberName(trade.userId) }}
              {{ trade.shares > 0 ? 'bought' : 'sold' }}
              {{ Math.abs(trade.shares) }}
              "{{ bet.outcomes[trade.outcomeIndex] }}"
            </v-list-item-title>
            <v-list-item-subtitle class="text-caption">
              {{ trade.shares > 0 ? 'Paid' : 'Received' }}
              {{ Math.abs(trade.cost).toFixed(2) }} dollars
            </v-list-item-subtitle>
          </v-list-item>
        </v-list>
        <v-card-text v-else>
          <p class="text-body-2 text-medium-emphasis">No trades yet</p>
        </v-card-text>
      </v-card>
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
</style>
