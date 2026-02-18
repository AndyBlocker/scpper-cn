/**
 * useScrollReveal — IntersectionObserver-based scroll reveal for card grids.
 * Adds 'is-revealed' class to observed elements when they enter the viewport.
 * Each element gets a --reveal-index CSS variable for staggered animation.
 */
import { onMounted, onBeforeUnmount, ref, type Ref } from 'vue'

export function useScrollReveal(containerRef: Ref<HTMLElement | null>, options?: {
  threshold?: number
  rootMargin?: string
  selector?: string
}) {
  const observer = ref<IntersectionObserver | null>(null)
  const revealed = ref(0)

  const threshold = options?.threshold ?? 0.1
  const rootMargin = options?.rootMargin ?? '0px 0px -40px 0px'
  const selector = options?.selector ?? '.gacha-card-reveal-target'

  function observe() {
    if (typeof window === 'undefined') return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return

    const container = containerRef.value
    if (!container) return

    observer.value = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const el = entry.target as HTMLElement
            el.classList.add('is-revealed')
            el.style.setProperty('--reveal-index', String(revealed.value++))
            observer.value?.unobserve(el)
          }
        }
      },
      { threshold, rootMargin }
    )

    const targets = container.querySelectorAll(selector)
    targets.forEach((el) => observer.value?.observe(el))
  }

  function refresh() {
    cleanup()
    revealed.value = 0
    observe()
  }

  // Debounced refresh — avoids rapid re-observation when data changes quickly
  let refreshTimer: ReturnType<typeof setTimeout> | null = null
  function debouncedRefresh() {
    if (refreshTimer) clearTimeout(refreshTimer)
    refreshTimer = setTimeout(() => {
      refreshTimer = null
      refresh()
    }, 50)
  }

  function cleanup() {
    observer.value?.disconnect()
    observer.value = null
  }

  onMounted(() => {
    observe()
  })

  onBeforeUnmount(() => {
    cleanup()
  })

  return { refresh, debouncedRefresh, cleanup }
}
