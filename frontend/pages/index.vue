<template>
  <div class="space-y-8">
    <!-- Overview metrics -->
    <section class="space-y-6">
      <div class="flex items-center justify-between gap-2 flex-wrap">
        <div class="flex items-center gap-4">
          <div class="flex h-12 w-12 items-center justify-center rounded-2xl bg-[rgba(var(--accent),0.14)] text-[rgb(var(--accent))] shadow-[0_10px_24px_rgba(10,132,255,0.18)]">
            <LucideIcon name="LayoutDashboard" class="h-6 w-6" />
          </div>
          <div>
            <h2 class="text-2xl font-semibold text-neutral-900 dark:text-neutral-50">站点总览</h2>
          </div>
        </div>
        <span class="text-sm text-neutral-500 dark:text-neutral-400" :title="overviewUpdatedAtFull">上次更新：{{ overviewUpdatedAtRelative }}</span>
      </div>
      <div class="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-2 xl:mx-auto xl:max-w-[50vw] xl:min-w-[640px]">
        <!-- Users Block -->
        <div class="relative overflow-hidden rounded-2xl border border-white/60 bg-white/75 p-6 shadow-[0_20px_50px_rgba(15,23,42,0.10)] transition-all duration-300 hover:-translate-y-1 hover:shadow-[0_32px_70px_rgba(15,23,42,0.16)] before:pointer-events-none before:absolute before:inset-0 before:bg-[radial-gradient(circle_at_top,_rgba(var(--accent),0.18),_transparent_70%)] before:opacity-0 before:transition-opacity before:content-[''] dark:border-white/10 dark:bg-neutral-950/65 dark:shadow-[0_36px_80px_rgba(0,0,0,0.55)] hover:before:opacity-100">
          <div class="text-xs font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">用户</div>
          <div class="mt-4 flex items-end justify-between gap-3">
            <div class="text-3xl font-semibold text-neutral-900 dark:text-neutral-50">{{ Number(overview?.users?.total || 0).toLocaleString() }}</div>
            <svg v-if="overviewSparks.usersTotal" width="96" height="28" viewBox="0 0 100 24" preserveAspectRatio="none">
              <polyline :points="overviewSparks.usersTotal" fill="none" :stroke="sparkStroke" stroke-width="1.8" stroke-linecap="round" />
            </svg>
          </div>
          <div class="mt-4 space-y-2 text-xs text-neutral-600 dark:text-neutral-400">
            <div class="flex items-center justify-between gap-3">
              <span class="font-medium text-neutral-700 dark:text-neutral-300">活跃</span>
              <div class="flex items-center gap-2">
                <span>{{ Number(overview?.users?.active || 0).toLocaleString() }}</span>
                <svg v-if="overviewSparks.usersActive" width="80" height="18" viewBox="0 0 100 24" preserveAspectRatio="none">
                  <polyline :points="overviewSparks.usersActive" fill="none" :stroke="sparkStroke" stroke-width="1.5" stroke-linecap="round" />
                </svg>
              </div>
            </div>
            <div class="flex items-center justify-between gap-3">
              <span class="font-medium text-neutral-700 dark:text-neutral-300">贡献者</span>
              <div class="flex items-center gap-2">
                <span>{{ Number(overview?.users?.contributors || 0).toLocaleString() }}</span>
                <svg v-if="overviewSparks.usersContributors" width="80" height="18" viewBox="0 0 100 24" preserveAspectRatio="none">
                  <polyline :points="overviewSparks.usersContributors" fill="none" :stroke="sparkStroke" stroke-width="1.5" stroke-linecap="round" />
                </svg>
              </div>
            </div>
            <div class="flex items-center justify-between gap-3">
              <span class="font-medium text-neutral-700 dark:text-neutral-300">作者</span>
              <div class="flex items-center gap-2">
                <span>{{ Number(overview?.users?.authors || 0).toLocaleString() }}</span>
                <svg v-if="overviewSparks.usersAuthors" width="80" height="18" viewBox="0 0 100 24" preserveAspectRatio="none">
                  <polyline :points="overviewSparks.usersAuthors" fill="none" :stroke="sparkStroke" stroke-width="1.5" stroke-linecap="round" />
                </svg>
              </div>
            </div>
          </div>
        </div>

        <!-- Pages Block -->
        <div class="relative overflow-hidden rounded-2xl border border-white/60 bg-white/75 p-6 shadow-[0_20px_50px_rgba(15,23,42,0.10)] transition-all duration-300 hover:-translate-y-1 hover:shadow-[0_32px_70px_rgba(15,23,42,0.16)] before:pointer-events-none before:absolute before:inset-0 before:bg-[radial-gradient(circle_at_top,_rgba(166,200,255,0.28),_transparent_72%)] before:opacity-0 before:transition-opacity before:content-[''] dark:border-white/10 dark:bg-neutral-950/65 dark:shadow-[0_36px_80px_rgba(0,0,0,0.55)] hover:before:opacity-100">
          <div class="text-xs font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">页面</div>
          <div class="mt-4 flex items-end justify-between gap-3">
            <div class="text-3xl font-semibold text-neutral-900 dark:text-neutral-50">{{ Number(overview?.pages?.total || 0).toLocaleString() }}</div>
            <svg v-if="overviewSparks.pagesTotal" width="96" height="28" viewBox="0 0 100 24" preserveAspectRatio="none">
              <polyline :points="overviewSparks.pagesTotal" fill="none" :stroke="sparkStroke" stroke-width="1.8" stroke-linecap="round" />
            </svg>
          </div>
          <div class="mt-4 space-y-2 text-xs text-neutral-600 dark:text-neutral-400">
            <div class="flex items-center justify-between gap-3">
              <span class="font-medium text-neutral-700 dark:text-neutral-300">原创</span>
              <div class="flex items-center gap-2">
                <span>{{ Number(overview?.pages?.originals || 0).toLocaleString() }}</span>
                <svg v-if="overviewSparks.pagesOriginals" width="80" height="18" viewBox="0 0 100 24" preserveAspectRatio="none">
                  <polyline :points="overviewSparks.pagesOriginals" fill="none" :stroke="sparkStroke" stroke-width="1.5" stroke-linecap="round" />
                </svg>
              </div>
            </div>
            <div class="flex items-center justify-between gap-3">
              <span class="font-medium text-neutral-700 dark:text-neutral-300">翻译</span>
              <div class="flex items-center gap-2">
                <span>{{ Number(overview?.pages?.translations || 0).toLocaleString() }}</span>
                <svg v-if="overviewSparks.pagesTranslations" width="80" height="18" viewBox="0 0 100 24" preserveAspectRatio="none">
                  <polyline :points="overviewSparks.pagesTranslations" fill="none" :stroke="sparkStroke" stroke-width="1.5" stroke-linecap="round" />
                </svg>
              </div>
            </div>
          </div>
        </div>

        <!-- Votes Block -->
        <div class="relative overflow-hidden rounded-2xl border border-white/60 bg-white/75 p-6 shadow-[0_20px_50px_rgba(15,23,42,0.10)] transition-all duration-300 hover:-translate-y-1 hover:shadow-[0_32px_70px_rgba(15,23,42,0.16)] before:pointer-events-none before:absolute before:inset-0 before:bg-[radial-gradient(circle_at_top,_rgba(10,132,255,0.16),_transparent_70%)] before:opacity-0 before:transition-opacity before:content-[''] dark:border-white/10 dark:bg-neutral-950/65 dark:shadow-[0_36px_80px_rgba(0,0,0,0.55)] hover:before:opacity-100">
          <div class="text-xs font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">投票</div>
          <div class="mt-4 flex items-end justify-between gap-3">
            <div class="text-3xl font-semibold text-neutral-900 dark:text-neutral-50">{{ Number(overview?.votes?.total || 0).toLocaleString() }}</div>
            <svg v-if="overviewSparks.votesTotal" width="96" height="28" viewBox="0 0 100 24" preserveAspectRatio="none">
              <polyline :points="overviewSparks.votesTotal" fill="none" :stroke="sparkStroke" stroke-width="1.8" stroke-linecap="round" />
            </svg>
          </div>
          <div class="mt-4 space-y-2 text-xs text-neutral-600 dark:text-neutral-400">
            <div class="flex items-center justify-between gap-3">
              <span class="font-medium text-neutral-700 dark:text-neutral-300">upvote</span>
              <div class="flex items-center gap-2">
                <span>{{ Number(overview?.votes?.upvotes || 0).toLocaleString() }}</span>
                <svg v-if="overviewSparks.votesUp" width="80" height="18" viewBox="0 0 100 24" preserveAspectRatio="none">
                  <polyline :points="overviewSparks.votesUp" fill="none" :stroke="sparkStroke" stroke-width="1.5" stroke-linecap="round" />
                </svg>
              </div>
            </div>
            <div class="flex items-center justify-between gap-3">
              <span class="font-medium text-neutral-700 dark:text-neutral-300">downvote</span>
              <div class="flex items-center gap-2">
                <span>{{ Number(overview?.votes?.downvotes || 0).toLocaleString() }}</span>
                <svg v-if="overviewSparks.votesDown" width="80" height="18" viewBox="0 0 100 24" preserveAspectRatio="none">
                  <polyline :points="overviewSparks.votesDown" fill="none" :stroke="sparkStroke" stroke-width="1.5" stroke-linecap="round" />
                </svg>
              </div>
            </div>
          </div>
        </div>

        <!-- Revisions Block -->
        <div class="relative overflow-hidden rounded-2xl border border-white/60 bg-white/75 p-6 shadow-[0_20px_50px_rgba(15,23,42,0.10)] transition-all duration-300 hover:-translate-y-1 hover:shadow-[0_32px_70px_rgba(15,23,42,0.16)] before:pointer-events-none before:absolute before:inset-0 before:bg-[radial-gradient(circle_at_top,_rgba(118,188,255,0.24),_transparent_68%)] before:opacity-0 before:transition-opacity before:content-[''] dark:border-white/10 dark:bg-neutral-950/65 dark:shadow-[0_36px_80px_rgba(0,0,0,0.55)] hover:before:opacity-100">
          <div class="text-xs font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">修订</div>
          <div class="mt-4 flex items-end justify-between gap-3">
            <div class="text-3xl font-semibold text-neutral-900 dark:text-neutral-50">{{ Number(overview?.revisions?.total || 0).toLocaleString() }}</div>
            <svg v-if="overviewSparks.revisionsTotal" width="96" height="28" viewBox="0 0 100 24" preserveAspectRatio="none">
              <polyline :points="overviewSparks.revisionsTotal" fill="none" :stroke="sparkStroke" stroke-width="1.8" stroke-linecap="round" />
            </svg>
          </div>
        </div>
      </div>
    </section>

  </div>
