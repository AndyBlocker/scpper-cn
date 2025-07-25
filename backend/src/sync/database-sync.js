import { GraphQLClient } from 'graphql-request';
import { PrismaClient } from '@prisma/client';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

// SCPPER-CN 数据库同步脚本
// 功能: 页面历史版本管理、删除页面检测、用户评分维护、增量更新
class DatabaseSync {
  constructor() {
    this.cromClient = new GraphQLClient('https://apiv2.crom.avn.sh/graphql');
    this.prisma = new PrismaClient();
    
    this.stats = {
      startTime: null,
      endTime: null,
      pagesProcessed: 0,
      pagesCreated: 0,
      pagesUpdated: 0,
      pagesDeleted: 0,
      versionsCreated: 0,
      usersProcessed: 0,
      votesProcessed: 0,
      revisionsProcessed: 0,
      attributionsProcessed: 0,
      alternateTitlesProcessed: 0,
      errors: []
    };
    
    this.config = {
      batchSize: 20,
      maxRequestsPerSecond: 8.0,
      targetSiteUrl: process.env.TARGET_SITE_URL || 'http://scp-wiki-cn.wikidot.com',
      enableIncrementalUpdate: true,
      checkDeletions: true
    };
    
    // 数据缓存
    this.cache = {
      users: new Map(),
      pages: new Map(),
      existingPages: new Set()
    };
  }

