<template>
  <div class="relative rounded-lg p-5 overflow-hidden bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 hover:shadow-md transition-all duration-200">
    <div class="text-xs font-medium text-neutral-600 dark:text-neutral-400">{{ label }}</div>
    <div class="mt-2 flex items-baseline gap-2">
      <div class="text-3xl font-bold text-neutral-900 dark:text-neutral-100">{{ (value ?? 0).toLocaleString() }}</div>
    </div>
  </div>
</template>

<script setup lang="ts">
defineProps<{ label: string; value: number }>();
</script>


