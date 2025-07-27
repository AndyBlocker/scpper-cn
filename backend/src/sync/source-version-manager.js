/**
 * 文件路径: src/sync/source-version-manager.js
 * 功能概述: SCPPER-CN 源代码版本管理器模块
 * 
 * 主要功能:
 * - 维护页面源代码与 revision 的对应关系
 * - 源代码版本控制和历史追踪
 * - 基于 hash 的源代码去重和比较
 * - 页面修订历史的源代码关联
 * - 源代码变更检测和版本差异分析
 * - 数据库中源代码版本的管理和维护
 * 
 * 核心特性:
 * - SHA-256 哈希的源代码唯一标识
 * - 源代码版本与 revision 记录的双向关联
 * - 智能去重：相同源代码只存储一次
 * - 版本控制：支持源代码的历史版本追踪
 * - 增量更新：仅处理变更的源代码版本
 * 
 * 数据库表:
 * - source_versions: 存储源代码版本和内容
 * - pages.currentSourceVersionId: 当前源代码版本引用
 * - revisions.sourceVersionId: 修订对应的源代码版本
 */

import crypto from 'crypto';
export class SourceVersionManager {
  constructor(prisma) {
    this.prisma = prisma;
    this.stats = {
      sourceVersionsCreated: 0,
      revisionSourceLinked: 0,
      errors: []
    };
  }

  /**
   * 为页面建立源代码版本控制
   * @param {Object} pageData - 页面数据（包含当前sourceCode）
   * @param {Array} revisions - 该页面的所有revision记录
   */
  async establishSourceVersioning(pageData, revisions) {
    if (!pageData.source || !revisions?.length) {
      return; // 没有源代码或revision，跳过
    }

    try {
      // 1. 获取页面ID
      const page = await this.prisma.page.findFirst({
        where: {
          url: pageData.url,
          instanceDeletedAt: null
        },
        select: { id: true }
      });

      if (!page) {
        console.warn(`⚠️  未找到页面: ${pageData.url}`);
        return;
      }

      // 2. 处理源代码版本控制
      let currentSourceVersion = null;
      
      if (pageData.source) {
        // 有源代码的页面：创建源代码版本记录
        const currentSourceHash = this.calculateSourceHash(pageData.source);
        currentSourceVersion = await this.createSourceVersion({
          pageId: page.id,
          sourceCode: pageData.source,
          sourceHash: currentSourceHash,
          contentLength: pageData.source.length,
          isCurrentVersion: true,
          capturedAt: new Date()
        });
        this.stats.sourceVersionsCreated++;
      }

      // 3. 处理revision与源代码的关联
      if (currentSourceVersion) {
        // 有源代码：将revision关联到源代码版本
        await this.linkRevisionsToSourceVersion(page.id, revisions, currentSourceVersion.id);
      } else {
        // 无源代码：只更新revision记录（不关联源代码版本）
        await this.linkRevisionsWithoutSourceVersion(page.id, revisions);
      }

      this.stats.sourceVersionsCreated++;
      
    } catch (error) {
      console.error(`❌ 建立源代码版本控制失败 [${pageData.url}]: ${error.message}`);
      this.stats.errors.push({
        type: 'source_versioning_error',
        pageUrl: pageData.url,
        error: error.message
      });
    }
  }

  /**
   * 创建源代码版本记录
   */
  async createSourceVersion(versionData) {
    // 先尝试找到现有记录
    const existing = await this.prisma.sourceVersion.findFirst({
      where: {
        pageId: versionData.pageId,
        sourceHash: versionData.sourceHash
      }
    });

    if (existing) {
      // 更新现有记录
      return await this.prisma.sourceVersion.update({
        where: { id: existing.id },
        data: {
          isCurrentVersion: versionData.isCurrentVersion,
          capturedAt: versionData.capturedAt
        }
      });
    } else {
      // 创建新记录
      return await this.prisma.sourceVersion.create({
        data: versionData
      });
    }
  }

