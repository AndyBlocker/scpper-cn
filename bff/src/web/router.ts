import { Router } from 'express';
import type { Pool } from 'pg';
import type { RedisClientType } from 'redis';
import type { Request, Response, NextFunction } from 'express';
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
import { forumAlertsRouter } from './routes/forumAlerts.js';
import { referencesRouter } from './routes/references.js';
import { trackingRouter } from './routes/tracking.js';
import { collectionsRouter } from './routes/collections.js';
import { htmlSnippetsRouter } from './routes/html-snippets.js';
import { internalRouter } from './routes/internal.js';
import { textAnalysisRouter } from './routes/text-analysis.js';
import { forumsRouter } from './routes/forums.js';
import { cssProxyRouter } from './routes/css-proxy.js';

export function buildRouter(pool: Pool, redis: RedisClientType | null) {
  const router = Router();
  const avatarAgentBase = (process.env.AVATAR_AGENT_BASE_URL || 'http://127.0.0.1:3200').replace(/\/$/, '');
  const normalizeRemoteIp = (value: string | null | undefined) => {
    if (!value) return '';
    return value.replace(/^::ffff:/, '').trim().toLowerCase();
  };
  const isLoopbackIp = (value: string | null | undefined) => {
    const ip = normalizeRemoteIp(value);
    return ip === '127.0.0.1' || ip === '::1' || ip === 'localhost';
  };
  const guardInternalRoutes = (req: Request, res: Response, next: NextFunction) => {
    const expectedKey = (process.env.BFF_INTERNAL_API_KEY || '').trim();
    const providedKey = String(req.get('x-internal-key') || '').trim();
    if (expectedKey && providedKey && providedKey === expectedKey) {
      return next();
    }
    // Loopback IP alone is no longer sufficient — the Nuxt frontend proxy also
    // originates from localhost, so a public user hitting /api/internal/** would
    // pass a pure-loopback check.  Require a valid x-internal-key for all
    // internal route access.
    return res.status(403).json({ error: 'internal_access_denied' });
  };
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
  router.use('/alerts/forum', forumAlertsRouter(pool, redis));
  router.use('/references', referencesRouter(pool, redis));
  router.use('/tracking', trackingRouter(pool));
  router.use('/collections', collectionsRouter(pool, redis));
  router.use('/text-analysis', textAnalysisRouter());
  router.use('/forums', forumsRouter(pool, redis));
  router.use(cssProxyRouter());
  router.use('/internal', guardInternalRoutes, internalRouter());
  router.use('/', htmlSnippetsRouter);
  router.use(PAGE_IMAGE_ROUTE_PREFIX, pageImagesRouter(pool));
  // Proxy avatar endpoints to avatar-agent service
  router.use('/avatar', createProxyMiddleware({ target: avatarAgentBase, changeOrigin: false, xfwd: true }));
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
