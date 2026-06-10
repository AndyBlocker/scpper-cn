import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { randomBytes } from 'crypto';
import type { Pool } from 'pg';
import type { IncomingHttpHeaders } from 'http';
import type { Request, Response } from 'express';

const PIXEL_BUFFER = Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64');
const DEDUPE_WINDOW_HOURS = 12;
const MAX_COMPONENT_LENGTH = 64;
const MAX_SOURCE_LENGTH = 64;
const MAX_USER_AGENT_LENGTH = 1024;
const MAX_REFERER_LENGTH = 255;
const MAX_SIGNAL_LENGTH = 256;
// TLS 指纹(openresty 注入的原始 ClientHello 密码套件/曲线列表)较长,单独放宽上限存全量。
const MAX_TLS_FP_LENGTH = 1024;
// ETag 缓存型访客标识(image-only 无 cookie)。语义重要: HTTP 缓存按 URL 分键,故 token 是
// "同一像素 URL 的复访信号"(同浏览器对 /pixel/by-url?url=X 复访得稳定 token),而非跨页/跨账号
// 的全局浏览器 ID——不同像素 URL 会得到不同 token。因此不能用它做跨账号小号关联(检测 Job 的
// sharedTokens 对 by-username 不同 wikidotId 恒为 0),它的价值是页面级"独立复访者"计量。
const VISITOR_TOKEN_ENABLED = String(process.env.TRACKING_VISITOR_TOKEN || '').toLowerCase() === 'true';
const VISITOR_TOKEN_RE = /^[0-9a-f]{32}$/;
// openresty/nginx 在 TLS 终止层注入的 JA3/JA4 指纹头名(连接层,抗改 UA)。默认读 x-tls-fingerprint。
const TLS_FP_HEADER = (process.env.TRACKING_TLS_FP_HEADER || 'x-tls-fingerprint').toLowerCase();
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
// 生产环境采样率硬上限 5%:tracking_debug_event 存完整请求头+原始 IP,曾因 PM2 env 漂移
// 以 100% 采样常开累积 504MB 无清理(2026-06-10 审计),clamp 兜住同类配置事故。
const DEBUG_SAMPLE_RATE_CAP = process.env.NODE_ENV === 'production' ? 0.05 : 1;
const DEBUG_SAMPLE_RATE = Math.max(0, Math.min(DEBUG_SAMPLE_RATE_CAP, Number(process.env.TRACKING_DEBUG_SAMPLE_RATE ?? '0')));
// 计数白名单:referer 主机在名单内(或无 referer,如直访/strict-origin 策略)才允许给
// PageDailyStats.views +1;名单外站点嵌像素仍记录事件行但不污染计数。
const COUNT_REFERER_ALLOWLIST = (process.env.TRACKING_COUNT_REFERER_ALLOWLIST
  || 'scp-wiki-cn.wikidot.com,scp-wiki-cn.wikidot.mer.run')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
const DEBUG_TABLE_NAME = 'tracking_debug_event' as const;
// Safety assertion: table name must be a valid SQL identifier
if (!/^[a-z_][a-z0-9_]*$/i.test(DEBUG_TABLE_NAME)) {
  throw new Error(`Invalid debug table name: ${DEBUG_TABLE_NAME}`);
}
let debugTableEnsured = false;
const WIKIDOT_HTTP_BASE = 'http://scp-wiki-cn.wikidot.com';

type PixelHeaders = Record<string, string>;

function sendPixel(res: Response, extraHeaders: PixelHeaders = {}, visitorToken?: string | null) {
  const base: PixelHeaders = {
    'Content-Type': 'image/gif',
    'Content-Length': String(PIXEL_BUFFER.length),
    'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
    Pragma: 'no-cache',
    Expires: '0'
  };
  if (visitorToken) {
    // ETag 持久标识:用 no-cache(私有)让浏览器缓存响应但每次使用前必发条件请求,
    // 我们每次都收到 If-None-Match 回送 token、仍每次命中服务器(不丢计数),并稳定回显同一 ETag。
    base['Cache-Control'] = 'private, no-cache, max-age=0';
    base.Pragma = 'no-cache';
    base.ETag = `"${visitorToken}"`;
  }
  res.set({ ...base, ...extraHeaders });
  res.status(200).send(PIXEL_BUFFER);
}

// ── 身份信号采集(image-only:仅来自被动请求头/IP/TLS,无 JS/cookie) ──

