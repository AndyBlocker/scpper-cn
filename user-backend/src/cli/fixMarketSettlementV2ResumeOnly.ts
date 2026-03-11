/**
 * Market settlement repair v2 (resume-only)
 *
 * 1) Detect MARKET_POSITION_SETTLE entries with settleTickTs >= threshold whose
 *    oracle index at settleTickTs mismatches metadata.settleIndex by >= EPSILON.
 * 2) Roll back only: delete those settle entries and reverse wallet deltas.
 * 3) Do NOT auto-resettle. Positions should remain open/resumed.
 * 4) Report resumed-open count (open entries without settle entry) and affected users.
 *
 * Usage:
 *   cd user-backend
 *   node --import tsx/esm src/cli/fixMarketSettlementV2ResumeOnly.ts
 */
import { writeFile } from 'node:fs/promises';
import type { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { loadOracleContext, ORACLE_TICK_LIMIT_POSITION } from '../routes/gacha/runtime.js';
import { MARKET_CONTRACT_ALIASES, type MarketCategory } from '../routes/gacha/shared/constants.js';

const THRESHOLD_ISO = '2026-02-25T16:00:00.000Z';
const THRESHOLD = new Date(THRESHOLD_ISO);
const EPSILON = 1e-6;
const REPORT_PATH = '/tmp/user-market-fix-20260226-v2-resume-report.json';

type JsonObj = Record<string, unknown>;
type Tick = { asOfTs: Date; indexMark: number };
type EntryLite = {
  id: string;
  userId: string;
  walletId: string;
  delta: number;
  createdAt: Date;
  metadata: Prisma.JsonValue | null;
};

function asObj(input: Prisma.JsonValue | null): JsonObj | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  return input as JsonObj;
}

function toCategory(contractRaw: unknown): MarketCategory | null {
  const key = String(contractRaw ?? '').trim().toUpperCase();
  const normalized = (MARKET_CONTRACT_ALIASES[key] ?? key) as MarketCategory;
  if (normalized === 'OVERALL' || normalized === 'TRANSLATION' || normalized === 'SCP'
    || normalized === 'TALE' || normalized === 'GOI' || normalized === 'WANDERERS') {
    return normalized;
  }
  return null;
}

function findLastTickAtOrBefore(ticks: Tick[], ts: Date): Tick | null {
  if (!ticks.length) return null;
  let left = 0;
  let right = ticks.length - 1;
  let answer: Tick | null = null;
  const target = ts.getTime();
  while (left <= right) {
    const mid = Math.floor((left + right) / 2);
    const tick = ticks[mid]!;
    const value = tick.asOfTs.getTime();
    if (value <= target) {
      answer = tick;
      left = mid + 1;
    } else {
      right = mid - 1;
    }
  }
  return answer;
}

