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
          <div class="flex items-start justify-between gap-3">
            <div class="flex items-start gap-3 min-w-0 flex-1">
              <UserAvatar :wikidot-id="wikidotId" :name="user?.displayName || 'Unknown User'" :size="56" class="ring-1 ring-inset ring-neutral-200 dark:ring-neutral-800" />
              <h1 class="text-xl sm:text-2xl font-bold text-neutral-900 dark:text-neutral-100 mb-2 truncate">{{ user?.displayName || 'Unknown User' }}</h1>
              <div class="flex flex-wrap gap-2 mb-4">
                <span class="inline-flex items-center px-3 py-1 rounded-full text-xs font-medium bg-neutral-100 dark:bg-neutral-800 text-neutral-700 dark:text-neutral-300">
                  Wikidot: {{ wikidotId }}
                </span>
                <!-- remove @username pill per request -->
                <span v-if="user?.isGuest" class="inline-flex items-center px-3 py-1 rounded-full text-xs font-medium bg-yellow-100 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-400">
                  访客
                </span>
              </div>
            </div>
            <div v-if="stats?.rank" class="text-right shrink-0">
              <div class="text-2xl sm:text-3xl font-bold text-emerald-600 dark:text-emerald-400 whitespace-nowrap overflow-hidden">#{{ stats.rank }}</div>
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
              <div v-if="user?.firstActivityPageWikidotId || user?.firstActivityPageTitle" class="text-xs text-neutral-600 dark:text-neutral-400 mt-1">
                <NuxtLink :to="`/page/${user.firstActivityPageWikidotId}`" class="hover:text-emerald-600 dark:hover:text-emerald-400">
                  {{ user.firstActivityPageTitle || '未知页面' }}
                </NuxtLink>
                <span v-if="user?.firstActivityType === 'VOTE'" :class="[
                  'ml-1 font-bold',
                  Number(user?.firstActivityDirection || 0) > 0 ? 'text-green-600 dark:text-green-400' : Number(user?.firstActivityDirection || 0) < 0 ? 'text-red-600 dark:text-red-400' : 'text-neutral-500 dark:text-neutral-500'
                ]">
                  {{ Number(user?.firstActivityDirection || 0) > 0 ? '+1' : Number(user?.firstActivityDirection || 0) < 0 ? '-1' : '0' }}
                </span>
                <span v-else-if="user?.firstActivityType === 'REVISION' && user?.firstActivityRevisionType" class="ml-1 text-neutral-500 dark:text-neutral-500">— {{ formatRevisionType(user.firstActivityRevisionType) }}</span>
                <span v-if="user?.firstActivityComment" class="text-neutral-500 dark:text-neutral-500 ml-1 truncate">— {{ user.firstActivityComment }}</span>
              </div>
            </div>
            <div v-if="user?.lastActivityAt" class="bg-neutral-50 dark:bg-neutral-800 rounded-lg p-3">
              <div class="text-xs text-neutral-600 dark:text-neutral-400 mb-1">最近活动</div>
              <div class="text-sm font-medium text-neutral-900 dark:text-neutral-100">{{ formatDate(user.lastActivityAt) }}</div>
              <div v-if="user?.lastActivityType === 'VOTE' && (user?.lastActivityPageWikidotId || user?.lastActivityPageTitle)" class="text-xs text-neutral-600 dark:text-neutral-400 mt-1">
                投票 · 
                <NuxtLink :to="`/page/${user.lastActivityPageWikidotId}`" class="hover:text-emerald-600 dark:hover:text-emerald-400">
                  {{ user.lastActivityPageTitle || '未知页面' }}
                </NuxtLink>
                <span :class="[
                  'ml-1 font-bold',
                  Number(user?.lastActivityDirection || 0) > 0 ? 'text-green-600 dark:text-green-400' : Number(user?.lastActivityDirection || 0) < 0 ? 'text-red-600 dark:text-red-400' : 'text-neutral-500 dark:text-neutral-500'
                ]">
                  {{ Number(user?.lastActivityDirection || 0) > 0 ? '+1' : Number(user?.lastActivityDirection || 0) < 0 ? '-1' : '0' }}
                </span>
              </div>
              <div v-else-if="user?.lastActivityType === 'REVISION' && (user?.lastActivityPageWikidotId || user?.lastActivityPageTitle)" class="text-xs text-neutral-600 dark:text-neutral-400 mt-1">
                {{ formatRevisionType(user?.lastActivityRevisionType || '') }} · 
                <NuxtLink :to="`/page/${user.lastActivityPageWikidotId}`" class="hover:text-emerald-600 dark:hover:text-emerald-400">
                  {{ user.lastActivityPageTitle || '未知页面' }}
                </NuxtLink>
                <span v-if="user?.lastActivityComment" class="text-neutral-500 dark:text-neutral-500 ml-1 truncate">— {{ user.lastActivityComment }}</span>
              </div>
            </div>
          </div>

          <!-- Overall Stats Grid -->
          <div class="grid grid-cols-2 lg:grid-cols-4 gap-3 mt-6">
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
              <div class="text-xs text-neutral-600 dark:text-neutral-400 mb-1">投票</div>
              <div class="flex items-center justify-center gap-4">
                <span class="text-2xl font-bold text-green-600 dark:text-green-400">{{ stats?.votesUp ?? '0' }}</span>
                <span class="text-neutral-400">/</span>
                <span class="text-2xl font-bold text-red-600 dark:text-red-400">{{ stats?.votesDown ?? '0' }}</span>
              </div>
            </div>
          </div>
        </div>

        <!-- Category Rankings / Radar -->
        <div class="border border-neutral-200 dark:border-neutral-800 rounded-lg p-6 bg-white dark:bg-neutral-900 shadow-sm">
          <div class="flex items-center justify-between mb-4">
            <h3 class="text-sm font-semibold text-neutral-700 dark:text-neutral-300">分类表现</h3>
            <div class="inline-flex rounded-md overflow-hidden border border-neutral-200 dark:border-neutral-800">
              <button type="button" class="px-2 py-1 text-xs"
                :class="categoryView==='list' ? 'bg-emerald-600 text-white' : 'bg-transparent text-neutral-600 dark:text-neutral-300'"
                @click="categoryView='list'">列表</button>
              <button type="button" class="px-2 py-1 text-xs"
                :class="categoryView==='radar' ? 'bg-emerald-600 text-white' : 'bg-transparent text-neutral-600 dark:text-neutral-300'"
                @click="categoryView='radar'">雷达</button>
            </div>
          </div>
          <div v-if="stats && !statsPending">
            <div v-if="categoryView==='list'" class="space-y-3">
              <CategoryRank label="SCP" :rank="stats.scpRank ?? '-'" :rating="stats.scpRating ?? 0" :count="stats.pageCountScp ?? 0" />
              <CategoryRank label="故事" :rank="stats.storyRank ?? '-'" :rating="stats.storyRating ?? 0" :count="stats.pageCountTale ?? 0" />
              <CategoryRank label="GoI格式" :rank="stats.goiRank ?? '-'" :rating="stats.goiRating ?? 0" :count="stats.pageCountGoiFormat ?? 0" />
              <CategoryRank label="翻译" :rank="stats.translationRank ?? '-'" :rating="stats.translationRating ?? 0" :count="stats.translationPageCount ?? 0" />
              <CategoryRank label="被放逐者的图书馆" :rank="stats.wanderersRank ?? '-'" :rating="stats.wanderersRating ?? 0" :count="stats.wanderersPageCount ?? 0" />
              <CategoryRank label="艺术作品" :rank="stats.artRank ?? '-'" :rating="stats.artRating ?? 0" :count="stats.pageCountArtwork ?? 0" />
            </div>
            <div v-else>
              <ClientOnly>
                <UserCategoryRadarChart :user-stats="stats" />
                <template #fallback>
                  <div class="h-72 flex items-center justify-center text-neutral-500 dark:text-neutral-400">加载雷达图中...</div>
                </template>
              </ClientOnly>
            </div>
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
          <nav class="flex items-center justify-between px-6" aria-label="Tabs">
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
              <span v-if="tab.count !== null && tab.count !== undefined" class="ml-2 text-xs text-neutral-400">({{ tab.count }})</span>
            </button>
            <div class="flex items-center gap-2 text-xs text-neutral-600 dark:text-neutral-400">
              <label class="sr-only">排序</label>
              <select v-model="sortField" class="px-2 py-1 rounded bg-neutral-100 dark:bg-neutral-800">
                <option value="date">按时间</option>
                <option value="rating">按Rating</option>
              </select>
              <select v-model="sortOrder" class="px-2 py-1 rounded bg-neutral-100 dark:bg-neutral-800">
                <option value="desc">降序</option>
                <option value="asc">升序</option>
              </select>
            </div>
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
          <div v-else class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            <PageCard
              v-for="work in displayedWorks"
              :key="work.wikidotId"
              size="md"
              :p="normalizeWork(work)"
              :authors="[{ name: user?.displayName || 'Unknown User', url: `/user/${wikidotId}` }]"
            />
          </div>

          <!-- Pagination with selector -->
          <div v-if="totalPages > 1" class="flex flex-wrap items-center justify-center gap-2 mt-6">
            <button
              @click="currentPage = Math.max(1, currentPage - 1)"
              :disabled="currentPage === 1"
              class="px-3 py-1 rounded text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed bg-neutral-100 dark:bg-neutral-800 hover:bg-neutral-200 dark:hover:bg-neutral-700"
            >上一页</button>
            <div class="inline-flex items-center gap-1 text-sm text-neutral-600 dark:text-neutral-400">
              第
              <select v-model.number="currentPage" class="px-2 py-1 rounded bg-neutral-100 dark:bg-neutral-800">
                <option v-for="n in totalPages" :key="`wp-${n}`" :value="n">{{ n }}</option>
              </select>
              / {{ totalPages }} 页
            </div>
            <button
              @click="currentPage = Math.min(totalPages, currentPage + 1)"
              :disabled="currentPage === totalPages"
              class="px-3 py-1 rounded text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed bg-neutral-100 dark:bg-neutral-800 hover:bg-neutral-200 dark:hover:bg-neutral-700"
            >下一页</button>
          </div>
        </div>
      </div>

      <!-- Recent Activity -->
      <div class="space-y-6">
        <!-- Recent Votes -->
        <div v-if="recentVotes && recentVotes.length > 0" class="border border-neutral-200 dark:border-neutral-800 rounded-lg p-6 bg-white dark:bg-neutral-900 shadow-sm">
          <h3 class="text-sm font-semibold text-neutral-700 dark:text-neutral-300 mb-4">最近投票</h3>
          <div class="space-y-2">
            <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
              <div v-for="vote in recentVotes" :key="`${vote.timestamp}-${vote.pageWikidotId}`" 
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
            <div class="flex items-center justify-between mt-3">
              <button @click="prevUserVotePage" :disabled="userVoteOffset === 0" class="text-xs px-2 py-1 rounded bg-neutral-100 dark:bg-neutral-800 disabled:opacity-50">上一页</button>
              <div class="flex items-center gap-1 text-xs text-neutral-500 dark:text-neutral-400">
                第
                <select :value="(userVoteOffset / userVotePageSize) + 1" @change="e => goUserVotePage(Number((e.target as HTMLSelectElement).value))" class="px-2 py-1 rounded bg-neutral-100 dark:bg-neutral-800">
                  <option v-for="n in userVoteTotalPages" :key="`uvp-${n}`" :value="n">{{ n }}</option>
                </select>
                / {{ userVoteTotalPages }} 页
              </div>
              <button @click="nextUserVotePage" :disabled="!userHasMoreVotes" class="text-xs px-2 py-1 rounded bg-neutral-100 dark:bg-neutral-800 disabled:opacity-50">下一页</button>
            </div>
          </div>
        </div>

        <!-- Recent Revisions -->
        <div v-if="recentRevisions && recentRevisions.length > 0" class="border border-neutral-200 dark:border-neutral-800 rounded-lg p-6 bg-white dark:bg-neutral-900 shadow-sm">
          <h3 class="text-sm font-semibold text-neutral-700 dark:text-neutral-300 mb-4">最近编辑</h3>
          <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
            <div v-for="revision in recentRevisions" :key="`${revision.timestamp}-${revision.pageWikidotId}`" 
                 class="p-2 bg-neutral-50 dark:bg-neutral-800 rounded">
              <NuxtLink :to="`/page/${revision.pageWikidotId}`" class="text-sm font-medium text-neutral-900 dark:text-neutral-100 hover:text-emerald-600 dark:hover:text-emerald-400 truncate block">
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
          <div class="flex items-center justify-between mt-3">
            <button @click="prevUserRevPage" :disabled="userRevOffset === 0" class="text-xs px-2 py-1 rounded bg-neutral-100 dark:bg-neutral-800 disabled:opacity-50">上一页</button>
            <div class="flex items-center gap-1 text-xs text-neutral-500 dark:text-neutral-400">
              第
              <select :value="(userRevOffset / userRevPageSize) + 1" @change="e => goUserRevPage(Number((e.target as HTMLSelectElement).value))" class="px-2 py-1 rounded bg-neutral-100 dark:bg-neutral-800">
                <option v-for="n in userRevTotalPages" :key="`urp-${n}`" :value="n">{{ n }}</option>
              </select>
              / {{ userRevTotalPages }} 页
            </div>
            <button @click="nextUserRevPage" :disabled="!userHasMoreRevisions" class="text-xs px-2 py-1 rounded bg-neutral-100 dark:bg-neutral-800 disabled:opacity-50">下一页</button>
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
const categoryView = ref<'list'|'radar'>('list')
// Responsive items per page for works list
const itemsPerPage = ref(10);
if (typeof window !== 'undefined') {
  const computeItemsPerPage = () => {
    const width = window.innerWidth;
    if (width >= 1024) return 12; // lg: 3 columns
    if (width >= 768) return 8;   // md: 2 columns
    return 6;                     // sm: 1 column
  };
  itemsPerPage.value = computeItemsPerPage();
  window.addEventListener('resize', () => {
    const next = computeItemsPerPage();
    if (next !== itemsPerPage.value) {
      itemsPerPage.value = next;
      currentPage.value = 1;
    }
  });
}

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

