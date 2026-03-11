<script setup lang="ts">
/**
 * 轻量卡片列表项 — 替代完整 GachaCard 用于批量分解等列表场景。
 * 仅显示：缩略图(40px) + 标题 + 稀有度色条 + 词条标签 + 持有数 + 锁定图标。
 */
import type { Rarity, AffixVisualStyle } from '~/types/gacha'
import { rarityLabel, rarityChipClassMap } from '~/utils/gachaRarity'
import { resolveAffixParts } from '~/utils/gachaAffix'
import { displayCardTitle } from '~/utils/gachaTitle'
import { computed } from 'vue'
import GachaAffixChip from '~/components/gacha/GachaAffixChip.vue'

const props = defineProps<{
  title: string
  rarity: Rarity
  imageUrl: string | null
  count: number
  affixVisualStyle?: AffixVisualStyle
  affixSignature?: string
  affixLabel?: string | null
  affixStyles?: AffixVisualStyle[]
  affixStyleCounts?: Partial<Record<AffixVisualStyle, number>>
  dismantleCount?: number
  estimatedReward?: number
  selected?: boolean
  locked?: boolean
  retired?: boolean
  disabled?: boolean
}>()

const affixParts = computed(() => resolveAffixParts(props))
</script>

<template>
  <div
    class="card-list-item"
    :class="{
      'card-list-item--selected': selected,
      'card-list-item--locked': locked,
      'card-list-item--disabled': disabled
    }"
  >
    <!-- Thumbnail -->
    <div class="card-list-thumb">
      <img v-if="imageUrl" :src="imageUrl" :alt="displayCardTitle(title)" loading="lazy" decoding="async" class="h-full w-full object-cover" />
      <div v-else class="flex h-full w-full items-center justify-center text-[10px] text-neutral-400">--</div>
    </div>

    <!-- Info -->
    <div class="min-w-0 flex-1 space-y-0.5">
      <div class="flex items-center gap-1.5">
        <span v-if="locked" class="text-xs text-amber-500" title="已锁定">&#x1F512;</span>
        <h4 class="truncate text-xs font-semibold text-neutral-900 dark:text-neutral-100">{{ displayCardTitle(title) }}</h4>
      </div>
      <div class="flex flex-wrap items-start gap-1 text-[10px]">
        <div class="card-list-meta-left">
          <span class="inline-flex rounded-full border px-1.5 py-0.5 font-semibold" :class="rarityChipClassMap[rarity] || rarityChipClassMap.WHITE">
            {{ rarityLabel(rarity) }}
          </span>
          <span v-if="retired" class="card-list-meta-retired">绝版</span>
        </div>
        <GachaAffixChip
          v-for="part in affixParts.filter((p) => p.style !== 'NONE')"
          :key="`list-affix-${part.style}-${part.count}`"
          :style="part.style"
          :count="part.count"
        />
      </div>
    </div>

    <!-- Counts -->
    <div class="flex flex-col items-end gap-0.5 text-right">
      <span class="text-[11px] font-semibold text-neutral-600 dark:text-neutral-300">{{ count }} 张</span>
      <span v-if="dismantleCount != null && dismantleCount > 0" class="text-[10px] text-cyan-600 dark:text-cyan-300">
        分解 {{ dismantleCount }}
      </span>
      <span v-if="estimatedReward != null && estimatedReward > 0" class="text-[10px] text-amber-600 dark:text-amber-300">
        +{{ estimatedReward }} T
      </span>
    </div>

    <!-- Selection indicator -->
    <div class="flex w-5 items-center justify-center">
      <div
        v-if="!locked && !disabled"
        class="h-4 w-4 rounded border-2 transition"
        :class="selected
          ? 'border-cyan-500 bg-cyan-500'
          : 'border-neutral-300 dark:border-neutral-600'"
      >
        <svg v-if="selected" class="h-full w-full text-white" viewBox="0 0 16 16" fill="currentColor">
          <path d="M12.207 4.793a1 1 0 010 1.414l-5 5a1 1 0 01-1.414 0l-2-2a1 1 0 011.414-1.414L6.5 9.086l4.293-4.293a1 1 0 011.414 0z" />
        </svg>
      </div>
    </div>
  </div>
</template>

<style scoped>
.card-list-item {
  display: flex;
  align-items: center;
  gap: 0.625rem;
  padding: 0.375rem 0.5rem;
  border-radius: 0.75rem;
  border: 1px solid rgba(148, 163, 184, 0.2);
  background: rgba(255, 255, 255, 0.7);
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
  content-visibility: auto;
  contain-intrinsic-size: auto 52px;
}

html.dark .card-list-item {
  border-color: rgba(100, 116, 139, 0.3);
  background: rgba(15, 23, 42, 0.5);
}

.card-list-item:hover:not(.card-list-item--disabled):not(.card-list-item--locked) {
  border-color: rgba(14, 116, 144, 0.3);
  background: rgba(236, 254, 255, 0.3);
}

html.dark .card-list-item:hover:not(.card-list-item--disabled):not(.card-list-item--locked) {
  border-color: rgba(34, 211, 238, 0.3);
  background: rgba(8, 47, 73, 0.3);
}

.card-list-item--selected {
  border-color: rgba(14, 116, 144, 0.5);
  background: rgba(236, 254, 255, 0.4);
}

html.dark .card-list-item--selected {
  border-color: rgba(34, 211, 238, 0.5);
  background: rgba(8, 47, 73, 0.4);
}

.card-list-item--locked {
  opacity: 0.6;
  cursor: not-allowed;
}

.card-list-item--disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.card-list-thumb {
  flex-shrink: 0;
  position: relative;
  width: 40px;
  height: 40px;
  border-radius: 0.5rem;
  overflow: hidden;
  background: rgb(243 244 246);
}

html.dark .card-list-thumb {
  background: rgb(30 41 59);
}

.card-list-meta-left {
  display: inline-flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
}

.card-list-meta-retired {
  display: inline-flex;
  justify-content: center;
  min-width: 22px;
  height: 12px;
  padding: 0 3px;
  border-radius: 999px;
  border: 1px solid rgba(190, 24, 93, 0.28);
  background: linear-gradient(135deg, rgba(255, 241, 242, 0.95), rgba(255, 228, 230, 0.88));
  color: rgb(159 18 57);
  font-size: 7px;
  font-weight: 800;
  letter-spacing: 0.08em;
  pointer-events: none;
}

html.dark .card-list-meta-retired {
  border-color: rgba(251, 113, 133, 0.28);
  background: linear-gradient(135deg, rgba(76, 5, 25, 0.88), rgba(136, 19, 55, 0.72));
  color: rgb(255 228 230);
}
</style>
