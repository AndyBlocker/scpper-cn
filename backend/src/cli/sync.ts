// @ts-ignore JS module without types
// @ts-ignore JS module without types
import type { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { PhaseAProcessor } from '../core/processors/PhaseAProcessor.js';
import { PhaseBProcessor } from '../core/processors/PhaseBProcessor.js';
import { PhaseCProcessor } from '../core/processors/PhaseCProcessor.js';
import { analyzeIncremental } from '../jobs/IncrementalAnalyzeJob.js';
import ora from 'ora';
import { DatabaseStore } from '../core/store/DatabaseStore.js';
import { getPrismaClient } from '../utils/db-connection.js';

type SyncOptions = {
  full?: boolean;
  phase?: string;
  concurrency?: string;
  testMode?: boolean;
  onProgress?: () => void;
};

const SYNC_LOCK_KEY = 'scpper-sync-global';
const SYNC_LOCK_LEASE_MS = 5 * 60 * 1000; // 5 minutes (heartbeat keeps it alive during active runs)
const SYNC_LOCK_HEARTBEAT_MS = 30 * 1000; // 30 seconds

type SyncLockAcquireResult = {
  acquired: boolean;
  leaseUntil?: Date;
  holderOwner?: string;
  holderLeaseUntil?: Date;
};

let syncLockTableReady = false;

async function ensureSyncLockTable(prisma: PrismaClient): Promise<void> {
  if (syncLockTableReady) return;

  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "SyncExecutionLock" (
      "key" TEXT PRIMARY KEY,
      "owner" TEXT NOT NULL,
      "acquiredAt" TIMESTAMP(3) NOT NULL DEFAULT NOW(),
      "heartbeatAt" TIMESTAMP(3) NOT NULL DEFAULT NOW(),
      "expiresAt" TIMESTAMP(3) NOT NULL,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT NOW(),
      "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT NOW()
    )
  `);

  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "SyncExecutionLock_expiresAt_idx"
    ON "SyncExecutionLock" ("expiresAt")
  `);

  syncLockTableReady = true;
}

function leaseUntilDate(): Date {
  return new Date(Date.now() + SYNC_LOCK_LEASE_MS);
}

async function acquireSyncLock(prisma: PrismaClient, owner: string): Promise<SyncLockAcquireResult> {
  await ensureSyncLockTable(prisma);
  const leaseUntil = leaseUntilDate();

  const rows = await prisma.$queryRaw<Array<{ owner: string; expiresAt: Date }>>`
    INSERT INTO "SyncExecutionLock" ("key", "owner", "acquiredAt", "heartbeatAt", "expiresAt", "createdAt", "updatedAt")
    VALUES (${SYNC_LOCK_KEY}, ${owner}, NOW(), NOW(), ${leaseUntil}, NOW(), NOW())
    ON CONFLICT ("key") DO UPDATE
    SET "owner" = EXCLUDED."owner",
        "heartbeatAt" = NOW(),
        "expiresAt" = EXCLUDED."expiresAt",
        "updatedAt" = NOW()
    WHERE "SyncExecutionLock"."expiresAt" < NOW()
       OR "SyncExecutionLock"."owner" = EXCLUDED."owner"
    RETURNING "owner", "expiresAt"
  `;

  if (rows.length > 0 && rows[0]?.owner === owner) {
    return { acquired: true, leaseUntil: rows[0].expiresAt };
  }

  const holderRows = await prisma.$queryRaw<Array<{ owner: string; expiresAt: Date }>>`
    SELECT "owner", "expiresAt"
    FROM "SyncExecutionLock"
    WHERE "key" = ${SYNC_LOCK_KEY}
    LIMIT 1
  `;

  return {
    acquired: false,
    holderOwner: holderRows[0]?.owner,
    holderLeaseUntil: holderRows[0]?.expiresAt
  };
}

