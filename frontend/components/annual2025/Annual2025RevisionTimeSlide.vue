<template>
  <section class="slide" :class="{ 'slide-active': isActive }">
    <div class="slide-content">
      <div class="max-w-5xl w-full mx-auto px-2">
        <div class="flex items-center gap-2 md:gap-3 mb-6 md:mb-8">
          <div class="p-1.5 md:p-2 bg-[rgb(var(--accent))] rounded-lg">
            <LucideIcon name="Clock" class="w-4 h-4 md:w-5 md:h-5 text-white" />
          </div>
          <h2 class="text-2xl md:text-3xl font-bold">编辑时间分布</h2>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-2 gap-4 md:gap-6">
          <div class="space-y-4 md:space-y-6">
            <div class="bento-card">
              <div class="bento-header">
                <span class="text-xs md:text-sm font-medium text-[rgb(var(--muted))]">24小时编辑分布</span>
                <LucideIcon name="Clock" class="w-4 h-4 md:w-5 md:h-5 text-[rgb(var(--accent))]" />
              </div>
              <div class="flex items-center justify-center mt-4">
                <Annual2025ClockPlot class="w-48 h-48 md:w-56 md:h-56" :hours="siteData.hourlyRevisions" />
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

            <div class="bento-card">
              <div class="bento-header">
                <span class="text-xs md:text-sm font-medium text-[rgb(var(--muted))]">时段分布</span>
                <LucideIcon name="Sun" class="w-4 h-4 md:w-5 md:h-5 text-[rgb(var(--accent))]" />
              </div>
              <div class="space-y-2 mt-3">
                <div
                  v-for="(period, i) in siteData.revisionByTimeOfDay"
                  :key="period.period"
                  class="flex items-center gap-2 md:gap-3"
                >
                  <span class="bar-axis w-12">{{ period.period }}</span>
                  <div class="bar-track h-3 md:h-4 flex-1">
                    <div
                      class="bar-fill-x h-full"
                      :class="period.colorClass"
                      :style="{ width: `${period.percent}%`, '--bar-delay': `${i * 60}ms` }"
                    />
                  </div>
                  <span class="bar-value w-12 text-right">{{ period.percent }}%</span>
                </div>
              </div>
            </div>
          </div>

          <div class="space-y-4 md:space-y-6">
            <div class="bento-card">
              <div class="bento-header">
                <span class="text-xs md:text-sm font-medium text-[rgb(var(--muted))]">星期编辑分布</span>
                <LucideIcon name="CalendarCheck" class="w-4 h-4 md:w-5 md:h-5 text-[rgb(var(--accent))]" />
              </div>
              <div v-if="hasWeekdayData" class="space-y-2 mt-3">
                <div
                  v-for="(day, i) in siteData.revisionByWeekday"
                  :key="day.weekday"
                  class="flex items-center gap-2 md:gap-3"
                >
                  <span class="bar-axis w-10">{{ day.weekday }}</span>
                  <div class="bar-track h-3 md:h-4 flex-1">
                    <div
                      class="bar-fill-x h-full bg-[rgb(var(--accent))]"
                      :style="{ width: `${day.percent}%`, '--bar-delay': `${i * 60}ms` }"
                    />
                  </div>
                  <span class="bar-value w-14 text-right">{{ formatNumber(day.count) }}</span>
                </div>
              </div>
              <div v-else class="text-[10px] text-[rgb(var(--muted))] mt-3">暂无数据</div>
              <div v-if="hasWeekdayData" class="mt-2 text-[10px] text-[rgb(var(--muted))]">
                编辑最多: <span class="text-[rgb(var(--accent))] font-semibold">{{ peakWeekday }}</span>
              </div>
            </div>

            <div class="bento-card">
              <div class="bento-header">
                <span class="text-xs md:text-sm font-medium text-[rgb(var(--muted))]">月度编辑量</span>
                <LucideIcon name="Calendar" class="w-4 h-4 md:w-5 md:h-5 text-[rgb(var(--accent))]" />
              </div>
              <div class="flex items-end gap-1 mt-3">
                <div
                  v-for="(m, i) in siteData.monthlyRevisions"
                  :key="m.month"
                  class="flex-1 flex flex-col items-center justify-end"
                >
                  <div class="bar-value mb-0.5">{{ formatNumber(m.count) }}</div>
                  <div class="w-full h-16 md:h-20 flex items-end">
                    <div
                      class="w-full bg-purple-500 bar-fill-y"
                      :style="{ height: `${m.height}px`, '--bar-delay': `${i * 40}ms` }"
                      :title="`${m.month}: ${m.count} 次编辑`"
                    />
                  </div>
                  <span class="bar-axis mt-0.5">{{ m.monthLabel }}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
    <div class="slide-bg">
      <div class="absolute top-1/3 right-1/4 w-80 h-80 bg-indigo-500/10 blur-[100px] rounded-full" />
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { AnnualSiteData } from '~/types/annual2025'
import { formatNumber } from '~/utils/annual2025'

const props = defineProps<{
  isActive: boolean
  siteData: AnnualSiteData
}>()

const hasWeekdayData = computed(() => {
  return props.siteData.revisionByWeekday.some(day => day.count > 0)
})

const peakWeekday = computed(() => {
  if (!hasWeekdayData.value) return '-'
  const peak = props.siteData.revisionByWeekday.reduce((max, day) => {
    return day.count > max.count ? day : max
  }, { weekday: '-', count: 0, percent: 0, isPeak: false })
  return peak.weekday || '-'
})
</script>
