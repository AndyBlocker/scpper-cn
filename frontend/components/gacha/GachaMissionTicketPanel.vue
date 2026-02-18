<script setup lang="ts">
/**
 * 票券仓库面板。
 * 从 missions.vue 提取，展示票券余额和使用按钮。
 */
import { computed, ref, watch } from 'vue'
import type { TicketBalance, AffixVisualStyle, Rarity } from '~/types/gacha'
import { formatTokens } from '~/utils/gachaFormatters'
import { usePageAuthors } from '~/composables/usePageAuthors'
import { resolveAuthorSearchText } from '~/utils/gachaAuthorSearch'
import GachaCardMini from '~/components/gacha/GachaCardMini.vue'
import { UiButton } from '~/components/ui/button'
import { UiInput } from '~/components/ui/input'

interface ReforgeCardOption {
  stackKey: string
  cardId: string
  title: string
  rarity: Rarity
  imageUrl: string | null
  wikidotId?: number | null
  tags: string[]
  authors?: Array<{ name: string; wikidotId: number | null }> | null
  count: number
  placedCount: number
  affixSignature?: string
  affixStyles?: AffixVisualStyle[]
  affixStyleCounts?: Partial<Record<AffixVisualStyle, number>>
}

const props = defineProps<{
  tickets: TicketBalance
  loading: boolean
  ticketAction: 'draw' | 'draw10' | 'reforge' | null
  reforgeCardOptions: ReforgeCardOption[]
  reforgeOptionsLoading: boolean
  reforgeOptionsFullyLoaded: boolean
  reforgeCardId: string
  reforgeAffixFilter: string
}>()

const emit = defineEmits<{
  draw: [mode: 1 | 10]
  reforge: []
  'update:reforgeCardId': [value: string]
  'update:reforgeAffixFilter': [value: string]
}>()

function handleReforgeCardIdUpdate(value: string | number | null) {
  emit('update:reforgeCardId', String(value ?? '').trim())
}

const reforgeSearch = ref('')
const pageAuthors = usePageAuthors()

const normalizedReforgeSearch = computed(() => reforgeSearch.value.trim().toLowerCase())

function authorSearchText(
  authors: Array<{ name: string; wikidotId: number | null }> | null | undefined,
  wikidotId: number | null | undefined
) {
  const id = Number(wikidotId)
  const cachedAuthors = Number.isFinite(id) && id > 0 ? pageAuthors.getAuthors(id) : []
  return resolveAuthorSearchText(authors, cachedAuthors)
}

const filteredReforgeCardOptions = computed(() => {
  const keyword = normalizedReforgeSearch.value
  if (!keyword) return props.reforgeCardOptions
  return props.reforgeCardOptions.filter((item) => {
    const text = `${item.title} ${item.cardId} ${(item.tags ?? []).filter(t => !t.startsWith('_')).join(' ')} ${authorSearchText(item.authors, item.wikidotId)}`.toLowerCase()
    return text.includes(keyword)
  })
})

const REFORGE_PAGE_SIZE = 36
const reforgeVisibleCount = ref(REFORGE_PAGE_SIZE)
const visibleReforgeOptions = computed(() => filteredReforgeCardOptions.value.slice(0, reforgeVisibleCount.value))
const hasMoreReforge = computed(() => filteredReforgeCardOptions.value.length > reforgeVisibleCount.value)

watch(reforgeSearch, () => {
  reforgeVisibleCount.value = REFORGE_PAGE_SIZE
})

const selectedReforgeCardOption = computed(() =>
  props.reforgeCardOptions.find((item) => item.stackKey === props.reforgeCardId) ?? null
)

function clearReforgeCardId() {
  handleReforgeCardIdUpdate('')
}
</script>

