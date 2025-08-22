import { PrismaClient } from '@prisma/client';
import { Logger } from '../../utils/Logger.js';
import { SourceVersionService } from '../../services/SourceVersionService.js';

/**
 * 页面版本操作存储类
 * 负责PageVersion表的操作
 */
export class PageVersionStore {
  private sourceVersionService: SourceVersionService;

  constructor(private prisma: PrismaClient) {
    this.sourceVersionService = new SourceVersionService(prisma);
  }

  /**
   * 更新页面内容（Phase B）
   */
  async upsertPageContent(data: any) {
    if (!data.wikidotId) {
      Logger.error('wikidotId is required for Phase B');
      return;
    }

    const page = await this.prisma.page.findUnique({
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
      Logger.error(`Page with wikidotId ${data.wikidotId} not found`);
      return;
    }

    const currentVersion = page.versions[0];
    const needsNewVersion = this.shouldCreateNewVersion(currentVersion, data);
    let targetVersionId: number;

    if (needsNewVersion) {
      const newVersion = await this.createNewVersion(page.id, currentVersion, data);
      targetVersionId = newVersion.id;
    } else {
      // Always update rating and revisionCount regardless of whether they changed
      await this.updateExistingVersion(currentVersion.id, data, true);
      targetVersionId = currentVersion.id;
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

    // 处理归属
    if (data.attributions) {
      await this.importAttributions(targetVersionId, data.attributions);
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
  private shouldCreateNewVersion(currentVersion: any, newData: any): boolean {
    if (!currentVersion) return true;

    // 只有内容/结构层面的变化才开新版本；评分/票数属于统计快照，不触发版本
    const significantChanges = [
      currentVersion.title !== newData.title,
      currentVersion.category !== (newData.category ?? currentVersion.category),
      !this.arraysEqual(currentVersion.tags ?? [], newData.tags ?? []),
      (newData.source && newData.source !== currentVersion.source),
      (newData.textContent && newData.textContent !== currentVersion.textContent)
    ];

    return significantChanges.some(changed => changed);
  }

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

    await this.prisma.pageVersion.update({
      where: { id: versionId },
      data: updateData
    });

    Logger.debug(`📝 Updated existing version ${versionId} with content and metadata${forceUpdateStats ? ' (forced stats update)' : ''}`);
  }

  /**
   * 导入归属信息
   */
  private async importAttributions(pageVersionId: number, attributions: any[]) {
    for (const attr of attributions) {
      try {
        let userId = null;
        let anonKey = null;
        
        if (attr.user) {
          let userData = attr.user;
          
          // 如果是 UserWikidotNameReference 类型，需要访问 wikidotUser
          if (userData.wikidotUser) {
            userData = userData.wikidotUser;
          }
          
          // 如果有 wikidotId，创建/更新用户
          if (userData.wikidotId) {
            const user = await this.prisma.user.upsert({
              where: { wikidotId: parseInt(userData.wikidotId) },
              create: {
                wikidotId: parseInt(userData.wikidotId),
                displayName: userData.displayName || 'Unknown'
              },
              update: {
                displayName: userData.displayName || undefined
              }
            });
            userId = user?.id || null;
          } else if (userData.displayName) {
            // 没有 wikidotId 但有 displayName，使用 anonKey
            anonKey = `anon:${userData.displayName}`;
          }
        }

        // Try to find existing attribution
        const existingAttr = await this.prisma.attribution.findFirst({
          where: {
            pageVerId: pageVersionId,
            type: attr.type || 'unknown',
            OR: [
              { userId: userId },
              { anonKey: anonKey }
            ]
          }
        });

        if (!existingAttr) {
          await this.prisma.attribution.create({
            data: {
              pageVerId: pageVersionId,
              userId: userId,
              anonKey: anonKey,
              type: attr.type || 'unknown'
            }
          });
        } else {
          await this.prisma.attribution.update({
            where: { id: existingAttr.id },
            data: {
              userId: userId,
              anonKey: anonKey
            }
          });
        }
      } catch (error) {
        Logger.error(`Failed to import attribution for pageVersionId ${pageVersionId}:`, error);
      }
    }
  }

  /**
   * 比较两个数组是否相等
   */
  private arraysEqual(a: any[], b: any[]): boolean {
    if (!a || !b) return !a && !b;
    if (a.length !== b.length) return false;
    return a.every((val, index) => val === b[index]);
  }
}