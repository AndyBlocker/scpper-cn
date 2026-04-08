<template>
  <div class="mx-auto w-full max-w-6xl py-6">
    <!-- Header -->
    <header class="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div class="space-y-1">
        <div class="inline-flex items-center gap-2 text-[11px] uppercase tracking-widest text-[var(--g-accent)]">
          <span class="h-1 w-1 rounded-full bg-[var(--g-accent)]" />
          <span>标签健康检查</span>
        </div>
        <h1 class="text-xl font-bold text-neutral-900 dark:text-neutral-100">非指导标签审查</h1>
        <p class="text-sm text-neutral-500 dark:text-neutral-400">
          以下标签不在官方标签指导页中。大部分是合法的竞赛/角色标签，重点关注疑似拼写错误的条目。
        </p>
      </div>
      <button
        type="button"
        class="self-start inline-flex items-center gap-1.5 rounded-full border border-neutral-200/80 bg-white/80 px-4 py-2 text-sm font-medium text-neutral-600 shadow-sm transition hover:border-[rgb(var(--accent)_/_0.4)] hover:text-[var(--g-accent)] dark:border-neutral-700/70 dark:bg-neutral-900/70 dark:text-neutral-200"
        @click="reload"
      >
        <span class="inline-block w-2 h-2 rounded-full" :class="loading ? 'animate-ping bg-[var(--g-accent)]' : 'bg-neutral-400 dark:bg-neutral-500'" />
        刷新
      </button>
    </header>

    <!-- Stats Cards -->
    <div class="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
      <div class="stat-card">
        <div class="stat-value text-amber-600 dark:text-amber-400">{{ invalidTotal ?? '—' }}</div>
        <div class="stat-label">非指导标签</div>
      </div>
      <div class="stat-card">
        <div class="stat-value" :class="typoSuspects.length > 0 ? 'text-red-600 dark:text-red-400' : ''">{{ loading ? '—' : typoSuspects.length }}</div>
        <div class="stat-label">疑似拼写错误</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">{{ stats?.total ?? '—' }}</div>
        <div class="stat-label">官方定义</div>
      </div>
      <div class="stat-card">
        <div class="stat-value text-blue-600 dark:text-blue-400">{{ stats?.withoutTranslation ?? '—' }}</div>
        <div class="stat-label">未翻译</div>
      </div>
    </div>

    <!-- Typo Alert -->
    <div
      v-if="typoSuspects.length > 0 && !loading"
      class="mb-6 rounded-lg border border-amber-200 dark:border-amber-800/50 bg-amber-50/80 dark:bg-amber-900/10 p-4"
    >
      <div class="flex items-start gap-2">
        <span class="text-amber-500 text-lg leading-none mt-0.5">!</span>
        <div>
          <div class="text-sm font-medium text-amber-800 dark:text-amber-300">
            发现 {{ typoSuspects.length }} 个疑似拼写错误
          </div>
          <div class="mt-2 flex flex-wrap gap-1.5">
            <button
              v-for="t in typoSuspects.slice(0, 20)"
              :key="t.tag"
              class="inline-flex items-center gap-1 rounded-full bg-amber-100 dark:bg-amber-900/30 px-2.5 py-1 text-xs font-medium text-amber-800 dark:text-amber-300 hover:bg-amber-200 dark:hover:bg-amber-800/40 transition"
              @click="scrollToTag(t.tag)"
            >
              {{ t.tag }}
              <span class="opacity-60">→ {{ t.typoMatch }}</span>
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- Search & Sort -->
    <div class="flex flex-col sm:flex-row sm:items-center gap-3 mb-4">
      <input
        v-model="search"
        type="text"
        placeholder="搜索标签..."
        class="flex-1 px-3 py-2 rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 text-sm text-neutral-700 dark:text-neutral-200"
      />
      <div class="flex items-center gap-2">
        <button
          v-for="opt in sortOptions"
          :key="opt.key"
          type="button"
          class="px-3 py-1.5 text-sm rounded-lg border transition-colors"
          :class="sortKey === opt.key
            ? 'border-[var(--g-accent)] text-[var(--g-accent)]'
            : 'border-neutral-200 dark:border-neutral-700 text-neutral-600 dark:text-neutral-300 hover:border-neutral-300 dark:hover:border-neutral-600'"
          @click="toggleSort(opt.key)"
        >
          {{ opt.label }}
          <span v-if="sortKey === opt.key" class="ml-0.5 text-xs">{{ sortDir === 'desc' ? '↓' : '↑' }}</span>
        </button>
        <label class="flex items-center gap-1.5 text-xs text-neutral-500 dark:text-neutral-400 ml-2">
          <input v-model="onlyTypos" type="checkbox" class="rounded" />
          仅疑似拼错
        </label>
      </div>
    </div>

    <!-- Loading / Error -->
    <div v-if="loading" class="space-y-3">
      <div v-for="i in 6" :key="i" class="h-14 rounded-lg bg-neutral-100 dark:bg-neutral-800 animate-pulse" />
    </div>
    <div v-else-if="error" class="rounded-lg border border-red-200 dark:border-red-700 bg-red-50 dark:bg-red-900/20 px-4 py-3 text-sm text-red-700 dark:text-red-300">
      加载失败：{{ error }}
    </div>

    <!-- Tag List -->
    <div v-else-if="filteredTags.length === 0" class="text-sm text-neutral-500 dark:text-neutral-400 py-8 text-center">
      {{ search ? '未找到匹配的标签' : '暂无数据' }}
    </div>
    <div v-else>
      <div class="overflow-x-auto">
        <table class="min-w-full text-sm text-left">
          <thead class="text-xs uppercase tracking-wide text-neutral-500 dark:text-neutral-400 border-b border-neutral-200 dark:border-neutral-700">
            <tr>
              <th class="py-2.5 pr-3">标签</th>
              <th class="py-2.5 pr-3 w-24 text-right">页面数</th>
              <th class="py-2.5 pr-3 w-44">疑似拼写</th>
              <th class="py-2.5 pr-3 w-40 text-right hidden sm:table-cell">最近使用</th>
              <th class="py-2.5 w-40 hidden lg:table-cell">样本页面</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="tag in paginatedTags"
              :key="tag.tag"
              :ref="el => setTagRef(tag.tag, el)"
              class="border-b border-neutral-100 dark:border-neutral-800 hover:bg-neutral-50 dark:hover:bg-neutral-800/50 transition"
              :class="highlightTag === tag.tag ? 'bg-amber-50/60 dark:bg-amber-900/10' : ''"
            >
              <td class="py-2.5 pr-3">
                <NuxtLink
                  :to="`/search?tags=${encodeURIComponent(tag.tag)}`"
                  class="font-medium text-neutral-900 dark:text-neutral-100 hover:text-[var(--g-accent)]"
                >
                  {{ tag.tag }}
                </NuxtLink>
              </td>
              <td class="py-2.5 pr-3 text-right tabular-nums font-semibold text-neutral-700 dark:text-neutral-200">
                {{ tag.pageCount }}
              </td>
              <td class="py-2.5 pr-3">
                <span
                  v-if="tag.typoMatch"
                  class="inline-flex items-center gap-1 rounded-full bg-amber-100 dark:bg-amber-900/30 px-2 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-300"
                >
                  → {{ tag.typoMatch }}
                  <span class="opacity-50">({{ tag.typoDistance }})</span>
                </span>
                <span v-else class="text-neutral-300 dark:text-neutral-600">—</span>
              </td>
              <td class="py-2.5 pr-3 text-right text-xs text-neutral-500 dark:text-neutral-400 hidden sm:table-cell">
                {{ formatDate(tag.latestPageDate) }}
              </td>
              <td class="py-2.5 text-xs text-neutral-500 dark:text-neutral-400 hidden lg:table-cell">
                <template v-if="tag.samplePages?.length">
                  <NuxtLink
                    v-for="(sid, idx) in tag.samplePages.slice(0, 2)"
                    :key="sid"
                    :to="`/page/${sid}`"
                    class="hover:text-[var(--g-accent)] hover:underline"
                  >{{ idx > 0 ? ', ' : '' }}{{ sid }}</NuxtLink>
                </template>
                <span v-else>—</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- Pagination -->
      <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mt-4 text-sm text-neutral-600 dark:text-neutral-300">
        <div>
          第 {{ pageStart }}–{{ pageEnd }} 条，共 {{ filteredTags.length }} 个标签
        </div>
        <div class="flex items-center gap-2">
          <button
            class="px-3 py-1.5 rounded-lg border border-neutral-200 dark:border-neutral-700 hover:border-neutral-300 dark:hover:border-neutral-600 disabled:opacity-40 disabled:cursor-not-allowed"
            :disabled="page <= 1"
            @click="page--"
          >上一页</button>
          <span class="text-xs text-neutral-500 dark:text-neutral-400">{{ page }} / {{ maxPage }}</span>
          <button
            class="px-3 py-1.5 rounded-lg border border-neutral-200 dark:border-neutral-700 hover:border-neutral-300 dark:hover:border-neutral-600 disabled:opacity-40 disabled:cursor-not-allowed"
            :disabled="page >= maxPage"
            @click="page++"
          >下一页</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch, nextTick } from 'vue'
