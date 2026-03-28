<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { useServerStore } from '@/stores/server'

const serverStore = useServerStore()
const router = useRouter()

const tab = ref<'join' | 'create'>('join')
const inviteCode = ref('')
const serverName = ref('')
const submitting = ref(false)

async function handleJoin() {
  submitting.value = true
  try {
    await serverStore.joinServer(inviteCode.value)
    router.replace('/')
  } finally {
    submitting.value = false
  }
}

async function handleCreate() {
  submitting.value = true
  try {
    await serverStore.createServer(serverName.value)
    router.replace('/')
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <v-container class="fill-height d-flex align-center justify-center">
    <v-card max-width="450" width="100%" class="pa-4">
      <v-card-title class="text-h5 text-center mb-2">Get Started</v-card-title>

      <v-tabs v-model="tab" grow class="mb-4">
        <v-tab value="join">Join Server</v-tab>
        <v-tab value="create">Create Server</v-tab>
      </v-tabs>

      <v-card-text>
        <v-window v-model="tab">
          <v-window-item value="join">
            <p class="text-body-2 text-medium-emphasis mb-4">
              Enter an invite code from a friend to join their server.
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
                Join Server
              </v-btn>
            </v-form>
          </v-window-item>

          <v-window-item value="create">
            <p class="text-body-2 text-medium-emphasis mb-4">
              Create a new server and invite your friends.
            </p>
            <v-form @submit.prevent="handleCreate">
              <v-text-field
                v-model="serverName"
                label="Server Name"
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
                :disabled="!serverName.trim()"
              >
                Create Server
              </v-btn>
            </v-form>
          </v-window-item>
        </v-window>

        <v-alert v-if="serverStore.error" type="error" variant="tonal" class="mt-4">
          {{ serverStore.error }}
        </v-alert>
      </v-card-text>
    </v-card>
  </v-container>
</template>
