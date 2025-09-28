<template>
    <component
      :is="linkComponent"
      :to="to || undefined"
      :class="rootClass"
      :aria-label="displayTitle || 'Page'"
    >
      <!-- Header: Title (lg only); md title inline; sm has compact header -->
      <div v-if="variant === 'lg'" class="flex items-start gap-3">
        <div class="font-semibold text-neutral-900 dark:text-neutral-100 truncate leading-snug"
             :class="['text-base line-clamp-2', (displayDate ? 'pr-24' : '')]"
             :title="displayTitle">
          {{ displayTitle || 'Untitled' }}
        </div>
      </div>

      <!-- sm header -->
      <div v-else-if="variant === 'sm'" class="flex items-center justify-between gap-2">
        <div class="truncate text-[13px] font-medium text-neutral-900 dark:text-neutral-100" :title="displayTitle">
          {{ displayTitle || 'Untitled' }}
        </div>
        <div v-if="displayDate" class="text-[11px] text-neutral-500 dark:text-neutral-400 whitespace-nowrap">
          {{ displayDate }}
        </div>
      </div>

      <!-- lg top-right date overlay (avoid overlap with deleted badge) -->
      <div v-if="variant === 'lg' && displayDate && !isDeleted" class="absolute top-4 right-3 text-xs text-neutral-500 dark:text-neutral-400 whitespace-nowrap leading-6">
        {{ displayDate }}
      </div>
  
      <!-- ===== LG =====  richer, airy left-to-right stack -->
      <div v-if="variant === 'lg'" class="flex flex-col gap-2">
        <!-- authors -->
        <div v-if="authorsVisible.length" class="flex items-center flex-wrap gap-1.5">
          <UserCard
            v-for="(a,idx) in authorsVisible"
            :key="a.name + idx"
            size="S"
            :display-name="a.name"
            :to="a.url || undefined"
            :wikidot-id="(parseUserIdFromUrl(a.url) ?? 0)"
            bare
          />
          <span v-if="authorsMoreCount>0" class="text-xs text-neutral-400 dark:text-neutral-500">+{{ authorsMoreCount }}</span>
        </div>
  
        <!-- tags (one-line clamp, subtle) -->
        <div v-if="internalTags.length" class="text-[11px] text-neutral-500 dark:text-neutral-400 flex flex-nowrap gap-1 overflow-hidden whitespace-nowrap">
          <span v-for="t in visibleTags" :key="t"
                class="inline-block px-1.5 py-0.5 rounded-full bg-neutral-50 dark:bg-neutral-800/60 text-[rgb(var(--accent))] dark:text-[rgb(var(--accent))]">
            #{{ t }}
          </span>
          <span v-if="tagsMoreCount>0" class="text-[10px] text-neutral-500 dark:text-neutral-400">+{{ tagsMoreCount }}</span>
        </div>
  
        <!-- excerpt (max 3 lines) -> enforce uniform height across cards -->
        <div>
          <div class="h-[48px] overflow-hidden flex items-center">
            <p v-if="excerpt" class="text-[12px] leading-4 text-neutral-600 dark:text-neutral-400 line-clamp-3 italic border-l border-[rgba(var(--accent),0.3)] pl-2">
              "{{ excerpt }}"
            </p>
          </div>
        </div>
  
        <!-- metrics row (Rating / 评论 / 争议) -->
        <div class="grid grid-cols-3 gap-2 mt-1">
          <div class="stat-tile">
            <div class="stat-label">Rating</div>
            <div class="stat-value">{{ displayRating }}</div>
          </div>
          <div class="stat-tile">
            <div class="stat-label">评论</div>
            <div class="stat-value">{{ displayComments }}</div>
          </div>
          <div class="stat-tile">
            <div class="stat-label">争议</div>
            <div class="stat-value">{{ controversyText }}</div>
          </div>
        </div>
  
        <!-- sparkline -->
        <div v-if="computedSparkLine && computedSparkPoints && !hasFewVotes"
             class="mt-1 h-12 border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-800 rounded flex items-center justify-center">
          <svg :width="'100%'" height="48" viewBox="0 0 300 48" preserveAspectRatio="none">
            <defs>
              <linearGradient :id="`gradient-${wikidotId || 'pg'}`" x1="0%" y1="0%" x2="0%" y2="100%">
                <stop offset="0%" :style="{ stopColor: 'rgb(var(--accent))', stopOpacity: 0.28 }" />
                <stop offset="100%" :style="{ stopColor: 'rgb(var(--accent))', stopOpacity: 0 }" />
              </linearGradient>
            </defs>
            <polyline :points="computedSparkPoints || ''" :fill="`url(#gradient-${wikidotId || 'pg'})`" stroke="none" />
            <polyline :points="computedSparkLine || ''" fill="none" :stroke="'rgb(var(--accent))'" stroke-width="1.5" stroke-linecap="round" />
          </svg>
        </div>
        <div v-else class="mt-1 h-12 border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-800 rounded flex items-center justify-center">
          <span class="text-[12px] text-neutral-400 dark:text-neutral-500">暂无趋势</span>
        </div>
      </div>
  
      <!-- ===== MD ===== tighter two-column; right becomes soft stat grid -->
      <div v-if="variant === 'md'" class="grid grid-cols-[minmax(0,1fr)_164px] gap-3 items-start">
        <div class="flex flex-col gap-1.5 min-w-0">
          <!-- inline title inside left column -->
          <div class="font-semibold text-neutral-900 dark:text-neutral-100 text-[15px] leading-snug truncate" :title="displayTitle">
            {{ displayTitle || 'Untitled' }}
          </div>
          <div v-if="authorsVisible.length" class="flex items-center flex-wrap gap-1.5">
            <UserCard v-for="(a,idx) in authorsVisible" :key="a.name+idx" size="S" :display-name="a.name" :to="a.url || undefined" :wikidot-id="(parseUserIdFromUrl(a.url) ?? 0)" bare />
            <span v-if="authorsMoreCount>0" class="text-xs text-neutral-400 dark:text-neutral-500">+{{ authorsMoreCount }}</span>
          </div>
          <div v-if="internalTags.length" class="text-[11px] text-neutral-500 dark:text-neutral-400 flex flex-nowrap gap-1 overflow-hidden whitespace-nowrap">
            <span v-for="t in visibleTags" :key="t" class="inline-block px-1.5 py-0.5 rounded-full bg-neutral-50 dark:bg-neutral-800/60 text-[rgb(var(--accent))] dark:text-[rgb(var(--accent))]">#{{ t }}</span>
            <span v-if="tagsMoreCount>0" class="text-[10px] text-neutral-500 dark:text-neutral-400">+{{ tagsMoreCount }}</span>
          </div>
          <div v-if="snippetHtml" class="text-[12px] text-neutral-600 dark:text-neutral-400 line-clamp-3" v-html="snippetHtml"></div>
        </div>
  
        <!-- right stats 2x2 + date -->
        <div class="grid grid-cols-2 gap-1.5 items-start w-[164px]">
          <div v-if="displayDate" class="col-span-2 text-[11px] text-neutral-500 dark:text-neutral-400 text-right mb-1">
            <span v-if="!isDeleted">{{ displayDate }}</span>
            <span v-else class="invisible">0000-00-00</span>
          </div>
          <div class="stat-soft">
            <div class="stat-label">Rating</div>
            <div class="stat-num">{{ displayRating }}</div>
          </div>
          <div class="stat-soft">
            <div class="stat-label">评论</div>
            <div class="stat-num">{{ displayComments }}</div>
          </div>
          <div class="stat-soft">
            <div class="stat-label">Wilson</div>
            <div class="stat-num">{{ wilsonText }}</div>
          </div>
          <div class="stat-soft">
            <div class="stat-label">争议</div>
            <div class="stat-num">{{ controversyText }}</div>
          </div>
        </div>
      </div>
  
      <!-- ===== SM ===== title + mini authors + micro stats (no extra data) -->
      <div v-if="variant === 'sm'" class="flex flex-col gap-1 mt-0.5">
        <div v-if="authorsVisible.length" class="flex items-center flex-wrap gap-1.5">
          <UserCard v-for="(a,idx) in authorsVisible" :key="a.name+idx" size="S" :display-name="a.name" :to="a.url || undefined" :wikidot-id="(parseUserIdFromUrl(a.url) ?? 0)" bare />
          <span v-if="authorsMoreCount>0" class="text-[11px] text-neutral-400 dark:text-neutral-500">+{{ authorsMoreCount }}</span>
        </div>
        <div v-if="displayDate && !isDeleted" class="text-[11px] text-neutral-500 dark:text-neutral-400 whitespace-nowrap">{{ displayDate }}</div>
      </div>
  
      <!-- deletion mark -->
      <div v-if="isDeleted" class="absolute top-2 right-2 z-10 text-[10px] px-2 py-0.5 rounded-full bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400">
        已删除<span v-if="deletedDate"> · {{ deletedDate }}</span>
      </div>
    </component>
  </template>
  
  <script setup lang="ts">
  import { computed, resolveComponent } from 'vue'
  
  interface PageLike {
    wikidotId?: number | string
    title?: string
    tags?: string[]
    authors?: string
    createdDate?: string
    deletedAt?: string | null
    excerpt?: string
    rating?: number
    voteCount?: number
    commentCount?: number
    controversy?: number | string
    wilson95?: number
    sparkLine?: string | null
    sparkPoints?: string | null
    snippetHtml?: string | null
    isDeleted?: boolean
  }
  
  type PageCardSize = 'lg' | 'md' | 'sm' | 'L' | 'M' | 'S'
  
  interface Props {
    p?: PageLike
    size?: PageCardSize
    to?: string | null
    wikidotId?: number | string
    title?: string
    url?: string
    authors?: Array<{ name: string; url?: string }>
    dateISO?: string
    tags?: string[]
    excerpt?: string
    rating?: number
    voteCount?: number
    comments?: number
    controversy?: number | string
    wilson95?: number
    sparkline?: number[]
    sparkLine?: string | null
    sparkPoints?: string | null
    snippetHtml?: string | null
    badge?: 'new' | 'hot' | null
    isDeleted?: boolean
  }
  
  const props = defineProps<Props>()
  
  const variant = computed<'lg'|'md'|'sm'>(() => {
    const s = props.size || 'md'
    if (s === 'L') return 'lg'
    if (s === 'M') return 'md'
    if (s === 'S') return 'sm'
    return s as 'lg'|'md'|'sm'
  })
  
  const wikidotId = computed(() => props.p?.wikidotId ?? props.wikidotId)
  const displayTitle = computed(() => props.title ?? props.p?.title ?? '')
  const internalTags = computed<string[]>(() => (props.tags ?? props.p?.tags ?? []).filter(Boolean))
  const createdDate = computed(() => (props as any).dateISO ?? (props as any).dateIso ?? props.p?.createdDate ?? '')
  const excerpt = computed(() => props.excerpt ?? props.p?.excerpt ?? '')
  const controversy = computed(() => props.controversy ?? props.p?.controversy)
  const snippetHtml = computed(() => props.p?.snippetHtml ?? props.snippetHtml ?? null)
  const isDeleted = computed(() => Boolean(props.p?.isDeleted ?? props.isDeleted))
  const deletedDate = computed(() => {
    const raw = (props.p as any)?.deletedAt
    if (!raw) return ''
    const d = new Date(raw)
    return isNaN(d.getTime()) ? '' : d.toISOString().slice(0,10)
  })
  
  const displayRating = computed(() => Number(props.rating ?? props.p?.rating ?? 0) || 0)
  const displayComments = computed(() => Number(props.comments ?? props.p?.commentCount ?? (props.p as any)?.revisionCount ?? 0) || 0)
  const voteCountVal = computed(() => {
    const v: unknown = (props as any).voteCount ?? (props.p as any)?.voteCount
    const num = Number(v)
    return Number.isFinite(num) ? num : NaN
  })
  const hasFewVotes = computed(() => Number.isFinite(voteCountVal.value) ? voteCountVal.value < 10 : false)
  
  const authorsList = computed<Array<{ name: string; url?: string }>>(() => {
    if (Array.isArray(props.authors)) return props.authors
    const s = props.p?.authors
    if (typeof s === 'string' && s.trim()) {
      return s.split(/[、,]/).map(x => ({ name: x.trim() })).filter(a => a.name)
    }
    return []
  })
  function estimateCountByCharBudget(items: string[], budget: number, minItems: number, maxItems: number, perItemPadding = 2): number {
    if (!Array.isArray(items) || items.length === 0) return 0
    let used = 0
    let count = 0
    const upper = Math.min(maxItems, items.length)
    for (let i = 0; i < upper; i++) {
      const next = items[i]
      const add = (next?.length || 0) + perItemPadding
      if (used + add > budget) break
      used += add
      count++
    }
    return Math.max(minItems, Math.min(upper, count))
  }
  const authorsVisibleCount = computed(() => {
    const names = authorsList.value.map(a => a.name || '')
    if (variant.value === 'lg') return estimateCountByCharBudget(names, 28, 2, 4, 2)
    if (variant.value === 'md') return Math.min(2, authorsList.value.length)
    return estimateCountByCharBudget(names, 18, 1, 2, 2)
  })
  const authorsVisible = computed(() => authorsList.value.slice(0, authorsVisibleCount.value))
  const authorsMoreCount = computed(() => Math.max(0, authorsList.value.length - authorsVisibleCount.value))
  
  const visibleTagsCount = computed(() => {
    const tags = internalTags.value
    if (!tags.length) return 0
    if (variant.value === 'lg') return estimateCountByCharBudget(tags, 36, 2, 6, 1)
    if (variant.value === 'md') return estimateCountByCharBudget(tags, 20, 1, 4, 1)
    return 0
  })
  const visibleTags = computed(() => internalTags.value.slice(0, visibleTagsCount.value))
  const tagsMoreCount = computed(() => Math.max(0, internalTags.value.length - visibleTagsCount.value))
  
  const displayDate = computed(() => createdDate.value)
  const wilsonVal = computed(() => {
    const v: unknown = (props as any).wilson95 ?? (props.p as any)?.wilson95 ?? undefined
    const num = Number(v)
    return Number.isFinite(num) && num >= 0 ? num : NaN
  })
  const wilsonText = computed(() => Number.isFinite(wilsonVal.value) ? (wilsonVal.value * 100).toFixed(1) + '%' : '—')
  
  function parseUserIdFromUrl(url?: string) {
    if (!url) return undefined
    const m = url.match(/\/(?:user|users)\/(\d+)/)
    return m ? Number(m[1]) : undefined
  }
  
  const to = computed(() => {
    if (props.to != null) return props.to
    if (props.url && props.url.startsWith('/')) return props.url
    const id = wikidotId.value
    return id != null ? `/page/${id}` : null
  })
  
  const linkComponent = computed(() => (to.value ? (resolveComponent('NuxtLink') as any) : 'div'))
  
  // spark helper
  function computeSparkFromNumbers(nums?: number[] | null) {
    if (!nums || nums.length < 2) return { line: null as string | null, area: null as string | null }
    const recent = nums.slice(-30)
    const ys = recent
    const minY = Math.min(...ys)
    const maxY = Math.max(...ys)
    const rangeY = maxY - minY || 1
    const n = ys.length
    const points: string[] = []
    for (let i = 0; i < n; i++) {
      const x = 10 + 280 * (i / (n - 1))
      const y = 40 - 35 * ((ys[i] - minY) / rangeY)
      points.push(`${x.toFixed(1)},${y.toFixed(1)}`)
    }
    const line = points.join(' ')
    const area = line + ' 290,45 10,45'
    return { line, area }
  }
  const computedSparkRaw = computed(() => computeSparkFromNumbers(props.sparkline ?? null))
  const computedSparkLine = computed(() => (props.sparkline && computedSparkRaw.value.line) || (props.p?.sparkLine ?? props.sparkLine ?? null))
  const computedSparkPoints = computed(() => (props.sparkline && computedSparkRaw.value.area) || (props.p?.sparkPoints ?? props.sparkPoints ?? null))
  
  const controversyText = computed(() => {
    const v = Number(controversy.value ?? 0)
    return Number.isFinite(v) ? v.toFixed(3) : '0.000'
  })

  
  
  /* Base class tweaks: lighter borders, slightly tighter padding on md/sm */
  const baseClass = 'relative min-w-0 rounded-xl bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 transition-all duration-200'
  const rootClass = computed(() => {
    if (variant.value === 'lg') {
      return [
        baseClass,
        to.value ? 'hover:shadow-md cursor-pointer focus:outline-none focus:ring-2 ring-[rgb(var(--accent))]' : '',
        'p-5 md:p-6 flex flex-col gap-3'
      ].join(' ')
    }
    if (variant.value === 'md') {
      return [
        baseClass,
        to.value ? 'hover:shadow-md cursor-pointer focus:outline-none focus:ring-2 ring-[rgb(var(--accent))]' : '',
        'p-3 flex flex-col gap-2'
      ].join(' ')
    }
    return [
      baseClass,
      to.value ? 'hover:shadow-sm cursor-pointer focus:outline-none focus:ring-2 ring-[rgb(var(--accent))]' : '',
      'p-2.5 flex flex-col gap-1'
    ].join(' ')
  })
  </script>
  
  <style scoped>
  .stat-tile{ @apply border border-neutral-200 dark:border-neutral-700 rounded p-2 text-center; }
  .stat-label{ @apply text-[10px] leading-none text-neutral-500 dark:text-neutral-400; }
  .stat-value{ @apply text-sm font-semibold text-neutral-800 dark:text-neutral-200 tabular-nums; }
  .stat-soft{ @apply rounded text-center bg-neutral-50 dark:bg-neutral-800/60 p-1.5; }
  .stat-num{ @apply text-[13px] leading-tight font-semibold text-neutral-800 dark:text-neutral-200 tabular-nums; }
  .stat-chip{ @apply inline-flex items-center px-2 py-0.5 rounded-full bg-neutral-50 dark:bg-neutral-800 text-[11px] text-neutral-700 dark:text-neutral-300 tabular-nums; }
  </style>
  