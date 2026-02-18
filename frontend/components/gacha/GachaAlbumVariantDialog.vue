<script setup lang="ts">
/**
 * 页面变体详情弹窗。
 * 从 album.vue 提取，展示某个页面下所有变体卡片。
 */
import type { Rarity, AffixVisualStyle, AlbumPageVariant, AlbumPageDetail } from '~/types/gacha'
import { computed, nextTick, ref, watch } from 'vue'
import { formatTokens } from '~/utils/gachaFormatters'
import { raritySortWeight, rarityLabel } from '~/utils/gachaRarity'
import {
  resolveAffixParts,
  formatAffixPartsLabel, resolveAffixDisplayName, resolveAffixSignatureFromSource,
  affixDisplayOrder
} from '~/utils/gachaAffix'
import { variantStackKey, estimateVariantDismantlePerCard } from '~/utils/gachaAffix'
import { usePageAuthors } from '~/composables/usePageAuthors'
import { resolveAuthorSearchText } from '~/utils/gachaAuthorSearch'
import GachaAffixChip from '~/components/gacha/GachaAffixChip.vue'
import GachaRarityFilter from '~/components/gacha/GachaRarityFilter.vue'
import GachaRarityStars from '~/components/gacha/GachaRarityStars.vue'
import { UiButton } from '~/components/ui/button'
import { UiInput } from '~/components/ui/input'
import { UiSelectRoot, UiSelectTrigger, UiSelectContent, UiSelectItem } from '~/components/ui/select'
import {
  UiDialogRoot,
  UiDialogPortal,
  UiDialogOverlay,
  UiDialogContent,
  UiDialogClose
} from '~/components/ui/dialog'

// ─── Props / Emits ───────────────────────────────────────

const props = defineProps<{
  open: boolean
  pageId: number | null
  pageMeta: AlbumPageDetail | null
  pageTitle: string | null
  pageWikidotId: number | null
  variants: AlbumPageVariant[]
  loading: boolean
  dismantling: boolean
  dismantlingVariantKey: string | null
}>()

const emit = defineEmits<{
  close: []
  dismantle: [variant: AlbumPageVariant]
}>()

// ─── 内部筛选 / 排序 ────────────────────────────────────

const searchKeyword = ref('')
const rarityFilter = ref<Rarity | 'ALL'>('ALL')
const affixFilter = ref<AffixVisualStyle | 'ALL'>('ALL')
const sortMode = ref<'RARITY' | 'COUNT' | 'AFFIX'>('RARITY')
const variantCardDensity = ref<'default' | 'compact'>('compact')
const searchInputRef = ref<{ focus: () => void } | null>(null)
const pageAuthors = usePageAuthors()

const rarityFilterOptions: Array<Rarity | 'ALL'> = ['ALL', 'GOLD', 'PURPLE', 'BLUE', 'GREEN', 'WHITE']

function authorSearchText(
  authors: Array<{ name: string; wikidotId: number | null }> | null | undefined,
  wikidotId: number | null | undefined
) {
  const id = Number(wikidotId)
  const cachedAuthors = Number.isFinite(id) && id > 0 ? pageAuthors.getAuthors(id) : []
  return resolveAuthorSearchText(authors, cachedAuthors)
}

function searchableTags(tags: string[] | null | undefined) {
  return (tags ?? []).filter((tag) => {
    const normalized = String(tag || '').trim()
    return normalized.length > 0 && !normalized.startsWith('_')
  })
}

const affixFilterOptions = computed<Array<AffixVisualStyle | 'ALL'>>(() => {
  const styles = new Set<AffixVisualStyle>()
  props.variants.forEach((v) => {
    resolveAffixParts(v).forEach((p) => {
      if (p.style !== 'NONE') styles.add(p.style)
    })
  })
  const affixWeight = Object.fromEntries(affixDisplayOrder.map((s, i) => [s, i])) as Record<AffixVisualStyle, number>
  return ['ALL', ...Array.from(styles).sort((a, b) => (affixWeight[a] ?? 99) - (affixWeight[b] ?? 99))]
})

const variantOwnedTotal = computed(() =>
  props.variants.reduce((sum, v) => sum + v.count, 0)
)
const filteredOwnedTotal = computed(() =>
  filteredVariants.value.reduce((sum, v) => sum + v.count, 0)
)
const filteredEstimatedReward = computed(() =>
  filteredVariants.value.reduce((sum, v) => sum + estimateVariantDismantlePerCard(v) * v.count, 0)
)

