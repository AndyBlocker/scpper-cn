<template>
  <div :class="[{ dark: isDark }, 'apple-design-root']" :style="accentStyle">
    <div class="relative min-h-screen overflow-hidden bg-[radial-gradient(120%_120%_at_100%_0%,rgba(255,255,255,0.95),#f4f4f5_45%,#e5e5e5_75%)] text-neutral-900 transition-colors dark:bg-[linear-gradient(140deg,#050507,#0d0d12_42%,#10121a)] dark:text-neutral-50">
      <div class="pointer-events-none absolute inset-0">
        <div class="absolute -top-32 -right-16 h-80 w-80 rounded-full bg-[rgba(var(--accent),0.22)] blur-[160px]" />
        <div class="absolute top-56 -left-40 h-96 w-96 rounded-full bg-[rgba(var(--accent-weak),0.25)] blur-[200px]" />
        <div class="absolute bottom-[-120px] right-1/3 h-72 w-72 rounded-full bg-white/40 blur-[180px] dark:bg-white/8" />
      </div>

      <div class="relative z-10 mx-auto max-w-6xl px-6 pb-24 pt-16" :class="densitySpaceClass">
        <!-- Hero -->
        <section class="grid items-center gap-12 lg:grid-cols-[1.12fr_0.88fr]">
          <div class="space-y-8">
            <div class="inline-flex items-center gap-2 rounded-full border border-white/70 bg-white/90 px-4 py-1.5 text-[11px] uppercase tracking-[0.32em] text-neutral-500 shadow-[0_12px_28px_-28px_rgba(15,23,42,0.35)] dark:border-white/15 dark:bg-white/10 dark:text-neutral-400">
              <span class="h-1.5 w-1.5 rounded-full" :style="{ background: `rgb(${activePalette.accent})` }" />
              SCPPER DESIGN LAB
            </div>
            <div class="space-y-6">
              <h1 class="text-4xl font-semibold leading-tight text-neutral-900 sm:text-5xl lg:text-[56px] dark:text-neutral-50">
                Apple 风格的 SCPPER 体验
              </h1>
              <p class="text-base text-neutral-600 sm:text-lg dark:text-neutral-300">
                将排行榜、档案与标签面板重塑为柔和的玻璃态界面，强调节奏、空气感与精准的色彩动势，像体验一场 Apple Keynote。
              </p>
            </div>
            <div class="flex flex-wrap gap-4">
              <NuxtLink
                to="/"
                class="inline-flex items-center gap-3 rounded-full bg-neutral-900 px-6 py-3 text-sm font-semibold text-white shadow-[0_22px_40px_-30px_rgba(15,23,42,0.6)] transition hover:bg-neutral-800 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
              >
                查看真实站点
                <span aria-hidden="true">→</span>
              </NuxtLink>
              <button
                type="button"
                class="inline-flex items-center gap-3 rounded-full border border-white/70 bg-white/85 px-6 py-3 text-sm font-semibold text-neutral-700 shadow-[0_12px_36px_-30px_rgba(15,23,42,0.45)] transition hover:border-[rgba(var(--accent),0.45)] hover:text-[rgb(var(--accent-strong))] dark:border-white/15 dark:bg-white/10 dark:text-neutral-200"
                @click="isDark = !isDark"
              >
                切换至 {{ isDark ? '浅色' : '深色' }} 模式
              </button>
            </div>
            <div class="grid gap-4 sm:grid-cols-3">
              <div
                v-for="highlight in heroHighlights"
                :key="highlight.title"
                class="rounded-3xl border border-white/70 bg-white/80 px-5 py-4 text-sm text-neutral-600 backdrop-blur-xl shadow-[inset_0_1px_0_rgba(255,255,255,0.6)] dark:border-white/10 dark:bg-white/5 dark:text-neutral-300"
              >
                <p class="mb-2 text-xs uppercase tracking-[0.24em] text-neutral-400 dark:text-neutral-500">{{ highlight.title }}</p>
                <p class="leading-relaxed text-sm">{{ highlight.description }}</p>
              </div>
            </div>
          </div>
          <div class="relative">
            <div class="absolute inset-0 -translate-y-10 translate-x-8 rounded-[40px] bg-white/50 blur-[120px] dark:bg-white/10" />
            <div class="relative flex flex-col gap-6">
              <PageCardApple :page="samplePages[0]" :accent-rgb="activeAccentRGB" :size="pageCardSize" />
              <div class="ml-auto w-full max-w-sm">
                <UserCardApple :user="sampleUsers[0]" :accent-rgb="activeAccentRGB" :size="userCardSize" />
              </div>
            </div>
          </div>
        </section>

        <!-- Control Center -->
        <section class="rounded-[32px] border border-white/70 bg-white/85 px-8 py-10 shadow-[0_28px_72px_-48px_rgba(15,23,42,0.55)] backdrop-blur-2xl dark:border-white/10 dark:bg-white/5">
          <header class="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <h2 class="text-2xl font-semibold text-neutral-900 dark:text-neutral-100">交互控制中心</h2>
              <p class="text-sm text-neutral-500 dark:text-neutral-400">调整主题、强调色与组件尺寸，实时预览 Apple 式组件响应。</p>
            </div>
            <div class="flex flex-wrap items-center gap-2 text-xs text-neutral-500 dark:text-neutral-400">
              <span>主题：{{ isDark ? 'Dark' : 'Light' }}</span>
              <span>·</span>
              <span>强调色：{{ accentPreset.label }}</span>
              <span>·</span>
              <span>密度：{{ densityLabel }}</span>
            </div>
          </header>

          <div class="mt-8 grid gap-8 md:grid-cols-2 xl:grid-cols-3">
            <div class="space-y-3">
              <h3 class="text-sm font-semibold text-neutral-700 dark:text-neutral-200">主题模式</h3>
              <div class="flex flex-wrap items-center gap-3">
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
                <button
                  type="button"
                  class="relative inline-flex h-6 w-11 items-center rounded-full border border-neutral-200 bg-white/70 transition dark:border-white/10 dark:bg-white/10"
                  @click="isDark = !isDark"
                >
                  <span
                    class="absolute left-1 h-4 w-4 rounded-full bg-neutral-900 transition-transform dark:bg-neutral-100"
                    :class="{ 'translate-x-5': isDark }"
                  />
                  <span class="sr-only">Toggle theme</span>
                </button>
              </div>
            </div>

            <div class="space-y-3">
              <h3 class="text-sm font-semibold text-neutral-700 dark:text-neutral-200">强调色预设</h3>
              <div class="flex flex-wrap gap-3">
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

            <div class="space-y-3">
              <h3 class="text-sm font-semibold text-neutral-700 dark:text-neutral-200">版面密度</h3>
              <div class="flex flex-wrap gap-3">
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

            <div class="space-y-3">
              <h3 class="text-sm font-semibold text-neutral-700 dark:text-neutral-200">PageCard 尺寸</h3>
              <div class="flex flex-wrap gap-3">
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

            <div class="space-y-3">
              <h3 class="text-sm font-semibold text-neutral-700 dark:text-neutral-200">UserCard 尺寸</h3>
              <div class="flex flex-wrap gap-3">
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
          </div>
        </section>

        <!-- Apple PageCard Gallery -->
        <section class="space-y-8">
          <div class="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <h2 class="text-2xl font-semibold text-neutral-900 dark:text-neutral-100">PageCard · Apple Version</h2>
              <p class="text-sm text-neutral-500 dark:text-neutral-400">尺寸：{{ pageCardSizeLabel }} · {{ densityLabel }} 间距布局。</p>
            </div>
            <span class="text-xs text-neutral-500 dark:text-neutral-400">强调色 {{ accentPreset.label }}</span>
          </div>
          <div class="grid" :class="[pageCardPreviewCols, previewGapClass]">
            <PageCardApple
              v-for="page in samplePages"
              :key="page.wikidotId"
              :page="page"
              :accent-rgb="activeAccentRGB"
              :size="pageCardSize"
            />
          </div>
        </section>

        <!-- Apple UserCard Gallery -->
        <section class="space-y-8">
          <div class="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <h2 class="text-2xl font-semibold text-neutral-900 dark:text-neutral-100">UserCard · Apple Version</h2>
              <p class="text-sm text-neutral-500 dark:text-neutral-400">尺寸：{{ userCardSizeLabel }} · {{ densityLabel }} 信息节奏。</p>
            </div>
            <span class="text-xs text-neutral-500 dark:text-neutral-400">自动同步作者数据（{{ sampleUsers.length }} 位样本）</span>
          </div>
          <div class="grid" :class="[userCardPreviewCols, previewGapClass]">
            <UserCardApple
              v-for="user in sampleUsers"
              :key="user.wikidotId"
              :user="user"
              :accent-rgb="activeAccentRGB"
              :size="userCardSize"
            />
          </div>
        </section>

        <!-- Metrics -->
        <section class="space-y-8">
          <div class="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <h2 class="text-2xl font-semibold text-neutral-900 dark:text-neutral-100">核心指标对齐</h2>
              <p class="text-sm text-neutral-500 dark:text-neutral-400">以 Apple 风格呈现四项运营指标，突出数字的节奏感与态势。</p>
            </div>
            <span class="text-xs text-neutral-500 dark:text-neutral-400">更新于 {{ lastUpdated }}</span>
          </div>
          <div class="grid gap-6 md:grid-cols-2 xl:grid-cols-4">
            <div
              v-for="metric in showcaseMetrics"
              :key="metric.label"
              class="group relative overflow-hidden rounded-3xl border border-white/70 bg-white/80 p-6 transition-all duration-300 hover:-translate-y-1 hover:shadow-[0_30px_70px_-50px_rgba(15,23,42,0.65)] dark:border-white/10 dark:bg-white/5"
            >
              <div class="pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-300 group-hover:opacity-100">
                <div class="absolute inset-0 bg-gradient-to-br from-[rgba(var(--accent),0.12)] via-transparent to-transparent" />
              </div>
              <div class="relative flex flex-col gap-4">
                <div class="flex items-center justify-between text-xs uppercase tracking-[0.26em] text-neutral-500 dark:text-neutral-400">
                  <span>{{ metric.label }}</span>
                  <span :class="metric.trend === 'up' ? 'text-[rgb(var(--accent))]' : 'text-rose-500'">{{ metric.delta }}</span>
                </div>
                <div class="flex items-end gap-2">
                  <span class="text-3xl font-semibold leading-none text-neutral-900 dark:text-neutral-50">{{ formatNumber(metric.value) }}</span>
                  <span class="text-xs text-neutral-400 dark:text-neutral-500">{{ metric.unit }}</span>
                </div>
                <p class="text-xs leading-relaxed text-neutral-500 dark:text-neutral-400">{{ metric.caption }}</p>
              </div>
            </div>
          </div>
        </section>

        <!-- Tag & Tip -->
        <section class="grid gap-8 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)]">
          <div class="rounded-[32px] border border-white/70 bg-white/80 p-8 shadow-[0_24px_60px_-48px_rgba(15,23,42,0.55)] backdrop-blur-2xl dark:border-white/10 dark:bg-white/5">
            <div class="flex items-center justify-between">
              <h3 class="text-base font-semibold text-neutral-900 dark:text-neutral-100">标签光晕</h3>
              <span class="text-xs text-neutral-500 dark:text-neutral-400">最近 30 天</span>
            </div>
            <div class="mt-5 flex flex-wrap gap-2">
              <span
                v-for="tag in trendingTags"
                :key="tag"
                class="inline-flex items-center gap-2 rounded-full border border-white/70 bg-white/80 px-3 py-1 text-xs text-neutral-600 backdrop-blur-md dark:border-white/10 dark:bg-white/5 dark:text-neutral-200"
              >
                #{{ tag }}
              </span>
            </div>
          </div>
          <div class="relative overflow-hidden rounded-[32px] border border-white/70 bg-gradient-to-br from-neutral-900 via-neutral-850 to-neutral-700 p-8 text-neutral-100 shadow-[0_24px_60px_-48px_rgba(15,23,42,0.55)] dark:border-white/10">
            <div class="pointer-events-none absolute -top-8 right-0 h-40 w-40 rounded-full bg-[rgba(var(--accent),0.25)] blur-[120px]" />
            <div class="relative flex flex-col gap-4">
              <p class="text-xs uppercase tracking-[0.3em] text-neutral-400">设计提示</p>
              <h3 class="text-2xl font-semibold">保持视觉节奏</h3>
              <p class="text-sm leading-relaxed text-neutral-300">
                通过 24px 左右的段落间距、柔和的投影与半透明边框，让密集数据也能保持优雅气质。强调色沿用 {{ accentPreset.label }} 方案，可快速适配暗色模式。
              </p>
              <p class="text-xs text-neutral-400">当前强调色 RGB：{{ activeAccentRGB }}</p>
            </div>
          </div>
        </section>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import PageCardApple from '~/components/apple/PageCardApple.vue'
