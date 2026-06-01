<template>
  <div class="max-w-6xl mx-auto px-4 py-12 space-y-12">
    <section class="rounded-lg border border-white/70 bg-white/90 px-6 py-10 shadow-sm backdrop-blur dark:border-white/10 dark:bg-neutral-900/85 dark:shadow-lg">
      <div class="flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
        <div class="space-y-4">
          <div class="inline-flex items-center gap-2 rounded-full border border-[var(--g-accent-border)] bg-[var(--g-accent-soft)] px-4 py-1 text-xs font-semibold uppercase tracking-[0.2em] text-[var(--g-accent)]">
            <span>Winter Contest 2026</span>
          </div>
          <div class="space-y-3">
            <h1 class="text-3xl font-semibold text-neutral-900 dark:text-neutral-50 sm:text-4xl">2026冬季征文：循环</h1>
            <p class="text-sm leading-relaxed text-neutral-600 dark:text-neutral-300">
              汇总“2026冬季征文”标签下的投稿作品，提供规则速览、赛程倒计时、随机抽样与全量浏览。
            </p>
            <div class="flex flex-wrap items-center gap-2 text-xs text-neutral-500 dark:text-neutral-400">
              <span class="inline-flex items-center gap-1 rounded-full border border-neutral-200 bg-white/80 px-3 py-1 dark:border-neutral-700 dark:bg-neutral-900/70">
                <span class="h-1.5 w-1.5 rounded-full bg-[var(--g-accent)]" />
                <span>统计标签：2026冬季征文</span>
              </span>
              <span class="inline-flex items-center gap-1 rounded-full border border-neutral-200 bg-white/80 px-3 py-1 dark:border-neutral-700 dark:bg-neutral-900/70">
                <span>主题：循环</span>
              </span>
              <span class="inline-flex items-center gap-1 rounded-full border border-neutral-200 bg-white/80 px-3 py-1 dark:border-neutral-700 dark:bg-neutral-900/70">
                <span>投稿类型：故事 / GOI格式</span>
              </span>
            </div>
          </div>
        </div>
        <div class="rounded-lg border border-[var(--g-accent-border)] bg-[var(--g-accent-soft)] px-6 py-5 text-sm text-[rgb(var(--accent-strong))]">
          <div class="font-semibold">当前更新时间</div>
          <div class="mt-1 font-mono text-lg tracking-wide">
            <ClientOnly>{{ nowFormatted }}<template #fallback>--</template></ClientOnly>
          </div>
          <div class="mt-2 text-xs text-[rgb(var(--accent-strong)_/_0.7)]">基于浏览器本地时间</div>
        </div>
      </div>
      <div
        v-if="heroImageVisible && heroImageSrc"
        class="mt-6 overflow-hidden rounded-lg border border-neutral-200/70 bg-gradient-to-r from-[var(--g-accent-soft)] via-white to-white dark:border-neutral-800/70 dark:from-[var(--g-accent-soft)] dark:via-neutral-900/60 dark:to-neutral-900/80"
      >
        <img
          :src="heroImageSrc"
          alt="2026冬季征文题图"
          class="h-full w-full max-h-96 object-cover"
          loading="lazy"
          @error="onHeroError"
        >
      </div>
    </section>

    <section class="space-y-4">
      <h2 class="text-xl font-semibold text-neutral-900 dark:text-neutral-50">征文导语</h2>
      <div class="rounded-lg border border-neutral-200/80 bg-white/85 p-6 leading-7 text-neutral-700 shadow-sm backdrop-blur dark:border-neutral-800/70 dark:bg-neutral-900/80 dark:text-neutral-300 dark:shadow-none">
        <p>有人说宇宙将在足够遥远的未来回归到曾经的某个状态，穿过莫比乌斯环的蚂蚁左右翻转。</p>
        <p class="mt-3">众生死了又生、生了又死。历史重复着自身，星球转动，周而复始。</p>
        <p class="mt-3">循环是否存在？如果知道自己身处循环，它究竟是枷锁，还是安慰？</p>
      </div>
    </section>

    <section class="space-y-5">
      <div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 class="text-xl font-semibold text-neutral-900 dark:text-neutral-50">赛程节点</h2>
          <p class="text-sm text-neutral-500 dark:text-neutral-400">北京时间（GMT+08）为准，实时更新至下一关键节点。</p>
        </div>
      </div>
      <ClientOnly>
      <div class="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        <div
          v-for="milestone in milestoneStates"
          :key="milestone.key"
          class="relative rounded-lg border p-5 transition-colors"
          :class="[
            'border-neutral-200/80 bg-white/80 dark:border-neutral-800/70 dark:bg-neutral-900/80 backdrop-blur',
            milestone.key === nextMilestoneKey && milestone.status === 'upcoming' ? 'ring-2 ring-[rgb(var(--accent)_/_0.65)]' : ''
          ]"
        >
          <div class="flex items-start justify-between gap-4">
            <div>
              <div class="text-sm font-semibold text-neutral-900 dark:text-neutral-100">{{ milestone.label }}</div>
              <div class="mt-1 text-xs text-neutral-500 dark:text-neutral-400">{{ milestone.display }}</div>
            </div>
            <span
              class="rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
              :class="milestone.status === 'upcoming' ? 'bg-[var(--g-accent-soft)] text-[var(--g-accent)]' : 'bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400'"
            >
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
      </ClientOnly>
    </section>

    <section class="space-y-4">
      <h2 class="text-xl font-semibold text-neutral-900 dark:text-neutral-50">竞赛规则</h2>
      <div class="rounded-lg border border-neutral-200/80 bg-white/85 p-6 text-sm leading-6 text-neutral-700 shadow-sm backdrop-blur dark:border-neutral-800/70 dark:bg-neutral-900/80 dark:text-neutral-300 dark:shadow-none">
        <ul class="list-disc space-y-2 pl-5">
          <li>题目为“循环”，参赛作品需与主题相关，循环是否严格存在、循环间是否一致由作者自行发挥。</li>
          <li>导语与题图仅用于启发和装饰，不构成创作限制。</li>
          <li>参赛页面必须打上“2026冬季征文”标签，否则不会被索引页收录。</li>
          <li>参赛作品需包含可见且可用的投票代码与评论区入口。</li>
          <li>赛前未正式发布过的草稿可以参赛。</li>
          <li>计票截止前禁止在其他 wiki 页面额外链接你的投稿（作者页不受此限制）。</li>
          <li>竞赛期间禁止使用 HTML、JavaScript 以及修改基金会基础版式/非正文区域元素的 CSS；GOI主页已明确列出的版式或 CSS 不受此限制。</li>
          <li>竞赛期间禁止使用外网址链接（仅允许 Wikidot 链接，赛后该限制失效）。</li>
          <li>本次仅接受“故事”“GOI格式”投稿。</li>
          <li>成人内容投稿不参与评奖，是否属于成人内容由站务判定。</li>
          <li>页面名称不支持中文，请使用英文或拼音。</li>
        </ul>
      </div>
    </section>

    <section class="space-y-4">
      <h2 class="text-xl font-semibold text-neutral-900 dark:text-neutral-50">奖项设置</h2>
      <div class="rounded-lg border border-neutral-200/80 bg-white/85 p-6 text-sm leading-6 text-neutral-700 shadow-sm backdrop-blur dark:border-neutral-800/70 dark:bg-neutral-900/80 dark:text-neutral-300 dark:shadow-none">
        <ul class="list-disc space-y-2 pl-5">
          <li>一等奖：奖金 500 元。</li>
          <li>二等奖：奖金 300 元。</li>
          <li>三等奖：奖金 200 元。</li>
          <li>可能增设特别奖，由站务在赛后视情况评选并决定是否颁发。</li>
          <li>具体排名以页面分数为基础，管理方保留最终规则解释与裁定权。</li>
        </ul>
      </div>
    </section>

    <section class="space-y-4">
      <h2 class="text-xl font-semibold text-neutral-900 dark:text-neutral-50">其他细则</h2>
      <div class="rounded-lg border border-neutral-200/80 bg-white/85 p-6 text-sm leading-6 text-neutral-700 shadow-sm backdrop-blur dark:border-neutral-800/70 dark:bg-neutral-900/80 dark:text-neutral-300 dark:shadow-none">
        <ul class="list-disc space-y-2 pl-5">
          <li>每位作者（含合著）仅能以一篇作品参与评奖，同人多稿按最高分处理。</li>
          <li>参赛者须为网站成员，且必须由作者本人发布，不承认匿名/代发参赛资格。</li>
          <li>投票规则与站内一致，作者不得给自己的作品投票。</li>
          <li>截稿后至计票结束前，仅允许纠错，不得做实质性改动。</li>
          <li>禁止自删条目与一切不正当竞争，违规则可能被取消资格、警告或进一步处理。</li>
        </ul>
      </div>
    </section>

    <section class="space-y-4">
      <div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 class="text-xl font-semibold text-neutral-900 dark:text-neutral-50">随机四篇</h2>
          <p class="text-sm text-neutral-500 dark:text-neutral-400">从“2026冬季征文”标签作品中随机抽取四篇，便于快速浏览。</p>
        </div>
        <button
          type="button"
          class="inline-flex items-center gap-1 rounded-full border border-neutral-200 px-3 py-1.5 text-xs font-medium text-neutral-600 transition hover:border-[var(--g-accent-border)] hover:text-[var(--g-accent)] dark:border-neutral-700 dark:text-neutral-300"
          @click="refreshHighlights"
          :disabled="entriesPending"
        >
          <LucideIcon name="RotateCw" class="h-3.5 w-3.5" />
          <span>换一批</span>
        </button>
      </div>
      <div v-if="entriesPending" class="rounded-lg border border-dashed border-neutral-200/60 bg-white/60 p-6 text-center text-sm text-neutral-500 dark:border-neutral-800/60 dark:bg-neutral-900/60 dark:text-neutral-400">
        正在加载参赛作品…
      </div>
      <div v-else-if="entriesError" class="rounded-lg border border-red-200 bg-red-50 p-5 text-sm text-red-600 dark:border-red-800 dark:bg-red-900/20 dark:text-red-300">
        加载参赛作品失败：{{ entriesError.message || entriesError }}
      </div>
      <div v-else-if="highlightCards.length === 0" class="rounded-lg border border-dashed border-neutral-200/60 bg-white/70 p-6 text-center text-sm text-neutral-500 dark:border-neutral-800/60 dark:bg-neutral-900/70 dark:text-neutral-400">
        暂未收录带有“2026冬季征文”标签的作品。
      </div>
      <div v-else class="grid gap-4 md:grid-cols-2">
        <PageCard v-for="(entry, idx) in highlightCards" :key="entry.wikidotId ?? entry.title ?? idx" size="lg" :p="entry" />
      </div>
    </section>

    <section class="space-y-4">
      <div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 class="text-xl font-semibold text-neutral-900 dark:text-neutral-50">全部参赛作品</h2>
          <p class="text-sm text-neutral-500 dark:text-neutral-400">
            当前共 {{ entriesCount }} 篇作品，已过滤中心页和竞赛中心页，可按发布时间或随机顺序浏览。
          </p>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <div class="inline-flex items-center gap-1 rounded-full border border-neutral-200 px-1 py-1 text-xs dark:border-neutral-700">
            <button
              type="button"
              class="rounded-full px-3 py-1 transition"
              :class="orderMode === 'created' ? 'bg-[var(--g-accent-soft)] text-[var(--g-accent)]' : 'text-neutral-500 dark:text-neutral-400'"
              @click="orderMode = 'created'"
            >
              按时间
            </button>
            <button
              type="button"
              class="rounded-full px-3 py-1 transition"
              :class="orderMode === 'random' ? 'bg-[var(--g-accent-soft)] text-[var(--g-accent)]' : 'text-neutral-500 dark:text-neutral-400'"
              @click="orderMode = 'random'"
            >
              随机
            </button>
          </div>
          <button
            v-if="orderMode === 'random'"
            type="button"
            class="inline-flex items-center gap-1 rounded-full border border-neutral-200 px-3 py-1.5 text-xs font-medium text-neutral-600 transition hover:border-[var(--g-accent-border)] hover:text-[var(--g-accent)] dark:border-neutral-700 dark:text-neutral-300"
            @click="reshuffleAll"
            :disabled="entriesPending"
          >
            <LucideIcon name="Shuffle" class="h-3.5 w-3.5" />
            <span>重新随机</span>
          </button>
        </div>
      </div>
      <div v-if="entriesPending" class="rounded-lg border border-dashed border-neutral-200/60 bg-white/60 p-6 text-center text-sm text-neutral-500 dark:border-neutral-800/60 dark:bg-neutral-900/60 dark:text-neutral-400">
        正在加载参赛作品…
      </div>
      <div v-else-if="entriesError" class="rounded-lg border border-red-200 bg-red-50 p-5 text-sm text-red-600 dark:border-red-800 dark:bg-red-900/20 dark:text-red-300">
        加载参赛作品失败：{{ entriesError.message || entriesError }}
      </div>
      <div v-else>
        <div v-if="displayedEntries.length === 0" class="rounded-lg border border-dashed border-neutral-200/60 bg-white/70 p-6 text-center text-sm text-neutral-500 dark:border-neutral-800/60 dark:bg-neutral-900/70 dark:text-neutral-400">
          暂未收录带有“2026冬季征文”标签的作品。
        </div>
        <div v-else class="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          <PageCard v-for="(entry, idx) in displayedEntries" :key="entry.wikidotId ?? entry.title ?? idx" size="md" :p="entry" />
        </div>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useAsyncData, useNuxtApp, useRuntimeConfig } from 'nuxt/app'
