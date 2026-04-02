/**
 * Types that cross the API boundary between frontend and backend.
 *
 * These describe the shape of JSON payloads exchanged over HTTP.
 * Display-only types (Tailwind class maps, UI state) stay in the frontend.
 * Internal backend types (Prisma Tx, oracle cache) stay in the backend.
 */

import type {
  Rarity,
  AffixVisualStyle,
  MarketCategory,
  MarketLockTier,
  MarketPositionSide,
  BuyRequestStatus,
  BuyRequestMatchLevel,
  MatchMode,
} from './enums.js';

// ─── Shared sub-shapes ──────────────────────────────────────────────────────

export type AuthorRef = { name: string; wikidotId: number | null };

export type UserRef = {
  id: string;
  displayName: string | null;
  linkedWikidotId: number | null;
};

export type AffixSourceLike = {
  affixSignature?: string | null;
  affixStyles?: AffixVisualStyle[] | null;
  affixStyleCounts?: Partial<Record<AffixVisualStyle, number>> | null;
  affixVisualStyle?: AffixVisualStyle | null;
};

// ─── Wallet ─────────────────────────────────────────────────────────────────

export interface Wallet {
  balance: number;
  totalEarned: number;
  totalSpent: number;
  purplePityCount: number;
  goldPityCount: number;
  lastDailyClaimAt: string | null;
}

// ─── Tickets ────────────────────────────────────────────────────────────────

// Using `type` instead of `interface` so it stays structurally compatible
// with Prisma's JsonObject (interfaces lack implicit index signatures).
export type TicketBalance = {
  drawTicket: number;
  draw10Ticket: number;
  affixReforgeTicket: number;
};

/** API response shape — both fields always present in JSON payloads. */
export type RewardPack = {
  tokens: number;
  tickets: TicketBalance;
};

/** Backend-internal shape used when defining missions/achievements (fields optional). */
export type RewardPackPartial = {
  tokens?: number;
  tickets?: Partial<TicketBalance>;
};

// ─── Feature Flags ──────────────────────────────────────────────────────────

export interface GachaFeatureFlags {
  draw: boolean;
  placement: boolean;
  album: boolean;
  tickets: boolean;
  missions: boolean;
  achievements: boolean;
  market: boolean;
  trade?: boolean;
  buyRequest?: boolean;
}

export interface GachaFeatureStatus {
  timezone: string;
  poolMode: string;
  drawTokenCost: number;
  tenDrawTokenCost: number;
  features: GachaFeatureFlags;
  notes: Record<string, string>;
}

// ─── Pool & Boost ───────────────────────────────────────────────────────────

export interface GachaPool {
  id: string;
  name: string;
  description?: string | null;
  tokenCost: number;
  tenDrawCost: number;
  rewardPerDuplicate: number;
  startsAt: string | null;
  endsAt: string | null;
  isActive: boolean;
}

export interface GlobalBoost {
  id: string;
  includeTags: string[];
  excludeTags: string[];
  match: MatchMode;
  weightMultiplier: number;
  startsAt: string | null;
  endsAt: string | null;
  isActive: boolean;
  createdAt: string | null;
  updatedAt: string | null;
  createdBy?: {
    id: string;
    email: string;
    displayName: string | null;
  } | null;
}

export interface GachaConfig {
  activated: boolean;
  pools: GachaPool[];
  boosts: GlobalBoost[];
}

// ─── Draw ───────────────────────────────────────────────────────────────────

export interface DrawItem {
  id: string;
  title: string;
  rarity: Rarity;
  tags: string[];
  isRetired?: boolean;
  imageUrl: string | null;
  wikidotId: number | null;
  pageId: number | null;
  rewardTokens: number;
  duplicate: boolean;
  countAfter: number;
  affixSignature?: string;
  affixStyles?: AffixVisualStyle[];
  affixStyleCounts?: Partial<Record<AffixVisualStyle, number>>;
  affixVisualStyle?: AffixVisualStyle;
  affixLabel?: string;
  affixYieldBoostPercent?: number;
  affixOfflineBufferBonus?: number;
  affixDismantleBonusPercent?: number;
  authors?: AuthorRef[] | null;
}

