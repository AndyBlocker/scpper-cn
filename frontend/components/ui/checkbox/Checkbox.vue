<script setup lang="ts">
import { CheckboxRoot, CheckboxIndicator } from 'radix-vue'
import { cn } from '~/utils/cn'

const props = withDefaults(defineProps<{
  modelValue?: boolean
}>(), {
  modelValue: false
})

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
}>()

function handleChecked(nextChecked: boolean) {
  emit('update:modelValue', !!nextChecked)
}
</script>

<template>
  <CheckboxRoot
    :checked="props.modelValue"
    :class="cn('inline-flex h-4 w-4 shrink-0 items-center justify-center rounded border border-neutral-300 bg-white text-[rgb(var(--accent-strong))] outline-none transition focus-visible:ring-2 focus-visible:ring-[rgb(var(--accent-strong))]/35 data-[state=checked]:border-[rgb(var(--accent-strong))] data-[state=checked]:bg-[rgb(var(--accent-strong))]/12 disabled:cursor-not-allowed disabled:opacity-60 dark:border-neutral-600 dark:bg-neutral-900')"
    v-bind="$attrs"
    @update:checked="handleChecked"
  >
    <CheckboxIndicator class="text-[11px] leading-none">✓</CheckboxIndicator>
  </CheckboxRoot>
</template>
