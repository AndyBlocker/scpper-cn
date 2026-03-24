<script setup lang="ts">
/**
 * 集换 tab 面板。
 * 从 index.vue 提取，包含发布挂牌、我的挂牌、公共挂牌三个区域。
 * 模板已拆分到 trade/ 子组件：TradeSellForm, TradeListings, TradeBuyForm, TradeDetail
 */
import { computed, ref, watch } from 'vue'
import { onBeforeUnmount, onMounted } from 'vue'
import type { AffixVisualStyle, Rarity, TradeListing, BuyRequest, PageCatalogEntry, BuyRequestMatchLevel } from '~/types/gacha'
import { formatTokens, formatDateCompact } from '~/utils/gachaFormatters'
import { rarityLabel } from '~/utils/gachaRarity'
import { resolveAffixParts } from '~/utils/gachaAffix'
import { tradeStatusLabelMap, tradeStatusChipClassMap, buyRequestStatusLabelMap, buyRequestStatusChipClassMap, buyRequestMatchLevelLabelMap, buyRequestMatchLevelShortMap, coatingStyleLabelMap } from '~/utils/gachaConstants'
import type { BuyRequestSortMode } from '~/utils/gachaConstants'
import { usePageAuthors } from '~/composables/usePageAuthors'
import { resolveAuthorSearchText } from '~/utils/gachaAuthorSearch'
import GachaCardMini from '~/components/gacha/GachaCardMini.vue'
import GachaAffixChip from '~/components/gacha/GachaAffixChip.vue'
import { UiButton } from '~/components/ui/button'
import { UiSelectRoot, UiSelectTrigger, UiSelectContent, UiSelectItem } from '~/components/ui/select'
import TradeSellForm from '~/components/gacha/trade/TradeSellForm.vue'
import TradeListings from '~/components/gacha/trade/TradeListings.vue'
import TradeBuyForm from '~/components/gacha/trade/TradeBuyForm.vue'
import TradeDetail from '~/components/gacha/trade/TradeDetail.vue'

// ─── 类型 ────────────────────────────────────────────────

interface TradeCardOption {
  stackKey: string
  cardId: string
  title: string
  rarity: Rarity
  imageUrl: string | null
  isRetired?: boolean
  wikidotId?: number | null
  pageId?: number | null
  tags?: string[]
  authors?: Array<{ name: string; wikidotId: number | null }> | null
  availableCount: number
  affixSignature?: string
  affixStyles?: AffixVisualStyle[]
  affixStyleCounts?: Partial<Record<AffixVisualStyle, number>>
  affixVisualStyle?: AffixVisualStyle
  affixLabel?: string
}

interface BuyRequestFulfillPayload {
  buyRequestId: string
  selectedCardId?: string
  selectedAffixSignature?: string
}

type BuyRequestDraft =
  | { targetCardId: string; matchLevel: 'PAGE' }
  | { targetCardId: string; matchLevel: 'IMAGE_VARIANT' }
  | { targetCardId: string; matchLevel: 'COATING'; requiredCoating: AffixVisualStyle }

type TradeSortMode = 'LATEST' | 'PRICE_ASC' | 'PRICE_DESC' | 'TOTAL_ASC' | 'TOTAL_DESC' | 'RARITY_DESC'

// ─── Props / Emits ───────────────────────────────────────

const props = defineProps<{
  cardOptions: TradeCardOption[]
  ownedCardIds?: Set<string>
  publicListings: TradeListing[]
  myListings: TradeListing[]
  loading: boolean
  inventoryLoading: boolean
  submitting: boolean
  buyingId: string | null
  cancellingId: string | null
  publicTotal: number
  publicHasMore: boolean
  publicLoadingMore: boolean
  userId: string | null
  // Buy Request props
  publicBuyRequests: BuyRequest[]
  myBuyRequests: BuyRequest[]
  pageCatalog: PageCatalogEntry[]
  buyRequestLoading: boolean
  buyRequestSubmitting: boolean
  buyRequestFulfillingId: string | null
  buyRequestCancelId: string | null
  buyRequestPublicTotal: number
  buyRequestPublicHasMore: boolean
  buyRequestPublicLoadingMore: boolean
  myOpenBuyRequestCount: number
}>()

const emit = defineEmits<{
  refresh: [options: { syncInventory?: boolean; resetPublic?: boolean }]
  create: [payload: { cardId: string; quantity: number; unitPrice: number; expiresHours: number; affixSignature?: string }]
  buy: [listingId: string]
  cancel: [listingId: string]
  'load-more': []
  'trade-page-change': [page: number]
  'query-change': [payload: {
    search: string
    searchMode: 'ALL' | 'CARD' | 'SELLER'
    sort: TradeSortMode
    rarity: Rarity | 'ALL'
  }]
  // Buy Request emits
  'create-buy-request': [payloads: Array<{
    targetCardId: string
    matchLevel: BuyRequestMatchLevel
    requiredCoating?: AffixVisualStyle
    tokenOffer: number
    offeredCards: Array<{ cardId: string; affixSignature?: string; quantity: number }>
    expiresHours: number
  }>]
  'fulfill-buy-request': [payload: BuyRequestFulfillPayload]
  'cancel-buy-request': [buyRequestId: string]
  'buy-request-load-more': []
  'buy-request-page-change': [page: number]
  'buy-request-query-change': [payload: {
    search: string
    sort: BuyRequestSortMode
    rarity: Rarity | 'ALL'
    fulfillableOnly: boolean
  }]
  'refresh-buy-requests': [options?: { resetPublic?: boolean }]
  'request-inventory': []
  'request-catalog': []
}>()

// ─── 表单状态 ────────────────────────────────────────────

const tradeSelectionKey = ref<string>('')
const tradeCreateSearch = ref('')
const tradeQuantity = ref<number>(1)
const tradeUnitPrice = ref<number>(100)
const tradeExpiresHours = ref<number>(72)

// ─── 子标签页 ──────────────────────────────────────────
type TradeSubTab = 'market' | 'buyRequest' | 'mine'
const activeSubTab = ref<TradeSubTab>('market')
const showCreateForm = ref(false)
const showBuyRequestForm = ref(false)

// Lazy-load: emit request-inventory when create form opens
watch(showCreateForm, (val) => {
  if (val) emit('request-inventory')
})

// Lazy-load: emit request-catalog when buy request form opens
watch(showBuyRequestForm, (val) => {
  if (val) emit('request-catalog')
})

// ─── Picker 分页 ─────────────────────────────────────
const PICKER_PAGE_SIZE = 30
const pickerVisibleCount = ref(PICKER_PAGE_SIZE)

// ─── 公共挂牌客户端渐进渲染 ────────────────────────────
const LISTING_PAGE_SIZE = 40
const TRADE_PAGE_SIZE = 40
const listingVisibleCount = ref(LISTING_PAGE_SIZE)
const visiblePublicListings = computed(() => props.publicListings)
const tradePublicPage = ref(1)

// ─── 求购列表客户端渐进渲染 ────────────────────────────
const BR_PAGE_SIZE = 40
const brVisibleCount = ref(BR_PAGE_SIZE)
const buyRequestPublicPage = ref(1)

// ─── 筛选 / 排序状态 ────────────────────────────────────

