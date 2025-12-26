<template>
  <section class="slide" :class="{ 'slide-active': isActive }">
    <div class="slide-content">
      <div class="max-w-5xl w-full px-2">
        <div class="flex items-center gap-2 md:gap-3 mb-6 md:mb-8">
          <div class="p-1.5 md:p-2 bg-purple-600 rounded-lg">
            <LucideIcon name="Layers" class="w-4 h-4 md:w-5 md:h-5 text-white" />
          </div>
          <h2 class="text-2xl md:text-3xl font-bold">内容分布</h2>
        </div>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-6 md:gap-8">
          <div class="flex flex-col md:flex-row items-center gap-4 md:gap-6">
            <div
              class="w-36 h-36 md:w-48 md:h-48 rounded-full relative flex-shrink-0"
              :style="{ background: categoryPieGradient }"
            >
              <div class="absolute inset-3 md:inset-4 rounded-full bg-[rgb(var(--bg))] flex items-center justify-center">
                <div class="text-center">
                  <div class="text-xl md:text-2xl font-black text-[rgb(var(--fg))]">{{ siteData.overview.pages.total }}</div>
                  <div class="text-[10px] md:text-xs text-[rgb(var(--muted))]">总页面</div>
                </div>
              </div>
            </div>
            <div class="flex-1 space-y-1.5 md:space-y-2 w-full">
              <div
                v-for="(cat, idx) in siteData.breakdown.byCategory"
                :key="idx"
                class="flex items-center gap-2 md:gap-3"
              >
                <div class="w-2.5 h-2.5 md:w-3 md:h-3 rounded-sm flex-shrink-0" :style="{ background: cat.colorFrom }" />
                <div class="flex-1 flex justify-between items-center">
                  <span class="text-xs md:text-sm text-[rgb(var(--fg))]">{{ cat.label }}</span>
                  <div class="text-right">
                    <span class="text-xs md:text-sm font-bold text-[rgb(var(--fg))]">{{ cat.percent }}%</span>
                    <span class="text-[10px] md:text-xs text-[rgb(var(--muted))] ml-1 md:ml-2">{{ cat.count }}篇</span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div class="space-y-3 md:space-y-4">
            <div class="bento-card">
              <div class="bento-header">
                <span class="text-xs md:text-sm font-medium text-[rgb(var(--muted))]">原创 / 翻译占比</span>
                <span class="text-[10px] md:text-xs text-[rgb(var(--muted))]">总 {{ formatNumber(overallSplit.total) }} 篇</span>
              </div>
              <div class="flex-1 flex flex-col justify-center gap-2 md:gap-3">
                <div class="flex justify-between items-center text-[10px] md:text-xs font-medium">
                  <span class="text-green-500 flex items-center gap-1">
                    <LucideIcon name="PenTool" class="w-3 h-3" /> 原创
                  </span>
                  <span class="bar-value">{{ formatNumber(overallSplit.originals) }}</span>
                  <span class="bar-meta">{{ overallSplit.originalPercent }}%</span>
                </div>
                <div class="flex justify-between items-center text-[10px] md:text-xs font-medium">
                  <span class="text-blue-500 flex items-center gap-1">
                    <LucideIcon name="Languages" class="w-3 h-3" /> 翻译
                  </span>
                  <span class="bar-value">{{ formatNumber(overallSplit.translations) }}</span>
                  <span class="bar-meta">{{ overallSplit.translationPercent }}%</span>
                </div>
                <div class="bar-track h-2 md:h-2.5 w-full">
                  <div
                    class="bar-fill-x bg-green-500"
                    :style="{ width: `${Math.max(overallSplit.originalPercent, 3)}%`, '--bar-delay': '0ms' }"
                  />
                  <div
                    class="bar-fill-x bg-blue-500"
                    :style="{ width: `${Math.max(overallSplit.translationPercent, 3)}%`, '--bar-delay': '80ms' }"
                  />
                </div>
              </div>
            </div>

            <div class="bento-card flex-1">
              <div class="bento-header">
                <span class="text-xs md:text-sm font-medium text-[rgb(var(--muted))]">翻译来源</span>
                <div v-if="branchTotalPages > 1" class="flex items-center gap-1">
                  <button
                    @click.stop="prevBranchPage"
                    :disabled="branchPageIndex === 0"
                    class="p-0.5 md:p-1 rounded hover:bg-[rgba(var(--fg),0.1)] disabled:opacity-30 disabled:cursor-not-allowed"
                  >
                    <LucideIcon name="ChevronLeft" class="w-3 h-3 md:w-4 md:h-4" />
                  </button>
                  <span class="text-[10px] md:text-xs text-[rgb(var(--muted))]">{{ branchPageIndex + 1 }}/{{ branchTotalPages }}</span>
                  <button
                    @click.stop="nextBranchPage"
                    :disabled="branchPageIndex >= branchTotalPages - 1"
                    class="p-0.5 md:p-1 rounded hover:bg-[rgba(var(--fg),0.1)] disabled:opacity-30 disabled:cursor-not-allowed"
                  >
                    <LucideIcon name="ChevronRight" class="w-3 h-3 md:w-4 md:h-4" />
                  </button>
                </div>
              </div>
              <div class="space-y-2 md:space-y-3">
                <div v-for="(b, i) in visibleBranches" :key="b.branchKey" class="flex items-center gap-2 md:gap-3">
                  <span class="text-base md:text-lg">{{ b.flag }}</span>
                  <div class="flex-1">
                    <div class="flex justify-between text-[10px] md:text-xs mb-1">
                      <span class="text-[rgb(var(--fg))]">{{ b.branch.split(' ')[0] }}</span>
                      <span class="bar-meta">{{ formatNumber(b.count) }}篇</span>
                    </div>
                    <div class="bar-track h-1 md:h-1.5 w-full">
                      <div
                        class="bar-fill-x h-full bg-[rgb(var(--success))]"
                        :style="{ width: `${b.percent}%`, '--bar-delay': `${i * 60}ms` }"
                      />
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-3 gap-4 md:gap-6 mt-6">
          <div class="bento-card">
            <div class="bento-header">
              <span class="text-xs md:text-sm font-medium text-[rgb(var(--muted))]">标签数量分布</span>
              <span class="text-[10px] md:text-xs text-[rgb(var(--muted))]">共 {{ formatNumber(siteData.distributions.tagCount.total) }} 篇</span>
            </div>
            <div class="flex items-end gap-1 mt-3">
              <div
                v-for="(bucket, i) in siteData.distributions.tagCount.buckets"
                :key="bucket.label"
                class="flex-1 flex flex-col items-center justify-end"
              >
                <div class="bar-value mb-0.5">{{ formatNumber(bucket.count) }}</div>
                <div class="w-full h-16 md:h-20 flex items-end">
                  <div
                    class="w-full bg-emerald-500 bar-fill-y"
                    :style="{ height: bucket.count === 0 ? '4px' : `${Math.max(bucket.heightPercent, 8)}%`, '--bar-delay': `${i * 40}ms` }"
                    :title="`${bucket.label}: ${bucket.count} 篇`"
                  />
                </div>
                <span class="bar-axis mt-1">{{ bucket.label }}</span>
              </div>
            </div>
          </div>

          <div class="bento-card">
            <div class="bento-header">
              <span class="text-xs md:text-sm font-medium text-[rgb(var(--muted))]">今年新增标签</span>
              <div class="flex items-center gap-2">
                <span class="text-[10px] md:text-xs text-[rgb(var(--muted))]">共 {{ formatNumber(newTagsTotal) }} 个</span>
                <div v-if="newTagsTotalPages > 1" class="flex items-center gap-1">
                  <button
                    @click.stop="prevNewTagsPage"
                    :disabled="newTagsPageIndex === 0"
                    class="p-0.5 md:p-1 rounded hover:bg-[rgba(var(--fg),0.1)] disabled:opacity-30 disabled:cursor-not-allowed"
                  >
                    <LucideIcon name="ChevronLeft" class="w-3 h-3 md:w-4 md:h-4" />
                  </button>
                  <span class="text-[10px] md:text-xs text-[rgb(var(--muted))]">{{ newTagsPageIndex + 1 }}/{{ newTagsTotalPages }}</span>
                  <button
                    @click.stop="nextNewTagsPage"
                    :disabled="newTagsPageIndex >= newTagsTotalPages - 1"
                    class="p-0.5 md:p-1 rounded hover:bg-[rgba(var(--fg),0.1)] disabled:opacity-30 disabled:cursor-not-allowed"
                  >
                    <LucideIcon name="ChevronRight" class="w-3 h-3 md:w-4 md:h-4" />
                  </button>
                </div>
              </div>
            </div>
            <div v-if="newTagsTotal > 0" class="space-y-1.5 mt-2">
              <div
                v-for="tag in newTagsVisible"
                :key="tag.tag"
                class="flex items-center justify-between gap-2"
              >
                <div class="flex items-center gap-1.5 min-w-0">
                  <span class="w-1.5 h-1.5 rounded-full bg-[rgb(var(--accent))] flex-shrink-0" />
                  <span class="text-[10px] md:text-xs text-[rgb(var(--fg))] truncate">#{{ tag.tag }}</span>
                </div>
                <div class="text-right">
                  <div class="bar-value">{{ formatNumber(tag.count) }} 篇</div>
                  <div class="bar-axis">{{ tag.firstSeen }}</div>
                </div>
              </div>
            </div>
            <div v-else class="text-[10px] text-[rgb(var(--muted))] mt-2">暂无数据</div>
          </div>

          <div class="bento-card">
            <div class="bento-header">
              <span class="text-xs md:text-sm font-medium text-[rgb(var(--muted))]">标题长度分布</span>
              <span class="text-[10px] md:text-xs text-[rgb(var(--muted))]">共 {{ formatNumber(siteData.distributions.titleLength.total) }} 篇</span>
            </div>
            <div class="flex items-end gap-1 mt-3">
              <div
                v-for="(bucket, i) in siteData.distributions.titleLength.buckets"
                :key="bucket.label"
                class="flex-1 flex flex-col items-center justify-end"
              >
                <div class="bar-value mb-0.5">{{ formatNumber(bucket.count) }}</div>
                <div class="w-full h-16 md:h-20 flex items-end">
                  <div
                    class="w-full bg-sky-500 bar-fill-y"
                    :style="{ height: bucket.count === 0 ? '4px' : `${Math.max(bucket.heightPercent, 8)}%`, '--bar-delay': `${i * 40}ms` }"
                    :title="`${bucket.label}: ${bucket.count} 篇`"
                  />
                </div>
                <span class="bar-axis mt-1">{{ bucket.label }}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { AnnualSiteData } from '~/types/annual2025'
