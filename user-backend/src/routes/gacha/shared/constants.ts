/**
 * Gacha system — pure constants, types, and configuration.
 *
 * This file contains NO mutable state and NO side effects.
 * Extracted from runtime.ts for readability.
 */

import { GachaRarity, Prisma } from '@prisma/client';

// ─── Core types ──────────────────────────────────────────────────────────────

export type Tx = Prisma.TransactionClient;

// ─── Draw & wallet ───────────────────────────────────────────────────────────

export const DAILY_REWARD = 100;
export const UTC8_OFFSET_MINUTES = 8 * 60;
export const INITIAL_WALLET_BALANCE = 500;
export const FIXED_DRAW_TOKEN_COST = 10;
export const FIXED_TEN_DRAW_TOKEN_COST = 100;
export const PURPLE_PITY_THRESHOLD = 60;
export const GOLD_PITY_THRESHOLD = 120;
export const MAX_DRAW_COUNT = 10;
export const ALLOWED_DRAW_COUNTS = new Set([1, 10]);

// ─── Placement ───────────────────────────────────────────────────────────────

export const PLACEMENT_SLOT_COUNT_DEFAULT = 5;
export const PLACEMENT_SLOT_COUNT_MAX = 10;
export const PLACEMENT_SLOT_UNLOCK_COSTS = [1000, 1500, 2000, 3000, 5000] as const;
export const PLACEMENT_BUFFER_CAP_BASE = Math.max(0, Math.floor(Number(process.env.GACHA_PLACEMENT_BUFFER_CAP_BASE ?? '3000') || 3000));
export const PLACEMENT_OPTION_LIMIT = Math.max(120, Math.floor(Number(process.env.GACHA_INVENTORY_QUERY_LIMIT_MAX ?? '1000') || 0));
export const ALBUM_PAGE_QUERY_LIMIT_MAX = 5000;
export const PLACEMENT_DECIMAL_SCALE = 6;
export const DEFAULT_PLACEMENT_YIELD_BOOST_PERCENT = Number(process.env.GACHA_PLACEMENT_YIELD_BOOST_PERCENT ?? '0');

// ─── Idempotency ─────────────────────────────────────────────────────────────

export const IDEMPOTENCY_TTL_HOURS = 24;

// ─── Card rewards ────────────────────────────────────────────────────────────

export const DEFAULT_DUPLICATE_REWARD = 0;
export const DEFAULT_CARD_WEIGHT = 1;
export const BASE_PLACEMENT_YIELD_BY_RARITY: Record<GachaRarity, number> = {
  WHITE: 0.5,
  GREEN: 0.7,
  BLUE: 1.0,
  PURPLE: 1.5,
  GOLD: 2.0
};
export const PERMANENT_POOL_ID = process.env.GACHA_PERMANENT_POOL_ID || 'permanent-main-pool';

// ─── Feature flags ───────────────────────────────────────────────────────────

export function parseBooleanEnv(value: string | undefined): boolean | null {
  if (value == null) return null;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return null;
}

const featureAllEnv = parseBooleanEnv(process.env.GACHA_FEATURE_ALL);
const defaultFeatureFlag = featureAllEnv ?? true;
export const FEATURE_FLAGS = {
  draw: parseBooleanEnv(process.env.GACHA_FEATURE_DRAW) ?? defaultFeatureFlag,
  placement: parseBooleanEnv(process.env.GACHA_FEATURE_PLACEMENT) ?? defaultFeatureFlag,
  album: parseBooleanEnv(process.env.GACHA_FEATURE_ALBUM) ?? defaultFeatureFlag,
  tickets: parseBooleanEnv(process.env.GACHA_FEATURE_TICKETS) ?? defaultFeatureFlag,
  missions: parseBooleanEnv(process.env.GACHA_FEATURE_MISSIONS) ?? defaultFeatureFlag,
  achievements: parseBooleanEnv(process.env.GACHA_FEATURE_ACHIEVEMENTS) ?? defaultFeatureFlag,
  market: parseBooleanEnv(process.env.GACHA_FEATURE_MARKET) ?? defaultFeatureFlag,
  trade: parseBooleanEnv(process.env.GACHA_FEATURE_TRADE) ?? defaultFeatureFlag,
  buyRequest: parseBooleanEnv(process.env.GACHA_FEATURE_BUY_REQUEST) ?? defaultFeatureFlag
} as const;

