<template>
  <div class="sample-page">
    <!-- Ambient Background -->
    <div class="ambient-bg">
      <div class="glow glow-1"></div>
      <div class="glow glow-2"></div>
      <div class="noise-layer"></div>
    </div>

    <div class="page-container">
      <!-- Search Hero Section -->
      <section class="search-hero">
        <div class="search-hero-content">
          <div class="brand-mark">
            <BrandIcon class="w-12 h-12 text-[rgb(var(--accent))]" />
          </div>
          <p class="hero-kicker">SCPper CN 数据主页</p>
          <h1 class="hero-title">SCPPER <span class="hero-accent">CN</span></h1>

          <div class="search-box-wrapper">
            <form class="search-box" @submit.prevent="onHeroSearch">
              <LucideIcon name="Search" class="search-icon" />
              <input
                v-model="heroQuery"
                type="text"
                placeholder="搜索页面、文档或标签..."
                class="search-input"
              />
              <button type="submit" class="search-btn" aria-label="搜索">
                <LucideIcon name="ArrowRight" class="w-5 h-5" />
              </button>
            </form>
          </div>
        </div>
      </section>

      <!-- Activity Pulse -->
      <section class="pulse-strip">
        <div v-for="stat in pulseStats" :key="stat.label" class="pulse-card">
          <span class="pulse-label">{{ stat.label }}</span>
          <span class="pulse-value">{{ formatNumber(stat.value) }}</span>
          <span class="pulse-meta">{{ stat.meta }}</span>
        </div>
      </section>

      <!-- Featured Banner -->
      <section class="featured-banner">
        <NuxtLink to="/sample/page" class="banner-link">
          <div class="banner-bg"></div>
          <div class="banner-content">
            <div class="banner-badge">
              <LucideIcon name="Sparkles" class="w-3 h-3" />
              竞赛专题
            </div>
            <div class="banner-text">
              <h2 class="banner-title">SCP-CN-4000 "难题"竞赛</h2>
              <p class="banner-desc">我们的世界已然如此，基金会的世界又将如何？探索未知，挑战极限。</p>
            </div>
            <div class="banner-action">
              <span>立即前往</span>
              <LucideIcon name="ArrowRight" class="w-4 h-4 group-hover:translate-x-1 transition-transform" />
            </div>
          </div>
        </NuxtLink>
      </section>

      <!-- Main Content Grid -->
      <div class="content-grid">
        <main class="main-column">
          <!-- Recent Created -->
          <section class="content-section">
            <div class="section-header">
              <div class="title-group">
                <LucideIcon name="Zap" class="section-icon" />
                <h3 class="section-title">近期新增</h3>
              </div>
              <NuxtLink to="/search" class="more-link">查看全部</NuxtLink>
            </div>
            <div class="card-list">
              <PageCard
                v-for="page in recentCreatedPages"
                :key="page.id"
                size="md"
                :title="page.title"
                :alternate-title="page.subtitle"
                :authors="page.authors"
                :date-iso="page.date"
                :rating="page.rating"
                :comments="page.comments"
                :tags="page.tags"
                :excerpt="page.excerpt"
                :to="page.to"
              />
            </div>
          </section>

          <!-- Recent Modified -->
          <section class="content-section">
            <div class="section-header">
              <div class="title-group">
                <LucideIcon name="History" class="section-icon" />
                <h3 class="section-title">近期更新</h3>
              </div>
              <NuxtLink to="/search" class="more-link">查看全部</NuxtLink>
            </div>
            <div class="update-list">
              <NuxtLink
                v-for="item in recentUpdatedPages"
                :key="item.id"
                :to="item.to"
                class="update-card"
              >
                <div class="update-main">
                  <div class="update-title">{{ item.title }}</div>
                  <div class="update-summary">{{ item.summary }}</div>
                  <div class="update-meta">
                    <span class="update-chip">{{ item.change }}</span>
                    <span class="update-editor">by {{ item.editor }}</span>
                    <span class="update-time">{{ item.time }}</span>
                  </div>
                </div>
                <div class="update-rating">
                  <span class="update-score">{{ item.rating }}</span>
                  <span :class="['update-delta', item.delta > 0 ? 'up' : 'down']">
                    {{ item.delta > 0 ? '+' : '' }}{{ item.delta }}
                  </span>
                </div>
              </NuxtLink>
            </div>
          </section>

          <!-- Featured Modules -->
          <section class="content-section">
            <div class="section-header">
              <div class="title-group">
                <LucideIcon name="Layers" class="section-icon" />
                <h3 class="section-title">专题与精选</h3>
              </div>
              <NuxtLink to="/tools" class="more-link">查看更多</NuxtLink>
            </div>
            <div class="feature-grid">
              <NuxtLink
                v-for="feature in featuredCollections"
                :key="feature.id"
                :to="feature.to"
                class="feature-card"
              >
                <div class="feature-top">
                  <span class="feature-label">{{ feature.label }}</span>
                  <span class="feature-date">{{ feature.date }}</span>
                </div>
                <h4 class="feature-title">{{ feature.title }}</h4>
                <p class="feature-desc">{{ feature.desc }}</p>
                <div class="feature-tags">
                  <span v-for="tag in feature.tags" :key="tag" class="feature-tag">
                    #{{ tag }}
                  </span>
                </div>
              </NuxtLink>
            </div>
          </section>
        </main>

        <aside class="side-column">
          <!-- Site Overview -->
          <section class="side-widget">
            <div class="widget-header">
              <LucideIcon name="Activity" class="w-4 h-4 text-[rgb(var(--accent))]" />
              <span class="widget-title">站点状态</span>
            </div>
            <div class="stats-matrix">
              <div class="matrix-item">
                <span class="matrix-label">页面</span>
                <span class="matrix-value">{{ formatNumber(overview.pages.total) }}</span>
              </div>
              <div class="matrix-item">
                <span class="matrix-label">用户</span>
                <span class="matrix-value">{{ formatNumber(overview.users.total) }}</span>
              </div>
              <div class="matrix-item">
                <span class="matrix-label">评分</span>
                <span class="matrix-value">{{ formatNumber(overview.votes.total) }}</span>
              </div>
              <div class="matrix-item">
                <span class="matrix-label">评论</span>
                <span class="matrix-value">{{ formatNumber(8200) }}</span>
              </div>
            </div>
            <div class="widget-footer">
              <span class="update-time">更新于 {{ overviewUpdatedAtRelative }}</span>
            </div>
          </section>

          <!-- Top Authors -->
          <section class="side-widget">
            <div class="widget-header">
              <LucideIcon name="Crown" class="w-4 h-4 text-[rgb(var(--accent))]" />
              <span class="widget-title">作者排行速览</span>
            </div>
            <div class="author-list">
              <div v-for="author in topAuthors" :key="author.id" class="author-item">
                <UserAvatar
                  :wikidot-id="author.id"
                  :size="28"
                  :name="author.name"
                  class="author-avatar"
                />
                <div class="author-meta">
                  <span class="author-name">{{ author.name }}</span>
                  <span class="author-works">{{ author.works }} 作品</span>
                </div>
                <div class="author-score">
                  <span class="author-rating">+{{ author.rating }}</span>
                  <span class="author-trend">{{ author.trend }}</span>
                </div>
              </div>
            </div>
          </section>

          <!-- Hot Tags -->
          <section class="side-widget">
            <div class="widget-header">
              <LucideIcon name="Hash" class="w-4 h-4 text-[rgb(var(--accent))]" />
              <span class="widget-title">热门标签</span>
            </div>
            <div class="tag-cloud">
              <NuxtLink
                v-for="tag in hotTags"
                :key="tag"
                :to="{ path: '/search', query: { tags: [tag] } }"
                class="cloud-tag"
              >
                #{{ tag }}
              </NuxtLink>
            </div>
          </section>

          <!-- Quick Tools -->
          <section class="side-widget">
            <div class="widget-header">
              <LucideIcon name="Wrench" class="w-4 h-4 text-[rgb(var(--accent))]" />
              <span class="widget-title">常用工具</span>
            </div>
            <div class="tools-list">
              <NuxtLink v-for="tool in quickTools" :key="tool.title" :to="tool.to" class="tool-item">
                <div class="tool-icon"><LucideIcon :name="tool.icon" class="w-4 h-4" /></div>
                <div class="tool-text">
                  <span class="tool-title">{{ tool.title }}</span>
                  <span class="tool-desc">{{ tool.desc }}</span>
                </div>
              </NuxtLink>
            </div>
          </section>

          <!-- Community Activity -->
          <section class="side-widget">
            <div class="widget-header">
              <LucideIcon name="MessageSquare" class="w-4 h-4 text-[rgb(var(--accent))]" />
              <span class="widget-title">社区动态</span>
            </div>
            <div class="activity-feed">
              <div class="feed-item" v-for="item in communityFeed" :key="item.id">
                <UserAvatar
                  :size="24"
                  :wikidot-id="item.userId"
                  :name="item.user"
                  class="feed-avatar"
                />
                <div class="feed-content">
                  <div class="feed-text">
                    <span class="feed-user">{{ item.user }}</span>
                    {{ item.action }}
                    <span class="feed-target">{{ item.target }}</span>
                  </div>
                  <div class="feed-time">{{ item.time }}</div>
                </div>
              </div>
            </div>
          </section>
        </aside>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useHead } from 'nuxt/app'

