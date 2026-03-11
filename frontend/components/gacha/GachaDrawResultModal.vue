<template>
  <UiDialogRoot :open="props.open" @update:open="handleOpenChange">
    <UiDialogPortal>
      <UiDialogOverlay class="!z-[58] !bg-black/50 !backdrop-blur-sm" />
      <UiDialogContent
        class="result-modal-shell z-[61] mx-2 flex w-full max-w-6xl flex-col overflow-hidden rounded-lg border border-white/40 bg-white/92 p-0 shadow-lg backdrop-blur-xl max-h-[calc(100vh-2rem)] max-h-[calc(100dvh-2rem)] dark:border-neutral-700/70 dark:bg-neutral-950/88 sm:mx-0 sm:rounded-[30px] sm:max-h-[calc(100vh-4rem)] sm:max-h-[calc(100dvh-4rem)]"
      >
        <div class="result-modal-shell__glow result-modal-shell__glow--a" />
        <div class="result-modal-shell__glow result-modal-shell__glow--b" />
        <div class="result-modal-shell__glow result-modal-shell__glow--c" />

        <header class="relative z-[2] flex items-start justify-between gap-3 border-b border-neutral-200/70 px-3 py-3 sm:gap-4 sm:px-6 sm:py-4 dark:border-neutral-800/70">
          <div class="space-y-1.5">
            <p class="inline-flex w-fit items-center rounded-full border border-[rgb(var(--accent-strong))]/30 bg-[rgb(var(--accent-strong))]/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-[rgb(var(--accent-strong))]">
              Draw Report · {{ drawModeLabel }}
            </p>
            <h2 class="text-lg font-semibold text-neutral-900 dark:text-neutral-50 sm:text-2xl">开包结果</h2>
          </div>

          <UiDialogClose as-child>
            <UiButton
              variant="ghost"
              size="sm"
              class="h-9 w-9 rounded-full border border-neutral-200/70 p-0 text-neutral-500 hover:text-neutral-900 dark:border-neutral-700/70 dark:text-neutral-400 dark:hover:text-neutral-100"
              aria-label="关闭抽卡结果"
            >
              <LucideIcon name="X" class="h-4 w-4" />
            </UiButton>
          </UiDialogClose>
        </header>

        <div class="relative z-[2] flex-1 overflow-y-auto">
          <div class="px-3 pb-3 pt-2 sm:px-6 sm:pb-5 sm:pt-4">
            <section v-if="raritySegments.length" class="result-rarity-strip" aria-label="稀有度分布条">
              <div class="result-rarity-strip__bar">
                <div
                  v-for="segment in raritySegments"
                  :key="segment.rarity"
                  class="h-full flex-none"
                  :class="segment.barClass"
                  :style="[{ width: segment.width }, segment.barStyle]"
                />
              </div>
            </section>

            <div v-if="displayItems.length" class="mt-3 pb-2">
              <!-- Single draw: centered hero card -->
              <div v-if="isSingleDraw" class="result-single-hero">
                <div
                  class="result-single-hero__card"
                  :class="{ 'result-card-item--reveal': !prefersReducedMotion }"
                  :style="cardRevealStyle(0, displayItems[0].rarity)"
                >
                  <GachaCard
                    class="result-modal-card"
                    :title="displayItems[0].title"
                    :rarity="displayItems[0].rarity"
                    :tags="displayItems[0].tags"
                    :wikidot-id="displayItems[0].wikidotId"
                    :authors="displayItems[0].authors"
                    :count="1"
                    :image-url="displayItems[0].imageUrl || undefined"
                    :page-url="pageUrl(displayItems[0])"
                    :retired="displayItems[0].isRetired"
                    :affix-visual-style="displayItems[0].affixVisualStyle"
                    :affix-label="displayItems[0].affixLabel"
                    :affix-signature="displayItems[0].affixSignature"
                    :affix-styles="displayItems[0].affixStyles"
                    :affix-style-counts="displayItems[0].affixStyleCounts"
                    density="compact"
                  >
                    <template #meta>
                      <span class="draw-card-meta-pill" :class="displayItems[0].duplicate ? 'draw-card-meta-pill--dup' : 'draw-card-meta-pill--new'">
                        <span v-if="displayItems[0].duplicate">重复掉落</span>
                        <span v-else>首次解锁</span>
                      </span>
                    </template>
                  </GachaCard>
                </div>
              </div>

              <!-- Multi draw: grid -->
              <TransitionGroup
                v-else
                name="gacha-list"
                tag="div"
                class="result-card-grid"
              >
                <div
                  v-for="(item, index) in displayItems"
                  :key="`${item.id}-${index}`"
                  class="result-card-item"
                  :class="{ 'result-card-item--reveal': !prefersReducedMotion }"
                  :style="cardRevealStyle(index, item.rarity)"
                >
                  <GachaCard
                    class="result-modal-card"
                    :title="item.title"
                    :rarity="item.rarity"
                    :tags="item.tags"
                    :wikidot-id="item.wikidotId"
                    :authors="item.authors"
                    :count="1"
                    :image-url="item.imageUrl || undefined"
                    :page-url="pageUrl(item)"
                    :retired="item.isRetired"
                    :affix-visual-style="item.affixVisualStyle"
                    :affix-label="item.affixLabel"
                    :affix-signature="item.affixSignature"
                    :affix-styles="item.affixStyles"
                    :affix-style-counts="item.affixStyleCounts"
                    density="compact"
                  >
                    <template #meta>
                      <span class="draw-card-meta-pill" :class="item.duplicate ? 'draw-card-meta-pill--dup' : 'draw-card-meta-pill--new'">
                        <span v-if="item.duplicate">重复掉落</span>
                        <span v-else>首次解锁</span>
                      </span>
                    </template>
                  </GachaCard>
                </div>
              </TransitionGroup>
            </div>

            <p v-else class="mt-4 rounded-xl border border-neutral-200/80 bg-neutral-50/80 px-4 py-3 text-sm text-neutral-500 dark:border-neutral-800/70 dark:bg-neutral-900/70 dark:text-neutral-300">
              暂无抽卡记录。
            </p>
          </div>
        </div>

        <footer class="relative z-[2] flex flex-col gap-2 border-t border-neutral-200/70 bg-white/65 px-3 py-3 dark:border-neutral-800/70 dark:bg-neutral-950/72 sm:flex-row sm:items-center sm:justify-between sm:gap-3 sm:px-6 sm:py-4">
          <div class="hidden text-sm text-neutral-500 sm:block dark:text-neutral-400">
            最新抽卡结果已加入图鉴，可在图鉴页查看全部。
          </div>
          <div class="flex gap-2 sm:flex-row">
            <UiButton variant="outline" @click="emit('view-album')">
              前往图鉴
            </UiButton>
            <UiButton :disabled="props.drawAgainDisabled" @click="emit('draw-again')">
              {{ totalCount >= 10 ? '再来十连' : '再来一抽' }}
            </UiButton>
          </div>
        </footer>
      </UiDialogContent>
    </UiDialogPortal>
  </UiDialogRoot>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import LucideIcon from '~/components/LucideIcon.vue'
