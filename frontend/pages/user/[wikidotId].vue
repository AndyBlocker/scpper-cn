<template>
  <div>
    <NuxtPage v-if="isCollectionsRoute" />
    <div v-else>
      <div v-if="userPending || statsPending" class="p-8 text-center">
        <div class="inline-flex items-center gap-2">
          <LucideIcon name="Loader2" class="w-5 h-5 animate-spin text-[var(--g-accent)]" stroke-width="2" />
          <span class="text-neutral-600 dark:text-neutral-400">加载中...</span>
        </div>
      </div>
      <div v-else-if="userError" class="p-8 text-center text-red-600 dark:text-red-400">
        加载失败: {{ userError.message }}
      </div>
      <div v-else class="space-y-6">

      <UserHeader
        :wikidot-id="wikidotId"
        :user="user"
        :stats="stats"
        :stats-pending="statsPending"
        :public-collections="publicCollections"
        :public-collections-loading="publicCollectionsLoading"
        :rating-history="ratingHistory"
        :rating-history-pending="ratingHistoryPending"
        :activity-heatmap-records="activityHeatmapRecords"
        :activity-heatmap-range="activityHeatmapRange"
        :user-daily-stats-pending="userDailyStatsPending"
        :user-daily-stats-error="userDailyStatsError"
        :can-follow="canFollow"
        :is-following-this="isFollowingThis"
        @toggle-follow="toggleFollow"
      />

      <UserWorks
        :work-tabs="workTabs"
        :active-tab="activeTab"
        :sort-field="sortField"
        :sort-order="sortOrder"
        :works-pending="worksPending"
        :works="works as any[] | null"
        :displayed-works="displayedWorks"
        :current-tab-label="currentTabLabel"
        :current-page="currentPage"
        :total-pages="totalPages"
        :authors="[{ name: user?.displayName || 'Unknown User', url: `/user/${wikidotId}` }]"
        @update:active-tab="activeTab = $event"
        @update:sort-field="sortField = $event as 'date' | 'rating'"
        @update:sort-order="sortOrder = $event as 'asc' | 'desc'"
        @update:current-page="currentPage = $event"
      />

      <UserPreferences
        :fav-authors="favAuthors"
        :fan-authors="fanAuthors"
        :liker-authors-pending="likerAuthorsPending"
        :fan-authors-pending="fanAuthorsPending"
        :has-more-fav-authors="hasMoreFavAuthors"
        :has-more-fan-authors="hasMoreFanAuthors"
        :pref-authors-offset="prefAuthorsOffset"
        :pref-fans-offset="prefFansOffset"
        :fav-tags="favTags"
        :hate-tags="hateTags"
        :liker-tags-pending="likerTagsPending"
        :hater-tags-pending="haterTagsPending"
        :has-more-fav-tags="hasMoreFavTags"
        :has-more-hate-tags="hasMoreHateTags"
        :pref-fav-tags-offset="prefFavTagsOffset"
        :pref-hate-tags-offset="prefHateTagsOffset"
        @prev-fav-authors="prevFavAuthorsPage"
        @next-fav-authors="nextFavAuthorsPage"
        @prev-fan-authors="prevFanAuthorsPage"
        @next-fan-authors="nextFanAuthorsPage"
        @prev-fav-tags="prevFavTagsPage"
        @next-fav-tags="nextFavTagsPage"
        @prev-hate-tags="prevHateTagsPage"
        @next-hate-tags="nextHateTagsPage"
      />

      <UserVotes
        :votes="recentVotes"
        :pending="userVotesPending"
        :offset="userVoteOffset"
        :page-index="userVotePageIndex"
        :total-pages="userVoteTotalPages"
        :has-more="userHasMoreVotes"
        @prev-page="prevUserVotePage"
        @next-page="nextUserVotePage"
      />

      <UserRevisions
        :revisions="recentRevisions"
        :revisions-pending="userRevisionsPending"
        :rev-offset="userRevOffset"
        :rev-page-index="userRevPageIndex"
        :rev-total-pages="userRevTotalPages"
        :rev-has-more="userHasMoreRevisions"
        :forum-posts="forumPosts"
        :forum-posts-pending="forumPostsPending"
        :forum-post-page="forumPostPage"
        :forum-total-pages="forumTotalPages"
        @prev-rev-page="prevUserRevPage"
        @next-rev-page="nextUserRevPage"
        @prev-forum-page="prevForumPage"
        @next-forum-page="nextForumPage"
      />

      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch, watchEffect } from 'vue'