const tradeSearch = ref('')
const tradeSearchMode = ref<'ALL' | 'CARD' | 'SELLER'>('ALL')
const tradeSortMode = ref<TradeSortMode>('LATEST')
const tradeRarityFilter = ref<Rarity | 'ALL'>('ALL')
const tradeMyStatusFilter = ref<TradeListing['status'] | 'ALL'>('ALL')

// ─── 公共挂牌详情 ─────────────────────────────────────
const selectedPublicListing = ref<TradeListing | null>(null)

function openListingDetail(listing: TradeListing) {
  selectedPublicListing.value = listing
}

function closeListingDetail() {
  selectedPublicListing.value = null
}

// ─── 我的挂牌详情 ─────────────────────────────────────
const selectedMyListing = ref<TradeListing | null>(null)

function openMyListingDetail(listing: TradeListing) {
  selectedMyListing.value = listing
}

function closeMyListingDetail() {
  selectedMyListing.value = null
}

// ─── 求购详情 ─────────────────────────────────────
const selectedBuyRequest = ref<BuyRequest | null>(null)
const selectedFulfillStackKey = ref<string>('')
const pageAuthors = usePageAuthors()

function openBuyRequestDetail(br: BuyRequest) {
  selectedBuyRequest.value = br
  if (!props.inventoryLoading && props.cardOptions.length === 0) {
    emit('request-inventory')
  }
}

function closeBuyRequestDetail() {
  selectedBuyRequest.value = null
}

const buyRequestFulfillCandidates = computed(() => {
  const br = selectedBuyRequest.value
  if (!br || br.status !== 'OPEN' || br.buyerId === props.userId) return []
  if (br.matchLevel === 'PAGE') {
    const targetPageId = br.targetCard.pageId
    if (targetPageId == null) return []
    return props.cardOptions.filter((item) => item.pageId === targetPageId)
  }
  if (br.matchLevel === 'COATING') {
    const requiredCoating = br.requiredCoating
    if (!requiredCoating || requiredCoating === 'NONE') return []
    return props.cardOptions.filter((item) => item.cardId === br.targetCardId && item.affixVisualStyle === requiredCoating)
  }
  return props.cardOptions.filter((item) => item.cardId === br.targetCardId)
})

const selectedBuyRequestFulfillOption = computed(() =>
  buyRequestFulfillCandidates.value.find((item) => item.stackKey === selectedFulfillStackKey.value)
  ?? buyRequestFulfillCandidates.value[0]
  ?? null
)

function handleFulfillBuyRequestFromDetail() {
  const br = selectedBuyRequest.value
  if (!br) return
  const selected = selectedBuyRequestFulfillOption.value
  emit('fulfill-buy-request', {
    buyRequestId: br.id,
    selectedCardId: selected?.cardId,
    selectedAffixSignature: selected?.affixSignature
  })
  closeBuyRequestDetail()
}

// ─── 求购创建表单状态 ──────────────────────────────
const brSelectedPage = ref<PageCatalogEntry | null>(null)
const brSelectedVariantIds = ref<string[]>([])
const brSelectedCoatings = ref<AffixVisualStyle[]>([])
const brTokenOffer = ref<number>(0)
const brExpiresHours = ref<number>(72)
const brOfferedCards = ref<Array<{ stackKey: string; cardId: string; affixSignature?: string; quantity: number }>>([])
const brTargetSearch = ref('')
const brOfferedSearch = ref('')

const coatingOptions: AffixVisualStyle[] = ['MONO', 'SILVER', 'GOLD', 'CYAN', 'PRISM', 'COLORLESS', 'WILDCARD', 'SPECTRUM', 'MIRROR', 'ORBIT', 'ECHO']

function authorSearchText(
  authors: Array<{ name: string; wikidotId: number | null }> | null | undefined,
  wikidotId: number | null | undefined
) {
  const id = Number(wikidotId)
  const cachedAuthors = Number.isFinite(id) && id > 0 ? pageAuthors.getAuthors(id) : []
  return resolveAuthorSearchText(authors, cachedAuthors)
}

function searchableTags(tags: string[] | null | undefined) {
  return (tags ?? []).filter((tag) => {
    const normalized = String(tag || '').trim()
    return normalized.length > 0 && !normalized.startsWith('_')
  })
}

// Pre-compute search text for catalog pages
const catalogSearchIndex = computed(() => {
  const index = new Map<string, string>()
  for (const p of props.pageCatalog) {
    const key = p.pageId ?? p.variants[0]?.id ?? p.title
    const text = `${p.title} ${searchableTags(p.tags).join(' ')} ${authorSearchText(p.authors, p.wikidotId)}`.toLowerCase()
    index.set(String(key), text)
  }
  return index
})

const brFilteredCatalog = computed(() => {
  const keyword = brTargetSearch.value.trim().toLowerCase()
  if (!keyword) return props.pageCatalog
  const idx = catalogSearchIndex.value
  return props.pageCatalog.filter((p) => {
    const key = String(p.pageId ?? p.variants[0]?.id ?? p.title)
    const text = idx.get(key) || ''
    return text.includes(keyword)
  })
})

const brDerivedPayloads = computed<BuyRequestDraft[]>(() => {
  if (!brSelectedPage.value) return []
  const page = brSelectedPage.value
  const firstVariantId = page.variants[0]?.id
  if (!firstVariantId) return []
  if (brSelectedVariantIds.value.length === 0) {
    return [{ targetCardId: firstVariantId, matchLevel: 'PAGE' }]
  }
  if (brSelectedCoatings.value.length === 0) {
    return brSelectedVariantIds.value.map((vid) => ({
      targetCardId: vid,
      matchLevel: 'IMAGE_VARIANT'
    }))
  }
  return brSelectedVariantIds.value.flatMap((vid) =>
    brSelectedCoatings.value.map((coating) => ({
      targetCardId: vid,
      matchLevel: 'COATING',
      requiredCoating: coating
    }))
  )
})

const brDerivedMatchLevelLabel = computed(() => {
  const payloads = brDerivedPayloads.value
  if (payloads.length === 0) return ''
  const level = payloads[0]!.matchLevel
  return level === 'PAGE' ? '接受同页面任意画面/镀层的卡片'
    : level === 'IMAGE_VARIANT' ? '接受同画面任意镀层的卡片'
    : '仅接受指定镀层的卡片'
})

const brFilteredTradeCardOptions = computed(() => {
  const keyword = brOfferedSearch.value.trim().toLowerCase()
  const targetIds = new Set(brDerivedPayloads.value.map(p => p.targetCardId))
  const base = props.cardOptions.filter((item) => !targetIds.has(item.cardId))
  if (!keyword) return base
  const idx = cardSearchIndex.value
  return base.filter((c) => {
    const text = idx.get(c.stackKey) || ''
    return text.includes(keyword)
  })
})

function brToggleOfferedCard(item: TradeCardOption) {
  const idx = brOfferedCards.value.findIndex((c) => c.stackKey === item.stackKey)
  if (idx >= 0) {
    brOfferedCards.value.splice(idx, 1)
  } else {
    brOfferedCards.value.push({
      stackKey: item.stackKey,
      cardId: item.cardId,
      affixSignature: item.affixSignature,
      quantity: 1
    })
  }
}

