import type { AffixVisualStyle, AffixSourceLike, Rarity } from '~/types/gacha'
import { normalizeAffixStyle } from '~/utils/gachaAffixTheme'
import { formatPlacementPercent, formatTokens } from '~/utils/gachaFormatters'

// ═══════════════════════════════════════════════════════════
// Affix Perk Calculation (numerics)
// ═══════════════════════════════════════════════════════════

export type AffixPerkValues = {
  affixYieldBoostPercent: number
  affixOfflineBufferBonus: number
  affixDismantleBonusPercent: number
}

const PLACEMENT_DECIMAL_SCALE = 6

const AFFIX_YIELD_BASE_BY_RARITY: Record<Rarity, number> = {
  WHITE: 0.004,
  GREEN: 0.006,
  BLUE: 0.008,
  PURPLE: 0.011,
  GOLD: 0.014
}

const AFFIX_YIELD_MULTIPLIER_BY_STYLE: Record<AffixVisualStyle, number> = {
  NONE: 0,
  MONO: 0.5,
  SILVER: 0.8,
  GOLD: 1.45,
  CYAN: 0.65,
  PRISM: 1.0,
  COLORLESS: 1.8,
  WILDCARD: 0,
  SPECTRUM: 0,
  MIRROR: 0,
  ORBIT: 0,
  ECHO: 0,
  NEXUS: 1.45,
  ANCHOR: 0,
  FLUX: 0
}

const AFFIX_OFFLINE_BASE_BY_RARITY: Record<Rarity, number> = {
  WHITE: 8,
  GREEN: 12,
  BLUE: 18,
  PURPLE: 26,
  GOLD: 36
}

const AFFIX_OFFLINE_MULTIPLIER_BY_STYLE: Record<AffixVisualStyle, number> = {
  NONE: 0,
  MONO: 0.5,
  SILVER: 0.8,
  GOLD: 0.7,
  CYAN: 1.8,
  PRISM: 1.0,
  COLORLESS: 1.2,
  WILDCARD: 0,
  SPECTRUM: 0,
  MIRROR: 0,
  ORBIT: 0,
  ECHO: 0,
  NEXUS: 0.7,
  ANCHOR: 0,
  FLUX: 0
}

const AFFIX_DISMANTLE_BASE_BY_RARITY: Record<Rarity, number> = {
  WHITE: 0.02,
  GREEN: 0.03,
  BLUE: 0.04,
  PURPLE: 0.05,
  GOLD: 0.06
}

const AFFIX_DISMANTLE_MULTIPLIER_BY_STYLE: Record<AffixVisualStyle, number> = {
  NONE: 0,
  MONO: 0.5,
  SILVER: 0.8,
  GOLD: 1.2,
  CYAN: 1.0,
  PRISM: 1.6,
  COLORLESS: 2.0,
  WILDCARD: 0,
  SPECTRUM: 0,
  MIRROR: 0,
  ORBIT: 0,
  ECHO: 0,
  NEXUS: 1.2,
  ANCHOR: 0.5,
  FLUX: 0.8
}

function placementRound(value: number) {
  if (!Number.isFinite(value)) return 0
  return Number(value.toFixed(PLACEMENT_DECIMAL_SCALE))
}

export function computeAffixPerkByStyle(rarity: Rarity | null | undefined, style: AffixVisualStyle, layers = 1): AffixPerkValues {
  if (!rarity || !AFFIX_YIELD_BASE_BY_RARITY[rarity]) {
    return {
      affixYieldBoostPercent: 0,
      affixOfflineBufferBonus: 0,
      affixDismantleBonusPercent: 0
    }
  }

  const count = Math.max(0, Math.floor(Number(layers || 0)))
  if (count <= 0) {
    return {
      affixYieldBoostPercent: 0,
      affixOfflineBufferBonus: 0,
      affixDismantleBonusPercent: 0
    }
  }

  const yieldPerLayer = placementRound((AFFIX_YIELD_BASE_BY_RARITY[rarity] || 0) * (AFFIX_YIELD_MULTIPLIER_BY_STYLE[style] || 0))
  const offlinePerLayer = Math.max(0, Math.floor((AFFIX_OFFLINE_BASE_BY_RARITY[rarity] || 0) * (AFFIX_OFFLINE_MULTIPLIER_BY_STYLE[style] || 0)))
  const dismantlePerLayer = placementRound((AFFIX_DISMANTLE_BASE_BY_RARITY[rarity] || 0) * (AFFIX_DISMANTLE_MULTIPLIER_BY_STYLE[style] || 0))

  return {
    affixYieldBoostPercent: placementRound(yieldPerLayer * count),
    affixOfflineBufferBonus: Math.max(0, Math.floor(offlinePerLayer * count)),
    affixDismantleBonusPercent: placementRound(dismantlePerLayer * count)
  }
}

