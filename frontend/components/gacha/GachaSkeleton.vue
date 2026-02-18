<script setup lang="ts">
/**
 * 可复用骨架加载器。
 * variant 控制形状: card-mini / card-large / metric / row / panel / text / text-short
 * count 控制重复数量。
 */
withDefaults(defineProps<{
  variant?: 'card-mini' | 'card-large' | 'metric' | 'row' | 'panel' | 'text' | 'text-short'
  count?: number
}>(), {
  variant: 'panel',
  count: 1
})

const variantClassMap: Record<string, string> = {
  'card-mini': 'gacha-skeleton gacha-skeleton--card-mini',
  'card-large': 'gacha-skeleton gacha-skeleton--card-large',
  metric: 'gacha-skeleton gacha-skeleton--metric',
  row: 'gacha-skeleton gacha-skeleton--row',
  panel: 'gacha-skeleton gacha-skeleton--panel',
  text: 'gacha-skeleton gacha-skeleton--text',
  'text-short': 'gacha-skeleton gacha-skeleton--text-short'
}
</script>

<template>
  <div v-for="i in count" :key="i" :class="variantClassMap[variant]" role="status" aria-label="加载中">
    <span class="sr-only">加载中...</span>
  </div>
</template>
