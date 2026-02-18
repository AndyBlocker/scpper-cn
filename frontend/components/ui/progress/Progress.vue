<script setup lang="ts">
import { computed } from 'vue'
import { ProgressRoot, ProgressIndicator } from 'radix-vue'
import { cn } from '~/utils/cn'

const props = withDefaults(defineProps<{
  modelValue?: number
  max?: number
  color?: 'accent' | 'emerald' | 'cyan' | 'amber' | 'rose'
}>(), {
  modelValue: 0,
  max: 100,
  color: 'accent'
})

const colorClassMap = {
  accent: 'bg-[rgb(var(--accent-strong))]',
  emerald: 'bg-emerald-500',
  cyan: 'bg-cyan-500',
  amber: 'bg-amber-500',
  rose: 'bg-rose-500'
} as const

const safeMax = computed(() => {
  const value = Number(props.max)
  return Number.isFinite(value) && value > 0 ? value : 100
})

const safeValue = computed(() => {
  const value = Number(props.modelValue)
  if (!Number.isFinite(value)) return 0
  return Math.min(safeMax.value, Math.max(0, value))
})

const percent = computed(() => Math.round((safeValue.value / safeMax.value) * 100))
</script>

<template>
  <ProgressRoot
    :model-value="safeValue"
    :max="safeMax"
    :class="cn('relative h-2 w-full overflow-hidden rounded-full bg-neutral-200/75 dark:bg-neutral-800/75')"
    v-bind="$attrs"
  >
    <ProgressIndicator
      :class="cn('h-full transition-all', colorClassMap[props.color])"
      :style="{ width: `${percent}%` }"
    />
  </ProgressRoot>
</template>
