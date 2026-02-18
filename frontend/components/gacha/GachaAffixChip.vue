<script setup lang="ts">
/**
 * 可复用的词条标签 + 悬停提示。
 * 替代 GachaCard.vue 中的 .gacha-card__affix-chip 和
 * index.vue 中的 .affix-chip-with-tip 两套独立实现。
 */
import type { AffixVisualStyle } from '~/types/gacha'
import { computed } from 'vue'
import { affixThemeMap } from '~/utils/gachaAffixTheme'
import { formatAffixPartLabel, affixPartHoverSummary, affixStyleGlyph } from '~/utils/gachaAffix'
import {
  UiTooltipProvider,
  UiTooltip,
  UiTooltipTrigger,
  UiTooltipContent
} from '~/components/ui/tooltip'

const props = withDefaults(defineProps<{
  style: AffixVisualStyle
  count?: number
  /** 是否显示 glyph 符号前缀 */
  showGlyph?: boolean
  /** 自定义 tooltip 文字，默认使用 affixPartHoverSummary */
  tooltip?: string
  /** 额外后缀文字，如 "x3" */
  suffix?: string
}>(), {
  count: 1,
  showGlyph: false,
})

const part = computed(() => ({ style: props.style, count: props.count }))
const chipClass = computed(() => affixThemeMap[props.style]?.chip || affixThemeMap.NONE.chip)
const tipText = computed(() => props.tooltip || affixPartHoverSummary(part.value))
</script>

<template>
  <UiTooltipProvider :delay-duration="200">
    <UiTooltip>
      <UiTooltipTrigger as-child>
        <span
          class="gacha-affix-chip inline-flex max-w-full items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold"
          :class="chipClass"
        >
          <span class="truncate">
            <template v-if="showGlyph">{{ affixStyleGlyph(style) }} </template>
            {{ formatAffixPartLabel(part) }}
            <template v-if="suffix"> {{ suffix }}</template>
          </span>
        </span>
      </UiTooltipTrigger>
      <UiTooltipContent v-if="tipText">
        {{ tipText }}
      </UiTooltipContent>
    </UiTooltip>
  </UiTooltipProvider>
</template>

<style scoped>
.gacha-affix-chip {
  position: relative;
  z-index: 1;
  max-width: 100%;
  transition: transform 0.16s ease, box-shadow 0.16s ease, border-color 0.16s ease;
}

.gacha-affix-chip:hover,
.gacha-affix-chip:focus-within {
  transform: translateY(-1px);
  box-shadow: 0 10px 20px -16px rgba(15, 23, 42, 0.9);
  z-index: 84;
}

@media (prefers-reduced-motion: reduce) {
  .gacha-affix-chip {
    transition: none !important;
  }
}
</style>
