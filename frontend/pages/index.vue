<template>
  <div class="space-y-8">
    <section>
      <div class="flex items-center justify-between border-b-2 border-emerald-100 dark:border-emerald-900/30 pb-3 mb-4">
        <div class="flex items-center gap-3">
          <div class="h-8 w-1 bg-emerald-600 rounded" />
          <h2 class="text-lg font-bold text-neutral-800 dark:text-neutral-100">站点总览</h2>
        </div>
        <span class="text-sm text-neutral-500 dark:text-neutral-400">上次更新时间：{{ (site?.date || '') }}</span>
      </div>
      <div class="mt-3 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <KpiTile label="总用户数" :value="site?.totalUsers || 0" />
        <KpiTile label="活跃用户" :value="site?.activeUsers || 0" />
        <KpiTile label="总页面数" :value="site?.totalPages || 0" />
        <KpiTile label="总投票数" :value="site?.totalVotes || 0" />
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
        <NuxtLink
          v-for="p in pages" 
          :key="p.wikidotId" 
          :to="`/page/${p.wikidotId}`"
          class="group relative border border-neutral-200 dark:border-neutral-800 rounded-lg p-4 bg-white dark:bg-neutral-900 flex flex-col gap-3 hover:shadow-md transition-all duration-200 cursor-pointer">
          <div class="flex items-center justify-between">
            <div class="font-semibold text-neutral-900 dark:text-neutral-100 truncate" :title="p.title">{{ p.title || 'Untitled' }}</div>
            <div class="text-xs text-neutral-500 dark:text-neutral-400 whitespace-nowrap">{{ p.createdDate }}</div>
          </div>
          <div class="text-xs text-neutral-600 dark:text-neutral-400 truncate">
            <span v-if="p.authors">{{ (p.tags||[]).includes('原创') ? '作者' : '译者' }}：{{ p.authors }}</span>
          </div>
          <div class="text-[11px] text-neutral-400 flex flex-wrap gap-1">
            <span v-for="t in (p.tags||[]).slice(0,5)" :key="t" class="inline-block px-2 py-0.5 bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-400 rounded-full text-[10px]">#{{ t }}</span>
          </div>
          <div v-if="p.excerpt" class="text-xs text-neutral-600 dark:text-neutral-400 line-clamp-3 italic border-l-2 border-emerald-500/30 pl-3 my-2">
            "{{ p.excerpt }}"
          </div>
          <div class="grid grid-cols-3 gap-2 mt-2">
            <div class="border border-neutral-200 dark:border-neutral-700 rounded p-2 text-center">
              <div class="text-[10px] text-neutral-500 dark:text-neutral-400">Rating</div>
              <div class="text-sm font-semibold text-neutral-800 dark:text-neutral-200">{{ p.rating || 0 }}</div>
            </div>
            <div class="border border-neutral-200 dark:border-neutral-700 rounded p-2 text-center">
              <div class="text-[10px] text-neutral-500 dark:text-neutral-400">修订</div>
              <div class="text-sm font-semibold text-neutral-800 dark:text-neutral-200">{{ p.revisionCount || 0 }}</div>
            </div>
            <div class="border border-neutral-200 dark:border-neutral-700 rounded p-2 text-center">
              <div class="text-[10px] text-neutral-500 dark:text-neutral-400">争议</div>
              <div class="text-sm font-semibold text-neutral-800 dark:text-neutral-200">{{ p.controversy ? Number(p.controversy).toFixed(3) : '0.000' }}</div>
            </div>
          </div>
          <div class="mt-auto pt-2 h-12 border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-800 rounded flex items-center justify-center">
            <svg v-if="p.spark && p.spark.length >= 2" :width="'100%'" height="48" viewBox="0 0 300 48" preserveAspectRatio="none">
              <defs>
                <linearGradient :id="`gradient-${p.wikidotId}`" x1="0%" y1="0%" x2="0%" y2="100%">
                  <stop offset="0%" style="stop-color:#10b981;stop-opacity:0.3" />
                  <stop offset="100%" style="stop-color:#10b981;stop-opacity:0" />
                </linearGradient>
              </defs>
              <polyline :points="p.sparkPoints" :fill="`url(#gradient-${p.wikidotId})`" stroke="none" />
              <polyline :points="p.sparkLine" fill="none" stroke="#10b981" stroke-width="2" />
            </svg>
            <div v-else class="text-xs text-neutral-400 dark:text-neutral-500">暂无趋势</div>
          </div>
        </NuxtLink>
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

    <section class="grid grid-cols-1 lg:grid-cols-3 gap-6">
      <div class="lg:col-span-1">
        <div class="flex items-center justify-between border-b-2 border-emerald-100 dark:border-emerald-900/30 pb-3 mb-4">
          <div class="flex items-center gap-3">
            <div class="h-8 w-1 bg-emerald-600 rounded" />
            <h2 class="text-lg font-bold text-neutral-800 dark:text-neutral-100">系列占位率</h2>
          </div>
        </div>
        <div class="mt-3 space-y-3">
          <div v-for="s in filteredSeries" :key="s.seriesNumber" class="border border-neutral-200 dark:border-neutral-800 rounded-lg p-3 bg-white dark:bg-neutral-950 hover:shadow-md dark:hover:shadow-emerald-900/10 transition-shadow">
            <div class="flex items-center justify-between text-sm">
              <div class="font-medium text-neutral-700 dark:text-neutral-300">Series {{ s.seriesNumber }}</div>
              <div class="text-neutral-600 dark:text-neutral-400">{{ s.usedSlots }}/{{ s.totalSlots }} · <span :class="pct(s)>=90?'text-red-500 font-bold':(pct(s)>=60?'text-amber-500 font-medium':'text-emerald-600')">{{ pct(s) }}%</span></div>
            </div>
            <div class="mt-2 h-5 relative bg-neutral-100 dark:bg-neutral-900 rounded-full overflow-hidden">
              <div class="h-full bg-emerald-600 rounded-full transition-all duration-500" :style="{ width: pct(s)+'%' }" />
            </div>
          </div>
        </div>
      </div>
      <!-- 删除关于区块后占位：可在此添加其他模块 -->
    </section>
  </div>
