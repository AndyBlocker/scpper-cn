<script setup lang="ts">
/**
 * 集换 tab 面板。
 * 从 index.vue 提取，包含发布挂牌、我的挂牌、公共挂牌三个区域。
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
import GachaRarityFilter from '~/components/gacha/GachaRarityFilter.vue'
import GachaAffixChip from '~/components/gacha/GachaAffixChip.vue'
import GachaCard from '~/components/gacha/GachaCard.vue'
import GachaCardMini from '~/components/gacha/GachaCardMini.vue'
import GachaPagination from '~/components/gacha/GachaPagination.vue'
import { UiButton } from '~/components/ui/button'
import { UiInput } from '~/components/ui/input'
import { UiSelectRoot, UiSelectTrigger, UiSelectContent, UiSelectItem } from '~/components/ui/select'
import {
  UiDialogRoot,
  UiDialogPortal,
  UiDialogOverlay,
  UiDialogContent,
  UiDialogClose
} from '~/components/ui/dialog'

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

function handleMyListingDialogChange(nextOpen: boolean) {
  if (!nextOpen) closeMyListingDetail()
}

function handlePublicListingDialogChange(nextOpen: boolean) {
  if (!nextOpen) closeListingDetail()
}

function handleBuyRequestDialogChange(nextOpen: boolean) {
  if (!nextOpen) closeBuyRequestDetail()
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
const brSelectedVariantIds = ref<string[]>([])       // empty = 任意画面
const brSelectedCoatings = ref<AffixVisualStyle[]>([])  // empty = 任意镀层
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
  // No specific variants → PAGE level (single request)
  if (brSelectedVariantIds.value.length === 0) {
    return [{ targetCardId: firstVariantId, matchLevel: 'PAGE' }]
  }
  // Specific variants, no coatings → IMAGE_VARIANT for each
  if (brSelectedCoatings.value.length === 0) {
    return brSelectedVariantIds.value.map((vid) => ({
      targetCardId: vid,
      matchLevel: 'IMAGE_VARIANT'
    }))
  }
  // Specific variants + specific coatings → COATING for each combo
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

function brFindOfferedOption(stackKey: string) {
  return props.cardOptions.find((item) => item.stackKey === stackKey) ?? null
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
  // Auto-select variant if only one exists
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
  // Clear coatings when variants change to empty
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

// ─── 衍生数据 ────────────────────────────────────────────

const selectedTradeCardOption = computed(() =>
  props.cardOptions.find((item) => item.stackKey === tradeSelectionKey.value) ?? null
)

const normalizedCreateSearch = computed(() => tradeCreateSearch.value.trim().toLowerCase())

// Pre-compute search text for each card option once when props change,
// avoiding repeated string builds + toLowerCase on every keystroke.
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

// Rarity group boundaries for the filtered list (used for group headers)
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

// Progressive pagination — slice the filtered list to pickerVisibleCount
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

// Find which rarity group the current visible boundary sits in
function pickerNextGroupLabel(): string {
  const nextIdx = pickerVisibleCount.value
  for (const g of rarityGroups.value) {
    if (nextIdx >= g.startIndex && nextIdx < g.startIndex + g.count) {
      return rarityLabel(g.rarity)
    }
  }
  return ''
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
      <!-- 折叠式发布表单 -->
      <div>
        <button
          type="button"
          class="trade-collapse-toggle"
          @click="showCreateForm = !showCreateForm"
        >
          <span>{{ showCreateForm ? '收起发布' : '发布挂牌' }}</span>
          <span class="trade-collapse-toggle__icon" :class="{ 'trade-collapse-toggle__icon--open': showCreateForm }">&#9662;</span>
        </button>

        <Transition name="trade-collapse">
          <article v-if="showCreateForm" class="mt-2 rounded-lg border border-neutral-200/75 bg-neutral-50/75 p-4 dark:border-neutral-800/70 dark:bg-neutral-900/55">
            <p class="text-[11px] text-neutral-500 dark:text-neutral-400">仅可上架未放置、且当前可用的库存数量。</p>

            <div v-if="inventoryLoading && !cardOptions.length" class="gacha-empty mt-3">
              正在加载可上架卡片...
            </div>

            <div v-else-if="!cardOptions.length" class="gacha-empty mt-3">
              当前无可上架卡片。你可以先抽卡或从放置槽中撤下卡片。
            </div>

            <form v-else class="mt-3 space-y-3" @submit.prevent="handleCreate">
              <div class="space-y-2">
                <div class="flex flex-wrap items-center justify-between gap-2 text-xs text-neutral-500 dark:text-neutral-400">
                  <span>选择卡片</span>
                  <span>当前可选 {{ filteredTradeCardOptions.length }} 种</span>
                </div>
                <!-- Rarity group summary -->
                <div v-if="rarityGroups.length > 1 && !normalizedCreateSearch" class="flex flex-wrap gap-1">
                  <span
                    v-for="g in rarityGroups"
                    :key="`rg-${g.rarity}`"
                    class="picker-rarity-tag"
                    :class="`picker-rarity-tag--${g.rarity.toLowerCase()}`"
                  >{{ rarityLabel(g.rarity) }} {{ g.count }}</span>
                </div>
                <p v-if="inventoryLoading" class="text-[11px] text-neutral-500 dark:text-neutral-400">
                  正在后台同步可上架库存...
                </p>
                <UiInput
                  v-model.trim="tradeCreateSearch"
                  type="search"
                  placeholder="搜索可上架卡片（标题 / 标签 / 作者 / ID）"
                  class="w-full"
                />
                <div class="picker-scroll-area">
                  <p v-if="!filteredTradeCardOptions.length" class="gacha-empty py-4">
                    当前筛选条件下没有可上架卡片。
                  </p>
                  <div v-else class="trade-create-grid gacha-card-grid--mini">
                    <button
                      v-for="item in visibleTradeCardOptions"
                      :key="`trade-card-${item.stackKey}`"
                      type="button"
                      class="trade-create-card"
                      :class="{ 'trade-create-card--selected': tradeSelectionKey === item.stackKey }"
                      :aria-pressed="tradeSelectionKey === item.stackKey"
                      @click="tradeSelectionKey = item.stackKey"
                    >
                      <GachaCardMini
                        :title="item.title"
                        :rarity="item.rarity"
                        :image-url="item.imageUrl || undefined"
                        :retired="item.isRetired"
                        :affix-visual-style="item.affixVisualStyle"
                        :affix-label="item.affixLabel"
                      >
                        <template #meta>
                          <span class="trade-remaining-chip">可上架 {{ item.availableCount }}</span>
                        </template>
                      </GachaCardMini>
                    </button>
                  </div>
                  <button
                    v-if="pickerHasMore"
                    type="button"
                    class="picker-load-more-btn"
                    @click="pickerLoadMore()"
                  >
                    加载更多（剩余 {{ pickerRemainingCount }}{{ pickerNextGroupLabel() ? `，下批为 ${pickerNextGroupLabel()}` : '' }}）
                  </button>
                </div>
              </div>

              <p v-if="selectedTradeCardOption" class="text-[11px] text-neutral-500 dark:text-neutral-400">
                已选 {{ selectedTradeCardOption.title }} · {{ rarityLabel(selectedTradeCardOption.rarity) }} · 词条 {{ selectedTradeCardOption.affixSignature || 'NONE' }} · 可上架 {{ selectedTradeCardOption.availableCount }}
              </p>

              <div class="grid gap-2 sm:grid-cols-3">
                <label class="space-y-1 text-xs text-neutral-500 dark:text-neutral-400">
                  <span>数量</span>
                  <UiInput v-model.number="tradeQuantity" type="number" min="1" :max="tradeQuantityMax" step="1" />
                </label>
                <label class="space-y-1 text-xs text-neutral-500 dark:text-neutral-400">
                  <span>单价 Token</span>
                  <UiInput v-model.number="tradeUnitPrice" type="number" min="1" max="1000000" step="1" />
                </label>
                <label class="space-y-1 text-xs text-neutral-500 dark:text-neutral-400">
                  <span>有效期（小时）</span>
                  <UiInput v-model.number="tradeExpiresHours" type="number" min="1" :max="24 * 30" step="1" />
                </label>
              </div>

              <p class="text-[11px] text-neutral-500 dark:text-neutral-400">
                挂牌总价 {{ formatTokens(Math.max(1, Number(tradeQuantity || 1)) * Math.max(1, Number(tradeUnitPrice || 1))) }} Token · 预计到期 {{ tradeExpiresHours }} 小时后
              </p>

              <div class="flex flex-wrap gap-2">
                <UiButton type="button" variant="ghost" size="sm" class="rounded-full border border-neutral-200 bg-white px-2.5 py-1 text-[11px] dark:border-neutral-700 dark:bg-neutral-800" @click="tradeExpiresHours = 24">24h</UiButton>
                <UiButton type="button" variant="ghost" size="sm" class="rounded-full border border-neutral-200 bg-white px-2.5 py-1 text-[11px] dark:border-neutral-700 dark:bg-neutral-800" @click="tradeExpiresHours = 72">72h</UiButton>
                <UiButton type="button" variant="ghost" size="sm" class="rounded-full border border-neutral-200 bg-white px-2.5 py-1 text-[11px] dark:border-neutral-700 dark:bg-neutral-800" @click="tradeExpiresHours = 168">168h</UiButton>
              </div>

              <UiButton type="submit" class="w-full py-2.5 text-sm" :disabled="submitting || !selectedTradeCardOption">
                {{ submitting ? '上架中...' : '提交并确认' }}
              </UiButton>
            </form>
          </article>
        </Transition>
      </div>

      <!-- 搜索 / 排序 -->
      <div class="grid gap-2 md:grid-cols-[minmax(0,1fr),minmax(160px,200px),minmax(180px,230px),auto]">
        <UiInput
          v-model.trim="tradeSearch"
          type="search"
          placeholder="搜索卡片名 / 标签 / 作者 / 卖家"
          class="w-full"
        />
        <UiSelectRoot v-model="tradeSearchMode">
          <UiSelectTrigger placeholder="搜索模式" />
          <UiSelectContent>
            <UiSelectItem value="ALL">全字段搜索</UiSelectItem>
            <UiSelectItem value="CARD">仅卡片</UiSelectItem>
            <UiSelectItem value="SELLER">仅卖家</UiSelectItem>
          </UiSelectContent>
        </UiSelectRoot>
        <UiSelectRoot v-model="tradeSortMode">
          <UiSelectTrigger placeholder="排序方式" />
          <UiSelectContent>
            <UiSelectItem value="LATEST">按上架时间（新到旧）</UiSelectItem>
            <UiSelectItem value="RARITY_DESC">按稀有度（高到低）</UiSelectItem>
            <UiSelectItem value="PRICE_ASC">按单价（低到高）</UiSelectItem>
            <UiSelectItem value="PRICE_DESC">按单价（高到低）</UiSelectItem>
            <UiSelectItem value="TOTAL_ASC">按总价（低到高）</UiSelectItem>
            <UiSelectItem value="TOTAL_DESC">按总价（高到低）</UiSelectItem>
          </UiSelectContent>
        </UiSelectRoot>
        <UiButton variant="outline" class="h-9" @click="resetFilters">重置</UiButton>
      </div>

      <div class="mt-2">
        <GachaRarityFilter
          v-model="tradeRarityFilter"
          :options="tradeRarityFilterOptions"
          all-label="全部品质"
        />
      </div>

      <p class="mt-2 text-[11px] text-neutral-500 dark:text-neutral-400">
        显示 {{ visiblePublicListings.length }} / {{ publicTotal }} 条
      </p>

      <p v-if="!publicListings.length" class="gacha-empty mt-3">当前筛选条件下没有可购买挂牌。</p>
      <div v-else class="mt-3">
        <div class="gacha-trade-item-grid">
          <button
            v-for="listing in visiblePublicListings"
            :key="`public-trade-${listing.id}`"
            type="button"
            class="trade-item-row"
            @click="openListingDetail(listing)"
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
              <span class="trade-item-row__user">{{ formatAccountDisplayName(listing.seller, listing.sellerId) }}</span>
              <span class="trade-item-row__price">{{ formatTokens(listing.unitPrice) }}T <span class="trade-item-row__qty">× {{ listing.remaining }}张</span></span>
              <span class="trade-item-row__time">{{ listingRemainingLabel(listing) }}</span>
            </div>
          </button>
        </div>
      </div>

      <GachaPagination
        :current="tradePublicPage"
        :total="publicTotal"
        :page-size="TRADE_PAGE_SIZE"
        :loading="loading || publicLoadingMore"
        @change="(p: number) => { tradePublicPage = p; emit('trade-page-change', p) }"
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
    <div v-else-if="activeSubTab === 'buyRequest'" class="mt-4 space-y-4">
      <!-- 折叠式发布求购表单 -->
      <div>
        <button
          type="button"
          class="trade-collapse-toggle"
          @click="showBuyRequestForm = !showBuyRequestForm"
        >
          <span>{{ showBuyRequestForm ? '收起求购' : '发布求购' }}</span>
          <span class="trade-collapse-toggle__icon" :class="{ 'trade-collapse-toggle__icon--open': showBuyRequestForm }">&#9662;</span>
        </button>

        <Transition name="trade-collapse">
          <article v-if="showBuyRequestForm" class="mt-2 rounded-lg border border-cyan-200/60 bg-cyan-50/40 p-4 dark:border-cyan-800/50 dark:bg-cyan-950/30">
            <p class="mt-1 text-[10px] text-neutral-500 dark:text-neutral-400">指定想要的卡片，可使用 Token 或自己的卡牌出价。</p>

            <div class="mt-3 space-y-3">
              <!-- Step 1: 搜索页面 -->
              <div class="space-y-1.5">
                <div class="flex items-center justify-between">
                  <span class="text-[11px] text-neutral-500 dark:text-neutral-400">想要的页面</span>
                  <button
                    v-if="brSelectedPage"
                    type="button"
                    class="text-[10px] text-cyan-600 hover:text-cyan-800 dark:text-cyan-400 dark:hover:text-cyan-200"
                    @click="brClearSelection"
                  >重新选择</button>
                </div>
                <template v-if="!brSelectedPage">
                  <UiInput
                    v-model.trim="brTargetSearch"
                    type="search"
                    placeholder="搜索页面名 / 标签 / 作者"
                    class="w-full"
                  />
                  <div class="max-h-[14rem] overflow-y-auto pr-1">
                    <p v-if="!brFilteredCatalog.length" class="gacha-empty py-3 text-[11px]">未找到匹配的页面。</p>
                    <div v-else class="gacha-card-grid--mini">
                      <button
                        v-for="entry in brFilteredCatalog.slice(0, 30)"
                        :key="`br-page-${entry.pageId ?? entry.variants[0]?.id}`"
                        type="button"
                        class="trade-create-card"
                        @click="brSelectPage(entry)"
                      >
                      <GachaCardMini
                          :title="entry.title"
                          :rarity="entry.rarity"
                          :image-url="entry.variants[0]?.imageUrl || undefined"
                          :retired="entry.isRetired"
                          :hide-footer="true"
                        />
                      </button>
                    </div>
                  </div>
                </template>
                <p v-else class="text-[11px] text-cyan-700 dark:text-cyan-200">
                  已选: {{ brSelectedPage.title }} · {{ rarityLabel(brSelectedPage.rarity) }}
                  <span v-if="brSelectedPage.variants.length > 1" class="text-neutral-400">（{{ brSelectedPage.variants.length }} 个画面）</span>
                </p>
              </div>

              <!-- Step 2: 画面选择（多画面时显示，使用 GachaCard mini 可视化） -->
              <div v-if="brSelectedPage && brSelectedPage.variants.length > 1" class="space-y-1.5">
                <div class="flex items-center justify-between">
                  <span class="text-[11px] text-neutral-500 dark:text-neutral-400">选择画面（可多选）</span>
                  <span class="flex gap-2">
                    <button
                      v-if="brSelectedVariantIds.length > 0"
                      type="button"
                      class="text-[10px] text-cyan-600 hover:text-cyan-800 dark:text-cyan-400 dark:hover:text-cyan-200"
                      @click="brClearVariants"
                    >任意画面</button>
                    <button
                      v-if="brSelectedVariantIds.length < brSelectedPage.variants.length"
                      type="button"
                      class="text-[10px] text-cyan-600 hover:text-cyan-800 dark:text-cyan-400 dark:hover:text-cyan-200"
                      @click="brSelectAllVariants"
                    >全选</button>
                  </span>
                </div>
                <div class="gacha-card-grid--mini">
                  <button
                    v-for="v in brSelectedPage.variants"
                    :key="`br-variant-${v.id}`"
                    type="button"
                    class="trade-create-card"
                    :class="{ 'trade-create-card--selected': brSelectedVariantIds.includes(v.id) }"
                    @click="brToggleVariant(v.id)"
                  >
                    <GachaCardMini
                      :title="brSelectedPage.title"
                      :rarity="brSelectedPage.rarity"
                      :image-url="v.imageUrl || undefined"
                      :retired="v.isRetired"
                      :hide-footer="true"
                    />
                  </button>
                </div>
                <p class="text-[10px] text-neutral-400 dark:text-neutral-500">
                  {{ brSelectedVariantIds.length === 0 ? '未选择 = 接受任意画面（PAGE 级匹配）' : `已选 ${brSelectedVariantIds.length} 个画面` }}
                </p>
              </div>

              <!-- Step 3: 镀层选择（选了具体画面才能指定镀层，可多选） -->
              <div v-if="brSelectedPage && brSelectedVariantIds.length > 0" class="space-y-1.5">
                <span class="text-[11px] text-neutral-500 dark:text-neutral-400">镀层要求（可多选，不选 = 任意镀层）</span>
                <div class="flex flex-wrap gap-1.5">
                  <button
                    v-for="style in coatingOptions"
                    :key="`br-coat-${style}`"
                    type="button"
                    class="br-match-btn"
                    :class="{ 'br-match-btn--active': brSelectedCoatings.includes(style) }"
                    @click="brToggleCoating(style)"
                  >
                    {{ coatingStyleLabelMap[style] }}
                  </button>
                </div>
                <p v-if="brSelectedCoatings.length > 0" class="text-[10px] text-neutral-400 dark:text-neutral-500">
                  已选 {{ brSelectedCoatings.length }} 种镀层
                </p>
              </div>

              <!-- 匹配级别提示 -->
              <p v-if="brSelectedPage" class="rounded-lg bg-neutral-100/80 px-2.5 py-1.5 text-[10px] text-neutral-500 dark:bg-neutral-800/60 dark:text-neutral-400">
                <template v-if="brDerivedPayloads.length === 1">
                  匹配级别: <span class="font-semibold text-cyan-700 dark:text-cyan-300">{{ buyRequestMatchLevelLabelMap[brDerivedPayloads[0]!.matchLevel] }}</span>
                  — {{ brDerivedMatchLevelLabel }}
                </template>
                <template v-else>
                  将创建 <span class="font-semibold text-cyan-700 dark:text-cyan-300">{{ brDerivedPayloads.length }}</span> 个求购（每个出价相同）
                  — {{ brDerivedMatchLevelLabel }}
                </template>
              </p>

              <!-- Token 出价 -->
              <label class="block space-y-1 text-xs text-neutral-500 dark:text-neutral-400">
                <span>Token 出价（可为 0）</span>
                <UiInput v-model.number="brTokenOffer" type="number" min="0" max="500000" step="1" />
              </label>

              <!-- 提供卡牌 -->
              <div class="space-y-1.5">
                <span class="text-[11px] text-neutral-500 dark:text-neutral-400">
                  提供的卡牌（可选，{{ brOfferedCards.length }} 张已选）
                </span>
                <UiInput
                  v-model.trim="brOfferedSearch"
                  type="search"
                  placeholder="搜索可提供的卡牌（标题 / 标签 / 作者）"
                  class="w-full"
                />
                <div v-if="inventoryLoading && !cardOptions.length" class="text-[11px] text-neutral-500 dark:text-neutral-400">
                  正在加载库存...
                </div>
                <div v-else class="max-h-[12rem] overflow-y-auto pr-1">
                  <div v-if="brFilteredTradeCardOptions.length" class="gacha-card-grid--mini">
                    <button
                      v-for="item in brFilteredTradeCardOptions.slice(0, 30)"
                      :key="`br-offer-${item.stackKey}`"
                      type="button"
                      class="trade-create-card"
                      :class="{ 'trade-create-card--selected': brOfferedCards.some((c) => c.stackKey === item.stackKey) }"
                      @click="brToggleOfferedCard(item)"
                    >
                      <GachaCardMini
                        :title="item.title"
                        :rarity="item.rarity"
                        :image-url="item.imageUrl || undefined"
                        :retired="item.isRetired"
                        :affix-visual-style="item.affixVisualStyle"
                        :affix-label="item.affixLabel"
                      >
                        <template #meta>
                          <span class="trade-remaining-chip">可选 {{ item.availableCount }}</span>
                        </template>
                      </GachaCardMini>
                    </button>
                  </div>
                </div>
                <!-- 已选卡牌及数量设置 -->
                <div v-if="brOfferedCards.length > 0" class="flex flex-wrap gap-2 pt-1">
                  <div
                    v-for="oc in brOfferedCards"
                    :key="`br-oc-${oc.stackKey}`"
                    class="flex items-center gap-1 rounded-lg border border-cyan-200/60 bg-white/80 px-2 py-1 text-[10px] dark:border-cyan-700/50 dark:bg-neutral-900/60"
                  >
                    <span class="max-w-[80px] truncate text-neutral-700 dark:text-neutral-200">
                      {{ brFindOfferedOption(oc.stackKey)?.title ?? oc.cardId.slice(0, 8) }} · {{ oc.affixSignature || 'NONE' }}
                    </span>
                    <input
                      type="number"
                      :value="oc.quantity"
                      min="1"
                      :max="brFindOfferedOption(oc.stackKey)?.availableCount ?? 99"
                      class="w-10 rounded border border-neutral-200 bg-transparent px-1 py-0 text-center text-[10px] dark:border-neutral-700"
                      @input="brSetOfferedQuantity(oc.stackKey, Number(($event.target as HTMLInputElement).value || 1))"
                    />
                    <button type="button" class="text-neutral-400 hover:text-red-500" @click="brRemoveOfferedCard(oc.stackKey)">×</button>
                  </div>
                </div>
              </div>

              <!-- 有效期 -->
              <label class="block space-y-1 text-xs text-neutral-500 dark:text-neutral-400">
                <span>有效期（小时）</span>
                <UiInput v-model.number="brExpiresHours" type="number" min="1" :max="24 * 30" step="1" />
              </label>

              <div class="flex flex-wrap gap-2">
                <UiButton type="button" variant="ghost" size="sm" class="rounded-full border border-neutral-200 bg-white px-2.5 py-1 text-[11px] dark:border-neutral-700 dark:bg-neutral-800" @click="brExpiresHours = 24">24h</UiButton>
                <UiButton type="button" variant="ghost" size="sm" class="rounded-full border border-neutral-200 bg-white px-2.5 py-1 text-[11px] dark:border-neutral-700 dark:bg-neutral-800" @click="brExpiresHours = 72">72h</UiButton>
                <UiButton type="button" variant="ghost" size="sm" class="rounded-full border border-neutral-200 bg-white px-2.5 py-1 text-[11px] dark:border-neutral-700 dark:bg-neutral-800" @click="brExpiresHours = 168">168h</UiButton>
              </div>

              <UiButton class="w-full py-2.5 text-sm" :disabled="buyRequestSubmitting || !brCanSubmit" @click="handleCreateBuyRequest">
                {{ buyRequestSubmitting ? '提交中...' : '发布求购' }}
              </UiButton>
            </div>
          </article>
        </Transition>
      </div>

      <!-- 公共求购浏览 -->
      <article class="rounded-lg border border-neutral-200/75 bg-neutral-50/75 p-4 dark:border-neutral-800/70 dark:bg-neutral-900/55">
        <header class="flex flex-wrap items-center justify-between gap-2">
          <h4 class="text-xs font-semibold text-neutral-700 dark:text-neutral-200">
            公共求购
          </h4>
          <UiButton variant="outline" size="sm" :disabled="buyRequestLoading" @click="emit('refresh-buy-requests', { resetPublic: true })">
            {{ buyRequestLoading ? '刷新中...' : '刷新' }}
          </UiButton>
        </header>

        <!-- 可接单筛选开关 -->
        <div v-if="userId" class="mt-2">
          <button
            type="button"
            class="br-fulfillable-toggle"
            :class="{ 'br-fulfillable-toggle--active': brShowFulfillableOnly }"
            @click="toggleFulfillableOnly"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="br-fulfillable-toggle__icon"><path fill-rule="evenodd" d="M16.704 4.153a.75.75 0 01.143 1.052l-8 10.5a.75.75 0 01-1.127.075l-4.5-4.5a.75.75 0 011.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 011.05-.143z" clip-rule="evenodd" /></svg>
            仅显示我可接的求购
          </button>
        </div>

        <div class="mt-2 grid gap-2 md:grid-cols-[minmax(0,1fr),minmax(160px,200px),auto]">
          <UiInput v-model.trim="brSearchInput" type="search" placeholder="搜索卡片名 / 作者 / 买家" class="w-full" />
          <UiSelectRoot v-model="brSortMode">
            <UiSelectTrigger placeholder="排序方式" />
            <UiSelectContent>
              <UiSelectItem value="LATEST">按发布时间</UiSelectItem>
              <UiSelectItem value="RARITY_DESC">按稀有度</UiSelectItem>
              <UiSelectItem value="TOKEN_DESC">按出价降序</UiSelectItem>
              <UiSelectItem value="TOKEN_ASC">按出价升序</UiSelectItem>
              <UiSelectItem value="EXPIRY_ASC">按到期时间</UiSelectItem>
            </UiSelectContent>
          </UiSelectRoot>
          <UiButton variant="outline" class="h-9" @click="brResetFilters">重置</UiButton>
        </div>
        <div class="mt-2">
          <GachaRarityFilter v-model="brRarityFilter" :options="tradeRarityFilterOptions" all-label="全部品质" />
        </div>

        <p class="mt-2 text-[11px] text-neutral-500 dark:text-neutral-400">
          显示 {{ visibleBuyRequests.length }}{{ brShowFulfillableOnly ? ` (可接)` : '' }} / {{ buyRequestPublicTotal }} 条
        </p>

        <p v-if="!displayedBuyRequests.length" class="gacha-empty mt-3">
          {{ brShowFulfillableOnly ? '当前没有你可以接的求购。' : '当前没有公开求购。' }}
        </p>
        <div v-else class="mt-3 gacha-trade-item-grid">
          <button
            v-for="br in visibleBuyRequests"
            :key="`public-br-${br.id}`"
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
              <span class="trade-item-row__user">{{ formatAccountDisplayName(br.buyer, br.buyerId) }}</span>
              <span class="trade-item-row__price">{{ br.tokenOffer > 0 ? `${formatTokens(br.tokenOffer)}T` : '' }}{{ br.tokenOffer > 0 && br.offeredCards.length > 0 ? ' + ' : '' }}{{ br.offeredCards.length > 0 ? `${br.offeredCards.length}卡` : '' }}</span>
              <span class="flex items-center gap-1">
                <span class="trade-item-row__time">{{ buyRequestRemainingLabel(br) }}</span>
                <span class="br-match-chip">{{ buyRequestMatchLevelShortMap[br.matchLevel] }}</span>
              </span>
            </div>
          </button>
        </div>

        <div v-if="hasMoreBrLocal" class="mt-3 flex items-center justify-center">
          <UiButton variant="outline" size="sm" @click="brVisibleCount += BR_PAGE_SIZE">
            显示更多已加载求购（剩余 {{ displayedBuyRequests.length - brVisibleCount }} 条）
          </UiButton>
        </div>

        <GachaPagination
          :current="buyRequestPublicPage"
          :total="buyRequestPublicTotal"
          :page-size="40"
          :loading="buyRequestPublicLoadingMore || buyRequestLoading"
          @change="(p: number) => { buyRequestPublicPage = p; emit('buy-request-page-change', p) }"
        />
      </article>
    </div>

    <!-- 挂牌详情弹窗 -->
    <UiDialogRoot :open="!!selectedMyListing" @update:open="handleMyListingDialogChange">
      <UiDialogPortal>
        <UiDialogOverlay />
        <UiDialogContent class="max-w-lg p-0">
          <template v-if="selectedMyListing">
            <header class="flex items-start justify-between gap-3 border-b border-neutral-200/60 px-5 py-4 dark:border-neutral-800/70">
              <div class="min-w-0">
                <p class="text-[11px] font-semibold uppercase tracking-[0.14em] text-cyan-700 dark:text-cyan-200">My Listing</p>
                <h3 class="mt-1 truncate text-lg font-semibold text-neutral-900 dark:text-neutral-50">{{ selectedMyListing.card.title }}</h3>
                <p class="mt-0.5 text-xs text-neutral-500 dark:text-neutral-400">
                  {{ rarityLabel(selectedMyListing.card.rarity) }} · {{ tradeStatusLabel(selectedMyListing.status) }}
                </p>
              </div>
              <UiDialogClose as-child>
                <UiButton variant="ghost" size="sm" class="h-9 w-9 rounded-full p-0" aria-label="关闭">X</UiButton>
              </UiDialogClose>
            </header>

            <div class="max-h-[calc(100vh-7rem)] max-h-[calc(100dvh-7rem)] overflow-y-auto px-5 pb-5 pt-4">
              <div class="grid gap-4 sm:grid-cols-[150px_minmax(0,1fr)] sm:items-start">
                <div class="trade-detail-mini-card">
                  <GachaCard
                    :title="selectedMyListing.card.title"
                    :rarity="selectedMyListing.card.rarity"
                    :tags="selectedMyListing.card.tags ?? []"
                    :wikidot-id="selectedMyListing.card.wikidotId"
                    :authors="selectedMyListing.card.authors"
                    :image-url="selectedMyListing.card.imageUrl || undefined"
                    :retired="selectedMyListing.card.isRetired"
                    variant="mini"
                    :hide-footer="true"
                    :affix-visual-style="selectedMyListing.card.affixVisualStyle || selectedMyListing.affixBreakdown?.[0]?.affixVisualStyle"
                    :affix-signature="selectedMyListing.card.affixSignature || selectedMyListing.affixBreakdown?.[0]?.affixSignature"
                    :affix-styles="selectedMyListing.card.affixStyles || selectedMyListing.affixBreakdown?.[0]?.affixStyles"
                    :affix-style-counts="selectedMyListing.card.affixStyleCounts || selectedMyListing.affixBreakdown?.[0]?.affixStyleCounts"
                    :affix-label="selectedMyListing.card.affixLabel || selectedMyListing.affixBreakdown?.[0]?.affixLabel"
                  />
                </div>

                <div class="space-y-3">
                  <dl class="grid grid-cols-2 gap-2 text-xs">
                    <div class="rounded-xl border border-neutral-200/70 bg-neutral-50/90 px-2.5 py-2 dark:border-neutral-700/70 dark:bg-neutral-800/70">
                      <dt class="text-neutral-500 dark:text-neutral-400">单价</dt>
                      <dd class="mt-0.5 font-semibold text-neutral-800 dark:text-neutral-100">{{ formatTokens(selectedMyListing.unitPrice) }} Token</dd>
                    </div>
                    <div class="rounded-xl border border-neutral-200/70 bg-neutral-50/90 px-2.5 py-2 dark:border-neutral-700/70 dark:bg-neutral-800/70">
                      <dt class="text-neutral-500 dark:text-neutral-400">总价</dt>
                      <dd class="mt-0.5 font-semibold text-neutral-800 dark:text-neutral-100">{{ formatTokens(listingTotalPrice(selectedMyListing)) }} Token</dd>
                    </div>
                    <div class="rounded-xl border border-neutral-200/70 bg-neutral-50/90 px-2.5 py-2 dark:border-neutral-700/70 dark:bg-neutral-800/70">
                      <dt class="text-neutral-500 dark:text-neutral-400">剩余数量</dt>
                      <dd class="mt-0.5 font-semibold text-neutral-800 dark:text-neutral-100">{{ selectedMyListing.remaining }} / {{ selectedMyListing.quantity }}</dd>
                    </div>
                    <div class="rounded-xl border border-neutral-200/70 bg-neutral-50/90 px-2.5 py-2 dark:border-neutral-700/70 dark:bg-neutral-800/70">
                      <dt class="text-neutral-500 dark:text-neutral-400">到期时间</dt>
                      <dd class="mt-0.5 font-semibold text-neutral-800 dark:text-neutral-100">{{ formatDateCompact(selectedMyListing.expiresAt) || '无' }}</dd>
                    </div>
                    <div
                      v-if="selectedMyListing.status === 'SOLD'"
                      class="rounded-xl border border-emerald-200/80 bg-emerald-50/80 px-2.5 py-2 dark:border-emerald-700/70 dark:bg-emerald-900/20"
                    >
                      <dt class="text-emerald-700 dark:text-emerald-300">成交买家</dt>
                      <dd class="mt-0.5 font-semibold text-emerald-900 dark:text-emerald-100">
                        {{ formatAccountDisplayName(selectedMyListing.buyer, selectedMyListing.buyerId) }}
                      </dd>
                    </div>
                    <div
                      v-if="selectedMyListing.status === 'SOLD'"
                      class="rounded-xl border border-emerald-200/80 bg-emerald-50/80 px-2.5 py-2 dark:border-emerald-700/70 dark:bg-emerald-900/20"
                    >
                      <dt class="text-emerald-700 dark:text-emerald-300">成交时间</dt>
                      <dd class="mt-0.5 font-semibold text-emerald-900 dark:text-emerald-100">
                        {{ formatDateCompact(selectedMyListing.soldAt) || '未知' }}
                      </dd>
                    </div>
                  </dl>

                  <div v-if="selectedMyListing.affixBreakdown?.length" class="flex flex-wrap gap-1.5 text-[10px]">
                    <template
                      v-for="entry in selectedMyListing.affixBreakdown"
                      :key="`my-detail-bd-${entry.affixSignature || entry.affixVisualStyle}`"
                    >
                      <GachaAffixChip
                        v-for="part in resolveAffixParts(entry)"
                        :key="`my-detail-bd-${entry.affixSignature || entry.affixVisualStyle}-${part.style}-${part.count}`"
                        :style="part.style"
                        :count="part.count"
                        :show-glyph="true"
                        :suffix="`x${entry.count}`"
                      />
                    </template>
                  </div>

                  <div class="flex items-center gap-2 pt-1">
                    <span
                      class="inline-flex rounded-full border px-2 py-0.5 text-[10px] font-semibold"
                      :class="tradeStatusChipClassMap[selectedMyListing.status]"
                    >
                      {{ tradeStatusLabel(selectedMyListing.status) }}
                    </span>
                    <span class="text-[11px] text-neutral-500 dark:text-neutral-400">
                      上架 {{ formatDateCompact(selectedMyListing.createdAt) }}
                    </span>
                  </div>

                  <UiButton
                    v-if="selectedMyListing.status === 'OPEN' && selectedMyListing.remaining > 0"
                    class="w-full"
                    variant="outline"
                    :disabled="cancellingId === selectedMyListing.id"
                    @click="emit('cancel', selectedMyListing.id); closeMyListingDetail()"
                  >
                    {{ cancellingId === selectedMyListing.id ? '撤销中...' : '撤销挂牌' }}
                  </UiButton>
                </div>
              </div>
            </div>
          </template>
        </UiDialogContent>
      </UiDialogPortal>
    </UiDialogRoot>

    <UiDialogRoot :open="!!selectedPublicListing" @update:open="handlePublicListingDialogChange">
      <UiDialogPortal>
        <UiDialogOverlay />
        <UiDialogContent class="max-w-lg p-0">
          <template v-if="selectedPublicListing">
            <header class="flex items-start justify-between gap-3 border-b border-neutral-200/60 px-5 py-4 dark:border-neutral-800/70">
              <div class="min-w-0">
                <p class="text-[11px] font-semibold uppercase tracking-[0.14em] text-cyan-700 dark:text-cyan-200">Trade Listing</p>
                <h3 class="mt-1 truncate text-lg font-semibold text-neutral-900 dark:text-neutral-50">{{ selectedPublicListing.card.title }}</h3>
                <p class="mt-0.5 text-xs text-neutral-500 dark:text-neutral-400">
                  {{ rarityLabel(selectedPublicListing.card.rarity) }} · 卖家 {{ formatAccountDisplayName(selectedPublicListing.seller, selectedPublicListing.sellerId) }}
                </p>
              </div>
              <UiDialogClose as-child>
                <UiButton variant="ghost" size="sm" class="h-9 w-9 rounded-full p-0" aria-label="关闭">X</UiButton>
              </UiDialogClose>
            </header>

            <div class="max-h-[calc(100vh-7rem)] max-h-[calc(100dvh-7rem)] overflow-y-auto px-5 pb-5 pt-4">
              <div class="grid gap-4 sm:grid-cols-[150px_minmax(0,1fr)] sm:items-start">
                <div class="trade-detail-mini-card">
                  <GachaCard
                    :title="selectedPublicListing.card.title"
                    :rarity="selectedPublicListing.card.rarity"
                    :tags="selectedPublicListing.card.tags ?? []"
                    :wikidot-id="selectedPublicListing.card.wikidotId"
                    :authors="selectedPublicListing.card.authors"
                    :image-url="selectedPublicListing.card.imageUrl || undefined"
                    :retired="selectedPublicListing.card.isRetired"
                    variant="mini"
                    :hide-footer="true"
                    :affix-visual-style="selectedPublicListing.card.affixVisualStyle || selectedPublicListing.affixBreakdown?.[0]?.affixVisualStyle"
                    :affix-signature="selectedPublicListing.card.affixSignature || selectedPublicListing.affixBreakdown?.[0]?.affixSignature"
                    :affix-styles="selectedPublicListing.card.affixStyles || selectedPublicListing.affixBreakdown?.[0]?.affixStyles"
                    :affix-style-counts="selectedPublicListing.card.affixStyleCounts || selectedPublicListing.affixBreakdown?.[0]?.affixStyleCounts"
                    :affix-label="selectedPublicListing.card.affixLabel || selectedPublicListing.affixBreakdown?.[0]?.affixLabel"
                  />
                </div>

                <div class="space-y-3">
                  <dl class="grid grid-cols-2 gap-2 text-xs">
                    <div class="rounded-xl border border-neutral-200/70 bg-neutral-50/90 px-2.5 py-2 dark:border-neutral-700/70 dark:bg-neutral-800/70">
                      <dt class="text-neutral-500 dark:text-neutral-400">单价</dt>
                      <dd class="mt-0.5 font-semibold text-neutral-800 dark:text-neutral-100">{{ formatTokens(selectedPublicListing.unitPrice) }} Token</dd>
                    </div>
                    <div class="rounded-xl border border-neutral-200/70 bg-neutral-50/90 px-2.5 py-2 dark:border-neutral-700/70 dark:bg-neutral-800/70">
                      <dt class="text-neutral-500 dark:text-neutral-400">总价</dt>
                      <dd class="mt-0.5 font-semibold text-neutral-800 dark:text-neutral-100">{{ formatTokens(listingTotalPrice(selectedPublicListing)) }} Token</dd>
                    </div>
                    <div class="rounded-xl border border-neutral-200/70 bg-neutral-50/90 px-2.5 py-2 dark:border-neutral-700/70 dark:bg-neutral-800/70">
                      <dt class="text-neutral-500 dark:text-neutral-400">剩余数量</dt>
                      <dd class="mt-0.5 font-semibold text-neutral-800 dark:text-neutral-100">{{ selectedPublicListing.remaining }} / {{ selectedPublicListing.quantity }}</dd>
                    </div>
                    <div class="rounded-xl border border-neutral-200/70 bg-neutral-50/90 px-2.5 py-2 dark:border-neutral-700/70 dark:bg-neutral-800/70">
                      <dt class="text-neutral-500 dark:text-neutral-400">到期时间</dt>
                      <dd class="mt-0.5 font-semibold text-neutral-800 dark:text-neutral-100">{{ formatDateCompact(selectedPublicListing.expiresAt) || '无' }}</dd>
                    </div>
                    <div class="rounded-xl border border-neutral-200/70 bg-neutral-50/90 px-2.5 py-2 dark:border-neutral-700/70 dark:bg-neutral-800/70">
                      <dt class="text-neutral-500 dark:text-neutral-400">卖家</dt>
                      <dd class="mt-0.5 font-semibold text-neutral-800 dark:text-neutral-100">
                        {{ formatAccountDisplayName(selectedPublicListing.seller, selectedPublicListing.sellerId) }}
                      </dd>
                    </div>
                  </dl>

                  <div v-if="selectedPublicListing.affixBreakdown?.length" class="flex flex-wrap gap-1.5 text-[10px]">
                    <template
                      v-for="entry in selectedPublicListing.affixBreakdown"
                      :key="`detail-bd-${entry.affixSignature || entry.affixVisualStyle}`"
                    >
                      <GachaAffixChip
                        v-for="part in resolveAffixParts(entry)"
                        :key="`detail-bd-${entry.affixSignature || entry.affixVisualStyle}-${part.style}-${part.count}`"
                        :style="part.style"
                        :count="part.count"
                        :show-glyph="true"
                        :suffix="`x${entry.count}`"
                      />
                    </template>
                  </div>

                  <div class="flex items-center gap-2 pt-1">
                    <span
                      class="inline-flex rounded-full border px-2 py-0.5 text-[10px] font-semibold"
                      :class="tradeStatusChipClassMap[selectedPublicListing.status]"
                    >
                      {{ tradeStatusLabel(selectedPublicListing.status) }}
                    </span>
                    <span class="text-[11px] text-neutral-500 dark:text-neutral-400">
                      上架 {{ formatDateCompact(selectedPublicListing.createdAt) }}
                    </span>
                  </div>

                  <UiButton
                    class="w-full"
                    :disabled="buyingId === selectedPublicListing.id || selectedPublicListing.sellerId === userId || selectedPublicListing.status !== 'OPEN' || selectedPublicListing.remaining <= 0"
                    @click="emit('buy', selectedPublicListing.id); closeListingDetail()"
                  >
                    <span v-if="buyingId === selectedPublicListing.id">购买中...</span>
                    <span v-else-if="selectedPublicListing.sellerId === userId">这是我的挂牌</span>
                    <span v-else>购买 · {{ formatTokens(selectedPublicListing.unitPrice) }} Token</span>
                  </UiButton>
                </div>
              </div>
            </div>
          </template>
        </UiDialogContent>
      </UiDialogPortal>
    </UiDialogRoot>

    <!-- 求购详情弹窗 -->
    <UiDialogRoot :open="!!selectedBuyRequest" @update:open="handleBuyRequestDialogChange">
      <UiDialogPortal>
        <UiDialogOverlay />
        <UiDialogContent class="max-w-xl p-0">
          <template v-if="selectedBuyRequest">
            <header class="flex items-start justify-between gap-3 border-b border-neutral-200/60 px-5 py-4 dark:border-neutral-800/70">
              <div class="min-w-0">
                <p class="text-[11px] font-semibold uppercase tracking-[0.14em] text-cyan-700 dark:text-cyan-200">Buy Request</p>
                <h3 class="mt-1 truncate text-lg font-semibold text-neutral-900 dark:text-neutral-50">求购: {{ selectedBuyRequest.targetCard.title }}</h3>
                <p class="mt-0.5 text-xs text-neutral-500 dark:text-neutral-400">
                  {{ rarityLabel(selectedBuyRequest.targetCard.rarity) }} · 买家 {{ formatAccountDisplayName(selectedBuyRequest.buyer, selectedBuyRequest.buyerId) }}
                </p>
              </div>
              <UiDialogClose as-child>
                <UiButton variant="ghost" size="sm" class="h-9 w-9 rounded-full p-0" aria-label="关闭">X</UiButton>
              </UiDialogClose>
            </header>

            <div class="br-detail-body">
              <div class="br-detail-layout">
                <div class="br-detail-card">
                  <GachaCard
                    :title="selectedBuyRequest.targetCard.title"
                    :rarity="selectedBuyRequest.targetCard.rarity"
                    :tags="selectedBuyRequest.targetCard.tags ?? []"
                    :wikidot-id="selectedBuyRequest.targetCard.wikidotId"
                    :authors="selectedBuyRequest.targetCard.authors"
                    :image-url="selectedBuyRequest.targetCard.imageUrl || undefined"
                    :retired="selectedBuyRequest.targetCard.isRetired"
                    variant="mini"
                    :hide-footer="true"
                  />
                </div>

                <div class="space-y-3">
                  <dl class="br-detail-stats">
                    <div class="rounded-xl border border-neutral-200/70 bg-neutral-50/90 px-2.5 py-2 dark:border-neutral-700/70 dark:bg-neutral-800/70">
                      <dt class="text-neutral-500 dark:text-neutral-400">Token 出价</dt>
                      <dd class="mt-0.5 font-semibold text-neutral-800 dark:text-neutral-100">
                        {{ selectedBuyRequest.tokenOffer > 0 ? `${formatTokens(selectedBuyRequest.tokenOffer)} Token` : '无' }}
                      </dd>
                    </div>
                    <div class="rounded-xl border border-neutral-200/70 bg-neutral-50/90 px-2.5 py-2 dark:border-neutral-700/70 dark:bg-neutral-800/70">
                      <dt class="text-neutral-500 dark:text-neutral-400">提供卡牌</dt>
                      <dd class="mt-0.5 font-semibold text-neutral-800 dark:text-neutral-100">
                        {{ selectedBuyRequest.offeredCards.length > 0 ? `${selectedBuyRequest.offeredCards.length} 种` : '无' }}
                      </dd>
                    </div>
                    <div class="rounded-xl border border-neutral-200/70 bg-neutral-50/90 px-2.5 py-2 dark:border-neutral-700/70 dark:bg-neutral-800/70">
                      <dt class="text-neutral-500 dark:text-neutral-400">到期时间</dt>
                      <dd class="mt-0.5 font-semibold text-neutral-800 dark:text-neutral-100">{{ formatDateCompact(selectedBuyRequest.expiresAt) || '无' }}</dd>
                    </div>
                    <div class="rounded-xl border border-neutral-200/70 bg-neutral-50/90 px-2.5 py-2 dark:border-neutral-700/70 dark:bg-neutral-800/70">
                      <dt class="text-neutral-500 dark:text-neutral-400">状态</dt>
                      <dd class="mt-0.5">
                        <span class="inline-flex rounded-full border px-2 py-0.5 text-[10px] font-semibold" :class="buyRequestStatusChipClassMap[selectedBuyRequest.status]">
                          {{ buyRequestStatusLabelMap[selectedBuyRequest.status] }}
                        </span>
                      </dd>
                    </div>
                    <div class="rounded-xl border border-neutral-200/70 bg-neutral-50/90 px-2.5 py-2 dark:border-neutral-700/70 dark:bg-neutral-800/70">
                      <dt class="text-neutral-500 dark:text-neutral-400">匹配要求</dt>
                      <dd class="mt-0.5 font-semibold text-neutral-800 dark:text-neutral-100">
                        {{ buyRequestMatchLevelLabelMap[selectedBuyRequest.matchLevel] }}
                        <span v-if="selectedBuyRequest.matchLevel === 'COATING' && selectedBuyRequest.requiredCoating" class="text-[10px] font-normal text-neutral-500 dark:text-neutral-400">
                          · {{ coatingStyleLabelMap[selectedBuyRequest.requiredCoating] }}
                        </span>
                      </dd>
                    </div>
                  </dl>

                  <div v-if="selectedBuyRequest.offeredCards.length > 0" class="space-y-1.5">
                    <span class="text-[10px] font-semibold text-neutral-500 dark:text-neutral-400">提供的卡牌</span>
                    <div class="flex flex-wrap gap-2">
                      <div
                        v-for="oc in selectedBuyRequest.offeredCards"
                        :key="`br-detail-oc-${oc.id}`"
                        class="flex items-center gap-1.5 rounded-lg border border-neutral-200/60 bg-white/70 px-2 py-1 dark:border-neutral-700/60 dark:bg-neutral-800/60"
                      >
                        <img v-if="oc.card.imageUrl" :src="oc.card.imageUrl" class="h-6 w-6 rounded object-cover" loading="lazy" />
                        <span class="max-w-[100px] truncate text-[10px] font-medium text-neutral-700 dark:text-neutral-200">{{ oc.card.title }}</span>
                        <span class="text-[9px] text-neutral-500 dark:text-neutral-400">x{{ oc.quantity }}</span>
                      </div>
                    </div>
                  </div>

                  <div
                    v-if="selectedBuyRequest.status === 'OPEN' && selectedBuyRequest.buyerId !== userId"
                    class="space-y-1.5"
                  >
                    <div class="flex items-center justify-between gap-2">
                      <span class="text-[10px] font-semibold text-neutral-500 dark:text-neutral-400">选择要提供的卡牌</span>
                      <span v-if="buyRequestFulfillCandidates.length > 1" class="text-[10px] text-neutral-500 dark:text-neutral-400">
                        可选 {{ buyRequestFulfillCandidates.length }} 种
                      </span>
                    </div>
                    <p
                      v-if="inventoryLoading && !cardOptions.length"
                      class="text-[11px] text-neutral-500 dark:text-neutral-400"
                    >
                      正在加载你的可交付库存...
                    </p>
                    <div v-else-if="buyRequestFulfillCandidates.length > 0" class="br-fulfill-scroll">
                      <div class="br-fulfill-grid">
                        <button
                          v-for="item in buyRequestFulfillCandidates"
                          :key="`br-fulfill-candidate-${item.stackKey}`"
                          type="button"
                          class="trade-create-card"
                          :class="{ 'trade-create-card--selected': selectedFulfillStackKey === item.stackKey }"
                          @click="selectedFulfillStackKey = item.stackKey"
                        >
                          <GachaCardMini
                            :title="item.title"
                            :rarity="item.rarity"
                            :image-url="item.imageUrl || undefined"
                            :retired="item.isRetired"
                            :affix-visual-style="item.affixVisualStyle"
                            :affix-label="item.affixLabel"
                          >
                            <template #meta>
                              <span class="trade-remaining-chip">可交付 {{ item.availableCount }}</span>
                            </template>
                          </GachaCardMini>
                        </button>
                      </div>
                    </div>
                    <p v-else class="text-[11px] text-neutral-500 dark:text-neutral-400">
                      暂无可直接交付库存，将由系统自动尝试释放符合条件的卡牌。
                    </p>
                  </div>

                </div>
              </div>

              <!-- Sticky action buttons -->
              <div
                v-if="selectedBuyRequest.status === 'OPEN'"
                class="br-detail-actions"
              >
                <UiButton
                  v-if="selectedBuyRequest.buyerId !== userId"
                  class="w-full"
                  :disabled="buyRequestFulfillingId === selectedBuyRequest.id"
                  @click="handleFulfillBuyRequestFromDetail"
                >
                  {{
                    buyRequestFulfillingId === selectedBuyRequest.id
                      ? '接受中...'
                      : buyRequestFulfillCandidates.length > 1
                        ? '选择并接受求购'
                        : '接受求购（出售目标卡）'
                  }}
                </UiButton>

                <UiButton
                  v-if="selectedBuyRequest.buyerId === userId"
                  class="w-full"
                  variant="outline"
                  :disabled="buyRequestCancelId === selectedBuyRequest.id"
                  @click="emit('cancel-buy-request', selectedBuyRequest.id); closeBuyRequestDetail()"
                >
                  {{ buyRequestCancelId === selectedBuyRequest.id ? '取消中...' : '取消求购' }}
                </UiButton>
              </div>
            </div>
          </template>
        </UiDialogContent>
      </UiDialogPortal>
    </UiDialogRoot>
  </section>
</template>

<style scoped>
.trade-sub-tab {
  flex: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  border-radius: 0.5rem;
  padding: 0.4rem 0.75rem;
  font-size: 12px;
  font-weight: 600;
  color: rgb(100 116 139);
  cursor: pointer;
  transition: all 0.15s ease;
  border: none;
  background: transparent;
}

.trade-sub-tab:hover {
  color: rgb(51 65 85);
  background: rgba(255, 255, 255, 0.6);
}

.trade-sub-tab--active {
  background: white;
  color: rgb(15 23 42);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
}

html.dark .trade-sub-tab {
  color: rgb(148 163 184);
}

html.dark .trade-sub-tab:hover {
  color: rgb(226 232 240);
  background: rgba(255, 255, 255, 0.06);
}

html.dark .trade-sub-tab--active {
  background: rgba(30, 41, 59, 0.9);
  color: rgb(241 245 249);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);
}

.trade-sub-tab__badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  border-radius: 999px;
  font-size: 9px;
  font-weight: 700;
  background: rgba(14, 116, 144, 0.12);
  color: rgb(14 116 144);
}

html.dark .trade-sub-tab__badge {
  background: rgba(34, 211, 238, 0.15);
  color: rgb(103 232 249);
}

.trade-create-card {
  position: relative;
  display: block;
  width: 100%;
  min-width: 0;
  border-radius: 0.9rem;
  border: 1px solid rgba(148, 163, 184, 0.24);
  background: rgba(255, 255, 255, 0.72);
  padding: 0.22rem;
  text-align: left;
  cursor: pointer;
  transition: border-color 0.15s ease, box-shadow 0.15s ease, transform 0.15s ease;
}

.trade-create-card:hover {
  border-color: rgba(14, 116, 144, 0.35);
  box-shadow: 0 4px 12px rgba(15, 23, 42, 0.08);
  transform: translateY(-1px);
}

.trade-create-card--selected {
  border-color: rgba(14, 116, 144, 0.55);
  box-shadow:
    0 0 0 4px rgba(14, 116, 144, 0.22),
    0 0 0 1px rgba(14, 116, 144, 0.12),
    0 8px 20px rgba(8, 145, 178, 0.16);
}

html.dark .trade-create-card {
  border-color: rgba(100, 116, 139, 0.45);
  background: rgba(15, 23, 42, 0.62);
}

html.dark .trade-create-card:hover {
  border-color: rgba(34, 211, 238, 0.45);
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.28);
}

html.dark .trade-create-card--selected {
  border-color: rgba(34, 211, 238, 0.62);
  box-shadow:
    0 0 0 4px rgba(34, 211, 238, 0.22),
    0 0 0 1px rgba(34, 211, 238, 0.2),
    0 10px 22px rgba(6, 182, 212, 0.18);
}

.trade-price-chip {
  display: inline-flex;
  align-items: center;
  border-radius: 999px;
  border: 1px solid rgba(245, 158, 11, 0.4);
  background: rgba(245, 158, 11, 0.1);
  color: rgb(180 83 9);
  font-size: 10px;
  font-weight: 700;
  padding: 1px 6px;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

html.dark .trade-price-chip {
  border-color: rgba(251, 191, 36, 0.45);
  background: rgba(245, 158, 11, 0.15);
  color: rgb(252 211 77);
}

.trade-meta-cluster {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
}

.trade-seller-chip {
  display: inline-flex;
  align-items: center;
  border-radius: 999px;
  border: 1px solid rgba(14, 116, 144, 0.3);
  background: rgba(236, 254, 255, 0.8);
  color: rgb(14 116 144);
  font-size: 9px;
  font-weight: 600;
  padding: 1px 6px;
  max-width: 88px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

html.dark .trade-seller-chip {
  border-color: rgba(34, 211, 238, 0.36);
  background: rgba(8, 47, 73, 0.62);
  color: rgb(103 232 249);
}

.trade-remaining-chip {
  display: inline-flex;
  align-items: center;
  border-radius: 999px;
  border: 1px solid rgba(148, 163, 184, 0.35);
  background: rgba(248, 250, 252, 0.8);
  color: rgb(100 116 139);
  font-size: 9px;
  font-weight: 600;
  padding: 1px 5px;
  white-space: nowrap;
}

html.dark .trade-remaining-chip {
  border-color: rgba(100, 116, 139, 0.45);
  background: rgba(15, 23, 42, 0.7);
  color: rgb(148 163 184);
}

.trade-expire-chip {
  display: inline-flex;
  align-items: center;
  border-radius: 999px;
  border: 1px solid rgba(14, 116, 144, 0.28);
  background: rgba(236, 254, 255, 0.72);
  color: rgb(14 116 144);
  font-size: 9px;
  font-weight: 700;
  padding: 1px 5px;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

html.dark .trade-expire-chip {
  border-color: rgba(34, 211, 238, 0.32);
  background: rgba(8, 47, 73, 0.65);
  color: rgb(103 232 249);
}

.trade-create-grid {
  align-items: stretch;
}

/* ── Picker scroll area ── */

