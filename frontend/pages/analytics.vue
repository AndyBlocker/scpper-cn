<template>
  <div class="container mx-auto px-4 py-6">
    <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-6">
      <h1 class="text-xl font-bold text-neutral-900 dark:text-neutral-100">站点数据分析</h1>
      <div class="flex flex-wrap items-center gap-2 w-full sm:w-auto">
        <select v-model="period" class="px-3 py-1.5 rounded border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 text-neutral-700 dark:text-neutral-200 w-full sm:w-auto text-sm">
          <option value="day">按日</option>
          <option value="week">按周</option>
          <option value="month">按月</option>
        </select>
        <input type="date" v-model="startDate" class="px-3 py-1.5 rounded border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 text-neutral-700 dark:text-neutral-200 w-full sm:w-auto text-sm" />
        <input type="date" v-model="endDate" class="px-3 py-1.5 rounded border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 text-neutral-700 dark:text-neutral-200 w-full sm:w-auto text-sm" />
        <button @click="refreshAll" class="px-3 py-1.5 rounded bg-[rgb(var(--accent))] text-white w-full sm:w-auto">应用</button>
      </div>
    </div>

    <!-- 分类总览 + 饼图 -->
    <div class="grid grid-cols-1 lg:grid-cols-5 gap-4 sm:gap-6 mb-6">
      <!-- 左侧 8 类卡片（桌面 4x4，移动两列） -->
      <div class="lg:col-span-2">
        <div class="grid grid-cols-2 gap-3">
          <div v-for="c in categories" :key="c.key" class="border border-neutral-200 dark:border-neutral-800 rounded-lg p-3 bg-white dark:bg-neutral-900">
            <div class="text-xs text-neutral-600 dark:text-neutral-400 mb-1">{{ c.label }}</div>
            <div class="text-xl sm:text-2xl font-bold" :style="{ color: c.color }">{{ summary[c.key] ?? '—' }}</div>
          </div>
        </div>
      </div>
      <!-- 右侧饼图 -->
      <div class="lg:col-span-3 border border-neutral-200 dark:border-neutral-800 rounded-lg p-3 sm:p-4 bg-white dark:bg-neutral-900">
        <h2 class="text-sm font-semibold text-neutral-700 dark:text-neutral-300 mb-3">分类占比（当前区间）</h2>
        <ClientOnly>
          <PieDonutChart :labels="pieLabels" :values="pieValues" :colors="pieColors" />
          <template #fallback>
            <div class="h-60 sm:h-72 flex items-center justify-center text-neutral-500 dark:text-neutral-400">加载图表中...</div>
          </template>
        </ClientOnly>
      </div>
    </div>

    <div class="grid grid-cols-1 lg:grid-cols-2 gap-4 sm:gap-6">
      <!-- 分类折线 -->
      <div class="border border-neutral-200 dark:border-neutral-800 rounded-lg p-3 sm:p-4 bg-white dark:bg-neutral-900">
        <h2 class="text-sm font-semibold text-neutral-700 dark:text-neutral-300 mb-3">分类随时间变化</h2>
        <ClientOnly>
          <TimeSeriesLineChart :key="'cat-'+period+'-'+startDate+'-'+endDate" :labels="labels" :datasets="categoryDatasets" y-title="数量" />
          <template #fallback>
            <div class="h-60 sm:h-72 flex items-center justify-center text-neutral-500 dark:text-neutral-400">加载图表中...</div>
          </template>
        </ClientOnly>
      </div>

      <!-- 活跃用户折线 -->
      <div class="border border-neutral-200 dark:border-neutral-800 rounded-lg p-3 sm:p-4 bg-white dark:bg-neutral-900">
        <h2 class="text-sm font-semibold text-neutral-700 dark:text-neutral-300 mb-3">活跃用户（60天滚动）</h2>
        <ClientOnly>
          <TimeSeriesLineChart :key="'active-'+period+'-'+startDate+'-'+endDate" :labels="activeLabels" :datasets="activeDatasets" y-title="人数" />
          <template #fallback>
            <div class="h-60 sm:h-72 flex items-center justify-center text-neutral-500 dark:text-neutral-400">加载图表中...</div>
          </template>
        </ClientOnly>
      </div>
    </div>

    <!-- 标签组合 -->
    <div class="mt-6 border border-neutral-200 dark:border-neutral-800 rounded-lg p-3 sm:p-4 bg-white dark:bg-neutral-900">
      <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-4">
        <h2 class="text-sm font-semibold text-neutral-700 dark:text-neutral-300">标签组合分析</h2>
        <div class="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 w-full sm:w-auto">
          <div class="flex items-center gap-1 w-full sm:w-auto">
            <input v-model="tagInput" @keyup.enter="addTag" placeholder="输入标签后回车" class="px-3 py-1.5 rounded border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 text-neutral-700 dark:text-neutral-200 w-full sm:w-64 text-sm" />
            <button @click="addTag" class="px-2 py-1.5 rounded bg-neutral-100 dark:bg-neutral-800 text-neutral-700 dark:text-neutral-200 w-full sm:w-auto">添加</button>
          </div>
          <select v-model="tagMatch" class="px-3 py-1.5 rounded border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 text-neutral-700 dark:text-neutral-200 w-full sm:w-auto text-sm">
            <option value="all">全部包含</option>
            <option value="any">包含任一</option>
          </select>
        </div>
      </div>
      <div class="flex flex-wrap gap-2 mb-3">
        <span v-for="t in tags" :key="t" class="inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300">
          {{ t }}
          <button @click="removeTag(t)" class="ml-1 text-blue-700/70 dark:text-blue-300/70">×</button>
        </span>
      </div>
      <ClientOnly>
        <TimeSeriesLineChart :key="'tag-'+period+'-'+startDate+'-'+endDate+'-'+tags.join(',')+'-'+tagMatch" :labels="tagLabels" :datasets="tagDatasets" y-title="数量" />
        <template #fallback>
          <div class="h-60 sm:h-72 flex items-center justify-center text-neutral-500 dark:text-neutral-400">加载图表中...</div>
        </template>
      </ClientOnly>
    </div>
  </div>
  
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useNuxtApp } from 'nuxt/app'
import TimeSeriesLineChart from '../components/TimeSeriesLineChart.vue'
import PieDonutChart from '../components/PieDonutChart.vue'

