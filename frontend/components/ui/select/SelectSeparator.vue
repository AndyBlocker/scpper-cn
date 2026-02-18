<script setup lang="ts">
import { SelectSeparator as SelectSeparatorPrimitive } from 'radix-vue'
import { cn } from '~/utils/cn'
</script>

<template>
  <SelectSeparatorPrimitive
    :class="cn('-mx-1 my-1 h-px bg-neutral-200/80 dark:bg-neutral-700/80')"
    v-bind="$attrs"
  />
</template>
