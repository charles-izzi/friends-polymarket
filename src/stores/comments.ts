import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import {
  collection,
  getDocs,
  limit as firestoreLimit,
  onSnapshot,
  orderBy,
  query,
} from 'firebase/firestore'
import { getFunctions, httpsCallable } from 'firebase/functions'
import { db, dbName } from '@/firebase'
import { useMarketStore } from '@/stores/market'
import { useBetsStore } from '@/stores/bets'
import type { Comment } from '@/types'

const SEEN_KEY = 'commentLastSeenAt'

function loadSeenMap(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(SEEN_KEY) || '{}')
  } catch {
    return {}
  }
}

function saveSeenMap(map: Record<string, number>) {
  localStorage.setItem(SEEN_KEY, JSON.stringify(map))
}

export const useCommentsStore = defineStore('comments', () => {
  const comments = ref<Comment[]>([])
  const submitting = ref(false)
  const error = ref('')
  const submitButtonRect = ref<{ top: number; right: number; bottom: number; left: number } | null>(
    null,
  )

  // Track seen timestamps reactively (bumped on markSeen/markAllSeen)
  const seenMap = ref<Record<string, number>>(loadSeenMap())

  const functions = getFunctions()
  let unsubComments: (() => void) | null = null

  const unseenBetIds = computed(() => {
    const betsStore = useBetsStore()
    const seen = seenMap.value
    const ids: string[] = []
    for (const bet of betsStore.bets) {
      const lastComment = bet.lastCommentAt
      if (!lastComment) continue
      const lastCommentMs = lastComment.toDate().getTime()
      const lastSeenMs = seen[bet.id] ?? 0
      if (lastCommentMs > lastSeenMs) {
        ids.push(bet.id)
      }
    }
    return ids
  })

  const unseenCount = computed(() => unseenBetIds.value.length)

  function isUnseen(betId: string): boolean {
    return unseenBetIds.value.includes(betId)
  }

  function getLastSeenAt(betId: string): number {
    return seenMap.value[betId] ?? 0
  }

  function markSeen(betId: string) {
    const map = { ...seenMap.value, [betId]: Date.now() }
    seenMap.value = map
    saveSeenMap(map)
  }

  function markAllSeen() {
    const betsStore = useBetsStore()
    const map = { ...seenMap.value }
    for (const betId of unseenBetIds.value) {
      const bet = betsStore.bets.find((b) => b.id === betId)
      if (bet?.lastCommentAt) {
        map[betId] = Math.max(map[betId] ?? 0, bet.lastCommentAt.toDate().getTime())
      } else {
        map[betId] = Date.now()
      }
    }
    seenMap.value = map
    saveSeenMap(map)
  }

  function listenToComments(betId: string) {
    stopListening()
    const marketStore = useMarketStore()
    if (!marketStore.market) return

    const commentsRef = collection(db, 'markets', marketStore.market.id, 'bets', betId, 'comments')
    const q = query(commentsRef, orderBy('createdAt', 'asc'))
    unsubComments = onSnapshot(q, (snap) => {
      comments.value = snap.docs.map((d) => ({ id: d.id, ...d.data() }) as Comment)
    })
  }

  function stopListening() {
    unsubComments?.()
    unsubComments = null
    comments.value = []
  }

  async function addComment(betId: string, text: string) {
    const marketStore = useMarketStore()
    if (!marketStore.market) throw new Error('No market')

    error.value = ''
    submitting.value = true
    try {
      const fn = httpsCallable<
        { marketId: string; betId: string; text: string; database: string },
        { commentId: string }
      >(functions, 'addComment')

      await fn({
        marketId: marketStore.market.id,
        betId,
        text,
        database: dbName,
      })
      // Mark this bet as seen immediately after posting
      markSeen(betId)
    } catch (e: unknown) {
      error.value = e instanceof Error ? e.message : 'Failed to post comment'
      throw e
    } finally {
      submitting.value = false
    }
  }

  async function fetchRecentComments(betId: string, count: number): Promise<Comment[]> {
    const marketStore = useMarketStore()
    if (!marketStore.market) return []

    const commentsRef = collection(db, 'markets', marketStore.market.id, 'bets', betId, 'comments')
    const q = query(commentsRef, orderBy('createdAt', 'desc'), firestoreLimit(count))
    const snap = await getDocs(q)
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }) as Comment).reverse()
  }

  async function fetchAllComments(betId: string): Promise<Comment[]> {
    const marketStore = useMarketStore()
    if (!marketStore.market) return []

    const commentsRef = collection(db, 'markets', marketStore.market.id, 'bets', betId, 'comments')
    const q = query(commentsRef, orderBy('createdAt', 'asc'))
    const snap = await getDocs(q)
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }) as Comment)
  }

  return {
    comments,
    submitting,
    error,
    submitButtonRect,
    unseenBetIds,
    unseenCount,
    seenMap,
    isUnseen,
    getLastSeenAt,
    markSeen,
    markAllSeen,
    listenToComments,
    stopListening,
    addComment,
    fetchRecentComments,
    fetchAllComments,
  }
})