// Fetch recent votes with pagination (responsive page size)
const userVotePageSize = ref(10)
if (typeof window !== 'undefined') {
  const computeVotePageSize = () => {
    const width = window.innerWidth
    if (width >= 1024) return 12 // 3列时每页12个
    if (width >= 768) return 10  // 2列时每页10个
    return 12                    // 1列时可多一些
  }
  userVotePageSize.value = computeVotePageSize()
  window.addEventListener('resize', () => {
    const next = computeVotePageSize()
    if (next !== userVotePageSize.value) {
      userVotePageSize.value = next
      userVoteOffset.value = 0
    }
  })
}
const userVoteOffset = ref(0)
const { data: recentVotes } = await useAsyncData(
  () => `user-votes-${wikidotId.value}-${userVoteOffset.value}-${userVotePageSize.value}`,
  () => $bff(`/users/${wikidotId.value}/votes`, { params: { limit: userVotePageSize.value, offset: userVoteOffset.value } }),
  { watch: [() => route.params.wikidotId, () => userVoteOffset.value, () => userVotePageSize.value] }
);
const userHasMoreVotes = computed(() => Array.isArray(recentVotes.value) && recentVotes.value.length === userVotePageSize.value)
function nextUserVotePage() { if (userHasMoreVotes.value) userVoteOffset.value += userVotePageSize.value }
function prevUserVotePage() { userVoteOffset.value = Math.max(0, userVoteOffset.value - userVotePageSize.value) }
const userVoteTotalPages = computed(() => {
  // Use votes cast by the user (not total votes received on their pages)
  const up = Number(stats.value?.votesUp || 0)
  const down = Number(stats.value?.votesDown || 0)
  const total = Math.max(0, up + down)
  const size = Number(userVotePageSize.value || 0)
  if (!total || !size) return 1
  return Math.max(1, Math.ceil(total / size))
})
function goUserVotePage(n:number){
  const idx = Math.max(1, Math.min(userVoteTotalPages.value, n)) - 1
  userVoteOffset.value = idx * userVotePageSize.value
}

