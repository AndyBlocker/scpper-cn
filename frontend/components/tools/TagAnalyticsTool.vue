<template>
  <div class="mx-auto w-full max-w-6xl py-6">
    <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-6">
      <h1 class="text-xl font-bold text-neutral-900 dark:text-neutral-100">标签偏好榜</h1>
      <div class="flex items-center gap-2 w-full sm:w-auto">
        <div class="relative w-full sm:w-80" @click.stop>
          <input
            v-model="search"
            @input="onSearchInput"
            @focus="onSearchFocus"
            @blur="onSearchBlur"
            placeholder="搜索标签，例如 原创 / scp / 故事..."
            class="px-3 py-1.5 rounded border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 text-neutral-700 dark:text-neutral-200 w-full text-sm"
          />
          <div v-if="suggestionsOpen && suggestions.length > 0" class="absolute z-10 mt-1 w-full rounded border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 shadow max-h-60 overflow-y-auto">
            <button
              v-for="s in suggestions"
              :key="s"
              @click="selectTag(s)"
              class="block w-full text-left px-3 py-2 text-sm hover:bg-neutral-50 dark:hover:bg-neutral-800 text-neutral-700 dark:text-neutral-200"
            >{{ s }}</button>
          </div>
        </div>
        <select v-model.number="limit" @change="refreshAll" class="px-3 py-1.5 rounded border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 text-neutral-700 dark:text-neutral-200 text-sm">
          <option :value="10">前10</option>
          <option :value="20">前20</option>
          <option :value="50">前50</option>
        </select>
      </div>
    </div>

    <!-- 标签概览：文章数量分布 -->
    <section class="rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 shadow-sm p-4 sm:p-6 mb-6">
      <div class="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
        <div>
          <h2 class="text-lg font-semibold text-neutral-900 dark:text-neutral-100">标签文章数量分布</h2>
          <p class="text-sm text-neutral-500 dark:text-neutral-400 mt-1">
            共 {{ totalTags }} 个标签，按文章数量划分 100 个区间，帮助快速感知标签热度长尾。
          </p>
        </div>
        <button
          type="button"
          class="self-start inline-flex items-center gap-1 rounded border border-neutral-200 dark:border-neutral-700 px-3 py-1.5 text-sm text-neutral-600 dark:text-neutral-300 hover:border-neutral-300 dark:hover:border-neutral-600"
          @click="reloadTagData"
        >
          <span class="inline-block w-2 h-2 rounded-full" :class="tagDataLoading ? 'animate-ping bg-[rgb(var(--accent))]' : 'bg-neutral-400 dark:bg-neutral-500'"></span>
          刷新数据
        </button>
      </div>
      <div class="mt-4">
        <div v-if="tagDataError" class="rounded border border-red-200 dark:border-red-700 bg-red-50 dark:bg-red-900/20 px-4 py-3 text-sm text-red-700 dark:text-red-300">
          加载标签统计失败：{{ tagDataError }}
        </div>
        <div v-else-if="tagDataLoading" class="h-36 sm:h-44 rounded bg-neutral-100 dark:bg-neutral-800 animate-pulse" />
        <div v-else-if="histogramBins.length === 0" class="text-sm text-neutral-500 dark:text-neutral-400">
          暂无可用的标签分布数据。
        </div>
        <div v-else>
          <div class="h-72 sm:h-80 rounded-md bg-neutral-50 dark:bg-neutral-800 px-3 py-3">
            <Bar
              v-if="histogramBins.length > 0"
              :data="histogramChartData"
              :options="histogramChartOptions"
            />
            <div v-else class="flex h-full items-center justify-center text-sm text-neutral-500 dark:text-neutral-400">
              暂无可视化数据
            </div>
          </div>
          <div class="flex flex-wrap items-center justify-between text-xs sm:text-sm text-neutral-500 dark:text-neutral-400 mt-3">
            <span>最少：{{ histogramSummary.min }} 篇</span>
            <span>中位数：{{ histogramSummary.median }} 篇</span>
            <span>最多：{{ histogramSummary.max }} 篇</span>
          </div>
        </div>
      </div>
    </section>

    <!-- 标签概览：标签列表与排序 -->
    <section class="rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 shadow-sm p-4 sm:p-6 mb-6">
      <div class="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
        <div>
          <h2 class="text-lg font-semibold text-neutral-900 dark:text-neutral-100">标签文章数量概览</h2>
          <p class="text-sm text-neutral-500 dark:text-neutral-400 mt-1">选择排序方式或翻页查看不同标签的文章规模，点击标签可跳转至搜索页面并直接过滤。</p>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <div class="flex items-center gap-2">
            <button
              v-for="option in sortOptions"
              :key="option.key"
              type="button"
              @click="changeSort(option.key)"
              class="px-3 py-1.5 text-sm rounded border transition-colors"
              :class="[
                tableSort === option.key
                  ? 'border-[rgb(var(--accent))] text-[rgb(var(--accent))]' 
                  : 'border-neutral-200 dark:border-neutral-700 text-neutral-600 dark:text-neutral-300 hover:border-neutral-300 dark:hover:border-neutral-600'
              ]"
            >
              {{ option.label }}
              <span v-if="tableSort === option.key" class="ml-1 text-xs">
                {{ tableOrder === 'desc' ? '↓' : '↑' }}
              </span>
            </button>
          </div>
          <label class="text-xs text-neutral-500 dark:text-neutral-400">
            每页
            <select v-model.number="pageSize" class="ml-1 rounded border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-2 py-1 text-sm text-neutral-600 dark:text-neutral-300">
              <option v-for="size in pageSizeOptions" :key="size" :value="size">{{ size }}</option>
            </select>
          </label>
        </div>
      </div>

      <div class="mt-4">
        <div v-if="tagDataError" class="rounded border border-red-200 dark:border-red-700 bg-red-50 dark:bg-red-900/20 px-4 py-3 text-sm text-red-700 dark:text-red-300">
          加载标签列表失败：{{ tagDataError }}
        </div>
        <div v-else-if="tagDataLoading" class="space-y-3">
          <div v-for="i in 4" :key="i" class="h-12 rounded bg-neutral-100 dark:bg-neutral-800 animate-pulse" />
        </div>
        <div v-else-if="paginatedTags.length === 0" class="text-sm text-neutral-500 dark:text-neutral-400">
          暂无标签数据。
        </div>
        <div v-else class="overflow-x-auto">
          <table class="min-w-full text-sm text-left text-neutral-700 dark:text-neutral-200">
            <thead class="text-xs uppercase tracking-wide text-neutral-500 dark:text-neutral-400 border-b border-neutral-200 dark:border-neutral-700">
              <tr>
                <th class="py-3 pr-3">标签</th>
                <th class="py-3 pr-3 w-32 text-right">文章数量</th>
                <th class="py-3 pr-3 w-40 text-right">最近新增</th>
                <th class="py-3 pr-3 w-40 text-right">最早新增</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="tag in paginatedTags"
                :key="tag.tag"
                @click="goToTag(tag.tag)"
                class="border-b border-neutral-200 dark:border-neutral-700 hover:bg-neutral-50 dark:hover:bg-neutral-800 transition cursor-pointer"
              >
                <td class="py-2 pr-3">
                  <span class="font-medium text-neutral-900 dark:text-neutral-100">{{ tag.tag }}</span>
                </td>
                <td class="py-2 pr-3 text-right font-semibold">{{ tag.pageCount }}</td>
                <td class="py-2 pr-3 text-right text-xs sm:text-sm text-neutral-500 dark:text-neutral-400">
                  {{ formatActivity(tag.latestActivity) }}
                </td>
                <td class="py-2 pr-3 text-right text-xs sm:text-sm text-neutral-500 dark:text-neutral-400">
                  {{ formatActivity(tag.oldestActivity) }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div v-if="paginatedTags.length > 0" class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mt-4 text-sm text-neutral-600 dark:text-neutral-300">
          <div>
            第 {{ pageRange.start }} - {{ pageRange.end }} 条，共 {{ totalTags }} 个标签
          </div>
          <div class="flex items-center gap-2">
            <button
              type="button"
              class="px-3 py-1.5 rounded border border-neutral-200 dark:border-neutral-700 hover:border-neutral-300 dark:hover:border-neutral-600 disabled:opacity-50 disabled:cursor-not-allowed"
              :disabled="!hasPrevPage"
              @click="prevPage"
            >上一页</button>
            <span class="text-xs sm:text-sm text-neutral-500 dark:text-neutral-400">
              第 {{ tablePage }} / {{ maxPage }} 页
            </span>
            <button
              type="button"
              class="px-3 py-1.5 rounded border border-neutral-200 dark:border-neutral-700 hover:border-neutral-300 dark:hover:border-neutral-600 disabled:opacity-50 disabled:cursor-not-allowed"
              :disabled="!hasNextPage"
              @click="nextPage"
            >下一页</button>
          </div>
        </div>
      </div>
    </section>

    <!-- 选中标签置顶 -->
    <div v-if="selectedTag" class="mb-6">
      <TagBoard
        :tag="selectedTag"
        :limit="limit"
        :offset-lovers="offsetLovers[selectedTag] || 0"
        :offset-haters="offsetHaters[selectedTag] || 0"
        @update:offset-lovers="v => setOffset(selectedTag, 'lovers', v)"
        @update:offset-haters="v => setOffset(selectedTag, 'haters', v)"
      />
    </div>

    <!-- 默认六个标签：桌面两列三行，移动单列；每列一个TagBoard，内部双列(lovers/haters) -->
    <div class="grid grid-cols-1 lg:grid-cols-2 gap-4 sm:gap-6">
      <TagBoard
        v-for="t in defaultTags"
        :key="t"
        :tag="t"
        :limit="limit"
        :offset-lovers="offsetLovers[t] || 0"
        :offset-haters="offsetHaters[t] || 0"
        @update:offset-lovers="v => setOffset(t, 'lovers', v)"
        @update:offset-haters="v => setOffset(t, 'haters', v)"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, computed, watch } from 'vue'
