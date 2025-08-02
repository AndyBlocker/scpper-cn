import { PhaseAProcessor } from '../core/processors/PhaseAProcessor.js';
import { PhaseBProcessor } from '../core/processors/PhaseBProcessor.js';
import { PhaseCProcessor } from '../core/processors/PhaseCProcessor.js';
import { analyze } from '../jobs/AnalyzeJob.js';

export async function sync({ 
  full, 
  phase, 
  concurrency 
}: { 
  full?: boolean; 
  phase?: string; 
  concurrency?: string; 
}) {
  console.log('🚀 Starting incremental synchronization (New Architecture)...');
  console.log(`Mode: ${full ? 'Full sync' : 'Incremental sync'}`);
  console.log(`Phase: ${phase || 'all'}`);
  console.log(`Concurrency: ${concurrency || '4'}`);

  const startTime = Date.now();
  let results = {};

  try {
    if (phase === 'all' || phase === 'a') {
      console.log('\n=== Phase A: Complete Page Scanning ===');
      const phaseAProcessor = new PhaseAProcessor();
      results.phaseA = await phaseAProcessor.runComplete();
      console.log(`✅ Phase A completed: ${results.phaseA.totalScanned} pages scanned`);
      console.log(`📊 Dirty Queue: ${results.phaseA.queueStats.total} pages need processing`);
      console.log(`   - Phase B: ${results.phaseA.queueStats.phaseB} pages`);
      console.log(`   - Phase C: ${results.phaseA.queueStats.phaseC} pages`);
      console.log(`   - Deleted: ${results.phaseA.queueStats.deleted} pages`);
    }

    if (phase === 'all' || phase === 'b') {
      console.log('\n=== Phase B: Targeted Content Collection ===');
      const phaseBProcessor = new PhaseBProcessor();
      await phaseBProcessor.run(full);
      console.log('✅ Phase B completed');
    }

    if (phase === 'all' || phase === 'c') {
      console.log('\n=== Phase C: Targeted Vote & Revision Collection ===');
      const phaseCProcessor = new PhaseCProcessor({ 
        concurrency: parseInt(concurrency || '4') 
      });
      await phaseCProcessor.run();
      console.log('✅ Phase C completed');
    }

    console.log('\n=== Running Analysis ===');
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