function brRemoveOfferedCard(stackKey: string) {
  const idx = brOfferedCards.value.findIndex((c) => c.stackKey === stackKey)
  if (idx >= 0) brOfferedCards.value.splice(idx, 1)
}

function brSetOfferedQuantity(stackKey: string, qty: number) {
  const entry = brOfferedCards.value.find((c) => c.stackKey === stackKey)
  if (entry) {
    entry.quantity = Math.max(1, qty)
  }
}

const brCanSubmit = computed(() => {
  if (!brSelectedPage.value) return false
  if (brDerivedPayloads.value.length === 0) return false
  return brTokenOffer.value > 0 || brOfferedCards.value.length > 0
})

function handleCreateBuyRequest() {
  if (!brCanSubmit.value) return
  const tokenOffer = Math.max(0, Number(brTokenOffer.value || 0))
  const offeredCards = brOfferedCards.value
    .filter((c) => c.quantity > 0)
    .map((c) => ({
      cardId: c.cardId,
      affixSignature: c.affixSignature,
      quantity: c.quantity
    }))
  const expiresHours = Math.max(1, Number(brExpiresHours.value || 72))
  const payloads = brDerivedPayloads.value.map(p => ({
    targetCardId: p.targetCardId,
    matchLevel: p.matchLevel,
    requiredCoating: p.matchLevel === 'COATING' ? p.requiredCoating : undefined,
    tokenOffer,
    offeredCards,
    expiresHours
  }))
  emit('create-buy-request', payloads)
}

function brSelectPage(entry: PageCatalogEntry) {
  brSelectedPage.value = entry
  brSelectedCoatings.value = []
  if (entry.variants.length === 1) {
    brSelectedVariantIds.value = [entry.variants[0]!.id]
  } else {
    brSelectedVariantIds.value = []
  }
}

function brClearSelection() {
  brSelectedPage.value = null
  brSelectedVariantIds.value = []
  brSelectedCoatings.value = []
}

function brToggleVariant(variantId: string) {
  const idx = brSelectedVariantIds.value.indexOf(variantId)
  if (idx >= 0) {
    brSelectedVariantIds.value.splice(idx, 1)
  } else {
    brSelectedVariantIds.value.push(variantId)
  }
  if (brSelectedVariantIds.value.length === 0) {
    brSelectedCoatings.value = []
  }
}

function brSelectAllVariants() {
  if (!brSelectedPage.value) return
  brSelectedVariantIds.value = brSelectedPage.value.variants.map(v => v.id)
}

function brClearVariants() {
  brSelectedVariantIds.value = []
  brSelectedCoatings.value = []
}

function brToggleCoating(style: AffixVisualStyle) {
  const idx = brSelectedCoatings.value.indexOf(style)
  if (idx >= 0) {
    brSelectedCoatings.value.splice(idx, 1)
  } else {
    brSelectedCoatings.value.push(style)
  }
}

// ─── 求购筛选 / 排序 ──────────────────────────────
const brSearchInput = ref('')
const brSortMode = ref<BuyRequestSortMode>('LATEST')
const brRarityFilter = ref<Rarity | 'ALL'>('ALL')
const brShowFulfillableOnly = ref(false)
let brQuerySuppressed = false

function brResetFilters() {
  brQuerySuppressed = true
  brSearchInput.value = ''
  brSortMode.value = 'LATEST'
  brRarityFilter.value = 'ALL'
  brQuerySuppressed = false
  brVisibleCount.value = BR_PAGE_SIZE
  buyRequestPublicPage.value = 1
  emitBrQuery()
}

function emitBrQuery() {
  emit('buy-request-query-change', {
    search: brSearchInput.value.trim(),
    sort: brSortMode.value,
    rarity: brRarityFilter.value,
    fulfillableOnly: brShowFulfillableOnly.value
  })
}

// ─── 衍生数据 ────────────────────────────────────────────

const selectedTradeCardOption = computed(() =>
  props.cardOptions.find((item) => item.stackKey === tradeSelectionKey.value) ?? null
)

const normalizedCreateSearch = computed(() => tradeCreateSearch.value.trim().toLowerCase())

const cardSearchIndex = computed(() => {
  const index = new Map<string, string>()
  for (const item of props.cardOptions) {
    const text = `${item.title} ${item.cardId} ${(item.tags ?? []).filter(t => !t.startsWith('_')).join(' ')} ${authorSearchText(item.authors, item.wikidotId)}`.toLowerCase()
    index.set(item.stackKey, text)
  }
  return index
})

const filteredTradeCardOptions = computed(() => {
  const keyword = normalizedCreateSearch.value
  if (!keyword) return props.cardOptions
  const idx = cardSearchIndex.value
  return props.cardOptions.filter((item) => {
    const text = idx.get(item.stackKey) || ''
    return text.includes(keyword)
  })
})

type RarityGroup = { rarity: Rarity; startIndex: number; count: number }
const rarityGroups = computed<RarityGroup[]>(() => {
  const items = filteredTradeCardOptions.value
  if (!items.length) return []
  const groups: RarityGroup[] = []
  let currentRarity = items[0]!.rarity
  let startIndex = 0
  for (let i = 1; i <= items.length; i++) {
    const r = i < items.length ? items[i]!.rarity : null
    if (r !== currentRarity) {
      groups.push({ rarity: currentRarity, startIndex, count: i - startIndex })
      if (r != null) {
        currentRarity = r
        startIndex = i
      }
    }
  }
  return groups
})

const visibleTradeCardOptions = computed(() =>
  filteredTradeCardOptions.value.slice(0, pickerVisibleCount.value)
)
const pickerHasMore = computed(() =>
  filteredTradeCardOptions.value.length > pickerVisibleCount.value
)
const pickerRemainingCount = computed(() =>
  Math.max(0, filteredTradeCardOptions.value.length - pickerVisibleCount.value)
)

function pickerLoadMore() {
  pickerVisibleCount.value = Math.min(
    pickerVisibleCount.value + PICKER_PAGE_SIZE,
    filteredTradeCardOptions.value.length
  )
}

const tradeQuantityMax = computed(() =>
  Math.max(1, selectedTradeCardOption.value?.availableCount ?? 1)
)

const myOpenTradeCount = computed(() =>
  props.myListings.filter((item) => item.status === 'OPEN' && item.remaining > 0).length
)

const filteredMyTradeListings = computed(() =>
  props.myListings
    .filter((listing) => (tradeMyStatusFilter.value === 'ALL' ? true : listing.status === tradeMyStatusFilter.value))
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
)

function toggleFulfillableOnly() {
  brShowFulfillableOnly.value = !brShowFulfillableOnly.value
  brVisibleCount.value = BR_PAGE_SIZE
  buyRequestPublicPage.value = 1
  emitBrQuery()
}

const displayedBuyRequests = computed(() => props.publicBuyRequests)

const visibleBuyRequests = computed(() => displayedBuyRequests.value.slice(0, brVisibleCount.value))
const hasMoreBrLocal = computed(() => displayedBuyRequests.value.length > brVisibleCount.value)

const tradeRarityFilterOptions: Array<Rarity | 'ALL'> = ['ALL', 'GOLD', 'PURPLE', 'BLUE', 'GREEN', 'WHITE']
let suppressMarketQueryWatch = false

