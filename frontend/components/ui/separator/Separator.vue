<script setup lang="ts">
import { computed } from 'vue'
import { Separator as SeparatorPrimitive } from 'radix-vue'
import { cn } from '~/utils/cn'

const props = withDefaults(defineProps<{
  dashed?: boolean
  orientation?: 'horizontal' | 'vertical'
}>(), {
  dashed: false,
  orientation: 'horizontal'
})

const separatorClass = computed(() => {
  if (props.orientation === 'vertical') {
    return props.dashed
      ? 'mx-1 h-full w-px border-l border-dashed border-neutral-200/80 dark:border-neutral-700/80'
      : 'mx-1 h-full w-px bg-neutral-200/80 dark:bg-neutral-700/80'
  }
  return props.dashed
    ? 'h-px w-full border-t border-dashed border-neutral-200/80 dark:border-neutral-700/80'
    : 'h-px w-full bg-neutral-200/80 dark:bg-neutral-700/80'
})
</script>

<template>
  <SeparatorPrimitive
    :orientation="props.orientation"
    :class="cn(separatorClass)"
    v-bind="$attrs"
  />
</template>
