import { PrismaClient, Prisma } from '@prisma/client';
import { Logger } from '../../utils/Logger.js';
import { SIMPLE_PAGE_THRESHOLD } from '../../config/RateLimitConfig.js';

type DbClient = PrismaClient | Prisma.TransactionClient;

// PostgreSQL's extended-query protocol caps a single statement at 65535 bind
// parameters (uint16). DirtyPage has ~10 columns/row, so at ~6500 rows a
// single createMany would already be at risk. Keep the per-call chunk well
// under that — 2000 rows gives a comfortable safety margin and is still one
// multi-row INSERT per chunk.
const DIRTY_PAGE_CHUNK_SIZE = 2000;
// Full-sync rebuilds can legitimately take tens of seconds, which exceeds
// Prisma's 5s default transaction timeout. Size this high enough to cover
// realistic workloads while still bounded so a stuck query surfaces.
const DIRTY_QUEUE_TX_TIMEOUT_MS = 120_000;
const DIRTY_QUEUE_TX_MAX_WAIT_MS = 10_000;

async function createDirtyPagesChunked(
  prisma: DbClient,
  rows: Prisma.DirtyPageCreateManyInput[]
): Promise<void> {
  for (let i = 0; i < rows.length; i += DIRTY_PAGE_CHUNK_SIZE) {
    await prisma.dirtyPage.createMany({
      data: rows.slice(i, i + DIRTY_PAGE_CHUNK_SIZE)
    });
  }
}

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
    commentCount: number | null;
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
        commentCount: meta.commentCount,
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
        commentCount: meta.commentCount,
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
   * Pre-load lookup maps for pages and current versions to avoid N+1 queries.
   * Returns { pageMap: wikidotId → Page, versionMap: pageId → PageVersion }.
   */
  private async preloadLookups() {
    const allPages = await this.prisma.page.findMany({
      select: { id: true, wikidotId: true, currentUrl: true }
    });
    Logger.info(`preloadLookups: loaded ${allPages.length} pages`);

    const pageMap = new Map<number, { id: number; wikidotId: number; currentUrl: string }>();
    const pageIds: number[] = [];
    for (const p of allPages) {
      pageMap.set(p.wikidotId, p);
      pageIds.push(p.id);
    }

    const currentVersions = await this.prisma.pageVersion.findMany({
      where: { pageId: { in: pageIds }, validTo: null },
      select: {
        pageId: true, isDeleted: true, title: true, rating: true,
        tags: true, category: true, attributionCount: true,
        voteCount: true, revisionCount: true
      }
    });
    Logger.info(`preloadLookups: loaded ${currentVersions.length} current versions`);

    const versionMap = new Map<number, typeof currentVersions[number]>();
    for (const v of currentVersions) {
      versionMap.set(v.pageId, v);
    }

    return { pageMap, versionMap };
  }

  /**
   * 构建Dirty Queue - 完整模式
   */
  async buildDirtyQueue() {
    Logger.info('🔍 Building dirty page queue...');

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

    const { pageMap, versionMap } = await this.preloadLookups();

    // 获取所有staging记录
    const stagingPages = await this.prisma.pageMetaStaging.findMany();

    const toCreate: Prisma.DirtyPageCreateManyInput[] = [];

    for (const staging of stagingPages) {
      const page = staging.wikidotId ? pageMap.get(staging.wikidotId) ?? null : null;
      const currentVersion = page ? versionMap.get(page.id) ?? null : null;
      const result = this.processStagingPage(staging, page, currentVersion);

      stats.total++;
      if (result.needPhaseB) stats.phaseB++;
      if (result.needPhaseC) stats.phaseC++;
      if (result.isDeleted) stats.deleted++;
      if (result.isNew) stats.newPages++;
      else stats.existingPages++;
      if (result.hasMetadataChanges) stats.metadataChanges++;
      if (result.hasVotesRevChanges) stats.votesRevChanges++;

      if (result.needPhaseB || result.needPhaseC) {
        toCreate.push({
          pageId: page?.id ?? null,
          stagingUrl: staging.url,
          wikidotId: staging.wikidotId,
          needPhaseB: result.needPhaseB,
          needPhaseC: result.needPhaseC,
          donePhaseB: false,
          donePhaseC: false,
          reasons: result.reasons,
          detectedAt: new Date()
        });
      }
    }

    // Atomic rebuild: wrap the delete + chunked inserts in a single
    // transaction so the table is never left in a partially-populated
    // intermediate state. Chunk size stays under PostgreSQL's 65535
    // bind-parameter cap; without chunking, full syncs (tens of thousands
    // of rows) would fail the insert on the driver side. Timeout is lifted
    // above the default 5s because a large rebuild can legitimately take
    // tens of seconds.
    await this.prisma.$transaction(async (tx) => {
      await tx.dirtyPage.deleteMany({});
      if (toCreate.length > 0) {
        await createDirtyPagesChunked(tx, toCreate);
      }
    }, { timeout: DIRTY_QUEUE_TX_TIMEOUT_MS, maxWait: DIRTY_QUEUE_TX_MAX_WAIT_MS });

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

    const stats = {
      total: 0,
      phaseB: 0,
      phaseC: 0,
      deleted: 0
    };

    const { pageMap, versionMap } = await this.preloadLookups();

    // 获取所有staging记录（测试模式）
    const stagingPages = await this.prisma.pageMetaStaging.findMany();

    const toCreate: Prisma.DirtyPageCreateManyInput[] = [];

    for (const staging of stagingPages) {
      const page = staging.wikidotId ? pageMap.get(staging.wikidotId) ?? null : null;
      const currentVersion = page ? versionMap.get(page.id) ?? null : null;
      const result = this.processStagingPage(staging, page, currentVersion);

      stats.total++;
      if (result.needPhaseB) stats.phaseB++;
      if (result.needPhaseC) stats.phaseC++;
      if (result.isDeleted) stats.deleted++;

      if (result.needPhaseB || result.needPhaseC) {
        toCreate.push({
          pageId: page?.id ?? null,
          stagingUrl: staging.url,
          wikidotId: staging.wikidotId,
          needPhaseB: result.needPhaseB,
          needPhaseC: result.needPhaseC,
          donePhaseB: false,
          donePhaseC: false,
          reasons: result.reasons,
          detectedAt: new Date()
        });
      }
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.dirtyPage.deleteMany({});
      if (toCreate.length > 0) {
        await createDirtyPagesChunked(tx, toCreate);
      }
    }, { timeout: DIRTY_QUEUE_TX_TIMEOUT_MS, maxWait: DIRTY_QUEUE_TX_MAX_WAIT_MS });

    Logger.info(`✅ Dirty queue built (TEST): ${stats.total} pages`);

    return stats;
  }

  /**
   * 处理单个staging页面（纯同步逻辑，使用预加载的 lookup maps）
   */
  private processStagingPage(
    staging: any,
    page: { id: number; wikidotId: number; currentUrl: string } | null,
    currentVersion: any | null
  ) {
    let needPhaseB = false;
    let needPhaseC = false;
    const reasons: string[] = [];

    const result = {
      isNew: false,
      isDeleted: staging.isDeleted,
      hasMetadataChanges: false,
      hasVotesRevChanges: false,
      needPhaseB: false,
      needPhaseC: false,
      reasons
    };

    if (!page) {
      // 新页面
      if (!staging.isDeleted) {
        needPhaseB = true;
        reasons.push('new_page');
        result.isNew = true;
      }
    } else {
      // URL 变更：当wikidotId相同但URL不同，标记进入 Phase B 以同步 Page.currentUrl
      if (staging.url && page.currentUrl && staging.url !== page.currentUrl) {
        needPhaseB = true;
        reasons.push('url_changed');
      }

      if (!currentVersion && !staging.isDeleted) {
        needPhaseB = true;
        reasons.push('no_current_version');
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
          needPhaseB = true;
          reasons.push(...votesRevChanges);
          result.hasVotesRevChanges = true;
        }
      }
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

    // commentCount should NOT trigger Phase B; update happens directly in Phase A
    // So we intentionally do NOT add a change reason for commentCount differences
    
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

    // commentCount differences should not trigger Phase B
    // Do not push any change here for commentCount
    
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
  async clearDirtyFlag(wikidotId: number, phase: 'B' | 'C', tx?: DbClient) {
    // 验证参数
    if (!wikidotId || typeof wikidotId !== 'number') {
      Logger.error(`Invalid wikidotId provided to clearDirtyFlag: ${wikidotId} (type: ${typeof wikidotId})`);
      return;
    }

    const updateField = phase === 'B' ? 'donePhaseB' : 'donePhaseC';
    const db = tx ?? this.prisma;

    try {
      const result = await db.dirtyPage.updateMany({
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
  private arraysEqual(a: any[], b: any[]): boolean {
    if (!a || !b) return !a && !b;
    if (a.length !== b.length) return false;
    return a.every((val, index) => val === b[index]);
  }
}