import TagBoard from '~/components/TagBoard.vue'
import { useNuxtApp } from 'nuxt/app'
import { useRouter } from 'vue-router'
import { Bar } from 'vue-chartjs'
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  BarElement,
  Title,
  Tooltip,
  Legend
} from 'chart.js'

ChartJS.register(CategoryScale, LinearScale, BarElement, Title, Tooltip, Legend)

type BffFetcher = <T=any>(url: string, options?: any) => Promise<T>
const { $bff } = useNuxtApp()
const bff = $bff as BffFetcher
const router = useRouter()

const defaultTags = ['原创', 'scp', '故事', 'goi格式', 'wanderers', '艺术作品']

const search = ref('')
const suggestions = ref<string[]>([])
const suggestionsOpen = ref(false)
const selectedTag = ref<string | null>(null)
const limit = ref<number>(10)

// pagination state per tag & polarity
const offsetLovers = ref<Record<string, number>>({})
const offsetHaters = ref<Record<string, number>>({})

function setOffset(tag: string, kind: 'lovers'|'haters', v: number) {
  if (kind === 'lovers') offsetLovers.value = { ...offsetLovers.value, [tag]: Math.max(0, v|0) }
  else offsetHaters.value = { ...offsetHaters.value, [tag]: Math.max(0, v|0) }
}

