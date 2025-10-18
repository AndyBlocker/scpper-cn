<template>
  <div>
    <div v-if="userPending || statsPending" class="p-8 text-center">
      <div class="inline-flex items-center gap-2">
        <svg class="w-5 h-5 animate-spin text-[rgb(var(--accent))]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
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
      <div class="flex items-center justify-between border-b-2 border-[rgba(var(--accent),0.18)] dark:border-[rgba(var(--accent),0.24)] pb-3 mb-4">
        <div class="flex items-center gap-3">
          <div class="h-8 w-1 bg-[rgb(var(--accent))] rounded" />
          <h2 class="text-lg font-bold text-neutral-800 dark:text-neutral-100">用户详情</h2>
        </div>
        <div class="flex items-center gap-3">
          <button
            v-if="canFollow"
            type="button"
            :aria-label="isFollowingThis ? '取消收藏作者' : '收藏作者'"
            :title="isFollowingThis ? '取消收藏作者' : '收藏作者'"
            class="inline-flex items-center justify-center h-9 w-9 rounded-full border transition shadow-sm"
            :class="isFollowingThis
              ? 'border-[rgba(var(--accent),0.45)] bg-[rgba(var(--accent),0.10)] text-[rgb(var(--accent))] dark:border-[rgba(var(--accent),0.45)]'
              : 'border-neutral-200 bg-white/80 text-neutral-600 hover:border-[rgba(var(--accent),0.35)] hover:text-[rgb(var(--accent))] dark:border-neutral-700 dark:bg-neutral-800/80 dark:text-neutral-300'"
            @click="toggleFollow"
          >
            <!-- Use the same star geometry for both states to ensure equal visual size -->
            <svg v-if="isFollowingThis" class="w-5 h-5" viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true">
              <path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.62L12 2 9.19 8.62 2 9.24l5.46 4.73L5.82 21z" />
            </svg>
            <svg v-else class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
              <path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.62L12 2 9.19 8.62 2 9.24l5.46 4.73L5.82 21z" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
            </svg>
          </button>
        </div>
      </div>

      

      <!-- User Info and Overall Stats -->
      <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <!-- User Basic Info -->
        <div class="lg:col-span-2 border border-neutral-200 dark:border-neutral-800 rounded-lg p-6 bg-white dark:bg-neutral-900 shadow-sm">
          <div class="flex items-start justify-between gap-3">
            <div class="flex items-start gap-3 min-w-0 flex-1">
              <UserAvatar :wikidot-id="wikidotId" :name="user?.displayName || 'Unknown User'" :size="56" class="shrink-0 ring-1 ring-neutral-200 dark:ring-neutral-800" />
              <div class="min-w-0 flex-1">
                <h1 class="text-xl sm:text-2xl font-bold text-neutral-900 dark:text-neutral-100 truncate">{{ user?.displayName || 'Unknown User' }}</h1>
                <div class="mt-1 text-xs text-neutral-600 dark:text-neutral-400 flex items-center gap-2">
                  <span>ID：{{ wikidotId }}</span>
                  <span v-if="user?.isGuest" class="inline-flex items-center px-2 py-0.5 rounded bg-yellow-100 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-400">访客</span>
                </div>
              </div>
            </div>
            <div v-if="stats?.rank" class="text-right shrink-0">
              <div class="text-2xl sm:text-3xl font-bold text-[rgb(var(--accent))] whitespace-nowrap overflow-hidden">#{{ stats.rank }}</div>
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
              <div v-if="user?.firstActivityPageWikidotId || user?.firstActivityPageTitle" class="text-xs text-neutral-600 dark:text-neutral-400 mt-1 break-words overflow-hidden">
                <div class="flex flex-wrap items-start gap-1">
                  <NuxtLink :to="`/page/${user.firstActivityPageWikidotId}`" class="hover:text-[rgb(var(--accent))] truncate max-w-full block">
                    {{ user.firstActivityPageTitle || '未知页面' }}
                  </NuxtLink>
                  <span v-if="user?.firstActivityType === 'VOTE'" :class="[
                    'font-bold shrink-0',
                    Number(user?.firstActivityDirection || 0) > 0 ? 'text-green-600 dark:text-green-400' : Number(user?.firstActivityDirection || 0) < 0 ? 'text-red-600 dark:text-red-400' : 'text-neutral-500 dark:text-neutral-500'
                  ]">
                    {{ Number(user?.firstActivityDirection || 0) > 0 ? '+1' : Number(user?.firstActivityDirection || 0) < 0 ? '-1' : '0' }}
                  </span>
                  <span v-else-if="user?.firstActivityType === 'REVISION' && user?.firstActivityRevisionType" class="text-neutral-500 dark:text-neutral-500 shrink-0">— {{ formatRevisionType(user.firstActivityRevisionType) }}</span>
                </div>
                <div v-if="user?.firstActivityComment" class="text-neutral-500 dark:text-neutral-500 mt-1 text-xs break-words overflow-hidden" style="display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical;">
                  — {{ user.firstActivityComment }}
                </div>
              </div>
            </div>
            <div v-if="user?.lastActivityAt" class="bg-neutral-50 dark:bg-neutral-800 rounded-lg p-3">
              <div class="text-xs text-neutral-600 dark:text-neutral-400 mb-1">最近活动</div>
              <div class="text-sm font-medium text-neutral-900 dark:text-neutral-100">{{ formatDate(user.lastActivityAt) }}</div>
              <div v-if="user?.lastActivityType === 'VOTE' && (user?.lastActivityPageWikidotId || user?.lastActivityPageTitle)" class="text-xs text-neutral-600 dark:text-neutral-400 mt-1 break-words overflow-hidden">
                <div class="flex flex-wrap items-start gap-1">
                  <span class="shrink-0">投票 ·</span>
                  <NuxtLink :to="`/page/${user.lastActivityPageWikidotId}`" class="hover:text-[rgb(var(--accent))] truncate max-w-full block">
                    {{ user.lastActivityPageTitle || '未知页面' }}
                  </NuxtLink>
                  <span :class="[
                    'font-bold shrink-0',
                    Number(user?.lastActivityDirection || 0) > 0 ? 'text-green-600 dark:text-green-400' : Number(user?.lastActivityDirection || 0) < 0 ? 'text-red-600 dark:text-red-400' : 'text-neutral-500 dark:text-neutral-500'
                  ]">
                    {{ Number(user?.lastActivityDirection || 0) > 0 ? '+1' : Number(user?.lastActivityDirection || 0) < 0 ? '-1' : '0' }}
                  </span>
                </div>
              </div>
              <div v-else-if="user?.lastActivityType === 'REVISION' && (user?.lastActivityPageWikidotId || user?.lastActivityPageTitle)" class="text-xs text-neutral-600 dark:text-neutral-400 mt-1 break-words overflow-hidden">
                <div class="flex flex-wrap items-start gap-1">
                  <span class="shrink-0">{{ formatRevisionType(user?.lastActivityRevisionType || '') }} ·</span>
                  <NuxtLink :to="`/page/${user.lastActivityPageWikidotId}`" class="hover:text-[rgb(var(--accent))] truncate max-w-full block">
                    {{ user.lastActivityPageTitle || '未知页面' }}
                  </NuxtLink>
                </div>
                <div v-if="user?.lastActivityComment" class="text-neutral-500 dark:text-neutral-500 mt-1 text-xs break-words overflow-hidden" style="display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical;">
                  — {{ user.lastActivityComment }}
                </div>
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
                :class="categoryView==='list' ? 'bg-[rgb(var(--accent))] text-white' : 'bg-transparent text-neutral-600 dark:text-neutral-300'"
                @click="categoryView='list'">列表</button>
              <button type="button" class="px-2 py-1 text-xs"
                :class="categoryView==='radar' ? 'bg-[rgb(var(--accent))] text-white' : 'bg-transparent text-neutral-600 dark:text-neutral-300'"
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

      
      <!-- Activity Heatmap -->
      <div class="border border-neutral-200 dark:border-neutral-800 rounded-lg p-6 bg-white dark:bg-neutral-900 shadow-sm">
        <div class="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between mb-4">
          <h3 class="text-sm font-semibold text-neutral-700 dark:text-neutral-300">过去一年活跃热力图</h3>
          <span class="text-xs text-neutral-500 dark:text-neutral-400">绿色越深代表当天的投票与创作更多</span>
        </div>
        <UserActivityHeatmap
          :records="activityHeatmapRecords"
          :requested-range="activityHeatmapRange"
          :pending="userDailyStatsPending"
          :error="userDailyStatsError"
        />
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
                  ? 'border-[rgb(var(--accent))] text-[rgb(var(--accent))]'
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
            <svg class="w-5 h-5 animate-spin text-[rgb(var(--accent))] mx-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24">
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

      <!-- Preferences Summary (2x2 on desktop, 1x4 on mobile) - moved below Works and above Recent Activity -->
      <div class="border border-neutral-200 dark:border-neutral-800 rounded-lg p-6 bg-white dark:bg-neutral-900 shadow-sm">
        <div class="flex items-center justify-between mb-4">
          <h3 class="text-sm font-semibold text-neutral-700 dark:text-neutral-300">偏好一览</h3>
        </div>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
          <!-- Favorite Authors with avatar -->
          <div class="bg-neutral-50 dark:bg-neutral-800 rounded-lg p-4">
            <div class="text-xs text-neutral-600 dark:text-neutral-400 mb-2">最喜欢的作者</div>
            <div v-if="favAuthors && favAuthors.length > 0" class="space-y-2">
              <div v-for="a in favAuthors" :key="`fa-${a.userId}`" class="flex items-center justify-between gap-3">
                <div class="flex items-center gap-2 min-w-0">
                  <UserAvatar :wikidot-id="a.wikidotId" :name="a.displayName || String(a.wikidotId || a.userId)" :size="24" class="ring-1 ring-neutral-200 dark:ring-neutral-800" />
                  <NuxtLink :to="`/user/${a.wikidotId}`" class="text-sm font-medium text-neutral-900 dark:text-neutral-100 hover:text-[rgb(var(--accent))] truncate">
                    {{ a.displayName || a.wikidotId || a.userId }}
                  </NuxtLink>
                </div>
                <div class="text-xs shrink-0 inline-flex items-center gap-1">
                  <span class="px-2 py-0.5 rounded bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400">+{{ a.uv }}</span>
                  <span class="px-2 py-0.5 rounded bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400">-{{ a.dv }}</span>
                </div>
              </div>
            </div>
            <div v-else class="text-xs text-neutral-500 dark:text-neutral-400">暂无数据</div>
            <div class="flex items-center justify-end gap-2 mt-3">
              <button @click="prevFavAuthorsPage" :disabled="prefAuthorsOffset===0" class="text-xs px-2 py-1 rounded bg-neutral-100 dark:bg-neutral-800 disabled:opacity-50">上一页</button>
              <button @click="nextFavAuthorsPage" :disabled="!hasMoreFavAuthors" class="text-xs px-2 py-1 rounded bg-neutral-100 dark:bg-neutral-800 disabled:opacity-50">下一页</button>
            </div>
          </div>

          <!-- Most Hated Authors (hidden content with centered placeholder) -->
          <div class="bg-neutral-50 dark:bg-neutral-800 rounded-lg p-4">
            <div class="text-xs text-neutral-600 dark:text-neutral-400 mb-2">最讨厌的作者</div>
            <div class="flex items-center justify-center text-xs text-neutral-500 dark:text-neutral-400 h-10">-- 暂无数据 --</div>
          </div>

          <!-- Favorite Tags -->
          <div class="bg-neutral-50 dark:bg-neutral-800 rounded-lg p-4">
            <div class="text-xs text-neutral-600 dark:text-neutral-400 mb-2">最喜欢的标签</div>
            <div v-if="favTags && favTags.length > 0" class="space-y-2">
              <div v-for="t in favTags" :key="`ft-${t.tag}`" class="flex items-center justify-between">
                <NuxtLink :to="`/search?tags=${encodeURIComponent(t.tag)}`" class="text-sm font-medium text-neutral-900 dark:text-neutral-100 hover:text-[rgb(var(--accent))] truncate">
                  #{{ t.tag }}
                </NuxtLink>
                <div class="text-xs shrink-0 inline-flex items-center gap-1">
                  <span class="px-2 py-0.5 rounded bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400">+{{ t.uv }}</span>
                  <span class="px-2 py-0.5 rounded bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400">-{{ t.dv }}</span>
                </div>
              </div>
            </div>
            <div v-else class="text-xs text-neutral-500 dark:text-neutral-400">暂无数据</div>
            <div class="flex items-center justify-end gap-2 mt-3">
              <button @click="prevFavTagsPage" :disabled="prefFavTagsOffset===0" class="text-xs px-2 py-1 rounded bg-neutral-100 dark:bg-neutral-800 disabled:opacity-50">上一页</button>
              <button @click="nextFavTagsPage" :disabled="!hasMoreFavTags" class="text-xs px-2 py-1 rounded bg-neutral-100 dark:bg-neutral-800 disabled:opacity-50">下一页</button>
            </div>
          </div>

          <!-- Most Hated Tags -->
          <div class="bg-neutral-50 dark:bg-neutral-800 rounded-lg p-4">
            <div class="text-xs text-neutral-600 dark:text-neutral-400 mb-2">最讨厌的标签</div>
            <div v-if="hateTags && hateTags.length > 0" class="space-y-2">
              <div v-for="t in hateTags" :key="`ht-${t.tag}`" class="flex items-center justify-between">
                <NuxtLink :to="`/search?excludeTags=${encodeURIComponent(t.tag)}`" class="text-sm font-medium text-neutral-900 dark:text-neutral-100 hover:text-[rgb(var(--accent))] truncate">
                  #{{ t.tag }}
                </NuxtLink>
                <div class="text-xs shrink-0 inline-flex items-center gap-1">
                  <span class="px-2 py-0.5 rounded bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400">-{{ t.dv }}</span>
                  <span class="px-2 py-0.5 rounded bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400">+{{ t.uv }}</span>
                </div>
              </div>
            </div>
            <div v-else class="text-xs text-neutral-500 dark:text-neutral-400">暂无数据</div>
            <div class="flex items-center justify-end gap-2 mt-3">
              <button @click="prevHateTagsPage" :disabled="prefHateTagsOffset===0" class="text-xs px-2 py-1 rounded bg-neutral-100 dark:bg-neutral-800 disabled:opacity-50">上一页</button>
              <button @click="nextHateTagsPage" :disabled="!hasMoreHateTags" class="text-xs px-2 py-1 rounded bg-neutral-100 dark:bg-neutral-800 disabled:opacity-50">下一页</button>
            </div>
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
                   :class="[
                     'flex items-center justify-between p-2 rounded',
                     vote.direction > 0 ? 'bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800/40' :
                     vote.direction < 0 ? 'bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800/40' :
                     'bg-neutral-50 dark:bg-neutral-800'
                   ]">
                <div class="flex-1 min-w-0">
                  <NuxtLink :to="`/page/${vote.pageWikidotId}`" class="text-sm font-medium text-neutral-900 dark:text-neutral-100 hover:text-[rgb(var(--accent))] truncate block">
                    {{ composeTitle(vote.pageTitle, vote.pageAlternateTitle) || 'Untitled' }}
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
                 class="p-2 rounded border border-neutral-200 dark:border-neutral-800 hover:bg-neutral-50 dark:hover:bg-neutral-800">
              <div class="flex items-center justify-between gap-2">
                <span :class="['inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-medium shrink-0 w-[120px] justify-center', revisionTypeClass(revision.type)]">
                  {{ formatRevisionType(revision.type) }}
                </span>
                <div class="text-xs text-neutral-500 dark:text-neutral-400 whitespace-nowrap shrink-0">{{ formatRelativeTime(revision.timestamp) }}</div>
              </div>
              <NuxtLink :to="`/page/${revision.pageWikidotId}`" class="text-sm font-medium text-neutral-900 dark:text-neutral-100 hover:text-[rgb(var(--accent))] mt-1 block truncate">
                {{ composeTitle(revision.pageTitle, revision.pageAlternateTitle) || 'Untitled' }}
              </NuxtLink>
              <div v-if="revision.comment" class="text-xs text-neutral-600 dark:text-neutral-400 mt-1 break-words overflow-hidden" style="display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical;">{{ revision.comment }}</div>
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
            <div v-if="record.value" class="text-lg font-bold text-[rgb(var(--accent))]">{{ Number(record.value).toFixed(0) }}</div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch, watchEffect } from 'vue'
