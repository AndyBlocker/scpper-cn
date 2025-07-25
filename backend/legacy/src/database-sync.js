import { GraphQLClient } from 'graphql-request';
import { PrismaClient } from '@prisma/client';
// import crypto from 'crypto'; // 不再需要用于源代码hash
import dotenv from 'dotenv';

dotenv.config();

// 基于数据库的增强版数据同步脚本
// 功能: 页面历史版本管理、删除页面检测、用户评分维护
class DatabaseSyncService {
  constructor() {
    this.cromClient = new GraphQLClient(process.env.CROM_API_URL || 'https://apiv1.crom.avn.sh/graphql');
    this.prisma = new PrismaClient();
    
    this.stats = {
      startTime: null,
      endTime: null,
      pagesProcessed: 0,
      pagesCreated: 0,
      pagesUpdated: 0,
      pagesDeleted: 0,
      versionsCreated: 0,
      errors: []
    };
    
    this.config = {
      batchSize: 10,
      maxRequestsPerSecond: 1.8,
      targetSiteUrl: process.env.TARGET_SITE_URL || 'http://scp-wiki-cn.wikidot.com'
    };
  }

  async runDatabaseSync() {
    console.log('🗄️  SCPPER-CN 数据库同步开始');
    console.log('=' .repeat(80));
    console.log(`📅 开始时间: ${new Date().toLocaleString()}`);
    console.log(`🎯 目标站点: ${this.config.targetSiteUrl}`);
    console.log('');
    
    this.stats.startTime = new Date();
    
    try {
      // 1. 记录同步开始
      const syncLog = await this.createSyncLog();
      
      // 2. 获取现有页面列表用于删除检测
      const existingPages = await this.getExistingPages();
      console.log(`📊 数据库中现有页面: ${existingPages.size} 个`);
      
      // 3. 同步页面数据
      const currentPages = await this.syncPages(existingPages);
      
      // 4. 检测并处理删除的页面
      await this.handleDeletedPages(existingPages, currentPages);
      
      // 5. 同步用户数据
      await this.syncUsers();
      
      // 6. 更新用户统计（排除删除的页面）
      await this.updateUserStatistics();
      
      // 7. 完成同步记录
      await this.completeSyncLog(syncLog.id);
      
      this.stats.endTime = new Date();
      await this.generateSyncReport();
      
    } catch (error) {
      console.error(`❌ 同步过程发生错误: ${error.message}`);
      this.stats.errors.push({
        type: 'fatal_error',
        error: error.message,
        timestamp: new Date()
      });
    } finally {
      await this.prisma.$disconnect();
    }
  }

  async getExistingPages() {
    console.log('📋 获取现有页面列表...');
    
    const pages = await this.prisma.page.findMany({
      where: { isDeleted: false },
      select: { url: true, lastRevisionCount: true, lastSyncedAt: true }
    });
    
    const pageMap = new Map();
    pages.forEach(page => {
      pageMap.set(page.url, {
        lastRevisionCount: page.lastRevisionCount,
        lastSyncedAt: page.lastSyncedAt
      });
    });
    
    return pageMap;
  }

  async syncPages(existingPages) {
    console.log('📄 开始页面数据同步...');
    
    const currentPages = new Set();
    let cursor = null;
    let totalProcessed = 0;
    
    while (true) {
      await this.enforceRateLimit();
      
      try {
        const result = await this.fetchPageBatch(cursor, this.config.batchSize);
        
        if (!result || !result.pages.edges.length) {
          console.log('✅ 没有更多页面可处理');
          break;
        }
        
        // 处理批次中的每个页面
        for (const edge of result.pages.edges) {
          const page = edge.node;
          const pageUrl = page.url;
          
          currentPages.add(pageUrl);
          
          // 使用revision数量检测内容变化
          const currentRevisionCount = page.wikidotInfo?.revisionCount || 0;
          const existingPage = existingPages.get(pageUrl);
          
          if (!existingPage) {
            // 新页面
            await this.createPage(page, currentRevisionCount);
            this.stats.pagesCreated++;
          } else if (existingPage.lastRevisionCount !== currentRevisionCount) {
            // 页面有新的revision（内容变化）
            await this.updatePage(page, currentRevisionCount, existingPage);
            this.stats.pagesUpdated++;
          } else {
            // 页面无变化，只更新同步时间
            await this.touchPage(pageUrl);
          }
          
          cursor = edge.cursor;
          totalProcessed++;
          this.stats.pagesProcessed++;
        }
        
        // 显示进度
        process.stdout.write(`\\r📊 已处理: ${totalProcessed} 页面 | 新建: ${this.stats.pagesCreated} | 更新: ${this.stats.pagesUpdated}`);
        
        if (!result.pages.pageInfo.hasNextPage) {
          console.log('\\n✅ 所有页面处理完成');
          break;
        }
        
      } catch (error) {
        console.log(`\\n❌ 批次处理失败: ${error.message}`);
        this.stats.errors.push({
          type: 'batch_error',
          error: error.message,
          timestamp: new Date()
        });
        
        if (this.stats.errors.filter(e => e.type === 'batch_error').length >= 5) {
          throw new Error('错误过多，停止同步');
        }
      }
    }
    
    return currentPages;
  }

