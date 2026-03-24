/**
 * Shared constants used by both frontend and backend.
 *
 * Only values needed on both sides belong here.
 * Backend-only constants (sweep intervals, env configs, etc.) stay in
 * user-backend/src/routes/gacha/shared/constants.ts.
 */

import type { Rarity, MarketCategory, MarketLockTier } from './enums.js';
import type { TicketBalance, MarketContractDefinition } from './api-types.js';

// ─── Rarity-based placement yield ───────────────────────────────────────────

export const BASE_PLACEMENT_YIELD_BY_RARITY: Record<Rarity, number> = {
  WHITE: 0.5,
  GREEN: 0.7,
  BLUE: 1.0,
  PURPLE: 1.5,
  GOLD: 2.0,
};

// ─── Ticket defaults ────────────────────────────────────────────────────────

export const EMPTY_TICKETS: TicketBalance = {
  drawTicket: 0,
  draw10Ticket: 0,
  affixReforgeTicket: 0,
};

// ─── Market ─────────────────────────────────────────────────────────────────

export const MARKET_CATEGORIES: MarketCategory[] = [
  'OVERALL',
  'TRANSLATION',
  'SCP',
  'TALE',
  'GOI',
  'WANDERERS',
];

export const MARKET_CONTRACTS: MarketContractDefinition[] = [
  { id: 'OVERALL', category: 'OVERALL', symbol: 'OVERALL', name: '全站指数' },
  { id: 'TRANSLATION', category: 'TRANSLATION', symbol: 'TRANSLATION', name: '译文指数' },
  { id: 'SCP', category: 'SCP', symbol: 'SCP', name: 'SCP 指数' },
  { id: 'TALE', category: 'TALE', symbol: 'TALE', name: '故事指数' },
  { id: 'GOI', category: 'GOI', symbol: 'GOI', name: 'GOI 指数' },
  { id: 'WANDERERS', category: 'WANDERERS', symbol: 'WANDERERS', name: '图书馆指数' },
];

export const MARKET_CONTRACT_ALIASES: Record<string, MarketCategory> = {
  'SCP-INDEX': 'SCP',
  'SCPI': 'SCP',
  'RARE-SURGE': 'OVERALL',
  'RSGE': 'OVERALL',
  'ANOMALY-SIGNAL': 'TALE',
  'ANOM': 'TALE',
};

export const MARKET_LOCK_TIERS: MarketLockTier[] = ['T1', 'T7', 'T15', 'T30'];

export const MARKET_LOCK_TIER_CONFIG: Record<MarketLockTier, {
  durationMs: number;
  minLots: number;
  openFeeBaseRate: number;
  settleFeeRate: number;
  leverageOptions: number[];
}> = {
  T1: {
    durationMs: 24 * 60 * 60 * 1000,
    minLots: 10,
    openFeeBaseRate: 0.008,
    settleFeeRate: 0.08,
    leverageOptions: [1, 2, 5, 10],
  },
  T7: {
    durationMs: 7 * 24 * 60 * 60 * 1000,
    minLots: 20,
    openFeeBaseRate: 0.007,
    settleFeeRate: 0.08,
    leverageOptions: [1, 2, 5, 10, 20],
  },
  T15: {
    durationMs: 15 * 24 * 60 * 60 * 1000,
    minLots: 30,
    openFeeBaseRate: 0.006,
    settleFeeRate: 0.08,
    leverageOptions: [1, 2, 5, 10, 20, 50],
  },
  T30: {
    durationMs: 30 * 24 * 60 * 60 * 1000,
    minLots: 50,
    openFeeBaseRate: 0.005,
    settleFeeRate: 0.08,
    leverageOptions: [1, 2, 5, 10, 20, 50, 100],
  },
};

export const MARKET_LEVERAGE_SURCHARGE_RATE: Record<number, number> = {
  1: 0,
  2: 0.002,
  5: 0.008,
  10: 0.018,
  20: 0.04,
  50: 0.10,
  100: 0.22,
};

// ─── Validation arrays ──────────────────────────────────────────────────────

export const DISMANTLE_KEEP_SCOPE_VALUES = ['CARD', 'VARIANT'] as const;
export const TRADE_SEARCH_MODE_VALUES = ['ALL', 'CARD', 'SELLER'] as const;
export const TRADE_SORT_MODE_VALUES = ['LATEST', 'PRICE_ASC', 'PRICE_DESC', 'TOTAL_ASC', 'TOTAL_DESC', 'RARITY_DESC'] as const;