import { useAsyncData, useHead, useNuxtApp, useRoute, useState } from '#imports'

definePageMeta({ key: route => route.fullPath })
import { useAuth } from '~/composables/useAuth'
import { useFollows } from '~/composables/useFollows'
import { useCollections, type CollectionSummary } from '~/composables/useCollections'
import { useViewerVotes } from '~/composables/useViewerVotes'
import { orderTags } from '~/composables/useTagOrder'
import { formatDateUtc8, formatDateIsoUtc8, startOfUtc8Day, nowUtc8 } from '~/utils/timezone'
import UserHeader from '~/components/user/UserHeader.vue'
import UserWorks from '~/components/user/UserWorks.vue'
import UserPreferences from '~/components/user/UserPreferences.vue'
import UserVotes from '~/components/user/UserVotes.vue'
import UserRevisions from '~/components/user/UserRevisions.vue'

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

const isClient = typeof window !== 'undefined'

// 简易调试开关（可通过 window.__DEV_DEBUG__ = true 打开）
const __DEV_DEBUG__ = isClient && (window as Window & { __DEV_DEBUG__?: boolean }).__DEV_DEBUG__ === true
const route = useRoute();
const isCollectionsRoute = computed(() => route.path.includes('/collections/'));
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
// Responsive items per page for works list
const itemsPerPage = ref(10);
if (isClient) {
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

useHead(() => {
  const title = userPageTitle.value
  const description = user.value?.displayName
    ? `${user.value.displayName} 的用户资料 - 查看作品、投票记录和统计数据`
    : '用户详情'
  return {
    title,
    meta: [
      { name: 'description', content: description, key: 'description' },
      { property: 'og:type', content: 'profile', key: 'og:type' },
      { property: 'og:title', content: title, key: 'og:title' },
      { property: 'og:description', content: description, key: 'og:description' },
      { name: 'twitter:card', content: 'summary', key: 'twitter:card' },
      { name: 'twitter:title', content: title, key: 'twitter:title' },
      { name: 'twitter:description', content: description, key: 'twitter:description' }
    ]
  }
})

// Follow/unfollow state
const { isAuthenticated, user: authUser } = useAuth()
const { fetchFollows, followUser, unfollowUser, isFollowing } = useFollows()
const { fetchPublicCollections } = useCollections()
const publicCollections = ref<CollectionSummary[]>([])
const publicCollectionsLoading = ref(true)
const canFollow = computed(() => isAuthenticated.value && Number(authUser.value?.linkedWikidotId || 0) !== Number(wikidotId.value))
const isFollowingThis = computed(() => isFollowing(Number(wikidotId.value)))

if (isClient) {
  watch(
    [() => isAuthenticated.value, () => authUser.value?.linkedWikidotId],
    async ([loggedIn, linkedId], [prevLoggedIn, prevLinkedId]) => {
      if (loggedIn && linkedId && (prevLoggedIn !== loggedIn || prevLinkedId !== linkedId)) {
        try {
          await fetchFollows()
        } catch (err) {
          console.warn('[user] preload follows failed', err)
        }
      }
    },
    { immediate: true }
  )
}

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

watch(
  () => wikidotId.value,
  async (next) => {
    const id = Number(next)
    if (!Number.isFinite(id) || id <= 0) {
      publicCollections.value = []
      publicCollectionsLoading.value = false
      return
    }
    publicCollectionsLoading.value = true
    try {
      const list = await fetchPublicCollections(id, true)
      publicCollections.value = Array.isArray(list) ? list : []
    } catch (error) {
      console.warn('[user] fetch public collections failed', error)
      publicCollections.value = []
    } finally {
      publicCollectionsLoading.value = false
    }
  },
  { immediate: true }
)

// Relations: authors and tags (liker/hater)
// Preferences pagination state
const prefAuthorsPageSize = ref(5)
const prefAuthorsOffset = ref(0)
const prefFansOffset = ref(0)
const prefTagsPageSize = ref(5)
const prefFavTagsOffset = ref(0)
const prefHateTagsOffset = ref(0)

if (isClient) {
  const computePrefSize = () => (window.innerWidth >= 768 ? 5 : 5)
  const setSizes = () => {
    const size = computePrefSize()
    if (prefAuthorsPageSize.value !== size) {
      prefAuthorsPageSize.value = size
      prefAuthorsOffset.value = 0
      prefFansOffset.value = 0
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

const { data: likerAuthors, pending: likerAuthorsPending } = await useAsyncData(
  () => `user-liker-authors-${wikidotId.value}-${prefAuthorsPageSize.value}-${prefAuthorsOffset.value}`,
  () => $bff(`/users/${wikidotId.value}/relations/users`, { params: { direction: 'targets', polarity: 'liker', limit: prefAuthorsPageSize.value, offset: prefAuthorsOffset.value } }),
  {
    watch: [() => route.params.wikidotId, () => prefAuthorsPageSize.value, () => prefAuthorsOffset.value],
    server: false,
    lazy: true,
    default: () => []
  }
);
const { data: fanAuthorsData, pending: fanAuthorsPending } = await useAsyncData(
  () => `user-fan-authors-${wikidotId.value}-${prefAuthorsPageSize.value}-${prefFansOffset.value}`,
  () => $bff(`/users/${wikidotId.value}/relations/users`, { params: { direction: 'sources', polarity: 'liker', limit: prefAuthorsPageSize.value, offset: prefFansOffset.value } }),
  {
    watch: [() => route.params.wikidotId, () => prefAuthorsPageSize.value, () => prefFansOffset.value],
    server: false,
    lazy: true,
    default: () => []
  }
);
const { data: likerTags, pending: likerTagsPending } = await useAsyncData(
  () => `user-liker-tags-${wikidotId.value}-${prefTagsPageSize.value}-${prefFavTagsOffset.value}`,
  () => $bff(`/users/${wikidotId.value}/relations/tags`, { params: { polarity: 'liker', limit: prefTagsPageSize.value, offset: prefFavTagsOffset.value } }),
  {
    watch: [() => route.params.wikidotId, () => prefTagsPageSize.value, () => prefFavTagsOffset.value],
    server: false,
    lazy: true,
    default: () => []
  }
);
const { data: haterTags, pending: haterTagsPending } = await useAsyncData(
  () => `user-hater-tags-${wikidotId.value}-${prefTagsPageSize.value}-${prefHateTagsOffset.value}`,
  () => $bff(`/users/${wikidotId.value}/relations/tags`, { params: { polarity: 'hater', limit: prefTagsPageSize.value, offset: prefHateTagsOffset.value } }),
  {
    watch: [() => route.params.wikidotId, () => prefTagsPageSize.value, () => prefHateTagsOffset.value],
    server: false,
    lazy: true,
    default: () => []
  }
);

// Picks for UI (page by API sorting); filter out '原创'
const favAuthors = computed(() => (Array.isArray(likerAuthors.value) ? likerAuthors.value : []))
const fanAuthors = computed(() => (Array.isArray(fanAuthorsData.value) ? fanAuthorsData.value : []))
const favTags = computed(() => (Array.isArray(likerTags.value) ? likerTags.value.filter((t:any)=> t && t.tag !== '原创').map((t:any)=>({ tag: t.tag, uv: Number(t.uv||t.upvoteCount||0), dv: Number(t.dv||t.downvoteCount||0) })) : []))
const hateTags = computed(() => (Array.isArray(haterTags.value) ? haterTags.value.filter((t:any)=> t && t.tag !== '原创').map((t:any)=>({ tag: t.tag, uv: Number(t.uv||t.upvoteCount||0), dv: Number(t.dv||t.downvoteCount||0) })) : []))

// Has more flags & pager actions
const hasMoreFavAuthors = computed(() => {
  const size = Number(prefAuthorsPageSize.value || 0)
  if (!size) return false
  if (prefAuthorsOffset.value >= size) return false
  return Array.isArray(likerAuthors.value) && likerAuthors.value.length === size
})
const hasMoreFanAuthors = computed(() => {
  const size = Number(prefAuthorsPageSize.value || 0)
  if (!size) return false
  if (prefFansOffset.value >= size) return false
  return Array.isArray(fanAuthorsData.value) && fanAuthorsData.value.length === size
})
function nextFavAuthorsPage(){
  const size = Number(prefAuthorsPageSize.value || 0)
  if (!size || !hasMoreFavAuthors.value) return
  prefAuthorsOffset.value = Math.min(size, prefAuthorsOffset.value + size)
}
function prevFavAuthorsPage(){ prefAuthorsOffset.value = Math.max(0, prefAuthorsOffset.value - prefAuthorsPageSize.value) }
function nextFanAuthorsPage(){
  const size = Number(prefAuthorsPageSize.value || 0)
  if (!size || !hasMoreFanAuthors.value) return
  prefFansOffset.value = Math.min(size, prefFansOffset.value + size)
}
function prevFanAuthorsPage(){ prefFansOffset.value = Math.max(0, prefFansOffset.value - prefAuthorsPageSize.value) }

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
  {
    watch: [() => route.params.wikidotId],
    server: false,
    lazy: true,
    default: () => null
  }
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
  {
    watch: [() => route.params.wikidotId, activeTab, () => sortField.value, () => sortOrder.value, () => currentPage.value, () => itemsPerPage.value],
    server: false,
    lazy: true,
    default: () => []
  }
);

// Fetch recent votes with pagination (responsive page size)
const userVotePageSize = ref(10)
if (isClient) {
  const computeVotePageSize = () => {
    const width = window.innerWidth
    if (width >= 1024) return 12
    if (width >= 768) return 10
    return 12
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
const { data: userVotesPage, pending: userVotesPending } = await useAsyncData(
  () => `user-votes-${wikidotId.value}-${userVoteOffset.value}-${userVotePageSize.value}`,
  () => $bff(`/users/${wikidotId.value}/votes`, { params: { limit: userVotePageSize.value, offset: userVoteOffset.value } }),
  {
    watch: [() => route.params.wikidotId, () => userVoteOffset.value, () => userVotePageSize.value],
    server: false,
    lazy: true,
    default: () => ({ items: [], total: 0, limit: userVotePageSize.value, offset: userVoteOffset.value })
  }
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
const userVotePageIndex = computed(() => {
  const size = Number(userVotePageSize.value || 0)
  if (!size) return 0
  return Math.floor(userVoteOffset.value / size)
})
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
if (isClient) {
  const computeRevPageSize = () => {
    const width = window.innerWidth
    if (width >= 1024) return 12
    if (width >= 768) return 10
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
const { data: userRevisionsPage, pending: userRevisionsPending } = await useAsyncData(
  () => `user-revisions-${wikidotId.value}-${userRevOffset.value}-${userRevPageSize.value}`,
  () => $bff(`/users/${wikidotId.value}/revisions`, { params: { limit: userRevPageSize.value, offset: userRevOffset.value } }),
  {
    watch: [() => route.params.wikidotId, () => userRevOffset.value, () => userRevPageSize.value],
    server: false,
    lazy: true,
    default: () => ({ items: [], total: 0, limit: userRevPageSize.value, offset: userRevOffset.value })
  }
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
const userRevPageIndex = computed(() => {
  const size = Number(userRevPageSize.value || 0)
  if (!size) return 0
  return Math.floor(userRevOffset.value / size)
})
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

// Forum posts
const forumPostPage = ref(1)
const forumPostPageSize = 9
type ForumPostItem = { id: number; title?: string; textHtml?: string; createdAt?: string; threadId: number; threadTitle?: string; categoryId?: number; categoryTitle?: string; createdByName?: string }
const { data: rawForumPosts, pending: forumPostsPending } = await useAsyncData(
  () => `user-forum-posts-${wikidotId.value}-${forumPostPage.value}`,
  () => $bff(`/forums/users/${wikidotId.value}/posts`, {
    params: { page: forumPostPage.value, limit: forumPostPageSize }
  }),
  {
    watch: [() => wikidotId.value, forumPostPage],
    server: false,
    lazy: true,
    default: () => ({ posts: [], total: 0, page: 1, limit: forumPostPageSize })
  }
)
const forumPosts = computed<ForumPostItem[]>(() => {
  const val = rawForumPosts.value as any
  return Array.isArray(val?.posts) ? val.posts : []
})
const forumTotalPages = computed(() => {
  const val = rawForumPosts.value as any
  const total = Number(val?.total || 0)
  return Math.max(1, Math.ceil(total / forumPostPageSize))
})
function prevForumPage() { if (forumPostPage.value > 1) forumPostPage.value-- }
function nextForumPage() { if (forumPostPage.value < forumTotalPages.value) forumPostPage.value++ }

// Fetch rating history
const { data: ratingHistory, pending: ratingHistoryPending } = await useAsyncData(
  () => `user-rating-history-${wikidotId.value}`,
  () => $bff(`/users/${wikidotId.value}/rating-history`, {
    params: {
      granularity: 'week'
    }
  }),
  {
    watch: [() => route.params.wikidotId],
    server: false,
    lazy: true,
    default: () => []
  }
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
  {
    watch: [() => user.value?.id, () => activityHeatmapRange.value.startIso, () => activityHeatmapRange.value.endIso],
    server: false,
    lazy: true,
    default: () => []
  }
);

const activityHeatmapRecords = computed<UserDailyStatRecord[]>(() => {
  if (!Array.isArray(userDailyStats.value)) return [];
  return (userDailyStats.value as UserDailyStatRecord[]).map((record) => ({
    ...record,
    revisions: typeof record.revisions === 'number' ? record.revisions : Number(record.revisions ?? 0)
  }));
});

// Precise tab counts from BFF (fallback to local if unavailable)
const { data: tabCounts, pending: tabCountsPending } = await useAsyncData(
  () => `user-tab-counts-${wikidotId.value}`,
  () => $bff(`/users/${wikidotId.value}/page-counts`, { params: { includeDeleted: 'true' } }),
  {
    watch: [() => route.params.wikidotId],
    server: false,
    lazy: true,
    default: () => ({ total: 0, original: 0, translation: 0, shortStories: 0, anomalousLog: 0, other: 0 })
  }
);

// Works helpers and tag-based filters
const allWorks = computed(() => Array.isArray(works.value) ? (works.value as any[]) : ([] as any[]))

function hasTag(work: any, tag: string): boolean {
  return Array.isArray(work?.tags) && work.tags.includes(tag)
}

const hasGroup = (w: any, key: string) => (w && typeof w.groupKey === 'string' && w.groupKey === key)
const isOriginal = (w: any) => hasGroup(w, 'author') || hasTag(w, '原创')
const isAuthorPage = (w: any) => hasTag(w, '作者')
const isCoverPage = (w: any) => hasTag(w, '掩盖页')
const isParagraph = (w: any) => hasTag(w, '段落')
const isShortStories = (w: any) => hasGroup(w, 'short_stories') || (w?.category === 'short-stories')
const isAnomalousLog = (w: any) => hasGroup(w, 'anomalous_log') || (w?.category === 'log-of-anomalous-items-cn')

const filterOriginal = (w: any) => isOriginal(w) && !isCoverPage(w) && !isParagraph(w) && !isShortStories(w) && !isAnomalousLog(w)
const filterTranslation = (w: any) => hasGroup(w, 'translator') || (!isOriginal(w) && !isAuthorPage(w) && !isCoverPage(w) && !isParagraph(w) && !isShortStories(w) && !isAnomalousLog(w))
const filterOther = (w: any) => hasGroup(w, 'other') || ((isAuthorPage(w) || isCoverPage(w) || isParagraph(w)) && !isShortStories(w) && !isAnomalousLog(w))

const shortStoriesCount = computed(() => {
  if (tabCounts.value && typeof tabCounts.value.shortStories === 'number') return tabCounts.value.shortStories
  return allWorks.value.filter(isShortStories).length
})
const anomalousLogCount = computed(() => {
  if (tabCounts.value && typeof tabCounts.value.anomalousLog === 'number') return tabCounts.value.anomalousLog
  return allWorks.value.filter(isAnomalousLog).length
})

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
  return tabs.filter(t => t.key === 'all' || (t.count || 0) > 0)
})

const currentTabLabel = computed(() => {
  const tab = workTabs.value.find(t => t.key === activeTab.value);
  return tab ? tab.label : '作品';
});

const activeTabTotalCount = computed(() => {
  const counts = tabCounts.value as Record<string, unknown> | null;
  const fallback = Array.isArray(filteredWorks.value) ? filteredWorks.value.length : 0;
  if (!counts) return fallback;

  const pick = (key: string): number | null => {
    const raw = counts?.[key];
    if (typeof raw === 'number') return raw;
    if (typeof raw === 'string' && raw.trim() !== '') {
      const parsed = Number(raw);
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  };

  switch (activeTab.value) {
    case 'AUTHOR':
      return pick('original') ?? fallback;
    case 'TRANSLATOR':
      return pick('translation') ?? fallback;
    case 'SHORT_STORIES':
      return pick('shortStories') ?? fallback;
    case 'ANOMALOUS_LOG':
      return pick('anomalousLog') ?? fallback;
    case 'OTHER':
      return pick('other') ?? fallback;
    default:
      return pick('total') ?? fallback;
  }
});

const filteredWorks = computed(() => {
  const all = allWorks.value
  if (activeTab.value === 'AUTHOR') return all.filter(filterOriginal)
  if (activeTab.value === 'TRANSLATOR') return all.filter(filterTranslation)
  if (activeTab.value === 'SHORT_STORIES') return all.filter(isShortStories)
  if (activeTab.value === 'ANOMALOUS_LOG') return all.filter(isAnomalousLog)
  if (activeTab.value === 'OTHER') return all.filter(filterOther)
  return all
});

const sortedWorks = computed(() => filteredWorks.value)

watch([sortField, sortOrder], () => { currentPage.value = 1 })

const displayedWorks = computed(() => sortedWorks.value.map(normalizeWork));

watch(
  () => works.value,
  (newWorks) => {
    if (!isClient) return
    if (!Array.isArray(newWorks) || newWorks.length === 0) return
    void hydrateViewerVotes(newWorks as any[])
  },
  { immediate: true, flush: 'post' }
)

const totalPages = computed(() => {
  const size = Math.max(1, Number(itemsPerPage.value || 1));
  const total = Number(activeTabTotalCount.value || 0);
  if (!Number.isFinite(total) || total <= 0) return 1;
  return Math.max(1, Math.ceil(total / size));
});

watch(activeTab, () => { currentPage.value = 1; });

watch(totalPages, (nextTotal) => {
  if (!Number.isFinite(nextTotal) || nextTotal <= 0) {
    currentPage.value = 1;
    return;
  }
  if (currentPage.value > nextTotal) {
    currentPage.value = nextTotal;
  }
});

watch(workTabs, (tabs) => {
  const exists = tabs.some(t => t.key === activeTab.value)
  if (!exists) activeTab.value = 'all'
})

// Helper functions
function computeHeatmapFetchRange(): HeatmapRange {
  const end = startOfUtc8Day(nowUtc8());
  if (!end) {
    const iso = formatDateIsoUtc8(new Date());
    return { startIso: iso, endIso: iso };
  }
  const start = new Date(end.getTime() - 364 * 86400000);
  return {
    startIso: formatDateIsoUtc8(start),
    endIso: formatDateIsoUtc8(end)
  };
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
    createdDate: work.createdAt ? formatDateIsoUtc8(work.createdAt) : undefined
  }
}
</script>