import { useAuth } from '~/composables/useAuth'
import { useFollows } from '~/composables/useFollows'
import { useViewerVotes } from '~/composables/useViewerVotes'
import { orderTags } from '~/composables/useTagOrder'
// Note: avoid importing Nuxt auto-imported composables to prevent linter conflicts

// Declarations for Nuxt auto-imported globals to satisfy type checker in this environment
declare const useAsyncData: any
declare const useNuxtApp: any
declare const useRoute: any
declare const useState: any
declare const useHead: any

type UserDailyStatRecord = {
  date: string;
  votesCast?: number | null;
  pagesCreated?: number | null;
  revisions?: number | null;
  lastActivity?: string | null;
};

type HeatmapRange = {
  startIso: string;
  endIso: string;
};

// 简易调试开关（可通过 window.__DEV_DEBUG__ = true 打开）
// @ts-ignore
const __DEV_DEBUG__ = typeof window !== 'undefined' && (window as any).__DEV_DEBUG__ === true
const route = useRoute();
const {$bff} = useNuxtApp();
const { hydratePages: hydrateViewerVotes } = useViewerVotes()

const toItems = (payload: unknown): any[] => {
  if (Array.isArray(payload)) {
    return payload as any[];
  }
  if (payload && typeof payload === 'object' && Array.isArray((payload as any).items)) {
    return (payload as any).items as any[];
  }
  return [];
};

