<script setup lang="ts">
import { DialogDescription as DialogDescriptionPrimitive } from 'radix-vue'
</script>

<template>
  <DialogDescriptionPrimitive
    class="text-sm text-neutral-500 dark:text-neutral-400"
    v-bind="$attrs"
  >
    <slot />
  </DialogDescriptionPrimitive>
</template>
