<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from 'vue'
import type { ComponentPublicInstance } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useSmartBack } from '@/composables/useSmartBack'
import { useSwipe } from '@/composables/useSwipe'
import { useFilteredBets } from '@/composables/useFilteredBets'
import { useBetsStore } from '@/stores/bets'
import { useMarketStore } from '@/stores/market'
import { useAuthStore } from '@/stores/auth'
import { useCommentsStore } from '@/stores/comments'
import { calcCost, calcEffectiveB, calcPrices, rescaleShares } from '@/utils/lmsr'
import SvgLineChart from '@/components/SvgLineChart.vue'
import type { ChartSeries } from '@/components/SvgLineChart.vue'

const route = useRoute()
const router = useRouter()
const betsStore = useBetsStore()
const marketStore = useMarketStore()
const authStore = useAuthStore()
const commentsStore = useCommentsStore()
const { sortedBets: filteredBetList } = useFilteredBets()
const { goBack } = useSmartBack(`/${marketStore.market?.id ?? ''}/bets`)

// Swipe navigation between bets
const currentIndex = computed(() => filteredBetList.value.findIndex((b) => b.id === betId.value))

// Swipe animation state
const ANIM_MS = 200
type SlideState = 'idle' | 'exiting' | 'entering-setup' | 'entering'
const slideState = ref<SlideState>('idle')
const slideDirection = ref<1 | -1>(1)

async function navigateToBet(direction: 1 | -1) {
  if (slideState.value !== 'idle') return
  const list = filteredBetList.value
  if (list.length === 0) return
  const idx = currentIndex.value
  const nextIdx = idx + direction
  if (nextIdx < 0 || nextIdx >= list.length) return

  slideDirection.value = direction

  // Exit: animate current content off-screen
  slideState.value = 'exiting'
  await new Promise<void>((r) => setTimeout(r, ANIM_MS))

  // Navigate
  await router.replace(`/${marketStore.market!.id}/bets/${list[nextIdx]!.id}`)
  resetSwipe()

  // Position new content off-screen on opposite side (no transition)
  slideState.value = 'entering-setup'
  await nextTick()
  await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))

  // Animate in
  slideState.value = 'entering'
  await new Promise<void>((r) => setTimeout(r, ANIM_MS))

  slideState.value = 'idle'
}

const { swipeDeltaX, resetSwipe } = useSwipe({
  ignore: '.v-slider-thumb, .holdings-scroll',
  onSwipeLeft: () => navigateToBet(1),
  onSwipeRight: () => navigateToBet(-1),
})

const contentStyle = computed(() => {
  const state = slideState.value
  if (state === 'exiting') {
    const x = slideDirection.value === 1 ? '-100%' : '100%'
    return {
      transform: `translateX(${x})`,
      transition: `transform ${ANIM_MS}ms ease-in, opacity ${ANIM_MS}ms ease-in`,
      opacity: '0',
    }
  }
  if (state === 'entering-setup') {
    const x = slideDirection.value === 1 ? '60%' : '-60%'
    return {
      transform: `translateX(${x})`,
      transition: 'none',
      opacity: '0',
    }
  }
  if (state === 'entering') {
    return {
      transform: 'translateX(0)',
      transition: `transform ${ANIM_MS}ms ease-out, opacity ${ANIM_MS}ms ease-out`,
      opacity: '1',
    }
  }
  // idle — follow finger during drag
  if (swipeDeltaX.value !== 0) {
    const damped = swipeDeltaX.value * 0.3
    return {
      transform: `translateX(${damped}px)`,
      transition: 'none',
    }
  }
  return { transition: 'transform 0.15s ease-out' }
})

const canSwipeNext = computed(
  () => currentIndex.value >= 0 && currentIndex.value < filteredBetList.value.length - 1,
)
const canSwipePrev = computed(() => currentIndex.value > 0)

const betId = computed(() => route.params.id as string)
const bet = computed(() => betsStore.bets.find((m) => m.id === betId.value) ?? null)
const prices = computed(() => (bet.value ? betsStore.getPrices(bet.value) : []))
const position = computed(() => betsStore.currentPosition)

const submitting = ref(false)
const resolveOutcome = ref(0)
const resolveResolvesAt = ref('')
const showResolveDialog = ref(false)
const showCancelDialog = ref(false)
const showUnresolveDialog = ref(false)
const showContestDialog = ref(false)
const showEditDialog = ref(false)
const resolving = ref(false)
const unresolving = ref(false)
const contesting = ref(false)
const editSubmitting = ref(false)
const detailTab = ref('chart')

// Edit form state
const editQuestion = ref('')
const editOutcomes = ref<string[]>([])
const editType = ref<'binary' | 'multiple_choice'>('binary')
const editExcludedMembers = ref<string[]>([])
const editClosesAt = ref('')
const editValidated = ref(false)
const editErrors = ref<Record<string, string>>({})

const now = ref(Date.now())
let nowInterval: ReturnType<typeof setInterval> | null = null

const newCommentText = ref('')
const sendBtnRef = ref<ComponentPublicInstance | null>(null)
const holdingsScrollRef = ref<HTMLElement | null>(null)
const pendingImage = ref<File | null>(null)
const pendingImagePreview = ref<string | null>(null)
const imageInputRef = ref<HTMLInputElement | null>(null)

const MAX_IMAGE_SIZE = 5 * 1024 * 1024

function attachImage(file: File) {
  if (!file.type.startsWith('image/')) {
    commentsStore.error = 'Only image files are supported'
    return
  }
  if (file.size > MAX_IMAGE_SIZE) {
    commentsStore.error = 'Image must be under 5 MB'
    return
  }
  commentsStore.error = ''
  pendingImage.value = file
  pendingImagePreview.value = URL.createObjectURL(file)
}

function removeImage() {
  if (pendingImagePreview.value) URL.revokeObjectURL(pendingImagePreview.value)
  pendingImage.value = null
  pendingImagePreview.value = null
  if (imageInputRef.value) imageInputRef.value.value = ''
}

function onImagePicked(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (file) attachImage(file)
}

function onCommentPaste(event: ClipboardEvent) {
  const items = event.clipboardData?.items
  if (!items) return
  for (const item of items) {
    if (item.type.startsWith('image/')) {
      const file = item.getAsFile()
      if (file) {
        attachImage(file)
        event.preventDefault()
      }
      return
    }
  }
}

const effectiveStatus = computed(() => {
  if (!bet.value) return 'open'
  if (bet.value.status !== 'open') return bet.value.status
  if (bet.value.closesAt.toDate().getTime() <= now.value) return 'closed'
  return 'open'
})

const isCreator = computed(() => bet.value?.createdBy === authStore.user?.uid)

const isExcluded = computed(() => bet.value?.excludedMembers.includes(authStore.user?.uid ?? ''))

// Compute invalidated trade refund for the current user when resolvesAt is set
const myInvalidatedCost = computed(() => {
  if (!bet.value?.resolvesAt || !authStore.user?.uid) return 0
  const cutoff = bet.value.resolvesAt.toMillis()
  const uid = authStore.user.uid
  return betsStore.trades
    .filter((t) => t.userId === uid && t.createdAt && t.createdAt.toMillis() > cutoff)
    .reduce((sum, t) => sum + t.cost, 0)
})

const myInvalidatedShares = computed(() => {
  if (!bet.value?.resolvesAt || !authStore.user?.uid || bet.value.resolvedOutcome === null) return 0
  const cutoff = bet.value.resolvesAt.toMillis()
  const uid = authStore.user.uid
  const outcome = bet.value.resolvedOutcome
  return betsStore.trades
    .filter(
      (t) =>
        t.userId === uid &&
        t.outcomeIndex === outcome &&
        t.createdAt &&
        t.createdAt.toMillis() > cutoff,
    )
    .reduce((sum, t) => sum + t.shares, 0)
})

