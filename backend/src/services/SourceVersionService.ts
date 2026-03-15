import { PrismaClient, Prisma } from '@prisma/client';
import { Logger } from '../utils/Logger.js';

type DbClient = PrismaClient | Prisma.TransactionClient;

export class SourceVersionService {
  private prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  /**
   * 管理页面的source code版本
   * 基于SOURCE_CHANGED revision创建新版本
   */
  async manageSourceVersion(pageVersionId: number, data: {
    source?: string;
    textContent?: string;
  }, outerTx?: DbClient) {
    Logger.debug(`📋 Managing source version for PageVersion ${pageVersionId}`);
    const db = outerTx ?? this.prisma;

    try {
      // 1. 获取当前最新的SourceVersion
      const currentSourceVersion = await db.sourceVersion.findFirst({
        where: {
          pageVersionId,
          isLatest: true,
        },
        orderBy: { timestamp: 'desc' },
      });

      // 2. 查找最新的SOURCE_CHANGED revision
      const latestSourceRevision = await db.revision.findFirst({
        where: {
          pageVersionId,
          type: 'SOURCE_CHANGED',
        },
        orderBy: { timestamp: 'desc' },
      });

      // 3. 判断是否需要创建新的SourceVersion
      const shouldCreateNewVersion = this.shouldCreateNewSourceVersion(
        currentSourceVersion,
        latestSourceRevision,
        data
      );

      if (shouldCreateNewVersion) {
        Logger.info(`📝 Creating new source version for PageVersion ${pageVersionId}`);
        await this.createNewSourceVersion(
          pageVersionId,
          latestSourceRevision,
          data,
          currentSourceVersion,
          outerTx
        );
      } else {
        // 不需要创建新版本，但可能需要更新现有版本的内容
        if (currentSourceVersion) {
          const hasContentChanges = 
            (data.source && data.source !== currentSourceVersion.source) ||
            (data.textContent && data.textContent !== currentSourceVersion.textContent);
            
          if (hasContentChanges) {
            Logger.debug(`📝 Updating existing source version for PageVersion ${pageVersionId}`);
            await this.updateExistingSourceVersion(currentSourceVersion.id, data, outerTx);
          } else {
            Logger.debug(`⏭️ No changes needed for PageVersion ${pageVersionId}`);
          }
        }
      }

    } catch (error) {
      Logger.error(`❌ Failed to manage source version for PageVersion ${pageVersionId}:`, error);
      throw error;
    }
  }

  /**
   * 判断是否需要创建新的SourceVersion
   */
  private shouldCreateNewSourceVersion(
    currentSourceVersion: any,
    latestSourceRevision: any,
    newData: any
  ): boolean {
    // 情况1: 没有现有的SourceVersion - 创建初始版本
    if (!currentSourceVersion) {
      Logger.debug(`📋 No existing source version found - creating initial version`);
      return true;
    }

    // 情况2: 有新的SOURCE_CHANGED revision（只有revision真的更新了才创建新版本）
    if (latestSourceRevision && (
      !currentSourceVersion.revisionNumber || 
      latestSourceRevision.wikidotId > currentSourceVersion.revisionNumber
    )) {
      Logger.debug(`📋 New SOURCE_CHANGED revision detected: ${latestSourceRevision.wikidotId} > ${currentSourceVersion.revisionNumber || 'null'}`);
      return true;
    }

    // 情况3&4: 如果只是内容变化但revision没变，不创建新版本，而是更新现有版本
    if (newData.source && newData.source !== currentSourceVersion.source) {
      Logger.debug(`📋 Source content changed but no new revision - will update existing version`);
      return false; // 不创建新版本，会在后续更新现有版本
    }

    if (newData.textContent && newData.textContent !== currentSourceVersion.textContent) {
      Logger.debug(`📋 Text content changed but no new revision - will update existing version`);
      return false; // 不创建新版本，会在后续更新现有版本
    }

    return false;
  }

  /**
   * 创建新的SourceVersion
   */
  private async createNewSourceVersion(
    pageVersionId: number,
    latestSourceRevision: any,
    data: any,
    currentSourceVersion: any,
    outerTx?: DbClient
  ) {
    const doWork = async (tx: DbClient) => {
      // 1. 将现有版本标记为非最新
      if (currentSourceVersion) {
        await tx.sourceVersion.update({
          where: { id: currentSourceVersion.id },
          data: { isLatest: false },
        });
      }

      // 2. 创建新版本
      const newSourceVersion = await tx.sourceVersion.create({
        data: {
          pageVersionId,
          revisionId: latestSourceRevision?.id || null,
          revisionNumber: latestSourceRevision?.wikidotId || null,
          source: data.source,
          textContent: data.textContent,
          isLatest: true,
          timestamp: latestSourceRevision?.timestamp || new Date(),
        },
      });

      Logger.info(`✅ Created new SourceVersion ${newSourceVersion.id} (revision: ${newSourceVersion.revisionNumber || 'initial'})`);
    };

    if (outerTx) {
      await doWork(outerTx);
    } else {
      await this.prisma.$transaction(async (tx) => doWork(tx), { timeout: 30000 });
    }
  }

  /**
   * 更新现有的SourceVersion
   */
  private async updateExistingSourceVersion(sourceVersionId: number, data: any, outerTx?: DbClient) {
    const updateData: any = {};

    if (data.source !== undefined) {
      updateData.source = data.source;
    }

    if (data.textContent !== undefined) {
      updateData.textContent = data.textContent;
    }

    if (Object.keys(updateData).length > 0) {
      const db = outerTx ?? this.prisma;
      await db.sourceVersion.update({
        where: { id: sourceVersionId },
        data: updateData,
      });
      
      Logger.debug(`📝 Updated existing SourceVersion ${sourceVersionId}`);
    }
  }

  /**
   * 获取页面的所有source code版本历史
   */
  async getSourceHistory(pageVersionId: number) {
    return await this.prisma.sourceVersion.findMany({
      where: { pageVersionId },
      include: {
        revision: {
          select: {
            id: true,
            wikidotId: true,
            timestamp: true,
            type: true,
            comment: true,
            user: {
              select: {
                displayName: true,
                wikidotId: true,
              },
            },
          },
        },
      },
      orderBy: { timestamp: 'desc' },
    });
  }

  /**
   * 获取特定revision的source code版本
   */
  async getSourceVersionByRevision(pageVersionId: number, revisionNumber: number) {
    return await this.prisma.sourceVersion.findUnique({
      where: {
        pageVersionId_revisionNumber: {
          pageVersionId,
          revisionNumber,
        },
      },
      include: {
        revision: {
          include: {
            user: {
              select: {
                displayName: true,
                wikidotId: true,
              },
            },
          },
        },
      },
    });
  }

  /**
   * 获取最新的source code版本
   */
  async getLatestSourceVersion(pageVersionId: number) {
    return await this.prisma.sourceVersion.findFirst({
      where: {
        pageVersionId,
        isLatest: true,
      },
      include: {
        revision: {
          include: {
            user: {
              select: {
                displayName: true,
                wikidotId: true,
              },
            },
          },
        },
      },
    });
  }

  /**
   * 统计信息：获取source版本数量
   */
  async getSourceVersionStats(pageVersionId?: number) {
    const where = pageVersionId ? { pageVersionId } : {};
    
    return await this.prisma.sourceVersion.aggregate({
      where,
      _count: {
        id: true,
      },
    });
  }
}