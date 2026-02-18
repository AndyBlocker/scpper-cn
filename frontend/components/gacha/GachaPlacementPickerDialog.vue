<script setup lang="ts">
/**
 * 放置卡片选择器弹窗。
 * 使用 GachaCardMini 紧凑展示，按稀有度 > 镀层数量 > 可用数量排序。
 */
import type { Rarity, AffixVisualStyle, InventoryItem } from '~/types/gacha'
import { computed, nextTick, ref, watch } from 'vue'
import { resolveAffixParts } from '~/utils/gachaAffix'
import { raritySortWeight } from '~/utils/gachaRarity'
import { usePageAuthors } from '~/composables/usePageAuthors'
import { resolveAuthorSearchText } from '~/utils/gachaAuthorSearch'
import GachaRarityFilter from '~/components/gacha/GachaRarityFilter.vue'
import GachaCardMini from '~/components/gacha/GachaCardMini.vue'
import { UiButton } from '~/components/ui/button'
import { UiInput } from '~/components/ui/input'
import {
  UiDialogRoot,
  UiDialogPortal,
  UiDialogOverlay,
  UiDialogContent,
  UiDialogClose
} from '~/components/ui/dialog'

// ─── Picker 选项类型 ─────────────────────────────────────

export interface PickerOption extends InventoryItem {
  stackKey: string
  availableCount: number
  disabled: boolean
  affixParts: ReturnType<typeof resolveAffixParts>
  primaryAffixStyle: AffixVisualStyle
  affixSignatureNormalized: string
}

// ─── Props / Emits ───────────────────────────────────────

const props = defineProps<{
  slotIndex: number | null
  currentCardTitle: string | null
  currentCardStackKey: string | null
  hasCurrentCard: boolean
  options: PickerOption[]
  loading?: boolean
  busy: boolean
}>()

const emit = defineEmits<{
  close: []
  select: [cardId: string, affixVisualStyle: AffixVisualStyle, affixSignature: string | undefined]
  clear: []
}>()

// ─── 内部搜索 / 筛选 ────────────────────────────────────

const search = ref('')
const rarityFilter = ref<Rarity | 'ALL'>('ALL')
const searchInputRef = ref<{ focus: () => void } | null>(null)
const pageAuthors = usePageAuthors()

const rarityFilters: Array<Rarity | 'ALL'> = ['ALL', 'GOLD', 'PURPLE', 'BLUE', 'GREEN', 'WHITE']

function authorSearchText(
  authors: Array<{ name: string; wikidotId: number | null }> | null | undefined,
  wikidotId: number | null | undefined
) {
  const id = Number(wikidotId)
  const cachedAuthors = Number.isFinite(id) && id > 0 ? pageAuthors.getAuthors(id) : []
  return resolveAuthorSearchText(authors, cachedAuthors)
}

// 预计算搜索索引
const searchIndex = computed(() => {
  const index = new Map<string, string>()
  for (const item of props.options) {
    const text = `${item.title} ${(item.tags ?? []).filter(t => !t.startsWith('_')).join(' ')} ${authorSearchText(item.authors, item.wikidotId)} ${item.cardId}`.toLowerCase()
    index.set(item.stackKey, text)
  }
  return index
})

// 词条数量（镀层越多排越前）
function affixTotalCount(item: PickerOption): number {
  return item.affixParts.reduce((sum, p) => sum + p.count, 0)
}

// 预排序：稀有度 > 镀层数量(降序) > 可放数量(降序) > 标题
const sortedOptions = computed(() =>
  [...props.options].sort((a, b) => {
    const rarityDiff = (raritySortWeight[a.rarity] ?? 99) - (raritySortWeight[b.rarity] ?? 99)
    if (rarityDiff !== 0) return rarityDiff
    const affixDiff = affixTotalCount(b) - affixTotalCount(a)
    if (affixDiff !== 0) return affixDiff
    if (a.availableCount !== b.availableCount) return b.availableCount - a.availableCount
    return a.title.localeCompare(b.title, 'zh-CN')
  })
)

