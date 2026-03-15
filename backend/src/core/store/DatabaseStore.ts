import { PrismaClient, Prisma } from '@prisma/client';
import { Logger } from '../../utils/Logger.js';
import { getPrismaClient, disconnectPrisma } from '../../utils/db-connection.js';
import { PageStore } from './PageStore.js';
import { PageVersionStore } from './PageVersionStore.js';
import { VoteRevisionStore } from './VoteRevisionStore.js';
import { DirtyQueueStore } from './DirtyQueueStore.js';
import { SourceVersionService } from '../../services/SourceVersionService.js';
import { AttributionService } from './AttributionService.js';
import { shouldCreateNewVersion } from './versionRules.js';

export type DbClient = PrismaClient | Prisma.TransactionClient;

/**
 * 数据库存储主类
 * 协调各个专门化存储类的操作
 */
export class DatabaseStore {
  public prisma: PrismaClient;
  private pageStore: PageStore;
  private pageVersionStore: PageVersionStore;
  private voteRevisionStore: VoteRevisionStore;
  private dirtyQueueStore: DirtyQueueStore;
  private sourceVersionService: SourceVersionService;
  private attributionService: AttributionService;

  constructor() {
    this.prisma = getPrismaClient();
    this.pageStore = new PageStore(this.prisma);
    this.pageVersionStore = new PageVersionStore(this.prisma);
    this.voteRevisionStore = new VoteRevisionStore(this.prisma);
    this.dirtyQueueStore = new DirtyQueueStore(this.prisma);
    this.sourceVersionService = new SourceVersionService(this.prisma);
    this.attributionService = new AttributionService(this.prisma);
  }

  /**
   * 加载进度（用于恢复）
   */
  async loadProgress(phase = 'phase1') {
    switch (phase) {
      case 'phase1':
        return await this.prisma.page.findMany({
          include: {
            versions: {
              orderBy: { validFrom: 'desc' },
              take: 1,
            },
          },
        });
      case 'phase2':
        return await this.prisma.pageVersion.findMany({
          where: {
            validTo: null,
            textContent: { not: null },
          },
        });
      case 'phase3':
        return await this.prisma.pageVersion.findMany({
          where: {
            validTo: null,
          },
          include: {
            revisions: true,
            votes: true,
          },
        });
      default:
        return [];
    }
  }

  /**
   * 添加数据（根据阶段）
   */
  async append(phase: string, obj: any) {
    switch (phase) {
      case 'phase1':
        await this.upsertPageBasicInfo(obj);
        break;
      case 'phase2':
        await this.upsertPageContent(obj);
        break;
      case 'phase3':
        await this.upsertPageDetails(obj);
        break;
    }
  }

