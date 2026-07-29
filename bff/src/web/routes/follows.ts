import { Router } from 'express';
import type { Pool } from 'pg';
import type { RedisClientType } from 'redis';
import { fetchAuthUser, ensureUserByWikidotId, findUserByWikidotId } from '../utils/auth.js';
import { getReadPoolSync } from '../utils/dbPool.js';

export function followsRouter(pool: Pool, _redis: RedisClientType | null) {
  const router = Router();

  // 读写分离：GET 使用从库，POST/DELETE 使用主库
  const readPool = getReadPoolSync();

  router.get('/', async (req, res, next) => {
    try {
      const auth = await fetchAuthUser(req);
      if (!auth || auth.linkedWikidotId == null) return res.status(401).json({ ok: false, error: 'unauthenticated' });
      const followerId = await ensureUserByWikidotId(pool, auth.linkedWikidotId);
      if (followerId == null) return res.status(500).json({ ok: false, error: 'user_resolve_failed' });

      const rows = await readPool.query<{ id: number; targetUserId: number; wikidotId: number | null; displayName: string | null }>(
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
      // 只查不建：targetWikidotId 完全由客户端控制，用 ensure 会让任意登录用户
      // 往主库注入任意 User 行。关注一个站上不存在的用户本来也没有意义。
      const targetUserId = await findUserByWikidotId(pool, targetWikidotId);
      if (targetUserId == null) return res.status(404).json({ ok: false, error: 'target_not_found' });
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
      // ON CONFLICT DO NOTHING 时无返回行 —— 用 created 明确区分「新建」与「早已关注」，
      // 否则调用方看到 id:null 无从判断，将来要按「新增关注」触发欢迎推送就会出错。
      const id = inserted.rows[0]?.id ?? null;
      res.json({ ok: true, id, created: id !== null, followerId, targetUserId });
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
