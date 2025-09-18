<template>
  <div :class="[{ dark: isDark }, 'design-sample-root']">
    <div class="min-h-screen bg-neutral-100/70 dark:bg-neutral-950/90 py-10">
      <div class="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
        <div class="flex flex-col" :class="densityClass" :style="accentStyle">
          <!-- Control Center -->
          <section class="rounded-2xl border border-neutral-200 dark:border-neutral-800 bg-white/90 dark:bg-neutral-900/90 shadow-sm backdrop-blur-sm p-6 space-y-6">
            <header class="flex items-center gap-3">
              <div class="h-8 w-1 rounded bg-[rgb(var(--accent))]" />
              <div>
                <h1 class="text-lg font-semibold text-neutral-900 dark:text-neutral-100">Design Playground 控制面板</h1>
                <p class="text-xs text-neutral-500 dark:text-neutral-400">快速切换主题、密度和组件尺寸，预览核心界面风格。</p>
              </div>
            </header>

            <div class="grid gap-6 md:grid-cols-2 xl:grid-cols-3">
              <div class="space-y-2">
                <h2 class="text-sm font-medium text-neutral-700 dark:text-neutral-200">主题模式</h2>
                <div class="flex items-center gap-3 flex-wrap">
                  <button
                    type="button"
                    :class="[pillBaseClass, isDark ? 'opacity-60' : pillActiveClass]"
                    @click="isDark = false"
                  >
                    <span :class="pillDotClass" class="bg-neutral-900" />
                    Light
                  </button>
                  <button
                    type="button"
                    :class="[pillBaseClass, isDark ? pillActiveClass : 'opacity-60']"
                    @click="isDark = true"
                  >
                    <span :class="pillDotClass" class="bg-neutral-100" />
                    Dark
                  </button>
                  <button type="button" class="relative inline-flex h-6 w-11 items-center rounded-full border border-neutral-200 dark:border-neutral-700 bg-white/60 dark:bg-neutral-800 transition" @click="isDark = !isDark">
                    <span class="absolute left-1 h-4 w-4 rounded-full bg-neutral-900 dark:bg-neutral-100 transition-transform" :class="{ 'translate-x-5': isDark }" />
                    <span class="sr-only">Toggle theme</span>
                  </button>
                </div>
              </div>

              <div class="space-y-2">
                <h2 class="text-sm font-medium text-neutral-700 dark:text-neutral-200">强调色预设</h2>
                <div class="flex flex-wrap gap-2">
                  <button
                    v-for="preset in accentPresets"
                    :key="preset.id"
                    type="button"
                    :class="[pillBaseClass, selectedAccentId === preset.id ? pillActiveClass : '']"
                    @click="selectedAccentId = preset.id"
                  >
                    <span
                      :class="pillDotClass"
                      :style="{ background: `rgb(${(isDark ? preset.dark : preset.light).accent})` }"
                    />
                    {{ preset.label }}
                  </button>
                </div>
              </div>

              <div class="space-y-2">
                <h2 class="text-sm font-medium text-neutral-700 dark:text-neutral-200">版面密度</h2>
                <div class="flex flex-wrap gap-2">
                  <button
                    v-for="option in densityOptions"
                    :key="option.id"
                    type="button"
                    :class="[pillBaseClass, selectedDensity === option.id ? pillActiveClass : '']"
                    @click="selectedDensity = option.id"
                  >
                    {{ option.label }}
                  </button>
                </div>
              </div>

              <div class="space-y-2">
                <h2 class="text-sm font-medium text-neutral-700 dark:text-neutral-200">PageCard 尺寸</h2>
                <div class="flex flex-wrap gap-2">
                  <button
                    v-for="option in pageCardSizeOptions"
                    :key="option.id"
                    type="button"
                    :class="[pillBaseClass, pageCardSize === option.id ? pillActiveClass : '']"
                    @click="pageCardSize = option.id"
                  >
                    {{ option.label }}
                  </button>
                </div>
              </div>

              <div class="space-y-2">
                <h2 class="text-sm font-medium text-neutral-700 dark:text-neutral-200">UserCard 尺寸</h2>
                <div class="flex flex-wrap gap-2">
                  <button
                    v-for="option in userCardSizeOptions"
                    :key="option.id"
                    type="button"
                    :class="[pillBaseClass, userCardSize === option.id ? pillActiveClass : '']"
                    @click="userCardSize = option.id"
                  >
                    {{ option.label }}
                  </button>
                </div>
              </div>

              <div class="space-y-2">
                <h2 class="text-sm font-medium text-neutral-700 dark:text-neutral-200">辅助视图</h2>
                <div class="flex flex-wrap gap-2">
                  <button type="button" :class="[pillBaseClass, showGuides ? pillActiveClass : '']" @click="showGuides = !showGuides">
                    {{ showGuides ? '隐藏布局线' : '显示布局线' }}
                  </button>
                  <button type="button" :class="[pillBaseClass, showSkeleton ? pillActiveClass : '']" @click="showSkeleton = !showSkeleton">
                    {{ showSkeleton ? '还原真实数据' : '切换加载骨架' }}
                  </button>
                </div>
              </div>
            </div>
          </section>

          <!-- Hero Section -->
          <section :class="['relative overflow-hidden rounded-2xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 shadow-sm', guideClass]">
            <div class="absolute inset-0 bg-gradient-to-tr from-[rgba(var(--accent),0.16)] via-transparent to-[rgba(var(--accent-strong),0.2)] dark:from-[rgba(var(--accent),0.24)] dark:via-transparent dark:to-[rgba(var(--accent-strong),0.32)]" />
            <div class="relative p-8 sm:p-12 grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,420px)]">
              <div class="space-y-6">
                <div class="inline-flex items-center gap-2 text-xs font-semibold tracking-[0.3em] text-neutral-500 dark:text-neutral-400 uppercase">
                  <span class="h-1.5 w-1.5 rounded-full bg-[rgb(var(--accent))]" />
                  Style Capsule
                </div>
                <div class="flex items-start gap-4">
                  <div class="shrink-0 flex h-12 w-12 items-center justify-center rounded-xl bg-white/80 dark:bg-neutral-900/70 border border-neutral-200/80 dark:border-neutral-700/70 shadow-sm">
                    <BrandIcon class="h-8 w-8 text-neutral-900 dark:text-neutral-100" />
                  </div>
                  <div class="space-y-3">
                    <h2 class="text-3xl sm:text-4xl font-semibold text-neutral-900 dark:text-neutral-50 leading-tight">SCPPER-CN 设计语言速览</h2>
                    <p class="text-sm sm:text-base text-neutral-600 dark:text-neutral-400 max-w-2xl">
                      中性色与柔和阴影构成基础层次，强调色通过 CSS 变量驱动，支持暗色模式的无缝切换。以下示例抽取首页、排行榜与分析面板的典型布局片段，可即时检视不同主题与密度下的视觉节奏。
                    </p>
                  </div>
                </div>
                <div class="grid gap-4 sm:grid-cols-3">
                  <div
                    v-for="highlight in heroHighlights"
                    :key="highlight.title"
                    class="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white/85 dark:bg-neutral-900/85 p-4 shadow-sm flex flex-col gap-2"
                  >
                    <span class="text-sm font-semibold text-neutral-800 dark:text-neutral-100">{{ highlight.title }}</span>
                    <p class="text-xs text-neutral-500 dark:text-neutral-400 leading-relaxed">{{ highlight.description }}</p>
                  </div>
                </div>
                <NuxtLink
                  to="/"
                  class="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[rgb(var(--accent))] text-white text-sm font-medium shadow-sm hover:bg-[rgba(var(--accent),0.9)] transition-colors"
                >
                  查看真实页面
                  <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
                  </svg>
                </NuxtLink>
              </div>

              <div class="rounded-2xl border border-neutral-200 dark:border-neutral-800 bg-neutral-50/70 dark:bg-neutral-800/60 p-6 shadow-inner space-y-4">
                <div class="flex items-center justify-between text-sm text-neutral-500 dark:text-neutral-400">
                  <span>主题变量</span>
                  <span>{{ accentPreset.label }}</span>
                </div>
                <div class="grid grid-cols-2 gap-3">
                  <div class="h-24 rounded-xl border border-neutral-200 dark:border-neutral-800 bg-gradient-to-br from-white via-neutral-50 to-neutral-200 shadow-sm" />
                  <div class="h-24 rounded-xl border border-neutral-700/60 bg-gradient-to-br from-neutral-900 via-neutral-800 to-neutral-700 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.05)]" />
                </div>
                <p class="text-xs text-neutral-500 dark:text-neutral-400 leading-relaxed">
                  Tailwind 原子类与 `--accent` 变量组合，实现统一强调色与 hover 状态；暗色模式仅需切换父级 `dark` class 即可同步更新。
                </p>
              </div>
            </div>
          </section>

          <!-- KPI Grid -->
          <section :class="['rounded-2xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 shadow-sm p-6', guideClass]">
            <header class="flex items-center justify-between border-b-2 border-[rgba(var(--accent),0.18)] dark:border-[rgba(var(--accent),0.28)] pb-3 mb-6">
              <div class="flex items-center gap-3">
                <div class="h-8 w-1 rounded bg-[rgb(var(--accent))]" />
                <h2 class="text-lg font-semibold text-neutral-900 dark:text-neutral-100">核心指标对齐</h2>
              </div>
              <span class="text-xs text-neutral-500 dark:text-neutral-400">更新于 {{ lastUpdated }}</span>
            </header>

            <div v-if="showSkeleton" class="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
              <div
                v-for="idx in 4"
                :key="`metric-skeleton-${idx}`"
                class="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-5 space-y-4 animate-pulse"
              >
                <div class="h-3 w-20 rounded bg-neutral-200 dark:bg-neutral-700" />
                <div class="h-8 w-24 rounded bg-neutral-200 dark:bg-neutral-700" />
                <div class="h-12 rounded bg-neutral-200/80 dark:bg-neutral-800" />
              </div>
            </div>

            <div v-else class="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
              <div
                v-for="metric in showcaseMetrics"
                :key="metric.label"
                class="group relative overflow-hidden rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-5 transition-all duration-200 hover:shadow-lg hover:-translate-y-0.5"
              >
                <div class="absolute inset-0 bg-gradient-to-br from-transparent via-transparent to-[rgba(var(--accent),0.08)] opacity-0 group-hover:opacity-100 transition-opacity" />
                <div class="relative space-y-3">
                  <div class="flex items-center justify-between">
                    <span class="text-xs font-medium tracking-wide uppercase text-neutral-500 dark:text-neutral-400">{{ metric.label }}</span>
                    <span :class="metric.trend === 'up' ? 'text-[rgb(var(--accent))]' : 'text-danger'" class="inline-flex items-center gap-1 text-xs">
                      <svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path v-if="metric.trend === 'up'" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 12l5-5 5 5M10 7v10" />
                        <path v-else stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 12l-5 5-5-5m5 5V7" />
                      </svg>
                      {{ metric.delta }}
                    </span>
                  </div>
                  <div class="flex items-baseline gap-2">
                    <span class="text-3xl font-semibold text-neutral-900 dark:text-neutral-100">{{ formatNumber(metric.value) }}</span>
                    <span class="text-xs text-neutral-400 dark:text-neutral-500">{{ metric.unit }}</span>
                  </div>
                  <p class="text-xs text-neutral-500 dark:text-neutral-400 leading-relaxed">{{ metric.caption }}</p>
                </div>
              </div>
            </div>
          </section>

          <!-- Page Cards -->
          <section :class="['rounded-2xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 shadow-sm p-6 space-y-6', guideClass]">
            <header class="flex items-center justify-between">
              <div>
                <h2 class="text-lg font-semibold text-neutral-900 dark:text-neutral-100">页面卡片排版</h2>
                <p class="text-xs text-neutral-500 dark:text-neutral-400">组件来源：PageCard.vue · 尺寸：{{ pageCardSize.toUpperCase() }}</p>
              </div>
              <span class="text-xs text-neutral-500 dark:text-neutral-400">{{ showSkeleton ? '骨架示例' : '真实数据示例' }}</span>
            </header>
            <div v-if="showSkeleton" :class="pageCardGridClass" class="grid gap-4">
              <div
                v-for="idx in pageCardSkeletonCount"
                :key="`page-skeleton-${idx}`"
                class="border border-neutral-200 dark:border-neutral-800 rounded-xl p-5 bg-white dark:bg-neutral-900 animate-pulse space-y-4"
              >
                <div class="h-4 w-3/4 rounded bg-neutral-200 dark:bg-neutral-700" />
                <div class="h-3 w-1/2 rounded bg-neutral-200 dark:bg-neutral-800" />
                <div class="h-16 rounded bg-neutral-200/80 dark:bg-neutral-800" />
              </div>
            </div>
            <div v-else :class="pageCardGridClass" class="grid gap-4">
              <PageCard
                v-for="page in samplePages"
                :key="page.wikidotId"
                :p="page"
                :authors="page.authorObjs"
                :comments="page.commentCount"
                :size="pageCardSize"
                :to="page.url"
              />
            </div>
          </section>

          <!-- User Cards -->
          <section :class="['rounded-2xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 shadow-sm p-6 space-y-6', guideClass]">
            <header class="flex items-center justify-between">
              <div>
                <h2 class="text-lg font-semibold text-neutral-900 dark:text-neutral-100">活跃作者图谱</h2>
                <p class="text-xs text-neutral-500 dark:text-neutral-400">组件来源：UserCard.vue · 尺寸：{{ userCardSize.toUpperCase() }}</p>
              </div>
              <span class="text-xs text-neutral-500 dark:text-neutral-400">{{ showSkeleton ? '骨架示例' : '真实数据示例' }}</span>
            </header>
            <div v-if="showSkeleton" :class="userCardGridClass" class="grid gap-4">
              <div
                v-for="idx in userCardSkeletonCount"
                :key="`user-skeleton-${idx}`"
                class="border border-neutral-200 dark:border-neutral-800 rounded-xl p-5 bg-white dark:bg-neutral-900 animate-pulse space-y-4"
              >
                <div class="h-10 w-10 rounded-full bg-neutral-200 dark:bg-neutral-700" />
                <div class="h-3 w-32 rounded bg-neutral-200 dark:bg-neutral-700" />
                <div class="h-3 w-24 rounded bg-neutral-200 dark:bg-neutral-800" />
              </div>
            </div>
            <div v-else :class="userCardGridClass" class="grid gap-4">
              <UserCard
                v-for="user in sampleUsers"
                :key="user.wikidotId"
                :size="userCardSize"
                :wikidot-id="user.wikidotId"
                :display-name="user.displayName"
                :subtitle="user.subtitle"
                :totals="user.totals"
                :rank="user.rank"
                :category-ranks="user.categoryRanks"
                :sparkline="user.sparkline"
                :last-active-i-s-o="user.lastActiveISO"
                avatar
              />
            </div>
          </section>

          <!-- Tag Spotlight & Note -->
          <section :class="['grid grid-cols-1 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)] gap-6', guideClass]">
            <div class="rounded-2xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 shadow-sm p-6">
              <div class="flex items-center justify-between">
                <h3 class="text-base font-semibold text-neutral-900 dark:text-neutral-100">标签热度集锦</h3>
                <span class="text-xs text-neutral-500 dark:text-neutral-400">最近 30 天</span>
              </div>
              <div class="mt-4 flex flex-wrap gap-2">
                <span
                  v-for="tag in trendingTags"
                  :key="tag"
                  class="inline-flex items-center gap-1 rounded-full bg-neutral-50 dark:bg-neutral-800/60 px-3 py-1 text-xs text-neutral-600 dark:text-neutral-300 border border-neutral-200/70 dark:border-neutral-700/70"
                >
                  #{{ tag }}
                </span>
              </div>
            </div>
            <div class="rounded-2xl border border-neutral-200 dark:border-neutral-800 bg-gradient-to-br from-neutral-900 via-neutral-850 to-neutral-700 text-neutral-100 p-6 shadow-sm">
              <div class="flex items-center gap-3">
                <svg class="h-8 w-8 text-[rgb(var(--accent))]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.6" d="M12 6v6l4 2" />
                </svg>
                <div>
                  <p class="text-xs uppercase tracking-[0.2em] text-neutral-400">设计提示</p>
                  <h3 class="text-xl font-semibold">保持视觉节奏</h3>
                </div>
              </div>
              <p class="mt-4 text-sm text-neutral-300 leading-relaxed">
                控制区块间距在 24px 左右，配合柔和边框、透明度渐变与微妙阴影，即便展示密集数据也能维持舒适的阅读体验。
              </p>
              <p class="mt-4 text-xs text-neutral-400">当前强调色：{{ accentPreset.label }} · RGB {{ activeAccentRGB }}</p>
            </div>
          </section>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import BrandIcon from '~/components/BrandIcon.vue'