  async runDatabaseSync() {
    console.log('🗄️  SCPPER-CN 数据库同步开始');
    console.log('='.repeat(80));
    console.log(`📅 开始时间: ${new Date().toLocaleString()}`);
    console.log(`🎯 目标站点: ${this.config.targetSiteUrl}`);
    console.log(`📡 API版本: v2 (${this.cromClient.url})`);
    console.log('');
    
    this.stats.startTime = new Date();
    
    try {
      // 1. 记录同步开始
      const syncLog = await this.createSyncLog();
      
      // 2. 获取现有页面列表用于删除检测
      if (this.config.checkDeletions) {
        await this.loadExistingPages();
      }
      
      // 3. 从最新的v2数据文件加载数据
      const dataFilePath = await this.findLatestDataFile();
      if (dataFilePath) {
        await this.syncFromDataFile(dataFilePath);
      } else {
        console.log('❌ 没有找到数据文件，请先运行production-sync.js');
        return;
      }
      
      // 4. 检测并处理删除的页面
      if (this.config.checkDeletions) {
        await this.handleDeletedPages();
      }
      
      // 5. 更新用户统计（正确处理已删除页面）
      await this.updateUserStatistics();
      
      // 6. 更新用户排名
      await this.updateUserRankings();
      
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

  async findLatestDataFile() {
    console.log('🔍 查找最新的v2数据文件...');
    
    const dataDir = './production-data';
    if (!fs.existsSync(dataDir)) {
      console.log('📁 v2数据目录不存在');
      return null;
    }
    
    const files = fs.readdirSync(dataDir);
    const dataFiles = files
      .filter(f => f.startsWith('production-data') && f.endsWith('.json'))
      .sort()
      .reverse();
    
    if (dataFiles.length === 0) {
      console.log('📁 没有找到v2数据文件');
      return null;
    }
    
    const latestFile = path.join(dataDir, dataFiles[0]);
    console.log(`✅ 找到最新数据文件: ${dataFiles[0]}`);
    
    return latestFile;
  }

  async syncFromDataFile(dataFilePath) {
    console.log('📥 从v2数据文件同步...');
    
    const rawData = fs.readFileSync(dataFilePath, 'utf8');
    const data = JSON.parse(rawData);
    
    console.log(`📊 数据文件统计:`);
    console.log(`   页面数: ${data.pages?.length || 0}`);
    console.log(`   投票记录: ${data.voteRecords?.length || 0}`);
    console.log(`   用户数: ${data.users?.length || 0}`);
    console.log(`   修订记录: ${data.revisions?.length || 0}`);
    console.log(`   贡献记录: ${data.attributions?.length || 0}`);
    console.log(`   备用标题: ${data.alternateTitles?.length || 0}`);
    console.log('');
    
    // 1. 同步页面数据
    if (data.pages) {
      await this.syncPages(data.pages);
    }
    
    // 2. 同步用户数据
    if (data.users) {
      await this.syncUsers(data.users);
    }
    
    // 3. 同步投票记录
    if (data.voteRecords) {
      await this.syncVoteRecords(data.voteRecords);
    }
    
    // 4. 同步修订记录
    if (data.revisions) {
      await this.syncRevisions(data.revisions);
    }
    
    // 5. 同步贡献记录
    if (data.attributions) {
      await this.syncAttributions(data.attributions);
    }
    
    // 6. 同步备用标题
    if (data.alternateTitles) {
      await this.syncAlternateTitles(data.alternateTitles);
    }
  }

  async syncPages(pages) {
    console.log('📄 同步页面数据...');
    
    for (const pageData of pages) {
      try {
        // 检查页面是否存在
        const existingPage = await this.prisma.page.findUnique({
          where: { url: pageData.url }
        });
        
        const pageRecord = {
          url: pageData.url,
          wikidotId: pageData.wikidotId,
          title: pageData.title,
          category: pageData.category,
          rating: pageData.rating || 0,
          voteCount: pageData.voteCount || 0,
          commentCount: pageData.commentCount || 0,
          createdAt: pageData.createdAt ? new Date(pageData.createdAt) : null,
          revisionCount: pageData.revisionCount || 0,
          source: null, // v2 API doesn't store full source in basic data
          textContent: null, // v2 API doesn't store full text in basic data
          tags: pageData.tags || [],
          isPrivate: false, // v2 doesn't have this field
          isDeleted: false,
          createdByUser: pageData.createdByUser,
          parentUrl: pageData.parentUrl,
          thumbnailUrl: pageData.thumbnailUrl,
          lastSyncedAt: new Date(),
          lastRevisionCount: pageData.revisionCount || 0
        };
        
        if (existingPage) {
          // 检查是否需要更新
          const needsUpdate = this.checkPageNeedsUpdate(existingPage, pageRecord);
          
          if (needsUpdate) {
            await this.prisma.page.update({
              where: { url: existingPage.url },
              data: pageRecord
            });
            
            // 创建页面历史版本记录
            await this.createPageHistory(existingPage.url, pageRecord, 'updated');
            this.stats.pagesUpdated++;
          }
        } else {
          // 创建新页面
          await this.prisma.page.create({
            data: pageRecord
          });
          
          // 创建初始页面历史版本记录
          await this.createPageHistory(pageRecord.url, pageRecord, 'created');
          this.stats.pagesCreated++;
        }
        
        // 标记页面为存在（用于删除检测）
        this.cache.existingPages.delete(pageData.url);
        
        this.stats.pagesProcessed++;
        
        if (this.stats.pagesProcessed % 1000 === 0) {
          console.log(`   已处理 ${this.stats.pagesProcessed} 页面...`);
        }
        
      } catch (error) {
        console.error(`❌ 处理页面失败 ${pageData.url}: ${error.message}`);
        this.stats.errors.push({
          type: 'page_sync_error',
          pageUrl: pageData.url,
          error: error.message,
          timestamp: new Date()
        });
      }
    }
    
    console.log(`✅ 页面同步完成: 创建 ${this.stats.pagesCreated}, 更新 ${this.stats.pagesUpdated}`);
  }

  async syncUsers(users) {
    console.log('👤 同步用户数据...');
    
    for (const userData of users) {
      try {
        // 检查用户是否存在（使用displayName作为主键，因为schema中name是主键）
        let user = await this.prisma.user.findUnique({
          where: { name: userData.displayName }
        });
        
        const userRecord = {
          name: userData.displayName,
          displayName: userData.displayName,
          wikidotId: userData.wikidotId ? parseInt(userData.wikidotId) : null,
          unixName: userData.unixName || null,
          // 其他统计字段将在updateUserStatistics中计算
          lastSyncedAt: new Date()
        };
        
        if (user) {
          await this.prisma.user.update({
            where: { name: user.name },
            data: userRecord
          });
        } else {
          await this.prisma.user.create({
            data: userRecord
          });
        }
        
        this.stats.usersProcessed++;
        
      } catch (error) {
        console.error(`❌ 处理用户失败 ${userData.displayName}: ${error.message}`);
        this.stats.errors.push({
          type: 'user_sync_error',
          userId: userData.displayName,
          error: error.message,
          timestamp: new Date()
        });
      }
    }
    
    console.log(`✅ 用户同步完成: ${this.stats.usersProcessed} 用户`);
  }

  async syncVoteRecords(voteRecords) {
    console.log('🗳️  同步投票记录...');
    
    for (const voteData of voteRecords) {
      try {
        // 检查投票记录是否已存在
        const existingVote = await this.prisma.voteRecord.findUnique({
          where: {
            pageUrl_userWikidotId_timestamp: {
              pageUrl: voteData.pageUrl,
              userWikidotId: parseInt(voteData.voterWikidotId),
              timestamp: new Date(voteData.timestamp)
            }
          }
        });
        
        if (!existingVote) {
          await this.prisma.voteRecord.create({
            data: {
              pageUrl: voteData.pageUrl,
              userWikidotId: parseInt(voteData.voterWikidotId),
              userName: voteData.voterName,
              timestamp: new Date(voteData.timestamp),
              direction: voteData.direction
            }
          });
        }
        
        this.stats.votesProcessed++;
        
        if (this.stats.votesProcessed % 10000 === 0) {
          console.log(`   已处理 ${this.stats.votesProcessed} 投票记录...`);
        }
        
      } catch (error) {
        console.error(`❌ 处理投票记录失败: ${error.message}`);
        this.stats.errors.push({
          type: 'vote_sync_error',
          error: error.message,
          timestamp: new Date()
        });
      }
    }
    
    console.log(`✅ 投票记录同步完成: ${this.stats.votesProcessed} 记录`);
  }

  async syncRevisions(revisions) {
    console.log('📝 同步修订记录...');
    
    for (const revisionData of revisions) {
      try {
        // 检查修订记录是否已存在
        const existingRevision = await this.prisma.revision.findUnique({
          where: {
            pageUrl_revisionIndex: {
              pageUrl: revisionData.pageUrl,
              revisionIndex: parseInt(revisionData.revisionId)
            }
          }
        });
        
        if (!existingRevision) {
          await this.prisma.revision.create({
            data: {
              pageUrl: revisionData.pageUrl,
              revisionIndex: parseInt(revisionData.revisionId),
              wikidotId: parseInt(revisionData.revisionId),
              timestamp: new Date(revisionData.timestamp),
              type: 'edit',
              userWikidotId: revisionData.userId ? parseInt(revisionData.userId) : null,
              userName: revisionData.userName,
              comment: revisionData.comment
            }
          });
        }
        
        this.stats.revisionsProcessed++;
        
      } catch (error) {
        console.error(`❌ 处理修订记录失败: ${error.message}`);
        this.stats.errors.push({
          type: 'revision_sync_error',
          error: error.message,
          timestamp: new Date()
        });
      }
    }
    
    console.log(`✅ 修订记录同步完成: ${this.stats.revisionsProcessed} 记录`);
  }

  async syncAttributions(attributions) {
    console.log('👥 同步贡献记录...');
    
    for (const attrData of attributions) {
      try {
        // 检查贡献记录是否已存在
        const existingAttribution = await this.prisma.attribution.findUnique({
          where: {
            pageUrl_userName_attributionType: {
              pageUrl: attrData.pageUrl,
              userName: attrData.userName,
              attributionType: attrData.attributionType
            }
          }
        });
        
        if (!existingAttribution) {
          await this.prisma.attribution.create({
            data: {
              pageUrl: attrData.pageUrl,
              userName: attrData.userName,
              attributionType: attrData.attributionType,
              date: attrData.date ? new Date(attrData.date) : null,
              orderIndex: attrData.order || 0,
              isCurrent: true
            }
          });
        }
        
        this.stats.attributionsProcessed++;
        
      } catch (error) {
        console.error(`❌ 处理贡献记录失败: ${error.message}`);
        this.stats.errors.push({
          type: 'attribution_sync_error',
          error: error.message,
          timestamp: new Date()
        });
      }
    }
    
    console.log(`✅ 贡献记录同步完成: ${this.stats.attributionsProcessed} 记录`);
  }

  async syncAlternateTitles(alternateTitles) {
    console.log('🏷️  同步备用标题...');
    
    for (const titleData of alternateTitles) {
      try {
        // 检查标题是否已存在
        const existingTitle = await this.prisma.alternateTitle.findFirst({
          where: {
            pageUrl: titleData.pageUrl,
            title: titleData.title
          }
        });
        
        if (!existingTitle) {
          await this.prisma.alternateTitle.create({
            data: {
              pageUrl: titleData.pageUrl,
              type: titleData.language || 'unknown',
              title: titleData.title
            }
          });
        }
        
        this.stats.alternateTitlesProcessed++;
        
      } catch (error) {
        console.error(`❌ 处理备用标题失败: ${error.message}`);
        this.stats.errors.push({
          type: 'title_sync_error',
          error: error.message,
          timestamp: new Date()
        });
      }
    }
    
    console.log(`✅ 备用标题同步完成: ${this.stats.alternateTitlesProcessed} 记录`);
  }

  async loadExistingPages() {
    console.log('📋 加载现有页面列表...');
    
    const pages = await this.prisma.page.findMany({
      where: { isDeleted: false },
      select: { url: true }
    });
    
    pages.forEach(page => {
      this.cache.existingPages.add(page.url);
    });
    
    console.log(`📊 现有页面: ${this.cache.existingPages.size} 个`);
  }

  async handleDeletedPages() {
    console.log('🗑️  检查删除的页面...');
    
    const deletedUrls = Array.from(this.cache.existingPages);
    
    if (deletedUrls.length > 0) {
      await this.prisma.page.updateMany({
        where: {
          url: { in: deletedUrls }
        },
        data: {
          isDeleted: true,
          deletedAt: new Date(),
          deletionReason: 'Detected missing from API sync'
        }
      });
      
      // 为删除的页面创建历史记录
      for (const deletedUrl of deletedUrls) {
        await this.createPageHistory(deletedUrl, null, 'deleted');
      }
      
      this.stats.pagesDeleted = deletedUrls.length;
      console.log(`🗑️  标记 ${deletedUrls.length} 个页面为已删除`);
    } else {
      console.log('✅ 没有检测到删除的页面');
    }
  }

  checkPageNeedsUpdate(existingPage, newPageData) {
    return existingPage.lastRevisionCount !== newPageData.lastRevisionCount ||
           existingPage.rating !== newPageData.rating ||
           existingPage.voteCount !== newPageData.voteCount ||
           existingPage.title !== newPageData.title;
  }

  async createPageHistory(pageUrl, pageData, changeType) {
    try {
      // 获取当前版本号
      const lastVersion = await this.prisma.pageHistory.findFirst({
        where: { pageUrl: pageUrl },
        orderBy: { versionNumber: 'desc' }
      });
      
      const versionNumber = (lastVersion?.versionNumber || 0) + 1;
      
      const historyData = {
        pageUrl: pageUrl,
        versionNumber: versionNumber,
        capturedAt: new Date(),
        changeType: changeType,
        changeReason: `API v2 sync - ${changeType}`
      };
      
      if (pageData) {
        historyData.title = pageData.title;
        historyData.rating = pageData.rating;
        historyData.voteCount = pageData.voteCount;
        historyData.commentCount = pageData.commentCount;
        historyData.revisionCount = pageData.lastRevisionCount;
        historyData.tags = pageData.tags;
      }
      
      await this.prisma.pageHistory.create({
        data: historyData
      });
      
      this.stats.versionsCreated++;
      
    } catch (error) {
      console.error(`❌ 创建页面历史失败 ${pageUrl}: ${error.message}`);
    }
  }

  async createSyncLog() {
    return await this.prisma.syncLog.create({
      data: {
        syncType: 'API_V2_DATABASE_SYNC',
        startedAt: new Date(),
        status: 'running'
      }
    });
  }

  async completeSyncLog(syncLogId) {
    await this.prisma.syncLog.update({
      where: { id: syncLogId },
      data: {
        completedAt: new Date(),
        pagesProcessed: this.stats.pagesProcessed,
        status: this.stats.errors.length > 0 ? 'completed_with_errors' : 'completed'
      }
    });
  }

  // 🔧 修复：正确处理已删除页面的用户统计
  async updateUserStatistics() {
    console.log('📊 更新用户统计（正确处理已删除页面）...');
    
    // 使用原生SQL查询，确保数据一致性
    const userStats = await this.prisma.$queryRaw`
      SELECT 
        p.created_by_user as user_name,
        COUNT(*) as page_count,
        SUM(p.rating) as total_rating,
        AVG(p.rating::float) as mean_rating
      FROM pages p 
      WHERE p.created_by_user IS NOT NULL 
        AND p.is_deleted = false  -- ✅ 关键：排除已删除页面
      GROUP BY p.created_by_user
    `;
    
    console.log(`   📊 需要更新 ${userStats.length} 个用户的统计信息`);
    
    // 批量更新用户统计
    for (const stat of userStats) {
      try {
        // 计算分类页面数（同样排除已删除页面）
        const [scpCount, taleCount, goiFormatCount] = await Promise.all([
          this.prisma.page.count({
            where: { 
              createdByUser: stat.user_name, 
              isDeleted: false,  // ✅ 排除已删除页面
              OR: [
                { category: 'scp' },
                { url: { contains: '/scp-' } }
              ]
            }
          }),
          this.prisma.page.count({
            where: { 
              createdByUser: stat.user_name, 
              isDeleted: false,  // ✅ 排除已删除页面
              OR: [
                { category: 'tale' },
                { url: { contains: '/tale-' } }
              ]
            }
          }),
          this.prisma.page.count({
            where: { 
              createdByUser: stat.user_name, 
              isDeleted: false,  // ✅ 排除已删除页面
              tags: { array_contains: ['goi格式'] }
            }
          })
        ]);
        
        await this.prisma.user.upsert({
          where: { name: stat.user_name },
          update: {
            pageCount: Number(stat.page_count),
            totalRating: Number(stat.total_rating) || 0,
            meanRating: Number(stat.mean_rating) || 0,
            pageCountScp: scpCount,
            pageCountTale: taleCount,
            pageCountGoiFormat: goiFormatCount,
            lastSyncedAt: new Date()
          },
          create: {
            name: stat.user_name,
            displayName: stat.user_name,
            pageCount: Number(stat.page_count),
            totalRating: Number(stat.total_rating) || 0,
            meanRating: Number(stat.mean_rating) || 0,
            pageCountScp: scpCount,
            pageCountTale: taleCount,
            pageCountGoiFormat: goiFormatCount,
            lastSyncedAt: new Date()
          }
        });
        
      } catch (error) {
        console.error(`❌ 更新用户统计失败 ${stat.user_name}: ${error.message}`);
        this.stats.errors.push({
          type: 'user_stats_error',
          user: stat.user_name,
          error: error.message,
          timestamp: new Date()
        });
      }
    }
    
    console.log(`✅ 用户统计更新完成`);
  }

  async updateUserRankings() {
    console.log('🏆 更新用户排名...');
    
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
    
    console.log(`✅ 用户排名更新完成`);
  }

  async generateSyncReport() {
    const duration = (this.stats.endTime - this.stats.startTime) / 1000;
    
    console.log('\n🎉 API v2 数据库同步完成！');
    console.log('='.repeat(80));
    console.log(`⏱️  总耗时: ${this.formatDuration(duration)}`);
    console.log(`📄 页面处理: ${this.stats.pagesProcessed} (创建: ${this.stats.pagesCreated}, 更新: ${this.stats.pagesUpdated}, 删除: ${this.stats.pagesDeleted})`);
    console.log(`👤 用户处理: ${this.stats.usersProcessed}`);
    console.log(`🗳️  投票记录: ${this.stats.votesProcessed}`);
    console.log(`📝 修订记录: ${this.stats.revisionsProcessed}`);
    console.log(`👥 贡献记录: ${this.stats.attributionsProcessed}`);
    console.log(`🏷️  备用标题: ${this.stats.alternateTitlesProcessed}`);
    console.log(`📚 历史版本: ${this.stats.versionsCreated}`);
    console.log(`❌ 错误数量: ${this.stats.errors.length}`);
    
    // 显示用户统计处理的特殊说明
    console.log('');
    console.log('📊 用户统计处理说明:');
    console.log('   ✅ 已删除页面的rating已从用户统计中排除');
    console.log('   ✅ 只统计活跃页面(isDeleted=false)的评分');
    console.log('   ✅ 用户排名基于活跃页面的总评分计算');
    
    if (this.stats.errors.length > 0) {
      console.log('\n⚠️  错误详情:');
      this.stats.errors.slice(0, 10).forEach((error, i) => {
        console.log(`${i + 1}. [${error.type}] ${error.error}`);
      });
      if (this.stats.errors.length > 10) {
        console.log(`... 还有 ${this.stats.errors.length - 10} 个错误`);
      }
    }
    
    console.log('='.repeat(80));
  }

  formatDuration(seconds) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    
    if (hours > 0) return `${hours}h ${minutes}m ${secs}s`;
    if (minutes > 0) return `${minutes}m ${secs}s`;
    return `${secs}s`;
  }
}

// 运行数据库同步
async function runDatabaseSync() {
  const syncService = new DatabaseSync();
  await syncService.runDatabaseSync();
}

export { DatabaseSync };

if (import.meta.url === `file://${process.argv[1]}`) {
  runDatabaseSync().catch(console.error);
}