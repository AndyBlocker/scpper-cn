<template>
  <div class="sample-page">
    <!-- Ambient Background -->
    <div class="ambient-bg">
      <div class="glow glow-1"></div>
      <div class="glow glow-2"></div>
      <div class="noise-layer"></div>
    </div>

    <div class="page-container">
      <!-- Share Card Header - First Screen Focus -->
      <section class="share-card">
        <div class="share-card-inner">
          <!-- Left: User Identity & Timeline -->
          <div class="card-left">
            <!-- User Identity -->
            <div class="user-identity">
              <div class="user-avatar-wrapper">
                <UserAvatar :wikidot-id="123456" :size="80" name="AndyBlocker" class="user-avatar-main" />
              </div>
              <div class="user-info">
                <h1 class="user-name">AndyBlocker</h1>
                <p class="user-id">ID: 123456</p>
                <!-- Activity Timeline inline -->
                <div class="timeline-inline">
                  <span class="timeline-item-inline">
                    <LucideIcon name="Sparkles" class="w-3.5 h-3.5 text-[rgb(var(--accent))]" />
                    首次 2022-06-15
                  </span>
                  <span class="timeline-sep">·</span>
                  <span class="timeline-item-inline">
                    <LucideIcon name="Activity" class="w-3.5 h-3.5 text-[rgb(var(--success))]" />
                    最近 2024-12-16
                  </span>
                </div>
              </div>
            </div>
          </div>

          <!-- Center: Stats Grid -->
          <div class="card-center">
            <div class="stats-grid">
              <div class="stat-box stat-box-highlight">
                <span class="stat-value">42</span>
                <span class="stat-label">作品数</span>
              </div>
              <div class="stat-box">
                <span class="stat-value success">1,280</span>
                <span class="stat-label">总评分</span>
              </div>
              <div class="stat-box">
                <span class="stat-value">30.5</span>
                <span class="stat-label">平均分</span>
              </div>
              <div class="stat-box">
                <div class="vote-split">
                  <span class="vote-up">1,456</span>
                  <span class="vote-sep">/</span>
                  <span class="vote-down">176</span>
                </div>
                <span class="stat-label">投票 ↑/↓</span>
              </div>
            </div>
          </div>

          <!-- Right: Rank -->
          <div class="card-right">
            <div class="rank-block">
              <span class="rank-value">#1</span>
              <span class="rank-label">综合排名</span>
            </div>
          </div>
        </div>
      </section>

      <!-- Content Below First Screen -->
      <div class="content-grid">
        <main class="main-column">
          <!-- Category Performance -->
          <section class="content-card">
            <div class="card-header">
              <h2 class="section-title">
                <LucideIcon name="PieChart" class="w-5 h-5" />
                分类表现
              </h2>
            </div>
            <div class="category-list">
              <div v-for="cat in categories" :key="cat.name" class="category-item">
                <div class="category-info">
                  <span class="category-name">{{ cat.name }}</span>
                  <span class="category-count">{{ cat.count }} 作品</span>
                </div>
                <div class="category-stats">
                  <span class="category-rank">#{{ cat.rank }}</span>
                  <span class="category-rating">{{ cat.rating }}</span>
                </div>
                <div class="category-bar">
                  <div class="bar-fill" :style="{ width: cat.percent + '%' }"></div>
                </div>
              </div>
            </div>
          </section>

          <!-- Rating History -->
          <section class="content-card">
            <div class="card-header">
              <h2 class="section-title">
                <LucideIcon name="TrendingUp" class="w-5 h-5" />
                评分历史趋势
              </h2>
            </div>
            <div class="chart-area">
              <svg viewBox="0 0 400 120" preserveAspectRatio="none" class="rating-chart">
                <defs>
                  <linearGradient id="rating-gradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stop-color="rgb(var(--accent))" stop-opacity="0.3" />
                    <stop offset="100%" stop-color="rgb(var(--accent))" stop-opacity="0" />
                  </linearGradient>
                </defs>
                <path d="M0,110 Q50,100 100,85 T200,60 T300,40 T400,20 L400,120 L0,120 Z" fill="url(#rating-gradient)" />
                <path d="M0,110 Q50,100 100,85 T200,60 T300,40 T400,20" fill="none" stroke="rgb(var(--accent))" stroke-width="2" stroke-linecap="round" />
              </svg>
              <div class="chart-labels">
                <span>2022</span>
                <span>2023</span>
                <span>2024</span>
              </div>
            </div>
          </section>

          <!-- Works List -->
          <section class="content-card">
            <div class="card-header">
              <h2 class="section-title">
                <LucideIcon name="FileText" class="w-5 h-5" />
                作品列表
              </h2>
              <div class="tab-group">
                <button
                  v-for="tab in workTabs"
                  :key="tab.id"
                  :class="['tab-btn', { active: activeWorkTab === tab.id }]"
                  @click="activeWorkTab = tab.id"
                >
                  {{ tab.label }}
                  <span class="tab-count">{{ tab.count }}</span>
                </button>
              </div>
            </div>
            <div class="works-list">
              <div v-for="work in works" :key="work.id" class="work-item">
                <span :class="['work-rating', work.rating > 0 ? 'up' : work.rating < 0 ? 'down' : '']">
                  {{ work.rating > 0 ? '+' : '' }}{{ work.rating }}
                </span>
                <div class="work-info">
                  <h3 class="work-title">{{ work.title }}</h3>
                  <div class="work-meta">
                    <span>{{ work.date }}</span>
                    <span>{{ work.wilson }}</span>
                  </div>
                </div>
              </div>
            </div>
          </section>
        </main>

        <!-- Sidebar -->
        <aside class="side-column">
          <!-- Favorite Authors -->
          <section class="sidebar-card">
            <h3 class="sidebar-title">
              <LucideIcon name="Heart" class="w-4 h-4" />
              最喜欢的作者
            </h3>
            <div class="favorite-list">
              <div v-for="author in favoriteAuthors" :key="author.id" class="favorite-item">
                <UserAvatar :wikidot-id="author.id" :size="28" :name="author.name" />
                <span class="favorite-name">{{ author.name }}</span>
                <div class="favorite-votes">
                  <span class="vote-up">+{{ author.up }}</span>
                  <span class="vote-down">-{{ author.down }}</span>
                </div>
              </div>
            </div>
          </section>

          <!-- Recent Votes -->
          <section class="sidebar-card">
            <h3 class="sidebar-title">
              <LucideIcon name="ThumbsUp" class="w-4 h-4" />
              最近投票
            </h3>
            <div class="recent-votes-list">
              <div v-for="vote in recentVotes" :key="vote.id" class="recent-vote-item">
                <NuxtLink to="/sample/page" class="vote-page">{{ vote.page }}</NuxtLink>
                <span :class="['vote-dir', vote.value > 0 ? 'up' : 'down']">
                  {{ vote.value > 0 ? '+1' : '-1' }}
                </span>
                <span class="vote-time">{{ vote.time }}</span>
              </div>
            </div>
          </section>
        </aside>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'

