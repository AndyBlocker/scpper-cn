import { PrismaClient } from '@prisma/client';
import { Logger } from '../../utils/Logger.js';

/**
 * 页面基础操作存储类
 * 负责Page表的基本CRUD操作
 */
export class PageStore {
  constructor(private prisma: PrismaClient) {}

  /**
   * 通过URL提取页面的URL key（去掉域名部分）
   */
  extractUrlKey(url: string): string {
    return url.replace(/^https?:\/\/[^\/]+/, '');
  }

  /**
   * 根据标识符查找页面（wikidotId或URL）
   */
  async findPageByIdentifier(identifier: string) {
    // 尝试作为wikidotId查找
    const wikidotId = parseInt(identifier);
    if (!isNaN(wikidotId)) {
      const pageByWikidotId = await this.prisma.page.findUnique({
        where: { wikidotId }
      });
      if (pageByWikidotId) return pageByWikidotId;
    }

    // 尝试作为URL查找
    return await this.prisma.page.findFirst({
      where: {
        OR: [
          { url: identifier },
          { currentUrl: identifier }
        ]
      }
    });
  }

  /**
   * 根据wikidotId或URL查找页面（包含版本信息）
   */
  async findPageWithVersion(identifier: string) {
    // 尝试作为wikidotId查找
    const wikidotId = parseInt(identifier);
    if (!isNaN(wikidotId)) {
      const page = await this.prisma.page.findUnique({
        where: { wikidotId },
        include: {
          versions: {
            where: { validTo: null },
            orderBy: { validFrom: 'desc' },
            take: 1
          }
        }
      });
      if (page) return page;
    }

    // 尝试作为完整URL查找
    const page = await this.prisma.page.findFirst({
      where: {
        OR: [
          { url: identifier },
          { currentUrl: identifier }
        ]
      },
      include: {
        versions: {
          where: { validTo: null },
          orderBy: { validFrom: 'desc' },
          take: 1
        }
      }
    });

    if (page) return page;

    // 尝试作为URL key查找
    const urlKey = this.extractUrlKey(identifier);
    return await this.prisma.page.findFirst({
      where: {
        OR: [
          { url: { endsWith: urlKey } },
          { currentUrl: { endsWith: urlKey } }
        ]
      },
      include: {
        versions: {
          where: { validTo: null },
          orderBy: { validFrom: 'desc' },
          take: 1
        }
      }
    });
  }

  /**
   * 创建新页面
   */
  async createNewPage(data: {
    wikidotId: number;
    url: string;
    category?: any;
    title?: string;
    isDeleted?: boolean;
    createdAt?: string;
  }) {
    const page = await this.prisma.page.create({
      data: {
        wikidotId: data.wikidotId,
        url: data.url,
        currentUrl: data.url,
        urlHistory: [data.url],
        isDeleted: data.isDeleted || false,
        firstPublishedAt: data.createdAt ? new Date(data.createdAt) : new Date(),
        createdAt: new Date(),
        updatedAt: new Date()
      }
    });

    Logger.info(`✅ Created new page: ${data.url} (wikidotId: ${data.wikidotId})`);
    return page;
  }

  /**
   * 标记页面为已删除
   */
  async markPageDeleted(pageId: number): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      // 标记 Page 为已删除
      try {
        await tx.page.update({
          where: { id: pageId },
          data: { isDeleted: true, updatedAt: new Date() }
        });
      } catch {}

      // 获取当前版本
      const currentVersion = await tx.pageVersion.findFirst({
        where: {
          pageId: pageId,
          validTo: null
        }
      });

      if (!currentVersion) {
        Logger.warn(`No current version found for page ${pageId}`);
        return;
      }

      // 结束当前版本
      await tx.pageVersion.update({
        where: { id: currentVersion.id },
        data: { validTo: new Date() }
      });

      // 创建新的已删除版本
      await tx.pageVersion.create({
        data: {
          pageId: pageId,
          title: currentVersion.title,
          source: currentVersion.source,
          textContent: currentVersion.textContent,
          rating: null,
          voteCount: null,
          tags: [],
          category: currentVersion.category,
          isDeleted: true,
          validFrom: new Date(),
          validTo: null
        }
      });

      Logger.info(`✅ Marked page ${pageId} as deleted`);
    });
  }

  /**
   * 处理页面重命名
   */
  async handlePageRename(options: {
    pageId: number;
    oldUrl: string;
    newUrl: string;
    timestamp?: Date;
  }) {
    const { pageId, oldUrl, newUrl, timestamp = new Date() } = options;

    await this.prisma.$transaction(async (tx) => {
      const page = await tx.page.findUnique({
        where: { id: pageId }
      });

      if (!page) {
        throw new Error(`Page ${pageId} not found`);
      }

      // 更新页面信息
      await tx.page.update({
        where: { id: pageId },
        data: {
          currentUrl: newUrl,
          urlHistory: {
            set: [...new Set([...page.urlHistory, oldUrl, newUrl])]
          },
          updatedAt: timestamp
        }
      });

      Logger.info(`✅ Renamed page ${pageId}: ${oldUrl} -> ${newUrl}`);
    });
  }
}