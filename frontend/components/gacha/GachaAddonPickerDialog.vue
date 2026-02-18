<script setup lang="ts">
/**
 * 无色词条挂载选择器弹窗。
 * 使用 GachaCardMini 紧凑展示。
 */
import type { Rarity, AffixVisualStyle, InventoryItem } from '~/types/gacha'
import { computed, nextTick, ref, watch } from 'vue'
import { formatTokenDecimal } from '~/utils/gachaFormatters'
import { placementBaseYieldByRarity } from '~/utils/gachaRarity'
import { resolveAffixParts } from '~/utils/gachaAffix'
import { usePageAuthors } from '~/composables/usePageAuthors'
import { resolveAuthorSearchText } from '~/utils/gachaAuthorSearch'
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

// ─── Picker 选项类型（与 PlacementPicker 共享结构） ──────

export interface AddonPickerOption extends InventoryItem {
  stackKey: string
  availableCount: number
  disabled: boolean
  affixParts: ReturnType<typeof resolveAffixParts>
  primaryAffixStyle: AffixVisualStyle
  affixSignatureNormalized: string
}

// ─── Props / Emits ───────────────────────────────────────

const props = defineProps<{
  open: boolean
  currentCardTitle: string | null
  hasCurrentCard: boolean
  options: AddonPickerOption[]
  busy: boolean
}>()

const emit = defineEmits<{
  close: []
  select: [cardId: string, affixVisualStyle: AffixVisualStyle, affixSignature: string | undefined]
  clear: []
}>()

// ─── 内部搜索 ───────────────────────────────────────────

const search = ref('')
const searchInputRef = ref<{ focus: () => void } | null>(null)
const pageAuthors = usePageAuthors()

function authorSearchText(
  authors: Array<{ name: string; wikidotId: number | null }> | null | undefined,
  wikidotId: number | null | undefined
) {
  const id = Number(wikidotId)
  const cachedAuthors = Number.isFinite(id) && id > 0 ? pageAuthors.getAuthors(id) : []
  return resolveAuthorSearchText(authors, cachedAuthors)
}

const searchIndex = computed(() => {
  const index = new Map<string, string>()
  for (const item of props.options) {
    const text = `${item.title} ${(item.tags ?? []).filter(t => !t.startsWith('_')).join(' ')} ${authorSearchText(item.authors, item.wikidotId)} ${item.cardId}`.toLowerCase()
    index.set(item.stackKey, text)
  }
  return index
})

