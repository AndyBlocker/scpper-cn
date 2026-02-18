<script setup lang="ts">
import { SelectRoot as SelectRootPrimitive } from 'radix-vue'
</script>

<template>
  <SelectRootPrimitive v-bind="$attrs">
    <slot />
  </SelectRootPrimitive>
</template>