let searchTimer: any
function onSearchInput() {
  suggestionsOpen.value = true
  clearTimeout(searchTimer)
  const q = search.value.trim()
  if (!q) { suggestions.value = []; return }
  searchTimer = setTimeout(async () => {
    const data = await bff<{ results: Array<{ tag: string }> }>('/search/tags', { params: { query: q, limit: 12 } })
    const results = data?.results || []
    suggestions.value = Array.isArray(results) ? results.map(r => r.tag).filter(Boolean) : []
  }, 250)
}

function selectTag(t: string) {
  selectedTag.value = t
  suggestionsOpen.value = false
  suggestions.value = []
  search.value = ''
}

function onSearchFocus() {
  if (search.value.trim() && suggestions.value.length > 0) {
    suggestionsOpen.value = true
  }
}

function onSearchBlur() {
  // Delay to allow click on suggestions
  setTimeout(() => {
    suggestionsOpen.value = false
  }, 150)
}

function refreshAll() {
  // noop here; each TagBoard fetches by itself based on props
}

interface TagStat {
  tag: string
  pageCount: number
  latestActivity?: string | null
  oldestActivity?: string | null
}

const tagDataLoading = ref(true)
const tagDataError = ref<string | null>(null)
const rawTagStats = ref<TagStat[]>([])

async function loadTagData() {
  tagDataLoading.value = true
  tagDataError.value = null
  try {
    const resp = await bff<{ tags: TagStat[] }>('/tags', { params: { sort: 'count', order: 'desc', limit: 10000 } })
    rawTagStats.value = Array.isArray(resp?.tags) ? resp.tags : []
  } catch (err: any) {
    tagDataError.value = err?.message || '未知错误'
    rawTagStats.value = []
  } finally {
    tagDataLoading.value = false
  }
}

function reloadTagData() {
  void loadTagData()
}

const totalTags = computed(() => rawTagStats.value.length)

