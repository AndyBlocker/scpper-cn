<template>
  <section class="slide" :class="{ 'slide-active': isActive }">
    <div class="slide-content">
      <div class="max-w-5xl w-full mx-auto px-2">
        <div class="flex items-center gap-2 md:gap-3 mb-4 md:mb-6">
          <div class="p-1.5 md:p-2 bg-red-500/20 rounded-lg">
            <LucideIcon name="Trash2" class="w-4 h-4 md:w-5 md:h-5 text-red-400" />
          </div>
          <h2 class="text-2xl md:text-3xl font-bold">已删除页面统计</h2>
        </div>

        <!-- 数据说明 -->
        <div class="mb-4 md:mb-6 px-3 py-2 md:px-4 md:py-3 bg-amber-500/15 border border-amber-500/30 rounded-lg flex items-start gap-2">
          <LucideIcon name="AlertCircle" class="w-4 h-4 text-amber-500 flex-shrink-0 mt-0.5" />
          <p class="text-xs md:text-sm text-[rgb(var(--fg))]">
            由于今年大部分时间 scpper.com 对 scp-wiki-cn 的记录停止、scpper.mer.run 尚未运行，已删除页面数据仅包含 9 月后 scpper.mer.run 运行后记载的内容。
          </p>
        </div>

        <div v-if="stats" class="grid grid-cols-2 md:grid-cols-4 gap-3 md:gap-4">
          <!-- 总删除数 -->
          <div class="bento-card col-span-2 row-span-2 bg-gradient-to-br from-red-500/10 to-transparent">
            <div class="bento-header">
              <span class="text-xs md:text-sm font-medium uppercase tracking-wider text-[rgb(var(--muted))]">今年创建并删除</span>
              <LucideIcon name="FileX" class="w-4 h-4 md:w-5 md:h-5 text-red-400" />
            </div>
            <div class="text-4xl md:text-6xl font-black text-[rgb(var(--fg))] mb-2">
              <Annual2025CountUp :end="stats.total" />
            </div>
            <div class="text-xs md:text-sm text-[rgb(var(--muted))] mb-4">
              页面在发布后被删除
            </div>
            <!-- 原创/翻译分布 -->
            <div class="mt-4 md:mt-6 flex-1 flex flex-col justify-center gap-1.5">
              <div class="bar-track h-2 md:h-2.5 w-full">
                <div
                  class="bar-fill-x bg-green-500"
                  :style="{ width: `${Math.max(originalPercent, 3)}%`, '--bar-delay': '0ms' }"
                />
                <div
                  class="bar-fill-x bg-blue-500"
                  :style="{ width: `${Math.max(translationPercent, 3)}%`, '--bar-delay': '80ms' }"
                />
              </div>
              <div class="flex justify-between text-[10px] md:text-xs mt-1">
                <span class="text-green-500">原创 {{ stats.originalCount }} <span class="text-[rgb(var(--muted))]">({{ originalPercent }}%)</span></span>
                <span class="text-blue-500">翻译 {{ stats.translationCount }} <span class="text-[rgb(var(--muted))]">({{ translationPercent }}%)</span></span>
              </div>
            </div>
          </div>

          <!-- 六大类分布 -->
          <div class="bento-card col-span-2 row-span-2">
            <div class="bento-header">
              <span class="text-xs md:text-sm font-medium uppercase tracking-wider text-[rgb(var(--muted))]">按分类</span>
              <LucideIcon name="PieChart" class="w-4 h-4 md:w-5 md:h-5 text-[rgb(var(--accent))]" />
            </div>
            <div class="space-y-2 mt-2">
              <div
                v-for="cat in categoryBreakdown"
                :key="cat.key"
                class="flex items-center gap-2"
              >
                <div class="w-16 md:w-20 text-xs md:text-sm text-[rgb(var(--muted))] truncate">{{ cat.label }}</div>
                <div class="flex-1 bar-track h-3 md:h-4">
                  <div
                    class="bar-fill-x"
                    :class="cat.colorClass"
                    :style="{ width: `${cat.percent}%`, '--bar-delay': `${cat.delay}ms` }"
                  />
                </div>
                <div class="w-10 md:w-12 text-right text-xs md:text-sm font-medium">{{ cat.count }}</div>
              </div>
            </div>
          </div>

          <!-- 月度趋势 -->
          <div class="bento-card col-span-2 md:col-span-4">
            <div class="bento-header">
              <span class="text-xs md:text-sm font-medium uppercase tracking-wider text-[rgb(var(--muted))]">月度删除趋势</span>
              <LucideIcon name="TrendingDown" class="w-4 h-4 md:w-5 md:h-5 text-red-400" />
            </div>
            <div class="flex items-end gap-1 md:gap-2 h-24 md:h-32 mt-4">
              <div
                v-for="(item, idx) in monthlyTrendData"
                :key="item.month"
                class="flex-1 flex flex-col items-center"
                :style="{ height: '100%' }"
              >
                <div class="flex-1 w-full flex items-end justify-center">
                  <div
                    class="w-4 md:w-6 bg-red-500 rounded-t relative"
                    :style="{ height: `${item.heightPercent}%`, '--bar-delay': `${idx * 50}ms` }"
                  >
                    <div class="absolute -top-5 left-1/2 -translate-x-1/2 text-[10px] md:text-xs font-medium text-red-400">
                      {{ item.count }}
                    </div>
                  </div>
                </div>
                <div class="text-[10px] md:text-xs text-[rgb(var(--muted))] mt-1">{{ item.monthLabel }}</div>
              </div>
            </div>
          </div>

          <!-- 删除最多的作者 -->
          <div v-if="stats.topAuthors && stats.topAuthors.length > 0" class="bento-card col-span-2 md:col-span-4">
            <div class="bento-header">
              <span class="text-xs md:text-sm font-medium uppercase tracking-wider text-[rgb(var(--muted))]">今年创建并删除页面最多的作者</span>
              <LucideIcon name="Users" class="w-4 h-4 md:w-5 md:h-5 text-[rgb(var(--accent))]" />
            </div>
            <div class="grid grid-cols-2 md:grid-cols-5 gap-2 mt-3">
              <div
                v-for="author in stats.topAuthors.slice(0, 5)"
                :key="author.userId"
                class="flex items-center gap-2 p-2 rounded-lg bg-[rgba(var(--fg),0.03)]"
              >
                <div class="w-6 h-6 md:w-8 md:h-8 rounded-full bg-red-500/20 flex items-center justify-center text-xs md:text-sm font-bold text-red-400">
                  {{ author.rank }}
                </div>
                <div class="flex-1 min-w-0">
                  <div class="text-xs md:text-sm font-medium truncate">{{ author.displayName }}</div>
                  <div class="text-[10px] md:text-xs text-[rgb(var(--muted))]">{{ author.deletedCount }} 篇</div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- 无数据提示 -->
        <div v-else class="text-center py-12">
          <LucideIcon name="CheckCircle" class="w-12 h-12 text-green-500 mx-auto mb-4" />
          <p class="text-[rgb(var(--muted))]">今年没有被删除的页面数据</p>
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