  async createPage(pageData, revisionCount) {
    const info = pageData.wikidotInfo;
    
    // 创建页面记录
    const page = await this.prisma.page.create({
      data: {
        url: pageData.url,
        title: info?.title,
        wikidotId: info?.wikidotId,
        category: info?.category,
        rating: info?.rating,
        voteCount: info?.voteCount,
        realtimeRating: info?.realtimeRating,
        realtimeVoteCount: info?.realtimeVoteCount,
        commentCount: info?.commentCount,
        createdAt: info?.createdAt ? new Date(info.createdAt) : null,
        revisionCount: info?.revisionCount,
        source: info?.source,
        textContent: info?.textContent,
        tags: info?.tags || [],
        isPrivate: info?.isPrivate || false,
        createdByUser: info?.createdBy?.name,
        parentUrl: info?.parent?.url,
        thumbnailUrl: info?.thumbnailUrl,
        lastRevisionCount: revisionCount,
        lastSyncedAt: new Date()
      }
    });
    
    // 创建初始版本历史
    await this.createPageHistory(pageData.url, 1, info, revisionCount, 'created', '页面首次创建');
    
    // 批量创建相关数据
    await this.createPageRelatedData(pageData);
    
    return page;
  }

  async updatePage(pageData, revisionCount, existingPage) {
    const info = pageData.wikidotInfo;
    
    // 获取当前版本号
    const latestVersion = await this.prisma.pageHistory.findFirst({
      where: { pageUrl: pageData.url },
      orderBy: { versionNumber: 'desc' },
      select: { versionNumber: true }
    });
    
    const nextVersion = (latestVersion?.versionNumber || 0) + 1;
    
    // 更新页面记录
    await this.prisma.page.update({
      where: { url: pageData.url },
      data: {
        title: info?.title,
        rating: info?.rating,
        voteCount: info?.voteCount,
        realtimeRating: info?.realtimeRating,
        realtimeVoteCount: info?.realtimeVoteCount,
        commentCount: info?.commentCount,
        revisionCount: info?.revisionCount,
        source: info?.source,
        textContent: info?.textContent,
        tags: info?.tags || [],
        thumbnailUrl: info?.thumbnailUrl,
        lastRevisionCount: revisionCount,
        lastSyncedAt: new Date()
      }
    });
    
    // 创建版本历史
    await this.createPageHistory(pageData.url, nextVersion, info, revisionCount, 'updated', `页面revision更新 (${existingPage.lastRevisionCount} → ${revisionCount})`);
    this.stats.versionsCreated++;
    
    // 更新相关数据
    await this.updatePageRelatedData(pageData);
  }

  async createPageHistory(pageUrl, versionNumber, info, revisionCount, changeType, changeReason) {
    await this.prisma.pageHistory.create({
      data: {
        pageUrl: pageUrl,
        versionNumber: versionNumber,
        title: info?.title,
        rating: info?.rating,
        voteCount: info?.voteCount,
        commentCount: info?.commentCount,
        revisionCount: revisionCount,
        tags: info?.tags || [],
        changeType: changeType,
        changeReason: changeReason
      }
    });
  }

