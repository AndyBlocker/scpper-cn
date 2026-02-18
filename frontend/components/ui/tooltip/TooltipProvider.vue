<script setup lang="ts">
import { TooltipProvider as TooltipProviderPrimitive } from 'radix-vue'

const props = withDefaults(defineProps<{
  delayDuration?: number
  disableHoverableContent?: boolean
}>(), {
  delayDuration: 180,
  disableHoverableContent: false
})
</script>

<template>
  <TooltipProviderPrimitive
    :delay-duration="props.delayDuration"
    :disable-hoverable-content="props.disableHoverableContent"
    v-bind="$attrs"
  >
    <slot />
  </TooltipProviderPrimitive>
</template>
