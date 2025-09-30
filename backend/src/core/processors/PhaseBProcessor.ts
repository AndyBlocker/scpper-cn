import { buildAliasQuery } from '../graphql/AliasQueryBuilder.js';
import { PointEstimator } from '../graphql/PointEstimator.js';
import { GraphQLClient } from '../client/GraphQLClient.js';
import { DatabaseStore } from '../store/DatabaseStore.js';
import { Logger } from '../../utils/Logger.js';
import {
  SIMPLE_PAGE_THRESHOLD,
  BUCKET_SOFT_LIMIT,
  MAX_FIRST
} from '../../config/RateLimitConfig.js';
import { Progress } from '../../utils/Progress.js';

const MAX_PACK_CNT = 15;

interface PageToProcess {
  url: string;
  wikidotId: number;
  estimatedCost: number;
  pageId: number | null;
  reasons: string[];
  actualRevisionCount: number;
  actualVoteCount: number;
  stagingIsDeleted: boolean | null;
}

export class PhaseBProcessor {
  private client: GraphQLClient;
  private store: DatabaseStore;

  constructor() {
    this.client = new GraphQLClient();
    this.store = new DatabaseStore();
  }

  async run(fullSync = false, testMode = false): Promise<void> {
    Logger.info('=== Phase B: Targeted Page Content Collection ===');
    
    const BATCH_LIMIT = testMode ? 100 : 5000;
    let round = 0;
    let totalProcessed = 0;

    const totalPhaseBPages = await this.store.prisma.dirtyPage.count({
      where: { needPhaseB: true, donePhaseB: false }
    });
    
    Logger.info(`Phase B: ${totalPhaseBPages} total pages need processing${testMode ? ' (TEST MODE - limit 100)' : ''}`);
    const bar = totalPhaseBPages > 0 ? Progress.createBar({ title: 'Phase B', total: testMode ? Math.min(100, totalPhaseBPages) : totalPhaseBPages }) : null;

    while (true) {
      // In test mode, limit to 100 pages total
      const remainingLimit = testMode ? Math.max(0, 100 - totalProcessed) : BATCH_LIMIT;
      if (testMode && remainingLimit === 0) {
        Logger.info(`Phase B test mode completed: ${totalProcessed} pages processed (limit: 100)`);
        break;
      }
      
      const dirtyPages = await this.store.fetchDirtyPages('B', Math.min(BATCH_LIMIT, remainingLimit));
      
      if (dirtyPages.length === 0) {
        Logger.info(`Phase B completed: ${totalProcessed}/${totalPhaseBPages} pages processed`);
        break;
      }
      
      round++;
      const roundProgressPercent = totalPhaseBPages > 0 ? (totalProcessed / totalPhaseBPages * 100).toFixed(1) : '0';
      Logger.info(`\n🔄 Phase B Round ${round}: Processing ${dirtyPages.length} pages [Current: ${totalProcessed}/${totalPhaseBPages} = ${roundProgressPercent}%]`);
      
      const urlsToProcess: PageToProcess[] = [];
      for (const dirtyPage of dirtyPages) {
        // Use wikidotId for staging data lookup
        const stagingData = await this.store.prisma.pageMetaStaging.findUnique({
          where: { wikidotId: dirtyPage.wikidotId || 0 }
        });
        
        if (!stagingData) {
          Logger.warn(`No staging data found for wikidotId: ${dirtyPage.wikidotId}`);
          continue;
        }
        
        const actualRevCount = stagingData.revisionCount ?? 0;
        const actualVoteCount = stagingData.voteCount ?? 0;
        
        const conservativeCost = PointEstimator.estimatePageCost(
          { revisionCount: actualRevCount, voteCount: actualVoteCount },
          {
            revisionLimit: MAX_FIRST,
            voteLimit: MAX_FIRST,
            includeAttributions: true,
            includeAlternateTitles: true,
            includeChildren: true,
            includeParent: true,
            includeSource: true,
            includeTextContent: true
          }
        );
        
        urlsToProcess.push({
          url: stagingData.url,
          wikidotId: dirtyPage.wikidotId!,
          estimatedCost: conservativeCost,
          pageId: dirtyPage.pageId,
          reasons: dirtyPage.reasons,
          actualRevisionCount: actualRevCount,
          actualVoteCount: actualVoteCount,
          stagingIsDeleted: stagingData?.isDeleted ?? null,
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

      let bucket: PageToProcess[] = [];
      let bucketCost = 0;
      let cnt = 0;
      
      for (const page of urlsToProcess) {
        const c = page.estimatedCost;
        if ((bucketCost + c > BUCKET_SOFT_LIMIT && bucket.length > 0) || cnt === MAX_PACK_CNT) {
          bucketCount++;
          const processedInFlush = await this._flush(bucket, bucketCount, round, totalProcessed + roundProcessedPages, totalPhaseBPages);
          roundProcessedPages += processedInFlush;
          if (bar) bar.increment(processedInFlush);
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
        const processedInFlush = await this._flush(bucket, bucketCount, round, totalProcessed + roundProcessedPages, totalPhaseBPages);
        roundProcessedPages += processedInFlush;
        if (bar) bar.increment(processedInFlush);
      }

      const roundElapsedTime = (Date.now() - roundStartTime) / 1000;
      const speed = roundElapsedTime > 0 ? (roundProcessedPages / roundElapsedTime).toFixed(1) + ' pages/s' : 'N/A';
      
      totalProcessed += roundProcessedPages;
      const finalRoundPercent = totalPhaseBPages > 0 ? (totalProcessed / totalPhaseBPages * 100).toFixed(1) : '0';
      Logger.info(`✅ Phase B Round ${round} completed: ${roundProcessedPages} pages in ${bucketCount} batches, ${roundElapsedTime.toFixed(1)}s (${speed}) [${totalProcessed}/${totalPhaseBPages} = ${finalRoundPercent}%]`);
    }
    
    Logger.info(`✅ Phase B fully completed: ${totalProcessed}/${totalPhaseBPages} pages processed across ${round} rounds`);
    if (bar) bar.stop();
  }

  private async _flush(
    bucket: PageToProcess[], 
    bucketNumber: number, 
    round = 1, 
    totalProcessed = 0, 
    totalPhaseBPages = 0
  ): Promise<number> {
    if (!bucket.length) return 0;
    
    const pagesWithCounts = bucket.map(page => ({
      url: page.url,
      revisionCount: page.actualRevisionCount ?? 0,
      voteCount: page.actualVoteCount ?? 0
    }));
    
    const { query, variables } = buildAliasQuery(pagesWithCounts, {
      revisionLimit: MAX_FIRST,
      voteLimit: MAX_FIRST
    });
    const cost = PointEstimator.estimateQueryCost(bucket);
    
    const aliasByUrl = new Map(
      bucket.map((p, i) => [p.url, `p${i}`])
    );
    
    const currentProgress = totalProcessed + bucket.length;
    const progressPercent = totalPhaseBPages > 0 ? (currentProgress / totalPhaseBPages * 100).toFixed(1) : '0';
    Logger.info(`Round ${round}, Batch ${bucketNumber}: Processing ${bucket.length} pages (~${cost} pts) [${currentProgress}/${totalPhaseBPages} = ${progressPercent}%]`);
    
    const res = await this.client.request(query, variables);
    
    let savedCount = 0;
    let deletedCount = 0;
    let skippedCount = 0;
    const CHUNK_SIZE = 50;
    
    for (let i = 0; i < bucket.length; i += CHUNK_SIZE) {
      const chunk = bucket.slice(i, i + CHUNK_SIZE);
      
      // Process pages and collect PhaseC candidates
      try {
        await this.store.prisma.$transaction(async (tx) => {
          for (const page of chunk) {
            const alias = aliasByUrl.get(page.url);
            const pageData = alias ? res[alias] : undefined;
            const flaggedByStaging = page.stagingIsDeleted === true;
            const flaggedByReason = page.reasons.includes('page_deleted');

            if (!pageData) {
              if (flaggedByStaging || flaggedByReason) {
                await this.store.markDeletedByWikidotId(page.wikidotId);
                deletedCount++;
              } else {
                Logger.warn('Phase B: Skipping deletion for missing remote page data', {
                  url: page.url,
                  wikidotId: page.wikidotId,
                  reasons: page.reasons,
                });
                await this.store.clearDirtyFlag(page.wikidotId, 'B');
                skippedCount++;
              }
              continue;
            }

            if (pageData) {
              const revisionsCount = pageData.revisions?.edges?.length || 0;
              const votesCount = pageData.fuzzyVoteRecords?.edges?.length || 0;
              const needsPhaseC = 
                (pageData.revisions?.pageInfo?.hasNextPage && revisionsCount >= MAX_FIRST) || 
                (pageData.fuzzyVoteRecords?.pageInfo?.hasNextPage && votesCount >= MAX_FIRST);
              
              await this.store.upsertPageContent({
                ...pageData,
                wikidotId: page.wikidotId
              });
              await this.store.clearDirtyFlag(page.wikidotId, 'B');
              
              if (needsPhaseC) {
                const additionalReasons = [
                  pageData.revisions?.pageInfo?.hasNextPage ? 'incomplete_revisions' : '',
                  pageData.fuzzyVoteRecords?.pageInfo?.hasNextPage ? 'incomplete_votes' : ''
                ].filter(Boolean);
                await this.store.markForPhaseC(page.wikidotId, page.pageId, additionalReasons);
              }
              savedCount++;
            }
          }
        }, { 
          isolationLevel: 'Serializable',
          timeout: 30000
        });
      } catch (error) {
        Logger.error(`❌ Failed to process chunk ${i}-${i + chunk.length}:`, error);
        for (const page of chunk) {
          try {
            const alias = aliasByUrl.get(page.url);
            const pageData = alias ? res[alias] : undefined;
            const flaggedByStaging = page.stagingIsDeleted === true;
            const flaggedByReason = page.reasons.includes('page_deleted');

            if (!pageData) {
              if (flaggedByStaging || flaggedByReason) {
                await this.store.markDeletedByWikidotId(page.wikidotId);
                deletedCount++;
              } else {
                Logger.warn('Phase B: Skipping deletion for missing remote page data (retry path)', {
                  url: page.url,
                  wikidotId: page.wikidotId,
                  reasons: page.reasons,
                });
                await this.store.clearDirtyFlag(page.wikidotId, 'B');
                skippedCount++;
              }
              continue;
            }

            if (pageData) {
              const revisionsCount = pageData.revisions?.edges?.length || 0;
              const votesCount = pageData.fuzzyVoteRecords?.edges?.length || 0;
              const needsPhaseC = 
                (pageData.revisions?.pageInfo?.hasNextPage && revisionsCount >= MAX_FIRST) || 
                (pageData.fuzzyVoteRecords?.pageInfo?.hasNextPage && votesCount >= MAX_FIRST);
              await this.store.upsertPageContent({
                ...pageData,
                wikidotId: page.wikidotId
              });
              await this.store.clearDirtyFlag(page.wikidotId, 'B');
              if (needsPhaseC) {
                const additionalReasons = [
                  pageData.revisions?.pageInfo?.hasNextPage ? 'incomplete_revisions' : '',
                  pageData.fuzzyVoteRecords?.pageInfo?.hasNextPage ? 'incomplete_votes' : ''
                ].filter(Boolean);
                await this.store.markForPhaseC(page.wikidotId, page.pageId, additionalReasons);
              }
              savedCount++;
            }
          } catch (individualError) {
            Logger.error(`❌ Failed to process individual page ${page.url}:`, individualError);
            try {
              await this.store.clearDirtyFlag(page.wikidotId, 'B');
              Logger.warn(`⚠️  Force cleared dirty flag for failed page: ${page.url}`);
            } catch (clearError) {
              Logger.error(`❌ Failed to force clear dirty flag for ${page.url}:`, clearError);
            }
          }
        }
      }
    }

    const totalProcessedInBatch = savedCount + deletedCount + skippedCount;
    Logger.info(`✅ Batch ${bucketNumber} completed: ${savedCount} saved, ${deletedCount} deleted, ${skippedCount} skipped`);
    
    return totalProcessedInBatch;
  }
}
