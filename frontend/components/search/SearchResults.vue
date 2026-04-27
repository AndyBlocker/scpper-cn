<template>
  <div v-if="searchPerformed">
    <div v-if="initialLoading" class="text-sm text-neutral-600 dark:text-neutral-400">搜索中…</div>
    <div v-else-if="error" class="text-sm text-red-600 dark:text-red-400">搜索失败，请稍后重试</div>
    <div v-else>
      <div class="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div v-if="scope === 'forums'" class="text-sm text-neutral-600 dark:text-neutral-400">
          找到讨论区帖子 <span class="font-semibold text-[var(--g-accent)]">{{ totalForums }}</span>
        </div>
        <div v-else class="text-sm text-neutral-600 dark:text-neutral-400">
          找到用户 <span class="font-semibold text-[var(--g-accent)]">{{ totalUsers }}</span>
          ，页面 <span class="font-semibold text-[var(--g-accent)]">{{ totalPages }}</span>
        </div>
        <button
          v-if="canExportCsv"
          type="button"
          class="inline-flex h-8 items-center gap-1.5 rounded-full border border-neutral-200 bg-white/80 px-3 text-xs font-medium text-neutral-600 transition hover:border-[var(--g-accent-border)] hover:text-[var(--g-accent)] disabled:cursor-not-allowed disabled:opacity-60 dark:border-neutral-700 dark:bg-neutral-900/70 dark:text-neutral-300"
          :disabled="csvExporting"
          :aria-busy="csvExporting ? 'true' : 'false'"
          @click="$emit('export-csv')"
        >
          <LucideIcon :name="csvExporting ? 'Loader2' : 'Download'" :class="['h-3.5 w-3.5', csvExporting ? 'animate-spin' : '']" />
          <span>{{ csvExporting ? '导出中...' : '导出 CSV' }}</span>
        </button>
      </div>
      <p v-if="csvExportError" class="-mt-2 mb-4 text-xs text-red-600 dark:text-red-400">{{ csvExportError }}</p>

      <div class="space-y-8">
        <!-- Users -->
        <section v-if="(scope==='both' || scope==='users') && (totalUsers > 0 || usersLoading)" class="space-y-3">
          <div class="flex items-center justify-between">
            <div class="text-xs font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">用户</div>
            <div class="text-[11px] text-neutral-400 dark:text-neutral-500">共 {{ totalUsers }}</div>
          </div>
          <div v-if="usersLoading && userResults.length === 0" class="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
            <div v-for="i in 6" :key="`user-skel-${i}`" class="h-24 rounded-lg border border-neutral-200 bg-neutral-100/70 animate-pulse dark:border-neutral-800 dark:bg-neutral-800/40"></div>
          </div>
          <div v-else-if="userResults.length === 0" class="rounded-lg border border-dashed border-neutral-300 bg-neutral-50/80 px-4 py-6 text-sm text-neutral-500 dark:border-neutral-800 dark:bg-neutral-900/70 dark:text-neutral-300">
            暂无用户符合条件。
          </div>
          <div v-else class="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
            <UserCard
              v-for="u in userResults"
              :key="u.wikidotId || u.id"
              size="md"
              :wikidot-id="u.wikidotId"
              :display-name="u.displayName"
              :rank="u.rank"
              :totals="{ totalRating: u.totalRating, works: u.pageCount }"
            />
          </div>
          <div v-if="userLoadingMore" class="flex items-center justify-center text-xs text-neutral-500 dark:text-neutral-400">
            正在载入更多用户…
          </div>
          <div v-else-if="userHasMore" class="flex flex-col items-center gap-2">
            <button
              type="button"
              class="rounded-full border border-neutral-200 bg-white/80 px-3 py-1.5 text-xs font-medium text-neutral-600 hover:border-[var(--g-accent-border)] hover:text-[var(--g-accent)] dark:border-neutral-700 dark:bg-neutral-900/70 dark:text-neutral-300"
              @click="$emit('load-more-users')"
            >加载更多用户</button>
            <div ref="userSentinelRef" class="h-1 w-full"></div>
          </div>
        </section>

        <!-- Pages -->
        <section v-if="(scope==='both' || scope==='pages')" class="space-y-4">
          <div class="flex items-center justify-between">
            <div class="text-xs font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">页面</div>
            <div class="text-[11px] text-neutral-400 dark:text-neutral-500">共 {{ totalPages }}</div>
          </div>
          <div v-if="pagesLoading && pageResults.length === 0" class="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
            <div v-for="i in 6" :key="`page-skel-${i}`" class="h-48 rounded-lg border border-neutral-200 bg-neutral-100/70 animate-pulse dark:border-neutral-800 dark:bg-neutral-800/40"></div>
          </div>
          <div v-else-if="pageResults.length === 0" class="rounded-lg border border-dashed border-neutral-300 bg-neutral-50/80 px-4 py-6 text-sm text-neutral-500 dark:border-neutral-800 dark:bg-neutral-900/70 dark:text-neutral-300">
            暂无页面符合条件。
          </div>
          <div v-else>
            <div class="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
              <PageCard size="md" v-for="p in pageResults" :key="p.wikidotId || p.id" :p="p" />
            </div>
          </div>
          <div v-if="pageLoadingMore" class="flex items-center justify-center text-xs text-neutral-500 dark:text-neutral-400">
            正在载入更多页面…
          </div>
          <div v-else-if="pageHasMore" class="flex flex-col items-center gap-2">
            <button
              type="button"
              class="rounded-full border border-neutral-200 bg-white/80 px-3 py-1.5 text-xs font-medium text-neutral-600 hover:border-[var(--g-accent-border)] hover:text-[var(--g-accent)] dark:border-neutral-700 dark:bg-neutral-900/70 dark:text-neutral-300"
              @click="$emit('load-more-pages')"
            >加载更多页面</button>
            <div ref="pageSentinelRef" class="h-1 w-full"></div>
          </div>
          <div v-else>
            <div ref="pageSentinelRef" class="h-0 w-full"></div>
          </div>
        </section>

        <!-- Forums -->
        <section v-if="scope==='forums'" class="space-y-4">
          <div class="flex items-center justify-between">
            <div class="text-xs font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">讨论区</div>
            <div class="text-[11px] text-neutral-400 dark:text-neutral-500">共 {{ totalForums }}</div>
          </div>
          <div v-if="forumsLoading && forumResults.length === 0" class="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
            <div v-for="i in 6" :key="`forum-skel-${i}`" class="h-36 rounded-lg border border-neutral-200 bg-neutral-100/70 animate-pulse dark:border-neutral-800 dark:bg-neutral-800/40"></div>
          </div>
          <div v-else-if="forumResults.length === 0" class="rounded-lg border border-dashed border-neutral-300 bg-neutral-50/80 px-4 py-6 text-sm text-neutral-500 dark:border-neutral-800 dark:bg-neutral-900/70 dark:text-neutral-300">
            暂无讨论区帖子符合条件。
          </div>
          <div v-else class="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
            <NuxtLink
              v-for="post in forumResults"
              :key="post.postId || `${post.threadId}-${post.createdAt}`"
              :to="forumPostLink(post)"
              class="block rounded-lg border border-neutral-200 bg-white p-4 shadow-sm transition hover:border-[var(--g-accent-border)] hover:shadow-md dark:border-neutral-800 dark:bg-neutral-900 dark:hover:border-neutral-700"
            >
              <div class="flex items-start gap-3">
                <UserAvatar
                  v-if="post.createdByWikidotId"
                  :wikidot-id="post.createdByWikidotId"
                  :name="post.createdByName"
                  :size="32"
                  class="shrink-0 mt-0.5"
                />
                <div class="min-w-0 flex-1 space-y-1.5">
                  <h3 class="text-sm font-semibold text-neutral-800 dark:text-neutral-100 line-clamp-1">
                    {{ post.title || post.threadTitle || '(无标题)' }}
                  </h3>
                  <div v-if="post.categoryTitle || post.threadTitle" class="text-xs text-neutral-500 dark:text-neutral-400 line-clamp-1">
                    <span v-if="post.categoryTitle">{{ post.categoryTitle }}</span>
                    <span v-if="post.categoryTitle && post.threadTitle"> > </span>
                    <span v-if="post.threadTitle">{{ post.threadTitle }}</span>
                  </div>
                  <p class="text-xs text-neutral-600 dark:text-neutral-300 line-clamp-2" v-html="highlightForumSnippet(post.textHtml, searchQuery)"></p>
                  <div class="flex items-center gap-2 text-[11px] text-neutral-400 dark:text-neutral-500">
                    <span v-if="post.createdByName" class="font-medium text-neutral-500 dark:text-neutral-400">{{ post.createdByName }}</span>
                    <span v-if="post.createdAt">{{ formatForumDate(post.createdAt) }}</span>
                  </div>
                </div>
              </div>
            </NuxtLink>
          </div>
          <div v-if="forumLoadingMore" class="flex items-center justify-center text-xs text-neutral-500 dark:text-neutral-400">
            正在载入更多帖子…
          </div>
          <div v-else-if="forumHasMore" class="flex flex-col items-center gap-2">
            <button
              type="button"
              class="rounded-full border border-neutral-200 bg-white/80 px-3 py-1.5 text-xs font-medium text-neutral-600 hover:border-[var(--g-accent-border)] hover:text-[var(--g-accent)] dark:border-neutral-700 dark:bg-neutral-900/70 dark:text-neutral-300"
              @click="$emit('load-more-forums')"
            >加载更多帖子</button>
            <div ref="forumSentinelRef" class="h-1 w-full"></div>
          </div>
        </section>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch, onMounted, onBeforeUnmount } from 'vue'
