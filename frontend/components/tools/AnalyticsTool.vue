<template>
  <div class="mx-auto w-full max-w-6xl py-6">
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
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
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
            <option value="all">标签全部匹配</option>
            <option value="any">任意一个匹配</option>
          </select>
          <button v-if="tags.length > 0" @click="clearTags" class="px-3 py-1.5 rounded border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 text-neutral-600 dark:text-neutral-300 w-full sm:w-auto text-sm">清空</button>
        </div>
      </div>

      <div class="flex flex-wrap items-center gap-2 mb-4">
        <span v-for="t in tags" :key="t" class="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-neutral-100 dark:bg-neutral-800 text-neutral-700 dark:text-neutral-200 text-sm">
          {{ t }}
          <button @click="removeTag(t)" class="text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-200">
            <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </span>
        <span v-if="tags.length === 0" class="text-sm text-neutral-500 dark:text-neutral-400">暂无标签，请添加。</span>
      </div>

      <div class="border border-neutral-200 dark:border-neutral-800 rounded-lg p-3 sm:p-4 bg-white dark:bg-neutral-900">
        <ClientOnly>
          <TimeSeriesLineChart
            :key="'tag-'+period+'-'+startDate+'-'+endDate+'-'+tagMatch+'-'+tags.join(',')"
            :labels="tagLabels"
            :datasets="tagDatasets"
            :options="tagChartOptions"
            y-title="数量"
          />
          <template #fallback>
            <div class="h-60 sm:h-72 flex items-center justify-center text-neutral-500 dark:text-neutral-400">加载图表中...</div>
          </template>
        </ClientOnly>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useNuxtApp } from 'nuxt/app'

import PieDonutChart from '~/components/PieDonutChart.vue'
import TimeSeriesLineChart from '~/components/TimeSeriesLineChart.vue'

const { $bff } = useNuxtApp()

const today = new Date()
const defaultEnd = today.toISOString().slice(0, 10)
const defaultStart = new Date(today.getTime() - 29 * 24 * 3600 * 1000).toISOString().slice(0, 10)

const period = ref<'day' | 'week' | 'month'>('day')
const startDate = ref<string>(defaultStart)
const endDate = ref<string>(defaultEnd)

const categories = [
  { key: 'scp', label: 'SCP', color: '#2563eb' },
  { key: 'goi', label: 'GOI 格式', color: '#4c1d95' },
  { key: 'story', label: '故事', color: '#ea580c' },
  { key: 'wanderers', label: '图书馆', color: '#16a34a' },
  { key: 'art', label: '艺术作品', color: '#0ea5e9' },
  { key: '三句话外围', label: '三句话外围', color: '#b91c1c' },
  { key: '异常物品', label: '异常物品', color: '#ef4444' },
  { key: 'translation', label: '翻译', color: '#7c3aed' }
] as const

const summary = ref<Record<string, number>>({})
const series = ref<Array<{ date: string; category: string; count: number }>>([])

const labels = computed(() => {
  const set = new Set(series.value.map(s => s.date.slice(0, 10)))
  return Array.from(set).sort()
})

const categoryDatasets = computed(() => {
  return categories.map(c => {
    const map = new Map(series.value.filter(s => s.category === c.key).map(s => [s.date.slice(0, 10), s.count]))
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
const activeLabels = computed(() => activeSeries.value.map(s => s.date.slice(0, 10)))
const activeDatasets = computed(() => [{ label: '活跃用户', data: activeSeries.value.map(s => s.activeUsers), color: '#14b8a6', fill: true }])

// 标签组合（默认当前月、常见组合避免空图）
const tagInput = ref<string>('')
const tags = ref<string[]>(['原创', 'scp'])
const tagMatch = ref<'all' | 'any'>('all')
const tagSeries = ref<Array<{ date: string; newCount: number; cumulativeCount: number }>>([])
const tagLabels = computed(() => tagSeries.value.map(s => s.date.slice(0, 10)))
const tagDatasets = computed(() => [
  { label: '新增', data: tagSeries.value.map(s => s.newCount), color: '#3b82f6', type: 'bar' as const, yAxisID: 'y' as const },
  { label: '累计', data: tagSeries.value.map(s => s.cumulativeCount), color: '#a855f7', type: 'line' as const, yAxisID: 'y1' as const, fill: false }
])

const tagChartOptions = {
  responsive: true,
  maintainAspectRatio: false,
  scales: {
    y: {
      beginAtZero: true,
      position: 'left' as const,
      ticks: { precision: 0 }
    },
    y1: {
      beginAtZero: true,
      position: 'right' as const,
      grid: { drawOnChartArea: false },
      ticks: { precision: 0 }
    }
  },
  plugins: {
    legend: { position: 'bottom' as const }
  }
}

function clearTags() {
  tags.value = []
  tagSeries.value = []
}

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
  const data = await $bff<Array<{ category: string; count: number }>>('/analytics/pages/category-summary', {
    params: { startDate: startDate.value, endDate: endDate.value }
  })
  const map: Record<string, number> = {}
  for (const r of data) map[r.category] = Number(r.count || 0)
  summary.value = map
}

async function refreshSeries() {
  series.value = await $bff('/analytics/pages/category-series', {
    params: { startDate: startDate.value, endDate: endDate.value, period: period.value }
  })
}

async function refreshActive() {
  activeSeries.value = await $bff('/analytics/users/active-series', {
    params: { startDate: startDate.value, endDate: endDate.value, period: period.value }
  })
}

async function refreshTags() {
  if (tags.value.length === 0) {
    tagSeries.value = []
    return
  }
  tagSeries.value = await $bff('/analytics/pages/tag-series', {
    params: { startDate: startDate.value, endDate: endDate.value, period: period.value, match: tagMatch.value, tags: tags.value }
  })
}

async function refreshAll() {
  await Promise.all([refreshSummary(), refreshSeries(), refreshActive(), refreshTags()])
}

onMounted(() => {
  refreshAll()
})

</script>

<style scoped>
.container {
  max-width: 1200px;
}
</style>
