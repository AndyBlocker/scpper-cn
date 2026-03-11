<script setup lang="ts">
/**
 * 批量分解弹窗。
 *
 * 性能优化（v3 — 解决 Safari 移动端崩溃）：
 * 1. 异步分批索引构建 — 50 项/批，每批间 yield 主线程（setTimeout(0)）
 * 2. 索引就绪前不触发任何 computed 过滤（indexReady 门控）
 * 3. 渐进式渲染 — 每帧追加 20 项，RENDER_LIMIT=40 + "加载更多"
 * 4. 图片 loading="lazy" + decoding="async"（在 GachaCardListItem 中）
 */
import type { Rarity, AffixVisualStyle, AlbumPageVariant } from '~/types/gacha'
import { computed, ref, watch, nextTick, onBeforeUnmount } from 'vue'
import { formatTokens } from '~/utils/gachaFormatters'
import { rarityLabel } from '~/utils/gachaRarity'
import { resolveAffixParts, resolveAffixDisplayName, resolveAffixSignatureFromSource } from '~/utils/gachaAffix'
import { variantStackKey, estimateVariantDismantlePerCard } from '~/utils/gachaAffix'
import { usePageAuthors } from '~/composables/usePageAuthors'
import { resolveAuthorSearchText } from '~/utils/gachaAuthorSearch'
import GachaCardListItem from '~/components/gacha/GachaCardListItem.vue'
import { UiButton } from '~/components/ui/button'
import { UiInput } from '~/components/ui/input'
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
  candidates: AlbumPageVariant[]
  loading: boolean
  dismantling: boolean
  error: string | null
}>()

const emit = defineEmits<{
  close: []
  confirm: [rows: Array<{ cardId: string; count: number; affixVisualStyle: string; affixSignature: string }>, keepAtLeast: number]
}>()

// ─── 筛选状态 ────────────────────────────────────────────

const search = ref('')
const pageId = ref('')
const keepAtLeast = ref(1)
const minCount = ref(1)
const rarityFilters = ref<Rarity[]>(['WHITE', 'GREEN', 'BLUE'])
const affixFilters = ref<AffixVisualStyle[]>([])
const selectedKeys = ref<string[]>([])

const rarityOptions: Rarity[] = ['GOLD', 'PURPLE', 'BLUE', 'GREEN', 'WHITE']
const affixOptions: AffixVisualStyle[] = [
  'COLORLESS', 'PRISM', 'GOLD', 'CYAN', 'SILVER', 'MONO',
  'WILDCARD', 'SPECTRUM', 'MIRROR', 'ORBIT', 'ECHO'
]
const pageAuthors = usePageAuthors()

const RENDER_LIMIT = 40
const RENDER_BATCH = 20
const showAll = ref(false)
const confirmPending = ref(false)

// ─── 渐进式渲染 ─────────────────────────────────────────

const renderBudget = ref(0)
let renderRafId: number | null = null

function startProgressiveRender() {
  renderBudget.value = 0
  cancelProgressiveRender()
  function step() {
    const target = showAll.value ? Infinity : RENDER_LIMIT
    if (renderBudget.value < target) {
      renderBudget.value = Math.min(renderBudget.value + RENDER_BATCH, target)
      renderRafId = requestAnimationFrame(step)
    } else {
      renderRafId = null
    }
  }
  renderRafId = requestAnimationFrame(step)
}

function cancelProgressiveRender() {
  if (renderRafId != null) {
    cancelAnimationFrame(renderRafId)
    renderRafId = null
  }
}

onBeforeUnmount(() => {
  cancelProgressiveRender()
  abortIndexBuild()
})

// ─── 异步分批索引构建 ────────────────────────────────────

const INDEX_CHUNK = 50

interface CandidateIndex {
  searchText: string
  affixStyles: AffixVisualStyle[]
  stackKey: string
  dismantlePerCard: number
}

const candidateIndexMap = new WeakMap<AlbumPageVariant, CandidateIndex>()
const indexReady = ref(false)
const indexProgress = ref(0)
let indexAbortId = 0

