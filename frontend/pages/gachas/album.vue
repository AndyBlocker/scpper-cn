<template>
  <GachaPageShell
    :auth-pending="authPending"
    :show-binding-block="showBindingBlock"
    :wallet-balance="walletBalance"
    feature-name="图鉴"
    page="album"
  >
    <div class="gacha-page-flow">
      <GachaErrorBanner :error="errorBanner" :success="successBanner" />

      <div class="flex items-center gap-2">
        <button
          type="button"
          class="gacha-tab-btn"
          :class="{ 'is-active': activeTab === 'album' }"
          @click="setTab('album')"
        >
          图鉴
        </button>
        <button
          type="button"
          class="gacha-tab-btn"
          :class="{ 'is-active': activeTab === 'showcase' }"
          @click="handleShowcaseTab"
        >
          展示柜
        </button>
        <button
          type="button"
          class="gacha-tab-btn"
          :class="{ 'is-active': activeTab === 'progress' }"
          @click="setTab('progress')"
        >
          进度
        </button>
      </div>

      <Transition name="slide-fade" mode="out-in">
        <!-- Progress Tab -->
        <section
          v-if="activeTab === 'progress'"
          key="progress-tab"
          class="surface-card p-5"
        >
          <header class="gacha-panel-head">
            <h2 class="gacha-panel-title">收集进度</h2>
            <UiButton variant="outline" size="sm" @click="refreshProgress">刷新</UiButton>
          </header>

          <div v-if="loadingProgress" class="mt-4 flex flex-col gap-3">
            <GachaSkeleton variant="metric" />
            <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <GachaSkeleton v-for="i in 5" :key="i" variant="row" />
            </div>
          </div>
          <div v-else-if="progressData" class="mt-4 space-y-4">
            <!-- Three-layer progress overview -->
            <div class="grid gap-3 sm:grid-cols-3">
              <div class="surface-recessed p-4">
                <div class="flex items-center justify-between gap-3">
                  <span class="gacha-text-body text-xs font-semibold">页面收集</span>
                  <span class="gacha-text-kpi" style="font-size:1rem">{{ pagesPercent }}%</span>
                </div>
                <span class="gacha-text-body text-sm font-semibold">{{ progressData.pages.collected }} / {{ progressData.pages.total }}</span>
                <UiProgress class="mt-2 h-2" :model-value="pagesPercent" />
              </div>
              <div class="surface-recessed p-4">
                <div class="flex items-center justify-between gap-3">
                  <span class="gacha-text-body text-xs font-semibold">异画收集</span>
                  <span class="gacha-text-kpi" style="font-size:1rem">{{ imageVariantsPercent }}%</span>
                </div>
                <span class="gacha-text-body text-sm font-semibold">{{ progressData.imageVariants.collected }} / {{ progressData.imageVariants.total }}</span>
                <UiProgress class="mt-2 h-2" :model-value="imageVariantsPercent" />
              </div>
              <div class="surface-recessed p-4">
                <div class="flex items-center justify-between gap-3">
                  <span class="gacha-text-body text-xs font-semibold">镀层收集</span>
                  <span class="gacha-text-kpi" style="font-size:1rem">{{ coatingsPercent }}%</span>
                </div>
                <span class="gacha-text-body text-sm font-semibold">{{ progressData.coatings.collected }} / {{ progressData.coatings.total }}</span>
                <UiProgress class="mt-2 h-2" :model-value="coatingsPercent" />
              </div>
            </div>

            <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <article
                v-for="entry in rarityEntries"
                :key="entry.rarity"
                class="surface-recessed p-3"
              >
                <div class="flex items-center justify-between gap-2">
                  <span class="text-sm font-semibold" style="color:var(--g-text-primary)">{{ rarityLabel(entry.rarity) }}</span>
                  <span class="text-sm font-semibold" style="color:var(--g-text-secondary)">{{ entry.collected }} / {{ entry.total }}</span>
                </div>
                <div class="mt-2 h-2 w-full overflow-hidden rounded-full" :style="{ background: 'var(--g-surface-deep)' }">
                  <div
                    class="gacha-progress-animate h-full rounded-full"
                    :style="{
                      width: entry.percent + '%',
                      background: rarityBarColor(entry.rarity)
                    }"
                  />
                </div>
              </article>
            </div>
          </div>
          <GachaEmptyState v-else icon="📊" title="无数据" class="mt-4" />
        </section>

        <!-- Showcase Tab -->
        <section
          v-else-if="activeTab === 'showcase'"
          key="showcase-tab"
          class="surface-card p-5"
        >
          <header class="gacha-panel-head">
            <h2 class="gacha-panel-title">展示柜</h2>
          </header>
          <div class="mt-4">
            <GachaShowcasePanel
              :showcases="showcase.showcases.value"
              :meta="showcase.meta.value"
              :loading="showcase.loadingShowcases.value"
              :busy="showcase.showcaseBusy.value"
              :picker-options="showcasePickerOptions"
              :picker-loading="loadingShowcasePicker"
              :wallet-balance="walletBalance"
              @create="showcase.createShowcase"
              @rename="showcase.renameShowcase"
              @delete="showcase.deleteShowcase"
              @set-slot="showcase.setSlot"
              @clear-slot="showcase.clearSlot"
              @refresh="refreshShowcaseTabManually"
              @load-picker="loadShowcasePickerOptions"
            />
          </div>
        </section>

        <!-- Album Tab -->
        <div v-else key="album-tab" class="gacha-page-flow gacha-page-enter">
          <section class="surface-card p-4">
            <div class="flex flex-wrap items-center gap-3">
              <UiInput
                v-model.trim="searchKeyword"
                type="search"
                placeholder="搜索卡牌..."
                class="w-48 text-sm"
              />
              <UiButton variant="outline" size="sm" :disabled="loadingPages" @click="refreshPages(true)">刷新</UiButton>
              <UiButton
                variant="outline"
                size="sm"
                :disabled="loadingPages || batchDismantling"
                @click="openQuickDismantleDialog"
              >
                快速分解
              </UiButton>
              <UiButton
                variant="outline"
                size="sm"
                :disabled="loadingPages || batchDismantling"
                @click="openBatchDismantleDialog"
              >
                精细分解
              </UiButton>
              <div class="ml-auto flex items-center gap-1 rounded-full border border-[var(--g-border)] p-1">
                <button
                  type="button"
                  class="gacha-toggle-btn"
                  :class="{ 'is-active': albumCardVariant === 'mini' }"
                  @click="albumCardVariant = 'mini'"
                >
                  缩略
                </button>
                <button
                  type="button"
                  class="gacha-toggle-btn"
                  :class="{ 'is-active': albumCardVariant === 'large' }"
                  @click="albumCardVariant = 'large'"
                >
                  大图
                </button>
              </div>
            </div>
            <div class="mt-3">
              <GachaRarityFilter v-model="pageRarityFilter" :options="pageRarityFilterOptions" all-label="全部" />
            </div>
          </section>

          <section ref="cardGridRef" class="surface-card p-4">
            <div v-if="loadingPages" :class="albumCardVariant === 'mini' ? 'gacha-card-grid--mini' : 'gacha-card-grid--large'">
              <GachaSkeleton v-for="i in 12" :key="i" :variant="albumCardVariant === 'mini' ? 'card-mini' : 'card-large'" />
            </div>
            <div
              v-else-if="filteredVariants.length"
              :class="albumCardVariant === 'mini' ? 'gacha-card-grid--mini' : 'gacha-card-grid--large'"
            >
              <GachaCard
                v-for="card in visibleVariants"
                :key="`${card.cardId}::${card.affixSignature || 'std'}`"
                class="gacha-card-reveal-target album-card-trigger"
                :tabindex="albumCardVariant === 'mini' ? 0 : undefined"
                :role="albumCardVariant === 'mini' ? 'button' : undefined"
                :aria-label="albumCardVariant === 'mini' ? `查看${card.title}详情` : undefined"
                :title="card.title"
                :rarity="card.rarity"
                :tags="card.tags"
                :authors="card.authors"
                :wikidot-id="card.wikidotId"
                :count="card.count"
                :image-url="card.imageUrl || undefined"
                :page-url="albumCardVariant === 'large' ? albumCardPageUrl(card) : null"
                :variant="albumCardVariant"
                :affix-visual-style="card.affixVisualStyle"
                :affix-signature="card.affixSignature"
                :affix-styles="card.affixStyles"
                :affix-style-counts="card.affixStyleCounts"
                :affix-label="card.affixLabel"
                :locked="(card.lockedCount ?? 0) > 0"
                @click="onAlbumCardClick(card)"
                @keydown.enter.prevent="onAlbumCardClick(card)"
                @keydown.space.prevent="onAlbumCardClick(card)"
              />
            </div>
            <GachaEmptyState v-else icon="🔍" title="无匹配结果" description="尝试调整搜索条件或稀有度筛选" />

            <button
              v-if="albumHasMore"
              type="button"
              class="mt-3 w-full rounded-xl bg-neutral-100 px-3 py-2.5 text-center text-xs font-medium text-neutral-600 transition hover:bg-neutral-200 dark:bg-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-700"
              @click="albumLoadMore"
            >
              加载更多 (剩余 {{ filteredVariants.length - ALBUM_RENDER_LIMIT }} 张)
            </button>

            <p v-if="loadingRemainder" class="mt-3 text-center text-[11px] text-neutral-400 dark:text-neutral-500">
              正在加载其余卡片...
            </p>
          </section>
        </div>
      </Transition>

      <GachaAlbumDismantleDialog
        :open="batchDismantleDialogOpen"
        :candidates="batchDismantleCandidates"
        :loading="batchDismantleLoading"
        :dismantling="batchDismantling"
        :error="batchDismantleError"
        @close="closeBatchDismantleDialog"
        @confirm="confirmBatchDismantle"
      />
      <GachaQuickDismantleDialog
        ref="quickDismantleRef"
        :open="quickDismantleDialogOpen"
        @close="closeQuickDismantleDialog"
        @preview="handleQuickDismantlePreview"
        @confirm="handleQuickDismantleConfirm"
      />
      <GachaAlbumCardDetailDialog
        :open="cardDetailDialogOpen"
        :card="selectedCardForDetail"
        :page-url="selectedCardForDetailPageUrl"
        :lock-busy="lock.lockBusy.value"
        :dismantle-busy="detailDismantleBusy"
        @close="closeCardDetailDialog"
        @lock="handleLockVariant"
        @unlock="handleUnlockVariant"
        @dismantle-one="handleDetailDismantleOne"
      />
    </div>
  </GachaPageShell>
