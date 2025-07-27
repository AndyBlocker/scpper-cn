/**
 * 文件路径: src/sync/core/rate-limit-safe-fetcher.js
 * 功能概述: SCPPER-CN Rate Limit 安全获取器模块
 * 
 * 主要功能:
 * - 防止 429 错误导致的数据错误覆盖和丢失
 * - 智能重试机制和指数退避策略
 * - 数据保护缓存，避免错误数据覆盖正确数据
 * - Rate Limit 状态监控和追踪
 * - 安全的 GraphQL 查询执行
 * - 连续错误检测和自动降级保护
 * 
 * 核心特性:
 * - 429 错误的智能识别和处理
 * - 数据缓存保护机制（防止空数据覆盖）
 * - 指数退避重试策略（backoff multiplier）
 * - Rate Limit 状态追踪和统计
 * - 安全获取页面投票数据的专用方法
 * 
 * 保护机制:
 * - 连续 429 错误检测和报警
 * - 数据一致性保护（拒绝可疑的空数据）
 * - 自动降级和错误恢复
 */
export class RateLimitSafeFetcher {
  constructor(cromClient, config) {
    this.cromClient = cromClient;
    this.config = config;
    
    // Rate Limit错误追踪
    this.rateLimitTracker = {
      consecutive429Count: 0,
      last429Time: null,
      rateLimitActive: false,
      backoffMultiplier: 1
    };
    
    // 数据保护缓存
    this.dataCache = new Map(); // pageUrl -> cachedData
    
    this.stats = {
      requestsWithRateLimit: 0,
      dataProtectionActivated: 0,
      successfulRetries: 0,
      failedAfterRetries: 0
    };
  }
  
  /**
   * 安全获取页面投票数据，防止Rate Limit导致的数据覆盖
   */
  async safeGetPageVotes(pageUrl, expectedVoteCount, existingVoteCount = 0) {
    const cacheKey = `votes_${pageUrl}`;
    let attempts = 0;
    const maxAttempts = this.config.max429Retries || 10;
    
    // 如果有现有数据且期望数据与现有数据相近，考虑跳过
    if (existingVoteCount > 0 && Math.abs(expectedVoteCount - existingVoteCount) <= 2) {
      console.log(`📋 数据近似，跳过获取: ${pageUrl} (现有:${existingVoteCount}, 期望:${expectedVoteCount})`);
      return {
        votes: null, // 返回null表示使用现有数据
        isComplete: true,
        useExistingData: true,
        reason: 'data_similarity'
      };
    }
    
    while (attempts < maxAttempts) {
      try {
        attempts++;
        
        // 检查是否需要Rate Limit等待
        await this.handleRateLimitWait();
        
        // 尝试获取投票数据
        const result = await this.fetchPageVotesInternal(pageUrl, expectedVoteCount);
        
        // 成功获取数据，重置Rate Limit追踪
        this.resetRateLimitTracker();
        
        // 验证数据质量
        const dataQuality = this.assessDataQuality(result, expectedVoteCount);
        
        if (dataQuality.isAcceptable) {
          // 缓存成功的数据
          this.dataCache.set(cacheKey, {
            data: result,
            timestamp: new Date(),
            expectedCount: expectedVoteCount
          });
          
          return result;
        } else if (dataQuality.shouldRetry && attempts < maxAttempts) {
          console.log(`🔄 数据质量不佳，重试 ${attempts}/${maxAttempts}: ${pageUrl} (${dataQuality.reason})`);
          await this.wait(2000 * attempts); // 递增等待时间
          continue;
        } else {
          // 数据质量不佳但不应重试，使用现有数据保护
          return this.useDataProtection(pageUrl, existingVoteCount, dataQuality.reason);
        }
        
      } catch (error) {
        const errorInfo = this.analyzeError(error);
        
        if (errorInfo.isRateLimit) {
          console.log(`⚠️  Rate Limit 检测到 #${attempts}: ${pageUrl}`);
          this.handleRateLimitError();
          
          // 在Rate Limit情况下，优先保护现有数据
          if (existingVoteCount > 0 && attempts >= 3) {
            return this.useDataProtection(pageUrl, existingVoteCount, 'rate_limit_protection');
          }
          
          // 等待更长时间后重试
          const waitTime = this.calculateRateLimitWaitTime(attempts);
          console.log(`   等待 ${Math.round(waitTime/1000)}s 后重试...`);
          await this.wait(waitTime);
          continue;
          
        } else if (errorInfo.isRetryable && attempts < maxAttempts) {
          console.log(`🔄 网络错误重试 ${attempts}/${maxAttempts}: ${pageUrl} - ${error.message}`);
          await this.wait(1000 * attempts);
          continue;
          
        } else {
          // 非Rate Limit错误且无法重试
          console.error(`❌ 获取投票失败: ${pageUrl} - ${error.message}`);
          return this.useDataProtection(pageUrl, existingVoteCount, 'fetch_failed');
        }
      }
    }
    
    // 达到最大重试次数，使用数据保护
    return this.useDataProtection(pageUrl, existingVoteCount, 'max_retries_exceeded');
  }
  