type BffFetcher = <T=any>(url: string, options?: any) => Promise<T>
const { $bff } = useNuxtApp()
const bff = $bff as BffFetcher

// helpers
function fmt(d: Date) { return d.toISOString().slice(0,10) }
function firstDayOfMonth(d = new Date()) { return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)) }
function yesterdayUTC() { const t = new Date(); return new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()-1)) }
function daysAgoUTC(n: number) {
  const t = new Date();
  return new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate() - n))
}

const period = ref<'day'|'week'|'month'>('day')
// 默认过去30天
const startDate = ref<string>(fmt(daysAgoUTC(30)))
const endDate = ref<string>(fmt(yesterdayUTC()))

// 分类配色
const categories = [
  { key: 'scp', label: 'SCP', color: '#2563eb' },
  { key: 'story', label: '故事', color: '#16a34a' },
  { key: 'goi', label: 'GoI格式', color: '#f59e0b' },
  { key: 'art', label: '艺术作品', color: '#db2777' },
  { key: 'wanderers', label: '图书馆', color: '#8b5cf6' },
  { key: 'translation', label: '翻译', color: '#0ea5e9' },
  { key: '三句话外围', label: '三句话外围', color: '#10b981' },
  { key: '异常物品', label: '异常物品', color: '#ef4444' }
] as const

const summary = ref<Record<string, number>>({})
const series = ref<Array<{ date: string; category: string; count: number }>>([])

const labels = computed(() => {
  const set = new Set(series.value.map(s => s.date.slice(0,10)))
  return Array.from(set).sort()
})

const categoryDatasets = computed(() => {
  return categories.map(c => {
    const map = new Map(series.value.filter(s => s.category === c.key).map(s => [s.date.slice(0,10), s.count]))
    const data = labels.value.map(d => map.get(d) || 0)
    return { label: c.label, data, color: c.color }
  })
})

// 饼图数据
const pieLabels = computed(() => categories.map(c => c.label))
const pieValues = computed(() => categories.map(c => Number(summary.value[c.key] || 0)))
const pieColors = computed(() => categories.map(c => c.color))

// 活跃用户
const activeSeries = ref<Array<{ date: string; activeUsers: number }>>([])
const activeLabels = computed(() => activeSeries.value.map(s => s.date.slice(0,10)))
const activeDatasets = computed(() => [{ label: '活跃用户', data: activeSeries.value.map(s => s.activeUsers), color: '#14b8a6', fill: true }])

// 标签组合（默认当前月、常见组合避免空图）
const tagInput = ref<string>('')
const tags = ref<string[]>(['原创', 'scp'])
const tagMatch = ref<'all'|'any'>('all')
const tagSeries = ref<Array<{ date: string; newCount: number; cumulativeCount: number }>>([])
const tagLabels = computed(() => tagSeries.value.map(s => s.date.slice(0,10)))
const tagDatasets = computed(() => [
  { label: '新增', data: tagSeries.value.map(s => s.newCount), color: '#3b82f6', type: 'bar' as const, yAxisID: 'y' as const },
  { label: '累计', data: tagSeries.value.map(s => s.cumulativeCount), color: '#a855f7', type: 'line' as const, yAxisID: 'y1' as const, fill: false }
])

function addTag() {
  const t = tagInput.value.trim()
  if (!t) return
  if (!tags.value.includes(t)) tags.value.push(t)
  tagInput.value = ''
  refreshTags()
}
function removeTag(t: string) {
  tags.value = tags.value.filter(x => x !== t)
  refreshTags()
}

async function refreshSummary() {
  const data = await bff<Array<{ category: string; count: number }>>('/analytics/pages/category-summary', {
    params: { startDate: startDate.value, endDate: endDate.value }
  })
  const map: Record<string, number> = {}
  for (const r of data) map[r.category] = Number(r.count || 0)
  summary.value = map
}

async function refreshSeries() {
  series.value = await bff('/analytics/pages/category-series', {
    params: { startDate: startDate.value, endDate: endDate.value, period: period.value }
  })
}

async function refreshActive() {
  activeSeries.value = await bff('/analytics/users/active-series', {
    params: { startDate: startDate.value, endDate: endDate.value, period: period.value }
  })
}

async function refreshTags() {
  if (tags.value.length === 0) { tagSeries.value = []; return }
  tagSeries.value = await bff('/analytics/pages/tag-series', {
    params: { startDate: startDate.value, endDate: endDate.value, period: period.value, match: tagMatch.value, tags: tags.value }
  })
}

async function refreshAll() {
  await Promise.all([refreshSummary(), refreshSeries(), refreshActive(), refreshTags()])
}

onMounted(() => { refreshAll() })
</script>

<style scoped>
.container { max-width: 1200px; }
</style>