const wikidotId = computed(() => route.params.wikidotId as string);
const activityHeatmapRange = useState<HeatmapRange>(`user-activity-range-${wikidotId.value}`, computeHeatmapFetchRange);

watch(() => wikidotId.value, () => {
  activityHeatmapRange.value = computeHeatmapFetchRange();
});
const activeTab = ref('all');
const currentPage = ref(1);
// Sorting (server-side)
const sortField = ref<'date'|'rating'>('date')
const sortOrder = ref<'asc'|'desc'>('desc')
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

// 动态页面标题：使用用户显示名
const userPageTitle = computed(() => {
  const name = (user.value && (user.value as any).displayName)
    ? String((user.value as any).displayName).trim()
    : ''
  return name ? '用户：' + name : '用户详情'
})

function revisionTypeClass(type: string) {
  const t = String(type || '')
  if (t === 'PAGE_CREATED' || t === 'PAGE_RESTORED') {
    return 'bg-[rgba(var(--accent),0.12)] dark:bg-[rgba(var(--accent),0.22)] text-[rgb(var(--accent))]'
  }
  if (t === 'PAGE_EDITED') {
    return 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400'
  }
  if (t === 'PAGE_RENAMED') {
    return 'bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-400'
  }
  if (t === 'PAGE_DELETED') {
    return 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400'
  }
  if (t === 'METADATA_CHANGED') {
    return 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400'
  }
  if (t === 'TAGS_CHANGED') {
    return 'bg-sky-100 dark:bg-sky-900/30 text-sky-700 dark:text-sky-400'
  }
  if (t === 'SOURCE_CHANGED') {
    return 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400'
  }
  return 'bg-neutral-100 dark:bg-neutral-800 text-neutral-700 dark:text-neutral-300'
}
useHead({ title: userPageTitle })

