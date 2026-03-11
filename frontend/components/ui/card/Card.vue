<script setup lang="ts">
import { computed, useAttrs } from 'vue'
import { cn } from '~/utils/cn'

const attrs = useAttrs()

const delegatedAttrs = computed(() => {
  const { class: _class, ...rest } = attrs as Record<string, unknown>
  return rest
})
</script>

<template>
  <article
    :class="cn('rounded-lg border border-neutral-200/70 bg-white/90 p-6 shadow-sm dark:border-neutral-800/70 dark:bg-neutral-900/70', attrs.class)"
    v-bind="delegatedAttrs"
  >
    <slot />
  </article>
</template>
