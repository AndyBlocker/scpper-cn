<script setup lang="ts">
import { TabsContent as TabsContentPrimitive } from 'radix-vue'
import { cn } from '~/utils/cn'
</script>

<template>
  <TabsContentPrimitive
    :class="cn('mt-4 focus-visible:outline-none')"
    v-bind="$attrs"
  >
    <slot />
  </TabsContentPrimitive>
</template>
