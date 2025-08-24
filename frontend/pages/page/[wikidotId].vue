<template>
  <div>
    <div v-if="pagePending" class="p-8 text-center">
      <div class="inline-flex items-center gap-2">
        <svg class="w-5 h-5 animate-spin text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
        </svg>
        <span class="text-neutral-600 dark:text-neutral-400">加载中...</span>
      </div>
    </div>
    <div v-else-if="pageError" class="p-8 text-center text-red-600 dark:text-red-400">
      加载失败: {{ pageError.message }}
    </div>
    <div v-else class="space-y-6">
    <div class="flex items-center justify-between border-b-2 border-emerald-100 dark:border-emerald-900/30 pb-3 mb-4">
      <div class="flex items-center gap-3">
        <div class="h-8 w-1 bg-emerald-600 rounded" />
        <h2 class="text-lg font-bold text-neutral-800 dark:text-neutral-100">页面详情</h2>
      </div>
      <NuxtLink to="/" class="text-sm text-emerald-600 dark:text-emerald-400 hover:text-emerald-700 dark:hover:text-emerald-300 font-medium">← 返回主页</NuxtLink>
    </div>

    <!-- Main Page Info -->
    <div class="border border-neutral-200 dark:border-neutral-800 rounded-lg p-6 bg-white dark:bg-neutral-900 shadow-sm mb-6">
      <div class="text-2xl font-bold text-neutral-900 dark:text-neutral-100 mb-3">{{ page?.title || 'Untitled' }}</div>
      
      <!-- Authors Section - Moved to prominent position -->
      <div v-if="groupedAttributions && groupedAttributions.length > 0" class="mb-4">
        <div class="flex flex-wrap gap-3">
          <div v-for="attr in groupedAttributions" :key="attr.type" class="flex items-center gap-2">
            <span class="text-xs text-neutral-600 dark:text-neutral-400">{{ formatAttributionType(attr.type) }}:</span>
            <div class="flex flex-wrap gap-2">
              <template v-for="(person, idx) in attr.users" :key="`person-${idx}`">
                <NuxtLink v-if="person && person.userWikidotId"
                          :to="`/user/${person.userWikidotId}`" 
                          class="text-sm font-medium text-emerald-600 dark:text-emerald-400 hover:text-emerald-700 dark:hover:text-emerald-300 hover:underline">
                  {{ person.displayName || 'Unknown' }}
                </NuxtLink>
                <span v-else class="text-sm text-neutral-600 dark:text-neutral-400">
                  {{ person?.displayName || 'Anonymous' }}
                </span>
              </template>
            </div>
          </div>
        </div>
      </div>

      <!-- Tags and Links -->
      <div class="flex flex-wrap gap-2 mb-4">
        <span class="inline-flex items-center px-3 py-1 rounded-full text-xs font-medium bg-neutral-100 dark:bg-neutral-800 text-neutral-700 dark:text-neutral-300">
          ID: {{ page?.wikidotId }}
        </span>
        <a v-if="page?.url" :href="page.url" target="_blank" class="inline-flex items-center px-3 py-1 rounded-full text-xs font-medium bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-200 dark:hover:bg-emerald-900/50">
          🔗 源页面
        </a>
        <span v-for="t in (page?.tags||[]).slice(0, 8)" :key="t" class="inline-flex items-center px-3 py-1 rounded-full text-xs font-medium bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400">
          #{{ t }}
        </span>
      </div>

      <!-- Page Metadata -->
      <div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-2 text-xs text-neutral-600 dark:text-neutral-400">
        <div><span class="font-medium">类别:</span> {{ page?.category || 'N/A' }}</div>
        <div><span class="font-medium">创建:</span> {{ page?.createdAt ? formatDate(page.createdAt) : 'N/A' }}</div>
        <div><span class="font-medium">修订:</span> {{ page?.revisionCount || 0 }}</div>
        <div v-if="page?.isHidden"><span class="font-medium text-yellow-600">隐藏页面</span></div>
        <div v-if="page?.isUserPage"><span class="font-medium text-blue-600">用户页面</span></div>
      </div>
    </div>

    <!-- Stats Grid -->
    <div class="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
      <div class="border border-neutral-200 dark:border-neutral-800 rounded-lg p-4 bg-white dark:bg-neutral-900 shadow-sm text-center">
        <div class="text-3xl font-bold text-neutral-900 dark:text-neutral-100">{{ page?.rating ?? '0' }}</div>
        <div class="text-xs text-neutral-600 dark:text-neutral-400 mt-1">评分</div>
      </div>
      <div class="border border-neutral-200 dark:border-neutral-800 rounded-lg p-4 bg-white dark:bg-neutral-900 shadow-sm text-center">
        <div class="text-3xl font-bold text-neutral-900 dark:text-neutral-100">{{ page?.voteCount ?? '0' }}</div>
        <div class="text-xs text-neutral-600 dark:text-neutral-400 mt-1">投票数</div>
      </div>
      <div class="border border-neutral-200 dark:border-neutral-800 rounded-lg p-4 bg-white dark:bg-neutral-900 shadow-sm text-center">
        <div class="text-3xl font-bold text-neutral-900 dark:text-neutral-100">{{ stats?.wilson95 ? Number(stats.wilson95).toFixed(2) : '0.00' }}</div>
        <div class="text-xs text-neutral-600 dark:text-neutral-400 mt-1">Wilson95</div>
      </div>
      <div class="border border-neutral-200 dark:border-neutral-800 rounded-lg p-4 bg-white dark:bg-neutral-900 shadow-sm text-center">
        <div class="text-3xl font-bold text-neutral-900 dark:text-neutral-100">{{ stats?.controversy ? Number(stats.controversy).toFixed(3) : '0.000' }}</div>
        <div class="text-xs text-neutral-600 dark:text-neutral-400 mt-1">争议度</div>
      </div>
    </div>

    <!-- Vote Distribution -->
    <div v-if="voteDistribution" class="border border-neutral-200 dark:border-neutral-800 rounded-lg p-6 bg-white dark:bg-neutral-900 shadow-sm mb-6">
      <h3 class="text-sm font-semibold text-neutral-700 dark:text-neutral-300 mb-4">投票分布</h3>
      <div class="grid grid-cols-3 gap-4">
        <div class="bg-green-50 dark:bg-green-900/20 rounded-lg p-4 text-center">
          <div class="text-2xl font-bold text-green-700 dark:text-green-300">{{ voteDistribution.upvotes || 0 }}</div>
          <div class="text-xs text-green-600 dark:text-green-400 mt-1">支持</div>
        </div>
        <div class="bg-red-50 dark:bg-red-900/20 rounded-lg p-4 text-center">
          <div class="text-2xl font-bold text-red-700 dark:text-red-300">{{ voteDistribution.downvotes || 0 }}</div>
          <div class="text-xs text-red-600 dark:text-red-400 mt-1">反对</div>
        </div>
        <div class="bg-neutral-50 dark:bg-neutral-800 rounded-lg p-4 text-center">
          <div class="text-2xl font-bold text-neutral-700 dark:text-neutral-300">{{ voteDistribution.novotes || 0 }}</div>
          <div class="text-xs text-neutral-600 dark:text-neutral-400 mt-1">中立</div>
        </div>
      </div>
    </div>

    <!-- Rating Trend Section - Now as bar chart -->
    <div v-if="ratingHistory && ratingHistory.length > 0" class="border border-neutral-200 dark:border-neutral-800 rounded-lg p-6 bg-white dark:bg-neutral-900 shadow-sm mb-6">
      <h3 class="text-sm font-semibold text-neutral-700 dark:text-neutral-300 mb-4">评分趋势</h3>
      <ClientOnly>
        <RatingHistoryChart 
          :data="ratingHistory" 
          :first-activity-date="firstRev && firstRev[0] ? firstRev[0].timestamp : '2022-06-15'"
          :allow-page-markers="false"
        />
        <template #fallback>
          <div class="h-64 flex items-center justify-center text-neutral-500 dark:text-neutral-400">
            加载图表中...
          </div>
        </template>
      </ClientOnly>
    </div>
    </div>

    <!-- Revisions History -->
    <div class="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
      <!-- Recent Revisions -->
      <div class="border border-neutral-200 dark:border-neutral-800 rounded-lg p-6 bg-white dark:bg-neutral-900 shadow-sm">
        <h3 class="text-sm font-semibold text-neutral-700 dark:text-neutral-300 mb-4">最近修订</h3>
        <div v-if="!revisions || revisions.length === 0" class="text-center py-4 text-neutral-500 dark:text-neutral-400">
          暂无修订记录
        </div>
        <div v-else class="space-y-2">
          <div v-for="rev in revisions.slice(0, 5)" :key="rev.wikidotId" class="p-2 bg-neutral-50 dark:bg-neutral-800 rounded">
            <div class="flex items-start justify-between">
              <div class="flex-1">
                <div class="text-sm font-medium text-neutral-900 dark:text-neutral-100">{{ formatRevisionType(rev.type) }}</div>
                <div v-if="rev.comment" class="text-xs text-neutral-600 dark:text-neutral-400 mt-1 truncate">{{ rev.comment }}</div>
                <div class="flex items-center gap-3 mt-1 text-xs text-neutral-500 dark:text-neutral-500">
                  <span>{{ formatRelativeTime(rev.timestamp) }}</span>
                  <NuxtLink v-if="rev.userId && rev.userDisplayName" :to="`/user/${rev.userId}`" class="hover:text-emerald-600 dark:hover:text-emerald-400">
                    {{ rev.userDisplayName }}
                  </NuxtLink>
                </div>
              </div>
            </div>
          </div>
          <div v-if="revisions.length > 5" class="text-center mt-2">
            <span class="text-xs text-neutral-500 dark:text-neutral-400">共 {{ revisions.length }} 次修订</span>
          </div>
        </div>
      </div>

      <!-- Related Records -->
      <div class="border border-neutral-200 dark:border-neutral-800 rounded-lg p-6 bg-white dark:bg-neutral-900 shadow-sm">
        <h3 class="text-sm font-semibold text-neutral-700 dark:text-neutral-300 mb-4">相关记录</h3>
        <div v-if="!relatedRecords || relatedRecords.length === 0" class="text-center py-4 text-neutral-500 dark:text-neutral-400">
          暂无相关记录
        </div>
        <div v-else class="space-y-2">
          <div v-for="record in relatedRecords.slice(0, 5)" :key="`${record.category}-${record.recordType}`" 
               class="p-2 bg-neutral-50 dark:bg-neutral-800 rounded">
            <div class="flex items-center justify-between">
              <div>
                <span class="text-xs px-2 py-0.5 rounded bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400 mr-2">
                  {{ formatRecordCategory(record.category) }}
                </span>
                <span class="text-xs font-medium text-neutral-900 dark:text-neutral-100">{{ formatRecordType(record.recordType) }}</span>
              </div>
              <div v-if="record.rating" class="text-sm font-bold text-neutral-900 dark:text-neutral-100">{{ record.rating }}</div>
            </div>
            <div v-if="record.achievedAt" class="text-xs text-neutral-500 dark:text-neutral-500 mt-1">
              {{ formatRelativeTime(record.achievedAt) }}
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, onMounted, onBeforeUnmount } from 'vue'
import { onBeforeRouteUpdate } from 'vue-router';

