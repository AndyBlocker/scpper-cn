<template>
  <article
    class="gcm"
    :class="[rarityClass, { 'gcm--coated': hasCoating }]"
    :style="coatingVars"
  >
    <div class="gcm__media">
      <img
        v-if="props.imageUrl"
        :src="props.imageUrl"
        :alt="displayTitle"
        class="gcm__img"
        loading="lazy"
        decoding="async"
      >
      <div v-else class="gcm__fallback" />
      <div class="gcm__rarity-band" />
      <span v-if="props.locked" class="gcm__lock">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" width="10" height="10"><path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1s3.1 1.39 3.1 3.1v2z"/></svg>
      </span>
      <div class="gcm__top">
        <UiBadge :variant="props.rarity" class="gcm__badge">
          {{ rarityShort }}
        </UiBadge>
        <span v-if="coatingChip" class="gcm__chip" :class="chipClass">{{ coatingChip }}</span>
      </div>
    </div>
    <div class="gcm__content">
      <h3 class="gcm__title">{{ displayTitle }}</h3>
    </div>
    <footer v-if="props.count != null || $slots.meta" class="gcm__footer">
      <span v-if="props.count != null" class="gcm__count">x{{ props.count }}</span>
      <slot name="meta" />
    </footer>
  </article>
</template>

<script setup lang="ts">
/**
 * GachaCardMini — lightweight card for picker grids, trade listing rows,
 * and any context where many cards are rendered simultaneously.
 *
 * Compared to GachaCard, this removes:
 * - useCardAffix composable (15 computed per instance)
 * - usePageAuthors composable
 * - mousemove / 3D tilt / foil overlay
 * - backdrop-filter CSS (major mobile GPU cost)
 * - tag lookup / majorType / author resolution
 * - will-change / preserve-3d
 *
 * Result: ~5 computed per instance vs ~35, zero event listeners,
 * no GPU-expensive CSS.
 */
import type { Rarity, AffixVisualStyle } from '~/types/gacha'
import { stripLegacyGachaTitleSuffix } from '~/utils/gachaTitle'
import { UiBadge } from '~/components/ui/badge'
import { computed } from 'vue'

const props = defineProps<{
  title: string
  rarity: Rarity
  imageUrl?: string | null
  count?: number
  affixVisualStyle?: AffixVisualStyle | null
  affixLabel?: string | null
  locked?: boolean
  hideFooter?: boolean
}>()

const displayTitle = computed(() => stripLegacyGachaTitleSuffix(props.title) || '未命名')

const rarityClassMap: Record<Rarity, string> = {
  WHITE: 'gcm--white',
  GREEN: 'gcm--green',
  BLUE: 'gcm--blue',
  PURPLE: 'gcm--purple',
  GOLD: 'gcm--gold'
}
const rarityClass = computed(() => rarityClassMap[props.rarity] || 'gcm--white')

const rarityShortMap: Record<Rarity, string> = {
  WHITE: 'W', GREEN: 'G', BLUE: 'B', PURPLE: 'P', GOLD: 'G'
}
const rarityShort = computed(() => rarityShortMap[props.rarity] || 'W')

// Simple coating detection — no composable, just a quick check
const effectiveStyle = computed<AffixVisualStyle>(() => {
  const s = props.affixVisualStyle
  return (s && s !== 'NONE') ? s : 'NONE'
})

const hasCoating = computed(() => effectiveStyle.value !== 'NONE')

const shortLabelMap: Record<string, string> = {
  MONO: '黑白', SILVER: '银', GOLD: '金', CYAN: '蓝',
  PRISM: '棱镜', COLORLESS: '无色', WILDCARD: '通配',
  SPECTRUM: '谱系', MIRROR: '镜', ORBIT: '轨道', ECHO: '回声',
  NEXUS: '枢纽', ANCHOR: '锚点', FLUX: '流变'
}
const coatingChip = computed(() => {
  if (!hasCoating.value) return ''
  return shortLabelMap[effectiveStyle.value] || props.affixLabel || ''
})

// Minimal chip class — just border/bg color, no backdrop-filter
const chipClassMap: Record<string, string> = {
  GOLD: 'gcm__chip--gold',
  SILVER: 'gcm__chip--silver',
  CYAN: 'gcm__chip--cyan',
  PRISM: 'gcm__chip--prism',
  MONO: 'gcm__chip--mono'
}
const chipClass = computed(() => chipClassMap[effectiveStyle.value] || 'gcm__chip--default')

// Coating edge color for border gradient (simple version)
const coatingEdgeMap: Record<string, string> = {
  GOLD: '#f59e0b', SILVER: '#94a3b8', CYAN: '#06b6d4',
  PRISM: '#a855f7', MONO: '#64748b', COLORLESS: '#a1a1aa',
  WILDCARD: '#f97316', SPECTRUM: '#f43f5e', MIRROR: '#38bdf8',
  ORBIT: '#10b981', ECHO: '#6366f1',
  NEXUS: '#7c3aed', ANCHOR: '#475569', FLUX: '#db2777'
}
const coatingVars = computed(() => {
  if (!hasCoating.value) return {}
  return { '--gcm-edge': coatingEdgeMap[effectiveStyle.value] || '#94a3b8' }
})
</script>

