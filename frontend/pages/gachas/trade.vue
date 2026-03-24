<template>
  <GachaPageShell
    :auth-pending="authPending"
    :show-binding-block="showBindingBlock"
    :wallet-balance="walletBalance"
    feature-name="交易"
    page="trade"
  >
    <div class="gacha-page-flow">
      <GachaErrorBanner :error="errorBanner" />

      <Transition name="fade" mode="out-in">
        <GachaActivationBlock
          v-if="!activated"
          key="trade-activation"
          :activating="activating"
          :activation-error="activationError"
          @activate="onActivate"
        />

        <div v-else key="trade-main" class="gacha-page-flow gacha-page-enter">
          <section class="gacha-kpi-grid">
            <GachaMetricCard label="我的进行中" :value="myOpenTradeCount" tone="accent" />
            <GachaMetricCard label="公共挂牌" :value="tradePublicTotal" />
            <GachaMetricCard label="可上架卡种" :value="tradeCardTypeCount" />
            <GachaMetricCard label="活跃卖家" :value="activeSellerCount" />
          </section>

          <GachaTradePanel
            :card-options="tradeCardOptionsForPanel"
            :owned-card-ids="ownedCardIds"
            :public-listings="publicTradeListings"
            :my-listings="myTradeListings"
            :loading="tradePanelLoading"
            :inventory-loading="placementOptionsLoading"
            :submitting="tradeSubmitting"
            :buying-id="tradeBuyingId"
            :cancelling-id="tradeCancelId"
            :public-total="tradePublicTotal"
            :public-has-more="tradePublicHasMore"
            :public-loading-more="tradePublicLoadingMore"
            :user-id="user?.id ?? null"
            :public-buy-requests="publicBuyRequests"
            :my-buy-requests="myBuyRequests"
            :page-catalog="cardCatalog"
            :buy-request-loading="buyRequestLoading"
            :buy-request-submitting="buyRequestSubmitting"
            :buy-request-fulfilling-id="buyRequestFulfillingId"
            :buy-request-cancel-id="buyRequestCancelId"
            :buy-request-public-total="buyRequestPublicTotal"
            :buy-request-public-has-more="buyRequestPublicHasMore"
            :buy-request-public-loading-more="buyRequestPublicLoadingMore"
            :my-open-buy-request-count="myOpenBuyRequestCount"
            @refresh="refreshTradePanel"
            @create="requestCreateTradeListing"
            @buy="requestBuyTradeListing"
            @cancel="handleCancelTradeListingById"
            @load-more="loadMorePublicTradeListings"
            @trade-page-change="loadPublicTradePage"
            @query-change="setPublicTradeQuery"
            @create-buy-request="requestCreateBuyRequest"
            @fulfill-buy-request="requestFulfillBuyRequest"
            @cancel-buy-request="handleCancelBuyRequest"
            @buy-request-load-more="loadMorePublicBuyRequests"
            @buy-request-page-change="loadPublicBuyRequestPage"
            @buy-request-query-change="setBuyRequestQuery"
            @refresh-buy-requests="refreshBuyRequestPanel"
            @request-inventory="handleRequestInventory"
            @request-catalog="handleRequestCatalog"
          />
        </div>
      </Transition>
    </div>
  </GachaPageShell>

  <!-- Buy Confirmation Dialog -->
  <GachaConfirmDialog
    :open="!!pendingBuyListing"
    title="确认购买"
    description="请确认以下交易信息。购买后 Token 将立即扣除。"
    confirm-text="确认购买"
    :busy="!!tradeBuyingId"
    :details="buyConfirmDetails"
    @confirm="confirmBuyTradeListing"
    @cancel="pendingBuyListing = null"
  />

  <!-- Create Listing Confirmation Dialog -->
  <GachaConfirmDialog
    :open="!!pendingCreatePayload"
    title="确认挂牌"
    description="请确认以下挂牌信息。确认后卡片会立即进入市场。"
    confirm-text="确认挂牌"
    :busy="tradeSubmitting"
    :details="createConfirmDetails"
    @confirm="confirmCreateTradeListing"
    @cancel="pendingCreatePayload = null"
  />

  <!-- Create Buy Request Confirmation Dialog -->
  <GachaConfirmDialog
    :open="pendingBuyRequestPayloads.length > 0"
    title="确认发布求购"
    :description="pendingBuyRequestPayloads.length > 1 ? `将创建 ${pendingBuyRequestPayloads.length} 个求购，每个的 Token/卡牌出价相同。` : '确认后 Token 将立即托管扣除，提供的卡牌也会被锁定。'"
    confirm-text="确认求购"
    :busy="buyRequestSubmitting"
    :details="buyRequestCreateConfirmDetails"
    @confirm="confirmCreateBuyRequest"
    @cancel="pendingBuyRequestPayloads = []"
  />

  <!-- Fulfill Buy Request Confirmation Dialog -->
  <GachaConfirmDialog
    :open="!!pendingFulfillBuyRequest"
    title="确认接受求购"
    description="你将出售目标卡片并获得买方的出价。"
    confirm-text="确认接受"
    :busy="!!buyRequestFulfillingId"
    :details="fulfillBuyRequestConfirmDetails"
    @confirm="confirmFulfillBuyRequest"
    @cancel="pendingFulfillBuyRequest = null"
  />
