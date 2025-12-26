<template>
  <div class="max-w-6xl mx-auto px-4 py-12 space-y-12">
    <section class="rounded-3xl border border-white/70 bg-white/90 px-6 py-10 shadow-[0_24px_60px_rgba(15,23,42,0.08)] backdrop-blur dark:border-white/10 dark:bg-neutral-900/85 dark:shadow-[0_18px_50px_rgba(0,0,0,0.55)]">
      <div class="flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
        <div class="space-y-4">
          <div class="inline-flex items-center gap-2 rounded-full border border-[rgba(var(--accent),0.35)] bg-[rgba(var(--accent),0.1)] px-4 py-1 text-xs font-semibold uppercase tracking-[0.2em] text-[rgb(var(--accent))]">
            <span>SCPCN 4K</span>
          </div>
          <div class="space-y-3">
            <h1 class="text-3xl font-semibold text-neutral-900 dark:text-neutral-50 sm:text-4xl">SCP-CN-4000 “难题”竞赛</h1>
            <p class="text-sm leading-relaxed text-neutral-600 dark:text-neutral-300">
              标签含有“cn4000”的页面会自动汇聚于此，随机抽取四篇作品预览，并可按发布时间或随机顺序浏览全部参赛条目。
            </p>
            <div class="flex flex-wrap items-center gap-2 text-xs text-neutral-500 dark:text-neutral-400">
              <span class="inline-flex items-center gap-1 rounded-full border border-neutral-200 bg-white/80 px-3 py-1 dark:border-neutral-700 dark:bg-neutral-900/70">
                <span class="h-1.5 w-1.5 rounded-full bg-[rgb(var(--accent))]" />
                <span>统计标签：cn4000</span>
              </span>
              <span class="inline-flex items-center gap-1 rounded-full border border-neutral-200 bg-white/80 px-3 py-1 dark:border-neutral-700 dark:bg-neutral-900/70">
                <LucideIcon name="KeyRound" class="h-3.5 w-3.5" />
                <span>主题：难题</span>
              </span>
              <span class="inline-flex items-center gap-1 rounded-full border border-neutral-200 bg-white/80 px-3 py-1 dark:border-neutral-700 dark:bg-neutral-900/70">
                <LucideIcon name="Shuffle" class="h-3.5 w-3.5" />
                <span>随机四篇 + 时间 / 随机排序</span>
              </span>
            </div>
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
      <div
        v-if="heroImageVisible && heroImageSrc"
        class="mt-6 overflow-hidden rounded-2xl border border-neutral-200/70 bg-gradient-to-r from-[rgba(var(--accent),0.08)] via-white to-white dark:border-neutral-800/70 dark:from-[rgba(var(--accent),0.08)] dark:via-neutral-900/60 dark:to-neutral-900/80"
      >
        <img
          :src="heroImageSrc"
          alt="SCP-CN-4000 题图"
          class="h-full w-full max-h-96 object-cover"
          loading="lazy"
          @error="onHeroError"
        >
      </div>
    </section>

    <section class="space-y-4">
      <h2 class="text-xl font-semibold text-neutral-900 dark:text-neutral-50">竞赛引言</h2>
      <div class="rounded-2xl border border-neutral-200/80 bg-white/85 p-6 leading-7 text-neutral-700 shadow-sm backdrop-blur dark:border-neutral-800/70 dark:bg-neutral-900/80 dark:text-neutral-300 dark:shadow-none">
        <p>当我们每一天睁开双眼，我们总能听到难题的窃窃私语。</p>
        <p class="mt-3">
          它如同任性的幽灵缓缓盘旋在我们身边，不经意之间显示出庞大如宇宙的幻影，然后悄悄把谜底置换成隐喻，轻而又轻地放在永恒的迷雾中，饶有兴味观察我们焦头烂额寻找雾中的方向，笑着窥视我们找到如黄金般珍贵的答案。然后……又轻轻一点，布下新的迷宫，撒下新的迷雾。
        </p>
        <p class="mt-3">
          我们抬眼，这个世界已遍布难题，难题接着下一个难题，甚至或许世界也不过是难题的一个同义词。然而，我们的世界已然如此，基金会的世界又将如何？
        </p>
        <p class="mt-3">
          我们在迷雾中邀请你们，基金会的爱好者们，前路有怎样的崎岖？遍布怎样的荆棘？被何种绳索束缚了双手？脚下的路是否将通向永不复返的悬崖？你们可否述说与我们听？
        </p>
        <p class="mt-3">
          以及……请述说与我们听。怎样的结局才能化作精巧的钥匙，越过一切险阻，严丝合缝地嵌入那难题之中？回首望去，这一路种种究竟遗落了什么，还是获得了什么？走到尽头的双眼中，到底映照的是满载的喜悦，还是空空的双手？
        </p>
        <p class="mt-3">请尽情述说吧，因为难题永远在那儿，毫不疲倦微笑着侧耳倾听。</p>
      </div>
    </section>

    <section class="space-y-4">
      <div class="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 class="text-xl font-semibold text-neutral-900 dark:text-neutral-50">竞赛规则</h2>
          <p class="text-sm text-neutral-500 dark:text-neutral-400">主题：难题。以下要点摘自主办方要求，便于查阅。</p>
        </div>
      </div>
      <div class="rounded-2xl border border-neutral-200/80 bg-white/85 p-6 text-sm leading-6 text-neutral-700 shadow-sm backdrop-blur dark:border-neutral-800/70 dark:bg-neutral-900/80 dark:text-neutral-300 dark:shadow-none">
        <ul class="list-disc space-y-2 pl-5">
          <li>本次主题：难题。所谓难题，究竟是已经改了20遍仍然不能满足老板的PPT，是失效的收容措施，还是K级末日，又或者，是婴儿的第一声啼哭，是已然困难的呼吸，还是再也睁不开的双眼？以上种种，都由你们来决定。</li>
          <li>参加方式：使用 <code class="rounded bg-neutral-100 px-1 py-0.5 text-xs text-neutral-700 dark:bg-neutral-800 dark:text-neutral-200">cn4000&lt;你的用户名&gt;</code> 作为条目的网址名称（用户名即 Wikidot 头像旁显示的名称），且条目必须由作者本人发布。</li>
          <li>页面标题格式：SCP-CN-4000：&lt;作品标题&gt;，可使用初始内容的原创文档模板进行评分模组的添加。</li>
          <li>多人参赛需包含所有参与写作的用户名称；若有合著，所有合著者均应拥有网站成员资格，并建议保留合作记录以便认领与争议处理。</li>
          <li>每位作者仅能发布一个作品；若已参与一篇合著，则所有合著者皆不可投稿第2篇合著或独立条目参赛。</li>
          <li>参赛作品需带有标签：cn4000，以便在本页展示。</li>
          <li>作品发布后仍按一般删除流程处理；可编辑但大幅度编辑仅限投稿期间。</li>
          <li>竞赛导语、题图不代表主办方任何提示或倾向，创作内容可自由发挥。</li>
          <li>优胜条目可获得正式的 SCP-CN-4000 编号。如得分相同，取 upvote 比例最高者。</li>
          <li>发布后请在评论区声明除 SCP-CN-4000 外的5个心仪编号，比赛结束将按分数与评论意向进行系列5编号选择；未声明视为放弃优先权，将按顺序指派空编号。</li>
          <li>先行完工但未正式发布的草稿可参赛；有意参赛者可在主题公布后立即开始写作，不建议临近投稿截止赶稿。</li>
          <li>如发现以非常规手段操作分数，可能取消参赛资格并追加处分。非常规情形示例：以任何 Wikidot 私信方式宣传作品；在竞争对手发布数秒至分钟内打低分；大肆张扬对他人参赛作品的打分；用小号或与文章内容无关的理由投票（恶意投票）。站务可采取额外筛选措施，一经查实有追回票数与奖项的权利。</li>
          <li>在 Wikidot 外的社群频繁宣传参赛条目可能会被关切；如有未尽事宜，请私信主办工作人员获取进一步信息。</li>
        </ul>
      </div>
    </section>

    <section class="space-y-4">
      <div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 class="text-xl font-semibold text-neutral-900 dark:text-neutral-50">赛程节点</h2>
          <p class="text-sm text-neutral-500 dark:text-neutral-400">北京时间（GMT+08），实时显示距离下一关键时间的倒计时。</p>
        </div>
      </div>
      <div class="grid gap-4 md:grid-cols-2">
        <div
          v-for="phase in phaseStates"
          :key="phase.key"
          class="relative rounded-2xl border p-5 transition-colors"
          :class="[
            'border-neutral-200/80 bg-white/80 dark:border-neutral-800/70 dark:bg-neutral-900/80 backdrop-blur',
            phase.key === nextPhaseKey || phase.status === 'ongoing' ? 'ring-2 ring-[rgba(var(--accent),0.65)]' : ''
          ]"
        >
          <div class="flex items-start justify-between gap-4">
            <div>
              <div class="text-sm font-semibold text-neutral-900 dark:text-neutral-100">{{ phase.label }}</div>
              <div class="mt-1 text-xs text-neutral-500 dark:text-neutral-400">{{ phase.display }}</div>
            </div>
            <span
              class="rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
              :class="phase.status === 'ended' ? 'bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400' : 'bg-[rgba(var(--accent),0.12)] text-[rgb(var(--accent))]'"
            >
              {{ phase.status === 'upcoming' ? '未开始' : phase.status === 'ongoing' ? '进行中' : '已结束' }}
            </span>
          </div>
          <div class="mt-4 font-mono text-2xl font-semibold text-neutral-900 dark:text-neutral-50">
            {{ phase.countdown }}
          </div>
          <div class="mt-1 text-xs text-neutral-500 dark:text-neutral-400">{{ phase.countdownLabel }}</div>
        </div>
      </div>
    </section>

    <section class="space-y-4">
      <div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 class="text-xl font-semibold text-neutral-900 dark:text-neutral-50">雾中先声 · 随机四篇</h2>
          <p class="text-sm text-neutral-500 dark:text-neutral-400">从“cn4000”标签的作品中随机选出四篇，换一批即可重新抽取。</p>
        </div>
        <button
          type="button"
          class="inline-flex items-center gap-1 rounded-full border border-neutral-200 px-3 py-1.5 text-xs font-medium text-neutral-600 transition hover:border-[rgba(var(--accent),0.5)] hover:text-[rgb(var(--accent))] dark:border-neutral-700 dark:text-neutral-300"
          @click="refreshHighlights"
          :disabled="entriesPending"
        >
          <LucideIcon name="RotateCw" class="h-3.5 w-3.5" />
          <span>换一批</span>
        </button>
      </div>
      <div v-if="entriesPending" class="rounded-2xl border border-dashed border-neutral-200/60 bg-white/60 p-6 text-center text-sm text-neutral-500 dark:border-neutral-800/60 dark:bg-neutral-900/60 dark:text-neutral-400">
        正在加载参赛作品…
      </div>
      <div v-else-if="entriesError" class="rounded-2xl border border-red-200 bg-red-50 p-5 text-sm text-red-600 dark:border-red-800 dark:bg-red-900/20 dark:text-red-300">
        加载参赛作品失败：{{ entriesError.message || entriesError }}
      </div>
      <div v-else-if="highlightCards.length === 0" class="rounded-2xl border border-dashed border-neutral-200/60 bg-white/70 p-6 text-center text-sm text-neutral-500 dark:border-neutral-800/60 dark:bg-neutral-900/70 dark:text-neutral-400">
        暂未收录带有“cn4000”标签的作品。
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
            当前共 {{ entriesCount }} 篇作品，全部包含“cn4000”标签，可按发布时间或随机顺序浏览。
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
            @click="reshuffleAll"
            :disabled="entriesPending"
          >
            <LucideIcon name="Shuffle" class="h-3.5 w-3.5" />
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
          暂未收录带有“cn4000”标签的作品。
        </div>
        <div v-else class="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          <PageCard v-for="(entry, idx) in displayedEntries" :key="entry.wikidotId ?? entry.title ?? idx" size="md" :p="entry" />
        </div>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch, watchEffect } from 'vue'
