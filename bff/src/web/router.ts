import { Router } from 'express';
import type { Pool } from 'pg';
import type { RedisClientType } from 'redis';
import { pagesRouter } from './routes/pages.js';
import { usersRouter } from './routes/users.js';
import { searchRouter } from './routes/search.js';
import { aggregateRouter } from './routes/aggregate.js';
import { statsRouter, extendStatsRouter } from './routes/stats.js';

export function buildRouter(pool: Pool, redis: RedisClientType | null) {
  const router = Router();
  router.use('/pages', pagesRouter(pool, redis));
  router.use('/users', usersRouter(pool, redis));
  router.use('/search', searchRouter(pool, redis));
  router.use('/aggregate', aggregateRouter(pool, redis));
  router.use('/stats', statsRouter(pool, redis));
  router.use('/stats', extendStatsRouter(pool, redis));
  return router;
}


