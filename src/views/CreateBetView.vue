<script setup lang="ts">
import { ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import { useSmartBack } from '@/composables/useSmartBack'
import { useMarketStore } from '@/stores/market'
import { useBetsStore } from '@/stores/bets'
import { useAuthStore } from '@/stores/auth'

const router = useRouter()
const marketStore = useMarketStore()
const betsStore = useBetsStore()
const authStore = useAuthStore()
const { goBack } = useSmartBack(`/${marketStore.market?.id ?? ''}/bets`)

const question = ref('')
const type = ref<'binary' | 'multiple_choice'>('binary')
const outcomes = ref(['Yes', 'No'])
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
const filledOutcomes = computed(() => outcomes.value.filter((o) => o.trim()))
const outcomesError = computed(() =>
  validated.value && type.value === 'multiple_choice' && filledOutcomes.value.length < 2
    ? 'At least 2 non-empty outcomes are required'
    : '',
)

const otherMembers = computed(() => marketStore.members)

function addOutcome() {
  outcomes.value.push('')
}

function removeOutcome(index: number) {
  outcomes.value.splice(index, 1)
}

function moveOutcome(index: number, direction: -1 | 1) {
  const target = index + direction
  if (target < 0 || target >= outcomes.value.length) return
  const arr = outcomes.value
  ;[arr[index], arr[target]] = [arr[target]!, arr[index]!]
}

function onTypeChange(newType: 'binary' | 'multiple_choice') {
  if (newType === 'binary') {
    outcomes.value = ['Yes', 'No']
  } else {
    outcomes.value = ['', '']
  }
}

async function handleSubmit() {
  validated.value = true
  const trimmedOutcomes = outcomes.value.filter((o) => o.trim()).map((o) => o.trim())
  if (!question.value.trim() || !closesAt.value || trimmedOutcomes.length < 2) return
  submitting.value = true
  try {
    await betsStore.createBet({
      question: question.value,
      type: type.value,
      outcomes: trimmedOutcomes,
      excludedMembers: excludedMembers.value,
      closesAt: new Date(closesAt.value).toISOString(),
    })
    router.push(`/${marketStore.market!.id}/bets`)
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <v-container max-width="600" class="pt-0">
    <div class="d-flex align-center mb-0">
      <v-btn icon="mdi-arrow-left" variant="text" @click="goBack()" />
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
        class="mb-2"
        @update:model-value="onTypeChange"
      >
        <v-btn value="binary">Yes / No</v-btn>
        <v-btn value="multiple_choice">Multiple Choice</v-btn>
      </v-btn-toggle>

      <template v-if="type === 'multiple_choice'">
        <fieldset class="outcomes-fieldset mb-4">
          <legend class="outcomes-legend">Outcomes</legend>
          <div v-for="(_, i) in outcomes" :key="i" class="d-flex align-center mb-2">
            <div class="d-flex flex-column mr-1">
              <v-btn
                icon="mdi-chevron-up"
                size="x-small"
                variant="text"
                density="compact"
                :disabled="i === 0"
                @click="moveOutcome(i, -1)"
              />
              <v-btn
                icon="mdi-chevron-down"
                size="x-small"
                variant="text"
                density="compact"
                :disabled="i === outcomes.length - 1"
                @click="moveOutcome(i, 1)"
              />
            </div>
            <v-text-field
              v-model="outcomes[i]"
              :placeholder="`Option ${i + 1}`"
              variant="outlined"
              density="compact"
              hide-details
              class="flex-grow-1"
            />
            <v-btn
              icon="mdi-close"
              size="small"
              variant="text"
              color="error"
              class="ml-1"
              @click="removeOutcome(i)"
            />
          </div>
          <p v-if="outcomesError" class="text-caption text-error mt-1">{{ outcomesError }}</p>
          <v-btn
            prepend-icon="mdi-plus"
            variant="tonal"
            size="small"
            :disabled="outcomes.length >= 10"
            class="mt-1"
            @click="addOutcome"
          >
            Add option
          </v-btn>
        </fieldset>
      </template>

      <v-text-field
        v-model="closesAt"
        label="Betting closes at"
        type="datetime-local"
        variant="outlined"
        :disabled="submitting"
        :rules="closesAtRules"
        hide-details="auto"
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

<style scoped>
.outcomes-fieldset {
  border: 1px solid rgba(var(--v-theme-on-surface), 0.38);
  border-radius: 4px;
  padding: 12px;
  margin: 0 0 16px;
}
.outcomes-legend {
  font-size: 0.75rem;
  padding: 0 5px;
  color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
}
</style>
