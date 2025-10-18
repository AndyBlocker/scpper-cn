import { Router, type Request } from 'express';
import type { Pool } from 'pg';
import type { RedisClientType } from 'redis';

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

async function resolveFollowerId(pool: Pool, wikidotId: number): Promise<number | null> {
  const row = await pool.query<{ id: number }>('SELECT id FROM "User" WHERE "wikidotId" = $1 LIMIT 1', [wikidotId]);
  return row.rows.length > 0 ? row.rows[0].id : null;
}

export function followAlertsRouter(pool: Pool, _redis: RedisClientType | null) {
  const router = Router();

  router.get('/', async (req, res, next) => {
    try {
      const auth = await fetchAuthUser(req);
      if (!auth || auth.linkedWikidotId == null) return res.status(401).json({ ok: false, error: 'unauthenticated' });
      const followerId = await resolveFollowerId(pool, auth.linkedWikidotId);
      if (followerId == null) return res.json({ ok: true, alerts: [], unreadCount: 0 });

      const { type } = req.query as Record<string, string>;
      const limit = Math.max(1, Math.min(parseInt(String(req.query.limit ?? '20'), 10) || 20, 50));
      const offset = Math.max(0, parseInt(String(req.query.offset ?? '0'), 10) || 0);

      const whereType = type && (type === 'REVISION' || type === 'ATTRIBUTION' || type === 'ATTRIBUTION_REMOVED') ? type : null;

      const alertsQuery = `
        SELECT a.id, a.type, a."detectedAt", a."acknowledgedAt", a."pageId",
               p."wikidotId" AS "pageWikidotId", p."currentUrl" AS "pageUrl",
               pv.title AS "pageTitle", pv."alternateTitle" AS "pageAlternateTitle",
               a."targetUserId"
        FROM "UserActivityAlert" a
        JOIN "Page" p ON p.id = a."pageId"
        LEFT JOIN "PageVersion" pv ON pv."pageId" = a."pageId" AND pv."validTo" IS NULL
        WHERE a."followerId" = $1
          ${whereType ? `AND a.type = '${whereType}'` : ''}
        ORDER BY a."detectedAt" DESC
        LIMIT $2 OFFSET $3
      `;
      const unreadQuery = `
        SELECT COUNT(*)::int AS count
        FROM "UserActivityAlert"
        WHERE "followerId" = $1 AND "acknowledgedAt" IS NULL
          ${whereType ? `AND type = '${whereType}'` : ''}
      `;
      const [alertsRes, unreadRes] = await Promise.all([
        pool.query(alertsQuery, [followerId, limit, offset]),
        pool.query<{ count: number }>(unreadQuery, [followerId])
      ]);
      res.json({ ok: true, alerts: alertsRes.rows, unreadCount: unreadRes.rows[0]?.count ?? 0 });
    } catch (e) {
      next(e);
    }
  });

  router.get('/combined', async (req, res, next) => {
    try {
      const auth = await fetchAuthUser(req);
      if (!auth || auth.linkedWikidotId == null) return res.status(401).json({ ok: false, error: 'unauthenticated' });
      const followerId = await resolveFollowerId(pool, auth.linkedWikidotId);
      if (followerId == null) return res.json({ ok: true, total: 0, groups: [] });

      const limit = Math.max(1, Math.min(parseInt(String(req.query.limit ?? '20'), 10) || 20, 50));
      const offset = Math.max(0, parseInt(String(req.query.offset ?? '0'), 10) || 0);

      const countRes = await pool.query<{ count: number }>(
        `
          SELECT COUNT(*)::int AS count
          FROM (
            SELECT DISTINCT a."pageId"
            FROM "UserActivityAlert" a
            WHERE a."followerId" = $1 AND a."acknowledgedAt" IS NULL
          ) t
        `,
        [followerId]
      );
      const total = countRes.rows[0]?.count ?? 0;
      if (total === 0) return res.json({ ok: true, total, groups: [] });

      const groupsRes = await pool.query<{ pageId: number; updatedAt: string }>(
        `
          SELECT a."pageId" AS "pageId", MAX(a."detectedAt") AS "updatedAt"
          FROM "UserActivityAlert" a
          WHERE a."followerId" = $1 AND a."acknowledgedAt" IS NULL
          GROUP BY a."pageId"
          ORDER BY "updatedAt" DESC
          LIMIT $2 OFFSET $3
        `,
        [followerId, limit, offset]
      );

      const pageIds = groupsRes.rows.map(r => r.pageId);
      const details = await pool.query(
        `
          SELECT a.id, a.type, a."detectedAt", a."acknowledgedAt", a."pageId",
                 p."wikidotId" AS "pageWikidotId", p."currentUrl" AS "pageUrl",
                 pv.title AS "pageTitle", pv."alternateTitle" AS "pageAlternateTitle",
                 a."targetUserId"
          FROM "UserActivityAlert" a
          JOIN "Page" p ON p.id = a."pageId"
          LEFT JOIN "PageVersion" pv ON pv."pageId" = a."pageId" AND pv."validTo" IS NULL
          WHERE a."followerId" = $1 AND a."acknowledgedAt" IS NULL AND a."pageId" = ANY($2::int[])
          ORDER BY a."detectedAt" DESC
        `,
        [followerId, pageIds]
      );

      const updatedMap = new Map<number, string>();
      for (const r of groupsRes.rows) updatedMap.set(r.pageId, r.updatedAt);
      const grouped = new Map<number, any>();
      for (const row of details.rows as any[]) {
        let group = grouped.get(row.pageId);
        if (!group) {
          group = {
            pageId: row.pageId,
            pageWikidotId: row.pageWikidotId,
            pageUrl: row.pageUrl,
            pageTitle: row.pageTitle,
            pageAlternateTitle: row.pageAlternateTitle,
            updatedAt: updatedMap.get(row.pageId) || row.detectedAt,
            alerts: [] as any[]
          };
          grouped.set(row.pageId, group);
        }
        group.alerts.push(row);
      }

      const groups = groupsRes.rows.map(r => grouped.get(r.pageId)).filter(Boolean);
      res.json({ ok: true, total, groups });
    } catch (e) {
      next(e);
    }
  });

  router.post('/:id/read', async (req, res, next) => {
    try {
      const auth = await fetchAuthUser(req);
      if (!auth || auth.linkedWikidotId == null) return res.status(401).json({ ok: false, error: 'unauthenticated' });
      const followerId = await resolveFollowerId(pool, auth.linkedWikidotId);
      if (followerId == null) return res.status(404).json({ ok: false, error: 'user_not_found' });
      const id = Number.parseInt(String(req.params.id), 10);
      if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: 'invalid_id' });
      const result = await pool.query<{ id: number; acknowledgedAt: string | null }>(
        `
          UPDATE "UserActivityAlert" SET "acknowledgedAt" = COALESCE("acknowledgedAt", NOW())
          WHERE id = $1 AND "followerId" = $2
          RETURNING id, "acknowledgedAt"
        `,
        [id, followerId]
      );
      if (result.rowCount === 0) return res.status(404).json({ ok: false, error: 'not_found' });
      res.json({ ok: true, id, acknowledgedAt: result.rows[0]?.acknowledgedAt ?? null });
    } catch (e) {
      next(e);
    }
  });

  router.post('/read-all', async (req, res, next) => {
    try {
      const auth = await fetchAuthUser(req);
      if (!auth || auth.linkedWikidotId == null) return res.status(401).json({ ok: false, error: 'unauthenticated' });
      const followerId = await resolveFollowerId(pool, auth.linkedWikidotId);
      if (followerId == null) return res.status(404).json({ ok: false, error: 'user_not_found' });
      const result = await pool.query<{ id: number }>(
        `
          UPDATE "UserActivityAlert" SET "acknowledgedAt" = COALESCE("acknowledgedAt", NOW())
          WHERE "followerId" = $1 AND "acknowledgedAt" IS NULL
          RETURNING id
        `,
        [followerId]
      );
      res.json({ ok: true, updated: result.rowCount });
    } catch (e) {
      next(e);
    }
  });

  return router;
}
