<template>
  <div class="max-w-6xl mx-auto px-4 py-12 space-y-12">
    <section class="rounded-3xl border border-white/70 bg-white/90 px-6 py-10 shadow-[0_24px_60px_rgba(15,23,42,0.08)] backdrop-blur dark:border-white/10 dark:bg-neutral-900/85 dark:shadow-[0_18px_50px_rgba(0,0,0,0.55)]">
      <div class="flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
        <div class="space-y-4">
          <div class="inline-flex items-center gap-2 rounded-full border border-[rgba(var(--accent),0.35)] bg-[rgba(var(--accent),0.1)] px-4 py-1 text-xs font-semibold uppercase tracking-[0.2em] text-[rgb(var(--accent))]">
            <span>Newbee 2025</span>
          </div>
          <div class="space-y-3">
            <h1 class="text-3xl font-semibold text-neutral-900 dark:text-neutral-50 sm:text-4xl">2025“群雄逐鹿”新秀竞赛</h1>
          </div>
        </div>
        <div class="rounded-2xl border border-[rgba(var(--accent),0.4)] bg-[rgba(var(--accent),0.08)] px-6 py-5 text-sm text-[rgb(var(--accent-strong))]">
          <div class="font-semibold">当前更新时间</div>
          <div class="mt-1 font-mono text-lg tracking-wide">
            {{ nowFormatted }}
          </div>
          <div class="mt-2 text-xs text-[rgba(var(--accent-strong),0.7)]">基于浏览器本地时间</div>
        </div>
      </div>
    </section>

    <section class="space-y-5">
      <div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 class="text-xl font-semibold text-neutral-900 dark:text-neutral-50">赛事倒计时</h2>
          <p class="text-sm text-neutral-500 dark:text-neutral-400">北京时间（GMT+08）为准，实时更新至下一关键节点。</p>
        </div>
      </div>
      <div class="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        <div
          v-for="milestone in milestoneStates"
          :key="milestone.key"
          class="relative rounded-2xl border p-5 transition-colors"
          :class="[
            'border-neutral-200/80 bg-white/80 dark:border-neutral-800/70 dark:bg-neutral-900/80 backdrop-blur',
            milestone.key === nextMilestoneKey && milestone.status === 'upcoming' ? 'ring-2 ring-[rgba(var(--accent),0.65)]' : ''
          ]"
        >
          <div class="flex items-start justify-between gap-4">
            <div>
              <div class="text-sm font-semibold text-neutral-900 dark:text-neutral-100">{{ milestone.label }}</div>
              <div class="mt-1 text-xs text-neutral-500 dark:text-neutral-400">{{ milestone.display }}</div>
            </div>
            <span class="rounded-full bg-[rgba(var(--accent),0.12)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[rgb(var(--accent))]">
              {{ milestone.status === 'upcoming' ? '倒计时' : '已结束' }}
            </span>
          </div>
          <div class="mt-4 font-mono text-2xl font-semibold text-neutral-900 dark:text-neutral-50">
            {{ milestone.countdown }}
          </div>
          <div class="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
            {{ milestone.status === 'upcoming' ? '剩余时间' : '已过去时间' }}
          </div>
        </div>
      </div>
    </section>

    <section class="space-y-4">
      <h2 class="text-xl font-semibold text-neutral-900 dark:text-neutral-50">参赛规则</h2>
      <div class="rounded-2xl border border-neutral-200/80 bg-white/85 p-6 leading-7 text-neutral-700 shadow-sm backdrop-blur dark:border-neutral-800/70 dark:bg-neutral-900/80 dark:text-neutral-300 dark:shadow-none">
        <p>本届比赛为参赛作品设置了三个可选主题：控制、收容、保护。</p>
        <p class="mt-3">参赛选手在投稿时，应当为自己的作品选择一个主题，同时该作品内容应当符合你所选的主题。</p>
        <p class="mt-3">根据你选择的主题，请为你的作品打上“_2025新竞控制”，“_2025新竞收容”，或者“_2025新竞保护”标签。</p>
        <p class="mt-3">分数结算后，将根据各主题阵营下所有参赛作品的总分选出获胜主题阵营。</p>
        <p class="mt-3">获胜阵营将会占领本届比赛的颁奖庆典！</p>
      </div>
    </section>

    <section class="space-y-4">
      <div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 class="text-xl font-semibold text-neutral-900 dark:text-neutral-50">赛道随机展示</h2>
          <p class="text-sm text-neutral-500 dark:text-neutral-400">从含有“2025新秀竞赛”标签的作品中，按照赛道标签随机挑选示例。</p>
        </div>
        <button
          type="button"
          class="inline-flex items-center gap-1 rounded-full border border-neutral-200 px-3 py-1.5 text-xs font-medium text-neutral-600 transition hover:border-[rgba(var(--accent),0.5)] hover:text-[rgb(var(--accent))] dark:border-neutral-700 dark:text-neutral-300"
          @click="refreshTrackHighlights"
          :disabled="entriesPending"
        >
          <span>换一批</span>
        </button>
      </div>
      <div class="grid gap-4 md:grid-cols-2">
        <div
          v-for="track in trackHighlights"
          :key="track.def.key"
          class="space-y-3 rounded-2xl border border-neutral-200/80 bg-white/85 p-4 backdrop-blur transition-colors dark:border-neutral-800/70 dark:bg-neutral-900/80"
          :style="track.palette.card"
        >
          <div class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div class="space-y-1">
              <div class="flex items-center gap-2">
                <span class="inline-flex h-2.5 w-2.5 rounded-full" :style="track.palette.accentDot"></span>
                <div class="text-sm font-semibold text-neutral-900 dark:text-neutral-100">{{ track.def.title }}</div>
              </div>
              <div class="text-xs text-neutral-600 dark:text-neutral-400" :style="{ color: track.palette.accentText }">
                {{ track.def.subtitle }}
              </div>
              <div
                v-if="track.theme"
                class="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium"
                :style="track.themeBadgeStyle"
              >
                <span class="inline-flex h-1.5 w-1.5 rounded-full" :style="track.palette.accentDot"></span>
                <span>{{ track.theme.title }}</span>
              </div>
            </div>
            <div class="flex items-center justify-start gap-2 sm:justify-end">
              <span
                class="self-start rounded-full border px-2 py-0.5 text-[11px] font-medium"
                :style="track.palette.badge"
              >
                {{ track.count }} 篇
              </span>
            </div>
          </div>
          <PageCard v-if="track.card" size="lg" :p="track.card" />
          <div
            v-else
            class="flex h-64 items-center justify-center rounded-xl border border-dashed text-sm text-neutral-400 dark:text-neutral-500"
            :style="{ borderColor: track.palette.accentBorder }"
          >
            暂无符合条件的作品
          </div>
        </div>
      </div>
    </section>

    <section class="space-y-4">
      <div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 class="text-xl font-semibold text-neutral-900 dark:text-neutral-50">主题随机展示</h2>
          <p class="text-sm text-neutral-500 dark:text-neutral-400">按控制、收容、保护三个主题标签抽选作品示例。</p>
          <div class="mt-2 flex flex-wrap items-center gap-2 text-xs text-neutral-500 dark:text-neutral-400">
            <span
              v-for="legend in themeDefinitions"
              :key="legend.key"
              class="inline-flex items-center gap-1 rounded-full border px-2 py-0.5"
              :style="{
                backgroundColor: themePalettes[legend.key]?.badge.backgroundColor || 'rgba(148,163,184,0.12)',
                borderColor: themePalettes[legend.key]?.badge.borderColor || 'rgba(148,163,184,0.35)',
                color: themePalettes[legend.key]?.badge.color || '#475569'
              }"
            >
              <span class="inline-flex h-2 w-2 rounded-full" :style="themePalettes[legend.key]?.accentDot"></span>
              <span>{{ legend.title }}</span>
            </span>
          </div>
        </div>
        <button
          type="button"
          class="inline-flex items-center gap-1 rounded-full border border-neutral-200 px-3 py-1.5 text-xs font-medium text-neutral-600 transition hover:border-[rgba(var(--accent),0.5)] hover:text-[rgb(var(--accent))] dark:border-neutral-700 dark:text-neutral-300"
          @click="refreshThemeHighlights"
          :disabled="entriesPending"
        >
          <span>换一批</span>
        </button>
      </div>
      <div class="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        <div
          v-for="theme in themeHighlights"
          :key="theme.def.key"
          class="space-y-3 rounded-2xl border border-neutral-200/80 bg-white/85 p-4 backdrop-blur transition-colors dark:border-neutral-800/70 dark:bg-neutral-900/80"
          :style="themePalettes[theme.def.key]?.card"
        >
          <div class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div class="space-y-1">
              <div class="flex items-center gap-2">
                <span class="inline-flex h-2.5 w-2.5 rounded-full" :style="themePalettes[theme.def.key]?.accentDot"></span>
                <div class="text-sm font-semibold text-neutral-900 dark:text-neutral-100">{{ theme.def.title }}</div>
              </div>
              <div class="text-xs text-neutral-600 dark:text-neutral-400" :style="{ color: themePalettes[theme.def.key]?.accentText }">
                {{ theme.def.subtitle }}
              </div>
            </div>
            <div class="flex items-center justify-start gap-2 sm:justify-end">
              <span
                class="self-start rounded-full border px-2 py-0.5 text-[11px] font-medium"
                :style="themePalettes[theme.def.key]?.badge"
              >
                {{ theme.count }} 篇
              </span>
            </div>
          </div>
          <PageCard v-if="theme.card" size="md" :p="theme.card" />
          <div
            v-else
            class="flex h-40 items-center justify-center rounded-xl border border-dashed text-sm text-neutral-400 dark:text-neutral-500"
            :style="{ borderColor: themePalettes[theme.def.key]?.accentBorder || 'rgba(148,163,184,0.45)' }"
          >
            暂无符合条件的作品
          </div>
        </div>
      </div>
    </section>

    <section class="space-y-4">
      <div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 class="text-xl font-semibold text-neutral-900 dark:text-neutral-50">全部参赛作品</h2>
          <p class="text-sm text-neutral-500 dark:text-neutral-400">
            当前共 {{ entriesCount }} 篇作品，全部包含“2025新秀竞赛”标签。
          </p>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <div class="inline-flex items-center gap-1 rounded-full border border-neutral-200 px-1 py-1 text-xs dark:border-neutral-700">
            <button
              type="button"
              class="rounded-full px-3 py-1 transition"
              :class="orderMode === 'created' ? 'bg-[rgba(var(--accent),0.12)] text-[rgb(var(--accent))]' : 'text-neutral-500 dark:text-neutral-400'"
              @click="orderMode = 'created'"
            >
              按时间
            </button>
            <button
              type="button"
              class="rounded-full px-3 py-1 transition"
              :class="orderMode === 'random' ? 'bg-[rgba(var(--accent),0.12)] text-[rgb(var(--accent))]' : 'text-neutral-500 dark:text-neutral-400'"
              @click="orderMode = 'random'"
            >
              随机
            </button>
          </div>
          <button
            v-if="orderMode === 'random'"
            type="button"
            class="inline-flex items-center gap-1 rounded-full border border-neutral-200 px-3 py-1.5 text-xs font-medium text-neutral-600 transition hover:border-[rgba(var(--accent),0.5)] hover:text-[rgb(var(--accent))] dark:border-neutral-700 dark:text-neutral-300"
            @click="reshuffleEntries"
            :disabled="entriesPending"
          >
            <span>重新随机</span>
          </button>
        </div>
      </div>
      <div v-if="entriesPending" class="rounded-2xl border border-dashed border-neutral-200/60 bg-white/60 p-6 text-center text-sm text-neutral-500 dark:border-neutral-800/60 dark:bg-neutral-900/60 dark:text-neutral-400">
        正在加载参赛作品…
      </div>
      <div v-else-if="entriesError" class="rounded-2xl border border-red-200 bg-red-50 p-5 text-sm text-red-600 dark:border-red-800 dark:bg-red-900/20 dark:text-red-300">
        加载参赛作品失败：{{ entriesError.message || entriesError }}
      </div>
      <div v-else>
        <div v-if="displayedEntries.length === 0" class="rounded-2xl border border-dashed border-neutral-200/60 bg-white/70 p-6 text-center text-sm text-neutral-500 dark:border-neutral-800/60 dark:bg-neutral-900/70 dark:text-neutral-400">
          暂未收录带有“2025新秀竞赛”标签的作品。
        </div>
        <div v-else class="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          <PageCard v-for="(entry, idx) in displayedEntries" :key="entry.wikidotId ?? entry.title ?? idx" size="md" :p="entry" />
        </div>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch, onMounted, onBeforeUnmount } from 'vue'