  /**
   * Phase A: 创建或更新页面基本信息
   */
  async upsertPageBasicInfo(data: any) {
    if (!data.wikidotId) {
      Logger.error('wikidotId is required for page processing');
      return;
    }
    
    const wikidotId = parseInt(data.wikidotId);
    Logger.info(`🔄 Processing ${data.url} (wikidotId: ${wikidotId})`);
    
    await this.prisma.$transaction(async (tx) => {
      // 查找页面（通过wikidotId）
      let page = await tx.page.findUnique({
        where: { wikidotId },
        include: {
          versions: {
            where: { validTo: null },
            take: 1
          }
        }
      });
      
      if (!page) {
        // 创建新页面
        page = await tx.page.create({
          data: {
            wikidotId,
            url: data.url,
            currentUrl: data.url,
            urlHistory: [data.url],
            isDeleted: false,
            firstPublishedAt: data.createdAt ? new Date(data.createdAt) : new Date()
          },
          include: {
            versions: {
              where: { validTo: null },
              take: 1
            }
          }
        });
        Logger.info(`✅ Created new page: ${data.url} (wikidotId: ${wikidotId})`);
      } else {
        // 更新现有页面
        if (page.currentUrl !== data.url && data.url) {
          // URL变更
          const newUrlHistory = [...new Set([...page.urlHistory, data.url])];
          await tx.page.update({
            where: { id: page.id },
            data: {
              currentUrl: data.url,
              urlHistory: newUrlHistory,
              updatedAt: new Date()
            }
          });
          Logger.info(`✅ Updated page URL: ${page.currentUrl} -> ${data.url} (wikidotId: ${wikidotId})`);
        }
      }
      
      // 处理删除状态
      if (data.isDeleted && !page.isDeleted) {
        await tx.page.update({
          where: { id: page.id },
          data: { isDeleted: true }
        });
        
        // 创建删除版本
        if (page.versions.length > 0) {
          await tx.pageVersion.update({
            where: { id: page.versions[0].id },
            data: { validTo: new Date() }
          });
        }
        
        await tx.pageVersion.create({
          data: {
            pageId: page.id,
            wikidotId,
            title: data.title || page.versions[0]?.title || 'Deleted',
            isDeleted: true,
            validFrom: new Date(),
            validTo: null,
            tags: [],
            rating: null,
            voteCount: null,
            commentCount: null
          }
        });
        
        Logger.info(`✅ Marked page as deleted: ${data.url} (wikidotId: ${wikidotId})`);
      } else if (!data.isDeleted) {
        // 创建或更新版本
        await this.updatePageVersionInTransaction(tx, page.id, data);
      }
    });
  }

  /**
   * Phase B: 更新页面内容
   */
  async upsertPageContent(data: any, tx?: DbClient) {
    // Delegate to PageVersionStore which handles version management properly
    await this.pageVersionStore.upsertPageContent(data, tx);
  }

  /**
   * Phase C: 更新页面详细信息（投票、修订、归属）
   */
  async upsertPageDetails(data: any) {
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

    if (!page || page.versions.length === 0) {
      Logger.error(`No page found for wikidotId ${data.wikidotId}`);
      return;
    }

    // Also keep Page.currentUrl in sync during Phase C when URL is present
    try {
      const incomingUrl = typeof data.url === 'string' ? data.url : '';
      if (incomingUrl && page.currentUrl !== incomingUrl) {
        const newHistory = Array.isArray(page.urlHistory)
          ? Array.from(new Set([...(page.urlHistory as string[]), page.currentUrl, incomingUrl]))
          : [page.currentUrl, incomingUrl].filter(Boolean);
        await this.prisma.page.update({
          where: { id: page.id },
          data: {
            currentUrl: incomingUrl,
            urlHistory: newHistory,
            updatedAt: new Date()
          }
        });
        Logger.info(`✅ Phase C synchronized page URL for wikidotId ${data.wikidotId}: ${page.currentUrl} -> ${incomingUrl}`);
      }
    } catch (e) {
      Logger.warn(`Phase C failed to sync URL for wikidotId ${data.wikidotId}: ${(e as any)?.message ?? e}`);
    }

    const currentVersion = page.versions[0];

    // 导入投票和修订
    await this.voteRevisionStore.importVotesAndRevisions(currentVersion.id, {
      votes: data.votes,
      revisions: data.revisions
    });

    // 处理归属（Phase C 也可能携带）
    if (data.attributions && Array.isArray(data.attributions)) {
      await this.attributionService.importAttributions(currentVersion.id, data.attributions);
    }

    Logger.debug(`✅ Updated details for wikidotId ${data.wikidotId}`);
  }

  /**
   * 更新页面版本（在事务内）
   */
  private async updatePageVersionInTransaction(tx: any, pageId: number, data: any) {
    const currentVersion = await tx.pageVersion.findFirst({
      where: {
        pageId: pageId,
        validTo: null
      }
    });

    const needsNewVersion = shouldCreateNewVersion(currentVersion, data);

    if (needsNewVersion) {
      if (currentVersion) {
        await tx.pageVersion.update({
          where: { id: currentVersion.id },
          data: { validTo: new Date() }
        });
      }

      await tx.pageVersion.create({
        data: {
          pageId: pageId,
          wikidotId: data.wikidotId ? parseInt(data.wikidotId, 10) : null,
          title: data.title || 'Untitled',
          rating: data.rating ?? null,
          voteCount: data.voteCount ?? null,
          revisionCount: data.revisionCount ?? null,
          commentCount: data.commentCount ?? null,
          tags: data.tags || [],
          category: data.category ?? null,
          attributionCount: data.attributionCount || null,
          isDeleted: false,
          validFrom: new Date(),
          validTo: null,
          createdAt: new Date(),
          updatedAt: new Date()
        }
      });

      Logger.info(`✅ Created new version for page ${pageId}`);
    }
  }

