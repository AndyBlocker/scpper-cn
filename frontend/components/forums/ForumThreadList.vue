<script setup lang="ts">
defineProps<{
  threads: Array<{
    id: number
    title: string
    createdByName?: string | null
    createdAt?: string | null
    postCount: number
    categoryTitle?: string | null
  }>
}>()

function formatDate(dateStr: string | null | undefined): string {
  if (!dateStr) return ''
  const d = new Date(dateStr)
  return d.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'Asia/Shanghai' })
}
</script>

<template>
  <div class="space-y-2">
    <NuxtLink
      v-for="thread in threads"
      :key="thread.id"
      :to="`/forums/t/${thread.id}`"
      class="flex items-start gap-3 rounded-lg border border-[rgb(var(--panel-border)_/_0.35)] bg-[rgb(var(--panel)_/_0.72)] p-3 transition hover:border-[var(--g-accent-border)] hover:bg-[rgb(var(--panel)_/_0.92)]"
    >
      <div class="min-w-0 flex-1">
        <h4 class="text-sm font-medium text-[rgb(var(--fg))] line-clamp-1">
          {{ thread.title }}
        </h4>
        <div class="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-[rgb(var(--muted))]">
          <span v-if="thread.createdByName" class="inline-flex items-center gap-1">
            <LucideIcon name="User" class="w-3 h-3" stroke-width="2" aria-hidden="true" />
            {{ thread.createdByName }}
          </span>
          <span v-if="thread.createdAt" class="inline-flex items-center gap-1">
            <LucideIcon name="Calendar" class="w-3 h-3" stroke-width="2" aria-hidden="true" />
            {{ formatDate(thread.createdAt) }}
          </span>
          <span v-if="thread.categoryTitle" class="inline-flex items-center gap-1">
            <LucideIcon name="Folder" class="w-3 h-3" stroke-width="2" aria-hidden="true" />
            {{ thread.categoryTitle }}
          </span>
        </div>
      </div>
      <span class="shrink-0 inline-flex items-center gap-1 rounded-full bg-[rgb(var(--tag-bg))] px-2 py-0.5 text-xs text-[rgb(var(--tag-text))]">
        <LucideIcon name="MessageSquare" class="w-3 h-3" stroke-width="2" aria-hidden="true" />
        {{ thread.postCount }}
      </span>
    </NuxtLink>
  </div>
</template>
