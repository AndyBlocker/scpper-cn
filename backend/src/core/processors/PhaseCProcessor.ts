import { GraphQLClient } from '../client/GraphQLClient.js';
import { DatabaseStore } from '../store/DatabaseStore.js';
import { TaskQueue } from '../scheduler/TaskQueue.js';
import { Logger } from '../../utils/Logger.js';
import { MAX_FIRST, SIMPLE_PAGE_THRESHOLD } from '../../config/RateLimitConfig.js';
import { Progress } from '../../utils/Progress.js';

interface PageToProcess {
  url: string;
  pageId: number;
  wikidotId: number;
  reasons: string[];
  estimatedCost: number;
  isComplex: boolean;
}

interface CollectedData {
  url: string;
  wikidotId: number;
  revisions: any[];
  votes: any[];
}

export class PhaseCProcessor {
  private client: GraphQLClient;
  private store: DatabaseStore;
  private queue: TaskQueue;

  constructor({ concurrency = 2 }: { concurrency?: number } = {}) {
    this.client = new GraphQLClient();
    this.store = new DatabaseStore();
    this.queue = new TaskQueue(concurrency);
  }

  async run(testMode = false): Promise<void> {
    Logger.info('=== Phase C: Targeted Complex Page Processing ===');
    
    const BATCH_LIMIT = testMode ? 100 : 3000;
    let round = 0;
    let totalProcessed = 0;

    const totalPhaseCPages = await this.store.prisma.dirtyPage.count({
      where: { needPhaseC: true, donePhaseC: false }
    });
    
    Logger.info(`Phase C: ${totalPhaseCPages} total pages need processing${testMode ? ' (TEST MODE - limit 100)' : ''}`);
    const bar = totalPhaseCPages > 0 ? Progress.createBar({ title: 'Phase C', total: testMode ? Math.min(100, totalPhaseCPages) : totalPhaseCPages }) : null;

    while (true) {
      // In test mode, limit to 100 pages total
      const remainingLimit = testMode ? Math.max(0, 100 - totalProcessed) : BATCH_LIMIT;
      if (testMode && remainingLimit === 0) {
        Logger.info(`Phase C test mode completed: ${totalProcessed} pages processed (limit: 100)`);
        break;
      }
      
      const dirtyPages = await this.store.fetchDirtyPages('C', Math.min(BATCH_LIMIT, remainingLimit));
      
      if (dirtyPages.length === 0) {
        Logger.info(`Phase C completed: ${totalProcessed}/${totalPhaseCPages} pages processed`);
        break;
      }
      
      round++;
      Logger.info(`Phase C Round ${round}: Found ${dirtyPages.length} pages needing processing`);

      // Batch query: collect all wikidotIds and pageIds that need Phase C
      const phaseCPages = dirtyPages.filter(dp => dp.needPhaseC && dp.wikidotId);
      const wikidotIds = phaseCPages.map(dp => dp.wikidotId).filter((id): id is number => id != null);
      const pageIds = phaseCPages.map(dp => dp.pageId).filter((id): id is number => id != null);

      // Batch query page data (single query instead of N queries)
      const pageDataList = await this.store.prisma.page.findMany({
        where: {
          OR: [
            { id: { in: pageIds } },
            { wikidotId: { in: wikidotIds } }
          ]
        }
      });
      const pageByPageId = new Map(pageDataList.map(p => [p.id, p]));
      const pageByWikidotId = new Map(pageDataList.map(p => [p.wikidotId, p]));

      // Batch query staging data (single query instead of N queries)
      const stagingDataList = await this.store.prisma.pageMetaStaging.findMany({
        where: { wikidotId: { in: wikidotIds } }
      });
      const stagingByWikidotId = new Map(stagingDataList.map(s => [s.wikidotId, s]));

      const pagesToProcess: PageToProcess[] = [];
      for (const dirtyPage of dirtyPages) {
        if (dirtyPage.needPhaseC && dirtyPage.wikidotId) {
          // Use pre-fetched page data (O(1) lookup instead of query)
          let pageData = dirtyPage.page;
          if (!pageData && dirtyPage.pageId) {
            pageData = pageByPageId.get(dirtyPage.pageId) ?? null;
          }
          if (!pageData && dirtyPage.wikidotId) {
            pageData = pageByWikidotId.get(dirtyPage.wikidotId) ?? null;
          }

          if (!pageData) {
            Logger.warn(`No page found for dirtyPage with wikidotId: ${dirtyPage.wikidotId}`);
            continue;
          }

          // Use pre-fetched staging data (O(1) lookup instead of query)
          const stagingData = stagingByWikidotId.get(dirtyPage.wikidotId);

          const estimatedCost = stagingData?.estimatedCost ?? 100;
          const isComplex = estimatedCost > SIMPLE_PAGE_THRESHOLD;

          pagesToProcess.push({
            url: pageData.currentUrl || pageData.url || stagingData?.url || '',
            pageId: pageData.id,
            wikidotId: dirtyPage.wikidotId,
            reasons: dirtyPage.reasons,
            estimatedCost,
            isComplex,
          });
        } else if (dirtyPage.wikidotId) {
          await this.store.clearDirtyFlag(dirtyPage.wikidotId, 'C');
          Logger.debug(`✅ Skipped Phase C for wikidotId ${dirtyPage.wikidotId} (not needed)`);
        }
      }

      const firstUrl = pagesToProcess.length > 0 ? pagesToProcess[0].url : 'N/A';
      const complexCount = pagesToProcess.filter(p => p.isComplex).length;
      const simpleCount = pagesToProcess.filter(p => !p.isComplex).length;
      
      Logger.info(`Phase C Round ${round}: Filtered to ${pagesToProcess.length} pages for processing (${complexCount} complex, ${simpleCount} simple) [${totalProcessed + pagesToProcess.length}/${totalPhaseCPages} total]`);
      Logger.info(`  First URL: ${firstUrl}`);
      
      if (pagesToProcess.length === 0) {
        Logger.info(`Phase C Round ${round}: No pages to process, breaking...`);
        // If we can't process any pages from the batch, something is wrong
        // Break to avoid infinite loop
        break;
      }
      
      const roundStartTime = Date.now();
      let roundProcessedCount = 0;

      const trackProgress = async (wikidotId: number, success = true): Promise<void> => {
        roundProcessedCount++;
        if (bar) bar.increment(1);
        
        if (success) {
          try {
            await this.store.clearDirtyFlag(wikidotId, 'C');
            Logger.debug(`✅ Cleared Phase C dirty flag for wikidotId: ${wikidotId}`);
          } catch (err: any) {
            Logger.error(`Failed to clear dirty flag for wikidotId ${wikidotId}:`, {
              message: err.message,
              stack: err.stack,
              wikidotId: wikidotId,
              wikidotIdType: typeof wikidotId
            });
          }
        }
        
        if (roundProcessedCount % 10 === 0 || roundProcessedCount === pagesToProcess.length) {
          const elapsedTime = (Date.now() - roundStartTime) / 1000;
          const speed = roundProcessedCount > 0 && elapsedTime > 0 ? 
            (roundProcessedCount / elapsedTime).toFixed(1) + ' pages/s' : 'N/A';
          Logger.info(`Phase C Round ${round} progress: ${roundProcessedCount}/${pagesToProcess.length} pages (${speed}) [${totalProcessed + roundProcessedCount}/${totalPhaseCPages} total]`);
        }
      };

      for (const page of pagesToProcess) {
        await this.queue.add(() => this._processOne(
          page.url, 
          page.wikidotId,
          page.reasons, 
          trackProgress
        ));
      }
      
      await this.queue.drain();
      
      const roundElapsedTime = (Date.now() - roundStartTime) / 1000;
      const speed = roundProcessedCount > 0 && roundElapsedTime > 0 ? 
        (roundProcessedCount / roundElapsedTime).toFixed(1) + ' pages/s' : 'N/A';
      
      totalProcessed += roundProcessedCount;
      Logger.info(`Phase C Round ${round} completed: ${roundProcessedCount} pages processed in ${roundElapsedTime.toFixed(1)}s (${speed}) [${totalProcessed}/${totalPhaseCPages}]`);
    }
    
    Logger.info(`✅ Phase C fully completed: ${totalProcessed}/${totalPhaseCPages} pages processed across ${round} rounds`);
    if (bar) bar.stop();
  }

