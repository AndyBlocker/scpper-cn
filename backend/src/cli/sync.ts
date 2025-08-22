// @ts-ignore JS module without types
import { PhaseAProcessor } from '../core/processors/PhaseAProcessor.js';
import { PhaseBProcessor } from '../core/processors/PhaseBProcessor.js';
import { PhaseCProcessor } from '../core/processors/PhaseCProcessor.js';
import { analyzeIncremental } from '../jobs/IncrementalAnalyzeJob.js';
import ora from 'ora';

type SyncOptions = {
  full?: boolean;
  phase?: string;
  concurrency?: string;
  testMode?: boolean;
};

export async function sync({ 
  full, 
  phase, 
  concurrency,
  testMode
}: SyncOptions) {
  const startTime = Date.now();
  const results: { phaseA?: { totalScanned: number; elapsedTime: number; speed: string; queueStats: any } } = {};

  try {
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
  }
}

// CLI execution is managed via commander in index.ts