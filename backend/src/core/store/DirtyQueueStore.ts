import { PrismaClient } from '@prisma/client';
import { Logger } from '../../utils/Logger.js';
import { SIMPLE_PAGE_THRESHOLD } from '../../config/RateLimitConfig.js';

/**
 * Dirty Queue存储类
 * 负责管理需要更新的页面队列
 */
export class DirtyQueueStore {
  constructor(private prisma: PrismaClient) {}

  /**
   * 创建或更新PageMetaStaging记录
   * 使用wikidotId作为主键
   */
  async upsertPageMetaStaging(meta: {
    url: string;
    wikidotId: number;
    title: string | null;
    rating: number | null;
    voteCount: number | null;
    revisionCount: number | null;
    tags: string[];
    isDeleted: boolean;
    estimatedCost: number;
    category?: string | null;
    parentUrl?: string | null;
    childCount?: number | null;
    attributionCount?: number | null;
    voteUp?: number | null;
    voteDown?: number | null;
  }) {
    if (!meta.wikidotId) {
      Logger.error('wikidotId is required for staging');
      return;
    }
    
    await this.prisma.pageMetaStaging.upsert({
      where: { wikidotId: meta.wikidotId },
      update: {
        url: meta.url,
        title: meta.title,
        rating: meta.rating,
        voteCount: meta.voteCount,
        revisionCount: meta.revisionCount,
        tags: meta.tags,
        isDeleted: meta.isDeleted,
        estimatedCost: meta.estimatedCost,
        lastSeenAt: new Date(),
        category: meta.category,
        parentUrl: meta.parentUrl,
        childCount: meta.childCount,
        attributionCount: meta.attributionCount,
        voteUp: meta.voteUp,
        voteDown: meta.voteDown
      },
      create: {
        url: meta.url,
        wikidotId: meta.wikidotId,
        title: meta.title,
        rating: meta.rating,
        voteCount: meta.voteCount,
        revisionCount: meta.revisionCount,
        tags: meta.tags,
        isDeleted: meta.isDeleted,
        estimatedCost: meta.estimatedCost,
        lastSeenAt: new Date(),
        category: meta.category,
        parentUrl: meta.parentUrl,
        childCount: meta.childCount,
        attributionCount: meta.attributionCount,
        voteUp: meta.voteUp,
        voteDown: meta.voteDown
      }
    });
  }

  /**
   * 构建Dirty Queue - 完整模式
   */
  async buildDirtyQueue() {
    Logger.info('🔍 Building dirty page queue...');
    
    // 清理旧的dirty记录
    await this.prisma.dirtyPage.deleteMany({});
    
    const stats = {
      total: 0,
      phaseB: 0,
      phaseC: 0,
      deleted: 0,
      newPages: 0,
      existingPages: 0,
      metadataChanges: 0,
      votesRevChanges: 0
    };

    // 获取所有staging记录
    const stagingPages = await this.prisma.pageMetaStaging.findMany();
    
    for (const staging of stagingPages) {
      const result = await this.processStagingPage(staging);
      
      stats.total++;
      if (result.needPhaseB) stats.phaseB++;
      if (result.needPhaseC) stats.phaseC++;
      if (result.isDeleted) stats.deleted++;
      if (result.isNew) stats.newPages++;
      else stats.existingPages++;
      if (result.hasMetadataChanges) stats.metadataChanges++;
      if (result.hasVotesRevChanges) stats.votesRevChanges++;
    }

    Logger.info(`✅ Dirty queue built: ${stats.total} pages processed`);
    Logger.info(`   - New pages: ${stats.newPages}`);
    Logger.info(`   - Existing pages: ${stats.existingPages}`);
    Logger.info(`   - Deleted pages: ${stats.deleted}`);
    Logger.info(`   - Metadata changes: ${stats.metadataChanges}`);
    Logger.info(`   - Votes/Rev changes: ${stats.votesRevChanges}`);
    
    return stats;
  }

