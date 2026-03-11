<script setup lang="ts">
import { TabsContent as TabsContentPrimitive } from 'radix-vue'
import { cn } from '~/utils/cn'

const props = defineProps<{
  value: string | number
  forceMount?: boolean
}>()
</script>

<template>
  <TabsContentPrimitive
    :value="props.value"
    :force-mount="props.forceMount"
    :class="cn('mt-4 focus-visible:outline-none')"
    v-bind="$attrs"
  >
    <slot />
  </TabsContentPrimitive>
</template>