const myCommissionFee = computed(() => {
  if (!bet.value || !position.value || bet.value.resolvedOutcome === null) return 0
  const winningShares =
    (position.value.shares[bet.value.resolvedOutcome] ?? 0) - myInvalidatedShares.value
  if (winningShares <= 0) return 0
  return winningShares * (bet.value.commissionPerShare ?? 0)
})

const myNetCommission = computed(() => {
  if (!bet.value || !isCreator.value) return 0
  return (bet.value.creatorCommission ?? 0) - myCommissionFee.value
})

const myResolvedProfit = computed(() => {
  if (!bet.value || !position.value || bet.value.resolvedOutcome === null) return 0
  const payout = (position.value.shares[bet.value.resolvedOutcome] ?? 0) - myInvalidatedShares.value
  const cost = position.value.totalCost - myInvalidatedCost.value
  if (isCreator.value) {
    // Creator pays fee on own shares but receives full commission
    return payout - myCommissionFee.value + (bet.value.creatorCommission ?? 0) - cost
  }
  return payout - myCommissionFee.value - cost
})

const creatorAwaitingFirstWager = computed(
  () => isCreator.value && bet.value?.totalVolume === 0 && effectiveStatus.value === 'open',
)

const hasTrades = computed(() => (betsStore.trades.length ?? 0) > 0)

const excludedMemberNames = computed(() => {
  if (!bet.value || bet.value.excludedMembers.length === 0) return []
  return bet.value.excludedMembers.map((id) => memberName(id)).filter((n) => n !== 'Unknown')
})

const canTrade = computed(() => {
  if (!bet.value || effectiveStatus.value !== 'open' || isExcluded.value) return false
  // Creator cannot be first to wager
  if (isCreator.value && bet.value.totalVolume === 0) return false
  return true
})

// Per-outcome desired share counts (sliders)
const desiredShares = ref<number[]>([])
const userEdited = ref(false)

function syncDesiredShares() {
  if (!bet.value) return
  desiredShares.value = bet.value.outcomes.map((_, i) => position.value?.shares[i] ?? 0)
}

// Compute the delta per outcome
const tradeDiffs = computed(() => {
  if (!bet.value) return []
  return bet.value.outcomes.map((_, i) => {
    const current = position.value?.shares[i] ?? 0
    const desired = desiredShares.value[i] ?? 0
    return desired - current
  })
})

const hasPendingTrades = computed(() => tradeDiffs.value.some((d) => d !== 0))

// Sync sliders from position, but only if user hasn't manually edited
watch(
  [bet, position],
  () => {
    if (!userEdited.value) {
      syncDesiredShares()
    }
  },
  { immediate: true },
)

// Compute cost for each changed outcome
const tradeCosts = computed(() => {
  if (!bet.value) return []
  const totalVolume = bet.value.totalVolume ?? 0
  const bMax = bet.value.liquidityParam
  const bBefore = calcEffectiveB(totalVolume, bMax)
  // Cost is computed at the current b (before the trade), matching server behavior
  return tradeDiffs.value.map((diff, i) => {
    if (diff === 0) return 0
    return calcCost(bet.value!.sharesSold, i, diff, bBefore)
  })
})

const totalCost = computed(() => tradeCosts.value.reduce((sum, c) => sum + c, 0))

const projectedPrices = computed(() => {
  if (!bet.value || !hasPendingTrades.value) return prices.value
  const totalVolume = bet.value.totalVolume ?? 0
  const bMax = bet.value.liquidityParam
  const bBefore = calcEffectiveB(totalVolume, bMax)
  // Build post-trade shares at current b, then rescale to bAfter for display
  const postTradeShares = [...bet.value.sharesSold]
  let projectedVolume = totalVolume
  for (let i = 0; i < tradeDiffs.value.length; i++) {
    const diff = tradeDiffs.value[i] ?? 0
    postTradeShares[i] = (postTradeShares[i] ?? 0) + diff
    projectedVolume += Math.abs(diff)
  }
  const bAfter = calcEffectiveB(projectedVolume, bMax)
  const rescaled = rescaleShares(postTradeShares, bBefore, bAfter)
  return calcPrices(rescaled, bAfter)
})

const holdingsNetCost = computed(() => position.value?.totalCost ?? 0)

const projectedNetCost = computed(() => holdingsNetCost.value + totalCost.value)

const holdingsProfitPotential = computed(() => {
  if (!bet.value) return { value: 0, outcome: '' }
  const cost = holdingsNetCost.value
  let bestIdx = 0
  let bestProfit = -Infinity
  bet.value.outcomes.forEach((_, i) => {
    const profit = (position.value?.shares[i] ?? 0) - cost
    if (profit > bestProfit) {
      bestProfit = profit
      bestIdx = i
    }
  })
  return {
    value: bestProfit === -Infinity ? 0 : bestProfit,
    outcome: bet.value.outcomes[bestIdx] ?? '',
  }
})

const projectedHoldingsProfitPotential = computed(() => {
  if (!bet.value) return { value: 0, outcome: '' }
  const cost = projectedNetCost.value
  let bestIdx = 0
  let bestProfit = -Infinity
  bet.value.outcomes.forEach((_, i) => {
    const shares = (position.value?.shares[i] ?? 0) + (tradeDiffs.value[i] ?? 0)
    const profit = shares - cost
    if (profit > bestProfit) {
      bestProfit = profit
      bestIdx = i
    }
  })
  return {
    value: bestProfit === -Infinity ? 0 : bestProfit,
    outcome: bet.value.outcomes[bestIdx] ?? '',
  }
})

const tradeActionLabel = computed(() => {
  const buys = tradeDiffs.value.filter((d) => d > 0).length
  const sells = tradeDiffs.value.filter((d) => d < 0).length
  if (buys > 0 && sells > 0) return 'Trade'
  if (sells > 0) return 'Sell'
  return 'Buy'
})

const limitWarnings = ref<Record<number, boolean>>({})

function onSliderUpdate(index: number, val: number) {
  userEdited.value = true
  if (val > 100) {
    desiredShares.value[index] = 100
    limitWarnings.value[index] = true
    setTimeout(() => (limitWarnings.value[index] = false), 2000)
  } else {
    desiredShares.value[index] = val
    limitWarnings.value[index] = false
  }
}

function resetSliders() {
  userEdited.value = false
  syncDesiredShares()
}

const timeRemaining = computed(() => {
  if (!bet.value || effectiveStatus.value !== 'open') return ''
  const diff = bet.value.closesAt.toDate().getTime() - now.value
  if (diff <= 0) return ''
  const years = Math.floor(diff / 31536000000)
  const months = Math.floor((diff % 31536000000) / 2592000000)
  const days = Math.floor((diff % 2592000000) / 86400000)
  const hours = Math.floor((diff % 86400000) / 3600000)
  const minutes = Math.floor((diff % 3600000) / 60000)
  const parts: string[] = []
  if (years > 0) parts.push(`${years}y`)
  if (months > 0) parts.push(`${months}mo`)
  if (days > 0) parts.push(`${days}d`)
  if (hours > 0) parts.push(`${hours}h`)
  if (minutes > 0) parts.push(`${minutes}m`)
  return parts.length > 0 ? `${parts.slice(0, 2).join(' ')} left` : ''
})

function memberName(userId: string): string {
  return marketStore.members.find((m) => m.userId === userId)?.displayName ?? 'Unknown'
}

function fmtTradeTime(ts: { seconds: number } | number): string {
  const ms = typeof ts === 'number' ? ts : ts.seconds * 1000
  const d = new Date(ms)
  const date = d.toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' })
  const time = d.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
  return `${date} ${time}`
}

async function handleTrades() {
  if (!hasPendingTrades.value || submitting.value) return
  submitting.value = true
  try {
    for (let i = 0; i < tradeDiffs.value.length; i++) {
      const diff = tradeDiffs.value[i] ?? 0
      if (diff === 0) continue
      await betsStore.executeTrade({
        betId: betId.value,
        outcomeIndex: i,
        shares: diff,
      })
    }
    userEdited.value = false
  } finally {
    submitting.value = false
  }
}

