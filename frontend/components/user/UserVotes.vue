<template>
  <div class="border border-neutral-200 dark:border-neutral-800 rounded-lg p-6 bg-white dark:bg-neutral-900 shadow-sm">
    <h3 class="text-sm font-semibold text-neutral-700 dark:text-neutral-300 mb-4">最近投票</h3>
    <div v-if="pending" class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
      <div v-for="n in 6" :key="`vote-skeleton-${n}`" class="h-16 rounded bg-neutral-100 animate-pulse dark:bg-neutral-800/70" />
    </div>
    <div v-else-if="votes && votes.length > 0" class="space-y-2">
      <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
        <div v-for="vote in votes" :key="`${vote.timestamp}-${vote.pageWikidotId}`"
             :class="[
               'flex items-center justify-between p-2 rounded',
               vote.direction > 0 ? 'bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800/40' :
               vote.direction < 0 ? 'bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800/40' :
               'bg-neutral-50 dark:bg-neutral-800'
             ]">
          <div class="flex-1 min-w-0">
            <NuxtLink :to="`/page/${vote.pageWikidotId}`" class="text-sm font-medium text-neutral-900 dark:text-neutral-100 hover:text-[var(--g-accent)] truncate block">
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
        <button @click="$emit('prev-page')" :disabled="offset === 0" class="text-xs px-2 py-1 rounded bg-neutral-100 dark:bg-neutral-800 disabled:opacity-50">上一页</button>
        <div class="text-xs text-neutral-500 dark:text-neutral-400">第 {{ pageIndex + 1 }} / {{ totalPages }} 页</div>
        <button @click="$emit('next-page')" :disabled="!hasMore" class="text-xs px-2 py-1 rounded bg-neutral-100 dark:bg-neutral-800 disabled:opacity-50">下一页</button>
      </div>
    </div>
    <div v-else class="text-sm text-neutral-500 dark:text-neutral-400">暂无数据</div>
  </div>
</template>

<script setup lang="ts">
defineProps<{
  votes: any[]
  pending: boolean
  offset: number
  pageIndex: number
  totalPages: number
  hasMore: boolean
}>()

defineEmits<{
  'prev-page': []
  'next-page': []
}>()

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
</script>