import LucideIcon from '~/components/LucideIcon.vue'
import PageCard from '~/components/PageCard.vue'
import { useViewerVotes } from '~/composables/useViewerVotes'
import { orderTags } from '~/composables/useTagOrder'
import { normalizeBffBase, resolveAssetUrl } from '~/utils/assetUrl'

definePageMeta({ title: '2026冬季征文：循环', key: 'winter-contest-2026' })

const isClient = typeof window !== 'undefined'
const CONTEST_TAG = '2026冬季征文'
const contestTag = ref(CONTEST_TAG)

const runtimeConfig = useRuntimeConfig()
const bffBase = normalizeBffBase((runtimeConfig?.public as any)?.bffBase)
const HERO_ASSET_PATH = '/page-images/39867'
const HERO_FALLBACK_URL = 'https://05command-cn.wdfiles.com/local--files/collab%3Aimage-collection/2026wintercon-banner.jpg'
const heroImageLowSrc = resolveAssetUrl(HERO_ASSET_PATH, bffBase, { variant: 'low' })
const heroImageFullSrc = resolveAssetUrl(HERO_ASSET_PATH, bffBase) || HERO_FALLBACK_URL
const heroImageSrc = ref<string | null>(heroImageLowSrc || heroImageFullSrc || null)
const heroImageVisible = ref(Boolean(heroImageSrc.value))

