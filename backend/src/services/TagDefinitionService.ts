import { PrismaClient } from '@prisma/client';
import { Logger } from '../utils/Logger.js';

const logger = Logger;

// 标签指导页面配置
const TAG_GUIDE_PAGES = [
  { urlPattern: '/tag-guide', category: '通用标签' },
  { urlPattern: '/tale-tagging-guide', category: '体裁标签' },
  { urlPattern: '/art-tagging-guide', category: '艺作标签' },
  { urlPattern: 'wanderers:tagging-guide', category: '流浪者图书馆标签' },
];

interface TagDef {
  tagChinese: string;
  tagEnglish: string | null;
  description: string | null;
  sourcePageUrl: string;
  category: string;
}

interface SyncResult {
  pagesProcessed: number;
  tagsAdded: number;
  tagsUpdated: number;
  errors: string[];
}

interface CachedTag {
  tag: string;
  pageCount: number;
  samplePages: string[];
}

interface UsedTagRow {
  tag: string;
  page_count: number;
  sample_pages: string[] | null;
  latest_page_date: Date | null;
}

interface UntranslatedRow {
  tag_chinese: string;
  source_page_url: string | null;
  category: string | null;
  usage_count: number;
}

export class TagDefinitionService {
  private prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  /**
   * 从 source 中提取标签定义
   */
  extractTagDefinitions(source: string, sourcePageUrl: string, category: string): TagDef[] {
    const definitions = new Map<string, TagDef>();

    // 格式1: tag-guide 标准格式（有中英文对照，英文是链接）
    // **[*/system:page-tags/tag/中文 中文]** **//([*https://www.scpwiki.com/system:page-tags/tag/英文 英文])//**
    const pattern1 = /\*\*\[\*?\/system:page-tags\/tag\/([^\s\]]+)\s+[^\]]+\]\*\*\s*\*\*\/\/\(\[\*https?:\/\/[^\s]+\/system:page-tags\/tag\/([^\s\]]+)\s+[^\]]+\]\)\/\/\*\*/g;

    // 格式2: tale-tagging-guide 格式（中文圆括号）
    // **[https://scp-wiki-cn.wikidot.com/system:page-tags/tag/中文 中文]（[https://scp-wiki.wikidot.com/system:page-tags/tag/英文 英文]）**
    const pattern2 = /\*\*\[https?:\/\/[^\s]+\/system:page-tags\/tag\/([^\s\]]+)\s+[^\]]+\]（\[https?:\/\/[^\s]+\/system:page-tags\/tag\/([^\s\]]+)\s+[^\]]+\]）\*\*/g;

    // 格式3: tag-guide 简化格式（英文不是链接，只是斜体）
    // **[/system:page-tags/tag/无定形 无定形] //(amorphous)//**
    const pattern3 = /\*\*\[\/?system:page-tags\/tag\/([^\s\]]+)\s+[^\]]+\]\s*\/\/\(([^)]+)\)\/\/\*\*/g;

    // 格式4: 仅中文标签（后面不跟英文）
    // **[*/system:page-tags/tag/中文 中文]**
    const pattern4 = /\*\*\[\*?\/system:page-tags\/tag\/([^\s\]]+)\s+[^\]]+\]\*\*(?!\s*\*\*\/\/|\s*\/\/\()/g;

    // 格式5: 另一种仅中文格式（tale-tagging-guide中的）
    // **[https://scp-wiki-cn.wikidot.com/system:page-tags/tag/中文 中文]** 后面不跟（
    const pattern5 = /\*\*\[https?:\/\/scp-wiki-cn\.wikidot\.com\/system:page-tags\/tag\/([^\s\]]+)\s+[^\]]+\]\*\*(?!\s*（)/g;

    let match: RegExpExecArray | null;

    // 匹配格式1
    while ((match = pattern1.exec(source)) !== null) {
      const chinese = match[1];
      const english = match[2];
      if (!definitions.has(chinese)) {
        definitions.set(chinese, {
          tagChinese: chinese,
          tagEnglish: english !== chinese ? english : null,
          description: null,
          sourcePageUrl,
          category,
        });
      }
    }

    // 匹配格式2
    while ((match = pattern2.exec(source)) !== null) {
      const chinese = match[1];
      const english = match[2];
      if (!definitions.has(chinese)) {
        definitions.set(chinese, {
          tagChinese: chinese,
          tagEnglish: english !== chinese ? english : null,
          description: null,
          sourcePageUrl,
          category,
        });
      }
    }

    // 匹配格式3 (简化格式，英文在斜体括号内)
    while ((match = pattern3.exec(source)) !== null) {
      const chinese = match[1];
      const english = match[2];
      if (!definitions.has(chinese)) {
        definitions.set(chinese, {
          tagChinese: chinese,
          tagEnglish: english !== chinese ? english : null,
          description: null,
          sourcePageUrl,
          category,
        });
      }
    }

    // 匹配格式4 (仅中文)
    while ((match = pattern4.exec(source)) !== null) {
      const chinese = match[1];
      if (!definitions.has(chinese)) {
        definitions.set(chinese, {
          tagChinese: chinese,
          tagEnglish: null,
          description: null,
          sourcePageUrl,
          category,
        });
      }
    }

    // 匹配格式5 (仅中文，tale-tagging-guide)
    while ((match = pattern5.exec(source)) !== null) {
      const chinese = match[1];
      if (!definitions.has(chinese)) {
        definitions.set(chinese, {
          tagChinese: chinese,
          tagEnglish: null,
          description: null,
          sourcePageUrl,
          category,
        });
      }
    }

    return Array.from(definitions.values());
  }

  /**
   * 同步标签定义
   */
  async syncTagDefinitions(force = false): Promise<SyncResult> {
    const result: SyncResult = {
      pagesProcessed: 0,
      tagsAdded: 0,
      tagsUpdated: 0,
      errors: [],
    };

    for (const guide of TAG_GUIDE_PAGES) {
      try {
        // 查找页面
        const page = await this.prisma.page.findFirst({
          where: {
            url: { contains: guide.urlPattern },
            isDeleted: false,
          },
          include: {
            versions: {
              where: { validTo: null },
              take: 1,
            },
          },
        });

        if (!page) {
          logger.warn(`未找到标签指导页面: ${guide.urlPattern}`);
          continue;
        }

        const version = page.versions[0];
        if (!version?.source) {
          logger.warn(`页面无source内容: ${page.url}`);
          continue;
        }

        // 检查是否需要更新
        const syncStatus = await this.prisma.tagGuideSync.findUnique({
          where: { pageUrl: page.url },
        });

        if (!force && syncStatus?.pageVersionId === version.id) {
          logger.info(`页面未变化，跳过: ${page.url}`);
          continue;
        }

        // 提取标签定义
        const definitions = this.extractTagDefinitions(version.source, page.url, guide.category);
        logger.info(`从 ${page.url} 提取到 ${definitions.length} 个标签定义`);

        // 批量upsert
        for (const def of definitions) {
          const existing = await this.prisma.tagDefinition.findUnique({
            where: { tagChinese: def.tagChinese },
          });

          if (existing) {
            await this.prisma.tagDefinition.update({
              where: { tagChinese: def.tagChinese },
              data: {
                tagEnglish: def.tagEnglish,
                sourcePageUrl: def.sourcePageUrl,
                category: def.category,
                updatedAt: new Date(),
              },
            });
            result.tagsUpdated++;
          } else {
            await this.prisma.tagDefinition.create({
              data: {
                tagChinese: def.tagChinese,
                tagEnglish: def.tagEnglish,
                description: def.description,
                sourcePageUrl: def.sourcePageUrl,
                category: def.category,
                isOfficial: true,
              },
            });
            result.tagsAdded++;
          }
        }

        // 更新同步状态
        await this.prisma.tagGuideSync.upsert({
          where: { pageUrl: page.url },
          create: {
            pageUrl: page.url,
            pageVersionId: version.id,
            tagsExtracted: definitions.length,
            lastSyncedAt: new Date(),
            syncStatus: 'synced',
          },
          update: {
            pageVersionId: version.id,
            tagsExtracted: definitions.length,
            lastSyncedAt: new Date(),
            syncStatus: 'synced',
            errorMessage: null,
          },
        });

        result.pagesProcessed++;
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        result.errors.push(`${guide.urlPattern}: ${errMsg}`);
        logger.error(`处理页面失败 ${guide.urlPattern}: ${errMsg}`);

        // 记录失败状态
        try {
          const page = await this.prisma.page.findFirst({
            where: { url: { contains: guide.urlPattern } },
          });
          if (page) {
            await this.prisma.tagGuideSync.upsert({
              where: { pageUrl: page.url },
              create: {
                pageUrl: page.url,
                syncStatus: 'failed',
                errorMessage: errMsg,
              },
              update: {
                syncStatus: 'failed',
                errorMessage: errMsg,
              },
            });
          }
        } catch { /* ignore nested error */ }
      }
    }

    return result;
  }

  /**
   * 获取无效标签（从缓存读取）
   */
  async getInvalidTags(limit = 100): Promise<CachedTag[]> {
    const cached = await this.prisma.$queryRaw<CachedTag[]>`
      SELECT tag, "pageCount", "samplePages"
      FROM "TagValidationCache"
      WHERE "validationType" = 'invalid'
      ORDER BY "pageCount" DESC
      LIMIT ${limit}
    `;
    return cached.map(c => ({
      tag: c.tag,
      pageCount: c.pageCount,
      samplePages: c.samplePages || [],
    }));
  }

  /**
   * 计算并缓存无效标签（离线计算）
   */
  async computeAndCacheInvalidTags(): Promise<number> {
    logger.info('开始计算无效标签...');

    // 获取所有官方标签
    const officialTags = await this.prisma.tagDefinition.findMany({
      select: { tagChinese: true, tagEnglish: true },
    });
    const officialSet = new Set<string>();
    for (const tag of officialTags) {
      officialSet.add(tag.tagChinese);
      if (tag.tagEnglish) {
        officialSet.add(tag.tagEnglish);
      }
    }

    // 系统标签前缀
    const systemPrefixes = ['crom:', '_', 'system:', 'admin:'];
    const isSystemTag = (tag: string) => {
      return systemPrefixes.some(prefix => tag.startsWith(prefix));
    };

    // 一次性获取所有使用中的标签、示例页面wikidotId和最近活跃时间
    const usedTagsWithPages = await this.prisma.$queryRaw<UsedTagRow[]>`
      WITH tag_pages AS (
        SELECT
          t.tag,
          p."wikidotId"::text as wikidot_id,
          pv."createdAt" as page_date,
          ROW_NUMBER() OVER (PARTITION BY t.tag ORDER BY p."wikidotId") as rn
        FROM "PageVersion" pv
        CROSS JOIN LATERAL unnest(pv.tags) AS t(tag)
        JOIN "Page" p ON pv."pageId" = p.id
        WHERE pv."validTo" IS NULL AND NOT pv."isDeleted" AND p."wikidotId" IS NOT NULL
      )
      SELECT
        tag,
        COUNT(DISTINCT wikidot_id)::int as page_count,
        ARRAY_AGG(wikidot_id) FILTER (WHERE rn <= 5) as sample_pages,
        MAX(page_date) as latest_page_date
      FROM tag_pages
      GROUP BY tag
      ORDER BY page_count DESC
    `;

    // 过滤出无效标签
    const invalidTags = usedTagsWithPages.filter(
      t => !isSystemTag(t.tag) && !officialSet.has(t.tag)
    );

    // 在事务内原子替换，避免 BFF 读到中间状态
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`DELETE FROM "TagValidationCache" WHERE "validationType" = 'invalid'`;
      if (invalidTags.length > 0) {
        const now = new Date();
        for (const t of invalidTags) {
          await tx.$executeRaw`
            INSERT INTO "TagValidationCache" (tag, "pageCount", "samplePages", "validationType", "computedAt", "latestPageDate")
            VALUES (${t.tag}, ${t.page_count}, ${t.sample_pages || []}, 'invalid', ${now}, ${t.latest_page_date})
          `;
        }
      }
    });

    logger.info(`缓存了 ${invalidTags.length} 个无效标签`);
    return invalidTags.length;
  }

  /**
   * 计算并缓存所有使用中的标签（离线计算）
   */
  async computeAndCacheAllTags(): Promise<number> {
    logger.info('开始计算所有标签...');

    const allTagsWithStats = await this.prisma.$queryRaw<UsedTagRow[]>`
      SELECT
        t.tag,
        COUNT(DISTINCT pv."pageId")::int as page_count,
        MAX(pv."createdAt") as latest_page_date
      FROM "PageVersion" pv
      CROSS JOIN LATERAL unnest(pv.tags) AS t(tag)
      WHERE pv."validTo" IS NULL AND NOT pv."isDeleted"
        AND t.tag IS NOT NULL AND btrim(t.tag) <> ''
      GROUP BY t.tag
      ORDER BY page_count DESC
    `;

    // 在事务内原子替换，避免 BFF 读到中间状态
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`DELETE FROM "TagValidationCache" WHERE "validationType" = 'all'`;
      if (allTagsWithStats.length > 0) {
        const now = new Date();
        for (const t of allTagsWithStats) {
          await tx.$executeRaw`
            INSERT INTO "TagValidationCache" (tag, "pageCount", "samplePages", "validationType", "computedAt", "latestPageDate")
            VALUES (${t.tag}, ${t.page_count}, '{}', 'all', ${now}, ${t.latest_page_date})
          `;
        }
      }
    });

    logger.info(`缓存了 ${allTagsWithStats.length} 个标签`);
    return allTagsWithStats.length;
  }

  /**
   * 计算并缓存未翻译标签的使用统计（离线计算）
   */
  async computeAndCacheUntranslatedTags(): Promise<number> {
    logger.info('开始计算未翻译标签...');

    const untranslatedWithUsage = await this.prisma.$queryRaw<UntranslatedRow[]>`
      WITH tag_usage AS (
        SELECT tag, COUNT(DISTINCT pv."pageId")::int as usage_count
        FROM "PageVersion" pv
        CROSS JOIN LATERAL unnest(pv.tags) AS t(tag)
        WHERE pv."validTo" IS NULL AND NOT pv."isDeleted"
        GROUP BY tag
      )
      SELECT td."tagChinese" as tag_chinese, td."sourcePageUrl" as source_page_url, td.category,
             COALESCE(tu.usage_count, 0)::int as usage_count
      FROM "TagDefinition" td
      LEFT JOIN tag_usage tu ON td."tagChinese" = tu.tag
      WHERE td."tagEnglish" IS NULL
      ORDER BY usage_count DESC
    `;

    // 在事务内原子替换，避免 BFF 读到中间状态
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`DELETE FROM "TagValidationCache" WHERE "validationType" = 'untranslated'`;
      if (untranslatedWithUsage.length > 0) {
        const now = new Date();
        for (const t of untranslatedWithUsage) {
          // 使用 samplePages 存储 category 和 sourcePageUrl
          const metadata = [t.source_page_url || '', t.category || ''];
          await tx.$executeRaw`
            INSERT INTO "TagValidationCache" (tag, "pageCount", "samplePages", "validationType", "computedAt")
            VALUES (${t.tag_chinese}, ${t.usage_count}, ${metadata}, 'untranslated', ${now})
          `;
        }
      }
    });

    logger.info(`缓存了 ${untranslatedWithUsage.length} 个未翻译标签`);
    return untranslatedWithUsage.length;
  }

  /**
   * 获取未翻译的标签（只有中文没有英文）
   */
  async getUntranslatedTags() {
    const tags = await this.prisma.tagDefinition.findMany({
      where: { tagEnglish: null },
      orderBy: { tagChinese: 'asc' },
    });
    return tags.map(t => ({
      tagChinese: t.tagChinese,
      tagEnglish: t.tagEnglish,
      description: t.description,
      sourcePageUrl: t.sourcePageUrl,
      category: t.category,
    }));
  }

  /**
   * 获取同步状态
   */
  async getSyncStatus() {
    return this.prisma.tagGuideSync.findMany({
      orderBy: { lastSyncedAt: 'desc' },
    });
  }

  /**
   * 获取统计信息
   */
  async getStats() {
    const total = await this.prisma.tagDefinition.count();
    const withTranslation = await this.prisma.tagDefinition.count({
      where: { tagEnglish: { not: null } },
    });
    const byCategory = await this.prisma.tagDefinition.groupBy({
      by: ['category'],
      _count: { id: true },
    });
    return {
      total,
      withTranslation,
      withoutTranslation: total - withTranslation,
      byCategory: byCategory.map(c => ({
        category: c.category || '未分类',
        count: c._count.id,
      })),
    };
  }
}
