<script setup lang="ts">
/**
 * 横向紧凑版交易挂牌项。
 * 左: 48×48 缩略图 + 稀有度色条
 * 右: 卖家名 / 剩余时间 / 价格
 */
import type { Rarity, AffixVisualStyle } from '~/types/gacha'
import { formatTokens } from '~/utils/gachaFormatters'
import { affixThemeMap } from '~/utils/gachaAffixTheme'

const props = defineProps<{
  title: string
  rarity: Rarity
  imageUrl: string | null
  sellerName: string
  unitPrice: number
  remaining: number
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
</script>

<template>
  <button
    type="button"
    class="listing-item"
    @click="$emit('click')"
  >
    <div class="listing-item__thumb">
      <img
        v-if="imageUrl"
        :src="imageUrl"
        :alt="title"
        class="listing-item__img"
        :style="affixFilter ? { filter: affixFilter } : undefined"
        loading="lazy"
      />
      <div v-else class="listing-item__placeholder" />
      <span
        class="listing-item__rarity-bar"
        :style="{ backgroundColor: rarityBarColor[rarity] }"
      />
    </div>
    <div class="listing-item__info">
      <span class="listing-item__seller" :title="sellerName">{{ sellerName }}</span>
      <span class="listing-item__time">{{ remainingLabel }}</span>
      <span class="listing-item__price">{{ formatTokens(unitPrice) }}T <span class="listing-item__qty">x{{ remaining }}</span></span>
    </div>
  </button>
</template>

<style scoped>
.listing-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 0.75rem;
  border: 1px solid rgba(148, 163, 184, 0.25);
  background: rgba(255, 255, 255, 0.8);
  cursor: pointer;
  text-align: left;
  transition: border-color 0.15s ease, box-shadow 0.15s ease, transform 0.12s ease;
  min-width: 0;
}

.listing-item:hover {
  border-color: rgba(14, 116, 144, 0.4);
  box-shadow: 0 2px 8px rgba(15, 23, 42, 0.08);
  transform: translateY(-1px);
}

html.dark .listing-item {
  border-color: rgba(100, 116, 139, 0.4);
  background: rgba(15, 23, 42, 0.6);
}

html.dark .listing-item:hover {
  border-color: rgba(34, 211, 238, 0.45);
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.25);
}

.listing-item__thumb {
  position: relative;
  flex-shrink: 0;
  width: 48px;
  height: 48px;
  border-radius: 0.5rem;
  overflow: hidden;
  background: rgba(241, 245, 249, 0.7);
}

html.dark .listing-item__thumb {
  background: rgba(30, 41, 59, 0.7);
}

.listing-item__img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.listing-item__placeholder {
  width: 100%;
  height: 100%;
  background: linear-gradient(135deg, rgba(148, 163, 184, 0.15), rgba(148, 163, 184, 0.08));
}

.listing-item__rarity-bar {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  height: 3px;
}

.listing-item__info {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
  flex: 1;
}

.listing-item__seller {
  font-size: 11px;
  font-weight: 500;
  color: rgb(71 85 105);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

html.dark .listing-item__seller {
  color: rgb(203 213 225);
}

.listing-item__time {
  font-size: 10px;
  font-weight: 600;
  color: rgb(14 116 144);
  font-variant-numeric: tabular-nums;
}

html.dark .listing-item__time {
  color: rgb(103 232 249);
}

.listing-item__price {
  font-size: 12px;
  font-weight: 700;
  color: rgb(180 83 9);
  font-variant-numeric: tabular-nums;
}

html.dark .listing-item__price {
  color: rgb(252 211 77);
}

.listing-item__qty {
  font-size: 10px;
  font-weight: 500;
  color: rgb(100 116 139);
}

html.dark .listing-item__qty {
  color: rgb(148 163 184);
}
</style>
