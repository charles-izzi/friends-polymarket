<script setup lang="ts">
import { useAuthStore } from '@/stores/auth'
import { useMarketStore } from '@/stores/market'
import { useRouter } from 'vue-router'
import { computed } from 'vue'

const authStore = useAuthStore()
const marketStore = useMarketStore()
const router = useRouter()

const inviteCode = computed(() => marketStore.market?.inviteCode ?? '')

async function handleLogout() {
  marketStore.cleanup()
  await authStore.logout()
  router.replace('/login')
}
</script>

<template>
  <v-container>
    <div class="d-flex align-center justify-space-between mb-6">
      <div>
        <h1 class="text-h4">{{ marketStore.market?.name }}</h1>
        <p class="text-body-2 text-medium-emphasis mt-1">
          Invite code:
          <code class="text-primary">{{ inviteCode }}</code>
        </p>
      </div>
      <v-btn color="primary" variant="outlined" size="small" @click="handleLogout">
        Sign Out
      </v-btn>
    </div>

    <v-card class="mb-6">
      <v-card-title class="text-h6">Your Balance</v-card-title>
      <v-card-text>
        <span class="text-h3 text-primary">
          {{ marketStore.currentMember?.balance?.toLocaleString() ?? 0 }}
        </span>
        <span class="text-body-1 ml-1">coins</span>
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
          :subtitle="`${member.balance.toLocaleString()} coins`"
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
