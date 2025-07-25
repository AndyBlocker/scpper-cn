import { GraphQLClient } from 'graphql-request';
import fs from 'fs';
import dotenv from 'dotenv';

dotenv.config();

// 优化的数据同步服务
class OptimizedSyncService {
  constructor() {
    this.cromClient = new GraphQLClient(process.env.CROM_API_URL || 'https://apiv1.crom.avn.sh/graphql');
    this.stats = {
      startTime: null,
      endTime: null,
      pagesProcessed: 0,
      batchesCompleted: 0,
      rateLimitUsed: 0,
      errors: [],
      lastRateLimit: null
    };
    
    // 配置参数（基于测试结果优化）
    this.config = {
      batchSize: 3, // 减少批次大小以控制rate limit
      delayBetweenBatches: 2000, // 批次间延迟2秒
      maxRetries: 3,
      rateLimitThreshold: 280000, // 当剩余配额低于此值时暂停
      resetWaitTime: 300000, // 等待5分钟配额重置
      targetPages: 100 // 测试目标：100个页面
    };
    
    this.data = {
      pages: [],
      voteRecords: [],
      revisions: []
    };
  }

  async runOptimizedSync() {
    console.log('🚀 开始优化数据同步测试\n');
    console.log(`配置信息:`);
    console.log(`  批次大小: ${this.config.batchSize} 页面/批次`);
    console.log(`  批次延迟: ${this.config.delayBetweenBatches}ms`);
    console.log(`  目标页面: ${this.config.targetPages} 页面`);
    console.log(`  Rate Limit阈值: ${this.config.rateLimitThreshold}`);
    console.log('');
    
    this.stats.startTime = new Date();
    
    let cursor = null;
    let totalProcessed = 0;
    
    while (totalProcessed < this.config.targetPages) {
      try {
        // 检查Rate Limit状态
        if (this.stats.lastRateLimit && this.stats.lastRateLimit.remaining < this.config.rateLimitThreshold) {
          console.log(`⚠️  Rate Limit剩余 ${this.stats.lastRateLimit.remaining}，低于阈值 ${this.config.rateLimitThreshold}`);
          await this.waitForRateLimit();
        }
        
        console.log(`📦 处理批次 ${this.stats.batchesCompleted + 1}...`);
        
        const result = await this.fetchPageBatch(cursor, this.config.batchSize);
        
        if (!result || !result.pages.edges.length) {
          console.log('✅ 没有更多页面可处理');
          break;
        }
        
        this.stats.lastRateLimit = result.rateLimit;
        this.stats.rateLimitUsed += result.rateLimit.cost;
        
        // 处理页面数据
        for (const edge of result.pages.edges) {
          this.processPageData(edge.node);
          cursor = edge.cursor;
          totalProcessed++;
          
          if (totalProcessed >= this.config.targetPages) {
            console.log(`🎯 达到目标页面数 ${this.config.targetPages}`);
            break;
          }
        }
        
        this.stats.batchesCompleted++;
        
        console.log(`   ✅ 批次完成: ${result.pages.edges.length} 页面`);
        console.log(`   💰 Rate Limit: ${result.rateLimit.cost} (剩余: ${result.rateLimit.remaining})`);
        console.log(`   📊 总进度: ${totalProcessed}/${this.config.targetPages}`);
        
        // 检查是否有下一页
        if (!result.pages.pageInfo.hasNextPage) {
          console.log('✅ 已处理所有可用页面');
          break;
        }
        
        // 批次间延迟
        if (totalProcessed < this.config.targetPages) {
          console.log(`   ⏸️  等待 ${this.config.delayBetweenBatches}ms...\n`);
          await this.sleep(this.config.delayBetweenBatches);
        }
        
      } catch (error) {
        console.error(`❌ 批次处理失败: ${error.message}`);
        this.stats.errors.push({
          type: 'batch_error',
          batchNumber: this.stats.batchesCompleted + 1,
          error: error.message,
          timestamp: new Date()
        });
        
        // 错误重试逻辑
        if (this.stats.errors.filter(e => e.type === 'batch_error').length >= this.config.maxRetries) {
          console.error('❌ 达到最大重试次数，停止同步');
          break;
        }
        
        console.log(`⏸️  错误恢复等待 ${this.config.delayBetweenBatches * 2}ms...`);
        await this.sleep(this.config.delayBetweenBatches * 2);
      }
    }
    
    this.stats.endTime = new Date();
    this.generateOptimizedReport();
  }