// Fetch recent revisions with pagination (2-3 cols responsive page size)
const userRevPageSize = ref(10)
if (typeof window !== 'undefined') {
  const computeRevPageSize = () => {
    const width = window.innerWidth
    if (width >= 1024) return 12 // 3列
    if (width >= 768) return 10  // 2列
    return 12
  }
  userRevPageSize.value = computeRevPageSize()
  window.addEventListener('resize', () => {
    const next = computeRevPageSize()
    if (next !== userRevPageSize.value) {
      userRevPageSize.value = next
      userRevOffset.value = 0
    }
  })
}
const userRevOffset = ref(0)
const { data: recentRevisions } = await useAsyncData(
  () => `user-revisions-${wikidotId.value}-${userRevOffset.value}-${userRevPageSize.value}`,
  () => $bff(`/users/${wikidotId.value}/revisions`, { params: { limit: userRevPageSize.value, offset: userRevOffset.value } }),
  { watch: [() => route.params.wikidotId, () => userRevOffset.value, () => userRevPageSize.value] }
);
const userHasMoreRevisions = computed(() => Array.isArray(recentRevisions.value) && recentRevisions.value.length === userRevPageSize.value)
function nextUserRevPage() { if (userHasMoreRevisions.value) userRevOffset.value += userRevPageSize.value }
function prevUserRevPage() { userRevOffset.value = Math.max(0, userRevOffset.value - userRevPageSize.value) }
const userRevTotalPages = computed(() => {
  const approxTotal = Number(stats.value?.pageCount || 0) * 4 // heuristic if no total available
  if (!userRevPageSize.value) return 1
  return Math.max(1, Math.ceil(approxTotal / userRevPageSize.value))
})
function goUserRevPage(n:number){
  const idx = Math.max(1, Math.min(userRevTotalPages.value, n)) - 1
  userRevOffset.value = idx * userRevPageSize.value
}

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

