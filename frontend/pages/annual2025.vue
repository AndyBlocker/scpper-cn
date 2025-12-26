<template>
  <div class="annual-summary bg-[rgb(var(--bg))] text-[rgb(var(--fg))] min-h-screen w-full font-sans">
    <!-- 无数据确认弹窗 -->
    <Teleport to="body">
      <div v-if="showNoDataConfirm" class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
        <div class="bg-[rgb(var(--panel))] border border-[rgb(var(--panel-border))] rounded-2xl p-6 md:p-8 max-w-md w-full shadow-2xl">
          <div class="flex items-center gap-3 mb-4">
            <div class="w-12 h-12 bg-amber-500/20 rounded-full flex items-center justify-center">
              <LucideIcon name="AlertTriangle" class="w-6 h-6 text-amber-500" />
            </div>
            <div>
              <h3 class="text-lg font-bold text-[rgb(var(--fg))]">未找到个人数据</h3>
              <p class="text-sm text-[rgb(var(--muted))]">{{ pendingUsername }}</p>
            </div>
          </div>
          <p class="text-[rgb(var(--muted))] text-sm mb-6">
            该用户在 2025 年没有创作或投票记录，无法生成个人年度报告。<br><br>
            你可以继续浏览站点年度数据，或返回重新输入用户名。
          </p>
          <div class="flex gap-3">
            <button
              @click="cancelNoDataConfirm"
              class="flex-1 px-4 py-2.5 bg-transparent border border-[rgb(var(--panel-border))] text-[rgb(var(--fg))] rounded-lg font-medium transition-colors hover:border-[rgb(var(--accent))]"
            >
              返回
            </button>
            <button
              @click="confirmNoDataContinue"
              class="flex-1 px-4 py-2.5 bg-[rgb(var(--accent))] hover:bg-[rgb(var(--accent-strong))] text-white rounded-lg font-medium transition-colors"
            >
              继续浏览
            </button>
          </div>
        </div>
      </div>
    </Teleport>

    <Annual2025Login
      v-if="!hasStarted"
      v-model="usernameInput"
      :is-loading="isLoading"
      :load-error="loadError"
      :users-count="usersIndex?.totalCount || 0"
      @submit="handleLogin"
      @enter-site="enterSiteDataOnly"
      @clear-error="loadError = null"
    />

    <template v-else>
      <Annual2025ProgressNav
        :progress-percent="progressPercent"
        :slide-labels="visibleSlideLabels"
        :current-slide-index="currentSlideIndex"
        :total-slides="visibleSlides.length"
        @scroll-to-slide="scrollToSlide"
      />

      <div
        ref="containerRef"
        class="h-screen w-full overflow-y-scroll scroll-smooth no-scrollbar relative"
        :class="isMobile ? 'snap-none' : 'snap-y snap-mandatory'"
        @scroll="handleScroll"
      >
        <Annual2025IntroSlide :is-active="getSlideActive('intro')" />
        <Annual2025SiteOverviewSlide :is-active="getSlideActive('site-overview')" :site-data="siteData" />
        <Annual2025ContentBreakdownSlide :is-active="getSlideActive('content-breakdown')" :site-data="siteData" />
        <Annual2025TopContributorsSlide :is-active="getSlideActive('top-contributors')" :site-data="siteData" />
        <Annual2025CategoryBestSlide :is-active="getSlideActive('category-best')" :site-data="siteData" />
        <Annual2025RecordsSlide :is-active="getSlideActive('records')" :site-data="siteData" />
        <Annual2025TrendsSlide :is-active="getSlideActive('trends')" :site-data="siteData" />
        <Annual2025VoteAnalyticsSlide :is-active="getSlideActive('vote-analytics')" :site-data="siteData" />
        <Annual2025RevisionTimeSlide :is-active="getSlideActive('revision-time')" :site-data="siteData" />
        <Annual2025InterestingStatsSlide :is-active="getSlideActive('interesting-stats')" :site-data="siteData" />
        <Annual2025ScpDetailsSlide
          :is-active="getSlideActive('scp-details')"
          :site-data="siteData"
          :category-helpers="categoryHelpers"
          :is-mobile="isMobile"
        />
        <Annual2025CategoryDetailsSlide
          :is-active="getSlideActive('category-story')"
          category-key="故事"
          :site-data="siteData"
          :category-helpers="categoryHelpers"
          :is-mobile="isMobile"
        />
        <Annual2025CategoryDetailsSlide
          :is-active="getSlideActive('category-goi')"
          category-key="goi格式"
          :site-data="siteData"
          :category-helpers="categoryHelpers"
          :is-mobile="isMobile"
        />
        <Annual2025CategoryDetailsSlide
          :is-active="getSlideActive('category-art')"
          category-key="艺术作品"
          :site-data="siteData"
          :category-helpers="categoryHelpers"
          :is-mobile="isMobile"
        />
        <Annual2025CategoryDetailsSlide
          :is-active="getSlideActive('category-wanderers')"
          category-key="wanderers"
          :site-data="siteData"
          :category-helpers="categoryHelpers"
          :is-mobile="isMobile"
        />
        <Annual2025CategoryDetailsSlide
          :is-active="getSlideActive('category-article')"
          category-key="文章"
          :site-data="siteData"
          :category-helpers="categoryHelpers"
          :is-mobile="isMobile"
        />
        <Annual2025DeletedPagesSlide :is-active="getSlideActive('deleted-pages')" :site-data="siteData" />
        <!-- 用户数据相关页面：仅在有用户数据时显示 -->
        <Annual2025UserIdentitySlide
          v-if="hasUserData"
          :is-active="getSlideActive('user-identity')"
          :has-user-data="hasUserData"
          :user-data="userData"
          :is-mobile="isMobile"
        />
        <Annual2025CreativeDnaSlide
          v-if="hasUserData"
          :is-active="getSlideActive('creative-dna')"
          :has-user-data="hasUserData"
          :user-data="userData"
          :site-data="siteData"
        />
        <Annual2025AchievementsSlide
          v-if="hasUserData"
          :is-active="getSlideActive('achievements')"
          :has-user-data="hasUserData"
          :user-data="userData"
        />
        <Annual2025VotingStyleSlide
          v-if="hasUserData"
          :is-active="getSlideActive('voting-style')"
          :has-user-data="hasUserData"
          :user-data="userData"
          :site-data="siteData"
        />
        <Annual2025ShareCardSlide
          v-if="hasUserData"
          :is-active="getSlideActive('share-card')"
          :has-user-data="hasUserData"
          :user-data="userData"
        />
        <!-- 无用户数据时的结束页面 -->
        <Annual2025NoDataEndSlide
          v-if="!hasUserData"
          :is-active="getSlideActive('no-data-end')"
          @restart="handleRestart"
        />
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, nextTick } from 'vue'
import type { SiteData, UserData, UsersIndex } from '~/types/annual2025'
import { useAnnual2025Data } from '~/composables/useAnnual2025Data'