import PageCard from '~/components/PageCard.vue'
import UserCard from '~/components/UserCard.vue'

interface AccentPalette {
  accent: string
  strong: string
  weak: string
}

interface AccentPreset {
  id: 'emerald' | 'indigo' | 'rose' | 'amber' | 'violet'
  label: string
  light: AccentPalette
  dark: AccentPalette
}

const accentPresets: AccentPreset[] = [
  {
    id: 'emerald',
    label: 'Emerald 翡翠绿',
    light: { accent: '16 185 129', strong: '5 150 105', weak: '110 231 183' },
    dark: { accent: '16 185 129', strong: '5 150 105', weak: '52 211 153' }
  },
  {
    id: 'indigo',
    label: 'Indigo 靛蓝',
    light: { accent: '99 102 241', strong: '79 70 229', weak: '165 180 252' },
    dark: { accent: '129 140 248', strong: '99 102 241', weak: '165 180 252' }
  },
  {
    id: 'rose',
    label: 'Rose 曙光红',
    light: { accent: '244 63 94', strong: '225 29 72', weak: '251 113 133' },
    dark: { accent: '248 113 113', strong: '244 63 94', weak: '254 205 211' }
  },
  {
    id: 'amber',
    label: 'Amber 琥珀',
    light: { accent: '245 158 11', strong: '217 119 6', weak: '252 211 77' },
    dark: { accent: '251 191 36', strong: '245 158 11', weak: '253 230 138' }
  },
  {
    id: 'violet',
    label: 'Violet 曜紫',
    light: { accent: '139 92 246', strong: '124 58 237', weak: '196 181 253' },
    dark: { accent: '167 139 250', strong: '139 92 246', weak: '216 180 254' }
  }
]

