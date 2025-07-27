/**
 * 文件路径: src/sync/fast-database-sync.js
 * 功能概述: SCPPER-CN 高性能数据库同步模块
 * 
 * 主要功能:
 * - 高性能批处理数据库同步，继承并优化 DatabaseSync 功能
 * - V2版本适配新ID-based schema，支持URL实例版本控制
 * - 大幅提升批处理大小和并发性能（页面1000/批，投票2000/批）
 * - 集成用户分析和页面质量分析功能
 * - 智能数据去重和增量更新机制
 * - 源代码版本管理和数据一致性保证
 * 
 * 使用方式:
 * - npm run database 或 node src/main.js database
 * - 支持 --force 参数进行强制重置
 */

import { PrismaClient } from '@prisma/client';
import { DatabaseSync } from './database-sync.js';
import { SourceVersionManager } from './source-version-manager.js';
import fs from 'fs';
import crypto from 'crypto';
class FastDatabaseSync extends DatabaseSync {
  constructor(options = {}) {
    super();
    
    // 重写配置，针对高性能批处理优化
    this.config = {
      ...this.config,
      batchSize: 500,              // 大幅提升批处理大小
      pageBatchSize: 1000,         // 页面批处理 - 大幅提升
      voteBatchSize: 2000,         // 投票记录批处理 - 大幅提升  
      attrBatchSize: 500,          // 贡献记录批处理 - 大幅提升
      revisionBatchSize: 1000,     // 修订记录批处理
      userBatchSize: 1000,         // 用户批处理
      enableBatchOperations: true,
      maxConcurrentOps: 5,         // 提升并发数
      forceReset: options.forceReset || false,  // 强制重置选项
      skipAnalysis: false  // 保持所有分析功能
    };
    
    // 使用高性能数据库配置
    this.prisma = new PrismaClient({
      log: ['error']
    });
    
    // 初始化源代码版本管理器
    this.sourceVersionManager = new SourceVersionManager(this.prisma);
    
    this.batchStats = {
      pagesPreloaded: 0,
      pagesBatched: 0,
      votesBatched: 0,
      attributionsBatched: 0
    };

    // 新增：URL到pageId的映射管理
    this.pageIdMap = new Map(); // url -> 最新pageId
    this.urlInstanceMap = new Map(); // url -> 当前实例版本号
  }

  buildOptimizedUrl() {
    const baseUrl = process.env.DATABASE_URL;
    if (!baseUrl) return baseUrl;
    
    const url = new URL(baseUrl);
    // 设置适中的连接池参数，平衡批处理和Web应用需求
    url.searchParams.set('connection_limit', '15');  // 足够批处理，也预留Web应用连接
    url.searchParams.set('pool_timeout', '60');
    return url.toString();
  }

  /**
   * 预加载URL到pageId的映射关系
   */
  async preloadPageMappings() {
    console.log('🔄 预加载页面映射关系...');
    
    // 获取所有现有页面的URL -> 最新pageId映射
    const existingPages = await this.prisma.page.findMany({
      select: {
        id: true,
        url: true,
        instanceVersion: true,
        isDeleted: true
      }
    });
    
    // 建立URL到最新pageId的映射
    const urlLatestPageMap = new Map();
    existingPages.forEach(page => {
      const current = urlLatestPageMap.get(page.url);
      if (!current || page.instanceVersion > current.instanceVersion) {
        urlLatestPageMap.set(page.url, page);
      }
    });
    
    // 更新映射关系
    urlLatestPageMap.forEach((page, url) => {
      this.pageIdMap.set(url, page.id);
      this.urlInstanceMap.set(url, page.instanceVersion);
    });
    
    console.log(`   ✅ 加载了 ${this.pageIdMap.size} 个URL映射`);
  }