  async fetchPageBatch(cursor, batchSize) {
    const pageQuery = `
      query OptimizedPageSync($filter: QueryPagesFilter, $first: Int, $after: ID) {
        pages(filter: $filter, first: $first, after: $after) {
          edges {
            node {
              url
              wikidotInfo {
                title
                category
                wikidotId
                rating
                voteCount
                commentCount
                createdAt
                revisionCount
                tags
                
                createdBy {
                  name
                }
                
                coarseVoteRecords {
                  timestamp
                  userWikidotId
                  direction
                  user {
                    name
                  }
                }
                
                revisions {
                  index
                  timestamp
                  type
                  userWikidotId
                  comment
                  user {
                    name
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
    
    return await this.cromClient.request(pageQuery, variables);
  }

  processPageData(page) {
    const info = page.wikidotInfo;
    
    // 存储页面基础信息
    const pageData = {
      url: page.url,
      title: info.title,
      wikidotId: info.wikidotId,
      category: info.category,
      rating: info.rating,
      voteCount: info.voteCount,
      commentCount: info.commentCount,
      createdAt: info.createdAt,
      revisionCount: info.revisionCount,
      tagsCount: info.tags?.length || 0,
      createdByUser: info.createdBy?.name,
      voteRecordsCount: info.coarseVoteRecords?.length || 0,
      revisionsCount: info.revisions?.length || 0
    };
    
    this.data.pages.push(pageData);
    this.stats.pagesProcessed++;
    
    // 存储投票记录
    if (info.coarseVoteRecords) {
      for (const vote of info.coarseVoteRecords) {
        this.data.voteRecords.push({
          pageUrl: page.url,
          pageTitle: info.title,
          userWikidotId: vote.userWikidotId,
          userName: vote.user?.name,
          timestamp: vote.timestamp,
          direction: vote.direction
        });
      }
    }
    
    // 存储修订记录
    if (info.revisions) {
      for (const revision of info.revisions) {
        this.data.revisions.push({
          pageUrl: page.url,
          pageTitle: info.title,
          revisionIndex: revision.index,
          timestamp: revision.timestamp,
          type: revision.type,
          userWikidotId: revision.userWikidotId,
          userName: revision.user?.name,
          comment: revision.comment
        });
      }
    }
    
    console.log(`     📝 ${info.title} (评分: ${info.rating}, 投票: ${info.voteCount})`);
  }

  async waitForRateLimit() {
    const resetTime = new Date(this.stats.lastRateLimit.resetAt);
    const now = new Date();
    const waitTime = Math.max(resetTime - now, this.config.resetWaitTime);
    
    console.log(`⏳ 等待Rate Limit重置...`);
    console.log(`   重置时间: ${resetTime.toLocaleString()}`);
    console.log(`   等待时长: ${Math.round(waitTime / 1000)}秒`);
    
    await this.sleep(waitTime);
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  generateOptimizedReport() {
    const duration = this.stats.endTime - this.stats.startTime;
    const durationMinutes = Math.round(duration / 1000 / 60 * 100) / 100;
    const pagesPerMinute = this.stats.pagesProcessed / durationMinutes;
    
    // 基于实际性能估算全量同步
    const estimatedFullSyncMinutes = Math.round(30849 / pagesPerMinute);
    const estimatedRateLimitCost = Math.round(this.stats.rateLimitUsed * 30849 / this.stats.pagesProcessed);
    const rateLimitCycles = Math.ceil(estimatedRateLimitCost / 300000); // 每5分钟300k配额
    const estimatedWithWaits = estimatedFullSyncMinutes + (rateLimitCycles - 1) * 5; // 加上等待时间
    
    const report = {
      testConfig: this.config,
      performance: {
        duration: `${durationMinutes} minutes`,
        pagesProcessed: this.stats.pagesProcessed,
        batchesCompleted: this.stats.batchesCompleted,
        rateLimitUsed: this.stats.rateLimitUsed,
        averagePagePerMinute: pagesPerMinute,
        averageCostPerPage: this.stats.rateLimitUsed / this.stats.pagesProcessed
      },
      fullSyncProjection: {
        totalPages: 30849,
        estimatedDuration: `${estimatedWithWaits} minutes (${Math.round(estimatedWithWaits/60*10)/10} hours)`,
        estimatedRateLimitCost: estimatedRateLimitCost,
        rateLimitCycles: rateLimitCycles,
        withWaitTimes: `+${(rateLimitCycles-1)*5} minutes for rate limit resets`
      },
      dataQuality: {
        averageVoteRecordsPerPage: this.data.voteRecords.length / this.stats.pagesProcessed,
        averageRevisionsPerPage: this.data.revisions.length / this.stats.pagesProcessed,
        pagesWithVotes: this.data.pages.filter(p => p.voteRecordsCount > 0).length,
        pagesWithRevisions: this.data.pages.filter(p => p.revisionsCount > 0).length
      },
      errors: this.stats.errors,
      recommendations: this.generateRecommendations(),
      timestamp: new Date().toISOString()
    };
    
    // 保存报告
    fs.writeFileSync('./optimized-sync-report.json', JSON.stringify(report, null, 2));
    
    console.log('\n🎯 优化同步测试完成!');
    console.log('=' .repeat(60));
    console.log(`⏱️  总耗时: ${durationMinutes} 分钟`);
    console.log(`📦 完成批次: ${this.stats.batchesCompleted}`);
    console.log(`📄 处理页面: ${this.stats.pagesProcessed}`);
    console.log(`🗳️  投票记录: ${this.data.voteRecords.length}`);
    console.log(`📝 修订记录: ${this.data.revisions.length}`);
    console.log(`💰 Rate Limit消耗: ${this.stats.rateLimitUsed}`);
    console.log(`❌ 错误数量: ${this.stats.errors.length}`);
    
    console.log('\n📊 性能指标:');
    console.log(`📈 处理速度: ${pagesPerMinute.toFixed(2)} 页面/分钟`);
    console.log(`💰 平均成本: ${(this.stats.rateLimitUsed / this.stats.pagesProcessed).toFixed(1)} 点/页面`);
    
    console.log('\n🔮 全量同步预估:');
    console.log(`⏱️  理论时间: ${estimatedFullSyncMinutes} 分钟`);
    console.log(`⏱️  实际时间: ${estimatedWithWaits} 分钟 (~${Math.round(estimatedWithWaits/60*10)/10} 小时)`);
    console.log(`💰 总成本: ${estimatedRateLimitCost} 点`);
    console.log(`🔄 配额周期: ${rateLimitCycles} 个 (每5分钟)`);
    
    if (this.stats.errors.length > 0) {
      console.log('\n⚠️  错误统计:');
      const errorTypes = {};
      this.stats.errors.forEach(error => {
        errorTypes[error.type] = (errorTypes[error.type] || 0) + 1;
      });
      Object.entries(errorTypes).forEach(([type, count]) => {
        console.log(`   ${type}: ${count} 次`);
      });
    }
    
    console.log('\n💾 详细报告已保存到: ./optimized-sync-report.json');
    
    // 输出建议
    const recommendations = this.generateRecommendations();
    if (recommendations.length > 0) {
      console.log('\n💡 优化建议:');
      recommendations.forEach((rec, i) => {
        console.log(`   ${i+1}. ${rec}`);
      });
    }
  }

  generateRecommendations() {
    const recommendations = [];
    const avgCostPerPage = this.stats.rateLimitUsed / this.stats.pagesProcessed;
    
    if (avgCostPerPage > 15) {
      recommendations.push('减少每次查询的字段数量以降低成本');
    }
    
    if (this.stats.errors.length > 0) {
      recommendations.push('增加错误重试机制和更长的恢复延迟');
    }
    
    const voteRatio = this.data.voteRecords.length / this.stats.pagesProcessed;
    if (voteRatio < 5) {
      recommendations.push('考虑筛选有投票记录的页面以提高数据密度');
    }
    
    if (this.stats.rateLimitUsed > 250000) {
      recommendations.push('使用更小的批次大小或增加批次间延迟');
    }
    
    return recommendations;
  }
}

// 运行优化测试
async function runOptimizedTest() {
  const syncService = new OptimizedSyncService();
  await syncService.runOptimizedSync();
}

runOptimizedTest().catch(console.error);