declare const $fetch: any

definePageMeta({
  layout: 'blank',
  ssr: false
})

useHead({
  title: 'SCPper CN 2025 年度报告'
})

const hasStarted = ref(false)
const usernameInput = ref('')
const isLoading = ref(false)
const loadError = ref<string | null>(null)
const currentSlideIndex = ref(0)
const containerRef = ref<HTMLElement | null>(null)
const isMobile = ref(false)

// 无数据确认弹窗状态
const showNoDataConfirm = ref(false)
const pendingUsername = ref('')

const updateIsMobile = () => {
  if (typeof window === 'undefined') return
  isMobile.value = window.innerWidth < 768
}

const rawSiteData = ref<SiteData | null>(null)
const rawUserData = ref<UserData | null>(null)
const usersIndex = ref<UsersIndex | null>(null)

const { siteData, userData, categoryHelpers } = useAnnual2025Data(rawSiteData, rawUserData)

const hasUserData = computed(() => !!rawUserData.value)

// 定义所有 slide 的 key 和 label
interface SlideInfo {
  key: string
  label: string
  requiresUserData?: boolean
}

const allSlideInfos: SlideInfo[] = [
  { key: 'intro', label: '开场' },
  { key: 'site-overview', label: '全站概览' },
  { key: 'content-breakdown', label: '内容分布' },
  { key: 'top-contributors', label: '贡献者' },
  { key: 'category-best', label: '分类最佳' },
  { key: 'records', label: '极限数据' },
  { key: 'trends', label: '趋势' },
  { key: 'vote-analytics', label: '投票分析' },
  { key: 'revision-time', label: '编辑时间' },
  { key: 'interesting-stats', label: '有趣数据' },
  { key: 'scp-details', label: 'SCP' },
  { key: 'category-story', label: '故事' },
  { key: 'category-goi', label: 'GOI格式' },
  { key: 'category-art', label: '艺术作品' },
  { key: 'category-wanderers', label: '图书馆' },
  { key: 'category-article', label: '文章' },
  { key: 'deleted-pages', label: '删除页面' },
  // 用户数据相关 slides
  { key: 'user-identity', label: '个人概览', requiresUserData: true },
  { key: 'creative-dna', label: '创作数据', requiresUserData: true },
  { key: 'achievements', label: '成就', requiresUserData: true },
  { key: 'voting-style', label: '投票风格', requiresUserData: true },
  { key: 'share-card', label: '分享', requiresUserData: true },
  // 无数据结束页
  { key: 'no-data-end', label: '结束' }
]

