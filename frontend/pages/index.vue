<template>
  <div class="space-y-8">
    <section>
      <div class="flex items-center justify-between border-b-2 border-emerald-100 dark:border-emerald-900/30 pb-3 mb-4">
        <div class="flex items-center gap-3">
          <div class="h-8 w-1 bg-emerald-600 rounded" />
          <h2 class="text-lg font-bold text-neutral-800 dark:text-neutral-100">站点总览</h2>
        </div>
        <span class="text-sm text-neutral-500 dark:text-neutral-400" :title="overviewUpdatedAtFull">上次更新时间：{{ overviewUpdatedAtRelative }}</span>
      </div>
      <div class="mt-3 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <!-- Users Block -->
        <div class="relative rounded-lg p-5 overflow-hidden bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 hover:shadow-md transition-all duration-200">
          <div class="text-xs font-medium text-neutral-600 dark:text-neutral-400">用户</div>
          <div class="mt-2 flex items-center justify-between gap-3">
            <div class="text-3xl font-bold text-neutral-900 dark:text-neutral-100">{{ Number(overview?.users?.total || 0).toLocaleString() }}</div>
            <svg v-if="overviewSparks.usersTotal" width="80" height="24" viewBox="0 0 100 24" preserveAspectRatio="none">
              <polyline :points="overviewSparks.usersTotal" fill="none" stroke="#10b981" stroke-width="2" />
            </svg>
          </div>
          <div class="mt-2 text-xs text-neutral-600 dark:text-neutral-400 space-y-1">
            <div class="flex items-center justify-between gap-3">
              <span>{{ Number(overview?.users?.active || 0).toLocaleString() }} 活跃</span>
              <svg v-if="overviewSparks.usersActive" width="80" height="20" viewBox="0 0 100 24" preserveAspectRatio="none">
                <polyline :points="overviewSparks.usersActive" fill="none" stroke="#10b981" stroke-width="1.5" />
              </svg>
            </div>
            <div class="flex items-center justify-between gap-3">
              <span>{{ Number(overview?.users?.contributors || 0).toLocaleString() }} 贡献者</span>
              <svg v-if="overviewSparks.usersContributors" width="80" height="20" viewBox="0 0 100 24" preserveAspectRatio="none">
                <polyline :points="overviewSparks.usersContributors" fill="none" stroke="#10b981" stroke-width="1.5" />
              </svg>
            </div>
            <div class="flex items-center justify-between gap-3">
              <span>{{ Number(overview?.users?.authors || 0).toLocaleString() }} 作者</span>
              <svg v-if="overviewSparks.usersAuthors" width="80" height="20" viewBox="0 0 100 24" preserveAspectRatio="none">
                <polyline :points="overviewSparks.usersAuthors" fill="none" stroke="#10b981" stroke-width="1.5" />
              </svg>
            </div>
          </div>
        </div>

        <!-- Pages Block -->
        <div class="relative rounded-lg p-5 overflow-hidden bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 hover:shadow-md transition-all duration-200">
          <div class="text-xs font-medium text-neutral-600 dark:text-neutral-400">页面</div>
          <div class="mt-2 flex items-center justify-between gap-3">
            <div class="text-3xl font-bold text-neutral-900 dark:text-neutral-100">{{ Number(overview?.pages?.total || 0).toLocaleString() }}</div>
            <svg v-if="overviewSparks.pagesTotal" width="80" height="24" viewBox="0 0 100 24" preserveAspectRatio="none">
              <polyline :points="overviewSparks.pagesTotal" fill="none" stroke="#10b981" stroke-width="2" />
            </svg>
          </div>
          <div class="mt-2 text-xs text-neutral-600 dark:text-neutral-400 space-y-1">
            <div class="flex items-center justify-between gap-3">
              <span>{{ Number(overview?.pages?.originals || 0).toLocaleString() }} 原创</span>
              <svg v-if="overviewSparks.pagesOriginals" width="80" height="20" viewBox="0 0 100 24" preserveAspectRatio="none">
                <polyline :points="overviewSparks.pagesOriginals" fill="none" stroke="#10b981" stroke-width="1.5" />
              </svg>
            </div>
            <div class="flex items-center justify-between gap-3">
              <span>{{ Number(overview?.pages?.translations || 0).toLocaleString() }} 翻译</span>
              <svg v-if="overviewSparks.pagesTranslations" width="80" height="20" viewBox="0 0 100 24" preserveAspectRatio="none">
                <polyline :points="overviewSparks.pagesTranslations" fill="none" stroke="#10b981" stroke-width="1.5" />
              </svg>
            </div>
          </div>
        </div>

        <!-- Votes Block -->
        <div class="relative rounded-lg p-5 overflow-hidden bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 hover:shadow-md transition-all duration-200">
          <div class="text-xs font-medium text-neutral-600 dark:text-neutral-400">投票</div>
          <div class="mt-2 flex items-center justify-between gap-3">
            <div class="text-3xl font-bold text-neutral-900 dark:text-neutral-100">{{ Number(overview?.votes?.total || 0).toLocaleString() }}</div>
            <svg v-if="overviewSparks.votesTotal" width="80" height="24" viewBox="0 0 100 24" preserveAspectRatio="none">
              <polyline :points="overviewSparks.votesTotal" fill="none" stroke="#10b981" stroke-width="2" />
            </svg>
          </div>
          <div class="mt-2 text-xs text-neutral-600 dark:text-neutral-400 space-y-1">
            <div class="flex items-center justify-between gap-3">
              <span>{{ Number(overview?.votes?.upvotes || 0).toLocaleString() }} 支持</span>
              <svg v-if="overviewSparks.votesUp" width="80" height="20" viewBox="0 0 100 24" preserveAspectRatio="none">
                <polyline :points="overviewSparks.votesUp" fill="none" stroke="#10b981" stroke-width="1.5" />
              </svg>
            </div>
            <div class="flex items-center justify-between gap-3">
              <span>{{ Number(overview?.votes?.downvotes || 0).toLocaleString() }} 反对</span>
              <svg v-if="overviewSparks.votesDown" width="80" height="20" viewBox="0 0 100 24" preserveAspectRatio="none">
                <polyline :points="overviewSparks.votesDown" fill="none" stroke="#10b981" stroke-width="1.5" />
              </svg>
            </div>
          </div>
        </div>

        <!-- Revisions Block -->
        <div class="relative rounded-lg p-5 overflow-hidden bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 hover:shadow-md transition-all duration-200">
          <div class="text-xs font-medium text-neutral-600 dark:text-neutral-400">修订</div>
          <div class="mt-2 flex items-center justify-between gap-3">
            <div class="text-3xl font-bold text-neutral-900 dark:text-neutral-100">{{ Number(overview?.revisions?.total || 0).toLocaleString() }}</div>
            <svg v-if="overviewSparks.revisionsTotal" width="80" height="24" viewBox="0 0 100 24" preserveAspectRatio="none">
              <polyline :points="overviewSparks.revisionsTotal" fill="none" stroke="#10b981" stroke-width="2" />
            </svg>
          </div>
        </div>
      </div>
    </section>

    <section>
      <div class="flex items-center justify-between border-b-2 border-emerald-100 dark:border-emerald-900/30 pb-3 mb-4">
        <div class="flex items-center gap-3">
          <div class="h-8 w-1 bg-emerald-600 rounded" />
          <h2 class="text-lg font-bold text-neutral-800 dark:text-neutral-100">随机页面</h2>
        </div>
        <button 
          @click="refreshRandomPages" 
          :disabled="loadingPages"
          class="flex items-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-700 disabled:bg-emerald-400 text-white rounded-lg transition-colors text-sm font-medium"
        >
          <svg 
            class="w-4 h-4" 
            :class="{ 'animate-spin': loadingPages }"
            fill="none" 
            stroke="currentColor" 
            viewBox="0 0 24 24"
          >
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
          {{ loadingPages ? '刷新中...' : '刷新' }}
        </button>
      </div>
      <div v-if="loadingPages" class="mt-3 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        <div v-for="i in 6" :key="i" class="animate-pulse">
          <div class="border border-neutral-200 dark:border-neutral-800 rounded-lg p-4 bg-white dark:bg-neutral-900">
            <div class="h-6 bg-neutral-200 dark:bg-neutral-700 rounded mb-3"></div>
            <div class="h-4 bg-neutral-200 dark:bg-neutral-700 rounded w-3/4 mb-2"></div>
            <div class="h-16 bg-neutral-200 dark:bg-neutral-700 rounded"></div>
          </div>
        </div>
      </div>
      <div v-else-if="pages.length > 0" class="mt-3 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        <PageCard v-for="p in pages" :key="p.wikidotId" :p="p" :authors="p.authorObjs" :comments="Number(p.commentCount ?? 0)" size="lg" />
      </div>
      <div v-else class="mt-3 p-8 text-center text-neutral-500 dark:text-neutral-400">
        <svg class="w-12 h-12 mx-auto mb-3 text-neutral-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
        </svg>
        <p class="text-sm">暂无页面数据</p>
        <button 
          @click="refreshRandomPages" 
          class="mt-3 px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-sm"
        >
          加载随机页面
        </button>
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
type BasicPage = { wikidotId: number; title?: string; rating?: number; voteCount?: number; category?: string; tags?: string[]; createdAt?: string; revisionCount?: number; attributionCount?: number; url?: string; textContent?: string };
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