const densityOptions = [
  { id: 'compact', label: '紧凑' },
  { id: 'comfortable', label: '舒适' },
  { id: 'relaxed', label: '宽松' }
] as const

const pageCardSizeOptions = [
  { id: 'lg', label: 'Large' },
  { id: 'md', label: 'Medium' },
  { id: 'sm', label: 'Small' }
] as const

const userCardSizeOptions = pageCardSizeOptions

const pillBaseClass = 'inline-flex items-center gap-2 rounded-full border border-neutral-200 dark:border-neutral-700 bg-white/80 dark:bg-neutral-900/70 px-3 py-1.5 text-xs font-medium text-neutral-600 dark:text-neutral-300 transition-all hover:border-[rgb(var(--accent))] hover:text-[rgb(var(--accent-strong))]'
const pillActiveClass = 'bg-[rgb(var(--accent))] text-white border-transparent shadow-sm hover:shadow-md hover:text-white'
const pillDotClass = 'inline-flex h-2.5 w-2.5 rounded-full shadow-sm'

const isDark = ref(false)
const selectedAccentId = ref<AccentPreset['id']>('emerald')
const selectedDensity = ref<typeof densityOptions[number]['id']>('comfortable')
const pageCardSize = ref<typeof pageCardSizeOptions[number]['id']>('lg')
const userCardSize = ref<typeof userCardSizeOptions[number]['id']>('lg')
const showGuides = ref(false)
const showSkeleton = ref(false)

