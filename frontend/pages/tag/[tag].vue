<template>
  <div class="space-y-8 py-6">
    <div class="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
      <div class="space-y-1">
        <div class="inline-flex items-center gap-2 text-[11px] uppercase tracking-widest text-[rgb(var(--accent))]">
          <span class="h-1 w-1 rounded-full bg-[rgb(var(--accent))]" />
          <span>标签详情</span>
        </div>
        <h1 class="text-2xl font-bold text-neutral-900 dark:text-neutral-100 break-all">
          #{{ decodedTag }}
        </h1>
        <p class="text-sm text-neutral-500 dark:text-neutral-400 max-w-2xl">
          聚合近期表现、受众倾向与活跃走势，帮助快速判断 {{ decodedTag }} 标签的热度与贡献者生态。
        </p>
      </div>
      <div class="flex flex-wrap items-center gap-3">
        <button
          type="button"
          class="inline-flex items-center gap-2 rounded-full border border-neutral-200/80 bg-white/80 px-4 py-2 text-sm font-medium text-neutral-600 shadow-sm transition hover:border-[rgba(var(--accent),0.4)] hover:text-[rgb(var(--accent))] dark:border-neutral-700/70 dark:bg-neutral-900/70 dark:text-neutral-200"
          @click="navigateToSearch"
        >
          <LucideIcon name="Search" class="h-4 w-4" />
          在搜索中查看
        </button>
        <button
          type="button"
          class="inline-flex items-center gap-2 rounded-full border border-neutral-200/80 bg-white/80 px-4 py-2 text-sm font-medium text-neutral-600 shadow-sm transition hover:border-[rgba(var(--accent),0.4)] hover:text-[rgb(var(--accent))] dark:border-neutral-700/70 dark:bg-neutral-900/70 dark:text-neutral-200"
          @click="reload"
        >
          <LucideIcon name="RefreshCcw" class="h-4 w-4" />
          刷新数据
        </button>
      </div>
    </div>

    <section class="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <div class="summary-card">
        <div class="summary-label">相关页面</div>
        <div class="summary-value">{{ totalPagesText }}</div>
        <div class="summary-foot" v-if="tagMeta">
          最新新增 {{ formatRelative(tagMeta.latestActivity) }}
        </div>
      </div>
      <div class="summary-card">
        <div class="summary-label">近30日新增</div>
        <div class="summary-value">
          <span>{{ recentWindow.current }}</span>
          <span
            v-if="recentWindow.delta !== 0"
            :class="recentWindow.delta > 0 ? 'text-emerald-500 dark:text-emerald-400' : 'text-rose-500 dark:text-rose-400'"
            class="ml-2 text-sm font-medium"
          >
            {{ recentWindow.delta > 0 ? '+' : '' }}{{ recentWindow.delta }}
          </span>
        </div>
        <div class="summary-foot">
          对比前30日 {{ recentWindow.previous }}
        </div>
      </div>
      <div class="summary-card">
        <div class="summary-label">平均 Rating</div>
        <div class="summary-value">{{ summaryAverages.avgRating }}</div>
        <div class="summary-foot">样本：{{ summaryAverages.sampleSize }} 篇</div>
      </div>
      <div class="summary-card">
        <div class="summary-label">贡献作者</div>
        <div class="summary-value">{{ topAuthorsShort }}</div>
        <div class="summary-foot">榜头：{{ topAuthorName }}</div>
      </div>
    </section>

    <section class="rounded-3xl border border-white/60 bg-white/80 p-6 shadow-[0_24px_60px_rgba(15,23,42,0.12)] backdrop-blur-lg dark:border-white/10 dark:bg-neutral-950/60 dark:shadow-[0_32px_70px_rgba(0,0,0,0.55)]">
      <header class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-6">
        <div>
          <h2 class="text-lg font-semibold text-neutral-900 dark:text-neutral-100">Top 页面</h2>
          <p class="text-sm text-neutral-500 dark:text-neutral-400">按 Rating 排名前 {{ topPages.length }} 的代表作品。</p>
        </div>
        <div class="flex items-center gap-2">
          <label class="text-xs text-neutral-500 dark:text-neutral-400">展示数量</label>
          <select v-model.number="pageLimit" class="rounded border border-neutral-200 bg-white px-3 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200">
            <option :value="6">6</option>
            <option :value="9">9</option>
            <option :value="12">12</option>
          </select>
        </div>
      </header>
      <div v-if="pendingPrimary" class="grid place-items-center py-16">
        <div class="text-sm text-neutral-500 dark:text-neutral-400">加载中…</div>
      </div>
      <div v-else-if="error" class="rounded border border-red-200 bg-red-50 px-4 py-6 text-sm text-red-600 dark:border-red-800 dark:bg-red-900/20 dark:text-red-300">
        加载失败：{{ error }}
      </div>
      <div v-else-if="topPages.length === 0" class="text-sm text-neutral-500 dark:text-neutral-400">
        暂无符合条件的页面。
      </div>
      <div v-else class="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        <PageCard
          v-for="page in topPages.slice(0, pageLimit)"
          :key="page.wikidotId || page.title"
          size="md"
          :p="page"
        />
      </div>
    </section>

    <section class="rounded-3xl border border-white/60 bg-white/80 p-6 shadow-[0_24px_60px_rgba(15,23,42,0.12)] backdrop-blur-lg dark:border-white/10 dark:bg-neutral-950/60 dark:shadow-[0_32px_70px_rgba(0,0,0,0.55)]">
      <header class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-6">
        <div>
          <h2 class="text-lg font-semibold text-neutral-900 dark:text-neutral-100">活跃窗口</h2>
          <p class="text-sm text-neutral-500 dark:text-neutral-400">最近上线的页面，感知创作节奏。</p>
        </div>
        <div class="text-xs text-neutral-500 dark:text-neutral-400">
          上次更新：{{ summaryAverages.lastUpdated }}
        </div>
      </header>
      <div v-if="recentPages.length === 0" class="text-sm text-neutral-500 dark:text-neutral-400">
        暂无最新页面。
      </div>
      <div v-else class="grid grid-cols-1 gap-4 md:grid-cols-2">
        <article
          v-for="page in recentPages.slice(0, 8)"
          :key="`recent-${page.wikidotId || page.title}`"
          class="rounded-2xl border border-neutral-200/70 bg-white/85 p-4 transition hover:-translate-y-0.5 hover:border-[rgba(var(--accent),0.4)] dark:border-neutral-800/70 dark:bg-neutral-900/80"
        >
          <div class="flex items-start justify-between gap-3">
            <NuxtLink :to="`/page/${page.wikidotId}`" class="font-medium text-neutral-900 hover:text-[rgb(var(--accent))] dark:text-neutral-100">
              {{ page.title || 'Untitled' }}
            </NuxtLink>
            <span class="rounded-full bg-[rgba(var(--accent),0.16)] px-2 py-0.5 text-[11px] font-semibold text-[rgb(var(--accent))]">
              Rating {{ Number(page.rating ?? 0) }}
            </span>
          </div>
          <div class="mt-2 flex flex-wrap gap-2 text-xs text-neutral-500 dark:text-neutral-400">
            <span>发布于 {{ formatDate(page.createdDate) }}</span>
            <span v-if="page.tags?.length">标签：{{ page.tags.map(t => `#${t}`).join('、') }}</span>
          </div>
        </article>
      </div>
    </section>

    <section class="rounded-3xl border border-white/60 bg-white/80 p-6 shadow-[0_24px_60px_rgba(15,23,42,0.12)] backdrop-blur-lg dark:border-white/10 dark:bg-neutral-950/60 dark:shadow-[0_32px_70px_rgba(0,0,0,0.55)]">
      <header class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-6">
        <div>
          <h2 class="text-lg font-semibold text-neutral-900 dark:text-neutral-100">Top 作者</h2>
          <p class="text-sm text-neutral-500 dark:text-neutral-400">按总 Rating 与作品数排序的作者榜。</p>
        </div>
        <div class="flex items-center gap-2 text-xs text-neutral-500 dark:text-neutral-400">
          <span>统计样本：{{ authorStats.length }}</span>
        </div>
      </header>
      <div v-if="authorStats.length === 0" class="text-sm text-neutral-500 dark:text-neutral-400">
        暂无可用数据。
      </div>
      <div v-else class="overflow-x-auto">
        <table class="min-w-full divide-y divide-neutral-200 dark:divide-neutral-800 text-sm">
          <thead class="bg-neutral-50/80 dark:bg-neutral-900/60 text-xs text-neutral-500 dark:text-neutral-400 uppercase tracking-wide">
            <tr>
              <th class="px-3 py-2 text-left">作者</th>
              <th class="px-3 py-2 text-left">作品数</th>
              <th class="px-3 py-2 text-left">总 Rating</th>
              <th class="px-3 py-2 text-left">均值</th>
              <th class="px-3 py-2 text-left">代表作</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-neutral-200/80 dark:divide-neutral-800/60">
            <tr v-for="(author, idx) in authorStats.slice(0, 12)" :key="author.name" class="hover:bg-neutral-50/80 dark:hover:bg-neutral-900/60">
              <td class="px-3 py-2 font-medium text-neutral-800 dark:text-neutral-100">
                <span class="inline-flex items-center gap-2">
                  <span class="text-xs text-neutral-400 dark:text-neutral-500 w-5">#{{ idx + 1 }}</span>
                  <span>{{ author.name }}</span>
                </span>
              </td>
              <td class="px-3 py-2 text-neutral-600 dark:text-neutral-300">{{ author.pageCount }}</td>
              <td class="px-3 py-2 text-neutral-600 dark:text-neutral-300">{{ author.totalRating }}</td>
              <td class="px-3 py-2 text-neutral-600 dark:text-neutral-300">{{ author.avgRating }}</td>
              <td class="px-3 py-2">
                <NuxtLink
                  v-if="author.topPageId"
                  :to="`/page/${author.topPageId}`"
                  class="text-[rgb(var(--accent))] hover:underline"
                >
                  {{ author.topPageTitle }}
                </NuxtLink>
                <span v-else class="text-neutral-500 dark:text-neutral-400">—</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <section class="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
      <div class="rounded-3xl border border-white/60 bg-white/80 p-6 shadow-[0_24px_60px_rgba(15,23,42,0.12)] backdrop-blur-lg dark:border-white/10 dark:bg-neutral-950/60 dark:shadow-[0_32px_70px_rgba(0,0,0,0.55)]">
        <header class="mb-6 flex items-center justify-between gap-3">
          <div>
            <h2 class="text-lg font-semibold text-neutral-900 dark:text-neutral-100">时间序列</h2>
            <p class="text-sm text-neutral-500 dark:text-neutral-400">近半年 {{ decodedTag }} 标签的新增页面走势。</p>
          </div>
          <select v-model="period" class="rounded border border-neutral-200 bg-white px-3 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200">
            <option value="day">按日</option>
            <option value="week">按周</option>
            <option value="month">按月</option>
          </select>
        </header>
        <ClientOnly>
          <TimeSeriesLineChart
            :key="`tag-series-${decodedTag}-${period}`"
            :labels="seriesLabels"
            :datasets="seriesDatasets"
            y-title="新增页面数"
          />
          <template #fallback>
            <div class="flex h-60 items-center justify-center text-sm text-neutral-500 dark:text-neutral-400">加载图表中…</div>
          </template>
        </ClientOnly>
      </div>
      <div class="rounded-3xl border border-white/60 bg-white/80 p-6 shadow-[0_24px_60px_rgba(15,23,42,0.12)] backdrop-blur-lg dark:border-white/10 dark:bg-neutral-950/60 dark:shadow-[0_32px_70px_rgba(0,0,0,0.55)]">
        <header class="mb-4">
          <h2 class="text-lg font-semibold text-neutral-900 dark:text-neutral-100">Lovers / Haters 榜</h2>
          <p class="text-sm text-neutral-500 dark:text-neutral-400">基于用户投票倾向，挑选最爱与最刺痛该标签的用户。</p>
        </header>
        <TagBoard
          :tag="decodedTag"
          :limit="boardLimit"
          :offset-lovers="offsetLovers"
          :offset-haters="offsetHaters"
          @update:offset-lovers="offsetLovers = $event"
          @update:offset-haters="offsetHaters = $event"
        />
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useNuxtApp, useHead, useState } from 'nuxt/app'
import PageCard from '~/components/PageCard.vue'
import TagBoard from '~/components/TagBoard.vue'
import TimeSeriesLineChart from '~/components/TimeSeriesLineChart.vue'
import { orderTags } from '~/composables/useTagOrder'
import { useViewerVotes } from '~/composables/useViewerVotes'
import { formatDateIsoUtc8, formatDateUtc8, diffUtc8CalendarDays, startOfUtc8Day, nowUtc8, toUtc8Date } from '~/utils/timezone'

