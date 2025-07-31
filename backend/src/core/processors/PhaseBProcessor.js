// src/core/processors/PhaseBProcessor.js
import { buildAliasQuery } from '../graphql/AliasQueryBuilder.js';
import { PointEstimator } from '../graphql/PointEstimator.js';
import { GraphQLClient } from '../client/GraphQLClient.js';
import { DataStore } from '../store/DataStore.js';
import { Logger } from '../../utils/Logger.js';
import {
  SIMPLE_PAGE_THRESHOLD,
  BUCKET_SOFT_LIMIT
} from '../../config/RateLimitConfig.js';

let MAX_PACK_CNT = 10

export class PhaseBProcessor {
  constructor() {
    this.client = new GraphQLClient();
    this.store = new DataStore();
  }

  async run() {
    Logger.info('=== Phase B: Simple Page Data Collection ===');
    
    const pages = await this.store.loadProgress('phase1');
    const simple = pages.filter(p => (p.estimatedCost ?? 0) <= SIMPLE_PAGE_THRESHOLD);

    Logger.info(`Found ${simple.length} simple pages to process`);
    
    const startTime = Date.now();
    let processedPages = 0;
    let bucketCount = 0;

    // 分桶
    let bucket = [];
    let bucketCost = 0;
    let cnt = 0;
    for (const page of simple) {
      const c = page.estimatedCost ?? 100;
      if (bucketCost + c > BUCKET_SOFT_LIMIT && bucket.length > 0 || cnt == MAX_PACK_CNT) {
        bucketCount++;
        processedPages += await this._flush(bucket, bucketCount);
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
      processedPages += await this._flush(bucket, bucketCount);
    }

    const elapsedTime = (Date.now() - startTime) / 1000;
    const speed = elapsedTime > 0 ? (processedPages / elapsedTime).toFixed(1) + ' pages/s' : 'N/A';
    
    Logger.info(`Phase B completed: ${processedPages} pages processed in ${bucketCount} batches, ${elapsedTime.toFixed(1)}s (${speed})`);
  }

  async _flush(bucket, bucketNumber) {
    if (!bucket.length) return 0;
    
    const { query, variables } = buildAliasQuery(bucket);
    const cost = PointEstimator.estimateQueryCost(bucket);
    
    Logger.info(`Batch ${bucketNumber}: Processing ${bucket.length} pages (~${cost} pts)`);
    
    const res = await this.client.request(query, variables);
    
    // 处理结果并保存
    let savedCount = 0;
    Object.values(res).forEach(page => {
      if (page) {
        this.store.append('phase2', page);
        savedCount++;
      }
    });

    Logger.debug(`Batch ${bucketNumber}: Saved ${savedCount}/${bucket.length} pages`);
    
    return bucket.length;
  }
}