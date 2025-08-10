import { Router } from 'express';
import { PageController } from '../controllers/page.controller.js';
import { validate, schemas } from '../middleware/validation.middleware.js';
import { cacheMiddleware } from '../middleware/cache.middleware.js';
import { CACHE_TTL } from '../types/cache.js';

export function createPageRoutes(pageController: PageController): Router {
  const router = Router();

  // GET /pages - 获取页面列表
  router.get(
    '/',
    validate({ query: schemas.pageListQuery }),
    cacheMiddleware(CACHE_TTL.PAGE_DETAIL),
    pageController.getPageList
  );

  // GET /pages/random - 获取随机页面（不使用缓存）
  // 注意：必须放在 /:identifier 路由之前
  router.get(
    '/random',
    pageController.getRandomPages
  );

  // GET /pages/:identifier - 获取页面详情
  router.get(
    '/:identifier',
    validate({ params: schemas.identifier }),
    cacheMiddleware(CACHE_TTL.PAGE_DETAIL),
    pageController.getPageDetail
  );

  // GET /pages/:identifier/versions - 获取页面版本历史
  router.get(
    '/:identifier/versions',
    validate({ params: schemas.identifier }),
    cacheMiddleware(CACHE_TTL.PAGE_DETAIL),
    pageController.getPageVersions
  );

  // GET /pages/:identifier/votes - 获取页面投票记录
  router.get(
    '/:identifier/votes',
    validate({ params: schemas.identifier }),
    cacheMiddleware(CACHE_TTL.HOT_DATA),
    pageController.getPageVotes
  );

  // GET /pages/:identifier/revisions - 获取页面修订记录
  router.get(
    '/:identifier/revisions',
    validate({ params: schemas.identifier }),
    cacheMiddleware(CACHE_TTL.PAGE_DETAIL),
    pageController.getPageRevisions
  );

  // GET /pages/:identifier/stats - 获取页面统计
  router.get(
    '/:identifier/stats',
    validate({ params: schemas.identifier }),
    cacheMiddleware(CACHE_TTL.PAGE_STATS),
    pageController.getPageStats
  );

  // GET /pages/:identifier/voting-history - 获取页面投票历史时间序列
  router.get(
    '/:identifier/voting-history',
    validate({ params: schemas.identifier }),
    cacheMiddleware(CACHE_TTL.PAGE_DETAIL),
    pageController.getPageVotingHistory
  );

  return router;
}