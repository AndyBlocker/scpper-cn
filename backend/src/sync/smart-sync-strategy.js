import { GraphQLClient } from 'graphql-request';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

/**
 * 智能同步策略：分层数据维护
 * 
 * 核心思路：
 * 1. 每日全量页面基础信息同步（评分、投票数等轻量数据）
 * 2. 基于变化检测的增量投票记录同步
 * 3. 智能Rate Limit分配和优化
 */
class SmartSyncStrategy {
  constructor() {
    this.cromClient = new GraphQLClient('https://apiv2.crom.avn.sh/graphql');
    
    this.config = {
      // Rate Limit配置（300,000点/5分钟）
      rateLimitPoints: 300000,
      rateLimitWindowMs: 5 * 60 * 1000,
      safetyMargin: 0.85, // 只使用85%的配额，留出安全余量
      
      // 分层同步配置
      dailyFullSyncSchedule: '02:00', // 每日凌晨2点进行全量基础数据同步
      voteIncrementalInterval: 4 * 60 * 60 * 1000, // 每4小时进行一次增量投票同步
      
      // 批次大小配置
      pageMetadataBatchSize: 20,  // 页面基础信息批次（只获取轻量数据）
      voteDetailBatchSize: 5,     // 详细投票记录批次
      changeDetectionBatchSize: 50, // 变化检测批次
      
      // 智能优化配置
      voteChangeThreshold: 0.05,  // 投票变化阈值（5%变化才触发详细同步）
      priorityPagesPath: './priority-pages.json', // 优先页面列表
      recentDaysThreshold: 7,     // 最近几天的页面优先处理
    };
    
    this.data = {
      pageMetadata: new Map(),    // 页面基础数据缓存
      voteHistory: new Map(),     // 投票历史记录
      changeLog: [],              // 变化日志
      syncHistory: []             // 同步历史
    };
    
    this.stats = {
      dailyFullSync: { lastRun: null, pagesProcessed: 0, pointsUsed: 0 },
      incrementalSync: { lastRun: null, pagesChecked: 0, pagesUpdated: 0, pointsUsed: 0 },
      totalPointsUsed: 0,
      efficiencyRatio: 0  // 有效更新/总检查数
    };
  }

  /**
   * 主调度器：根据时间和需求选择执行策略
   */
  async run(forceMode = null) {
    console.log('🚀 智能同步策略启动');
    console.log('='.repeat(60));
    
    const now = new Date();
    const currentHour = now.getHours();
    const lastFullSync = this.stats.dailyFullSync.lastRun ? 
      new Date(this.stats.dailyFullSync.lastRun) : null;
    
    const shouldRunFullSync = forceMode === 'full' || 
      (currentHour === 2 && (!lastFullSync || now - lastFullSync > 20 * 60 * 60 * 1000));
    
    const shouldRunIncremental = forceMode === 'incremental' || 
      (!shouldRunFullSync && this.shouldRunIncrementalSync());

    if (shouldRunFullSync) {
      await this.runDailyFullSync();
    } else if (shouldRunIncremental) {
      await this.runIncrementalVoteSync();
    } else {
      console.log('⏰ 当前时间不需要同步，等待下次调度');
      this.showNextSchedule();
    }
    
    await this.generateReport();
  }

  /**
   * 每日全量基础数据同步
   * 目标：获取所有页面的基础信息，识别有变化的页面
   */
  async runDailyFullSync() {
    console.log('📊 执行每日全量基础数据同步');
    const startTime = Date.now();
    const pointsBudget = Math.floor(this.config.rateLimitPoints * this.config.safetyMargin);
    
    try {
      // 第一步：获取所有页面的轻量级基础信息
      console.log('🔍 步骤1：获取页面基础信息...');
      const pageChanges = await this.scanAllPagesBasicInfo(pointsBudget * 0.6);
      
      // 第二步：对有显著变化的页面进行详细检查
      console.log('🎯 步骤2：检查有变化的页面...');
      if (pageChanges.length > 0) {
        await this.processChangedPages(pageChanges, pointsBudget * 0.4);
      }
      
      // 第三步：更新统计和保存数据
      this.stats.dailyFullSync = {
        lastRun: new Date().toISOString(),
        pagesProcessed: this.data.pageMetadata.size,
        pointsUsed: this.stats.totalPointsUsed,
        duration: Date.now() - startTime
      };
      
      await this.saveData('daily-full-sync');
      console.log('✅ 每日全量同步完成');
      
    } catch (error) {
      console.error('❌ 每日全量同步失败:', error.message);
    }
  }

