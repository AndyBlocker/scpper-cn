// src/core/client/GraphQLClient.js
import { GraphQLClient as GQLClient } from 'graphql-request';
import { MAX_RETRY_ATTEMPTS } from '../../config/RateLimitConfig.js';
import { BackoffManager } from '../scheduler/BackoffManager.js';
import { Logger } from '../../utils/Logger.js';


export class GraphQLClient {
  constructor(endpoint = 'https://apiv2.crom.avn.sh/graphql') {
    this.client = new GQLClient(endpoint);
    this.backoff = new BackoffManager();
  }

  async request(query, variables) {
    for (let attempt = 1; attempt <= MAX_RETRY_ATTEMPTS; attempt++) {
      try {
        return await this.client.request(query, variables);
      } catch (err) {
        if (this._isRateLimited(err)) {
            const wait = this._getRetryAfter(err);
            await this.backoff.wait(wait);  // 使用新的带进度的等待方法
            continue;
        }
        console.log(err)
        if (attempt === MAX_RETRY_ATTEMPTS) throw err;
        
        Logger.warn(`Network error, retry #${attempt}`);
        await this.backoff.sleep(1000 * attempt);
        
      }
    }
  }

  _isRateLimited(err) {
    const h = err.response?.headers;
    return err.response?.status === 429 ||
           (h && (h['retry-after'] || (typeof h.get === 'function' && h.get('retry-after'))));
  }

  _getRetryAfter(err) {
    const h = err?.response?.headers;
    if (!h) return 60;
    
    // Handle different header object types
    if (typeof h.get === 'function') {
      return Number(h.get('retry-after') ?? 60);
    }
    if (typeof h['retry-after'] !== 'undefined') {
      return Number(h['retry-after']);
    }
    
    return 60;
  }
}
