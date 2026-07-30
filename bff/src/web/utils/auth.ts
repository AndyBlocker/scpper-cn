import type { NextFunction, Request, Response } from 'express';
import type { Pool } from 'pg';

export interface AuthUserPayload {
  id: string;
  email: string;
  displayName: string | null;
  linkedWikidotId: number | null;
  lastLoginAt: string | null;
  /**
   * 通知渠道绑定摘要。**只有掩码**（1234***7）——
   * user-backend 刻意不把完整 QQ 号发到 BFF，所以 BFF 全链路（含前端）都拿不到它。
   * 完整号只在 user-backend 的投递路径与 backend dispatcher 的跨库只读查询里出现。
   */
  qqBinding: {
    bound: boolean;
    addressMask: string | null;
    status: string | null;
    pendingChallenge: boolean;
    capabilities: {
      featureEnabled: boolean;
      createBinding: boolean;
      deliverNotifications: boolean;
      manageExistingBinding: boolean;
    };
  };
}

const USER_BACKEND_DEFAULT = 'http://127.0.0.1:4455';
const USER_BACKEND_AUTH_TIMEOUT_DEFAULT_MS = 2_000;
const USER_BACKEND_AUTH_TIMEOUT_MIN_MS = 100;
const USER_BACKEND_AUTH_TIMEOUT_MAX_MS = 5_000;
export const EXPECTED_USER_ID_HEADER = 'x-scpper-expected-user-id';
const READ_METHODS = new Set(['GET', 'HEAD']);
const requestAuthCache = new WeakMap<Request, Promise<AuthUserPayload | null>>();

function userBackendAuthTimeoutMs(): number {
  const raw = process.env.USER_BACKEND_AUTH_TIMEOUT_MS?.trim();
  if (!raw) return USER_BACKEND_AUTH_TIMEOUT_DEFAULT_MS;

  const configured = Number(raw);
  if (!Number.isFinite(configured)) return USER_BACKEND_AUTH_TIMEOUT_DEFAULT_MS;
  return Math.min(
    USER_BACKEND_AUTH_TIMEOUT_MAX_MS,
    Math.max(USER_BACKEND_AUTH_TIMEOUT_MIN_MS, Math.trunc(configured))
  );
}

