import { PrismaClient } from '@prisma/client';
import { Logger } from '../../utils/Logger.js';
import { SourceVersionService } from '../../services/SourceVersionService.js';
import { shouldCreateNewVersion } from './versionRules.js';
import { AttributionService } from './AttributionService.js';
import { PageVersionImageService } from '../../services/PageVersionImageService.js';

/**
 * 页面版本操作存储类
 * 负责PageVersion表的操作
 */
export class PageVersionStore {
  private sourceVersionService: SourceVersionService;
  private attributionService: AttributionService;
  private pageVersionImageService: PageVersionImageService;

  constructor(private prisma: PrismaClient) {
    this.sourceVersionService = new SourceVersionService(prisma);
    this.attributionService = new AttributionService(prisma);
    this.pageVersionImageService = new PageVersionImageService(prisma);
  }

  /**
   * 更新页面内容（Phase B）
   */
  async upsertPageContent(data: any) {
    if (!data.wikidotId) {
      Logger.error('wikidotId is required for Phase B');
      return;
    }

    let page = await this.prisma.page.findUnique({
      where: { wikidotId: parseInt(data.wikidotId) },
      include: {
        versions: {
          where: { validTo: null },
          orderBy: { validFrom: 'desc' },
          take: 1
        }
      }
    });

    if (!page) {
      // Auto-create page entity if missing (new page flow)
      Logger.warn(`Page with wikidotId ${data.wikidotId} not found. Creating a new page entity.`);
      try {
        page = await this.prisma.page.create({
          data: {
            wikidotId: parseInt(data.wikidotId),
            url: data.url,
            currentUrl: data.url,
            urlHistory: data.url ? [data.url] : [],
            isDeleted: false,
            firstPublishedAt: data.createdAt ? new Date(data.createdAt) : new Date()
          },
          include: {
            versions: {
              where: { validTo: null },
              orderBy: { validFrom: 'desc' },
              take: 1
            }
          }
        });
      } catch (e) {
        Logger.error(`Failed to auto-create page for wikidotId ${data.wikidotId}`, e as any);
        return;
      }
    }

    const currentVersion = page.versions[0];
    let targetVersionId: number;
    if (!currentVersion) {
      // No current version exists yet (brand new page)
      const newVersion = await this.createNewVersion(page.id, null, data);
      targetVersionId = newVersion.id;
    } else {
      const needsNewVersion = shouldCreateNewVersion(currentVersion, data);
      if (needsNewVersion) {
        const newVersion = await this.createNewVersion(page.id, currentVersion, data);
        targetVersionId = newVersion.id;
      } else {
        // Always update rating and revisionCount regardless of whether they changed
        await this.updateExistingVersion(currentVersion.id, data, true);
        targetVersionId = currentVersion.id;
      }
    }

    // 处理source版本管理
    if (data.source) {
      await this.sourceVersionService.manageSourceVersion(
        targetVersionId,
        {
          source: data.source,
          textContent: data.textContent
        }
      );
    }

    if (typeof data.source === 'string') {
      await this.pageVersionImageService.syncPageVersionImages(targetVersionId, data.source);
    }

    // 处理归属
    if (data.attributions) {
      await this.attributionService.importAttributions(targetVersionId, data.attributions);
    }
    
    // 处理投票和修订数据 (Phase B 也要保存获取到的数据)
    if (data.fuzzyVoteRecords || data.revisions) {
      const VoteRevisionStore = await import('./VoteRevisionStore.js');
      const voteRevisionStore = new VoteRevisionStore.VoteRevisionStore(this.prisma);
      await voteRevisionStore.importVotesAndRevisions(targetVersionId, {
        votes: data.fuzzyVoteRecords,
        revisions: data.revisions
      });
    }
  }

  /**
   * 判断是否需要创建新版本
   */
  // Rule implemented in versionRules.ts

  /**
   * 创建新版本
   */
  private async createNewVersion(pageId: number, currentVersion: any, data: any) {
    return await this.prisma.$transaction(async (tx) => {
      // 结束当前版本
      if (currentVersion) {
        await tx.pageVersion.update({
          where: { id: currentVersion.id },
          data: { validTo: new Date() }
        });
      }

      // 创建新版本
      const newVersion = await tx.pageVersion.create({
        data: {
          pageId: pageId,
          wikidotId: data.wikidotId ? parseInt(data.wikidotId) : null,
          title: data.title || 'Untitled',
          source: data.source || null,
          textContent: data.textContent || null,
          rating: data.rating ?? null,
          voteCount: data.voteCount ?? null,
          revisionCount: data.revisionCount ?? null,
          commentCount: data.commentCount ?? null,
          attributionCount: data.attributions?.length ?? null,
          tags: data.tags || [],
          category: data.category ?? null,
          isDeleted: data.isDeleted || false,
          validFrom: new Date(),
          validTo: null,
          createdAt: new Date(),
          updatedAt: new Date()
        }
      });

      Logger.info(`✅ Created new version for page ${pageId}`);
      return newVersion;
    });
  }

  /**
   * 更新现有版本
   */
  private async updateExistingVersion(versionId: number, data: any, forceUpdateStats: boolean = false) {
    const updateData: any = {
      // 元数据字段
      title: data.title ?? undefined,
      tags: data.tags ?? undefined,
      category: data.category ?? undefined,
      // 内容字段
      source: data.source ?? undefined,
      textContent: data.textContent ?? undefined,
      attributionCount: data.attributions?.length ?? undefined,
      updatedAt: new Date()
    };

    // Always update rating and revisionCount when forceUpdateStats is true or when values are provided
    if (forceUpdateStats || data.rating !== undefined) {
      updateData.rating = data.rating ?? null;
    }
    if (forceUpdateStats || data.voteCount !== undefined) {
      updateData.voteCount = data.voteCount ?? null;
    }
    if (forceUpdateStats || data.revisionCount !== undefined) {
      updateData.revisionCount = data.revisionCount ?? null;
    }
    if (data.commentCount !== undefined) {
      updateData.commentCount = data.commentCount ?? null;
    }
    if (data.commentCount !== undefined) {
      updateData.commentCount = data.commentCount ?? null;
    }

    await this.prisma.pageVersion.update({
      where: { id: versionId },
      data: updateData
    });

    Logger.debug(`📝 Updated existing version ${versionId} with content and metadata${forceUpdateStats ? ' (forced stats update)' : ''}`);
  }

  // Attribution import moved to AttributionService

  /**
   * 比较两个数组是否相等
   */
  private arraysEqual(a: any[], b: any[]): boolean {
    if (!a || !b) return !a && !b;
    if (a.length !== b.length) return false;
    return a.every((val, index) => val === b[index]);
  }
}
