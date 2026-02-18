<script setup lang="ts">
import { TooltipTrigger as TooltipTriggerPrimitive } from 'radix-vue'
</script>

<template>
  <TooltipTriggerPrimitive v-bind="$attrs">
    <slot />
  </TooltipTriggerPrimitive>
</template>
