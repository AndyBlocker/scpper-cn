import { PrismaClient } from '@prisma/client';
import { EmbeddingService } from './EmbeddingService';
import { logger } from '../utils/logger';

interface SearchOptions {
  ftsWeight?: number;
  vectorWeight?: number;
  limit?: number;
  offset?: number;
  lang?: string;
  contentType?: string;
  tags?: string[];
  includeDeleted?: boolean;
  rerank?: boolean;
  minScore?: number;
}

interface SearchResult {
  pageId: number;
  chunkId?: bigint;
  title: string;
  url: string;
  content: string;
  score: number;
  highlightedContent?: string;
  tags: string[];
  contentType?: string;
}

interface SearchStats {
  totalResults: number;
  searchTime: number;
  ftsResults: number;
  vectorResults: number;
  rerankApplied: boolean;
}

export class HybridSearchService {
  private prisma: PrismaClient;
  private embeddingService: EmbeddingService;

  constructor(prisma: PrismaClient, embeddingService: EmbeddingService) {
    this.prisma = prisma;
    this.embeddingService = embeddingService;
  }

  async search(query: string, options: SearchOptions = {}): Promise<{
    results: SearchResult[];
    stats: SearchStats;
  }> {
    const startTime = Date.now();
    
    const {
      ftsWeight = 0.6,
      vectorWeight = 0.4,
      limit = 20,
      offset = 0,
      lang = 'zh',
      contentType,
      tags,
      includeDeleted = false,
      rerank = true,
      minScore = 0.1
    } = options;

    try {
      // Generate query embedding
      const [queryEmbedding] = await this.embeddingService.generateEmbeddings([query]);
      const embeddingStr = `[${queryEmbedding.join(',')}]`;

      // Build WHERE clause
      const whereConditions: string[] = [];
      const params: any[] = [];
      let paramIndex = 1;

      if (!includeDeleted) {
        whereConditions.push(`si."isDeleted" = false`);
      }

      if (contentType) {
        whereConditions.push(`si."contentType" = $${paramIndex++}`);
        params.push(contentType);
      }

      if (tags && tags.length > 0) {
        whereConditions.push(`si.tags && $${paramIndex++}::text[]`);
        params.push(tags);
      }

      const whereClause = whereConditions.length > 0 
        ? `WHERE ${whereConditions.join(' AND ')}` 
        : '';

      // Execute hybrid search query
      const searchQuery = `
        WITH fts_results AS (
          SELECT 
            sc.id as chunk_id,
            sc."pageId",
            ts_rank(sc.tsv, websearch_to_tsquery($1::regconfig, $2)) as fts_score,
            sc.content
          FROM "SearchChunk" sc
          JOIN "SearchIndex" si ON si."pageId" = sc."pageId"
          ${whereClause}
          WHERE sc.tsv @@ websearch_to_tsquery($1::regconfig, $2)
          ORDER BY fts_score DESC
          LIMIT $${paramIndex++}
        ),
        vector_results AS (
          SELECT 
            sc.id as chunk_id,
            sc."pageId",
            1 - (sc.embedding <=> $${paramIndex++}::vector(768)) as vector_score,
            sc.content
          FROM "SearchChunk" sc
          JOIN "SearchIndex" si ON si."pageId" = sc."pageId"
          ${whereClause}
          WHERE sc.embedding IS NOT NULL
          ORDER BY sc.embedding <=> $${paramIndex - 1}::vector(768)
          LIMIT $${paramIndex++}
        ),
        combined_results AS (
          SELECT 
            COALESCE(f.chunk_id, v.chunk_id) as chunk_id,
            COALESCE(f."pageId", v."pageId") as page_id,
            COALESCE(f.content, v.content) as content,
            (
              COALESCE(f.fts_score * $${paramIndex++}, 0) + 
              COALESCE(v.vector_score * $${paramIndex++}, 0)
            ) as combined_score,
            COALESCE(f.fts_score, 0) as fts_score,
            COALESCE(v.vector_score, 0) as vector_score
          FROM fts_results f
          FULL OUTER JOIN vector_results v 
            ON f.chunk_id = v.chunk_id
        )
        SELECT 
          cr.chunk_id,
          cr.page_id,
          cr.content,
          cr.combined_score,
          cr.fts_score,
          cr.vector_score,
          si.title,
          si.url,
          si.tags,
          si."contentType",
          COUNT(*) OVER() as total_count
        FROM combined_results cr
        JOIN "SearchIndex" si ON si."pageId" = cr.page_id
        WHERE cr.combined_score >= $${paramIndex++}
        ORDER BY cr.combined_score DESC
        OFFSET $${paramIndex++}
        LIMIT $${paramIndex++}
      `;

      const queryParams = [
        lang === 'zh' ? 'zh' : 'english',
        query,
        ...params,
        limit * 3, // Get more results for FTS
        embeddingStr,
        limit * 3, // Get more results for vector search
        ftsWeight,
        vectorWeight,
        minScore,
        offset,
        limit
      ];

      const rawResults = await this.prisma.$queryRawUnsafe<any[]>(searchQuery, ...queryParams);

      // Process results
      let results: SearchResult[] = rawResults.map(row => ({
        pageId: row.page_id,
        chunkId: row.chunk_id,
        title: row.title || '',
        url: row.url || '',
        content: row.content || '',
        score: parseFloat(row.combined_score),
        tags: row.tags || [],
        contentType: row.contentType
      }));

      // Apply reranking if requested
      if (rerank && results.length > 0) {
        results = await this.rerankResults(query, results);
      }

      // Generate highlighted content
      results = await this.addHighlights(query, results, lang);

      // Calculate statistics
      const stats: SearchStats = {
        totalResults: rawResults[0]?.total_count || 0,
        searchTime: Date.now() - startTime,
        ftsResults: rawResults.filter(r => r.fts_score > 0).length,
        vectorResults: rawResults.filter(r => r.vector_score > 0).length,
        rerankApplied: rerank
      };

      return { results, stats };

    } catch (error) {
      logger.error('Hybrid search failed:', error);
      throw error;
    }
  }

