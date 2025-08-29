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
        orderBy = 'relevance',
        includeTotal = 'true',
        includeSnippet = 'true',
        includeDate = 'true'
      } = req.query as Record<string, string>;
      if (!query) return res.status(400).json({ error: 'query is required' });

      const wantTotal = String(includeTotal).toLowerCase() === 'true';
      const wantSnippet = String(includeSnippet).toLowerCase() === 'true';
      const wantDate = String(includeDate).toLowerCase() === 'true';

      // Limit-then-enrich: compute Top-N first, then attach optional fields
      const baseSql = `
        WITH base AS (
          SELECT 
            pv.id,
            pv."wikidotId",
            pv."pageId",
            pv.title,
            p."currentUrl" AS url,
            p."firstPublishedAt" AS "firstPublishedAt",
            pv.rating,
            pv."voteCount",
            pv."revisionCount",
            pv."commentCount",
            pv.tags,
            pgroonga_score(pv.tableoid, pv.ctid) AS score,
            pv."validFrom",
            ps."wilson95",
            ps."controversy"
          FROM "PageVersion" pv
          JOIN "Page" p ON pv."pageId" = p.id
          LEFT JOIN "PageStats" ps ON ps."pageVersionId" = pv.id
          WHERE pv."validTo" IS NULL
            AND (pv.title &@~ $1 OR pv."textContent" &@~ $1)
            AND ($2::text[] IS NULL OR pv.tags @> $2::text[])
            AND ($3::text[] IS NULL OR NOT (pv.tags && $3::text[]))
            AND ($4::int IS NULL OR pv.rating >= $4)
            AND ($5::int IS NULL OR pv.rating <= $5)
        ),
        limited AS (
          SELECT * FROM base
          ORDER BY 
            CASE WHEN $8 = 'rating' THEN NULL END,
            CASE WHEN $8 = 'recent' THEN NULL END,
            CASE WHEN $8 IS NULL OR $8 = 'relevance' THEN (CASE WHEN lower(split_part(url, '/', 4)) = lower($1) THEN 1 ELSE 0 END) END DESC NULLS LAST,
            CASE WHEN $8 IS NULL OR $8 = 'relevance' THEN (CASE WHEN lower(title) = lower($1) THEN 1 ELSE 0 END) END DESC NULLS LAST,
            CASE WHEN $8 IS NULL OR $8 = 'relevance' THEN (CASE WHEN title &@~ $1 THEN 1 ELSE 0 END) END DESC NULLS LAST,
            CASE WHEN $8 IS NULL OR $8 = 'relevance' THEN (
              score
              + LN(1 + COALESCE("voteCount", 0)) * 0.05
              + LN(1 + COALESCE("commentCount", 0)) * 0.03
            ) END DESC NULLS LAST,
            CASE WHEN $8 = 'rating' THEN rating END DESC NULLS LAST,
            CASE WHEN $8 = 'recent' THEN "validFrom" END DESC
          LIMIT $6::int OFFSET $7::int
        )
      `;

      const finalSql = wantSnippet
        ? `${baseSql}
          SELECT l.*, l."firstPublishedAt" AS "firstRevisionAt", sn.snippet
          FROM limited l
          LEFT JOIN LATERAL (
            SELECT array_to_string(
                     pgroonga_snippet_html(pv."textContent", pgroonga_query_extract_keywords($1), 200), ' '
                   ) AS snippet
            FROM "PageVersion" pv
            WHERE pv.id = l.id
          ) sn ON TRUE
        `
        : `${baseSql}
          SELECT l.*, l."firstPublishedAt" AS "firstRevisionAt"
          FROM limited l
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

      const [{ rows }, totalRes] = await Promise.all([
        pool.query(finalSql, params),
        wantTotal
          ? pool.query(
              `SELECT COUNT(*) AS total
               FROM "PageVersion" pv
               WHERE pv."validTo" IS NULL
                 AND (pv.title &@~ $1 OR pv."textContent" &@~ $1)
                 AND ($2::text[] IS NULL OR pv.tags @> $2::text[])
                 AND ($3::text[] IS NULL OR NOT (pv.tags && $3::text[]))
                 AND ($4::int IS NULL OR pv.rating >= $4)
                 AND ($5::int IS NULL OR pv.rating <= $5)`,
              [
                query,
                tags ? (Array.isArray(tags) ? (tags as any) : [tags]) : null,
                excludeTags ? (Array.isArray(excludeTags) ? (excludeTags as any) : [excludeTags]) : null,
                ratingMin || null,
                ratingMax || null
              ]
            )
          : Promise.resolve(null as any)
      ]);

      const total = totalRes ? Number(totalRes.rows?.[0]?.total || 0) : undefined;
      // If includeDate=false, strip the firstRevisionAt to reduce payload size
      const results = rows.map((r: any) => {
        if (!wantDate) {
          const { firstRevisionAt, ...rest } = r;
          return rest;
        }
        return r;
      });

      res.json(total !== undefined ? { results, total } : { results });
    } catch (err) {
      next(err);
    }
  });

  // GET /search/users
  router.get('/users', async (req, res, next) => {
    try {
      const { query, limit = '20', offset = '0', includeTotal = 'true' } = req.query as Record<string, string>;
      if (!query) return res.status(400).json({ error: 'query is required' });
      const wantTotal = String(includeTotal).toLowerCase() === 'true';
      const sql = `
        SELECT 
          u.id,
          u."wikidotId",
          u."displayName",
          us."overallRank" AS rank,
          COALESCE(us."totalRating", 0) AS "totalRating",
          COALESCE(us."pageCount", 0) AS "pageCount"
        FROM "User" u
        LEFT JOIN "UserStats" us ON u.id = us."userId"
        WHERE (u."displayName" &@~ $1) OR (LOWER(u."displayName") ILIKE LOWER('%' || $1 || '%'))
        ORDER BY us."totalRating" DESC NULLS LAST
        LIMIT $2::int OFFSET $3::int
      `;
      const [rowsRes, totalRes] = await Promise.all([
        pool.query(sql, [query, limit, offset]),
        wantTotal ? pool.query(`SELECT COUNT(*) AS total FROM "User" WHERE ("displayName" &@~ $1) OR (LOWER("displayName") ILIKE LOWER('%' || $1 || '%'))`, [query]) : Promise.resolve(null as any)
      ]);
      const results = rowsRes.rows;
      const total = totalRes ? Number(totalRes.rows?.[0]?.total || 0) : undefined;
      res.json(total !== undefined ? { results, total } : { results });
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
            p."firstPublishedAt" AS "firstRevisionAt",
            pv.rating,
            pv."voteCount",
            pv."revisionCount",
            pv."commentCount",
            pv.tags,
            pgroonga_score(pv.tableoid, pv.ctid) AS score,
            pv."validFrom",
            ps."wilson95",
            ps."controversy"
          FROM "PageVersion" pv
          JOIN "Page" p ON pv."pageId" = p.id
          LEFT JOIN "PageStats" ps ON ps."pageVersionId" = pv.id
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
          us."overallRank" AS rank,
          COALESCE(us."totalRating", 0) AS "totalRating",
          COALESCE(us."pageCount", 0) AS "pageCount",
          pgroonga_score(u.tableoid, u.ctid) AS score
        FROM "User" u
        LEFT JOIN "UserStats" us ON u.id = us."userId"
        WHERE (u."displayName" &@~ $1) OR (LOWER(u."displayName") ILIKE LOWER('%' || $1 || '%'))
        ORDER BY score DESC NULLS LAST, us."totalRating" DESC NULLS LAST
        LIMIT $2::int OFFSET $3::int
      `;
      const userParams = [query, String(userCap), '0'];

      // total counts (without LIMIT/OFFSET)
      const pageCountSql = `
        SELECT COUNT(*) AS total
        FROM "PageVersion" pv
        WHERE pv."validTo" IS NULL
          AND (pv.title &@~ $1 OR pv."textContent" &@~ $1)
          AND ($2::text[] IS NULL OR pv.tags @> $2::text[])
          AND ($3::text[] IS NULL OR NOT (pv.tags && $3::text[]))
          AND ($4::int IS NULL OR pv.rating >= $4)
          AND ($5::int IS NULL OR pv.rating <= $5)
      `;
      const userCountSql = `
        SELECT COUNT(*) AS total
        FROM "User" u
        WHERE (u."displayName" &@~ $1) OR (LOWER(u."displayName") ILIKE LOWER('%' || $1 || '%'))
      `;

      const [pageRes, userRes, pageCountRes, userCountRes] = await Promise.all([
        pool.query(pageSql, pageParams),
        pool.query(userSql, userParams),
        pool.query(pageCountSql, [query, pageParams[1], pageParams[2], pageParams[3], pageParams[4]]),
        pool.query(userCountSql, [query])
      ]);

      const pages = (pageRes.rows || []).map((r) => ({
        type: 'page' as const,
        id: r.id,
        wikidotId: r.wikidotId,
        pageId: r.pageId,
        title: r.title,
        url: r.url,
        rating: r.rating,
        voteCount: r.voteCount,
        revisionCount: r.revisionCount,
        commentCount: r.commentCount,
        tags: r.tags,
        snippet: r.snippet,
        wilson95: typeof r.wilson95 === 'number' ? r.wilson95 : null,
        controversy: typeof r.controversy === 'number' ? r.controversy : null,
        firstRevisionAt: r.firstRevisionAt || null,
        textScore: typeof r.score === 'number' ? r.score : null,
        popularityScore: typeof r.rating === 'number' ? r.rating : 0
      }));
      const users = (userRes.rows || []).map((r) => ({
        type: 'user' as const,
        id: r.id,
        wikidotId: r.wikidotId,
        displayName: r.displayName,
        rank: r.rank ?? null,
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

      const totalPages = Number(pageCountRes.rows?.[0]?.total || 0);
      const totalUsers = Number(userCountRes.rows?.[0]?.total || 0);
      res.json({
        results: sliced,
        meta: {
          counts: { pages: totalPages, users: totalUsers },
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


