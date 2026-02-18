<script setup lang="ts">
import { TabsRoot as TabsRootPrimitive } from 'radix-vue'
</script>

<template>
  <TabsRootPrimitive v-bind="$attrs">
    <slot />
  </TabsRootPrimitive>
</template>