  /**
   * 优化的页面同步 - V2版本使用ID主键和实例版本控制
   */
  async syncPagesFast(pages) {
    console.log(`📄 快速页面同步 V2: ${pages.length} 个页面`);
    const startTime = Date.now();
    
    // 1. 预加载页面映射关系
    await this.preloadPageMappings();
    
    // 2. 处理页面数据，使用实例版本控制
    const operations = { toCreate: [], toUpdate: [], toRevive: [], toModify: [] };
    
    for (const pageData of pages) {
      const url = pageData.url;
      const existingPageId = this.pageIdMap.get(url);
      const currentInstanceVersion = this.urlInstanceMap.get(url) || 0;
      
      // 计算源代码hash
      const sourceHash = pageData.source ? 
        crypto.createHash('sha256').update(pageData.source).digest('hex') : null;
      
      if (!existingPageId) {
        // 全新页面
        const pageRecord = this.buildPageRecordV2(pageData, 1, sourceHash);
        pageRecord.urlInstanceId = `${url}#1`;
        operations.toCreate.push(pageRecord);
      } else {
        // 检查现有页面状态
        const existingPage = await this.prisma.page.findUnique({
          where: { id: existingPageId },
          select: { 
            sourceHash: true, 
            isDeleted: true, 
            rating: true, 
            voteCount: true,
            instanceVersion: true
          }
        });
        
        if (existingPage?.isDeleted) {
          // 复活删除的页面 - 创建新实例
          const newInstanceVersion = currentInstanceVersion + 1;
          const pageRecord = this.buildPageRecordV2(pageData, newInstanceVersion, sourceHash);
          operations.toRevive.push({ pageRecord, existingPageId });
        } else if (this.shouldCreateNewInstance(existingPage, pageData, sourceHash)) {
          // 需要更新的页面 - 创建新实例
          const newInstanceVersion = currentInstanceVersion + 1;
          const pageRecord = this.buildPageRecordV2(pageData, newInstanceVersion, sourceHash);
          operations.toUpdate.push({ pageRecord, existingPageId });
        } else {
          // 仅需要更新统计数据，不创建新实例
          operations.toModify.push({ 
            pageId: existingPageId, 
            pageData: pageData, 
            sourceHash: sourceHash 
          });
        }
      }
      
      // 标记页面为存在（用于删除检测） - 修复bug
      this.cache.existingPages.delete(url);
    }
    
    console.log(`📊 页面操作分类: 创建 ${operations.toCreate.length}, 更新 ${operations.toUpdate.length}, 复活 ${operations.toRevive.length}, 修改 ${operations.toModify.length}`);
    
    // 3. 批量执行操作
    let processed = 0;
    
    // 批量创建新页面
    if (operations.toCreate.length > 0) {
      console.log(`➕ 批量创建页面...`);
      for (let i = 0; i < operations.toCreate.length; i += this.config.pageBatchSize) {
        const batch = operations.toCreate.slice(i, i + this.config.pageBatchSize);
        
        // 使用事务确保一致性
        await this.prisma.$transaction(async (tx) => {
          for (const pageRecord of batch) {
            const newPage = await tx.page.create({ data: pageRecord });
            this.pageIdMap.set(pageRecord.url, newPage.id);
            this.urlInstanceMap.set(pageRecord.url, newPage.instanceVersion);
          }
        });
        
        processed += batch.length;
        if (processed % 1000 === 0) {
          console.log(`   创建进度: ${processed}/${operations.toCreate.length}`);
        }
      }
      this.stats.pagesCreated = operations.toCreate.length;
    }
    
    // 批量创建更新实例
    if (operations.toUpdate.length > 0) {
      console.log(`🔄 批量创建更新实例...`);
      for (const { pageRecord, existingPageId } of operations.toUpdate) {
        const newPage = await this.prisma.page.create({ 
          data: {
            ...pageRecord,
            replacedByInstanceId: null // 新实例不指向任何替换
          }
        });
        
        // 更新旧实例的替换指针
        await this.prisma.page.update({
          where: { id: existingPageId },
          data: { replacedByInstanceId: newPage.id }
        });
        
        // 更新映射关系
        this.pageIdMap.set(pageRecord.url, newPage.id);
        this.urlInstanceMap.set(pageRecord.url, newPage.instanceVersion);
        
        processed++;
      }
      this.stats.pagesUpdated = operations.toUpdate.length;
    }
    
    // 批量创建复活实例
    if (operations.toRevive.length > 0) {
      console.log(`🔄 批量复活页面...`);
      for (const { pageRecord, existingPageId } of operations.toRevive) {
        // 创建页面历史记录
        await this.createPageHistoryV2(existingPageId, 'recreated', '页面URL被重新使用');
        
        const newPage = await this.prisma.page.create({ data: pageRecord });
        
        // 更新映射关系
        this.pageIdMap.set(pageRecord.url, newPage.id);
        this.urlInstanceMap.set(pageRecord.url, newPage.instanceVersion);
        
        processed++;
      }
      this.stats.pagesRecreated = operations.toRevive.length;
    }
    
    // 批量修改现有页面（不创建新实例）
    if (operations.toModify.length > 0) {
      console.log(`📝 批量修改现有页面...`);
      for (let i = 0; i < operations.toModify.length; i += this.config.pageBatchSize) {
        const batch = operations.toModify.slice(i, i + this.config.pageBatchSize);
        
        // 使用事务批量更新
        await this.prisma.$transaction(async (tx) => {
          for (const { pageId, pageData, sourceHash } of batch) {
            // 获取现有页面的源代码信息，避免错误覆盖
            const existingPage = await tx.page.findUnique({
              where: { id: pageId },
              select: { source: true, sourceHash: true }
            });
            
            // 构建更新数据 - 保留现有源代码如果新数据中没有源代码
            const updateData = {
              title: pageData.title || 'Untitled',
              category: pageData.category,
              rating: pageData.rating || 0,
              voteCount: pageData.voteCount || 0,
              commentCount: pageData.commentCount || 0,
              revisionCount: pageData.revisionCount || 0,
              lastRevisionCount: pageData.lastRevisionCount || 0,
              tags: pageData.tags || [],
              lastEditedByUser: pageData.lastEditedByUser,
              lastEditedAt: pageData.lastEditedAt ? new Date(pageData.lastEditedAt) : null,
              lastSyncedAt: new Date()
            };
            
            // 只有新数据中有源代码时才更新源代码字段
            if (pageData.source) {
              updateData.source = pageData.source;
              updateData.textContent = pageData.textContent;
              updateData.sourceHash = sourceHash;
              updateData.contentLength = pageData.source.length;
            }
            // 如果新数据没有源代码，保留现有的源代码（不覆盖）
            
            await tx.page.update({
              where: { id: pageId },
              data: updateData
            });
          }
        });
        
        processed += batch.length;
        if (processed % 1000 === 0) {
          console.log(`   修改进度: ${processed}/${operations.toModify.length}`);
        }
      }
      this.stats.pagesModified = operations.toModify.length;
    }
    
    // 更新URL映射表
    await this.updateUrlMappings();
    
    this.batchStats.pagesBatched = operations.toCreate.length + operations.toUpdate.length + operations.toRevive.length + operations.toModify.length;
    
    const duration = Date.now() - startTime;
    console.log(`✅ V2页面同步完成: 耗时 ${Math.round(duration / 1000)}秒`);
    console.log(`📊 处理结果: 创建 ${this.stats.pagesCreated || 0}, 更新 ${this.stats.pagesUpdated || 0}, 复活 ${this.stats.pagesRecreated || 0}, 修改 ${this.stats.pagesModified || 0}`);
  }

