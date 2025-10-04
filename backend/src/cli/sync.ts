// @ts-ignore JS module without types
// @ts-ignore JS module without types
import type { PrismaClient } from '@prisma/client';
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
};

const SYNC_LOCK_KEY = 'scpper-sync-global';

async function acquireSyncLock(prisma: PrismaClient): Promise<boolean> {
  const rows = await prisma.$queryRaw<Array<{ locked: boolean }>>`
    SELECT pg_try_advisory_lock(hashtext(${SYNC_LOCK_KEY})) AS locked
  `;
  return Boolean(rows[0]?.locked);
}

async function releaseSyncLock(prisma: PrismaClient): Promise<void> {
  try {
    await prisma.$executeRaw`
      SELECT pg_advisory_unlock(hashtext(${SYNC_LOCK_KEY}))
    `;
  } catch (err) {
    console.warn('⚠️ Failed to release sync advisory lock:', err);
  }
}

export async function sync({ 
  full, 
  phase, 
  concurrency,
  testMode
}: SyncOptions) {
  const startTime = Date.now();
  const results: { phaseA?: { totalScanned: number; elapsedTime: number; speed: string; queueStats: any } } = {};
  const prisma = getPrismaClient();
  let lockHeld = false;

  try {
    lockHeld = await acquireSyncLock(prisma);
    if (!lockHeld) {
      console.warn('⚠️ Sync skipped because another run is still in progress.');
      return { skipped: true };
    }

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
      const phaseARes = await phaseAProcessor.runComplete();
      results.phaseA = phaseARes;
      console.log(`Phase A: ${phaseARes.totalScanned} pages scanned in ${phaseARes.elapsedTime.toFixed(1)}s`);
      console.log(`📊 Dirty Queue: ${phaseARes.queueStats.total} pages need processing`);
      console.log(`   - Phase B: ${phaseARes.queueStats.phaseB} pages`);
      console.log(`   - Phase C: ${phaseARes.queueStats.phaseC} pages`);
      console.log(`   - Deleted: ${phaseARes.queueStats.deleted} pages`);

      // Reconcile unseen and URL-reused pages and mark deletions now
      const db = new DatabaseStore();
      const rec = await db.reconcileAndMarkDeletions();
      console.log(`🧾 Reconciliation: marked ${rec.unseenCount} unseen and ${rec.urlReusedCount} url-reused pages as deleted`);
      await db.disconnect();
    }

    if ((testMode && phase === 'all') || (!testMode && (phase === 'all' || phase === 'b'))) {
      console.log(testMode ? 'Phase B (test): Collecting content...' : 'Phase B: Collecting content...');
      const phaseBProcessor = new PhaseBProcessor();
      await phaseBProcessor.run(full, testMode);
      console.log('Phase B completed');
    }

    if ((testMode && phase === 'all') || (!testMode && (phase === 'all' || phase === 'c'))) {
      console.log(testMode ? 'Phase C (test): Deep processing...' : 'Phase C: Deep processing...');
      const phaseCProcessor = new PhaseCProcessor({ concurrency: parseInt(concurrency || '4') });
      await phaseCProcessor.run(testMode);
      console.log('Phase C completed');
    }

    // 只有在运行所有阶段或者明确指定 analyze 时才运行分析
    if (phase === 'all' || phase === 'analyze') {
      const spinnerAnalyze = ora(full ? 'Analysis: full incremental...' : 'Analysis: incremental...').start();
      if (full) {
        await analyzeIncremental({ forceFullAnalysis: true });
      } else {
        await analyzeIncremental();
      }
      spinnerAnalyze.succeed('Analysis completed');
    }

    const totalTime = (Date.now() - startTime) / 1000;
    console.log(`\n🎉 Synchronization completed successfully in ${totalTime.toFixed(1)}s!`);
    
    return results;
    
  } catch (error) {
    console.error('❌ Synchronization failed:', error);
    throw error;
  } finally {
    if (lockHeld) {
      await releaseSyncLock(prisma);
    }
  }
}

// CLI execution is managed via commander in index.ts
