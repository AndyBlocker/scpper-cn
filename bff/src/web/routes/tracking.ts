import { Router } from 'express';
import type { Pool } from 'pg';
import type { Request, Response } from 'express';

const PIXEL_BUFFER = Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64');
const DEDUPE_WINDOW_MS = 12 * 60 * 60 * 1000;
const MAX_COMPONENT_LENGTH = 64;
const MAX_SOURCE_LENGTH = 64;
const MAX_USER_AGENT_LENGTH = 1024;
const MAX_REFERER_LENGTH = 255;
const WIKIDOT_HTTP_BASE = 'http://scp-wiki-cn.wikidot.com';

type PixelHeaders = Record<string, string>;

function sendPixel(res: Response, extraHeaders: PixelHeaders = {}) {
  res.set({
    'Content-Type': 'image/gif',
    'Content-Length': String(PIXEL_BUFFER.length),
    'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
    Pragma: 'no-cache',
    Expires: '0',
    ...extraHeaders
  });
  res.status(200).send(PIXEL_BUFFER);
}

function sanitizeParam(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length <= maxLength ? trimmed : trimmed.slice(0, maxLength);
}

function buildClientFingerprint(ip: string, userAgent: string): string {
  const safeIp = ip && ip.trim() ? ip.trim() : 'unknown-ip';
  const safeAgent = userAgent && userAgent.trim() ? userAgent.trim() : 'unknown-ua';
  return `${safeIp}|${safeAgent}`;
}

function resolveClientIp(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    const [first] = forwarded.split(',');
    if (first && first.trim()) return first.trim();
  }
  if (Array.isArray(forwarded) && forwarded.length > 0) {
    const first = forwarded[0];
    if (first && first.trim()) return first.trim();
  }
  const socketIp = req.socket?.remoteAddress;
  return typeof socketIp === 'string' ? socketIp : '';
}

function extractRefererHost(req: Request): string | null {
  const ref = req.get('referer') || req.get('referrer');
  if (!ref) return null;
  try {
    const url = new URL(ref);
    return url.hostname.length > MAX_REFERER_LENGTH
      ? url.hostname.slice(0, MAX_REFERER_LENGTH)
      : url.hostname;
  } catch {
    return null;
  }
}