const heroQuery = ref('')


const pulseStats = [
  { label: '今日新增', value: 18, meta: '近 24 小时' },
  { label: '今日更新', value: 42, meta: '近 24 小时' },
  { label: '活跃作者', value: 186, meta: '本周' }
]

const recentCreatedPages = [
  {
    id: 1,
    title: 'SCP-CN-4012',
    subtitle: '临界余波',
    authors: [{ name: 'Dr_Writer' }],
    date: '2026-01-18',
    rating: 126,
    comments: 32,
    tags: ['scp', 'cn', 'keter'],
    excerpt: '一份关于临界区异常响应的档案，记录在收容边界徘徊的信号。',
    to: '/sample/page'
  },
  {
    id: 2,
    title: 'SCP-CN-4051',
    subtitle: '白噪的来信',
    authors: [{ name: 'Editor_A' }],
    date: '2026-01-17',
    rating: 94,
    comments: 18,
    tags: ['scp', '故事', '记录'],
    excerpt: '一段被噪声覆盖的讯息串联起多次回访与隐藏线索。',
    to: '/sample/page'
  },
  {
    id: 3,
    title: 'SCP-CN-3920',
    subtitle: '灰阶通道',
    authors: [{ name: 'Researcher_J' }],
    date: '2026-01-17',
    rating: 88,
    comments: 16,
    tags: ['scp', 'cn', 'euclid'],
    excerpt: '灰阶空间中出现的短暂通道，需要多部门协作响应。',
    to: '/sample/page'
  },
  {
    id: 4,
    title: 'SCP-CN-3877',
    subtitle: '无名回声',
    authors: [{ name: 'Agent_Li' }],
    date: '2026-01-16',
    rating: 73,
    comments: 11,
    tags: ['scp', 'cn', 'safe'],
    excerpt: '在废弃站点中持续回响的录音让资料组重新梳理旧档。',
    to: '/sample/page'
  },
  {
    id: 5,
    title: 'SCP-CN-4102',
    subtitle: '记录备忘',
    authors: [{ name: 'Dr_Chen' }],
    date: '2026-01-15',
    rating: 65,
    comments: 9,
    tags: ['翻译', 'scp', '档案'],
    excerpt: '翻译档案与原文并置，展示条目演变与注释节奏。',
    to: '/sample/page'
  }
]