// ─── 辅助函数 ────────────────────────────────────────────

function tradeStatusLabel(status: TradeListing['status']) {
  return tradeStatusLabelMap[status] || status
}

function listingTotalPrice(listing: TradeListing) {
  return Math.max(0, Number(listing.remaining || 0)) * Math.max(0, Number(listing.unitPrice || 0))
}

// Client-side clock for remaining time (avoid SSR hydration mismatch)
const clientNow = ref<number | null>(null)
let nowTimer: ReturnType<typeof setInterval> | null = null

onMounted(() => {
  clientNow.value = Date.now()
  nowTimer = setInterval(() => {
    clientNow.value = Date.now()
  }, 60_000)
})

onBeforeUnmount(() => {
  if (nowTimer) clearInterval(nowTimer)
  clearMarketQueryTimer()
})

function formatAccountDisplayName(
  account: { id: string; displayName: string | null; linkedWikidotId: number | null } | null | undefined,
  fallbackId?: string | null
) {
  if (account?.displayName) return account.displayName
  if (account?.linkedWikidotId) return `WID:${account.linkedWikidotId}`
  const rawId = String(fallbackId || account?.id || '').trim()
  if (!rawId) return '未知用户'
  return `用户-${rawId.slice(0, 8)}`
}

function listingRemainingLabel(listing: TradeListing) {
  if (listing.status !== 'OPEN' || listing.remaining <= 0) return tradeStatusLabel(listing.status)
  if (!listing.expiresAt) return '无期限'
  const now = clientNow.value
  if (!now) return formatDateCompact(listing.expiresAt) || '无'
  const expiresTs = new Date(listing.expiresAt).getTime()
  if (!Number.isFinite(expiresTs)) return formatDateCompact(listing.expiresAt) || '无'
  const diffMs = expiresTs - now
  if (diffMs <= 0) return '已到期'
  const diffMin = Math.max(1, Math.ceil(diffMs / 60_000))
  if (diffMin < 60) return `剩${diffMin}m`
  const diffH = Math.ceil(diffMin / 60)
  if (diffH < 48) return `剩${diffH}h`
  const diffD = Math.ceil(diffH / 24)
  return `剩${diffD}d`
}

function buyRequestRemainingLabel(br: BuyRequest) {
  if (br.status !== 'OPEN') return buyRequestStatusLabelMap[br.status]
  if (!br.expiresAt) return '无期限'
  const now = clientNow.value
  if (!now) return formatDateCompact(br.expiresAt) || '无'
  const expiresTs = new Date(br.expiresAt).getTime()
  if (!Number.isFinite(expiresTs)) return formatDateCompact(br.expiresAt) || '无'
  const diffMs = expiresTs - now
  if (diffMs <= 0) return '已到期'
  const diffMin = Math.max(1, Math.ceil(diffMs / 60_000))
  if (diffMin < 60) return `剩${diffMin}m`
  const diffH = Math.ceil(diffMin / 60)
  if (diffH < 48) return `剩${diffH}h`
  const diffD = Math.ceil(diffH / 24)
  return `剩${diffD}d`
}

function resetFilters() {
  suppressMarketQueryWatch = true
  tradeSearch.value = ''
  tradeSearchMode.value = 'ALL'
  tradeSortMode.value = 'LATEST'
  tradeRarityFilter.value = 'ALL'
  suppressMarketQueryWatch = false
  listingVisibleCount.value = LISTING_PAGE_SIZE
  tradePublicPage.value = 1
  emitMarketQuery()
}

function handleCreate() {
  const selected = selectedTradeCardOption.value
  if (!selected) return
  emit('create', {
    cardId: selected.cardId,
    affixSignature: selected.affixSignature,
    quantity: Math.max(1, Math.min(Number(tradeQuantity.value || 1), selected.availableCount)),
    unitPrice: Math.max(1, Number(tradeUnitPrice.value || 1)),
    expiresHours: Math.max(1, Number(tradeExpiresHours.value || 72))
  })
}

const MARKET_QUERY_DEBOUNCE_MS = 280
let marketQueryTimer: ReturnType<typeof setTimeout> | null = null

function clearMarketQueryTimer() {
  if (!marketQueryTimer) return
  clearTimeout(marketQueryTimer)
  marketQueryTimer = null
}

function emitMarketQuery() {
  emit('query-change', {
    search: tradeSearch.value.trim(),
    searchMode: tradeSearchMode.value,
    sort: tradeSortMode.value,
    rarity: tradeRarityFilter.value
  })
}

function scheduleMarketQueryEmit() {
  clearMarketQueryTimer()
  marketQueryTimer = setTimeout(() => {
    marketQueryTimer = null
    emitMarketQuery()
  }, MARKET_QUERY_DEBOUNCE_MS)
}

// 自动选中第一张卡片
watch(() => props.cardOptions, (options) => {
  if (options.length <= 0) {
    tradeSelectionKey.value = ''
    return
  }
  if (!tradeSelectionKey.value || !options.some((item) => item.stackKey === tradeSelectionKey.value)) {
    tradeSelectionKey.value = options[0]!.stackKey
  }
}, { immediate: true })

watch(tradeSearch, () => {
  if (suppressMarketQueryWatch) return
  listingVisibleCount.value = LISTING_PAGE_SIZE
  tradePublicPage.value = 1
  scheduleMarketQueryEmit()
})

watch([tradeSearchMode, tradeSortMode, tradeRarityFilter], () => {
  if (suppressMarketQueryWatch) return
  listingVisibleCount.value = LISTING_PAGE_SIZE
  tradePublicPage.value = 1
  emitMarketQuery()
})

watch(tradeCreateSearch, () => {
  pickerVisibleCount.value = PICKER_PAGE_SIZE
})

// 数量不超过上限
watch(tradeQuantityMax, (max) => {
  if (tradeQuantity.value > max) tradeQuantity.value = max
})

watch([() => selectedBuyRequest.value?.id, buyRequestFulfillCandidates], () => {
  const candidates = buyRequestFulfillCandidates.value
  if (!candidates.length) {
    selectedFulfillStackKey.value = ''
    return
  }
  if (!candidates.some((item) => item.stackKey === selectedFulfillStackKey.value)) {
    selectedFulfillStackKey.value = candidates[0]!.stackKey
  }
}, { immediate: true })

watch(brSearchInput, () => {
  if (brQuerySuppressed) return
  brVisibleCount.value = BR_PAGE_SIZE
  buyRequestPublicPage.value = 1
  emitBrQuery()
})

watch([brSortMode, brRarityFilter], () => {
  if (brQuerySuppressed) return
  brVisibleCount.value = BR_PAGE_SIZE
  emitBrQuery()
})
</script>

