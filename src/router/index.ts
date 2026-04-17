import { createRouter, createWebHistory } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useMarketStore } from '@/stores/market'

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    // --- Static routes (defined first to avoid /:marketId collision) ---
    {
      path: '/join',
      name: 'join',
      component: () => import('@/views/JoinView.vue'),
    },
    {
      path: '/invite/:code',
      name: 'invite',
      component: () => import('@/views/InviteView.vue'),
    },
    {
      path: '/login',
      name: 'login',
      component: () => import('@/views/LoginView.vue'),
      meta: { public: true },
    },
    // --- Market-scoped routes ---
    {
      path: '/:marketId',
      name: 'home',
      component: () => import('@/views/MarketView.vue'),
    },
    {
      path: '/:marketId/bets',
      name: 'bets',
      component: () => import('@/views/BetListView.vue'),
    },
    {
      path: '/:marketId/bets/create',
      name: 'create-bet',
      component: () => import('@/views/CreateBetView.vue'),
    },
    {
      path: '/:marketId/bets/:id',
      name: 'bet-detail',
      component: () => import('@/views/BetDetailView.vue'),
    },
    {
      path: '/:marketId/stats/:userId?',
      name: 'stats',
      component: () => import('@/views/PlayerStatsView.vue'),
    },
    // Root redirect (handled by beforeEach guard after markets are loaded)
    {
      path: '/',
      name: 'root',
      component: () => import('@/views/JoinView.vue'),
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

  // If authenticated, ensure market store is loaded (with timeout so
  // navigation isn't blocked when offline / on slow PWA resume)
  if (authStore.isAuthenticated && to.name !== 'login') {
    const marketStore = useMarketStore()
    if (marketStore.loading) {
      await Promise.race([
        marketStore.loadUserMarkets(),
        new Promise<void>((resolve) => setTimeout(resolve, 5000)),
      ])
    }

    // Let InviteView handle the join flow with its own loading UI
    if (to.name === 'invite') {
      return
    }

    // Redirect to /join if user has no markets (unless already going there)
    if (!marketStore.hasMarket && to.name !== 'join') {
      return { name: 'join' }
    }

    // Redirect root to the active (last-used) market
    if (to.name === 'root' && marketStore.hasMarket) {
      return { path: `/${marketStore.market!.id}` }
    }

    // For market-scoped routes, sync the active market
    const routeMarketId = to.params.marketId as string | undefined
    if (routeMarketId && marketStore.hasMarket) {
      const isMember = marketStore.markets.some((m) => m.id === routeMarketId)
      if (!isMember) {
        // User is not a member of this market — redirect to their active market
        return { path: `/${marketStore.market!.id}` }
      }
      if (routeMarketId !== marketStore.activeMarketId) {
        await marketStore.switchMarket(routeMarketId)
      }
    }
  }
})

export default router