</template>

<script setup lang="ts">
import { useNuxtApp, useAsyncData } from 'nuxt/app';
import { ref, computed, onMounted } from 'vue';
import { formatDateIsoUtc8, nowUtc8 } from '~/utils/timezone';
type SiteOverviewRich = {
  date?: string;
  updatedAt?: string;
  users: { total: number; active: number; contributors: number; authors: number };
  pages: { total: number; originals: number; translations: number };
  votes: { total: number; upvotes: number; downvotes: number };
  revisions: { total: number };
};
type BffFetcher = <T = any>(url: string, options?: any) => Promise<T>;
const nuxtApp = useNuxtApp();
const bff = nuxtApp.$bff as unknown as BffFetcher;

// Fetch overview data server-side
const { data: overview } = await useAsyncData<SiteOverviewRich>('site-overview', () => bff<SiteOverviewRich>('/stats/site/overview'));

// 站点总览 sparkline（过去90天）
type OverviewSeriesItem = {
  date: string;
  users: { total: number; active: number; contributors: number; authors: number };
  pages: { total: number; originals: number; translations: number };
  votes: { total: number; upvotes: number; downvotes: number };
  revisions: { total: number };
};
const { data: overviewSeries } = await useAsyncData<OverviewSeriesItem[] | null>(
  'site-overview-series',
  () => {
    const base = nowUtc8();
    const start = new Date(base.getTime() - 30 * 86400000);
    const startDate = formatDateIsoUtc8(start) || formatDateIsoUtc8(base);
    return bff<OverviewSeriesItem[]>('/stats/site/overview/series', { params: { startDate } });
  },
);

