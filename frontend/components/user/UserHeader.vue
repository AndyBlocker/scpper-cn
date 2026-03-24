<template>
  <div class="space-y-6">
    <!-- Header -->
    <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between border-b-2 border-[var(--g-accent-medium)] dark:border-[var(--g-accent-strong)] pb-3 mb-4">
      <div class="flex items-center gap-3">
        <div class="h-8 w-1 bg-[var(--g-accent)] rounded" />
        <h2 class="text-lg font-bold text-neutral-800 dark:text-neutral-100">用户详情</h2>
      </div>
      <div class="flex items-center gap-3 w-full sm:w-auto sm:justify-end">
        <button
          v-if="canFollow"
          type="button"
          :aria-label="isFollowingThis ? '取消收藏作者' : '收藏作者'"
          :title="isFollowingThis ? '取消收藏作者' : '收藏作者'"
          class="inline-flex items-center justify-center h-9 w-9 rounded-full border transition shadow-sm"
          :class="isFollowingThis
            ? 'border-[rgba(var(--accent),0.45)] bg-[var(--g-accent-soft)] text-[var(--g-accent)] dark:border-[rgba(var(--accent),0.45)]'
            : 'border-neutral-200 bg-white/80 text-neutral-600 hover:border-[var(--g-accent-border)] hover:text-[var(--g-accent)] dark:border-neutral-700 dark:bg-neutral-800/80 dark:text-neutral-300'"
          @click="$emit('toggle-follow')"
        >
          <!-- Use the same star geometry for both states to ensure equal visual size -->
          <LucideIcon v-if="isFollowingThis" name="Star" class="w-5 h-5" stroke-width="1.8" fill="currentColor" />
          <LucideIcon v-else name="Star" class="w-5 h-5" stroke-width="1.8" />
        </button>
      </div>
    </div>

    <!-- User Info and Overall Stats -->
    <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
      <!-- User Basic Info -->
      <div class="lg:col-span-2 border border-neutral-200 dark:border-neutral-800 rounded-lg p-6 bg-white dark:bg-neutral-900 shadow-sm">
        <div class="flex flex-wrap items-start justify-between gap-4">
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
          <div v-if="statsPending" class="text-right shrink-0">
            <div class="w-16 h-7 rounded bg-neutral-100 animate-pulse dark:bg-neutral-700/60 mb-1"></div>
            <div class="w-20 h-3 rounded bg-neutral-100 animate-pulse dark:bg-neutral-700/60 ml-auto"></div>
          </div>
          <div v-else-if="stats?.rank" class="text-right shrink-0">
            <div class="text-2xl sm:text-3xl font-bold text-[var(--g-accent)] whitespace-nowrap overflow-hidden">#{{ stats.rank }}</div>
            <div class="text-xs text-neutral-600 dark:text-neutral-400">综合排名</div>
          </div>
        </div>

        <!-- Activity Timeline -->
        <div class="grid grid-cols-1 md:grid-cols-2 gap-4 mt-6">
          <div v-if="user?.firstActivityAt" class="bg-neutral-50 dark:bg-neutral-800 rounded-lg p-3">
            <div class="text-xs text-neutral-600 dark:text-neutral-400 mb-1">首次活动</div>
            <div class="text-sm font-medium text-neutral-900 dark:text-neutral-100">{{ formatDate(user.firstActivityAt) }}</div>
            <div v-if="user?.firstActivityType && !isForumPostActivity(user?.firstActivityType)" class="text-xs text-neutral-500 dark:text-neutral-500 mt-1">
              {{ formatActivityType(user.firstActivityType) }}
            </div>
            <div v-if="user?.firstActivityPageWikidotId || user?.firstActivityPageTitle" class="text-xs text-neutral-600 dark:text-neutral-400 mt-1 break-words overflow-hidden">
              <div class="flex flex-wrap items-start gap-1">
                <NuxtLink :to="`/page/${user.firstActivityPageWikidotId}`" class="hover:text-[var(--g-accent)] truncate max-w-full block">
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
            <div v-else-if="isForumPostActivity(user?.firstActivityType)" class="text-xs text-neutral-600 dark:text-neutral-400 mt-1 break-words overflow-hidden">
              <NuxtLink
                :to="forumPostLink(user?.firstActivityForumThreadId, user?.firstActivityForumPostId)"
                class="block text-xs font-medium text-neutral-700 dark:text-neutral-300 hover:text-[var(--g-accent)] break-words overflow-hidden"
                style="display: -webkit-box; -webkit-line-clamp: 1; line-clamp: 1; -webkit-box-orient: vertical;"
              >
                发帖 - {{ user?.firstActivityForumThreadTitle || '论坛主题' }} - {{ user?.firstActivityForumPostTitle || '无标题' }}
              </NuxtLink>
              <div
                v-if="user?.firstActivityForumExcerpt"
                class="text-neutral-500 dark:text-neutral-500 mt-1 text-xs break-words overflow-hidden"
                style="display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical;"
              >
                {{ user.firstActivityForumExcerpt }}
              </div>
            </div>
          </div>
          <div v-if="user?.lastActivityAt" class="bg-neutral-50 dark:bg-neutral-800 rounded-lg p-3">
            <div class="text-xs text-neutral-600 dark:text-neutral-400 mb-1">最近活动</div>
            <div class="text-sm font-medium text-neutral-900 dark:text-neutral-100">{{ formatDate(user.lastActivityAt) }}</div>
            <div v-if="user?.lastActivityType && !isForumPostActivity(user?.lastActivityType)" class="text-xs text-neutral-500 dark:text-neutral-500 mt-1">
              {{ formatActivityType(user.lastActivityType) }}
            </div>
            <div v-if="user?.lastActivityType === 'VOTE' && (user?.lastActivityPageWikidotId || user?.lastActivityPageTitle)" class="text-xs text-neutral-600 dark:text-neutral-400 mt-1 break-words overflow-hidden">
              <div class="flex flex-wrap items-start gap-1">
                <span class="shrink-0">投票 ·</span>
                <NuxtLink :to="`/page/${user.lastActivityPageWikidotId}`" class="hover:text-[var(--g-accent)] truncate max-w-full block">
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
                <NuxtLink :to="`/page/${user.lastActivityPageWikidotId}`" class="hover:text-[var(--g-accent)] truncate max-w-full block">
                  {{ user.lastActivityPageTitle || '未知页面' }}
                </NuxtLink>
              </div>
              <div v-if="user?.lastActivityComment" class="text-neutral-500 dark:text-neutral-500 mt-1 text-xs break-words overflow-hidden" style="display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical;">
                — {{ user.lastActivityComment }}
              </div>
            </div>
            <div v-else-if="isForumPostActivity(user?.lastActivityType)" class="text-xs text-neutral-600 dark:text-neutral-400 mt-1 break-words overflow-hidden">
              <NuxtLink
                :to="forumPostLink(user?.lastActivityForumThreadId, user?.lastActivityForumPostId)"
                class="block text-xs font-medium text-neutral-700 dark:text-neutral-300 hover:text-[var(--g-accent)] break-words overflow-hidden"
                style="display: -webkit-box; -webkit-line-clamp: 1; line-clamp: 1; -webkit-box-orient: vertical;"
              >
                发帖 - {{ user?.lastActivityForumThreadTitle || '论坛主题' }} - {{ user?.lastActivityForumPostTitle || '无标题' }}
              </NuxtLink>
              <div
                v-if="user?.lastActivityForumExcerpt"
                class="text-neutral-500 dark:text-neutral-500 mt-1 text-xs break-words overflow-hidden"
                style="display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical;"
              >
                {{ user.lastActivityForumExcerpt }}
              </div>
            </div>
          </div>
        </div>

        <!-- Overall Stats Grid -->
        <div v-if="statsPending" class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 mt-6">
          <div v-for="n in 4" :key="`stats-skeleton-${n}`" class="bg-neutral-100 dark:bg-neutral-800 rounded-lg p-3 animate-pulse">
            <div class="h-3 w-20 bg-neutral-300/70 dark:bg-neutral-700/70 rounded mb-3"></div>
            <div class="h-8 bg-neutral-300/80 dark:bg-neutral-700/80 rounded"></div>
          </div>
        </div>
        <div v-else class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 mt-6">
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
        <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between mb-4">
          <h3 class="text-sm font-semibold text-neutral-700 dark:text-neutral-300">分类表现</h3>
          <div class="inline-flex w-full sm:w-auto rounded-md overflow-hidden border border-neutral-200 dark:border-neutral-800 justify-center sm:justify-start">
            <button type="button" class="px-2 py-1 text-xs"
              :class="categoryView==='list' ? 'bg-[var(--g-accent)] text-white' : 'bg-transparent text-neutral-600 dark:text-neutral-300'"
              @click="categoryView='list'">列表</button>
            <button type="button" class="px-2 py-1 text-xs"
              :class="categoryView==='radar' ? 'bg-[var(--g-accent)] text-white' : 'bg-transparent text-neutral-600 dark:text-neutral-300'"
              @click="categoryView='radar'">雷达</button>
          </div>
        </div>
        <div v-if="statsPending">
          <div class="space-y-3">
            <div v-for="n in 6" :key="`category-skeleton-${n}`" class="h-10 rounded-lg bg-neutral-100 animate-pulse dark:bg-neutral-800" />
          </div>
        </div>
        <div v-else-if="stats">
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

    <!-- Public Collections -->
    <section
      v-if="publicCollectionsLoading || publicCollections.length > 0"
      class="relative overflow-hidden rounded-lg border border-neutral-200/80 bg-white p-6 shadow-sm dark:border-neutral-800/70 dark:bg-neutral-950"
    >
      <div class="space-y-6">
        <div class="flex flex-wrap items-center justify-between gap-3">
          <h3 class="flex items-center gap-2 text-base font-semibold text-neutral-800 dark:text-neutral-100">
            <LucideIcon name="BookmarkPlus" class="h-5 w-5 text-[var(--g-accent)]" />
            公开收藏夹
          </h3>
          <span v-if="!publicCollectionsLoading && publicCollections.length > 0" class="text-xs text-neutral-500 dark:text-neutral-400">
            共 {{ publicCollections.length }} 个
          </span>
        </div>
        <div v-if="publicCollectionsLoading" class="grid gap-4 md:grid-cols-2">
          <div v-for="n in 3" :key="`collection-skeleton-${n}`" class="h-40 rounded-lg bg-neutral-100/80 animate-pulse dark:bg-neutral-800/60" />
        </div>
        <div v-else class="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
          <NuxtLink
            v-for="collection in publicCollections"
            :key="collection.id"
            :to="`/user/${wikidotId}/collections/${collection.slug}`"
            class="block rounded-lg focus:outline-none focus:ring-2 focus:ring-[var(--g-accent-border)]"
          >
            <CollectionCard :collection="collection" :show-visibility="false" :clickable="false">
              <template #footer>
                <span class="inline-flex items-center gap-1 text-xs text-neutral-500 dark:text-neutral-400">
                  <LucideIcon name="ArrowUpRight" class="h-3 w-3" />
                  查看详情
                </span>
              </template>
            </CollectionCard>
          </NuxtLink>
        </div>
      </div>
    </section>

    <!-- Rating History Chart -->
    <div class="border border-neutral-200 dark:border-neutral-800 rounded-lg p-6 bg-white dark:bg-neutral-900 shadow-sm">
      <h3 class="text-sm font-semibold text-neutral-700 dark:text-neutral-300 mb-4">评分历史趋势</h3>
      <div v-if="ratingHistoryPending" class="h-64 rounded-lg bg-neutral-100 animate-pulse dark:bg-neutral-800/70"></div>
      <ClientOnly v-else-if="ratingHistory && ratingHistory.length > 0">
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
      <div v-else class="text-sm text-neutral-500 dark:text-neutral-400">暂无评分历史数据</div>
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
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import CollectionCard from '~/components/collections/CollectionCard.vue'
import type { CollectionSummary } from '~/composables/useCollections'
import { formatDateUtc8 } from '~/utils/timezone'

