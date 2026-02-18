<script setup lang="ts">
import { cn } from '~/utils/cn'
</script>

<template>
  <h3 :class="cn('text-lg font-semibold text-neutral-900 dark:text-neutral-50')" v-bind="$attrs">
    <slot />
  </h3>
</template>