function deriveUaFamily(ua: string): string | null {
  if (!ua || ua === 'unknown-ua') return null;
  const os =
    /Android/i.test(ua) ? 'Android' :
    /iPhone|iPad|iOS/i.test(ua) ? 'iOS' :
    /Windows/i.test(ua) ? 'Windows' :
    /Mac OS X|Macintosh/i.test(ua) ? 'macOS' :
    /Linux/i.test(ua) ? 'Linux' : 'Other';
  const browser =
    /Edg[A-Z]?\//i.test(ua) ? 'Edge' :
    /OPR\/|Opera/i.test(ua) ? 'Opera' :
    /HuaweiBrowser/i.test(ua) ? 'Huawei' :
    /QuarkPC|Quark/i.test(ua) ? 'Quark' :
    /Firefox\//i.test(ua) ? 'Firefox' :
    /Chrome\//i.test(ua) ? 'Chrome' :
    /Version\/.*Safari/i.test(ua) ? 'Safari' :
    /Safari/i.test(ua) ? 'Safari' : 'Other';
  return `${browser}/${os}`;
}

// 从 sec-ch-ua 取"有意义品牌+大版本",剔除 GREASE 占位(Not.A/Brand)。
function parseSecChUaBrandMajor(value: string | null): string | null {
  if (!value) return null;
  const entries: Array<{ brand: string; v: string }> = [];
  const re = /"([^"]+)";v="([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(value)) !== null) entries.push({ brand: m[1], v: m[2] });
  if (entries.length === 0) return null;
  const real = entries.filter((e) => !/not.?a.?brand/i.test(e.brand));
  const prefer = real.find((e) => !/^chromium$/i.test(e.brand)) || real[0] || entries[0];
  return `${prefer.brand} ${prefer.v}`.slice(0, MAX_SIGNAL_LENGTH);
}

function unquoteHint(value: string | null | undefined): string | null {
  if (!value) return null;
  const t = value.trim().replace(/^"+|"+$/g, '').trim();
  return t ? t.slice(0, MAX_SIGNAL_LENGTH) : null;
}

function ipSubnet24(ip: string): string {
  let v = (ip || '').trim();
  // IPv4-mapped IPv6 (::ffff:1.2.3.4) → 取内嵌 IPv4,与普通 IPv4 归一到同一 /24
  const mapped = v.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
  if (mapped) v = mapped[1];
  const parts = v.split('.');
  if (parts.length === 4) return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
  // 真实 IPv6: 取前 4 个 hextet 作为 /64 粗前缀(去碎片化, 长度有界), 其余忽略
  if (v.includes(':')) return v.split(':').slice(0, 4).join(':') + '::/64';
  return v.slice(0, 45);
}

type IdentitySignals = {
  acceptLanguage: string | null;
  uaPlatform: string | null;
  uaBrandMajor: string | null;
  uaFamily: string | null;
  softprint: string | null;
  tlsFingerprint: string | null;
};

function collectIdentitySignals(req: Request, clientIp: string, userAgent: string): IdentitySignals {
  const acceptLanguage = truncateValue(req.get('accept-language'), MAX_SIGNAL_LENGTH);
  const uaPlatform = unquoteHint(req.get('sec-ch-ua-platform'));
  const uaBrandMajor = parseSecChUaBrandMajor(req.get('sec-ch-ua') || null);
  const uaFamily = deriveUaFamily(userAgent);
  // TLS 指纹存原始 ClientHello 信号(协议|协商套件|客户端套件列表|曲线列表),纯数据可审计,放宽上限。
  const tlsFingerprint = truncateValue(req.headers[TLS_FP_HEADER] as string | undefined, MAX_TLS_FP_LENGTH);
  // 软指纹:可读复合键(纯数据,不哈希),便于审计;= /24 子网 | UA族 | 品牌大版本 | 平台 | 语言。
  // 比 ip|ua 更稳(抗版本漂移/移动末位变动)且能拆开 VPN 碰撞(语言不同=不同人);各原始分量另有独立列。
  // 给前四项各设硬预算,保证末尾的"语言"永不被整体 256 上限挤掉(否则同/24+长品牌串会假碰撞)。
  const softprint = [
    ipSubnet24(clientIp),
    (uaFamily || '').slice(0, 24),
    (uaBrandMajor || '').slice(0, 48),
    (uaPlatform || '').slice(0, 24),
    acceptLanguage || ''
  ].join('|').slice(0, MAX_SIGNAL_LENGTH);
  return { acceptLanguage, uaPlatform, uaBrandMajor, uaFamily, softprint, tlsFingerprint };
}