// 根据是否有用户数据过滤可见 slides
const visibleSlides = computed(() => {
  if (hasUserData.value) {
    // 有用户数据：显示所有 slides，除了 no-data-end
    return allSlideInfos.filter(s => s.key !== 'no-data-end')
  } else {
    // 无用户数据：显示站点 slides + no-data-end
    return allSlideInfos.filter(s => !s.requiresUserData || s.key === 'no-data-end')
  }
})

const visibleSlideLabels = computed(() => visibleSlides.value.map(s => s.label))

// 根据 slide key 获取当前是否为活跃状态
const getSlideActive = (key: string): boolean => {
  const idx = visibleSlides.value.findIndex(s => s.key === key)
  return idx === currentSlideIndex.value
}

const progressPercent = computed(() => {
  const total = visibleSlides.value.length
  return total > 1 ? (currentSlideIndex.value / (total - 1)) * 100 : 0
})

onMounted(async () => {
  try {
    const [site, users] = await Promise.all([
      $fetch('/annual-summary/2025/site.json'),
      $fetch('/annual-summary/2025/users/index.json')
    ])
    rawSiteData.value = site
    usersIndex.value = users
  } catch (e) {
    console.error('Failed to load site data:', e)
  }
})

async function handleLogin() {
  if (!usernameInput.value.trim()) return
  isLoading.value = true
  loadError.value = null

  const inputName = usernameInput.value.trim().toLowerCase()

  try {
    if (!usersIndex.value) {
      throw new Error('用户索引数据未加载，请刷新页面重试')
    }

    const isMatch = (value: unknown) => {
      return typeof value === 'string' && value.trim().toLowerCase() === inputName
    }

    const userEntry = Object.entries(usersIndex.value.users).find(
      ([_, user]) => isMatch(user.userName) || isMatch(user.displayName)
    )

    if (!userEntry) {
      // 用户不存在，显示确认弹窗
      isLoading.value = false
      pendingUsername.value = usernameInput.value.trim()
      showNoDataConfirm.value = true
      return
    }

    const [userId, userMeta] = userEntry

    if (!userMeta.hasOriginals && !userMeta.hasTranslations && !userMeta.hasVotes) {
      // 用户存在但没有数据，显示确认弹窗
      isLoading.value = false
      pendingUsername.value = usernameInput.value.trim()
      showNoDataConfirm.value = true
      return
    }

    const userDataResponse = await $fetch(`/annual-summary/2025/users/${userId}.json`)
    rawUserData.value = userDataResponse

    isLoading.value = false
    hasStarted.value = true
    nextTick(() => {
      currentSlideIndex.value = 0
    })
  } catch (e: any) {
    isLoading.value = false
    if (e.statusCode === 404 || e.status === 404) {
      // 用户数据文件不存在，显示确认弹窗
      pendingUsername.value = usernameInput.value.trim()
      showNoDataConfirm.value = true
    } else {
      loadError.value = e.message || '加载用户数据失败'
    }
    console.error('Failed to load user data:', e)
  }
}

function cancelNoDataConfirm() {
  showNoDataConfirm.value = false
  pendingUsername.value = ''
}

