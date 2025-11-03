<template>
  <Teleport to="body">
    <transition name="fade">
      <div
        v-if="props.open"
        class="fixed inset-0 z-[60] flex items-center justify-center"
        role="dialog"
        aria-modal="true"
      >
        <div class="absolute inset-0 bg-black/60 backdrop-blur-sm" @click="emit('close')" />
        <div class="relative z-[61] mx-4 flex w-full max-w-6xl flex-col overflow-hidden rounded-3xl border border-neutral-200/70 bg-white/95 shadow-2xl max-h-[calc(100vh-2rem)] dark:border-neutral-700/70 dark:bg-neutral-900/95 sm:mx-0 sm:max-h-[calc(100vh-4rem)]">
          <header class="flex flex-col gap-3 border-b border-neutral-200/60 px-5 py-4 sm:flex-row sm:items-start sm:justify-between sm:gap-4 sm:px-6 dark:border-neutral-800/60">
            <div>
              <h2 class="text-lg font-semibold text-neutral-900 dark:text-neutral-50 sm:text-xl">抽卡结果</h2>
              <p class="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
                共获得 {{ totalCount }} 张卡片，Token 奖励 {{ totalTokens }}
              </p>
            </div>
            <button
              type="button"
              class="inline-flex h-9 w-9 items-center justify-center rounded-full border border-neutral-200/70 text-neutral-500 transition hover:text-neutral-900 dark:border-neutral-700/70 dark:text-neutral-400 dark:hover:text-neutral-100 self-end"
              @click="emit('close')"
            >
              <LucideIcon name="X" class="h-4 w-4" />
            </button>
          </header>

          <div class="flex-1 overflow-y-auto">
            <div class="flex flex-col gap-6 px-5 pb-5 sm:px-6">
              <section v-if="raritySegments.length" class="space-y-3">
                <div class="flex items-center justify-between gap-3">
                  <h3 class="text-sm font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">抽取分布</h3>
                  <span class="text-xs text-neutral-400 dark:text-neutral-500">共 {{ totalCount }} 张</span>
                </div>
                <div class="flex h-3 overflow-hidden rounded-full bg-neutral-200/70 dark:bg-neutral-800/70">
                  <div
                    v-for="segment in raritySegments"
                    :key="segment.rarity"
                    class="h-full flex-none transition-all duration-200"
                    :class="segment.barClass"
                    :style="[{ width: segment.width }, segment.barStyle]"
                  />
                </div>
                <ul class="flex flex-wrap gap-2 text-xs text-neutral-500 dark:text-neutral-400">
                  <li
                    v-for="segment in raritySegments"
                    :key="`${segment.rarity}-legend`"
                    class="inline-flex items-center gap-2 rounded-full border border-neutral-200/70 bg-white/80 px-3 py-1 dark:border-neutral-700/70 dark:bg-neutral-900/60"
                  >
                    <span class="h-2.5 w-2.5 rounded-full" :class="segment.dotClass" :style="segment.dotStyle" />
                    <span class="font-medium text-neutral-600 dark:text-neutral-200">{{ segment.label }}</span>
                    <span class="text-neutral-400 dark:text-neutral-500">{{ segment.count }} 张 · {{ segment.percentLabel }}</span>
                  </li>
                </ul>
              </section>

              <section>
                <h3 class="text-sm font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">获得卡片</h3>
                <div v-if="displayItems.length" class="mt-3 grid grid-cols-1 gap-3 pb-2 sm:grid-cols-2 lg:grid-cols-3">
                  <GachaCard
                    v-for="item in displayItems"
                    :key="item.id"
                    :title="item.title"
                    :rarity="item.rarity"
                    :tags="item.tags"
                    :authors="item.authors"
                    :count="1"
                    :image-url="item.imageUrl || undefined"
                    :page-url="pageUrl(item)"
                  >
                    <template #meta>
                      <span class="text-xs text-neutral-500 dark:text-neutral-400">
                        奖励 {{ item.rewardTokens }} <span v-if="item.duplicate">（重复）</span>
                      </span>
                    </template>
                  </GachaCard>
                </div>
                <p v-else class="mt-4 rounded-xl border border-neutral-200/80 bg-neutral-50/80 px-4 py-3 text-sm text-neutral-500 dark:border-neutral-800/70 dark:bg-neutral-900/70 dark:text-neutral-300">
                  暂无抽卡记录。
                </p>
              </section>
            </div>
          </div>

          <footer class="flex flex-col gap-3 border-t border-neutral-200/60 bg-neutral-50/80 px-5 py-4 dark:border-neutral-800/60 dark:bg-neutral-900/70 sm:flex-row sm:items-center sm:justify-between sm:px-6">
            <div class="text-sm text-neutral-500 dark:text-neutral-400">
              最新抽卡结果已加入图鉴，可在图鉴页查看全部。
            </div>
            <div class="flex flex-col gap-2 sm:flex-row">
              <button
                type="button"
                class="inline-flex items-center justify-center rounded-xl border border-neutral-300 px-4 py-2 text-sm font-medium text-neutral-600 hover:border-neutral-400 hover:text-neutral-900 dark:border-neutral-700 dark:text-neutral-200 dark:hover:border-neutral-600 dark:hover:text-neutral-50"
                @click="emit('view-album')"
              >
                前往图鉴
              </button>
              <button
                type="button"
                class="inline-flex items-center justify-center rounded-xl bg-[rgb(var(--accent-strong))] px-4 py-2 text-sm font-semibold text-white shadow transition hover:bg-[rgb(var(--accent))]"
                @click="emit('draw-again')"
              >
                再来十连
              </button>
            </div>
          </footer>
        </div>
      </div>
    </transition>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, watch } from 'vue'