.picker-scroll-area {
  max-height: 22rem;
  overflow-y: auto;
  padding-right: 2px;
}

.picker-load-more-btn {
  display: block;
  width: 100%;
  margin-top: 8px;
  padding: 8px 0;
  border-radius: 0.6rem;
  border: 1px solid rgba(14, 116, 144, 0.25);
  background: rgba(236, 254, 255, 0.4);
  color: rgb(14 116 144);
  font-size: 11px;
  font-weight: 600;
  text-align: center;
  cursor: pointer;
  transition: all 0.15s ease;
}

.picker-load-more-btn:hover {
  border-color: rgba(14, 116, 144, 0.45);
  background: rgba(236, 254, 255, 0.7);
  box-shadow: 0 2px 8px rgba(8, 145, 178, 0.08);
}

html.dark .picker-load-more-btn {
  border-color: rgba(34, 211, 238, 0.25);
  background: rgba(8, 47, 73, 0.4);
  color: rgb(103 232 249);
}

html.dark .picker-load-more-btn:hover {
  border-color: rgba(34, 211, 238, 0.45);
  background: rgba(8, 47, 73, 0.6);
}

/* ── Rarity group tags ── */

.picker-rarity-tag {
  display: inline-flex;
  align-items: center;
  border-radius: 999px;
  padding: 1px 7px;
  font-size: 10px;
  font-weight: 600;
  border: 1px solid;
}

