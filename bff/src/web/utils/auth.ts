import type { Request } from 'express';
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

export async function fetchAuthUser(req: Request): Promise<AuthUserPayload | null> {
  const base = process.env.USER_BACKEND_BASE_URL || USER_BACKEND_DEFAULT;
  if (!base || base === 'disable') return null;
  const target = base.replace(/\/$/, '') + '/auth/me';
  try {
    const response = await fetch(target, {
      method: 'GET',
      headers: { accept: 'application/json', cookie: req.headers.cookie ?? '' }
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
    // eslint-disable-next-line no-console
    console.error('[fetchAuthUser] user-backend unreachable:', err instanceof Error ? err.message : err);
    return null;
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
