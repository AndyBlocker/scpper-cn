/**
 * 午夜阶梯跳变 - 仓位结算补偿脚本 (user-backend 数据库)
 *
 * 查找异常 tick 期间的结算，用修正后的 tick 价格重算，创建补偿条目
 *
 * Usage:
 *   cd user-backend
 *   node --import tsx/esm src/cli/fixMidnightJumpCompensate.ts inspect
 *   node --import tsx/esm src/cli/fixMidnightJumpCompensate.ts apply
 */
import { prisma } from '../db.js';
import { Prisma } from '@prisma/client';

const ANOMALOUS_TS = new Date('2026-02-14T16:00:00Z'); // Feb 15 00:00 UTC+8

// Corrected tick data from backend (regenerated with fixed algorithm)
const CORRECTED_TICKS: Record<string, Record<string, number>> = {
  // asOfTs -> category -> indexMark
  '2026-02-14T14:00:00.000Z': {
    GOI: 77.9601, OVERALL: 99.7800, SCP: 94.9529, TALE: 94.0745, TRANSLATION: 116.9043, WANDERERS: 73.2195
  },
  '2026-02-14T15:00:00.000Z': {
    GOI: 77.9601, OVERALL: 99.7800, SCP: 94.9529, TALE: 94.0745, TRANSLATION: 116.9043, WANDERERS: 73.2195
  },
  '2026-02-14T16:00:00.000Z': {
    GOI: 78.0000, OVERALL: 99.5038, SCP: 94.9452, TALE: 93.4987, TRANSLATION: 116.6988, WANDERERS: 72.8704
  },
  '2026-02-14T17:00:00.000Z': {
    GOI: 78.0000, OVERALL: 99.5038, SCP: 94.9452, TALE: 93.4987, TRANSLATION: 116.6988, WANDERERS: 72.8704
  }
};

// Settle fee rate is 8% on profit, same across all tiers
const SETTLE_FEE_RATE = 0.08;

function marketCalcEquity(
  margin: number,
  side: string,
  leverage: number,
  entryIndex: number,
  currentIndex: number
) {
  if (margin <= 0 || entryIndex <= 0 || currentIndex <= 0) return 0;
  const direction = side === 'LONG' ? 1 : -1;
  const ratio = (currentIndex - entryIndex) / entryIndex;
  return margin * (1 + direction * leverage * ratio);
}

function getCorrectedIndex(category: string, settleTickTs: string): number | null {
  // Find the tick at or before the settle time
  const sortedKeys = Object.keys(CORRECTED_TICKS).sort();
  let bestKey: string | null = null;
  for (const key of sortedKeys) {
    if (key <= settleTickTs) bestKey = key;
  }
  if (!bestKey) return null;
  return CORRECTED_TICKS[bestKey]?.[category] ?? null;
}

type CompensationEntry = {
  userId: string;
  walletId: string;
  amount: number;
  ledgerId: string;
  meta: Record<string, unknown>;
};

