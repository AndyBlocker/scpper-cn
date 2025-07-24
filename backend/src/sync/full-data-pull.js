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

// 完整全量数据拉取服务
class FullDataPuller {
  constructor() {
    this.cromClient = new GraphQLClient(process.env.CROM_API_URL || 'https://apiv1.crom.avn.sh/graphql');
    
    // 创建数据目录
    this.dataDir = './full-sync-data';
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }
    
    // 统计信息
    this.stats = {
      startTime: null,
      endTime: null,
      pagesProcessed: 0,
      batchesCompleted: 0,
      rateLimitUsed: 0,
      totalDataSize: 0,
      rawDataSize: 0,
      processedDataSize: 0,
      errors: [],
      lastRateLimit: null,
      checkpoints: []
    };
    
    // 优化后的配置
    this.config = {
      batchSize: 5, // 稍微增加批次大小以提高效率
      delayBetweenBatches: 1500, // 减少延迟
      maxRetries: 5,
      rateLimitThreshold: 250000, // 更保守的阈值
      checkpointInterval: 1000, // 每1000个页面保存一次检查点
      targetPages: 30849 // 全量目标
    };
    
    // 数据存储
    this.data = {
      pages: [],
      users: [],
      voteRecords: [],
      revisions: [],
      attributions: [],
      relations: [],
      alternateTitles: []
    };
    
    // 进度条
    this.pageProgressBar = null;
    this.userProgressBar = null;
    
