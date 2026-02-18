<script setup lang="ts">
import { SelectTrigger as SelectTriggerPrimitive, SelectValue, SelectIcon } from 'radix-vue'
import { cn } from '~/utils/cn'

withDefaults(defineProps<{
  placeholder?: string
}>(), {
  placeholder: '请选择...'
})
</script>

<template>
  <SelectTriggerPrimitive
    :class="cn('inline-flex h-9 w-full items-center justify-between gap-2 rounded-xl border border-neutral-200 bg-white px-3 py-2 text-xs text-neutral-700 outline-none transition focus:border-[rgb(var(--accent-strong))] disabled:cursor-not-allowed disabled:opacity-60 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100')"
    v-bind="$attrs"
  >
    <SelectValue :placeholder="placeholder" />
    <SelectIcon class="text-neutral-400 dark:text-neutral-500">▾</SelectIcon>
  </SelectTriggerPrimitive>
</template>
