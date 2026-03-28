import { createRouter, createWebHistory } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useMarketStore } from '@/stores/market'

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    {
      path: '/',
      name: 'home',
      component: () => import('@/views/MarketView.vue'),
    },
    {
      path: '/join',
      name: 'join',
      component: () => import('@/views/JoinView.vue'),
    },
    {
      path: '/bets',
      name: 'bets',
      component: () => import('@/views/BetListView.vue'),
    },
    {
      path: '/bets/create',
      name: 'create-bet',
      component: () => import('@/views/CreateBetView.vue'),
    },
    {
      path: '/bets/:id',
      name: 'bet-detail',
      component: () => import('@/views/BetDetailView.vue'),
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

  // Wait for Firebase auth to resolve before making any decisions
  if (authStore.loading) {
    await authStore.ready()
  }

  if (!to.meta.public && !authStore.isAuthenticated) {
    return { name: 'login', query: { redirect: to.fullPath } }
  }

  if (to.name === 'login' && authStore.isAuthenticated) {
    return { path: '/' }
  }

  // If authenticated, ensure market store is loaded
  if (authStore.isAuthenticated && to.name !== 'login') {
    const marketStore = useMarketStore()
    if (marketStore.loading) {
      await marketStore.loadUserMarket()
    }

    // Redirect to /join if user has no market (unless already going there)
    if (!marketStore.hasMarket && to.name !== 'join') {
      return { name: 'join' }
    }

    // Redirect away from /join if user already has a market
    if (marketStore.hasMarket && to.name === 'join') {
      return { path: '/' }
    }
  }
})

export default router
