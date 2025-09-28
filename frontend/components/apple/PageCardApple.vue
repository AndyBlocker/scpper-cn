<template>
  <article
    class="relative overflow-hidden rounded-[32px] border border-white/60 dark:border-white/10 bg-white/70 dark:bg-neutral-900/70 shadow-[0_32px_80px_-40px_rgba(15,23,42,0.5)] backdrop-blur-2xl transition-colors"
    :class="cardSurfaceClass"
  >
    <div class="pointer-events-none absolute inset-0">
      <div class="absolute inset-y-[-30%] right-[-20%] h-[160%] w-2/3 bg-gradient-to-br from-[rgba(var(--accent),0.26)] via-transparent to-transparent blur-3xl" />
      <div class="absolute top-0 left-0 h-full w-1/2 bg-gradient-to-b from-white/40 via-white/10 to-transparent dark:from-white/10 dark:via-transparent" />
    </div>
    <div class="relative flex flex-col gap-6" :class="paddingClass">
      <header class="flex items-center justify-between text-[11px] uppercase tracking-[0.32em] text-neutral-400 dark:text-neutral-500">
        <span class="inline-flex items-center gap-2">
          <span class="h-1.5 w-1.5 rounded-full" :style="{ background: accentColor }" />
          {{ heroLabel }}
        </span>
        <span>{{ dateText }}</span>
      </header>

      <div class="space-y-5">
        <component
          :is="page.url ? NuxtLink : 'h3'"
          :to="page.url || undefined"
          class="block font-semibold text-neutral-900 dark:text-neutral-50 tracking-tight transition-colors"
          :class="titleClass"
        >
          {{ page.title || '未命名页面' }}
        </component>
        <p v-if="page.excerpt" :class="excerptClass" class="text-neutral-600 dark:text-neutral-300 max-w-3xl">
          {{ page.excerpt }}
        </p>
        <p v-else class="text-sm text-neutral-500 dark:text-neutral-400">没有可用摘要。</p>
      </div>

      <div v-if="displayTags.length" class="flex flex-wrap gap-2">
        <span
          v-for="tag in displayTags"
          :key="tag"
          class="inline-flex items-center gap-2 rounded-full border border-white/70 dark:border-white/10 bg-white/80 dark:bg-white/5 px-3 py-1 text-[11px] font-medium text-neutral-600 dark:text-neutral-200"
        >
          #{{ tag }}
        </span>
      </div>

      <div class="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div class="flex items-center gap-4 min-w-0">
          <div class="flex -space-x-4">
            <div
              v-for="author in leadingAuthors"
              :key="author.name"
              class="relative flex h-10 w-10 items-center justify-center rounded-full border border-white/70 dark:border-white/10 bg-gradient-to-br from-white/90 via-white/50 to-white/20 text-[11px] font-semibold uppercase text-neutral-700 dark:text-neutral-100 shadow-[0_6px_18px_rgba(15,23,42,0.18)]"
            >
              {{ initials(author.name) }}
            </div>
            <div
              v-if="authorOverflow > 0"
              class="relative flex h-10 w-10 items-center justify-center rounded-full border border-white/70 dark:border-white/10 bg-gradient-to-br from-white/70 via-white/30 to-white/10 text-[11px] font-semibold text-neutral-600 dark:text-neutral-200"
            >
              +{{ authorOverflow }}
            </div>
          </div>
          <div class="min-w-0 space-y-1">
            <div class="truncate text-sm font-medium text-neutral-800 dark:text-neutral-200">{{ authorHeadline }}</div>
            <div class="text-xs text-neutral-500 dark:text-neutral-400">{{ authorCaption }}</div>
          </div>
        </div>

        <div :class="['flex flex-wrap items-center gap-4', metricsGapClass]">
          <div class="flex items-center gap-2 text-sm text-neutral-700 dark:text-neutral-300">
            <span class="text-lg font-semibold tabular-nums text-neutral-900 dark:text-neutral-100">{{ ratingText }}</span>
            <span class="text-[11px] uppercase tracking-[0.24em] text-neutral-400 dark:text-neutral-500">评分</span>
          </div>
          <div class="flex items-center gap-2 text-sm text-neutral-700 dark:text-neutral-300">
            <span class="text-lg font-semibold tabular-nums text-neutral-900 dark:text-neutral-100">{{ commentText }}</span>
            <span class="text-[11px] uppercase tracking-[0.24em] text-neutral-400 dark:text-neutral-500">评论</span>
          </div>
          <NuxtLink
            v-if="page.url"
            :to="page.url"
            class="inline-flex items-center gap-2 rounded-full bg-[rgba(var(--accent),0.18)] px-4 py-2 text-sm font-medium text-[rgb(var(--accent-strong))] backdrop-blur transition hover:bg-[rgba(var(--accent),0.26)]"
          >
            查看页面
            <span aria-hidden="true">→</span>
          </NuxtLink>
        </div>
      </div>
    </div>
  </article>