  /**
   * 构建Dirty Queue - 测试模式
   */
  async buildDirtyQueueTestMode() {
    Logger.info('🔍 Building dirty page queue (TEST MODE)...');
    
    // 清理旧的dirty记录
    await this.prisma.dirtyPage.deleteMany({});
    
    const stats = {
      total: 0,
      phaseB: 0,
      phaseC: 0,
      deleted: 0
    };

    // 获取所有staging记录（测试模式）
    const stagingPages = await this.prisma.pageMetaStaging.findMany();
    
    for (const staging of stagingPages) {
      const result = await this.processStagingPage(staging);
      
      stats.total++;
      if (result.needPhaseB) stats.phaseB++;
      if (result.needPhaseC) stats.phaseC++;
      if (result.isDeleted) stats.deleted++;
    }

    Logger.info(`✅ Dirty queue built (TEST): ${stats.total} pages`);
    
    return stats;
  }

  /**
   * 处理单个staging页面
   */
  private async processStagingPage(staging: any) {
    const page = await this.findPageByWikidotId(staging.wikidotId);
    
    let needPhaseB = false;
    let needPhaseC = false;
    const reasons: string[] = [];
    
    const result = {
      isNew: false,
      isDeleted: staging.isDeleted,
      hasMetadataChanges: false,
      hasVotesRevChanges: false,
      needPhaseB: false,
      needPhaseC: false
    };

    if (!page) {
      // 新页面
      if (!staging.isDeleted) {
        needPhaseB = true;
        reasons.push('new_page');
        result.isNew = true;
        // 不预先设置needPhaseC，让PhaseB决定
      }
    } else {
      // 现有页面 - 检查变化
      const currentVersion = await this.getCurrentVersion(page.id);
      
      if (!currentVersion && !staging.isDeleted) {
        needPhaseB = true;
        reasons.push('no_current_version');
        // 不预先设置needPhaseC，让PhaseB决定
      } else if (staging.isDeleted && currentVersion && !currentVersion.isDeleted) {
        needPhaseB = true;
        reasons.push('page_deleted');
        result.isDeleted = true;
      } else if (currentVersion) {
        // 检查元数据变化
        const metadataChanges = this.checkMetadataChanges(currentVersion, staging);
        if (metadataChanges.length > 0) {
          needPhaseB = true;
          reasons.push(...metadataChanges);
          result.hasMetadataChanges = true;
        }
        
        // 检查投票/修订变化
        const votesRevChanges = this.checkVotesRevChanges(currentVersion, staging);
        if (votesRevChanges.length > 0) {
          // 投票/修订变化应该进入PhaseB，让PhaseB决定是否需要PhaseC
          needPhaseB = true;
          reasons.push(...votesRevChanges);
          result.hasVotesRevChanges = true;
        }
      }
    }

    // 创建dirty记录
    if (needPhaseB || needPhaseC) {
      await this.prisma.dirtyPage.create({
        data: {
          page: page?.id ? { connect: { id: page.id } } : undefined,
          stagingUrl: staging.url,
          wikidotId: staging.wikidotId,
          needPhaseB,
          needPhaseC,
          donePhaseB: false,
          donePhaseC: false,
          reasons,
          detectedAt: new Date()
        }
      });
    }

    result.needPhaseB = needPhaseB;
    result.needPhaseC = needPhaseC;
    
    return result;
  }

