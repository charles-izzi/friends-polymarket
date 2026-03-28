<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useMarketsStore } from '@/stores/markets'
import { useServerStore } from '@/stores/server'
import { useAuthStore } from '@/stores/auth'
import { calcCost } from '@/utils/lmsr'
import type { Market } from '@/types'

const route = useRoute()
const router = useRouter()
const marketsStore = useMarketsStore()
const serverStore = useServerStore()
const authStore = useAuthStore()

const marketId = computed(() => route.params.id as string)
const market = computed(() => marketsStore.markets.find((m) => m.id === marketId.value) ?? null)
const prices = computed(() => (market.value ? marketsStore.getPrices(market.value) : []))
const position = computed(() => marketsStore.currentPosition)

const selectedOutcome = ref(0)
const shareAmount = ref(1)
const tradeMode = ref<'buy' | 'sell'>('buy')
const submitting = ref(false)
const resolveOutcome = ref(0)
const showResolveDialog = ref(false)
const showCancelDialog = ref(false)
const resolving = ref(false)

const isCreator = computed(() => market.value?.createdBy === authStore.user?.uid)

const isExcluded = computed(() => market.value?.excludedMembers.includes(authStore.user?.uid ?? ''))

const canTrade = computed(() => {
  if (!market.value || market.value.status !== 'open' || isExcluded.value) return false
  if (market.value.closesAt.toDate().getTime() <= Date.now()) return false
  return true
})

const estimatedCost = computed(() => {
  if (!market.value || shareAmount.value <= 0) return 0
  const shares = tradeMode.value === 'sell' ? -shareAmount.value : shareAmount.value
  return calcCost(
    market.value.sharesSold,
    selectedOutcome.value,
    shares,
    market.value.liquidityParam,
  )
})

const maxSellShares = computed(() => {
  if (!position.value) return 0
  return position.value.shares[selectedOutcome.value] ?? 0
})

const canSubmitTrade = computed(() => {
  if (!canTrade.value || shareAmount.value <= 0 || submitting.value) return false
  if (tradeMode.value === 'sell' && shareAmount.value > maxSellShares.value) return false
  if (tradeMode.value === 'buy' && estimatedCost.value > (serverStore.currentMember?.balance ?? 0))
    return false
  return true
})

function timeRemaining(): string {
  if (!market.value) return ''
  const closes = market.value.closesAt.toDate()
  const now = new Date()
  if (closes <= now) return 'Closed'
  const diff = closes.getTime() - now.getTime()
  const hours = Math.floor(diff / 3600000)
  const days = Math.floor(hours / 24)
  if (days > 0) return `${days}d ${hours % 24}h left`
  if (hours > 0) return `${hours}h left`
  return `${Math.floor(diff / 60000)}m left`
}

function memberName(userId: string): string {
  return serverStore.members.find((m) => m.userId === userId)?.displayName ?? 'Unknown'
}

async function handleTrade() {
  if (!canSubmitTrade.value) return
  submitting.value = true
  try {
    const shares = tradeMode.value === 'sell' ? -shareAmount.value : shareAmount.value
    await marketsStore.executeTrade({
      marketId: marketId.value,
      outcomeIndex: selectedOutcome.value,
      shares,
    })
    shareAmount.value = 1
  } finally {
    submitting.value = false
  }
}

async function handleResolve() {
  resolving.value = true
  try {
    await marketsStore.resolveMarket(marketId.value, resolveOutcome.value)
    showResolveDialog.value = false
  } finally {
    resolving.value = false
  }
}

async function handleCancel() {
  resolving.value = true
  try {
    await marketsStore.cancelMarket(marketId.value)
    showCancelDialog.value = false
  } finally {
    resolving.value = false
  }
}

onMounted(() => {
  if (!marketsStore.markets.length) {
    marketsStore.listenToMarkets()
  }
  marketsStore.listenToMarket(marketId.value)
})

onUnmounted(() => {
  marketsStore.stopListeningToMarket()
})

// Reset share amount when switching trade mode
watch(tradeMode, () => {
  shareAmount.value = 1
})
</script>

