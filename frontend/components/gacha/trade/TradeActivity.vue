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

    <div v-else class="mt-3 space-y-2">
      <div
        v-for="item in items"
        :key="`${item.kind}-${item.data.id}`"
        class="trade-activity-row"
      >
        <div class="trade-activity-row__card">
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

        <div class="trade-activity-row__body">
          <div class="flex flex-wrap items-center gap-1.5">
            <span
              class="inline-flex rounded-full border px-2 py-0.5 text-[9px] font-semibold"
              :class="activityChipClass(item)"
            >{{ activityLabel(item) }}</span>
            <span v-if="quantityLabel(item)" class="text-[10px] text-neutral-500 dark:text-neutral-400">{{ quantityLabel(item) }}</span>
          </div>

          <span v-if="tokenAmount(item) > 0" class="trade-activity-row__price">
            {{ formatTokens(tokenAmount(item)) }} T
          </span>

          <div class="flex items-center gap-1.5 text-[10px]">
            <span v-if="counterparty(item)" class="trade-activity-row__user">
              {{ formatAccountDisplayName(counterparty(item)) }}
            </span>
            <span class="trade-activity-row__time">
              {{ formatDateCompact(item.activityTs) }}
            </span>
          </div>
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

<style scoped>
.trade-activity-row {
  display: flex;
  align-items: stretch;
  gap: 10px;
  padding: 8px;
  border-radius: 0.85rem;
  border: 1px solid rgba(148, 163, 184, 0.18);
  background: rgba(255, 255, 255, 0.55);
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}
.trade-activity-row:hover {
  border-color: rgba(148, 163, 184, 0.35);
  box-shadow: 0 2px 8px rgba(15, 23, 42, 0.05);
}
html.dark .trade-activity-row {
  border-color: rgba(100, 116, 139, 0.3);
  background: rgba(15, 23, 42, 0.45);
}
html.dark .trade-activity-row:hover {
  border-color: rgba(100, 116, 139, 0.5);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
}

.trade-activity-row__card {
  flex: 0 0 64px;
  min-width: 0;
}
.trade-activity-row__card > * {
  width: 100%;
  height: 100%;
}

.trade-activity-row__body {
  flex: 1;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 3px;
  min-width: 0;
  padding: 2px 0;
}

.trade-activity-row__price {
  font-size: 12px;
  font-weight: 700;
  color: rgb(180 83 9);
  font-variant-numeric: tabular-nums;
}
html.dark .trade-activity-row__price {
  color: rgb(252 211 77);
}

.trade-activity-row__user {
  font-weight: 600;
  color: rgb(14 116 144);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 120px;
}
html.dark .trade-activity-row__user {
  color: rgb(103 232 249);
}

.trade-activity-row__time {
  font-size: 10px;
  font-weight: 500;
  color: rgb(100 116 139);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
html.dark .trade-activity-row__time {
  color: rgb(148 163 184);
}
</style>