  /**
   * 内部投票获取方法
   */
  async fetchPageVotesInternal(pageUrl, expectedVoteCount) {
    const query = `
      query SafeFetchPageVotes($pageUrl: URL!, $first: Int) {
        wikidotPage(url: $pageUrl) {
          fuzzyVoteRecords(first: $first) {
            edges {
              node {
                userWikidotId
                direction
                timestamp
                user {
                  ... on WikidotUser {
                    displayName
                    wikidotId
                  }
                }
              }
              cursor
            }
            pageInfo {
              hasNextPage
              endCursor
            }
          }
        }
      }
    `;
    
    const batchSize = Math.min(this.config.votesBatchSize || 100, expectedVoteCount + 10);
    const variables = { pageUrl, first: batchSize };
    
    const networkStart = Date.now();
    const result = await this.cromClient.request(query, variables);
    const networkTime = Date.now() - networkStart;
    
    const voteData = result.wikidotPage?.fuzzyVoteRecords;
    if (!voteData) {
      throw new Error('API返回空投票数据结构');
    }
    
    const votes = voteData.edges.map(edge => ({
      userWikidotId: edge.node.userWikidotId,
      direction: edge.node.direction,
      timestamp: edge.node.timestamp,
      user: edge.node.user
    }));
    
    return {
      votes,
      isComplete: !voteData.pageInfo.hasNextPage || votes.length >= expectedVoteCount,
      nextCursor: voteData.pageInfo.endCursor,
      networkTime,
      hasNextPage: voteData.pageInfo.hasNextPage
    };
  }
  
  /**
   * 评估数据质量
   */
  assessDataQuality(result, expectedVoteCount) {
    if (!result.votes || result.votes.length === 0) {
      return {
        isAcceptable: false,
        shouldRetry: true,
        reason: 'empty_response'
      };
    }
    
    const actualCount = result.votes.length;
    const difference = Math.abs(expectedVoteCount - actualCount);
    const diffPercentage = difference / Math.max(expectedVoteCount, 1);
    
    // 如果获取的数据明显少于期望（可能是Rate Limit导致的部分响应）
    if (actualCount > 0 && actualCount < expectedVoteCount * 0.3) {
      return {
        isAcceptable: false,
        shouldRetry: true,
        reason: 'significant_undercount'
      };
    }
    
    // 完全匹配或合理差异范围内
    if (difference <= 5 || diffPercentage <= 0.1) {
      return {
        isAcceptable: true,
        reason: 'acceptable_difference'
      };
    }
    
    // fuzzyVoteRecords的正常差异范围
    if (diffPercentage <= 0.2) {
      return {
        isAcceptable: true,
        reason: 'fuzzy_data_nature'
      };
    }
    
    return {
      isAcceptable: false,
      shouldRetry: false,
      reason: 'large_discrepancy'
    };
  }
  