</template>

<script setup lang="ts">
import { computed, ref, onBeforeUnmount } from 'vue'

useHead({ title: '扭蛋 - 交易' })

import GachaPageShell from '~/components/gacha/GachaPageShell.vue'
import GachaErrorBanner from '~/components/gacha/GachaErrorBanner.vue'
import GachaActivationBlock from '~/components/gacha/GachaActivationBlock.vue'
import GachaMetricCard from '~/components/gacha/GachaMetricCard.vue'
import GachaTradePanel from '~/components/gacha/GachaTradePanel.vue'
import GachaConfirmDialog from '~/components/gacha/GachaConfirmDialog.vue'
import { useGachaPage } from '~/composables/useGachaPage'
import { useGachaTrade } from '~/composables/useGachaTrade'
import { useGachaPageLifecycle } from '~/composables/useGachaPageLifecycle'
import { formatTokens } from '~/utils/gachaFormatters'
import { rarityLabel } from '~/utils/gachaRarity'
import { buyRequestMatchLevelLabelMap, coatingStyleLabelMap } from '~/utils/gachaConstants'
import type { TradeListing, BuyRequest, BuyRequestMatchLevel, AffixVisualStyle } from '~/types/gacha'

interface TradeCreatePayload {
  cardId: string
  affixSignature?: string
  quantity: number
  unitPrice: number
  expiresHours: number
}

interface BuyRequestCreatePayload {
  targetCardId: string
  matchLevel: BuyRequestMatchLevel
  requiredCoating?: AffixVisualStyle
  tokenOffer: number
  offeredCards: Array<{ cardId: string; affixSignature?: string; quantity: number }>
  expiresHours: number
}

interface BuyRequestFulfillPayload {
  buyRequestId: string
  selectedCardId?: string
  selectedAffixSignature?: string
}

const page = useGachaPage({ pageName: 'trade' })
const {
  authPending, showBindingBlock,
  errorBanner, activated, activating, activationError,
  user, handleActivate
} = page

const idx = useGachaTrade(page)
const {
  placement, history,
  tradeCardOptionsForPanel, publicTradeListings, myTradeListings,
  tradeLoading, tradeSubmitting, tradeBuyingId, tradeCancelId, placementOptionsLoading,
  tradePublicTotal, tradePublicHasMore, tradePublicLoadingMore,
  tradePublicQueryLoading,
  tradeListings,
  ownedCardIds,
  placementOptions,
  refreshTradePanel, handleCreateTradeListingFromPanel,
  handleBuyTradeListingById, handleCancelTradeListingById,
  setPublicTradeQuery,
  refreshPlacementOptions,
  loadMorePublicTradeListings,
  loadPublicTradePage,
  loadInitial,
  // Buy Request
  publicBuyRequests, myBuyRequests, cardCatalog,
  buyRequestLoading, buyRequestSubmitting,
  buyRequestFulfillingId, buyRequestCancelId,
  buyRequestPublicTotal, buyRequestPublicHasMore, buyRequestPublicLoadingMore,
  myOpenBuyRequestCount,
  refreshBuyRequestPanel, loadMorePublicBuyRequests,
  loadPublicBuyRequestPage,
  setBuyRequestQuery,
  handleCreateBuyRequest, handleFulfillBuyRequest, handleCancelBuyRequest,
  // Lazy-load helpers
  refreshOwnedCardIds, refreshCardCatalog,
  cleanup: cleanupTrade
} = idx

onBeforeUnmount(() => {
  cleanupTrade()
})

const tradePanelLoading = computed(() => tradeLoading.value || tradePublicQueryLoading.value)

const myOpenTradeCount = computed(() =>
  myTradeListings.value.filter((listing) => listing.status === 'OPEN' && listing.remaining > 0).length
)
const tradeCardTypeCount = computed(() => tradeCardOptionsForPanel.value.length)
const activeSellerCount = computed(() => {
  const set = new Set<string>()
  publicTradeListings.value.forEach((listing) => {
    if (listing.status === 'OPEN' && listing.remaining > 0) {
      set.add(listing.sellerId)
    }
  })
  return set.size
})