</template>

<script setup lang="ts">
import { computed, ref, nextTick, watch } from 'vue'
import GachaPageShell from '~/components/gacha/GachaPageShell.vue'
import GachaErrorBanner from '~/components/gacha/GachaErrorBanner.vue'
import GachaSkeleton from '~/components/gacha/GachaSkeleton.vue'
import GachaEmptyState from '~/components/gacha/GachaEmptyState.vue'
import GachaAlbumDismantleDialog from '~/components/gacha/GachaAlbumDismantleDialog.vue'
import GachaAlbumCardDetailDialog from '~/components/gacha/GachaAlbumCardDetailDialog.vue'
import GachaQuickDismantleDialog from '~/components/gacha/GachaQuickDismantleDialog.vue'
import GachaShowcasePanel from '~/components/gacha/GachaShowcasePanel.vue'
import GachaRarityFilter from '~/components/gacha/GachaRarityFilter.vue'
import GachaCard from '~/components/gacha/GachaCard.vue'
import { UiButton } from '~/components/ui/button'
import { UiInput } from '~/components/ui/input'
import { UiProgress } from '~/components/ui/progress'
import { useGachaPage } from '~/composables/useGachaPage'
import { useGachaAlbum } from '~/composables/useGachaAlbum'
import { useGachaLock } from '~/composables/useGachaLock'
import { useGachaShowcase } from '~/composables/useGachaShowcase'
import { useGachaPageLifecycle } from '~/composables/useGachaPageLifecycle'
import { useQueryTab } from '~/composables/useQueryTab'
import { useScrollReveal } from '~/composables/useScrollReveal'
import { rarityLabel, raritySortWeight } from '~/utils/gachaRarity'
import { progressPercent, formatTokens } from '~/utils/gachaFormatters'
import type { Progress, Rarity, AlbumPageVariant, DismantleKeepScope } from '~/types/gacha'
import type { ShowcasePickerOption } from '~/components/gacha/GachaShowcaseSlotPicker.vue'

