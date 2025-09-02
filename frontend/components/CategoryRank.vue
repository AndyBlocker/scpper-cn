<template>
  <div class="flex items-center justify-between p-2 rounded-lg hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-colors">
    <div class="flex items-center gap-2">
      <span class="text-sm font-medium text-neutral-700 dark:text-neutral-300">{{ label }}</span>
      <span class="text-xs text-neutral-500 dark:text-neutral-500">({{ safeCount }})</span>
    </div>
    <div class="flex items-center gap-3">
      <span class="text-sm font-bold text-neutral-900 dark:text-neutral-100">{{ safeRating }}</span>
      <span
        v-if="rank !== null && rank !== undefined && rank !== '-'"
        class="text-xs px-2 py-0.5 rounded-full bg-[rgba(var(--accent),0.12)] dark:bg-[rgba(var(--accent),0.22)] text-[rgb(var(--accent))]"
      >
        #{{ rank }}
      </span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{
  label: string
  rank: number | string | null | undefined
  rating: number | null | undefined
  count: number | null | undefined
}>()

const safeRating = computed(() => Number(props.rating ?? 0).toFixed(0))
const safeCount = computed(() => Number(props.count ?? 0))
</script>