<template>
  <section class="surface-card trade-bazaar p-3 sm:p-4">
    <!-- 头部 + 子标签 -->
    <header class="trade-bazaar__head">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <h3 class="gacha-panel-title">卡片集换市场</h3>
        <UiButton
          variant="outline"
          size="sm"
          :disabled="loading"
          @click="emit('refresh', { syncInventory: true, resetPublic: true })"
        >
          {{ loading ? '刷新中...' : '刷新' }}
        </UiButton>
      </div>

      <nav class="mt-3 flex gap-1 rounded-xl border border-neutral-200/70 bg-neutral-100/70 p-1 dark:border-neutral-700/70 dark:bg-neutral-800/50">
        <button
          v-for="tab in ([
            { key: 'market', label: '挂牌', badge: publicTotal },
            { key: 'buyRequest', label: '求购', badge: buyRequestPublicTotal },
            { key: 'mine', label: '我的', badge: myOpenTradeCount + myOpenBuyRequestCount }
          ] as const)"
          :key="tab.key"
          type="button"
          class="trade-sub-tab"
          :class="{ 'trade-sub-tab--active': activeSubTab === tab.key }"
          @click="activeSubTab = tab.key"
        >
          {{ tab.label }}
          <span v-if="tab.badge != null && tab.badge > 0" class="trade-sub-tab__badge">{{ tab.badge }}</span>
        </button>
      </nav>
    </header>

    <!-- ═══ 挂牌 Tab ═══ -->
    <div v-if="activeSubTab === 'market'" class="mt-4 space-y-4">
      <TradeSellForm
        :inventory-loading="inventoryLoading"
        :card-options="cardOptions"
        :filtered-trade-card-options="filteredTradeCardOptions"
        :visible-trade-card-options="visibleTradeCardOptions"
        :rarity-groups="rarityGroups"
        :trade-create-search="tradeCreateSearch"
        :normalized-create-search="normalizedCreateSearch"
        :trade-selection-key="tradeSelectionKey"
        :selected-trade-card-option="selectedTradeCardOption"
        :trade-quantity="tradeQuantity"
        :trade-quantity-max="tradeQuantityMax"
        :trade-unit-price="tradeUnitPrice"
        :trade-expires-hours="tradeExpiresHours"
        :submitting="submitting"
        :picker-has-more="pickerHasMore"
        :picker-remaining-count="pickerRemainingCount"
        :show-create-form="showCreateForm"
        @update:show-create-form="showCreateForm = $event"
        @update:trade-create-search="tradeCreateSearch = $event"
        @update:trade-selection-key="tradeSelectionKey = $event"
        @update:trade-quantity="tradeQuantity = $event"
        @update:trade-unit-price="tradeUnitPrice = $event"
        @update:trade-expires-hours="tradeExpiresHours = $event"
        @create="handleCreate"
        @picker-load-more="pickerLoadMore"
      />

      <TradeListings
        :public-listings="visiblePublicListings"
        :public-total="publicTotal"
        :loading="loading"
        :public-loading-more="publicLoadingMore"
        :trade-search="tradeSearch"
        :trade-search-mode="tradeSearchMode"
        :trade-sort-mode="tradeSortMode"
        :trade-rarity-filter="tradeRarityFilter"
        :trade-rarity-filter-options="tradeRarityFilterOptions"
        :trade-public-page="tradePublicPage"
        :page-size="TRADE_PAGE_SIZE"
        :client-now="clientNow"
        :user-id="userId"
        @update:trade-search="tradeSearch = $event"
        @update:trade-search-mode="tradeSearchMode = $event"
        @update:trade-sort-mode="tradeSortMode = $event"
        @update:trade-rarity-filter="tradeRarityFilter = $event"
        @reset-filters="resetFilters"
        @open-listing-detail="openListingDetail"
        @trade-page-change="(p) => { tradePublicPage = p; emit('trade-page-change', p) }"
      />
    </div>

    <!-- ═══ 我的 Tab ═══ -->
    <div v-else-if="activeSubTab === 'mine'" class="mt-4 space-y-4">
      <!-- 我的挂牌 -->
      <article class="rounded-lg border border-neutral-200/75 bg-neutral-50/75 p-4 dark:border-neutral-800/70 dark:bg-neutral-900/55">
        <header class="flex flex-wrap items-center justify-between gap-2">
          <h4 class="text-xs font-semibold text-neutral-700 dark:text-neutral-200">我的挂牌 ({{ filteredMyTradeListings.length }})</h4>
          <UiSelectRoot v-model="tradeMyStatusFilter">
            <UiSelectTrigger class="w-[112px] text-[11px]" placeholder="全部状态" />
            <UiSelectContent>
              <UiSelectItem value="ALL">全部状态</UiSelectItem>
              <UiSelectItem value="OPEN">进行中</UiSelectItem>
              <UiSelectItem value="SOLD">已售罄</UiSelectItem>
              <UiSelectItem value="CANCELLED">已撤销</UiSelectItem>
              <UiSelectItem value="EXPIRED">已过期</UiSelectItem>
            </UiSelectContent>
          </UiSelectRoot>
        </header>
        <p v-if="!filteredMyTradeListings.length" class="gacha-empty mt-2">当前筛选条件下没有挂牌记录。</p>
        <div v-else class="mt-3 gacha-trade-item-grid">
          <button
            v-for="listing in filteredMyTradeListings"
            :key="`my-trade-${listing.id}`"
            type="button"
            class="trade-item-row"
            @click="openMyListingDetail(listing)"
          >
            <div class="trade-item-row__card">
              <GachaCardMini
                :title="listing.card.title"
                :rarity="listing.card.rarity"
                :image-url="listing.card.imageUrl || undefined"
                :retired="listing.card.isRetired"
                :affix-visual-style="listing.card.affixVisualStyle || listing.affixBreakdown?.[0]?.affixVisualStyle"
                :affix-label="listing.card.affixLabel || listing.affixBreakdown?.[0]?.affixLabel"
                :hide-footer="true"
              />
            </div>
            <div class="trade-item-row__info">
              <span
                class="inline-flex self-start rounded-full border px-2 py-0.5 text-[9px] font-semibold"
                :class="tradeStatusChipClassMap[listing.status]"
              >{{ tradeStatusLabel(listing.status) }}</span>
              <span class="trade-item-row__price">{{ formatTokens(listing.unitPrice) }}T <span class="trade-item-row__qty">× {{ listing.remaining }}/{{ listing.quantity }}</span></span>
              <span class="trade-item-row__time">{{ listingRemainingLabel(listing) }}</span>
            </div>
          </button>
        </div>
      </article>

      <!-- 我的求购 -->
      <article class="rounded-lg border border-neutral-200/75 bg-neutral-50/75 p-4 dark:border-neutral-800/70 dark:bg-neutral-900/55">
        <h4 class="text-xs font-semibold text-neutral-700 dark:text-neutral-200">我的求购 ({{ myBuyRequests.length }})</h4>
        <p v-if="!myBuyRequests.length" class="gacha-empty mt-2">暂无求购记录。</p>
        <div v-else class="mt-3 gacha-trade-item-grid">
          <button
            v-for="br in myBuyRequests"
            :key="`my-br-${br.id}`"
            type="button"
            class="trade-item-row"
            @click="openBuyRequestDetail(br)"
          >
            <div class="trade-item-row__card">
              <GachaCardMini
                :title="br.targetCard.title"
                :rarity="br.targetCard.rarity"
                :image-url="br.targetCard.imageUrl || undefined"
                :retired="br.targetCard.isRetired"
                :hide-footer="true"
              />
            </div>
            <div class="trade-item-row__info">
              <span
                class="inline-flex self-start rounded-full border px-2 py-0.5 text-[9px] font-semibold"
                :class="buyRequestStatusChipClassMap[br.status]"
              >{{ buyRequestStatusLabelMap[br.status] }}</span>
              <span class="trade-item-row__price">{{ br.tokenOffer > 0 ? `${formatTokens(br.tokenOffer)}T` : '' }}{{ br.tokenOffer > 0 && br.offeredCards.length > 0 ? ' + ' : '' }}{{ br.offeredCards.length > 0 ? `${br.offeredCards.length}卡` : '' }}</span>
              <span class="flex items-center gap-1">
                <span class="trade-item-row__time">{{ buyRequestRemainingLabel(br) }}</span>
                <span class="br-match-chip">{{ buyRequestMatchLevelShortMap[br.matchLevel] }}</span>
              </span>
            </div>
          </button>
        </div>
      </article>
    </div>

    <!-- ═══ 求购 Tab ═══ -->
    <div v-else-if="activeSubTab === 'buyRequest'" class="mt-4">
      <TradeBuyForm
        :show-buy-request-form="showBuyRequestForm"
        :br-selected-page="brSelectedPage"
        :br-selected-variant-ids="brSelectedVariantIds"
        :br-selected-coatings="brSelectedCoatings"
        :br-token-offer="brTokenOffer"
        :br-expires-hours="brExpiresHours"
        :br-offered-cards="brOfferedCards"
        :br-target-search="brTargetSearch"
        :br-offered-search="brOfferedSearch"
        :br-filtered-catalog="brFilteredCatalog"
        :br-filtered-trade-card-options="brFilteredTradeCardOptions"
        :br-derived-payloads="brDerivedPayloads"
        :br-derived-match-level-label="brDerivedMatchLevelLabel"
        :br-can-submit="brCanSubmit"
        :buy-request-submitting="buyRequestSubmitting"
        :inventory-loading="inventoryLoading"
        :card-options="cardOptions"
        :coating-options="coatingOptions"
        :public-buy-requests="displayedBuyRequests"
        :visible-buy-requests="visibleBuyRequests"
        :has-more-br-local="hasMoreBrLocal"
        :buy-request-public-total="buyRequestPublicTotal"
        :buy-request-public-page="buyRequestPublicPage"
        :buy-request-loading="buyRequestLoading"
        :buy-request-public-loading-more="buyRequestPublicLoadingMore"
        :br-search-input="brSearchInput"
        :br-sort-mode="brSortMode"
        :br-rarity-filter="brRarityFilter"
        :trade-rarity-filter-options="tradeRarityFilterOptions"
        :br-show-fulfillable-only="brShowFulfillableOnly"
        :user-id="userId"
        :client-now="clientNow"
        :br-page-size="BR_PAGE_SIZE"
        @update:show-buy-request-form="showBuyRequestForm = $event"
        @update:br-target-search="brTargetSearch = $event"
        @update:br-offered-search="brOfferedSearch = $event"
        @update:br-token-offer="brTokenOffer = $event"
        @update:br-expires-hours="brExpiresHours = $event"
        @update:br-search-input="brSearchInput = $event"
        @update:br-sort-mode="brSortMode = $event"
        @update:br-rarity-filter="brRarityFilter = $event"
        @br-select-page="brSelectPage"
        @br-clear-selection="brClearSelection"
        @br-toggle-variant="brToggleVariant"
        @br-select-all-variants="brSelectAllVariants"
        @br-clear-variants="brClearVariants"
        @br-toggle-coating="brToggleCoating"
        @br-toggle-offered-card="brToggleOfferedCard"
        @br-remove-offered-card="brRemoveOfferedCard"
        @br-set-offered-quantity="brSetOfferedQuantity"
        @create-buy-request="handleCreateBuyRequest"
        @open-buy-request-detail="openBuyRequestDetail"
        @toggle-fulfillable-only="toggleFulfillableOnly"
        @br-reset-filters="brResetFilters"
        @br-load-more-local="brVisibleCount += BR_PAGE_SIZE"
        @buy-request-page-change="(p) => { buyRequestPublicPage = p; emit('buy-request-page-change', p) }"
        @refresh-buy-requests="emit('refresh-buy-requests', { resetPublic: true })"
      />
    </div>

    <!-- 详情弹窗 -->
    <TradeDetail
      :selected-my-listing="selectedMyListing"
      :cancelling-id="cancellingId"
      :selected-public-listing="selectedPublicListing"
      :buying-id="buyingId"
      :user-id="userId"
      :selected-buy-request="selectedBuyRequest"
      :buy-request-fulfill-candidates="buyRequestFulfillCandidates"
      :selected-fulfill-stack-key="selectedFulfillStackKey"
      :buy-request-fulfilling-id="buyRequestFulfillingId"
      :buy-request-cancel-id="buyRequestCancelId"
      :inventory-loading="inventoryLoading"
      :card-options-length="cardOptions.length"
      @close-my-listing="closeMyListingDetail"
      @close-public-listing="closeListingDetail"
      @close-buy-request="closeBuyRequestDetail"
      @cancel-listing="(id) => emit('cancel', id)"
      @buy-listing="(id) => emit('buy', id)"
      @update:selected-fulfill-stack-key="selectedFulfillStackKey = $event"
      @fulfill-buy-request="handleFulfillBuyRequestFromDetail"
      @cancel-buy-request="(id) => emit('cancel-buy-request', id)"
    />
  </section>