<template>
  <article class="rounded-2xl border border-neutral-200/75 bg-neutral-50/75 p-4 dark:border-neutral-800/70 dark:bg-neutral-900/55">
    <header class="flex items-center justify-between">
      <h4 class="text-sm font-semibold text-neutral-900 dark:text-neutral-100">票券仓库</h4>
      <span class="text-[11px] text-neutral-500 dark:text-neutral-400">{{ loading ? '同步中...' : '实时' }}</span>
    </header>
    <div class="mt-3 flex flex-wrap gap-2">
      <div class="ticket-pill">
        <span class="ticket-pill__label">单抽券</span>
        <span class="ticket-pill__count">{{ formatTokens(tickets.drawTicket) }}</span>
      </div>
      <div class="ticket-pill">
        <span class="ticket-pill__label">十连券</span>
        <span class="ticket-pill__count">{{ formatTokens(tickets.draw10Ticket) }}</span>
      </div>
      <div class="ticket-pill ticket-pill--accent">
        <span class="ticket-pill__label">改造券</span>
        <span class="ticket-pill__count">{{ formatTokens(tickets.affixReforgeTicket) }}</span>
      </div>
    </div>

    <hr class="gacha-section-divider mt-3">
    <p class="gacha-text-label mb-2">快速使用</p>

    <div class="grid grid-cols-2 gap-2">
      <UiButton
        size="sm"
        class="w-full"
        :disabled="ticketAction != null || tickets.drawTicket <= 0"
        @click="emit('draw', 1)"
      >
        <span v-if="ticketAction === 'draw'">处理中...</span>
        <span v-else>用单抽券</span>
      </UiButton>
      <UiButton
        variant="outline"
        size="sm"
        class="w-full"
        :disabled="ticketAction != null || tickets.draw10Ticket <= 0"
        @click="emit('draw', 10)"
      >
        <span v-if="ticketAction === 'draw10'">处理中...</span>
        <span v-else>用十连券</span>
      </UiButton>
    </div>

    <hr class="gacha-section-divider mt-3">
    <div class="mt-2 space-y-2">
      <p class="gacha-text-label">词条改造</p>
      <div class="flex flex-wrap items-center justify-between gap-2">
        <p class="text-[11px] text-neutral-500 dark:text-neutral-400">改造目标（留空即随机）</p>
        <UiButton
          type="button"
          variant="outline"
          size="sm"
          class="h-7 px-2 text-[11px]"
          :disabled="ticketAction != null"
          @click="clearReforgeCardId"
        >
          设为随机
        </UiButton>
      </div>

      <UiInput
        v-model.trim="reforgeSearch"
        type="search"
        placeholder="搜索改造目标（标题 / 标签 / 作者 / ID）"
        class="w-full text-xs"
      />

      <div class="flex items-center gap-2">
        <button
          type="button"
          class="reforge-filter-chip"
          :class="{ 'reforge-filter-chip--active': reforgeAffixFilter === 'NONE' }"
          @click="emit('update:reforgeAffixFilter', reforgeAffixFilter === 'NONE' ? '' : 'NONE')"
        >
          仅无镀层
        </button>
      </div>

      <div class="ticket-reforge-picker">
        <div v-if="reforgeOptionsLoading && !reforgeCardOptions.length" class="gacha-empty py-4">
          正在加载可改造卡片...
        </div>
        <div v-else-if="!filteredReforgeCardOptions.length" class="gacha-empty py-4">
          当前筛选下没有可改造卡片。
        </div>
        <template v-else>
          <div class="gacha-card-grid--mini">
            <button
              v-for="item in visibleReforgeOptions"
              :key="`reforge-option-${item.stackKey}`"
              type="button"
              class="ticket-reforge-card"
              :class="{ 'ticket-reforge-card--selected': reforgeCardId === item.stackKey }"
              @click="handleReforgeCardIdUpdate(item.stackKey)"
            >
              <GachaCardMini
                :title="item.title"
                :rarity="item.rarity"
                :image-url="item.imageUrl || undefined"
                :affix-visual-style="item.affixStyles?.[0]"
              >
                <template #meta>
                  <span class="ticket-reforge-chip">x{{ item.count }}</span>
                  <span v-if="item.placedCount > 0" class="ticket-reforge-chip ticket-reforge-chip--placed">放置中</span>
                </template>
              </GachaCardMini>
            </button>
          </div>
          <div v-if="hasMoreReforge" class="mt-2 flex items-center justify-center">
            <button
              type="button"
              class="ticket-reforge-loading-more"
              style="cursor: pointer;"
              @click="reforgeVisibleCount += REFORGE_PAGE_SIZE"
            >
              加载更多（剩余 {{ filteredReforgeCardOptions.length - reforgeVisibleCount }} 张）
            </button>
          </div>
          <div v-if="!reforgeOptionsFullyLoaded" class="ticket-reforge-loading-more">
            加载更多卡片中...
          </div>
        </template>
      </div>

      <p class="text-[11px] text-neutral-500 dark:text-neutral-400">
        <template v-if="selectedReforgeCardOption">
          已选 {{ selectedReforgeCardOption.title }}（{{ selectedReforgeCardOption.cardId }} · {{ selectedReforgeCardOption.affixSignature || 'NONE' }}）
        </template>
        <template v-else>
          当前为随机改造（未指定卡片）。
        </template>
      </p>

      <UiButton
        variant="outline"
        size="sm"
        class="w-full"
        :disabled="ticketAction != null || tickets.affixReforgeTicket <= 0"
        @click="emit('reforge')"
      >
        <span v-if="ticketAction === 'reforge'">处理中...</span>
        <span v-else>使用改造券</span>
      </UiButton>
    </div>
    <p class="mt-1 text-[11px] text-neutral-500 dark:text-neutral-400">可直接选择目标卡；不选则随机选择一张可改造卡。</p>
  </article>