import { useNuxtApp, useAsyncData } from 'nuxt/app'
import { useViewerVotes } from '~/composables/useViewerVotes'
import { orderTags } from '~/composables/useTagOrder'

import PageCard from '~/components/PageCard.vue'

definePageMeta({ title: '2025“群雄逐鹿”新秀竞赛', key: 'newbee2025' })

const milestones = [
  {
    key: 'submission-open',
    label: '投稿开始',
    iso: '2025-10-01T12:00:00+08:00',
    display: '北京时间 (GMT+08) 2025年10月01日 12:00:00'
  },
  {
    key: 'submission-deadline',
    label: '投稿截止',
    iso: '2025-10-24T12:00:00+08:00',
    display: '北京时间 (GMT+08) 2025年10月24日 12:00:00'
  },
  {
    key: 'declaration-deadline',
    label: '声明截止',
    iso: '2025-10-25T12:00:00+08:00',
    display: '北京时间 (GMT+08) 2025年10月25日 12:00:00'
  },
  {
    key: 'achievement-reveal',
    label: '揭榜成就',
    iso: '2025-10-25T12:00:00+08:00',
    display: '北京时间 (GMT+08) 2025年10月25日 12:00:00'
  },
  {
    key: 'voting-deadline',
    label: '投票截止',
    iso: '2025-10-31T12:00:00+08:00',
    display: '北京时间 (GMT+08) 2025年10月31日 12:00:00'
  }
] as const