async function refreshSyncLock(prisma: PrismaClient, owner: string): Promise<boolean> {
  await ensureSyncLockTable(prisma);
  const leaseUntil = leaseUntilDate();

  const rows = await prisma.$queryRaw<Array<{ owner: string; expiresAt: Date }>>`
    UPDATE "SyncExecutionLock"
    SET "heartbeatAt" = NOW(),
        "expiresAt" = ${leaseUntil},
        "updatedAt" = NOW()
    WHERE "key" = ${SYNC_LOCK_KEY}
      AND "owner" = ${owner}
    RETURNING "owner", "expiresAt"
  `;

  return rows.length > 0;
}

async function releaseSyncLock(prisma: PrismaClient, owner: string): Promise<void> {
  try {
    await ensureSyncLockTable(prisma);
    await prisma.$executeRaw`
      DELETE FROM "SyncExecutionLock"
      WHERE "key" = ${SYNC_LOCK_KEY}
        AND "owner" = ${owner}
    `;
  } catch (err) {
    console.warn('⚠️ Failed to release sync execution lock:', err);
  }
}

export async function sync({
  full,
  phase,
  concurrency,
  testMode,
  onProgress,
  analysisFatal = true
}: SyncOptions & { analysisFatal?: boolean }) {
  const startTime = Date.now();
  const results: { phaseA?: { totalScanned: number; elapsedTime: number; speed: string; queueStats: any } } = {};
  const prisma = getPrismaClient();
  const lockOwner = `${os.hostname()}:${process.pid}:${randomUUID()}`;
  let lockHeld = false;
  let lockHeartbeatTimer: NodeJS.Timeout | null = null;

  try {
    const lockAcquireResult = await acquireSyncLock(prisma, lockOwner);
    lockHeld = lockAcquireResult.acquired;
    if (!lockHeld) {
      const holder = lockAcquireResult.holderOwner ? ` owner=${lockAcquireResult.holderOwner}` : '';
      const lease = lockAcquireResult.holderLeaseUntil ? ` lease_until=${lockAcquireResult.holderLeaseUntil.toISOString()}` : '';
      console.warn(`⚠️ Sync skipped because another run is still in progress.${holder}${lease}`);
      return { skipped: true };
    }

    lockHeartbeatTimer = setInterval(() => {
      void refreshSyncLock(prisma, lockOwner)
        .then((ok) => {
          if (!ok) {
            console.error('❌ Lost sync execution lock during run. This cycle will continue, but another sync may start after lease expiry.');
          }
        })
        .catch((err) => {
          console.error('⚠️ Failed to refresh sync execution lock heartbeat:', err);
        });
    }, SYNC_LOCK_HEARTBEAT_MS);
    lockHeartbeatTimer.unref();

    // 如果只运行analyze阶段
    if (phase === 'analyze') {
      console.log('📊 Running Analysis Only...');
      if (full) {
        console.log('🔄 Running full incremental analysis (includes voting cache)...');
        await analyzeIncremental({ forceFullAnalysis: true });
      } else {
        console.log('🔄 Running incremental analysis (includes voting cache)...');
        await analyzeIncremental();
      }
      console.log('✅ Analysis completed');
      
      const totalTime = (Date.now() - startTime) / 1000;
      console.log(`\n🎉 Analysis completed successfully in ${totalTime.toFixed(1)}s!`);
      return { analysis: true };
    }

    const mode = testMode ? 'Test mode (first batch only)' : full ? 'Full sync' : 'Incremental sync';
    const header = `🚀 Sync (${mode}) | Phase: ${phase || 'all'} | Concurrency: ${concurrency || '4'}`;
    console.log(header);

    if (testMode) {
      // In test mode, force phase to 'all' to ensure we run Phase A
      phase = phase || 'all';
      console.log('\n=== Test Mode: Phase A with first batch only ===');
      const phaseAProcessor = new PhaseAProcessor();
      const phaseAResTest = await phaseAProcessor.runTestBatch();
      results.phaseA = phaseAResTest;
      console.log(`✅ Phase A (test batch) completed: ${phaseAResTest.totalScanned} pages scanned`);
      console.log(`📊 Dirty Queue: ${phaseAResTest.queueStats.total} pages need processing`);
      console.log(`   - Phase B: ${phaseAResTest.queueStats.phaseB} pages`);
      console.log(`   - Phase C: ${phaseAResTest.queueStats.phaseC} pages`);
      console.log(`   - Deleted: ${phaseAResTest.queueStats.deleted} pages`);
    } else if (phase === 'all' || phase === 'a') {
      // Avoid spinner to keep progress bar clean
      console.log('Phase A: Scanning pages...');
      const phaseAProcessor = new PhaseAProcessor();
      const phaseARes = await phaseAProcessor.runComplete(onProgress);
      results.phaseA = phaseARes;
      console.log(`Phase A: ${phaseARes.totalScanned} pages scanned in ${phaseARes.elapsedTime.toFixed(1)}s`);
      console.log(`📊 Dirty Queue: ${phaseARes.queueStats.total} pages need processing`);
      console.log(`   - Phase B: ${phaseARes.queueStats.phaseB} pages`);
      console.log(`   - Phase C: ${phaseARes.queueStats.phaseC} pages`);
      console.log(`   - Deleted: ${phaseARes.queueStats.deleted} pages`);
      onProgress?.();

      // Reconcile unseen and URL-reused pages and mark deletions now
      const db = new DatabaseStore();
      const rec = await db.reconcileAndMarkDeletions();
      console.log(`🧾 Reconciliation: marked ${rec.unseenCount} unseen and ${rec.urlReusedCount} url-reused pages as deleted`);
      await db.disconnect();
    }

    if ((testMode && phase === 'all') || (!testMode && (phase === 'all' || phase === 'b'))) {
      console.log(testMode ? 'Phase B (test): Collecting content...' : 'Phase B: Collecting content...');
      const phaseBProcessor = new PhaseBProcessor();
      await phaseBProcessor.run(full, testMode, onProgress);
      console.log('Phase B completed');
      onProgress?.();
    }

    if ((testMode && phase === 'all') || (!testMode && (phase === 'all' || phase === 'c'))) {
      console.log(testMode ? 'Phase C (test): Deep processing...' : 'Phase C: Deep processing...');
      const phaseCProcessor = new PhaseCProcessor({ concurrency: parseInt(concurrency || '4') });
      await phaseCProcessor.run(testMode, onProgress);
      console.log('Phase C completed');
      onProgress?.();
    }

    // 只有在运行所有阶段或者明确指定 analyze 时才运行分析
    if (phase === 'all' || phase === 'analyze') {
      const spinnerAnalyze = ora(full ? 'Analysis: full incremental...' : 'Analysis: incremental...').start();
      try {
        if (full) {
          await analyzeIncremental({ forceFullAnalysis: true });
        } else {
          await analyzeIncremental();
        }
        spinnerAnalyze.succeed('Analysis completed');
      } catch (analyzeError) {
        spinnerAnalyze.fail('Analysis completed with errors');
        console.error('⚠️ Incremental analysis had failures:', analyzeError instanceof Error ? analyzeError.message : analyzeError);
        // When called from sync-hourly, analysis failures are non-fatal so
        // forum sync and gacha sync can still proceed. For direct CLI usage
        // (npm run sync / sync --full), propagate the error so operators see
        // a non-zero exit code.
        if (analysisFatal) throw analyzeError;
      }
    }

    const totalTime = (Date.now() - startTime) / 1000;
    console.log(`\n🎉 Synchronization completed successfully in ${totalTime.toFixed(1)}s!`);
    
    return results;
    
  } catch (error) {
    console.error('❌ Synchronization failed:', error);
    throw error;
  } finally {
    if (lockHeartbeatTimer) {
      clearInterval(lockHeartbeatTimer);
      lockHeartbeatTimer = null;
    }
    if (lockHeld) {
      await releaseSyncLock(prisma, lockOwner);
    }
  }
}

// CLI execution is managed via commander in index.ts