function authorSearchText(
  authors: Array<{ name: string; wikidotId: number | null }> | null | undefined,
  wikidotId: number | null | undefined
) {
  const id = Number(wikidotId)
  const cachedAuthors = Number.isFinite(id) && id > 0 ? pageAuthors.getAuthors(id) : []
  return resolveAuthorSearchText(authors, cachedAuthors)
}

function buildOneIndex(item: AlbumPageVariant): CandidateIndex {
  let idx = candidateIndexMap.get(item)
  if (idx) return idx
  const parts = resolveAffixParts(item)
  idx = {
    searchText: `${item.cardId} ${item.title} ${(item.tags ?? []).filter(t => !t.startsWith('_')).join(' ')} ${authorSearchText(item.authors, item.wikidotId)} ${resolveAffixSignatureFromSource(item)}`.toLowerCase(),
    affixStyles: parts.map((p) => p.style),
    stackKey: variantStackKey(item),
    dismantlePerCard: estimateVariantDismantlePerCard(item)
  }
  candidateIndexMap.set(item, idx)
  return idx
}

/** 获取已有索引（仅在 indexReady 后调用） */
function getIndex(item: AlbumPageVariant): CandidateIndex {
  return candidateIndexMap.get(item) || buildOneIndex(item)
}

function abortIndexBuild() {
  indexAbortId++
}

async function buildIndexAsync(items: AlbumPageVariant[]) {
  abortIndexBuild()
  const myId = indexAbortId
  indexReady.value = false
  indexProgress.value = 0

  for (let i = 0; i < items.length; i += INDEX_CHUNK) {
    if (indexAbortId !== myId) return
    const end = Math.min(i + INDEX_CHUNK, items.length)
    for (let j = i; j < end; j++) {
      buildOneIndex(items[j])
    }
    indexProgress.value = end
    // 每批后让出主线程
    if (end < items.length) {
      await new Promise<void>((r) => setTimeout(r, 0))
    }
  }

  if (indexAbortId !== myId) return
  indexReady.value = true
  await nextTick()
  startProgressiveRender()
}

// ─── 候选映射（仅索引就绪后生效）────────────────────────

const candidateMap = computed(() => {
  if (!indexReady.value) return new Map<string, AlbumPageVariant>()
  const map = new Map<string, AlbumPageVariant>()
  for (const item of props.candidates) {
    map.set(getIndex(item).stackKey, item)
  }
  return map
})

const filteredCandidates = computed(() => {
  if (!indexReady.value) return []
  const keyword = search.value.trim().toLowerCase()
  const min = Math.max(1, Math.floor(Number(minCount.value || 1)))
  const pidFilter = Math.floor(Number(pageId.value || 0))
  const hasAffixFilter = affixFilters.value.length > 0
  const hasRarityFilter = rarityFilters.value.length > 0
  return props.candidates.filter((item) => {
    if (hasRarityFilter && !rarityFilters.value.includes(item.rarity)) return false
    if (item.count < min) return false
    if (pidFilter > 0 && Number(item.pageId || 0) !== pidFilter) return false
    const idx = getIndex(item)
    if (hasAffixFilter) {
      if (!idx.affixStyles.some((s) => affixFilters.value.includes(s))) return false
    }
    if (!keyword) return true
    return idx.searchText.includes(keyword)
  })
})

const selectedRows = computed(() => {
  if (!indexReady.value) return []
  const keep = Math.max(0, Math.floor(Number(keepAtLeast.value || 0)))
  return selectedKeys.value
    .map((key) => {
      const item = candidateMap.value.get(key)
      if (!item) return null
      const idx = getIndex(item)
      const cnt = Math.max(0, Math.floor(Number(item.count || 0)) - Math.max(item.lockedCount ?? 0, keep))
      return { key, item, dismantleCount: cnt, estimatedReward: idx.dismantlePerCard * cnt }
    })
    .filter((r): r is NonNullable<typeof r> => !!r && r.dismantleCount > 0)
})

const selectedVariantCount = computed(() => selectedRows.value.length)
const selectedCardCount = computed(() => selectedRows.value.reduce((s, r) => s + r.dismantleCount, 0))
const selectedRewardEstimate = computed(() => selectedRows.value.reduce((s, r) => s + r.estimatedReward, 0))

