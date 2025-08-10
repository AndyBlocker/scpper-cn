import { PrismaClient } from '@prisma/client';

/**
 * 全文搜索服务
 * 基于 reply.md 文档中的搜索方案实现
 * 支持 pg_trgm + GIN 索引的模糊搜索
 */
export class SearchService {
  private prisma: PrismaClient;

  constructor(prisma?: PrismaClient) {
    this.prisma = prisma || new PrismaClient();
  }

  /**
   * 全文搜索（主入口）
   */
  async search(options: {
    query: string;
    filters?: {
      tags?: string[];
      hasTitle?: boolean;
      hasContent?: boolean;
      hasSource?: boolean;
    };
    pagination?: {
      limit?: number;
      offset?: number;
    };
    scoring?: {
      titleWeight?: number;
      contentWeight?: number;
      sourceWeight?: number;
    };
  }) {
    const {
      query,
      filters = {},
      pagination = { limit: 20, offset: 0 },
      scoring = { titleWeight: 2, contentWeight: 1, sourceWeight: 0.5 }
    } = options;

    if (!query.trim()) {
      throw new Error('Search query cannot be empty');
    }

    const searchResults = await this.performTrgramSearch(query, filters, pagination, scoring);
    const totalCount = await this.getSearchResultCount(query, filters);

    return {
      results: searchResults,
      total: totalCount,
      query: query.trim(),
      pagination: {
        limit: pagination.limit || 20,
        offset: pagination.offset || 0,
        hasMore: (pagination.offset || 0) + searchResults.length < totalCount
      }
    };
  }

  /**
   * 使用 pg_trgm 执行搜索
   */
  private async performTrgramSearch(
    query: string, 
    filters: any, 
    pagination: any, 
    scoring: any
  ) {
    const { tags, hasTitle, hasContent, hasSource } = filters;
    const { limit = 20, offset = 0 } = pagination;
    const { titleWeight = 2, contentWeight = 1, sourceWeight = 0.5 } = scoring;

    // 构建基础WHERE条件
    let whereConditions = [`(
        si.title ILIKE $1 
        OR si.text_content ILIKE $1
        OR si.source_content ILIKE $1
      )`];
    let params: any[] = [`%${query}%`];
    let paramIndex = 2;

    // 添加标签过滤
    if (tags && tags.length > 0) {
      whereConditions.push(`si.tags @> $${paramIndex}`);
      params.push(tags);
      paramIndex++;
    }

    // 添加内容过滤
    if (hasTitle) {
      whereConditions.push(`si.title IS NOT NULL AND si.title != ''`);
    }
    if (hasContent) {
      whereConditions.push(`si.text_content IS NOT NULL AND si.text_content != ''`);
    }
    if (hasSource) {
      whereConditions.push(`si.source_content IS NOT NULL AND si.source_content != ''`);
    }

    const whereClause = whereConditions.join(' AND ');
    
    // 添加query参数到scoring计算中
    params.push(query, query, query); // titleWeight, contentWeight, sourceWeight计算需要
    const titleQueryParam = paramIndex;
    const contentQueryParam = paramIndex + 1;
    const sourceQueryParam = paramIndex + 2;
    paramIndex += 3;

    params.push(limit, offset);
    const limitParam = paramIndex;
    const offsetParam = paramIndex + 1;

    const sql = `
      SELECT 
        si."pageId",
        si.title,
        si.url,
        si.tags,
        (similarity(COALESCE(si.title, ''), $${titleQueryParam}) * ${titleWeight}
         + similarity(COALESCE(si.text_content, ''), $${contentQueryParam}) * ${contentWeight}
         + similarity(COALESCE(si.source_content, ''), $${sourceQueryParam}) * ${sourceWeight}
        ) AS score,
        similarity(COALESCE(si.title, ''), $${titleQueryParam}) AS "titleSimilarity",
        similarity(COALESCE(si.text_content, ''), $${contentQueryParam}) AS "contentSimilarity",
        similarity(COALESCE(si.source_content, ''), $${sourceQueryParam}) AS "sourceSimilarity"
      FROM "SearchIndex" si
      WHERE ${whereClause}
      ORDER BY score DESC, si."pageId" ASC
      LIMIT $${limitParam}
      OFFSET $${offsetParam}
    `;

    const searchResults = await this.prisma.$queryRawUnsafe<Array<{
      pageId: number;
      title: string;
      url: string;
      tags: string[];
      score: number;
      titleSimilarity: number;
      contentSimilarity: number;
      sourceSimilarity: number;
    }>>(sql, ...params);

    return searchResults;
  }

