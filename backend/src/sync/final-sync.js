import { GraphQLClient } from 'graphql-request';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

// 最终版本数据同步脚本
// 功能：完整页面数据拉取 + 有限用户数据 + 断点续传 + 频率优化
class FinalSyncService {
  constructor() {
    this.cromClient = new GraphQLClient(process.env.CROM_API_URL || 'https://apiv1.crom.avn.sh/graphql');
    
    this.dataDir = './final-sync-data';
    this.checkpointDir = './sync-checkpoints';
    
    // 确保目录存在
    [this.dataDir, this.checkpointDir].forEach(dir => {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    });
    
    this.stats = {
      startTime: null,
      endTime: null,
      pagesProcessed: 0,
      usersProcessed: 0,
      resumeFromPage: 0,
      batchesCompleted: 0,
      rateLimitUsed: 0,
      errors: [],
      lastRateLimit: null,
      requestTimes: []
    };
    
    // 最优配置
    this.config = {
      batchSize: 10, // 充分利用每次请求
      maxRequestsPerSecond: 1.8, // 接近API限制但保持安全缓冲
      rateLimitThreshold: 200000, // 保守的配额阈值
      targetPages: 30849, // CN站点总页面数
      checkpointInterval: 1000, // 每1000页面保存检查点
      maxUserRetries: 3 // 用户查询重试次数
    };
    
    this.data = {
      pages: [],
      users: [], // 注意：API限制，最多5个用户
      voteRecords: [],
      revisions: [],
      attributions: [],
      relations: [],
      alternateTitles: []
    };
    
    this.resumeInfo = null;
  }

  async runFinalSync() {
    console.log('🚀 SCPPER-CN 最终版数据同步');
    console.log('=' .repeat(80));
    console.log(`📅 开始时间: ${new Date().toLocaleString()}`);
    console.log(`🎯 目标页面: ${this.config.targetPages.toLocaleString()} 页面`);
    console.log(`⚡ 最大频率: ${this.config.maxRequestsPerSecond} 请求/秒`);
    console.log(`📦 批次大小: ${this.config.batchSize} 页面/批次`);
    console.log('');
    
    this.stats.startTime = new Date();
    
    try {
      // 1. 检查断点续传
      const resumeData = await this.checkResumePoint();
      if (resumeData && resumeData.progress < this.config.targetPages) {
        console.log(`🔄 从第 ${resumeData.progress.toLocaleString()} 页面继续...`);
        this.resumeInfo = resumeData;
        this.stats.resumeFromPage = resumeData.progress;
        await this.loadExistingData();
      } else {
        console.log('🆕 开始全新的数据同步...');
        this.stats.resumeFromPage = 0;
      }
      
      // 2. 同步页面数据
      if (this.stats.resumeFromPage < this.config.targetPages) {
        console.log('📄 开始页面数据同步...');
        await this.syncPageData();
      } else {
        console.log('✅ 页面数据已完整，跳过页面同步');
      }
      
      // 3. 同步用户数据（有限）
      console.log('\n👤 开始用户数据同步...');
      await this.syncLimitedUserData();
      
      // 4. 生成最终报告
      this.stats.endTime = new Date();
      await this.generateFinalReport();
      
    } catch (error) {
      console.error(`❌ 同步过程发生错误: ${error.message}`);
      this.stats.errors.push({
        type: 'fatal_error',
        error: error.message,
        timestamp: new Date()
      });
    }
  }

  async checkResumePoint() {
    try {
      if (!fs.existsSync(this.checkpointDir)) {
        return null;
      }

      const files = fs.readdirSync(this.checkpointDir);
      const checkpointFiles = files
        .filter(f => f.startsWith('checkpoint-') && f.endsWith('.json'))
        .sort()
        .reverse();

      if (checkpointFiles.length === 0) {
        return null;
      }

      const latestFile = checkpointFiles[0];
      const checkpointData = JSON.parse(
        fs.readFileSync(path.join(this.checkpointDir, latestFile), 'utf8')
      );

      return checkpointData;
    } catch (error) {
      console.log(`⚠️  检查断点失败: ${error.message}`);
      return null;
    }
  }