// Precise tab counts from BFF (fallback to local if unavailable)
const { data: tabCounts } = await useAsyncData(
  () => `user-tab-counts-${wikidotId.value}`,
  () => $bff(`/users/${wikidotId.value}/page-counts`, { params: { includeDeleted: 'true' } }),
  { watch: [() => route.params.wikidotId] }
);

// Works helpers and tag-based filters (counts computed from all works to avoid tab-switch bugs)
const allWorks = computed(() => Array.isArray(works.value) ? (works.value as any[]) : ([] as any[]))

function hasTag(work: any, tag: string): boolean {
  return Array.isArray(work?.tags) && work.tags.includes(tag)
}

const isOriginal = (w: any) => hasTag(w, '原创')
const isAuthorPage = (w: any) => hasTag(w, '作者')
const isCoverPage = (w: any) => hasTag(w, '掩盖页')

const filterOriginal = (w: any) => isOriginal(w) && !isCoverPage(w)
const filterTranslation = (w: any) => !isOriginal(w) && !isAuthorPage(w) && !isCoverPage(w)
const filterOther = (w: any) => isAuthorPage(w) || isCoverPage(w)

// Work tabs configuration
const workTabs = computed(() => [
  { key: 'all', label: '全部作品', count: (tabCounts.value && typeof tabCounts.value.total === 'number') ? tabCounts.value.total : allWorks.value.length },
  { key: 'AUTHOR', label: '原创', count: (tabCounts.value && typeof tabCounts.value.original === 'number') ? tabCounts.value.original : allWorks.value.filter(filterOriginal).length },
  { key: 'TRANSLATOR', label: '翻译', count: (tabCounts.value && typeof tabCounts.value.translation === 'number') ? tabCounts.value.translation : allWorks.value.filter(filterTranslation).length },
  { key: 'OTHER', label: '其他', count: (tabCounts.value && typeof tabCounts.value.other === 'number') ? tabCounts.value.other : allWorks.value.filter(filterOther).length },
]);

