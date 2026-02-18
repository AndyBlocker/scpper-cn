<script setup lang="ts">
import { DialogRoot as DialogRootPrimitive } from 'radix-vue'
</script>

<template>
  <DialogRootPrimitive v-bind="$attrs">
    <slot />
  </DialogRootPrimitive>
</template>