.picker-rarity-tag--gold { border-color: rgba(245, 158, 11, 0.35); background: rgba(245, 158, 11, 0.08); color: rgb(180 83 9); }
.picker-rarity-tag--purple { border-color: rgba(124, 58, 237, 0.3); background: rgba(124, 58, 237, 0.06); color: rgb(109 40 217); }
.picker-rarity-tag--blue { border-color: rgba(37, 99, 235, 0.3); background: rgba(37, 99, 235, 0.06); color: rgb(29 78 216); }
.picker-rarity-tag--green { border-color: rgba(5, 150, 105, 0.3); background: rgba(5, 150, 105, 0.06); color: rgb(4 120 87); }
.picker-rarity-tag--white { border-color: rgba(148, 163, 184, 0.35); background: rgba(148, 163, 184, 0.06); color: rgb(100 116 139); }

html.dark .picker-rarity-tag--gold { border-color: rgba(251, 191, 36, 0.4); background: rgba(245, 158, 11, 0.12); color: rgb(252 211 77); }
html.dark .picker-rarity-tag--purple { border-color: rgba(167, 139, 250, 0.4); background: rgba(124, 58, 237, 0.12); color: rgb(196 181 253); }
html.dark .picker-rarity-tag--blue { border-color: rgba(96, 165, 250, 0.4); background: rgba(37, 99, 235, 0.12); color: rgb(147 197 253); }
html.dark .picker-rarity-tag--green { border-color: rgba(52, 211, 153, 0.4); background: rgba(5, 150, 105, 0.12); color: rgb(110 231 183); }
html.dark .picker-rarity-tag--white { border-color: rgba(148, 163, 184, 0.4); background: rgba(148, 163, 184, 0.1); color: rgb(148 163 184); }

