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
import { resolveAffixSignatureFromSource } from '~/utils/gachaAffix'
import { variantStackKey } from '~/utils/gachaAffix'
import { paginatedLoadAll } from '~/utils/gachaPagination'
import { normalizeError } from '~/composables/api/gachaCore'
import { usePageAuthors } from '~/composables/usePageAuthors'

export interface AlbumStackedCard extends AlbumPageVariant {
  stackKey: string
  stackIndex: number
  stackTotal: number
}

function normalizeVariant(item: any): AlbumPageVariant {
  return {
    ...item,
    affixVisualStyle: item.affixVisualStyle || 'NONE',
    affixLabel: item.affixLabel || '',
    affixSignature: item.affixSignature || resolveAffixSignatureFromSource(item)
  }
}

const ALBUM_PAGE_SIZE = 80

function createDialogSessionId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID().replace(/-/g, '').slice(0, 12)
  }
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`.slice(0, 12)
}

function stablePayloadHash(input: string) {
  let hash = 5381
  for (let i = 0; i < input.length; i += 1) {
    hash = ((hash << 5) + hash + input.charCodeAt(i)) >>> 0
  }
  return hash.toString(36)
}

/**
 * album 页面的状态和逻辑。
 *
 * 加载策略：服务端分页
 * 搜索、筛选、排序全部由后端处理，前端只渲染当前页。
 */
export function useGachaAlbum(page: GachaPageContext) {
  const { gacha, emitError, emitSuccess } = page
  const pageAuthors = usePageAuthors()

  // ─── Pagination State ──────────────────────────────
  const albumPage = ref(1)
  const albumTotal = ref(0)
  const albumItems = ref<AlbumPageVariant[]>([])
  const albumLoading = ref(false)
  const loadingPages = ref(false)
  const albumSummary = ref<AlbumSummary | null>(null)

  // ─── Search & Filter (server-side) ─────────────────
  const searchKeyword = ref('')
  const debouncedKeyword = ref('')
  const pageRarityFilter = ref<Rarity | 'ALL'>('ALL')

  let keywordDebounceTimer: ReturnType<typeof setTimeout> | null = null
  watch(searchKeyword, (val) => {
    if (keywordDebounceTimer) clearTimeout(keywordDebounceTimer)
    keywordDebounceTimer = setTimeout(() => {
      debouncedKeyword.value = val
    }, 300)
  })

  // ─── Author Hydration ─────────────────────────────
  let albumAuthorQueueTimer: ReturnType<typeof setTimeout> | null = null
  const albumAuthorQueue = new Set<number>()

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

  function hydrateVariantAuthors(items: AlbumPageVariant[]) {
    for (const item of items) {
      pageAuthors.seedAuthors(item.wikidotId ?? null, item.authors ?? null)
    }
    queueAuthorHydration(items.map((item) => item.wikidotId))
  }

  // ─── Summary (computed from ref) ───────────────────
  const totalPages = computed(() => Math.max(0, Number(albumSummary.value?.totalPages ?? 0)))
  const totalImageVariants = computed(() => Math.max(0, Number(albumSummary.value?.totalImageVariants ?? albumItems.value.length)))
  const totalImageVariantsInPool = computed(() => Math.max(0, Number(albumSummary.value?.totalImageVariantsInPool ?? 0)))
  const totalPagesInPool = computed(() => Math.max(0, Number(albumSummary.value?.totalPagesInPool ?? 0)))
  const coatingStyles = computed(() => Math.max(0, Number(albumSummary.value?.coatingStyles ?? 0)))
  const totalOwnedCount = computed(() => Math.max(0, Number(albumSummary.value?.totalOwnedCount ?? 0)))

  // ─── Paginated Load ────────────────────────────────
  async function loadAlbumPage(pageNum: number) {
    albumLoading.value = true
    try {
      const offset = (pageNum - 1) * ALBUM_PAGE_SIZE
      const res = await gacha.getInventory({
        limit: ALBUM_PAGE_SIZE,
        offset,
        rarity: pageRarityFilter.value === 'ALL' ? undefined : pageRarityFilter.value,
        search: debouncedKeyword.value || undefined
      })
      if (res.ok) {
        albumItems.value = (res.data ?? []).map(normalizeVariant)
        albumTotal.value = res.total ?? 0
        albumPage.value = pageNum
        hydrateVariantAuthors(albumItems.value)
      }
    } catch (error: unknown) {
      emitError(normalizeError(error, '加载图鉴失败'))
    } finally {
      albumLoading.value = false
    }
  }

  // Watch search/filter — auto reset to page 1
  watch([debouncedKeyword, pageRarityFilter], () => {
    loadAlbumPage(1)
  })

  // ─── Initial Load ─────────────────────────────────
  async function refreshPages(forceConfig = false) {
    loadingPages.value = true
    try {
      const configRes = await gacha.getConfig(forceConfig)
      if (!configRes.ok || !configRes.data) {
        page.activated.value = false
        albumSummary.value = null
        albumItems.value = []
        return
      }

      page.activated.value = !!configRes.data.activated
      if (!page.activated.value) {
        albumSummary.value = null
        albumItems.value = []
        return
      }

      // Load first page + summary in parallel
      const [, summaryRes] = await Promise.all([
        loadAlbumPage(1),
        gacha.getAlbumSummary()
      ])

      if (summaryRes.ok) {
        albumSummary.value = summaryRes.summary
      }
    } catch (error: unknown) {
      emitError(normalizeError(error, '加载图鉴失败'))
    } finally {
      loadingPages.value = false
    }
  }

  // ─── Local Update (no refresh) ─────────────────────
  function updateVariantLockStatus(cardId: string, affixSignature: string, locked: boolean) {
    const sig = affixSignature || 'NONE'
    for (const v of albumItems.value) {
      if (v.cardId === cardId && (v.affixSignature || 'NONE') === sig) {
        v.lockedCount = locked ? v.count : 0
      }
    }
  }

  // ─── Batch Dismantle ───────────────────────────────
  const batchDismantleDialogOpen = ref(false)
  const batchDismantling = ref(false)
  const batchDismantleLoading = ref(false)
  const batchDismantleError = ref<string | null>(null)
  const batchDismantleCandidates = ref<AlbumPageVariant[]>([])
  const batchDismantleSessionId = ref('')

  function buildBatchDismantleIdempotencyKey(
    rows: Array<{ cardId: string; count: number; affixVisualStyle: string; affixSignature: string }>,
    keepAtLeast: number
  ) {
    const sessionId = batchDismantleSessionId.value || createDialogSessionId()
    batchDismantleSessionId.value = sessionId
    const payload = rows
      .map((row) => `${row.cardId}:${row.affixSignature || 'NONE'}:${Math.max(0, Math.floor(Number(row.count) || 0))}`)
      .sort()
      .join('|')
    return `dbs-${sessionId}-${stablePayloadHash(`${Math.max(0, Math.floor(Number(keepAtLeast) || 0))}|${payload}`)}`
  }

  async function loadBatchDismantleCandidates() {
    if (!page.activated.value) {
      batchDismantleCandidates.value = []
      return
    }
    batchDismantleLoading.value = true
    try {
      // Load all inventory for batch dismantle (separate request, not tied to current page)
      const items = await paginatedLoadAll<AlbumPageVariant>({
        fetchPage: async (offset, limit, skipTotal) => {
          const res = await gacha.getInventory({ limit, offset, skipTotal })
          if (!res.ok) return { items: [], total: 0, pageRows: 0 }
          const chunk = (res.data ?? []).map(normalizeVariant).filter((i) => i.count > 0)
          return { items: chunk, total: res.total ?? 0, pageRows: Number(res.pageRows ?? 0) }
        },
        pageSize: 1000
      })
      batchDismantleCandidates.value = items
      hydrateVariantAuthors(items)
    } catch (error: unknown) {
      batchDismantleError.value = normalizeError(error, '加载可分解候选失败')
    } finally {
      batchDismantleLoading.value = false
    }
  }

  async function openBatchDismantleDialog() {
    batchDismantleError.value = null
    batchDismantleSessionId.value = createDialogSessionId()
    batchDismantleDialogOpen.value = true
    await loadBatchDismantleCandidates()
  }

  function closeBatchDismantleDialog() {
    if (batchDismantling.value) return
    batchDismantleDialogOpen.value = false
    batchDismantleError.value = null
    batchDismantleSessionId.value = ''
  }

  async function confirmBatchDismantle(
    rows: Array<{ cardId: string; count: number; affixVisualStyle: string; affixSignature: string }>,
    keepAtLeast = 1
  ) {
    if (batchDismantling.value) {
      return
    }
    if (rows.length <= 0) {
      batchDismantleError.value = '请先勾选至少一个可分解变体'
      return
    }

    batchDismantling.value = true
    batchDismantleError.value = null

    try {
      const idempotencyKey = buildBatchDismantleIdempotencyKey(rows, keepAtLeast)
      const res = await gacha.dismantleBatchSelective(rows.map((r) => ({
        cardId: r.cardId,
        count: r.count,
        affixSignature: r.affixSignature || undefined,
        affixVisualStyle: r.affixVisualStyle || undefined
      })), {
        keepAtLeast,
        idempotencyKey
      })

      if (!res.ok) {
        batchDismantleError.value = res.error || '批量分解失败'
        return
      }

      await refreshPages(true)
      closeBatchDismantleDialog()
      const summary = res.summary
      emitSuccess(`批量分解完成：共分解 ${formatTokens(summary?.totalCount || 0)} 张，返还 ${formatTokens(summary?.totalReward || 0)} Token。`)
    } catch (error: unknown) {
      batchDismantleError.value = normalizeError(error, '批量分解失败')
    } finally {
      batchDismantling.value = false
    }
  }

  // ─── Quick Dismantle ──────────────────────────────
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

  async function loadInitial() {
    await refreshPages(true)
  }

  return {
    // Pagination
    albumPage,
    albumTotal,
    albumItems,
    albumLoading,
    loadAlbumPage,

    // Loading state
    loadingPages,

    // Summary
    albumSummary,
    totalPages,
    totalImageVariants,
    totalImageVariantsInPool,
    totalPagesInPool,
    coatingStyles,
    totalOwnedCount,

    // Search & Filter
    searchKeyword,
    pageRarityFilter,

    // Core
    refreshPages,
    updateVariantLockStatus,

    // Batch Dismantle
    batchDismantleDialogOpen,
    batchDismantling,
    batchDismantleLoading,
    batchDismantleError,
    batchDismantleCandidates,
    openBatchDismantleDialog,
    closeBatchDismantleDialog,
    confirmBatchDismantle,

    // Quick Dismantle
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
