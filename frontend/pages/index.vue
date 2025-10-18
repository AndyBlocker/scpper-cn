<template>
  <div class="space-y-8">
    <!-- Overview metrics -->
    <section class="space-y-6">
      <div class="flex items-center justify-between gap-2 flex-wrap">
        <div class="flex items-center gap-4">
          <div class="flex h-12 w-12 items-center justify-center rounded-2xl bg-[rgba(var(--accent),0.14)] text-[rgb(var(--accent))] shadow-[0_10px_24px_rgba(10,132,255,0.18)]">
            <svg class="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0h6" />
            </svg>
          </div>
          <div>
            <h2 class="text-2xl font-semibold text-neutral-900 dark:text-neutral-50">站点总览</h2>
          </div>
        </div>
        <span class="text-sm text-neutral-500 dark:text-neutral-400" :title="overviewUpdatedAtFull">上次更新：{{ overviewUpdatedAtRelative }}</span>
      </div>
      <div class="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
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

    <!-- Random picks -->
    <section class="space-y-6">
      <div class="flex items-center justify-between gap-2 flex-wrap">
        <div class="flex items-center gap-4">
          <div class="flex h-12 w-12 items-center justify-center rounded-2xl bg-[rgba(var(--accent),0.14)] text-[rgb(var(--accent))] shadow-[0_10px_24px_rgba(10,132,255,0.18)]">
            <svg class="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M4 4v6h6M20 20v-6h-6M5 19a9 9 0 0014-7" />
            </svg>
          </div>
          <div>
            <h2 class="text-2xl font-semibold text-neutral-900 dark:text-neutral-50">随机页面</h2>
            <p class="hidden sm:block text-sm text-neutral-500 dark:text-neutral-400">从随机推荐中发现值得一读的作品。</p>
          </div>
        </div>
        <button
          @click="refreshRandomPages"
          class="inline-flex items-center gap-2 rounded-full border border-[rgba(var(--accent),0.28)] bg-white/80 px-4 py-2 text-sm font-medium text-[rgb(var(--accent))] shadow-[0_12px_28px_rgba(10,132,255,0.15)] transition-all hover:-translate-y-0.5 hover:border-[rgba(var(--accent),0.4)] hover:text-[rgb(var(--accent-strong))] focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-[rgba(var(--accent),0.5)] dark:bg-neutral-950/70 dark:focus:ring-offset-neutral-950"
        >
          <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v6h6M20 20v-6h-6M5 19a9 9 0 0014-7" />
          </svg>
          刷新推荐
        </button>
      </div>
      <div class="rounded-[28px] border border-white/60 bg-white/65 p-6 shadow-[0_28px_70px_rgba(15,23,42,0.12)] backdrop-blur-xl dark:border-white/10 dark:bg-neutral-950/65 dark:shadow-[0_36px_80px_rgba(0,0,0,0.55)]">
        <div v-if="loadingPages" class="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          <div v-for="i in 6" :key="i" class="animate-pulse rounded-2xl border border-white/60 bg-white/70 p-5 dark:border-white/10 dark:bg-neutral-900/70">
            <div class="mb-4 h-6 rounded-full bg-neutral-200/70 dark:bg-neutral-700/60"></div>
            <div class="mb-3 h-4 w-3/4 rounded-full bg-neutral-200/60 dark:bg-neutral-700/50"></div>
            <div class="h-20 rounded-2xl bg-neutral-200/50 dark:bg-neutral-800/50"></div>
          </div>
        </div>
        <div v-else-if="pages.length > 0" class="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          <PageCard v-for="p in pages" :key="p.wikidotId" :p="p" :authors="p.authorObjs" :comments="Number(p.commentCount ?? 0)" size="lg" />
        </div>
        <div v-else class="flex flex-col items-center gap-4 rounded-2xl border border-white/70 bg-white/70 px-6 py-12 text-center text-neutral-500 dark:border-white/10 dark:bg-neutral-900/70 dark:text-neutral-300">
          <svg class="h-12 w-12 text-neutral-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
          <div class="space-y-2">
            <p class="text-sm">暂时没有推荐内容，试试刷新？</p>
            <button
              @click="refreshRandomPages"
              class="inline-flex items-center gap-2 rounded-full bg-[rgb(var(--accent))] px-5 py-2 text-sm font-medium text-white shadow-[0_14px_36px_rgba(10,132,255,0.35)] transition-all hover:-translate-y-0.5 hover:shadow-[0_18px_44px_rgba(10,132,255,0.45)] focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-[rgba(var(--accent),0.65)] dark:focus:ring-offset-neutral-950"
            >
              再来一次
              <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v6h6M20 20v-6h-6M5 19a9 9 0 0014-7" />
              </svg>
            </button>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { useRuntimeConfig, useNuxtApp, useAsyncData } from 'nuxt/app';
