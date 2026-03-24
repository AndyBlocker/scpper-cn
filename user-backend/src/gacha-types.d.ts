/**
 * Ambient module declaration for @scpper/gacha-types.
 *
 * The canonical definitions live in shared/gacha-types/src/.
 * This declaration lets user-backend import types from '@scpper/gacha-types'
 * without changing rootDir or adding the shared directory to the compilation.
 *
 * Keep this file in sync with shared/gacha-types/src/enums.ts and api-types.ts.
 * If a type is added or changed in the shared package, update this file too.
 */
declare module '@scpper/gacha-types' {
  // ─── Enums ──────────────────────────────────────────────────────────────

  export type Rarity = 'WHITE' | 'GREEN' | 'BLUE' | 'PURPLE' | 'GOLD';
  export const RARITY_VALUES: readonly ['WHITE', 'GREEN', 'BLUE', 'PURPLE', 'GOLD'];

  export type AffixVisualStyle =
    | 'NONE' | 'MONO' | 'SILVER' | 'GOLD' | 'CYAN' | 'PRISM' | 'COLORLESS'
    | 'WILDCARD' | 'SPECTRUM' | 'MIRROR' | 'ORBIT' | 'ECHO'
    | 'NEXUS' | 'ANCHOR' | 'FLUX';

  export const AFFIX_VISUAL_STYLE_VALUES: readonly [
    'NONE', 'MONO', 'SILVER', 'GOLD', 'CYAN', 'PRISM', 'COLORLESS',
    'WILDCARD', 'SPECTRUM', 'MIRROR', 'ORBIT', 'ECHO',
    'NEXUS', 'ANCHOR', 'FLUX',
  ];

  export type MatchMode = 'all' | 'any';
  export type TradeListingStatus = 'OPEN' | 'SOLD' | 'CANCELLED' | 'EXPIRED';
  export type BuyRequestStatus = 'OPEN' | 'FULFILLED' | 'CANCELLED' | 'EXPIRED';
  export type BuyRequestMatchLevel = 'PAGE' | 'IMAGE_VARIANT' | 'COATING';
  export type DrawPaymentMethod = 'TOKEN' | 'DRAW_TICKET' | 'DRAW10_TICKET' | 'AUTO';
  export type DismantleKeepScope = 'CARD' | 'VARIANT';
  export type MarketPositionSide = 'LONG' | 'SHORT';
  export type MarketLockTier = 'T1' | 'T7' | 'T15' | 'T30';
  export type MarketCategory = 'OVERALL' | 'TRANSLATION' | 'SCP' | 'TALE' | 'GOI' | 'WANDERERS';
  export type MarketPositionStatus = 'OPEN' | 'EXPIRED' | 'SETTLED' | 'LIQUIDATED';
  export type MarketTickTimeframe = '24H' | '7D' | '30D';
  export type TradeSearchMode = 'ALL' | 'CARD' | 'SELLER';
  export type TradeSortMode = 'LATEST' | 'PRICE_ASC' | 'PRICE_DESC' | 'TOTAL_ASC' | 'TOTAL_DESC' | 'RARITY_DESC';
  export type MissionPeriodType = 'daily' | 'weekly';

  // ─── API Types ────────────────────────────────────────────────────────

  export type TicketBalance = {
    drawTicket: number;
    draw10Ticket: number;
    affixReforgeTicket: number;
  };

  export type RewardPack = {
    tokens: number;
    tickets: TicketBalance;
  };

  export type RewardPackPartial = {
    tokens?: number;
    tickets?: Partial<TicketBalance>;
  };

  export type MarketContractDefinition = {
    id: MarketCategory;
    category: MarketCategory;
    symbol: MarketCategory;
    name: string;
  };
}