const filteredVariants = computed(() => {
  const keyword = searchKeyword.value.trim().toLowerCase()
  return [...props.variants]
    .filter((v) => {
      if (rarityFilter.value !== 'ALL' && v.rarity !== rarityFilter.value) return false
      if (affixFilter.value !== 'ALL') {
        if (!resolveAffixParts(v).some((p) => p.style === affixFilter.value)) return false
      }
      if (!keyword) return true
      const target = `${v.cardId} ${v.title} ${searchableTags(v.tags).join(' ')} ${authorSearchText(v.authors, v.wikidotId)} ${resolveAffixSignatureFromSource(v)}`.toLowerCase()
      return target.includes(keyword)
    })
    .sort((a, b) => {
      if (sortMode.value === 'COUNT') {
        if (a.count !== b.count) return b.count - a.count
      } else if (sortMode.value === 'AFFIX') {
        const diff = resolveAffixParts(b).reduce((s, p) => s + p.count, 0)
          - resolveAffixParts(a).reduce((s, p) => s + p.count, 0)
        if (diff !== 0) return diff
      }
      const rd = (raritySortWeight[a.rarity] ?? 99) - (raritySortWeight[b.rarity] ?? 99)
      if (rd !== 0) return rd
      if (a.count !== b.count) return b.count - a.count
      return a.title.localeCompare(b.title, 'zh-CN')
    })
})

// 打开时重置筛选
watch(() => props.open, (val) => {
  if (val) {
    searchKeyword.value = ''
    rarityFilter.value = 'ALL'
    affixFilter.value = 'ALL'
    sortMode.value = 'RARITY'
    variantCardDensity.value = 'compact'
    nextTick(() => searchInputRef.value?.focus())
  }
})
</script>

