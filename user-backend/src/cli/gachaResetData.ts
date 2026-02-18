import { Prisma } from '@prisma/client';
import { prisma } from '../db.js';

type ResetOptions = {
  userId?: string;
  dryRun?: boolean;
};

type ResetSummary = {
  dryRun: boolean;
  scope: 'all' | 'user';
  userId?: string;
  countsBefore: Record<string, number>;
  deleted: Record<string, number>;
};

function normalizeCount(value: number | undefined | null) {
  if (!Number.isFinite(value as number)) return 0;
  return Number(value);
}

async function countGachaRows(userId?: string) {
  const userWhere = userId ? { userId } : undefined;
  const drawItemWhere: Prisma.GachaDrawItemWhereInput | undefined = userId ? { draw: { userId } } : undefined;

  const [
    idempotencyCount,
    placementSlotCount,
    placementStateCount,
    cardInstanceCount,
    dismantleCount,
    drawItemCount,
    drawCount,
    inventoryCount,
    unlockCount,
    ledgerCount,
    walletCount
  ] = await Promise.all([
    prisma.apiIdempotencyRecord.count({ where: userWhere }),
    prisma.gachaPlacementSlot.count({ where: userWhere }),
    prisma.gachaPlacementState.count({ where: userWhere }),
    prisma.gachaCardInstance.count({ where: userWhere }),
    prisma.gachaDismantleLog.count({ where: userWhere }),
    prisma.gachaDrawItem.count({ where: drawItemWhere }),
    prisma.gachaDraw.count({ where: userWhere }),
    prisma.gachaInventory.count({ where: userWhere }),
    prisma.gachaCardUnlock.count({ where: userWhere }),
    prisma.gachaLedgerEntry.count({ where: userWhere }),
    prisma.gachaWallet.count({ where: userWhere })
  ]);

  return {
    apiIdempotencyRecord: normalizeCount(idempotencyCount),
    gachaPlacementSlot: normalizeCount(placementSlotCount),
    gachaPlacementState: normalizeCount(placementStateCount),
    gachaCardInstance: normalizeCount(cardInstanceCount),
    gachaDismantleLog: normalizeCount(dismantleCount),
    gachaDrawItem: normalizeCount(drawItemCount),
    gachaDraw: normalizeCount(drawCount),
    gachaInventory: normalizeCount(inventoryCount),
    gachaCardUnlock: normalizeCount(unlockCount),
    gachaLedgerEntry: normalizeCount(ledgerCount),
    gachaWallet: normalizeCount(walletCount)
  };
}

export async function resetGachaUserData(options: ResetOptions = {}): Promise<ResetSummary> {
  const dryRun = options.dryRun === true;
  const userId = options.userId?.trim() || undefined;
  const scope: 'all' | 'user' = userId ? 'user' : 'all';

  const countsBefore = await countGachaRows(userId);
  if (dryRun) {
    return {
      dryRun: true,
      scope,
      userId,
      countsBefore,
      deleted: {
        apiIdempotencyRecord: 0,
        gachaPlacementSlot: 0,
        gachaPlacementState: 0,
        gachaCardInstance: 0,
        gachaDismantleLog: 0,
        gachaDrawItem: 0,
        gachaDraw: 0,
        gachaInventory: 0,
        gachaCardUnlock: 0,
        gachaLedgerEntry: 0,
        gachaWallet: 0
      }
    };
  }

  const userWhere = userId ? { userId } : undefined;
  const drawItemWhere: Prisma.GachaDrawItemWhereInput | undefined = userId ? { draw: { userId } } : undefined;

  const deleted = await prisma.$transaction(async (tx) => {
    const idempotency = await tx.apiIdempotencyRecord.deleteMany({ where: userWhere });
    const placementSlot = await tx.gachaPlacementSlot.deleteMany({ where: userWhere });
    const placementState = await tx.gachaPlacementState.deleteMany({ where: userWhere });
    const cardInstance = await tx.gachaCardInstance.deleteMany({ where: userWhere });
    const dismantle = await tx.gachaDismantleLog.deleteMany({ where: userWhere });
    const drawItem = await tx.gachaDrawItem.deleteMany({ where: drawItemWhere });
    const draw = await tx.gachaDraw.deleteMany({ where: userWhere });
    const inventory = await tx.gachaInventory.deleteMany({ where: userWhere });
    const unlock = await tx.gachaCardUnlock.deleteMany({ where: userWhere });
    const ledger = await tx.gachaLedgerEntry.deleteMany({ where: userWhere });
    const wallet = await tx.gachaWallet.deleteMany({ where: userWhere });

    return {
      apiIdempotencyRecord: normalizeCount(idempotency.count),
      gachaPlacementSlot: normalizeCount(placementSlot.count),
      gachaPlacementState: normalizeCount(placementState.count),
      gachaCardInstance: normalizeCount(cardInstance.count),
      gachaDismantleLog: normalizeCount(dismantle.count),
      gachaDrawItem: normalizeCount(drawItem.count),
      gachaDraw: normalizeCount(draw.count),
      gachaInventory: normalizeCount(inventory.count),
      gachaCardUnlock: normalizeCount(unlock.count),
      gachaLedgerEntry: normalizeCount(ledger.count),
      gachaWallet: normalizeCount(wallet.count)
    };
  });

  return {
    dryRun: false,
    scope,
    userId,
    countsBefore,
    deleted
  };
}