// Declarations for Nuxt auto-imported globals to satisfy type checker in this environment
declare const useAsyncData: any
declare const useNuxtApp: any
declare const useRoute: any
declare const definePageMeta: any
declare const process: any

const route = useRoute();
const {$bff} = useNuxtApp();

// 使用key强制重新渲染组件 - 使用fullPath确保完全刷新
definePageMeta({ 
  key: (route) => route.fullPath 
});

// 路由调试 - 仅在开发环境
if (process.dev) {
  onBeforeRouteUpdate((to, from) => {
    console.log('页面路由更新:', { to: to.fullPath, from: from.fullPath })
  });
}

// 使用路由参数
const wikidotId = computed(() => route.params.wikidotId as string);

// 使用 watch 确保在路由变化时重新获取数据
// 动态key + watch确保数据更新
const { data: page, pending: pagePending, error: pageError } = await useAsyncData(
  () => `page-${wikidotId.value}`, // 动态key
  () => $bff(`/pages/by-id`, { params: { wikidotId: wikidotId.value } }),
  { 
    watch: [() => route.params.wikidotId] // 监听路由参数变化
  }
);

const { data: stats } = await useAsyncData(
  () => `stats-${wikidotId.value}`,
  () => $bff(`/stats/pages/${wikidotId.value}`),
  { 
    watch: [() => route.params.wikidotId]
  }
);