const histogramBins = computed(() => {
  const counts = rawTagStats.value.map(t => t.pageCount).filter(c => Number.isFinite(c) && c >= 0)
  if (counts.length === 0) return []
  const binTotal = 100
  const min = Math.min(...counts)
  const max = Math.max(...counts)
  const isProd = process.env.NODE_ENV === 'production'
  const isClient = typeof window !== 'undefined'
  if (isClient) {
    if (isProd) {
      console.log('[TagAnalytics] Histogram source stats', { min, max, totalTags: counts.length })
    } else {
      console.debug('[TagAnalytics] Histogram source stats', { min, max, totalTags: counts.length })
    }
  }
  if (min === max) {
    const singleRange = { start: Math.floor(min), end: Math.ceil(max) || Math.floor(min) + 1 }
    return [{ ...singleRange, count: counts.length }]
  }

  const span = max - min
  const exponent = span > 5000 ? 3 : span > 1000 ? 2.5 : span > 200 ? 1.8 : 1.2
  const edges = Array.from({ length: binTotal + 1 }, (_, idx) => min + Math.pow(idx / binTotal, exponent) * span)
  edges[0] = min
  edges[binTotal] = max + 1
  for (let i = 1; i < edges.length; i += 1) {
    if (edges[i] <= edges[i - 1]) {
      edges[i] = edges[i - 1] + 1
    }
  }

  const bins = Array.from({ length: binTotal }, (_, idx) => {
    const start = Math.floor(edges[idx])
    const rawEnd = Math.floor(edges[idx + 1])
    const end = rawEnd <= start ? start + 1 : rawEnd
    return { start, end, count: 0 }
  })

  const sortedCounts = [...counts].sort((a, b) => a - b)
  let binIndex = 0
  for (const value of sortedCounts) {
    while (binIndex < bins.length - 1 && value >= bins[binIndex].end) {
      binIndex += 1
    }
    bins[binIndex].count += 1
  }

  const peak = Math.max(...bins.map(b => b.count), 1)
  if (isClient) {
    const sampleIndices = [0, Math.floor(binTotal * 0.1), Math.floor(binTotal * 0.5), Math.floor(binTotal * 0.9), binTotal - 1]
      .filter((v, idx, arr) => v >= 0 && v < bins.length && arr.indexOf(v) === idx)
    const samples = sampleIndices.map(idx => ({ idx, range: `${bins[idx].start}-${bins[idx].end - 1}`, count: bins[idx].count }))
    const payload = { peak, samples }
    if (isProd) {
      console.log('[TagAnalytics] Histogram debug samples', payload)
    } else {
      console.debug('[TagAnalytics] Histogram debug samples', payload)
    }
  }
  return bins.map((bin, idx) => {
    return {
      start: bin.start,
      end: bin.end - 1,
      count: bin.count
    }
  })
})

const histogramChartData = computed(() => {
  const bins = histogramBins.value
  return {
    labels: bins.map(bin => `${bin.start}-${bin.end}`),
    datasets: [
      {
        label: '标签数量',
        data: bins.map(bin => bin.count),
        backgroundColor: 'rgba(59, 130, 246, 0.75)',
        borderColor: 'rgba(37, 99, 235, 1)',
        borderWidth: 1,
        hoverBackgroundColor: 'rgba(29, 78, 216, 0.85)'
      }
    ]
  }
})

const histogramChartOptions = computed(() => {
  const bins = histogramBins.value
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 250 },
    scales: {
      x: {
        grid: { display: false },
        ticks: {
          autoSkip: false,
          maxRotation: 0,
          callback: (value: any, index: number) => {
            const bin = bins[index]
            if (!bin) return ''
            return index % 10 === 0 ? `${bin.start}-${bin.end}` : ''
          }
        }
      },
      y: {
        beginAtZero: true,
        ticks: {
          precision: 0,
          stepSize: Math.max(Math.round((Math.max(...bins.map(b => b.count), 1)) / 8), 1)
        },
        grid: {
          color: 'rgba(148, 163, 184, 0.2)'
        }
      }
    },
    plugins: {
      legend: { display: false },
      tooltip: {
        callbacks: {
          title: (items: any[]) => {
            const item = items[0]
            const bin = bins[item.dataIndex]
            return bin ? `${bin.start} - ${bin.end} 篇` : ''
          },
          label: (item: any) => `标签数：${item.raw}`
        }
      }
    }
  }
})

const histogramSummary = computed(() => {
  const counts = rawTagStats.value.map(t => t.pageCount).filter(c => Number.isFinite(c))
  if (counts.length === 0) {
    return { min: 0, max: 0, median: 0 }
  }
  const sorted = [...counts].sort((a, b) => a - b)
  const min = sorted[0]
  const max = sorted[sorted.length - 1]
  const mid = Math.floor(sorted.length / 2)
  const median = sorted.length % 2 === 0 ? Math.round((sorted[mid - 1] + sorted[mid]) / 2) : sorted[mid]
  return { min, max, median }
})

