import { Router } from 'express';
import type { Pool } from 'pg';
import type { IncomingHttpHeaders } from 'http';
import type { Request, Response } from 'express';

const PIXEL_BUFFER = Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64');
const DEDUPE_WINDOW_MS = 12 * 60 * 60 * 1000;
const MAX_COMPONENT_LENGTH = 64;
const MAX_SOURCE_LENGTH = 64;
const MAX_USER_AGENT_LENGTH = 1024;
const MAX_REFERER_LENGTH = 255;
const MAX_DEBUG_HEADER_VALUE = 2048;
const DEBUG_HEADERS = [
  'user-agent',
  'x-forwarded-for',
  'x-real-ip',
  'cf-connecting-ip',
  'forwarded',
  'via',
  'referer',
  'referrer',
  'origin',
  'sec-ch-ua',
  'sec-ch-ua-mobile',
  'sec-ch-ua-platform',
  'sec-fetch-site',
  'sec-fetch-mode',
  'sec-fetch-dest',
  'accept-language',
  'accept'
];
const DEBUG_ENABLED = String(process.env.ENABLE_TRACKING_DEBUG || '').toLowerCase() === 'true';
const DEBUG_SAMPLE_RATE = Math.max(0, Math.min(1, Number(process.env.TRACKING_DEBUG_SAMPLE_RATE ?? '0')));
const DEBUG_TABLE_NAME = 'tracking_debug_event';
let debugTableEnsured = false;
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

function truncateValue(value: string | null | undefined, maxLength = 1024): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length <= maxLength ? trimmed : trimmed.slice(0, maxLength);
}

function coerceHeaderValue(value: string | string[] | number | undefined): string | null {
  if (value === undefined) return null;
  if (Array.isArray(value)) return truncateValue(value.join(', '), MAX_DEBUG_HEADER_VALUE);
  if (typeof value === 'number') return truncateValue(String(value), MAX_DEBUG_HEADER_VALUE);
  return truncateValue(value, MAX_DEBUG_HEADER_VALUE);
}

function collectDebugHeaders(headers: IncomingHttpHeaders): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const key of DEBUG_HEADERS) {
    const raw = coerceHeaderValue(headers[key]);
    if (raw) picked[key] = raw;
  }
  return picked;
}

function sanitizeQueryParams(rawQuery: Record<string, unknown>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(rawQuery)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      const joined = value.map((v) => (typeof v === 'string' ? v : String(v))).join(',');
      const sanitized = truncateValue(joined, MAX_DEBUG_HEADER_VALUE);
      if (sanitized) result[key] = sanitized;
      continue;
    }
    const str = typeof value === 'string' ? value : String(value);
    const sanitized = truncateValue(str, MAX_DEBUG_HEADER_VALUE);
    if (sanitized) result[key] = sanitized;
  }
  return result;
}

function shouldLogDebug(req: Request): boolean {
  if (!DEBUG_ENABLED) return false;
  const flag = (req.query as Record<string, unknown>).debug;
  if (flag !== undefined && flag !== null) {
    const normalized = Array.isArray(flag) ? flag.join(',') : String(flag);
    const lowered = normalized.trim().toLowerCase();
    if (lowered === '1' || lowered === 'true' || lowered === 'yes' || lowered === 'on') {
      return true;
    }
    if (lowered === '0' || lowered === 'false' || lowered === 'no' || lowered === 'off') {
      return false;
    }
  }
  return DEBUG_SAMPLE_RATE > 0 && Math.random() < DEBUG_SAMPLE_RATE;
}

