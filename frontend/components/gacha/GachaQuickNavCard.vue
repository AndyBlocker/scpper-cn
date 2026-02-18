<script setup lang="ts">
withDefaults(defineProps<{
  to: string
  title: string
  meta?: string | null
}>(), {
  meta: null
})
</script>

<template>
  <NuxtLink
    :to="to"
    class="block h-full rounded-xl border border-neutral-200 bg-white px-3 py-2.5 text-sm font-semibold text-neutral-800 transition hover:-translate-y-0.5 hover:shadow-sm dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
  >
    <div class="flex h-full min-h-[3rem] flex-col justify-center gap-1">
      <span class="truncate">{{ title }}</span>
      <span v-if="meta" class="line-clamp-1 text-xs font-medium text-neutral-500 dark:text-neutral-300">{{ meta }}</span>
    </div>
  </NuxtLink>
</template>
