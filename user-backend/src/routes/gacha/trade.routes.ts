import type { Router } from 'express';
import { Prisma, GachaRarity } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../db.js';
import * as h from './_helpers.js';

export function registerTradeRoutes(router: Router) {
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
      const parsed = h.tradeListingsQuerySchema.parse(req.query ?? {});
      const limit = h.tradeListingQueryLimit(parsed.limit, 20);
      const offset = Math.max(Number(parsed.offset ?? '0'), 0);
      const status = parsed.status ?? 'OPEN';
      const where: Prisma.GachaTradeListingWhereInput = {};
      const andConditions: Prisma.GachaTradeListingWhereInput[] = [];
      const asOf = h.now();
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
      const searchWhere = await h.buildTradeListingSearchWhere(parsed.search ?? '', searchMode);
      if (searchWhere) {
        andConditions.push(searchWhere);
      }
      if (andConditions.length > 0) {
        where.AND = andConditions;
      }
      const sortMode = parsed.sort ?? 'LATEST';
      h.triggerTradeExpirySweep();
      const [items, total] = await Promise.all([
        prisma.gachaTradeListing.findMany({
          where,
          orderBy: h.buildTradeListingOrderBy(sortMode),
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
        enabled: h.FEATURE_FLAGS.trade,
        items: items.map(h.serializeTradeListing),
        pagination: {
          total,
          limit,
          offset
        },
        ...h.featureStatusPayload()
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
      h.triggerTradeExpirySweep();
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
        enabled: h.FEATURE_FLAGS.trade,
        items: result.map(h.serializeTradeListing),
        pagination: { total, limit, offset },
        ...h.featureStatusPayload()
      });
    } catch (error) {
      next(error);
    }
  });

  // ─── My Activity (unified trade history) ────────────────
  router.get('/trade/my-activity', async (req, res, next) => {
    try {
      if (!req.authUser) return res.status(401).json({ error: '未登录' });
      const userId = req.authUser.id;
      const limit = Math.min(Math.max(Number(req.query?.limit ?? '20'), 1), 60);
      const offset = Math.max(Number(req.query?.offset ?? '0'), 0);
      const fetchSize = limit + offset;

      h.triggerTradeExpirySweep();
      h.triggerBuyRequestExpirySweep();

      const listingStatuses: Array<'SOLD' | 'CANCELLED' | 'EXPIRED'> = ['SOLD', 'CANCELLED', 'EXPIRED'];
      const buyRequestStatuses: Array<'FULFILLED' | 'CANCELLED' | 'EXPIRED'> = ['FULFILLED', 'CANCELLED', 'EXPIRED'];
      const listingWhere: Prisma.GachaTradeListingWhereInput = {
        OR: [{ sellerId: userId }, { buyerId: userId }],
        status: { in: listingStatuses }
      };
      const buyRequestWhere: Prisma.GachaBuyRequestWhereInput = {
        OR: [{ buyerId: userId }, { fulfillerId: userId }],
        status: { in: buyRequestStatuses }
      };

      const tradeListingInclude = {
        card: true as const,
        seller: { select: { id: true, displayName: true, linkedWikidotId: true } },
        buyer: { select: { id: true, displayName: true, linkedWikidotId: true } }
      };
      const [listings, listingCount, buyRequests, buyRequestCount] = await Promise.all([
        prisma.gachaTradeListing.findMany({
          where: listingWhere,
          orderBy: [{ updatedAt: 'desc' }],
          take: fetchSize,
          include: tradeListingInclude
        }),
        prisma.gachaTradeListing.count({ where: listingWhere }),
        prisma.gachaBuyRequest.findMany({
          where: buyRequestWhere,
          orderBy: [{ updatedAt: 'desc' }],
          take: fetchSize,
          include: h.buyRequestInclude
        }),
        prisma.gachaBuyRequest.count({ where: buyRequestWhere })
      ]);

      type ActivityItem = { kind: string; role: string; activityTs: string; data: unknown };
      const items: ActivityItem[] = [];

      for (const listing of listings) {
        const role = listing.sellerId === userId ? 'seller' : 'buyer';
        const activityTs = (listing.soldAt ?? listing.updatedAt).toISOString();
        items.push({ kind: 'listing', role, activityTs, data: h.serializeTradeListing(listing) });
      }

      for (const br of buyRequests) {
        const role = br.buyerId === userId ? 'poster' : 'fulfiller';
        const activityTs = (br.fulfilledAt ?? br.updatedAt).toISOString();
        items.push({ kind: 'buyRequest', role, activityTs, data: h.serializeBuyRequest(br) });
      }

      items.sort((a, b) => new Date(b.activityTs).getTime() - new Date(a.activityTs).getTime());
      const paged = items.slice(offset, offset + limit);
      const total = listingCount + buyRequestCount;

      res.json({
        ok: true,
        items: paged,
        pagination: { total, limit, offset },
        ...h.featureStatusPayload()
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/trade/listings', async (req, res, next) => {
    try {
      if (!req.authUser) return res.status(401).json({ error: '未登录' });
      const payload = h.tradeCreateSchema.parse(req.body ?? {});
      const scope = h.buildIdempotencyScope(req, req.authUser.id);
      h.triggerTradeExpirySweep();
      const outcome = await h.executeIdempotent(scope, async (tx) => {
        const userId = req.authUser!.id;
        const card = await tx.gachaCardDefinition.findUnique({
          where: { id: payload.cardId },
          select: { id: true, title: true }
        });
        if (!card) {
          throw Object.assign(new Error('卡片不存在'), { status: 404 });
        }
        const requestedSignature = payload.affixSignature
          ? h.affixSignatureFromStyles(h.parseAffixSignature(payload.affixSignature))
          : undefined;
        // Find free instances and lock them for the trade listing
        const freeInstances = await h.findFreeInstances(tx, userId, card.id, {
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
        const consumedBreakdown = h.normalizeTradeAffixBreakdownEntries(
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
            metadata: h.serializeTradeListingAffixBreakdown(consumedBreakdown)
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
        await h.lockInstancesForTrade(tx, toLock.map((inst) => inst.id), listing.id);
        const wallet = await h.ensureWallet(tx, userId);
        await h.recordLedger(tx, wallet.id, userId, 0, h.TRADE_LISTING_CREATE_REASON, {
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
            enabled: h.FEATURE_FLAGS.trade,
            listing: h.serializeTradeListing(listing),
            wallet: await h.serializeWalletWithPity(tx, wallet),
            ...h.featureStatusPayload()
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
      const payload = h.tradeBuySchema.parse(req.body ?? {});
      const scope = h.buildIdempotencyScope(req, req.authUser.id);
      const outcome = await h.executeIdempotent(scope, async (tx) => {
        const buyerId = req.authUser!.id;
        h.triggerTradeExpirySweep();
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
        const didExpireNow = await h.expireTradeListingIfNeeded(tx, {
          id: listing.id,
          sellerId: listing.sellerId,
          remaining: listing.remaining,
          status: listing.status,
          expiresAt: listing.expiresAt,
          metadata: listing.metadata,
          card: listing.card
        }, h.now());
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
        const consumedBreakdown = h.normalizeTradeAffixBreakdownEntries(
          [...breakdownMap.entries()].map(([affixSignature, count]) => ({ affixSignature, count }))
        );
        const totalCost = quantity * listing.unitPrice;
        let buyerWallet = await h.ensureWallet(tx, buyerId);
        if (buyerWallet.balance < totalCost) {
          throw Object.assign(new Error('Token 余额不足'), { status: 400 });
        }
        const sellerWallet = await h.ensureWallet(tx, listing.sellerId);
        buyerWallet = await h.applyWalletDelta(tx, buyerWallet, -totalCost, h.TRADE_BUY_SPEND_REASON, {
          listingId: listing.id,
          cardId: listing.cardId,
          quantity,
          unitPrice: listing.unitPrice,
          byAffix: consumedBreakdown
        });
        await h.applyWalletDelta(tx, sellerWallet, totalCost, h.TRADE_SELL_EARN_REASON, {
          listingId: listing.id,
          buyerId,
          cardId: listing.cardId,
          quantity,
          unitPrice: listing.unitPrice,
          byAffix: consumedBreakdown
        });
        // Transfer instances from seller to buyer
        await h.transferInstances(tx, lockedInstances.map((inst) => inst.id), listing.sellerId, buyerId);
        await h.safeUpsertCardUnlock(tx, buyerId, listing.cardId);
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
        const remainingBreakdown = h.normalizeTradeAffixBreakdownEntries(
          [...remainingBreakdownMap.entries()].map(([affixSignature, count]) => ({ affixSignature, count }))
        );
        const updated = await tx.gachaTradeListing.update({
          where: { id: listing.id },
          data: {
            remaining,
            status: remaining > 0 ? 'OPEN' : 'SOLD',
            buyerId: remaining > 0 ? null : buyerId,
            soldAt: remaining > 0 ? null : h.now(),
            metadata: h.serializeTradeListingAffixBreakdown(remainingBreakdown)
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
            enabled: h.FEATURE_FLAGS.trade,
            listing: h.serializeTradeListing(updated),
            wallet: await h.serializeWalletWithPity(tx, buyerWallet),
            ...h.featureStatusPayload()
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
      const scope = h.buildIdempotencyScope(req, req.authUser.id);
      const outcome = await h.executeIdempotent(scope, async (tx) => {
        h.triggerTradeExpirySweep();
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
        const didExpireNow = await h.expireTradeListingIfNeeded(tx, {
          id: listing.id,
          sellerId: listing.sellerId,
          remaining: listing.remaining,
          status: listing.status,
          expiresAt: listing.expiresAt,
          metadata: listing.metadata,
          card: listing.card
        }, h.now());
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
        await h.unlockTradeInstances(tx, listing.id);
        const updated = await tx.gachaTradeListing.update({
          where: { id: listing.id },
          data: {
            remaining: 0,
            status: 'CANCELLED',
            metadata: h.serializeTradeListingAffixBreakdown([])
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
        const wallet = await h.ensureWallet(tx, req.authUser!.id);
        await h.recordLedger(tx, wallet.id, req.authUser!.id, 0, h.TRADE_LISTING_CANCEL_REASON, {
          listingId: updated.id,
          cardId: updated.cardId,
          quantity: listing.remaining
        });
        return {
          statusCode: 200,
          responseJson: {
            ok: true,
            enabled: h.FEATURE_FLAGS.trade,
            listing: h.serializeTradeListing(updated),
            wallet: await h.serializeWalletWithPity(tx, wallet),
            ...h.featureStatusPayload()
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
      const pools = await h.fetchActivePools(prisma);
      if (pools.length === 0) {
        return res.json({ ok: true, enabled: h.FEATURE_FLAGS.buyRequest, pages: [] });
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
          authors: h.resolveCardAuthorsFromTags(first.tags),
          wikidotId: first.wikidotId ?? null,
          isRetired: group.every((card) => h.isRetiredCard(card)),
          variants: h.buildImageVariants(group.map((c) => ({
            id: c.id,
            imageUrl: c.imageUrl ?? null,
            poolId: c.poolId,
            weight: c.weight
          })))
        };
      });
      res.json({
        ok: true,
        enabled: h.FEATURE_FLAGS.buyRequest,
        pages
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/trade/buy-requests', async (req, res, next) => {
    try {
      if (!req.authUser) return res.status(401).json({ error: '未登录' });
      const parsed = h.buyRequestListSchema.parse(req.query ?? {});
      h.triggerBuyRequestExpirySweep();
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
          const authorMatchedCardIds = await h.findCardIdsByAuthorKeyword(keyword);
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
            ok: true, enabled: h.FEATURE_FLAGS.buyRequest,
            items: [], pagination: { total: 0, limit, offset },
            ...h.featureStatusPayload()
          });
          return;
        }

        where.id = { in: ids };
      }

      const [items, total] = await Promise.all([
        prisma.gachaBuyRequest.findMany({
          where,
          orderBy: h.buildBuyRequestOrderBy(sort),
          take: limit,
          skip: offset,
          include: h.buyRequestInclude
        }),
        prisma.gachaBuyRequest.count({ where })
      ]);

      res.json({
        ok: true,
        enabled: h.FEATURE_FLAGS.buyRequest,
        items: items.map(h.serializeBuyRequest),
        pagination: { total, limit, offset },
        ...h.featureStatusPayload()
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
      h.triggerBuyRequestExpirySweep();
      const result = await prisma.gachaBuyRequest.findMany({
        where: { buyerId: req.authUser!.id },
        orderBy: [{ createdAt: 'desc' }],
        include: h.buyRequestInclude
      });
      res.json({
        ok: true,
        enabled: h.FEATURE_FLAGS.buyRequest,
        items: result.map(h.serializeBuyRequest),
        ...h.featureStatusPayload()
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/trade/buy-requests', async (req, res, next) => {
    try {
      if (!req.authUser) return res.status(401).json({ error: '未登录' });
      const payload = h.buyRequestCreateSchema.parse(req.body ?? {});
      if (payload.tokenOffer <= 0 && payload.offeredCards.length === 0) {
        return res.status(400).json({ error: '必须提供 Token 出价或卡牌出价' });
      }
      const scope = h.buildIdempotencyScope(req, req.authUser.id);
      h.triggerBuyRequestExpirySweep();
      const outcome = await h.executeIdempotent(scope, async (tx) => {
        const userId = req.authUser!.id;
        const targetCard = await tx.gachaCardDefinition.findUnique({
          where: { id: payload.targetCardId },
          select: { id: true, title: true }
        });
        if (!targetCard) {
          throw Object.assign(new Error('目标卡片不存在'), { status: 404 });
        }

        // Token escrow
        let wallet = await h.ensureWallet(tx, userId);
        if (payload.tokenOffer > 0) {
          if (wallet.balance < payload.tokenOffer) {
            throw Object.assign(new Error('Token 余额不足'), { status: 400 });
          }
          wallet = await h.applyWalletDelta(tx, wallet, -payload.tokenOffer, h.BUY_REQUEST_CREATE_REASON, {
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
          include: h.buyRequestInclude
        });

        // Lock offered card instances
        for (const oc of payload.offeredCards) {
          const requestedSignature = oc.affixSignature
            ? h.affixSignatureFromStyles(h.parseAffixSignature(oc.affixSignature))
            : undefined;
          // eslint-disable-next-line no-await-in-loop
          const freeInstances = await h.findFreeInstances(tx, userId, oc.cardId, {
            affixSignature: requestedSignature
          });
          if (freeInstances.length < oc.quantity) {
            const suffix = requestedSignature ? `（词条 ${requestedSignature}）` : '';
            throw Object.assign(new Error(`卡牌 "${oc.cardId}"${suffix} 可用数量不足`), { status: 400 });
          }
          const toLock = freeInstances.slice(0, oc.quantity);
          // eslint-disable-next-line no-await-in-loop
          await h.lockInstancesForBuyRequest(tx, toLock.map((inst) => inst.id), buyRequest.id);
        }

        // Record ledger
        await h.recordLedger(tx, wallet.id, userId, 0, h.BUY_REQUEST_CREATE_REASON, {
          buyRequestId: buyRequest.id,
          targetCardId: targetCard.id,
          tokenOffer: payload.tokenOffer,
          offeredCards: payload.offeredCards
        });

        // Re-fetch with updated relations
        const refreshed = await tx.gachaBuyRequest.findUniqueOrThrow({
          where: { id: buyRequest.id },
          include: h.buyRequestInclude
        });

        return {
          statusCode: 200,
          responseJson: {
            ok: true,
            enabled: h.FEATURE_FLAGS.buyRequest,
            buyRequest: h.serializeBuyRequest(refreshed),
            wallet: await h.serializeWalletWithPity(tx, wallet),
            ...h.featureStatusPayload()
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
      const fulfillPayload = h.buyRequestFulfillSchema.parse(req.body ?? {});
      const selectedCardId = fulfillPayload.selectedCardId?.trim() || undefined;
      const selectedAffixSignature = fulfillPayload.selectedAffixSignature
        ? h.affixSignatureFromStyles(h.parseAffixSignature(fulfillPayload.selectedAffixSignature))
        : undefined;
      const scope = h.buildIdempotencyScope(req, req.authUser.id);
      const outcome = await h.executeIdempotent(scope, async (tx) => {
        const fulfillerId = req.authUser!.id;
        h.triggerBuyRequestExpirySweep();

        const br = await tx.gachaBuyRequest.findUnique({
          where: { id: buyRequestId },
          include: h.buyRequestInclude
        });
        if (!br) {
          throw Object.assign(new Error('求购单不存在'), { status: 404 });
        }

        const didExpire = await h.expireBuyRequestIfNeeded(tx, {
          id: br.id, buyerId: br.buyerId, status: br.status,
          expiresAt: br.expiresAt, tokenOffer: br.tokenOffer
        }, h.now());
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
              const autoFreed = await h.autoFreeInstanceForSale(tx, fulfillerId, cid, { affixSignature: selectedAffixSignature });
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
          const sellerFreeInstances = await h.findFreeInstances(tx, fulfillerId, br.targetCardId, {
            limit: 1,
            affixSignature: selectedAffixSignature
          });
          if (sellerFreeInstances.length >= 1) {
            sellerInstanceId = sellerFreeInstances[0]!.id;
          } else {
            const autoFreed = await h.autoFreeInstanceForSale(tx, fulfillerId, br.targetCardId, {
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
        await h.transferInstances(tx, [sellerInstanceId], fulfillerId, br.buyerId);
        // Decrement seller inventory (h.transferInstances only increments receiver;
        // in the trade-listing flow the lock step already decremented, but here there's no lock)
        await tx.gachaInventory.updateMany({
          where: { userId: fulfillerId, cardId: matchedCardId },
          data: { count: { decrement: 1 } }
        });
        await h.safeUpsertCardUnlock(tx, br.buyerId, matchedCardId);

        // 3. Transfer offered cards (locked instances): buyer → seller
        // These instances were locked during buy-request creation which already decremented
        // the buyer's inventory. We skip h.unlockBuyRequestInstances to avoid +count/-count
        // round-trip — h.transferInstances clears buyRequestId and increments seller inventory.
        const lockedInstances = await tx.gachaCardInstance.findMany({
          where: { buyRequestId: br.id },
          select: { id: true, cardId: true }
        });
        if (lockedInstances.length > 0) {
          await h.transferInstances(tx, lockedInstances.map((i) => i.id), br.buyerId, fulfillerId);
          const uniqueCardIds = [...new Set(lockedInstances.map((i) => i.cardId))];
          for (const cardId of uniqueCardIds) {
            // eslint-disable-next-line no-await-in-loop
            await h.safeUpsertCardUnlock(tx, fulfillerId, cardId);
          }
        }

        // 4. Transfer escrowed tokens to seller
        if (br.tokenOffer > 0) {
          const sellerWallet = await h.ensureWallet(tx, fulfillerId);
          await h.applyWalletDelta(tx, sellerWallet, br.tokenOffer, h.BUY_REQUEST_FULFILL_SELLER_EARN_REASON, {
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
            fulfilledAt: h.now()
          },
          include: h.buyRequestInclude
        });

        const fulfillerWallet = await h.ensureWallet(tx, fulfillerId);
        return {
          statusCode: 200,
          responseJson: {
            ok: true,
            enabled: h.FEATURE_FLAGS.buyRequest,
            buyRequest: h.serializeBuyRequest(updated),
            wallet: await h.serializeWalletWithPity(tx, fulfillerWallet),
            ...h.featureStatusPayload()
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
      const scope = h.buildIdempotencyScope(req, req.authUser.id);
      const outcome = await h.executeIdempotent(scope, async (tx) => {
        const br = await tx.gachaBuyRequest.findUnique({
          where: { id: buyRequestId },
          include: h.buyRequestInclude
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
        await h.unlockBuyRequestInstances(tx, br.id);

        // Refund escrowed tokens
        let wallet = await h.ensureWallet(tx, br.buyerId);
        if (br.tokenOffer > 0) {
          wallet = await h.applyWalletDelta(tx, wallet, br.tokenOffer, h.BUY_REQUEST_CANCEL_REASON, {
            buyRequestId: br.id,
            tokenOffer: br.tokenOffer
          });
        }

        await h.recordLedger(tx, wallet.id, br.buyerId, 0, h.BUY_REQUEST_CANCEL_REASON, {
          buyRequestId: br.id
        });

        const updated = await tx.gachaBuyRequest.update({
          where: { id: br.id },
          data: { status: 'CANCELLED' },
          include: h.buyRequestInclude
        });

        return {
          statusCode: 200,
          responseJson: {
            ok: true,
            enabled: h.FEATURE_FLAGS.buyRequest,
            buyRequest: h.serializeBuyRequest(updated),
            wallet: await h.serializeWalletWithPity(tx, wallet),
            ...h.featureStatusPayload()
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
}
