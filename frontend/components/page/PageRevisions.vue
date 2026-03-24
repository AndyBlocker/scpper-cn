<template>
  <section id="revisions" class="border border-neutral-200 dark:border-neutral-800 rounded-lg p-4 bg-white dark:bg-neutral-900 shadow-sm min-h-[280px] flex flex-col">
    <div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between mb-4">
      <div class="flex items-center gap-2">
        <h3 class="text-sm font-semibold text-neutral-700 dark:text-neutral-300">最近修订</h3>
        <button
          type="button"
          class="inline-flex h-7 w-7 items-center justify-center rounded-full border border-neutral-200 dark:border-neutral-700 text-neutral-500 hover:text-[var(--g-accent)] hover:border-[var(--g-accent-border)] dark:text-neutral-400 dark:hover:text-[var(--g-accent)]"
          @click="$emit('copy-anchor', 'revisions')"
          :title="copiedAnchorId === 'revisions' ? '已复制链接' : '复制该段落链接'"
        >
          <LucideIcon v-if="copiedAnchorId === 'revisions'" name="Check" class="w-3.5 h-3.5" stroke-width="2" aria-hidden="true" />
          <LucideIcon v-else name="Link" class="w-3.5 h-3.5" stroke-width="2" aria-hidden="true" />
        </button>
      </div>
      <div class="text-xs text-neutral-500 dark:text-neutral-400">{{ (revPage + 1) }} / {{ revTotalPages }}</div>
    </div>

    <div v-if="pending" class="flex-1 flex items-center justify-center text-neutral-500 dark:text-neutral-400">
      正在加载修订记录…
    </div>

    <div v-else-if="error" class="flex-1 flex flex-col items-center justify-center gap-2 text-sm text-neutral-500 dark:text-neutral-400">
      加载修订记录失败。
      <button type="button" class="inline-flex items-center gap-1 text-[var(--g-accent)] hover:underline" @click="$emit('refresh')">重试</button>
    </div>

    <div v-else-if="!revisions || revisions.length === 0" class="flex-1 flex items-center justify-center text-neutral-500 dark:text-neutral-400">
      暂无修订记录
    </div>

    <div v-else class="flex-1">
      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
        <div
          v-for="rev in revisions"
          :key="rev.revisionId || rev.wikidotId"
          class="p-2 rounded border border-neutral-200 dark:border-neutral-800 hover:bg-neutral-50 dark:hover:bg-neutral-800"
        >
          <div class="flex items-center justify-between gap-3">
            <div class="flex items-center gap-2 min-w-0">
              <span :class="['inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-medium shrink-0 w-[120px] justify-center', revisionTypeClass(rev.type)]">
                {{ formatRevisionType(rev.type) }}
              </span>
              <div class="min-w-0">
                <UserCard
                  size="sm"
                  :wikidot-id="rev.userWikidotId || null"
                  :display-name="rev.userDisplayName || '(account deleted)'"
                  :to="rev.userWikidotId ? `/user/${rev.userWikidotId}` : null"
                  :avatar="true"
                />
              </div>
            </div>
            <div class="text-xs text-neutral-500 dark:text-neutral-400 whitespace-nowrap shrink-0">{{ formatRelativeTime(rev.timestamp) }}</div>
          </div>
          <div v-if="rev.comment" class="text-xs text-neutral-600 dark:text-neutral-400 mt-1 break-words overflow-hidden" style="display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical;">{{ rev.comment }}</div>
        </div>
      </div>

    </div>
    <div v-if="revisions && revisions.length > 0" class="mt-3">
      <div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <button @click="$emit('prev-page')" :disabled="revPage === 0"
                class="text-xs px-2 py-1 rounded bg-neutral-100 dark:bg-neutral-800 disabled:opacity-50">上一页</button>
        <div class="flex items-center gap-1">
          <button
            v-for="n in revPageNumbers"
            :key="`rp-${n}`"
            @click="$emit('go-page', n)"
            :class="['text-xs px-2 py-1 rounded border', (revPage + 1 === n) ? 'bg-neutral-200 dark:bg-neutral-700 border-neutral-300 dark:border-neutral-700' : 'bg-neutral-100 dark:bg-neutral-800 border-neutral-200 dark:border-neutral-800']"
          >{{ n }}</button>
        </div>
        <div class="hidden sm:flex items-center gap-1">
          <input
            :value="jumpPage"
            @input="emitJumpPage($event)"
            type="number"
            :min="1"
            :max="revTotalPages"
            placeholder="页码"
            @keyup.enter="$emit('jump')"
            class="w-16 text-xs px-2 py-1 rounded border border-neutral-300 dark:border-neutral-700 bg-neutral-100 dark:bg-neutral-800"
          />
          <button @click="$emit('jump')" class="text-xs px-2 py-1 rounded bg-neutral-100 dark:bg-neutral-800">跳转</button>
        </div>
        <button @click="$emit('next-page')" :disabled="!hasMore"
                class="text-xs px-2 py-1 rounded bg-neutral-100 dark:bg-neutral-800 disabled:opacity-50">下一页</button>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { formatDateUtc8 } from '~/utils/timezone'

defineProps<{
  revisions: any[] | null
  pending: boolean
  error: any
  revPage: number
  revTotalPages: number
  revPageNumbers: number[]
  hasMore: boolean
  jumpPage: number | null
  copiedAnchorId: string | null
}>()

const emit = defineEmits<{
  'copy-anchor': [sectionId: string]
  'refresh': []
  'prev-page': []
  'next-page': []
  'go-page': [n: number]
  'jump': []
  'update:jump-page': [value: number | null]
}>()

function emitJumpPage(event: Event) {
  const raw = (event.target as HTMLInputElement).value
  if (raw === '') {
    emit('update:jump-page', null)
  } else {
    const num = Number(raw)
    if (Number.isFinite(num)) emit('update:jump-page', num)
  }
}

function formatRevisionType(type: string) {
  const map: Record<string, string> = {
    'PAGE_CREATED': '创建页面', 'PAGE_EDITED': '编辑内容', 'PAGE_RENAMED': '重命名', 'PAGE_DELETED': '删除', 'PAGE_RESTORED': '恢复', 'METADATA_CHANGED': '修改元数据', 'TAGS_CHANGED': '修改标签', 'SOURCE_CHANGED': '编辑内容'
  }
  return map[type] || type
}

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

function formatRelativeTime(dateStr: string) {
  if (!dateStr) return ''
  return formatDateUtc8(dateStr, { year: 'numeric', month: 'short', day: 'numeric' }) || ''
}
</script>
