import { Router } from 'express';
import { UserController } from '../controllers/user.controller.js';
import { validate, schemas } from '../middleware/validation.middleware.js';
import { cacheMiddleware } from '../middleware/cache.middleware.js';
import { CACHE_TTL } from '../types/cache.js';

export function createUserRoutes(userController: UserController): Router {
  const router = Router();

  // GET /users - 获取用户列表
  router.get(
    '/',
    validate({ query: schemas.pagination }),
    cacheMiddleware(CACHE_TTL.USER_PROFILE),
    userController.getUserList
  );

  // GET /users/:identifier - 获取用户详情
  router.get(
    '/:identifier',
    validate({ params: schemas.identifier }),
    cacheMiddleware(CACHE_TTL.USER_PROFILE),
    userController.getUserDetail
  );

  // GET /users/:identifier/stats - 获取用户统计
  router.get(
    '/:identifier/stats',
    validate({ params: schemas.identifier }),
    cacheMiddleware(CACHE_TTL.USER_STATS),
    userController.getUserStats
  );

  // GET /users/:identifier/attributions - 获取用户贡献
  router.get(
    '/:identifier/attributions',
    validate({ 
      params: schemas.identifier,
      query: schemas.pagination 
    }),
    cacheMiddleware(CACHE_TTL.USER_STATS),
    userController.getUserAttributions
  );

  // GET /users/:identifier/votes - 获取用户投票记录
  router.get(
    '/:identifier/votes',
    validate({ 
      params: schemas.identifier,
      query: schemas.pagination 
    }),
    cacheMiddleware(CACHE_TTL.USER_STATS),
    userController.getUserVotes
  );

  // GET /users/:identifier/activity - 获取用户活动记录
  router.get(
    '/:identifier/activity',
    validate({ 
      params: schemas.identifier,
      query: schemas.pagination 
    }),
    cacheMiddleware(CACHE_TTL.HOT_DATA),
    userController.getUserActivity
  );

  // GET /users/:identifier/rating-history - 获取用户rating历史时间序列
  router.get(
    '/:identifier/rating-history',
    validate({ params: schemas.identifier }),
    cacheMiddleware(CACHE_TTL.USER_STATS),
    userController.getUserRatingHistory
  );

  return router;
}