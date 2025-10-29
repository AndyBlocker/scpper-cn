<template>
  <component v-if="iconComponent" :is="iconComponent" v-bind="forwardAttrs" />
</template>

<script setup lang="ts">
import { computed, useAttrs } from 'vue'
import * as lucide from 'lucide-vue-next'

const props = defineProps<{
  name: keyof typeof lucide | string
  fallback?: keyof typeof lucide | string
}>()

const attrs = useAttrs()

const iconComponent = computed(() => {
  const icon = lucide[props.name as keyof typeof lucide]
  if (icon) {
    return icon
  }
  const fallback = lucide[(props.fallback ?? 'CircleHelp') as keyof typeof lucide]
  return fallback ?? null
})

const forwardAttrs = computed<Record<string, unknown>>(() => {
  const base = { ...attrs } as Record<string, unknown>
  if (!('stroke-width' in base) && !('strokeWidth' in base)) {
    base['stroke-width'] = 2
  }
  return base
})
</script>
