/**
 * 文件路径: src/sync/strategies/update-sync-strategy-v3.js
 * 功能概述: SCPPER-CN 智能增量更新同步策略模块
 * 
 * 主要功能:
 * - 基于时间戳的真正增量更新，检测页面实际变化
 * - 独立的数据获取逻辑，不依赖 ProductionSync
 * - 智能变化检测：仅更新真正发生变化的页面和数据
 * - 增量投票记录更新，使用 GraphQL 分页避免重复数据
 * - 智能数据合并，防止覆盖现有数据
 * - 断点续传机制，支持中断恢复
 * - Rate Limit 优化和错误处理
 * 
 * 核心特性:
 * - 四阶段处理：加载→扫描→详细获取→合并
 * - 页面级精确变化检测（评分、投票数、修订时间等）
 * - 增量投票记录获取，避免全量重复
 * 
 * 使用方式:
 * - npm run update 或 node src/main.js update
 * - 支持 --test, --debug 参数
 */

import { BaseSync } from '../core/base-sync.js';
import { GraphQLClient } from 'graphql-request';
import fs from 'fs';
import path from 'path';
export class UpdateSyncStrategyV3 extends BaseSync {
  constructor(options = {}) {
    super(options);
    
    this.updateStats = {
      newPages: 0,
      changedPages: 0,
      unchangedPages: 0,
      newVotes: 0,
      newRevisions: 0,
      newAttributions: 0,
      pagesScanned: 0,
      pagesSkipped: 0,
      incrementalVoteUpdates: 0,
      totalVoteChanges: 0,
      intelligentMerges: 0,
      rateLimitOptimizations: 0,
      fieldProtections: 0
    };
    
    this.existingData = null;
    this.existingPagesMap = new Map();
    this.lastUpdateTime = null;
    this.updateCheckpoint = null;
    
    // 扩展基础配置，不覆盖BaseSync的重要配置
    this.config = {
      ...this.config, // 保留BaseSync的配置
      networkDelayMs: 250,     // 网络请求间隔
      detailedDataDelayMs: 500, // 详细数据查询间隔
      batchSize: 50,           // 批次大小
      testMode: options.testMode || false, // 测试模式：找到第一个变化页面后停止
      debug: options.debug || false, // 调试模式：显示详细的数据缺口信息
      checkpointSaveInterval: {
        scanning: 500,  // 扫描阶段每500个批次保存一次检查点
        detailed: 100   // 详细数据阶段每100个批次保存一次检查点
      }
    };
    
    // 检查点保存计数器
    this.checkpointCounters = {
      scanningBatches: 0,
      detailedBatches: 0
    };
    
    // 进度跟踪
    this.progressState = {
      totalPages: 0,
      totalChangedPages: 0,
      lastProgressUpdate: 0,
      progressUpdateInterval: 1000, // 1秒更新一次
      phase: 'loading', // loading, scanning, detailed, merging, saving
      phaseStartTime: null,
      checkpointStartCount: 0, // checkpoint恢复时的起始计数
      actualProcessedThisSession: 0 // 本次会话实际处理的数量
    };
  }
  
  /**
   * 运行增量更新同步
   */
  async runUpdateSync() {
    console.log('🔄 SCPPER-CN 真正增量更新同步开始 (v3)');
    console.log('='.repeat(80));
    console.log(`📅 开始时间: ${new Date().toLocaleString()}`);
    console.log(`🎯 目标站点: ${this.config.targetSiteUrl}`);
    console.log(`📡 API版本: v2 (${this.cromClient.url})`);
    console.log('');
    
    this.stats.startTime = new Date();
    
    try {
      // 0. 获取总页面数（用于进度条）
      await this.fetchTotalPageCount();
      
      // 1. 加载现有数据和更新时间戳
      await this.loadExistingDataAndTimestamp();
      
      // 2. 加载或创建更新检查点
      await this.loadUpdateCheckpoint();
      
      // 3. 根据检查点阶段执行相应步骤
      if (this.updateCheckpoint.phase === 'scanning' || !this.updateCheckpoint.phase) {
        // 第一阶段：扫描变化
        await this.fetchIncrementalChanges();
      }
      
      if (this.updateCheckpoint.phase === 'detailed') {
        // 第二阶段：获取详细数据（如果有变化的页面）
        await this.fetchDetailedDataForChangedPages();
      }
      
      if (this.updateCheckpoint.phase === 'merging') {
        // 第三阶段：合并数据
        await this.mergeIncrementalData();
        this.updateCheckpoint.phase = 'saving';
        await this.saveUpdateCheckpoint();
      }
      
      if (this.updateCheckpoint.phase === 'saving') {
        // 第四阶段：保存数据
        await this.saveUpdatedData();
        // 完成后清空检查点
        await this.clearUpdateCheckpoint();
      }
      
      this.stats.endTime = new Date();
      await this.generateUpdateReport();
      
    } catch (error) {
      console.error(`❌ 增量更新失败: ${error?.message || error || 'Unknown error'}`);
      this.recordError('update_sync_failed', error);
      throw error;
    }
  }
  
