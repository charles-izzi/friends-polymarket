<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { useMarketStore } from '@/stores/market'

const marketStore = useMarketStore()
const router = useRouter()

const tab = ref<'join' | 'create'>('join')
const inviteCode = ref('')
const marketName = ref('')
const submitting = ref(false)

async function handleJoin() {
  submitting.value = true
  try {
    const marketId = await marketStore.joinMarket(inviteCode.value)
    router.replace(`/${marketId}`)
  } finally {
    submitting.value = false
  }
}

async function handleCreate() {
  submitting.value = true
  try {
    const marketId = await marketStore.createMarket(marketName.value)
    router.replace(`/${marketId}`)
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <v-container class="fill-height d-flex align-center justify-center">
    <v-card max-width="450" width="100%" class="pa-4">
      <v-card-title class="text-h6 text-center mb-1">Get Started</v-card-title>

      <v-tabs v-model="tab" grow class="mb-4">
        <v-tab value="join">Join Market</v-tab>
        <v-tab value="create">Create Market</v-tab>
      </v-tabs>

      <v-card-text>
        <v-window v-model="tab">
          <v-window-item value="join">
            <p class="text-body-2 text-medium-emphasis mb-4">
              Enter an invite code from a friend to join their market.
            </p>
            <v-form @submit.prevent="handleJoin">
              <v-text-field
                v-model="inviteCode"
                label="Invite Code"
                variant="outlined"
                density="comfortable"
                placeholder="e.g. a1b2c3d4"
                :disabled="submitting"
              />
              <v-btn
                type="submit"
                color="primary"
                block
                size="large"
                :loading="submitting"
                :disabled="!inviteCode.trim()"
              >
                Join Market
              </v-btn>
            </v-form>
          </v-window-item>

          <v-window-item value="create">
            <p class="text-body-2 text-medium-emphasis mb-4">
              Create a new market and invite your friends.
            </p>
            <v-form @submit.prevent="handleCreate">
              <v-text-field
                v-model="marketName"
                label="Market Name"
                variant="outlined"
                density="comfortable"
                placeholder="e.g. The Boys"
                :disabled="submitting"
              />
              <v-btn
                type="submit"
                color="primary"
                block
                size="large"
                :loading="submitting"
                :disabled="!marketName.trim()"
              >
                Create Market
              </v-btn>
            </v-form>
          </v-window-item>
        </v-window>

        <v-alert v-if="marketStore.error" type="error" variant="tonal" class="mt-4">
          {{ marketStore.error }}
        </v-alert>
      </v-card-text>
    </v-card>
  </v-container>
</template>