import { useAsyncData, useNuxtApp, useRuntimeConfig } from 'nuxt/app'
import LucideIcon from '~/components/LucideIcon.vue'
import { useViewerVotes } from '~/composables/useViewerVotes'
import { orderTags } from '~/composables/useTagOrder'
import { normalizeBffBase, resolveWithFallback } from '~/utils/assetUrl'
import { useAuth } from '~/composables/useAuth'

import PageCard from '~/components/PageCard.vue'

definePageMeta({ title: 'SCP-CN-4000 “难题”竞赛', key: 'scpcn4k' })

const isClient = typeof window !== 'undefined'
const runtimeConfig = useRuntimeConfig()
const bffBase = normalizeBffBase((runtimeConfig?.public as any)?.bffBase)
const { user, fetchCurrentUser } = useAuth()
const TARGET_EMAIL = 'andyblocker0@gmail.com'
const isTrackingTarget = computed(() => (user.value?.email || '').toLowerCase() === TARGET_EMAIL)

const HERO_PAGE_ID = '1465568835'
const HERO_FALLBACK_URL = 'https://05command-cn.wdfiles.com/local--files/collab%3Aimage-collection/CN-4K%E9%A2%98%E5%9B%BE.jpg'

const heroImageSrc = ref<string | null>(HERO_FALLBACK_URL)
const heroImageVisible = ref(true)
function onHeroError() {
  if (heroImageSrc.value && heroImageSrc.value !== HERO_FALLBACK_URL) {
    heroImageSrc.value = HERO_FALLBACK_URL
    heroImageVisible.value = Boolean(heroImageSrc.value)
    return
  }
  heroImageVisible.value = false
}

