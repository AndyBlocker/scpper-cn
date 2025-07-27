/**
 * 文件路径: src/sync/database-sync.js
 * 功能概述: SCPPER-CN 数据库同步基础模块
 * 
 * 主要功能:
 * - 基础数据库同步类，提供核心同步逻辑
 * - 页面历史版本管理和删除页面检测
 * - 用户评分维护和数据一致性保证
 * - 集成投票关系分析、用户分析、页面质量分析
 * - 支持增量更新和批量操作
 * - 数据库连接和事务管理
 * 
 * 注意:
 * - 此类作为基础类被 FastDatabaseSync 继承和优化
 * - 建议使用 FastDatabaseSync 以获得更好的性能
 */

import { GraphQLClient } from 'graphql-request';
import { PrismaClient } from '@prisma/client';
import { VoteRelationAnalyzer } from './analyzers/vote-relation-analyzer.js';
import { UserAnalyzer } from '../analyze/user-analyzer.js';
import { PageAnalyzer } from '../analyze/page-analyzer.js';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();
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
      pagesRecreated: 0,
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
      // 0. 确保数据一致性和数据库扩展
      await this.ensureDataConsistency();
      
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
      
      // 7. 分析用户投票关系
      await this.analyzeUserVoteRelations();
      
      // 8. 分析用户数据（joinTime、活跃用户）
      await this.analyzeUserData();
      
      // 9. 分析页面数据（威尔逊置信区间）
      await this.analyzePageData();
      
      // 10. 完成同步记录
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
      .filter(f => f.startsWith('production-data-final-') && f.endsWith('.json'))
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
        // 检查页面是否存在（查找指定URL的活跃页面）
        const existingPage = await this.prisma.page.findFirst({
          where: { 
            url: pageData.url,
            instanceDeletedAt: null // 只查找未被删除的实例
          },
          orderBy: { instanceVersion: 'desc' } // 获取最新版本
        });
        
        // 检查是否存在已删除的页面（用于URL复用检测）
        const deletedPage = existingPage?.isDeleted ? existingPage : null;
        const activePage = existingPage?.isDeleted ? null : existingPage;
        
        // 计算实例版本号：新页面从1开始，已存在页面递增
        const nextVersion = activePage ? activePage.instanceVersion + 1 : 1;
        
        const pageRecord = {
          url: pageData.url,
          urlInstanceId: `${pageData.url}#${nextVersion}`, // 使用正确的版本号
          instanceVersion: nextVersion, // 添加实例版本字段
          wikidotId: pageData.wikidotId,
          title: pageData.title,
          category: pageData.category,
          rating: pageData.rating || 0,
          voteCount: pageData.voteCount || 0,
          commentCount: pageData.commentCount || 0,
          revisionCount: pageData.revisionCount || 0,
          source: pageData.source || null, // 保存源代码
          textContent: pageData.textContent || null, // 保存文本内容
          tags: pageData.tags || [],
          isPrivate: false, // v2 doesn't have this field
          isDeleted: false,
          parentUrl: pageData.parentUrl,
          thumbnailUrl: pageData.thumbnailUrl,
          lastSyncedAt: new Date(),
          lastRevisionCount: pageData.revisionCount || 0,
          // 创建信息：仅在新页面时设置，更新时保留原值
          ...(activePage ? {} : {
            createdAt: pageData.createdAt ? new Date(pageData.createdAt) : null,
            createdByUser: pageData.createdByUser,
            createdByWikidotId: pageData.createdByWikidotId,
            instanceCreatedAt: new Date()
          })
        };
        
        if (activePage) {
          // 存在活跃页面，检查是否需要更新
          const needsUpdate = this.checkPageNeedsUpdate(activePage, pageRecord);
          
          if (needsUpdate) {
            // 更新时仅修改可变字段，保留创建信息
            const updateData = {
              title: pageRecord.title,
              category: pageRecord.category,
              rating: pageRecord.rating,
              voteCount: pageRecord.voteCount,
              commentCount: pageRecord.commentCount,
              revisionCount: pageRecord.revisionCount,
              source: pageRecord.source,
              textContent: pageRecord.textContent,
              tags: pageRecord.tags,
              parentUrl: pageRecord.parentUrl,
              thumbnailUrl: pageRecord.thumbnailUrl,
              lastSyncedAt: pageRecord.lastSyncedAt,
              lastRevisionCount: pageRecord.lastRevisionCount,
              // 保留原有的创建信息，不覆盖
              // createdAt, createdByUser, createdByWikidotId, instanceCreatedAt 等字段不更新
            };
            
            await this.prisma.page.update({
              where: { id: activePage.id },
              data: updateData
            });
            
            // 创建页面历史版本记录
            await this.createPageHistory(activePage.url, pageRecord, 'updated');
            this.stats.pagesUpdated++;
          }
        } else if (deletedPage) {
          // URL复用情况：存在已删除页面，需要复活并保留删除历史
          console.log(`🔄 检测到URL复用: ${pageData.url} (之前被删除于 ${deletedPage.deletedAt})`);
          
          // 先为已删除状态创建历史记录（如果还没有）
          const hasDeletedHistory = await this.prisma.pageHistory.findFirst({
            where: { 
              pageUrl: deletedPage.url,
              changeType: 'deleted' 
            }
          });
          
          if (!hasDeletedHistory) {
            await this.createPageHistory(deletedPage.url, deletedPage, 'deleted');
          }
          
          // 复活页面并更新为新数据
          await this.prisma.page.update({
            where: { url: deletedPage.url },
            data: {
              ...pageRecord,
              // 保留一些删除相关的历史信息到备注字段或新字段
              deletionReason: `复用URL - 原删除原因: ${deletedPage.deletionReason}`
            }
          });
          
          // 创建复活记录
          await this.createPageHistory(deletedPage.url, pageRecord, 'recreated');
          this.stats.pagesRecreated = (this.stats.pagesRecreated || 0) + 1;
          
        } else {
          // 创建全新页面
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
    
    console.log(`✅ 页面同步完成: 创建 ${this.stats.pagesCreated}, 更新 ${this.stats.pagesUpdated}, 复活 ${this.stats.pagesRecreated}`);
  }

  async syncUsers(users) {
    console.log('👤 同步用户数据...');
    
    for (const userData of users) {
      try {
        // 使用 wikidotId 作为唯一主键，避免同名用户互相覆盖
        if (!userData.wikidotId) {
          console.log(`⚠️  跳过无 wikidotId 的用户: ${userData.displayName}`);
          continue;
        }
        
        let user = await this.prisma.user.findUnique({
          where: { wikidotId: String(userData.wikidotId) }
        });
        
        const userRecord = {
          name: userData.displayName, // 保持 schema 兼容性
          displayName: userData.displayName, // 可变显示名
          wikidotId: String(userData.wikidotId), // 真正的唯一主键
          unixName: userData.unixName || null,
          // 其他统计字段将在updateUserStatistics中计算
          lastSyncedAt: new Date()
        };
        
        if (user) {
          // 更新时允许 displayName 变更，但保持 wikidotId 不变
          await this.prisma.user.update({
            where: { wikidotId: user.wikidotId },
            data: {
              displayName: userRecord.displayName,
              name: userRecord.name, // 同步更新 name 字段
              unixName: userRecord.unixName,
              lastSyncedAt: userRecord.lastSyncedAt
            }
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
    console.log('🗳️  智能投票记录同步...');
    
    if (!voteRecords || voteRecords.length === 0) {
      console.log('   无投票记录需要同步');
      return;
    }
    
    console.log(`   📊 待处理投票记录: ${voteRecords.length.toLocaleString()} 条`);
    
    // 获取数据库中最新的投票时间戳，实现增量同步
    const latestVoteInDb = await this.prisma.voteRecord.findFirst({
      orderBy: { timestamp: 'desc' },
      select: { timestamp: true }
    });
    
    let filteredVotes = voteRecords;
    if (latestVoteInDb && this.config.enableIncrementalUpdate) {
      const latestTimestamp = latestVoteInDb.timestamp;
      console.log(`   📅 数据库最新投票时间: ${latestTimestamp.toLocaleString()}`);
      
      // 只处理比数据库最新记录更新的投票
      filteredVotes = voteRecords.filter(vote => {
        const voteTimestamp = new Date(vote.timestamp);
        return voteTimestamp > latestTimestamp;
      });
      
      console.log(`   🔄 增量模式: 需要同步 ${filteredVotes.length.toLocaleString()} 条新投票记录`);
      console.log(`   ⚡ 跳过了 ${(voteRecords.length - filteredVotes.length).toLocaleString()} 条已存在的记录`);
      
      if (filteredVotes.length === 0) {
        console.log('   ✅ 所有投票记录都是最新的，无需同步');
        return;
      }
    } else {
      console.log('   📦 完整模式: 将检查所有投票记录');
    }
    
    // 批量处理投票记录
    await this.batchSyncVoteRecords(filteredVotes);
  }
  
  async batchSyncVoteRecords(voteRecords) {
    const batchSize = 1000; // 每批处理1000条记录
    const totalBatches = Math.ceil(voteRecords.length / batchSize);
    
    console.log(`   🔄 开始批量同步: ${totalBatches} 个批次，每批 ${batchSize} 条`);
    
    for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
      const startIdx = batchIndex * batchSize;
      const endIdx = Math.min(startIdx + batchSize, voteRecords.length);
      const batch = voteRecords.slice(startIdx, endIdx);
      
      console.log(`     批次 ${batchIndex + 1}/${totalBatches}: 处理 ${batch.length} 条记录...`);
      
      try {
        // 批量检查现有记录
        const existingVotes = await this.batchCheckExistingVotes(batch);
        const existingVoteKeys = new Set(existingVotes.map(vote => {
          // 统一到秒级 Unix 时间戳
          const ts = Math.floor(new Date(vote.timestamp).getTime() / 1000);
          return `${vote.pageUrl}|${vote.userWikidotId}|${ts}`;
        }));
        
        // 过滤出需要插入的新记录
        const newVotes = batch.filter(voteData => {
          // 统一到秒级 Unix 时间戳，避免毫秒精度差异导致的重复插入
          const ts = Math.floor(new Date(voteData.timestamp).getTime() / 1000);
          const key = `${voteData.pageUrl}|${voteData.voterWikidotId}|${ts}`;
          return !existingVoteKeys.has(key);
        });
        
        if (newVotes.length > 0) {
          // 批量插入新记录
          await this.batchInsertVoteRecords(newVotes);
          console.log(`       ✅ 插入了 ${newVotes.length} 条新记录`);
        } else {
          console.log(`       ⚪ 该批次所有记录都已存在`);
        }
        
        this.stats.votesProcessed += batch.length;
        
      } catch (error) {
        console.error(`❌ 批次 ${batchIndex + 1} 处理失败: ${error.message}`);
        // 回退到逐条处理
        await this.fallbackSyncVoteRecords(batch);
      }
    }
    
    console.log(`   ✅ 投票记录同步完成: 处理了 ${this.stats.votesProcessed.toLocaleString()} 条记录`);
  }
  
  async batchCheckExistingVotes(batch) {
    const conditions = batch.map(vote => ({
      pageUrl: vote.pageUrl,
      userWikidotId: String(vote.voterWikidotId),
      timestamp: new Date(vote.timestamp)
    }));
    
    return await this.prisma.voteRecord.findMany({
      where: {
        OR: conditions
      },
      select: {
        pageUrl: true,
        userWikidotId: true,
        timestamp: true
      }
    });
  }
  
  async batchInsertVoteRecords(voteRecords) {
    const data = voteRecords.map(voteData => ({
      pageUrl: voteData.pageUrl,
      userWikidotId: String(voteData.voterWikidotId),
      userName: voteData.voterName || `User_${voteData.voterWikidotId}`,
      timestamp: new Date(voteData.timestamp),
      direction: voteData.direction
    }));
    
    await this.prisma.voteRecord.createMany({
      data: data,
      skipDuplicates: true // 跳过重复记录
    });
  }
  
  async fallbackSyncVoteRecords(batch) {
    console.log(`       🔄 回退到逐条处理模式...`);
    
    for (const voteData of batch) {
      try {
        // 检查投票记录是否已存在
        const existingVote = await this.prisma.voteRecord.findUnique({
          where: {
            pageUrl_userWikidotId_timestamp: {
              pageUrl: voteData.pageUrl,
              userWikidotId: String(voteData.voterWikidotId),
              timestamp: new Date(voteData.timestamp)
            }
          }
        });
        
        if (!existingVote) {
          await this.prisma.voteRecord.create({
            data: {
              pageUrl: voteData.pageUrl,
              userWikidotId: String(voteData.voterWikidotId),
              userName: voteData.voterName || `User_${voteData.voterWikidotId}`,
              timestamp: new Date(voteData.timestamp),
              direction: voteData.direction
            }
          });
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
              wikidotId: revisionData.revisionId,
              timestamp: new Date(revisionData.timestamp),
              type: 'edit',
              userWikidotId: revisionData.userId ? String(revisionData.userId) : null,
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
        // 检查贡献记录是否已存在（使用实际的唯一约束：pageUrl + userName + attributionType）
        const existingAttribution = await this.prisma.attribution.findUnique({
          where: {
            pageUrl_userName_attributionType: {
              pageUrl: attrData.pageUrl,
              userName: attrData.userName || 'Unknown',
              attributionType: attrData.attributionType
            }
          }
        });
        
        if (!existingAttribution) {
          await this.prisma.attribution.create({
            data: {
              pageUrl: attrData.pageUrl,
              userName: attrData.userName || 'Unknown',
              userId: attrData.userId,
              userUnixName: attrData.userUnixName,
              attributionType: attrData.attributionType,
              date: attrData.date ? new Date(attrData.date) : null,
              orderIndex: attrData.order || 0,
              isCurrent: true
            }
          });
        } else {
          // 更新现有记录以确保数据最新（使用复合主键）
          await this.prisma.attribution.update({
            where: {
              pageUrl_userName_attributionType: {
                pageUrl: attrData.pageUrl,
                userName: attrData.userName || 'Unknown',
                attributionType: attrData.attributionType
              }
            },
            data: {
              userId: attrData.userId,
              userUnixName: attrData.userUnixName,
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
      // 获取页面ID
      const page = await this.prisma.page.findFirst({
        where: { 
          url: pageUrl,
          instanceDeletedAt: null
        },
        select: { id: true },
        orderBy: { instanceVersion: 'desc' }
      });
      
      if (!page) {
        console.warn(`⚠️ 页面不存在，无法创建历史记录: ${pageUrl}`);
        return;
      }
      
      // 获取当前版本号
      const lastVersion = await this.prisma.pageHistory.findFirst({
        where: { pageId: page.id },
        orderBy: { versionNumber: 'desc' }
      });
      
      const versionNumber = (lastVersion?.versionNumber || 0) + 1;
      
      const historyData = {
        pageId: page.id,
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
      FROM "Page" p 
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
  
  async analyzeUserVoteRelations() {
    console.log('🤝 分析用户投票关系...');
    
    try {
      const voteRelationAnalyzer = new VoteRelationAnalyzer(this.prisma);
      await voteRelationAnalyzer.analyzeAndUpdateVoteRelations();
      
      console.log(`✅ 用户投票关系分析完成`);
    } catch (error) {
      console.error(`❌ 投票关系分析失败: ${error.message}`);
      this.stats.errors.push({
        type: 'vote_relation_analysis_error',
        error: error.message,
        timestamp: new Date()
      });
      // 不抛出错误，允许同步继续完成
    }
  }

  async analyzeUserData() {
    console.log('👤 分析用户数据...');
    
    try {
      const userAnalyzer = new UserAnalyzer(this.prisma);
      
      // 确保数据库表包含必要字段
      await userAnalyzer.ensureUserTableFields();
      
      // 运行用户数据分析
      await userAnalyzer.analyzeAndUpdateUserData();
      
      console.log(`✅ 用户数据分析完成`);
    } catch (error) {
      console.error(`❌ 用户数据分析失败: ${error.message}`);
      this.stats.errors.push({
        type: 'user_data_analysis_error',
        error: error.message,
        timestamp: new Date()
      });
      // 不抛出错误，允许同步继续完成
    }
  }

  async analyzePageData() {
    console.log('📄 分析页面数据...');
    
    try {
      const pageAnalyzer = new PageAnalyzer(this.prisma);
      
      // 确保数据库表包含必要字段
      await pageAnalyzer.ensurePageTableFields();
      
      // 运行页面数据分析
      await pageAnalyzer.analyzeAndUpdatePageData();
      
      console.log(`✅ 页面数据分析完成`);
    } catch (error) {
      console.error(`❌ 页面数据分析失败: ${error.message}`);
      this.stats.errors.push({
        type: 'page_data_analysis_error',
        error: error.message,
        timestamp: new Date()
      });
      // 不抛出错误，允许同步继续完成
    }
  }

  async generateSyncReport() {
    const duration = (this.stats.endTime - this.stats.startTime) / 1000;
    
    console.log('\n🎉 API v2 数据库同步完成！');
    console.log('='.repeat(80));
    console.log(`⏱️  总耗时: ${this.formatDuration(duration)}`);
    console.log(`📄 页面处理: ${this.stats.pagesProcessed} (创建: ${this.stats.pagesCreated}, 更新: ${this.stats.pagesUpdated}, 复活: ${this.stats.pagesRecreated}, 删除: ${this.stats.pagesDeleted})`);
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

  /**
   * 确保数据一致性和数据库扩展
   */
  async ensureDataConsistency() {
    console.log('🔧 检查数据一致性和数据库扩展...');
    
    try {
      // 1. 确保PostgreSQL扩展存在
      await this.ensurePostgreSQLExtensions();
      
      // 2. 检查和修复外键一致性
      await this.checkForeignKeyConsistency();
      
      // 3. 添加缺失的索引
      await this.ensureOptimalIndexes();
      
      console.log('✅ 数据一致性检查完成');
      
    } catch (error) {
      console.error(`⚠️  数据一致性检查警告: ${error.message}`);
      // 不中断同步，仅记录警告
    }
  }
  
  /**
   * 确保PostgreSQL扩展存在
   */
  async ensurePostgreSQLExtensions() {
    const extensions = ['pgcrypto', 'uuid-ossp'];
    
    for (const ext of extensions) {
      try {
        await this.prisma.$executeRawUnsafe(`CREATE EXTENSION IF NOT EXISTS "${ext}"`);
        console.log(`   ✅ PostgreSQL扩展 ${ext} 已确保`);
      } catch (error) {
        console.log(`   ⚠️  PostgreSQL扩展 ${ext} 创建失败: ${error.message}`);
      }
    }
  }
  
  /**
   * 检查外键一致性
   */
  async checkForeignKeyConsistency() {
    console.log('   🔍 检查外键一致性...');
    
    try {
      // 检查孤立的投票记录（引用不存在的页面）
      const orphanedVotes = await this.prisma.$queryRawUnsafe(`
        SELECT COUNT(*) as count FROM "VoteRecord" v
        LEFT JOIN "Page" p ON v."pageId" = p.id
        WHERE p.id IS NULL
      `);
      
      if (orphanedVotes[0]?.count > 0) {
        console.log(`   ⚠️  发现 ${orphanedVotes[0].count} 条孤立投票记录`);
        
        // 删除孤立的投票记录
        await this.prisma.$executeRawUnsafe(`
          DELETE FROM "VoteRecord" v
          WHERE NOT EXISTS (
            SELECT 1 FROM "Page" p WHERE p.id = v."pageId"
          )
        `);
        
        console.log(`   🧹 已清理孤立投票记录`);
      }
      
      // 检查孤立的归属记录
      const orphanedAttributions = await this.prisma.$queryRawUnsafe(`
        SELECT COUNT(*) as count FROM "Attribution" a
        LEFT JOIN "Page" p ON a."pageId" = p.id
        WHERE p.id IS NULL
      `);
      
      if (orphanedAttributions[0]?.count > 0) {
        console.log(`   ⚠️  发现 ${orphanedAttributions[0].count} 条孤立归属记录`);
        
        await this.prisma.$executeRawUnsafe(`
          DELETE FROM "Attribution" a
          WHERE NOT EXISTS (
            SELECT 1 FROM "Page" p WHERE p.id = a."pageId"
          )
        `);
        
        console.log(`   🧹 已清理孤立归属记录`);
      }
      
    } catch (error) {
      console.log(`   ⚠️  外键一致性检查失败: ${error.message}`);
    }
  }
  
  /**
   * 确保最优索引存在
   */
  async ensureOptimalIndexes() {
    console.log('   📊 确保最优索引...');
    
    const indexes = [
      {
        name: 'idx_pages_url_is_deleted',
        sql: 'CREATE INDEX IF NOT EXISTS idx_pages_url_is_deleted ON "Page" (url, "isDeleted")'
      },
      {
        name: 'idx_pages_last_synced',
        sql: 'CREATE INDEX IF NOT EXISTS idx_pages_last_synced ON "Page" ("lastSyncedAt")'
      },
      {
        name: 'idx_vote_records_page_user',
        sql: 'CREATE INDEX IF NOT EXISTS idx_vote_records_page_user ON "VoteRecord" ("pageId", "userWikidotId")'
      },
      {
        name: 'idx_users_wikidot_id',
        sql: 'CREATE INDEX IF NOT EXISTS idx_users_wikidot_id ON "User" ("wikidotId")'
      }
    ];
    
    for (const index of indexes) {
      try {
        await this.prisma.$executeRawUnsafe(index.sql);
        console.log(`   ✅ 索引 ${index.name} 已确保`);
      } catch (error) {
        console.log(`   ⚠️  索引 ${index.name} 创建失败: ${error.message}`);
      }
    }
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