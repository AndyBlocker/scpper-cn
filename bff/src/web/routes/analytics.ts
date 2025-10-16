import { Router } from 'express';
import type { Pool } from 'pg';
import type { RedisClientType } from 'redis';

function sanitizePeriod(p?: string): 'day' | 'week' | 'month' {
  const v = String(p || 'day').toLowerCase();
  return (v === 'week' || v === 'month') ? v : 'day';
}

// Category CASE expression shared by endpoints
// IMPORTANT: This expects aliases e_tags (effective tags) and e_category (effective category)
// to be available in the current query scope. These fields should represent the
// current version tags/category, falling back to the last non-deleted version for
// deleted pages, so that deleted pages are still categorized consistently.
const CATEGORY_CASE_SQL = `
  CASE
    WHEN e_tags @> ARRAY['原创','scp']::text[] THEN 'scp'
    WHEN e_tags @> ARRAY['原创','goi格式']::text[] THEN 'goi'
    WHEN e_tags @> ARRAY['原创','故事']::text[] THEN 'story'
    WHEN e_tags @> ARRAY['原创','wanderers']::text[] THEN 'wanderers'
    WHEN e_tags @> ARRAY['原创','艺术作品']::text[] THEN 'art'
    WHEN e_category = 'short-stories' THEN '三句话外围'
    WHEN e_category = 'log-of-anomalous-items-cn' THEN '异常物品'
    WHEN NOT (e_tags @> ARRAY['原创']::text[])
         AND NOT (e_tags @> ARRAY['作者']::text[])
         AND NOT (e_tags @> ARRAY['掩盖页']::text[])
         AND NOT (e_tags @> ARRAY['段落']::text[])
         AND NOT (e_tags @> ARRAY['补充材料']::text[])
         AND e_category NOT IN ('log-of-anomalous-items-cn','short-stories')
    THEN 'translation'
    ELSE 'other'
  END`;

