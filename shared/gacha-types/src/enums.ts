/**
 * Gacha shared enums — single source of truth.
 *
 * Values are kept in sync with user-backend/prisma/schema.prisma.
 * Both frontend and backend import from here instead of defining their own.
 */

// ─── Rarity ──────────────────────────────────────────────────────────────────

export type Rarity = 'WHITE' | 'GREEN' | 'BLUE' | 'PURPLE' | 'GOLD';

export const RARITY_VALUES = ['WHITE', 'GREEN', 'BLUE', 'PURPLE', 'GOLD'] as const;

// ─── Affix Visual Style ──────────────────────────────────────────────────────

export type AffixVisualStyle =
  | 'NONE' | 'MONO' | 'SILVER' | 'GOLD' | 'CYAN' | 'PRISM' | 'COLORLESS'
  | 'WILDCARD' | 'SPECTRUM' | 'MIRROR' | 'ORBIT' | 'ECHO'
  | 'NEXUS' | 'ANCHOR' | 'FLUX';

export const AFFIX_VISUAL_STYLE_VALUES = [
  'NONE', 'MONO', 'SILVER', 'GOLD', 'CYAN', 'PRISM', 'COLORLESS',
  'WILDCARD', 'SPECTRUM', 'MIRROR', 'ORBIT', 'ECHO',
  'NEXUS', 'ANCHOR', 'FLUX',
] as const;

// ─── Match Mode ──────────────────────────────────────────────────────────────
// The API uses lowercase; Prisma stores uppercase and the backend converts.

export type MatchMode = 'all' | 'any';

// ─── Trade & Buy Request Status ──────────────────────────────────────────────

export type TradeListingStatus = 'OPEN' | 'SOLD' | 'CANCELLED' | 'EXPIRED';

export type BuyRequestStatus = 'OPEN' | 'FULFILLED' | 'CANCELLED' | 'EXPIRED';

export type BuyRequestMatchLevel = 'PAGE' | 'IMAGE_VARIANT' | 'COATING';

// ─── Draw & Dismantle ────────────────────────────────────────────────────────

export type DrawPaymentMethod = 'TOKEN' | 'DRAW_TICKET' | 'DRAW10_TICKET' | 'AUTO';

export type DismantleKeepScope = 'CARD' | 'VARIANT';

// ─── Market ──────────────────────────────────────────────────────────────────

export type MarketPositionSide = 'LONG' | 'SHORT';

export type MarketLockTier = 'T1' | 'T7' | 'T15' | 'T30';

export type MarketCategory = 'OVERALL' | 'TRANSLATION' | 'SCP' | 'TALE' | 'GOI' | 'WANDERERS';

export type MarketPositionStatus = 'OPEN' | 'EXPIRED' | 'SETTLED' | 'LIQUIDATED';

export type MarketTickTimeframe = '24H' | '7D' | '30D';

// ─── Trade Sort / Search ─────────────────────────────────────────────────────

export type TradeSearchMode = 'ALL' | 'CARD' | 'SELLER';

export type TradeSortMode = 'LATEST' | 'PRICE_ASC' | 'PRICE_DESC' | 'TOTAL_ASC' | 'TOTAL_DESC' | 'RARITY_DESC';

// ─── Mission ─────────────────────────────────────────────────────────────────

export type MissionPeriodType = 'daily' | 'weekly';
