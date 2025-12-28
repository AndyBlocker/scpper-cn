import { Router } from 'express';
import type { Pool } from 'pg';
import type { RedisClientType } from 'redis';
import { getReadPoolSync } from '../utils/dbPool.js';

const SORT_FIELDS = ['alpha', 'count', 'activity'] as const;
type SortKey = typeof SORT_FIELDS[number];

const DEFAULT_ORDER: Record<SortKey, 'asc' | 'desc'> = {
  alpha: 'asc',
  count: 'desc',
  activity: 'desc'
};

export function tagsRouter(pool: Pool, _redis: RedisClientType | null) {
  const router = Router();

  // 读写分离：tags 全部是读操作，使用从库
  const readPool = getReadPoolSync();

  router.get('/', async (req, res, next) => {
    try {
      const { sort = 'count', order, limit, offset } = req.query as Record<string, string | undefined>;

      if (!SORT_FIELDS.includes(sort as SortKey)) {
        return res.status(400).json({ error: 'invalid_sort' });
      }

      const normalizedSort = sort as SortKey;
      let normalizedOrder: 'asc' | 'desc' = DEFAULT_ORDER[normalizedSort];
      if (order) {
        const orderLower = order.toLowerCase();
        if (orderLower !== 'asc' && orderLower !== 'desc') {
          return res.status(400).json({ error: 'invalid_order' });
        }
        normalizedOrder = orderLower as 'asc' | 'desc';
      }

      let limitClause = '';
      let offsetClause = '';
      const params: Array<number> = [];

      if (limit !== undefined) {
        const limitValue = Number.parseInt(limit, 10);
        if (!Number.isFinite(limitValue) || limitValue <= 0) {
          return res.status(400).json({ error: 'invalid_limit' });
        }
        params.push(limitValue);
        limitClause = ` LIMIT $${params.length}`;
      }

      if (offset !== undefined) {
        const offsetValue = Number.parseInt(offset, 10);
        if (!Number.isFinite(offsetValue) || offsetValue < 0) {
          return res.status(400).json({ error: 'invalid_offset' });
        }
        params.push(offsetValue);
        offsetClause = ` OFFSET $${params.length}`;
      }

      let orderClause = '';
      switch (normalizedSort) {
        case 'alpha':
          orderClause = `ORDER BY tag ${normalizedOrder}, page_count DESC`;
          break;
        case 'count':
          orderClause = `ORDER BY page_count ${normalizedOrder}, tag ASC`;
          break;
        case 'activity':
          orderClause = `ORDER BY latest_activity ${normalizedOrder}, tag ASC`;
          break;
      }

      const sql = `
        WITH current_tags AS (
          SELECT DISTINCT
            pv."pageId" AS page_id,
            tag
          FROM "PageVersion" pv
          JOIN "Page" p ON p.id = pv."pageId"
          CROSS JOIN LATERAL UNNEST(pv.tags) AS t(tag)
          WHERE pv."validTo" IS NULL
            AND pv."isDeleted" = false
            AND p."isDeleted" = false
            AND tag IS NOT NULL AND btrim(tag) <> ''
        ),
        tag_history AS (
          SELECT
            pv."pageId" AS page_id,
            tag,
            MIN(
              COALESCE(
                rev.first_revision,
                pv."validFrom",
                pv."createdAt"
              )
            ) AS first_added
          FROM "PageVersion" pv
          JOIN "Page" p ON p.id = pv."pageId"
          LEFT JOIN LATERAL (
            SELECT MIN(r."timestamp") AS first_revision
            FROM "Revision" r
            WHERE r."pageVersionId" = pv.id
          ) rev ON TRUE
          CROSS JOIN LATERAL UNNEST(pv.tags) AS t(tag)
          WHERE COALESCE(array_length(pv.tags, 1), 0) > 0
            AND tag IS NOT NULL AND btrim(tag) <> ''
          GROUP BY pv."pageId", tag
        )
        SELECT
          ct.tag AS tag,
          COUNT(*)::int AS page_count,
          MAX(th.first_added) AS latest_activity,
          MIN(th.first_added) AS oldest_activity
        FROM current_tags ct
        JOIN tag_history th ON th.page_id = ct.page_id AND th.tag = ct.tag
        GROUP BY ct.tag
        ${orderClause}
        ${limitClause}
        ${offsetClause}
      `;

      const { rows } = await readPool.query(sql, params);

      const tags = rows.map((row: any) => ({
        tag: row.tag,
        pageCount: Number(row.page_count || 0),
        latestActivity: row.latest_activity ?? null,
        oldestActivity: row.oldest_activity ?? null
      }));

      res.json({
        tags,
        meta: {
          sort: normalizedSort,
          order: normalizedOrder,
          limit: limit !== undefined ? Number.parseInt(limit, 10) : null,
          offset: offset !== undefined ? Number.parseInt(offset, 10) : null
        }
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