function onHeroError() {
  if (heroImageSrc.value !== heroImageFullSrc && heroImageFullSrc) {
    heroImageSrc.value = heroImageFullSrc
    return
  }
  heroImageVisible.value = false
}

const milestones = [
  {
    key: 'submission-open',
    label: '征文开始',
    iso: '2026-02-17T00:00:00+08:00',
    display: '北京时间 2026年2月17日 00时00分'
  },
  {
    key: 'submission-deadline',
    label: '征文截止',
    iso: '2026-03-03T23:59:00+08:00',
    display: '北京时间 2026年3月3日 23时59分'
  },
  {
    key: 'voting-deadline',
    label: '计票截止',
    iso: '2026-03-10T23:59:00+08:00',
    display: '北京时间 2026年3月10日 23时59分'
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

const { data: entriesData, pending: entriesPendingRef, error: entriesErrorRef } = await useAsyncData(
  'winter-contest-2026-entries',
  async () => {
    const resp = await $bff('/search/pages', {
      params: {
        tags: [contestTag.value],
        limit: 400,
        includeSnippet: true,
        includeDate: true
      }
    })
    if (Array.isArray(resp?.results)) return resp.results as Entry[]
    if (Array.isArray(resp)) return resp as Entry[]
    return [] as Entry[]
  },
  { watch: [contestTag] }
)

const entriesPending = computed(() => Boolean(entriesPendingRef.value))
const entriesError = computed(() => entriesErrorRef.value as Error | null)
const rawEntries = computed<Entry[]>(() => entriesData.value ?? [])

function hasExactTag(tags: string[] | undefined, target: string) {
  if (!Array.isArray(tags) || tags.length === 0) return false
  const lower = target.toLowerCase()
  return tags.some(tag => tag.toLowerCase() === lower)
}

const filteredEntries = computed<Entry[]>(() =>
  rawEntries.value.filter(entry =>
    !entry.isDeleted &&
    !hasExactTag(entry.tags, '待删除') &&
    !hasExactTag(entry.tags, '中心') &&
    !hasExactTag(entry.tags, '竞赛')
  )
)
const entriesCount = computed(() => filteredEntries.value.length)

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

function shuffle<T>(source: T[]): T[] {
  const arr = [...source]
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
  return arr
}

const highlightEntries = ref<Entry[]>([])
const randomEntries = ref<Entry[]>([])

function resampleHighlights() {
  const list = filteredEntries.value
  if (!Array.isArray(list) || list.length === 0) {
    highlightEntries.value = []
    return
  }
  highlightEntries.value = shuffle(list).slice(0, 4)
}

function reshuffleEntries() {
  const list = filteredEntries.value
  if (!Array.isArray(list) || list.length === 0) {
    randomEntries.value = []
    return
  }
  randomEntries.value = shuffle(list)
}

const highlightCards = computed(() => highlightEntries.value.map(normalizeEntry))

const sortedByCreated = computed(() => {
  const list = [...filteredEntries.value]
  list.sort((a, b) => toTimestamp(b) - toTimestamp(a))
  return list
})

const entriesByCreated = computed(() => sortedByCreated.value.map(normalizeEntry))
const entriesByRandom = computed(() => randomEntries.value.map(normalizeEntry))

const orderMode = ref<'created' | 'random'>('created')
const displayedEntries = computed(() => (orderMode.value === 'created' ? entriesByCreated.value : entriesByRandom.value))

watch(filteredEntries, list => {
  if (!isClient) return
  if (!Array.isArray(list) || list.length === 0) {
    highlightEntries.value = []
    randomEntries.value = []
    return
  }
  resampleHighlights()
  reshuffleEntries()
})

onMounted(() => {
  const list = filteredEntries.value
  if (Array.isArray(list) && list.length > 0) {
    resampleHighlights()
    reshuffleEntries()
  }
})

watch(
  () => [entriesByCreated.value, entriesByRandom.value],
  ([created, random]) => {
    if (!isClient) return
    const combined: any[] = []
    const seen = new Set<number>()
    for (const arr of [created, random]) {
      if (!Array.isArray(arr)) continue
      for (const item of arr) {
        const id = Number(item?.wikidotId)
        if (!Number.isInteger(id)) continue
        if (seen.has(id)) continue
        seen.add(id)
        combined.push(item)
      }
    }
    if (combined.length > 0) {
      void hydrateViewerVotes(combined)
    }
  },
  { immediate: true, flush: 'post' }
)

function refreshHighlights() {
  if (rawEntries.value.length === 0) return
  resampleHighlights()
}

function reshuffleAll() {
  if (rawEntries.value.length === 0) return
  reshuffleEntries()
}
</script>
