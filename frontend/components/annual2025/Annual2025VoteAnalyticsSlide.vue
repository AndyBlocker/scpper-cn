<template>
  <section class="slide" :class="{ 'slide-active': isActive }">
    <div class="slide-content">
      <div class="max-w-5xl w-full mx-auto px-2">
        <div class="flex items-center gap-2 md:gap-3 mb-6 md:mb-8">
          <div class="p-1.5 md:p-2 bg-[rgb(var(--accent))] rounded-lg">
            <LucideIcon name="Vote" class="w-4 h-4 md:w-5 md:h-5 text-white" />
          </div>
          <h2 class="text-2xl md:text-3xl font-bold">投票数据分析</h2>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-2 gap-4 md:gap-6">
          <div class="bento-card col-span-1 md:col-span-2">
            <div class="bento-header">
              <span class="text-xs md:text-sm font-medium text-[rgb(var(--muted))]">月度投票趋势</span>
              <LucideIcon name="TrendingUp" class="w-4 h-4 md:w-5 md:h-5 text-[rgb(var(--accent))]" />
            </div>
            <div class="flex items-end gap-1 md:gap-2 h-32 md:h-40 mt-3 md:mt-4">
              <div
                v-for="(item, i) in siteData.monthlyVotes"
                :key="item.month"
                class="flex-1 flex flex-col items-center gap-1"
              >
                <div class="bar-value">{{ formatNumber(item.total) }}</div>
                <div class="w-full flex flex-col gap-0.5">
                  <div
                    class="w-full bg-green-500 bar-fill-y"
                    :style="{ height: `${item.upHeight}px`, '--bar-delay': `${i * 40}ms` }"
                    :title="`UpVotes: ${item.up}`"
                  />
                  <div
                    class="w-full bg-red-400 rounded-b bar-fill-y"
                    :style="{ height: `${item.downHeight}px`, '--bar-delay': `${i * 40 + 60}ms` }"
                    :title="`DownVotes: ${item.down}`"
                  />
                </div>
                <span class="bar-axis">{{ item.monthLabel }}</span>
              </div>
            </div>
            <div class="flex justify-center gap-4 mt-3 text-xs">
              <div class="flex items-center gap-1">
                <div class="w-3 h-3 bg-green-500 rounded" />
                <span class="text-[rgb(var(--muted))]">UpVotes</span>
              </div>
              <div class="flex items-center gap-1">
                <div class="w-3 h-3 bg-red-400 rounded" />
                <span class="text-[rgb(var(--muted))]">DownVotes</span>
              </div>
            </div>
          </div>

          <div class="bento-card">
            <div class="bento-header">
              <span class="text-xs md:text-sm font-medium text-[rgb(var(--muted))]">分类投票分布</span>
              <LucideIcon name="PieChart" class="w-4 h-4 md:w-5 md:h-5 text-[rgb(var(--accent))]" />
            </div>
            <div class="space-y-2 mt-3">
              <div
                v-for="(cat, i) in siteData.votesByCategory"
                :key="cat.name"
                class="flex items-center gap-2"
              >
                <span class="text-xs text-[rgb(var(--muted))] w-16 truncate">{{ cat.name }}</span>
                <div class="bar-track h-3 md:h-4 flex-1">
                  <div
                    class="h-full flex rounded-full overflow-hidden flex-shrink-0"
                    :style="{ width: `${cat.scaledPercent}%` }"
                  >
                    <div
                      class="bar-fill-x bg-green-500"
                      :style="{ width: `${cat.upPercent}%`, '--bar-delay': `${i * 60}ms` }"
                    />
                    <div
                      class="bar-fill-x bg-red-400"
                      :style="{ width: `${cat.downPercent}%`, '--bar-delay': `${i * 60 + 80}ms` }"
                    />
                  </div>
                </div>
                <span class="bar-value w-10 text-right">{{ formatNumber(cat.total) }}</span>
              </div>
            </div>
          </div>

          <div class="bento-card">
            <div class="bento-header">
              <span class="text-xs md:text-sm font-medium text-[rgb(var(--muted))]">投票统计</span>
              <LucideIcon name="BarChart2" class="w-4 h-4 md:w-5 md:h-5 text-[rgb(var(--accent))]" />
            </div>
            <div class="grid grid-cols-2 gap-3 mt-3">
              <div class="text-center p-3 bg-[rgba(var(--fg),0.03)] rounded-lg">
                <div class="text-xl md:text-2xl font-bold text-green-500">{{ formatNumber(siteData.overview.votes.up) }}</div>
                <div class="text-[10px] text-[rgb(var(--muted))]">UpVotes</div>
              </div>
              <div class="text-center p-3 bg-[rgba(var(--fg),0.03)] rounded-lg">
                <div class="text-xl md:text-2xl font-bold text-red-400">{{ formatNumber(siteData.overview.votes.down) }}</div>
                <div class="text-[10px] text-[rgb(var(--muted))]">DownVotes</div>
              </div>
              <div class="col-span-2 text-center p-3 bg-[rgba(var(--accent),0.1)] rounded-lg">
                <div class="text-2xl md:text-3xl font-bold text-[rgb(var(--accent))]">{{ siteData.overview.votes.upRate }}%</div>
                <div class="text-[10px] text-[rgb(var(--muted))]">年度UpVote率</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
    <div class="slide-bg">
      <div class="absolute top-1/4 left-1/4 w-96 h-96 bg-green-500/10 blur-[100px] rounded-full" />
      <div class="absolute bottom-1/4 right-1/4 w-64 h-64 bg-red-500/10 blur-[80px] rounded-full" />
    </div>
  </section>
</template>

<script setup lang="ts">
import type { AnnualSiteData } from '~/types/annual2025'
import { formatNumber } from '~/utils/annual2025'

defineProps<{
  isActive: boolean
  siteData: AnnualSiteData
}>()
</script>