const { data: heroImagesData } = await useAsyncData(
  'scpcn4k-hero-images',
  () => $bff(`/pages/${HERO_PAGE_ID}/images`),
  { server: false }
)

watch(
  heroImagesData,
  images => {
    let next = HERO_FALLBACK_URL
    if (Array.isArray(images) && images.length > 0) {
      const primary = images.find(img => img?.imageUrl || img?.displayUrl || img?.originUrl)
      if (primary) {
        const resolved = resolveWithFallback(
          primary.imageUrl as string,
          (primary.displayUrl ?? primary.originUrl) as string | null | undefined,
          bffBase,
          { variant: 'low' }
        )
        next = resolved || HERO_FALLBACK_URL
      }
    }
    heroImageSrc.value = next
    heroImageVisible.value = Boolean(next)
  },
  { immediate: true }
)

const phases = [
  {
    key: 'submission',
    label: '条目投稿期间',
    startIso: '2025-12-01T00:00:00+08:00',
    endIso: '2025-12-05T23:59:59+08:00',
    display: '北京时间 2025年12月1日 00时00分 - 2025年12月5日 23时59分'
  },
  {
    key: 'voting',
    label: '投票期间',
    startIso: '2025-12-06T00:00:00+08:00',
    endIso: '2025-12-25T23:59:59+08:00',
    display: '北京时间 2025年12月6日 00时00分 - 2025年12月25日 23时59分'
  }
] as const