.trade-my-grid {
  align-items: stretch;
}

.trade-detail-mini-card {
  width: 100%;
  max-width: 150px;
  margin-inline: auto;
}

.trade-detail-mini-card > * {
  width: 100%;
}

.br-target-pick {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 6px;
  border-radius: 0.5rem;
  border: 1px solid rgba(148, 163, 184, 0.25);
  background: rgba(255, 255, 255, 0.7);
  cursor: pointer;
  text-align: left;
  transition: border-color 0.12s ease, box-shadow 0.12s ease;
  min-width: 0;
}

.br-target-pick:hover {
  border-color: rgba(14, 116, 144, 0.35);
}

.br-target-pick--selected {
  border-color: rgba(14, 116, 144, 0.6);
  box-shadow: 0 0 0 2px rgba(14, 116, 144, 0.18);
}

html.dark .br-target-pick {
  border-color: rgba(100, 116, 139, 0.4);
  background: rgba(15, 23, 42, 0.6);
}

html.dark .br-target-pick:hover {
  border-color: rgba(34, 211, 238, 0.4);
}

html.dark .br-target-pick--selected {
  border-color: rgba(34, 211, 238, 0.6);
  box-shadow: 0 0 0 2px rgba(34, 211, 238, 0.18);
}

.br-target-pick__img {
  width: 28px;
  height: 28px;
  border-radius: 4px;
  object-fit: cover;
  flex-shrink: 0;
}