const { data: daily } = await useAsyncData(
  () => `daily-${wikidotId.value}`,
  () => $bff(`/pages/${wikidotId.value}/ratings/cumulative`),
  { 
    watch: [() => route.params.wikidotId]
  }
);

// Fetch rating history for bar chart
const { data: ratingHistory } = await useAsyncData(
  () => `page-rating-history-${wikidotId.value}`,
  () => $bff(`/pages/${wikidotId.value}/rating-history`, { 
    params: { 
      granularity: 'week'  // 按周聚合，获取全部历史数据
    } 
  }),
  { watch: [() => route.params.wikidotId] }
);

const { data: revs } = await useAsyncData(
  () => `revs-${wikidotId.value}`,
  () => $bff(`/pages/${wikidotId.value}/revisions`, { params: { limit: 500 } }),
  { 
    watch: [() => route.params.wikidotId]
  }
);

const { data: firstRev } = await useAsyncData(
  () => `firstrev-${wikidotId.value}`,
  () => $bff(`/pages/${wikidotId.value}/revisions`, { params: { limit: 1, offset: 0, order: 'ASC', type: 'PAGE_CREATED' } }),
  { 
    watch: [() => route.params.wikidotId]
  }
);

// Fetch attributions
const { data: attributions } = await useAsyncData(
  () => `attributions-${wikidotId.value}`,
  () => $bff(`/pages/${wikidotId.value}/attributions`),
  { 
    watch: [() => route.params.wikidotId]
  }
);