const pageRarityFilterOptions: Array<Rarity | 'ALL'> = ['ALL', 'GOLD', 'PURPLE', 'BLUE', 'GREEN', 'WHITE']

const page = useGachaPage({ pageName: 'album' })
const {
  authPending, showBindingBlock,
  errorBanner, successBanner, gacha,
  emitError, emitSuccess
} = page

const album = useGachaAlbum(page)
const lock = useGachaLock(page)
const showcase = useGachaShowcase(page)
const {
  loadingPages, loadingRemainder, searchKeyword, pageRarityFilter,
  filteredVariants,
  refreshPages, updateVariantLockStatus,
  batchDismantleDialogOpen, batchDismantleCandidates,
  batchDismantleLoading, batchDismantling, batchDismantleError,
  openBatchDismantleDialog, closeBatchDismantleDialog, confirmBatchDismantle,
  quickDismantleDialogOpen,
  openQuickDismantleDialog, closeQuickDismantleDialog,
  previewQuickDismantle, confirmQuickDismantle,
  loadInitial
} = album

const quickDismantleRef = ref<InstanceType<typeof GachaQuickDismantleDialog> | null>(null)

const { activeTab, setTab } = useQueryTab<'album' | 'showcase' | 'progress'>({ defaultTab: 'album' })