</template>

<style scoped>
.ticket-pill {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  border-radius: 999px;
  border: 1px solid rgba(148, 163, 184, 0.3);
  background: rgba(248, 250, 252, 0.8);
  padding: 0.25rem 0.6rem;
}

html.dark .ticket-pill {
  border-color: rgba(100, 116, 139, 0.4);
  background: rgba(15, 23, 42, 0.55);
}

.ticket-pill__label {
  font-size: 11px;
  color: rgb(100, 116, 139);
}

html.dark .ticket-pill__label {
  color: rgb(148, 163, 184);
}

.ticket-pill__count {
  font-size: 12px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  color: rgb(15, 23, 42);
}

html.dark .ticket-pill__count {
  color: rgb(241, 245, 249);
}

.ticket-pill--accent {
  border-color: rgba(8, 145, 178, 0.3);
  background: rgba(8, 145, 178, 0.06);
}

html.dark .ticket-pill--accent {
  border-color: rgba(34, 211, 238, 0.3);
  background: rgba(34, 211, 238, 0.08);
}

.ticket-reforge-picker {
  max-height: 24rem;
  overflow-y: auto;
  padding-right: 0.2rem;
}

.ticket-reforge-card {
  position: relative;
  border-radius: 0.9rem;
  border: 2px solid transparent;
  background: rgba(255, 255, 255, 0.72);
  padding: 0;
  text-align: left;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}

.ticket-reforge-card:hover {
  border-color: rgba(14, 116, 144, 0.3);
}

.ticket-reforge-card--selected {
  border-color: rgb(14, 116, 144);
  box-shadow: 0 0 0 1px rgba(14, 116, 144, 0.2), 0 0 12px rgba(8, 145, 178, 0.25);
}

html.dark .ticket-reforge-card {
  background: rgba(15, 23, 42, 0.62);
}

html.dark .ticket-reforge-card:hover {
  border-color: rgba(34, 211, 238, 0.35);
}

html.dark .ticket-reforge-card--selected {
  border-color: rgb(34, 211, 238);
  box-shadow: 0 0 0 1px rgba(34, 211, 238, 0.25), 0 0 14px rgba(6, 182, 212, 0.3);
}

.ticket-reforge-chip {
  display: inline-flex;
  align-items: center;
  border-radius: 999px;
  border: 1px solid rgba(148, 163, 184, 0.35);
  background: rgba(248, 250, 252, 0.8);
  color: rgb(100 116 139);
  font-size: 10px;
  font-weight: 700;
  padding: 1px 6px;
}

html.dark .ticket-reforge-chip {
  border-color: rgba(100, 116, 139, 0.45);
  background: rgba(2, 6, 23, 0.72);
  color: rgb(148 163 184);
}

.ticket-reforge-chip--placed {
  border-color: rgba(234, 179, 8, 0.45);
  background: rgba(254, 249, 195, 0.85);
  color: rgb(161 98 7);
}

html.dark .ticket-reforge-chip--placed {
  border-color: rgba(250, 204, 21, 0.38);
  background: rgba(66, 32, 6, 0.85);
  color: rgb(253 224 71);
}

.ticket-reforge-loading-more {
  text-align: center;
  padding: 0.75rem 0;
  font-size: 11px;
  color: rgb(148, 163, 184);
}

.reforge-filter-chip {
  display: inline-flex;
  align-items: center;
  border-radius: 999px;
  border: 1px solid rgba(148, 163, 184, 0.35);
  background: rgba(248, 250, 252, 0.8);
  color: rgb(100 116 139);
  font-size: 11px;
  font-weight: 600;
  padding: 3px 10px;
  cursor: pointer;
  transition: all 0.15s ease;
}

.reforge-filter-chip:hover {
  border-color: rgba(14, 116, 144, 0.4);
  color: rgb(14, 116, 144);
}

.reforge-filter-chip--active {
  border-color: rgb(14, 116, 144);
  background: rgba(8, 145, 178, 0.1);
  color: rgb(14, 116, 144);
}

html.dark .reforge-filter-chip {
  border-color: rgba(100, 116, 139, 0.45);
  background: rgba(2, 6, 23, 0.72);
  color: rgb(148 163 184);
}

html.dark .reforge-filter-chip:hover {
  border-color: rgba(34, 211, 238, 0.5);
  color: rgb(34, 211, 238);
}

html.dark .reforge-filter-chip--active {
  border-color: rgb(34, 211, 238);
  background: rgba(34, 211, 238, 0.12);
  color: rgb(34, 211, 238);
}
</style>
