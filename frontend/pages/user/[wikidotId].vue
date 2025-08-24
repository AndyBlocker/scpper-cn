<template>
  <div>
    <div v-if="userPending || statsPending" class="p-8 text-center">
      <div class="inline-flex items-center gap-2">
        <svg class="w-5 h-5 animate-spin text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
        </svg>
        <span class="text-neutral-600 dark:text-neutral-400">加载中...</span>
      </div>
    </div>
    <div v-else-if="userError" class="p-8 text-center text-red-600 dark:text-red-400">
      加载失败: {{ userError.message }}
    </div>
    <div v-else class="space-y-6">
      <!-- Header -->
      <div class="flex items-center justify-between border-b-2 border-emerald-100 dark:border-emerald-900/30 pb-3 mb-4">
        <div class="flex items-center gap-3">
          <div class="h-8 w-1 bg-emerald-600 rounded" />
          <h2 class="text-lg font-bold text-neutral-800 dark:text-neutral-100">用户详情</h2>
        </div>
        <NuxtLink to="/" class="text-sm text-emerald-600 dark:text-emerald-400 hover:text-emerald-700 dark:hover:text-emerald-300 font-medium">← 返回主页</NuxtLink>
      </div>

      <!-- User Info and Overall Stats -->
      <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <!-- User Basic Info -->
        <div class="lg:col-span-2 border border-neutral-200 dark:border-neutral-800 rounded-lg p-6 bg-white dark:bg-neutral-900 shadow-sm">
          <div class="flex items-start justify-between">
            <div>
              <h1 class="text-2xl font-bold text-neutral-900 dark:text-neutral-100 mb-2">{{ user?.displayName || 'Unknown User' }}</h1>
              <div class="flex flex-wrap gap-2 mb-4">
                <span class="inline-flex items-center px-3 py-1 rounded-full text-xs font-medium bg-neutral-100 dark:bg-neutral-800 text-neutral-700 dark:text-neutral-300">
                  Wikidot: {{ wikidotId }}
                </span>
                <span v-if="user?.username" class="inline-flex items-center px-3 py-1 rounded-full text-xs font-medium bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400">
                  @{{ user.username }}
                </span>
                <span v-if="user?.isGuest" class="inline-flex items-center px-3 py-1 rounded-full text-xs font-medium bg-yellow-100 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-400">
                  访客
                </span>
              </div>
            </div>
            <div v-if="stats?.rank" class="text-right">
              <div class="text-3xl font-bold text-emerald-600 dark:text-emerald-400">#{{ stats.rank }}</div>
              <div class="text-xs text-neutral-600 dark:text-neutral-400">综合排名</div>
            </div>
          </div>

          <!-- Activity Timeline -->
          <div class="grid grid-cols-1 md:grid-cols-2 gap-4 mt-6">
            <div v-if="user?.firstActivityAt" class="bg-neutral-50 dark:bg-neutral-800 rounded-lg p-3">
              <div class="text-xs text-neutral-600 dark:text-neutral-400 mb-1">首次活动</div>
              <div class="text-sm font-medium text-neutral-900 dark:text-neutral-100">{{ formatDate(user.firstActivityAt) }}</div>
              <div v-if="user?.firstActivityType" class="text-xs text-neutral-500 dark:text-neutral-500 mt-1">
                {{ formatActivityType(user.firstActivityType) }}
              </div>
            </div>
            <div v-if="user?.lastActivityAt" class="bg-neutral-50 dark:bg-neutral-800 rounded-lg p-3">
              <div class="text-xs text-neutral-600 dark:text-neutral-400 mb-1">最近活动</div>
              <div class="text-sm font-medium text-neutral-900 dark:text-neutral-100">{{ formatDate(user.lastActivityAt) }}</div>
            </div>
          </div>

          <!-- Overall Stats Grid -->
          <div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3 mt-6">
            <div class="bg-neutral-50 dark:bg-neutral-800 rounded-lg p-3 text-center">
              <div class="text-xs text-neutral-600 dark:text-neutral-400 mb-1">总评分</div>
              <div class="text-2xl font-bold text-neutral-900 dark:text-neutral-100">{{ stats?.totalRating ?? '0' }}</div>
            </div>
            <div class="bg-neutral-50 dark:bg-neutral-800 rounded-lg p-3 text-center">
              <div class="text-xs text-neutral-600 dark:text-neutral-400 mb-1">平均评分</div>
              <div class="text-2xl font-bold text-neutral-900 dark:text-neutral-100">{{ stats?.meanRating ? Number(stats.meanRating).toFixed(1) : '0.0' }}</div>
            </div>
            <div class="bg-neutral-50 dark:bg-neutral-800 rounded-lg p-3 text-center">
              <div class="text-xs text-neutral-600 dark:text-neutral-400 mb-1">作品数</div>
              <div class="text-2xl font-bold text-neutral-900 dark:text-neutral-100">{{ stats?.pageCount ?? '0' }}</div>
            </div>
            <div class="bg-neutral-50 dark:bg-neutral-800 rounded-lg p-3 text-center">
              <div class="text-xs text-neutral-600 dark:text-neutral-400 mb-1">投出支持票</div>
              <div class="text-2xl font-bold text-green-600 dark:text-green-400">{{ stats?.votesUp ?? '0' }}</div>
            </div>
            <div class="bg-neutral-50 dark:bg-neutral-800 rounded-lg p-3 text-center">
              <div class="text-xs text-neutral-600 dark:text-neutral-400 mb-1">投出反对票</div>
              <div class="text-2xl font-bold text-red-600 dark:text-red-400">{{ stats?.votesDown ?? '0' }}</div>
            </div>
          </div>
        </div>

        <!-- Category Rankings -->
        <div class="border border-neutral-200 dark:border-neutral-800 rounded-lg p-6 bg-white dark:bg-neutral-900 shadow-sm">
          <h3 class="text-sm font-semibold text-neutral-700 dark:text-neutral-300 mb-4">分类排名</h3>
          <div class="space-y-3" v-if="stats && !statsPending">
            <CategoryRank label="SCP" :rank="stats.scpRank ?? '-'" :rating="stats.scpRating ?? 0" :count="stats.pageCountScp ?? 0" />
            <CategoryRank label="故事" :rank="stats.storyRank ?? '-'" :rating="stats.storyRating ?? 0" :count="stats.pageCountTale ?? 0" />
            <CategoryRank label="GoI格式" :rank="stats.goiRank ?? '-'" :rating="stats.goiRating ?? 0" :count="stats.pageCountGoiFormat ?? 0" />
            <CategoryRank label="翻译" :rank="stats.translationRank ?? '-'" :rating="stats.translationRating ?? 0" :count="stats.translationPageCount ?? 0" />
            <CategoryRank label="流浪者" :rank="stats.wanderersRank ?? '-'" :rating="stats.wanderersRating ?? 0" :count="stats.wanderersPageCount ?? 0" />
            <CategoryRank label="艺术作品" :rank="stats.artRank ?? '-'" :rating="stats.artRating ?? 0" :count="stats.pageCountArtwork ?? 0" />
          </div>
          <div v-if="stats?.favTag" class="mt-4 pt-4 border-t border-neutral-200 dark:border-neutral-700">
            <div class="text-xs text-neutral-600 dark:text-neutral-400 mb-1">最爱标签</div>
            <span class="inline-flex items-center px-3 py-1 rounded-full text-xs font-medium bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400">
              #{{ stats.favTag }}
            </span>
          </div>
        </div>
      </div>

      <!-- Rating History Chart -->
      <div v-if="ratingHistory && ratingHistory.length > 0" class="border border-neutral-200 dark:border-neutral-800 rounded-lg p-6 bg-white dark:bg-neutral-900 shadow-sm">
        <h3 class="text-sm font-semibold text-neutral-700 dark:text-neutral-300 mb-4">评分历史趋势</h3>
        <ClientOnly>
          <RatingHistoryChart 
            :data="ratingHistory" 
            :first-activity-date="user?.firstActivityAt || '2022-06-15'"
            :compact="true"
            :allow-page-markers="true"
            :target-total="stats?.totalRating || undefined"
          />
          <template #fallback>
            <div class="h-64 flex items-center justify-center text-neutral-500 dark:text-neutral-400">
              加载图表中...
            </div>
          </template>
        </ClientOnly>
      </div>

      <!-- Works Tabs -->
      <div class="border border-neutral-200 dark:border-neutral-800 rounded-lg bg-white dark:bg-neutral-900 shadow-sm">
        <div class="border-b border-neutral-200 dark:border-neutral-800">
          <nav class="flex space-x-6 px-6" aria-label="Tabs">
            <button
              v-for="tab in workTabs"
              :key="tab.key"
              @click="activeTab = tab.key"
              :class="[
                'py-3 px-1 border-b-2 font-medium text-sm transition-colors',
                activeTab === tab.key
                  ? 'border-emerald-500 text-emerald-600 dark:text-emerald-400'
                  : 'border-transparent text-neutral-500 hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-300'
              ]"
            >
              {{ tab.label }}
              <span v-if="tab.count" class="ml-2 text-xs text-neutral-400">({{ tab.count }})</span>
            </button>
          </nav>
          
        </div>

        <!-- Works List -->
        <div class="p-6">
          <div v-if="worksPending" class="text-center py-8">
            <svg class="w-5 h-5 animate-spin text-emerald-600 mx-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          </div>
          <div v-else-if="!works || works.length === 0" class="text-center py-8 text-neutral-500 dark:text-neutral-400">
            暂无{{ currentTabLabel }}作品
          </div>
          <div v-else class="space-y-3">
            <div v-for="work in displayedWorks" :key="work.wikidotId" 
                 class="p-4 bg-neutral-50 dark:bg-neutral-800 rounded-lg hover:bg-neutral-100 dark:hover:bg-neutral-700 transition-colors">
              <div class="flex items-start justify-between">
                <div class="flex-1">
                  <div class="flex items-center gap-2">
                    <NuxtLink :to="`/page/${work.wikidotId}`" class="text-sm font-medium text-neutral-900 dark:text-neutral-100 hover:text-emerald-600 dark:hover:text-emerald-400">
                      {{ work.title || 'Untitled' }}
                    </NuxtLink>
                    <span v-if="work.isDeleted" class="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400">
                      已删除
                    </span>
                  </div>
                  <div class="flex items-center gap-4 mt-1 text-xs text-neutral-600 dark:text-neutral-400">
                    <span v-if="work.voteCount">{{ work.voteCount }} 票</span>
                    <span v-if="work.revisionCount">{{ work.revisionCount }} 修订</span>
                    <span v-if="work.revisionCount">{{ work.revisionCount }} 修订</span>
                    <span v-if="work.isDeleted && work.deletedAt" class="text-red-600 dark:text-red-400">
                      删除于 {{ formatDate(work.deletedAt) }}
                    </span>
                  </div>
                  <div class="mt-2">
                    <div class="flex flex-wrap gap-2 max-w-full">
                      <span v-for="tag in (work.tags || []).slice(0, 6)" :key="tag" 
                            class="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400 truncate max-w-[40vw] sm:max-w-[18rem]">
                        #{{ tag }}
                      </span>
                    </div>
                  </div>
                </div>
                <div class="text-right ml-4">
                  <div class="text-lg font-bold text-neutral-900 dark:text-neutral-100">{{ work.rating ?? '0' }}</div>
                  <div class="text-xs text-neutral-600 dark:text-neutral-400">评分</div>
                </div>
              </div>
            </div>
          </div>

          <!-- Pagination -->
          <div v-if="totalPages > 1" class="flex justify-center gap-2 mt-6">
            <button
              @click="currentPage = Math.max(1, currentPage - 1)"
              :disabled="currentPage === 1"
              class="px-3 py-1 rounded text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed bg-neutral-100 dark:bg-neutral-800 hover:bg-neutral-200 dark:hover:bg-neutral-700"
            >
              上一页
            </button>
            <span class="px-3 py-1 text-sm text-neutral-600 dark:text-neutral-400">
              {{ currentPage }} / {{ totalPages }}
            </span>
            <button
              @click="currentPage = Math.min(totalPages, currentPage + 1)"
              :disabled="currentPage === totalPages"
              class="px-3 py-1 rounded text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed bg-neutral-100 dark:bg-neutral-800 hover:bg-neutral-200 dark:hover:bg-neutral-700"
            >
              下一页
            </button>
          </div>
        </div>
      </div>

      <!-- Recent Activity -->
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <!-- Recent Votes -->
        <div v-if="recentVotes && recentVotes.length > 0" class="border border-neutral-200 dark:border-neutral-800 rounded-lg p-6 bg-white dark:bg-neutral-900 shadow-sm">
          <h3 class="text-sm font-semibold text-neutral-700 dark:text-neutral-300 mb-4">最近投票</h3>
          <div class="space-y-2">
            <div v-for="vote in recentVotes.slice(0, 5)" :key="`${vote.timestamp}-${vote.pageWikidotId}`" 
                 class="flex items-center justify-between p-2 bg-neutral-50 dark:bg-neutral-800 rounded">
              <div class="flex-1 min-w-0">
                <NuxtLink :to="`/page/${vote.pageWikidotId}`" class="text-sm font-medium text-neutral-900 dark:text-neutral-100 hover:text-emerald-600 dark:hover:text-emerald-400 truncate block">
                  {{ vote.pageTitle || 'Untitled' }}
                </NuxtLink>
                <div class="text-xs text-neutral-600 dark:text-neutral-400">{{ formatRelativeTime(vote.timestamp) }}</div>
              </div>
              <div :class="[
                'text-lg font-bold ml-2',
                vote.direction > 0 ? 'text-green-600 dark:text-green-400' : 
                vote.direction < 0 ? 'text-red-600 dark:text-red-400' : 
                'text-neutral-600 dark:text-neutral-400'
              ]">
                {{ vote.direction > 0 ? '+1' : vote.direction < 0 ? '-1' : '0' }}
              </div>
            </div>
          </div>
        </div>

        <!-- Recent Revisions -->
        <div v-if="recentRevisions && recentRevisions.length > 0" class="border border-neutral-200 dark:border-neutral-800 rounded-lg p-6 bg-white dark:bg-neutral-900 shadow-sm">
          <h3 class="text-sm font-semibold text-neutral-700 dark:text-neutral-300 mb-4">最近编辑</h3>
          <div class="space-y-2">
            <div v-for="revision in recentRevisions.slice(0, 5)" :key="`${revision.timestamp}-${revision.pageWikidotId}`" 
                 class="p-2 bg-neutral-50 dark:bg-neutral-800 rounded">
              <NuxtLink :to="`/page/${revision.pageWikidotId}`" class="text-sm font-medium text-neutral-900 dark:text-neutral-100 hover:text-emerald-600 dark:hover:text-emerald-400">
                {{ revision.pageTitle || 'Untitled' }}
              </NuxtLink>
              <div class="text-xs text-neutral-600 dark:text-neutral-400 mt-1">
                {{ formatRevisionType(revision.type) }} · {{ formatRelativeTime(revision.timestamp) }}
              </div>
              <div v-if="revision.comment" class="text-xs text-neutral-500 dark:text-neutral-500 mt-1 truncate">
                {{ revision.comment }}
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Activity Records -->
      <div v-if="activityRecords && activityRecords.length > 0" class="border border-neutral-200 dark:border-neutral-800 rounded-lg p-6 bg-white dark:bg-neutral-900 shadow-sm">
        <h3 class="text-sm font-semibold text-neutral-700 dark:text-neutral-300 mb-4">成就记录</h3>
        <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          <div v-for="record in activityRecords" :key="record.id" class="flex items-center justify-between p-3 bg-neutral-50 dark:bg-neutral-800 rounded-lg">
            <div>
              <div class="text-sm font-medium text-neutral-900 dark:text-neutral-100">{{ formatRecordType(record.recordType) }}</div>
              <div v-if="record.achievedAt" class="text-xs text-neutral-600 dark:text-neutral-400 mt-1">{{ formatDate(record.achievedAt) }}</div>
            </div>
            <div v-if="record.value" class="text-lg font-bold text-emerald-600 dark:text-emerald-400">{{ Number(record.value).toFixed(0) }}</div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