async function handleResolve() {
  resolving.value = true
  try {
    const resolvesAt = resolveResolvesAt.value
      ? new Date(resolveResolvesAt.value).toISOString()
      : undefined
    await betsStore.resolveBet(betId.value, resolveOutcome.value, resolvesAt)
    showResolveDialog.value = false
  } finally {
    resolving.value = false
  }
}

function openResolveDialog() {
  resolveResolvesAt.value = ''
  showResolveDialog.value = true
}

async function handleCancel() {
  resolving.value = true
  try {
    await betsStore.cancelBet(betId.value)
    showCancelDialog.value = false
  } finally {
    resolving.value = false
  }
}

async function handleUnresolve() {
  unresolving.value = true
  try {
    await betsStore.unresolveBet(betId.value)
    showUnresolveDialog.value = false
  } finally {
    unresolving.value = false
  }
}

async function handleContest() {
  contesting.value = true
  try {
    await betsStore.contestBet(betId.value)
    showContestDialog.value = false
  } finally {
    contesting.value = false
  }
}

const contestCount = computed(() => (bet.value?.contests ?? []).length)
const hasContested = computed(() => {
  const uid = authStore.user?.uid
  return uid ? (bet.value?.contests ?? []).includes(uid) : false
})

function openEditDialog() {
  if (!bet.value) return
  editQuestion.value = bet.value.question
  editOutcomes.value = [...bet.value.outcomes]
  editType.value = bet.value.type
  editExcludedMembers.value = [...bet.value.excludedMembers]
  // Format closesAt for datetime-local input
  const d = bet.value.closesAt.toDate()
  const pad = (n: number) => n.toString().padStart(2, '0')
  editClosesAt.value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
  editValidated.value = false
  editErrors.value = {}
  showEditDialog.value = true
}

function addEditOutcome() {
  editOutcomes.value.push('')
}

function removeEditOutcome(index: number) {
  editOutcomes.value.splice(index, 1)
}

function moveEditOutcome(index: number, direction: -1 | 1) {
  const target = index + direction
  if (target < 0 || target >= editOutcomes.value.length) return
  const arr = editOutcomes.value
  ;[arr[index], arr[target]] = [arr[target]!, arr[index]!]
}

async function handleEditSubmit() {
  if (!bet.value) return
  editValidated.value = true
  editErrors.value = {}

  const changes: {
    question?: string
    outcomes?: string[]
    excludedMembers?: string[]
    closesAt?: string
  } = {}

  // Validate question
  if (editQuestion.value.trim() !== bet.value.question) {
    if (!editQuestion.value.trim()) {
      editErrors.value.question = 'Question is required'
    } else {
      changes.question = editQuestion.value.trim()
    }
  }

  // Validate outcomes
  if (!hasTrades.value) {
    const trimmed = editOutcomes.value.filter((o) => o.trim())
    const origTrimmed = bet.value.outcomes
    const changed =
      trimmed.length !== origTrimmed.length || trimmed.some((o, i) => o.trim() !== origTrimmed[i])
    if (changed) {
      if (trimmed.length < 2) {
        editErrors.value.outcomes = 'At least 2 non-empty outcomes are required'
      } else {
        changes.outcomes = trimmed.map((o) => o.trim())
      }
    }
  }

  // Validate excluded members
  const origExcluded = bet.value.excludedMembers
  const newExcluded = editExcludedMembers.value
  if (JSON.stringify(origExcluded.slice().sort()) !== JSON.stringify(newExcluded.slice().sort())) {
    // Check no removals
    const removed = origExcluded.filter((id) => !newExcluded.includes(id))
    if (removed.length > 0) {
      editErrors.value.excludedMembers = 'Cannot remove previously excluded members'
    } else {
      // Check newly added members haven't already traded
      const newlyAdded = newExcluded.filter((id) => !origExcluded.includes(id))
      const positions = betsStore.allPositions[betId.value] ?? []
      const tradedIds = new Set(
        positions
          .filter((p) => p.totalCost > 0 || p.shares.some((s) => s > 0))
          .map((p) => p.userId),
      )
      const alreadyTraded = newlyAdded.filter((id) => tradedIds.has(id))
      if (alreadyTraded.length > 0) {
        const names = alreadyTraded.map((id) => memberName(id)).join(', ')
        editErrors.value.excludedMembers = `${names} already placed bets and cannot be excluded`
      } else {
        changes.excludedMembers = newExcluded
      }
    }
  }

  // Validate close date
  if (editClosesAt.value) {
    const newClose = new Date(editClosesAt.value)
    const currentClose = bet.value.closesAt.toDate()
    if (newClose.getTime() !== currentClose.getTime()) {
      if (newClose.getTime() <= currentClose.getTime()) {
        editErrors.value.closesAt = 'Close date can only be extended, not shortened'
      } else {
        changes.closesAt = newClose.toISOString()
      }
    }
  }

  if (Object.keys(editErrors.value).length > 0) return
  if (Object.keys(changes).length === 0) {
    showEditDialog.value = false
    return
  }

  editSubmitting.value = true
  try {
    await betsStore.editBet(betId.value, changes)
    showEditDialog.value = false
  } catch (e: unknown) {
    editErrors.value.general = e instanceof Error ? e.message : 'Failed to save changes'
  } finally {
    editSubmitting.value = false
  }
}

// --- Chart ---
const OUTCOME_COLORS = [
  '#5b8fa8',
  '#c47a6a',
  '#b5944f',
  '#7a9a6d',
  '#9b7db8',
  '#6a8f6d',
  '#7b8fb8',
  '#b85b7d',
  '#5ba8a0',
]

function getOutcomeColor(index: number): string {
  return OUTCOME_COLORS[index % OUTCOME_COLORS.length]!
}

const betPositions = computed(() => {
  const positions = betsStore.allPositions[betId.value] ?? []
  return positions.filter((p) => p.totalCost > 0 || p.shares.some((s) => s > 0))
})

const chartSeries = computed<ChartSeries[]>(() => {
  if (!bet.value) return []
  const n = bet.value.outcomes.length

  // Build chronological price points per outcome
  const points: number[][] = Array.from({ length: n }, () => [])

  // Initial equal prices
  for (let i = 0; i < n; i++) points[i]!.push((1 / n) * 100)

  // Trades are stored DESC — iterate in reverse for chronological order
  const trades = betsStore.trades
  for (let t = trades.length - 1; t >= 0; t--) {
    const trade = trades[t]!
    for (let i = 0; i < n; i++) {
      points[i]!.push((trade.priceAfter[i] ?? 0) * 100)
    }
  }

  return bet.value.outcomes.map((label, i) => ({
    label,
    color: getOutcomeColor(i),
    data: points[i]!,
  }))
})

const chartLabels = computed(() => {
  if (!bet.value) return []
  const count = chartSeries.value[0]?.data.length ?? 0
  return Array.from({ length: count }, (_, i) => (i === 0 ? 'Start' : `#${i}`))
})

