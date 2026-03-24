<script setup lang="ts">
import type { Rarity, TradeListing } from '~/types/gacha'
import { formatTokens, formatDateCompact } from '~/utils/gachaFormatters'
import { rarityLabel } from '~/utils/gachaRarity'
import { tradeStatusLabelMap, tradeStatusChipClassMap } from '~/utils/gachaConstants'
import GachaCardMini from '~/components/gacha/GachaCardMini.vue'
import GachaRarityFilter from '~/components/gacha/GachaRarityFilter.vue'
import GachaPagination from '~/components/gacha/GachaPagination.vue'
import { UiButton } from '~/components/ui/button'
import { UiInput } from '~/components/ui/input'
import { UiSelectRoot, UiSelectTrigger, UiSelectContent, UiSelectItem } from '~/components/ui/select'

type TradeSortMode = 'LATEST' | 'PRICE_ASC' | 'PRICE_DESC' | 'TOTAL_ASC' | 'TOTAL_DESC' | 'RARITY_DESC'

defineProps<{
  publicListings: TradeListing[]
  publicTotal: number
  loading: boolean
  publicLoadingMore: boolean
  tradeSearch: string
  tradeSearchMode: 'ALL' | 'CARD' | 'SELLER'
  tradeSortMode: TradeSortMode
  tradeRarityFilter: Rarity | 'ALL'
  tradeRarityFilterOptions: Array<Rarity | 'ALL'>
  tradePublicPage: number
  pageSize: number
  clientNow: number | null
  userId: string | null
}>()

const emit = defineEmits<{
  'update:tradeSearch': [val: string]
  'update:tradeSearchMode': [val: 'ALL' | 'CARD' | 'SELLER']
  'update:tradeSortMode': [val: TradeSortMode]
  'update:tradeRarityFilter': [val: Rarity | 'ALL']
  'reset-filters': []
  'open-listing-detail': [listing: TradeListing]
  'trade-page-change': [page: number]
}>()

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

function listingRemainingLabel(listing: TradeListing, now: number | null) {
  if (listing.status !== 'OPEN' || listing.remaining <= 0) return tradeStatusLabelMap[listing.status] || listing.status
  if (!listing.expiresAt) return '无期限'
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
</script>

<template>
  <div class="space-y-4">
    <!-- 搜索 / 排序 -->
    <div class="grid gap-2 md:grid-cols-[minmax(0,1fr),minmax(160px,200px),minmax(180px,230px),auto]">
      <UiInput
        :model-value="tradeSearch"
        type="search"
        placeholder="搜索卡片名 / 标签 / 作者 / 卖家"
        class="w-full"
        @update:model-value="emit('update:tradeSearch', String($event))"
      />
      <UiSelectRoot :model-value="tradeSearchMode" @update:model-value="emit('update:tradeSearchMode', $event as any)">
        <UiSelectTrigger placeholder="搜索模式" />
        <UiSelectContent>
          <UiSelectItem value="ALL">全字段搜索</UiSelectItem>
          <UiSelectItem value="CARD">仅卡片</UiSelectItem>
          <UiSelectItem value="SELLER">仅卖家</UiSelectItem>
        </UiSelectContent>
      </UiSelectRoot>
      <UiSelectRoot :model-value="tradeSortMode" @update:model-value="emit('update:tradeSortMode', $event as any)">
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
      <UiButton variant="outline" class="h-9" @click="emit('reset-filters')">重置</UiButton>
    </div>

    <div class="mt-2">
      <GachaRarityFilter
        :model-value="tradeRarityFilter"
        :options="tradeRarityFilterOptions"
        all-label="全部品质"
        @update:model-value="emit('update:tradeRarityFilter', $event as any)"
      />
    </div>

    <p class="mt-2 text-[11px] text-neutral-500 dark:text-neutral-400">
      显示 {{ publicListings.length }} / {{ publicTotal }} 条
    </p>

    <p v-if="!publicListings.length" class="gacha-empty mt-3">当前筛选条件下没有可购买挂牌。</p>
    <div v-else class="mt-3">
      <div class="gacha-trade-item-grid">
        <button
          v-for="listing in publicListings"
          :key="`public-trade-${listing.id}`"
          type="button"
          class="trade-item-row"
          @click="emit('open-listing-detail', listing)"
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
            <span class="trade-item-row__time">{{ listingRemainingLabel(listing, clientNow) }}</span>
          </div>
        </button>
      </div>
    </div>

    <GachaPagination
      :current="tradePublicPage"
      :total="publicTotal"
      :page-size="pageSize"
      :loading="loading || publicLoadingMore"
      @change="(p: number) => emit('trade-page-change', p)"
    />
  </div>
</template>
