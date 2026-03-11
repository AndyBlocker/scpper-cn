<script setup lang="ts">
defineProps<{
  category: {
    id: number
    title: string
    description?: string | null
    threadsCount: number
    postsCount: number
  }
}>()
</script>

<template>
  <NuxtLink
    :to="`/forums/c/${category.id}`"
    class="block rounded-xl border border-[rgb(var(--panel-border)_/_0.45)] bg-[rgb(var(--panel)_/_0.88)] p-4 shadow-sm transition hover:border-[var(--g-accent-border)] hover:shadow-md"
  >
    <h3 class="text-base font-semibold text-[rgb(var(--fg))]">
      {{ category.title }}
    </h3>
    <p
      v-if="category.description"
      class="mt-1 text-sm text-[rgb(var(--muted))] line-clamp-2"
    >
      {{ category.description }}
    </p>
    <div class="mt-3 flex items-center gap-4 text-xs text-[rgb(var(--muted))]">
      <span class="inline-flex items-center gap-1">
        <LucideIcon name="MessageSquare" class="w-3.5 h-3.5" stroke-width="2" aria-hidden="true" />
        {{ category.threadsCount }} 个主题
      </span>
      <span class="inline-flex items-center gap-1">
        <LucideIcon name="MessagesSquare" class="w-3.5 h-3.5" stroke-width="2" aria-hidden="true" />
        {{ category.postsCount }} 条回复
      </span>
    </div>
  </NuxtLink>
</template>