</template>

<style>
/* Trade panel styles - NOT scoped so child components in trade/ can inherit them */
.trade-bazaar .trade-sub-tab { flex: 1; display: inline-flex; align-items: center; justify-content: center; gap: 4px; border-radius: 0.5rem; padding: 0.4rem 0.75rem; font-size: 12px; font-weight: 600; color: rgb(100 116 139); cursor: pointer; transition: all 0.15s ease; border: none; background: transparent; }
.trade-bazaar .trade-sub-tab:hover { color: rgb(51 65 85); background: rgba(255, 255, 255, 0.6); }
.trade-bazaar .trade-sub-tab--active { background: white; color: rgb(15 23 42); box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08); }
html.dark .trade-bazaar .trade-sub-tab { color: rgb(148 163 184); }
html.dark .trade-bazaar .trade-sub-tab:hover { color: rgb(226 232 240); background: rgba(255, 255, 255, 0.06); }
html.dark .trade-bazaar .trade-sub-tab--active { background: rgba(30, 41, 59, 0.9); color: rgb(241 245 249); box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3); }
.trade-bazaar .trade-sub-tab__badge { display: inline-flex; align-items: center; justify-content: center; min-width: 16px; height: 16px; padding: 0 4px; border-radius: 999px; font-size: 9px; font-weight: 700; background: rgba(14, 116, 144, 0.12); color: rgb(14 116 144); }
html.dark .trade-bazaar .trade-sub-tab__badge { background: rgba(34, 211, 238, 0.15); color: rgb(103 232 249); }

