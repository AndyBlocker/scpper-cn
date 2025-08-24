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
  router.get('/random', async (req, res, next) => {
    try {
      const { limit = '1' } = req.query as Record<string, string>;
      
      // For backward compatibility, if limit is 1, return a single random page
      if (limit === '1') {
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
            AND pv.rating IS NOT NULL
          ORDER BY random()
          LIMIT 1
        `;
        const { rows } = await pool.query(sql);
        if (rows.length === 0) return res.status(404).json({ error: 'not_found' });
        return res.json(rows[0]);
      }
      
      // For limit=6 (homepage), use specific composition
      if (limit === '6') {
        // Query 1: Get 1 high-scoring (>=50) original page
        const highScoringOriginalSql = `
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
            pv."attributionCount",
            pv."textContent"
          FROM "PageVersion" pv
          JOIN "Page" p ON pv."pageId" = p.id
          WHERE pv."validTo" IS NULL
            AND pv.rating >= 50
            AND '原创' = ANY(pv.tags)
          ORDER BY random()
          LIMIT 1
        `;
        
        // Query 2: Get 3 other original pages
        const otherOriginalSql = `
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
            pv."attributionCount",
            pv."textContent"
          FROM "PageVersion" pv
          JOIN "Page" p ON pv."pageId" = p.id
          WHERE pv."validTo" IS NULL
            AND pv.rating IS NOT NULL
            AND '原创' = ANY(pv.tags)
          ORDER BY random()
          LIMIT 3
        `;
        
        // Query 3: Get 2 non-original (translation) pages
        const translationSql = `
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
            pv."attributionCount",
            pv."textContent"
          FROM "PageVersion" pv
          JOIN "Page" p ON pv."pageId" = p.id
          WHERE pv."validTo" IS NULL
            AND pv.rating IS NOT NULL
            AND NOT ('原创' = ANY(pv.tags))
          ORDER BY random()
          LIMIT 2
        `;
        
        // Execute all queries in parallel
        const [highScoringResult, otherOriginalResult, translationResult] = await Promise.all([
          pool.query(highScoringOriginalSql),
          pool.query(otherOriginalSql),
          pool.query(translationSql)
        ]);
        
        // Helper function to extract excerpt from text content
        const extractExcerpt = (textContent: string | null, maxLength: number = 150): string => {
          if (!textContent || textContent.trim() === '') {
            return '';
          }
          
          // Remove common formatting and special characters
          const cleanText = textContent
            .replace(/\[[^\]]*\]/g, '') // Remove [bracketed] content
            .replace(/\{\{[^}]*\}\}/g, '') // Remove {{template}} content
            .replace(/^[#*\-+>|\s]+/gm, '') // Remove list markers and quotes
            .replace(/\n+/g, ' ') // Replace newlines with spaces
            .trim();
          
          // Try to extract complete sentences
          const sentences = cleanText.split(/[。！？.!?]\s*/g).filter(s => s.length > 20);
          
          if (sentences.length > 0) {
            // Get a random sentence
            const randomSentence = sentences[Math.floor(Math.random() * sentences.length)];
            if (randomSentence.length <= maxLength) {
              return randomSentence;
            }
            // If sentence is too long, truncate it
            return randomSentence.substring(0, maxLength - 3) + '...';
          }
          
          // Fallback: just take the first part of the text
          if (cleanText.length <= maxLength) {
            return cleanText;
          }
          return cleanText.substring(0, maxLength - 3) + '...';
        };
        
        // Combine results and add excerpts
        const allPages = [
          ...highScoringResult.rows,
          ...otherOriginalResult.rows,
          ...translationResult.rows
        ].map(page => {
          const excerpt = extractExcerpt(page.textContent);
          // Remove textContent from response to reduce payload
          const { textContent, ...pageWithoutContent } = page;
          return {
            ...pageWithoutContent,
            excerpt
          };
        });
        
        // Shuffle the combined array to mix the order
        for (let i = allPages.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [allPages[i], allPages[j]] = [allPages[j], allPages[i]];
        }
        
        return res.json(allPages);
      }
      
      // For other limit values, use simple random selection
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
          AND pv.rating IS NOT NULL
        ORDER BY random()
        LIMIT $1::int
      `;
      const { rows } = await pool.query(sql, [limit]);
      if (rows.length === 0) return res.status(404).json({ error: 'not_found' });
      res.json(rows);
    } catch (err) {
      next(err);
    }
  });

  // GET /api/wikidot-pages/:wikidotId/revisions
  // query: limit, offset, order=ASC|DESC, type (optional exact match)
  router.get('/:wikidotId/revisions', async (req, res, next) => {
    try {
      const { limit = '20', offset = '0', order = 'DESC', type } = req.query as Record<string, string>;
      const { wikidotId } = req.params as Record<string, string>;
      const dir = (order || 'DESC').toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
      const sql = `
        SELECT r."wikidotId", r.timestamp, r.type, r.comment, r."userId"
        FROM "Revision" r
        JOIN "PageVersion" pv ON r."pageVersionId" = pv.id
        WHERE pv."wikidotId" = $1
          AND ($4::text IS NULL OR r.type = $4::text)
        ORDER BY r.timestamp ${dir}
        LIMIT $2::int OFFSET $3::int
      `;
      const { rows } = await pool.query(sql, [wikidotId, limit, offset, type || null]);
      res.json(rows);
    } catch (err) {
      next(err);
    }
  });

  // GET /pages/:wikidotId/attributions
  router.get('/:wikidotId/attributions', async (req, res, next) => {
    try {
      const { wikidotId } = req.params as Record<string, string>;
      const sql = `
        WITH pv AS (
          SELECT id FROM "PageVersion"
          WHERE "wikidotId" = $1::int
          ORDER BY id DESC LIMIT 1
        )
        SELECT DISTINCT ON (u.id)
          u.id AS "userId",
          u."displayName",
          a.type
        FROM "Attribution" a
        JOIN pv ON a."pageVerId" = pv.id
        JOIN "User" u ON u.id = a."userId"
        ORDER BY u.id, a.type ASC
      `;
      const { rows } = await pool.query(sql, [wikidotId]);
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

  // GET /pages/{wikidotId}/attributions
  router.get('/:wikidotId/attributions', async (req, res, next) => {
    try {
      const { wikidotId } = req.params;
      const sql = `
        SELECT 
          a.type,
          a."order",
          a.date,
          a."userId",
          u."displayName",
          u."wikidotId" as "userWikidotId"
        FROM "Attribution" a
        JOIN "PageVersion" pv ON a."pageVerId" = pv.id
        LEFT JOIN "User" u ON a."userId" = u.id
        WHERE pv."wikidotId" = $1 AND pv."validTo" IS NULL
        ORDER BY a.type, a."order"
      `;
      const { rows } = await pool.query(sql, [wikidotId]);
      res.json(rows);
    } catch (err) {
      next(err);
    }
  });

  // GET /pages/{wikidotId}/vote-distribution
  router.get('/:wikidotId/vote-distribution', async (req, res, next) => {
    try {
      const { wikidotId } = req.params;
      const sql = `
        WITH pv AS (
          SELECT id FROM "PageVersion" WHERE "wikidotId" = $1 AND "validTo" IS NULL LIMIT 1
        )
        SELECT 
          COUNT(CASE WHEN v.direction = 1 THEN 1 END) as upvotes,
          COUNT(CASE WHEN v.direction = -1 THEN 1 END) as downvotes,
          COUNT(CASE WHEN v.direction = 0 THEN 1 END) as novotes,
          COUNT(*) as total
        FROM "Vote" v
        JOIN pv ON v."pageVersionId" = pv.id
      `;
      const { rows } = await pool.query(sql, [wikidotId]);
      res.json(rows[0] || { upvotes: 0, downvotes: 0, novotes: 0, total: 0 });
    } catch (err) {
      next(err);
    }
  });

  // GET /pages/{wikidotId}/related-records
  router.get('/:wikidotId/related-records', async (req, res, next) => {
    try {
      const { wikidotId } = req.params;
      const { limit = '10' } = req.query as Record<string, string>;
      
      // Get page ID first
      const pageIdResult = await pool.query(
        `SELECT p.id FROM "Page" p JOIN "PageVersion" pv ON p.id = pv."pageId" WHERE pv."wikidotId" = $1 LIMIT 1`,
        [wikidotId]
      );
      
      if (pageIdResult.rows.length === 0) {
        return res.status(404).json({ error: 'not_found' });
      }
      
      const pageId = pageIdResult.rows[0].id;
      
      // Get various records
      const sql = `
        WITH rating_records AS (
          SELECT 'rating' as category, "recordType", "pageTitle", rating, "voteCount", controversy, wilson95, "achievedAt"
          FROM "RatingRecords"
          WHERE "pageId" = $1
          ORDER BY "achievedAt" DESC NULLS LAST
          LIMIT $2::int
        ),
        content_records AS (
          SELECT 'content' as category, "recordType", "pageTitle", NULL::int as rating, "sourceLength" as "voteCount", NULL::float as controversy, NULL::float as wilson95, "calculatedAt" as "achievedAt"
          FROM "ContentRecords"
          WHERE "pageId" = $1
          ORDER BY "calculatedAt" DESC
          LIMIT $2::int
        ),
        interesting_facts AS (
          SELECT 'fact' as category, type as "recordType", title as "pageTitle", NULL::int as rating, NULL::int as "voteCount", NULL::float as controversy, NULL::float as wilson95, "calculatedAt" as "achievedAt"
          FROM "InterestingFacts"
          WHERE "pageId" = $1 AND "isActive" = true
          ORDER BY rank ASC, "calculatedAt" DESC
          LIMIT $2::int
        )
        SELECT * FROM rating_records
        UNION ALL
        SELECT * FROM content_records
        UNION ALL
        SELECT * FROM interesting_facts
        ORDER BY "achievedAt" DESC NULLS LAST
        LIMIT $2::int
      `;
      const { rows } = await pool.query(sql, [pageId, limit]);
      res.json(rows);
    } catch (err) {
      next(err);
    }
  });

  // GET /pages/:wikidotId/rating-history
  router.get('/:wikidotId/rating-history', async (req, res, next) => {
    try {
      const { wikidotId } = req.params as Record<string, string>;
      const wikidotIdInt = parseInt(wikidotId, 10);
      if (isNaN(wikidotIdInt)) {
        return res.status(400).json({ error: 'Invalid wikidotId' });
      }
      const { granularity = 'week' } = req.query as Record<string, string>;
      
      // 获取页面的投票历史，按周或月聚合（无时间限制，获取全部历史数据）
      const dateLabel = granularity === 'month' ? 'YYYY-MM-DD' : 'YYYY-MM-DD';
      
      const sql = `
        WITH vote_history AS (
          -- 获取页面的所有投票，按周或月聚合（无时间限制）
          SELECT 
            DATE_TRUNC('${granularity}', v.timestamp) as period,
            SUM(CASE WHEN v.direction > 0 THEN v.direction ELSE 0 END) as upvotes,
            SUM(CASE WHEN v.direction < 0 THEN ABS(v.direction) ELSE 0 END) as downvotes,
            SUM(v.direction) as net_change
          FROM "Vote" v
          JOIN "PageVersion" pv ON v."pageVersionId" = pv.id
          WHERE pv."wikidotId" = $1
          GROUP BY DATE_TRUNC('${granularity}', v.timestamp)
        ),
        cumulative AS (
          -- 计算累计评分
          SELECT 
            period,
            upvotes,
            downvotes,
            net_change,
            SUM(net_change) OVER (ORDER BY period) as cumulative_rating
          FROM vote_history
        )
        SELECT 
          TO_CHAR(period, '${dateLabel}') as date,
          COALESCE(upvotes, 0) as upvotes,
          COALESCE(downvotes, 0) as downvotes,
          COALESCE(net_change, 0) as net_change,
          COALESCE(cumulative_rating, 0) as cumulative_rating
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