  /**
   * 增量投票数据同步
   * 目标：只同步有投票变化的页面的详细投票记录
   */
  async runIncrementalVoteSync() {
    console.log('⚡ 执行增量投票数据同步');
    const startTime = Date.now();
    const pointsBudget = Math.floor(this.config.rateLimitPoints * this.config.safetyMargin * 0.3);
    
    try {
      // 获取优先级页面列表（最近活跃的页面）
      const priorityPages = await this.getPriorityPages();
      console.log(`🎯 检查 ${priorityPages.length} 个优先页面的投票变化`);
      
      let pagesChecked = 0;
      let pagesUpdated = 0;
      let pointsUsed = 0;
      
      for (const pageUrl of priorityPages) {
        if (pointsUsed >= pointsBudget) break;
        
        // 快速检查页面是否有投票变化
        const hasChanges = await this.quickVoteChangeCheck(pageUrl);
        pagesChecked++;
        pointsUsed += 1; // 简单检查消耗1点
        
        if (hasChanges) {
          // 获取详细投票记录
          await this.syncPageVoteDetails(pageUrl);
          pagesUpdated++;
          pointsUsed += 5; // 详细投票同步消耗更多点数
        }
        
        // 进度显示
        if (pagesChecked % 50 === 0) {
          console.log(`📈 已检查 ${pagesChecked}/${priorityPages.length} 页面，更新 ${pagesUpdated} 个`);
        }
      }
      
      this.stats.incrementalSync = {
        lastRun: new Date().toISOString(),
        pagesChecked,
        pagesUpdated,
        pointsUsed,
        duration: Date.now() - startTime
      };
      
      this.stats.efficiencyRatio = pagesUpdated / pagesChecked;
      
      await this.saveData('incremental-vote-sync');
      console.log(`✅ 增量同步完成：检查 ${pagesChecked} 页面，更新 ${pagesUpdated} 个`);
      
    } catch (error) {
      console.error('❌ 增量投票同步失败:', error.message);
    }
  }