function commentTimeAgo(ts: import('firebase/firestore').Timestamp): string {
  const diff = Date.now() - ts.toDate().getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

async function handlePostComment() {
  const text = newCommentText.value.trim()
  const image = pendingImage.value
  if (!text && !image) return
  try {
    await commentsStore.addComment(betId.value, text, image)
    newCommentText.value = ''
    removeImage()
  } catch {
    // error is set in store
  }
}

// Drag-to-scroll for .holdings-scroll (mouse only; touch uses native overflow scroll)
function initDragScroll(el: HTMLElement) {
  let isDown = false
  let startX = 0
  let scrollLeft = 0

  el.addEventListener('mousedown', (e: MouseEvent) => {
    // Only left button, and only if content overflows
    if (e.button !== 0 || el.scrollWidth <= el.clientWidth) return
    isDown = true
    startX = e.pageX - el.offsetLeft
    scrollLeft = el.scrollLeft
    el.style.cursor = 'grabbing'
    el.style.userSelect = 'none'
  })

  el.addEventListener('mouseleave', () => {
    if (!isDown) return
    isDown = false
    el.style.cursor = ''
    el.style.userSelect = ''
  })

  el.addEventListener('mouseup', () => {
    if (!isDown) return
    isDown = false
    el.style.cursor = ''
    el.style.userSelect = ''
  })

  el.addEventListener('mousemove', (e: MouseEvent) => {
    if (!isDown) return
    e.preventDefault()
    const x = e.pageX - el.offsetLeft
    el.scrollLeft = scrollLeft - (x - startX)
  })
}

function setupBetListeners(id: string) {
  betsStore.listenToBet(id)
  commentsStore.listenToComments(id)
  commentsStore.markSeen(id)
  userEdited.value = false
}

function updateSendButtonRect() {
  const el = sendBtnRef.value?.$el as HTMLElement | undefined
  if (!el) {
    commentsStore.submitButtonRect = null
    return
  }
  const r = el.getBoundingClientRect()
  commentsStore.submitButtonRect = { top: r.top, right: r.right, bottom: r.bottom, left: r.left }
}

onMounted(() => {
  if (!betsStore.bets.length) {
    betsStore.listenToBets()
  }
  setupBetListeners(betId.value)
  nowInterval = setInterval(() => (now.value = Date.now()), 60000)
  window.addEventListener('scroll', updateSendButtonRect, { passive: true, capture: true })
  window.addEventListener('resize', updateSendButtonRect, { passive: true })
})

// Attach drag-to-scroll when the holdings scroll container mounts
watch(holdingsScrollRef, (el) => {
  if (el) initDragScroll(el)
})

// Re-establish listeners when navigating between bet detail pages
watch(betId, (newId, oldId) => {
  if (newId === oldId) return
  betsStore.stopListeningToBet()
  commentsStore.stopListening()
  commentsStore.markSeen(oldId)
  setupBetListeners(newId)
})

onUnmounted(() => {
  betsStore.stopListeningToBet()
  commentsStore.stopListening()
  commentsStore.markSeen(betId.value)
  commentsStore.submitButtonRect = null
  window.removeEventListener('scroll', updateSendButtonRect, true)
  window.removeEventListener('resize', updateSendButtonRect)
  if (nowInterval) clearInterval(nowInterval)
})
</script>

<template>
  <!-- Swipe indicators -->
  <div
    v-if="canSwipePrev && swipeDeltaX > 0"
    class="swipe-indicator swipe-indicator-left"
    :style="{ opacity: Math.min(1, swipeDeltaX / 50) }"
  >
    <v-icon>mdi-chevron-left</v-icon>
  </div>
  <div
    v-if="canSwipeNext && swipeDeltaX < 0"
    class="swipe-indicator swipe-indicator-right"
    :style="{ opacity: Math.min(1, -swipeDeltaX / 50) }"
  >
    <v-icon>mdi-chevron-right</v-icon>
  </div>

  <div class="swipe-viewport">
    <v-container max-width="700" class="pt-0" :style="contentStyle">
      <div class="d-flex align-center mb-0">
        <v-btn icon="mdi-arrow-left" variant="text" @click="goBack()" />
        <h1 class="text-h6 ml-2 flex-grow-1">Bet Detail</h1>
        <template
          v-if="isCreator && bet && (effectiveStatus === 'open' || effectiveStatus === 'closed')"
        >
          <v-btn
            icon="mdi-pencil"
            variant="tonal"
            size="small"
            class="ml-1"
            @click="openEditDialog()"
          >
            <v-icon>mdi-pencil</v-icon>
            <v-tooltip activator="parent" location="bottom">Edit Bet</v-tooltip>
          </v-btn>
          <v-btn
            icon="mdi-gavel"
            color="primary"
            variant="tonal"
            size="small"
            :class="['ml-1', { 'pulse-shadow': effectiveStatus === 'closed' }]"
            @click="openResolveDialog()"
          >
            <v-icon>mdi-gavel</v-icon>
            <v-tooltip activator="parent" location="bottom">
              {{ effectiveStatus === 'closed' ? 'Betting closed — Resolve now!' : 'Resolve Bet' }}
            </v-tooltip>
          </v-btn>
          <v-btn
            icon="mdi-cancel"
            color="error"
            variant="tonal"
            size="small"
            class="ml-1"
            @click="showCancelDialog = true"
          >
            <v-icon>mdi-cancel</v-icon>
            <v-tooltip activator="parent" location="bottom">Cancel Bet</v-tooltip>
          </v-btn>
        </template>
        <template v-if="isCreator && bet && bet.status === 'resolved'">
          <v-btn
            icon="mdi-undo"
            color="warning"
            variant="tonal"
            size="small"
            class="ml-1"
            @click="showUnresolveDialog = true"
          >
            <v-icon>mdi-undo</v-icon>
            <v-tooltip activator="parent" location="bottom">Unresolve Bet</v-tooltip>
          </v-btn>
        </template>
      </div>

      <template v-if="!bet">
        <v-progress-linear indeterminate />
      </template>

      <template v-else>
        <!-- Question + status row -->
        <div class="d-flex align-center ga-4 mb-2" style="margin-top: -4px">
          <div class="flex-grow-1">
            <p class="text-h6 font-weight-medium">{{ bet.question }}</p>
            <v-chip v-if="isExcluded" color="error" size="small" variant="tonal" class="mt-1">
              You are excluded
            </v-chip>
            <v-chip
              v-else-if="excludedMemberNames.length > 0"
              color="warning"
              size="small"
              variant="tonal"
              class="mt-1"
            >
              Excluded: {{ excludedMemberNames.join(', ') }}
            </v-chip>
          </div>
          <div class="d-flex flex-column align-end justify-center ga-1 flex-shrink-0">
            <v-chip
              :color="
                effectiveStatus === 'open'
                  ? 'success'
                  : effectiveStatus === 'resolved'
                    ? 'info'
                    : effectiveStatus === 'cancelled'
                      ? 'error'
                      : 'warning'
              "
              size="small"
              variant="tonal"
            >
              {{ effectiveStatus }}
            </v-chip>
            <span v-if="timeRemaining" class="text-caption text-medium-emphasis">{{
              timeRemaining
            }}</span>
          </div>
        </div>

        <!-- Resolved banner -->
        <v-alert
          v-if="bet.status === 'resolved' && bet.resolvedOutcome !== null"
          type="success"
          variant="tonal"
          class="mb-4"
        >
          <strong>Resolved:</strong> "{{ bet.outcomes[bet.resolvedOutcome] }}" won!
          <table
            v-if="position && position.totalCost > 0"
            class="text-body-2 mt-2"
            style="border-collapse: collapse"
          >
            <tbody>
              <tr>
                <td class="pr-4 text-medium-emphasis">Cost</td>
                <td class="text-right">
                  ${{ (position.totalCost - myInvalidatedCost).toFixed(2) }}
                </td>
              </tr>
              <tr>
                <td class="pr-4 text-medium-emphasis">Payout</td>
                <td class="text-right">
                  ${{
                    ((position.shares[bet.resolvedOutcome] ?? 0) - myInvalidatedShares).toFixed(2)
                  }}
                </td>
              </tr>
              <tr v-if="!isCreator && myCommissionFee > 0">
                <td class="pr-4 text-medium-emphasis">
                  <span class="d-inline-flex align-center">
                    Creator fee
                    <v-btn icon size="x-small" variant="text" class="ml-1">
                      <v-icon size="14">mdi-information-outline</v-icon>
                      <v-tooltip activator="parent" location="top" max-width="280">
                        A small fee paid to the bet creator for making a bet that divided the group.
                        Higher disagreement = higher fee.
                      </v-tooltip>
                    </v-btn>
                  </span>
                </td>
                <td class="text-right text-error">-${{ myCommissionFee.toFixed(2) }}</td>
              </tr>
              <tr v-if="isCreator && myNetCommission !== 0">
                <td class="pr-4 text-medium-emphasis">
                  <span class="d-inline-flex align-center">
                    Commission
                    <v-btn icon size="x-small" variant="text" class="ml-1">
                      <v-icon size="14">mdi-information-outline</v-icon>
                      <v-tooltip activator="parent" location="top" max-width="280">
                        You earn a commission for creating bets that divided the group. This is the
                        net amount after deducting the fee on your own winnings.
                      </v-tooltip>
                    </v-btn>
                  </span>
                </td>
                <td
                  class="text-right"
                  :class="myNetCommission >= 0 ? 'text-success' : 'text-error'"
                >
                  {{ myNetCommission >= 0 ? '+' : '-' }}${{ Math.abs(myNetCommission).toFixed(2) }}
                </td>
              </tr>
              <tr>
                <td class="pr-4 text-medium-emphasis font-weight-bold">Profit</td>
                <td
                  class="text-right font-weight-bold"
                  :class="myResolvedProfit >= 0 ? 'text-success' : 'text-error'"
                >
                  {{ myResolvedProfit >= 0 ? '+' : '' }}${{ myResolvedProfit.toFixed(2) }}
                </td>
              </tr>
              <tr v-if="myInvalidatedCost > 0">
                <td class="pr-4 text-medium-emphasis">Refund</td>
                <td class="text-right text-success">+${{ myInvalidatedCost.toFixed(2) }}</td>
              </tr>
            </tbody>
          </table>
          <div
            v-if="
              isCreator &&
              (!position || position.totalCost <= 0) &&
              bet.creatorCommission &&
              bet.creatorCommission > 0
            "
            class="text-body-2 mt-2 d-flex align-center"
          >
            <span class="text-success font-weight-medium">
              Commission earned: +${{ bet.creatorCommission.toFixed(2) }}
            </span>
            <v-btn icon size="x-small" variant="text" class="ml-1">
              <v-icon size="14">mdi-information-outline</v-icon>
              <v-tooltip activator="parent" location="top" max-width="280">
                You earn a commission for creating bets that divided the group. Higher disagreement
                = higher payout.
              </v-tooltip>
            </v-btn>
          </div>
          <div v-if="bet.resolvesAt && myInvalidatedCost > 0" class="text-body-2 mt-2">
            Trades after {{ bet.resolvesAt.toDate().toLocaleString() }} were refunded.
          </div>
          <div v-if="!isCreator" class="mt-3">
            <v-btn
              v-if="!hasContested"
              size="small"
              color="warning"
              variant="tonal"
              prepend-icon="mdi-flag"
              @click="showContestDialog = true"
            >
              Contest Resolution
              <span v-if="contestCount > 0" class="ml-1 text-caption">({{ contestCount }}/2)</span>
            </v-btn>
            <v-chip v-else size="small" color="warning" variant="tonal">
              <v-icon start size="small">mdi-flag</v-icon>
              Contested ({{ contestCount }}/2)
            </v-chip>
          </div>
        </v-alert>

        <!-- Cancelled banner -->
        <v-alert v-if="bet.status === 'cancelled'" type="warning" variant="tonal" class="mb-4">
          This bet was cancelled. All positions have been refunded at cost basis.
        </v-alert>

        <!-- Creator waiting for first wager -->
        <v-alert v-if="creatorAwaitingFirstWager" type="info" variant="tonal" class="mb-4">
          As bet creator, you can't be the first person to make a trade.
        </v-alert>

        <!-- Chart / Trades tabs -->
        <v-tabs v-model="detailTab" density="compact" class="mb-2">
          <v-tab value="chart">
            <v-icon>mdi-chart-line</v-icon>
          </v-tab>
          <v-tab value="holdings">
            <v-icon>mdi-swap-horizontal</v-icon>
          </v-tab>
          <v-tab value="trades">
            <v-icon>mdi-history</v-icon>
          </v-tab>
        </v-tabs>

        <v-window v-model="detailTab" class="mb-4" :touch="false">
          <v-window-item value="chart">
            <div
              class="mt-2 mb-4"
              :style="{ minHeight: betsStore.trades.length > 0 ? '180px' : undefined }"
            >
              <SvgLineChart
                :series="chartSeries"
                :labels="chartLabels"
                :y-min="0"
                :y-max="100"
                :y-format="(v: number) => `${v.toFixed(0)}%`"
              />
            </div>
          </v-window-item>

          <v-window-item value="trades">
            <table
              v-if="betsStore.trades.length > 0"
              class="text-body-2"
              style="width: 100%; border-collapse: collapse; table-layout: fixed"
            >
              <thead>
                <tr
                  class="text-caption text-medium-emphasis"
                  style="
                    border-bottom: thin solid rgba(var(--v-border-color), var(--v-border-opacity));
                  "
                >
                  <th class="text-left py-1" style="width: 22%">Player</th>
                  <th class="text-left py-1" style="max-width: 30%">Action</th>
                  <th class="text-left py-1" style="width: 22%">Shares</th>
                  <th class="text-right py-1" style="width: 26%">
                    Time <v-icon size="12">mdi-arrow-down</v-icon>
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="trade in betsStore.trades"
                  :key="trade.id"
                  style="
                    border-bottom: thin solid rgba(var(--v-border-color), var(--v-border-opacity));
                  "
                >
                  <td class="py-1 truncate-cell">
                    <v-menu
                      open-on-hover
                      open-on-click
                      location="top"
                      :close-on-content-click="false"
                    >
                      <template #activator="{ props }">
                        <span v-bind="props" class="d-block text-truncate truncate-clickable">{{
                          memberName(trade.userId)
                        }}</span>
                      </template>
                      <v-card class="pa-2 text-caption">{{ memberName(trade.userId) }}</v-card>
                    </v-menu>
                  </td>
                  <td class="py-1 truncate-cell">
                    <v-menu
                      open-on-hover
                      open-on-click
                      location="top"
                      :close-on-content-click="false"
                    >
                      <template #activator="{ props }">
                        <span v-bind="props" class="d-block text-truncate truncate-clickable">
                          <span :class="trade.shares > 0 ? 'text-success' : 'text-error'">
                            {{ trade.shares > 0 ? 'Buy' : 'Sell' }}
                          </span>
                          "{{ bet.outcomes[trade.outcomeIndex] }}"
                        </span>
                      </template>
                      <v-card class="pa-2 text-caption">
                        <span :class="trade.shares > 0 ? 'text-success' : 'text-error'">
                          {{ trade.shares > 0 ? 'Buy' : 'Sell' }}
                        </span>
                        "{{ bet.outcomes[trade.outcomeIndex] }}"
                      </v-card>
                    </v-menu>
                  </td>
                  <td class="text-left py-1">
                    {{ Math.abs(trade.shares).toFixed(0) }}<br />@${{
                      Math.abs(trade.cost).toFixed(2)
                    }}
                  </td>
                  <td class="text-right py-1">{{ fmtTradeTime(trade.createdAt) }}</td>
                </tr>
              </tbody>
            </table>
            <p v-else class="text-body-2 text-medium-emphasis">No trades yet</p>
          </v-window-item>

          <v-window-item value="holdings">
            <div ref="holdingsScrollRef" class="holdings-scroll">
              <table
                v-if="betPositions.length > 0"
                class="text-body-2"
                style="width: max-content; min-width: 100%; border-collapse: collapse"
              >
                <thead>
                  <tr
                    class="text-caption text-medium-emphasis"
                    style="
                      border-bottom: thin solid rgba(var(--v-border-color), var(--v-border-opacity));
                    "
                  >
                    <th class="text-left py-1">Player</th>
                    <th
                      v-for="(outcome, i) in bet.outcomes"
                      :key="i"
                      class="text-center py-1 holdings-th"
                    >
                      <v-menu
                        open-on-hover
                        open-on-click
                        location="top"
                        :close-on-content-click="false"
                      >
                        <template #activator="{ props }">
                          <span
                            v-bind="props"
                            class="d-inline-flex align-center ga-1 holdings-th-content"
                          >
                            <span
                              :style="{
                                width: '8px',
                                height: '8px',
                                borderRadius: '2px',
                                backgroundColor: OUTCOME_COLORS[i % OUTCOME_COLORS.length],
                                flexShrink: 0,
                              }"
                            />
                            <span class="text-truncate">{{ outcome }}</span>
                          </span>
                        </template>
                        <v-card class="pa-2 text-caption">{{ outcome }}</v-card>
                      </v-menu>
                    </th>
                    <th class="text-right py-1">Spent</th>
                  </tr>
                </thead>
                <tbody>
                  <tr
                    v-for="pos in betPositions"
                    :key="pos.userId"
                    style="
                      border-bottom: thin solid rgba(var(--v-border-color), var(--v-border-opacity));
                    "
                  >
                    <td class="py-1">{{ memberName(pos.userId) }}</td>
                    <td v-for="(outcome, i) in bet.outcomes" :key="i" class="text-center py-1">
                      {{ (pos.shares[i] ?? 0).toFixed(1) }}
                    </td>
                    <td class="text-right py-1">${{ pos.totalCost.toFixed(2) }}</td>
                  </tr>
                </tbody>
              </table>
              <p v-else class="text-body-2 text-medium-emphasis">No positions yet</p>
            </div>
          </v-window-item>
        </v-window>
        <!-- Outcome prices -->
        <div class="mb-4">
          <div
            class="outcome-spectrum"
            :style="{
              height: '28px',
              borderRadius: '6px',
              overflow: 'hidden',
              display: 'flex',
              position: 'relative',
            }"
          >
            <div
              v-for="(outcome, i) in bet.outcomes"
              :key="i"
              :style="{
                width: (prices[i] ?? 0) * 100 + '%',
                backgroundColor: OUTCOME_COLORS[i % OUTCOME_COLORS.length],
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                position: 'relative',
              }"
            >
              <span
                v-if="(prices[i] ?? 0) >= 0.08"
                class="text-caption font-weight-bold"
                style="color: white; text-shadow: 0 1px 2px rgba(0, 0, 0, 0.4)"
              >
                {{ ((prices[i] ?? 0) * 100).toFixed(1) }}%
              </span>
            </div>
          </div>
          <div class="d-flex flex-wrap ga-3 mt-2">
            <div v-for="(outcome, i) in bet.outcomes" :key="i" class="d-flex align-center ga-1">
              <div
                :style="{
                  width: '12px',
                  height: '12px',
                  borderRadius: '3px',
                  backgroundColor: OUTCOME_COLORS[i % OUTCOME_COLORS.length],
                }"
              />
              <span class="text-caption">{{ outcome }}</span>
            </div>
          </div>
        </div>

        <!-- Your Positions -->
        <v-card v-if="canTrade || position" class="mb-4" variant="outlined">
          <v-card-title class="text-subtitle-1">Your Positions</v-card-title>
          <v-card-text>
            <div v-for="(outcome, i) in bet.outcomes" :key="i" class="mb-4">
              <div class="d-flex align-center ga-2 mb-1" style="min-width: 0">
                <div
                  :style="{
                    width: '10px',
                    height: '10px',
                    borderRadius: '2px',
                    backgroundColor: OUTCOME_COLORS[i % OUTCOME_COLORS.length],
                  }"
                />
                <v-menu open-on-hover open-on-click location="top" :close-on-content-click="false">
                  <template #activator="{ props }">
                    <span
                      v-bind="props"
                      class="text-body-2 font-weight-medium text-truncate d-block truncate-clickable"
                      style="min-width: 0"
                      >{{ outcome }}</span
                    >
                  </template>
                  <v-card class="pa-2 text-caption">{{ outcome }}</v-card>
                </v-menu>
                <div class="ml-auto d-flex flex-column align-end" style="line-height: 1.2">
                  <div class="d-flex align-baseline ga-2">
                    <span class="text-caption text-medium-emphasis">
                      {{ (1 / (prices[i] ?? 1)).toFixed(2) }}x
                    </span>
                    <span class="font-weight-bold" style="font-size: 15px">
                      {{ ((prices[i] ?? 0) * 100).toFixed(0) }}%
                    </span>
                  </div>
                  <div
                    class="d-flex align-baseline ga-2"
                    :style="{ visibility: hasPendingTrades ? 'visible' : 'hidden' }"
                  >
                    <span
                      class="text-caption font-weight-bold"
                      :style="{
                        color:
                          1 / (projectedPrices[i] ?? 1) >= 1 / (prices[i] ?? 1)
                            ? '#4caf50'
                            : '#ef5350',
                      }"
                    >
                      {{ (1 / (projectedPrices[i] ?? 1)).toFixed(2) }}x
                    </span>
                    <span
                      class="text-caption font-weight-bold"
                      :style="{
                        color:
                          (projectedPrices[i] ?? 0) >= (prices[i] ?? 0) ? '#4caf50' : '#ef5350',
                      }"
                    >
                      {{ ((projectedPrices[i] ?? 0) * 100).toFixed(0) }}%
                    </span>
                  </div>
                </div>
              </div>

              <div v-if="canTrade" class="thumb-only-slider">
                <v-slider
                  :model-value="desiredShares[i] ?? 0"
                  @update:model-value="(val: number) => onSliderUpdate(i, val)"
                  :min="0"
                  :max="100"
                  :step="1"
                  density="compact"
                  hide-details
                />
              </div>

              <p
                v-if="limitWarnings[i]"
                class="text-caption text-center"
                style="color: #ef5350; margin-top: -4px"
              >
                You can't wager more than 100 shares per bet
              </p>

              <div class="text-caption text-medium-emphasis" style="margin-top: 2px">
                {{ (position?.shares[i] ?? 0).toFixed(0) }} shares held
                <span v-if="(tradeDiffs[i] ?? 0) !== 0" class="ml-1">
                  &rarr;
                  <span
                    :style="{
                      color: (tradeDiffs[i] ?? 0) > 0 ? '#4caf50' : '#ef5350',
                      marginLeft: '3px',
                    }"
                  >
                    ({{ (tradeDiffs[i] ?? 0) > 0 ? '+' : '' }}{{ tradeDiffs[i] ?? 0 }})
                  </span>

                  <span
                    :style="{
                      color: (tradeCosts[i] ?? 0) <= 0 ? '#4caf50' : '#ef5350',
                      marginLeft: '3px',
                    }"
                  >
                    ({{ (tradeCosts[i] ?? 0) <= 0 ? '+' : '-' }}${{
                      Math.abs(tradeCosts[i] ?? 0).toFixed(2)
                    }})
                  </span>
                </span>
              </div>
            </div>

            <!-- Total Holdings -->
            <v-divider class="mb-3" />

            <div class="mb-3">
              <!-- Net cost -->
              <div class="d-flex align-start justify-space-between text-body-2 mb-1">
                <span class="font-weight-medium">Net cost</span>
                <div class="d-flex flex-column align-end" style="line-height: 1.3">
                  <span class="font-weight-bold">${{ holdingsNetCost.toFixed(2) }}</span>
                  <span
                    class="text-caption font-weight-bold"
                    :style="{
                      color: projectedNetCost <= holdingsNetCost ? '#4caf50' : '#ef5350',
                      visibility: hasPendingTrades ? 'visible' : 'hidden',
                    }"
                  >
                    ${{ projectedNetCost.toFixed(2) }}
                  </span>
                </div>
              </div>

              <!-- Profit potential -->
              <div class="d-flex align-start justify-space-between text-body-2">
                <span class="font-weight-medium"
                  >Profit potential<span
                    v-if="holdingsProfitPotential.outcome"
                    class="text-medium-emphasis font-weight-regular"
                  >
                    ({{ holdingsProfitPotential.outcome }})</span
                  ></span
                >
                <div class="d-flex flex-column align-end" style="line-height: 1.3">
                  <span
                    class="font-weight-bold"
                    :style="{
                      color: holdingsProfitPotential.value >= 0 ? '#4caf50' : '#ef5350',
                    }"
                  >
                    {{ holdingsProfitPotential.value >= 0 ? '+' : '' }}${{
                      holdingsProfitPotential.value.toFixed(2)
                    }}
                  </span>
                  <span
                    class="text-caption font-weight-bold"
                    :style="{
                      color:
                        projectedHoldingsProfitPotential.value >= holdingsProfitPotential.value
                          ? '#4caf50'
                          : '#ef5350',
                      visibility: hasPendingTrades ? 'visible' : 'hidden',
                    }"
                  >
                    {{ projectedHoldingsProfitPotential.value >= 0 ? '+' : '' }}${{
                      projectedHoldingsProfitPotential.value.toFixed(2)
                    }}
                    <span
                      v-if="
                        projectedHoldingsProfitPotential.outcome !== holdingsProfitPotential.outcome
                      "
                      class="text-medium-emphasis"
                    >
                      ({{ projectedHoldingsProfitPotential.outcome }})
                    </span>
                  </span>
                </div>
              </div>
            </div>

            <div
              class="d-flex ga-2"
              :style="{ visibility: hasPendingTrades ? 'visible' : 'hidden' }"
            >
              <v-btn
                color="primary"
                :loading="submitting"
                :disabled="submitting"
                @click="handleTrades"
                class="flex-grow-1"
              >
                {{ tradeActionLabel }}
              </v-btn>
              <v-btn variant="text" @click="resetSliders" :disabled="submitting"> Reset </v-btn>
            </div>

            <v-alert v-if="betsStore.error" type="error" variant="tonal" class="mt-3">
              {{ betsStore.error }}
            </v-alert>
          </v-card-text>
        </v-card>

        <!-- Comments -->
        <v-card class="mb-4" variant="outlined">
          <v-card-title class="text-subtitle-1 d-flex align-center">
            Comments
            <v-chip
              v-if="bet.commentCount"
              size="x-small"
              color="secondary"
              variant="tonal"
              class="ml-2"
            >
              {{ bet.commentCount ?? 0 }}
            </v-chip>
          </v-card-title>
          <v-card-text>
            <div
              v-if="commentsStore.comments.length > 0"
              class="comments-list mb-3"
              style="max-height: 400px; overflow-y: auto"
            >
              <div
                v-for="comment in commentsStore.comments"
                :key="comment.id"
                class="d-flex ga-2 py-2"
                style="
                  border-bottom: thin solid rgba(var(--v-border-color), var(--v-border-opacity));
                "
              >
                <div class="flex-grow-1" style="min-width: 0">
                  <div class="d-flex align-center ga-2">
                    <span class="text-caption font-weight-bold">{{
                      memberName(comment.userId)
                    }}</span>
                    <span class="text-caption text-medium-emphasis">
                      {{ comment.createdAt ? commentTimeAgo(comment.createdAt) : '' }}
                    </span>
                  </div>
                  <p
                    v-if="comment.text"
                    class="text-body-2 mt-1"
                    style="white-space: pre-wrap; word-break: break-word"
                  >
                    {{ comment.text }}
                  </p>
                  <a
                    v-if="comment.imageUrl"
                    :href="comment.imageUrl"
                    target="_blank"
                    rel="noopener noreferrer"
                    class="d-block mt-1"
                  >
                    <v-img
                      :src="comment.imageUrl"
                      max-height="200"
                      max-width="300"
                      rounded="lg"
                      cover
                      class="comment-image"
                    />
                  </a>
                </div>
              </div>
            </div>
            <p v-else class="text-body-2 text-medium-emphasis mb-3">No comments yet</p>

            <!-- Image preview -->
            <div v-if="pendingImagePreview" class="mb-2">
              <v-chip
                closable
                color="primary"
                variant="tonal"
                size="small"
                prepend-icon="mdi-image"
                @click:close="removeImage()"
              >
                {{ pendingImage?.name }}
              </v-chip>
            </div>

            <div class="d-flex align-center ga-2">
              <v-text-field
                v-model="newCommentText"
                placeholder="Write a comment..."
                variant="outlined"
                density="compact"
                hide-details
                :maxlength="500"
                @keydown.enter.prevent="handlePostComment"
                @paste="onCommentPaste"
              />
              <input
                ref="imageInputRef"
                type="file"
                accept="image/*"
                hidden
                @change="onImagePicked"
              />
              <v-btn
                icon="mdi-image"
                :variant="pendingImage ? 'flat' : 'tonal'"
                :color="pendingImage ? 'primary' : undefined"
                size="small"
                :disabled="commentsStore.submitting"
                @click="imageInputRef?.click()"
              />
              <v-btn
                ref="sendBtnRef"
                icon="mdi-send"
                color="primary"
                variant="tonal"
                size="small"
                :loading="commentsStore.submitting"
                :disabled="(!newCommentText.trim() && !pendingImage) || commentsStore.submitting"
                @click="handlePostComment"
              />
            </div>
            <v-alert
              v-if="commentsStore.error"
              type="error"
              variant="tonal"
              class="mt-2"
              density="compact"
            >
              {{ commentsStore.error }}
            </v-alert>
          </v-card-text>
        </v-card>

        <!-- Resolve dialog -->
        <v-dialog v-model="showResolveDialog" max-width="400">
          <v-card>
            <v-card-title>Resolve Bet</v-card-title>
            <v-card-text>
              <p class="text-body-2 mb-3">Select the winning outcome:</p>
              <v-radio-group v-model="resolveOutcome">
                <v-radio
                  v-for="(outcome, i) in bet.outcomes"
                  :key="i"
                  :label="outcome"
                  :value="i"
                />
              </v-radio-group>

              <div class="d-flex align-center mb-1">
                <span class="text-body-2">Resolution time (optional)</span>
                <v-btn icon size="x-small" variant="text" class="ml-1">
                  <v-icon size="14">mdi-information-outline</v-icon>
                  <v-tooltip activator="parent" location="top" max-width="280">
                    If the true outcome was revealed before betting closed, set the time it became
                    known. All trades made after this time will be refunded.
                  </v-tooltip>
                </v-btn>
              </div>
              <v-text-field
                v-model="resolveResolvesAt"
                type="datetime-local"
                variant="outlined"
                density="compact"
                hide-details
                :disabled="resolving"
              />
            </v-card-text>
            <v-card-actions>
              <v-spacer />
              <v-btn variant="text" @click="showResolveDialog = false">Cancel</v-btn>
              <v-btn color="primary" :loading="resolving" @click="handleResolve">
                Confirm Resolution
              </v-btn>
            </v-card-actions>
          </v-card>
        </v-dialog>

        <!-- Edit dialog -->
        <v-dialog v-model="showEditDialog" max-width="500" persistent>
          <v-card>
            <v-card-title>Edit Bet</v-card-title>
            <v-card-text>
              <v-textarea
                v-model="editQuestion"
                label="Question"
                variant="outlined"
                rows="2"
                :disabled="hasTrades || editSubmitting"
                hide-details
              />
              <p v-if="editErrors.question" class="edit-field-error">{{ editErrors.question }}</p>
              <p v-else-if="hasTrades" class="edit-field-hint">
                Cannot change after trading has started
              </p>
              <div style="height: 8px" />

              <template v-if="editType === 'multiple_choice'">
                <fieldset class="outcomes-fieldset mb-1">
                  <legend class="outcomes-legend">Outcomes</legend>
                  <div v-for="(_, i) in editOutcomes" :key="i" class="d-flex align-center mb-2">
                    <div class="d-flex flex-column mr-1">
                      <v-btn
                        icon="mdi-chevron-up"
                        size="x-small"
                        variant="text"
                        density="compact"
                        :disabled="i === 0 || hasTrades || editSubmitting"
                        @click="moveEditOutcome(i, -1)"
                      />
                      <v-btn
                        icon="mdi-chevron-down"
                        size="x-small"
                        variant="text"
                        density="compact"
                        :disabled="i === editOutcomes.length - 1 || hasTrades || editSubmitting"
                        @click="moveEditOutcome(i, 1)"
                      />
                    </div>
                    <v-text-field
                      v-model="editOutcomes[i]"
                      :placeholder="`Option ${i + 1}`"
                      variant="outlined"
                      density="compact"
                      hide-details
                      class="flex-grow-1"
                      :disabled="hasTrades || editSubmitting"
                    />
                    <v-btn
                      icon="mdi-close"
                      size="small"
                      variant="text"
                      color="error"
                      class="ml-1"
                      :disabled="hasTrades || editSubmitting"
                      @click="removeEditOutcome(i)"
                    />
                  </div>
                  <p v-if="editErrors.outcomes" class="edit-field-error" style="margin-top: 4px">
                    {{ editErrors.outcomes }}
                  </p>
                  <p v-else-if="hasTrades" class="edit-field-hint" style="margin-top: 4px">
                    Cannot change after trading has started
                  </p>
                  <v-btn
                    prepend-icon="mdi-plus"
                    variant="tonal"
                    size="small"
                    :disabled="editOutcomes.length >= 10 || hasTrades || editSubmitting"
                    class="mt-1"
                    @click="addEditOutcome"
                  >
                    Add option
                  </v-btn>
                </fieldset>
              </template>

              <v-text-field
                v-model="editClosesAt"
                label="Closes at"
                type="datetime-local"
                variant="outlined"
                :disabled="editSubmitting"
                hide-details
              />
              <p v-if="editErrors.closesAt" class="edit-field-error">{{ editErrors.closesAt }}</p>
              <p v-else class="edit-field-hint">Can only be extended, not shortened</p>
              <div style="height: 8px" />

              <v-select
                v-model="editExcludedMembers"
                :items="marketStore.members"
                item-title="displayName"
                item-value="userId"
                label="Exclude members"
                variant="outlined"
                multiple
                chips
                closable-chips
                hide-details
                :disabled="editSubmitting"
              />
              <p v-if="editErrors.excludedMembers" class="edit-field-error" style="margin-top: 2px">
                {{ editErrors.excludedMembers }}
              </p>
              <p v-else class="edit-field-hint" style="margin-top: 2px">
                Can only add new exclusions
              </p>

              <v-alert
                v-if="editErrors.general"
                type="error"
                variant="tonal"
                class="mt-3"
                density="compact"
              >
                {{ editErrors.general }}
              </v-alert>
            </v-card-text>
            <v-card-actions>
              <v-spacer />
              <v-btn variant="text" @click="showEditDialog = false" :disabled="editSubmitting"
                >Cancel</v-btn
              >
              <v-btn color="primary" :loading="editSubmitting" @click="handleEditSubmit">
                Save Changes
              </v-btn>
            </v-card-actions>
          </v-card>
        </v-dialog>

        <!-- Cancel dialog -->
        <v-dialog v-model="showCancelDialog" max-width="400">
          <v-card>
            <v-card-title>Cancel Bet</v-card-title>
            <v-card-text>
              <p class="text-body-2">
                Are you sure? All positions will be refunded at cost basis. This cannot be undone.
              </p>
            </v-card-text>
            <v-card-actions>
              <v-spacer />
              <v-btn variant="text" @click="showCancelDialog = false">Go Back</v-btn>
              <v-btn color="error" :loading="resolving" @click="handleCancel"> Cancel Bet </v-btn>
            </v-card-actions>
          </v-card>
        </v-dialog>

        <!-- Unresolve dialog -->
        <v-dialog v-model="showUnresolveDialog" max-width="400">
          <v-card>
            <v-card-title>Unresolve Bet</v-card-title>
            <v-card-text>
              <p class="text-body-2">
                Are you sure? All payouts, commissions, and stats from this resolution will be
                reversed. The bet will reopen for re-resolution.
              </p>
            </v-card-text>
            <v-card-actions>
              <v-spacer />
              <v-btn variant="text" @click="showUnresolveDialog = false">Go Back</v-btn>
              <v-btn color="warning" :loading="unresolving" @click="handleUnresolve">
                Unresolve
              </v-btn>
            </v-card-actions>
          </v-card>
        </v-dialog>

        <!-- Contest dialog -->
        <v-dialog v-model="showContestDialog" max-width="400">
          <v-card>
            <v-card-title>Contest Resolution</v-card-title>
            <v-card-text>
              <p class="text-body-2">
                Are you sure you want to contest this resolution? If 2 members contest, the bet will
                be unresolved and all payouts reversed.
              </p>
            </v-card-text>
            <v-card-actions>
              <v-spacer />
              <v-btn variant="text" @click="showContestDialog = false">Go Back</v-btn>
              <v-btn color="warning" :loading="contesting" @click="handleContest"> Contest </v-btn>
            </v-card-actions>
          </v-card>
        </v-dialog>

        <!-- Recent trades removed - now in tabs above -->
      </template>
    </v-container>
  </div>
