// src/core/processors/PhaseCProcessor.js
import { GraphQLClient } from '../client/GraphQLClient.js';
import { DatabaseStore } from '../store/DatabaseStore.js';
import { TaskQueue } from '../scheduler/TaskQueue.js';
import { Logger } from '../../utils/Logger.js';
import { MAX_FIRST, SIMPLE_PAGE_THRESHOLD } from '../../config/RateLimitConfig.js';

export class PhaseCProcessor {
  constructor({ concurrency = 2 } = {}) {
    this.client = new GraphQLClient();
    this.store = new DatabaseStore();
    this.queue = new TaskQueue(concurrency);
  }

  async run() {
    Logger.info('=== Phase C: Targeted Complex Page Processing ===');
    
    const BATCH_LIMIT = 3000; // Smaller batches for complex pages
    let round = 0, totalProcessed = 0;

    // Get total count of pages needing Phase C processing
    const totalPhaseCPages = await this.store.prisma.dirtyPage.count({
      where: { needPhaseC: true, donePhaseC: false }
    });
    
    Logger.info(`Phase C: ${totalPhaseCPages} total pages need processing`);

    while (true) {
      // Get dirty pages that need Phase C processing
      const dirtyPages = await this.store.fetchDirtyPages('C', BATCH_LIMIT);
      
      if (dirtyPages.length === 0) {
        Logger.info(`Phase C completed: ${totalProcessed}/${totalPhaseCPages} pages processed`);
        break;
      }
      
      round++;
      Logger.info(`Phase C Round ${round}: Found ${dirtyPages.length} pages needing processing`);
      
      // Only process pages that Phase B determined need Phase C
      const pagesToProcess = [];
      for (const dirtyPage of dirtyPages) {
        // Only process if Phase B determined this page needs Phase C
        if (dirtyPage.needPhaseC) {
          // Get estimated cost for logging purposes
          const stagingData = await this.store.prisma.pageMetaStaging.findUnique({
            where: { url: dirtyPage.page.url }
          });
          const estimatedCost = stagingData?.estimatedCost ?? 100;
          const isComplex = estimatedCost > SIMPLE_PAGE_THRESHOLD;
          
          pagesToProcess.push({
            url: dirtyPage.page.url,
            pageId: dirtyPage.pageId,
            reasons: dirtyPage.reasons,
            estimatedCost,
            isComplex,
          });
        } else {
          // Phase B determined this page doesn't need Phase C
          await this.store.clearDirtyFlag(dirtyPage.pageId, 'C');
          Logger.debug(`✅ Skipped Phase C for ${dirtyPage.page.url} (Phase B determined not needed)`);
        }
      }

      const firstUrl = pagesToProcess.length > 0 ? pagesToProcess[0].url : 'N/A';
      Logger.info(`Phase C Round ${round}: Filtered to ${pagesToProcess.length} pages for processing (${pagesToProcess.filter(p => p.isComplex).length} complex, ${pagesToProcess.filter(p => !p.isComplex).length} simple with vote/revision needs) [${totalProcessed + pagesToProcess.length}/${totalPhaseCPages} total]`);
      Logger.info(`  First URL: ${firstUrl}`);
      
      if (pagesToProcess.length === 0) {
        Logger.info(`Phase C Round ${round}: No pages to process, continuing...`);
        continue;
      }
      
      const roundStartTime = Date.now();
      let roundProcessedCount = 0;

      // 创建进度跟踪函数
      const trackProgress = async (pageId, success = true) => {
        roundProcessedCount++;
        
        if (success) {
          // Clear the dirty flag for Phase C
          try {
            await this.store.clearDirtyFlag(pageId, 'C');
            Logger.debug(`✅ Cleared Phase C dirty flag for page ${pageId}`);
          } catch (err) {
            Logger.error(`Failed to clear dirty flag for page ${pageId}:`, err.message);
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
        await this.queue.add(() => this._processOne(page.url, page.pageId, page.reasons, trackProgress));
      }
      
      await this.queue.drain();
      
      const roundElapsedTime = (Date.now() - roundStartTime) / 1000;
      const speed = roundProcessedCount > 0 && roundElapsedTime > 0 ? 
        (roundProcessedCount / roundElapsedTime).toFixed(1) + ' pages/s' : 'N/A';
      
      totalProcessed += roundProcessedCount;
      Logger.info(`Phase C Round ${round} completed: ${roundProcessedCount} pages processed in ${roundElapsedTime.toFixed(1)}s (${speed}) [${totalProcessed}/${totalPhaseCPages}]`);
    }
    
    Logger.info(`✅ Phase C fully completed: ${totalProcessed}/${totalPhaseCPages} pages processed across ${round} rounds`);
  }

  async _processOne(url, pageId, reasons, onComplete) {
    // console.log(`🔍 Phase C processing: ${url} (pageId: ${pageId})`);
    // console.log(`📋 Reasons: ${reasons.join(', ')}`);
    
    let afterRev = null;
    let afterVote = null;
    let requestCount = 0;
    const collected = { url, revisions: [], votes: [] };
    let success = false;

    try {
      // 当两种分页都抓完才结束
      while (afterRev !== undefined || afterVote !== undefined) {
        requestCount++;
        // console.log(`📋 Request ${requestCount}: afterRev=${afterRev}, afterVote=${afterVote}`);
        
        const { query, variables } = this._buildQuery(url, afterRev, afterVote);
        // console.log(`📋 Query built, variables:`, variables);
        // console.log(`📋 Query (first 300 chars):`, query.substring(0, 300));
        
        const res = await this.client.request(query, variables);
        // console.log(`📋 GraphQL response received`);
        
        const page = res.page;
        // console.log(`📋 Page data:`, page ? 'Found' : 'NULL');

        // Check if page is deleted (null response)
        if (!page) {
          // console.log(`🗑 Page ${url} deleted, clearing flags`);
          await this.store.markPageDeleted(pageId);
          await this.store.clearDirtyFlag(pageId, 'B');
          await this.store.clearDirtyFlag(pageId, 'C');
          success = true;
          await onComplete(pageId, success);
          return;
        }

        // 处理 revisions
        if (page.revisions) {
          // console.log(`📝 Processing revisions...`);
          const edges = page.revisions.edges;
          // console.log(`📝 Found ${edges.length} revision edges`);
          collected.revisions.push(...edges.map(e => e.node));
          if (page.revisions.pageInfo.hasNextPage) {
            afterRev = page.revisions.pageInfo.endCursor;
            // console.log(`📝 More revisions available, cursor: ${afterRev}`);
          } else {
            afterRev = undefined; // 标记抓取完，从查询中移除
            // console.log(`📝 No more revisions`);
          }
        } else {
          // console.log(`📝 No revisions in response`);
          afterRev = undefined;
        }

        // 处理 votes
        if (page.fuzzyVoteRecords) {
          // console.log(`🗳️ Processing votes...`);
          const edges = page.fuzzyVoteRecords.edges;
          // console.log(`🗳️ Found ${edges.length} vote edges`);
          collected.votes.push(...edges.map(e => e.node));
          if (page.fuzzyVoteRecords.pageInfo.hasNextPage) {
            afterVote = page.fuzzyVoteRecords.pageInfo.endCursor;
            // console.log(`🗳️ More votes available, cursor: ${afterVote}`);
          } else {
            afterVote = undefined; // 标记抓取完，从查询中移除
            // console.log(`🗳️ No more votes`);
          }
        } else {
          // console.log(`🗳️ No votes in response`);
          afterVote = undefined;
        }
        
        // console.log(`📊 Current totals: ${collected.revisions.length} revisions, ${collected.votes.length} votes`);
      }

      // console.log(`💾 Saving to database: ${collected.revisions.length} revisions, ${collected.votes.length} votes`);
      
      // Convert the data structure to match what upsertPageDetails expects
      const dataForStore = {
        url: url,
        revisions: collected.revisions,
        votes: collected.votes  // Phase C calls it 'votes', but upsertPageDetails expects 'votes'
      };
      
      // console.log(`📋 Data structure for store:`, {
      //   url: dataForStore.url,
      //   revisionsCount: dataForStore.revisions?.length || 0,
      //   votesCount: dataForStore.votes?.length || 0,
      //   sampleRevision: dataForStore.revisions?.[0] ? {
      //     wikidotId: dataForStore.revisions[0].wikidotId,
      //     timestamp: dataForStore.revisions[0].timestamp,
      //     hasUser: !!dataForStore.revisions[0].user
      //   } : null,
      //   sampleVote: dataForStore.votes?.[0] ? {
      //     direction: dataForStore.votes[0].direction,
      //     timestamp: dataForStore.votes[0].timestamp,
      //     hasUser: !!dataForStore.votes[0].user,
      //     userWikidotId: dataForStore.votes[0].userWikidotId
      //   } : null
      // });
      
      // Save to database using existing method
      await this.store.upsertPageDetails(dataForStore);
      success = true;
      // console.log(`✅ Database save completed successfully`);
      
      
      Logger.debug(`✅ ${url}: ${collected.revisions.length} revisions, ${collected.votes.length} votes (${requestCount} requests) - reasons: ${reasons.join(', ')}`);
      
    } catch (error) {
      Logger.error(`❌ Failed to process ${url}:`, {
        message: error.message,
        stack: error.stack?.split('\n').slice(0, 5).join('\n'),
        name: error.name
      });
      success = false;
      
      // FORCE clear dirty flag to prevent infinite loops
      try {
        await this.store.clearDirtyFlag(pageId, 'C');
        Logger.warn(`⚠️  Force cleared Phase C dirty flag for failed page: ${url}`);
      } catch (clearError) {
        Logger.error(`❌ Failed to force clear dirty flag for ${url}:`, clearError.message);
      }
    }
    
    await onComplete(pageId, success); // 更新进度计数并清除标记
  }

  _buildQuery(url, afterRev, afterVote) {
    const vars = { url };
    const queryParts = [];
    const varDeclarations = ['$url: URL!'];
    
    // 只在连接未完成时添加对应的查询字段
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