  async loadExistingData() {
    try {
      // 从最新的数据文件加载已有数据
      const files = fs.readdirSync(this.dataDir);
      const dataFiles = files
        .filter(f => f.startsWith('pages-data-') && f.endsWith('.json'))
        .sort()
        .reverse();

      if (dataFiles.length > 0) {
        const latestDataFile = dataFiles[0];
        const existingData = JSON.parse(
          fs.readFileSync(path.join(this.dataDir, latestDataFile), 'utf8')
        );

        if (existingData.pages) this.data.pages = existingData.pages;
        if (existingData.voteRecords) this.data.voteRecords = existingData.voteRecords;
        if (existingData.revisions) this.data.revisions = existingData.revisions;
        if (existingData.attributions) this.data.attributions = existingData.attributions;

        console.log(`📥 已加载 ${this.data.pages.length.toLocaleString()} 页面数据`);
      }
    } catch (error) {
      console.log(`⚠️  加载已有数据失败: ${error.message}`);
    }
  }

  async syncPageData() {
    let cursor = this.resumeInfo ? this.resumeInfo.cursor : null;
    let totalProcessed = this.stats.resumeFromPage;
    
    console.log(`📊 进度: 0% (${totalProcessed.toLocaleString()}/${this.config.targetPages.toLocaleString()})`);
    
    try {
      while (totalProcessed < this.config.targetPages) {
        // 频率控制
        await this.enforceRateLimit();
        
        // Rate Limit检查
        if (this.stats.lastRateLimit && this.stats.lastRateLimit.remaining < this.config.rateLimitThreshold) {
          await this.handleRateLimitWait();
        }
        
        try {
          const result = await this.fetchPageBatch(cursor, this.config.batchSize);
          
          if (!result || !result.pages.edges.length) {
            console.log('✅ 没有更多页面可处理');
            break;
          }
          
          // 记录请求时间
          this.stats.requestTimes.push(Date.now());
          this.cleanupOldRequestTimes();
          
          this.stats.lastRateLimit = result.rateLimit;
          this.stats.rateLimitUsed += result.rateLimit.cost;
          
          // 处理页面数据
          let batchProcessed = 0;
          for (const edge of result.pages.edges) {
            this.processPageData(edge.node);
            cursor = edge.cursor;
            totalProcessed++;
            batchProcessed++;
            
            if (totalProcessed >= this.config.targetPages) {
              break;
            }
          }
          
          this.stats.batchesCompleted++;
          this.stats.pagesProcessed = totalProcessed;
          
          // 显示进度
          const progress = (totalProcessed / this.config.targetPages * 100).toFixed(1);
          const elapsed = (Date.now() - this.stats.startTime) / 1000;
          const speed = ((totalProcessed - this.stats.resumeFromPage) / elapsed).toFixed(1);
          const eta = this.calculateETA(totalProcessed);
          
          process.stdout.write(`\r📊 进度: ${progress}% (${totalProcessed.toLocaleString()}/${this.config.targetPages.toLocaleString()}) | 速度: ${speed}/s | ETA: ${eta} | RL: ${result.rateLimit.remaining.toLocaleString()}`);
          
          // 定期保存检查点
          if (totalProcessed % this.config.checkpointInterval === 0 || totalProcessed >= this.config.targetPages) {
            await this.saveCheckpoint(totalProcessed, cursor);
            await this.saveCurrentData();
          }
          
          // 检查是否有下一页
          if (!result.pages.pageInfo.hasNextPage) {
            console.log('\n✅ 已处理所有可用页面');
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
          
          if (this.stats.errors.filter(e => e.type === 'batch_error').length >= 5) {
            console.log('\n❌ 错误过多，停止页面同步');
            break;
          }
          
          await this.sleep(3000); // 错误后等待更长时间
        }
      }
      
      console.log(`\n✅ 页面数据同步完成! 总计 ${totalProcessed.toLocaleString()} 页面`);
      
    } catch (error) {
      console.log(`\n❌ 页面同步严重错误: ${error.message}`);
      throw error;
    }
  }

  async syncLimitedUserData() {
    console.log('⚠️  注意: CROM API用户查询限制为最多5个用户');
    
    for (let attempt = 1; attempt <= this.config.maxUserRetries; attempt++) {
      try {
        console.log(`🔄 用户查询尝试 ${attempt}/${this.config.maxUserRetries}...`);
        
        const userQuery = `
          query GetLimitedUsers {
            searchUsers(query: "") {
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
        
        const result = await this.cromClient.request(userQuery);
        
        this.data.users = result.searchUsers.map(user => ({
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
        }));
        
        this.stats.usersProcessed = this.data.users.length;
        this.stats.rateLimitUsed += result.rateLimit.cost;
        this.stats.lastRateLimit = result.rateLimit;
        
        console.log(`✅ 用户数据同步完成: ${this.data.users.length} 个用户`);
        console.log(`💰 Rate Limit消耗: ${result.rateLimit.cost}`);
        
        // 显示用户信息
        if (this.data.users.length > 0) {
          console.log('👤 用户列表:');
          this.data.users.forEach((user, i) => {
            console.log(`   ${i+1}. ${user.name} (排名: ${user.rank}, 评分: ${user.totalRating})`);
          });
        }
        
        break; // 成功后退出重试循环
        
      } catch (error) {
        console.log(`❌ 用户查询失败 (尝试 ${attempt}): ${error.message}`);
        
        if (attempt === this.config.maxUserRetries) {
          console.log('❌ 用户数据同步最终失败，但页面数据完整');
          this.stats.errors.push({
            type: 'user_sync_failed',
            error: error.message,
            timestamp: new Date()
          });
        } else {
          await this.sleep(2000); // 重试前等待
        }
      }
    }
  }

  async fetchPageBatch(cursor, batchSize) {
    const pageQuery = `
      query FinalSync($filter: QueryPagesFilter, $first: Int, $after: ID) {
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
    
    // 页面基础信息
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
    
    // 投票记录
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
    
    // 修订记录
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
    
    // 贡献者信息
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
    
    // 页面关系
    if (info.parent) {
      this.data.relations.push({
        pageUrl: page.url,
        relatedUrl: info.parent.url,
        relationType: 'parent',
        relatedTitle: info.parent.wikidotInfo?.title
      });
    }
    
    if (info.children) {
      for (const child of info.children) {
        this.data.relations.push({
          pageUrl: page.url,
          relatedUrl: child.url,
          relationType: 'child',
          relatedTitle: child.wikidotInfo?.title
        });
      }
    }
    
    if (page.translations) {
      for (const translation of page.translations) {
        this.data.relations.push({
          pageUrl: page.url,
          relatedUrl: translation.url,
          relationType: 'translation',
          relatedTitle: translation.wikidotInfo?.title
        });
      }
    }
    
    if (page.translationOf) {
      this.data.relations.push({
        pageUrl: page.url,
        relatedUrl: page.translationOf.url,
        relationType: 'translation_of',
        relatedTitle: page.translationOf.wikidotInfo?.title
      });
    }
    
    // 替代标题
    if (page.alternateTitles) {
      for (const altTitle of page.alternateTitles) {
        this.data.alternateTitles.push({
          pageUrl: page.url,
          type: altTitle.type,
          title: altTitle.title
        });
      }
    }
  }

  // 智能频率控制
  async enforceRateLimit() {
    const now = Date.now();
    const oneSecondAgo = now - 1000;
    
    this.stats.requestTimes = this.stats.requestTimes.filter(time => time > oneSecondAgo);
    
    if (this.stats.requestTimes.length >= this.config.maxRequestsPerSecond) {
      const oldestRequest = Math.min(...this.stats.requestTimes);
      const waitTime = 1000 - (now - oldestRequest) + 100; // 100ms缓冲
      
      if (waitTime > 0) {
        await this.sleep(waitTime);
      }
    }
  }

  cleanupOldRequestTimes() {
    const fiveSecondsAgo = Date.now() - 5000;
    this.stats.requestTimes = this.stats.requestTimes.filter(time => time > fiveSecondsAgo);
  }

  calculateETA(current) {
    if (current <= this.stats.resumeFromPage) return 'N/A';
    
    const elapsed = (Date.now() - this.stats.startTime) / 1000;
    const processed = current - this.stats.resumeFromPage;
    const rate = processed / elapsed;
    const remaining = this.config.targetPages - current;
    const eta = remaining / rate;
    
    const hours = Math.floor(eta / 3600);
    const minutes = Math.floor((eta % 3600) / 60);
    
    if (hours > 0) {
      return `${hours}h${minutes}m`;
    } else {
      return `${minutes}m`;
    }
  }

  async saveCheckpoint(currentProgress, cursor) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    
    const checkpointData = {
      progress: currentProgress,
      cursor: cursor,
      timestamp: new Date(),
      stats: {
        pagesProcessed: this.stats.pagesProcessed,
        rateLimitUsed: this.stats.rateLimitUsed,
        batchesCompleted: this.stats.batchesCompleted
      },
      dataCount: {
        pages: this.data.pages.length,
        voteRecords: this.data.voteRecords.length,
        revisions: this.data.revisions.length,
        attributions: this.data.attributions.length
      }
    };
    
    const checkpointPath = path.join(this.checkpointDir, `checkpoint-${timestamp}.json`);
    fs.writeFileSync(checkpointPath, JSON.stringify(checkpointData, null, 2));
  }

  async saveCurrentData() {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    
    // 分别保存不同类型的数据
    const dataFiles = {
      pages: `pages-data-${timestamp}.json`,
      voteRecords: `votes-data-${timestamp}.json`,
      revisions: `revisions-data-${timestamp}.json`,
      users: `users-data-${timestamp}.json`
    };
    
    // 保存页面数据
    fs.writeFileSync(
      path.join(this.dataDir, dataFiles.pages),
      JSON.stringify(this.data.pages, null, 2)
    );
    
    // 保存投票记录
    fs.writeFileSync(
      path.join(this.dataDir, dataFiles.voteRecords),
      JSON.stringify(this.data.voteRecords, null, 2)
    );
    
    // 保存修订记录
    fs.writeFileSync(
      path.join(this.dataDir, dataFiles.revisions),
      JSON.stringify(this.data.revisions, null, 2)
    );
    
    // 保存用户数据
    fs.writeFileSync(
      path.join(this.dataDir, dataFiles.users),
      JSON.stringify(this.data.users, null, 2)
    );
  }

  async handleRateLimitWait() {
    const resetTime = new Date(this.stats.lastRateLimit.resetAt);
    const waitTime = Math.max(resetTime - Date.now() + 15000, 60000); // 至少等待1分钟
    
    console.log(`\n⏳ Rate Limit配额不足，等待 ${Math.round(waitTime/1000)}秒...`);
    console.log(`   重置时间: ${resetTime.toLocaleString()}`);
    await this.sleep(waitTime);
    console.log(`✅ Rate Limit等待完成，继续同步`);
  }

  async generateFinalReport() {
    const duration = (this.stats.endTime - this.stats.startTime) / 1000 / 3600;
    const newPagesProcessed = this.stats.pagesProcessed - this.stats.resumeFromPage;
    const avgSpeed = newPagesProcessed > 0 ? newPagesProcessed / duration : 0;
    
    // 计算文件大小
    const fileSizes = this.calculateFileSizes();
    
    const report = {
      syncSummary: {
        startTime: this.stats.startTime,
        endTime: this.stats.endTime,
        duration: `${duration.toFixed(2)} hours`,
        resumeFromPage: this.stats.resumeFromPage,
        newPagesProcessed: newPagesProcessed,
        totalPagesProcessed: this.stats.pagesProcessed,
        usersProcessed: this.stats.usersProcessed,
        avgSpeed: `${avgSpeed.toFixed(1)} pages/hour`,
        rateLimitUsed: this.stats.rateLimitUsed,
        batchesCompleted: this.stats.batchesCompleted,
        errors: this.stats.errors.length
      },
      dataCollected: {
        pages: this.data.pages.length,
        users: this.data.users.length,
        voteRecords: this.data.voteRecords.length,
        revisions: this.data.revisions.length,
        attributions: this.data.attributions.length,
        relations: this.data.relations.length,
        alternateTitles: this.data.alternateTitles.length
      },
      dataQuality: {
        averageVoteRecordsPerPage: this.data.pages.length > 0 ? (this.data.voteRecords.length / this.data.pages.length).toFixed(1) : 0,
        averageRevisionsPerPage: this.data.pages.length > 0 ? (this.data.revisions.length / this.data.pages.length).toFixed(1) : 0,
        pagesWithVotes: this.data.pages.filter(p => p.voteRecordsCount > 0).length,
        pagesWithRevisions: this.data.pages.filter(p => p.revisionsCount > 0).length,
        pagesWithContent: this.data.pages.filter(p => p.sourceLength > 0).length
      },
      storageInfo: {
        totalSize: fileSizes.total,
        totalSizeFormatted: this.formatBytes(fileSizes.total),
        breakdown: fileSizes.breakdown
      },
      apiLimitations: {
        userQueryLimit: '最多5个用户 (CROM API限制)',
        rateLimitQuota: '300,000点/5分钟',
        requestFrequency: '最多2请求/秒'
      },
      errors: this.stats.errors,
      timestamp: new Date().toISOString()
    };
    
    // 保存报告
    const reportPath = path.join(this.dataDir, `final-sync-report-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    
    // 显示最终统计
    console.log('\n🎉 最终数据同步完成!');
    console.log('=' .repeat(80));
    console.log(`⏱️  总耗时: ${duration.toFixed(2)} 小时`);
    console.log(`📄 页面数: ${this.data.pages.length.toLocaleString()}`);
    console.log(`👤 用户数: ${this.data.users.length} (API限制)`);
    console.log(`🗳️  投票记录: ${this.data.voteRecords.length.toLocaleString()}`);
    console.log(`📝 修订记录: ${this.data.revisions.length.toLocaleString()}`);
    console.log(`👥 贡献者记录: ${this.data.attributions.length.toLocaleString()}`);
    console.log(`🔗 页面关系: ${this.data.relations.length.toLocaleString()}`);
    console.log(`📋 替代标题: ${this.data.alternateTitles.length.toLocaleString()}`);
    console.log(`📈 平均速度: ${avgSpeed.toFixed(1)} 页面/小时`);
    console.log(`💰 Rate Limit消耗: ${this.stats.rateLimitUsed.toLocaleString()}`);
    console.log(`💾 数据总大小: ${this.formatBytes(fileSizes.total)}`);
    
    if (this.stats.errors.length > 0) {
      console.log(`⚠️  错误数量: ${this.stats.errors.length}`);
    } else {
      console.log(`✅ 同步完成，无错误`);
    }
    
    console.log(`\n📁 数据已保存到:`);
    console.log(`   数据目录: ${path.resolve(this.dataDir)}`);
    console.log(`   检查点目录: ${path.resolve(this.checkpointDir)}`);
    console.log(`   最终报告: ${path.basename(reportPath)}`);
    
    console.log(`\n📅 结束时间: ${new Date().toLocaleString()}`);
  }

  calculateFileSizes() {
    let total = 0;
    const breakdown = {};
    
    try {
      // 计算数据文件大小
      if (fs.existsSync(this.dataDir)) {
        const dataFiles = fs.readdirSync(this.dataDir);
        for (const file of dataFiles) {
          const filePath = path.join(this.dataDir, file);
          const stats = fs.statSync(filePath);
          total += stats.size;
          
          const category = file.split('-')[0];
          if (!breakdown[category]) breakdown[category] = 0;
          breakdown[category] += stats.size;
        }
      }
      
      // 计算检查点文件大小
      if (fs.existsSync(this.checkpointDir)) {
        const checkpointFiles = fs.readdirSync(this.checkpointDir);
        let checkpointSize = 0;
        for (const file of checkpointFiles) {
          const filePath = path.join(this.checkpointDir, file);
          const stats = fs.statSync(filePath);
          checkpointSize += stats.size;
        }
        total += checkpointSize;
        breakdown.checkpoints = checkpointSize;
      }
      
    } catch (error) {
      console.log(`⚠️  计算文件大小失败: ${error.message}`);
    }
    
    return { total, breakdown };
  }

  formatBytes(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// 运行最终同步
async function runFinalSync() {
  const syncService = new FinalSyncService();
  await syncService.runFinalSync();
}

// 导出供其他模块使用
export { FinalSyncService };

// 如果直接运行此脚本
if (import.meta.url === `file://${process.argv[1]}`) {
  runFinalSync().catch(console.error);
}