import { ref, computed, onMounted } from 'vue';
type SeriesInfo = { seriesNumber: number; usedSlots: number; totalSlots: number };
type SiteOverview = { date?: string; totalUsers?: number; activeUsers?: number; totalPages?: number; totalVotes?: number };
type SiteOverviewRich = {
  date?: string;
  updatedAt?: string;
  users: { total: number; active: number; contributors: number; authors: number };
  pages: { total: number; originals: number; translations: number };
  votes: { total: number; upvotes: number; downvotes: number };
  revisions: { total: number };
};
type BasicPage = { wikidotId: number; title?: string; alternateTitle?: string; rating?: number; voteCount?: number; category?: string; tags?: string[]; createdAt?: string; revisionCount?: number; attributionCount?: number; url?: string; textContent?: string };
type BffFetcher = <T = any>(url: string, options?: any) => Promise<T>;
const config = useRuntimeConfig();
const nuxtApp = useNuxtApp();
const bff = nuxtApp.$bff as unknown as BffFetcher;

// Fetch base data and enhancements in parallel on server side
const [{ data: overview }, { data: pagesData }] = await Promise.all([
  useAsyncData<SiteOverviewRich>('site-overview', () => bff<SiteOverviewRich>('/stats/site/overview')),
  useAsyncData<any[]>('pages', async () => {
    // First get the pages
    const basePages = await bff<BasicPage[]>('/pages/random', { params: { limit: 6 } });
    const excludedSet = new Set<string>(['作者','段落','补充材料']);
    const filteredBasePages = (basePages || []).filter((p: any) => Array.isArray(p.tags) && p.tags.length > 0 && !(p.tags as string[]).some(t => excludedSet.has(t)));
    
    // Then enhance each page with additional data
    const enhancedPages = await Promise.all((filteredBasePages || []).map(async (p: any) => {
      try {
        const [attr, cumu, firstRevData, stats] = await Promise.all([
          bff(`/pages/${p.wikidotId}/attributions`),
          bff(`/pages/${p.wikidotId}/ratings/cumulative`),
          bff(`/pages/${p.wikidotId}/revisions`, { params: { limit: 1, offset: 0, order: 'ASC', type: 'PAGE_CREATED' } }),
          bff(`/stats/pages/${p.wikidotId}`).catch(() => null)
        ]);
        
        const firstRev = firstRevData && firstRevData[0];
        
        // Set authors - fallback to dummy when empty (use avatar backend default via id=0)
        const authorList = Array.isArray(attr) && attr.length > 0 ? attr : [{ displayName: '(account deleted)', userWikidotId: 0 }];
        const authors = authorList.map((a: any) => a.displayName).join('、');
        const authorObjs = authorList.map((a: any) => {
          const idNum = Number(a.userWikidotId)
          const url = (Number.isFinite(idNum) && idNum > 0) ? `/user/${idNum}` : undefined
          return { name: a.displayName, url }
        });
        
        // Set creation date from first revision
        const baseTs = firstRev ? new Date(firstRev.timestamp).getTime() : undefined;
        const createdDate = baseTs ? new Date(baseTs).toISOString().slice(0,10) : (p.createdAt||'').slice(0,10);
        
        // Process cumulative ratings for spark line
        let spark: Array<{ x: number; y: number }> | null = null, sparkLine: string | null = null, sparkPoints: string | null = null;
        if (cumu && cumu.length > 1) {
          // Take last 30 data points
          const recent = cumu.slice(-30);
          spark = recent.map((d: any) => ({ 
            x: new Date(d.date).getTime(), 
            y: Number(d.cumulativeRating) 
          }));
          
          if (spark && spark.length >= 2) {
            // Generate spark points for line and area
            const xs = spark.map(pt => pt.x);
            const ys = spark.map(pt => pt.y);
            const minX = Math.min(...xs);
            const maxX = Math.max(...xs);
            const minY = Math.min(...ys);
            const maxY = Math.max(...ys);
            const rangeY = maxY - minY || 1;
            const rangeX = maxX - minX || 1;
            
            sparkLine = spark.map(pt => {
              const nx = 10 + 280 * ((pt.x - minX) / rangeX);
              const ny = 40 - 35 * ((pt.y - minY) / rangeY);
              return `${nx.toFixed(1)},${ny.toFixed(1)}`;
            }).join(' ');
            
            // Create area points (line + bottom corners)
            sparkPoints = sparkLine + ` 290,45 10,45`;
          }
        }
        
        // Prefer backend-provided commentCount if available, fallback to revisionCount
        const commentCount = (p.commentCount ?? p.revisionCount ?? 0);
        
        return {
          ...p,
          authors,
          authorObjs,
          createdDate,
          spark,
          sparkLine,
          sparkPoints,
          controversy: stats?.controversy || 0,
          commentCount
        };
      } catch (err) {
        console.error(`Error loading data for page ${p.wikidotId}:`, err);
        return p;
      }
    }));
    
    return enhancedPages;
  })
]);

