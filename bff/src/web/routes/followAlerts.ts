import { Router } from 'express';
import { loadSiteVisibility, siteBoundaryClause } from '../utils/notifyPrefs.js';
import type { Pool } from 'pg';
import type { RedisClientType } from 'redis';
import { getReadPoolSync } from '../utils/dbPool.js';
import { fetchAuthUser } from '../utils/auth.js';

async function resolveFollowerId(readPool: Pool, wikidotId: number): Promise<number | null> {
  const row = await readPool.query<{ id: number }>('SELECT id FROM "User" WHERE "wikidotId" = $1 LIMIT 1', [wikidotId]);
  return row.rows.length > 0 ? row.rows[0].id : null;
}

export function followAlertsRouter(pool: Pool, _redis: RedisClientType | null) {
  const router = Router();

  // 读写分离：GET 使用从库，POST 使用主库
  const readPool = getReadPoolSync();

  router.get('/', async (req, res, next) => {
    try {
      const auth = await fetchAuthUser(req);
      if (!auth || auth.linkedWikidotId == null) return res.status(401).json({ ok: false, error: 'unauthenticated' });
      const followerId = await resolveFollowerId(readPool, auth.linkedWikidotId);
      if (followerId == null) return res.json({ ok: true, alerts: [], unreadCount: 0 });

      // 用主库 pool 而非 readPool：这是**用户刚刚在设置页改过**的值，
      // 走副本会撞上复制延迟 —— 关掉后还看得见、打开后还看不见。
      // 列表数据走副本没问题（慢一点无所谓），但控制可见性的开关不行。
      // 用户关掉了「关注动态」的站内展示：列表与未读数一并置空。
      // 两者必须一起，只清列表会留下一个消不掉的红点。
      // 注意这不影响 QQ 推送 —— 两个渠道各自独立。
      const visibility = await loadSiteVisibility(pool, followerId);
      if (visibility.disabled.has('FOLLOW_ACTIVITY')) {
        return res.json({ ok: true, alerts: [], unreadCount: 0 });
      }
      // 关闭期间攒下的不算「新未读」—— 只显示最近一次切换之后的
      const followBoundary = visibility.suppressedBefore.get('FOLLOW_ACTIVITY');

      const { type } = req.query as Record<string, string>;
      // 同 /alerts：不加这个参数，客户端过滤会让「最新 20 条已读完」的用户
      // 看到空列表而徽标仍有数字
      const unreadOnly = String(req.query.unreadOnly ?? '') === '1';
      const limit = Math.max(1, Math.min(parseInt(String(req.query.limit ?? '20'), 10) || 20, 50));
      const offset = Math.max(0, parseInt(String(req.query.offset ?? '0'), 10) || 0);

      const whereType = type && (type === 'REVISION' || type === 'ATTRIBUTION' || type === 'ATTRIBUTION_REMOVED') ? type : null;

      const alertsParams: (number | string)[] = [followerId];
      let alertsTypeClause = '';
      if (whereType) {
        alertsParams.push(whereType);
        alertsTypeClause = `AND a.type = $${alertsParams.length}`;
      }
      alertsParams.push(limit);
      const limitIdx = alertsParams.length;
      alertsParams.push(offset);
      const offsetIdx = alertsParams.length;

      const alertsQuery = `
        SELECT a.id, a.type, a."detectedAt", a."acknowledgedAt", a."pageId",
               p."wikidotId" AS "pageWikidotId", p."currentUrl" AS "pageUrl",
               pv.title AS "pageTitle", pv."alternateTitle" AS "pageAlternateTitle",
               a."targetUserId",
               -- 被关注者的名字：此前只返回 targetUserId，前端只能显示「你关注的作者」，
               -- 用户看不出到底是谁动了什么，关注多个作者时这条提醒几乎没有信息量
               tu."displayName" AS "targetDisplayName",
               tu."wikidotId" AS "targetWikidotId"
        FROM "UserActivityAlert" a
        JOIN "Page" p ON p.id = a."pageId"
        LEFT JOIN "PageVersion" pv ON pv."pageId" = a."pageId" AND pv."validTo" IS NULL
        LEFT JOIN "User" tu ON tu.id = a."targetUserId"
        WHERE a."followerId" = $1
          ${alertsTypeClause}
          ${unreadOnly ? 'AND a."acknowledgedAt" IS NULL' : ''}
          ${siteBoundaryClause(followBoundary, alertsParams, 'a')}
        ORDER BY a."detectedAt" DESC
        LIMIT $${limitIdx} OFFSET $${offsetIdx}
      `;

      const unreadParams: (number | string)[] = [followerId];
      let unreadTypeClause = '';
      if (whereType) {
        unreadParams.push(whereType);
        unreadTypeClause = `AND type = $${unreadParams.length}`;
      }
      const unreadQuery = `
        SELECT COUNT(*)::int AS count
        FROM "UserActivityAlert"
        WHERE "followerId" = $1 AND "acknowledgedAt" IS NULL
          ${unreadTypeClause}
          ${siteBoundaryClause(followBoundary, unreadParams, '')}
      `;
      const [alertsRes, unreadRes] = await Promise.all([
        readPool.query(alertsQuery, alertsParams),
        readPool.query<{ count: number }>(unreadQuery, unreadParams)
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
      const followerId = await resolveFollowerId(readPool, auth.linkedWikidotId);
      if (followerId == null) return res.json({ ok: true, total: 0, groups: [] });

      // combined 与根路由是**两个独立入口**，只在根路由加过滤等于没加 ——
      // 用这个端点的客户端会完全绕过站内开关。
      const combinedVisibility = await loadSiteVisibility(pool, followerId);
      if (combinedVisibility.disabled.has('FOLLOW_ACTIVITY')) {
        return res.json({ ok: true, total: 0, groups: [] });
      }
      // 计数、分组、明细三处都要过滤 —— 漏掉任一处就会出现
      // 「总数对不上分组」或「分组里冒出关闭期间的旧条目」
      const combinedBoundary = combinedVisibility.suppressedBefore.get('FOLLOW_ACTIVITY');

      const limit = Math.max(1, Math.min(parseInt(String(req.query.limit ?? '20'), 10) || 20, 50));
      const offset = Math.max(0, parseInt(String(req.query.offset ?? '0'), 10) || 0);

      const countParams: unknown[] = [followerId];
      const countRes = await readPool.query<{ count: number }>(
        `
          SELECT COUNT(*)::int AS count
          FROM (
            SELECT DISTINCT a."pageId"
            FROM "UserActivityAlert" a
            WHERE a."followerId" = $1 AND a."acknowledgedAt" IS NULL
              ${siteBoundaryClause(combinedBoundary, countParams, 'a')}
          ) t
        `,
        countParams
      );
      const total = countRes.rows[0]?.count ?? 0;
      if (total === 0) return res.json({ ok: true, total, groups: [] });

      // limit/offset 固定在 $2/$3，边界参数追加在后面
      const groupParams: unknown[] = [followerId, limit, offset];
      const groupsRes = await readPool.query<{ pageId: number; updatedAt: string }>(
        `
          SELECT a."pageId" AS "pageId", MAX(a."detectedAt") AS "updatedAt"
          FROM "UserActivityAlert" a
          WHERE a."followerId" = $1 AND a."acknowledgedAt" IS NULL
            ${siteBoundaryClause(combinedBoundary, groupParams, 'a')}
          GROUP BY a."pageId"
          ORDER BY "updatedAt" DESC
          LIMIT $2 OFFSET $3
        `,
        groupParams
      );

      const pageIds = groupsRes.rows.map(r => r.pageId);
      const detailParams: unknown[] = [followerId, pageIds];
      const details = await readPool.query(
        `
          SELECT a.id, a.type, a."detectedAt", a."acknowledgedAt", a."pageId",
                 p."wikidotId" AS "pageWikidotId", p."currentUrl" AS "pageUrl",
                 pv.title AS "pageTitle", pv."alternateTitle" AS "pageAlternateTitle",
                 a."targetUserId"
          FROM "UserActivityAlert" a
          JOIN "Page" p ON p.id = a."pageId"
          LEFT JOIN "PageVersion" pv ON pv."pageId" = a."pageId" AND pv."validTo" IS NULL
          WHERE a."followerId" = $1 AND a."acknowledgedAt" IS NULL AND a."pageId" = ANY($2::int[])
            ${siteBoundaryClause(combinedBoundary, detailParams, 'a')}
          ORDER BY a."detectedAt" DESC
        `,
        detailParams
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
      const readAllVisibility = await loadSiteVisibility(pool, followerId);
      if (readAllVisibility.disabled.has('FOLLOW_ACTIVITY')) {
        return res.json({ ok: true, updated: 0 });
      }
      const readAllParams: unknown[] = [followerId];
      const result = await pool.query<{ id: number }>(
        `
          UPDATE "UserActivityAlert" SET "acknowledgedAt" = COALESCE("acknowledgedAt", NOW())
          WHERE "followerId" = $1 AND "acknowledgedAt" IS NULL
          -- 「全部已读」只能覆盖用户**实际看得见的**那些。
          -- acknowledgedAt 是两个渠道共用的状态：QQ 投递器拿它判断「不必再推」。
          -- 把站内隐藏的行一并标记，等于用户点一下「全部已读」就把待发的
          -- QQ 通知悄悄杀掉了 —— 而他根本没看到过那些条目。
          ${siteBoundaryClause(readAllVisibility.suppressedBefore.get('FOLLOW_ACTIVITY'), readAllParams, '')}
          RETURNING id
        `,
        readAllParams
      );
      res.json({ ok: true, updated: result.rowCount });
    } catch (e) {
      next(e);
    }
  });

  return router;
}
