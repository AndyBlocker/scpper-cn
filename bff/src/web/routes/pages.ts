import { Router } from 'express';
import type { Pool } from 'pg';
import type { RedisClientType } from 'redis';

export function pagesRouter(pool: Pool, _redis: RedisClientType | null) {
  const router = Router();

  // GET /api/pages
  router.get('/', async (req, res, next) => {
    try {
      const {
        urlStartsWith,
        titleEqLower,
        categoryEq,
        tagEq,
        ratingGte,
        ratingLte,
        createdAtGte,
        createdAtLte,
        isHidden,
        isUserPage,
        sortKey,
        sortOrder,
        limit = '20',
        offset = '0'
      } = req.query as Record<string, string>;

      const orderKey = (sortKey || '').toUpperCase();
      const dir = (sortOrder || 'ASC').toUpperCase() === 'DESC' ? 'DESC' : 'ASC';
      const orderColumn =
        orderKey === 'URL' ? 'p."currentUrl"' :
        orderKey === 'WIKIDOT_TITLE' ? 'pv.title' :
        orderKey === 'WIKIDOT_RATING' ? 'pv.rating' :
        'pv."createdAt"';

      const sql = `
        SELECT 
          pv."wikidotId",
          p."currentUrl" AS url,
          pv.title,
          pv.rating,
          pv."voteCount",
          pv.category,
          pv.tags,
          pv."createdAt",
          pv."revisionCount",
          pv."attributionCount"
        FROM "PageVersion" pv
        JOIN "Page" p ON pv."pageId" = p.id
        WHERE pv."validTo" IS NULL
          AND ($1::text IS NULL OR p."currentUrl" LIKE ($1::text || '%'))
          AND ($2::text IS NULL OR lower(pv.title) = $2::text)
          AND ($3::text IS NULL OR pv.category = $3::text)
          AND ($4::text IS NULL OR pv.tags @> ARRAY[$4::text]::text[])
          AND ($5::int IS NULL OR pv.rating >= $5::int)
          AND ($6::int IS NULL OR pv.rating <= $6::int)
          AND ($7::timestamptz IS NULL OR pv."createdAt" >= $7::timestamptz)
          AND ($8::timestamptz IS NULL OR pv."createdAt" <= $8::timestamptz)
          
        ORDER BY ${orderColumn} ${dir} NULLS LAST
        LIMIT $9::int OFFSET $10::int
      `;

      const params = [
        urlStartsWith || null,
        titleEqLower || null,
        categoryEq || null,
        tagEq || null,
        ratingGte || null,
        ratingLte || null,
        createdAtGte || null,
        createdAtLte || null,
        limit,
        offset
      ];

      const { rows } = await pool.query(sql, params);
      res.json(rows);
    } catch (err) {
      next(err);
    }
  });

  // GET /api/wikidot-pages/by-url
  router.get('/by-url', async (req, res, next) => {
    try {
      const { url } = req.query as Record<string, string>;
      if (!url) return res.status(400).json({ error: 'url is required' });
      const sql = `
        SELECT pv."wikidotId", p."currentUrl" AS url, pv.*
        FROM "PageVersion" pv
        JOIN "Page" p ON pv."pageId" = p.id
        WHERE pv."validTo" IS NULL AND p."currentUrl" = $1
        LIMIT 1
      `;
      const { rows } = await pool.query(sql, [url]);
      if (rows.length === 0) return res.status(404).json({ error: 'not_found' });
      res.json(rows[0]);
    } catch (err) {
      next(err);
    }
  });

  // GET /api/wikidot-pages/by-id
  router.get('/by-id', async (req, res, next) => {
    try {
      const { wikidotId } = req.query as Record<string, string>;
      if (!wikidotId) return res.status(400).json({ error: 'wikidotId is required' });
      const sql = `
        SELECT pv."wikidotId", p."currentUrl" AS url, pv.*
        FROM "PageVersion" pv
        JOIN "Page" p ON pv."pageId" = p.id
        WHERE pv."validTo" IS NULL AND pv."wikidotId" = $1
        LIMIT 1
      `;
      const { rows } = await pool.query(sql, [wikidotId]);
      if (rows.length === 0) return res.status(404).json({ error: 'not_found' });
      res.json(rows[0]);
    } catch (err) {
      next(err);
    }
  });

  // GET /api/pages/matching
  router.get('/matching', async (req, res, next) => {
    try {
      const { url, limit = '50' } = req.query as Record<string, string>;
      if (!url) return res.status(400).json({ error: 'url is required' });
      const sql = `
        WITH input AS (
          SELECT $1::text AS url
        ), path AS (
          SELECT regexp_replace(url, '^https?://[^/]+', '') AS p FROM input
        )
        SELECT pv."wikidotId", p."currentUrl" AS url, pv.title, pv.rating, pv.tags
        FROM "PageVersion" pv
        JOIN "Page" p ON pv."pageId" = p.id, path
        WHERE pv."validTo" IS NULL AND p."currentUrl" LIKE ('http://%' || path.p)
        ORDER BY pv."createdAt" DESC
        LIMIT $2::int
      `;
      const { rows } = await pool.query(sql, [url, limit]);
      res.json(rows);
    } catch (err) {
      next(err);
    }
  });

  // GET /api/pages/random
  router.get('/random', async (_req, res, next) => {
    try {
      const sql = `
        SELECT pv."wikidotId", p."currentUrl" AS url, pv.title, pv.rating
        FROM "PageVersion" pv
        JOIN "Page" p ON pv."pageId" = p.id
        WHERE pv."validTo" IS NULL
        ORDER BY random()
        LIMIT 1
      `;
      const { rows } = await pool.query(sql);
      if (rows.length === 0) return res.status(404).json({ error: 'not_found' });
      res.json(rows[0]);
    } catch (err) {
      next(err);
    }
  });

  // GET /api/wikidot-pages/:wikidotId/revisions
  router.get('/:wikidotId/revisions', async (req, res, next) => {
    try {
      const { limit = '20', offset = '0' } = req.query as Record<string, string>;
      const { wikidotId } = req.params as Record<string, string>;
      const sql = `
        SELECT r."wikidotId", r.timestamp, r.type, r.comment, r."userId"
        FROM "Revision" r
        JOIN "PageVersion" pv ON r."pageVersionId" = pv.id
        WHERE pv."wikidotId" = $1
        ORDER BY r.timestamp DESC
        LIMIT $2::int OFFSET $3::int
      `;
      const { rows } = await pool.query(sql, [wikidotId, limit, offset]);
      res.json(rows);
    } catch (err) {
      next(err);
    }
  });

  // GET /api/wikidot-pages/:wikidotId/votes/fuzzy
  router.get('/:wikidotId/votes/fuzzy', async (req, res, next) => {
    try {
      const { limit = '100', offset = '0' } = req.query as Record<string, string>;
      const { wikidotId } = req.params as Record<string, string>;
      const sql = `
        WITH pv AS (
          SELECT id FROM "PageVersion" WHERE "wikidotId" = $1 ORDER BY id DESC LIMIT 1
        ), dedup AS (
          SELECT v."userId", v.direction, v.timestamp::date AS day, MAX(v.timestamp) AS latest_ts
          FROM "Vote" v JOIN pv ON v."pageVersionId" = pv.id
          GROUP BY v."userId", v.direction, v.timestamp::date
        )
        SELECT d."userId", d.direction, d.latest_ts AS timestamp
        FROM dedup d
        ORDER BY d.latest_ts ASC
        LIMIT $2::int OFFSET $3::int
      `;
      const { rows } = await pool.query(sql, [wikidotId, limit, offset]);
      res.json(rows);
    } catch (err) {
      next(err);
    }
  });

  // GET /api/wikidot-pages/:wikidotId/ratings/cumulative
  router.get('/:wikidotId/ratings/cumulative', async (req, res, next) => {
    try {
      const { wikidotId } = req.params as Record<string, string>;
      const sql = `
        WITH pv AS (
          SELECT id FROM "PageVersion" WHERE "wikidotId" = $1 ORDER BY id DESC LIMIT 1
        ), daily AS (
          SELECT date_trunc('day', v.timestamp) AS day, SUM(v.direction) AS delta
          FROM "Vote" v JOIN pv ON v."pageVersionId" = pv.id
          GROUP BY 1
        )
        SELECT day::timestamptz AS date,
               SUM(delta) OVER (ORDER BY day ASC ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS "cumulativeRating"
        FROM daily
        ORDER BY day ASC
      `;
      const { rows } = await pool.query(sql, [wikidotId]);
      res.json(rows);
    } catch (err) {
      next(err);
    }
  });

  return router;
}