// ─── Market ──────────────────────────────────────────────────────────────────

export const MARKET_POSITION_MAX_OPEN = 5;
export const MARKET_LOT_TOKEN = 10;
export const INDEX_BASE = 100;
export const BFF_BASE_URL = process.env.BFF_BASE_URL || 'http://127.0.0.1:4396';
export const BFF_INTERNAL_KEY = (process.env.BFF_INTERNAL_API_KEY || '').trim();
export const BFF_INTERNAL_FETCH_TIMEOUT_MS = Math.max(1000, Math.floor(Number(process.env.BFF_INTERNAL_FETCH_TIMEOUT_MS ?? '4500') || 4500));
export const ORACLE_CACHE_TTL_MS = 30_000;
export const ORACLE_TICK_LIMIT_SNAPSHOT = 24 * 8;
export const ORACLE_TICK_LIMIT_POSITION = 24 * 40;
export const ORACLE_TICK_CACHE_LIMIT = ORACLE_TICK_LIMIT_POSITION;
export const ORACLE_TICK_TIMEFRAME_BUFFER_HOURS = 24;
export const ORACLE_NEAR_REALTIME_WINDOW_MS = 60_000;
export const MARKET_GLOBAL_POSITION_LOOKBACK_DAYS = 45;
export const MARKET_GLOBAL_POSITION_CACHE_TTL_MS = 60_000;
export const MARKET_USER_LEDGER_LOOKBACK_DAYS = 180;
export const DRAW_POOL_CACHE_TTL_MS = 60_000;

// ─── Ledger reasons ──────────────────────────────────────────────────────────

export const TICKET_LEDGER_REASON_GRANT = 'TICKET_GRANT';
export const TICKET_LEDGER_REASON_USE = 'TICKET_USE';
export const MISSION_CLAIM_REASON = 'MISSION_CLAIM';
export const ACHIEVEMENT_CLAIM_REASON = 'ACHIEVEMENT_CLAIM';
export const MARKET_OPEN_REASON = 'MARKET_POSITION_OPEN';
export const MARKET_OPEN_SPEND_REASON = 'MARKET_POSITION_OPEN_SPEND';
export const MARKET_SETTLE_REASON = 'MARKET_POSITION_SETTLE';
export const TRADE_LISTING_CREATE_REASON = 'TRADE_LISTING_CREATE';
export const TRADE_LISTING_CANCEL_REASON = 'TRADE_LISTING_CANCEL';
export const TRADE_BUY_SPEND_REASON = 'TRADE_BUY_SPEND';
export const TRADE_SELL_EARN_REASON = 'TRADE_SELL_EARN';
export const BUY_REQUEST_CREATE_REASON = 'BUY_REQUEST_CREATE';
export const BUY_REQUEST_CANCEL_REASON = 'BUY_REQUEST_CANCEL';
export const BUY_REQUEST_FULFILL_BUYER_SPEND_REASON = 'BUY_REQUEST_FULFILL_BUYER_SPEND';
export const BUY_REQUEST_FULFILL_SELLER_EARN_REASON = 'BUY_REQUEST_FULFILL_SELLER_EARN';
export const PLACEMENT_SLOT_UNLOCK_REASON = 'PLACEMENT_SLOT_UNLOCK';

// ─── Sweep config ────────────────────────────────────────────────────────────