function normalizeRelativePath(value: string | undefined): string | null {
  if (!value || typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || /^https?:\/\//i.test(trimmed)) return null;
  if (/\s/.test(trimmed)) return null;
  const withoutQuery = trimmed.split(/[?#]/)[0] || '';
  if (!withoutQuery) return null;
  let path = withoutQuery;
  if (!path.startsWith('/')) path = `/${path}`;
  path = path.replace(/\/{2,}/g, '/');
  return path;
}

async function trackPageView(req: Request, res: Response, pool: Pool, pageId: number, wikidotId: number, extraHeaders: PixelHeaders) {
  const component = sanitizeParam((req.query as Record<string, string | undefined>).component, MAX_COMPONENT_LENGTH);
  const source = sanitizeParam((req.query as Record<string, string | undefined>).source, MAX_SOURCE_LENGTH);
  const userAgentRaw = req.get('user-agent') || '';
  const userAgentTrimmed = userAgentRaw.length <= MAX_USER_AGENT_LENGTH
    ? userAgentRaw
    : userAgentRaw.slice(0, MAX_USER_AGENT_LENGTH);
  const userAgent = userAgentTrimmed && userAgentTrimmed.trim() ? userAgentTrimmed : 'unknown-ua';
  const clientIpRaw = resolveClientIp(req);
  const clientIp = clientIpRaw && clientIpRaw.trim() ? clientIpRaw.trim() : 'unknown-ip';
  const clientFingerprint = buildClientFingerprint(clientIp, userAgent);
  const refererHost = extractRefererHost(req);

  const now = new Date();
  const lookback = new Date(now.getTime() - DEDUPE_WINDOW_MS);

  const dedupeRes = await pool.query(
    `SELECT 1
       FROM "PageViewEvent"
      WHERE "pageId" = $1
        AND "clientIp" = $2
        AND "userAgent" = $3
        AND "createdAt" >= $4
      LIMIT 1`,
    [pageId, clientIp, userAgent, lookback]
  );
  const counted = dedupeRes.rows.length === 0;

  await pool.query(
    `INSERT INTO "PageViewEvent"
       ("pageId", "wikidotId", "clientHash", "clientIp", "userAgent", "component", "source", "refererHost", "createdAt")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      pageId,
      wikidotId,
      clientFingerprint,
      clientIp,
      userAgent,
      component,
      source,
      refererHost,
      now
    ]
  );

  if (counted) {
    await pool.query(
      `INSERT INTO "PageDailyStats" ("pageId", date, views)
       VALUES ($1, CURRENT_DATE, 1)
       ON CONFLICT ("pageId", date)
       DO UPDATE SET views = "PageDailyStats".views + EXCLUDED.views`,
      [pageId]
    );
  }

  extraHeaders['X-Tracking-Counted'] = counted ? '1' : '0';
  sendPixel(res, extraHeaders);
}

async function trackUserPixel(
  req: Request,
  res: Response,
  pool: Pool,
  userId: number,
  wikidotId: number | null,
  username: string,
  extraHeaders: PixelHeaders
) {
  const component = sanitizeParam((req.query as Record<string, string | undefined>).component, MAX_COMPONENT_LENGTH);
  const source = sanitizeParam((req.query as Record<string, string | undefined>).source, MAX_SOURCE_LENGTH);
  const userAgentRaw = req.get('user-agent') || '';
  const userAgentTrimmed = userAgentRaw.length <= MAX_USER_AGENT_LENGTH
    ? userAgentRaw
    : userAgentRaw.slice(0, MAX_USER_AGENT_LENGTH);
  const userAgent = userAgentTrimmed && userAgentTrimmed.trim() ? userAgentTrimmed : 'unknown-ua';
  const clientIpRaw = resolveClientIp(req);
  const clientIp = clientIpRaw && clientIpRaw.trim() ? clientIpRaw.trim() : 'unknown-ip';
  const clientFingerprint = buildClientFingerprint(clientIp, userAgent);
  const refererHost = extractRefererHost(req);

  const now = new Date();
  const lookback = new Date(now.getTime() - DEDUPE_WINDOW_MS);
  const dedupeRes = await pool.query(
    `SELECT 1
       FROM "UserPixelEvent"
      WHERE "userId" = $1
        AND "clientIp" = $2
        AND "userAgent" = $3
        AND "createdAt" >= $4
      LIMIT 1`,
    [userId, clientIp, userAgent, lookback]
  );
  const counted = dedupeRes.rows.length === 0;

  await pool.query(
    `INSERT INTO "UserPixelEvent"
       ("userId", "wikidotId", username, "clientHash", "clientIp", "userAgent", "component", "source", "refererHost", "createdAt")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      userId,
      Number.isFinite(wikidotId) ? wikidotId : null,
      username,
      clientFingerprint,
      clientIp,
      userAgent,
      component,
      source,
      refererHost,
      now
    ]
  );

  extraHeaders['X-Tracking-Counted'] = counted ? '1' : '0';
  sendPixel(res, extraHeaders);
}

export function trackingRouter(pool: Pool) {
  const router = Router();

  router.get('/pixel', async (req, res) => {
    const extraHeaders: PixelHeaders = {};
    const logger = (req as any)?.log;
    try {
      const wikidotIdRaw = (req.query as Record<string, string | undefined>).wikidotId;
      if (!wikidotIdRaw) {
        extraHeaders['X-Tracking-Error'] = 'missing_wikidot_id';
        return sendPixel(res, extraHeaders);
      }
      const wikidotId = Number(wikidotIdRaw);
      if (!Number.isFinite(wikidotId) || wikidotId <= 0) {
        extraHeaders['X-Tracking-Error'] = 'invalid_wikidot_id';
        return sendPixel(res, extraHeaders);
      }

      const pageRes = await pool.query('SELECT id FROM "Page" WHERE "wikidotId" = $1::int LIMIT 1', [wikidotId]);
      if (pageRes.rows.length === 0) {
        extraHeaders['X-Tracking-Error'] = 'page_not_found';
        return sendPixel(res, extraHeaders);
      }
      const pageId = Number(pageRes.rows[0].id);

      await trackPageView(req, res, pool, pageId, wikidotId, extraHeaders);
    } catch (err: any) {
      if (logger && typeof logger.error === 'function') {
        logger.error({ err }, 'tracking_pixel_failed');
      } else {
        console.error('tracking_pixel_failed', err);
      }
      extraHeaders['X-Tracking-Error'] = 'internal_error';
      sendPixel(res, extraHeaders);
    }
  });

  router.get('/pixel/by-url', async (req, res) => {
    const extraHeaders: PixelHeaders = {};
    const logger = (req as any)?.log;
    try {
      const normalizedPath = normalizeRelativePath((req.query as Record<string, string | undefined>).url);
      if (!normalizedPath) {
        extraHeaders['X-Tracking-Error'] = 'invalid_url';
        return sendPixel(res, extraHeaders);
      }

      const base = WIKIDOT_HTTP_BASE.replace(/\/+$/u, '');
      const canonicalHttp = `${base}${normalizedPath}`;
      const canonicalHttps = canonicalHttp.replace(/^http:/i, 'https:');
      const candidateUrls = Array.from(new Set([canonicalHttp.toLowerCase(), canonicalHttps.toLowerCase()]));
      const pageRes = await pool.query(
        `SELECT id, "wikidotId"
           FROM "Page"
          WHERE lower("currentUrl") = ANY($1)
             OR EXISTS (
               SELECT 1
               FROM unnest("urlHistory") AS hist(url)
               WHERE lower(hist.url) = ANY($1)
             )
          LIMIT 1`,
        [candidateUrls]
      );

      if (pageRes.rows.length === 0) {
        extraHeaders['X-Tracking-Error'] = 'page_not_found';
        return sendPixel(res, extraHeaders);
      }

      const row = pageRes.rows[0];
      const pageId = Number(row.id);
      const wikidotId = Number(row.wikidotId);
      if (!Number.isFinite(pageId) || !Number.isFinite(wikidotId)) {
        extraHeaders['X-Tracking-Error'] = 'page_not_found';
        return sendPixel(res, extraHeaders);
      }

      await trackPageView(req, res, pool, pageId, wikidotId, extraHeaders);
    } catch (err: any) {
      if (logger && typeof logger.error === 'function') {
        logger.error({ err }, 'tracking_pixel_by_url_failed');
      } else {
        console.error('tracking_pixel_by_url_failed', err);
      }
      extraHeaders['X-Tracking-Error'] = 'internal_error';
      sendPixel(res, extraHeaders);
    }
  });

  router.get('/pixel/by-username', async (req, res) => {
    const extraHeaders: PixelHeaders = {};
    const logger = (req as any)?.log;
    try {
      const wikidotIdRaw = (req.query as Record<string, string | undefined>).wikidotId;
      if (!wikidotIdRaw) {
        extraHeaders['X-Tracking-Error'] = 'missing_wikidot_id';
        return sendPixel(res, extraHeaders);
      }

      const wikidotId = Number(wikidotIdRaw);
      if (!Number.isFinite(wikidotId) || wikidotId <= 0) {
        extraHeaders['X-Tracking-Error'] = 'invalid_wikidot_id';
        return sendPixel(res, extraHeaders);
      }

      const userRes = await pool.query(
        `SELECT id, "wikidotId", username
           FROM "User"
          WHERE "wikidotId" = $1
          LIMIT 1`,
        [wikidotId]
      );

      if (userRes.rows.length === 0) {
        extraHeaders['X-Tracking-Error'] = 'user_not_found';
        return sendPixel(res, extraHeaders);
      }

      const row = userRes.rows[0];
      const userId = Number(row.id);
      if (!Number.isFinite(userId) || userId <= 0) {
        extraHeaders['X-Tracking-Error'] = 'user_not_found';
        return sendPixel(res, extraHeaders);
      }

      const wikidotIdNumeric = Number(row.wikidotId);
      const resolvedWikidotId = Number.isFinite(wikidotIdNumeric) && wikidotIdNumeric > 0
        ? wikidotIdNumeric
        : wikidotId;
      const storedUsername = typeof row.username === 'string' && row.username.trim()
        ? row.username.trim()
        : '';
      await trackUserPixel(req, res, pool, userId, resolvedWikidotId, storedUsername, extraHeaders);
    } catch (err: any) {
      if (logger && typeof logger.error === 'function') {
        logger.error({ err }, 'tracking_pixel_by_username_failed');
      } else {
        console.error('tracking_pixel_by_username_failed', err);
      }
      extraHeaders['X-Tracking-Error'] = 'internal_error';
      sendPixel(res, extraHeaders);
    }
  });

  return router;
}