import UserCardApple from '~/components/apple/UserCardApple.vue'

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

const pillBaseClass = 'inline-flex items-center gap-2 rounded-full border border-white/70 bg-white/75 px-3 py-1.5 text-xs font-medium text-neutral-600 transition-all backdrop-blur hover:border-[rgba(var(--accent),0.35)] hover:text-[rgb(var(--accent-strong))] dark:border-white/15 dark:bg-white/10 dark:text-neutral-200'
const pillActiveClass = 'bg-[rgb(var(--accent))] text-white border-transparent shadow-[0_10px_30px_-18px_rgba(15,23,42,0.5)] hover:text-white'
const pillDotClass = 'inline-flex h-2.5 w-2.5 rounded-full shadow-sm'

const isDark = ref(false)
const selectedAccentId = ref<AccentPreset['id']>('emerald')
const selectedDensity = ref<typeof densityOptions[number]['id']>('comfortable')
const pageCardSize = ref<typeof pageCardSizeOptions[number]['id']>('lg')
const userCardSize = ref<typeof userCardSizeOptions[number]['id']>('lg')

const accentPreset = computed(() => accentPresets.find((preset) => preset.id === selectedAccentId.value) ?? accentPresets[0])
const activePalette = computed<AccentPalette>(() => (isDark.value ? accentPreset.value.dark : accentPreset.value.light))