</template>

<style scoped>
.swipe-viewport {
  overflow-x: hidden;
}

.slider-shake {
  animation: shake 0.3s ease;
}

@keyframes shake {
  0%,
  100% {
    transform: translateX(0);
  }
  25% {
    transform: translateX(-4px);
  }
  50% {
    transform: translateX(4px);
  }
  75% {
    transform: translateX(-2px);
  }
}

.pulse-shadow {
  animation: pulse-glow 1.5s ease-in-out infinite;
  border-radius: 50%;
}

.holdings-scroll {
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
  cursor: grab;
}

.holdings-th {
  max-width: 80px;
}

.holdings-th-content {
  max-width: 100%;
  overflow: hidden;
  cursor: pointer;
}

.truncate-cell {
  max-width: 0;
  overflow: hidden;
}

.truncate-clickable {
  cursor: pointer;
}

@keyframes pulse-glow {
  0%,
  100% {
    box-shadow: 0 0 0 0 rgba(255, 152, 0, 0.6);
  }
  50% {
    box-shadow: 0 0 8px 4px rgba(255, 152, 0, 0.4);
  }
}

/* Swipe navigation indicators */
.swipe-indicator {
  position: fixed;
  top: 50%;
  transform: translateY(-50%);
  z-index: 100;
  pointer-events: none;
  background: rgba(var(--v-theme-surface-variant), 0.85);
  border-radius: 50%;
  width: 36px;
  height: 36px;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25);
}
.swipe-indicator-left {
  left: 6px;
}
.swipe-indicator-right {
  right: 6px;
}

/* Only allow slider interaction via the thumb – ignore track clicks/taps */
.thumb-only-slider :deep(.v-slider) {
  pointer-events: none !important;
}
.thumb-only-slider :deep(.v-slider-thumb) {
  pointer-events: auto !important;
}
.thumb-only-slider :deep(.v-slider-thumb__surface) {
  width: 28px;
  height: 28px;
  cursor: grab !important;
}
.thumb-only-slider :deep(.v-slider-thumb__surface:active) {
  cursor: grabbing !important;
}

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
.edit-field-error {
  font-size: 0.7rem;
  color: rgb(var(--v-theme-error));
  margin: 2px 0 0;
  line-height: 1.2;
}
.edit-field-hint {
  font-size: 0.7rem;
  color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
  margin: 2px 0 0;
  line-height: 1.2;
}

.comment-image {
  cursor: pointer;
  border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
}
</style>