export function scaleAffixPerk(perk: AffixPerkValues, factor: number): AffixPerkValues {
  const safeFactor = Number.isFinite(factor) ? Math.max(0, factor) : 0
  return {
    affixYieldBoostPercent: placementRound((perk.affixYieldBoostPercent || 0) * safeFactor),
    affixOfflineBufferBonus: Math.max(0, Math.floor((perk.affixOfflineBufferBonus || 0) * safeFactor)),
    affixDismantleBonusPercent: placementRound((perk.affixDismantleBonusPercent || 0) * safeFactor)
  }
}

// ═══════════════════════════════════════════════════════════
// Affix Parsing & Display
// ═══════════════════════════════════════════════════════════

export const affixDisplayOrder: AffixVisualStyle[] = [
  'COLORLESS', 'NEXUS', 'PRISM', 'GOLD', 'CYAN', 'SILVER', 'MONO',
  'WILDCARD', 'SPECTRUM', 'MIRROR', 'ORBIT', 'ECHO', 'ANCHOR', 'FLUX', 'NONE'
]

const affixDisplayWeight = Object.fromEntries(
  affixDisplayOrder.map((style, index) => [style, index])
) as Record<AffixVisualStyle, number>

// ─── 签名解析 ────────────────────────────────────────────

export function splitAffixSignature(signature: string | null | undefined): AffixVisualStyle[] {
  const raw = String(signature || '').trim().toUpperCase()
  if (!raw) return []
  return raw
    .split(/[+,/|]/g)
    .map((token) => token.trim())
    .filter(Boolean)
    .map((token) => normalizeAffixStyle(token as AffixVisualStyle))
    .filter((style) => style !== 'NONE')
    .sort((a, b) => affixDisplayWeight[a] - affixDisplayWeight[b])
}

// ─── 样式计数解析 ────────────────────────────────────────

export function resolveAffixStyleCounts(source: AffixSourceLike | null | undefined): Partial<Record<AffixVisualStyle, number>> {
  const counts: Partial<Record<AffixVisualStyle, number>> = {}
  if (!source) {
    counts.NONE = 1
    return counts
  }
  const rawCounts = source.affixStyleCounts
  if (rawCounts && typeof rawCounts === 'object') {
    for (const [styleRaw, value] of Object.entries(rawCounts)) {
      const style = normalizeAffixStyle(styleRaw as AffixVisualStyle)
      const count = Math.max(0, Math.floor(Number(value ?? 0)))
      if (style === 'NONE' || count <= 0) continue
      counts[style] = (counts[style] || 0) + count
    }
    const total = Object.values(counts).reduce((sum, v) => sum + Number(v || 0), 0)
    if (total > 0) return counts
  }
  if (Array.isArray(source.affixStyles) && source.affixStyles.length) {
    source.affixStyles.forEach((styleRaw) => {
      const style = normalizeAffixStyle(styleRaw)
      if (style === 'NONE') return
      counts[style] = (counts[style] || 0) + 1
    })
    const total = Object.values(counts).reduce((sum, v) => sum + Number(v || 0), 0)
    if (total > 0) return counts
  }
  const fromSignature = splitAffixSignature(source.affixSignature)
  if (fromSignature.length) {
    fromSignature.forEach((style) => { counts[style] = (counts[style] || 0) + 1 })
    return counts
  }
  const fallback = normalizeAffixStyle(source.affixVisualStyle)
  counts[fallback] = 1
  return counts
}

// ─── Parts 解析 ──────────────────────────────────────────