// ETag 持久访客 token:复用 If-None-Match 回送的合法 token,否则签发新随机 token。
function resolveVisitorToken(req: Request): string | null {
  if (!VISITOR_TOKEN_ENABLED) return null;
  const inm = req.get('if-none-match');
  if (inm) {
    const candidate = inm.trim().replace(/^W\//, '').replace(/^"+|"+$/g, '').trim().toLowerCase();
    if (VISITOR_TOKEN_RE.test(candidate)) return candidate;
  }
  return randomBytes(16).toString('hex');
}

// 像素专属限流:超限也必须回 200+GIF(而非全局限流的 429 JSON),否则会在嵌入方页面
// 留下裂图;被限流的请求不写库。
export function pixelRateLimiter(options: { windowMs?: number; max?: number } = {}) {
  return rateLimit({
    windowMs: options.windowMs ?? 60 * 1000,
    max: options.max ?? 120,
    standardHeaders: false,
    legacyHeaders: false,
    handler: (_req, res) => sendPixel(res, { 'X-Tracking-Error': 'rate_limited' })
  });
}

function isInternalDebugRequest(req: Request): boolean {
  const expectedKey = (process.env.BFF_INTERNAL_API_KEY || '').trim();
  const providedKey = String(req.get('x-internal-key') || '').trim();
  return Boolean(expectedKey && providedKey && providedKey === expectedKey);
}

function isCountableReferer(refererHost: string | null): boolean {
  if (!refererHost) return true;
  const host = refererHost.toLowerCase();
  return COUNT_REFERER_ALLOWLIST.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
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
  // Use req.ip which honours Express trust-proxy setting,
  // instead of directly trusting the spoofable x-forwarded-for header.
  if (req.ip) return req.ip;
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
  // ?debug 强制开关仅对持有 x-internal-key 的内部请求生效:debug 行包含完整请求头与
  // 原始 IP,公网可控的写放大入口必须收口。
  const flag = (req.query as Record<string, unknown>).debug;
  if (flag !== undefined && flag !== null && isInternalDebugRequest(req)) {
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
  const countableReferer = isCountableReferer(refererHost);
  const sig = collectIdentitySignals(req, clientIp, userAgent);
  const visitorToken = resolveVisitorToken(req);

  let counted = false;
  if (countableReferer) {
    const dedupeRes = await pool.query(
      `SELECT 1
         FROM "PageViewEvent"
        WHERE "pageId" = $1
          AND "clientIp" = $2
          AND "userAgent" = $3
          AND "createdAt" >= NOW() - INTERVAL '${DEDUPE_WINDOW_HOURS} hours'
        LIMIT 1`,
      [pageId, clientIp, userAgent]
    );
    counted = dedupeRes.rows.length === 0;
  }

  await pool.query(
    `INSERT INTO "PageViewEvent"
       ("pageId", "wikidotId", "clientHash", "clientIp", "userAgent", "component", "source", "refererHost",
        "acceptLanguage", "uaPlatform", "uaBrandMajor", "uaFamily", "softprint", "visitorToken", "tlsFingerprint", "createdAt")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, NOW())`,
    [
      pageId,
      wikidotId,
      clientFingerprint,
      clientIp,
      userAgent,
      component,
      source,
      refererHost,
      sig.acceptLanguage,
      sig.uaPlatform,
      sig.uaBrandMajor,
      sig.uaFamily,
      sig.softprint,
      visitorToken,
      sig.tlsFingerprint
    ]
  );

  if (counted) {
    // 显式按 Asia/Shanghai 切日,与读侧 stats.ts 的 todayViews 口径逐字一致;
    // 不再依赖 DB 会话 timezone GUC 恰好是上海这一隐性耦合。
    await pool.query(
      `INSERT INTO "PageDailyStats" ("pageId", date, views)
       VALUES ($1, (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::date, 1)
       ON CONFLICT ("pageId", date)
       DO UPDATE SET views = "PageDailyStats".views + EXCLUDED.views`,
      [pageId]
    );
  }

  // 计数结果只回显给内部请求:公开回显会成为刷量者校准去重窗口的 oracle。
  if (isInternalDebugRequest(req)) {
    extraHeaders['X-Tracking-Counted'] = counted ? '1' : '0';
  }
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
  sendPixel(res, extraHeaders, visitorToken);
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
  const sig = collectIdentitySignals(req, clientIp, userAgent);
  const visitorToken = resolveVisitorToken(req);

  const dedupeRes = await pool.query(
    `SELECT 1
       FROM "UserPixelEvent"
      WHERE "userId" = $1
        AND "clientIp" = $2
        AND "userAgent" = $3
        AND "createdAt" >= NOW() - INTERVAL '${DEDUPE_WINDOW_HOURS} hours'
      LIMIT 1`,
    [userId, clientIp, userAgent]
  );
  const counted = dedupeRes.rows.length === 0;

  await pool.query(
    `INSERT INTO "UserPixelEvent"
       ("userId", "wikidotId", username, "clientHash", "clientIp", "userAgent", "component", "source", "refererHost",
        "acceptLanguage", "uaPlatform", "uaBrandMajor", "uaFamily", "softprint", "visitorToken", "tlsFingerprint", "createdAt")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, NOW())`,
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
      sig.acceptLanguage,
      sig.uaPlatform,
      sig.uaBrandMajor,
      sig.uaFamily,
      sig.softprint,
      visitorToken,
      sig.tlsFingerprint
    ]
  );

  if (isInternalDebugRequest(req)) {
    extraHeaders['X-Tracking-Counted'] = counted ? '1' : '0';
  }
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
  sendPixel(res, extraHeaders, visitorToken);
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
        extraHeaders['X-Tracking-Error'] = 'not_tracked';
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
      // 三段短路:原 OR + EXISTS(unnest) 单查询的子计划会让规划器放弃索引整表过滤
      // (实测 p50 189ms,占像素延迟 97%)。绝大多数真实流量在第一段命中
      // (在档页 + lower("currentUrl") 精确匹配,走 idx_page_lower_currenturl,
      // 见 backend/sql/20260610_tracking_pixel_page_url_index.sql);后两段保持原查询
      // 的优先级语义: 在档 > currentUrl 命中 > urlHistory 命中 > 已删页兜底。
      let pageRes = await pool.query(
        `SELECT id, "wikidotId"
           FROM "Page"
          WHERE "isDeleted" = false
            AND lower("currentUrl") = ANY($1)
          ORDER BY "updatedAt" DESC,
                   id DESC
          LIMIT 1`,
        [candidateUrls]
      );
      if (pageRes.rows.length === 0) {
        pageRes = await pool.query(
          `SELECT id, "wikidotId"
             FROM "Page"
            WHERE "isDeleted" = false
              AND EXISTS (
                SELECT 1
                FROM unnest("urlHistory") AS hist(url)
                WHERE lower(hist.url) = ANY($1)
              )
            ORDER BY "updatedAt" DESC,
                     id DESC
            LIMIT 1`,
          [candidateUrls]
        );
      }
      if (pageRes.rows.length === 0) {
        // 无在档页命中才扫已删页(罕见路径,保留原合并查询及其排序)
        pageRes = await pool.query(
          `SELECT id, "wikidotId"
             FROM "Page"
            WHERE lower("currentUrl") = ANY($1)
               OR EXISTS (
                 SELECT 1
                 FROM unnest("urlHistory") AS hist(url)
                 WHERE lower(hist.url) = ANY($1)
               )
            ORDER BY "isDeleted" ASC,
                     CASE WHEN lower("currentUrl") = ANY($1) THEN 0 ELSE 1 END ASC,
                     "updatedAt" DESC,
                     id DESC
            LIMIT 1`,
          [candidateUrls]
        );
      }

      if (pageRes.rows.length === 0) {
        // 统一为 not_tracked:具体的 not_found 区分会泄漏页面/用户存在性,且对嵌入方无意义。
        extraHeaders['X-Tracking-Error'] = 'not_tracked';
        return sendPixel(res, extraHeaders);
      }

      const row = pageRes.rows[0];
      const pageId = Number(row.id);
      const wikidotId = Number(row.wikidotId);
      if (!Number.isFinite(pageId) || !Number.isFinite(wikidotId)) {
        extraHeaders['X-Tracking-Error'] = 'not_tracked';
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
        extraHeaders['X-Tracking-Error'] = 'not_tracked';
        return sendPixel(res, extraHeaders);
      }

      const row = userRes.rows[0];
      const userId = Number(row.id);
      if (!Number.isFinite(userId) || userId <= 0) {
        extraHeaders['X-Tracking-Error'] = 'not_tracked';
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
