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

const MAX_PACK_CNT = 15;

interface PageToProcess {
  url: string;
  wikidotId: number;
  estimatedCost: number;
  pageId: number | null;
  reasons: string[];
  actualRevisionCount: number;
  actualVoteCount: number;
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
    const CHUNK_SIZE = 50;
    
    for (let i = 0; i < bucket.length; i += CHUNK_SIZE) {
      const chunk = bucket.slice(i, i + CHUNK_SIZE);
      
      // Process pages and collect PhaseC candidates
      const phaseCCandidates: Array<{wikidotId: number, pageId: number | null, reasons: string[]}> = [];
      
      try {
        await this.store.prisma.$transaction(async (tx) => {
          for (const page of chunk) {
            const alias = aliasByUrl.get(page.url);
            const pageData = res[alias!];
            
            if (pageData) {
              // Check if we got all data or need PhaseC
              // Only mark for PhaseC if we actually hit the limit
              const revisionsCount = pageData.revisions?.edges?.length || 0;
              const votesCount = pageData.fuzzyVoteRecords?.edges?.length || 0;
              
              const needsPhaseC = 
                (pageData.revisions?.pageInfo?.hasNextPage && revisionsCount >= MAX_FIRST) || 
                (pageData.fuzzyVoteRecords?.pageInfo?.hasNextPage && votesCount >= MAX_FIRST);
              
              // Pass wikidotId instead of pageId
              await this.store.upsertPageContent({
                ...pageData,
                wikidotId: page.wikidotId
              });
              
              // Clear dirty flag using wikidotId
              await this.store.clearDirtyFlag(page.wikidotId, 'B');
              
              // Collect pages that need PhaseC
              if (needsPhaseC) {
                const additionalReasons = [
                  pageData.revisions?.pageInfo?.hasNextPage ? 'incomplete_revisions' : '',
                  pageData.fuzzyVoteRecords?.pageInfo?.hasNextPage ? 'incomplete_votes' : ''
                ].filter(Boolean);
                
                phaseCCandidates.push({
                  wikidotId: page.wikidotId,
                  pageId: page.pageId,
                  reasons: additionalReasons
                });
              }
              
              savedCount++;
            } else {
              // Page is deleted
              if (page.wikidotId) {
                const existingPage = await this.store.prisma.page.findUnique({
                  where: { wikidotId: page.wikidotId }
                });
                
                if (existingPage) {
                  await this.store.prisma.page.update({
                    where: { id: existingPage.id },
                    data: { isDeleted: true }
                  });
                }
              }
              
              // Clear dirty flags using wikidotId
              await this.store.clearDirtyFlag(page.wikidotId, 'B');
              await this.store.clearDirtyFlag(page.wikidotId, 'C');
              
              deletedCount++;
            }
          }
        }, { 
          isolationLevel: 'Serializable',
          timeout: 30000
        });
        
        // Mark pages for PhaseC in a separate operation
        for (const candidate of phaseCCandidates) {
          try {
            const existingDirtyPage = await this.store.prisma.dirtyPage.findFirst({
              where: { wikidotId: candidate.wikidotId }
            });
            
            if (existingDirtyPage) {
              await this.store.prisma.dirtyPage.update({
                where: { id: existingDirtyPage.id },
                data: {
                  needPhaseC: true,
                  donePhaseC: false,
                  reasons: [...existingDirtyPage.reasons, ...candidate.reasons]
                }
              });
            } else {
              await this.store.prisma.dirtyPage.create({
                data: {
                  wikidotId: candidate.wikidotId,
                  pageId: candidate.pageId,
                  needPhaseC: true,
                  donePhaseC: false,
                  needPhaseB: false,
                  donePhaseB: true,
                  reasons: candidate.reasons
                }
              });
            }
          } catch (phaseCError) {
            Logger.warn(`Failed to mark page ${candidate.wikidotId} for PhaseC:`, phaseCError);
          }
        }
      } catch (error) {
        Logger.error(`❌ Failed to process chunk ${i}-${i + chunk.length}:`, error);
        
        // Process individually if transaction fails
        for (const page of chunk) {
          try {
            const alias = aliasByUrl.get(page.url);
            const pageData = res[alias!];
            
            if (pageData) {
              // Check if we got all data or need PhaseC
              // Only mark for PhaseC if we actually hit the limit
              const revisionsCount = pageData.revisions?.edges?.length || 0;
              const votesCount = pageData.fuzzyVoteRecords?.edges?.length || 0;
              
              const needsPhaseC = 
                (pageData.revisions?.pageInfo?.hasNextPage && revisionsCount >= MAX_FIRST) || 
                (pageData.fuzzyVoteRecords?.pageInfo?.hasNextPage && votesCount >= MAX_FIRST);
              
              await this.store.upsertPageContent({
                ...pageData,
                wikidotId: page.wikidotId
              });
              
              // Clear dirty flag using wikidotId
              await this.store.clearDirtyFlag(page.wikidotId, 'B');
              
              // Mark for PhaseC if we didn't get all data
              if (needsPhaseC) {
                const additionalReasons = [
                  pageData.revisions?.pageInfo?.hasNextPage ? 'incomplete_revisions' : '',
                  pageData.fuzzyVoteRecords?.pageInfo?.hasNextPage ? 'incomplete_votes' : ''
                ].filter(Boolean);
                
                try {
                  const existingDirtyPage = await this.store.prisma.dirtyPage.findFirst({
                    where: { wikidotId: page.wikidotId }
                  });
                  
                  if (existingDirtyPage) {
                    await this.store.prisma.dirtyPage.update({
                      where: { id: existingDirtyPage.id },
                      data: {
                        needPhaseC: true,
                        donePhaseC: false,
                        reasons: [...existingDirtyPage.reasons, ...additionalReasons]
                      }
                    });
                  } else {
                    await this.store.prisma.dirtyPage.create({
                      data: {
                        wikidotId: page.wikidotId,
                        pageId: page.pageId,
                        needPhaseC: true,
                        donePhaseC: false,
                        needPhaseB: false,
                        donePhaseB: true,
                        reasons: additionalReasons
                      }
                    });
                  }
                } catch (phaseCError) {
                  Logger.warn(`Failed to mark page ${page.wikidotId} for PhaseC:`, phaseCError);
                }
              }
              
              savedCount++;
            } else {
              if (page.wikidotId) {
                const existingPage = await this.store.prisma.page.findUnique({
                  where: { wikidotId: page.wikidotId }
                });
                
                if (existingPage) {
                  await this.store.prisma.page.update({
                    where: { id: existingPage.id },
                    data: { isDeleted: true }
                  });
                }
              }
              
              // Clear dirty flags using wikidotId
              await this.store.clearDirtyFlag(page.wikidotId, 'B');
              await this.store.clearDirtyFlag(page.wikidotId, 'C');
              
              deletedCount++;
            }
          } catch (individualError) {
            Logger.error(`❌ Failed to process individual page ${page.url}:`, individualError);
            
            // Force clear dirty flag to prevent infinite loops
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

    const totalProcessedInBatch = savedCount + deletedCount;
    Logger.info(`✅ Batch ${bucketNumber} completed: ${savedCount} saved, ${deletedCount} deleted`);
    
    return totalProcessedInBatch;
  }
}