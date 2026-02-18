import type {
  Rarity,
  MarketLockTier,
  MarketLockTierMeta,
  TradeListing,
  BuyRequestStatus,
  BuyRequestMatchLevel,
  AffixVisualStyle
} from '~/types/gacha'

// ─── Type Aliases ──────────────────────────────────────

export type TradeSortMode = 'LATEST' | 'PRICE_ASC' | 'PRICE_DESC' | 'TOTAL_ASC' | 'TOTAL_DESC' | 'RARITY_DESC'
export type BuyRequestSortMode = 'LATEST' | 'TOKEN_DESC' | 'TOKEN_ASC' | 'EXPIRY_ASC' | 'RARITY_DESC'
export type MarketLockTierViewMeta = {
  label: string
  durationLabel: string
  minLots: number
  leverageOptions: number[]
  stakePreset: number[]
  openFeeBaseRate: number
}

// ─── Pool Status Maps ──────────────────────────────────
// PoolStatusKey is already exported from gachaFormatters.ts

import type { PoolStatusKey } from '~/utils/gachaFormatters'

export const poolStatusLabelMap: Record<PoolStatusKey, string> = {
  active: '开放中',
  upcoming: '即将开放',
  inactive: '未开放',
  ended: '已结束'
}

export const poolBadgeClassMap: Record<PoolStatusKey, string> = {
  active: 'bg-emerald-50/90 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-200',
  upcoming: 'bg-amber-50/90 text-amber-700 dark:bg-amber-500/20 dark:text-amber-200',
  inactive: 'bg-neutral-100 text-neutral-500 dark:bg-neutral-800/70 dark:text-neutral-300',
  ended: 'bg-neutral-100 text-neutral-500 dark:bg-neutral-800/70 dark:text-neutral-400'
}

export const poolCardClassMap: Record<PoolStatusKey, string> = {
  active: 'border-emerald-200/70 bg-emerald-50/50 dark:border-emerald-500/40 dark:bg-emerald-500/10',
  upcoming: 'border-amber-200/70 bg-amber-50/50 dark:border-amber-500/40 dark:bg-amber-500/10',
  inactive: 'border-neutral-200/70 bg-white/70 dark:border-neutral-700/60 dark:bg-neutral-900/50',
  ended: 'border-neutral-200/70 bg-neutral-100/60 dark:border-neutral-700/60 dark:bg-neutral-900/50'
}

export const poolTextClassMap: Record<PoolStatusKey, string> = {
  active: 'text-neutral-600 dark:text-neutral-300',
  upcoming: 'text-neutral-600 dark:text-neutral-300',
  inactive: 'text-neutral-500 dark:text-neutral-400',
  ended: 'text-neutral-500 dark:text-neutral-500'
}

export const poolPriorityMap: Record<PoolStatusKey, number> = {
  active: 0,
  upcoming: 1,
  inactive: 2,
  ended: 3
}

// ─── History Chip Maps ─────────────────────────────────

export const historyChipClassMap: Record<Rarity, string> = {
  GOLD: 'border-amber-300 bg-amber-50/80 text-amber-700 dark:border-amber-400/60 dark:bg-amber-500/10 dark:text-amber-200',
  PURPLE: 'border-purple-300 bg-purple-50/80 text-purple-700 dark:border-purple-400/60 dark:bg-purple-500/10 dark:text-purple-200',
  BLUE: 'border-blue-300 bg-blue-50/80 text-blue-700 dark:border-blue-400/60 dark:bg-blue-500/10 dark:text-blue-200',
  GREEN: 'border-emerald-300 bg-emerald-50/80 text-emerald-700 dark:border-emerald-400/60 dark:bg-emerald-500/10 dark:text-emerald-200',
  WHITE: 'border-neutral-200 bg-white/80 text-neutral-600 dark:border-neutral-700 dark:bg-neutral-900/60 dark:text-neutral-300'
}

export const historyChipDotClassMap: Record<Rarity, string> = {
  GOLD: 'bg-amber-400',
  PURPLE: 'bg-purple-400',
  BLUE: 'bg-blue-400',
  GREEN: 'bg-emerald-400',
  WHITE: 'bg-neutral-400'
}

// ─── Placement Maps ────────────────────────────────────

export const placementSlotCardClassMap: Record<Rarity, string> = {
  GOLD: 'placement-slot-card--gold',
  PURPLE: 'placement-slot-card--purple',
  BLUE: 'placement-slot-card--blue',
  GREEN: 'placement-slot-card--green',
  WHITE: 'placement-slot-card--white'
}

// ─── Trade Maps ────────────────────────────────────────

export const tradeStatusLabelMap: Record<TradeListing['status'], string> = {
  OPEN: '进行中',
  SOLD: '已售罄',
  CANCELLED: '已撤销',
  EXPIRED: '已过期'
}

export const tradeStatusChipClassMap: Record<TradeListing['status'], string> = {
  OPEN: 'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-500/40 dark:bg-emerald-500/10 dark:text-emerald-200',
  SOLD: 'border-blue-300 bg-blue-50 text-blue-700 dark:border-blue-500/40 dark:bg-blue-500/10 dark:text-blue-200',
  CANCELLED: 'border-neutral-300 bg-neutral-100 text-neutral-600 dark:border-neutral-600 dark:bg-neutral-800/70 dark:text-neutral-300',
  EXPIRED: 'border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200'
}

