import type { Router } from 'express';
import { Prisma, GachaRarity } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../db.js';
import * as h from './_helpers.js';
import { planBatchSelectiveDismantle } from './_dismantlePlanner.js';

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
        // Accumulated so we can write all dismantle logs in one createMany at
        // the end of the loop. `deleteCardInstances` still runs per iteration
        // because each card has a different set of instance ids.
        const dismantleLogsToCreate: Array<{
          userId: string;
          cardId: string;
          count: number;
          tokensEarned: number;
        }> = [];

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

          dismantleLogsToCreate.push({
            userId,
            cardId: item.cardId,
            count: dismantleCount,
            tokensEarned: reward
          });
        }

        if (dismantleLogsToCreate.length > 0) {
          await tx.gachaDismantleLog.createMany({ data: dismantleLogsToCreate });
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

        // ── #96 集合化：原实现对 ≤500 个 item 在单个长事务里逐个串行查询/删除(~4000 次往返、
        // 持锁数十秒、串行化冲突重试风暴)。改为单次批量读取快照 → 纯函数规划器复刻旧 per-item
        // 顺序语义(planBatchSelectiveDismantle，由 scripts/verify-dismantle-planner.ts golden 验证
        // 与旧循环逐项等价) → 一次性 deleteMany/createMany/count 同步/钱包结算。仍是单原子事务，
        // 外部"全成或全不成"契约与幂等不变；事务大幅变短，冲突窗口骤降。
        const planItems = payload.items.map((item) => ({
          cardId: item.cardId,
          affixSignature: item.affixSignature
            ? h.affixSignatureFromStyles(h.parseAffixSignature(item.affixSignature))
            : undefined,
          count: item.count
        }));
        const cardIds = [...new Set(planItems.map((it) => it.cardId))];

        // 快照：一次性批量读取（替代每 item 的 2×count + findFreeInstances + findUnique）。
        const [cardDefs, totalGroups, lockedGroups, freeInstances] = await Promise.all([
          tx.gachaCardDefinition.findMany({ where: { id: { in: cardIds } } }),
          // 留存护栏分母：排除交易/求购，但包含锁定/放置/展示。
          tx.gachaCardInstance.groupBy({
            by: ['cardId', 'affixSignature'],
            where: { userId, cardId: { in: cardIds }, tradeListingId: null, buyRequestId: null },
            _count: { _all: true }
          }),
          tx.gachaCardInstance.groupBy({
            by: ['cardId', 'affixSignature'],
            where: { userId, cardId: { in: cardIds }, tradeListingId: null, buyRequestId: null, isLocked: true },
            _count: { _all: true }
          }),
          // 自由实例池（完整白名单），按 obtainedAt 升序；加 id 次级排序消除 obtainedAt 并列
          // （如十连同一时刻获得）的歧义，使批量选择【确定性】，并保证一次全池查询与逐 item
          // 查询的并列解析一致。
          tx.gachaCardInstance.findMany({
            where: {
              userId, cardId: { in: cardIds },
              tradeListingId: null, buyRequestId: null,
              placementSlot: { is: null }, showcaseSlot: { is: null }, isLocked: false
            },
            select: { id: true, cardId: true, affixSignature: true },
            orderBy: [{ obtainedAt: 'asc' }, { id: 'asc' }]
          })
        ]);

        const cardById = new Map(cardDefs.map((c) => [c.id, c]));
        const cardExists = new Set(cardById.keys());

        const totalByCard = new Map<string, number>();
        const totalByCardSig = new Map<string, Map<string, number>>();
        const lockedByCard = new Map<string, number>();
        const lockedByCardSig = new Map<string, Map<string, number>>();
        const accumulate = (
          flat: Map<string, number>,
          nested: Map<string, Map<string, number>>,
          groups: Array<{ cardId: string; affixSignature: string; _count: { _all: number } }>
        ) => {
          for (const g of groups) {
            const cnt = g._count._all;
            flat.set(g.cardId, (flat.get(g.cardId) ?? 0) + cnt);
            let inner = nested.get(g.cardId);
            if (!inner) { inner = new Map(); nested.set(g.cardId, inner); }
            inner.set(g.affixSignature, (inner.get(g.affixSignature) ?? 0) + cnt);
          }
        };
        accumulate(totalByCard, totalByCardSig, totalGroups);
        accumulate(lockedByCard, lockedByCardSig, lockedGroups);

        const freeByCard = new Map<string, Array<{ id: string; cardId: string; affixSignature: string }>>();
        for (const inst of freeInstances) {
          let list = freeByCard.get(inst.cardId);
          if (!list) { list = []; freeByCard.set(inst.cardId, list); }
          list.push(inst);
        }

        // 纯规划：复刻旧 per-item 顺序语义（按已删后的状态续算，含重复 item/混合 affix）。
        const plan = planBatchSelectiveDismantle(planItems, payload.keepAtLeast, {
          totalByCard, totalByCardSig, lockedByCard, lockedByCardSig, freeByCard, cardExists
        });

        const logRows: Prisma.GachaDismantleLogCreateManyInput[] = [];
        for (const it of plan.perItem) {
          const card = cardById.get(it.cardId);
          if (!card) continue; // planner 已按 cardExists 过滤，此处仅防御
          const consumed: Array<{ affixVisualStyle: h.AffixVisualStyle; affixSignature: string; affixStyles: h.AffixVisualStyle[]; count: number }> = [];
          for (const [signature, count] of it.consumeGroups) {
            const fp = h.buildAffixFingerprintFromSignature(signature);
            consumed.push({ affixVisualStyle: fp.affixVisualStyle, affixSignature: fp.affixSignature, affixStyles: fp.affixStyles, count });
          }
          const rewardDetail = h.computeDismantleRewardByAffix(card, consumed);
          cardsAffected += 1;
          totalCount += it.dismantleCount;
          totalReward += rewardDetail.totalReward;
          byRarityCount[card.rarity] += it.dismantleCount;
          byRarityReward[card.rarity] += rewardDetail.totalReward;
          logRows.push({ userId, cardId: it.cardId, count: it.dismantleCount, tokensEarned: rewardDetail.totalReward });
        }

        // 批量写入：一次 deleteMany（再次套白名单兜底并发）+ createMany 日志 + 库存 count 同步。
        if (plan.selectedIds.length > 0) {
          const deleted = await tx.gachaCardInstance.deleteMany({
            where: {
              id: { in: plan.selectedIds },
              userId,
              tradeListingId: null, buyRequestId: null,
              placementSlot: { is: null }, showcaseSlot: { is: null }, isLocked: false
            }
          });
          // 同一 Serializable 事务内快照一致，此断言理论上恒真；万一不等（并发把实例改为
          // 已锁/已放置/上架等），抛出使整事务【回滚】——请求以错误失败、无任何部分副作用
          // （非自动重试：普通 Error 不被 runSerializableTransaction 当 DB 序列化错误重试，
          // 客户端可凭同一幂等键安全重试）。
          if (deleted.count !== plan.selectedIds.length) {
            throw new Error(`dismantle_selection_changed: expected ${plan.selectedIds.length}, deleted ${deleted.count}`);
          }
          if (logRows.length > 0) {
            await tx.gachaDismantleLog.createMany({ data: logRows });
          }
          // 受影响卡牌库存 count 按删除后真实实例数重算（自愈式，含归零）。
          // 注意 count 口径：排除已上架交易/求购抵押的实例（与 draw +1 / 上架·求购 -1 的维护
          // 口径、以及库存聚合的 tradeListingId/buyRequestId IS NULL 一致），否则会把在售/抵押中
          // 的实例错误加回库存。手动 updatedAt=NOW() 以匹配 @updatedAt（raw SQL 不触发 Prisma）。
          const affectedCardIds = [...plan.deletedCountByCard.keys()];
          await tx.$executeRaw(Prisma.sql`
            UPDATE "GachaInventory" gi
            SET count = (
              SELECT COUNT(*)::int FROM "GachaCardInstance" ci
              WHERE ci."userId" = gi."userId" AND ci."cardId" = gi."cardId"
                AND ci."tradeListingId" IS NULL AND ci."buyRequestId" IS NULL
            ),
            "updatedAt" = NOW()
            WHERE gi."userId" = ${userId} AND gi."cardId" IN (${Prisma.join(affectedCardIds)})
          `);
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