const accentPreset = computed(() => accentPresets.find((preset) => preset.id === selectedAccentId.value) ?? accentPresets[0])
const activePalette = computed<AccentPalette>(() => (isDark.value ? accentPreset.value.dark : accentPreset.value.light))

const accentStyle = computed(() => ({
  '--accent': activePalette.value.accent,
  '--accent-strong': activePalette.value.strong,
  '--accent-weak': activePalette.value.weak
}))

const activeAccentRGB = computed(() => activePalette.value.accent)

const densityClass = computed(() => {
  switch (selectedDensity.value) {
    case 'compact':
      return 'space-y-8'
    case 'relaxed':
      return 'space-y-16'
    default:
      return 'space-y-12'
  }
})

const guideClass = computed(() => (showGuides.value ? 'outline outline-1 outline-[rgba(var(--accent),0.32)] outline-offset-4 transition-all duration-200' : 'transition-all duration-200'))

const pageCardGridClass = computed(() => {
  switch (pageCardSize.value) {
    case 'sm':
      return 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4'
    case 'md':
      return 'grid-cols-1 sm:grid-cols-2 xl:grid-cols-3'
    default:
      return 'grid-cols-1 md:grid-cols-2 xl:grid-cols-3'
  }
})

const userCardGridClass = computed(() => {
  switch (userCardSize.value) {
    case 'sm':
      return 'grid-cols-1 sm:grid-cols-2 xl:grid-cols-3'
    case 'md':
      return 'grid-cols-1 lg:grid-cols-2'
    default:
      return 'grid-cols-1 lg:grid-cols-2'
  }
})

