import { Request, Response } from 'express';
import { SearchService } from '../services/search.service.js';
import type { AdvancedSearchOptions } from '../services/search.service.js';
import { ResponseBuilder } from '../types/api.js';
import { asyncHandler } from '../middleware/error.middleware.js';

export class SearchController {
  constructor(private searchService: SearchService) {}

  search = asyncHandler(async (req: Request, res: Response) => {
    const { q, tags, category, sort } = req.query as any;
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const offset = (page - 1) * limit;

    if (!q || q.trim().length === 0) {
      return res.status(400).json(
        ResponseBuilder.error('VALIDATION_ERROR', 'Search query is required')
      );
    }

    const searchResult = await this.searchService.search({
      query: q.trim(),
      filters: {
        tags: tags ? tags.split(',').filter(Boolean) : undefined,
        category,
      },
      limit,
      offset,
    });

    res.json(ResponseBuilder.success(searchResult));
  });

  getSearchSuggestions = asyncHandler(async (req: Request, res: Response) => {
    const { q } = req.query as any;

    if (!q || q.trim().length < 2) {
      return res.json(ResponseBuilder.success([]));
    }

    const suggestions = await this.searchService.getSearchSuggestions(q.trim());
    res.json(ResponseBuilder.success(suggestions));
  });

  searchByTags = asyncHandler(async (req: Request, res: Response) => {
    const { tags } = req.query as any;
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;

    if (!tags) {
      return res.status(400).json(
        ResponseBuilder.error('VALIDATION_ERROR', 'Tags parameter is required')
      );
    }

    const tagList = Array.isArray(tags) ? tags : tags.split(',').filter(Boolean);
    if (tagList.length === 0) {
      return res.status(400).json(
        ResponseBuilder.error('VALIDATION_ERROR', 'At least one tag is required')
      );
    }

    // Use the search service with tag filters
    const searchResult = await this.searchService.search({
      query: '*', // Match all documents
      filters: {
        tags: tagList,
      },
      limit,
      offset: (page - 1) * limit,
    });

    res.json(ResponseBuilder.success(searchResult));
  });

  advancedSearch = asyncHandler(async (req: Request, res: Response) => {
    const {
      title,
      content,
      source,
      includeTags,
      excludeTags,
      scoringMode,
    } = req.query as any;

    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const offset = (page - 1) * limit;

    // Build advanced search options
    const options: AdvancedSearchOptions = {
      pagination: { limit, offset }
    };
    
    if (title) options.title = title;
    if (content) options.content = content;
    if (source) options.source = source;
    if (scoringMode) options.scoringMode = scoringMode;
    
    if (includeTags || excludeTags) {
      options.tags = {};
      if (includeTags) {
        options.tags.include = includeTags.split(',').filter(Boolean);
      }
      if (excludeTags) {
        options.tags.exclude = excludeTags.split(',').filter(Boolean);
      }
    }

    const searchResult = await this.searchService.advancedSearch(options);
    res.json(ResponseBuilder.success(searchResult));
  });

  // 新增API端点
  getPopularTags = asyncHandler(async (req: Request, res: Response) => {
    const limit = parseInt(req.query.limit as string) || 20;
    const tags = await this.searchService.getPopularTags(limit);
    res.json(ResponseBuilder.success(tags));
  });

  getSearchStats = asyncHandler(async (req: Request, res: Response) => {
    const stats = await this.searchService.getSearchStats();
    res.json(ResponseBuilder.success(stats));
  });

  syncSearchIndex = asyncHandler(async (req: Request, res: Response) => {
    const { pageIds } = req.body;
    
    if (pageIds && !Array.isArray(pageIds)) {
      return res.status(400).json(
        ResponseBuilder.error('VALIDATION_ERROR', 'pageIds must be an array')
      );
    }

    await this.searchService.syncPagesToSearchIndex(pageIds);
    res.json(ResponseBuilder.success({ message: 'Search index synced successfully' }));
  });

  cleanupSearchIndex = asyncHandler(async (req: Request, res: Response) => {
    const deletedCount = await this.searchService.cleanupOrphanedSearchIndex();
    res.json(ResponseBuilder.success({ deletedCount }));
  });
}