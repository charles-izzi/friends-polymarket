import { onMounted, onUnmounted, ref, type Ref } from 'vue'

export interface SwipeOptions {
  /** Element ref to attach listeners to (defaults to document) */
  target?: Ref<HTMLElement | undefined>
  /** Minimum horizontal distance in px to count as a swipe (default: 50) */
  threshold?: number
  /** Maximum vertical distance in px before cancelling (default: 100) */
  maxVertical?: number
  /** CSS selector — ignore touches that originate from matching elements */
  ignore?: string
  onSwipeLeft?: () => void
  onSwipeRight?: () => void
}

export function useSwipe(options: SwipeOptions) {
  const threshold = options.threshold ?? 50
  const maxVertical = options.maxVertical ?? 100

  let startX = 0
  let startY = 0
  let tracking = false
  let cancelled = false

  /** Live horizontal delta while a touch is in progress (0 when idle) */
  const swipeDeltaX = ref(0)

  function onTouchStart(e: TouchEvent) {
    if (options.ignore && (e.target as HTMLElement)?.closest?.(options.ignore)) {
      return
    }
    const touch = e.touches[0]
    if (!touch) return
    startX = touch.clientX
    startY = touch.clientY
    tracking = true
    cancelled = false
    swipeDeltaX.value = 0
  }

  function onTouchMove(e: TouchEvent) {
    if (!tracking || cancelled) return
    const touch = e.touches[0]
    if (!touch) return

    const dy = Math.abs(touch.clientY - startY)
    if (dy > maxVertical) {
      cancelled = true
      swipeDeltaX.value = 0
      return
    }

    swipeDeltaX.value = touch.clientX - startX
  }

  function onTouchEnd(e: TouchEvent) {
    if (!tracking) return
    tracking = false

    if (cancelled) {
      swipeDeltaX.value = 0
      return
    }

    const touch = e.changedTouches[0]
    if (!touch) {
      swipeDeltaX.value = 0
      return
    }

    const dx = touch.clientX - startX
    const dy = Math.abs(touch.clientY - startY)

    if (dy > maxVertical || Math.abs(dx) < threshold) {
      // Below threshold — snap back
      swipeDeltaX.value = 0
      return
    }

    // Swipe detected — keep swipeDeltaX so caller can animate from current position
    if (dx < 0) {
      options.onSwipeLeft?.()
    } else {
      options.onSwipeRight?.()
    }
  }

  function resetSwipe() {
    swipeDeltaX.value = 0
  }

  function getTarget() {
    return options.target?.value ?? document
  }

  onMounted(() => {
    const el = getTarget()
    el.addEventListener('touchstart', onTouchStart as EventListener, { passive: true })
    el.addEventListener('touchmove', onTouchMove as EventListener, { passive: true })
    el.addEventListener('touchend', onTouchEnd as EventListener, { passive: true })
  })

  onUnmounted(() => {
    const el = getTarget()
    el.removeEventListener('touchstart', onTouchStart as EventListener)
    el.removeEventListener('touchmove', onTouchMove as EventListener)
    el.removeEventListener('touchend', onTouchEnd as EventListener)
  })

  return { swipeDeltaX, resetSwipe }
}