const phaseTargets = phases.map(phase => ({
  ...phase,
  startTs: new Date(phase.startIso).getTime(),
  endTs: new Date(phase.endIso).getTime()
}))

const nowTick = ref(Date.now())
let timer: ReturnType<typeof setInterval> | null = null

onMounted(() => {
  timer = setInterval(() => {
    nowTick.value = Date.now()
  }, 1000)
  void fetchCurrentUser()
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

const phaseStates = computed(() => {
  const now = nowTick.value
  return phaseTargets.map(phase => {
    let status: 'upcoming' | 'ongoing' | 'ended' = 'upcoming'
    let diff: number
    let label: string
    if (now < phase.startTs) {
      status = 'upcoming'
      diff = phase.startTs - now
      label = '距离开始'
    } else if (now <= phase.endTs) {
      status = 'ongoing'
      diff = phase.endTs - now
      label = '距离结束'
    } else {
      status = 'ended'
      diff = now - phase.endTs
      label = '结束后已过去'
    }
    return {
      key: phase.key,
      label: phase.label,
      display: phase.display,
      status,
      countdown: formatDuration(diff),
      countdownLabel: label
    }
  })
})

const nextPhaseKey = computed(() => {
  const now = nowTick.value
  const ongoing = phaseTargets.find(phase => now >= phase.startTs && now <= phase.endTs)
  if (ongoing) return ongoing.key
  const upcoming = phaseTargets.filter(phase => now < phase.startTs)
  if (!upcoming.length) return null
  return upcoming.reduce((prev, curr) => (curr.startTs < prev.startTs ? curr : prev)).key
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

const { data: entriesData, pending: entriesPendingRef, error: entriesErrorRef } = await useAsyncData('scpcn4k-entries', async () => {
  const resp = await $bff('/search/pages', {
    params: {
      tags: ['cn4000'],
      limit: 400,
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
const trackingFlags = ref<Record<number, boolean>>({})
const trackingLoading = new Set<number>()

function hasPendingDeletion(tags: string[] | undefined) {
  if (!Array.isArray(tags) || tags.length === 0) return false
  return tags.some(tag => tag.toLowerCase() === '待删除')
}

function hasCenterTag(tags: string[] | undefined) {
  if (!Array.isArray(tags) || tags.length === 0) return false
  return tags.some(tag => tag.toLowerCase() === '中心')
}

function stripCn4000Prefix(title?: string | null) {
  if (!title) return title ?? ''
  return title.replace(/^SCP-CN-4000[:：]\s*/i, '')
}

async function ensureTrackingFlag(wikidotId: number) {
  if (!isClient || !isTrackingTarget.value) return
  if (trackingFlags.value[wikidotId] !== undefined || trackingLoading.has(wikidotId)) return
  trackingLoading.add(wikidotId)
  try {
    const resp = await $bff(`/pages/${wikidotId}/source`)
    const source = typeof resp?.source === 'string' ? resp.source.toLowerCase() : ''
    const hasModule = source.includes('[[include component:scpper-tracking-module')
    trackingFlags.value = { ...trackingFlags.value, [wikidotId]: hasModule }
  } catch (error) {
    trackingFlags.value = { ...trackingFlags.value, [wikidotId]: false }
  } finally {
    trackingLoading.delete(wikidotId)
  }
}

function queueTrackingFor(entries: Array<{ wikidotId?: number | string | null }>) {
  if (!isClient || !isTrackingTarget.value) return
  const ids = new Set<number>()
  for (const entry of entries) {
    const id = Number(entry?.wikidotId)
    if (!Number.isInteger(id) || id <= 0) continue
    if (trackingFlags.value[id] !== undefined) continue
    ids.add(id)
  }
  ids.forEach(id => {
    void ensureTrackingFlag(id)
  })
}

const filteredEntries = computed<Entry[]>(() =>
  rawEntries.value.filter(entry => !entry.isDeleted && !hasPendingDeletion(entry.tags) && !hasCenterTag(entry.tags))
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
  const wid = Number(entry.wikidotId)
  const trackingModule = Number.isInteger(wid) ? trackingFlags.value[wid] === true : false
  return {
    wikidotId: entry.wikidotId,
    title: stripCn4000Prefix(entry.title),
    alternateTitle: stripCn4000Prefix(entry.alternateTitle),
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
    sparkPoints: entry.sparkPoints ?? null,
    trackingModule
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
  const sampled = shuffle(list).slice(0, 4)
  highlightEntries.value = sampled
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
  if (!Array.isArray(list) || list.length === 0) {
    highlightEntries.value = []
    randomEntries.value = []
    return
  }
  resampleHighlights()
  reshuffleEntries()
}, { immediate: true })

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

watchEffect(() => {
  if (!isClient || !isTrackingTarget.value) return
  const targets: Array<{ wikidotId?: number | string | null }> = []
  if (Array.isArray(highlightEntries.value)) targets.push(...highlightEntries.value)
  if (Array.isArray(displayedEntries.value)) targets.push(...displayedEntries.value)
  if (targets.length > 0) {
    queueTrackingFor(targets)
  }
})

function refreshHighlights() {
  if (rawEntries.value.length === 0) return
  resampleHighlights()
}

function reshuffleAll() {
  if (rawEntries.value.length === 0) return
  reshuffleEntries()
}
</script>
