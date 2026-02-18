<script setup lang="ts">
import { TooltipPortal, TooltipContent as TooltipContentPrimitive, TooltipArrow } from 'radix-vue'
import { cn } from '~/utils/cn'

const props = withDefaults(defineProps<{
  sideOffset?: number
}>(), {
  sideOffset: 8
})
</script>

<template>
  <TooltipPortal>
    <TooltipContentPrimitive
      :side-offset="props.sideOffset"
      :class="cn('z-[88] max-w-[18rem] rounded-lg border border-neutral-300 bg-white px-2.5 py-1.5 text-[11px] leading-relaxed text-neutral-800 shadow-xl dark:border-neutral-600 dark:bg-neutral-950 dark:text-neutral-100')"
      v-bind="$attrs"
    >
      <slot />
      <TooltipArrow class="fill-white dark:fill-neutral-950" />
    </TooltipContentPrimitive>
  </TooltipPortal>
</template>