const albumCardVariant = ref<'mini' | 'large'>('mini')
const cardDetailDialogOpen = ref(false)
const selectedCardForDetail = ref<AlbumPageVariant | null>(null)
const detailDismantleBusy = ref(false)

// ─── Album grid progressive render ─────────────────────
const ALBUM_RENDER_LIMIT = 60
const ALBUM_RENDER_BATCH = 20
const albumShowAll = ref(false)
const albumRenderBudget = ref(ALBUM_RENDER_BATCH)
let albumRafId: number | null = null

const visibleVariants = computed(() => {
  const limit = albumShowAll.value ? albumRenderBudget.value : Math.min(albumRenderBudget.value, ALBUM_RENDER_LIMIT)
  return filteredVariants.value.slice(0, limit)
})
const albumHasMore = computed(() => !albumShowAll.value && filteredVariants.value.length > ALBUM_RENDER_LIMIT)

function startAlbumProgressiveRender() {
  albumRenderBudget.value = ALBUM_RENDER_BATCH
  if (albumRafId != null) cancelAnimationFrame(albumRafId)
  function step() {
    const target = albumShowAll.value ? filteredVariants.value.length : ALBUM_RENDER_LIMIT
    if (albumRenderBudget.value < target) {
      albumRenderBudget.value = Math.min(albumRenderBudget.value + ALBUM_RENDER_BATCH, target)
      albumRafId = requestAnimationFrame(step)
    } else {
      albumRafId = null
    }
  }
  albumRafId = requestAnimationFrame(step)
}

function albumLoadMore() {
  albumShowAll.value = true
  startAlbumProgressiveRender()
}

// Scroll-reveal for card grid
const cardGridRef = ref<HTMLElement | null>(null)
const { refresh: refreshReveal, debouncedRefresh: debouncedReveal } = useScrollReveal(cardGridRef, {
  selector: '.gacha-card-reveal-target',
  rootMargin: '0px 0px -30px 0px'
})

// Re-trigger reveal and progressive render when cards or variant change
watch([filteredVariants, albumCardVariant], () => {
  albumShowAll.value = false
  startAlbumProgressiveRender()
  nextTick(() => refreshReveal())
})

watch(albumRenderBudget, () => {
  nextTick(() => debouncedReveal())
})

const progressData = ref<Progress | null>(null)
const loadingProgress = ref(false)