function confirmNoDataContinue() {
  showNoDataConfirm.value = false
  pendingUsername.value = ''
  rawUserData.value = null
  hasStarted.value = true
  nextTick(() => {
    currentSlideIndex.value = 0
  })
}

function enterSiteDataOnly() {
  rawUserData.value = null
  hasStarted.value = true
  nextTick(() => {
    currentSlideIndex.value = 0
  })
}

function handleRestart() {
  hasStarted.value = false
  currentSlideIndex.value = 0
  rawUserData.value = null
  usernameInput.value = ''
  loadError.value = null
}

function handleScroll() {
  if (!containerRef.value) return
  const slides = Array.from(containerRef.value.querySelectorAll<HTMLElement>('.slide'))
  const scrollPos = containerRef.value.scrollTop + containerRef.value.clientHeight / 2
  let closestIdx = 0
  let smallestDiff = Infinity
  slides.forEach((el, idx) => {
    const top = el.offsetTop
    const height = el.offsetHeight
    const center = top + height / 2
    const diff = Math.abs(center - scrollPos)
    if (diff < smallestDiff) {
      smallestDiff = diff
      closestIdx = idx
    }
  })
  currentSlideIndex.value = closestIdx
}

function scrollToSlide(index: number) {
  if (!containerRef.value) return
  const slides = containerRef.value.querySelectorAll<HTMLElement>('.slide')
  const target = slides[index]
  if (!target) return
  containerRef.value.scrollTo({
    top: target.offsetTop,
    behavior: 'smooth'
  })
}

function handleKeyDown(e: KeyboardEvent) {
  if (!hasStarted.value) return
  const maxIndex = visibleSlides.value.length - 1
  if (e.key === 'ArrowDown' || e.key === ' ') {
    e.preventDefault()
    scrollToSlide(Math.min(currentSlideIndex.value + 1, maxIndex))
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    scrollToSlide(Math.max(currentSlideIndex.value - 1, 0))
  }
}

onMounted(() => {
  window.addEventListener('keydown', handleKeyDown)
  updateIsMobile()
  window.addEventListener('resize', updateIsMobile)
})

onUnmounted(() => {
  window.removeEventListener('keydown', handleKeyDown)
  window.removeEventListener('resize', updateIsMobile)
})
</script>

<style scoped>
.annual-summary {
  --slide-transition: 0.6s ease-out;
  --bar-day: 14 165 233;
  --bar-night: 99 102 241;
  --bar-peak: 245 158 11;
}

.annual-summary :deep(.slide) {
  @apply min-h-screen w-full snap-start flex flex-col items-center p-3 md:p-8 relative;
  overflow-y: auto;
  overflow-x: hidden;
  justify-content: center;
}

@media (max-width: 768px) {
  .annual-summary :deep(.slide) {
    padding-top: 3.5rem;
    padding-bottom: 2.5rem;
    justify-content: flex-start;
    align-items: stretch;
  }
  .annual-summary :deep(.slide-content) {
    min-height: calc(100vh - 120px);
    justify-content: center;
    gap: 1.25rem;
    opacity: 1;
    transform: none;
    transition: none;
  }
}

.annual-summary :deep(.slide-content) {
  @apply w-full max-w-5xl z-10 flex flex-col justify-center transition-all duration-700 ease-out;
  opacity: 0;
  transform: translateY(40px) scale(0.95);
}

.annual-summary :deep(.slide-active .slide-content) {
  opacity: 1;
  transform: translateY(0) scale(1);
}

.annual-summary :deep(.slide-bg) {
  @apply absolute inset-0 -z-10 pointer-events-none overflow-hidden;
}

.annual-summary :deep(.bento-card) {
  @apply bg-[rgb(var(--panel))] backdrop-blur-md border border-[rgb(var(--panel-border))] rounded-xl md:rounded-2xl p-3 md:p-6 flex flex-col relative overflow-hidden;
  @apply hover:border-[rgba(var(--accent),0.3)] transition-all duration-500;
}

.annual-summary :deep(.bento-header) {
  @apply flex items-center justify-between mb-2 md:mb-4 relative z-10;
}

.annual-summary :deep(.bar-track) {
  @apply bg-[rgba(var(--fg),0.12)] rounded-full flex;
}

