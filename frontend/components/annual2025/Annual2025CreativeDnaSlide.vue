<template>
  <section class="slide" :class="{ 'slide-active': isActive }">
    <div class="slide-content">
      <div v-if="!hasUserData" class="max-w-md w-full mx-auto px-4 text-center">
        <div class="bg-[rgb(var(--panel))] border border-[rgb(var(--panel-border))] rounded-2xl p-8 md:p-12">
          <div class="w-20 h-20 mx-auto mb-6 bg-[rgba(var(--fg),0.1)] rounded-full flex items-center justify-center">
            <LucideIcon name="PenTool" class="w-10 h-10 text-[rgb(var(--muted))]" />
          </div>
          <h2 class="text-xl md:text-2xl font-bold text-[rgb(var(--fg))] mb-3">创作数据</h2>
          <p class="text-[rgb(var(--muted))] text-sm">输入用户名查看创作统计</p>
        </div>
      </div>
      <div v-else class="max-w-5xl w-full grid grid-cols-1 md:grid-cols-2 gap-6 md:gap-8 px-2">
        <div class="space-y-4 md:space-y-6">
          <h3 class="text-xl md:text-2xl font-bold flex items-center gap-2">
            <LucideIcon name="PenTool" class="text-purple-500 w-5 h-5 md:w-6 md:h-6" /> 创作数据
          </h3>

          <div class="bento-card">
            <div class="bento-header">
              <span class="text-xs md:text-sm font-medium text-[rgb(var(--muted))]">常用标签分布</span>
            </div>
            <div class="space-y-3 md:space-y-4">
              <div v-for="(tag, i) in userData.preferences.topTags" :key="i">
                <div class="flex justify-between text-xs md:text-sm mb-1">
                  <span class="font-medium text-[rgb(var(--fg))]">#{{ tag.tag }}</span>
                  <span class="text-[rgb(var(--muted))]">
                    {{ tag.value }}{{ tag.unit }}
                    <span v-if="tag.detail" class="text-yellow-500 ml-1">{{ tag.detail }}</span>
                  </span>
                </div>
                <div class="bar-track h-2 md:h-2.5 w-full">
                  <div
                    :class="tag.bgClass"
                    class="bar-fill-x h-full"
                    :style="{ width: `${tag.barPercent}%`, '--bar-delay': `${i * 60}ms` }"
                  />
                </div>
              </div>
            </div>
          </div>

          <div class="flex gap-3 md:gap-4">
            <div class="bento-card flex-1 bg-gradient-to-br from-blue-900/20 to-transparent">
              <div class="text-2xl md:text-3xl font-bold text-[rgb(var(--fg))]">{{ userData.overview.creation.originals }}</div>
              <div class="text-[10px] md:text-xs text-[rgb(var(--muted))]">原创作品</div>
            </div>
            <div class="bento-card flex-1 bg-gradient-to-br from-purple-900/20 to-transparent">
              <div class="text-2xl md:text-3xl font-bold text-[rgb(var(--fg))]">{{ userData.overview.creation.translations }}</div>
              <div class="text-[10px] md:text-xs text-[rgb(var(--muted))]">翻译作品</div>
            </div>
          </div>

          <div class="bento-card">
            <div class="bento-header">
              <span class="text-xs md:text-sm font-medium text-[rgb(var(--muted))]">内容长度分布</span>
              <div class="text-right">
                <div class="text-[10px] md:text-xs text-[rgb(var(--muted))]">你的总字数 {{ formatNumber(userData.overview.creation.totalWords) }}</div>
                <div class="text-[10px] md:text-xs text-[rgb(var(--muted))]">共 {{ siteData.distributions.contentWords.total }} 位作者</div>
              </div>
            </div>
            <div v-if="siteData.distributions.contentWords.buckets.length" class="mt-3">
              <div class="relative h-16 md:h-20">
                <svg width="100%" height="70" viewBox="0 0 300 60" preserveAspectRatio="none">
                  <defs>
                    <linearGradient id="content-dist-gradient" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stop-color="#a855f7" stop-opacity="0.35" />
                      <stop offset="100%" stop-color="#a855f7" stop-opacity="0.05" />
                    </linearGradient>
                  </defs>
                  <polyline :points="contentDistributionSpark.area" fill="url(#content-dist-gradient)" stroke="none" />
                  <polyline :points="contentDistributionSpark.line" fill="none" stroke="#a855f7" stroke-width="1.5" stroke-linecap="round" />
                </svg>
                <div
                  v-if="contentPercentilePosition !== null"
                  class="absolute bottom-1 -translate-x-1/2"
                  :style="{ left: `${contentPercentilePosition}%` }"
                >
                  <div class="w-2 h-2 bg-purple-400 rounded-full ring-2 ring-[rgb(var(--bg))]" />
                </div>
              </div>
              <div class="flex justify-between text-[9px] text-[rgb(var(--muted))]">
                <span>少</span>
                <span>多</span>
              </div>
            </div>
            <div v-else class="text-[10px] text-[rgb(var(--muted))] mt-3">暂无分布数据</div>
            <div class="mt-2 text-[10px] text-[rgb(var(--muted))]">
              <div v-if="userData.percentiles.contentWords" class="flex items-center justify-between gap-2">
                <span>
                  你的内容字数 {{ formatNumber(userData.percentiles.contentWords.value) }}，{{ userData.percentiles.contentWords.percentileLabel }}
                </span>
                <span
                  v-if="contentPercentileBadge"
                  class="inline-flex items-center px-2 py-0.5 rounded-full bg-purple-500/15 text-purple-300"
                >
                  {{ contentPercentileBadge }}
                </span>
              </div>
              <span v-else>暂无内容分位数据</span>
            </div>
          </div>
        </div>

        <div class="space-y-4 md:space-y-6">
          <h3 class="text-xl md:text-2xl font-bold flex items-center gap-2">
            <LucideIcon name="Clock" class="text-green-500 w-5 h-5 md:w-6 md:h-6" /> 编辑时间分布
          </h3>

          <div class="bento-card" v-if="userData.revisionTimeDistribution && userData.revisionTimeDistribution.totalRevisions > 0">
            <div class="bento-header">
              <span class="text-xs md:text-sm font-medium text-[rgb(var(--muted))]">24小时编辑分布</span>
              <span class="text-xs text-[rgb(var(--accent))]">共{{ userData.revisionTimeDistribution.totalRevisions }}次</span>
            </div>
            <div class="flex items-center justify-center mt-4">
              <Annual2025ClockPlot class="w-48 h-48 md:w-60 md:h-60" :hours="userData.revisionTimeDistribution.hourly" />
            </div>
            <div v-if="userData.revisionTimeDistribution.peakHour" class="mt-2 text-center text-[10px] text-[rgb(var(--muted))]">
              高峰时段: <span class="text-[rgb(var(--accent))] font-bold">{{ userData.revisionTimeDistribution.peakHour.label }}</span>
            </div>
            <div class="mt-3">
              <div
                class="h-2 rounded-full"
                :style="{ background: 'linear-gradient(90deg,#1e3a8a 0%,#0ea5e9 28%,#facc15 52%,#f97316 70%,#a855f7 85%,#4338ca 100%)' }"
              />
              <div class="flex justify-between text-[9px] text-[rgb(var(--muted))] mt-1">
                <span>凌晨</span>
                <span>上午</span>
                <span>下午</span>
                <span>深夜</span>
              </div>
            </div>
          </div>

          <div class="bento-card" v-if="userData.revisionTimeDistribution && userData.revisionTimeDistribution.byTimeOfDay.length > 0">
            <div class="bento-header">
              <span class="text-xs md:text-sm font-medium text-[rgb(var(--muted))]">时段偏好</span>
            </div>
            <div class="space-y-1.5 mt-2">
              <div
                v-for="(period, i) in userData.revisionTimeDistribution.byTimeOfDay"
                :key="period.period"
                class="flex items-center gap-2"
              >
                <span class="bar-axis w-8">{{ period.period }}</span>
                <div class="bar-track h-2.5 flex-1">
                  <div
                    class="bar-fill-x h-full"
                    :class="period.colorClass"
                    :style="{ width: `${period.percent}%`, '--bar-delay': `${i * 60}ms` }"
                  />
                </div>
                <span class="bar-value w-8 text-right">{{ period.percent }}%</span>
              </div>
            </div>
          </div>

          <div class="bento-card">
            <div class="bento-header">
              <span class="text-xs md:text-sm font-medium text-[rgb(var(--muted))]">年度时间轴</span>
              <div class="flex items-center gap-2">
                <span class="text-[10px] md:text-xs text-[rgb(var(--muted))]">共 {{ timelineTotal }} 项</span>
                <div v-if="timelineTotalPages > 1" class="flex items-center gap-1">
                  <button
                    @click.stop="prevTimelinePage"
                    :disabled="timelinePageIndex === 0"
                    class="p-0.5 md:p-1 rounded hover:bg-[rgba(var(--fg),0.1)] disabled:opacity-30 disabled:cursor-not-allowed"
                  >
                    <LucideIcon name="ChevronLeft" class="w-3 h-3 md:w-4 md:h-4" />
                  </button>
                  <span class="text-[10px] md:text-xs text-[rgb(var(--muted))]">{{ timelinePageIndex + 1 }}/{{ timelineTotalPages }}</span>
                  <button
                    @click.stop="nextTimelinePage"
                    :disabled="timelinePageIndex >= timelineTotalPages - 1"
                    class="p-0.5 md:p-1 rounded hover:bg-[rgba(var(--fg),0.1)] disabled:opacity-30 disabled:cursor-not-allowed"
                  >
                    <LucideIcon name="ChevronRight" class="w-3 h-3 md:w-4 md:h-4" />
                  </button>
                </div>
              </div>
            </div>
            <div class="space-y-2 mt-2">
              <div v-for="(item, i) in visibleTimeline" :key="i" class="flex items-center gap-2">
                <div class="w-1.5 h-1.5 rounded-full" :class="item.dotClass" />
                <span class="text-[9px] text-[rgb(var(--muted))] w-12">{{ item.month }}</span>
                <span class="text-[10px] text-[rgb(var(--fg))] flex-1 truncate">{{ item.event }}</span>
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
import type { AnnualSiteData, AnnualUserData } from '~/types/annual2025'
import { buildSparkLine, formatNumber, getPercentilePosition } from '~/utils/annual2025'

