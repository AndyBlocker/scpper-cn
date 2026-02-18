<script setup lang="ts">
import { computed, useAttrs } from 'vue'
import { DialogOverlay as DialogOverlayPrimitive } from 'radix-vue'
import { cn } from '~/utils/cn'

const attrs = useAttrs()

const delegatedAttrs = computed(() => {
  const { class: _class, ...rest } = attrs as Record<string, unknown>
  return rest
})
</script>

<template>
  <DialogOverlayPrimitive
    :class="cn('fixed inset-0 z-[66] bg-black/65 backdrop-blur-sm', attrs.class)"
    v-bind="delegatedAttrs"
  />
</template>