export interface DrawResult {
  items: DrawItem[];
  rewardSummary?: {
    totalTokens: number;
    byRarity: Array<{ rarity: Rarity; count: number }>;
  };
  wallet?: Wallet | null;
}

// ─── Inventory ──────────────────────────────────────────────────────────────

export interface InventoryItem {
  id: string;
  cardId: string;
  poolId: string;
  title: string;
  rarity: Rarity;
  tags: string[];
  isRetired?: boolean;
  authors?: AuthorRef[] | null;
  imageUrl: string | null;
  wikidotId: number | null;
  pageId: number | null;
  rewardTokens: number;
  count: number;
  instanceIds?: string[];
  affixSignature?: string;
  affixStyles?: AffixVisualStyle[];
  affixStyleCounts?: Partial<Record<AffixVisualStyle, number>>;
  affixVisualStyle?: AffixVisualStyle;
  affixLabel?: string;
  affixYieldBoostPercent?: number;
  affixOfflineBufferBonus?: number;
  affixDismantleBonusPercent?: number;
}

export interface AdminCard {
  id: string;
  poolId: string;
  poolName: string | null;
  title: string;
  rarity: Rarity;
  weight: number;
  rewardTokens: number;
  tags: string[];
  imageUrl: string | null;
  wikidotId: number | null;
  pageId: number | null;
  createdAt: string | null;
  updatedAt: string | null;
}

// ─── Progress & Dismantle ───────────────────────────────────────────────────

export interface Progress {
  pages: {
    total: number;
    collected: number;
    byRarity: Array<{
      rarity: Rarity;
      total: number;
      collected: number;
    }>;
  };
  imageVariants: {
    total: number;
    collected: number;
  };
  coatings: {
    total: number;
    collected: number;
  };
}

export interface DismantleBatchSummary {
  maxRarity: Rarity;
  keepAtLeast: number;
  keepScope?: 'CARD' | 'VARIANT';
  cardsAffected: number;
  totalCount: number;
  totalReward: number;
  byRarity: Array<{
    rarity: Rarity;
    count: number;
    reward: number;
  }>;
}

// ─── History ────────────────────────────────────────────────────────────────

export interface HistoryItem {
  id: string;
  poolId: string;
  poolName: string | null;
  count: number;
  tokensSpent: number;
  tokensReward: number;
  createdAt: string;
  items: Array<{
    cardId: string;
    title: string;
    rarity: Rarity;
    rewardTokens: number;
    imageUrl: string | null;
    isRetired?: boolean;
  }>;
}

// ─── Placement ──────────────────────────────────────────────────────────────

export interface PlacementSlotCard {
  id: string;
  poolId: string;
  title: string;
  rarity: Rarity;
  tags: string[];
  isRetired?: boolean;
  authors?: AuthorRef[] | null;
  imageUrl: string | null;
  wikidotId: number | null;
  pageId: number | null;
  instanceId?: string;
  isLocked?: boolean;
  affixSignature?: string;
  affixStyles?: AffixVisualStyle[];
  affixStyleCounts?: Partial<Record<AffixVisualStyle, number>>;
  affixVisualStyle?: AffixVisualStyle;
  affixLabel?: string;
  affixYieldBoostPercent?: number;
  affixOfflineBufferBonus?: number;
  affixDismantleBonusPercent?: number;
}

export interface PlacementSlot {
  slotIndex: number;
  assignedAt: string | null;
  yieldPerHour: number;
  card: PlacementSlotCard | null;
}

export interface PlacementComboBonus {
  key: string;
  label: string;
  yieldBoostPercent: number;
}

export interface PlacementAddon {
  kind: 'COLORLESS';
  ratio: number;
  assignedAt: string;
  yieldPerHour: number;
  card: PlacementSlotCard;
}

