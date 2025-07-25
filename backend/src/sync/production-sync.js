import { GraphQLClient } from 'graphql-request';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

// SCPPER-CN 生产环境数据同步脚本
// 基于复杂度限制和权限分析的优化版本
class ProductionSync {
  constructor() {
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
      pagesProcessed: 0,
      votesProcessed: 0,
      usersProcessed: 0,
      batchesCompleted: 0,
      errors: [],
      requestTimes: []
    };
    
    // 基于300,000点/5分钟的高速配置 - 支持增量更新
    this.config = {
      pagesBatchSize: 20,    // 增加页面批次大小
      votesBatchSize: 100,   // 每次获取100条投票记录（API默认最大值）
      maxRequestsPerSecond: 8.0,   // 更保守的请求频率，避免过多429错误
      targetPages: null,     // 自动检测所有CN分支页面（基于API分页）
      checkpointInterval: 1000,
      maxRetries: 10,         // 增加重试次数以处理rate limiting
      retryDelayMs: 15000,    // 429错误后等待15秒（更保守）
      max429Retries: 50,      // 专门处理429错误的重试次数
      // 全量投票数据配置
      getCompleteVoteRecords: true,  // 获取完整投票记录
      maxVotePagesPerRequest: 500,   // 每500页进行一次投票记录检查点保存
      // 增量更新配置
      enableIncrementalUpdate: true, // 启用增量更新
      voteDataRetentionDays: 7,      // 投票数据保留天数（用于增量计算）
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
    
    // Rate Limit追踪
    this.rateLimitTracker = {
      pointsUsed: 0,
      windowStart: Date.now(),
      requestHistory: []  // {timestamp, points} 的数组
    };
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
    console.log('');
    
    this.stats.startTime = new Date();
    
    try {
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

  async syncPagesBasicData() {
    console.log('📄 第一阶段：同步页面基础数据...');
    
    let cursor = null;
    let totalProcessed = 0;
    
    while (true) {
      try {
        await this.rateLimit();
        
        const startTime = Date.now();
        const result = await this.fetchPagesBasic(cursor, this.config.pagesBatchSize);
        const requestTime = Date.now() - startTime;
        
        this.stats.requestTimes.push(requestTime);
        
        // 成功请求后清理429错误计数
        this.clearConsecutive429Errors('pages_basic');
        
        if (!result || !result.pages.edges.length) {
          console.log('\n✅ 没有更多页面可处理');
          break;
        }
        
        // 处理页面基础数据
        for (const edge of result.pages.edges) {
          this.processPageBasic(edge.node);
          cursor = edge.cursor;
          totalProcessed++;
        }
        
        this.stats.batchesCompleted++;
        this.stats.pagesProcessed = totalProcessed;
        
        // 智能进度显示（避免刷屏）
        this.updateProgress(totalProcessed);
        
        // 定期保存检查点
        if (totalProcessed % this.config.checkpointInterval === 0) {
          await this.saveCurrentData(`pages-checkpoint-${totalProcessed}`);
        }
        
        // 检查是否有下一页
        if (!result.pages.pageInfo.hasNextPage) {
          console.log('\n✅ 已处理所有可用页面');
          break;
        }
        
      } catch (error) {
        console.log(`\n❌ 页面批次处理失败: ${error.message}`);
        await this.handleError(error, 'pages_basic');
      }
    }
    
    console.log(`\n✅ 页面基础数据同步完成! 总计 ${totalProcessed} 页面`);
  }

  async fetchPagesBasic(cursor, batchSize) {
    const query = `
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
                
                # 尝试修复后的字段
                alternateTitles {
                  title
                  language
                }
                
                revisions(first: 10) {
                  edges {
                    node {
                      id
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
      first: batchSize
    };
    
    if (cursor) {
      variables.after = cursor;
    }
    
    return await this.cromClient.request(query, variables);
  }

  updateProgress(currentCount, context = 'pages') {
    const now = Date.now();
    
    // 限制进度更新频率，避免刷屏
    if (now - this.progressState.lastProgressUpdate < this.progressState.progressUpdateInterval) {
      return;
    }
    
    this.progressState.lastProgressUpdate = now;
    
    const speed = currentCount / ((now - this.stats.startTime) / 1000);
    const avgResponseTime = this.stats.requestTimes.slice(-5).reduce((a, b) => a + b, 0) / Math.min(5, this.stats.requestTimes.length);
    
    // 更新速度历史用于时间预估
    this.progressState.speedHistory.push(speed);
    if (this.progressState.speedHistory.length > this.progressState.maxSpeedHistory) {
      this.progressState.speedHistory.shift();
    }
    
    let progressText = '';
    let etaText = '';
    
    // 计算已用时间
    const elapsedSeconds = (now - this.stats.startTime) / 1000;
    const elapsedText = ` | 已用: ${this.formatDuration(elapsedSeconds)}`;
    
    if (this.progressState.totalPages && context === 'pages') {
      // 有总数时显示百分比进度条和预计时间
      const percentage = (currentCount / this.progressState.totalPages * 100);
      const progressBar = this.generateProgressBar(percentage);
      progressText = `📊 ${progressBar} ${percentage.toFixed(1)}% (${currentCount.toLocaleString()}/${this.progressState.totalPages.toLocaleString()})`;
      
      // 计算预计剩余时间
      const remaining = this.progressState.totalPages - currentCount;
      const avgSpeed = this.progressState.speedHistory.reduce((sum, s) => sum + s, 0) / this.progressState.speedHistory.length;
      if (avgSpeed > 0 && remaining > 0) {
        const etaSeconds = remaining / avgSpeed;
        etaText = ` | ETA: ${this.formatDuration(etaSeconds)}`;
      }
    } else {
      // 无总数时显示简单计数
      progressText = `📊 ${context === 'pages' ? '页面' : '投票'}进度: ${currentCount.toLocaleString()}`;
    }
    
    // Rate limit状态指示
    const rateLimitStatus = this.progressState.isWaitingRateLimit ? ' ⏳ [等待Rate Limit]' : '';
    
    process.stdout.write(`\r${progressText} | 速度: ${speed.toFixed(1)}/s | 响应: ${avgResponseTime.toFixed(0)}ms${elapsedText}${etaText}${rateLimitStatus}`);
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
    
    // Rate limit状态和使用率
    const rateLimitUsage = (this.rateLimitTracker.pointsUsed / this.config.rateLimitPoints * 100).toFixed(1);
    const rateLimitStatus = this.progressState.isWaitingRateLimit ? ' ⏳ [等待Rate Limit]' : '';
    const incrementalInfo = this.incrementalData.newVotesOnly ? ' | 增量更新' : ' | 全量同步';
    
    process.stdout.write(`\r🗳️  ${progressBar} ${progress}% (${processedPages}/${totalPages}) | 投票: ${this.stats.votesProcessed.toLocaleString()} | 完整性: ${completeness}% | RL: ${rateLimitUsage}%${elapsedText}${etaText}${incrementalInfo}${rateLimitStatus}`);
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
          language: altTitle.language
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
          revisionId: revision.id,
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
        this.data.attributions.push({
          pageUrl: page.url,
          pageTitle: page.title,
          userId: attr.user?.wikidotId,
          userName: attr.user?.displayName,
          userUnixName: attr.user?.unixName,
          attributionType: attr.type,
          date: attr.date,
          order: attr.order
        });
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
          updateReason: 'new_page',
          limitVoteCount: Math.min(100, page.voteCount)
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
      
      // 检查3: 需要检查第一个vote的ID（获取少量数据进行比较）
      if (!needsUpdate && page.voteCount > 0) {
        // 只有在前两个检查都通过时才进行这个较昂贵的检查
        const currentFirstVote = await this.getFirstVoteId(page.url);
        if (currentFirstVote && currentFirstVote !== historicalState.firstVoteId) {
          needsUpdate = true;
          reason = 'first_vote_changed';
          firstVoteChanged++;
        }
      }
      
      if (needsUpdate) {
        pagesToUpdate.push({
          ...page,
          updateReason: reason,
          limitVoteCount: Math.min(100, page.voteCount)
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
    
    // 计算预期投票总数（基于实际需要更新的页面）
    this.voteProgress.totalVotesExpected = pagesToUpdate.reduce((sum, p) => sum + Math.min(100, p.voteCount), 0);
    console.log(`📊 预期投票记录总数: ${this.voteProgress.totalVotesExpected.toLocaleString()}`);
    
    let processedVotePages = 0;
    
    for (const page of pagesToUpdate) {
      try {
        // 检查是否已完成该页面的投票获取
        if (this.voteProgress.completedPages.has(page.url)) {
          processedVotePages++;
          continue;
        }
        
        await this.rateLimit();
        
        // 智能获取投票记录，使用限制数量
        const voteResult = await this.fetchPageVotesWithResume(page.url, page.limitVoteCount || page.voteCount);
        
        // 成功请求后清理429错误计数
        this.clearConsecutive429Errors('votes');
        
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
        
        // 更新页面投票状态（用于下次智能检测）
        if (voteResult.votes && voteResult.votes.length > 0) {
          const firstVoteId = voteResult.votes.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))[0].voterWikidotId;
          this.incrementalData.pageVoteStates.set(page.url, {
            voteCount: page.voteCount,
            rating: page.rating,
            firstVoteId: firstVoteId,
            lastUpdated: new Date().toISOString()
          });
        }
        
        // 标记完成状态
        if (voteResult.isComplete) {
          this.voteProgress.completedPages.add(page.url);
          this.voteProgress.partialPages.delete(page.url);
        } else {
          // 保存部分进度
          this.voteProgress.partialPages.set(page.url, {
            cursor: voteResult.nextCursor,
            votesCollected: voteResult.votes.length
          });
        }
        
        processedVotePages++;
        
        // 智能进度显示（投票阶段）  
        this.updateVoteProgress(processedVotePages, pagesToUpdate.length);
        
        // 定期保存投票进度检查点
        if (processedVotePages % this.config.maxVotePagesPerRequest === 0) {
          await this.saveVoteProgressCheckpoint();
        }
        
      } catch (error) {
        await this.handleError(error, 'votes');
      }
    }
    
    console.log(`\n✅ 投票数据同步完成! 总计 ${this.stats.votesProcessed.toLocaleString()} 条投票记录`);
  }

  async fetchPageVotesWithResume(pageUrl, expectedVoteCount) {
    // 支持断点续传和增量更新的投票记录获取
    // 重要：fuzzyVoteRecords从新到旧排序！这对增量更新极其有利
    let allVotes = [];
    let cursor = null;
    let hasNextPage = true;
    let foundOldVote = false; // 是否找到已存在的投票（用于增量更新）
    
    // 检查是否有部分完成的进度
    if (this.voteProgress.partialPages.has(pageUrl)) {
      const partialProgress = this.voteProgress.partialPages.get(pageUrl);
      cursor = partialProgress.cursor;
      console.log(`\n📥 继续获取页面 ${pageUrl} 的投票记录 (从游标继续)`);
    }
    
    // 增量更新逻辑：检查是否需要获取该页面的投票
    if (this.incrementalData.newVotesOnly && this.incrementalData.pageVoteTimestamps.has(pageUrl)) {
      const lastVoteTime = this.incrementalData.pageVoteTimestamps.get(pageUrl);
      const daysSinceLastVote = (Date.now() - lastVoteTime.getTime()) / (1000 * 60 * 60 * 24);
      
      // 如果该页面最后投票时间超过保留期，跳过获取
      if (daysSinceLastVote > this.config.voteDataRetentionDays) {
        console.log(`⏭️  跳过页面 ${pageUrl} (最后投票: ${daysSinceLastVote.toFixed(1)}天前)`);
        return {
          votes: [],
          isComplete: true,
          nextCursor: null,
          error: null,
          skipped: true
        };
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
      
      const variables = {
        pageUrl,
        first: Math.min(this.config.votesBatchSize, remainingVotes), // 智能批次大小
        ...(cursor && { after: cursor })
      };
      
      try {
        const result = await this.cromClient.request(query, variables);
        const voteData = result.wikidotPage?.fuzzyVoteRecords;
        
        if (!voteData || !voteData.edges.length) {
          break;
        }
        
        // 处理本批次的投票记录
        const batchVotes = voteData.edges.map(edge => edge.node);
        
        // 增量更新：检查是否遇到已存在的投票
        if (this.incrementalData.newVotesOnly && this.incrementalData.existingVotes.has(pageUrl)) {
          const existingVoteKeys = this.incrementalData.existingVotes.get(pageUrl);
          const newVotes = [];
          
          for (const vote of batchVotes) {
            const voteKey = `${vote.userWikidotId}-${vote.timestamp}`;
            if (existingVoteKeys.has(voteKey)) {
              foundOldVote = true;
              console.log(`🔍 发现已存在投票，停止增量获取: ${pageUrl}`);
              break;
            } else {
              newVotes.push(vote);
            }
          }
          
          allVotes.push(...newVotes);
          remainingVotes -= newVotes.length;
          
          // 如果发现老投票，停止继续获取
          if (foundOldVote) {
            hasNextPage = false;
          }
        } else {
          // 全量更新：添加所有投票
          allVotes.push(...batchVotes);
          remainingVotes -= batchVotes.length;
        }
        
        // 更新分页信息
        if (!foundOldVote) {
          hasNextPage = voteData.pageInfo.hasNextPage;
          cursor = voteData.pageInfo.endCursor;
        }
        
        // 更新rate limit追踪
        await this.updateRateLimitTracker(this.config.votesBatchSize);
        
        // 如果有更多数据需要获取，短暂延迟
        if (hasNextPage && !foundOldVote) {
          await this.sleep(100); // 减少延迟以利用更高的速率限制
        }
        
      } catch (error) {
        // 如果遇到错误，返回当前已获取的数据和游标信息
        return {
          votes: allVotes,
          isComplete: false,
          nextCursor: cursor,
          error: error.message
        };
      }
    }
    
    return {
      votes: allVotes,
      isComplete: true,
      nextCursor: null,
      error: null,
      skipped: false
    };
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

      console.log(`✅ 已加载投票进度检查点: ${latestFile}`);
      console.log(`   已完成页面: ${this.voteProgress.completedPages.size}`);
      console.log(`   部分完成页面: ${this.voteProgress.partialPages.size}`);
      console.log(`   已收集投票: ${this.voteProgress.totalVotesCollected.toLocaleString()}`);
      
    } catch (error) {
      console.log(`⚠️  加载投票进度检查点失败: ${error.message}`);
    }
  }

  async saveVoteProgressCheckpoint() {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const checkpointFile = `vote-progress-checkpoint-${timestamp}.json`;
    
    const checkpoint = {
      timestamp: new Date().toISOString(),
      completedPages: Array.from(this.voteProgress.completedPages),
      partialPages: Object.fromEntries(this.voteProgress.partialPages),
      totalVotesExpected: this.voteProgress.totalVotesExpected,
      totalVotesCollected: this.voteProgress.totalVotesCollected,
      stats: {
        votesProcessed: this.stats.votesProcessed,
        pagesProcessed: this.stats.pagesProcessed
      }
    };
    
    const checkpointPath = path.join(this.checkpointDir, checkpointFile);
    fs.writeFileSync(checkpointPath, JSON.stringify(checkpoint, null, 2));
    
    console.log(`\n💾 投票进度检查点已保存: ${checkpointFile}`);
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
    
    // 数据质量分析
    const pagesWithVotes = this.data.pages.filter(p => p.voteCount > 0).length;
    const pagesWithContent = this.data.pages.filter(p => p.sourceLength > 0).length;
    const avgVotesPerPage = this.data.voteRecords.length / this.data.pages.length;
    
    console.log('\n📊 数据质量分析:');
    console.log(`   有投票的页面: ${pagesWithVotes} (${(pagesWithVotes/this.data.pages.length*100).toFixed(1)}%)`);
    console.log(`   有内容的页面: ${pagesWithContent} (${(pagesWithContent/this.data.pages.length*100).toFixed(1)}%)`);
    console.log(`   平均投票/页面: ${avgVotesPerPage.toFixed(1)}`);
    
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

  async handleError(error, context) {
    const is429Error = error.message.includes('429') || error.status === 429;
    
    // 简化错误信息，避免打印大量body内容
    const errorMessage = is429Error ? 'Rate Limit (429)' : 
      (error.message.length > 100 ? error.message.substring(0, 100) + '...' : error.message);
    
    this.stats.errors.push({
      type: `${context}_error`,
      error: errorMessage,
      timestamp: new Date(),
      is429: is429Error
    });
    
    if (is429Error) {
      // 429错误特殊处理 - 减少重复输出
      const count429 = this.stats.errors.filter(e => e.type === `${context}_error` && e.is429).length;
      
      // 只在第1,5,10,20,30...次时显示消息，避免刷屏
      if (count429 === 1 || count429 % 5 === 0) {
        process.stdout.write(`\n⚠️  Rate Limit第${count429}次，等待${this.config.retryDelayMs/1000}s... `);
      }
      
      if (count429 >= this.config.max429Retries) {
        throw new Error(`${context} 429错误过多(${count429}次)，停止同步`);
      }
      
      await this.sleep(this.config.retryDelayMs); // 429错误后长时间等待
    } else {
      // 普通错误处理
      const generalErrors = this.stats.errors.filter(e => e.type === `${context}_error` && !e.is429).length;
      console.log(`\n❌ ${context}错误: ${errorMessage}`);
      
      if (generalErrors >= this.config.maxRetries) {
        throw new Error(`${context}一般错误过多(${generalErrors}次)，停止同步`);
      }
      
      await this.sleep(3000); // 普通错误后短暂等待
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
    // 基于300,000点/5分钟的动态频率控制
    const now = Date.now();
    
    // 清理过期的请求记录
    this.rateLimitTracker.requestHistory = this.rateLimitTracker.requestHistory
      .filter(req => now - req.timestamp < this.config.rateLimitWindowMs);
    
    // 计算当前窗口内的点数使用
    const currentUsage = this.rateLimitTracker.requestHistory
      .reduce((sum, req) => sum + req.points, 0);
    
    // 计算剩余点数
    const remainingPoints = this.config.rateLimitPoints - currentUsage;
    const usagePercentage = currentUsage / this.config.rateLimitPoints;
    
    // 动态调整延迟
    let delayMs = 1000 / this.config.maxRequestsPerSecond; // 基础延迟
    
    if (usagePercentage > 0.9) {
      // 使用超过90%，大幅延迟
      delayMs = 2000;
      this.progressState.isWaitingRateLimit = true;
    } else if (usagePercentage > 0.7) {
      // 使用超过70%，适度延迟
      delayMs = 500;
      this.progressState.isWaitingRateLimit = true;
    } else if (remainingPoints > 50000) {
      // 剩余点数充足，加速
      delayMs = 50;
      this.progressState.isWaitingRateLimit = false;
    } else {
      this.progressState.isWaitingRateLimit = false;
    }
    
    await this.sleep(delayMs);
    
    // 延迟完成后清除等待状态
    if (delayMs > 200) {
      this.progressState.isWaitingRateLimit = false;
    }
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// 运行生产环境同步
async function runProductionSync() {
  const syncService = new ProductionSync();
  await syncService.runProductionSync();
}

export { ProductionSync };

if (import.meta.url === `file://${process.argv[1]}`) {
  runProductionSync().catch(console.error);
}