export const tradeSortLabelMap: Record<TradeSortMode, string> = {
  LATEST: '按上架时间',
  PRICE_ASC: '按单价升序',
  PRICE_DESC: '按单价降序',
  TOTAL_ASC: '按总价升序',
  TOTAL_DESC: '按总价降序',
  RARITY_DESC: '按稀有度'
}

// ─── Album Page Rarity Card Classes ────────────────────

export const albumPageRarityCardClassMap: Record<Rarity, string> = {
  GOLD: 'border-amber-300/75 bg-gradient-to-b from-amber-50/90 via-white/95 to-amber-100/75 dark:border-amber-500/45 dark:from-amber-500/12 dark:via-neutral-900/78 dark:to-amber-500/10',
  PURPLE: 'border-purple-300/75 bg-gradient-to-b from-purple-50/90 via-white/95 to-purple-100/75 dark:border-purple-500/45 dark:from-purple-500/12 dark:via-neutral-900/78 dark:to-purple-500/10',
  BLUE: 'border-blue-300/75 bg-gradient-to-b from-blue-50/90 via-white/95 to-blue-100/75 dark:border-blue-500/45 dark:from-blue-500/12 dark:via-neutral-900/78 dark:to-blue-500/10',
  GREEN: 'border-emerald-300/75 bg-gradient-to-b from-emerald-50/90 via-white/95 to-emerald-100/75 dark:border-emerald-500/45 dark:from-emerald-500/12 dark:via-neutral-900/78 dark:to-emerald-500/10',
  WHITE: 'border-neutral-200/75 bg-gradient-to-b from-neutral-50/90 via-white/95 to-neutral-100/70 dark:border-neutral-700/70 dark:from-neutral-900/72 dark:via-neutral-900/76 dark:to-neutral-950/72'
}

// ─── Mission Status Rank ───────────────────────────────

export const missionStatusRank = { claimable: 0, pending: 1, claimed: 2 } as const

// ─── Market Lock Tier Fallback ─────────────────────────

export const fallbackMarketLockTierMeta: Record<MarketLockTier, MarketLockTierViewMeta> = {
  T1: {
    label: 'T1（24h）',
    durationLabel: '24 小时',
    minLots: 10,
    leverageOptions: [1, 2, 5, 10],
    stakePreset: [100, 200, 500, 1000],
    openFeeBaseRate: 0.008
  },
  T7: {
    label: 'T7（168h）',
    durationLabel: '7 天',
    minLots: 20,
    leverageOptions: [1, 2, 5, 10, 20],
    stakePreset: [200, 400, 800, 1600],
    openFeeBaseRate: 0.007
  },
  T15: {
    label: 'T15（360h）',
    durationLabel: '15 天',
    minLots: 30,
    leverageOptions: [1, 2, 5, 10, 20, 50],
    stakePreset: [300, 600, 1200, 2400],
    openFeeBaseRate: 0.006
  },
  T30: {
    label: 'T30（720h）',
    durationLabel: '30 天',
    minLots: 50,
    leverageOptions: [1, 2, 5, 10, 20, 50, 100],
    stakePreset: [500, 1000, 2000, 5000],
    openFeeBaseRate: 0.005
  }
}

// ─── Placement Picker Rarity Filters ───────────────────

export const placementPickerRarityFilters: Array<Rarity | 'ALL'> = ['ALL', 'GOLD', 'PURPLE', 'BLUE', 'GREEN', 'WHITE']

// ─── Buy Request Maps ────────────────────────────────

export const buyRequestStatusLabelMap: Record<BuyRequestStatus, string> = {
  OPEN: '求购中',
  FULFILLED: '已成交',
  CANCELLED: '已撤销',
  EXPIRED: '已过期'
}

export const buyRequestStatusChipClassMap: Record<BuyRequestStatus, string> = {
  OPEN: 'border-cyan-300 bg-cyan-50 text-cyan-700 dark:border-cyan-500/40 dark:bg-cyan-500/10 dark:text-cyan-200',
  FULFILLED: 'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-500/40 dark:bg-emerald-500/10 dark:text-emerald-200',
  CANCELLED: 'border-neutral-300 bg-neutral-100 text-neutral-600 dark:border-neutral-600 dark:bg-neutral-800/70 dark:text-neutral-300',
  EXPIRED: 'border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200'
}

export const buyRequestSortLabelMap: Record<BuyRequestSortMode, string> = {
  LATEST: '按发布时间',
  TOKEN_DESC: '按出价降序',
  TOKEN_ASC: '按出价升序',
  EXPIRY_ASC: '按到期时间',
  RARITY_DESC: '按稀有度'
}

export const buyRequestMatchLevelLabelMap: Record<BuyRequestMatchLevel, string> = {
  PAGE: '同页面（任意画/镀层）',
  IMAGE_VARIANT: '同画面（任意镀层）',
  COATING: '指定镀层'
}

export const buyRequestMatchLevelShortMap: Record<BuyRequestMatchLevel, string> = {
  PAGE: '页面',
  IMAGE_VARIANT: '画面',
  COATING: '镀层'
}

export const coatingStyleLabelMap: Record<AffixVisualStyle, string> = {
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
