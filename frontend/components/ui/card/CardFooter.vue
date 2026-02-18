<script setup lang="ts">
import { cn } from '~/utils/cn'
</script>

<template>
  <footer :class="cn('mt-4 flex items-center justify-end gap-2')" v-bind="$attrs">
    <slot />
  </footer>
</template>