async function fetchAuthUserUncached(req: Request): Promise<AuthUserPayload | null> {
  const base = process.env.USER_BACKEND_BASE_URL || USER_BACKEND_DEFAULT;
  if (!base || base === 'disable') return null;
  const target = base.replace(/\/$/, '') + '/auth/me';
  const timeoutMs = userBackendAuthTimeoutMs();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  timeout.unref?.();
  try {
    const response = await fetch(target, {
      method: 'GET',
      headers: { accept: 'application/json', cookie: req.headers.cookie ?? '' },
      signal: controller.signal
    });
    if (response.status === 401) return null;
    if (!response.ok) {
      // eslint-disable-next-line no-console
      console.warn(`[fetchAuthUser] user-backend returned ${response.status}`);
      return null;
    }
    const data = await response.json();
    if (!data?.ok || !data.user) return null;
    const bound = Boolean(data.user.qqBinding?.bound);
    const pendingChallenge = Boolean(data.user.qqBinding?.pendingChallenge);
    const capabilities = data.user.qqBinding?.capabilities;
    return {
      id: String(data.user.id),
      email: String(data.user.email || ''),
      displayName: data.user.displayName ?? null,
      linkedWikidotId: data.user.linkedWikidotId != null ? Number(data.user.linkedWikidotId) : null,
      lastLoginAt: data.user.lastLoginAt ?? null,
      // 只有掩码。老版本 user-backend 不返回该字段时给安全默认值，
      // 免得调用方到处判 undefined 还漏掉一处。
      qqBinding: {
        bound,
        addressMask: data.user.qqBinding?.addressMask ?? null,
        status: data.user.qqBinding?.status ?? null,
        pendingChallenge,
        capabilities: {
          // 兼容滚动发布中的旧 user-backend：缺失能力字段时按安全方向关闭
          // 新建与投递，但仍根据已有摘要保留清理入口。
          featureEnabled: Boolean(capabilities?.featureEnabled),
          createBinding: Boolean(capabilities?.createBinding),
          deliverNotifications: Boolean(capabilities?.deliverNotifications),
          manageExistingBinding: capabilities?.manageExistingBinding == null
            ? bound || pendingChallenge
            : Boolean(capabilities.manageExistingBinding)
        }
      }
    };
  } catch (err) {
    if (controller.signal.aborted) {
      // eslint-disable-next-line no-console
      console.warn(`[fetchAuthUser] user-backend timed out after ${timeoutMs}ms`);
      return null;
    }
    // eslint-disable-next-line no-console
    console.error('[fetchAuthUser] user-backend unreachable:', err instanceof Error ? err.message : err);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Re-read /auth/me without this request's WeakMap snapshot.
 *
 * Most route logic should use fetchAuthUser(). Collection ownership takeover is
 * the exception: after locking the current claimant it must verify that the
 * incoming Wikidot link is still authoritative, otherwise an in-flight stale
 * request could reclaim an identity that an administrator just transferred.
 */
export function fetchFreshAuthUser(req: Request): Promise<AuthUserPayload | null> {
  return fetchAuthUserUncached(req);
}

/**
 * A request can pass through an expected-user guard and then its route handler.
 * Reuse the same /auth/me result so the guard does not double the auth-service
 * traffic and both checks operate on one identity snapshot.
 */
export function fetchAuthUser(req: Request): Promise<AuthUserPayload | null> {
  const cached = requestAuthCache.get(req);
  if (cached) return cached;
  const pending = fetchAuthUserUncached(req);
  requestAuthCache.set(req, pending);
  return pending;
}

function expectedUserId(req: Request): string | null {
  const raw = req.headers[EXPECTED_USER_ID_HEADER];
  if (raw === undefined) return null;
  if (Array.isArray(raw)) return raw.join(',');
  return String(raw).trim();
}

const hasPathPrefix = (path: string, prefix: string) =>
  path === prefix || path.startsWith(`${prefix}/`);

function requestPath(req: Request): string {
  const raw = String(req.originalUrl || req.url || req.path || '/');
  const path = raw.split(/[?#]/u, 1)[0] || '/';
  return (path.startsWith('/') ? path : `/${path}`).replace(/\/+$/u, '') || '/';
}

/**
 * Private GET/HEAD routes that are scoped to the session owner.
 *
 * `/auth/me` is deliberately excluded: it is the source of truth used to
 * re-resolve the real cookie identity after a mismatch. Public collections
 * stay anonymous and cacheable. This list covers BFF-owned private reads;
 * proxied `/gacha` and `/admin` reads are checked by user-backend after the
 * BFF forwards the same header.
 */
export function isExpectedUserPrivateReadPath(path: string): boolean {
  if (path === '/auth/me' || hasPathPrefix(path, '/collections/public')) {
    return false;
  }

  if (
    hasPathPrefix(path, '/alerts')
    || hasPathPrefix(path, '/follows')
    || hasPathPrefix(path, '/collections')
    || hasPathPrefix(path, '/ftml-projects')
  ) {
    return true;
  }

  return path === '/qq-binding/status'
    || path === '/wikidot-binding/status'
    || path === '/wikidot-binding/resolve';
}

function shouldCheckExpectedUser(req: Request): boolean {
  const method = req.method.toUpperCase();
  if (method === 'OPTIONS') return false;
  if (READ_METHODS.has(method)) {
    return isExpectedUserPrivateReadPath(requestPath(req));
  }

  // Preserve the pre-existing mutation boundary. Other proxied user-backend
  // mutations are independently checked by its requireAuth middleware.
  const path = requestPath(req);
  return hasPathPrefix(path, '/alerts')
    || hasPathPrefix(path, '/follows')
    || (
      hasPathPrefix(path, '/collections')
      && !hasPathPrefix(path, '/collections/public')
    );
}

function accountMismatch(res: Response) {
  return res.status(409).json({
    ok: false,
    code: 'account_mismatch',
    error: '登录账号已切换，请刷新后重试。'
  });
}

/**
 * Optimistic concurrency guard for account identity.
 *
 * It is deliberately optional for rolling deploys: requests from old clients
 * without the header keep their existing behavior. New clients send the user
 * id from their last trusted auth snapshot. If another tab has since replaced
 * the cookie, private reads and mutations are rejected before a database owner
 * is resolved, including GET paths whose owner resolution can insert rows.
 */
export async function requireExpectedUser(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const expected = expectedUserId(req);
  if (expected === null || !shouldCheckExpectedUser(req)) {
    return next();
  }

  try {
    const actual = await fetchAuthUser(req);
    // With a trusted client snapshot but no verifiable cookie identity, fail
    // closed before private data is read. The 409 recovery path re-runs
    // /auth/me, which will then resolve an expired session to 401 or pick up the
    // replacement account. Header-less old clients retain their old behavior.
    if (!actual) return accountMismatch(res);
    if (expected !== actual.id) {
      return accountMismatch(res);
    }
    return next();
  } catch (error) {
    return next(error);
  }
}

/**
 * 只查不建。用于「客户端传来的 wikidotId」这类不可信输入。
 *
 * 与 ensureUserByWikidotId 的区别是它**不会插入新行** —— 后者被
 * POST /follows 用在客户端可控的 targetWikidotId 上，等于让任意登录用户
 * 往主库注入任意 User 行（没有校验该 wikidotId 是否真实存在于 Wikidot），
 * 可批量刷出空 User 行污染统计、并拉高 syncAutoWatches 的扫描成本。
 */
export async function findUserByWikidotId(pool: Pool, wikidotId: number): Promise<number | null> {
  if (!Number.isFinite(wikidotId) || wikidotId <= 0) return null;
  const found = await pool.query<{ id: number }>('SELECT id FROM "User" WHERE "wikidotId" = $1 LIMIT 1', [wikidotId]);
  return found.rows[0]?.id ?? null;
}

/** 查不到则插入。**只能用于已验证的身份**（如当前登录用户自己的 linkedWikidotId）。 */
export async function ensureUserByWikidotId(pool: Pool, wikidotId: number): Promise<number | null> {
  if (!Number.isFinite(wikidotId) || wikidotId <= 0) return null;
  const found = await pool.query<{ id: number }>('SELECT id FROM "User" WHERE "wikidotId" = $1 LIMIT 1', [wikidotId]);
  if (found.rows.length > 0) return found.rows[0].id;
  const inserted = await pool.query<{ id: number }>(
    'INSERT INTO "User" ("wikidotId") VALUES ($1) ON CONFLICT ("wikidotId") DO NOTHING RETURNING id',
    [wikidotId]
  );
  if (inserted.rows.length > 0) return inserted.rows[0].id;
  const again = await pool.query<{ id: number }>('SELECT id FROM "User" WHERE "wikidotId" = $1 LIMIT 1', [wikidotId]);
  return again.rows.length > 0 ? again.rows[0].id : null;
}
