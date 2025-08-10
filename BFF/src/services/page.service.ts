import { PrismaClient } from '@prisma/client';
import { CacheService } from './cache.service.js';
import { PageDetailDTO, PageListDTO } from '../types/dto.js';
import { CacheKeyBuilder, CACHE_TTL } from '../types/cache.js';
import { logger } from '../utils/logger.js';

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

export class PageService {
  constructor(
    private prisma: PrismaClient,
    private cache: CacheService
  ) {}

  async getPageDetail(identifier: string): Promise<PageDetailDTO> {
    const cacheKey = CacheKeyBuilder.pageDetail(identifier);
    
    return this.cache.getOrSet(
      cacheKey,
      async () => {
        // 复杂的数据聚合逻辑
        const page = await this.prisma.page.findFirst({
          where: {
            OR: [
              { url: identifier },
              { urlKey: identifier },
              { pageUuid: identifier },
            ],
          },
          include: {
            PageVersion: {
              where: { validTo: null },
              include: {
                PageStats: true,
                Attribution: {
                  include: { User: true },
                  orderBy: { order: 'asc' },
                },
              },
            },
          },
        });

        if (!page || !page.PageVersion.length) {
          throw new NotFoundError('Page not found');
        }

        // 并行获取额外数据
        const [recentVotes, recentRevisions, relatedPages] = await Promise.all([
          this.getRecentVotes(page.PageVersion[0].id),
          this.getRecentRevisions(page.PageVersion[0].id),
          this.getRelatedPages(page.id, page.PageVersion[0].tags) as Promise<any[]>,
        ]);

        // 数据转换和格式化
        return this.formatPageDetail(
          page,
          recentVotes,
          recentRevisions,
          relatedPages
        );
      },
      CACHE_TTL.PAGE_DETAIL
    );
  }

  async getPageList(params: {
    page?: number;
    limit?: number;
    tags?: string[];
    category?: string;
    sort?: 'rating' | 'date' | 'votes';
  }): Promise<PageListDTO> {
    const cacheKey = CacheKeyBuilder.pageList(params);
    
    return this.cache.getOrSet(
      cacheKey,
      async () => {
        const page = params.page || 1;
        const limit = params.limit || 20;
        const offset = (page - 1) * limit;

        // Build where clause
        const where: any = {
          validTo: null,
          isDeleted: false,
        };

        if (params.tags && params.tags.length > 0) {
          where.tags = { hasEvery: params.tags };
        }

        if (params.category) {
          // Category filtering logic based on tags
          switch (params.category) {
            case 'scp':
              where.tags = { ...where.tags, hasEvery: ['scp', '原创'] };
              break;
            case 'goi':
              where.tags = { ...where.tags, hasEvery: ['goi格式', '原创'] };
              break;
            case 'story':
              where.tags = { ...where.tags, hasEvery: ['故事', '原创'] };
              break;
            case 'translation':
              where.tags = { ...where.tags, not: { has: '原创' } };
              break;
          }
        }

        // Build order by
        let orderBy: any = { rating: 'desc' };
        if (params.sort === 'date') {
          orderBy = { createdAt: 'desc' };
        } else if (params.sort === 'votes') {
          orderBy = { voteCount: 'desc' };
        }

        const [pages, total] = await Promise.all([
          this.prisma.pageVersion.findMany({
            where,
            include: {
              Page: true,
            },
            orderBy,
            skip: offset,
            take: limit,
          }),
          this.prisma.pageVersion.count({ where }),
        ]);

        return {
          pages: pages.map(pv => ({
            id: pv.Page.id,
            url: pv.Page.url,
            title: pv.title || '',
            rating: pv.rating || 0,
            voteCount: pv.voteCount || 0,
            tags: pv.tags,
            createdAt: pv.createdAt.toISOString(),
            updatedAt: pv.updatedAt.toISOString(),
          })),
          pagination: {
            total,
            page,
            limit,
            totalPages: Math.ceil(total / limit),
            hasNext: page * limit < total,
            hasPrev: page > 1,
          },
        };
      },
      CACHE_TTL.PAGE_DETAIL
    );
  }

