import { Router } from 'express';
import type { Pool } from 'pg';
import type { RedisClientType } from 'redis';
import type { Request } from 'express';

const USER_BACKEND_DEFAULT = 'http://127.0.0.1:4455';

interface AuthUserPayload {
  id: string;
  email: string;
  displayName: string | null;
  linkedWikidotId: number | null;
  lastLoginAt: string | null;
}

async function fetchAuthUser(req: Request): Promise<AuthUserPayload | null> {
  const base = process.env.USER_BACKEND_BASE_URL || USER_BACKEND_DEFAULT;
  if (!base || base === 'disable') return null;
  const target = base.replace(/\/$/, '') + '/auth/me';
  try {
    const response = await fetch(target, {
      method: 'GET',
      headers: { accept: 'application/json', cookie: req.headers.cookie ?? '' }
    });
    if (response.status === 401 || !response.ok) return null;
    const data = await response.json();
    if (!data?.ok || !data.user) return null;
    return {
      id: String(data.user.id),
      email: String(data.user.email || ''),
      displayName: data.user.displayName ?? null,
      linkedWikidotId: data.user.linkedWikidotId != null ? Number(data.user.linkedWikidotId) : null,
      lastLoginAt: data.user.lastLoginAt ?? null
    };
  } catch {
    return null;
  }
}

async function ensureUserByWikidotId(pool: Pool, wikidotId: number): Promise<number | null> {
  const found = await pool.query<{ id: number }>('SELECT id FROM "User" WHERE "wikidotId" = $1 LIMIT 1', [wikidotId]);
  if (found.rows.length > 0) return found.rows[0].id;
  const inserted = await pool.query<{ id: number }>(
    'INSERT INTO "User" ("wikidotId") VALUES ($1) ON CONFLICT ("wikidotId") DO NOTHING RETURNING id',
    [wikidotId]
  );
  if (inserted.rows.length > 0) return inserted.rows[0].id;
  // race: another insert happened; reselect
  const again = await pool.query<{ id: number }>('SELECT id FROM "User" WHERE "wikidotId" = $1 LIMIT 1', [wikidotId]);
  return again.rows.length > 0 ? again.rows[0].id : null;
}

export function followsRouter(pool: Pool, _redis: RedisClientType | null) {
  const router = Router();

  router.get('/', async (req, res, next) => {
    try {
      const auth = await fetchAuthUser(req);
      if (!auth || auth.linkedWikidotId == null) return res.status(401).json({ ok: false, error: 'unauthenticated' });
      const followerId = await ensureUserByWikidotId(pool, auth.linkedWikidotId);
      if (followerId == null) return res.status(500).json({ ok: false, error: 'user_resolve_failed' });

      const rows = await pool.query<{ id: number; targetUserId: number; wikidotId: number | null; displayName: string | null }>(
        `
          SELECT f.id, f."targetUserId", u."wikidotId", u."displayName"
          FROM "UserFollow" f
          JOIN "User" u ON u.id = f."targetUserId"
          WHERE f."followerId" = $1
          ORDER BY f."createdAt" DESC
        `,
        [followerId]
      );
      res.json({ ok: true, follows: rows.rows });
    } catch (e) {
      next(e);
    }
  });

  router.post('/', async (req, res, next) => {
    try {
      const auth = await fetchAuthUser(req);
      if (!auth || auth.linkedWikidotId == null) return res.status(401).json({ ok: false, error: 'unauthenticated' });
      const followerId = await ensureUserByWikidotId(pool, auth.linkedWikidotId);
      if (followerId == null) return res.status(500).json({ ok: false, error: 'user_resolve_failed' });

      const targetWikidotId = Number.parseInt(String(req.body?.targetWikidotId ?? ''), 10);
      if (!Number.isFinite(targetWikidotId) || targetWikidotId <= 0) return res.status(400).json({ ok: false, error: 'invalid_target' });
      const targetUserId = await ensureUserByWikidotId(pool, targetWikidotId);
      if (targetUserId == null) return res.status(500).json({ ok: false, error: 'target_resolve_failed' });
      if (targetUserId === followerId) return res.status(400).json({ ok: false, error: 'cannot_follow_self' });

      const inserted = await pool.query<{ id: number }>(
        `
          INSERT INTO "UserFollow" ("followerId", "targetUserId")
          VALUES ($1, $2)
          ON CONFLICT ("followerId", "targetUserId") DO NOTHING
          RETURNING id
        `,
        [followerId, targetUserId]
      );
      const id = inserted.rows[0]?.id || null;
      res.json({ ok: true, id, followerId, targetUserId });
    } catch (e) {
      next(e);
    }
  });

  router.delete('/:target', async (req, res, next) => {
    try {
      const auth = await fetchAuthUser(req);
      if (!auth || auth.linkedWikidotId == null) return res.status(401).json({ ok: false, error: 'unauthenticated' });
      const followerId = await ensureUserByWikidotId(pool, auth.linkedWikidotId);
      if (followerId == null) return res.status(500).json({ ok: false, error: 'user_resolve_failed' });

      const targetWikidotId = Number.parseInt(String(req.params.target ?? ''), 10);
      if (!Number.isFinite(targetWikidotId) || targetWikidotId <= 0) return res.status(400).json({ ok: false, error: 'invalid_target' });
      const targetUserRow = await pool.query<{ id: number }>('SELECT id FROM "User" WHERE "wikidotId" = $1 LIMIT 1', [targetWikidotId]);
      if (targetUserRow.rowCount === 0) return res.json({ ok: true, deleted: 0 });
      const targetUserId = targetUserRow.rows[0].id;
      const result = await pool.query('DELETE FROM "UserFollow" WHERE "followerId" = $1 AND "targetUserId" = $2', [followerId, targetUserId]);
      res.json({ ok: true, deleted: result.rowCount || 0 });
    } catch (e) {
      next(e);
    }
  });

  return router;
}