  /**
   * 将revision记录链接到源代码版本
   * 策略：
   * 1. 如果只有一个源代码版本，所有revision都链接到它
   * 2. 如果有多个版本，根据时间戳就近原则链接
   */
  async linkRevisionsToSourceVersion(pageId, revisions, currentSourceVersionId) {
    // 按时间排序revision
    const sortedRevisions = revisions
      .filter(r => r.pageUrl && r.timestamp)
      .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

    if (sortedRevisions.length === 0) return;

    // 获取该页面的所有源代码版本（按时间排序）
    const sourceVersions = await this.prisma.sourceVersion.findMany({
      where: { pageId: pageId },
      orderBy: { capturedAt: 'asc' }
    });

    if (sourceVersions.length === 0) return;

    // 策略1: 如果只有一个源代码版本，所有revision都指向它
    if (sourceVersions.length === 1) {
      const sourceVersionId = sourceVersions[0].id;
      
      for (const revision of sortedRevisions) {
        await this.updateRevisionSourceVersion(pageId, revision, sourceVersionId);
      }
      
      this.stats.revisionSourceLinked += sortedRevisions.length;
      return;
    }

    // 策略2: 多个源代码版本的情况（未来扩展）
    // 目前大多数情况下只有一个版本，先实现简单策略
    const defaultSourceVersionId = sourceVersions.find(v => v.isCurrentVersion)?.id || sourceVersions[0].id;
    
    for (const revision of sortedRevisions) {
      await this.updateRevisionSourceVersion(pageId, revision, defaultSourceVersionId);
    }
    
    this.stats.revisionSourceLinked += sortedRevisions.length;
  }

  /**
   * 更新revision记录的源代码版本关联
   */
  async updateRevisionSourceVersion(pageId, revisionData, sourceVersionId) {
    try {
      // 找到对应的revision记录并更新
      await this.prisma.revision.updateMany({
        where: {
          pageId: pageId,
          revisionIndex: parseInt(revisionData.revisionId),
          timestamp: new Date(revisionData.timestamp)
        },
        data: {
          sourceVersionId: sourceVersionId
        }
      });
    } catch (error) {
      console.error(`❌ 更新revision源代码版本失败: ${error.message}`);
    }
  }

  /**
   * 为没有源代码的页面关联revision记录
   * 这些revision不会关联到具体的源代码版本，但会被正确维护
   */
  async linkRevisionsWithoutSourceVersion(pageId, revisions) {
    if (!revisions || revisions.length === 0) return;
    
    try {
      // 对于没有源代码的页面，我们仍然需要确保revision记录存在
      // 但不关联到sourceVersionId（保持为null）
      for (const revisionData of revisions) {
        // 检查revision是否已存在，如果不存在则需要创建
        // 这里主要是确保revision记录的完整性
        await this.ensureRevisionExists(pageId, revisionData);
      }
      
      this.stats.revisionSourceLinked += revisions.length;
      
    } catch (error) {
      console.error(`❌ 处理无源代码页面的revision失败: ${error.message}`);
    }
  }

  /**
   * 确保revision记录存在（用于没有源代码的页面）
   */
  async ensureRevisionExists(pageId, revisionData) {
    try {
      // 使用upsert确保revision记录存在
      await this.prisma.revision.upsert({
        where: {
          pageId_revisionIndex: {
            pageId: pageId,
            revisionIndex: parseInt(revisionData.revisionId)
          }
        },
        update: {
          // 更新基础信息，但不更新sourceVersionId（保持现有值）
          timestamp: new Date(revisionData.timestamp),
          userWikidotId: revisionData.userWikidotId,
          userName: revisionData.userName,
          type: revisionData.type,
          comment: revisionData.comment
        },
        create: {
          pageId: pageId,
          revisionIndex: parseInt(revisionData.revisionId),
          timestamp: new Date(revisionData.timestamp),
          userWikidotId: revisionData.userWikidotId,
          userName: revisionData.userName,
          type: revisionData.type,
          comment: revisionData.comment,
          sourceVersionId: null  // 没有源代码版本关联
        }
      });
    } catch (error) {
      console.error(`❌ 确保revision存在失败: ${error.message}`);
    }
  }