import { formatNumber } from '~/utils/annual2025'

const props = defineProps<{
  isActive: boolean
  siteData: AnnualSiteData
}>()

const overallSplit = computed(() => {
  const total = props.siteData.overview.pages.total || 0
  const originals = props.siteData.overview.pages.originals || 0
  const translations = props.siteData.overview.pages.translations || 0
  return {
    total,
    originals,
    translations,
    originalPercent: total > 0 ? Math.round((originals / total) * 100) : 0,
    translationPercent: total > 0 ? Math.round((translations / total) * 100) : 0
  }
})

const NEW_TAGS_PER_PAGE = 6
const newTagsPageIndex = ref(0)
const newTagsSorted = computed(() => {
  return [...(props.siteData.tagInsights?.newTagsThisYear || [])].sort((a, b) => b.count - a.count)
})
const newTagsTotal = computed(() => newTagsSorted.value.length)
const newTagsVisible = computed(() => {
  const start = newTagsPageIndex.value * NEW_TAGS_PER_PAGE
  return newTagsSorted.value.slice(start, start + NEW_TAGS_PER_PAGE)
})
const newTagsTotalPages = computed(() => Math.ceil(newTagsSorted.value.length / NEW_TAGS_PER_PAGE))

const nextNewTagsPage = () => {
  if (newTagsPageIndex.value < newTagsTotalPages.value - 1) {
    newTagsPageIndex.value++
  }
}

