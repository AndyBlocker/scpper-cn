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
          查看 {{ decodedTag }} 标签下的热门作品与近期动态。
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

    <section class="grid grid-cols-1 gap-4 sm:grid-cols-3">
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

  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useNuxtApp, useHead, useState } from 'nuxt/app'
import PageCard from '~/components/PageCard.vue'
import { orderTags } from '~/composables/useTagOrder'
import { useViewerVotes } from '~/composables/useViewerVotes'
import { formatDateIsoUtc8, diffUtc8CalendarDays, nowUtc8, toUtc8Date } from '~/utils/timezone'

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

const tagCatalog = useState<any[]>('tag-catalog', () => [])

let requestToken = 0

useHead(() => {
  const tag = decodedTag.value
  const title = tag ? `#${tag} 标签详情 - SCPPER-CN` : '标签详情 - SCPPER-CN'
  const description = tag
    ? `浏览 #${tag} 标签下的热门页面和最新动态。`
    : '浏览标签的热门页面。'
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

async function reload() {
  const tag = decodedTag.value
  if (!tag) return
  const token = ++requestToken
  pendingPrimary.value = true
  error.value = null
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

const recentWindow = computed(() => {
  // 从 recentPages 计算近30日新增
  const now = nowUtc8()
  const thirtyDaysAgo = new Date(now)
  thirtyDaysAgo.setDate(now.getDate() - 30)
  const sixtyDaysAgo = new Date(now)
  sixtyDaysAgo.setDate(now.getDate() - 60)

  let current = 0
  let previous = 0

  // 合并所有页面来计算
  const allPages = [...topPages.value, ...recentPages.value]
  const seen = new Set<number>()

  for (const page of allPages) {
    if (!page.wikidotId || seen.has(page.wikidotId)) continue
    seen.add(page.wikidotId)
    const dateStr = page.createdDate
    if (!dateStr) continue
    const date = toUtc8Date(dateStr)
    if (!date || Number.isNaN(date.getTime())) continue
    if (date >= thirtyDaysAgo) {
      current++
    } else if (date >= sixtyDaysAgo) {
      previous++
    }
  }

  return { current, previous, delta: current - previous }
})

function formatDate(input: string | null | undefined) {
  if (!input) return '未知'
  const iso = formatDateIsoUtc8(input)
  return iso || '未知'
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