type BffFetcher = <T = any>(url: string, options?: Record<string, any>) => Promise<T>

const route = useRoute()
const router = useRouter()
const { $bff } = useNuxtApp()
const bff = $bff as BffFetcher
const { hydratePages: hydrateViewerVotes } = useViewerVotes()

const decodedTag = computed(() => {
  const raw = route.params.tag
  if (Array.isArray(raw)) return raw[0] ? decodeURIComponent(String(raw[0])) : ''
  return raw ? decodeURIComponent(String(raw)) : ''
})

const pendingPrimary = ref(false)
const error = ref<string | null>(null)
const topPages = ref<any[]>([])
const recentPages = ref<any[]>([])
const totalPages = ref<number | null>(null)
const tagMeta = ref<{ tag: string; pageCount: number; latestActivity: string | null; oldestActivity: string | null } | null>(null)
const pageLimit = ref(9)
const period = ref<'day' | 'week' | 'month'>('week')
const timeSeries = ref<Array<{ date: string; newCount: number; cumulativeCount: number }>>([])

const tagCatalog = useState<any[]>('tag-catalog', () => [])

const boardLimit = 10
const offsetLovers = ref(0)
const offsetHaters = ref(0)

let requestToken = 0

useHead(() => {
  const tag = decodedTag.value
  const title = tag ? `#${tag} 标签详情 - SCPPER-CN` : '标签详情 - SCPPER-CN'
  const description = tag
    ? `浏览 #${tag} 标签下的热门页面、贡献作者、投票倾向和时间序列表现，掌握创作动向与受众偏好。`
    : '浏览标签的热门页面、贡献作者、投票倾向和时间序列表现。'
  return {
    title,
    meta: [
      { name: 'description', content: description }
    ]
  }
})

