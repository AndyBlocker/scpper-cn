<script setup lang="ts">
import { TabsTrigger as TabsTriggerPrimitive } from 'radix-vue'
import { cn } from '~/utils/cn'

const props = defineProps<{
  value: string | number
  disabled?: boolean
}>()
</script>

<template>
  <TabsTriggerPrimitive
    :value="props.value"
    :disabled="props.disabled"
    :class="cn('inline-flex min-w-[120px] shrink-0 items-center justify-between gap-2 rounded-xl border border-neutral-200 bg-white px-3 py-2 text-left text-xs font-semibold text-neutral-500 transition hover:border-neutral-300 hover:text-neutral-900 data-[state=active]:border-[rgb(var(--accent-strong))]/45 data-[state=active]:bg-[rgb(var(--accent-strong))]/10 data-[state=active]:text-[rgb(var(--accent-strong))] dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300 dark:hover:border-neutral-600 dark:hover:text-neutral-100 dark:data-[state=active]:border-[rgb(var(--accent-strong))]/45 dark:data-[state=active]:bg-[rgb(var(--accent-strong))]/16 whitespace-nowrap')"
    v-bind="$attrs"
  >
    <slot />
  </TabsTriggerPrimitive>
</template>
