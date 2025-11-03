import { Router } from 'express';
import { Prisma, GachaRarity, GachaMatchMode } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../db.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { requireAdmin } from '../middleware/requireAdmin.js';

type Tx = Prisma.TransactionClient;

const DAILY_REWARD = 100;
const INITIAL_WALLET_BALANCE = 500;
const MAX_DRAW_COUNT = 10;
const DEFAULT_DUPLICATE_REWARD = 5;
const DEFAULT_CARD_WEIGHT = 1;
const PERMANENT_POOL_ID = process.env.GACHA_PERMANENT_POOL_ID || 'permanent-main-pool';

const RARITY_ORDER: GachaRarity[] = ['WHITE', 'GREEN', 'BLUE', 'PURPLE', 'GOLD'];

const DEFAULT_DISMANTLE_REWARD_BY_RARITY: Record<GachaRarity, number> = {
  WHITE: 2,
  GREEN: 5,
  BLUE: 10,
  PURPLE: 50,
  GOLD: 100
};

const DEFAULT_DRAW_REWARD_BY_RARITY: Record<GachaRarity, number> = {
  WHITE: 1,
  GREEN: 10,
  BLUE: 50,
  PURPLE: 100,
  GOLD: 200
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

function isRetryableTransactionError(error: unknown): error is Prisma.PrismaClientKnownRequestError {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034';
}

async function runSerializableTransaction<T>(task: (tx: Tx) => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= SERIALIZABLE_RETRY_ATTEMPTS; attempt += 1) {
    try {
      return await prisma.$transaction((tx) => task(tx), {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable
      });
    } catch (error) {
      lastError = error;
      if (!isRetryableTransactionError(error) || attempt === SERIALIZABLE_RETRY_ATTEMPTS) {
        throw error;
      }
      const delayMs = SERIALIZABLE_RETRY_BASE_DELAY_MS * attempt;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError ?? new Error('Serializable transaction failed');
}

const drawRequestSchema = z.object({
  poolId: z.string().trim().optional(),
  count: z.number().int().min(1).max(MAX_DRAW_COUNT)
});

const dismantleSchema = z.object({
  cardId: z.string().trim().min(1),
  count: z.number().int().min(1)
});

const inventoryQuerySchema = z.object({
  poolId: z.string().trim().optional(),
  rarity: z.string().trim().optional(),
  limit: z.string().trim().optional(),
  offset: z.string().trim().optional()
});

const progressQuerySchema = z.object({
  poolId: z.string().trim().optional()
});

const historyQuerySchema = z.object({
  poolId: z.string().trim().optional(),
  limit: z.string().trim().optional()
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
  poolId: z.string().trim().min(1),
  title: z.string().trim().min(1).max(200),
  rarity: z.nativeEnum(GachaRarity),
  tags: z.array(z.string().trim().min(1)).max(30).optional().default([]),
  weight: z.number().int().positive().max(1000).optional(),
  rewardTokens: z.number().int().nonnegative().max(10000).optional(),
  wikidotId: z.number().int().positive().optional(),
  pageId: z.number().int().positive().optional(),
  imageUrl: z.string().url().optional()
});

const cardUpdateSchema = cardCreateSchema.partial().omit({ poolId: true }).extend({
  poolId: z.string().trim().optional()
});

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

function toDate(value?: string | null): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function isWithinRange(date: Date, start?: Date | null, end?: Date | null) {
  if (start && date < start) return false;
  if (end && date > end) return false;
  return true;
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

function computeAdjustedWeight(card: Prisma.GachaCardDefinitionGetPayload<{}>, boosts: Array<{
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

function pickWeightedCard(cards: Array<{ card: Prisma.GachaCardDefinitionGetPayload<{}>; weight: number }>) {
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
) {
  if (delta === 0) return wallet;
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

async function fetchActivePools(tx: typeof prisma | Tx, date = now()) {
  const pools = await tx.gachaPool.findMany({
    where: {
      isActive: true,
      AND: [
        { startsAt: { lte: date } },
        { OR: [{ endsAt: { gte: date } }, { endsAt: null }] }
      ]
    },
    orderBy: [{ startsAt: 'asc' }, { createdAt: 'asc' }]
  });
  if (pools.length > 0) return pools;
  const fallback = await tx.gachaPool.findMany({
    where: { id: PERMANENT_POOL_ID },
    orderBy: [{ createdAt: 'asc' }]
  });
  return fallback;
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
    tokenCost: pool.tokenCost,
    tenDrawCost: pool.tenDrawCost,
    rewardPerDuplicate: pool.rewardPerDuplicate ?? DEFAULT_DUPLICATE_REWARD,
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

function serializeCard(card: Prisma.GachaCardDefinitionGetPayload<{}> & { pool?: { id: string; name: string } | null }) {
  return {
    id: card.id,
    poolId: card.poolId,
    title: card.title,
    rarity: card.rarity,
    tags: card.tags ?? [],
    weight: card.weight ?? DEFAULT_CARD_WEIGHT,
    rewardTokens: card.rewardTokens ?? 0,
    wikidotId: card.wikidotId ?? null,
    pageId: card.pageId ?? null,
    imageUrl: card.imageUrl ?? null,
    createdAt: card.createdAt?.toISOString() ?? null,
    updatedAt: card.updatedAt?.toISOString() ?? null,
    poolName: card.pool?.name ?? null
  };
}

function buildCardCloneKey(card: Prisma.GachaCardDefinitionGetPayload<{}>) {
  if (card.pageId != null) return `page:${card.pageId}`;
  if (card.wikidotId != null) return `wikidot:${card.wikidotId}`;
  return `title:${(card.title ?? '').trim().toLowerCase()}`;
}

async function cloneCardsIntoPool(
  tx: typeof prisma | Tx,
  options: { targetPoolId: string; cloneAllCards?: boolean; sourcePoolId?: string }
) {
  const shouldCloneAll = !!options.cloneAllCards;
  const sourcePoolId = shouldCloneAll ? undefined : options.sourcePoolId;
  if (!shouldCloneAll && !sourcePoolId) {
    return { count: 0 };
  }

  const where: Prisma.GachaCardDefinitionWhereInput = {};
  if (sourcePoolId) {
    where.poolId = sourcePoolId;
  }

  const cards = await tx.gachaCardDefinition.findMany({
    where,
    orderBy: [{ createdAt: 'asc' }]
  });
  if (cards.length === 0) {
    return { count: 0 };
  }

  const shouldDeduplicate = shouldCloneAll && !sourcePoolId;
  const seen = new Set<string>();
  const data: Prisma.GachaCardDefinitionCreateManyInput[] = [];
  for (const card of cards) {
    const key = buildCardCloneKey(card);
    if (shouldDeduplicate) {
      if (seen.has(key)) continue;
      seen.add(key);
    }
    data.push({
      poolId: options.targetPoolId,
      title: card.title,
      rarity: card.rarity,
      tags: card.tags ?? [],
      weight: card.weight ?? DEFAULT_CARD_WEIGHT,
      rewardTokens: card.rewardTokens ?? 0,
      wikidotId: card.wikidotId ?? undefined,
      pageId: card.pageId ?? undefined,
      imageUrl: card.imageUrl ?? undefined
    });
  }

  if (data.length === 0) {
    return { count: 0 };
  }

  let totalCreated = 0;
  const batchSize = 200;
  for (let index = 0; index < data.length; index += batchSize) {
    const chunk = data.slice(index, index + batchSize);
    // eslint-disable-next-line no-await-in-loop
    const result = await tx.gachaCardDefinition.createMany({
      data: chunk
    });
    totalCreated += result.count;
  }

  return { count: totalCreated };
}

function buildProgressResponse(totalCards: Prisma.GachaCardDefinitionGetPayload<{}>[], ownedCardIds: Set<string>) {
  const total = totalCards.length;
  const collected = totalCards.filter((card) => ownedCardIds.has(card.id)).length;
  const byRarity = RARITY_ORDER.map((rarity) => {
    const cardsOfRarity = totalCards.filter((card) => card.rarity === rarity);
    const totalRarity = cardsOfRarity.length;
    const collectedRarity = cardsOfRarity.filter((card) => ownedCardIds.has(card.id)).length;
    return {
      rarity,
      total: totalRarity,
      collected: collectedRarity
    };
  });
  return { total, collected, byRarity };
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

export function gachaRouter() {
  const router = Router();

  router.use(requireAuth);

  router.get('/config', async (req, res, next) => {
    try {
      if (!req.authUser) return res.status(401).json({ error: '未登录' });
      const [wallet, poolsRaw, boosts] = await Promise.all([
        prisma.gachaWallet.findUnique({ where: { userId: req.authUser.id } }),
        fetchActivePools(prisma),
        fetchActiveBoosts(prisma)
      ]);
      const pools = sortPoolsForDisplay(poolsRaw);
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
      const wallet = await prisma.$transaction((tx) => ensureWallet(tx, req.authUser!.id));
      res.json({ ok: true, wallet });
    } catch (error) {
      next(error);
    }
  });

  router.get('/wallet', async (req, res, next) => {
    try {
      if (!req.authUser) return res.status(401).json({ error: '未登录' });
      const wallet = await prisma.$transaction((tx) => ensureWallet(tx, req.authUser!.id));
      res.json({ ok: true, wallet });
    } catch (error) {
      next(error);
    }
  });

  router.post('/claim-daily', async (req, res, next) => {
    try {
      if (!req.authUser) return res.status(401).json({ error: '未登录' });
      const result = await runSerializableTransaction(async (tx) => {
        const wallet = await ensureWallet(tx, req.authUser!.id);
        const today = now();
        if (wallet.lastDailyClaimAt && isWithinRange(wallet.lastDailyClaimAt, new Date(today.getFullYear(), today.getMonth(), today.getDate()))) {
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
        return updated;
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
        count: req.body?.count
      });
      const activePools = sortPoolsForDisplay(await fetchActivePools(prisma));
      if (activePools.length === 0) {
        return res.status(400).json({ error: '当前没有开放的卡池' });
      }
      const poolId = payload.poolId ?? activePools[0].id;
      const pool = await prisma.gachaPool.findUnique({
        where: { id: poolId },
        include: { cards: true }
      });
      if (!pool || !pool.isActive) {
        return res.status(404).json({ error: '卡池不存在或未开放' });
      }
      if (pool.cards.length === 0) {
        return res.status(400).json({ error: '卡池尚未配置卡片' });
      }
      const boosts = await fetchActiveBoosts(prisma);
      const boostPayload = boosts.map((boost) => ({
        includeTags: boost.includeTags ?? [],
        excludeTags: boost.excludeTags ?? [],
        matchMode: boost.matchMode,
        weightMultiplier: boost.weightMultiplier
      }));

      const drawResult = await runSerializableTransaction(async (tx) => {
        const { drawRewards } = await loadRarityRewards(tx);
        const wallet = await ensureWallet(tx, req.authUser!.id);
        const drawCount = payload.count;
        const costPerDraw = pool.tokenCost ?? 100;
        const totalCost = drawCount === 10
          ? pool.tenDrawCost ?? costPerDraw * 10
          : costPerDraw * drawCount;
        if (wallet.balance < totalCost) {
          throw Object.assign(new Error('Token 余额不足'), { status: 400 });
        }
        const updatedWallet = await tx.gachaWallet.update({
          where: { id: wallet.id },
          data: {
            balance: { decrement: totalCost },
            totalSpent: { increment: totalCost }
          }
        });
        await recordLedger(tx, wallet.id, req.authUser!.id, -totalCost, 'DRAW_SPEND', { poolId, drawCount });

        const cardsWithWeights = pool.cards.map((card) => ({
          card,
          weight: computeAdjustedWeight(card, boostPayload)
        })).filter((item) => item.weight > 0);

        if (cardsWithWeights.length === 0) {
          throw Object.assign(new Error('卡池无有效卡片'), { status: 400 });
        }

        const drawItemsForCreate: Array<{ cardId: string; rarity: GachaRarity; rewardTokens: number }> = [];
        const responseItems: Array<{
          id: string;
          title: string;
          rarity: GachaRarity;
          tags: string[];
          imageUrl: string | null;
          wikidotId: number | null;
          pageId: number | null;
          rewardTokens: number;
          duplicate: boolean;
          countAfter: number;
        }> = [];

        let tokensReward = 0;

        for (let i = 0; i < drawCount; i += 1) {
          const pickedCard = pickWeightedCard(cardsWithWeights);
          if (!pickedCard) continue;

          const inventory = await tx.gachaInventory.findUnique({
            where: { userId_cardId: { userId: req.authUser!.id, cardId: pickedCard.id } }
          });

          const duplicate = !!inventory;
          const newCount = (inventory?.count ?? 0) + 1;

          await tx.gachaInventory.upsert({
            where: { userId_cardId: { userId: req.authUser!.id, cardId: pickedCard.id } },
            create: { userId: req.authUser!.id, cardId: pickedCard.id, count: 1 },
            update: { count: { increment: 1 } }
          });

          const baseReward = pickedCard.rewardTokens ?? drawRewards[pickedCard.rarity] ?? 0;
          let rewardTokens = baseReward;
          if (duplicate) {
            rewardTokens += pool.rewardPerDuplicate ?? DEFAULT_DUPLICATE_REWARD;
          }

          if (rewardTokens > 0) {
            tokensReward += rewardTokens;
          }

          drawItemsForCreate.push({
            cardId: pickedCard.id,
            rarity: pickedCard.rarity,
            rewardTokens
          });

          responseItems.push({
            id: pickedCard.id,
            title: pickedCard.title,
            rarity: pickedCard.rarity,
            tags: pickedCard.tags ?? [],
            imageUrl: pickedCard.imageUrl ?? null,
            wikidotId: pickedCard.wikidotId ?? null,
            pageId: pickedCard.pageId ?? null,
            rewardTokens,
            duplicate,
            countAfter: newCount
          });
        }

        if (tokensReward > 0) {
          const updatedRewardWallet = await tx.gachaWallet.update({
            where: { id: updatedWallet.id },
            data: {
              balance: { increment: tokensReward },
              totalEarned: { increment: tokensReward }
            }
          });
          await recordLedger(tx, wallet.id, req.authUser!.id, tokensReward, 'DRAW_REWARD', { poolId, tokensReward });
          Object.assign(updatedWallet, updatedRewardWallet);
        }

        const drawRecord = await tx.gachaDraw.create({
          data: {
            userId: req.authUser!.id,
            poolId,
            drawCount,
            tokensSpent: totalCost,
            tokensReward,
            items: {
              create: drawItemsForCreate.map((item) => ({
                cardId: item.cardId,
                rarity: item.rarity,
                rewardTokens: item.rewardTokens
              }))
            }
          },
          include: {
            items: {
              include: { card: true }
            }
          }
        });

        return {
          wallet: updatedWallet,
          draw: drawRecord,
          items: responseItems,
          tokensReward,
          tokensSpent: totalCost
        };
      });

      res.json({
        ok: true,
        data: {
          items: drawResult.items,
          rewardSummary: {
            totalTokens: drawResult.tokensReward,
            byRarity: RARITY_ORDER.map((rarity) => ({
              rarity,
              count: drawResult.draw.items.filter((item) => item.card?.rarity === rarity).length
            }))
          },
          wallet: drawResult.wallet
        }
      });
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

  router.post('/dismantle', async (req, res, next) => {
    try {
      if (!req.authUser) return res.status(401).json({ error: '未登录' });
      const payload = dismantleSchema.parse(req.body ?? {});
      const result = await runSerializableTransaction(async (tx) => {
        const { dismantleRewards } = await loadRarityRewards(tx);
        const wallet = await ensureWallet(tx, req.authUser!.id);
        const card = await tx.gachaCardDefinition.findUnique({ where: { id: payload.cardId }, include: { pool: true } });
        if (!card) throw Object.assign(new Error('卡片不存在'), { status: 404 });
        const inventory = await tx.gachaInventory.findUnique({
          where: { userId_cardId: { userId: req.authUser!.id, cardId: card.id } }
        });
        if (!inventory || inventory.count < payload.count) {
          throw Object.assign(new Error('拥有数量不足'), { status: 400 });
        }

        const remaining = inventory.count - payload.count;
        await tx.gachaInventory.update({
          where: { id: inventory.id },
          data: { count: remaining }
        });

        const rewardBase = card.rewardTokens ?? 0;
        const poolReward = card.pool?.rewardPerDuplicate ?? DEFAULT_DUPLICATE_REWARD;
        const rarityReward = dismantleRewards[card.rarity] ?? 0;
        const totalReward = (rewardBase + poolReward + rarityReward) * payload.count;

        const updatedWallet = await tx.gachaWallet.update({
          where: { id: wallet.id },
          data: {
            balance: { increment: totalReward },
            totalEarned: { increment: totalReward }
          }
        });

        await recordLedger(tx, wallet.id, req.authUser!.id, totalReward, 'DISMANTLE_REWARD', { cardId: card.id, count: payload.count });

        await tx.gachaDismantleLog.create({
          data: {
            userId: req.authUser!.id,
            cardId: card.id,
            count: payload.count,
            tokensEarned: totalReward
          }
        });

        return {
          wallet: updatedWallet,
          remaining,
          reward: totalReward
        };
      });

      res.json({ ok: true, wallet: result.wallet, remaining: result.remaining, reward: result.reward });
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

  router.get('/inventory', async (req, res, next) => {
    try {
      if (!req.authUser) return res.status(401).json({ error: '未登录' });
      const parsed = inventoryQuerySchema.parse(req.query ?? {});
      const limit = Math.min(Math.max(Number(parsed.limit ?? '30'), 1), 100);
      const offset = Math.max(Number(parsed.offset ?? '0'), 0);
      const rarityFilter = parsed.rarity ? parsed.rarity.toUpperCase() : null;
      const poolId = parsed.poolId ?? null;

      const where: Prisma.GachaInventoryWhereInput = {
        userId: req.authUser.id,
        card: {}
      };
      if (poolId) {
        (where.card as Prisma.GachaCardDefinitionRelationFilter).is = { poolId };
      }
      if (rarityFilter && RARITY_ORDER.includes(rarityFilter as GachaRarity)) {
        (where.card as Prisma.GachaCardDefinitionRelationFilter).is = {
          ...(where.card as Prisma.GachaCardDefinitionRelationFilter).is,
          rarity: rarityFilter as GachaRarity
        };
      }

      const [items, total] = await Promise.all([
        prisma.gachaInventory.findMany({
          where,
          include: { card: true },
          orderBy: [{ createdAt: 'asc' }],
          skip: offset,
          take: limit
        }),
        prisma.gachaInventory.count({ where })
      ]);

      res.json({
        ok: true,
        items: items.map((item) => ({
          id: item.cardId,
          cardId: item.cardId,
          title: item.card.title,
          rarity: item.card.rarity,
          tags: item.card.tags ?? [],
          imageUrl: item.card.imageUrl ?? null,
          wikidotId: item.card.wikidotId ?? null,
          pageId: item.card.pageId ?? null,
          count: item.count,
          rewardTokens: item.card.rewardTokens ?? 0,
          poolId: item.card.poolId
        })),
        total
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/progress', async (req, res, next) => {
    try {
      if (!req.authUser) return res.status(401).json({ error: '未登录' });
      const parsed = progressQuerySchema.parse(req.query ?? {});
      const pools = sortPoolsForDisplay(await fetchActivePools(prisma));
      if (pools.length === 0) {
        return res.json({
          ok: true,
          progress: buildProgressResponse([], new Set())
        });
      }
      const poolId = parsed.poolId ?? pools[0].id;
      const cards = await prisma.gachaCardDefinition.findMany({
        where: { poolId }
      });
      const inventory = await prisma.gachaInventory.findMany({
        where: {
          userId: req.authUser.id,
          cardId: { in: cards.map((card) => card.id) },
          count: { gt: 0 }
        }
      });
      const ownedSet = new Set(inventory.map((item) => item.cardId));
      res.json({
        ok: true,
        progress: buildProgressResponse(cards, ownedSet)
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/history', async (req, res, next) => {
    try {
      if (!req.authUser) return res.status(401).json({ error: '未登录' });
      const parsed = historyQuerySchema.parse(req.query ?? {});
      const limit = Math.min(Math.max(Number(parsed.limit ?? '20'), 1), 50);
      const poolId = parsed.poolId ?? undefined;
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
            imageUrl: item.card?.imageUrl ?? null
          }))
        }))
      });
    } catch (error) {
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

      const totalItems = itemsWithCards.length;
      const rarityDistribution = RARITY_ORDER.map((rarity) => {
        const entry = itemAgg.find((group) => group.rarity === rarity);
        const count = entry?._count?._all ?? 0;
        const percentage = totalItems > 0 ? (count / totalItems) * 100 : 0;
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

      const where: Prisma.GachaCardDefinitionWhereInput = {};
      if (parsed.poolId) where.poolId = parsed.poolId;
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
      const payload = poolCreateSchema.parse(req.body ?? {});
      const startsAt = toDate(payload.startsAt);
      const endsAt = toDate(payload.endsAt);
      if (startsAt && endsAt && startsAt >= endsAt) {
        return res.status(400).json({ error: '结束时间需晚于开始时间' });
      }
      const result = await prisma.$transaction(async (tx) => {
        const pool = await tx.gachaPool.create({
          data: {
            name: payload.name,
            description: payload.description,
            tokenCost: payload.tokenCost ?? 100,
            tenDrawCost: payload.tenDrawCost ?? (payload.tokenCost ?? 100) * 10,
            rewardPerDuplicate: payload.rewardPerDuplicate ?? DEFAULT_DUPLICATE_REWARD,
            startsAt: startsAt ?? undefined,
            endsAt: endsAt ?? undefined,
            isActive: payload.isActive ?? true,
            createdById: req.authUser!.id
          }
        });
        let copied = 0;
        if (payload.cloneAllCards || payload.cloneFromPoolId) {
          const cloneResult = await cloneCardsIntoPool(tx, {
            targetPoolId: pool.id,
            cloneAllCards: payload.cloneAllCards,
            sourcePoolId: payload.cloneAllCards ? undefined : payload.cloneFromPoolId
          });
          copied = cloneResult.count;
        }
        return { pool, copied };
      });
      res.json({ ok: true, pool: serializePool(result.pool), copied: result.copied });
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
          tokenCost: payload.tokenCost,
          tenDrawCost: payload.tenDrawCost,
          rewardPerDuplicate: payload.rewardPerDuplicate,
          startsAt,
          endsAt,
          isActive: payload.isActive
        }
      });
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
      const { id } = req.params;
      await prisma.gachaPool.delete({ where: { id } });
      res.json({ ok: true });
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
          poolId: payload.poolId,
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
          poolId: payload.poolId ?? undefined,
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
      await prisma.gachaCardDefinition.delete({ where: { id } });
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  router.post('/cards/batch-adjust', async (req, res, next) => {
    try {
      const payload = cardBatchAdjustSchema.parse(req.body ?? {});
      const includeTags = payload.includeTags?.map((tag) => tag.trim().toLowerCase()).filter(Boolean) ?? [];
      const excludeTags = payload.excludeTags?.map((tag) => tag.trim().toLowerCase()).filter(Boolean) ?? [];
      const where: Prisma.GachaCardDefinitionWhereInput = {};
      if (payload.poolId) where.poolId = payload.poolId;
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

      res.json({ ok: true, matched: cards.length, updated: updates.length });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