import GachaCard from '~/components/gacha/GachaCard.vue'
import { UiButton } from '~/components/ui/button'
import {
  UiDialogRoot,
  UiDialogPortal,
  UiDialogOverlay,
  UiDialogContent,
  UiDialogClose
} from '~/components/ui/dialog'
import type { DrawResult, DrawItem, Rarity } from '~/types/gacha'
import { raritySortWeight } from '~/utils/gachaRarity'

const rarityBarClassMap: Record<Rarity, string> = {
  WHITE: 'bg-neutral-300 dark:bg-neutral-600',
  GREEN: 'bg-emerald-400',
  BLUE: 'bg-blue-400',
  PURPLE: 'bg-purple-400',
  GOLD: 'bg-amber-400'
}
const rarityColorMap: Record<Rarity, string> = {
  WHITE: '#d4d4d8',
  GREEN: '#34d399',
  BLUE: '#60a5fa',
  PURPLE: '#c084fc',
  GOLD: '#fbbf24'
}
const resultTitleCollator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' })

const props = defineProps<{
  open: boolean
  result: DrawResult | null
  drawAgainDisabled?: boolean
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'draw-again'): void
  (e: 'view-album'): void
}>()

function handleOpenChange(nextOpen: boolean) {
  if (!nextOpen) emit('close')
}

const prefersReducedMotion = ref(false)

