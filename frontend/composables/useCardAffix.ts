/**
 * useCardAffix — 从 GachaCard.vue 提取的词缀显示逻辑。
 * 负责解析词缀来源、生成 chip 文本、tooltip、视觉 token。
 */
import { computed, type Ref } from 'vue'
import type { AffixVisualStyle } from '~/types/gacha'
import { affixThemeMap, normalizeAffixStyle } from '~/utils/gachaAffixTheme'
import {
  resolvePrimaryAffixStyleFromSource,
  resolveAffixDisplayName,
  resolveAffixParts,
  formatAffixPartsLabel,
  affixPartHoverSummary,
  resolveAffixEffectSummary
} from '~/utils/gachaAffix'

export interface AffixSource {
  affixVisualStyle?: AffixVisualStyle | null
  affixLabel?: string | null
  affixSignature?: string | null
  affixStyles?: AffixVisualStyle[] | null
  affixStyleCounts?: Partial<Record<AffixVisualStyle, number>> | null
}

// Coating tone palette per style
const coatingToneMap: Record<AffixVisualStyle, { edge: string; glow: string; foil: string }> = {
  NONE: { edge: '#94a3b8', glow: 'rgba(148,163,184,0.22)', foil: 'rgba(255,255,255,0.24)' },
  MONO: { edge: '#64748b', glow: 'rgba(100,116,139,0.3)', foil: 'rgba(241,245,249,0.28)' },
  SILVER: { edge: '#94a3b8', glow: 'rgba(148,163,184,0.34)', foil: 'rgba(248,250,252,0.35)' },
  GOLD: { edge: '#f59e0b', glow: 'rgba(245,158,11,0.36)', foil: 'rgba(254,240,138,0.34)' },
  CYAN: { edge: '#06b6d4', glow: 'rgba(6,182,212,0.35)', foil: 'rgba(103,232,249,0.34)' },
  PRISM: { edge: '#a855f7', glow: 'rgba(168,85,247,0.36)', foil: 'rgba(216,180,254,0.34)' },
  COLORLESS: { edge: '#a1a1aa', glow: 'rgba(161,161,170,0.32)', foil: 'rgba(244,244,245,0.32)' },
  WILDCARD: { edge: '#f97316', glow: 'rgba(249,115,22,0.35)', foil: 'rgba(253,186,116,0.34)' },
  SPECTRUM: { edge: '#f43f5e', glow: 'rgba(244,63,94,0.35)', foil: 'rgba(251,113,133,0.34)' },
  MIRROR: { edge: '#38bdf8', glow: 'rgba(56,189,248,0.34)', foil: 'rgba(186,230,253,0.34)' },
  ORBIT: { edge: '#10b981', glow: 'rgba(16,185,129,0.35)', foil: 'rgba(110,231,183,0.34)' },
  ECHO: { edge: '#6366f1', glow: 'rgba(99,102,241,0.35)', foil: 'rgba(165,180,252,0.34)' },
  NEXUS: { edge: '#7c3aed', glow: 'rgba(124,58,237,0.36)', foil: 'rgba(196,181,253,0.34)' },
  ANCHOR: { edge: '#475569', glow: 'rgba(71,85,105,0.32)', foil: 'rgba(148,163,184,0.34)' },
  FLUX: { edge: '#db2777', glow: 'rgba(219,39,119,0.36)', foil: 'rgba(244,114,182,0.34)' }
}

