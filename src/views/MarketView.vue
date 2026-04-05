<script setup lang="ts">
import { useMarketStore } from '@/stores/market'
import { useBetsStore } from '@/stores/bets'
import { useRouter } from 'vue-router'
import { computed, ref, onMounted } from 'vue'
import type { Bet } from '@/types'

const marketStore = useMarketStore()
const betsStore = useBetsStore()
const router = useRouter()

onMounted(() => {
  betsStore.listenToBets()
})

const copied = ref(false)
const inviteUrl = computed(() => {
  const code = marketStore.market?.inviteCode ?? ''
  return `${window.location.origin}/invite/${code}`
})

const topBets = computed(() =>
  [...betsStore.bets]
    .sort((a, b) => {
      const aOpen = a.status === 'open' ? 0 : 1
      const bOpen = b.status === 'open' ? 0 : 1
      if (aOpen !== bOpen) return aOpen - bOpen
      return b.createdAt.toMillis() - a.createdAt.toMillis()
    })
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
  switch (bet.status) {
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
          @click="router.push('/bets')"
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
          <v-list-item class="cursor-pointer pr-2" @click="router.push(`/bets/${bet.id}`)">
            <v-list-item-title class="text-body-2 font-weight-medium" style="margin-right: 12px">
              {{ bet.question }}
            </v-list-item-title>
            <v-list-item-subtitle class="text-caption" style="margin-right: 12px">
              {{ topOutcome(bet).label }} at {{ topOutcome(bet).pct }}
            </v-list-item-subtitle>
            <template #append>
              <v-chip :color="statusColor(bet)" size="x-small" variant="tonal">
                {{ bet.status }}
              </v-chip>
            </template>
          </v-list-item>
        </template>
      </v-list>

      <v-card-text v-else class="text-center text-medium-emphasis py-4"> No bets yet </v-card-text>
    </v-card>

    <v-card variant="flat">
      <v-list>
        <v-list-item
          v-for="member in marketStore.members"
          :key="member.userId"
          :title="member.displayName"
          :subtitle="`$${member.balance.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`"
        >
          <template #prepend>
            <v-avatar color="primary" size="36">
              <v-img v-if="member.photoURL" :src="member.photoURL" />
              <span v-else class="text-body-2">{{ member.displayName[0] }}</span>
            </v-avatar>
          </template>
          <template #append>
            <v-chip
              v-if="member.userId === marketStore.market?.ownerId"
              size="small"
              color="primary"
              variant="tonal"
            >
              Owner
            </v-chip>
          </template>
        </v-list-item>
      </v-list>
    </v-card>
  </v-container>
</template>