const recentUpdatedPages = [
  {
    id: 1,
    title: 'SCP-CN-1733',
    summary: '新增附录与交叉引用，补充监管记录。',
    change: '修订',
    editor: 'Editor_A',
    time: '12分钟前',
    rating: '+128',
    delta: 4,
    to: '/sample/page'
  },
  {
    id: 2,
    title: 'SCP-CN-0042',
    summary: '补充访谈与注释，修正描述细节。',
    change: '补档',
    editor: 'Dr_Wengwan',
    time: '38分钟前',
    rating: '+72',
    delta: 2,
    to: '/sample/page'
  },
  {
    id: 3,
    title: '基金会故事：黎明',
    summary: '修复排版并更新关键段落。',
    change: '格式',
    editor: 'Agent_Li',
    time: '2小时前',
    rating: '+45',
    delta: -1,
    to: '/sample/page'
  },
  {
    id: 4,
    title: 'SCP-CN-2999',
    summary: '新增收容记录与参考条目。',
    change: '附录',
    editor: 'Researcher_J',
    time: '昨天',
    rating: '+306',
    delta: 6,
    to: '/sample/page'
  }
]

const featuredCollections = [
  {
    id: 1,
    label: '专题',
    title: 'SCP-CN-4000 竞赛作品',
    desc: '快速浏览竞赛投稿与评审进度，掌握热门条目走势。',
    date: '更新于 01-18',
    tags: ['竞赛', '4000', '投稿'],
    to: '/sample/page'
  },
  {
    id: 2,
    label: '精选',
    title: '最受关注的 GoI 页面',
    desc: '聚合近期评分与评论表现突出的 GoI 相关作品。',
    date: '更新于 01-17',
    tags: ['GoI', '热榜', '收藏'],
    to: '/sample/page'
  },
  {
    id: 3,
    label: '档案',
    title: '站点历史文档回顾',
    desc: '按年份整理的关键条目与里程碑，适合梳理站点脉络。',
    date: '更新于 01-14',
    tags: ['历史', '档案', '回顾'],
    to: '/sample/page'
  }
]

