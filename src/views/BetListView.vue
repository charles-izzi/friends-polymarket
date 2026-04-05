<script setup lang="ts">
import { onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useBetsStore } from '@/stores/bets'
import { useAuthStore } from '@/stores/auth'
import type { Bet } from '@/types'

const router = useRouter()
const betsStore = useBetsStore()
const authStore = useAuthStore()

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
  const days = Math.floor(diff / 86400000)
  const hours = Math.floor((diff % 86400000) / 3600000)
  const minutes = Math.floor((diff % 3600000) / 60000)
  if (days > 0) return `${days}d ${hours}h ${minutes}m left`
  if (hours > 0) return `${hours}h ${minutes}m left`
  return `${minutes}m left`
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
</script>

<template>
  <v-container>
    <div class="d-flex align-center justify-space-between mb-4">
      <div class="d-flex align-center ga-2">
        <v-btn icon="mdi-arrow-left" variant="text" @click="router.push('/')" />
        <h1 class="text-h5">Bets</h1>
      </div>
      <v-btn color="primary" prepend-icon="mdi-plus" @click="router.push('/bets/create')">
        New Bet
      </v-btn>
    </div>

    <v-progress-linear v-if="betsStore.loading" indeterminate class="mb-4" />

    <div v-if="!betsStore.loading && betsStore.bets.length === 0" class="text-center py-8">
      <v-icon icon="mdi-chart-line" size="64" color="grey-lighten-1" class="mb-4" />
      <p class="text-h6 text-medium-emphasis">No bets yet</p>
      <p class="text-body-2 text-medium-emphasis mb-4">Create the first one!</p>
      <v-btn color="primary" @click="router.push('/bets/create')">Create a Bet</v-btn>
    </div>

    <v-card
      v-for="bet in betsStore.bets"
      :key="bet.id"
      class="mb-3 cursor-pointer"
      variant="outlined"
      hover
      @click="router.push(`/bets/${bet.id}`)"
    >
      <v-card-text>
        <div class="d-flex align-center justify-space-between mb-2">
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
              v-else-if="effectiveStatus(bet) === 'closed' && bet.createdBy === authStore.user?.uid"
            >
              <v-icon icon="mdi-alert-circle" size="x-small" color="warning" class="mr-1" />
              Needs resolution
            </template>
          </span>
        </div>

        <p class="text-subtitle-1 font-weight-medium mb-3">{{ bet.question }}</p>

        <div class="d-flex flex-wrap ga-2">
          <v-chip
            v-for="(outcome, i) in bet.outcomes"
            :key="i"
            :color="i === 0 ? 'primary' : 'default'"
            variant="tonal"
            size="small"
          >
            {{ outcome }}
            <span class="ml-1 font-weight-bold">{{ getPriceLabel(bet, i) }}</span>
          </v-chip>
        </div>

        <div v-if="bet.outcomes.length === 2" class="mt-3">
          <v-progress-linear
            :model-value="(betsStore.getPrices(bet)[0] ?? 0) * 100"
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
