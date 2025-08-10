import { PrismaClient } from '@prisma/client';
import { CacheService } from './cache.service.js';
import { SearchResultDTO } from '../types/dto.js';
import { CacheKeyBuilder, CACHE_TTL } from '../types/cache.js';
import { TextProcessor } from '../utils/TextProcessor.js';
import crypto from 'crypto';

export interface SearchParams {
  query: string;
  filters?: {
    tags?: string[];
    hasTitle?: boolean;
    hasContent?: boolean;
    hasSource?: boolean;
    category?: string;
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
  limit?: number;
  offset?: number;
}

export interface AdvancedSearchOptions {
  title?: string;
  content?: string;
  source?: string;
  tags?: { include?: string[]; exclude?: string[] };
  scoringMode?: 'similarity' | 'relevance' | 'length';
  pagination?: { limit?: number; offset?: number };
}

export class SearchService {
  constructor(
    private prisma: PrismaClient,
    private cache: CacheService
  ) {}

  async search(params: SearchParams): Promise<SearchResultDTO> {
    const cacheKey = this.generateOptimizedCacheKey(params);
    
    return this.cache.getOrSet(
      cacheKey,
      async () => {
        const {
          query,
          filters = {},
          pagination = { limit: 20, offset: 0 },
          scoring = { titleWeight: 2, contentWeight: 1, sourceWeight: 0.5 }
        } = params;

        if (!query.trim()) {
          throw new Error('Search query cannot be empty');
        }

        const searchResults = await this.performTrgramSearch(query, filters, pagination, scoring);
        const totalCount = await this.getSearchResultCount(query, filters);
        
        // 获取搜索建议
        const suggestions = await this.generateSuggestions(
          query,
          searchResults
        );
        
        return {
          results: searchResults.map(this.formatSearchResult),
          total: totalCount,
          query: query.trim(),
          filters: filters,
          suggestions,
          pagination: {
            limit: pagination.limit || 20,
            offset: pagination.offset || 0,
            hasMore: (pagination.offset || 0) + searchResults.length < totalCount,
            totalPages: Math.ceil(totalCount / (pagination.limit || 20)),
          },
        };
      },
      CACHE_TTL.SEARCH_RESULTS
    );
  }

  private buildSearchQuery(params: SearchParams) {
    const { query, filters = {}, limit = 20, offset = 0 } = params;
    
    // 优化: 限制单次查询最大数量，防止过大查询
    const safeLimit = Math.min(limit, 100);
    
    // PostgreSQL全文搜索查询构建 - 优化版本
    let whereClause = '';
    const queryParams = [];
    let paramIndex = 1;
    
    if (query && query !== '*') {
      // 优先使用预计算的search_vector字段 (如果存在)
      // 降级到实时计算 (保持兼容性)
      whereClause = `(
        (si.search_vector IS NOT NULL AND si.search_vector @@ plainto_tsquery('english', $${paramIndex}))
        OR
        (si.search_vector IS NULL AND (
          to_tsvector('english', COALESCE(si.title, '')) || 
          to_tsvector('english', COALESCE(si.text_content, '')) ||
          to_tsvector('english', COALESCE(si.source_content, ''))
          @@ plainto_tsquery('english', $${paramIndex})
        ))
      )`;
      queryParams.push(query);
      paramIndex++;
    } else {
      // 匹配所有记录的情况 (如按标签搜索)
      whereClause = '1=1';
    }
    
    // 添加标签过滤
    if (filters.tags && filters.tags.length > 0) {
      whereClause += ` AND pv.tags && $${paramIndex}::text[]`;
      queryParams.push(filters.tags as any);
      paramIndex++;
    }
    
    // 添加分类过滤
    if (filters.category) {
      switch (filters.category) {
        case 'scp':
          whereClause += ` AND pv.tags @> ARRAY['scp', '原创']`;
          break;
        case 'goi':
          whereClause += ` AND pv.tags @> ARRAY['goi格式', '原创']`;
          break;
        case 'story':
          whereClause += ` AND pv.tags @> ARRAY['故事', '原创']`;
          break;
        case 'translation':
          whereClause += ` AND NOT (pv.tags @> ARRAY['原创'])`;
          break;
      }
    }
    
    return { whereClause, queryParams, limit: safeLimit, offset };
  }