export interface PlacementOverview {
  slotCount: number;
  slotMaxCount?: number;
  nextUnlockCost?: number | null;
  cap: number;
  offlineBufferBonus?: number;
  offlineBufferBonusRaw?: number;
  offlineBufferCapped?: boolean;
  baseOfflineBufferBonus?: number;
  affixOfflineBufferBonus?: number;
  pendingToken: number;
  claimableToken: number;
  baseYieldPerHour?: number;
  addonYieldPerHour?: number;
  estimatedYieldPerHour: number;
  yieldBoostPercent: number;
  yieldBoostPercentRaw?: number;
  yieldBoostCapped?: boolean;
  baseYieldBoostPercent?: number;
  affixYieldBoostPercent?: number;
  comboYieldBoostPercent?: number;
  comboBonuses?: PlacementComboBonus[];
  lastAccrualAt: string;
  addons?: PlacementAddon[];
  slots: PlacementSlot[];
}

// ─── Album ──────────────────────────────────────────────────────────────────

export interface AlbumPageItem {
  pageId: number;
  wikidotId: number | null;
  title: string;
  highestRarity: Rarity;
  coverImageUrl: string | null;
  totalCount: number;
  variantCount: number;
  tags: string[];
}

export interface AlbumPageDetail {
  pageId: number;
  wikidotId: number | null;
  title: string;
  totalCount: number;
  variantCount: number;
  coverImageUrl: string | null;
}

export interface AlbumSummary {
  totalPages: number;
  totalImageVariants: number;
  totalImageVariantsInPool: number;
  totalPagesInPool: number;
  coatingStyles: number;
  totalOwnedCount: number;
}

export interface AlbumPageVariant {
  cardId: string;
  title: string;
  rarity: Rarity;
  count: number;
  lockedCount?: number;
  tags: string[];
  isRetired?: boolean;
  authors?: AuthorRef[] | null;
  imageUrl: string | null;
  wikidotId: number | null;
  pageId: number | null;
  rewardTokens: number;
  affixSignature?: string;
  affixStyles?: AffixVisualStyle[];
  affixStyleCounts?: Partial<Record<AffixVisualStyle, number>>;
  affixVisualStyle: AffixVisualStyle;
  affixLabel: string;
  affixYieldBoostPercent?: number;
  affixOfflineBufferBonus?: number;
  affixDismantleBonusPercent?: number;
  isAlternateArt?: boolean;
  imageIndex?: number;
}

// ─── Analytics ──────────────────────────────────────────────────────────────

export interface GachaAnalytics {
  period: '7d' | '30d' | 'all';
  totalDraws: number;
  totalTokensAwarded: number;
  totalTokensDismantled: number;
  totalTokensSpent: number;
  rarityDistribution: Array<{ rarity: Rarity; count: number; percentage: number }>;
  topTags: Array<{ tag: string; count: number }>;
  topPages: Array<{ cardId: string; title: string; count: number; rarity: Rarity }>;
}

// ─── Tickets & Missions ─────────────────────────────────────────────────────

export interface TicketUseResult {
  tickets: TicketBalance;
  data?: DrawResult;
  result?: {
    cardId: string;
    title: string;
    before: { affixSignature: string; affixVisualStyle: AffixVisualStyle; affixLabel: string };
    after: { affixSignature: string; affixVisualStyle: AffixVisualStyle; affixLabel: string };
  };
  wallet?: Wallet | null;
}

export interface MissionItem {
  missionKey: string;
  periodType?: 'daily' | 'weekly';
  periodKey?: string;
  title: string;
  description: string;
  target: number;
  progress: number;
  claimable: boolean;
  claimed: boolean;
  claimedAt: string | null;
  reward: RewardPack;
}

export interface AchievementItem {
  achievementKey: string;
  title: string;
  description: string;
  target: number;
  progress: number;
  claimable: boolean;
  claimed: boolean;
  claimedAt: string | null;
  reward: RewardPack;
  hidden?: boolean;
}

// ─── Market ─────────────────────────────────────────────────────────────────