watch(
  () => decodedTag.value,
  () => {
    reload()
  },
  { immediate: true }
)

watch(
  () => period.value,
  (next) => {
    const tag = decodedTag.value
    if (!tag) return
    void refreshSeries(tag, requestToken)
  }
)

async function reload() {
  const tag = decodedTag.value
  if (!tag) return
  const token = ++requestToken
  pendingPrimary.value = true
  error.value = null
  offsetLovers.value = 0
  offsetHaters.value = 0
  try {
    const [topResp, recentResp] = await Promise.all([
      bff<{ results: any[]; total?: number }>('/search/pages', {
        params: {
          tags: tag,
          limit: 24,
          orderBy: 'rating',
          includeTotal: 'true',
          includeSnippet: 'false',
          includeDate: 'true'
        }
      }),
      bff<{ results: any[] }>('/search/pages', {
        params: {
          tags: tag,
          limit: 12,
          orderBy: 'recent',
          includeSnippet: 'false',
          includeDate: 'true'
        }
      })
    ])

    if (token !== requestToken) return

    topPages.value = normalizePages(topResp.results || [])
    recentPages.value = normalizePages(recentResp.results || [])
    await hydrateViewerVotes([...topPages.value, ...recentPages.value])
    totalPages.value = typeof topResp.total === 'number' ? topResp.total : null

    await ensureTagMeta(tag, token)
    await refreshSeries(tag, token)
  } catch (e: any) {
    if (token !== requestToken) return
    console.error('[tag-detail] load failed', e)
    error.value = e?.message || '加载失败'
  } finally {
    if (token === requestToken) {
      pendingPrimary.value = false
    }
  }
}

