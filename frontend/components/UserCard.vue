<template>
    <component
      :is="linkComponent"
      v-bind="linkBindings"
      :class="rootClass"
      :role="bareRole"
      :tabindex="bareTabIndex"
      @click="handleBareClick"
      @keydown="handleBareKeydown"
    >
      <div class="flex items-center gap-3 min-w-0 relative w-full" :class="variant === 'lg' ? 'pr-14' : ''" v-if="variant !== 'sm'">
        <UserAvatar
          v-if="avatar"
          :wikidot-id="wikidotId"
          :name="displayName"
          :size="avatarSize"
          class="rounded-full overflow-hidden ring-1 ring-inset ring-neutral-200 dark:ring-neutral-800"
        />
        <div class="min-w-0">
          <div class="truncate" :class="nameClass">{{ displayName || 'Unknown' }}</div>
          <div v-if="variant==='lg' && (subtitle || wikidotIdText)" class="mt-0.5 text-[11px] text-neutral-500 dark:text-neutral-400 truncate">
            <span v-if="subtitle">{{ subtitle }}</span>
            <span v-if="subtitle && wikidotIdText" class="mx-1">·</span>
            <span v-if="wikidotIdText">ID {{ wikidotIdText }}</span>
          </div>
        </div>
        <div :class="rankPositionClass">
          <div v-if="rank != null" class="text-base font-semibold text-[rgb(var(--accent))] dark:text-[rgb(var(--accent))] tabular-nums leading-none">#{{ rank }}</div>
          <div v-else-if="totalsText" class="text-xs text-neutral-500 dark:text-neutral-400 leading-none">{{ totalsText }}</div>
          <div v-else-if="metaRight != null" class="text-xs text-neutral-500 dark:text-neutral-400 leading-none">{{ metaRight }}</div>
        </div>
      </div>
  
      <!-- LG content (unchanged from your v1, kept compact below) -->
      <template v-if="variant === 'lg'">
        <div class="mt-3 grid grid-cols-3 gap-2 w-full">
          <div class="tile"><div class="lbl">总评分</div><div class="val">{{ totalsSafe.totalRating }}</div></div>
          <div class="tile"><div class="lbl">平均评分</div><div class="val">{{ avgRatingText }}</div></div>
          <div class="tile"><div class="lbl">作品</div><div class="val">{{ totalsSafe.works }}</div></div>
          <div class="tile"><div class="lbl">支持票</div><div class="val">{{ totalsSafe.votesUp }}</div></div>
          <div class="tile"><div class="lbl">反对票</div><div class="val">{{ totalsSafe.votesDown }}</div></div>
          <div class="tile"><div class="lbl">最近活动</div><div class="val">{{ lastActiveText || '—' }}</div></div>
        </div>
        <div v-if="sparkline && sparkline.length>1" class="mt-3 h-12 border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-800 rounded flex items-center justify-center w-full">
          <svg :width="'100%'" height="48" viewBox="0 0 300 48" preserveAspectRatio="none">
            <defs>
              <linearGradient :id="`ug-${wikidotId || 'u'}`" x1="0%" y1="0%" x2="0%" y2="100%">
                <stop offset="0%" style="stop-color:#10b981;stop-opacity:0.3" />
                <stop offset="100%" style="stop-color:#10b981;stop-opacity:0" />
              </linearGradient>
            </defs>
            <polyline :points="userSparkArea || ''" :fill="`url(#ug-${wikidotId || 'u'})`" stroke="none" />
            <polyline :points="userSparkLine || ''" fill="none" stroke="#10b981" stroke-width="2" />
          </svg>
        </div>
        <div v-if="categoryRanksNorm.length" class="mt-3 grid grid-cols-2 gap-2 w-full">
          <div v-for="r in categoryRanksNorm" :key="r.name" class="border border-neutral-200 dark:border-neutral-800 rounded px-2 py-1 text-xs flex items-center justify-between">
            <span class="truncate text-neutral-600 dark:text-neutral-300">{{ r.name }}</span>
            <span class="font-semibold text-[rgb(var(--accent))] dark:text-[rgb(var(--accent))] tabular-nums">#{{ r.rank }}</span>
          </div>
        </div>
      </template>
  
      <template v-if="variant === 'md'">
        <div class="w-full mt-1 flex items-center justify-end gap-1.5 text-right">
          <span class="chip">评分 {{ totalsSafe.totalRating }}</span>
          <span class="chip">作品 {{ totalsSafe.works }}</span>
        </div>
      </template>
  
      <template v-if="variant === 'sm'">
        <div class="inline-flex items-center gap-1.5">
          <UserAvatar v-if="avatar" :wikidot-id="wikidotId" :name="displayName" :size="avatarSize" class="ring-1 ring-inset ring-neutral-200 dark:ring-neutral-800" />
          <div :class="nameSmClass">{{ displayName || 'Unknown' }}</div>
        </div>
      </template>
    </component>
  </template>
  