const pagesPercent = computed(() => {
  if (!progressData.value || progressData.value.pages.total === 0) return 0
  return Math.min(100, Math.round((progressData.value.pages.collected / progressData.value.pages.total) * 100))
})

const imageVariantsPercent = computed(() => {
  if (!progressData.value || progressData.value.imageVariants.total === 0) return 0
  return Math.min(100, Math.round((progressData.value.imageVariants.collected / progressData.value.imageVariants.total) * 100))
})

const coatingsPercent = computed(() => {
  if (!progressData.value || progressData.value.coatings.total === 0) return 0
  return Math.min(100, Math.round((progressData.value.coatings.collected / progressData.value.coatings.total) * 100))
})

const rarityEntries = computed(() =>
  [...(progressData.value?.pages.byRarity ?? [])]
    .sort((a, b) => (raritySortWeight[a.rarity] ?? 99) - (raritySortWeight[b.rarity] ?? 99))
    .map((entry) => ({ ...entry, percent: progressPercent(entry.collected, entry.total) }))
)

const rarityBarColorMap: Record<Rarity, string> = {
  GOLD: 'var(--g-rarity-gold)',
  PURPLE: 'var(--g-rarity-purple)',
  BLUE: 'var(--g-rarity-blue)',
  GREEN: 'var(--g-rarity-green)',
  WHITE: 'var(--g-rarity-white)'
}

function rarityBarColor(rarity: Rarity): string {
  return rarityBarColorMap[rarity] || 'rgb(var(--accent-strong))'
}

function albumCardPageUrl(card: { wikidotId: number | null; pageId: number | null }) {
  if (card.wikidotId != null) return `/page/${card.wikidotId}`
  if (card.pageId != null) return `/page/${card.pageId}`
  return null
}

const selectedCardForDetailPageUrl = computed(() =>
  selectedCardForDetail.value ? albumCardPageUrl(selectedCardForDetail.value) : null
)

function onAlbumCardClick(card: AlbumPageVariant) {
  if (albumCardVariant.value !== 'mini') return
  selectedCardForDetail.value = card
  cardDetailDialogOpen.value = true
}

function closeCardDetailDialog() {
  cardDetailDialogOpen.value = false
}

async function handleLockVariant(cardId: string, affixSignature: string) {
  const ok = await lock.lockVariant(cardId, affixSignature)
  if (ok) updateVariantLockStatus(cardId, affixSignature, true)
}

async function handleUnlockVariant(cardId: string, affixSignature: string) {
  const ok = await lock.unlockVariant(cardId, affixSignature)
  if (ok) updateVariantLockStatus(cardId, affixSignature, false)
}

async function handleDetailDismantleOne() {
  if (detailDismantleBusy.value) return
  const card = selectedCardForDetail.value
  if (!card) return

  const lockedCount = Math.max(0, Number(card.lockedCount || 0))
  const freeCount = Math.max(0, Number(card.count || 0) - lockedCount)
  if (freeCount <= 0) {
    emitError('该变体当前没有可分解的空闲卡片')
    return
  }

  detailDismantleBusy.value = true
  try {
    const res = await gacha.dismantle(
      card.cardId,
      1,
      card.affixVisualStyle,
      card.affixSignature || undefined
    )
    if (!res.ok) {
      emitError(res.error || '分解失败')
      return
    }

    emitSuccess(`已分解 1 张卡片，返还 ${formatTokens(res.reward || 0)} Token`)
    const signature = card.affixSignature || 'NONE'
    const index = album.inventoryVariants.value.findIndex((item) =>
      item.cardId === card.cardId && (item.affixSignature || 'NONE') === signature
    )

    if (index >= 0) {
      const target = album.inventoryVariants.value[index]
      const nextCount = Math.max(0, Number(target.count || 0) - 1)
      target.count = nextCount
      if (typeof target.lockedCount === 'number') {
        target.lockedCount = Math.min(Math.max(0, Number(target.lockedCount || 0)), nextCount)
      }
      if (nextCount <= 0) {
        album.inventoryVariants.value.splice(index, 1)
      }
    }

    const nextCard = album.inventoryVariants.value.find((item) =>
      item.cardId === card.cardId && (item.affixSignature || 'NONE') === signature
    ) || null
    if (nextCard) {
      selectedCardForDetail.value = nextCard
    } else {
      closeCardDetailDialog()
    }
  } catch (error: any) {
    emitError(error?.message || '分解失败')
  } finally {
    detailDismantleBusy.value = false
  }
}