.br-target-pick__placeholder {
  width: 28px;
  height: 28px;
  border-radius: 4px;
  background: rgba(148, 163, 184, 0.15);
  flex-shrink: 0;
}

.br-target-pick__title {
  font-size: 10px;
  font-weight: 500;
  color: rgb(51 65 85);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}

html.dark .br-target-pick__title {
  color: rgb(226 232 240);
}

/* ── 折叠按钮 ── */

.trade-collapse-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 14px;
  border-radius: 0.75rem;
  border: 1px solid rgba(14, 116, 144, 0.3);
  background: rgba(236, 254, 255, 0.5);
  color: rgb(14 116 144);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s ease;
}

.trade-collapse-toggle:hover {
  border-color: rgba(14, 116, 144, 0.5);
  background: rgba(236, 254, 255, 0.8);
  box-shadow: 0 2px 8px rgba(8, 145, 178, 0.1);
}

html.dark .trade-collapse-toggle {
  border-color: rgba(34, 211, 238, 0.3);
  background: rgba(8, 47, 73, 0.5);
  color: rgb(103 232 249);
}

html.dark .trade-collapse-toggle:hover {
  border-color: rgba(34, 211, 238, 0.5);
  background: rgba(8, 47, 73, 0.7);
}

.trade-collapse-toggle__icon {
  display: inline-block;
  font-size: 10px;
  transition: transform 0.2s ease;
}