// Fetch all revisions
const { data: revisions } = await useAsyncData(
  () => `all-revisions-${wikidotId.value}`,
  () => $bff(`/pages/${wikidotId.value}/revisions`, { params: { limit: 100 } }),
  { 
    watch: [() => route.params.wikidotId]
  }
);

// Fetch vote distribution
const { data: voteDistribution } = await useAsyncData(
  () => `vote-dist-${wikidotId.value}`,
  () => $bff(`/pages/${wikidotId.value}/vote-distribution`),
  { 
    watch: [() => route.params.wikidotId]
  }
);

// Fetch related records
const { data: relatedRecords } = await useAsyncData(
  () => `related-records-${wikidotId.value}`,
  () => $bff(`/pages/${wikidotId.value}/related-records`),
  { 
    watch: [() => route.params.wikidotId]
  }
);

// Removed legacy line and marker computations to avoid type errors (chart now uses RatingHistoryChart)

// Old SVG chart code - commented out as we use bar chart component
const points = computed(() => {
  const arr: any[] = [] as any[];
  if (!arr.length) return '';
  const xs = arr.map(p => p.x), ys = arr.map(p => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const norm = (v: number, a: number, b: number) => (b - a ? (v - a) / (b - a) : 0);
  return arr.map(p => {
    const nx = 20 + 760 * norm(p.x, minX, maxX);
    const ny = 170 - 140 * norm(p.y, minY, maxY);
    return `${nx},${ny}`;
  }).join(' ');
});

// hover & revision dots
const hover = ref<{ x: number; y: number; label: string; value: number } | null>(null);

function onMove(e: MouseEvent) {
  hover.value = null;
}

onMounted(() => {
  const el = document.querySelector('svg');
  el?.addEventListener('mousemove', onMove);
});

onBeforeUnmount(() => {
  const el = document.querySelector('svg');
  el?.removeEventListener('mousemove', onMove as any);
});

// Tab management
const activeContentTab = ref('attribution');
const showAllRevisions = ref(false);

// Removed tabs system - all info now displayed directly

const groupedAttributions = computed(() => {
  if (!attributions.value) return [];
  const grouped: Record<string, any[]> = {};
  attributions.value.forEach((attr: any) => {
    if (!grouped[attr.type]) grouped[attr.type] = [];
    grouped[attr.type].push(attr);
  });
  return Object.entries(grouped).map(([type, users]) => ({ type, users }));
});

const displayedRevisions = computed(() => {
  if (!revisions.value) return [];
  return showAllRevisions.value ? revisions.value : revisions.value.slice(0, 10);
});

// Helper functions
function formatDate(dateStr: string) {
  if (!dateStr) return 'N/A';
  const date = new Date(dateStr);
  return date.toLocaleDateString('zh-CN', { 
    year: 'numeric', 
    month: 'short', 
    day: 'numeric' 
  });
}

function formatRelativeTime(dateStr: string) {
  if (!dateStr) return '';
  const date = new Date(dateStr);
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  
  if (days === 0) return '今天';
  if (days === 1) return '昨天';
  if (days < 30) return `${days} 天前`;
  if (days < 365) return `${Math.floor(days / 30)} 个月前`;
  return `${Math.floor(days / 365)} 年前`;
}

function formatAttributionType(type: string) {
  const typeMap: Record<string, string> = {
    'AUTHOR': '作者',
    'REWRITE': '重写',
    'TRANSLATOR': '译者',
    'SUBMITTER': '提交者',
  };
  return typeMap[type] || type;
}

function formatRevisionType(type: string) {
  const typeMap: Record<string, string> = {
    'PAGE_CREATED': '创建页面',
    'PAGE_EDITED': '编辑内容',
    'PAGE_RENAMED': '重命名',
    'PAGE_DELETED': '删除',
    'PAGE_RESTORED': '恢复',
    'METADATA_CHANGED': '修改元数据',
    'TAGS_CHANGED': '修改标签',
  };
  return typeMap[type] || type;
}

function formatRecordCategory(category: string) {
  const categoryMap: Record<string, string> = {
    'rating': '评分',
    'content': '内容',
    'fact': '事实',
  };
  return categoryMap[category] || category;
}

function formatRecordType(type: string) {
  const typeMap: Record<string, string> = {
    'HIGHEST_RATED': '最高评分',
    'FASTEST_RISING': '上升最快',
    'MOST_CONTROVERSIAL': '最具争议',
    'LONGEST_SOURCE': '最长源码',
    'LONGEST_CONTENT': '最长内容',
    'MOST_COMPLEX': '最复杂',
  };
  return typeMap[type] || type;
}
</script>


