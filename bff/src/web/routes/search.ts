import { Router } from 'express';
import type { Pool } from 'pg';
import type { RedisClientType } from 'redis';

export function searchRouter(pool: Pool, _redis: RedisClientType | null) {
  const router = Router();

  // GET /search/pages
  router.get('/pages', async (req, res, next) => {
    try {
      const {
        query,
        limit = '20',
        offset = '0',
        tags,
        excludeTags,
        ratingMin,
        ratingMax,
        orderBy = 'relevance'
      } = req.query as Record<string, string>;
      if (!query) return res.status(400).json({ error: 'query is required' });

      const sql = `
        WITH base AS (
          SELECT 
            pv.id,
            pv."wikidotId",
            pv."pageId",
            pv.title,
            p."currentUrl" AS url,
            pv.rating,
            pv.tags,
            COALESCE(
              array_to_string(pgroonga_snippet_html(pv."textContent", pgroonga_query_extract_keywords($1), 200), ' '),
              LEFT(pv."textContent", 200)
            ) AS snippet,
            pgroonga_score(pv.tableoid, pv.ctid) AS score,
            pv."validFrom"
          FROM "PageVersion" pv
          JOIN "Page" p ON pv."pageId" = p.id
          WHERE pv."validTo" IS NULL
            AND (pv.title &@~ $1 OR pv."textContent" &@~ $1)
            AND ($2::text[] IS NULL OR pv.tags @> $2::text[])
            AND ($3::text[] IS NULL OR NOT (pv.tags && $3::text[]))
            AND ($4::int IS NULL OR pv.rating >= $4)
            AND ($5::int IS NULL OR pv.rating <= $5)
        )
        SELECT * FROM base
        ORDER BY 
          CASE WHEN $8 = 'rating' THEN NULL END,
          CASE WHEN $8 = 'recent' THEN NULL END,
          CASE WHEN $8 IS NULL OR $8 = 'relevance' THEN score END DESC NULLS LAST,
          CASE WHEN $8 = 'rating' THEN rating END DESC NULLS LAST,
          CASE WHEN $8 = 'recent' THEN "validFrom" END DESC
        LIMIT $6::int OFFSET $7::int
      `;

      const params = [
        query,
        tags ? (Array.isArray(tags) ? (tags as any) : [tags]) : null,
        excludeTags ? (Array.isArray(excludeTags) ? (excludeTags as any) : [excludeTags]) : null,
        ratingMin || null,
        ratingMax || null,
        limit,
        offset,
        orderBy
      ];
      const { rows } = await pool.query(sql, params);
      res.json({ results: rows });
    } catch (err) {
      next(err);
    }
  });

  // GET /search/users
  router.get('/users', async (req, res, next) => {
    try {
      const { query, limit = '20', offset = '0' } = req.query as Record<string, string>;
      if (!query) return res.status(400).json({ error: 'query is required' });
      const sql = `
        SELECT 
          u.id,
          u."wikidotId",
          u."displayName",
          COALESCE(us."totalRating", 0) AS "totalRating",
          COALESCE(us."pageCount", 0) AS "pageCount"
        FROM "User" u
        LEFT JOIN "UserStats" us ON u.id = us."userId"
        WHERE u."displayName" &@~ $1
        ORDER BY us."totalRating" DESC NULLS LAST
        LIMIT $2::int OFFSET $3::int
      `;
      const { rows } = await pool.query(sql, [query, limit, offset]);
      res.json({ results: rows });
    } catch (err) {
      next(err);
    }
  });

  // GET /search/all
  // Unified search across pages and users, with hybrid ranking
  router.get('/all', async (req, res, next) => {
    try {
      const {
        query,
        // global pagination over the merged list
        limit = '20',
        offset = '0',
        // per-type caps (optional)
        pageLimit,
        userLimit,
        // page filters
        tags,
        excludeTags,
        ratingMin,
        ratingMax,
        // ordering for merged results
        orderBy = 'relevance' // relevance | pages_first | users_first | page_rating | user_totalRating
      } = req.query as Record<string, string>;
      if (!query) return res.status(400).json({ error: 'query is required' });

      const totalLimit = Math.max(0, Number(limit) | 0);
      const totalOffset = Math.max(0, Number(offset) | 0);
      const defaultPageCap = Math.max(0, Math.min(totalLimit || 20, Math.ceil((totalLimit || 20) * 0.6)));
      const pageCap = Math.max(0, Number(pageLimit ?? defaultPageCap) | 0);
      const userCap = Math.max(0, Number(userLimit ?? ((totalLimit || 20) - pageCap)) | 0);

      const pageSql = `
        WITH base AS (
          SELECT 
            pv.id,
            pv."wikidotId",
            pv."pageId",
            pv.title,
            p."currentUrl" AS url,
            pv.rating,
            pv.tags,
            COALESCE(
              array_to_string(pgroonga_snippet_html(pv."textContent", pgroonga_query_extract_keywords($1), 200), ' '),
              LEFT(pv."textContent", 200)
            ) AS snippet,
            pgroonga_score(pv.tableoid, pv.ctid) AS score,
            pv."validFrom"
          FROM "PageVersion" pv
          JOIN "Page" p ON pv."pageId" = p.id
          WHERE pv."validTo" IS NULL
            AND (pv.title &@~ $1 OR pv."textContent" &@~ $1)
            AND ($2::text[] IS NULL OR pv.tags @> $2::text[])
            AND ($3::text[] IS NULL OR NOT (pv.tags && $3::text[]))
            AND ($4::int IS NULL OR pv.rating >= $4)
            AND ($5::int IS NULL OR pv.rating <= $5)
        )
        SELECT * FROM base
        ORDER BY 
          CASE WHEN $8 = 'rating' THEN NULL END,
          CASE WHEN $8 = 'recent' THEN NULL END,
          CASE WHEN $8 IS NULL OR $8 = 'relevance' THEN score END DESC NULLS LAST,
          CASE WHEN $8 = 'rating' THEN rating END DESC NULLS LAST,
          CASE WHEN $8 = 'recent' THEN "validFrom" END DESC
        LIMIT $6::int OFFSET $7::int
      `;
      const pageParams = [
        query,
        tags ? (Array.isArray(tags) ? (tags as any) : [tags]) : null,
        excludeTags ? (Array.isArray(excludeTags) ? (excludeTags as any) : [excludeTags]) : null,
        ratingMin || null,
        ratingMax || null,
        String(pageCap),
        '0',
        'relevance'
      ];

      const userSql = `
        SELECT 
          u.id,
          u."wikidotId",
          u."displayName",
          COALESCE(us."totalRating", 0) AS "totalRating",
          COALESCE(us."pageCount", 0) AS "pageCount",
          pgroonga_score(u.tableoid, u.ctid) AS score
        FROM "User" u
        LEFT JOIN "UserStats" us ON u.id = us."userId"
        WHERE u."displayName" &@~ $1
        ORDER BY score DESC NULLS LAST, us."totalRating" DESC NULLS LAST
        LIMIT $2::int OFFSET $3::int
      `;
      const userParams = [query, String(userCap), '0'];

      const [pageRes, userRes] = await Promise.all([
        pool.query(pageSql, pageParams),
        pool.query(userSql, userParams)
      ]);

      const pages = (pageRes.rows || []).map((r) => ({
        type: 'page' as const,
        id: r.id,
        wikidotId: r.wikidotId,
        pageId: r.pageId,
        title: r.title,
        url: r.url,
        rating: r.rating,
        tags: r.tags,
        snippet: r.snippet,
        textScore: typeof r.score === 'number' ? r.score : null,
        popularityScore: typeof r.rating === 'number' ? r.rating : 0
      }));
      const users = (userRes.rows || []).map((r) => ({
        type: 'user' as const,
        id: r.id,
        wikidotId: r.wikidotId,
        displayName: r.displayName,
        totalRating: r.totalRating ?? 0,
        pageCount: r.pageCount ?? 0,
        textScore: typeof r.score === 'number' ? r.score : null,
        popularityScore: typeof r.totalRating === 'number' ? r.totalRating : 0
      }));

      // Build merged list with a simple hybrid score
      const textScores = [...pages, ...users].map((i) => i.textScore || 0);
      const popScores = [...pages, ...users].map((i) => i.popularityScore || 0);
      const maxText = Math.max(1, ...textScores);
      const maxPop = Math.max(1, ...popScores);
      const hybrid = [...pages, ...users].map((i) => ({
        ...i,
        combinedScore: 0.7 * ((i.textScore || 0) / maxText) + 0.3 * ((i.popularityScore || 0) / maxPop)
      }));

      let sorted = hybrid;
      switch ((orderBy || 'relevance').toLowerCase()) {
        case 'pages_first':
          sorted = hybrid.sort((a, b) => (a.type === b.type ? b.combinedScore - a.combinedScore : a.type === 'page' ? -1 : 1));
          break;
        case 'users_first':
          sorted = hybrid.sort((a, b) => (a.type === b.type ? b.combinedScore - a.combinedScore : a.type === 'user' ? -1 : 1));
          break;
        case 'page_rating':
          sorted = hybrid.sort((a, b) => ((b.type === 'page' ? (b as any).rating || 0 : 0) - (a.type === 'page' ? (a as any).rating || 0 : 0)) || (b.combinedScore - a.combinedScore));
          break;
        case 'user_totalrating':
          sorted = hybrid.sort((a, b) => ((b.type === 'user' ? (b as any).totalRating || 0 : 0) - (a.type === 'user' ? (a as any).totalRating || 0 : 0)) || (b.combinedScore - a.combinedScore));
          break;
        case 'relevance':
        default:
          sorted = hybrid.sort((a, b) => b.combinedScore - a.combinedScore);
          break;
      }

      const sliced = totalOffset > 0 ? sorted.slice(totalOffset, totalOffset + (totalLimit || 20)) : sorted.slice(0, (totalLimit || 20));

      res.json({
        results: sliced,
        meta: {
          counts: { pages: pages.length, users: users.length },
          usedCaps: { pageLimit: pageCap, userLimit: userCap },
          orderBy
        }
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}


