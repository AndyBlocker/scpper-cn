import { createHash, randomUUID } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { Prisma, GachaRarity, GachaMatchMode, GachaAffixVisualStyle as PrismaAffixVisualStyle } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../db.js';
import { requireAuth } from '../../middleware/requireAuth.js';
import { requireAdmin } from '../../middleware/requireAdmin.js';

import {
  type Tx, type MarketLockTier, type MarketPositionStatus, type TicketBalance,
  type WalletPityCounters, type DrawPaymentMethod, type DismantleKeepScope,
  type TradeSearchMode, type TradeSortMode, type RewardPack, type MarketCategory,
  type MarketContractDefinition, type MarketPositionSide, type MissionPeriodType,
  type MissionDefinition, type AchievementDefinition, type UserGachaStats,
  type MarketTickTimeframe, type OracleTick, type OracleCacheEntry,
  type OracleInflightEntry, type AuthorCardSearchCacheEntry, type DrawPoolCardSnapshot,
  DAILY_REWARD, UTC8_OFFSET_MINUTES, INITIAL_WALLET_BALANCE,
  FIXED_DRAW_TOKEN_COST, FIXED_TEN_DRAW_TOKEN_COST,
  PURPLE_PITY_THRESHOLD, GOLD_PITY_THRESHOLD, MAX_DRAW_COUNT, ALLOWED_DRAW_COUNTS,
  PLACEMENT_SLOT_COUNT_DEFAULT, PLACEMENT_SLOT_COUNT_MAX, PLACEMENT_SLOT_UNLOCK_COSTS,
  PLACEMENT_BUFFER_CAP_BASE, PLACEMENT_OPTION_LIMIT, ALBUM_PAGE_QUERY_LIMIT_MAX,
  PLACEMENT_DECIMAL_SCALE, DEFAULT_PLACEMENT_YIELD_BOOST_PERCENT,
  IDEMPOTENCY_TTL_HOURS, DEFAULT_DUPLICATE_REWARD, DEFAULT_CARD_WEIGHT,
  BASE_PLACEMENT_YIELD_BY_RARITY, PERMANENT_POOL_ID, FEATURE_FLAGS,
  MARKET_POSITION_MAX_OPEN, MARKET_LOT_TOKEN, INDEX_BASE,
  BFF_BASE_URL, BFF_INTERNAL_KEY, BFF_INTERNAL_FETCH_TIMEOUT_MS,
  ORACLE_CACHE_TTL_MS, ORACLE_TICK_LIMIT_SNAPSHOT, ORACLE_TICK_LIMIT_POSITION,
  ORACLE_TICK_CACHE_LIMIT, ORACLE_TICK_TIMEFRAME_BUFFER_HOURS,
  ORACLE_NEAR_REALTIME_WINDOW_MS, MARKET_GLOBAL_POSITION_LOOKBACK_DAYS,
  MARKET_GLOBAL_POSITION_CACHE_TTL_MS, MARKET_USER_LEDGER_LOOKBACK_DAYS,
  DRAW_POOL_CACHE_TTL_MS, TICKET_LEDGER_REASON_GRANT, TICKET_LEDGER_REASON_USE,
  MISSION_CLAIM_REASON, ACHIEVEMENT_CLAIM_REASON,
  MARKET_OPEN_REASON, MARKET_OPEN_SPEND_REASON, MARKET_SETTLE_REASON,
  TRADE_LISTING_CREATE_REASON, TRADE_LISTING_CANCEL_REASON,
  TRADE_BUY_SPEND_REASON, TRADE_SELL_EARN_REASON,
  BUY_REQUEST_CREATE_REASON, BUY_REQUEST_CANCEL_REASON,
  BUY_REQUEST_FULFILL_BUYER_SPEND_REASON, BUY_REQUEST_FULFILL_SELLER_EARN_REASON,
  BUY_REQUEST_EXPIRY_SWEEP_BATCH_SIZE, BUY_REQUEST_EXPIRY_SWEEP_MAX_BATCHES,
  BUY_REQUEST_EXPIRY_SWEEP_INTERVAL_MS, PLACEMENT_SLOT_UNLOCK_REASON,
  TRADE_EXPIRY_SWEEP_BATCH_SIZE, TRADE_EXPIRY_SWEEP_MAX_BATCHES_PER_RUN,
  TRADE_EXPIRY_SWEEP_INTERVAL_MS, MARKET_SETTLE_SWEEP_USER_BATCH_SIZE,
  MARKET_SETTLE_SWEEP_MAX_BATCHES_PER_RUN, MARKET_SETTLE_SWEEP_INTERVAL_MS,
  DAILY_MISSION_KEY, WEEKLY_MISSION_KEY,
  MARKET_LOCK_TIERS, MARKET_LOCK_TIER_CONFIG, MARKET_LEVERAGE_SURCHARGE_RATE,
  DISMANTLE_KEEP_SCOPE_VALUES, TRADE_SEARCH_MODE_VALUES, TRADE_SORT_MODE_VALUES,
  AUTHOR_CARD_SEARCH_LIMIT, AUTHOR_BFF_PAGE_LOOKUP_LIMIT,
  AUTHOR_BFF_USER_LOOKUP_LIMIT, AUTHOR_SEARCH_CACHE_TTL_MS,
  EMPTY_TICKETS, MARKET_CATEGORIES, MARKET_CONTRACT_ALIASES, MARKET_CONTRACTS,
  parseBooleanEnv,
} from './shared/constants.js';

const oracleTickCache = new Map<MarketCategory, OracleCacheEntry>();
const oracleTickInflight = new Map<MarketCategory, OracleInflightEntry>();
const authorCardSearchCache = new Map<string, AuthorCardSearchCacheEntry>();
let drawPoolCache: {
  fetchedAt: number;
  items: DrawPoolCardSnapshot[];
} | null = null;
let globalMarketPositionCache: {
  fetchedAt: number;
  asOfTs: Date;
  items: GlobalActiveMarketPosition[];
} | null = null;
let tradeExpirySweepLastRunAt = 0;
let tradeExpirySweepInFlight: Promise<number> | null = null;
let buyRequestExpirySweepLastRunAt = 0;
let buyRequestExpirySweepInFlight: Promise<number> | null = null;
let marketSettleSweepLastRunAt = 0;
let marketSettleSweepInFlight: Promise<number> | null = null;
let marketSettleSweepCursor: string | null = null;
const TEN_DRAW_REFORGE_REWARD: TicketBalance = {
  drawTicket: 0,
  draw10Ticket: 0,
  affixReforgeTicket: 1
};
const TEN_DRAW_REFORGE_SOURCE = 'TEN_DRAW_COMPLETION_BONUS';

function invalidateDrawPoolCache() {
  drawPoolCache = null;
}

function invalidateGlobalMarketPositionCache() {
  globalMarketPositionCache = null;
}

const MISSION_DEFINITIONS: MissionDefinition[] = [
  {
    key: DAILY_MISSION_KEY,
    title: '每日消耗 200',
    description: '当日累计 Token 消耗达到 200（抽卡 + 开仓）',
    target: 200,
    periodType: 'daily',
    reward: { tickets: { drawTicket: 3 } }
  },
  {
    key: WEEKLY_MISSION_KEY,
    title: '每周消耗 800',
    description: '当周累计 Token 消耗达到 800（抽卡 + 开仓）',
    target: 800,
    periodType: 'weekly',
    reward: { tickets: { drawTicket: 10, affixReforgeTicket: 2 } }
  },
  {
    key: 'DAILY_DRAW_5',
    title: '每日抽卡 5 次',
    description: '当日累计抽卡次数达到 5（十连抽算 10 次）',
    target: 5,
    periodType: 'daily',
    reward: { tickets: { drawTicket: 1 } }
  },
  {
    key: 'DAILY_CLAIM_PLACEMENT',
    title: '每日领取放置收益',
    description: '当日领取至少 1 次放置收益',
    target: 1,
    periodType: 'daily',
    reward: { tokens: 20 }
  },
  {
    key: 'WEEKLY_COLLECT_3',
    title: '每周收集 3 种新卡',
    description: '当周首次获得 3 种不同的卡片',
    target: 3,
    periodType: 'weekly',
    reward: { tickets: { drawTicket: 3, affixReforgeTicket: 1 } }
  },
  {
    key: 'WEEKLY_TRADE_1',
    title: '每周完成交易',
    description: '当周成功完成至少 1 笔交易（买入或卖出）',
    target: 1,
    periodType: 'weekly',
    reward: { tickets: { drawTicket: 2, affixReforgeTicket: 1 } }
  },
  {
    key: 'WEEKLY_DRAW_50',
    title: '每周抽卡 50 次',
    description: '当周累计抽卡次数达到 50（十连抽算 10 次）',
    target: 50,
    periodType: 'weekly',
    reward: { tickets: { drawTicket: 5, affixReforgeTicket: 1 } }
  },
  {
    key: 'WEEKLY_DISMANTLE_5',
    title: '每周分解 5 次',
    description: '当周累计分解卡片操作达到 5 次',
    target: 5,
    periodType: 'weekly',
    reward: { tickets: { drawTicket: 2 }, tokens: 30 }
  }
];

const ACHIEVEMENT_DEFINITIONS: AchievementDefinition[] = [
  // ─── 抽卡次数阶梯 (10-draw = 10次) ─────────────────
  {
    key: 'total-draws-50',
    title: '初出茅庐',
    description: '累计抽卡 50 次',
    target: 50,
    metric: (stats) => stats.totalDraws,
    reward: { tickets: { drawTicket: 2 }, tokens: 100 }
  },
  {
    key: 'total-draws-100',
    title: '抽卡达人',
    description: '累计抽卡 100 次',
    target: 100,
    metric: (stats) => stats.totalDraws,
    reward: { tickets: { drawTicket: 3 }, tokens: 200 }
  },
  {
    key: 'total-draws-200',
    title: '抽卡专家',
    description: '累计抽卡 200 次',
    target: 200,
    metric: (stats) => stats.totalDraws,
    reward: { tickets: { drawTicket: 5, draw10Ticket: 1 }, tokens: 300 }
  },
  {
    key: 'total-draws-500',
    title: '卡池常客',
    description: '累计抽卡 500 次',
    target: 500,
    metric: (stats) => stats.totalDraws,
    reward: { tickets: { draw10Ticket: 2, affixReforgeTicket: 5 }, tokens: 500 }
  },
  {
    key: 'total-draws-1000',
    title: '抽卡狂人',
    description: '累计抽卡 1000 次',
    target: 1000,
    metric: (stats) => stats.totalDraws,
    reward: { tickets: { draw10Ticket: 3, affixReforgeTicket: 8 }, tokens: 800 }
  },

  // ─── 收集阶梯 ──────────────────────────────────────
  {
    key: 'unique-20',
    title: '崭新收藏',
    description: '解锁 20 种不同卡片',
    target: 20,
    metric: (stats) => stats.uniqueCards,
    reward: { tickets: { drawTicket: 2 }, tokens: 60 }
  },
  {
    key: 'unique-60',
    title: '收藏大师',
    description: '解锁 60 种不同卡片',
    target: 60,
    metric: (stats) => stats.uniqueCards,
    reward: { tickets: { drawTicket: 3 }, tokens: 200 }
  },
  {
    key: 'unique-120',
    title: '全能收藏家',
    description: '解锁 120 种不同卡片',
    target: 120,
    metric: (stats) => stats.uniqueCards,
    reward: { tickets: { draw10Ticket: 1, affixReforgeTicket: 5 }, tokens: 400 }
  },
  {
    key: 'unique-200',
    title: '传说收藏家',
    description: '解锁 200 种不同卡片',
    target: 200,
    metric: (stats) => stats.uniqueCards,
    reward: { tickets: { draw10Ticket: 2, affixReforgeTicket: 8 }, tokens: 600 }
  },
  {
    key: 'unique-350',
    title: '万象典藏',
    description: '解锁 350 种不同卡片',
    target: 350,
    metric: (stats) => stats.uniqueCards,
    reward: { tickets: { draw10Ticket: 3, affixReforgeTicket: 10 }, tokens: 1000 }
  },

  // ─── 金卡阶梯 ──────────────────────────────────────
  {
    key: 'gold-3',
    title: '金光初现',
    description: '累计抽到 3 张金卡',
    target: 3,
    metric: (stats) => stats.goldCardsDrawn,
    reward: { tickets: { drawTicket: 2 }, tokens: 50 }
  },
  {
    key: 'gold-12',
    title: '金色追逐者',
    description: '累计抽到 12 张金卡',
    target: 12,
    metric: (stats) => stats.goldCardsDrawn,
    reward: { tickets: { draw10Ticket: 1 }, tokens: 120 }
  },
  {
    key: 'gold-30',
    title: '黄金猎手',
    description: '累计抽到 30 张金卡',
    target: 30,
    metric: (stats) => stats.goldCardsDrawn,
    reward: { tickets: { draw10Ticket: 1, affixReforgeTicket: 3 }, tokens: 300 }
  },
  {
    key: 'gold-50',
    title: '黄金传说',
    description: '累计抽到 50 张金卡',
    target: 50,
    metric: (stats) => stats.goldCardsDrawn,
    reward: { tickets: { draw10Ticket: 2, affixReforgeTicket: 5 }, tokens: 500 }
  },

  // ─── 签到阶梯 ──────────────────────────────────────
  {
    key: 'daily-7',
    title: '初来乍到',
    description: '累计每日签到 7 天',
    target: 7,
    metric: (stats) => stats.dailyClaims,
    reward: { tickets: { drawTicket: 1 }, tokens: 50 }
  },
  {
    key: 'daily-14',
    title: '稳定签到者',
    description: '累计每日签到 14 天',
    target: 14,
    metric: (stats) => stats.dailyClaims,
    reward: { tickets: { affixReforgeTicket: 2 }, tokens: 80 }
  },
  {
    key: 'daily-30',
    title: '坚持不懈',
    description: '累计每日签到 30 天',
    target: 30,
    metric: (stats) => stats.dailyClaims,
    reward: { tickets: { draw10Ticket: 1, affixReforgeTicket: 3 }, tokens: 300 }
  },
  {
    key: 'daily-60',
    title: '铁杆玩家',
    description: '累计每日签到 60 天',
    target: 60,
    metric: (stats) => stats.dailyClaims,
    reward: { tickets: { draw10Ticket: 1, affixReforgeTicket: 5 }, tokens: 500 }
  },
  {
    key: 'daily-100',
    title: '百日传奇',
    description: '累计每日签到 100 天',
    target: 100,
    metric: (stats) => stats.dailyClaims,
    reward: { tickets: { draw10Ticket: 2, affixReforgeTicket: 8 }, tokens: 800 }
  },

  // ─── 放置收益阶梯 ──────────────────────────────────
  {
    key: 'placement-10',
    title: '小试牛刀',
    description: '累计领取放置收益 10 次',
    target: 10,
    metric: (stats) => stats.placementClaims,
    reward: { tokens: 80 }
  },
  {
    key: 'placement-30',
    title: '收益猎手',
    description: '累计领取放置收益 30 次',
    target: 30,
    metric: (stats) => stats.placementClaims,
    reward: { tickets: { affixReforgeTicket: 1 }, tokens: 200 }
  },
  {
    key: 'placement-100',
    title: '放置大亨',
    description: '累计领取放置收益 100 次',
    target: 100,
    metric: (stats) => stats.placementClaims,
    reward: { tickets: { draw10Ticket: 1, affixReforgeTicket: 3 }, tokens: 400 }
  },
  {
    key: 'placement-300',
    title: '放置帝国',
    description: '累计领取放置收益 300 次',
    target: 300,
    metric: (stats) => stats.placementClaims,
    reward: { tickets: { draw10Ticket: 2, affixReforgeTicket: 5 }, tokens: 600 }
  },
  {
    key: 'placement-earn-1000',
    title: '躺赢人生',
    description: '放置累计获得 1000 Token',
    target: 1000,
    metric: (stats) => stats.placementTokensEarned,
    reward: { tickets: { drawTicket: 5, affixReforgeTicket: 3 }, tokens: 300 }
  },
  {
    key: 'placement-earn-5000',
    title: '被动收入大师',
    description: '放置累计获得 5000 Token',
    target: 5000,
    metric: (stats) => stats.placementTokensEarned,
    reward: { tickets: { draw10Ticket: 2, affixReforgeTicket: 5 }, tokens: 600 }
  },

  // ─── 交易阶梯 ──────────────────────────────────────
  {
    key: 'trade-sell-1',
    title: '初次交易',
    description: '完成第 1 笔交易（买入或卖出）',
    target: 1,
    metric: (stats) => stats.tradeSells,
    reward: { tickets: { drawTicket: 2 }, tokens: 50 }
  },
  {
    key: 'trade-sell-5',
    title: '集换商人',
    description: '累计完成 5 笔交易',
    target: 5,
    metric: (stats) => stats.tradeSells,
    reward: { tickets: { affixReforgeTicket: 3 }, tokens: 200 }
  },
  {
    key: 'trade-sell-20',
    title: '交易高手',
    description: '累计完成 20 笔交易',
    target: 20,
    metric: (stats) => stats.tradeSells,
    reward: { tickets: { draw10Ticket: 1, affixReforgeTicket: 3 }, tokens: 400 }
  },
  {
    key: 'trade-sell-50',
    title: '集换大师',
    description: '累计完成 50 笔交易',
    target: 50,
    metric: (stats) => stats.tradeSells,
    reward: { tickets: { draw10Ticket: 2, affixReforgeTicket: 5 }, tokens: 600 }
  },

  // ─── 股市盈利阶梯 ──────────────────────────────────
  {
    key: 'market-profit-200',
    title: '股市新手',
    description: '股市累计盈利 200 Token',
    target: 200,
    metric: (stats) => stats.marketProfit,
    reward: { tickets: { drawTicket: 3 }, tokens: 80 }
  },
  {
    key: 'market-profit-500',
    title: '股市赢家',
    description: '股市累计盈利 500 Token',
    target: 500,
    metric: (stats) => stats.marketProfit,
    reward: { tickets: { drawTicket: 5, affixReforgeTicket: 3 } }
  },
  {
    key: 'market-profit-2000',
    title: '股市巨鳄',
    description: '股市累计盈利 2000 Token',
    target: 2000,
    metric: (stats) => stats.marketProfit,
    reward: { tickets: { draw10Ticket: 1, affixReforgeTicket: 5 }, tokens: 400 }
  },

  // ─── 分解阶梯 ──────────────────────────────────────
  {
    key: 'dismantle-10',
    title: '物尽其用',
    description: '累计分解卡片 10 次',
    target: 10,
    metric: (stats) => stats.dismantleCount,
    reward: { tickets: { drawTicket: 2 }, tokens: 50 }
  },
  {
    key: 'dismantle-50',
    title: '断舍离',
    description: '累计分解卡片 50 次',
    target: 50,
    metric: (stats) => stats.dismantleCount,
    reward: { tickets: { drawTicket: 5 }, tokens: 200 }
  },
  {
    key: 'dismantle-200',
    title: '碎卡机器',
    description: '累计分解卡片 200 次',
    target: 200,
    metric: (stats) => stats.dismantleCount,
    reward: { tickets: { draw10Ticket: 1, affixReforgeTicket: 3 }, tokens: 400 }
  },

  // ─── 改造阶梯 ──────────────────────────────────────
  {
    key: 'reforge-5',
    title: '改造新手',
    description: '累计使用改造券 5 次',
    target: 5,
    metric: (stats) => stats.affixReforgeCount,
    reward: { tickets: { affixReforgeTicket: 2 }, tokens: 50 }
  },
  {
    key: 'reforge-20',
    title: '炼金术士',
    description: '累计使用改造券 20 次',
    target: 20,
    metric: (stats) => stats.affixReforgeCount,
    reward: { tickets: { affixReforgeTicket: 3 }, tokens: 200 }
  },
  {
    key: 'reforge-50',
    title: '词条大师',
    description: '累计使用改造券 50 次',
    target: 50,
    metric: (stats) => stats.affixReforgeCount,
    reward: { tickets: { draw10Ticket: 1, affixReforgeTicket: 5 }, tokens: 400 }
  },

  // ─── Token 消耗阶梯 ────────────────────────────────
  {
    key: 'spend-5000',
    title: '消费达人',
    description: '抽卡累计消耗 5000 Token',
    target: 5000,
    metric: (stats) => stats.totalTokensSpent,
    reward: { tickets: { drawTicket: 5 }, tokens: 200 }
  },
  {
    key: 'spend-20000',
    title: '氪金战士',
    description: '抽卡累计消耗 20000 Token',
    target: 20000,
    metric: (stats) => stats.totalTokensSpent,
    reward: { tickets: { draw10Ticket: 2, affixReforgeTicket: 5 }, tokens: 500 }
  },
  {
    key: 'spend-50000',
    title: '富可敌国',
    description: '抽卡累计消耗 50000 Token',
    target: 50000,
    metric: (stats) => stats.totalTokensSpent,
    reward: { tickets: { draw10Ticket: 3, affixReforgeTicket: 8 }, tokens: 800 }
  },

  // ═══ 隐藏成就 ══════════════════════════════════════
  // 股市亏损阶梯 (hidden — 只有开始亏钱才能看到)
  {
    key: 'market-loss-100',
    title: '小赔怡情',
    description: '股市累计亏损 100 Token',
    target: 100,
    metric: (stats) => stats.marketLoss,
    reward: { tickets: { drawTicket: 2 } },
    hidden: true
  },
  {
    key: 'market-loss-500',
    title: '股市韭菜',
    description: '股市累计亏损 500 Token',
    target: 500,
    metric: (stats) => stats.marketLoss,
    reward: { tickets: { drawTicket: 3 }, tokens: 100 },
    hidden: true
  },
  {
    key: 'market-loss-1000',
    title: '越挫越勇',
    description: '股市累计亏损 1000 Token',
    target: 1000,
    metric: (stats) => stats.marketLoss,
    reward: { tickets: { draw10Ticket: 1, affixReforgeTicket: 2 }, tokens: 200 },
    hidden: true
  },
  {
    key: 'market-loss-2000',
    title: '坚定信仰',
    description: '股市累计亏损 2000 Token',
    target: 2000,
    metric: (stats) => stats.marketLoss,
    reward: { tickets: { draw10Ticket: 1, affixReforgeTicket: 3 }, tokens: 300 },
    hidden: true
  },
  {
    key: 'market-loss-5000',
    title: '钻石之手',
    description: '股市累计亏损 5000 Token',
    target: 5000,
    metric: (stats) => stats.marketLoss,
    reward: { tickets: { draw10Ticket: 2, affixReforgeTicket: 5 }, tokens: 500 },
    hidden: true
  },

  // 紫卡隐藏成就
  {
    key: 'purple-10',
    title: '紫气东来',
    description: '累计抽到 10 张紫卡',
    target: 10,
    metric: (stats) => stats.purpleCardsDrawn,
    reward: { tickets: { drawTicket: 3 }, tokens: 80 },
    hidden: true
  },
  {
    key: 'purple-50',
    title: '紫霞仙境',
    description: '累计抽到 50 张紫卡',
    target: 50,
    metric: (stats) => stats.purpleCardsDrawn,
    reward: { tickets: { draw10Ticket: 1, affixReforgeTicket: 3 }, tokens: 300 },
    hidden: true
  }
];

const RARITY_ORDER: GachaRarity[] = ['WHITE', 'GREEN', 'BLUE', 'PURPLE', 'GOLD'];

const DEFAULT_DISMANTLE_REWARD_BY_RARITY: Record<GachaRarity, number> = {
  WHITE: 1,
  GREEN: 4,
  BLUE: 12,
  PURPLE: 30,
  GOLD: 100
};

const DEFAULT_DRAW_REWARD_BY_RARITY: Record<GachaRarity, number> = {
  WHITE: 0,
  GREEN: 0,
  BLUE: 0,
  PURPLE: 0,
  GOLD: 0
};

type RarityRewardConfig = {
  drawRewards: Record<GachaRarity, number>;
  dismantleRewards: Record<GachaRarity, number>;
};

let rarityRewardCache: { data: RarityRewardConfig; fetchedAt: number } | null = null;
const RARITY_REWARD_CACHE_MS = 60_000;

type BoostBase = Prisma.GachaGlobalBoostGetPayload<{}>;
type BoostWithCreator = Prisma.GachaGlobalBoostGetPayload<{ include: { createdBy: true } }>;
type BoostWithMaybeCreator = BoostBase | BoostWithCreator;

const rarityDisplayName: Record<GachaRarity, string> = {
  WHITE: 'WHITE',
  GREEN: 'GREEN',
  BLUE: 'BLUE',
  PURPLE: 'PURPLE',
  GOLD: 'GOLD'
};

const rarityWeight: Record<GachaRarity, number> = {
  GOLD: 0,
  PURPLE: 1,
  BLUE: 2,
  GREEN: 3,
  WHITE: 4
};

const AFFIX_VISUAL_STYLE_VALUES = [
  'NONE',
  'MONO',
  'SILVER',
  'GOLD',
  'CYAN',
  'PRISM',
  'COLORLESS',
  'WILDCARD',
  'SPECTRUM',
  'MIRROR',
  'ORBIT',
  'ECHO',
  'NEXUS',
  'ANCHOR',
  'FLUX'
] as const;
type AffixVisualStyle = typeof AFFIX_VISUAL_STYLE_VALUES[number];
type PlacementAddonKind = 'COLORLESS';

const FALLBACK_AFFIX_STYLES: AffixVisualStyle[] = [
  'MONO',
  'SILVER',
  'GOLD',
  'CYAN',
  'PRISM',
  'COLORLESS',
  'WILDCARD',
  'SPECTRUM',
  'MIRROR',
  'ORBIT',
  'ECHO',
  'NEXUS',
  'ANCHOR',
  'FLUX'
];
const AFFIX_ROLL_DENOMINATOR = 10_000;
const AFFIX_CARD_ROLL_THRESHOLD = 1_800; // ~18%
const AFFIX_CARD_SECOND_STYLE_THRESHOLD = 2_500; // ~25% among affixed cards
const AFFIX_CARD_THIRD_STYLE_THRESHOLD = 900; // ~9% among affixed cards
const AFFIX_MULTI_STYLE_MAX_PER_CARD = 3;
const AFFIX_STYLE_ROLL_WEIGHTS: Array<{ style: Exclude<AffixVisualStyle, 'NONE'>; weight: number }> = [
  { style: 'MONO', weight: 280 },
  { style: 'SILVER', weight: 220 },
  { style: 'CYAN', weight: 190 },
  { style: 'PRISM', weight: 140 },
  { style: 'GOLD', weight: 120 },
  { style: 'COLORLESS', weight: 45 },
  { style: 'WILDCARD', weight: 55 },
  { style: 'SPECTRUM', weight: 50 },
  { style: 'MIRROR', weight: 50 },
  { style: 'ORBIT', weight: 50 },
  { style: 'ECHO', weight: 40 },
  { style: 'NEXUS', weight: 25 },
  { style: 'ANCHOR', weight: 35 },
  { style: 'FLUX', weight: 30 }
];
const AFFIX_STYLE_ROLL_WEIGHT_TOTAL = AFFIX_STYLE_ROLL_WEIGHTS
  .reduce((sum, item) => sum + Math.max(0, Math.floor(item.weight)), 0);

const AFFIX_KEYWORDS: Record<Exclude<AffixVisualStyle, 'NONE'>, string[]> = {
  MONO: ['mono', 'locked', 'lock', 'noir', 'blackwhite', 'black-white', '黑白', '单色', '灰度', '锁定'],
  SILVER: ['silver', 'chrome', 'argent', 'free-slot', 'freeslot', '空槽', '银色', '银镀层'],
  GOLD: ['gold', 'gilded', 'foil', 'yieldboost', 'yield-boost', '镀金', '金箔', '鎏金', '产出加成'],
  CYAN: ['cyan', 'azure', 'blueprint', 'offlinebuffer', 'offline-buffer', '青色', '蓝图', '离线缓冲'],
  PRISM: ['prism', 'holo', 'rainbow', 'dismantlebonus', 'dismantle-bonus', '彩虹', '棱镜', '分解加成'],
  COLORLESS: ['colorless', 'achromatic', 'void', 'blank', '无色', '异化', '透明', '无相'],
  WILDCARD: ['wildcard', 'joker', 'wild', '通配', '万能', '百搭'],
  SPECTRUM: ['spectrum', 'raritysync', 'rarity-sync', '频谱', '谱系', '共鸣'],
  MIRROR: ['mirror', 'echoid', 'samecard', 'same-card', '镜像', '同构'],
  ORBIT: ['orbit', 'pagechain', 'page-chain', '轨道', '环轨', '同页'],
  ECHO: ['echo', 'repeat', 'dupe', '回声', '复调', '叠写'],
  NEXUS: ['nexus', '节点', '枢纽', '核心'],
  ANCHOR: ['anchor', '锚点', '锚定', '固定'],
  FLUX: ['flux', '流变', '涌动', '脉动']
};
const AFFIX_KEYWORD_STYLE_MAP = (() => {
  const map = new Map<string, Exclude<AffixVisualStyle, 'NONE'>>();
  for (const style of Object.keys(AFFIX_KEYWORDS) as Array<Exclude<AffixVisualStyle, 'NONE'>>) {
    for (const keyword of AFFIX_KEYWORDS[style]) {
      const normalized = keyword.trim().toLowerCase().replace(/[\s_]+/g, '').replace(/-/g, '');
      if (!normalized) continue;
      map.set(normalized, style);
    }
  }
  return map;
})();

const AFFIX_STYLE_LABEL: Record<AffixVisualStyle, string> = {
  NONE: '标准',
  MONO: '黑白',
  SILVER: '银镀层',
  GOLD: '金镀层',
  CYAN: '青镀层',
  PRISM: '棱镜',
  COLORLESS: '无色词条',
  WILDCARD: '通配符',
  SPECTRUM: '谱系共鸣',
  MIRROR: '镜像',
  ORBIT: '轨道',
  ECHO: '回声',
  NEXUS: '枢纽',
  ANCHOR: '锚点',
  FLUX: '流变'
};

const AFFIX_PRIMARY_STYLE_PRIORITY: AffixVisualStyle[] = [
  'COLORLESS',
  'NEXUS',
  'PRISM',
  'GOLD',
  'CYAN',
  'SILVER',
  'MONO',
  'WILDCARD',
  'SPECTRUM',
  'MIRROR',
  'ORBIT',
  'ECHO',
  'ANCHOR',
  'FLUX',
  'NONE'
];

const PLACEMENT_AFFIX_YIELD_BASE_BY_RARITY: Record<GachaRarity, number> = {
  WHITE: 0.004,
  GREEN: 0.006,
  BLUE: 0.008,
  PURPLE: 0.011,
  GOLD: 0.014
};
const PLACEMENT_AFFIX_YIELD_MULTIPLIER_BY_STYLE: Record<AffixVisualStyle, number> = {
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
};

const PLACEMENT_AFFIX_OFFLINE_BASE_BY_RARITY: Record<GachaRarity, number> = {
  WHITE: 8,
  GREEN: 12,
  BLUE: 18,
  PURPLE: 26,
  GOLD: 36
};
const PLACEMENT_AFFIX_OFFLINE_MULTIPLIER_BY_STYLE: Record<AffixVisualStyle, number> = {
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
};

const AFFIX_DISMANTLE_BONUS_BASE_BY_RARITY: Record<GachaRarity, number> = {
  WHITE: 0.02,
  GREEN: 0.03,
  BLUE: 0.04,
  PURPLE: 0.05,
  GOLD: 0.06
};
const AFFIX_DISMANTLE_BONUS_MULTIPLIER_BY_STYLE: Record<AffixVisualStyle, number> = {
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
};

const PLACEMENT_COMBO_SAME_RARITY_YIELD_BY_COUNT: Record<number, number> = {
  3: 0.03,
  4: 0.065,
  5: 0.11,
  6: 0.16
};

const PLACEMENT_COMBO_SAME_AFFIX_YIELD_BY_COUNT: Record<number, number> = {
  3: 0.03,
  4: 0.065,
  5: 0.11,
  6: 0.16
};

const PLACEMENT_COMBO_SAME_PAGE_YIELD_BY_COUNT: Record<number, number> = {
  3: 0.03,
  4: 0.065,
  5: 0.11,
  6: 0.16
};

const PLACEMENT_COMBO_SAME_CARD_YIELD_BY_COUNT: Record<number, number> = {
  3: 0.05,
  4: 0.105,
  5: 0.17,
  6: 0.25
};

const PLACEMENT_COMBO_SAME_TYPE_YIELD_BY_COUNT: Record<number, number> = {
  3: 0.03,
  4: 0.065,
  5: 0.11,
  6: 0.16
};

const PLACEMENT_COMBO_SAME_AUTHOR_YIELD_BY_COUNT: Record<number, number> = {
  3: 0.03,
  4: 0.065,
  5: 0.11,
  6: 0.16
};
const PLACEMENT_COMBO_SAME_AUTHOR_DECAY = 0.65;
const PLACEMENT_COMBO_SAME_AUTHOR_MAX_BONUS = 0.25;

const PLACEMENT_COMBO_ALL_GOLD_RARITY_YIELD_BONUS = 0.15;
const PLACEMENT_COMBO_ALL_AFFIX_GOLD_YIELD_BONUS = 0.18;

const PLACEMENT_COMBO_SAME_TAG_YIELD_BY_COUNT: Record<number, number> = {
  3: 0.015, 4: 0.03, 5: 0.05, 6: 0.075,
  7: 0.1, 8: 0.12, 9: 0.14, 10: 0.16
};
const PLACEMENT_COMBO_SAME_TAG_PER_CARD_LIMIT = 2;
const PLACEMENT_COMBO_SAME_TAG_DECAY = 0.65;
const PLACEMENT_COMBO_SAME_TAG_MAX_BONUS = 0.25;

const PLACEMENT_COMBO_TAG_EXCLUDE_SET = new Set([
  '原创', 'original', 'origin',
  'scp', 'scpi', 'scp-cn', 'scpcn',
  'goi格式', 'goi', 'goiformat',
  '故事', 'tale', 'tales',
  '艺术作品', '艺术', 'art', 'artwork',
  '掩藏页', '隐藏页', 'hidden',
  '中文', 'cn', 'en', 'jp', 'ko', 'ru', 'fr', 'de', 'es', 'it', 'pt', 'pl', 'th', 'uk', 'zh',
  '图书馆', '流浪者图书馆', 'wanderers',
]);

const PLACEMENT_NEXUS_CONVERT_BONUS_PER_COMBO = 0.12;
const PLACEMENT_NEXUS_CONVERT_MAX_COMBO_COUNT = 30;

const PLACEMENT_ANCHOR_FLAT_YIELD_BY_RARITY: Record<GachaRarity, number> = {
  WHITE: 0.08, GREEN: 0.12, BLUE: 0.18, PURPLE: 0.26, GOLD: 0.35
};

const PLACEMENT_FLUX_YIELD_BASE_BY_RARITY: Record<GachaRarity, number> = {
  WHITE: 0.07, GREEN: 0.10, BLUE: 0.15, PURPLE: 0.22, GOLD: 0.30
};
const PLACEMENT_FLUX_SCALE_PER_COMBO = 0.12;

const PLACEMENT_CONTENT_TYPE_LABEL: Record<PlacementContentType, string> = {
  SCP: 'SCP',
  TRANSLATION: '译文',
  GOI: 'GOI',
  WANDERERS: 'WANDERERS',
  ART: 'ART',
  TALE: 'TALE',
  OTHERS: 'OTHERS'
};

const PLACEMENT_COLORLESS_ADDON_RATIO = 0.5;
const PLACEMENT_COLORLESS_ADDON_KIND: PlacementAddonKind = 'COLORLESS';

const matchModeToString = (mode: GachaMatchMode): 'all' | 'any' => (mode === 'ALL' ? 'all' : 'any');

const matchModeFromInput = (value: string | undefined): GachaMatchMode => {
  if (!value) return 'ANY';
  return value.toLowerCase() === 'all' ? 'ALL' : 'ANY';
};

function buildDefaultRarityRewards(): RarityRewardConfig {
  return {
    drawRewards: { ...DEFAULT_DRAW_REWARD_BY_RARITY },
    dismantleRewards: { ...DEFAULT_DISMANTLE_REWARD_BY_RARITY }
  };
}

function invalidateRarityRewardCache() {
  rarityRewardCache = null;
}

async function loadRarityRewards(tx: typeof prisma | Tx, force = false): Promise<RarityRewardConfig> {
  if (!force && rarityRewardCache && Date.now() - rarityRewardCache.fetchedAt <= RARITY_REWARD_CACHE_MS) {
    return rarityRewardCache.data;
  }
  const rows = await tx.gachaRarityReward.findMany();
  const defaults = buildDefaultRarityRewards();
  for (const row of rows) {
    defaults.drawRewards[row.rarity] = row.drawReward;
    defaults.dismantleRewards[row.rarity] = row.dismantleReward;
  }
  rarityRewardCache = { data: defaults, fetchedAt: Date.now() };
  return defaults;
}

const SERIALIZABLE_RETRY_ATTEMPTS = 5;
const SERIALIZABLE_RETRY_BASE_DELAY_MS = 50;
const SERIALIZABLE_MAX_WAIT_MS = 10_000;
const SERIALIZABLE_TIMEOUT_MS = 20_000;

function getTransactionErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`.toLowerCase();
  }
  return String(error).toLowerCase();
}

function isRetryableTransactionError(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034') {
    return true;
  }

  const message = getTransactionErrorMessage(error);
  return (
    message.includes('could not serialize access')
    || message.includes('serialization failure')
    || message.includes('write conflict')
    || message.includes('deadlock')
    || message.includes('40p01')
    || message.includes('40001')
  );
}

function isUniqueConstraintError(error: unknown): error is Prisma.PrismaClientKnownRequestError {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

function isMissingTableError(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2021';
}

async function runSerializableTransaction<T>(task: (tx: Tx) => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= SERIALIZABLE_RETRY_ATTEMPTS; attempt += 1) {
    try {
      return await prisma.$transaction((tx) => task(tx), {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        maxWait: SERIALIZABLE_MAX_WAIT_MS,
        timeout: SERIALIZABLE_TIMEOUT_MS
      });
    } catch (error) {
      lastError = error;
      if (!isRetryableTransactionError(error) || attempt === SERIALIZABLE_RETRY_ATTEMPTS) {
        throw error;
      }
      const jitterMs = Math.floor(Math.random() * SERIALIZABLE_RETRY_BASE_DELAY_MS);
      const delayMs = SERIALIZABLE_RETRY_BASE_DELAY_MS * attempt + jitterMs;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError ?? new Error('Serializable transaction failed');
}

const drawRequestSchema = z.object({
  poolId: z.string().trim().optional(),
  paymentMethod: z.enum(['TOKEN', 'DRAW_TICKET', 'DRAW10_TICKET', 'AUTO']).optional().default('AUTO'),
  count: z.number().int().min(1).max(MAX_DRAW_COUNT).refine((value) => ALLOWED_DRAW_COUNTS.has(value), {
    message: 'count 仅支持 1 或 10'
  })
});

const dismantleSchema = z.object({
  cardId: z.string().trim().min(1),
  affixVisualStyle: z.enum(AFFIX_VISUAL_STYLE_VALUES).optional(),
  affixSignature: z.string().trim().optional(),
  count: z.number().int().min(1)
});

const dismantleBatchSchema = z.object({
  maxRarity: z.nativeEnum(GachaRarity).optional().default('BLUE'),
  keepAtLeast: z.number().int().min(0).max(999).optional().default(1),
  keepScope: z.enum(DISMANTLE_KEEP_SCOPE_VALUES).optional().default('CARD')
});

const inventoryQuerySchema = z.object({
  poolId: z.string().trim().optional(),
  rarity: z.string().trim().optional(),
  limit: z.string().trim().optional(),
  offset: z.string().trim().optional(),
  skipTotal: z.string().trim().optional(),
  affixFilter: z.string().trim().optional(),
  search: z.string().trim().optional()
});

const progressQuerySchema = z.object({
  poolId: z.string().trim().optional()
});

const historyQuerySchema = z.object({
  poolId: z.string().trim().optional(),
  limit: z.string().trim().optional()
});

const albumPagesQuerySchema = z.object({
  search: z.string().trim().optional(),
  limit: z.string().trim().optional(),
  offset: z.string().trim().optional()
});

const albumVariantsParamSchema = z.object({
  pageId: z.coerce.number().int().positive()
});

const placementSlotParamSchema = z.object({
  slotIndex: z.coerce.number().int().min(1).max(PLACEMENT_SLOT_COUNT_MAX)
});

const placementSetSchema = z.object({
  cardId: z.string().trim().min(1),
  affixVisualStyle: z.enum(AFFIX_VISUAL_STYLE_VALUES).optional(),
  affixSignature: z.string().trim().optional()
});

const placementAddonSetSchema = z.object({
  cardId: z.string().trim().min(1),
  affixVisualStyle: z.enum(AFFIX_VISUAL_STYLE_VALUES).optional(),
  affixSignature: z.string().trim().optional()
});

const ticketReforgeSchema = z.object({
  cardId: z.string().trim().optional(),
  affixSignature: z.string().trim().optional()
});

const missionClaimParamSchema = z.object({
  missionKey: z.string().trim().min(1)
});

const achievementClaimParamSchema = z.object({
  achievementKey: z.string().trim().min(1)
});

const marketTicksQuerySchema = z.object({
  contractId: z.string().trim().optional(),
  category: z.string().trim().optional(),
  limit: z.coerce.number().int().min(8).max(4000).optional(),
  timeframe: z.enum(['24H', '7D', '30D']).optional()
});

const marketOpponentsQuerySchema = z.object({
  contractId: z.string().trim().optional(),
  category: z.string().trim().optional(),
  lockTier: z.enum(['T1', 'T7', 'T15', 'T30']).optional()
});

const marketPositionOpenSchema = z.object({
  contractId: z.string().trim().min(1),
  side: z.enum(['LONG', 'SHORT']),
  lockTier: z.enum(['T1', 'T7', 'T15', 'T30']).optional(),
  lots: z.coerce.number().int().min(1).max(10_000).optional(),
  stake: z.coerce.number().int().min(MARKET_LOT_TOKEN).max(100_000).optional(),
  leverage: z.coerce.number().int().min(1).max(100).optional().default(1)
}).superRefine((payload, ctx) => {
  if (payload.lots == null && payload.stake == null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: '请提供 lots 或 stake'
    });
  }
});

const marketHistoryQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional()
});

const tradeListingsQuerySchema = z.object({
  status: z.enum(['OPEN', 'SOLD', 'CANCELLED', 'EXPIRED', 'ALL']).optional(),
  limit: z.string().trim().optional(),
  offset: z.string().trim().optional(),
  cardId: z.string().trim().optional(),
  mine: z.enum(['0', '1']).optional(),
  search: z.string().trim().max(120).optional(),
  searchMode: z.enum(TRADE_SEARCH_MODE_VALUES).optional(),
  rarity: z.nativeEnum(GachaRarity).optional(),
  sort: z.enum(TRADE_SORT_MODE_VALUES).optional()
});

const tradeCreateSchema = z.object({
  cardId: z.string().trim().min(1),
  affixSignature: z.string().trim().optional(),
  quantity: z.coerce.number().int().min(1).max(99),
  unitPrice: z.coerce.number().int().min(1).max(500_000),
  expiresHours: z.coerce.number().int().min(1).max(24 * 30).optional()
});

const tradeBuySchema = z.object({
  quantity: z.coerce.number().int().min(1).max(99).optional()
});

const buyRequestCreateSchema = z.object({
  targetCardId: z.string().trim().min(1),
  matchLevel: z.enum(['PAGE', 'IMAGE_VARIANT', 'COATING']).optional().default('IMAGE_VARIANT'),
  requiredCoating: z.enum([
    'NONE', 'MONO', 'SILVER', 'GOLD', 'CYAN', 'PRISM',
    'COLORLESS', 'WILDCARD', 'SPECTRUM', 'MIRROR', 'ORBIT', 'ECHO'
  ]).optional(),
  tokenOffer: z.coerce.number().int().min(0).max(500_000).default(0),
  offeredCards: z.array(z.object({
    cardId: z.string().trim().min(1),
    affixSignature: z.string().trim().optional(),
    quantity: z.coerce.number().int().min(1).max(99).default(1)
  })).max(20).default([]),
  expiresHours: z.coerce.number().int().min(1).max(24 * 30).optional()
});

const buyRequestFulfillSchema = z.object({
  selectedCardId: z.string().trim().min(1).optional(),
  selectedAffixSignature: z.string().trim().min(1).optional()
});

const buyRequestListSchema = z.object({
  status: z.enum(['OPEN', 'ALL']).optional().default('OPEN'),
  targetCardId: z.string().trim().min(1).optional(),
  search: z.string().trim().max(200).optional(),
  rarity: z.enum(['WHITE', 'GREEN', 'BLUE', 'PURPLE', 'GOLD']).optional(),
  sort: z.enum(['LATEST', 'TOKEN_DESC', 'TOKEN_ASC', 'EXPIRY_ASC', 'RARITY_DESC']).optional().default('LATEST'),
  limit: z.coerce.number().int().min(1).max(200).optional().default(60),
  offset: z.coerce.number().int().min(0).optional().default(0),
  fulfillableOnly: z.string().trim().optional()
});

const boostCreateSchema = z.object({
  includeTags: z.array(z.string().trim().min(1)).max(20).optional().default([]),
  excludeTags: z.array(z.string().trim().min(1)).max(20).optional().default([]),
  match: z.enum(['all', 'any']).optional().default('any'),
  weightMultiplier: z.number().positive().max(10),
  startsAt: z.string().optional(),
  endsAt: z.string().optional()
});

const boostPatchSchema = z.object({
  includeTags: z.array(z.string().trim().min(1)).max(20).optional(),
  excludeTags: z.array(z.string().trim().min(1)).max(20).optional(),
  match: z.enum(['all', 'any']).optional(),
  weightMultiplier: z.number().positive().max(10).optional(),
  startsAt: z.string().optional(),
  endsAt: z.string().nullable().optional(),
  isActive: z.boolean().optional()
});

const poolCreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2000).optional(),
  tokenCost: z.number().int().positive().max(10000).optional(),
  tenDrawCost: z.number().int().positive().max(100000).optional(),
  rewardPerDuplicate: z.number().int().nonnegative().max(10000).optional(),
  startsAt: z.string().optional(),
  endsAt: z.string().optional(),
  isActive: z.boolean().optional(),
  cloneFromPoolId: z.string().trim().min(1).optional(),
  cloneAllCards: z.boolean().optional().default(true)
});

const poolUpdateSchema = poolCreateSchema.partial();

const cardCreateSchema = z.object({
  title: z.string().trim().min(1).max(200),
  rarity: z.nativeEnum(GachaRarity),
  tags: z.array(z.string().trim().min(1)).max(30).optional().default([]),
  weight: z.number().int().positive().max(1000).optional(),
  rewardTokens: z.number().int().nonnegative().max(10000).optional(),
  wikidotId: z.number().int().positive().optional(),
  pageId: z.number().int().positive().optional(),
  imageUrl: z.string().url().optional()
});

const cardUpdateSchema = cardCreateSchema.partial();

const periodSchema = z.enum(['7d', '30d', 'all']).default('7d');

const cardListQuerySchema = z.object({
  poolId: z.string().trim().optional(),
  rarity: z.nativeEnum(GachaRarity).optional(),
  search: z.string().trim().optional(),
  includeTags: z.string().trim().optional(),
  excludeTags: z.string().trim().optional(),
  limit: z.string().trim().optional(),
  offset: z.string().trim().optional()
});

const cardBatchAdjustSchema = z.object({
  poolId: z.string().trim().optional(),
  includeTags: z.array(z.string().trim().min(1)).max(30).optional().default([]),
  excludeTags: z.array(z.string().trim().min(1)).max(30).optional().default([]),
  match: z.enum(['all', 'any']).optional().default('any'),
  rarity: z.nativeEnum(GachaRarity).optional(),
  multiplier: z.number().positive().max(10).optional(),
  setWeight: z.number().int().min(1).max(1000).optional()
}).refine((payload) => payload.multiplier != null || payload.setWeight != null, {
  message: '请指定权重调整方式'
});

const rarityRewardSchema = z.object({
  WHITE: z.number().int().min(0).max(1_000_000),
  GREEN: z.number().int().min(0).max(1_000_000),
  BLUE: z.number().int().min(0).max(1_000_000),
  PURPLE: z.number().int().min(0).max(1_000_000),
  GOLD: z.number().int().min(0).max(1_000_000)
});

const economyUpdateSchema = z.object({
  drawRewards: rarityRewardSchema.optional(),
  dismantleRewards: rarityRewardSchema.optional()
}).refine((payload) => payload.drawRewards || payload.dismantleRewards, {
  message: '请至少提供一组稀有度奖励配置'
});

const walletAdjustSchema = z.object({
  scope: z.enum(['user', 'all']).default('user'),
  userId: z.string().trim().optional(),
  email: z.string().trim().email().optional(),
  delta: z.number().int().min(-1_000_000_000).max(1_000_000_000),
  reason: z.string().trim().max(200).optional(),
  message: z.string().trim().max(2000).optional(),
  allowNegative: z.boolean().optional().default(false)
}).refine((payload) => {
  if (payload.scope === 'all') return true;
  return Boolean(payload.userId?.length) || Boolean(payload.email?.length);
}, {
  message: '请提供 userId 或 email'
});

function now(): Date {
  return new Date();
}

function toUtc8DayKey(date: Date) {
  const shifted = new Date(date.getTime() + UTC8_OFFSET_MINUTES * 60_000);
  return shifted.toISOString().slice(0, 10);
}

function utc8Shift(date: Date) {
  return new Date(date.getTime() + UTC8_OFFSET_MINUTES * 60_000);
}

function utc8DateStart(shiftedDate: Date) {
  return new Date(Date.UTC(
    shiftedDate.getUTCFullYear(),
    shiftedDate.getUTCMonth(),
    shiftedDate.getUTCDate(),
    0,
    0,
    0,
    0
  ));
}

function toUtc8WeekKey(date: Date) {
  const shifted = utc8Shift(date);
  const dayOfWeek = shifted.getUTCDay();
  const offsetToMonday = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
  const monday = new Date(Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate() + offsetToMonday,
    0,
    0,
    0,
    0
  ));
  return monday.toISOString().slice(0, 10);
}

function missionPeriodWindow(periodType: MissionPeriodType, asOf: Date) {
  if (periodType === 'daily') {
    const shifted = utc8Shift(asOf);
    const shiftedStart = utc8DateStart(shifted);
    const shiftedEnd = new Date(shiftedStart.getTime() + 24 * 60 * 60 * 1000);
    return {
      periodKey: shiftedStart.toISOString().slice(0, 10),
      startsAt: new Date(shiftedStart.getTime() - UTC8_OFFSET_MINUTES * 60_000),
      endsAt: new Date(shiftedEnd.getTime() - UTC8_OFFSET_MINUTES * 60_000)
    };
  }
  const shifted = utc8Shift(asOf);
  const dayOfWeek = shifted.getUTCDay();
  const offsetToMonday = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
  const shiftedStart = new Date(Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate() + offsetToMonday,
    0,
    0,
    0,
    0
  ));
  const shiftedEnd = new Date(shiftedStart.getTime() + 7 * 24 * 60 * 60 * 1000);
  return {
    periodKey: toUtc8WeekKey(asOf),
    startsAt: new Date(shiftedStart.getTime() - UTC8_OFFSET_MINUTES * 60_000),
    endsAt: new Date(shiftedEnd.getTime() - UTC8_OFFSET_MINUTES * 60_000)
  };
}

function toDate(value?: string | null): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function normalizeAffixToken(value: string) {
  return value.trim().toLowerCase().replace(/[\s_]+/g, '').replace(/-/g, '');
}

function resolveExplicitAffixStyleFromTags(tags: string[]) {
  for (const rawTag of tags) {
    const tag = String(rawTag || '').trim();
    if (!tag) continue;
    const normalized = normalizeAffixToken(tag);
    if (!normalized) continue;
    const direct = AFFIX_KEYWORD_STYLE_MAP.get(normalized);
    if (direct) return direct;

    let prefixed: string | null = null;
    if (normalized.startsWith('affix:')) {
      prefixed = normalized.slice('affix:'.length);
    } else if (normalized.startsWith('词条:')) {
      prefixed = normalized.slice('词条:'.length);
    } else if (normalized.startsWith('variant:')) {
      prefixed = normalized.slice('variant:'.length);
    }
    if (!prefixed) continue;
    const fromPrefix = AFFIX_KEYWORD_STYLE_MAP.get(prefixed);
    if (fromPrefix) return fromPrefix;
  }
  return null;
}

function rollAffixStyleByWeight(weightRoll: number): Exclude<AffixVisualStyle, 'NONE'> {
  if (AFFIX_STYLE_ROLL_WEIGHT_TOTAL <= 0) return 'MONO';
  let remaining = Math.max(0, Math.floor(weightRoll)) % AFFIX_STYLE_ROLL_WEIGHT_TOTAL;
  for (const item of AFFIX_STYLE_ROLL_WEIGHTS) {
    remaining -= Math.max(0, Math.floor(item.weight));
    if (remaining < 0) {
      return item.style;
    }
  }
  return AFFIX_STYLE_ROLL_WEIGHTS[AFFIX_STYLE_ROLL_WEIGHTS.length - 1]?.style ?? 'MONO';
}

function inferAffixVisualStyleFromTitle(title: string): Exclude<AffixVisualStyle, 'NONE'> | null {
  const normalizedTitle = normalizeAffixToken(title || '');
  if (!normalizedTitle) return null;
  // Only infer from title when it explicitly looks like an affix variant.
  const hasAffixMarker = normalizedTitle.includes('词条')
    || normalizedTitle.includes('affix')
    || normalizedTitle.includes('版本')
    || normalizedTitle.includes('variant')
    || normalizedTitle.includes('version');
  if (!hasAffixMarker) return null;
  for (const style of Object.keys(AFFIX_KEYWORDS) as Array<Exclude<AffixVisualStyle, 'NONE'>>) {
    const keywords = AFFIX_KEYWORDS[style];
    if (keywords.some((keyword) => normalizedTitle.includes(normalizeAffixToken(keyword)))) {
      return style;
    }
  }
  return null;
}

function inferLegacyAffixVisualStyle(card: { title: string; tags?: string[] | null }): Exclude<AffixVisualStyle, 'NONE'> | null {
  const normalizedTags = (card.tags ?? [])
    .filter((tag) => typeof tag === 'string')
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);

  const explicit = resolveExplicitAffixStyleFromTags(normalizedTags);
  if (explicit) return explicit;
  return inferAffixVisualStyleFromTitle(card.title);
}

type AffixStyleCountMap = Record<AffixVisualStyle, number>;
type AffixStackMap = AffixStyleCountMap;
type AffixVariantMap = Record<string, number>;
type AffixFingerprint = {
  affixSignature: string;
  affixStyles: AffixVisualStyle[];
  affixVisualStyle: AffixVisualStyle;
  affixLabel: string;
  affixStyleCounts: AffixStyleCountMap;
};
type AffixStackEntry = AffixFingerprint & {
  count: number;
};

const AFFIX_STACK_STYLE_ORDER: AffixVisualStyle[] = [...AFFIX_VISUAL_STYLE_VALUES];
const AFFIX_STACK_CONSUME_PRIORITY: AffixVisualStyle[] = [
  'NONE',
  'MONO',
  'SILVER',
  'CYAN',
  'PRISM',
  'GOLD',
  'COLORLESS',
  'WILDCARD',
  'SPECTRUM',
  'MIRROR',
  'ORBIT',
  'ECHO',
  'NEXUS',
  'ANCHOR',
  'FLUX'
];

function emptyAffixStyleCountMap(): AffixStyleCountMap {
  return {
    NONE: 0,
    MONO: 0,
    SILVER: 0,
    GOLD: 0,
    CYAN: 0,
    PRISM: 0,
    COLORLESS: 0,
    WILDCARD: 0,
    SPECTRUM: 0,
    MIRROR: 0,
    ORBIT: 0,
    ECHO: 0,
    NEXUS: 0,
    ANCHOR: 0,
    FLUX: 0
  };
}

function emptyAffixStackMap(): AffixStackMap {
  return emptyAffixStyleCountMap();
}

function emptyAffixVariantMap(): AffixVariantMap {
  return {};
}

function normalizeAffixVisualStyleInput(value: unknown): AffixVisualStyle {
  const raw = String(value ?? '').trim().toUpperCase();
  return (AFFIX_VISUAL_STYLE_VALUES as readonly string[]).includes(raw)
    ? raw as AffixVisualStyle
    : 'NONE';
}

function normalizeAffixStyleList(rawStyles: unknown[], maxCount = AFFIX_MULTI_STYLE_MAX_PER_CARD): AffixVisualStyle[] {
  const normalized = rawStyles
    .map((style) => normalizeAffixVisualStyleInput(style))
    .filter((style) => style !== 'NONE')
    .slice(0, Math.max(1, maxCount));
  if (normalized.length <= 0) return ['NONE'];
  const sorted = [...normalized].sort((a, b) => (
    AFFIX_STACK_STYLE_ORDER.indexOf(a) - AFFIX_STACK_STYLE_ORDER.indexOf(b)
  ));
  return sorted;
}

function affixSignatureFromStyles(styles: AffixVisualStyle[]) {
  const normalized = normalizeAffixStyleList(styles);
  if (normalized.length <= 0) return 'NONE';
  if (normalized.length === 1 && normalized[0] === 'NONE') return 'NONE';
  return normalized.join('+');
}

function parseAffixSignature(signatureRaw: unknown): AffixVisualStyle[] {
  const raw = String(signatureRaw ?? '').trim().toUpperCase();
  if (!raw) return ['NONE'];
  const tokens = raw.split('+').map((item) => item.trim()).filter(Boolean);
  return normalizeAffixStyleList(tokens);
}

function stylesToCountMap(styles: AffixVisualStyle[]) {
  const counts = emptyAffixStyleCountMap();
  for (const style of styles) {
    counts[style] += 1;
  }
  if (styles.length > 1 && counts.NONE > 0) {
    counts.NONE = 0;
  }
  return counts;
}

function resolvePrimaryAffixStyleFromStacks(map: AffixStyleCountMap): AffixVisualStyle {
  const entries = AFFIX_STACK_STYLE_ORDER
    .map((style) => ({
      style,
      count: Math.max(0, Math.floor(map[style] ?? 0))
    }))
    .filter((entry) => entry.count > 0)
    .sort((a, b) => {
      if (a.count !== b.count) return b.count - a.count;
      return AFFIX_PRIMARY_STYLE_PRIORITY.indexOf(a.style) - AFFIX_PRIMARY_STYLE_PRIORITY.indexOf(b.style);
    });
  return entries[0]?.style ?? 'NONE';
}

function inferAffixLabel(_card: { tags: string[] }, style: AffixVisualStyle) {
  return AFFIX_STYLE_LABEL[style] ?? AFFIX_STYLE_LABEL.NONE;
}

function buildAffixLabelFromStyles(styles: AffixVisualStyle[]) {
  const counts = stylesToCountMap(styles);
  const parts = AFFIX_STACK_STYLE_ORDER
    .filter((style) => counts[style] > 0 && style !== 'NONE')
    .map((style) => {
      const count = counts[style];
      if (count <= 1) return AFFIX_STYLE_LABEL[style];
      return `${AFFIX_STYLE_LABEL[style]}x${count}`;
    });
  if (parts.length <= 0) return AFFIX_STYLE_LABEL.NONE;
  return parts.join(' + ');
}

function buildAffixFingerprintFromStyles(stylesInput: unknown[]): AffixFingerprint {
  const affixStyles = normalizeAffixStyleList(stylesInput);
  const affixStyleCounts = stylesToCountMap(affixStyles);
  const affixVisualStyle = resolvePrimaryAffixStyleFromStacks(affixStyleCounts);
  return {
    affixSignature: affixSignatureFromStyles(affixStyles),
    affixStyles,
    affixVisualStyle,
    affixLabel: buildAffixLabelFromStyles(affixStyles),
    affixStyleCounts
  };
}

function buildAffixFingerprintFromSignature(signatureRaw: unknown) {
  return buildAffixFingerprintFromStyles(parseAffixSignature(signatureRaw));
}

function resolveCardAffix(card: { id: string; title: string; tags?: string[] | null }) {
  const style: AffixVisualStyle = inferLegacyAffixVisualStyle(card) ?? 'NONE';
  return buildAffixFingerprintFromStyles([style]);
}

function rollDrawAffixStyles(): AffixVisualStyle[] {
  const firstRoll = Math.random() * AFFIX_ROLL_DENOMINATOR;
  if (firstRoll >= AFFIX_CARD_ROLL_THRESHOLD) {
    return ['NONE'];
  }
  const styles: AffixVisualStyle[] = [];
  const firstWeightRoll = Math.floor(Math.random() * Math.max(1, AFFIX_STYLE_ROLL_WEIGHT_TOTAL));
  styles.push(rollAffixStyleByWeight(firstWeightRoll));
  const secondRoll = Math.random() * AFFIX_ROLL_DENOMINATOR;
  if (styles.length < AFFIX_MULTI_STYLE_MAX_PER_CARD && secondRoll < AFFIX_CARD_SECOND_STYLE_THRESHOLD) {
    const secondWeightRoll = Math.floor(Math.random() * Math.max(1, AFFIX_STYLE_ROLL_WEIGHT_TOTAL));
    styles.push(rollAffixStyleByWeight(secondWeightRoll));
  }
  const thirdRoll = Math.random() * AFFIX_ROLL_DENOMINATOR;
  if (styles.length < AFFIX_MULTI_STYLE_MAX_PER_CARD && thirdRoll < AFFIX_CARD_THIRD_STYLE_THRESHOLD) {
    const thirdWeightRoll = Math.floor(Math.random() * Math.max(1, AFFIX_STYLE_ROLL_WEIGHT_TOTAL));
    styles.push(rollAffixStyleByWeight(thirdWeightRoll));
  }
  return normalizeAffixStyleList(styles);
}

function rollAffixStyleCountForReforge() {
  let count = 1;
  const secondRoll = Math.random() * AFFIX_ROLL_DENOMINATOR;
  if (count < AFFIX_MULTI_STYLE_MAX_PER_CARD && secondRoll < AFFIX_CARD_SECOND_STYLE_THRESHOLD) {
    count += 1;
  }
  const thirdRoll = Math.random() * AFFIX_ROLL_DENOMINATOR;
  if (count < AFFIX_MULTI_STYLE_MAX_PER_CARD && thirdRoll < AFFIX_CARD_THIRD_STYLE_THRESHOLD) {
    count += 1;
  }
  return count;
}

function rollAffixStylesByCount(count: number) {
  const normalizedCount = Math.max(1, Math.min(
    AFFIX_MULTI_STYLE_MAX_PER_CARD,
    Math.floor(Number(count) || 1)
  ));
  const styles: AffixVisualStyle[] = [];
  for (let i = 0; i < normalizedCount; i += 1) {
    const weightRoll = Math.floor(Math.random() * Math.max(1, AFFIX_STYLE_ROLL_WEIGHT_TOTAL));
    styles.push(rollAffixStyleByWeight(weightRoll));
  }
  return normalizeAffixStyleList(styles, normalizedCount);
}

function rollReforgeAffixStyles(options?: {
  minCount?: number;
  excludeSignature?: string | null;
  maxAttempts?: number;
}) {
  const minCount = Math.max(1, Math.min(
    AFFIX_MULTI_STYLE_MAX_PER_CARD,
    Math.floor(Number(options?.minCount) || 1)
  ));
  const targetCount = Math.max(minCount, rollAffixStyleCountForReforge());
  const excludeSignature = options?.excludeSignature
    ? affixSignatureFromStyles(parseAffixSignature(options.excludeSignature))
    : null;
  const maxAttempts = Math.max(1, Math.floor(Number(options?.maxAttempts) || 16));

  let lastStyles = rollAffixStylesByCount(targetCount);
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const rolledStyles = attempt === 0 ? lastStyles : rollAffixStylesByCount(targetCount);
    lastStyles = rolledStyles;
    const rolledSignature = affixSignatureFromStyles(rolledStyles);
    if (!excludeSignature || rolledSignature !== excludeSignature) {
      return rolledStyles;
    }
  }

  if (excludeSignature && lastStyles.length > 0) {
    const fallbackStyles = [...lastStyles];
    const mutateIndex = Math.floor(Math.random() * fallbackStyles.length);
    const current = fallbackStyles[mutateIndex] ?? 'MONO';
    const candidates = FALLBACK_AFFIX_STYLES.filter((style) => style !== current);
    fallbackStyles[mutateIndex] = candidates[Math.floor(Math.random() * Math.max(1, candidates.length))] ?? current;
    const mutated = normalizeAffixStyleList(fallbackStyles, targetCount);
    if (affixSignatureFromStyles(mutated) !== excludeSignature) {
      return mutated;
    }
  }

  return lastStyles;
}

function parseAffixVariantMap(raw: Prisma.JsonValue | null | undefined): AffixVariantMap {
  const map = emptyAffixVariantMap();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return map;
  }
  const json = raw as Record<string, unknown>;
  for (const [rawKey, rawValue] of Object.entries(json)) {
    const count = Math.max(0, Math.floor(Number(rawValue) || 0));
    if (count <= 0) continue;
    const signature = affixSignatureFromStyles(parseAffixSignature(rawKey));
    map[signature] = (map[signature] ?? 0) + count;
  }
  return map;
}

function variantMapTotal(map: AffixVariantMap) {
  return Object.values(map).reduce((sum, value) => sum + Math.max(0, Math.floor(value || 0)), 0);
}

function variantMapToStyleCountMap(map: AffixVariantMap) {
  const counts = emptyAffixStyleCountMap();
  for (const [signature, countRaw] of Object.entries(map)) {
    const count = Math.max(0, Math.floor(countRaw || 0));
    if (count <= 0) continue;
    const fingerprint = buildAffixFingerprintFromSignature(signature);
    for (const style of AFFIX_STACK_STYLE_ORDER) {
      const styleCount = Math.max(0, Math.floor(fingerprint.affixStyleCounts[style] ?? 0));
      if (styleCount <= 0) continue;
      counts[style] += styleCount * count;
    }
  }
  return counts;
}

function normalizeAffixVariantMap(map: AffixVariantMap) {
  const normalized: AffixVariantMap = {};
  for (const [signatureRaw, countRaw] of Object.entries(map)) {
    const count = Math.max(0, Math.floor(countRaw || 0));
    if (count <= 0) continue;
    const signature = affixSignatureFromStyles(parseAffixSignature(signatureRaw));
    normalized[signature] = (normalized[signature] ?? 0) + count;
  }
  return normalized;
}

function variantEntrySortWeight(signature: string) {
  const fingerprint = buildAffixFingerprintFromSignature(signature);
  const primaryPriority = AFFIX_STACK_CONSUME_PRIORITY.indexOf(fingerprint.affixVisualStyle);
  const styleCount = fingerprint.affixStyles.length;
  return primaryPriority * 100 + styleCount;
}

function selectBatchDismantleInstances(
  freeInstances: Array<{ id: string; affixSignature: string; obtainedAt: Date }>,
  keepAtLeast: number,
  keepScope: DismantleKeepScope
) {
  const normalizedKeepAtLeast = Math.max(0, Math.floor(Number(keepAtLeast) || 0));
  const sortedByConsumePriority = [...freeInstances]
    .sort((a, b) => variantEntrySortWeight(a.affixSignature) - variantEntrySortWeight(b.affixSignature));

  if (keepScope === 'CARD') {
    const dismantleCount = Math.max(0, sortedByConsumePriority.length - normalizedKeepAtLeast);
    return sortedByConsumePriority.slice(0, dismantleCount);
  }

  const instancesByVariant = new Map<string, Array<{ id: string; affixSignature: string; obtainedAt: Date }>>();
  for (const inst of sortedByConsumePriority) {
    const signature = buildAffixFingerprintFromSignature(inst.affixSignature).affixSignature;
    const list = instancesByVariant.get(signature);
    if (list) {
      list.push(inst);
      continue;
    }
    instancesByVariant.set(signature, [inst]);
  }

  const variantSignatures = Array.from(instancesByVariant.keys())
    .sort((a, b) => variantEntrySortWeight(a) - variantEntrySortWeight(b));
  const toDelete: Array<{ id: string; affixSignature: string; obtainedAt: Date }> = [];
  for (const signature of variantSignatures) {
    const instances = [...(instancesByVariant.get(signature) ?? [])]
      .sort((a, b) => a.obtainedAt.getTime() - b.obtainedAt.getTime());
    const dismantleCount = Math.max(0, instances.length - normalizedKeepAtLeast);
    if (dismantleCount <= 0) continue;
    toDelete.push(...instances.slice(0, dismantleCount));
  }
  return toDelete;
}

function alignAffixVariantMapToCount(
  card: { id: string; title: string; tags?: string[] | null },
  map: AffixVariantMap,
  count: number
) {
  const normalizedCount = Math.max(0, Math.floor(Number(count) || 0));
  const normalizedMap = normalizeAffixVariantMap(map);
  let total = variantMapTotal(normalizedMap);
  if (total < normalizedCount) {
    const inferredStyle = inferLegacyAffixVisualStyle(card) ?? 'NONE';
    const fillSignature = affixSignatureFromStyles([inferredStyle]);
    normalizedMap[fillSignature] = (normalizedMap[fillSignature] ?? 0) + (normalizedCount - total);
    total = normalizedCount;
  }
  if (total > normalizedCount) {
    let overflow = total - normalizedCount;
    const signatures = Object.keys(normalizedMap)
      .sort((a, b) => variantEntrySortWeight(a) - variantEntrySortWeight(b));
    for (const signature of signatures) {
      if (overflow <= 0) break;
      const current = Math.max(0, Math.floor(normalizedMap[signature] ?? 0));
      if (current <= 0) continue;
      const deduct = Math.min(current, overflow);
      normalizedMap[signature] = current - deduct;
      overflow -= deduct;
      if (normalizedMap[signature] <= 0) {
        delete normalizedMap[signature];
      }
    }
  }
  return normalizeAffixVariantMap(normalizedMap);
}

function affixStackTotal(map: AffixStackMap) {
  return AFFIX_STACK_STYLE_ORDER.reduce((sum, style) => sum + Math.max(0, Math.floor(map[style] ?? 0)), 0);
}

function alignAffixStackToCount(
  card: { id: string; title: string; tags?: string[] | null },
  map: AffixStackMap,
  count: number
) {
  const variantMap = emptyAffixVariantMap();
  for (const style of AFFIX_STACK_STYLE_ORDER) {
    const value = Math.max(0, Math.floor(map[style] ?? 0));
    if (value <= 0) continue;
    variantMap[affixSignatureFromStyles([style])] = value;
  }
  const alignedVariantMap = alignAffixVariantMapToCount(card, variantMap, count);
  return variantMapToStyleCountMap(alignedVariantMap);
}

function normalizeInventoryAffixStacks(
  card: { id: string; title: string; tags?: string[] | null },
  count: number,
  raw: Prisma.JsonValue | null | undefined
) {
  const parsedVariantMap = parseAffixVariantMap(raw);
  const alignedVariantMap = alignAffixVariantMapToCount(card, parsedVariantMap, count);
  const alignedStyleMap = variantMapToStyleCountMap(alignedVariantMap);
  const normalizedRaw = normalizeJsonValue(raw);
  const normalizedAligned = normalizeJsonValue(serializeAffixStacks(alignedVariantMap));
  const needsPersist = JSON.stringify(normalizedRaw) !== JSON.stringify(normalizedAligned);
  return {
    map: alignedStyleMap,
    variantMap: alignedVariantMap,
    needsPersist
  };
}

function serializeAffixStacks(map: AffixStackMap | AffixVariantMap): Prisma.JsonObject {
  const output: Record<string, number> = {};
  for (const [key, valueRaw] of Object.entries(map)) {
    const value = Math.max(0, Math.floor(Number(valueRaw) || 0));
    if (value <= 0) continue;
    if ((AFFIX_VISUAL_STYLE_VALUES as readonly string[]).includes(key)) {
      const signature = affixSignatureFromStyles([key as AffixVisualStyle]);
      output[signature] = (output[signature] ?? 0) + value;
      continue;
    }
    const signature = affixSignatureFromStyles(parseAffixSignature(key));
    output[signature] = (output[signature] ?? 0) + value;
  }
  return output;
}

function consumeAffixStacks(
  map: AffixVariantMap | AffixStackMap,
  quantity: number,
  options?: { style?: AffixVisualStyle; affixSignature?: string }
) {
  let remaining = Math.max(0, Math.floor(quantity));
  const consumed: AffixStackEntry[] = [];
  const source = normalizeAffixVariantMap(map as AffixVariantMap);
  const targetStyle = options?.style ? normalizeAffixVisualStyleInput(options.style) : null;
  const targetSignature = options?.affixSignature
    ? affixSignatureFromStyles(parseAffixSignature(options.affixSignature))
    : null;

  const signatures = Object.keys(source).sort((a, b) => variantEntrySortWeight(a) - variantEntrySortWeight(b));
  for (const signature of signatures) {
    if (remaining <= 0) break;
    if (targetSignature && signature !== targetSignature) continue;
    const fingerprint = buildAffixFingerprintFromSignature(signature);
    if (targetStyle && !fingerprint.affixStyles.includes(targetStyle)) continue;
    const current = Math.max(0, Math.floor(source[signature] ?? 0));
    if (current <= 0) continue;
    const used = Math.min(current, remaining);
    source[signature] = current - used;
    remaining -= used;
    consumed.push({
      ...fingerprint,
      count: used
    });
  }

  for (const key of Object.keys(map)) {
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete (map as Record<string, number>)[key];
  }
  for (const [signature, count] of Object.entries(source)) {
    if (count <= 0) continue;
    (map as Record<string, number>)[signature] = count;
  }

  return {
    consumed,
    consumedCount: quantity - remaining,
    remainingCount: remaining
  };
}

function applyAffixStacksIncrement(map: AffixVariantMap | AffixStackMap, style: AffixVisualStyle, count: number) {
  const delta = Math.max(0, Math.floor(count));
  if (delta <= 0) return map;
  const signature = affixSignatureFromStyles([style]);
  (map as Record<string, number>)[signature] = Math.max(0, Math.floor((map as Record<string, number>)[signature] ?? 0)) + delta;
  return map;
}

function applyAffixVariantIncrement(map: AffixVariantMap, signature: string, count: number) {
  const delta = Math.max(0, Math.floor(count));
  if (delta <= 0) return map;
  const normalizedSignature = affixSignatureFromStyles(parseAffixSignature(signature));
  map[normalizedSignature] = Math.max(0, Math.floor(map[normalizedSignature] ?? 0)) + delta;
  return map;
}

function expandAffixStackEntries(
  card: { id: string; title: string; tags?: string[] | null },
  count: number,
  raw: Prisma.JsonValue | null | undefined
) {
  const { variantMap } = normalizeInventoryAffixStacks(card, count, raw);
  return Object.entries(variantMap)
    .map(([signature, stackCount]) => ({
      ...buildAffixFingerprintFromSignature(signature),
      count: Math.max(0, Math.floor(stackCount || 0))
    }))
    .filter((entry) => entry.count > 0)
    .sort((a, b) => variantEntrySortWeight(a.affixSignature) - variantEntrySortWeight(b.affixSignature));
}

// ─── Card Instance helpers ─────────────────────────────────────────────

async function createCardInstance(
  tx: Tx,
  userId: string,
  cardId: string,
  affixSignature: string,
  obtainedVia: string
) {
  const normalizedSignature = affixSignatureFromStyles(parseAffixSignature(affixSignature));
  const fingerprint = buildAffixFingerprintFromSignature(normalizedSignature);
  const instance = await tx.gachaCardInstance.create({
    data: {
      userId,
      cardId,
      affixVisualStyle: fingerprint.affixVisualStyle as PrismaAffixVisualStyle,
      affixSignature: normalizedSignature,
      affixLabel: fingerprint.affixLabel,
      obtainedVia
    }
  });
  await tx.gachaInventory.upsert({
    where: { userId_cardId: { userId, cardId } },
    create: { userId, cardId, count: 1 },
    update: { count: { increment: 1 } }
  });
  return instance;
}

async function deleteCardInstances(tx: Tx, instanceIds: string[]) {
  if (instanceIds.length === 0) return;
  const instances = await tx.gachaCardInstance.findMany({
    where: { id: { in: instanceIds } },
    select: { id: true, userId: true, cardId: true }
  });
  await tx.gachaPlacementSlot.updateMany({
    where: { instanceId: { in: instanceIds } },
    data: { instanceId: null, inventoryId: null, cardId: null, affixSignature: null, affixVisualStyle: null, affixLabel: null, assignedAt: null }
  });
  await tx.gachaCardInstance.deleteMany({
    where: { id: { in: instanceIds } }
  });
  const countsByKey = new Map<string, { userId: string; cardId: string; count: number }>();
  for (const inst of instances) {
    const key = `${inst.userId}:${inst.cardId}`;
    const entry = countsByKey.get(key);
    if (entry) { entry.count += 1; } else { countsByKey.set(key, { userId: inst.userId, cardId: inst.cardId, count: 1 }); }
  }
  for (const entry of countsByKey.values()) {
    // eslint-disable-next-line no-await-in-loop
    await tx.gachaInventory.updateMany({
      where: { userId: entry.userId, cardId: entry.cardId },
      data: { count: { decrement: entry.count } }
    });
  }
}

async function findFreeInstances(
  tx: Tx,
  userId: string,
  cardId: string,
  opts?: { affixSignature?: string; limit?: number; includeLocked?: boolean; includeShowcased?: boolean; includePlaced?: boolean }
) {
  const where: Prisma.GachaCardInstanceWhereInput = {
    userId,
    cardId,
    tradeListingId: null,
    buyRequestId: null
  };
  if (!opts?.includePlaced) {
    where.placementSlot = { is: null };
  }
  if (!opts?.includeShowcased) {
    where.showcaseSlot = { is: null };
  }
  if (!opts?.includeLocked) {
    where.isLocked = false;
  }
  if (opts?.affixSignature) {
    where.affixSignature = affixSignatureFromStyles(parseAffixSignature(opts.affixSignature));
  }
  return tx.gachaCardInstance.findMany({
    where,
    orderBy: { obtainedAt: 'asc' },
    ...(opts?.limit ? { take: opts.limit } : {})
  });
}

/**
 * When a user explicitly accepts a buy request (sell), try to auto-free
 * an instance that is locked, placed, or showcased (but NOT in a trade
 * listing or another buy request). Returns the freed instance or null.
 */
async function autoFreeInstanceForSale(
  tx: Tx,
  userId: string,
  cardId: string,
  opts?: { affixSignature?: string }
): Promise<{ id: string; affixSignature: string } | null> {
  const where: Prisma.GachaCardInstanceWhereInput = {
    userId,
    cardId,
    tradeListingId: null,
    buyRequestId: null
  };
  if (opts?.affixSignature) {
    where.affixSignature = affixSignatureFromStyles(parseAffixSignature(opts.affixSignature));
  }
  const instance = await tx.gachaCardInstance.findFirst({
    where,
    include: {
      placementSlot: { select: { id: true } },
      showcaseSlot: { select: { id: true } }
    },
    orderBy: { obtainedAt: 'asc' }
  });
  if (!instance) return null;

  // Auto-unlock
  if (instance.isLocked) {
    await tx.gachaCardInstance.update({
      where: { id: instance.id },
      data: { isLocked: false, lockedAt: null }
    });
  }

  // Auto-clear placement slot
  if (instance.placementSlot) {
    await tx.gachaPlacementSlot.update({
      where: { id: instance.placementSlot.id },
      data: {
        cardId: null,
        inventoryId: null,
        instanceId: null,
        affixVisualStyle: null,
        affixSignature: null,
        affixLabel: null,
        assignedAt: null
      }
    });
  }

  // Auto-clear showcase slot
  if (instance.showcaseSlot) {
    await tx.gachaShowcaseSlot.delete({
      where: { id: instance.showcaseSlot.id }
    });
  }

  return { id: instance.id, affixSignature: instance.affixSignature };
}

async function groupInstancesByVariant(
  tx: Tx | typeof prisma,
  userId: string,
  cardId: string
) {
  const instances = await tx.gachaCardInstance.findMany({
    where: { userId, cardId, tradeListingId: null },
    select: { affixSignature: true, affixVisualStyle: true, affixLabel: true }
  });
  const groups = new Map<string, { affixSignature: string; affixVisualStyle: PrismaAffixVisualStyle; affixLabel: string | null; count: number }>();
  for (const inst of instances) {
    const normalizedSignature = affixSignatureFromStyles(parseAffixSignature(
      inst.affixSignature || inst.affixVisualStyle || 'NONE'
    ));
    const existing = groups.get(normalizedSignature);
    if (existing) {
      existing.count += 1;
    } else {
      groups.set(normalizedSignature, {
        affixSignature: normalizedSignature,
        affixVisualStyle: inst.affixVisualStyle,
        affixLabel: inst.affixLabel,
        count: 1
      });
    }
  }
  return [...groups.values()].sort((a, b) => variantEntrySortWeight(a.affixSignature) - variantEntrySortWeight(b.affixSignature));
}

async function lockInstancesForTrade(tx: Tx, instanceIds: string[], tradeListingId: string) {
  if (instanceIds.length === 0) return;
  const instances = await tx.gachaCardInstance.findMany({
    where: { id: { in: instanceIds } },
    select: { userId: true, cardId: true }
  });
  await tx.gachaCardInstance.updateMany({
    where: { id: { in: instanceIds } },
    data: { tradeListingId }
  });
  const countsByKey = new Map<string, { userId: string; cardId: string; count: number }>();
  for (const inst of instances) {
    const key = `${inst.userId}:${inst.cardId}`;
    const entry = countsByKey.get(key);
    if (entry) { entry.count += 1; } else { countsByKey.set(key, { userId: inst.userId, cardId: inst.cardId, count: 1 }); }
  }
  // Batch decrement inventory counts in a single raw SQL statement
  const entries = [...countsByKey.values()];
  if (entries.length > 0) {
    await tx.$executeRaw(Prisma.sql`
      UPDATE "GachaInventory" AS inv
      SET count = inv.count - batch.cnt, "updatedAt" = NOW()
      FROM (VALUES ${Prisma.join(
        entries.map(e => Prisma.sql`(${e.userId}, ${e.cardId}, ${e.count}::int)`)
      )}) AS batch("userId", "cardId", cnt)
      WHERE inv."userId" = batch."userId" AND inv."cardId" = batch."cardId"
    `);
  }
}

async function unlockTradeInstances(tx: Tx, tradeListingId: string) {
  const instances = await tx.gachaCardInstance.findMany({
    where: { tradeListingId },
    select: { id: true, userId: true, cardId: true }
  });
  if (instances.length === 0) return;
  await tx.gachaCardInstance.updateMany({
    where: { tradeListingId },
    data: { tradeListingId: null }
  });
  const countsByKey = new Map<string, { userId: string; cardId: string; count: number }>();
  for (const inst of instances) {
    const key = `${inst.userId}:${inst.cardId}`;
    const entry = countsByKey.get(key);
    if (entry) { entry.count += 1; } else { countsByKey.set(key, { userId: inst.userId, cardId: inst.cardId, count: 1 }); }
  }
  // Batch upsert inventory counts in a single raw SQL statement
  const entries = [...countsByKey.values()];
  if (entries.length > 0) {
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "GachaInventory" (id, "userId", "cardId", count, "createdAt", "updatedAt")
      VALUES ${Prisma.join(
        entries.map(e => Prisma.sql`(gen_random_uuid()::text, ${e.userId}, ${e.cardId}, ${e.count}::int, NOW(), NOW())`)
      )}
      ON CONFLICT ("userId", "cardId") DO UPDATE
      SET count = "GachaInventory".count + EXCLUDED.count, "updatedAt" = NOW()
    `);
  }
}

async function transferInstances(tx: Tx, instanceIds: string[], fromUserId: string, toUserId: string) {
  if (instanceIds.length === 0) return;
  const instances = await tx.gachaCardInstance.findMany({
    where: { id: { in: instanceIds } },
    select: { id: true, cardId: true }
  });
  await tx.gachaCardInstance.updateMany({
    where: { id: { in: instanceIds } },
    data: { userId: toUserId, tradeListingId: null, buyRequestId: null }
  });
  const countsByCard = new Map<string, number>();
  for (const inst of instances) {
    countsByCard.set(inst.cardId, (countsByCard.get(inst.cardId) ?? 0) + 1);
  }
  // Batch upsert recipient inventory in a single raw SQL statement
  const entries = [...countsByCard.entries()];
  if (entries.length > 0) {
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "GachaInventory" (id, "userId", "cardId", count, "createdAt", "updatedAt")
      VALUES ${Prisma.join(
        entries.map(([cardId, count]) => Prisma.sql`(gen_random_uuid()::text, ${toUserId}, ${cardId}, ${count}::int, NOW(), NOW())`)
      )}
      ON CONFLICT ("userId", "cardId") DO UPDATE
      SET count = "GachaInventory".count + EXCLUDED.count, "updatedAt" = NOW()
    `);
  }
}

// ─── End Card Instance helpers ─────────────────────────────────────────

function computeDismantleRewardByAffix(
  card: { rarity: GachaRarity },
  consumed: Array<{ affixVisualStyle: AffixVisualStyle; affixStyles?: AffixVisualStyle[]; affixSignature?: string; count: number }>
) {
  const basePerCard = DEFAULT_DISMANTLE_REWARD_BY_RARITY[card.rarity] ?? 0;
  let baseReward = 0;
  let totalReward = 0;
  const byAffix = consumed
    .filter((entry) => entry.count > 0)
    .map((entry) => {
      const count = Math.max(0, Math.floor(entry.count));
      const fingerprint = entry.affixSignature
        ? buildAffixFingerprintFromSignature(entry.affixSignature)
        : buildAffixFingerprintFromStyles(entry.affixStyles?.length ? entry.affixStyles : [entry.affixVisualStyle]);
      const bonusPerCard = fingerprint.affixStyles.reduce((sum, style) => (
        sum + getAffixDismantleBonusPercent(card, style)
      ), 0);
      const styleBaseReward = basePerCard * count;
      const styleReward = Math.max(0, Math.floor(styleBaseReward * (1 + bonusPerCard)));
      baseReward += styleBaseReward;
      totalReward += styleReward;
      return {
        affixVisualStyle: fingerprint.affixVisualStyle,
        affixSignature: fingerprint.affixSignature,
        affixStyles: fingerprint.affixStyles,
        affixStyleCounts: fingerprint.affixStyleCounts,
        affixLabel: fingerprint.affixLabel,
        count,
        affixDismantleBonusPercent: bonusPerCard,
        baseReward: styleBaseReward,
        reward: styleReward
      };
    });
  return {
    basePerCard,
    baseReward,
    totalReward,
    bonusReward: Math.max(0, totalReward - baseReward),
    byAffix
  };
}

function matchesTags(cardTags: string[], boostTags: string[], mode: GachaMatchMode) {
  if (boostTags.length === 0) return true;
  const normalizedCardTags = new Set(cardTags.map((t) => t.toLowerCase()));
  if (mode === 'ALL') {
    return boostTags.every((tag) => normalizedCardTags.has(tag.toLowerCase()));
  }
  return boostTags.some((tag) => normalizedCardTags.has(tag.toLowerCase()));
}

function matchesBoost(cardTags: string[], boost: { includeTags: string[]; excludeTags: string[]; matchMode: GachaMatchMode }) {
  if (boost.includeTags.length === 0 && boost.excludeTags.length === 0) return true;
  const includeOk = matchesTags(cardTags, boost.includeTags, boost.matchMode);
  if (!includeOk) return false;
  if (boost.excludeTags.length === 0) return true;
  const lowerTags = new Set(cardTags.map((t) => t.toLowerCase()));
  return !boost.excludeTags.some((tag) => lowerTags.has(tag.toLowerCase()));
}

function computeAdjustedWeight(card: { weight: number | null; tags?: string[] | null }, boosts: Array<{
  includeTags: string[];
  excludeTags: string[];
  matchMode: GachaMatchMode;
  weightMultiplier: number;
}>) {
  let weight = card.weight ?? DEFAULT_CARD_WEIGHT;
  for (const boost of boosts) {
    if (!boost.weightMultiplier || boost.weightMultiplier <= 0) continue;
    if (matchesBoost(card.tags ?? [], boost)) {
      weight *= boost.weightMultiplier;
    }
  }
  return weight;
}

function pickWeightedCard<T>(cards: Array<{ card: T; weight: number }>) {
  const total = cards.reduce((sum, item) => sum + item.weight, 0);
  if (total <= 0) return cards[cards.length - 1]?.card;
  let r = Math.random() * total;
  for (const item of cards) {
    r -= item.weight;
    if (r <= 0) {
      return item.card;
    }
  }
  return cards[cards.length - 1]?.card;
}

function isPurpleOrHigherRarity(rarity: GachaRarity) {
  return rarity === 'PURPLE' || rarity === 'GOLD';
}

type FlatPoolItem = Omit<DrawPoolCardSnapshot, 'variants'>;

function normalizeVariantImageUrl(imageUrl: string | null | undefined) {
  const normalized = typeof imageUrl === 'string' ? imageUrl.trim() : '';
  return normalized.length > 0 ? normalized : null;
}

function variantIdPriority(id: string) {
  if (/^permanent-\d+$/.test(id)) return 0;
  if (/^permanent-main-pool-\d+$/.test(id)) return 1;
  if (/^permanent-original-pool-\d+$/.test(id)) return 2;
  return 3;
}

function isRetiredCard(card: { poolId?: string | null; weight?: number | null | undefined }) {
  return card.poolId === PERMANENT_POOL_ID && Number(card.weight ?? DEFAULT_CARD_WEIGHT) <= 0;
}

function pickPreferredVariant<T extends { id: string; poolId?: string | null; weight?: number | null }>(variants: T[]): T {
  return variants
    .slice()
    .sort((a, b) => {
      const retiredDiff = Number(isRetiredCard(a)) - Number(isRetiredCard(b));
      if (retiredDiff !== 0) return retiredDiff;
      const priorityDiff = variantIdPriority(a.id) - variantIdPriority(b.id);
      if (priorityDiff !== 0) return priorityDiff;
      if (a.id.length !== b.id.length) return a.id.length - b.id.length;
      return a.id.localeCompare(b.id);
    })[0]!;
}

function buildImageVariants<T extends { id: string; imageUrl: string | null; poolId?: string | null; weight?: number | null }>(
  variants: T[]
): Array<{ id: string; imageUrl: string | null; isRetired?: boolean }> {
  if (variants.length === 0) return [];
  const variantsByImage = new Map<string, T[]>();
  for (const variant of variants) {
    const normalizedImage = normalizeVariantImageUrl(variant.imageUrl);
    if (!normalizedImage) continue;
    const group = variantsByImage.get(normalizedImage);
    if (group) {
      group.push(variant);
    } else {
      variantsByImage.set(normalizedImage, [variant]);
    }
  }

  if (variantsByImage.size === 0) {
    const fallback = pickPreferredVariant(variants);
    return [{
      id: fallback.id,
      imageUrl: null,
      isRetired: isRetiredCard(fallback) || undefined
    }];
  }

  const merged: Array<{ id: string; imageUrl: string | null; isRetired?: boolean }> = [];
  for (const [imageUrl, group] of variantsByImage.entries()) {
    const picked = pickPreferredVariant(group);
    merged.push({
      id: picked.id,
      imageUrl,
      isRetired: isRetiredCard(picked) || undefined
    });
  }
  return merged;
}

function deduplicatePoolByPage(flatItems: FlatPoolItem[]): DrawPoolCardSnapshot[] {
  const pageGroups = new Map<string, FlatPoolItem[]>();
  let nullIdx = 0;
  for (const item of flatItems) {
    const key = item.pageId != null ? String(item.pageId) : `__null_${nullIdx++}`;
    const group = pageGroups.get(key);
    if (group) group.push(item);
    else pageGroups.set(key, [item]);
  }
  const items: DrawPoolCardSnapshot[] = [];
  for (const group of pageGroups.values()) {
    const first = group[0]!;
    if (first.adjustedWeight <= 0) continue;
    items.push({
      ...first,
      variants: buildImageVariants(group)
    });
  }
  return items;
}

async function fetchActiveBoostRules(tx: typeof prisma | Tx, date = now()) {
  return tx.gachaGlobalBoost.findMany({
    where: {
      isActive: true,
      AND: [
        { startsAt: { lte: date } },
        { OR: [{ endsAt: { gte: date } }, { endsAt: null }] }
      ]
    },
    select: {
      includeTags: true,
      excludeTags: true,
      matchMode: true,
      weightMultiplier: true
    }
  });
}

async function loadDrawPoolSnapshot(asOf = now(), force = false) {
  const canUseCache = Math.abs(Date.now() - asOf.getTime()) <= 60_000;
  if (
    canUseCache
    && !force
    && drawPoolCache
    && Date.now() - drawPoolCache.fetchedAt <= DRAW_POOL_CACHE_TTL_MS
  ) {
    return drawPoolCache.items;
  }

  const [cards, boosts] = await Promise.all([
    prisma.gachaCardDefinition.findMany({
      where: { poolId: PERMANENT_POOL_ID },
      select: {
        id: true,
        title: true,
        rarity: true,
        tags: true,
        authorKeys: true,
        imageUrl: true,
        wikidotId: true,
        pageId: true,
        rewardTokens: true,
        weight: true
      }
    }),
    fetchActiveBoostRules(prisma, asOf)
  ]);

  const items: DrawPoolCardSnapshot[] = deduplicatePoolByPage(
    cards
      .map((card) => ({
        id: card.id,
        title: card.title,
        rarity: card.rarity,
        tags: card.tags ?? [],
        authors: resolveCardAuthorsFromTags(card.tags, card.authorKeys),
        imageUrl: card.imageUrl ?? null,
        wikidotId: card.wikidotId ?? null,
        pageId: card.pageId ?? null,
        rewardTokens: Math.max(0, Math.floor(Number(card.rewardTokens ?? 0) || 0)),
        adjustedWeight: computeAdjustedWeight(card, boosts)
      }))
      .filter((item) => item.adjustedWeight > 0)
  );

  if (canUseCache) {
    drawPoolCache = {
      fetchedAt: Date.now(),
      items
    };
  }
  return items;
}

async function ensureWallet(tx: Tx, userId: string) {
  const existing = await tx.gachaWallet.findUnique({ where: { userId } });
  if (existing) return existing;
  const created = await tx.gachaWallet.create({
    data: {
      userId,
      balance: INITIAL_WALLET_BALANCE,
      totalEarned: INITIAL_WALLET_BALANCE
    }
  });
  if (INITIAL_WALLET_BALANCE > 0) {
    await recordLedger(tx, created.id, userId, INITIAL_WALLET_BALANCE, 'WALLET_INIT', { initialBalance: INITIAL_WALLET_BALANCE });
  }
  return created;
}

async function recordLedger(tx: Tx, walletId: string, userId: string, delta: number, reason: string, metadata?: Prisma.JsonObject) {
  await tx.gachaLedgerEntry.create({
    data: {
      walletId,
      userId,
      delta,
      reason,
      metadata
    }
  });
}

async function applyWalletDelta(
  tx: Tx,
  wallet: { id: string; userId: string; balance: number },
  delta: number,
  reason: string,
  metadata?: Prisma.JsonObject,
  allowNegative = false
): Promise<Prisma.GachaWalletGetPayload<{}>> {
  if (delta === 0) {
    return tx.gachaWallet.findUniqueOrThrow({ where: { id: wallet.id } });
  }
  if (!allowNegative && delta < 0 && wallet.balance + delta < 0) {
    throw Object.assign(new Error('余额不足'), { status: 400, code: 'INSUFFICIENT_BALANCE' });
  }
  const data: Prisma.GachaWalletUpdateInput = {
    balance: { increment: delta }
  };
  if (delta > 0) {
    data.totalEarned = { increment: delta };
  } else if (delta < 0) {
    data.totalSpent = { increment: -delta };
  }
  const updated = await tx.gachaWallet.update({
    where: { id: wallet.id },
    data
  });
  await recordLedger(tx, wallet.id, wallet.userId, delta, reason, metadata);
  return updated;
}

function isPoolCurrentlyActive(
  pool: { isActive: boolean; startsAt?: Date | null; endsAt?: Date | null },
  date = now()
) {
  if (!pool.isActive) return false;
  if (pool.startsAt && pool.startsAt > date) return false;
  if (pool.endsAt && pool.endsAt < date) return false;
  return true;
}

async function executeDrawForUser(
  tx: Tx,
  options: {
    userId: string;
    drawCount: number;
    poolId?: string | null;
    tokensCost: number;
    spendReason: string;
    spendMetadata?: Prisma.JsonObject;
    prefetchedCards?: DrawPoolCardSnapshot[];
    wallet?: Prisma.GachaWalletGetPayload<{}>;
  }
) {
  const targetPoolId = options.poolId || PERMANENT_POOL_ID;
  if (targetPoolId !== PERMANENT_POOL_ID) {
    throw Object.assign(new Error('当前仅支持常驻卡池'), { status: 400 });
  }
  const asOf = now();
  const pool = await tx.gachaPool.findUnique({
    where: { id: PERMANENT_POOL_ID },
    select: {
      id: true,
      isActive: true,
      startsAt: true,
      endsAt: true
    }
  });
  if (!pool || !isPoolCurrentlyActive(pool, asOf)) {
    throw Object.assign(new Error('卡池不存在或未开放'), { status: 404 });
  }

  let drawableCards: DrawPoolCardSnapshot[] = (options.prefetchedCards ?? [])
    .filter((item) => item.adjustedWeight > 0);
  if (drawableCards.length === 0) {
    const [cards, boosts] = await Promise.all([
      tx.gachaCardDefinition.findMany({
        where: { poolId: PERMANENT_POOL_ID },
        select: {
          id: true,
          title: true,
          rarity: true,
          tags: true,
          authorKeys: true,
          imageUrl: true,
          wikidotId: true,
          pageId: true,
          rewardTokens: true,
          weight: true
        }
      }),
      fetchActiveBoostRules(tx)
    ]);
    drawableCards = deduplicatePoolByPage(
      cards
        .map((card) => ({
          id: card.id,
          title: card.title,
          rarity: card.rarity,
          tags: card.tags ?? [],
          authors: resolveCardAuthorsFromTags(card.tags, card.authorKeys),
          imageUrl: card.imageUrl ?? null,
          wikidotId: card.wikidotId ?? null,
          pageId: card.pageId ?? null,
          rewardTokens: Math.max(0, Math.floor(Number(card.rewardTokens ?? 0) || 0)),
          adjustedWeight: computeAdjustedWeight(card, boosts)
        }))
        .filter((item) => item.adjustedWeight > 0)
    );
  }
  if (drawableCards.length === 0) {
    throw Object.assign(new Error('卡池无有效卡片'), { status: 400 });
  }

  let wallet = options.wallet ?? await ensureWallet(tx, options.userId);
  if (options.tokensCost > 0) {
    if (wallet.balance < options.tokensCost) {
      throw Object.assign(new Error('Token 余额不足'), { status: 400 });
    }
    wallet = await applyWalletDelta(
      tx,
      wallet,
      -options.tokensCost,
      options.spendReason,
      options.spendMetadata
    );
  }
  const rarityRewards = await loadRarityRewards(tx);

  const cardsWithWeights = drawableCards
    .map((card) => ({
      card,
      weight: card.adjustedWeight
    }))
    .filter((item) => item.weight > 0);
  const purpleOrHigherCardsWithWeights = cardsWithWeights
    .filter((item) => isPurpleOrHigherRarity(item.card.rarity));
  const goldCardsWithWeights = cardsWithWeights
    .filter((item) => item.card.rarity === 'GOLD');

  const drawItemsForCreate: Array<{ cardId: string; rarity: GachaRarity; rewardTokens: number }> = [];
  const rarityCounter: Record<GachaRarity, number> = {
    WHITE: 0,
    GREEN: 0,
    BLUE: 0,
    PURPLE: 0,
    GOLD: 0
  };
  const responseItems: Array<{
    id: string;
    title: string;
    rarity: GachaRarity;
    tags: string[];
    authors: Array<{ name: string; wikidotId: number | null }> | null;
    imageUrl: string | null;
    wikidotId: number | null;
    pageId: number | null;
    rewardTokens: number;
    duplicate: boolean;
    countAfter: number;
    affixSignature: string;
    affixStyles: AffixVisualStyle[];
    affixStyleCounts: AffixStyleCountMap;
    affixVisualStyle: AffixVisualStyle;
    affixLabel: string;
    affixYieldBoostPercent: number;
    affixOfflineBufferBonus: number;
    affixDismantleBonusPercent: number;
  }> = [];
  let totalRewardTokens = 0;
  const pityBefore = await loadWalletPityCounters(tx, wallet.id);
  let purplePityCount = pityBefore.purplePityCount;
  let goldPityCount = pityBefore.goldPityCount;

  const pickedCards: DrawPoolCardSnapshot[] = [];
  for (let index = 0; index < options.drawCount; index += 1) {
    const shouldTriggerGoldPity = goldPityCount + 1 >= GOLD_PITY_THRESHOLD;
    const shouldTriggerPurplePity = !shouldTriggerGoldPity && purplePityCount + 1 >= PURPLE_PITY_THRESHOLD;
    let pickPool = cardsWithWeights;
    if (shouldTriggerGoldPity) {
      if (goldCardsWithWeights.length <= 0) {
        throw Object.assign(new Error('卡池缺少金色卡片，无法执行金色保底'), { status: 400 });
      }
      pickPool = goldCardsWithWeights;
    } else if (shouldTriggerPurplePity) {
      if (purpleOrHigherCardsWithWeights.length <= 0) {
        throw Object.assign(new Error('卡池缺少紫色及以上卡片，无法执行紫色保底'), { status: 400 });
      }
      pickPool = purpleOrHigherCardsWithWeights;
    }

    const pickedCard = pickWeightedCard(pickPool);
    if (!pickedCard) continue;
    pickedCards.push(pickedCard);

    if (pickedCard.rarity === 'GOLD') {
      purplePityCount = 0;
      goldPityCount = 0;
    } else if (pickedCard.rarity === 'PURPLE') {
      purplePityCount = 0;
      goldPityCount += 1;
    } else {
      purplePityCount += 1;
      goldPityCount += 1;
    }
  }

  // Resolve a random image variant for each picked page-level card
  const resolvedPicks = pickedCards.map((card) => {
    const variant = card.variants[Math.floor(Math.random() * card.variants.length)]!;
    return { card, chosenCardId: variant.id, chosenImageUrl: variant.imageUrl };
  });

  const uniqueCardIds = Array.from(new Set(resolvedPicks.map((p) => p.chosenCardId)));
  const existingInventory = uniqueCardIds.length > 0
    ? await tx.gachaInventory.findMany({
        where: {
          userId: options.userId,
          cardId: { in: uniqueCardIds }
        },
        select: {
          cardId: true,
          count: true
        }
      })
    : [];
  const inventoryCountBefore = new Map<string, number>();
  for (const item of existingInventory) {
    inventoryCountBefore.set(item.cardId, item.count);
  }

  const countIncrements = new Map<string, number>();
  for (const { card: pickedCard, chosenCardId, chosenImageUrl } of resolvedPicks) {
    const previousCount = (inventoryCountBefore.get(chosenCardId) ?? 0) + (countIncrements.get(chosenCardId) ?? 0);
    const rolledStyles = rollDrawAffixStyles();
    const rolledFingerprint = buildAffixFingerprintFromStyles(rolledStyles);
    const nextCount = previousCount + 1;
    countIncrements.set(chosenCardId, (countIncrements.get(chosenCardId) ?? 0) + 1);
    // eslint-disable-next-line no-await-in-loop
    await createCardInstance(tx, options.userId, chosenCardId, rolledFingerprint.affixSignature, 'DRAW');
    const rarityReward = Math.max(0, Math.floor(Number(rarityRewards.drawRewards[pickedCard.rarity] ?? 0) || 0));
    const configuredReward = Math.max(0, Math.floor(Number(pickedCard.rewardTokens ?? 0) || 0));
    const rewardTokens = configuredReward > 0 ? configuredReward : rarityReward;
    drawItemsForCreate.push({
      cardId: chosenCardId,
      rarity: pickedCard.rarity,
      rewardTokens
    });
    rarityCounter[pickedCard.rarity] += 1;
    totalRewardTokens += rewardTokens;
    responseItems.push({
      id: chosenCardId,
      title: pickedCard.title,
      rarity: pickedCard.rarity,
      tags: pickedCard.tags ?? [],
      authors: pickedCard.authors ?? null,
      imageUrl: chosenImageUrl ?? null,
      wikidotId: pickedCard.wikidotId ?? null,
      pageId: pickedCard.pageId ?? null,
      rewardTokens,
      duplicate: previousCount > 0,
      countAfter: nextCount,
      ...resolveCardAffixWithBonus(pickedCard, {
        affixSignature: rolledFingerprint.affixSignature
      })
    });
  }

  for (const cardId of uniqueCardIds) {
    // eslint-disable-next-line no-await-in-loop
    await safeUpsertCardUnlock(tx, options.userId, cardId);
  }

  const nextPurplePityCount = Math.max(0, purplePityCount);
  const nextGoldPityCount = Math.max(0, goldPityCount);
  const pityCounters: WalletPityCounters = {
    purplePityCount: nextPurplePityCount,
    goldPityCount: nextGoldPityCount
  };
  if (
    pityBefore.purplePityCount !== pityCounters.purplePityCount
    || pityBefore.goldPityCount !== pityCounters.goldPityCount
  ) {
    await saveWalletPityCounters(tx, wallet.id, pityCounters);
  }

  if (totalRewardTokens > 0) {
    wallet = await applyWalletDelta(tx, wallet, totalRewardTokens, 'DRAW_REWARD', {
      poolId: pool.id,
      drawCount: options.drawCount
    });
  }

  const drawRecord = await tx.gachaDraw.create({
    data: {
      userId: options.userId,
      poolId: pool.id,
      drawCount: options.drawCount,
      tokensSpent: options.tokensCost,
      tokensReward: totalRewardTokens,
      items: {
        create: drawItemsForCreate.map((item) => ({
          cardId: item.cardId,
          rarity: item.rarity,
          rewardTokens: item.rewardTokens
        }))
      }
    }
  });

  if (options.drawCount === 10) {
    await grantTicketBalance(tx, wallet, options.userId, TEN_DRAW_REFORGE_REWARD, TEN_DRAW_REFORGE_SOURCE);
  }

  return {
    wallet,
    drawRecord,
    responseItems,
    rarityCounter,
    totalRewardTokens,
    pityCounters
  };
}

async function fetchActivePools(tx: typeof prisma | Tx, date = now()) {
  const permanent = await tx.gachaPool.findUnique({
    where: { id: PERMANENT_POOL_ID }
  });
  if (permanent && isPoolCurrentlyActive(permanent, date)) {
    return [permanent];
  }
  return [];
}

async function fetchActiveBoosts(tx: typeof prisma | Tx, date = now()) {
  return tx.gachaGlobalBoost.findMany({
    where: {
      isActive: true,
      AND: [
        { startsAt: { lte: date } },
        { OR: [{ endsAt: { gte: date } }, { endsAt: null }] }
      ]
    },
    include: { createdBy: true }
  });
}

function serializePool(pool: Prisma.GachaPoolGetPayload<{}>) {
  return {
    id: pool.id,
    name: pool.name,
    description: pool.description,
    tokenCost: FIXED_DRAW_TOKEN_COST,
    tenDrawCost: FIXED_TEN_DRAW_TOKEN_COST,
    rewardPerDuplicate: DEFAULT_DUPLICATE_REWARD,
    startsAt: pool.startsAt?.toISOString() ?? null,
    endsAt: pool.endsAt?.toISOString() ?? null,
    isActive: pool.isActive
  };
}

function hasCreatedBy(boost: BoostWithMaybeCreator): boost is BoostWithCreator {
  return (boost as BoostWithCreator).createdBy !== undefined && (boost as BoostWithCreator).createdBy !== null;
}

function serializeBoost(boost: BoostWithMaybeCreator) {
  const createdBy = hasCreatedBy(boost) ? boost.createdBy : undefined;
  return {
    id: boost.id,
    includeTags: boost.includeTags ?? [],
    excludeTags: boost.excludeTags ?? [],
    match: matchModeToString(boost.matchMode),
    weightMultiplier: boost.weightMultiplier,
    startsAt: boost.startsAt?.toISOString() ?? null,
    endsAt: boost.endsAt?.toISOString() ?? null,
    isActive: boost.isActive,
    createdAt: boost.createdAt?.toISOString() ?? null,
    updatedAt: boost.updatedAt?.toISOString() ?? null,
    createdBy: createdBy ? {
      id: createdBy.id,
      email: createdBy.email,
      displayName: createdBy.displayName
    } : null
  };
}

function serializeCardSummary(card: {
  id: string;
  title: string;
  rarity: GachaRarity;
  tags?: string[] | null;
  authorKeys?: string[] | null;
  imageUrl?: string | null;
  wikidotId?: number | null;
  pageId?: number | null;
  poolId?: string | null;
  weight?: number | null;
}) {
  return {
    id: card.id,
    title: card.title,
    rarity: card.rarity,
    tags: card.tags ?? [],
    authors: resolveCardAuthorsFromTags(card.tags, card.authorKeys ?? []),
    imageUrl: card.imageUrl ?? null,
    wikidotId: card.wikidotId ?? null,
    pageId: card.pageId ?? null,
    isRetired: isRetiredCard(card)
  };
}

function serializeCard(card: Prisma.GachaCardDefinitionGetPayload<{}> & { pool?: { id: string; name: string } | null }) {
  return {
    ...serializeCardSummary(card),
    poolId: card.poolId,
    weight: card.weight ?? DEFAULT_CARD_WEIGHT,
    rewardTokens: card.rewardTokens ?? 0,
    createdAt: card.createdAt?.toISOString() ?? null,
    updatedAt: card.updatedAt?.toISOString() ?? null,
    poolName: card.pool?.name ?? null
  };
}

function buildProgressResponse(
  totalCards: Array<Pick<Prisma.GachaCardDefinitionGetPayload<{}>, 'id' | 'rarity'>>,
  ownedCardIds: Set<string>
) {
  const byRarityMap: Record<GachaRarity, { total: number; collected: number }> = {
    GOLD: { total: 0, collected: 0 },
    PURPLE: { total: 0, collected: 0 },
    BLUE: { total: 0, collected: 0 },
    GREEN: { total: 0, collected: 0 },
    WHITE: { total: 0, collected: 0 }
  };

  let collected = 0;
  for (const card of totalCards) {
    byRarityMap[card.rarity].total += 1;
    if (ownedCardIds.has(card.id)) {
      collected += 1;
      byRarityMap[card.rarity].collected += 1;
    }
  }

  return {
    total: totalCards.length,
    collected,
    byRarity: RARITY_ORDER.map((rarity) => ({
      rarity,
      total: byRarityMap[rarity].total,
      collected: byRarityMap[rarity].collected
    }))
  };
}

function sortPoolsForDisplay(pools: Prisma.GachaPoolGetPayload<{}>[]) {
  return [...pools].sort((a, b) => {
    if (a.id === PERMANENT_POOL_ID && b.id !== PERMANENT_POOL_ID) return -1;
    if (b.id === PERMANENT_POOL_ID && a.id !== PERMANENT_POOL_ID) return 1;
    const aStart = a.startsAt ? a.startsAt.getTime() : 0;
    const bStart = b.startsAt ? b.startsAt.getTime() : 0;
    if (aStart !== bStart) return aStart - bStart;
    return a.createdAt.getTime() - b.createdAt.getTime();
  });
}

type PlacementState = Prisma.GachaPlacementStateGetPayload<{}>;
type PlacementSlotWithCard = Prisma.GachaPlacementSlotGetPayload<{ include: { card: true; instance: { select: { isLocked: true } } } }>;
type PlacementAddonWithCard = {
  id: string;
  userId: string;
  kind: PlacementAddonKind;
  cardId: string;
  affixVisualStyle: AffixVisualStyle | null;
  affixSignature: string | null;
  affixLabel: string | null;
  inventoryId: string | null;
  assignedAt: Date;
  card: PlacementSlotWithCard['card'];
  isLocked: boolean;
};
type PlacementSlotAffix = {
  affixVisualStyle: AffixVisualStyle;
  affixSignature: string;
  affixStyles: AffixVisualStyle[];
  affixStyleCounts: AffixStyleCountMap;
  affixLabel: string;
  yieldBoostPercent: number;
  offlineBufferBonus: number;
  dismantleBonusPercent: number;
};

type PlacementContentType = 'SCP' | 'TRANSLATION' | 'GOI' | 'WANDERERS' | 'ART' | 'TALE' | 'OTHERS';
type PlacementAuthorKey = {
  key: string;
  label: string;
};

type PlacementComboParticipant = {
  card: NonNullable<PlacementSlotWithCard['card']>;
  affixStyleCounts: AffixStyleCountMap;
  contentType: PlacementContentType;
  authorKeys: PlacementAuthorKey[];
  comboTags: string[];
  isColorlessAddon: boolean;
  excludeFromCombo: boolean;
};

type PlacementComboBonus = {
  key: string;
  label: string;
  yieldBoostPercent: number;
};

type PlacementMetrics = {
  unlockedSlotCount: number;
  slotMaxCount: number;
  nextUnlockCost: number | null;
  cap: number;
  pendingToken: number;
  claimableToken: number;
  baseYieldPerHour: number;
  addonYieldPerHour: number;
  estimatedYieldPerHour: number;
  yieldBoostPercent: number;
  yieldBoostPercentRaw: number;
  yieldBoostCapped: boolean;
  baseYieldBoostPercent: number;
  affixYieldBoostPercent: number;
  comboYieldBoostPercent: number;
  offlineBufferBonus: number;
  offlineBufferBonusRaw: number;
  offlineBufferCapped: boolean;
  baseOfflineBufferBonus: number;
  affixOfflineBufferBonus: number;
  comboBonuses: PlacementComboBonus[];
  anchorFlatYieldPerHour: number;
  fluxDynamicYieldPerHour: number;
};

type IdempotencyScope = {
  userId: string;
  method: string;
  path: string;
  idemKey: string;
  requestHash: string;
};

type IdempotencyOutcome = {
  statusCode: number;
  responseJson: Record<string, unknown>;
};

const PLACEMENT_EPSILON = 1 / (10 ** PLACEMENT_DECIMAL_SCALE);

function placementRound(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Number(value.toFixed(PLACEMENT_DECIMAL_SCALE));
}

function placementDecimalToNumber(value: Prisma.Decimal | number | string | null | undefined) {
  if (value == null) return 0;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return numeric;
}

function toPlacementDecimal(value: number) {
  return new Prisma.Decimal(placementRound(value).toFixed(PLACEMENT_DECIMAL_SCALE));
}

function clampPlacementToken(value: number, cap: number) {
  const normalized = Number.isFinite(value) ? value : 0;
  return placementRound(Math.min(cap, Math.max(0, normalized)));
}

function getPlacementBaseOfflineBufferBonus(_userId: string) {
  return 0;
}

function getPlacementBaseYieldBoostPercent(_userId: string) {
  const percent = Number.isFinite(DEFAULT_PLACEMENT_YIELD_BOOST_PERCENT)
    ? DEFAULT_PLACEMENT_YIELD_BOOST_PERCENT
    : 0;
  return Math.max(0, percent);
}

function getPlacementAffixYieldBoostPercent(
  card: { rarity: GachaRarity } | null | undefined,
  affixVisualStyle: AffixVisualStyle
) {
  if (!card) return 0;
  const base = PLACEMENT_AFFIX_YIELD_BASE_BY_RARITY[card.rarity] ?? 0;
  const multiplier = PLACEMENT_AFFIX_YIELD_MULTIPLIER_BY_STYLE[affixVisualStyle] ?? 0;
  return placementRound(Math.max(0, base * multiplier));
}

function getPlacementAffixOfflineBufferBonus(
  card: { rarity: GachaRarity } | null | undefined,
  affixVisualStyle: AffixVisualStyle
) {
  if (!card) return 0;
  const base = PLACEMENT_AFFIX_OFFLINE_BASE_BY_RARITY[card.rarity] ?? 0;
  const multiplier = PLACEMENT_AFFIX_OFFLINE_MULTIPLIER_BY_STYLE[affixVisualStyle] ?? 0;
  return Math.max(0, Math.floor(base * multiplier));
}

function getAffixDismantleBonusPercent(
  card: { rarity: GachaRarity } | null | undefined,
  affixVisualStyle: AffixVisualStyle
) {
  if (!card) return 0;
  const base = AFFIX_DISMANTLE_BONUS_BASE_BY_RARITY[card.rarity] ?? 0;
  const multiplier = AFFIX_DISMANTLE_BONUS_MULTIPLIER_BY_STYLE[affixVisualStyle] ?? 0;
  return placementRound(Math.max(0, base * multiplier));
}

function resolveCardAffixWithBonus(
  card: { id: string; title: string; rarity: GachaRarity; tags?: string[] | null },
  overrides?: {
    affixVisualStyle?: AffixVisualStyle | null;
    affixSignature?: string | null;
    affixStyles?: AffixVisualStyle[] | null;
    affixLabel?: string | null;
  }
) {
  const fingerprint = (() => {
    if (overrides?.affixSignature) {
      return buildAffixFingerprintFromSignature(overrides.affixSignature);
    }
    if (overrides?.affixStyles && overrides.affixStyles.length > 0) {
      return buildAffixFingerprintFromStyles(overrides.affixStyles);
    }
    if (overrides?.affixVisualStyle) {
      return buildAffixFingerprintFromStyles([overrides.affixVisualStyle]);
    }
    return resolveCardAffix(card);
  })();
  const label = String(overrides?.affixLabel || '').trim()
    || fingerprint.affixLabel
    || inferAffixLabel({ tags: card.tags ?? [] }, fingerprint.affixVisualStyle);
  let affixYieldBoostPercent = 0;
  let affixOfflineBufferBonus = 0;
  let affixDismantleBonusPercent = 0;
  for (const style of fingerprint.affixStyles) {
    affixYieldBoostPercent += getPlacementAffixYieldBoostPercent(card, style);
    affixOfflineBufferBonus += getPlacementAffixOfflineBufferBonus(card, style);
    affixDismantleBonusPercent += getAffixDismantleBonusPercent(card, style);
  }
  const affix = {
    ...fingerprint,
    affixLabel: label
  };
  return {
    ...affix,
    affixYieldBoostPercent: placementRound(affixYieldBoostPercent),
    affixOfflineBufferBonus: Math.max(0, Math.floor(affixOfflineBufferBonus)),
    affixDismantleBonusPercent: placementRound(affixDismantleBonusPercent)
  };
}

function resolvePlacementSlotAffixMap(slots: PlacementSlotWithCard[]) {
  const map = new Map<number, PlacementSlotAffix>();
  for (const slot of slots) {
    if (!slot.card) continue;
    const affix = resolveCardAffixWithBonus(slot.card, {
      affixSignature: slot.affixSignature as string | null | undefined,
      affixVisualStyle: slot.affixVisualStyle as AffixVisualStyle | null | undefined,
      affixLabel: slot.affixLabel
    });
    map.set(slot.slotIndex, {
      affixVisualStyle: affix.affixVisualStyle,
      affixSignature: affix.affixSignature,
      affixStyles: affix.affixStyles,
      affixStyleCounts: affix.affixStyleCounts,
      affixLabel: affix.affixLabel,
      yieldBoostPercent: affix.affixYieldBoostPercent,
      offlineBufferBonus: affix.affixOfflineBufferBonus,
      dismantleBonusPercent: affix.affixDismantleBonusPercent
    });
  }
  return map;
}

function resolvePlacementActiveColorlessAddons(addons: PlacementAddonWithCard[]) {
  return addons
    .map((addon) => {
      if (addon.kind !== PLACEMENT_COLORLESS_ADDON_KIND || !addon.card) return null;
      const affix = resolveCardAffixWithBonus(addon.card, {
        affixSignature: addon.affixSignature,
        affixVisualStyle: addon.affixVisualStyle,
        affixLabel: addon.affixLabel
      });
      if (!affix.affixStyles.includes('COLORLESS')) return null;
      return {
        addon,
        card: addon.card,
        affix
      };
    })
    .filter((item): item is {
      addon: PlacementAddonWithCard;
      card: NonNullable<PlacementAddonWithCard['card']>;
      affix: ReturnType<typeof resolveCardAffixWithBonus>;
    } => Boolean(item));
}

type PlacementTagLookup = {
  normalized: Set<string>;
  compact: Set<string>;
};

const PLACEMENT_TYPE_TAG_ALIASES = {
  ORIGINAL: ['原创', 'original', 'origin'],
  HIDDEN: ['掩藏页', '隐藏页', 'hidden'],
  SCP: ['scp', 'scpi', 'scp-cn', 'scpcn'],
  GOI: ['goi', 'goi格式', 'goiformat'],
  WANDERERS: ['wanderers', '图书馆', '流浪者图书馆'],
  ART: ['艺术作品', '艺术', 'art', 'artwork'],
  TALE: ['故事', 'tale', 'tales']
} as const;

const PLACEMENT_AUTHOR_TAG_PREFIX = /^(?:作者|author|authors|by|译者|translator|translators?)[\s:_\-\/\\]+(.+)$/i;
const PLACEMENT_AUTHOR_TAG_PREFIX_COMPACT = /^(?:作者|author|authors|by|译者|translator|translators?)(.+)$/i;
const PLACEMENT_AUTHOR_GENERIC_KEYS = new Set([
  'unknown',
  'unknownauthor',
  'anonymous',
  'anon',
  '匿名',
  '佚名',
  '多人',
  '多位作者',
  'collective'
]);

function normalizePlacementTagToken(raw: unknown) {
  return String(raw ?? '').trim().toLowerCase().replace(/[\s_]+/g, '-');
}

function compactPlacementTagToken(raw: string) {
  return String(raw || '').toLowerCase().replace(/[\s_:\-\/\\]+/g, '');
}

function buildPlacementTagLookup(tags: string[] | null | undefined): PlacementTagLookup {
  const normalized = new Set<string>();
  const compact = new Set<string>();
  for (const rawTag of tags ?? []) {
    const token = normalizePlacementTagToken(rawTag);
    if (!token) continue;
    normalized.add(token);
    compact.add(compactPlacementTagToken(token));
  }
  return { normalized, compact };
}

function hasPlacementTagAlias(lookup: PlacementTagLookup, aliases: readonly string[]) {
  for (const alias of aliases) {
    const normalized = normalizePlacementTagToken(alias);
    if (!normalized) continue;
    if (lookup.normalized.has(normalized)) return true;
    if (lookup.compact.has(compactPlacementTagToken(normalized))) return true;
  }
  return false;
}

function resolvePlacementCardContentType(card: { tags?: string[] | null }): PlacementContentType {
  const lookup = buildPlacementTagLookup(card.tags ?? []);
  const hasOriginal = hasPlacementTagAlias(lookup, PLACEMENT_TYPE_TAG_ALIASES.ORIGINAL);
  const hasHidden = hasPlacementTagAlias(lookup, PLACEMENT_TYPE_TAG_ALIASES.HIDDEN);
  if (!hasOriginal && !hasHidden) return 'TRANSLATION';
  if (hasPlacementTagAlias(lookup, PLACEMENT_TYPE_TAG_ALIASES.SCP)) return 'SCP';
  if (hasPlacementTagAlias(lookup, PLACEMENT_TYPE_TAG_ALIASES.GOI)) return 'GOI';
  if (hasPlacementTagAlias(lookup, PLACEMENT_TYPE_TAG_ALIASES.TALE)) return 'TALE';
  if (hasPlacementTagAlias(lookup, PLACEMENT_TYPE_TAG_ALIASES.WANDERERS)) return 'WANDERERS';
  if (hasPlacementTagAlias(lookup, PLACEMENT_TYPE_TAG_ALIASES.ART)) return 'ART';
  return 'OTHERS';
}

function normalizePlacementAuthorKey(raw: string) {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/^[#@]+/, '')
    .replace(/[\s_:\-\/\\\.]+/g, '');
}

function normalizePlacementAuthorLabel(raw: string) {
  return String(raw || '')
    .trim()
    .replace(/^[#@]+/, '')
    .replace(/[_]+/g, ' ');
}

function resolvePlacementCardAuthorKeys(card: { tags?: string[] | null; authorKeys?: string[] | null }): PlacementAuthorKey[] {
  // Prefer structured authorKeys from Attribution data when available
  const structuredKeys = card.authorKeys ?? [];
  if (structuredKeys.length > 0) {
    const map = new Map<string, string>();
    for (const raw of structuredKeys) {
      const key = normalizePlacementAuthorKey(raw);
      if (!key) continue;
      if (PLACEMENT_AUTHOR_GENERIC_KEYS.has(key)) continue;
      if (!map.has(key)) map.set(key, normalizePlacementAuthorLabel(raw) || key);
    }
    return Array.from(map.entries()).map(([key, label]) => ({ key, label }));
  }
  // Fallback: parse author tags from card.tags
  const map = new Map<string, string>();
  for (const rawTag of card.tags ?? []) {
    const source = String(rawTag ?? '').trim();
    if (!source) continue;
    let payload = source.match(PLACEMENT_AUTHOR_TAG_PREFIX)?.[1] ?? '';
    if (!payload) {
      const compact = compactPlacementTagToken(source);
      payload = compact.match(PLACEMENT_AUTHOR_TAG_PREFIX_COMPACT)?.[1] ?? '';
    }
    if (!payload) continue;
    const labels = String(payload)
      .split(/[,&+、|/，;；]/g)
      .map((item) => item.trim())
      .filter(Boolean);
    for (const labelRaw of labels) {
      const label = normalizePlacementAuthorLabel(labelRaw);
      const key = normalizePlacementAuthorKey(label);
      if (!key) continue;
      if (PLACEMENT_AUTHOR_GENERIC_KEYS.has(key)) continue;
      if (!map.has(key)) map.set(key, label || key);
    }
  }
  return Array.from(map.entries()).map(([key, label]) => ({ key, label }));
}

function resolveCardAuthorsFromTags(tags: string[] | null | undefined, authorKeys?: string[] | null) {
  const resolved = resolvePlacementCardAuthorKeys({ tags: tags ?? [], authorKeys });
  if (!resolved.length) return null;
  return resolved.map((entry) => ({
    name: entry.label || entry.key,
    wikidotId: null as number | null
  }));
}

function resolvePlacementComboTags(tags: string[] | null | undefined): string[] {
  if (!tags || !Array.isArray(tags)) return [];
  return tags
    .map((t) => String(t || '').trim().toLowerCase())
    .filter((t) => {
      if (!t) return false;
      if (t.startsWith('_')) return false;
      if (PLACEMENT_COMBO_TAG_EXCLUDE_SET.has(t)) return false;
      if (/^(作者|author):/.test(t)) return false;
      return true;
    });
}

function resolvePlacementComboParticipants(
  slots: PlacementSlotWithCard[],
  slotAffixMap: Map<number, PlacementSlotAffix>,
  activeColorlessAddons: ReturnType<typeof resolvePlacementActiveColorlessAddons>
) {
  const participants: PlacementComboParticipant[] = [];
  for (const slot of slots) {
    if (!slot.card) continue;
    const counts = slotAffixMap.get(slot.slotIndex)?.affixStyleCounts ?? emptyAffixStyleCountMap();
    const hasNexus = Math.max(0, Math.floor(counts.NEXUS ?? 0)) > 0;
    participants.push({
      card: slot.card,
      affixStyleCounts: counts,
      contentType: resolvePlacementCardContentType(slot.card),
      authorKeys: resolvePlacementCardAuthorKeys(slot.card),
      comboTags: resolvePlacementComboTags(slot.card.tags),
      isColorlessAddon: false,
      excludeFromCombo: hasNexus
    });
  }
  for (const addon of activeColorlessAddons) {
    participants.push({
      card: addon.card,
      affixStyleCounts: addon.affix.affixStyleCounts,
      contentType: resolvePlacementCardContentType(addon.card),
      authorKeys: resolvePlacementCardAuthorKeys(addon.card),
      comboTags: resolvePlacementComboTags(addon.card.tags),
      isColorlessAddon: true,
      excludeFromCombo: false
    });
  }
  return participants;
}

function countPlacementAssignedCard(
  slots: PlacementSlotWithCard[],
  addons: PlacementAddonWithCard[],
  cardId: string,
  options?: {
    affixVisualStyle?: AffixVisualStyle;
    affixSignature?: string;
    excludeSlotIndex?: number;
    excludeAddonKind?: PlacementAddonKind;
  }
) {
  const styleFilter = options?.affixVisualStyle
    ? normalizeAffixVisualStyleInput(options.affixVisualStyle)
    : null;
  const signatureFilter = options?.affixSignature
    ? affixSignatureFromStyles(parseAffixSignature(options.affixSignature))
    : null;
  const fromSlots = slots.filter((slot) => {
    if (slot.cardId !== cardId) return false;
    const slotFingerprint = buildAffixFingerprintFromSignature(
      slot.affixSignature || slot.affixVisualStyle || 'NONE'
    );
    if (signatureFilter && slotFingerprint.affixSignature !== signatureFilter) return false;
    if (styleFilter && !slotFingerprint.affixStyles.includes(styleFilter)) return false;
    if (options?.excludeSlotIndex != null && slot.slotIndex === options.excludeSlotIndex) return false;
    return true;
  }).length;
  const fromAddons = addons.filter((addon) => {
    if (addon.cardId !== cardId) return false;
    const addonFingerprint = buildAffixFingerprintFromSignature(
      addon.affixSignature || addon.affixVisualStyle || 'NONE'
    );
    if (signatureFilter && addonFingerprint.affixSignature !== signatureFilter) return false;
    if (styleFilter && !addonFingerprint.affixStyles.includes(styleFilter)) return false;
    if (options?.excludeAddonKind && addon.kind === options.excludeAddonKind) return false;
    return true;
  }).length;
  return fromSlots + fromAddons;
}

function dominantPlacementGroup<T extends string | number>(values: T[]) {
  if (!values.length) return null;
  const counts = new Map<T, number>();
  let topValue: T | null = null;
  let topCount = 0;
  for (const value of values) {
    const nextCount = (counts.get(value) ?? 0) + 1;
    counts.set(value, nextCount);
    if (nextCount > topCount) {
      topCount = nextCount;
      topValue = value;
    }
  }
  if (!topValue || topCount <= 0) return null;
  return { value: topValue, count: topCount };
}

function allPlacementGroups<T extends string | number>(
  values: T[],
  minCount: number = 1
): Array<{ value: T; count: number }> {
  const counts = new Map<T, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .filter(([, count]) => count >= minCount)
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count);
}

/**
 * Distribute a pool of wildcard-like bonuses across qualifying groups.
 * Rules:
 * - Only groups with raw count >= minRawCount qualify (wildcards cannot help reach threshold)
 * - Each wildcard is consumed once assigned; no sharing across groups
 * - Groups are processed in descending count order (largest first)
 */
function distributeWildcardsToGroups<T>(
  groups: Array<{ value: T; count: number }>,
  pool: number,
  minRawCount: number = 3,
  maxTier: number = 6
): Array<{ value: T; count: number; tierCount: number }> {
  let remaining = pool;
  return groups
    .filter((g) => g.count >= minRawCount)
    .map((group) => {
      const room = Math.max(0, maxTier - group.count);
      const used = Math.min(remaining, room);
      remaining -= used;
      return { ...group, tierCount: Math.min(maxTier, group.count + used) };
    });
}

function resolvePlacementComboBonuses(participants: PlacementComboParticipant[]) {
  const bonuses: PlacementComboBonus[] = [];
  if (participants.length < 3) return bonuses;

  const colorlessNexusLayers = participants.reduce((sum, participant) => {
    if (!participant.isColorlessAddon) return sum;
    const counts = participant.affixStyleCounts ?? emptyAffixStyleCountMap();
    return sum + Math.max(0, Math.floor(counts.NEXUS ?? 0));
  }, 0);

  // NEXUS: filter out excludeFromCombo participants for combo evaluation
  const activeParticipants = participants.filter((p) => !p.excludeFromCombo);
  if (activeParticipants.length < 3) {
    // Check colorless NEXUS convert even if not enough active participants
    if (colorlessNexusLayers > 0) {
      bonuses.push({
        key: 'NEXUS_CONVERT',
        label: colorlessNexusLayers > 1
          ? `枢纽转化 ×0 · 层数 x${colorlessNexusLayers}`
          : '枢纽转化 ×0',
        yieldBoostPercent: 0
      });
    }
    return bonuses;
  }

  const wildcardCount = activeParticipants.reduce((sum, participant) => {
    const counts = participant.affixStyleCounts ?? emptyAffixStyleCountMap();
    return sum + Math.max(0, Math.floor(counts.WILDCARD ?? 0));
  }, 0);
  const spectrumCount = activeParticipants.reduce((sum, participant) => {
    const counts = participant.affixStyleCounts ?? emptyAffixStyleCountMap();
    return sum + (Math.max(0, Math.floor(counts.SPECTRUM ?? 0)) > 0 ? 1 : 0);
  }, 0);
  const mirrorCount = activeParticipants.reduce((sum, participant) => {
    const counts = participant.affixStyleCounts ?? emptyAffixStyleCountMap();
    return sum + (Math.max(0, Math.floor(counts.MIRROR ?? 0)) > 0 ? 1 : 0);
  }, 0);
  const orbitCount = activeParticipants.reduce((sum, participant) => {
    const counts = participant.affixStyleCounts ?? emptyAffixStyleCountMap();
    return sum + (Math.max(0, Math.floor(counts.ORBIT ?? 0)) > 0 ? 1 : 0);
  }, 0);

  const participantAffixCountsForCombo = activeParticipants.map((participant) => {
    const baseCounts = participant.affixStyleCounts ?? emptyAffixStyleCountMap();
    const counts = { ...baseCounts };
    counts.WILDCARD = Math.max(0, Math.floor(baseCounts.WILDCARD ?? 0));
    counts.SPECTRUM = Math.max(0, Math.floor(baseCounts.SPECTRUM ?? 0)) > 0 ? 1 : 0;
    counts.MIRROR = Math.max(0, Math.floor(baseCounts.MIRROR ?? 0)) > 0 ? 1 : 0;
    counts.ORBIT = Math.max(0, Math.floor(baseCounts.ORBIT ?? 0)) > 0 ? 1 : 0;
    const echoActive = Math.max(0, Math.floor(baseCounts.ECHO ?? 0)) > 0;
    counts.ECHO = echoActive ? 1 : 0;
    if (echoActive) {
      const candidates = AFFIX_STACK_STYLE_ORDER
        .filter((style) => style !== 'NONE' && style !== 'ECHO')
        .map((style) => ({ style, count: Math.max(0, Math.floor(baseCounts[style] ?? 0)) }))
        .filter((entry) => entry.count > 0)
        .sort((a, b) => {
          if (a.count !== b.count) return b.count - a.count;
          return AFFIX_PRIMARY_STYLE_PRIORITY.indexOf(a.style) - AFFIX_PRIMARY_STYLE_PRIORITY.indexOf(b.style);
        });
      const target = candidates[0]?.style;
      if (target) {
        counts[target] = Math.max(0, Math.floor(counts[target] ?? 0)) + 1;
      }
    }
    return counts;
  });

  // --- 1. Same rarity: raw count >= 3 to qualify, wildcards+spectrum distributed ---
  for (const g of distributeWildcardsToGroups(
    allPlacementGroups(activeParticipants.map((p) => p.card.rarity)),
    wildcardCount + spectrumCount
  )) {
    const bonusPercent = PLACEMENT_COMBO_SAME_RARITY_YIELD_BY_COUNT[g.tierCount] ?? 0;
    if (bonusPercent > 0) {
      bonuses.push({
        key: `SAME_RARITY_${g.value}_${g.tierCount}`,
        label: `同稀有度 x${g.tierCount}（${rarityDisplayName[g.value]}）`,
        yieldBoostPercent: bonusPercent
      });
    }
  }

  // --- 2. Same content type: raw count >= 3, wildcards distributed ---
  for (const g of distributeWildcardsToGroups(
    allPlacementGroups(activeParticipants.map((p) => p.contentType)),
    wildcardCount
  )) {
    const bonusPercent = PLACEMENT_COMBO_SAME_TYPE_YIELD_BY_COUNT[g.tierCount] ?? 0;
    if (bonusPercent > 0) {
      bonuses.push({
        key: `SAME_TYPE_${g.value}_${g.tierCount}`,
        label: `同类型 x${g.tierCount}（${PLACEMENT_CONTENT_TYPE_LABEL[g.value]}）`,
        yieldBoostPercent: bonusPercent
      });
    }
  }

  // --- 3. Same page: raw count >= 3, wildcards+orbit distributed ---
  const validPageIds = activeParticipants
    .map((p) => p.card.pageId)
    .filter((pageId): pageId is number => Number.isInteger(pageId) && Number(pageId) > 0);
  for (const g of distributeWildcardsToGroups(
    allPlacementGroups(validPageIds),
    wildcardCount + orbitCount
  )) {
    const bonusPercent = PLACEMENT_COMBO_SAME_PAGE_YIELD_BY_COUNT[g.tierCount] ?? 0;
    if (bonusPercent > 0) {
      bonuses.push({
        key: `SAME_PAGE_${g.value}_${g.tierCount}`,
        label: `同页面 x${g.tierCount}（#${g.value}）`,
        yieldBoostPercent: bonusPercent
      });
    }
  }

  // --- 4. Same card: raw count >= 3, wildcards+mirror distributed ---
  for (const g of distributeWildcardsToGroups(
    allPlacementGroups(activeParticipants.map((p) => p.card.id)),
    wildcardCount + mirrorCount
  )) {
    const bonusPercent = PLACEMENT_COMBO_SAME_CARD_YIELD_BY_COUNT[g.tierCount] ?? 0;
    if (bonusPercent > 0) {
      bonuses.push({
        key: `SAME_CARD_${g.value}_${g.tierCount}`,
        label: `同卡片 x${g.tierCount}`,
        yieldBoostPercent: bonusPercent
      });
    }
  }

  const goldRarityCount = activeParticipants.filter((participant) => participant.card.rarity === 'GOLD').length;
  if (Math.min(6, goldRarityCount + wildcardCount + spectrumCount) >= 6) {
    bonuses.push({
      key: 'ALL_GOLD_6',
      label: '全 GOLD 阵容 x6',
      yieldBoostPercent: PLACEMENT_COMBO_ALL_GOLD_RARITY_YIELD_BONUS
    });
  }

  // --- 5. Same author: raw count >= 3, wildcards distributed ---
  const authorCounts = new Map<string, number>();
  const authorLabels = new Map<string, string>();
  for (const participant of activeParticipants) {
    const uniqueAuthorKeys = new Set<string>();
    for (const entry of participant.authorKeys) {
      if (!entry?.key) continue;
      if (uniqueAuthorKeys.has(entry.key)) continue;
      uniqueAuthorKeys.add(entry.key);
      authorCounts.set(entry.key, (authorCounts.get(entry.key) ?? 0) + 1);
      if (!authorLabels.has(entry.key) && entry.label) {
        authorLabels.set(entry.key, entry.label);
      }
    }
  }
  const authorRawGroups = Array.from(authorCounts.entries())
    .map(([key, count]) => ({ value: key, count }))
    .sort((a, b) => b.count - a.count);
  const authorGroupsWithBonus = distributeWildcardsToGroups(authorRawGroups, wildcardCount)
    .map((group) => {
      const tierCount = Math.min(6, group.tierCount);
      const rawBonus = PLACEMENT_COMBO_SAME_AUTHOR_YIELD_BY_COUNT[tierCount] ?? 0;
      return { ...group, tierCount, rawBonus };
    })
    .filter((group) => group.rawBonus > 0)
    .sort((a, b) => {
      if (b.rawBonus !== a.rawBonus) return b.rawBonus - a.rawBonus;
      if (b.tierCount !== a.tierCount) return b.tierCount - a.tierCount;
      return a.value.localeCompare(b.value);
    });
  let appliedSameAuthorBonus = 0;
  for (let index = 0; index < authorGroupsWithBonus.length; index += 1) {
    const group = authorGroupsWithBonus[index];
    const decayMultiplier = Math.pow(PLACEMENT_COMBO_SAME_AUTHOR_DECAY, index);
    const decayedBonus = group.rawBonus * decayMultiplier;
    if (decayedBonus <= 0) continue;
    const remainingBonus = Math.max(0, PLACEMENT_COMBO_SAME_AUTHOR_MAX_BONUS - appliedSameAuthorBonus);
    if (remainingBonus <= 0) break;
    const appliedBonus = Math.min(decayedBonus, remainingBonus);
    if (appliedBonus > 0) {
      appliedSameAuthorBonus += appliedBonus;
      const label = authorLabels.get(group.value) ?? group.value;
      bonuses.push({
        key: `SAME_AUTHOR_${group.tierCount}_${group.value}`,
        label: `同作者 x${group.tierCount}（${label}）`,
        yieldBoostPercent: appliedBonus
      });
    }
  }

  // --- 6. Same affix style: raw count >= 3, wildcards distributed ---
  const affixCounts = emptyAffixStyleCountMap();
  for (const counts of participantAffixCountsForCombo) {
    for (const style of AFFIX_STACK_STYLE_ORDER) {
      affixCounts[style] += Math.max(0, Math.floor(counts[style] ?? 0));
    }
  }
  const affixGroups: Array<{ value: AffixVisualStyle; count: number }> = [];
  for (const style of AFFIX_STACK_STYLE_ORDER) {
    if (style === 'NONE' || style === 'WILDCARD' || style === 'SPECTRUM' || style === 'MIRROR' || style === 'ORBIT' || style === 'ECHO') continue;
    const styleCount = Math.max(0, Math.floor(affixCounts[style] ?? 0));
    if (styleCount >= 1) {
      affixGroups.push({ value: style, count: styleCount });
    }
  }
  affixGroups.sort((a, b) => b.count - a.count);
  for (const g of distributeWildcardsToGroups(affixGroups, wildcardCount)) {
    const bonusPercent = PLACEMENT_COMBO_SAME_AFFIX_YIELD_BY_COUNT[g.tierCount] ?? 0;
    if (bonusPercent > 0) {
      bonuses.push({
        key: `SAME_AFFIX_${g.value}_${g.tierCount}`,
        label: `同词条 x${g.tierCount}（${AFFIX_STYLE_LABEL[g.value]}）`,
        yieldBoostPercent: bonusPercent
      });
    }
  }
  const goldAffixCount = Math.max(0, Math.floor(affixCounts.GOLD ?? 0));
  if (Math.min(6, goldAffixCount + wildcardCount) >= 6) {
    bonuses.push({
      key: 'ALL_AFFIX_GOLD_6',
      label: '全 GOLD 词条 x6',
      yieldBoostPercent: PLACEMENT_COMBO_ALL_AFFIX_GOLD_YIELD_BONUS
    });
  }

  // --- 7. Same tag: raw count >= 3, wildcards distributed, tier cap 10 ---
  const perCardTagContributionLimit = Math.max(1, Math.floor(PLACEMENT_COMBO_SAME_TAG_PER_CARD_LIMIT));
  const participantUniqueTags = activeParticipants.map((participant) => {
    const uniqueTags = new Set<string>();
    for (const tag of participant.comboTags) {
      if (!tag) continue;
      uniqueTags.add(tag);
    }
    return Array.from(uniqueTags.values());
  });
  const rawTagPopularity = new Map<string, number>();
  for (const tags of participantUniqueTags) {
    for (const tag of tags) {
      rawTagPopularity.set(tag, (rawTagPopularity.get(tag) ?? 0) + 1);
    }
  }
  const tagCounts = new Map<string, number>();
  for (const tags of participantUniqueTags) {
    // Count only the top-N shared tags per card to avoid high-tag cards dominating.
    const selectedTags = tags
      .sort((a, b) => {
        const countDiff = (rawTagPopularity.get(b) ?? 0) - (rawTagPopularity.get(a) ?? 0);
        if (countDiff !== 0) return countDiff;
        return a.localeCompare(b);
      })
      .slice(0, perCardTagContributionLimit);
    for (const tag of selectedTags) {
      tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
    }
  }
  const tagGroupsWithBonus = distributeWildcardsToGroups(
    Array.from(tagCounts.entries())
      .map(([tag, count]) => ({ value: tag, count }))
      .sort((a, b) => {
        if (b.count !== a.count) return b.count - a.count;
        return a.value.localeCompare(b.value);
      }),
    wildcardCount,
    3,
    10
  )
    .map((group) => {
      const tierCount = Math.min(10, group.tierCount);
      const rawBonus = PLACEMENT_COMBO_SAME_TAG_YIELD_BY_COUNT[tierCount] ?? 0;
      return { ...group, tierCount, rawBonus };
    })
    .filter((group) => group.rawBonus > 0)
    .sort((a, b) => {
      if (b.rawBonus !== a.rawBonus) return b.rawBonus - a.rawBonus;
      if (b.tierCount !== a.tierCount) return b.tierCount - a.tierCount;
      return a.value.localeCompare(b.value);
    });
  let appliedSameTagBonus = 0;
  for (let index = 0; index < tagGroupsWithBonus.length; index += 1) {
    const group = tagGroupsWithBonus[index];
    const decayMultiplier = Math.pow(PLACEMENT_COMBO_SAME_TAG_DECAY, index);
    const decayedBonus = group.rawBonus * decayMultiplier;
    if (decayedBonus <= 0) continue;
    const remainingBonus = Math.max(0, PLACEMENT_COMBO_SAME_TAG_MAX_BONUS - appliedSameTagBonus);
    if (remainingBonus <= 0) break;
    const appliedBonus = Math.min(decayedBonus, remainingBonus);
    if (appliedBonus > 0) {
      appliedSameTagBonus += appliedBonus;
      bonuses.push({
        key: `SAME_TAG_${group.value}_${group.tierCount}`,
        label: `同标签 x${group.tierCount}（${group.value}）`,
        yieldBoostPercent: appliedBonus
      });
    }
  }

  // --- NEXUS colorless convert: replace all combos with a single flat bonus ---
  if (colorlessNexusLayers > 0) {
    const comboCount = bonuses.length;
    const effectiveComboCount = Math.min(comboCount, PLACEMENT_NEXUS_CONVERT_MAX_COMBO_COUNT);
    bonuses.length = 0;
    bonuses.push({
      key: 'NEXUS_CONVERT',
      label: colorlessNexusLayers > 1
        ? `枢纽转化 ×${effectiveComboCount} · 层数 x${colorlessNexusLayers}`
        : `枢纽转化 ×${effectiveComboCount}`,
      yieldBoostPercent: effectiveComboCount * PLACEMENT_NEXUS_CONVERT_BONUS_PER_COMBO * colorlessNexusLayers
    });
  }

  return bonuses;
}

function sumPlacementAffixYieldBoostPercent(
  slotAffixMap: Map<number, PlacementSlotAffix>,
  activeColorlessAddons: ReturnType<typeof resolvePlacementActiveColorlessAddons>
) {
  let total = 0;
  for (const affix of slotAffixMap.values()) {
    total += affix.yieldBoostPercent;
  }
  for (const addon of activeColorlessAddons) {
    total += addon.affix.affixYieldBoostPercent;
  }
  return placementRound(Math.max(0, total));
}

function sumPlacementAffixOfflineBufferBonus(
  slotAffixMap: Map<number, PlacementSlotAffix>,
  activeColorlessAddons: ReturnType<typeof resolvePlacementActiveColorlessAddons>
) {
  let total = 0;
  for (const affix of slotAffixMap.values()) {
    total += Math.max(0, Math.floor(affix.offlineBufferBonus));
  }
  for (const addon of activeColorlessAddons) {
    total += Math.max(0, Math.floor(addon.affix.affixOfflineBufferBonus));
  }
  return total;
}

function resolvePlacementYieldBoost(
  userId: string,
  slots: PlacementSlotWithCard[],
  slotAffixMap: Map<number, PlacementSlotAffix>,
  activeColorlessAddons: ReturnType<typeof resolvePlacementActiveColorlessAddons>
) {
  const comboParticipants = resolvePlacementComboParticipants(slots, slotAffixMap, activeColorlessAddons);
  const baseYieldBoostPercent = getPlacementBaseYieldBoostPercent(userId);
  const affixYieldBoostPercent = sumPlacementAffixYieldBoostPercent(slotAffixMap, activeColorlessAddons);
  const comboBonuses = resolvePlacementComboBonuses(comboParticipants);
  const comboYieldBoostPercent = placementRound(
    comboBonuses.reduce((sum, bonus) => sum + bonus.yieldBoostPercent, 0)
  );
  const yieldBoostPercentRaw = placementRound(baseYieldBoostPercent + affixYieldBoostPercent + comboYieldBoostPercent);
  const yieldBoostPercent = placementRound(Math.max(0, yieldBoostPercentRaw));
  return {
    baseYieldBoostPercent,
    affixYieldBoostPercent,
    comboYieldBoostPercent,
    yieldBoostPercentRaw,
    yieldBoostPercent,
    yieldBoostCapped: false,
    comboBonuses
  };
}

function resolvePlacementOfflineBufferBonus(
  userId: string,
  slotAffixMap: Map<number, PlacementSlotAffix>,
  activeColorlessAddons: ReturnType<typeof resolvePlacementActiveColorlessAddons>
) {
  const baseOfflineBufferBonus = getPlacementBaseOfflineBufferBonus(userId);
  const affixOfflineBufferBonus = sumPlacementAffixOfflineBufferBonus(slotAffixMap, activeColorlessAddons);
  const offlineBufferBonusRaw = Math.max(0, Math.floor(baseOfflineBufferBonus + affixOfflineBufferBonus));
  const offlineBufferBonus = offlineBufferBonusRaw;
  return {
    baseOfflineBufferBonus,
    affixOfflineBufferBonus,
    offlineBufferBonusRaw,
    offlineBufferBonus,
    offlineBufferCapped: false
  };
}

function getPlacementBufferCap(offlineBufferBonus: number) {
  const bonus = Math.max(0, Math.floor(offlineBufferBonus));
  const cap = PLACEMENT_BUFFER_CAP_BASE + bonus;
  return Math.max(0, cap);
}

function getPlacementSlotYieldPerHour(card: { rarity: GachaRarity } | null | undefined, yieldBoostPercent: number) {
  if (!card) return 0;
  const base = BASE_PLACEMENT_YIELD_BY_RARITY[card.rarity] ?? 0;
  return placementRound(base * (1 + Math.max(0, yieldBoostPercent)));
}

function getPlacementAddonYieldPerHour(card: { rarity: GachaRarity } | null | undefined, yieldBoostPercent: number) {
  const slotYield = getPlacementSlotYieldPerHour(card, yieldBoostPercent);
  return placementRound(slotYield * PLACEMENT_COLORLESS_ADDON_RATIO);
}

const EMPTY_WALLET_PITY_COUNTERS: WalletPityCounters = {
  purplePityCount: 0,
  goldPityCount: 0
};
const WALLET_PITY_COLUMN_CHECK_CACHE_MS = 30_000;
let walletPityColumnSupportCache: { available: boolean; checkedAt: number } | null = null;

function serializeWallet(wallet: Prisma.GachaWalletGetPayload<{}>, pityCounters?: WalletPityCounters | null) {
  const pity = normalizeWalletPityCounters(pityCounters);
  return {
    balance: wallet.balance,
    totalEarned: wallet.totalEarned,
    totalSpent: wallet.totalSpent,
    purplePityCount: pity.purplePityCount,
    goldPityCount: pity.goldPityCount,
    lastDailyClaimAt: wallet.lastDailyClaimAt?.toISOString() ?? null
  };
}

function createRuntimeId(prefix: string) {
  try {
    return `${prefix}_${randomUUID()}`;
  } catch {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  }
}

function asJsonObject(value: Prisma.JsonValue | null | undefined): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function toSafeInt(value: unknown, fallback = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.trunc(numeric);
}

function normalizeWalletPityCounters(
  input?: { purplePityCount?: unknown; goldPityCount?: unknown } | null
): WalletPityCounters {
  if (!input) return { ...EMPTY_WALLET_PITY_COUNTERS };
  return {
    purplePityCount: Math.max(0, toSafeInt(input.purplePityCount, 0)),
    goldPityCount: Math.max(0, toSafeInt(input.goldPityCount, 0))
  };
}

async function hasWalletPityColumns(tx: Tx | typeof prisma): Promise<boolean> {
  const nowMs = Date.now();
  if (
    walletPityColumnSupportCache
    && (nowMs - walletPityColumnSupportCache.checkedAt) < WALLET_PITY_COLUMN_CHECK_CACHE_MS
  ) {
    return walletPityColumnSupportCache.available;
  }

  const rows = await tx.$queryRaw<Array<{ column_count: number | string | null }>>`
    SELECT COUNT(*)::int AS column_count
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'GachaWallet'
      AND column_name IN ('purplePityCount', 'goldPityCount')
  `;
  const available = toSafeInt(rows[0]?.column_count, 0) >= 2;
  walletPityColumnSupportCache = {
    available,
    checkedAt: nowMs
  };
  return available;
}

async function loadWalletPityCounters(tx: Tx, walletId: string): Promise<WalletPityCounters> {
  if (!(await hasWalletPityColumns(tx))) {
    return { ...EMPTY_WALLET_PITY_COUNTERS };
  }
  const rows = await tx.$queryRaw<Array<{ purplePityCount: number | string | null; goldPityCount: number | string | null }>>`
    SELECT "purplePityCount", "goldPityCount"
    FROM "GachaWallet"
    WHERE id = ${walletId}
    LIMIT 1
  `;
  return normalizeWalletPityCounters(rows[0]);
}

async function saveWalletPityCounters(tx: Tx, walletId: string, counters: WalletPityCounters) {
  if (!(await hasWalletPityColumns(tx))) {
    return;
  }
  const normalized = normalizeWalletPityCounters(counters);
  await tx.$executeRaw`
    UPDATE "GachaWallet"
    SET "purplePityCount" = ${normalized.purplePityCount},
        "goldPityCount" = ${normalized.goldPityCount}
    WHERE id = ${walletId}
  `;
}

async function serializeWalletWithPity(
  tx: Tx,
  wallet: Prisma.GachaWalletGetPayload<{}>,
  pityCounters?: WalletPityCounters | null
) {
  const pity = pityCounters ?? await loadWalletPityCounters(tx, wallet.id);
  return serializeWallet(wallet, pity);
}

function toSafeNumber(value: unknown, fallback = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return numeric;
}

function normalizeTicketBalance(input?: Partial<TicketBalance> | null): TicketBalance {
  const source = input ?? {};
  return {
    drawTicket: Math.max(0, toSafeInt(source.drawTicket, 0)),
    draw10Ticket: Math.max(0, toSafeInt(source.draw10Ticket, 0)),
    affixReforgeTicket: Math.max(0, toSafeInt(source.affixReforgeTicket, 0))
  };
}

function applyTicketDelta(target: TicketBalance, delta: TicketBalance, factor = 1) {
  target.drawTicket += delta.drawTicket * factor;
  target.draw10Ticket += delta.draw10Ticket * factor;
  target.affixReforgeTicket += delta.affixReforgeTicket * factor;
}

function parseTicketBalanceFromMetadata(metadata: Prisma.JsonValue | null | undefined) {
  const json = asJsonObject(metadata);
  return {
    drawTicket: Math.max(0, toSafeInt(json.drawTicket, 0)),
    draw10Ticket: Math.max(0, toSafeInt(json.draw10Ticket, 0)),
    affixReforgeTicket: Math.max(0, toSafeInt(json.affixReforgeTicket, 0))
  };
}

function isZeroTicketBalance(balance: TicketBalance) {
  return balance.drawTicket <= 0 && balance.draw10Ticket <= 0 && balance.affixReforgeTicket <= 0;
}

function cloneTicketBalance(balance: TicketBalance): TicketBalance {
  return {
    drawTicket: balance.drawTicket,
    draw10Ticket: balance.draw10Ticket,
    affixReforgeTicket: balance.affixReforgeTicket
  };
}

function resolveDrawPaymentMethod(requested: DrawPaymentMethod, drawCount: number, currentTickets: TicketBalance) {
  if (drawCount === 1) {
    if (requested === 'DRAW10_TICKET') {
      throw Object.assign(new Error('单抽不可使用十连券'), { status: 400 });
    }
    if (requested === 'AUTO') {
      return currentTickets.drawTicket > 0 ? 'DRAW_TICKET' : 'TOKEN';
    }
  } else if (drawCount === 10) {
    if (requested === 'DRAW_TICKET') {
      return currentTickets.drawTicket > 0 ? 'DRAW_TICKET' : 'TOKEN';
    }
    if (requested === 'AUTO') {
      if (currentTickets.draw10Ticket > 0) return 'DRAW10_TICKET';
      return currentTickets.drawTicket > 0 ? 'DRAW_TICKET' : 'TOKEN';
    }
  }
  return requested === 'AUTO' ? 'TOKEN' : requested;
}

function normalizeMarketCategoryKey(value: string | null | undefined) {
  return String(value ?? '').trim().toUpperCase();
}

function resolveMarketContract(contractId: string) {
  const rawKey = normalizeMarketCategoryKey(contractId);
  const key = MARKET_CONTRACT_ALIASES[rawKey] ?? rawKey;
  if (!key) return null;
  return MARKET_CONTRACTS.find((contract) =>
    contract.id === key
    || contract.category === key
    || contract.symbol === key
  ) ?? null;
}

function resolveMarketLockTier(lockTierInput?: string | null): MarketLockTier {
  const raw = String(lockTierInput || '').trim().toUpperCase();
  if (MARKET_LOCK_TIERS.includes(raw as MarketLockTier)) {
    return raw as MarketLockTier;
  }
  return 'T1';
}

function marketTierConfig(lockTierInput?: string | null) {
  const lockTier = resolveMarketLockTier(lockTierInput);
  return {
    lockTier,
    ...MARKET_LOCK_TIER_CONFIG[lockTier]
  };
}

function marketOpenFeeRate(lockTierInput: MarketLockTier, leverage: number) {
  const tier = MARKET_LOCK_TIER_CONFIG[lockTierInput];
  const baseRateMilli = Math.round(tier.openFeeBaseRate * 1000);
  const surchargeRateMilli = Math.round((MARKET_LEVERAGE_SURCHARGE_RATE[leverage] ?? 0) * 1000);
  return (baseRateMilli + surchargeRateMilli) / 1000;
}

function marketOpenFee(lockTierInput: MarketLockTier, leverage: number, margin: number) {
  const tier = MARKET_LOCK_TIER_CONFIG[lockTierInput];
  const baseRateMilli = Math.round(tier.openFeeBaseRate * 1000);
  const surchargeRateMilli = Math.round((MARKET_LEVERAGE_SURCHARGE_RATE[leverage] ?? 0) * 1000);
  const totalRateMilli = baseRateMilli + surchargeRateMilli;
  return {
    openFeeRate: totalRateMilli / 1000,
    openFee: Math.floor((Math.max(0, margin) * totalRateMilli) / 1000)
  };
}

function marketMarginByLots(lots: number) {
  return Math.max(0, Math.trunc(lots)) * MARKET_LOT_TOKEN;
}

function marketCalcEquity(
  margin: number,
  side: MarketPositionSide,
  leverage: number,
  entryIndex: number,
  currentIndex: number
) {
  if (margin <= 0 || entryIndex <= 0 || currentIndex <= 0) return 0;
  const direction = side === 'LONG' ? 1 : -1;
  const ratio = (currentIndex - entryIndex) / entryIndex;
  return margin * (1 + direction * leverage * ratio);
}

type MarketOracleContext = {
  asOfTs: Date;
  byCategory: Record<MarketCategory, OracleTick[]>;
};

function normalizeMarketTimeframe(value: string | null | undefined): MarketTickTimeframe {
  const normalized = String(value || '').trim().toUpperCase();
  if (normalized === '7D' || normalized === '30D') return normalized;
  return '24H';
}

function timeframeBucketMs(timeframe: MarketTickTimeframe) {
  if (timeframe === '7D') return 4 * 60 * 60 * 1000;
  if (timeframe === '30D') return 12 * 60 * 60 * 1000;
  return 60 * 60 * 1000;
}

function floorToUtc8BucketStart(input: Date, bucketMs: number) {
  const offsetMs = UTC8_OFFSET_MINUTES * 60 * 1000;
  const shiftedTs = input.getTime() + offsetMs;
  const bucketStartShifted = Math.floor(shiftedTs / bucketMs) * bucketMs;
  return bucketStartShifted - offsetMs;
}

function floorToUtc8DayStart(input: Date) {
  const shifted = new Date(input.getTime() + UTC8_OFFSET_MINUTES * 60 * 1000);
  shifted.setUTCHours(0, 0, 0, 0);
  return new Date(shifted.getTime() - UTC8_OFFSET_MINUTES * 60 * 1000);
}

function floorToUtc8WeekStart(input: Date) {
  const shifted = new Date(input.getTime() + UTC8_OFFSET_MINUTES * 60 * 1000);
  const weekday = shifted.getUTCDay();
  const mondayOffset = (weekday + 6) % 7;
  shifted.setUTCDate(shifted.getUTCDate() - mondayOffset);
  shifted.setUTCHours(0, 0, 0, 0);
  return new Date(shifted.getTime() - UTC8_OFFSET_MINUTES * 60 * 1000);
}

function floorToUtc8MonthStart(input: Date) {
  const shifted = new Date(input.getTime() + UTC8_OFFSET_MINUTES * 60 * 1000);
  shifted.setUTCDate(1);
  shifted.setUTCHours(0, 0, 0, 0);
  return new Date(shifted.getTime() - UTC8_OFFSET_MINUTES * 60 * 1000);
}

function floorToUtc8NDaysAgo(input: Date, days: number) {
  const dayStart = floorToUtc8DayStart(input);
  return new Date(dayStart.getTime() - days * 24 * 60 * 60 * 1000);
}

function timeframeRangeStart(asOfTs: Date, timeframe: MarketTickTimeframe) {
  if (timeframe === '7D') return floorToUtc8NDaysAgo(asOfTs, 7);
  if (timeframe === '30D') return floorToUtc8NDaysAgo(asOfTs, 30);
  return floorToUtc8DayStart(asOfTs);
}

function timeframeHours(asOfTs: Date, timeframe: MarketTickTimeframe) {
  const start = timeframeRangeStart(asOfTs, timeframe);
  const durationMs = Math.max(0, asOfTs.getTime() - start.getTime());
  return Math.max(1, Math.ceil(durationMs / (60 * 60 * 1000)));
}

function oracleLimitForTimeframe(asOfTs: Date, timeframe: MarketTickTimeframe) {
  const target = timeframeHours(asOfTs, timeframe) + ORACLE_TICK_TIMEFRAME_BUFFER_HOURS;
  return Math.min(ORACLE_TICK_LIMIT_POSITION, Math.max(48, target));
}

async function fetchOracleTicksFromBff(category: MarketCategory, limit: number, asOfTs: Date) {
  const endpoint = `${BFF_BASE_URL}/internal/gacha-market/ticks?category=${encodeURIComponent(category)}&limit=${encodeURIComponent(String(limit))}&asOfTs=${encodeURIComponent(asOfTs.toISOString())}`;
  let response: globalThis.Response;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BFF_INTERNAL_FETCH_TIMEOUT_MS);
  try {
    response = await fetch(endpoint, {
      method: 'GET',
      signal: controller.signal,
      headers: BFF_INTERNAL_KEY
        ? { 'x-internal-key': BFF_INTERNAL_KEY }
        : undefined
    });
  } catch {
    return [] as OracleTick[];
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    return [] as OracleTick[];
  }
  const payload = await response.json().catch(() => null) as {
    ok?: boolean;
    items?: Array<{
      category?: string;
      asOfTs?: string;
      watermarkTs?: string | null;
      voteCutoffDate?: string;
      voteRuleVersion?: string;
      indexMark?: number;
    }>;
  } | null;
  if (!payload?.ok || !Array.isArray(payload.items)) {
    return [] as OracleTick[];
  }
  return payload.items
    .map((item) => {
      const ts = item.asOfTs ? new Date(item.asOfTs) : null;
      if (!ts || Number.isNaN(ts.getTime())) return null;
      const watermarkTs = item.watermarkTs ? new Date(item.watermarkTs) : null;
      return {
        category,
        asOfTs: ts,
        watermarkTs: watermarkTs && !Number.isNaN(watermarkTs.getTime()) ? watermarkTs : null,
        voteCutoffDate: String(item.voteCutoffDate || ''),
        voteRuleVersion: String(item.voteRuleVersion || 'utc8-t+1-v1'),
        indexMark: Number(item.indexMark ?? 0)
      } as OracleTick;
    })
    .filter((item): item is OracleTick => {
      if (!item) return false;
      return Number.isFinite(item.indexMark) && item.indexMark > 0;
    });
}

async function loadOracleTicks(category: MarketCategory, limit: number, asOfTs: Date) {
  const asOfTsMs = asOfTs.getTime();
  const nowMs = Date.now();
  const canUseCache = Number.isFinite(asOfTsMs) && Math.abs(nowMs - asOfTsMs) <= ORACLE_NEAR_REALTIME_WINDOW_MS;
  const cache = oracleTickCache.get(category);
  if (
    canUseCache
    && cache
    && cache.limit >= limit
    && nowMs - cache.fetchedAt <= ORACLE_CACHE_TTL_MS
  ) {
    return cache.items.slice(-limit);
  }

  const inflight = oracleTickInflight.get(category);
  if (
    canUseCache
    && inflight
    && inflight.limit >= limit
    && Math.abs(inflight.asOfTsMs - asOfTsMs) <= ORACLE_NEAR_REALTIME_WINDOW_MS
  ) {
    const inflightItems = await inflight.promise;
    return inflightItems.slice(-limit);
  }

  const fetchPromise = fetchOracleTicksFromBff(category, limit, asOfTs)
    .then((items) => {
      if (canUseCache && items.length > 0) {
        oracleTickCache.set(category, {
          fetchedAt: Date.now(),
          limit,
          items
        });
      }
      return items;
    })
    .finally(() => {
      const current = oracleTickInflight.get(category);
      if (current?.promise === fetchPromise) {
        oracleTickInflight.delete(category);
      }
    });

  if (canUseCache) {
    oracleTickInflight.set(category, {
      limit,
      asOfTsMs,
      promise: fetchPromise
    });
  }

  const items = await fetchPromise;
  return items.slice(-limit);
}

function createEmptyOracleCategoryRecord(): Record<MarketCategory, OracleTick[]> {
  return {
    OVERALL: [],
    TRANSLATION: [],
    SCP: [],
    TALE: [],
    GOI: [],
    WANDERERS: []
  };
}

async function loadOracleContextForCategories(
  categories: readonly MarketCategory[],
  asOfTs = now(),
  limit = ORACLE_TICK_CACHE_LIMIT
): Promise<MarketOracleContext> {
  const result = createEmptyOracleCategoryRecord();
  const uniqueCategories = Array.from(new Set(categories));
  const rows = await Promise.all(uniqueCategories.map(async (category) => {
    const ticks = await loadOracleTicks(category, limit, asOfTs);
    return { category, ticks };
  }));
  for (const row of rows) {
    result[row.category] = row.ticks;
  }
  return {
    asOfTs,
    byCategory: result
  };
}

async function loadOracleContext(asOfTs = now(), limit = ORACLE_TICK_CACHE_LIMIT): Promise<MarketOracleContext> {
  return loadOracleContextForCategories(MARKET_CATEGORIES, asOfTs, limit);
}

function findLastTickAtOrBefore(ticks: OracleTick[], ts: Date) {
  if (!ticks.length) return null;
  let left = 0;
  let right = ticks.length - 1;
  let answer: OracleTick | null = null;
  const target = ts.getTime();
  while (left <= right) {
    const middle = Math.floor((left + right) / 2);
    const tick = ticks[middle]!;
    const value = tick.asOfTs.getTime();
    if (value <= target) {
      answer = tick;
      left = middle + 1;
    } else {
      right = middle - 1;
    }
  }
  return answer;
}

function marketTickAt(
  contract: MarketContractDefinition,
  date: Date,
  context: MarketOracleContext
) {
  return findLastTickAtOrBefore(context.byCategory[contract.category] ?? [], date);
}

function marketPriceAt(
  contract: MarketContractDefinition,
  date: Date,
  context: MarketOracleContext
): number | null {
  const tick = marketTickAt(contract, date, context);
  if (!tick) return null;
  return Number(tick.indexMark);
}

function sliceTicksByTimeframe(ticks: OracleTick[], asOfTs: Date, timeframe: MarketTickTimeframe) {
  const start = timeframeRangeStart(asOfTs, timeframe);
  return ticks.filter((tick) => tick.asOfTs.getTime() >= start.getTime() && tick.asOfTs.getTime() <= asOfTs.getTime());
}

function buildMarketTickSeries(
  contract: MarketContractDefinition,
  context: MarketOracleContext,
  timeframe: MarketTickTimeframe,
  limit: number
) {
  const all = context.byCategory[contract.category] ?? [];
  const rangeStart = timeframeRangeStart(context.asOfTs, timeframe);
  const scoped = sliceTicksByTimeframe(all, context.asOfTs, timeframe);
  const anchor = findLastTickAtOrBefore(all, new Date(rangeStart.getTime() - 1));
  const merged = anchor
    ? [anchor, ...scoped.filter((item) => item.asOfTs.getTime() !== anchor.asOfTs.getTime())]
    : scoped;
  if (!merged.length) return [];
  const itemCount = Math.min(Math.max(limit, 8), merged.length);
  const selected = merged.slice(-itemCount);
  return selected.map((tick) => ({
    ts: tick.asOfTs.toISOString(),
    asOfTs: tick.asOfTs.toISOString(),
    watermarkTs: tick.watermarkTs ? tick.watermarkTs.toISOString() : null,
    voteCutoffDate: tick.voteCutoffDate,
    voteRuleVersion: tick.voteRuleVersion,
    price: Number(tick.indexMark)
  }));
}

function buildMarketContractSnapshot(
  contract: MarketContractDefinition,
  context: MarketOracleContext,
  timeframe: MarketTickTimeframe = '24H'
) {
  const asOf = context.asOfTs;
  const latestPrice = marketPriceAt(contract, asOf, context) ?? INDEX_BASE;
  const dayStart = floorToUtc8DayStart(asOf);
  const dayOpen = marketPriceAt(contract, dayStart, context) ?? latestPrice;
  const weekOpen = marketPriceAt(contract, floorToUtc8NDaysAgo(asOf, 7), context) ?? latestPrice;
  const monthOpen = marketPriceAt(contract, floorToUtc8NDaysAgo(asOf, 30), context) ?? latestPrice;
  const rangeStart = timeframeRangeStart(asOf, timeframe);
  const openPrice = marketPriceAt(contract, rangeStart, context) ?? latestPrice;
  const recentTicks = sliceTicksByTimeframe(context.byCategory[contract.category] ?? [], asOf, timeframe);
  let rangeHigh = Math.max(latestPrice, openPrice);
  let rangeLow = Math.min(latestPrice, openPrice);
  for (const item of recentTicks) {
    const price = Number(item.indexMark);
    if (price > rangeHigh) rangeHigh = price;
    if (price < rangeLow) rangeLow = price;
  }
  const delta = Number((latestPrice - openPrice).toFixed(4));
  const deltaPercent = openPrice > 0
    ? Number((((latestPrice - openPrice) / openPrice) * 100).toFixed(2))
    : 0;
  return {
    id: contract.id,
    category: contract.category,
    symbol: contract.symbol,
    name: contract.name,
    timeframe,
    rangeStartTs: rangeStart.toISOString(),
    changeBasisTs: rangeStart.toISOString(),
    indexOpen: Number(openPrice.toFixed(4)),
    indexOpenDay: Number(dayOpen.toFixed(4)),
    indexOpenWeek: Number(weekOpen.toFixed(4)),
    indexOpenMonth: Number(monthOpen.toFixed(4)),
    indexNow: Number(latestPrice.toFixed(4)),
    indexClose: null,
    latestPrice: Number(latestPrice.toFixed(4)),
    change: delta,
    changePercent: deltaPercent,
    rangeHigh: Number(rangeHigh.toFixed(4)),
    rangeLow: Number(rangeLow.toFixed(4)),
    rangeVolume: 0,
    change24h: delta,
    change24hPercent: deltaPercent,
    high24h: Number(rangeHigh.toFixed(4)),
    low24h: Number(rangeLow.toFixed(4)),
    volume24h: 0
  };
}

function buildMarketCandles(
  ticks: Array<{ ts: string; price: number }>,
  timeframe: MarketTickTimeframe,
  asOfTs: Date
) {
  if (!ticks.length) return [];
  const bucketMs = timeframeBucketMs(timeframe);
  const endBucket = floorToUtc8BucketStart(asOfTs, bucketMs);
  const rangeStart = timeframeRangeStart(asOfTs, timeframe);
  const startBucket = floorToUtc8BucketStart(rangeStart, bucketMs);

  const normalizedTicks = ticks
    .map((tick) => {
      const ts = new Date(tick.ts).getTime();
      const price = Number(tick.price || 0);
      if (!Number.isFinite(ts) || !Number.isFinite(price) || price <= 0) return null;
      return { ts, price };
    })
    .filter((item): item is { ts: number; price: number } => Boolean(item))
    .sort((a, b) => a.ts - b.ts);

  if (!normalizedTicks.length) return [];
  const firstTickInWindow = normalizedTicks.find((item) => item.ts >= startBucket && item.ts <= asOfTs.getTime());
  if (!firstTickInWindow) return [];
  const visibleStartBucket = Math.max(
    startBucket,
    Math.min(floorToUtc8BucketStart(new Date(firstTickInWindow.ts), bucketMs), endBucket)
  );

  let index = 0;
  let lastPrice = normalizedTicks[0]!.price;
  // Seed the first visible bucket with the latest known price at or before visibleStartBucket.
  while (index < normalizedTicks.length && normalizedTicks[index]!.ts <= visibleStartBucket) {
    lastPrice = normalizedTicks[index]!.price;
    index += 1;
  }
  if (index === 0) {
    lastPrice = firstTickInWindow.price;
  }

  const candles: Array<{ ts: string; open: number; high: number; low: number; close: number }> = [];
  for (let bucket = visibleStartBucket; bucket <= endBucket; bucket += bucketMs) {
    const bucketEnd = bucket + bucketMs;
    const open = lastPrice;
    let high = open;
    let low = open;

    // Use step-function semantics:
    // - open: last price at bucket start
    // - close: last price at bucket end (inclusive)
    // - high/low: extrema touched within [bucketStart, bucketEnd]
    while (index < normalizedTicks.length && normalizedTicks[index]!.ts <= bucketEnd) {
      const price = normalizedTicks[index]!.price;
      lastPrice = price;
      if (price > high) high = price;
      if (price < low) low = price;
      index += 1;
    }
    const close = lastPrice;
    if (close > high) high = close;
    if (close < low) low = close;

    candles.push({
      ts: new Date(bucket).toISOString(),
      open,
      high,
      low,
      close
    });
  }

  return candles;
}

function tradeListingQueryLimit(rawLimit: string | undefined, fallback = 20) {
  const parsed = rawLimit ? Number(rawLimit) : fallback;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.floor(parsed), 1), 240);
}

function asNumber(value: unknown, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toDisplayName(value: string | null | undefined, userId: string) {
  const name = String(value || '').trim();
  return name || `用户-${userId.slice(0, 6)}`;
}

function positionNetMargin(entry: { longMargin: number; shortMargin: number }) {
  return entry.longMargin - entry.shortMargin;
}

function positionTotalMargin(entry: { longMargin: number; shortMargin: number }) {
  return entry.longMargin + entry.shortMargin;
}

function groupMarketParticipants(positions: GlobalActiveMarketPosition[]) {
  const grouped = new Map<string, {
    userId: string;
    longLots: number;
    shortLots: number;
    longMargin: number;
    shortMargin: number;
  }>();
  for (const position of positions) {
    const current = grouped.get(position.userId) ?? {
      userId: position.userId,
      longLots: 0,
      shortLots: 0,
      longMargin: 0,
      shortMargin: 0
    };
    if (position.side === 'LONG') {
      current.longLots += asNumber(position.lots, 0);
      current.longMargin += asNumber(position.margin, 0);
    } else {
      current.shortLots += asNumber(position.lots, 0);
      current.shortMargin += asNumber(position.margin, 0);
    }
    grouped.set(position.userId, current);
  }
  return grouped;
}

function sortMarketParticipants<T extends { longMargin: number; shortMargin: number }>(items: T[]) {
  return [...items].sort((a, b) => {
    const totalDelta = positionTotalMargin(b) - positionTotalMargin(a);
    if (totalDelta !== 0) return totalDelta;
    const netDelta = Math.abs(positionNetMargin(b)) - Math.abs(positionNetMargin(a));
    if (netDelta !== 0) return netDelta;
    return positionNetMargin(b) - positionNetMargin(a);
  });
}

type MarketOpenPosition = {
  positionId: string;
  contractId: string;
  side: MarketPositionSide;
  lockTier: MarketLockTier;
  lots: number;
  margin: number;
  stake: number;
  openFee: number;
  leverage: number;
  entryIndex: number;
  entryPrice: number;
  entryTickTs: string;
  expireAt: string;
  openedAt: string;
};

type MarketSettlementRecord = {
  positionId: string;
  contractId: string;
  side: MarketPositionSide;
  status: MarketPositionStatus;
  lockTier: MarketLockTier;
  lots: number;
  margin: number;
  stake: number;
  openFee: number;
  leverage: number;
  entryIndex: number;
  entryPrice: number;
  settleIndex: number;
  exitPrice: number;
  settleFee: number;
  payout: number;
  pnl: number;
  expireAt: string;
  liquidatedAt: string | null;
  settledAt: string;
};

function parseMarketOpenPosition(metadata: Prisma.JsonValue | null | undefined, createdAt: Date): MarketOpenPosition | null {
  const json = asJsonObject(metadata);
  const positionId = String(json.positionId ?? '').trim();
  const contractId = String(json.contractId ?? '').trim();
  const sideRaw = String(json.side ?? '').toUpperCase();
  const side: MarketPositionSide = sideRaw === 'SHORT' ? 'SHORT' : 'LONG';
  const lockTier = resolveMarketLockTier(String(json.lockTier ?? 'T1'));
  const tier = MARKET_LOCK_TIER_CONFIG[lockTier];
  const lots = Math.max(1, toSafeInt(json.lots, Math.floor(toSafeInt(json.stake, 0) / MARKET_LOT_TOKEN)));
  const margin = Math.max(0, toSafeInt(json.margin, marketMarginByLots(lots)));
  const openFee = Math.max(0, toSafeInt(json.openFee, 0));
  const leverage = Math.max(1, Math.min(100, toSafeInt(json.leverage, 1)));
  const entryIndex = Math.max(0, toSafeNumber(json.entryIndex, toSafeNumber(json.entryPrice, 0)));
  const entryTickRaw = String(json.entryTickTs ?? '').trim();
  const entryTickTs = (toDate(entryTickRaw) ?? createdAt).toISOString();
  const openedAtRaw = String(json.openedAt ?? '').trim();
  const openedAtDate = openedAtRaw ? toDate(openedAtRaw) : null;
  const fallbackExpireAt = new Date((openedAtDate ?? createdAt).getTime() + tier.durationMs).toISOString();
  const expireAtRaw = String(json.expireAt ?? '').trim();
  const expireAtDate = expireAtRaw ? toDate(expireAtRaw) : null;
  const expireAt = (expireAtDate ?? toDate(fallbackExpireAt) ?? new Date(createdAt.getTime() + tier.durationMs)).toISOString();
  if (!positionId || !contractId || margin <= 0 || entryIndex <= 0) {
    console.error('[market] parseMarketOpenPosition: invalid or missing critical fields', {
      positionId: positionId || '(empty)',
      contractId: contractId || '(empty)',
      margin,
      entryIndex
    });
    return null;
  }
  return {
    positionId,
    contractId,
    side,
    lockTier,
    lots,
    margin,
    stake: margin,
    openFee,
    leverage,
    entryIndex,
    entryPrice: entryIndex,
    entryTickTs,
    expireAt,
    openedAt: (openedAtDate ?? createdAt).toISOString()
  };
}

function parseMarketSettlement(metadata: Prisma.JsonValue | null | undefined, createdAt: Date): MarketSettlementRecord | null {
  const json = asJsonObject(metadata);
  const positionId = String(json.positionId ?? '').trim();
  const contractId = String(json.contractId ?? '').trim();
  const sideRaw = String(json.side ?? '').toUpperCase();
  const side: MarketPositionSide = sideRaw === 'SHORT' ? 'SHORT' : 'LONG';
  const statusRaw = String(json.status ?? '').trim().toUpperCase();
  const status: MarketPositionStatus = ['LIQUIDATED', 'EXPIRED', 'OPEN', 'SETTLED'].includes(statusRaw)
    ? statusRaw as MarketPositionStatus
    : 'SETTLED';
  const lockTier = resolveMarketLockTier(String(json.lockTier ?? 'T1'));
  const lots = Math.max(1, toSafeInt(json.lots, Math.floor(toSafeInt(json.stake, 0) / MARKET_LOT_TOKEN)));
  const margin = Math.max(0, toSafeInt(json.margin, toSafeInt(json.stake, 0)));
  const openFee = Math.max(0, toSafeInt(json.openFee, 0));
  const leverage = Math.max(1, Math.min(100, toSafeInt(json.leverage, 1)));
  const entryIndex = Math.max(0, toSafeNumber(json.entryIndex, toSafeNumber(json.entryPrice, 0)));
  const settleIndex = Math.max(0, toSafeNumber(json.settleIndex, toSafeNumber(json.exitPrice, 0)));
  const settleFee = Math.max(0, toSafeInt(json.settleFee, 0));
  const payout = Math.max(0, toSafeInt(json.payout, 0));
  const pnl = toSafeInt(json.pnl, payout - margin - openFee);
  const expireAtRaw = String(json.expireAt ?? '').trim();
  const expireAtDate = expireAtRaw ? toDate(expireAtRaw) : null;
  const liquidatedAtRaw = String(json.liquidatedAt ?? '').trim();
  const liquidatedAtDate = liquidatedAtRaw ? toDate(liquidatedAtRaw) : null;
  const settledAtRaw = String(json.settledAt ?? '').trim();
  const settledAtDate = settledAtRaw ? toDate(settledAtRaw) : null;
  if (!positionId || !contractId || margin <= 0 || entryIndex <= 0 || settleIndex <= 0) return null;
  return {
    positionId,
    contractId,
    side,
    status,
    lockTier,
    lots,
    margin,
    stake: margin,
    openFee,
    leverage,
    entryIndex,
    entryPrice: entryIndex,
    settleIndex,
    exitPrice: settleIndex,
    settleFee,
    payout,
    pnl,
    expireAt: (expireAtDate ?? createdAt).toISOString(),
    liquidatedAt: liquidatedAtDate ? liquidatedAtDate.toISOString() : null,
    settledAt: (settledAtDate ?? createdAt).toISOString()
  };
}

type TradeAffixBreakdownEntry = {
  affixSignature: string;
  affixStyles: AffixVisualStyle[];
  affixStyleCounts: AffixStyleCountMap;
  affixVisualStyle: AffixVisualStyle;
  affixLabel: string;
  count: number;
};

function normalizeTradeAffixBreakdownEntries(entries: Array<{ affixSignature?: string; affixVisualStyle?: AffixVisualStyle; count: number }>) {
  const merged = new Map<string, number>();
  for (const entry of entries) {
    const signature = entry.affixSignature
      ? affixSignatureFromStyles(parseAffixSignature(entry.affixSignature))
      : affixSignatureFromStyles([normalizeAffixVisualStyleInput(entry.affixVisualStyle)]);
    const count = Math.max(0, Math.floor(entry.count));
    if (count <= 0) continue;
    merged.set(signature, (merged.get(signature) ?? 0) + count);
  }
  return [...merged.entries()]
    .map(([signature, count]) => ({
      ...buildAffixFingerprintFromSignature(signature),
      count: Math.max(0, Math.floor(count || 0))
    }))
    .sort((a, b) => variantEntrySortWeight(a.affixSignature) - variantEntrySortWeight(b.affixSignature));
}

function parseTradeListingAffixBreakdown(metadata: Prisma.JsonValue | null | undefined) {
  const json = asJsonObject(metadata);
  const rows = Array.isArray(json.affixBreakdown) ? json.affixBreakdown : [];
  const parsed: Array<{ affixSignature?: string; affixVisualStyle?: AffixVisualStyle; count: number }> = [];
  for (const row of rows) {
    const item = asJsonObject(row as Prisma.JsonValue);
    const signature = String(item.affixSignature ?? '').trim();
    const style = normalizeAffixVisualStyleInput(item.affixVisualStyle);
    const count = Math.max(0, Math.floor(Number(item.count) || 0));
    if (count <= 0) continue;
    if (signature) {
      parsed.push({ affixSignature: signature, count });
      continue;
    }
    parsed.push({ affixVisualStyle: style, count });
  }
  return normalizeTradeAffixBreakdownEntries(parsed);
}

function serializeTradeListingAffixBreakdown(entries: TradeAffixBreakdownEntry[]) {
  return {
    affixBreakdown: entries.map((entry) => ({
      affixSignature: affixSignatureFromStyles(parseAffixSignature(entry.affixSignature)),
      affixVisualStyle: entry.affixVisualStyle,
      count: Math.max(0, Math.floor(entry.count))
    }))
  } as Prisma.JsonObject;
}

function buildFallbackTradeAffixBreakdown(
  card: { id: string; title: string; tags?: string[] | null },
  count: number
) {
  const normalizedCount = Math.max(0, Math.floor(count));
  if (normalizedCount <= 0) return [];
  return normalizeTradeAffixBreakdownEntries([{
    affixSignature: affixSignatureFromStyles([inferLegacyAffixVisualStyle(card) ?? 'NONE']),
    count: normalizedCount
  }]);
}

function splitTradeAffixBreakdownByQuantity(entries: TradeAffixBreakdownEntry[], quantity: number) {
  const map = emptyAffixVariantMap();
  for (const entry of entries) {
    const signature = affixSignatureFromStyles(parseAffixSignature(entry.affixSignature));
    map[signature] = (map[signature] ?? 0) + Math.max(0, Math.floor(entry.count));
  }
  const consumed = consumeAffixStacks(map, quantity);
  const remainingEntries = Object.entries(map).map(([affixSignature, count]) => ({
    affixSignature,
    count
  }));
  return {
    consumed: normalizeTradeAffixBreakdownEntries(consumed.consumed),
    consumedCount: consumed.consumedCount,
    remaining: normalizeTradeAffixBreakdownEntries(remainingEntries)
  };
}

async function consumeInventoryForTrade(
  tx: Tx,
  userId: string,
  card: { id: string; title: string; tags?: string[] | null },
  quantity: number
) {
  const normalizedQuantity = Math.max(0, Math.floor(quantity));
  if (normalizedQuantity <= 0) {
    return [] as TradeAffixBreakdownEntry[];
  }
  const inventory = await tx.gachaInventory.findUnique({
    where: { userId_cardId: { userId, cardId: card.id } }
  });
  if (!inventory || inventory.count < normalizedQuantity) {
    throw Object.assign(new Error('库存不足'), { status: 400 });
  }
  const assignedRows = await tx.gachaPlacementSlot.findMany({
    where: {
      userId,
      cardId: card.id,
      assignedAt: { not: null }
    },
    select: { affixVisualStyle: true, affixSignature: true }
  });
  const assignedByVariant = emptyAffixVariantMap();
  for (const row of assignedRows) {
    const signature = affixSignatureFromStyles(parseAffixSignature(row.affixSignature || row.affixVisualStyle || 'NONE'));
    assignedByVariant[signature] = (assignedByVariant[signature] ?? 0) + 1;
  }
  const { variantMap } = normalizeInventoryAffixStacks(card, inventory.count, inventory.affixStacks);
  const freeMap = emptyAffixVariantMap();
  for (const [signature, countRaw] of Object.entries(variantMap)) {
    const count = Math.max(0, Math.floor(countRaw || 0));
    const assigned = Math.max(0, Math.floor(assignedByVariant[signature] ?? 0));
    const freeCount = Math.max(0, count - assigned);
    if (freeCount > 0) {
      freeMap[signature] = freeCount;
    }
  }
  const consumed = consumeAffixStacks({ ...freeMap } as AffixVariantMap, normalizedQuantity);
  if (consumed.consumedCount < normalizedQuantity) {
    throw Object.assign(new Error('可上架数量不足（已放置或库存不足）'), { status: 400 });
  }
  for (const entry of consumed.consumed) {
    variantMap[entry.affixSignature] = Math.max(0, Math.floor((variantMap[entry.affixSignature] ?? 0) - entry.count));
    if (variantMap[entry.affixSignature] <= 0) {
      delete variantMap[entry.affixSignature];
    }
  }
  const remaining = inventory.count - normalizedQuantity;
  await tx.gachaInventory.update({
    where: { id: inventory.id },
    data: {
      count: remaining,
      affixStacks: serializeAffixStacks(alignAffixVariantMapToCount(card, variantMap, remaining))
    }
  });
  return normalizeTradeAffixBreakdownEntries(consumed.consumed);
}

async function grantInventoryByAffixBreakdown(
  tx: Tx,
  userId: string,
  card: { id: string; title: string; tags?: string[] | null },
  entries: TradeAffixBreakdownEntry[]
) {
  const normalized = normalizeTradeAffixBreakdownEntries(entries);
  const increment = normalized.reduce((sum, entry) => sum + entry.count, 0);
  if (increment <= 0) return;
  const inventory = await tx.gachaInventory.findUnique({
    where: { userId_cardId: { userId, cardId: card.id } }
  });
  if (!inventory) {
    const map = emptyAffixVariantMap();
    for (const entry of normalized) {
      map[entry.affixSignature] = (map[entry.affixSignature] ?? 0) + entry.count;
    }
    await tx.gachaInventory.create({
      data: {
        userId,
        cardId: card.id,
        count: increment,
        affixStacks: serializeAffixStacks(map)
      }
    });
    return;
  }
  const { variantMap } = normalizeInventoryAffixStacks(card, inventory.count, inventory.affixStacks);
  for (const entry of normalized) {
    variantMap[entry.affixSignature] = (variantMap[entry.affixSignature] ?? 0) + entry.count;
  }
  const nextCount = inventory.count + increment;
  await tx.gachaInventory.update({
    where: { id: inventory.id },
    data: {
      count: nextCount,
      affixStacks: serializeAffixStacks(alignAffixVariantMapToCount(card, variantMap, nextCount))
    }
  });
}

type TradeListingCardLite = { id: string; title: string; tags?: string[] | null };
type TradeListingForExpiry = {
  id: string;
  sellerId: string;
  remaining: number;
  status: 'OPEN' | 'SOLD' | 'CANCELLED' | 'EXPIRED';
  expiresAt: Date | null;
  metadata: Prisma.JsonValue;
  card: TradeListingCardLite;
};

async function expireTradeListingIfNeeded(
  tx: Tx,
  listing: TradeListingForExpiry,
  asOf = now()
): Promise<boolean> {
  if (listing.status !== 'OPEN' || listing.remaining <= 0) return false;
  if (!listing.expiresAt || listing.expiresAt.getTime() > asOf.getTime()) return false;
  // Unlock all instances locked for this listing (returns them to seller's inventory)
  if (listing.remaining > 0) {
    await unlockTradeInstances(tx, listing.id);
  }
  await tx.gachaTradeListing.update({
    where: { id: listing.id },
    data: {
      remaining: 0,
      status: 'EXPIRED',
      metadata: serializeTradeListingAffixBreakdown([])
    }
  });
  return true;
}

async function settleExpiredTradeListings(
  tx: Tx,
  asOf = now(),
  options: { batchSize?: number } = {}
) {
  const batchSize = Math.max(1, Math.min(options.batchSize ?? TRADE_EXPIRY_SWEEP_BATCH_SIZE, 2000));
  const expired = await tx.gachaTradeListing.findMany({
    where: {
      status: 'OPEN',
      expiresAt: { lte: asOf },
      remaining: { gt: 0 }
    },
    take: batchSize,
    orderBy: { expiresAt: 'asc' },
    select: {
      id: true,
      sellerId: true,
      cardId: true,
      remaining: true,
      expiresAt: true,
      metadata: true,
      card: {
        select: {
          id: true,
          title: true,
          tags: true
        }
      }
    }
  });
  let settledCount = 0;
  for (const listing of expired) {
    // eslint-disable-next-line no-await-in-loop
    const didSettle = await expireTradeListingIfNeeded(tx, {
      id: listing.id,
      sellerId: listing.sellerId,
      remaining: listing.remaining,
      status: 'OPEN',
      expiresAt: listing.expiresAt,
      metadata: listing.metadata,
      card: listing.card
    }, asOf);
    if (didSettle) {
      settledCount += 1;
    }
  }
  return settledCount;
}

async function runTradeExpirySweep(asOf = now()) {
  let processed = 0;
  for (let batch = 0; batch < TRADE_EXPIRY_SWEEP_MAX_BATCHES_PER_RUN; batch += 1) {
    // eslint-disable-next-line no-await-in-loop
    const settled = await runSerializableTransaction(async (tx) => (
      settleExpiredTradeListings(tx, asOf, { batchSize: TRADE_EXPIRY_SWEEP_BATCH_SIZE })
    ));
    processed += settled;
    if (settled < TRADE_EXPIRY_SWEEP_BATCH_SIZE) break;
  }
  return processed;
}

function triggerTradeExpirySweep() {
  if (tradeExpirySweepInFlight) return;
  const nowMs = Date.now();
  if (nowMs - tradeExpirySweepLastRunAt < TRADE_EXPIRY_SWEEP_INTERVAL_MS) return;
  tradeExpirySweepLastRunAt = nowMs;
  tradeExpirySweepInFlight = runTradeExpirySweep()
    .catch((error) => {
      // eslint-disable-next-line no-console
      console.warn('[gacha] trade expiry sweep failed', error);
      return 0;
    })
    .finally(() => {
      tradeExpirySweepInFlight = null;
    });
}

function serializeTradeListing(
  listing: Prisma.GachaTradeListingGetPayload<{
    include: {
      card: true;
      seller: { select: { id: true; displayName: true; linkedWikidotId: true } };
      buyer: { select: { id: true; displayName: true; linkedWikidotId: true } };
    };
  }>
) {
  const affixBreakdown = parseTradeListingAffixBreakdown(listing.metadata);
  const effectiveStatus: 'OPEN' | 'SOLD' | 'CANCELLED' | 'EXPIRED' = (
    listing.status === 'OPEN'
    && listing.remaining > 0
    && listing.expiresAt
    && listing.expiresAt.getTime() <= Date.now()
  )
    ? 'EXPIRED'
    : listing.status;
  return {
    id: listing.id,
    sellerId: listing.sellerId,
    buyerId: listing.buyerId,
    cardId: listing.cardId,
    quantity: listing.quantity,
    remaining: listing.remaining,
    unitPrice: listing.unitPrice,
    totalPrice: listing.totalPrice,
    status: effectiveStatus,
    expiresAt: listing.expiresAt?.toISOString() ?? null,
    soldAt: listing.soldAt?.toISOString() ?? null,
    createdAt: listing.createdAt.toISOString(),
    updatedAt: listing.updatedAt.toISOString(),
    affixBreakdown,
    card: serializeCardSummary(listing.card),
    seller: {
      id: listing.seller.id,
      displayName: listing.seller.displayName ?? null,
      linkedWikidotId: listing.seller.linkedWikidotId ?? null
    },
    buyer: listing.buyer
      ? {
          id: listing.buyer.id,
          displayName: listing.buyer.displayName ?? null,
          linkedWikidotId: listing.buyer.linkedWikidotId ?? null
        }
      : null
  };
}

function buildTradeListingOrderBy(sortMode: TradeSortMode): Prisma.GachaTradeListingOrderByWithRelationInput[] {
  if (sortMode === 'PRICE_ASC') {
    return [{ unitPrice: 'asc' }, { createdAt: 'desc' }];
  }
  if (sortMode === 'PRICE_DESC') {
    return [{ unitPrice: 'desc' }, { createdAt: 'desc' }];
  }
  if (sortMode === 'TOTAL_ASC') {
    return [{ totalPrice: 'asc' }, { createdAt: 'desc' }];
  }
  if (sortMode === 'TOTAL_DESC') {
    return [{ totalPrice: 'desc' }, { createdAt: 'desc' }];
  }
  if (sortMode === 'RARITY_DESC') {
    return [{ card: { rarity: 'desc' } }, { createdAt: 'desc' }];
  }
  return [{ createdAt: 'desc' }];
}

function escapeSqlLikePattern(value: string) {
  return String(value || '').replace(/[\\%_]/g, '\\$&');
}

function pruneAuthorCardSearchCache() {
  if (authorCardSearchCache.size <= 600) return;
  const nowMs = Date.now();
  for (const [key, entry] of authorCardSearchCache.entries()) {
    if (entry.expiresAt <= nowMs) {
      authorCardSearchCache.delete(key);
    }
  }
  while (authorCardSearchCache.size > 600) {
    const oldestKey = authorCardSearchCache.keys().next().value;
    if (!oldestKey) break;
    authorCardSearchCache.delete(oldestKey);
  }
}

function readAuthorCardSearchCache(key: string) {
  const entry = authorCardSearchCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    authorCardSearchCache.delete(key);
    return null;
  }
  return entry.cardIds;
}

function writeAuthorCardSearchCache(key: string, cardIds: string[]) {
  pruneAuthorCardSearchCache();
  authorCardSearchCache.set(key, {
    expiresAt: Date.now() + AUTHOR_SEARCH_CACHE_TTL_MS,
    cardIds
  });
}

type BffAuthorPageLookupPayload = {
  ok?: boolean;
  items?: Array<{ wikidotId?: number | null; pageId?: number | null }>;
} | null;

async function fetchAuthorMatchedPageKeys(search: string): Promise<{ wikidotIds: number[]; pageIds: number[] }> {
  const query = String(search || '').trim();
  if (!query) return { wikidotIds: [], pageIds: [] };
  const endpoint = `${BFF_BASE_URL}/internal/gacha-author-pages?query=${encodeURIComponent(query)}&limit=${encodeURIComponent(String(AUTHOR_BFF_PAGE_LOOKUP_LIMIT))}&userLimit=${encodeURIComponent(String(AUTHOR_BFF_USER_LOOKUP_LIMIT))}`;
  let response: globalThis.Response;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BFF_INTERNAL_FETCH_TIMEOUT_MS);
  try {
    response = await fetch(endpoint, {
      method: 'GET',
      signal: controller.signal,
      headers: BFF_INTERNAL_KEY
        ? { 'x-internal-key': BFF_INTERNAL_KEY }
        : undefined
    });
  } catch {
    return { wikidotIds: [], pageIds: [] };
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) return { wikidotIds: [], pageIds: [] };
  const payload = await response.json().catch(() => null) as BffAuthorPageLookupPayload;
  if (!payload?.ok || !Array.isArray(payload.items)) {
    return { wikidotIds: [], pageIds: [] };
  }
  const wikidotIds = new Set<number>();
  const pageIds = new Set<number>();
  for (const item of payload.items) {
    const wikidotId = Number(item?.wikidotId);
    if (Number.isFinite(wikidotId) && wikidotId > 0) {
      wikidotIds.add(Math.floor(wikidotId));
    }
    const pageId = Number(item?.pageId);
    if (Number.isFinite(pageId) && pageId > 0) {
      pageIds.add(Math.floor(pageId));
    }
  }
  return {
    wikidotIds: Array.from(wikidotIds),
    pageIds: Array.from(pageIds)
  };
}

async function findCardIdsByAuthorKeyword(search: string): Promise<string[]> {
  const normalizedKeyword = normalizePlacementAuthorKey(search);
  if (!normalizedKeyword) return [];
  const cached = readAuthorCardSearchCache(normalizedKeyword);
  if (cached) return cached;
  const likePattern = `%${escapeSqlLikePattern(normalizedKeyword)}%`;
  const tagRowsPromise = prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT DISTINCT c.id
    FROM "GachaCardDefinition" c
    JOIN LATERAL UNNEST(c.tags) AS t(tag) ON TRUE
    WHERE t.tag ~* '^(?:作者|author|authors|by|译者|translator|translators?)'
      AND regexp_replace(
        regexp_replace(
          lower(t.tag),
          '^(?:作者|author|authors|by|译者|translator|translators?)[\\s:_\\-\\/\\\\：]*',
          '',
          'i'
        ),
        '[\\s_:\\-\\/\\\\\\.\\u3000：；，、|]+',
        '',
        'g'
      ) LIKE ${likePattern} ESCAPE '\\'
    LIMIT ${AUTHOR_CARD_SEARCH_LIMIT}
  `);
  const pageKeysPromise = fetchAuthorMatchedPageKeys(search);
  const [tagRows, pageKeys] = await Promise.all([tagRowsPromise, pageKeysPromise]);

  const cardIds = new Set(
    (tagRows ?? [])
      .map((row) => String(row?.id || '').trim())
      .filter(Boolean)
  );

  const pageMatchOr: Prisma.GachaCardDefinitionWhereInput[] = [];
  if (pageKeys.wikidotIds.length > 0) {
    pageMatchOr.push({
      wikidotId: {
        in: pageKeys.wikidotIds
      }
    });
  }
  if (pageKeys.pageIds.length > 0) {
    pageMatchOr.push({
      pageId: {
        in: pageKeys.pageIds
      }
    });
  }
  if (pageMatchOr.length > 0) {
    const pageMatchedCards = await prisma.gachaCardDefinition.findMany({
      where: {
        OR: pageMatchOr
      },
      select: {
        id: true
      },
      take: AUTHOR_CARD_SEARCH_LIMIT
    });
    for (const row of pageMatchedCards) {
      const id = String(row?.id || '').trim();
      if (id) cardIds.add(id);
      if (cardIds.size >= AUTHOR_CARD_SEARCH_LIMIT) break;
    }
  }

  const ids = Array.from(cardIds).slice(0, AUTHOR_CARD_SEARCH_LIMIT);
  writeAuthorCardSearchCache(normalizedKeyword, ids);
  return ids;
}

async function buildTradeListingSearchWhere(search: string, mode: TradeSearchMode): Promise<Prisma.GachaTradeListingWhereInput | null> {
  const keyword = search.trim();
  if (!keyword) return null;
  const keywordLower = keyword.toLowerCase();
  const keywordInt = toSafeInt(keyword, 0);
  const numericKeyword = Number.isSafeInteger(keywordInt) && keywordInt > 0 ? keywordInt : null;
  const cardAuthorMatchedIds = mode === 'SELLER' ? [] : await findCardIdsByAuthorKeyword(keyword);

  const cardConditions: Prisma.GachaTradeListingWhereInput[] = [
    {
      card: {
        is: {
          title: {
            contains: keyword,
            mode: 'insensitive'
          }
        }
      }
    },
    {
      card: {
        is: {
          tags: {
            hasSome: [keywordLower]
          }
        }
      }
    },
    {
      cardId: {
        contains: keyword,
        mode: 'insensitive'
      }
    }
  ];

  if (cardAuthorMatchedIds.length > 0) {
    cardConditions.push({
      cardId: {
        in: cardAuthorMatchedIds
      }
    });
  }

  if (numericKeyword != null) {
    cardConditions.push({
      card: {
        is: {
          wikidotId: numericKeyword
        }
      }
    });
    cardConditions.push({
      card: {
        is: {
          pageId: numericKeyword
        }
      }
    });
  }

  const sellerConditions: Prisma.GachaTradeListingWhereInput[] = [
    {
      seller: {
        is: {
          displayName: {
            contains: keyword,
            mode: 'insensitive'
          }
        }
      }
    },
    {
      sellerId: {
        contains: keyword,
        mode: 'insensitive'
      }
    }
  ];

  if (numericKeyword != null) {
    sellerConditions.push({
      seller: {
        is: {
          linkedWikidotId: numericKeyword
        }
      }
    });
  }

  if (mode === 'CARD') {
    return { OR: cardConditions };
  }
  if (mode === 'SELLER') {
    return { OR: sellerConditions };
  }
  return { OR: [...cardConditions, ...sellerConditions] };
}

// ═══════════════════════════════════════════════════════
// BUY REQUEST HELPERS
// ═══════════════════════════════════════════════════════

const buyRequestInclude = {
  targetCard: true,
  buyer: { select: { id: true, displayName: true, linkedWikidotId: true } },
  fulfiller: { select: { id: true, displayName: true, linkedWikidotId: true } },
  offeredCards: { include: { card: true } }
} as const;

type BuyRequestWithRelations = Prisma.GachaBuyRequestGetPayload<{ include: typeof buyRequestInclude }>;

function serializeBuyRequest(br: BuyRequestWithRelations) {
  const effectiveStatus: 'OPEN' | 'FULFILLED' | 'CANCELLED' | 'EXPIRED' = (
    br.status === 'OPEN' && br.expiresAt && br.expiresAt.getTime() <= Date.now()
  ) ? 'EXPIRED' : br.status;
  return {
    id: br.id,
    buyerId: br.buyerId,
    targetCardId: br.targetCardId,
    matchLevel: br.matchLevel ?? 'IMAGE_VARIANT',
    requiredCoating: br.requiredCoating ?? null,
    tokenOffer: br.tokenOffer,
    status: effectiveStatus,
    fulfillerId: br.fulfillerId,
    expiresAt: br.expiresAt?.toISOString() ?? null,
    fulfilledAt: br.fulfilledAt?.toISOString() ?? null,
    createdAt: br.createdAt.toISOString(),
    updatedAt: br.updatedAt.toISOString(),
    targetCard: serializeCardSummary(br.targetCard),
    buyer: {
      id: br.buyer.id,
      displayName: br.buyer.displayName ?? null,
      linkedWikidotId: br.buyer.linkedWikidotId ?? null
    },
    fulfiller: br.fulfiller ? {
      id: br.fulfiller.id,
      displayName: br.fulfiller.displayName ?? null,
      linkedWikidotId: br.fulfiller.linkedWikidotId ?? null
    } : null,
    offeredCards: br.offeredCards.map((oc) => {
      return {
        id: oc.id,
        cardId: oc.cardId,
        quantity: oc.quantity,
        card: serializeCardSummary(oc.card)
      };
    })
  };
}

async function lockInstancesForBuyRequest(tx: Tx, instanceIds: string[], buyRequestId: string) {
  if (instanceIds.length === 0) return;
  const instances = await tx.gachaCardInstance.findMany({
    where: { id: { in: instanceIds } },
    select: { userId: true, cardId: true }
  });
  await tx.gachaCardInstance.updateMany({
    where: { id: { in: instanceIds } },
    data: { buyRequestId }
  });
  const countsByKey = new Map<string, { userId: string; cardId: string; count: number }>();
  for (const inst of instances) {
    const key = `${inst.userId}:${inst.cardId}`;
    const entry = countsByKey.get(key);
    if (entry) { entry.count += 1; } else { countsByKey.set(key, { userId: inst.userId, cardId: inst.cardId, count: 1 }); }
  }
  for (const entry of countsByKey.values()) {
    // eslint-disable-next-line no-await-in-loop
    await tx.gachaInventory.updateMany({
      where: { userId: entry.userId, cardId: entry.cardId },
      data: { count: { decrement: entry.count } }
    });
  }
}

async function unlockBuyRequestInstances(tx: Tx, buyRequestId: string) {
  const instances = await tx.gachaCardInstance.findMany({
    where: { buyRequestId },
    select: { id: true, userId: true, cardId: true }
  });
  if (instances.length === 0) return;
  await tx.gachaCardInstance.updateMany({
    where: { buyRequestId },
    data: { buyRequestId: null }
  });
  const countsByKey = new Map<string, { userId: string; cardId: string; count: number }>();
  for (const inst of instances) {
    const key = `${inst.userId}:${inst.cardId}`;
    const entry = countsByKey.get(key);
    if (entry) { entry.count += 1; } else { countsByKey.set(key, { userId: inst.userId, cardId: inst.cardId, count: 1 }); }
  }
  for (const entry of countsByKey.values()) {
    // eslint-disable-next-line no-await-in-loop
    await tx.gachaInventory.upsert({
      where: { userId_cardId: { userId: entry.userId, cardId: entry.cardId } },
      create: { userId: entry.userId, cardId: entry.cardId, count: entry.count },
      update: { count: { increment: entry.count } }
    });
  }
}

async function expireBuyRequestIfNeeded(tx: Tx, br: { id: string; buyerId: string; status: string; expiresAt: Date | null; tokenOffer: number }, asOf = now()): Promise<boolean> {
  if (br.status !== 'OPEN') return false;
  if (!br.expiresAt || br.expiresAt.getTime() > asOf.getTime()) return false;
  await unlockBuyRequestInstances(tx, br.id);
  if (br.tokenOffer > 0) {
    const wallet = await ensureWallet(tx, br.buyerId);
    await applyWalletDelta(tx, wallet, br.tokenOffer, BUY_REQUEST_CANCEL_REASON, {
      buyRequestId: br.id,
      reason: 'expired'
    });
  }
  await tx.gachaBuyRequest.update({
    where: { id: br.id },
    data: { status: 'EXPIRED' }
  });
  return true;
}

async function runBuyRequestExpirySweep(asOf = now()) {
  let processed = 0;
  for (let batch = 0; batch < BUY_REQUEST_EXPIRY_SWEEP_MAX_BATCHES; batch += 1) {
    // eslint-disable-next-line no-await-in-loop
    const settled = await runSerializableTransaction(async (tx) => {
      const expired = await tx.gachaBuyRequest.findMany({
        where: {
          status: 'OPEN',
          expiresAt: { lte: asOf }
        },
        take: BUY_REQUEST_EXPIRY_SWEEP_BATCH_SIZE,
        orderBy: { expiresAt: 'asc' },
        select: { id: true, buyerId: true, status: true, expiresAt: true, tokenOffer: true }
      });
      let count = 0;
      for (const br of expired) {
        // eslint-disable-next-line no-await-in-loop
        const didExpire = await expireBuyRequestIfNeeded(tx, br, asOf);
        if (didExpire) count += 1;
      }
      return count;
    });
    processed += settled;
    if (settled < BUY_REQUEST_EXPIRY_SWEEP_BATCH_SIZE) break;
  }
  return processed;
}

function triggerBuyRequestExpirySweep() {
  if (buyRequestExpirySweepInFlight) return;
  const nowMs = Date.now();
  if (nowMs - buyRequestExpirySweepLastRunAt < BUY_REQUEST_EXPIRY_SWEEP_INTERVAL_MS) return;
  buyRequestExpirySweepLastRunAt = nowMs;
  buyRequestExpirySweepInFlight = runBuyRequestExpirySweep()
    .catch((error) => {
      // eslint-disable-next-line no-console
      console.warn('[gacha] buy request expiry sweep failed', error);
      return 0;
    })
    .finally(() => {
      buyRequestExpirySweepInFlight = null;
    });
}

async function loadUsersWithDueMarketSettlement(
  tx: Tx | typeof prisma,
  asOf = now(),
  limit = MARKET_SETTLE_SWEEP_USER_BATCH_SIZE,
  afterUserId: string | null = null
) {
  const since = new Date(asOf.getTime() - MARKET_USER_LEDGER_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  const cursorCondition = afterUserId
    ? Prisma.sql`AND opens."userId" > ${afterUserId}`
    : Prisma.empty;
  return tx.$queryRaw<Array<{ userId: string }>>(Prisma.sql`
    WITH opens AS (
      SELECT DISTINCT ON (open_events."positionId")
        open_events."positionId",
        open_events."userId",
        open_events."expireAt"
      FROM (
        SELECT
          "userId",
          COALESCE(metadata->>'positionId', '') AS "positionId",
          COALESCE((metadata->>'expireAt')::timestamptz, "createdAt") AS "expireAt",
          "createdAt"
        FROM "GachaLedgerEntry"
        WHERE reason = ${MARKET_OPEN_REASON}
          AND "createdAt" >= ${since}
      ) AS open_events
      WHERE open_events."positionId" <> ''
      ORDER BY open_events."positionId", open_events."createdAt" ASC
    ),
    settles AS (
      SELECT DISTINCT
        COALESCE(metadata->>'positionId', '') AS "positionId"
      FROM "GachaLedgerEntry"
      WHERE reason = ${MARKET_SETTLE_REASON}
        AND "createdAt" >= ${since}
        AND COALESCE(metadata->>'positionId', '') <> ''
    )
    SELECT DISTINCT opens."userId"
    FROM opens
    LEFT JOIN settles ON settles."positionId" = opens."positionId"
    WHERE settles."positionId" IS NULL
      AND opens."expireAt" <= ${asOf}
      ${cursorCondition}
    ORDER BY opens."userId" ASC
    LIMIT ${Math.max(1, Math.floor(limit))}
  `);
}

async function runMarketSettleSweep(asOf = now()) {
  const oracleContext = await loadOracleContext(asOf, ORACLE_TICK_LIMIT_POSITION);
  let settledPositions = 0;
  // Use persistent cursor so that stuck users at the front of the sort don't
  // block later users across sweep invocations. Resets to null when a full
  // pass completes (batch returned fewer than BATCH_SIZE), ensuring every
  // user is eventually visited.
  let cursor = marketSettleSweepCursor;
  for (let batch = 0; batch < MARKET_SETTLE_SWEEP_MAX_BATCHES_PER_RUN; batch += 1) {
    // eslint-disable-next-line no-await-in-loop
    const dueUsers = await loadUsersWithDueMarketSettlement(prisma, asOf, MARKET_SETTLE_SWEEP_USER_BATCH_SIZE, cursor);
    if (dueUsers.length <= 0) {
      // Wrapped around — reset cursor so next invocation starts from the top
      cursor = null;
      break;
    }
    for (const row of dueUsers) {
      const userId = String(row.userId || '').trim();
      if (!userId) continue;
      cursor = userId;
      // eslint-disable-next-line no-await-in-loop
      const settledForUser = await runSerializableTransaction(async (tx) => {
        const wallet = await ensureWallet(tx, userId);
        const settled = await settleDueMarketPositions(tx, userId, wallet, oracleContext, asOf);
        return settled.settlements.length;
      });
      settledPositions += settledForUser;
    }
    if (dueUsers.length < MARKET_SETTLE_SWEEP_USER_BATCH_SIZE) {
      // Reached the end of due users — reset cursor for next invocation
      cursor = null;
      break;
    }
  }
  marketSettleSweepCursor = cursor;
  return settledPositions;
}

function triggerMarketSettleSweep() {
  if (marketSettleSweepInFlight) return;
  const nowMs = Date.now();
  if (nowMs - marketSettleSweepLastRunAt < MARKET_SETTLE_SWEEP_INTERVAL_MS) return;
  marketSettleSweepLastRunAt = nowMs;
  marketSettleSweepInFlight = runMarketSettleSweep()
    .catch((error) => {
      // eslint-disable-next-line no-console
      console.warn('[gacha] market settle sweep failed', error);
      return 0;
    })
    .finally(() => {
      marketSettleSweepInFlight = null;
    });
}

function buildBuyRequestOrderBy(sortMode: string): Prisma.GachaBuyRequestOrderByWithRelationInput[] {
  if (sortMode === 'TOKEN_DESC') return [{ tokenOffer: 'desc' }, { createdAt: 'desc' }];
  if (sortMode === 'TOKEN_ASC') return [{ tokenOffer: 'asc' }, { createdAt: 'desc' }];
  if (sortMode === 'EXPIRY_ASC') return [{ expiresAt: 'asc' }, { createdAt: 'desc' }];
  if (sortMode === 'RARITY_DESC') return [{ targetCard: { rarity: 'desc' } }, { createdAt: 'desc' }];
  return [{ createdAt: 'desc' }];
}

async function computeTicketBalance(tx: Tx, userId: string): Promise<TicketBalance> {
  const rows = await tx.$queryRaw<Array<{
    drawTicket: number | string | null;
    draw10Ticket: number | string | null;
    affixReforgeTicket: number | string | null;
  }>>(Prisma.sql`
    SELECT
      COALESCE(SUM(
        CASE
          WHEN reason = ${TICKET_LEDGER_REASON_GRANT} THEN
            CASE
              WHEN (metadata->>'drawTicket') ~ '^-?[0-9]+$' THEN (metadata->>'drawTicket')::bigint
              ELSE 0
            END
          WHEN reason = ${TICKET_LEDGER_REASON_USE} THEN
            -CASE
              WHEN (metadata->>'drawTicket') ~ '^-?[0-9]+$' THEN (metadata->>'drawTicket')::bigint
              ELSE 0
            END
          ELSE 0
        END
      ), 0) AS "drawTicket",
      COALESCE(SUM(
        CASE
          WHEN reason = ${TICKET_LEDGER_REASON_GRANT} THEN
            CASE
              WHEN (metadata->>'draw10Ticket') ~ '^-?[0-9]+$' THEN (metadata->>'draw10Ticket')::bigint
              ELSE 0
            END
          WHEN reason = ${TICKET_LEDGER_REASON_USE} THEN
            -CASE
              WHEN (metadata->>'draw10Ticket') ~ '^-?[0-9]+$' THEN (metadata->>'draw10Ticket')::bigint
              ELSE 0
            END
          ELSE 0
        END
      ), 0) AS "draw10Ticket",
      COALESCE(SUM(
        CASE
          WHEN reason = ${TICKET_LEDGER_REASON_GRANT} THEN
            CASE
              WHEN (metadata->>'affixReforgeTicket') ~ '^-?[0-9]+$' THEN (metadata->>'affixReforgeTicket')::bigint
              ELSE 0
            END
          WHEN reason = ${TICKET_LEDGER_REASON_USE} THEN
            -CASE
              WHEN (metadata->>'affixReforgeTicket') ~ '^-?[0-9]+$' THEN (metadata->>'affixReforgeTicket')::bigint
              ELSE 0
            END
          ELSE 0
        END
      ), 0) AS "affixReforgeTicket"
    FROM "GachaLedgerEntry"
    WHERE "userId" = ${userId}
      AND reason IN (${TICKET_LEDGER_REASON_GRANT}, ${TICKET_LEDGER_REASON_USE})
  `);
  const row = rows[0];
  return normalizeTicketBalance({
    drawTicket: toSafeInt(row?.drawTicket, 0),
    draw10Ticket: toSafeInt(row?.draw10Ticket, 0),
    affixReforgeTicket: toSafeInt(row?.affixReforgeTicket, 0)
  });
}

async function grantTicketBalance(
  tx: Tx,
  wallet: Prisma.GachaWalletGetPayload<{}>,
  userId: string,
  tickets: TicketBalance,
  source: string,
  sourceKey?: string
) {
  if (isZeroTicketBalance(tickets)) return;
  await recordLedger(tx, wallet.id, userId, 0, TICKET_LEDGER_REASON_GRANT, {
    source,
    sourceKey: sourceKey ?? null,
    drawTicket: tickets.drawTicket,
    draw10Ticket: tickets.draw10Ticket,
    affixReforgeTicket: tickets.affixReforgeTicket
  });
}

async function consumeTicketBalance(
  tx: Tx,
  wallet: Prisma.GachaWalletGetPayload<{}>,
  userId: string,
  consume: TicketBalance,
  source: string
) {
  const current = await computeTicketBalance(tx, userId);
  if (current.drawTicket < consume.drawTicket
    || current.draw10Ticket < consume.draw10Ticket
    || current.affixReforgeTicket < consume.affixReforgeTicket) {
    throw Object.assign(new Error('票券数量不足'), { status: 400 });
  }
  await recordLedger(tx, wallet.id, userId, 0, TICKET_LEDGER_REASON_USE, {
    source,
    drawTicket: consume.drawTicket,
    draw10Ticket: consume.draw10Ticket,
    affixReforgeTicket: consume.affixReforgeTicket
  });
  const after = cloneTicketBalance(current);
  applyTicketDelta(after, consume, -1);
  return normalizeTicketBalance(after);
}

async function loadClaimedAtMap(tx: Tx, userId: string, reason: string, keyField: 'missionKey' | 'achievementKey') {
  const rows = await tx.gachaLedgerEntry.findMany({
    where: { userId, reason },
    orderBy: { createdAt: 'asc' },
    select: { createdAt: true, metadata: true }
  });
  const map = new Map<string, string>();
  for (const row of rows) {
    const key = String(asJsonObject(row.metadata)[keyField] ?? '').trim();
    if (!key || map.has(key)) continue;
    map.set(key, row.createdAt.toISOString());
  }
  return map;
}

function buildMissionClaimCompositeKey(missionKey: string, periodKey: string) {
  return `${missionKey}::${periodKey}`;
}

async function loadMissionClaimedAtMap(tx: Tx, userId: string) {
  const rows = await tx.gachaLedgerEntry.findMany({
    where: { userId, reason: MISSION_CLAIM_REASON },
    orderBy: { createdAt: 'asc' },
    select: { createdAt: true, metadata: true }
  });
  const map = new Map<string, string>();
  for (const row of rows) {
    const metadata = asJsonObject(row.metadata);
    const missionKey = String(metadata.missionKey ?? '').trim();
    const periodKey = String(metadata.periodKey ?? '').trim();
    if (!missionKey || !periodKey) continue;
    const compositeKey = buildMissionClaimCompositeKey(missionKey, periodKey);
    if (map.has(compositeKey)) continue;
    map.set(compositeKey, row.createdAt.toISOString());
  }
  return map;
}

async function countUniqueUnlockedCards(tx: Tx, userId: string) {
  try {
    return await tx.gachaCardUnlock.count({ where: { userId } });
  } catch (error) {
    if (!isMissingTableError(error)) throw error;
    return tx.gachaInventory.count({
      where: {
        userId,
        count: { gt: 0 }
      }
    });
  }
}

async function loadUserGachaStats(tx: Tx, userId: string): Promise<UserGachaStats> {
  const [
    drawAgg, uniqueCards, goldCardsDrawn, purpleCardsDrawn,
    placementClaims, placementEarnAgg, dailyClaims,
    marketProfitAgg, marketLossRows, tradeSells,
    dismantleCount, affixReforgeCount, totalSpentAgg
  ] = await Promise.all([
    tx.gachaDraw.aggregate({
      where: { userId },
      _sum: { drawCount: true }
    }),
    countUniqueUnlockedCards(tx, userId),
    tx.gachaDrawItem.count({
      where: {
        rarity: 'GOLD',
        draw: { userId }
      }
    }),
    tx.gachaDrawItem.count({
      where: {
        rarity: 'PURPLE',
        draw: { userId }
      }
    }),
    tx.gachaLedgerEntry.count({
      where: {
        userId,
        reason: 'PLACEMENT_CLAIM'
      }
    }),
    tx.gachaLedgerEntry.aggregate({
      where: {
        userId,
        reason: 'PLACEMENT_CLAIM',
        delta: { gt: 0 }
      },
      _sum: { delta: true }
    }),
    tx.gachaLedgerEntry.count({
      where: {
        userId,
        reason: 'DAILY_CLAIM'
      }
    }),
    tx.gachaLedgerEntry.aggregate({
      where: {
        userId,
        reason: MARKET_SETTLE_REASON,
        delta: { gt: 0 }
      },
      _sum: { delta: true }
    }),
    tx.$queryRaw<Array<{ marketLoss: number | string | null }>>(Prisma.sql`
      SELECT COALESCE(
        SUM(
          CASE
            WHEN (metadata->>'pnl') ~ '^-?[0-9]+$' AND (metadata->>'pnl')::bigint < 0
              THEN ABS((metadata->>'pnl')::bigint)
            WHEN delta < 0
              THEN ABS(delta)::bigint
            ELSE 0::bigint
          END
        ),
        0
      )::bigint AS "marketLoss"
      FROM "GachaLedgerEntry"
      WHERE "userId" = ${userId}
        AND reason = ${MARKET_SETTLE_REASON}
    `),
    tx.gachaLedgerEntry.count({
      where: {
        userId,
        reason: { in: [TRADE_BUY_SPEND_REASON, TRADE_SELL_EARN_REASON] }
      }
    }),
    tx.gachaLedgerEntry.count({
      where: {
        userId,
        reason: { in: ['DISMANTLE_REWARD', 'DISMANTLE_BATCH_REWARD', 'DISMANTLE_BATCH_SELECTIVE_REWARD'] }
      }
    }),
    tx.gachaLedgerEntry.count({
      where: {
        userId,
        reason: TICKET_LEDGER_REASON_USE,
        metadata: { path: ['source'], equals: 'AFFIX_REFORGE' }
      }
    }),
    tx.gachaDraw.aggregate({
      where: { userId, tokensSpent: { gt: 0 } },
      _sum: { tokensSpent: true }
    })
  ]);
  return {
    totalDraws: drawAgg._sum.drawCount ?? 0,
    uniqueCards,
    goldCardsDrawn,
    purpleCardsDrawn,
    placementClaims,
    placementTokensEarned: Math.max(0, Number(placementEarnAgg._sum.delta ?? 0)),
    dailyClaims,
    marketProfit: Math.max(0, Number(marketProfitAgg._sum.delta ?? 0)),
    marketLoss: Math.max(0, toSafeInt(marketLossRows[0]?.marketLoss, 0)),
    tradeSells,
    dismantleCount,
    affixReforgeCount,
    totalTokensSpent: Math.max(0, totalSpentAgg._sum.tokensSpent ?? 0)
  };
}

function normalizeRewardPack(reward: RewardPack) {
  return {
    tokens: Math.max(0, toSafeInt(reward.tokens, 0)),
    tickets: normalizeTicketBalance(reward.tickets)
  };
}

type MissionProgressSnapshot = {
  missionKey: string;
  periodType: MissionPeriodType;
  periodKey: string;
  target: number;
  progress: number;
  title: string;
  description: string;
  reward: RewardPack;
};

async function loadMissionProgressSnapshots(tx: Tx, userId: string, asOf = now()): Promise<MissionProgressSnapshot[]> {
  return Promise.all(MISSION_DEFINITIONS.map(async (definition) => {
    const period = missionPeriodWindow(definition.periodType, asOf);
    let progress = 0;

    if (definition.key === DAILY_MISSION_KEY || definition.key === WEEKLY_MISSION_KEY) {
      // Token spend missions
      const [drawAgg, marketAgg] = await Promise.all([
        tx.gachaDraw.aggregate({
          where: {
            userId,
            createdAt: { gte: period.startsAt, lt: period.endsAt },
            tokensSpent: { gt: 0 }
          },
          _sum: { tokensSpent: true }
        }),
        tx.gachaLedgerEntry.aggregate({
          where: {
            userId,
            reason: MARKET_OPEN_SPEND_REASON,
            createdAt: { gte: period.startsAt, lt: period.endsAt }
          },
          _sum: { delta: true }
        })
      ]);
      progress = Math.max(0, drawAgg._sum.tokensSpent ?? 0) + Math.max(0, -(marketAgg._sum.delta ?? 0));
    } else if (definition.key === 'DAILY_DRAW_5' || definition.key === 'WEEKLY_DRAW_50') {
      // Draw count missions (10-draw = 10 counts)
      const drawAgg = await tx.gachaDraw.aggregate({
        where: {
          userId,
          createdAt: { gte: period.startsAt, lt: period.endsAt }
        },
        _sum: { drawCount: true }
      });
      progress = drawAgg._sum.drawCount ?? 0;
    } else if (definition.key === 'DAILY_CLAIM_PLACEMENT') {
      // Daily placement claim count
      const claimCount = await tx.gachaLedgerEntry.count({
        where: {
          userId,
          reason: 'PLACEMENT_CLAIM',
          createdAt: { gte: period.startsAt, lt: period.endsAt }
        }
      });
      progress = claimCount;
    } else if (definition.key === 'WEEKLY_COLLECT_3') {
      // Weekly new card unlock count
      try {
        const unlockCount = await tx.gachaCardUnlock.count({
          where: {
            userId,
            firstUnlockedAt: { gte: period.startsAt, lt: period.endsAt }
          }
        });
        progress = unlockCount;
      } catch {
        progress = 0;
      }
    } else if (definition.key === 'WEEKLY_TRADE_1') {
      // Weekly completed trade count
      const tradeCount = await tx.gachaLedgerEntry.count({
        where: {
          userId,
          reason: { in: [TRADE_BUY_SPEND_REASON, TRADE_SELL_EARN_REASON] },
          createdAt: { gte: period.startsAt, lt: period.endsAt }
        }
      });
      progress = tradeCount;
    } else if (definition.key === 'WEEKLY_DISMANTLE_5') {
      // Weekly dismantle count
      const dismantleCount = await tx.gachaLedgerEntry.count({
        where: {
          userId,
          reason: { in: ['DISMANTLE_REWARD', 'DISMANTLE_BATCH_REWARD', 'DISMANTLE_BATCH_SELECTIVE_REWARD'] },
          createdAt: { gte: period.startsAt, lt: period.endsAt }
        }
      });
      progress = dismantleCount;
    }

    return {
      missionKey: definition.key,
      periodType: definition.periodType,
      periodKey: period.periodKey,
      target: definition.target,
      progress,
      title: definition.title,
      description: definition.description,
      reward: definition.reward
    };
  }));
}

function buildMissionItems(snapshots: MissionProgressSnapshot[], claimedMap: Map<string, string>) {
  return snapshots.map((snapshot) => {
    const claimedAt = claimedMap.get(buildMissionClaimCompositeKey(snapshot.missionKey, snapshot.periodKey)) ?? null;
    const progress = Math.max(0, snapshot.progress);
    const reward = normalizeRewardPack(snapshot.reward);
    return {
      missionKey: snapshot.missionKey,
      periodType: snapshot.periodType,
      periodKey: snapshot.periodKey,
      title: snapshot.title,
      description: snapshot.description,
      target: snapshot.target,
      progress,
      claimable: progress >= snapshot.target && !claimedAt,
      claimed: Boolean(claimedAt),
      claimedAt,
      reward
    };
  });
}

function buildAchievementItems(stats: UserGachaStats, claimedMap: Map<string, string>) {
  return ACHIEVEMENT_DEFINITIONS.map((definition) => {
    const progress = Math.max(0, definition.metric(stats));
    const claimedAt = claimedMap.get(definition.key) ?? null;
    const reward = normalizeRewardPack(definition.reward);
    const hidden = definition.hidden ?? false;
    return {
      achievementKey: definition.key,
      title: hidden && progress <= 0 && !claimedAt ? '???' : definition.title,
      description: hidden && progress <= 0 && !claimedAt ? '隐藏成就，达成条件后揭晓' : definition.description,
      target: definition.target,
      progress,
      claimable: progress >= definition.target && !claimedAt,
      claimed: Boolean(claimedAt),
      claimedAt,
      reward,
      hidden
    };
  });
}

async function applyRewardPack(
  tx: Tx,
  wallet: Prisma.GachaWalletGetPayload<{}>,
  userId: string,
  reward: RewardPack,
  source: string,
  sourceKey: string
) {
  const normalized = normalizeRewardPack(reward);
  let nextWallet = wallet;
  if (normalized.tokens > 0) {
    nextWallet = await applyWalletDelta(
      tx,
      nextWallet,
      normalized.tokens,
      `${source}_TOKEN`,
      { source, sourceKey, rewardType: 'tokens' }
    );
  }
  await grantTicketBalance(tx, nextWallet, userId, normalized.tickets, source, sourceKey);
  return {
    wallet: nextWallet,
    reward: normalized
  };
}

async function safeUpsertCardUnlock(tx: Tx, userId: string, cardId: string) {
  try {
    await tx.gachaCardUnlock.upsert({
      where: {
        userId_cardId: {
          userId,
          cardId
        }
      },
      create: {
        userId,
        cardId
      },
      update: {}
    });
  } catch (error) {
    if (!isMissingTableError(error)) {
      throw error;
    }
  }
}

const MAX_QUERY_IN_CARD_IDS = 15_000;

function chunkStringArray(values: string[], chunkSize: number) {
  const result: string[][] = [];
  for (let index = 0; index < values.length; index += chunkSize) {
    result.push(values.slice(index, index + chunkSize));
  }
  return result;
}

async function loadOwnedCardIdsWithFallback(
  tx: typeof prisma | Tx,
  userId: string,
  options: { cardIds?: string[]; poolId?: string }
) {
  const poolId = typeof options.poolId === 'string' ? options.poolId.trim() : '';
  const cardIds = options.cardIds ?? [];
  if (!poolId && cardIds.length === 0) return new Set<string>();

  if (poolId) {
    try {
      const unlocks = await tx.gachaCardUnlock.findMany({
        where: {
          userId,
          card: {
            is: { poolId }
          }
        },
        select: { cardId: true }
      });
      return new Set(unlocks.map((item) => item.cardId));
    } catch (error) {
      if (!isMissingTableError(error)) {
        throw error;
      }
      const inventory = await tx.gachaInventory.findMany({
        where: {
          userId,
          count: { gt: 0 },
          card: {
            is: { poolId }
          }
        },
        select: { cardId: true }
      });
      return new Set(inventory.map((item) => item.cardId));
    }
  }

  try {
    const owned = new Set<string>();
    const chunks = chunkStringArray(cardIds, MAX_QUERY_IN_CARD_IDS);
    for (const chunk of chunks) {
      // eslint-disable-next-line no-await-in-loop
      const unlocks = await tx.gachaCardUnlock.findMany({
        where: {
          userId,
          cardId: { in: chunk }
        },
        select: { cardId: true }
      });
      for (const item of unlocks) {
        owned.add(item.cardId);
      }
    }
    return owned;
  } catch (error) {
    if (!isMissingTableError(error)) {
      throw error;
    }
    const owned = new Set<string>();
    const chunks = chunkStringArray(cardIds, MAX_QUERY_IN_CARD_IDS);
    for (const chunk of chunks) {
      // eslint-disable-next-line no-await-in-loop
      const inventory = await tx.gachaInventory.findMany({
        where: {
          userId,
          cardId: { in: chunk },
          count: { gt: 0 }
        },
        select: { cardId: true }
      });
      for (const item of inventory) {
        owned.add(item.cardId);
      }
    }
    return owned;
  }
}

async function listMarketLedgerEntries(tx: Tx | typeof prisma, userId: string, asOf = now()) {
  const since = new Date(asOf.getTime() - MARKET_USER_LEDGER_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  return tx.gachaLedgerEntry.findMany({
    where: {
      userId,
      reason: { in: [MARKET_OPEN_REASON, MARKET_SETTLE_REASON] },
      createdAt: { gte: since }
    },
    orderBy: { createdAt: 'asc' },
    select: {
      createdAt: true,
      reason: true,
      metadata: true
    }
  });
}

type GlobalActiveMarketPosition = {
  userId: string;
  positionId: string;
  contractId: string;
  category: MarketCategory | null;
  side: MarketPositionSide;
  lockTier: MarketLockTier;
  lots: number;
  margin: number;
};

async function loadGlobalMarketOpenPositions(tx: typeof prisma | Tx, asOf = now()) {
  const nearRealtime = Math.abs(Date.now() - asOf.getTime()) <= 120_000;
  if (
    nearRealtime
    && globalMarketPositionCache
    && Date.now() - globalMarketPositionCache.fetchedAt <= MARKET_GLOBAL_POSITION_CACHE_TTL_MS
  ) {
    return globalMarketPositionCache.items;
  }
  const since = new Date(asOf.getTime() - MARKET_GLOBAL_POSITION_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  const entries = await tx.gachaLedgerEntry.findMany({
    where: {
      reason: { in: [MARKET_OPEN_REASON, MARKET_SETTLE_REASON] },
      createdAt: { gte: since }
    },
    orderBy: { createdAt: 'asc' },
    select: {
      userId: true,
      createdAt: true,
      reason: true,
      metadata: true
    }
  });
  const openMap = new Map<string, GlobalActiveMarketPosition>();
  const settledSet = new Set<string>();
  for (const entry of entries) {
    if (entry.reason === MARKET_OPEN_REASON) {
      const parsed = parseMarketOpenPosition(entry.metadata, entry.createdAt);
      if (!parsed) continue;
      const contract = resolveMarketContract(parsed.contractId);
      openMap.set(parsed.positionId, {
        userId: entry.userId,
        positionId: parsed.positionId,
        contractId: parsed.contractId,
        category: contract?.category ?? null,
        side: parsed.side,
        lockTier: parsed.lockTier,
        lots: parsed.lots,
        margin: parsed.margin
      });
      continue;
    }
    if (entry.reason === MARKET_SETTLE_REASON) {
      const parsed = parseMarketSettlement(entry.metadata, entry.createdAt);
      if (!parsed) continue;
      settledSet.add(parsed.positionId);
    }
  }
  const items = Array.from(openMap.values()).filter((item) => !settledSet.has(item.positionId));
  if (nearRealtime) {
    globalMarketPositionCache = {
      fetchedAt: Date.now(),
      asOfTs: asOf,
      items
    };
  }
  return items;
}

async function computeMarketState(tx: Tx, userId: string, context: MarketOracleContext, asOf = now()) {
  const entries = await listMarketLedgerEntries(tx, userId, asOf);
  const openMap = new Map<string, MarketOpenPosition>();
  const settlementMap = new Map<string, MarketSettlementRecord>();
  for (const entry of entries) {
    if (entry.reason === MARKET_OPEN_REASON) {
      const parsed = parseMarketOpenPosition(entry.metadata, entry.createdAt);
      if (!parsed) continue;
      openMap.set(parsed.positionId, parsed);
      continue;
    }
    if (entry.reason === MARKET_SETTLE_REASON) {
      const parsed = parseMarketSettlement(entry.metadata, entry.createdAt);
      if (!parsed) continue;
      settlementMap.set(parsed.positionId, parsed);
    }
  }
  const active = Array.from(openMap.values())
    .filter((position) => !settlementMap.has(position.positionId))
    .map((position) => {
      const contract = resolveMarketContract(position.contractId);
      const currentIndex = contract ? (marketPriceAt(contract, asOf, context) ?? position.entryIndex) : position.entryIndex;
      const currentEquity = marketCalcEquity(
        position.margin,
        position.side,
        position.leverage,
        position.entryIndex,
        currentIndex
      );
      const costBasis = Math.max(1, position.margin + Math.max(0, position.openFee));
      const unrealizedPnl = Math.floor(currentEquity - position.margin - Math.max(0, position.openFee));
      const expireAt = toDate(position.expireAt);
      const status: MarketPositionStatus = expireAt && expireAt.getTime() <= asOf.getTime() ? 'EXPIRED' : 'OPEN';
      return {
        ...position,
        status,
        currentIndex,
        currentPrice: currentIndex,
        unrealizedPnl,
        unrealizedRoi: Number((unrealizedPnl / costBasis).toFixed(4))
      };
    });
  const history = Array.from(settlementMap.values()).sort((a, b) => (
    new Date(b.settledAt).getTime() - new Date(a.settledAt).getTime()
  ));
  return { active, history };
}

async function settleDueMarketPositions(
  tx: Tx,
  userId: string,
  wallet: Prisma.GachaWalletGetPayload<{}>,
  context: MarketOracleContext,
  asOf = now()
) {
  const state = await computeMarketState(tx, userId, context, asOf);
  let currentWallet = wallet;
  const settlements: MarketSettlementRecord[] = [];
  const remainingActive: typeof state.active = [];

  for (const position of state.active) {
    const contract = resolveMarketContract(position.contractId);
    if (!contract) continue;
    const expireAt = toDate(position.expireAt);

    let status: MarketPositionStatus | null = null;
    let settleTickTs = asOf;
    let settleIndex = INDEX_BASE;
    let liquidatedAt: string | null = null;

    // Expired positions must settle at IndexPriceAtOrBefore(expireAt),
    // and should not be overridden by current-time equity checks.
    if (expireAt && expireAt.getTime() <= asOf.getTime()) {
      let expireTick = marketTickAt(contract, expireAt, context);
      if (!expireTick) {
        // expireAt may be older than the oracle tick window. Use the earliest
        // available tick as an approximation to avoid permanent limbo. The tick
        // may be after expireAt if the oracle window has rolled past, but locking
        // a user's margin forever is worse than settling on a nearby price.
        const categoryTicks = context.byCategory[contract.category] ?? [];
        const earliest = categoryTicks.length > 0 ? categoryTicks[0]! : null;
        if (!earliest) {
          console.warn(`[market-settle] ⚠️ No ticks at all for ${contract.category}, skipping position ${position.positionId}`);
          remainingActive.push(position);
          continue;
        }
        expireTick = earliest;
        const isApproximate = earliest.asOfTs.getTime() > expireAt.getTime();
        console.warn(`[market-settle] ⚠️ No tick for ${contract.category} at expireAt=${expireAt.toISOString()}, using ${isApproximate ? 'approximate post-expiry' : 'earliest'} tick at ${expireTick.asOfTs.toISOString()}`);
      }
      settleTickTs = expireTick.asOfTs;
      settleIndex = Number(expireTick.indexMark);
      const expireEquity = marketCalcEquity(
        position.margin,
        position.side,
        position.leverage,
        position.entryIndex,
        settleIndex
      );
      if (expireEquity <= 0) {
        status = 'LIQUIDATED';
        liquidatedAt = settleTickTs.toISOString();
      } else {
        status = 'SETTLED';
      }
    } else {
      const currentTick = marketTickAt(contract, asOf, context);
      if (!currentTick) {
        // No tick available — do NOT settle/liquidate with INDEX_BASE fallback.
        // Keep position active and let next cycle retry with fresh ticks.
        remainingActive.push(position);
        continue;
      }
      settleTickTs = currentTick.asOfTs;
      settleIndex = Number(currentTick.indexMark);
      const currentEquity = marketCalcEquity(
        position.margin,
        position.side,
        position.leverage,
        position.entryIndex,
        settleIndex
      );
      if (currentEquity <= 0) {
        status = 'LIQUIDATED';
        liquidatedAt = settleTickTs.toISOString();
      }
    }

    if (!status) {
      remainingActive.push(position);
      continue;
    }

    const tier = MARKET_LOCK_TIER_CONFIG[position.lockTier];
    const settleEquity = status === 'LIQUIDATED'
      ? 0
      : Math.max(0, marketCalcEquity(position.margin, position.side, position.leverage, position.entryIndex, settleIndex));
    const profit = Math.max(0, settleEquity - position.margin);
    const settleFee = status === 'LIQUIDATED' ? 0 : Math.floor(profit * tier.settleFeeRate);
    const payout = status === 'LIQUIDATED' ? 0 : Math.max(0, Math.floor(settleEquity - settleFee));
    const pnl = payout - position.margin - Math.max(0, position.openFee);
    const settlementMetadata: Prisma.JsonObject = {
      positionId: position.positionId,
      contractId: position.contractId,
      side: position.side,
      status,
      lockTier: position.lockTier,
      lots: position.lots,
      margin: position.margin,
      stake: position.margin,
      openFee: position.openFee,
      leverage: position.leverage,
      entryIndex: position.entryIndex,
      entryPrice: position.entryIndex,
      entryTickTs: position.entryTickTs,
      settleIndex,
      exitPrice: settleIndex,
      settleFee,
      payout,
      pnl,
      expireAt: position.expireAt,
      liquidatedAt,
      settledAt: asOf.toISOString(),
      settleTickTs: settleTickTs.toISOString()
    };
    if (payout > 0) {
      currentWallet = await applyWalletDelta(tx, currentWallet, payout, MARKET_SETTLE_REASON, settlementMetadata);
    } else {
      await recordLedger(tx, currentWallet.id, userId, 0, MARKET_SETTLE_REASON, settlementMetadata);
    }
    settlements.push({
      positionId: position.positionId,
      contractId: position.contractId,
      side: position.side,
      status,
      lockTier: position.lockTier,
      lots: position.lots,
      margin: position.margin,
      stake: position.margin,
      openFee: position.openFee,
      leverage: position.leverage,
      entryIndex: position.entryIndex,
      entryPrice: position.entryIndex,
      settleIndex,
      exitPrice: settleIndex,
      settleFee,
      payout,
      pnl,
      expireAt: position.expireAt,
      liquidatedAt,
      settledAt: asOf.toISOString()
    });
  }

  if (settlements.length > 0) {
    invalidateGlobalMarketPositionCache();
  }

  const nextHistory = [...settlements, ...state.history].sort((a, b) => (
    new Date(b.settledAt).getTime() - new Date(a.settledAt).getTime()
  ));

  return {
    wallet: currentWallet,
    settlements,
    state: {
      active: remainingActive,
      history: nextHistory
    }
  };
}

function normalizeJsonValue(value: unknown): Prisma.JsonValue {
  if (value == null) return null;
  if (Array.isArray(value)) {
    return value.map((item) => normalizeJsonValue(item));
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  const valueType = typeof value;
  if (valueType === 'string' || valueType === 'number' || valueType === 'boolean') {
    return value as Prisma.JsonValue;
  }
  if (valueType === 'object') {
    const output: Record<string, Prisma.JsonValue> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (item === undefined) continue;
      output[key] = normalizeJsonValue(item);
    }
    return output;
  }
  return String(value);
}

function hashRequestPayload(payload: unknown) {
  const normalized = normalizeJsonValue(payload);
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

function resolveIdempotencyPath(req: Request) {
  const path = `${req.baseUrl ?? ''}${req.path ?? ''}`;
  if (path) return path;
  if (req.originalUrl) return req.originalUrl.split('?')[0] ?? req.originalUrl;
  return '/';
}

function parseIdempotencyKey(req: Request) {
  const raw = req.get('x-idempotency-key');
  const value = raw?.trim() ?? '';
  if (!value || value.length > 64) {
    throw Object.assign(new Error('缺少或无效的 X-Idempotency-Key'), { status: 400 });
  }
  return value;
}

async function listPlacementSlots(tx: Tx, userId: string) {
  return tx.gachaPlacementSlot.findMany({
    where: {
      userId,
      slotIndex: { gte: 1 }
    },
    orderBy: { slotIndex: 'asc' },
    include: { card: true, instance: { select: { isLocked: true } } }
  });
}

async function listPlacementAddons(tx: Tx, userId: string) {
  const rows = await tx.gachaPlacementSlot.findMany({
    where: {
      userId,
      slotIndex: 0
    },
    include: { card: true, instance: { select: { isLocked: true } } }
  });
  return rows
    .filter((row) => Boolean(row.cardId && row.card))
    .map((row) => ({
      id: row.id,
      userId: row.userId,
      kind: PLACEMENT_COLORLESS_ADDON_KIND,
      cardId: row.cardId!,
      affixVisualStyle: normalizeAffixVisualStyleInput(row.affixVisualStyle),
      affixSignature: row.affixSignature,
      affixLabel: row.affixLabel,
      inventoryId: row.inventoryId,
      assignedAt: row.assignedAt ?? row.updatedAt,
      card: row.card,
      isLocked: row.instance?.isLocked ?? false
    }));
}

async function ensurePlacementStateAndSlots(tx: Tx, userId: string) {
  let state = await tx.gachaPlacementState.upsert({
    where: { userId },
    create: {
      userId,
      unlockedSlotCount: PLACEMENT_SLOT_COUNT_DEFAULT,
      pendingToken: toPlacementDecimal(0),
      lastAccrualAt: now()
    },
    update: {}
  });
  const normalizedUnlockedCount = normalizedPlacementUnlockedSlotCount(state);
  if (normalizedUnlockedCount !== state.unlockedSlotCount) {
    state = await tx.gachaPlacementState.update({
      where: { id: state.id },
      data: { unlockedSlotCount: normalizedUnlockedCount }
    });
  }
  const currentSlots = await tx.gachaPlacementSlot.findMany({
    where: { userId },
    orderBy: { slotIndex: 'asc' }
  });
  const existingIndexes = new Set(currentSlots.map((slot) => slot.slotIndex));
  const createData: Prisma.GachaPlacementSlotCreateManyInput[] = [];
  if (!existingIndexes.has(0)) {
    createData.push({ userId, slotIndex: 0 });
  }
  for (let slotIndex = 1; slotIndex <= PLACEMENT_SLOT_COUNT_MAX; slotIndex += 1) {
    if (existingIndexes.has(slotIndex)) continue;
    createData.push({ userId, slotIndex });
  }
  if (createData.length > 0) {
    await tx.gachaPlacementSlot.createMany({
      data: createData,
      skipDuplicates: true
    });
  }
  const legacySlots = await tx.gachaPlacementSlot.findMany({
    where: {
      userId,
      cardId: { not: null },
      OR: [
        { affixVisualStyle: null },
        { affixSignature: null }
      ]
    },
    include: { card: true }
  });
  for (const slot of legacySlots) {
    if (!slot.card) continue;
    const legacyAffix = resolveCardAffix(slot.card);
    // eslint-disable-next-line no-await-in-loop
    await tx.gachaPlacementSlot.update({
      where: { id: slot.id },
      data: {
        affixVisualStyle: legacyAffix.affixVisualStyle as PrismaAffixVisualStyle,
        affixSignature: legacyAffix.affixSignature,
        affixLabel: legacyAffix.affixLabel,
        // Backfill assignedAt for legacy placed cards to prevent dismantle bypass
        assignedAt: slot.assignedAt ?? slot.updatedAt ?? now()
      }
    });
  }
  const slots = await listPlacementSlots(tx, userId);
  const addons = await listPlacementAddons(tx, userId);
  return { state, slots, addons };
}

function normalizedPlacementUnlockedSlotCount(state: PlacementState) {
  const raw = Math.max(0, Math.floor(Number(state.unlockedSlotCount) || 0));
  if (raw <= 0) return PLACEMENT_SLOT_COUNT_DEFAULT;
  return Math.max(PLACEMENT_SLOT_COUNT_DEFAULT, Math.min(PLACEMENT_SLOT_COUNT_MAX, raw));
}

function nextPlacementSlotUnlockCost(unlockedSlotCount: number) {
  const normalized = Math.max(PLACEMENT_SLOT_COUNT_DEFAULT, Math.min(PLACEMENT_SLOT_COUNT_MAX, Math.floor(unlockedSlotCount)));
  const nextIndex = normalized - PLACEMENT_SLOT_COUNT_DEFAULT;
  return PLACEMENT_SLOT_UNLOCK_COSTS[nextIndex] ?? null;
}

function activePlacementSlots(slots: PlacementSlotWithCard[], unlockedSlotCount: number) {
  return slots.filter((slot) => slot.slotIndex >= 1 && slot.slotIndex <= unlockedSlotCount);
}

function computePlacementMetrics(
  userId: string,
  state: PlacementState,
  slots: PlacementSlotWithCard[],
  addons: PlacementAddonWithCard[]
): PlacementMetrics {
  const unlockedSlotCount = normalizedPlacementUnlockedSlotCount(state);
  const scopedSlots = activePlacementSlots(slots, unlockedSlotCount);
  const slotAffixMap = resolvePlacementSlotAffixMap(scopedSlots);
  const activeColorlessAddons = resolvePlacementActiveColorlessAddons(addons);
  const yieldBoost = resolvePlacementYieldBoost(userId, scopedSlots, slotAffixMap, activeColorlessAddons);
  const offlineBuffer = resolvePlacementOfflineBufferBonus(userId, slotAffixMap, activeColorlessAddons);
  const cap = getPlacementBufferCap(offlineBuffer.offlineBufferBonus);
  const slotBaseYieldPerHour = placementRound(
    scopedSlots.reduce((sum, slot) => sum + getPlacementSlotYieldPerHour(slot.card, 0), 0)
  );
  const slotEstimatedYieldPerHour = placementRound(
    scopedSlots.reduce((sum, slot) => sum + getPlacementSlotYieldPerHour(slot.card, yieldBoost.yieldBoostPercent), 0)
  );
  const addonBaseYieldPerHour = placementRound(
    activeColorlessAddons.reduce((sum, addon) => sum + getPlacementAddonYieldPerHour(addon.card, 0), 0)
  );
  const addonYieldPerHour = placementRound(
    activeColorlessAddons.reduce((sum, addon) => sum + getPlacementAddonYieldPerHour(addon.card, yieldBoost.yieldBoostPercent), 0)
  );
  const baseYieldPerHour = placementRound(slotBaseYieldPerHour + addonBaseYieldPerHour);

  // --- ANCHOR flat yield: sum up ANCHOR layers × rarity flat rate ---
  let anchorFlatYieldPerHour = 0;
  for (const slot of scopedSlots) {
    if (!slot.card) continue;
    const affix = slotAffixMap.get(slot.slotIndex);
    if (!affix) continue;
    const anchorLayers = Math.max(0, Math.floor(affix.affixStyleCounts.ANCHOR ?? 0));
    if (anchorLayers > 0) {
      anchorFlatYieldPerHour += (PLACEMENT_ANCHOR_FLAT_YIELD_BY_RARITY[slot.card.rarity] ?? 0) * anchorLayers;
    }
  }
  for (const addon of activeColorlessAddons) {
    const anchorLayers = Math.max(0, Math.floor(addon.affix.affixStyleCounts.ANCHOR ?? 0));
    if (anchorLayers > 0) {
      anchorFlatYieldPerHour += (PLACEMENT_ANCHOR_FLAT_YIELD_BY_RARITY[addon.card.rarity] ?? 0) * anchorLayers;
    }
  }
  anchorFlatYieldPerHour = placementRound(anchorFlatYieldPerHour);

  // --- FLUX dynamic yield: base × layers × (1 + scale × comboCount) ---
  const comboCount = yieldBoost.comboBonuses.length;
  let fluxDynamicYieldPerHour = 0;
  for (const slot of scopedSlots) {
    if (!slot.card) continue;
    const affix = slotAffixMap.get(slot.slotIndex);
    if (!affix) continue;
    const fluxLayers = Math.max(0, Math.floor(affix.affixStyleCounts.FLUX ?? 0));
    if (fluxLayers > 0) {
      fluxDynamicYieldPerHour += (PLACEMENT_FLUX_YIELD_BASE_BY_RARITY[slot.card.rarity] ?? 0) * fluxLayers;
    }
  }
  for (const addon of activeColorlessAddons) {
    const fluxLayers = Math.max(0, Math.floor(addon.affix.affixStyleCounts.FLUX ?? 0));
    if (fluxLayers > 0) {
      fluxDynamicYieldPerHour += (PLACEMENT_FLUX_YIELD_BASE_BY_RARITY[addon.card.rarity] ?? 0) * fluxLayers;
    }
  }
  fluxDynamicYieldPerHour = placementRound(fluxDynamicYieldPerHour * (1 + PLACEMENT_FLUX_SCALE_PER_COMBO * comboCount));

  const normalEstimatedYieldPerHour = placementRound(slotEstimatedYieldPerHour + addonYieldPerHour);
  const estimatedYieldPerHour = placementRound(normalEstimatedYieldPerHour + anchorFlatYieldPerHour + fluxDynamicYieldPerHour);
  const pendingToken = clampPlacementToken(placementDecimalToNumber(state.pendingToken), cap);
  return {
    unlockedSlotCount,
    slotMaxCount: PLACEMENT_SLOT_COUNT_MAX,
    nextUnlockCost: nextPlacementSlotUnlockCost(unlockedSlotCount),
    cap,
    pendingToken,
    claimableToken: Math.floor(pendingToken),
    baseYieldPerHour,
    addonYieldPerHour,
    estimatedYieldPerHour,
    yieldBoostPercent: yieldBoost.yieldBoostPercent,
    yieldBoostPercentRaw: yieldBoost.yieldBoostPercentRaw,
    yieldBoostCapped: yieldBoost.yieldBoostCapped,
    baseYieldBoostPercent: yieldBoost.baseYieldBoostPercent,
    affixYieldBoostPercent: yieldBoost.affixYieldBoostPercent,
    comboYieldBoostPercent: yieldBoost.comboYieldBoostPercent,
    offlineBufferBonus: offlineBuffer.offlineBufferBonus,
    offlineBufferBonusRaw: offlineBuffer.offlineBufferBonusRaw,
    offlineBufferCapped: offlineBuffer.offlineBufferCapped,
    baseOfflineBufferBonus: offlineBuffer.baseOfflineBufferBonus,
    affixOfflineBufferBonus: offlineBuffer.affixOfflineBufferBonus,
    comboBonuses: yieldBoost.comboBonuses.map((bonus) => ({
      ...bonus,
      yieldBoostPercent: placementRound(bonus.yieldBoostPercent)
    })),
    anchorFlatYieldPerHour,
    fluxDynamicYieldPerHour
  };
}

async function accruePlacementPending(
  tx: Tx,
  options: {
    userId: string;
    state: PlacementState;
    slots: PlacementSlotWithCard[];
    addons: PlacementAddonWithCard[];
    asOf: Date;
  }
) {
  const metrics = computePlacementMetrics(options.userId, options.state, options.slots, options.addons);
  const elapsedMs = Math.max(0, options.asOf.getTime() - options.state.lastAccrualAt.getTime());
  const elapsedHours = elapsedMs / 3_600_000;
  let nextPending = metrics.pendingToken;
  if (elapsedHours > 0 && metrics.estimatedYieldPerHour > 0 && metrics.pendingToken < metrics.cap) {
    nextPending = clampPlacementToken(
      metrics.pendingToken + metrics.estimatedYieldPerHour * elapsedHours,
      metrics.cap
    );
  }

  const shouldUpdatePending = Math.abs(nextPending - metrics.pendingToken) >= PLACEMENT_EPSILON;
  const shouldUpdateLastAccrualAt = elapsedMs > 0;
  if (!shouldUpdatePending && !shouldUpdateLastAccrualAt) {
    return options.state;
  }

  const data: Prisma.GachaPlacementStateUpdateInput = {};
  if (shouldUpdatePending) {
    data.pendingToken = toPlacementDecimal(nextPending);
  }
  if (shouldUpdateLastAccrualAt) {
    data.lastAccrualAt = options.asOf;
  }
  return tx.gachaPlacementState.update({
    where: { id: options.state.id },
    data
  });
}

function serializePlacement(
  userId: string,
  state: PlacementState,
  slots: PlacementSlotWithCard[],
  addons: PlacementAddonWithCard[]
) {
  const metrics = computePlacementMetrics(userId, state, slots, addons);
  const scopedSlots = activePlacementSlots(slots, metrics.unlockedSlotCount);
  const slotAffixMap = resolvePlacementSlotAffixMap(scopedSlots);
  const activeColorlessAddons = resolvePlacementActiveColorlessAddons(addons);
  return {
    slotCount: metrics.unlockedSlotCount,
    slotMaxCount: metrics.slotMaxCount,
    nextUnlockCost: metrics.nextUnlockCost,
    cap: metrics.cap,
    offlineBufferBonus: metrics.offlineBufferBonus,
    offlineBufferBonusRaw: metrics.offlineBufferBonusRaw,
    offlineBufferCapped: metrics.offlineBufferCapped,
    baseOfflineBufferBonus: metrics.baseOfflineBufferBonus,
    affixOfflineBufferBonus: metrics.affixOfflineBufferBonus,
    pendingToken: metrics.pendingToken,
    claimableToken: metrics.claimableToken,
    baseYieldPerHour: metrics.baseYieldPerHour,
    addonYieldPerHour: metrics.addonYieldPerHour,
    estimatedYieldPerHour: metrics.estimatedYieldPerHour,
    yieldBoostPercent: metrics.yieldBoostPercent,
    yieldBoostPercentRaw: metrics.yieldBoostPercentRaw,
    yieldBoostCapped: metrics.yieldBoostCapped,
    baseYieldBoostPercent: metrics.baseYieldBoostPercent,
    affixYieldBoostPercent: metrics.affixYieldBoostPercent,
    comboYieldBoostPercent: metrics.comboYieldBoostPercent,
    comboBonuses: metrics.comboBonuses,
    anchorFlatYieldPerHour: metrics.anchorFlatYieldPerHour,
    fluxDynamicYieldPerHour: metrics.fluxDynamicYieldPerHour,
    lastAccrualAt: state.lastAccrualAt.toISOString(),
    addons: activeColorlessAddons.map(({ addon, card, affix }) => ({
      kind: addon.kind,
      ratio: PLACEMENT_COLORLESS_ADDON_RATIO,
      assignedAt: addon.assignedAt.toISOString(),
      yieldPerHour: getPlacementAddonYieldPerHour(card, metrics.yieldBoostPercent),
      card: {
        ...serializeCardSummary(card),
        poolId: card.poolId,
        isLocked: addon.isLocked,
        affixSignature: affix.affixSignature,
        affixStyles: affix.affixStyles,
        affixStyleCounts: affix.affixStyleCounts,
        affixVisualStyle: affix.affixVisualStyle,
        affixLabel: affix.affixLabel,
        affixYieldBoostPercent: placementRound(affix.affixYieldBoostPercent),
        affixOfflineBufferBonus: Math.max(0, Math.floor(affix.affixOfflineBufferBonus)),
        affixDismantleBonusPercent: placementRound(affix.affixDismantleBonusPercent)
      }
    })),
    slots: scopedSlots.map((slot) => ({
      slotIndex: slot.slotIndex,
      assignedAt: slot.assignedAt?.toISOString() ?? null,
      yieldPerHour: getPlacementSlotYieldPerHour(slot.card, metrics.yieldBoostPercent),
      card: slot.card
        ? (() => {
          const affix = slotAffixMap.get(slot.slotIndex)
            ?? (() => {
              const resolved = resolveCardAffixWithBonus(slot.card!);
              return {
                affixVisualStyle: resolved.affixVisualStyle,
                affixSignature: resolved.affixSignature,
                affixStyles: resolved.affixStyles,
                affixStyleCounts: resolved.affixStyleCounts,
                affixLabel: resolved.affixLabel,
                yieldBoostPercent: resolved.affixYieldBoostPercent,
                offlineBufferBonus: resolved.affixOfflineBufferBonus,
                dismantleBonusPercent: resolved.affixDismantleBonusPercent
              };
            })();
          return {
            ...serializeCardSummary(slot.card),
            poolId: slot.card.poolId,
            isLocked: slot.instance?.isLocked ?? false,
            affixSignature: affix.affixSignature,
            affixStyles: affix.affixStyles,
            affixStyleCounts: affix.affixStyleCounts,
            affixVisualStyle: affix.affixVisualStyle,
            affixLabel: affix.affixLabel,
            affixYieldBoostPercent: placementRound(affix.yieldBoostPercent),
            affixOfflineBufferBonus: Math.max(0, Math.floor(affix.offlineBufferBonus)),
            affixDismantleBonusPercent: placementRound(affix.dismantleBonusPercent)
          };
        })()
        : null
    }))
  };
}

function featureStatusPayload() {
  return {
    timezone: 'UTC+8',
    poolMode: 'single_permanent',
    drawTokenCost: FIXED_DRAW_TOKEN_COST,
    tenDrawTokenCost: FIXED_TEN_DRAW_TOKEN_COST,
    features: FEATURE_FLAGS,
    notes: {
      draw: `抽卡支持双保底：${PURPLE_PITY_THRESHOLD} 抽内至少 1 张紫色及以上，${GOLD_PITY_THRESHOLD} 抽内至少 1 张金色`,
      tickets: '票券可用于免费单抽/十连与异画改造',
      placement: '放置默认 5 槽位并可逐步解锁至 10 槽 + 无色词条槽',
      missions: '任务按 UTC+8 日/周累计消耗统计：抽卡 Token + 开仓消耗',
      achievements: '成就用于记录长期里程碑并提供一次性奖励',
      market: '市场按 OVERALL/TRANSLATION/SCP/TALE/GOI/图书馆 六大类展示，小时级 tick，支持 T1/T7/T15/T30 锁仓开仓',
      trade: '卡片集换市场（用户间上架与购买）',
      buyRequest: '求购系统（买方发布需求，卖方接受）'
    }
  };
}

function respondFeatureNotReady(res: Response, feature: keyof typeof FEATURE_FLAGS) {
  res.status(503).json({
    error: 'feature_not_ready',
    feature,
    ...featureStatusPayload()
  });
}

function ensureFeatureEnabled(res: Response, feature: keyof typeof FEATURE_FLAGS) {
  if (FEATURE_FLAGS[feature]) return true;
  respondFeatureNotReady(res, feature);
  return false;
}

function resolveFeatureByPath(pathname: string): keyof typeof FEATURE_FLAGS | null {
  const path = pathname.trim();
  if (!path) return null;
  if (path.startsWith('/market')) return 'market';
  if (path.startsWith('/trade')) return 'trade';
  if (path.startsWith('/placement')) return 'placement';
  if (path.startsWith('/tickets')) return 'tickets';
  if (path.startsWith('/missions')) return 'missions';
  if (path.startsWith('/achievements')) return 'achievements';
  if (path.startsWith('/album') || path.startsWith('/inventory') || path.startsWith('/progress')) return 'album';
  if (
    path.startsWith('/draw')
    || path.startsWith('/dismantle')
    || path.startsWith('/history')
    || path === '/claim-daily'
  ) {
    return 'draw';
  }
  return null;
}

function buildIdempotencyScope(req: Request, userId: string): IdempotencyScope {
  return {
    userId,
    method: req.method.toUpperCase(),
    path: resolveIdempotencyPath(req),
    idemKey: parseIdempotencyKey(req),
    requestHash: hashRequestPayload(req.body ?? {})
  };
}

function mapIdempotencyReplay(record: {
  statusCode: number;
  responseJson: Prisma.JsonValue;
}): IdempotencyOutcome {
  return {
    statusCode: record.statusCode,
    responseJson: (record.responseJson ?? {}) as Record<string, unknown>
  };
}

async function replayIdempotencyRecord(scope: IdempotencyScope) {
  const record = await prisma.apiIdempotencyRecord.findUnique({
    where: {
      userId_method_path_idemKey: {
        userId: scope.userId,
        method: scope.method,
        path: scope.path,
        idemKey: scope.idemKey
      }
    }
  });
  if (!record) return null;
  if (record.requestHash !== scope.requestHash) {
    throw Object.assign(new Error('idempotency_key_conflict'), { status: 409, code: 'IDEMPOTENCY_KEY_CONFLICT' });
  }
  return mapIdempotencyReplay(record);
}

async function executeIdempotent(
  scope: IdempotencyScope,
  task: (tx: Tx) => Promise<IdempotencyOutcome>
) {
  try {
    return await runSerializableTransaction(async (tx) => {
      const asOf = now();
      await tx.apiIdempotencyRecord.deleteMany({
        where: {
          userId: scope.userId,
          expireAt: { lte: asOf }
        }
      });

      const existing = await tx.apiIdempotencyRecord.findUnique({
        where: {
          userId_method_path_idemKey: {
            userId: scope.userId,
            method: scope.method,
            path: scope.path,
            idemKey: scope.idemKey
          }
        }
      });
      if (existing) {
        if (existing.requestHash !== scope.requestHash) {
          throw Object.assign(new Error('idempotency_key_conflict'), { status: 409, code: 'IDEMPOTENCY_KEY_CONFLICT' });
        }
        return mapIdempotencyReplay(existing);
      }

      const outcome = await task(tx);

      await tx.apiIdempotencyRecord.create({
        data: {
          userId: scope.userId,
          method: scope.method,
          path: scope.path,
          idemKey: scope.idemKey,
          requestHash: scope.requestHash,
          responseJson: normalizeJsonValue(outcome.responseJson) as Prisma.InputJsonValue,
          statusCode: outcome.statusCode,
          expireAt: new Date(asOf.getTime() + IDEMPOTENCY_TTL_HOURS * 3_600_000)
        }
      });
      return outcome;
    });
  } catch (error) {
    if (!isUniqueConstraintError(error)) {
      throw error;
    }
    const replayed = await replayIdempotencyRecord(scope);
    if (!replayed) {
      throw error;
    }
    return replayed;
  }
}

export function gachaRouter() {
  const router = Router();

  router.use(requireAuth);
  router.use((req, res, next) => {
    const feature = resolveFeatureByPath(req.path ?? '');
    if (!feature || ensureFeatureEnabled(res, feature)) {
      next();
    }
  });

  router.get('/config', async (req, res, next) => {
    try {
      if (!req.authUser) return res.status(401).json({ error: '未登录' });
      const [wallet, poolsRaw, boosts] = await Promise.all([
        prisma.gachaWallet.findUnique({ where: { userId: req.authUser.id } }),
        fetchActivePools(prisma),
        fetchActiveBoosts(prisma)
      ]);
      const pools = sortPoolsForDisplay(
        poolsRaw.filter((pool) => pool.id === PERMANENT_POOL_ID)
      );
      res.json({
        ok: true,
        config: {
          activated: !!wallet,
          pools: pools.map(serializePool),
          boosts: boosts.map(serializeBoost)
        }
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/activate', async (req, res, next) => {
    try {
      if (!req.authUser) return res.status(401).json({ error: '未登录' });
      const wallet = await prisma.$transaction(async (tx) => {
        const ensured = await ensureWallet(tx, req.authUser!.id);
        return serializeWalletWithPity(tx, ensured);
      });
      res.json({ ok: true, wallet });
    } catch (error) {
      next(error);
    }
  });

  router.get('/wallet', async (req, res, next) => {
    try {
      if (!req.authUser) return res.status(401).json({ error: '未登录' });
      const wallet = await prisma.$transaction(async (tx) => {
        const ensured = await ensureWallet(tx, req.authUser!.id);
        return serializeWalletWithPity(tx, ensured);
      });
      res.json({ ok: true, wallet });
    } catch (error) {
      next(error);
    }
  });

  router.get('/features', async (_req, res) => {
    res.json({
      ok: true,
      ...featureStatusPayload()
    });
  });

  router.post('/claim-daily', async (req, res, next) => {
    try {
      if (!req.authUser) return res.status(401).json({ error: '未登录' });
      const result = await runSerializableTransaction(async (tx) => {
        const wallet = await ensureWallet(tx, req.authUser!.id);
        const today = now();
        if (
          wallet.lastDailyClaimAt
          && toUtc8DayKey(wallet.lastDailyClaimAt) === toUtc8DayKey(today)
        ) {
          throw Object.assign(new Error('今日已领取每日奖励'), { status: 400 });
        }
        const updated = await tx.gachaWallet.update({
          where: { id: wallet.id },
          data: {
            balance: { increment: DAILY_REWARD },
            totalEarned: { increment: DAILY_REWARD },
            lastDailyClaimAt: today
          }
        });
        await recordLedger(tx, wallet.id, req.authUser!.id, DAILY_REWARD, 'DAILY_CLAIM', { reward: DAILY_REWARD });
        return serializeWalletWithPity(tx, updated);
      });
      res.json({ ok: true, wallet: result, reward: DAILY_REWARD });
    } catch (error: any) {
      if (error?.status === 400) {
        res.status(400).json({ error: error.message });
        return;
      }
      next(error);
    }
  });

  router.post('/draw', async (req, res, next) => {
    try {
      if (!req.authUser) return res.status(401).json({ error: '未登录' });
      const payload = drawRequestSchema.parse({
        poolId: req.body?.poolId,
        paymentMethod: req.body?.paymentMethod,
        count: req.body?.count
      });
      if (payload.poolId && payload.poolId !== PERMANENT_POOL_ID) {
        res.status(400).json({ error: '当前仅支持常驻卡池' });
        return;
      }
      const drawSnapshot = await loadDrawPoolSnapshot(now());

      const scope = buildIdempotencyScope(req, req.authUser.id);
      const outcome = await executeIdempotent(scope, async (tx) => {
        const userId = req.authUser!.id;
        const drawCount = payload.count;
        const totalCost = drawCount === 10 ? FIXED_TEN_DRAW_TOKEN_COST : FIXED_DRAW_TOKEN_COST * drawCount;
        const requestedPaymentMethod = payload.paymentMethod as DrawPaymentMethod;
        let resolvedPaymentMethod: Exclude<DrawPaymentMethod, 'AUTO'> = 'TOKEN';
        let ticketsAfterPayment: TicketBalance | null = null;
        let walletForDraw: Prisma.GachaWalletGetPayload<{}> | null = null;
        let ticketDrawConsumeCount = 0;
        let tokenCostForDraw = totalCost;

        if (requestedPaymentMethod === 'TOKEN') {
          resolvedPaymentMethod = 'TOKEN';
        } else {
          const currentTickets = await computeTicketBalance(tx, userId);
          resolvedPaymentMethod = resolveDrawPaymentMethod(requestedPaymentMethod, drawCount, currentTickets);
          if (resolvedPaymentMethod === 'DRAW_TICKET') {
            const walletForTicket = await ensureWallet(tx, userId);
            walletForDraw = walletForTicket;
            ticketDrawConsumeCount = drawCount === 10
              ? Math.min(drawCount, Math.max(0, currentTickets.drawTicket))
              : 1;
            if (ticketDrawConsumeCount > 0) {
              ticketsAfterPayment = await consumeTicketBalance(
                tx,
                walletForTicket,
                userId,
                { drawTicket: ticketDrawConsumeCount, draw10Ticket: 0, affixReforgeTicket: 0 },
                drawCount === 10 ? 'DRAW_TICKET_TEN_MIXED' : 'DRAW_TICKET_SINGLE'
              );
            } else {
              ticketsAfterPayment = currentTickets;
              resolvedPaymentMethod = 'TOKEN';
            }
            tokenCostForDraw = Math.max(0, totalCost - (ticketDrawConsumeCount * FIXED_DRAW_TOKEN_COST));
          } else if (resolvedPaymentMethod === 'DRAW10_TICKET') {
            const walletForTicket = await ensureWallet(tx, userId);
            walletForDraw = walletForTicket;
            ticketsAfterPayment = await consumeTicketBalance(
              tx,
              walletForTicket,
              userId,
              { drawTicket: 0, draw10Ticket: 1, affixReforgeTicket: 0 },
              'DRAW_TICKET_TEN'
            );
            tokenCostForDraw = 0;
          } else {
            ticketsAfterPayment = currentTickets;
            tokenCostForDraw = totalCost;
          }
        }

        const spendMetadata: Prisma.JsonObject = {
          poolId: PERMANENT_POOL_ID,
          drawCount,
          paymentMethod: resolvedPaymentMethod,
          tokenCost: tokenCostForDraw
        };
        if (ticketDrawConsumeCount > 0) {
          spendMetadata.drawTicketConsumed = ticketDrawConsumeCount;
        }

        const drawResult = await executeDrawForUser(tx, {
          userId,
          drawCount,
          poolId: PERMANENT_POOL_ID,
          tokensCost: tokenCostForDraw,
          spendReason: tokenCostForDraw > 0 ? 'DRAW_SPEND' : 'DRAW_TICKET_SPEND',
          spendMetadata,
          prefetchedCards: drawSnapshot,
          wallet: walletForDraw ?? undefined
        });
        const ticketsForResponse = drawCount === 10
          ? await computeTicketBalance(tx, userId)
          : ticketsAfterPayment;

        return {
          statusCode: 200,
          responseJson: {
            ok: true,
            paymentMethod: resolvedPaymentMethod,
            tickets: ticketsForResponse,
            data: {
                items: drawResult.responseItems,
                rewardSummary: {
                  totalTokens: drawResult.totalRewardTokens,
                  byRarity: RARITY_ORDER.map((rarity) => ({
                    rarity,
                    count: drawResult.rarityCounter[rarity] ?? 0
                  }))
                },
                wallet: serializeWallet(drawResult.wallet, drawResult.pityCounters)
            }
          }
        };
      });

      res.status(outcome.statusCode).json(outcome.responseJson);
    } catch (error: any) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ error: error.issues[0]?.message ?? '参数错误' });
        return;
      }
      if (error?.status === 404) {
        res.status(404).json({ error: error.message });
        return;
      }
      if (error?.status === 400) {
        res.status(400).json({ error: error.message });
        return;
      }
      if (error?.status === 409 || error?.code === 'IDEMPOTENCY_KEY_CONFLICT') {
        res.status(409).json({ error: 'idempotency_key_conflict' });
        return;
      }
      next(error);
    }
  });

  router.post('/dismantle', async (req, res, next) => {
    try {
      if (!req.authUser) return res.status(401).json({ error: '未登录' });
      const payload = dismantleSchema.parse(req.body ?? {});
      const scope = buildIdempotencyScope(req, req.authUser.id);
      const outcome = await executeIdempotent(scope, async (tx) => {
        const wallet = await ensureWallet(tx, req.authUser!.id);
        const card = await tx.gachaCardDefinition.findUnique({ where: { id: payload.cardId } });
        if (!card) throw Object.assign(new Error('卡片不存在'), { status: 404 });
        const allFree = await findFreeInstances(tx, req.authUser!.id, card.id);
        if (allFree.length < payload.count) {
          throw Object.assign(new Error('拥有数量不足'), { status: 400 });
        }
        const requestedSignature = payload.affixSignature
          ? affixSignatureFromStyles(parseAffixSignature(payload.affixSignature))
          : null;
        const requestedStyle = payload.affixVisualStyle
          ? normalizeAffixVisualStyleInput(payload.affixVisualStyle)
          : null;
        let filtered = allFree;
        if (requestedSignature) {
          filtered = filtered.filter((inst) => inst.affixSignature === requestedSignature);
        }
        if (requestedStyle && requestedStyle !== 'NONE') {
          filtered = filtered.filter((inst) => {
            const fp = buildAffixFingerprintFromSignature(inst.affixSignature);
            return fp.affixStyles.includes(requestedStyle);
          });
        }
        filtered.sort((a, b) => variantEntrySortWeight(a.affixSignature) - variantEntrySortWeight(b.affixSignature));
        if (filtered.length < payload.count) {
          throw Object.assign(new Error('所选词条组合库存不足或已被放置占用'), { status: 400 });
        }
        const toDelete = filtered.slice(0, payload.count);
        const consumed: Array<{ affixVisualStyle: AffixVisualStyle; affixSignature: string; affixStyles: AffixVisualStyle[]; count: number }> = [];
        const consumeGroups = new Map<string, number>();
        for (const inst of toDelete) {
          consumeGroups.set(inst.affixSignature, (consumeGroups.get(inst.affixSignature) ?? 0) + 1);
        }
        for (const [signature, count] of consumeGroups) {
          const fp = buildAffixFingerprintFromSignature(signature);
          consumed.push({
            affixVisualStyle: fp.affixVisualStyle,
            affixSignature: fp.affixSignature,
            affixStyles: fp.affixStyles,
            count
          });
        }
        await deleteCardInstances(tx, toDelete.map((inst) => inst.id));
        const remaining = allFree.length - payload.count;

        const rewardDetail = computeDismantleRewardByAffix(card, consumed);
        const totalReward = rewardDetail.totalReward;
        const baseReward = rewardDetail.baseReward;
        const bonusReward = rewardDetail.bonusReward;

        const updatedWallet = await tx.gachaWallet.update({
          where: { id: wallet.id },
          data: {
            balance: { increment: totalReward },
            totalEarned: { increment: totalReward }
          }
        });

        await recordLedger(tx, wallet.id, req.authUser!.id, totalReward, 'DISMANTLE_REWARD', {
          cardId: card.id,
          count: payload.count,
          rarity: card.rarity,
          baseReward,
          bonusReward,
          byAffix: rewardDetail.byAffix
        });

        await tx.gachaDismantleLog.create({
          data: {
            userId: req.authUser!.id,
            cardId: card.id,
            count: payload.count,
            tokensEarned: totalReward
          }
        });

        return {
          statusCode: 200,
          responseJson: {
            ok: true,
            wallet: await serializeWalletWithPity(tx, updatedWallet),
            remaining,
            reward: totalReward,
            rewardDetail: {
              baseReward,
              bonusReward,
              byAffix: rewardDetail.byAffix
            }
          }
        };
      });

      res.status(outcome.statusCode).json(outcome.responseJson);
    } catch (error: any) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ error: error.issues[0]?.message ?? '参数错误' });
        return;
      }
      if (error?.status === 404) {
        res.status(404).json({ error: error.message });
        return;
      }
      if (error?.status === 400) {
        res.status(400).json({ error: error.message });
        return;
      }
      if (error?.status === 409 || error?.code === 'IDEMPOTENCY_KEY_CONFLICT') {
        res.status(409).json({ error: 'idempotency_key_conflict' });
        return;
      }
      next(error);
    }
  });

  router.post('/dismantle/batch', async (req, res, next) => {
    try {
      if (!req.authUser) return res.status(401).json({ error: '未登录' });
      const payload = dismantleBatchSchema.parse(req.body ?? {});
      const scope = buildIdempotencyScope(req, req.authUser.id);
      const outcome = await executeIdempotent(scope, async (tx) => {
        const userId = req.authUser!.id;
        const wallet = await ensureWallet(tx, userId);
        const maxRarityIndex = RARITY_ORDER.indexOf(payload.maxRarity);
        if (maxRarityIndex < 0) {
          throw Object.assign(new Error('稀有度参数无效'), { status: 400 });
        }
        const allowedRarities = RARITY_ORDER.slice(0, maxRarityIndex + 1);
        const inventoryItems = await tx.gachaInventory.findMany({
          where: {
            userId,
            count: { gt: 0 },
            card: {
              rarity: { in: allowedRarities }
            }
          },
          include: {
            card: true
          }
        });

        const byRarityCount: Record<GachaRarity, number> = {
          WHITE: 0,
          GREEN: 0,
          BLUE: 0,
          PURPLE: 0,
          GOLD: 0
        };
        const byRarityReward: Record<GachaRarity, number> = {
          WHITE: 0,
          GREEN: 0,
          BLUE: 0,
          PURPLE: 0,
          GOLD: 0
        };

        if (!inventoryItems.length) {
          return {
            statusCode: 200,
            responseJson: {
              ok: true,
              wallet: await serializeWalletWithPity(tx, wallet),
              summary: {
                maxRarity: payload.maxRarity,
                keepAtLeast: payload.keepAtLeast,
                keepScope: payload.keepScope,
                cardsAffected: 0,
                totalCount: 0,
                totalReward: 0,
                byRarity: RARITY_ORDER.map((rarity) => ({
                  rarity,
                  count: byRarityCount[rarity],
                  reward: byRarityReward[rarity]
                }))
              }
            }
          };
        }

        const cardIds = Array.from(new Set(inventoryItems.map((item) => item.cardId)));
        // Batch-load all free instances for the candidate cards
        const allFreeInstances = cardIds.length > 0
          ? await tx.gachaCardInstance.findMany({
            where: {
              userId,
              cardId: { in: cardIds },
              tradeListingId: null,
              buyRequestId: null,
              isLocked: false,
              placementSlot: { is: null },
              showcaseSlot: { is: null }
            },
            orderBy: { obtainedAt: 'asc' }
          })
          : [];
        const freeByCard = new Map<string, typeof allFreeInstances>();
        for (const inst of allFreeInstances) {
          const list = freeByCard.get(inst.cardId) ?? [];
          list.push(inst);
          freeByCard.set(inst.cardId, list);
        }

        let cardsAffected = 0;
        let totalCount = 0;
        let totalReward = 0;

        for (const item of inventoryItems) {
          const freeInstances = freeByCard.get(item.cardId) ?? [];
          const toDelete = selectBatchDismantleInstances(freeInstances, payload.keepAtLeast, payload.keepScope);
          const dismantleCount = toDelete.length;
          if (dismantleCount <= 0) continue;
          const consumeGroups = new Map<string, number>();
          for (const inst of toDelete) {
            consumeGroups.set(inst.affixSignature, (consumeGroups.get(inst.affixSignature) ?? 0) + 1);
          }
          const consumed: Array<{ affixVisualStyle: AffixVisualStyle; affixSignature: string; affixStyles: AffixVisualStyle[]; count: number }> = [];
          for (const [signature, count] of consumeGroups) {
            const fp = buildAffixFingerprintFromSignature(signature);
            consumed.push({
              affixVisualStyle: fp.affixVisualStyle,
              affixSignature: fp.affixSignature,
              affixStyles: fp.affixStyles,
              count
            });
          }
          // eslint-disable-next-line no-await-in-loop
          await deleteCardInstances(tx, toDelete.map((inst) => inst.id));

          const rewardDetail = computeDismantleRewardByAffix(item.card, consumed);
          const reward = rewardDetail.totalReward;
          totalCount += dismantleCount;
          totalReward += reward;
          cardsAffected += 1;
          byRarityCount[item.card.rarity] += dismantleCount;
          byRarityReward[item.card.rarity] += reward;

          // eslint-disable-next-line no-await-in-loop
          await tx.gachaDismantleLog.create({
            data: {
              userId,
              cardId: item.cardId,
              count: dismantleCount,
              tokensEarned: reward
            }
          });
        }

        let updatedWallet = wallet;
        if (totalReward > 0) {
          updatedWallet = await tx.gachaWallet.update({
            where: { id: wallet.id },
            data: {
              balance: { increment: totalReward },
              totalEarned: { increment: totalReward }
            }
          });

          await recordLedger(tx, wallet.id, userId, totalReward, 'DISMANTLE_BATCH_REWARD', {
            maxRarity: payload.maxRarity,
            keepAtLeast: payload.keepAtLeast,
            keepScope: payload.keepScope,
            cardsAffected,
            totalCount,
            totalReward,
            byRarity: RARITY_ORDER.map((rarity) => ({
              rarity,
              count: byRarityCount[rarity],
              reward: byRarityReward[rarity]
            }))
          });
        }

        return {
          statusCode: 200,
          responseJson: {
            ok: true,
            wallet: await serializeWalletWithPity(tx, updatedWallet),
            summary: {
              maxRarity: payload.maxRarity,
              keepAtLeast: payload.keepAtLeast,
              keepScope: payload.keepScope,
              cardsAffected,
              totalCount,
              totalReward,
              byRarity: RARITY_ORDER.map((rarity) => ({
                rarity,
                count: byRarityCount[rarity],
                reward: byRarityReward[rarity]
              }))
            }
          }
        };
      });

      res.status(outcome.statusCode).json(outcome.responseJson);
    } catch (error: any) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ error: error.issues[0]?.message ?? '参数错误' });
        return;
      }
      if (error?.status === 400) {
        res.status(400).json({ error: error.message });
        return;
      }
      if (error?.status === 409 || error?.code === 'IDEMPOTENCY_KEY_CONFLICT') {
        res.status(409).json({ error: 'idempotency_key_conflict' });
        return;
      }
      next(error);
    }
  });

  router.get('/inventory', async (req, res, next) => {
    try {
      if (!req.authUser) return res.status(401).json({ error: '未登录' });
      const parsed = inventoryQuerySchema.parse(req.query ?? {});
      const limit = Math.min(Math.max(Number(parsed.limit ?? '30'), 1), PLACEMENT_OPTION_LIMIT);
      const offset = Math.max(Number(parsed.offset ?? '0'), 0);
      const skipTotal = parsed.skipTotal === '1';
      const rarityFilter = parsed.rarity ? parsed.rarity.toUpperCase() : null;
      const poolId = parsed.poolId ?? null;
      const affixFilter = parsed.affixFilter ? parsed.affixFilter.toUpperCase().trim() : null;
      const searchTerm = parsed.search?.trim() || null;
      if (poolId && poolId !== PERMANENT_POOL_ID) {
        res.status(400).json({ error: '当前仅支持常驻卡池' });
        return;
      }

      const userId = req.authUser.id;

      // Build dynamic WHERE clause for raw SQL
      let invWhere = Prisma.sql`i."userId" = ${userId} AND i.count > 0`;
      if (rarityFilter && RARITY_ORDER.includes(rarityFilter as GachaRarity)) {
        invWhere = Prisma.sql`${invWhere} AND c.rarity::text = ${rarityFilter}`;
      }
      if (poolId) {
        invWhere = Prisma.sql`${invWhere} AND c."poolId" = ${poolId}`;
      }
      // When affixFilter is set, only include inventory rows that have matching instances
      if (affixFilter) {
        invWhere = Prisma.sql`${invWhere} AND EXISTS (
          SELECT 1 FROM "GachaCardInstance" ci2
          WHERE ci2."userId" = ${userId}
            AND ci2."cardId" = i."cardId"
            AND ci2."tradeListingId" IS NULL
            AND ci2."affixSignature" = ${affixFilter}
        )`;
      }
      // Search by card title + tags + author (tag-based and page-based author matching)
      if (searchTerm) {
        const searchTermLower = searchTerm.toLowerCase();
        const authorCardIds = await findCardIdsByAuthorKeyword(searchTerm);
        const orClauses: Prisma.Sql[] = [
          Prisma.sql`c.title ILIKE '%' || ${searchTerm} || '%'`,
          Prisma.sql`${searchTermLower} = ANY(SELECT LOWER(t) FROM unnest(c.tags) AS t)`
        ];
        if (authorCardIds.length > 0) {
          orClauses.push(Prisma.sql`c.id IN (${Prisma.join(authorCardIds)})`);
        }
        invWhere = Prisma.sql`${invWhere} AND (${Prisma.join(orClauses, ' OR ')})`;
      }

      // Instance-level filter for the variant aggregation
      const instAffixWhere = affixFilter
        ? Prisma.sql`AND ci."affixSignature" = ${affixFilter}`
        : Prisma.empty;

      type RawInvRow = {
        cardId: string;
        inv_count: number;
        title: string;
        rarity: string;
        tags: string[] | null;
        imageUrl: string | null;
        wikidotId: string | null;
        pageId: string | null;
        poolId: string;
        weight: number | null;
        variants: Array<{ s: string | null; style: string | null; c: number; lc: number }> | null;
      };

      // Single combined query: inventory + card + instance aggregation in one DB roundtrip
      // Sort by rarity priority (GOLD first) then createdAt
      const [rows, total] = await Promise.all([
        prisma.$queryRaw<RawInvRow[]>(Prisma.sql`
          WITH inv_page AS (
            SELECT i.id AS inv_id, i."cardId", i.count AS inv_count,
                   c.title, c.rarity::text AS rarity, c.tags, c."imageUrl",
                   c."wikidotId", c."pageId", c."poolId", c.weight,
                   i."createdAt",
                   CASE c.rarity::text
                     WHEN 'GOLD' THEN 0
                     WHEN 'PURPLE' THEN 1
                     WHEN 'BLUE' THEN 2
                     WHEN 'GREEN' THEN 3
                     WHEN 'WHITE' THEN 4
                     ELSE 5
                   END AS rarity_weight
            FROM "GachaInventory" i
            JOIN "GachaCardDefinition" c ON c.id = i."cardId"
            WHERE ${invWhere}
            ORDER BY rarity_weight ASC, i."createdAt" ASC, i.id ASC
            OFFSET ${offset} LIMIT ${limit}
          ),
          inst_agg AS (
            SELECT ci."cardId", ci."affixSignature", ci."affixVisualStyle"::text AS "affixVisualStyle", COUNT(*)::int AS cnt,
                   COUNT(*) FILTER (WHERE ci."isLocked" = true)::int AS locked_cnt
            FROM "GachaCardInstance" ci
            WHERE ci."userId" = ${userId}
              AND ci."cardId" IN (SELECT "cardId" FROM inv_page)
              AND ci."tradeListingId" IS NULL
              AND ci."buyRequestId" IS NULL
              ${instAffixWhere}
            GROUP BY ci."cardId", ci."affixSignature", ci."affixVisualStyle"
          )
          SELECT
            p."cardId", p.inv_count, p.title, p.rarity,
            p.tags, p."imageUrl", p."wikidotId", p."pageId", p."poolId", p.weight,
            COALESCE(
              (SELECT json_agg(json_build_object('s', ia."affixSignature", 'style', ia."affixVisualStyle", 'c', ia.cnt, 'lc', ia.locked_cnt))
               FROM inst_agg ia WHERE ia."cardId" = p."cardId"),
              '[]'::json
            ) AS variants
          FROM inv_page p
          ORDER BY p.rarity_weight ASC, p."createdAt" ASC, p.inv_id ASC
        `),
        skipTotal
          ? Promise.resolve(-1)
          : prisma.$queryRaw<[{ count: number }]>(Prisma.sql`
              SELECT COUNT(*)::int AS count
              FROM "GachaInventory" i
              JOIN "GachaCardDefinition" c ON c.id = i."cardId"
              WHERE ${invWhere}
            `).then(r => Number(r[0]?.count ?? 0))
      ]);

      res.json({
        ok: true,
        items: rows.flatMap((row) => {
          const card = { id: row.cardId, title: row.title, rarity: row.rarity as GachaRarity, tags: row.tags };
          const variantListRaw = Array.isArray(row.variants) ? row.variants : [];
          const variantCountBySignature = new Map<string, { count: number; lockedCount: number }>();
          for (const variant of variantListRaw) {
            const count = Math.max(0, Number(variant?.c ?? 0));
            if (count <= 0) continue;
            const lockedCount = Math.max(0, Number(variant?.lc ?? 0));
            const normalizedSignature = affixSignatureFromStyles(parseAffixSignature(
              variant?.s || variant?.style || 'NONE'
            ));
            const existing = variantCountBySignature.get(normalizedSignature) ?? { count: 0, lockedCount: 0 };
            variantCountBySignature.set(normalizedSignature, {
              count: existing.count + count,
              lockedCount: existing.lockedCount + lockedCount
            });
          }
          const variantList = [...variantCountBySignature.entries()].map(([s, v]) => ({ s, c: v.count, lc: v.lockedCount }));
          if (variantList.length === 0) {
            const affix = resolveCardAffixWithBonus(card, { affixSignature: 'NONE' });
            return [{
              ...affix,
              id: `${row.cardId}:NONE`,
              cardId: row.cardId,
              title: row.title,
              rarity: row.rarity,
              tags: row.tags ?? [],
              authors: resolveCardAuthorsFromTags(row.tags),
              imageUrl: row.imageUrl ?? null,
              wikidotId: row.wikidotId ?? null,
              pageId: row.pageId ?? null,
              count: row.inv_count,
              lockedCount: 0,
              rewardTokens: DEFAULT_DISMANTLE_REWARD_BY_RARITY[row.rarity as GachaRarity] ?? 0,
              poolId: row.poolId,
              isRetired: isRetiredCard({ poolId: row.poolId, weight: row.weight })
            }];
          }
          return variantList
            .sort((a, b) => variantEntrySortWeight(a.s) - variantEntrySortWeight(b.s))
            .map((v) => {
              const affix = resolveCardAffixWithBonus(card, { affixSignature: v.s });
              return {
                ...affix,
                id: `${row.cardId}:${v.s}`,
                cardId: row.cardId,
                title: row.title,
                rarity: row.rarity,
                tags: row.tags ?? [],
                authors: resolveCardAuthorsFromTags(row.tags),
                imageUrl: row.imageUrl ?? null,
                wikidotId: row.wikidotId ?? null,
                pageId: row.pageId ?? null,
                count: v.c,
                lockedCount: v.lc,
                rewardTokens: DEFAULT_DISMANTLE_REWARD_BY_RARITY[row.rarity as GachaRarity] ?? 0,
                poolId: row.poolId,
                isRetired: isRetiredCard({ poolId: row.poolId, weight: row.weight })
              };
            });
        }),
        pageRows: rows.length,
        total
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/album/summary', async (req, res, next) => {
    try {
      if (!req.authUser) return res.status(401).json({ error: '未登录' });
      // Single query: user instance stats + pool card count in one DB round-trip
      const rows = await prisma.$queryRaw<Array<{
        totalPages: number | string | null;
        totalImageVariants: number | string | null;
        totalOwnedCount: number | string | null;
        coatingStyles: number | string | null;
        totalImageVariantsInPool: number | string | null;
        totalPagesInPool: number | string | null;
      }>>(Prisma.sql`
        WITH instance_rows AS (
          SELECT
            c."pageId" AS "pageId",
            c."imageUrl" AS "imageUrl",
            ci."cardId" AS "cardId",
            ci."affixVisualStyle" AS "affixVisualStyle"
          FROM "GachaCardInstance" ci
          JOIN "GachaCardDefinition" c ON c.id = ci."cardId"
          WHERE ci."userId" = ${req.authUser.id}
            AND ci."tradeListingId" IS NULL
        ),
        pool_total AS (
          SELECT
            COUNT(
              DISTINCT CASE
                WHEN "pageId" IS NOT NULL
                  THEN ("pageId")::text || '|' || COALESCE(NULLIF(BTRIM("imageUrl"), ''), '__NOIMG__')
                ELSE id
              END
            )::int AS total,
            COUNT(DISTINCT "pageId")::int AS "totalPages"
          FROM "GachaCardDefinition"
          WHERE "poolId" = ${PERMANENT_POOL_ID}
        )
        SELECT
          COUNT(DISTINCT "pageId") FILTER (WHERE "pageId" IS NOT NULL)::int AS "totalPages",
          COUNT(
            DISTINCT CASE
              WHEN "pageId" IS NOT NULL
                THEN ("pageId")::text || '|' || COALESCE(NULLIF(BTRIM("imageUrl"), ''), '__NOIMG__')
              ELSE "cardId"
            END
          )::int AS "totalImageVariants",
          COUNT(*)::int AS "totalOwnedCount",
          COUNT(DISTINCT "affixVisualStyle") FILTER (WHERE "affixVisualStyle" != 'NONE')::int AS "coatingStyles",
          (SELECT total FROM pool_total)::int AS "totalImageVariantsInPool",
          (SELECT "totalPages" FROM pool_total)::int AS "totalPagesInPool"
        FROM instance_rows
      `);
      const row = rows[0];
      res.json({
        ok: true,
        summary: {
          totalPages: Math.max(0, toSafeInt(row?.totalPages, 0)),
          totalImageVariants: Math.max(0, toSafeInt(row?.totalImageVariants, 0)),
          totalImageVariantsInPool: Math.max(0, toSafeInt(row?.totalImageVariantsInPool, 0)),
          totalPagesInPool: Math.max(0, toSafeInt(row?.totalPagesInPool, 0)),
          coatingStyles: Math.max(0, toSafeInt(row?.coatingStyles, 0)),
          totalOwnedCount: Math.max(0, toSafeInt(row?.totalOwnedCount, 0))
        }
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/album/pages', async (req, res, next) => {
    try {
      if (!req.authUser) return res.status(401).json({ error: '未登录' });
      const parsed = albumPagesQuerySchema.parse(req.query ?? {});
      const limit = Math.min(Math.max(Number(parsed.limit ?? '80'), 1), ALBUM_PAGE_QUERY_LIMIT_MAX);
      const offset = Math.max(Number(parsed.offset ?? '0'), 0);
      const search = parsed.search?.trim() ?? '';
      const userId = req.authUser.id;

      // Build search condition — match title, tags, or author
      let searchCondition: Prisma.Sql;
      if (search) {
        const searchLower = search.toLowerCase();
        const authorCardIds = await findCardIdsByAuthorKeyword(search);
        const orClauses: Prisma.Sql[] = [
          Prisma.sql`LOWER(pb."title") LIKE '%' || LOWER(${search}) || '%'`,
          Prisma.sql`EXISTS (
            SELECT 1 FROM "GachaCardDefinition" cd
            CROSS JOIN LATERAL unnest(cd."tags") AS t(tag)
            WHERE cd."pageId" = pb."pageId" AND LOWER(t.tag) = ${searchLower}
          )`
        ];
        if (authorCardIds.length > 0) {
          orClauses.push(Prisma.sql`EXISTS (
            SELECT 1 FROM "GachaCardDefinition" cd
            WHERE cd."pageId" = pb."pageId" AND cd.id IN (${Prisma.join(authorCardIds)})
          )`);
        }
        searchCondition = Prisma.sql`AND (${Prisma.join(orClauses, ' OR ')})`;
      } else {
        searchCondition = Prisma.empty;
      }

      type AlbumPageRow = {
        pageId: number | string;
        wikidotId: number | string | null;
        title: string | null;
        highestRarityRank: number | string;
        coverImageUrl: string | null;
        totalCount: number | string | null;
        variantCount: number | string | null;
        imageVariantCount: number | string | null;
        coatingCount: number | string | null;
      };

      // Optimized: split into data query + count query (parallel), no COUNT(*) OVER()
      // Also removed page_tags CTE from main query — tags are fetched post-pagination
      const baseCTE = Prisma.sql`
        WITH page_base AS (
          SELECT
            c."pageId" AS "pageId",
            MIN(c."wikidotId") FILTER (WHERE c."wikidotId" IS NOT NULL) AS "wikidotId",
            MIN(c."title") AS "title",
            MIN(
              CASE c."rarity"
                WHEN 'GOLD' THEN 0
                WHEN 'PURPLE' THEN 1
                WHEN 'BLUE' THEN 2
                WHEN 'GREEN' THEN 3
                ELSE 4
              END
            ) AS "highestRarityRank",
            MAX(c."imageUrl") FILTER (WHERE c."imageUrl" IS NOT NULL) AS "coverImageUrl",
            COUNT(*)::int AS "totalCount",
            COUNT(DISTINCT ci."affixSignature")::int AS "variantCount",
            COUNT(DISTINCT COALESCE(NULLIF(BTRIM(c."imageUrl"), ''), '__NOIMG__'))::int AS "imageVariantCount",
            COUNT(DISTINCT ci."affixVisualStyle") FILTER (WHERE ci."affixVisualStyle" != 'NONE')::int AS "coatingCount"
          FROM "GachaCardInstance" ci
          JOIN "GachaCardDefinition" c ON c.id = ci."cardId"
          WHERE ci."userId" = ${userId}
            AND ci."tradeListingId" IS NULL
            AND c."pageId" IS NOT NULL
          GROUP BY c."pageId"
        )
      `;

      const [rows, totalResult, poolTotals] = await Promise.all([
        prisma.$queryRaw<AlbumPageRow[]>(Prisma.sql`
          ${baseCTE}
          SELECT
            pb."pageId",
            pb."wikidotId",
            pb."title",
            pb."highestRarityRank",
            pb."coverImageUrl",
            pb."totalCount",
            pb."variantCount",
            pb."imageVariantCount",
            pb."coatingCount"
          FROM page_base pb
          WHERE TRUE ${searchCondition}
          ORDER BY pb."totalCount" DESC, pb."variantCount" DESC, pb."highestRarityRank" ASC, pb."pageId" ASC
          OFFSET ${offset}
          LIMIT ${limit}
        `),
        prisma.$queryRaw<[{ count: number | string }]>(Prisma.sql`
          ${baseCTE}
          SELECT COUNT(*)::int AS count
          FROM page_base pb
          WHERE TRUE ${searchCondition}
        `),
        // Pool image variant totals — only for the paged results (joined after)
        prisma.$queryRaw<Array<{ pageId: number | string; total: number | string }>>(Prisma.sql`
          SELECT "pageId", COUNT(DISTINCT COALESCE(NULLIF(BTRIM("imageUrl"), ''), '__NOIMG__'))::int AS total
          FROM "GachaCardDefinition"
          WHERE "poolId" = ${PERMANENT_POOL_ID} AND "pageId" IS NOT NULL
          GROUP BY "pageId"
        `)
      ]);

      const total = Math.max(0, Number(totalResult[0]?.count ?? 0));
      const poolTotalMap = new Map(poolTotals.map(r => [Number(r.pageId), Number(r.total)]));

      // Post-pagination: fetch tags only for returned page IDs
      const pageIds = rows.map(r => Number(r.pageId));
      let tagsByPage = new Map<number, string[]>();
      if (pageIds.length > 0) {
        const tagRows = await prisma.$queryRaw<Array<{ pageId: number | string; tags: string[] }>>(Prisma.sql`
          SELECT c."pageId"::int AS "pageId",
            ARRAY(
              SELECT DISTINCT NULLIF(BTRIM(t.tag), '')
              FROM "GachaCardDefinition" c2
              CROSS JOIN LATERAL unnest(c2."tags") AS t(tag)
              WHERE c2."pageId" = c."pageId" AND NULLIF(BTRIM(t.tag), '') IS NOT NULL
              ORDER BY 1
              LIMIT 8
            ) AS tags
          FROM "GachaCardDefinition" c
          WHERE c."pageId" = ANY(${pageIds}::int[])
          GROUP BY c."pageId"
        `);
        tagsByPage = new Map(tagRows.map(r => [Number(r.pageId), r.tags ?? []]));
      }

      const items = rows.map((row) => {
        const rarityRank = Number(row.highestRarityRank ?? 4);
        const highestRarity = (['GOLD', 'PURPLE', 'BLUE', 'GREEN', 'WHITE'] as const)[rarityRank] ?? 'WHITE';
        const pid = Number(row.pageId);
        return {
          pageId: Math.max(1, toSafeInt(row.pageId, 1)),
          wikidotId: row.wikidotId == null ? null : toSafeInt(row.wikidotId, 0),
          title: String(row.title || ''),
          highestRarity,
          coverImageUrl: row.coverImageUrl ? String(row.coverImageUrl) : null,
          totalCount: Math.max(0, toSafeInt(row.totalCount, 0)),
          variantCount: Math.max(0, toSafeInt(row.variantCount, 0)),
          imageVariantCount: Math.max(0, toSafeInt(row.imageVariantCount, 0)),
          imageVariantTotal: poolTotalMap.get(pid) ?? 0,
          coatingCount: Math.max(0, toSafeInt(row.coatingCount, 0)),
          tags: (tagsByPage.get(pid) ?? [])
            .map((tag) => String(tag || '').trim())
            .filter((tag) => tag.length > 0)
            .slice(0, 8)
        };
      });
      res.json({
        ok: true,
        items,
        total
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ error: error.issues[0]?.message ?? '参数错误' });
        return;
      }
      next(error);
    }
  });

  router.get('/album/pages/:pageId/variants', async (req, res, next) => {
    try {
      if (!req.authUser) return res.status(401).json({ error: '未登录' });
      const params = albumVariantsParamSchema.parse(req.params ?? {});
      const pageId = params.pageId;
      const userId = req.authUser.id;

      // Single query: JOIN cards + instances, GROUP BY cardId + affixSignature
      type VariantRow = {
        cardId: string;
        title: string;
        rarity: string;
        tags: string[] | null;
        authorKeys: string[] | null;
        imageUrl: string | null;
        wikidotId: number | string | null;
        rowPageId: number | string | null;
        poolId: string;
        weight: number | null;
        affixSignature: string;
        cnt: number | string;
      };
      const variantRows = await prisma.$queryRaw<VariantRow[]>(Prisma.sql`
        SELECT
          c.id AS "cardId",
          c.title,
          c.rarity::text AS rarity,
          c.tags,
          c."authorKeys",
          c."imageUrl",
          c."wikidotId",
          c."pageId" AS "rowPageId",
          c."poolId",
          c.weight,
          ci."affixSignature",
          COUNT(*)::int AS cnt
        FROM "GachaCardInstance" ci
        JOIN "GachaCardDefinition" c ON c.id = ci."cardId"
        WHERE ci."userId" = ${userId}
          AND ci."tradeListingId" IS NULL
          AND c."pageId" = ${pageId}
        GROUP BY c.id, c.title, c.rarity, c.tags, c."authorKeys", c."imageUrl", c."wikidotId", c."pageId", c."poolId", c.weight, ci."affixSignature"
      `);

      if (variantRows.length === 0) {
        res.status(404).json({ error: '未找到该页面的已拥有变体' });
        return;
      }

      const variants = variantRows
        .map((row) => {
          const card = { id: row.cardId, title: row.title, rarity: row.rarity as GachaRarity, tags: row.tags ?? [] };
          const normalizedSignature = affixSignatureFromStyles(parseAffixSignature(
            row.affixSignature || 'NONE'
          ));
          const affix = resolveCardAffixWithBonus(card, {
            affixSignature: normalizedSignature
          });
          const imgMatch = row.cardId.match(/-img-(\d+)$/);
          const imageIndex = imgMatch ? parseInt(imgMatch[1], 10) - 1 : 0;
          const isAlternateArt = imageIndex > 0;
          return {
            cardId: row.cardId,
            title: row.title,
            rarity: row.rarity as GachaRarity,
            count: Number(row.cnt),
            tags: row.tags ?? [],
            authors: resolveCardAuthorsFromTags(row.tags ?? [], row.authorKeys ?? []),
            imageUrl: row.imageUrl ?? null,
            wikidotId: row.wikidotId != null ? Number(row.wikidotId) : null,
            pageId: row.rowPageId != null ? Number(row.rowPageId) : null,
            rewardTokens: DEFAULT_DISMANTLE_REWARD_BY_RARITY[row.rarity as GachaRarity] ?? 0,
            affixSignature: affix.affixSignature,
            affixStyles: affix.affixStyles,
            affixStyleCounts: affix.affixStyleCounts,
            affixVisualStyle: affix.affixVisualStyle,
            affixLabel: affix.affixLabel,
            affixYieldBoostPercent: affix.affixYieldBoostPercent,
            affixOfflineBufferBonus: affix.affixOfflineBufferBonus,
            affixDismantleBonusPercent: affix.affixDismantleBonusPercent,
            isRetired: isRetiredCard({ poolId: row.poolId, weight: row.weight }),
            isAlternateArt,
            imageIndex
          };
        })
        .sort((a, b) => {
          const rarityDiff = rarityWeight[a.rarity] - rarityWeight[b.rarity];
          if (rarityDiff !== 0) return rarityDiff;
          if (a.count !== b.count) return b.count - a.count;
          return a.title.localeCompare(b.title, 'zh-CN');
        });

      const primary = variants[0];
      const page = {
        pageId,
        wikidotId: primary?.wikidotId ?? null,
        title: primary?.title ?? `页面 ${pageId}`,
        totalCount: variants.reduce((sum, variant) => sum + variant.count, 0),
        variantCount: variants.length,
        coverImageUrl: variants.find((variant) => variant.imageUrl)?.imageUrl ?? null
      };

      res.json({
        ok: true,
        page,
        variants
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ error: error.issues[0]?.message ?? '参数错误' });
        return;
      }
      next(error);
    }
  });

  router.get('/placement', async (req, res, next) => {
    try {
      if (!req.authUser) return res.status(401).json({ error: '未登录' });
      const placement = await runSerializableTransaction(async (tx) => {
        const userId = req.authUser!.id;
        const asOf = now();
        const ensured = await ensurePlacementStateAndSlots(tx, userId);
        const state = await accruePlacementPending(tx, {
          userId,
          state: ensured.state,
          slots: ensured.slots,
          addons: ensured.addons,
          asOf
        });
        return serializePlacement(userId, state, ensured.slots, ensured.addons);
      });
      res.json({ ok: true, placement });
    } catch (error) {
      next(error);
    }
  });

  router.post('/placement/slots/:slotIndex/set', async (req, res, next) => {
    try {
      if (!req.authUser) return res.status(401).json({ error: '未登录' });
      const params = placementSlotParamSchema.parse(req.params ?? {});
      const payload = placementSetSchema.parse(req.body ?? {});
      const placement = await runSerializableTransaction(async (tx) => {
        const userId = req.authUser!.id;
        const asOf = now();
        const ensured = await ensurePlacementStateAndSlots(tx, userId);
        const accruedState = await accruePlacementPending(tx, {
          userId,
          state: ensured.state,
          slots: ensured.slots,
          addons: ensured.addons,
          asOf
        });
        const unlockedSlotCount = normalizedPlacementUnlockedSlotCount(accruedState);
        if (params.slotIndex > unlockedSlotCount) {
          throw Object.assign(new Error('该槽位尚未解锁'), { status: 400 });
        }
        const targetSlot = ensured.slots.find((slot) => slot.slotIndex === params.slotIndex);
        if (!targetSlot) {
          throw Object.assign(new Error('槽位不存在'), { status: 404 });
        }
        const inventory = await tx.gachaInventory.findUnique({
          where: {
            userId_cardId: {
              userId,
              cardId: payload.cardId
            }
          },
          include: { card: true }
        });
        if (!inventory || inventory.count <= 0 || !inventory.card) {
          throw Object.assign(new Error('你还没有这张卡片，无法放置'), { status: 400 });
        }
        const requestedSignature = payload.affixSignature
          ? affixSignatureFromStyles(parseAffixSignature(payload.affixSignature))
          : null;
        const requestedStyle = payload.affixVisualStyle
          ? normalizeAffixVisualStyleInput(payload.affixVisualStyle)
          : null;
        let freeInstances = await findFreeInstances(tx, userId, payload.cardId, {
          affixSignature: requestedSignature ?? undefined,
          includeLocked: true,
          includeShowcased: true
        });
        if (requestedStyle && requestedStyle !== 'NONE' && !requestedSignature) {
          freeInstances = freeInstances.filter((inst) => {
            const fp = buildAffixFingerprintFromSignature(inst.affixSignature);
            return fp.affixStyles.includes(requestedStyle);
          });
        }
        if (freeInstances.length === 0) {
          throw Object.assign(new Error('该卡对应词条实例库存不足，无法放置'), { status: 400 });
        }
        const selectedInstance = freeInstances[0];
        const selectedFingerprint = buildAffixFingerprintFromSignature(selectedInstance.affixSignature);
        const selectedSignature = selectedFingerprint.affixSignature;
        const selectedStyle = selectedFingerprint.affixVisualStyle;
        const selectedLabel = selectedFingerprint.affixLabel;
        const currentSignature = affixSignatureFromStyles(parseAffixSignature(targetSlot.affixSignature || targetSlot.affixVisualStyle || 'NONE'));
        if (
          targetSlot.cardId !== payload.cardId
          || currentSignature !== selectedSignature
          || normalizeAffixVisualStyleInput(targetSlot.affixVisualStyle) !== selectedStyle
          || String(targetSlot.affixLabel || '') !== selectedLabel
        ) {
          await tx.gachaPlacementSlot.update({
            where: { id: targetSlot.id },
            data: {
              cardId: payload.cardId,
              inventoryId: inventory.id,
              instanceId: selectedInstance.id,
              affixSignature: selectedSignature,
              affixVisualStyle: selectedStyle as PrismaAffixVisualStyle,
              affixLabel: selectedLabel,
              assignedAt: asOf
            }
          });
        }
        const slots = (
          targetSlot.cardId === payload.cardId
          && currentSignature === selectedSignature
          && normalizeAffixVisualStyleInput(targetSlot.affixVisualStyle) === selectedStyle
          && String(targetSlot.affixLabel || '') === selectedLabel
        )
          ? ensured.slots
          : await listPlacementSlots(tx, userId);
        return serializePlacement(userId, accruedState, slots, ensured.addons);
      });
      res.json({ ok: true, placement });
    } catch (error: any) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ error: error.issues[0]?.message ?? '参数错误' });
        return;
      }
      if (error?.status === 404) {
        res.status(404).json({ error: error.message });
        return;
      }
      if (error?.status === 400) {
        res.status(400).json({ error: error.message });
        return;
      }
      next(error);
    }
  });

  router.post('/placement/slots/:slotIndex/clear', async (req, res, next) => {
    try {
      if (!req.authUser) return res.status(401).json({ error: '未登录' });
      const params = placementSlotParamSchema.parse(req.params ?? {});
      const placement = await runSerializableTransaction(async (tx) => {
        const userId = req.authUser!.id;
        const asOf = now();
        const ensured = await ensurePlacementStateAndSlots(tx, userId);
        const accruedState = await accruePlacementPending(tx, {
          userId,
          state: ensured.state,
          slots: ensured.slots,
          addons: ensured.addons,
          asOf
        });
        const unlockedSlotCount = normalizedPlacementUnlockedSlotCount(accruedState);
        if (params.slotIndex > unlockedSlotCount) {
          throw Object.assign(new Error('该槽位尚未解锁'), { status: 400 });
        }
        const targetSlot = ensured.slots.find((slot) => slot.slotIndex === params.slotIndex);
        if (!targetSlot) {
          throw Object.assign(new Error('槽位不存在'), { status: 404 });
        }
        if (targetSlot.cardId != null) {
          await tx.gachaPlacementSlot.update({
            where: { id: targetSlot.id },
            data: {
              cardId: null,
              inventoryId: null,
              instanceId: null,
              affixVisualStyle: null,
              affixSignature: null,
              affixLabel: null,
              assignedAt: null
            }
          });
        }
        const slots = targetSlot.cardId == null
          ? ensured.slots
          : await listPlacementSlots(tx, userId);
        return serializePlacement(userId, accruedState, slots, ensured.addons);
      });
      res.json({ ok: true, placement });
    } catch (error: any) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ error: error.issues[0]?.message ?? '参数错误' });
        return;
      }
      if (error?.status === 404) {
        res.status(404).json({ error: error.message });
        return;
      }
      if (error?.status === 400) {
        res.status(400).json({ error: error.message });
        return;
      }
      next(error);
    }
  });

  router.post('/placement/slots/unlock', async (req, res, next) => {
    try {
      if (!req.authUser) return res.status(401).json({ error: '未登录' });
      const result = await runSerializableTransaction(async (tx) => {
        const userId = req.authUser!.id;
        const asOf = now();
        const ensured = await ensurePlacementStateAndSlots(tx, userId);
        const accruedState = await accruePlacementPending(tx, {
          userId,
          state: ensured.state,
          slots: ensured.slots,
          addons: ensured.addons,
          asOf
        });
        const unlockedSlotCount = normalizedPlacementUnlockedSlotCount(accruedState);
        if (unlockedSlotCount >= PLACEMENT_SLOT_COUNT_MAX) {
          throw Object.assign(new Error('槽位已解锁至上限'), { status: 400 });
        }
        const unlockCost = nextPlacementSlotUnlockCost(unlockedSlotCount);
        if (unlockCost == null || unlockCost <= 0) {
          throw Object.assign(new Error('当前无法解锁槽位'), { status: 400 });
        }
        const wallet = await ensureWallet(tx, userId);
        if (wallet.balance < unlockCost) {
          throw Object.assign(new Error('Token 余额不足'), { status: 400 });
        }
        const updatedWallet = await applyWalletDelta(
          tx,
          wallet,
          -unlockCost,
          PLACEMENT_SLOT_UNLOCK_REASON,
          {
            fromSlotCount: unlockedSlotCount,
            toSlotCount: unlockedSlotCount + 1,
            cost: unlockCost
          }
        );
        const updatedState = await tx.gachaPlacementState.update({
          where: { id: accruedState.id },
          data: {
            unlockedSlotCount: unlockedSlotCount + 1,
            lastAccrualAt: asOf
          }
        });
        return {
          wallet: await serializeWalletWithPity(tx, updatedWallet),
          placement: serializePlacement(userId, updatedState, ensured.slots, ensured.addons)
        };
      });
      res.json({ ok: true, wallet: result.wallet, placement: result.placement });
    } catch (error: any) {
      if (error?.status === 400) {
        res.status(400).json({ error: error.message });
        return;
      }
      next(error);
    }
  });

  router.post('/placement/addons/colorless/set', async (req, res, next) => {
    try {
      if (!req.authUser) return res.status(401).json({ error: '未登录' });
      const payload = placementAddonSetSchema.parse(req.body ?? {});
      const placement = await runSerializableTransaction(async (tx) => {
        const userId = req.authUser!.id;
        const asOf = now();
        const ensured = await ensurePlacementStateAndSlots(tx, userId);
        const accruedState = await accruePlacementPending(tx, {
          userId,
          state: ensured.state,
          slots: ensured.slots,
          addons: ensured.addons,
          asOf
        });
        const inventory = await tx.gachaInventory.findUnique({
          where: {
            userId_cardId: {
              userId,
              cardId: payload.cardId
            }
          },
          include: { card: true }
        });
        if (!inventory || inventory.count <= 0 || !inventory.card) {
          throw Object.assign(new Error('你还没有这张卡片，无法挂载'), { status: 400 });
        }
        const requestedSignature = payload.affixSignature
          ? affixSignatureFromStyles(parseAffixSignature(payload.affixSignature))
          : null;
        // Find free instances, then filter for COLORLESS
        let freeInstances = await findFreeInstances(tx, userId, payload.cardId, {
          affixSignature: requestedSignature ?? undefined,
          includeLocked: true,
          includeShowcased: true
        });
        freeInstances = freeInstances.filter((inst) => {
          const fingerprint = buildAffixFingerprintFromSignature(inst.affixSignature);
          return fingerprint.affixStyles.includes('COLORLESS');
        });
        if (freeInstances.length === 0) {
          throw Object.assign(new Error('无可挂载的无色词条实例'), { status: 400 });
        }
        const selectedInstance = freeInstances[0];
        const selectedFingerprint = buildAffixFingerprintFromSignature(selectedInstance.affixSignature);
        const selectedSignature = selectedFingerprint.affixSignature;
        const addonSlot = await tx.gachaPlacementSlot.findUnique({
          where: {
            userId_slotIndex: {
              userId,
              slotIndex: 0
            }
          }
        });
        if (!addonSlot) {
          throw Object.assign(new Error('无色词条槽初始化失败，请稍后重试'), { status: 500 });
        }
        const addonCurrentSignature = affixSignatureFromStyles(parseAffixSignature(addonSlot.affixSignature || addonSlot.affixVisualStyle || 'NONE'));
        if (
          addonSlot.cardId !== payload.cardId
          || addonCurrentSignature !== selectedSignature
          || normalizeAffixVisualStyleInput(addonSlot.affixVisualStyle) !== selectedFingerprint.affixVisualStyle
          || String(addonSlot.affixLabel || '') !== selectedFingerprint.affixLabel
        ) {
          await tx.gachaPlacementSlot.update({
            where: { id: addonSlot.id },
            data: {
              cardId: payload.cardId,
              inventoryId: inventory.id,
              instanceId: selectedInstance.id,
              affixVisualStyle: selectedFingerprint.affixVisualStyle as PrismaAffixVisualStyle,
              affixSignature: selectedSignature,
              affixLabel: selectedFingerprint.affixLabel,
              assignedAt: asOf
            }
          });
        }
        const addonChanged = addonSlot.cardId !== payload.cardId
          || addonCurrentSignature !== selectedSignature
          || normalizeAffixVisualStyleInput(addonSlot.affixVisualStyle) !== selectedFingerprint.affixVisualStyle
          || String(addonSlot.affixLabel || '') !== selectedFingerprint.affixLabel;
        const addons = addonChanged
          ? await listPlacementAddons(tx, userId)
          : ensured.addons;
        return serializePlacement(userId, accruedState, ensured.slots, addons);
      });
      res.json({ ok: true, placement });
    } catch (error: any) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ error: error.issues[0]?.message ?? '参数错误' });
        return;
      }
      if (error?.status === 400) {
        res.status(400).json({ error: error.message });
        return;
      }
      next(error);
    }
  });

  router.post('/placement/addons/colorless/clear', async (req, res, next) => {
    try {
      if (!req.authUser) return res.status(401).json({ error: '未登录' });
      const placement = await runSerializableTransaction(async (tx) => {
        const userId = req.authUser!.id;
        const asOf = now();
        const ensured = await ensurePlacementStateAndSlots(tx, userId);
        const accruedState = await accruePlacementPending(tx, {
          userId,
          state: ensured.state,
          slots: ensured.slots,
          addons: ensured.addons,
          asOf
        });
        const addonSlot = await tx.gachaPlacementSlot.findUnique({
          where: {
            userId_slotIndex: {
              userId,
              slotIndex: 0
            }
          }
        });
        if (!addonSlot) {
          throw Object.assign(new Error('无色词条槽初始化失败，请稍后重试'), { status: 500 });
        }
        if (addonSlot.cardId != null) {
          await tx.gachaPlacementSlot.update({
            where: { id: addonSlot.id },
            data: {
              cardId: null,
              inventoryId: null,
              instanceId: null,
              affixVisualStyle: null,
              affixSignature: null,
              affixLabel: null,
              assignedAt: null
            }
          });
        }
        const addons = addonSlot.cardId != null
          ? await listPlacementAddons(tx, userId)
          : ensured.addons;
        return serializePlacement(userId, accruedState, ensured.slots, addons);
      });
      res.json({ ok: true, placement });
    } catch (error) {
      next(error);
    }
  });

  router.post('/placement/claim', async (req, res, next) => {
    try {
      if (!req.authUser) return res.status(401).json({ error: '未登录' });
      const scope = buildIdempotencyScope(req, req.authUser.id);
      let outcome: IdempotencyOutcome;
      try {
        outcome = await runSerializableTransaction(async (tx) => {
          const asOf = now();
          await tx.apiIdempotencyRecord.deleteMany({
            where: {
              userId: scope.userId,
              expireAt: { lte: asOf }
            }
          });
          const existing = await tx.apiIdempotencyRecord.findUnique({
            where: {
              userId_method_path_idemKey: {
                userId: scope.userId,
                method: scope.method,
                path: scope.path,
                idemKey: scope.idemKey
              }
            }
          });
          if (existing) {
            if (existing.requestHash !== scope.requestHash) {
              throw Object.assign(new Error('idempotency_key_conflict'), { status: 409, code: 'IDEMPOTENCY_KEY_CONFLICT' });
            }
            return mapIdempotencyReplay(existing);
          }

          const ensured = await ensurePlacementStateAndSlots(tx, scope.userId);
          const accruedState = await accruePlacementPending(tx, {
            userId: scope.userId,
            state: ensured.state,
            slots: ensured.slots,
            addons: ensured.addons,
            asOf
          });
          const beforePlacement = serializePlacement(scope.userId, accruedState, ensured.slots, ensured.addons);

          let nextOutcome: IdempotencyOutcome;
          if (beforePlacement.claimableToken <= 0) {
            nextOutcome = {
              statusCode: 400,
              responseJson: {
                ok: false,
                error: '当前暂无可领取收益'
              }
            };
          } else {
            const claimToken = beforePlacement.claimableToken;
            const wallet = await ensureWallet(tx, scope.userId);
            const updatedWallet = await tx.gachaWallet.update({
              where: { id: wallet.id },
              data: {
                balance: { increment: claimToken },
                totalEarned: { increment: claimToken }
              }
            });
            const pendingAfter = clampPlacementToken(
              beforePlacement.pendingToken - claimToken,
              beforePlacement.cap
            );
            const stateAfter = await tx.gachaPlacementState.update({
              where: { id: accruedState.id },
              data: {
                pendingToken: toPlacementDecimal(pendingAfter),
                lastAccrualAt: asOf
              }
            });
            await recordLedger(tx, wallet.id, scope.userId, claimToken, 'PLACEMENT_CLAIM', {
              claimToken,
              pendingBefore: beforePlacement.pendingToken,
              pendingAfter
            });
            nextOutcome = {
              statusCode: 200,
              responseJson: {
                ok: true,
                claimedToken: claimToken,
                wallet: await serializeWalletWithPity(tx, updatedWallet),
                placement: serializePlacement(scope.userId, stateAfter, ensured.slots, ensured.addons)
              }
            };
          }

          await tx.apiIdempotencyRecord.create({
            data: {
              userId: scope.userId,
              method: scope.method,
              path: scope.path,
              idemKey: scope.idemKey,
              requestHash: scope.requestHash,
              responseJson: normalizeJsonValue(nextOutcome.responseJson) as Prisma.InputJsonValue,
              statusCode: nextOutcome.statusCode,
              expireAt: new Date(asOf.getTime() + IDEMPOTENCY_TTL_HOURS * 3_600_000)
            }
          });

          return nextOutcome;
        });
      } catch (error) {
        if (!isUniqueConstraintError(error)) {
          throw error;
        }
        const replayed = await replayIdempotencyRecord(scope);
        if (!replayed) {
          throw error;
        }
        outcome = replayed;
      }

      res.status(outcome.statusCode).json(outcome.responseJson);
    } catch (error: any) {
      if (error?.status === 400) {
        res.status(400).json({ error: error.message });
        return;
      }
      if (error?.status === 409 || error?.code === 'IDEMPOTENCY_KEY_CONFLICT') {
        res.status(409).json({ error: 'idempotency_key_conflict' });
        return;
      }
      next(error);
    }
  });

  router.get('/tickets', async (req, res, next) => {
    try {
      if (!req.authUser) return res.status(401).json({ error: '未登录' });
      const result = await runSerializableTransaction(async (tx) => {
        const wallet = await ensureWallet(tx, req.authUser!.id);
        const tickets = await computeTicketBalance(tx, req.authUser!.id);
        return { wallet: await serializeWalletWithPity(tx, wallet), tickets };
      });
      res.json({
        ok: true,
        enabled: FEATURE_FLAGS.tickets,
        tickets: result.tickets,
        wallet: result.wallet,
        ...featureStatusPayload()
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/tickets/draw/use', async (req, res, next) => {
    try {
      if (!req.authUser) return res.status(401).json({ error: '未登录' });
      const drawSnapshot = await loadDrawPoolSnapshot(now());
      const scope = buildIdempotencyScope(req, req.authUser.id);
      const outcome = await executeIdempotent(scope, async (tx) => {
        const userId = req.authUser!.id;
        const wallet = await ensureWallet(tx, userId);
        await consumeTicketBalance(tx, wallet, userId, { drawTicket: 1, draw10Ticket: 0, affixReforgeTicket: 0 }, 'DRAW_TICKET_SINGLE');
        const drawResult = await executeDrawForUser(tx, {
          userId,
          drawCount: 1,
          poolId: PERMANENT_POOL_ID,
          tokensCost: 0,
          spendReason: 'DRAW_TICKET_SPEND',
          spendMetadata: { ticketType: 'drawTicket', drawCount: 1 },
          prefetchedCards: drawSnapshot,
          wallet
        });
        const tickets = await computeTicketBalance(tx, userId);
        return {
          statusCode: 200,
          responseJson: {
            ok: true,
            enabled: FEATURE_FLAGS.tickets,
            tickets,
            data: {
              items: drawResult.responseItems,
              rewardSummary: {
                totalTokens: drawResult.totalRewardTokens,
                byRarity: RARITY_ORDER.map((rarity) => ({
                  rarity,
                  count: drawResult.rarityCounter[rarity] ?? 0
                }))
              },
              wallet: serializeWallet(drawResult.wallet, drawResult.pityCounters)
            },
            ...featureStatusPayload()
          }
        };
      });
      res.status(outcome.statusCode).json(outcome.responseJson);
    } catch (error: any) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ error: error.issues[0]?.message ?? '参数错误' });
        return;
      }
      if (error?.status === 404) {
        res.status(404).json({ error: error.message });
        return;
      }
      if (error?.status === 400) {
        res.status(400).json({ error: error.message });
        return;
      }
      if (error?.status === 409 || error?.code === 'IDEMPOTENCY_KEY_CONFLICT') {
        res.status(409).json({ error: 'idempotency_key_conflict' });
        return;
      }
      next(error);
    }
  });

  router.post('/tickets/draw10/use', async (req, res, next) => {
    try {
      if (!req.authUser) return res.status(401).json({ error: '未登录' });
      const drawSnapshot = await loadDrawPoolSnapshot(now());
      const scope = buildIdempotencyScope(req, req.authUser.id);
      const outcome = await executeIdempotent(scope, async (tx) => {
        const userId = req.authUser!.id;
        const wallet = await ensureWallet(tx, userId);
        await consumeTicketBalance(tx, wallet, userId, { drawTicket: 0, draw10Ticket: 1, affixReforgeTicket: 0 }, 'DRAW_TICKET_TEN');
        const drawResult = await executeDrawForUser(tx, {
          userId,
          drawCount: 10,
          poolId: PERMANENT_POOL_ID,
          tokensCost: 0,
          spendReason: 'DRAW_TICKET_SPEND',
          spendMetadata: { ticketType: 'draw10Ticket', drawCount: 10 },
          prefetchedCards: drawSnapshot,
          wallet
        });
        const tickets = await computeTicketBalance(tx, userId);
        return {
          statusCode: 200,
          responseJson: {
            ok: true,
            enabled: FEATURE_FLAGS.tickets,
            tickets,
            data: {
              items: drawResult.responseItems,
              rewardSummary: {
                totalTokens: drawResult.totalRewardTokens,
                byRarity: RARITY_ORDER.map((rarity) => ({
                  rarity,
                  count: drawResult.rarityCounter[rarity] ?? 0
                }))
              },
              wallet: serializeWallet(drawResult.wallet, drawResult.pityCounters)
            },
            ...featureStatusPayload()
          }
        };
      });
      res.status(outcome.statusCode).json(outcome.responseJson);
    } catch (error: any) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ error: error.issues[0]?.message ?? '参数错误' });
        return;
      }
      if (error?.status === 404) {
        res.status(404).json({ error: error.message });
        return;
      }
      if (error?.status === 400) {
        res.status(400).json({ error: error.message });
        return;
      }
      if (error?.status === 409 || error?.code === 'IDEMPOTENCY_KEY_CONFLICT') {
        res.status(409).json({ error: 'idempotency_key_conflict' });
        return;
      }
      next(error);
    }
  });

  router.post('/tickets/affix-reforge/use', async (req, res, next) => {
    try {
      if (!req.authUser) return res.status(401).json({ error: '未登录' });
      const payload = ticketReforgeSchema.parse(req.body ?? {});
      const scope = buildIdempotencyScope(req, req.authUser.id);
      const outcome = await executeIdempotent(scope, async (tx) => {
        const userId = req.authUser!.id;
        const requestedSignature = payload.affixSignature
          ? affixSignatureFromStyles(parseAffixSignature(payload.affixSignature))
          : undefined;
        const wallet = await ensureWallet(tx, userId);
        await consumeTicketBalance(tx, wallet, userId, { drawTicket: 0, draw10Ticket: 0, affixReforgeTicket: 1 }, 'AFFIX_REFORGE');

        const inventoryCandidates = payload.cardId
          ? await tx.gachaInventory.findMany({
            where: {
              userId,
              cardId: payload.cardId,
              count: { gt: 0 }
            },
            include: { card: true },
            take: 1
          })
          : await tx.gachaInventory.findMany({
            where: {
              userId,
              count: { gt: 0 }
            },
            include: { card: true }
          });

        if (!inventoryCandidates.length) {
          throw Object.assign(new Error(payload.cardId ? '未找到可改造的卡片实例' : '暂无可改造卡片'), { status: 400 });
        }

        // Batch-load free instances for candidate cards
        const candidateCardIds = Array.from(new Set(
          inventoryCandidates.map((item) => item.cardId).filter(Boolean)
        ));
        const allFreeForReforge = candidateCardIds.length > 0
          ? await tx.gachaCardInstance.findMany({
            where: {
              userId,
              cardId: { in: candidateCardIds },
              tradeListingId: null,
              buyRequestId: null
            },
            orderBy: { obtainedAt: 'asc' }
          })
          : [];
        const freeByCard = new Map<string, typeof allFreeForReforge>();
        for (const inst of allFreeForReforge) {
          const list = freeByCard.get(inst.cardId) ?? [];
          list.push(inst);
          freeByCard.set(inst.cardId, list);
        }

        type CandidateForReforge = {
          inventory: NonNullable<typeof inventoryCandidates[number]> & { card: NonNullable<typeof inventoryCandidates[number]['card']> };
          freeInstances: typeof allFreeForReforge;
          totalCount: number;
        };
        const candidateStates: CandidateForReforge[] = [];
        for (const item of inventoryCandidates) {
          if (!item.card) continue;
          const freeInstances = (freeByCard.get(item.cardId) ?? []).filter((inst) => (
            !requestedSignature || inst.affixSignature === requestedSignature
          ));
          if (freeInstances.length <= 0) continue;
          candidateStates.push({
            inventory: item as NonNullable<typeof inventoryCandidates[number]> & { card: NonNullable<typeof inventoryCandidates[number]['card']> },
            freeInstances,
            totalCount: freeInstances.length
          });
        }

        if (!candidateStates.length) {
          throw Object.assign(
            new Error(payload.cardId
              ? (requestedSignature ? `该卡片暂无词条 ${requestedSignature} 可改造实例` : '该卡片暂无可改造变体')
              : (requestedSignature ? `暂无词条 ${requestedSignature} 可改造实例` : '暂无可改造卡片')),
            { status: 400 }
          );
        }

        let selected = candidateStates[0]!;
        if (!payload.cardId) {
          const totalAll = candidateStates.reduce((sum, item) => sum + item.totalCount, 0);
          let pick = Math.floor(Math.random() * totalAll);
          for (const item of candidateStates) {
            if (pick < item.totalCount) {
              selected = item;
              break;
            }
            pick -= item.totalCount;
          }
        }

        // Pick the first free instance to reforge
        const targetInstance = selected.freeInstances[0];
        if (!targetInstance) {
          throw Object.assign(new Error('暂无可改造卡片'), { status: 400 });
        }

        const beforeFingerprint = buildAffixFingerprintFromSignature(targetInstance.affixSignature);
        const beforeSignature = beforeFingerprint.affixSignature;
        const beforeStyleCount = beforeFingerprint.affixStyles.filter((style) => style !== 'NONE').length;
        const nextStyles = rollReforgeAffixStyles({
          minCount: Math.max(1, beforeStyleCount),
          excludeSignature: beforeSignature
        });
        const nextFingerprint = buildAffixFingerprintFromStyles(nextStyles);
        const before = {
          affixSignature: beforeFingerprint.affixSignature,
          affixVisualStyle: beforeFingerprint.affixVisualStyle,
          affixLabel: beforeFingerprint.affixLabel
        };

        // Update the instance directly
        await tx.gachaCardInstance.update({
          where: { id: targetInstance.id },
          data: {
            affixSignature: nextFingerprint.affixSignature,
            affixVisualStyle: nextFingerprint.affixVisualStyle as PrismaAffixVisualStyle,
            affixLabel: nextFingerprint.affixLabel
          }
        });

        // If the instance was placed (shouldn't be since we filtered for free, but check anyway)
        let placementUpdated = false;
        const affectedSlot = await tx.gachaPlacementSlot.findFirst({
          where: {
            userId,
            instanceId: targetInstance.id
          }
        });
        if (affectedSlot) {
          await tx.gachaPlacementSlot.update({
            where: { id: affectedSlot.id },
            data: {
              affixVisualStyle: nextFingerprint.affixVisualStyle,
              affixSignature: nextFingerprint.affixSignature,
              affixLabel: nextFingerprint.affixLabel
            }
          });
          placementUpdated = true;
        }

        const tickets = await computeTicketBalance(tx, userId);
        return {
          statusCode: 200,
          responseJson: {
            ok: true,
            enabled: FEATURE_FLAGS.tickets,
            tickets,
            result: {
              cardId: selected.inventory.card.id,
              title: selected.inventory.card.title,
              before,
              after: {
                affixSignature: nextFingerprint.affixSignature,
                affixVisualStyle: nextFingerprint.affixVisualStyle,
                affixLabel: nextFingerprint.affixLabel
              },
              placementUpdated
            },
            ...featureStatusPayload()
          }
        };
      });
      res.status(outcome.statusCode).json(outcome.responseJson);
    } catch (error: any) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ error: error.issues[0]?.message ?? '参数错误' });
        return;
      }
      if (error?.status === 400) {
        res.status(400).json({ error: error.message });
        return;
      }
      if (error?.status === 409 || error?.code === 'IDEMPOTENCY_KEY_CONFLICT') {
        res.status(409).json({ error: 'idempotency_key_conflict' });
        return;
      }
      next(error);
    }
  });

  router.get('/missions', async (req, res, next) => {
    try {
      if (!req.authUser) return res.status(401).json({ error: '未登录' });
      const items = await prisma.$transaction(async (tx) => {
        const snapshots = await loadMissionProgressSnapshots(tx, req.authUser!.id, now());
        const claimedMap = await loadMissionClaimedAtMap(tx, req.authUser!.id);
        return buildMissionItems(snapshots, claimedMap);
      });
      res.json({
        ok: true,
        enabled: FEATURE_FLAGS.missions,
        items,
        ...featureStatusPayload()
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/missions/:missionKey/claim', async (req, res, next) => {
    try {
      if (!req.authUser) return res.status(401).json({ error: '未登录' });
      const { missionKey } = missionClaimParamSchema.parse(req.params ?? {});
      const result = await runSerializableTransaction(async (tx) => {
        const userId = req.authUser!.id;
        const asOf = now();
        let wallet = await ensureWallet(tx, userId);
        const snapshots = await loadMissionProgressSnapshots(tx, userId, asOf);
        const claimedMap = await loadMissionClaimedAtMap(tx, userId);
        const mission = buildMissionItems(snapshots, claimedMap).find((item) => item.missionKey === missionKey);
        if (!mission) {
          throw Object.assign(new Error('任务不存在'), { status: 404 });
        }
        if (mission.claimed) {
          throw Object.assign(new Error('该任务奖励已领取'), { status: 400 });
        }
        if (!mission.claimable) {
          throw Object.assign(new Error('任务尚未达成'), { status: 400 });
        }
        const rewardResult = await applyRewardPack(tx, wallet, userId, mission.reward, MISSION_CLAIM_REASON, mission.missionKey);
        wallet = rewardResult.wallet;
        await recordLedger(tx, wallet.id, userId, 0, MISSION_CLAIM_REASON, {
          missionKey: mission.missionKey,
          periodType: mission.periodType,
          periodKey: mission.periodKey,
          spendToken: mission.progress,
          reward: rewardResult.reward
        });
        const tickets = await computeTicketBalance(tx, userId);
        return {
          mission: {
            ...mission,
            claimed: true,
            claimable: false,
            claimedAt: asOf.toISOString()
          },
          wallet: await serializeWalletWithPity(tx, wallet),
          tickets
        };
      });
      res.json({
        ok: true,
        enabled: FEATURE_FLAGS.missions,
        mission: result.mission,
        wallet: result.wallet,
        tickets: result.tickets,
        ...featureStatusPayload()
      });
    } catch (error: any) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ error: error.issues[0]?.message ?? '参数错误' });
        return;
      }
      if (error?.status === 404) {
        res.status(404).json({ error: error.message });
        return;
      }
      if (error?.status === 400) {
        res.status(400).json({ error: error.message });
        return;
      }
      next(error);
    }
  });

  router.post('/missions/claim-all', async (req, res, next) => {
    try {
      if (!req.authUser) return res.status(401).json({ error: '未登录' });
      const result = await runSerializableTransaction(async (tx) => {
        const userId = req.authUser!.id;
        const asOf = now();
        let wallet = await ensureWallet(tx, userId);
        const snapshots = await loadMissionProgressSnapshots(tx, userId, asOf);
        const claimedMap = await loadMissionClaimedAtMap(tx, userId);
        const missionItems = buildMissionItems(snapshots, claimedMap);
        const claimable = missionItems.filter((item) => item.claimable && !item.claimed);
        const claimedItems: Array<{ missionKey: string; periodKey: string; claimedAt: string }> = [];
        for (const mission of claimable) {
          // eslint-disable-next-line no-await-in-loop
          const rewardResult = await applyRewardPack(tx, wallet, userId, mission.reward, MISSION_CLAIM_REASON, mission.missionKey);
          wallet = rewardResult.wallet;
          // eslint-disable-next-line no-await-in-loop
          await recordLedger(tx, wallet.id, userId, 0, MISSION_CLAIM_REASON, {
            missionKey: mission.missionKey,
            periodType: mission.periodType,
            periodKey: mission.periodKey,
            spendToken: mission.progress,
            reward: rewardResult.reward
          });
          claimedItems.push({
            missionKey: mission.missionKey,
            periodKey: mission.periodKey,
            claimedAt: asOf.toISOString()
          });
        }
        const tickets = await computeTicketBalance(tx, userId);
        return { claimedItems, wallet: await serializeWalletWithPity(tx, wallet), tickets };
      });
      res.json({
        ok: true,
        enabled: FEATURE_FLAGS.missions,
        claimed: result.claimedItems.length,
        items: result.claimedItems,
        wallet: result.wallet,
        tickets: result.tickets,
        ...featureStatusPayload()
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/achievements', async (req, res, next) => {
    try {
      if (!req.authUser) return res.status(401).json({ error: '未登录' });
      const items = await prisma.$transaction(async (tx) => {
        const stats = await loadUserGachaStats(tx, req.authUser!.id);
        const claimedMap = await loadClaimedAtMap(tx, req.authUser!.id, ACHIEVEMENT_CLAIM_REASON, 'achievementKey');
        return buildAchievementItems(stats, claimedMap);
      });
      res.json({
        ok: true,
        enabled: FEATURE_FLAGS.achievements,
        items,
        ...featureStatusPayload()
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/achievements/:achievementKey/claim', async (req, res, next) => {
    try {
      if (!req.authUser) return res.status(401).json({ error: '未登录' });
      const { achievementKey } = achievementClaimParamSchema.parse(req.params ?? {});
      const result = await runSerializableTransaction(async (tx) => {
        const userId = req.authUser!.id;
        let wallet = await ensureWallet(tx, userId);
        const stats = await loadUserGachaStats(tx, userId);
        const claimedMap = await loadClaimedAtMap(tx, userId, ACHIEVEMENT_CLAIM_REASON, 'achievementKey');
        const achievement = buildAchievementItems(stats, claimedMap)
          .find((item) => item.achievementKey === achievementKey);
        if (!achievement) {
          throw Object.assign(new Error('成就不存在'), { status: 404 });
        }
        if (achievement.claimed) {
          throw Object.assign(new Error('该成就奖励已领取'), { status: 400 });
        }
        if (!achievement.claimable) {
          throw Object.assign(new Error('成就尚未达成'), { status: 400 });
        }
        const rewardResult = await applyRewardPack(tx, wallet, userId, achievement.reward, ACHIEVEMENT_CLAIM_REASON, achievement.achievementKey);
        wallet = rewardResult.wallet;
        await recordLedger(tx, wallet.id, userId, 0, ACHIEVEMENT_CLAIM_REASON, {
          achievementKey: achievement.achievementKey,
          reward: rewardResult.reward
        });
        const tickets = await computeTicketBalance(tx, userId);
        return {
          achievement: {
            ...achievement,
            claimed: true,
            claimable: false,
            claimedAt: now().toISOString()
          },
          wallet: await serializeWalletWithPity(tx, wallet),
          tickets
        };
      });
      res.json({
        ok: true,
        enabled: FEATURE_FLAGS.achievements,
        achievement: result.achievement,
        wallet: result.wallet,
        tickets: result.tickets,
        ...featureStatusPayload()
      });
    } catch (error: any) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ error: error.issues[0]?.message ?? '参数错误' });
        return;
      }
      if (error?.status === 404) {
        res.status(404).json({ error: error.message });
        return;
      }
      if (error?.status === 400) {
        res.status(400).json({ error: error.message });
        return;
      }
      next(error);
    }
  });

  router.post('/achievements/claim-all', async (req, res, next) => {
    try {
      if (!req.authUser) return res.status(401).json({ error: '未登录' });
      const result = await runSerializableTransaction(async (tx) => {
        const userId = req.authUser!.id;
        let wallet = await ensureWallet(tx, userId);
        const stats = await loadUserGachaStats(tx, userId);
        const claimedMap = await loadClaimedAtMap(tx, userId, ACHIEVEMENT_CLAIM_REASON, 'achievementKey');
        const achievementItems = buildAchievementItems(stats, claimedMap);
        const claimable = achievementItems.filter((item) => item.claimable && !item.claimed);
        const claimedItems: Array<{ achievementKey: string; claimedAt: string }> = [];
        for (const achievement of claimable) {
          // eslint-disable-next-line no-await-in-loop
          const rewardResult = await applyRewardPack(tx, wallet, userId, achievement.reward, ACHIEVEMENT_CLAIM_REASON, achievement.achievementKey);
          wallet = rewardResult.wallet;
          // eslint-disable-next-line no-await-in-loop
          await recordLedger(tx, wallet.id, userId, 0, ACHIEVEMENT_CLAIM_REASON, {
            achievementKey: achievement.achievementKey,
            reward: rewardResult.reward
          });
          claimedItems.push({
            achievementKey: achievement.achievementKey,
            claimedAt: now().toISOString()
          });
        }
        const tickets = await computeTicketBalance(tx, userId);
        return { claimedItems, wallet: await serializeWalletWithPity(tx, wallet), tickets };
      });
      res.json({
        ok: true,
        enabled: FEATURE_FLAGS.achievements,
        claimed: result.claimedItems.length,
        items: result.claimedItems,
        wallet: result.wallet,
        tickets: result.tickets,
        ...featureStatusPayload()
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/market/contracts', async (req, res, next) => {
    try {
      const asOf = now();
      const timeframeRaw = (req.query as Record<string, unknown> | undefined)?.timeframe;
      const timeframe = normalizeMarketTimeframe(typeof timeframeRaw === 'string' ? timeframeRaw : undefined);
      const contextLimit = Math.max(ORACLE_TICK_LIMIT_SNAPSHOT, oracleLimitForTimeframe(asOf, timeframe));
      const context = await loadOracleContext(asOf, contextLimit);
      const orderedContracts = MARKET_CATEGORIES
        .map((category) => resolveMarketContract(category))
        .filter((contract): contract is MarketContractDefinition => Boolean(contract));
      res.json({
        ok: true,
        enabled: FEATURE_FLAGS.market,
        timeframe,
        items: orderedContracts.map((contract) => buildMarketContractSnapshot(contract, context, timeframe)),
        lockTiers: MARKET_LOCK_TIERS.map((lockTier) => {
          const tier = MARKET_LOCK_TIER_CONFIG[lockTier];
          return {
            lockTier,
            durationHours: Math.round(tier.durationMs / (60 * 60 * 1000)),
            minLots: tier.minLots,
            lotToken: MARKET_LOT_TOKEN,
            leverageOptions: tier.leverageOptions,
            openFeeBaseRate: tier.openFeeBaseRate,
            settleFeeRate: tier.settleFeeRate
          };
        }),
        ...featureStatusPayload()
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/market/ticks', async (req, res, next) => {
    try {
      const parsed = marketTicksQuerySchema.parse(req.query ?? {});
      const contract = resolveMarketContract(parsed.contractId || parsed.category || MARKET_CONTRACTS[0]!.id);
      if (!contract) {
        res.status(404).json({ error: '合约不存在' });
        return;
      }
      const asOf = now();
      const timeframe = normalizeMarketTimeframe(parsed.timeframe);
      const context = await loadOracleContextForCategories([contract.category], asOf, oracleLimitForTimeframe(asOf, timeframe));
      const rangeStart = timeframeRangeStart(asOf, timeframe);
      const defaultLimit = Math.max(24, timeframeHours(asOf, timeframe) + 2);
      const items = buildMarketTickSeries(contract, context, timeframe, parsed.limit ?? defaultLimit);
      const candles = buildMarketCandles(items, timeframe, asOf);
      const rangeStartTs = rangeStart.getTime();
      const entries = await listMarketLedgerEntries(prisma, req.authUser!.id, asOf);
      const openMap = new Map<string, MarketOpenPosition>();
      const settlementMap = new Map<string, MarketSettlementRecord>();
      for (const entry of entries) {
        if (entry.reason === MARKET_OPEN_REASON) {
          const parsedOpen = parseMarketOpenPosition(entry.metadata, entry.createdAt);
          if (!parsedOpen || parsedOpen.contractId !== contract.id) continue;
          openMap.set(parsedOpen.positionId, parsedOpen);
          continue;
        }
        if (entry.reason === MARKET_SETTLE_REASON) {
          const parsedSettlement = parseMarketSettlement(entry.metadata, entry.createdAt);
          if (!parsedSettlement || parsedSettlement.contractId !== contract.id) continue;
          settlementMap.set(parsedSettlement.positionId, parsedSettlement);
        }
      }
      const markers = [
        ...Array.from(openMap.values())
          .filter((position) => !settlementMap.has(position.positionId))
          .map((position) => ({
            ts: position.entryTickTs || position.openedAt,
            side: position.side,
            kind: 'OPEN' as const,
            price: Number(position.entryIndex ?? position.entryPrice ?? 0),
            positionId: position.positionId
          })),
        ...Array.from(settlementMap.values()).flatMap((position) => {
          const historyMarkers: Array<{
            ts: string;
            side: MarketPositionSide;
            kind: 'SETTLE' | 'EXPIRE';
            price: number;
            positionId: string;
          }> = [
            {
              ts: position.settledAt,
              side: position.side,
              kind: 'SETTLE' as const,
              price: Number(position.settleIndex ?? position.exitPrice ?? 0),
              positionId: position.positionId
            }
          ];
          if (position.status !== 'LIQUIDATED') {
            historyMarkers.push({
              ts: position.expireAt,
              side: position.side,
              kind: 'EXPIRE' as const,
              price: Number(position.settleIndex ?? position.exitPrice ?? 0),
              positionId: position.positionId
            });
          }
          return historyMarkers;
        })
      ]
        .filter((item) => {
          const ts = new Date(item.ts).getTime();
          if (!Number.isFinite(ts)) return false;
          if (ts < rangeStartTs || ts > asOf.getTime()) return false;
          return true;
        })
        .map((item) => ({
          ts: new Date(item.ts).toISOString(),
          side: item.side,
          kind: item.kind,
          price: Number(item.price || 0),
          positionId: item.positionId
        }))
        .sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
      const latestTick = items.length > 0 ? items[items.length - 1]! : null;
      const latestTickAsOfTs = latestTick?.asOfTs ? new Date(latestTick.asOfTs) : null;
      const latestWatermarkTs = latestTick?.watermarkTs ? new Date(latestTick.watermarkTs) : null;
      const tickLagMs = latestTickAsOfTs && Number.isFinite(latestTickAsOfTs.getTime())
        ? Math.max(0, asOf.getTime() - latestTickAsOfTs.getTime())
        : null;
      const watermarkLagMs = latestWatermarkTs && Number.isFinite(latestWatermarkTs.getTime())
        ? Math.max(0, asOf.getTime() - latestWatermarkTs.getTime())
        : null;
      const staleLevel = (tickLagMs != null && tickLagMs >= 3 * 60 * 60 * 1000)
        || (watermarkLagMs != null && watermarkLagMs >= 4 * 60 * 60 * 1000)
        ? 'stale'
        : (tickLagMs != null && tickLagMs >= 90 * 60 * 1000)
          || (watermarkLagMs != null && watermarkLagMs >= 2 * 60 * 60 * 1000)
          ? 'lagging'
          : 'ok';
      res.json({
        ok: true,
        enabled: FEATURE_FLAGS.market,
        timeframe,
        contract: buildMarketContractSnapshot(contract, context, timeframe),
        items,
        candles,
        markers,
        diagnostics: {
          asOfTs: asOf.toISOString(),
          latestTickAsOfTs: latestTickAsOfTs ? latestTickAsOfTs.toISOString() : null,
          latestWatermarkTs: latestWatermarkTs ? latestWatermarkTs.toISOString() : null,
          latestVoteCutoffDate: latestTick?.voteCutoffDate ?? null,
          tickLagMs,
          watermarkLagMs,
          staleLevel
        },
        ...featureStatusPayload()
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ error: error.issues[0]?.message ?? '参数错误' });
        return;
      }
      next(error);
    }
  });

  router.get('/market/opponents', async (req, res, next) => {
    try {
      const parsed = marketOpponentsQuerySchema.parse(req.query ?? {});
      const asOf = now();
      const contract = resolveMarketContract(parsed.contractId || parsed.category || MARKET_CONTRACTS[0]!.id);
      if (!contract) {
        res.status(404).json({ error: '合约不存在' });
        return;
      }
      const context = await loadOracleContextForCategories([contract.category], asOf, ORACLE_TICK_LIMIT_SNAPSHOT);
      const lockTier = parsed.lockTier ? resolveMarketLockTier(parsed.lockTier) : null;

      const activePositions = await loadGlobalMarketOpenPositions(prisma, asOf);
      const scopedPositions = activePositions.filter((position) => {
        if (position.contractId !== contract.id && position.category !== contract.category) return false;
        if (lockTier && position.lockTier !== lockTier) return false;
        return true;
      });
      const longPositions = scopedPositions.filter((item) => item.side === 'LONG');
      const shortPositions = scopedPositions.filter((item) => item.side === 'SHORT');
      const longUsers = new Set(longPositions.map((item) => item.userId)).size;
      const shortUsers = new Set(shortPositions.map((item) => item.userId)).size;
      const longLots = longPositions.reduce((sum, item) => sum + item.lots, 0);
      const shortLots = shortPositions.reduce((sum, item) => sum + item.lots, 0);
      const longMargin = longPositions.reduce((sum, item) => sum + item.margin, 0);
      const shortMargin = shortPositions.reduce((sum, item) => sum + item.margin, 0);
      const participantMap = groupMarketParticipants(scopedPositions);
      const userIds = Array.from(participantMap.keys());
      const participantUsers = userIds.length > 0
        ? await prisma.userAccount.findMany({
            where: { id: { in: userIds } },
            select: {
              id: true,
              displayName: true,
              linkedWikidotId: true
            }
          })
        : [];
      const participantUserMap = new Map(participantUsers.map((item: {
        id: string;
        displayName: string | null;
        linkedWikidotId: number | null;
      }) => [item.id, item]));
      const leaderboard = sortMarketParticipants(Array.from(participantMap.values()))
        .slice(0, 8)
        .map((entry, index) => {
          const user = participantUserMap.get(entry.userId);
          const totalMargin = positionTotalMargin(entry);
          const netMargin = positionNetMargin(entry);
          return {
            rank: index + 1,
            userId: entry.userId,
            displayName: toDisplayName(user?.displayName ?? null, entry.userId),
            linkedWikidotId: user?.linkedWikidotId ?? null,
            balance: totalMargin,
            totalMargin,
            netMargin,
            longLots: entry.longLots,
            shortLots: entry.shortLots,
            longMargin: entry.longMargin,
            shortMargin: entry.shortMargin
          };
        });
      const primary = buildMarketContractSnapshot(contract, context);
      res.json({
        ok: true,
        enabled: FEATURE_FLAGS.market,
        snapshot: {
          asOfTs: asOf.toISOString(),
          updatedAt: asOf.toISOString(),
          category: contract.category,
          contractId: contract.id,
          lockTier,
          mood: longMargin === shortMargin ? 'neutral' : longMargin > shortMargin ? 'bullish' : 'bearish',
          benchmark: primary,
          longUsers,
          shortUsers,
          longLots,
          shortLots,
          longMargin,
          shortMargin,
          leaderboard
        },
        ...featureStatusPayload()
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ error: error.issues[0]?.message ?? '参数错误' });
        return;
      }
      next(error);
    }
  });

  router.post('/market/positions/open', async (req, res, next) => {
    try {
      if (!req.authUser) return res.status(401).json({ error: '未登录' });
      const payload = marketPositionOpenSchema.parse(req.body ?? {});
      const contract = resolveMarketContract(payload.contractId);
      if (!contract) {
        res.status(404).json({ error: '合约不存在' });
        return;
      }
      const asOf = now();
      const oracleContext = await loadOracleContext(asOf, ORACLE_TICK_LIMIT_POSITION);
      const scope = buildIdempotencyScope(req, req.authUser.id);
      const outcome = await executeIdempotent(scope, async (tx) => {
        const userId = req.authUser!.id;
        const lockTier = resolveMarketLockTier(payload.lockTier);
        const tier = MARKET_LOCK_TIER_CONFIG[lockTier];
        const leverage = payload.leverage;
        if (!tier.leverageOptions.includes(leverage)) {
          throw Object.assign(new Error(`锁仓档位 ${lockTier} 不支持 ${leverage}x 杠杆`), { status: 400 });
        }
        if (payload.stake != null && payload.lots == null && payload.stake % MARKET_LOT_TOKEN !== 0) {
          throw Object.assign(new Error(`stake 必须是 ${MARKET_LOT_TOKEN} 的倍数`), { status: 400 });
        }
        const lots = payload.lots != null
          ? payload.lots
          : Math.floor((payload.stake ?? 0) / MARKET_LOT_TOKEN);
        if (lots < tier.minLots) {
          throw Object.assign(new Error(`${lockTier} 最低手数为 ${tier.minLots}`), { status: 400 });
        }
        const margin = marketMarginByLots(lots);
        const { openFeeRate, openFee } = marketOpenFee(lockTier, leverage, margin);
        const totalCost = margin + openFee;

        let wallet = await ensureWallet(tx, userId);
        const settled = await settleDueMarketPositions(tx, userId, wallet, oracleContext, asOf);
        wallet = settled.wallet;
        const state = settled.state;
        if (state.active.length >= MARKET_POSITION_MAX_OPEN) {
          throw Object.assign(new Error(`最多同时持有 ${MARKET_POSITION_MAX_OPEN} 个仓位`), { status: 400 });
        }
        if (wallet.balance < totalCost) {
          throw Object.assign(new Error('Token 余额不足，无法开仓'), { status: 400 });
        }
        const positionId = createRuntimeId('mpos');
        const entryTick = marketTickAt(contract, asOf, oracleContext);
        if (!entryTick) {
          throw Object.assign(new Error('当前合约暂无可用 Oracle tick，请稍后再试'), { status: 503 });
        }
        const entryIndex = Number(entryTick.indexMark);
        const entryTickTs = entryTick.asOfTs.toISOString();
        const expireAt = new Date(asOf.getTime() + tier.durationMs).toISOString();
        wallet = await applyWalletDelta(tx, wallet, -totalCost, MARKET_OPEN_SPEND_REASON, {
          positionId,
          contractId: contract.id,
          side: payload.side,
          lockTier,
          lots,
          margin,
          stake: margin,
          openFee,
          openFeeRate,
          leverage,
          entryIndex,
          entryPrice: entryIndex,
          entryTickTs,
          expireAt,
          openedAt: asOf.toISOString(),
          spendToken: totalCost
        });
        await recordLedger(tx, wallet.id, userId, 0, MARKET_OPEN_REASON, {
          positionId,
          contractId: contract.id,
          side: payload.side,
          lockTier,
          lots,
          margin,
          stake: margin,
          openFee,
          openFeeRate,
          leverage,
          entryIndex,
          entryPrice: entryIndex,
          entryTickTs,
          expireAt,
          openedAt: asOf.toISOString()
        });
        invalidateGlobalMarketPositionCache();
        return {
          statusCode: 200,
          responseJson: {
            ok: true,
            enabled: FEATURE_FLAGS.market,
            wallet: await serializeWalletWithPity(tx, wallet),
            position: {
              positionId,
              contractId: contract.id,
              side: payload.side,
              status: 'OPEN' as const,
              lockTier,
              lots,
              margin,
              stake: margin,
              openFee,
              leverage,
              entryIndex,
              entryPrice: entryIndex,
              entryTickTs,
              expireAt,
              openedAt: asOf.toISOString()
            },
            ...featureStatusPayload()
          }
        };
      });
      res.status(outcome.statusCode).json(outcome.responseJson);
    } catch (error: any) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ error: error.issues[0]?.message ?? '参数错误' });
        return;
      }
      if (error?.status === 400) {
        res.status(400).json({ error: error.message });
        return;
      }
      if (error?.status === 503) {
        res.status(503).json({ error: error.message });
        return;
      }
      if (error?.status === 409 || error?.code === 'IDEMPOTENCY_KEY_CONFLICT') {
        res.status(409).json({ error: 'idempotency_key_conflict' });
        return;
      }
      next(error);
    }
  });

  router.get('/market/positions', async (req, res, next) => {
    try {
      if (!req.authUser) return res.status(401).json({ error: '未登录' });
      const asOf = now();
      const oracleContext = await loadOracleContext(asOf, ORACLE_TICK_LIMIT_POSITION);
      const result = await runSerializableTransaction(async (tx) => {
        const userId = req.authUser!.id;
        let wallet = await ensureWallet(tx, userId);
        const settled = await settleDueMarketPositions(tx, userId, wallet, oracleContext, asOf);
        wallet = settled.wallet;
        const state = settled.state;
        return { wallet: await serializeWalletWithPity(tx, wallet), state, settled: settled.settlements };
      });
      res.json({
        ok: true,
        enabled: FEATURE_FLAGS.market,
        items: result.state.active,
        autoSettled: result.settled,
        wallet: result.wallet,
        ...featureStatusPayload()
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/market/positions/history', async (req, res, next) => {
    try {
      if (!req.authUser) return res.status(401).json({ error: '未登录' });
      const parsed = marketHistoryQuerySchema.parse(req.query ?? {});
      const limit = parsed.limit ?? 30;
      const asOf = now();
      const oracleContext = await loadOracleContext(asOf, ORACLE_TICK_LIMIT_POSITION);
      const result = await runSerializableTransaction(async (tx) => {
        const userId = req.authUser!.id;
        const wallet = await ensureWallet(tx, userId);
        const settled = await settleDueMarketPositions(tx, userId, wallet, oracleContext, asOf);
        return settled.state.history.slice(0, limit);
      });
      res.json({
        ok: true,
        enabled: FEATURE_FLAGS.market,
        items: result,
        ...featureStatusPayload()
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ error: error.issues[0]?.message ?? '参数错误' });
        return;
      }
      next(error);
    }
  });

  router.get('/market/settlements', async (req, res, next) => {
    try {
      if (!req.authUser) return res.status(401).json({ error: '未登录' });
      const parsed = marketHistoryQuerySchema.parse(req.query ?? {});
      const limit = parsed.limit ?? 20;
      const asOf = now();
      const oracleContext = await loadOracleContext(asOf, ORACLE_TICK_LIMIT_POSITION);
      const result = await runSerializableTransaction(async (tx) => {
        const userId = req.authUser!.id;
        const wallet = await ensureWallet(tx, userId);
        const settled = await settleDueMarketPositions(tx, userId, wallet, oracleContext, asOf);
        const state = settled.state;
        const history = state.history.slice(0, limit);
        const pnlTotal = history.reduce((sum, item) => sum + item.pnl, 0);
        return {
          autoSettled: settled.settlements,
          history,
          summary: {
            total: history.length,
            pnl: pnlTotal
          }
        };
      });
      res.json({
        ok: true,
        enabled: FEATURE_FLAGS.market,
        items: result.history,
        autoSettled: result.autoSettled,
        summary: result.summary,
        ...featureStatusPayload()
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ error: error.issues[0]?.message ?? '参数错误' });
        return;
      }
      next(error);
    }
  });

  // Lightweight endpoint: return only cardIds the user owns (count > 0)
  router.get('/trade/owned-card-ids', async (req, res, next) => {
    try {
      if (!req.authUser) return res.status(401).json({ error: '未登录' });
      const rows = await prisma.gachaInventory.findMany({
        where: { userId: req.authUser.id, count: { gt: 0 } },
        select: { cardId: true }
      });
      res.json({
        ok: true,
        cardIds: rows.map((r) => r.cardId)
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/trade/listings', async (req, res, next) => {
    try {
      if (!req.authUser) return res.status(401).json({ error: '未登录' });
      const parsed = tradeListingsQuerySchema.parse(req.query ?? {});
      const limit = tradeListingQueryLimit(parsed.limit, 20);
      const offset = Math.max(Number(parsed.offset ?? '0'), 0);
      const status = parsed.status ?? 'OPEN';
      const where: Prisma.GachaTradeListingWhereInput = {};
      const andConditions: Prisma.GachaTradeListingWhereInput[] = [];
      const asOf = now();
      if (status !== 'ALL') {
        where.status = status;
      }
      if (status === 'OPEN') {
        andConditions.push(
          {
            OR: [
              { expiresAt: null },
              { expiresAt: { gt: asOf } }
            ]
          }
        );
      }
      if (parsed.cardId) {
        where.cardId = parsed.cardId;
      }
      if (parsed.mine === '1' && req.authUser?.id) {
        andConditions.push({
          OR: [
          { sellerId: req.authUser.id },
          { buyerId: req.authUser.id }
          ]
        });
      }
      if (parsed.rarity) {
        andConditions.push({
          card: {
            is: {
              rarity: parsed.rarity
            }
          }
        });
      }
      const searchMode = parsed.searchMode ?? 'ALL';
      const searchWhere = await buildTradeListingSearchWhere(parsed.search ?? '', searchMode);
      if (searchWhere) {
        andConditions.push(searchWhere);
      }
      if (andConditions.length > 0) {
        where.AND = andConditions;
      }
      const sortMode = parsed.sort ?? 'LATEST';
      triggerTradeExpirySweep();
      const [items, total] = await Promise.all([
        prisma.gachaTradeListing.findMany({
          where,
          orderBy: buildTradeListingOrderBy(sortMode),
          skip: offset,
          take: limit,
          include: {
            card: true,
            seller: {
              select: {
                id: true,
                displayName: true,
                linkedWikidotId: true
              }
            },
            buyer: {
              select: {
                id: true,
                displayName: true,
                linkedWikidotId: true
              }
            }
          }
        }),
        prisma.gachaTradeListing.count({ where })
      ]);

      res.json({
        ok: true,
        enabled: FEATURE_FLAGS.trade,
        items: items.map(serializeTradeListing),
        pagination: {
          total,
          limit,
          offset
        },
        ...featureStatusPayload()
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ error: error.issues[0]?.message ?? '参数错误' });
        return;
      }
      next(error);
    }
  });

  router.get('/trade/my-listings', async (req, res, next) => {
    try {
      if (!req.authUser) return res.status(401).json({ error: '未登录' });
      triggerTradeExpirySweep();
      const statusRaw = (typeof req.query?.status === 'string' ? req.query.status.toUpperCase() : '') as string;
      const validStatuses = ['OPEN', 'SOLD', 'CANCELLED', 'EXPIRED'] as const;
      const statusFilter = validStatuses.includes(statusRaw as any) ? statusRaw as typeof validStatuses[number] : null;
      const limit = Math.min(Math.max(Number(req.query?.limit ?? '40'), 1), 200);
      const offset = Math.max(Number(req.query?.offset ?? '0'), 0);
      const where = {
        sellerId: req.authUser!.id,
        ...(statusFilter ? { status: statusFilter } : {})
      };
      const [result, total] = await Promise.all([
        prisma.gachaTradeListing.findMany({
          where,
          orderBy: [{ createdAt: 'desc' }],
          take: limit,
          skip: offset,
          include: {
            card: true,
            seller: {
              select: {
                id: true,
                displayName: true,
                linkedWikidotId: true
              }
            },
            buyer: {
              select: {
                id: true,
                displayName: true,
                linkedWikidotId: true
              }
            }
          }
        }),
        prisma.gachaTradeListing.count({ where })
      ]);
      res.json({
        ok: true,
        enabled: FEATURE_FLAGS.trade,
        items: result.map(serializeTradeListing),
        pagination: { total, limit, offset },
        ...featureStatusPayload()
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/trade/listings', async (req, res, next) => {
    try {
      if (!req.authUser) return res.status(401).json({ error: '未登录' });
      const payload = tradeCreateSchema.parse(req.body ?? {});
      const scope = buildIdempotencyScope(req, req.authUser.id);
      triggerTradeExpirySweep();
      const outcome = await executeIdempotent(scope, async (tx) => {
        const userId = req.authUser!.id;
        const card = await tx.gachaCardDefinition.findUnique({
          where: { id: payload.cardId },
          select: { id: true, title: true }
        });
        if (!card) {
          throw Object.assign(new Error('卡片不存在'), { status: 404 });
        }
        const requestedSignature = payload.affixSignature
          ? affixSignatureFromStyles(parseAffixSignature(payload.affixSignature))
          : undefined;
        // Find free instances and lock them for the trade listing
        const freeInstances = await findFreeInstances(tx, userId, card.id, {
          affixSignature: requestedSignature
        });
        if (freeInstances.length < payload.quantity) {
          throw Object.assign(
            new Error(requestedSignature
              ? `可上架数量不足（词条 ${requestedSignature} 实例不足）`
              : '可上架数量不足（已放置或库存不足）'),
            { status: 400 }
          );
        }
        const toLock = freeInstances.slice(0, payload.quantity);
        // Build affix breakdown from selected instances for metadata
        const breakdownMap = new Map<string, number>();
        for (const inst of toLock) {
          breakdownMap.set(inst.affixSignature, (breakdownMap.get(inst.affixSignature) ?? 0) + 1);
        }
        const consumedBreakdown = normalizeTradeAffixBreakdownEntries(
          [...breakdownMap.entries()].map(([affixSignature, count]) => ({ affixSignature, count }))
        );
        const expiresAt = payload.expiresHours
          ? new Date(Date.now() + payload.expiresHours * 3_600_000)
          : null;
        const listing = await tx.gachaTradeListing.create({
          data: {
            sellerId: userId,
            cardId: card.id,
            quantity: payload.quantity,
            remaining: payload.quantity,
            unitPrice: payload.unitPrice,
            totalPrice: payload.unitPrice * payload.quantity,
            expiresAt,
            metadata: serializeTradeListingAffixBreakdown(consumedBreakdown)
          },
          include: {
            card: true,
            seller: {
              select: {
                id: true,
                displayName: true,
                linkedWikidotId: true
              }
            },
            buyer: {
              select: {
                id: true,
                displayName: true,
                linkedWikidotId: true
              }
            }
          }
        });
        // Lock the selected instances for this trade listing
        await lockInstancesForTrade(tx, toLock.map((inst) => inst.id), listing.id);
        const wallet = await ensureWallet(tx, userId);
        await recordLedger(tx, wallet.id, userId, 0, TRADE_LISTING_CREATE_REASON, {
          listingId: listing.id,
          cardId: listing.cardId,
          affixSignature: requestedSignature ?? null,
          quantity: listing.quantity,
          unitPrice: listing.unitPrice
        });
        return {
          statusCode: 200,
          responseJson: {
            ok: true,
            enabled: FEATURE_FLAGS.trade,
            listing: serializeTradeListing(listing),
            wallet: await serializeWalletWithPity(tx, wallet),
            ...featureStatusPayload()
          }
        };
      });
      res.status(outcome.statusCode).json(outcome.responseJson);
    } catch (error: any) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ error: error.issues[0]?.message ?? '参数错误' });
        return;
      }
      if (error?.status === 404) {
        res.status(404).json({ error: error.message });
        return;
      }
      if (error?.status === 400) {
        res.status(400).json({ error: error.message });
        return;
      }
      if (error?.status === 409 || error?.code === 'IDEMPOTENCY_KEY_CONFLICT') {
        res.status(409).json({ error: 'idempotency_key_conflict' });
        return;
      }
      next(error);
    }
  });

  router.post('/trade/listings/:id/buy', async (req, res, next) => {
    try {
      if (!req.authUser) return res.status(401).json({ error: '未登录' });
      const listingId = String(req.params.id || '').trim();
      if (!listingId) {
        res.status(400).json({ error: 'listingId 不能为空' });
        return;
      }
      const payload = tradeBuySchema.parse(req.body ?? {});
      const scope = buildIdempotencyScope(req, req.authUser.id);
      const outcome = await executeIdempotent(scope, async (tx) => {
        const buyerId = req.authUser!.id;
        triggerTradeExpirySweep();
        const listing = await tx.gachaTradeListing.findUnique({
          where: { id: listingId },
          include: {
            card: true,
            seller: {
              select: {
                id: true,
                displayName: true,
                linkedWikidotId: true
              }
            },
            buyer: {
              select: {
                id: true,
                displayName: true,
                linkedWikidotId: true
              }
            }
          }
        });
        if (!listing) {
          throw Object.assign(new Error('挂牌不存在'), { status: 404 });
        }
        const didExpireNow = await expireTradeListingIfNeeded(tx, {
          id: listing.id,
          sellerId: listing.sellerId,
          remaining: listing.remaining,
          status: listing.status,
          expiresAt: listing.expiresAt,
          metadata: listing.metadata,
          card: listing.card
        }, now());
        if (didExpireNow) {
          throw Object.assign(new Error('挂牌已过期'), { status: 400 });
        }
        if (listing.status !== 'OPEN' || listing.remaining <= 0) {
          throw Object.assign(new Error('挂牌已不可购买'), { status: 400 });
        }
        if (listing.sellerId === buyerId) {
          throw Object.assign(new Error('不能购买自己的挂牌'), { status: 400 });
        }
        if (listing.expiresAt && listing.expiresAt.getTime() <= Date.now()) {
          throw Object.assign(new Error('挂牌已过期'), { status: 400 });
        }
        const quantity = Math.max(1, Math.min(payload.quantity ?? listing.remaining, listing.remaining));
        // Get instances locked for this listing
        const lockedInstances = await tx.gachaCardInstance.findMany({
          where: { tradeListingId: listing.id },
          orderBy: { obtainedAt: 'asc' },
          take: quantity
        });
        if (lockedInstances.length < quantity) {
          throw Object.assign(new Error('挂牌库存实例异常，请稍后重试'), { status: 409 });
        }
        // Build affix breakdown from locked instances for metadata/wallet logging
        const breakdownMap = new Map<string, number>();
        for (const inst of lockedInstances) {
          breakdownMap.set(inst.affixSignature, (breakdownMap.get(inst.affixSignature) ?? 0) + 1);
        }
        const consumedBreakdown = normalizeTradeAffixBreakdownEntries(
          [...breakdownMap.entries()].map(([affixSignature, count]) => ({ affixSignature, count }))
        );
        const totalCost = quantity * listing.unitPrice;
        let buyerWallet = await ensureWallet(tx, buyerId);
        if (buyerWallet.balance < totalCost) {
          throw Object.assign(new Error('Token 余额不足'), { status: 400 });
        }
        const sellerWallet = await ensureWallet(tx, listing.sellerId);
        buyerWallet = await applyWalletDelta(tx, buyerWallet, -totalCost, TRADE_BUY_SPEND_REASON, {
          listingId: listing.id,
          cardId: listing.cardId,
          quantity,
          unitPrice: listing.unitPrice,
          byAffix: consumedBreakdown
        });
        await applyWalletDelta(tx, sellerWallet, totalCost, TRADE_SELL_EARN_REASON, {
          listingId: listing.id,
          buyerId,
          cardId: listing.cardId,
          quantity,
          unitPrice: listing.unitPrice,
          byAffix: consumedBreakdown
        });
        // Transfer instances from seller to buyer
        await transferInstances(tx, lockedInstances.map((inst) => inst.id), listing.sellerId, buyerId);
        await safeUpsertCardUnlock(tx, buyerId, listing.cardId);
        const remaining = listing.remaining - quantity;
        // Build remaining breakdown from remaining locked instances
        const remainingInstances = await tx.gachaCardInstance.findMany({
          where: { tradeListingId: listing.id },
          select: { affixSignature: true }
        });
        const remainingBreakdownMap = new Map<string, number>();
        for (const inst of remainingInstances) {
          remainingBreakdownMap.set(inst.affixSignature, (remainingBreakdownMap.get(inst.affixSignature) ?? 0) + 1);
        }
        const remainingBreakdown = normalizeTradeAffixBreakdownEntries(
          [...remainingBreakdownMap.entries()].map(([affixSignature, count]) => ({ affixSignature, count }))
        );
        const updated = await tx.gachaTradeListing.update({
          where: { id: listing.id },
          data: {
            remaining,
            status: remaining > 0 ? 'OPEN' : 'SOLD',
            buyerId: remaining > 0 ? null : buyerId,
            soldAt: remaining > 0 ? null : now(),
            metadata: serializeTradeListingAffixBreakdown(remainingBreakdown)
          },
          include: {
            card: true,
            seller: {
              select: {
                id: true,
                displayName: true,
                linkedWikidotId: true
              }
            },
            buyer: {
              select: {
                id: true,
                displayName: true,
                linkedWikidotId: true
              }
            }
          }
        });
        return {
          statusCode: 200,
          responseJson: {
            ok: true,
            enabled: FEATURE_FLAGS.trade,
            listing: serializeTradeListing(updated),
            wallet: await serializeWalletWithPity(tx, buyerWallet),
            ...featureStatusPayload()
          }
        };
      });
      res.status(outcome.statusCode).json(outcome.responseJson);
    } catch (error: any) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ error: error.issues[0]?.message ?? '参数错误' });
        return;
      }
      if (error?.status === 404) {
        res.status(404).json({ error: error.message });
        return;
      }
      if (error?.status === 400) {
        res.status(400).json({ error: error.message });
        return;
      }
      if (error?.status === 409 || error?.code === 'IDEMPOTENCY_KEY_CONFLICT') {
        res.status(409).json({ error: 'idempotency_key_conflict' });
        return;
      }
      next(error);
    }
  });

  router.post('/trade/listings/:id/cancel', async (req, res, next) => {
    try {
      if (!req.authUser) return res.status(401).json({ error: '未登录' });
      const listingId = String(req.params.id || '').trim();
      if (!listingId) {
        res.status(400).json({ error: 'listingId 不能为空' });
        return;
      }
      const scope = buildIdempotencyScope(req, req.authUser.id);
      const outcome = await executeIdempotent(scope, async (tx) => {
        triggerTradeExpirySweep();
        const listing = await tx.gachaTradeListing.findUnique({
          where: { id: listingId },
          include: {
            card: true,
            seller: {
              select: {
                id: true,
                displayName: true,
                linkedWikidotId: true
              }
            },
            buyer: {
              select: {
                id: true,
                displayName: true,
                linkedWikidotId: true
              }
            }
          }
        });
        if (!listing) {
          throw Object.assign(new Error('挂牌不存在'), { status: 404 });
        }
        const didExpireNow = await expireTradeListingIfNeeded(tx, {
          id: listing.id,
          sellerId: listing.sellerId,
          remaining: listing.remaining,
          status: listing.status,
          expiresAt: listing.expiresAt,
          metadata: listing.metadata,
          card: listing.card
        }, now());
        if (didExpireNow) {
          throw Object.assign(new Error('挂牌已过期'), { status: 400 });
        }
        if (listing.sellerId !== req.authUser!.id) {
          throw Object.assign(new Error('只能撤销自己的挂牌'), { status: 400 });
        }
        if (listing.status !== 'OPEN' || listing.remaining <= 0) {
          throw Object.assign(new Error('当前挂牌不可撤销'), { status: 400 });
        }
        // Unlock all instances locked for this listing (returns them to seller's inventory)
        await unlockTradeInstances(tx, listing.id);
        const updated = await tx.gachaTradeListing.update({
          where: { id: listing.id },
          data: {
            remaining: 0,
            status: 'CANCELLED',
            metadata: serializeTradeListingAffixBreakdown([])
          },
          include: {
            card: true,
            seller: {
              select: {
                id: true,
                displayName: true,
                linkedWikidotId: true
              }
            },
            buyer: {
              select: {
                id: true,
                displayName: true,
                linkedWikidotId: true
              }
            }
          }
        });
        const wallet = await ensureWallet(tx, req.authUser!.id);
        await recordLedger(tx, wallet.id, req.authUser!.id, 0, TRADE_LISTING_CANCEL_REASON, {
          listingId: updated.id,
          cardId: updated.cardId,
          quantity: listing.remaining
        });
        return {
          statusCode: 200,
          responseJson: {
            ok: true,
            enabled: FEATURE_FLAGS.trade,
            listing: serializeTradeListing(updated),
            wallet: await serializeWalletWithPity(tx, wallet),
            ...featureStatusPayload()
          }
        };
      });
      res.status(outcome.statusCode).json(outcome.responseJson);
    } catch (error: any) {
      if (error?.status === 404) {
        res.status(404).json({ error: error.message });
        return;
      }
      if (error?.status === 400) {
        res.status(400).json({ error: error.message });
        return;
      }
      if (error?.status === 409 || error?.code === 'IDEMPOTENCY_KEY_CONFLICT') {
        res.status(409).json({ error: 'idempotency_key_conflict' });
        return;
      }
      next(error);
    }
  });

  // ═══════════════════════════════════════════════════════
  // BUY REQUEST ENDPOINTS
  // ═══════════════════════════════════════════════════════

  router.get('/trade/buy-requests/card-catalog', async (req, res, next) => {
    try {
      if (!req.authUser) return res.status(401).json({ error: '未登录' });
      const pools = await fetchActivePools(prisma);
      if (pools.length === 0) {
        return res.json({ ok: true, enabled: FEATURE_FLAGS.buyRequest, pages: [] });
      }
      const cards = await prisma.gachaCardDefinition.findMany({
        where: { poolId: { in: pools.map((p) => p.id) } },
        select: { id: true, title: true, rarity: true, imageUrl: true, tags: true, wikidotId: true, pageId: true, poolId: true, weight: true },
        orderBy: [{ rarity: 'asc' }, { title: 'asc' }]
      });
      // Group cards by pageId; null-pageId cards each become their own entry
      const pageMap = new Map<number | string, typeof cards>();
      let nullIdx = 0;
      for (const c of cards) {
        const key = c.pageId != null ? c.pageId : `__null_${nullIdx++}`;
        const group = pageMap.get(key);
        if (group) {
          group.push(c);
        } else {
          pageMap.set(key, [c]);
        }
      }
      const pages = Array.from(pageMap.values()).map((group) => {
        const first = group[0]!;
        return {
          pageId: first.pageId ?? null,
          title: first.title,
          rarity: first.rarity,
          tags: first.tags ?? [],
          authors: resolveCardAuthorsFromTags(first.tags),
          wikidotId: first.wikidotId ?? null,
          isRetired: group.every((card) => isRetiredCard(card)),
          variants: buildImageVariants(group.map((c) => ({
            id: c.id,
            imageUrl: c.imageUrl ?? null,
            poolId: c.poolId,
            weight: c.weight
          })))
        };
      });
      res.json({
        ok: true,
        enabled: FEATURE_FLAGS.buyRequest,
        pages
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/trade/buy-requests', async (req, res, next) => {
    try {
      if (!req.authUser) return res.status(401).json({ error: '未登录' });
      const parsed = buyRequestListSchema.parse(req.query ?? {});
      triggerBuyRequestExpirySweep();
      const { limit, offset, sort } = parsed;
      const where: Prisma.GachaBuyRequestWhereInput = {};

      if (parsed.status === 'OPEN') {
        where.status = 'OPEN';
      }
      if (parsed.targetCardId) {
        where.targetCardId = parsed.targetCardId;
      }
      if (parsed.rarity) {
        where.targetCard = { is: { rarity: parsed.rarity } };
      }
      if (parsed.search) {
        const keyword = parsed.search.trim();
        if (keyword) {
          const authorMatchedCardIds = await findCardIdsByAuthorKeyword(keyword);
          where.OR = [
            { targetCard: { is: { title: { contains: keyword, mode: 'insensitive' } } } },
            { buyer: { is: { displayName: { contains: keyword, mode: 'insensitive' } } } },
            ...(authorMatchedCardIds.length > 0 ? [{ targetCardId: { in: authorMatchedCardIds } }] : [])
          ];
        }
      }

      // ─── fulfillableOnly: server-side check ──────────────
      // Uses raw SQL subqueries to avoid bind-variable explosion (PostgreSQL limit: 32,767).
      // Previous approach expanded coating instances into individual OR conditions, which
      // could exceed 40,000+ bind variables for users with large inventories.
      if (parsed.fulfillableOnly === '1') {
        const userId = req.authUser.id;
        where.buyerId = { not: userId };

        // Single raw SQL query using EXISTS subqueries — O(1) bind variables (just userId)
        const fulfillableIds = await prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
          SELECT br.id
          FROM "GachaBuyRequest" br
          WHERE br.status = 'OPEN'
            AND br."buyerId" != ${userId}
            AND (
              -- IMAGE_VARIANT: user has at least one eligible instance of exact target card
              (br."matchLevel"::text = 'IMAGE_VARIANT' AND EXISTS (
                SELECT 1
                FROM "GachaCardInstance" ci
                WHERE ci."userId" = ${userId}
                  AND ci."cardId" = br."targetCardId"
                  AND ci."tradeListingId" IS NULL
                  AND ci."buyRequestId" IS NULL
              ))
              OR
              -- PAGE: user has at least one eligible instance from the same page
              (br."matchLevel"::text = 'PAGE' AND EXISTS (
                SELECT 1
                FROM "GachaCardDefinition" target
                JOIN "GachaCardDefinition" ownCard
                  ON ownCard."pageId" = target."pageId"
                JOIN "GachaCardInstance" ci
                  ON ci."cardId" = ownCard.id
                WHERE target.id = br."targetCardId"
                  AND target."pageId" IS NOT NULL
                  AND ci."userId" = ${userId}
                  AND ci."tradeListingId" IS NULL
                  AND ci."buyRequestId" IS NULL
              ))
              OR
              -- COATING: user has at least one eligible instance with required coating
              (br."matchLevel"::text = 'COATING' AND EXISTS (
                SELECT 1 FROM "GachaCardInstance" ci
                WHERE ci."userId" = ${userId}
                  AND ci."cardId" = br."targetCardId"
                  AND ci."affixVisualStyle"::text = br."requiredCoating"::text
                  AND ci."tradeListingId" IS NULL
                  AND ci."buyRequestId" IS NULL
              ))
            )
        `);

        const ids = fulfillableIds.map(r => r.id);
        if (ids.length === 0) {
          res.json({
            ok: true, enabled: FEATURE_FLAGS.buyRequest,
            items: [], pagination: { total: 0, limit, offset },
            ...featureStatusPayload()
          });
          return;
        }

        where.id = { in: ids };
      }

      const [items, total] = await Promise.all([
        prisma.gachaBuyRequest.findMany({
          where,
          orderBy: buildBuyRequestOrderBy(sort),
          take: limit,
          skip: offset,
          include: buyRequestInclude
        }),
        prisma.gachaBuyRequest.count({ where })
      ]);

      res.json({
        ok: true,
        enabled: FEATURE_FLAGS.buyRequest,
        items: items.map(serializeBuyRequest),
        pagination: { total, limit, offset },
        ...featureStatusPayload()
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ error: error.issues[0]?.message ?? '参数错误' });
        return;
      }
      next(error);
    }
  });

  router.get('/trade/my-buy-requests', async (req, res, next) => {
    try {
      if (!req.authUser) return res.status(401).json({ error: '未登录' });
      triggerBuyRequestExpirySweep();
      const result = await prisma.gachaBuyRequest.findMany({
        where: { buyerId: req.authUser!.id },
        orderBy: [{ createdAt: 'desc' }],
        include: buyRequestInclude
      });
      res.json({
        ok: true,
        enabled: FEATURE_FLAGS.buyRequest,
        items: result.map(serializeBuyRequest),
        ...featureStatusPayload()
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/trade/buy-requests', async (req, res, next) => {
    try {
      if (!req.authUser) return res.status(401).json({ error: '未登录' });
      const payload = buyRequestCreateSchema.parse(req.body ?? {});
      if (payload.tokenOffer <= 0 && payload.offeredCards.length === 0) {
        return res.status(400).json({ error: '必须提供 Token 出价或卡牌出价' });
      }
      const scope = buildIdempotencyScope(req, req.authUser.id);
      triggerBuyRequestExpirySweep();
      const outcome = await executeIdempotent(scope, async (tx) => {
        const userId = req.authUser!.id;
        const targetCard = await tx.gachaCardDefinition.findUnique({
          where: { id: payload.targetCardId },
          select: { id: true, title: true }
        });
        if (!targetCard) {
          throw Object.assign(new Error('目标卡片不存在'), { status: 404 });
        }

        // Token escrow
        let wallet = await ensureWallet(tx, userId);
        if (payload.tokenOffer > 0) {
          if (wallet.balance < payload.tokenOffer) {
            throw Object.assign(new Error('Token 余额不足'), { status: 400 });
          }
          wallet = await applyWalletDelta(tx, wallet, -payload.tokenOffer, BUY_REQUEST_CREATE_REASON, {
            targetCardId: targetCard.id,
            tokenOffer: payload.tokenOffer
          });
        }

        // Validate COATING-level requires a non-NONE coating
        if (payload.matchLevel === 'COATING' && (!payload.requiredCoating || payload.requiredCoating === 'NONE')) {
          throw Object.assign(new Error('镀层级别求购必须指定一个非 NONE 的镀层类型'), { status: 400 });
        }

        const expiresAt = payload.expiresHours
          ? new Date(Date.now() + payload.expiresHours * 3_600_000)
          : null;

        const buyRequest = await tx.gachaBuyRequest.create({
          data: {
            buyerId: userId,
            targetCardId: targetCard.id,
            matchLevel: payload.matchLevel,
            requiredCoating: payload.matchLevel === 'COATING' ? (payload.requiredCoating ?? null) : null,
            tokenOffer: payload.tokenOffer,
            expiresAt,
            offeredCards: {
              create: payload.offeredCards.map((oc) => ({
                cardId: oc.cardId,
                quantity: oc.quantity
              }))
            }
          },
          include: buyRequestInclude
        });

        // Lock offered card instances
        for (const oc of payload.offeredCards) {
          const requestedSignature = oc.affixSignature
            ? affixSignatureFromStyles(parseAffixSignature(oc.affixSignature))
            : undefined;
          // eslint-disable-next-line no-await-in-loop
          const freeInstances = await findFreeInstances(tx, userId, oc.cardId, {
            affixSignature: requestedSignature
          });
          if (freeInstances.length < oc.quantity) {
            const suffix = requestedSignature ? `（词条 ${requestedSignature}）` : '';
            throw Object.assign(new Error(`卡牌 "${oc.cardId}"${suffix} 可用数量不足`), { status: 400 });
          }
          const toLock = freeInstances.slice(0, oc.quantity);
          // eslint-disable-next-line no-await-in-loop
          await lockInstancesForBuyRequest(tx, toLock.map((inst) => inst.id), buyRequest.id);
        }

        // Record ledger
        await recordLedger(tx, wallet.id, userId, 0, BUY_REQUEST_CREATE_REASON, {
          buyRequestId: buyRequest.id,
          targetCardId: targetCard.id,
          tokenOffer: payload.tokenOffer,
          offeredCards: payload.offeredCards
        });

        // Re-fetch with updated relations
        const refreshed = await tx.gachaBuyRequest.findUniqueOrThrow({
          where: { id: buyRequest.id },
          include: buyRequestInclude
        });

        return {
          statusCode: 200,
          responseJson: {
            ok: true,
            enabled: FEATURE_FLAGS.buyRequest,
            buyRequest: serializeBuyRequest(refreshed),
            wallet: await serializeWalletWithPity(tx, wallet),
            ...featureStatusPayload()
          }
        };
      });
      res.status(outcome.statusCode).json(outcome.responseJson);
    } catch (error: any) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ error: error.issues[0]?.message ?? '参数错误' });
        return;
      }
      if (error?.status === 404) {
        res.status(404).json({ error: error.message });
        return;
      }
      if (error?.status === 400) {
        res.status(400).json({ error: error.message });
        return;
      }
      if (error?.status === 409 || error?.code === 'IDEMPOTENCY_KEY_CONFLICT') {
        res.status(409).json({ error: 'idempotency_key_conflict' });
        return;
      }
      next(error);
    }
  });

  router.post('/trade/buy-requests/:id/fulfill', async (req, res, next) => {
    try {
      if (!req.authUser) return res.status(401).json({ error: '未登录' });
      const buyRequestId = String(req.params.id || '').trim();
      if (!buyRequestId) {
        return res.status(400).json({ error: 'buyRequestId 不能为空' });
      }
      const fulfillPayload = buyRequestFulfillSchema.parse(req.body ?? {});
      const selectedCardId = fulfillPayload.selectedCardId?.trim() || undefined;
      const selectedAffixSignature = fulfillPayload.selectedAffixSignature
        ? affixSignatureFromStyles(parseAffixSignature(fulfillPayload.selectedAffixSignature))
        : undefined;
      const scope = buildIdempotencyScope(req, req.authUser.id);
      const outcome = await executeIdempotent(scope, async (tx) => {
        const fulfillerId = req.authUser!.id;
        triggerBuyRequestExpirySweep();

        const br = await tx.gachaBuyRequest.findUnique({
          where: { id: buyRequestId },
          include: buyRequestInclude
        });
        if (!br) {
          throw Object.assign(new Error('求购单不存在'), { status: 404 });
        }

        const didExpire = await expireBuyRequestIfNeeded(tx, {
          id: br.id, buyerId: br.buyerId, status: br.status,
          expiresAt: br.expiresAt, tokenOffer: br.tokenOffer
        }, now());
        if (didExpire) {
          throw Object.assign(new Error('求购单已过期'), { status: 400 });
        }
        if (br.status !== 'OPEN') {
          throw Object.assign(new Error('求购单不可接受'), { status: 400 });
        }
        if (br.buyerId === fulfillerId) {
          throw Object.assign(new Error('不能接受自己的求购'), { status: 400 });
        }

        // 1. Seller must have a matching card based on matchLevel
        let sellerInstanceId: string;
        let matchedCardId: string;
        const matchLevel = br.matchLevel ?? 'IMAGE_VARIANT';
        if (selectedCardId && matchLevel !== 'PAGE' && selectedCardId !== br.targetCardId) {
          throw Object.assign(new Error('所选卡片与求购目标不匹配'), { status: 400 });
        }

        if (matchLevel === 'PAGE') {
          // PAGE level: find any instance whose card has the same pageId as the target card
          const targetCard = await tx.gachaCardDefinition.findUnique({
            where: { id: br.targetCardId },
            select: { pageId: true }
          });
          if (!targetCard?.pageId) {
            throw Object.assign(new Error('目标卡片没有关联页面'), { status: 400 });
          }
          // Find all cardIds with the same pageId
          const pageCards = await tx.gachaCardDefinition.findMany({
            where: { pageId: targetCard.pageId },
            select: { id: true }
          });
          const pageCardIds = pageCards.map((c) => c.id);
          if (selectedCardId && !pageCardIds.includes(selectedCardId)) {
            throw Object.assign(new Error('所选卡片不在该页面求购范围内'), { status: 400 });
          }
          const selectedPageCardIds = selectedCardId ? [selectedCardId] : pageCardIds;

          // Try to find a free instance among any of these cards
          const pageWhere: Prisma.GachaCardInstanceWhereInput = {
            userId: fulfillerId,
            cardId: { in: selectedPageCardIds },
            tradeListingId: null,
            buyRequestId: null,
            isLocked: false,
            placementSlot: { is: null },
            showcaseSlot: { is: null }
          };
          if (selectedAffixSignature) {
            pageWhere.affixSignature = selectedAffixSignature;
          }
          const freeInstance = await tx.gachaCardInstance.findFirst({
            where: pageWhere,
            orderBy: { obtainedAt: 'asc' }
          });
          if (freeInstance) {
            sellerInstanceId = freeInstance.id;
            matchedCardId = freeInstance.cardId;
          } else {
            // Try auto-free from placed/locked/showcased for any of these cards
            let freed: { id: string; cardId: string } | null = null;
            for (const cid of selectedPageCardIds) {
              // eslint-disable-next-line no-await-in-loop
              const autoFreed = await autoFreeInstanceForSale(tx, fulfillerId, cid, { affixSignature: selectedAffixSignature });
              if (autoFreed) {
                freed = { id: autoFreed.id, cardId: cid };
                break;
              }
            }
            if (!freed) {
              throw Object.assign(new Error(
                selectedAffixSignature ? '你没有该页面该词条的可用库存' : '你没有该页面的可用库存'
              ), { status: 400 });
            }
            sellerInstanceId = freed.id;
            matchedCardId = freed.cardId;
          }
        } else if (matchLevel === 'COATING') {
          // COATING level: find instance matching exact cardId + specific affixVisualStyle
          const requiredCoating = br.requiredCoating;
          if (!requiredCoating || requiredCoating === 'NONE') {
            throw Object.assign(new Error('镀层级别求购缺少有效镀层要求'), { status: 400 });
          }
          if (selectedCardId && selectedCardId !== br.targetCardId) {
            throw Object.assign(new Error('所选卡片与求购目标不匹配'), { status: 400 });
          }
          const coatingWhere: Prisma.GachaCardInstanceWhereInput = {
            userId: fulfillerId,
            cardId: br.targetCardId,
            affixVisualStyle: requiredCoating,
            tradeListingId: null,
            buyRequestId: null,
            isLocked: false,
            placementSlot: { is: null },
            showcaseSlot: { is: null }
          };
          if (selectedAffixSignature) {
            coatingWhere.affixSignature = selectedAffixSignature;
          }
          const freeInstance = await tx.gachaCardInstance.findFirst({
            where: coatingWhere,
            orderBy: { obtainedAt: 'asc' }
          });
          if (freeInstance) {
            sellerInstanceId = freeInstance.id;
            matchedCardId = freeInstance.cardId;
          } else {
            // Try auto-free: find instance with matching coating
            const candidateWhere: Prisma.GachaCardInstanceWhereInput = {
              userId: fulfillerId,
              cardId: br.targetCardId,
              affixVisualStyle: requiredCoating,
              tradeListingId: null,
              buyRequestId: null
            };
            if (selectedAffixSignature) {
              candidateWhere.affixSignature = selectedAffixSignature;
            }
            const candidate = await tx.gachaCardInstance.findFirst({
              where: candidateWhere,
              include: {
                placementSlot: { select: { id: true } },
                showcaseSlot: { select: { id: true } }
              },
              orderBy: { obtainedAt: 'asc' }
            });
            if (!candidate) {
              throw Object.assign(new Error(
                selectedAffixSignature ? '你没有该镀层该词条的可用库存' : '你没有该镀层的可用库存'
              ), { status: 400 });
            }
            if (candidate.isLocked) {
              await tx.gachaCardInstance.update({
                where: { id: candidate.id },
                data: { isLocked: false, lockedAt: null }
              });
            }
            if (candidate.placementSlot) {
              await tx.gachaPlacementSlot.update({
                where: { id: candidate.placementSlot.id },
                data: { cardId: null, inventoryId: null, instanceId: null, affixVisualStyle: null, affixSignature: null, affixLabel: null, assignedAt: null }
              });
            }
            if (candidate.showcaseSlot) {
              await tx.gachaShowcaseSlot.delete({ where: { id: candidate.showcaseSlot.id } });
            }
            sellerInstanceId = candidate.id;
            matchedCardId = candidate.cardId;
          }
        } else {
          // IMAGE_VARIANT level (default): exact cardId match (original behavior)
          matchedCardId = br.targetCardId;
          const sellerFreeInstances = await findFreeInstances(tx, fulfillerId, br.targetCardId, {
            limit: 1,
            affixSignature: selectedAffixSignature
          });
          if (sellerFreeInstances.length >= 1) {
            sellerInstanceId = sellerFreeInstances[0]!.id;
          } else {
            const autoFreed = await autoFreeInstanceForSale(tx, fulfillerId, br.targetCardId, {
              affixSignature: selectedAffixSignature
            });
            if (!autoFreed) {
              throw Object.assign(new Error(
                selectedAffixSignature ? '你没有该词条的可用库存' : '你没有该卡片的可用库存'
              ), { status: 400 });
            }
            sellerInstanceId = autoFreed.id;
          }
        }

        // 2. Transfer target card: seller → buyer
        await transferInstances(tx, [sellerInstanceId], fulfillerId, br.buyerId);
        // Decrement seller inventory (transferInstances only increments receiver;
        // in the trade-listing flow the lock step already decremented, but here there's no lock)
        await tx.gachaInventory.updateMany({
          where: { userId: fulfillerId, cardId: matchedCardId },
          data: { count: { decrement: 1 } }
        });
        await safeUpsertCardUnlock(tx, br.buyerId, matchedCardId);

        // 3. Transfer offered cards (locked instances): buyer → seller
        // These instances were locked during buy-request creation which already decremented
        // the buyer's inventory. We skip unlockBuyRequestInstances to avoid +count/-count
        // round-trip — transferInstances clears buyRequestId and increments seller inventory.
        const lockedInstances = await tx.gachaCardInstance.findMany({
          where: { buyRequestId: br.id },
          select: { id: true, cardId: true }
        });
        if (lockedInstances.length > 0) {
          await transferInstances(tx, lockedInstances.map((i) => i.id), br.buyerId, fulfillerId);
          const uniqueCardIds = [...new Set(lockedInstances.map((i) => i.cardId))];
          for (const cardId of uniqueCardIds) {
            // eslint-disable-next-line no-await-in-loop
            await safeUpsertCardUnlock(tx, fulfillerId, cardId);
          }
        }

        // 4. Transfer escrowed tokens to seller
        if (br.tokenOffer > 0) {
          const sellerWallet = await ensureWallet(tx, fulfillerId);
          await applyWalletDelta(tx, sellerWallet, br.tokenOffer, BUY_REQUEST_FULFILL_SELLER_EARN_REASON, {
            buyRequestId: br.id,
            buyerId: br.buyerId,
            tokenOffer: br.tokenOffer
          });
        }

        // 5. Mark as fulfilled
        const updated = await tx.gachaBuyRequest.update({
          where: { id: br.id },
          data: {
            status: 'FULFILLED',
            fulfillerId,
            fulfilledAt: now()
          },
          include: buyRequestInclude
        });

        const fulfillerWallet = await ensureWallet(tx, fulfillerId);
        return {
          statusCode: 200,
          responseJson: {
            ok: true,
            enabled: FEATURE_FLAGS.buyRequest,
            buyRequest: serializeBuyRequest(updated),
            wallet: await serializeWalletWithPity(tx, fulfillerWallet),
            ...featureStatusPayload()
          }
        };
      });
      res.status(outcome.statusCode).json(outcome.responseJson);
    } catch (error: any) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ error: error.issues[0]?.message ?? '参数错误' });
        return;
      }
      if (error?.status === 404) {
        res.status(404).json({ error: error.message });
        return;
      }
      if (error?.status === 400) {
        res.status(400).json({ error: error.message });
        return;
      }
      if (error?.status === 409 || error?.code === 'IDEMPOTENCY_KEY_CONFLICT') {
        res.status(409).json({ error: 'idempotency_key_conflict' });
        return;
      }
      next(error);
    }
  });

  router.post('/trade/buy-requests/:id/cancel', async (req, res, next) => {
    try {
      if (!req.authUser) return res.status(401).json({ error: '未登录' });
      const buyRequestId = String(req.params.id || '').trim();
      if (!buyRequestId) {
        return res.status(400).json({ error: 'buyRequestId 不能为空' });
      }
      const scope = buildIdempotencyScope(req, req.authUser.id);
      const outcome = await executeIdempotent(scope, async (tx) => {
        const br = await tx.gachaBuyRequest.findUnique({
          where: { id: buyRequestId },
          include: buyRequestInclude
        });
        if (!br) {
          throw Object.assign(new Error('求购单不存在'), { status: 404 });
        }
        if (br.buyerId !== req.authUser!.id) {
          throw Object.assign(new Error('只能取消自己的求购'), { status: 400 });
        }
        if (br.status !== 'OPEN') {
          throw Object.assign(new Error('当前求购不可取消'), { status: 400 });
        }

        // Unlock offered card instances
        await unlockBuyRequestInstances(tx, br.id);

        // Refund escrowed tokens
        let wallet = await ensureWallet(tx, br.buyerId);
        if (br.tokenOffer > 0) {
          wallet = await applyWalletDelta(tx, wallet, br.tokenOffer, BUY_REQUEST_CANCEL_REASON, {
            buyRequestId: br.id,
            tokenOffer: br.tokenOffer
          });
        }

        await recordLedger(tx, wallet.id, br.buyerId, 0, BUY_REQUEST_CANCEL_REASON, {
          buyRequestId: br.id
        });

        const updated = await tx.gachaBuyRequest.update({
          where: { id: br.id },
          data: { status: 'CANCELLED' },
          include: buyRequestInclude
        });

        return {
          statusCode: 200,
          responseJson: {
            ok: true,
            enabled: FEATURE_FLAGS.buyRequest,
            buyRequest: serializeBuyRequest(updated),
            wallet: await serializeWalletWithPity(tx, wallet),
            ...featureStatusPayload()
          }
        };
      });
      res.status(outcome.statusCode).json(outcome.responseJson);
    } catch (error: any) {
      if (error?.status === 404) {
        res.status(404).json({ error: error.message });
        return;
      }
      if (error?.status === 400) {
        res.status(400).json({ error: error.message });
        return;
      }
      if (error?.status === 409 || error?.code === 'IDEMPOTENCY_KEY_CONFLICT') {
        res.status(409).json({ error: 'idempotency_key_conflict' });
        return;
      }
      next(error);
    }
  });

  router.get('/progress', async (req, res, next) => {
    try {
      if (!req.authUser) return res.status(401).json({ error: '未登录' });
      const parsed = progressQuerySchema.parse(req.query ?? {});
      if (parsed.poolId && parsed.poolId !== PERMANENT_POOL_ID) {
        res.status(400).json({ error: '当前仅支持常驻卡池' });
        return;
      }
      const pools = sortPoolsForDisplay(await fetchActivePools(prisma));
      if (pools.length === 0) {
        const emptyByRarity = buildProgressResponse([], new Set());
        return res.json({
          ok: true,
          progress: {
            pages: emptyByRarity,
            imageVariants: { total: 0, collected: 0 },
            coatings: { total: 14, collected: 0 }
          }
        });
      }
      const poolId = PERMANENT_POOL_ID;
      const userId = req.authUser.id;

      // Single combined query: page-level + variant-level stats + coating count
      type ProgressRow = {
        rarity: string;
        pageTotal: number;
        pageCollected: number;
        variantTotal: number;
        variantCollected: number;
        coatingCount: number;
      };
      const progressRows = await prisma.$queryRaw<ProgressRow[]>(Prisma.sql`
        WITH pool_cards AS (
          SELECT id, rarity::text AS rarity, "pageId", "imageUrl"
          FROM "GachaCardDefinition"
          WHERE "poolId" = ${poolId}
        ),
        owned AS (
          SELECT "cardId" FROM "GachaCardUnlock"
          WHERE "userId" = ${userId}
            AND "cardId" IN (SELECT id FROM pool_cards)
        ),
        owned_pages AS (
          SELECT DISTINCT pc."pageId"
          FROM owned o JOIN pool_cards pc ON pc.id = o."cardId"
          WHERE pc."pageId" IS NOT NULL
        ),
        page_rarity AS (
          SELECT
            rarity,
            COUNT(DISTINCT "pageId")::int AS total,
            COUNT(DISTINCT CASE WHEN "pageId" IN (SELECT "pageId" FROM owned_pages) THEN "pageId" END)::int AS collected
          FROM pool_cards
          WHERE "pageId" IS NOT NULL
          GROUP BY rarity
        ),
        variant_stats AS (
          SELECT
            pc.rarity,
            COUNT(
              DISTINCT CASE
                WHEN pc."pageId" IS NOT NULL
                  THEN (pc."pageId")::text || '|' || COALESCE(NULLIF(BTRIM(pc."imageUrl"), ''), '__NOIMG__')
                ELSE pc.id
              END
            )::int AS total,
            COUNT(
              DISTINCT CASE
                WHEN o."cardId" IS NULL THEN NULL
                WHEN pc."pageId" IS NOT NULL
                  THEN (pc."pageId")::text || '|' || COALESCE(NULLIF(BTRIM(pc."imageUrl"), ''), '__NOIMG__')
                ELSE pc.id
              END
            )::int AS collected
          FROM pool_cards pc
          LEFT JOIN owned o ON o."cardId" = pc.id
          GROUP BY pc.rarity
        ),
        coating_stats AS (
          SELECT COUNT(DISTINCT "affixVisualStyle")::int AS cnt
          FROM "GachaCardInstance"
          WHERE "userId" = ${userId}
            AND "tradeListingId" IS NULL
            AND "affixVisualStyle" != 'NONE'
        )
        SELECT
          pr.rarity,
          pr.total AS "pageTotal",
          pr.collected AS "pageCollected",
          COALESCE(vs.total, 0)::int AS "variantTotal",
          COALESCE(vs.collected, 0)::int AS "variantCollected",
          cs.cnt AS "coatingCount"
        FROM page_rarity pr
        LEFT JOIN variant_stats vs ON vs.rarity = pr.rarity
        CROSS JOIN coating_stats cs
      `);

      // Reconstruct per-rarity breakdown (page-level for pages, variant-level for imageVariants)
      const pageByRarityMap: Record<string, { total: number; collected: number }> = {
        GOLD: { total: 0, collected: 0 },
        PURPLE: { total: 0, collected: 0 },
        BLUE: { total: 0, collected: 0 },
        GREEN: { total: 0, collected: 0 },
        WHITE: { total: 0, collected: 0 }
      };
      let pageTotalAll = 0;
      let pageCollectedAll = 0;
      let variantTotalAll = 0;
      let variantCollectedAll = 0;
      let coatingCollected = 0;

      for (const row of progressRows) {
        const r = row.rarity;
        const pageTotal = Math.max(0, Number(row.pageTotal));
        const pageCollected = Math.max(0, Number(row.pageCollected));
        const variantTotal = Math.max(0, Number(row.variantTotal));
        const variantCollected = Math.max(0, Number(row.variantCollected));
        if (pageByRarityMap[r]) {
          pageByRarityMap[r].total = pageTotal;
          pageByRarityMap[r].collected = pageCollected;
        }
        pageTotalAll += pageTotal;
        pageCollectedAll += pageCollected;
        variantTotalAll += variantTotal;
        variantCollectedAll += variantCollected;
        coatingCollected = Math.max(0, Number(row.coatingCount));
      }

      res.json({
        ok: true,
        progress: {
          pages: {
            total: pageTotalAll,
            collected: pageCollectedAll,
            byRarity: RARITY_ORDER.map((rarity) => ({
              rarity,
              total: pageByRarityMap[rarity]?.total ?? 0,
              collected: pageByRarityMap[rarity]?.collected ?? 0
            }))
          },
          imageVariants: { total: variantTotalAll, collected: variantCollectedAll },
          coatings: { total: 14, collected: coatingCollected }
        }
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/history', async (req, res, next) => {
    try {
      if (!req.authUser) return res.status(401).json({ error: '未登录' });
      const parsed = historyQuerySchema.parse(req.query ?? {});
      if (parsed.poolId && parsed.poolId !== PERMANENT_POOL_ID) {
        res.status(400).json({ error: '当前仅支持常驻卡池' });
        return;
      }
      const limit = Math.min(Math.max(Number(parsed.limit ?? '20'), 1), 50);
      const poolId = PERMANENT_POOL_ID;
      const draws = await prisma.gachaDraw.findMany({
        where: {
          userId: req.authUser.id,
          poolId
        },
        orderBy: { createdAt: 'desc' },
        take: limit,
        include: {
          items: {
            include: {
              card: true
            }
          },
          pool: true
        }
      });

      res.json({
        ok: true,
        items: draws.map((draw) => ({
          id: draw.id,
          poolId: draw.poolId,
          poolName: draw.pool?.name ?? null,
          count: draw.drawCount,
          tokensSpent: draw.tokensSpent,
          tokensReward: draw.tokensReward,
          createdAt: draw.createdAt.toISOString(),
          items: draw.items.map((item) => ({
            cardId: item.cardId,
            title: item.card?.title ?? '',
            rarity: item.card?.rarity ?? item.rarity,
            rewardTokens: item.rewardTokens,
            imageUrl: item.card?.imageUrl ?? null,
            isRetired: item.card ? isRetiredCard(item.card) : false
          }))
        }))
      });
    } catch (error) {
      next(error);
    }
  });

  // ─── Notifications ────────────────────────────────────
  router.get('/notifications', async (req, res, next) => {
    try {
      if (!req.authUser) {
        res.status(401).json({ error: '未登录' });
        return;
      }
      const userId = req.authUser.id;
      const sinceParam = typeof req.query?.since === 'string' ? req.query.since : undefined;
      const since = sinceParam ? new Date(sinceParam) : undefined;
      if (since && Number.isNaN(since.getTime())) {
        res.status(400).json({ error: 'since 参数格式错误' });
        return;
      }

      const where: Prisma.GachaLedgerEntryWhereInput = {
        userId,
        reason: 'ADMIN_ADJUST',
        metadata: { path: ['message'], not: Prisma.DbNull }
      };
      if (since) {
        where.createdAt = { gt: since };
      }

      const entries = await prisma.gachaLedgerEntry.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: {
          id: true,
          delta: true,
          metadata: true,
          createdAt: true
        }
      });

      const items = entries
        .map((entry) => {
          const meta = entry.metadata as Record<string, any> | null;
          const message = meta?.message;
          if (typeof message !== 'string' || !message.trim()) return null;
          return {
            id: entry.id,
            delta: entry.delta,
            message: message.trim(),
            reason: typeof meta?.reason === 'string' ? meta.reason : null,
            createdAt: entry.createdAt.toISOString()
          };
        })
        .filter(Boolean);

      res.json({ ok: true, items });
    } catch (error) {
      next(error);
    }
  });

  // ─── Lock / Unlock ─────────────────────────────────────

  const lockBodySchema = z.union([
    z.object({ instanceIds: z.array(z.string().trim()).min(1).max(200) }),
    z.object({ cardId: z.string().trim(), affixSignature: z.string().trim().optional(), count: z.number().int().min(1).max(999).optional() })
  ]);

  router.post('/lock', async (req, res, next) => {
    try {
      if (!req.authUser) return res.status(401).json({ error: '未登录' });
      const body = lockBodySchema.parse(req.body ?? {});
      const userId = req.authUser.id;

      let targetIds: string[];
      if ('instanceIds' in body) {
        targetIds = body.instanceIds;
      } else {
        const where: Prisma.GachaCardInstanceWhereInput = {
          userId, cardId: body.cardId, tradeListingId: null, buyRequestId: null, isLocked: false
        };
        if (body.affixSignature) where.affixSignature = body.affixSignature;
        const found = await prisma.gachaCardInstance.findMany({
          where, select: { id: true }, orderBy: { obtainedAt: 'asc' },
          ...(body.count ? { take: body.count } : {})
        });
        targetIds = found.map((i) => i.id);
      }

      if (targetIds.length === 0) return res.json({ ok: true, locked: 0, alreadyLocked: 0 });

      const instances = await prisma.gachaCardInstance.findMany({
        where: { id: { in: targetIds }, userId },
        select: { id: true, tradeListingId: true, buyRequestId: true, isLocked: true }
      });
      if ('instanceIds' in body && instances.length !== targetIds.length) {
        return res.status(400).json({ error: '部分实例不存在或不属于当前用户' });
      }
      const busy = instances.find((i) => i.tradeListingId || i.buyRequestId);
      if (busy) {
        return res.status(400).json({ error: '交易/求购中的卡片不可锁定' });
      }
      const toLock = instances.filter((i) => !i.isLocked).map((i) => i.id);
      if (toLock.length > 0) {
        await prisma.gachaCardInstance.updateMany({
          where: { id: { in: toLock } },
          data: { isLocked: true, lockedAt: new Date() }
        });
      }
      res.json({ ok: true, locked: toLock.length, alreadyLocked: instances.length - toLock.length });
    } catch (error: any) {
      if (error instanceof z.ZodError) return res.status(400).json({ error: error.issues[0]?.message ?? '参数错误' });
      if (error?.status === 400) return res.status(400).json({ error: error.message });
      if (error?.status === 409 || error?.code === 'IDEMPOTENCY_KEY_CONFLICT') {
        return res.status(409).json({ error: 'idempotency_key_conflict' });
      }
      next(error);
    }
  });

  router.post('/unlock', async (req, res, next) => {
    try {
      if (!req.authUser) return res.status(401).json({ error: '未登录' });
      const body = lockBodySchema.parse(req.body ?? {});
      const userId = req.authUser.id;

      let targetIds: string[];
      if ('instanceIds' in body) {
        targetIds = body.instanceIds;
      } else {
        const where: Prisma.GachaCardInstanceWhereInput = {
          userId, cardId: body.cardId, tradeListingId: null, buyRequestId: null, isLocked: true
        };
        if (body.affixSignature) where.affixSignature = body.affixSignature;
        const found = await prisma.gachaCardInstance.findMany({
          where, select: { id: true }, orderBy: { obtainedAt: 'asc' },
          ...(body.count ? { take: body.count } : {})
        });
        targetIds = found.map((i) => i.id);
      }

      if (targetIds.length === 0) return res.json({ ok: true, unlocked: 0, alreadyUnlocked: 0 });

      const instances = await prisma.gachaCardInstance.findMany({
        where: { id: { in: targetIds }, userId },
        select: { id: true, tradeListingId: true, buyRequestId: true, isLocked: true }
      });
      if ('instanceIds' in body && instances.length !== targetIds.length) {
        return res.status(400).json({ error: '部分实例不存在或不属于当前用户' });
      }
      const busy = instances.find((i) => i.tradeListingId || i.buyRequestId);
      if (busy) {
        return res.status(400).json({ error: '交易/求购中的卡片不可解锁' });
      }
      const toUnlock = instances.filter((i) => i.isLocked).map((i) => i.id);
      if (toUnlock.length > 0) {
        await prisma.gachaCardInstance.updateMany({
          where: { id: { in: toUnlock } },
          data: { isLocked: false, lockedAt: null }
        });
      }
      res.json({ ok: true, unlocked: toUnlock.length, alreadyUnlocked: instances.length - toUnlock.length });
    } catch (error: any) {
      if (error instanceof z.ZodError) return res.status(400).json({ error: error.issues[0]?.message ?? '参数错误' });
      if (error?.status === 400) return res.status(400).json({ error: error.message });
      if (error?.status === 409 || error?.code === 'IDEMPOTENCY_KEY_CONFLICT') {
        return res.status(409).json({ error: 'idempotency_key_conflict' });
      }
      next(error);
    }
  });

  router.get('/locked', async (req, res, next) => {
    try {
      if (!req.authUser) return res.status(401).json({ error: '未登录' });
      const userId = req.authUser.id;
      const instances = await prisma.gachaCardInstance.findMany({
        where: { userId, isLocked: true },
        include: {
          card: {
            select: { id: true, title: true, rarity: true, imageUrl: true, tags: true, authorKeys: true, wikidotId: true, pageId: true, poolId: true, weight: true }
          }
        },
        orderBy: { lockedAt: 'desc' }
      });
      res.json({
        ok: true,
        items: instances.map((inst) => ({
          instanceId: inst.id,
          cardId: inst.cardId,
          title: inst.card.title,
          rarity: inst.card.rarity,
          imageUrl: inst.card.imageUrl,
          tags: inst.card.tags,
          authors: resolveCardAuthorsFromTags(inst.card.tags, inst.card.authorKeys),
          wikidotId: inst.card.wikidotId,
          pageId: inst.card.pageId,
          isRetired: isRetiredCard(inst.card),
          affixVisualStyle: inst.affixVisualStyle,
          affixSignature: inst.affixSignature,
          affixLabel: inst.affixLabel,
          lockedAt: inst.lockedAt?.toISOString() ?? null
        }))
      });
    } catch (error) {
      next(error);
    }
  });

  // Free instances list (for showcase picker and other pickers needing instance-level data)
  router.get('/instances/free', async (req, res, next) => {
    try {
      if (!req.authUser) return res.status(401).json({ error: '未登录' });
      const userId = req.authUser.id;
      const limitParam = String(req.query.limit ?? '').trim().toLowerCase();
      const parsedLimit = Number(limitParam || '500');
      const take = limitParam === 'all'
        ? undefined
        : (Number.isFinite(parsedLimit)
            ? Math.min(Math.max(Math.trunc(parsedLimit), 1), 2000)
            : 500);
      const parsedOffset = Number(req.query.offset ?? '0');
      const skip = Number.isFinite(parsedOffset) ? Math.max(0, Math.trunc(parsedOffset)) : 0;
      const search = String(req.query.search ?? '').trim();
      const searchLower = search.toLowerCase();
      const rarityRaw = String(req.query.rarity ?? '').trim().toUpperCase();
      const rarity = RARITY_ORDER.includes(rarityRaw as GachaRarity)
        ? rarityRaw as GachaRarity
        : null;
      const sortMode = String(req.query.sort ?? '').trim().toUpperCase() === 'PICKER'
        ? 'PICKER'
        : 'LATEST';
      const includePlaced = ['1', 'true', 'yes', 'on'].includes(
        String(req.query.includePlaced ?? '').trim().toLowerCase()
      );
      const includeLocked = ['1', 'true', 'yes', 'on'].includes(
        String(req.query.includeLocked ?? '').trim().toLowerCase()
      );
      const andConditions: Prisma.GachaCardInstanceWhereInput[] = [];
      const where: Prisma.GachaCardInstanceWhereInput = {
        userId,
        tradeListingId: null,
        buyRequestId: null,
        showcaseSlot: { is: null }
      };
      if (!includeLocked) {
        where.isLocked = false;
      }
      if (!includePlaced) {
        where.placementSlot = { is: null };
      }
      if (rarity) {
        andConditions.push({ card: { is: { rarity } } });
      }
      if (search) {
        const authorCardIds = await findCardIdsByAuthorKeyword(search);
        andConditions.push({
          OR: [
            { cardId: { contains: search, mode: 'insensitive' } },
            { card: { is: { title: { contains: search, mode: 'insensitive' } } } },
            { card: { is: { tags: { hasSome: [searchLower] } } } },
            ...(authorCardIds.length > 0 ? [{ cardId: { in: authorCardIds } }] : [])
          ]
        });
      }

      const orderBy: Prisma.GachaCardInstanceOrderByWithRelationInput[] = sortMode === 'PICKER'
        ? [
            { card: { rarity: 'asc' } },
            { card: { title: 'asc' } },
            { obtainedAt: 'desc' }
          ]
        : [{ obtainedAt: 'desc' }];

      const [instances, total] = await Promise.all([
        prisma.gachaCardInstance.findMany({
          where: {
            ...where,
            AND: andConditions.length > 0 ? andConditions : undefined
          },
          include: {
            card: {
              select: { id: true, title: true, rarity: true, imageUrl: true, tags: true, authorKeys: true, wikidotId: true, pageId: true, poolId: true, weight: true }
            }
          },
          orderBy,
          skip,
          take
        }),
        prisma.gachaCardInstance.count({
          where: {
            ...where,
            AND: andConditions.length > 0 ? andConditions : undefined
          }
        })
      ]);
      res.json({
        ok: true,
        total,
        pageRows: instances.length,
        items: instances.map((inst) => ({
          instanceId: inst.id,
          cardId: inst.cardId,
          title: inst.card.title,
          rarity: inst.card.rarity,
          imageUrl: inst.card.imageUrl,
          tags: inst.card.tags,
          authors: resolveCardAuthorsFromTags(inst.card.tags, inst.card.authorKeys),
          wikidotId: inst.card.wikidotId,
          pageId: inst.card.pageId,
          isRetired: isRetiredCard(inst.card),
          affixVisualStyle: inst.affixVisualStyle,
          affixSignature: inst.affixSignature,
          affixLabel: inst.affixLabel,
          isLocked: inst.isLocked
        }))
      });
    } catch (error) {
      next(error);
    }
  });

  // ─── Showcase ──────────────────────────────────────────

  const SHOWCASE_FREE_COUNT = 3;
  const SHOWCASE_MAX_COUNT = 10;
  const SHOWCASE_UNLOCK_COST = 3000;
  const SHOWCASE_SLOT_MAX = 10;

  router.get('/showcases', async (req, res, next) => {
    try {
      if (!req.authUser) return res.status(401).json({ error: '未登录' });
      const showcases = await prisma.gachaShowcase.findMany({
        where: { userId: req.authUser.id },
        orderBy: { sortOrder: 'asc' },
        include: {
          slots: {
            orderBy: { slotIndex: 'asc' },
            include: {
              instance: {
                include: {
                  card: {
                    select: { id: true, title: true, rarity: true, imageUrl: true, tags: true, authorKeys: true, wikidotId: true, pageId: true, poolId: true, weight: true }
                  }
                }
              }
            }
          }
        }
      });
      res.json({
        ok: true,
        freeCount: SHOWCASE_FREE_COUNT,
        maxCount: SHOWCASE_MAX_COUNT,
        unlockCost: SHOWCASE_UNLOCK_COST,
        slotMax: SHOWCASE_SLOT_MAX,
        showcases: showcases.map((sc) => ({
          id: sc.id,
          name: sc.name,
          sortOrder: sc.sortOrder,
          createdAt: sc.createdAt.toISOString(),
          slots: Array.from({ length: SHOWCASE_SLOT_MAX }, (_, i) => {
            const slot = sc.slots.find((s) => s.slotIndex === i);
            if (!slot) return { slotIndex: i, card: null };
            const inst = slot.instance;
            return {
              slotIndex: i,
              card: {
                instanceId: inst.id,
                cardId: inst.cardId,
                title: inst.card.title,
                rarity: inst.card.rarity,
                imageUrl: inst.card.imageUrl,
                tags: inst.card.tags,
                authors: resolveCardAuthorsFromTags(inst.card.tags, inst.card.authorKeys),
                wikidotId: inst.card.wikidotId,
                pageId: inst.card.pageId,
                isRetired: isRetiredCard(inst.card),
                affixVisualStyle: inst.affixVisualStyle,
                affixSignature: inst.affixSignature,
                affixLabel: inst.affixLabel
              }
            };
          })
        }))
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/showcases', async (req, res, next) => {
    try {
      if (!req.authUser) return res.status(401).json({ error: '未登录' });
      const { name } = z.object({ name: z.string().trim().min(1).max(30) }).parse(req.body ?? {});
      const userId = req.authUser.id;

      const count = await prisma.gachaShowcase.count({ where: { userId } });
      if (count >= SHOWCASE_MAX_COUNT) {
        return res.status(400).json({ error: `最多创建 ${SHOWCASE_MAX_COUNT} 个展示柜` });
      }

      if (count >= SHOWCASE_FREE_COUNT) {
        // Need to pay
        const result = await prisma.$transaction(async (tx) => {
          const wallet = await ensureWallet(tx, userId);
          if (wallet.balance < SHOWCASE_UNLOCK_COST) {
            throw Object.assign(new Error(`余额不足，需要 ${SHOWCASE_UNLOCK_COST} Token`), { status: 400 });
          }
          const updatedWallet = await tx.gachaWallet.update({
            where: { id: wallet.id },
            data: { balance: { decrement: SHOWCASE_UNLOCK_COST }, totalSpent: { increment: SHOWCASE_UNLOCK_COST } }
          });
          await recordLedger(tx, wallet.id, userId, -SHOWCASE_UNLOCK_COST, 'SHOWCASE_UNLOCK', { showcaseIndex: count });
          const showcase = await tx.gachaShowcase.create({
            data: { userId, name, sortOrder: count }
          });
          return { showcase, wallet: await serializeWalletWithPity(tx, updatedWallet) };
        });
        return res.json({ ok: true, showcase: { id: result.showcase.id, name: result.showcase.name, sortOrder: result.showcase.sortOrder, createdAt: result.showcase.createdAt.toISOString(), slots: Array.from({ length: SHOWCASE_SLOT_MAX }, (_, i) => ({ slotIndex: i, card: null })) }, wallet: result.wallet });
      }

      const showcase = await prisma.gachaShowcase.create({
        data: { userId, name, sortOrder: count }
      });
      res.json({ ok: true, showcase: { id: showcase.id, name: showcase.name, sortOrder: showcase.sortOrder, createdAt: showcase.createdAt.toISOString(), slots: Array.from({ length: SHOWCASE_SLOT_MAX }, (_, i) => ({ slotIndex: i, card: null })) } });
    } catch (error: any) {
      if (error instanceof z.ZodError) return res.status(400).json({ error: error.issues[0]?.message ?? '参数错误' });
      if (error?.status === 400) return res.status(400).json({ error: error.message });
      next(error);
    }
  });

  router.patch('/showcases/:id', async (req, res, next) => {
    try {
      if (!req.authUser) return res.status(401).json({ error: '未登录' });
      const { name } = z.object({ name: z.string().trim().min(1).max(30) }).parse(req.body ?? {});
      const showcase = await prisma.gachaShowcase.findFirst({ where: { id: req.params.id, userId: req.authUser.id } });
      if (!showcase) return res.status(404).json({ error: '展示柜不存在' });
      await prisma.gachaShowcase.update({ where: { id: showcase.id }, data: { name } });
      res.json({ ok: true });
    } catch (error: any) {
      if (error instanceof z.ZodError) return res.status(400).json({ error: error.issues[0]?.message ?? '参数错误' });
      next(error);
    }
  });

  router.delete('/showcases/:id', async (req, res, next) => {
    try {
      if (!req.authUser) return res.status(401).json({ error: '未登录' });
      const showcase = await prisma.gachaShowcase.findFirst({
        where: { id: req.params.id, userId: req.authUser.id },
        include: { slots: { select: { instanceId: true } } }
      });
      if (!showcase) return res.status(404).json({ error: '展示柜不存在' });

      await prisma.$transaction(async (tx) => {
        // Unlock all showcased cards before cascade delete
        const instanceIds = showcase.slots.map((s) => s.instanceId);
        if (instanceIds.length > 0) {
          await tx.gachaCardInstance.updateMany({
            where: { id: { in: instanceIds } },
            data: { isLocked: false, lockedAt: null }
          });
        }
        await tx.gachaShowcase.delete({ where: { id: showcase.id } });
      });

      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  router.post('/showcases/:id/slots/:slotIndex/set', async (req, res, next) => {
    try {
      if (!req.authUser) return res.status(401).json({ error: '未登录' });
      const { instanceId } = z.object({ instanceId: z.string().trim() }).parse(req.body ?? {});
      const slotIndex = Math.floor(Number(req.params.slotIndex));
      if (!Number.isFinite(slotIndex) || slotIndex < 0 || slotIndex >= SHOWCASE_SLOT_MAX) {
        return res.status(400).json({ error: `槽位索引必须在 0-${SHOWCASE_SLOT_MAX - 1} 之间` });
      }
      const userId = req.authUser.id;

      const result = await prisma.$transaction(async (tx) => {
        const showcase = await tx.gachaShowcase.findFirst({ where: { id: req.params.id, userId } });
        if (!showcase) throw Object.assign(new Error('展示柜不存在'), { status: 404 });

        const instance = await tx.gachaCardInstance.findFirst({
          where: { id: instanceId, userId },
          include: { card: { select: { id: true, title: true, rarity: true, imageUrl: true, tags: true, authorKeys: true, wikidotId: true, pageId: true, poolId: true, weight: true } } }
        });
        if (!instance) throw Object.assign(new Error('卡片实例不存在'), { status: 404 });
        if (instance.tradeListingId || instance.buyRequestId) {
          throw Object.assign(new Error('交易/求购中的卡片不可放入展示柜'), { status: 400 });
        }

        // Check not already in a showcase slot
        const existingSlot = await tx.gachaShowcaseSlot.findUnique({ where: { instanceId } });
        if (existingSlot) throw Object.assign(new Error('该卡片已在展示柜中'), { status: 400 });

        // Clear existing slot content (unlock displaced card)
        const displaced = await tx.gachaShowcaseSlot.findFirst({ where: { showcaseId: showcase.id, slotIndex } });
        if (displaced) {
          await tx.gachaShowcaseSlot.deleteMany({ where: { showcaseId: showcase.id, slotIndex } });
          await tx.gachaCardInstance.update({ where: { id: displaced.instanceId }, data: { isLocked: false, lockedAt: null } });
        }

        const slot = await tx.gachaShowcaseSlot.create({
          data: { showcaseId: showcase.id, slotIndex, instanceId }
        });

        // Auto-lock the showcased card
        if (!instance.isLocked) {
          await tx.gachaCardInstance.update({ where: { id: instanceId }, data: { isLocked: true, lockedAt: new Date() } });
        }

        return {
          slotIndex,
          card: {
            instanceId: instance.id,
            cardId: instance.cardId,
            title: instance.card.title,
            rarity: instance.card.rarity,
            imageUrl: instance.card.imageUrl,
            tags: instance.card.tags,
            authors: resolveCardAuthorsFromTags(instance.card.tags, instance.card.authorKeys),
            wikidotId: instance.card.wikidotId,
            pageId: instance.card.pageId,
            isRetired: isRetiredCard(instance.card),
            affixVisualStyle: instance.affixVisualStyle,
            affixSignature: instance.affixSignature,
            affixLabel: instance.affixLabel
          }
        };
      });

      res.json({ ok: true, slot: result });
    } catch (error: any) {
      if (error instanceof z.ZodError) return res.status(400).json({ error: error.issues[0]?.message ?? '参数错误' });
      if (error?.status) return res.status(error.status).json({ error: error.message });
      next(error);
    }
  });

  router.post('/showcases/:id/slots/:slotIndex/clear', async (req, res, next) => {
    try {
      if (!req.authUser) return res.status(401).json({ error: '未登录' });
      const slotIndex = Math.floor(Number(req.params.slotIndex));
      if (!Number.isFinite(slotIndex) || slotIndex < 0 || slotIndex >= SHOWCASE_SLOT_MAX) {
        return res.status(400).json({ error: `槽位索引必须在 0-${SHOWCASE_SLOT_MAX - 1} 之间` });
      }
      const userId = req.authUser.id;

      await prisma.$transaction(async (tx) => {
        const showcase = await tx.gachaShowcase.findFirst({ where: { id: req.params.id, userId } });
        if (!showcase) throw Object.assign(new Error('展示柜不存在'), { status: 404 });

        const slot = await tx.gachaShowcaseSlot.findFirst({ where: { showcaseId: showcase.id, slotIndex } });
        if (slot) {
          await tx.gachaShowcaseSlot.deleteMany({ where: { showcaseId: showcase.id, slotIndex } });
          await tx.gachaCardInstance.update({ where: { id: slot.instanceId }, data: { isLocked: false, lockedAt: null } });
        }
      });

      res.json({ ok: true });
    } catch (error: any) {
      if (error?.status) return res.status(error.status).json({ error: error.message });
      next(error);
    }
  });

  router.post('/showcases/:id/reorder', async (req, res, next) => {
    try {
      if (!req.authUser) return res.status(401).json({ error: '未登录' });
      const { slotOrder } = z.object({ slotOrder: z.array(z.number().int().min(0).max(SHOWCASE_SLOT_MAX - 1)) }).parse(req.body ?? {});
      const userId = req.authUser.id;
      const showcase = await prisma.gachaShowcase.findFirst({
        where: { id: req.params.id, userId },
        include: { slots: true }
      });
      if (!showcase) return res.status(404).json({ error: '展示柜不存在' });

      // Reorder: slotOrder[newIndex] = oldSlotIndex
      await prisma.$transaction(async (tx) => {
        // Clear all slots first (temp), then re-assign
        const existingSlots = showcase.slots;
        // Delete all current slots
        await tx.gachaShowcaseSlot.deleteMany({ where: { showcaseId: showcase.id } });
        // Re-create with new order
        for (let newIdx = 0; newIdx < slotOrder.length; newIdx++) {
          const oldSlot = existingSlots.find((s) => s.slotIndex === slotOrder[newIdx]);
          if (oldSlot) {
            // eslint-disable-next-line no-await-in-loop
            await tx.gachaShowcaseSlot.create({
              data: { showcaseId: showcase.id, slotIndex: newIdx, instanceId: oldSlot.instanceId }
            });
          }
        }
      });

      res.json({ ok: true });
    } catch (error: any) {
      if (error instanceof z.ZodError) return res.status(400).json({ error: error.issues[0]?.message ?? '参数错误' });
      next(error);
    }
  });

  // ─── Batch Dismantle: Preview (dry-run) ────────────────

  router.post('/dismantle/batch/preview', async (req, res, next) => {
    try {
      if (!req.authUser) return res.status(401).json({ error: '未登录' });
      const payload = dismantleBatchSchema.parse(req.body ?? {});
      const userId = req.authUser.id;
      const maxRarityIndex = RARITY_ORDER.indexOf(payload.maxRarity);
      if (maxRarityIndex < 0) return res.status(400).json({ error: '稀有度参数无效' });

      const allowedRarities = RARITY_ORDER.slice(0, maxRarityIndex + 1);
      const inventoryItems = await prisma.gachaInventory.findMany({
        where: { userId, count: { gt: 0 }, card: { rarity: { in: allowedRarities } } },
        include: { card: true }
      });

      const byRarityCount: Record<GachaRarity, number> = { WHITE: 0, GREEN: 0, BLUE: 0, PURPLE: 0, GOLD: 0 };
      const byRarityReward: Record<GachaRarity, number> = { WHITE: 0, GREEN: 0, BLUE: 0, PURPLE: 0, GOLD: 0 };

      if (!inventoryItems.length) {
        return res.json({
          ok: true,
          preview: {
            maxRarity: payload.maxRarity,
            keepAtLeast: payload.keepAtLeast,
            keepScope: payload.keepScope,
            cardsAffected: 0,
            totalCount: 0,
            totalReward: 0,
            byRarity: RARITY_ORDER.map((rarity) => ({ rarity, count: 0, reward: 0 }))
          }
        });
      }

      const cardIds = Array.from(new Set(inventoryItems.map((i) => i.cardId)));
      const allFreeInstances = cardIds.length > 0
        ? await prisma.gachaCardInstance.findMany({
          where: { userId, cardId: { in: cardIds }, tradeListingId: null, buyRequestId: null, isLocked: false, placementSlot: { is: null }, showcaseSlot: { is: null } },
          orderBy: { obtainedAt: 'asc' }
        })
        : [];
      const freeByCard = new Map<string, typeof allFreeInstances>();
      for (const inst of allFreeInstances) {
        const list = freeByCard.get(inst.cardId) ?? [];
        list.push(inst);
        freeByCard.set(inst.cardId, list);
      }

      let cardsAffected = 0;
      let totalCount = 0;
      let totalReward = 0;

      for (const item of inventoryItems) {
        const freeInstances = freeByCard.get(item.cardId) ?? [];
        const toPreview = selectBatchDismantleInstances(freeInstances, payload.keepAtLeast, payload.keepScope);
        const dismantleCount = toPreview.length;
        if (dismantleCount <= 0) continue;
        const consumeGroups = new Map<string, number>();
        for (const inst of toPreview) {
          consumeGroups.set(inst.affixSignature, (consumeGroups.get(inst.affixSignature) ?? 0) + 1);
        }
        const consumed: Array<{ affixVisualStyle: AffixVisualStyle; affixSignature: string; affixStyles: AffixVisualStyle[]; count: number }> = [];
        for (const [signature, count] of consumeGroups) {
          const fp = buildAffixFingerprintFromSignature(signature);
          consumed.push({ affixVisualStyle: fp.affixVisualStyle, affixSignature: fp.affixSignature, affixStyles: fp.affixStyles, count });
        }
        const rewardDetail = computeDismantleRewardByAffix(item.card, consumed);
        totalCount += dismantleCount;
        totalReward += rewardDetail.totalReward;
        cardsAffected += 1;
        byRarityCount[item.card.rarity] += dismantleCount;
        byRarityReward[item.card.rarity] += rewardDetail.totalReward;
      }

      res.json({
        ok: true,
        preview: {
          maxRarity: payload.maxRarity,
          keepAtLeast: payload.keepAtLeast,
          keepScope: payload.keepScope,
          cardsAffected,
          totalCount,
          totalReward,
          byRarity: RARITY_ORDER.map((rarity) => ({ rarity, count: byRarityCount[rarity], reward: byRarityReward[rarity] }))
        }
      });
    } catch (error: any) {
      if (error instanceof z.ZodError) return res.status(400).json({ error: error.issues[0]?.message ?? '参数错误' });
      next(error);
    }
  });

  // ─── Batch Dismantle: Selective ────────────────────────

  const dismantleBatchSelectiveSchema = z.object({
    keepAtLeast: z.number().int().min(0).max(999).optional().default(1),
    items: z.array(z.object({
      cardId: z.string().trim(),
      affixSignature: z.string().trim().optional(),
      affixVisualStyle: z.string().trim().optional(),
      count: z.number().int().min(1)
    })).min(1).max(500)
  });

  router.post('/dismantle/batch-selective', async (req, res, next) => {
    try {
      if (!req.authUser) return res.status(401).json({ error: '未登录' });
      const payload = dismantleBatchSelectiveSchema.parse(req.body ?? {});
      const scope = buildIdempotencyScope(req, req.authUser.id);
      const outcome = await executeIdempotent(scope, async (tx) => {
        const userId = req.authUser!.id;
        const wallet = await ensureWallet(tx, userId);

        let cardsAffected = 0;
        let totalCount = 0;
        let totalReward = 0;
        const byRarityCount: Record<GachaRarity, number> = { WHITE: 0, GREEN: 0, BLUE: 0, PURPLE: 0, GOLD: 0 };
        const byRarityReward: Record<GachaRarity, number> = { WHITE: 0, GREEN: 0, BLUE: 0, PURPLE: 0, GOLD: 0 };

        for (const item of payload.items) {
          const normalizedSignature = item.affixSignature
            ? affixSignatureFromStyles(parseAffixSignature(item.affixSignature))
            : undefined;
          const instanceWhere: Prisma.GachaCardInstanceWhereInput = {
            userId,
            cardId: item.cardId,
            tradeListingId: null,
            buyRequestId: null
          };
          if (normalizedSignature) {
            instanceWhere.affixSignature = normalizedSignature;
          }

          // Server-side retention guard: destructive count must always respect keepAtLeast
          // against the current instance set, not just the stale client snapshot.
          // We must preserve at least `keepAtLeast` instances OR all locked instances,
          // whichever is greater. Locked instances are never deletable anyway, so the
          // effective minimum to keep = max(lockedOwnedCount, keepAtLeast).
          const [totalOwnedCount, lockedOwnedCount] = await Promise.all([
            tx.gachaCardInstance.count({ where: instanceWhere }),
            tx.gachaCardInstance.count({ where: { ...instanceWhere, isLocked: true } })
          ]);
          const minKeep = Math.max(lockedOwnedCount, payload.keepAtLeast);
          const maxDeletableCount = Math.max(0, totalOwnedCount - minKeep);
          const targetDeleteCount = Math.min(item.count, maxDeletableCount);
          if (targetDeleteCount <= 0) continue;

          // eslint-disable-next-line no-await-in-loop
          const freeInstances = await findFreeInstances(tx, userId, item.cardId, {
            affixSignature: normalizedSignature,
            limit: targetDeleteCount
          });
          const dismantleCount = Math.min(freeInstances.length, targetDeleteCount);
          if (dismantleCount <= 0) continue;

          const toDelete = freeInstances.slice(0, dismantleCount);
          const consumeGroups = new Map<string, number>();
          for (const inst of toDelete) {
            consumeGroups.set(inst.affixSignature, (consumeGroups.get(inst.affixSignature) ?? 0) + 1);
          }

          // eslint-disable-next-line no-await-in-loop
          const card = await tx.gachaCardDefinition.findUnique({ where: { id: item.cardId } });
          if (!card) continue;

          const consumed: Array<{ affixVisualStyle: AffixVisualStyle; affixSignature: string; affixStyles: AffixVisualStyle[]; count: number }> = [];
          for (const [signature, count] of consumeGroups) {
            const fp = buildAffixFingerprintFromSignature(signature);
            consumed.push({ affixVisualStyle: fp.affixVisualStyle, affixSignature: fp.affixSignature, affixStyles: fp.affixStyles, count });
          }

          // eslint-disable-next-line no-await-in-loop
          await deleteCardInstances(tx, toDelete.map((inst) => inst.id));

          const rewardDetail = computeDismantleRewardByAffix(card, consumed);
          cardsAffected += 1;
          totalCount += dismantleCount;
          totalReward += rewardDetail.totalReward;
          byRarityCount[card.rarity] += dismantleCount;
          byRarityReward[card.rarity] += rewardDetail.totalReward;

          // eslint-disable-next-line no-await-in-loop
          await tx.gachaDismantleLog.create({
            data: { userId, cardId: item.cardId, count: dismantleCount, tokensEarned: rewardDetail.totalReward }
          });
        }

        let updatedWallet = wallet;
        if (totalReward > 0) {
          updatedWallet = await tx.gachaWallet.update({
            where: { id: wallet.id },
            data: { balance: { increment: totalReward }, totalEarned: { increment: totalReward } }
          });
          await recordLedger(tx, wallet.id, userId, totalReward, 'DISMANTLE_BATCH_SELECTIVE_REWARD', {
            keepAtLeast: payload.keepAtLeast,
            cardsAffected,
            itemCount: payload.items.length,
            totalCount,
            totalReward,
            byRarity: RARITY_ORDER.map((rarity) => ({ rarity, count: byRarityCount[rarity], reward: byRarityReward[rarity] }))
          });
        }

        return {
          statusCode: 200,
          responseJson: {
            ok: true,
            wallet: await serializeWalletWithPity(tx, updatedWallet),
            summary: {
              keepAtLeast: payload.keepAtLeast,
              cardsAffected,
              totalCount,
              totalReward,
              byRarity: RARITY_ORDER.map((rarity) => ({ rarity, count: byRarityCount[rarity], reward: byRarityReward[rarity] }))
            }
          }
        };
      });
      res.status(outcome.statusCode).json(outcome.responseJson);
    } catch (error: any) {
      if (error instanceof z.ZodError) return res.status(400).json({ error: error.issues[0]?.message ?? '参数错误' });
      if (error?.status === 400) return res.status(400).json({ error: error.message });
      if (error?.status === 409 || error?.code === 'IDEMPOTENCY_KEY_CONFLICT') {
        return res.status(409).json({ error: 'idempotency_key_conflict' });
      }
      next(error);
    }
  });

  return router;
}

export function gachaAdminRouter() {
  const router = Router();

  router.use(requireAdmin);

  router.get('/economy', async (_req, res, next) => {
    try {
      const rewards = await loadRarityRewards(prisma, true);
      res.json({ ok: true, rewards });
    } catch (error) {
      next(error);
    }
  });

  router.put('/economy', async (req, res, next) => {
    try {
      const payload = economyUpdateSchema.parse(req.body ?? {});
      const current = await loadRarityRewards(prisma);
      const draw = { ...current.drawRewards, ...(payload.drawRewards ?? {}) };
      const dismantle = { ...current.dismantleRewards, ...(payload.dismantleRewards ?? {}) };
      await prisma.$transaction(async (tx) => {
        for (const rarity of RARITY_ORDER) {
          const drawReward = draw[rarity] ?? DEFAULT_DRAW_REWARD_BY_RARITY[rarity];
          const dismantleReward = dismantle[rarity] ?? DEFAULT_DISMANTLE_REWARD_BY_RARITY[rarity];
          await tx.gachaRarityReward.upsert({
            where: { rarity },
            create: { rarity, drawReward, dismantleReward },
            update: { drawReward, dismantleReward }
          });
        }
      });
      invalidateRarityRewardCache();
      const updated = await loadRarityRewards(prisma, true);
      res.json({ ok: true, rewards: updated });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ error: error.issues[0]?.message ?? '参数错误' });
        return;
      }
      next(error);
    }
  });

  router.post('/wallets/adjust', async (req, res, next) => {
    try {
      if (!req.authUser) {
        res.status(401).json({ error: '未登录' });
        return;
      }
      const payload = walletAdjustSchema.parse(req.body ?? {});
      const adminId = req.authUser.id;
      const metadataBase: Prisma.JsonObject = {
        scope: payload.scope,
        adminId,
        reason: payload.reason ?? null,
        message: payload.message ?? null,
        allowNegative: payload.allowNegative
      };
      if (payload.delta === 0) {
        res.json({ ok: true, updated: 0 });
        return;
      }
      if (payload.scope === 'user') {
        const user = payload.userId
          ? await prisma.userAccount.findUnique({ where: { id: payload.userId } })
          : await prisma.userAccount.findUnique({ where: { email: payload.email!.toLowerCase() } });
        if (!user) {
          res.status(404).json({ error: '未找到目标用户' });
          return;
        }
        const wallet = await runSerializableTransaction(async (tx) => {
          const ensured = await ensureWallet(tx, user.id);
          return applyWalletDelta(
            tx,
            ensured,
            payload.delta,
            'ADMIN_ADJUST',
            { ...metadataBase, targetUserId: user.id },
            payload.allowNegative
          );
        });
        res.json({ ok: true, wallet });
        return;
      }

      const summary = await runSerializableTransaction(async (tx) => {
        const wallets = await tx.gachaWallet.findMany({ select: { id: true, userId: true, balance: true } });
        if (wallets.length === 0) {
          return { updated: 0 };
        }
        if (payload.delta < 0 && !payload.allowNegative) {
          const insufficient = wallets.filter((wallet) => wallet.balance + payload.delta < 0);
          if (insufficient.length > 0) {
            throw Object.assign(
              new Error(`共有 ${insufficient.length} 个钱包扣减后余额将为负`),
              { status: 400, code: 'INSUFFICIENT_BALANCE' }
            );
          }
        }
        const data: Prisma.GachaWalletUpdateManyMutationInput = {
          balance: { increment: payload.delta }
        };
        if (payload.delta > 0) {
          data.totalEarned = { increment: payload.delta };
        } else if (payload.delta < 0) {
          data.totalSpent = { increment: -payload.delta };
        }
        await tx.gachaWallet.updateMany({ data });
        await tx.gachaLedgerEntry.createMany({
          data: wallets.map((wallet) => ({
            walletId: wallet.id,
            userId: wallet.userId,
            delta: payload.delta,
            reason: 'ADMIN_ADJUST',
            metadata: { ...metadataBase }
          }))
        });
        return { updated: wallets.length };
      });

      res.json({ ok: true, updated: summary.updated });
    } catch (error: any) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ error: error.issues[0]?.message ?? '参数错误' });
        return;
      }
      if (error?.status === 400) {
        res.status(400).json({ error: error.message });
        return;
      }
      next(error);
    }
  });

  router.get('/analytics', async (req, res, next) => {
    try {
      const period = periodSchema.parse((req.query?.period as string | undefined) ?? '7d');
      const nowDate = now();
      let since: Date | undefined;
      if (period === '7d') {
        since = new Date(nowDate.getTime() - 7 * 24 * 60 * 60 * 1000);
      } else if (period === '30d') {
        since = new Date(nowDate.getTime() - 30 * 24 * 60 * 60 * 1000);
      }

      const whereDraw: Prisma.GachaDrawWhereInput = since ? { createdAt: { gte: since } } : {};
      const whereItem: Prisma.GachaDrawItemWhereInput = since ? { createdAt: { gte: since } } : {};
      const whereDismantle: Prisma.GachaDismantleLogWhereInput = since ? { createdAt: { gte: since } } : {};

      const [drawAgg, itemAgg, dismantleAgg, itemsWithCards] = await Promise.all([
        prisma.gachaDraw.aggregate({
          where: whereDraw,
          _count: { _all: true },
          _sum: { tokensSpent: true, tokensReward: true }
        }),
        prisma.gachaDrawItem.groupBy({
          by: ['rarity'],
          _count: { _all: true },
          where: whereItem
        }),
        prisma.gachaDismantleLog.aggregate({
          where: whereDismantle,
          _sum: { tokensEarned: true }
        }),
        prisma.gachaDrawItem.findMany({
          where: whereItem,
          include: { card: true },
          take: 2000,
          orderBy: { createdAt: 'desc' }
        })
      ]);

      const totalItemsFromAgg = itemAgg.reduce((sum, group) => sum + (group._count?._all ?? 0), 0);
      const rarityDistribution = RARITY_ORDER.map((rarity) => {
        const entry = itemAgg.find((group) => group.rarity === rarity);
        const count = entry?._count?._all ?? 0;
        const percentage = totalItemsFromAgg > 0 ? (count / totalItemsFromAgg) * 100 : 0;
        return {
          rarity,
          count,
          percentage: Number(percentage.toFixed(2))
        };
      });

      const tagCount = new Map<string, number>();
      const pageCount: Array<{ cardId: string; title: string; rarity: GachaRarity; count: number }> = [];

      for (const item of itemsWithCards) {
        const card = item.card;
        if (!card) continue;
        (card.tags ?? []).forEach((tag) => {
          const key = tag.toLowerCase();
          tagCount.set(key, (tagCount.get(key) ?? 0) + 1);
        });
        const existing = pageCount.find((entry) => entry.cardId === card.id);
        if (existing) {
          existing.count += 1;
        } else {
          pageCount.push({
            cardId: card.id,
            title: card.title,
            rarity: card.rarity,
            count: 1
          });
        }
      }

      const topTags = Array.from(tagCount.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([tag, count]) => ({ tag, count }));

      const topPages = pageCount
        .sort((a, b) => b.count - a.count)
        .slice(0, 10)
        .map((entry) => ({
          cardId: entry.cardId,
          title: entry.title,
          rarity: entry.rarity,
          count: entry.count
        }));

      res.json({
        ok: true,
        analytics: {
          period,
          totalDraws: drawAgg._count?._all ?? 0,
          totalTokensAwarded: (drawAgg._sum?.tokensReward ?? 0) + (dismantleAgg._sum?.tokensEarned ?? 0),
          totalTokensDismantled: dismantleAgg._sum?.tokensEarned ?? 0,
          totalTokensSpent: drawAgg._sum?.tokensSpent ?? 0,
          rarityDistribution,
          topTags,
          topPages
        }
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/cards', async (req, res, next) => {
    try {
      const parsed = cardListQuerySchema.parse(req.query ?? {});
      if (parsed.poolId && parsed.poolId !== PERMANENT_POOL_ID) {
        res.status(400).json({ error: '当前仅允许维护常驻卡池' });
        return;
      }
      const limit = Math.min(Math.max(Number(parsed.limit ?? '50'), 1), 200);
      const offset = Math.max(Number(parsed.offset ?? '0'), 0);
      const includeTags = (parsed.includeTags ?? '')
        .split(',')
        .map((tag) => tag.trim().toLowerCase())
        .filter((tag) => tag.length > 0);
      const excludeTags = (parsed.excludeTags ?? '')
        .split(',')
        .map((tag) => tag.trim().toLowerCase())
        .filter((tag) => tag.length > 0);
      const search = parsed.search?.trim();

      const where: Prisma.GachaCardDefinitionWhereInput = { poolId: PERMANENT_POOL_ID };
      if (parsed.rarity) where.rarity = parsed.rarity;

      const andConditions: Prisma.GachaCardDefinitionWhereInput[] = [];
      if (includeTags.length) {
        andConditions.push({ tags: { hasSome: includeTags } });
      }
      if (excludeTags.length) {
        andConditions.push({ NOT: { tags: { hasSome: excludeTags } } });
      }
      if (search) {
        andConditions.push({
          OR: [
            { title: { contains: search, mode: 'insensitive' } },
            { tags: { hasSome: [search.toLowerCase()] } }
          ]
        });
      }
      if (andConditions.length > 0) {
        where.AND = andConditions;
      }

      const [total, cards] = await Promise.all([
        prisma.gachaCardDefinition.count({ where }),
        prisma.gachaCardDefinition.findMany({
          where,
          include: { pool: true },
          orderBy: [{ rarity: 'desc' }, { weight: 'desc' }, { createdAt: 'desc' }],
          skip: offset,
          take: limit
        })
      ]);

      res.json({
        ok: true,
        total,
        items: cards.map((card) => serializeCard(card))
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/boosts', async (req, res, next) => {
    try {
      const activeOnly = ['1', 'true', 'yes'].includes(String(req.query?.active ?? '').toLowerCase());
      const where: Prisma.GachaGlobalBoostWhereInput = {};
      if (activeOnly) {
        const date = now();
        where.isActive = true;
        where.AND = [
          { startsAt: { lte: date } },
          { OR: [{ endsAt: { gte: date } }, { endsAt: null }] }
        ];
      }
      const boosts = await prisma.gachaGlobalBoost.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        include: { createdBy: true }
      });
      res.json({ ok: true, items: boosts.map(serializeBoost) });
    } catch (error) {
      next(error);
    }
  });

  router.post('/boosts', async (req, res, next) => {
    try {
      if (!req.authUser) return res.status(401).json({ error: '未登录' });
      const payload = boostCreateSchema.parse(req.body ?? {});
      const startsAt = toDate(payload.startsAt);
      const endsAt = toDate(payload.endsAt);
      if (payload.startsAt && !startsAt) {
        return res.status(400).json({ error: '开始时间格式错误' });
      }
      if (payload.endsAt && !endsAt) {
        return res.status(400).json({ error: '结束时间格式错误' });
      }
      if (startsAt && endsAt && startsAt >= endsAt) {
        return res.status(400).json({ error: '结束时间需晚于开始时间' });
      }
      const data: Prisma.GachaGlobalBoostCreateInput = {
        includeTags: payload.includeTags,
        excludeTags: payload.excludeTags,
        matchMode: matchModeFromInput(payload.match),
        weightMultiplier: payload.weightMultiplier,
        createdBy: { connect: { id: req.authUser.id } }
      };
      if (startsAt) data.startsAt = startsAt;
      if (endsAt) data.endsAt = endsAt;
      const boost = await prisma.gachaGlobalBoost.create({
        data,
        include: { createdBy: true }
      });
      invalidateDrawPoolCache();
      res.json({ ok: true, boost: serializeBoost(boost) });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ error: error.issues[0]?.message ?? '参数错误' });
        return;
      }
      next(error);
    }
  });

  router.patch('/boosts/:id', async (req, res, next) => {
    try {
      const { id } = req.params;
      const payload = boostPatchSchema.parse(req.body ?? {});
      const startsAtRaw = payload.startsAt;
      const endsAtRaw = payload.endsAt;
      const startsAt = startsAtRaw === undefined ? undefined : toDate(startsAtRaw);
      const endsAt = endsAtRaw === undefined ? undefined : endsAtRaw === null ? null : toDate(endsAtRaw);
      if (startsAtRaw !== undefined && startsAt === null) {
        return res.status(400).json({ error: '开始时间格式错误' });
      }
      if (endsAtRaw !== undefined && endsAtRaw !== null && endsAt === null) {
        return res.status(400).json({ error: '结束时间格式错误' });
      }
      if (startsAt && endsAt && endsAt !== null && startsAt >= endsAt) {
        return res.status(400).json({ error: '结束时间需晚于开始时间' });
      }
      const data: Prisma.GachaGlobalBoostUpdateInput = {
        includeTags: payload.includeTags,
        excludeTags: payload.excludeTags,
        matchMode: payload.match ? matchModeFromInput(payload.match) : undefined,
        weightMultiplier: payload.weightMultiplier,
        isActive: payload.isActive
      };
      if (startsAt !== undefined) {
        data.startsAt = startsAt as Date;
      }
      if (endsAt !== undefined) {
        data.endsAt = endsAt === null ? { set: null } : { set: endsAt };
      }
      const boost = await prisma.gachaGlobalBoost.update({
        where: { id },
        data,
        include: { createdBy: true }
      });
      invalidateDrawPoolCache();
      res.json({ ok: true, boost: serializeBoost(boost) });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ error: error.issues[0]?.message ?? '参数错误' });
        return;
      }
      next(error);
    }
  });

  router.delete('/boosts/:id', async (req, res, next) => {
    try {
      const { id } = req.params;
      await prisma.gachaGlobalBoost.delete({ where: { id } });
      invalidateDrawPoolCache();
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  router.get('/pools', async (req, res, next) => {
    try {
      const includeCards = ['1', 'true', 'yes'].includes(String(req.query?.includeCards ?? '').toLowerCase());
      if (includeCards) {
        const pools = await prisma.gachaPool.findMany({
          where: { id: PERMANENT_POOL_ID },
          orderBy: { createdAt: 'desc' },
          include: { cards: true }
        });
        res.json({
          ok: true,
          items: pools.map((pool) => ({
            ...serializePool(pool),
            cards: pool.cards.map(serializeCard)
          }))
        });
        return;
      }
      const pools = await prisma.gachaPool.findMany({
        where: { id: PERMANENT_POOL_ID },
        orderBy: { createdAt: 'desc' }
      });
      res.json({
        ok: true,
        items: pools.map((pool) => serializePool(pool))
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/pools', async (req, res, next) => {
    try {
      if (!req.authUser) return res.status(401).json({ error: '未登录' });
      res.status(403).json({ error: '当前版本仅允许单常驻卡池，不支持新增卡池' });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ error: error.issues[0]?.message ?? '参数错误' });
        return;
      }
      next(error);
    }
  });

  router.patch('/pools/:id', async (req, res, next) => {
    try {
      const { id } = req.params;
      if (id !== PERMANENT_POOL_ID) {
        res.status(400).json({ error: '当前仅允许维护常驻卡池' });
        return;
      }
      const payload = poolUpdateSchema.parse(req.body ?? {});
      const startsAt = payload.startsAt !== undefined ? toDate(payload.startsAt) : undefined;
      const endsAt = payload.endsAt !== undefined ? toDate(payload.endsAt) : undefined;
      if (startsAt && endsAt && startsAt >= endsAt) {
        return res.status(400).json({ error: '结束时间需晚于开始时间' });
      }
      const pool = await prisma.gachaPool.update({
        where: { id },
        data: {
          name: payload.name,
          description: payload.description,
          tokenCost: FIXED_DRAW_TOKEN_COST,
          tenDrawCost: FIXED_TEN_DRAW_TOKEN_COST,
          rewardPerDuplicate: DEFAULT_DUPLICATE_REWARD,
          startsAt,
          endsAt,
          isActive: payload.isActive
        }
      });
      invalidateDrawPoolCache();
      res.json({ ok: true, pool: serializePool(pool) });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ error: error.issues[0]?.message ?? '参数错误' });
        return;
      }
      next(error);
    }
  });

  router.delete('/pools/:id', async (req, res, next) => {
    try {
      res.status(403).json({ error: '当前版本仅允许单常驻卡池，不支持删除卡池' });
    } catch (error) {
      next(error);
    }
  });

  router.post('/cards', async (req, res, next) => {
    try {
      const payload = cardCreateSchema.parse(req.body ?? {});
      const { drawRewards } = await loadRarityRewards(prisma);
      const card = await prisma.gachaCardDefinition.create({
        data: {
          poolId: PERMANENT_POOL_ID,
          title: payload.title,
          rarity: payload.rarity,
          tags: payload.tags,
          weight: payload.weight ?? DEFAULT_CARD_WEIGHT,
          rewardTokens: payload.rewardTokens ?? drawRewards[payload.rarity] ?? 0,
          wikidotId: payload.wikidotId,
          pageId: payload.pageId,
          imageUrl: payload.imageUrl
        }
      });
      invalidateDrawPoolCache();
      res.json({ ok: true, card: serializeCard(card) });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ error: error.issues[0]?.message ?? '参数错误' });
        return;
      }
      next(error);
    }
  });

  router.patch('/cards/:id', async (req, res, next) => {
    try {
      const { id } = req.params;
      const payload = cardUpdateSchema.parse(req.body ?? {});
      const card = await prisma.gachaCardDefinition.update({
        where: { id },
        data: {
          title: payload.title,
          rarity: payload.rarity,
          tags: payload.tags,
          weight: payload.weight,
          rewardTokens: payload.rewardTokens,
          wikidotId: payload.wikidotId,
          pageId: payload.pageId,
          imageUrl: payload.imageUrl
        }
      });
      invalidateDrawPoolCache();
      res.json({ ok: true, card: serializeCard(card) });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ error: error.issues[0]?.message ?? '参数错误' });
        return;
      }
      next(error);
    }
  });

  router.delete('/cards/:id', async (req, res, next) => {
    try {
      const { id } = req.params;
      const card = await prisma.gachaCardDefinition.findUnique({
        where: { id },
        select: { id: true, title: true }
      });
      if (!card) {
        res.status(404).json({ error: '卡片不存在' });
        return;
      }
      const [inventoryRows, unlockRows, drawItemRows, dismantleRows, placementRows, tradeRows] = await prisma.$transaction([
        prisma.gachaInventory.count({
          where: {
            cardId: id,
            count: { gt: 0 }
          }
        }),
        prisma.gachaCardUnlock.count({ where: { cardId: id } }),
        prisma.gachaDrawItem.count({ where: { cardId: id } }),
        prisma.gachaDismantleLog.count({ where: { cardId: id } }),
        prisma.gachaPlacementSlot.count({
          where: {
            cardId: id,
            assignedAt: { not: null }
          }
        }),
        prisma.gachaTradeListing.count({ where: { cardId: id } })
      ]);
      const dependentRows = inventoryRows + unlockRows + drawItemRows + dismantleRows + placementRows + tradeRows;
      if (dependentRows > 0) {
        res.status(409).json({
          error: 'card_has_user_data',
          message: `卡片「${card.title}」已有用户资产或历史记录，禁止删除`,
          detail: {
            inventoryRows,
            unlockRows,
            drawItemRows,
            dismantleRows,
            placementRows,
            tradeRows
          }
        });
        return;
      }
      await prisma.gachaCardDefinition.delete({ where: { id } });
      invalidateDrawPoolCache();
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  router.post('/cards/batch-adjust', async (req, res, next) => {
    try {
      const payload = cardBatchAdjustSchema.parse(req.body ?? {});
      if (payload.poolId && payload.poolId !== PERMANENT_POOL_ID) {
        res.status(400).json({ error: '当前仅允许维护常驻卡池' });
        return;
      }
      const includeTags = payload.includeTags?.map((tag) => tag.trim().toLowerCase()).filter(Boolean) ?? [];
      const excludeTags = payload.excludeTags?.map((tag) => tag.trim().toLowerCase()).filter(Boolean) ?? [];
      const where: Prisma.GachaCardDefinitionWhereInput = { poolId: PERMANENT_POOL_ID };
      if (payload.rarity) where.rarity = payload.rarity;
      const andConditions: Prisma.GachaCardDefinitionWhereInput[] = [];
      if (includeTags.length) {
        andConditions.push({
          tags: payload.match === 'all'
            ? { hasEvery: includeTags }
            : { hasSome: includeTags }
        });
      }
      if (excludeTags.length) {
        andConditions.push({ NOT: { tags: { hasSome: excludeTags } } });
      }
      if (andConditions.length) {
        where.AND = andConditions;
      }

      const cards = await prisma.gachaCardDefinition.findMany({
        where,
        select: { id: true, weight: true }
      });
      if (cards.length === 0) {
        res.json({ ok: true, matched: 0, updated: 0 });
        return;
      }

      const updates = cards
        .map((card) => {
          const currentWeight = card.weight ?? DEFAULT_CARD_WEIGHT;
          let target = payload.setWeight ?? currentWeight;
          if (payload.multiplier) {
            target = Math.round(target * payload.multiplier);
          }
          target = Math.max(1, Math.min(1000, target));
          if (target === currentWeight) return null;
          return { id: card.id, weight: target };
        })
        .filter((entry): entry is { id: string; weight: number } => entry !== null);

      if (updates.length === 0) {
        res.json({ ok: true, matched: cards.length, updated: 0 });
        return;
      }

      const batches: Array<typeof updates> = [];
      for (let i = 0; i < updates.length; i += 100) {
        batches.push(updates.slice(i, i + 100));
      }

      for (const batch of batches) {
        // eslint-disable-next-line no-await-in-loop
        await prisma.$transaction(
          batch.map((entry) => prisma.gachaCardDefinition.update({
            where: { id: entry.id },
            data: { weight: entry.weight }
          }))
        );
      }

      invalidateDrawPoolCache();
      res.json({ ok: true, matched: cards.length, updated: updates.length });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

export {
  DAILY_REWARD,
  UTC8_OFFSET_MINUTES,
  INITIAL_WALLET_BALANCE,
  FIXED_DRAW_TOKEN_COST,
  FIXED_TEN_DRAW_TOKEN_COST,
  PURPLE_PITY_THRESHOLD,
  GOLD_PITY_THRESHOLD,
  MAX_DRAW_COUNT,
  ALLOWED_DRAW_COUNTS,
  PLACEMENT_SLOT_COUNT_DEFAULT,
  PLACEMENT_SLOT_COUNT_MAX,
  PLACEMENT_SLOT_UNLOCK_COSTS,
  PLACEMENT_BUFFER_CAP_BASE,
  PLACEMENT_OPTION_LIMIT,
  ALBUM_PAGE_QUERY_LIMIT_MAX,
  PLACEMENT_DECIMAL_SCALE,
  DEFAULT_PLACEMENT_YIELD_BOOST_PERCENT,
  IDEMPOTENCY_TTL_HOURS,
  DEFAULT_DUPLICATE_REWARD,
  DEFAULT_CARD_WEIGHT,
  BASE_PLACEMENT_YIELD_BY_RARITY,
  PERMANENT_POOL_ID,
  FEATURE_FLAGS,
  MARKET_POSITION_MAX_OPEN,
  MARKET_LOT_TOKEN,
  INDEX_BASE,
  BFF_BASE_URL,
  BFF_INTERNAL_KEY,
  BFF_INTERNAL_FETCH_TIMEOUT_MS,
  ORACLE_CACHE_TTL_MS,
  ORACLE_TICK_LIMIT_SNAPSHOT,
  ORACLE_TICK_LIMIT_POSITION,
  ORACLE_TICK_CACHE_LIMIT,
  ORACLE_TICK_TIMEFRAME_BUFFER_HOURS,
  MARKET_GLOBAL_POSITION_LOOKBACK_DAYS,
  MARKET_GLOBAL_POSITION_CACHE_TTL_MS,
  MARKET_USER_LEDGER_LOOKBACK_DAYS,
  DRAW_POOL_CACHE_TTL_MS,
  TICKET_LEDGER_REASON_GRANT,
  TICKET_LEDGER_REASON_USE,
  MISSION_CLAIM_REASON,
  ACHIEVEMENT_CLAIM_REASON,
  MARKET_OPEN_REASON,
  MARKET_OPEN_SPEND_REASON,
  MARKET_SETTLE_REASON,
  TRADE_LISTING_CREATE_REASON,
  TRADE_LISTING_CANCEL_REASON,
  TRADE_BUY_SPEND_REASON,
  TRADE_SELL_EARN_REASON,
  PLACEMENT_SLOT_UNLOCK_REASON,
  TRADE_EXPIRY_SWEEP_BATCH_SIZE,
  TRADE_EXPIRY_SWEEP_MAX_BATCHES_PER_RUN,
  TRADE_EXPIRY_SWEEP_INTERVAL_MS,
  DAILY_MISSION_KEY,
  WEEKLY_MISSION_KEY,
  MARKET_LOCK_TIERS,
  MARKET_LOCK_TIER_CONFIG,
  MARKET_LEVERAGE_SURCHARGE_RATE,
  EMPTY_TICKETS,
  MARKET_CATEGORIES,
  MARKET_CONTRACT_ALIASES,
  MARKET_CONTRACTS,
  MISSION_DEFINITIONS,
  ACHIEVEMENT_DEFINITIONS,
  RARITY_ORDER,
  DEFAULT_DISMANTLE_REWARD_BY_RARITY,
  DEFAULT_DRAW_REWARD_BY_RARITY,
  AFFIX_VISUAL_STYLE_VALUES,
  PLACEMENT_COMBO_SAME_RARITY_YIELD_BY_COUNT,
  PLACEMENT_COMBO_SAME_AFFIX_YIELD_BY_COUNT,
  PLACEMENT_COMBO_SAME_PAGE_YIELD_BY_COUNT,
  PLACEMENT_COMBO_SAME_CARD_YIELD_BY_COUNT,
  PLACEMENT_COMBO_SAME_TYPE_YIELD_BY_COUNT,
  PLACEMENT_COMBO_SAME_AUTHOR_YIELD_BY_COUNT,
  PLACEMENT_COMBO_SAME_TAG_YIELD_BY_COUNT,
  PLACEMENT_COMBO_ALL_GOLD_RARITY_YIELD_BONUS,
  PLACEMENT_COMBO_ALL_AFFIX_GOLD_YIELD_BONUS,
  PLACEMENT_CONTENT_TYPE_LABEL,
  PLACEMENT_COLORLESS_ADDON_RATIO,
  PLACEMENT_COLORLESS_ADDON_KIND,
  drawRequestSchema,
  dismantleSchema,
  dismantleBatchSchema,
  inventoryQuerySchema,
  progressQuerySchema,
  historyQuerySchema,
  albumPagesQuerySchema,
  albumVariantsParamSchema,
  placementSlotParamSchema,
  placementSetSchema,
  placementAddonSetSchema,
  ticketReforgeSchema,
  missionClaimParamSchema,
  achievementClaimParamSchema,
  marketTicksQuerySchema,
  marketOpponentsQuerySchema,
  marketPositionOpenSchema,
  marketHistoryQuerySchema,
  tradeListingsQuerySchema,
  tradeCreateSchema,
  tradeBuySchema,
  boostCreateSchema,
  boostPatchSchema,
  poolCreateSchema,
  poolUpdateSchema,
  cardCreateSchema,
  cardUpdateSchema,
  periodSchema,
  cardListQuerySchema,
  cardBatchAdjustSchema,
  rarityRewardSchema,
  economyUpdateSchema,
  walletAdjustSchema,
  parseBooleanEnv,
  now,
  toUtc8DayKey,
  toUtc8WeekKey,
  missionPeriodWindow,
  runSerializableTransaction,
  oracleTickCache,
  drawPoolCache,
  globalMarketPositionCache,
  invalidateDrawPoolCache,
  invalidateGlobalMarketPositionCache,
  invalidateRarityRewardCache,
  ensureWallet,
  applyWalletDelta,
  recordLedger,
  serializeWalletWithPity,
  buildIdempotencyScope,
  executeIdempotent,
  serializeWallet,
  serializePool,
  serializeBoost,
  serializeCard,
  featureStatusPayload,
  rollDrawAffixStyles,
  consumeAffixStacks,
  resolveCardAffixWithBonus,
  computeDismantleRewardByAffix,
  loadDrawPoolSnapshot,
  executeDrawForUser,
  fetchActivePools,
  fetchActiveBoosts,
  resolvePlacementComboBonuses,
  computePlacementMetrics,
  computeTicketBalance,
  consumeTicketBalance,
  loadMissionProgressSnapshots,
  loadUserGachaStats,
  loadOracleContext,
  settleDueMarketPositions,
  runMarketSettleSweep,
  triggerTradeExpirySweep,
  triggerBuyRequestExpirySweep,
  triggerMarketSettleSweep,
  respondFeatureNotReady,
  ensureFeatureEnabled,
  resolveFeatureByPath
};

export type {
  Tx,
  MarketLockTier,
  MarketPositionStatus,
  TicketBalance,
  WalletPityCounters,
  DrawPaymentMethod,
  RewardPack,
  MarketCategory,
  MarketContractDefinition,
  MarketPositionSide,
  MissionPeriodType,
  MissionDefinition,
  AchievementDefinition,
  UserGachaStats,
  MarketTickTimeframe,
  OracleTick,
  OracleCacheEntry,
  DrawPoolCardSnapshot,
  RarityRewardConfig,
  BoostBase,
  BoostWithCreator,
  BoostWithMaybeCreator,
  AffixVisualStyle,
  PlacementAddonKind,
  AffixStyleCountMap,
  AffixStackMap,
  AffixVariantMap,
  AffixFingerprint,
  AffixStackEntry,
  PlacementState,
  PlacementSlotWithCard,
  PlacementAddonWithCard,
  PlacementSlotAffix,
  PlacementContentType,
  PlacementAuthorKey,
  PlacementComboParticipant,
  PlacementComboBonus,
  PlacementMetrics,
  IdempotencyScope,
  IdempotencyOutcome,
  PlacementTagLookup,
  MarketOracleContext,
  MarketOpenPosition,
  MarketSettlementRecord,
  TradeAffixBreakdownEntry,
  TradeListingCardLite,
  TradeListingForExpiry,
  MissionProgressSnapshot,
  GlobalActiveMarketPosition
};
