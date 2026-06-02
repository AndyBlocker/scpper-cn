import type { Router } from 'express';
import { Prisma, GachaRarity, GachaAffixVisualStyle as PrismaAffixVisualStyle } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../db.js';
import * as h from './_helpers.js';

export function registerTicketsRoutes(router: Router) {
  router.get('/tickets', async (req, res, next) => {
    try {
      if (!req.authUser) return res.status(401).json({ error: '未登录' });
      const result = await h.runSerializableTransaction(async (tx) => {
        const wallet = await h.ensureWallet(tx, req.authUser!.id);
        const tickets = await h.computeTicketBalance(tx, req.authUser!.id);
        return { wallet: await h.serializeWalletWithPity(tx, wallet), tickets };
      });
      res.json({
        ok: true,
        enabled: h.FEATURE_FLAGS.tickets,
        tickets: result.tickets,
        wallet: result.wallet,
        ...h.featureStatusPayload()
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/tickets/draw/use', async (req, res, next) => {
    try {
      if (!req.authUser) return res.status(401).json({ error: '未登录' });
      const drawSnapshot = await h.loadDrawPoolSnapshot(h.now());
      const scope = h.buildIdempotencyScope(req, req.authUser.id);
      const outcome = await h.executeIdempotent(scope, async (tx) => {
        const userId = req.authUser!.id;
        const wallet = await h.ensureWallet(tx, userId);
        await h.consumeTicketBalance(tx, wallet, userId, { drawTicket: 1, draw10Ticket: 0, affixReforgeTicket: 0 }, 'DRAW_TICKET_SINGLE');
        const drawResult = await h.executeDrawForUser(tx, {
          userId,
          drawCount: 1,
          poolId: h.PERMANENT_POOL_ID,
          tokensCost: 0,
          spendReason: 'DRAW_TICKET_SPEND',
          spendMetadata: { ticketType: 'drawTicket', drawCount: 1 },
          prefetchedCards: drawSnapshot,
          wallet
        });
        const tickets = await h.computeTicketBalance(tx, userId);
        return {
          statusCode: 200,
          responseJson: {
            ok: true,
            enabled: h.FEATURE_FLAGS.tickets,
            tickets,
            data: {
              items: drawResult.responseItems,
              rewardSummary: {
                totalTokens: drawResult.totalRewardTokens,
                byRarity: h.RARITY_ORDER.map((rarity) => ({
                  rarity,
                  count: drawResult.rarityCounter[rarity] ?? 0
                }))
              },
              wallet: h.serializeWallet(drawResult.wallet, drawResult.pityCounters)
            },
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

  router.post('/tickets/draw10/use', async (req, res, next) => {
    try {
      if (!req.authUser) return res.status(401).json({ error: '未登录' });
      const drawSnapshot = await h.loadDrawPoolSnapshot(h.now());
      const scope = h.buildIdempotencyScope(req, req.authUser.id);
      const outcome = await h.executeIdempotent(scope, async (tx) => {
        const userId = req.authUser!.id;
        const wallet = await h.ensureWallet(tx, userId);
        await h.consumeTicketBalance(tx, wallet, userId, { drawTicket: 0, draw10Ticket: 1, affixReforgeTicket: 0 }, 'DRAW_TICKET_TEN');
        const drawResult = await h.executeDrawForUser(tx, {
          userId,
          drawCount: 10,
          poolId: h.PERMANENT_POOL_ID,
          tokensCost: 0,
          spendReason: 'DRAW_TICKET_SPEND',
          spendMetadata: { ticketType: 'draw10Ticket', drawCount: 10 },
          prefetchedCards: drawSnapshot,
          wallet
        });
        const tickets = await h.computeTicketBalance(tx, userId);
        return {
          statusCode: 200,
          responseJson: {
            ok: true,
            enabled: h.FEATURE_FLAGS.tickets,
            tickets,
            data: {
              items: drawResult.responseItems,
              rewardSummary: {
                totalTokens: drawResult.totalRewardTokens,
                byRarity: h.RARITY_ORDER.map((rarity) => ({
                  rarity,
                  count: drawResult.rarityCounter[rarity] ?? 0
                }))
              },
              wallet: h.serializeWallet(drawResult.wallet, drawResult.pityCounters)
            },
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

  router.post('/tickets/affix-reforge/use', async (req, res, next) => {
    try {
      if (!req.authUser) return res.status(401).json({ error: '未登录' });
      const payload = h.ticketReforgeSchema.parse(req.body ?? {});
      const scope = h.buildIdempotencyScope(req, req.authUser.id);
      const outcome = await h.executeIdempotent(scope, async (tx) => {
        const userId = req.authUser!.id;
        const requestedSignature = payload.affixSignature
          ? h.affixSignatureFromStyles(h.parseAffixSignature(payload.affixSignature))
          : undefined;
        const wallet = await h.ensureWallet(tx, userId);
        await h.consumeTicketBalance(tx, wallet, userId, { drawTicket: 0, draw10Ticket: 0, affixReforgeTicket: 1 }, 'AFFIX_REFORGE');

        // #97：未指定卡时原实现全量载入用户库存 + 全部自由实例(重库存用户单次操作放大锁/内存),
        // 仅为随机挑一张改造。改为:按卡【聚合】可改造(未交易/未求购[+指定 sig])实例数 → 加权随机
        // 选卡(权重=该卡可改造数,与原分布等价) → 只取该卡最早一条可改造实例。指定卡时按卡计数即可。
        // 不再把全部实例拉进内存与长事务。可改造口径沿用原 allFreeForReforge:仅排除交易/求购
        // (含 locked/placed/showcased,reforge 允许)。
        const eligibleWhere: Prisma.GachaCardInstanceWhereInput = {
          userId,
          tradeListingId: null,
          buyRequestId: null,
          ...(requestedSignature ? { affixSignature: requestedSignature } : {})
        };

        let selectedCardId: string;
        if (payload.cardId) {
          const ownedCount = await tx.gachaInventory.count({ where: { userId, cardId: payload.cardId, count: { gt: 0 } } });
          if (ownedCount <= 0) {
            throw Object.assign(new Error('未找到可改造的卡片实例'), { status: 400 });
          }
          const eligibleCount = await tx.gachaCardInstance.count({ where: { ...eligibleWhere, cardId: payload.cardId } });
          if (eligibleCount <= 0) {
            throw Object.assign(new Error(requestedSignature ? `该卡片暂无词条 ${requestedSignature} 可改造实例` : '该卡片暂无可改造变体'), { status: 400 });
          }
          selectedCardId = payload.cardId;
        } else {
          const groups = await tx.gachaCardInstance.groupBy({
            by: ['cardId'],
            where: eligibleWhere,
            _count: { _all: true }
          });
          if (!groups.length) {
            throw Object.assign(new Error(requestedSignature ? `暂无词条 ${requestedSignature} 可改造实例` : '暂无可改造卡片'), { status: 400 });
          }
          // 加权随机：每卡权重 = 其可改造实例数（与原实现一致的分布）。
          const totalAll = groups.reduce((sum, g) => sum + g._count._all, 0);
          let pick = Math.floor(Math.random() * totalAll);
          selectedCardId = groups[0]!.cardId;
          for (const g of groups) {
            if (pick < g._count._all) { selectedCardId = g.cardId; break; }
            pick -= g._count._all;
          }
        }

        // 取选中卡的库存(含卡定义)与最早一条可改造实例。
        const selectedInventory = await tx.gachaInventory.findFirst({
          where: { userId, cardId: selectedCardId, count: { gt: 0 } },
          include: { card: true }
        });
        const firstEligible = await tx.gachaCardInstance.findFirst({
          where: { ...eligibleWhere, cardId: selectedCardId },
          orderBy: { obtainedAt: 'asc' }
        });
        if (!selectedInventory || !selectedInventory.card || !firstEligible) {
          // 卡定义缺失/并发改动等极端情形(原实现会跳过该卡),按"暂无可改造"处理。
          throw Object.assign(new Error(payload.cardId
            ? (requestedSignature ? `该卡片暂无词条 ${requestedSignature} 可改造实例` : '该卡片暂无可改造变体')
            : '暂无可改造卡片'), { status: 400 });
        }

        const selected = {
          inventory: selectedInventory as typeof selectedInventory & { card: NonNullable<typeof selectedInventory.card> },
          freeInstances: [firstEligible]
        };

        // Pick the first free instance to reforge
        const targetInstance = selected.freeInstances[0];
        if (!targetInstance) {
          throw Object.assign(new Error('暂无可改造卡片'), { status: 400 });
        }

        const beforeFingerprint = h.buildAffixFingerprintFromSignature(targetInstance.affixSignature);
        const beforeSignature = beforeFingerprint.affixSignature;
        const beforeStyleCount = beforeFingerprint.affixStyles.filter((style) => style !== 'NONE').length;
        const nextStyles = h.rollReforgeAffixStyles({
          minCount: Math.max(1, beforeStyleCount),
          excludeSignature: beforeSignature
        });
        const nextFingerprint = h.buildAffixFingerprintFromStyles(nextStyles);
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

        const tickets = await h.computeTicketBalance(tx, userId);
        return {
          statusCode: 200,
          responseJson: {
            ok: true,
            enabled: h.FEATURE_FLAGS.tickets,
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
