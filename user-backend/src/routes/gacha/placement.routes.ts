import type { Router } from 'express';
import { GachaRarity, GachaAffixVisualStyle as PrismaAffixVisualStyle } from '@prisma/client';
import { z } from 'zod';
import * as h from './_helpers.js';

export function registerPlacementRoutes(router: Router) {
  router.get('/placement', async (req, res, next) => {
    try {
      if (!req.authUser) return res.status(401).json({ error: '未登录' });
      const placement = await h.runSerializableTransaction(async (tx) => {
        const userId = req.authUser!.id;
        const asOf = h.now();
        const ensured = await h.ensurePlacementStateAndSlots(tx, userId);
        const state = await h.accruePlacementPending(tx, {
          userId,
          state: ensured.state,
          slots: ensured.slots,
          addons: ensured.addons,
          asOf
        });
        return h.serializePlacement(userId, state, ensured.slots, ensured.addons);
      });
      res.json({ ok: true, placement });
    } catch (error) {
      next(error);
    }
  });

  router.post('/placement/slots/:slotIndex/set', async (req, res, next) => {
    try {
      if (!req.authUser) return res.status(401).json({ error: '未登录' });
      const params = h.placementSlotParamSchema.parse(req.params ?? {});
      const payload = h.placementSetSchema.parse(req.body ?? {});
      const placement = await h.runSerializableTransaction(async (tx) => {
        const userId = req.authUser!.id;
        const asOf = h.now();
        const ensured = await h.ensurePlacementStateAndSlots(tx, userId);
        const accruedState = await h.accruePlacementPending(tx, {
          userId,
          state: ensured.state,
          slots: ensured.slots,
          addons: ensured.addons,
          asOf
        });
        const unlockedSlotCount = h.normalizedPlacementUnlockedSlotCount(accruedState);
        if (params.slotIndex > unlockedSlotCount) {
          throw Object.assign(new Error('该槽位尚未解锁'), { status: 400 });
        }
        const targetSlot = ensured.slots.find((slot) => slot.slotIndex === params.slotIndex);
        if (!targetSlot) {
          throw Object.assign(new Error('槽位不存在'), { status: 404 });
        }
        const inventory = await tx.gachaInventory.findUnique({
          where: {
            userId_cardId: {
              userId,
              cardId: payload.cardId
            }
          },
          include: { card: true }
        });
        if (!inventory || inventory.count <= 0 || !inventory.card) {
          throw Object.assign(new Error('你还没有这张卡片，无法放置'), { status: 400 });
        }
        const requestedSignature = payload.affixSignature
          ? h.affixSignatureFromStyles(h.parseAffixSignature(payload.affixSignature))
          : null;
        const requestedStyle = payload.affixVisualStyle
          ? h.normalizeAffixVisualStyleInput(payload.affixVisualStyle)
          : null;
        let freeInstances = await h.findFreeInstances(tx, userId, payload.cardId, {
          affixSignature: requestedSignature ?? undefined,
          includeLocked: true,
          includeShowcased: true
        });
        if (requestedStyle && requestedStyle !== 'NONE' && !requestedSignature) {
          freeInstances = freeInstances.filter((inst) => {
            const fp = h.buildAffixFingerprintFromSignature(inst.affixSignature);
            return fp.affixStyles.includes(requestedStyle);
          });
        }
        if (freeInstances.length === 0) {
          throw Object.assign(new Error('该卡对应词条实例库存不足，无法放置'), { status: 400 });
        }
        const selectedInstance = freeInstances[0];
        const selectedFingerprint = h.buildAffixFingerprintFromSignature(selectedInstance.affixSignature);
        const selectedSignature = selectedFingerprint.affixSignature;
        const selectedStyle = selectedFingerprint.affixVisualStyle;
        const selectedLabel = selectedFingerprint.affixLabel;
        const currentSignature = h.affixSignatureFromStyles(h.parseAffixSignature(targetSlot.affixSignature || targetSlot.affixVisualStyle || 'NONE'));
        if (
          targetSlot.cardId !== payload.cardId
          || currentSignature !== selectedSignature
          || h.normalizeAffixVisualStyleInput(targetSlot.affixVisualStyle) !== selectedStyle
          || String(targetSlot.affixLabel || '') !== selectedLabel
        ) {
          await tx.gachaPlacementSlot.update({
            where: { id: targetSlot.id },
            data: {
              cardId: payload.cardId,
              inventoryId: inventory.id,
              instanceId: selectedInstance.id,
              affixSignature: selectedSignature,
              affixVisualStyle: selectedStyle as PrismaAffixVisualStyle,
              affixLabel: selectedLabel,
              assignedAt: asOf
            }
          });
        }
        const slots = (
          targetSlot.cardId === payload.cardId
          && currentSignature === selectedSignature
          && h.normalizeAffixVisualStyleInput(targetSlot.affixVisualStyle) === selectedStyle
          && String(targetSlot.affixLabel || '') === selectedLabel
        )
          ? ensured.slots
          : await h.listPlacementSlots(tx, userId);
        return h.serializePlacement(userId, accruedState, slots, ensured.addons);
      });
      res.json({ ok: true, placement });
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

  router.post('/placement/slots/:slotIndex/clear', async (req, res, next) => {
    try {
      if (!req.authUser) return res.status(401).json({ error: '未登录' });
      const params = h.placementSlotParamSchema.parse(req.params ?? {});
      const placement = await h.runSerializableTransaction(async (tx) => {
        const userId = req.authUser!.id;
        const asOf = h.now();
        const ensured = await h.ensurePlacementStateAndSlots(tx, userId);
        const accruedState = await h.accruePlacementPending(tx, {
          userId,
          state: ensured.state,
          slots: ensured.slots,
          addons: ensured.addons,
          asOf
        });
        const unlockedSlotCount = h.normalizedPlacementUnlockedSlotCount(accruedState);
        if (params.slotIndex > unlockedSlotCount) {
          throw Object.assign(new Error('该槽位尚未解锁'), { status: 400 });
        }
        const targetSlot = ensured.slots.find((slot) => slot.slotIndex === params.slotIndex);
        if (!targetSlot) {
          throw Object.assign(new Error('槽位不存在'), { status: 404 });
        }
        if (targetSlot.cardId != null) {
          await tx.gachaPlacementSlot.update({
            where: { id: targetSlot.id },
            data: {
              cardId: null,
              inventoryId: null,
              instanceId: null,
              affixVisualStyle: null,
              affixSignature: null,
              affixLabel: null,
              assignedAt: null
            }
          });
        }
        const slots = targetSlot.cardId == null
          ? ensured.slots
          : await h.listPlacementSlots(tx, userId);
        return h.serializePlacement(userId, accruedState, slots, ensured.addons);
      });
      res.json({ ok: true, placement });
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

  router.post('/placement/slots/unlock', async (req, res, next) => {
    try {
      if (!req.authUser) return res.status(401).json({ error: '未登录' });
      const result = await h.runSerializableTransaction(async (tx) => {
        const userId = req.authUser!.id;
        const asOf = h.now();
        const ensured = await h.ensurePlacementStateAndSlots(tx, userId);
        const accruedState = await h.accruePlacementPending(tx, {
          userId,
          state: ensured.state,
          slots: ensured.slots,
          addons: ensured.addons,
          asOf
        });
        const unlockedSlotCount = h.normalizedPlacementUnlockedSlotCount(accruedState);
        if (unlockedSlotCount >= h.PLACEMENT_SLOT_COUNT_MAX) {
          throw Object.assign(new Error('槽位已解锁至上限'), { status: 400 });
        }
        const unlockCost = h.nextPlacementSlotUnlockCost(unlockedSlotCount);
        if (unlockCost == null || unlockCost <= 0) {
          throw Object.assign(new Error('当前无法解锁槽位'), { status: 400 });
        }
        const wallet = await h.ensureWallet(tx, userId);
        if (wallet.balance < unlockCost) {
          throw Object.assign(new Error('Token 余额不足'), { status: 400 });
        }
        const updatedWallet = await h.applyWalletDelta(
          tx,
          wallet,
          -unlockCost,
          h.PLACEMENT_SLOT_UNLOCK_REASON,
          {
            fromSlotCount: unlockedSlotCount,
            toSlotCount: unlockedSlotCount + 1,
            cost: unlockCost
          }
        );
        const updatedState = await tx.gachaPlacementState.update({
          where: { id: accruedState.id },
          data: {
            unlockedSlotCount: unlockedSlotCount + 1,
            lastAccrualAt: asOf
          }
        });
        return {
          wallet: await h.serializeWalletWithPity(tx, updatedWallet),
          placement: h.serializePlacement(userId, updatedState, ensured.slots, ensured.addons)
        };
      });
      res.json({ ok: true, wallet: result.wallet, placement: result.placement });
    } catch (error: any) {
      if (error?.status === 400) {
        res.status(400).json({ error: error.message });
        return;
      }
      next(error);
    }
  });

  router.post('/placement/addons/colorless/set', async (req, res, next) => {
    try {
      if (!req.authUser) return res.status(401).json({ error: '未登录' });
      const payload = h.placementAddonSetSchema.parse(req.body ?? {});
      const placement = await h.runSerializableTransaction(async (tx) => {
        const userId = req.authUser!.id;
        const asOf = h.now();
        const ensured = await h.ensurePlacementStateAndSlots(tx, userId);
        const accruedState = await h.accruePlacementPending(tx, {
          userId,
          state: ensured.state,
          slots: ensured.slots,
          addons: ensured.addons,
          asOf
        });
        const inventory = await tx.gachaInventory.findUnique({
          where: {
            userId_cardId: {
              userId,
              cardId: payload.cardId
            }
          },
          include: { card: true }
        });
        if (!inventory || inventory.count <= 0 || !inventory.card) {
          throw Object.assign(new Error('你还没有这张卡片，无法挂载'), { status: 400 });
        }
        const requestedSignature = payload.affixSignature
          ? h.affixSignatureFromStyles(h.parseAffixSignature(payload.affixSignature))
          : null;
        // Find free instances, then filter for COLORLESS
        let freeInstances = await h.findFreeInstances(tx, userId, payload.cardId, {
          affixSignature: requestedSignature ?? undefined,
          includeLocked: true,
          includeShowcased: true
        });
        freeInstances = freeInstances.filter((inst) => {
          const fingerprint = h.buildAffixFingerprintFromSignature(inst.affixSignature);
          return fingerprint.affixStyles.includes('COLORLESS');
        });
        if (freeInstances.length === 0) {
          throw Object.assign(new Error('无可挂载的无色词条实例'), { status: 400 });
        }
        const selectedInstance = freeInstances[0];
        const selectedFingerprint = h.buildAffixFingerprintFromSignature(selectedInstance.affixSignature);
        const selectedSignature = selectedFingerprint.affixSignature;
        const addonSlot = await tx.gachaPlacementSlot.findUnique({
          where: {
            userId_slotIndex: {
              userId,
              slotIndex: 0
            }
          }
        });
        if (!addonSlot) {
          throw Object.assign(new Error('无色词条槽初始化失败，请稍后重试'), { status: 500 });
        }
        const addonCurrentSignature = h.affixSignatureFromStyles(h.parseAffixSignature(addonSlot.affixSignature || addonSlot.affixVisualStyle || 'NONE'));
        if (
          addonSlot.cardId !== payload.cardId
          || addonCurrentSignature !== selectedSignature
          || h.normalizeAffixVisualStyleInput(addonSlot.affixVisualStyle) !== selectedFingerprint.affixVisualStyle
          || String(addonSlot.affixLabel || '') !== selectedFingerprint.affixLabel
        ) {
          await tx.gachaPlacementSlot.update({
            where: { id: addonSlot.id },
            data: {
              cardId: payload.cardId,
              inventoryId: inventory.id,
              instanceId: selectedInstance.id,
              affixVisualStyle: selectedFingerprint.affixVisualStyle as PrismaAffixVisualStyle,
              affixSignature: selectedSignature,
              affixLabel: selectedFingerprint.affixLabel,
              assignedAt: asOf
            }
          });
        }
        const addonChanged = addonSlot.cardId !== payload.cardId
          || addonCurrentSignature !== selectedSignature
          || h.normalizeAffixVisualStyleInput(addonSlot.affixVisualStyle) !== selectedFingerprint.affixVisualStyle
          || String(addonSlot.affixLabel || '') !== selectedFingerprint.affixLabel;
        const addons = addonChanged
          ? await h.listPlacementAddons(tx, userId)
          : ensured.addons;
        return h.serializePlacement(userId, accruedState, ensured.slots, addons);
      });
      res.json({ ok: true, placement });
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

  router.post('/placement/addons/colorless/clear', async (req, res, next) => {
    try {
      if (!req.authUser) return res.status(401).json({ error: '未登录' });
      const placement = await h.runSerializableTransaction(async (tx) => {
        const userId = req.authUser!.id;
        const asOf = h.now();
        const ensured = await h.ensurePlacementStateAndSlots(tx, userId);
        const accruedState = await h.accruePlacementPending(tx, {
          userId,
          state: ensured.state,
          slots: ensured.slots,
          addons: ensured.addons,
          asOf
        });
        const addonSlot = await tx.gachaPlacementSlot.findUnique({
          where: {
            userId_slotIndex: {
              userId,
              slotIndex: 0
            }
          }
        });
        if (!addonSlot) {
          throw Object.assign(new Error('无色词条槽初始化失败，请稍后重试'), { status: 500 });
        }
        if (addonSlot.cardId != null) {
          await tx.gachaPlacementSlot.update({
            where: { id: addonSlot.id },
            data: {
              cardId: null,
              inventoryId: null,
              instanceId: null,
              affixVisualStyle: null,
              affixSignature: null,
              affixLabel: null,
              assignedAt: null
            }
          });
        }
        const addons = addonSlot.cardId != null
          ? await h.listPlacementAddons(tx, userId)
          : ensured.addons;
        return h.serializePlacement(userId, accruedState, ensured.slots, addons);
      });
      res.json({ ok: true, placement });
    } catch (error) {
      next(error);
    }
  });

  router.post('/placement/claim', async (req, res, next) => {
    try {
      if (!req.authUser) return res.status(401).json({ error: '未登录' });
      const scope = h.buildIdempotencyScope(req, req.authUser.id);
      const outcome = await h.executeIdempotent(scope, async (tx) => {
        const asOf = h.now();
        const ensured = await h.ensurePlacementStateAndSlots(tx, scope.userId);
        const accruedState = await h.accruePlacementPending(tx, {
          userId: scope.userId,
          state: ensured.state,
          slots: ensured.slots,
          addons: ensured.addons,
          asOf
        });
        const beforePlacement = h.serializePlacement(scope.userId, accruedState, ensured.slots, ensured.addons);

        if (beforePlacement.claimableToken <= 0) {
          return {
            statusCode: 400,
            responseJson: {
              ok: false,
              error: '当前暂无可领取收益'
            }
          };
        }

        const claimToken = beforePlacement.claimableToken;
        const wallet = await h.ensureWallet(tx, scope.userId);
        const updatedWallet = await tx.gachaWallet.update({
          where: { id: wallet.id },
          data: {
            balance: { increment: claimToken },
            totalEarned: { increment: claimToken }
          }
        });
        const pendingAfter = h.clampPlacementToken(
          beforePlacement.pendingToken - claimToken,
          beforePlacement.cap
        );
        const stateAfter = await tx.gachaPlacementState.update({
          where: { id: accruedState.id },
          data: {
            pendingToken: h.toPlacementDecimal(pendingAfter),
            lastAccrualAt: asOf
          }
        });
        await h.recordLedger(tx, wallet.id, scope.userId, claimToken, 'PLACEMENT_CLAIM', {
          claimToken,
          pendingBefore: beforePlacement.pendingToken,
          pendingAfter
        });
        return {
          statusCode: 200,
          responseJson: {
            ok: true,
            claimedToken: claimToken,
            wallet: await h.serializeWalletWithPity(tx, updatedWallet),
            placement: h.serializePlacement(scope.userId, stateAfter, ensured.slots, ensured.addons)
          }
        };
      });

      res.status(outcome.statusCode).json(outcome.responseJson);
    } catch (error: any) {
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