  private async executeSearch(searchQuery: any) {
    const { whereClause, queryParams, limit, offset } = searchQuery;
    const query = queryParams[0] || '';
    
    return this.prisma.$queryRawUnsafe(`
      SELECT 
        p.id as "pageId",
        p.url,
        p."urlKey",
        pv.title,
        pv.rating,
        pv."voteCount",
        pv.tags,
        LEFT(COALESCE(si.text_content, ''), 200) as content,
        CASE 
          WHEN si.search_vector IS NOT NULL AND $1 != '' THEN
            ts_rank_cd(si.search_vector, plainto_tsquery('english', $1))
          WHEN $1 != '' THEN
            ts_rank_cd(
              to_tsvector('english', COALESCE(si.title, '')) || 
              to_tsvector('english', COALESCE(si.text_content, '')),
              plainto_tsquery('english', $1)
            )
          ELSE 1.0
        END as score
      FROM "SearchIndex" si
      JOIN "Page" p ON si."pageId" = p.id
      JOIN "PageVersion" pv ON p.id = pv."pageId" AND pv."validTo" IS NULL
      WHERE ${whereClause}
      ORDER BY score DESC, pv.rating DESC
      LIMIT ${limit}
      OFFSET ${offset}
    `, query, ...queryParams);
  }

  private async countSearchResults(searchQuery: any) {
    const { whereClause, queryParams } = searchQuery;
    
    const result = await this.prisma.$queryRawUnsafe(`
      SELECT COUNT(*)::int as count
      FROM "SearchIndex" si
      JOIN "Page" p ON si."pageId" = p.id
      JOIN "PageVersion" pv ON p.id = pv."pageId" AND pv."validTo" IS NULL
      WHERE ${whereClause}
    `, ...queryParams);
    
    return (result as any[])[0]?.count || 0;
  }

  private async generateSuggestions(query: string, results: any[]): Promise<string[]> {
    // 基于搜索结果生成建议
    const suggestions: string[] = [];
    
    // 从结果中提取常见标签作为建议
    const tagCounts = new Map<string, number>();
    
    (results as any[]).forEach(result => {
      if (result.tags) {
        result.tags.forEach((tag: string) => {
          if (tag.includes(query.toLowerCase())) {
            tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
          }
        });
      }
    });
    
    // 按出现频率排序并返回前5个
    const sortedTags = Array.from(tagCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([tag]) => tag);
    
    suggestions.push(...sortedTags);
    
    return suggestions;
  }

  private formatSearchResult = (result: any) => ({
    pageId: result.pageId,
    url: result.url,
    urlKey: result.urlKey,
    title: result.title,
    rating: result.rating,
    voteCount: result.voteCount,
    tags: result.tags || [],
    content: this.truncateContent(result.content, 200),
    score: parseFloat(result.score) || 0,
  });

  private truncateContent(content: string, maxLength: number): string {
    if (!content || content.length <= maxLength) return content || '';
    return content.substring(0, maxLength) + '...';
  }

  private generateOptimizedCacheKey(params: SearchParams): string {
    // 优化缓存键生成，确保稳定性和唯一性
    const query = params.query?.toLowerCase()?.trim() || '';
    const filters = params.filters || {};
    const keyData = {
      q: query,
      tags: filters.tags?.sort() || [],
      category: filters.category || '',
      limit: Math.min(params.limit || 20, 100),
      offset: params.offset || 0
    };
    
    const keyString = JSON.stringify(keyData);
    const hash = crypto.createHash('md5').update(keyString).digest('hex');
    return `search:v2:${hash}`;
  }