// Foil color palettes for conic-gradient (holographic effect)
export const coatingFoilPalette: Record<AffixVisualStyle, string[]> = {
  NONE: ['transparent'],
  MONO: ['#e2e8f0', '#f8fafc', '#94a3b8', '#e2e8f0'],
  SILVER: ['#cbd5e1', '#f1f5f9', '#e2e8f0', '#cbd5e1'],
  GOLD: ['#fbbf24', '#fef3c7', '#f59e0b', '#fffbeb', '#fbbf24'],
  CYAN: ['#22d3ee', '#a5f3fc', '#0891b2', '#cffafe', '#22d3ee'],
  PRISM: ['#c084fc', '#67e8f9', '#f9a8d4', '#a78bfa', '#c084fc'],
  COLORLESS: ['#d4d4d8', '#fafafa', '#a1a1aa', '#f4f4f5', '#d4d4d8'],
  WILDCARD: ['#fb923c', '#fde68a', '#f97316', '#fed7aa', '#fb923c'],
  SPECTRUM: ['#fb7185', '#e879f9', '#f43f5e', '#fda4af', '#fb7185'],
  MIRROR: ['#7dd3fc', '#e0f2fe', '#38bdf8', '#bae6fd', '#7dd3fc'],
  ORBIT: ['#6ee7b7', '#d1fae5', '#10b981', '#a7f3d0', '#6ee7b7'],
  ECHO: ['#a5b4fc', '#e0e7ff', '#6366f1', '#c7d2fe', '#a5b4fc'],
  NEXUS: ['#c4b5fd', '#f5d0fe', '#7c3aed', '#ddd6fe', '#c4b5fd'],
  ANCHOR: ['#94a3b8', '#e2e8f0', '#475569', '#cbd5e1', '#94a3b8'],
  FLUX: ['#f9a8d4', '#fce7f3', '#db2777', '#fbcfe8', '#f9a8d4']
}

const shortLabelMap: Record<AffixVisualStyle, string> = {
  NONE: '标准',
  MONO: '黑白',
  SILVER: '银层',
  GOLD: '金层',
  CYAN: '蓝层',
  PRISM: '棱镜',
  COLORLESS: '无色',
  WILDCARD: '通配',
  SPECTRUM: '谱系',
  MIRROR: '镜像',
  ORBIT: '轨道',
  ECHO: '回声',
  NEXUS: '枢纽',
  ANCHOR: '锚点',
  FLUX: '流变'
}

function resolveStyleFromLabel(label: string | null | undefined): AffixVisualStyle {
  const raw = String(label || '').trim()
  if (!raw) return 'NONE'
  const upper = raw.toUpperCase()
  if (/GOLD|鎏金|金/.test(upper)) return 'GOLD'
  if (/PRISM|棱镜/.test(upper)) return 'PRISM'
  if (/CYAN|蓝图|青/.test(upper)) return 'CYAN'
  if (/SILVER|银/.test(upper)) return 'SILVER'
  if (/MONO|黑白/.test(upper)) return 'MONO'
  if (/COLORLESS|无色/.test(upper)) return 'COLORLESS'
  if (/WILDCARD|通配/.test(upper)) return 'WILDCARD'
  if (/SPECTRUM|谱系/.test(upper)) return 'SPECTRUM'
  if (/MIRROR|镜/.test(upper)) return 'MIRROR'
  if (/ORBIT|轨道/.test(upper)) return 'ORBIT'
  if (/ECHO|回声/.test(upper)) return 'ECHO'
  if (/NEXUS|枢纽|核心/.test(upper)) return 'NEXUS'
  if (/ANCHOR|锚点|锚定/.test(upper)) return 'ANCHOR'
  if (/FLUX|流变|脉动/.test(upper)) return 'FLUX'
  return 'NONE'
}