  /**
   * 优化的投票记录同步 - V2版本使用pageId
   */
  async syncVoteRecordsFast(voteRecords) {
    if (!voteRecords?.length) return;
    
    console.log(`🗳️  快速投票记录同步 V2: ${voteRecords.length} 条记录`);
    const startTime = Date.now();
    
    // 1. 去重和转换为pageId
    console.log('🔍 去重处理和URL转换...');
    const uniqueVotes = new Map();
    let invalidPageUrls = 0;
    
    for (const vote of voteRecords) {
      const pageId = this.pageIdMap.get(vote.pageUrl);
      if (!pageId) {
        invalidPageUrls++;
        continue;
      }
      
      const key = `${pageId}|${vote.voterWikidotId}|${vote.timestamp}`;
      if (!uniqueVotes.has(key)) {
        uniqueVotes.set(key, {
          pageId: pageId,
          userWikidotId: vote.voterWikidotId,
          timestamp: vote.timestamp,
          userName: vote.voterName || 'Unknown',
          direction: vote.direction
        });
      }
    }
    
    const deduplicatedVotes = Array.from(uniqueVotes.values());
    console.log(`📊 去重完成: ${deduplicatedVotes.length} 条记录 (去除重复 ${voteRecords.length - deduplicatedVotes.length} 条)`);
    
    if (invalidPageUrls > 0) {
      console.log(`⚠️  跳过 ${invalidPageUrls} 条无效页面URL的投票记录`);
    }
    
    // 2. 大批量处理
    let processed = 0;
    for (let i = 0; i < deduplicatedVotes.length; i += this.config.voteBatchSize) {
      const batch = deduplicatedVotes.slice(i, i + this.config.voteBatchSize);
      
      try {
        // 构建批量插入SQL（使用pageId）
        const values = batch.map(vote => {
          const safeUserName = vote.userName.replace(/'/g, "''");
          return `(${vote.pageId}, '${vote.userWikidotId}', '${vote.timestamp}', '${safeUserName}', ${vote.direction})`;
        }).join(',');
        
        await this.prisma.$executeRawUnsafe(`
          INSERT INTO "VoteRecord" ("pageId", "userWikidotId", "timestamp", "userName", "direction")
          VALUES ${values}
          ON CONFLICT ("pageId", "userWikidotId", "timestamp") 
          DO UPDATE SET 
            "userName" = EXCLUDED."userName",
            "direction" = EXCLUDED."direction"
        `);
        
        processed += batch.length;
        
        // 定期显示进度
        if (i % (this.config.voteBatchSize * 20) === 0) {
          const progress = Math.round((processed / deduplicatedVotes.length) * 100);
          console.log(`   🗳️  处理进度: ${processed}/${deduplicatedVotes.length} (${progress}%)`);
        }
        
      } catch (error) {
        console.error(`❌ 投票记录批量插入失败 (批次 ${Math.floor(i / this.config.voteBatchSize)}): ${error.message}`);
        this.stats.errors.push({
          type: 'vote_batch_error',
          error: error.message,
          batchIndex: Math.floor(i / this.config.voteBatchSize)
        });
      }
    }
    
    this.batchStats.votesBatched = processed;
    this.stats.votesProcessed = processed;
    
    const duration = Date.now() - startTime;
    console.log(`✅ V2投票记录同步完成: ${processed} 条记录，耗时 ${Math.round(duration / 1000)}秒`);
  }

  /**
   * 优化的Attribution同步 - V2版本使用pageId
   */
  async syncAttributionsFast(attributions) {
    if (!attributions?.length) return;
    
    console.log(`👥 快速贡献记录同步 V2: ${attributions.length} 条记录`);
    const startTime = Date.now();
    
    // 1. 转换并过滤有效记录
    const validAttributions = [];
    let invalidPageUrls = 0;
    
    for (const attr of attributions) {
      const pageId = this.pageIdMap.get(attr.pageUrl);
      if (!pageId) {
        invalidPageUrls++;
        continue;
      }
      
      validAttributions.push({
        pageId: pageId,
        userName: attr.userName || 'Unknown',
        attributionType: attr.attributionType,
        userId: attr.userId,
        userUnixName: attr.userUnixName,
        date: attr.date ? new Date(attr.date) : null,
        orderIndex: attr.order || 0,
        isCurrent: true
      });
    }
    
    if (invalidPageUrls > 0) {
      console.log(`⚠️  跳过 ${invalidPageUrls} 条无效页面URL的贡献记录`);
    }
    
    // 2. 预查询现有记录
    console.log('📋 预查询现有贡献记录...');
    const existingKeys = new Set();
    
    // 分批查询避免单次查询过大
    for (let i = 0; i < validAttributions.length; i += 1000) {
      const batch = validAttributions.slice(i, i + 1000);
      const existing = await this.prisma.attribution.findMany({
        where: {
          OR: batch.map(attr => ({
            pageId: attr.pageId,
            userName: attr.userName,
            attributionType: attr.attributionType
          }))
        },
        select: { pageId: true, userName: true, attributionType: true }
      });
      
      existing.forEach(attr => {
        existingKeys.add(`${attr.pageId}|${attr.userName}|${attr.attributionType}`);
      });
    }
    
    console.log(`📋 预查询完成: ${existingKeys.size} 个现有记录`);
    
    // 3. 分类处理
    const operations = { toCreate: [], toUpdate: [] };
    
    validAttributions.forEach(attr => {
      const key = `${attr.pageId}|${attr.userName}|${attr.attributionType}`;
      
      if (existingKeys.has(key)) {
        operations.toUpdate.push(attr);
      } else {
        operations.toCreate.push(attr);
      }
    });
    
    console.log(`📊 贡献记录分类: 创建 ${operations.toCreate.length}, 更新 ${operations.toUpdate.length}`);
    
    // 4. 批量执行
    let processed = 0;
    
    // 批量创建
    if (operations.toCreate.length > 0) {
      for (let i = 0; i < operations.toCreate.length; i += this.config.attrBatchSize) {
        const batch = operations.toCreate.slice(i, i + this.config.attrBatchSize);
        try {
          await this.prisma.attribution.createMany({
            data: batch,
            skipDuplicates: true
          });
          processed += batch.length;
        } catch (error) {
          console.error(`❌ 创建贡献记录失败: ${error.message}`);
        }
      }
    }
    
    // 批量更新
    if (operations.toUpdate.length > 0) {
      for (let i = 0; i < operations.toUpdate.length; i += this.config.attrBatchSize) {
        const batch = operations.toUpdate.slice(i, i + this.config.attrBatchSize);
        try {
          await Promise.all(
            batch.map(data =>
              this.prisma.attribution.update({
                where: {
                  pageId_userName_attributionType: {
                    pageId: data.pageId,
                    userName: data.userName,
                    attributionType: data.attributionType
                  }
                },
                data: {
                  userId: data.userId,
                  userUnixName: data.userUnixName,
                  date: data.date,
                  orderIndex: data.orderIndex,
                  isCurrent: data.isCurrent
                }
              })
            )
          );
          processed += batch.length;
        } catch (error) {
          console.error(`❌ 更新贡献记录失败: ${error.message}`);
        }
      }
    }
    
    this.batchStats.attributionsBatched = processed;
    this.stats.attributionsProcessed = operations.toCreate.length + operations.toUpdate.length;
    
    const duration = Date.now() - startTime;
    console.log(`✅ V2贡献记录同步完成: ${processed} 条记录，耗时 ${Math.round(duration / 1000)}秒`);
  }

  /**
   * 修订记录同步 - V2版本使用pageId
   */
  async syncRevisionsFastV2(revisions) {
    if (!revisions?.length) return;
    
    console.log(`📝 快速修订记录同步 V2: ${revisions.length} 条记录`);
    const startTime = Date.now();
    
    const batchSize = 200;
    let processed = 0;
    let invalidPageUrls = 0;
    
    for (let i = 0; i < revisions.length; i += batchSize) {
      const batch = revisions.slice(i, i + batchSize);
      const validRevisions = [];
      
      for (const revision of batch) {
        const pageId = this.pageIdMap.get(revision.pageUrl);
        if (!pageId) {
          invalidPageUrls++;
          continue;
        }
        
        try {
          // 检查修订记录是否已存在
          const existingRevision = await this.prisma.revision.findUnique({
            where: {
              pageId_revisionIndex: {
                pageId: pageId,
                revisionIndex: parseInt(revision.revisionId)
              }
            }
          });
          
          if (!existingRevision) {
            // 只有当真的有源代码时才计算hash和长度
            const hasSourceCode = revision.sourceCode && revision.sourceCode.length > 0;
            const sourceHash = hasSourceCode ? 
              crypto.createHash('sha256').update(revision.sourceCode).digest('hex') : null;
            
            validRevisions.push({
              pageId: pageId,
              revisionIndex: parseInt(revision.revisionId),
              wikidotId: revision.wikidotId,
              timestamp: new Date(revision.timestamp),
              type: revision.type || 'edit',
              comment: revision.comment,
              userWikidotId: revision.userWikidotId,
              userName: revision.userName,
              // 只在有实际源代码时才存储，否则为null避免存储无意义的undefined
              sourceCode: hasSourceCode ? revision.sourceCode : null,
              sourceHash: sourceHash,
              contentLength: hasSourceCode ? revision.sourceCode.length : null
            });
          }
        } catch (error) {
          console.error(`❌ 处理修订记录失败: ${error.message}`);
        }
      }
      
      // 批量创建修订记录
      if (validRevisions.length > 0) {
        try {
          await this.prisma.revision.createMany({
            data: validRevisions,
            skipDuplicates: true
          });
          
          processed += validRevisions.length;
        } catch (error) {
          console.error(`❌ 批量创建修订记录失败: ${error.message}`);
        }
      }
      
      if (processed % 2000 === 0) {
        console.log(`   📝 处理进度: ${processed}/${revisions.length}...`);
      }
    }
    
    if (invalidPageUrls > 0) {
      console.log(`   ⚠️  跳过 ${invalidPageUrls} 条无效页面URL的修订记录`);
    }
    
    const duration = Date.now() - startTime;
    console.log(`   ✅ V2修订记录同步完成: ${processed} 条记录，耗时 ${Math.round(duration / 1000)}秒`);
  }

  /**
   * 备用标题同步 - V2版本使用pageId
   */
  async syncAlternateTitlesFastV2(alternateTitles) {
    if (!alternateTitles?.length) return;
    
    console.log(`🏷️  快速备用标题同步 V2: ${alternateTitles.length} 条记录`);
    const startTime = Date.now();
    
    const batchSize = 200;
    let processed = 0;
    let invalidPageUrls = 0;
    
    for (let i = 0; i < alternateTitles.length; i += batchSize) {
      const batch = alternateTitles.slice(i, i + batchSize);
      const validTitles = [];
      
      for (const altTitle of batch) {
        const pageId = this.pageIdMap.get(altTitle.pageUrl);
        if (!pageId) {
          invalidPageUrls++;
          continue;
        }
        
        validTitles.push({
          pageId: pageId,
          type: altTitle.type || 'alternate', // 提供默认值
          title: altTitle.title
        });
      }
      
      if (validTitles.length > 0) {
        try {
          await this.prisma.alternateTitle.createMany({
            data: validTitles,
            skipDuplicates: true
          });
          
          processed += validTitles.length;
        } catch (error) {
          console.error(`❌ 批量创建备用标题失败: ${error.message}`);
        }
      }
    }
    
    if (invalidPageUrls > 0) {
      console.log(`   ⚠️  跳过 ${invalidPageUrls} 条无效页面URL的备用标题`);
    }
    
    const duration = Date.now() - startTime;
    console.log(`   ✅ V2备用标题同步完成: ${processed} 条记录，耗时 ${Math.round(duration / 1000)}秒`);
  }

  /**
   * 优化的用户同步 - 批量处理，跳过复杂统计
   */
  async syncUsersFast(users) {
    console.log(`👤 快速用户同步: ${users.length} 个用户`);
    const startTime = Date.now();
    
    // 1. 批量预查询现有用户
    console.log('📋 预查询现有用户...');
    const userNames = users.map(u => u.displayName);
    const existingUsers = await this.prisma.user.findMany({
      where: { name: { in: userNames } },
      select: { name: true, lastSyncedAt: true }
    });
    
    const existingUserSet = new Set(existingUsers.map(u => u.name));
    console.log(`📋 找到 ${existingUsers.length} 个现有用户`);
    
    // 2. 分类处理
    const toCreate = [];
    const toUpdate = [];
    
    for (const userData of users) {
      const userRecord = {
        name: userData.displayName,
        wikidotId: userData.wikidotId ? String(userData.wikidotId) : null,
        displayName: userData.displayName,
        unixName: userData.unixName || null,
        // 跳过复杂统计计算，这些将在后续批量处理
        lastSyncedAt: new Date()
      };
      
      if (existingUserSet.has(userData.displayName)) {
        toUpdate.push({ name: userData.displayName, data: userRecord });
      } else {
        toCreate.push(userRecord);
      }
    }
    
    console.log(`📊 用户分类: 创建 ${toCreate.length}, 更新 ${toUpdate.length}`);
    
    // 3. 批量执行
    if (toCreate.length > 0) {
      console.log(`➕ 批量创建用户...`);
      for (let i = 0; i < toCreate.length; i += this.config.pageBatchSize) {
        const batch = toCreate.slice(i, i + this.config.pageBatchSize);
        await this.prisma.user.createMany({
          data: batch,
          skipDuplicates: true
        });
        
        if (i % (this.config.pageBatchSize * 5) === 0) {
          console.log(`   创建进度: ${Math.min(i + this.config.pageBatchSize, toCreate.length)}/${toCreate.length}`);
        }
      }
    }
    
    if (toUpdate.length > 0) {
      console.log(`🔄 批量更新用户...`);
      for (let i = 0; i < toUpdate.length; i += this.config.pageBatchSize) {
        const batch = toUpdate.slice(i, i + this.config.pageBatchSize);
        await Promise.all(
          batch.map(({ name, data }) =>
            this.prisma.user.update({ where: { name }, data })
          )
        );
        
        if (i % (this.config.pageBatchSize * 5) === 0) {
          console.log(`   更新进度: ${Math.min(i + this.config.pageBatchSize, toUpdate.length)}/${toUpdate.length}`);
        }
      }
    }
    
    this.stats.usersProcessed = toCreate.length + toUpdate.length;
    
    const duration = Date.now() - startTime;
    console.log(`✅ 快速用户同步完成: ${this.stats.usersProcessed} 用户，耗时 ${Math.round(duration / 1000)}秒`);
  }

  /**
   * 快速用户统计更新 - 使用单个批量SQL查询
   */
  async updateUserStatisticsFast() {
    console.log('📊 快速更新用户统计...');
    const startTime = Date.now();
    
    try {
      // 使用单个原生SQL查询更新所有用户统计
      await this.prisma.$executeRawUnsafe(`
        UPDATE "User" SET 
          "pageCount" = stats.page_count,
          "totalRating" = stats.total_rating,
          "meanRating" = CASE 
            WHEN stats.page_count > 0 THEN stats.total_rating::float / stats.page_count 
            ELSE 0 
          END,
          "pageCountScp" = stats.scp_count,
          "pageCountTale" = stats.tale_count,
          "pageCountGoiFormat" = stats.goi_count,
          "lastAnalyzedAt" = NOW()
        FROM (
          SELECT 
            p."createdByUser" as user_name,
            COUNT(*) as page_count,
            COALESCE(SUM(p.rating), 0) as total_rating,
            COUNT(*) FILTER (WHERE p.category = 'scp' OR p.url LIKE '%/scp-%') as scp_count,
            COUNT(*) FILTER (WHERE p.category = 'tale' OR p.url LIKE '%/tale-%') as tale_count,
            COUNT(*) FILTER (WHERE p.category = 'goi-format' OR p.url LIKE '%/goi-%') as goi_count
          FROM "Page" p
          WHERE p."isDeleted" = false 
            AND p."createdByUser" IS NOT NULL
            AND p."createdByUser" != ''
          GROUP BY p."createdByUser"
        ) as stats
        WHERE "User".name = stats.user_name
      `);
      
      // 获取更新的用户数量
      const updatedCount = await this.prisma.user.count({
        where: {
          lastAnalyzedAt: {
            gte: new Date(startTime)
          }
        }
      });
      
      const duration = Date.now() - startTime;
      console.log(`✅ 快速用户统计更新完成: ${updatedCount} 用户，耗时 ${Math.round(duration / 1000)}秒`);
      
    } catch (error) {
      console.error(`❌ 用户统计更新失败: ${error.message}`);
      this.stats.errors.push({
        type: 'user_stats_fast_error',
        error: error.message,
        timestamp: new Date()
      });
    }
  }

  /**
   * 重写主同步方法，使用快速版本
   */
  async syncFromDataFile(dataFilePath) {
    console.log('📥 快速数据文件同步开始...');
    
    const rawData = fs.readFileSync(dataFilePath, 'utf8');
    const data = JSON.parse(rawData);
    
    console.log(`📊 数据文件统计:`);
    console.log(`   页面数: ${data.pages?.length || 0}`);
    console.log(`   投票记录: ${data.voteRecords?.length || 0}`);
    console.log(`   用户数: ${data.users?.length || 0}`);
    console.log(`   修订记录: ${data.revisions?.length || 0}`);
    console.log(`   贡献记录: ${data.attributions?.length || 0}`);
    
    // 使用快速版本同步
    if (data.pages) {
      await this.syncPagesFast(data.pages);
    }
    
    if (data.users) {
      await this.syncUsersFast(data.users); // 使用快速版本
    }
    
    if (data.voteRecords) {
      await this.syncVoteRecordsFast(data.voteRecords);
    }
    
    if (data.revisions) {
      await this.syncRevisionsFastV2(data.revisions); // 使用V2适配方法
    }
    
    if (data.attributions) {
      await this.syncAttributionsFast(data.attributions);
    }
    
    if (data.alternateTitles) {
      await this.syncAlternateTitlesFastV2(data.alternateTitles); // 使用V2适配方法
    }
    
    // 显示批处理统计
    console.log('\n📊 快速同步批处理统计:');
    console.log(`   预加载页面: ${this.batchStats.pagesPreloaded}`);
    console.log(`   批处理页面: ${this.batchStats.pagesBatched}`);
    console.log(`   批处理投票: ${this.batchStats.votesBatched}`);
    console.log(`   批处理贡献: ${this.batchStats.attributionsBatched}`);
  }

  /**
   * 重写同步流程，添加快速用户统计更新
   */
  async runDatabaseSync() {
    console.log('🗄️  SCPPER-CN 快速数据库同步开始');
    console.log('='.repeat(80));
    console.log(`📅 开始时间: ${new Date().toLocaleString()}`);
    console.log(`🎯 目标站点: ${this.config.targetSiteUrl}`);
    console.log(`📡 API版本: v2 (https://apiv2.crom.avn.sh/graphql)`);
    console.log('');
    
    this.stats.startTime = new Date();
    
    try {
      // 0. 强制重置数据库（如果启用）
      if (this.config.forceReset) {
        await this.forceDatabaseReset();
      }
      
      // 1. 记录同步开始
      const syncLog = await this.createSyncLog();
      
      // 2. 获取现有页面列表用于删除检测（强制重置时跳过）
      if (this.config.checkDeletions && !this.config.forceReset) {
        await this.loadExistingPages();
      }
      
      // 3. 从最新的v2数据文件加载数据（使用快速版本）
      const dataFilePath = await this.findLatestDataFile();
      if (dataFilePath) {
        await this.syncFromDataFile(dataFilePath);
      }
      
      // 4. 检测并处理删除的页面（强制重置时跳过）
      if (this.config.checkDeletions && !this.config.forceReset) {
        await this.handleDeletedPages();
      }
      
      // 5. 使用快速版本更新用户统计
      await this.updateUserStatisticsFast();
      
      // 6. 更新用户排名
      await this.updateUserRankings();
      
      // 7-9. 分析功能（可选跳过以加速同步）
      if (!this.config.skipAnalysis) {
        console.log('🔬 开始数据分析（可通过--force跳过以加速）...');
        
        // 7. 分析用户投票关系
        await this.analyzeUserVoteRelations();
        
        // 8. 分析用户数据（joinTime、活跃用户）
        await this.analyzeUserData();
        
        // 9. 分析页面数据（威尔逊置信区间）
        await this.analyzePageData();
        
        // 10. 建立源代码版本控制
        await this.establishSourceVersionControl();
      } else {
        console.log('⚡ 跳过数据分析以加速同步');
      }
      
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

  /**
   * 构建V2版本的页面记录
   */
  buildPageRecordV2(pageData, instanceVersion, sourceHash) {
    return {
      url: pageData.url,
      instanceVersion: instanceVersion,
      urlInstanceId: `${pageData.url}#${instanceVersion}`,
      wikidotId: pageData.wikidotId,
      title: pageData.title || 'Untitled',
      category: pageData.category,
      source: pageData.source,
      textContent: pageData.textContent,
      sourceHash: sourceHash,
      contentLength: pageData.source ? pageData.source.length : 0,
      rating: pageData.rating || 0,
      voteCount: pageData.voteCount || 0,
      commentCount: pageData.commentCount || 0,
      revisionCount: pageData.revisionCount || 0,
      lastRevisionCount: pageData.lastRevisionCount || 0,
      createdByUser: pageData.createdByUser,
      createdByWikidotId: pageData.createdByWikidotId,
      lastEditedByUser: pageData.lastEditedByUser,
      parentUrl: pageData.parentUrl,
      thumbnailUrl: pageData.thumbnailUrl,
      tags: pageData.tags || [],
      isPrivate: pageData.isPrivate || false,
      isDeleted: false,
      instanceCreatedAt: new Date(),
      createdAt: pageData.createdAt ? new Date(pageData.createdAt) : null,
      lastEditedAt: pageData.lastEditedAt ? new Date(pageData.lastEditedAt) : null,
      lastSyncedAt: new Date()
    };
  }

  /**
   * 判断是否需要创建新的页面实例
   * 修复：仅在源代码实际变化时创建新实例，评分和投票数变化只需更新现有实例
   */
  shouldCreateNewInstance(existingPage, newPageData, newSourceHash) {
    // 只有源代码hash真正不同时，才需要创建新实例
    if (existingPage.sourceHash !== newSourceHash && newSourceHash !== null) {
      return true;
    }
    
    // 不再因为评分或投票数变化创建新实例
    // 这些统计数据的更新应该使用现有实例的更新操作
    
    return false;
  }

  /**
   * 创建V2版本的页面历史记录
   */
  async createPageHistoryV2(pageId, changeType, changeReason) {
    try {
      const page = await this.prisma.page.findUnique({
        where: { id: pageId },
        select: {
          title: true,
          rating: true,
          voteCount: true,
          commentCount: true,
          revisionCount: true,
          tags: true,
          source: true,
          textContent: true,
          sourceHash: true,
          instanceVersion: true,
          isDeleted: true
        }
      });
      
      if (page) {
        await this.prisma.pageHistory.create({
          data: {
            pageId: pageId,
            versionNumber: page.instanceVersion,
            changeType: changeType,
            changeReason: changeReason,
            title: page.title,
            rating: page.rating,
            voteCount: page.voteCount,
            commentCount: page.commentCount,
            revisionCount: page.revisionCount,
            tags: page.tags,
            sourceSnapshot: page.source,
            textSnapshot: page.textContent,
            sourceHash: page.sourceHash,
            instanceVersion: page.instanceVersion,
            isDeleted: page.isDeleted
          }
        });
      }
    } catch (error) {
      console.error(`❌ 创建页面历史记录失败: ${error.message}`);
    }
  }

  /**
   * 更新URL映射表
   */
  async updateUrlMappings() {
    console.log('🗺️  更新URL映射表...');
    
    // 获取所有活跃页面的最新实例
    const activePages = await this.prisma.page.findMany({
      where: { isDeleted: false },
      select: { 
        id: true, 
        url: true, 
        instanceVersion: true 
      }
    });
    
    // 按URL分组，找到每个URL的最新实例
    const urlLatestMap = new Map();
    activePages.forEach(page => {
      const current = urlLatestMap.get(page.url);
      if (!current || page.instanceVersion > current.instanceVersion) {
        urlLatestMap.set(page.url, page);
      }
    });
    
    // 批量更新/创建URL映射
    for (const [url, page] of urlLatestMap) {
      const totalInstances = await this.prisma.page.count({
        where: { url }
      });
      
      await this.prisma.urlMapping.upsert({
        where: { url: url },
        update: {
          currentPageId: page.id,
          currentInstanceVersion: page.instanceVersion,
          lastUpdatedAt: new Date(),
          totalInstances: totalInstances
        },
        create: {
          url: url,
          currentPageId: page.id,
          currentInstanceVersion: page.instanceVersion,
          lastUpdatedAt: new Date(),
          totalInstances: totalInstances
        }
      });
    }
    
    console.log(`   ✅ URL映射更新完成: ${urlLatestMap.size} 个映射`);
  }

  buildPageRecord(pageData) {
    return {
      url: pageData.url,
      wikidotId: pageData.wikidotId,
      title: pageData.title,
      category: pageData.category,
      rating: pageData.rating || 0,
      voteCount: pageData.voteCount || 0,
      createdAt: pageData.createdAt ? new Date(pageData.createdAt) : null,
      lastEditedAt: pageData.lastEditedAt ? new Date(pageData.lastEditedAt) : null,
      createdByUser: pageData.createdByUser,
      lastEditedByUser: pageData.lastEditedByUser,
      tags: pageData.tags || [],
      isDeleted: false,
      lastSyncedAt: new Date(),
      lastRevisionCount: pageData.revisionCount || 0
    };
  }

  /**
   * 建立源代码版本控制
   */
  async establishSourceVersionControl() {
    console.log('🔗 建立源代码版本控制...');
    
    try {
      // 1. 确保必要的表结构存在
      await this.sourceVersionManager.ensureSourceVersionTable();
      await this.sourceVersionManager.ensureRevisionSourceVersionLink();
      
      // 2. 准备页面和revision数据
      const pagesWithRevisions = await this.collectPagesWithRevisions();
      
      if (pagesWithRevisions.length === 0) {
        console.log('   ⚠️  没有发现需要建立版本控制的页面');
        return;
      }
      
      // 3. 批量建立源代码版本控制
      await this.sourceVersionManager.batchEstablishSourceVersioning(pagesWithRevisions);
      
      console.log('✅ 源代码版本控制建立完成');
      
    } catch (error) {
      console.error(`❌ 建立源代码版本控制失败: ${error.message}`);
      // 不抛出错误，允许同步继续进行
    }
  }

  /**
   * 收集需要建立版本控制的页面及其revision数据
   */
  async collectPagesWithRevisions() {
    console.log('   📋 收集页面和revision数据...');
    
    // 获取所有有revision的页面（不管是否有源代码）
    const pagesWithRevisions = await this.prisma.page.findMany({
      where: {
        revisions: { some: {} },  // 只要有revision就处理
        instanceDeletedAt: null  // 只处理活跃页面
      },
      select: {
        id: true,
        url: true,
        source: true,
        revisions: {
          select: {
            revisionIndex: true,
            timestamp: true,
            userWikidotId: true,
            userName: true,
            type: true,
            comment: true
          },
          orderBy: { timestamp: 'asc' }
        }
      }
    });
    
    // 转换数据格式以匹配 SourceVersionManager 的期望
    // 注意：现在包括所有有revision的页面，不管是否有源代码
    const processablePages = pagesWithRevisions
      .filter(page => page.revisions.length > 0)  // 只要有revision就处理
      .map(page => ({
        pageData: {
          id: page.id,
          url: page.url,
          source: page.source
        },
        revisions: page.revisions.map(rev => ({
          pageUrl: page.url,
          revisionId: rev.revisionIndex.toString(),
          timestamp: rev.timestamp.toISOString(),
          userWikidotId: rev.userWikidotId,
          userName: rev.userName,
          type: rev.type,
          comment: rev.comment
        }))
      }));
    
    console.log(`   找到 ${processablePages.length} 个页面需要建立版本控制`);
    
    return processablePages;
  }

  /**
   * 强制重置数据库 - 清空所有表进行全量同步
   */
  async forceDatabaseReset() {
    console.log('🗑️  强制重置数据库...');
    console.log('⚠️  警告：这将清空所有数据表！');
    
    const startTime = Date.now();
    
    try {
      // 按依赖关系顺序删除数据
      console.log('   清空关联数据表...');
      await this.prisma.userVoteRelation.deleteMany({});
      await this.prisma.pageHistory.deleteMany({});
      await this.prisma.sourceVersion.deleteMany({});
      await this.prisma.urlMapping.deleteMany({});
      
      console.log('   清空业务数据表...');
      await this.prisma.alternateTitle.deleteMany({});
      await this.prisma.attribution.deleteMany({});
      await this.prisma.revision.deleteMany({});
      await this.prisma.voteRecord.deleteMany({});
      
      console.log('   清空核心数据表...');
      await this.prisma.page.deleteMany({});
      await this.prisma.user.deleteMany({});
      
      console.log('   重置序列...');
      await this.prisma.$executeRawUnsafe('ALTER SEQUENCE "Page_id_seq" RESTART WITH 1');
      await this.prisma.$executeRawUnsafe('ALTER SEQUENCE "PageHistory_id_seq" RESTART WITH 1');
      
      const duration = Date.now() - startTime;
      console.log(`✅ 数据库重置完成，耗时 ${Math.round(duration / 1000)}秒`);
      console.log('');
      
    } catch (error) {
      console.error('❌ 数据库重置失败:', error.message);
      throw error;
    }
  }
}

export { FastDatabaseSync };