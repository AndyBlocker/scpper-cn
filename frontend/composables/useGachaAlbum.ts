import { computed, ref, watch } from 'vue'
import type { GachaPageContext } from '~/composables/useGachaPage'
import type {
  Rarity,
  AlbumPageVariant,
  AlbumSummary,
  DismantleBatchSummary,
  DismantleKeepScope
} from '~/types/gacha'
import { formatTokens } from '~/utils/gachaFormatters'
import { raritySortWeight } from '~/utils/gachaRarity'
import { resolveAffixSignatureFromSource } from '~/utils/gachaAffix'
import {
  variantStackKey
} from '~/utils/gachaAffix'
import { paginatedLoadAll } from '~/utils/gachaPagination'
import { usePageAuthors } from '~/composables/usePageAuthors'
import { resolveAuthorSearchText } from '~/utils/gachaAuthorSearch'

export interface AlbumStackedCard extends AlbumPageVariant {
  stackKey: string
  stackIndex: number
  stackTotal: number
}

function sortAlbumVariants(rows: AlbumPageVariant[]) {
  return [...rows].sort((a, b) => {
    const rarityDiff = raritySortWeight[a.rarity] - raritySortWeight[b.rarity]
    if (rarityDiff !== 0) return rarityDiff
    if (a.count !== b.count) return b.count - a.count
    const titleDiff = a.title.localeCompare(b.title, 'zh-CN')
    if (titleDiff !== 0) return titleDiff
    return variantStackKey(a).localeCompare(variantStackKey(b), 'zh-CN')
  })
}

function normalizeVariant(item: any): AlbumPageVariant {
  return {
    ...item,
    affixVisualStyle: item.affixVisualStyle || 'NONE',
    affixLabel: item.affixLabel || '',
    affixSignature: item.affixSignature || resolveAffixSignatureFromSource(item)
  }
}

function searchableTags(tags: string[] | null | undefined) {
  return (tags ?? []).filter((tag) => {
    const normalized = String(tag || '').trim()
    return normalized.length > 0 && !normalized.startsWith('_')
  })
}

// Backend caps limit at ~1000 (PLACEMENT_OPTION_LIMIT).
// We use parallel pagination to load all items.
const API_PAGE_SIZE = 1000
const ALBUM_FAST_VIEW_SIZE = 180

/**
 * album 页面的状态和逻辑。
 *
 * 加载策略：两阶段渐进加载
 * Phase 1：加载首批全量库存（保证首屏卡片数量）+ summary → 立即渲染
 * Phase 2：分页加载全部库存 → 替换完整数据集
 */