// Note: avoid importing Nuxt auto-imported composables to prevent linter conflicts

// Declarations for Nuxt auto-imported globals to satisfy type checker in this environment
declare const useAsyncData: any
declare const useNuxtApp: any
declare const useRoute: any
// 简易调试开关（可通过 window.__DEV_DEBUG__ = true 打开）
// @ts-ignore
const __DEV_DEBUG__ = typeof window !== 'undefined' && (window as any).__DEV_DEBUG__ === true
const route = useRoute();
const {$bff} = useNuxtApp();

const wikidotId = computed(() => route.params.wikidotId as string);
const activeTab = ref('all');
const currentPage = ref(1);
const itemsPerPage = 10;

// Fetch user data
const { data: user, pending: userPending, error: userError } = await useAsyncData(
  () => `user-${wikidotId.value}`,
  () => $bff(`/users/by-wikidot-id`, { params: { wikidotId: wikidotId.value } }),
  { watch: [() => route.params.wikidotId] }
);

// Fetch user stats
const { data: stats, pending: statsPending } = await useAsyncData(
  () => `user-stats-${wikidotId.value}`,
  () => $bff(`/users/${wikidotId.value}/stats`),
  { watch: [() => route.params.wikidotId] }
);

// Fetch user works
const { data: works, pending: worksPending, refresh: refreshWorks } = await useAsyncData(
  () => `user-works-${wikidotId.value}-${activeTab.value}`,
  async () => {
    // 'all' 标签页不传递type参数，后端会返回所有类型
    // 其他标签页传递对应的type参数进行过滤
    const params: any = { 
      limit: 100, // Fetch more for client-side pagination
      includeDeleted: 'true' // 包含已删除的页面
    };
    
    // 不再让后端过滤，全部拉取后本地按标签过滤
    return await $bff(`/users/${wikidotId.value}/pages`, { params });
  },
  { watch: [() => route.params.wikidotId, activeTab] }
);

