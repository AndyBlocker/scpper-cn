<template>
  <article
    class="relative overflow-hidden rounded-[28px] border border-white/60 dark:border-white/10 bg-white/75 dark:bg-neutral-900/70 shadow-[0_28px_72px_-40px_rgba(15,23,42,0.58)] backdrop-blur-2xl transition-colors"
    :class="cardRadiusClass"
  >
    <div class="pointer-events-none absolute inset-0">
      <div class="absolute inset-y-[-20%] right-[-25%] h-[140%] w-3/5 bg-gradient-to-br from-[rgba(var(--accent),0.22)] via-transparent to-transparent blur-[120px]" />
      <div class="absolute top-0 left-0 h-1/2 w-full bg-gradient-to-b from-white/50 via-transparent to-transparent dark:from-white/10" />
    </div>
    <div class="relative flex flex-col gap-6" :class="paddingClass">
      <div class="flex items-start gap-4">
        <UserAvatar
          :wikidot-id="user.wikidotId || undefined"
          :name="user.displayName"
          :size="avatarSize"
          class="rounded-3xl border border-white/80 dark:border-white/15 bg-white/60 p-1 shadow-[0_12px_36px_-18px_rgba(15,23,42,0.45)]"
        />
        <div class="min-w-0 space-y-2">
          <div class="flex flex-wrap items-center gap-3">
            <component
              :is="profileUrl ? NuxtLink : 'span'"
              :to="profileUrl || undefined"
              class="font-semibold text-neutral-900 dark:text-neutral-50 tracking-tight"
              :class="nameClass"
            >
              {{ user.displayName || '未命名作者' }}
            </component>
            <span v-if="user.rank != null" class="inline-flex items-center rounded-full bg-[rgba(var(--accent),0.16)] px-3 py-1 text-[11px] font-semibold text-[rgb(var(--accent-strong))] uppercase tracking-[0.26em]">
              #{{ user.rank }}
            </span>
          </div>
          <p v-if="user.subtitle" class="text-sm text-neutral-500 dark:text-neutral-400 truncate">{{ user.subtitle }}</p>
          <p v-if="lastActiveText" class="text-xs text-neutral-400 dark:text-neutral-500">最近活跃 {{ lastActiveText }}</p>
        </div>
      </div>

      <div class="grid w-full" :class="metricsGridClass">
        <div
          v-for="metric in metricTiles"
          :key="metric.label"
          class="flex flex-col gap-1.5 rounded-3xl border border-white/70 bg-white/70 px-4 py-4 backdrop-blur-lg shadow-[inset_0_1px_0_rgba(255,255,255,0.55)] dark:border-white/10 dark:bg-white/5"
        >
          <span class="text-[11px] uppercase tracking-[0.18em] text-neutral-500 dark:text-neutral-400">{{ metric.label }}</span>
          <span class="text-xl font-semibold text-neutral-900 dark:text-neutral-50 tabular-nums">{{ metric.value }}</span>
        </div>
      </div>

      <div v-if="sparkPoints" class="relative h-24 w-full overflow-hidden rounded-2xl border border-white/70 dark:border-white/10 bg-white/70 dark:bg-white/5">
        <svg :width="'100%'" height="96" viewBox="0 0 320 96" preserveAspectRatio="none">
          <defs>
            <linearGradient :id="`apple-user-${user.wikidotId || user.displayName}`" x1="0%" y1="0%" x2="0%" y2="100%">
              <stop offset="0%" :style="{ stopColor: accentColor, stopOpacity: 0.32 }" />
              <stop offset="100%" :style="{ stopColor: accentColor, stopOpacity: 0 }" />
            </linearGradient>
          </defs>
          <polyline :points="sparkArea" :fill="`url(#apple-user-${user.wikidotId || user.displayName})`" stroke="none" />
          <polyline :points="sparkLine" fill="none" :stroke="accentColor" stroke-width="2.2" stroke-linecap="round" />
        </svg>
      </div>

      <div class="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div class="flex flex-wrap gap-2 text-xs text-neutral-500 dark:text-neutral-400">
          <span v-for="tag in resolvedCategoryRanks" :key="tag.name" class="inline-flex items-center gap-2 rounded-full border border-white/70 dark:border-white/10 bg-white/70 dark:bg-white/5 px-3 py-1">
            <span class="text-neutral-600 dark:text-neutral-200">{{ tag.name }}</span>
            <span class="font-semibold text-[rgb(var(--accent-strong))]">#{{ tag.rank }}</span>
          </span>
        </div>
        <NuxtLink
          v-if="profileUrl"
          :to="profileUrl"
          class="inline-flex items-center gap-2 self-start rounded-full bg-[rgba(var(--accent),0.18)] px-4 py-2 text-sm font-medium text-[rgb(var(--accent-strong))] hover:bg-[rgba(var(--accent),0.26)]"
        >
          查看档案
          <span aria-hidden="true">→</span>
        </NuxtLink>
      </div>
    </div>
  </article>