const accentStyle = computed(() => ({
  '--accent': activePalette.value.accent,
  '--accent-strong': activePalette.value.strong,
  '--accent-weak': activePalette.value.weak
}))

const activeAccentRGB = computed(() => activePalette.value.accent)

const densitySpaceClass = computed(() => {
  switch (selectedDensity.value) {
    case 'compact':
      return 'space-y-16'
    case 'relaxed':
      return 'space-y-24'
    default:
      return 'space-y-20'
  }
})

const previewGapClass = computed(() => {
  switch (selectedDensity.value) {
    case 'compact':
      return 'gap-6'
    case 'relaxed':
      return 'gap-12'
    default:
      return 'gap-8'
  }
})

const pageCardPreviewCols = computed(() => {
  switch (pageCardSize.value) {
    case 'sm':
      return 'grid-cols-1 md:grid-cols-2 xl:grid-cols-3'
    case 'md':
      return 'grid-cols-1 md:grid-cols-2'
    default:
      return 'grid-cols-1 lg:grid-cols-2'
  }
})

const userCardPreviewCols = computed(() => {
  switch (userCardSize.value) {
    case 'sm':
      return 'grid-cols-1 sm:grid-cols-2 xl:grid-cols-3'
    default:
      return 'grid-cols-1 md:grid-cols-2'
  }
})