async function computeCompensations(): Promise<CompensationEntry[]> {
  const settlements = await prisma.gachaLedgerEntry.findMany({
    where: {
      reason: 'MARKET_POSITION_SETTLE',
      createdAt: { gte: ANOMALOUS_TS }
    },
    orderBy: { createdAt: 'asc' }
  });

  console.log(`  Settle entries after ${ANOMALOUS_TS.toISOString()}: ${settlements.length}`);

  if (settlements.length === 0) return [];

  const compensations: CompensationEntry[] = [];

  for (const entry of settlements) {
    const meta = entry.metadata as Record<string, any> | null;
    if (!meta?.positionId || !meta?.settleTickTs || !meta?.entryIndex || !meta?.margin) {
      console.log(`  Skipping entry id=${entry.id}: insufficient metadata`);
      continue;
    }

    const category = meta.contractId || meta.category;
    const side = meta.side as string;
    const entryIndex = Number(meta.entryIndex);
    const margin = Number(meta.margin);
    const leverage = Number(meta.leverage || 1);
    const originalSettleIndex = Number(meta.settleIndex);
    const originalPayout = Number(meta.payout ?? entry.delta);
    const status = meta.status as string;

    const correctedIndex = getCorrectedIndex(category, meta.settleTickTs);
    if (correctedIndex === null) {
      console.log(`  Skipping entry id=${entry.id}: no corrected tick for ${category} at ${meta.settleTickTs}`);
      continue;
    }

    // Recalculate with corrected index
    let correctedPayout: number;
    if (status === 'LIQUIDATED') {
      // Liquidation: check if corrected index still triggers liquidation
      const correctedEquity = marketCalcEquity(margin, side, leverage, entryIndex, correctedIndex);
      if (correctedEquity <= 0) {
        correctedPayout = 0; // Still liquidated
      } else {
        // No longer liquidated! Full payout
        const profit = Math.max(0, correctedEquity - margin);
        const settleFee = Math.floor(profit * SETTLE_FEE_RATE);
        correctedPayout = Math.max(0, Math.floor(correctedEquity - settleFee));
      }
    } else {
      const correctedEquity = Math.max(0, marketCalcEquity(margin, side, leverage, entryIndex, correctedIndex));
      const profit = Math.max(0, correctedEquity - margin);
      const settleFee = Math.floor(profit * SETTLE_FEE_RATE);
      correctedPayout = Math.max(0, Math.floor(correctedEquity - settleFee));
    }

    const compensation = correctedPayout - originalPayout;

    console.log(`  Entry id=${entry.id}, userId=${entry.userId}`);
    console.log(`    ${category} ${side} ${leverage}x, margin=${margin}, entryIndex=${entryIndex}`);
    console.log(`    status=${status}, originalIndex=${originalSettleIndex}, correctedIndex=${correctedIndex.toFixed(4)}`);
    console.log(`    originalPayout=${originalPayout}, correctedPayout=${correctedPayout}, diff=${compensation}`);

    if (compensation > 0) {
      compensations.push({
        userId: entry.userId,
        walletId: entry.walletId,
        amount: compensation,
        ledgerId: entry.id,
        meta: {
          originalLedgerId: entry.id,
          positionId: meta.positionId,
          contractId: category,
          side,
          leverage,
          margin,
          entryIndex,
          originalSettleIndex,
          correctedIndex,
          originalPayout,
          correctedPayout,
          settleTickTs: meta.settleTickTs
        }
      });
    } else if (compensation < 0) {
      console.log(`    → correction is negative (${compensation}), skipping`);
    } else {
      console.log(`    → no change`);
    }
  }

  return compensations;
}

async function main() {
  const action = process.argv[2] || 'inspect';

  try {
    if (action === 'inspect') {
      console.log('=== Inspecting Affected Settlements ===');
      const compensations = await computeCompensations();
      console.log(`\n=== Summary ===`);
      console.log(`  Compensations to issue: ${compensations.length}`);
      const total = compensations.reduce((sum, c) => sum + c.amount, 0);
      console.log(`  Total compensation: ${total} tokens`);
      for (const c of compensations) {
        console.log(`    userId=${c.userId}: +${c.amount}`);
      }
    } else if (action === 'apply') {
      console.log('=== Applying Compensations ===');
      const compensations = await computeCompensations();

      if (compensations.length === 0) {
        console.log('  No compensations to apply.');
        return;
      }

      const total = compensations.reduce((sum, c) => sum + c.amount, 0);
      console.log(`\n  Issuing ${compensations.length} compensations totaling ${total} tokens...`);

      await prisma.$transaction(async (tx) => {
        for (const comp of compensations) {
          await tx.gachaLedgerEntry.create({
            data: {
              walletId: comp.walletId,
              userId: comp.userId,
              delta: comp.amount,
              reason: 'MIDNIGHT_JUMP_COMPENSATION',
              metadata: comp.meta as Prisma.JsonObject
            }
          });
          await tx.gachaWallet.update({
            where: { id: comp.walletId },
            data: {
              balance: { increment: comp.amount },
              totalEarned: { increment: comp.amount }
            }
          });
          console.log(`  ✅ userId=${comp.userId}: +${comp.amount} tokens`);
        }
      });

      console.log('  All compensations applied successfully.');
    } else {
      console.log('Usage: fixMidnightJumpCompensate.ts [inspect|apply]');
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