const visibleCandidates = computed(() => {
  const limit = showAll.value ? renderBudget.value : Math.min(renderBudget.value, RENDER_LIMIT)
  return filteredCandidates.value.slice(0, limit)
})
const hasMore = computed(() => !showAll.value && filteredCandidates.value.length > RENDER_LIMIT)

// ─── 操作函数 ────────────────────────────────────────────

function isSelected(item: AlbumPageVariant) {
  return selectedKeys.value.includes(getIndex(item).stackKey)
}

function toggleSelection(item: AlbumPageVariant) {
  const key = getIndex(item).stackKey
  if (selectedKeys.value.includes(key)) {
    selectedKeys.value = selectedKeys.value.filter((k) => k !== key)
  } else {
    selectedKeys.value = [...selectedKeys.value, key]
  }
}

function toggleRarity(rarity: Rarity) {
  if (rarityFilters.value.includes(rarity)) {
    rarityFilters.value = rarityFilters.value.filter((r) => r !== rarity)
  } else {
    rarityFilters.value = [...rarityFilters.value, rarity]
  }
}

function toggleAffix(style: AffixVisualStyle) {
  if (affixFilters.value.includes(style)) {
    affixFilters.value = affixFilters.value.filter((s) => s !== style)
  } else {
    affixFilters.value = [...affixFilters.value, style]
  }
}

function resetFilters() {
  search.value = ''
  pageId.value = ''
  minCount.value = 1
  keepAtLeast.value = 1
  rarityFilters.value = ['WHITE', 'GREEN', 'BLUE']
  affixFilters.value = []
}

function clearSelection() { selectedKeys.value = [] }

function selectAllFiltered() {
  const keep = Math.max(0, Math.floor(Number(keepAtLeast.value || 0)))
  const keys = filteredCandidates.value
    .filter((item) => Math.max(0, Number(item.count || 0) - keep) > 0)
    .map((item) => getIndex(item).stackKey)
  selectedKeys.value = Array.from(new Set([...selectedKeys.value, ...keys]))
}

function handleConfirm() {
  if (confirmPending.value || props.dismantling || props.loading || !indexReady.value || selectedRows.value.length <= 0) {
    return
  }
  confirmPending.value = true
  emit('confirm', selectedRows.value.map((r) => ({
    cardId: r.item.cardId,
    count: r.dismantleCount,
    affixVisualStyle: r.item.affixVisualStyle || 'NONE',
    affixSignature: r.item.affixSignature || resolveAffixSignatureFromSource(r.item)
  })), Math.max(0, Math.floor(Number(keepAtLeast.value || 0))))
}

function dismantleCountFor(item: AlbumPageVariant) {
  return Math.max(0, item.count - Math.max(item.lockedCount ?? 0, Math.max(0, Number(keepAtLeast.value || 0))))
}

function dismantleRewardFor(item: AlbumPageVariant) {
  return getIndex(item).dismantlePerCard * dismantleCountFor(item)
}

// ─── 生命周期 ────────────────────────────────────────────

// 打开时重置
watch(() => props.open, (val) => {
  if (val) {
    confirmPending.value = false
    resetFilters()
    clearSelection()
    showAll.value = false
    renderBudget.value = 0
    indexReady.value = false
    // 如果数据已就绪，立即开始构建索引
    if (props.candidates.length > 0 && !props.loading) {
      void buildIndexAsync(props.candidates)
    }
  } else {
    confirmPending.value = false
    cancelProgressiveRender()
    abortIndexBuild()
  }
})

watch(() => props.dismantling, (dismantling) => {
  if (!dismantling) {
    confirmPending.value = false
  }
})

// 加载完成 → 开始构建索引
watch(() => props.loading, (loading, prevLoading) => {
  if (prevLoading && !loading && props.open) {
    void buildIndexAsync(props.candidates)
  }
})

// candidates 引用变化（如父组件刷新数据）
watch(() => props.candidates, (items) => {
  if (props.open && !props.loading && items.length > 0) {
    void buildIndexAsync(items)
  }
})

