import { PhaseAProcessor } from '../core/processors/PhaseAProcessor.js';
import { PhaseBProcessor } from '../core/processors/PhaseBProcessor.js';
import { PhaseCProcessor } from '../core/processors/PhaseCProcessor.js';
import { analyze } from '../jobs/AnalyzeJob.js';

export async function sync({ 
  full, 
  phase, 
  concurrency,
  testMode
}: { 
  full?: boolean; 
  phase?: string; 
  concurrency?: string;
  testMode?: boolean;
}) {
  const startTime = Date.now();
  let results = {};

  try {
    // 如果只运行analyze阶段
    if (phase === 'analyze') {
      console.log('📊 Running Analysis Only...');
      await analyze();
      console.log('✅ Analysis completed');
      
      const totalTime = (Date.now() - startTime) / 1000;
      console.log(`\n🎉 Analysis completed successfully in ${totalTime.toFixed(1)}s!`);
      return { analysis: true };
    }

    const mode = testMode ? 'Test mode (first batch only)' : 
                 full ? 'Full sync' : 'Incremental sync';
    console.log('🚀 Starting incremental synchronization (New Architecture)...');
    console.log(`Mode: ${mode}`);
    console.log(`Phase: ${phase || 'all'}`);
    console.log(`Concurrency: ${concurrency || '4'}`);

    if (testMode) {
      // In test mode, force phase to 'all' to ensure we run Phase A
      phase = phase || 'all';
      console.log('\n=== Test Mode: Phase A with first batch only ===');
      const phaseAProcessor = new PhaseAProcessor();
      results.phaseA = await phaseAProcessor.runTestBatch();
      console.log(`✅ Phase A (test batch) completed: ${results.phaseA.totalScanned} pages scanned`);
      console.log(`📊 Dirty Queue: ${results.phaseA.queueStats.total} pages need processing`);
      console.log(`   - Phase B: ${results.phaseA.queueStats.phaseB} pages`);
      console.log(`   - Phase C: ${results.phaseA.queueStats.phaseC} pages`);
      console.log(`   - Deleted: ${results.phaseA.queueStats.deleted} pages`);
    } else if (phase === 'all' || phase === 'a') {
      console.log('\n=== Phase A: Complete Page Scanning ===');
      const phaseAProcessor = new PhaseAProcessor();
      results.phaseA = await phaseAProcessor.runComplete();
      console.log(`✅ Phase A completed: ${results.phaseA.totalScanned} pages scanned`);
      console.log(`📊 Dirty Queue: ${results.phaseA.queueStats.total} pages need processing`);
      console.log(`   - Phase B: ${results.phaseA.queueStats.phaseB} pages`);
      console.log(`   - Phase C: ${results.phaseA.queueStats.phaseC} pages`);
      console.log(`   - Deleted: ${results.phaseA.queueStats.deleted} pages`);
    }

    if ((testMode && phase === 'all') || (!testMode && (phase === 'all' || phase === 'b'))) {
      console.log(testMode ? 
        '\n=== Test Mode: Phase B (test batch only) ===' : 
        '\n=== Phase B: Targeted Content Collection ===');
      const phaseBProcessor = new PhaseBProcessor();
      await phaseBProcessor.run(full);
      console.log('✅ Phase B completed');
    }

    if ((testMode && phase === 'all') || (!testMode && (phase === 'all' || phase === 'c'))) {
      console.log(testMode ?
        '\n=== Test Mode: Phase C (test batch only) ===' :
        '\n=== Phase C: Targeted Vote & Revision Collection ===');
      const phaseCProcessor = new PhaseCProcessor({ 
        concurrency: parseInt(concurrency || '4') 
      });
      await phaseCProcessor.run();
      console.log('✅ Phase C completed');
    }

    console.log(testMode ? '\n=== Test Mode: Running Analysis ===' : '\n=== Running Analysis ===');
    await analyze();
    console.log('✅ Analysis completed');

    const totalTime = (Date.now() - startTime) / 1000;
    console.log(`\n🎉 Synchronization completed successfully in ${totalTime.toFixed(1)}s!`);
    
    return results;
    
  } catch (error) {
    console.error('❌ Synchronization failed:', error);
    throw error;
  }
}

// 如果直接运行此文件，处理命令行参数
if (import.meta.url === `file://${process.argv[1]}`) {
  const testMode = process.argv.includes('--test');
  // If test mode, default phase should be 'all', otherwise use argument or 'all'
  const phase = testMode ? 'all' : (process.argv[2] || 'all');
  const full = process.argv.includes('--full');
  const concurrencyArg = process.argv.find(arg => arg.startsWith('--concurrency='));
  const concurrency = concurrencyArg ? concurrencyArg.split('=')[1] : '4';

  sync({ full, phase, concurrency, testMode })
    .then(() => {
      console.log('🎉 操作完成！');
      process.exit(0);
    })
    .catch((error) => {
      console.error('💥 操作失败:', error);
      process.exit(1);
    });
}