import { useNuxtApp } from 'nuxt/app'

import type { BffFetcher } from '~/types/nuxt-bff'
const { $bff } = useNuxtApp()
const bff = $bff as BffFetcher

// ─── State ───

const loading = ref(true)
const error = ref<string | null>(null)

interface TagEntry {
  tag: string
  pageCount: number
  samplePages: string[]
  latestPageDate: string | null
  typoMatch: string | null
  typoDistance: number | null
}

interface Stats {
  total: number
  withTranslation: number
  withoutTranslation: number
  invalidCount: number
  byCategory: Array<{ category: string; count: number }>
}

const invalidTags = ref<TagEntry[]>([])
const invalidTotal = ref(0)
const stats = ref<Stats | null>(null)
const officialTags = ref<string[]>([])

const search = ref('')
const sortKey = ref<'count' | 'alpha' | 'typo'>('count')
const sortDir = ref<'asc' | 'desc'>('desc')
const onlyTypos = ref(false)
const page = ref(1)
const pageSize = 40
const highlightTag = ref<string | null>(null)

const sortOptions = [
  { key: 'count' as const, label: '按页面数' },
  { key: 'alpha' as const, label: '按标签名' },
  { key: 'typo' as const, label: '按相似度' },
]

// ─── Data Loading ───

