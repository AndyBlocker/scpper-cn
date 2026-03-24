<script setup lang="ts">
import type { AffixVisualStyle, Rarity, TradeListing, BuyRequest } from '~/types/gacha'
import { formatTokens, formatDateCompact } from '~/utils/gachaFormatters'
import { rarityLabel } from '~/utils/gachaRarity'
import { resolveAffixParts } from '~/utils/gachaAffix'
import { tradeStatusLabelMap, tradeStatusChipClassMap, buyRequestStatusLabelMap, buyRequestStatusChipClassMap, buyRequestMatchLevelLabelMap, buyRequestMatchLevelShortMap, coatingStyleLabelMap } from '~/utils/gachaConstants'
import GachaAffixChip from '~/components/gacha/GachaAffixChip.vue'
import GachaCard from '~/components/gacha/GachaCard.vue'
import GachaCardMini from '~/components/gacha/GachaCardMini.vue'
import { UiButton } from '~/components/ui/button'
import {
  UiDialogRoot,
  UiDialogPortal,
  UiDialogOverlay,
  UiDialogContent,
  UiDialogClose
} from '~/components/ui/dialog'

interface TradeCardOption {
  stackKey: string
  cardId: string
  title: string
  rarity: Rarity
  imageUrl: string | null
  isRetired?: boolean
  availableCount: number
  affixSignature?: string
  affixVisualStyle?: AffixVisualStyle
  affixLabel?: string
}

defineProps<{
  // My listing dialog
  selectedMyListing: TradeListing | null
  cancellingId: string | null
  // Public listing dialog
  selectedPublicListing: TradeListing | null
  buyingId: string | null
  userId: string | null
  // Buy request dialog
  selectedBuyRequest: BuyRequest | null
  buyRequestFulfillCandidates: TradeCardOption[]
  selectedFulfillStackKey: string
  buyRequestFulfillingId: string | null
  buyRequestCancelId: string | null
  inventoryLoading: boolean
  cardOptionsLength: number
}>()

const emit = defineEmits<{
  'close-my-listing': []
  'close-public-listing': []
  'close-buy-request': []
  'cancel-listing': [id: string]
  'buy-listing': [id: string]
  'update:selectedFulfillStackKey': [val: string]
  'fulfill-buy-request': []
  'cancel-buy-request': [id: string]
}>()

function tradeStatusLabel(status: TradeListing['status']) {
  return tradeStatusLabelMap[status] || status
}

function listingTotalPrice(listing: TradeListing) {
  return Math.max(0, Number(listing.remaining || 0)) * Math.max(0, Number(listing.unitPrice || 0))
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
</script>

<template>
  <!-- 我的挂牌详情弹窗 -->
  <UiDialogRoot :open="!!selectedMyListing" @update:open="(v: boolean) => { if (!v) emit('close-my-listing') }">
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
                  @click="emit('cancel-listing', selectedMyListing.id); emit('close-my-listing')"
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

  <!-- 公共挂牌详情弹窗 -->
  <UiDialogRoot :open="!!selectedPublicListing" @update:open="(v: boolean) => { if (!v) emit('close-public-listing') }">
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
                  @click="emit('buy-listing', selectedPublicListing.id); emit('close-public-listing')"
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
  <UiDialogRoot :open="!!selectedBuyRequest" @update:open="(v: boolean) => { if (!v) emit('close-buy-request') }">
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
                    v-if="inventoryLoading && !cardOptionsLength"
                    class="text-[11px] text-neutral-500 dark:text-neutral-400"
                  >
                    正在加载你的可交付库存...
                  </p>
                  <div v-else-if="buyRequestFulfillCandidates.length > 0" class="br-fulfill-grid">
                    <button
                      v-for="item in buyRequestFulfillCandidates"
                      :key="`br-fulfill-candidate-${item.stackKey}`"
                      type="button"
                      class="trade-create-card"
                      :class="{ 'trade-create-card--selected': selectedFulfillStackKey === item.stackKey }"
                      @click="emit('update:selectedFulfillStackKey', item.stackKey)"
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
                @click="emit('fulfill-buy-request')"
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
                @click="emit('cancel-buy-request', selectedBuyRequest.id); emit('close-buy-request')"
              >
                {{ buyRequestCancelId === selectedBuyRequest.id ? '取消中...' : '取消求购' }}
              </UiButton>
            </div>
          </div>
        </template>
      </UiDialogContent>
    </UiDialogPortal>
  </UiDialogRoot>
</template>
