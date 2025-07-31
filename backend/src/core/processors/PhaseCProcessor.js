// src/core/processors/PhaseCProcessor.js
import { GraphQLClient } from '../client/GraphQLClient.js';
import { DataStore } from '../store/DataStore.js';
import { TaskQueue } from '../scheduler/TaskQueue.js';
import { Logger } from '../../utils/Logger.js';
import { MAX_FIRST } from '../../config/RateLimitConfig.js';

export class PhaseCProcessor {
  constructor({ concurrency = 2 } = {}) {
    this.client = new GraphQLClient();
    this.store = new DataStore();
    this.queue = new TaskQueue(concurrency);
  }

  async run() {
    Logger.info('=== Phase C: Complex Page Processing ===');
    
    const phase1 = await this.store.loadProgress('phase1');
    const complex = phase1.filter(p => (p.estimatedCost ?? 0) > 600);

    Logger.info(`Found ${complex.length} complex pages to process with concurrency=${this.queue.concurrency}`);
    
    const startTime = Date.now();
    let processedCount = 0;

    // 创建进度跟踪函数
    const trackProgress = () => {
      processedCount++;
      if (processedCount % 10 === 0 || processedCount === complex.length) {
        const elapsedTime = (Date.now() - startTime) / 1000;
        const speed = processedCount > 0 && elapsedTime > 0 ? 
          (processedCount / elapsedTime).toFixed(1) + ' pages/s' : 'N/A';
        Logger.info(`Progress: ${processedCount}/${complex.length} pages (${speed})`);
      }
    };

    for (const page of complex) {
      const url = page.url || page.wikidotInfo?.url;
      if (!url) continue;
      
      await this.queue.add(() => this._processOne(url, trackProgress));
    }
    
    await this.queue.drain();
    
    const elapsedTime = (Date.now() - startTime) / 1000;
    const speed = processedCount > 0 && elapsedTime > 0 ? 
      (processedCount / elapsedTime).toFixed(1) + ' pages/s' : 'N/A';
    
    Logger.info(`Phase C completed: ${processedCount} pages processed in ${elapsedTime.toFixed(1)}s (${speed})`);
  }

  async _processOne(url, onComplete) {
    let afterRev = null;
    let afterVote = null;
    let requestCount = 0;
    const collected = { url, revisions: [], votes: [] };

    // 当两种分页都抓完才结束
    while (afterRev !== undefined || afterVote !== undefined) {
      requestCount++;
      const { query, variables } = this._buildQuery(url, afterRev, afterVote);
      const res = await this.client.request(query, variables);
      const page = res.page;

      // 处理 revisions
      if (page.revisions) {
        const edges = page.revisions.edges;
        collected.revisions.push(...edges.map(e => e.node));
        if (page.revisions.pageInfo.hasNextPage) {
          afterRev = page.revisions.pageInfo.endCursor;
        } else {
          afterRev = undefined; // 标记抓取完，从查询中移除
        }
      }

      // 处理 votes
      if (page.fuzzyVoteRecords) {
        const edges = page.fuzzyVoteRecords.edges;
        collected.votes.push(...edges.map(e => e.node));
        if (page.fuzzyVoteRecords.pageInfo.hasNextPage) {
          afterVote = page.fuzzyVoteRecords.pageInfo.endCursor;
        } else {
          afterVote = undefined; // 标记抓取完，从查询中移除
        }
      }
    }

    await this.store.append('phase3', collected);
    
    Logger.debug(`${url}: ${collected.revisions.length} revisions, ${collected.votes.length} votes (${requestCount} requests)`);
    
    onComplete(); // 更新进度计数
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