  /**
   * 获取总页面数（用于进度条）
   */
  async fetchTotalPageCount() {
    console.log('📊 预先获取总页面数...');
    this.progressState.phase = 'loading';
    this.progressState.phaseStartTime = Date.now();
    
    try {
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
            url: { startsWith: this.config.targetSiteUrl }
          }
        }
      };
      
      const result = await this.executeWithRetry(async () => {
        return await this.cromClient.request(query, variables);
      }, { phase: 'total_page_count' });
      
      this.progressState.totalPages = result.aggregatePages._count;
      console.log(`✅ 总页面数: ${this.progressState.totalPages.toLocaleString()}`);
      
    } catch (error) {
      console.log(`⚠️  无法获取总页面数: ${error?.message || error || 'Unknown error'}`);
      
      // 详细错误信息调试输出
      console.log('🔍 aggregatePages错误详情:');
      if (error?.response?.errors) {
        console.log('   GraphQL错误:', JSON.stringify(error.response.errors, null, 2));
      }
      if (error?.response?.status) {
        console.log('   HTTP状态:', error.response.status);
      }
      console.log('   完整错误对象:', JSON.stringify(error, null, 2));
      
      console.log('   将使用简单计数模式显示进度');
      this.progressState.totalPages = 0;
    }
  }

  /**
   * 加载现有数据和上次更新时间
   */
  async loadExistingDataAndTimestamp() {
    console.log('🔍 加载现有数据和更新时间戳...');
    
    const latestDataFile = await this.findLatestDataFile('production-data-final-');
    if (!latestDataFile) {
      throw new Error('没有找到现有数据文件，请先运行完整同步 (npm run main full)');
    }
    
    console.log(`📂 使用数据文件: ${path.basename(latestDataFile)}`);
    
    this.existingData = await this.loadDataFromFile(latestDataFile);
    
    // 从metadata中获取上次同步时间
    this.lastUpdateTime = this.existingData.metadata?.startTime ? 
      new Date(this.existingData.metadata.startTime) : 
      new Date(Date.now() - 24 * 60 * 60 * 1000); // 默认24小时前
    
    console.log(`📅 上次同步时间: ${this.lastUpdateTime.toLocaleString()}`);
    
    // 构建页面映射表
    if (this.existingData.pages) {
      this.existingData.pages.forEach(page => {
        this.existingPagesMap.set(page.url, {
          url: page.url,
          title: page.title,
          voteCount: page.voteCount || 0,
          rating: page.rating || 0,
          revisionCount: page.revisionCount || 0,
          lastRevisionTime: page.lastRevisionTime || null,
          fullData: page
        });
      });
    }
    
    console.log(`✅ 已加载现有数据: ${this.existingPagesMap.size} 个页面`);
  }
  
  /**
   * 加载更新检查点
   */
  async loadUpdateCheckpoint() {
    const checkpointPath = './production-checkpoints/update-checkpoint.json';
    
    try {
      if (fs.existsSync(checkpointPath)) {
        this.updateCheckpoint = JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));
        this.progressState.checkpointStartCount = this.updateCheckpoint.processedPages || 0;
        
        // 重置本次会话的处理计数，避免ETA计算失真
        this.progressState.actualProcessedThisSession = 0;
        
        // 恢复执行阶段和中间数据
        if (this.updateCheckpoint.phase) {
          console.log(`📋 恢复更新检查点: 阶段 ${this.updateCheckpoint.phase}, 已处理 ${this.progressState.checkpointStartCount} 个页面`);
          
          // 恢复变化分析结果
          if (this.updateCheckpoint.changeAnalysis) {
            this.changeAnalysis = this.updateCheckpoint.changeAnalysis;
            console.log(`   恢复变化分析: 新增${this.changeAnalysis.newPages.length}, 投票变化${this.changeAnalysis.votingChangedPages.length}, 内容变化${this.changeAnalysis.contentChangedPages.length}`);
          }
          
          // 恢复详细数据获取进度
          if (this.updateCheckpoint.detailedDataProgress) {
            this.detailedDataProgress = this.updateCheckpoint.detailedDataProgress;
            console.log(`   恢复详细数据进度: 已完成${this.detailedDataProgress.completed.length}, 待处理${this.detailedDataProgress.remaining.length}`);
          }
          
          // 恢复已获取的详细数据
          if (this.updateCheckpoint.detailedData) {
            this.detailedData = new Map(Object.entries(this.updateCheckpoint.detailedData));
            console.log(`   恢复详细数据: ${this.detailedData.size} 个页面`);
          }
          
          // 恢复批次计数器
          if (this.updateCheckpoint.checkpointCounters) {
            this.checkpointCounters = this.updateCheckpoint.checkpointCounters;
            console.log(`   恢复批次计数器: 扫描${this.checkpointCounters.scanningBatches}, 详细数据${this.checkpointCounters.detailedBatches}`);
          }
        } else {
          console.log(`📋 恢复更新检查点: 已处理 ${this.progressState.checkpointStartCount} 个页面`);
        }
      } else {
        this.updateCheckpoint = this.createNewCheckpoint();
        console.log('📋 创建新的更新检查点');
      }
    } catch (error) {
      console.log('⚠️  检查点文件损坏，创建新检查点');
      this.updateCheckpoint = this.createNewCheckpoint();
    }
  }

  /**
   * 创建新的检查点结构
   */
  createNewCheckpoint() {
    return {
      phase: 'scanning',
      processedPages: 0,
      lastProcessedUrl: null,
      startTime: new Date().toISOString(),
      changeAnalysis: {
        newPages: [],
        votingChangedPages: [],
        contentChangedPages: [],
        revisionChangedPages: [],
        attributionChangedPages: []
      },
      detailedDataProgress: {
        completed: [],
        remaining: []
      },
      detailedData: {}
    };
  }
  
  /**
   * 增量获取变化的页面
   * 策略：获取所有页面的完整数据（除投票记录外），然后精确检测变化类型
   */
  async fetchIncrementalChanges() {
    console.log('🔍 第一阶段：获取页面核心数据并检测变化...');
    this.progressState.phase = 'scanning';
    this.progressState.phaseStartTime = Date.now();
    
    // 第一阶段：获取核心数据用于变化检测
    const query = `
      query GetPagesBasicData($filter: PageQueryFilter, $first: Int!, $after: ID) {
        pages(filter: $filter, first: $first, after: $after) {
          edges {
            node {
              url
              ... on WikidotPage {
                title
                wikidotId
                category
                tags
                rating
                voteCount
                commentCount
                revisionCount
                createdAt
                createdBy {
                  displayName
                  wikidotId
                  unixName
                }
                thumbnailUrl
              }
            }
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    `;
    
    let hasNextPage = true;
    let cursor = this.updateCheckpoint.lastProcessedUrl ? 
      this.updateCheckpoint.lastProcessedUrl : null;
    
    this.pagesData = [];  // 存储所有页面的完整数据
    this.changeAnalysis = {
      newPages: [],
      votingChangedPages: [],
      contentChangedPages: [],
      revisionChangedPages: [],
      attributionChangedPages: [],
      unchangedPages: []
    };
    
    console.log('📊 开始获取页面完整数据...');
    
    while (hasNextPage) {
      const variables = {
        filter: {
          onWikidotPage: {
            url: { startsWith: this.config.targetSiteUrl }
          }
        },
        first: this.config.batchSize || 50,  // 核心数据查询可以使用更大的批次
        after: cursor
      };
      
      try {
        const response = await this.executeWithRetry(async () => {
          return await this.cromClient.request(query, variables);
        }, { phase: 'page_scan', cursor, batch: variables.first });
        
        const pages = response.pages.edges;
        
        // 存储页面数据并分析变化
        let newPagesInBatch = 0;
        let changedPagesInBatch = 0;
        let testModeFoundChange = false; // 测试模式标志
        
        for (const edge of pages) {
          const pageData = edge.node;
          
          // 只处理WikidotPage类型的页面
          if (!pageData.title) {
            continue; // 跳过非WikidotPage类型
          }
          
          this.updateStats.pagesScanned++;
          this.progressState.actualProcessedThisSession++; // 记录本次会话实际处理数
          this.pagesData.push(pageData);
          
          const existingPage = this.existingPagesMap.get(pageData.url);
          
          if (!existingPage) {
            // 新页面
            this.changeAnalysis.newPages.push(pageData);
            this.updateStats.newPages++;
            newPagesInBatch++;
            
            // 测试模式：找到第一个新页面后停止扫描
            if (this.config.testMode) {
              console.log(`\n🧪 测试模式：发现第一个新页面: ${pageData.url}`);
              testModeFoundChange = true;
              break; // 退出当前批次循环
            }
          } else {
            // 精确检测变化类型  
            const changeTypes = this.detectDetailedChanges(existingPage, pageData);
            if (changeTypes.length > 0) {
              changedPagesInBatch++;
            }
            this.categorizePageChanges(pageData, changeTypes);
            
            // 测试模式：找到第一个变化页面后停止扫描
            if (this.config.testMode && changeTypes.length > 0) {
              console.log(`\n🧪 测试模式：发现第一个变化页面: ${pageData.url}`);
              console.log(`   变化类型: ${changeTypes.join(', ')}`);
              testModeFoundChange = true;
              break; // 退出当前批次循环
            }
          }
          
          // 更新进度显示（加上检查点起始位置）
          this.updateProgress(this.progressState.checkpointStartCount + this.updateStats.pagesScanned, this.progressState.totalPages);
        }
        
        // 批次总结（只在有变化时显示）
        if (newPagesInBatch > 0 || changedPagesInBatch > 0) {
          // 清空当前行，输出批次总结
          process.stdout.write(`\r${' '.repeat(100)}\r\n   批次 ${Math.floor(this.updateStats.pagesScanned / variables.first)}: ${pages.length} 页面 | 新增: ${newPagesInBatch} | 变化: ${changedPagesInBatch}\n`);
        }
        
        // 更新检查点
        if (testModeFoundChange) {
          hasNextPage = false; // 测试模式：找到变化后停止
          console.log('🧪 测试模式：停止页面扫描，开始处理变化页面...');
        } else {
          hasNextPage = response.pages.pageInfo.hasNextPage;
        }
        cursor = response.pages.pageInfo.endCursor;
        
        this.updateCheckpoint.processedPages += pages.length;
        this.updateCheckpoint.lastProcessedUrl = cursor;
        this.updateCheckpoint.phase = 'scanning';
        
        // 增加批次计数器
        this.checkpointCounters.scanningBatches++;
        
        // 每N个批次保存一次检查点
        if (this.checkpointCounters.scanningBatches % this.config.checkpointSaveInterval.scanning === 0) {
          await this.saveUpdateCheckpoint();
          console.log(`💾 检查点已保存 (扫描批次: ${this.checkpointCounters.scanningBatches})`);
        }
        
        // Rate limit控制
        await this.delay(this.config.networkDelayMs || 250);
        
      } catch (error) {
        console.error(`❌ 页面扫描批次失败: ${error?.message || error || 'Unknown error'}`);
        console.log(`   当前cursor: ${cursor}`);
        console.log(`   已处理页面: ${this.updateStats.pagesScanned}`);
        
        // 详细错误信息调试输出
        console.log('🔍 详细错误信息:');
        if (error?.response?.errors) {
          console.log('   GraphQL错误:', JSON.stringify(error.response.errors, null, 2));
        }
        if (error?.response?.status) {
          console.log('   HTTP状态:', error.response.status);
        }
        if (error?.response?.data) {
          console.log('   响应数据:', JSON.stringify(error.response.data, null, 2));
        }
        console.log('   完整错误对象:', JSON.stringify(error, null, 2));
        
        // 记录错误但继续尝试下一个cursor位置（如果可能）
        this.recordError('page_scan_batch_failed', error, { 
          cursor, 
          processedPages: this.updateStats.pagesScanned 
        });
        
        // 对于严重错误，重新抛出
        if (error?.message?.includes('401') || error?.message?.includes('403')) {
          console.error('❌ 认证失败，无法继续同步');
          throw error;
        }
        
        // 对于其他错误，等待后重试当前批次
        console.log('⏳ 等待1分钟后重试当前批次...');
        await this.delay(60000); // 等待1分钟
        continue; // 重试当前批次，不移动cursor
      }
    }
    
    console.log(`✅ 页面数据获取和分析完成:`);
    console.log(`   📊 总扫描: ${this.updateStats.pagesScanned} 个`);
    console.log(`   🆕 新页面: ${this.changeAnalysis.newPages.length} 个`);
    console.log(`   🗳️  投票变化: ${this.changeAnalysis.votingChangedPages.length} 个`);
    console.log(`   📄 内容变化: ${this.changeAnalysis.contentChangedPages.length} 个`);
    console.log(`   📝 修订变化: ${this.changeAnalysis.revisionChangedPages.length} 个`);
    console.log(`   👥 合著变化: ${this.changeAnalysis.attributionChangedPages.length} 个`);
    console.log(`   ⚪ 无变化: ${this.changeAnalysis.unchangedPages.length} 个`);
    
    // 扫描阶段结束，强制保存检查点
    this.updateCheckpoint.phase = 'detailed';
    await this.saveUpdateCheckpoint();
    
    // 第二阶段：为变化的页面获取详细数据
    await this.fetchDetailedDataForChangedPages();
  }
  
  /**
   * 精确检测页面变化类型
   */
  detectDetailedChanges(existingPage, newPageData) {
    const changes = [];
    
    // 检测投票相关变化
    if ((newPageData.voteCount || 0) !== existingPage.voteCount) {
      changes.push('voting');
    }
    if ((newPageData.rating || 0) !== existingPage.rating) {
      changes.push('voting');
    }
    
    // 检测基础内容变化（只比较基础查询包含的字段）
    if (newPageData.title !== existingPage.title) {
      changes.push('content');
    }
    if (JSON.stringify(newPageData.tags || []) !== JSON.stringify(existingPage.fullData.tags || [])) {
      changes.push('content');
    }
    
    // 检测修订变化
    if ((newPageData.revisionCount || 0) !== existingPage.revisionCount) {
      changes.push('revision');
    }
    
    // 检测合著变化 - 如果新数据包含 attributions 信息
    if (newPageData.attributions && existingPage.fullData?.attributions) {
      if (this.hasAttributionChanges(existingPage.fullData.attributions, newPageData.attributions)) {
        changes.push('attribution');
      }
    }
    // 如果现有页面有合著信息但新数据没有，也视为变更
    else if (existingPage.fullData?.attributions && existingPage.fullData.attributions.length > 0 && !newPageData.attributions) {
      changes.push('attribution');
    }
    
    // 注意：source 的变化检测需要在获取详细数据后进行
    // 这里不检测 source 字段，因为基础查询不包含它
    
    return [...new Set(changes)]; // 去重
  }
  
  /**
   * 检测合著信息变化
   */
  hasAttributionChanges(existingAttributions, newAttributions) {
    if (existingAttributions.length !== newAttributions.length) {
      return true;
    }
    
    // 简单的内容比较（可以优化为更精确的比较）
    const existingSignature = existingAttributions
      .map(attr => `${attr.type}-${attr.order}-${attr.userName}`)
      .sort()
      .join('|');
    
    const newSignature = newAttributions
      .map(attr => {
        const wikidotUser = attr.user?.wikidotUser;
        const userName = wikidotUser?.displayName || attr.user?.displayName || 'Unknown';
        return `${attr.type}-${attr.order}-${userName}`;
      })
      .sort()
      .join('|');
    
    return existingSignature !== newSignature;
  }
  
  /**
   * 根据变化类型分类页面
   */
  categorizePageChanges(pageData, changeTypes) {
    if (changeTypes.length === 0) {
      this.changeAnalysis.unchangedPages.push(pageData);
      this.updateStats.unchangedPages++;
      return;
    }
    
    let categorized = false;
    
    if (changeTypes.includes('voting')) {
      this.changeAnalysis.votingChangedPages.push(pageData);
      // 清空当前行，输出变化信息
      process.stdout.write(`\r${' '.repeat(100)}\r     🗳️  投票变化: ${pageData.title}\n`);
      categorized = true;
    }
    
    if (changeTypes.includes('content')) {
      this.changeAnalysis.contentChangedPages.push(pageData);
      if (!categorized) {
        process.stdout.write(`\r${' '.repeat(100)}\r     📄 内容变化: ${pageData.title}\n`);
      }
      categorized = true;
    }
    
    if (changeTypes.includes('revision')) {
      this.changeAnalysis.revisionChangedPages.push(pageData);
      if (!categorized) {
        process.stdout.write(`\r${' '.repeat(100)}\r     📝 修订变化: ${pageData.title}\n`);
      }
      categorized = true;
    }
    
    if (changeTypes.includes('attribution')) {
      this.changeAnalysis.attributionChangedPages.push(pageData);
      if (!categorized) {
        process.stdout.write(`\r${' '.repeat(100)}\r     👥 合著变化: ${pageData.title}\n`);
      }
      categorized = true;
    }
    
    this.updateStats.changedPages++;
  }
  
  /**
   * 第二阶段：为变化的页面获取详细数据（revisions、attributions、voting等）
   */
  async fetchDetailedDataForChangedPages() {
    // 构建带有数据需求的页面对象列表
    const pagesWithNeeds = [];
    
    // 新页面：需要所有数据
    for (const page of this.changeAnalysis.newPages) {
      pagesWithNeeds.push({
        url: page.url,
        needs: {
          needsSource: true,
          needsVoting: true,
          needsRevisions: true,
          needsAttributions: true,
          needsAlternateTitles: true
        },
        reason: 'new_page'
      });
    }
    
    // 投票变化页面：主要需要投票数据，但也要更新基础信息
    for (const page of this.changeAnalysis.votingChangedPages) {
      pagesWithNeeds.push({
        url: page.url,
        needs: {
          needsSource: false,  // 评分变化通常不需要重新获取源代码
          needsVoting: true,
          needsRevisions: false,
          needsAttributions: false,
          needsAlternateTitles: false
        },
        reason: 'voting_changed'
      });
    }
    
    // 内容变化页面：需要源代码和修订信息
    for (const page of this.changeAnalysis.contentChangedPages) {
      pagesWithNeeds.push({
        url: page.url,
        needs: {
          needsSource: true,
          needsVoting: false,  // 内容变化时不一定需要重新获取投票
          needsRevisions: true,
          needsAttributions: true,
          needsAlternateTitles: true
        },
        reason: 'content_changed'
      });
    }
    
    // 修订变化页面：需要修订信息
    for (const page of this.changeAnalysis.revisionChangedPages) {
      pagesWithNeeds.push({
        url: page.url,
        needs: {
          needsSource: false,
          needsVoting: false,
          needsRevisions: true,
          needsAttributions: false,
          needsAlternateTitles: false
        },
        reason: 'revision_changed'
      });
    }
    
    // 合著变化页面：需要合著信息
    for (const page of this.changeAnalysis.attributionChangedPages) {
      pagesWithNeeds.push({
        url: page.url,
        needs: {
          needsSource: false,
          needsVoting: false,
          needsRevisions: false,
          needsAttributions: true,
          needsAlternateTitles: false
        },
        reason: 'attribution_changed'
      });
    }
    
    // 精细化数据需求识别：识别数据缺口的智能需求
    const smartNeeds = this.identifySmartDataNeeds(this.changeAnalysis.unchangedPages);
    
    // 添加轻量级数据需求页面
    for (const pageObj of smartNeeds.lightweightPages) {
      pagesWithNeeds.push({
        url: pageObj.url,
        needs: pageObj.needs,
        reason: 'data_gap_lightweight'
      });
    }
    
    // 添加仅投票数据需求页面
    for (const pageObj of smartNeeds.votingOnlyPages) {
      pagesWithNeeds.push({
        url: pageObj.url,
        needs: pageObj.needs,
        reason: 'data_gap_voting'
      });
    }
    
    // 添加完整数据需求页面
    for (const pageObj of smartNeeds.fullDataPages) {
      pagesWithNeeds.push({
        url: pageObj.url,
        needs: pageObj.needs,
        reason: 'data_gap_full'
      });
    }
    
    // 去重（基于URL）
    const uniquePagesMap = new Map();
    for (const pageObj of pagesWithNeeds) {
      if (!uniquePagesMap.has(pageObj.url)) {
        uniquePagesMap.set(pageObj.url, pageObj);
      } else {
        // 如果有重复，合并需求（取较宽松的需求）
        const existing = uniquePagesMap.get(pageObj.url);
        existing.needs = {
          needsSource: existing.needs.needsSource || pageObj.needs.needsSource,
          needsVoting: existing.needs.needsVoting || pageObj.needs.needsVoting,
          needsRevisions: existing.needs.needsRevisions || pageObj.needs.needsRevisions,
          needsAttributions: existing.needs.needsAttributions || pageObj.needs.needsAttributions,
          needsAlternateTitles: existing.needs.needsAlternateTitles || pageObj.needs.needsAlternateTitles
        };
        existing.reason = `${existing.reason}+${pageObj.reason}`;
      }
    }
    
    const uniquePagesWithNeeds = Array.from(uniquePagesMap.values());
    
    if (uniquePagesWithNeeds.length === 0) {
      console.log('✅ 无页面需要更新详细数据');
      return;
    }
    
    // 计算预期的 Rate Limit 节省
    const lightweightCount = uniquePagesWithNeeds.filter(p => 
      !p.needs.needsVoting && (p.needs.needsSource || p.needs.needsRevisions || p.needs.needsAttributions)
    ).length;
    const votingOnlyCount = uniquePagesWithNeeds.filter(p => 
      p.needs.needsVoting && !p.needs.needsSource && !p.needs.needsRevisions && !p.needs.needsAttributions
    ).length;
    const fullDataCount = uniquePagesWithNeeds.length - lightweightCount - votingOnlyCount;
    
    console.log(`🔍 第二阶段：智能获取 ${uniquePagesWithNeeds.length} 个页面的详细数据`);
    console.log(`   轻量级: ${lightweightCount}个 | 仅投票: ${votingOnlyCount}个 | 完整数据: ${fullDataCount}个`);
    console.log(`   预计节省 Rate Limit: ${((lightweightCount * 0.3 + votingOnlyCount * 0.4) * 100).toFixed(0)}%`);
    
    this.progressState.phase = 'detailed';
    this.progressState.phaseStartTime = Date.now();
    this.progressState.totalChangedPages = uniquePagesWithNeeds.length;
    this.progressState.actualProcessedThisSession = 0;
    this.progressState.checkpointStartCount = 0;
    
    // 初始化或恢复详细数据进度跟踪
    if (!this.detailedDataProgress) {
      this.detailedDataProgress = {
        completed: [],
        remaining: uniquePagesWithNeeds  // 现在存储带有需求信息的页面对象
      };
    }
    
    // 初始化或恢复详细数据存储
    if (!this.detailedData) {
      this.detailedData = new Map();
    }
    
    // 分批获取详细数据 - 轻量级数据可以使用更大的批次
    const batchSize = this.config.batchSize || 50;
    let detailedPagesProcessed = this.detailedDataProgress.completed.length;
    
    while (this.detailedDataProgress.remaining.length > 0) {
      const batch = this.detailedDataProgress.remaining.splice(0, batchSize);
      console.log(`   详细数据批次: 获取 ${batch.length} 个页面 (剩余: ${this.detailedDataProgress.remaining.length})`);
      
      try {
        const batchDetailedData = await this.fetchDetailedDataBatch(batch);
        batchDetailedData.forEach(pageData => {
          if (pageData) {
            this.detailedData.set(pageData.url, pageData);
            this.detailedDataProgress.completed.push(pageData.url);
            detailedPagesProcessed++;
            this.progressState.actualProcessedThisSession++;
          }
        });
        
        // 更新详细数据获取进度
        this.updateProgress(detailedPagesProcessed, this.progressState.totalChangedPages, 'detailed');
        
        // 增加批次计数器
        this.checkpointCounters.detailedBatches++;
        
        // 每N个批次保存一次检查点
        if (this.checkpointCounters.detailedBatches % this.config.checkpointSaveInterval.detailed === 0) {
          await this.saveUpdateCheckpoint();
          console.log(`💾 检查点已保存 (详细数据批次: ${this.checkpointCounters.detailedBatches})`);
        }
        
        await this.delay(this.config.networkDelayMs || 250);
        
      } catch (error) {
        console.error(`❌ 详细数据批次失败: ${error?.message || error || 'Unknown error'}`);
        this.recordError('detailed_data_batch_failed', error, { 
          batch_size: batch.length,
          remaining_count: this.detailedDataProgress.remaining.length
        });
        
        // 将失败的批次放回待处理列表头部
        this.detailedDataProgress.remaining.unshift(...batch);
        
        // 等待1分钟后重试
        console.log('⏳ 等待1分钟后重试当前详细数据批次...');
        await this.delay(60000);
        // 继续处理（失败的批次已经放回待处理列表）
        continue;
      }
    }
    
    console.log(`✅ 详细数据获取完成: ${this.detailedData.size} 个页面`);
    
    // 详细数据获取阶段结束，强制保存检查点
    this.updateCheckpoint.phase = 'merging';
    await this.saveUpdateCheckpoint();
  }
  
  /**
   * 根据需求获取不同类型的详细数据，优化Rate Limit消耗
   */
  async fetchDetailedDataSingle(url, dataNeeds = {}) {
    const {
      needsSource = false,        // 默认改为 false，按需获取
      needsVoting = false,        // 默认改为 false，避免高开销字段
      needsRevisions = false,     // 默认改为 false，按需获取
      needsAttributions = false,  // 默认改为 false，按需获取
      needsAlternateTitles = false // 默认改为 false，按需获取
    } = dataNeeds;
    
    // 构建有选择性的查询
    const queryParts = [];
    
    if (needsSource) {
      queryParts.push('source');
    }
    
    if (needsVoting) {
      queryParts.push(`
            # 投票记录 (高Rate Limit消耗)
            fuzzyVoteRecords {
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
              }
            }`);
    }
    
    if (needsRevisions) {
      queryParts.push(`
            # 修订历史
            revisions {
              edges {
                node {
                  wikidotId
                  timestamp
                  type
                  comment
                  user {
                    displayName
                    wikidotId
                    unixName
                  }
                }
              }
            }`);
    }
    
    if (needsAttributions) {
      queryParts.push(`
            # 合著信息
            attributions {
              type
              date
              order
              user {
                displayName
                ... on UserWikidotNameReference {
                  wikidotUser {
                    displayName
                    wikidotId
                    unixName
                  }
                }
              }
            }`);
    }
    
    if (needsAlternateTitles) {
      queryParts.push(`
            # 备用标题
            alternateTitles {
              title
            }`);
    }
    
    const query = `
      query GetSelectedData($url: URL!) {
        page(url: $url) {
          url
          ... on WikidotPage {
            title
            rating
            voteCount
            revisionCount
            createdAt
            commentCount
            tags
            createdBy {
              ... on WikidotUser {
                displayName
                wikidotId
              }
            }
            ${queryParts.join('')}
          }
        }
      }
    `;
    
    try {
      const response = await this.executeWithRetry(async () => {
        return await this.cromClient.request(query, { url });
      }, { phase: 'detailed_data', url });
      
      return response.page;
    } catch (error) {
      console.error(`❌ 获取页面详细数据失败 ${url}: ${error?.message || error || 'Unknown error'}`);
      this.recordError('detailed_data_fetch_failed', error, { url });
      return null;
    }
  }

  /**
   * 批量获取详细数据（使用真正的并行处理提升性能）
   */
  async fetchDetailedDataBatch(pageObjects) {
    const promises = pageObjects.map(async (pageObj) => {
      // 支持旧格式（纯URL字符串）和新格式（包含需求的对象）
      const url = typeof pageObj === 'string' ? pageObj : pageObj.url;
      const needs = typeof pageObj === 'string' ? {} : pageObj.needs;
      
      return await this.fetchDetailedDataSingle(url, needs);
    });
    
    // 并行执行所有请求，过滤掉null结果
    const results = await Promise.all(promises);
    return results.filter(result => result !== null);
  }
  
  /**
   * 保存更新检查点
   */
  async saveUpdateCheckpoint() {
    const checkpointPath = './production-checkpoints/update-checkpoint.json';
    
    try {
      const dir = path.dirname(checkpointPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      
      // 更新检查点内容
      this.updateCheckpoint.lastSaved = new Date().toISOString();
      this.updateCheckpoint.changeAnalysis = this.changeAnalysis;
      this.updateCheckpoint.detailedDataProgress = this.detailedDataProgress;
      this.updateCheckpoint.checkpointCounters = this.checkpointCounters;
      
      // 将 Map 转换为 Object 以便序列化
      if (this.detailedData && this.detailedData.size > 0) {
        this.updateCheckpoint.detailedData = Object.fromEntries(this.detailedData);
      }
      
      fs.writeFileSync(checkpointPath, JSON.stringify(this.updateCheckpoint, null, 2));
    } catch (error) {
      console.error(`⚠️  保存检查点失败: ${error?.message || error || 'Unknown error'}`);
      this.recordError('checkpoint_save_failed', error);
      // 检查点保存失败不应该中断同步过程
    }
  }
  
  /**
   * 清空更新检查点
   */
  async clearUpdateCheckpoint() {
    const checkpointPath = './production-checkpoints/update-checkpoint.json';
    
    try {
      if (fs.existsSync(checkpointPath)) {
        fs.unlinkSync(checkpointPath);
        console.log('🗑️  已清理更新检查点');
      }
    } catch (error) {
      console.error(`⚠️  清理检查点失败: ${error?.message || error || 'Unknown error'}`);
      // 清理失败不影响主流程
    }
  }
  
  /**
   * 合并增量数据
   */
  async mergeIncrementalData() {
    console.log('\n🔄 智能合并增量数据...');
    this.progressState.phase = 'merging';
    this.progressState.phaseStartTime = Date.now();
    
    // 从现有数据开始 - 包括所有现有页面
    this.mergedData = {
      pages: [...(this.existingData.pages || [])],  // 从现有页面开始，不是空数组！
      voteRecords: [...(this.existingData.voteRecords || [])],
      users: [...(this.existingData.users || [])],
      attributions: [...(this.existingData.attributions || [])],
      revisions: [...(this.existingData.revisions || [])],
      alternateTitles: [...(this.existingData.alternateTitles || [])]
    };
    
    // 构建需要合并的页面URL集合（仅包含有变化或有数据缺口的页面）
    const pagesToMerge = new Set([
      ...this.changeAnalysis.newPages.map(p => p.url),
      ...this.changeAnalysis.votingChangedPages.map(p => p.url),
      ...this.changeAnalysis.contentChangedPages.map(p => p.url),
      ...this.changeAnalysis.revisionChangedPages.map(p => p.url),
      ...this.changeAnalysis.attributionChangedPages.map(p => p.url)
    ]);
    
    // 添加有数据缺口的页面
    const smartNeeds = this.identifySmartDataNeeds(this.changeAnalysis.unchangedPages);
    for (const pageObj of [...smartNeeds.lightweightPages, ...smartNeeds.votingOnlyPages, ...smartNeeds.fullDataPages]) {
      pagesToMerge.add(pageObj.url);
    }
    
    console.log(`   合并页面: ${pagesToMerge.size} 个 (跳过 ${this.pagesData.length - pagesToMerge.size} 个未变化页面)`);
    
    // 仅合并需要更新的页面数据
    for (const pageData of this.pagesData) {
      if (pagesToMerge.has(pageData.url)) {
        await this.mergePageDataIntelligently(pageData);
      }
      // 未变化且无数据缺口的页面直接跳过，沿用现有数据
    }
    
    console.log('✅ 智能增量数据合并完成');
    console.log(`   页面总数: ${this.mergedData.pages.length}`);
    console.log(`   投票记录: ${this.mergedData.voteRecords.length}`);
    console.log(`   合著记录: ${this.mergedData.attributions.length}`);
  }
  
  /**
   * 智能合并单个页面数据
   */
  async mergePageDataIntelligently(pageData) {
    // 处理页面基础数据
    const processedPage = this.processPageData(pageData);
    
    const existingPage = this.existingPagesMap.get(pageData.url);
    const isNewPage = !existingPage;
    
    if (isNewPage) {
      // 新页面：直接添加
      this.mergedData.pages.push(processedPage);
    } else {
      // 现有页面：找到并替换
      const existingIndex = this.mergedData.pages.findIndex(p => p.url === pageData.url);
      if (existingIndex !== -1) {
        this.mergedData.pages[existingIndex] = processedPage;
      } else {
        // 如果没找到（理论上不应该发生），则添加
        this.mergedData.pages.push(processedPage);
      }
    }
    
    // 根据变化类型智能更新相关数据
    if (isNewPage) {
      // 新页面：添加所有相关数据
      await this.addAllRelatedData(pageData);
    } else {
      // 检查需要更新的数据类型
      const changeTypes = this.detectDetailedChanges(existingPage, pageData);
      await this.updateSelectedRelatedData(pageData, changeTypes);
    }
  }
  
  /**
   * 添加新页面的所有相关数据
   */
  async addAllRelatedData(pageData) {
    const pageUrl = pageData.url;
    const detailedPageData = this.detailedData.get(pageUrl);
    
    // 添加投票记录（如果有）
    if (detailedPageData?.fuzzyVoteRecords?.edges) {
      for (const edge of detailedPageData.fuzzyVoteRecords.edges) {
        const vote = edge.node;
        this.mergedData.voteRecords.push({
          pageUrl: pageUrl,
          pageTitle: pageData.title,
          voterWikidotId: vote.userWikidotId,
          voterName: vote.user?.displayName || 'Unknown',
          direction: vote.direction,
          timestamp: vote.timestamp
        });
      }
    }
    
    // 添加修订记录
    if (detailedPageData?.revisions?.edges) {
      for (const edge of detailedPageData.revisions.edges) {
        const revision = edge.node;
        this.mergedData.revisions.push({
          pageUrl: pageUrl,
          pageTitle: pageData.title,
          revisionId: revision.wikidotId,
          timestamp: revision.timestamp,
          userId: revision.user?.wikidotId,
          userName: revision.user?.displayName,
          userUnixName: revision.user?.unixName,
          comment: revision.comment
        });
      }
    }
    
    // 添加合著记录
    if (detailedPageData?.attributions) {
      for (const attr of detailedPageData.attributions) {
        const wikidotUser = attr.user?.wikidotUser;
        this.mergedData.attributions.push({
          pageUrl: pageUrl,
          pageTitle: pageData.title,
          userId: wikidotUser?.wikidotId || null,
          userName: wikidotUser?.displayName || attr.user?.displayName || `Unknown_${wikidotUser?.wikidotId || 'User'}`,
          userUnixName: wikidotUser?.unixName || null,
          attributionType: attr.type,
          date: attr.date,
          order: attr.order
        });
      }
    }
    
    // 添加备用标题
    if (detailedPageData?.alternateTitles) {
      for (const title of detailedPageData.alternateTitles) {
        this.mergedData.alternateTitles.push({
          pageUrl: pageUrl,
          title: title.title,
          language: 'unknown' // 使用默认值，因为API不提供language字段
        });
      }
    }
  }
  
  /**
   * 根据变化类型选择性更新相关数据
   */
  /**
   * 智能数据合并：只更新变化的部分，保护现有数据不被覆盖
   */
  async updateSelectedRelatedData(pageData, changeTypes) {
    const pageUrl = pageData.url;
    const detailedPageData = this.detailedData.get(pageUrl);
    
    // 投票记录智能合并
    if (changeTypes.includes('voting')) {
      await this.mergeVoteRecordsIncrementally(pageUrl, pageData.title, detailedPageData);
    }
    
    // 修订记录智能合并
    if (changeTypes.includes('revision')) {
      this.mergeRevisionsIncrementally(pageUrl, pageData.title, detailedPageData);
    }
    
    // 合著记录智能合并
    if (changeTypes.includes('attribution')) {
      this.mergeAttributionsIncrementally(pageUrl, pageData.title, detailedPageData);
    }
    
    // 备用标题智能合并
    this.mergeAlternateTitlesIncrementally(pageUrl, detailedPageData);
  }
  
  /**
   * 增量更新投票记录 - 使用fuzzyVoteRecords的last参数优化
   */
  async mergeVoteRecordsIncrementally(pageUrl, pageTitle, detailedPageData) {
    // 对于投票变化的页面，使用真正的增量获取
    if (this.changeAnalysis.votingChangedPages.some(p => p.url === pageUrl)) {
      console.log(`   📊 增量获取投票记录: ${pageUrl}`);
      return await this.fetchAndMergeVoteRecordsIncrementally(pageUrl, pageTitle);
    }
    
    // 对于其他页面，使用传统的完整数据处理
    if (!detailedPageData?.fuzzyVoteRecords?.edges) {
      console.log(`⚠️  页面 ${pageUrl} 无新投票数据，保持现有记录`);
      return;
    }
    
    // 获取现有投票记录
    const existingVotes = this.mergedData.voteRecords.filter(v => v.pageUrl === pageUrl);
    const existingVoteMap = new Map();
    existingVotes.forEach(vote => {
      const key = `${vote.voterWikidotId}_${vote.timestamp}`;
      existingVoteMap.set(key, vote);
    });
    
    // 处理投票数据
    const newVotes = [];
    let updatedCount = 0;
    
    for (const edge of detailedPageData.fuzzyVoteRecords.edges) {
      const vote = edge.node;
      const voteKey = `${vote.userWikidotId}_${vote.timestamp}`;
      
      const newVoteRecord = {
        pageUrl: pageUrl,
        pageTitle: pageTitle,
        voterWikidotId: vote.userWikidotId,
        voterName: vote.user?.displayName || 'Unknown',
        direction: vote.direction,
        timestamp: vote.timestamp
      };
      
      if (!existingVoteMap.has(voteKey)) {
        // 新投票记录
        newVotes.push(newVoteRecord);
      } else {
        // 检查是否需要更新（投票方向可能变化）
        const existingVote = existingVoteMap.get(voteKey);
        if (existingVote.direction !== vote.direction || existingVote.voterName !== newVoteRecord.voterName) {
          // 更新现有记录
          Object.assign(existingVote, newVoteRecord);
          updatedCount++;
        }
        existingVoteMap.delete(voteKey); // 标记为已处理
      }
    }
    
    // 添加新投票记录
    if (newVotes.length > 0) {
      this.mergedData.voteRecords.push(...newVotes);
    }
    
    if (this.debug) {
      console.log(`   📊 投票增量更新: ${pageUrl} - 新增${newVotes.length}, 更新${updatedCount}`);
    }
    
    // 记录Rate Limit优化统计
    if (newVotes.length > 0 || updatedCount > 0) {
      this.updateStats.incrementalVoteUpdates++;
      this.updateStats.totalVoteChanges += newVotes.length + updatedCount;
      this.updateStats.intelligentMerges++;
    }
  }
  
  /**
   * 真正的增量投票记录获取 - 使用 GraphQL 分页
   */
  async fetchAndMergeVoteRecordsIncrementally(pageUrl, pageTitle) {
    // 获取现有投票记录用于比较
    const existingVotes = this.mergedData.voteRecords.filter(v => v.pageUrl === pageUrl);
    const existingVoteMap = new Set();
    existingVotes.forEach(vote => {
      const key = `${vote.voterWikidotId}_${vote.timestamp}`;
      existingVoteMap.add(key);
    });
    
    const newVotes = [];
    let hasNextPage = true;
    let after = null;
    const batchSize = 50; // 每次获取50条投票记录
    
    console.log(`   🔄 增量获取投票: ${pageUrl} (现有 ${existingVotes.length} 条)`);
    
    while (hasNextPage) {
      try {
        const query = `
          query FetchIncrementalVotes($pageUrl: URL!, $first: Int, $after: ID) {
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
          pageUrl: pageUrl,
          first: batchSize,
          after: after
        };
        
        const result = await this.cromClient.request(query, variables);
        const voteData = result.wikidotPage?.fuzzyVoteRecords;
        
        if (!voteData?.edges || voteData.edges.length === 0) {
          break;
        }
        
        let foundExisting = false;
        
        for (const edge of voteData.edges) {
          const vote = edge.node;
          const voteKey = `${vote.userWikidotId}_${vote.timestamp}`;
          
          if (existingVoteMap.has(voteKey)) {
            // 遇到已存在的投票，说明增量获取完成
            foundExisting = true;
            break;
          }
          
          // 新投票记录
          newVotes.push({
            pageUrl: pageUrl,
            pageTitle: pageTitle,
            voterWikidotId: vote.userWikidotId,
            voterName: vote.user?.displayName || 'Unknown',
            direction: vote.direction,
            timestamp: vote.timestamp
          });
        }
        
        if (foundExisting) {
          console.log(`   ✅ 遇到已存在投票，增量获取完成`);
          break;
        }
        
        // 更新分页参数
        hasNextPage = voteData.pageInfo?.hasNextPage || false;
        after = voteData.pageInfo?.endCursor;
        
        if (this.debug && newVotes.length > 0) {
          console.log(`   📄 分页获取: +${voteData.edges.length} 条投票 (总计: ${newVotes.length})`);
        }
        
        // 添加延迟避免Rate Limit
        await this.delay(200);
        
      } catch (error) {
        console.error(`   ❌ 增量投票获取失败: ${error.message}`);
        break;
      }
    }
    
    // 合并新投票记录
    if (newVotes.length > 0) {
      this.mergedData.voteRecords.push(...newVotes);
      console.log(`   📊 增量投票完成: ${pageUrl} - 新增 ${newVotes.length} 条记录`);
      
      // 更新统计
      this.updateStats.incrementalVoteUpdates++;
      this.updateStats.totalVoteChanges += newVotes.length;
      this.updateStats.intelligentMerges++;
    } else {
      console.log(`   ⚪ 无新投票记录: ${pageUrl}`);
    }
  }
  
  /**
   * 增量更新修订记录
   */
  mergeRevisionsIncrementally(pageUrl, pageTitle, detailedPageData) {
    if (!detailedPageData?.revisions?.edges) {
      console.log(`⚠️  页面 ${pageUrl} 无新修订数据，保持现有记录`);
      return;
    }
    
    // 获取现有修订记录
    const existingRevisions = this.mergedData.revisions.filter(r => r.pageUrl === pageUrl);
    const existingRevisionIds = new Set(existingRevisions.map(r => r.revisionId));
    
    // 处理新修订数据  
    const newRevisions = [];
    for (const edge of detailedPageData.revisions.edges) {
      const revision = edge.node;
      if (!existingRevisionIds.has(revision.wikidotId)) {
        newRevisions.push({
          pageUrl: pageUrl,
          pageTitle: pageTitle,
          revisionId: revision.wikidotId,
          timestamp: revision.timestamp,
          userId: revision.user?.wikidotId,
          userName: revision.user?.displayName,
          userUnixName: revision.user?.unixName,
          comment: revision.comment
        });
      }
    }
    
    // 添加新修订记录
    if (newRevisions.length > 0) {
      this.mergedData.revisions.push(...newRevisions);
      if (this.debug) {
        console.log(`   📝 修订增量更新: ${pageUrl} - 新增${newRevisions.length}条记录`);
      }
    }
  }
  
  /**
   * 增量更新合著记录
   */
  mergeAttributionsIncrementally(pageUrl, pageTitle, detailedPageData) {
    if (!detailedPageData?.attributions) {
      if (this.debug) {
        console.log(`   👥 合著更新: ${pageUrl} - 无新数据，保留现有数据`);
      }
      return; // 保留现有数据，不删除
    }
    
    // 先检查新数据是否有效（非空数组且包含有效记录）
    const validNewAttributions = detailedPageData.attributions.filter(attr => 
      attr && (attr.user?.wikidotUser?.wikidotId || attr.user?.displayName)
    );
    
    if (validNewAttributions.length === 0) {
      if (this.debug) {
        console.log(`   👥 合著更新: ${pageUrl} - 新数据无效，保留现有数据`);
      }
      return; // 如果新数据无效，保留现有数据
    }
    
    // 仅当有有效新数据时才替换
    // 移除旧合著记录
    this.mergedData.attributions = this.mergedData.attributions.filter(a => a.pageUrl !== pageUrl);
    
    // 添加新的有效合著记录
    const newAttributions = [];
    for (const attr of validNewAttributions) {  // 使用已验证的有效数据
      const wikidotUser = attr.user?.wikidotUser;
      newAttributions.push({
        pageUrl: pageUrl,
        pageTitle: pageTitle,
        userId: wikidotUser?.wikidotId || null,
        userName: wikidotUser?.displayName || attr.user?.displayName || `Unknown_${wikidotUser?.wikidotId || 'User'}`,
        userUnixName: wikidotUser?.unixName || null,
        attributionType: attr.type,
        date: attr.date,
        order: attr.order
      });
    }
    
    this.mergedData.attributions.push(...newAttributions);
    if (this.debug) {
      console.log(`   👥 合著更新: ${pageUrl} - 替换${newAttributions.length}条有效记录`);
    }
  }
  
  /**
   * 增量更新备用标题
   */ 
  mergeAlternateTitlesIncrementally(pageUrl, detailedPageData) {
    if (!detailedPageData?.alternateTitles) {
      if (this.debug) {
        console.log(`   🏷️  备用标题更新: ${pageUrl} - 无新数据，保留现有数据`);
      }
      return; // 保留现有数据，不删除
    }
    
    // 先检查新数据是否有效（非空数组且包含有效标题）
    const validNewTitles = detailedPageData.alternateTitles.filter(title => 
      title && title.title && title.title.trim() !== ''
    );
    
    if (validNewTitles.length === 0) {
      if (this.debug) {
        console.log(`   🏷️  备用标题更新: ${pageUrl} - 新数据无效，保留现有数据`);
      }
      return; // 如果新数据无效，保留现有数据
    }
    
    // 仅当有有效新数据时才替换
    // 移除旧的备用标题
    this.mergedData.alternateTitles = this.mergedData.alternateTitles.filter(t => t.pageUrl !== pageUrl);
    
    // 添加新的有效备用标题
    const newTitles = validNewTitles.map(title => ({
      pageUrl: pageUrl,
      title: title.title,
      language: 'unknown'
    }));
    
    this.mergedData.alternateTitles.push(...newTitles);
    if (this.debug && newTitles.length > 0) {
      console.log(`   🏷️  备用标题更新: ${pageUrl} - ${newTitles.length}条有效记录`);
    }
  }
  
  /**
   * 处理页面数据格式 - 实现字段级数据保护
   * 保护现有数据不被新数据中的null/undefined值覆盖
   */
  processPageData(pageData) {
    const detailedPageData = this.detailedData.get(pageData.url);
    const existingPage = this.existingPagesMap.get(pageData.url)?.fullData;
    
    return {
      url: pageData.url,
      wikidotId: pageData.wikidotId,
      title: this.smartMergeField(pageData.title, existingPage?.title),
      category: this.smartMergeField(pageData.category, existingPage?.category),
      tags: this.smartMergeArray(pageData.tags, existingPage?.tags),
      rating: this.smartMergeNumber(pageData.rating, existingPage?.rating),
      voteCount: this.smartMergeNumber(pageData.voteCount, existingPage?.voteCount),
      commentCount: this.smartMergeNumber(pageData.commentCount, existingPage?.commentCount),
      revisionCount: this.smartMergeNumber(pageData.revisionCount, existingPage?.revisionCount),
      createdAt: this.smartMergeField(pageData.createdAt, existingPage?.createdAt),
      createdByUser: this.smartMergeField(pageData.createdBy?.displayName, existingPage?.createdByUser),
      createdByUserId: this.smartMergeField(pageData.createdBy?.wikidotId, existingPage?.createdByUserId),
      source: this.smartMergeSource(detailedPageData, existingPage),
      thumbnailUrl: this.smartMergeField(pageData.thumbnailUrl, existingPage?.thumbnailUrl),
      lastRevisionTime: this.smartMergeField(
        detailedPageData?.revisions?.edges?.[0]?.node?.timestamp,
        existingPage?.lastRevisionTime
      ),
      lastSyncedAt: new Date().toISOString()
    };
  }
  
  /**
   * 智能字段合并：优先使用新数据，但保护现有数据不被 null/undefined 覆盖
   */
  smartMergeField(newValue, existingValue) {
    // 记录字段保护统计
    if ((newValue === null || newValue === undefined || newValue === '') && 
        (existingValue !== null && existingValue !== undefined && existingValue !== '')) {
      this.updateStats.fieldProtections = (this.updateStats.fieldProtections || 0) + 1;
    }
    
    if (newValue !== null && newValue !== undefined && newValue !== '') {
      return newValue;
    }
    return existingValue !== null && existingValue !== undefined ? existingValue : newValue;
  }
  
  /**
   * 智能数字合并：特殊处理数字类型，0 是有效值
   */
  smartMergeNumber(newValue, existingValue) {
    if (typeof newValue === 'number' && !isNaN(newValue)) {
      return newValue;
    }
    return (typeof existingValue === 'number' && !isNaN(existingValue)) ? existingValue : (newValue || 0);
  }
  
  /**
   * 智能数组合并：优先使用新数组，保护非空现有数组
   */
  smartMergeArray(newArray, existingArray) {
    if (Array.isArray(newArray) && newArray.length > 0) {
      return newArray;
    }
    return (Array.isArray(existingArray) && existingArray.length > 0) ? existingArray : (newArray || []);
  }
  
  /**
   * 智能数据需求识别：最小化Rate Limit消耗
   * 按照优先级和消耗级别精细分类
   */
  identifyDataGaps(unchangedPages) {
    const smartNeeds = this.identifySmartDataNeeds(unchangedPages);
    
    // 转换为旧格式以保持兼容性
    const result = {
      missingSource: smartNeeds.stats.missingSource,
      incompleteVoting: smartNeeds.stats.incompleteVoting,
      incompleteRevisions: smartNeeds.stats.incompleteRevisions,
      totalPages: smartNeeds.stats.totalPages,
      pagesToFetch: [
        ...smartNeeds.lightweightPages.map(p => p.url),
        ...smartNeeds.votingOnlyPages.map(p => p.url),
        ...smartNeeds.fullDataPages.map(p => p.url)
      ],
      // 新增：优化信息
      smartNeeds: smartNeeds
    };
    
    return result;
  }

  /**
   * 智能数据需求识别：最小化Rate Limit消耗
   * 按照优先级和消耗级别精细分类
   */
  identifySmartDataNeeds(unchangedPages) {
    const result = {
      // 轻量级需求（低 Rate Limit 消耗）
      lightweightPages: [],  // 仅需要 source + revisions + attributions
      
      // 重量级需求（高 Rate Limit 消耗） 
      votingOnlyPages: [],   // 仅需要 voting 数据
      
      // 复合需求
      fullDataPages: [],     // 需要全部数据
      
      // 统计信息
      stats: {
        missingSource: 0,
        incompleteVoting: 0,
        incompleteRevisions: 0,
        totalPages: 0,
        rateLimitSaved: 0  // 估算节省的Rate Limit
      }
    };
    
    for (const page of unchangedPages) {
      const existingPage = this.existingPagesMap.get(page.url);
      if (!existingPage) continue;
      
      const needs = this.analyzePageDataNeeds(page, existingPage);
      
      if (!needs.needsAnyData) continue;
      
      // 按照数据需求分类
      if (needs.needsVoting && (needs.needsSource || needs.needsRevisions)) {
        // 需要多种数据，使用完整查询
        result.fullDataPages.push({
          url: page.url,
          needs: needs,
          reasons: needs.reasons
        });
      } else if (needs.needsVoting) {
        // 仅需要投票数据
        result.votingOnlyPages.push({
          url: page.url,
          needs: { needsVoting: true },
          reasons: ['voting']
        });
        result.stats.rateLimitSaved += 0.3; // 估算节省
      } else {
        // 仅需要轻量级数据（source/revisions/attributions）
        result.lightweightPages.push({
          url: page.url,
          needs: {
            needsSource: needs.needsSource,
            needsRevisions: needs.needsRevisions,
            needsAttributions: needs.needsAttributions,
            needsVoting: false  // 明确不需要voting
          },
          reasons: needs.reasons
        });
        result.stats.rateLimitSaved += 0.7; // 估算节省
      }
      
      // 更新统计
      if (needs.needsSource) result.stats.missingSource++;
      if (needs.needsVoting) result.stats.incompleteVoting++;
      if (needs.needsRevisions) result.stats.incompleteRevisions++;
      result.stats.totalPages++;
    }
    
    return result;
  }
  
  /**
   * 分析单个页面的数据需求
   */
  analyzePageDataNeeds(page, existingPage) {
    const needs = {
      needsSource: false,
      needsVoting: false,
      needsRevisions: false,
      needsAttributions: false,
      needsAnyData: false,
      reasons: []
    };
    
    // 1. 源代码检查（高优先级，低消耗）
    if (this.isSourceCodeMissing(existingPage)) {
      needs.needsSource = true;
      needs.needsRevisions = true;  // 获取源代码时一并获取修订
      needs.needsAttributions = true; // 获取源代码时一并获取合著
      needs.reasons.push('源代码缺失');
      needs.needsAnyData = true;
    }
    
    // 2. 投票数据检查（低优先级，高消耗，严格条件）
    if (this.isVotingDataCriticallyIncomplete(page, existingPage)) {
      needs.needsVoting = true;
      needs.reasons.push('投票数据重要变化');
      needs.needsAnyData = true;
    }
    
    // 3. 修订数据检查（仅在未获取源代码时单独检查）
    if (!needs.needsSource && this.isRevisionDataIncomplete(page, existingPage)) {
      needs.needsRevisions = true;
      needs.reasons.push('修订数据变化');
      needs.needsAnyData = true;
    }
    
    return needs;
  }
  
  /**
   * 检查源代码是否缺失
   */
  isSourceCodeMissing(existingPage) {
    return existingPage.source === null || 
           existingPage.source === undefined ||
           existingPage.source === '';
  }
  
  /**
   * 检查投票数据是否不完整（保守策略）
   * 策略：综合考虑投票数变化和数据新鲜度
   */
  isVotingDataIncomplete(currentPage, existingPage) {
    // 当前页面显示有投票
    const hasVotesInCurrentData = currentPage.voteCount > 0;
    
    if (hasVotesInCurrentData) {
      // 1. 检查投票数变化（提高阈值，更加保守）
      const voteCountDiff = Math.abs((currentPage.voteCount || 0) - (existingPage.voteCount || 0));
      if (voteCountDiff > 10) {
        return true; // 投票数变化超过10票，需要更新
      }
      
      // 2. 检查数据新鲜度（更加保守：仅在数据非常旧且有很多投票时才更新）
      if (currentPage.voteCount > 50) {
        const lastSyncTime = existingPage.lastSyncedAt ? new Date(existingPage.lastSyncedAt) : null;
        if (!lastSyncTime || (Date.now() - lastSyncTime.getTime()) > 30 * 24 * 60 * 60 * 1000) {
          return true; // 数据超过30天没更新且有很多投票，需要刷新
        }
      }
    }
    
    return false;
  }

  /**
   * 检查投票数据是否严重不完整（极严格条件，最小化Rate Limit消耗）
   * 只在投票数据明显需要更新时才返回true
   */
  isVotingDataCriticallyIncomplete(currentPage, existingPage) {
    const hasVotesInCurrentData = currentPage.voteCount > 0;
    
    if (hasVotesInCurrentData) {
      // 1. 投票数大幅变化（阈值提高到20）
      const voteCountDiff = Math.abs((currentPage.voteCount || 0) - (existingPage.voteCount || 0));
      if (voteCountDiff > 20) {
        return true; // 投票数变化超过20票才更新
      }
      
      // 2. 大型页面的数据过期（更严格的条件）
      if (currentPage.voteCount > 100) {
        const lastSyncTime = existingPage.lastSyncedAt ? new Date(existingPage.lastSyncedAt) : null;
        if (!lastSyncTime || (Date.now() - lastSyncTime.getTime()) > 60 * 24 * 60 * 60 * 1000) {
          return true; // 数据超过60天没更新且有超过100票的大型页面才刷新
        }
      }
      
      // 3. 新页面投票数据缺失（如果原来没有投票记录，现在有很多投票）
      if (existingPage.voteCount === 0 && currentPage.voteCount > 30) {
        return true; // 从无投票到有30+投票，可能是新的热门页面
      }
    }
    
    return false;
  }
  
  /**
   * 检查修订数据是否不完整
   */
  isRevisionDataIncomplete(currentPage, existingPage) {
    // 类似投票数据的策略
    const hasRevisionsInCurrentData = currentPage.revisionCount > 0;
    
    if (hasRevisionsInCurrentData) {
      // 如果修订数明显增加，可能需要获取新的修订数据
      const revisionCountDiff = (currentPage.revisionCount || 0) - (existingPage.revisionCount || 0);
      return revisionCountDiff > 3; // 修订数增加超过3个才重新获取
    }
    
    return false;
  }

  /**
   * 智能合并源代码：保护现有数据不被null覆盖
   */
  smartMergeSource(detailedPageData, existingPage) {
    // 如果获取到了详细数据且包含有效的源代码字段（不为null和空字符串）
    if (detailedPageData && 
        detailedPageData.hasOwnProperty('source') &&
        detailedPageData.source !== null &&
        detailedPageData.source !== '') {
      // 仅当拿到有效源码时才覆盖
      return detailedPageData.source;
    }
    
    // 如果没有获取到有效的详细数据，保留现有的源代码
    if (existingPage && existingPage.hasOwnProperty('source')) {
      return existingPage.source;
    }
    
    // 都没有的情况下返回null
    return null;
  }
  
  
  /**
   * 保存更新后的数据
   */
  async saveUpdatedData() {
    console.log('\n💾 保存增量更新数据...');
    this.progressState.phase = 'saving';
    this.progressState.phaseStartTime = Date.now();
    
    const timestamp = this.generateTimestamp();
    const filename = `production-data-final-${timestamp}.json`;
    
    const finalData = {
      metadata: {
        syncType: 'incremental_update_v3',
        startTime: this.stats.startTime.toISOString(),
        endTime: new Date().toISOString(),
        targetSite: this.config.targetSiteUrl,
        updateStats: this.updateStats,
        previousDataFile: this.existingData.metadata?.filename || 'unknown',
        lastUpdateTime: this.lastUpdateTime.toISOString()
      },
      pages: this.mergedData.pages,
      voteRecords: this.mergedData.voteRecords,
      users: this.mergedData.users,
      attributions: this.mergedData.attributions,
      revisions: this.mergedData.revisions,
      alternateTitles: this.mergedData.alternateTitles
    };
    
    const filePath = await this.saveDataToFile(filename, finalData);
    
    // 清理更新检查点
    try {
      fs.unlinkSync('./production-checkpoints/update-checkpoint.json');
      console.log('🗑️  已清理更新检查点');
    } catch (error) {
      // 忽略清理错误
    }
    
    // 显示100%完成
    console.log('\n');
    this.updateProgress(this.progressState.totalPages || this.updateStats.pagesScanned, 
                       this.progressState.totalPages || this.updateStats.pagesScanned);
    console.log(`\n✅ 增量更新数据保存完成: ${filename}`);
    console.log(`   总页面数: ${finalData.pages.length}`);
    console.log(`   总投票记录: ${finalData.voteRecords.length}`);
    console.log(`   总合著记录: ${finalData.attributions.length}`);
    
    return filePath;
  }
  
  /**
   * 生成增量更新报告
   */
  async generateUpdateReport() {
    const duration = this.stats.endTime - this.stats.startTime;
    
    console.log('\n📊 增量更新统计报告 (v3)');
    console.log('='.repeat(80));
    console.log(`⏱️  总耗时: ${Math.round(duration / 1000 / 60)} 分钟`);
    console.log(`📖 扫描页面: ${this.updateStats.pagesScanned} 个`);
    console.log(`🆕 新增页面: ${this.updateStats.newPages} 个`);
    console.log(`📝 变化页面: ${this.updateStats.changedPages} 个`);
    console.log(`⚪ 未变化页面: ${this.updateStats.unchangedPages} 个`);
    
    // 计算效率指标
    const changeRatio = this.updateStats.pagesScanned > 0 ? 
      ((this.updateStats.newPages + this.updateStats.changedPages) / this.updateStats.pagesScanned * 100).toFixed(1) : '0';
    
    console.log(`\n📈 增量更新效率:`);
    console.log(`   变化比例: ${changeRatio}% (${this.updateStats.newPages + this.updateStats.changedPages}/${this.updateStats.pagesScanned})`);
    console.log(`   扫描速度: ${Math.round(this.updateStats.pagesScanned / (duration / 1000 / 60))} 页面/分钟`);
    console.log(`   数据获取优化: 只获取了 ${this.detailedData?.size || 0} 个页面的详细数据`);
    
    // 新增的优化统计
    if (this.updateStats.incrementalVoteUpdates > 0) {
      console.log(`\n📊 Rate Limit 优化统计:`);
      console.log(`   增量投票更新: ${this.updateStats.incrementalVoteUpdates} 个页面`);
      console.log(`   总投票变化: ${this.updateStats.totalVoteChanges} 条记录`);
      console.log(`   智能合并操作: ${this.updateStats.intelligentMerges} 次`);
      console.log(`   Rate Limit 优化: ${this.updateStats.rateLimitOptimizations} 次（分页获取）`);
    }
    
    if (this.stats.errors.length > 0) {
      console.log(`\n❌ 错误统计: ${this.stats.errors.length} 个`);
    }
    
    console.log(`\n✅ 增量更新完成时间: ${this.stats.endTime.toLocaleString()}`);
  }
  
  /**
   * 延迟函数
   */
  async delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
  
  /**
   * 生成进度条
   */
  generateProgressBar(percentage, width = 20) {
    const filled = Math.round(percentage / 100 * width);
    const empty = width - filled;
    return `[${'█'.repeat(filled)}${'░'.repeat(empty)}]`;
  }
  
  /**
   * 格式化时间显示
   */
  formatDuration(seconds) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    
    if (hours > 0) return `${hours}h ${minutes}m ${secs}s`;
    if (minutes > 0) return `${minutes}m ${secs}s`;
    return `${secs}s`;
  }
  
  /**
   * 更新进度显示
   */
  updateProgress(current, total, context = 'pages') {
    const now = Date.now();
    
    // 限制进度更新频率
    if (now - this.progressState.lastProgressUpdate < this.progressState.progressUpdateInterval) {
      return;
    }
    
    this.progressState.lastProgressUpdate = now;
    
    let progressText = '';
    let etaText = '';
    
    // 计算已用时间（只计算当前阶段）
    const phaseStartTime = this.progressState.phaseStartTime || this.stats.startTime;
    const elapsedSeconds = (now - phaseStartTime) / 1000;
    const elapsedText = ` | 已用: ${this.formatDuration(elapsedSeconds)}`;
    
    // actualProcessedThisSession 已经在处理过程中正确累积，无需重新计算
    
    if (total > 0) {
      // 有总数时显示百分比进度条和预计时间
      const percentage = (current / total * 100);
      const progressBar = this.generateProgressBar(percentage);
      progressText = `📊 ${progressBar} ${percentage.toFixed(1)}% (${current.toLocaleString()}/${total.toLocaleString()})`;
      
      // ETA计算 - 基于本次会话的实际处理速度
      const remaining = total - current;
      const minSampleSize = 5;  // 最小样本大小
      const minElapsedTime = 10; // 最小经过时间（秒）
      const hasEnoughData = this.progressState.actualProcessedThisSession >= minSampleSize && elapsedSeconds >= minElapsedTime;
      
      if (this.progressState.actualProcessedThisSession > 0 && remaining > 0 && hasEnoughData) {
        // 使用本次会话的实际速度，而不是包含checkpoint的速度
        const actualSpeed = this.progressState.actualProcessedThisSession / elapsedSeconds;
        let etaSeconds = remaining / actualSpeed;
        
        // 考虑错误率对时间的影响
        const errorRate = this.stats.errors.length / Math.max(this.progressState.actualProcessedThisSession, 1);
        if (errorRate > 0.1) {
          etaSeconds = etaSeconds * (1 + errorRate * 0.5);
        }
        
        // 防止ETA预估过于极端
        if (etaSeconds > 24 * 3600) {  // 超过24小时
          etaText = ' | ETA: >24小时';
        } else if (etaSeconds < 1) {    // 小于1秒
          etaText = ' | ETA: <1秒';
        } else {
          etaText = ` | ETA: ${this.formatDuration(etaSeconds)}`;
        }
        
        // 如果从checkpoint恢复，添加提示
        if (this.progressState.checkpointStartCount > 0) {
          etaText += ' (基于当前速度)';
        }
      } else {
        // 数据不足以预估，保持简洁
        etaText = '';
      }
    } else {
      // 无总数时显示简单计数
      progressText = `📊 ${context}进度: ${current.toLocaleString()}`;
      if (this.progressState.checkpointStartCount > 0) {
        progressText += ` (本次: +${this.progressState.actualProcessedThisSession})`;
      }
    }
    
    // 显示当前阶段和速度（基于本次会话的实际处理速度）
    const phaseText = this.getPhaseText();
    const speed = elapsedSeconds > 0 && this.progressState.actualProcessedThisSession > 0 ? 
      (this.progressState.actualProcessedThisSession / elapsedSeconds).toFixed(1) : '0.0';
    
    process.stdout.write(`\r${phaseText} ${progressText} | 速度: ${speed}/s${elapsedText}${etaText}`);
  }
  
  /**
   * 获取当前阶段文本
   */
  getPhaseText() {
    switch (this.progressState.phase) {
      case 'loading': return '🔍 加载现有数据';
      case 'scanning': return '📊 扫描页面变化';
      case 'detailed': return '🔍 获取详细数据';
      case 'merging': return '🔄 合并数据';
      case 'saving': return '💾 保存数据';
      default: return '🔄 处理中';
    }
  }
}