// ─── Buy Confirmation ─────────────────────────────
const pendingBuyListing = ref<TradeListing | null>(null)
const pendingCreatePayload = ref<TradeCreatePayload | null>(null)
const pendingBuyRequestPayloads = ref<BuyRequestCreatePayload[]>([])
const pendingFulfillBuyRequest = ref<BuyRequestFulfillPayload | null>(null)

const buyConfirmDetails = computed(() => {
  if (!pendingBuyListing.value) return []
  const listing = pendingBuyListing.value

  // 检查完全相同的 cardId（同画面）
  const sameCardItems = placementOptions.value.filter((item) => item.cardId === listing.cardId)
  const sameCardCount = sameCardItems.reduce((sum, item) => sum + Math.max(0, item.count), 0)

  // 检查同 pageId 但不同 cardId（同页面不同画面）
  const listingPageId = listing.card.pageId
  const samePageOtherVariants = listingPageId != null
    ? placementOptions.value.filter((item) => item.pageId === listingPageId && item.cardId !== listing.cardId)
    : []
  const samePageOtherCount = samePageOtherVariants.reduce((sum, item) => sum + Math.max(0, item.count), 0)

  const rows: Array<{ label: string; value: string | number; warn?: boolean }> = [
    { label: '卡牌', value: listing.card.title },
    { label: '稀有度', value: rarityLabel(listing.card.rarity) },
    { label: '卖家', value: listing.seller.displayName || listing.sellerId.slice(0, 8) },
    { label: '数量', value: `${listing.remaining} 张` },
    { label: '单价', value: `${formatTokens(listing.unitPrice)} T` },
    { label: '总价', value: `${formatTokens(listing.remaining * listing.unitPrice)} T` }
  ]

  if (sameCardCount > 0) {
    rows.push({ label: '已有同画面', value: `${sameCardCount} 张`, warn: true })
  }
  if (samePageOtherCount > 0) {
    rows.push({ label: '已有同页面异画', value: `${samePageOtherCount} 张`, warn: true })
  }

  return rows
})

const pendingCreateCardOption = computed(() => {
  if (!pendingCreatePayload.value) return null
  const targetSignature = pendingCreatePayload.value.affixSignature || 'NONE'
  return tradeCardOptionsForPanel.value.find((item) => (
    item.cardId === pendingCreatePayload.value?.cardId
    && (item.affixSignature || 'NONE') === targetSignature
  )) ?? null
})

const createConfirmDetails = computed(() => {
  if (!pendingCreatePayload.value) return []
  const payload = pendingCreatePayload.value
  const quantity = Math.max(1, Number(payload.quantity || 1))
  const unitPrice = Math.max(1, Number(payload.unitPrice || 1))
  const expiresHours = Math.max(1, Number(payload.expiresHours || 1))
  const rows: Array<{ label: string; value: string | number }> = [
    { label: '卡牌', value: pendingCreateCardOption.value?.title || payload.cardId },
    { label: '稀有度', value: pendingCreateCardOption.value ? rarityLabel(pendingCreateCardOption.value.rarity) : '未知' },
    { label: '词条', value: pendingCreateCardOption.value?.affixSignature || payload.affixSignature || 'NONE' },
    { label: '数量', value: `${quantity} 张` },
    { label: '单价', value: `${formatTokens(unitPrice)} T` },
    { label: '总价', value: `${formatTokens(quantity * unitPrice)} T` },
    { label: '有效期', value: `${expiresHours} 小时` }
  ]
  if (pendingCreateCardOption.value) {
    rows.push({ label: '当前可上架', value: `${pendingCreateCardOption.value.availableCount} 张` })
  }
  return rows
})

function requestBuyTradeListing(listingId: string) {
  const listing = [...tradeListings.value, ...publicTradeListings.value].find((l) => l.id === listingId)
  if (listing) {
    pendingBuyListing.value = listing
  }
}

function requestCreateTradeListing(payload: TradeCreatePayload) {
  pendingCreatePayload.value = {
    cardId: payload.cardId,
    affixSignature: payload.affixSignature || undefined,
    quantity: Math.max(1, Number(payload.quantity || 1)),
    unitPrice: Math.max(1, Number(payload.unitPrice || 1)),
    expiresHours: Math.max(1, Number(payload.expiresHours || 1))
  }
}

async function confirmBuyTradeListing() {
  if (!pendingBuyListing.value) return
  const id = pendingBuyListing.value.id
  pendingBuyListing.value = null
  await handleBuyTradeListingById(id)
}

async function confirmCreateTradeListing() {
  if (!pendingCreatePayload.value) return
  const payload = pendingCreatePayload.value
  pendingCreatePayload.value = null
  await handleCreateTradeListingFromPanel(payload)
}

function requestCreateBuyRequest(payloads: BuyRequestCreatePayload[]) {
  pendingBuyRequestPayloads.value = payloads
}