async function handleQuickDismantlePreview(maxRarity: Rarity, keepAtLeast: number, keepScope: DismantleKeepScope) {
  if (!quickDismantleRef.value) return
  quickDismantleRef.value.previewLoading = true
  quickDismantleRef.value.previewError = null
  await previewQuickDismantle(maxRarity, keepAtLeast, keepScope)
  quickDismantleRef.value.previewData = album.quickDismantlePreview.value
  quickDismantleRef.value.previewLoading = album.quickDismantlePreviewLoading.value
  quickDismantleRef.value.previewError = album.quickDismantlePreviewError.value
}

async function handleQuickDismantleConfirm(maxRarity: Rarity, keepAtLeast: number, keepScope: DismantleKeepScope) {
  if (!quickDismantleRef.value) return
  quickDismantleRef.value.confirming = true
  quickDismantleRef.value.confirmError = null
  await confirmQuickDismantle(maxRarity, keepAtLeast, keepScope)
  quickDismantleRef.value.confirming = album.quickDismantleConfirming.value
  quickDismantleRef.value.confirmError = album.quickDismantleConfirmError.value
}

// ─── Showcase helpers ──────────────────────────────────
const showcasePickerOptions = ref<ShowcasePickerOption[]>([])
const loadingShowcasePicker = ref(false)
const showcaseTabLoaded = ref(false)

async function refreshShowcaseTab(force = false) {
  if (!force && showcaseTabLoaded.value) return
  const ok = await showcase.refreshShowcases()
  if (ok) showcaseTabLoaded.value = true
}

async function handleShowcaseTab() {
  setTab('showcase')
  await refreshShowcaseTab()
}

async function refreshShowcaseTabManually() {
  await refreshShowcaseTab(true)
}

async function loadShowcasePickerOptions() {
  loadingShowcasePicker.value = true
  try {
    const res = await gacha.getFreeInstances(2000, { includePlaced: true, includeLocked: true })
    if (!res.ok) {
      showcasePickerOptions.value = []
      return
    }
    showcasePickerOptions.value = (res.items ?? []).map((inst) => ({
      cardId: inst.cardId,
      instanceId: inst.instanceId,
      title: inst.title,
      rarity: inst.rarity,
      tags: inst.tags ?? [],
      imageUrl: inst.imageUrl,
      authors: inst.authors ?? null,
      wikidotId: inst.wikidotId ?? null,
      affixVisualStyle: inst.affixVisualStyle || 'NONE',
      affixSignature: inst.affixSignature || 'NONE',
      affixLabel: inst.affixLabel || null,
      isLocked: inst.isLocked ?? false
    }))
  } catch {
    showcasePickerOptions.value = []
  } finally {
    loadingShowcasePicker.value = false
  }
}

watch(() => activeTab.value, (tab) => {
  if (tab === 'showcase') {
    void refreshShowcaseTab()
  }
}, { immediate: true })

async function refreshProgress() {
  loadingProgress.value = true
  try {
    const res = await gacha.getProgress()
    progressData.value = res.ok ? res.data : null
  } catch {
    progressData.value = null
  } finally {
    loadingProgress.value = false
  }
}

const { walletBalance } = useGachaPageLifecycle({
  page,
  tag: 'gacha-album',
  loadInitial: async () => {
    await Promise.allSettled([loadInitial(), refreshProgress()])
  }
})
</script>

<style scoped>
.album-card-trigger {
  cursor: pointer;
  content-visibility: auto;
  contain-intrinsic-size: auto 180px;
}

.album-card-trigger:focus-visible {
  outline: 2px solid rgb(var(--accent-strong) / 0.65);
  outline-offset: 2px;
}
</style>