// Follow/unfollow state
const { isAuthenticated, user: authUser } = useAuth()
const { fetchFollows, followUser, unfollowUser, isFollowing } = useFollows()
const canFollow = computed(() => isAuthenticated.value && Number(authUser.value?.linkedWikidotId || 0) !== Number(wikidotId.value))
const isFollowingThis = computed(() => isFollowing(Number(wikidotId.value)))
async function toggleFollow() {
  const id = Number(wikidotId.value)
  if (!Number.isFinite(id) || id <= 0) return
  await fetchFollows()
  try {
    if (isFollowingThis.value) {
      await unfollowUser(id)
    } else {
      await followUser(id)
    }
    await fetchFollows(true)
  } catch (e) {
    console.warn('[user] toggle follow failed', e)
  }
}

// Relations: authors and tags (liker/hater)
// Preferences pagination state
const prefAuthorsPageSize = ref(5)
const prefAuthorsOffset = ref(0)
const prefTagsPageSize = ref(5)
const prefFavTagsOffset = ref(0)
const prefHateTagsOffset = ref(0)

if (typeof window !== 'undefined') {
  const computePrefSize = () => (window.innerWidth >= 768 ? 5 : 5)
  const setSizes = () => {
    const size = computePrefSize()
    if (prefAuthorsPageSize.value !== size) {
      prefAuthorsPageSize.value = size
      prefAuthorsOffset.value = 0
    }
    if (prefTagsPageSize.value !== size) {
      prefTagsPageSize.value = size
      prefFavTagsOffset.value = 0
      prefHateTagsOffset.value = 0
    }
  }
  setSizes()
  window.addEventListener('resize', setSizes)
}