async function confirmCreateBuyRequest() {
  if (!pendingBuyRequestPayloads.value.length) return
  const payloads = [...pendingBuyRequestPayloads.value]
  pendingBuyRequestPayloads.value = []
  for (const payload of payloads) {
    await handleCreateBuyRequest(payload)
  }
}

function requestFulfillBuyRequest(payload: BuyRequestFulfillPayload) {
  pendingFulfillBuyRequest.value = payload
}

async function confirmFulfillBuyRequest() {
  if (!pendingFulfillBuyRequest.value) return
  const payload = pendingFulfillBuyRequest.value
  pendingFulfillBuyRequest.value = null
  await handleFulfillBuyRequest(payload.buyRequestId, {
    selectedCardId: payload.selectedCardId,
    selectedAffixSignature: payload.selectedAffixSignature
  })
}

const buyRequestCreateConfirmDetails = computed(() => {
  if (!pendingBuyRequestPayloads.value.length) return []
  const payloads = pendingBuyRequestPayloads.value
  const first = payloads[0]!
  const targetPage = cardCatalog.value.find((p) => p.variants.some((v) => v.id === first.targetCardId))
  const matchLabel = buyRequestMatchLevelLabelMap[first.matchLevel] ?? first.matchLevel
  const rows: Array<{ label: string; value: string | number }> = [
    { label: '目标页面', value: targetPage?.title || first.targetCardId },
    { label: '求购数量', value: payloads.length > 1 ? `${payloads.length} 个求购` : '1 个求购' },
    { label: '匹配要求', value: first.matchLevel === 'COATING' && first.requiredCoating ? `${matchLabel} · ${coatingStyleLabelMap[first.requiredCoating] ?? first.requiredCoating}` : matchLabel },
    { label: '每个出价', value: first.tokenOffer > 0 ? `${formatTokens(first.tokenOffer)} T` : '无' }
  ]
  if (payloads.length > 1 && first.tokenOffer > 0) {
    rows.push({ label: '总计 Token', value: `${formatTokens(first.tokenOffer * payloads.length)} T` })
  }
  if (first.offeredCards.length > 0) {
    rows.push({ label: '每个提供卡牌', value: `${first.offeredCards.length} 种` })
  }
  rows.push({ label: '有效期', value: `${first.expiresHours} 小时` })
  return rows
})

const fulfillBuyRequestConfirmDetails = computed(() => {
  if (!pendingFulfillBuyRequest.value) return []
  const br = [...publicBuyRequests.value, ...myBuyRequests.value].find((b) => b.id === pendingFulfillBuyRequest.value?.buyRequestId)
  if (!br) return []
  const matchLabel = buyRequestMatchLevelLabelMap[br.matchLevel] ?? br.matchLevel
  const rows: Array<{ label: string; value: string | number }> = [
    { label: '目标卡片', value: br.targetCard.title },
    { label: '买家', value: br.buyer.displayName || br.buyerId.slice(0, 8) },
    { label: '匹配要求', value: br.matchLevel === 'COATING' && br.requiredCoating ? `${matchLabel} · ${coatingStyleLabelMap[br.requiredCoating] ?? br.requiredCoating}` : matchLabel },
    { label: 'Token 报酬', value: br.tokenOffer > 0 ? `${formatTokens(br.tokenOffer)} T` : '无' },
    { label: '获得卡牌', value: br.offeredCards.length > 0 ? `${br.offeredCards.length} 种` : '无' }
  ]
  if (pendingFulfillBuyRequest.value.selectedCardId) {
    rows.push({ label: '出售卡牌ID', value: pendingFulfillBuyRequest.value.selectedCardId })
  }
  if (pendingFulfillBuyRequest.value.selectedAffixSignature) {
    rows.push({ label: '出售词条', value: pendingFulfillBuyRequest.value.selectedAffixSignature })
  }
  return rows
})

const { walletBalance, onActivate } = useGachaPageLifecycle({
  page: {
    showBindingBlock,
    handleActivate,
    gacha: page.gacha
  },
  tag: 'gacha-trade',
  loadInitial,
  afterLoad: async () => {
    // Lightweight initial load: skip full inventory and catalog, use ownedCardIds endpoint instead
    await Promise.allSettled([
      refreshTradePanel({ syncInventory: false, resetPublic: true }),
      refreshOwnedCardIds(),
      refreshBuyRequestPanel({ resetPublic: true, loadCatalog: false })
    ])
  }
})

// Lazy-load full inventory when the create-listing form opens
function handleRequestInventory() {
  if (placementOptions.value.length === 0 && !placementOptionsLoading.value) {
    void refreshPlacementOptions()
  }
}

// Lazy-load card catalog when the buy-request form opens
function handleRequestCatalog() {
  if (cardCatalog.value.length === 0) {
    void refreshCardCatalog()
  }
}
</script>
