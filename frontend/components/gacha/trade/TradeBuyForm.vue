<script setup lang="ts">
import type { AffixVisualStyle, Rarity, BuyRequest, PageCatalogEntry, BuyRequestMatchLevel } from '~/types/gacha'
import { formatTokens, formatDateCompact } from '~/utils/gachaFormatters'
import { rarityLabel } from '~/utils/gachaRarity'
import { buyRequestStatusLabelMap, buyRequestStatusChipClassMap, buyRequestMatchLevelLabelMap, buyRequestMatchLevelShortMap, coatingStyleLabelMap } from '~/utils/gachaConstants'
import type { BuyRequestSortMode } from '~/utils/gachaConstants'
import GachaCardMini from '~/components/gacha/GachaCardMini.vue'
import GachaRarityFilter from '~/components/gacha/GachaRarityFilter.vue'
import GachaPagination from '~/components/gacha/GachaPagination.vue'
import { UiButton } from '~/components/ui/button'
import { UiInput } from '~/components/ui/input'
import { UiSelectRoot, UiSelectTrigger, UiSelectContent, UiSelectItem } from '~/components/ui/select'

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

type BuyRequestDraft =
  | { targetCardId: string; matchLevel: 'PAGE' }
  | { targetCardId: string; matchLevel: 'IMAGE_VARIANT' }
  | { targetCardId: string; matchLevel: 'COATING'; requiredCoating: AffixVisualStyle }

const props = defineProps<{
  // Form state
  showBuyRequestForm: boolean
  brSelectedPage: PageCatalogEntry | null
  brSelectedVariantIds: string[]
  brSelectedCoatings: AffixVisualStyle[]
  brTokenOffer: number
  brExpiresHours: number
  brOfferedCards: Array<{ stackKey: string; cardId: string; affixSignature?: string; quantity: number }>
  brTargetSearch: string
  brOfferedSearch: string
  brFilteredCatalog: PageCatalogEntry[]
  brFilteredTradeCardOptions: TradeCardOption[]
  brDerivedPayloads: BuyRequestDraft[]
  brDerivedMatchLevelLabel: string
  brCanSubmit: boolean
  buyRequestSubmitting: boolean
  inventoryLoading: boolean
  cardOptions: TradeCardOption[]
  coatingOptions: AffixVisualStyle[]
  // Public listings
  publicBuyRequests: BuyRequest[]
  visibleBuyRequests: BuyRequest[]
  hasMoreBrLocal: boolean
  buyRequestPublicTotal: number
  buyRequestPublicPage: number
  buyRequestLoading: boolean
  buyRequestPublicLoadingMore: boolean
  brSearchInput: string
  brSortMode: BuyRequestSortMode
  brRarityFilter: Rarity | 'ALL'
  tradeRarityFilterOptions: Array<Rarity | 'ALL'>
  brShowFulfillableOnly: boolean
  userId: string | null
  clientNow: number | null
  brPageSize: number
}>()