  private async _processOne(
    url: string, 
    wikidotId: number,
    reasons: string[], 
    onComplete: (wikidotId: number, success: boolean) => Promise<void>
  ): Promise<void> {
    let afterRev: string | null | undefined = null;
    let afterVote: string | null | undefined = null;
    let requestCount = 0;
    const collected: CollectedData = { url, wikidotId, revisions: [], votes: [] };
    let success = false;

    try {
      while (afterRev !== undefined || afterVote !== undefined) {
        requestCount++;
        
        const { query, variables } = this._buildQuery(url, afterRev, afterVote);
        const res = await this.client.request(query, variables);
        const page = res.page;

        if (!page) {
          Logger.warn('Phase C: Remote page missing, skipping deletion', {
            url,
            wikidotId,
            reasons,
          });
          success = true;
          await onComplete(wikidotId, success);
          return;
        }

        // Process revisions
        if (page.revisions) {
          const edges = page.revisions.edges;
          collected.revisions.push(...edges.map((e: any) => e.node));
          if (page.revisions.pageInfo.hasNextPage) {
            afterRev = page.revisions.pageInfo.endCursor;
          } else {
            afterRev = undefined;
          }
        } else {
          afterRev = undefined;
        }

        // Process votes
        if (page.fuzzyVoteRecords) {
          const edges = page.fuzzyVoteRecords.edges;
          collected.votes.push(...edges.map((e: any) => e.node));
          if (page.fuzzyVoteRecords.pageInfo.hasNextPage) {
            afterVote = page.fuzzyVoteRecords.pageInfo.endCursor;
          } else {
            afterVote = undefined;
          }
        } else {
          afterVote = undefined;
        }
      }

      // Save to database
      await this.store.upsertPageDetails({
        wikidotId,
        url,
        revisions: { edges: collected.revisions.map(node => ({ node })) },
        votes: { edges: collected.votes.map(node => ({ node })) }
      });
      
      success = true;
      Logger.debug(`✅ ${url}: ${collected.revisions.length} revisions, ${collected.votes.length} votes (${requestCount} requests) - reasons: ${reasons.join(', ')}`);
      
    } catch (error: any) {
      Logger.error(`❌ Failed to process ${url}:`, {
        message: error.message,
        stack: error.stack?.split('\n').slice(0, 5).join('\n'),
        name: error.name
      });
      success = false;

      // 不清除脏标记，保留以便下次同步重试
      // 添加失败原因用于调试
      try {
        const errorReason = `phase_c_error:${new Date().toISOString().slice(0, 19)}`;
        await this.store.prisma.dirtyPage.updateMany({
          where: { wikidotId },
          data: {
            reasons: { push: errorReason }
          }
        });
        Logger.warn(`⚠️  Kept Phase C dirty flag for failed page (will retry): ${url}`);
      } catch (updateError: any) {
        Logger.error(`❌ Failed to update reasons for ${url}:`, updateError.message);
      }
    }
    
    await onComplete(wikidotId, success);
  }