const filteredOptions = computed(() => {
  const keyword = search.value.trim().toLowerCase()
  const idx = searchIndex.value
  return sortedOptions.value.filter((item) => {
    if (rarityFilter.value !== 'ALL' && item.rarity !== rarityFilter.value) return false
    if (!keyword) return true
    return (idx.get(item.stackKey) || '').includes(keyword)
  })
})

// ─── 渐进分页 ─────────────────────────────────────────
const PICKER_PAGE_SIZE = 36
const pickerVisibleCount = ref(PICKER_PAGE_SIZE)

const visibleOptions = computed(() =>
  filteredOptions.value.slice(0, pickerVisibleCount.value)
)
const pickerHasMore = computed(() =>
  filteredOptions.value.length > pickerVisibleCount.value
)
const pickerRemainingCount = computed(() =>
  Math.max(0, filteredOptions.value.length - pickerVisibleCount.value)
)

function pickerLoadMore() {
  pickerVisibleCount.value = Math.min(
    pickerVisibleCount.value + PICKER_PAGE_SIZE,
    filteredOptions.value.length
  )
}

watch([search, rarityFilter], () => {
  pickerVisibleCount.value = PICKER_PAGE_SIZE
})

watch(() => props.slotIndex, (val) => {
  if (val != null) {
    search.value = ''
    rarityFilter.value = 'ALL'
    pickerVisibleCount.value = PICKER_PAGE_SIZE
    nextTick(() => searchInputRef.value?.focus())
  }
})
</script>

<template>
  <UiDialogRoot :open="slotIndex != null" @update:open="(nextOpen) => { if (!nextOpen) emit('close') }">
    <UiDialogPortal>
      <UiDialogOverlay />
      <UiDialogContent class="placement-picker-dialog p-0">
        <!-- 头部 -->
        <header class="flex flex-wrap items-start justify-between gap-3 border-b border-neutral-200/70 bg-white px-5 py-4 dark:border-neutral-700/70 dark:bg-neutral-900">
          <div>
            <h3 class="text-lg font-semibold text-neutral-900 dark:text-neutral-50">选择放置卡片</h3>
          </div>
          <div class="flex items-center gap-2">
            <UiButton
              variant="outline"
              size="sm"
              :disabled="busy || !hasCurrentCard"
              @click="emit('clear')"
            >
              清空槽位
            </UiButton>
            <UiDialogClose as-child>
              <UiButton variant="ghost" size="sm" class="h-9 w-9 rounded-full p-0" aria-label="关闭放置卡片选择">
                X
              </UiButton>
            </UiDialogClose>
          </div>
        </header>

        <!-- 搜索 + 稀有度筛选 -->
        <div class="border-b border-neutral-200/70 bg-neutral-50 px-5 py-3 dark:border-neutral-700/70 dark:bg-neutral-900">
          <div class="flex flex-col gap-2 md:flex-row md:items-center">
            <UiInput
              ref="searchInputRef"
              v-model.trim="search"
              type="search"
              placeholder="搜索卡片标题 / 标签 / 作者"
              class="w-full text-xs md:max-w-xs"
            />
            <GachaRarityFilter v-model="rarityFilter" :options="rarityFilters" />
            <span class="ml-auto text-xs text-neutral-500 dark:text-neutral-400">
              {{ filteredOptions.length }} 种可选
            </span>
          </div>
        </div>

        <!-- 卡片网格 -->
        <div class="placement-picker-scroll">
          <div v-if="!filteredOptions.length" class="mt-4 rounded-2xl border border-dashed border-neutral-200/70 px-4 py-4 text-sm text-neutral-500 dark:border-neutral-800/70 dark:text-neutral-400">
            {{ loading ? '正在加载可放置卡片...' : '当前筛选条件下没有可放置卡片。' }}
          </div>

          <div v-else class="gacha-card-grid--mini mt-3">
            <button
              v-for="item in visibleOptions"
              :key="`placement-picker-${item.stackKey}`"
              type="button"
              class="placement-picker-card"
              :disabled="item.disabled || busy"
              @click="emit('select', item.cardId, item.primaryAffixStyle, item.affixSignatureNormalized)"
            >
              <GachaCardMini
                :title="item.title"
                :rarity="item.rarity"
                :image-url="item.imageUrl || undefined"
                :affix-visual-style="item.primaryAffixStyle"
                :affix-label="item.affixLabel"
                :count="item.count"
              >
                <template #meta>
                  <span class="placement-avail-chip">可放 {{ Math.max(0, item.availableCount) }}</span>
                </template>
              </GachaCardMini>
            </button>
          </div>

          <button
            v-if="pickerHasMore"
            type="button"
            class="placement-picker-load-more"
            @click="pickerLoadMore()"
          >
            加载更多（剩余 {{ pickerRemainingCount }}）
          </button>
        </div>
      </UiDialogContent>
    </UiDialogPortal>
  </UiDialogRoot>
