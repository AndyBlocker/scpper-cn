// src/core/processors/PhaseAProcessor.js
import { GraphQLClient } from '../client/GraphQLClient.js';
import { CoreQueries } from '../graphql/CoreQueries.js';
import { PointEstimator } from '../graphql/PointEstimator.js';
import { DatabaseStore } from '../store/DatabaseStore.js';
import { Logger } from '../../utils/Logger.js';

const cq = new CoreQueries();

let PHASE_A_BATCHSIZE = 100

// 获取总量的查询
const TOTAL_QUERY = /* GraphQL */`
  query {
    aggregatePages(filter: {url: {startsWith: "http://scp-wiki-cn.wikidot.com/"}}) {
      _count
    }
  }
`;

export class PhaseAProcessor {
  constructor() {
    this.client = new GraphQLClient();
    this.store = new DatabaseStore();
  }

  async runComplete() {
    Logger.info('=== Phase A: Complete Page Scanning (New Architecture) ===');
    
    // 获取总页面数量
    Logger.info('Fetching total page count...');
    const totalResult = await this.client.request(TOTAL_QUERY);
    const total = totalResult.aggregatePages._count;
    Logger.info(`Total pages in remote: ${total}`);
    
    // Clear staging table to start fresh
    Logger.info('🧹 Clearing staging table...');
    await this.store.prisma.pageMetaStaging.deleteMany({});
    
    let after = null;
    let processedCount = 0;
    const startTime = Date.now();
    let batchCount = 0;
    
    Logger.info('🔄 Starting complete scan (no skipping)...');
    
    while (true) {
      const vars = cq.buildPhaseAVariables({ first: PHASE_A_BATCHSIZE, after });
      const { query } = cq.buildQuery('phaseA', vars);

      const res = await this.client.request(query, vars);
      const edges = res.pages.edges;

      if (edges.length === 0) break;
      
      batchCount++;
      let totalCostInBatch = 0;

      // Process all pages in this batch (no skipping)
      for (const { node } of edges) {
        // 估算完整采集 cost，使用更准确的参数
        const estCost = PointEstimator.estimatePageCost(
          node,
          { 
            revisionLimit: Math.max(node.revisionCount ?? 0, 20),
            voteLimit: Math.max(node.voteCount ?? 0, 20) 
          }
        );
        
        // Write to staging table instead of cache file
        await this.store.upsertPageMetaStaging({
          url: node.url,
          wikidotId: node.wikidotId ? parseInt(node.wikidotId) : null,
          title: node.title,
          rating: node.rating !== null && node.rating !== undefined ? parseInt(node.rating) : null,
          voteCount: node.voteCount !== null && node.voteCount !== undefined ? parseInt(node.voteCount) : null,
          revisionCount: node.revisionCount !== null && node.revisionCount !== undefined ? parseInt(node.revisionCount) : null,
          tags: node.tags || [],
          isDeleted: node.isDeleted || false,
          estimatedCost: estCost,
          // New fields for enhanced dirty detection
          category: node.category || null,
          parentUrl: node.parent?.url || null,
          childCount: null,
          attributionCount: null,
          voteUp: null, // Will be populated by Wilson score calculation if available
          voteDown: null, // Will be populated by Wilson score calculation if available
        });
        
        totalCostInBatch += estCost;
        processedCount++;
      }
      
      const avgCostInBatch = edges.length > 0 ? (totalCostInBatch / edges.length).toFixed(2) : '0';
      const firstUrl = edges.length > 0 ? edges[0].node.url : 'N/A';
      Logger.info(`Batch ${batchCount}: processed ${edges.length} pages (${processedCount}/${total}), avg cost: ${avgCostInBatch} pts`);
      Logger.info(`  First URL: ${firstUrl}`);

      if (!res.pages.pageInfo.hasNextPage) break;
      after = res.pages.pageInfo.endCursor;
    }
    
    const elapsedTime = (Date.now() - startTime) / 1000;
    const speed = elapsedTime > 0 && processedCount > 0 ? 
      (processedCount / elapsedTime).toFixed(1) + ' pages/s' : 'N/A';
    
    Logger.info(`✅ Phase A completed: ${processedCount} pages scanned in ${elapsedTime.toFixed(1)}s (${speed})`);
    
    // Now build the dirty queue
    Logger.info('🔍 Building dirty page queue...');
    const queueStats = await this.store.buildDirtyQueue();
    
    // Cleanup old staging data
    await this.store.cleanupStagingData(24);
    
    return {
      totalScanned: processedCount,
      elapsedTime,
      speed,
      queueStats,
    };
  }

  async runTestBatch() {
    Logger.info('🧪 Starting test batch scan (first batch only)...');
    
    // Clear staging table to start fresh
    Logger.info('🧹 Clearing staging table...');
    await this.store.prisma.pageMetaStaging.deleteMany({});
    
    const startTime = Date.now();
    let processedCount = 0;
    
    // Only process the first batch
    const vars = cq.buildPhaseAVariables({ first: PHASE_A_BATCHSIZE, after: null });
    const { query } = cq.buildQuery('phaseA', vars);

    Logger.info(`📦 Processing test batch (up to ${PHASE_A_BATCHSIZE} pages)...`);
    
    const res = await this.client.request(query, vars);
    const edges = res.pages.edges;
    
    if (edges.length === 0) {
      Logger.info('No pages found in first batch');
      return {
        totalScanned: 0,
        elapsedTime: 0,
        speed: 'N/A',
        queueStats: { total: 0, phaseB: 0, phaseC: 0, deleted: 0 }
      };
    }

    let totalCostInBatch = 0;

    // Process all pages in this test batch
    for (const { node } of edges) {
      // 估算完整采集 cost，使用更准确的参数
      const estCost = PointEstimator.estimatePageCost(
        node,
        { 
          revisionLimit: Math.max(node.revisionCount ?? 0, 20),
          voteLimit: Math.max(node.voteCount ?? 0, 20) 
        }
      );
      
      // Write to staging table instead of cache file
      await this.store.upsertPageMetaStaging({
        url: node.url,
        wikidotId: node.wikidotId ? parseInt(node.wikidotId) : null,
        title: node.title,
        rating: node.rating,
        voteCount: node.voteCount,
        revisionCount: node.revisionCount,
        tags: node.tags,
        isDeleted: node.isDeleted || false,
        estimatedCost: estCost,
        lastSeenAt: new Date(),
        category: node.category || null,
        parentUrl: node.parent?.url || null,
        childCount: null,
        attributionCount: null,
        // Don't estimate uv/dv in Phase A, leave for analysis stage
        voteUp: null,
        voteDown: null,
      });
      
      totalCostInBatch += estCost;
      processedCount++;
    }
    
    const elapsedTime = (Date.now() - startTime) / 1000;
    const speed = elapsedTime > 0 && processedCount > 0 ? 
      (processedCount / elapsedTime).toFixed(1) + ' pages/s' : 'N/A';
    
    Logger.info(`✅ Test batch completed: ${processedCount} pages scanned in ${elapsedTime.toFixed(1)}s (${speed})`);
    Logger.info(`💰 Estimated total cost for test batch: ${totalCostInBatch} points`);
    
    // Build dirty queue with only the test batch data
    Logger.info('🔍 Building dirty page queue for test batch...');
    const queueStats = await this.store.buildDirtyQueueTestMode();
    
    return {
      totalScanned: processedCount,
      elapsedTime,
      speed,
      queueStats,
    };
  }

  // Legacy method for backward compatibility
  async run() {
    return await this.runComplete();
  }
}