type SortKey = 'count' | 'alpha' | 'activity'
const sortOptions: Array<{ key: SortKey; label: string }> = [
  { key: 'count', label: '按文章数' },
  { key: 'alpha', label: '按标签名' },
  { key: 'activity', label: '按最近新增' }
]

const tableSort = ref<SortKey>('count')
const tableOrder = ref<'asc' | 'desc'>('desc')
const pageSizeOptions = [20, 40, 80]
const pageSize = ref<number>(20)
const tablePage = ref<number>(1)

const sortedTags = computed(() => {
  const items = [...rawTagStats.value]
  const orderFactor = tableOrder.value === 'desc' ? -1 : 1
  items.sort((a, b) => {
    if (tableSort.value === 'count') {
      return (a.pageCount - b.pageCount) * orderFactor
    }
    if (tableSort.value === 'alpha') {
      return a.tag.localeCompare(b.tag, 'zh-Hans-CN', { sensitivity: 'base' }) * orderFactor
    }
    const timeA = a.latestActivity ? Date.parse(a.latestActivity) : 0
    const timeB = b.latestActivity ? Date.parse(b.latestActivity) : 0
    return (timeA - timeB) * orderFactor
  })
  return items
})

const maxPage = computed(() => {
  if (sortedTags.value.length === 0) return 1
  return Math.max(1, Math.ceil(sortedTags.value.length / pageSize.value))
})

const paginatedTags = computed(() => {
  if (sortedTags.value.length === 0) return []
  const start = (tablePage.value - 1) * pageSize.value
  return sortedTags.value.slice(start, start + pageSize.value)
})

const pageRange = computed(() => {
  if (paginatedTags.value.length === 0) return { start: 0, end: 0 }
  const startIdx = (tablePage.value - 1) * pageSize.value + 1
  const endIdx = startIdx + paginatedTags.value.length - 1
  return { start: startIdx, end: endIdx }
})

const hasPrevPage = computed(() => tablePage.value > 1)
const hasNextPage = computed(() => tablePage.value < maxPage.value)

function changeSort(key: SortKey) {
  if (tableSort.value === key) {
    tableOrder.value = tableOrder.value === 'asc' ? 'desc' : 'asc'
  } else {
    tableSort.value = key
    tableOrder.value = key === 'alpha' ? 'asc' : 'desc'
  }
}

function prevPage() {
  if (tablePage.value > 1) tablePage.value -= 1
}

function nextPage() {
  if (tablePage.value < maxPage.value) tablePage.value += 1
}

function goToTag(tag: string) {
  router.push({ path: '/search', query: { tags: [tag] } })
}

function formatActivity(value?: string | null) {
  if (!value) return '—'
  try {
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) return '—'
    return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'Asia/Shanghai' })
  } catch (err) {
    return '—'
  }
}

watch([tableSort, tableOrder, pageSize], () => {
  tablePage.value = 1
})

watch(() => [sortedTags.value.length, pageSize.value], () => {
  tablePage.value = Math.min(tablePage.value, maxPage.value)
})

onMounted(() => {
  void loadTagData()
})

watch(() => histogramBins.value, (bins) => {
  const isClient = typeof window !== 'undefined'
  const isProd = process.env.NODE_ENV === 'production'
  if (!isClient) return
  if (!bins || bins.length === 0) {
    console.log('[TagAnalytics] Histogram bins empty')
    return
  }
  const maxBin = bins.reduce((prev, curr) => (curr.count > prev.count ? curr : prev), bins[0])
  const nonZero = bins.filter(bin => bin.count > 0)
  const smallest = nonZero.length > 0 ? nonZero.reduce((prev, curr) => (curr.count < prev.count ? curr : prev), nonZero[0]) : null
  const payload = {
    firstBin: bins[0],
    midBin: bins[Math.floor(bins.length / 2)],
    lastBin: bins[bins.length - 1],
    maxBin,
    smallestNonZero: smallest,
    samples: bins
      .filter((_bin, index) => index % 10 === 0)
      .slice(0, 6)
      .map(bin => ({ range: `${bin.start}-${bin.end}`, count: bin.count })),
    totalNonZero: nonZero.length
  }
  if (isProd) {
    console.log('[TagAnalytics] Histogram checkpoint', payload)
  } else {
    console.debug('[TagAnalytics] Histogram checkpoint', payload)
  }
}, { deep: true, immediate: true })
</script>

<style scoped>
.container { max-width: 1200px; }
</style>