async function ensureDebugTable(pool: Pool): Promise<void> {
  if (!DEBUG_ENABLED || debugTableEnsured) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${DEBUG_TABLE_NAME} (
      id BIGSERIAL PRIMARY KEY,
      kind TEXT NOT NULL,
      page_id INT,
      user_id INT,
      wikidot_id INT,
      username TEXT,
      client_hash TEXT,
      client_ip_raw TEXT,
      client_ip_resolved TEXT,
      remote_address TEXT,
      forwarded_for TEXT,
      user_agent_raw TEXT,
      user_agent_trimmed TEXT,
      referer_raw TEXT,
      referer_host TEXT,
      component TEXT,
      source TEXT,
      deduped BOOLEAN,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      headers JSONB,
      query JSONB
    );
    CREATE INDEX IF NOT EXISTS tracking_debug_event_created_at_idx ON ${DEBUG_TABLE_NAME} (created_at);
    CREATE INDEX IF NOT EXISTS tracking_debug_event_kind_idx ON ${DEBUG_TABLE_NAME} (kind);
  `);
  debugTableEnsured = true;
}

async function recordDebugEvent(
  pool: Pool,
  req: Request,
  kind: 'page' | 'user',
  payload: {
    pageId?: number;
    userId?: number;
    wikidotId?: number | null;
    username?: string;
    clientHash: string;
    clientIpRaw: string;
    clientIpResolved: string;
    userAgentRaw: string;
    userAgentTrimmed: string;
    refererHost: string | null;
    component: string | null;
    source: string | null;
    deduped: boolean;
  }
): Promise<void> {
  if (!DEBUG_ENABLED) return;
  await ensureDebugTable(pool);
  const forwardedRaw = coerceHeaderValue(req.headers['x-forwarded-for']);
  const remoteAddress = typeof req.socket?.remoteAddress === 'string' ? req.socket.remoteAddress : null;
  const refererRaw = truncateValue(req.get('referer') || req.get('referrer'), MAX_DEBUG_HEADER_VALUE);
  const headers = collectDebugHeaders(req.headers);
  const query = sanitizeQueryParams(req.query as Record<string, unknown>);

  await pool.query(
    `INSERT INTO ${DEBUG_TABLE_NAME}
       (kind, page_id, user_id, wikidot_id, username, client_hash, client_ip_raw, client_ip_resolved, remote_address,
        forwarded_for, user_agent_raw, user_agent_trimmed, referer_raw, referer_host, component, source, deduped, created_at, headers, query)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, NOW(), $18::jsonb, $19::jsonb)`,
    [
      kind,
      payload.pageId ?? null,
      payload.userId ?? null,
      payload.wikidotId ?? null,
      payload.username ?? null,
      payload.clientHash,
      payload.clientIpRaw,
      payload.clientIpResolved,
      remoteAddress,
      forwardedRaw,
      payload.userAgentRaw,
      payload.userAgentTrimmed,
      refererRaw,
      payload.refererHost,
      payload.component,
      payload.source,
      payload.deduped,
      JSON.stringify(headers),
      JSON.stringify(query)
    ]
  );
}

async function trackPageView(
  req: Request,
  res: Response,
  pool: Pool,
  pageId: number,
  wikidotId: number,
  extraHeaders: PixelHeaders,
  debugRequested: boolean
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
  if (debugRequested) {
    try {
      await recordDebugEvent(pool, req, 'page', {
        pageId,
        wikidotId,
        clientHash: clientFingerprint,
        clientIpRaw: truncateValue(clientIpRaw, MAX_DEBUG_HEADER_VALUE) ?? 'unknown',
        clientIpResolved: clientIp,
        userAgentRaw: truncateValue(userAgentRaw, MAX_DEBUG_HEADER_VALUE) ?? 'unknown-ua',
        userAgentTrimmed: userAgent,
        refererHost,
        component,
        source,
        deduped: counted
      });
      extraHeaders['X-Tracking-Debug-Logged'] = '1';
    } catch (err) {
      extraHeaders['X-Tracking-Debug-Logged'] = '0';
      // eslint-disable-next-line no-console
      console.error('tracking_debug_log_failed', err);
    }
  }
  sendPixel(res, extraHeaders);
}

async function trackUserPixel(
  req: Request,
  res: Response,
  pool: Pool,
  userId: number,
  wikidotId: number | null,
  username: string,
  extraHeaders: PixelHeaders,
  debugRequested: boolean
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
  if (debugRequested) {
    try {
      await recordDebugEvent(pool, req, 'user', {
        userId,
        wikidotId,
        username,
        clientHash: clientFingerprint,
        clientIpRaw: truncateValue(clientIpRaw, MAX_DEBUG_HEADER_VALUE) ?? 'unknown',
        clientIpResolved: clientIp,
        userAgentRaw: truncateValue(userAgentRaw, MAX_DEBUG_HEADER_VALUE) ?? 'unknown-ua',
        userAgentTrimmed: userAgent,
        refererHost,
        component,
        source,
        deduped: counted
      });
      extraHeaders['X-Tracking-Debug-Logged'] = '1';
    } catch (err) {
      extraHeaders['X-Tracking-Debug-Logged'] = '0';
      // eslint-disable-next-line no-console
      console.error('tracking_debug_log_failed', err);
    }
  }
  sendPixel(res, extraHeaders);
}

export function trackingRouter(pool: Pool) {
  const router = Router();

  router.get('/pixel', async (req, res) => {
    const extraHeaders: PixelHeaders = {};
    const logger = (req as any)?.log;
    try {
      const debugRequested = shouldLogDebug(req);
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

      await trackPageView(req, res, pool, pageId, wikidotId, extraHeaders, debugRequested);
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
      const debugRequested = shouldLogDebug(req);
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

      await trackPageView(req, res, pool, pageId, wikidotId, extraHeaders, debugRequested);
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
      const debugRequested = shouldLogDebug(req);
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
      await trackUserPixel(req, res, pool, userId, resolvedWikidotId, storedUsername, extraHeaders, debugRequested);
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
