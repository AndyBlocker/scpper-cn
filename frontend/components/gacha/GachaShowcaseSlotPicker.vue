<script setup lang="ts">
/**
 * 展示柜卡片选择器弹窗。
 * 从库存中选择一张卡片放入展示柜槽位。
 */
import type { Rarity, AffixVisualStyle } from '~/types/gacha'
import { computed, ref, watch } from 'vue'
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

export interface ShowcasePickerOption {
  cardId: string
  instanceId: string
  title: string
  rarity: Rarity
  tags: string[]
  imageUrl: string | null
  authors?: Array<{ name: string; wikidotId: number | null }> | null
  wikidotId?: number | null
  affixVisualStyle: AffixVisualStyle
  affixSignature: string
  affixLabel: string | null
  isLocked?: boolean
}

const props = defineProps<{
  open: boolean
  options: ShowcasePickerOption[]
  loading?: boolean
  busy: boolean
}>()

const emit = defineEmits<{
  close: []
  select: [instanceId: string]
}>()

const search = ref('')
const rarityFilter = ref<Rarity | 'ALL'>('ALL')
const rarityFilters: Array<Rarity | 'ALL'> = ['ALL', 'GOLD', 'PURPLE', 'BLUE', 'GREEN', 'WHITE']
const pageAuthors = usePageAuthors()

function authorSearchText(
  authors: Array<{ name: string; wikidotId: number | null }> | null | undefined,
  wikidotId: number | null | undefined
) {
  const id = Number(wikidotId)
  const cachedAuthors = Number.isFinite(id) && id > 0 ? pageAuthors.getAuthors(id) : []
  return resolveAuthorSearchText(authors, cachedAuthors)
}

const filteredOptions = computed(() => {
  const keyword = search.value.trim().toLowerCase()
  return props.options
    .filter((item) => {
      if (rarityFilter.value !== 'ALL' && item.rarity !== rarityFilter.value) return false
      if (!keyword) return true
      const target = `${item.title} ${(item.tags ?? []).filter(t => !t.startsWith('_')).join(' ')} ${authorSearchText(item.authors, item.wikidotId)} ${item.cardId}`.toLowerCase()
      return target.includes(keyword)
    })
    .sort((a, b) => {
      const rarityDiff = (raritySortWeight[a.rarity] ?? 99) - (raritySortWeight[b.rarity] ?? 99)
      if (rarityDiff !== 0) return rarityDiff
      return a.title.localeCompare(b.title, 'zh-CN')
    })
})

const PICKER_PAGE_SIZE = 36
const visibleCount = ref(PICKER_PAGE_SIZE)
const visibleOptions = computed(() => filteredOptions.value.slice(0, visibleCount.value))
const hasMore = computed(() => filteredOptions.value.length > visibleCount.value)

watch([search, rarityFilter], () => {
  visibleCount.value = PICKER_PAGE_SIZE
})

watch(() => props.open, (val) => {
  if (val) {
    search.value = ''
    rarityFilter.value = 'ALL'
    visibleCount.value = PICKER_PAGE_SIZE
  }
})
</script>

<template>
  <UiDialogRoot :open="open" @update:open="(nextOpen) => { if (!nextOpen) emit('close') }">
    <UiDialogPortal>
      <UiDialogOverlay />
      <UiDialogContent class="max-w-4xl p-0">
        <header class="flex items-start justify-between gap-3 border-b border-neutral-200/70 px-5 py-4 dark:border-neutral-700/70">
          <div>
            <h3 class="text-lg font-semibold text-neutral-900 dark:text-neutral-50">选择展示卡片</h3>
            <p class="mt-1 text-xs text-neutral-500 dark:text-neutral-400">从库存中选择一张卡片放入展示柜</p>
          </div>
          <UiDialogClose as-child>
            <UiButton variant="ghost" size="sm" class="h-9 w-9 rounded-full p-0" aria-label="关闭">X</UiButton>
          </UiDialogClose>
        </header>

        <div class="border-b border-neutral-200/70 px-5 py-3 dark:border-neutral-700/70">
          <div class="flex flex-col gap-2 md:flex-row md:items-center">
            <UiInput v-model.trim="search" type="search" placeholder="搜索卡片（标题 / 标签 / 作者）..." class="w-full text-xs md:max-w-xs" />
            <GachaRarityFilter v-model="rarityFilter" :options="rarityFilters" />
          </div>
        </div>

        <div class="max-h-[calc(100vh-14rem)] max-h-[calc(100dvh-14rem)] overflow-y-auto px-5 pb-5">
          <div v-if="loading" class="mt-4 text-center text-sm text-neutral-500 dark:text-neutral-400">加载中...</div>
          <div v-else-if="!filteredOptions.length" class="mt-4 rounded-2xl border border-dashed border-neutral-200/70 px-4 py-4 text-sm text-neutral-500 dark:border-neutral-800/70 dark:text-neutral-400">
            没有可展示的卡片。锁定、交易中或已在展示柜中的卡片不可选择。
          </div>
          <template v-else>
            <p class="mt-3 text-[11px] text-neutral-500 dark:text-neutral-400">
              显示 {{ visibleOptions.length }} / {{ filteredOptions.length }} 张
            </p>
            <div class="mt-2 gacha-card-grid--mini">
              <button
                v-for="item in visibleOptions"
                :key="`showcase-pick-${item.instanceId}`"
                type="button"
                class="showcase-picker-card"
                :disabled="busy"
                @click="emit('select', item.instanceId)"
              >
                <GachaCardMini
                  :title="item.title"
                  :rarity="item.rarity"
                  :image-url="item.imageUrl || undefined"
                  :locked="item.isLocked"
                  :affix-visual-style="item.affixVisualStyle"
                  :affix-label="item.affixLabel"
                >
                  <template #meta>
                    <span class="showcase-picker-card__meta">实例 {{ item.instanceId.slice(0, 8) }}</span>
                  </template>
                </GachaCardMini>
              </button>
            </div>
            <div v-if="hasMore" class="mt-3 flex items-center justify-center">
              <UiButton variant="outline" size="sm" @click="visibleCount += PICKER_PAGE_SIZE">
                加载更多（剩余 {{ filteredOptions.length - visibleCount }} 张）
              </UiButton>
            </div>
          </template>
        </div>
      </UiDialogContent>
    </UiDialogPortal>
  </UiDialogRoot>
</template>

<style scoped>
.showcase-picker-card {
  border-radius: 0.9rem;
  transition: transform .16s ease;
}

.showcase-picker-card:hover {
  transform: translateY(-2px);
}

.showcase-picker-card:disabled {
  opacity: 0.6;
  cursor: not-allowed;
  transform: none;
}

.showcase-picker-card__meta {
  display: inline-flex;
  border-radius: 9999px;
  padding: 1px 7px;
  font-size: 9px;
  font-weight: 600;
  color: rgb(82 82 82);
  border: 1px solid rgb(212 212 212);
  background: rgb(245 245 245 / 0.9);
}

html.dark .showcase-picker-card__meta {
  color: rgb(212 212 212);
  border-color: rgb(82 82 82);
  background: rgb(38 38 38 / 0.8);
}
</style>