export interface MarketContract {
  id: string;
  category?: MarketCategory | string;
  symbol: MarketCategory | string;
  name: string;
  timeframe?: '24H' | '7D' | '30D';
  rangeStartTs?: string;
  changeBasisTs?: string;
  indexOpen?: number;
  indexOpenDay?: number;
  indexOpenWeek?: number;
  indexOpenMonth?: number;
  indexNow?: number;
  indexClose?: number | null;
  latestPrice: number;
  change?: number;
  changePercent?: number;
  rangeHigh?: number;
  rangeLow?: number;
  rangeVolume?: number;
  change24h: number;
  change24hPercent: number;
  high24h: number;
  low24h: number;
  volume24h: number;
}

export interface MarketLockTierMeta {
  lockTier: MarketLockTier;
  durationHours: number;
  minLots: number;
  lotToken: number;
  leverageOptions: number[];
  stakePreset?: number[];
  openFeeBaseRate: number;
  settleFeeRate: number;
}

export interface MarketTick {
  ts: string;
  asOfTs?: string;
  watermarkTs?: string;
  voteCutoffDate?: string;
  voteRuleVersion?: string;
  price: number;
  crowdDrag?: number;
}

export interface MarketTickDiagnostics {
  asOfTs: string;
  latestTickAsOfTs: string | null;
  latestWatermarkTs: string | null;
  latestVoteCutoffDate: string | null;
  tickLagMs: number | null;
  watermarkLagMs: number | null;
  staleLevel: 'ok' | 'lagging' | 'stale';
}