const milestoneTargets = milestones.map(m => ({
  ...m,
  timestamp: new Date(m.iso).getTime()
}))

const nowTick = ref(Date.now())
let timer: ReturnType<typeof setInterval> | null = null

onMounted(() => {
  timer = setInterval(() => {
    nowTick.value = Date.now()
  }, 1000)
})

onBeforeUnmount(() => {
  if (timer) clearInterval(timer)
})

const nowFormatted = computed(() => {
  const formatter = new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  })
  return formatter.format(new Date(nowTick.value))
})

function formatDuration(ms: number) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const days = Math.floor(totalSeconds / 86400)
  const hours = Math.floor((totalSeconds % 86400) / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(days)}天 ${pad(hours)}:${pad(minutes)}:${pad(seconds)}`
}

const milestoneStates = computed(() => {
  return milestoneTargets.map(m => {
    const diff = m.timestamp - nowTick.value
    return {
      key: m.key,
      label: m.label,
      display: m.display,
      status: diff > 0 ? 'upcoming' : 'passed',
      countdown: formatDuration(Math.abs(diff))
    }
  })
})

const nextMilestoneKey = computed(() => {
  const upcoming = milestoneTargets
    .map(m => ({ key: m.key, diff: m.timestamp - nowTick.value }))
    .filter(m => m.diff > 0)
  if (!upcoming.length) return null
  return upcoming.reduce((prev, curr) => (curr.diff < prev.diff ? curr : prev)).key
})

interface Entry {
  wikidotId?: number
  title?: string
  alternateTitle?: string
  authors?: Array<{ name: string; url?: string }>
  tags?: string[]
  rating?: number
  commentCount?: number
  voteCount?: number
  controversy?: number
  snippet?: string
  snippetHtml?: string
  excerpt?: string
  firstRevisionAt?: string
  createdAt?: string
  validFrom?: string
  updatedAt?: string
  isDeleted?: boolean
  deletedAt?: string | null
  wilson95?: number
  revisionCount?: number
  sparkLine?: string | null
  sparkPoints?: string | null
}

const { $bff } = useNuxtApp()
const { hydratePages: hydrateViewerVotes } = useViewerVotes()

const { data: entriesData, pending: entriesPendingRef, error: entriesErrorRef } = await useAsyncData('newbee2025-entries', async () => {
  const resp = await $bff('/search/pages', {
    params: {
      tags: ['2025新秀竞赛'],
      limit: 200,
      includeSnippet: true,
      includeDate: true
    }
  })
  if (Array.isArray(resp?.results)) return resp.results as Entry[]
  if (Array.isArray(resp)) return resp as Entry[]
  return [] as Entry[]
})

const entriesPending = computed(() => Boolean(entriesPendingRef.value))
const entriesError = computed(() => entriesErrorRef.value as Error | null)
const rawEntries = computed<Entry[]>(() => entriesData.value ?? [])
const entriesCount = computed(() => rawEntries.value.length)

function toTimestamp(entry: Entry): number {
  const source = entry.firstRevisionAt || entry.createdAt || entry.validFrom || entry.updatedAt
  if (!source) return 0
  const d = new Date(source)
  return Number.isNaN(d.getTime()) ? 0 : d.getTime()
}

function normalizeEntry(entry: Entry) {
  const toISO = (value?: string) => {
    if (!value) return null
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10)
  }
  const pickExcerpt = (value?: string | null) => {
    if (typeof value !== 'string') return null
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : null
  }
  const excerpt = pickExcerpt(entry.excerpt) ?? pickExcerpt(entry.snippet)
  const snippetHtml = entry.snippetHtml ?? (excerpt ?? null)
  return {
    wikidotId: entry.wikidotId,
    title: entry.title,
    alternateTitle: entry.alternateTitle,
    authors: entry.authors,
    tags: orderTags(entry.tags as string[] | null | undefined),
    rating: entry.rating,
    commentCount: entry.commentCount ?? entry.revisionCount ?? null,
    controversy: entry.controversy,
    snippetHtml,
    excerpt,
    isDeleted: Boolean(entry.isDeleted),
    deletedAt: entry.deletedAt ?? null,
    createdDate: toISO(entry.firstRevisionAt || entry.createdAt || entry.validFrom || entry.updatedAt),
    wilson95: entry.wilson95,
    voteCount: entry.voteCount,
    sparkLine: entry.sparkLine ?? null,
    sparkPoints: entry.sparkPoints ?? null
  }
}

function includesSubstring(tags: string[] | undefined, target: string) {
  if (!Array.isArray(tags) || !tags.length) return false
  const lower = target.toLowerCase()
  return tags.some(tag => tag.toLowerCase().includes(lower))
}

function includesExactTag(tags: string[] | undefined, target: string) {
  if (!Array.isArray(tags) || !tags.length) return false
  const lower = target.toLowerCase()
  return tags.some(tag => tag.toLowerCase() === lower)
}

function shuffle<T>(source: T[]): T[] {
  const arr = [...source]
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
  return arr
}

const trackDefinitions = [
  { key: 'scp', title: 'SCP赛道', subtitle: '标签含有 “scp”', predicate: (tags: string[] | undefined) => includesSubstring(tags, 'scp') },
  { key: 'story', title: '故事赛道', subtitle: '标签含有 “故事”', predicate: (tags: string[] | undefined) => includesSubstring(tags, '故事') },
  { key: 'goi', title: 'GoI格式赛道', subtitle: '标签含有 “goi格式”', predicate: (tags: string[] | undefined) => includesSubstring(tags, 'goi格式') },
  { key: 'wanderers', title: '图书馆赛道', subtitle: '标签含有 “wanderers”', predicate: (tags: string[] | undefined) => includesSubstring(tags, 'wanderers') }
] as const

const themeDefinitions = [
  { key: 'secure', title: '控制阵营', subtitle: '标签 `_2025新竞控制`', tag: '_2025新竞控制', color: '#ff6455' },
  { key: 'contain', title: '收容阵营', subtitle: '标签 `_2025新竞收容`', tag: '_2025新竞收容', color: '#6ea0ff' },
  { key: 'protect', title: '保护阵营', subtitle: '标签 `_2025新竞保护`', tag: '_2025新竞保护', color: '#ffff87' }
] as const

type StyleObject = Record<string, string>

type ThemePalette = {
  card: StyleObject
  badge: StyleObject
  accentDot: StyleObject
  accentText: string
  accentBorder: string
}

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const normalized = hex.trim().replace(/^#/, '')
  if (normalized.length !== 3 && normalized.length !== 6) return null
  const expanded = normalized.length === 3
    ? normalized.split('').map(char => char + char).join('')
    : normalized
  const value = Number.parseInt(expanded, 16)
  if (Number.isNaN(value)) return null
  return {
    r: (value >> 16) & 0xff,
    g: (value >> 8) & 0xff,
    b: value & 0xff
  }
}

function mixWithBlack(rgb: { r: number; g: number; b: number }, ratio: number) {
  const safeRatio = Math.max(0, Math.min(1, ratio))
  const clamp = (n: number) => Math.max(0, Math.min(255, Math.round(n)))
  return {
    r: clamp(rgb.r * (1 - safeRatio)),
    g: clamp(rgb.g * (1 - safeRatio)),
    b: clamp(rgb.b * (1 - safeRatio))
  }
}

function createThemePalette(hex: string): ThemePalette {
  const rgb = hexToRgb(hex)
  if (!rgb) {
    return {
      card: {},
      badge: {},
      accentDot: {},
      accentText: '#444444',
      accentBorder: 'rgba(148, 163, 184, 0.45)'
    }
  }
  const { r, g, b } = rgb
  const card: StyleObject = {
    background: `linear-gradient(135deg, rgba(${r}, ${g}, ${b}, 0.20), rgba(${r}, ${g}, ${b}, 0.06))`,
    borderColor: `rgba(${r}, ${g}, ${b}, 0.45)`,
    boxShadow: `0 18px 36px rgba(${r}, ${g}, ${b}, 0.18)`
  }
  const toLinear = (channel: number) => {
    const c = channel / 255
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
  }
  const luminance = 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b)
  const darkenRatio = luminance >= 0.8 ? 0.35 : luminance >= 0.65 ? 0.25 : luminance >= 0.45 ? 0.18 : luminance >= 0.3 ? 0.12 : 0.08
  const accentRgb = mixWithBlack(rgb, darkenRatio)
  const accent = `rgb(${accentRgb.r}, ${accentRgb.g}, ${accentRgb.b})`
  const badge: StyleObject = {
    backgroundColor: `rgba(${r}, ${g}, ${b}, 0.16)`,
    borderColor: `rgba(${accentRgb.r}, ${accentRgb.g}, ${accentRgb.b}, 0.65)`,
    color: accent
  }
  const accentDot: StyleObject = {
    backgroundColor: accent
  }
  return {
    card,
    badge,
    accentDot,
    accentText: accent,
    accentBorder: `rgba(${accentRgb.r}, ${accentRgb.g}, ${accentRgb.b}, 0.55)`
  }
}

const themePalettes = computed(() => {
  const map: Record<string, ThemePalette> = {}
  for (const def of themeDefinitions) {
    map[def.key] = createThemePalette(def.color)
  }
  return map
})

const fallbackPalette = createThemePalette('#94a3b8')
const neutralBadgeStyle: StyleObject = {
  backgroundColor: 'rgba(148, 163, 184, 0.12)',
  borderColor: 'rgba(148, 163, 184, 0.35)',
  color: '#475569'
}

const trackSamples = ref<Record<string, Entry | null>>({})
const themeSamples = ref<Record<string, Entry | null>>({})
const randomEntries = ref<Entry[]>([])
const sparkCache = ref<Record<number, { line: string | null; area: string | null }>>({})
const sparkLoading = new Set<number>()

function buildSparklineFromSeries(series: Array<{ date?: string; cumulativeRating?: number | string }>) {
  if (!Array.isArray(series) || series.length < 2) {
    return { line: null, area: null }
  }
  const normalized = series
    .map(item => {
      const ts = item?.date ? new Date(item.date).getTime() : NaN
      const rating = Number(item?.cumulativeRating)
      return { x: ts, y: rating }
    })
    .filter(point => Number.isFinite(point.x) && Number.isFinite(point.y))
  if (normalized.length < 2) {
    return { line: null, area: null }
  }
  const recent = normalized.slice(-30)
  const xs = recent.map(pt => pt.x)
  const ys = recent.map(pt => pt.y)
  const minX = Math.min(...xs)
  const maxX = Math.max(...xs)
  const minY = Math.min(...ys)
  const maxY = Math.max(...ys)
  const rangeX = Math.max(1, maxX - minX)
  const rangeY = Math.max(1, maxY - minY)
  const linePoints = recent.map(pt => {
    const nx = 10 + 280 * ((pt.x - minX) / rangeX)
    const ny = 40 - 35 * ((pt.y - minY) / rangeY)
    return `${nx.toFixed(1)},${ny.toFixed(1)}`
  }).join(' ')
  if (!linePoints) {
    return { line: null, area: null }
  }
  return {
    line: linePoints,
    area: `${linePoints} 290,45 10,45`
  }
}

async function ensureSparklineFor(wikidotId: number | undefined | null) {
  const id = Number(wikidotId)
  if (!Number.isInteger(id) || id <= 0) return
  if (sparkCache.value[id] || sparkLoading.has(id)) return
  sparkLoading.add(id)
  try {
    const data = await $bff(`/pages/${id}/ratings/cumulative`)
    const spark = buildSparklineFromSeries(Array.isArray(data) ? data : [])
    sparkCache.value = { ...sparkCache.value, [id]: spark }
  } catch (error) {
    sparkCache.value = { ...sparkCache.value, [id]: { line: null, area: null } }
  } finally {
    sparkLoading.delete(id)
  }
}

function hydrateEntrySparklines(entries: Entry[]) {
  if (!Array.isArray(entries) || entries.length === 0) return
  const ids = Array.from(new Set(entries.map(entry => Number(entry.wikidotId)).filter(id => Number.isInteger(id) && id > 0)))
  if (ids.length === 0) return
  for (const id of ids) {
    void ensureSparklineFor(id)
  }
}

function resampleTrackHighlights() {
  const list = rawEntries.value
  const next: Record<string, Entry | null> = {}
  for (const def of trackDefinitions) {
    const filtered = list.filter(entry => def.predicate(entry.tags))
    next[def.key] = filtered.length ? filtered[Math.floor(Math.random() * filtered.length)] : null
  }
  trackSamples.value = next
  hydrateEntrySparklines(Object.values(next).filter((entry): entry is Entry => Boolean(entry)))
}

function resampleThemeHighlights() {
  const list = rawEntries.value
  const next: Record<string, Entry | null> = {}
  for (const def of themeDefinitions) {
    const filtered = list.filter(entry => includesExactTag(entry.tags, def.tag))
    next[def.key] = filtered.length ? filtered[Math.floor(Math.random() * filtered.length)] : null
  }
  themeSamples.value = next
}

function reshuffleEntries() {
  randomEntries.value = shuffle(rawEntries.value)
}

watch(rawEntries, list => {
  if (!Array.isArray(list) || list.length === 0) {
    trackSamples.value = {}
    themeSamples.value = {}
    randomEntries.value = []
    return
  }
  resampleTrackHighlights()
  resampleThemeHighlights()
  reshuffleEntries()
}, { immediate: true })

const trackHighlights = computed(() => {
  const paletteMap = themePalettes.value
  const cache = sparkCache.value
  return trackDefinitions.map(def => {
    const entry = trackSamples.value[def.key] ?? null
    const filteredCount = rawEntries.value.filter(item => def.predicate(item.tags)).length
    const themeMatch = entry ? themeDefinitions.find(theme => includesExactTag(entry.tags, theme.tag)) ?? null : null
    const palette = themeMatch ? paletteMap[themeMatch.key] ?? fallbackPalette : fallbackPalette
    const badgeStyle = themeMatch ? palette.badge : neutralBadgeStyle
    const baseCard = entry ? normalizeEntry(entry) : null
    const wikidotId = entry?.wikidotId ? Number(entry.wikidotId) : null
    const spark = (wikidotId && Number.isInteger(wikidotId) && wikidotId > 0) ? cache[wikidotId] : undefined
    const card = baseCard
      ? {
          ...baseCard,
          sparkLine: spark?.line ?? baseCard.sparkLine ?? null,
          sparkPoints: spark?.area ?? baseCard.sparkPoints ?? null
        }
      : null
    return {
      def,
      count: filteredCount,
      card,
      theme: themeMatch,
      palette,
      themeBadgeStyle: badgeStyle
    }
  })
})

const themeHighlights = computed(() => {
  return themeDefinitions.map(def => {
    const entry = themeSamples.value[def.key] ?? null
    const filteredCount = rawEntries.value.filter(item => includesExactTag(item.tags, def.tag)).length
    return {
      def,
      count: filteredCount,
      card: entry ? normalizeEntry(entry) : null
    }
  })
})

const sortedByCreated = computed(() => {
  const list = [...rawEntries.value]
  list.sort((a, b) => toTimestamp(b) - toTimestamp(a))
  return list
})

const entriesByCreated = computed(() => sortedByCreated.value.map(normalizeEntry))
const entriesByRandom = computed(() => randomEntries.value.map(normalizeEntry))

const orderMode = ref<'created' | 'random'>('created')
const displayedEntries = computed(() => (orderMode.value === 'created' ? entriesByCreated.value : entriesByRandom.value))

watch(
  () => [entriesByCreated.value, entriesByRandom.value],
  ([created, random]) => {
    if (!process.client) return
    const combined: any[] = []
    if (Array.isArray(created)) combined.push(...created)
    if (Array.isArray(random)) combined.push(...random)
    if (combined.length === 0) return
    const unique: any[] = []
    const seen = new Set<number>()
    for (const item of combined) {
      const id = Number(item?.wikidotId)
      if (!Number.isFinite(id)) continue
      const nid = Math.trunc(id)
      if (seen.has(nid)) continue
      seen.add(nid)
      unique.push(item)
    }
    if (unique.length > 0) {
      void hydrateViewerVotes(unique)
    }
  },
  { immediate: true, flush: 'post' }
)

watch(
  () => trackHighlights.value,
  (highlights) => {
    if (!process.client) return
    if (!Array.isArray(highlights) || highlights.length === 0) return
    const cards = highlights.map(h => h.card).filter(Boolean) as any[]
    if (cards.length === 0) return
    void hydrateViewerVotes(cards)
  },
  { immediate: true, flush: 'post' }
)

watch(
  () => themeHighlights.value,
  (highlights) => {
    if (!process.client) return
    if (!Array.isArray(highlights) || highlights.length === 0) return
    const cards = highlights.map(h => h.card).filter(Boolean) as any[]
    if (cards.length === 0) return
    void hydrateViewerVotes(cards)
  },
  { immediate: true, flush: 'post' }
)

function refreshTrackHighlights() {
  if (rawEntries.value.length === 0) return
  resampleTrackHighlights()
}

function refreshThemeHighlights() {
  if (rawEntries.value.length === 0) return
  resampleThemeHighlights()
}
</script>