const { data: likerAuthors } = await useAsyncData(
  () => `user-liker-authors-${wikidotId.value}-${prefAuthorsPageSize.value}-${prefAuthorsOffset.value}`,
  () => $bff(`/users/${wikidotId.value}/relations/users`, { params: { direction: 'targets', polarity: 'liker', limit: prefAuthorsPageSize.value, offset: prefAuthorsOffset.value } }),
  { watch: [() => route.params.wikidotId, () => prefAuthorsPageSize.value, () => prefAuthorsOffset.value] }
);
const { data: haterAuthors } = await useAsyncData(
  () => `user-hater-authors-${wikidotId.value}-${prefAuthorsPageSize.value}-${prefAuthorsOffset.value}`,
  () => $bff(`/users/${wikidotId.value}/relations/users`, { params: { direction: 'targets', polarity: 'hater', limit: prefAuthorsPageSize.value, offset: prefAuthorsOffset.value } }),
  { watch: [() => route.params.wikidotId, () => prefAuthorsPageSize.value, () => prefAuthorsOffset.value] }
);
const { data: likerTags } = await useAsyncData(
  () => `user-liker-tags-${wikidotId.value}-${prefTagsPageSize.value}-${prefFavTagsOffset.value}`,
  () => $bff(`/users/${wikidotId.value}/relations/tags`, { params: { polarity: 'liker', limit: prefTagsPageSize.value, offset: prefFavTagsOffset.value } }),
  { watch: [() => route.params.wikidotId, () => prefTagsPageSize.value, () => prefFavTagsOffset.value] }
);
const { data: haterTags } = await useAsyncData(
  () => `user-hater-tags-${wikidotId.value}-${prefTagsPageSize.value}-${prefHateTagsOffset.value}`,
  () => $bff(`/users/${wikidotId.value}/relations/tags`, { params: { polarity: 'hater', limit: prefTagsPageSize.value, offset: prefHateTagsOffset.value } }),
  { watch: [() => route.params.wikidotId, () => prefTagsPageSize.value, () => prefHateTagsOffset.value] }
);

// Picks for UI (page by API sorting); filter out '原创'
const favAuthors = computed(() => (Array.isArray(likerAuthors.value) ? likerAuthors.value : []))
// hater authors content intentionally hidden per requirements
const favTags = computed(() => (Array.isArray(likerTags.value) ? likerTags.value.filter((t:any)=> t && t.tag !== '原创').map((t:any)=>({ tag: t.tag, uv: Number(t.uv||t.upvoteCount||0), dv: Number(t.dv||t.downvoteCount||0) })) : []))
const hateTags = computed(() => (Array.isArray(haterTags.value) ? haterTags.value.filter((t:any)=> t && t.tag !== '原创').map((t:any)=>({ tag: t.tag, uv: Number(t.uv||t.upvoteCount||0), dv: Number(t.dv||t.downvoteCount||0) })) : []))

// Has more flags & pager actions
const hasMoreFavAuthors = computed(() => Array.isArray(likerAuthors.value) && likerAuthors.value.length === prefAuthorsPageSize.value)
function nextFavAuthorsPage(){ if (hasMoreFavAuthors.value) prefAuthorsOffset.value += prefAuthorsPageSize.value }
function prevFavAuthorsPage(){ prefAuthorsOffset.value = Math.max(0, prefAuthorsOffset.value - prefAuthorsPageSize.value) }