async function fetchAllPages<T>(
  url: string,
  key: string,
  pageSize: number,
  params: Record<string, string | number> = {}
): Promise<{ items: T[]; total: number }> {
  const firstResp = await bff<Record<string, any>>(url, { params: { ...params, limit: pageSize, offset: 0 } })
  const total: number = firstResp.total ?? 0
  const items: T[] = firstResp[key] ?? []

  // Fetch remaining pages if needed
  const remaining = total - items.length
  if (remaining > 0) {
    const pageCount = Math.ceil(remaining / pageSize)
    const pages = await Promise.all(
      Array.from({ length: pageCount }, (_, i) =>
        bff<Record<string, any>>(url, { params: { ...params, limit: pageSize, offset: (i + 1) * pageSize } })
      )
    )
    for (const p of pages) {
      const batch = p[key] ?? []
      items.push(...batch)
    }
  }

  return { items, total }
}

async function loadData() {
  loading.value = true
  error.value = null
  try {
    const [invalidResult, statsResp, defsResult] = await Promise.all([
      fetchAllPages<{ tag: string; pageCount: number; samplePages: string[]; latestPageDate: string | null }>(
        '/tags/definitions/invalid', 'invalidTags', 200, { sort: 'count' }
      ),
      bff<Stats>('/tags/definitions/stats'),
      fetchAllPages<{ tagChinese: string; tagEnglish: string | null }>(
        '/tags/definitions', 'definitions', 1000
      ),
    ])

    stats.value = statsResp
    invalidTotal.value = invalidResult.total

    // Build official tag set for similarity matching
    const officials: string[] = []
    for (const d of defsResult.items) {
      officials.push(d.tagChinese)
      if (d.tagEnglish) officials.push(d.tagEnglish)
    }
    officialTags.value = officials

    // Compute similarity for each invalid tag
    invalidTags.value = computeTypoMatches(invalidResult.items, officials)
  } catch (err: any) {
    error.value = err?.message || '未知错误'
  } finally {
    loading.value = false
  }
}

function reload() {
  void loadData()
}

onMounted(() => {
  void loadData()
})

// ─── Levenshtein Similarity ───

function levenshtein(a: string, b: string): number {
  const la = a.length
  const lb = b.length
  if (la === 0) return lb
  if (lb === 0) return la
  // Early exit: if length difference already exceeds threshold, skip
  if (Math.abs(la - lb) > 3) return Math.abs(la - lb)

  const prev = new Uint16Array(lb + 1)
  const curr = new Uint16Array(lb + 1)

  for (let j = 0; j <= lb; j++) prev[j] = j

  for (let i = 1; i <= la; i++) {
    curr[0] = i
    for (let j = 1; j <= lb; j++) {
      curr[j] = a[i - 1] === b[j - 1]
        ? prev[j - 1]
        : 1 + Math.min(prev[j - 1], prev[j], curr[j - 1])
    }
    prev.set(curr)
  }
  return prev[lb]
}