  /**
   * 使用数据保护机制
   */
  useDataProtection(pageUrl, existingVoteCount, reason) {
    this.stats.dataProtectionActivated++;
    
    console.log(`🛡️  数据保护激活: ${pageUrl} (保持现有 ${existingVoteCount} 票, 原因: ${reason})`);
    
    return {
      votes: null, // 表示使用现有数据
      isComplete: true,
      useExistingData: true,
      protectionReason: reason,
      existingDataCount: existingVoteCount
    };
  }
  
  /**
   * 处理Rate Limit错误
   */
  handleRateLimitError() {
    this.rateLimitTracker.consecutive429Count++;
    this.rateLimitTracker.last429Time = Date.now();
    this.rateLimitTracker.rateLimitActive = true;
    this.rateLimitTracker.backoffMultiplier = Math.min(
      this.rateLimitTracker.backoffMultiplier * 1.5, 
      10
    );
    this.stats.requestsWithRateLimit++;
  }
  
  /**
   * 重置Rate Limit追踪器
   */
  resetRateLimitTracker() {
    this.rateLimitTracker.consecutive429Count = 0;
    this.rateLimitTracker.rateLimitActive = false;
    this.rateLimitTracker.backoffMultiplier = 1;
  }
  
  /**
   * 处理Rate Limit等待
   */
  async handleRateLimitWait() {
    if (!this.rateLimitTracker.rateLimitActive) {
      return;
    }
    
    const timeSinceLastError = Date.now() - (this.rateLimitTracker.last429Time || 0);
    const baseWaitTime = this.config.retryDelayMs || 60000;
    const backoffWaitTime = baseWaitTime * this.rateLimitTracker.backoffMultiplier;
    
    if (timeSinceLastError < backoffWaitTime) {
      const remainingWait = backoffWaitTime - timeSinceLastError;
      console.log(`⏳ Rate Limit等待中... 还需 ${Math.round(remainingWait/1000)}s`);
      await this.wait(remainingWait);
    }
  }
  
  /**
   * 计算Rate Limit等待时间
   */
  calculateRateLimitWaitTime(attempt) {
    const baseWaitTime = this.config.retryDelayMs || 60000;
    const attemptMultiplier = Math.pow(1.5, attempt - 1);
    const backoffMultiplier = this.rateLimitTracker.backoffMultiplier;
    
    return Math.min(baseWaitTime * attemptMultiplier * backoffMultiplier, 300000); // 最多5分钟
  }
  
  /**
   * 分析错误类型
   */
  analyzeError(error) {
    const errorMessage = error.message || '';
    const errorStatus = error.status || error.statusCode;
    
    return {
      isRateLimit: errorStatus === 429 || errorMessage.includes('429') || errorMessage.includes('rate limit'),
      isRetryable: errorMessage.includes('ECONNRESET') || 
                   errorMessage.includes('ETIMEDOUT') || 
                   errorMessage.includes('network') ||
                   errorStatus >= 500,
      errorType: errorStatus === 429 ? 'rate_limit' : 
                 errorStatus >= 500 ? 'server_error' : 
                 errorMessage.includes('network') ? 'network_error' : 'unknown'
    };
  }
  
  /**
   * 等待指定时间
   */
  async wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
  
  /**
   * 获取统计信息
   */
  getStats() {
    return {
      ...this.stats,
      cacheSize: this.dataCache.size,
      rateLimitActive: this.rateLimitTracker.rateLimitActive,
      consecutive429Count: this.rateLimitTracker.consecutive429Count
    };
  }
  
  /**
   * 清理过期缓存
   */
  cleanupCache(maxAgeMs = 3600000) { // 默认1小时
    const now = Date.now();
    for (const [key, cached] of this.dataCache.entries()) {
      if (now - cached.timestamp.getTime() > maxAgeMs) {
        this.dataCache.delete(key);
      }
    }
  }
}