async function ensureTagMeta(tag: string, token: number) {
  if (tagCatalog.value.length === 0) {
    try {
      const resp = await bff<{ tags: any[] }>('/tags', { params: { sort: 'alpha' } })
      if (token !== requestToken) return
      tagCatalog.value = resp.tags || []
    } catch (err) {
      console.warn('[tag-detail] failed to fetch catalog', err)
    }
  }
  const found = tagCatalog.value.find((t: any) => t.tag === tag) ?? null
  tagMeta.value = found
}

async function refreshSeries(tag: string, token: number) {
  const { start, end } = computeRange(period.value)
  try {
    const rows = await bff<Array<{ date: string; newCount: number; cumulativeCount: number }>>('/analytics/pages/tag-series', {
      params: {
        tags: tag,
        startDate: start,
        endDate: end,
        period: period.value,
        match: 'all'
      }
    })
    if (token !== requestToken) return
    timeSeries.value = rows || []
  } catch (err) {
    if (token !== requestToken) return
    console.warn('[tag-detail] failed to fetch series', err)
    timeSeries.value = []
  }
}

function computeRange(p: 'day' | 'week' | 'month') {
  const now = nowUtc8()
  const end = formatDateIsoUtc8(now)
  const baseDate = toUtc8Date(now) ?? now
  const base = new Date(baseDate)
  const days = p === 'day' ? 30 : (p === 'week' ? 180 : 365)
  base.setDate(base.getDate() - days)
  const start = formatDateIsoUtc8(base)
  return { start, end }
}