const pageCardSkeletonCount = computed(() => (pageCardSize.value === 'sm' ? 4 : 3))
const userCardSkeletonCount = computed(() => (userCardSize.value === 'sm' ? 3 : 2))

const heroHighlights = [
  { title: '信息密度控制', description: '组件以 12~16px 辅助文字搭配 24px 结构间距，保证数据面板的呼吸感。' },
  { title: '多模式支持', description: '统一使用 CSS 变量描述强调色，Tailwind 原子类在 light/dark 之间复用。' },
  { title: '动效节奏', description: 'hover 使用轻微阴影与 0.2s 过渡，确保交互反馈柔和稳定。' }
] as const

const lastUpdated = new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' })
const formatNumber = (value: number) => value.toLocaleString('zh-CN')

const showcaseMetrics = [
  { label: '活跃用户', value: 12840, delta: '+3.2%', trend: 'up', unit: '人', caption: '追踪社区活跃度，突出用户增长的稳定性。' },
  { label: '新增页面', value: 86, delta: '+12.5%', trend: 'up', unit: '篇', caption: '强调内容扩张，以轻量渐变背景突出卡片层级。' },
  { label: '评分互动', value: 4521, delta: '-4.1%', trend: 'down', unit: '次', caption: '利用语义色传达风险，与强调色形成对比。' },
  { label: '标签覆盖', value: 312, delta: '+1.8%', trend: 'up', unit: '个', caption: '圆角排版与大数字组合，凸显榜单式阅读体验。' }
] as const

