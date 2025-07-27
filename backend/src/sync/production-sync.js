/**
 * 文件路径: src/sync/production-sync.js
 * 功能概述: SCPPER-CN 生产环境数据同步核心模块
 * 
 * 主要功能:
 * - 从 CROM GraphQL API v2 获取完整的生产环境数据
 * - 支持页面数据、投票记录、用户信息、修订历史的全量同步
 * - 基于复杂度限制和权限分析的优化同步策略
 * - 断点续传机制，支持大规模数据同步中断恢复
 * - Rate Limit 管理和错误处理
 * - 数据导出和JSON文件生成
 * 
 * 使用方式:
 * - npm run sync 或 node src/sync/production-sync.js
 * - 支持命令行参数: --votes, --vote-only 等
 */

import { GraphQLClient } from 'graphql-request';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { RateLimitSafeFetcher } from './core/rate-limit-safe-fetcher.js';

dotenv.config();
class ProductionSync {
  constructor(options = {}) {
    this.cromClient = new GraphQLClient('https://apiv2.crom.avn.sh/graphql');
    
    this.dataDir = './production-data';
    this.checkpointDir = './production-checkpoints';
    
    // 确保目录存在
    [this.dataDir, this.checkpointDir].forEach(dir => {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    });
    
    this.stats = {
      startTime: null,
      endTime: null,
      actualSyncStartTime: null, // 实际网络同步开始时间（排除checkpoint加载）
      pagesProcessed: 0,
      actualPagesProcessed: 0,   // 实际从网络同步的页面数（不包括checkpoint）
      votesProcessed: 0,
      usersProcessed: 0,
      batchesCompleted: 0,
      errors: [],
      requestTimes: []
    };
    
    // 基于300,000点/5分钟的保守配置 - 支持增量更新
    this.config = {
      pagesBatchSize: 10,    // 基础查询可以用更大的批次
      votesBatchSize: 100,   // 设置为100如用户建议
      maxRequestsPerSecond: 4,    // 进一步降低请求频率以适应更大的投票批次
      targetPages: null,     // 自动检测所有CN分支页面（基于API分页）
      checkpointInterval: 1000, // 更频繁的检查点，防止丢失进度
      maxRetries: 15,         // 增加重试次数以处理网络错误
      retryDelayMs: 60000,    // 429错误后等待60秒（进一步延长等待时间）
      networkRetryDelayMs: 8000, // 网络错误后等待8秒
      max429Retries: 50,      // 专门处理429错误的重试次数
      // 运行模式配置
      voteOnlyMode: options.voteOnly || false,    // 仅获取投票数据模式，不同步页面数据
      // 全量投票数据配置
      getCompleteVoteRecords: true,  // 获取完整投票记录
      maxVotePagesPerRequest: 200,   // 每200页进行一次投票记录检查点保存（降低间隔以更频繁保存）
      // 增量更新配置
      enableIncrementalUpdate: true, // 启用增量更新
      voteDataRetentionDays: 30,     // 30天保留期，用于增量更新优化
      rateLimitPoints: 300000,       // 5分钟内可用点数
      rateLimitWindowMs: 5 * 60 * 1000 // 5分钟窗口
    };
    
    this.data = {
      pages: [],
      voteRecords: [],
      users: [],
      attributions: [],
      revisions: [],
      alternateTitles: []
    };
    
    this.userCache = new Set(); // 缓存已处理的用户ID
    
    // 投票记录断点续传状态
    this.voteProgress = {
      completedPages: new Set(), // 已完成投票获取的页面URL
      partialPages: new Map(),   // 部分完成的页面：URL -> {cursor, votesCollected}
      totalVotesExpected: 0,     // 预期投票总数
      totalVotesCollected: 0     // 已收集投票数
    };
    
    // 增量更新状态
    this.incrementalData = {
      lastSyncTimestamp: null,   // 上次同步时间戳
      pageVoteTimestamps: new Map(), // 页面URL -> 最新投票时间戳
      existingVotes: new Map(),      // 页面URL -> 已有投票记录的Set(userWikidotId-timestamp)
      newVotesOnly: false,           // 是否只获取新投票
      // 智能投票更新状态
      pageVoteStates: new Map()      // 页面URL -> {voteCount, rating, firstVoteId, lastUpdated}
    };
    
    // 进度显示状态
    this.progressState = {
      totalPages: null,           // 总页面数（预先获取）
      isWaitingRateLimit: false,  // 是否正在等待rate limit
      lastProgressUpdate: 0,      // 上次进度更新时间
      progressUpdateInterval: 1000, // 进度更新间隔（毫秒）
      // 时间预估相关
      speedHistory: [],           // 最近的速度记录
      maxSpeedHistory: 10         // 保留最近10次速度记录用于预估
    };

    // 网络耗时追踪
    this.lastNetworkTime = 0;
    
    // Rate Limit追踪 - 基于5分钟滑动窗口
    this.rateLimitTracker = {
      requestHistory: [],  // {timestamp, points, operation} 的数组
      windowSizeMs: 5 * 60 * 1000, // 5分钟窗口
      maxPoints: 300000,   // 5分钟内最大点数
      currentWindowStart: Date.now(),
      isWaiting: false,
      waitingReason: null, // 'rate_limit', 'network_error', 'other'
      waitStartTime: null,
      estimatedWaitEndTime: null,
      // 新增：空响应检测
      emptyResponseCount: 0,       // 连续空响应计数
      consecutiveEmptyThreshold: 3, // 连续空响应阈值
      adaptiveDelayMs: 1000,       // 自适应延迟
      maxAdaptiveDelayMs: 30000    // 最大自适应延迟
    };
  }

  resetRateLimitTracker() {
    this.rateLimitTracker = {
      requestHistory: [],
      windowSizeMs: 5 * 60 * 1000,
      maxPoints: 300000,
      currentWindowStart: Date.now(),
      isWaiting: false,
      waitingReason: null,
      waitStartTime: null,
      estimatedWaitEndTime: null,
      emptyResponseCount: 0,
      consecutiveEmptyThreshold: 3,
      adaptiveDelayMs: 1000,
      maxAdaptiveDelayMs: 30000
    };
    console.log('🔄 Rate limit追踪器已重置');
  }

