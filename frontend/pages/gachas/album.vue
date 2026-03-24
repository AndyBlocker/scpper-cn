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

      <div class="flex items-center gap-2" role="tablist" @keydown="handleTabKeydown">
        <button
          type="button"
          role="tab"
          :aria-selected="activeTab === 'album'"
          :tabindex="activeTab === 'album' ? 0 : -1"
          class="gacha-tab-btn"
          :class="{ 'is-active': activeTab === 'album' }"
          @click="setTab('album')"
        >
          图鉴
        </button>
        <button
          type="button"
          role="tab"
          :aria-selected="activeTab === 'showcase'"
          :tabindex="activeTab === 'showcase' ? 0 : -1"
          class="gacha-tab-btn"
          :class="{ 'is-active': activeTab === 'showcase' }"
          @click="handleShowcaseTab"
        >
          展示柜
        </button>
        <button
          type="button"
          role="tab"
          :aria-selected="activeTab === 'progress'"
          :tabindex="activeTab === 'progress' ? 0 : -1"
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
              :picker-total="showcasePickerTotal"
              :picker-has-more="showcasePickerHasMore"
              :wallet-balance="walletBalance ?? 0"
              @create="showcase.createShowcase"
              @rename="showcase.renameShowcase"
              @delete="showcase.deleteShowcase"
              @set-slot="handleShowcaseSetSlot"
              @clear-slot="handleShowcaseClearSlot"
              @refresh="refreshShowcaseTabManually"
              @load-picker="() => loadShowcasePickerOptions(true)"
              @picker-query-change="handleShowcasePickerQueryChange"
              @picker-load-more="handleShowcasePickerLoadMore"
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

          <section class="surface-card p-4">
            <div v-if="loadingPages || albumLoading" :class="albumCardVariant === 'mini' ? 'gacha-card-grid--mini' : 'gacha-card-grid--large'">
              <GachaSkeleton v-for="i in 12" :key="i" :variant="albumCardVariant === 'mini' ? 'card-mini' : 'card-large'" />
            </div>
            <div
              v-else-if="albumItems.length"
              :class="albumCardVariant === 'mini' ? 'gacha-card-grid--mini' : 'gacha-card-grid--large'"
            >
              <GachaCard
                v-for="card in albumItems"
                :key="`${card.cardId}::${card.affixSignature || 'std'}`"
                class="album-card-trigger"
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
                :retired="card.isRetired"
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

            <GachaPagination
              :current="albumPage"
              :total="albumTotal"
              :page-size="80"
              :loading="albumLoading"
              @change="loadAlbumPage"
            />
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
import { computed, ref, watch, nextTick } from 'vue'

useHead({ title: '扭蛋 - 图鉴' })

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
import GachaPagination from '~/components/gacha/GachaPagination.vue'
import { UiButton } from '~/components/ui/button'
import { UiInput } from '~/components/ui/input'
import { UiProgress } from '~/components/ui/progress'
import { useGachaPage } from '~/composables/useGachaPage'
import { useGachaAlbum } from '~/composables/useGachaAlbum'
import { useGachaLock } from '~/composables/useGachaLock'
import { useGachaShowcase } from '~/composables/useGachaShowcase'
import { useGachaPageLifecycle } from '~/composables/useGachaPageLifecycle'
import { useQueryTab } from '~/composables/useQueryTab'
import { rarityLabel, raritySortWeight } from '~/utils/gachaRarity'
import { progressPercent, formatTokens } from '~/utils/gachaFormatters'
import type { Progress, Rarity, AlbumPageVariant, DismantleKeepScope } from '~/types/gacha'
import type { ShowcasePickerOption } from '~/components/gacha/GachaShowcaseSlotPicker.vue'
import type { ShowcaseSlotCard } from '~/composables/api/gachaShowcase'
import type { LockedInstance } from '~/composables/api/gachaLock'

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
  loadingPages, albumLoading, albumItems, albumPage, albumTotal,
  searchKeyword, pageRarityFilter,
  loadAlbumPage, refreshPages, updateVariantLockStatus,
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

const albumTabs: Array<'album' | 'showcase' | 'progress'> = ['album', 'showcase', 'progress']
function handleTabKeydown(e: KeyboardEvent) {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
  e.preventDefault()
  const idx = albumTabs.indexOf(activeTab.value)
  const next = e.key === 'ArrowRight'
    ? albumTabs[(idx + 1) % albumTabs.length]
    : albumTabs[(idx - 1 + albumTabs.length) % albumTabs.length]
  if (next === 'showcase') handleShowcaseTab()
  else setTab(next)
  nextTick(() => {
    const tablist = (e.currentTarget as HTMLElement)
    const nextBtn = tablist?.querySelector<HTMLElement>('[aria-selected="true"]')
    nextBtn?.focus()
  })
}