const filteredOptions = computed(() => {
  const keyword = search.value.trim().toLowerCase()
  if (!keyword) return props.options
  const idx = searchIndex.value
  return props.options.filter((item) => {
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

watch(search, () => {
  pickerVisibleCount.value = PICKER_PAGE_SIZE
})

function previewColorlessBaseYield(rarity: Rarity) {
  const base = Number(placementBaseYieldByRarity[rarity] ?? 0)
  return formatTokenDecimal(base * 0.5, 2)
}

watch(() => props.open, (val) => {
  if (val) {
    search.value = ''
    pickerVisibleCount.value = PICKER_PAGE_SIZE
    nextTick(() => searchInputRef.value?.focus())
  }
})
</script>

<template>
  <UiDialogRoot :open="open" @update:open="(nextOpen) => { if (!nextOpen) emit('close') }">
    <UiDialogPortal>
      <UiDialogOverlay />
      <UiDialogContent class="addon-picker-dialog p-0">
        <!-- 头部 -->
        <header class="flex flex-wrap items-start justify-between gap-3 border-b border-neutral-200/70 bg-white px-5 py-4 dark:border-neutral-700/70 dark:bg-neutral-900">
          <div>
            <h3 class="text-lg font-semibold text-neutral-900 dark:text-neutral-50">无色词条槽</h3>
            <p class="mt-1 text-xs text-neutral-500 dark:text-neutral-300">
              当前 {{ hasCurrentCard ? currentCardTitle : '未挂载' }}
            </p>
          </div>
          <div class="flex items-center gap-2">
            <UiButton
              variant="outline"
              size="sm"
              :disabled="busy || !hasCurrentCard"
              @click="emit('clear')"
            >
              清空挂载
            </UiButton>
            <UiDialogClose as-child>
              <UiButton variant="ghost" size="sm" class="h-9 w-9 rounded-full p-0" aria-label="关闭无色词条槽选择">
                X
              </UiButton>
            </UiDialogClose>
          </div>
        </header>

        <!-- 搜索 -->
        <div class="border-b border-neutral-200/70 bg-neutral-50 px-5 py-3 dark:border-neutral-700/70 dark:bg-neutral-900">
          <UiInput
            ref="searchInputRef"
            v-model.trim="search"
            type="search"
            placeholder="搜索无色词条卡片（标题 / 标签 / 作者）"
            class="w-full text-xs md:max-w-sm"
          />
        </div>

        <!-- 卡片网格 -->
        <div class="addon-picker-scroll">
          <div v-if="!filteredOptions.length" class="mt-4 rounded-2xl border border-dashed border-neutral-300/70 px-4 py-4 text-sm text-neutral-500 dark:border-neutral-700/70 dark:text-neutral-300">
            没有可挂载的无色词条卡片。
          </div>

          <div v-else class="gacha-card-grid--mini mt-3">
            <button
              v-for="item in visibleOptions"
              :key="`placement-addon-${item.stackKey}`"
              type="button"
              class="addon-picker-card"
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
                  <span class="addon-yield-chip">+{{ previewColorlessBaseYield(item.rarity) }}/h</span>
                </template>
              </GachaCardMini>
            </button>
          </div>

          <button
            v-if="pickerHasMore"
            type="button"
            class="addon-picker-load-more"
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
.addon-picker-dialog {
  width: 90vw;
  max-width: 90vw;
}
@media (min-width: 1280px) {
  .addon-picker-dialog {
    max-width: 1200px;
  }
}

.addon-picker-scroll {
  max-height: calc(100vh - 10rem);
  max-height: calc(100dvh - 10rem);
  overflow-y: auto;
  padding: 0 1.25rem 1.25rem;
}
@media (min-width: 640px) {
  .addon-picker-scroll {
    max-height: calc(100vh - 12rem);
    max-height: calc(100dvh - 12rem);
  }
}

.addon-picker-card {
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
.addon-picker-card:hover:not(:disabled) {
  border-color: rgba(14, 116, 144, 0.35);
  box-shadow: 0 4px 12px rgba(15, 23, 42, 0.08);
  transform: translateY(-1px);
}
.addon-picker-card:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}

html.dark .addon-picker-card {
  border-color: rgba(100, 116, 139, 0.45);
  background: rgba(15, 23, 42, 0.62);
}
html.dark .addon-picker-card:hover:not(:disabled) {
  border-color: rgba(34, 211, 238, 0.45);
  box-shadow: 0 4px 12px rgba(6, 182, 212, 0.12);
}

.addon-yield-chip {
  font-size: 9px;
  font-weight: 600;
  color: rgb(8 145 178);
  white-space: nowrap;
}
html.dark .addon-yield-chip {
  color: rgb(103 232 249);
}

.addon-picker-load-more {
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
.addon-picker-load-more:hover {
  border-color: rgba(14, 116, 144, 0.45);
  background: rgba(236, 254, 255, 0.7);
  box-shadow: 0 2px 8px rgba(8, 145, 178, 0.08);
}
html.dark .addon-picker-load-more {
  border-color: rgba(34, 211, 238, 0.25);
  background: rgba(8, 47, 73, 0.4);
  color: rgb(103 232 249);
}
html.dark .addon-picker-load-more:hover {
  border-color: rgba(34, 211, 238, 0.45);
  background: rgba(8, 47, 73, 0.6);
}
</style>
