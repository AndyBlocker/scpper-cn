/**
 * 午夜阶梯跳变 - 撤销错误结算 & 恢复仓位
 *
 * 流程:
 *   1. 删除错误的 MIDNIGHT_JUMP_COMPENSATION 条目 + 回扣 wallet
 *   2. 删除受异常 tick 影响的 MARKET_POSITION_SETTLE 条目 + 回扣 wallet
 *   3. 仓位自动恢复为活跃，系统下次访问时用正确 tick 重新结算
 *
 * Usage:
 *   cd user-backend
 *   node --import tsx/esm src/cli/fixMidnightJumpReopen.ts inspect
 *   node --import tsx/esm src/cli/fixMidnightJumpReopen.ts apply
 */
import { prisma } from '../db.js';
import type { Prisma } from '@prisma/client';

const ANOMALOUS_TICK_TS = '2026-02-14T16:00:00.000Z';
const ANOMALOUS_TS = new Date(ANOMALOUS_TICK_TS);

// Old anomalous tick index values (before fix) at 2026-02-14T16:00:00.000Z
const OLD_ANOMALOUS_INDEX: Record<string, number> = {
  GOI: 73.74,
  OVERALL: 99.42,
  SCP: 94.08,
  TALE: 92.12,
  TRANSLATION: 116.40,
  WANDERERS: 72.50
};

type SettleEntry = {
  id: string;
  userId: string;
  walletId: string;
  delta: number;
  reason: string;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
};

function isAnomalousTick(meta: Record<string, unknown> | null): boolean {
  if (!meta) return false;
  if (String(meta.settleTickTs ?? '') !== ANOMALOUS_TICK_TS) return false;
  // Also verify the settleIndex matches the OLD anomalous values, not the corrected ones
  const category = String(meta.contractId ?? '');
  const settleIndex = Number(meta.settleIndex ?? 0);
  const oldIndex = OLD_ANOMALOUS_INDEX[category];
  if (!oldIndex) return false;
  // Check if settleIndex is close to the OLD anomalous value (within 0.5)
  return Math.abs(settleIndex - oldIndex) < 0.5;
}

async function inspect() {
  console.log('=== 1. Compensation entries to delete ===');
  const comps = await prisma.gachaLedgerEntry.findMany({
    where: { reason: 'MIDNIGHT_JUMP_COMPENSATION' }
  });
  let compTotal = 0;
  for (const c of comps) {
    console.log(`  id=${c.id}, userId=${c.userId}, delta=+${c.delta}`);
    compTotal += c.delta;
  }
  console.log(`  Count: ${comps.length}, total delta to reverse: -${compTotal}`);

  console.log('\n=== 2. Settle entries using anomalous tick ===');
  const settles = await prisma.gachaLedgerEntry.findMany({
    where: {
      reason: 'MARKET_POSITION_SETTLE',
      createdAt: { gte: ANOMALOUS_TS }
    },
    orderBy: { createdAt: 'asc' }
  });

  const anomalousSettles: SettleEntry[] = [];
  const unaffectedSettles: SettleEntry[] = [];

  for (const s of settles) {
    const meta = s.metadata as Record<string, unknown> | null;
    const tickTs = String(meta?.settleTickTs ?? '?');
    const positionId = String(meta?.positionId ?? '?');
    const status = String(meta?.status ?? '?');
    const settleIndex = meta?.settleIndex ?? '?';

    if (isAnomalousTick(meta)) {
      anomalousSettles.push(s as SettleEntry);
      console.log(`  [ANOMALOUS] id=${s.id}, userId=${s.userId}, delta=${s.delta}`);
      console.log(`    positionId=${positionId}, status=${status}, settleIndex=${settleIndex}, settleTickTs=${tickTs}`);
    } else {
      unaffectedSettles.push(s as SettleEntry);
      console.log(`  [OK] id=${s.id}, userId=${s.userId}, delta=${s.delta}, settleTickTs=${tickTs}`);
    }
  }

  console.log(`\n=== Summary ===`);
  console.log(`  Compensation entries to delete: ${comps.length} (reverse delta: -${compTotal})`);
  console.log(`  Anomalous settle entries to delete: ${anomalousSettles.length} (reverse delta: -${anomalousSettles.reduce((s, e) => s + e.delta, 0)})`);
  console.log(`  Unaffected settle entries: ${unaffectedSettles.length}`);

  // Per-user breakdown
  const userMap = new Map<string, { compDelta: number; settleDelta: number; netWalletChange: number }>();
  for (const c of comps) {
    const u = userMap.get(c.userId) ?? { compDelta: 0, settleDelta: 0, netWalletChange: 0 };
    u.compDelta += c.delta;
    userMap.set(c.userId, u);
  }
  for (const s of anomalousSettles) {
    const u = userMap.get(s.userId) ?? { compDelta: 0, settleDelta: 0, netWalletChange: 0 };
    u.settleDelta += s.delta;
    userMap.set(s.userId, u);
  }
  console.log('\n  Per-user wallet change:');
  for (const [userId, data] of userMap) {
    const netChange = -(data.compDelta + data.settleDelta);
    data.netWalletChange = netChange;
    console.log(`    ${userId}: compensation=-${data.compDelta}, settlePayout=-${data.settleDelta}, net wallet change: ${netChange}`);
  }

  // Show which positions will become active again
  console.log('\n  Positions that will become active again:');
  for (const s of anomalousSettles) {
    const meta = s.metadata as Record<string, unknown> | null;
    console.log(`    positionId=${meta?.positionId}, contract=${meta?.contractId}, side=${meta?.side}, leverage=${meta?.leverage}x, margin=${meta?.margin}, entryIndex=${meta?.entryIndex}`);
    console.log(`      expireAt=${meta?.expireAt}`);
  }
}