  /**
   * 使用预计算搜索向量执行增强搜索
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
    let whereConditions = [];
    let params: any[] = [];
    let paramIndex = 1;

    // 主搜索条件：优先使用预计算的search_vector
    if (query && query.trim()) {
      whereConditions.push(`(
        si.search_vector @@ plainto_tsquery('english', $${paramIndex})
        OR si.title ILIKE $${paramIndex + 1}
      )`);
      params.push(query.trim(), `%${query.trim()}%`);
      paramIndex += 2;
    }

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

    if (whereConditions.length === 0) {
      whereConditions.push('1=1'); // 匹配所有
    }

    const whereClause = whereConditions.join(' AND ');
    
    params.push(limit, offset);
    const limitParam = paramIndex;
    const offsetParam = paramIndex + 1;

    // 使用预计算向量的优化查询
    const sql = `
      SELECT 
        si."pageId",
        si.title,
        si.url,
        si.tags,
        si.random_sentences,
        si.content_stats,
        CASE 
          WHEN si.search_vector IS NOT NULL AND $1 != '' THEN
            ts_rank_cd(si.search_vector, plainto_tsquery('english', $1)) * 10.0
          WHEN si.title ILIKE $2 THEN 5.0
          ELSE 1.0
        END as score
      FROM "SearchIndex" si
      WHERE ${whereClause}
      ORDER BY score DESC, si."pageId" ASC
      LIMIT $${limitParam}
      OFFSET $${offsetParam}
    `;

    console.log('🔍 Enhanced Search SQL:', sql.replace(/\s+/g, ' '));
    console.log('📝 Parameters:', params);

    const searchResults = await this.prisma.$queryRawUnsafe<Array<{
      pageId: number;
      title: string;
      url: string;
      tags: string[];
      random_sentences: string[];
      content_stats: any;
      score: number;
    }>>(sql, query || '', `%${query || ''}%`, ...params.slice(2));

    // 格式化结果，使用预计算的句子作为内容预览
    return searchResults.map(result => ({
      pageId: result.pageId,
      title: result.title,
      url: result.url,
      tags: result.tags,
      score: result.score,
      content: result.random_sentences?.[0] || '', // 使用预计算的第一句作为预览
      contentStats: result.content_stats,
      titleSimilarity: 0, // 向后兼容
      contentSimilarity: 0,
      sourceSimilarity: 0
    }));
  }

  /**
   * 获取搜索结果总数（优化版）
   */
  private async getSearchResultCount(query: string, filters: any): Promise<number> {
    const { tags, hasTitle, hasContent, hasSource } = filters;

    // 构建基础WHERE条件
    let whereConditions = [];
    let params: any[] = [];
    let paramIndex = 1;

    // 主搜索条件：优先使用预计算的search_vector
    if (query && query.trim()) {
      whereConditions.push(`(
        si.search_vector @@ plainto_tsquery('english', $${paramIndex})
        OR si.title ILIKE $${paramIndex + 1}
      )`);
      params.push(query.trim(), `%${query.trim()}%`);
      paramIndex += 2;
    }

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

    if (whereConditions.length === 0) {
      whereConditions.push('1=1'); // 匹配所有
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
   * 高级搜索（使用预计算数据的优化版本）
   */
  async advancedSearch(options: AdvancedSearchOptions) {
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

    const safeLimit = Math.min(limit, 50);

    let whereConditions = [];
    let params: any[] = [];
    let paramIndex = 1;

    // 1. 标签过滤（最高效）
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

    // 2. 标题搜索
    if (title) {
      whereConditions.push(`si.title ILIKE $${paramIndex}`);
      params.push(`%${title}%`);
      paramIndex++;
    }

    // 3. 内容搜索 - 使用预计算的search_vector
    if (content) {
      if (content.length < 2) {
        throw new Error('Content search requires at least 2 characters');
      }
      
      whereConditions.push(`si.search_vector @@ plainto_tsquery('english', $${paramIndex})`);
      params.push(content);
      paramIndex++;
    }

    // 4. 源码搜索（保守使用）
    if (source) {
      if (source.length < 3) {
        throw new Error('Source search requires at least 3 characters');
      }
      whereConditions.push(`si.source_content ILIKE $${paramIndex}`);
      params.push(`%${source}%`);
      paramIndex++;
    }

    if (whereConditions.length === 0) {
      throw new Error('At least one search field must be specified');
    }

    // 使用预计算数据的评分
    let scoreClause = 'COALESCE(';
    let scoreComponents = [];
    
    if (title) {
      scoreComponents.push(`(CASE WHEN si.title ILIKE $${paramIndex} THEN 3.0 ELSE 0 END)`);
      params.push(`%${title}%`);
      paramIndex++;
    }
    
    if (content) {
      scoreComponents.push(`(CASE WHEN si.search_vector @@ plainto_tsquery('english', $${paramIndex}) THEN ts_rank_cd(si.search_vector, plainto_tsquery('english', $${paramIndex})) * 10 ELSE 0 END)`);
      params.push(content, content);
      paramIndex += 2;
    }

    if (scoreComponents.length > 0) {
      scoreClause += scoreComponents.join(' + ') + ', 1.0)';
    } else {
      scoreClause = '1.0';
    }

    // 排序
    let orderBy = '';
    switch (scoringMode) {
      case 'relevance':
        orderBy = `ORDER BY (${scoreClause}) DESC, char_length(COALESCE(si.title, '')) ASC`;
        break;
      case 'length':
        orderBy = `ORDER BY jsonb_extract_path_text(si.content_stats, 'contentLength')::int DESC NULLS LAST`;
        break;
      default: // similarity
        orderBy = `ORDER BY (${scoreClause}) DESC, si."pageId" ASC`;
    }

    const whereClause = `WHERE ${whereConditions.join(' AND ')}`;
    
    params.push(safeLimit, offset);
    const limitParam = paramIndex;
    const offsetParam = paramIndex + 1;

    const sql = `
      SELECT 
        si."pageId",
        si.title,
        si.url,
        si.tags,
        si.random_sentences,
        si.content_stats,
        (${scoreClause}) AS score
      FROM "SearchIndex" si
      ${whereClause}
      ${orderBy}
      LIMIT $${limitParam}
      OFFSET $${offsetParam}
    `;

    console.log('🔍 Enhanced Advanced Search SQL:', sql.replace(/\s+/g, ' '));

    const results = await this.prisma.$queryRawUnsafe<Array<{
      pageId: number;
      title: string;
      url: string;
      tags: string[];
      random_sentences: string[];
      content_stats: any;
      score: number;
    }>>(sql, ...params);

    // 计数查询
    let totalCount = 0;
    if (results.length === safeLimit || offset > 0) {
      const countParams = params.slice(0, -2);
      const countSql = `
        SELECT COUNT(*) as count
        FROM "SearchIndex" si
        ${whereClause}
      `;
      const countResult = await this.prisma.$queryRawUnsafe<Array<{ count: bigint }>>(countSql, ...countParams);
      totalCount = Number(countResult[0].count);
    } else {
      totalCount = results.length;
    }

    return {
      results: results.map(result => ({
        pageId: result.pageId,
        title: result.title,
        url: result.url,
        tags: result.tags,
        score: result.score,
        content: result.random_sentences?.[0] || '',
        contentStats: result.content_stats
      })),
      total: totalCount,
      options,
      pagination: {
        limit: safeLimit,
        offset,
        hasMore: offset + results.length < totalCount
      }
    };
  }

  /**
   * 同步单个页面到搜索索引（增强版）
   */
  async syncPageToSearchIndex(pageId: number) {
    console.log(`🔄 Syncing enhanced search index for page ${pageId}...`);
    
    // 1. 获取原始数据
    const rawData = await this.prisma.$queryRaw<Array<{
      pageId: number;
      title: string | null;
      url: string;
      tags: string[];
      textContent: string | null;
      source: string | null;
    }>>`
      SELECT 
        pv."pageId",
        pv.title,
        p.url,
        pv.tags,
        pv."textContent",
        pv.source
      FROM "PageVersion" pv
      JOIN "Page" p ON p.id = pv."pageId"
      WHERE pv."pageId" = ${pageId}
        AND pv."validTo" IS NULL 
        AND pv."isDeleted" = false
    `;

    if (rawData.length === 0) {
      console.warn(`⚠️  No data found for page ${pageId}`);
      return;
    }

    const row = rawData[0];

    // 2. 使用TextProcessor计算增强字段
    try {
      const randomSentences = TextProcessor.extractRandomSentences(row.textContent || '', 4);
      const contentStats = TextProcessor.calculateContentStats(
        row.title || '',
        row.textContent || '',
        row.source || ''
      );

      // 3. 插入或更新增强数据
      await this.prisma.$executeRaw`
        INSERT INTO "SearchIndex" (
          "pageId", title, url, tags, text_content, source_content, 
          search_vector, random_sentences, content_stats, "updatedAt"
        ) VALUES (
          ${row.pageId},
          ${row.title},
          ${row.url},
          ${row.tags}::text[],
          ${row.textContent},
          ${row.source},
          calculate_search_vector_enhanced(${row.title}, ${row.textContent}, ${row.source}),
          ${randomSentences}::text[],
          ${JSON.stringify(contentStats)}::jsonb,
          now()
        )
        ON CONFLICT ("pageId") DO UPDATE SET
          title = EXCLUDED.title,
          url = EXCLUDED.url,
          tags = EXCLUDED.tags,
          text_content = EXCLUDED.text_content,
          source_content = EXCLUDED.source_content,
          search_vector = EXCLUDED.search_vector,
          random_sentences = EXCLUDED.random_sentences,
          content_stats = EXCLUDED.content_stats,
          "updatedAt" = EXCLUDED."updatedAt"
      `;

      console.log(`✅ Enhanced sync completed for page ${pageId}`);
    } catch (error) {
      console.warn(`⚠️  Enhanced sync failed for page ${pageId}:`, error);
      
      // 降级到基础同步
      await this.prisma.$executeRaw`
        INSERT INTO "SearchIndex" ("pageId", title, url, tags, text_content, source_content, "updatedAt")
        SELECT 
          ${row.pageId},
          ${row.title},
          ${row.url},
          ${row.tags}::text[],
          ${row.textContent},
          ${row.source},
          now()
        ON CONFLICT ("pageId") DO UPDATE SET
          title = EXCLUDED.title,
          url = EXCLUDED.url,
          tags = EXCLUDED.tags,
          text_content = EXCLUDED.text_content,
          source_content = EXCLUDED.source_content,
          "updatedAt" = EXCLUDED."updatedAt"
      `;
    }
  }

  /**
   * 批量同步页面到搜索索引（增强版）
   */
  async syncPagesToSearchIndex(pageIds?: number[]) {
    console.log(`🔄 Starting enhanced batch sync for ${pageIds?.length || 'all'} pages...`);
    
    // 获取目标页面ID列表
    let targetPageIds: number[];
    if (pageIds && pageIds.length > 0) {
      targetPageIds = pageIds;
    } else {
      const allPages = await this.prisma.$queryRaw<Array<{ pageId: number }>>`
        SELECT DISTINCT pv."pageId" as "pageId"
        FROM "PageVersion" pv
        WHERE pv."validTo" IS NULL AND pv."isDeleted" = false
      `;
      targetPageIds = allPages.map(p => p.pageId);
    }

    if (targetPageIds.length === 0) {
      console.log('🔄 No pages to sync');
      return;
    }

    // 分批处理，避免单次操作过大
    const batchSize = 200; // 比Backend小一点，BFF资源有限
    let processed = 0;
    let enhanced = 0;

    for (let i = 0; i < targetPageIds.length; i += batchSize) {
      const batch = targetPageIds.slice(i, i + batchSize);
      
      console.log(`📦 Processing batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(targetPageIds.length/batchSize)} (${batch.length} pages)...`);
      
      // 1. 获取原始数据
      const rawData = await this.prisma.$queryRaw<Array<{
        pageId: number;
        title: string | null;
        url: string;
        tags: string[];
        textContent: string | null;
        source: string | null;
      }>>`
        SELECT 
          pv."pageId",
          pv.title,
          p.url,
          pv.tags,
          pv."textContent",
          pv.source
        FROM "PageVersion" pv
        JOIN "Page" p ON p.id = pv."pageId"
        WHERE pv."pageId" = ANY(${batch}::int[])
          AND pv."validTo" IS NULL 
          AND pv."isDeleted" = false
      `;

      if (rawData.length === 0) continue;

      // 2. 删除当前批次的现有索引
      await this.prisma.$executeRaw`
        DELETE FROM "SearchIndex" 
        WHERE "pageId" = ANY(${batch}::int[])
      `;

      // 3. 处理每个页面的增强数据
      for (const row of rawData) {
        try {
          const randomSentences = TextProcessor.extractRandomSentences(row.textContent || '', 4);
          const contentStats = TextProcessor.calculateContentStats(
            row.title || '',
            row.textContent || '',
            row.source || ''
          );

          // 4. 插入增强数据
          await this.prisma.$executeRaw`
            INSERT INTO "SearchIndex" (
              "pageId", title, url, tags, text_content, source_content, 
              search_vector, random_sentences, content_stats, "updatedAt"
            ) VALUES (
              ${row.pageId},
              ${row.title},
              ${row.url},
              ${row.tags}::text[],
              ${row.textContent},
              ${row.source},
              calculate_search_vector_enhanced(${row.title}, ${row.textContent}, ${row.source}),
              ${randomSentences}::text[],
              ${JSON.stringify(contentStats)}::jsonb,
              now()
            )
          `;
          enhanced++;
        } catch (error) {
          console.warn(`⚠️  Failed to enhance page ${row.pageId}:`, error);
          
          // 降级到基础插入
          await this.prisma.$executeRaw`
            INSERT INTO "SearchIndex" ("pageId", title, url, tags, text_content, source_content, "updatedAt")
            VALUES (
              ${row.pageId},
              ${row.title},
              ${row.url},
              ${row.tags}::text[],
              ${row.textContent},
              ${row.source},
              now()
            )
          `;
        }
      }

      processed += rawData.length;
      console.log(`  ✅ Processed ${rawData.length} pages in batch (${processed}/${targetPageIds.length} total)`);
    }

    console.log(`✅ Enhanced batch sync completed: ${processed} total, ${enhanced} enhanced`);
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

  async getSearchSuggestions(query: string): Promise<string[]> {
    if (query.length < 2) return [];

    const suggestions = await this.getSuggestions(query, 10);
    return suggestions.map(s => s.title);
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
  const prisma = new PrismaClient();
  const cache = new (await import('./cache.service.js')).CacheService();
  const searchService = new SearchService(prisma, cache);
  
  return await searchService.search({
    query,
    filters: options?.tags ? { tags: options.tags } : undefined,
    pagination: {
      limit: options?.limit,
      offset: options?.offset
    }
  });
}