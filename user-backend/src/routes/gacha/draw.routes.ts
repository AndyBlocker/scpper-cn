import type { Router } from 'express';
import { Prisma, GachaRarity } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../db.js';
import * as h from './_helpers.js';

export function registerDrawRoutes(router: Router) {
  router.post('/draw', async (req, res, next) => {
    try {
      if (!req.authUser) return res.status(401).json({ error: '未登录' });
      const payload = h.drawRequestSchema.parse({
        poolId: req.body?.poolId,
        paymentMethod: req.body?.paymentMethod,
        count: req.body?.count
      });
      if (payload.poolId && payload.poolId !== h.PERMANENT_POOL_ID) {
        res.status(400).json({ error: '当前仅支持常驻卡池' });
        return;
      }
      const drawSnapshot = await h.loadDrawPoolSnapshot(h.now());

      const scope = h.buildIdempotencyScope(req, req.authUser.id);
      const outcome = await h.executeIdempotent(scope, async (tx) => {
        const userId = req.authUser!.id;
        const drawCount = payload.count;
        const totalCost = drawCount === 10 ? h.FIXED_TEN_DRAW_TOKEN_COST : h.FIXED_DRAW_TOKEN_COST * drawCount;
        const requestedPaymentMethod = payload.paymentMethod as h.DrawPaymentMethod;
        let resolvedPaymentMethod: Exclude<h.DrawPaymentMethod, 'AUTO'> = 'TOKEN';
        let ticketsAfterPayment: h.TicketBalance | null = null;
        let walletForDraw: Prisma.GachaWalletGetPayload<{}> | null = null;
        let ticketDrawConsumeCount = 0;
        let tokenCostForDraw = totalCost;

        if (requestedPaymentMethod === 'TOKEN') {
          resolvedPaymentMethod = 'TOKEN';
        } else {
          const currentTickets = await h.computeTicketBalance(tx, userId);
          resolvedPaymentMethod = h.resolveDrawPaymentMethod(requestedPaymentMethod, drawCount, currentTickets);
          if (resolvedPaymentMethod === 'DRAW_TICKET') {
            const walletForTicket = await h.ensureWallet(tx, userId);
            walletForDraw = walletForTicket;
            ticketDrawConsumeCount = drawCount === 10
              ? Math.min(drawCount, Math.max(0, currentTickets.drawTicket))
              : 1;
            if (ticketDrawConsumeCount > 0) {
              ticketsAfterPayment = await h.consumeTicketBalance(
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
            tokenCostForDraw = Math.max(0, totalCost - (ticketDrawConsumeCount * h.FIXED_DRAW_TOKEN_COST));
          } else if (resolvedPaymentMethod === 'DRAW10_TICKET') {
            const walletForTicket = await h.ensureWallet(tx, userId);
            walletForDraw = walletForTicket;
            ticketsAfterPayment = await h.consumeTicketBalance(
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
          poolId: h.PERMANENT_POOL_ID,
          drawCount,
          paymentMethod: resolvedPaymentMethod,
          tokenCost: tokenCostForDraw
        };
        if (ticketDrawConsumeCount > 0) {
          spendMetadata.drawTicketConsumed = ticketDrawConsumeCount;
        }

        const drawResult = await h.executeDrawForUser(tx, {
          userId,
          drawCount,
          poolId: h.PERMANENT_POOL_ID,
          tokensCost: tokenCostForDraw,
          spendReason: tokenCostForDraw > 0 ? 'DRAW_SPEND' : 'DRAW_TICKET_SPEND',
          spendMetadata,
          prefetchedCards: drawSnapshot,
          wallet: walletForDraw ?? undefined
        });
        const ticketsForResponse = drawCount === 10
          ? await h.computeTicketBalance(tx, userId)
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
                  byRarity: h.RARITY_ORDER.map((rarity) => ({
                    rarity,
                    count: drawResult.rarityCounter[rarity] ?? 0
                  }))
                },
                wallet: h.serializeWallet(drawResult.wallet, drawResult.pityCounters)
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
      const payload = h.dismantleSchema.parse(req.body ?? {});
      const scope = h.buildIdempotencyScope(req, req.authUser.id);
      const outcome = await h.executeIdempotent(scope, async (tx) => {
        const wallet = await h.ensureWallet(tx, req.authUser!.id);
        const card = await tx.gachaCardDefinition.findUnique({ where: { id: payload.cardId } });
        if (!card) throw Object.assign(new Error('卡片不存在'), { status: 404 });
        const allFree = await h.findFreeInstances(tx, req.authUser!.id, card.id);
        if (allFree.length < payload.count) {
          throw Object.assign(new Error('拥有数量不足'), { status: 400 });
        }
        const requestedSignature = payload.affixSignature
          ? h.affixSignatureFromStyles(h.parseAffixSignature(payload.affixSignature))
          : null;
        const requestedStyle = payload.affixVisualStyle
          ? h.normalizeAffixVisualStyleInput(payload.affixVisualStyle)
          : null;
        let filtered = allFree;
        if (requestedSignature) {
          filtered = filtered.filter((inst) => inst.affixSignature === requestedSignature);
        }
        if (requestedStyle && requestedStyle !== 'NONE') {
          filtered = filtered.filter((inst) => {
            const fp = h.buildAffixFingerprintFromSignature(inst.affixSignature);
            return fp.affixStyles.includes(requestedStyle);
          });
        }
        filtered.sort((a, b) => h.variantEntrySortWeight(a.affixSignature) - h.variantEntrySortWeight(b.affixSignature));
        if (filtered.length < payload.count) {
          throw Object.assign(new Error('所选词条组合库存不足或已被放置占用'), { status: 400 });
        }
        const toDelete = filtered.slice(0, payload.count);
        const consumed: Array<{ affixVisualStyle: h.AffixVisualStyle; affixSignature: string; affixStyles: h.AffixVisualStyle[]; count: number }> = [];
        const consumeGroups = new Map<string, number>();
        for (const inst of toDelete) {
          consumeGroups.set(inst.affixSignature, (consumeGroups.get(inst.affixSignature) ?? 0) + 1);
        }
        for (const [signature, count] of consumeGroups) {
          const fp = h.buildAffixFingerprintFromSignature(signature);
          consumed.push({
            affixVisualStyle: fp.affixVisualStyle,
            affixSignature: fp.affixSignature,
            affixStyles: fp.affixStyles,
            count
          });
        }
        await h.deleteCardInstances(tx, toDelete.map((inst) => inst.id));
        const remaining = allFree.length - payload.count;

        const rewardDetail = h.computeDismantleRewardByAffix(card, consumed);
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

        await h.recordLedger(tx, wallet.id, req.authUser!.id, totalReward, 'DISMANTLE_REWARD', {
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
            wallet: await h.serializeWalletWithPity(tx, updatedWallet),
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
      const payload = h.dismantleBatchSchema.parse(req.body ?? {});
      const scope = h.buildIdempotencyScope(req, req.authUser.id);
      const outcome = await h.executeIdempotent(scope, async (tx) => {
        const userId = req.authUser!.id;
        const wallet = await h.ensureWallet(tx, userId);
        const maxRarityIndex = h.RARITY_ORDER.indexOf(payload.maxRarity);
        if (maxRarityIndex < 0) {
          throw Object.assign(new Error('稀有度参数无效'), { status: 400 });
        }
        const allowedRarities = h.RARITY_ORDER.slice(0, maxRarityIndex + 1);
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
              wallet: await h.serializeWalletWithPity(tx, wallet),
              summary: {
                maxRarity: payload.maxRarity,
                keepAtLeast: payload.keepAtLeast,
                keepScope: payload.keepScope,
                cardsAffected: 0,
                totalCount: 0,
                totalReward: 0,
                byRarity: h.RARITY_ORDER.map((rarity) => ({
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
          const toDelete = h.selectBatchDismantleInstances(freeInstances, payload.keepAtLeast, payload.keepScope);
          const dismantleCount = toDelete.length;
          if (dismantleCount <= 0) continue;
          const consumeGroups = new Map<string, number>();
          for (const inst of toDelete) {
            consumeGroups.set(inst.affixSignature, (consumeGroups.get(inst.affixSignature) ?? 0) + 1);
          }
          const consumed: Array<{ affixVisualStyle: h.AffixVisualStyle; affixSignature: string; affixStyles: h.AffixVisualStyle[]; count: number }> = [];
          for (const [signature, count] of consumeGroups) {
            const fp = h.buildAffixFingerprintFromSignature(signature);
            consumed.push({
              affixVisualStyle: fp.affixVisualStyle,
              affixSignature: fp.affixSignature,
              affixStyles: fp.affixStyles,
              count
            });
          }
          // eslint-disable-next-line no-await-in-loop
          await h.deleteCardInstances(tx, toDelete.map((inst) => inst.id));

          const rewardDetail = h.computeDismantleRewardByAffix(item.card, consumed);
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

          await h.recordLedger(tx, wallet.id, userId, totalReward, 'DISMANTLE_BATCH_REWARD', {
            maxRarity: payload.maxRarity,
            keepAtLeast: payload.keepAtLeast,
            keepScope: payload.keepScope,
            cardsAffected,
            totalCount,
            totalReward,
            byRarity: h.RARITY_ORDER.map((rarity) => ({
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
            wallet: await h.serializeWalletWithPity(tx, updatedWallet),
            summary: {
              maxRarity: payload.maxRarity,
              keepAtLeast: payload.keepAtLeast,
              keepScope: payload.keepScope,
              cardsAffected,
              totalCount,
              totalReward,
              byRarity: h.RARITY_ORDER.map((rarity) => ({
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

  router.post('/dismantle/batch/preview', async (req, res, next) => {
    try {
      if (!req.authUser) return res.status(401).json({ error: '未登录' });
      const payload = h.dismantleBatchSchema.parse(req.body ?? {});
      const userId = req.authUser.id;
      const maxRarityIndex = h.RARITY_ORDER.indexOf(payload.maxRarity);
      if (maxRarityIndex < 0) return res.status(400).json({ error: '稀有度参数无效' });

      const allowedRarities = h.RARITY_ORDER.slice(0, maxRarityIndex + 1);
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
            byRarity: h.RARITY_ORDER.map((rarity) => ({ rarity, count: 0, reward: 0 }))
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
        const toPreview = h.selectBatchDismantleInstances(freeInstances, payload.keepAtLeast, payload.keepScope);
        const dismantleCount = toPreview.length;
        if (dismantleCount <= 0) continue;
        const consumeGroups = new Map<string, number>();
        for (const inst of toPreview) {
          consumeGroups.set(inst.affixSignature, (consumeGroups.get(inst.affixSignature) ?? 0) + 1);
        }
        const consumed: Array<{ affixVisualStyle: h.AffixVisualStyle; affixSignature: string; affixStyles: h.AffixVisualStyle[]; count: number }> = [];
        for (const [signature, count] of consumeGroups) {
          const fp = h.buildAffixFingerprintFromSignature(signature);
          consumed.push({ affixVisualStyle: fp.affixVisualStyle, affixSignature: fp.affixSignature, affixStyles: fp.affixStyles, count });
        }
        const rewardDetail = h.computeDismantleRewardByAffix(item.card, consumed);
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
          byRarity: h.RARITY_ORDER.map((rarity) => ({ rarity, count: byRarityCount[rarity], reward: byRarityReward[rarity] }))
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
      const scope = h.buildIdempotencyScope(req, req.authUser.id);
      const outcome = await h.executeIdempotent(scope, async (tx) => {
        const userId = req.authUser!.id;
        const wallet = await h.ensureWallet(tx, userId);

        let cardsAffected = 0;
        let totalCount = 0;
        let totalReward = 0;
        const byRarityCount: Record<GachaRarity, number> = { WHITE: 0, GREEN: 0, BLUE: 0, PURPLE: 0, GOLD: 0 };
        const byRarityReward: Record<GachaRarity, number> = { WHITE: 0, GREEN: 0, BLUE: 0, PURPLE: 0, GOLD: 0 };

        for (const item of payload.items) {
          const normalizedSignature = item.affixSignature
            ? h.affixSignatureFromStyles(h.parseAffixSignature(item.affixSignature))
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
          const freeInstances = await h.findFreeInstances(tx, userId, item.cardId, {
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

          const consumed: Array<{ affixVisualStyle: h.AffixVisualStyle; affixSignature: string; affixStyles: h.AffixVisualStyle[]; count: number }> = [];
          for (const [signature, count] of consumeGroups) {
            const fp = h.buildAffixFingerprintFromSignature(signature);
            consumed.push({ affixVisualStyle: fp.affixVisualStyle, affixSignature: fp.affixSignature, affixStyles: fp.affixStyles, count });
          }

          // eslint-disable-next-line no-await-in-loop
          await h.deleteCardInstances(tx, toDelete.map((inst) => inst.id));

          const rewardDetail = h.computeDismantleRewardByAffix(card, consumed);
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
          await h.recordLedger(tx, wallet.id, userId, totalReward, 'DISMANTLE_BATCH_SELECTIVE_REWARD', {
            keepAtLeast: payload.keepAtLeast,
            cardsAffected,
            itemCount: payload.items.length,
            totalCount,
            totalReward,
            byRarity: h.RARITY_ORDER.map((rarity) => ({ rarity, count: byRarityCount[rarity], reward: byRarityReward[rarity] }))
          });
        }

        return {
          statusCode: 200,
          responseJson: {
            ok: true,
            wallet: await h.serializeWalletWithPity(tx, updatedWallet),
            summary: {
              keepAtLeast: payload.keepAtLeast,
              cardsAffected,
              totalCount,
              totalReward,
              byRarity: h.RARITY_ORDER.map((rarity) => ({ rarity, count: byRarityCount[rarity], reward: byRarityReward[rarity] }))
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
}