if (import.meta.client) {
  prefersReducedMotion.value = window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

const sortedItems = computed(() => {
  if (!props.result?.items?.length) {
    return []
  }
  return [...props.result.items].sort((a, b) => {
    const rarityDiff = raritySortWeight[a.rarity] - raritySortWeight[b.rarity]
    if (rarityDiff !== 0) return rarityDiff
    const duplicateDiff = Number(a.duplicate) - Number(b.duplicate)
    if (duplicateDiff !== 0) return duplicateDiff
    return resultTitleCollator.compare(a.title, b.title)
  })
})

const displayItems = computed(() => sortedItems.value)

const totalCount = computed(() => sortedItems.value.length)
const isSingleDraw = computed(() => totalCount.value === 1)
const drawModeLabel = computed(() => (totalCount.value >= 10 ? '十连开包' : '抽卡开包'))

const rarityStats = computed(() => {
  const stats: Record<Rarity, number> = {
    WHITE: 0,
    GREEN: 0,
    BLUE: 0,
    PURPLE: 0,
    GOLD: 0
  }
  if (props.result?.rewardSummary?.byRarity?.length) {
    props.result.rewardSummary.byRarity.forEach((entry: { rarity: Rarity; count: number } | null | undefined) => {
      if (entry && entry.rarity in stats) {
        stats[entry.rarity] = entry.count
      }
    })
  } else {
    sortedItems.value.forEach((item) => {
      if (item?.rarity in stats) {
        stats[item.rarity] += 1
      }
    })
  }
  return (Object.keys(stats) as Rarity[])
    .map((key) => ({ rarity: key, count: stats[key] }))
    .filter((entry) => entry.count > 0)
})

const raritySegments = computed(() => {
  const total = totalCount.value || 0
  if (total <= 0) return []
  return rarityStats.value.map((entry) => {
    const percent = (entry.count / total) * 100
    const fillColor = rarityColorMap[entry.rarity] || rarityColorMap.WHITE
    return {
      rarity: entry.rarity,
      width: `${Math.max(0, Math.min(100, percent))}%`,
      barClass: rarityBarClassMap[entry.rarity] || rarityBarClassMap.WHITE,
      barStyle: { backgroundColor: fillColor }
    }
  })
})

function cardRevealStyle(index: number, rarity: Rarity) {
  if (prefersReducedMotion.value) {
    return {}
  }
  // High-rarity cards appear last with extra delay for dramatic effect
  const rarityBonus = rarity === 'GOLD' ? 300 : rarity === 'PURPLE' ? 150 : 0
  return {
    animationDelay: `${index * 120 + rarityBonus}ms`
  }
}

function pageUrl(item: DrawItem | null | undefined) {
  if (!item) return null
  if (item.wikidotId != null) {
    return `/page/${item.wikidotId}`
  }
  if (item.pageId != null) {
    return `/page/${item.pageId}`
  }
  return null
}
</script>

<style scoped>
.result-modal-shell::before {
  content: '';
  position: absolute;
  inset: 0;
  pointer-events: none;
  background:
    linear-gradient(135deg, rgba(255, 255, 255, 0.74), rgba(255, 255, 255, 0.22) 55%, rgba(15, 23, 42, 0.05)),
    radial-gradient(circle at 15% 20%, var(--g-accent-strong), transparent 46%),
    radial-gradient(circle at 86% 86%, rgb(var(--accent-strong) / 0.17), transparent 44%);
}

html.dark .result-modal-shell::before {
  background:
    linear-gradient(135deg, rgba(15, 23, 42, 0.82), rgba(15, 23, 42, 0.28) 55%, rgba(15, 23, 42, 0.1)),
    radial-gradient(circle at 15% 20%, var(--g-accent-strong), transparent 48%),
    radial-gradient(circle at 86% 86%, rgb(var(--accent-strong) / 0.2), transparent 46%);
}

.result-modal-shell__glow {
  position: absolute;
  border-radius: 999px;
  filter: blur(42px);
  opacity: 0.68;
  pointer-events: none;
}

.result-modal-shell__glow--a {
  left: -5rem;
  top: -4rem;
  width: 14rem;
  height: 14rem;
  background: var(--g-accent-border);
}

.result-modal-shell__glow--b {
  right: -4rem;
  bottom: -4rem;
  width: 12rem;
  height: 12rem;
  background: rgb(var(--accent-strong) / 0.28);
}

.result-modal-shell__glow--c {
  right: 28%;
  top: -5rem;
  width: 10rem;
  height: 10rem;
  background: rgba(245, 158, 11, 0.22);
}

.result-rarity-strip {
  width: 100%;
  border-radius: 999px;
  border: 1px solid rgba(148, 163, 184, 0.34);
  background: rgba(255, 255, 255, 0.78);
  padding: 0.3rem;
}

html.dark .result-rarity-strip {
  border-color: rgba(100, 116, 139, 0.45);
  background: rgba(15, 23, 42, 0.7);
}

.result-rarity-strip__bar {
  display: flex;
  height: 0.32rem;
  overflow: hidden;
  border-radius: 999px;
  background: rgba(148, 163, 184, 0.2);
}

/* Single-draw hero layout */
.result-single-hero {
  display: flex;
  justify-content: center;
  align-items: center;
  padding: 1rem 0;
}

.result-single-hero__card {
  width: min(280px, 70vw);
  position: relative;
  z-index: 0;
  transition: transform 0.2s ease;
}

.result-single-hero__card:hover {
  transform: translateY(-3px);
}

.result-single-hero :deep(.result-modal-card) {
  width: 100%;
  height: auto;
}

.result-card-grid {
  display: grid;
  gap: 0.5rem;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  grid-auto-rows: 1fr;
  align-items: stretch;
  isolation: isolate;
}

.result-card-item {
  position: relative;
  display: flex;
  height: 100%;
  min-width: 0;
  z-index: 0;
  transition: transform 0.2s ease, z-index 0.16s ease;
  opacity: 1;
  isolation: isolate;
}

:deep(.result-modal-card) {
  width: 100%;
  height: 100%;
  min-width: 0;
}

.result-card-item:hover {
  transform: translateY(-2px);
  z-index: 6;
}

.result-card-item--reveal {
  animation: resultCardReveal 0.6s cubic-bezier(0.175, 0.885, 0.32, 1.275) both;
}

.draw-card-meta-pill {
  display: inline-flex;
  align-items: center;
  border-radius: 999px;
  border: 1px solid transparent;
  padding: 0.16rem 0.52rem;
  font-size: 0.64rem;
  font-weight: 600;
}

.draw-card-meta-pill--new {
  border-color: rgba(16, 185, 129, 0.35);
  background: rgba(16, 185, 129, 0.13);
  color: rgb(5 150 105);
}

.draw-card-meta-pill--dup {
  border-color: rgba(245, 158, 11, 0.35);
  background: rgba(245, 158, 11, 0.13);
  color: rgb(180 83 9);
}

html.dark .draw-card-meta-pill--new {
  border-color: rgba(52, 211, 153, 0.45);
  background: rgba(16, 185, 129, 0.15);
  color: rgb(110 231 183);
}

html.dark .draw-card-meta-pill--dup {
  border-color: rgba(251, 191, 36, 0.45);
  background: rgba(245, 158, 11, 0.15);
  color: rgb(252 211 77);
}

:deep(.result-modal-card .gacha-card__foil) {
  opacity: 0.42;
  transform: translateX(-12%);
}

:deep(.result-modal-card.gacha-card:hover) {
  transform: translateY(-2px);
  z-index: 6;
  box-shadow: 0 28px 58px -34px rgba(15, 23, 42, 0.78);
}

:deep(.result-modal-card:hover .gacha-card__foil) {
  opacity: 0.64;
  transform: translateX(18%);
}

@media (min-width: 480px) {
  .result-card-grid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 0.6rem;
  }
}

