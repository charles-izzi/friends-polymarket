<script setup lang="ts">
import { onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useMarketsStore } from '@/stores/markets'
import type { Market } from '@/types'

const router = useRouter()
const marketsStore = useMarketsStore()

onMounted(() => {
  marketsStore.listenToMarkets()
})

function getPriceLabel(market: Market, index: number): string {
  const prices = marketsStore.getPrices(market)
  return `${((prices[index] ?? 0) * 100).toFixed(0)}%`
}

function topOutcome(market: Market): { label: string; pct: string } {
  const prices = marketsStore.getPrices(market)
  let maxIdx = 0
  for (let i = 1; i < prices.length; i++) {
    if ((prices[i] ?? 0) > (prices[maxIdx] ?? 0)) maxIdx = i
  }
  return {
    label: market.outcomes[maxIdx] ?? '',
    pct: `${((prices[maxIdx] ?? 0) * 100).toFixed(0)}%`,
  }
}

function timeRemaining(market: Market): string {
  const closes = market.closesAt.toDate()
  const now = new Date()
  if (closes <= now) return 'Closed'
  const diff = closes.getTime() - now.getTime()
  const hours = Math.floor(diff / 3600000)
  const days = Math.floor(hours / 24)
  if (days > 0) return `${days}d ${hours % 24}h left`
  if (hours > 0) return `${hours}h left`
  const mins = Math.floor(diff / 60000)
  return `${mins}m left`
}

function statusColor(market: Market): string {
  switch (market.status) {
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
</script>

<template>
  <v-container>
    <div class="d-flex align-center justify-space-between mb-4">
      <h1 class="text-h5">Markets</h1>
      <v-btn color="primary" prepend-icon="mdi-plus" @click="router.push('/markets/create')">
        New Bet
      </v-btn>
    </div>

    <v-progress-linear v-if="marketsStore.loading" indeterminate class="mb-4" />

    <div v-if="!marketsStore.loading && marketsStore.markets.length === 0" class="text-center py-8">
      <v-icon icon="mdi-chart-line" size="64" color="grey-lighten-1" class="mb-4" />
      <p class="text-h6 text-medium-emphasis">No bets yet</p>
      <p class="text-body-2 text-medium-emphasis mb-4">Create the first one!</p>
      <v-btn color="primary" @click="router.push('/markets/create')">Create a Bet</v-btn>
    </div>

    <v-card
      v-for="market in marketsStore.markets"
      :key="market.id"
      class="mb-3 cursor-pointer"
      variant="outlined"
      hover
      @click="router.push(`/markets/${market.id}`)"
    >
      <v-card-text>
        <div class="d-flex align-center justify-space-between mb-2">
          <v-chip :color="statusColor(market)" size="small" variant="tonal">
            {{ market.status }}
          </v-chip>
          <span class="text-caption text-medium-emphasis">
            <template v-if="market.status === 'open'">{{ timeRemaining(market) }}</template>
            <template v-else-if="market.status === 'resolved' && market.resolvedOutcome !== null">
              Winner: {{ market.outcomes[market.resolvedOutcome] }}
            </template>
            <template v-else-if="market.status === 'cancelled'">Refunded</template>
          </span>
        </div>

        <p class="text-subtitle-1 font-weight-medium mb-3">{{ market.question }}</p>

        <div class="d-flex flex-wrap ga-2">
          <v-chip
            v-for="(outcome, i) in market.outcomes"
            :key="i"
            :color="i === 0 ? 'primary' : 'default'"
            variant="tonal"
            size="small"
          >
            {{ outcome }}
            <span class="ml-1 font-weight-bold">{{ getPriceLabel(market, i) }}</span>
          </v-chip>
        </div>

        <div v-if="market.outcomes.length === 2" class="mt-3">
          <v-progress-linear
            :model-value="(marketsStore.getPrices(market)[0] ?? 0) * 100"
            color="primary"
            bg-color="grey-lighten-2"
            height="8"
            rounded
          />
        </div>
      </v-card-text>
    </v-card>
  </v-container>
</template>
