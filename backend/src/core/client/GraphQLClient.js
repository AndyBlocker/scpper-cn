// src/core/client/GraphQLClient.js
import { GraphQLClient as GQLClient } from 'graphql-request';
import { MAX_RETRY_ATTEMPTS } from '../../config/RateLimitConfig.js';
import { BackoffManager } from '../scheduler/BackoffManager.js';
import { Logger } from '../../utils/Logger.js';
import { Progress } from '../../utils/Progress.js';


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
    // console.log(err.response.headers)
    return err.response?.status === 429 ||
           (err.response?.headers && 'retry-after' in err.response.headers);
  }

  _getRetryAfter(err) {
    return Number(err.response?.headers?.get('retry-after') ?? 60);
  }
}
