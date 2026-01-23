import { Router } from 'express';
import type { Pool } from 'pg';
import type { RedisClientType } from 'redis';
import type { Request, Response } from 'express';
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
import { tagsRouter } from './routes/tags.js';
import { alertsRouter } from './routes/alerts.js';
import { followsRouter } from './routes/follows.js';
import { followAlertsRouter } from './routes/followAlerts.js';
import { referencesRouter } from './routes/references.js';
import { trackingRouter } from './routes/tracking.js';
import { collectionsRouter } from './routes/collections.js';
import { htmlSnippetsRouter } from './routes/html-snippets.js';
import { internalRouter } from './routes/internal.js';

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
  router.use('/tags', tagsRouter(pool, redis));
  router.use('/alerts', alertsRouter(pool, redis));
  router.use('/follows', followsRouter(pool, redis));
  router.use('/alerts/follow', followAlertsRouter(pool, redis));
  router.use('/references', referencesRouter(pool, redis));
  router.use('/tracking', trackingRouter(pool));
  router.use('/collections', collectionsRouter(pool, redis));
  router.use('/internal', internalRouter());
  router.use('/', htmlSnippetsRouter);
  router.use(PAGE_IMAGE_ROUTE_PREFIX, pageImagesRouter(pool));
  // Proxy avatar endpoints to avatar-agent service
  router.use('/avatar', createProxyMiddleware({ target: 'http://127.0.0.1:3200', changeOrigin: false, xfwd: true }));
  const userBackendBase = process.env.USER_BACKEND_BASE_URL || 'http://127.0.0.1:4455';
  if (userBackendBase !== 'disable') {
    const normalizedTarget = userBackendBase.replace(/\/$/, '');
    const forwardJsonBody = (proxyReq: any, req: Request) => {
      if (!req.body || req.method === 'GET' || req.method === 'HEAD') {
        return;
      }
      try {
        const bodyData = JSON.stringify(req.body);
        proxyReq.setHeader('Content-Type', 'application/json');
        proxyReq.setHeader('Content-Length', Buffer.byteLength(bodyData));
        proxyReq.end(bodyData);
      } catch (error) {
        // eslint-disable-next-line no-console
        console.warn('Failed to forward proxy payload:', error);
      }
    };
    const rewrite = (prefix: string) => (path: string) => {
      const clean = path.startsWith('/') ? path : `/${path}`;
      return `${prefix}${clean}`.replace(/\/{2,}/g, '/');
    };
    router.use('/auth', createProxyMiddleware<Request, Response>({
      target: normalizedTarget,
      changeOrigin: true,
      xfwd: true,
      pathRewrite: rewrite('/auth'),
      on: {
        proxyReq: forwardJsonBody,
        proxyRes: (proxyRes) => {
          proxyRes.headers['cache-control'] = 'no-store, no-cache, must-revalidate, max-age=0';
          delete proxyRes.headers.etag;
          delete proxyRes.headers['last-modified'];
        }
      }
    }));
    router.use('/wikidot-binding', createProxyMiddleware<Request, Response>({
      target: normalizedTarget,
      changeOrigin: true,
      xfwd: true,
      pathRewrite: rewrite('/wikidot-binding'),
      on: {
        proxyReq: forwardJsonBody,
        proxyRes: (proxyRes) => {
          proxyRes.headers['cache-control'] = 'no-store, no-cache, must-revalidate, max-age=0';
          delete proxyRes.headers.etag;
          delete proxyRes.headers['last-modified'];
        }
      }
    }));
    router.use('/gacha', createProxyMiddleware<Request, Response>({
      target: normalizedTarget,
      changeOrigin: true,
      xfwd: true,
      pathRewrite: rewrite('/gacha'),
      on: {
        proxyReq: forwardJsonBody,
        proxyRes: (proxyRes) => {
          proxyRes.headers['cache-control'] = 'no-store, no-cache, must-revalidate, max-age=0';
          delete proxyRes.headers.etag;
          delete proxyRes.headers['last-modified'];
        }
      }
    }));
    router.use('/admin', createProxyMiddleware<Request, Response>({
      target: normalizedTarget,
      changeOrigin: true,
      xfwd: true,
      pathRewrite: rewrite('/admin'),
      on: {
        proxyReq: forwardJsonBody
      }
    }));
    // Public events proxy to user-backend
    router.use('/events', createProxyMiddleware<Request, Response>({
      target: normalizedTarget,
      changeOrigin: true,
      xfwd: true,
      pathRewrite: rewrite('/events'),
      on: {
        proxyReq: forwardJsonBody
      }
    }));
    // FTML projects proxy to user-backend
    router.use('/ftml-projects', createProxyMiddleware<Request, Response>({
      target: normalizedTarget,
      changeOrigin: true,
      xfwd: true,
      pathRewrite: rewrite('/ftml-projects'),
      on: {
        proxyReq: forwardJsonBody,
        proxyRes: (proxyRes) => {
          proxyRes.headers['cache-control'] = 'no-store, no-cache, must-revalidate, max-age=0';
          delete proxyRes.headers.etag;
          delete proxyRes.headers['last-modified'];
        }
      }
    }));
  }
  return router;
}