const hasMoreFavTags = computed(() => Array.isArray(likerTags.value) && likerTags.value.length === prefTagsPageSize.value)
function nextFavTagsPage(){ if (hasMoreFavTags.value) prefFavTagsOffset.value += prefTagsPageSize.value }
function prevFavTagsPage(){ prefFavTagsOffset.value = Math.max(0, prefFavTagsOffset.value - prefTagsPageSize.value) }

const hasMoreHateTags = computed(() => Array.isArray(haterTags.value) && haterTags.value.length === prefTagsPageSize.value)
function nextHateTagsPage(){ if (hasMoreHateTags.value) prefHateTagsOffset.value += prefTagsPageSize.value }
function prevHateTagsPage(){ prefHateTagsOffset.value = Math.max(0, prefHateTagsOffset.value - prefTagsPageSize.value) }

// Fetch user stats
const { data: stats, pending: statsPending } = await useAsyncData(
  () => `user-stats-${wikidotId.value}`,
  () => $bff(`/users/${wikidotId.value}/stats`),
  { watch: [() => route.params.wikidotId] }
);

// Fetch user works (server-side sorting)
const { data: works, pending: worksPending, refresh: refreshWorks } = await useAsyncData(
  () => `user-works-${wikidotId.value}-${activeTab.value}-${sortField.value}-${sortOrder.value}-${currentPage.value}-${itemsPerPage.value}`,
  async () => {
    const params: any = { 
      limit: itemsPerPage.value, 
      offset: (Math.max(1, Number(currentPage.value || 1)) - 1) * Math.max(1, Number(itemsPerPage.value || 10)),
      sortBy: (sortField.value === 'rating') ? 'rating' : 'date',
      sortDir: (sortOrder.value === 'asc') ? 'asc' : 'desc',
      includeDeleted: 'true',
      tab: (activeTab.value === 'SHORT_STORIES') ? 'short_stories'
         : (activeTab.value === 'ANOMALOUS_LOG') ? 'anomalous_log'
         : (activeTab.value === 'AUTHOR') ? 'author'
         : (activeTab.value === 'TRANSLATOR') ? 'translator'
         : (activeTab.value === 'OTHER') ? 'other'
         : 'all'
    };
    return await $bff(`/users/${wikidotId.value}/pages`, { params });
  },
  { watch: [() => route.params.wikidotId, activeTab, () => sortField.value, () => sortOrder.value, () => currentPage.value, () => itemsPerPage.value] }
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
const { data: userVotesPage } = await useAsyncData(
  () => `user-votes-${wikidotId.value}-${userVoteOffset.value}-${userVotePageSize.value}`,
  () => $bff(`/users/${wikidotId.value}/votes`, { params: { limit: userVotePageSize.value, offset: userVoteOffset.value } }),
  { watch: [() => route.params.wikidotId, () => userVoteOffset.value, () => userVotePageSize.value] }
);
const recentVotes = computed(() => toItems(userVotesPage.value))
const userVoteTotal = computed(() => {
  const payload = userVotesPage.value as any
  if (payload && typeof payload.total === 'number' && Number.isFinite(payload.total)) {
    return Number(payload.total)
  }
  return Math.max(0, userVoteOffset.value + recentVotes.value.length)
})
const userHasMoreVotes = computed(() => {
  const size = Number(userVotePageSize.value || 0)
  if (!size) return false
  const total = userVoteTotal.value
  if (!total) return recentVotes.value.length === size
  return userVoteOffset.value + recentVotes.value.length < total
})
function nextUserVotePage() { if (userHasMoreVotes.value) userVoteOffset.value += userVotePageSize.value }
function prevUserVotePage() { userVoteOffset.value = Math.max(0, userVoteOffset.value - userVotePageSize.value) }
const userVoteTotalPages = computed(() => {
  const size = Number(userVotePageSize.value || 0)
  if (!size) return 1
  const total = userVoteTotal.value
  if (!total) return 1
  return Math.max(1, Math.ceil(total / size))
})
function goUserVotePage(n:number){
  const totalPages = userVoteTotalPages.value
  if (!Number.isFinite(totalPages) || totalPages <= 0) return
  const idx = Math.max(1, Math.min(totalPages, Number.isFinite(n) ? n : 1)) - 1
  userVoteOffset.value = idx * userVotePageSize.value
}
watchEffect(() => {
  const size = Number(userVotePageSize.value || 0)
  if (!size) return
  const total = userVoteTotal.value
  if (!total) {
    if (userVoteOffset.value !== 0 && recentVotes.value.length === 0) {
      userVoteOffset.value = 0
    }
    return
  }
  const maxOffset = Math.max(0, Math.floor((total - 1) / size) * size)
  if (userVoteOffset.value > maxOffset) {
    userVoteOffset.value = maxOffset
  }
})

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
const { data: userRevisionsPage } = await useAsyncData(
  () => `user-revisions-${wikidotId.value}-${userRevOffset.value}-${userRevPageSize.value}`,
  () => $bff(`/users/${wikidotId.value}/revisions`, { params: { limit: userRevPageSize.value, offset: userRevOffset.value } }),
  { watch: [() => route.params.wikidotId, () => userRevOffset.value, () => userRevPageSize.value] }
);
const recentRevisions = computed(() => toItems(userRevisionsPage.value))
const userRevTotal = computed(() => {
  const payload = userRevisionsPage.value as any
  if (payload && typeof payload.total === 'number' && Number.isFinite(payload.total)) {
    return Number(payload.total)
  }
  return Math.max(0, userRevOffset.value + recentRevisions.value.length)
})
const userHasMoreRevisions = computed(() => {
  const size = Number(userRevPageSize.value || 0)
  if (!size) return false
  const total = userRevTotal.value
  if (!total) return recentRevisions.value.length === size
  return userRevOffset.value + recentRevisions.value.length < total
})
function nextUserRevPage() { if (userHasMoreRevisions.value) userRevOffset.value += userRevPageSize.value }
function prevUserRevPage() { userRevOffset.value = Math.max(0, userRevOffset.value - userRevPageSize.value) }
const userRevTotalPages = computed(() => {
  const size = Number(userRevPageSize.value || 0)
  if (!size) return 1
  const total = userRevTotal.value
  if (!total) return 1
  return Math.max(1, Math.ceil(total / size))
})
function goUserRevPage(n:number){
  const totalPages = userRevTotalPages.value
  if (!Number.isFinite(totalPages) || totalPages <= 0) return
  const idx = Math.max(1, Math.min(totalPages, Number.isFinite(n) ? n : 1)) - 1
  userRevOffset.value = idx * userRevPageSize.value
}
watchEffect(() => {
  const size = Number(userRevPageSize.value || 0)
  if (!size) return
  const total = userRevTotal.value
  if (!total) {
    if (userRevOffset.value !== 0 && recentRevisions.value.length === 0) {
      userRevOffset.value = 0
    }
    return
  }
  const maxOffset = Math.max(0, Math.floor((total - 1) / size) * size)
  if (userRevOffset.value > maxOffset) {
    userRevOffset.value = maxOffset
  }
})

// Fetch activity records
const { data: rawActivityRecords } = await useAsyncData(
  () => `user-activity-${wikidotId.value}`,
  () => $bff(`/stats/user-activity`, { 
    params: { 
      userId: user.value?.id,
      limit: 6
    } 
  }),
  { watch: [() => user.value?.id] }
);
const activityRecords = computed(() => toItems(rawActivityRecords.value))

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

const { data: userDailyStats, pending: userDailyStatsPending, error: userDailyStatsError } = await useAsyncData(
  () => `user-daily-stats-${wikidotId.value}`,
  async () => {
    const id = user.value?.id;
    if (!id) return [];
    const range = activityHeatmapRange.value;
    if (!range?.startIso || !range?.endIso) return [];
    return await $bff(`/stats/users/${id}/daily`, {
      params: {
        startDate: range.startIso,
        endDate: range.endIso,
        limit: '400'
      }
    });
  },
  { watch: [() => user.value?.id, () => activityHeatmapRange.value] }
);

const activityHeatmapRecords = computed<UserDailyStatRecord[]>(() => {
  if (!Array.isArray(userDailyStats.value)) return [];
  return (userDailyStats.value as UserDailyStatRecord[]).map((record) => ({
    ...record,
    revisions: typeof record.revisions === 'number' ? record.revisions : Number(record.revisions ?? 0)
  }));
});

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

// Prefer server-side grouping when available
const hasGroup = (w: any, key: string) => (w && typeof w.groupKey === 'string' && w.groupKey === key)
const isOriginal = (w: any) => hasGroup(w, 'author') || hasTag(w, '原创')
const isAuthorPage = (w: any) => hasTag(w, '作者')
const isCoverPage = (w: any) => hasTag(w, '掩盖页')
const isParagraph = (w: any) => hasTag(w, '段落')

const isShortStories = (w: any) => hasGroup(w, 'short_stories') || (w?.category === 'short-stories')
const isAnomalousLog = (w: any) => hasGroup(w, 'anomalous_log') || (w?.category === 'log-of-anomalous-items-cn')

// Exclude short-stories & anomalous-log from original/translation/other
const filterOriginal = (w: any) => isOriginal(w) && !isCoverPage(w) && !isParagraph(w) && !isShortStories(w) && !isAnomalousLog(w)
const filterTranslation = (w: any) => hasGroup(w, 'translator') || (!isOriginal(w) && !isAuthorPage(w) && !isCoverPage(w) && !isParagraph(w) && !isShortStories(w) && !isAnomalousLog(w))
const filterOther = (w: any) => hasGroup(w, 'other') || ((isAuthorPage(w) || isCoverPage(w) || isParagraph(w)) && !isShortStories(w) && !isAnomalousLog(w))

// Category-based tabs

// Hide-zero tabs: compute counts safely from BFF counts if available, else local
const shortStoriesCount = computed(() => {
  if (tabCounts.value && typeof tabCounts.value.shortStories === 'number') return tabCounts.value.shortStories
  return allWorks.value.filter(isShortStories).length
})
const anomalousLogCount = computed(() => {
  if (tabCounts.value && typeof tabCounts.value.anomalousLog === 'number') return tabCounts.value.anomalousLog
  return allWorks.value.filter(isAnomalousLog).length
})

// Work tabs configuration
const workTabs = computed(() => {
  const tabs = [
    { key: 'all', label: '全部作品', count: (tabCounts.value && typeof tabCounts.value.total === 'number') ? tabCounts.value.total : allWorks.value.length },
    { key: 'AUTHOR', label: '原创', count: (tabCounts.value && typeof tabCounts.value.original === 'number') ? tabCounts.value.original : allWorks.value.filter(filterOriginal).length },
    { key: 'TRANSLATOR', label: '翻译', count: (tabCounts.value && typeof tabCounts.value.translation === 'number') ? tabCounts.value.translation : allWorks.value.filter(filterTranslation).length },
  ] as Array<{key:string,label:string,count:number}>
  const ss = shortStoriesCount.value
  if (ss > 0) tabs.push({ key: 'SHORT_STORIES', label: '三句话外围', count: ss })
  const al = anomalousLogCount.value
  if (al > 0) tabs.push({ key: 'ANOMALOUS_LOG', label: '异常物品记录', count: al })
  const otherCount = (tabCounts.value && typeof tabCounts.value.other === 'number') ? tabCounts.value.other : allWorks.value.filter(filterOther).length
  tabs.push({ key: 'OTHER', label: '其他', count: otherCount })
  // hide tabs with zero count except 'all'
  return tabs.filter(t => t.key === 'all' || (t.count || 0) > 0)
})

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
  if (activeTab.value === 'SHORT_STORIES') {
    return all.filter(isShortStories)
  }
  if (activeTab.value === 'ANOMALOUS_LOG') {
    return all.filter(isAnomalousLog)
  }
  if (activeTab.value === 'OTHER') {
    return all.filter(filterOther)
  }
  return all
});