</template>

<style scoped>
.placement-picker-dialog {
  width: 90vw;
  max-width: 90vw;
}
@media (min-width: 1280px) {
  .placement-picker-dialog {
    max-width: 1200px;
  }
}

.placement-picker-scroll {
  max-height: calc(100vh - 10rem);
  max-height: calc(100dvh - 10rem);
  overflow-y: auto;
  padding: 0 1.25rem 1.25rem;
}
@media (min-width: 640px) {
  .placement-picker-scroll {
    max-height: calc(100vh - 12rem);
    max-height: calc(100dvh - 12rem);
  }
}

.placement-picker-card {
  position: relative;
  display: block;
  width: 100%;
  border: 1px solid rgba(100, 116, 139, 0.28);
  border-radius: 0.9rem;
  padding: 0;
  background: transparent;
  cursor: pointer;
  transition: border-color 0.15s, box-shadow 0.15s, transform 0.15s;
}
.placement-picker-card:hover:not(:disabled) {
  border-color: rgba(14, 116, 144, 0.35);
  box-shadow: 0 4px 12px rgba(15, 23, 42, 0.08);
  transform: translateY(-1px);
}
.placement-picker-card:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}

html.dark .placement-picker-card {
  border-color: rgba(100, 116, 139, 0.45);
  background: rgba(15, 23, 42, 0.62);
}
html.dark .placement-picker-card:hover:not(:disabled) {
  border-color: rgba(34, 211, 238, 0.45);
  box-shadow: 0 4px 12px rgba(6, 182, 212, 0.12);
}

.placement-avail-chip {
  font-size: 9px;
  font-weight: 600;
  color: rgb(8 145 178);
  white-space: nowrap;
}
html.dark .placement-avail-chip {
  color: rgb(103 232 249);
}

.placement-picker-load-more {
  display: block;
  width: 100%;
  margin-top: 8px;
  padding: 8px 0;
  border-radius: 0.6rem;
  border: 1px dashed rgba(14, 116, 144, 0.3);
  background: rgba(236, 254, 255, 0.4);
  color: rgb(8 145 178);
  font-size: 12px;
  font-weight: 500;
  text-align: center;
  cursor: pointer;
  transition: all 0.15s ease;
}
.placement-picker-load-more:hover {
  border-color: rgba(14, 116, 144, 0.45);
  background: rgba(236, 254, 255, 0.7);
  box-shadow: 0 2px 8px rgba(8, 145, 178, 0.08);
}
html.dark .placement-picker-load-more {
  border-color: rgba(34, 211, 238, 0.25);
  background: rgba(8, 47, 73, 0.4);
  color: rgb(103 232 249);
}
html.dark .placement-picker-load-more:hover {
  border-color: rgba(34, 211, 238, 0.45);
  background: rgba(8, 47, 73, 0.6);
}
</style>