  private async getRecentVotes(pageVersionId: number) {
    return this.prisma.vote.findMany({
      where: { pageVersionId },
      include: { User: true },
      orderBy: { timestamp: 'desc' },
      take: 20,
    });
  }

  private async getRecentRevisions(pageVersionId: number) {
    return this.prisma.revision.findMany({
      where: { pageVersionId },
      include: { User: true },
      orderBy: { timestamp: 'desc' },
      take: 10,
    });
  }

  private async getRelatedPages(pageId: number, tags: string[]) {
    if (tags.length === 0) return [];
    
    return this.prisma.$queryRaw`
      SELECT 
        p.id,
        p.url,
        pv.title,
        pv.rating,
        array_length(array(select unnest(pv.tags) intersect select unnest(${tags}::text[])), 1) as common_tags
      FROM "Page" p
      JOIN "PageVersion" pv ON p.id = pv."pageId"
      WHERE 
        pv."validTo" IS NULL
        AND p.id != ${pageId}
        AND pv.tags && ${tags}::text[]
      ORDER BY common_tags DESC, pv.rating DESC
      LIMIT 5
    `;
  }

  private formatPageDetail(
    page: any,
    votes: any[],
    revisions: any[],
    related: any[]
  ): PageDetailDTO {
    const currentVersion = page.PageVersion[0];
    
    return {
      page: {
        id: page.id,
        url: page.url,
        pageUuid: page.pageUuid,
        urlKey: page.urlKey,
        historicalUrls: page.historicalUrls || [],
        firstPublishedAt: page.firstPublishedAt?.toISOString(),
      },
      currentVersion: {
        id: currentVersion.id,
        title: currentVersion.title,
        rating: currentVersion.rating,
        voteCount: currentVersion.voteCount,
        revisionCount: currentVersion.revisionCount,
        tags: currentVersion.tags,
        isDeleted: currentVersion.isDeleted,
        createdAt: currentVersion.createdAt.toISOString(),
        updatedAt: currentVersion.updatedAt.toISOString(),
      },
      stats: currentVersion.PageStats ? {
        wilson95: currentVersion.PageStats.wilson95,
        controversy: currentVersion.PageStats.controversy,
        likeRatio: currentVersion.PageStats.likeRatio,
        upvotes: currentVersion.PageStats.uv,
        downvotes: currentVersion.PageStats.dv,
      } : undefined,
      attributions: currentVersion.Attribution.map((attr: any) => ({
        type: attr.type,
        order: attr.order,
        user: attr.User ? {
          id: attr.User.id,
          displayName: attr.User.displayName,
          wikidotId: attr.User.wikidotId,
        } : undefined,
        date: attr.date?.toISOString(),
      })),
      recentRevisions: revisions.map(rev => ({
        id: rev.id,
        wikidotId: rev.wikidotId,
        timestamp: rev.timestamp.toISOString(),
        type: rev.type,
        comment: rev.comment,
        user: rev.User ? {
          displayName: rev.User.displayName,
          wikidotId: rev.User.wikidotId,
        } : undefined,
      })),
      recentVotes: votes.map(vote => ({
        id: vote.id,
        timestamp: vote.timestamp.toISOString(),
        direction: vote.direction,
        user: vote.User ? {
          displayName: vote.User.displayName,
          wikidotId: vote.User.wikidotId,
        } : undefined,
      })),
      relatedPages: related,
    };
  }