// Server-side sorted; keep client no-op to preserve existing bindings
const sortedWorks = computed(() => filteredWorks.value)

watch([sortField, sortOrder], () => { currentPage.value = 1 })

// Server-side pagination: displayed list equals fetched page
const displayedWorks = computed(() => sortedWorks.value);

watch(
  () => works.value,
  (newWorks) => {
    if (!process.client) return
    if (!Array.isArray(newWorks) || newWorks.length === 0) return
    void hydrateViewerVotes(newWorks as any[])
  },
  { immediate: true, flush: 'post' }
)

const totalPages = computed(() => {
  const total = (tabCounts.value && typeof tabCounts.value.total === 'number') ? Number(tabCounts.value.total) : 0;
  if (Number.isFinite(total) && total > 0) return Math.max(1, Math.ceil(total / itemsPerPage.value));
  // Fallback: estimate from current page size if counts unavailable
  const count = sortedWorks.value.length || 0;
  return Math.max(1, Math.ceil(count / itemsPerPage.value));
});

// Reset page when tab changes
watch(activeTab, () => {
  currentPage.value = 1;
});

// Ensure active tab is visible; if hidden by zero-count, reset to 'all'
watch(workTabs, (tabs) => {
  const exists = tabs.some(t => t.key === activeTab.value)
  if (!exists) activeTab.value = 'all'
})

