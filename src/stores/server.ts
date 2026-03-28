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
import type { Server, Member } from '@/types'

export const useServerStore = defineStore('server', () => {
  const server = ref<Server | null>(null)
  const members = ref<Member[]>([])
  const loading = ref(true)
  const error = ref('')

  const functions = getFunctions()
  const hasServer = computed(() => !!server.value)
  const currentMember = computed(() => {
    const authStore = useAuthStore()
    return members.value.find((m) => m.userId === authStore.user?.uid) ?? null
  })

  let unsubServer: (() => void) | null = null
  let unsubMembers: (() => void) | null = null

  async function loadUserServer() {
    const authStore = useAuthStore()
    if (!authStore.user) {
      server.value = null
      members.value = []
      loading.value = false
      return
    }

    loading.value = true
    error.value = ''

    try {
      // Find which server this user belongs to via collectionGroup query
      const memberQuery = query(
        collectionGroup(db, 'members'),
        where('userId', '==', authStore.user.uid),
        limit(1),
      )
      const memberSnap = await getDocs(memberQuery)

      if (memberSnap.empty || !memberSnap.docs[0]) {
        server.value = null
        members.value = []
        loading.value = false
        return
      }

      // The member doc path is servers/{serverId}/members/{userId}
      const memberDoc = memberSnap.docs[0]
      if (!memberDoc) {
        loading.value = false
        return
      }
      const serverRef = memberDoc.ref.parent.parent!
      const serverId = serverRef.id

      // Listen to server doc, waiting for first snapshot before resolving
      const serverReady = new Promise<void>((resolve) => {
        unsubServer = onSnapshot(serverRef, (snap) => {
          if (snap.exists()) {
            server.value = { id: snap.id, ...snap.data() } as Server
          }
          resolve()
        })
      })

      // Listen to members collection, waiting for first snapshot before resolving
      const membersReady = new Promise<void>((resolve) => {
        unsubMembers = onSnapshot(collection(db, 'servers', serverId, 'members'), (snap) => {
          members.value = snap.docs.map((d) => ({ userId: d.id, ...d.data() }) as Member)
          resolve()
        })
      })

      await Promise.all([serverReady, membersReady])
    } catch (e: unknown) {
      error.value = e instanceof Error ? e.message : 'Failed to load server'
    } finally {
      loading.value = false
    }
  }

  async function createServer(name: string) {
    error.value = ''
    try {
      const fn = httpsCallable<{ name: string }, { serverId: string; inviteCode: string }>(
        functions,
        'createServer',
      )
      await fn({ name })
      await loadUserServer()
    } catch (e: unknown) {
      error.value = e instanceof Error ? e.message : 'Failed to create server'
      throw e
    }
  }

  async function joinServer(inviteCode: string) {
    error.value = ''
    try {
      const fn = httpsCallable<{ inviteCode: string }, { serverId: string }>(
        functions,
        'joinServer',
      )
      await fn({ inviteCode })
      await loadUserServer()
    } catch (e: unknown) {
      error.value = e instanceof Error ? e.message : 'Failed to join server'
      throw e
    }
  }

  function cleanup() {
    unsubServer?.()
    unsubMembers?.()
    unsubServer = null
    unsubMembers = null
    server.value = null
    members.value = []
  }

  return {
    server,
    members,
    loading,
    error,
    hasServer,
    currentMember,
    loadUserServer,
    createServer,
    joinServer,
    cleanup,
  }
})
