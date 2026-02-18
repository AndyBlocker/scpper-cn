<script setup lang="ts">
import { cn } from '~/utils/cn'
</script>

<template>
  <header :class="cn('flex flex-col gap-1.5')" v-bind="$attrs">
    <slot />
  </header>
</template>