const currentTabLabel = computed(() => {
  const tab = workTabs.value.find(t => t.key === activeTab.value);
  return tab ? tab.label : '作品';
});

const filteredWorks = computed(() => {
  const all = allWorks.value
  if (activeTab.value === 'AUTHOR') {
    return all.filter(filterOriginal)
  }
  if (activeTab.value === 'TRANSLATOR') {
    return all.filter(filterTranslation)
  }
  if (activeTab.value === 'OTHER') {
    return all.filter(filterOther)
  }
  return all
});

// Sorting
const sortField = ref<'date'|'rating'>('date')
const sortOrder = ref<'asc'|'desc'>('desc')

const sortedWorks = computed(() => {
  const list = filteredWorks.value.slice();
  const sign = sortOrder.value === 'asc' ? 1 : -1
  if (sortField.value === 'rating') {
    list.sort((a: any, b: any) => sign * ((Number(a?.rating || 0)) - (Number(b?.rating || 0))))
  } else {
    // date: use createdAt if available else fallback to wikidotId numeric order
    const getTime = (w: any) => {
      const t = w?.createdAt || w?.validFrom || w?.firstRevisionAt || null
      const d = t ? new Date(t) : null
      if (d && !isNaN(d.getTime())) return d.getTime()
      const idNum = Number(w?.wikidotId)
      return Number.isFinite(idNum) ? idNum : 0
    }
    list.sort((a: any, b: any) => sign * (getTime(a) - getTime(b)))
  }
  return list
})

watch([sortField, sortOrder], () => { currentPage.value = 1 })

const displayedWorks = computed(() => {
  const list = sortedWorks.value;
  const start = (currentPage.value - 1) * itemsPerPage.value;
  const end = start + itemsPerPage.value;
  return list.slice(start, end);
});

const totalPages = computed(() => {
  const count = sortedWorks.value.length || 0;
  return Math.max(1, Math.ceil(count / itemsPerPage.value));
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

function normalizeWork(work: any) {
  return {
    wikidotId: work.wikidotId,
    title: work.title,
    tags: work.tags,
    rating: work.rating,
    commentCount: work.commentCount ?? work.revisionCount,
    wilson95: work.wilson95,
    controversy: work.controversy,
    voteCount: work.voteCount,
    isDeleted: !!work.isDeleted,
    createdDate: (work.createdAt ? new Date(work.createdAt).toISOString().slice(0,10) : undefined)
  }
}
</script>