<style scoped>
.gcm {
  position: relative;
  border: 1px solid var(--g-border);
  border-radius: var(--g-radius-md);
  background: var(--g-surface-card);
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  min-width: 0;
  overflow: hidden;
  contain: layout style paint;
  content-visibility: auto;
  contain-intrinsic-size: auto 160px;
}

/* Coating border — simple solid, no gradient mask trick */
.gcm--coated {
  border-color: var(--gcm-edge, var(--g-border));
}

/* ── Media ── */
.gcm__media {
  position: relative;
  overflow: hidden;
  aspect-ratio: 3 / 4;
}

.gcm__img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.gcm__fallback {
  width: 100%;
  height: 100%;
  background: var(--g-surface-recessed);
}

/* ── Rarity band — pure CSS, no pseudo-elements ── */
.gcm__rarity-band {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  height: 2px;
  z-index: 1;
}
.gcm--gold .gcm__rarity-band { background: var(--g-rarity-gold); }
.gcm--purple .gcm__rarity-band { background: var(--g-rarity-purple); }
.gcm--blue .gcm__rarity-band { background: var(--g-rarity-blue); }
.gcm--green .gcm__rarity-band { background: var(--g-rarity-green); }
.gcm--white .gcm__rarity-band { background: var(--g-rarity-white); opacity: 0.3; }

/* ── Rarity outer glow (simplified — no pseudo-elements) ── */
.gcm--gold { box-shadow: 0 0 0 1px rgba(217, 119, 6, 0.15); }
.gcm--purple { box-shadow: 0 0 0 1px rgba(124, 58, 237, 0.1); }

/* ── Top badge row ── */
.gcm__top {
  position: absolute;
  top: 3px;
  left: 3px;
  right: 3px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 2px;
}

.gcm__badge {
  padding: 1px 5px !important;
  font-size: 8px !important;
  line-height: 1.2 !important;
}

/* ── Coating chip — NO backdrop-filter ── */
.gcm__chip {
  max-width: 50%;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  border-radius: 999px;
  font-size: 8px;
  font-weight: 600;
  padding: 1px 5px;
  line-height: 1.3;
  border: 1px solid rgba(148, 163, 184, 0.4);
  background: rgba(255, 255, 255, 0.75);
  color: rgb(100 116 139);
}

html.dark .gcm__chip {
  background: rgba(15, 23, 42, 0.75);
  border-color: rgba(100, 116, 139, 0.5);
  color: rgb(148 163 184);
}

.gcm__chip--gold { border-color: rgba(245, 158, 11, 0.5); color: rgb(180 83 9); }
.gcm__chip--silver { border-color: rgba(148, 163, 184, 0.5); color: rgb(100 116 139); }
.gcm__chip--cyan { border-color: rgba(6, 182, 212, 0.5); color: rgb(8 145 178); }
.gcm__chip--prism { border-color: rgba(168, 85, 247, 0.5); color: rgb(126 34 206); }
.gcm__chip--mono { border-color: rgba(100, 116, 139, 0.5); color: rgb(71 85 105); }

html.dark .gcm__chip--gold { border-color: rgba(251, 191, 36, 0.5); color: rgb(252 211 77); }
html.dark .gcm__chip--cyan { border-color: rgba(34, 211, 238, 0.5); color: rgb(103 232 249); }
html.dark .gcm__chip--prism { border-color: rgba(167, 139, 250, 0.5); color: rgb(196 181 253); }

/* ── Lock indicator — NO backdrop-filter ── */
.gcm__lock {
  position: absolute;
  top: 18px;
  left: 3px;
  z-index: 2;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  border-radius: 3px;
  background: rgba(0, 0, 0, 0.5);
  color: rgba(255, 255, 255, 0.85);
  pointer-events: none;
}

/* ── Content ── */
.gcm__content {
  padding: 3px 5px;
  min-width: 0;
}

.gcm__title {
  font-size: 10px;
  font-weight: 600;
  line-height: 1.3;
  color: var(--g-text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

/* ── Footer ── */
.gcm__footer {
  border-top: 1px solid var(--g-border);
  padding: 2px 5px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 4px;
  margin-top: auto;
  min-height: 22px;
  max-height: 22px;
  overflow: hidden;
}

.gcm__count {
  font-size: 10px;
  font-weight: 700;
  color: var(--g-text-secondary);
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

/* ── Reduced motion ── */
@media (prefers-reduced-motion: reduce) {
  .gcm { transition: none !important; }
}
</style>
