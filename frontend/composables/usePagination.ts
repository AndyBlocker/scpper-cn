import { ref, computed, watchEffect, type Ref, type ComputedRef } from 'vue'

export interface PaginationOptions {
  /** 初始每页条数 */
  initialPageSize?: number
  /** 初始偏移量 */
  initialOffset?: number
}

export interface PaginationState {
  /** 每页条数 */
  pageSize: Ref<number>
  /** 当前偏移量 */
  offset: Ref<number>
  /** 总条数 */
  total: Ref<number>
  /** 当前页的数据条数 */
  currentCount: Ref<number>
  /** 是否有更多数据 */
  hasMore: ComputedRef<boolean>
  /** 是否有上一页 */
  hasPrev: ComputedRef<boolean>
  /** 总页数 */
  totalPages: ComputedRef<number>
  /** 当前页索引 (0-based) */
  pageIndex: ComputedRef<number>
  /** 下一页 */
  nextPage: () => void
  /** 上一页 */
  prevPage: () => void
  /** 跳转到指定页 (0-based) */
  goToPage: (index: number) => void
  /** 重置到第一页 */
  reset: () => void
  /** 更新总数和当前页数据条数 */
  updateFromResponse: (response: { total?: number; items?: unknown[] } | null | undefined) => void
}

/**
 * 通用分页逻辑 composable
 *
 * @example
 * const pagination = usePagination({ initialPageSize: 20 })
 *
 * const { data } = await useAsyncData(
 *   () => `list-${pagination.offset.value}`,
 *   () => $bff('/api/list', { params: { limit: pagination.pageSize.value, offset: pagination.offset.value } }),
 *   { watch: [() => pagination.offset.value, () => pagination.pageSize.value] }
 * )
 *
 * watchEffect(() => {
 *   pagination.updateFromResponse(data.value)
 * })
 */
export function usePagination(options: PaginationOptions = {}): PaginationState {
  const { initialPageSize = 20, initialOffset = 0 } = options

  const pageSize = ref(initialPageSize)
  const offset = ref(initialOffset)
  const total = ref(0)
  const currentCount = ref(0)

  const hasMore = computed(() => {
    const size = Number(pageSize.value || 0)
    if (!size) return false
    const t = total.value
    if (!t) return currentCount.value === size
    return offset.value + currentCount.value < t
  })

  const hasPrev = computed(() => offset.value > 0)

  const totalPages = computed(() => {
    const size = Number(pageSize.value || 0)
    if (!size) return 1
    const t = total.value
    if (!t) return 1
    return Math.max(1, Math.ceil(t / size))
  })

  const pageIndex = computed(() => {
    const size = Number(pageSize.value || 0)
    if (!size) return 0
    return Math.floor(offset.value / size)
  })

  function nextPage() {
    if (hasMore.value) {
      offset.value += pageSize.value
    }
  }

  function prevPage() {
    offset.value = Math.max(0, offset.value - pageSize.value)
  }

  function goToPage(index: number) {
    const size = Number(pageSize.value || 0)
    if (!size) return
    const maxIndex = Math.max(0, totalPages.value - 1)
    const clampedIndex = Math.max(0, Math.min(index, maxIndex))
    offset.value = clampedIndex * size
  }

  function reset() {
    offset.value = 0
  }

  function updateFromResponse(response: { total?: number; items?: unknown[] } | null | undefined) {
    if (!response) {
      currentCount.value = 0
      return
    }
    if (typeof response.total === 'number' && Number.isFinite(response.total)) {
      total.value = response.total
    }
    if (Array.isArray(response.items)) {
      currentCount.value = response.items.length
    } else if (Array.isArray(response)) {
      currentCount.value = response.length
    }
  }

  // 自动修正超出范围的 offset
  watchEffect(() => {
    const size = Number(pageSize.value || 0)
    if (!size) return
    const t = total.value
    if (!t) {
      if (offset.value !== 0 && currentCount.value === 0) {
        offset.value = 0
      }
      return
    }
    const maxOffset = Math.max(0, Math.floor((t - 1) / size) * size)
    if (offset.value > maxOffset) {
      offset.value = maxOffset
    }
  })

  return {
    pageSize,
    offset,
    total,
    currentCount,
    hasMore,
    hasPrev,
    totalPages,
    pageIndex,
    nextPage,
    prevPage,
    goToPage,
    reset,
    updateFromResponse
  }
}
