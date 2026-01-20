<template>
  <div class="sample-page">
    <!-- Ambient Background -->
    <div class="ambient-bg">
      <div class="glow glow-1"></div>
      <div class="noise-layer"></div>
    </div>

    <div class="page-container">
      <!-- Share Card Header - First Screen Focus -->
      <section class="share-card">
        <div class="share-card-inner">
          <!-- Left: Title & Meta -->
          <div class="card-left">
            <!-- Badges -->
            <div class="card-badges">
              <span class="badge badge-premium">
                <LucideIcon name="Award" class="w-3 h-3" />
                精品
              </span>
              <span class="badge badge-tracking">
                <LucideIcon name="Bell" class="w-3 h-3" />
                追踪中
              </span>
            </div>

            <!-- Title -->
            <div class="title-block">
              <h1 class="page-title">SCP-CN-001</h1>
              <h2 class="page-subtitle">等待解密</h2>
            </div>

            <!-- Author & Meta -->
            <div class="meta-block">
              <div class="author-chip">
                <UserAvatar :wikidot-id="123456" :size="36" name="AndyBlocker" />
                <div class="author-info">
                  <NuxtLink to="/sample/user" class="author-name">AndyBlocker</NuxtLink>
                  <span class="author-role">原作者</span>
                </div>
              </div>
              <div class="meta-items">
                <span class="meta-item">
                  <LucideIcon name="Calendar" class="w-4 h-4" />
                  2024-12-15 发布
                </span>
                <span class="meta-item">
                  <LucideIcon name="Edit3" class="w-4 h-4" />
                  Rev. 23
                </span>
              </div>
            </div>

            <!-- Tags -->
            <div class="card-tags">
              <span class="tag tag-primary">#scp</span>
              <span class="tag tag-primary">#cn</span>
              <span class="tag">#001提案</span>
              <span class="tag">#keter</span>
              <span class="tag">#模因</span>
              <span class="tag">#认知危害</span>
            </div>
          </div>

          <!-- Right: Rating & Stats -->
          <div class="card-right">
            <!-- Main Rating -->
            <div class="rating-block">
              <span class="rating-value">+128</span>
              <span class="rating-label">评分</span>
            </div>

            <!-- Stats Grid -->
            <div class="stats-grid">
              <div class="stat-box">
                <span class="stat-value">156</span>
                <span class="stat-label">投票数</span>
              </div>
              <div class="stat-box">
                <span class="stat-value success">82.1%</span>
                <span class="stat-label">Wilson</span>
              </div>
              <div class="stat-box">
                <span class="stat-value">0.123</span>
                <span class="stat-label">争议度</span>
              </div>
              <div class="stat-box">
                <span class="stat-value">45</span>
                <span class="stat-label">评论</span>
              </div>
            </div>

            <!-- Wikidot Link -->
            <a href="https://scp-wiki-cn.wikidot.com/scp-cn-001" target="_blank" class="wikidot-link">
              <LucideIcon name="ExternalLink" class="w-4 h-4" />
              在 Wikidot 查看
            </a>
          </div>
        </div>
      </section>

      <!-- Content Below First Screen -->
      <div class="content-grid">
        <main class="main-column">
          <!-- Rating History Chart -->
          <section class="content-card">
            <div class="card-header">
              <h3 class="section-title">
                <LucideIcon name="TrendingUp" class="w-5 h-5" />
                评分趋势
              </h3>
              <div class="chart-controls">
                <button class="chart-btn active">周</button>
                <button class="chart-btn">月</button>
                <button class="chart-btn">全部</button>
              </div>
            </div>
            <div class="chart-container">
              <svg viewBox="0 0 400 120" preserveAspectRatio="none" class="trend-chart">
                <defs>
                  <linearGradient id="chart-gradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stop-color="rgb(var(--accent))" stop-opacity="0.3" />
                    <stop offset="100%" stop-color="rgb(var(--accent))" stop-opacity="0" />
                  </linearGradient>
                </defs>
                <path d="M0,100 Q50,90 100,70 T200,50 T300,40 T400,20 L400,120 L0,120 Z" fill="url(#chart-gradient)" />
                <path d="M0,100 Q50,90 100,70 T200,50 T300,40 T400,20" fill="none" stroke="rgb(var(--accent))" stroke-width="2" stroke-linecap="round" />
              </svg>
              <div class="chart-labels">
                <span>12/08</span>
                <span>12/10</span>
                <span>12/12</span>
                <span>12/14</span>
                <span>12/16</span>
              </div>
            </div>
          </section>

          <!-- Recent Votes -->
          <section class="content-card">
            <h3 class="section-title">
              <LucideIcon name="ThumbsUp" class="w-5 h-5" />
              最近投票
            </h3>
            <div class="votes-list">
              <div v-for="vote in recentVotes" :key="vote.id" class="vote-item">
                <UserAvatar :wikidot-id="vote.userId" :size="24" :name="vote.user" />
                <span class="vote-user">{{ vote.user }}</span>
                <span :class="['vote-value', vote.value > 0 ? 'up' : 'down']">
                  {{ vote.value > 0 ? '+1' : '-1' }}
                </span>
                <span class="vote-time">{{ vote.time }}</span>
              </div>
            </div>
          </section>

          <!-- Revision History -->
          <section class="content-card">
            <h3 class="section-title">
              <LucideIcon name="History" class="w-5 h-5" />
              修订历史
            </h3>
            <div class="revisions-list">
              <div v-for="rev in revisions" :key="rev.id" class="revision-item">
                <div class="revision-header">
                  <span :class="['revision-type', rev.type]">{{ rev.typeLabel }}</span>
                  <span class="revision-num">Rev. {{ rev.num }}</span>
                </div>
                <div class="revision-content">
                  <span class="revision-comment">{{ rev.comment }}</span>
                  <div class="revision-meta">
                    <UserAvatar :wikidot-id="rev.userId" :size="18" :name="rev.user" />
                    <span class="revision-user">{{ rev.user }}</span>
                    <span class="revision-time">{{ rev.time }}</span>
                  </div>
                </div>
              </div>
            </div>
          </section>
        </main>

        <!-- Sidebar -->
        <aside class="side-column">
          <!-- Page Info -->
          <div class="sidebar-card">
            <h4 class="sidebar-title">页面信息</h4>
            <dl class="info-list">
              <div class="info-item">
                <dt>Wikidot ID</dt>
                <dd>12345678</dd>
              </div>
              <div class="info-item">
                <dt>分类</dt>
                <dd>SCP</dd>
              </div>
              <div class="info-item">
                <dt>创建日期</dt>
                <dd>2024-12-15</dd>
              </div>
              <div class="info-item">
                <dt>最后编辑</dt>
                <dd>2024-12-16</dd>
              </div>
            </dl>
          </div>

          <!-- Contributors -->
          <div class="sidebar-card">
            <h4 class="sidebar-title">贡献者</h4>
            <div class="contributors-list">
              <div class="contributor-item contributor-primary">
                <UserAvatar :wikidot-id="123456" :size="32" name="AndyBlocker" />
                <div class="contributor-info">
                  <span class="contributor-name">AndyBlocker</span>
                  <span class="contributor-role">原作者</span>
                </div>
              </div>
              <div class="contributor-item">
                <UserAvatar :wikidot-id="789" :size="32" name="Editor_A" />
                <div class="contributor-info">
                  <span class="contributor-name">Editor_A</span>
                  <span class="contributor-role">5 次修订</span>
                </div>
              </div>
            </div>
          </div>
        </aside>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'