const topAuthors = [
  { id: 789, name: 'Researcher_J', works: 42, rating: 1280, trend: '+12' },
  { id: 456, name: 'Dr_Chen', works: 31, rating: 980, trend: '+7' },
  { id: 111, name: 'Agent_Li', works: 28, rating: 820, trend: '+4' },
  { id: 222, name: 'Editor_A', works: 24, rating: 760, trend: '+3' }
]

const hotTags = ['scp', 'cn', 'keter', '收容失效', 'GoI', '故事', '艺术作品', '短篇', '实验记录']

const quickTools = [
  { title: '作者排行', desc: '查看活跃作者榜单', icon: 'ChartBar', to: '/ranking' },
  { title: '站点工具', desc: '数据分析与标签洞察', icon: 'Hammer', to: '/tools' },
  { title: '发布日历', desc: '按月查看活动', icon: 'CalendarDays', to: '/tools/calendar' }
]

const communityFeed = [
  { id: 1, user: 'User_A', userId: 101, action: '评论了', target: 'SCP-CN-1733', time: '8分钟前' },
  { id: 2, user: 'Editor_B', userId: 202, action: '追踪了', target: 'SCP-CN-4021', time: '18分钟前' },
  { id: 3, user: 'Researcher_J', userId: 789, action: '发布了', target: 'SCP-CN-4012', time: '1小时前' },
  { id: 4, user: 'Agent_Li', userId: 111, action: '更新了', target: 'SCP-CN-2999', time: '3小时前' }
]

const overview = ref({
  users: { total: 8920, active: 2156, contributors: 1823, authors: 945 },
  pages: { total: 12345, originals: 8234, translations: 3156, deleted: 955 },
  votes: { total: 456789, upvotes: 398234, downvotes: 58555 },
  revisions: { total: 234567 },
  updatedAt: new Date().toISOString()
})

function formatNumber(num: number): string {
  if (num >= 10000) return (num / 10000).toFixed(1) + 'w'
  if (num >= 1000) return (num / 1000).toFixed(1) + 'k'
  return Number(num || 0).toLocaleString()
}

const mounted = ref(false)
onMounted(() => { mounted.value = true })

function parseDateInput(input?: string | Date | null): Date | null {
  if (!input) return null
  const d = new Date(input as any)
  if (isNaN(d.getTime())) return null
  return d
}

function chineseNum(n: number, unit: string): string {
  if (n === 1) return `一${unit}前`
  if (n === 2) return `两${unit}前`
  return `${n}${unit}前`
}

function formatRelativeZh(input?: string | Date | null): string {
  const d = parseDateInput(input)
  if (!d) return '—'
  const now = Date.now()
  const diffSec = Math.max(0, Math.floor((now - d.getTime()) / 1000))
  if (diffSec < 60) return '刚刚'
  const mins = Math.floor(diffSec / 60)
  if (mins < 60) return chineseNum(mins, '分钟')
  const hours = Math.floor(mins / 60)
  if (hours < 24) return chineseNum(hours, '小时')
  const days = Math.floor(hours / 24)
  if (days < 30) return chineseNum(days, '天')
  return '很久以前'
}

const overviewUpdatedAtRelative = computed(() => mounted.value ? formatRelativeZh(overview.value.updatedAt) : '...')

const onHeroSearch = () => {
  const q = heroQuery.value.trim()
  if (!q) {
    navigateTo('/search')
    return
  }
  navigateTo({ path: '/search', query: { q } })
}

useHead({
  bodyAttrs: {
    class: 'sample-home'
  }
})

definePageMeta({ layout: 'default' })
</script>