  /**
   * 更新页面版本
   */
  private async updatePageVersion(pageId: number, data: any) {
    const currentVersion = await this.prisma.pageVersion.findFirst({
      where: {
        pageId: pageId,
        validTo: null
      }
    });

    const needsNewVersion = shouldCreateNewVersion(currentVersion, data);

    if (needsNewVersion) {
      await this.prisma.$transaction(async (tx) => {
        if (currentVersion) {
          await tx.pageVersion.update({
            where: { id: currentVersion.id },
            data: { validTo: new Date() }
          });
        }

        await tx.pageVersion.create({
          data: {
            pageId: pageId,
            wikidotId: data.wikidotId ? parseInt(data.wikidotId, 10) : null,
            title: data.title || 'Untitled',
            rating: data.rating ?? null,
            voteCount: data.voteCount ?? null,
            revisionCount: data.revisionCount ?? null,
            commentCount: data.commentCount ?? null,
            tags: data.tags || [],
            category: data.category ?? null,
            attributionCount: data.attributionCount || null,
            isDeleted: false,
            validFrom: new Date(),
            validTo: null,
            createdAt: new Date(),
            updatedAt: new Date()
          }
        });
      });

      Logger.info(`✅ Created new version for page ${pageId}`);
    } else {
      // 不需要新版本时，更新快照字段
      if (!currentVersion) {
        Logger.warn(`No current version found for page ${pageId} when updating snapshot fields`);
        return;
      }
      await this.prisma.pageVersion.update({
        where: { id: currentVersion.id },
        data: {
          rating: data.rating ?? undefined,
          voteCount: data.voteCount ?? undefined,
          revisionCount: data.revisionCount ?? undefined,
          commentCount: data.commentCount ?? undefined,
          tags: data.tags ?? undefined,
          category: data.category ?? undefined,
          updatedAt: new Date()
        }
      });
    }
  }

  /**
   * 判断是否需要创建新版本
   */
  /**
   * 导入归属信息
   */
  private async importAttributions(pageVersionId: number, attributions: any[]) {
    const stats = { inserted: 0, updated: 0, errors: 0 };

    for (const attr of attributions) {
      // 不再需要 edge.node，直接使用 attr
      
      try {
        let userId = null;
        let anonKey = null;
        
        if (attr.user) {
          // 处理嵌套的用户结构
          let userData = attr.user;
          
          // 如果是 UserWikidotNameReference 类型，需要访问 wikidotUser
          if (userData.wikidotUser) {
            userData = userData.wikidotUser;
          }
          
          // 如果有 wikidotId，创建/更新用户
          if (userData.wikidotId) {
            const user = await this.upsertUser(userData);
            userId = user?.id || null;
          } else if (userData.displayName) {
            // 没有 wikidotId 但有 displayName，使用 anonKey
            // 使用 displayName 作为 anonKey
            anonKey = `anon:${userData.displayName}`;
          }
        }

        if (userId != null) {
          await this.prisma.attribution.upsert({
            where: {
              Attribution_unique_constraint: {
                pageVerId: pageVersionId,
                type: attr.type,
                order: attr.order ?? 0,
                userId: userId
              }
            },
            update: {
              date: attr.date ? new Date(attr.date) : null
            },
            create: {
              pageVerId: pageVersionId,
              userId: userId,
              type: attr.type,
              order: attr.order ?? 0,
              date: attr.date ? new Date(attr.date) : null
            }
          });
        } else if (anonKey || attr.anonKey) {
          // 使用计算出的 anonKey 或原始的 attr.anonKey
          const finalAnonKey = anonKey || attr.anonKey;
          await this.prisma.attribution.upsert({
            where: {
              Attribution_anon_unique_constraint: {
                pageVerId: pageVersionId,
                type: attr.type,
                order: attr.order ?? 0,
                anonKey: finalAnonKey
              }
            },
            update: {
              date: attr.date ? new Date(attr.date) : null
            },
            create: {
              pageVerId: pageVersionId,
              anonKey: finalAnonKey,
              type: attr.type,
              order: attr.order ?? 0,
              date: attr.date ? new Date(attr.date) : null
            }
          });
        }
        stats.inserted++;
      } catch (error) {
        stats.errors++;
        Logger.error(`Attribution import error: ${error}`);
      }
    }

    return stats;
  }