export interface MarketCandle {
  ts: string;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface MarketPositionMarker {
  ts: string;
  side: MarketPositionSide;
  kind: 'OPEN' | 'SETTLE' | 'EXPIRE';
  price: number;
  positionId: string;
}

export interface MarketPosition {
  positionId: string;
  contractId: string;
  side: MarketPositionSide;
  status?: 'OPEN' | 'EXPIRED' | 'SETTLED' | 'LIQUIDATED';
  lockTier?: MarketLockTier;
  lots?: number;
  margin?: number;
  openFee?: number;
  stake: number;
  leverage: number;
  entryIndex?: number;
  entryPrice: number;
  entryTickTs?: string;
  expireAt?: string;
  openedAt: string;
  currentIndex?: number;
  currentPrice?: number;
  unrealizedPnl?: number;
  unrealizedRoi?: number;
}

export interface MarketSettlement {
  positionId: string;
  contractId: string;
  side: MarketPositionSide;
  status?: 'SETTLED' | 'LIQUIDATED';
  lockTier?: MarketLockTier;
  lots?: number;
  margin?: number;
  openFee?: number;
  stake: number;
  leverage: number;
  entryIndex?: number;
  entryPrice: number;
  settleIndex?: number;
  exitPrice: number;
  settleFee?: number;
  payout: number;
  pnl: number;
  expireAt?: string;
  liquidatedAt?: string | null;
  settledAt: string;
}

export interface MarketOpponentSnapshot {
  asOfTs?: string;
  updatedAt: string;
  mood: string;
  category?: MarketCategory | string;
  contractId?: string;
  lockTier?: MarketLockTier | null;
  benchmark?: MarketContract;
  longUsers?: number;
  shortUsers?: number;
  longLots?: number;
  shortLots?: number;
  longMargin?: number;
  shortMargin?: number;
  leaderboard?: Array<{
    rank: number;
    userId: string;
    displayName: string;
    linkedWikidotId: number | null;
    balance: number;
    totalMargin?: number;
    netMargin?: number;
    longLots?: number;
    shortLots?: number;
    longMargin?: number;
    shortMargin?: number;
  }>;
}

export interface MarketContractDefinition {
  id: MarketCategory;
  category: MarketCategory;
  symbol: MarketCategory;
  name: string;
}

// ─── Trade ──────────────────────────────────────────────────────────────────

export interface TradeListing {
  id: string;
  sellerId: string;
  buyerId: string | null;
  cardId: string;
  quantity: number;
  remaining: number;
  unitPrice: number;
  totalPrice: number;
  status: 'OPEN' | 'SOLD' | 'CANCELLED' | 'EXPIRED';
  expiresAt: string | null;
  soldAt: string | null;
  createdAt: string;
  updatedAt: string;
  affixBreakdown?: Array<{
    affixSignature?: string;
    affixStyles?: AffixVisualStyle[];
    affixStyleCounts?: Partial<Record<AffixVisualStyle, number>>;
    affixVisualStyle: AffixVisualStyle;
    affixLabel: string;
    count: number;
  }>;
  card: {
    id: string;
    title: string;
    rarity: Rarity;
    imageUrl: string | null;
    tags: string[];
    isRetired?: boolean;
    authors?: AuthorRef[] | null;
    wikidotId: number | null;
    pageId: number | null;
    affixSignature?: string;
    affixStyles?: AffixVisualStyle[];
    affixStyleCounts?: Partial<Record<AffixVisualStyle, number>>;
    affixVisualStyle?: AffixVisualStyle;
    affixLabel?: string;
  };
  seller: UserRef;
  buyer: UserRef | null;
}

// ─── Buy Request ────────────────────────────────────────────────────────────

export interface BuyRequestOfferedCard {
  id: string;
  cardId: string;
  quantity: number;
  card: {
    id: string;
    title: string;
    rarity: Rarity;
    imageUrl: string | null;
    tags: string[];
    isRetired?: boolean;
    authors?: AuthorRef[] | null;
    wikidotId: number | null;
    pageId: number | null;
    affixSignature?: string;
    affixStyles?: AffixVisualStyle[];
    affixStyleCounts?: Partial<Record<AffixVisualStyle, number>>;
    affixVisualStyle?: AffixVisualStyle;
    affixLabel?: string;
  };
}

export interface BuyRequest {
  id: string;
  buyerId: string;
  targetCardId: string;
  matchLevel: BuyRequestMatchLevel;
  requiredCoating: AffixVisualStyle | null;
  tokenOffer: number;
  status: BuyRequestStatus;
  fulfillerId: string | null;
  expiresAt: string | null;
  fulfilledAt: string | null;
  createdAt: string;
  updatedAt: string;
  targetCard: {
    id: string;
    title: string;
    rarity: Rarity;
    imageUrl: string | null;
    tags: string[];
    isRetired?: boolean;
    authors?: AuthorRef[] | null;
    wikidotId: number | null;
    pageId: number | null;
    affixSignature?: string;
    affixStyles?: AffixVisualStyle[];
    affixStyleCounts?: Partial<Record<AffixVisualStyle, number>>;
    affixVisualStyle?: AffixVisualStyle;
    affixLabel?: string;
  };
  buyer: UserRef;
  fulfiller: UserRef | null;
  offeredCards: BuyRequestOfferedCard[];
}

// ─── Trade Activity ────────────────────────────────────────────────────────

export type TradeActivityRole = 'seller' | 'buyer' | 'poster' | 'fulfiller';

export interface TradeActivityItem {
  kind: 'listing' | 'buyRequest';
  role: TradeActivityRole;
  activityTs: string;
  data: TradeListing | BuyRequest;
}

export interface CardCatalogItem {
  id: string;
  title: string;
  rarity: Rarity;
  imageUrl: string | null;
  tags: string[];
  isRetired?: boolean;
  authors?: AuthorRef[] | null;
  wikidotId: number | null;
  pageId: number | null;
}

// ─── Page Catalog ───────────────────────────────────────────────────────────

export interface PageCatalogVariant {
  id: string;
  imageUrl: string | null;
  isRetired?: boolean;
}

export interface PageCatalogEntry {
  pageId: number | null;
  title: string;
  rarity: Rarity;
  tags: string[];
  isRetired?: boolean;
  authors?: AuthorRef[] | null;
  wikidotId: number | null;
  variants: PageCatalogVariant[];
}

// ─── Economy ────────────────────────────────────────────────────────────────

export interface EconomyConfig {
  drawRewards: Record<Rarity, number>;
  dismantleRewards: Record<Rarity, number>;
}