.trade-bazaar .trade-create-card { position: relative; display: block; width: 100%; min-width: 0; border-radius: 0.9rem; border: 1px solid rgba(148, 163, 184, 0.24); background: rgba(255, 255, 255, 0.72); padding: 0.22rem; text-align: left; cursor: pointer; transition: border-color 0.15s ease, box-shadow 0.15s ease, transform 0.15s ease; }
.trade-bazaar .trade-create-card:hover { border-color: rgba(14, 116, 144, 0.35); box-shadow: 0 4px 12px rgba(15, 23, 42, 0.08); transform: translateY(-1px); }
.trade-bazaar .trade-create-card--selected { border-color: rgba(14, 116, 144, 0.55); box-shadow: 0 0 0 4px rgba(14, 116, 144, 0.22), 0 0 0 1px rgba(14, 116, 144, 0.12), 0 8px 20px rgba(8, 145, 178, 0.16); }
html.dark .trade-bazaar .trade-create-card { border-color: rgba(100, 116, 139, 0.45); background: rgba(15, 23, 42, 0.62); }
html.dark .trade-bazaar .trade-create-card:hover { border-color: rgba(34, 211, 238, 0.45); box-shadow: 0 4px 14px rgba(0, 0, 0, 0.28); }
html.dark .trade-bazaar .trade-create-card--selected { border-color: rgba(34, 211, 238, 0.62); box-shadow: 0 0 0 4px rgba(34, 211, 238, 0.22), 0 0 0 1px rgba(34, 211, 238, 0.2), 0 10px 22px rgba(6, 182, 212, 0.18); }

.trade-bazaar .trade-remaining-chip { display: inline-flex; align-items: center; border-radius: 999px; border: 1px solid rgba(148, 163, 184, 0.35); background: rgba(248, 250, 252, 0.8); color: rgb(100 116 139); font-size: 9px; font-weight: 600; padding: 1px 5px; white-space: nowrap; }
html.dark .trade-bazaar .trade-remaining-chip { border-color: rgba(100, 116, 139, 0.45); background: rgba(15, 23, 42, 0.7); color: rgb(148 163 184); }

.trade-bazaar .trade-create-grid { align-items: stretch; }

.trade-bazaar .picker-scroll-area { max-height: 22rem; overflow-y: auto; padding-right: 2px; }
.trade-bazaar .picker-load-more-btn { display: block; width: 100%; margin-top: 8px; padding: 8px 0; border-radius: 0.6rem; border: 1px solid rgba(14, 116, 144, 0.25); background: rgba(236, 254, 255, 0.4); color: rgb(14 116 144); font-size: 11px; font-weight: 600; text-align: center; cursor: pointer; transition: all 0.15s ease; }
.trade-bazaar .picker-load-more-btn:hover { border-color: rgba(14, 116, 144, 0.45); background: rgba(236, 254, 255, 0.7); box-shadow: 0 2px 8px rgba(8, 145, 178, 0.08); }
html.dark .trade-bazaar .picker-load-more-btn { border-color: rgba(34, 211, 238, 0.25); background: rgba(8, 47, 73, 0.4); color: rgb(103 232 249); }
html.dark .trade-bazaar .picker-load-more-btn:hover { border-color: rgba(34, 211, 238, 0.45); background: rgba(8, 47, 73, 0.6); }

.trade-bazaar .picker-rarity-tag { display: inline-flex; align-items: center; border-radius: 999px; padding: 1px 7px; font-size: 10px; font-weight: 600; border: 1px solid; }
.trade-bazaar .picker-rarity-tag--gold { border-color: rgba(245, 158, 11, 0.35); background: rgba(245, 158, 11, 0.08); color: rgb(180 83 9); }
.trade-bazaar .picker-rarity-tag--purple { border-color: rgba(124, 58, 237, 0.3); background: rgba(124, 58, 237, 0.06); color: rgb(109 40 217); }
.trade-bazaar .picker-rarity-tag--blue { border-color: rgba(37, 99, 235, 0.3); background: rgba(37, 99, 235, 0.06); color: rgb(29 78 216); }
.trade-bazaar .picker-rarity-tag--green { border-color: rgba(5, 150, 105, 0.3); background: rgba(5, 150, 105, 0.06); color: rgb(4 120 87); }
.trade-bazaar .picker-rarity-tag--white { border-color: rgba(148, 163, 184, 0.35); background: rgba(148, 163, 184, 0.06); color: rgb(100 116 139); }
html.dark .trade-bazaar .picker-rarity-tag--gold { border-color: rgba(251, 191, 36, 0.4); background: rgba(245, 158, 11, 0.12); color: rgb(252 211 77); }
html.dark .trade-bazaar .picker-rarity-tag--purple { border-color: rgba(167, 139, 250, 0.4); background: rgba(124, 58, 237, 0.12); color: rgb(196 181 253); }
html.dark .trade-bazaar .picker-rarity-tag--blue { border-color: rgba(96, 165, 250, 0.4); background: rgba(37, 99, 235, 0.12); color: rgb(147 197 253); }
html.dark .trade-bazaar .picker-rarity-tag--green { border-color: rgba(52, 211, 153, 0.4); background: rgba(5, 150, 105, 0.12); color: rgb(110 231 183); }
html.dark .trade-bazaar .picker-rarity-tag--white { border-color: rgba(148, 163, 184, 0.4); background: rgba(148, 163, 184, 0.1); color: rgb(148 163 184); }

.trade-bazaar .trade-detail-mini-card { width: 100%; max-width: 150px; margin-inline: auto; }
.trade-bazaar .trade-detail-mini-card > * { width: 100%; }

.trade-bazaar .trade-collapse-toggle { display: inline-flex; align-items: center; gap: 6px; padding: 6px 14px; border-radius: 0.75rem; border: 1px solid rgba(14, 116, 144, 0.3); background: rgba(236, 254, 255, 0.5); color: rgb(14 116 144); font-size: 12px; font-weight: 600; cursor: pointer; transition: all 0.15s ease; }
.trade-bazaar .trade-collapse-toggle:hover { border-color: rgba(14, 116, 144, 0.5); background: rgba(236, 254, 255, 0.8); box-shadow: 0 2px 8px rgba(8, 145, 178, 0.1); }
html.dark .trade-bazaar .trade-collapse-toggle { border-color: rgba(34, 211, 238, 0.3); background: rgba(8, 47, 73, 0.5); color: rgb(103 232 249); }
html.dark .trade-bazaar .trade-collapse-toggle:hover { border-color: rgba(34, 211, 238, 0.5); background: rgba(8, 47, 73, 0.7); }
.trade-bazaar .trade-collapse-toggle__icon { display: inline-block; font-size: 10px; transition: transform 0.2s ease; }
.trade-bazaar .trade-collapse-toggle__icon--open { transform: rotate(180deg); }

.trade-bazaar .trade-collapse-enter-active, .trade-bazaar .trade-collapse-leave-active { transition: all 0.25s ease; overflow: hidden; }
.trade-bazaar .trade-collapse-enter-from, .trade-bazaar .trade-collapse-leave-to { opacity: 0; max-height: 0; margin-top: 0; }
.trade-bazaar .trade-collapse-enter-to, .trade-bazaar .trade-collapse-leave-from { opacity: 1; max-height: 2000px; }

