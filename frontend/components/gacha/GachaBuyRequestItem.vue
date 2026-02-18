<script setup lang="ts">
/**
 * 横向紧凑版求购项。
 * 左: 目标卡缩略图 + 稀有度色条
 * 右: 买家名 / 剩余时间 + offered cards 数量 / Token出价
 */
import type { Rarity, AffixVisualStyle } from '~/types/gacha'
import { formatTokens } from '~/utils/gachaFormatters'
import { affixThemeMap } from '~/utils/gachaAffixTheme'

const props = defineProps<{
  title: string
  rarity: Rarity
  imageUrl: string | null
  buyerName: string
  tokenOffer: number
  offeredCardCount: number
  remainingLabel: string
  affixVisualStyle?: AffixVisualStyle | null
}>()

defineEmits<{
  click: []
}>()

const rarityBarColor: Record<Rarity, string> = {
  GOLD: '#f59e0b',
  PURPLE: '#a855f7',
  BLUE: '#3b82f6',
  GREEN: '#10b981',
  WHITE: '#a3a3a3'
}

const affixFilter = computed(() => {
  if (!props.affixVisualStyle || props.affixVisualStyle === 'NONE') return ''
  return affixThemeMap[props.affixVisualStyle]?.filter || ''
})

const priceLabel = computed(() => {
  if (props.tokenOffer > 0 && props.offeredCardCount > 0) {
    return `${formatTokens(props.tokenOffer)}T + ${props.offeredCardCount}卡`
  }
  if (props.tokenOffer > 0) {
    return `${formatTokens(props.tokenOffer)}T`
  }
  return `${props.offeredCardCount}卡交换`
})
</script>

<template>
  <button
    type="button"
    class="br-item"
    @click="$emit('click')"
  >
    <div class="br-item__thumb">
      <img
        v-if="imageUrl"
        :src="imageUrl"
        :alt="title"
        class="br-item__img"
        :style="affixFilter ? { filter: affixFilter } : undefined"
        loading="lazy"
      />
      <div v-else class="br-item__placeholder" />
      <span
        class="br-item__rarity-bar"
        :style="{ backgroundColor: rarityBarColor[rarity] }"
      />
    </div>
    <div class="br-item__info">
      <span class="br-item__buyer" :title="buyerName">{{ buyerName }}</span>
      <span class="br-item__time">{{ remainingLabel }}</span>
      <span class="br-item__price">{{ priceLabel }}</span>
    </div>
  </button>
</template>

<style scoped>
.br-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 0.75rem;
  border: 1px solid rgba(14, 116, 144, 0.2);
  background: rgba(236, 254, 255, 0.5);
  cursor: pointer;
  text-align: left;
  transition: border-color 0.15s ease, box-shadow 0.15s ease, transform 0.12s ease;
  min-width: 0;
}

.br-item:hover {
  border-color: rgba(14, 116, 144, 0.45);
  box-shadow: 0 2px 8px rgba(8, 145, 178, 0.1);
  transform: translateY(-1px);
}

html.dark .br-item {
  border-color: rgba(34, 211, 238, 0.25);
  background: rgba(8, 47, 73, 0.5);
}

html.dark .br-item:hover {
  border-color: rgba(34, 211, 238, 0.5);
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.25);
}

.br-item__thumb {
  position: relative;
  flex-shrink: 0;
  width: 48px;
  height: 48px;
  border-radius: 0.5rem;
  overflow: hidden;
  background: rgba(241, 245, 249, 0.7);
}

html.dark .br-item__thumb {
  background: rgba(30, 41, 59, 0.7);
}

.br-item__img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.br-item__placeholder {
  width: 100%;
  height: 100%;
  background: linear-gradient(135deg, rgba(14, 116, 144, 0.1), rgba(14, 116, 144, 0.04));
}

.br-item__rarity-bar {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  height: 3px;
}

.br-item__info {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
  flex: 1;
}

.br-item__buyer {
  font-size: 11px;
  font-weight: 500;
  color: rgb(71 85 105);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

html.dark .br-item__buyer {
  color: rgb(203 213 225);
}

.br-item__time {
  font-size: 10px;
  font-weight: 600;
  color: rgb(14 116 144);
  font-variant-numeric: tabular-nums;
}

html.dark .br-item__time {
  color: rgb(103 232 249);
}

.br-item__price {
  font-size: 12px;
  font-weight: 700;
  color: rgb(8 145 178);
  font-variant-numeric: tabular-nums;
}

html.dark .br-item__price {
  color: rgb(34 211 238);
}
</style>