  async handleDeletedPages(existingPages, currentPages) {
    console.log('\\n🗑️  检测删除的页面...');
    
    const deletedPages = [];
    
    for (const [pageUrl, pageInfo] of existingPages) {
      if (!currentPages.has(pageUrl)) {
        deletedPages.push(pageUrl);
      }
    }
    
    if (deletedPages.length === 0) {
      console.log('✅ 未发现删除的页面');
      return;
    }
    
    console.log(`⚠️  发现 ${deletedPages.length} 个删除的页面:`);
    
    for (const pageUrl of deletedPages) {
      try {
        // 获取页面信息用于历史记录
        const page = await this.prisma.page.findUnique({
          where: { url: pageUrl }
        });
        
        if (page) {
          console.log(`   🗑️  ${page.title || pageUrl}`);
          
          // 获取下一个版本号
          const latestVersion = await this.prisma.pageHistory.findFirst({
            where: { pageUrl: pageUrl },
            orderBy: { versionNumber: 'desc' },
            select: { versionNumber: true }
          });
          
          const nextVersion = (latestVersion?.versionNumber || 0) + 1;
          
          // 标记页面为已删除
          await this.prisma.page.update({
            where: { url: pageUrl },
            data: {
              isDeleted: true,
              deletedAt: new Date(),
              deletionReason: '页面在源站点中不再存在'
            }
          });
          
          // 创建删除历史记录
          await this.createPageHistory(
            pageUrl, 
            nextVersion, 
            page, 
            page.lastRevisionCount, 
            'deleted', 
            '页面在源站点中被删除'
          );
          
          this.stats.pagesDeleted++;
          this.stats.versionsCreated++;
        }
        
      } catch (error) {
        console.log(`   ❌ 处理删除页面失败 ${pageUrl}: ${error.message}`);
        this.stats.errors.push({
          type: 'deletion_error',
          pageUrl: pageUrl,
          error: error.message,
          timestamp: new Date()
        });
      }
    }
  }

  async updateUserStatistics() {
    console.log('\\n👤 更新用户统计信息...');
    
    // 重新计算用户评分（排除已删除页面）
    const userStats = await this.prisma.$queryRaw`
      SELECT 
        p.created_by_user as user_name,
        COUNT(*) as page_count,
        SUM(p.rating) as total_rating,
        AVG(p.rating::float) as mean_rating
      FROM pages p 
      WHERE p.created_by_user IS NOT NULL 
        AND p.is_deleted = false
      GROUP BY p.created_by_user
    `;
    
    console.log(`   📊 需要更新 ${userStats.length} 个用户的统计信息`);
    
    // 批量更新用户统计
    for (const stat of userStats) {
      await this.prisma.user.upsert({
        where: { name: stat.user_name },
        update: {
          pageCount: stat.page_count,
          totalRating: stat.total_rating,
          meanRating: stat.mean_rating,
          lastSyncedAt: new Date()
        },
        create: {
          name: stat.user_name,
          pageCount: stat.page_count,
          totalRating: stat.total_rating,
          meanRating: stat.mean_rating,
          lastSyncedAt: new Date()
        }
      });
    }
    
    // 更新用户排名
    await this.updateUserRankings();
  }

  async updateUserRankings() {
    console.log('   🏆 更新用户排名...');
    
    const rankedUsers = await this.prisma.user.findMany({
      orderBy: { totalRating: 'desc' },
      select: { name: true }
    });
    
    // 批量更新排名
    for (let i = 0; i < rankedUsers.length; i++) {
      await this.prisma.user.update({
        where: { name: rankedUsers[i].name },
        data: { rank: i + 1 }
      });
    }
  }

  // 不再需要源代码hash计算，使用revision数量检测变化
  // calculateSourceHash() method removed - using revision count instead

  async touchPage(pageUrl) {
    await this.prisma.page.update({
      where: { url: pageUrl },
      data: { lastSyncedAt: new Date() }
    });
  }