// Mock data
const recentVotes = ref([
  { id: 1, user: 'Voter_A', userId: 111, value: 1, time: '2分钟前' },
  { id: 2, user: 'Voter_B', userId: 222, value: 1, time: '5分钟前' },
  { id: 3, user: 'Voter_C', userId: 333, value: -1, time: '8分钟前' },
  { id: 4, user: 'Voter_D', userId: 444, value: 1, time: '12分钟前' },
])

const revisions = ref([
  { id: 1, num: 23, type: 'edit', typeLabel: '编辑', comment: '修复了一些格式问题', user: 'AndyBlocker', userId: 123456, time: '1小时前' },
  { id: 2, num: 22, type: 'tags', typeLabel: '标签', comment: '添加了"精品"标签', user: 'Editor_A', userId: 789, time: '3小时前' },
  { id: 3, num: 21, type: 'edit', typeLabel: '编辑', comment: '补充了附录部分内容', user: 'AndyBlocker', userId: 123456, time: '1天前' },
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
  @apply w-[520px] h-[520px] -top-40 right-1/4;
  background: radial-gradient(circle, rgb(var(--accent) / 0.22), transparent 70%);
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
  @apply flex flex-col lg:flex-row gap-8 lg:gap-12;
}

/* Left Column: Title & Meta */
.card-left {
  @apply flex-1 min-w-0 space-y-4;
}

.card-badges {
  @apply flex items-center gap-2;
}

  .badge {
    @apply inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold;
    font-family: 'Courier New', 'SFMono-Regular', monospace;
    border-radius: 2px;
  }


  .badge-premium {
    background: rgb(var(--accent));
    color: white;
    border: 2px solid rgb(var(--fg));
    box-shadow: 3px 3px 0 rgb(var(--fg) / 0.8);
  }

  .badge-tracking {
    background: rgb(var(--tag-bg));
    color: rgb(var(--fg));
    border: 2px solid rgb(var(--panel-border));
    box-shadow: 2px 2px 0 rgb(var(--fg) / 0.5);
  }


.title-block {
  @apply space-y-1;
}

  .page-title {
    @apply text-2xl sm:text-3xl lg:text-4xl font-semibold tracking-tight leading-tight;
    color: rgb(var(--fg));
    font-family: 'Times New Roman', 'Songti SC', serif;
    letter-spacing: -0.02em;
  }


  .page-subtitle {
    @apply text-lg sm:text-xl lg:text-2xl font-semibold tracking-tight;
    color: rgb(var(--accent));
    font-family: 'Times New Roman', 'Songti SC', serif;
  }


.meta-block {
  @apply flex flex-wrap items-center gap-4 lg:gap-6;
}

.author-chip {
  @apply flex items-center gap-3;
}

.author-info {
  @apply flex flex-col;
}

  .author-name {
    @apply text-sm font-semibold;
    color: rgb(var(--fg));
    font-family: 'Courier New', 'SFMono-Regular', monospace;
  }


.author-name:hover {
  color: rgb(var(--accent));
}

.author-role {
  @apply text-xs;
  color: rgb(var(--muted));
}

.meta-items {
  @apply flex items-center gap-4;
}

  .meta-item {
    @apply flex items-center gap-1.5 text-sm;
    color: rgb(var(--muted));
    font-family: 'Courier New', 'SFMono-Regular', monospace;
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }


.card-tags {
  @apply flex flex-wrap gap-2;
}

  .tag {
    @apply px-3 py-1 text-xs font-medium tracking-wide;
    background: rgb(var(--tag-bg));
    border: 1px solid rgb(var(--tag-border));
    color: rgb(var(--tag-text));
    border-radius: 2px;
    font-family: 'Courier New', 'SFMono-Regular', monospace;
  }

  .tag-primary {
    background: rgb(var(--accent-weak));
    color: rgb(var(--accent-strong));
    border-color: rgb(var(--accent));
  }


/* Right Column: Rating & Stats */
  .card-right {
    @apply shrink-0 flex flex-col items-center lg:items-end gap-4 lg:w-[220px];
    @apply pt-4 lg:pt-0 border-t lg:border-t-0 lg:border-l lg:pl-10;
    border-color: rgb(var(--panel-border));
    position: relative;
  }

  .card-right::before {
    content: 'RATING';
    position: absolute;
    top: 10px;
    right: 10px;
    font-size: 9px;
    letter-spacing: 0.24em;
    color: rgb(var(--muted));
    font-family: 'Courier New', 'SFMono-Regular', monospace;
  }


.rating-block {
  @apply text-center lg:text-right;
}

  .rating-value {
    @apply block text-4xl lg:text-5xl font-bold tabular-nums;
    color: rgb(var(--success));
    font-family: 'Times New Roman', 'Songti SC', serif;
  }


.rating-label {
  @apply text-sm;
  color: rgb(var(--muted));
}

.stats-grid {
  @apply grid grid-cols-4 lg:grid-cols-2 gap-4 w-full;
}

  .stat-box {
    @apply text-center p-3;
    background: rgb(var(--tag-bg));
    border: 2px solid rgb(var(--panel-border));
    box-shadow: 2px 2px 0 rgb(var(--fg) / 0.5);
    border-radius: 2px;
  }


.stat-box .stat-value {
  @apply text-base font-bold tabular-nums;
  color: rgb(var(--fg));
}

.stat-box .stat-value.success {
  color: rgb(var(--success));
}

.stat-box .stat-label {
  @apply text-xs;
  color: rgb(var(--muted));
}

  .wikidot-link {
    @apply flex items-center justify-center gap-2 w-full px-4 py-2.5 text-sm font-medium transition-all;
    background: rgb(var(--fg));
    border: 2px solid rgb(var(--fg));
    color: rgb(var(--panel));
    box-shadow: 4px 4px 0 rgb(var(--accent));
    border-radius: 2px;
    font-family: 'Courier New', 'SFMono-Regular', monospace;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .wikidot-link:hover {
    background: rgb(var(--accent));
    color: #fff;
    transform: translate(1px, 1px);
    box-shadow: 2px 2px 0 rgb(var(--fg));
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

/* Chart */
  .chart-controls {
    @apply flex gap-1 p-1;
    background: rgb(var(--tag-bg));
    border: 2px solid rgb(var(--panel-border));
    box-shadow: 2px 2px 0 rgb(var(--fg) / 0.4);
    border-radius: 2px;
  }


  .chart-btn {
    @apply px-3 py-1 text-xs font-medium transition-all;
    color: rgb(var(--muted));
    border-radius: 2px;
    font-family: 'Courier New', 'SFMono-Regular', monospace;
  }

  .chart-btn:hover {
    color: rgb(var(--fg));
    background: rgb(var(--panel));
  }

  .chart-btn.active {
    background: rgb(var(--fg));
    color: rgb(var(--panel));
    box-shadow: 2px 2px 0 rgb(var(--accent));
  }


.chart-container {
  @apply relative;
}

.trend-chart {
  @apply w-full h-28;
}

.chart-labels {
  @apply flex justify-between mt-2 text-xs;
  color: rgb(var(--muted));
}

/* Votes List */
.votes-list {
  @apply space-y-2;
}

  .vote-item {
    @apply flex items-center gap-3 p-2.5;
    background: rgb(var(--tag-bg));
    border: 2px solid rgb(var(--panel-border));
    box-shadow: 2px 2px 0 rgb(var(--fg) / 0.4);
    border-radius: 2px;
  }


  .vote-user {
    @apply flex-1 text-sm font-medium;
    color: rgb(var(--fg));
    font-family: 'Courier New', 'SFMono-Regular', monospace;
  }


.vote-value {
  @apply text-sm font-bold;
}

.vote-value.up {
  color: rgb(var(--success));
}

.vote-value.down {
  color: rgb(var(--danger));
}

.vote-time {
  @apply text-xs;
  color: rgb(var(--muted));
}

/* Revisions List */
.revisions-list {
  @apply space-y-3;
}

  .revision-item {
    @apply p-3;
    background: rgb(var(--tag-bg));
    border: 2px solid rgb(var(--panel-border));
    box-shadow: 2px 2px 0 rgb(var(--fg) / 0.4);
    border-radius: 2px;
  }


.revision-header {
  @apply flex items-center justify-between mb-2;
}

  .revision-type {
    @apply px-2 py-0.5 text-xs font-semibold;
    border-radius: 2px;
    font-family: 'Courier New', 'SFMono-Regular', monospace;
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }


.revision-type.edit {
  background: rgb(var(--accent) / 0.1);
  color: rgb(var(--accent));
}

.revision-type.tags {
  background: rgb(52 211 153 / 0.1);
  color: rgb(16 185 129);
}

  .revision-num {
    @apply text-xs font-mono;
    color: rgb(var(--muted));
  }

  .revision-comment {
    font-family: 'Times New Roman', 'Songti SC', serif;
  }


.revision-content {
  @apply space-y-1;
}

.revision-comment {
  @apply block text-sm;
  color: rgb(var(--fg));
}

.revision-meta {
  @apply flex items-center gap-2 text-xs;
  color: rgb(var(--muted));
}

.revision-user {
  color: rgb(var(--muted-strong));
}

/* Sidebar */
.side-column {
  @apply space-y-4;
}

  .sidebar-card {
    @apply p-6;
    background: rgb(var(--panel));
    border: 2px solid rgb(var(--panel-border));
    box-shadow: 4px 4px 0 rgb(var(--fg) / 0.7);
    border-radius: 4px;
  }



  .sidebar-title {
    @apply text-sm font-semibold mb-4;
    color: rgb(var(--fg));
    font-family: 'Courier New', 'SFMono-Regular', monospace;
    text-transform: uppercase;
    letter-spacing: 0.12em;
  }


/* Info List */
.info-list {
  @apply space-y-2.5;
}

  .info-item {
    @apply flex justify-between text-sm;
  }

  .info-item dt {
    color: rgb(var(--muted));
    font-family: 'Courier New', 'SFMono-Regular', monospace;
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }

  .info-item dd {
    @apply font-medium;
    color: rgb(var(--fg));
    font-family: 'Times New Roman', 'Songti SC', serif;
  }


/* Contributors */
.contributors-list {
  @apply space-y-3;
}

.contributor-item {
  @apply flex items-center gap-3 p-2 rounded-lg;
}

.contributor-primary {
  background: rgb(var(--accent) / 0.05);
}

.contributor-info {
  @apply flex flex-col;
}

.contributor-name {
  @apply text-sm font-medium;
  color: rgb(var(--fg));
}

.contributor-role {
  @apply text-xs;
  color: rgb(var(--muted));
}
</style>
