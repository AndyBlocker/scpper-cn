<script setup lang="ts">
import { computed, useAttrs } from 'vue'
import { DialogContent as DialogContentPrimitive } from 'radix-vue'
import { cn } from '~/utils/cn'

const attrs = useAttrs()

const delegatedAttrs = computed(() => {
  const { class: _class, ...rest } = attrs as Record<string, unknown>
  return rest
})
</script>

<template>
  <DialogContentPrimitive
    :class="cn('fixed left-1/2 top-1/2 z-[67] box-border w-[calc(100%-1rem)] max-w-5xl -translate-x-1/2 -translate-y-1/2 rounded-[24px] border border-neutral-200/70 bg-white/95 p-3 shadow-2xl focus:outline-none max-h-[calc(100vh-1rem)] max-h-[calc(100dvh-1rem)] overflow-x-hidden overflow-y-auto flex flex-col dark:border-neutral-700/70 dark:bg-neutral-900/95 sm:w-[calc(100%-2rem)] sm:rounded-[28px] sm:p-5 sm:max-h-[calc(100vh-2rem)] sm:max-h-[calc(100dvh-2rem)]', attrs.class)"
    v-bind="delegatedAttrs"
  >
    <slot />
  </DialogContentPrimitive>
</template>