/* 水平 bar 基础样式 */
.annual-summary :deep(.bar-fill-x) {
  transform: scaleX(0);
  transform-origin: left center;
  opacity: 0.85;
  transition: transform 0.8s ease, opacity 0.8s ease;
  transition-delay: var(--bar-delay, 0ms);
  will-change: transform;
  border-radius: 0;
}

/* 水平 bar 圆角逻辑：第一个左圆角，最后一个右圆角 */
.annual-summary :deep(.bar-fill-x:first-child) {
  border-radius: 9999px 0 0 9999px;
}

.annual-summary :deep(.bar-fill-x:last-child) {
  border-radius: 0 9999px 9999px 0;
}

/* 单独 bar（既是第一个又是最后一个）：两边都圆角 */
.annual-summary :deep(.bar-fill-x:first-child:last-child) {
  border-radius: 9999px;
}

/* 垂直 bar 基础样式 */
.annual-summary :deep(.bar-fill-y) {
  transform: scaleY(0);
  transform-origin: center bottom;
  opacity: 0.8;
  transition: transform 0.8s ease, opacity 0.8s ease;
  transition-delay: var(--bar-delay, 0ms);
  will-change: transform;
  border-radius: 4px 4px 0 0;
}

.annual-summary :deep(.slide-active .bar-fill-x) {
  transform: scaleX(1);
  opacity: 1;
}

.annual-summary :deep(.slide-active .bar-fill-y) {
  transform: scaleY(1);
  opacity: 1;
}

.annual-summary :deep(.bar-value) {
  @apply text-[9px] md:text-[10px] font-semibold tracking-tight;
}

.annual-summary :deep(.bar-axis) {
  @apply text-[8px] md:text-[9px] text-[rgb(var(--muted))] whitespace-nowrap;
}

.annual-summary :deep(.bar-meta) {
  @apply text-[10px] md:text-xs text-[rgb(var(--muted))];
}

.annual-summary :deep(.clock-plot) {
  @apply relative flex items-center justify-center;
}

.annual-summary :deep(.clock-ring) {
  stroke: rgba(var(--fg), 0.12);
  stroke-width: 1.2;
  fill: none;
}

.annual-summary :deep(.clock-core) {
  fill: rgb(var(--bg));
  stroke: rgba(var(--fg), 0.08);
  stroke-width: 1;
}

.annual-summary :deep(.clock-bar) {
  stroke-linecap: round;
  stroke-width: 6;
  stroke-dasharray: var(--clock-length);
  stroke-dashoffset: var(--clock-length);
  opacity: 0.4;
  transition: stroke-dashoffset 0.9s ease var(--bar-delay, 0ms), opacity 0.9s ease var(--bar-delay, 0ms);
}

.annual-summary :deep(.slide-active .clock-bar) {
  stroke-dashoffset: 0;
  opacity: 1;
}

.annual-summary :deep(.clock-label) {
  fill: rgb(var(--muted));
  font-size: 8px;
  font-weight: 600;
}

.annual-summary :deep(.contributor-card) {
  @apply bg-gradient-to-b from-[rgb(var(--panel))] to-[rgb(var(--bg))] border rounded-2xl p-6 relative flex flex-col items-center text-center;
  @apply transform hover:-translate-y-2 transition-transform duration-500 shadow-xl;
}

.annual-summary :deep(.contributor-card-mini) {
  @apply bg-[rgb(var(--panel))] border rounded-xl p-4 relative overflow-hidden;
  @apply hover:bg-[rgba(var(--fg),0.03)] transition-all duration-300;
}

.annual-summary :deep(.contributor-avatar) {
  @apply w-12 h-12 rounded-full flex items-center justify-center border text-lg font-bold flex-shrink-0;
}

.annual-summary :deep(.no-scrollbar::-webkit-scrollbar) {
  display: none;
}
.annual-summary :deep(.no-scrollbar) {
  -ms-overflow-style: none;
  scrollbar-width: none;
}

@keyframes fade-in-up {
  from {
    opacity: 0;
    transform: translateY(20px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.annual-summary :deep(.animate-fade-in-up) {
  animation: fade-in-up 0.6s ease-out forwards;
}

@keyframes shimmer {
  0% { transform: translateX(-100%); }
  100% { transform: translateX(100%); }
}

.annual-summary :deep(.animate-shimmer) {
  animation: shimmer 1.5s infinite;
}
</style>