const props = defineProps<{
  isActive: boolean
  siteData: AnnualSiteData
}>()

const stats = computed(() => props.siteData.deletedPageStats)

const originalPercent = computed(() => {
  if (!stats.value || stats.value.total === 0) return 0
  return Math.round((stats.value.originalCount / stats.value.total) * 100)
})

const translationPercent = computed(() => {
  if (!stats.value || stats.value.total === 0) return 0
  return Math.round((stats.value.translationCount / stats.value.total) * 100)
})

const categoryBreakdown = computed(() => {
  if (!stats.value) return []
  const { byCategory } = stats.value
  const categories = [
    { key: 'scp', label: 'SCP', count: byCategory.scp, colorClass: 'bg-red-500' },
    { key: 'tale', label: '故事', count: byCategory.tale, colorClass: 'bg-blue-500' },
    { key: 'wanderers', label: 'Wanderers', count: byCategory.wanderers, colorClass: 'bg-purple-500' },
    { key: 'goi', label: 'GOI格式', count: byCategory.goi, colorClass: 'bg-orange-500' },
    { key: 'art', label: '艺术作品', count: byCategory.art, colorClass: 'bg-pink-500' },
    { key: 'article', label: '文章', count: byCategory.article, colorClass: 'bg-cyan-500' }
  ]
  const maxCount = Math.max(...categories.map(c => c.count), 1)
  return categories
    .filter(c => c.count > 0)
    .sort((a, b) => b.count - a.count)
    .map((c, idx) => ({
      ...c,
      percent: Math.round((c.count / maxCount) * 100),
      delay: idx * 60
    }))
})

const monthlyTrendData = computed(() => {
  if (!stats.value?.monthlyTrend) return []
  const trend = stats.value.monthlyTrend
  const maxCount = Math.max(...trend.map((t: { month: string; count: number }) => t.count), 1)
  return trend.map((t: { month: string; count: number }) => ({
    month: t.month,
    monthLabel: t.month.slice(5), // "2025-09" -> "09"
    count: t.count,
    heightPercent: Math.round((t.count / maxCount) * 100)
  }))
})
</script>
