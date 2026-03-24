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
