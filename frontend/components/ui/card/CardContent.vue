<script setup lang="ts">
import { cn } from '~/utils/cn'
</script>

<template>
  <div :class="cn('mt-4')" v-bind="$attrs">
    <slot />
  </div>
</template>
