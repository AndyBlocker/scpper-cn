import { GraphQLClient } from 'graphql-request';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

// 简单的进度条工具
class ProgressBar {
  constructor(total, width = 50) {
    this.total = total;
    this.width = width;
    this.current = 0;
  }

  update(current, info = '') {
    this.current = current;
    const percentage = Math.floor((current / this.total) * 100);
    const filled = Math.floor((current / this.total) * this.width);
    const empty = this.width - filled;
    
    const bar = '█'.repeat(filled) + '░'.repeat(empty);
    const line = `\r[${bar}] ${percentage}% (${current.toLocaleString()}/${this.total.toLocaleString()}) ${info}`;
    
    process.stdout.write(line);
    
    if (current >= this.total) {
      process.stdout.write('\n');
    }
  }
}

// 智能频率控制的数据拉取服务
class RateLimitedPuller {
  constructor() {
    this.cromClient = new GraphQLClient(process.env.CROM_API_URL || 'https://apiv1.crom.avn.sh/graphql');
    
    this.dataDir = './rate-limited-sync-data';
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }
    
    this.stats = {
      startTime: null,
      endTime: null,
      pagesProcessed: 0,
      batchesCompleted: 0,
      rateLimitUsed: 0,
      errors: [],
      lastRateLimit: null,
      requestTimes: [] // 记录请求时间用于频率控制
    };
    
    // 🚀 频率优先配置
    this.config = {
      batchSize: 10, // 更大的批次大小充分利用每次请求
      maxRequestsPerSecond: 1.8, // 稍微保守，确保不超过2/秒
      rateLimitThreshold: 200000, // 更激进的阈值
      checkpointInterval: 2000, // 每2000个页面保存检查点
      targetPages: 30849
    };
    
    this.data = {
      pages: [],
      users: [],
      voteRecords: [],
      revisions: [],
      attributions: [],
      relations: [],
      alternateTitles: []
    };
    
