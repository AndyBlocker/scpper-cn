<script setup lang="ts">
import { SelectPortal, SelectContent as SelectContentPrimitive, SelectViewport } from 'radix-vue'
import { cn } from '~/utils/cn'
</script>

<template>
  <SelectPortal>
    <SelectContentPrimitive
      position="popper"
      :class="cn('z-[130] max-h-[18rem] max-h-[calc(100dvh-2rem)] min-w-[10rem] overflow-hidden rounded-xl border border-neutral-300 bg-white p-1 text-neutral-800 shadow-2xl dark:border-neutral-600 dark:bg-neutral-950 dark:text-neutral-100')"
      v-bind="$attrs"
    >
      <SelectViewport>
        <slot />
      </SelectViewport>
    </SelectContentPrimitive>
  </SelectPortal>
</template>
