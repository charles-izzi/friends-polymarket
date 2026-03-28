import { createRouter, createWebHistory } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useServerStore } from '@/stores/server'

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    {
      path: '/',
      name: 'home',
      component: () => import('@/views/ServerView.vue'),
    },
    {
      path: '/join',
      name: 'join',
      component: () => import('@/views/JoinView.vue'),
    },
    {
      path: '/markets',
      name: 'markets',
      component: () => import('@/views/MarketListView.vue'),
    },
    {
      path: '/markets/create',
      name: 'create-market',
      component: () => import('@/views/CreateMarketView.vue'),
    },
    {
      path: '/markets/:id',
      name: 'market-detail',
      component: () => import('@/views/MarketDetailView.vue'),
    },
    {
      path: '/login',
      name: 'login',
      component: () => import('@/views/LoginView.vue'),
      meta: { public: true },
    },
  ],
})

router.beforeEach(async (to) => {
  const authStore = useAuthStore()

  if (!to.meta.public && !authStore.isAuthenticated) {
    return { name: 'login', query: { redirect: to.fullPath } }
  }

  if (to.name === 'login' && authStore.isAuthenticated) {
    return { path: '/' }
  }

  // If authenticated, ensure server store is loaded
  if (authStore.isAuthenticated && to.name !== 'login') {
    const serverStore = useServerStore()
    if (serverStore.loading) {
      await serverStore.loadUserServer()
    }

    // Redirect to /join if user has no server (unless already going there)
    if (!serverStore.hasServer && to.name !== 'join') {
      return { name: 'join' }
    }

    // Redirect away from /join if user already has a server
    if (serverStore.hasServer && to.name === 'join') {
      return { path: '/' }
    }
  }
})

export default router