function normalizePages(items: any[]) {
  return items.map((p) => {
    const created = toISODate(p.firstRevisionAt || p.createdAt || p.validFrom)
    const tags = orderTags(Array.isArray(p.tags) ? p.tags : Array.isArray(p.e_tags) ? p.e_tags : [])
    return {
      wikidotId: p.wikidotId,
      title: p.title,
      alternateTitle: p.alternateTitle,
      authors: p.authors,
      tags,
      rating: p.rating,
      wilson95: p.wilson95,
      commentCount: p.commentCount ?? p.revisionCount,
      controversy: p.controversy,
      snippetHtml: p.snippet || null,
      isDeleted: Boolean(p.isDeleted),
      deletedAt: p.deletedAt || null,
      createdDate: created
    }
  })
}

function toISODate(value: any) {
  if (!value) return null
  const formatted = formatDateIsoUtc8(value)
  return formatted || null
}

const totalPagesText = computed(() => {
  if (typeof totalPages.value === 'number') {
    return totalPages.value.toLocaleString()
  }
  if (tagMeta.value?.pageCount) {
    return tagMeta.value.pageCount.toLocaleString()
  }
  return '—'
})

const summaryAverages = computed(() => {
  const pages = topPages.value
  if (!pages.length) {
    return {
      avgRating: '—',
      sampleSize: 0,
      lastUpdated: '暂无数据'
    }
  }
  const sum = pages.reduce((acc, p) => acc + Number(p.rating ?? 0), 0)
  const avg = sum / pages.length
  const last = pages.reduce((latest, p) => {
    const d = p.createdDate ? toUtc8Date(p.createdDate) : null
    if (!d) return latest
    if (!latest) return d
    return d.getTime() > latest.getTime() ? d : latest
  }, null as Date | null)
  return {
    avgRating: avg.toFixed(1),
    sampleSize: pages.length,
    lastUpdated: last ? formatRelative(last) : '暂无数据'
  }
})

const authorStats = computed(() => {
  const map = new Map<string, { pageCount: number; totalRating: number; ratings: number[]; topPageId: number | null; topPageRating: number; topPageTitle: string }>()
  for (const page of topPages.value) {
    const authors = extractAuthors(page.authors)
    for (const name of authors) {
      if (!map.has(name)) {
        map.set(name, { pageCount: 0, totalRating: 0, ratings: [], topPageId: null, topPageRating: -Infinity, topPageTitle: '' })
      }
      const entry = map.get(name)!
      entry.pageCount += 1
      const rating = Number(page.rating ?? 0)
      if (Number.isFinite(rating)) {
        entry.totalRating += rating
        entry.ratings.push(rating)
        if (rating > entry.topPageRating) {
          entry.topPageRating = rating
          entry.topPageId = Number(page.wikidotId) || null
          entry.topPageTitle = page.title || ''
        }
      }
    }
  }
  const arr = Array.from(map.entries()).map(([name, info]) => ({
    name,
    pageCount: info.pageCount,
    totalRating: Math.round(info.totalRating),
    avgRating: info.ratings.length ? (info.ratings.reduce((a, b) => a + b, 0) / info.ratings.length).toFixed(1) : '—',
    topPageId: info.topPageId,
    topPageTitle: info.topPageTitle
  }))
  return arr.sort((a, b) => {
    if (b.totalRating !== a.totalRating) return b.totalRating - a.totalRating
    if (b.pageCount !== a.pageCount) return b.pageCount - a.pageCount
    return a.name.localeCompare(b.name, 'zh-CN')
  })
})

