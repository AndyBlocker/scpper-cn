<script setup lang="ts">
import type { TradeActivityItem, TradeListing, BuyRequest } from '~/types/gacha'
import { formatTokens, formatDateCompact } from '~/utils/gachaFormatters'
import GachaCardMini from '~/components/gacha/GachaCardMini.vue'
import GachaPagination from '~/components/gacha/GachaPagination.vue'

defineProps<{
  items: TradeActivityItem[]
  total: number
  currentPage: number
  pageSize: number
  loading: boolean
}>()

const emit = defineEmits<{
  'page-change': [page: number]
}>()

const activityLabelMap: Record<string, string> = {
  'listing:seller:SOLD': '卖出',
  'listing:buyer:SOLD': '购入',
  'listing:seller:CANCELLED': '挂牌撤销',
  'listing:seller:EXPIRED': '挂牌过期',
  'listing:buyer:CANCELLED': '购买撤销',
  'listing:buyer:EXPIRED': '挂牌过期',
  'buyRequest:poster:FULFILLED': '求购成交',
  'buyRequest:fulfiller:FULFILLED': '接受求购',
  'buyRequest:poster:CANCELLED': '求购撤销',
  'buyRequest:poster:EXPIRED': '求购过期',
  'buyRequest:fulfiller:CANCELLED': '求购撤销',
  'buyRequest:fulfiller:EXPIRED': '求购过期'
}

const activityChipClassMap: Record<string, string> = {
  SOLD: 'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-500/40 dark:bg-emerald-500/10 dark:text-emerald-200',
  FULFILLED: 'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-500/40 dark:bg-emerald-500/10 dark:text-emerald-200',
  CANCELLED: 'border-neutral-300 bg-neutral-100 text-neutral-600 dark:border-neutral-600 dark:bg-neutral-800/70 dark:text-neutral-300',
  EXPIRED: 'border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200'
}

function activityLabel(item: TradeActivityItem): string {
  const key = `${item.kind}:${item.role}:${item.data.status}`
  return activityLabelMap[key] ?? '交易动态'
}

function activityChipClass(item: TradeActivityItem): string {
  return activityChipClassMap[item.data.status] ?? ''
}

function itemCard(item: TradeActivityItem) {
  return item.kind === 'listing'
    ? (item.data as TradeListing).card
    : (item.data as BuyRequest).targetCard
}

function counterparty(item: TradeActivityItem) {
  if (item.kind === 'listing') {
    const listing = item.data as TradeListing
    return item.role === 'seller' ? listing.buyer : listing.seller
  }
  const br = item.data as BuyRequest
  return item.role === 'poster' ? br.fulfiller : br.buyer
}

function formatAccountDisplayName(
  account: { id: string; displayName: string | null; linkedWikidotId: number | null } | null | undefined
) {
  if (account?.displayName) return account.displayName
  if (account?.linkedWikidotId) return `WID:${account.linkedWikidotId}`
  const rawId = String(account?.id || '').trim()
  if (!rawId) return '未知用户'
  return `用户-${rawId.slice(0, 8)}`
}

function tokenAmount(item: TradeActivityItem): number {
  if (item.kind === 'listing') {
    const listing = item.data as TradeListing
    return listing.remaining > 0
      ? listing.unitPrice * listing.remaining
      : listing.totalPrice
  }
  return (item.data as BuyRequest).tokenOffer
}

function quantityLabel(item: TradeActivityItem): string {
  if (item.kind === 'listing') {
    const listing = item.data as TradeListing
    return `${listing.quantity} 张`
  }
  return ''
}
</script>

<template>
  <article class="rounded-lg border border-neutral-200/75 bg-neutral-50/75 p-4 dark:border-neutral-800/70 dark:bg-neutral-900/55">
    <header class="flex items-center justify-between">
      <h4 class="text-xs font-semibold text-neutral-700 dark:text-neutral-200">
        交易动态
        <span v-if="total > 0" class="ml-1 text-[10px] font-medium text-neutral-500 dark:text-neutral-400">({{ total }})</span>
      </h4>
    </header>

    <p v-if="loading && !items.length" class="gacha-empty mt-3">加载中...</p>
    <p v-else-if="!items.length" class="gacha-empty mt-3">暂无交易动态。完成一笔交易后会在此显示。</p>

    <div v-else class="mt-3 gacha-trade-item-grid">
      <div
        v-for="item in items"
        :key="`${item.kind}-${item.data.id}`"
        class="trade-item-row"
      >
        <div class="trade-item-row__card">
          <GachaCardMini
            :title="itemCard(item).title"
            :rarity="itemCard(item).rarity"
            :image-url="itemCard(item).imageUrl || undefined"
            :retired="itemCard(item).isRetired"
            :affix-visual-style="itemCard(item).affixVisualStyle"
            :affix-label="itemCard(item).affixLabel"
            :hide-footer="true"
          />
        </div>

        <div class="trade-item-row__info">
          <span
            class="inline-flex self-start rounded-full border px-2 py-0.5 text-[9px] font-semibold"
            :class="activityChipClass(item)"
          >{{ activityLabel(item) }}</span>
          <span class="trade-item-row__price">
            {{ tokenAmount(item) > 0 ? `${formatTokens(tokenAmount(item))}T` : '' }}
            <span v-if="quantityLabel(item)" class="trade-item-row__qty">{{ quantityLabel(item) }}</span>
          </span>
          <span class="trade-item-row__time">
            <span v-if="counterparty(item)" class="trade-item-row__user">{{ formatAccountDisplayName(counterparty(item)) }}</span>
            {{ formatDateCompact(item.activityTs) }}
          </span>
        </div>
      </div>
    </div>

    <GachaPagination
      v-if="total > pageSize"
      :current="currentPage"
      :total="total"
      :page-size="pageSize"
      :loading="loading"
      class="mt-3"
      @change="(p: number) => emit('page-change', p)"
    />
  </article>
</template>

