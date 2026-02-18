<script setup lang="ts">
import { DialogTitle as DialogTitlePrimitive } from 'radix-vue'
</script>

<template>
  <DialogTitlePrimitive
    class="text-lg font-semibold text-neutral-900 dark:text-neutral-50"
    v-bind="$attrs"
  >
    <slot />
  </DialogTitlePrimitive>
</template>