const props = defineProps<{
  isActive: boolean
  hasUserData: boolean
  userData: AnnualUserData
  siteData: AnnualSiteData
}>()

// Timeline pagination
const TIMELINE_PER_PAGE = 6
const timelinePageIndex = ref(0)
const timelineTotal = computed(() => props.userData.timeline?.length || 0)
const visibleTimeline = computed(() => {
  const all = props.userData.timeline || []
  const start = timelinePageIndex.value * TIMELINE_PER_PAGE
  return all.slice(start, start + TIMELINE_PER_PAGE)
})
const timelineTotalPages = computed(() => Math.ceil(timelineTotal.value / TIMELINE_PER_PAGE))

const nextTimelinePage = () => {
  if (timelinePageIndex.value < timelineTotalPages.value - 1) {
    timelinePageIndex.value++
  }
}

const prevTimelinePage = () => {
  if (timelinePageIndex.value > 0) {
    timelinePageIndex.value--
  }
}

watch(() => props.userData.timeline, () => {
  timelinePageIndex.value = 0
})

const contentDistributionSpark = computed(() => {
  const counts = props.siteData.distributions.contentWords.buckets.map(b => b.count)
  return buildSparkLine(counts)
})

const contentPercentilePosition = computed(() => getPercentilePosition(props.userData.percentiles.contentWords))

const contentPercentileBadge = computed(() => {
  const percentile = props.userData.percentiles.contentWords?.percentile
  if (percentile === undefined || percentile === null) return ''
  const exceed = Math.max(0, Math.round((1 - percentile) * 100))
  return `超过 ${exceed}% 的作者`
})
</script>
