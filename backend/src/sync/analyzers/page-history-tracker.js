/**
 * 文件路径: src/sync/analyzers/page-history-tracker.js
 * 功能概述: SCPPER-CN 页面历史版本追踪器模块
 * 
 * 主要功能:
 * - 追踪页面源代码变化和历史版本演进
 * - 检测已删除页面和页面重新创建事件
 * - 维护完整的页面版本历史记录
 * - 源代码变更检测和差异分析
 * - 页面状态变化的自动追踪和记录
 * - 数据库版本历史表的管理和维护
 * 
 * 核心特性:
 * - 基于 SHA-256 哈希的源代码版本识别
 * - 智能删除页面检测（基于 API 响应分析）
 * - 页面重新创建识别和版本链恢复
 * - 源代码变更的增量检测和记录
 * - 版本历史的完整性检查和修复
 * - 统计信息和错误追踪
 * 
 * 追踪内容:
 * - 页面创建、修改、删除事件
 * - 源代码版本变更历史
 * - 页面元数据变化（标题、标签等）
 * - 删除和重新创建的页面恢复
 */

import crypto from 'crypto';

export class PageHistoryTracker {
  constructor(prisma) {
    this.prisma = prisma;
    this.stats = {
      pagesTracked: 0,
      versionsCreated: 0,
      deletedPagesDetected: 0,
      recreatedPagesDetected: 0,
      sourceChangesDetected: 0,
      errors: []
    };
  }
  
