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

// 支持断点续传的数据拉取服务
class ResumablePuller {
  constructor() {
    this.cromClient = new GraphQLClient(process.env.CROM_API_URL || 'https://apiv1.crom.avn.sh/graphql');
    
    this.oldDataDir = './full-sync-data'; // 旧脚本的数据目录
    this.newDataDir = './resume-sync-data'; // 新的数据目录
    
    if (!fs.existsSync(this.newDataDir)) {
      fs.mkdirSync(this.newDataDir, { recursive: true });
    }
    
    this.stats = {
      startTime: null,
      endTime: null,
      pagesProcessed: 0,
      resumeFromPage: 0,
      batchesCompleted: 0,
      rateLimitUsed: 0,
      errors: [],
      lastRateLimit: null,
      requestTimes: []
    };
    
    // ⚡ 优化配置：去掉固定延迟
    this.config = {
      batchSize: 10, // 更大批次
      maxRequestsPerSecond: 1.8, // 频率控制
      rateLimitThreshold: 200000,
      targetPages: 30849,
      checkpointInterval: 2000
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
    
    this.resumeInfo = null;
    this.pageProgressBar = null;
  }

  async runResumablePull() {
    console.log('🔄 启动断点续传数据拉取');
    console.log('=' .repeat(70));
    
    // 🔍 查找断点信息
    const resumeData = await this.findResumePoint();
    
    if (resumeData) {
      console.log(`✅ 找到断点: 第 ${resumeData.progress.toLocaleString()} 页面`);
      console.log(`📅 断点时间: ${new Date(resumeData.timestamp).toLocaleString()}`);
      console.log(`🔗 Cursor: ${resumeData.cursor.substring(0, 50)}...`);
      console.log(`📊 剩余页面: ${(this.config.targetPages - resumeData.progress).toLocaleString()}`);
      
      this.resumeInfo = resumeData;
      this.stats.resumeFromPage = resumeData.progress;
      
      // 导入已有数据
      await this.loadExistingData();
    } else {
      console.log('❌ 未找到有效断点，将从头开始');
      this.stats.resumeFromPage = 0;
    }
    
    console.log('');
    console.log(`🎯 拉取计划:`);
    console.log(`   开始位置: 第 ${this.stats.resumeFromPage.toLocaleString()} 页面`);
    console.log(`   目标位置: 第 ${this.config.targetPages.toLocaleString()} 页面`);
    console.log(`   剩余页面: ${(this.config.targetPages - this.stats.resumeFromPage).toLocaleString()}`);
    console.log(`   批次大小: ${this.config.batchSize} 页面/批次`);
    console.log(`   最大频率: ${this.config.maxRequestsPerSecond} 请求/秒`);
    console.log(`   预估时间: ~${Math.round((this.config.targetPages - this.stats.resumeFromPage) / (this.config.maxRequestsPerSecond * this.config.batchSize) / 3600 * 10) / 10} 小时`);
    console.log('');
    
    this.stats.startTime = new Date();
    
    // 初始化进度条（显示总体进度）
    this.pageProgressBar = new ProgressBar(this.config.targetPages);
    
    await this.pullRemainingPages();
    
    console.log('\n🔄 开始拉取用户数据...');
    await this.pullUserData();
    
    this.stats.endTime = new Date();
    await this.generateFinalReport();
  }

  async findResumePoint() {
    if (!fs.existsSync(this.oldDataDir)) {
      console.log('❌ 未找到旧数据目录');
      return null;
    }
    
    try {
      // 查找最新的检查点文件
      const files = fs.readdirSync(this.oldDataDir);
      const checkpointFiles = files
        .filter(f => f.startsWith('checkpoint-pages-'))
        .sort()
        .reverse();
      
      if (checkpointFiles.length === 0) {
        console.log('❌ 未找到检查点文件');
        return null;
      }
      
      const latestCheckpoint = checkpointFiles[0];
      console.log(`🔍 读取最新检查点: ${latestCheckpoint}`);
      
      const checkpointData = JSON.parse(
        fs.readFileSync(path.join(this.oldDataDir, latestCheckpoint), 'utf8')
      );
      
      // 查找对应的原始数据文件获取cursor
      const rawDataFiles = files
        .filter(f => f.startsWith('raw-batch-pages-') && f.includes(latestCheckpoint.split('-')[2]))
        .sort()
        .reverse();
      
      if (rawDataFiles.length === 0) {
        console.log('❌ 未找到对应的原始数据文件');
        return null;
      }
      
      const rawDataFile = rawDataFiles[0];
      console.log(`🔍 读取原始数据文件: ${rawDataFile}`);
      
      const rawData = JSON.parse(
        fs.readFileSync(path.join(this.oldDataDir, rawDataFile), 'utf8')
      );
      
      // 从最后一个批次获取cursor
      const lastBatch = rawData[rawData.length - 1];
      const lastEdge = lastBatch.pages.edges[lastBatch.pages.edges.length - 1];
      const cursor = lastEdge.cursor;
      
      return {
        progress: checkpointData.checkpoint.currentProgress,
        timestamp: checkpointData.checkpoint.timestamp,
        cursor: cursor,
        checkpointFile: latestCheckpoint,
        rawDataFile: rawDataFile
      };
      
    } catch (error) {
      console.log(`❌ 读取断点信息失败: ${error.message}`);
      return null;
    }
  }

  async loadExistingData() {
    console.log('📥 导入已有数据...');
    
    try {
      // 读取所有检查点文件获取已处理的数据
      const files = fs.readdirSync(this.oldDataDir);
      const checkpointFiles = files
        .filter(f => f.startsWith('checkpoint-pages-'))
        .sort();
      
      let totalLoaded = 0;
      
      for (const checkpointFile of checkpointFiles) {
        const checkpointData = JSON.parse(
          fs.readFileSync(path.join(this.oldDataDir, checkpointFile), 'utf8')
        );
        
        if (checkpointData.data) {
          // 合并页面数据
          if (checkpointData.data.pages) {
            this.data.pages.push(...checkpointData.data.pages);
          }
          
          // 合并投票记录
          if (checkpointData.data.voteRecords) {
            this.data.voteRecords.push(...checkpointData.data.voteRecords);
          }
          
          // 合并修订记录
          if (checkpointData.data.revisions) {
            this.data.revisions.push(...checkpointData.data.revisions);
          }
          
          // 合并其他数据
          if (checkpointData.data.attributions) {
            this.data.attributions.push(...checkpointData.data.attributions);
          }
          
          totalLoaded++;
        }
      }
      
      // 去重（基于URL）
      this.data.pages = this.removeDuplicatePages(this.data.pages);
      this.data.voteRecords = this.removeDuplicateVotes(this.data.voteRecords);
      this.data.revisions = this.removeDuplicateRevisions(this.data.revisions);
      
      console.log(`✅ 已导入数据:`);
      console.log(`   页面: ${this.data.pages.length.toLocaleString()}`);
      console.log(`   投票记录: ${this.data.voteRecords.length.toLocaleString()}`);
      console.log(`   修订记录: ${this.data.revisions.length.toLocaleString()}`);
      console.log(`   检查点文件: ${totalLoaded}`);
      
    } catch (error) {
      console.log(`⚠️  导入数据时出错: ${error.message}`);
    }
  }

  removeDuplicatePages(pages) {
    const seen = new Set();
    return pages.filter(page => {
      if (seen.has(page.url)) {
        return false;
      }
      seen.add(page.url);
      return true;
    });
  }

  removeDuplicateVotes(votes) {
    const seen = new Set();
    return votes.filter(vote => {
      const key = `${vote.pageUrl}-${vote.userWikidotId}-${vote.timestamp}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
  }

  removeDuplicateRevisions(revisions) {
    const seen = new Set();
    return revisions.filter(revision => {
      const key = `${revision.pageUrl}-${revision.revisionIndex}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
  }

  async pullRemainingPages() {
    let cursor = this.resumeInfo ? this.resumeInfo.cursor : null;
    let totalProcessed = this.stats.resumeFromPage;
    let rawDataBatch = [];
    
    // 初始进度条位置
    this.pageProgressBar.update(totalProcessed, '准备开始...');
    
    try {
      while (totalProcessed < this.config.targetPages) {
        // ⚡ 智能频率控制
        await this.enforceRateLimit();
        
        // 检查Rate Limit配额
        if (this.stats.lastRateLimit && this.stats.lastRateLimit.remaining < this.config.rateLimitThreshold) {
          await this.handleRateLimitWait();
        }
        
        try {
          const result = await this.fetchPageBatch(cursor, this.config.batchSize);
          
          if (!result || !result.pages.edges.length) {
            break;
          }
          
          // 记录请求时间
          this.stats.requestTimes.push(Date.now());
          this.cleanupOldRequestTimes();
          
          this.stats.lastRateLimit = result.rateLimit;
          this.stats.rateLimitUsed += result.rateLimit.cost;
          rawDataBatch.push(result);
          
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
            const currentSpeed = batchProcessed > 0 ? (totalProcessed - this.stats.resumeFromPage) / elapsed : 0;
            const eta = this.calculateETA(totalProcessed, this.stats.startTime, this.config.targetPages);
            
            // 更新进度条
            this.pageProgressBar.update(totalProcessed, `${currentSpeed.toFixed(1)}/s | ETA: ${eta} | ${currentPageInfo}`);
            
            if (totalProcessed >= this.config.targetPages) {
              break;
            }
          }
          
          this.stats.batchesCompleted++;
          this.stats.pagesProcessed = totalProcessed;
          
          // 定期保存检查点
          if (totalProcessed % this.config.checkpointInterval === 0 || totalProcessed >= this.config.targetPages) {
            console.log(`\n💾 保存检查点 ${Math.floor(totalProcessed / this.config.checkpointInterval)}...`);
            await this.saveCheckpoint(totalProcessed, rawDataBatch, cursor);
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
          
          await this.sleep(2000);
        }
      }
      
      // 保存最终数据
      if (rawDataBatch.length > 0) {
        await this.saveCheckpoint(totalProcessed, rawDataBatch, cursor);
      }
      
    } catch (error) {
      console.log(`\n❌ 页面拉取严重错误: ${error.message}`);
    }
    
    console.log(`\n✅ 页面数据拉取完成! 总计处理 ${totalProcessed.toLocaleString()} 页面`);
    console.log(`📈 本次新增: ${(totalProcessed - this.stats.resumeFromPage).toLocaleString()} 页面`);
  }

  // ⚡ 核心优化：智能频率控制（去掉固定延迟）
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
    const fiveSecondsAgo = Date.now() - 5000;
    this.stats.requestTimes = this.stats.requestTimes.filter(time => time > fiveSecondsAgo);
  }

  async fetchPageBatch(cursor, batchSize) {
    const pageQuery = `
      query ResumablePull($filter: QueryPagesFilter, $first: Int, $after: ID) {
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
    
    // 处理其他关系数据
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
    // 用户数据拉取（与之前相同）
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
    if (current <= this.stats.resumeFromPage) return 'N/A';
    
    const elapsed = Date.now() - startTime;
    const processed = current - this.stats.resumeFromPage;
    const rate = processed / elapsed;
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
    const rate = (processed - this.stats.resumeFromPage) / elapsed;
    
    console.log(`\n📊 当前统计:`);
    console.log(`   本次处理: ${(processed - this.stats.resumeFromPage).toLocaleString()} 页面`);
    console.log(`   总计页面: ${processed.toLocaleString()} 页面`);
    console.log(`   处理速度: ${rate.toFixed(1)} 页面/分钟`);
    console.log(`   投票记录: ${this.data.voteRecords.length.toLocaleString()}`);
    console.log(`   修订记录: ${this.data.revisions.length.toLocaleString()}`);
    console.log(`   Rate Limit剩余: ${this.stats.lastRateLimit?.remaining?.toLocaleString() || 'N/A'}`);
  }

  async saveCheckpoint(currentProgress, rawDataBatch, cursor) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    
    // 保存原始数据
    if (rawDataBatch.length > 0) {
      const rawDataPath = path.join(this.newDataDir, `raw-batch-${timestamp}.json`);
      fs.writeFileSync(rawDataPath, JSON.stringify(rawDataBatch, null, 2));
    }
    
    // 保存检查点数据
    const checkpointData = {
      progress: currentProgress,
      cursor: cursor,
      timestamp: new Date(),
      resumeInfo: this.resumeInfo,
      stats: this.stats,
      dataCount: {
        pages: this.data.pages.length,
        users: this.data.users.length,
        voteRecords: this.data.voteRecords.length,
        revisions: this.data.revisions.length
      }
    };
    
    const checkpointPath = path.join(this.newDataDir, `checkpoint-${timestamp}.json`);
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
    const newPagesProcessed = this.stats.pagesProcessed - this.stats.resumeFromPage;
    const avgSpeed = newPagesProcessed / duration;
    
    const report = {
      resumeSummary: {
        resumeFromPage: this.stats.resumeFromPage,
        newPagesProcessed: newPagesProcessed,
        totalPagesProcessed: this.stats.pagesProcessed,
        duration: `${duration.toFixed(2)} hours`,
        avgSpeed: `${avgSpeed.toFixed(1)} pages/hour`,
        rateLimitUsed: this.stats.rateLimitUsed,
        errors: this.stats.errors.length
      },
      finalDataCount: {
        pages: this.data.pages.length,
        users: this.data.users.length,
        voteRecords: this.data.voteRecords.length,
        revisions: this.data.revisions.length,
        attributions: this.data.attributions.length
      },
      timestamp: new Date().toISOString()
    };
    
    // 保存报告和数据
    const reportPath = path.join(this.newDataDir, `resume-report-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    
    const dataPath = path.join(this.newDataDir, `complete-data-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    fs.writeFileSync(dataPath, JSON.stringify(this.data, null, 2));
    
    console.log('\n🎉 断点续传拉取完成!');
    console.log(`⏱️  本次耗时: ${duration.toFixed(2)} 小时`);
    console.log(`📄 本次新增: ${newPagesProcessed.toLocaleString()} 页面`);
    console.log(`📄 总计页面: ${this.data.pages.length.toLocaleString()}`);
    console.log(`👤 用户数: ${this.data.users.length.toLocaleString()}`);
    console.log(`🗳️  投票记录: ${this.data.voteRecords.length.toLocaleString()}`);
    console.log(`📝 修订记录: ${this.data.revisions.length.toLocaleString()}`);
    console.log(`📈 平均速度: ${avgSpeed.toFixed(1)} 页面/小时`);
    console.log(`💰 Rate Limit消耗: ${this.stats.rateLimitUsed.toLocaleString()}`);
    console.log(`📁 数据已保存到: ${this.newDataDir}/`);
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// 运行断点续传
async function runResumablePull() {
  console.log('🌟 SCPPER-CN 断点续传数据拉取开始');
  console.log(`开始时间: ${new Date().toLocaleString()}`);
  console.log('');
  
  const puller = new ResumablePuller();
  await puller.runResumablePull();
  
  console.log('');
  console.log(`结束时间: ${new Date().toLocaleString()}`);
  console.log('🌟 断点续传任务完成');
}

runResumablePull().catch(console.error);