function makeSparkPoints(values: number[] | undefined, width = 100, height = 24): string | null {
  if (!values || values.length < 2) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = (max - min) || 1;
  const n = values.length;
  return values.map((v, i) => {
    const x = (i/(n-1)) * width;
    const y = height - ((v - min) / range) * (height - 4) - 2;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
}

const overviewSparks = computed<Record<string, string | null>>(() => {
  const series = overviewSeries.value || [];
  const vals = (fn: (it: OverviewSeriesItem)=>number) => series.map(fn);
  const diffs = (arr: number[]) => arr.length < 2 ? [] : arr.slice(1).map((v, i) => v - arr[i]);
  const points = (arr: number[]) => makeSparkPoints(arr);
  return {
    // show daily increments for cumulative metrics
    usersTotal: points(diffs(vals(it => it.users.total))),
    usersActive: points(vals(it => it.users.active)), // active is a daily snapshot, not cumulative
    usersContributors: points(diffs(vals(it => it.users.contributors))),
    usersAuthors: points(diffs(vals(it => it.users.authors))),
    pagesTotal: points(diffs(vals(it => it.pages.total))),
    pagesOriginals: points(diffs(vals(it => it.pages.originals))),
    pagesTranslations: points(diffs(vals(it => it.pages.translations))),
    // votes/revisions already daily in backend
    votesTotal: points(vals(it => it.votes.total)),
    votesUp: points(vals(it => it.votes.upvotes)),
    votesDown: points(vals(it => it.votes.downvotes)),
    revisionsTotal: points(vals(it => it.revisions.total)),
  };
});

// stroke color derived from CSS variables
const sparkStroke = computed(() => {
  if (typeof window === 'undefined') return '#0a84ff'
  const cs = getComputedStyle(document.documentElement)
  const accent = (cs.getPropertyValue('--accent').trim() || '10 132 255').replace(/\s+/g, ' ')
  return `rgb(${accent})`
})

// removed series occupancy section

// 更新时间（GMT+8，悬浮显示完整时间，正文为相对时间）
const mounted = ref(false)
onMounted(() => {
  mounted.value = true
})

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
  const y = get('year')
  const M = get('month')
  const D = get('day')
  const h = get('hour')
  const m = get('minute')
  const s = get('second')
  return `${y}-${M}-${D} ${h}:${m}:${s} GMT+8`
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

const overviewUpdatedAtRaw = computed(() => (overview.value as any)?.updatedAt || (overview.value as any)?.date || null)
const overviewUpdatedAtFull = computed(() => formatToGmt8Full(overviewUpdatedAtRaw.value))
const overviewUpdatedAtRelative = computed(() => mounted.value ? formatRelativeZh(overviewUpdatedAtRaw.value) : overviewUpdatedAtFull.value)
</script>