<script setup lang="ts">
import { computed, resolveComponent } from 'vue'
import { navigateTo } from 'nuxt/app'
  
  type UserCardSize = 'lg'|'md'|'sm'|'L'|'M'|'S'
  
  interface Props {
    size?: UserCardSize
    wikidotId?: number | string | null
    displayName?: string | null
    subtitle?: string | null
    rank?: number | null
    metaRight?: string | number | null
    to?: string | null
    avatar?: boolean
    bare?: boolean
    handle?: string | null
    totals?: { totalRating?: number; avgRating?: number; works?: number; votesUp?: number; votesDown?: number } | null
    lastActiveISO?: string | null
    categoryRanks?: Array<{ name: string; rank: number }> | null
    sparkline?: number[] | null
    smBgClass?: string | null
    smAvatarSize?: number | null
    smTextClass?: string | null
  }
  
  const props = withDefaults(defineProps<Props>(), { size: 'md', avatar: true, bare: false })
  
  const variant = computed<'lg'|'md'|'sm'>(() => {
    const s = props.size || 'md'
    if (s === 'L') return 'lg'
    if (s === 'M') return 'md'
    if (s === 'S') return 'sm'
    return s as 'lg'|'md'|'sm'
  })
  
  const wikidotId = computed(() => props.wikidotId)
  const displayName = computed(() => props.displayName ?? '')
  const to = computed(() => {
    if (props.to !== undefined && props.to !== null) return props.to
    const id = wikidotId.value as any
    const idNum = typeof id === 'number' ? id : Number(id)
    if (id == null || !Number.isFinite(idNum) || idNum <= 0) return null
    return `/user/${id}`
  })
  const nuxtLink = resolveComponent('NuxtLink') as any
  const shouldUseNuxtLink = computed(() => Boolean(to.value) && !props.bare)
  const linkComponent = computed(() => (shouldUseNuxtLink.value ? nuxtLink : 'div'))
  const linkBindings = computed(() => (shouldUseNuxtLink.value ? { to: to.value } : {}))
  const bareInteractive = computed(() => Boolean(to.value) && props.bare)
  const bareRole = computed(() => (bareInteractive.value ? 'link' : undefined))
  const bareTabIndex = computed(() => (bareInteractive.value ? 0 : undefined))

  const triggerNavigation = () => {
    if (bareInteractive.value && to.value) navigateTo(to.value)
  }

  const handleBareClick = (event: MouseEvent) => {
    if (!bareInteractive.value) return
    event.preventDefault()
    event.stopPropagation()
    triggerNavigation()
  }

  const handleBareKeydown = (event: KeyboardEvent) => {
    if (!bareInteractive.value) return
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    event.stopPropagation()
    triggerNavigation()
  }
  
  const wikidotIdText = computed(() => (wikidotId.value != null && String(wikidotId.value)) || '')
  const totalsText = computed(() => {
    const t = props.totals || null
    if (!t) return ''
    const works = Number(t.works ?? 0)
    const tr = Number(t.totalRating ?? 0)
    if (works > 0 && tr > 0) return `作品 ${works} · 评分 ${tr}`
    if (works > 0) return `作品 ${works}`
    if (tr > 0) return `评分 ${tr}`
    return ''
  })
  
  const totalsSafe = computed(() => ({
    totalRating: Number(props.totals?.totalRating ?? 0),
    avgRating: Number(props.totals?.avgRating ?? NaN),
    works: Number(props.totals?.works ?? 0),
    votesUp: Number(props.totals?.votesUp ?? 0),
    votesDown: Number(props.totals?.votesDown ?? 0)
  }))
  
  const avgRatingResolved = computed(() => {
    const given = totalsSafe.value.avgRating
    if (Number.isFinite(given) && given >= 0) return given
    const w = totalsSafe.value.works
    const tr = totalsSafe.value.totalRating
    if (w > 0) return tr / w
    return NaN
  })
  const avgRatingText = computed(() => Number.isFinite(avgRatingResolved.value) ? avgRatingResolved.value.toFixed(1) : '—')
  
  const lastActiveText = computed(() => {
    const iso = props.lastActiveISO
    if (!iso) return ''
    const parsed = Date.parse(iso)
    if (Number.isNaN(parsed)) return ''
    const diff = Date.now() - parsed
    const sec = Math.floor(diff / 1000)
    if (sec < 60) return '刚刚'
    const min = Math.floor(sec / 60)
    if (min < 60) return `${min} 分钟前`
    const hr = Math.floor(min / 60)
    if (hr < 24) return `${hr} 小时前`
    const day = Math.floor(hr / 24)
    if (day < 30) return `${day} 天前`
    const d = new Date(parsed)
    const y = d.getFullYear(); const m = String(d.getMonth()+1).padStart(2,'0'); const da = String(d.getDate()).padStart(2,'0')
    return `${y}-${m}-${da}`
  })
  
  const categoryRanksNorm = computed(() => (props.categoryRanks || []).filter(r => r && typeof r.rank === 'number').slice(0,6))
  
  function computeSparkFromNumbers(nums?: number[] | null){
    if (!nums || nums.length < 2) return { line: null as string | null, area: null as string | null }
    const recent = nums.slice(-30)
    const ys = recent
    const minY = Math.min(...ys)
    const maxY = Math.max(...ys)
    const rangeY = maxY - minY || 1
    const n = ys.length
    const points: string[] = []
    for (let i=0;i<n;i++){
      const x = 10 + 280 * (i / (n-1))
      const y = 40 - 35 * ((ys[i]-minY)/rangeY)
      points.push(`${x.toFixed(1)},${y.toFixed(1)}`)
    }
    const line = points.join(' ')
    const area = line + ' 290,45 10,45'
    return { line, area }
  }
  const userSparkRaw = computed(() => computeSparkFromNumbers(props.sparkline ?? null))
  const userSparkLine = computed(() => userSparkRaw.value.line)
  const userSparkArea = computed(() => userSparkRaw.value.area)
  
  const baseClass = 'relative self-start min-w-0 rounded-xl bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 transition-all duration-200'
  const rootClass = computed(() => {
    if (props.bare) {
      if (variant.value === 'lg') return [to.value ? 'cursor-pointer' : '', 'self-start flex flex-col gap-3 min-w-0'].join(' ')
      if (variant.value === 'md') return [to.value ? 'cursor-pointer' : '', 'self-start flex items-center justify-between gap-2 min-w-0'].join(' ')
      return [to.value ? 'cursor-pointer' : '', 'self-start flex items-center gap-2 min-w-0'].join(' ')
    }
    if (variant.value === 'lg') return [baseClass, to.value ? 'hover:shadow-md cursor-pointer focus:outline-none focus:ring-2 ring-[rgb(var(--accent))]' : '', 'p-5 md:p-6 flex flex-col relative'].join(' ')
    if (variant.value === 'md') return [baseClass, to.value ? 'hover:shadow-md cursor-pointer focus:outline-none focus:ring-2 ring-[rgb(var(--accent))]' : '', 'p-3 flex items-center justify-between gap-2'].join(' ')
    return ['relative self-start justify-self-start inline-flex items-center gap-1.5 rounded-full border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900', to.value ? 'hover:shadow-sm cursor-pointer focus:outline-none focus:ring-2 ring-[rgb(var(--accent))]' : '', 'px-2 py-1 min-h-[26px] w-auto', props.smBgClass || ''].join(' ')
  })
  
  const rankPositionClass = computed(() => {
    if (variant.value === 'lg') return 'absolute right-0 top-1.5 md:top-1 text-right leading-none'
    if (variant.value === 'md') return 'ml-auto shrink-0 text-right self-center leading-none'
    return 'hidden'
  })
  
  const nameClass = computed(() => {
    if (variant.value === 'lg') return 'text-base font-medium text-[rgb(var(--accent))]'
    if (variant.value === 'md') return 'text-[13px] font-medium text-[rgb(var(--accent))]'
    return 'text-[12px] font-medium text-[rgb(var(--accent))]'
  })
  
  const nameSmClass = computed(() => (props.smTextClass && props.smTextClass.trim()) ? props.smTextClass : 'text-[12px] leading-none font-medium text-[rgb(var(--accent))] truncate max-w-[140px]')
  
  const avatarSize = computed(() => {
    if (variant.value === 'lg') return 44
    if (variant.value === 'md') return 32
    const s = Number(props.smAvatarSize ?? 18)
    return Number.isFinite(s) && s > 0 ? s : 18
  })
  </script>
  
  <style scoped>
  .tile{ @apply border border-neutral-200 dark:border-neutral-700 rounded p-2 text-center; }
  .lbl{ @apply text-[10px] text-neutral-500 dark:text-neutral-400; }
  .val{ @apply text-sm font-semibold text-neutral-800 dark:text-neutral-200 tabular-nums; }
  .chip{ @apply px-2 py-0.5 rounded-full bg-neutral-50 dark:bg-neutral-800 text-[11px] text-neutral-700 dark:text-neutral-300 tabular-nums; }
  </style>
  