export function useGachaAlbum(page: GachaPageContext) {
  const { gacha, emitError, emitSuccess } = page
  const pageAuthors = usePageAuthors()

  function authorSearchText(
    authors: Array<{ name: string; wikidotId: number | null }> | null | undefined,
    wikidotId: number | null | undefined
  ) {
    const id = Number(wikidotId)
    const cachedAuthors = Number.isFinite(id) && id > 0 ? pageAuthors.getAuthors(id) : []
    return resolveAuthorSearchText(authors, cachedAuthors)
  }

  const loadingPages = ref(false)
  const loadingRemainder = ref(false)
  const albumSummary = ref<AlbumSummary | null>(null)
  const inventoryVariants = ref<AlbumPageVariant[]>([])
  const searchKeyword = ref('')
  const pageRarityFilter = ref<Rarity | 'ALL'>('ALL')
  let albumAuthorQueueTimer: ReturnType<typeof setTimeout> | null = null
  const albumAuthorQueue = new Set<number>()

  // Debounced keyword — avoids triggering O(n log n) sort + O(n) filter on every keystroke
  const debouncedKeyword = ref('')
  let keywordDebounceTimer: ReturnType<typeof setTimeout> | null = null
  watch(searchKeyword, (val) => {
    if (keywordDebounceTimer) clearTimeout(keywordDebounceTimer)
    keywordDebounceTimer = setTimeout(() => {
      debouncedKeyword.value = val
    }, 200)
  })

  const totalPages = computed(() => Math.max(0, Number(albumSummary.value?.totalPages ?? 0)))
  const totalImageVariants = computed(() => Math.max(0, Number(albumSummary.value?.totalImageVariants ?? inventoryVariants.value.length)))
  const totalImageVariantsInPool = computed(() => Math.max(0, Number(albumSummary.value?.totalImageVariantsInPool ?? 0)))
  const totalPagesInPool = computed(() => Math.max(0, Number(albumSummary.value?.totalPagesInPool ?? 0)))
  const coatingStyles = computed(() => Math.max(0, Number(albumSummary.value?.coatingStyles ?? 0)))
  const totalOwnedCount = computed(() => Math.max(0, Number(albumSummary.value?.totalOwnedCount ?? inventoryVariants.value.reduce((sum, p) => sum + p.count, 0))))

  // Sorted variants — only depends on inventoryVariants, cached until inventory changes
  const sortedVariants = computed(() => sortAlbumVariants(inventoryVariants.value))

  const filteredVariants = computed(() => {
    const keyword = debouncedKeyword.value.trim().toLowerCase()
    return sortedVariants.value.filter((v) => {
      if (pageRarityFilter.value !== 'ALL' && v.rarity !== pageRarityFilter.value) return false
      if (!keyword) return true
      const target = `${v.pageId ?? ''} ${v.cardId} ${v.title} ${searchableTags(v.tags).join(' ')} ${authorSearchText(v.authors, v.wikidotId)} ${v.affixSignature || ''}`.toLowerCase()
      return target.includes(keyword)
    })
  })

  // Lazy stacked cards — only computed when explicitly called (not used by album page render)
  function getFilteredStackedCards(): AlbumStackedCard[] {
    const rows: AlbumStackedCard[] = []
    filteredVariants.value.forEach((variant) => {
      const stackTotal = Math.max(0, Math.floor(Number(variant.count || 0)))
      for (let stackIndex = 0; stackIndex < stackTotal; stackIndex += 1) {
        rows.push({
          ...variant,
          count: 1,
          stackTotal,
          stackIndex,
          stackKey: `${variantStackKey(variant)}::${stackIndex}`
        })
      }
    })
    return rows
  }

  // Keep computed for backward compat — but callers that don't need it should use getFilteredStackedCards
  const filteredStackedCards = computed<AlbumStackedCard[]>(() => getFilteredStackedCards())

  // ─── Inventory loading helpers ──────────────────────

  function queueAuthorHydration(ids: Array<number | null | undefined>) {
    ids.forEach((value) => {
      const id = Number(value)
      if (!Number.isFinite(id) || id <= 0) return
      albumAuthorQueue.add(id)
    })
    if (!albumAuthorQueue.size || albumAuthorQueueTimer) return
    albumAuthorQueueTimer = setTimeout(() => {
      albumAuthorQueueTimer = null
      const batch = Array.from(albumAuthorQueue)
      albumAuthorQueue.clear()
      void pageAuthors.ensureAuthors(batch)
    }, 80)
  }

  function seedAuthorCacheForVariants(items: AlbumPageVariant[]) {
    for (const item of items) {
      pageAuthors.seedAuthors(item.wikidotId ?? null, item.authors ?? null)
    }
  }

  function hydrateVariantAuthors(items: AlbumPageVariant[]) {
    seedAuthorCacheForVariants(items)
    queueAuthorHydration(items.map((item) => item.wikidotId))
  }

  /** Fast first screen batch (all rarity mixed, lightweight limit). */
  async function fetchFastViewBatch() {
    const res = await gacha.getInventory({ limit: ALBUM_FAST_VIEW_SIZE, offset: 0 })
    if (!res.ok) throw new Error(res.error || '加载图鉴失败')
    const items = (res.data ?? []).map(normalizeVariant).filter((item) => item.count > 0)
    const pageRowsRaw = Number(res.pageRows ?? items.length)
    hydrateVariantAuthors(items)
    return {
      items,
      total: Math.max(0, Number(res.total ?? 0)),
      pageRows: Number.isFinite(pageRowsRaw) && pageRowsRaw > 0 ? Math.floor(pageRowsRaw) : items.length
    }
  }

  /** Paginated load of all inventory (no rarity filter). */
  async function fetchAllPaginated(): Promise<AlbumPageVariant[]> {
    const items = await paginatedLoadAll<AlbumPageVariant>({
      fetchPage: async (offset, limit, skipTotal) => {
        const res = await gacha.getInventory({ limit, offset, skipTotal })
        if (!res.ok) return { items: [], total: 0, pageRows: 0 }
        const chunk = (res.data ?? []).map(normalizeVariant).filter((i) => i.count > 0)
        return { items: chunk, total: res.total ?? 0, pageRows: Number(res.pageRows ?? 0) }
      },
      pageSize: API_PAGE_SIZE
    })
    hydrateVariantAuthors(items)
    return items
  }

  /** Deduplicate variants by stack key, keeping the first occurrence. */
  function deduplicateVariants(items: AlbumPageVariant[]): AlbumPageVariant[] {
    const seen = new Map<string, AlbumPageVariant>()
    for (const item of items) {
      const key = variantStackKey(item)
      if (!seen.has(key)) seen.set(key, item)
    }
    return Array.from(seen.values())
  }

  async function refreshPages(forceConfig = false) {
    loadingPages.value = true
    try {
      const configRes = await gacha.getConfig(forceConfig)
      if (!configRes.ok || !configRes.data) {
        page.activated.value = false
        albumSummary.value = null
        inventoryVariants.value = []
        return
      }

      page.activated.value = !!configRes.data.activated
      if (!page.activated.value) {
        albumSummary.value = null
        inventoryVariants.value = []
        return
      }

      // ── Phase 1: Fast batch + summary (parallel) ──
      const [fastBatch, summaryRes] = await Promise.all([
        fetchFastViewBatch(),
        gacha.getAlbumSummary()
      ])

      if (summaryRes.ok) {
        albumSummary.value = summaryRes.summary
      }

      const priorityItems = sortAlbumVariants(fastBatch.items)
      inventoryVariants.value = priorityItems
      loadingPages.value = false

      // ── Phase 2: Full inventory (background) ──
      loadingRemainder.value = true
      try {
        const mayHaveMore = fastBatch.total > fastBatch.pageRows
        if (!mayHaveMore) {
          inventoryVariants.value = deduplicateVariants(priorityItems)
          return
        }
        const allItems = await fetchAllPaginated()
        inventoryVariants.value = deduplicateVariants([...priorityItems, ...allItems])
        hydrateVariantAuthors(inventoryVariants.value)
      } finally {
        loadingRemainder.value = false
      }
    } catch (error: any) {
      emitError(error?.message || '加载图鉴失败')
    } finally {
      loadingPages.value = false
      loadingRemainder.value = false
    }
  }

  // ─── Batch Dismantle ───────────────────────────────
  const batchDismantleDialogOpen = ref(false)
  const batchDismantling = ref(false)
  const batchDismantleLoading = ref(false)
  const batchDismantleError = ref<string | null>(null)
  const batchDismantleCandidates = ref<AlbumPageVariant[]>([])

  async function loadBatchDismantleCandidates() {
    if (!page.activated.value) {
      batchDismantleCandidates.value = []
      return
    }
    batchDismantleLoading.value = true
    try {
      // If remainder is still loading, wait for it instead of triggering a duplicate full load
      if (loadingRemainder.value) {
        // Wait until remainder finishes (poll at short interval)
        await new Promise<void>((resolve) => {
          const check = () => {
            if (!loadingRemainder.value) return resolve()
            setTimeout(check, 100)
          }
          check()
        })
      }

      if (inventoryVariants.value.length > 0) {
        batchDismantleCandidates.value = [...inventoryVariants.value]
        hydrateVariantAuthors(batchDismantleCandidates.value)
      } else {
        const rows = await fetchAllPaginated()
        const deduped = deduplicateVariants(rows)
        inventoryVariants.value = deduped
        batchDismantleCandidates.value = deduped
        hydrateVariantAuthors(deduped)
      }
    } catch (error: any) {
      batchDismantleError.value = error?.message || '加载可分解候选失败'
    } finally {
      batchDismantleLoading.value = false
    }
  }

  async function openBatchDismantleDialog() {
    batchDismantleError.value = null
    batchDismantleDialogOpen.value = true
    await loadBatchDismantleCandidates()
  }

  function closeBatchDismantleDialog() {
    if (batchDismantling.value) return
    batchDismantleDialogOpen.value = false
    batchDismantleError.value = null
  }

  async function confirmBatchDismantle(rows: Array<{ cardId: string; count: number; affixVisualStyle: string; affixSignature: string }>) {
    if (rows.length <= 0) {
      batchDismantleError.value = '请先勾选至少一个可分解变体'
      return
    }

    batchDismantling.value = true
    batchDismantleError.value = null

    try {
      const res = await gacha.dismantleBatchSelective(rows.map((r) => ({
        cardId: r.cardId,
        count: r.count,
        affixSignature: r.affixSignature || undefined,
        affixVisualStyle: r.affixVisualStyle || undefined
      })))

      if (!res.ok) {
        batchDismantleError.value = res.error || '批量分解失败'
        return
      }

      await refreshPages(true)
      batchDismantleCandidates.value = [...inventoryVariants.value]

      closeBatchDismantleDialog()
      const summary = res.summary
      emitSuccess(`批量分解完成：共分解 ${formatTokens(summary?.totalCount || 0)} 张，返还 ${formatTokens(summary?.totalReward || 0)} Token。`)
    } catch (error: any) {
      batchDismantleError.value = error?.message || '批量分解失败'
    } finally {
      batchDismantling.value = false
    }
  }

  // ─── Quick Dismantle ──────────────────────────────────
  const quickDismantleDialogOpen = ref(false)
  const quickDismantlePreview = ref<DismantleBatchSummary | null>(null)
  const quickDismantlePreviewLoading = ref(false)
  const quickDismantlePreviewError = ref<string | null>(null)
  const quickDismantleConfirming = ref(false)
  const quickDismantleConfirmError = ref<string | null>(null)

  function openQuickDismantleDialog() {
    quickDismantleDialogOpen.value = true
    quickDismantlePreview.value = null
    quickDismantlePreviewError.value = null
    quickDismantleConfirmError.value = null
  }

  function closeQuickDismantleDialog() {
    if (quickDismantleConfirming.value) return
    quickDismantleDialogOpen.value = false
  }

  async function previewQuickDismantle(maxRarity: Rarity, keepAtLeast: number, keepScope: DismantleKeepScope = 'CARD') {
    quickDismantlePreviewLoading.value = true
    quickDismantlePreviewError.value = null
    try {
      const res = await gacha.dismantleBatchPreview(maxRarity, keepAtLeast, keepScope)
      if (!res.ok) {
        quickDismantlePreviewError.value = res.error || '预览失败'
        quickDismantlePreview.value = null
        return
      }
      quickDismantlePreview.value = res.preview ?? null
    } catch (e: any) {
      quickDismantlePreviewError.value = e?.message || '预览失败'
      quickDismantlePreview.value = null
    } finally {
      quickDismantlePreviewLoading.value = false
    }
  }

  async function confirmQuickDismantle(maxRarity: Rarity, keepAtLeast: number, keepScope: DismantleKeepScope = 'CARD') {
    quickDismantleConfirming.value = true
    quickDismantleConfirmError.value = null
    try {
      const res = await gacha.dismantleBatchByRarity(maxRarity, keepAtLeast, keepScope)
      if (!res.ok) {
        quickDismantleConfirmError.value = res.error || '分解失败'
        return
      }
      await refreshPages(true)
      closeQuickDismantleDialog()
      const summary = res.summary
      emitSuccess(`快速分解完成：共分解 ${formatTokens(summary?.totalCount || 0)} 张，返还 ${formatTokens(summary?.totalReward || 0)} Token。`)
    } catch (e: any) {
      quickDismantleConfirmError.value = e?.message || '分解失败'
    } finally {
      quickDismantleConfirming.value = false
    }
  }

  // ─── Local Update (no refresh) ──────────────────────
  function updateVariantLockStatus(cardId: string, affixSignature: string, locked: boolean) {
    const sig = affixSignature || 'NONE'
    for (const v of inventoryVariants.value) {
      if (v.cardId === cardId && (v.affixSignature || 'NONE') === sig) {
        v.lockedCount = locked ? v.count : 0
      }
    }
  }

  async function loadInitial() {
    await refreshPages(true)
  }

  return {
    loadingPages,
    loadingRemainder,
    albumSummary,
    inventoryVariants,
    searchKeyword,
    pageRarityFilter,
    totalPages,
    totalImageVariants,
    totalImageVariantsInPool,
    totalPagesInPool,
    coatingStyles,
    totalOwnedCount,
    filteredVariants,
    filteredStackedCards,
    refreshPages,
    updateVariantLockStatus,

    batchDismantleDialogOpen,
    batchDismantling,
    batchDismantleLoading,
    batchDismantleError,
    batchDismantleCandidates,
    openBatchDismantleDialog,
    closeBatchDismantleDialog,
    confirmBatchDismantle,

    quickDismantleDialogOpen,
    quickDismantlePreview,
    quickDismantlePreviewLoading,
    quickDismantlePreviewError,
    quickDismantleConfirming,
    quickDismantleConfirmError,
    openQuickDismantleDialog,
    closeQuickDismantleDialog,
    previewQuickDismantle,
    confirmQuickDismantle,

    loadInitial
  }
}