export function resolveAffixParts(source: AffixSourceLike | null | undefined) {
  const counts = resolveAffixStyleCounts(source)
  const parts = affixDisplayOrder
    .filter((style) => style !== 'NONE' && Number(counts[style] || 0) > 0)
    .map((style) => ({ style, count: Number(counts[style] || 0) }))
  if (parts.length) return parts
  return [{ style: 'NONE' as AffixVisualStyle, count: 1 }]
}

export function resolvePrimaryAffixStyleFromSource(source: AffixSourceLike | null | undefined): AffixVisualStyle {
  const parts = resolveAffixParts(source)
  return parts
    .slice()
    .sort((a, b) => {
      if (a.count !== b.count) return b.count - a.count
      return affixDisplayWeight[a.style] - affixDisplayWeight[b.style]
    })[0]?.style || 'NONE'
}

export function resolveAffixSignatureFromSource(source: AffixSourceLike | null | undefined): string {
  if (source?.affixSignature) {
    return splitAffixSignature(source.affixSignature).join('+') || 'NONE'
  }
  const parts = resolveAffixParts(source)
  return parts
    .filter((p) => p.style !== 'NONE')
    .flatMap((p) => Array(p.count).fill(p.style))
    .join('+') || 'NONE'
}

export function hasAffixStyle(source: AffixSourceLike | null | undefined, style: AffixVisualStyle): boolean {
  const counts = resolveAffixStyleCounts(source)
  return Number(counts[style] || 0) > 0
}

// ─── 显示名称 ────────────────────────────────────────────

export function resolveAffixDisplayName(style: AffixVisualStyle): string {
  switch (style) {
    case 'MONO': return '黑白谱面'
    case 'SILVER': return '银镀层'
    case 'GOLD': return '鎏金回路'
    case 'CYAN': return '蓝图回路'
    case 'PRISM': return '棱镜折射'
    case 'COLORLESS': return '无色词条'
    case 'WILDCARD': return '通配符'
    case 'SPECTRUM': return '谱系共鸣'
    case 'MIRROR': return '镜像'
    case 'ORBIT': return '轨道'
    case 'ECHO': return '回声'
    case 'NEXUS': return '枢纽核心'
    case 'ANCHOR': return '锚点固基'
    case 'FLUX': return '流变脉动'
    default: return '标准词条'
  }
}

export function resolveAffixEffectSummary(style: AffixVisualStyle): string {
  switch (style) {
    case 'MONO':
    case 'SILVER':
    case 'GOLD':
    case 'CYAN':
    case 'PRISM':
      return '提升放置收益、离线缓冲和分解收益'
    case 'COLORLESS': return '可用于无色词条槽'
    case 'WILDCARD': return '可同时参与多个组合判定，并按实际层数提供通配层数'
    case 'SPECTRUM': return '额外计入同稀有度组合层数（每卡记 1 层）'
    case 'MIRROR': return '额外计入同卡片组合层数（每卡记 1 层）'
    case 'ORBIT': return '额外计入同页面组合层数（每卡记 1 层）'
    case 'ECHO': return '复制主词条一次用于组合判定（每卡生效 1 次）'
    case 'NEXUS': return '普通槽：收益按层数线性叠加但不参与组合；无色槽：移除所有组合，转化收益按层数放大'
    case 'ANCHOR': return '提供固定每小时产出，不受百分比加成影响'
    case 'FLUX': return '基础产出按层数线性叠加，并随触发的组合数量动态缩放'
    default: return '当前无额外词条效果'
  }
}

export function formatAffixPartLabel(part: { style: AffixVisualStyle; count: number }): string {
  const base = resolveAffixDisplayName(part.style)
  if (part.count <= 1) return base
  return `${base} x${part.count}`
}

export function affixPartHoverSummary(part: { style: AffixVisualStyle; count: number }): string {
  const summary = `${resolveAffixDisplayName(part.style)}：${resolveAffixEffectSummary(part.style)}`
  if (part.count <= 1) return summary
  return `${summary}（层数 x${part.count}）`
}