    this.pageProgressBar = null;
  }

  async runRateLimitedPull() {
    console.log('⚡ 开始频率优化全量数据拉取');
    console.log('=' .repeat(80));
    console.log(`🎯 目标: ${this.config.targetPages.toLocaleString()} 页面`);
    console.log(`📊 频率配置:`);
    console.log(`   最大请求频率: ${this.config.maxRequestsPerSecond}/秒`);
    console.log(`   批次大小: ${this.config.batchSize} 页面/批次`);
    console.log(`   理论最大速度: ${this.config.maxRequestsPerSecond * this.config.batchSize} 页面/秒`);
    console.log(`   预估时间: ~${Math.round(this.config.targetPages / (this.config.maxRequestsPerSecond * this.config.batchSize) / 3600 * 10) / 10} 小时`);
    console.log('');
    
    this.stats.startTime = new Date();
    this.cleanupOldData();
    
    // 初始化进度条
    this.pageProgressBar = new ProgressBar(this.config.targetPages);
    
    await this.pullPageDataWithRateLimit();
    
    console.log('\n🔄 开始拉取用户数据...');
    await this.pullUserData();
    
    this.stats.endTime = new Date();
    await this.generateFinalReport();
  }

  async pullPageDataWithRateLimit() {
    let cursor = null;
    let totalProcessed = 0;
    let rawDataBatch = [];
    
    try {
      while (totalProcessed < this.config.targetPages) {
        // 🚀 智能频率控制 - 核心优化
        await this.enforceRateLimit();
        
        // 检查Rate Limit配额
        if (this.stats.lastRateLimit && this.stats.lastRateLimit.remaining < this.config.rateLimitThreshold) {
          await this.handleRateLimitWait();
        }
        
        const requestStartTime = Date.now();
        
        try {
          const result = await this.fetchPageBatch(cursor, this.config.batchSize);
          
          if (!result || !result.pages.edges.length) {
            break;
          }
          
          // 记录请求时间用于频率控制
          this.stats.requestTimes.push(Date.now());
          this.cleanupOldRequestTimes();
          
          // 保存原始数据
          const rawDataStr = JSON.stringify(result, null, 2);
          rawDataBatch.push(result);
          
          this.stats.lastRateLimit = result.rateLimit;
          this.stats.rateLimitUsed += result.rateLimit.cost;
          
          // 处理页面数据
          let batchProcessed = 0;
          let currentPageInfo = '';
          for (const edge of result.pages.edges) {
            const page = edge.node;
            this.processPageData(page);
            cursor = edge.cursor;
            totalProcessed++;
            batchProcessed++;
            
            currentPageInfo = `${page.wikidotInfo?.title?.substring(0, 25) || 'Unknown'}... (评分: ${page.wikidotInfo?.rating || 0})`;
            
            // 计算实时速度和ETA
            const elapsed = (Date.now() - this.stats.startTime) / 1000;
            const currentSpeed = (totalProcessed / elapsed).toFixed(1);
            const eta = this.calculateETA(totalProcessed, this.stats.startTime, this.config.targetPages);
            
            // 更新进度条
            this.pageProgressBar.update(totalProcessed, `${currentSpeed}/s | ETA: ${eta} | ${currentPageInfo}`);
            
            if (totalProcessed >= this.config.targetPages) {
              break;
            }
          }
          
          this.stats.batchesCompleted++;
          this.stats.pagesProcessed = totalProcessed;
          
          // 定期保存检查点
          if (totalProcessed % this.config.checkpointInterval === 0 || totalProcessed >= this.config.targetPages) {
            console.log(`\n💾 保存检查点 ${Math.floor(totalProcessed / this.config.checkpointInterval)}...`);
            await this.saveCheckpoint(totalProcessed, rawDataBatch, 'pages');
            rawDataBatch = [];
            this.showCurrentStats(totalProcessed);
          }
          
          // 检查是否有下一页
          if (!result.pages.pageInfo.hasNextPage) {
            break;
          }
          
        } catch (error) {
          console.log(`\n❌ 批次处理失败: ${error.message}`);
          this.stats.errors.push({
            type: 'batch_error',
            batchNumber: this.stats.batchesCompleted + 1,
            totalProcessed,
            error: error.message,
            timestamp: new Date()
          });
          
          if (this.stats.errors.length >= 5) {
            console.log('\n❌ 错误过多，停止页面同步');
            break;
          }
          
          // 错误后等待更长时间
          await this.sleep(2000);
        }
      }
    } catch (error) {
      console.log(`\n❌ 页面拉取严重错误: ${error.message}`);
    }
    
    console.log(`\n✅ 页面数据拉取完成! 共处理 ${totalProcessed.toLocaleString()} 页面`);
  }

  // 🚀 核心优化：智能频率控制
  async enforceRateLimit() {
    const now = Date.now();
    const oneSecondAgo = now - 1000;
    
    // 清理1秒前的请求记录
    this.stats.requestTimes = this.stats.requestTimes.filter(time => time > oneSecondAgo);
    
    // 如果1秒内的请求数已达到限制，等待
    if (this.stats.requestTimes.length >= this.config.maxRequestsPerSecond) {
      const oldestRequest = Math.min(...this.stats.requestTimes);
      const waitTime = 1000 - (now - oldestRequest) + 50; // 加50ms缓冲
      
      if (waitTime > 0) {
        await this.sleep(waitTime);
      }
    }
  }

  cleanupOldRequestTimes() {
    // 只保留最近5秒的请求时间记录
    const fiveSecondsAgo = Date.now() - 5000;
    this.stats.requestTimes = this.stats.requestTimes.filter(time => time > fiveSecondsAgo);
  }

  async fetchPageBatch(cursor, batchSize) {
    const pageQuery = `
      query RateLimitedPull($filter: QueryPagesFilter, $first: Int, $after: ID) {
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
                realtimeRating
                realtimeVoteCount
                commentCount
                createdAt
                revisionCount
                source
                textContent
                tags
                isPrivate
                thumbnailUrl
                
                createdBy {
                  name
                  wikidotInfo {
                    displayName
                    wikidotId
                    unixName
                  }
                }
                
                parent {
                  url
                  wikidotInfo { title }
                }
                
                children {
                  url
                  wikidotInfo { title }
                }
                
                coarseVoteRecords {
                  timestamp
                  userWikidotId
                  direction
                  user { name }
                }
                
                revisions {
                  index
                  wikidotId
                  timestamp
                  type
                  userWikidotId
                  comment
                  user { name }
                }
              }
              
              attributions {
                type
                user {
                  name
                  wikidotInfo {
                    displayName
                    wikidotId
                  }
                }
                date
                order
                isCurrent
              }
              
              alternateTitles {
                type
                title
              }
              
              translations {
                url
                wikidotInfo { title }
              }
              
              translationOf {
                url
                wikidotInfo { title }
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
    
    // 处理页面基础信息
    const pageData = {
      url: page.url,
      title: info.title,
      wikidotId: info.wikidotId,
      category: info.category,
      rating: info.rating,
      voteCount: info.voteCount,
      realtimeRating: info.realtimeRating,
      realtimeVoteCount: info.realtimeVoteCount,
      commentCount: info.commentCount,
      createdAt: info.createdAt,
      revisionCount: info.revisionCount,
      sourceLength: info.source?.length || 0,
      textContentLength: info.textContent?.length || 0,
      tagsCount: info.tags?.length || 0,
      isPrivate: info.isPrivate,
      createdByUser: info.createdBy?.name,
      parentUrl: info.parent?.url,
      thumbnailUrl: info.thumbnailUrl,
      childrenCount: info.children?.length || 0,
      voteRecordsCount: info.coarseVoteRecords?.length || 0,
      revisionsCount: info.revisions?.length || 0,
      attributionsCount: page.attributions?.length || 0,
      alternateTitlesCount: page.alternateTitles?.length || 0,
      translationsCount: page.translations?.length || 0,
      hasTranslationOf: !!page.translationOf
    };
    
    this.data.pages.push(pageData);
    
    // 处理相关数据
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
    
    if (info.revisions) {
      for (const revision of info.revisions) {
        this.data.revisions.push({
          pageUrl: page.url,
          pageTitle: info.title,
          revisionIndex: revision.index,
          wikidotId: revision.wikidotId,
          timestamp: revision.timestamp,
          type: revision.type,
          userWikidotId: revision.userWikidotId,
          userName: revision.user?.name,
          comment: revision.comment
        });
      }
    }
    
    // 处理其他关系数据...
    if (page.attributions) {
      for (const attr of page.attributions) {
        this.data.attributions.push({
          pageUrl: page.url,
          userName: attr.user.name,
          attributionType: attr.type,
          date: attr.date,
          orderIndex: attr.order,
          isCurrent: attr.isCurrent
        });
      }
    }
  }

  async pullUserData() {
    // 用户数据拉取逻辑（简化版）
    try {
      const userQuery = `
        query PullAllUsers($filter: SearchUsersFilter) {
          searchUsers(query: "", filter: $filter) {
            name
            wikidotInfo {
              displayName
              wikidotId
              unixName
            }
            statistics {
              rank
              totalRating
              meanRating
              pageCount
              pageCountScp
              pageCountTale
              pageCountGoiFormat
              pageCountArtwork
              pageCountLevel
              pageCountEntity
              pageCountObject
            }
          }
          rateLimit {
            cost
            remaining
            resetAt
          }
        }
      `;
      
      const result = await this.cromClient.request(userQuery, {
        filter: {
          anyBaseUrl: [process.env.TARGET_SITE_URL || 'http://scp-wiki-cn.wikidot.com']
        }
      });
      
      console.log(`📊 发现 ${result.searchUsers.length} 个用户`);
      
      for (const user of result.searchUsers) {
        this.data.users.push({
          name: user.name,
          displayName: user.wikidotInfo?.displayName,
          wikidotId: user.wikidotInfo?.wikidotId,
          unixName: user.wikidotInfo?.unixName,
          rank: user.statistics?.rank,
          totalRating: user.statistics?.totalRating,
          meanRating: user.statistics?.meanRating,
          pageCount: user.statistics?.pageCount,
          pageCountScp: user.statistics?.pageCountScp,
          pageCountTale: user.statistics?.pageCountTale,
          pageCountGoiFormat: user.statistics?.pageCountGoiFormat,
          pageCountArtwork: user.statistics?.pageCountArtwork,
          pageCountLevel: user.statistics?.pageCountLevel,
          pageCountEntity: user.statistics?.pageCountEntity,
          pageCountObject: user.statistics?.pageCountObject
        });
      }
      
      this.stats.rateLimitUsed += result.rateLimit.cost;
      console.log(`✅ 用户数据拉取完成! 共 ${result.searchUsers.length} 用户`);
      
    } catch (error) {
      console.log(`❌ 用户数据拉取失败: ${error.message}`);
    }
  }

  calculateETA(current, startTime, total) {
    if (current === 0) return 'N/A';
    
    const elapsed = Date.now() - startTime;
    const rate = current / elapsed;
    const remaining = total - current;
    const eta = remaining / rate;
    
    const hours = Math.floor(eta / 1000 / 60 / 60);
    const minutes = Math.floor((eta % (1000 * 60 * 60)) / 1000 / 60);
    
    if (hours > 0) {
      return `${hours}h ${minutes}m`;
    } else {
      return `${minutes}m`;
    }
  }

  showCurrentStats(processed) {
    const elapsed = (Date.now() - this.stats.startTime) / 1000 / 60;
    const rate = processed / elapsed;
    
    console.log(`\n📊 当前统计:`);
    console.log(`   已处理: ${processed.toLocaleString()} 页面`);
    console.log(`   平均速度: ${rate.toFixed(1)} 页面/分钟`);
    console.log(`   投票记录: ${this.data.voteRecords.length.toLocaleString()}`);
    console.log(`   修订记录: ${this.data.revisions.length.toLocaleString()}`);
    console.log(`   Rate Limit剩余: ${this.stats.lastRateLimit?.remaining?.toLocaleString() || 'N/A'}`);
  }

  async saveCheckpoint(currentProgress, rawDataBatch, phase = 'pages') {
    // 简化的检查点保存
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    
    if (rawDataBatch.length > 0) {
      const rawDataPath = path.join(this.dataDir, `raw-batch-${phase}-${timestamp}.json`);
      fs.writeFileSync(rawDataPath, JSON.stringify(rawDataBatch, null, 2));
    }
    
    const checkpointData = {
      progress: currentProgress,
      timestamp: new Date(),
      dataCount: {
        pages: this.data.pages.length,
        users: this.data.users.length,
        voteRecords: this.data.voteRecords.length,
        revisions: this.data.revisions.length
      }
    };
    
    const checkpointPath = path.join(this.dataDir, `checkpoint-${phase}-${timestamp}.json`);
    fs.writeFileSync(checkpointPath, JSON.stringify(checkpointData, null, 2));
  }

  async handleRateLimitWait() {
    const resetTime = new Date(this.stats.lastRateLimit.resetAt);
    const waitTime = Math.max(resetTime - Date.now() + 10000, 60000);
    
    console.log(`\n⏳ Rate Limit配额不足，等待 ${Math.round(waitTime/1000)}秒...`);
    await this.sleep(waitTime);
  }

  async generateFinalReport() {
    const duration = (this.stats.endTime - this.stats.startTime) / 1000 / 3600;
    const avgSpeed = this.stats.pagesProcessed / duration;
    
    const report = {
      summary: {
        duration: `${duration.toFixed(2)} hours`,
        pagesProcessed: this.stats.pagesProcessed,
        usersProcessed: this.data.users.length,
        avgSpeed: `${avgSpeed.toFixed(1)} pages/hour`,
        rateLimitUsed: this.stats.rateLimitUsed,
        errors: this.stats.errors.length
      },
      dataCollected: {
        pages: this.data.pages.length,
        users: this.data.users.length,
        voteRecords: this.data.voteRecords.length,
        revisions: this.data.revisions.length,
        attributions: this.data.attributions.length
      },
      timestamp: new Date().toISOString()
    };
    
    // 保存报告和数据
    const reportPath = path.join(this.dataDir, `final-report-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    
    const dataPath = path.join(this.dataDir, `final-data-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    fs.writeFileSync(dataPath, JSON.stringify(this.data, null, 2));
    
    console.log('\n🎉 频率优化全量拉取完成!');
    console.log(`⏱️  总耗时: ${duration.toFixed(2)} 小时`);
    console.log(`📄 页面数: ${this.stats.pagesProcessed.toLocaleString()}`);
    console.log(`👤 用户数: ${this.data.users.length.toLocaleString()}`);
    console.log(`🗳️  投票记录: ${this.data.voteRecords.length.toLocaleString()}`);
    console.log(`📝 修订记录: ${this.data.revisions.length.toLocaleString()}`);
    console.log(`📈 平均速度: ${avgSpeed.toFixed(1)} 页面/小时`);
    console.log(`💰 Rate Limit消耗: ${this.stats.rateLimitUsed.toLocaleString()}`);
    console.log(`📁 数据已保存到: ${this.dataDir}/`);
  }

  cleanupOldData() {
    if (fs.existsSync(this.dataDir)) {
      const files = fs.readdirSync(this.dataDir);
      if (files.length > 0) {
        console.log(`🧹 清理旧数据文件 (${files.length} 个)...`);
        for (const file of files) {
          fs.unlinkSync(path.join(this.dataDir, file));
        }
      }
    }
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// 运行频率优化版本
async function runRateLimitedPull() {
  console.log('🌟 SCPPER-CN 频率优化数据拉取开始');
  console.log(`开始时间: ${new Date().toLocaleString()}`);
  console.log('');
  
  const puller = new RateLimitedPuller();
  await puller.runRateLimitedPull();
  
  console.log('');
  console.log(`结束时间: ${new Date().toLocaleString()}`);
  console.log('🌟 频率优化拉取任务完成');
}

runRateLimitedPull().catch(console.error);