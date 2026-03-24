import type { Router } from 'express';
import { Prisma, GachaRarity } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../db.js';
import * as h from './_helpers.js';

export function registerMarketRoutes(router: Router) {
  router.get('/market/contracts', async (req, res, next) => {
    try {
      const asOf = h.now();
      const timeframeRaw = (req.query as Record<string, unknown> | undefined)?.timeframe;
      const timeframe = h.normalizeMarketTimeframe(typeof timeframeRaw === 'string' ? timeframeRaw : undefined);
      const contextLimit = Math.max(h.ORACLE_TICK_LIMIT_SNAPSHOT, h.oracleLimitForTimeframe(asOf, timeframe));
      const context = await h.loadOracleContext(asOf, contextLimit);
      const orderedContracts = h.MARKET_CATEGORIES
        .map((category) => h.resolveMarketContract(category))
        .filter((contract): contract is h.MarketContractDefinition => Boolean(contract));
      res.json({
        ok: true,
        enabled: h.FEATURE_FLAGS.market,
        timeframe,
        items: orderedContracts.map((contract) => h.buildMarketContractSnapshot(contract, context, timeframe)),
        lockTiers: h.MARKET_LOCK_TIERS.map((lockTier) => {
          const tier = h.MARKET_LOCK_TIER_CONFIG[lockTier];
          return {
            lockTier,
            durationHours: Math.round(tier.durationMs / (60 * 60 * 1000)),
            minLots: tier.minLots,
            lotToken: h.MARKET_LOT_TOKEN,
            leverageOptions: tier.leverageOptions,
            openFeeBaseRate: tier.openFeeBaseRate,
            settleFeeRate: tier.settleFeeRate
          };
        }),
        ...h.featureStatusPayload()
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/market/ticks', async (req, res, next) => {
    try {
      const parsed = h.marketTicksQuerySchema.parse(req.query ?? {});
      const contract = h.resolveMarketContract(parsed.contractId || parsed.category || h.MARKET_CONTRACTS[0]!.id);
      if (!contract) {
        res.status(404).json({ error: '合约不存在' });
        return;
      }
      const asOf = h.now();
      const timeframe = h.normalizeMarketTimeframe(parsed.timeframe);
      const context = await h.loadOracleContextForCategories([contract.category], asOf, h.oracleLimitForTimeframe(asOf, timeframe));
      const rangeStart = h.timeframeRangeStart(asOf, timeframe);
      const defaultLimit = Math.max(24, h.timeframeHours(asOf, timeframe) + 2);
      const items = h.buildMarketTickSeries(contract, context, timeframe, parsed.limit ?? defaultLimit);
      const candles = h.buildMarketCandles(items, timeframe, asOf);
      const rangeStartTs = rangeStart.getTime();
      const entries = await h.listMarketLedgerEntries(prisma, req.authUser!.id, asOf);
      const openMap = new Map<string, h.MarketOpenPosition>();
      const settlementMap = new Map<string, h.MarketSettlementRecord>();
      for (const entry of entries) {
        if (entry.reason === h.MARKET_OPEN_REASON) {
          const parsedOpen = h.parseMarketOpenPosition(entry.metadata, entry.createdAt);
          if (!parsedOpen || parsedOpen.contractId !== contract.id) continue;
          openMap.set(parsedOpen.positionId, parsedOpen);
          continue;
        }
        if (entry.reason === h.MARKET_SETTLE_REASON) {
          const parsedSettlement = h.parseMarketSettlement(entry.metadata, entry.createdAt);
          if (!parsedSettlement || parsedSettlement.contractId !== contract.id) continue;
          settlementMap.set(parsedSettlement.positionId, parsedSettlement);
        }
      }
      const markers = [
        ...Array.from(openMap.values())
          .filter((position) => !settlementMap.has(position.positionId))
          .map((position) => ({
            ts: position.entryTickTs || position.openedAt,
            side: position.side,
            kind: 'OPEN' as const,
            price: Number(position.entryIndex ?? position.entryPrice ?? 0),
            positionId: position.positionId
          })),
        ...Array.from(settlementMap.values()).flatMap((position) => {
          const historyMarkers: Array<{
            ts: string;
            side: h.MarketPositionSide;
            kind: 'SETTLE' | 'EXPIRE';
            price: number;
            positionId: string;
          }> = [
            {
              ts: position.settledAt,
              side: position.side,
              kind: 'SETTLE' as const,
              price: Number(position.settleIndex ?? position.exitPrice ?? 0),
              positionId: position.positionId
            }
          ];
          if (position.status !== 'LIQUIDATED') {
            historyMarkers.push({
              ts: position.expireAt,
              side: position.side,
              kind: 'EXPIRE' as const,
              price: Number(position.settleIndex ?? position.exitPrice ?? 0),
              positionId: position.positionId
            });
          }
          return historyMarkers;
        })
      ]
        .filter((item) => {
          const ts = new Date(item.ts).getTime();
          if (!Number.isFinite(ts)) return false;
          if (ts < rangeStartTs || ts > asOf.getTime()) return false;
          return true;
        })
        .map((item) => ({
          ts: new Date(item.ts).toISOString(),
          side: item.side,
          kind: item.kind,
          price: Number(item.price || 0),
          positionId: item.positionId
        }))
        .sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
      const latestTick = items.length > 0 ? items[items.length - 1]! : null;
      const latestTickAsOfTs = latestTick?.asOfTs ? new Date(latestTick.asOfTs) : null;
      const latestWatermarkTs = latestTick?.watermarkTs ? new Date(latestTick.watermarkTs) : null;
      const tickLagMs = latestTickAsOfTs && Number.isFinite(latestTickAsOfTs.getTime())
        ? Math.max(0, asOf.getTime() - latestTickAsOfTs.getTime())
        : null;
      const watermarkLagMs = latestWatermarkTs && Number.isFinite(latestWatermarkTs.getTime())
        ? Math.max(0, asOf.getTime() - latestWatermarkTs.getTime())
        : null;
      const staleLevel = (tickLagMs != null && tickLagMs >= 3 * 60 * 60 * 1000)
        || (watermarkLagMs != null && watermarkLagMs >= 4 * 60 * 60 * 1000)
        ? 'stale'
        : (tickLagMs != null && tickLagMs >= 90 * 60 * 1000)
          || (watermarkLagMs != null && watermarkLagMs >= 2 * 60 * 60 * 1000)
          ? 'lagging'
          : 'ok';
      res.json({
        ok: true,
        enabled: h.FEATURE_FLAGS.market,
        timeframe,
        contract: h.buildMarketContractSnapshot(contract, context, timeframe),
        items,
        candles,
        markers,
        diagnostics: {
          asOfTs: asOf.toISOString(),
          latestTickAsOfTs: latestTickAsOfTs ? latestTickAsOfTs.toISOString() : null,
          latestWatermarkTs: latestWatermarkTs ? latestWatermarkTs.toISOString() : null,
          latestVoteCutoffDate: latestTick?.voteCutoffDate ?? null,
          tickLagMs,
          watermarkLagMs,
          staleLevel
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

  router.get('/market/opponents', async (req, res, next) => {
    try {
      const parsed = h.marketOpponentsQuerySchema.parse(req.query ?? {});
      const asOf = h.now();
      const contract = h.resolveMarketContract(parsed.contractId || parsed.category || h.MARKET_CONTRACTS[0]!.id);
      if (!contract) {
        res.status(404).json({ error: '合约不存在' });
        return;
      }
      const context = await h.loadOracleContextForCategories([contract.category], asOf, h.ORACLE_TICK_LIMIT_SNAPSHOT);
      const lockTier = parsed.lockTier ? h.resolveMarketLockTier(parsed.lockTier) : null;

      const activePositions = await h.loadGlobalMarketOpenPositions(prisma, asOf);
      const scopedPositions = activePositions.filter((position) => {
        if (position.contractId !== contract.id && position.category !== contract.category) return false;
        if (lockTier && position.lockTier !== lockTier) return false;
        return true;
      });
      const longPositions = scopedPositions.filter((item) => item.side === 'LONG');
      const shortPositions = scopedPositions.filter((item) => item.side === 'SHORT');
      const longUsers = new Set(longPositions.map((item) => item.userId)).size;
      const shortUsers = new Set(shortPositions.map((item) => item.userId)).size;
      const longLots = longPositions.reduce((sum, item) => sum + item.lots, 0);
      const shortLots = shortPositions.reduce((sum, item) => sum + item.lots, 0);
      const longMargin = longPositions.reduce((sum, item) => sum + item.margin, 0);
      const shortMargin = shortPositions.reduce((sum, item) => sum + item.margin, 0);
      const participantMap = h.groupMarketParticipants(scopedPositions);
      const userIds = Array.from(participantMap.keys());
      const participantUsers = userIds.length > 0
        ? await prisma.userAccount.findMany({
            where: { id: { in: userIds } },
            select: {
              id: true,
              displayName: true,
              linkedWikidotId: true
            }
          })
        : [];
      const participantUserMap = new Map(participantUsers.map((item: {
        id: string;
        displayName: string | null;
        linkedWikidotId: number | null;
      }) => [item.id, item]));
      const leaderboard = h.sortMarketParticipants(Array.from(participantMap.values()))
        .slice(0, 8)
        .map((entry, index) => {
          const user = participantUserMap.get(entry.userId);
          const totalMargin = h.positionTotalMargin(entry);
          const netMargin = h.positionNetMargin(entry);
          return {
            rank: index + 1,
            userId: entry.userId,
            displayName: h.toDisplayName(user?.displayName ?? null, entry.userId),
            linkedWikidotId: user?.linkedWikidotId ?? null,
            balance: totalMargin,
            totalMargin,
            netMargin,
            longLots: entry.longLots,
            shortLots: entry.shortLots,
            longMargin: entry.longMargin,
            shortMargin: entry.shortMargin
          };
        });
      const primary = h.buildMarketContractSnapshot(contract, context);
      res.json({
        ok: true,
        enabled: h.FEATURE_FLAGS.market,
        snapshot: {
          asOfTs: asOf.toISOString(),
          updatedAt: asOf.toISOString(),
          category: contract.category,
          contractId: contract.id,
          lockTier,
          mood: longMargin === shortMargin ? 'neutral' : longMargin > shortMargin ? 'bullish' : 'bearish',
          benchmark: primary,
          longUsers,
          shortUsers,
          longLots,
          shortLots,
          longMargin,
          shortMargin,
          leaderboard
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

  router.post('/market/positions/open', async (req, res, next) => {
    try {
      if (!req.authUser) return res.status(401).json({ error: '未登录' });
      const payload = h.marketPositionOpenSchema.parse(req.body ?? {});
      const contract = h.resolveMarketContract(payload.contractId);
      if (!contract) {
        res.status(404).json({ error: '合约不存在' });
        return;
      }
      const asOf = h.now();
      const oracleContext = await h.loadOracleContext(asOf, h.ORACLE_TICK_LIMIT_POSITION);
      const scope = h.buildIdempotencyScope(req, req.authUser.id);
      const outcome = await h.executeIdempotent(scope, async (tx) => {
        const userId = req.authUser!.id;
        const lockTier = h.resolveMarketLockTier(payload.lockTier);
        const tier = h.MARKET_LOCK_TIER_CONFIG[lockTier];
        const leverage = payload.leverage;
        if (!tier.leverageOptions.includes(leverage)) {
          throw Object.assign(new Error(`锁仓档位 ${lockTier} 不支持 ${leverage}x 杠杆`), { status: 400 });
        }
        if (payload.stake != null && payload.lots == null && payload.stake % h.MARKET_LOT_TOKEN !== 0) {
          throw Object.assign(new Error(`stake 必须是 ${h.MARKET_LOT_TOKEN} 的倍数`), { status: 400 });
        }
        const lots = payload.lots != null
          ? payload.lots
          : Math.floor((payload.stake ?? 0) / h.MARKET_LOT_TOKEN);
        if (lots < tier.minLots) {
          throw Object.assign(new Error(`${lockTier} 最低手数为 ${tier.minLots}`), { status: 400 });
        }
        const margin = h.marketMarginByLots(lots);
        const { openFeeRate, openFee } = h.marketOpenFee(lockTier, leverage, margin);
        const totalCost = margin + openFee;

        let wallet = await h.ensureWallet(tx, userId);
        const settled = await h.settleDueMarketPositions(tx, userId, wallet, oracleContext, asOf);
        wallet = settled.wallet;
        const state = settled.state;
        if (state.active.length >= h.MARKET_POSITION_MAX_OPEN) {
          throw Object.assign(new Error(`最多同时持有 ${h.MARKET_POSITION_MAX_OPEN} 个仓位`), { status: 400 });
        }
        if (wallet.balance < totalCost) {
          throw Object.assign(new Error('Token 余额不足，无法开仓'), { status: 400 });
        }
        const positionId = h.createRuntimeId('mpos');
        const entryTick = h.marketTickAt(contract, asOf, oracleContext);
        if (!entryTick) {
          throw Object.assign(new Error('当前合约暂无可用 Oracle tick，请稍后再试'), { status: 503 });
        }
        const entryIndex = Number(entryTick.indexMark);
        const entryTickTs = entryTick.asOfTs.toISOString();
        const expireAt = new Date(asOf.getTime() + tier.durationMs).toISOString();
        wallet = await h.applyWalletDelta(tx, wallet, -totalCost, h.MARKET_OPEN_SPEND_REASON, {
          positionId,
          contractId: contract.id,
          side: payload.side,
          lockTier,
          lots,
          margin,
          stake: margin,
          openFee,
          openFeeRate,
          leverage,
          entryIndex,
          entryPrice: entryIndex,
          entryTickTs,
          expireAt,
          openedAt: asOf.toISOString(),
          spendToken: totalCost
        });
        await h.recordLedger(tx, wallet.id, userId, 0, h.MARKET_OPEN_REASON, {
          positionId,
          contractId: contract.id,
          side: payload.side,
          lockTier,
          lots,
          margin,
          stake: margin,
          openFee,
          openFeeRate,
          leverage,
          entryIndex,
          entryPrice: entryIndex,
          entryTickTs,
          expireAt,
          openedAt: asOf.toISOString()
        });
        h.invalidateGlobalMarketPositionCache();
        return {
          statusCode: 200,
          responseJson: {
            ok: true,
            enabled: h.FEATURE_FLAGS.market,
            wallet: await h.serializeWalletWithPity(tx, wallet),
            position: {
              positionId,
              contractId: contract.id,
              side: payload.side,
              status: 'OPEN' as const,
              lockTier,
              lots,
              margin,
              stake: margin,
              openFee,
              leverage,
              entryIndex,
              entryPrice: entryIndex,
              entryTickTs,
              expireAt,
              openedAt: asOf.toISOString()
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
      if (error?.status === 503) {
        res.status(503).json({ error: error.message });
        return;
      }
      if (error?.status === 409 || error?.code === 'IDEMPOTENCY_KEY_CONFLICT') {
        res.status(409).json({ error: 'idempotency_key_conflict' });
        return;
      }
      next(error);
    }
  });

  router.get('/market/positions', async (req, res, next) => {
    try {
      if (!req.authUser) return res.status(401).json({ error: '未登录' });
      const asOf = h.now();
      const oracleContext = await h.loadOracleContext(asOf, h.ORACLE_TICK_LIMIT_POSITION);
      const result = await h.runSerializableTransaction(async (tx) => {
        const userId = req.authUser!.id;
        let wallet = await h.ensureWallet(tx, userId);
        const settled = await h.settleDueMarketPositions(tx, userId, wallet, oracleContext, asOf);
        wallet = settled.wallet;
        const state = settled.state;
        return { wallet: await h.serializeWalletWithPity(tx, wallet), state, settled: settled.settlements };
      });
      res.json({
        ok: true,
        enabled: h.FEATURE_FLAGS.market,
        items: result.state.active,
        autoSettled: result.settled,
        wallet: result.wallet,
        ...h.featureStatusPayload()
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/market/positions/history', async (req, res, next) => {
    try {
      if (!req.authUser) return res.status(401).json({ error: '未登录' });
      const parsed = h.marketHistoryQuerySchema.parse(req.query ?? {});
      const limit = parsed.limit ?? 30;
      const asOf = h.now();
      const oracleContext = await h.loadOracleContext(asOf, h.ORACLE_TICK_LIMIT_POSITION);
      const result = await h.runSerializableTransaction(async (tx) => {
        const userId = req.authUser!.id;
        const wallet = await h.ensureWallet(tx, userId);
        const settled = await h.settleDueMarketPositions(tx, userId, wallet, oracleContext, asOf);
        return settled.state.history.slice(0, limit);
      });
      res.json({
        ok: true,
        enabled: h.FEATURE_FLAGS.market,
        items: result,
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

  router.get('/market/settlements', async (req, res, next) => {
    try {
      if (!req.authUser) return res.status(401).json({ error: '未登录' });
      const parsed = h.marketHistoryQuerySchema.parse(req.query ?? {});
      const limit = parsed.limit ?? 20;
      const asOf = h.now();
      const oracleContext = await h.loadOracleContext(asOf, h.ORACLE_TICK_LIMIT_POSITION);
      const result = await h.runSerializableTransaction(async (tx) => {
        const userId = req.authUser!.id;
        const wallet = await h.ensureWallet(tx, userId);
        const settled = await h.settleDueMarketPositions(tx, userId, wallet, oracleContext, asOf);
        const state = settled.state;
        const history = state.history.slice(0, limit);
        const pnlTotal = history.reduce((sum, item) => sum + item.pnl, 0);
        return {
          autoSettled: settled.settlements,
          history,
          summary: {
            total: history.length,
            pnl: pnlTotal
          }
        };
      });
      res.json({
        ok: true,
        enabled: h.FEATURE_FLAGS.market,
        items: result.history,
        autoSettled: result.autoSettled,
        summary: result.summary,
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

  // Lightweight endpoint: return only cardIds the user owns (count > 0)
}
