<template>
  <section class="slide" :class="{ 'slide-active': isActive }">
    <div class="slide-content">
      <div class="max-w-5xl w-full mx-auto px-2">
        <div class="flex items-center gap-2 md:gap-3 mb-6 md:mb-8">
          <div class="p-1.5 md:p-2 bg-[rgb(var(--accent))] rounded-lg">
            <LucideIcon name="Globe" class="w-4 h-4 md:w-5 md:h-5 text-white" />
          </div>
          <h2 class="text-2xl md:text-3xl font-bold">全站数据概览</h2>
        </div>

        <div class="grid grid-cols-2 md:grid-cols-4 gap-3 md:gap-4">
          <div class="bento-card col-span-2 row-span-2 bg-gradient-to-br from-[rgba(var(--accent),0.15)] to-transparent">
            <div class="bento-header">
              <span class="text-xs md:text-sm font-medium uppercase tracking-wider text-[rgb(var(--muted))]">年度新增文档</span>
              <LucideIcon name="FileText" class="w-4 h-4 md:w-5 md:h-5 text-[rgb(var(--accent))]" />
            </div>
            <div class="text-4xl md:text-6xl font-black text-[rgb(var(--fg))] mb-2">
              <Annual2025CountUp :end="siteData.overview.pages.total" />
            </div>
            <div class="flex items-center gap-1 md:gap-2 text-[rgb(var(--success))] bg-[rgba(var(--success),0.1)] w-fit px-2 py-1 rounded text-xs md:text-sm mb-3 md:mb-4">
              <LucideIcon name="TrendingUp" class="w-3 h-3 md:w-4 md:h-4" /> {{ siteData.overview.pages.growth }} 同比增长
            </div>
            <div class="mt-4 md:mt-6 flex-1 flex flex-col justify-center gap-1.5">
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
              <div class="flex justify-between text-[10px] md:text-xs mt-1">
                <span class="text-green-500">原创 {{ formatNumber(overallSplit.originals) }} <span class="text-[rgb(var(--muted))]">({{ overallSplit.originalPercent }}%)</span></span>
                <span class="text-blue-500">翻译 {{ formatNumber(overallSplit.translations) }} <span class="text-[rgb(var(--muted))]">({{ overallSplit.translationPercent }}%)</span></span>
              </div>
            </div>
          </div>

          <div class="bento-card">
            <div class="bento-header">
              <span class="text-[10px] md:text-sm font-medium uppercase tracking-wider text-[rgb(var(--muted))]">总字数</span>
              <LucideIcon name="PenTool" class="w-4 h-4 md:w-5 md:h-5 text-[rgb(var(--accent))]" />
            </div>
            <div class="text-xl md:text-3xl font-bold">
              {{ formatNumber(siteData.overview.words.total) }}
            </div>
            <div class="text-[10px] md:text-xs text-[rgb(var(--muted))] mt-1">平均每篇 {{ siteData.overview.words.avgPerDoc }} 字</div>
          </div>

          <div class="bento-card">
            <div class="bento-header">
              <span class="text-[10px] md:text-sm font-medium uppercase tracking-wider text-[rgb(var(--muted))]">活跃用户</span>
              <LucideIcon name="Users" class="w-4 h-4 md:w-5 md:h-5 text-[rgb(var(--accent))]" />
            </div>
            <div class="text-xl md:text-3xl font-bold">
              {{ siteData.overview.users.activeThisYear }}
            </div>
            <div class="text-[10px] md:text-xs text-[rgb(var(--muted))] mt-1">新注册 {{ siteData.overview.users.newThisYear }} 人</div>
          </div>

          <div class="bento-card col-span-2 bg-gradient-to-r from-[rgba(var(--accent),0.08)] to-transparent">
            <div class="bento-header">
              <span class="text-xs md:text-sm font-medium uppercase tracking-wider text-[rgb(var(--muted))]">社区投票</span>
              <LucideIcon name="ThumbsUp" class="w-4 h-4 md:w-5 md:h-5 text-[rgb(var(--accent))]" />
            </div>
            <div class="flex justify-between items-end">
              <div>
                <div class="text-2xl md:text-3xl font-bold"><Annual2025CountUp :end="siteData.overview.votes.total" /></div>
                <div class="text-xs md:text-sm text-[rgb(var(--muted))]">总投票数</div>
              </div>
              <div class="text-right">
                <div class="text-lg md:text-xl font-bold">{{ siteData.overview.votes.dailyAvg }}</div>
                <div class="text-xs md:text-sm text-[rgb(var(--muted))]">日均投票</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
    <div class="slide-bg">
      <div class="w-full h-full bg-[radial-gradient(rgba(var(--fg),0.03)_1px,transparent_1px)] bg-[length:24px_24px]" />
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
</script>
