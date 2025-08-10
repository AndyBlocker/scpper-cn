import { Router } from 'express';
import { StatsController } from '../controllers/stats.controller.js';
import { cacheMiddleware } from '../middleware/cache.middleware.js';
import { rateLimiters } from '../middleware/rateLimit.middleware.js';
import { CACHE_TTL } from '../types/cache.js';

export function createStatsRoutes(statsController: StatsController): Router {
  const router = Router();

  // 应用统计特定的限流
  router.use(rateLimiters.stats);

  // GET /stats/site - 站点统计
  router.get(
    '/site',
    cacheMiddleware(CACHE_TTL.SITE_STATS),
    statsController.getSiteStats
  );

  // GET /stats/series - 系列统计
  router.get(
    '/series',
    cacheMiddleware(CACHE_TTL.SERIES_STATS),
    statsController.getSeriesStats
  );

  // GET /stats/series/:number - 特定系列详情
  router.get(
    '/series/:number',
    cacheMiddleware(CACHE_TTL.SERIES_STATS),
    statsController.getSeriesDetail
  );

  // GET /stats/interesting - 有趣统计
  router.get(
    '/interesting',
    cacheMiddleware(CACHE_TTL.SITE_STATS),
    statsController.getInterestingStats
  );

  // GET /stats/trending - 趋势统计
  router.get(
    '/trending',
    cacheMiddleware(CACHE_TTL.HOT_DATA),
    statsController.getTrendingStats
  );


  // GET /stats/tags - 标签统计
  router.get(
    '/tags',
    cacheMiddleware(CACHE_TTL.TAG_METADATA),
    statsController.getTagStats
  );

  return router;
}