@media (min-width: 640px) {
  .result-card-grid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 0.7rem;
  }
}

@media (min-width: 1024px) {
  .result-card-grid {
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 0.82rem;
  }
}

@media (min-width: 1400px) {
  .result-card-grid {
    grid-template-columns: repeat(5, minmax(0, 1fr));
  }
}

@media (max-width: 639px) {
  .result-rarity-strip {
    padding: 0.24rem;
  }
}

@keyframes resultCardReveal {
  0% {
    opacity: 0;
    transform: translateY(16px) scale(0.92);
    filter: blur(4px);
  }
  60% {
    opacity: 1;
    transform: translateY(-2px) scale(1.03);
    filter: blur(0);
  }
  100% {
    opacity: 1;
    transform: translateY(0) scale(1);
    filter: blur(0);
  }
}

/* Gold card reveal — golden glow ring */
@keyframes goldRevealGlow {
  0% { box-shadow: 0 0 0 0 rgba(245, 158, 11, 0); }
  40% { box-shadow: 0 0 20px -2px rgba(245, 158, 11, 0.4), 0 0 40px -4px rgba(245, 158, 11, 0.2); }
  100% { box-shadow: 0 0 0 0 rgba(245, 158, 11, 0); }
}

/* Purple card reveal — purple glow ring */
@keyframes purpleRevealGlow {
  0% { box-shadow: 0 0 0 0 rgba(168, 85, 247, 0); }
  40% { box-shadow: 0 0 16px -2px rgba(168, 85, 247, 0.35), 0 0 32px -4px rgba(168, 85, 247, 0.15); }
  100% { box-shadow: 0 0 0 0 rgba(168, 85, 247, 0); }
}

/* Foil sweep on reveal for coated cards */
@keyframes resultFoilSweep {
  0% { opacity: 0; transform: translateX(-100%); }
  30% { opacity: 0.7; }
  100% { opacity: 0; transform: translateX(100%); }
}

:deep(.result-modal-card.is-gold .gacha-card__media) {
  animation: goldRevealGlow 1.2s ease-out both;
  animation-delay: inherit;
}

:deep(.result-modal-card.is-purple .gacha-card__media) {
  animation: purpleRevealGlow 1s ease-out both;
  animation-delay: inherit;
}

:deep(.result-modal-card.is-coated .gacha-card__foil) {
  animation: resultFoilSweep 0.8s ease-out 0.5s both;
}

@media (prefers-reduced-motion: reduce) {
  .result-card-item,
  .result-card-item--reveal {
    animation: none !important;
    transition: none !important;
  }
}
</style>
