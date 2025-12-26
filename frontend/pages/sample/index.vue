<template>
  <div class="sample-page">
    <!-- Ambient Background -->
    <div class="ambient-bg">
      <div class="glow glow-1"></div>
      <div class="glow glow-2"></div>
      <div class="noise-layer"></div>
    </div>

    <div class="page-container">
      <!-- Hero Banner -->
      <section class="hero-banner">
        <NuxtLink to="/sample/page" class="banner-link">
          <div class="banner-bg"></div>
          <div class="banner-content">
            <div class="banner-badge">竞赛专题页面</div>
            <div class="banner-text">
              <h1 class="banner-title">SCP-CN-4000 "难题"竞赛</h1>
              <p class="banner-desc">我们的世界已然如此，基金会的世界又将如何？</p>
            </div>
            <div class="banner-action">
              <LucideIcon name="Sparkles" class="w-4 h-4" />
              <span>立即前往</span>
            </div>
          </div>
        </NuxtLink>
      </section>

      <!-- Overview Section -->
      <section class="overview-section">
        <div class="section-header">
          <div class="section-title-group">
            <div class="section-icon-wrapper">
              <LucideIcon name="LayoutDashboard" class="w-6 h-6" />
            </div>
            <h2 class="section-title">站点总览</h2>
          </div>
          <span class="update-time" :title="overviewUpdatedAtFull">上次更新：{{ overviewUpdatedAtRelative }}</span>
        </div>

        <div class="stats-grid">
          <!-- Users Card -->
          <div class="stat-card">
            <div class="stat-header">用户</div>
            <div class="stat-value">{{ formatNumber(overview.users.total) }}</div>
            <div class="stat-details">
              <div class="stat-row">
                <span class="stat-label">活跃</span>
                <span>{{ formatNumber(overview.users.active) }}</span>
              </div>
              <div class="stat-row">
                <span class="stat-label">贡献者</span>
                <span>{{ formatNumber(overview.users.contributors) }}</span>
              </div>
              <div class="stat-row">
                <span class="stat-label">作者</span>
                <span>{{ formatNumber(overview.users.authors) }}</span>
              </div>
            </div>
          </div>

          <!-- Pages Card -->
          <div class="stat-card">
            <div class="stat-header">页面</div>
            <div class="stat-value">{{ formatNumber(overview.pages.total) }}</div>
            <div class="stat-details">
              <div class="stat-row">
                <span class="stat-label">原创</span>
                <span>{{ formatNumber(overview.pages.originals) }}</span>
              </div>
              <div class="stat-row">
                <span class="stat-label">翻译</span>
                <span>{{ formatNumber(overview.pages.translations) }}</span>
              </div>
              <div class="stat-row">
                <span class="stat-label">已删除</span>
                <span>{{ formatNumber(overview.pages.deleted) }}</span>
              </div>
            </div>
          </div>

          <!-- Votes Card -->
          <div class="stat-card">
            <div class="stat-header">投票</div>
            <div class="stat-value">{{ formatNumber(overview.votes.total) }}</div>
            <div class="stat-details">
              <div class="stat-row">
                <span class="stat-label">upvote</span>
                <span>{{ formatNumber(overview.votes.upvotes) }}</span>
              </div>
              <div class="stat-row">
                <span class="stat-label">downvote</span>
                <span>{{ formatNumber(overview.votes.downvotes) }}</span>
              </div>
            </div>
          </div>

          <!-- Revisions Card -->
          <div class="stat-card stat-card-simple">
            <div class="stat-header">修订</div>
            <div class="stat-value-center">{{ formatNumber(overview.revisions.total) }}</div>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'

// Mock overview data (matching current index.vue structure)
const overview = ref({
  users: { total: 8920, active: 2156, contributors: 1823, authors: 945 },
  pages: { total: 12345, originals: 8234, translations: 3156, deleted: 955 },
  votes: { total: 456789, upvotes: 398234, downvotes: 58555 },
  revisions: { total: 234567 },
  updatedAt: new Date().toISOString()
})

// Format number with locale
function formatNumber(num: number): string {
  return Number(num || 0).toLocaleString()
}

// Time formatting (same as current index.vue)
const mounted = ref(false)
onMounted(() => { mounted.value = true })

function parseDateInput(input?: string | Date | null): Date | null {
  if (!input) return null
  const d = new Date(input as any)
  if (isNaN(d.getTime())) return null
  return d
}

function formatToGmt8Full(input?: string | Date | null): string {
  const d = parseDateInput(input)
  if (!d) return '—'
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).formatToParts(d)
  const get = (type: string) => parts.find(p => p.type === type)?.value || ''
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')} GMT+8`
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
  const months = Math.floor(days / 30)
  if (months < 12) return chineseNum(months, '个月')
  const years = Math.floor(days / 365)
  return chineseNum(years, '年')
}