defineProps<{
  wikidotId: string
  user: any
  stats: any
  statsPending: boolean
  // Collections
  publicCollections: CollectionSummary[]
  publicCollectionsLoading: boolean
  // Rating history
  ratingHistory: any
  ratingHistoryPending: boolean
  // Heatmap
  activityHeatmapRecords: any[]
  activityHeatmapRange: { startIso: string; endIso: string }
  userDailyStatsPending: boolean
  userDailyStatsError: any
  // Follow
  canFollow: boolean
  isFollowingThis: boolean
}>()

defineEmits<{
  'toggle-follow': []
}>()

const categoryView = ref<'list' | 'radar'>('list')

function formatDate(dateStr: string) {
  if (!dateStr) return 'N/A'
  return formatDateUtc8(dateStr, {
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  }) || 'N/A'
}

function formatActivityType(type: string) {
  const typeMap: Record<string, string> = {
    'PAGE_CREATED': '创建页面',
    'PAGE_EDITED': '编辑页面',
    'PAGE_TRANSLATED': '翻译页面',
    'VOTE_CAST': '投票',
    'COMMENT_POSTED': '发表评论',
    'VOTE': '投票',
    'REVISION': '修订',
    'FORUM_POST': '论坛发帖',
    'forum_post': '论坛发帖',
    'attribution': '页面归属',
    'revision': '修订',
    'vote': '投票',
  }
  return typeMap[type] || type
}

function isForumPostActivity(type: string | null | undefined) {
  return String(type || '').toUpperCase() === 'FORUM_POST'
}

function forumPostLink(threadId: number | string | null | undefined, postId: number | string | null | undefined) {
  const tid = Number(threadId)
  if (!Number.isFinite(tid) || tid <= 0) return '/forums'
  const pid = Number(postId)
  if (Number.isFinite(pid) && pid > 0) {
    return `/forums/t/${tid}?postId=${pid}`
  }
  return `/forums/t/${tid}`
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
  }
  return typeMap[type] || type
}
</script>