function handleOpenChange(nextOpen: boolean) {
  if (!nextOpen) emit('close')
}
</script>

<template>
  <UiDialogRoot :open="open" @update:open="handleOpenChange">
    <UiDialogPortal>
      <UiDialogOverlay />
      <UiDialogContent class="max-w-5xl">
        <!-- 头部 -->
        <header class="flex items-start justify-between gap-3">
          <div>
            <h3 class="text-base font-semibold text-neutral-900 dark:text-neutral-50">勾选批量分解</h3>
            <p class="text-xs text-neutral-500 dark:text-neutral-400">
              使用筛选器定位变体后勾选分解。放置中的实例会被后端自动拦截，不会误分解。
            </p>
          </div>
          <UiDialogClose as-child>
            <UiButton variant="ghost" size="sm" class="h-9 w-9 rounded-full p-0" aria-label="关闭批量分解弹窗">
              X
            </UiButton>
          </UiDialogClose>
        </header>

        <div class="mt-3 flex-1 min-h-0 space-y-3 overflow-y-auto text-sm text-neutral-600 dark:text-neutral-300">
          <!-- 筛选输入 -->
          <div class="grid gap-2 md:grid-cols-2 xl:grid-cols-4">
            <label class="flex flex-col gap-1 text-sm text-neutral-500 dark:text-neutral-400">
              关键词
              <UiInput v-model.trim="search" type="search" placeholder="标题 / 卡片 ID / 标签 / 作者" />
            </label>
            <label class="flex flex-col gap-1 text-sm text-neutral-500 dark:text-neutral-400">
              每变体保留
              <UiInput v-model.number="keepAtLeast" type="number" min="0" max="999" />
            </label>
            <label class="flex flex-col gap-1 text-sm text-neutral-500 dark:text-neutral-400">
              最少持有数量
              <UiInput v-model.number="minCount" type="number" min="1" max="999" />
            </label>
            <label class="flex flex-col gap-1 text-sm text-neutral-500 dark:text-neutral-400">
              页面 ID（可选）
              <UiInput v-model.trim="pageId" type="text" inputmode="numeric" placeholder="例如 421" />
            </label>
          </div>

          <!-- 稀有度过滤 -->
          <div class="space-y-2">
            <p class="text-xs font-semibold uppercase tracking-[0.12em] text-neutral-500 dark:text-neutral-400">稀有度过滤</p>
            <div class="flex flex-wrap gap-1 text-[11px]">
              <button
                v-for="rarity in rarityOptions"
                :key="`batch-filter-rarity-${rarity}`"
                type="button"
                class="inline-flex items-center rounded-full border px-2.5 py-1 font-semibold transition"
                :class="rarityFilters.includes(rarity)
                  ? 'border-[rgb(var(--accent-strong))]/45 bg-[rgb(var(--accent-strong))]/10 text-[rgb(var(--accent-strong))]'
                  : 'border-neutral-200 bg-white text-neutral-500 hover:border-neutral-300 hover:text-neutral-800 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300 dark:hover:border-neutral-600 dark:hover:text-neutral-100'"
                @click="toggleRarity(rarity)"
              >
                {{ rarityLabel(rarity) }}
              </button>
            </div>
          </div>

          <!-- 词条过滤 -->
          <div class="space-y-2">
            <p class="text-xs font-semibold uppercase tracking-[0.12em] text-neutral-500 dark:text-neutral-400">词条过滤</p>
            <div class="flex flex-wrap gap-1 text-[11px]">
              <button
                v-for="style in affixOptions"
                :key="`batch-filter-affix-${style}`"
                type="button"
                class="inline-flex items-center rounded-full border px-2.5 py-1 font-semibold transition"
                :class="affixFilters.includes(style)
                  ? 'border-cyan-300 bg-cyan-50 text-cyan-700 dark:border-cyan-500/50 dark:bg-cyan-500/10 dark:text-cyan-200'
                  : 'border-neutral-200 bg-white text-neutral-500 hover:border-neutral-300 hover:text-neutral-800 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300 dark:hover:border-neutral-600 dark:hover:text-neutral-100'"
                @click="toggleAffix(style)"
              >
                {{ resolveAffixDisplayName(style) }}
              </button>
            </div>
          </div>

          <!-- 操作按钮 + 统计 -->
          <div class="flex flex-wrap items-center gap-1.5">
            <UiButton
              variant="outline"
              size="sm"
              :disabled="loading || dismantling || !indexReady"
              @click="selectAllFiltered"
            >
              勾选当前筛选
            </UiButton>
            <UiButton
              variant="outline"
              size="sm"
              :disabled="loading || dismantling || !indexReady"
              @click="clearSelection"
            >
              清空勾选
            </UiButton>
            <UiButton
              variant="outline"
              size="sm"
              :disabled="loading || dismantling || !indexReady"
              @click="resetFilters"
            >
              重置过滤器
            </UiButton>
            <span class="text-xs text-neutral-500 dark:text-neutral-400">
              已选 {{ selectedVariantCount }} 变体 · 预计分解 {{ formatTokens(selectedCardCount) }} 张 · 预计返还 {{ formatTokens(selectedRewardEstimate) }} Token
            </span>
          </div>

          <!-- 候选列表 -->
          <div class="rounded-lg border border-neutral-200/70 bg-neutral-50/70 p-2 dark:border-neutral-800/70 dark:bg-neutral-900/60">
            <div v-if="loading || !indexReady" class="px-3 py-8 text-center text-sm text-neutral-500 dark:text-neutral-400">
              <template v-if="loading">正在加载候选变体...</template>
              <template v-else>正在准备索引 ({{ indexProgress }}/{{ candidates.length }})...</template>
            </div>
            <div v-else-if="filteredCandidates.length" class="max-h-[min(40vh,24rem)] space-y-1 overflow-y-auto pr-1">
              <GachaCardListItem
                v-for="item in visibleCandidates"
                :key="`batch-candidate-${getIndex(item).stackKey}`"
                :title="item.title"
                :rarity="item.rarity"
                :image-url="item.imageUrl"
                :count="item.count"
                :locked="(item.lockedCount ?? 0) >= item.count"
                :retired="item.isRetired"
                :affix-visual-style="item.affixVisualStyle"
                :affix-signature="item.affixSignature"
                :affix-styles="item.affixStyles"
                :affix-style-counts="item.affixStyleCounts"
                :affix-label="item.affixLabel"
                :dismantle-count="dismantleCountFor(item)"
                :estimated-reward="dismantleRewardFor(item)"
                :selected="isSelected(item)"
                @click="toggleSelection(item)"
              />
              <button
                v-if="hasMore"
                type="button"
                class="mt-2 w-full rounded-lg bg-neutral-100 px-3 py-2 text-center text-xs font-medium text-neutral-600 transition hover:bg-neutral-200 dark:bg-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-700"
                @click="showAll = true; startProgressiveRender()"
              >
                加载更多 ({{ filteredCandidates.length - RENDER_LIMIT }} 项)
              </button>
            </div>
            <p v-else class="px-3 py-8 text-center text-sm text-neutral-500 dark:text-neutral-400">
              当前过滤条件下没有可分解候选。
            </p>
          </div>

          <!-- 错误提示 -->
          <transition name="fade">
            <p
              v-if="error"
              class="rounded-xl border border-rose-200/70 bg-rose-50/70 px-3 py-2 text-sm text-rose-600 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-200"
            >
              {{ error }}
            </p>
          </transition>
        </div>

        <!-- 底部操作 -->
        <footer class="mt-3 flex items-center justify-end gap-3">
          <UiDialogClose as-child>
            <UiButton variant="outline">取消</UiButton>
          </UiDialogClose>
          <UiButton
            variant="destructive"
            :disabled="dismantling || loading || !indexReady || selectedRows.length <= 0"
            @click="handleConfirm"
          >
            <span v-if="dismantling">处理中...</span>
            <span v-else>确认分解已勾选</span>
          </UiButton>
        </footer>
      </UiDialogContent>
    </UiDialogPortal>
  </UiDialogRoot>
</template>

<style scoped>
/* Styles handled by GachaCardListItem component */
</style>