async function main() {
  const now = new Date();
  console.log(`[start] ${now.toISOString()} threshold=${THRESHOLD_ISO}`);

  const oracle = await loadOracleContext(now, ORACLE_TICK_LIMIT_POSITION);
  const settleEntries = await prisma.gachaLedgerEntry.findMany({
    where: {
      reason: 'MARKET_POSITION_SETTLE',
      createdAt: { gte: THRESHOLD }
    },
    select: {
      id: true,
      userId: true,
      walletId: true,
      delta: true,
      createdAt: true,
      metadata: true
    },
    orderBy: { createdAt: 'asc' }
  });

  const affected: Array<{
    id: string;
    userId: string;
    walletId: string;
    delta: number;
    createdAt: string;
    positionId: string;
    contractId: string;
    settleTickTs: string;
    settleIndex: number;
    oracleIndex: number;
    diff: number;
  }> = [];

  for (const row of settleEntries as EntryLite[]) {
    const meta = asObj(row.metadata);
    if (!meta) continue;
    const settleTickTsRaw = String(meta.settleTickTs ?? '').trim();
    if (!settleTickTsRaw) continue;
    const settleTickTs = new Date(settleTickTsRaw);
    if (Number.isNaN(settleTickTs.getTime())) continue;
    if (settleTickTs.getTime() < THRESHOLD.getTime()) continue;

    const category = toCategory(meta.contractId);
    if (!category) continue;
    const ticks = oracle.byCategory[category] ?? [];
    const oracleTick = findLastTickAtOrBefore(ticks, settleTickTs);
    if (!oracleTick) continue;

    const settleIndex = Number(meta.settleIndex ?? NaN);
    if (!Number.isFinite(settleIndex)) continue;
    const oracleIndex = Number(oracleTick.indexMark ?? NaN);
    if (!Number.isFinite(oracleIndex)) continue;
    const diff = Math.abs(oracleIndex - settleIndex);
    if (diff < EPSILON) continue;

    affected.push({
      id: row.id,
      userId: row.userId,
      walletId: row.walletId,
      delta: row.delta,
      createdAt: row.createdAt.toISOString(),
      positionId: String(meta.positionId ?? ''),
      contractId: String(meta.contractId ?? ''),
      settleTickTs: settleTickTs.toISOString(),
      settleIndex,
      oracleIndex,
      diff
    });
  }

  if (affected.length === 0) {
    const emptyReport = {
      threshold: THRESHOLD_ISO,
      epsilon: EPSILON,
      affectedEntryCount: 0,
      affectedUserIds: [] as string[],
      reversedTotal: 0,
      resumedOpenCount: 0,
      resumedOpenByUser: {} as Record<string, number>,
      generatedAt: new Date().toISOString()
    };
    await writeFile(REPORT_PATH, `${JSON.stringify(emptyReport, null, 2)}\n`, 'utf8');
    console.log('affected_settles=0');
    console.log('resumed_open_count=0');
    console.log(`report=${REPORT_PATH}`);
    return;
  }

  const affectedIds = affected.map((a) => a.id);
  const affectedUserIds = Array.from(new Set(affected.map((a) => a.userId))).sort();

  const walletReversals = new Map<string, { userId: string; delta: number }>();
  for (const item of affected) {
    const cur = walletReversals.get(item.walletId) ?? { userId: item.userId, delta: 0 };
    cur.delta += -item.delta;
    walletReversals.set(item.walletId, cur);
  }

  await prisma.$transaction(async (tx) => {
    await tx.gachaLedgerEntry.deleteMany({ where: { id: { in: affectedIds } } });

    for (const [walletId, change] of walletReversals) {
      if (change.delta === 0) continue;
      const data: Prisma.GachaWalletUpdateInput = {
        balance: { increment: change.delta }
      };
      if (change.delta < 0) {
        data.totalEarned = { increment: change.delta };
      }
      await tx.gachaWallet.update({
        where: { id: walletId },
        data
      });
    }
  });

  // Post rollback: resumed-open means open has no corresponding settle
  const openEntries = await prisma.gachaLedgerEntry.findMany({
    where: {
      userId: { in: affectedUserIds },
      reason: 'MARKET_POSITION_OPEN'
    },
    select: { userId: true, metadata: true }
  });
  const settleEntriesAfter = await prisma.gachaLedgerEntry.findMany({
    where: {
      userId: { in: affectedUserIds },
      reason: 'MARKET_POSITION_SETTLE'
    },
    select: { userId: true, metadata: true }
  });

  const openByUser = new Map<string, Set<string>>();
  const settledByUser = new Map<string, Set<string>>();
  for (const row of openEntries) {
    const meta = asObj(row.metadata);
    const posId = String(meta?.positionId ?? '').trim();
    if (!posId) continue;
    const s = openByUser.get(row.userId) ?? new Set<string>();
    s.add(posId);
    openByUser.set(row.userId, s);
  }
  for (const row of settleEntriesAfter) {
    const meta = asObj(row.metadata);
    const posId = String(meta?.positionId ?? '').trim();
    if (!posId) continue;
    const s = settledByUser.get(row.userId) ?? new Set<string>();
    s.add(posId);
    settledByUser.set(row.userId, s);
  }

  const resumedOpenByUser: Record<string, number> = {};
  let resumedOpenCount = 0;
  for (const userId of affectedUserIds) {
    const opens = openByUser.get(userId) ?? new Set<string>();
    const settles = settledByUser.get(userId) ?? new Set<string>();
    let count = 0;
    for (const posId of opens) {
      if (!settles.has(posId)) count += 1;
    }
    resumedOpenByUser[userId] = count;
    resumedOpenCount += count;
  }

  const reversedTotal = Array.from(walletReversals.values()).reduce((sum, item) => sum + item.delta, 0);
  const report = {
    threshold: THRESHOLD_ISO,
    epsilon: EPSILON,
    affectedEntryCount: affected.length,
    affectedEntries: affected,
    affectedUserIds,
    walletReversals: Array.from(walletReversals.entries()).map(([walletId, v]) => ({
      walletId,
      userId: v.userId,
      delta: v.delta
    })),
    reversedTotal,
    resumedOpenCount,
    resumedOpenByUser,
    generatedAt: new Date().toISOString()
  };

  await writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`affected_settles=${affected.length}`);
  console.log(`affected_users=${affectedUserIds.length}`);
  console.log(`resumed_open_count=${resumedOpenCount}`);
  console.log(`report=${REPORT_PATH}`);
  console.log(`affected_user_ids=${affectedUserIds.join(',')}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