// Fetch recent votes
const { data: recentVotes } = await useAsyncData(
  () => `user-votes-${wikidotId.value}`,
  () => $bff(`/users/${wikidotId.value}/votes`, { params: { limit: 10 } }),
  { watch: [() => route.params.wikidotId] }
);

// Fetch recent revisions
const { data: recentRevisions } = await useAsyncData(
  () => `user-revisions-${wikidotId.value}`,
  () => $bff(`/users/${wikidotId.value}/revisions`, { params: { limit: 10 } }),
  { watch: [() => route.params.wikidotId] }
);

// Fetch activity records
const { data: activityRecords } = await useAsyncData(
  () => `user-activity-${wikidotId.value}`,
  () => $bff(`/stats/user-activity`, { 
    params: { 
      userId: user.value?.id,
      limit: 6
    } 
  }),
  { watch: [() => user.value?.id] }
);

// Fetch rating history
const { data: ratingHistory } = await useAsyncData(
  () => `user-rating-history-${wikidotId.value}`,
  () => $bff(`/users/${wikidotId.value}/rating-history`, { 
    params: { 
      granularity: 'week'  // 按周聚合，获取全部历史数据
    } 
  }),
  { watch: [() => route.params.wikidotId] }
);

// Work tabs configuration
const workTabs = computed(() => [
  { key: 'all', label: '全部作品', count: stats.value?.pageCount },
  { key: 'AUTHOR', label: '原创', count: null },
  { key: 'TRANSLATOR', label: '翻译', count: stats.value?.translationPageCount },
]);

