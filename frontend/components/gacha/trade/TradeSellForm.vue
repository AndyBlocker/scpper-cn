<script setup lang="ts">
import type { AffixVisualStyle, Rarity } from '~/types/gacha'
import { formatTokens } from '~/utils/gachaFormatters'
import { rarityLabel } from '~/utils/gachaRarity'
import GachaCardMini from '~/components/gacha/GachaCardMini.vue'
import { UiButton } from '~/components/ui/button'
import { UiInput } from '~/components/ui/input'

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

type RarityGroup = { rarity: Rarity; startIndex: number; count: number }

const props = defineProps<{
  inventoryLoading: boolean
  cardOptions: TradeCardOption[]
  filteredTradeCardOptions: TradeCardOption[]
  visibleTradeCardOptions: TradeCardOption[]
  rarityGroups: RarityGroup[]
  tradeCreateSearch: string
  normalizedCreateSearch: string
  tradeSelectionKey: string
  selectedTradeCardOption: TradeCardOption | null
  tradeQuantity: number
  tradeQuantityMax: number
  tradeUnitPrice: number
  tradeExpiresHours: number
  submitting: boolean
  pickerHasMore: boolean
  pickerRemainingCount: number
  showCreateForm: boolean
}>()

const emit = defineEmits<{
  'update:showCreateForm': [val: boolean]
  'update:tradeCreateSearch': [val: string]
  'update:tradeSelectionKey': [val: string]
  'update:tradeQuantity': [val: number]
  'update:tradeUnitPrice': [val: number]
  'update:tradeExpiresHours': [val: number]
  create: []
  'picker-load-more': []
  'picker-next-group-label': []
}>()

function pickerNextGroupLabel(): string {
  const nextIdx = props.visibleTradeCardOptions.length
  for (const g of props.rarityGroups) {
    if (nextIdx >= g.startIndex && nextIdx < g.startIndex + g.count) {
      return rarityLabel(g.rarity)
    }
  }
  return ''
}
</script>

<template>
  <div>
    <button
      type="button"
      class="trade-collapse-toggle"
      @click="emit('update:showCreateForm', !showCreateForm)"
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

        <form v-else class="mt-3 space-y-3" @submit.prevent="emit('create')">
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
              :model-value="tradeCreateSearch"
              type="search"
              placeholder="搜索可上架卡片（标题 / 标签 / 作者 / ID）"
              class="w-full"
              @update:model-value="emit('update:tradeCreateSearch', String($event))"
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
                  @click="emit('update:tradeSelectionKey', item.stackKey)"
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
                @click="emit('picker-load-more')"
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
              <UiInput :model-value="tradeQuantity" type="number" min="1" :max="tradeQuantityMax" step="1" @update:model-value="emit('update:tradeQuantity', Number($event))" />
            </label>
            <label class="space-y-1 text-xs text-neutral-500 dark:text-neutral-400">
              <span>单价 Token</span>
              <UiInput :model-value="tradeUnitPrice" type="number" min="1" max="1000000" step="1" @update:model-value="emit('update:tradeUnitPrice', Number($event))" />
            </label>
            <label class="space-y-1 text-xs text-neutral-500 dark:text-neutral-400">
              <span>有效期（小时）</span>
              <UiInput :model-value="tradeExpiresHours" type="number" min="1" :max="24 * 30" step="1" @update:model-value="emit('update:tradeExpiresHours', Number($event))" />
            </label>
          </div>

          <p class="text-[11px] text-neutral-500 dark:text-neutral-400">
            挂牌总价 {{ formatTokens(Math.max(1, Number(tradeQuantity || 1)) * Math.max(1, Number(tradeUnitPrice || 1))) }} Token · 预计到期 {{ tradeExpiresHours }} 小时后
          </p>

          <div class="flex flex-wrap gap-2">
            <UiButton type="button" variant="ghost" size="sm" class="rounded-full border border-neutral-200 bg-white px-2.5 py-1 text-[11px] dark:border-neutral-700 dark:bg-neutral-800" @click="emit('update:tradeExpiresHours', 24)">24h</UiButton>
            <UiButton type="button" variant="ghost" size="sm" class="rounded-full border border-neutral-200 bg-white px-2.5 py-1 text-[11px] dark:border-neutral-700 dark:bg-neutral-800" @click="emit('update:tradeExpiresHours', 72)">72h</UiButton>
            <UiButton type="button" variant="ghost" size="sm" class="rounded-full border border-neutral-200 bg-white px-2.5 py-1 text-[11px] dark:border-neutral-700 dark:bg-neutral-800" @click="emit('update:tradeExpiresHours', 168)">168h</UiButton>
          </div>

          <UiButton type="submit" class="w-full py-2.5 text-sm" :disabled="submitting || !selectedTradeCardOption">
            {{ submitting ? '上架中...' : '提交并确认' }}
          </UiButton>
        </form>
      </article>
    </Transition>
  </div>
</template>