// Helper functions
function computeHeatmapFetchRange(): HeatmapRange {
  const end = new Date();
  end.setUTCHours(0, 0, 0, 0);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 364);
  return {
    startIso: formatDateParam(start),
    endIso: formatDateParam(end)
  };
}

function formatDateParam(date: Date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '';
  return date.toISOString().slice(0, 10);
}

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
    'SOURCE_CHANGED': '编辑内容',
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

function composeTitle(title?: string | null, alternateTitle?: string | null) {
  const base = typeof title === 'string' ? title.trim() : ''
  const alt = typeof alternateTitle === 'string' ? alternateTitle.trim() : ''
  if (alt) return base ? `${base} - ${alt}` : alt
  return base
}

function normalizeWork(work: any) {
  return {
    wikidotId: work.wikidotId,
    title: work.title,
    alternateTitle: work.alternateTitle,
    category: work.category,
    tags: orderTags(work.tags as string[] | null | undefined),
    rating: work.rating,
    commentCount: work.commentCount ?? work.revisionCount,
    wilson95: work.wilson95,
    controversy: work.controversy,
    voteCount: work.voteCount,
    snippetHtml: work.snippet || null,
    isDeleted: !!work.isDeleted,
    deletedAt: work.deletedAt || (work.validTo || null),
    createdDate: (work.createdAt ? new Date(work.createdAt).toISOString().slice(0,10) : undefined)
  }
}
</script>
