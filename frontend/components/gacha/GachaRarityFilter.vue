<script setup lang="ts">
import type { Rarity } from '~/types/gacha'
import { rarityLabel } from '~/utils/gachaRarity'

const props = withDefaults(defineProps<{
  modelValue: Rarity | 'ALL'
  options?: Array<Rarity | 'ALL'>
  allLabel?: string
}>(), {
  options: () => ['ALL', 'GOLD', 'PURPLE', 'BLUE', 'GREEN', 'WHITE'],
  allLabel: '全部'
})

const emit = defineEmits<{
  'update:modelValue': [value: Rarity | 'ALL']
}>()

function formatOptionLabel(option: Rarity | 'ALL') {
  return option === 'ALL' ? props.allLabel : rarityLabel(option)
}
</script>

<template>
  <div class="flex flex-wrap items-center gap-1.5 text-[11px]">
    <button
      v-for="option in props.options"
      :key="`rarity-filter-${option}`"
      type="button"
      class="inline-flex items-center rounded-full border px-2.5 py-1 font-semibold transition"
      :class="props.modelValue === option
        ? 'border-[rgb(var(--accent-strong))]/45 bg-[rgb(var(--accent-strong))]/10 text-[rgb(var(--accent-strong))]'
        : 'border-neutral-200 bg-white text-neutral-500 hover:border-neutral-300 hover:text-neutral-800 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300 dark:hover:border-neutral-600 dark:hover:text-neutral-100'"
      @click="emit('update:modelValue', option)"
    >
      {{ formatOptionLabel(option) }}
    </button>
  </div>
</template>