// View state
const activeWorkTab = ref('all')

// Mock data
const categories = ref([
  { name: 'SCP', rank: 5, rating: 580, count: 18, percent: 85 },
  { name: '故事', rank: 12, rating: 320, count: 12, percent: 60 },
  { name: 'GoI格式', rank: 8, rating: 180, count: 6, percent: 45 },
  { name: '翻译', rank: 23, rating: 120, count: 4, percent: 30 },
])

const workTabs = ref([
  { id: 'all', label: '全部', count: 42 },
  { id: 'original', label: '原创', count: 38 },
  { id: 'translation', label: '翻译', count: 4 },
])

const works = ref([
  { id: 1, title: 'SCP-CN-001: 等待解密', rating: 128, date: '2024-12-15', wilson: '82.1%' },
  { id: 2, title: 'SCP-CN-042: 永恒观察者', rating: 67, date: '2024-11-20', wilson: '75.3%' },
  { id: 3, title: '基金会故事：最后的守望', rating: 45, date: '2024-10-15', wilson: '71.2%' },
  { id: 4, title: 'SCP-CN-123: 记忆碎片', rating: 38, date: '2024-09-08', wilson: '68.9%' },
])

const favoriteAuthors = ref([
  { id: 789, name: 'Researcher_J', up: 45, down: 2 },
  { id: 456, name: 'Dr_Chen', up: 38, down: 5 },
  { id: 111, name: 'Agent_Li', up: 32, down: 3 },
])

