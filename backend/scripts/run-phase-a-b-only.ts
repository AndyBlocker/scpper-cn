#!/usr/bin/env tsx
/**
 * Run only Phase A and B to set up for Phase C debugging
 */

import { PhaseAProcessor } from '../src/core/processors/PhaseAProcessor.js';
import { PhaseBProcessor } from '../src/core/processors/PhaseBProcessor.js';
import { DatabaseStore } from '../src/core/store/DatabaseStore.js';

const BATCH_SIZE = 3;

async function runPhaseABOnly() {
  console.log('🧪 Running Phase A and B only...');
  
  const store = new DatabaseStore();
  
  try {
    // Step 1: Phase A
    console.log('\n📋 Step 1: Running Phase A...');
    const { CoreQueries } = await import('../src/core/graphql/CoreQueries.js');
    const { GraphQLClient } = await import('../src/core/client/GraphQLClient.js');
    const { PointEstimator } = await import('../src/core/graphql/PointEstimator.js');
    
    const cq = new CoreQueries();
    const client = new GraphQLClient();
    
    const vars = cq.buildPhaseAVariables({ first: BATCH_SIZE, after: null });
    const { query } = cq.buildQuery('phaseA', vars);
    
    const res = await client.request(query, vars);
    const edges = res.pages.edges;
    
    console.log(`📋 Processing ${edges.length} pages...`);
    
    for (const { node } of edges) {
      const estCost = PointEstimator.estimatePageCost(node, { revisionLimit: 20, voteLimit: 20 });
      await store.upsertPageMetaStaging({
        url: node.url,
        wikidotId: node.wikidotId ? parseInt(node.wikidotId) : null,
        title: node.title,
        rating: node.rating ? parseInt(node.rating) : null,
        voteCount: node.voteCount ? parseInt(node.voteCount) : null,
        revisionCount: node.revisionCount ? parseInt(node.revisionCount) : null,
        tags: node.tags || [],
        isDeleted: node.isDeleted || false,
        estimatedCost: estCost,
        category: node.category || null,
        parentUrl: node.parent?.url || null,
        childCount: node.children ? node.children.length : 0,
        attributionCount: 0,
        voteUp: null,
        voteDown: null,
      });
    }
    
    const queueStats = await store.buildDirtyQueue();
    console.log('✅ Phase A completed:', queueStats);
    
    // Step 2: Phase B
    console.log('\n📋 Step 2: Running Phase B...');
    const phaseB = new PhaseBProcessor();
    await phaseB.run();
    console.log('✅ Phase B completed');
    
    // Show results
    console.log('\n📋 Results after Phase A & B:');
    const pages = await store.prisma.page.count();
    const versions = await store.prisma.pageVersion.count();
    const attributions = await store.prisma.attribution.count();
    const revisions = await store.prisma.revision.count();
    const votes = await store.prisma.vote.count();
    
    console.log(`📄 Pages: ${pages}`);
    console.log(`📑 Versions: ${versions}`);
    console.log(`👥 Attributions: ${attributions}`);
    console.log(`📝 Revisions: ${revisions}`);
    console.log(`🗳️ Votes: ${votes}`);
    
    // Check dirty pages for Phase C
    const dirtyPages = await store.fetchDirtyPages('C', 10);
    console.log(`🔄 Dirty pages needing Phase C: ${dirtyPages.length}`);
    
    for (const dp of dirtyPages) {
      console.log(`  - ${dp.page.url}: ${dp.reasons.join(', ')}`);
    }
    
  } catch (error) {
    console.error('❌ Error:', error);
  } finally {
    await store.disconnect();
  }
}

runPhaseABOnly().catch(console.error);