const emit = defineEmits<{
  'update:showBuyRequestForm': [val: boolean]
  'update:brTargetSearch': [val: string]
  'update:brOfferedSearch': [val: string]
  'update:brTokenOffer': [val: number]
  'update:brExpiresHours': [val: number]
  'update:brSearchInput': [val: string]
  'update:brSortMode': [val: BuyRequestSortMode]
  'update:brRarityFilter': [val: Rarity | 'ALL']
  'br-select-page': [entry: PageCatalogEntry]
  'br-clear-selection': []
  'br-toggle-variant': [variantId: string]
  'br-select-all-variants': []
  'br-clear-variants': []
  'br-toggle-coating': [style: AffixVisualStyle]
  'br-toggle-offered-card': [item: TradeCardOption]
  'br-remove-offered-card': [stackKey: string]
  'br-set-offered-quantity': [stackKey: string, qty: number]
  'create-buy-request': []
  'open-buy-request-detail': [br: BuyRequest]
  'toggle-fulfillable-only': []
  'br-reset-filters': []
  'br-load-more-local': []
  'buy-request-page-change': [page: number]
  'refresh-buy-requests': []
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

function buyRequestRemainingLabel(br: BuyRequest, now: number | null) {
  if (br.status !== 'OPEN') return buyRequestStatusLabelMap[br.status]
  if (!br.expiresAt) return '无期限'
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

function brFindOfferedOption(stackKey: string) {
  return props.cardOptions.find((item) => item.stackKey === stackKey) ?? null
}
</script>

<template>
  <div class="space-y-4">
    <!-- 折叠式发布求购表单 -->
    <div>
      <button
        type="button"
        class="trade-collapse-toggle"
        @click="emit('update:showBuyRequestForm', !showBuyRequestForm)"
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
                  @click="emit('br-clear-selection')"
                >重新选择</button>
              </div>
              <template v-if="!brSelectedPage">
                <UiInput
                  :model-value="brTargetSearch"
                  type="search"
                  placeholder="搜索页面名 / 标签 / 作者"
                  class="w-full"
                  @update:model-value="emit('update:brTargetSearch', String($event))"
                />
                <div class="max-h-[14rem] overflow-y-auto pr-1">
                  <p v-if="!brFilteredCatalog.length" class="gacha-empty py-3 text-[11px]">未找到匹配的页面。</p>
                  <div v-else class="gacha-card-grid--mini">
                    <button
                      v-for="entry in brFilteredCatalog.slice(0, 30)"
                      :key="`br-page-${entry.pageId ?? entry.variants[0]?.id}`"
                      type="button"
                      class="trade-create-card"
                      @click="emit('br-select-page', entry)"
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

            <!-- Step 2: 画面选择 -->
            <div v-if="brSelectedPage && brSelectedPage.variants.length > 1" class="space-y-1.5">
              <div class="flex items-center justify-between">
                <span class="text-[11px] text-neutral-500 dark:text-neutral-400">选择画面（可多选）</span>
                <span class="flex gap-2">
                  <button
                    v-if="brSelectedVariantIds.length > 0"
                    type="button"
                    class="text-[10px] text-cyan-600 hover:text-cyan-800 dark:text-cyan-400 dark:hover:text-cyan-200"
                    @click="emit('br-clear-variants')"
                  >任意画面</button>
                  <button
                    v-if="brSelectedVariantIds.length < brSelectedPage.variants.length"
                    type="button"
                    class="text-[10px] text-cyan-600 hover:text-cyan-800 dark:text-cyan-400 dark:hover:text-cyan-200"
                    @click="emit('br-select-all-variants')"
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
                  @click="emit('br-toggle-variant', v.id)"
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

            <!-- Step 3: 镀层选择 -->
            <div v-if="brSelectedPage && brSelectedVariantIds.length > 0" class="space-y-1.5">
              <span class="text-[11px] text-neutral-500 dark:text-neutral-400">镀层要求（可多选，不选 = 任意镀层）</span>
              <div class="flex flex-wrap gap-1.5">
                <button
                  v-for="style in coatingOptions"
                  :key="`br-coat-${style}`"
                  type="button"
                  class="br-match-btn"
                  :class="{ 'br-match-btn--active': brSelectedCoatings.includes(style) }"
                  @click="emit('br-toggle-coating', style)"
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
              <UiInput :model-value="brTokenOffer" type="number" min="0" max="500000" step="1" @update:model-value="emit('update:brTokenOffer', Number($event))" />
            </label>

            <!-- 提供卡牌 -->
            <div class="space-y-1.5">
              <span class="text-[11px] text-neutral-500 dark:text-neutral-400">
                提供的卡牌（可选，{{ brOfferedCards.length }} 张已选）
              </span>
              <UiInput
                :model-value="brOfferedSearch"
                type="search"
                placeholder="搜索可提供的卡牌（标题 / 标签 / 作者）"
                class="w-full"
                @update:model-value="emit('update:brOfferedSearch', String($event))"
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
                    @click="emit('br-toggle-offered-card', item)"
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
                    @input="emit('br-set-offered-quantity', oc.stackKey, Number(($event.target as HTMLInputElement).value || 1))"
                  />
                  <button type="button" class="text-neutral-400 hover:text-red-500" @click="emit('br-remove-offered-card', oc.stackKey)">x</button>
                </div>
              </div>
            </div>

            <!-- 有效期 -->
            <label class="block space-y-1 text-xs text-neutral-500 dark:text-neutral-400">
              <span>有效期（小时）</span>
              <UiInput :model-value="brExpiresHours" type="number" min="1" :max="24 * 30" step="1" @update:model-value="emit('update:brExpiresHours', Number($event))" />
            </label>

            <div class="flex flex-wrap gap-2">
              <UiButton type="button" variant="ghost" size="sm" class="rounded-full border border-neutral-200 bg-white px-2.5 py-1 text-[11px] dark:border-neutral-700 dark:bg-neutral-800" @click="emit('update:brExpiresHours', 24)">24h</UiButton>
              <UiButton type="button" variant="ghost" size="sm" class="rounded-full border border-neutral-200 bg-white px-2.5 py-1 text-[11px] dark:border-neutral-700 dark:bg-neutral-800" @click="emit('update:brExpiresHours', 72)">72h</UiButton>
              <UiButton type="button" variant="ghost" size="sm" class="rounded-full border border-neutral-200 bg-white px-2.5 py-1 text-[11px] dark:border-neutral-700 dark:bg-neutral-800" @click="emit('update:brExpiresHours', 168)">168h</UiButton>
            </div>

            <UiButton class="w-full py-2.5 text-sm" :disabled="buyRequestSubmitting || !brCanSubmit" @click="emit('create-buy-request')">
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
        <UiButton variant="outline" size="sm" :disabled="buyRequestLoading" @click="emit('refresh-buy-requests')">
          {{ buyRequestLoading ? '刷新中...' : '刷新' }}
        </UiButton>
      </header>

      <!-- 可接单筛选开关 -->
      <div v-if="userId" class="mt-2">
        <button
          type="button"
          class="br-fulfillable-toggle"
          :class="{ 'br-fulfillable-toggle--active': brShowFulfillableOnly }"
          @click="emit('toggle-fulfillable-only')"
        >
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="br-fulfillable-toggle__icon"><path fill-rule="evenodd" d="M16.704 4.153a.75.75 0 01.143 1.052l-8 10.5a.75.75 0 01-1.127.075l-4.5-4.5a.75.75 0 011.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 011.05-.143z" clip-rule="evenodd" /></svg>
          仅显示我可接的求购
        </button>
      </div>

      <div class="mt-2 grid gap-2 md:grid-cols-[minmax(0,1fr),minmax(160px,200px),auto]">
        <UiInput :model-value="brSearchInput" type="search" placeholder="搜索卡片名 / 作者 / 买家" class="w-full" @update:model-value="emit('update:brSearchInput', String($event))" />
        <UiSelectRoot :model-value="brSortMode" @update:model-value="emit('update:brSortMode', $event as any)">
          <UiSelectTrigger placeholder="排序方式" />
          <UiSelectContent>
            <UiSelectItem value="LATEST">按发布时间</UiSelectItem>
            <UiSelectItem value="RARITY_DESC">按稀有度</UiSelectItem>
            <UiSelectItem value="TOKEN_DESC">按出价降序</UiSelectItem>
            <UiSelectItem value="TOKEN_ASC">按出价升序</UiSelectItem>
            <UiSelectItem value="EXPIRY_ASC">按到期时间</UiSelectItem>
          </UiSelectContent>
        </UiSelectRoot>
        <UiButton variant="outline" class="h-9" @click="emit('br-reset-filters')">重置</UiButton>
      </div>
      <div class="mt-2">
        <GachaRarityFilter :model-value="brRarityFilter" :options="tradeRarityFilterOptions" all-label="全部品质" @update:model-value="emit('update:brRarityFilter', $event as any)" />
      </div>

      <p class="mt-2 text-[11px] text-neutral-500 dark:text-neutral-400">
        显示 {{ visibleBuyRequests.length }}{{ brShowFulfillableOnly ? ` (可接)` : '' }} / {{ buyRequestPublicTotal }} 条
      </p>

      <p v-if="!publicBuyRequests.length" class="gacha-empty mt-3">
        {{ brShowFulfillableOnly ? '当前没有你可以接的求购。' : '当前没有公开求购。' }}
      </p>
      <div v-else class="mt-3 gacha-trade-item-grid">
        <button
          v-for="br in visibleBuyRequests"
          :key="`public-br-${br.id}`"
          type="button"
          class="trade-item-row"
          @click="emit('open-buy-request-detail', br)"
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
              <span class="trade-item-row__time">{{ buyRequestRemainingLabel(br, clientNow) }}</span>
              <span class="br-match-chip">{{ buyRequestMatchLevelShortMap[br.matchLevel] }}</span>
            </span>
          </div>
        </button>
      </div>

      <div v-if="hasMoreBrLocal" class="mt-3 flex items-center justify-center">
        <UiButton variant="outline" size="sm" @click="emit('br-load-more-local')">
          显示更多已加载求购（剩余 {{ publicBuyRequests.length - visibleBuyRequests.length }} 条）
        </UiButton>
      </div>

      <GachaPagination
        :current="buyRequestPublicPage"
        :total="buyRequestPublicTotal"
        :page-size="brPageSize"
        :loading="buyRequestPublicLoadingMore || buyRequestLoading"
        @change="(p: number) => emit('buy-request-page-change', p)"
      />
    </article>
  </div>
</template>