export function useCardAffix(source: Ref<AffixSource>, affixLabel?: Ref<string | null | undefined>) {
  const primaryStyle = computed<AffixVisualStyle>(() => {
    const fromSource = resolvePrimaryAffixStyleFromSource(source.value)
    if (fromSource !== 'NONE') return fromSource
    return resolveStyleFromLabel(affixLabel?.value)
  })

  const affixParts = computed(() =>
    resolveAffixParts(source.value)
      .filter((part) => part.style !== 'NONE' && Number(part.count || 0) > 0)
  )

  const totalLayers = computed(() =>
    affixParts.value.reduce((sum, part) => sum + Math.max(0, Number(part.count || 0)), 0)
  )

  const hasMetadata = computed(() => {
    if (totalLayers.value > 0) return true
    if (affixLabel?.value && !/标准/.test(String(affixLabel.value))) return true
    if (source.value.affixSignature && String(source.value.affixSignature).trim().toUpperCase() !== 'NONE') return true
    if (Array.isArray(source.value.affixStyles) && source.value.affixStyles.some((s) => normalizeAffixStyle(s) !== 'NONE')) return true
    if (source.value.affixStyleCounts && typeof source.value.affixStyleCounts === 'object') {
      for (const [style, countRaw] of Object.entries(source.value.affixStyleCounts)) {
        const count = Math.max(0, Number(countRaw || 0))
        if (count > 0 && normalizeAffixStyle(style as AffixVisualStyle) !== 'NONE') return true
      }
    }
    if (normalizeAffixStyle(source.value.affixVisualStyle) !== 'NONE') return true
    return resolveStyleFromLabel(affixLabel?.value) !== 'NONE'
  })

  const isCoated = computed(() => hasMetadata.value)

  const coatingLabel = computed(() => {
    if (totalLayers.value > 1 || affixParts.value.length > 1) {
      return formatAffixPartsLabel(source.value)
    }
    if (affixLabel?.value && String(affixLabel.value).trim() && !/标准/.test(String(affixLabel.value))) {
      return String(affixLabel.value).trim()
    }
    if (primaryStyle.value === 'NONE') return '标准'
    return resolveAffixDisplayName(primaryStyle.value)
  })

  const chipText = computed(() => {
    if (affixParts.value.length > 0) {
      return affixParts.value.map((part) => {
        const short = shortLabelMap[part.style] || resolveAffixDisplayName(part.style)
        if (part.count > 1) return `${short}x${part.count}`
        return short
      }).join('·')
    }
    return coatingLabel.value
  })

  const chipTextMini = computed(() => {
    if (affixParts.value.length > 0) {
      return affixParts.value.map((part) => {
        const short = shortLabelMap[part.style] || resolveAffixDisplayName(part.style)
        if (part.count > 1) return `${short}x${part.count}`
        return short
      }).join('·')
    }
    if (primaryStyle.value === 'NONE') return coatingLabel.value
    return shortLabelMap[primaryStyle.value] || coatingLabel.value
  })

  const tooltipText = computed(() => {
    if (affixParts.value.length > 0) {
      return affixParts.value.map((part) => affixPartHoverSummary(part)).join('；')
    }
    return `${coatingLabel.value}：${resolveAffixEffectSummary(primaryStyle.value)}`
  })

  const mediaFilter = computed(() =>
    primaryStyle.value !== 'NONE'
      ? affixThemeMap[primaryStyle.value]?.filter || 'none'
      : 'none'
  )

  const overlayClass = computed(() =>
    primaryStyle.value !== 'NONE'
      ? affixThemeMap[primaryStyle.value]?.overlay || ''
      : ''
  )

  const frameClass = computed(() =>
    affixThemeMap[primaryStyle.value]?.frame || affixThemeMap.NONE.frame
  )

  const chipClass = computed(() =>
    affixThemeMap[primaryStyle.value]?.chip || affixThemeMap.NONE.chip
  )

  const toneStyle = computed<Record<string, string>>(() => {
    const tone = coatingToneMap[primaryStyle.value] || coatingToneMap.NONE
    return {
      '--coating-edge': tone.edge,
      '--coating-glow': tone.glow,
      '--coating-foil': tone.foil
    }
  })

  const foilGradient = computed(() => {
    const palette = coatingFoilPalette[primaryStyle.value]
    if (!palette || palette.length <= 1) return ''
    return palette.join(', ')
  })

  return {
    primaryStyle,
    affixParts,
    totalLayers,
    hasMetadata,
    isCoated,
    coatingLabel,
    chipText,
    chipTextMini,
    tooltipText,
    mediaFilter,
    overlayClass,
    frameClass,
    chipClass,
    toneStyle,
    foilGradient
  }
}
