<template>
  <section class="slide" :class="{ 'slide-active': isActive }">
    <div class="slide-content">
      <div class="max-w-5xl w-full grid grid-cols-1 md:grid-cols-2 gap-4 md:gap-6 px-2">
        <div class="space-y-4 md:space-y-6">
          <div class="relative group">
            <div class="absolute inset-0 bg-gradient-to-r from-yellow-500 to-orange-500 rounded-xl md:rounded-2xl blur opacity-20 group-hover:opacity-40 transition-opacity duration-500" />
            <div class="bg-[rgb(var(--panel))] border border-yellow-500/30 p-5 md:p-8 rounded-xl md:rounded-2xl relative h-full flex flex-col justify-between">
              <div>
                <div class="flex justify-between items-start mb-3 md:mb-4">
                  <div class="bg-yellow-500/20 text-yellow-500 px-2 md:px-3 py-1 rounded-full text-[10px] md:text-xs font-bold flex items-center gap-1">
                    <LucideIcon name="Trophy" class="w-3 h-3" /> 年度最高分原创
                  </div>
                  <div class="text-2xl md:text-4xl font-black text-[rgb(var(--fg))]">+{{ siteData.pageRankings.topOriginal.rating }}</div>
                </div>
                <h3 class="text-xl md:text-3xl font-bold text-[rgb(var(--fg))] mb-2">{{ siteData.pageRankings.topOriginal.title }}</h3>
                <p class="text-[rgb(var(--muted))] text-xs md:text-sm mb-4 md:mb-6 leading-relaxed line-clamp-3">
                  {{ siteData.pageRankings.topOriginal.desc }}
                </p>
              </div>
              <div class="flex gap-2 flex-wrap">
                <span
                  v-for="t in siteData.pageRankings.topOriginal.tags"
                  :key="t"
                  class="px-2 py-1 bg-[rgba(var(--fg),0.1)] rounded text-[10px] md:text-xs text-[rgb(var(--muted))]"
                >
                  #{{ t }}
                </span>
              </div>
            </div>
          </div>

          <div class="relative group">
            <div class="absolute inset-0 bg-gradient-to-r from-sky-500 to-blue-500 rounded-xl md:rounded-2xl blur opacity-20 group-hover:opacity-40 transition-opacity duration-500" />
            <div class="bg-[rgb(var(--panel))] border border-sky-500/30 p-4 md:p-6 rounded-xl md:rounded-2xl relative h-full flex flex-col justify-between">
              <div>
                <div class="flex justify-between items-start mb-3 md:mb-4">
                  <div class="bg-sky-500/15 text-sky-400 px-2 md:px-3 py-1 rounded-full text-[10px] md:text-xs font-bold flex items-center gap-1">
                    <LucideIcon name="Languages" class="w-3 h-3" /> 年度最高分翻译
                  </div>
                  <div class="text-2xl md:text-3xl font-black text-[rgb(var(--fg))]">+{{ siteData.pageRankings.topTranslation.rating }}</div>
                </div>
                <h3 class="text-lg md:text-2xl font-bold text-[rgb(var(--fg))] mb-2">{{ siteData.pageRankings.topTranslation.title }}</h3>
                <p class="text-[rgb(var(--muted))] text-xs md:text-sm mb-4 leading-relaxed line-clamp-2">
                  {{ siteData.pageRankings.topTranslation.desc }}
                </p>
              </div>
              <div class="flex gap-2 flex-wrap">
                <span
                  v-for="t in siteData.pageRankings.topTranslation.tags"
                  :key="t"
                  class="px-2 py-1 bg-[rgba(var(--fg),0.1)] rounded text-[10px] md:text-xs text-[rgb(var(--muted))]"
                >
                  #{{ t }}
                </span>
              </div>
            </div>
          </div>
        </div>

        <div class="space-y-4 md:space-y-6">
          <div class="bento-card">
            <div class="bento-header">
              <span class="text-xs md:text-sm font-medium text-[rgb(var(--muted))]">年度热门标签</span>
              <LucideIcon name="Hash" class="w-4 h-4 md:w-5 md:h-5 text-[rgb(var(--accent))]" />
            </div>
            <div class="flex flex-wrap gap-2 md:gap-3">
              <div
                v-for="(t, i) in siteData.funFacts.popularTags"
                :key="i"
                class="px-2 md:px-3 py-1 md:py-1.5 rounded-md border text-xs md:text-sm"
                :class="t.colorClass"
              >
                {{ t.tag }} <span class="opacity-60 text-[10px] md:text-xs ml-1">{{ t.count }}</span>
              </div>
            </div>
          </div>

          <div class="bento-card">
            <div class="bento-header">
              <span class="text-xs md:text-sm font-medium text-[rgb(var(--muted))]">月度发布趋势</span>
              <LucideIcon name="Activity" class="w-4 h-4 md:w-5 md:h-5 text-[rgb(var(--accent))]" />
            </div>
            <div class="text-[10px] text-[rgb(var(--muted))] mt-1">
              原 {{ formatNumber(monthlySummary.originals) }} / 译 {{ formatNumber(monthlySummary.translations) }} / 总 {{ formatNumber(monthlySummary.total) }}
            </div>
            <div class="flex items-end gap-1 md:gap-1.5 mt-3 md:mt-4">
              <div
                v-for="(item, i) in siteData.trends.monthlySeries"
                :key="item.monthLabel"
                class="flex-1 flex flex-col items-center justify-end"
              >
                <div class="bar-value text-[rgb(var(--accent))] mb-1">{{ item.total }}</div>
                <div class="w-full h-24 md:h-32 flex items-end">
                  <div
                    class="w-full bg-[rgb(var(--accent))] hover:bg-[rgb(var(--accent-strong))] bar-fill-y"
                    :style="{ height: item.total === 0 ? '10px' : `${Math.max((item.total / monthlyTrendMax) * 100, 12)}%`, minHeight: '10px', '--bar-delay': `${i * 40}ms` }"
                  />
                </div>
                <div class="bar-axis mt-1">{{ item.monthLabel }}</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
    <div class="slide-bg">
      <div class="w-full h-full bg-[linear-gradient(rgba(var(--accent),0.03)_1px,transparent_1px),linear-gradient(90deg,rgba(var(--accent),0.03)_1px,transparent_1px)] bg-[length:50px_50px]" />
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

const monthlyTrendMax = computed(() => {
  const monthly = props.siteData.trends.monthlySeries || []
  const totals = monthly.map(m => m.total)
  if (!totals.length) return 1
  const maxVal = Math.max(...totals)
  return maxVal > 0 ? maxVal : 1
})

const monthlySummary = computed(() => {
  return props.siteData.trends.monthlySeries.reduce((acc, item) => {
    acc.total += item.total
    acc.originals += item.originals
    acc.translations += item.translations
    return acc
  }, { total: 0, originals: 0, translations: 0 })
})
</script>
