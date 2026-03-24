// src/core/client/GraphQLClient.js
import { GraphQLClient as GQLClient } from 'graphql-request';
import { MAX_RETRY_ATTEMPTS } from '../../config/RateLimitConfig.js';
import { BackoffManager } from '../scheduler/BackoffManager.js';
import { Logger } from '../../utils/Logger.js';

export class GraphQLClient {
  constructor(endpoint = 'https://apiv2.crom.avn.sh/graphql', options = {}) {
    this.client = new GQLClient(endpoint);
    this.backoff = new BackoffManager();
    const timeoutFromEnv = Number.parseInt(process.env.SCPPER_GRAPHQL_TIMEOUT_MS || '', 10);
    const timeoutFromOptions = Number(options.requestTimeoutMs);
    this.requestTimeoutMs = Number.isFinite(timeoutFromEnv) && timeoutFromEnv > 0
      ? timeoutFromEnv
      : (Number.isFinite(timeoutFromOptions) && timeoutFromOptions > 0
        ? timeoutFromOptions
        : 90_000);
  }

  async request(query, variables) {
    for (let attempt = 1; attempt <= MAX_RETRY_ATTEMPTS; attempt++) {
      const { signal, abort, clear } = this._createTimeoutSignal(this.requestTimeoutMs);
      try {
        const requestPromise = this.client.request({
          document: query,
          variables,
          signal
        });
        // Extra guard: ensure the await itself always settles even if fetch/abort hangs.
        return await this._withTimeout(requestPromise, this.requestTimeoutMs, () => {
          try {
            abort(new Error(`GraphQL request timed out after ${this.requestTimeoutMs}ms`));
          } catch {}
        });
      } catch (err) {
        const isTimeout = this._isTimeout(err);
        if (this._isRateLimited(err)) {
          const wait = this._getRetryAfter(err);
          await this.backoff.wait(wait);  // 使用新的带进度的等待方法
          continue;
        }
        if (isTimeout) {
          Logger.warn(`GraphQL request timeout after ${this.requestTimeoutMs}ms (attempt ${attempt}/${MAX_RETRY_ATTEMPTS})`);
        } else {
          Logger.error('GraphQL request error:', err);
        }
        if (attempt === MAX_RETRY_ATTEMPTS) throw err;
        
        Logger.warn(`Network error, retry #${attempt}`);
        await this.backoff.sleep(1000 * attempt);
        
      } finally {
        clear();
      }
    }
  }

  _createTimeoutSignal(timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(new Error(`GraphQL request timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
    return {
      signal: controller.signal,
      abort: (reason) => controller.abort(reason),
      clear: () => clearTimeout(timer)
    };
  }

  _withTimeout(promise, timeoutMs, onTimeout) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return promise;
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        try {
          if (typeof onTimeout === 'function') onTimeout();
        } catch {}
        reject(new Error(`GraphQL request timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      if (typeof timer.unref === 'function') {
        timer.unref();
      }

      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        }
      );
    });
  }

  _isTimeout(err) {
    if (!err) return false;
    const name = err.name || err?.cause?.name;
    if (name === 'AbortError' || name === 'TimeoutError') return true;
    const message = String(err.message || '');
    return /timed out|timeout|aborted/i.test(message);
  }

  _isRateLimited(err) {
    const h = err.response?.headers;
    return err.response?.status === 429 ||
           (h && (h['retry-after'] || (typeof h.get === 'function' && h.get('retry-after'))));
  }

  /**
   * 释放底层 HTTP 连接资源，防止 keep-alive 连接池泄漏。
   * 调用后此实例不应再发起请求。
   */
  destroy() {
    this.client = null;
    this.backoff = null;
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