import LucideIcon from '~/components/LucideIcon.vue'
import GachaCard from '~/components/GachaCard.vue'
import type { DrawResult, DrawItem, Rarity } from '~/composables/useGacha'
import { usePageAuthors } from '~/composables/usePageAuthors'

const rarityLabelMap: Record<Rarity, string> = {
  WHITE: '白色',
  GREEN: '绿色',
  BLUE: '蓝色',
  PURPLE: '紫色',
  GOLD: '金色'
}
const rarityBarClassMap: Record<Rarity, string> = {
  WHITE: 'bg-neutral-300 dark:bg-neutral-600',
  GREEN: 'bg-emerald-400',
  BLUE: 'bg-blue-400',
  PURPLE: 'bg-purple-400',
  GOLD: 'bg-amber-400'
}
const rarityDotClassMap: Record<Rarity, string> = {
  WHITE: 'bg-neutral-400 dark:bg-neutral-500',
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
const rarityOrder: Record<Rarity, number> = {
  GOLD: 0,
  PURPLE: 1,
  BLUE: 2,
  GREEN: 3,
  WHITE: 4
}
const resultTitleCollator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' })

const props = defineProps<{
  open: boolean
  result: DrawResult | null
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'draw-again'): void
  (e: 'view-album'): void
}>()

const pageAuthors = usePageAuthors()

const sortedItems = computed(() => {
  if (!props.result?.items?.length) {
    return []
  }
  return [...props.result.items].sort((a, b) => {
    const rarityDiff = rarityOrder[a.rarity] - rarityOrder[b.rarity]
    if (rarityDiff !== 0) return rarityDiff
    const duplicateDiff = Number(a.duplicate) - Number(b.duplicate)
    if (duplicateDiff !== 0) return duplicateDiff
    return resultTitleCollator.compare(a.title, b.title)
  })
})
const displayItems = computed(() =>
  sortedItems.value.map((item) => ({
    ...item,
    authors: pageAuthors.getAuthors(item.wikidotId)
  }))
)
const totalCount = computed(() => sortedItems.value.length)
const totalTokens = computed(() => props.result?.rewardSummary?.totalTokens ?? 0)

const rarityStats = computed(() => {
  const stats: Record<Rarity, number> = {
    WHITE: 0,
    GREEN: 0,
    BLUE: 0,
    PURPLE: 0,
    GOLD: 0
  }
  if (props.result?.rewardSummary?.byRarity?.length) {
    props.result.rewardSummary.byRarity.forEach((entry) => {
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
    const percentRounded = percent >= 1 ? Math.round(percent * 10) / 10 : Math.round(percent * 100) / 100
    const fillColor = rarityColorMap[entry.rarity] || rarityColorMap.WHITE
    return {
      rarity: entry.rarity,
      label: rarityLabel(entry.rarity),
      count: entry.count,
      width: `${Math.max(0, Math.min(100, percent))}%`,
      percentLabel: `${percentRounded}%`,
      barClass: rarityBarClassMap[entry.rarity] || rarityBarClassMap.WHITE,
      barStyle: { backgroundColor: fillColor },
      dotClass: rarityDotClassMap[entry.rarity] || rarityDotClassMap.WHITE,
      dotStyle: { backgroundColor: fillColor }
    }
  })
})

watch(sortedItems, (list) => {
  pageAuthors.ensureAuthors(list.map((item) => item.wikidotId))
}, { immediate: true })

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

function rarityLabel(rarity: Rarity) {
  return rarityLabelMap[rarity] || rarity
}
</script>

<style scoped>
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