<style scoped>
/* Base */
.sample-page {
  @apply min-h-screen relative pb-20;
  --bg: 244 240 233;
  --fg: 32 29 26;
  --muted: 114 106 97;
  --muted-strong: 82 74 66;
  --panel: 255 252 246;
  --panel-border: 215 208 198;
  --tag-bg: 238 232 224;
  --tag-border: 204 193 180;
  --tag-text: 96 88 80;
  --input-bg: 255 253 248;
  --input-border: 188 176 164;
  --accent: 214 92 64;
  --accent-strong: 172 70 50;
  --accent-weak: 244 224 209;
  --success: 52 119 93;
  --danger: 172 68 68;

  background: rgb(var(--bg));
  background-image:
    linear-gradient(rgb(var(--fg) / 0.03) 1px, transparent 1px),
    linear-gradient(90deg, rgb(var(--fg) / 0.03) 1px, transparent 1px);
  background-size: 32px 32px;
  color: rgb(var(--fg));
  font-family: 'Helvetica Neue', 'PingFang SC', sans-serif;
}

/* Ambient Background */
.ambient-bg {
  @apply fixed inset-0 pointer-events-none overflow-hidden;
  z-index: 0;
}
.glow {
  @apply absolute rounded-full blur-[140px] opacity-15;
  mix-blend-mode: multiply;
}
.glow-1 {
  @apply w-[600px] h-[600px] -top-32 left-1/4;
  background: radial-gradient(circle, rgb(var(--accent) / 0.2), transparent 70%);
}
.glow-2 {
  @apply w-[500px] h-[500px] top-1/2 -right-20;
  background: radial-gradient(circle, rgb(var(--accent-weak) / 0.2), transparent 70%);
}
.noise-layer {
  @apply absolute inset-0 opacity-[0.04];
  background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.8' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)'/%3E%3C/svg%3E");
}

.page-container {
  @apply relative z-10 max-w-6xl mx-auto px-4 sm:px-6 md:px-8 pt-8;
}

/* Search Hero */
.search-hero {
  @apply flex flex-col items-center justify-center py-16 sm:py-20 text-center;
}
.search-hero-content {
  @apply flex flex-col items-center;
}
.hero-kicker {
  @apply text-xs uppercase tracking-[0.4em] mb-4;
  color: rgb(var(--muted));
  font-family: 'Courier New', monospace;
}
.hero-title {
  @apply text-4xl sm:text-5xl font-bold tracking-tight mb-6;
  font-family: 'Times New Roman', 'Songti SC', serif;
}
.hero-accent {
  color: rgb(var(--accent));
}
.search-box-wrapper {
  @apply w-full max-w-2xl relative z-20;
}
.search-box {
  @apply flex items-center w-full bg-[rgb(var(--panel))] rounded-full p-2 pl-6 shadow-lg transition-all duration-300;
  border: 2px solid rgb(var(--panel-border));
  box-shadow: 0 8px 30px -4px rgb(var(--fg) / 0.08);
}
.search-box:focus-within {
  border-color: rgb(var(--accent));
  box-shadow: 0 12px 40px -4px rgb(var(--accent) / 0.15);
  transform: translateY(-2px);
}
.search-icon {
  @apply w-5 h-5 mr-3 text-[rgb(var(--muted))];
}
.search-input {
  @apply flex-1 bg-transparent border-none outline-none text-lg text-[rgb(var(--fg))] placeholder-[rgb(var(--muted)/0.7)];
}
.search-btn {
  @apply w-10 h-10 rounded-full flex items-center justify-center bg-[rgb(var(--fg))] text-[rgb(var(--panel))] transition-transform active:scale-95;
}
.search-btn:hover {
  background: rgb(var(--accent));
  transform: scale(1.05);
}

/* Pulse Strip */
.pulse-strip {
  @apply grid grid-cols-1 sm:grid-cols-3 gap-3 mb-12;
}
.pulse-card {
  @apply flex flex-col gap-1 rounded-lg border border-[rgb(var(--panel-border))] bg-[rgb(var(--panel))] p-4 shadow-sm;
}
.pulse-label {
  @apply text-[10px] uppercase tracking-[0.2em];
  color: rgb(var(--muted));
}
.pulse-value {
  @apply text-2xl font-semibold;
  color: rgb(var(--fg));
  font-family: 'Times New Roman', 'Songti SC', serif;
}
.pulse-meta {
  @apply text-xs;
  color: rgb(var(--muted-strong));
}