export const BUY_REQUEST_EXPIRY_SWEEP_BATCH_SIZE = 200;
export const BUY_REQUEST_EXPIRY_SWEEP_MAX_BATCHES = 4;
export const BUY_REQUEST_EXPIRY_SWEEP_INTERVAL_MS = 30_000;
export const TRADE_EXPIRY_SWEEP_BATCH_SIZE = 400;
export const TRADE_EXPIRY_SWEEP_MAX_BATCHES_PER_RUN = 8;
export const TRADE_EXPIRY_SWEEP_INTERVAL_MS = 20_000;
export const MARKET_SETTLE_SWEEP_USER_BATCH_SIZE = 120;
export const MARKET_SETTLE_SWEEP_MAX_BATCHES_PER_RUN = 8;
export const MARKET_SETTLE_SWEEP_INTERVAL_MS = 20_000;

// ─── Missions ────────────────────────────────────────────────────────────────

export const DAILY_MISSION_KEY = 'DAILY_SPEND_200';
export const WEEKLY_MISSION_KEY = 'WEEKLY_SPEND_800';

// ─── Market lock tiers ───────────────────────────────────────────────────────

export type MarketLockTier = 'T1' | 'T7' | 'T15' | 'T30';
export type MarketPositionStatus = 'OPEN' | 'EXPIRED' | 'SETTLED' | 'LIQUIDATED';
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
    leverageOptions: [1, 2, 5, 10]
  },
  T7: {
    durationMs: 7 * 24 * 60 * 60 * 1000,
    minLots: 20,
    openFeeBaseRate: 0.007,
    settleFeeRate: 0.08,
    leverageOptions: [1, 2, 5, 10, 20]
  },
  T15: {
    durationMs: 15 * 24 * 60 * 60 * 1000,
    minLots: 30,
    openFeeBaseRate: 0.006,
    settleFeeRate: 0.08,
    leverageOptions: [1, 2, 5, 10, 20, 50]
  },
  T30: {
    durationMs: 30 * 24 * 60 * 60 * 1000,
    minLots: 50,
    openFeeBaseRate: 0.005,
    settleFeeRate: 0.08,
    leverageOptions: [1, 2, 5, 10, 20, 50, 100]
  }
};

export const MARKET_LEVERAGE_SURCHARGE_RATE: Record<number, number> = {
  1: 0,
  2: 0.002,
  5: 0.008,
  10: 0.018,
  20: 0.04,
  50: 0.10,
  100: 0.22
};

// ─── Domain types ────────────────────────────────────────────────────────────

export type TicketBalance = {
  drawTicket: number;
  draw10Ticket: number;
  affixReforgeTicket: number;
};

export type WalletPityCounters = {
  purplePityCount: number;
  goldPityCount: number;
};

export type DrawPaymentMethod = 'TOKEN' | 'DRAW_TICKET' | 'DRAW10_TICKET' | 'AUTO';
export type DismantleKeepScope = 'CARD' | 'VARIANT';
export type TradeSearchMode = 'ALL' | 'CARD' | 'SELLER';
export type TradeSortMode = 'LATEST' | 'PRICE_ASC' | 'PRICE_DESC' | 'TOTAL_ASC' | 'TOTAL_DESC' | 'RARITY_DESC';

export const DISMANTLE_KEEP_SCOPE_VALUES = ['CARD', 'VARIANT'] as const;
export const TRADE_SEARCH_MODE_VALUES = ['ALL', 'CARD', 'SELLER'] as const;
export const TRADE_SORT_MODE_VALUES = ['LATEST', 'PRICE_ASC', 'PRICE_DESC', 'TOTAL_ASC', 'TOTAL_DESC', 'RARITY_DESC'] as const;

export const AUTHOR_CARD_SEARCH_LIMIT = 2000;
export const AUTHOR_BFF_PAGE_LOOKUP_LIMIT = 2200;
export const AUTHOR_BFF_USER_LOOKUP_LIMIT = 160;
export const AUTHOR_SEARCH_CACHE_TTL_MS = 3 * 60 * 1000;

