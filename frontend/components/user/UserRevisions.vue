<template>
  <div class="space-y-6">
    <!-- Recent Revisions -->
    <div class="border border-neutral-200 dark:border-neutral-800 rounded-lg p-6 bg-white dark:bg-neutral-900 shadow-sm">
      <h3 class="text-sm font-semibold text-neutral-700 dark:text-neutral-300 mb-4">最近编辑</h3>
      <div v-if="revisionsPending" class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
        <div v-for="n in 6" :key="`revision-skeleton-${n}`" class="h-20 rounded bg-neutral-100 animate-pulse dark:bg-neutral-800/70" />
      </div>
      <div v-else-if="revisions && revisions.length > 0" class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
        <div v-for="revision in revisions" :key="`${revision.timestamp}-${revision.pageWikidotId}`"
             class="p-2 rounded border border-neutral-200 dark:border-neutral-800 hover:bg-neutral-50 dark:hover:bg-neutral-800">
          <div class="flex items-center justify-between gap-2">
            <span :class="['inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-medium shrink-0 w-[120px] justify-center', revisionTypeClass(revision.type)]">
              {{ formatRevisionType(revision.type) }}
            </span>
            <div class="text-xs text-neutral-500 dark:text-neutral-400 whitespace-nowrap shrink-0">{{ formatRelativeTime(revision.timestamp) }}</div>
          </div>
          <NuxtLink :to="`/page/${revision.pageWikidotId}`" class="text-sm font-medium text-neutral-900 dark:text-neutral-100 hover:text-[var(--g-accent)] mt-1 block truncate">
            {{ composeTitle(revision.pageTitle, revision.pageAlternateTitle) || 'Untitled' }}
          </NuxtLink>
          <div v-if="revision.comment" class="text-xs text-neutral-600 dark:text-neutral-400 mt-1 break-words overflow-hidden" style="display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical;">{{ revision.comment }}</div>
        </div>
      </div>
      <div v-else class="text-sm text-neutral-500 dark:text-neutral-400">暂无数据</div>
      <div v-if="!revisionsPending && revisions && revisions.length > 0" class="flex items-center justify-between mt-3">
        <button @click="$emit('prev-rev-page')" :disabled="revOffset === 0" class="text-xs px-2 py-1 rounded bg-neutral-100 dark:bg-neutral-800 disabled:opacity-50">上一页</button>
        <div class="text-xs text-neutral-500 dark:text-neutral-400">第 {{ revPageIndex + 1 }} / {{ revTotalPages }} 页</div>
        <button @click="$emit('next-rev-page')" :disabled="!revHasMore" class="text-xs px-2 py-1 rounded bg-neutral-100 dark:bg-neutral-800 disabled:opacity-50">下一页</button>
      </div>
    </div>

    <!-- Recent Forum Posts -->
    <ClientOnly>
      <div class="border border-neutral-200 dark:border-neutral-800 rounded-lg p-6 bg-white dark:bg-neutral-900 shadow-sm">
        <h3 class="text-sm font-semibold text-neutral-700 dark:text-neutral-300 mb-4">最近论坛发帖</h3>
        <div v-if="forumPostsPending" class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
          <div v-for="n in 6" :key="`forum-skeleton-${n}`" class="h-20 rounded bg-neutral-100 animate-pulse dark:bg-neutral-800/70" />
        </div>
        <div v-else-if="forumPosts && forumPosts.length > 0" class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
          <NuxtLink
            v-for="post in forumPosts"
            :key="post.id"
            :to="`/forums/t/${post.threadId}`"
            class="p-2 rounded border border-neutral-200 dark:border-neutral-800 hover:bg-neutral-50 dark:hover:bg-neutral-800 block"
          >
            <div class="flex items-center justify-between gap-2">
              <span v-if="post.categoryTitle" class="inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-medium shrink-0 bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 max-w-[120px] truncate">{{ post.categoryTitle }}</span>
              <div class="text-xs text-neutral-500 dark:text-neutral-400 whitespace-nowrap shrink-0">{{ formatRelativeTime(String(post.createdAt ?? '')) }}</div>
            </div>
            <div class="text-sm font-medium text-neutral-900 dark:text-neutral-100 mt-1 truncate">{{ post.threadTitle || post.title || '无标题' }}</div>
            <div v-if="post.textHtml" class="text-xs text-neutral-600 dark:text-neutral-400 mt-1 break-words overflow-hidden" style="display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical;" v-html="stripHtml(post.textHtml)"></div>
          </NuxtLink>
        </div>
        <div v-else class="text-sm text-neutral-500 dark:text-neutral-400">暂无论坛发帖</div>
        <div v-if="!forumPostsPending && forumPosts && forumPosts.length > 0" class="flex items-center justify-between mt-3">
          <button @click="$emit('prev-forum-page')" :disabled="forumPostPage === 1" class="text-xs px-2 py-1 rounded bg-neutral-100 dark:bg-neutral-800 disabled:opacity-50">上一页</button>
          <div class="text-xs text-neutral-500 dark:text-neutral-400">第 {{ forumPostPage }} / {{ forumTotalPages }} 页</div>
          <button @click="$emit('next-forum-page')" :disabled="forumPostPage >= forumTotalPages" class="text-xs px-2 py-1 rounded bg-neutral-100 dark:bg-neutral-800 disabled:opacity-50">下一页</button>
        </div>
      </div>
    </ClientOnly>
  </div>
</template>

<script setup lang="ts">
type ForumPostItem = {
  id: number
  title?: string
  textHtml?: string
  createdAt?: string
  threadId: number
  threadTitle?: string
  categoryId?: number
  categoryTitle?: string
  createdByName?: string
}

defineProps<{
  // Revisions
  revisions: any[]
  revisionsPending: boolean
  revOffset: number
  revPageIndex: number
  revTotalPages: number
  revHasMore: boolean
  // Forum Posts
  forumPosts: ForumPostItem[]
  forumPostsPending: boolean
  forumPostPage: number
  forumTotalPages: number
}>()

defineEmits<{
  'prev-rev-page': []
  'next-rev-page': []
  'prev-forum-page': []
  'next-forum-page': []
}>()

function revisionTypeClass(type: string) {
  const t = String(type || '')
  if (t === 'PAGE_CREATED' || t === 'PAGE_RESTORED') {
    return 'bg-[var(--g-accent-soft)] dark:bg-[var(--g-accent-strong)] text-[var(--g-accent)]'
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

function composeTitle(title?: string | null, alternateTitle?: string | null) {
  const base = typeof title === 'string' ? title.trim() : ''
  const alt = typeof alternateTitle === 'string' ? alternateTitle.trim() : ''
  if (alt) return base ? `${base} - ${alt}` : alt
  return base
}

function formatRelativeTime(dateStr: string) {
  if (!dateStr) return ''
  const date = new Date(dateStr)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMin = Math.floor(diffMs / 60000)
  if (diffMin < 60) return `${diffMin} 分钟前`
  const diffH = Math.floor(diffMin / 60)
  if (diffH < 24) return `${diffH} 小时前`
  const diffD = Math.floor(diffH / 24)
  if (diffD < 30) return `${diffD} 天前`
  const diffM = Math.floor(diffD / 30)
  if (diffM < 12) return `${diffM} 个月前`
  return `${Math.floor(diffM / 12)} 年前`
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, '').trim().slice(0, 200)
}
</script>