/* Featured Banner */
.featured-banner {
  @apply mb-12 rounded-xl overflow-hidden relative shadow-xl;
  border: 2px solid rgb(var(--panel-border));
}
.banner-link {
  @apply block relative p-8 sm:p-12 text-right overflow-hidden;
  background: rgb(var(--panel));
}
.banner-bg {
  @apply absolute inset-0 opacity-40 transition-transform duration-700;
  background: linear-gradient(120deg, transparent 40%, rgb(var(--accent) / 0.1) 100%);
}
.banner-link:hover .banner-bg {
  transform: scale(1.05);
}
.banner-content {
  @apply relative z-10 flex flex-col items-end gap-4;
}
.banner-badge {
  @apply inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold uppercase tracking-wider bg-[rgb(var(--accent))] text-white shadow-sm;
}
.banner-title {
  @apply text-3xl sm:text-4xl font-bold text-[rgb(var(--fg))];
  font-family: 'Times New Roman', serif;
}
.banner-desc {
  @apply text-sm sm:text-base max-w-lg text-[rgb(var(--muted-strong))] leading-relaxed;
}
.banner-action {
  @apply flex items-center gap-2 mt-2 text-sm font-bold uppercase tracking-widest text-[rgb(var(--accent-strong))];
}

/* Content Grid */
.content-grid {
  @apply grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_320px] gap-10;
}
.main-column {
  @apply flex flex-col gap-10;
}

/* Content Sections */
.content-section {
  @apply space-y-6;
}
.section-header {
  @apply flex items-center justify-between pb-2 border-b border-[rgb(var(--panel-border)/0.6)];
}
.title-group {
  @apply flex items-center gap-3;
}
.section-icon {
  @apply w-5 h-5 text-[rgb(var(--accent))];
}
.section-title {
  @apply text-xl font-bold tracking-tight text-[rgb(var(--fg))];
  font-family: 'Times New Roman', serif;
}
.more-link {
  @apply text-xs font-bold uppercase tracking-wider text-[rgb(var(--muted))] hover:text-[rgb(var(--accent))] transition-colors;
}
.card-list {
  @apply flex flex-col gap-4;
}

/* Update List */
.update-list {
  @apply flex flex-col gap-3;
}
.update-card {
  @apply flex items-start justify-between gap-4 rounded-lg border border-[rgb(var(--panel-border))] bg-[rgb(var(--panel))] p-4 transition-all;
}
.update-card:hover {
  box-shadow: 4px 6px 18px rgb(var(--fg) / 0.08);
  transform: translateY(-1px);
}
.update-main {
  @apply flex-1 min-w-0;
}
.update-title {
  @apply text-sm font-semibold text-[rgb(var(--fg))];
  font-family: 'Times New Roman', serif;
}
.update-summary {
  @apply text-xs mt-1;
  color: rgb(var(--muted));
}
.update-meta {
  @apply flex flex-wrap items-center gap-2 text-xs mt-2;
  color: rgb(var(--muted-strong));
}
.update-chip {
  @apply px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-[0.16em];
  background: rgb(var(--accent-weak));
  color: rgb(var(--accent-strong));
}
.update-editor {
  @apply text-xs;
}
.update-time {
  @apply text-xs;
}
.update-rating {
  @apply text-right min-w-[72px] flex flex-col items-end;
}
.update-score {
  @apply text-base font-semibold;
  color: rgb(var(--fg));
}
.update-delta {
  @apply text-xs font-semibold;
}
.update-delta.up {
  color: rgb(var(--success));
}
.update-delta.down {
  color: rgb(var(--danger));
}

/* Feature Grid */
.feature-grid {
  @apply grid gap-4 md:grid-cols-2;
}
.feature-card {
  @apply flex flex-col gap-3 rounded-lg border border-[rgb(var(--panel-border))] bg-[rgb(var(--panel))] p-4 shadow-sm transition-transform;
}
.feature-card:hover {
  transform: translateY(-2px);
  box-shadow: 6px 10px 22px rgb(var(--fg) / 0.08);
}
.feature-top {
  @apply flex items-center justify-between text-xs;
  color: rgb(var(--muted));
}
.feature-label {
  @apply uppercase tracking-[0.24em] text-[10px];
}
.feature-date {
  @apply text-[10px];
}
.feature-title {
  @apply text-base font-semibold text-[rgb(var(--fg))];
  font-family: 'Times New Roman', serif;
}
.feature-desc {
  @apply text-xs leading-relaxed;
  color: rgb(var(--muted-strong));
}
.feature-tags {
  @apply flex flex-wrap gap-2 text-[10px];
}
.feature-tag {
  @apply rounded-full border border-[rgb(var(--tag-border))] px-2 py-0.5;
  color: rgb(var(--tag-text));
  background: rgb(var(--tag-bg));
}