<template>
  <v-container max-width="700">
    <div class="d-flex align-center mb-4">
      <v-btn icon="mdi-arrow-left" variant="text" @click="router.push('/markets')" />
      <h1 class="text-h5 ml-2 flex-grow-1">{{ market?.question }}</h1>
    </div>

    <template v-if="!market">
      <v-progress-linear indeterminate />
    </template>

    <template v-else>
      <!-- Status bar -->
      <div class="d-flex align-center ga-3 mb-4">
        <v-chip
          :color="
            market.status === 'open'
              ? 'success'
              : market.status === 'resolved'
                ? 'info'
                : market.status === 'cancelled'
                  ? 'error'
                  : 'warning'
          "
          size="small"
          variant="tonal"
        >
          {{ market.status }}
        </v-chip>
        <span v-if="market.status === 'open'" class="text-caption text-medium-emphasis">{{
          timeRemaining()
        }}</span>
        <v-chip v-if="isExcluded" color="error" size="small" variant="tonal">
          You are excluded
        </v-chip>
      </div>

      <!-- Resolved banner -->
      <v-alert
        v-if="market.status === 'resolved' && market.resolvedOutcome !== null"
        type="success"
        variant="tonal"
        class="mb-4"
      >
        <strong>Resolved:</strong> "{{ market.outcomes[market.resolvedOutcome] }}" won!
        <span v-if="position && (position.shares[market.resolvedOutcome] ?? 0) > 0">
          You won
          <strong>{{ (position.shares[market.resolvedOutcome] ?? 0).toFixed(2) }}</strong> coins!
        </span>
      </v-alert>

      <!-- Cancelled banner -->
      <v-alert v-if="market.status === 'cancelled'" type="warning" variant="tonal" class="mb-4">
        This market was cancelled. All positions have been refunded at cost basis.
      </v-alert>

      <!-- Outcome prices -->
      <v-card class="mb-4" variant="outlined">
        <v-card-title class="text-subtitle-1">Outcome Prices</v-card-title>
        <v-card-text>
          <div v-for="(outcome, i) in market.outcomes" :key="i" class="mb-3">
            <div class="d-flex justify-space-between mb-1">
              <span class="text-body-2">{{ outcome }}</span>
              <span class="text-body-2 font-weight-bold">
                {{ ((prices[i] ?? 0) * 100).toFixed(1) }}%
              </span>
            </div>
            <v-progress-linear
              :model-value="(prices[i] ?? 0) * 100"
              :color="i === 0 ? 'primary' : i === 1 ? 'error' : 'warning'"
              height="12"
              rounded
            />
          </div>
        </v-card-text>
      </v-card>

      <!-- Your position -->
      <v-card v-if="position" class="mb-4" variant="outlined">
        <v-card-title class="text-subtitle-1">Your Position</v-card-title>
        <v-card-text>
          <div class="d-flex flex-wrap ga-3">
            <v-chip
              v-for="(outcome, i) in market.outcomes"
              :key="i"
              :color="(position.shares[i] ?? 0) > 0 ? 'primary' : 'default'"
              variant="tonal"
            >
              {{ outcome }}: {{ (position.shares[i] ?? 0).toFixed(1) }} shares
            </v-chip>
          </div>
          <p class="text-caption text-medium-emphasis mt-2">
            Total invested: {{ position.totalCost.toFixed(2) }} coins
          </p>
        </v-card-text>
      </v-card>

      <!-- Trade panel -->
      <v-card v-if="canTrade" class="mb-4">
        <v-card-title class="text-subtitle-1">Trade</v-card-title>
        <v-card-text>
          <v-btn-toggle
            v-model="tradeMode"
            mandatory
            density="comfortable"
            color="primary"
            class="mb-3"
          >
            <v-btn value="buy">Buy</v-btn>
            <v-btn value="sell" :disabled="!position">Sell</v-btn>
          </v-btn-toggle>

          <v-select
            v-model="selectedOutcome"
            :items="market.outcomes.map((o, i) => ({ title: o, value: i }))"
            label="Outcome"
            variant="outlined"
            density="comfortable"
            class="mb-2"
          />

          <v-slider
            v-model="shareAmount"
            :min="1"
            :max="tradeMode === 'sell' ? Math.max(maxSellShares, 1) : 100"
            :step="1"
            label="Shares"
            thumb-label="always"
            class="mb-2"
          />

          <v-text-field
            v-model.number="shareAmount"
            type="number"
            :min="1"
            :max="tradeMode === 'sell' ? maxSellShares : undefined"
            label="Number of shares"
            variant="outlined"
            density="compact"
            class="mb-2"
          />

          <v-alert
            :type="estimatedCost >= 0 ? 'info' : 'success'"
            variant="tonal"
            density="compact"
            class="mb-3"
          >
            <template v-if="tradeMode === 'buy'">
              Cost: <strong>{{ estimatedCost.toFixed(2) }}</strong> coins &mdash; Balance:
              {{ serverStore.currentMember?.balance?.toFixed(2) ?? 0 }}
            </template>
            <template v-else>
              You receive: <strong>{{ Math.abs(estimatedCost).toFixed(2) }}</strong> coins
            </template>
          </v-alert>

          <v-btn
            color="primary"
            block
            size="large"
            :loading="submitting"
            :disabled="!canSubmitTrade"
            @click="handleTrade"
          >
            {{ tradeMode === 'buy' ? 'Buy' : 'Sell' }} {{ shareAmount }} share{{
              shareAmount !== 1 ? 's' : ''
            }}
            of "{{ market.outcomes[selectedOutcome] }}"
          </v-btn>

          <v-alert v-if="marketsStore.error" type="error" variant="tonal" class="mt-3">
            {{ marketsStore.error }}
          </v-alert>
        </v-card-text>
      </v-card>

      <!-- Creator actions: resolve or cancel -->
      <v-card
        v-if="isCreator && (market.status === 'open' || market.status === 'closed')"
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
          <v-alert v-if="marketsStore.error" type="error" variant="tonal" class="mt-3">
            {{ marketsStore.error }}
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
              <v-radio
                v-for="(outcome, i) in market.outcomes"
                :key="i"
                :label="outcome"
                :value="i"
              />
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
          Recent Trades ({{ marketsStore.trades.length }})
        </v-card-title>
        <v-list v-if="marketsStore.trades.length > 0" density="compact">
          <v-list-item v-for="trade in marketsStore.trades" :key="trade.id">
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
              "{{ market.outcomes[trade.outcomeIndex] }}"
            </v-list-item-title>
            <v-list-item-subtitle class="text-caption">
              {{ trade.shares > 0 ? 'Paid' : 'Received' }}
              {{ Math.abs(trade.cost).toFixed(2) }} coins
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
