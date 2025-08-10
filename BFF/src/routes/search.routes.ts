import { Router } from 'express';
import { SearchController } from '../controllers/search.controller.js';
import { validate, schemas } from '../middleware/validation.middleware.js';
import { cacheMiddleware } from '../middleware/cache.middleware.js';
import { rateLimiters } from '../middleware/rateLimit.middleware.js';
import { CACHE_TTL } from '../types/cache.js';

export function createSearchRoutes(searchController: SearchController): Router {
  const router = Router();

  // 应用搜索特定的限流
  router.use(rateLimiters.search);

  // GET /search - 全文搜索
  router.get(
    '/',
    validate({ query: schemas.searchQuery }),
    cacheMiddleware(CACHE_TTL.SEARCH_RESULTS),
    searchController.search
  );

  // GET /search/suggest - 搜索建议
  router.get(
    '/suggest',
    cacheMiddleware(CACHE_TTL.SEARCH_RESULTS),
    searchController.getSearchSuggestions
  );

  // GET /search/tags - 按标签搜索
  router.get(
    '/tags',
    validate({ query: schemas.tagSearch }),
    cacheMiddleware(CACHE_TTL.SEARCH_RESULTS),
    searchController.searchByTags
  );

  // GET /search/advanced - 高级搜索
  router.get(
    '/advanced',
    cacheMiddleware(CACHE_TTL.SEARCH_RESULTS),
    searchController.advancedSearch
  );

  // GET /search/tags/popular - 获取热门标签
  router.get(
    '/tags/popular',
    cacheMiddleware(CACHE_TTL.SEARCH_RESULTS),
    searchController.getPopularTags
  );

  // GET /search/stats - 获取搜索统计信息
  router.get(
    '/stats',
    cacheMiddleware(CACHE_TTL.SEARCH_RESULTS),
    searchController.getSearchStats
  );

  // POST /search/sync - 同步搜索索引
  router.post(
    '/sync',
    searchController.syncSearchIndex
  );

  // POST /search/cleanup - 清理搜索索引
  router.post(
    '/cleanup',
    searchController.cleanupSearchIndex
  );

  return router;
}