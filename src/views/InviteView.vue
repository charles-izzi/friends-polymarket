<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useMarketStore } from '@/stores/market'

const route = useRoute()
const router = useRouter()
const marketStore = useMarketStore()

const status = ref<'joining' | 'error'>('joining')
const errorMsg = ref('')

onMounted(async () => {
  const code = route.params.code as string

  try {
    const marketId = await marketStore.joinMarket(code)
    router.replace(`/${marketId}`)
  } catch (e: unknown) {
    status.value = 'error'
    errorMsg.value = e instanceof Error ? e.message : 'Failed to join market'
  }
})
</script>

<template>
  <v-container class="fill-height d-flex align-center justify-center">
    <div v-if="status === 'joining'" class="text-center">
      <v-progress-circular indeterminate size="48" color="primary" class="mb-4" />
      <p class="text-body-1">Joining market...</p>
    </div>
    <v-card v-else max-width="400" class="pa-4 text-center">
      <v-icon icon="mdi-alert-circle" color="error" size="48" class="mb-2" />
      <v-card-title class="text-h6">Unable to Join</v-card-title>
      <v-card-text>{{ errorMsg }}</v-card-text>
      <v-card-actions class="justify-center">
        <v-btn color="primary" to="/join">Go to Join Page</v-btn>
      </v-card-actions>
    </v-card>
  </v-container>
</template>
