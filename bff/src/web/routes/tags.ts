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

      // 从缓存读取（如果有缓存）
      const { rows: cacheCheck } = await readPool.query(`
        SELECT COUNT(*)::int as count FROM "TagValidationCache" WHERE "validationType" = 'all'
      `);
      const hasCache = cacheCheck[0]?.count > 0;

      let tags: Array<{ tag: string; pageCount: number; latestActivity: Date | null }>;

      if (hasCache) {
        // 从缓存读取
        let orderClause = '';
        switch (normalizedSort) {
          case 'alpha':
            orderClause = `ORDER BY tag ${normalizedOrder}, "pageCount" DESC`;
            break;
          case 'count':
            orderClause = `ORDER BY "pageCount" ${normalizedOrder}, tag ASC`;
            break;
          case 'activity':
            orderClause = `ORDER BY "latestPageDate" ${normalizedOrder} NULLS LAST, tag ASC`;
            break;
        }

        const sql = `
          SELECT tag, "pageCount", "latestPageDate"
          FROM "TagValidationCache"
          WHERE "validationType" = 'all'
          ${orderClause}
          ${limitClause}
          ${offsetClause}
        `;

        const { rows } = await readPool.query(sql, params);
        tags = rows.map((row: any) => ({
          tag: row.tag,
          pageCount: Number(row.pageCount || 0),
          latestActivity: row.latestPageDate ?? null
        }));
      } else {
        // 回退到实时计算（用于缓存未生成时）
        let orderClause = '';
        switch (normalizedSort) {
          case 'alpha':
            orderClause = `ORDER BY tag ${normalizedOrder}, page_count DESC`;
            break;
          case 'count':
            orderClause = `ORDER BY page_count ${normalizedOrder}, tag ASC`;
            break;
          case 'activity':
            orderClause = `ORDER BY latest_page_date ${normalizedOrder} NULLS LAST, tag ASC`;
            break;
        }

        const sql = `
          SELECT
            t.tag,
            COUNT(DISTINCT pv."pageId")::int as page_count,
            MAX(pv."createdAt") as latest_page_date
          FROM "PageVersion" pv
          CROSS JOIN LATERAL unnest(pv.tags) AS t(tag)
          WHERE pv."validTo" IS NULL AND NOT pv."isDeleted"
            AND t.tag IS NOT NULL AND btrim(t.tag) <> ''
          GROUP BY t.tag
          ${orderClause}
          ${limitClause}
          ${offsetClause}
        `;

        const { rows } = await readPool.query(sql, params);
        tags = rows.map((row: any) => ({
          tag: row.tag,
          pageCount: Number(row.page_count || 0),
          latestActivity: row.latest_page_date ?? null
        }));
      }

      res.json({
        tags,
        meta: {
          sort: normalizedSort,
          order: normalizedOrder,
          limit: limit !== undefined ? Number.parseInt(limit, 10) : null,
          offset: offset !== undefined ? Number.parseInt(offset, 10) : null,
          cached: hasCache
        }
      });
    } catch (err) {
      next(err);
    }
  });

  // GET /api/tags/definitions - 获取所有标签定义
  router.get('/definitions', async (req, res, next) => {
    try {
      const { search, hasTranslation, category, limit = '200', offset = '0' } = req.query as Record<string, string | undefined>;

      let sql = `
        SELECT id, "tagChinese", "tagEnglish", description, "sourcePageUrl", category, "updatedAt"
        FROM "TagDefinition"
        WHERE 1=1
      `;
      const params: (string | number)[] = [];

      if (search) {
        params.push(`%${search}%`);
        sql += ` AND ("tagChinese" ILIKE $${params.length} OR "tagEnglish" ILIKE $${params.length})`;
      }

      if (hasTranslation === 'true') {
        sql += ` AND "tagEnglish" IS NOT NULL`;
      } else if (hasTranslation === 'false') {
        sql += ` AND "tagEnglish" IS NULL`;
      }

      if (category) {
        params.push(category);
        sql += ` AND category = $${params.length}`;
      }

      // Count total
      const countSql = sql.replace(/SELECT .* FROM/, 'SELECT COUNT(*)::int as total FROM');
      const { rows: countRows } = await readPool.query(countSql, params);
      const total = countRows[0]?.total || 0;

      // Add pagination
      const limitValue = Math.min(Number.parseInt(limit, 10) || 200, 1000);
      const offsetValue = Number.parseInt(offset, 10) || 0;
      params.push(limitValue, offsetValue);
      sql += ` ORDER BY "tagChinese" LIMIT $${params.length - 1} OFFSET $${params.length}`;

      const { rows } = await readPool.query(sql, params);
      res.json({ definitions: rows, total });
    } catch (err) {
      next(err);
    }
  });

  // GET /api/tags/definitions/stats - 获取标签定义统计
  router.get('/definitions/stats', async (req, res, next) => {
    try {
      const { rows } = await readPool.query(`
        SELECT
          COUNT(*)::int as total,
          COUNT("tagEnglish")::int as with_translation,
          (COUNT(*) - COUNT("tagEnglish"))::int as without_translation
        FROM "TagDefinition"
      `);

      const { rows: categoryRows } = await readPool.query(`
        SELECT category, COUNT(*)::int as count
        FROM "TagDefinition"
        GROUP BY category
        ORDER BY count DESC
      `);

      // 从缓存获取无效标签数量
      const { rows: invalidRows } = await readPool.query(`
        SELECT COUNT(*)::int as count FROM "TagValidationCache" WHERE "validationType" = 'invalid'
      `);

      res.json({
        total: rows[0]?.total || 0,
        withTranslation: rows[0]?.with_translation || 0,
        withoutTranslation: rows[0]?.without_translation || 0,
        invalidCount: invalidRows[0]?.count || 0,
        byCategory: categoryRows.map((r: any) => ({
          category: r.category || '未分类',
          count: r.count
        }))
      });
    } catch (err) {
      next(err);
    }
  });

  // GET /api/tags/definitions/invalid - 获取疑似无效的标签（从缓存读取，支持分页和排序）
  router.get('/definitions/invalid', async (req, res, next) => {
    try {
      const {
        limit = '50',
        offset = '0',
        sort = 'count' // 'count' 或 'recent'
      } = req.query as Record<string, string | undefined>;

      const limitValue = Math.min(Number.parseInt(limit, 10) || 50, 200);
      const offsetValue = Number.parseInt(offset, 10) || 0;

      // 根据排序方式选择 ORDER BY
      const orderBy = sort === 'recent'
        ? '"latestPageDate" DESC NULLS LAST, "pageCount" DESC'
        : '"pageCount" DESC, "latestPageDate" DESC NULLS LAST';

      // 获取总数
      const { rows: countRows } = await readPool.query(`
        SELECT COUNT(*)::int as total FROM "TagValidationCache" WHERE "validationType" = 'invalid'
      `);
      const total = countRows[0]?.total || 0;

      // 从预计算的缓存表读取
      const { rows } = await readPool.query(`
        SELECT tag, "pageCount", "samplePages", "latestPageDate"
        FROM "TagValidationCache"
        WHERE "validationType" = 'invalid'
        ORDER BY ${orderBy}
        LIMIT $1 OFFSET $2
      `, [limitValue, offsetValue]);

      const invalidTags = rows.map((r: any) => ({
        tag: r.tag,
        pageCount: r.pageCount,
        samplePages: (r.samplePages || []).slice(0, 5),
        latestPageDate: r.latestPageDate
      }));

      res.json({ invalidTags, total, limit: limitValue, offset: offsetValue });
    } catch (err) {
      next(err);
    }
  });

  // GET /api/tags/definitions/untranslated - 获取未翻译的标签
  router.get('/definitions/untranslated', async (req, res, next) => {
    try {
      const {
        limit = '500',
        offset = '0',
        sort = 'usage' // 'usage' 或 'alpha'
      } = req.query as Record<string, string | undefined>;

      const limitValue = Math.min(Number.parseInt(limit, 10) || 500, 1000);
      const offsetValue = Number.parseInt(offset, 10) || 0;

      // 检查缓存是否存在
      const { rows: cacheCheck } = await readPool.query(`
        SELECT COUNT(*)::int as count FROM "TagValidationCache" WHERE "validationType" = 'untranslated'
      `);
      const hasCache = cacheCheck[0]?.count > 0;

      // 获取总数
      let total = 0;
      if (hasCache) {
        const { rows: countRows } = await readPool.query(`
          SELECT COUNT(*)::int as total FROM "TagValidationCache" WHERE "validationType" = 'untranslated'
        `);
        total = countRows[0]?.total || 0;
      }

      let untranslatedTags: Array<{ tagChinese: string; sourcePageUrl: string; category: string | null; usageCount: number }>;

      if (hasCache) {
        // 从缓存读取（samplePages[0] = sourcePageUrl, samplePages[1] = category）
        const orderBy = sort === 'alpha'
          ? 'tag ASC'
          : '"pageCount" DESC, tag ASC';

        const { rows } = await readPool.query(`
          SELECT tag, "pageCount", "samplePages"
          FROM "TagValidationCache"
          WHERE "validationType" = 'untranslated'
          ORDER BY ${orderBy}
          LIMIT $1 OFFSET $2
        `, [limitValue, offsetValue]);

        untranslatedTags = rows.map((r: any) => ({
          tagChinese: r.tag,
          sourcePageUrl: r.samplePages?.[0] || '',
          category: r.samplePages?.[1] || null,
          usageCount: r.pageCount
        }));
      } else {
        // 回退到实时计算（用于缓存未生成时）
        const orderBy = sort === 'alpha'
          ? '"tagChinese" ASC'
          : 'usage_count DESC, "tagChinese" ASC';

        const { rows } = await readPool.query(`
          WITH tag_usage AS (
            SELECT tag, COUNT(DISTINCT pv."pageId")::int as usage_count
            FROM "PageVersion" pv
            CROSS JOIN LATERAL unnest(pv.tags) AS t(tag)
            WHERE pv."validTo" IS NULL AND NOT pv."isDeleted"
            GROUP BY tag
          )
          SELECT td."tagChinese", td."sourcePageUrl", td.category,
                 COALESCE(tu.usage_count, 0) as usage_count
          FROM "TagDefinition" td
          LEFT JOIN tag_usage tu ON td."tagChinese" = tu.tag
          WHERE td."tagEnglish" IS NULL
          ORDER BY ${orderBy}
          LIMIT $1 OFFSET $2
        `, [limitValue, offsetValue]);

        untranslatedTags = rows.map((r: any) => ({
          tagChinese: r.tagChinese,
          sourcePageUrl: r.sourcePageUrl,
          category: r.category,
          usageCount: r.usage_count
        }));

        // 实时计算时获取总数
        const { rows: countRows } = await readPool.query(`
          SELECT COUNT(*)::int as total FROM "TagDefinition" WHERE "tagEnglish" IS NULL
        `);
        total = countRows[0]?.total || 0;
      }

      res.json({
        untranslatedTags,
        total,
        limit: limitValue,
        offset: offsetValue,
        cached: hasCache
      });
    } catch (err) {
      next(err);
    }
  });

  // GET /api/tags/definitions/sync-status - 获取同步状态
  router.get('/definitions/sync-status', async (req, res, next) => {
    try {
      const { rows } = await readPool.query(`
        SELECT "pageUrl", "syncStatus", "tagsExtracted", "lastSyncedAt", "errorMessage"
        FROM "TagGuideSync"
        ORDER BY "lastSyncedAt" DESC NULLS LAST
      `);

      res.json({ syncStatus: rows });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