  /**
   * 获取搜索结果总数
   */
  private async getSearchResultCount(query: string, filters: any): Promise<number> {
    const { tags, hasTitle, hasContent, hasSource } = filters;

    // 构建基础WHERE条件
    let whereConditions = [`(
        si.title ILIKE $1 
        OR si.text_content ILIKE $1
        OR si.source_content ILIKE $1
      )`];
    let params: any[] = [`%${query}%`];
    let paramIndex = 2;

    // 添加标签过滤
    if (tags && tags.length > 0) {
      whereConditions.push(`si.tags @> $${paramIndex}`);
      params.push(tags);
      paramIndex++;
    }

    // 添加内容过滤
    if (hasTitle) {
      whereConditions.push(`si.title IS NOT NULL AND si.title != ''`);
    }
    if (hasContent) {
      whereConditions.push(`si.text_content IS NOT NULL AND si.text_content != ''`);
    }
    if (hasSource) {
      whereConditions.push(`si.source_content IS NOT NULL AND si.source_content != ''`);
    }

    const whereClause = whereConditions.join(' AND ');
    const sql = `
      SELECT COUNT(*) as count
      FROM "SearchIndex" si
      WHERE ${whereClause}
    `;

    const result = await this.prisma.$queryRawUnsafe<Array<{ count: bigint }>>(sql, ...params);
    return Number(result[0].count);
  }