  /**
   * 创建或更新用户
   */
  private async upsertUser(userData: any): Promise<any | null> {
    if (!userData || !userData.wikidotId) {
      return null;
    }

    try {
      const user = await this.prisma.user.upsert({
        where: { wikidotId: parseInt(userData.wikidotId, 10) },
        update: {
          displayName: userData.displayName || userData.username,
          username: userData.username,
          isGuest: userData.isGuest || false
        },
        create: {
          wikidotId: parseInt(userData.wikidotId, 10),
          displayName: userData.displayName || userData.username,
          username: userData.username,
          isGuest: userData.isGuest || false
        }
      });
      return user;
    } catch (error) {
      Logger.error(`Failed to upsert user ${userData.wikidotId}: ${error}`);
      return null;
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

  // 委托给专门的存储类
  async upsertPageMetaStaging(meta: any) {
    return await this.dirtyQueueStore.upsertPageMetaStaging(meta);
  }

  async buildDirtyQueue() {
    return await this.dirtyQueueStore.buildDirtyQueue();
  }

  async buildDirtyQueueTestMode() {
    return await this.dirtyQueueStore.buildDirtyQueueTestMode();
  }

  async fetchDirtyPages(phase: 'B' | 'C', limit = 500) {
    return await this.dirtyQueueStore.fetchDirtyPages(phase, limit);
  }

  async clearDirtyFlag(wikidotId: number, phase: 'B' | 'C', tx?: DbClient) {
    return await this.dirtyQueueStore.clearDirtyFlag(wikidotId, phase, tx);
  }

  async cleanupStagingData(olderThanHours = 24) {
    return await this.dirtyQueueStore.cleanupStagingData(olderThanHours);
  }

  async findPageByIdentifier(identifier: string) {
    return await this.pageStore.findPageByIdentifier(identifier);
  }

  async markPageDeleted(pageId: number, tx?: DbClient) {
    return await this.pageStore.markPageDeleted(pageId, tx);
  }

  /**
   * 通过 wikidotId 标记页面删除（若找到 page 则调用 PageStore 以生成删除版本），并清理脏标记
   */
  async markDeletedByWikidotId(wikidotId: number, tx?: DbClient): Promise<void> {
    const db = tx ?? this.prisma;
    const existingPage = await db.page.findUnique({
      where: { wikidotId }
    });

    if (existingPage) {
      await this.markPageDeleted(existingPage.id, tx);
    } else {
      Logger.warn(`No page entity for wikidotId ${wikidotId}, marking flags cleared only`);
    }
    try {
      await this.clearDirtyFlag(wikidotId, 'B', tx);
    } catch {}
    try {
      await this.clearDirtyFlag(wikidotId, 'C', tx);
    } catch {}
  }

  /**
   * Reconcile DB pages against current staging snapshot and mark deletions.
   * - Unseen in this run: pages present in DB (not deleted) but missing in staging → mark deleted
   * - URL reused by different wikidotId: staging shows same URL but different wikidotId → mark old page deleted
   */
  async reconcileAndMarkDeletions(): Promise<{ unseenCount: number; urlReusedCount: number }> {
    const stagingCount = await this.prisma.pageMetaStaging.count();
    if (stagingCount === 0) {
      Logger.warn('Staging snapshot empty; skipping deletion reconciliation to avoid false positives');
      return { unseenCount: 0, urlReusedCount: 0 };
    }

    const unseenPages = await this.prisma.$queryRaw<Array<{ id: number; wikidotId: number; currentUrl: string }>>`
      SELECT p.id, p."wikidotId", p."currentUrl"
      FROM "Page" p
      WHERE p."isDeleted" = false
        AND (p."currentUrl" ~ '^https?://scp-wiki-cn\\.wikidot\\.com/' OR p."url" ~ '^https?://scp-wiki-cn\\.wikidot\\.com/')
        AND NOT EXISTS (
          SELECT 1 FROM "PageMetaStaging" s WHERE s."wikidotId" = p."wikidotId"
        )
    `;

    const urlReusedPages = await this.prisma.$queryRaw<Array<{ id: number; wikidotId: number; currentUrl: string; newWikidotId: number }>>`
      SELECT p.id, p."wikidotId", p."currentUrl", s."wikidotId" AS "newWikidotId"
      FROM "Page" p
      INNER JOIN "PageMetaStaging" s ON s.url = p."currentUrl"
      WHERE p."isDeleted" = false
        AND s."wikidotId" IS NOT NULL
        AND s."wikidotId" <> p."wikidotId"
    `;

    const SAFETY_DELETE_THRESHOLD = 500; // avoid mass deletions when upstream data is suspicious

    if (unseenPages.length > SAFETY_DELETE_THRESHOLD) {
      Logger.error(`Detected ${unseenPages.length} unseen pages (> ${SAFETY_DELETE_THRESHOLD}); skipping deletion reconciliation`);
      return { unseenCount: 0, urlReusedCount: 0 };
    }

    if (urlReusedPages.length > SAFETY_DELETE_THRESHOLD) {
      Logger.error(`Detected ${urlReusedPages.length} URL reuse conflicts (> ${SAFETY_DELETE_THRESHOLD}); skipping deletion reconciliation`);
      return { unseenCount: 0, urlReusedCount: 0 };
    }

    let unseenCount = 0;
    for (const row of unseenPages) {
      try {
        await this.markPageDeleted(row.id);
        unseenCount++;
      } catch (e) {
        // continue best-effort
      }
    }

    let urlReusedCount = 0;
    // Avoid double-marking by skipping those already in unseen set
    const unseenIds = new Set(unseenPages.map(r => r.id));
    for (const row of urlReusedPages) {
      if (unseenIds.has(row.id)) continue;
      try {
        await this.markPageDeleted(row.id);
        urlReusedCount++;
      } catch (e) {
        // continue best-effort
      }
    }

    return { unseenCount, urlReusedCount };
  }

  /**
   * 标记页面需要 Phase C（合并 reasons），若不存在则创建 dirtyPage
   */
  async markForPhaseC(wikidotId: number, pageId: number | null, reasons: string[], tx?: DbClient): Promise<void> {
    const db = tx ?? this.prisma;
    const existingDirtyPage = await db.dirtyPage.findFirst({
      where: { wikidotId }
    });

    const mergedReasons = Array.from(new Set([...(existingDirtyPage?.reasons || []), ...reasons]));

    if (existingDirtyPage) {
      await db.dirtyPage.update({
        where: { id: existingDirtyPage.id },
        data: {
          needPhaseC: true,
          donePhaseC: false,
          reasons: mergedReasons
        }
      });
    } else {
      await db.dirtyPage.create({
        data: {
          wikidotId,
          pageId: pageId ?? undefined,
          needPhaseC: true,
          donePhaseC: false,
          needPhaseB: false,
          donePhaseB: true,
          reasons: reasons
        }
      });
    }
  }

  /**
   * 断开数据库连接
   */
  async disconnect() {
    await disconnectPrisma();
  }
}