const recentVotes = ref([
  { id: 1, page: 'SCP-CN-2345', value: 1, time: '2小时前' },
  { id: 2, page: 'SCP-CN-002', value: 1, time: '5小时前' },
  { id: 3, page: '基金会故事：黎明', value: -1, time: '1天前' },
])

definePageMeta({ layout: 'default' })
</script>

<style scoped>
/* Base */
  .sample-page {
    @apply min-h-screen relative;
    --bg: 244 240 233;
    --fg: 32 29 26;
    --muted: 114 106 97;
    --muted-strong: 82 74 66;
    --panel: 255 252 246;
    --panel-border: 120 110 100;
    --tag-bg: 247 241 233;
    --tag-border: 204 193 180;
    --tag-text: 96 88 80;
    --input-bg: 255 253 248;
    --input-border: 188 176 164;
    --accent: 214 92 64;
    --accent-strong: 172 70 50;
    --accent-weak: 244 224 209;
    --success: 52 119 93;
    --danger: 172 68 68;
    --warning: 212 156 70;
    background: rgb(var(--bg));
    background-image:
      linear-gradient(rgb(var(--fg) / 0.04) 1px, transparent 1px),
      linear-gradient(90deg, rgb(var(--fg) / 0.04) 1px, transparent 1px);
    background-size: 28px 28px;
    color: rgb(var(--fg));
    font-family: 'Helvetica Neue', 'PingFang SC', 'Microsoft YaHei', sans-serif;
    text-rendering: optimizeLegibility;
    -webkit-font-smoothing: antialiased;
  }


/* Ambient Background */
.ambient-bg {
  @apply fixed inset-0 pointer-events-none overflow-hidden;
  z-index: 0;
}

  .glow {
    @apply absolute rounded-full blur-[140px] opacity-20;
    mix-blend-mode: multiply;
  }


.glow-1 {
  @apply w-[520px] h-[520px] -top-40 left-1/4;
  background: radial-gradient(circle, rgb(var(--accent) / 0.18), transparent 70%);
}

.glow-2 {
  @apply w-[360px] h-[360px] top-1/3 -right-12;
  background: radial-gradient(circle, rgb(var(--accent-weak) / 0.12), transparent 70%);
}

.noise-layer {
  @apply absolute inset-0 opacity-[0.03];
  background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.7' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)'/%3E%3C/svg%3E");
}


/* Container */
.page-container {
  @apply relative z-10 max-w-6xl mx-auto px-6 sm:px-8 py-10 space-y-8;
}

/* Share Card - First Screen Focus */
  .share-card {
    @apply p-7 lg:p-10;
    background: rgb(var(--panel));
    border: 2px solid rgb(var(--panel-border));
    box-shadow: 6px 6px 0 rgb(var(--fg) / 0.9);
    border-radius: 4px;
    position: relative;
  }

  .share-card::before {
    content: '';
    position: absolute;
    top: 18px;
    left: 24px;
    width: 70px;
    height: 20px;
    background: rgba(230, 214, 190, 0.6);
    border: 1px solid rgba(60, 56, 52, 0.3);
    transform: rotate(-4deg);
    box-shadow: 2px 2px 0 rgba(32, 29, 26, 0.35);
    pointer-events: none;
  }


.share-card-inner {
  @apply flex flex-col lg:flex-row items-stretch gap-6 lg:gap-0;
}

/* Left Column: User Identity */
.card-left {
  @apply flex-1 min-w-0;
}

.user-identity {
  @apply flex items-center gap-4 lg:gap-5;
}

.user-avatar-wrapper {
  @apply shrink-0;
}

  .user-avatar-main {
    border: 2px solid rgb(var(--panel-border));
    border-radius: 2px;
    box-shadow: 3px 3px 0 rgb(var(--fg) / 0.6);
    background: rgb(var(--panel));
    padding: 4px;
  }


