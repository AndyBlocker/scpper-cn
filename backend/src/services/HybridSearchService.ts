import { PrismaClient } from '@prisma/client';
import { EmbeddingService } from './EmbeddingService';
import { Logger } from '../utils/Logger.js';

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

// Deprecated SearchIndex-based hybrid search service; kept for reference but no-op now
export class HybridSearchService {
  private prisma: PrismaClient;
  private embeddingService: EmbeddingService;

  constructor(prisma: PrismaClient, embeddingService: EmbeddingService) {
    this.prisma = prisma;
    this.embeddingService = embeddingService;
  }

  async search(query: string): Promise<{ results: SearchResult[]; stats: SearchStats }> {
    Logger.info('HybridSearchService.search is deprecated; returning empty results');
    return { results: [], stats: { totalResults: 0, searchTime: 0, ftsResults: 0, vectorResults: 0, rerankApplied: false } };
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
        Logger.warn(`Failed to generate highlight for result ${result.pageId}:`, error);
        result.highlightedContent = result.content.substring(0, 200) + '...';
      }
    }

    return results;
  }

  async searchPages(): Promise<{ results: SearchResult[]; stats: SearchStats }> {
    Logger.info('HybridSearchService.searchPages is deprecated; returning empty results');
    return { results: [], stats: { totalResults: 0, searchTime: 0, ftsResults: 0, vectorResults: 0, rerankApplied: false } };
  }

  async similarPages(): Promise<SearchResult[]> {
    Logger.info('HybridSearchService.similarPages is deprecated; returning empty results');
    return [];
  }

  async updateSearchIndex(): Promise<void> {
    Logger.info('HybridSearchService.updateSearchIndex is deprecated; no-op');
  }

  async rebuildSearchVectors(): Promise<void> {
    Logger.info('HybridSearchService.rebuildSearchVectors is deprecated; no-op');
  }
}

// Factory function
export function createHybridSearchService(
  prisma: PrismaClient, 
  embeddingService: EmbeddingService
): HybridSearchService {
  return new HybridSearchService(prisma, embeddingService);
}