  /**
   * 批量处理页面的源代码版本控制
   */
  async batchEstablishSourceVersioning(pagesWithRevisions) {
    console.log(`🔗 建立源代码版本控制: ${pagesWithRevisions.length} 个页面`);
    
    const batchSize = 50; // 控制批处理大小避免内存过载
    
    for (let i = 0; i < pagesWithRevisions.length; i += batchSize) {
      const batch = pagesWithRevisions.slice(i, i + batchSize);
      
      await Promise.all(
        batch.map(({ pageData, revisions }) => 
          this.establishSourceVersioning(pageData, revisions)
        )
      );
      
      if (i % (batchSize * 4) === 0) {
        console.log(`   处理进度: ${Math.min(i + batchSize, pagesWithRevisions.length)}/${pagesWithRevisions.length}`);
      }
    }
    
    console.log(`✅ 源代码版本控制建立完成:`);
    console.log(`   - 创建源代码版本: ${this.stats.sourceVersionsCreated}`);
    console.log(`   - 处理revision记录: ${this.stats.revisionSourceLinked}`);
    console.log(`   - 处理页面总数: ${pagesWithRevisions.length}`);
    
    if (this.stats.errors.length > 0) {
      console.log(`   - 错误数量: ${this.stats.errors.length}`);
    }
  }

  /**
   * 计算源代码哈希
   */
  calculateSourceHash(sourceCode) {
    return crypto.createHash('sha256').update(sourceCode).digest('hex');
  }

  /**
   * 确保SourceVersion表存在
   */
  async ensureSourceVersionTable() {
    try {
      await this.prisma.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS "SourceVersion" (
          id SERIAL PRIMARY KEY,
          "pageId" INTEGER NOT NULL,
          "sourceCode" TEXT NOT NULL,
          "sourceHash" VARCHAR(64) NOT NULL,
          "contentLength" INTEGER NOT NULL,
          "isCurrentVersion" BOOLEAN DEFAULT FALSE,
          "capturedAt" TIMESTAMP NOT NULL,
          "createdAt" TIMESTAMP DEFAULT NOW(),
          FOREIGN KEY ("pageId") REFERENCES "Page"(id) ON DELETE CASCADE,
          UNIQUE("pageId", "sourceHash")
        )
      `);

      await this.prisma.$executeRawUnsafe(`
        CREATE INDEX IF NOT EXISTS idx_source_version_page_id 
        ON "SourceVersion"("pageId")
      `);

      await this.prisma.$executeRawUnsafe(`
        CREATE INDEX IF NOT EXISTS idx_source_version_hash 
        ON "SourceVersion"("sourceHash")
      `);

      await this.prisma.$executeRawUnsafe(`
        CREATE INDEX IF NOT EXISTS idx_source_version_current 
        ON "SourceVersion"("pageId", "isCurrentVersion")
      `);

    } catch (error) {
      console.log(`   SourceVersion表创建信息: ${error.message}`);
    }
  }

  /**
   * 为revision表添加sourceVersionId字段
   */
  async ensureRevisionSourceVersionLink() {
    try {
      await this.prisma.$executeRawUnsafe(`
        ALTER TABLE "Revision" 
        ADD COLUMN IF NOT EXISTS "sourceVersionId" INTEGER
      `);

      await this.prisma.$executeRawUnsafe(`
        CREATE INDEX IF NOT EXISTS idx_revision_source_version 
        ON "Revision"("sourceVersionId")
      `);

    } catch (error) {
      console.log(`   Revision源代码版本链接字段信息: ${error.message}`);
    }
  }

  /**
   * 获取页面的源代码版本历史
   */
  async getPageSourceHistory(pageId) {
    return await this.prisma.sourceVersion.findMany({
      where: { pageId: pageId },
      orderBy: { capturedAt: 'desc' },
      include: {
        _count: {
          select: {
            revisions: true
          }
        }
      }
    });
  }

  /**
   * 获取特定revision的源代码
   */
  async getRevisionSourceCode(pageId, revisionIndex) {
    const revision = await this.prisma.revision.findFirst({
      where: {
        pageId: pageId,
        revisionIndex: revisionIndex
      },
      include: {
        sourceVersion: {
          select: {
            sourceCode: true,
            sourceHash: true,
            capturedAt: true
          }
        }
      }
    });

    return revision?.sourceVersion?.sourceCode;
  }
}