type SamplePage = {
  wikidotId: number
  title: string
  tags: string[]
  authorObjs: Array<{ name: string; url?: string }>
  createdDate: string
  excerpt: string
  rating: number
  voteCount: number
  commentCount: number
  controversy: number
  snippetHtml?: string
  url: string
}

const samplePages: SamplePage[] = [
  {
    wikidotId: 100861,
    title: 'SCP-CN-3000「蓝色回声计划」',
    tags: ['scp-cn', '站点-19', '心理'],
    authorObjs: [{ name: 'PolarStar', url: '/user/1173' }, { name: '镀银草莓', url: '/user/2132' }],
    createdDate: '2024-02-18',
    excerpt: '在极地基地的循环报告中，蓝色信号以指数级递增，预示某种跨维度的回声即将突破。',
    rating: 186,
    voteCount: 240,
    commentCount: 32,
    controversy: 0.12,
    snippetHtml: '<em>最新投票趋势呈现温和上升。</em>',
    url: '/page/100861'
  },
  {
    wikidotId: 100862,
    title: 'SCP-CN-███「聚光之城」',
    tags: ['scp-cn', '城市', '异常建筑'],
    authorObjs: [{ name: '数据洞察局', url: '/user/3001' }],
    createdDate: '2023-11-05',
    excerpt: '每当夜幕降临，整座城市的玻璃幕墙会将所有注视凝聚为一点，并反馈给远方的观测者。',
    rating: 142,
    voteCount: 201,
    commentCount: 18,
    controversy: 0.07,
    url: '/page/100862'
  },
  {
    wikidotId: 100863,
    title: 'SCP-CN-2700「珊瑚终端」',
    tags: ['scp-cn', '海洋', '科技'],
    authorObjs: [{ name: '深渊档案室', url: '/user/998' }, { name: '渡鸦计划', url: '/user/44' }],
    createdDate: '2024-03-12',
    excerpt: '自增长的珊瑚结构记录了所有连线终端的风化时差，维持着未知的蓝色协议。',
    rating: 208,
    voteCount: 284,
    commentCount: 41,
    controversy: 0.19,
    snippetHtml: '<strong>Wilson</strong> 指数位于前 5%。',
    url: '/page/100863'
  }
]

