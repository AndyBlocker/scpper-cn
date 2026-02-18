<script setup lang="ts">
import { TabsList as TabsListPrimitive } from 'radix-vue'
import { cn } from '~/utils/cn'
</script>

<template>
  <TabsListPrimitive
    :class="cn('inline-flex w-full items-center gap-2 overflow-x-auto pb-1 sm:flex-wrap sm:overflow-visible')"
    v-bind="$attrs"
  >
    <slot />
  </TabsListPrimitive>
</template>