import LucideIcon from '~/components/LucideIcon.vue'
import UserAvatar from '~/components/UserAvatar.vue'

const props = defineProps<{
  searchPerformed: boolean
  initialLoading: boolean
  error: boolean
  scope: 'both' | 'users' | 'pages' | 'forums'
  searchQuery: string
  userResults: any[]
  pageResults: any[]
  forumResults: any[]
  totalUsers: number
  totalPages: number
  totalForums: number
  usersLoading: boolean
  pagesLoading: boolean
  forumsLoading: boolean
  userLoadingMore: boolean
  pageLoadingMore: boolean
  forumLoadingMore: boolean
  userHasMore: boolean
  pageHasMore: boolean
  forumHasMore: boolean
  csvExporting?: boolean
  csvExportError?: string
}>()

const emit = defineEmits<{
  'load-more-users': []
  'load-more-pages': []
  'load-more-forums': []
  'export-csv': []
}>()

const pageSentinelRef = ref<HTMLElement | null>(null)
const userSentinelRef = ref<HTMLElement | null>(null)
const forumSentinelRef = ref<HTMLElement | null>(null)

let pageObserver: IntersectionObserver | null = null
let userObserver: IntersectionObserver | null = null
let forumObserver: IntersectionObserver | null = null
const isClient = typeof window !== 'undefined'
const canExportCsv = computed(() => (
  props.scope === 'forums' ? props.totalForums > 0
    : props.scope === 'users' ? props.totalUsers > 0
      : props.scope === 'pages' ? props.totalPages > 0
        : (props.totalUsers + props.totalPages) > 0
))

