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
  background: rgb(var(--bg));
  color: rgb(var(--fg));
}

/* Ambient Background */
.ambient-bg {
  @apply fixed inset-0 pointer-events-none overflow-hidden;
  z-index: 0;
}

.glow {
  @apply absolute rounded-full blur-3xl;
}

.glow-1 {
  @apply w-[600px] h-[600px] -top-32 right-1/4;
  background: radial-gradient(circle, rgb(var(--accent) / 0.15), transparent 70%);
}

.noise-layer {
  @apply absolute inset-0 opacity-[0.012];
  background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.8' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)'/%3E%3C/svg%3E");
}

/* Container */
.page-container {
  @apply relative z-10 max-w-6xl mx-auto px-6 py-8 space-y-6;
}

/* Share Card - First Screen Focus */
.share-card {
  @apply rounded-3xl p-6 lg:p-8;
  background: rgb(var(--panel) / 0.75);
  backdrop-filter: blur(20px);
  border: 1px solid rgb(var(--panel-border) / 0.5);
  box-shadow: 0 26px 70px rgb(0 0 0 / 0.12);
}

.share-card-inner {
  @apply flex flex-col lg:flex-row gap-6 lg:gap-10;
}

/* Left Column: Title & Meta */
.card-left {
  @apply flex-1 min-w-0 space-y-4;
}

.card-badges {
  @apply flex items-center gap-2;
}

.badge {
  @apply inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-semibold;
}

.badge-premium {
  background: linear-gradient(135deg, #fbbf24, #f59e0b);
  color: white;
  box-shadow: 0 2px 8px rgb(245 158 11 / 0.3);
}

.badge-tracking {
  background: rgb(var(--accent) / 0.1);
  color: rgb(var(--accent));
  border: 1px solid rgb(var(--accent) / 0.2);
}

.title-block {
  @apply space-y-1;
}

.page-title {
  @apply text-2xl sm:text-3xl lg:text-4xl font-bold;
  color: rgb(var(--fg));
}

.page-subtitle {
  @apply text-lg sm:text-xl lg:text-2xl font-semibold;
  color: rgb(var(--accent));
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
}

.card-tags {
  @apply flex flex-wrap gap-2;
}

.tag {
  @apply px-2.5 py-1 rounded-lg text-xs font-medium;
  background: rgb(var(--fg) / 0.05);
  color: rgb(var(--muted-strong));
}

.tag-primary {
  background: rgb(var(--accent) / 0.1);
  color: rgb(var(--accent));
}

/* Right Column: Rating & Stats */
.card-right {
  @apply shrink-0 flex flex-col items-center lg:items-end gap-4 lg:w-[220px];
  @apply pt-4 lg:pt-0 border-t lg:border-t-0 lg:border-l lg:pl-10;
  border-color: rgb(var(--panel-border) / 0.5);
}

.rating-block {
  @apply text-center lg:text-right;
}

.rating-value {
  @apply block text-4xl lg:text-5xl font-bold tabular-nums;
  color: rgb(var(--success));
}

.rating-label {
  @apply text-sm;
  color: rgb(var(--muted));
}

.stats-grid {
  @apply grid grid-cols-4 lg:grid-cols-2 gap-3 w-full;
}

.stat-box {
  @apply text-center p-2 rounded-xl;
  background: rgb(var(--fg) / 0.03);
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
  @apply flex items-center justify-center gap-2 w-full px-4 py-2.5 rounded-xl text-sm font-medium transition-all;
  background: rgb(var(--fg) / 0.05);
  color: rgb(var(--muted-strong));
}

.wikidot-link:hover {
  background: rgb(var(--accent) / 0.1);
  color: rgb(var(--accent));
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
  @apply p-5 rounded-2xl mb-4;
  background: rgb(var(--panel) / 0.6);
  backdrop-filter: blur(20px);
  border: 1px solid rgb(var(--panel-border) / 0.5);
}

.card-header {
  @apply flex items-center justify-between mb-4;
}

.section-title {
  @apply flex items-center gap-2 text-sm font-semibold;
  color: rgb(var(--fg));
}

.section-title svg {
  color: rgb(var(--accent));
}

/* Chart */
.chart-controls {
  @apply flex gap-1 p-1 rounded-lg;
  background: rgb(var(--fg) / 0.05);
}

.chart-btn {
  @apply px-3 py-1 rounded-md text-xs font-medium transition-all;
  color: rgb(var(--muted));
}

.chart-btn:hover {
  color: rgb(var(--fg));
}

.chart-btn.active {
  background: rgb(var(--panel));
  color: rgb(var(--fg));
  box-shadow: 0 1px 3px rgb(0 0 0 / 0.05);
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
  @apply flex items-center gap-3 p-2.5 rounded-lg;
  background: rgb(var(--fg) / 0.02);
}

.vote-user {
  @apply flex-1 text-sm font-medium;
  color: rgb(var(--fg));
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
  @apply p-3 rounded-xl;
  background: rgb(var(--fg) / 0.02);
}

.revision-header {
  @apply flex items-center justify-between mb-2;
}

.revision-type {
  @apply px-2 py-0.5 rounded text-xs font-semibold;
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
  @apply p-5 rounded-2xl;
  background: rgb(var(--panel) / 0.6);
  backdrop-filter: blur(20px);
  border: 1px solid rgb(var(--panel-border) / 0.5);
}

.sidebar-title {
  @apply text-sm font-semibold mb-4;
  color: rgb(var(--fg));
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
}

.info-item dd {
  @apply font-medium;
  color: rgb(var(--fg));
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