  async createPageRelatedData(pageData) {
    // 创建投票记录、修订记录、贡献者等数据
    // (简化实现，实际需要处理所有相关数据)
    
    const info = pageData.wikidotInfo;
    
    // 投票记录
    if (info?.coarseVoteRecords) {
      const voteData = info.coarseVoteRecords.map(vote => ({
        pageUrl: pageData.url,
        userWikidotId: vote.userWikidotId,
        userName: vote.user?.name,
        timestamp: new Date(vote.timestamp),
        direction: vote.direction
      }));
      
      await this.prisma.voteRecord.createMany({
        data: voteData,
        skipDuplicates: true
      });
    }
    
    // 修订记录
    if (info?.revisions) {
      const revisionData = info.revisions.map(revision => ({
        pageUrl: pageData.url,
        revisionIndex: revision.index,
        wikidotId: revision.wikidotId,
        timestamp: new Date(revision.timestamp),
        type: revision.type,
        userWikidotId: revision.userWikidotId,
        userName: revision.user?.name,
        comment: revision.comment
      }));
      
      await this.prisma.revision.createMany({
        data: revisionData,
        skipDuplicates: true
      });
    }
  }

  async updatePageRelatedData(pageData) {
    // 更新相关数据（投票记录、修订记录等）
    // 这里需要处理数据的增量更新逻辑
    // 为简化，我们先删除旧数据再创建新数据
    
    await this.prisma.voteRecord.deleteMany({
      where: { pageUrl: pageData.url }
    });
    
    await this.prisma.revision.deleteMany({
      where: { pageUrl: pageData.url }
    });
    
    await this.createPageRelatedData(pageData);
  }

  async fetchPageBatch(cursor, batchSize) {
    const pageQuery = `
      query DatabaseSync($filter: QueryPagesFilter, $first: Int, $after: ID) {
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
        url: { startsWith: this.config.targetSiteUrl }
      },
      first: batchSize
    };
    
    if (cursor) {
      variables.after = cursor;
    }
    
    return await this.cromClient.request(pageQuery, variables);
  }

  async createSyncLog() {
    return await this.prisma.syncLog.create({
      data: {
        syncType: 'incremental',
        status: 'running'
      }
    });
  }

  async completeSyncLog(syncLogId) {
    await this.prisma.syncLog.update({
      where: { id: syncLogId },
      data: {
        completedAt: new Date(),
        status: 'completed',
        pagesProcessed: this.stats.pagesProcessed,
        summary: {
          pagesCreated: this.stats.pagesCreated,
          pagesUpdated: this.stats.pagesUpdated,
          pagesDeleted: this.stats.pagesDeleted,
          versionsCreated: this.stats.versionsCreated,
          errors: this.stats.errors.length
        }
      }
    });
  }

  async syncUsers() {
    console.log('\\n👤 同步用户数据...');
    // 简化实现，实际需要从CROM API获取用户数据
    console.log('   ℹ️  用户数据将通过页面创建者信息自动更新');
  }

  async enforceRateLimit() {
    // 简化的频率控制
    await new Promise(resolve => setTimeout(resolve, 1000 / this.config.maxRequestsPerSecond));
  }

  async generateSyncReport() {
    const duration = (this.stats.endTime - this.stats.startTime) / 1000;
    
    console.log('\\n🎉 数据库同步完成!');
    console.log('=' .repeat(80));
    console.log(`⏱️  总耗时: ${duration.toFixed(1)} 秒`);
    console.log(`📄 处理页面: ${this.stats.pagesProcessed}`);
    console.log(`🆕 新建页面: ${this.stats.pagesCreated}`);
    console.log(`🔄 更新页面: ${this.stats.pagesUpdated}`);
    console.log(`🗑️  删除页面: ${this.stats.pagesDeleted}`);
    console.log(`📚 创建版本: ${this.stats.versionsCreated}`);
    
    if (this.stats.errors.length > 0) {
      console.log(`⚠️  错误数量: ${this.stats.errors.length}`);
    } else {
      console.log(`✅ 同步完成，无错误`);
    }
    
    console.log(`\\n📅 结束时间: ${new Date().toLocaleString()}`);
  }
}

// 运行数据库同步
async function runDatabaseSync() {
  const syncService = new DatabaseSyncService();
  await syncService.runDatabaseSync();
}

export { DatabaseSyncService };

if (import.meta.url === `file://${process.argv[1]}`) {
  runDatabaseSync().catch(console.error);
}