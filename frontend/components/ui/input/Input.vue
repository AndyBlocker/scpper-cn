<script setup lang="ts">
import { computed, ref, useAttrs } from 'vue'
import { cn } from '~/utils/cn'

const props = withDefaults(defineProps<{
  modelValue?: string | number | null
  modelModifiers?: { trim?: boolean; number?: boolean }
  type?: string
}>(), {
  modelValue: '',
  modelModifiers: () => ({}),
  type: 'text'
})

const emit = defineEmits<{
  'update:modelValue': [value: string | number | null]
}>()

const inputRef = ref<HTMLInputElement | null>(null)
const attrs = useAttrs()

const delegatedAttrs = computed(() => {
  const { class: _class, ...rest } = attrs as Record<string, unknown>
  return rest
})

function handleInput(event: Event) {
  const target = event.target as HTMLInputElement
  let nextValue: string | number | null = target.value
  if (props.modelModifiers.trim && typeof nextValue === 'string') {
    nextValue = nextValue.trim()
  }
  if (props.modelModifiers.number) {
    nextValue = nextValue === '' ? null : Number(nextValue)
  }
  emit('update:modelValue', nextValue)
}

defineExpose({
  focus: () => inputRef.value?.focus(),
  blur: () => inputRef.value?.blur()
})
</script>

<template>
  <input
    ref="inputRef"
    :type="props.type"
    :value="props.modelValue ?? ''"
    :class="cn('w-full rounded-xl border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-700 outline-none transition focus:border-[rgb(var(--accent-strong))] dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100', attrs.class)"
    v-bind="delegatedAttrs"
    @input="handleInput"
  >
</template>