.trade-collapse-toggle__icon--open {
  transform: rotate(180deg);
}

/* ── 折叠过渡 ── */

.trade-collapse-enter-active,
.trade-collapse-leave-active {
  transition: all 0.25s ease;
  overflow: hidden;
}

.trade-collapse-enter-from,
.trade-collapse-leave-to {
  opacity: 0;
  max-height: 0;
  margin-top: 0;
}

.trade-collapse-enter-to,
.trade-collapse-leave-from {
  opacity: 1;
  max-height: 2000px;
}

/* ── 横向行布局：左 MiniCard + 右信息 ── */

.gacha-trade-item-grid {
  display: grid;
  gap: 8px;
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.trade-item-row {
  display: flex;
  align-items: stretch;
  gap: 8px;
  padding: 6px;
  border-radius: 0.85rem;
  border: 1px solid rgba(148, 163, 184, 0.22);
  background: rgba(255, 255, 255, 0.6);
  cursor: pointer;
  text-align: left;
  transition: border-color 0.15s ease, box-shadow 0.15s ease, transform 0.12s ease;
  min-width: 0;
  content-visibility: auto;
  contain-intrinsic-size: auto 80px;
}

.trade-item-row:hover {
  border-color: rgba(14, 116, 144, 0.4);
  box-shadow: 0 4px 14px rgba(15, 23, 42, 0.08);
  transform: translateY(-1px);
}

html.dark .trade-item-row {
  border-color: rgba(100, 116, 139, 0.35);
  background: rgba(15, 23, 42, 0.5);
}

html.dark .trade-item-row:hover {
  border-color: rgba(34, 211, 238, 0.45);
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.3);
}