  async getPageVotes(identifier: string, params: {
    page?: number;
    limit?: number;
    direction?: number;
  }) {
    const cacheKey = `page_votes:${identifier}:${JSON.stringify(params)}`;
    
    return this.cache.getOrSet(
      cacheKey,
      async () => {
        const page = await this.findPageByIdentifier(identifier);
        if (!page) {
          throw new NotFoundError('Page not found');
        }

        const currentVersion = page.PageVersion[0];
        if (!currentVersion) {
          throw new NotFoundError('Page version not found');
        }

        const pageNum = params.page || 1;
        const limit = params.limit || 20;
        const offset = (pageNum - 1) * limit;

        const where: any = { pageVersionId: currentVersion.id };
        if (params.direction !== undefined) {
          where.direction = params.direction;
        }

        const [votes, total] = await Promise.all([
          this.prisma.vote.findMany({
            where,
            include: { User: true },
            orderBy: { timestamp: 'desc' },
            skip: offset,
            take: limit,
          }),
          this.prisma.vote.count({ where }),
        ]);

        return {
          votes: votes.map(vote => ({
            id: vote.id,
            timestamp: vote.timestamp.toISOString(),
            direction: vote.direction,
            user: vote.User ? {
              id: vote.User.id,
              displayName: vote.User.displayName,
              wikidotId: vote.User.wikidotId,
            } : null,
            anonKey: vote.anonKey,
          })),
          pagination: {
            total,
            page: pageNum,
            limit,
            totalPages: Math.ceil(total / limit),
            hasNext: pageNum * limit < total,
            hasPrev: pageNum > 1,
          },
          summary: {
            totalVotes: total,
            upvotes: votes.filter(v => v.direction > 0).length,
            downvotes: votes.filter(v => v.direction < 0).length,
          },
        };
      },
      CACHE_TTL.HOT_DATA
    );
  }

  async getPageRevisions(identifier: string, params: {
    page?: number;
    limit?: number;
    type?: string;
  }) {
    const cacheKey = `page_revisions:${identifier}:${JSON.stringify(params)}`;
    
    return this.cache.getOrSet(
      cacheKey,
      async () => {
        const page = await this.findPageByIdentifier(identifier);
        if (!page) {
          throw new NotFoundError('Page not found');
        }

        const currentVersion = page.PageVersion[0];
        if (!currentVersion) {
          throw new NotFoundError('Page version not found');
        }

        const pageNum = params.page || 1;
        const limit = params.limit || 20;
        const offset = (pageNum - 1) * limit;

        const where: any = { pageVersionId: currentVersion.id };
        if (params.type) {
          where.type = params.type;
        }

        const [revisions, total] = await Promise.all([
          this.prisma.revision.findMany({
            where,
            include: { User: true },
            orderBy: { timestamp: 'desc' },
            skip: offset,
            take: limit,
          }),
          this.prisma.revision.count({ where }),
        ]);

        return {
          revisions: revisions.map(rev => ({
            id: rev.id,
            wikidotId: rev.wikidotId,
            timestamp: rev.timestamp.toISOString(),
            type: rev.type,
            comment: rev.comment,
            user: rev.User ? {
              id: rev.User.id,
              displayName: rev.User.displayName,
              wikidotId: rev.User.wikidotId,
            } : null,
          })),
          pagination: {
            total,
            page: pageNum,
            limit,
            totalPages: Math.ceil(total / limit),
            hasNext: pageNum * limit < total,
            hasPrev: pageNum > 1,
          },
          summary: {
            totalRevisions: total,
            revisionTypes: await this.getRevisionTypesSummary(currentVersion.id),
          },
        };
      },
      CACHE_TTL.HOT_DATA
    );
  }