export function affixStyleGlyph(style: AffixVisualStyle): string {
  switch (style) {
    case 'MONO': return '◐'
    case 'SILVER': return '◇'
    case 'GOLD': return '◈'
    case 'CYAN': return '◆'
    case 'PRISM': return '◇'
    case 'COLORLESS': return '○'
    case 'WILDCARD': return '✦'
    case 'SPECTRUM': return '◎'
    case 'MIRROR': return '⊞'
    case 'ORBIT': return '⊛'
    case 'ECHO': return '⊜'
    case 'NEXUS': return '⊕'
    case 'ANCHOR': return '⚓'
    case 'FLUX': return '⚡'
    default: return '·'
  }
}

export function formatAffixPartsLabel(source: AffixSourceLike | null | undefined): string {
  const parts = resolveAffixParts(source)
  if (parts.length === 1 && parts[0]?.style === 'NONE') return '标准'
  return parts.map(formatAffixPartLabel).join(' + ')
}

export function resolveAffixPerkSummary(
  card: {
    affixYieldBoostPercent?: number | null
    affixOfflineBufferBonus?: number | null
    affixDismantleBonusPercent?: number | null
  } | null | undefined,
  style: AffixVisualStyle
): string {
  const yieldText = formatPlacementPercent(card?.affixYieldBoostPercent || 0)
  const offlineText = formatTokens(card?.affixOfflineBufferBonus || 0)
  const dismantleText = formatPlacementPercent(card?.affixDismantleBonusPercent || 0)
  switch (style) {
    case 'MONO': return `黑白锁定：收益 +${yieldText} · 缓冲 +${offlineText} · 分解 +${dismantleText}`
    case 'SILVER': return `银镀层：收益 +${yieldText} · 缓冲 +${offlineText} · 分解 +${dismantleText}`
    case 'GOLD': return `鎏金回路：收益 +${yieldText} · 缓冲 +${offlineText} · 分解 +${dismantleText}`
    case 'CYAN': return `蓝图回路：收益 +${yieldText} · 缓冲 +${offlineText} · 分解 +${dismantleText}`
    case 'COLORLESS': return `无色词条：收益 +${yieldText} · 缓冲 +${offlineText} · 分解 +${dismantleText}`
    case 'PRISM': return `棱镜折射：收益 +${yieldText} · 缓冲 +${offlineText} · 分解 +${dismantleText}`
    case 'WILDCARD': return '通配符：可同时参与多个组合判定，并按实际层数提供通配层数'
    case 'SPECTRUM': return '谱系共鸣：额外计入同稀有度组合层数（每卡记 1 层）'
    case 'MIRROR': return '镜像：额外计入同卡片组合层数（每卡记 1 层）'
    case 'ORBIT': return '轨道：额外计入同页面组合层数（每卡记 1 层）'
    case 'ECHO': return '回声：复制当前卡片主词条一次用于组合判定（每卡生效 1 次）'
    case 'NEXUS': return `枢纽核心：收益 +${yieldText} · 缓冲 +${offlineText} · 分解 +${dismantleText}（收益按层数叠加；无色槽转化也按层数放大）`
    case 'ANCHOR': return '锚点固基：提供固定每小时产出，不受百分比加成影响'
    case 'FLUX': return '流变脉动：基础产出按层数叠加，并随触发的组合数量动态缩放'
    default: return '标准词条：当前无额外挂机加成'
  }
}

export function placementStackKey(
  cardId: string,
  affixSignature: string | null | undefined,
  style: AffixVisualStyle | null | undefined
): string {
  return `${cardId}::${affixSignature || 'NONE'}::${style || 'NONE'}`
}

// ─── Variant Display Helpers ─────────────────────────────

export function variantStackKey(
  variant: Pick<AffixSourceLike, 'affixSignature' | 'affixVisualStyle' | 'affixStyles' | 'affixStyleCounts'> & { cardId: string }
): string {
  return `${variant.cardId}:${resolveAffixSignatureFromSource(variant)}`
}

export function estimateVariantDismantlePerCard(variant: { rewardTokens?: number; affixDismantleBonusPercent?: number }): number {
  const baseReward = Math.max(0, Number(variant.rewardTokens || 0))
  const bonusPercent = Math.max(0, Number(variant.affixDismantleBonusPercent || 0))
  return Math.max(0, Math.floor(baseReward * (1 + bonusPercent)))
}