/* Side Widgets */
.side-column {
  @apply flex flex-col gap-6;
}
.side-widget {
  @apply bg-[rgb(var(--panel))] rounded-lg p-5 border border-[rgb(var(--panel-border))] shadow-sm;
}
.widget-header {
  @apply flex items-center gap-2 mb-4 text-sm font-bold uppercase tracking-wider text-[rgb(var(--muted-strong))];
}
.widget-title {
  @apply text-xs font-semibold uppercase tracking-[0.2em];
}
.stats-matrix {
  @apply grid grid-cols-2 gap-3;
}
.matrix-item {
  @apply bg-[rgb(var(--bg))] p-3 rounded border border-[rgb(var(--panel-border)/0.5)] flex flex-col items-center text-center;
}
.matrix-label {
  @apply text-[10px] uppercase;
  color: rgb(var(--muted));
}
.matrix-value {
  @apply text-lg font-bold text-[rgb(var(--fg))];
  font-family: 'Times New Roman', serif;
}
.widget-footer {
  @apply mt-4 pt-3 border-t border-[rgb(var(--panel-border)/0.5)] text-center;
}
.update-time {
  @apply text-xs;
  color: rgb(var(--muted));
}

/* Authors */
.author-list {
  @apply flex flex-col gap-3;
}
.author-item {
  @apply flex items-center gap-3 rounded-md border border-[rgb(var(--panel-border)/0.5)] bg-[rgb(var(--bg))] p-2;
}
.author-avatar {
  @apply border border-[rgb(var(--panel-border))];
}
.author-meta {
  @apply flex-1 min-w-0 flex flex-col;
}
.author-name {
  @apply text-sm font-medium text-[rgb(var(--fg))];
}
.author-works {
  @apply text-xs;
  color: rgb(var(--muted));
}
.author-score {
  @apply text-right flex flex-col items-end;
}
.author-rating {
  @apply text-sm font-semibold text-[rgb(var(--fg))];
}
.author-trend {
  @apply text-xs;
  color: rgb(var(--accent-strong));
}

/* Tag Cloud */
.tag-cloud {
  @apply flex flex-wrap gap-2;
}
.cloud-tag {
  @apply px-2 py-1 text-xs rounded border border-[rgb(var(--tag-border))] bg-[rgb(var(--tag-bg))] text-[rgb(var(--tag-text))] hover:border-[rgb(var(--accent))] hover:text-[rgb(var(--accent))] transition-colors;
}

/* Tools */
.tools-list {
  @apply flex flex-col gap-2;
}
.tool-item {
  @apply flex items-start gap-3 p-2 rounded hover:bg-[rgb(var(--bg))] transition-colors;
}
.tool-icon {
  @apply w-8 h-8 flex items-center justify-center rounded bg-[rgb(var(--accent)/0.1)] text-[rgb(var(--accent))];
}
.tool-text {
  @apply flex flex-col;
}
.tool-title {
  @apply text-sm font-medium text-[rgb(var(--fg))];
}
.tool-desc {
  @apply text-xs;
  color: rgb(var(--muted));
}

/* Activity Feed */
.activity-feed {
  @apply flex flex-col gap-4;
}
.feed-item {
  @apply flex gap-3 text-xs leading-relaxed;
}
.feed-avatar {
  @apply shrink-0 border border-[rgb(var(--panel-border))];
}
.feed-content {
  @apply flex flex-col gap-0.5;
}
.feed-text {
  color: rgb(var(--muted-strong));
}
.feed-user {
  @apply font-bold text-[rgb(var(--fg))];
}
.feed-target {
  @apply text-[rgb(var(--accent-strong))] hover:underline cursor-pointer;
}
.feed-time {
  @apply text-[10px] text-[rgb(var(--muted))];
}

:global(body.sample-home .app-header form),
:global(body.sample-home .app-header button[aria-label="打开搜索"]) {
  display: none;
}
</style>