  async loadHistoricalData() {
    if (!this.config.enableIncrementalUpdate) {
      console.log('📋 增量更新已禁用，将进行全量同步');
      return;
    }

    console.log('📥 检查历史数据文件...');
    
    try {
      // 查找最新的数据文件
      const files = fs.readdirSync(this.dataDir);
      const dataFiles = files
        .filter(f => f.startsWith('production-data-') && f.endsWith('.json'))
        .sort()
        .reverse();

      if (dataFiles.length === 0) {
        console.log('📋 未找到历史数据，将进行全量同步');
        return;
      }

      const latestFile = dataFiles[0];
      const historicalData = JSON.parse(
        fs.readFileSync(path.join(this.dataDir, latestFile), 'utf8')
      );

      if (historicalData.voteRecords && historicalData.voteRecords.length > 0) {
        console.log(`✅ 已加载历史数据: ${latestFile}`);
        console.log(`   历史投票记录: ${historicalData.voteRecords?.length || 0}`);
        console.log(`   历史修订记录: ${historicalData.revisions?.length || 0}`);
        console.log(`   历史备用标题: ${historicalData.alternateTitles?.length || 0}`);
        
        // 构建增量更新索引
        this.incrementalData.lastSyncTimestamp = new Date(historicalData.metadata?.timestamp || '2022-05-01');
        
        // 为每个页面建立最新投票时间戳索引
        historicalData.voteRecords.forEach(vote => {
          const pageUrl = vote.pageUrl;
          const voteTimestamp = new Date(vote.timestamp);
          
          // 更新页面最新投票时间戳
          if (!this.incrementalData.pageVoteTimestamps.has(pageUrl) || 
              voteTimestamp > this.incrementalData.pageVoteTimestamps.get(pageUrl)) {
            this.incrementalData.pageVoteTimestamps.set(pageUrl, voteTimestamp);
          }
          
          // 建立已有投票记录索引
          if (!this.incrementalData.existingVotes.has(pageUrl)) {
            this.incrementalData.existingVotes.set(pageUrl, new Set());
          }
          const voteKey = `${vote.voterWikidotId}-${vote.timestamp}`;
          this.incrementalData.existingVotes.get(pageUrl).add(voteKey);
        });
        
        // 构建页面投票状态索引（用于智能更新判断）
        if (historicalData.pages && historicalData.pages.length > 0) {
          historicalData.pages.forEach(page => {
            if (page.voteCount > 0) {
              // 获取该页面最新投票的ID（用于变化检测）
              const pageVotes = historicalData.voteRecords?.filter(v => v.pageUrl === page.url);
              const firstVoteId = pageVotes && pageVotes.length > 0 ? 
                pageVotes.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))[0].voterWikidotId : null;
              
              this.incrementalData.pageVoteStates.set(page.url, {
                voteCount: page.voteCount,
                rating: page.rating,
                firstVoteId: firstVoteId,
                lastUpdated: historicalData.metadata?.timestamp || new Date().toISOString()
              });
            }
          });
        }
        
        this.incrementalData.newVotesOnly = true;
        console.log(`✅ 增量更新已启用，上次同步: ${this.incrementalData.lastSyncTimestamp.toLocaleString()}`);
        console.log(`   已索引页面投票: ${this.incrementalData.pageVoteTimestamps.size}`);
        console.log(`   已索引页面状态: ${this.incrementalData.pageVoteStates.size}`);
        
      } else {
        console.log('📋 历史数据中无投票记录，将进行全量同步');
      }
      
    } catch (error) {
      console.log(`⚠️  加载历史数据失败: ${error.message}，将进行全量同步`);
      this.incrementalData.newVotesOnly = false;
    }
  }

  async fetchTotalPageCount() {
    console.log('📊 预先获取总页面数...');
    
    try {
      // 尝试使用aggregatePages获取总数
      const query = `
        query GetTotalPageCount($filter: PageQueryFilter) {
          aggregatePages(filter: $filter) {
            _count
          }
        }
      `;
      
      const variables = {
        filter: {
          onWikidotPage: {
            url: { startsWith: "http://scp-wiki-cn.wikidot.com" }
          }
        }
      };
      
      const result = await this.cromClient.request(query, variables);
      this.progressState.totalPages = result.aggregatePages._count;
      
      console.log(`🎯 检测到总页面数: ${this.progressState.totalPages.toLocaleString()}`);
      console.log('');
      
    } catch (error) {
      console.log(`⚠️  无法获取总页面数，将使用动态进度显示: ${error.message.substring(0, 100)}`);
      this.progressState.totalPages = null;
    }
  }

  async runProductionSync() {
    console.log('🚀 SCPPER-CN 生产环境数据同步');
    console.log('='.repeat(80));
    console.log(`📅 开始时间: ${new Date().toLocaleString()}`);
    console.log(`📦 页面批次: ${this.config.pagesBatchSize}, 投票批次: ${this.config.votesBatchSize}`);
    console.log(`⚡ 请求频率: ${this.config.maxRequestsPerSecond}/秒`);
    
    if (this.config.voteOnlyMode) {
      console.log('🗳️  运行模式: 仅获取投票数据');
    }
    console.log('');
    
    this.stats.startTime = new Date();
    
    try {
      if (this.config.voteOnlyMode) {
        // 仅获取投票数据模式
        await this.runVoteOnlySync();
      } else {
        // 完整同步模式
        await this.runFullSync();
      }
      
    } catch (error) {
      console.error(`❌ 同步过程发生错误: ${error.message}`);
      this.stats.errors.push({
        type: 'fatal_error',
        error: error.message,
        timestamp: new Date()
      });
      
      // 保存已获取的数据
      if (this.data.pages.length > 0) {
        await this.saveCurrentData('emergency');
      }
    }
  }

  async runFullSync() {
    // -1. 预先获取总页面数（用于进度条）
    await this.fetchTotalPageCount();
    
    // 0. 检查并加载历史数据（用于增量更新）
    await this.loadHistoricalData();
    
    // 1. 第一阶段：同步页面基础数据
    await this.syncPagesBasicData();
    
    // 1.5. 加载投票进度检查点（如果存在）
    await this.loadVoteProgressCheckpoint();
    
    // 2. 第二阶段：同步投票数据（支持增量更新）
    await this.syncVoteData();
    
    // 3. 第三阶段：汇总用户数据（无需额外查询）
    await this.consolidateUserData();
    
    // 4. 生成最终报告和分析
    await this.generateProductionReport();
  }

  async runVoteOnlySync() {
    console.log('🗳️  仅获取投票数据模式');
    console.log('='.repeat(50));
    
    // 1. 加载现有页面数据
    await this.loadExistingPageData();
    
    // 2. 获取所有页面的投票数据
    await this.syncVoteDataForExistingPages();
    
    // 3. 汇总用户数据
    await this.consolidateUserData();
    
    // 4. 生成报告
    await this.generateVoteOnlyReport();
  }

  async syncPagesBasicData() {
    console.log('📄 第一阶段：同步页面基础数据...');
    
    let cursor = null;
    let totalProcessed = 0;
    
    // 尝试加载页面同步检查点
    const checkpoint = await this.loadPageCheckpoint();
    if (checkpoint) {
      console.log(`📥 发现页面检查点，从第 ${checkpoint.totalProcessed} 页继续...`);
      this.data.pages = checkpoint.pages || [];
      this.data.revisions = checkpoint.revisions || [];
      this.data.attributions = checkpoint.attributions || [];
      this.data.alternateTitles = checkpoint.alternateTitles || [];
      totalProcessed = checkpoint.totalProcessed || 0;
      this.stats.pagesProcessed = totalProcessed;
      
      // 直接使用保存的cursor，无需重新计算
      cursor = checkpoint.cursor;
      
      if (cursor) {
        console.log(`✅ 已恢复cursor，将从断点继续同步`);
        // 重置rate limit追踪器，因为从检查点恢复意味着之前的请求历史已过期
        this.resetRateLimitTracker();
        // 设置实际同步开始时间为现在（而不是程序启动时间）
        this.stats.actualSyncStartTime = Date.now();
        this.stats.actualPagesProcessed = 0; // 重置实际同步页面计数
      } else {
        console.log(`⚠️  检查点中没有cursor信息，页面同步可能已完成`);
        // 检查是否接近总页面数
        if (this.progressState.totalPages && totalProcessed >= this.progressState.totalPages - 10) {
          console.log(`✅ 页面同步已基本完成 (${totalProcessed}/${this.progressState.totalPages})`);
          // 直接结束页面同步阶段，进入投票同步
          this.stats.actualSyncStartTime = Date.now();
          return;
        }
        
        // 否则从头开始
        console.log(`🔄 从头开始页面同步`);
        this.data.pages = [];
        this.data.revisions = [];
        this.data.attributions = [];
        this.data.alternateTitles = [];
        totalProcessed = 0;
        this.stats.pagesProcessed = 0;
        this.stats.actualSyncStartTime = Date.now();
        this.stats.actualPagesProcessed = 0;
        this.resetRateLimitTracker();
      }
    }
    
    // 如果没有checkpoint，设置实际同步开始时间
    if (!this.stats.actualSyncStartTime) {
      this.stats.actualSyncStartTime = Date.now();
    }
    
    while (true) {
      let batchRetries = 0;
      let batchSuccess = false;
      
      // 重试当前批次直到成功或达到最大重试次数
      while (!batchSuccess && batchRetries < this.config.maxRetries) {
        try {
          
          const startTime = Date.now();
          const result = await this.fetchPagesBasic(cursor, this.config.pagesBatchSize);
          const requestTime = Date.now() - startTime;
          
          this.stats.requestTimes.push(requestTime);
          
          // 成功请求后清理429错误计数
          this.clearConsecutive429Errors('pages_basic');
          
          if (!result || !result.pages.edges.length) {
            console.log('\n✅ 没有更多页面可处理');
            // 保存最终的检查点
            await this.savePageCheckpoint(totalProcessed, cursor);
            
            // 验证页面数量完整性
            if (this.progressState.totalPages && totalProcessed < this.progressState.totalPages) {
              const missing = this.progressState.totalPages - totalProcessed;
              console.log(`⚠️  页面数量差异: ${missing} 页 (${totalProcessed}/${this.progressState.totalPages})`);
              console.log('   这通常是API统计的小误差，不影响数据完整性');
            }
            
            return; // 结束整个函数
          }
          
          // 检测空响应或数据异常
          const hasValidData = this.detectEmptyResponse(result, 'pages');
          if (!hasValidData) {
            throw new Error('检测到空响应或数据异常，可能是API限流');
          }
          
          // 处理页面基础数据
          for (const edge of result.pages.edges) {
            this.processPageBasic(edge.node);
            cursor = edge.cursor;
            totalProcessed++;
            this.stats.actualPagesProcessed++; // 增加实际同步页面计数
          }
          
          this.stats.batchesCompleted++;
          this.stats.pagesProcessed = totalProcessed;
          
          // 智能进度显示（避免刷屏）
          this.updateProgress(totalProcessed);
          
          // 定期保存检查点
          if (totalProcessed % this.config.checkpointInterval === 0) {
            await this.savePageCheckpoint(totalProcessed, cursor);
          }
          
          // 检查是否有下一页
          if (!result.pages.pageInfo.hasNextPage) {
            console.log('\n✅ 已处理所有可用页面');
            // 保存最终的检查点
            await this.savePageCheckpoint(totalProcessed, cursor);
            
            // 验证页面数量完整性
            if (this.progressState.totalPages && totalProcessed < this.progressState.totalPages) {
              const missing = this.progressState.totalPages - totalProcessed;
              console.log(`⚠️  检测到缺失页面: ${missing} 页 (${totalProcessed}/${this.progressState.totalPages})`);
              
              if (missing <= 20) { // 如果缺失页面不多，尝试使用不同的方法获取
                console.log('🔄 尝试获取剩余页面...');
                await this.fetchRemainingPages(totalProcessed);
              } else {
                console.log('   缺失页面较多，可能是API总数统计不准确');
              }
            }
            
            return; // 结束整个函数
          }
          
          batchSuccess = true; // 当前批次成功
          
          // 添加基础请求间隔控制
          const delayMs = 1000 / this.config.maxRequestsPerSecond;
          await this.sleep(delayMs);
          
        } catch (error) {
          batchRetries++;
          
          // 使用简化的错误处理，避免输出大量调试信息
          await this.handleBatchError(error, 'pages_basic', batchRetries);
          
          if (batchRetries >= this.config.maxRetries) {
            throw new Error(`页面批次重试${this.config.maxRetries}次后仍失败，停止同步`);
          }
        }
      }
    }
    
    console.log(`\n✅ 页面基础数据同步完成! 总计 ${totalProcessed} 页面`);
  }

  async fetchPagesBasic(cursor, batchSize) {
    // 第一阶段：获取基础页面数据（低复杂度）
    const basicQuery = `
      query FetchPagesBasic($filter: PageQueryFilter, $first: Int, $after: ID) {
        pages(filter: $filter, first: $first, after: $after) {
          edges {
            node {
              url
              ... on WikidotPage {
                wikidotId
                title
                rating
                voteCount
                category
                tags
                createdAt
                revisionCount
                commentCount
                isHidden
                isUserPage
                thumbnailUrl
                source
                textContent
                
                createdBy {
                  ... on WikidotUser {
                    displayName
                    wikidotId
                  }
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
    `;
    
    const variables = {
      filter: {
        onWikidotPage: {
          url: { startsWith: "http://scp-wiki-cn.wikidot.com" }
        }
      },
      first: batchSize
    };
    
    if (cursor) {
      variables.after = cursor;
    }
    
    const basicResult = await this.cromClient.request(basicQuery, variables);
    
    // 第二阶段：为每个页面获取复杂数据（revisions, attributions, alternateTitles）
    if (basicResult?.pages?.edges) {
      await this.enrichPagesWithComplexData(basicResult.pages.edges);
    }
    
    return basicResult;
  }

  /**
   * 为页面补充复杂数据（revisions, attributions, alternateTitles）
   */
  async enrichPagesWithComplexData(pageEdges) {
    console.log(`   🔍 补充 ${pageEdges.length} 个页面的复杂数据...`);
    
    let successCount = 0;
    let errorCount = 0;
    
    for (const edge of pageEdges) {
      const page = edge.node;
      if (!page.url) continue;
      
      try {
        await this.fetchAndMergeComplexPageData(page);
        successCount++;
        
        // 避免过于频繁的请求
        await this.sleep(100);
        
      } catch (error) {
        errorCount++;
        console.log(`   ⚠️  页面 ${page.url} 复杂数据获取失败: ${error.message}`);
        
        // 记录错误但不中断整个流程
        this.stats.errors.push({
          type: 'complex_data_fetch_failed',
          error: error.message,
          url: page.url,
          phase: 'enrich_complex_data',
          timestamp: new Date()
        });
        
        // 根据错误类型采取不同的等待策略
        if (error.message.includes('API_NULL_RESPONSE')) {
          console.log(`   ⏳ API返回null，等待60秒后继续...`);
          await this.sleep(60000);
        } else if (error.message.includes('RATE_LIMIT') || error.message.includes('429')) {
          console.log(`   ⏳ Rate Limit达到，等待90秒后继续...`);
          await this.sleep(90000);
        } else if (error.message.includes('NETWORK_ERROR')) {
          console.log(`   ⏳ 网络错误，等待15秒后继续...`);
          await this.sleep(15000);
        } else if (error.message.includes('maximum per-request complexity')) {
          console.log(`   ⏳ 复杂度超限，等待5秒后继续...`);
          await this.sleep(5000);
        } else {
          console.log(`   ⏳ 其他错误，等待30秒后继续...`);
          await this.sleep(30000);
        }
      }
    }
    
    console.log(`   ✅ 复杂数据补充完成: 成功 ${successCount}，失败 ${errorCount}/${pageEdges.length}`);
  }

  /**
   * 获取单个页面的复杂数据
   */
  async fetchAndMergeComplexPageData(page) {
    const complexQuery = `
      query FetchComplexPageData($url: URL!) {
        wikidotPage(url: $url) {
          alternateTitles {
            title
          }
          
          attributions {
            type
            user {
              displayName
              ... on UserWikidotNameReference {
                wikidotUser {
                  displayName
                  wikidotId
                }
              }
            }
            date
            order
          }
          
          revisions(first: 50) {
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
          }
        }
      }
    `;

    try {
      const complexResult = await this.cromClient.request(complexQuery, { url: page.url });
      
      if (complexResult?.wikidotPage) {
        // 将复杂数据合并到原页面对象中
        const complexData = complexResult.wikidotPage;
        
        if (complexData.alternateTitles) {
          page.alternateTitles = complexData.alternateTitles;
        }
        
        if (complexData.attributions) {
          page.attributions = complexData.attributions;
        }
        
        if (complexData.revisions) {
          page.revisions = complexData.revisions;
        }
      }
      
    } catch (error) {
      // 处理不同类型的错误响应
      
      // 1. 处理null响应（通常是Rate Limit导致）
      if (error.response?.data === null) {
        console.log(`   🔄 页面 ${page.url} API返回null - Rate Limit或服务暂时不可用`);
        throw new Error(`API_NULL_RESPONSE: ${page.url}`);
      }
      
      // 2. 处理GraphQL复杂度超限
      if (error.message.includes('maximum per-request complexity')) {
        console.log(`   ⚠️  页面 ${page.url} 查询复杂度超限，尝试简化查询`);
        return await this.fetchSimplifiedComplexData(page);
      }
      
      // 3. 处理429 Rate Limit错误
      if (error.message.includes('429') || error.response?.status === 429) {
        console.log(`   🔄 页面 ${page.url} Rate Limit达到，需要等待`);
        throw new Error(`RATE_LIMIT: ${page.url}`);
      }
      
      // 4. 处理网络错误
      if (error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT' || 
          error.message.includes('network') || error.message.includes('timeout')) {
        console.log(`   🌐 页面 ${page.url} 网络错误: ${error.message}`);
        throw new Error(`NETWORK_ERROR: ${page.url}`);
      }
      
      // 5. 其他错误
      console.log(`   ❌ 页面 ${page.url} 未知错误: ${error.message}`);
      throw error;
    }
  }

  /**
   * 获取简化的复杂数据（当复杂度超限时使用）
   */
  async fetchSimplifiedComplexData(page) {
    console.log(`   🔄 使用简化查询获取页面 ${page.url} 的数据`);
    
    // 分别获取每种数据类型，降低单次查询复杂度
    try {
      // 1. 获取备用标题
      const altTitlesQuery = `
        query FetchAlternateTitles($url: URL!) {
          wikidotPage(url: $url) {
            alternateTitles {
              title
            }
          }
        }
      `;
      
      try {
        const altTitlesResult = await this.cromClient.request(altTitlesQuery, { url: page.url });
        if (altTitlesResult?.wikidotPage?.alternateTitles) {
          page.alternateTitles = altTitlesResult.wikidotPage.alternateTitles;
        }
        await this.sleep(200);
      } catch (error) {
        console.log(`     ⚠️  备用标题获取失败: ${error.message}`);
      }

      // 2. 获取合著信息
      const attributionsQuery = `
        query FetchAttributions($url: URL!) {
          wikidotPage(url: $url) {
            attributions {
              type
              user {
                displayName
                ... on UserWikidotNameReference {
                  wikidotUser {
                    displayName
                    wikidotId
                  }
                }
              }
              date
              order
            }
          }
        }
      `;
      
      try {
        const attributionsResult = await this.cromClient.request(attributionsQuery, { url: page.url });
        if (attributionsResult?.wikidotPage?.attributions) {
          page.attributions = attributionsResult.wikidotPage.attributions;
        }
        await this.sleep(200);
      } catch (error) {
        console.log(`     ⚠️  合著信息获取失败: ${error.message}`);
      }

      // 3. 获取修订历史（减少数量）
      const revisionsQuery = `
        query FetchRevisions($url: URL!) {
          wikidotPage(url: $url) {
            revisions(first: 20) {
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
            }
          }
        }
      `;
      
      try {
        const revisionsResult = await this.cromClient.request(revisionsQuery, { url: page.url });
        if (revisionsResult?.wikidotPage?.revisions) {
          page.revisions = revisionsResult.wikidotPage.revisions;
        }
        await this.sleep(200);
      } catch (error) {
        console.log(`     ⚠️  修订历史获取失败: ${error.message}`);
      }

    } catch (error) {
      console.log(`   ❌ 简化查询也失败: ${error.message}`);
      throw error;
    }
  }

  updateProgress(currentCount, context = 'pages') {
    const now = Date.now();
    
    // 限制进度更新频率，避免刷屏
    if (now - this.progressState.lastProgressUpdate < this.progressState.progressUpdateInterval) {
      return;
    }
    
    this.progressState.lastProgressUpdate = now;
    
    // 使用实际同步进度计算速度，避免checkpoint数据影响ETA
    const actualElapsed = (now - this.stats.actualSyncStartTime) / 1000;
    const speed = actualElapsed > 0 ? this.stats.actualPagesProcessed / actualElapsed : 0;
    const avgResponseTime = this.stats.requestTimes.slice(-5).reduce((a, b) => a + b, 0) / Math.min(5, this.stats.requestTimes.length) || 0;
    
    // 更新速度历史用于时间预估
    this.progressState.speedHistory.push(speed);
    if (this.progressState.speedHistory.length > this.progressState.maxSpeedHistory) {
      this.progressState.speedHistory.shift();
    }
    
    let progressText = '';
    let etaText = '';
    
    // 计算已用时间（使用实际同步开始时间，排除checkpoint加载时间）
    const syncStartTime = this.stats.actualSyncStartTime || this.stats.startTime;
    const elapsedSeconds = (now - syncStartTime) / 1000;
    const elapsedText = ` | 已用: ${this.formatDuration(elapsedSeconds)}`;
    
    if (this.progressState.totalPages && context === 'pages') {
      // 有总数时显示百分比进度条和预计时间
      const percentage = (currentCount / this.progressState.totalPages * 100);
      const progressBar = this.generateProgressBar(percentage);
      progressText = `📊 ${progressBar} ${percentage.toFixed(1)}% (${currentCount.toLocaleString()}/${this.progressState.totalPages.toLocaleString()})`;
      
      // 简化ETA计算：使用当前实际速度和剩余页面数
      const remaining = this.progressState.totalPages - currentCount;
      const actualElapsed = (now - this.stats.actualSyncStartTime) / 1000;
      
      // 需要足够的数据和时间才能给出可靠的ETA估算  
      const hasEnoughData = this.stats.actualPagesProcessed >= 10 && actualElapsed >= 30;
      
      if (this.stats.actualPagesProcessed > 0 && remaining > 0 && hasEnoughData) {
        // 直接基于这次同步的实际速度计算ETA
        const currentSpeed = this.stats.actualPagesProcessed / actualElapsed;
        let etaSeconds = remaining / currentSpeed;
        
        // 考虑错误率对时间的影响
        const totalErrors = this.stats.errors.length;
        const errorRate = totalErrors / Math.max(currentCount, 1);
        
        if (errorRate > 0.1) { // 如果错误率超过10%
          // 根据错误类型调整ETA
          const rateLimitErrors = this.stats.errors.filter(e => e.is429).length;
          const networkErrors = this.stats.errors.filter(e => 
            !e.is429 && (e.error.includes('ECONNRESET') || e.error.includes('network'))
          ).length;
          
          // 估算额外的等待时间
          const avgRateLimitDelay = (rateLimitErrors * this.config.retryDelayMs) / 1000;
          const avgNetworkDelay = (networkErrors * this.config.networkRetryDelayMs) / 1000;
          const extraDelay = (avgRateLimitDelay + avgNetworkDelay) / Math.max(currentCount, 1);
          
          // 将额外延迟应用到剩余时间
          etaSeconds = etaSeconds * (1 + errorRate) + (remaining * extraDelay);
        }
        
        etaText = ` | ETA: ${this.formatDuration(etaSeconds)}`;
        
        // 如果有很多错误，添加不确定性提示
        if (errorRate > 0.2) {
          etaText += ' (±误差较大)';
        }
      }
    } else {
      // 无总数时显示简单计数
      progressText = `📊 ${context === 'pages' ? '页面' : '投票'}进度: ${currentCount.toLocaleString()}`;
    }
    
    // 等待状态指示
    const waitingStatus = this.getWaitingStatusText();
    
    process.stdout.write(`\r${progressText} | 速度: ${speed.toFixed(1)}/s | 响应: ${avgResponseTime.toFixed(0)}ms${elapsedText}${etaText}${waitingStatus}`);
  }
  
  getWaitingStatusText() {
    if (!this.rateLimitTracker.isWaiting) {
      return '';
    }
    
    const now = Date.now();
    const remainingMs = this.rateLimitTracker.estimatedWaitEndTime - now;
    const remainingSecs = Math.max(0, Math.ceil(remainingMs / 1000));
    
    switch (this.rateLimitTracker.waitingReason) {
      case 'rate_limit':
        return ` ⏳ [Rate Limit: ${remainingSecs}s]`;
      case 'rate_limit_throttle':
        return ` ⚡ [节流中]`;
      case 'adaptive_delay':
        return ` 🔄 [自适应延迟: ${remainingSecs}s]`;
      case 'network_error':
        return ` 🔌 [网络重试: ${remainingSecs}s]`;
      case 'other':
        return ` ⏸️ [等待: ${remainingSecs}s]`;
      default:
        return ` ⏳ [等待中]`;
    }
  }

  generateProgressBar(percentage, width = 20) {
    const filled = Math.round(percentage / 100 * width);
    const empty = width - filled;
    return `[${'█'.repeat(filled)}${'░'.repeat(empty)}]`;
  }
  
  updateVoteProgress(processedPages, totalPages) {
    const now = Date.now();
    
    // 限制进度更新频率
    if (now - this.progressState.lastProgressUpdate < this.progressState.progressUpdateInterval) {
      return;
    }
    
    this.progressState.lastProgressUpdate = now;
    
    const progress = (processedPages / totalPages * 100).toFixed(1);
    const progressBar = this.generateProgressBar(parseFloat(progress));
    const completeness = (this.voteProgress.totalVotesCollected / this.voteProgress.totalVotesExpected * 100).toFixed(1);
    
    // 计算已用时间
    const elapsedSeconds = (now - this.stats.startTime) / 1000;
    const elapsedText = ` | 已用: ${this.formatDuration(elapsedSeconds)}`;
    
    // 计算预计剩余时间（基于投票页面处理速度）
    let etaText = '';
    if (processedPages > 0) {
      const avgPageSpeed = processedPages / elapsedSeconds;
      const remainingPages = totalPages - processedPages;
      if (avgPageSpeed > 0 && remainingPages > 0) {
        const etaSeconds = remainingPages / avgPageSpeed;
        etaText = ` | ETA: ${this.formatDuration(etaSeconds)}`;
      }
    }
    
    // 网络耗时显示
    const networkTime = this.lastNetworkTime || 0;
    const waitingStatus = this.getWaitingStatusText();
    const incrementalInfo = this.incrementalData.newVotesOnly ? ' | 增量更新' : ' | 全量同步';
    
    process.stdout.write(`\r🗳️  ${progressBar} ${progress}% (${processedPages}/${totalPages}) | 投票: ${this.stats.votesProcessed.toLocaleString()} | 完整性: ${completeness}% | 网络: ${networkTime}ms${elapsedText}${etaText}${incrementalInfo}${waitingStatus}`);
  }

  processPageBasic(page) {
    const pageData = {
      url: page.url,
      wikidotId: page.wikidotId,
      title: page.title,
      rating: page.rating,
      voteCount: page.voteCount,
      category: page.category,
      tags: page.tags || [],
      createdAt: page.createdAt,
      revisionCount: page.revisionCount,
      commentCount: page.commentCount,
      isHidden: page.isHidden,
      isUserPage: page.isUserPage,
      thumbnailUrl: page.thumbnailUrl,
      sourceLength: page.source?.length || 0,
      textContentLength: page.textContent?.length || 0,
      createdByUser: page.createdBy?.displayName,
      createdByWikidotId: page.createdBy?.wikidotId,
      createdByUnixName: page.createdBy?.unixName,
      parentUrl: page.parent?.url,
      childrenCount: page.children?.length || 0,
      attributionsCount: page.attributions?.length || 0,
      revisionsCount: page.revisions?.edges?.length || 0,
      alternateTitlesCount: page.alternateTitles?.length || 0,
      // 标记是否需要获取投票数据
      needsVoteData: page.voteCount > 0
    };
    
    this.data.pages.push(pageData);
    
    // 处理备用标题
    if (page.alternateTitles && page.alternateTitles.length > 0) {
      for (const altTitle of page.alternateTitles) {
        this.data.alternateTitles.push({
          pageUrl: page.url,
          pageTitle: page.title,
          title: altTitle.title,
          language: 'unknown' // API v2中移除了language字段，使用默认值
        });
      }
    }
    
    // 处理修订历史
    if (page.revisions && page.revisions.edges) {
      for (const revisionEdge of page.revisions.edges) {
        const revision = revisionEdge.node;
        this.data.revisions.push({
          pageUrl: page.url,
          pageTitle: page.title,
          revisionId: revision.wikidotId,
          timestamp: revision.timestamp,
          userId: revision.user?.wikidotId,
          userName: revision.user?.displayName,
          userUnixName: revision.user?.unixName,
          comment: revision.comment
        });
        
        // 收集修订用户ID
        if (revision.user?.wikidotId) {
          this.userCache.add(revision.user.wikidotId);
        }
      }
    }
    
    // 处理贡献者信息
    if (page.attributions) {
      for (const attr of page.attributions) {
        // 从新的数据结构中获取用户信息
        const wikidotUser = attr.user?.wikidotUser;
        this.data.attributions.push({
          pageUrl: page.url,
          pageTitle: page.title,
          userId: wikidotUser?.wikidotId || null,
          userName: wikidotUser?.displayName || attr.user?.displayName || `Unknown_${wikidotUser?.wikidotId || 'User'}`,
          userUnixName: wikidotUser?.unixName || null,
          attributionType: attr.type,
          date: attr.date,
          order: attr.order
        });
        
        // 收集贡献者用户ID
        if (wikidotUser?.wikidotId) {
          this.userCache.add(wikidotUser.wikidotId);
        }
      }
    }
    
    // 收集需要详细信息的用户ID
    if (page.createdBy?.wikidotId) {
      this.userCache.add(page.createdBy.wikidotId);
    }
    if (page.attributions) {
      page.attributions.forEach(attr => {
        if (attr.user?.wikidotId) {
          this.userCache.add(attr.user.wikidotId);
        }
      });
    }
  }

  async filterPagesNeedingVoteUpdate(pagesWithVotes) {
    console.log('🔍 智能检测需要更新投票数据的页面...');
    
    const pagesToUpdate = [];
    let unchanged = 0;
    let voteCountChanged = 0;
    let ratingChanged = 0;
    let firstVoteChanged = 0;
    let newPages = 0;
    
    for (const page of pagesWithVotes) {
      const historicalState = this.incrementalData.pageVoteStates.get(page.url);
      
      if (!historicalState) {
        // 新页面，需要获取投票数据
        newPages++;
        pagesToUpdate.push({
          ...page,
          updateReason: 'new_page'
          // 移除limitVoteCount限制，获取完整投票数据
        });
        continue;
      }
      
      let needsUpdate = false;
      let reason = '';
      
      // 检查1: vote数量发生变化
      if (page.voteCount !== historicalState.voteCount) {
        needsUpdate = true;
        reason = 'vote_count_changed';
        voteCountChanged++;
      }
      
      // 检查2: rating发生变化
      if (page.rating !== historicalState.rating) {
        needsUpdate = true;
        reason = reason ? reason + '+rating_changed' : 'rating_changed';
        if (!needsUpdate) ratingChanged++;
      }
      
      // 检查3: 智能投票变化检测（获取前5个投票进行比较）
      if (!needsUpdate && page.voteCount > 0) {
        // 只有在前两个检查都通过时才进行这个较昂贵的检查
        const voteChangeResult = await this.checkVoteChanges(page.url, historicalState);
        if (voteChangeResult.hasChanges) {
          needsUpdate = true;
          reason = voteChangeResult.reason;
          firstVoteChanged++;
        }
      }
      
      if (needsUpdate) {
        pagesToUpdate.push({
          ...page,
          updateReason: reason
          // 移除limitVoteCount限制，获取完整投票数据
        });
      } else {
        unchanged++;
      }
    }
    
    console.log(`📊 投票更新统计:`);
    console.log(`   🆕 新页面: ${newPages}`);
    console.log(`   📊 投票数变化: ${voteCountChanged}`);
    console.log(`   ⭐ 评分变化: ${ratingChanged}`);
    console.log(`   🔄 首投票变化: ${firstVoteChanged}`);
    console.log(`   ✅ 无变化跳过: ${unchanged}`);
    
    return pagesToUpdate;
  }

  async getFirstVoteId(pageUrl) {
    // 轻量级查询，只获取第一个投票的ID
    try {
      const query = `
        query GetFirstVote($pageUrl: String!) {
          wikidotPage(url: $pageUrl) {
            fuzzyVoteRecords(first: 1) {
              edges {
                node {
                  userWikidotId
                }
              }
            }
          }
        }
      `;
      
      const result = await this.cromClient.request(query, { pageUrl });
      const firstVote = result.wikidotPage?.fuzzyVoteRecords?.edges?.[0]?.node;
      return firstVote?.userWikidotId || null;
      
    } catch (error) {
      // 如果获取失败，保守地假设需要更新
      return 'unknown';
    }
  }

  async syncVoteData() {
    console.log('\n🗳️  第二阶段：智能投票数据同步 (基于变化检测)...');
    
    // 只处理有投票的页面
    const pagesWithVotes = this.data.pages.filter(p => p.needsVoteData);
    console.log(`📊 有投票的页面总数: ${pagesWithVotes.length}/${this.data.pages.length}`);
    
    // 智能筛选需要更新的页面
    const pagesToUpdate = await this.filterPagesNeedingVoteUpdate(pagesWithVotes);
    console.log(`📊 需要更新投票数据的页面: ${pagesToUpdate.length}/${pagesWithVotes.length} (节省 ${pagesWithVotes.length - pagesToUpdate.length} 个请求)`);
    
    // 计算预期投票总数（基于实际需要更新的页面的完整投票数）
    this.voteProgress.totalVotesExpected = pagesToUpdate.reduce((sum, p) => sum + p.voteCount, 0);
    console.log(`📊 预期投票记录总数: ${this.voteProgress.totalVotesExpected.toLocaleString()}`);
    
    let processedVotePages = 0;
    
    for (const page of pagesToUpdate) {
      // 检查是否已完成该页面的投票获取
      if (this.voteProgress.completedPages.has(page.url)) {
        processedVotePages++;
        continue;
      }
      
      let pageRetries = 0;
      let pageSuccess = false;
      
      // 重试当前页面的投票获取直到成功或达到最大重试次数
      while (!pageSuccess && pageRetries < this.config.maxRetries) {
        try {
          
          // 获取页面的完整投票记录
          const voteResult = await this.fetchPageVotesWithResume(page.url, page.voteCount);
          
          // 成功请求后清理429错误计数
          this.clearConsecutive429Errors('votes');
          
          // 数据覆盖逻辑：先检查是否有差异，如有差异则先清理旧数据
          let hasDataDiscrepancy = false;
          if (voteResult.votes && page.voteCount > 0) {
            const difference = page.voteCount - voteResult.votes.length;
            if (difference !== 0) {
              hasDataDiscrepancy = true;
              
              // 移除该页面的旧投票记录（如果存在）
              const oldVoteCount = this.data.voteRecords.filter(v => v.pageUrl === page.url).length;
              if (oldVoteCount > 0) {
                console.log(`\n🔄 数据覆盖: ${page.url} (旧:${oldVoteCount}票 → 新:${voteResult.votes.length}票)`);
                this.data.voteRecords = this.data.voteRecords.filter(v => v.pageUrl !== page.url);
                
                // 调整统计计数
                this.voteProgress.totalVotesCollected -= oldVoteCount;
                this.stats.votesProcessed -= oldVoteCount;
              } else if (Math.abs(difference) > 5) {
                // 只有在显著差异时才记录日志
                console.log(`\n🔍 数据差异: ${page.url} (期望:${page.voteCount}票, 实际:${voteResult.votes.length}票, 差异:${difference})`);
              }
            }
          }
          
          // 添加新的投票记录
          if (voteResult.votes && voteResult.votes.length > 0) {
            for (const vote of voteResult.votes) {
              this.data.voteRecords.push({
                pageUrl: page.url,
                pageTitle: page.title,
                pageAuthor: page.createdByUser,
                pageAuthorId: page.createdByWikidotId,
                voterWikidotId: vote.userWikidotId,
                voterName: vote.user?.displayName,
                direction: vote.direction,
                timestamp: vote.timestamp
              });
              
              // 收集投票用户ID
              if (vote.user?.wikidotId) {
                this.userCache.add(vote.user.wikidotId);
              }
            }
            
            this.stats.votesProcessed += voteResult.votes.length;
            this.voteProgress.totalVotesCollected += voteResult.votes.length;
            
            if (hasDataDiscrepancy) {
              console.log(`   已添加新记录: ${voteResult.votes.length} 票`);
            }
            
            // 更新页面投票状态缓存
            const firstVoteId = voteResult.votes.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))[0].voterWikidotId;
            this.incrementalData.pageVoteStates.set(page.url, {
              voteCount: page.voteCount,
              rating: page.rating,
              firstVoteId: firstVoteId,
              lastUpdated: new Date().toISOString()
            });
            
            // 如果有数据差异，更新增量数据的已有投票索引
            if (hasDataDiscrepancy) {
              const newVoteKeys = new Set();
              voteResult.votes.forEach(vote => {
                const voteKey = `${vote.userWikidotId}-${vote.timestamp}`;
                newVoteKeys.add(voteKey);
              });
              this.incrementalData.existingVotes.set(page.url, newVoteKeys);
              console.log(`   已更新增量索引: ${newVoteKeys.size} 条记录`);
            }
          }
          
          // 标记完成状态和数据差异处理
          const difference = page.voteCount - voteResult.votes.length;
          let shouldContinue = false;
          
          if (voteResult.isComplete) {
            // API标记为完整，分析数据差异原因
            if (difference === 0) {
              // 完全匹配，正常情况
              shouldContinue = true;
            } else {
              // 有差异但API认为完整，这是fuzzyVoteRecords的特性
              shouldContinue = true;
              
              // 记录数据差异用于分析
              if (Math.abs(difference) > 5) {
                console.log(`📊 fuzzy数据差异: ${page.url} (${voteResult.votes.length}/${page.voteCount}, 差异${difference})`);
                
                if (!this.stats.dataDiscrepancies) {
                  this.stats.dataDiscrepancies = [];
                }
                this.stats.dataDiscrepancies.push({
                  pageUrl: page.url,
                  pageTitle: page.title,
                  expectedVotes: page.voteCount,
                  actualVotes: voteResult.votes.length,
                  difference: difference,
                  rating: page.rating,
                  reason: 'fuzzy_data_nature' // 标记为fuzzy数据特性
                });
              }
            }
          } else {
            // 我们的逻辑认为数据不完整
            const hasPartialData = voteResult.partialData; // 是否因异常导致的部分数据
            const retryThreshold = hasPartialData ? 2 : 3; // 如果是因异常导致，减少重试次数
            
            if (pageRetries >= retryThreshold) {
              // 重试次数达到阈值，接受当前数据并继续
              const reasonMsg = hasPartialData ? '网络异常但数据可用' : '数据评估为不完整';
              console.log(`📋 接受数据: ${page.url} (${voteResult.votes?.length || 0}/${page.voteCount}票, ${reasonMsg})`);
              shouldContinue = true;
              
              // 记录不完整页面
              if (!this.stats.incompletePages) {
                this.stats.incompletePages = [];
              }
              this.stats.incompletePages.push({
                url: page.url,
                title: page.title,
                expectedVotes: page.voteCount,
                actualVotes: voteResult.votes?.length || 0,
                difference: page.voteCount - (voteResult.votes?.length || 0),
                reason: hasPartialData ? 'network_error_partial_data' : 'data_assessment_incomplete',
                retries: pageRetries,
                errorMessage: voteResult.error
              });
            } else {
              // 继续重试
              const errorDetail = voteResult.error ? ` (${voteResult.error})` : '';
              throw new Error(`投票数据不完整: 数据评估失败 (${voteResult.votes?.length || 0}/${page.voteCount})${errorDetail}`);
            }
          }
          
          // 如果决定继续处理，标记为完成
          if (shouldContinue) {
            this.voteProgress.completedPages.add(page.url);
            this.voteProgress.partialPages.delete(page.url);
            
            // 添加处理完成标记，用于数据验证
            if (voteResult.votes && voteResult.votes.length > 0) {
              // 在投票记录中添加元数据标记
              voteResult.votes.forEach(vote => {
                if (vote._metadata) {
                  vote._metadata.dataQuality = voteResult.isComplete ? 'complete' : 'partial';
                  vote._metadata.expectedCount = page.voteCount;
                  vote._metadata.actualCount = voteResult.votes.length;
                }
              });
            }
          }
          
          pageSuccess = true; // 当前页面成功
          
          // 添加基础请求间隔控制
          const delayMs = 1000 / this.config.maxRequestsPerSecond;
          await this.sleep(delayMs);
          
        } catch (error) {
          pageRetries++;
          
          // 使用简化的错误处理
          await this.handleBatchError(error, 'votes', pageRetries);
          
          if (pageRetries >= this.config.maxRetries) {
            console.log(`\n❌ 页面 ${page.url} 投票获取失败，跳过该页面`);
            break; // 跳过此页面，继续下一个
          }
        }
      }
      
      processedVotePages++;
      
      // 智能进度显示（投票阶段）  
      this.updateVoteProgress(processedVotePages, pagesToUpdate.length);
      
      // 定期保存投票进度检查点
      if (processedVotePages % this.config.maxVotePagesPerRequest === 0) {
        await this.saveVoteProgressCheckpoint();
      }
    }
    
    // 保存最终的投票进度检查点
    await this.saveVoteProgressCheckpoint();
    
    console.log(`\n✅ 投票数据同步完成! 总计 ${this.stats.votesProcessed.toLocaleString()} 条投票记录`);
  }

  async fetchPageVotesWithResume(pageUrl, expectedVoteCount) {
    // 支持断点续传和增量更新的投票记录获取
    // 重要：fuzzyVoteRecords从新到旧排序！这对增量更新极其有利
    let allVotes = [];
    let cursor = null;
    let hasNextPage = true;
    let foundOldVote = false; // 是否找到已存在的投票（用于增量更新）
    
    // 对于投票数据，我们要求完整性，不允许部分完成状态
    // 如果之前有部分数据，从头重新获取以确保完整性
    if (this.voteProgress.partialPages.has(pageUrl)) {
      console.log(`\n🔄 发现页面 ${pageUrl} 有部分数据，为确保完整性将重新获取`);
      this.voteProgress.partialPages.delete(pageUrl);
      cursor = null; // 重置游标，从头获取
    }
    
    // 智能增量更新逻辑：只在有足够历史数据时启用
    if (this.config.enableIncrementalUpdate && 
        !this.config.voteOnlyMode && 
        this.incrementalData.newVotesOnly &&
        this.incrementalData.existingVotes.has(pageUrl) &&
        this.incrementalData.pageVoteStates.has(pageUrl)) {
      
      try {
        const shouldSkip = await this.checkVoteChangesAndDecideSync(pageUrl, expectedVoteCount);
        if (shouldSkip) {
          console.log(`⏭️  增量更新跳过: ${pageUrl}`);
          return {
            votes: [],
            isComplete: true,
            nextCursor: null,
            error: null,
            skipped: true
          };
        }
      } catch (error) {
        console.log(`⚠️  增量更新检查失败，进行完整同步: ${pageUrl} - ${error.message}`);
        // 增量更新失败时，继续进行完整同步
      }
    }
    
    // 获取投票记录（智能限制数量）
    let remainingVotes = expectedVoteCount;
    while (hasNextPage && !foundOldVote && remainingVotes > 0) {
      const query = `
        query FetchPageVotes($pageUrl: URL!, $first: Int, $after: ID) {
          wikidotPage(url: $pageUrl) {
            fuzzyVoteRecords(first: $first, after: $after) {
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
      
      const actualBatchSize = Math.min(this.config.votesBatchSize, remainingVotes);
      const variables = {
        pageUrl,
        first: actualBatchSize, // 智能批次大小
        ...(cursor && { after: cursor })
      };
      
      // 调试信息：显示实际批次大小
      if (actualBatchSize < this.config.votesBatchSize) {
        console.log(`🔍 智能批次: ${pageUrl} 使用 ${actualBatchSize}/${remainingVotes} 而非 ${this.config.votesBatchSize}`);
      }
      
      try {
        const networkStart = Date.now();
        const result = await this.cromClient.request(query, variables);
        this.lastNetworkTime = Date.now() - networkStart;
        const voteData = result.wikidotPage?.fuzzyVoteRecords;
        
        // 检测空响应
        const hasValidData = this.detectEmptyResponse(result, 'votes');
        if (!hasValidData) {
          throw new Error('检测到投票数据空响应，可能是API限流');
        }
        
        if (!voteData || !voteData.edges.length) {
          break;
        }
        
        // 处理本批次的投票记录
        const batchVotes = voteData.edges.map(edge => edge.node);
        
        // 现在统一使用全量获取，因为增量检测已在上层完成
        allVotes.push(...batchVotes);
        remainingVotes -= batchVotes.length;
        
        // 更新分页信息
        if (!foundOldVote) {
          hasNextPage = voteData.pageInfo.hasNextPage;
          cursor = voteData.pageInfo.endCursor;
        }
        
        
        // 如果有更多数据需要获取，按配置的频率限制延迟
        if (hasNextPage && !foundOldVote) {
          const delayMs = 1000 / this.config.maxRequestsPerSecond;
          await this.sleep(delayMs);
        }
        
      } catch (error) {
        // 如果遇到错误，智能判断是否应该接受部分数据
        const isDataComplete = this.assessDataCompleteness(allVotes, expectedVoteCount, hasNextPage);
        
        return {
          votes: allVotes,
          isComplete: isDataComplete, // 基于数据而非异常来判断
          nextCursor: cursor,
          error: error.message,
          partialData: true // 标记为因异常导致的部分数据
        };
      }
    }
    
    // 智能判断数据完整性
    const isDataComplete = this.assessDataCompleteness(allVotes, expectedVoteCount, hasNextPage);
    
    return {
      votes: allVotes,
      isComplete: isDataComplete,
      nextCursor: null,
      error: null,
      skipped: false
    };
  }

  assessDataCompleteness(votes, expectedVoteCount, hasNextPage) {
    // 智能评估数据完整性，而不是简单的异常检测
    
    if (!votes || votes.length === 0) {
      // 没有获取到任何投票数据
      if (expectedVoteCount === 0) {
        return true; // 页面确实没有投票
      } else {
        return false; // 应该有投票但没获取到
      }
    }
    
    // 获取到了投票数据，评估完整性
    const actualCount = votes.length;
    const difference = Math.abs(expectedVoteCount - actualCount);
    
    // 1. 如果API还有下一页，但我们停止了获取，标记为不完整
    if (hasNextPage && actualCount < expectedVoteCount) {
      return false;
    }
    
    // 2. 数据完全匹配
    if (difference === 0) {
      return true;
    }
    
    // 3. fuzzyVoteRecords的特性：轻微差异是正常的
    if (difference <= 5) {
      return true; // 认为是fuzzy数据的正常特性
    }
    
    // 4. 获取到的数据比预期多（重复投票等情况）
    if (actualCount > expectedVoteCount) {
      return true; // 有额外数据不算不完整
    }
    
    // 5. 大差异但获取到了大部分数据
    const completionRate = actualCount / expectedVoteCount;
    if (completionRate >= 0.8) { // 80%以上认为基本完整
      return true;
    }
    
    // 6. 其他情况认为不完整
    return false;
  }

  async updateRateLimitTracker(pointsUsed) {
    const now = Date.now();
    
    // 清理5分钟窗口之外的历史记录
    this.rateLimitTracker.requestHistory = this.rateLimitTracker.requestHistory
      .filter(req => now - req.timestamp < this.config.rateLimitWindowMs);
    
    // 添加当前请求
    this.rateLimitTracker.requestHistory.push({
      timestamp: now,
      points: pointsUsed
    });
    
    // 计算当前窗口内的点数使用
    this.rateLimitTracker.pointsUsed = this.rateLimitTracker.requestHistory
      .reduce((sum, req) => sum + req.points, 0);
    
    // 如果接近限制，增加延迟
    const usagePercentage = this.rateLimitTracker.pointsUsed / this.config.rateLimitPoints;
    if (usagePercentage > 0.8) {
      const remainingTime = this.config.rateLimitWindowMs - 
        (now - Math.min(...this.rateLimitTracker.requestHistory.map(r => r.timestamp)));
      const delayMs = Math.max(1000, remainingTime / 10); // 动态延迟
      console.log(`⏳ Rate limit使用 ${(usagePercentage * 100).toFixed(1)}%, 延迟 ${delayMs}ms`);
      await this.sleep(delayMs);
    }
  }

  async checkVoteChanges(pageUrl, historicalState) {
    try {
      console.log(`🔍 检查页面投票变化: ${pageUrl}`);
      
      // 获取前5个最新投票记录进行比较
      const query = `
        query CheckVoteChanges($pageUrl: URL!) {
          wikidotPage(url: $pageUrl) {
            fuzzyVoteRecords(first: 5) {
              edges {
                node {
                  userWikidotId
                  direction
                  timestamp
                }
              }
            }
          }
        }
      `;
      
      const result = await this.cromClient.request(query, { pageUrl });
      const currentVotes = result.wikidotPage?.fuzzyVoteRecords?.edges || [];
      
      if (currentVotes.length === 0) {
        return { hasChanges: false, reason: 'no_votes' };
      }
      
      // 检查是否有历史投票数据
      if (!this.incrementalData.existingVotes.has(pageUrl)) {
        // 没有历史数据，说明是首次同步，需要获取所有投票
        return { hasChanges: true, reason: 'first_sync_no_history' };
      }
      
      const existingVoteKeys = this.incrementalData.existingVotes.get(pageUrl);
      
      // 检查前5个投票是否都存在于历史数据中
      let hasNewVotes = false;
      for (const voteEdge of currentVotes) {
        const vote = voteEdge.node;
        const voteKey = `${vote.userWikidotId}-${vote.timestamp}`;
        
        if (!existingVoteKeys.has(voteKey)) {
          hasNewVotes = true;
          console.log(`   发现新投票: ${vote.userWikidotId} at ${vote.timestamp}`);
          break;
        }
      }
      
      if (hasNewVotes) {
        return { hasChanges: true, reason: 'new_votes_detected' };
      }
      
      // 所有前5个投票都存在于历史数据中，说明没有变化
      console.log(`   前5个投票均无变化，跳过页面`);
      return { hasChanges: false, reason: 'no_changes_in_recent_votes' };
      
    } catch (error) {
      console.log(`❌ 检查投票变化失败: ${error.message}，保守地获取投票数据`);
      // 出错时保守地假设有变化，确保数据完整性
      return { hasChanges: true, reason: 'error_fallback' };
    }
  }

  // 移除低效的findCursorFromProcessedPages方法
  // 已被新的cursor保存/恢复机制替代

  async loadPageCheckpoint() {
    try {
      // 查找最新的页面检查点文件（按页面数量排序）
      const files = fs.readdirSync(this.dataDir);
      const checkpointFiles = files
        .filter(f => f.startsWith('production-data-pages-checkpoint-') && f.endsWith('.json'))
        .map(f => {
          // 从文件名中提取页面数量用于排序
          const match = f.match(/pages-checkpoint-(\d+)-/);
          const pageCount = match ? parseInt(match[1]) : 0;
          return { filename: f, pageCount };
        })
        .sort((a, b) => b.pageCount - a.pageCount); // 按页面数量降序排序

      if (checkpointFiles.length === 0) {
        return null;
      }

      const latestFile = checkpointFiles[0].filename;
      const maxPageCount = checkpointFiles[0].pageCount;
      console.log(`📊 找到 ${checkpointFiles.length} 个检查点文件，选择最大的: ${maxPageCount} 页面`);
      
      const checkpointPath = path.join(this.dataDir, latestFile);
      const checkpointData = JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));

      // 优先使用metadata中的信息，兼容旧格式
      const metadata = checkpointData.metadata || {};
      const totalProcessed = metadata.totalProcessed || 
        (latestFile.match(/pages-checkpoint-(\d+)/) ? parseInt(latestFile.match(/pages-checkpoint-(\d+)/)[1]) : 0);
      const cursor = metadata.cursor || null;

      console.log(`✅ 加载页面检查点: ${latestFile}`);
      console.log(`   页面数: ${totalProcessed}, cursor: ${cursor ? '已保存' : '无'}`);

      return {
        totalProcessed,
        cursor: cursor, // 直接使用保存的cursor，无需重新计算
        pages: checkpointData.pages || [],
        revisions: checkpointData.revisions || [],
        attributions: checkpointData.attributions || [],
        alternateTitles: checkpointData.alternateTitles || []
      };
      
    } catch (error) {
      console.log(`⚠️  加载页面检查点失败: ${error.message}`);
      return null;
    }
  }

  async loadVoteProgressCheckpoint() {
    try {
      if (!fs.existsSync(this.checkpointDir)) {
        return;
      }

      const files = fs.readdirSync(this.checkpointDir);
      const voteCheckpointFiles = files
        .filter(f => f.startsWith('vote-progress-checkpoint-') && f.endsWith('.json'))
        .sort()
        .reverse();

      if (voteCheckpointFiles.length === 0) {
        console.log('📋 未找到投票进度检查点，将从头开始');
        return;
      }

      const latestFile = voteCheckpointFiles[0];
      const checkpointData = JSON.parse(
        fs.readFileSync(path.join(this.checkpointDir, latestFile), 'utf8')
      );

      // 恢复投票进度状态
      this.voteProgress.completedPages = new Set(checkpointData.completedPages || []);
      this.voteProgress.partialPages = new Map(Object.entries(checkpointData.partialPages || {}));
      this.voteProgress.totalVotesExpected = checkpointData.totalVotesExpected || 0;
      this.voteProgress.totalVotesCollected = checkpointData.totalVotesCollected || 0;

      // 关键修复：恢复已收集的数据
      if (checkpointData.collectedData) {
        console.log(`🔄 恢复已收集的数据...`);
        this.data.pages = checkpointData.collectedData.pages || [];
        this.data.voteRecords = checkpointData.collectedData.voteRecords || [];
        this.data.users = checkpointData.collectedData.users || [];
        this.data.attributions = checkpointData.collectedData.attributions || [];
        this.data.revisions = checkpointData.collectedData.revisions || [];
        this.data.alternateTitles = checkpointData.collectedData.alternateTitles || [];
        
        console.log(`   📄 恢复页面: ${this.data.pages.length.toLocaleString()}`);
        console.log(`   🗳️  恢复投票: ${this.data.voteRecords.length.toLocaleString()}`);
        console.log(`   👤 恢复用户: ${this.data.users.length.toLocaleString()}`);
      }

      console.log(`✅ 已加载投票进度检查点: ${latestFile}`);
      console.log(`   已完成页面: ${this.voteProgress.completedPages.size}`);
      console.log(`   部分完成页面: ${this.voteProgress.partialPages.size}`);
      console.log(`   期望总投票: ${this.voteProgress.totalVotesExpected.toLocaleString()}`);
      
    } catch (error) {
      console.log(`⚠️  加载投票进度检查点失败: ${error.message}`);
    }
  }

  async checkVoteChangesAndDecideSync(pageUrl, expectedVoteCount) {
    try {
      // 步骤1: 获取页面当前状态（包含最新5个投票和页面统计）
      const query = `
        query CheckVoteChangesAndPageState($pageUrl: URL!) {
          wikidotPage(url: $pageUrl) {
            voteCount
            rating
            fuzzyVoteRecords(first: 5) {
              edges {
                node {
                  userWikidotId
                  direction
                  timestamp
                }
              }
            }
          }
        }
      `;
      
      const result = await this.cromClient.request(query, { pageUrl });
      const pageData = result.wikidotPage;
      
      if (!pageData) {
        console.log(`   ⚠️  页面无法访问: ${pageUrl}`);
        return false; // 无法访问，进行同步
      }
      
      const currentVotes = pageData.fuzzyVoteRecords?.edges || [];
      const currentVoteCount = pageData.voteCount;
      const currentRating = pageData.rating;
      
      // 步骤2: 检查是否有历史数据
      const hasHistoricalVotes = this.incrementalData.existingVotes.has(pageUrl);
      const hasHistoricalPageState = this.incrementalData.pageVoteStates.has(pageUrl);
      
      if (!hasHistoricalVotes || !hasHistoricalPageState) {
        console.log(`   📝 首次同步页面: ${pageUrl}`);
        return false; // 首次同步，需要获取数据
      }
      
      // 步骤3: 比较最新5个投票
      const historicalVoteKeys = this.incrementalData.existingVotes.get(pageUrl);
      const historicalPageState = this.incrementalData.pageVoteStates.get(pageUrl);
      
      // 获取历史数据中最新的5个投票（按时间戳排序）
      const historicalVotes = Array.from(historicalVoteKeys)
        .map(voteKey => {
          // voteKey格式: "userWikidotId-timestamp"，但timestamp中也包含-，所以需要更精确的分割
          const dashIndex = voteKey.indexOf('-');
          const userWikidotId = parseInt(voteKey.substring(0, dashIndex));
          const timestamp = voteKey.substring(dashIndex + 1);
          return { userWikidotId, timestamp };
        })
        .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
        .slice(0, 5);
      
      // 比较当前最新5个投票与历史最新5个投票
      let votesChanged = false;
      if (currentVotes.length !== historicalVotes.length) {
        votesChanged = true;
        console.log(`   🔄 投票数量变化: ${historicalVotes.length} → ${currentVotes.length}`);
      } else {
        for (let i = 0; i < currentVotes.length; i++) {
          const currentVote = currentVotes[i].node;
          const historicalVote = historicalVotes[i];
          
          
          if (parseInt(currentVote.userWikidotId) !== historicalVote.userWikidotId ||
              currentVote.timestamp !== historicalVote.timestamp) {
            votesChanged = true;
            console.log(`   🔄 投票内容变化在位置 ${i + 1}: ${historicalVote.userWikidotId}@${historicalVote.timestamp} → ${currentVote.userWikidotId}@${currentVote.timestamp}`);
            break;
          }
        }
      }
      
      // 步骤4: 如果投票有变化，进行同步
      if (votesChanged) {
        console.log(`   ✅ 检测到投票变化，将进行同步: ${pageUrl}`);
        return false; // 需要同步
      }
      
      // 步骤5: 投票相同，检查页面状态（voteCount和rating）
      const voteCountChanged = currentVoteCount !== historicalPageState.voteCount;
      const ratingChanged = Math.abs(currentRating - historicalPageState.rating) > 0.01; // 使用小误差比较
      
      if (voteCountChanged || ratingChanged) {
        console.log(`   🔄 页面状态变化: voteCount ${historicalPageState.voteCount} → ${currentVoteCount}, rating ${historicalPageState.rating} → ${currentRating}`);
        return false; // 需要同步
      }
      
      // 步骤6: 所有检查都通过，跳过同步
      console.log(`   ⏭️  页面无变化，跳过同步: ${pageUrl} (${currentVoteCount}票, 评分${currentRating})`);
      return true; // 跳过同步
      
    } catch (error) {
      console.log(`   ❌ 检查投票变化失败: ${error.message}，保守地进行同步`);
      return false; // 出错时保守地进行同步
    }
  }

  async saveVoteProgressCheckpoint() {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const checkpointFile = `vote-progress-checkpoint-${timestamp}.json`;
    
    // 修复：保存完整的数据状态，包括已收集的投票数据
    const checkpoint = {
      timestamp: new Date().toISOString(),
      completedPages: Array.from(this.voteProgress.completedPages),
      partialPages: Object.fromEntries(this.voteProgress.partialPages),
      totalVotesExpected: this.voteProgress.totalVotesExpected,
      totalVotesCollected: this.voteProgress.totalVotesCollected,
      stats: {
        votesProcessed: this.stats.votesProcessed,
        pagesProcessed: this.stats.pagesProcessed
      },
      // 关键修复：保存已收集的数据，而不是只保存状态
      collectedData: {
        pages: this.data.pages,           // 页面数据
        voteRecords: this.data.voteRecords, // 已收集的投票记录
        users: this.data.users,           // 用户数据
        attributions: this.data.attributions,
        revisions: this.data.revisions,
        alternateTitles: this.data.alternateTitles
      }
    };
    
    const checkpointPath = path.join(this.checkpointDir, checkpointFile);
    fs.writeFileSync(checkpointPath, JSON.stringify(checkpoint, null, 2));
    
    // 清理旧的投票checkpoint文件，只保留最新的3个
    this.cleanupOldVoteCheckpoints();
    
    const completedCount = this.voteProgress.completedPages.size;
    const partialCount = this.voteProgress.partialPages.size;
    const dataSize = (fs.statSync(checkpointPath).size / 1024 / 1024).toFixed(2);
    
    console.log(`\n💾 投票进度检查点已保存: ${checkpointFile} (${dataSize} MB)`);
    console.log(`   ✅ 已完成页面: ${completedCount}, ⏸️ 部分完成: ${partialCount}`);
    console.log(`   🗳️  已保存投票: ${this.data.voteRecords.length.toLocaleString()} 条`);
  }

  cleanupOldVoteCheckpoints() {
    try {
      if (!fs.existsSync(this.checkpointDir)) {
        return;
      }

      const files = fs.readdirSync(this.checkpointDir);
      const voteCheckpointFiles = files
        .filter(f => f.startsWith('vote-progress-checkpoint-') && f.endsWith('.json'))
        .map(f => {
          const filePath = path.join(this.checkpointDir, f);
          const stats = fs.statSync(filePath);
          return {
            filename: f,
            filepath: filePath,
            mtime: stats.mtime.getTime(),
            size: stats.size
          };
        })
        .sort((a, b) => b.mtime - a.mtime); // 按修改时间降序排序，最新的在前

      // 保留最新的3个投票checkpoint，删除其余的
      if (voteCheckpointFiles.length > 3) {
        const toDelete = voteCheckpointFiles.slice(3);
        
        toDelete.forEach(file => {
          try {
            fs.unlinkSync(file.filepath);
            const sizeStr = (file.size / 1024 / 1024).toFixed(2);
            console.log(`🗑️  已删除旧投票checkpoint: ${file.filename} (${sizeStr} MB)`);
          } catch (error) {
            console.log(`⚠️  删除投票checkpoint失败: ${file.filename} - ${error.message}`);
          }
        });
        
        console.log(`✅ 投票checkpoint清理完成，删除了 ${toDelete.length} 个旧文件`);
      }
    } catch (error) {
      console.log(`⚠️  清理投票checkpoint时出错: ${error.message}`);
    }
  }

  async consolidateUserData() {
    console.log('\n👤 第三阶段：汇总用户数据...');
    
    // 从页面数据中收集所有用户信息
    const userMap = new Map();
    
    // 从页面作者收集用户
    this.data.pages.forEach(page => {
      if (page.createdByUser && page.createdByWikidotId) {
        const userId = page.createdByWikidotId;
        if (!userMap.has(userId)) {
          userMap.set(userId, {
            displayName: page.createdByUser,
            wikidotId: userId,
            roles: new Set(['author']),
            pagesCreated: 0,
            pagesVoted: 0,
            totalVotesGiven: 0,
            totalVotesReceived: 0
          });
        }
        userMap.get(userId).pagesCreated++;
      }
    });
    
    // 从投票记录收集用户
    this.data.voteRecords.forEach(vote => {
      if (vote.voterWikidotId && vote.voterName) {
        const userId = vote.voterWikidotId;
        if (!userMap.has(userId)) {
          userMap.set(userId, {
            displayName: vote.voterName,
            wikidotId: userId,
            roles: new Set(['voter']),
            pagesCreated: 0,
            pagesVoted: 0,
            totalVotesGiven: 0,
            totalVotesReceived: 0
          });
        }
        const user = userMap.get(userId);
        user.roles.add('voter');
        user.totalVotesGiven++;
      }
      
      // 统计被投票作者的投票数
      if (vote.pageAuthorId) {
        const authorUser = userMap.get(vote.pageAuthorId);
        if (authorUser) {
          authorUser.totalVotesReceived++;
        }
      }
    });
    
    // 从贡献者记录收集用户
    this.data.attributions.forEach(attr => {
      if (attr.userId && attr.userName) {
        const userId = attr.userId;
        if (!userMap.has(userId)) {
          userMap.set(userId, {
            displayName: attr.userName,
            wikidotId: userId,
            roles: new Set(['contributor']),
            pagesCreated: 0,
            pagesVoted: 0,
            totalVotesGiven: 0,
            totalVotesReceived: 0
          });
        }
        userMap.get(userId).roles.add('contributor');
      }
    });
    
    // 转换为数组并计算统计信息
    this.data.users = Array.from(userMap.values()).map(user => ({
      displayName: user.displayName,
      wikidotId: user.wikidotId,
      roles: Array.from(user.roles),
      pagesCreated: user.pagesCreated,
      totalVotesGiven: user.totalVotesGiven,
      totalVotesReceived: user.totalVotesReceived,
      netRating: user.totalVotesReceived, // 简化计算
      isActive: user.totalVotesGiven > 0 || user.pagesCreated > 0
    }));
    
    this.stats.usersProcessed = this.data.users.length;
    
    console.log(`✅ 用户数据汇总完成! 总计 ${this.stats.usersProcessed} 个用户`);
    console.log(`   作者: ${this.data.users.filter(u => u.roles.includes('author')).length}`);
    console.log(`   投票者: ${this.data.users.filter(u => u.roles.includes('voter')).length}`);
    console.log(`   贡献者: ${this.data.users.filter(u => u.roles.includes('contributor')).length}`);
  }

  async savePageCheckpoint(totalProcessed, cursor) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `production-data-pages-checkpoint-${totalProcessed}-${timestamp}.json`;
    
    const checkpointData = {
      metadata: {
        timestamp: new Date().toISOString(),
        checkpointType: 'pages',
        totalProcessed: totalProcessed,
        cursor: cursor,
        apiVersion: 'v2'
      },
      pages: this.data.pages,
      revisions: this.data.revisions,
      attributions: this.data.attributions,
      alternateTitles: this.data.alternateTitles,
      stats: {
        pagesProcessed: this.stats.pagesProcessed,
        batchesCompleted: this.stats.batchesCompleted,
        errors: this.stats.errors.length
      }
    };
    
    const filepath = path.join(this.dataDir, filename);
    fs.writeFileSync(filepath, JSON.stringify(checkpointData, null, 2));
    
    // 清理旧的页面checkpoint文件，只保留最新的
    this.cleanupOldPageCheckpoints(totalProcessed);
    
    console.log(`💾 页面检查点已保存: ${filename} (页面: ${totalProcessed}, cursor已保存)`);
    return filepath;
  }

  cleanupOldPageCheckpoints(currentPageCount) {
    try {
      const files = fs.readdirSync(this.dataDir);
      const checkpointFiles = files
        .filter(f => f.startsWith('production-data-pages-checkpoint-') && f.endsWith('.json'))
        .map(f => {
          const match = f.match(/pages-checkpoint-(\d+)-/);
          const pageCount = match ? parseInt(match[1]) : 0;
          return { filename: f, pageCount };
        })
        .filter(f => f.pageCount > 0 && f.pageCount < currentPageCount) // 只删除页面数更少的checkpoint
        .sort((a, b) => a.pageCount - b.pageCount);

      if (checkpointFiles.length > 0) {
        const toDelete = checkpointFiles.slice(0, -2); // 保留最新的2个旧checkpoint以防万一
        
        toDelete.forEach(file => {
          const filePath = path.join(this.dataDir, file.filename);
          try {
            fs.unlinkSync(filePath);
            console.log(`🗑️  已删除旧checkpoint: ${file.filename} (${file.pageCount}页)`);
          } catch (error) {
            console.log(`⚠️  删除checkpoint失败: ${file.filename} - ${error.message}`);
          }
        });
        
        if (toDelete.length > 0) {
          console.log(`✅ 清理完成，删除了 ${toDelete.length} 个旧checkpoint文件`);
        }
      }
    } catch (error) {
      console.log(`⚠️  清理checkpoint时出错: ${error.message}`);
    }
  }

  async saveCurrentData(suffix = '') {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `production-data${suffix ? '-' + suffix : ''}-${timestamp}.json`;
    
    const finalData = {
      metadata: {
        timestamp: new Date().toISOString(),
        apiVersion: 'v2',
        apiEndpoint: 'https://apiv2.crom.avn.sh/graphql',
        syncType: 'production',
        totalPages: this.data.pages.length,
        totalVoteRecords: this.data.voteRecords.length,
        totalUsers: this.data.users.length,
        totalAttributions: this.data.attributions.length,
        totalRevisions: this.data.revisions.length,
        totalAlternateTitles: this.data.alternateTitles.length,
        syncDuration: this.stats.endTime ? (this.stats.endTime - this.stats.startTime) / 1000 : null,
        averageSpeed: this.stats.pagesProcessed / ((Date.now() - this.stats.startTime) / 1000),
        errors: this.stats.errors.length,
        batchesCompleted: this.stats.batchesCompleted,
        features: {
          fuzzyVoteRecords: true,
          userStatistics: true,
          pageAttributions: true,
          hierarchicalPages: true
        },
        limitations: [
          'fuzzyVoteRecords may not be 100% current',
          'Query complexity limited to 1000 per request',
          'No access to accountVoteRecords (requires CRAWLER privilege)'
        ]
      },
      pages: this.data.pages,
      voteRecords: this.data.voteRecords,
      users: this.data.users,
      attributions: this.data.attributions,
      revisions: this.data.revisions,
      alternateTitles: this.data.alternateTitles,
      stats: this.stats
    };
    
    const filepath = path.join(this.dataDir, filename);
    fs.writeFileSync(filepath, JSON.stringify(finalData, null, 2));
    
    const fileSize = (fs.statSync(filepath).size / 1024 / 1024).toFixed(2);
    console.log(`💾 数据已保存: ${filename} (${fileSize} MB)`);
    
    return filepath;
  }

  async generateProductionReport() {
    this.stats.endTime = new Date();
    const duration = (this.stats.endTime - this.stats.startTime) / 1000;
    
    const filepath = await this.saveCurrentData('final');
    
    console.log('\n🎉 API v2 生产环境同步完成！');
    console.log('='.repeat(80));
    console.log(`⏱️  总耗时: ${this.formatDuration(duration)}`);
    console.log(`📄 处理页面: ${this.data.pages.length.toLocaleString()}`);
    console.log(`🗳️  投票记录: ${this.data.voteRecords.length.toLocaleString()}`);
    console.log(`👤 用户数据: ${this.data.users.length.toLocaleString()}`);
    console.log(`👥 贡献记录: ${this.data.attributions.length.toLocaleString()}`);
    console.log(`📝 修订记录: ${this.data.revisions.length.toLocaleString()}`);
    console.log(`🏷️  备用标题: ${this.data.alternateTitles.length.toLocaleString()}`);
    console.log(`⚡ 平均速度: ${(this.stats.pagesProcessed / duration).toFixed(1)} 页面/秒`);
    console.log(`🔄 批次数量: ${this.stats.batchesCompleted}`);
    console.log(`❌ 错误数量: ${this.stats.errors.length}`);
    
    // 详细错误统计
    if (this.stats.errorDetails && Object.keys(this.stats.errorDetails).length > 0) {
      console.log('\n📊 错误类型统计:');
      Object.entries(this.stats.errorDetails)
        .sort(([,a], [,b]) => b - a)
        .forEach(([errorType, count]) => {
          console.log(`   ${errorType}: ${count} 次`);
        });
    }
    
    // 数据质量分析
    const pagesWithVotes = this.data.pages.filter(p => p.voteCount > 0).length;
    const pagesWithContent = this.data.pages.filter(p => p.sourceLength > 0).length;
    const avgVotesPerPage = this.data.voteRecords.length / this.data.pages.length;
    
    console.log('\n📊 数据质量分析:');
    console.log(`   有投票的页面: ${pagesWithVotes} (${(pagesWithVotes/this.data.pages.length*100).toFixed(1)}%)`);
    console.log(`   有内容的页面: ${pagesWithContent} (${(pagesWithContent/this.data.pages.length*100).toFixed(1)}%)`);
    console.log(`   平均投票/页面: ${avgVotesPerPage.toFixed(1)}`);
    
    // 数据质量综合分析
    const fuzzyDataPages = this.stats.dataDiscrepancies?.filter(d => d.reason === 'fuzzy_data_nature') || [];
    const incompleteApiPages = this.stats.incompletePages?.filter(p => p.reason === 'api_incomplete_after_retries') || [];
    
    if (fuzzyDataPages.length > 0) {
      console.log('\n📊 fuzzyVoteRecords 数据差异分析:');
      console.log(`   有显著差异的页面: ${fuzzyDataPages.length}`);
      
      const totalDifference = fuzzyDataPages.reduce((sum, d) => sum + Math.abs(d.difference), 0);
      const avgDifference = totalDifference / fuzzyDataPages.length;
      console.log(`   平均差异: ${avgDifference.toFixed(1)} 票/页面`);
      
      // 按差异类型分类
      const positive = fuzzyDataPages.filter(d => d.difference > 0);
      const negative = fuzzyDataPages.filter(d => d.difference < 0);
      
      console.log(`   缺失投票: ${positive.length} 页 (总计 ${positive.reduce((sum, d) => sum + d.difference, 0)} 票)`);
      console.log(`   多余投票: ${negative.length} 页 (总计 ${Math.abs(negative.reduce((sum, d) => sum + d.difference, 0))} 票)`);
      
      // 显示最大差异的页面
      const sortedByDiff = fuzzyDataPages.sort((a, b) => Math.abs(b.difference) - Math.abs(a.difference));
      console.log(`   最大差异页面 (前3个):`);
      sortedByDiff.slice(0, 3).forEach((d, i) => {
        const sign = d.difference > 0 ? '缺失' : '多余';
        console.log(`     ${i+1}. ${d.pageTitle} - ${sign}: ${Math.abs(d.difference)} (${d.actualVotes}/${d.expectedVotes})`);
      });
      
      console.log('\n💡 这是 fuzzyVoteRecords 的正常特性，不影响数据分析价值');
    } else {
      console.log('\n✅ fuzzyVoteRecords 数据质量良好，无显著差异');
    }
    
    if (incompleteApiPages.length > 0) {
      console.log('\n⚠️  API不完整页面统计:');
      console.log(`   不完整页面数量: ${incompleteApiPages.length}`);
      
      const totalMissing = incompleteApiPages.reduce((sum, p) => sum + p.difference, 0);
      console.log(`   总缺失投票数: ${totalMissing.toLocaleString()}`);
      
      // 按重试次数分组
      const retryStats = {};
      incompleteApiPages.forEach(p => {
        const retries = p.retries || 0;
        retryStats[retries] = (retryStats[retries] || 0) + 1;
      });
      
      console.log('   重试次数分布:');
      Object.entries(retryStats).forEach(([retries, count]) => {
        console.log(`     ${retries}次重试: ${count} 页`);
      });
      
      // 显示缺失最多的页面
      const sortedIncomplete = incompleteApiPages.sort((a, b) => b.difference - a.difference);
      console.log(`   缺失最多的页面 (前3个):`);
      sortedIncomplete.slice(0, 3).forEach((p, i) => {
        console.log(`     ${i+1}. ${p.title} - 缺失: ${p.difference} (${p.actualVotes}/${p.expectedVotes})`);
      });
      
      console.log('\n📋 这些页面在多次重试后仍标记为不完整，已保存可用数据');
    }
    
    console.log('\n🔬 分析能力总结:');
    console.log('✅ 支持的分析类型:');
    console.log('   • "谁给我投票"分析 - 基于fuzzyVoteRecords');
    console.log('   • "我给谁投票"分析 - 基于用户投票历史');
    console.log('   • 投票网络分析 - 用户间投票关系');
    console.log('   • 作者影响力分析 - 基于被投票情况');
    console.log('   • 用户行为模式分析 - 基于投票偏好');
    console.log('   • 社区协作分析 - 基于attributions');
    console.log('   • 内容质量评估 - 基于评分和投票');
    
    console.log(`\n📁 数据已保存到: ${path.resolve(this.dataDir)}`);
    console.log(`📅 结束时间: ${new Date().toLocaleString()}`);
    
    // 保存分析报告
    await this.saveAnalysisGuide();
  }

  async saveAnalysisGuide() {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `analysis-guide-${timestamp}.md`;
    
    const guide = `# SCPPER-CN API v2 数据分析指南

## 数据概况
- **同步时间**: ${new Date().toLocaleString()}
- **页面数量**: ${this.data.pages.length.toLocaleString()}
- **投票记录**: ${this.data.voteRecords.length.toLocaleString()}
- **用户数据**: ${this.data.users.length.toLocaleString()}
- **贡献记录**: ${this.data.attributions.length.toLocaleString()}

## 核心分析能力

### 1. "谁给我投票" 分析
**实现方式**: 基于 \`fuzzyVoteRecords\` 数据
**数据完整性**: 约${((this.data.voteRecords.length / this.data.pages.reduce((sum, p) => sum + p.voteCount, 0)) * 100).toFixed(1)}%

\`\`\`javascript
// 示例：查找特定作者的所有投票者
function getMyVoters(authorName) {
  return voteRecords.filter(vote => vote.pageAuthor === authorName)
    .map(vote => ({
      voter: vote.voterName,
      direction: vote.direction,
      page: vote.pageTitle,
      timestamp: vote.timestamp
    }));
}
\`\`\`

### 2. "我给谁投票" 分析  
**实现方式**: 基于用户ID的投票记录聚合

\`\`\`javascript
// 示例：查找特定用户的投票历史
function getMyVotes(voterName) {
  return voteRecords.filter(vote => vote.voterName === voterName)
    .map(vote => ({
      author: vote.pageAuthor,
      direction: vote.direction,
      page: vote.pageTitle,
      timestamp: vote.timestamp
    }));
}
\`\`\`

### 3. 双向投票关系分析
**实现方式**: 交叉分析投票记录和作者身份

\`\`\`javascript
// 示例：找出相互投票的用户对
function getMutualVoting() {
  const relationships = [];
  // 算法：找出A投票给B，B也投票给A的情况
  // 具体实现需要结合用户作者身份数据
  return relationships;
}
\`\`\`

### 4. 投票网络分析
- **节点**: 用户（作者和投票者）
- **边**: 投票关系（带方向和权重）
- **分析维度**: 中心性、社区发现、影响力传播

### 5. 用户影响力评估
**综合指标**:
- 创作页面数量和质量
- 被投票总数和比例
- 投票行为活跃度
- 在投票网络中的地位

## 数据限制和注意事项

### ✅ 可用功能
- fuzzyVoteRecords: 历史投票记录
- 用户统计信息: 排名、评分、页面数
- 页面贡献关系: attributions
- 页面层次结构: parent/children

### ❌ 受限功能  
- accountVoteRecords: 需要CRAWLER权限
- currentVoteRecords: 需要特殊权限
- 实时投票状态: fuzzy数据可能有延迟

### 数据质量说明
- **fuzzyVoteRecords**: 历史投票数据，可能不是100%当前状态
- **复杂度限制**: 单次查询最大复杂度1000
- **分页限制**: 大量数据需要分批获取

## 推荐分析流程

1. **数据预处理**: 清洗和标准化投票记录
2. **关系建模**: 构建用户-页面-投票三元关系
3. **网络构建**: 基于投票关系构建有向图
4. **特征提取**: 计算网络和用户特征指标
5. **模式发现**: 识别投票模式和用户群体
6. **影响力排名**: 综合多维度指标评估用户影响力

---
*生成时间: ${new Date().toISOString()}*
`;
    
    const filepath = path.join(this.dataDir, filename);
    fs.writeFileSync(filepath, guide);
    
    console.log(`📋 分析指南已保存: ${filename}`);
  }

  async loadExistingPageData() {
    console.log('📥 加载现有页面数据...');
    
    try {
      // 查找最新的数据文件（包括检查点文件）
      const files = fs.readdirSync(this.dataDir);
      let dataFiles = files
        .filter(f => f.startsWith('production-data-') && f.endsWith('.json') && !f.includes('checkpoint'))
        .sort()
        .reverse();

      // 如果没有最终数据文件，尝试使用最新的检查点文件
      if (dataFiles.length === 0) {
        console.log('📋 未找到最终数据文件，尝试使用检查点文件...');
        const checkpointFiles = files
          .filter(f => f.startsWith('production-data-pages-checkpoint-') && f.endsWith('.json'))
          .map(f => {
            // 从文件名中提取页面数量用于排序
            const match = f.match(/pages-checkpoint-(\d+)-/);
            const pageCount = match ? parseInt(match[1]) : 0;
            return { filename: f, pageCount };
          })
          .sort((a, b) => b.pageCount - a.pageCount); // 按页面数量降序排序
        
        if (checkpointFiles.length === 0) {
          throw new Error('未找到任何页面数据文件，请先运行完整同步');
        }
        
        dataFiles = checkpointFiles.map(f => f.filename);
        console.log(`📊 找到 ${checkpointFiles.length} 个检查点文件，最大包含 ${checkpointFiles[0].pageCount} 页面`);
      }

      const latestFile = dataFiles[0];
      console.log(`📂 加载数据文件: ${latestFile}`);
      
      const existingData = JSON.parse(
        fs.readFileSync(path.join(this.dataDir, latestFile), 'utf8')
      );

      if (!existingData.pages || existingData.pages.length === 0) {
        throw new Error('数据文件中没有页面信息');
      }

      // 加载页面数据
      this.data.pages = existingData.pages;
      this.data.revisions = existingData.revisions || [];
      this.data.attributions = existingData.attributions || [];
      this.data.alternateTitles = existingData.alternateTitles || [];
      
      // 重置投票相关数据
      this.data.voteRecords = [];
      this.data.users = [];
      
      console.log(`✅ 已加载 ${this.data.pages.length} 个页面的基础数据`);
      console.log(`   有投票的页面: ${this.data.pages.filter(p => p.voteCount > 0).length}`);
      
    } catch (error) {
      throw new Error(`加载现有页面数据失败: ${error.message}`);
    }
  }

  async syncVoteDataForExistingPages() {
    console.log('🗳️  基于现有页面获取投票数据...');
    
    // 筛选有投票的页面
    const pagesWithVotes = this.data.pages.filter(p => p.voteCount > 0);
    console.log(`📊 需要获取投票数据的页面: ${pagesWithVotes.length}/${this.data.pages.length}`);
    
    // 计算预期投票总数
    this.voteProgress.totalVotesExpected = pagesWithVotes.reduce((sum, p) => sum + p.voteCount, 0);
    console.log(`📊 预期投票记录总数: ${this.voteProgress.totalVotesExpected.toLocaleString()}`);
    
    let processedVotePages = 0;
    
    for (const page of pagesWithVotes) {
      let pageRetries = 0;
      let pageSuccess = false;
      
      // 重试当前页面的投票获取直到成功或达到最大重试次数
      while (!pageSuccess && pageRetries < this.config.maxRetries) {
        try {
          
          // 获取页面的完整投票记录
          const voteResult = await this.fetchPageVotesWithResume(page.url, page.voteCount);
          
          if (voteResult.votes && voteResult.votes.length > 0) {
            for (const vote of voteResult.votes) {
              this.data.voteRecords.push({
                pageUrl: page.url,
                pageTitle: page.title,
                pageAuthor: page.createdByUser,
                pageAuthorId: page.createdByWikidotId,
                voterWikidotId: vote.userWikidotId,
                voterName: vote.user?.displayName,
                direction: vote.direction,
                timestamp: vote.timestamp
              });
              
              // 收集投票用户ID
              if (vote.user?.wikidotId) {
                this.userCache.add(vote.user.wikidotId);
              }
            }
            
            this.stats.votesProcessed += voteResult.votes.length;
            this.voteProgress.totalVotesCollected += voteResult.votes.length;
          }
          
          pageSuccess = true;
          
        } catch (error) {
          pageRetries++;
          await this.handleBatchError(error, 'votes', pageRetries);
          
          if (pageRetries >= this.config.maxRetries) {
            console.log(`\n❌ 页面 ${page.url} 投票获取失败，跳过该页面`);
            break;
          }
        }
      }
      
      processedVotePages++;
      
      // 进度显示
      if (processedVotePages % 10 === 0 || processedVotePages === pagesWithVotes.length) {
        const progress = (processedVotePages / pagesWithVotes.length * 100).toFixed(1);
        const completeness = (this.voteProgress.totalVotesCollected / this.voteProgress.totalVotesExpected * 100).toFixed(1);
        console.log(`🗳️  进度: ${progress}% (${processedVotePages}/${pagesWithVotes.length}) | 投票: ${this.stats.votesProcessed.toLocaleString()} | 完整性: ${completeness}%`);
      }
      
      // 定期保存投票进度检查点
      if (processedVotePages % this.config.maxVotePagesPerRequest === 0) {
        await this.saveVoteProgressCheckpoint();
      }
    }
    
    // 保存最终的投票进度检查点
    await this.saveVoteProgressCheckpoint();
    
    console.log(`\n✅ 投票数据获取完成! 总计 ${this.stats.votesProcessed.toLocaleString()} 条投票记录`);
  }

  async generateVoteOnlyReport() {
    this.stats.endTime = new Date();
    const duration = (this.stats.endTime - this.stats.startTime) / 1000;
    
    const filepath = await this.saveCurrentData('vote-only');
    
    console.log('\n🎉 投票数据获取完成！');
    console.log('='.repeat(50));
    console.log(`⏱️  总耗时: ${this.formatDuration(duration)}`);
    console.log(`📄 现有页面: ${this.data.pages.length.toLocaleString()}`);
    console.log(`🗳️  投票记录: ${this.data.voteRecords.length.toLocaleString()}`);
    console.log(`👤 用户数据: ${this.data.users.length.toLocaleString()}`);
    console.log(`⚡ 平均速度: ${(this.data.pages.filter(p => p.voteCount > 0).length / duration).toFixed(1)} 页面/秒`);
    console.log(`❌ 错误数量: ${this.stats.errors.length}`);
    
    const pagesWithVotes = this.data.pages.filter(p => p.voteCount > 0).length;
    const avgVotesPerPage = this.data.voteRecords.length / pagesWithVotes;
    
    console.log('\n📊 投票数据统计:');
    console.log(`   有投票的页面: ${pagesWithVotes} (${(pagesWithVotes/this.data.pages.length*100).toFixed(1)}%)`);
    console.log(`   平均投票/页面: ${avgVotesPerPage.toFixed(1)}`);
    console.log(`   投票完整性: ${(this.data.voteRecords.length / this.voteProgress.totalVotesExpected * 100).toFixed(1)}%`);
    
    console.log(`\n📁 数据已保存到: ${path.resolve(this.dataDir)}`);
    console.log(`📅 结束时间: ${new Date().toLocaleString()}`);
  }

  extractErrorInfo(error) {
    // 提取详细的错误信息
    const errorInfo = {
      type: 'unknown',
      code: null,
      message: error.message || error.toString(),
      status: error.status || error.statusCode || null,
      originalError: error
    };
    
    // 检查各种错误类型
    if (error.status === 429 || error.statusCode === 429 || error.message.includes('429')) {
      errorInfo.type = 'rate_limit';
      errorInfo.code = '429';
    } else if (error.message.includes('ECONNRESET')) {
      errorInfo.type = 'network';
      errorInfo.code = 'ECONNRESET';
    } else if (error.message.includes('ETIMEDOUT')) {
      errorInfo.type = 'network';
      errorInfo.code = 'ETIMEDOUT';
    } else if (error.message.includes('ENOTFOUND')) {
      errorInfo.type = 'network';
      errorInfo.code = 'ENOTFOUND';
    } else if (error.message.includes('ECONNREFUSED')) {
      errorInfo.type = 'network';
      errorInfo.code = 'ECONNREFUSED';
    } else if (error.response && error.response.errors) {
      // GraphQL 错误
      errorInfo.type = 'graphql';
      const gqlError = error.response.errors[0];
      errorInfo.code = gqlError.extensions?.code || 'GRAPHQL_ERROR';
      errorInfo.message = gqlError.message;
    } else if (error.message.includes('fetch')) {
      errorInfo.type = 'fetch';
      errorInfo.code = 'FETCH_ERROR';
    } else if (error.message.includes('timeout')) {
      errorInfo.type = 'timeout';
      errorInfo.code = 'TIMEOUT';
    } else {
      errorInfo.type = 'other';
      errorInfo.code = error.code || 'UNKNOWN';
    }
    
    return errorInfo;
  }

  async handleBatchError(error, context, retryCount) {
    const errorInfo = this.extractErrorInfo(error);
    
    // 记录详细错误信息用于统计
    if (!this.stats.errorDetails) {
      this.stats.errorDetails = {};
    }
    const errorKey = `${errorInfo.type}_${errorInfo.code}`;
    this.stats.errorDetails[errorKey] = (this.stats.errorDetails[errorKey] || 0) + 1;
    
    // 非常简化的错误输出，但包含错误代码
    if (errorInfo.type === 'rate_limit') {
      this.setWaitingState('rate_limit', this.config.retryDelayMs);
      if (retryCount === 1 || retryCount % 5 === 0) {
        process.stdout.write(`\n⚠️  Rate Limit (${errorInfo.code}) #${retryCount}`);
      } else {
        process.stdout.write('.');
      }
      await this.sleep(this.config.retryDelayMs);
    } else if (errorInfo.type === 'network') {
      this.setWaitingState('network_error', this.config.networkRetryDelayMs);
      if (retryCount === 1 || retryCount % 3 === 0) {
        process.stdout.write(`\n🔌 网络错误 (${errorInfo.code}) #${retryCount}`);
      } else {
        process.stdout.write('.');
      }
      await this.sleep(this.config.networkRetryDelayMs);
    } else {
      this.setWaitingState('other', 3000);
      if (retryCount <= 3) {
        process.stdout.write(`\n❌ 其他错误 (${errorInfo.code || errorInfo.type}) #${retryCount}: ${errorInfo.message.substring(0, 50)}`);
      } else {
        process.stdout.write('.');
      }
      await this.sleep(3000);
    }
    
    this.clearWaitingState();
  }

  async handleError(error, context) {
    const is429Error = error.message.includes('429') || error.status === 429 || 
                       error.message.toLowerCase().includes('rate limit');
    
    // 进一步简化错误信息，特别是429错误
    let errorMessage;
    if (is429Error) {
      errorMessage = 'Rate Limit (429)';
    } else {
      // 对于非429错误，也要简化过长的错误信息
      const rawMessage = error.message || error.toString();
      errorMessage = rawMessage.length > 100 ? rawMessage.substring(0, 100) + '...' : rawMessage;
    }
    
    this.stats.errors.push({
      type: `${context}_error`,
      error: errorMessage,
      timestamp: new Date(),
      is429: is429Error
    });
    
    if (is429Error) {
      // 429错误特殊处理 - 高度简化输出
      const count429 = this.stats.errors.filter(e => e.type === `${context}_error` && e.is429).length;
      
      // 进一步减少输出频率：只在第1,10,20,50次时显示
      if (count429 === 1 || count429 % 10 === 0 || count429 % 50 === 0) {
        process.stdout.write(`\n⚠️  Rate Limit #${count429}，等待${this.config.retryDelayMs/1000}s `);
      } else {
        // 其他时候只显示一个点，表示仍在重试
        process.stdout.write('.');
      }
      
      if (count429 >= this.config.max429Retries) {
        throw new Error(`${context} 429错误过多(${count429}次)，停止同步`);
      }
      
      await this.sleep(this.config.retryDelayMs);
    } else {
      // 普通错误处理
      const generalErrors = this.stats.errors.filter(e => e.type === `${context}_error` && !e.is429).length;
      console.log(`\n❌ ${context}错误: ${errorMessage}`);
      
      if (generalErrors >= this.config.maxRetries) {
        throw new Error(`${context}一般错误过多(${generalErrors}次)，停止同步`);
      }
      
      await this.sleep(3000);
    }
  }

  clearConsecutive429Errors(context) {
    // 清理连续的429错误，保留其他类型的错误
    const recent429Errors = this.stats.errors.filter(e => 
      e.type === `${context}_error` && e.is429 && 
      (Date.now() - new Date(e.timestamp).getTime()) < 60000 // 只清理最近1分钟的429错误
    );
    
    if (recent429Errors.length > 0) {
      // 移除最近的429错误，表示已经恢复
      this.stats.errors = this.stats.errors.filter(e => !recent429Errors.includes(e));
    }
  }

  formatDuration(seconds) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    
    if (hours > 0) return `${hours}h ${minutes}m ${secs}s`;
    if (minutes > 0) return `${minutes}m ${secs}s`;
    return `${secs}s`;
  }

  async rateLimit() {
    const now = Date.now();
    
    // 清理5分钟窗口外的请求记录
    this.rateLimitTracker.requestHistory = this.rateLimitTracker.requestHistory
      .filter(req => now - req.timestamp < this.rateLimitTracker.windowSizeMs);
    
    // 计算当前窗口内的点数使用
    const currentUsage = this.rateLimitTracker.requestHistory
      .reduce((sum, req) => sum + req.points, 0);
    
    const remainingPoints = this.rateLimitTracker.maxPoints - currentUsage;
    const usagePercentage = currentUsage / this.rateLimitTracker.maxPoints;
    
    // 预测下次请求的点数消耗（页面查询通常10-20点，投票查询50点）
    const estimatedNextRequestPoints = this.config.pagesBatchSize * 2 + this.config.votesBatchSize;
    
    let delayMs = Math.max(1000 / this.config.maxRequestsPerSecond, this.rateLimitTracker.adaptiveDelayMs); // 结合基础延迟和自适应延迟
    let waitingReason = null;
    
    if (remainingPoints < estimatedNextRequestPoints || usagePercentage > 0.95) {
      // 点数不足，需要等待窗口滑动
      const oldestRequest = Math.min(...this.rateLimitTracker.requestHistory.map(r => r.timestamp));
      const timeToWait = this.rateLimitTracker.windowSizeMs - (now - oldestRequest) + 1000; // 多等1秒保险
      
      if (timeToWait > 0) {
        delayMs = timeToWait;
        waitingReason = 'rate_limit';
        this.setWaitingState('rate_limit', delayMs);
        console.log(`\n⏳ Rate limit窗口等待: ${Math.ceil(timeToWait/1000)}s (使用率: ${usagePercentage.toFixed(1)}%)`);
      }
    } else if (usagePercentage > 0.8) {
      // 使用率较高，适度减速
      delayMs = Math.max(300, this.rateLimitTracker.adaptiveDelayMs);
      waitingReason = 'rate_limit_throttle';
    } else if (usagePercentage > 0.6) {
      // 中等使用率，轻微减速
      delayMs = Math.max(150, this.rateLimitTracker.adaptiveDelayMs);
    } else if (this.rateLimitTracker.adaptiveDelayMs > 1000) {
      // 自适应延迟激活，即使使用率不高也要应用
      delayMs = this.rateLimitTracker.adaptiveDelayMs;
      waitingReason = 'adaptive_delay';
    }
    
    if (waitingReason) {
      this.setWaitingState(waitingReason, delayMs);
    } else {
      this.clearWaitingState();
    }
    
    await this.sleep(delayMs);
    
    // 记录本次请求（估算点数）
    this.rateLimitTracker.requestHistory.push({
      timestamp: now,
      points: estimatedNextRequestPoints,
      operation: 'api_request'
    });
  }

  setWaitingState(reason, durationMs) {
    this.rateLimitTracker.isWaiting = true;
    this.rateLimitTracker.waitingReason = reason;
    this.rateLimitTracker.waitStartTime = Date.now();
    this.rateLimitTracker.estimatedWaitEndTime = Date.now() + durationMs;
  }

  clearWaitingState() {
    this.rateLimitTracker.isWaiting = false;
    this.rateLimitTracker.waitingReason = null;
    this.rateLimitTracker.waitStartTime = null;
    this.rateLimitTracker.estimatedWaitEndTime = null;
  }

  detectEmptyResponse(result, context) {
    // 检测GraphQL响应是否为空或异常
    let isEmpty = false;
    let hasValidData = true;
    
    if (context === 'pages') {
      // 检查页面数据的完整性
      if (!result.pages || !result.pages.edges) {
        isEmpty = true;
      } else {
        // 检查页面数据是否包含关键字段
        const edges = result.pages.edges;
        if (edges.length > 0) {
          const firstPage = edges[0].node;
          // 检查关键字段是否存在
          if (!firstPage.url || !firstPage.title || firstPage.wikidotId === undefined) {
            isEmpty = true;
            console.log(`⚠️  页面数据字段缺失: ${JSON.stringify(firstPage, null, 2).substring(0, 200)}...`);
          }
        }
      }
    } else if (context === 'votes') {
      // 检查投票数据的完整性
      if (!result.wikidotPage || !result.wikidotPage.fuzzyVoteRecords) {
        isEmpty = true;
      } else {
        const voteData = result.wikidotPage.fuzzyVoteRecords;
        if (voteData.edges && voteData.edges.length > 0) {
          const firstVote = voteData.edges[0].node;
          // 检查投票数据关键字段
          if (!firstVote.userWikidotId || firstVote.direction === undefined || !firstVote.timestamp) {
            isEmpty = true;
            console.log(`⚠️  投票数据字段缺失: ${JSON.stringify(firstVote, null, 2).substring(0, 200)}...`);
          }
        }
      }
    }
    
    if (isEmpty) {
      this.rateLimitTracker.emptyResponseCount++;
      console.log(`⚠️  检测到空响应 #${this.rateLimitTracker.emptyResponseCount} (${context})`);
      
      // 当连续空响应达到阈值时，增加延迟
      if (this.rateLimitTracker.emptyResponseCount >= this.rateLimitTracker.consecutiveEmptyThreshold) {
        this.rateLimitTracker.adaptiveDelayMs = Math.min(
          this.rateLimitTracker.adaptiveDelayMs * 1.5,
          this.rateLimitTracker.maxAdaptiveDelayMs
        );
        console.log(`📈 自适应延迟已增加至 ${this.rateLimitTracker.adaptiveDelayMs}ms`);
      }
      
      hasValidData = false;
    } else {
      // 成功响应，重置空响应计数和自适应延迟
      if (this.rateLimitTracker.emptyResponseCount > 0) {
        console.log(`✅ 数据响应恢复正常，重置空响应计数`);
        this.rateLimitTracker.emptyResponseCount = 0;
        this.rateLimitTracker.adaptiveDelayMs = 1000; // 重置为基础延迟
      }
      hasValidData = true;
    }
    
    return hasValidData;
  }

  async fetchRemainingPages(currentTotal) {
    console.log('🔍 尝试多种方法获取剩余页面...');
    
    try {
      // 方法1: 尝试不使用cursor，直接跳转到最后几页
      const estimatedRemaining = this.progressState.totalPages - currentTotal;
      console.log(`   方法1: 尝试获取最后 ${estimatedRemaining} 页`);
      
      // 使用一个较大的 first 参数来获取剩余页面
      const query = `
        query FetchRemainingPages($filter: PageQueryFilter, $first: Int, $after: ID) {
          pages(filter: $filter, first: $first, after: $after) {
            edges {
              node {
                url
                ... on WikidotPage {
                  wikidotId
                  title
                  rating
                  voteCount
                  category
                  tags
                  createdAt
                  revisionCount
                  commentCount
                  isHidden
                  isUserPage
                  thumbnailUrl
                  source
                  textContent
                  
                  alternateTitles {
                    title
                  }
                  
                  revisions(first: 5) {
                    edges {
                      node {
                        wikidotId
                        timestamp
                        user {
                          ... on WikidotUser {
                            displayName
                            wikidotId
                            unixName
                          }
                        }
                        comment
                      }
                    }
                  }
                  
                  createdBy {
                    ... on WikidotUser {
                      displayName
                      wikidotId
                      unixName
                    }
                  }
                  
                  parent {
                    url
                  }
                  
                  children {
                    url
                  }
                  
                  attributions {
                    type
                    user {
                      ... on WikidotUser {
                        displayName
                        wikidotId
                        unixName
                      }
                    }
                    date
                    order
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
      `;
      
      const variables = {
        filter: {
          onWikidotPage: {
            url: { startsWith: "http://scp-wiki-cn.wikidot.com" }
          }
        },
        first: Math.min(50, estimatedRemaining * 2) // 获取更多以防万一
      };
      
      await this.rateLimit();
      const result = await this.cromClient.request(query, variables);
      
      if (result && result.pages.edges.length > 0) {
        let newPagesFound = 0;
        const existingUrls = new Set(this.data.pages.map(p => p.url));
        
        for (const edge of result.pages.edges) {
          if (!existingUrls.has(edge.node.url)) {
            this.processPageBasic(edge.node);
            newPagesFound++;
          }
        }
        
        if (newPagesFound > 0) {
          console.log(`   ✅ 找到 ${newPagesFound} 个新页面`);
          this.stats.pagesProcessed += newPagesFound;
          
          // 保存更新后的检查点
          await this.savePageCheckpoint(this.stats.pagesProcessed, null);
        } else {
          console.log('   ℹ️  未找到新页面，可能总数统计存在误差');
        }
      }
      
    } catch (error) {
      console.log(`   ⚠️  获取剩余页面失败: ${error.message}`);
      console.log('   继续使用现有数据');
    }
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// 运行生产环境同步
async function runProductionSync(voteOnly = false) {
  const syncService = new ProductionSync({ voteOnly });
  await syncService.runProductionSync();
}

// 仅获取投票数据
async function runVoteOnlySync() {
  const syncService = new ProductionSync({ voteOnly: true });
  await syncService.runProductionSync();
}

export { ProductionSync, runVoteOnlySync };

if (import.meta.url === `file://${process.argv[1]}`) {
  // 检查命令行参数
  const args = process.argv.slice(2);
  const voteOnly = args.includes('--vote-only') || args.includes('--votes');
  
  if (voteOnly) {
    console.log('🗳️  启动仅投票模式...');
    runVoteOnlySync().catch(console.error);
  } else {
    runProductionSync().catch(console.error);
  }
}