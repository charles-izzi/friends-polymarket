<script setup lang="ts">
import { useMarketStore } from '@/stores/market'
import { useRouter } from 'vue-router'
import { computed } from 'vue'

const marketStore = useMarketStore()
const router = useRouter()

const inviteCode = computed(() => marketStore.market?.inviteCode ?? '')
</script>

<template>
  <v-container>
    <div class="mb-6">
      <h1 class="text-h4">{{ marketStore.market?.name }}</h1>
      <p class="text-body-2 text-medium-emphasis mt-1">
        Invite code:
        <code class="text-primary">{{ inviteCode }}</code>
      </p>
    </div>

    <v-card class="mb-6">
      <v-card-title class="text-h6">Your Balance</v-card-title>
      <v-card-text>
        <span
          class="text-h3"
          :class="(marketStore.currentMember?.balance ?? 0) < 0 ? 'text-error' : 'text-primary'"
        >
          ${{
            marketStore.currentMember?.balance?.toLocaleString(undefined, {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            }) ?? '0.00'
          }}
        </span>
      </v-card-text>
    </v-card>

    <v-btn
      color="primary"
      block
      size="large"
      prepend-icon="mdi-chart-line"
      class="mb-6"
      @click="router.push('/bets')"
    >
      View Bets
    </v-btn>

    <v-card>
      <v-card-title class="text-h6"> Members ({{ marketStore.members.length }}) </v-card-title>
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
