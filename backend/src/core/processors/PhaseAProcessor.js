// src/core/processors/PhaseAProcessor.js
import { GraphQLClient } from '../client/GraphQLClient.js';
import { CoreQueries } from '../graphql/CoreQueries.js';
import { PointEstimator } from '../graphql/PointEstimator.js';
import { DataStore } from '../store/DataStore.js';
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
    this.store = new DataStore();
  }

  async run() {
    Logger.info('=== Phase A: Basic Page Scanning ===');
    
    // 获取总页面数量
    Logger.info('Fetching total page count...');
    const totalResult = await this.client.request(TOTAL_QUERY);
    const total = totalResult.aggregatePages._count;
    Logger.info(`Total pages in database: ${total}`);
    
    // 获取已处理的页面
    const processed = new Set((await this.store.loadProgress('phase1')).map(p => p.url));
    Logger.info(`Previously processed pages: ${processed.size}`);
    
    let after = null;
    let processedCount = processed.size;
    const initialProcessed = processed.size;
    const startTime = Date.now();
    let batchCount = 0;
    let overall_processed = 0;
    
    while (true) {
      const vars = cq.buildPhaseAVariables({ first: PHASE_A_BATCHSIZE, after });
      const { query } = cq.buildQuery('phaseA', vars);

      const res = await this.client.request(query, vars);
      const edges = res.pages.edges;

      if (edges.length === 0) break;
      
      batchCount++;
      let newInBatch = 0;

      let tmp = 0;
      let cnt = 0;
      for (const { node } of edges) {
        cnt++;
        if (processed.has(node.url))
        {
          tmp += node.estimatedCost;
          continue;
        }
        // 估算完整采集 cost，使用更准确的参数
        const estCost = PointEstimator.estimatePageCost(
          node,
          { 
            revisionLimit: Math.max(node.revisionCount ?? 0, 20),
            voteLimit: Math.max(node.voteCount ?? 0, 20) 
          }
        );
        node.estimatedCost = estCost;
        tmp += estCost;
        await this.store.append('phase1', node);
        processed.add(node.url);
        processedCount++;
        newInBatch++;
      }
      overall_processed += cnt;
      // 每批次日志
      // Logger.info(tmp)
      // Logger.info(cnt)
      Logger.info(`Batch ${batchCount}: processed ${newInBatch} new pages (${overall_processed}/${total}), avg cost: ${(tmp / cnt).toFixed(2)} pts`);

      if (!res.pages.pageInfo.hasNextPage) break;
      after = res.pages.pageInfo.endCursor;
      // break
    }
    
    const elapsedTime = (Date.now() - startTime) / 1000;
    const newPagesProcessed = processedCount - initialProcessed;
    const speed = elapsedTime > 0 && newPagesProcessed > 0 ? 
      (newPagesProcessed / elapsedTime).toFixed(1) + ' pages/s' : 'N/A';
    
    Logger.info(`Phase A completed: ${processedCount} pages total, ${newPagesProcessed} new pages processed in ${elapsedTime.toFixed(1)}s (${speed})`);
  }
}