export type RewardPack = {
  tokens?: number;
  tickets?: Partial<TicketBalance>;
};

export type MarketCategory = 'OVERALL' | 'TRANSLATION' | 'SCP' | 'TALE' | 'GOI' | 'WANDERERS';

export type MarketContractDefinition = {
  id: MarketCategory;
  category: MarketCategory;
  symbol: MarketCategory;
  name: string;
};

export type MarketPositionSide = 'LONG' | 'SHORT';
export type MissionPeriodType = 'daily' | 'weekly';

export type MissionDefinition = {
  key: string;
  title: string;
  description: string;
  target: number;
  periodType: MissionPeriodType;
  reward: RewardPack;
};

export type AchievementDefinition = {
  key: string;
  title: string;
  description: string;
  target: number;
  metric: (stats: UserGachaStats) => number;
  reward: RewardPack;
  hidden?: boolean;
};

export type UserGachaStats = {
  totalDraws: number;
  uniqueCards: number;
  goldCardsDrawn: number;
  purpleCardsDrawn: number;
  placementClaims: number;
  placementTokensEarned: number;
  dailyClaims: number;
  marketProfit: number;
  marketLoss: number;
  tradeSells: number;
  dismantleCount: number;
  affixReforgeCount: number;
  totalTokensSpent: number;
};

export const EMPTY_TICKETS: TicketBalance = {
  drawTicket: 0,
  draw10Ticket: 0,
  affixReforgeTicket: 0
};

export const MARKET_CATEGORIES: MarketCategory[] = [
  'OVERALL',
  'TRANSLATION',
  'SCP',
  'TALE',
  'GOI',
  'WANDERERS'
];

export const MARKET_CONTRACT_ALIASES: Record<string, MarketCategory> = {
  'SCP-INDEX': 'SCP',
  'SCPI': 'SCP',
  'RARE-SURGE': 'OVERALL',
  'RSGE': 'OVERALL',
  'ANOMALY-SIGNAL': 'TALE',
  'ANOM': 'TALE'
};

export const MARKET_CONTRACTS: MarketContractDefinition[] = [
  { id: 'OVERALL', category: 'OVERALL', symbol: 'OVERALL', name: '全站指数' },
  { id: 'TRANSLATION', category: 'TRANSLATION', symbol: 'TRANSLATION', name: '译文指数' },
  { id: 'SCP', category: 'SCP', symbol: 'SCP', name: 'SCP 指数' },
  { id: 'TALE', category: 'TALE', symbol: 'TALE', name: '故事指数' },
  { id: 'GOI', category: 'GOI', symbol: 'GOI', name: 'GOI 指数' },
  { id: 'WANDERERS', category: 'WANDERERS', symbol: 'WANDERERS', name: '图书馆指数' }
];

export type MarketTickTimeframe = '24H' | '7D' | '30D';

export type OracleTick = {
  category: MarketCategory;
  asOfTs: Date;
  watermarkTs: Date | null;
  voteCutoffDate: string;
  voteRuleVersion: string;
  indexMark: number;
};

export type OracleCacheEntry = {
  fetchedAt: number;
  limit: number;
  items: OracleTick[];
};

export type OracleInflightEntry = {
  limit: number;
  asOfTsMs: number;
  promise: Promise<OracleTick[]>;
};

export type AuthorCardSearchCacheEntry = {
  expiresAt: number;
  cardIds: string[];
};

export type DrawPoolCardSnapshot = {
  id: string;
  title: string;
  rarity: GachaRarity;
  tags: string[];
  authors: Array<{ name: string; wikidotId: number | null }> | null;
  imageUrl: string | null;
  wikidotId: number | null;
  pageId: number | null;
  rewardTokens: number;
  adjustedWeight: number;
  variants: Array<{ id: string; imageUrl: string | null }>;
};