async function apply() {
  console.log('=== Applying: Reverse compensation + Delete anomalous settlements ===');

  // Gather data
  const comps = await prisma.gachaLedgerEntry.findMany({
    where: { reason: 'MIDNIGHT_JUMP_COMPENSATION' }
  });

  const settles = await prisma.gachaLedgerEntry.findMany({
    where: {
      reason: 'MARKET_POSITION_SETTLE',
      createdAt: { gte: ANOMALOUS_TS }
    }
  });

  const anomalousSettles = settles.filter(s => isAnomalousTick(s.metadata as Record<string, unknown> | null));

  if (comps.length === 0 && anomalousSettles.length === 0) {
    console.log('  Nothing to do.');
    return;
  }

  // Compute per-wallet delta reversals
  const walletDeltas = new Map<string, { userId: string; delta: number }>();
  for (const c of comps) {
    const w = walletDeltas.get(c.walletId) ?? { userId: c.userId, delta: 0 };
    w.delta -= c.delta; // Reverse compensation: subtract what was added
    walletDeltas.set(c.walletId, w);
  }
  for (const s of anomalousSettles) {
    const w = walletDeltas.get(s.walletId) ?? { userId: s.userId, delta: 0 };
    w.delta -= s.delta; // Reverse settle payout: subtract what was added
    walletDeltas.set(s.walletId, w);
  }

  console.log('  Wallet adjustments:');
  for (const [walletId, data] of walletDeltas) {
    console.log(`    walletId=${walletId}, userId=${data.userId}, delta=${data.delta}`);
  }

  const compIds = comps.map(c => c.id);
  const settleIds = anomalousSettles.map(s => s.id);

  console.log(`\n  Deleting ${compIds.length} compensation entries...`);
  console.log(`  Deleting ${settleIds.length} anomalous settle entries...`);

  await prisma.$transaction(async (tx) => {
    // 1. Delete compensation entries
    if (compIds.length > 0) {
      await tx.gachaLedgerEntry.deleteMany({ where: { id: { in: compIds } } });
      console.log(`  ✅ Deleted ${compIds.length} compensation entries`);
    }

    // 2. Delete anomalous settle entries
    if (settleIds.length > 0) {
      await tx.gachaLedgerEntry.deleteMany({ where: { id: { in: settleIds } } });
      console.log(`  ✅ Deleted ${settleIds.length} anomalous settle entries`);
    }

    // 3. Adjust wallet balances
    for (const [walletId, data] of walletDeltas) {
      if (data.delta === 0) continue;
      const updateData: Prisma.GachaWalletUpdateInput = {
        balance: { increment: data.delta }
      };
      // If delta is negative (removing tokens), increase totalSpent
      if (data.delta < 0) {
        updateData.totalEarned = { increment: data.delta }; // negative increment = decrease
      }
      await tx.gachaWallet.update({
        where: { id: walletId },
        data: updateData
      });
      console.log(`  ✅ Wallet ${walletId} (user=${data.userId}): balance adjusted by ${data.delta}`);
    }
  });

  console.log('\n  Done. Positions are now active again.');
  console.log('  They will be re-settled with corrected tick prices on next user interaction.');

  // Verify
  console.log('\n=== Post-verification ===');
  const remainingComps = await prisma.gachaLedgerEntry.count({ where: { reason: 'MIDNIGHT_JUMP_COMPENSATION' } });
  console.log(`  Remaining compensation entries: ${remainingComps}`);

  const verifyUsers = [...new Set([...comps.map(c => c.userId), ...anomalousSettles.map(s => s.userId)])];
  for (const userId of verifyUsers) {
    const wallet = await prisma.gachaWallet.findUnique({ where: { userId } });
    console.log(`  User ${userId}: balance=${wallet?.balance ?? '?'}`);
  }
}

async function main() {
  const action = process.argv[2] || 'inspect';
  try {
    if (action === 'inspect') {
      await inspect();
    } else if (action === 'apply') {
      await apply();
    } else {
      console.log('Usage: fixMidnightJumpReopen.ts [inspect|apply]');
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
