import { Router } from 'express';
import type { Pool } from 'pg';
import type { RedisClientType } from 'redis';
import { pagesRouter } from './routes/pages.js';
import { usersRouter } from './routes/users.js';
import { searchRouter } from './routes/search.js';
import { aggregateRouter } from './routes/aggregate.js';
import { statsRouter, extendStatsRouter } from './routes/stats.js';
import { quotesRouter } from './routes/quotes.js';
import { analyticsRouter } from './routes/analytics.js';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { pageImagesRouter } from './routes/page-images.js';
import { PAGE_IMAGE_ROUTE_PREFIX } from './pageImagesConfig.js';

export function buildRouter(pool: Pool, redis: RedisClientType | null) {
  const router = Router();
  router.use('/pages', pagesRouter(pool, redis));
  router.use('/users', usersRouter(pool, redis));
  router.use('/search', searchRouter(pool, redis));
  router.use('/aggregate', aggregateRouter(pool, redis));
  router.use('/stats', statsRouter(pool, redis));
  router.use('/stats', extendStatsRouter(pool, redis));
  router.use('/analytics', analyticsRouter(pool, redis));
  router.use('/quotes', quotesRouter(pool, redis));
  router.use(PAGE_IMAGE_ROUTE_PREFIX, pageImagesRouter(pool));
  // Proxy avatar endpoints to avatar-agent service
  router.use('/avatar', createProxyMiddleware({ target: 'http://127.0.0.1:3200', changeOrigin: false, xfwd: true }));
  return router;
}