.trade-item-row__card {
  flex: 0 0 72px;
  min-width: 0;
}

.trade-item-row__card > * {
  width: 100%;
  height: 100%;
}

.trade-item-row__info {
  flex: 1;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 3px;
  min-width: 0;
  padding: 2px 0;
}

.trade-item-row__user {
  font-size: 11px;
  font-weight: 600;
  color: rgb(14 116 144);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

html.dark .trade-item-row__user {
  color: rgb(103 232 249);
}

.trade-item-row__price {
  font-size: 12px;
  font-weight: 700;
  color: rgb(180 83 9);
  font-variant-numeric: tabular-nums;
}

html.dark .trade-item-row__price {
  color: rgb(252 211 77);
}

.trade-item-row__qty {
  font-size: 10px;
  font-weight: 500;
  color: rgb(100 116 139);
}

html.dark .trade-item-row__qty {
  color: rgb(148 163 184);
}

.trade-item-row__time {
  font-size: 10px;
  font-weight: 600;
  color: rgb(71 85 105);
  font-variant-numeric: tabular-nums;
}

html.dark .trade-item-row__time {
  color: rgb(148 163 184);
}

/* ── Fulfillable row highlight ── */

.trade-item-row--fulfillable {
  border-color: rgba(16, 185, 129, 0.35);
  background: rgba(16, 185, 129, 0.05);
}

.trade-item-row--fulfillable:hover {
  border-color: rgba(16, 185, 129, 0.55);
  box-shadow: 0 4px 14px rgba(16, 185, 129, 0.12);
}

html.dark .trade-item-row--fulfillable {
  border-color: rgba(52, 211, 153, 0.3);
  background: rgba(16, 185, 129, 0.06);
}

html.dark .trade-item-row--fulfillable:hover {
  border-color: rgba(52, 211, 153, 0.5);
  box-shadow: 0 4px 14px rgba(16, 185, 129, 0.15);
}

/* ── Fulfillable badge (prominent) ── */

.trade-item-row__fulfillable-badge {
  display: inline-flex;
  align-self: flex-start;
  align-items: center;
  gap: 3px;
  border-radius: 999px;
  border: 1px solid rgba(16, 185, 129, 0.5);
  background: rgba(16, 185, 129, 0.12);
  color: rgb(5 150 105);
  font-size: 10px;
  font-weight: 700;
  padding: 2px 8px;
  white-space: nowrap;
}

html.dark .trade-item-row__fulfillable-badge {
  border-color: rgba(52, 211, 153, 0.5);
  background: rgba(16, 185, 129, 0.18);
  color: rgb(110 231 183);
}

/* ── Header fulfillable count badge ── */

.br-fulfillable-header-badge {
  display: inline-flex;
  align-items: center;
  margin-left: 6px;
  border-radius: 999px;
  border: 1px solid rgba(16, 185, 129, 0.4);
  background: rgba(16, 185, 129, 0.1);
  color: rgb(5 150 105);
  font-size: 10px;
  font-weight: 700;
  padding: 1px 7px;
}

html.dark .br-fulfillable-header-badge {
  border-color: rgba(52, 211, 153, 0.4);
  background: rgba(16, 185, 129, 0.15);
  color: rgb(110 231 183);
}

/* ── Fulfillable filter toggle ── */

.br-fulfillable-toggle {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 5px 12px;
  border-radius: 0.6rem;
  border: 1px solid rgba(16, 185, 129, 0.3);
  background: rgba(16, 185, 129, 0.06);
  color: rgb(5 150 105);
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s ease;
}

.br-fulfillable-toggle:hover {
  border-color: rgba(16, 185, 129, 0.5);
  background: rgba(16, 185, 129, 0.12);
}

.br-fulfillable-toggle--active {
  border-color: rgba(16, 185, 129, 0.6);
  background: rgba(16, 185, 129, 0.15);
  box-shadow: 0 0 0 2px rgba(16, 185, 129, 0.12);
}

html.dark .br-fulfillable-toggle {
  border-color: rgba(52, 211, 153, 0.3);
  background: rgba(16, 185, 129, 0.08);
  color: rgb(110 231 183);
}

html.dark .br-fulfillable-toggle:hover {
  border-color: rgba(52, 211, 153, 0.5);
  background: rgba(16, 185, 129, 0.15);
}

html.dark .br-fulfillable-toggle--active {
  border-color: rgba(52, 211, 153, 0.6);
  background: rgba(16, 185, 129, 0.2);
  box-shadow: 0 0 0 2px rgba(52, 211, 153, 0.12);
}

.br-fulfillable-toggle__icon {
  width: 12px;
  height: 12px;
}

.br-match-btn {
  display: inline-flex;
  align-items: center;
  padding: 4px 10px;
  border-radius: 0.5rem;
  border: 1px solid rgba(148, 163, 184, 0.3);
  background: rgba(255, 255, 255, 0.7);
  color: rgb(100 116 139);
  font-size: 11px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s ease;
}

.br-match-btn:hover {
  border-color: rgba(14, 116, 144, 0.4);
  color: rgb(14 116 144);
}

.br-match-btn--active {
  border-color: rgba(14, 116, 144, 0.6);
  background: rgba(14, 116, 144, 0.08);
  color: rgb(14 116 144);
  font-weight: 600;
  box-shadow: 0 0 0 2px rgba(14, 116, 144, 0.12);
}

html.dark .br-match-btn {
  border-color: rgba(100, 116, 139, 0.4);
  background: rgba(15, 23, 42, 0.6);
  color: rgb(148 163 184);
}

html.dark .br-match-btn:hover {
  border-color: rgba(34, 211, 238, 0.4);
  color: rgb(103 232 249);
}

html.dark .br-match-btn--active {
  border-color: rgba(34, 211, 238, 0.6);
  background: rgba(34, 211, 238, 0.1);
  color: rgb(103 232 249);
  box-shadow: 0 0 0 2px rgba(34, 211, 238, 0.12);
}

.br-match-chip {
  display: inline-flex;
  align-items: center;
  border-radius: 999px;
  border: 1px solid rgba(139, 92, 246, 0.3);
  background: rgba(139, 92, 246, 0.08);
  color: rgb(139 92 246);
  font-size: 8px;
  font-weight: 700;
  padding: 0px 4px;
  white-space: nowrap;
}

html.dark .br-match-chip {
  border-color: rgba(167, 139, 250, 0.35);
  background: rgba(139, 92, 246, 0.15);
  color: rgb(196 181 253);
}

@media (min-width: 640px) {
  .gacha-trade-item-grid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}

@media (min-width: 1024px) {
  .gacha-trade-item-grid {
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }
}

@media (min-width: 1440px) {
  .gacha-trade-item-grid {
    grid-template-columns: repeat(5, minmax(0, 1fr));
  }
}

/* ── Buy-request detail dialog ── */

.br-detail-body {
  max-height: calc(100vh - 7rem);
  max-height: calc(100dvh - 7rem);
  overflow-y: auto;
  padding: 1rem 1.25rem 1.25rem;
}

.br-detail-layout {
  display: grid;
  gap: 12px;
  grid-template-columns: 100px minmax(0, 1fr);
  align-items: start;
}

@media (min-width: 640px) {
  .br-detail-layout {
    gap: 16px;
    grid-template-columns: 160px minmax(0, 1fr);
  }
}

.br-detail-card {
  width: 100%;
}

.br-detail-card > * {
  width: 100%;
}

.br-detail-stats {
  display: grid;
  gap: 6px;
  grid-template-columns: 1fr;
  font-size: 12px;
}

@media (min-width: 640px) {
  .br-detail-stats {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px;
  }
}

.br-detail-actions {
  position: sticky;
  bottom: 0;
  padding-top: 12px;
  background: linear-gradient(to bottom, transparent, var(--g-surface-card) 6px);
}

html.dark .br-detail-actions {
  background: linear-gradient(to bottom, transparent, rgba(23, 23, 23, 0.97) 6px);
}

.br-fulfill-scroll {
  max-height: 14rem;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding-right: 2px;
}

.br-fulfill-grid {
  display: grid;
  gap: 8px;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  align-items: stretch;
}

.br-fulfill-grid > * {
  display: flex;
  height: 100%;
  width: 100%;
  min-width: 0;
}

.br-fulfill-grid > * > * {
  width: 100%;
  height: 100%;
}

@media (min-width: 640px) {
  .br-fulfill-grid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}
</style>