  /**
   * 检查元数据变化
   */
  private checkMetadataChanges(currentVersion: any, staging: any): string[] {
    const changes: string[] = [];
    
    if (currentVersion.title !== staging.title) {
      changes.push('title_changed');
    }
    
    if (currentVersion.rating !== staging.rating) {
      changes.push('rating_changed');
    }
    
    if (!this.arraysEqual(currentVersion.tags, staging.tags)) {
      changes.push('tags_changed');
    }
    
    // Special handling for category: null in DB means "_default"
    const normalizedCurrentCategory = currentVersion.category || '_default';
    const normalizedStagingCategory = staging.category || '_default';
    if (normalizedCurrentCategory !== normalizedStagingCategory) {
      changes.push('category_changed');
    }

    // attribution count change triggers Phase B to refresh attribution rows
    const currentAttrCount = currentVersion.attributionCount ?? 0;
    const stagingAttrCount = staging.attributionCount ?? 0;
    if (currentAttrCount !== stagingAttrCount) {
      changes.push('attribution_changed');
    }
    
    return changes;
  }

  /**
   * 检查投票/修订变化
   */
  private checkVotesRevChanges(currentVersion: any, staging: any): string[] {
    const changes: string[] = [];
    
    if (currentVersion.voteCount !== staging.voteCount) {
      changes.push('vote_count_changed');
    }
    
    if (currentVersion.revisionCount !== staging.revisionCount) {
      changes.push('revision_count_changed');
    }
    
    // 不再在这里判断是否需要PhaseC
    // PhaseC应该只在PhaseB无法获取所有数据时才使用
    
    return changes;
  }

  /**
   * 获取待处理的dirty页面
   */
  async fetchDirtyPages(phase: 'B' | 'C', limit = 500) {
    const needPhaseField = phase === 'B' ? 'needPhaseB' : 'needPhaseC';
    const donePhaseField = phase === 'B' ? 'donePhaseB' : 'donePhaseC';
    
    return await this.prisma.dirtyPage.findMany({
      where: {
        [needPhaseField]: true,
        [donePhaseField]: false
      },
      include: {
        page: true
      },
      take: limit,
      orderBy: [
        { pageId: 'desc' },    // 优先处理已存在的页面
        { detectedAt: 'asc' }  // 按检测时间排序
      ]
    });
  }

  /**
   * 清除dirty标记 - 使用 wikidotId
   */
  async clearDirtyFlag(wikidotId: number, phase: 'B' | 'C') {
    // 验证参数
    if (!wikidotId || typeof wikidotId !== 'number') {
      Logger.error(`Invalid wikidotId provided to clearDirtyFlag: ${wikidotId} (type: ${typeof wikidotId})`);
      return;
    }
    
    const updateField = phase === 'B' ? 'donePhaseB' : 'donePhaseC';
    
    try {
      const result = await this.prisma.dirtyPage.updateMany({
        where: { wikidotId },
        data: { [updateField]: true }
      });
      
      if (result.count === 0) {
        Logger.warn(`No dirty records found to update for wikidotId: ${wikidotId}`);
      } else {
        Logger.debug(`Cleared ${phase} flag for ${result.count} records with wikidotId: ${wikidotId}`);
      }
    } catch (error: any) {
      Logger.error(`Failed to clear dirty flag for wikidotId ${wikidotId}:`, error);
      throw error;
    }
  }

  /**
   * 清理过期的staging数据
   */
  async cleanupStagingData(olderThanHours = 24) {
    const cutoffTime = new Date();
    cutoffTime.setHours(cutoffTime.getHours() - olderThanHours);
    
    const result = await this.prisma.pageMetaStaging.deleteMany({
      where: {
        lastSeenAt: {
          lt: cutoffTime
        }
      }
    });
    
    Logger.info(`🧹 Cleaned up ${result.count} old staging records`);
  }

  /**
   * 辅助方法
   */
  private async findPageByWikidotId(wikidotId: number | null) {
    if (!wikidotId) return null;
    
    return await this.prisma.page.findUnique({
      where: { wikidotId }
    });
  }

  private async getCurrentVersion(pageId: number) {
    return await this.prisma.pageVersion.findFirst({
      where: {
        pageId,
        validTo: null
      }
    });
  }

  private arraysEqual(a: any[], b: any[]): boolean {
    if (!a || !b) return !a && !b;
    if (a.length !== b.length) return false;
    return a.every((val, index) => val === b[index]);
  }
}