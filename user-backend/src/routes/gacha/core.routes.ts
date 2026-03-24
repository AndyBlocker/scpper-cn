import type { Router } from 'express';
import { Prisma, GachaRarity } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../db.js';
import * as h from './_helpers.js';

export function registerCoreRoutes(router: Router) {
  router.get('/config', async (req, res, next) => {
    try {
      if (!req.authUser) return res.status(401).json({ error: '未登录' });
      const [wallet, poolsRaw, boosts] = await Promise.all([
        prisma.gachaWallet.findUnique({ where: { userId: req.authUser.id } }),
        h.fetchActivePools(prisma),
        h.fetchActiveBoosts(prisma)
      ]);
      const pools = h.sortPoolsForDisplay(
        poolsRaw.filter((pool) => pool.id === h.PERMANENT_POOL_ID)
      );
      res.json({
        ok: true,
        config: {
          activated: !!wallet,
          pools: pools.map(h.serializePool),
          boosts: boosts.map(h.serializeBoost)
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
        const ensured = await h.ensureWallet(tx, req.authUser!.id);
        return h.serializeWalletWithPity(tx, ensured);
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
        const ensured = await h.ensureWallet(tx, req.authUser!.id);
        return h.serializeWalletWithPity(tx, ensured);
      });
      res.json({ ok: true, wallet });
    } catch (error) {
      next(error);
    }
  });

  router.get('/features', async (_req, res) => {
    res.json({
      ok: true,
      ...h.featureStatusPayload()
    });
  });

  router.post('/claim-daily', async (req, res, next) => {
    try {
      if (!req.authUser) return res.status(401).json({ error: '未登录' });
      const result = await h.runSerializableTransaction(async (tx) => {
        const wallet = await h.ensureWallet(tx, req.authUser!.id);
        const today = h.now();
        if (
          wallet.lastDailyClaimAt
          && h.toUtc8DayKey(wallet.lastDailyClaimAt) === h.toUtc8DayKey(today)
        ) {
          throw Object.assign(new Error('今日已领取每日奖励'), { status: 400 });
        }
        const updated = await tx.gachaWallet.update({
          where: { id: wallet.id },
          data: {
            balance: { increment: h.DAILY_REWARD },
            totalEarned: { increment: h.DAILY_REWARD },
            lastDailyClaimAt: today
          }
        });
        await h.recordLedger(tx, wallet.id, req.authUser!.id, h.DAILY_REWARD, 'DAILY_CLAIM', { reward: h.DAILY_REWARD });
        return h.serializeWalletWithPity(tx, updated);
      });
      res.json({ ok: true, wallet: result, reward: h.DAILY_REWARD });
    } catch (error: any) {
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
      const parsed = h.inventoryQuerySchema.parse(req.query ?? {});
      const limit = Math.min(Math.max(Number(parsed.limit ?? '30'), 1), h.PLACEMENT_OPTION_LIMIT);
      const offset = Math.max(Number(parsed.offset ?? '0'), 0);
      const skipTotal = parsed.skipTotal === '1';
      const rarityFilter = parsed.rarity ? parsed.rarity.toUpperCase() : null;
      const poolId = parsed.poolId ?? null;
      const affixFilter = parsed.affixFilter ? parsed.affixFilter.toUpperCase().trim() : null;
      const searchTerm = parsed.search?.trim() || null;
      if (poolId && poolId !== h.PERMANENT_POOL_ID) {
        res.status(400).json({ error: '当前仅支持常驻卡池' });
        return;
      }

      const userId = req.authUser.id;

      // Build dynamic WHERE clause for raw SQL
      let invWhere = Prisma.sql`i."userId" = ${userId} AND i.count > 0`;
      if (rarityFilter && h.RARITY_ORDER.includes(rarityFilter as GachaRarity)) {
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
        const authorCardIds = await h.findCardIdsByAuthorKeyword(searchTerm);
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
            const normalizedSignature = h.affixSignatureFromStyles(h.parseAffixSignature(
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
            const affix = h.resolveCardAffixWithBonus(card, { affixSignature: 'NONE' });
            return [{
              ...affix,
              id: `${row.cardId}:NONE`,
              cardId: row.cardId,
              title: row.title,
              rarity: row.rarity,
              tags: row.tags ?? [],
              authors: h.resolveCardAuthorsFromTags(row.tags),
              imageUrl: row.imageUrl ?? null,
              wikidotId: row.wikidotId ?? null,
              pageId: row.pageId ?? null,
              count: row.inv_count,
              lockedCount: 0,
              rewardTokens: h.DEFAULT_DISMANTLE_REWARD_BY_RARITY[row.rarity as GachaRarity] ?? 0,
              poolId: row.poolId,
              isRetired: h.isRetiredCard({ poolId: row.poolId, weight: row.weight })
            }];
          }
          return variantList
            .sort((a, b) => h.variantEntrySortWeight(a.s) - h.variantEntrySortWeight(b.s))
            .map((v) => {
              const affix = h.resolveCardAffixWithBonus(card, { affixSignature: v.s });
              return {
                ...affix,
                id: `${row.cardId}:${v.s}`,
                cardId: row.cardId,
                title: row.title,
                rarity: row.rarity,
                tags: row.tags ?? [],
                authors: h.resolveCardAuthorsFromTags(row.tags),
                imageUrl: row.imageUrl ?? null,
                wikidotId: row.wikidotId ?? null,
                pageId: row.pageId ?? null,
                count: v.c,
                lockedCount: v.lc,
                rewardTokens: h.DEFAULT_DISMANTLE_REWARD_BY_RARITY[row.rarity as GachaRarity] ?? 0,
                poolId: row.poolId,
                isRetired: h.isRetiredCard({ poolId: row.poolId, weight: row.weight })
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

  router.get('/progress', async (req, res, next) => {
    try {
      if (!req.authUser) return res.status(401).json({ error: '未登录' });
      const parsed = h.progressQuerySchema.parse(req.query ?? {});
      if (parsed.poolId && parsed.poolId !== h.PERMANENT_POOL_ID) {
        res.status(400).json({ error: '当前仅支持常驻卡池' });
        return;
      }
      const pools = h.sortPoolsForDisplay(await h.fetchActivePools(prisma));
      if (pools.length === 0) {
        const emptyByRarity = h.buildProgressResponse([], new Set());
        return res.json({
          ok: true,
          progress: {
            pages: emptyByRarity,
            imageVariants: { total: 0, collected: 0 },
            coatings: { total: 14, collected: 0 }
          }
        });
      }
      const poolId = h.PERMANENT_POOL_ID;
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
            byRarity: h.RARITY_ORDER.map((rarity) => ({
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
      const parsed = h.historyQuerySchema.parse(req.query ?? {});
      if (parsed.poolId && parsed.poolId !== h.PERMANENT_POOL_ID) {
        res.status(400).json({ error: '当前仅支持常驻卡池' });
        return;
      }
      const limit = Math.min(Math.max(Number(parsed.limit ?? '20'), 1), 50);
      const poolId = h.PERMANENT_POOL_ID;
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
            isRetired: item.card ? h.isRetiredCard(item.card) : false
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
          authors: h.resolveCardAuthorsFromTags(inst.card.tags, inst.card.authorKeys),
          wikidotId: inst.card.wikidotId,
          pageId: inst.card.pageId,
          isRetired: h.isRetiredCard(inst.card),
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
      const rarity = h.RARITY_ORDER.includes(rarityRaw as GachaRarity)
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
        const authorCardIds = await h.findCardIdsByAuthorKeyword(search);
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
          authors: h.resolveCardAuthorsFromTags(inst.card.tags, inst.card.authorKeys),
          wikidotId: inst.card.wikidotId,
          pageId: inst.card.pageId,
          isRetired: h.isRetiredCard(inst.card),
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
                authors: h.resolveCardAuthorsFromTags(inst.card.tags, inst.card.authorKeys),
                wikidotId: inst.card.wikidotId,
                pageId: inst.card.pageId,
                isRetired: h.isRetiredCard(inst.card),
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
          const wallet = await h.ensureWallet(tx, userId);
          if (wallet.balance < SHOWCASE_UNLOCK_COST) {
            throw Object.assign(new Error(`余额不足，需要 ${SHOWCASE_UNLOCK_COST} Token`), { status: 400 });
          }
          const updatedWallet = await tx.gachaWallet.update({
            where: { id: wallet.id },
            data: { balance: { decrement: SHOWCASE_UNLOCK_COST }, totalSpent: { increment: SHOWCASE_UNLOCK_COST } }
          });
          await h.recordLedger(tx, wallet.id, userId, -SHOWCASE_UNLOCK_COST, 'SHOWCASE_UNLOCK', { showcaseIndex: count });
          const showcase = await tx.gachaShowcase.create({
            data: { userId, name, sortOrder: count }
          });
          return { showcase, wallet: await h.serializeWalletWithPity(tx, updatedWallet) };
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
            authors: h.resolveCardAuthorsFromTags(instance.card.tags, instance.card.authorKeys),
            wikidotId: instance.card.wikidotId,
            pageId: instance.card.pageId,
            isRetired: h.isRetiredCard(instance.card),
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
}