const albumCardVariant = ref<'mini' | 'large'>('mini')
const cardDetailDialogOpen = ref(false)
const selectedCardForDetail = ref<AlbumPageVariant | null>(null)
const detailDismantleBusy = ref(false)

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
    const index = album.albumItems.value.findIndex((item) =>
      item.cardId === card.cardId && (item.affixSignature || 'NONE') === signature
    )

    if (index >= 0) {
      const target = album.albumItems.value[index]
      const nextCount = Math.max(0, Number(target.count || 0) - 1)
      target.count = nextCount
      if (typeof target.lockedCount === 'number') {
        target.lockedCount = Math.min(Math.max(0, Number(target.lockedCount || 0)), nextCount)
      }
      if (nextCount <= 0) {
        album.albumItems.value.splice(index, 1)
      }
    }

    const nextCard = album.albumItems.value.find((item) =>
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
const showcasePickerFallbackByInstanceId = ref<Record<string, ShowcasePickerOption>>({})
const showcasePickerSearch = ref('')
const showcasePickerRarity = ref<Rarity | 'ALL'>('ALL')
const showcasePickerTotal = ref(0)
const showcasePickerLoadedCount = ref(0)
const loadingShowcasePicker = ref(false)
const showcaseTabLoaded = ref(false)
const SHOWCASE_PICKER_PAGE_SIZE = 60
let showcasePickerRequestSeq = 0

const showcasedInstanceIdSet = computed(() => {
  const set = new Set<string>()
  for (const sc of showcase.showcases.value) {
    for (const slot of sc.slots ?? []) {
      const instanceId = slot.card?.instanceId
      if (instanceId) set.add(instanceId)
    }
  }
  return set
})

function toShowcasePickerOptionFromFreeInstance(inst: LockedInstance): ShowcasePickerOption {
  return {
    cardId: inst.cardId,
    instanceId: inst.instanceId,
    title: inst.title,
    rarity: inst.rarity,
    tags: inst.tags ?? [],
    imageUrl: inst.imageUrl,
    authors: inst.authors ?? null,
    wikidotId: inst.wikidotId ?? null,
    affixVisualStyle: inst.affixVisualStyle ?? 'NONE',
    affixSignature: inst.affixSignature ?? 'NONE',
    affixLabel: inst.affixLabel ?? null,
    isLocked: inst.isLocked ?? false
  }
}

function toShowcasePickerOptionFromShowcaseCard(card: ShowcaseSlotCard): ShowcasePickerOption {
  return {
    cardId: card.cardId,
    instanceId: card.instanceId,
    title: card.title,
    rarity: card.rarity,
    tags: card.tags ?? [],
    imageUrl: card.imageUrl,
    authors: card.authors ?? null,
    wikidotId: card.wikidotId ?? null,
    affixVisualStyle: card.affixVisualStyle ?? 'NONE',
    affixSignature: card.affixSignature ?? 'NONE',
    affixLabel: card.affixLabel ?? null,
    // 展示柜卡片下架后可再次入柜，前端不应因“曾被锁定”而禁用。
    isLocked: false
  }
}

function mergeShowcasePickerOptions(baseItems: ShowcasePickerOption[]) {
  const showcasedIds = showcasedInstanceIdSet.value
  const merged = new Map<string, ShowcasePickerOption>()
  for (const item of baseItems) {
    if (!item.instanceId || showcasedIds.has(item.instanceId)) continue
    merged.set(item.instanceId, item)
  }
  for (const [instanceId, option] of Object.entries(showcasePickerFallbackByInstanceId.value)) {
    if (!instanceId || showcasedIds.has(instanceId)) continue
    if (!merged.has(instanceId)) merged.set(instanceId, option)
  }
  showcasePickerOptions.value = Array.from(merged.values())
}

function appendShowcasePickerOptions(baseItems: ShowcasePickerOption[], incomingItems: ShowcasePickerOption[]) {
  const merged = new Map<string, ShowcasePickerOption>()
  for (const item of baseItems) {
    if (!item.instanceId) continue
    merged.set(item.instanceId, item)
  }
  for (const item of incomingItems) {
    if (!item.instanceId) continue
    merged.set(item.instanceId, item)
  }
  return Array.from(merged.values())
}

const showcasePickerHasMore = computed(() => showcasePickerLoadedCount.value < showcasePickerTotal.value)

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

async function loadShowcasePickerOptions(reset = true) {
  const requestSeq = ++showcasePickerRequestSeq
  if (reset) {
    showcasePickerLoadedCount.value = 0
    showcasePickerTotal.value = 0
  }
  loadingShowcasePicker.value = true
  try {
    const res = await gacha.getFreeInstances({
      limit: SHOWCASE_PICKER_PAGE_SIZE,
      offset: reset ? 0 : showcasePickerLoadedCount.value,
      search: showcasePickerSearch.value,
      rarity: showcasePickerRarity.value,
      includePlaced: true,
      includeLocked: true,
      sort: 'PICKER'
    })
    if (requestSeq !== showcasePickerRequestSeq) return
    if (!res.ok) {
      if (reset) {
        mergeShowcasePickerOptions([])
      }
      return
    }
    const mapped = (res.items ?? []).map(toShowcasePickerOptionFromFreeInstance)
    const nextBaseItems = reset
      ? mapped
      : appendShowcasePickerOptions(showcasePickerOptions.value, mapped)
    showcasePickerLoadedCount.value = reset
      ? mapped.length
      : showcasePickerLoadedCount.value + mapped.length
    showcasePickerTotal.value = Math.max(0, Number(res.total ?? nextBaseItems.length))
    mergeShowcasePickerOptions(nextBaseItems)
  } catch {
    if (requestSeq !== showcasePickerRequestSeq) return
    if (reset) {
      mergeShowcasePickerOptions([])
      showcasePickerLoadedCount.value = 0
      showcasePickerTotal.value = 0
    }
  } finally {
    if (requestSeq === showcasePickerRequestSeq) {
      loadingShowcasePicker.value = false
    }
  }
}

function handleShowcasePickerQueryChange(payload: { search: string; rarity: Rarity | 'ALL' }) {
  showcasePickerSearch.value = payload.search
  showcasePickerRarity.value = payload.rarity
  void loadShowcasePickerOptions(true)
}

function handleShowcasePickerLoadMore() {
  if (loadingShowcasePicker.value || !showcasePickerHasMore.value) return
  void loadShowcasePickerOptions(false)
}

async function handleShowcaseSetSlot(showcaseId: string, slotIndex: number, instanceId: string) {
  const ok = await showcase.setSlot(showcaseId, slotIndex, instanceId)
  if (!ok) return
  if (instanceId in showcasePickerFallbackByInstanceId.value) {
    const { [instanceId]: _removed, ...rest } = showcasePickerFallbackByInstanceId.value
    showcasePickerFallbackByInstanceId.value = rest
  }
  showcasePickerOptions.value = showcasePickerOptions.value.filter((item) => item.instanceId !== instanceId)
}

async function handleShowcaseClearSlot(showcaseId: string, slotIndex: number) {
  const beforeSlotCard = showcase.showcases.value
    .find((sc) => sc.id === showcaseId)
    ?.slots?.find((slot) => slot.slotIndex === slotIndex)
    ?.card ?? null
  const ok = await showcase.clearSlot(showcaseId, slotIndex)
  if (!ok || !beforeSlotCard?.instanceId) return
  const option = toShowcasePickerOptionFromShowcaseCard(beforeSlotCard)
  showcasePickerFallbackByInstanceId.value = {
    ...showcasePickerFallbackByInstanceId.value,
    [option.instanceId]: option
  }
  mergeShowcasePickerOptions(showcasePickerOptions.value)
}

watch(() => activeTab.value, (tab) => {
  if (tab === 'showcase') {
    void refreshShowcaseTab()
  }
}, { immediate: true })

watch(showcasedInstanceIdSet, (showcasedIds) => {
  const nextFallback: Record<string, ShowcasePickerOption> = {}
  let fallbackChanged = false
  for (const [instanceId, option] of Object.entries(showcasePickerFallbackByInstanceId.value)) {
    if (showcasedIds.has(instanceId)) {
      fallbackChanged = true
      continue
    }
    nextFallback[instanceId] = option
  }
  if (fallbackChanged) {
    showcasePickerFallbackByInstanceId.value = nextFallback
  }
  const filtered = showcasePickerOptions.value.filter((item) => !showcasedIds.has(item.instanceId))
  if (filtered.length !== showcasePickerOptions.value.length) {
    showcasePickerOptions.value = filtered
  }
})

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
  contain: layout paint;
}

.album-card-trigger:focus-visible {
  outline: 2px solid rgb(var(--accent-strong) / 0.65);
  outline-offset: 2px;
}
</style>
