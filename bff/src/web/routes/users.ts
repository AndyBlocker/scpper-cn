import { Router } from 'express';
import type { Pool } from 'pg';
import type { RedisClientType } from 'redis';

export function usersRouter(pool: Pool, _redis: RedisClientType | null) {
  const router = Router();

  // GET /users/by-rank
  router.get('/by-rank', async (req, res, next) => {
    try {
      const { limit = '20', offset = '0' } = req.query as Record<string, string>;
      const sql = `
        SELECT u.id, u."displayName", us."overallRank" AS rank, us."overallRating"
        FROM "User" u
        JOIN "UserStats" us ON us."userId" = u.id
        WHERE us."overallRank" IS NOT NULL
        ORDER BY us."overallRank" ASC
        LIMIT $1::int OFFSET $2::int
      `;
      const { rows } = await pool.query(sql, [limit, offset]);
      res.json(rows);
    } catch (err) {
      next(err);
    }
  });

  // GET /api/users/:id
  router.get('/:id', async (req, res, next) => {
    try {
      const { id } = req.params as Record<string, string>;
      const sql = `
        SELECT 
          id,
          "wikidotId",
          "displayName",
          "firstActivityAt",
          "firstActivityType",
          "firstActivityDetails",
          "lastActivityAt",
          username,
          "isGuest"
        FROM "User"
        WHERE id = $1
      `;
      const { rows } = await pool.query(sql, [id]);
      if (rows.length === 0) return res.status(404).json({ error: 'not_found' });
      res.json(rows[0]);
    } catch (err) {
      next(err);
    }
  });

  // GET /api/users/:id/stats
  router.get('/:id/stats', async (req, res, next) => {
    try {
      const { id } = req.params as Record<string, string>;
      const sql = `
        SELECT 
          "overallRank" AS rank,
          COALESCE("totalRating", 0) AS "totalRating",
          COALESCE("overallRating", 0) AS "meanRating",
          COALESCE("pageCount", 0) AS "pageCount",
          COALESCE("scpPageCount", 0) AS "pageCountScp",
          COALESCE("storyPageCount", 0) AS "pageCountTale",
          COALESCE("goiPageCount", 0) AS "pageCountGoiFormat",
          COALESCE("artPageCount", 0) AS "pageCountArtwork",
          COALESCE("totalUp", 0) AS "totalUp",
          COALESCE("totalDown", 0) AS "totalDown",
          "favTag",
          "goiRank",
          COALESCE("goiRating", 0) AS "goiRating",
          "scpRank",
          COALESCE("scpRating", 0) AS "scpRating",
          "storyRank",
          COALESCE("storyRating", 0) AS "storyRating",
          "translationRank",
          COALESCE("translationRating", 0) AS "translationRating",
          COALESCE("translationPageCount", 0) AS "translationPageCount",
          "wanderersRank",
          COALESCE("wanderersRating", 0) AS "wanderersRating",
          COALESCE("wanderersPageCount", 0) AS "wanderersPageCount",
          "artRank",
          COALESCE("artRating", 0) AS "artRating",
          "ratingUpdatedAt"
        FROM "UserStats"
        WHERE "userId" = $1
      `;
      const { rows } = await pool.query(sql, [id]);
      if (rows.length === 0) return res.status(404).json({ error: 'not_found' });
      res.json(rows[0]);
    } catch (err) {
      next(err);
    }
  });

  // GET /api/users/:id/pages
  router.get('/:id/pages', async (req, res, next) => {
    try {
      const { id } = req.params as Record<string, string>;
      const { type, limit = '20', offset = '0' } = req.query as Record<string, string>;
      const sql = `
        SELECT * FROM (
          SELECT DISTINCT ON (pv."wikidotId")
            pv."wikidotId",
            p."currentUrl" AS url,
            pv.title,
            pv.rating,
            pv.tags,
            pv."createdAt"
          FROM "Attribution" a
          JOIN "PageVersion" pv ON pv.id = a."pageVerId"
          JOIN "Page" p ON p.id = pv."pageId"
          WHERE pv."validTo" IS NULL
            AND a."userId" = $1
            AND ($2::text IS NULL OR a.type = $2)
          ORDER BY pv."wikidotId", pv."createdAt" DESC
        ) t
        ORDER BY t."createdAt" DESC
        LIMIT $3::int OFFSET $4::int
      `;
      const { rows } = await pool.query(sql, [id, type || null, limit, offset]);
      // strip createdAt helper column
      res.json(rows.map(({ createdAt, ...rest }) => rest));
    } catch (err) {
      next(err);
    }
  });

  return router;
}