export function analyticsRouter(pool: Pool, _redis: RedisClientType | null) {
  const router = Router();

  // GET /analytics/pages/category-summary
  router.get('/pages/category-summary', async (req, res, next) => {
    try {
      const { startDate, endDate } = req.query as Record<string, string>;
      const sql = `
        WITH pv AS (
          SELECT 
            pv."pageId",
            -- effective tags/category: use current version unless deleted; for deleted, fallback to last non-deleted
            COALESCE(CASE WHEN pv."isDeleted" THEN prev.tags ELSE pv.tags END, ARRAY[]::text[]) AS e_tags,
            COALESCE(CASE WHEN pv."isDeleted" THEN prev.category ELSE pv.category END, pv.category) AS e_category
          FROM "PageVersion" pv
          LEFT JOIN LATERAL (
            SELECT tags, category
            FROM "PageVersion" pv_prev
            WHERE pv_prev."pageId" = pv."pageId"
              AND pv_prev."isDeleted" = false
            ORDER BY pv_prev."validTo" DESC NULLS LAST, pv_prev.id DESC
            LIMIT 1
          ) prev ON TRUE
          WHERE pv."validTo" IS NULL
        ), base AS (
          SELECT 
            timezone('Asia/Shanghai', p."firstPublishedAt") AS local_ts,
            ${CATEGORY_CASE_SQL} AS category
          FROM "Page" p
          JOIN pv ON pv."pageId" = p.id
          WHERE p."firstPublishedAt" IS NOT NULL
            AND ($1::date IS NULL OR (timezone('Asia/Shanghai', p."firstPublishedAt")::date >= $1::date))
            AND ($2::date IS NULL OR (timezone('Asia/Shanghai', p."firstPublishedAt")::date <= $2::date))
        )
        SELECT category, COUNT(*)::int AS count
        FROM base
        WHERE category != 'other'
        GROUP BY category
        ORDER BY category ASC
      `;
      const params = [startDate || null, endDate || null];
      const { rows } = await pool.query(sql, params);
      res.json(rows);
    } catch (err) {
      next(err);
    }
  });

  // GET /analytics/pages/category-series
  router.get('/pages/category-series', async (req, res, next) => {
    try {
      const { startDate, endDate, period } = req.query as Record<string, string>;
      const p = sanitizePeriod(period);
      const sql = `
        WITH pv AS (
          SELECT 
            pv."pageId",
            COALESCE(CASE WHEN pv."isDeleted" THEN prev.tags ELSE pv.tags END, ARRAY[]::text[]) AS e_tags,
            COALESCE(CASE WHEN pv."isDeleted" THEN prev.category ELSE pv.category END, pv.category) AS e_category
          FROM "PageVersion" pv
          LEFT JOIN LATERAL (
            SELECT tags, category
            FROM "PageVersion" pv_prev
            WHERE pv_prev."pageId" = pv."pageId"
              AND pv_prev."isDeleted" = false
            ORDER BY pv_prev."validTo" DESC NULLS LAST, pv_prev.id DESC
            LIMIT 1
          ) prev ON TRUE
          WHERE pv."validTo" IS NULL
        ), base AS (
          SELECT 
            -- Use Asia/Shanghai local time for bucketing
            date_trunc($3::text, timezone('Asia/Shanghai', p."firstPublishedAt"))::date AS bucket,
            ${CATEGORY_CASE_SQL} AS category
          FROM "Page" p
          JOIN pv ON pv."pageId" = p.id
          WHERE p."firstPublishedAt" IS NOT NULL
            AND ($1::date IS NULL OR (timezone('Asia/Shanghai', p."firstPublishedAt")::date >= $1::date))
            AND ($2::date IS NULL OR (timezone('Asia/Shanghai', p."firstPublishedAt")::date <= $2::date))
        )
        SELECT bucket AS date, category, COUNT(*)::int AS count
        FROM base
        WHERE category != 'other'
        GROUP BY bucket, category
        ORDER BY bucket ASC, category ASC
      `;
      const params = [startDate || null, endDate || null, p];
      const { rows } = await pool.query(sql, params);
      res.json(rows);
    } catch (err) {
      next(err);
    }
  });

  // GET /analytics/users/active-series
  router.get('/users/active-series', async (req, res, next) => {
    try {
      const { startDate, endDate, period } = req.query as Record<string, string>;
      const p = sanitizePeriod(period);
      const sql = `
        SELECT 
          date_trunc($3::text, date)::date AS date,
          ROUND(AVG("usersActive"))::int AS "activeUsers"
        FROM "SiteOverviewDaily"
        WHERE ($1::date IS NULL OR date >= $1::date)
          AND ($2::date IS NULL OR date <= $2::date)
        GROUP BY 1
        ORDER BY 1 ASC
      `;
      const params = [startDate || null, endDate || null, p];
      const { rows } = await pool.query(sql, params);
      res.json(rows);
    } catch (err) {
      next(err);
    }
  });

  // GET /analytics/pages/tag-series
  router.get('/pages/tag-series', async (req, res, next) => {
    try {
      const { startDate, endDate, period, match = 'all' } = req.query as Record<string, string>;
      const p = sanitizePeriod(period);
      // Normalize tags & excludeTags
      const tagsRaw = (req.query as any).tags;
      const excludeTagsRaw = (req.query as any).excludeTags;
      const tags = Array.isArray(tagsRaw) ? tagsRaw : (tagsRaw ? [String(tagsRaw)] : []);
      const excludeTags = Array.isArray(excludeTagsRaw) ? excludeTagsRaw : (excludeTagsRaw ? [String(excludeTagsRaw)] : []);

      if (!tags || tags.length === 0) {
        return res.status(400).json({ error: 'tags are required' });
      }

      const sql = `
        WITH pv AS (
          SELECT 
            pv."pageId",
            COALESCE(CASE WHEN pv."isDeleted" THEN prev.tags ELSE pv.tags END, ARRAY[]::text[]) AS e_tags
          FROM "PageVersion" pv
          LEFT JOIN LATERAL (
            SELECT tags
            FROM "PageVersion" pv_prev
            WHERE pv_prev."pageId" = pv."pageId"
              AND pv_prev."isDeleted" = false
            ORDER BY pv_prev."validTo" DESC NULLS LAST, pv_prev.id DESC
            LIMIT 1
          ) prev ON TRUE
          WHERE pv."validTo" IS NULL
        ), base AS (
          SELECT 
            -- Use Asia/Shanghai local time for bucketing
            date_trunc($3::text, timezone('Asia/Shanghai', p."firstPublishedAt"))::date AS bucket
          FROM "Page" p
          JOIN pv ON pv."pageId" = p.id
          WHERE p."firstPublishedAt" IS NOT NULL
            AND ($1::date IS NULL OR (timezone('Asia/Shanghai', p."firstPublishedAt")::date >= $1::date))
            AND ($2::date IS NULL OR (timezone('Asia/Shanghai', p."firstPublishedAt")::date <= $2::date))
            AND (
              ($4::text = 'all' AND pv.e_tags @> $5::text[])
              OR
              ($4::text = 'any' AND pv.e_tags && $5::text[])
            )
            AND ($6::text[] IS NULL OR NOT (pv.e_tags && $6::text[]))
        ), per_bucket AS (
          SELECT bucket AS date, COUNT(*)::int AS new_count
          FROM base
          GROUP BY bucket
        )
        SELECT 
          date,
          new_count AS "newCount",
          SUM(new_count) OVER (ORDER BY date ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)::int AS "cumulativeCount"
        FROM per_bucket
        ORDER BY date ASC
      `;

      const params = [
        startDate || null,
        endDate || null,
        p,
        (String(match || 'all').toLowerCase() === 'any') ? 'any' : 'all',
        tags.length > 0 ? tags : null,
        excludeTags.length > 0 ? excludeTags : null
      ];

      const { rows } = await pool.query(sql, params);
      res.json(rows);
    } catch (err) {
      next(err);
    }
  });

  // GET /analytics/pages/by-category
  // Returns paginated list of pages in a given category (using effective tags/category).
  router.get('/pages/by-category', async (req, res, next) => {
    try {
      const { category, startDate, endDate, order = 'recent', limit = '12', offset = '0' } = req.query as Record<string, string>;
      if (!category || !category.trim()) {
        return res.status(400).json({ error: 'category is required' });
      }
      const normalizedOrder = (order === 'rating') ? 'rating' : 'recent';
      const limitInt = Math.min(Math.max(parseInt(String(limit), 10) || 12, 1), 100);
      const offsetInt = Math.max(parseInt(String(offset), 10) || 0, 0);

      const baseSql = `
        WITH pv AS (
          SELECT 
            pv.id,
            pv."pageId",
            COALESCE(pv."wikidotId", p."wikidotId") AS "wikidotId",
            pv.title,
            pv."alternateTitle",
            p."currentUrl" AS url,
            p."firstPublishedAt" AS "firstRevisionAt",
            CASE WHEN pv."isDeleted" THEN prev.rating ELSE pv.rating END AS rating,
            CASE WHEN pv."isDeleted" THEN prev."voteCount" ELSE pv."voteCount" END AS "voteCount",
            pv."revisionCount",
            CASE WHEN pv."isDeleted" THEN prev."commentCount" ELSE pv."commentCount" END AS "commentCount",
            CASE WHEN pv."isDeleted" THEN COALESCE(prev.tags, ARRAY[]::text[]) ELSE COALESCE(pv.tags, ARRAY[]::text[]) END AS e_tags,
            pv."isDeleted" AS "isDeleted",
            CASE WHEN pv."isDeleted" THEN pv."validFrom" ELSE NULL END AS "deletedAt",
            pv."validFrom",
            COALESCE(CASE WHEN pv."isDeleted" THEN prev.category ELSE pv.category END, pv.category) AS e_category,
            ps."wilson95",
            ps."controversy"
          FROM "PageVersion" pv
          JOIN "Page" p ON pv."pageId" = p.id
          LEFT JOIN "PageStats" ps ON ps."pageVersionId" = pv.id
          LEFT JOIN LATERAL (
            SELECT rating, "voteCount", "commentCount", tags, category
            FROM "PageVersion" pv_prev
            WHERE pv_prev."pageId" = pv."pageId"
              AND pv_prev."isDeleted" = false
            ORDER BY pv_prev."validTo" DESC NULLS LAST, pv_prev.id DESC
            LIMIT 1
          ) prev ON TRUE
          WHERE pv."validTo" IS NULL
        ), base AS (
          SELECT *,
            ${CATEGORY_CASE_SQL} AS category
          FROM pv
        )
        SELECT b.*
        FROM base b
        WHERE b.category = $1
          AND b."firstRevisionAt" IS NOT NULL
          AND ($2::date IS NULL OR (timezone('Asia/Shanghai', b."firstRevisionAt")::date >= $2::date))
          AND ($3::date IS NULL OR (timezone('Asia/Shanghai', b."firstRevisionAt")::date <= $3::date))
        ORDER BY 
          CASE WHEN $4 = 'rating' THEN b.rating END DESC NULLS LAST,
          CASE WHEN $4 = 'recent' THEN COALESCE(b."firstRevisionAt", b."validFrom") END DESC,
          b.rating DESC NULLS LAST,
          b."firstRevisionAt" DESC NULLS LAST,
          b.id DESC
        LIMIT $5::int OFFSET $6::int
      `;

      const countSql = `
        WITH pv AS (
          SELECT 
            pv.id,
            pv."pageId",
            COALESCE(CASE WHEN pv."isDeleted" THEN prev.tags ELSE pv.tags END, ARRAY[]::text[]) AS e_tags,
            COALESCE(CASE WHEN pv."isDeleted" THEN prev.category ELSE pv.category END, pv.category) AS e_category,
            p."firstPublishedAt" AS "firstRevisionAt"
          FROM "PageVersion" pv
          JOIN "Page" p ON pv."pageId" = p.id
          LEFT JOIN LATERAL (
            SELECT tags, category
            FROM "PageVersion" pv_prev
            WHERE pv_prev."pageId" = pv."pageId"
              AND pv_prev."isDeleted" = false
            ORDER BY pv_prev."validTo" DESC NULLS LAST, pv_prev.id DESC
            LIMIT 1
          ) prev ON TRUE
          WHERE pv."validTo" IS NULL
        ), base AS (
          SELECT *, ${CATEGORY_CASE_SQL} AS category FROM pv
        )
        SELECT COUNT(*)::int AS total
        FROM base b
        WHERE b.category = $1
          AND b."firstRevisionAt" IS NOT NULL
          AND ($2::date IS NULL OR (timezone('Asia/Shanghai', b."firstRevisionAt")::date >= $2::date))
          AND ($3::date IS NULL OR (timezone('Asia/Shanghai', b."firstRevisionAt")::date <= $3::date))
      `;

      const params = [category, startDate || null, endDate || null, normalizedOrder, limitInt, offsetInt];
      const countParams = [category, startDate || null, endDate || null];
      const [{ rows }, countRes] = await Promise.all([
        pool.query(baseSql, params),
        pool.query(countSql, countParams)
      ]);
      const total = Number(countRes.rows?.[0]?.total || 0);
      res.json({ results: rows, total });
    } catch (err) {
      next(err);
    }
  });

  // GET /analytics/tags/:tag/users
  // Returns top lovers and haters for a single tag
  router.get('/tags/:tag/users', async (req, res, next) => {
    try {
      const { tag } = req.params as Record<string, string>;
      const {
        limit = '10',
        offset = '0',
        offsetLovers = undefined,
        offsetHaters = undefined,
        minVotes = '3'
      } = req.query as Record<string, string>;

      if (!tag || !tag.trim()) {
        return res.status(400).json({ error: 'tag is required' });
      }

      const parsedLimit = Math.min(Math.max(parseInt(String(limit), 10) || 10, 1), 100);
      const parsedMinVotes = Math.max(parseInt(String(minVotes), 10) || 3, 0);
      const parsedOffsetLovers = Math.max(parseInt(String(offsetLovers ?? offset), 10) || 0, 0);
      const parsedOffsetHaters = Math.max(parseInt(String(offsetHaters ?? offset), 10) || 0, 0);

      const orderLovers = 'utp."upvoteCount" DESC, utp."downvoteCount" ASC, utp."totalVotes" DESC, utp."lastVoteAt" DESC NULLS LAST';
      const orderHaters = 'utp."downvoteCount" DESC, utp."upvoteCount" ASC, utp."totalVotes" DESC, utp."lastVoteAt" DESC NULLS LAST';

      const baseSelect = `
        SELECT 
          u."displayName",
          u."wikidotId",
          utp."upvoteCount" AS up,
          utp."downvoteCount" AS down,
          utp."totalVotes",
          utp."lastVoteAt"
        FROM "UserTagPreference" utp
        JOIN "User" u ON u.id = utp."userId"
        WHERE utp.tag = $1 AND utp."totalVotes" >= $2
      `;

      const loversSql = `${baseSelect} ORDER BY ${orderLovers} LIMIT $3 OFFSET $4`;
      const hatersSql = `${baseSelect} ORDER BY ${orderHaters} LIMIT $3 OFFSET $4`;
      const countSql = `
        SELECT COUNT(*)::int AS total
        FROM "UserTagPreference" utp
        JOIN "User" u ON u.id = utp."userId"
        WHERE utp.tag = $1 AND utp."totalVotes" >= $2
      `;

      const [lovers, haters, total] = await Promise.all([
        pool.query(loversSql, [tag, parsedMinVotes, parsedLimit, parsedOffsetLovers]),
        pool.query(hatersSql, [tag, parsedMinVotes, parsedLimit, parsedOffsetHaters]),
        pool.query(countSql, [tag, parsedMinVotes])
      ]);

      res.json({
        tag,
        lovers: {
          rows: lovers.rows,
          total: (total.rows[0]?.total as number) || 0,
          limit: parsedLimit,
          offset: parsedOffsetLovers
        },
        haters: {
          rows: haters.rows,
          total: (total.rows[0]?.total as number) || 0,
          limit: parsedLimit,
          offset: parsedOffsetHaters
        }
      });
    } catch (err) {
      next(err);
    }
  });

  // GET /analytics/tags/users/batch?tags=原创&tags=scp&...
  // Returns lovers/haters for multiple tags at once (shared limit/offsets)
  router.get('/tags/users/batch', async (req, res, next) => {
    try {
      const tagsRaw = (req.query as any).tags;
      const {
        limit = '10',
        offset = '0',
        offsetLovers = undefined,
        offsetHaters = undefined,
        minVotes = '3'
      } = req.query as Record<string, string>;

      const tags: string[] = Array.isArray(tagsRaw)
        ? tagsRaw.map((t: any) => String(t)).filter((t: string) => !!t && t.trim())
        : (tagsRaw ? [String(tagsRaw)].filter(t => !!t && t.trim()) : []);

      if (!tags || tags.length === 0) {
        return res.status(400).json({ error: 'tags are required' });
      }

      const parsedLimit = Math.min(Math.max(parseInt(String(limit), 10) || 10, 1), 100);
      const parsedMinVotes = Math.max(parseInt(String(minVotes), 10) || 3, 0);
      const parsedOffsetLovers = Math.max(parseInt(String(offsetLovers ?? offset), 10) || 0, 0);
      const parsedOffsetHaters = Math.max(parseInt(String(offsetHaters ?? offset), 10) || 0, 0);

      const orderLovers = 'utp."upvoteCount" DESC, utp."downvoteCount" ASC, utp."totalVotes" DESC, utp."lastVoteAt" DESC NULLS LAST';
      const orderHaters = 'utp."downvoteCount" DESC, utp."upvoteCount" ASC, utp."totalVotes" DESC, utp."lastVoteAt" DESC NULLS LAST';

      const baseSelect = `
        SELECT 
          u."displayName",
          u."wikidotId",
          utp."upvoteCount" AS up,
          utp."downvoteCount" AS down,
          utp."totalVotes",
          utp."lastVoteAt"
        FROM "UserTagPreference" utp
        JOIN "User" u ON u.id = utp."userId"
        WHERE utp.tag = $1 AND utp."totalVotes" >= $2
      `;
      const loversSql = `${baseSelect} ORDER BY ${orderLovers} LIMIT $3 OFFSET $4`;
      const hatersSql = `${baseSelect} ORDER BY ${orderHaters} LIMIT $3 OFFSET $4`;
      const countSql = `
        SELECT COUNT(*)::int AS total
        FROM "UserTagPreference" utp
        JOIN "User" u ON u.id = utp."userId"
        WHERE utp.tag = $1 AND utp."totalVotes" >= $2
      `;

      const results = await Promise.all(tags.map(async (t) => {
        const [lovers, haters, total] = await Promise.all([
          pool.query(loversSql, [t, parsedMinVotes, parsedLimit, parsedOffsetLovers]),
          pool.query(hatersSql, [t, parsedMinVotes, parsedLimit, parsedOffsetHaters]),
          pool.query(countSql, [t, parsedMinVotes])
        ]);
        return {
          tag: t,
          lovers: {
            rows: lovers.rows,
            total: (total.rows[0]?.total as number) || 0,
            limit: parsedLimit,
            offset: parsedOffsetLovers
          },
          haters: {
            rows: haters.rows,
            total: (total.rows[0]?.total as number) || 0,
            limit: parsedLimit,
            offset: parsedOffsetHaters
          }
        };
      }));

      res.json({ tags: results });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