const topAuthorName = computed(() => authorStats.value[0]?.name || '—')
const topAuthorsShort = computed(() => {
  if (!authorStats.value.length) return '—'
  const names = authorStats.value.slice(0, 3).map(a => a.name)
  return names.join(' / ')
})

const seriesLabels = computed(() => timeSeries.value.map(item => item.date))
const seriesDatasets = computed(() => {
  if (!timeSeries.value.length) return []
  return [
    {
      label: '新增',
      data: timeSeries.value.map(item => Number(item.newCount || 0)),
      color: 'rgb(56, 189, 248)',
      type: 'bar' as const,
      fill: true
    },
    {
      label: '累计',
      data: timeSeries.value.map(item => Number(item.cumulativeCount || 0)),
      color: 'rgb(129, 140, 248)',
      type: 'line' as const,
      fill: false,
      yAxisID: 'y1' as const
    }
  ]
})

const recentWindow = computed(() => {
  if (!timeSeries.value.length) {
    return { current: 0, previous: 0, delta: 0 }
  }
  const today = new Date()
  const currentStart = new Date(today)
  currentStart.setDate(today.getDate() - 29)
  const prevStart = new Date(currentStart)
  prevStart.setDate(prevStart.getDate() - 30)
  const prevEnd = new Date(currentStart)
  prevEnd.setDate(prevEnd.getDate() - 1)
  let current = 0
  let previous = 0
  for (const item of timeSeries.value) {
    const date = new Date(item.date)
    if (Number.isNaN(date.getTime())) continue
    if (date >= currentStart && date <= today) {
      current += Number(item.newCount || 0)
    } else if (date >= prevStart && date <= prevEnd) {
      previous += Number(item.newCount || 0)
    }
  }
  return { current, previous, delta: current - previous }
})

function extractAuthors(raw: any): string[] {
  if (!raw) return []
  if (Array.isArray(raw)) {
    return raw
      .map((item) => {
        if (typeof item === 'string') return item.trim()
        if (item && typeof item === 'object' && 'name' in item) return String((item as any).name || '').trim()
        return ''
      })
      .filter(Boolean)
  }
  if (typeof raw === 'string') {
    return raw
      .split(/[、,，/&]|和|·|\s{2,}/u)
      .map((name) => name.trim())
      .filter(Boolean)
  }
  return []
}

function formatDate(input: string | null | undefined) {
  if (!input) return '未知'
  const iso = formatDateIsoUtc8(input)
  return iso || '未知'
}

function formatDateRaw(date: Date) {
  return formatDateIsoUtc8(date)
}

function formatRelative(value: string | Date | null | undefined) {
  if (!value) return '未知'
  const date = typeof value === 'string' ? new Date(value) : value
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '未知'
  const days = diffUtc8CalendarDays(new Date(), date)
  if (days == null) return '未知'
  if (days === 0) return '今天'
  if (days < 0) return `${Math.abs(days)} 天后`
  return `${days} 天前`
}

function navigateToSearch() {
  if (!decodedTag.value) return
  router.push({ path: '/search', query: { tags: decodedTag.value } })
}
</script>

<style scoped>
.summary-card {
  @apply rounded-3xl border border-white/60 bg-white/80 p-6 shadow-[0_22px_55px_rgba(15,23,42,0.12)] backdrop-blur-lg transition hover:-translate-y-1 hover:shadow-[0_30px_70px_rgba(15,23,42,0.16)] dark:border-white/10 dark:bg-neutral-950/60 dark:shadow-[0_32px_80px_rgba(0,0,0,0.55)];
}
.summary-label {
  @apply text-xs font-medium uppercase tracking-widest text-neutral-500 dark:text-neutral-400;
}
.summary-value {
  @apply mt-2 text-2xl font-semibold text-neutral-900 dark:text-neutral-100;
}
.summary-foot {
  @apply mt-3 text-xs text-neutral-500 dark:text-neutral-500;
}
</style>
