<script setup lang="ts">
import { cn } from '~/utils/cn'
</script>

<template>
  <p :class="cn('text-sm text-neutral-500 dark:text-neutral-400')" v-bind="$attrs">
    <slot />
  </p>
</template>