defineExpose({ pageSentinelRef, userSentinelRef, forumSentinelRef })

function forumPostLink(post: any): string {
  const threadId = Number(post?.threadId)
  if (!Number.isInteger(threadId) || threadId <= 0) {
    return '/forums'
  }
  const postId = Number(post?.postId ?? post?.id)
  if (Number.isInteger(postId) && postId > 0) {
    return `/forums/t/${threadId}?postId=${postId}`
  }
  return `/forums/t/${threadId}`
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function stripHtml(html: string | null | undefined): string {
  if (!html) return ''
  return html.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&[a-zA-Z]+;/g, ' ').replace(/\s+/g, ' ').trim()
}

function highlightForumSnippet(html: string | null | undefined, query: string): string {
  const text = stripHtml(html)
  if (!text) return ''

  const q = query.trim()
  if (!q) return escapeHtml(text.slice(0, 200)) + (text.length > 200 ? '...' : '')

  const lowerText = text.toLowerCase()
  const lowerQ = q.toLowerCase()
  const firstIdx = lowerText.indexOf(lowerQ)

  if (firstIdx === -1) {
    return escapeHtml(text.slice(0, 200)) + (text.length > 200 ? '...' : '')
  }

  const prefixLen = Math.min(firstIdx, 5)
  const start = firstIdx - prefixLen
  const snippetLen = 200
  const end = Math.min(text.length, start + snippetLen)
  const snippet = text.slice(start, end)

  const lowerSnippet = snippet.toLowerCase()
  let result = ''
  let pos = 0
  while (pos < snippet.length) {
    const matchPos = lowerSnippet.indexOf(lowerQ, pos)
    if (matchPos === -1) {
      result += escapeHtml(snippet.slice(pos))
      break
    }
    result += escapeHtml(snippet.slice(pos, matchPos))
    result += `<span class="keyword">${escapeHtml(snippet.slice(matchPos, matchPos + q.length))}</span>`
    pos = matchPos + q.length
  }

  if (start > 0) result = '...' + result
  if (end < text.length) result += '...'

  return result
}

