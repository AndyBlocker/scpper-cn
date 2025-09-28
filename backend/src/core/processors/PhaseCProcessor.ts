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
      
      const pagesToProcess: PageToProcess[] = [];
      for (const dirtyPage of dirtyPages) {
        if (dirtyPage.needPhaseC && dirtyPage.wikidotId) {
          // For new pages, we might not have a page relation loaded, so look it up
          let pageData = dirtyPage.page;
          if (!pageData && dirtyPage.pageId) {
            pageData = await this.store.prisma.page.findUnique({
              where: { id: dirtyPage.pageId }
            });
          } else if (!pageData && dirtyPage.wikidotId) {
            pageData = await this.store.prisma.page.findUnique({
              where: { wikidotId: dirtyPage.wikidotId }
            });
          }
          
          if (!pageData) {
            Logger.warn(`No page found for dirtyPage with wikidotId: ${dirtyPage.wikidotId}`);
            continue;
          }
          
          const stagingData = await this.store.prisma.pageMetaStaging.findUnique({
            where: { wikidotId: dirtyPage.wikidotId }
          });
          
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
          await this.store.markDeletedByWikidotId(wikidotId);
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
      
      try {
        await this.store.clearDirtyFlag(wikidotId, 'C');
        Logger.warn(`⚠️  Force cleared Phase C dirty flag for failed page: ${url}`);
      } catch (clearError: any) {
        Logger.error(`❌ Failed to force clear dirty flag for ${url}:`, clearError.message);
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