<script setup lang="ts">
import { DialogClose as DialogClosePrimitive } from 'radix-vue'
</script>

<template>
  <DialogClosePrimitive v-bind="$attrs">
    <slot />
  </DialogClosePrimitive>
</template>