function formatForumDate(dateStr: string | null | undefined): string {
  if (!dateStr) return ''
  const d = new Date(dateStr)
  if (isNaN(d.getTime())) return ''
  return d.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' })
}

function setupPageObserver() {
  if (!isClient || typeof IntersectionObserver === 'undefined') return
  if (pageObserver) pageObserver.disconnect()
  pageObserver = new IntersectionObserver((entries) => {
    if (entries.some(entry => entry.isIntersecting)) {
      emit('load-more-pages')
    }
  }, { rootMargin: '320px 0px' })
  if (pageSentinelRef.value) pageObserver.observe(pageSentinelRef.value)
}

function setupUserObserver() {
  if (!isClient || typeof IntersectionObserver === 'undefined') return
  if (userObserver) userObserver.disconnect()
  userObserver = new IntersectionObserver((entries) => {
    if (entries.some(entry => entry.isIntersecting)) {
      emit('load-more-users')
    }
  }, { rootMargin: '320px 0px' })
  if (userSentinelRef.value) userObserver.observe(userSentinelRef.value)
}

function setupForumObserver() {
  if (!isClient || typeof IntersectionObserver === 'undefined') return
  if (forumObserver) forumObserver.disconnect()
  forumObserver = new IntersectionObserver((entries) => {
    if (entries.some(entry => entry.isIntersecting)) {
      emit('load-more-forums')
    }
  }, { rootMargin: '320px 0px' })
  if (forumSentinelRef.value) forumObserver.observe(forumSentinelRef.value)
}

watch(pageSentinelRef, (newEl, oldEl) => {
  if (!isClient || !pageObserver) return
  if (oldEl) pageObserver.unobserve(oldEl)
  if (newEl) pageObserver.observe(newEl)
})

watch(userSentinelRef, (newEl, oldEl) => {
  if (!isClient || !userObserver) return
  if (oldEl) userObserver.unobserve(oldEl)
  if (newEl) userObserver.observe(newEl)
})

watch(forumSentinelRef, (newEl, oldEl) => {
  if (!isClient || !forumObserver) return
  if (oldEl) forumObserver.unobserve(oldEl)
  if (newEl) forumObserver.observe(newEl)
})

onMounted(() => {
  setupPageObserver()
  setupUserObserver()
  setupForumObserver()
})

onBeforeUnmount(() => {
  if (pageObserver) { pageObserver.disconnect(); pageObserver = null }
  if (userObserver) { userObserver.disconnect(); userObserver = null }
  if (forumObserver) { forumObserver.disconnect(); forumObserver = null }
})
</script>