const currentTabLabel = computed(() => {
  const tab = workTabs.value.find(t => t.key === activeTab.value);
  return tab ? tab.label : '作品';
});

const filteredWorks = computed(() => {
  const all = works.value || [] as any[];
  if (activeTab.value === 'AUTHOR') {
    return all.filter(w => Array.isArray(w.tags) && w.tags.includes('原创'));
  }
  if (activeTab.value === 'TRANSLATOR') {
    return all.filter(w => !(Array.isArray(w.tags) && w.tags.includes('原创')));
  }
  return all;
});

const displayedWorks = computed(() => {
  const list = filteredWorks.value;
  const start = (currentPage.value - 1) * itemsPerPage;
  const end = start + itemsPerPage;
  return list.slice(start, end);
});

const totalPages = computed(() => {
  const count = filteredWorks.value.length || 0;
  return Math.max(1, Math.ceil(count / itemsPerPage));
});

// Reset page when tab changes
watch(activeTab, () => {
  currentPage.value = 1;
});

// Helper functions
function formatDate(dateStr: string) {
  if (!dateStr) return 'N/A';
  const date = new Date(dateStr);
  return date.toLocaleDateString('zh-CN', { 
    year: 'numeric', 
    month: 'long', 
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

function formatActivityType(type: string) {
  const typeMap: Record<string, string> = {
    'PAGE_CREATED': '创建页面',
    'PAGE_EDITED': '编辑页面',
    'PAGE_TRANSLATED': '翻译页面',
    'VOTE_CAST': '投票',
    'COMMENT_POSTED': '发表评论',
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

function formatRecordType(type: string) {
  const typeMap: Record<string, string> = {
    'MOST_PRODUCTIVE_DAY': '最高产的一天',
    'LONGEST_STREAK': '最长连续活动',
    'FIRST_100_RATING': '首次达到100评分',
    'FIRST_500_RATING': '首次达到500评分',
    'FIRST_1000_RATING': '首次达到1000评分',
    'TOP_RATED_PAGE': '最高评分页面',
    'MOST_CONTROVERSIAL': '最具争议页面',
  };
  return typeMap[type] || type;
}

// Removed inline CategoryRank to avoid hydration mismatch
</script>