</template>

<script setup lang="ts">
import { computed, resolveComponent } from 'vue'
import UserAvatar from '~/components/UserAvatar.vue'

interface AppleTotals {
  totalRating?: number | null
  avgRating?: number | null
  works?: number | null
  votesUp?: number | null
  votesDown?: number | null
}

interface AppleCategoryRank {
  name: string
  rank: number
}

interface AppleUser {
  wikidotId?: number | string | null
  displayName?: string | null
  subtitle?: string | null
  rank?: number | null
  totals?: AppleTotals | null
  categoryRanks?: AppleCategoryRank[] | null
  sparkline?: number[] | null
  lastActiveISO?: string | null
  profileUrl?: string | null
}

const NuxtLink = resolveComponent('NuxtLink') as any

const props = withDefaults(defineProps<{
  user: AppleUser
  accentRgb?: string
  size?: 'lg' | 'md' | 'sm'
}>(), {
  accentRgb: '82 96 255',
  size: 'lg'
})

const accentColor = computed(() => `rgb(${props.accentRgb})`)

const avatarSize = computed(() => {
  if (props.size === 'sm') return 64
  if (props.size === 'md') return 72
  return 80
})

const paddingClass = computed(() => {
  if (props.size === 'sm') return 'p-6'
  if (props.size === 'md') return 'p-7'
  return 'p-8'
})

const cardRadiusClass = computed(() => (props.size === 'sm' ? 'rounded-[24px]' : props.size === 'md' ? 'rounded-[26px]' : 'rounded-[28px]'))

const nameClass = computed(() => {
  if (props.size === 'sm') return 'text-[20px]'
  if (props.size === 'md') return 'text-[22px]'
  return 'text-[24px]'
})

const totalsSafe = computed(() => ({
  totalRating: Number(props.user.totals?.totalRating ?? 0),
  avgRating: Number(props.user.totals?.avgRating ?? NaN),
  works: Number(props.user.totals?.works ?? 0),
  votesUp: Number(props.user.totals?.votesUp ?? 0),
  votesDown: Number(props.user.totals?.votesDown ?? 0)
}))

const avgRatingText = computed(() => {
  const avg = totalsSafe.value.avgRating
  if (Number.isFinite(avg) && avg >= 0) return avg.toFixed(1)
  if (totalsSafe.value.works > 0) return (totalsSafe.value.totalRating / totalsSafe.value.works).toFixed(1)
  return '—'
})

const metricsGridClass = computed(() => {
  if (props.size === 'sm') return 'grid-cols-2 gap-3'
  if (props.size === 'md') return 'grid-cols-3 gap-4'
  return 'grid-cols-3 gap-5'
})

const formatMetric = (value: number | string) => {
  if (typeof value === 'number' && Number.isFinite(value)) return value.toLocaleString('zh-CN')
  return value ?? '—'
}

const metricTiles = computed(() => [
  { label: '总评分', value: formatMetric(totalsSafe.value.totalRating) },
  { label: '平均分', value: avgRatingText.value },
  { label: '作品数', value: formatMetric(totalsSafe.value.works) },
  { label: '支持票', value: formatMetric(totalsSafe.value.votesUp) },
  { label: '反对票', value: formatMetric(totalsSafe.value.votesDown) }
])

const profileUrl = computed(() => props.user.profileUrl || (props.user.wikidotId != null ? `/user/${props.user.wikidotId}` : null))

function formatRelativeTime(iso?: string | null) {
  if (!iso) return ''
  const parsed = Date.parse(iso)
  if (Number.isNaN(parsed)) return ''
  const diff = Date.now() - parsed
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  const days = Math.floor(diff / 86_400_000)
  if (days < 30) return `${days} 天前`
  const d = new Date(parsed)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const lastActiveText = computed(() => formatRelativeTime(props.user.lastActiveISO))

function computeSpark(nums?: number[] | null) {
  if (!nums || nums.length < 2) return { line: null as string | null, area: null as string | null }
  const recent = nums.slice(-24)
  const minY = Math.min(...recent)
  const maxY = Math.max(...recent)
  const range = maxY - minY || 1
  const points: string[] = []
  recent.forEach((value, index) => {
    const x = 10 + (300 * index) / (recent.length - 1)
    const y = 80 - (70 * (value - minY)) / range
    points.push(`${x.toFixed(1)},${y.toFixed(1)}`)
  })
  const line = points.join(' ')
  const area = `${line} 310,90 10,90`
  return { line, area }
}

const sparkComputed = computed(() => computeSpark(props.user.sparkline))
const sparkLine = computed(() => sparkComputed.value.line)
const sparkArea = computed(() => sparkComputed.value.area)
const sparkPoints = computed(() => sparkComputed.value.line)

const resolvedCategoryRanks = computed(() => (props.user.categoryRanks || []).slice(0, 4))

</script>