  async getPageVersions(identifier: string, params: {
    page?: number;
    limit?: number;
  }) {
    const cacheKey = `page_versions:${identifier}:${JSON.stringify(params)}`;
    
    return this.cache.getOrSet(
      cacheKey,
      async () => {
        const page = await this.findPageByIdentifier(identifier);
        if (!page) {
          throw new NotFoundError('Page not found');
        }

        const pageNum = params.page || 1;
        const limit = params.limit || 20;
        const offset = (pageNum - 1) * limit;

        const [versions, total] = await Promise.all([
          this.prisma.pageVersion.findMany({
            where: { pageId: page.id },
            include: {
              PageStats: true,
              Attribution: {
                include: { User: true },
                orderBy: { order: 'asc' },
              },
            },
            orderBy: { validFrom: 'desc' },
            skip: offset,
            take: limit,
          }),
          this.prisma.pageVersion.count({
            where: { pageId: page.id },
          }),
        ]);

        return {
          versions: versions.map(version => ({
            id: version.id,
            wikidotId: version.wikidotId,
            title: version.title,
            rating: version.rating,
            voteCount: version.voteCount,
            revisionCount: version.revisionCount,
            tags: version.tags,
            validFrom: version.validFrom.toISOString(),
            validTo: version.validTo?.toISOString(),
            isDeleted: version.isDeleted,
            isCurrent: version.validTo === null,
            stats: version.PageStats ? {
              wilson95: version.PageStats.wilson95,
              controversy: version.PageStats.controversy,
              likeRatio: version.PageStats.likeRatio,
              upvotes: version.PageStats.uv,
              downvotes: version.PageStats.dv,
            } : null,
            attributions: version.Attribution.map(attr => ({
              type: attr.type,
              order: attr.order,
              user: attr.User ? {
                id: attr.User.id,
                displayName: attr.User.displayName,
                wikidotId: attr.User.wikidotId,
              } : null,
              date: attr.date?.toISOString(),
            })),
          })),
          pagination: {
            total,
            page: pageNum,
            limit,
            totalPages: Math.ceil(total / limit),
            hasNext: pageNum * limit < total,
            hasPrev: pageNum > 1,
          },
        };
      },
      CACHE_TTL.PAGE_DETAIL
    );
  }

  async getPageStats(identifier: string) {
    const cacheKey = `page_stats:${identifier}`;
    
    return this.cache.getOrSet(
      cacheKey,
      async () => {
        const page = await this.prisma.page.findFirst({
          where: {
            OR: [
              { url: identifier },
              { urlKey: identifier },
              { pageUuid: identifier },
            ],
          },
          select: {
            id: true,
            votingTimeSeriesCache: true,
            votingCacheUpdatedAt: true,
            PageVersion: {
              where: { validTo: null },
              include: {
                PageStats: true,
              },
            },
          },
        });
        
        if (!page || !page.PageVersion.length) {
          throw new NotFoundError('Page not found');
        }

        const currentVersion = page.PageVersion[0];

        return {
          pageId: page.id,
          stats: currentVersion.PageStats ? {
            wilson95: currentVersion.PageStats.wilson95,
            controversy: currentVersion.PageStats.controversy,
            likeRatio: currentVersion.PageStats.likeRatio,
            upvotes: currentVersion.PageStats.uv,
            downvotes: currentVersion.PageStats.dv,
          } : null,
          votingHistory: page.votingTimeSeriesCache || null,
          lastUpdated: page.votingCacheUpdatedAt?.toISOString(),
        };
      },
      CACHE_TTL.PAGE_DETAIL
    );
  }

  async getPageVotingHistory(identifier: string) {
    const cacheKey = `page_voting_history:${identifier}`;
    
    return this.cache.getOrSet(
      cacheKey,
      async () => {
        const page = await this.prisma.page.findFirst({
          where: {
            OR: [
              { url: identifier },
              { urlKey: identifier },
              { pageUuid: identifier },
            ],
          },
          select: {
            id: true,
            votingTimeSeriesCache: true,
            votingCacheUpdatedAt: true,
          },
        });
        
        if (!page) {
          throw new NotFoundError('Page not found');
        }

        return {
          pageId: page.id,
          votingHistory: page.votingTimeSeriesCache || null,
          lastUpdated: page.votingCacheUpdatedAt?.toISOString(),
        };
      },
      CACHE_TTL.PAGE_DETAIL
    );
  }

  private async findPageByIdentifier(identifier: string) {
    return this.prisma.page.findFirst({
      where: {
        OR: [
          { url: identifier },
          { urlKey: identifier },
          { pageUuid: identifier },
        ],
      },
      include: {
        PageVersion: {
          where: { validTo: null },
          include: {
            PageStats: true,
            Attribution: {
              include: { User: true },
              orderBy: { order: 'asc' },
            },
          },
        },
      },
    });
  }