.trade-bazaar .gacha-trade-item-grid { display: grid; gap: 8px; grid-template-columns: repeat(2, minmax(0, 1fr)); }
.trade-bazaar .trade-item-row { display: flex; align-items: stretch; gap: 8px; padding: 6px; border-radius: 0.85rem; border: 1px solid rgba(148, 163, 184, 0.22); background: rgba(255, 255, 255, 0.6); cursor: pointer; text-align: left; transition: border-color 0.15s ease, box-shadow 0.15s ease, transform 0.12s ease; min-width: 0; content-visibility: auto; contain-intrinsic-size: auto 80px; }
.trade-bazaar .trade-item-row:hover { border-color: rgba(14, 116, 144, 0.4); box-shadow: 0 4px 14px rgba(15, 23, 42, 0.08); transform: translateY(-1px); }
html.dark .trade-bazaar .trade-item-row { border-color: rgba(100, 116, 139, 0.35); background: rgba(15, 23, 42, 0.5); }
html.dark .trade-bazaar .trade-item-row:hover { border-color: rgba(34, 211, 238, 0.45); box-shadow: 0 4px 14px rgba(0, 0, 0, 0.3); }
.trade-bazaar .trade-item-row__card { flex: 0 0 72px; min-width: 0; }
.trade-bazaar .trade-item-row__card > * { width: 100%; height: 100%; }
.trade-bazaar .trade-item-row__info { flex: 1; display: flex; flex-direction: column; justify-content: center; gap: 3px; min-width: 0; padding: 2px 0; }
.trade-bazaar .trade-item-row__user { font-size: 11px; font-weight: 600; color: rgb(14 116 144); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
html.dark .trade-bazaar .trade-item-row__user { color: rgb(103 232 249); }
.trade-bazaar .trade-item-row__price { font-size: 12px; font-weight: 700; color: rgb(180 83 9); font-variant-numeric: tabular-nums; }
html.dark .trade-bazaar .trade-item-row__price { color: rgb(252 211 77); }
.trade-bazaar .trade-item-row__qty { font-size: 10px; font-weight: 500; color: rgb(100 116 139); }
html.dark .trade-bazaar .trade-item-row__qty { color: rgb(148 163 184); }
.trade-bazaar .trade-item-row__time { font-size: 10px; font-weight: 600; color: rgb(71 85 105); font-variant-numeric: tabular-nums; }
html.dark .trade-bazaar .trade-item-row__time { color: rgb(148 163 184); }

.trade-bazaar .br-fulfillable-toggle { display: inline-flex; align-items: center; gap: 5px; padding: 5px 12px; border-radius: 0.6rem; border: 1px solid rgba(16, 185, 129, 0.3); background: rgba(16, 185, 129, 0.06); color: rgb(5 150 105); font-size: 11px; font-weight: 600; cursor: pointer; transition: all 0.15s ease; }
.trade-bazaar .br-fulfillable-toggle:hover { border-color: rgba(16, 185, 129, 0.5); background: rgba(16, 185, 129, 0.12); }
.trade-bazaar .br-fulfillable-toggle--active { border-color: rgba(16, 185, 129, 0.6); background: rgba(16, 185, 129, 0.15); box-shadow: 0 0 0 2px rgba(16, 185, 129, 0.12); }
html.dark .trade-bazaar .br-fulfillable-toggle { border-color: rgba(52, 211, 153, 0.3); background: rgba(16, 185, 129, 0.08); color: rgb(110 231 183); }
html.dark .trade-bazaar .br-fulfillable-toggle:hover { border-color: rgba(52, 211, 153, 0.5); background: rgba(16, 185, 129, 0.15); }
html.dark .trade-bazaar .br-fulfillable-toggle--active { border-color: rgba(52, 211, 153, 0.6); background: rgba(16, 185, 129, 0.2); box-shadow: 0 0 0 2px rgba(52, 211, 153, 0.12); }
.trade-bazaar .br-fulfillable-toggle__icon { width: 12px; height: 12px; }

.trade-bazaar .br-match-btn { display: inline-flex; align-items: center; padding: 4px 10px; border-radius: 0.5rem; border: 1px solid rgba(148, 163, 184, 0.3); background: rgba(255, 255, 255, 0.7); color: rgb(100 116 139); font-size: 11px; font-weight: 500; cursor: pointer; transition: all 0.15s ease; }
.trade-bazaar .br-match-btn:hover { border-color: rgba(14, 116, 144, 0.4); color: rgb(14 116 144); }
.trade-bazaar .br-match-btn--active { border-color: rgba(14, 116, 144, 0.6); background: rgba(14, 116, 144, 0.08); color: rgb(14 116 144); font-weight: 600; box-shadow: 0 0 0 2px rgba(14, 116, 144, 0.12); }
html.dark .trade-bazaar .br-match-btn { border-color: rgba(100, 116, 139, 0.4); background: rgba(15, 23, 42, 0.6); color: rgb(148 163 184); }
html.dark .trade-bazaar .br-match-btn:hover { border-color: rgba(34, 211, 238, 0.4); color: rgb(103 232 249); }
html.dark .trade-bazaar .br-match-btn--active { border-color: rgba(34, 211, 238, 0.6); background: rgba(34, 211, 238, 0.1); color: rgb(103 232 249); box-shadow: 0 0 0 2px rgba(34, 211, 238, 0.12); }

.trade-bazaar .br-match-chip { display: inline-flex; align-items: center; border-radius: 999px; border: 1px solid rgba(139, 92, 246, 0.3); background: rgba(139, 92, 246, 0.08); color: rgb(139 92 246); font-size: 8px; font-weight: 700; padding: 0px 4px; white-space: nowrap; }
html.dark .trade-bazaar .br-match-chip { border-color: rgba(167, 139, 250, 0.35); background: rgba(139, 92, 246, 0.15); color: rgb(196 181 253); }

@media (min-width: 640px) { .trade-bazaar .gacha-trade-item-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
@media (min-width: 1024px) { .trade-bazaar .gacha-trade-item-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); } }
@media (min-width: 1440px) { .trade-bazaar .gacha-trade-item-grid { grid-template-columns: repeat(5, minmax(0, 1fr)); } }

.trade-bazaar .br-detail-body { max-height: calc(100vh - 7rem); max-height: calc(100dvh - 7rem); overflow-y: auto; padding: 1rem 1.25rem 1.25rem; }
.trade-bazaar .br-detail-layout { display: grid; gap: 12px; align-items: start; }
.trade-bazaar .br-detail-card { width: 100%; max-width: 140px; margin-inline: auto; }
.trade-bazaar .br-detail-card > * { width: 100%; }
@media (min-width: 640px) { .trade-bazaar .br-detail-layout { gap: 16px; grid-template-columns: 160px minmax(0, 1fr); } .trade-bazaar .br-detail-card { max-width: none; margin-inline: 0; } }
.trade-bazaar .br-detail-stats { display: grid; gap: 6px; grid-template-columns: 1fr; font-size: 12px; }
@media (min-width: 640px) { .trade-bazaar .br-detail-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; } }
.trade-bazaar .br-detail-actions { position: sticky; bottom: 0; padding-top: 12px; background: linear-gradient(to bottom, transparent, var(--g-surface-card) 6px); }
.trade-bazaar .br-fulfill-grid { display: grid; gap: 8px; grid-template-columns: repeat(2, minmax(0, 1fr)); align-items: stretch; }
.trade-bazaar .br-fulfill-grid > * { display: flex; height: 100%; width: 100%; min-width: 0; }
.trade-bazaar .br-fulfill-grid > * > * { width: 100%; height: 100%; }
@media (min-width: 640px) { .trade-bazaar .br-fulfill-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
</style>