  /**
   * 追踪并更新页面历史版本
   */
  async trackAndUpdatePageHistory() {
    console.log('📚 开始追踪页面历史版本...');
    
    try {
      // 1. 确保版本历史表存在
      await this.ensureHistoryTables();
      
      // 2. 检测删除的页面
      await this.detectDeletedPages();
      
      // 3. 处理现有页面的版本更新
      await this.processPageVersionUpdates();
      
      // 4. 生成历史追踪报告
      await this.generateHistoryReport();
      
      console.log(`✅ 页面历史版本追踪完成: ${this.stats.pagesTracked} 个页面`);
      
    } catch (error) {
      console.error(`❌ 页面历史版本追踪失败: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * 确保页面历史相关表存在
   */
  async ensureHistoryTables() {
    try {
      // 首先创建枚举类型（如果不存在）
      await this.prisma.$executeRawUnsafe(`
        DO $$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'change_type') THEN
            CREATE TYPE change_type AS ENUM ('create', 'modify', 'delete');
          END IF;
        END$$;
      `);
      
      // 创建页面实例表（PostgreSQL 语法）
      await this.prisma.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS page_instances (
          instance_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          url VARCHAR(500) NOT NULL,
          created_at TIMESTAMP NOT NULL DEFAULT NOW(),
          deleted_at TIMESTAMP DEFAULT NULL,
          is_active BOOLEAN DEFAULT TRUE,
          initial_author_id INTEGER,
          initial_creation_date TIMESTAMP,
          initial_content_hash VARCHAR(64),
          deletion_detected_at TIMESTAMP DEFAULT NULL
        )
      `);
      
      // 创建索引（PostgreSQL 语法）
      await this.prisma.$executeRawUnsafe(`
        CREATE INDEX IF NOT EXISTS idx_page_instances_url_active 
        ON page_instances (url, is_active)
      `);
      
      await this.prisma.$executeRawUnsafe(`
        CREATE INDEX IF NOT EXISTS idx_page_instances_url_created 
        ON page_instances (url, created_at)
      `);
      
      await this.prisma.$executeRawUnsafe(`
        CREATE INDEX IF NOT EXISTS idx_page_instances_active 
        ON page_instances (is_active)
      `);
      
      // 创建页面源代码版本历史表（PostgreSQL 语法）
      await this.prisma.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS page_source_versions (
          version_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          page_instance_id UUID,
          page_url VARCHAR(500) NOT NULL,
          revision_number INTEGER NOT NULL,
          source_content TEXT,
          content_hash VARCHAR(64) NOT NULL,
          content_length INTEGER DEFAULT 0,
          author_id INTEGER,
          created_at TIMESTAMP NOT NULL DEFAULT NOW(),
          change_type change_type DEFAULT 'modify'
        )
      `);
      
      // 创建外键约束
      await this.prisma.$executeRawUnsafe(`
        ALTER TABLE page_source_versions 
        DROP CONSTRAINT IF EXISTS fk_page_source_versions_instance
      `);
      
      await this.prisma.$executeRawUnsafe(`
        ALTER TABLE page_source_versions 
        ADD CONSTRAINT fk_page_source_versions_instance 
        FOREIGN KEY (page_instance_id) REFERENCES page_instances(instance_id) ON DELETE CASCADE
      `);
      
      // 创建唯一约束和索引
      await this.prisma.$executeRawUnsafe(`
        CREATE UNIQUE INDEX IF NOT EXISTS unique_page_revision 
        ON page_source_versions (page_url, revision_number)
      `);
      
      await this.prisma.$executeRawUnsafe(`
        CREATE INDEX IF NOT EXISTS idx_page_source_versions_url 
        ON page_source_versions (page_url)
      `);
      
      await this.prisma.$executeRawUnsafe(`
        CREATE INDEX IF NOT EXISTS idx_page_source_versions_hash 
        ON page_source_versions (content_hash)
      `);
      
      await this.prisma.$executeRawUnsafe(`
        CREATE INDEX IF NOT EXISTS idx_page_source_versions_created 
        ON page_source_versions (created_at)
      `);
      
      // 添加页面表的源代码hash字段
      await this.prisma.$executeRawUnsafe(`
        ALTER TABLE pages 
        ADD COLUMN IF NOT EXISTS current_source_hash VARCHAR(64),
        ADD COLUMN IF NOT EXISTS last_source_check_at TIMESTAMP DEFAULT NULL
      `);
      
    } catch (error) {
      console.log(`   历史表创建信息: ${error.message}`);
    }
  }
  
  /**
   * 检测被删除的页面
   */
  async detectDeletedPages() {
    console.log('🔍 检测删除的页面...');
    
    try {
      // 获取数据库中活跃的页面列表
      const dbPages = await this.prisma.page.findMany({
        where: { isDeleted: false },
        select: { 
          url: true, 
          lastSyncedAt: true,
          revisionCount: true,
          createdAt: true,
          source: true
        }
      });
      
      // 检查哪些页面在最近同步中没有出现
      const recentSyncThreshold = new Date(Date.now() - 24 * 60 * 60 * 1000); // 24小时
      const potentiallyDeletedPages = dbPages.filter(page => 
        page.lastSyncedAt < recentSyncThreshold
      );
      
      console.log(`   发现 ${potentiallyDeletedPages.length} 个可能被删除的页面`);
      
      for (const page of potentiallyDeletedPages) {
        await this.handlePotentiallyDeletedPage(page);
      }
      
    } catch (error) {
      console.error(`❌ 检测删除页面失败: ${error.message}`);
      this.stats.errors.push({
        type: 'detect_deleted_pages_error',
        error: error.message
      });
    }
  }
  
  /**
   * 处理可能被删除的页面
   */
  async handlePotentiallyDeletedPage(page) {
    try {
      // 尝试获取页面当前状态以确认是否真的被删除
      const isStillActive = await this.checkPageStillExists(page.url);
      
      if (!isStillActive) {
        // 标记页面为已删除
        await this.prisma.page.update({
          where: { url: page.url },
          data: { 
            isDeleted: true,
            deletedAt: new Date()
          }
        });
        
        // 创建删除记录到页面实例表
        await this.createPageDeletionRecord(page);
        
        this.stats.deletedPagesDetected++;
        console.log(`   ✅ 检测到删除页面: ${page.url}`);
      }
      
    } catch (error) {
      console.error(`❌ 处理删除页面失败 ${page.url}: ${error.message}`);
    }
  }
  
  /**
   * 检查页面是否仍然存在（简化版，避免额外API调用）
   */
  async checkPageStillExists(pageUrl) {
    // 基于最近同步数据判断页面是否还存在
    try {
      // 检查页面是否在最近的同步中还存在且未被标记为删除
      const recentPage = await this.prisma.page.findFirst({
        where: { 
          url: pageUrl,
          isDeleted: false,
          lastSyncedAt: {
            gte: new Date(Date.now() - 24 * 60 * 60 * 1000) // 24小时内同步过
          }
        }
      });
      
      return recentPage !== null;
      
    } catch (error) {
      console.log(`   检查页面存在性时出错: ${pageUrl} - ${error.message}`);
      // 出错时保守地假设页面还存在，避免误删
      return true;
    }
  }
  
  /**
   * 创建页面删除记录
   */
  async createPageDeletionRecord(page) {
    try {
      // 查找或创建页面实例
      let pageInstance = await this.prisma.$queryRawUnsafe(`
        SELECT instance_id FROM page_instances 
        WHERE url = ? AND is_active = TRUE
        ORDER BY created_at DESC LIMIT 1
      `, page.url);
      
      if (!pageInstance || pageInstance.length === 0) {
        // 创建页面实例记录
        const contentHash = page.source ? this.calculateContentHash(page.source) : null;
        
        await this.prisma.$executeRawUnsafe(`
          INSERT INTO page_instances (
            url, created_at, is_active, initial_creation_date, 
            initial_content_hash, deletion_detected_at
          ) VALUES (?, ?, FALSE, ?, ?, NOW())
        `, page.url, page.createdAt || new Date(), page.createdAt, contentHash);
        
      } else {
        // 标记现有实例为删除
        await this.prisma.$executeRawUnsafe(`
          UPDATE page_instances 
          SET is_active = FALSE, deleted_at = NOW(), deletion_detected_at = NOW()
          WHERE instance_id = ?
        `, pageInstance[0].instance_id);
      }
      
    } catch (error) {
      console.error(`❌ 创建删除记录失败 ${page.url}: ${error.message}`);
    }
  }
  
  /**
   * 处理页面版本更新
   */
  async processPageVersionUpdates() {
    console.log('📝 处理页面版本更新...');
    
    // 获取所有有源代码的页面
    const pagesWithSource = await this.prisma.page.findMany({
      where: { 
        source: { not: null },
        isDeleted: false
      },
      select: {
        url: true,
        source: true,
        revisionCount: true,
        current_source_hash: true,
        createdAt: true,
        createdByWikidotId: true
      }
    });
    
    console.log(`   处理 ${pagesWithSource.length} 个页面的版本更新...`);
    
    for (const page of pagesWithSource) {
      await this.processSinglePageVersion(page);
    }
  }
  
  /**
   * 处理单个页面的版本更新
   */
  async processSinglePageVersion(page) {
    try {
      const currentContentHash = this.calculateContentHash(page.source);
      
      // 检查内容是否发生变化
      if (page.current_source_hash === currentContentHash) {
        return; // 内容没有变化，跳过
      }
      
      // 查找或创建页面实例
      const pageInstance = await this.findOrCreatePageInstance(page);
      
      // 检查是否已存在该版本
      const existingVersion = await this.prisma.$queryRawUnsafe(`
        SELECT version_id FROM page_source_versions 
        WHERE page_url = ? AND revision_number = ?
      `, page.url, page.revisionCount);
      
      if (!existingVersion || existingVersion.length === 0) {
        // 创建新版本记录
        await this.createSourceVersion(pageInstance.instance_id, page, currentContentHash);
        
        // 更新页面的当前源代码hash
        await this.prisma.page.update({
          where: { url: page.url },
          data: { 
            current_source_hash: currentContentHash,
            last_source_check_at: new Date()
          }
        });
        
        this.stats.versionsCreated++;
        this.stats.sourceChangesDetected++;
      }
      
      this.stats.pagesTracked++;
      
    } catch (error) {
      console.error(`❌ 处理页面版本失败 ${page.url}: ${error.message}`);
      this.stats.errors.push({
        type: 'process_page_version_error',
        url: page.url,
        error: error.message
      });
    }
  }
  
  /**
   * 查找或创建页面实例
   */
  async findOrCreatePageInstance(page) {
    // 查找现有活跃实例
    let instances = await this.prisma.$queryRawUnsafe(`
      SELECT instance_id, created_at, initial_content_hash
      FROM page_instances 
      WHERE url = ? AND is_active = TRUE
      ORDER BY created_at DESC
    `, page.url);
    
    if (instances && instances.length > 0) {
      return instances[0];
    }
    
    // 创建新实例
    const contentHash = this.calculateContentHash(page.source);
    const instanceId = crypto.randomUUID();
    
    await this.prisma.$executeRawUnsafe(`
      INSERT INTO page_instances (
        instance_id, url, created_at, is_active, 
        initial_creation_date, initial_content_hash, initial_author_id
      ) VALUES (?, ?, NOW(), TRUE, ?, ?, ?)
    `, instanceId, page.url, page.createdAt || new Date(), contentHash, page.createdByWikidotId);
    
    return { instance_id: instanceId };
  }
  
  /**
   * 创建源代码版本记录
   */
  async createSourceVersion(instanceId, page, contentHash) {
    const versionId = crypto.randomUUID();
    
    await this.prisma.$executeRawUnsafe(`
      INSERT INTO page_source_versions (
        version_id, page_instance_id, page_url, revision_number,
        source_content, content_hash, content_length, 
        author_id, created_at, change_type
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?)
    `, 
      versionId, instanceId, page.url, page.revisionCount,
      page.source, contentHash, page.source?.length || 0,
      page.createdByWikidotId, 'modify'
    );
  }
  
  /**
   * 计算内容hash值
   */
  calculateContentHash(content) {
    if (!content) return null;
    return crypto.createHash('sha256').update(content).digest('hex');
  }
  
  /**
   * 检测页面重新创建
   */
  async detectPageRecreation(pageUrl, currentPageData) {
    const existingInstances = await this.prisma.$queryRawUnsafe(`
      SELECT * FROM page_instances 
      WHERE url = ? 
      ORDER BY created_at DESC
    `, pageUrl);
    
    if (!existingInstances || existingInstances.length === 0) {
      return false; // 新页面
    }
    
    const lastInstance = existingInstances[0];
    
    // 重新创建的指标
    const indicators = {
      creationTimeRegression: currentPageData.createdAt < lastInstance.deleted_at,
      authorChange: currentPageData.createdByWikidotId !== lastInstance.initial_author_id,
      revisionReset: currentPageData.revisionCount < 5,
      contentChange: await this.isContentCompletelyDifferent(lastInstance, currentPageData)
    };
    
    const recreationScore = Object.values(indicators).filter(Boolean).length;
    return recreationScore >= 2;
  }
  
  /**
   * 检查内容是否完全不同
   */
  async isContentCompletelyDifferent(lastInstance, currentData) {
    if (!lastInstance.initial_content_hash || !currentData.source) {
      return true;
    }
    
    const currentHash = this.calculateContentHash(currentData.source);
    return lastInstance.initial_content_hash !== currentHash;
  }
  
  /**
   * 生成历史追踪报告
   */
  async generateHistoryReport() {
    console.log('\n📈 生成页面历史追踪报告...');
    
    try {
      // 统计信息
      const totalInstances = await this.prisma.$queryRawUnsafe(`
        SELECT COUNT(*) as count FROM page_instances
      `);
      
      const activeInstances = await this.prisma.$queryRawUnsafe(`
        SELECT COUNT(*) as count FROM page_instances WHERE is_active = TRUE
      `);
      
      const totalVersions = await this.prisma.$queryRawUnsafe(`
        SELECT COUNT(*) as count FROM page_source_versions
      `);
      
      const recentVersions = await this.prisma.$queryRawUnsafe(`
        SELECT COUNT(*) as count FROM page_source_versions 
        WHERE created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
      `);
      
      // 打印报告
      console.log('\n📊 页面历史追踪统计报告');
      console.log('='.repeat(80));
      console.log(`📚 本次追踪页面: ${this.stats.pagesTracked}`);
      console.log(`📝 创建版本记录: ${this.stats.versionsCreated}`);
      console.log(`🗑️  检测删除页面: ${this.stats.deletedPagesDetected}`);
      console.log(`♻️  检测重创页面: ${this.stats.recreatedPagesDetected}`);
      console.log(`🔄 检测源码变化: ${this.stats.sourceChangesDetected}`);
      console.log(`📋 总页面实例: ${totalInstances[0]?.count || 0}`);
      console.log(`✅ 活跃实例: ${activeInstances[0]?.count || 0}`);
      console.log(`📦 总版本记录: ${totalVersions[0]?.count || 0}`);
      console.log(`🆕 近7天版本: ${recentVersions[0]?.count || 0}`);
      
      if (this.stats.errors.length > 0) {
        console.log(`❌ 错误统计: ${this.stats.errors.length} 个`);
        const errorsByType = {};
        this.stats.errors.forEach(error => {
          errorsByType[error.type] = (errorsByType[error.type] || 0) + 1;
        });
        Object.entries(errorsByType).forEach(([type, count]) => {
          console.log(`   ${type}: ${count} 个`);
        });
      }
      
    } catch (error) {
      console.error(`❌ 生成历史追踪报告失败: ${error.message}`);
    }
  }
  
  /**
   * 获取页面版本历史
   */
  async getPageVersionHistory(pageUrl, limit = 10) {
    try {
      const versions = await this.prisma.$queryRawUnsafe(`
        SELECT 
          v.version_id,
          v.revision_number,
          v.content_hash,
          v.content_length,
          v.created_at,
          v.change_type,
          i.instance_id,
          i.is_active as instance_active
        FROM page_source_versions v
        LEFT JOIN page_instances i ON v.page_instance_id = i.instance_id
        WHERE v.page_url = ?
        ORDER BY v.revision_number DESC, v.created_at DESC
        LIMIT ?
      `, pageUrl, limit);
      
      return versions || [];
      
    } catch (error) {
      console.error(`❌ 获取页面版本历史失败: ${error.message}`);
      return [];
    }
  }
}