const prevNewTagsPage = () => {
  if (newTagsPageIndex.value > 0) {
    newTagsPageIndex.value--
  }
}

watch(newTagsSorted, () => {
  newTagsPageIndex.value = 0
})

const categoryPieGradient = computed(() => {
  const categories = props.siteData.breakdown.byCategory || []
  if (!categories.length) return '#666'

  const segments: string[] = []
  let currentAngle = 0

  for (const cat of categories) {
    const startAngle = currentAngle
    const ratio = typeof cat.ratio === 'number' ? cat.ratio : cat.percent / 100
    const endAngle = currentAngle + ratio * 360
    segments.push(`${cat.colorFrom} ${startAngle}deg ${endAngle}deg`)
    currentAngle = endAngle
  }

  return `conic-gradient(${segments.join(', ')})`
})

const branchPageIndex = ref(0)
const BRANCHES_PER_PAGE = 5

const visibleBranches = computed(() => {
  const all = props.siteData.breakdown.translationsByBranch || []
  const start = branchPageIndex.value * BRANCHES_PER_PAGE
  return all.slice(start, start + BRANCHES_PER_PAGE)
})

const branchTotalPages = computed(() => {
  const all = props.siteData.breakdown.translationsByBranch || []
  return Math.ceil(all.length / BRANCHES_PER_PAGE)
})

const nextBranchPage = () => {
  if (branchPageIndex.value < branchTotalPages.value - 1) {
    branchPageIndex.value++
  }
}

const prevBranchPage = () => {
  if (branchPageIndex.value > 0) {
    branchPageIndex.value--
  }
}
</script>