// 页面数据 - 确保响应式
const pages = ref<any[]>(pagesData.value || []);
const loadingPages = ref(false);
const randomVersion = ref(0); // 用于触发过渡

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
  () => bff<OverviewSeriesItem[]>('/stats/site/overview/series', { params: { startDate: new Date(Date.now() - 30*24*60*60*1000).toISOString().slice(0,10) } }),
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

// 路由调试 - 仅在开发环境
if (typeof window !== 'undefined') {
  console.log('主页加载, 初始页面数量:', pages.value.length);
}

// removed series occupancy section

// 更新时间（GMT+8，悬浮显示完整时间，正文为相对时间）
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

// 刷新随机页面
const refreshRandomPages = async () => {
  // 不要清空现有数据，只设置加载状态
  loadingPages.value = true;
  
  try {
    // 获取新的随机页面
    const basePages = await bff<BasicPage[]>('/pages/random', { params: { limit: 6 } });
    const excludedSet = new Set<string>(['作者','段落','补充材料']);
    const filteredBasePages = (basePages || []).filter((p: any) => Array.isArray(p.tags) && p.tags.length > 0 && !(p.tags as string[]).some(t => excludedSet.has(t)));

    if (!filteredBasePages || filteredBasePages.length === 0) {
      loadingPages.value = false;
      return;
    }
    
    // 增强每个页面的数据
    const enhancedPages = await Promise.all((filteredBasePages || []).map(async (p: any) => {
      try {
        const [attr, cumu, firstRevData, stats] = await Promise.all([
          bff(`/pages/${p.wikidotId}/attributions`),
          bff(`/pages/${p.wikidotId}/ratings/cumulative`),
          bff(`/pages/${p.wikidotId}/revisions`, { params: { limit: 1, offset: 0, order: 'ASC', type: 'PAGE_CREATED' } }),
          bff(`/stats/pages/${p.wikidotId}`).catch(() => null)
        ]);
        
        const firstRev = firstRevData && firstRevData[0];
        
        // 设置作者 - 为空时使用占位用户（通过 id=0 使用头像后端默认图）
        const authorList = Array.isArray(attr) && attr.length > 0 ? attr : [{ displayName: '(account deleted)', userWikidotId: 0 }];
        const authors = authorList.map((a: any) => a.displayName).join('、');
        const authorObjs = authorList.map((a: any) => {
          const idNum = Number(a.userWikidotId)
          const url = (Number.isFinite(idNum) && idNum > 0) ? `/user/${idNum}` : undefined
          return { name: a.displayName, url }
        });
        
        // 设置创建日期
        const baseTs = firstRev ? new Date(firstRev.timestamp).getTime() : undefined;
        const createdDate = baseTs ? new Date(baseTs).toISOString().slice(0,10) : (p.createdAt||'').slice(0,10);
        
        // 处理评分趋势线
        let spark: Array<{ x: number; y: number }> | null = null, sparkLine: string | null = null, sparkPoints: string | null = null;
        if (cumu && cumu.length > 1) {
          const recent = cumu.slice(-30);
          spark = recent.map((d: any) => ({ 
            x: new Date(d.date).getTime(), 
            y: Number(d.cumulativeRating) 
          }));
          
          if (spark && spark.length >= 2) {
            const xs = spark.map(pt => pt.x);
            const ys = spark.map(pt => pt.y);
            const minX = Math.min(...xs);
            const maxX = Math.max(...xs);
            const minY = Math.min(...ys);
            const maxY = Math.max(...ys);
            const rangeY = maxY - minY || 1;
            const rangeX = maxX - minX || 1;
            
            sparkLine = spark.map(pt => {
              const nx = 10 + 280 * ((pt.x - minX) / rangeX);
              const ny = 40 - 35 * ((pt.y - minY) / rangeY);
              return `${nx.toFixed(1)},${ny.toFixed(1)}`;
            }).join(' ');
            
            sparkPoints = sparkLine + ` 290,45 10,45`;
          }
        }
        
        const commentCount = (p.commentCount ?? p.revisionCount ?? 0);
        
        return {
          ...p,
          authors,
          authorObjs,
          createdDate,
          spark,
          sparkLine,
          sparkPoints,
          controversy: stats?.controversy || 0,
          commentCount
        };
      } catch (err) {
        console.error(`Error loading data for page ${p.wikidotId}:`, err);
        return p;
      }
    }));
    
    // 创建新引用确保视图更新
    pages.value = [...enhancedPages];
    randomVersion.value++;
  } catch (error) {
    console.error('刷新随机页面失败:', error);
    // 失败时不更改现有数据
  } finally {
    loadingPages.value = false;
  }
};
</script>
