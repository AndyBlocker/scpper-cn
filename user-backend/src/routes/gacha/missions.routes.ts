import type { Router } from 'express';
import { Prisma, GachaRarity } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../db.js';
import * as h from './_helpers.js';

export function registerMissionsRoutes(router: Router) {
  router.get('/missions', async (req, res, next) => {
    try {
      if (!req.authUser) return res.status(401).json({ error: '未登录' });
      const items = await prisma.$transaction(async (tx) => {
        const snapshots = await h.loadMissionProgressSnapshots(tx, req.authUser!.id, h.now());
        const claimedMap = await h.loadMissionClaimedAtMap(tx, req.authUser!.id);
        return h.buildMissionItems(snapshots, claimedMap);
      });
      res.json({
        ok: true,
        enabled: h.FEATURE_FLAGS.missions,
        items,
        ...h.featureStatusPayload()
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/missions/:missionKey/claim', async (req, res, next) => {
    try {
      if (!req.authUser) return res.status(401).json({ error: '未登录' });
      const { missionKey } = h.missionClaimParamSchema.parse(req.params ?? {});
      const result = await h.runSerializableTransaction(async (tx) => {
        const userId = req.authUser!.id;
        const asOf = h.now();
        let wallet = await h.ensureWallet(tx, userId);
        const snapshots = await h.loadMissionProgressSnapshots(tx, userId, asOf);
        const claimedMap = await h.loadMissionClaimedAtMap(tx, userId);
        const mission = h.buildMissionItems(snapshots, claimedMap).find((item) => item.missionKey === missionKey);
        if (!mission) {
          throw Object.assign(new Error('任务不存在'), { status: 404 });
        }
        if (mission.claimed) {
          throw Object.assign(new Error('该任务奖励已领取'), { status: 400 });
        }
        if (!mission.claimable) {
          throw Object.assign(new Error('任务尚未达成'), { status: 400 });
        }
        const rewardResult = await h.applyRewardPack(tx, wallet, userId, mission.reward, h.MISSION_CLAIM_REASON, mission.missionKey);
        wallet = rewardResult.wallet;
        await h.recordLedger(tx, wallet.id, userId, 0, h.MISSION_CLAIM_REASON, {
          missionKey: mission.missionKey,
          periodType: mission.periodType,
          periodKey: mission.periodKey,
          spendToken: mission.progress,
          reward: rewardResult.reward
        });
        const tickets = await h.computeTicketBalance(tx, userId);
        return {
          mission: {
            ...mission,
            claimed: true,
            claimable: false,
            claimedAt: asOf.toISOString()
          },
          wallet: await h.serializeWalletWithPity(tx, wallet),
          tickets
        };
      });
      res.json({
        ok: true,
        enabled: h.FEATURE_FLAGS.missions,
        mission: result.mission,
        wallet: result.wallet,
        tickets: result.tickets,
        ...h.featureStatusPayload()
      });
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

  router.post('/missions/claim-all', async (req, res, next) => {
    try {
      if (!req.authUser) return res.status(401).json({ error: '未登录' });
      const result = await h.runSerializableTransaction(async (tx) => {
        const userId = req.authUser!.id;
        const asOf = h.now();
        let wallet = await h.ensureWallet(tx, userId);
        const snapshots = await h.loadMissionProgressSnapshots(tx, userId, asOf);
        const claimedMap = await h.loadMissionClaimedAtMap(tx, userId);
        const missionItems = h.buildMissionItems(snapshots, claimedMap);
        const claimable = missionItems.filter((item) => item.claimable && !item.claimed);
        const claimedItems: Array<{ missionKey: string; periodKey: string; claimedAt: string }> = [];
        for (const mission of claimable) {
          // eslint-disable-next-line no-await-in-loop
          const rewardResult = await h.applyRewardPack(tx, wallet, userId, mission.reward, h.MISSION_CLAIM_REASON, mission.missionKey);
          wallet = rewardResult.wallet;
          // eslint-disable-next-line no-await-in-loop
          await h.recordLedger(tx, wallet.id, userId, 0, h.MISSION_CLAIM_REASON, {
            missionKey: mission.missionKey,
            periodType: mission.periodType,
            periodKey: mission.periodKey,
            spendToken: mission.progress,
            reward: rewardResult.reward
          });
          claimedItems.push({
            missionKey: mission.missionKey,
            periodKey: mission.periodKey,
            claimedAt: asOf.toISOString()
          });
        }
        const tickets = await h.computeTicketBalance(tx, userId);
        return { claimedItems, wallet: await h.serializeWalletWithPity(tx, wallet), tickets };
      });
      res.json({
        ok: true,
        enabled: h.FEATURE_FLAGS.missions,
        claimed: result.claimedItems.length,
        items: result.claimedItems,
        wallet: result.wallet,
        tickets: result.tickets,
        ...h.featureStatusPayload()
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/achievements', async (req, res, next) => {
    try {
      if (!req.authUser) return res.status(401).json({ error: '未登录' });
      const items = await prisma.$transaction(async (tx) => {
        const stats = await h.loadUserGachaStats(tx, req.authUser!.id);
        const claimedMap = await h.loadClaimedAtMap(tx, req.authUser!.id, h.ACHIEVEMENT_CLAIM_REASON, 'achievementKey');
        return h.buildAchievementItems(stats, claimedMap);
      });
      res.json({
        ok: true,
        enabled: h.FEATURE_FLAGS.achievements,
        items,
        ...h.featureStatusPayload()
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/achievements/:achievementKey/claim', async (req, res, next) => {
    try {
      if (!req.authUser) return res.status(401).json({ error: '未登录' });
      const { achievementKey } = h.achievementClaimParamSchema.parse(req.params ?? {});
      const result = await h.runSerializableTransaction(async (tx) => {
        const userId = req.authUser!.id;
        let wallet = await h.ensureWallet(tx, userId);
        const stats = await h.loadUserGachaStats(tx, userId);
        const claimedMap = await h.loadClaimedAtMap(tx, userId, h.ACHIEVEMENT_CLAIM_REASON, 'achievementKey');
        const achievement = h.buildAchievementItems(stats, claimedMap)
          .find((item) => item.achievementKey === achievementKey);
        if (!achievement) {
          throw Object.assign(new Error('成就不存在'), { status: 404 });
        }
        if (achievement.claimed) {
          throw Object.assign(new Error('该成就奖励已领取'), { status: 400 });
        }
        if (!achievement.claimable) {
          throw Object.assign(new Error('成就尚未达成'), { status: 400 });
        }
        const rewardResult = await h.applyRewardPack(tx, wallet, userId, achievement.reward, h.ACHIEVEMENT_CLAIM_REASON, achievement.achievementKey);
        wallet = rewardResult.wallet;
        await h.recordLedger(tx, wallet.id, userId, 0, h.ACHIEVEMENT_CLAIM_REASON, {
          achievementKey: achievement.achievementKey,
          reward: rewardResult.reward
        });
        const tickets = await h.computeTicketBalance(tx, userId);
        return {
          achievement: {
            ...achievement,
            claimed: true,
            claimable: false,
            claimedAt: h.now().toISOString()
          },
          wallet: await h.serializeWalletWithPity(tx, wallet),
          tickets
        };
      });
      res.json({
        ok: true,
        enabled: h.FEATURE_FLAGS.achievements,
        achievement: result.achievement,
        wallet: result.wallet,
        tickets: result.tickets,
        ...h.featureStatusPayload()
      });
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

  router.post('/achievements/claim-all', async (req, res, next) => {
    try {
      if (!req.authUser) return res.status(401).json({ error: '未登录' });
      const result = await h.runSerializableTransaction(async (tx) => {
        const userId = req.authUser!.id;
        let wallet = await h.ensureWallet(tx, userId);
        const stats = await h.loadUserGachaStats(tx, userId);
        const claimedMap = await h.loadClaimedAtMap(tx, userId, h.ACHIEVEMENT_CLAIM_REASON, 'achievementKey');
        const achievementItems = h.buildAchievementItems(stats, claimedMap);
        const claimable = achievementItems.filter((item) => item.claimable && !item.claimed);
        const claimedItems: Array<{ achievementKey: string; claimedAt: string }> = [];
        for (const achievement of claimable) {
          // eslint-disable-next-line no-await-in-loop
          const rewardResult = await h.applyRewardPack(tx, wallet, userId, achievement.reward, h.ACHIEVEMENT_CLAIM_REASON, achievement.achievementKey);
          wallet = rewardResult.wallet;
          // eslint-disable-next-line no-await-in-loop
          await h.recordLedger(tx, wallet.id, userId, 0, h.ACHIEVEMENT_CLAIM_REASON, {
            achievementKey: achievement.achievementKey,
            reward: rewardResult.reward
          });
          claimedItems.push({
            achievementKey: achievement.achievementKey,
            claimedAt: h.now().toISOString()
          });
        }
        const tickets = await h.computeTicketBalance(tx, userId);
        return { claimedItems, wallet: await h.serializeWalletWithPity(tx, wallet), tickets };
      });
      res.json({
        ok: true,
        enabled: h.FEATURE_FLAGS.achievements,
        claimed: result.claimedItems.length,
        items: result.claimedItems,
        wallet: result.wallet,
        tickets: result.tickets,
        ...h.featureStatusPayload()
      });
    } catch (error) {
      next(error);
    }
  });
}