  private async getRevisionTypesSummary(pageVersionId: number) {
    const result = await this.prisma.$queryRaw<Array<{type: string, count: bigint}>>`
      SELECT type, COUNT(*) as count
      FROM "Revision"
      WHERE "pageVersionId" = ${pageVersionId}
      GROUP BY type
      ORDER BY count DESC
    `;
    
    return result.map(item => ({
      type: item.type,
      count: Number(item.count),
    }));
  }

  /**
   * 获取随机页面 - 不使用缓存，每次都返回不同结果
   * @param params 过滤参数
   * @returns 随机页面列表
   */
  async getRandomPages(params: {
    limit?: number;
    tags?: string[];
    category?: string;
    minRating?: number;
    maxRating?: number;
  }) {
    const limit = Math.min(params.limit || 5, 10); // 限制最多返回10个
    
    // 构建WHERE条件
    let whereConditions = ['pv."validTo" IS NULL', 'pv."isDeleted" = false'];
    let queryParams: any[] = [];
    let paramIndex = 1;

    // 标签过滤
    if (params.tags && params.tags.length > 0) {
      whereConditions.push(`pv.tags @> $${paramIndex}::text[]`);
      queryParams.push(params.tags);
      paramIndex++;
    }

    // 分类过滤
    if (params.category) {
      switch (params.category) {
        case 'scp':
          whereConditions.push(`pv.tags @> ARRAY['scp', '原创']`);
          break;
        case 'goi':
          whereConditions.push(`pv.tags @> ARRAY['goi格式', '原创']`);
          break;
        case 'story':
          whereConditions.push(`pv.tags @> ARRAY['故事', '原创']`);
          break;
        case 'translation':
          whereConditions.push(`NOT (pv.tags @> ARRAY['原创'])`);
          break;
      }
    }

    // 评分范围过滤
    if (params.minRating !== undefined) {
      whereConditions.push(`pv.rating >= $${paramIndex}`);
      queryParams.push(params.minRating);
      paramIndex++;
    }
    if (params.maxRating !== undefined) {
      whereConditions.push(`pv.rating <= $${paramIndex}`);
      queryParams.push(params.maxRating);
      paramIndex++;
    }

    const whereClause = whereConditions.join(' AND ');
    queryParams.push(limit);
    const limitParam = paramIndex;

    // 使用PostgreSQL的TABLESAMPLE和随机排序获取真随机结果
    // 这样每次调用都会得到不同的结果，不依赖缓存
    const sql = `
      SELECT 
        p.id as "pageId",
        p.url,
        p."urlKey",
        pv.title,
        pv.rating,
        pv."voteCount",
        pv.tags,
        LEFT(COALESCE(si.text_content, ''), 200) as content,
        si.random_sentences
      FROM "PageVersion" pv
      JOIN "Page" p ON p.id = pv."pageId"
      LEFT JOIN "SearchIndex" si ON si."pageId" = p.id
      WHERE ${whereClause}
        AND pv.title IS NOT NULL 
        AND pv.title != ''
      ORDER BY RANDOM()
      LIMIT $${limitParam}
    `;

    logger.info('🎲 Getting random pages:', { 
      sql: sql.replace(/\s+/g, ' '),
      params: queryParams 
    });

    const results = await this.prisma.$queryRawUnsafe<Array<{
      pageId: number;
      url: string;
      urlKey: string;
      title: string;
      rating: number;
      voteCount: number;
      tags: string[];
      content: string;
      random_sentences: string[];
    }>>(sql, ...queryParams);

    return {
      results: results.map(result => ({
        pageId: result.pageId,
        url: result.url,
        urlKey: result.urlKey,
        title: result.title,
        rating: result.rating,
        voteCount: result.voteCount,
        tags: result.tags || [],
        content: result.random_sentences?.[0] || result.content || '',
      })),
      total: results.length,
      filters: params,
      note: 'Results are randomly generated and will differ on each request',
    };
  }
}