const sampleUsers = [
  {
    wikidotId: 1173,
    displayName: 'PolarStar',
    subtitle: '站点资深作者 · CN 分部',
    rank: 1,
    totals: { totalRating: 1820, avgRating: 4.6, works: 36, votesUp: 2350, votesDown: 530 },
    categoryRanks: [
      { name: '原创作品', rank: 3 },
      { name: '合作条目', rank: 1 },
      { name: '城市线', rank: 5 }
    ],
    sparkline: [180, 182, 187, 195, 205, 210, 212, 218, 225, 230, 240, 245],
    lastActiveISO: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString()
  },
  {
    wikidotId: 2132,
    displayName: '镀银草莓',
    subtitle: '视觉叙事研究员',
    rank: 4,
    totals: { totalRating: 1260, avgRating: 4.2, works: 21, votesUp: 1640, votesDown: 310 },
    categoryRanks: [
      { name: '心理研究', rank: 2 },
      { name: '站点档案', rank: 4 }
    ],
    sparkline: [110, 115, 120, 126, 130, 132, 140, 146, 149, 153, 160, 166],
    lastActiveISO: new Date(Date.now() - 26 * 60 * 60 * 1000).toISOString()
  }
] as const

const trendingTags = ['scp-cn', '站点-19', '情感叙事', '跨站合作', '深海档案', '机动特遣队', '实验记录', '蓝色协议']
</script>

<style scoped>
.design-sample-root {
  font-family: 'Inter', 'Noto Sans SC', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
}
</style>