.user-info {
  @apply flex-1 min-w-0;
}

  .user-name {
    @apply text-2xl lg:text-3xl font-semibold tracking-tight leading-tight;
    color: rgb(var(--fg));
    font-family: 'Times New Roman', 'Songti SC', serif;
    letter-spacing: -0.02em;
  }


.user-id {
  @apply text-sm mb-2;
  color: rgb(var(--muted));
}

  .timeline-inline {
    @apply flex flex-wrap items-center gap-2 text-xs tracking-wide;
    color: rgb(var(--muted));
    font-family: 'Courier New', 'SFMono-Regular', monospace;
    text-transform: uppercase;
  }


.timeline-item-inline {
  @apply inline-flex items-center gap-1.5;
}

.timeline-sep {
  color: rgb(var(--muted) / 0.3);
}

/* Center Column: Stats Grid */
.card-center {
  @apply lg:px-8 lg:border-x py-4 lg:py-0;
  border-color: rgb(var(--panel-border));
  @apply border-y lg:border-y-0;
}

  .stats-grid {
    @apply grid grid-cols-4 gap-px;
    background: rgb(var(--panel-border));
    border: 2px solid rgb(var(--panel-border));
  }


  .stat-box {
    @apply text-center p-3;
    background: rgb(var(--panel));
    border: none;
    box-shadow: none;
  }


  .stat-box-highlight {
    background: rgb(var(--accent-weak));
  }


  .stat-box .stat-value {
    @apply text-lg lg:text-xl font-bold tabular-nums;
    color: rgb(var(--fg));
    font-family: 'Courier New', 'SFMono-Regular', monospace;
  }


.stat-box .stat-value.success {
  color: rgb(var(--success));
}

.stat-box .stat-label {
  @apply text-xs;
  color: rgb(var(--muted));
}

.vote-split {
  @apply flex items-center justify-center gap-1 text-base lg:text-lg font-bold tabular-nums;
}

.vote-up {
  color: rgb(var(--success));
}

.vote-down {
  color: rgb(var(--danger));
}

.vote-sep {
  color: rgb(var(--muted) / 0.3);
}

/* Right Column: Rank */
.card-right {
  @apply flex items-center justify-center lg:pl-8;
}

.rank-block {
  @apply text-center;
}

  .rank-value {
    @apply block text-4xl lg:text-5xl font-bold;
    color: rgb(var(--accent));
    font-family: 'Times New Roman', 'Songti SC', serif;
  }


.rank-label {
  @apply text-sm;
  color: rgb(var(--muted));
}

/* Content Grid */
.content-grid {
  @apply grid gap-8;
  grid-template-columns: 1fr;
}

@media (min-width: 1024px) {
  .content-grid {
    grid-template-columns: 1fr 320px;
  }
}

/* Content Card */
  .content-card {
    @apply p-6 mb-4;
    background: rgb(var(--panel));
    border: 2px solid rgb(var(--panel-border));
    box-shadow: 4px 4px 0 rgb(var(--fg) / 0.6);
    border-radius: 4px;
  }


.card-header {
  @apply flex items-center justify-between mb-4;
}

  .section-title {
    @apply flex items-center gap-2 text-sm font-semibold;
    color: rgb(var(--fg));
    font-family: 'Courier New', 'SFMono-Regular', monospace;
    text-transform: uppercase;
    letter-spacing: 0.12em;
  }


.section-title svg {
  color: rgb(var(--accent));
}

/* Category List */
.category-list {
  @apply space-y-4;
}

  .category-item {
    @apply relative;
    padding: 12px;
    border: 2px solid rgb(var(--panel-border));
    box-shadow: 2px 2px 0 rgb(var(--fg) / 0.4);
    border-radius: 2px;
    background: rgb(var(--tag-bg));
    margin-bottom: 8px;
  }


.category-info {
  @apply flex items-center justify-between mb-1;
}

.category-name {
  @apply text-sm font-medium;
  color: rgb(var(--fg));
}

.category-count {
  @apply text-xs;
  color: rgb(var(--muted));
}

.category-stats {
  @apply flex items-center gap-3 mb-2;
}

.category-rank {
  @apply text-sm font-bold;
  color: rgb(var(--accent));
}

