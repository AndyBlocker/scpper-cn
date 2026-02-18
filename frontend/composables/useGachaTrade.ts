import { computed, ref, watch } from 'vue'
import type { GachaPageContext } from '~/composables/useGachaPage'
import type {
  AffixVisualStyle,
  HistoryItem,
  InventoryItem,
  Rarity,
  TradeListing,
  BuyRequest,
  PageCatalogEntry,
  BuyRequestMatchLevel
} from '~/types/gacha'
import {
  resolveAffixSignatureFromSource,
  resolveAffixStyleCounts,
  resolvePrimaryAffixStyleFromSource
} from '~/utils/gachaAffix'
import { raritySortWeight } from '~/utils/gachaRarity'
import { displayCardTitle } from '~/utils/gachaTitle'
import type { TradeSortMode } from '~/utils/gachaConstants'
import type { BuyRequestSortMode } from '~/utils/gachaConstants'
import { paginatedLoadAll } from '~/utils/gachaPagination'
import { usePageAuthors } from '~/composables/usePageAuthors'

/**
 * trade.vue (集换市场页面) 的状态管理和业务逻辑。
 * 从 useGachaIndex 中提取所有 trade 相关的 state + computed + handlers。
 */
export function useGachaTrade(page: GachaPageContext) {
  const { gacha, activated, emitError, handleWalletUpdated } = page
  const pageAuthors = usePageAuthors()

  // ─── Local Wrapper for placementSlotKey ──────────────
  // Handles null cardId and normalizes signature via resolveAffixSignatureFromSource
  function placementSlotKey(
    cardId: string | null | undefined,
    affixSignature: string | null | undefined,
    style: AffixVisualStyle | null | undefined
  ): string {
    if (!cardId) return ''
    return `${cardId}::${resolveAffixSignatureFromSource({
      affixSignature,
      affixVisualStyle: style
    })}`
  }

  // ─── History (for StatusBar) ────────────────────────
  const history = ref<HistoryItem[]>([])

  // ─── Placement Options (needed for inventory/trade card computation) ───
  const placementOptions = ref<InventoryItem[]>([])
  const placementOptionsLoading = ref(false)
  const placementOptionsRefreshQueued = ref(false)

  // ─── Trade State ──────────────────────────────────────
  const tradeListings = ref<TradeListing[]>([])
  const myTradeListings = ref<TradeListing[]>([])
  const tradeLoading = ref(false)
  const tradeSubmitting = ref(false)
  const tradeBuyingId = ref<string | null>(null)
  const tradeCancelId = ref<string | null>(null)
  const tradeCardId = ref<string>('')
  const tradeQuantity = ref<number>(1)
  const tradeUnitPrice = ref<number>(100)
  const tradeExpiresHours = ref<number>(72)
  const tradeSearch = ref('')
  const tradeSearchMode = ref<'ALL' | 'CARD' | 'SELLER'>('ALL')
  const tradeSortMode = ref<TradeSortMode>('LATEST')
  const tradeRarityFilter = ref<Rarity | 'ALL'>('ALL')
  const tradeMyStatusFilter = ref<TradeListing['status'] | 'ALL'>('ALL')
  const tradePublicOffset = ref(0)
  const tradePublicTotal = ref(0)
  const tradePublicLoadingMore = ref(false)
  const tradePublicQueryLoading = ref(false)

  // ─── Internal Flags ───────────────────────────────────
  const TRADE_PUBLIC_PAGE_SIZE = 120
  const TRADE_PUBLIC_QUERY_DEBOUNCE_MS = 280
  let tradePublicQueryTimer: ReturnType<typeof setTimeout> | null = null
  let tradePublicRequestSeq = 0
  let tradeAuthorQueueTimer: ReturnType<typeof setTimeout> | null = null
  const tradeAuthorQueue = new Set<number>()

  // ─── Buy Request State ─────────────────────────────────
  const buyRequests = ref<BuyRequest[]>([])
  const myBuyRequests = ref<BuyRequest[]>([])
  const cardCatalog = ref<PageCatalogEntry[]>([])
  const buyRequestLoading = ref(false)
  const buyRequestSubmitting = ref(false)
  const buyRequestFulfillingId = ref<string | null>(null)
  const buyRequestCancelId = ref<string | null>(null)
  const buyRequestSearch = ref('')
  const buyRequestSortMode = ref<BuyRequestSortMode>('LATEST')
  const buyRequestRarityFilter = ref<Rarity | 'ALL'>('ALL')
  const buyRequestPublicOffset = ref(0)
  const buyRequestPublicTotal = ref(0)
  const buyRequestPublicLoadingMore = ref(false)
  const buyRequestPublicQueryLoading = ref(false)
  const BUY_REQUEST_PUBLIC_PAGE_SIZE = 60
  const BUY_REQUEST_QUERY_DEBOUNCE_MS = 280
  let buyRequestQueryTimer: ReturnType<typeof setTimeout> | null = null
  let buyRequestRequestSeq = 0

  // ─── Placement (for StatusBar) ────────────────────────
  const placement = computed(() => page.gacha.state.value.placement)

  // ─── Placement Assigned Count (for trade quantity calculation) ──
  const placementAssignedCount = computed<Record<string, number>>(() => {
    const pl = page.gacha.state.value.placement
    const map: Record<string, number> = {}
    ;(pl?.slots ?? []).forEach((slot) => {
      const key = placementSlotKey(
        slot.card?.id ?? null,
        slot.card?.affixSignature,
        slot.card?.affixVisualStyle
      )
      if (!key) return
      map[key] = (map[key] || 0) + 1
    })
    ;(pl?.addons ?? []).forEach((addon) => {
      const key = placementSlotKey(
        addon.card?.id ?? null,
        addon.card?.affixSignature,
        addon.card?.affixVisualStyle
      )
      if (!key) return
      map[key] = (map[key] || 0) + 1
    })
    return map
  })

  // ═══════════════════════════════════════════════════════
  // HELPER FUNCTIONS
  // ═══════════════════════════════════════════════════════

  function compareInventoryRarity(
    a: Pick<InventoryItem, 'rarity'>,
    b: Pick<InventoryItem, 'rarity'>
  ) {
    return (raritySortWeight[a.rarity] ?? 99) - (raritySortWeight[b.rarity] ?? 99)
  }

  function compareInventoryRarityAndTitle(
    a: Pick<InventoryItem, 'rarity' | 'title' | 'cardId' | 'affixSignature' | 'affixVisualStyle'>,
    b: Pick<InventoryItem, 'rarity' | 'title' | 'cardId' | 'affixSignature' | 'affixVisualStyle'>
  ) {
    const rarityDiff = compareInventoryRarity(a, b)
    if (rarityDiff !== 0) return rarityDiff
    const titleDiff = a.title.localeCompare(b.title, 'zh-CN')
    if (titleDiff !== 0) return titleDiff
    const cardDiff = a.cardId.localeCompare(b.cardId, 'zh-CN')
    if (cardDiff !== 0) return cardDiff
    return placementSlotKey(a.cardId, a.affixSignature, a.affixVisualStyle)
      .localeCompare(placementSlotKey(b.cardId, b.affixSignature, b.affixVisualStyle), 'zh-CN')
  }

  function mergedAffixStyleCounts(
    left: Partial<Record<AffixVisualStyle, number>> | null | undefined,
    right: Pick<InventoryItem, 'affixSignature' | 'affixStyles' | 'affixStyleCounts' | 'affixVisualStyle'>
  ): Partial<Record<AffixVisualStyle, number>> {
    const merged: Partial<Record<AffixVisualStyle, number>> = {}
    const append = (source: Partial<Record<AffixVisualStyle, number>> | null | undefined) => {
      if (!source) return
      for (const [styleRaw, valueRaw] of Object.entries(source)) {
        const style = styleRaw as AffixVisualStyle
        const value = Math.max(0, Math.floor(Number(valueRaw ?? 0)))
        if (style === 'NONE' || value <= 0) continue
        merged[style] = (merged[style] || 0) + value
      }
    }
    append(left)
    append(resolveAffixStyleCounts(right))
    return merged
  }

  // ═══════════════════════════════════════════════════════
  // COMPUTED PROPERTIES
  // ═══════════════════════════════════════════════════════

  const tradeCardOptions = computed(() => {
    const grouped = new Map<string, InventoryItem & { availableCount: number; stackKey: string }>()
    for (const item of placementOptions.value) {
      const stackKey = placementSlotKey(item.cardId, item.affixSignature, item.affixVisualStyle)
      if (!stackKey) continue
      const assignedElsewhere = placementAssignedCount.value[stackKey] || 0
      const availableCount = Math.max(0, item.count - assignedElsewhere)
      if (availableCount <= 0) continue
      const normalizedAffixSignature = resolveAffixSignatureFromSource(item)
      const current = grouped.get(stackKey)
      if (!current) {
        grouped.set(stackKey, {
          ...item,
          stackKey,
          count: item.count,
          availableCount,
          affixSignature: normalizedAffixSignature
        })
        continue
      }
      current.count += item.count
      current.availableCount += availableCount
      current.affixStyleCounts = mergedAffixStyleCounts(current.affixStyleCounts, item)
      current.affixVisualStyle = resolvePrimaryAffixStyleFromSource({
        affixStyleCounts: current.affixStyleCounts,
        affixVisualStyle: current.affixVisualStyle,
        affixStyles: current.affixStyles,
        affixSignature: current.affixSignature
      })
      current.affixSignature = resolveAffixSignatureFromSource({
        affixStyleCounts: current.affixStyleCounts,
        affixVisualStyle: current.affixVisualStyle
      })
      if (!current.affixLabel && item.affixLabel) {
        current.affixLabel = item.affixLabel
      }
      if (!(current.authors?.length) && (item.authors?.length ?? 0) > 0) {
        current.authors = item.authors
      }
    }
    return Array.from(grouped.values())
      .filter((item) => item.availableCount > 0)
      .sort((a, b) => compareInventoryRarityAndTitle(a, b))
  })

  const tradeCardOptionsForPanel = computed(() => tradeCardOptions.value.map((item) => ({
    stackKey: item.stackKey,
    cardId: item.cardId,
    title: item.title,
    rarity: item.rarity,
    imageUrl: item.imageUrl ?? null,
    wikidotId: item.wikidotId ?? null,
    pageId: item.pageId ?? null,
    tags: item.tags ?? [],
    authors: item.authors ?? null,
    availableCount: item.availableCount,
    affixSignature: item.affixSignature,
    affixStyles: item.affixStyles,
    affixStyleCounts: item.affixStyleCounts,
    affixVisualStyle: item.affixVisualStyle,
    affixLabel: item.affixLabel
  })))

  const selectedTradeCardOption = computed(() => tradeCardOptions.value.find((item) => item.cardId === tradeCardId.value) ?? null)

  const tradeQuantityMax = computed(() => Math.max(1, selectedTradeCardOption.value?.availableCount ?? 1))

  // Broad set of all owned card IDs (regardless of placement/lock/showcase), for buy request fulfillment check
  const ownedCardIds = computed(() => new Set(placementOptions.value.map((item) => item.cardId)))

  const publicTradeListings = computed(() => tradeListings.value
    .filter((item) => item.status === 'OPEN' && item.remaining > 0))

  const tradePublicHasMore = computed(() => {
    const total = Math.max(0, Number(tradePublicTotal.value || 0))
    return total > tradeListings.value.length
  })

  const myOpenTradeCount = computed(() => myTradeListings.value.filter((item) => item.status === 'OPEN' && item.remaining > 0).length)

  // ═══════════════════════════════════════════════════════
  // REFRESH HANDLERS
  // ═══════════════════════════════════════════════════════

  async function refreshHistory() {
    if (!activated.value) {
      history.value = []
      return
    }
    try {
      const res = await gacha.getHistory({ limit: 8 })
      if (res.ok) {
        history.value = res.data ?? []
      }
    } catch (error) {
      console.warn('[gacha] load history failed', error)
    }
  }

  async function refreshPlacementOptions() {
    if (!activated.value) {
      placementOptions.value = []
      placementOptionsLoading.value = false
      placementOptionsRefreshQueued.value = false
      return
    }
    if (placementOptionsLoading.value) {
      placementOptionsRefreshQueued.value = true
      return
    }
    placementOptionsLoading.value = true
    placementOptionsRefreshQueued.value = false
    try {
      const allItems = await paginatedLoadAll<InventoryItem>({
        fetchPage: async (offset, limit, skipTotal) => {
          const res = await gacha.getInventory({ limit, offset, skipTotal })
          if (!res.ok) throw new Error(res.error || '加载放置卡片库存失败')
          return { items: res.data ?? [], total: res.total ?? 0, pageRows: Number(res.pageRows ?? 0) }
        },
        pageSize: 1000
      })
      const byStackKey = new Map<string, InventoryItem>()
      for (const item of allItems) {
        if (!item) continue
        const itemCount = Math.max(0, Math.floor(Number(item.count ?? 0)))
        if (itemCount <= 0) continue
        const stackKey = placementSlotKey(item.cardId, item.affixSignature, item.affixVisualStyle)
        if (!stackKey) continue
        const existing = byStackKey.get(stackKey)
        if (!existing) {
          byStackKey.set(stackKey, {
            ...item,
            count: itemCount
          })
        } else {
          existing.count = Math.max(0, Math.floor(Number(existing.count ?? 0))) + itemCount
        }
      }
      const items = Array.from(byStackKey.values())
        .sort((a, b) => compareInventoryRarityAndTitle(a, b))
      placementOptions.value = items
      seedAuthorCacheForInventory(items)
      queueAuthorHydration(items.map((item) => item.wikidotId))
    } catch (error) {
      console.warn('[gacha] load placement options failed', error)
    } finally {
      placementOptionsLoading.value = false
      if (placementOptionsRefreshQueued.value) {
        placementOptionsRefreshQueued.value = false
        await refreshPlacementOptions()
      }
    }
  }

  // ─── Trade Refresh Handlers ───────────────────────────

  function clearTradePublicQueryTimer() {
    if (!tradePublicQueryTimer) return
    clearTimeout(tradePublicQueryTimer)
    tradePublicQueryTimer = null
  }

  function queueAuthorHydration(ids: Array<number | null | undefined>) {
    ids.forEach((value) => {
      const id = Number(value)
      if (!Number.isFinite(id) || id <= 0) return
      tradeAuthorQueue.add(id)
    })
    if (!tradeAuthorQueue.size) return
    if (tradeAuthorQueueTimer) return
    tradeAuthorQueueTimer = setTimeout(() => {
      tradeAuthorQueueTimer = null
      const batch = Array.from(tradeAuthorQueue)
      tradeAuthorQueue.clear()
      void pageAuthors.ensureAuthors(batch)
    }, 80)
  }

  function seedAuthorCacheForListings(listings: TradeListing[]) {
    for (const listing of listings) {
      pageAuthors.seedAuthors(listing.card.wikidotId ?? null, listing.card.authors ?? null)
    }
  }

  function seedAuthorCacheForBuyRequests(requests: BuyRequest[]) {
    for (const br of requests) {
      pageAuthors.seedAuthors(br.targetCard.wikidotId ?? null, br.targetCard.authors ?? null)
      for (const oc of br.offeredCards) {
        pageAuthors.seedAuthors(oc.card.wikidotId ?? null, oc.card.authors ?? null)
      }
    }
  }

  function seedAuthorCacheForCatalog(pages: PageCatalogEntry[]) {
    for (const page of pages) {
      pageAuthors.seedAuthors(page.wikidotId ?? null, page.authors ?? null)
    }
  }

  function seedAuthorCacheForInventory(items: InventoryItem[]) {
    for (const item of items) {
      pageAuthors.seedAuthors(item.wikidotId ?? null, item.authors ?? null)
    }
  }

  async function loadPublicTradeListings(reset = false) {
    const offset = reset ? 0 : tradePublicOffset.value
    const requestSeq = ++tradePublicRequestSeq
    const search = tradeSearch.value.trim()
    const res = await gacha.getTradeListings({
      status: 'OPEN',
      search: search || undefined,
      searchMode: tradeSearchMode.value,
      rarity: tradeRarityFilter.value === 'ALL' ? undefined : tradeRarityFilter.value,
      sort: tradeSortMode.value,
      limit: TRADE_PUBLIC_PAGE_SIZE,
      offset
    })
    if (requestSeq !== tradePublicRequestSeq) {
      return { ok: false as const, stale: true, error: '' }
    }
    if (!res.ok) return { ...res, stale: false as const }
    const chunk = res.data ?? []
    seedAuthorCacheForListings(chunk)
    queueAuthorHydration(chunk.map((listing) => listing.card.wikidotId))
    if (reset) {
      tradeListings.value = chunk
    } else {
      const merged = new Map<string, TradeListing>()
      for (const listing of tradeListings.value) {
        merged.set(listing.id, listing)
      }
      for (const listing of chunk) {
        merged.set(listing.id, listing)
      }
      tradeListings.value = Array.from(merged.values())
    }
    const totalRaw = Number(res.pagination?.total ?? tradeListings.value.length)
    tradePublicTotal.value = Number.isFinite(totalRaw) ? Math.max(0, totalRaw) : tradeListings.value.length
    tradePublicOffset.value = offset + chunk.length
    return { ok: true as const, stale: false as const, data: tradeListings.value }
  }

  async function loadMorePublicTradeListings() {
    if (
      !activated.value
      || tradeLoading.value
      || tradePublicLoadingMore.value
      || tradePublicQueryLoading.value
      || !tradePublicHasMore.value
    ) return
    tradePublicLoadingMore.value = true
    try {
      const res = await loadPublicTradeListings(false)
      if (!res.ok && !res.stale) {
        emitError(res.error || '加载更多挂牌失败')
      }
    } finally {
      tradePublicLoadingMore.value = false
    }
  }

  function schedulePublicTradeQueryRefresh() {
    clearTradePublicQueryTimer()
    tradePublicQueryTimer = setTimeout(() => {
      tradePublicQueryTimer = null
      void refreshPublicTradeListingsByQuery()
    }, TRADE_PUBLIC_QUERY_DEBOUNCE_MS)
  }

  async function refreshPublicTradeListingsByQuery() {
    if (!activated.value) return
    if (tradePublicQueryLoading.value || tradeLoading.value) {
      schedulePublicTradeQueryRefresh()
      return
    }
    tradePublicQueryLoading.value = true
    try {
      const res = await loadPublicTradeListings(true)
      if (!res.ok && !res.stale) {
        emitError(res.error || '加载集换市场失败')
      }
    } finally {
      tradePublicQueryLoading.value = false
    }
  }

  function setPublicTradeQuery(payload: {
    search?: string
    searchMode?: 'ALL' | 'CARD' | 'SELLER'
    sort?: TradeSortMode
    rarity?: Rarity | 'ALL'
  }) {
    const nextSearch = String(payload.search ?? '').trim()
    const nextSearchMode = payload.searchMode ?? 'ALL'
    const nextSortMode = payload.sort ?? 'LATEST'
    const nextRarity = payload.rarity ?? 'ALL'
    const changed = (
      nextSearch !== tradeSearch.value
      || nextSearchMode !== tradeSearchMode.value
      || nextSortMode !== tradeSortMode.value
      || nextRarity !== tradeRarityFilter.value
    )
    if (!changed) return
    tradeSearch.value = nextSearch
    tradeSearchMode.value = nextSearchMode
    tradeSortMode.value = nextSortMode
    tradeRarityFilter.value = nextRarity
    schedulePublicTradeQueryRefresh()
  }

  async function refreshTradePanel(options: { syncInventory?: boolean; resetPublic?: boolean } = {}) {
    const syncInventory = options.syncInventory ?? false
    const resetPublic = options.resetPublic ?? true
    clearTradePublicQueryTimer()
    if (!activated.value) {
      tradeListings.value = []
      myTradeListings.value = []
      tradePublicOffset.value = 0
      tradePublicTotal.value = 0
      tradePublicQueryLoading.value = false
      return
    }
    if (tradeLoading.value) return
    tradeLoading.value = true
    try {
      // Load inventory, public listings, and my listings all in parallel
      const [, publicRes, mineRes] = await Promise.all([
        syncInventory ? refreshPlacementOptions() : Promise.resolve(),
        loadPublicTradeListings(resetPublic),
        gacha.getMyTradeListings()
      ])
      if (!publicRes.ok && !publicRes.stale) {
        emitError(publicRes.error || '加载集换市场失败')
      }
      if (!mineRes.ok) {
        emitError(mineRes.error || '加载我的挂牌失败')
      } else {
        myTradeListings.value = mineRes.data ?? []
        seedAuthorCacheForListings(myTradeListings.value)
        queueAuthorHydration(myTradeListings.value.map((listing) => listing.card.wikidotId))
      }
      if (!tradeCardId.value && tradeCardOptions.value.length > 0) {
        tradeCardId.value = tradeCardOptions.value[0]!.cardId
      }
      if (tradeQuantity.value > tradeQuantityMax.value) {
        tradeQuantity.value = tradeQuantityMax.value
      }
    } finally {
      tradeLoading.value = false
    }
  }

  // ═══════════════════════════════════════════════════════
  // ACTION HANDLERS
  // ═══════════════════════════════════════════════════════

  async function handleCreateTradeListingFromPanel(payload: {
    cardId: string
    quantity: number
    unitPrice: number
    expiresHours: number
    affixSignature?: string
  }) {
    if (tradeSubmitting.value) return
    tradeSubmitting.value = true
    try {
      const res = await gacha.createTradeListing(payload)
      if (!res.ok) {
        emitError(res.error || '上架失败')
        return
      }
      if (res.wallet) {
        handleWalletUpdated(res.wallet)
      }
      await refreshTradePanel({ syncInventory: false, resetPublic: true })
      placementOptionsRefreshQueued.value = true
    } finally {
      tradeSubmitting.value = false
    }
  }

  async function handleBuyTradeListing(listing: TradeListing) {
    if (tradeBuyingId.value) return
    tradeBuyingId.value = listing.id
    try {
      const res = await gacha.buyTradeListing(listing.id, { quantity: listing.remaining })
      if (!res.ok) {
        emitError(res.error || '购买失败')
        return
      }
      if (res.wallet) {
        handleWalletUpdated(res.wallet)
      }
      await refreshTradePanel({ syncInventory: false, resetPublic: true })
      placementOptionsRefreshQueued.value = true
    } finally {
      tradeBuyingId.value = null
    }
  }

  async function handleCancelTradeListing(listing: TradeListing) {
    if (tradeCancelId.value) return
    tradeCancelId.value = listing.id
    try {
      const res = await gacha.cancelTradeListing(listing.id)
      if (!res.ok) {
        emitError(res.error || '撤单失败')
        return
      }
      if (res.wallet) {
        handleWalletUpdated(res.wallet)
      }
      await refreshTradePanel({ syncInventory: false, resetPublic: true })
      placementOptionsRefreshQueued.value = true
    } finally {
      tradeCancelId.value = null
    }
  }

  async function handleBuyTradeListingById(listingId: string) {
    const listing = tradeListings.value.find((l) => l.id === listingId)
    if (!listing) {
      emitError('找不到该挂牌')
      return
    }
    await handleBuyTradeListing(listing)
  }

  async function handleCancelTradeListingById(listingId: string) {
    const listing = [...tradeListings.value, ...myTradeListings.value].find((l) => l.id === listingId)
    if (!listing) {
      emitError('找不到该挂牌')
      return
    }
    await handleCancelTradeListing(listing)
  }

  // ═══════════════════════════════════════════════════════
  // BUY REQUEST COMPUTED & HANDLERS
  // ═══════════════════════════════════════════════════════

  const publicBuyRequests = computed(() => buyRequests.value.filter((br) => br.status === 'OPEN'))

  const buyRequestPublicHasMore = computed(() => {
    const total = Math.max(0, Number(buyRequestPublicTotal.value || 0))
    return total > buyRequests.value.length
  })

  const myOpenBuyRequestCount = computed(() =>
    myBuyRequests.value.filter((br) => br.status === 'OPEN').length
  )

  function clearBuyRequestQueryTimer() {
    if (!buyRequestQueryTimer) return
    clearTimeout(buyRequestQueryTimer)
    buyRequestQueryTimer = null
  }

  async function loadPublicBuyRequests(reset = false) {
    const offset = reset ? 0 : buyRequestPublicOffset.value
    const requestSeq = ++buyRequestRequestSeq
    const res = await gacha.getBuyRequests({
      status: 'OPEN',
      search: buyRequestSearch.value.trim() || undefined,
      rarity: buyRequestRarityFilter.value === 'ALL' ? undefined : buyRequestRarityFilter.value,
      sort: buyRequestSortMode.value,
      limit: BUY_REQUEST_PUBLIC_PAGE_SIZE,
      offset
    })
    if (requestSeq !== buyRequestRequestSeq) {
      return { ok: false as const, stale: true, error: '' }
    }
    if (!res.ok) return { ...res, stale: false as const }
    const chunk = res.data ?? []
    seedAuthorCacheForBuyRequests(chunk)
    queueAuthorHydration(chunk.map((br) => br.targetCard.wikidotId))
    if (reset) {
      buyRequests.value = chunk
    } else {
      const merged = new Map<string, BuyRequest>()
      for (const br of buyRequests.value) merged.set(br.id, br)
      for (const br of chunk) merged.set(br.id, br)
      buyRequests.value = Array.from(merged.values())
    }
    const totalRaw = Number(res.pagination?.total ?? buyRequests.value.length)
    buyRequestPublicTotal.value = Number.isFinite(totalRaw) ? Math.max(0, totalRaw) : buyRequests.value.length
    buyRequestPublicOffset.value = offset + chunk.length
    return { ok: true as const, stale: false as const }
  }

  async function loadMorePublicBuyRequests() {
    if (!activated.value || buyRequestLoading.value || buyRequestPublicLoadingMore.value || !buyRequestPublicHasMore.value) return
    buyRequestPublicLoadingMore.value = true
    try {
      const res = await loadPublicBuyRequests(false)
      if (!res.ok && !res.stale) emitError(res.error || '加载更多求购失败')
    } finally {
      buyRequestPublicLoadingMore.value = false
    }
  }

  async function refreshPublicBuyRequestsByQuery() {
    if (!activated.value) return
    if (buyRequestPublicQueryLoading.value || buyRequestLoading.value) {
      scheduleBuyRequestQueryRefresh()
      return
    }
    buyRequestPublicQueryLoading.value = true
    try {
      const res = await loadPublicBuyRequests(true)
      if (!res.ok && !res.stale) emitError(res.error || '加载求购列表失败')
    } finally {
      buyRequestPublicQueryLoading.value = false
    }
  }

  function scheduleBuyRequestQueryRefresh() {
    clearBuyRequestQueryTimer()
    buyRequestQueryTimer = setTimeout(() => {
      buyRequestQueryTimer = null
      void refreshPublicBuyRequestsByQuery()
    }, BUY_REQUEST_QUERY_DEBOUNCE_MS)
  }

  function setBuyRequestQuery(payload: {
    search?: string
    sort?: BuyRequestSortMode
    rarity?: Rarity | 'ALL'
  }) {
    const nextSearch = String(payload.search ?? '').trim()
    const nextSortMode = payload.sort ?? 'LATEST'
    const nextRarity = payload.rarity ?? 'ALL'
    const changed = (
      nextSearch !== buyRequestSearch.value
      || nextSortMode !== buyRequestSortMode.value
      || nextRarity !== buyRequestRarityFilter.value
    )
    if (!changed) return
    buyRequestSearch.value = nextSearch
    buyRequestSortMode.value = nextSortMode
    buyRequestRarityFilter.value = nextRarity
    scheduleBuyRequestQueryRefresh()
  }

  async function refreshBuyRequestPanel(options: { resetPublic?: boolean } = {}) {
    const resetPublic = options.resetPublic ?? true
    clearBuyRequestQueryTimer()
    if (!activated.value) {
      buyRequests.value = []
      myBuyRequests.value = []
      buyRequestPublicOffset.value = 0
      buyRequestPublicTotal.value = 0
      return
    }
    if (buyRequestLoading.value) return
    buyRequestLoading.value = true
    try {
      const [publicRes, mineRes, catalogRes] = await Promise.all([
        loadPublicBuyRequests(resetPublic),
        gacha.getMyBuyRequests(),
        cardCatalog.value.length === 0 ? gacha.getPageCatalog() : Promise.resolve({ ok: true as const, data: cardCatalog.value })
      ])
      if (!publicRes.ok && !publicRes.stale) emitError(publicRes.error || '加载求购列表失败')
      if (!mineRes.ok) {
        emitError(mineRes.error || '加载我的求购失败')
      } else {
        myBuyRequests.value = mineRes.data ?? []
        seedAuthorCacheForBuyRequests(myBuyRequests.value)
        queueAuthorHydration(myBuyRequests.value.map((br) => br.targetCard.wikidotId))
      }
      if (catalogRes.ok) {
        cardCatalog.value = catalogRes.data ?? []
        seedAuthorCacheForCatalog(cardCatalog.value)
        queueAuthorHydration(cardCatalog.value.map((p) => p.wikidotId))
      }
    } finally {
      buyRequestLoading.value = false
    }
  }

  async function handleCreateBuyRequest(payload: {
    targetCardId: string
    matchLevel?: BuyRequestMatchLevel
    requiredCoating?: AffixVisualStyle
    tokenOffer: number
    offeredCards: Array<{ cardId: string; affixSignature?: string; quantity: number }>
    expiresHours: number
  }) {
    if (buyRequestSubmitting.value) return
    buyRequestSubmitting.value = true
    try {
      const res = await gacha.createBuyRequest(payload)
      if (!res.ok) {
        emitError(res.error || '创建求购失败')
        return
      }
      if (res.wallet) handleWalletUpdated(res.wallet)
      await Promise.all([
        refreshBuyRequestPanel({ resetPublic: true }),
        refreshPlacementOptions()
      ])
    } finally {
      buyRequestSubmitting.value = false
    }
  }

  async function handleFulfillBuyRequest(buyRequestId: string) {
    if (buyRequestFulfillingId.value) return
    buyRequestFulfillingId.value = buyRequestId
    try {
      const res = await gacha.fulfillBuyRequest(buyRequestId)
      if (!res.ok) {
        emitError(res.error || '接受求购失败')
        return
      }
      if (res.wallet) handleWalletUpdated(res.wallet)
      await Promise.all([
        refreshBuyRequestPanel({ resetPublic: true }),
        refreshPlacementOptions()
      ])
    } finally {
      buyRequestFulfillingId.value = null
    }
  }

  async function handleCancelBuyRequest(buyRequestId: string) {
    if (buyRequestCancelId.value) return
    buyRequestCancelId.value = buyRequestId
    try {
      const res = await gacha.cancelBuyRequest(buyRequestId)
      if (!res.ok) {
        emitError(res.error || '取消求购失败')
        return
      }
      if (res.wallet) handleWalletUpdated(res.wallet)
      await Promise.all([
        refreshBuyRequestPanel({ resetPublic: true }),
        refreshPlacementOptions()
      ])
    } finally {
      buyRequestCancelId.value = null
    }
  }

  // ═══════════════════════════════════════════════════════
  // LIFECYCLE
  // ═══════════════════════════════════════════════════════

  async function loadInitial() {
    // 必须先等 config 就绪（设置 activated），afterLoad 中的 refreshTradePanel 依赖它
    await page.refreshConfig(false)
  }

  // ═══════════════════════════════════════════════════════
  // WATCHERS
  // ═══════════════════════════════════════════════════════

  watch(tradeCardId, () => {
    if (tradeQuantity.value > tradeQuantityMax.value) {
      tradeQuantity.value = tradeQuantityMax.value
    }
    if (tradeQuantity.value < 1) {
      tradeQuantity.value = 1
    }
  })

  // ═══════════════════════════════════════════════════════
  // CLEANUP
  // ═══════════════════════════════════════════════════════

  function cleanup() {
    clearTradePublicQueryTimer()
    clearBuyRequestQueryTimer()
    if (tradeAuthorQueueTimer) {
      clearTimeout(tradeAuthorQueueTimer)
      tradeAuthorQueueTimer = null
    }
    tradeAuthorQueue.clear()
  }

  // ═══════════════════════════════════════════════════════
  // RETURN
  // ═══════════════════════════════════════════════════════

  return {
    // History (for StatusBar)
    history,
    refreshHistory,

    // Placement (for StatusBar)
    placement,

    // Placement options (for inventory / trade card computation)
    placementOptions,
    placementOptionsLoading,
    placementOptionsRefreshQueued,
    placementAssignedCount,
    refreshPlacementOptions,

    // Trade state
    tradeListings,
    myTradeListings,
    tradeLoading,
    tradeSubmitting,
    tradeBuyingId,
    tradeCancelId,
    tradeCardId,
    tradeQuantity,
    tradeUnitPrice,
    tradeExpiresHours,
    tradeSearch,
    tradeSearchMode,
    tradeSortMode,
    tradeRarityFilter,
    tradeMyStatusFilter,
    tradePublicOffset,
    tradePublicTotal,
    tradePublicLoadingMore,
    tradePublicQueryLoading,

    // Trade computed
    tradeCardOptions,
    tradeCardOptionsForPanel,
    selectedTradeCardOption,
    tradeQuantityMax,
    publicTradeListings,
    tradePublicHasMore,
    myOpenTradeCount,
    ownedCardIds,

    // Trade handlers
    loadPublicTradeListings,
    loadMorePublicTradeListings,
    refreshTradePanel,
    refreshPublicTradeListingsByQuery,
    setPublicTradeQuery,
    handleCreateTradeListingFromPanel,
    handleBuyTradeListing,
    handleCancelTradeListing,
    handleBuyTradeListingById,
    handleCancelTradeListingById,

    // Buy Request state
    buyRequests,
    myBuyRequests,
    cardCatalog,
    buyRequestLoading,
    buyRequestSubmitting,
    buyRequestFulfillingId,
    buyRequestCancelId,
    buyRequestSearch,
    buyRequestSortMode,
    buyRequestRarityFilter,
    buyRequestPublicOffset,
    buyRequestPublicTotal,
    buyRequestPublicLoadingMore,
    buyRequestPublicQueryLoading,

    // Buy Request computed
    publicBuyRequests,
    buyRequestPublicHasMore,
    myOpenBuyRequestCount,

    // Buy Request handlers
    loadPublicBuyRequests,
    loadMorePublicBuyRequests,
    refreshBuyRequestPanel,
    refreshPublicBuyRequestsByQuery,
    setBuyRequestQuery,
    handleCreateBuyRequest,
    handleFulfillBuyRequest,
    handleCancelBuyRequest,

    // Lifecycle
    loadInitial,

    // Cleanup (call from onBeforeUnmount)
    cleanup,

    // Utility
    placementSlotKey,
    displayCardTitle,
    handleWalletUpdated
  }
}
