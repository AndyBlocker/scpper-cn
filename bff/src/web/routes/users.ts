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

  // GET /api/users/by-wikidot-id
  router.get('/by-wikidot-id', async (req, res, next) => {
    try {
      const { wikidotId } = req.query as Record<string, string>;
      const wikidotIdInt = parseInt(wikidotId, 10);
      if (isNaN(wikidotIdInt)) {
        return res.status(400).json({ error: 'Invalid wikidotId' });
      }
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
        WHERE "wikidotId" = $1
      `;
      const { rows } = await pool.query(sql, [wikidotIdInt]);
      if (rows.length === 0) return res.status(404).json({ error: 'not_found' });
      res.json(rows[0]);
    } catch (err) {
      next(err);
    }
  });

  // GET /api/users/:id (keep for backward compatibility)
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

  // GET /api/users/:wikidotId/stats
  router.get('/:wikidotId/stats', async (req, res, next) => {
    try {
      const { wikidotId } = req.params as Record<string, string>;
      const wikidotIdInt = parseInt(wikidotId, 10);
      if (isNaN(wikidotIdInt)) {
        return res.status(400).json({ error: 'Invalid wikidotId' });
      }
      const sql = `
        WITH user_votes AS (
          -- 获取用户投出的票数
          SELECT 
            COUNT(CASE WHEN v.direction > 0 THEN 1 END) AS votes_up,
            COUNT(CASE WHEN v.direction < 0 THEN 1 END) AS votes_down
          FROM "Vote" v
          JOIN "User" u ON v."userId" = u.id
          WHERE u."wikidotId" = $1
        )
        SELECT 
          us."overallRank" AS rank,
          COALESCE(us."totalRating", 0) AS "totalRating",
          CASE 
            WHEN COALESCE(us."pageCount", 0) > 0 
            THEN (COALESCE(us."totalRating", 0))::float / NULLIF(us."pageCount", 0)::float
            ELSE 0::float 
          END AS "meanRating",
          COALESCE(us."pageCount", 0) AS "pageCount",
          COALESCE(us."scpPageCount", 0) AS "pageCountScp",
          COALESCE(us."storyPageCount", 0) AS "pageCountTale",
          COALESCE(us."goiPageCount", 0) AS "pageCountGoiFormat",
          COALESCE(us."artPageCount", 0) AS "pageCountArtwork",
          COALESCE(uv.votes_up, 0)::int AS "votesUp",
          COALESCE(uv.votes_down, 0)::int AS "votesDown",
          COALESCE(us."totalUp", 0) AS "totalUp",
          COALESCE(us."totalDown", 0) AS "totalDown",
          us."favTag",
          us."goiRank",
          COALESCE(us."goiRating", 0)::float AS "goiRating",
          us."scpRank",
          COALESCE(us."scpRating", 0)::float AS "scpRating",
          us."storyRank",
          COALESCE(us."storyRating", 0)::float AS "storyRating",
          us."translationRank",
          COALESCE(us."translationRating", 0)::float AS "translationRating",
          COALESCE(us."translationPageCount", 0) AS "translationPageCount",
          us."wanderersRank",
          COALESCE(us."wanderersRating", 0)::float AS "wanderersRating",
          COALESCE(us."wanderersPageCount", 0) AS "wanderersPageCount",
          us."artRank",
          COALESCE(us."artRating", 0)::float AS "artRating",
          us."ratingUpdatedAt"
        FROM "UserStats" us
        JOIN "User" u ON us."userId" = u.id
        CROSS JOIN user_votes uv
        WHERE u."wikidotId" = $1
      `;
      const { rows } = await pool.query(sql, [wikidotIdInt]);
      if (rows.length === 0) return res.status(404).json({ error: 'not_found' });
      res.json(rows[0]);
    } catch (err) {
      next(err);
    }
  });

  // GET /api/users/:wikidotId/pages
  router.get('/:wikidotId/pages', async (req, res, next) => {
    try {
      const { wikidotId } = req.params as Record<string, string>;
      const wikidotIdInt = parseInt(wikidotId, 10);
      if (isNaN(wikidotIdInt)) {
        return res.status(400).json({ error: 'Invalid wikidotId' });
      }
      const { type, limit = '20', offset = '0', includeDeleted = 'false' } = req.query as Record<string, string>;
      const sql = `
        SELECT * FROM (
          SELECT DISTINCT ON (pv."wikidotId")
            pv."wikidotId",
            p."currentUrl" AS url,
            pv.title,
            pv.rating,
            pv.tags,
            pv."voteCount",
            pv."createdAt",
            0::int AS "commentCount",
            pv."revisionCount",
            CASE WHEN pv."validTo" IS NOT NULL THEN true ELSE false END AS "isDeleted",
            pv."validTo" AS "deletedAt"
          FROM "Attribution" a
          JOIN "PageVersion" pv ON pv.id = a."pageVerId"
          JOIN "Page" p ON p.id = pv."pageId"
          JOIN "User" u ON a."userId" = u.id
          WHERE u."wikidotId" = $1
            AND ($2::boolean = true OR pv."validTo" IS NULL)
            AND ($3::text IS NULL OR a.type = $3)
          ORDER BY pv."wikidotId", pv."createdAt" DESC
        ) t
        ORDER BY t."createdAt" DESC
        LIMIT $4::int OFFSET $5::int
      `;
      const { rows } = await pool.query(sql, [wikidotIdInt, includeDeleted === 'true', type || null, limit, offset]);
      // strip createdAt helper column
      res.json(rows.map(({ createdAt, ...rest }) => rest));
    } catch (err) {
      next(err);
    }
  });

  // GET /api/users/:wikidotId/votes
  router.get('/:wikidotId/votes', async (req, res, next) => {
    try {
      const { wikidotId } = req.params as Record<string, string>;
      const wikidotIdInt = parseInt(wikidotId, 10);
      if (isNaN(wikidotIdInt)) {
        return res.status(400).json({ error: 'Invalid wikidotId' });
      }
      const { limit = '50', offset = '0' } = req.query as Record<string, string>;
      const sql = `
        SELECT 
          v.timestamp,
          v.direction,
          pv."wikidotId" as "pageWikidotId",
          pv.title as "pageTitle",
          p."currentUrl" as "pageUrl"
        FROM "Vote" v
        JOIN "PageVersion" pv ON v."pageVersionId" = pv.id
        JOIN "Page" p ON pv."pageId" = p.id
        JOIN "User" u ON v."userId" = u.id
        WHERE u."wikidotId" = $1
        ORDER BY v.timestamp DESC
        LIMIT $2::int OFFSET $3::int
      `;
      const { rows } = await pool.query(sql, [wikidotIdInt, limit, offset]);
      res.json(rows);
    } catch (err) {
      next(err);
    }
  });

  // GET /api/users/:wikidotId/revisions
  router.get('/:wikidotId/revisions', async (req, res, next) => {
    try {
      const { wikidotId } = req.params as Record<string, string>;
      const wikidotIdInt = parseInt(wikidotId, 10);
      if (isNaN(wikidotIdInt)) {
        return res.status(400).json({ error: 'Invalid wikidotId' });
      }
      const { limit = '50', offset = '0' } = req.query as Record<string, string>;
      const sql = `
        SELECT 
          r.timestamp,
          r.type,
          r.comment,
          pv."wikidotId" as "pageWikidotId",
          pv.title as "pageTitle",
          p."currentUrl" as "pageUrl"
        FROM "Revision" r
        JOIN "PageVersion" pv ON r."pageVersionId" = pv.id
        JOIN "Page" p ON pv."pageId" = p.id
        JOIN "User" u ON r."userId" = u.id
        WHERE u."wikidotId" = $1
        ORDER BY r.timestamp DESC
        LIMIT $2::int OFFSET $3::int
      `;
      const { rows } = await pool.query(sql, [wikidotIdInt, limit, offset]);
      res.json(rows);
    } catch (err) {
      next(err);
    }
  });

  // GET /api/users/:wikidotId/rating-history
  router.get('/:wikidotId/rating-history', async (req, res, next) => {
    try {
      const { wikidotId } = req.params as Record<string, string>;
      const wikidotIdInt = parseInt(wikidotId, 10);
      if (isNaN(wikidotIdInt)) {
        return res.status(400).json({ error: 'Invalid wikidotId' });
      }
      const { granularity = 'week' } = req.query as Record<string, string>;
      
      // 获取用户所有页面的投票历史，按周或月聚合（无时间限制，获取全部历史数据）
      const dateFormat = granularity === 'month' ? 'YYYY-MM' : 'YYYY-WW';
      const dateLabel = granularity === 'month' ? 'YYYY-MM-DD' : 'YYYY-MM-DD';
      
      const sql = `
        WITH user_all_pages AS (
          -- 所有与该用户有关联的页面（任意归属类型），用于累计评分
          SELECT DISTINCT pv."wikidotId"
          FROM "Attribution" a
          JOIN "PageVersion" pv ON pv.id = a."pageVerId"
          JOIN "User" u ON a."userId" = u.id
          WHERE u."wikidotId" = $1
        ),
        user_related_pages AS (
          -- 包含该用户的所有归属类型，用于页面标记（按优先级推断标记日期）
          SELECT DISTINCT ON (pv."wikidotId")
                 pv."wikidotId",
                 pv.title,
                 -- 是否为作者或提交者，用于优先采用页面创建时间
                 EXISTS (
                   SELECT 1 FROM "Attribution" aa
                   WHERE aa."pageVerId" = pv.id AND aa."userId" = u.id AND aa.type IN ('AUTHOR','SUBMITTER')
                 ) AS has_author_submitter,
                 -- 该用户在归属表中的最早日期（若有）
                 (
                   SELECT MIN(a2.date)
                   FROM "Attribution" a2
                   WHERE a2."pageVerId" = pv.id AND a2."userId" = u.id AND a2.date IS NOT NULL
                 ) AS attr_date,
                 -- 该用户在该页面的首次修订时间（若有）
                 (
                   SELECT MIN(r.timestamp)
                   FROM "Revision" r
                   WHERE r."pageVersionId" = pv.id AND r."userId" = u.id
                 ) AS first_user_rev_date,
                 -- 页面创建时间（独立于用户）
                 (
                   SELECT MIN(r2.timestamp)
                   FROM "Revision" r2
                   WHERE r2."pageVersionId" = pv.id AND r2.type = 'PAGE_CREATED'
                 ) AS page_created_date
          FROM "Attribution" a
          JOIN "PageVersion" pv ON pv.id = a."pageVerId"
          JOIN "User" u ON a."userId" = u.id
          WHERE u."wikidotId" = $1
          ORDER BY pv."wikidotId", pv."createdAt" DESC
        ),
        vote_history AS (
          -- 获取这些页面的所有投票，按周/月聚合（无时间限制）
          SELECT 
            DATE_TRUNC('${granularity}', v.timestamp) as period,
            SUM(CASE WHEN v.direction > 0 THEN v.direction ELSE 0 END) as upvotes,
            SUM(CASE WHEN v.direction < 0 THEN ABS(v.direction) ELSE 0 END) as downvotes,
            SUM(v.direction) as net_change
          FROM "Vote" v
          JOIN "PageVersion" pv ON v."pageVersionId" = pv.id
          WHERE pv."wikidotId" IN (SELECT "wikidotId" FROM user_all_pages)
          GROUP BY DATE_TRUNC('${granularity}', v.timestamp)
        ),
        pages_created AS (
          -- 获取用户相关页面的标记聚合（所有归属类型）。
          -- 标记日期优先级：
          -- 1) 若用户为 AUTHOR 或 SUBMITTER，则使用页面创建时间
          -- 2) 否则使用归属表记录的最早日期（若有）
          -- 3) 否则使用用户在该页面的首次修订时间（若有）
          -- 4) 最后兜底为页面创建时间
          SELECT 
            DATE_TRUNC(
              '${granularity}',
              COALESCE(
                CASE WHEN has_author_submitter THEN page_created_date ELSE NULL END,
                attr_date,
                first_user_rev_date,
                page_created_date
              )
            ) as period,
            JSON_AGG(
              JSON_BUILD_OBJECT(
                'wikidotId', "wikidotId",
                'title', title,
                'date', COALESCE(
                  CASE WHEN has_author_submitter THEN page_created_date ELSE NULL END,
                  attr_date,
                  first_user_rev_date,
                  page_created_date
                )
              ) ORDER BY COALESCE(
                CASE WHEN has_author_submitter THEN page_created_date ELSE NULL END,
                attr_date,
                first_user_rev_date,
                page_created_date
              )
            ) as pages
          FROM user_related_pages
          WHERE COALESCE(
                  CASE WHEN has_author_submitter THEN page_created_date ELSE NULL END,
                  attr_date,
                  first_user_rev_date,
                  page_created_date
                ) IS NOT NULL
          GROUP BY DATE_TRUNC(
            '${granularity}',
            COALESCE(
              CASE WHEN has_author_submitter THEN page_created_date ELSE NULL END,
              attr_date,
              first_user_rev_date,
              page_created_date
            )
          )
        ),
        periods AS (
          -- 合并所有可能出现的时间段，确保没有投票但创建了页面的时间段也会出现
          SELECT period FROM vote_history
          UNION
          SELECT period FROM pages_created
        ),
        combined AS (
          SELECT p.period,
                 COALESCE(vh.upvotes, 0) AS upvotes,
                 COALESCE(vh.downvotes, 0) AS downvotes,
                 COALESCE(vh.net_change, 0) AS net_change,
                 pc.pages
          FROM periods p
          LEFT JOIN vote_history vh ON vh.period = p.period
          LEFT JOIN pages_created pc ON pc.period = p.period
        ),
        cumulative AS (
          SELECT period,
                 upvotes,
                 downvotes,
                 net_change,
                 SUM(net_change) OVER (ORDER BY period) AS cumulative_rating,
                 pages
          FROM combined
        )
        SELECT 
          TO_CHAR(period, '${dateLabel}') as date,
          COALESCE(upvotes, 0) as upvotes,
          COALESCE(downvotes, 0) as downvotes,
          COALESCE(net_change, 0) as net_change,
          COALESCE(cumulative_rating, 0) as cumulative_rating,
          pages
        FROM cumulative
        ORDER BY period
      `;
      const { rows } = await pool.query(sql, [wikidotIdInt]);
      
      // 直接返回数据，前端会处理隐藏逻辑
      res.json(rows);
    } catch (err) {
      next(err);
    }
  });

  return router;
}


