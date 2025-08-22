import { PrismaClient } from '@prisma/client';
import { Logger } from '../utils/logger';

interface SearchOptions {
  query: string;
  limit?: number;
  offset?: number;
  tags?: string[];  // 标签过滤
  excludeTags?: string[];  // 排除标签
  ratingMin?: number;
  ratingMax?: number;
  orderBy?: 'relevance' | 'rating' | 'recent';
}

interface PageSearchResult {
  id: number;
  wikidotId: number;
  pageId: number;
  title: string;
  url: string;
  rating: number | null;
  tags: string[];
  snippet: string;
  score?: number;
}

interface UserSearchResult {
  id: number;
  wikidotId: number | null;
  displayName: string;
  totalRating: number;
  pageCount: number;
}

interface MixedSearchResult {
  pages: PageSearchResult[];
  users: UserSearchResult[];
  totalPages: number;
  totalUsers: number;
}

export class PGroongaSearchService {
  private prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  /**
   * 搜索页面（标题和内容）
   */
  async searchPages(options: SearchOptions): Promise<{
    results: PageSearchResult[];
    total: number;
  }> {
    const { 
      query, 
      limit = 20, 
      offset = 0, 
      tags, 
      excludeTags,
      ratingMin,
      ratingMax,
      orderBy = 'relevance' 
    } = options;

    // 构建 WHERE 条件
    const whereConditions: string[] = [
      `pv."validTo" IS NULL`,
      `(pv.title &@~ $1 OR pv."textContent" &@~ $1)`
    ];
    const params: any[] = [query];
    let paramIndex = 2;

    // 标签过滤
    if (tags && tags.length > 0) {
      whereConditions.push(`pv.tags @> $${paramIndex}::text[]`);
      params.push(tags);
      paramIndex++;
    }

    if (excludeTags && excludeTags.length > 0) {
      whereConditions.push(`NOT (pv.tags && $${paramIndex}::text[])`);
      params.push(excludeTags);
      paramIndex++;
    }

    // 评分过滤
    if (ratingMin !== undefined) {
      whereConditions.push(`pv.rating >= $${paramIndex}`);
      params.push(ratingMin);
      paramIndex++;
    }

    if (ratingMax !== undefined) {
      whereConditions.push(`pv.rating <= $${paramIndex}`);
      params.push(ratingMax);
      paramIndex++;
    }

    // 构建 ORDER BY
    let orderByClause = '';
    switch (orderBy) {
      case 'rating':
        orderByClause = 'ORDER BY pv.rating DESC NULLS LAST';
        break;
      case 'recent':
        orderByClause = 'ORDER BY pv."validFrom" DESC';
        break;
      case 'relevance':
      default:
        orderByClause = 'ORDER BY pgroonga_score(tableoid, ctid) DESC';
        break;
    }

    // 查询总数
    const countQuery = `
      SELECT COUNT(*) as total
      FROM "PageVersion" pv
      WHERE ${whereConditions.join(' AND ')}
    `;

    const countResult = await this.prisma.$queryRawUnsafe<Array<{total: bigint}>>(
      countQuery, 
      ...params
    );
    const total = Number(countResult[0].total);

    // 查询结果
    const searchQuery = `
      SELECT 
        pv.id,
        pv."wikidotId",
        pv."pageId",
        pv.title,
        p."currentUrl" as url,
        pv.rating,
        pv.tags,
        COALESCE(
          pgroonga_snippet_html(pv."textContent", pgroonga_query_extract_keywords($1), 200),
          LEFT(pv."textContent", 200)
        ) as snippet,
        pgroonga_score(tableoid, ctid) as score
      FROM "PageVersion" pv
      JOIN "Page" p ON pv."pageId" = p.id
      WHERE ${whereConditions.join(' AND ')}
      ${orderByClause}
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
    `;

    params.push(limit, offset);

    const results = await this.prisma.$queryRawUnsafe<PageSearchResult[]>(
      searchQuery,
      ...params
    );

    return { results, total };
  }

  /**
   * 搜索用户
   */
  async searchUsers(
    query: string, 
    limit: number = 20, 
    offset: number = 0
  ): Promise<{
    results: UserSearchResult[];
    total: number;
  }> {
    // 查询总数
    const countResult = await this.prisma.$queryRaw<Array<{total: bigint}>>`
      SELECT COUNT(*) as total
      FROM "User" u
      WHERE u."displayName" &@~ ${query}
    `;
    const total = Number(countResult[0].total);

    // 查询结果
    const results = await this.prisma.$queryRaw<UserSearchResult[]>`
      SELECT 
        u.id,
        u."wikidotId",
        u."displayName",
        COALESCE(us."totalRating", 0) as "totalRating",
        COALESCE(us."pageCount", 0) as "pageCount"
      FROM "User" u
      LEFT JOIN "UserStats" us ON u.id = us."userId"
      WHERE u."displayName" &@~ ${query}
      ORDER BY us."totalRating" DESC NULLS LAST
      LIMIT ${limit} OFFSET ${offset}
    `;

    return { results, total };
  }

  /**
   * 混合搜索（页面 + 用户）
   */
  async mixedSearch(
    query: string,
    pageLimit: number = 10,
    userLimit: number = 5
  ): Promise<MixedSearchResult> {
    const [pageResults, userResults] = await Promise.all([
      this.searchPages({ query, limit: pageLimit }),
      this.searchUsers(query, userLimit)
    ]);

    return {
      pages: pageResults.results,
      users: userResults.results,
      totalPages: pageResults.total,
      totalUsers: userResults.total
    };
  }

  /**
   * 搜索建议（自动完成）
   */
  async searchSuggestions(
    query: string,
    limit: number = 10
  ): Promise<string[]> {
    // 从标题中获取建议
    const suggestions = await this.prisma.$queryRaw<Array<{title: string}>>`
      SELECT DISTINCT title
      FROM "PageVersion"
      WHERE "validTo" IS NULL
        AND title &@~ ${query}
        AND title IS NOT NULL
      ORDER BY 
        pgroonga_score(tableoid, ctid) DESC,
        rating DESC NULLS LAST
      LIMIT ${limit}
    `;

    return suggestions.map(s => s.title);
  }

  /**
   * 获取热门标签
   */
  async getPopularTags(limit: number = 20): Promise<Array<{tag: string; count: number}>> {
    const tags = await this.prisma.$queryRaw<Array<{tag: string; count: bigint}>>`
      SELECT 
        unnest(tags) as tag,
        COUNT(*) as count
      FROM "PageVersion"
      WHERE "validTo" IS NULL
      GROUP BY tag
      ORDER BY count DESC
      LIMIT ${limit}
    `;

    return tags.map(t => ({
      tag: t.tag,
      count: Number(t.count)
    }));
  }
}