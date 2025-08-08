// src/core/processors/PhaseBProcessor.js
import { buildAliasQuery } from '../graphql/AliasQueryBuilder.js';
import { PointEstimator } from '../graphql/PointEstimator.js';
import { GraphQLClient } from '../client/GraphQLClient.js';
import { DatabaseStore } from '../store/DatabaseStore.js';
import { PageService } from '../../services/PageService.js';
import { Logger } from '../../utils/Logger.js';
import {
  SIMPLE_PAGE_THRESHOLD,
  BUCKET_SOFT_LIMIT,
  MAX_FIRST
} from '../../config/RateLimitConfig.js';

let MAX_PACK_CNT = 20;

export class PhaseBProcessor {
  constructor() {
    this.client = new GraphQLClient();
    this.store = new DatabaseStore();
    this.pageService = new PageService();
  }

  async run(fullSync = false) {
    Logger.info('=== Phase B: Targeted Page Content Collection ===');
    
    const BATCH_LIMIT = 5000; // Process in smaller batches for better memory management
    let round = 0, totalProcessed = 0;

    // Get total count of pages needing Phase B processing
    const totalPhaseBPages = await this.store.prisma.dirtyPage.count({
      where: { needPhaseB: true, donePhaseB: false }
    });
    
    Logger.info(`Phase B: ${totalPhaseBPages} total pages need processing`);

    while (true) {
      // Get dirty pages that need Phase B processing
      const dirtyPages = await this.store.fetchDirtyPages('B', BATCH_LIMIT);
      
      if (dirtyPages.length === 0) {
        Logger.info(`Phase B completed: ${totalProcessed}/${totalPhaseBPages} pages processed`);
        break;
      }
      
      round++;
      const roundProgressPercent = totalPhaseBPages > 0 ? (totalProcessed / totalPhaseBPages * 100).toFixed(1) : '0';
      Logger.info(`\n🔄 Phase B Round ${round}: Processing ${dirtyPages.length} pages [Current: ${totalProcessed}/${totalPhaseBPages} = ${roundProgressPercent}%]`);
      Logger.info(`   First URL: ${dirtyPages.length > 0 ? dirtyPages[0].page.url : 'N/A'}`);
      
      // Process ALL dirty pages in Phase B with conservative limits
      const urlsToProcess = [];
      for (const dirtyPage of dirtyPages) {
        // Get staging data for Phase C determination later
        const stagingData = await this.store.prisma.pageMetaStaging.findUnique({
          where: { url: dirtyPage.page.url }
        });
        
        // Calculate actual conservative cost based on what we'll fetch
        const actualRevCount = stagingData?.revisionCount ?? 0;
        const actualVoteCount = stagingData?.voteCount ?? 0;
        
        const conservativeCost = 
          1 +  // wikidotPage base cost
          2 +  // attributions
          1 +  // source  
          1 +  // textContent
          Math.min(actualRevCount, MAX_FIRST) +   // actual revisions we'll fetch (max 100)
          Math.min(actualVoteCount, MAX_FIRST);   // actual votes we'll fetch (max 100)
        
        urlsToProcess.push({
          url: dirtyPage.page.url,
          estimatedCost: conservativeCost, // Conservative cost based on limited fetching
          pageId: dirtyPage.pageId,
          reasons: dirtyPage.reasons,
          // Include actual counts for Phase C determination and query building
          actualRevisionCount: stagingData?.revisionCount ?? 0,
          actualVoteCount: stagingData?.voteCount ?? 0,
        });
      }
      
      Logger.info(`Round ${round}: Processing ${urlsToProcess.length} pages with conservative limits`);
      
      if (urlsToProcess.length === 0) {
        Logger.info(`Round ${round}: No pages to process, skipping...`);
        continue;
      }
      
      const roundStartTime = Date.now();
      let roundProcessedPages = 0;
      let bucketCount = 0;

      // 分桶 - using existing bucket logic but with dirty page data
      let bucket = [];
      let bucketCost = 0;
      let cnt = 0;
      
      for (const page of urlsToProcess) {
        const c = page.estimatedCost;
        if (bucketCost + c > BUCKET_SOFT_LIMIT && bucket.length > 0 || cnt == MAX_PACK_CNT) {
          bucketCount++;
          roundProcessedPages += await this._flush(bucket, bucketCount, round, totalProcessed + roundProcessedPages, totalPhaseBPages);
          bucket = [];
          bucketCost = 0;
          cnt = 0;
        }
        bucket.push(page);
        bucketCost += c;
        cnt++;
      }
      
      if (bucket.length > 0) {
        bucketCount++;
        roundProcessedPages += await this._flush(bucket, bucketCount, round, totalProcessed + roundProcessedPages, totalPhaseBPages);
      }

      const roundElapsedTime = (Date.now() - roundStartTime) / 1000;
      const speed = roundElapsedTime > 0 ? (roundProcessedPages / roundElapsedTime).toFixed(1) + ' pages/s' : 'N/A';
      
      totalProcessed += roundProcessedPages;
      const finalRoundPercent = totalPhaseBPages > 0 ? (totalProcessed / totalPhaseBPages * 100).toFixed(1) : '0';
      Logger.info(`✅ Phase B Round ${round} completed: ${roundProcessedPages} pages in ${bucketCount} batches, ${roundElapsedTime.toFixed(1)}s (${speed}) [${totalProcessed}/${totalPhaseBPages} = ${finalRoundPercent}%]`);
    }
    
    Logger.info(`✅ Phase B fully completed: ${totalProcessed}/${totalPhaseBPages} pages processed across ${round} rounds`);
  }