  private _buildQuery(url: string, afterRev: string | null | undefined, afterVote: string | null | undefined): { query: string; variables: any } {
    const vars: any = { url };
    const queryParts: string[] = [];
    const varDeclarations = ['$url: URL!'];
    
    if (afterRev !== undefined) {
      vars.afterRev = afterRev;
      varDeclarations.push('$afterRev: ID');
      queryParts.push(`
          revisions(first: ${MAX_FIRST}, after: $afterRev) {
            edges { 
              node { 
                wikidotId 
                timestamp 
                type 
                user { 
                  ... on WikidotUser { 
                    displayName 
                    wikidotId 
                  } 
                }
                comment
              } 
            }
            pageInfo { hasNextPage endCursor }
          }`);
    }
    
    if (afterVote !== undefined) {
      vars.afterVote = afterVote;
      varDeclarations.push('$afterVote: ID');
      queryParts.push(`
          fuzzyVoteRecords(first: ${MAX_FIRST}, after: $afterVote) {
            edges { 
              node { 
                direction 
                timestamp 
                userWikidotId
                user {
                  ... on WikidotUser {
                    displayName
                    wikidotId
                  }
                }
              } 
            }
            pageInfo { hasNextPage endCursor }
          }`);
    }

    const gql = /* GraphQL */`
      query ComplexPage(${varDeclarations.join(', ')}) {
        page: wikidotPage(url: $url) {
          url${queryParts.join('')}
        }
      }
    `;
    
    return { query: gql, variables: vars };
  }
}