  /**
   * 扫描所有页面的基础信息
   * 只获取 rating, voteCount, 最新修订时间等轻量数据
   */
  async scanAllPagesBasicInfo(pointsBudget) {
    const changes = [];
    let cursor = null;
    let pointsUsed = 0;
    let totalPages = 0;
    
    while (pointsUsed < pointsBudget) {
      const query = `
        query ScanPagesBasic($first: Int, $after: ID) {
          pages(
            first: $first,
            after: $after,
            filter: { url: { startsWith: "http://scp-wiki-cn.wikidot.com" } }
          ) {
            edges {
              node {
                url
                ... on WikidotPage {
                  rating
                  voteCount
                  wikidotId
                  updatedAt
                  revisions(first: 1) {
                    edges {
                      node {
                        timestamp
                      }
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
      
      const result = await this.cromClient.request(query, {
        first: this.config.pageMetadataBatchSize,
        ...(cursor && { after: cursor })
      });
      
      pointsUsed += this.config.pageMetadataBatchSize;
      
      if (!result.pages?.edges.length) break;
      
      // 检查每个页面是否有变化
      for (const edge of result.pages.edges) {
        const page = edge.node;
        const pageUrl = page.url;
        
        const oldData = this.data.pageMetadata.get(pageUrl);
        const hasSignificantChange = this.detectSignificantChange(oldData, page);
        
        // 更新缓存
        this.data.pageMetadata.set(pageUrl, {
          url: pageUrl,
          rating: page.rating,
          voteCount: page.voteCount,
          wikidotId: page.wikidotId,
          lastUpdate: page.updatedAt,
          lastRevision: page.revisions?.edges?.[0]?.node?.timestamp,
          lastChecked: new Date().toISOString()
        });
        
        if (hasSignificantChange) {
          changes.push({
            url: pageUrl,
            changeType: oldData ? 'updated' : 'new',
            oldRating: oldData?.rating,
            newRating: page.rating,
            oldVoteCount: oldData?.voteCount,
            newVoteCount: page.voteCount
          });
        }
        
        cursor = edge.cursor;
        totalPages++;
      }
      
      // 进度显示
      if (totalPages % 100 === 0) {
        console.log(`📊 已扫描 ${totalPages} 页面，发现 ${changes.length} 个变化 (${pointsUsed}/${pointsBudget} 点)`);
      }
      
      if (!result.pages.pageInfo.hasNextPage) break;
      
      // Rate limit 控制
      await this.sleep(100);
    }
    
    console.log(`✅ 扫描完成：${totalPages} 页面，${changes.length} 个有变化`);
    return changes;
  }

  /**
   * 检测页面是否有显著变化
   */
  detectSignificantChange(oldData, newData) {
    if (!oldData) return true; // 新页面
    
    const ratingChange = Math.abs((newData.rating || 0) - (oldData.rating || 0));
    const voteCountChange = Math.abs((newData.voteCount || 0) - (oldData.voteCount || 0));
    
    // 评分变化超过阈值，或投票数变化
    return ratingChange > this.config.voteChangeThreshold || voteCountChange > 0;
  }

  /**
   * 获取优先级页面列表
   * 基于最近活跃度、评分变化、用户关注度等因素
   */
  async getPriorityPages() {
    const allPages = Array.from(this.data.pageMetadata.values());
    
    // 按优先级排序
    const priorityPages = allPages
      .filter(page => {
        const lastUpdate = page.lastUpdate ? new Date(page.lastUpdate) : null;
        const isRecent = lastUpdate && (Date.now() - lastUpdate.getTime()) < 
          this.config.recentDaysThreshold * 24 * 60 * 60 * 1000;
        return isRecent || (page.voteCount && page.voteCount > 10);
      })
      .sort((a, b) => {
        // 综合评分：最近更新时间 + 投票数 + 评分
        const scoreA = (a.voteCount || 0) + Math.abs(a.rating || 0);
        const scoreB = (b.voteCount || 0) + Math.abs(b.rating || 0);
        return scoreB - scoreA;
      })
      .slice(0, 1000) // 限制数量
      .map(page => page.url);
    
    return priorityPages;
  }

  /**
   * 快速检查页面投票是否有变化
   */
  async quickVoteChangeCheck(pageUrl) {
    const query = `
      query QuickVoteCheck($pageUrl: URL!) {
        wikidotPage(url: $pageUrl) {
          rating
          voteCount
          fuzzyVoteRecords(first: 1) {
            edges {
              node {
                timestamp
                userWikidotId
              }
            }
          }
        }
      }
    `;
    
    try {
      const result = await this.cromClient.request(query, { pageUrl });
      const page = result.wikidotPage;
      
      if (!page) return false;
      
      const cached = this.data.pageMetadata.get(pageUrl);
      const latestVote = page.fuzzyVoteRecords?.edges?.[0]?.node;
      
      // 检查投票数或最新投票时间是否变化
      if (!cached) return true;
      
      const voteCountChanged = page.voteCount !== cached.voteCount;
      const ratingChanged = Math.abs((page.rating || 0) - (cached.rating || 0)) > 0.01;
      
      return voteCountChanged || ratingChanged;
      
    } catch (error) {
      console.warn(`⚠️ 快速检查失败 ${pageUrl}: ${error.message}`);
      return false;
    }
  }

  /**
   * 同步页面详细投票记录
   */
  async syncPageVoteDetails(pageUrl) {
    // 这里实现详细的投票记录同步逻辑
    // 类似现有的 fetchPageVoteRecords 但优化了增量逻辑
    console.log(`🎯 同步页面投票详情: ${pageUrl}`);
  }

  /**
   * 判断是否应该运行增量同步
   */
  shouldRunIncrementalSync() {
    const lastRun = this.stats.incrementalSync.lastRun ? 
      new Date(this.stats.incrementalSync.lastRun) : null;
    
    if (!lastRun) return true;
    
    const timeSinceLastRun = Date.now() - lastRun.getTime();
    return timeSinceLastRun >= this.config.voteIncrementalInterval;
  }

  /**
   * 显示下次调度时间
   */
  showNextSchedule() {
    const now = new Date();
    const tomorrow2AM = new Date();
    tomorrow2AM.setDate(tomorrow2AM.getDate() + 1);
    tomorrow2AM.setHours(2, 0, 0, 0);
    
    const nextIncremental = new Date(now.getTime() + this.config.voteIncrementalInterval);
    
    console.log(`⏰ 下次全量同步: ${tomorrow2AM.toLocaleString()}`);
    console.log(`⏰ 下次增量同步: ${nextIncremental.toLocaleString()}`);
  }

  /**
   * 生成同步报告
   */
  async generateReport() {
    console.log('\n📊 同步统计报告');
    console.log('='.repeat(60));
    
    const report = {
      timestamp: new Date().toISOString(),
      stats: this.stats,
      recommendations: this.generateRecommendations()
    };
    
    console.log(`📈 效率比率: ${(this.stats.efficiencyRatio * 100).toFixed(1)}%`);
    console.log(`🎯 今日点数使用: ${this.stats.totalPointsUsed}/${this.config.rateLimitPoints}`);
    console.log(`📄 页面缓存: ${this.data.pageMetadata.size} 个`);
    
    // 保存报告
    const reportPath = `./sync-reports/report-${Date.now()}.json`;
    await fs.promises.writeFile(reportPath, JSON.stringify(report, null, 2));
    console.log(`💾 报告已保存: ${reportPath}`);
  }

  /**
   * 生成优化建议
   */
  generateRecommendations() {
    const recommendations = [];
    
    if (this.stats.efficiencyRatio < 0.1) {
      recommendations.push('效率比率较低，建议调整优先级页面算法');
    }
    
    if (this.stats.totalPointsUsed < this.config.rateLimitPoints * 0.5) {
      recommendations.push('点数使用率偏低，可以增加批次大小或检查频率');
    }
    
    return recommendations;
  }

  async saveData(syncType) {
    const filename = `smart-sync-${syncType}-${Date.now()}.json`;
    const data = {
      metadata: { syncType, timestamp: new Date().toISOString() },
      pageMetadata: Array.from(this.data.pageMetadata.entries()),
      stats: this.stats
    };
    
    await fs.promises.writeFile(`./smart-sync-data/${filename}`, JSON.stringify(data, null, 2));
  }

  async sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

export { SmartSyncStrategy };