  async _flush(bucket, bucketNumber, round = 1, totalProcessed = 0, totalPhaseBPages = 0) {
    if (!bucket.length) return 0;
    
    // Pass actual counts but with limits for proper GraphQL query building
    const pagesWithCounts = bucket.map(page => ({
      ...page,
      revisionCount: page.actualRevisionCount ?? 0,
      voteCount: page.actualVoteCount ?? 0
    }));
    
    const { query, variables } = buildAliasQuery(pagesWithCounts, {
      revisionLimit: MAX_FIRST,
      voteLimit: MAX_FIRST
    });
    const cost = PointEstimator.estimateQueryCost(bucket);
    
    // Precompute url->alias mapping to avoid O(n²) complexity in findIndex
    const aliasByUrl = new Map(
      bucket.map((p, i) => [p.url, `p${i}`])
    );
    
    // Show progress for each batch with total progress
    const currentProgress = totalProcessed + bucket.length;
    const progressPercent = totalPhaseBPages > 0 ? (currentProgress / totalPhaseBPages * 100).toFixed(1) : '0';
    Logger.info(`Round ${round}, Batch ${bucketNumber}: Processing ${bucket.length} pages (~${cost} pts) [${currentProgress}/${totalPhaseBPages} = ${progressPercent}%]`);
    
    const res = await this.client.request(query, variables);
    
    // 处理结果并保存到数据库 - Process in smaller chunks to avoid large transactions
    let savedCount = 0;
    let deletedCount = 0;
    const CHUNK_SIZE = 50; // Process in chunks of 50 to avoid large transactions
    
    for (let i = 0; i < bucket.length; i += CHUNK_SIZE) {
      const chunk = bucket.slice(i, i + CHUNK_SIZE);
      
      // Process chunk in a transaction
      try {
        await this.store.prisma.$transaction(async (tx) => {
          for (let pageIndex = 0; pageIndex < chunk.length; pageIndex++) {
            const page = chunk[pageIndex];
            Logger.debug(`🔍 Processing page: ${page.url} (pageId: ${page.pageId})`);
            
            // Debug: log GraphQL response structure
            Logger.debug(`📋 GraphQL response keys: ${Object.keys(res)}`);
            
            // Fix: Use O(1) alias lookup instead of O(n) findIndex
            const alias = aliasByUrl.get(page.url);
            const pageData = res[alias];
            
            Logger.debug(`📄 Found pageData for ${page.url} at alias ${alias}: ${pageData ? 'YES' : 'NO'}`);
            
            if (pageData) {
              Logger.debug(`📋 PageData structure:`, {
                url: pageData.url,
                title: pageData.title,
                hasTextContent: !!pageData.textContent,
                hasSource: !!pageData.source,
                hasAttributions: !!pageData.attributions,
                hasRevisions: !!pageData.revisions,
                hasFuzzyVoteRecords: !!pageData.fuzzyVoteRecords
              });
              
              // Use existing upsertPageContent method
              await this.store.upsertPageContent(pageData);
              
              // Clear the dirty flag for Phase B
              await this.store.clearDirtyFlag(page.pageId, 'B');
              
              // Determine if Phase C is needed (if we need more votes/revisions)
              const needsMoreRevisions = (page.actualRevisionCount ?? 0) > MAX_FIRST;
              const needsMoreVotes = (page.actualVoteCount ?? 0) > MAX_FIRST;
              const needsPhaseC = needsMoreRevisions || needsMoreVotes;
              
              // Update Phase C requirement
              if (needsPhaseC) {
                Logger.debug(`📋 Page ${page.url} needs Phase C: revisions(${page.actualRevisionCount}) or votes(${page.actualVoteCount}) exceed limits`);
                // Ensure needPhaseC flag is set (it should already be, but make sure)
                await this.store.prisma.dirtyPage.upsert({
                  where: { pageId: page.pageId },
                  update: { needPhaseC: true, donePhaseC: false },
                  create: { 
                    pageId: page.pageId, 
                    needPhaseB: false, 
                    needPhaseC: true, 
                    donePhaseB: true, 
                    donePhaseC: false,
                    reasons: ['needs complete votes/revisions']
                  }
                });
              } else {
                Logger.debug(`📋 Page ${page.url} complete - no Phase C needed`);
                // Clear Phase C requirement since we got everything
                await this.store.prisma.dirtyPage.updateMany({
                  where: { pageId: page.pageId },
                  data: { needPhaseC: false, donePhaseC: true }
                });
              }
              
              savedCount++;
              Logger.debug(`✅ Processed page: ${page.url} (reasons: ${page.reasons?.join(', ') || 'unknown'})`);
            } else {
              // 连续出现 null ⇒ 判定为删除
              Logger.info(`🗑  Page appears to be deleted: ${page.url} – marking isDeleted`);
              await this.store.markPageDeleted(page.pageId);
              // Phase C 不必再跑，直接标记两阶段已完成
              await this.store.clearDirtyFlag(page.pageId, 'B');
              await this.store.clearDirtyFlag(page.pageId, 'C');
              Logger.debug(`✅ Marked ${page.url} as deleted & cleared dirty flags`);
              deletedCount++;
            }
          }
        }, { 
          isolationLevel: 'Serializable',
          timeout: 30000 // 30 second timeout
        });
      } catch (error) {
        Logger.error(`❌ Failed to process chunk ${i}-${i + chunk.length}:`, error);
        Logger.error(`❌ Error details:`, {
          message: error.message,
          stack: error.stack,
          name: error.name
        });
        
        // Process individually if transaction fails
        for (let pageIndex = 0; pageIndex < chunk.length; pageIndex++) {
          const page = chunk[pageIndex];
          try {
            Logger.debug(`🔍 Individual processing for: ${page.url}`);
            Logger.debug(`📋 Available GraphQL response keys: ${Object.keys(res)}`);
            
            // Fix: Use O(1) alias lookup instead of O(n) findIndex
            const alias = aliasByUrl.get(page.url);
            const pageData = res[alias];
            Logger.debug(`📄 Found pageData for ${page.url} at alias ${alias}: ${pageData ? 'YES' : 'NO'}`);
            
            if (pageData) {
              Logger.debug(`📋 Attempting upsertPageContent for: ${page.url}`);
              await this.store.upsertPageContent(pageData);
              await this.store.clearDirtyFlag(page.pageId, 'B');
              
              // Determine if Phase C is needed (individual processing)
              const needsMoreRevisions = (page.actualRevisionCount ?? 0) > MAX_FIRST;
              const needsMoreVotes = (page.actualVoteCount ?? 0) > MAX_FIRST;
              const needsPhaseC = needsMoreRevisions || needsMoreVotes;
              
              // Update Phase C requirement
              if (needsPhaseC) {
                await this.store.prisma.dirtyPage.upsert({
                  where: { pageId: page.pageId },
                  update: { needPhaseC: true, donePhaseC: false },
                  create: { 
                    pageId: page.pageId, 
                    needPhaseB: false, 
                    needPhaseC: true, 
                    donePhaseB: true, 
                    donePhaseC: false,
                    reasons: ['needs complete votes/revisions']
                  }
                });
              } else {
                await this.store.prisma.dirtyPage.updateMany({
                  where: { pageId: page.pageId },
                  data: { needPhaseC: false, donePhaseC: true }
                });
              }
              
              savedCount++;
              Logger.debug(`✅ Successfully processed: ${page.url}`);
            } else {
              Logger.info(`🗑  No data found, marking as deleted: ${page.url}`);
              await this.store.markPageDeleted(page.pageId);
              await this.store.clearDirtyFlag(page.pageId, 'B');
              await this.store.clearDirtyFlag(page.pageId, 'C');
              deletedCount++;
            }
          } catch (individualError) {
            Logger.error(`❌ Failed to process individual page ${page.url}:`, {
              message: individualError.message,
              stack: individualError.stack,
              name: individualError.name
            });
            
            // FORCE clear dirty flag to prevent infinite loops
            try {
              await this.store.clearDirtyFlag(page.pageId, 'B');
              Logger.warn(`⚠️  Force cleared dirty flag for failed page: ${page.url}`);
            } catch (clearError) {
              Logger.error(`❌ Failed to force clear dirty flag for ${page.url}:`, clearError.message);
            }
          }
        }
      }
    }

    const totalProcessedInBatch = savedCount + deletedCount;
    const finalProgress = totalProcessed + totalProcessedInBatch;
    const finalProgressPercent = totalPhaseBPages > 0 ? (finalProgress / totalPhaseBPages * 100).toFixed(1) : '0';
    
    Logger.info(`✅ Batch ${bucketNumber} completed: ${totalProcessedInBatch}/${bucket.length} pages processed${deletedCount > 0 ? ` (${deletedCount} deleted)` : ''} [${finalProgress}/${totalPhaseBPages} = ${finalProgressPercent}%]`);
    
    return totalProcessedInBatch; // Return total processed count
  }
}