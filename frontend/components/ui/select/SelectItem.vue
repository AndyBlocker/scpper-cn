<script setup lang="ts">
import { SelectItem as SelectItemPrimitive, SelectItemIndicator, SelectItemText } from 'radix-vue'
import { cn } from '~/utils/cn'

const props = defineProps<{
  value: string
  disabled?: boolean
  textValue?: string
}>()
</script>

<template>
  <SelectItemPrimitive
    :value="props.value"
    :disabled="props.disabled"
    :text-value="props.textValue"
    :class="cn('relative flex w-full cursor-default select-none items-center rounded-lg bg-white py-1.5 pl-7 pr-2 text-xs text-neutral-700 outline-none transition hover:bg-neutral-100 focus:bg-neutral-100 focus:text-neutral-900 data-[state=checked]:bg-neutral-100 data-[disabled]:pointer-events-none data-[disabled]:opacity-50 dark:bg-neutral-950 dark:text-neutral-200 dark:hover:bg-neutral-800 dark:focus:bg-neutral-800 dark:focus:text-neutral-50 dark:data-[state=checked]:bg-neutral-800')"
    v-bind="$attrs"
  >
    <span class="absolute left-2 inline-flex h-3.5 w-3.5 items-center justify-center">
      <SelectItemIndicator class="text-[rgb(var(--accent-strong))]">✓</SelectItemIndicator>
    </span>
    <SelectItemText>
      <slot />
    </SelectItemText>
  </SelectItemPrimitive>
</template>
