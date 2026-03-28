import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import {
  collection,
  query,
  where,
  collectionGroup,
  onSnapshot,
  getDocs,
  limit,
} from 'firebase/firestore'
import { getFunctions, httpsCallable } from 'firebase/functions'
import { db } from '@/firebase'
import { useAuthStore } from '@/stores/auth'
import type { Market, Member } from '@/types'

export const useMarketStore = defineStore('market', () => {
  const market = ref<Market | null>(null)
  const members = ref<Member[]>([])
  const loading = ref(true)
  const error = ref('')

  const functions = getFunctions()
  const hasMarket = computed(() => !!market.value)
  const currentMember = computed(() => {
    const authStore = useAuthStore()
    return members.value.find((m) => m.userId === authStore.user?.uid) ?? null
  })

  let unsubMarket: (() => void) | null = null
  let unsubMembers: (() => void) | null = null

  async function loadUserMarket() {
    const authStore = useAuthStore()
    if (!authStore.user) {
      market.value = null
      members.value = []
      loading.value = false
      return
    }

    loading.value = true
    error.value = ''

    try {
      // Find which market this user belongs to via collectionGroup query
      const memberQuery = query(
        collectionGroup(db, 'members'),
        where('userId', '==', authStore.user.uid),
        limit(1),
      )
      const memberSnap = await getDocs(memberQuery)

      if (memberSnap.empty || !memberSnap.docs[0]) {
        market.value = null
        members.value = []
        loading.value = false
        return
      }

      // The member doc path is markets/{marketId}/members/{userId}
      const memberDoc = memberSnap.docs[0]
      if (!memberDoc) {
        loading.value = false
        return
      }
      const marketRef = memberDoc.ref.parent.parent!
      const marketId = marketRef.id

      // Listen to market doc, waiting for first snapshot before resolving
      const marketReady = new Promise<void>((resolve) => {
        unsubMarket = onSnapshot(marketRef, (snap) => {
          if (snap.exists()) {
            market.value = { id: snap.id, ...snap.data() } as Market
          }
          resolve()
        })
      })

      // Listen to members collection, waiting for first snapshot before resolving
      const membersReady = new Promise<void>((resolve) => {
        unsubMembers = onSnapshot(collection(db, 'markets', marketId, 'members'), (snap) => {
          members.value = snap.docs.map((d) => ({ userId: d.id, ...d.data() }) as Member)
          resolve()
        })
      })

      await Promise.all([marketReady, membersReady])
    } catch (e: unknown) {
      error.value = e instanceof Error ? e.message : 'Failed to load market'
    } finally {
      loading.value = false
    }
  }

  async function createMarket(name: string) {
    error.value = ''
    try {
      const fn = httpsCallable<{ name: string }, { marketId: string; inviteCode: string }>(
        functions,
        'createMarket',
      )
      await fn({ name })
      await loadUserMarket()
    } catch (e: unknown) {
      error.value = e instanceof Error ? e.message : 'Failed to create market'
      throw e
    }
  }

  async function joinMarket(inviteCode: string) {
    error.value = ''
    try {
      const fn = httpsCallable<{ inviteCode: string }, { marketId: string }>(
        functions,
        'joinMarket',
      )
      await fn({ inviteCode })
      await loadUserMarket()
    } catch (e: unknown) {
      error.value = e instanceof Error ? e.message : 'Failed to join market'
      throw e
    }
  }

  function cleanup() {
    unsubMarket?.()
    unsubMembers?.()
    unsubMarket = null
    unsubMembers = null
    market.value = null
    members.value = []
  }

  return {
    market,
    members,
    loading,
    error,
    hasMarket,
    currentMember,
    loadUserMarket,
    createMarket,
    joinMarket,
    cleanup,
  }
})