const densityLabel = computed(() => densityOptions.find((item) => item.id === selectedDensity.value)?.label ?? '舒适')
const pageCardSizeLabel = computed(() => pageCardSizeOptions.find((item) => item.id === pageCardSize.value)?.label ?? 'Large')
const userCardSizeLabel = computed(() => userCardSizeOptions.find((item) => item.id === userCardSize.value)?.label ?? 'Large')

const heroHighlights = [
  { title: '气氛层次', description: '以柔和光晕叠加玻璃态蒙版，营造 Apple Keynote 式的舞台光感。' },
  { title: '流畅响应', description: '尺寸、主题与强调色实时联动，组件在暗浅模式间平滑过渡。' },
  { title: '精致排版', description: '大标题搭配细腻字重与 0.26em 字距标签，保持空灵却不失信息密度。' }
] as const

const lastUpdated = new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' })
const formatNumber = (value: number) => value.toLocaleString('zh-CN')

const showcaseMetrics = [
  { label: '活跃用户', value: 12840, delta: '+3.2%', trend: 'up', unit: '人', caption: '活跃用户保持稳健增长，以清晰的主数字突出趋势。' },
  { label: '新增页面', value: 86, delta: '+12.5%', trend: 'up', unit: '篇', caption: '玻璃态卡片突出内容扩张，支持暗色与浅色双态。' },
  { label: '评分互动', value: 4521, delta: '-4.1%', trend: 'down', unit: '次', caption: '指标下行以语义色提醒风险，与强调色保持平衡。' },
  { label: '标签覆盖', value: 312, delta: '+1.8%', trend: 'up', unit: '个', caption: '圆角排版结合等宽数字，营造榜单式阅读体验。' }
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
.apple-design-root {
  font-family: 'SF Pro Display', 'SF Pro Text', 'Inter', 'Noto Sans SC', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  background-color: transparent;
}
</style>