function computeTypoMatches(
  tags: Array<{ tag: string; pageCount: number; samplePages: string[]; latestPageDate: string | null }>,
  officials: string[]
): TagEntry[] {
  const maxDist = 2

  return tags.map(t => {
    let bestMatch: string | null = null
    let bestDist = Infinity

    // Only compute similarity for tags with reasonable length
    if (t.tag.length <= 30) {
      for (const official of officials) {
        // Quick length pre-filter
        if (Math.abs(t.tag.length - official.length) > maxDist) continue
        const d = levenshtein(t.tag, official)
        if (d > 0 && d <= maxDist && d < bestDist) {
          bestDist = d
          bestMatch = official
        }
      }
    }

    return {
      tag: t.tag,
      pageCount: t.pageCount,
      samplePages: t.samplePages || [],
      latestPageDate: t.latestPageDate,
      typoMatch: bestMatch,
      typoDistance: bestMatch ? bestDist : null,
    }
  })
}

// ─── Filtering & Sorting ───

const typoSuspects = computed(() =>
  invalidTags.value.filter(t => t.typoMatch).sort((a, b) => (a.typoDistance ?? 99) - (b.typoDistance ?? 99))
)

const filteredTags = computed(() => {
  let items = [...invalidTags.value]

  if (onlyTypos.value) {
    items = items.filter(t => t.typoMatch)
  }

  if (search.value.trim()) {
    const q = search.value.trim().toLowerCase()
    items = items.filter(t =>
      t.tag.toLowerCase().includes(q) ||
      (t.typoMatch && t.typoMatch.toLowerCase().includes(q))
    )
  }

  const dir = sortDir.value === 'desc' ? -1 : 1
  items.sort((a, b) => {
    switch (sortKey.value) {
      case 'count':
        return (a.pageCount - b.pageCount) * dir
      case 'alpha':
        return a.tag.localeCompare(b.tag, 'zh-Hans-CN') * dir
      case 'typo':
        // Tags with typo matches first, then by distance
        const da = a.typoMatch ? (a.typoDistance ?? 99) : 99
        const db = b.typoMatch ? (b.typoDistance ?? 99) : 99
        return (da - db) * dir || (a.pageCount - b.pageCount) * -1
    }
  })

  return items
})

const maxPage = computed(() => Math.max(1, Math.ceil(filteredTags.value.length / pageSize)))
const paginatedTags = computed(() => {
  const start = (page.value - 1) * pageSize
  return filteredTags.value.slice(start, start + pageSize)
})
const pageStart = computed(() => filteredTags.value.length === 0 ? 0 : (page.value - 1) * pageSize + 1)
const pageEnd = computed(() => Math.min(page.value * pageSize, filteredTags.value.length))

function toggleSort(key: typeof sortKey.value) {
  if (sortKey.value === key) {
    sortDir.value = sortDir.value === 'desc' ? 'asc' : 'desc'
  } else {
    sortKey.value = key
    sortDir.value = key === 'alpha' ? 'asc' : 'desc'
  }
}

watch([search, sortKey, sortDir, onlyTypos], () => {
  page.value = 1
})

watch(() => filteredTags.value.length, () => {
  page.value = Math.min(page.value, maxPage.value)
})

// ─── Helpers ───

function formatDate(value?: string | null) {
  if (!value) return '—'
  try {
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) return '—'
    return date.toLocaleDateString('zh-CN', { year: 'numeric', month: 'short', day: 'numeric' })
  } catch {
    return '—'
  }
}

const tagRefs = new Map<string, Element | null>()

function setTagRef(tag: string, el: any) {
  if (el) tagRefs.set(tag, el as Element)
}

let scrollRetried = false

function scrollToTag(tag: string) {
  // Find which page the tag is on
  const idx = filteredTags.value.findIndex(t => t.tag === tag)
  if (idx < 0) {
    if (scrollRetried) { scrollRetried = false; return }
    // Tag might be filtered out — clear filters and retry once
    scrollRetried = true
    search.value = ''
    onlyTypos.value = false
    nextTick(() => scrollToTag(tag))
    return
  }
  scrollRetried = false
  page.value = Math.floor(idx / pageSize) + 1
  highlightTag.value = tag
  nextTick(() => {
    const el = tagRefs.get(tag)
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    setTimeout(() => { highlightTag.value = null }, 2000)
  })
}
</script>

<style scoped>
.stat-card {
  @apply rounded-lg border border-neutral-200/70 dark:border-neutral-800 bg-white/90 dark:bg-neutral-900/80 p-4 text-center;
}
.stat-value {
  @apply text-2xl font-bold text-neutral-900 dark:text-neutral-100 tabular-nums;
}
.stat-label {
  @apply text-xs text-neutral-500 dark:text-neutral-400 mt-1;
}
</style>
