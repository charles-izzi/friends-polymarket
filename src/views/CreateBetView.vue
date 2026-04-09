<script setup lang="ts">
import { ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import { useMarketStore } from '@/stores/market'
import { useBetsStore } from '@/stores/bets'
import { useAuthStore } from '@/stores/auth'

const router = useRouter()
const marketStore = useMarketStore()
const betsStore = useBetsStore()
const authStore = useAuthStore()

const question = ref('')
const type = ref<'binary' | 'multiple_choice'>('binary')
const outcomes = ref(['Yes', 'No'])
const customOutcome = ref('')
const excludedMembers = ref<string[]>([])
const closesAt = ref('')
const submitting = ref(false)
const validated = ref(false)

const questionRules = computed(() =>
  validated.value && !question.value.trim() ? ['Question is required'] : [],
)
const closesAtRules = computed(() =>
  validated.value && !closesAt.value ? ['Close date is required'] : [],
)
const outcomesError = computed(() =>
  validated.value && type.value === 'multiple_choice' && outcomes.value.length < 2
    ? 'At least 2 outcomes are required'
    : '',
)

const otherMembers = computed(() =>
  marketStore.members.filter((m) => m.userId !== authStore.user?.uid),
)

const minDateTime = computed(() => {
  const d = new Date()
  d.setMinutes(d.getMinutes() + 5)
  // Format as YYYY-MM-DDTHH:mm for datetime-local input
  return d.toISOString().slice(0, 16)
})

function addOutcome() {
  const val = customOutcome.value.trim()
  if (val && !outcomes.value.includes(val)) {
    outcomes.value.push(val)
    customOutcome.value = ''
  }
}

function removeOutcome(index: number) {
  if (outcomes.value.length > 2) {
    outcomes.value.splice(index, 1)
  }
}

function onTypeChange(newType: 'binary' | 'multiple_choice') {
  if (newType === 'binary') {
    outcomes.value = ['Yes', 'No']
  } else {
    outcomes.value = []
  }
}

async function handleSubmit() {
  validated.value = true
  if (!question.value.trim() || !closesAt.value || outcomes.value.length < 2) return
  submitting.value = true
  try {
    await betsStore.createBet({
      question: question.value,
      type: type.value,
      outcomes: outcomes.value,
      excludedMembers: excludedMembers.value,
      closesAt: new Date(closesAt.value).toISOString(),
    })
    router.push('/bets')
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <v-container max-width="600" class="pt-0">
    <div class="d-flex align-center mb-0">
      <v-btn icon="mdi-arrow-left" variant="text" @click="router.back()" />
      <h1 class="text-h6 ml-2">Create a Bet</h1>
    </div>

    <v-form @submit.prevent="handleSubmit">
      <v-textarea
        v-model="question"
        label="Question"
        placeholder="e.g. Will Cameron eat the whole pizza in 1 hour?"
        variant="outlined"
        rows="2"
        :disabled="submitting"
        :rules="questionRules"
        class="mb-2"
      />

      <v-btn-toggle
        v-model="type"
        mandatory
        density="comfortable"
        color="primary"
        class="mb-4"
        @update:model-value="onTypeChange"
      >
        <v-btn value="binary">Yes / No</v-btn>
        <v-btn value="multiple_choice">Multiple Choice</v-btn>
      </v-btn-toggle>

      <template v-if="type === 'multiple_choice'">
        <v-card variant="outlined" class="mb-4 pa-3">
          <p class="text-subtitle-2 mb-2">Outcomes</p>
          <v-chip
            v-for="(outcome, i) in outcomes"
            :key="i"
            :closable="outcomes.length > 2"
            class="ma-1"
            @click:close="removeOutcome(i)"
          >
            {{ outcome }}
          </v-chip>
          <p v-if="outcomesError" class="text-caption text-error mt-1">{{ outcomesError }}</p>
          <div class="d-flex align-center mt-2">
            <v-text-field
              v-model="customOutcome"
              label="Add outcome"
              variant="outlined"
              density="compact"
              hide-details
              class="mr-2"
              @keydown.enter.prevent="addOutcome"
            />
            <v-btn
              icon="mdi-plus"
              size="small"
              color="primary"
              :disabled="!customOutcome.trim() || outcomes.length >= 10"
              @click="addOutcome"
            />
          </div>
        </v-card>
      </template>

      <v-text-field
        v-model="closesAt"
        label="Betting closes at"
        type="datetime-local"
        variant="outlined"
        :min="minDateTime"
        :disabled="submitting"
        :rules="closesAtRules"
        class="mb-2"
      />

      <v-select
        v-model="excludedMembers"
        :items="otherMembers"
        item-title="displayName"
        item-value="userId"
        label="Exclude members (optional)"
        variant="outlined"
        multiple
        chips
        closable-chips
        hint="Excluded members cannot trade on this bet"
        persistent-hint
        :disabled="submitting"
        class="mb-4"
      />

      <v-btn
        type="submit"
        color="primary"
        block
        size="large"
        :loading="submitting"
        :disabled="submitting"
      >
        Create Bet
      </v-btn>

      <v-alert v-if="betsStore.error" type="error" variant="tonal" class="mt-4">
        {{ betsStore.error }}
      </v-alert>
    </v-form>
  </v-container>
</template>