<template>
  <UiDialogRoot :open="open" @update:open="(nextOpen) => { if (!nextOpen) emit('close') }">
    <UiDialogPortal>
      <UiDialogOverlay />
      <UiDialogContent class="max-w-5xl p-0">
          <!-- 头部 -->
          <header class="flex flex-wrap items-start justify-between gap-3 border-b border-neutral-200/60 px-5 py-4 dark:border-neutral-800/60">
            <div>
              <h3 class="text-lg font-semibold text-neutral-900 dark:text-neutral-50">
                {{ pageMeta?.title || pageTitle || (pageId ? `页面 #${pageId}` : '页面变体详情') }}
              </h3>
              <p class="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
                #{{ pageId ?? '-' }} · 变体 {{ pageMeta?.variantCount ?? variants.length }} · 持有 {{ pageMeta?.totalCount ?? variantOwnedTotal }}
              </p>
            </div>
            <div class="flex items-center gap-2">
              <NuxtLink
                v-if="pageWikidotId"
                :to="`/page/${pageWikidotId}`"
                class="inline-flex items-center justify-center rounded-xl border border-neutral-200 px-3 py-1.5 text-xs font-medium text-neutral-600 transition hover:border-neutral-300 hover:text-neutral-900 dark:border-neutral-700 dark:text-neutral-200 dark:hover:border-neutral-600 dark:hover:text-neutral-50"
              >
                查看页面
              </NuxtLink>
              <UiDialogClose as-child>
                <UiButton variant="ghost" size="sm" class="h-9 w-9 rounded-full p-0" aria-label="关闭页面变体详情">
                  X
                </UiButton>
              </UiDialogClose>
            </div>
          </header>

          <!-- 内容区 -->
          <div class="flex-1 overflow-y-auto px-5 pb-5">
            <div v-if="loading" class="mt-4 rounded-2xl border border-dashed border-neutral-200/70 px-4 py-4 text-sm text-neutral-500 dark:border-neutral-800/70 dark:text-neutral-400">
              正在加载页面变体...
            </div>

            <div v-else-if="variants.length" class="mt-3 space-y-3">
              <!-- 搜索 / 排序 / 筛选 -->
              <div class="rounded-2xl border border-neutral-200/70 bg-neutral-50/85 p-3 dark:border-neutral-800/70 dark:bg-neutral-900/60">
                <div class="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
                  <div class="flex flex-wrap items-center gap-2">
                    <UiInput
                      ref="searchInputRef"
                      v-model.trim="searchKeyword"
                      type="search"
                      placeholder="搜索标题 / 词条 / 标签 / 作者"
                      class="w-52 text-xs"
                    />
                    <UiSelectRoot v-model="sortMode">
                      <UiSelectTrigger class="w-36" placeholder="选择排序" />
                      <UiSelectContent>
                        <UiSelectItem value="RARITY">按稀有度</UiSelectItem>
                        <UiSelectItem value="COUNT">按持有数量</UiSelectItem>
                        <UiSelectItem value="AFFIX">按词条复杂度</UiSelectItem>
                      </UiSelectContent>
                    </UiSelectRoot>
                    <div class="flex items-center gap-1 rounded-xl border border-neutral-200/75 bg-white/80 p-1 text-[11px] dark:border-neutral-700/70 dark:bg-neutral-900/70">
                      <button
                        type="button"
                        class="rounded-lg px-2 py-1 font-semibold transition"
                        :class="variantCardDensity === 'compact'
                          ? 'bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900'
                          : 'text-neutral-500 hover:text-neutral-800 dark:text-neutral-400 dark:hover:text-neutral-100'"
                        @click="variantCardDensity = 'compact'"
                      >
                        小图
                      </button>
                      <button
                        type="button"
                        class="rounded-lg px-2 py-1 font-semibold transition"
                        :class="variantCardDensity === 'default'
                          ? 'bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900'
                          : 'text-neutral-500 hover:text-neutral-800 dark:text-neutral-400 dark:hover:text-neutral-100'"
                        @click="variantCardDensity = 'default'"
                      >
                        标准
                      </button>
                    </div>
                  </div>
                  <p class="text-xs text-neutral-500 dark:text-neutral-400">
                    展示 {{ filteredVariants.length }} / {{ variants.length }} 个变体
                  </p>
                </div>

                <!-- 稀有度筛选 -->
                <div class="mt-2">
                  <GachaRarityFilter
                    v-model="rarityFilter"
                    :options="rarityFilterOptions"
                    all-label="全部品质"
                  />
                </div>

                <!-- 词条筛选 -->
                <div class="mt-2 flex flex-wrap items-center gap-1.5 text-[11px]">
                  <button
                    v-for="style in affixFilterOptions"
                    :key="`variant-affix-${style}`"
                    type="button"
                    class="inline-flex items-center rounded-full border px-2.5 py-1 font-semibold transition"
                    :class="affixFilter === style
                      ? 'border-cyan-300 bg-cyan-50 text-cyan-700 dark:border-cyan-500/50 dark:bg-cyan-500/10 dark:text-cyan-200'
                      : 'border-neutral-200 bg-white text-neutral-500 hover:border-neutral-300 hover:text-neutral-800 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300 dark:hover:border-neutral-600 dark:hover:text-neutral-100'"
                    @click="affixFilter = style"
                  >
                    {{ style === 'ALL' ? '全部词条' : resolveAffixDisplayName(style) }}
                  </button>
                </div>
              </div>

              <section class="variant-summary-grid">
                <article class="variant-summary-tile">
                  <p class="variant-summary-label">页面总变体</p>
                  <p class="variant-summary-value">{{ variants.length }}</p>
                </article>
                <article class="variant-summary-tile">
                  <p class="variant-summary-label">当前筛选变体</p>
                  <p class="variant-summary-value">{{ filteredVariants.length }}</p>
                </article>
                <article class="variant-summary-tile">
                  <p class="variant-summary-label">筛选持有总数</p>
                  <p class="variant-summary-value">{{ filteredOwnedTotal }}</p>
                </article>
                <article class="variant-summary-tile">
                  <p class="variant-summary-label">分解估算返还</p>
                  <p class="variant-summary-value">{{ formatTokens(filteredEstimatedReward) }}</p>
                </article>
              </section>

              <!-- 变体卡片网格 -->
              <div v-if="filteredVariants.length" class="variant-card-grid">
                <article
                  v-for="variant in filteredVariants"
                  :key="variantStackKey(variant)"
                  class="album-variant-tile variant-stack-card rounded-2xl border border-neutral-200/70 bg-white/88 p-2.5 shadow-sm dark:border-neutral-800/70 dark:bg-neutral-900/70"
                >
                  <div class="mb-2.5 flex items-center justify-between gap-2 rounded-xl border border-neutral-200/75 bg-white/80 px-2.5 py-1.5 dark:border-neutral-700/70 dark:bg-neutral-900/75">
                    <div class="min-w-0">
                      <p class="truncate text-[11px] font-semibold uppercase tracking-[0.12em] text-neutral-500 dark:text-neutral-400">
                        {{ rarityLabel(variant.rarity) }}
                      </p>
                      <p class="truncate text-[11px] text-neutral-500 dark:text-neutral-400">
                        {{ variantStackKey(variant) }}
                      </p>
                    </div>
                    <div class="flex items-center gap-1.5">
                      <span class="inline-flex rounded-full border border-rose-300/40 bg-rose-500/10 px-2 py-0.5 text-[10px] font-semibold text-rose-700 dark:border-rose-500/35 dark:bg-rose-500/15 dark:text-rose-200">
                        ×{{ variant.count }}
                      </span>
                      <GachaRarityStars :rarity="variant.rarity" />
                    </div>
                  </div>

                  <GachaCard
                    :title="variant.title"
                    :rarity="variant.rarity"
                    :tags="variant.tags"
                    :authors="variant.authors"
                    :wikidot-id="variant.wikidotId"
                    :count="variant.count"
                    :image-url="variant.imageUrl || undefined"
                    :affix-visual-style="variant.affixVisualStyle"
                    :affix-signature="variant.affixSignature"
                    :affix-styles="variant.affixStyles"
                    :affix-style-counts="variant.affixStyleCounts"
                    :density="variantCardDensity"
                  />
                  <div class="mt-2.5 space-y-2 rounded-xl border border-dashed border-neutral-200/80 bg-white/75 p-2 dark:border-neutral-700/70 dark:bg-neutral-900/60">
                    <div class="flex flex-wrap gap-1.5 text-[10px]">
                      <GachaAffixChip
                        v-for="part in resolveAffixParts(variant)"
                        :key="`variant-part-${variantStackKey(variant)}-${part.style}-${part.count}`"
                        :style="part.style"
                        :count="part.count"
                      />
                    </div>
                    <div class="flex flex-wrap gap-2 text-[11px] text-neutral-500 dark:text-neutral-400">
                      <span class="rounded-full bg-neutral-200/70 px-2 py-0.5 dark:bg-neutral-800/80">词条 {{ formatAffixPartsLabel(variant) }}</span>
                      <span class="rounded-full bg-neutral-200/70 px-2 py-0.5 dark:bg-neutral-800/80">单张返还约 {{ formatTokens(estimateVariantDismantlePerCard(variant)) }}</span>
                    </div>
                    <div class="flex items-center justify-end">
                      <UiButton
                        variant="outline"
                        size="sm"
                        :disabled="dismantling"
                        @click="emit('dismantle', variant)"
                      >
                        {{ dismantlingVariantKey === variantStackKey(variant) ? '处理中...' : '分解' }}
                      </UiButton>
                    </div>
                  </div>
                </article>
              </div>

              <p v-else class="rounded-2xl border border-dashed border-neutral-200/70 px-4 py-4 text-sm text-neutral-500 dark:border-neutral-800/70 dark:text-neutral-400">
                当前筛选下暂无可展示变体。
              </p>
            </div>

            <p v-else class="mt-4 rounded-2xl border border-dashed border-neutral-200/70 px-4 py-4 text-sm text-neutral-500 dark:border-neutral-800/70 dark:text-neutral-400">
              当前页面暂无可展示变体。
            </p>
          </div>
      </UiDialogContent>
    </UiDialogPortal>
  </UiDialogRoot>
