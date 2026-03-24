import type { Router } from 'express';
import { Prisma, GachaRarity } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../db.js';
import * as h from './_helpers.js';

export function registerAdminRoutes(router: Router) {
  router.get('/economy', async (_req, res, next) => {
    try {
      const rewards = await h.loadRarityRewards(prisma, true);
      res.json({ ok: true, rewards });
    } catch (error) {
      next(error);
    }
  });

  router.put('/economy', async (req, res, next) => {
    try {
      const payload = h.economyUpdateSchema.parse(req.body ?? {});
      const current = await h.loadRarityRewards(prisma);
      const draw = { ...current.drawRewards, ...(payload.drawRewards ?? {}) };
      const dismantle = { ...current.dismantleRewards, ...(payload.dismantleRewards ?? {}) };
      await prisma.$transaction(async (tx) => {
        for (const rarity of h.RARITY_ORDER) {
          const drawReward = draw[rarity] ?? h.DEFAULT_DRAW_REWARD_BY_RARITY[rarity];
          const dismantleReward = dismantle[rarity] ?? h.DEFAULT_DISMANTLE_REWARD_BY_RARITY[rarity];
          await tx.gachaRarityReward.upsert({
            where: { rarity },
            create: { rarity, drawReward, dismantleReward },
            update: { drawReward, dismantleReward }
          });
        }
      });
      h.invalidateRarityRewardCache();
      const updated = await h.loadRarityRewards(prisma, true);
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
      const payload = h.walletAdjustSchema.parse(req.body ?? {});
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
        const wallet = await h.runSerializableTransaction(async (tx) => {
          const ensured = await h.ensureWallet(tx, user.id);
          return h.applyWalletDelta(
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

      const summary = await h.runSerializableTransaction(async (tx) => {
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
      const period = h.periodSchema.parse((req.query?.period as string | undefined) ?? '7d');
      const nowDate = h.now();
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
      const rarityDistribution = h.RARITY_ORDER.map((rarity) => {
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
      const parsed = h.cardListQuerySchema.parse(req.query ?? {});
      if (parsed.poolId && parsed.poolId !== h.PERMANENT_POOL_ID) {
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

      const where: Prisma.GachaCardDefinitionWhereInput = { poolId: h.PERMANENT_POOL_ID };
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
        items: cards.map((card) => h.serializeCard(card))
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
        const date = h.now();
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
      res.json({ ok: true, items: boosts.map(h.serializeBoost) });
    } catch (error) {
      next(error);
    }
  });

  router.post('/boosts', async (req, res, next) => {
    try {
      if (!req.authUser) return res.status(401).json({ error: '未登录' });
      const payload = h.boostCreateSchema.parse(req.body ?? {});
      const startsAt = h.toDate(payload.startsAt);
      const endsAt = h.toDate(payload.endsAt);
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
        matchMode: h.matchModeFromInput(payload.match),
        weightMultiplier: payload.weightMultiplier,
        createdBy: { connect: { id: req.authUser.id } }
      };
      if (startsAt) data.startsAt = startsAt;
      if (endsAt) data.endsAt = endsAt;
      const boost = await prisma.gachaGlobalBoost.create({
        data,
        include: { createdBy: true }
      });
      h.invalidateDrawPoolCache();
      res.json({ ok: true, boost: h.serializeBoost(boost) });
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
      const payload = h.boostPatchSchema.parse(req.body ?? {});
      const startsAtRaw = payload.startsAt;
      const endsAtRaw = payload.endsAt;
      const startsAt = startsAtRaw === undefined ? undefined : h.toDate(startsAtRaw);
      const endsAt = endsAtRaw === undefined ? undefined : endsAtRaw === null ? null : h.toDate(endsAtRaw);
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
        matchMode: payload.match ? h.matchModeFromInput(payload.match) : undefined,
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
      h.invalidateDrawPoolCache();
      res.json({ ok: true, boost: h.serializeBoost(boost) });
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
      h.invalidateDrawPoolCache();
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
          where: { id: h.PERMANENT_POOL_ID },
          orderBy: { createdAt: 'desc' },
          include: { cards: true }
        });
        res.json({
          ok: true,
          items: pools.map((pool) => ({
            ...h.serializePool(pool),
            cards: pool.cards.map(h.serializeCard)
          }))
        });
        return;
      }
      const pools = await prisma.gachaPool.findMany({
        where: { id: h.PERMANENT_POOL_ID },
        orderBy: { createdAt: 'desc' }
      });
      res.json({
        ok: true,
        items: pools.map((pool) => h.serializePool(pool))
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
      if (id !== h.PERMANENT_POOL_ID) {
        res.status(400).json({ error: '当前仅允许维护常驻卡池' });
        return;
      }
      const payload = h.poolUpdateSchema.parse(req.body ?? {});
      const startsAt = payload.startsAt !== undefined ? h.toDate(payload.startsAt) : undefined;
      const endsAt = payload.endsAt !== undefined ? h.toDate(payload.endsAt) : undefined;
      if (startsAt && endsAt && startsAt >= endsAt) {
        return res.status(400).json({ error: '结束时间需晚于开始时间' });
      }
      const pool = await prisma.gachaPool.update({
        where: { id },
        data: {
          name: payload.name,
          description: payload.description,
          tokenCost: h.FIXED_DRAW_TOKEN_COST,
          tenDrawCost: h.FIXED_TEN_DRAW_TOKEN_COST,
          rewardPerDuplicate: h.DEFAULT_DUPLICATE_REWARD,
          startsAt,
          endsAt,
          isActive: payload.isActive
        }
      });
      h.invalidateDrawPoolCache();
      res.json({ ok: true, pool: h.serializePool(pool) });
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
      const payload = h.cardCreateSchema.parse(req.body ?? {});
      const { drawRewards } = await h.loadRarityRewards(prisma);
      const card = await prisma.gachaCardDefinition.create({
        data: {
          poolId: h.PERMANENT_POOL_ID,
          title: payload.title,
          rarity: payload.rarity,
          tags: payload.tags,
          weight: payload.weight ?? h.DEFAULT_CARD_WEIGHT,
          rewardTokens: payload.rewardTokens ?? drawRewards[payload.rarity] ?? 0,
          wikidotId: payload.wikidotId,
          pageId: payload.pageId,
          imageUrl: payload.imageUrl
        }
      });
      h.invalidateDrawPoolCache();
      res.json({ ok: true, card: h.serializeCard(card) });
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
      const payload = h.cardUpdateSchema.parse(req.body ?? {});
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
      h.invalidateDrawPoolCache();
      res.json({ ok: true, card: h.serializeCard(card) });
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
      h.invalidateDrawPoolCache();
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  router.post('/cards/batch-adjust', async (req, res, next) => {
    try {
      const payload = h.cardBatchAdjustSchema.parse(req.body ?? {});
      if (payload.poolId && payload.poolId !== h.PERMANENT_POOL_ID) {
        res.status(400).json({ error: '当前仅允许维护常驻卡池' });
        return;
      }
      const includeTags = payload.includeTags?.map((tag) => tag.trim().toLowerCase()).filter(Boolean) ?? [];
      const excludeTags = payload.excludeTags?.map((tag) => tag.trim().toLowerCase()).filter(Boolean) ?? [];
      const where: Prisma.GachaCardDefinitionWhereInput = { poolId: h.PERMANENT_POOL_ID };
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
          const currentWeight = card.weight ?? h.DEFAULT_CARD_WEIGHT;
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

      h.invalidateDrawPoolCache();
      res.json({ ok: true, matched: cards.length, updated: updates.length });
    } catch (error) {
      next(error);
    }
  });
}
