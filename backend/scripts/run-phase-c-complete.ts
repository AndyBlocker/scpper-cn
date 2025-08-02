#!/usr/bin/env tsx
/**
 * Run complete Phase C processing for all remaining dirty pages
 */

import { PhaseCProcessor } from '../src/core/processors/PhaseCProcessor.js';
import { DatabaseStore } from '../src/core/store/DatabaseStore.js';

async function runPhaseCComplete() {
  console.log('🔄 Running complete Phase C processing...');
  
  const store = new DatabaseStore();
  
  try {
    // Check initial state
    console.log('\n📋 Initial State:');
    const pages = await store.prisma.page.count();
    const versions = await store.prisma.pageVersion.count();
    const revisions = await store.prisma.revision.count();
    const votes = await store.prisma.vote.count();
    
    console.log(`  📄 Pages: ${pages}`);
    console.log(`  📑 Versions: ${versions}`);
    console.log(`  📝 Revisions: ${revisions}`);
    console.log(`  🗳️ Votes: ${votes}`);
    
    // Check dirty pages needing Phase C
    const dirtyPages = await store.fetchDirtyPages('C', 100);
    console.log(`\n🔄 Dirty pages needing Phase C: ${dirtyPages.length}`);
    
    if (dirtyPages.length === 0) {
      console.log('✅ No pages need Phase C processing');
      return;
    }
    
    // Show what pages need processing
    for (const dp of dirtyPages) {
      console.log(`  - ${dp.page.url}: ${dp.reasons.join(', ')}`);
    }
    
    // Run Phase C
    console.log('\n🚀 Starting Phase C processing...');
    const phaseC = new PhaseCProcessor({ concurrency: 1 });
    await phaseC.run();
    
    // Check final state
    console.log('\n📋 Final State:');
    const finalPages = await store.prisma.page.count();
    const finalVersions = await store.prisma.pageVersion.count();
    const finalRevisions = await store.prisma.revision.count();
    const finalVotes = await store.prisma.vote.count();
    
    console.log(`  📄 Pages: ${finalPages}`);
    console.log(`  📑 Versions: ${finalVersions}`);
    console.log(`  📝 Revisions: ${finalRevisions} (+${finalRevisions - revisions})`);
    console.log(`  🗳️ Votes: ${finalVotes} (+${finalVotes - votes})`);
    
    // Check remaining dirty pages
    const remainingDirty = await store.fetchDirtyPages('C', 100);
    console.log(`\n🔄 Remaining dirty pages: ${remainingDirty.length}`);
    
    if (remainingDirty.length > 0) {
      console.log('⚠️  Still have dirty pages:');
      for (const dp of remainingDirty) {
        console.log(`  - ${dp.page.url}: ${dp.reasons.join(', ')}`);
      }
    } else {
      console.log('✅ All pages processed successfully!');
    }
    
    // Show per-page breakdown
    console.log('\n📊 Per-page breakdown:');
    const pageBreakdown = await store.prisma.$queryRaw`
      SELECT 
        p.url,
        COUNT(DISTINCT pv.id) as versions,
        COUNT(DISTINCT r.id) as revisions,
        COUNT(DISTINCT v.id) as votes
      FROM "Page" p
      LEFT JOIN "PageVersion" pv ON pv."pageId" = p.id AND pv."validTo" IS NULL
      LEFT JOIN "Revision" r ON r."pageVersionId" = pv.id
      LEFT JOIN "Vote" v ON v."pageVersionId" = pv.id
      GROUP BY p.id, p.url
      ORDER BY p.url
    `;
    
    for (const row of pageBreakdown as any[]) {
      console.log(`  📋 Page: ${row.url} - Versions: ${row.versions} - Revisions: ${row.revisions} - Votes: ${row.votes}`);
    }
    
  } catch (error) {
    console.error('❌ Error:', error);
  } finally {
    await store.disconnect();
  }
}

runPhaseCComplete().catch(console.error);