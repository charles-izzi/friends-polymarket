import { onMounted, onUnmounted, type Ref } from 'vue'

export interface SwipeOptions {
  /** Element ref to attach listeners to (defaults to document) */
  target?: Ref<HTMLElement | undefined>
  /** Minimum horizontal distance in px to count as a swipe (default: 50) */
  threshold?: number
  /** Maximum vertical distance in px before cancelling (default: 100) */
  maxVertical?: number
  onSwipeLeft?: () => void
  onSwipeRight?: () => void
}

export function useSwipe(options: SwipeOptions) {
  const threshold = options.threshold ?? 50
  const maxVertical = options.maxVertical ?? 100

  let startX = 0
  let startY = 0
  let tracking = false

  function onTouchStart(e: TouchEvent) {
    const touch = e.touches[0]
    if (!touch) return
    startX = touch.clientX
    startY = touch.clientY
    tracking = true
  }

  function onTouchEnd(e: TouchEvent) {
    if (!tracking) return
    tracking = false

    const touch = e.changedTouches[0]
    if (!touch) return

    const dx = touch.clientX - startX
    const dy = Math.abs(touch.clientY - startY)

    if (dy > maxVertical) return
    if (Math.abs(dx) < threshold) return

    if (dx < 0) {
      options.onSwipeLeft?.()
    } else {
      options.onSwipeRight?.()
    }
  }

  function getTarget() {
    return options.target?.value ?? document
  }

  onMounted(() => {
    const el = getTarget()
    el.addEventListener('touchstart', onTouchStart as EventListener, { passive: true })
    el.addEventListener('touchend', onTouchEnd as EventListener, { passive: true })
  })

  onUnmounted(() => {
    const el = getTarget()
    el.removeEventListener('touchstart', onTouchStart as EventListener)
    el.removeEventListener('touchend', onTouchEnd as EventListener)
  })
}