  private async rerankResults(query: string, results: SearchResult[]): Promise<SearchResult[]> {
    // This would use a cross-encoder reranking model
    // For now, we'll just return the results as-is
    // In production, you'd call a Python service with a reranking model
    return results;
  }

  private async addHighlights(query: string, results: SearchResult[], lang: string): Promise<SearchResult[]> {
    const highlightQuery = `
      SELECT 
        ts_headline(
          $1::regconfig, 
          $2::text, 
          websearch_to_tsquery($1::regconfig, $3::text),
          'MaxWords=50, MinWords=20, ShortWord=2, HighlightAll=false, FragmentDelimiter=" ... "'
        ) as highlighted
    `;

    const config = lang === 'zh' ? 'zh' : 'english';

    for (const result of results) {
      try {
        const [{ highlighted }] = await this.prisma.$queryRawUnsafe<any[]>(
          highlightQuery,
          config,
          result.content,
          query
        );
        result.highlightedContent = highlighted;
      } catch (error) {
        logger.warn(`Failed to generate highlight for result ${result.pageId}:`, error);
        result.highlightedContent = result.content.substring(0, 200) + '...';
      }
    }

    return results;
  }

  async searchPages(query: string, options: SearchOptions = {}): Promise<{
    results: SearchResult[];
    stats: SearchStats;
  }> {
    // Page-level search (not chunk-based)
    const startTime = Date.now();
    
    const {
      ftsWeight = 0.6,
      vectorWeight = 0.4,
      limit = 20,
      offset = 0,
      lang = 'zh',
      contentType,
      tags,
      includeDeleted = false,
      minScore = 0.1
    } = options;

    try {
      // Generate query embedding
      const [queryEmbedding] = await this.embeddingService.generateEmbeddings([query]);
      const embeddingStr = `[${queryEmbedding.join(',')}]`;

      // Build WHERE clause
      const whereConditions: string[] = [];
      const params: any[] = [];
      let paramIndex = 1;

      if (!includeDeleted) {
        whereConditions.push(`"isDeleted" = false`);
      }

      if (contentType) {
        whereConditions.push(`"contentType" = $${paramIndex++}`);
        params.push(contentType);
      }

      if (tags && tags.length > 0) {
        whereConditions.push(`tags && $${paramIndex++}::text[]`);
        params.push(tags);
      }

      const whereClause = whereConditions.length > 0 
        ? `AND ${whereConditions.join(' AND ')}` 
        : '';

      const searchQuery = `
        SELECT 
          "pageId",
          title,
          url,
          tags,
          "contentType",
          COALESCE("contentSummary", LEFT("pureTextContent", 200)) as content,
          (
            $${paramIndex++} * ts_rank("searchVector", websearch_to_tsquery($${paramIndex++}::regconfig, $${paramIndex++})) +
            $${paramIndex++} * (1 - (embedding <=> $${paramIndex++}::vector(768)))
          ) as score,
          COUNT(*) OVER() as total_count
        FROM "SearchIndex"
        WHERE (
          "searchVector" @@ websearch_to_tsquery($3::regconfig, $4) OR
          embedding <=> $7::vector(768) < 0.5
        ) ${whereClause}
        AND (
          $2 * ts_rank("searchVector", websearch_to_tsquery($3::regconfig, $4)) +
          $6 * (1 - (embedding <=> $7::vector(768)))
        ) >= $${paramIndex++}
        ORDER BY score DESC
        OFFSET $${paramIndex++}
        LIMIT $${paramIndex++}
      `;

      const queryParams = [
        ...params,
        ftsWeight,
        lang === 'zh' ? 'zh' : 'english',
        query,
        ftsWeight,
        vectorWeight,
        embeddingStr,
        minScore,
        offset,
        limit
      ];

      const rawResults = await this.prisma.$queryRawUnsafe<any[]>(searchQuery, ...queryParams);

      const results: SearchResult[] = rawResults.map(row => ({
        pageId: row.pageId,
        title: row.title || '',
        url: row.url || '',
        content: row.content || '',
        score: parseFloat(row.score),
        tags: row.tags || [],
        contentType: row.contentType
      }));

      const stats: SearchStats = {
        totalResults: rawResults[0]?.total_count || 0,
        searchTime: Date.now() - startTime,
        ftsResults: results.length, // Simplified for page-level search
        vectorResults: results.length,
        rerankApplied: false
      };

      return { results, stats };

    } catch (error) {
      logger.error('Page search failed:', error);
      throw error;
    }
  }

