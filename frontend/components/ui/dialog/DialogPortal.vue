<script setup lang="ts">
import { DialogPortal as DialogPortalPrimitive } from 'radix-vue'
</script>

<template>
  <DialogPortalPrimitive v-bind="$attrs">
    <slot />
  </DialogPortalPrimitive>
</template>