</template>

<script setup lang="ts">
const config = useRuntimeConfig();
const bffBase = (config.public as any).bffBase as string;
const {$bff} = useNuxtApp();

// Fetch base data and enhancements in parallel on server side
const [{ data: site }, { data: series }, { data: pagesData }] = await Promise.all([
  useAsyncData('site', () => $bff('/stats/site/latest')),
  useAsyncData('series', () => $bff('/stats/series')),
  useAsyncData('pages', async () => {
    // First get the pages
    const basePages = await $bff('/pages/random', { params: { limit: 6 } });
    
    // Then enhance each page with additional data
    const enhancedPages = await Promise.all((basePages || []).map(async (p: any) => {
      try {
        const [attr, cumu, firstRevData, stats] = await Promise.all([
          $bff(`/pages/${p.wikidotId}/attributions`),
          $bff(`/pages/${p.wikidotId}/ratings/cumulative`),
          $bff(`/pages/${p.wikidotId}/revisions`, { params: { limit: 1, offset: 0, order: 'ASC', type: 'PAGE_CREATED' } }),
          $bff(`/stats/pages/${p.wikidotId}`).catch(() => null)
        ]);
        
        const firstRev = firstRevData && firstRevData[0];
        
        // Set authors - show all attributions regardless of type
        const authorList = attr || [];
        const authors = authorList.length > 0 ? authorList.map((a: any) => a.displayName).join('、') : '';
        
        // Set creation date from first revision
        const baseTs = firstRev ? new Date(firstRev.timestamp).getTime() : undefined;
        const createdDate = baseTs ? new Date(baseTs).toISOString().slice(0,10) : (p.createdAt||'').slice(0,10);
        
        // Process cumulative ratings for spark line
        let spark = null, sparkLine = null, sparkPoints = null;
        if (cumu && cumu.length > 1) {
          // Take last 30 data points
          const recent = cumu.slice(-30);
          spark = recent.map((d: any) => ({ 
            x: new Date(d.date).getTime(), 
            y: Number(d.cumulativeRating) 
          }));
          
          if (spark.length >= 2) {
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
        
        // Use revisionCount as a proxy for comment/discussion activity
        const commentCount = p.revisionCount || 0;
        
        return {
          ...p,
          authors,
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

// 路由调试 - 仅在开发环境
if (process.client && process.dev) {
  console.log('主页加载, 初始页面数量:', pages.value.length);
}

const pct = (s: any) => Math.round((s.usedSlots / Math.max(1, s.totalSlots)) * 100);

const filteredSeries = computed(() => (series.value || []).filter((s: any) => s.usedSlots > 0));

// 刷新随机页面
const refreshRandomPages = async () => {
  // 不要清空现有数据，只设置加载状态
  loadingPages.value = true;
  
  try {
    // 获取新的随机页面
    const basePages = await $bff('/pages/random', { params: { limit: 6 } });
    
    if (!basePages || basePages.length === 0) {
      loadingPages.value = false;
      return;
    }
    
    // 增强每个页面的数据
    const enhancedPages = await Promise.all((basePages || []).map(async (p: any) => {
      try {
        const [attr, cumu, firstRevData, stats] = await Promise.all([
          $bff(`/pages/${p.wikidotId}/attributions`),
          $bff(`/pages/${p.wikidotId}/ratings/cumulative`),
          $bff(`/pages/${p.wikidotId}/revisions`, { params: { limit: 1, offset: 0, order: 'ASC', type: 'PAGE_CREATED' } }),
          $bff(`/stats/pages/${p.wikidotId}`).catch(() => null)
        ]);
        
        const firstRev = firstRevData && firstRevData[0];
        
        // 设置作者
        const authorList = attr || [];
        const authors = authorList.length > 0 ? authorList.map((a: any) => a.displayName).join('、') : '';
        
        // 设置创建日期
        const baseTs = firstRev ? new Date(firstRev.timestamp).getTime() : undefined;
        const createdDate = baseTs ? new Date(baseTs).toISOString().slice(0,10) : (p.createdAt||'').slice(0,10);
        
        // 处理评分趋势线
        let spark = null, sparkLine = null, sparkPoints = null;
        if (cumu && cumu.length > 1) {
          const recent = cumu.slice(-30);
          spark = recent.map((d: any) => ({ 
            x: new Date(d.date).getTime(), 
            y: Number(d.cumulativeRating) 
          }));
          
          if (spark.length >= 2) {
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
        
        const commentCount = p.revisionCount || 0;
        
        return {
          ...p,
          authors,
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