const overviewUpdatedAtFull = computed(() => formatToGmt8Full(overview.value.updatedAt))
const overviewUpdatedAtRelative = computed(() => mounted.value ? formatRelativeZh(overview.value.updatedAt) : overviewUpdatedAtFull.value)

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
  @apply w-[600px] h-[600px] -top-32 left-1/4;
  background: radial-gradient(circle, rgb(var(--accent) / 0.15), transparent 70%);
}

.glow-2 {
  @apply w-[400px] h-[400px] top-1/3 -right-16;
  background: radial-gradient(circle, rgb(var(--accent-weak) / 0.1), transparent 70%);
}

.noise-layer {
  @apply absolute inset-0 opacity-[0.012];
  background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.8' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)'/%3E%3C/svg%3E");
}

/* Container */
.page-container {
  @apply relative z-10 max-w-4xl mx-auto px-6 py-8 space-y-8;
}

/* Hero Banner */
.hero-banner {
  @apply rounded-3xl overflow-hidden;
  background: rgb(var(--panel) / 0.7);
  backdrop-filter: blur(20px);
  border: 1px solid rgb(var(--panel-border) / 0.5);
  box-shadow: 0 26px 70px rgb(0 0 0 / 0.12);
}

.banner-link {
  @apply relative flex min-h-[240px] sm:min-h-[300px] items-stretch overflow-hidden;
}

.banner-bg {
  @apply absolute inset-0;
  background: linear-gradient(145deg, rgb(var(--accent) / 0.25), rgb(var(--accent-weak) / 0.15), transparent);
}

.banner-content {
  @apply relative flex flex-1 flex-col justify-end items-end gap-4 px-6 py-10 text-right sm:px-8 md:px-10;
}

.banner-badge {
  @apply inline-flex items-center gap-2 rounded-full px-4 py-1 text-xs font-semibold uppercase tracking-wider;
  background: rgb(var(--panel) / 0.6);
  color: rgb(var(--muted-strong));
  border: 1px solid rgb(var(--panel-border) / 0.5);
  backdrop-filter: blur(10px);
}

.banner-text {
  @apply space-y-2;
}

.banner-title {
  @apply text-2xl sm:text-3xl font-bold;
  color: rgb(var(--fg));
}

.banner-desc {
  @apply text-sm max-w-md;
  color: rgb(var(--muted));
}

.banner-action {
  @apply inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-semibold transition-all;
  background: rgb(var(--accent) / 0.15);
  color: rgb(var(--accent));
  border: 1px solid rgb(var(--accent) / 0.3);
}

.banner-link:hover .banner-action {
  background: rgb(var(--accent) / 0.25);
  transform: translateY(-2px);
}

/* Overview Section */
.overview-section {
  @apply space-y-6;
}

.section-header {
  @apply flex items-center justify-between gap-4 flex-wrap;
}

.section-title-group {
  @apply flex items-center gap-4;
}

.section-icon-wrapper {
  @apply w-12 h-12 rounded-2xl flex items-center justify-center;
  background: rgb(var(--accent) / 0.14);
  color: rgb(var(--accent));
  box-shadow: 0 10px 24px rgb(var(--accent) / 0.18);
}

.section-title {
  @apply text-2xl font-semibold;
  color: rgb(var(--fg));
}

.update-time {
  @apply text-sm;
  color: rgb(var(--muted));
}

/* Stats Grid */
.stats-grid {
  @apply grid grid-cols-1 sm:grid-cols-2 gap-4;
}

.stat-card {
  @apply relative overflow-hidden rounded-2xl p-6 text-center transition-all duration-300;
  background: rgb(var(--panel) / 0.75);
  border: 1px solid rgb(var(--panel-border) / 0.6);
  backdrop-filter: blur(20px);
  box-shadow: 0 20px 50px rgb(0 0 0 / 0.1);
}

.stat-card::before {
  content: '';
  @apply absolute inset-0 pointer-events-none opacity-0 transition-opacity;
  background: radial-gradient(circle at top, rgb(var(--accent) / 0.18), transparent 70%);
}

.stat-card:hover {
  transform: translateY(-4px);
  box-shadow: 0 32px 70px rgb(0 0 0 / 0.16);
}

.stat-card:hover::before {
  opacity: 1;
}

.stat-header {
  @apply text-xs font-semibold uppercase tracking-wide;
  color: rgb(var(--muted));
}

.stat-value {
  @apply mt-4 text-3xl font-semibold tabular-nums;
  color: rgb(var(--fg));
}

.stat-value-center {
  @apply flex-1 flex items-center justify-center text-3xl font-semibold tabular-nums;
  color: rgb(var(--fg));
}

.stat-card-simple {
  @apply flex flex-col min-h-[13rem];
}

.stat-details {
  @apply mt-4 space-y-2 text-xs;
  color: rgb(var(--muted));
}

.stat-row {
  @apply flex items-center justify-center gap-2;
}

.stat-label {
  @apply font-medium;
  color: rgb(var(--muted-strong));
}
</style>