    // 文件大小统计
    this.fileSizes = {
      rawResponses: 0,
      processedData: 0,
      checkpoints: 0,
      reports: 0
    };
  }

  async runFullDataPull() {
    console.log('🚀 开始完整全量数据拉取');
    console.log('=' .repeat(80));
    console.log(`📊 拉取计划:`);
    console.log(`   阶段1: 页面数据 - ${this.config.targetPages.toLocaleString()} 页面`);
    console.log(`   阶段2: 用户数据 - 预估 ~2,000 用户`);
    console.log(`   批次大小: ${this.config.batchSize} 页面/批次`);
    console.log(`   预估总时间: ~${Math.round(this.config.targetPages / 78 / 60 * 10) / 10} 小时`);
    console.log(`📁 数据存储目录: ${path.resolve(this.dataDir)}`);
    console.log('');
    
    this.stats.startTime = new Date();
    
    // 清理旧数据
    this.cleanupOldData();
    
    // 阶段1: 拉取页面数据
    console.log('🔄 阶段1: 开始拉取页面数据...');
    await this.pullPageData();
    
    console.log('\n🔄 阶段2: 开始拉取用户数据...');
    await this.pullUserData();
    
    this.stats.endTime = new Date();
    await this.generateFinalReport();
  }

  async pullPageData() {
    this.pageProgressBar = new ProgressBar(this.config.targetPages);
    
    let cursor = null;
    let totalProcessed = 0;
    let rawDataBatch = [];
    
    try {
      while (totalProcessed < this.config.targetPages) {
        // 检查Rate Limit
        if (this.stats.lastRateLimit && this.stats.lastRateLimit.remaining < this.config.rateLimitThreshold) {
          await this.handleRateLimitWait();
        }
        
        const batchStartTime = Date.now();
        
        try {
          const result = await this.fetchPageBatch(cursor, this.config.batchSize);
          
          if (!result || !result.pages.edges.length) {
            break;
          }
          
          // 保存原始响应数据并统计大小
          const rawDataStr = JSON.stringify(result, null, 2);
          this.stats.rawDataSize += Buffer.byteLength(rawDataStr, 'utf8');
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
            
            // 获取当前页面摘要信息
            currentPageInfo = `${page.wikidotInfo?.title || 'Unknown'} (评分: ${page.wikidotInfo?.rating || 0})`;
            
            // 更新进度条
            const eta = this.calculateETA(totalProcessed, this.stats.startTime, this.config.targetPages);
            this.pageProgressBar.update(totalProcessed, `ETA: ${eta} | ${currentPageInfo.substring(0, 30)}...`);
            
            if (totalProcessed >= this.config.targetPages) {
              break;
            }
          }
          
          this.stats.batchesCompleted++;
          
          // 检查点保存
          if (totalProcessed % this.config.checkpointInterval === 0 || totalProcessed >= this.config.targetPages) {
            console.log(`\n💾 保存检查点 ${Math.floor(totalProcessed / this.config.checkpointInterval)}...`);
            await this.saveCheckpoint(totalProcessed, rawDataBatch, 'pages');
            rawDataBatch = [];
            
            // 显示当前阶段统计
            this.showPhaseStats('pages', totalProcessed);
          }
          
          // 检查是否有下一页
          if (!result.pages.pageInfo.hasNextPage) {
            break;
          }
          
          // 批次间延迟
          if (totalProcessed < this.config.targetPages) {
            await this.sleep(this.config.delayBetweenBatches);
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
          
          // 错误重试逻辑
          const recentErrors = this.stats.errors.filter(e => 
            e.type === 'batch_error' && 
            Date.now() - new Date(e.timestamp).getTime() < 300000
          );
          
          if (recentErrors.length >= this.config.maxRetries) {
            console.log('\n❌ 达到最大重试次数，停止页面同步');
            break;
          }
          
          console.log(`⏸️  错误恢复等待 ${this.config.delayBetweenBatches * 3}ms...`);
          await this.sleep(this.config.delayBetweenBatches * 3);
        }
      }
      
      // 保存最终检查点
      if (rawDataBatch.length > 0) {
        await this.saveCheckpoint(totalProcessed, rawDataBatch, 'pages');
      }
      
    } catch (error) {
      console.log(`\n❌ 页面拉取过程出现严重错误: ${error.message}`);
      this.stats.errors.push({
        type: 'fatal_error',
        phase: 'pages',
        error: error.message,
        timestamp: new Date()
      });
    }
    
    console.log(`\n✅ 页面数据拉取完成! 共处理 ${totalProcessed.toLocaleString()} 页面`);
  }

  async pullUserData() {
    try {
      console.log('📊 获取用户数据...');
      
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
      
      const userCount = result.searchUsers.length;
      this.userProgressBar = new ProgressBar(userCount);
      
      console.log(`📊 发现 ${userCount.toLocaleString()} 个用户，开始处理...`);
      
      // 处理用户数据
      for (let i = 0; i < result.searchUsers.length; i++) {
        const user = result.searchUsers[i];
        
        const userData = {
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
        };
        
        this.data.users.push(userData);
        
        // 更新进度条
        const currentUserInfo = `${user.name} (排名: ${user.statistics?.rank || 'N/A'})`;
        this.userProgressBar.update(i + 1, currentUserInfo.substring(0, 40));
      }
      
      this.stats.rateLimitUsed += result.rateLimit.cost;
      this.stats.lastRateLimit = result.rateLimit;
      
      // 保存用户数据
      const userDataPath = path.join(this.dataDir, `users-data-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
      const userDataStr = JSON.stringify(this.data.users, null, 2);
      fs.writeFileSync(userDataPath, userDataStr);
      this.fileSizes.processedData += Buffer.byteLength(userDataStr, 'utf8');
      
      console.log(`\n✅ 用户数据拉取完成! 共处理 ${userCount.toLocaleString()} 用户`);
      console.log(`💰 Rate Limit消耗: ${result.rateLimit.cost}`);
      
    } catch (error) {
      console.log(`\n❌ 用户数据拉取失败: ${error.message}`);
      this.stats.errors.push({
        type: 'user_pull_error',
        error: error.message,
        timestamp: new Date()
      });
    }
  }

  calculateETA(current, startTime, total) {
    if (current === 0) return 'N/A';
    
    const elapsed = Date.now() - startTime;
    const rate = current / elapsed; // 每毫秒处理数量
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

  showPhaseStats(phase, processed) {
    const elapsed = (Date.now() - this.stats.startTime) / 1000 / 60; // 分钟
    const rate = processed / elapsed;
    
    console.log(`\n📊 ${phase === 'pages' ? '页面' : '用户'}阶段统计:`);
    console.log(`   已处理: ${processed.toLocaleString()}`);
    console.log(`   处理速度: ${rate.toFixed(1)} ${phase === 'pages' ? '页面' : '用户'}/分钟`);
    console.log(`   投票记录: ${this.data.voteRecords.length.toLocaleString()}`);
    console.log(`   修订记录: ${this.data.revisions.length.toLocaleString()}`);
    console.log(`   数据大小: ${this.formatBytes(this.stats.totalDataSize)}`);
    console.log(`   Rate Limit剩余: ${this.stats.lastRateLimit?.remaining?.toLocaleString() || 'N/A'}`);
  }

  async fetchPageBatch(cursor, batchSize) {
    const pageQuery = `
      query FullDataPull($filter: QueryPagesFilter, $first: Int, $after: ID) {
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
                  wikidotInfo {
                    title
                  }
                }
                
                children {
                  url
                  wikidotInfo {
                    title
                  }
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
                  wikidotId
                  timestamp
                  type
                  userWikidotId
                  comment
                  user {
                    name
                  }
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
                wikidotInfo {
                  title
                }
              }
              
              translationOf {
                url
                wikidotInfo {
                  title
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
    this.stats.pagesProcessed++;
    
    // 处理投票记录
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
    
    // 处理修订记录
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
    
    // 处理贡献者信息
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
    
    // 处理页面关系
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
    
    // 处理替代标题
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

  async saveCheckpoint(currentProgress, rawDataBatch, phase = 'pages') {
    const checkpointNum = Math.floor(currentProgress / this.config.checkpointInterval);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    
    // 保存原始数据批次
    if (rawDataBatch.length > 0) {
      const rawDataPath = path.join(this.dataDir, `raw-batch-${phase}-${checkpointNum}-${timestamp}.json`);
      const rawDataStr = JSON.stringify(rawDataBatch, null, 2);
      fs.writeFileSync(rawDataPath, rawDataStr);
      this.fileSizes.rawResponses += Buffer.byteLength(rawDataStr, 'utf8');
    }
    
    // 保存处理后的数据
    const processedData = {
      checkpoint: {
        number: checkpointNum,
        phase: phase,
        timestamp: new Date(),
        currentProgress,
        totalTarget: phase === 'pages' ? this.config.targetPages : this.data.users.length
      },
      data: {
        pages: this.data.pages.slice(-this.config.checkpointInterval),
        users: phase === 'users' ? this.data.users : [],
        voteRecords: this.data.voteRecords.slice(-this.config.checkpointInterval * 25),
        revisions: this.data.revisions.slice(-this.config.checkpointInterval * 10),
        attributions: this.data.attributions.slice(-this.config.checkpointInterval * 2),
        relations: this.data.relations.slice(-this.config.checkpointInterval * 3),
        alternateTitles: this.data.alternateTitles.slice(-this.config.checkpointInterval)
      },
      stats: {
        ...this.stats,
        dataCollected: {
          pages: this.data.pages.length,
          users: this.data.users.length,
          voteRecords: this.data.voteRecords.length,
          revisions: this.data.revisions.length,
          attributions: this.data.attributions.length,
          relations: this.data.relations.length,
          alternateTitles: this.data.alternateTitles.length
        }
      }
    };
    
    const processedDataPath = path.join(this.dataDir, `checkpoint-${phase}-${checkpointNum}-${timestamp}.json`);
    const processedDataStr = JSON.stringify(processedData, null, 2);
    fs.writeFileSync(processedDataPath, processedDataStr);
    this.fileSizes.processedData += Buffer.byteLength(processedDataStr, 'utf8');
    this.fileSizes.checkpoints += Buffer.byteLength(processedDataStr, 'utf8');
    
    this.stats.processedDataSize = this.fileSizes.processedData;
    this.stats.totalDataSize = this.fileSizes.rawResponses + this.fileSizes.processedData;
    
    this.stats.checkpoints.push({
      number: checkpointNum,
      phase: phase,
      timestamp: new Date(),
      currentProgress,
      totalDataSize: this.stats.totalDataSize,
      dataCollected: processedData.stats.dataCollected
    });
  }

  async handleRateLimitWait() {
    const resetTime = new Date(this.stats.lastRateLimit.resetAt);
    const now = new Date();
    const waitTime = Math.max(resetTime - now + 10000, 60000); // 至少等待1分钟
    
    console.log(`⚠️  Rate Limit接近阈值 (剩余: ${this.stats.lastRateLimit.remaining.toLocaleString()})`);
    console.log(`⏳ 等待Rate Limit重置...`);
    console.log(`   重置时间: ${resetTime.toLocaleString()}`);
    console.log(`   等待时长: ${Math.round(waitTime / 1000)}秒`);
    
    await this.sleep(waitTime);
    console.log(`✅ Rate Limit等待完成，继续同步`);
  }

  async generateFinalReport() {
    const duration = this.stats.endTime - this.stats.startTime;
    const durationHours = duration / 1000 / 60 / 60;
    const pagesPerHour = this.stats.pagesProcessed / durationHours;
    
    // 计算最终文件大小
    this.calculateFinalFileSizes();
    
    const report = {
      fullSyncSummary: {
        startTime: this.stats.startTime,
        endTime: this.stats.endTime,
        duration: `${Math.round(durationHours * 100) / 100} hours`,
        targetPages: this.config.targetPages,
        pagesProcessed: this.stats.pagesProcessed,
        completionRate: `${(this.stats.pagesProcessed / this.config.targetPages * 100).toFixed(2)}%`,
        batchesCompleted: this.stats.batchesCompleted,
        errors: this.stats.errors.length
      },
      performance: {
        averagePagesPerHour: Math.round(pagesPerHour),
        averagePagesPerMinute: Math.round(pagesPerHour / 60 * 10) / 10,
        rateLimitUsed: this.stats.rateLimitUsed,
        averageCostPerPage: Math.round(this.stats.rateLimitUsed / this.stats.pagesProcessed * 100) / 100
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
        averageVoteRecordsPerPage: Math.round(this.data.voteRecords.length / this.stats.pagesProcessed * 10) / 10,
        averageRevisionsPerPage: Math.round(this.data.revisions.length / this.stats.pagesProcessed * 10) / 10,
        pagesWithVotes: this.data.pages.filter(p => p.voteRecordsCount > 0).length,
        pagesWithRevisions: this.data.pages.filter(p => p.revisionsCount > 0).length,
        pagesWithContent: this.data.pages.filter(p => p.sourceLength > 0).length
      },
      storageAnalysis: {
        totalDataSize: this.stats.totalDataSize,
        totalDataSizeFormatted: this.formatBytes(this.stats.totalDataSize),
        breakdown: {
          rawResponses: {
            size: this.fileSizes.rawResponses,
            formatted: this.formatBytes(this.fileSizes.rawResponses),
            percentage: Math.round(this.fileSizes.rawResponses / this.stats.totalDataSize * 100)
          },
          processedData: {
            size: this.fileSizes.processedData,
            formatted: this.formatBytes(this.fileSizes.processedData),
            percentage: Math.round(this.fileSizes.processedData / this.stats.totalDataSize * 100)
          },
          checkpoints: {
            size: this.fileSizes.checkpoints,
            formatted: this.formatBytes(this.fileSizes.checkpoints),
            percentage: Math.round(this.fileSizes.checkpoints / this.stats.totalDataSize * 100)
          },
          reports: {
            size: this.fileSizes.reports,
            formatted: this.formatBytes(this.fileSizes.reports),
            percentage: Math.round(this.fileSizes.reports / this.stats.totalDataSize * 100)
          }
        },
        estimatedDatabaseSize: this.estimateDatabaseSize()
      },
      checkpoints: this.stats.checkpoints,
      errors: this.stats.errors,
      timestamp: new Date().toISOString()
    };
    
    // 保存最终全量数据
    const finalDataPath = path.join(this.dataDir, `full-data-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    const finalDataStr = JSON.stringify(this.data, null, 2);
    fs.writeFileSync(finalDataPath, finalDataStr);
    this.fileSizes.processedData += Buffer.byteLength(finalDataStr, 'utf8');
    
    // 保存报告
    const reportPath = path.join(this.dataDir, `full-sync-report-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    const reportStr = JSON.stringify(report, null, 2);
    fs.writeFileSync(reportPath, reportStr);
    this.fileSizes.reports += Buffer.byteLength(reportStr, 'utf8');
    
    // 更新总大小
    this.stats.totalDataSize = this.fileSizes.rawResponses + this.fileSizes.processedData + this.fileSizes.reports;
    report.storageAnalysis.totalDataSize = this.stats.totalDataSize;
    report.storageAnalysis.totalDataSizeFormatted = this.formatBytes(this.stats.totalDataSize);
    
    // 重新保存更新后的报告
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    
    console.log('\n🎉 完整全量数据拉取完成!');
    console.log('=' .repeat(80));
    console.log(`⏱️  总耗时: ${Math.round(durationHours * 100) / 100} 小时`);
    console.log(`📄 处理页面: ${this.stats.pagesProcessed.toLocaleString()}/${this.config.targetPages.toLocaleString()}`);
    console.log(`👤 处理用户: ${this.data.users.length.toLocaleString()}`);
    console.log(`📦 完成批次: ${this.stats.batchesCompleted.toLocaleString()}`);
    console.log(`🗳️  投票记录: ${this.data.voteRecords.length.toLocaleString()}`);
    console.log(`📝 修订记录: ${this.data.revisions.length.toLocaleString()}`);
    console.log(`👥 贡献者记录: ${this.data.attributions.length.toLocaleString()}`);
    console.log(`🔗 页面关系: ${this.data.relations.length.toLocaleString()}`);
    console.log(`📋 替代标题: ${this.data.alternateTitles.length.toLocaleString()}`);
    console.log(`💰 Rate Limit消耗: ${this.stats.rateLimitUsed.toLocaleString()}`);
    console.log(`❌ 错误数量: ${this.stats.errors.length}`);
    
    console.log('\n📊 性能统计:');
    console.log(`📈 处理速度: ${Math.round(pagesPerHour)} 页面/小时`);
    console.log(`💰 平均成本: ${Math.round(this.stats.rateLimitUsed / this.stats.pagesProcessed * 100) / 100} 点/页面`);
    
    console.log('\n💾 存储分析:');
    console.log(`📦 总数据大小: ${this.formatBytes(this.stats.totalDataSize)}`);
    console.log(`   原始响应: ${this.formatBytes(this.fileSizes.rawResponses)} (${Math.round(this.fileSizes.rawResponses / this.stats.totalDataSize * 100)}%)`);
    console.log(`   处理数据: ${this.formatBytes(this.fileSizes.processedData)} (${Math.round(this.fileSizes.processedData / this.stats.totalDataSize * 100)}%)`);
    console.log(`   检查点: ${this.formatBytes(this.fileSizes.checkpoints)} (${Math.round(this.fileSizes.checkpoints / this.stats.totalDataSize * 100)}%)`);
    console.log(`   报告: ${this.formatBytes(this.fileSizes.reports)} (${Math.round(this.fileSizes.reports / this.stats.totalDataSize * 100)}%)`);
    console.log(`📊 预估数据库大小: ${this.formatBytes(this.estimateDatabaseSize())}`);
    
    console.log('\n📁 生成的文件:');
    console.log(`   数据目录: ${path.resolve(this.dataDir)}`);
    console.log(`   最终数据: ${path.basename(finalDataPath)}`);
    console.log(`   详细报告: ${path.basename(reportPath)}`);
    console.log(`   检查点数量: ${this.stats.checkpoints.length}`);
    
    if (this.stats.errors.length > 0) {
      console.log('\n⚠️  错误统计:');
      const errorTypes = {};
      this.stats.errors.forEach(error => {
        errorTypes[error.type] = (errorTypes[error.type] || 0) + 1;
      });
      Object.entries(errorTypes).forEach(([type, count]) => {
        console.log(`   ${type}: ${count} 次`);
      });
    } else {
      console.log('\n✅ 全量拉取成功完成，无错误');
    }
  }

  calculateFinalFileSizes() {
    // 扫描数据目录计算实际文件大小
    if (fs.existsSync(this.dataDir)) {
      const files = fs.readdirSync(this.dataDir);
      let totalSize = 0;
      
      for (const file of files) {
        const filePath = path.join(this.dataDir, file);
        const stats = fs.statSync(filePath);
        totalSize += stats.size;
        
        if (file.includes('raw-batch')) {
          this.fileSizes.rawResponses += stats.size;
        } else if (file.includes('checkpoint')) {
          this.fileSizes.checkpoints += stats.size;
        } else if (file.includes('report')) {
          this.fileSizes.reports += stats.size;
        } else if (file.includes('full-data')) {
          this.fileSizes.processedData += stats.size;
        }
      }
      
      this.stats.totalDataSize = totalSize;
    }
  }

  estimateDatabaseSize() {
    // 基于收集的数据估算PostgreSQL数据库大小
    const avgPageSize = 2000; // 页面表平均行大小
    const avgVoteSize = 50; // 投票记录平均行大小
    const avgRevisionSize = 200; // 修订记录平均行大小
    const avgAttributionSize = 100; // 贡献者记录平均行大小
    const avgRelationSize = 150; // 关系记录平均行大小
    const avgAlternateTitleSize = 100; // 替代标题平均行大小
    
    const estimatedSize = 
      this.data.pages.length * avgPageSize +
      this.data.voteRecords.length * avgVoteSize +
      this.data.revisions.length * avgRevisionSize +
      this.data.attributions.length * avgAttributionSize +
      this.data.relations.length * avgRelationSize +
      this.data.alternateTitles.length * avgAlternateTitleSize;
    
    // 添加索引开销（约30%）和PostgreSQL开销（约20%）
    return Math.round(estimatedSize * 1.5);
  }

  cleanupOldData() {
    if (fs.existsSync(this.dataDir)) {
      const files = fs.readdirSync(this.dataDir);
      console.log(`🧹 清理旧数据文件 (${files.length} 个)...`);
      
      for (const file of files) {
        fs.unlinkSync(path.join(this.dataDir, file));
      }
    }
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

// 运行完整全量数据拉取
async function runFullDataPull() {
  console.log('🌟 SCPPER-CN 完整全量数据拉取开始');
  console.log(`开始时间: ${new Date().toLocaleString()}`);
  console.log('');
  
  const puller = new FullDataPuller();
  await puller.runFullDataPull();
  
  console.log('');
  console.log(`结束时间: ${new Date().toLocaleString()}`);
  console.log('🌟 全量数据拉取任务完成');
}

runFullDataPull().catch(console.error);