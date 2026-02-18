<script setup lang="ts">
import { TooltipRoot as TooltipRootPrimitive } from 'radix-vue'
</script>

<template>
  <TooltipRootPrimitive v-bind="$attrs">
    <slot />
  </TooltipRootPrimitive>
</template>
