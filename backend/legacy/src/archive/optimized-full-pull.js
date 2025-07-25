import { GraphQLClient } from 'graphql-request';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

// 优化后的全量数据拉取（速度优化版）
class OptimizedFullPuller {
  constructor() {
    this.cromClient = new GraphQLClient(process.env.CROM_API_URL || 'https://apiv1.crom.avn.sh/graphql');
    
    this.dataDir = './optimized-sync-data';
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }
    
    this.stats = {
      startTime: null,
      endTime: null,
      pagesProcessed: 0,
      rateLimitUsed: 0,
      errors: [],
      lastRateLimit: null
    };
    
    // 🚀 优化后的配置
    this.config = {
      batchSize: 10, // 增加批次大小，更好利用Rate Limit
      delayBetweenBatches: 500, // 减少延迟到0.5秒
      maxRetries: 3,
      rateLimitThreshold: 200000, // 更激进的阈值
      targetPages: 30849
    };
    
    this.data = {
      pages: [],
      users: [],
      voteRecords: [],
      revisions: []
    };
  }

  async runOptimizedPull() {
    console.log('⚡ 开始优化版全量数据拉取');
    console.log('=' .repeat(70));
    console.log(`🎯 目标: ${this.config.targetPages.toLocaleString()} 页面`);
    console.log(`📦 优化配置:`);
    console.log(`   批次大小: ${this.config.batchSize} 页面/批次`);
    console.log(`   批次延迟: ${this.config.delayBetweenBatches}ms`);
    console.log(`   预估速度: ~${Math.round(this.config.batchSize / (this.config.delayBetweenBatches + 500) * 1000)} 页面/秒`);
    console.log(`   预估时间: ~${Math.round(this.config.targetPages / (this.config.batchSize / (this.config.delayBetweenBatches + 500) * 1000) / 3600 * 10) / 10} 小时`);
    console.log('');
    
    this.stats.startTime = new Date();
    
    let cursor = null;
    let totalProcessed = 0;
    let consecutiveErrors = 0;
    
    while (totalProcessed < this.config.targetPages) {
      const batchStart = Date.now();
      
      try {
        // 检查Rate Limit
        if (this.stats.lastRateLimit && this.stats.lastRateLimit.remaining < this.config.rateLimitThreshold) {
          await this.handleRateLimitWait();
        }
        
        const result = await this.fetchOptimizedBatch(cursor, this.config.batchSize);
        
        if (!result || !result.pages.edges.length) {
          break;
        }
        
        this.stats.lastRateLimit = result.rateLimit;
        this.stats.rateLimitUsed += result.rateLimit.cost;
        
        // 快速处理页面数据
        for (const edge of result.pages.edges) {
          this.processPageQuickly(edge.node);
          cursor = edge.cursor;
          totalProcessed++;
          
          if (totalProcessed >= this.config.targetPages) {
            break;
          }
        }
        
        const batchTime = Date.now() - batchStart;
        const currentSpeed = (result.pages.edges.length / batchTime * 1000).toFixed(1);
        const avgSpeed = (totalProcessed / ((Date.now() - this.stats.startTime) / 1000)).toFixed(1);
        
        // 更简洁的进度显示
        const progress = (totalProcessed / this.config.targetPages * 100).toFixed(1);
        const eta = this.calculateQuickETA(totalProcessed);
        
        process.stdout.write(`\r⚡ 进度: ${progress}% (${totalProcessed.toLocaleString()}/${this.config.targetPages.toLocaleString()}) | 速度: ${currentSpeed}/s | 平均: ${avgSpeed}/s | ETA: ${eta} | RL: ${result.rateLimit.remaining.toLocaleString()}`);
        
        consecutiveErrors = 0; // 重置错误计数
        
        // 检查是否有下一页
        if (!result.pages.pageInfo.hasNextPage) {
          break;
        }
        
        // 动态调整延迟
        const targetDelay = this.calculateOptimalDelay(result.rateLimit);
        await this.sleep(targetDelay);
        
      } catch (error) {
        consecutiveErrors++;
        console.log(`\n❌ 批次失败: ${error.message} (连续错误: ${consecutiveErrors})`);
        
        if (consecutiveErrors >= this.config.maxRetries) {
          console.log('❌ 达到最大重试次数，停止拉取');
          break;
        }
        
        // 指数退避
        await this.sleep(this.config.delayBetweenBatches * Math.pow(2, consecutiveErrors));
      }
    }
    
    console.log('\n');
    this.stats.endTime = new Date();
    await this.generateQuickReport();
  }

  async fetchOptimizedBatch(cursor, batchSize) {
    // 🚀 精简的GraphQL查询，只获取关键数据
    const optimizedQuery = `
      query OptimizedPull($filter: QueryPagesFilter, $first: Int, $after: ID) {
        pages(filter: $filter, first: $first, after: $after) {
          edges {
            node {
              url
              wikidotInfo {
                title
                wikidotId
                rating
                voteCount
                createdAt
                createdBy { name }
                
                # 只获取投票记录的关键信息
                coarseVoteRecords {
                  timestamp
                  userWikidotId
                  direction
                  user { name }
                }
                
                # 只获取最近的修订记录
                revisions(last: 5) {
                  index
                  timestamp
                  type
                  userWikidotId
                  user { name }
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
        rateLimit {
          cost
          remaining
          resetAt
        }
      }
    `;
    
    const variables = {
      filter: {
        url: { startsWith: process.env.TARGET_SITE_URL || 'http://scp-wiki-cn.wikidot.com' }
      },
      first: batchSize
    };
    
    if (cursor) {
      variables.after = cursor;
    }
    
    return await this.cromClient.request(optimizedQuery, variables);
  }

  processPageQuickly(page) {
    const info = page.wikidotInfo;
    
    // 只存储关键页面信息
    this.data.pages.push({
      url: page.url,
      title: info.title,
      wikidotId: info.wikidotId,
      rating: info.rating,
      voteCount: info.voteCount,
      createdAt: info.createdAt,
      createdByUser: info.createdBy?.name,
      voteRecordsCount: info.coarseVoteRecords?.length || 0,
      revisionsCount: info.revisions?.length || 0
    });
    
    this.stats.pagesProcessed++;
    
    // 快速处理投票记录
    if (info.coarseVoteRecords) {
      for (const vote of info.coarseVoteRecords) {
        this.data.voteRecords.push({
          pageUrl: page.url,
          userWikidotId: vote.userWikidotId,
          userName: vote.user?.name,
          timestamp: vote.timestamp,
          direction: vote.direction
        });
      }
    }
    
    // 快速处理修订记录
    if (info.revisions) {
      for (const revision of info.revisions) {
        this.data.revisions.push({
          pageUrl: page.url,
          revisionIndex: revision.index,
          timestamp: revision.timestamp,
          type: revision.type,
          userWikidotId: revision.userWikidotId,
          userName: revision.user?.name
        });
      }
    }
  }

  calculateOptimalDelay(rateLimit) {
    // 🧠 智能延迟调整
    const remaining = rateLimit.remaining;
    const baseDelay = this.config.delayBetweenBatches;
    
    if (remaining > 280000) {
      return Math.max(baseDelay * 0.5, 200); // 配额充足时加速
    } else if (remaining > 250000) {
      return baseDelay; // 正常速度
    } else if (remaining > 200000) {
      return baseDelay * 1.5; // 稍微减速
    } else {
      return baseDelay * 2; // 配额不足时减速
    }
  }

  calculateQuickETA(current) {
    if (current === 0) return 'N/A';
    
    const elapsed = (Date.now() - this.stats.startTime) / 1000;
    const rate = current / elapsed;
    const remaining = this.config.targetPages - current;
    const etaSeconds = remaining / rate;
    
    const hours = Math.floor(etaSeconds / 3600);
    const minutes = Math.floor((etaSeconds % 3600) / 60);
    
    if (hours > 0) {
      return `${hours}h${minutes}m`;
    } else {
      return `${minutes}m`;
    }
  }

  async handleRateLimitWait() {
    const resetTime = new Date(this.stats.lastRateLimit.resetAt);
    const waitTime = Math.max(resetTime - Date.now() + 5000, 30000);
    
    console.log(`\n⏳ Rate Limit等待 ${Math.round(waitTime/1000)}s...`);
    await this.sleep(waitTime);
  }

  async generateQuickReport() {
    const duration = (this.stats.endTime - this.stats.startTime) / 1000 / 3600;
    const avgSpeed = this.stats.pagesProcessed / duration;
    
    // 快速保存核心数据
    const coreData = {
      summary: {
        duration: `${duration.toFixed(2)} hours`,
        pagesProcessed: this.stats.pagesProcessed,
        avgSpeed: `${avgSpeed.toFixed(1)} pages/hour`,
        rateLimitUsed: this.stats.rateLimitUsed,
        errors: this.stats.errors.length
      },
      data: {
        pages: this.data.pages.length,
        voteRecords: this.data.voteRecords.length,
        revisions: this.data.revisions.length
      },
      timestamp: new Date().toISOString()
    };
    
    const reportPath = path.join(this.dataDir, `optimized-report-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    fs.writeFileSync(reportPath, JSON.stringify(coreData, null, 2));
    
    // 保存数据
    const dataPath = path.join(this.dataDir, `optimized-data-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    fs.writeFileSync(dataPath, JSON.stringify(this.data, null, 2));
    
    console.log('🎉 优化版全量拉取完成!');
    console.log(`⏱️  总耗时: ${duration.toFixed(2)} 小时`);
    console.log(`📄 处理页面: ${this.stats.pagesProcessed.toLocaleString()}`);
    console.log(`🗳️  投票记录: ${this.data.voteRecords.length.toLocaleString()}`);
    console.log(`📝 修订记录: ${this.data.revisions.length.toLocaleString()}`);
    console.log(`📈 平均速度: ${avgSpeed.toFixed(1)} 页面/小时`);
    console.log(`💰 Rate Limit消耗: ${this.stats.rateLimitUsed.toLocaleString()}`);
    console.log(`📁 数据已保存到: ${this.dataDir}`);
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// 运行优化版本
async function runOptimized() {
  const puller = new OptimizedFullPuller();
  await puller.runOptimizedPull();
}

runOptimized().catch(console.error);