</template>

<style scoped>
.variant-summary-grid {
  display: grid;
  gap: 0.5rem;
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.variant-summary-tile {
  border-radius: 0.82rem;
  border: 1px solid rgba(148, 163, 184, 0.28);
  background: rgba(255, 255, 255, 0.76);
  padding: 0.58rem 0.72rem;
}

html.dark .variant-summary-tile {
  border-color: rgba(100, 116, 139, 0.44);
  background: rgba(15, 23, 42, 0.6);
}

.variant-summary-label {
  font-size: 0.68rem;
  color: rgb(100 116 139);
}

html.dark .variant-summary-label {
  color: rgb(148 163 184);
}

.variant-summary-value {
  margin-top: 0.1rem;
  font-size: 1.1rem;
  font-weight: 700;
  color: rgb(15 23 42);
}

html.dark .variant-summary-value {
  color: rgb(241 245 249);
}

.variant-stack-card {
  position: relative;
}

.variant-stack-card::before {
  content: '';
  pointer-events: none;
  position: absolute;
  inset-inline: 0;
  top: 0;
  height: 0.24rem;
  border-top-left-radius: 1rem;
  border-top-right-radius: 1rem;
  background: linear-gradient(90deg, rgba(244, 63, 94, 0.42), rgba(236, 72, 153, 0.62), rgba(244, 63, 94, 0.42));
}

@media (max-width: 640px) {
  .variant-summary-grid {
    grid-template-columns: repeat(1, minmax(0, 1fr));
  }
}
</style>
