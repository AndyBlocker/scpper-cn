<template>
  <section id="votes" class="border border-neutral-200 dark:border-neutral-800 rounded-lg p-4 bg-white dark:bg-neutral-900 shadow-sm min-h-[280px] flex flex-col">
    <div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between mb-4">
      <div class="flex items-center gap-2">
        <h3 class="text-sm font-semibold text-neutral-700 dark:text-neutral-300">最近投票</h3>
        <button
          type="button"
          class="inline-flex h-7 w-7 items-center justify-center rounded-full border border-neutral-200 dark:border-neutral-700 text-neutral-500 hover:text-[var(--g-accent)] hover:border-[var(--g-accent-border)] dark:text-neutral-400 dark:hover:text-[var(--g-accent)]"
          @click="$emit('copy-anchor', 'votes')"
          :title="copiedAnchorId === 'votes' ? '已复制链接' : '复制该段落链接'"
        >
          <LucideIcon v-if="copiedAnchorId === 'votes'" name="Check" class="w-3.5 h-3.5" stroke-width="2" aria-hidden="true" />
          <LucideIcon v-else name="Link" class="w-3.5 h-3.5" stroke-width="2" aria-hidden="true" />
        </button>
      </div>
      <div class="text-xs text-neutral-500 dark:text-neutral-400">{{ currentPage }} / {{ totalPages }}</div>
    </div>

    <div v-if="pending" class="flex-1 flex items-center justify-center text-neutral-500 dark:text-neutral-400">
      正在加载投票记录…
    </div>

    <div v-else-if="error" class="flex-1 flex flex-col items-center justify-center gap-2 text-sm text-neutral-500 dark:text-neutral-400">
      加载投票记录失败。
      <button type="button" class="inline-flex items-center gap-1 text-[var(--g-accent)] hover:underline" @click="$emit('refresh')">重试</button>
    </div>

    <div v-else-if="!votes || votes.length === 0" class="flex-1 flex items-center justify-center text-neutral-500 dark:text-neutral-400">
      暂无投票
    </div>

    <div v-else class="flex-1">
      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-2">
        <div
          v-for="v in votes"
          :key="`${v.timestamp}-${v.userId || v.userWikidotId}`"
          :class="[
            'p-2 rounded',
            v.direction > 0 ? 'bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800/40' :
            v.direction < 0 ? 'bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800/40' :
            'bg-neutral-50 dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-800'
          ]"
        >
          <div class="flex items-center gap-2">
            <div class="min-w-0 flex-1">
              <UserCard
                size="sm"
                :wikidot-id="v.userWikidotId || null"
                :display-name="v.userDisplayName || '(account deleted)'"
                :to="v.userWikidotId ? `/user/${v.userWikidotId}` : null"
                :avatar="true"
                :viewer-vote="viewerLinkedId != null && Number(v.userWikidotId || 0) === viewerLinkedId ? Number(v.direction || 0) : null"
              />
            </div>
            <div class="text-[11px] text-neutral-600 dark:text-neutral-400 whitespace-nowrap shrink-0 tabular-nums">{{ formatDateCompact(v.timestamp) }}</div>
          </div>
        </div>
      </div>

    </div>
    <div v-if="votes && votes.length > 0" class="mt-3">
      <div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <button @click="$emit('prev-page')" :disabled="offset === 0" class="text-xs px-2 py-1 rounded bg-neutral-100 dark:bg-neutral-800 disabled:opacity-50">上一页</button>
        <div class="flex items-center gap-1">
          <button
            v-for="n in pageNumbers"
            :key="`vp-${n}`"
            @click="$emit('go-page', n)"
            :class="['text-xs px-2 py-1 rounded border', (currentPage === n) ? 'bg-neutral-200 dark:bg-neutral-700 border-neutral-300 dark:border-neutral-700' : 'bg-neutral-100 dark:bg-neutral-800 border-neutral-200 dark:border-neutral-800']"
          >{{ n }}</button>
        </div>
        <div class="hidden sm:flex items-center gap-1">
          <input
            :value="jumpPage"
            @input="$emit('update:jump-page', Number(($event.target as HTMLInputElement).value))"
            type="number"
            :min="1"
            :max="totalPages"
            placeholder="页码"
            @keyup.enter="$emit('jump')"
            class="w-16 text-xs px-2 py-1 rounded border border-neutral-300 dark:border-neutral-700 bg-neutral-100 dark:bg-neutral-800"
          />
          <button @click="$emit('jump')" class="text-xs px-2 py-1 rounded bg-neutral-100 dark:bg-neutral-800">跳转</button>
        </div>
        <button @click="$emit('next-page')" :disabled="!hasMore" class="text-xs px-2 py-1 rounded bg-neutral-100 dark:bg-neutral-800 disabled:opacity-50">下一页</button>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { formatDateIsoUtc8 } from '~/utils/timezone'

defineProps<{
  votes: any[] | null
  pending: boolean
  error: any
  offset: number
  currentPage: number
  totalPages: number
  pageNumbers: number[]
  hasMore: boolean
  jumpPage: number | null
  viewerLinkedId: number | null
  copiedAnchorId: string | null
}>()

defineEmits<{
  'copy-anchor': [sectionId: string]
  'refresh': []
  'prev-page': []
  'next-page': []
  'go-page': [n: number]
  'jump': []
  'update:jump-page': [value: number]
}>()

function formatDateCompact(dateStr: string) {
  if (!dateStr) return ''
  return formatDateIsoUtc8(dateStr)
}
</script>