.category-rating {
  @apply text-sm font-semibold;
  color: rgb(var(--success));
}

  .category-bar {
    @apply h-2 overflow-hidden;
    background: rgb(var(--fg) / 0.08);
    border: 1px solid rgb(var(--panel-border));
    border-radius: 2px;
  }

  .bar-fill {
    @apply h-full;
    background: linear-gradient(to right, rgb(var(--accent)), rgb(var(--accent-strong)));
  }


/* Chart Area */
.chart-area {
  @apply relative;
}

.rating-chart {
  @apply w-full h-28;
}

.chart-labels {
  @apply flex justify-between mt-2 text-xs;
  color: rgb(var(--muted));
}

/* Works */
  .tab-group {
    @apply flex gap-1.5 p-1;
    background: rgb(var(--tag-bg));
    border: 2px solid rgb(var(--panel-border));
    box-shadow: 2px 2px 0 rgb(var(--fg) / 0.4);
    border-radius: 2px;
  }


  .tab-btn {
    @apply flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium transition-all;
    color: rgb(var(--muted));
    border-radius: 2px;
    font-family: 'Courier New', 'SFMono-Regular', monospace;
  }

  .tab-btn:hover {
    color: rgb(var(--fg));
    background: rgb(var(--panel));
  }

  .tab-btn.active {
    background: rgb(var(--fg));
    color: rgb(var(--panel));
    box-shadow: 2px 2px 0 rgb(var(--accent));
  }


.tab-count {
  @apply text-xs;
  color: rgb(var(--muted));
}

.works-list {
  @apply space-y-2;
}

  .work-item {
    @apply flex items-center gap-4 p-3;
    background: rgb(var(--tag-bg));
    border: 2px solid rgb(var(--panel-border));
    box-shadow: 2px 2px 0 rgb(var(--fg) / 0.4);
    border-radius: 2px;
  }


.work-rating {
  @apply w-12 text-center text-sm font-bold shrink-0;
  color: rgb(var(--muted));
}

.work-rating.up {
  color: rgb(var(--success));
}

.work-rating.down {
  color: rgb(var(--danger));
}

.work-info {
  @apply flex-1 min-w-0;
}

  .work-title {
    @apply text-sm font-medium truncate;
    color: rgb(var(--fg));
    font-family: 'Times New Roman', 'Songti SC', serif;
  }


  .work-meta {
    @apply flex items-center gap-3 text-xs;
    color: rgb(var(--muted));
    font-family: 'Courier New', 'SFMono-Regular', monospace;
  }


/* Sidebar */
.side-column {
  @apply space-y-4;
}

  .sidebar-card {
    @apply p-5;
    background: rgb(var(--panel));
    border: 2px solid rgb(var(--panel-border));
    box-shadow: 4px 4px 0 rgb(var(--fg) / 0.7);
    border-radius: 4px;
  }


.sidebar-title {
  @apply flex items-center gap-2 text-sm font-semibold mb-4;
  color: rgb(var(--fg));
}

.sidebar-title svg {
  color: rgb(var(--accent));
}

/* Favorite Lists */
.favorite-list {
  @apply space-y-3;
}

.favorite-item {
  @apply flex items-center gap-3;
}

.favorite-name {
  @apply flex-1 text-sm font-medium truncate;
  color: rgb(var(--fg));
}

.favorite-votes {
  @apply flex items-center gap-2 text-xs font-semibold;
}

/* Recent Votes */
.recent-votes-list {
  @apply space-y-2;
}

.recent-vote-item {
  @apply flex items-center gap-2 p-2 rounded-lg;
  background: rgb(var(--tag-bg));
  border: 1px solid rgb(var(--panel-border));
  box-shadow: 0 1px 2px rgb(var(--fg) / 0.04);
}

.vote-page {
  @apply flex-1 text-sm font-medium truncate;
  color: rgb(var(--fg));
}

.vote-page:hover {
  color: rgb(var(--accent));
}

.vote-dir {
  @apply text-xs font-bold;
}

.vote-dir.up {
  color: rgb(var(--success));
}

.vote-dir.down {
  color: rgb(var(--danger));
}

.vote-time {
  @apply text-xs;
  color: rgb(var(--muted));
}
</style>