  async similarPages(pageId: number, options: { limit?: number } = {}): Promise<SearchResult[]> {
    const { limit = 10 } = options;

    try {
      // Get the embedding of the source page
      const sourceEmbedding = await this.prisma.$queryRaw<any[]>`
        SELECT embedding 
        FROM "SearchIndex" 
        WHERE "pageId" = ${pageId}
        LIMIT 1
      `;

      if (!sourceEmbedding.length || !sourceEmbedding[0].embedding) {
        return [];
      }

      // Find similar pages
      const results = await this.prisma.$queryRaw<any[]>`
        SELECT 
          "pageId",
          title,
          url,
          tags,
          "contentType",
          COALESCE("contentSummary", LEFT("pureTextContent", 200)) as content,
          1 - (embedding <=> ${sourceEmbedding[0].embedding}::vector(768)) as score
        FROM "SearchIndex"
        WHERE "pageId" != ${pageId}
          AND "isDeleted" = false
          AND embedding IS NOT NULL
        ORDER BY embedding <=> ${sourceEmbedding[0].embedding}::vector(768)
        LIMIT ${limit}
      `;

      return results.map(row => ({
        pageId: row.pageId,
        title: row.title || '',
        url: row.url || '',
        content: row.content || '',
        score: parseFloat(row.score),
        tags: row.tags || [],
        contentType: row.contentType
      }));

    } catch (error) {
      logger.error('Similar pages search failed:', error);
      throw error;
    }
  }

  async updateSearchIndex(pageId: number): Promise<void> {
    try {
      // Trigger FTS vector update
      await this.prisma.$executeRaw`
        UPDATE "SearchIndex"
        SET "updatedAt" = CURRENT_TIMESTAMP
        WHERE "pageId" = ${pageId}
      `;

      // The trigger will automatically update the search vector
      logger.info(`Updated search index for page ${pageId}`);
    } catch (error) {
      logger.error(`Failed to update search index for page ${pageId}:`, error);
      throw error;
    }
  }

  async rebuildSearchVectors(batchSize: number = 100): Promise<void> {
    try {
      let offset = 0;
      let hasMore = true;

      while (hasMore) {
        const batch = await this.prisma.$queryRaw<any[]>`
          SELECT "pageId", title, tags, "pureTextContent", "languageType"
          FROM "SearchIndex"
          ORDER BY "pageId"
          OFFSET ${offset}
          LIMIT ${batchSize}
        `;

        if (batch.length === 0) {
          hasMore = false;
          break;
        }

        // Trigger vector updates for each page
        for (const page of batch) {
          await this.updateSearchIndex(page.pageId);
        }

        offset += batchSize;
        logger.info(`Rebuilt search vectors for ${offset} pages`);
      }

      logger.info('Search vector rebuild completed');
    } catch (error) {
      logger.error('Failed to rebuild search vectors:', error);
      throw error;
    }
  }
}

// Factory function
export function createHybridSearchService(
  prisma: PrismaClient, 
  embeddingService: EmbeddingService
): HybridSearchService {
  return new HybridSearchService(prisma, embeddingService);
}