</template>

<script setup lang="ts">
import { computed, resolveComponent } from 'vue'

interface AppleAuthor {
  name: string
  url?: string | null
}

interface ApplePage {
  title?: string | null
  excerpt?: string | null
  tags?: string[] | null
  authorObjs?: AppleAuthor[] | null
  createdDate?: string | null
  rating?: number | null
  commentCount?: number | null
  url?: string | null
}

const NuxtLink = resolveComponent('NuxtLink') as any

const props = withDefaults(defineProps<{
  page: ApplePage
  accentRgb?: string
  size?: 'lg' | 'md' | 'sm'
}>(), {
  accentRgb: '82 96 255',
  size: 'lg'
})

const accentColor = computed(() => `rgb(${props.accentRgb})`)
const displayTags = computed(() => props.page.tags?.filter(Boolean).slice(0, 5) ?? [])
const heroLabel = computed(() => displayTags.value[0] ?? '精选页面')
const authorList = computed(() => props.page.authorObjs?.filter((a) => a && a.name) ?? [])
const leadingAuthors = computed(() => authorList.value.slice(0, 3))
const authorOverflow = computed(() => Math.max(0, authorList.value.length - 3))

const authorHeadline = computed(() => {
  if (!authorList.value.length) return '匿名作者'
  if (authorList.value.length === 1) return authorList.value[0].name
  if (authorList.value.length === 2) return `${authorList.value[0].name} 与 ${authorList.value[1].name}`
  return `${authorList.value[0].name} 等 ${authorList.value.length} 位作者`
})

const authorCaption = computed(() => {
  if (!authorList.value.length) return '暂无作者信息'
  if (authorList.value.length === 1) return '独家创作'
  if (authorList.value.length === 2) return '双作者共创'
  return `${authorList.value.length} 位作者协同创作`
})

const dateText = computed(() => {
  const iso = props.page.createdDate
  if (!iso) return '更新中'
  const parsed = new Date(iso)
  if (Number.isNaN(parsed.getTime())) return '更新中'
  return parsed.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' })
})

const ratingText = computed(() => (props.page.rating ?? '—'))
const commentText = computed(() => (props.page.commentCount ?? '—'))

const isMedium = computed(() => props.size === 'md')
const isSmall = computed(() => props.size === 'sm')

const paddingClass = computed(() => {
  if (isSmall.value) return 'p-6 sm:p-6'
  if (isMedium.value) return 'p-7 sm:p-8'
  return 'p-8 sm:p-10'
})

const titleClass = computed(() => {
  if (isSmall.value) return 'text-[26px] sm:text-[28px]'
  if (isMedium.value) return 'text-[30px] sm:text-[34px]'
  return 'text-[32px] sm:text-[38px]'
})

const excerptClass = computed(() => (isSmall.value ? 'text-sm leading-relaxed' : 'text-base leading-relaxed'))
const metricsGapClass = computed(() => (isSmall.value ? 'gap-3' : 'gap-4'))
const cardSurfaceClass = computed(() => (isSmall.value ? 'rounded-[26px]' : isMedium.value ? 'rounded-[30px]' : 'rounded-[32px]'))

function initials(name: string) {
  const segments = name.trim().split(/\s+/).filter(Boolean)
  if (!segments.length) return 'S'
  if (segments.length === 1) {
    const chars = [...segments[0]]
    if (chars.length >= 2) return (chars[0] + chars[1]).toUpperCase()
    return chars[0].toUpperCase()
  }
  return (segments[0][0] + segments[segments.length - 1][0]).toUpperCase()
}
</script>