  /**
   * 标签搜索（精确匹配）
   */
  async searchByTags(tags: string[], options: { limit?: number; offset?: number } = {}) {
    const { limit = 20, offset = 0 } = options;

    const results = await this.prisma.$queryRaw<Array<{
      pageId: number;
      title: string;
      url: string;
      tags: string[];
      matchedTags: number;
    }>>`
      SELECT 
        si."pageId",
        si.title,
        si.url,
        si.tags,
        array_length(array(select unnest(si.tags) intersect select unnest(${tags})), 1) as "matchedTags"
      FROM "SearchIndex" si
      WHERE si.tags && ${tags}
      ORDER BY "matchedTags" DESC, si.title ASC
      LIMIT ${limit}
      OFFSET ${offset}
    `;

    const totalCount = await this.prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*) as count
      FROM "SearchIndex" si
      WHERE si.tags && ${tags}
    `;

    return {
      results,
      total: Number(totalCount[0].count),
      tags,
      pagination: {
        limit,
        offset,
        hasMore: offset + results.length < Number(totalCount[0].count)
      }
    };
  }

  /**
   * 获取热门搜索标签
   */
  async getPopularTags(limit: number = 20) {
    const results = await this.prisma.$queryRaw<Array<{
      tag: string;
      pageCount: bigint;
    }>>`
      SELECT 
        unnest(si.tags) as tag,
        COUNT(*) as "pageCount"
      FROM "SearchIndex" si
      WHERE array_length(si.tags, 1) > 0
      GROUP BY unnest(si.tags)
      ORDER BY "pageCount" DESC
      LIMIT ${limit}
    `;

    return results.map(r => ({
      tag: r.tag,
      pageCount: Number(r.pageCount)
    }));
  }

  /**
   * 搜索建议（自动补全）
   */
  async getSuggestions(query: string, limit: number = 10) {
    if (!query.trim()) return [];

    const results = await this.prisma.$queryRaw<Array<{
      title: string;
      url: string;
      similarity: number;
    }>>`
      SELECT 
        si.title,
        si.url,
        similarity(si.title, ${query}) as similarity
      FROM "SearchIndex" si
      WHERE si.title IS NOT NULL 
        AND si.title ILIKE ${`%${query}%`}
        AND similarity(si.title, ${query}) > 0.1
      ORDER BY similarity DESC, length(si.title) ASC
      LIMIT ${limit}
    `;

    return results;
  }

  /**
   * 高级搜索（支持多字段、操作符等）
   */
  async advancedSearch(options: {
    title?: string;
    content?: string;
    source?: string;
    tags?: { include?: string[]; exclude?: string[] };
    scoringMode?: 'similarity' | 'relevance' | 'length';
    pagination?: { limit?: number; offset?: number };
  }) {
    const {
      title,
      content,
      source,
      tags = {},
      scoringMode = 'similarity',
      pagination = { limit: 20, offset: 0 }
    } = options;

    const { limit = 20, offset = 0 } = pagination;
    const { include: includeTags = [], exclude: excludeTags = [] } = tags;

    let whereConditions = [];
    let scoreComponents = [];
    let params: any[] = [];
    let paramIndex = 1;

    // 构建搜索条件和评分组件
    if (title) {
      whereConditions.push(`si.title ILIKE $${paramIndex}`);
      scoreComponents.push(`similarity(COALESCE(si.title, ''), $${paramIndex + 1}) * 3`);
      params.push(`%${title}%`, title);
      paramIndex += 2;
    }

    if (content) {
      whereConditions.push(`si.text_content ILIKE $${paramIndex}`);
      scoreComponents.push(`similarity(COALESCE(si.text_content, ''), $${paramIndex + 1}) * 2`);
      params.push(`%${content}%`, content);
      paramIndex += 2;
    }

    if (source) {
      whereConditions.push(`si.source_content ILIKE $${paramIndex}`);
      scoreComponents.push(`similarity(COALESCE(si.source_content, ''), $${paramIndex + 1})`);
      params.push(`%${source}%`, source);
      paramIndex += 2;
    }

    // 标签过滤
    if (includeTags.length > 0) {
      whereConditions.push(`si.tags @> $${paramIndex}`);
      params.push(includeTags);
      paramIndex++;
    }
    if (excludeTags.length > 0) {
      whereConditions.push(`NOT (si.tags && $${paramIndex})`);
      params.push(excludeTags);
      paramIndex++;
    }

    if (whereConditions.length === 0) {
      throw new Error('At least one search field must be specified');
    }

    const whereClause = `WHERE ${whereConditions.join(' AND ')}`;
    const scoreClause = scoreComponents.length > 0 ? scoreComponents.join(' + ') : '0';

    let orderBy = '';
    switch (scoringMode) {
      case 'relevance':
        orderBy = `ORDER BY (${scoreClause}) DESC, char_length(COALESCE(si.title, '')) ASC`;
        break;
      case 'length':
        orderBy = `ORDER BY char_length(COALESCE(si.text_content, '')) DESC`;
        break;
      default: // similarity
        orderBy = `ORDER BY (${scoreClause}) DESC`;
    }

    params.push(limit, offset);
    const limitParam = paramIndex;
    const offsetParam = paramIndex + 1;

    const sql = `
      SELECT 
        si."pageId",
        si.title,
        si.url,
        si.tags,
        (${scoreClause}) AS score
      FROM "SearchIndex" si
      ${whereClause}
      ${orderBy}
      LIMIT $${limitParam}
      OFFSET $${offsetParam}
    `;

    const results = await this.prisma.$queryRawUnsafe<Array<{
      pageId: number;
      title: string;
      url: string;
      tags: string[];
      score: number;
    }>>(sql, ...params);

    // 获取总数（去除limit/offset参数）
    const countParams = params.slice(0, -2);
    const countSql = `
      SELECT COUNT(*) as count
      FROM "SearchIndex" si
      ${whereClause}
    `;

    const totalCount = await this.prisma.$queryRawUnsafe<Array<{ count: bigint }>>(countSql, ...countParams);

    return {
      results,
      total: Number(totalCount[0].count),
      options,
      pagination: {
        limit,
        offset,
        hasMore: offset + results.length < Number(totalCount[0].count)
      }
    };
  }

  /**
   * 同步单个页面到搜索索引
   */
  async syncPageToSearchIndex(pageId: number) {
    await this.prisma.$executeRaw`
      INSERT INTO "SearchIndex" ("pageId", title, url, tags, text_content, source_content, "updatedAt")
      SELECT 
        pv."pageId",
        pv.title,
        p.url,
        pv.tags,
        pv."textContent",
        pv.source,
        now()
      FROM "PageVersion" pv
      JOIN "Page" p ON p.id = pv."pageId"
      WHERE pv."pageId" = ${pageId}
        AND pv."validTo" IS NULL 
        AND pv."isDeleted" = false
      ON CONFLICT ("pageId") DO UPDATE SET
        title = EXCLUDED.title,
        url = EXCLUDED.url,
        tags = EXCLUDED.tags,
        text_content = EXCLUDED.text_content,
        source_content = EXCLUDED.source_content,
        "updatedAt" = EXCLUDED."updatedAt"
    `;
  }

  /**
   * 批量同步页面到搜索索引
   */
  async syncPagesToSearchIndex(pageIds?: number[]) {
    if (pageIds && pageIds.length > 0) {
      // 有指定页面ID
      await this.prisma.$executeRaw`
        INSERT INTO "SearchIndex" ("pageId", title, url, tags, text_content, source_content, "updatedAt")
        SELECT 
          pv."pageId",
          pv.title,
          p.url,
          pv.tags,
          pv."textContent",
          pv.source,
          now()
        FROM "PageVersion" pv
        JOIN "Page" p ON p.id = pv."pageId"
        WHERE pv."validTo" IS NULL 
          AND pv."isDeleted" = false
          AND pv."pageId" = ANY(${pageIds}::int[])
        ON CONFLICT ("pageId") DO UPDATE SET
          title = EXCLUDED.title,
          url = EXCLUDED.url,
          tags = EXCLUDED.tags,
          text_content = EXCLUDED.text_content,
          source_content = EXCLUDED.source_content,
          "updatedAt" = EXCLUDED."updatedAt"
      `;
    } else {
      // 同步所有页面
      await this.prisma.$executeRaw`
        INSERT INTO "SearchIndex" ("pageId", title, url, tags, text_content, source_content, "updatedAt")
        SELECT 
          pv."pageId",
          pv.title,
          p.url,
          pv.tags,
          pv."textContent",
          pv.source,
          now()
        FROM "PageVersion" pv
        JOIN "Page" p ON p.id = pv."pageId"
        WHERE pv."validTo" IS NULL 
          AND pv."isDeleted" = false
        ON CONFLICT ("pageId") DO UPDATE SET
          title = EXCLUDED.title,
          url = EXCLUDED.url,
          tags = EXCLUDED.tags,
          text_content = EXCLUDED.text_content,
          source_content = EXCLUDED.source_content,
          "updatedAt" = EXCLUDED."updatedAt"
      `;
    }

    console.log(`✅ Synced ${pageIds?.length || 'all'} pages to search index`);
  }

  /**
   * 获取搜索统计信息
   */
  async getSearchStats() {
    const stats = await this.prisma.$queryRaw<Array<{
      total_indexed_pages: bigint;
      pages_with_title: bigint;
      pages_with_content: bigint;
      pages_with_source: bigint;
      total_tags: bigint;
      avg_tags_per_page: number;
      last_updated: Date;
    }>>`
      SELECT 
        COUNT(*) as total_indexed_pages,
        COUNT(CASE WHEN title IS NOT NULL AND title != '' THEN 1 END) as pages_with_title,
        COUNT(CASE WHEN text_content IS NOT NULL AND text_content != '' THEN 1 END) as pages_with_content,
        COUNT(CASE WHEN source_content IS NOT NULL AND source_content != '' THEN 1 END) as pages_with_source,
        SUM(array_length(tags, 1)) as total_tags,
        AVG(array_length(tags, 1)) as avg_tags_per_page,
        MAX("updatedAt") as last_updated
      FROM "SearchIndex"
    `;

    const result = stats[0];
    return {
      totalIndexedPages: Number(result.total_indexed_pages),
      pagesWithTitle: Number(result.pages_with_title),
      pagesWithContent: Number(result.pages_with_content),
      pagesWithSource: Number(result.pages_with_source),
      totalTags: Number(result.total_tags),
      avgTagsPerPage: result.avg_tags_per_page,
      lastUpdated: result.last_updated
    };
  }

  /**
   * 清理过期的搜索索引
   */
  async cleanupOrphanedSearchIndex() {
    const deletedCount = await this.prisma.$executeRaw`
      DELETE FROM "SearchIndex" si
      WHERE NOT EXISTS (
        SELECT 1 FROM "Page" p 
        WHERE p.id = si."pageId"
      )
    `;

    console.log(`🧹 Cleaned up orphaned search index entries: ${deletedCount}`);
    return deletedCount;
  }
}

/**
 * 便捷的搜索函数
 */
export async function searchPages(query: string, options?: {
  tags?: string[];
  limit?: number;
  offset?: number;
}) {
  const searchService = new SearchService();
  return await searchService.search({
    query,
    filters: options?.tags ? { tags: options.tags } : undefined,
    pagination: {
      limit: options?.limit,
      offset: options?.offset
    }
  });
}