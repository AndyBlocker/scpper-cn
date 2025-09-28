import { Router } from 'express';
import type { Pool } from 'pg';
import type { RedisClientType } from 'redis';

export function pagesRouter(pool: Pool, _redis: RedisClientType | null) {
  const router = Router();

  async function mergeDeletedWithLatestLiveVersion(row: any) {
    if (!row || row.isDeleted !== true || !row.pageId) return row;

    const fallbackSql = `
      SELECT rating, "voteCount", "revisionCount", "commentCount", "attributionCount", tags, title, category, "wikidotId"
      FROM "PageVersion"
      WHERE "pageId" = $1 AND "isDeleted" = false
      ORDER BY "validFrom" DESC NULLS LAST, id DESC
      LIMIT 1
    `;

    const { rows: prevRows } = await pool.query(fallbackSql, [row.pageId]);
    if (prevRows.length === 0) return row;

    const prev = prevRows[0];
    const merged = { ...row };
    const fieldsToCopy = [
      'rating',
      'voteCount',
      'revisionCount',
      'commentCount',
      'attributionCount',
      'tags',
      'title',
      'category'
    ] as const;

    for (const key of fieldsToCopy) {
      if (prev[key] !== undefined) {
        merged[key] = prev[key];
      }
    }

    if (!merged.wikidotId && prev.wikidotId) {
      merged.wikidotId = prev.wikidotId;
    }

    merged.isDeleted = true;
    return merged;
  }

  interface PageContext {
    pageId: number;
    currentVersionId: number | null;
    currentIsDeleted: boolean;
    effectiveVersionId: number | null;
    effectiveIsDeleted: boolean;
  }

  async function resolvePageContextByWikidotId(input: string | number): Promise<PageContext | null> {
    const wikidotId = Number(input);
    if (!Number.isFinite(wikidotId)) return null;

    const { rows: pageRows } = await pool.query(
      'SELECT id FROM "Page" WHERE "wikidotId" = $1 LIMIT 1',
      [wikidotId]
    );
    if (pageRows.length === 0) return null;
    const pageId = pageRows[0].id;

    const { rows: currentRows } = await pool.query(
      `SELECT id, "isDeleted"
         FROM "PageVersion"
         WHERE "pageId" = $1 AND "validTo" IS NULL
         ORDER BY id DESC
         LIMIT 1`,
      [pageId]
    );
    const current = currentRows[0] ?? null;

    let effective = current;
    if (!effective) {
      const { rows: anyRows } = await pool.query(
        `SELECT id, "isDeleted"
           FROM "PageVersion"
           WHERE "pageId" = $1
           ORDER BY "validFrom" DESC NULLS LAST, id DESC
           LIMIT 1`,
        [pageId]
      );
      effective = anyRows[0] ?? null;
    } else if (effective.isDeleted) {
      const { rows: liveRows } = await pool.query(
        `SELECT id, "isDeleted"
           FROM "PageVersion"
           WHERE "pageId" = $1 AND "isDeleted" = false
           ORDER BY "validFrom" DESC NULLS LAST, id DESC
           LIMIT 1`,
        [pageId]
      );
      if (liveRows.length > 0) {
        effective = liveRows[0];
      }
    }

    return {
      pageId,
      currentVersionId: current?.id ?? null,
      currentIsDeleted: current?.isDeleted ?? false,
      effectiveVersionId: effective?.id ?? null,
      effectiveIsDeleted: effective?.isDeleted ?? false
    };
  }

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
        SELECT 
          COALESCE(pv."wikidotId", p."wikidotId") AS "wikidotId",
          p."currentUrl" AS url,
          pv.*,
          CASE WHEN pv."isDeleted" THEN pv."validFrom" ELSE NULL END AS "deletedAt"
        FROM "PageVersion" pv
        JOIN "Page" p ON pv."pageId" = p.id
        WHERE pv."validTo" IS NULL AND p."currentUrl" = $1
        LIMIT 1
      `;
      const { rows } = await pool.query(sql, [url]);
      if (rows.length === 0) return res.status(404).json({ error: 'not_found' });
      const row = rows[0];
      const merged = await mergeDeletedWithLatestLiveVersion(row);
      res.json(merged);
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
        SELECT 
          COALESCE(pv."wikidotId", p."wikidotId") AS "wikidotId",
          p."currentUrl" AS url,
          pv.*,
          CASE WHEN pv."isDeleted" THEN pv."validFrom" ELSE NULL END AS "deletedAt"
        FROM "PageVersion" pv
        JOIN "Page" p ON pv."pageId" = p.id
        WHERE pv."validTo" IS NULL AND p."wikidotId" = $1
        LIMIT 1
      `;
      const { rows } = await pool.query(sql, [wikidotId]);
      if (rows.length === 0) return res.status(404).json({ error: 'not_found' });
      const row = rows[0];
      const merged = await mergeDeletedWithLatestLiveVersion(row);
      res.json(merged);
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
        SELECT COALESCE(pv."wikidotId", p."wikidotId") AS "wikidotId", p."currentUrl" AS url, pv.title, pv.rating, pv.tags
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
            COALESCE(pv."wikidotId", p."wikidotId") AS "wikidotId",
            p."currentUrl" AS url,
            pv.title,
            pv.rating,
            pv."commentCount",
            pv."voteCount",
            pv.category,
            pv.tags,
            pv."createdAt",
            pv."revisionCount",
            pv."attributionCount",
            pv."isDeleted" AS "isDeleted",
            CASE WHEN pv."isDeleted" THEN pv."validFrom" ELSE NULL END AS "deletedAt"
          FROM "PageVersion" pv
          JOIN "Page" p ON pv."pageId" = p.id
          WHERE pv."validTo" IS NULL
            AND pv.rating IS NOT NULL
            AND COALESCE(array_length(pv.tags, 1), 0) > 0
            AND NOT (pv.tags && ARRAY['作者','段落','补充材料']::text[])
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
            COALESCE(pv."wikidotId", p."wikidotId") AS "wikidotId",
            p."currentUrl" AS url,
            pv.title,
            pv.rating,
            pv."commentCount",
            pv."voteCount",
            pv.category,
            pv.tags,
            pv."createdAt",
            pv."revisionCount",
            pv."attributionCount",
            pv."textContent",
            pv."isDeleted" AS "isDeleted",
            CASE WHEN pv."isDeleted" THEN pv."validFrom" ELSE NULL END AS "deletedAt"
          FROM "PageVersion" pv
          JOIN "Page" p ON pv."pageId" = p.id
          WHERE pv."validTo" IS NULL
            AND pv.rating >= 50
            AND '原创' = ANY(pv.tags)
            AND COALESCE(array_length(pv.tags, 1), 0) > 0
            AND NOT (pv.tags && ARRAY['作者','段落','补充材料']::text[])
          ORDER BY random()
          LIMIT 1
        `;
        
        // Query 2: Get 3 other original pages
        const otherOriginalSql = `
          SELECT 
            COALESCE(pv."wikidotId", p."wikidotId") AS "wikidotId",
            p."currentUrl" AS url,
            pv.title,
            pv.rating,
            pv."commentCount",
            pv."voteCount",
            pv.category,
            pv.tags,
            pv."createdAt",
            pv."revisionCount",
            pv."attributionCount",
            pv."textContent",
            pv."isDeleted" AS "isDeleted",
            CASE WHEN pv."isDeleted" THEN pv."validFrom" ELSE NULL END AS "deletedAt"
          FROM "PageVersion" pv
          JOIN "Page" p ON pv."pageId" = p.id
          WHERE pv."validTo" IS NULL
            AND pv.rating IS NOT NULL
            AND '原创' = ANY(pv.tags)
            AND COALESCE(array_length(pv.tags, 1), 0) > 0
            AND NOT (pv.tags && ARRAY['作者','段落','补充材料']::text[])
          ORDER BY random()
          LIMIT 3
        `;
        
        // Query 3: Get 2 non-original (translation) pages
        const translationSql = `
          SELECT 
            COALESCE(pv."wikidotId", p."wikidotId") AS "wikidotId",
            p."currentUrl" AS url,
            pv.title,
            pv.rating,
            pv."commentCount",
            pv."voteCount",
            pv.category,
            pv.tags,
            pv."createdAt",
            pv."revisionCount",
            pv."attributionCount",
            pv."textContent",
            pv."isDeleted" AS "isDeleted",
            CASE WHEN pv."isDeleted" THEN pv."validFrom" ELSE NULL END AS "deletedAt"
          FROM "PageVersion" pv
          JOIN "Page" p ON pv."pageId" = p.id
          WHERE pv."validTo" IS NULL
            AND pv.rating IS NOT NULL
            AND NOT ('原创' = ANY(pv.tags))
            AND COALESCE(array_length(pv.tags, 1), 0) > 0
            AND NOT (pv.tags && ARRAY['作者','段落','补充材料']::text[])
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
          AND COALESCE(array_length(pv.tags, 1), 0) > 0
          AND NOT (pv.tags && ARRAY['作者','段落','补充材料']::text[])
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
  // query: limit, offset, order=ASC|DESC, type (optional exact match), includeSource=true|false, scope=all|latest
  router.get('/:wikidotId/revisions', async (req, res, next) => {
    try {
      const { limit = '20', offset = '0', order = 'DESC', type, includeSource = 'false', scope = 'all' } = req.query as Record<string, string>;
      const { wikidotId } = req.params as Record<string, string>;
      const dir = (order || 'DESC').toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
      const withSource = (includeSource || '').toLowerCase() === 'true';
      const scopeLatest = (scope || '').toLowerCase() === 'latest';
      const context = await resolvePageContextByWikidotId(wikidotId);
      if (!context || !context.pageId) return res.status(404).json({ error: 'not_found' });

      if (scopeLatest) {
        if (!context.effectiveVersionId) {
          return res.json([]);
        }
        const sql = `
          SELECT 
            r.id              AS "revisionId",
            r."wikidotId",
            r.timestamp,
            r.type,
            r.comment,
            r."userId",
            u."displayName" AS "userDisplayName",
            u."wikidotId"   AS "userWikidotId",
            sv."revisionNumber" AS "revisionNumber",
            COALESCE(sv."hasSource", false) AS "hasSource"${withSource ? ', sv.source' : ''}
          FROM "Revision" r
          LEFT JOIN "User" u ON u.id = r."userId"
          LEFT JOIN LATERAL (
            SELECT 
              s."revisionNumber",
              ${withSource ? 's.source,' : ''}
              (s.source IS NOT NULL) AS "hasSource"
            FROM "SourceVersion" s
            WHERE s."revisionId" = r.id
            ORDER BY s."isLatest" DESC, s.timestamp DESC
            LIMIT 1
          ) sv ON TRUE
          WHERE r."pageVersionId" = $1
            AND ($4::text IS NULL OR r.type = $4::text)
          ORDER BY r.timestamp ${dir}
          LIMIT $2::int OFFSET $3::int
        `;
        const { rows } = await pool.query(sql, [context.effectiveVersionId, limit, offset, type || null]);
        return res.json(rows);
      }

      const sql = `
        SELECT 
          r.id              AS "revisionId",
          r."wikidotId",
          r.timestamp,
          r.type,
          r.comment,
          r."userId",
          u."displayName" AS "userDisplayName",
          u."wikidotId"   AS "userWikidotId",
          sv."revisionNumber" AS "revisionNumber",
          COALESCE(sv."hasSource", false) AS "hasSource"${withSource ? ', sv.source' : ''}
        FROM "Revision" r
        JOIN "PageVersion" pv ON r."pageVersionId" = pv.id
        LEFT JOIN "User" u ON u.id = r."userId"
        LEFT JOIN LATERAL (
          SELECT 
            s."revisionNumber",
            ${withSource ? 's.source,' : ''}
            (s.source IS NOT NULL) AS "hasSource"
          FROM "SourceVersion" s
          WHERE s."revisionId" = r.id
          ORDER BY s."isLatest" DESC, s.timestamp DESC
          LIMIT 1
        ) sv ON TRUE
        WHERE pv."pageId" = $1
          AND ($4::text IS NULL OR r.type = $4::text)
        ORDER BY r.timestamp ${dir}
        LIMIT $2::int OFFSET $3::int
      `;
      const { rows } = await pool.query(sql, [context.pageId, limit, offset, type || null]);
      res.json(rows);
    } catch (err) {
      next(err);
    }
  });

  // GET /api/wikidot-pages/:wikidotId/revisions/count
  // query: type (optional), scope=all|latest
  router.get('/:wikidotId/revisions/count', async (req, res, next) => {
    try {
      const { wikidotId } = req.params as Record<string, string>;
      const { type, scope = 'all' } = req.query as Record<string, string>;
      const scopeLatest = (scope || '').toLowerCase() === 'latest';
      const context = await resolvePageContextByWikidotId(wikidotId);
      if (!context || !context.pageId) return res.json({ total: 0 });

      if (scopeLatest) {
        if (!context.effectiveVersionId) return res.json({ total: 0 });
        const { rows } = await pool.query(
          `SELECT COUNT(*)::int AS total
             FROM "Revision" r
            WHERE r."pageVersionId" = $1
              AND ($2::text IS NULL OR r.type = $2::text)`,
          [context.effectiveVersionId, type || null]
        );
        return res.json(rows[0] || { total: 0 });
      }

      const { rows } = await pool.query(
        `SELECT COUNT(*)::int AS total
           FROM "Revision" r
           JOIN "PageVersion" pv ON r."pageVersionId" = pv.id
          WHERE pv."pageId" = $1
            AND ($2::text IS NULL OR r.type = $2::text)`,
        [context.pageId, type || null]
      );
      res.json(rows[0] || { total: 0 });
    } catch (err) {
      next(err);
    }
  });

  // GET /pages/:wikidotId/attributions
  router.get('/:wikidotId/attributions', async (req, res, next) => {
    try {
      const { wikidotId } = req.params as Record<string, string>;
      const context = await resolvePageContextByWikidotId(wikidotId);
      if (!context || !context.effectiveVersionId) return res.json([]);
      const sql = `
        SELECT DISTINCT ON (u.id)
          u.id AS "userId",
          u."displayName",
          u."wikidotId" AS "userWikidotId",
          a.type
        FROM "Attribution" a
        JOIN "User" u ON u.id = a."userId"
        WHERE a."pageVerId" = $1
        ORDER BY u.id, a.type ASC
      `;
      const { rows } = await pool.query(sql, [context.effectiveVersionId]);
      res.json(rows);
    } catch (err) {
      next(err);
    }
  });

  // GET /api/wikidot-pages/:wikidotId/versions
  // List all PageVersion rows for this wikidotId (newest first). Does not include source by default.
  router.get('/:wikidotId/versions', async (req, res, next) => {
    try {
      const { wikidotId } = req.params as Record<string, string>;
      const { includeSource = 'false', limit = '100', offset = '0' } = req.query as Record<string, string>;
      const withSource = (includeSource || '').toLowerCase() === 'true';
      const sql = `
        SELECT 
          pv.id AS "pageVersionId",
          pv."createdAt",
          pv."validTo",
          pv.title,
          pv.rating,
          pv."revisionCount",
          ${withSource ? 'pv.source AS source,' : ''}
          CASE WHEN pv.source IS NULL THEN false ELSE true END AS "hasSource"
        FROM "PageVersion" pv
        WHERE pv."wikidotId" = $1::int
        ORDER BY pv.id DESC
        LIMIT $2::int OFFSET $3::int
      `;
      const { rows } = await pool.query(sql, [wikidotId, limit, offset]);
      res.json(rows);
    } catch (err) {
      next(err);
    }
  });

  // GET /api/wikidot-pages/:wikidotId/versions/:versionId/source
  router.get('/:wikidotId/versions/:versionId/source', async (req, res, next) => {
    try {
      const { wikidotId, versionId } = req.params as Record<string, string>;
      const sql = `
        SELECT pv.id AS "pageVersionId", pv.source
        FROM "PageVersion" pv
        WHERE pv."wikidotId" = $1::int AND pv.id = $2::int
        LIMIT 1
      `;
      const { rows } = await pool.query(sql, [wikidotId, versionId]);
      if (rows.length === 0) return res.status(404).json({ error: 'not_found' });
      res.json(rows[0]);
    } catch (err) {
      next(err);
    }
  });

  // GET /api/wikidot-pages/:wikidotId/votes/fuzzy
  router.get('/:wikidotId/votes/fuzzy', async (req, res, next) => {
    try {
      const { limit = '100', offset = '0' } = req.query as Record<string, string>;
      const { wikidotId } = req.params as Record<string, string>;
      const context = await resolvePageContextByWikidotId(wikidotId);
      if (!context || !context.effectiveVersionId) return res.json([]);
      const sql = `
        WITH dedup AS (
          SELECT v."userId", v.direction, v.timestamp::date AS day, MAX(v.timestamp) AS latest_ts
          FROM "Vote" v
          WHERE v."pageVersionId" = $1
          GROUP BY v."userId", v.direction, v.timestamp::date
        )
        SELECT d."userId", d.direction, d.latest_ts AS timestamp, u."displayName" AS "userDisplayName", u."wikidotId" AS "userWikidotId"
        FROM dedup d
        JOIN "User" u ON u.id = d."userId"
        ORDER BY d.latest_ts DESC
        LIMIT $2::int OFFSET $3::int
      `;
      const { rows } = await pool.query(sql, [context.effectiveVersionId, limit, offset]);
      res.json(rows);
    } catch (err) {
      next(err);
    }
  });

  // GET /api/wikidot-pages/:wikidotId/votes/fuzzy/count
  router.get('/:wikidotId/votes/fuzzy/count', async (req, res, next) => {
    try {
      const { wikidotId } = req.params as Record<string, string>;
      const context = await resolvePageContextByWikidotId(wikidotId);
      if (!context || !context.effectiveVersionId) return res.json({ total: 0 });
      const { rows } = await pool.query(
        `SELECT COUNT(*)::int AS total
           FROM (
             SELECT v."userId", v.direction, v.timestamp::date AS day
             FROM "Vote" v
             WHERE v."pageVersionId" = $1
             GROUP BY v."userId", v.direction, v.timestamp::date
           ) dedup`,
        [context.effectiveVersionId]
      );
      res.json(rows[0] || { total: 0 });
    } catch (err) {
      next(err);
    }
  });

  // GET /api/wikidot-pages/:wikidotId/revisions/:revisionId/source
  router.get('/:wikidotId/revisions/:revisionId/source', async (req, res, next) => {
    try {
      const { wikidotId, revisionId } = req.params as Record<string, string>;
      // 找到该修订及其所属的 PageVersion 和时间
      const base = await pool.query(
        `SELECT r.id AS "revisionId", r."wikidotId", r.timestamp, r."pageVersionId"
         FROM "Revision" r
         JOIN "PageVersion" pv ON r."pageVersionId" = pv.id
         WHERE pv."wikidotId" = $1::int AND r.id = $2::int
         LIMIT 1`,
        [wikidotId, revisionId]
      );
      if (base.rows.length === 0) return res.status(404).json({ error: 'not_found' });
      const row = base.rows[0];

      // 1) 取该修订的 SourceVersion（最新一条）
      const primary = await pool.query(
        `SELECT s."revisionNumber", s.source
         FROM "SourceVersion" s
         WHERE s."revisionId" = $1::int AND s.source IS NOT NULL
         ORDER BY s."isLatest" DESC, s.timestamp DESC
         LIMIT 1`,
        [row.revisionId]
      );
      if (primary.rows.length > 0) {
        return res.json({
          revisionId: row.revisionId,
          revisionNumber: primary.rows[0].revisionNumber,
          wikidotId: row.wikidotId,
          timestamp: row.timestamp,
          source: primary.rows[0].source
        });
      }

      // 2) 同一 PageVersion 内，回退到时间早于该修订、最近一条带源码的 SourceVersion
      const fallbackPrev = await pool.query(
        `SELECT s."revisionNumber", s.source
         FROM "SourceVersion" s
         WHERE s."pageVersionId" = $1::int
           AND s.source IS NOT NULL
           AND s.timestamp < $2::timestamptz
         ORDER BY s.timestamp DESC
         LIMIT 1`,
        [row.pageVersionId, row.timestamp]
      );
      if (fallbackPrev.rows.length > 0) {
        return res.json({
          revisionId: row.revisionId,
          revisionNumber: fallbackPrev.rows[0].revisionNumber,
          wikidotId: row.wikidotId,
          timestamp: row.timestamp,
          source: fallbackPrev.rows[0].source
        });
      }

      // 3) 回退到 PageVersion 的源码
      const pvRow = await pool.query(
        `SELECT pv.source FROM "PageVersion" pv WHERE pv.id = $1::int LIMIT 1`,
        [row.pageVersionId]
      );
      if (pvRow.rows.length > 0 && pvRow.rows[0].source) {
        return res.json({
          revisionId: row.revisionId,
          revisionNumber: null,
          wikidotId: row.wikidotId,
          timestamp: row.timestamp,
          source: pvRow.rows[0].source
        });
      }

      return res.json({
        revisionId: row.revisionId,
        revisionNumber: null,
        wikidotId: row.wikidotId,
        timestamp: row.timestamp,
        source: null
      });
    } catch (err) {
      next(err);
    }
  });

  // GET /api/wikidot-pages/:wikidotId/source - 获取该页面可用的最佳源码（PageVersion.source 优先，其次最新有源码的修订）
  router.get('/:wikidotId/source', async (req, res, next) => {
    try {
      const { wikidotId } = req.params as Record<string, string>;
      const context = await resolvePageContextByWikidotId(wikidotId);
      if (!context) return res.status(404).json({ error: 'not_found' });
      const targetVersionId = context.effectiveVersionId ?? context.currentVersionId;
      if (!targetVersionId) return res.status(404).json({ error: 'not_found' });

      const pv = await pool.query(
        `SELECT pv.source
           FROM "PageVersion" pv
          WHERE pv.id = $1
          LIMIT 1`,
        [targetVersionId]
      );
      if (pv.rows.length === 0) return res.status(404).json({ error: 'not_found' });
      if (pv.rows[0].source) return res.json({ source: pv.rows[0].source, origin: 'pageVersion' });

      // 2) 否则回退到最新一条带源码的修订
      const lastWithSource = await pool.query(
        `SELECT r.id AS "revisionId", r."revisionNumber", r.source
         FROM "Revision" r
         WHERE r."pageVersionId" = $1::int AND r.source IS NOT NULL
         ORDER BY r.timestamp DESC
         LIMIT 1`,
        [targetVersionId]
      );
      if (lastWithSource.rows.length > 0) {
        const r = lastWithSource.rows[0];
        return res.json({ source: r.source, origin: 'revision', revisionId: r.revisionId, revisionNumber: r.revisionNumber });
      }

      // 3) 仍无则返回空
      return res.json({ source: null, origin: 'none' });
    } catch (err) {
      next(err);
    }
  });

  // GET /api/wikidot-pages/:wikidotId/recommendations
  // Similar pages by tags and/or authors, with optional diversity-aware re-ranking
  router.get('/:wikidotId/recommendations', async (req, res, next) => {
    try {
      const { wikidotId } = req.params as Record<string, string>;
      const {
        limit = '10',
        strategy = 'both', // tags | authors | both
        tagWeight: tagWeightStr = '1',
        authorWeight: authorWeightStr = '3',
        minTagOverlap: minTagOverlapStr = '1',
        minAuthorOverlap: minAuthorOverlapStr = '0',
        sameCategoryOnly: sameCategoryOnlyStr = 'false',
        excludeUserPages: excludeUserPagesStr = 'true',
        diversity: diversityStr = 'simple', // none | simple | mmr
        weighting: weightingStr = 'idf', // raw | idf
        excludeCommonTags: excludeCommonTagsStr = 'true',
        excludeTags: excludeTagsCsv = '',
        explore: exploreStr = '0', // 0..1 slight randomness after re-ranking
        mmrLambda: mmrLambdaStr = '0.8' // 0..1 tradeoff for mmr
      } = req.query as Record<string, string>;

      const limitInt = Math.max(1, parseInt(String(limit), 10) || 10);
      const candidateLimit = Math.min(100, Math.max(limitInt * 4, 20));
      const tagWeight = Number.isFinite(Number(tagWeightStr)) ? parseFloat(String(tagWeightStr)) : 1;
      const authorWeight = Number.isFinite(Number(authorWeightStr)) ? parseFloat(String(authorWeightStr)) : 3;
      const minTagOverlap = Math.max(0, parseInt(String(minTagOverlapStr), 10) || 0);
      const minAuthorOverlap = Math.max(0, parseInt(String(minAuthorOverlapStr), 10) || 0);
      const sameCategoryOnly = String(sameCategoryOnlyStr).toLowerCase() === 'true';
      const excludeUserPages = String(excludeUserPagesStr).toLowerCase() === 'true';
      const diversityParam = String(diversityStr || 'simple').toLowerCase();
      const diversity = diversityParam === 'none' ? 'none' : (diversityParam === 'mmr' ? 'mmr' : 'simple');
      const weighting = (String(weightingStr || 'idf').toLowerCase() === 'raw') ? 'raw' : 'idf';
      const excludeCommon = String(excludeCommonTagsStr).toLowerCase() !== 'false';
      const explore = Math.max(0, Math.min(1, parseFloat(String(exploreStr)) || 0));
      const mmrLambda = Math.max(0, Math.min(1, parseFloat(String(mmrLambdaStr)) || 0.8));
      const strat = String(strategy || 'both').toLowerCase();

      // 常见标签（在相似度中降权/忽略）
      const defaultCommonTags = ['原创','scp','故事','goi格式'];
      const extraExcluded = (excludeTagsCsv || '')
        .split(',')
        .map(s => s.trim())
        .filter(s => s.length > 0);
      const excludedTags = Array.from(new Set([...(excludeCommon ? defaultCommonTags : []), ...extraExcluded]));

      // 不使用 Redis 缓存（按需再启用）

      // 取候选集合（打齐标签与作者重合信息）
      const context = await resolvePageContextByWikidotId(wikidotId);
      if (!context || !context.effectiveVersionId) return res.json([]);

      const sql = `
        WITH target AS (
          SELECT 
            pv.id,
            pv."pageId",
            pv.tags,
            pv."createdAt",
            pv.category,
            (
              SELECT COALESCE(ARRAY_AGG(DISTINCT a."userId") FILTER (WHERE a."userId" IS NOT NULL), ARRAY[]::int[])
              FROM "Attribution" a
              WHERE a."pageVerId" = pv.id
            ) AS authors
          FROM "PageVersion" pv
          WHERE pv.id = $1
          LIMIT 1
        ),
        tag_freq AS (
          -- 仅统计目标页相关标签的全站出现次数，避免全表扫描
          SELECT tt.tag, COUNT(*)::int AS cnt
          FROM target t
          CROSS JOIN LATERAL UNNEST(t.tags) AS tt(tag)
          JOIN "PageVersion" pv2 
            ON pv2."validTo" IS NULL 
           AND pv2.tags @> ARRAY[tt.tag]::text[]
          GROUP BY tt.tag
        )
        SELECT 
          pv."wikidotId",
          p."currentUrl" AS url,
          pv.title,
          pv.rating,
          pv."commentCount",
          pv."voteCount",
          pv.category,
          pv.tags,
          pv."createdAt",
          pv."createdAt" AS date,
          pv."revisionCount",
          pv."attributionCount",
          ps."wilson95",
          ps."controversy",
          -- 标签重合
          (
            SELECT COUNT(*) FROM (
              SELECT UNNEST(pv.tags) AS x
              INTERSECT
              SELECT UNNEST(t.tags) AS x
            ) s
            WHERE ($5::text[] IS NULL OR NOT (s.x = ANY($5::text[])))
          ) AS tag_overlap,
          -- 基于 IDF 的加权标签重合
          (
            SELECT COALESCE(SUM(1.0 / LN(GREATEST(tf.cnt, 1) + 1)), 0.0)
            FROM (
              SELECT UNNEST(pv.tags) AS x
              INTERSECT
              SELECT UNNEST(t.tags) AS x
            ) m
            JOIN tag_freq tf ON tf.tag = m.x
            WHERE ($5::text[] IS NULL OR NOT (m.x = ANY($5::text[])))
          ) AS tag_overlap_weighted,
          -- 匹配的标签列表
          (
            SELECT COALESCE(ARRAY(
              SELECT x FROM (
                SELECT UNNEST(pv.tags) AS x
                INTERSECT
                SELECT UNNEST(t.tags) AS x
              ) q
              WHERE ($5::text[] IS NULL OR NOT (q.x = ANY($5::text[])))
            ), ARRAY[]::text[])
          ) AS matched_tags,
          -- 作者重合
          (
            SELECT COUNT(DISTINCT a2."userId")
            FROM "Attribution" a2
            WHERE a2."pageVerId" = pv.id
              AND a2."userId" = ANY(t.authors)
          ) AS author_overlap,
          -- 匹配作者详情
          (
            SELECT COALESCE(jsonb_agg(DISTINCT jsonb_build_object('userId', u2.id, 'displayName', u2."displayName", 'wikidotId', u2."wikidotId")) FILTER (WHERE u2.id IS NOT NULL), '[]'::jsonb)
            FROM "Attribution" a2
            JOIN "User" u2 ON u2.id = a2."userId"
            WHERE a2."pageVerId" = pv.id
              AND a2."userId" = ANY(t.authors)
          ) AS matched_authors,
          -- 候选页的作者完整列表（用于展示）
          (
            SELECT COALESCE(jsonb_agg(DISTINCT jsonb_build_object('userId', u3.id, 'displayName', u3."displayName", 'wikidotId', u3."wikidotId")) FILTER (WHERE u3.id IS NOT NULL), '[]'::jsonb)
            FROM "Attribution" a3
            JOIN "User" u3 ON u3.id = a3."userId"
            WHERE a3."pageVerId" = pv.id
          ) AS authors_full
        FROM "PageVersion" pv
        JOIN "Page" p ON p.id = pv."pageId"
        LEFT JOIN "PageStats" ps ON ps."pageVersionId" = pv.id
        CROSS JOIN target t
        WHERE pv."validTo" IS NULL
          AND pv."pageId" <> t."pageId"
          AND (
            -- 必须存在至少一个未被排除的标签重合，或作者重合
            EXISTS (
              SELECT 1 FROM (
                SELECT UNNEST(pv.tags) AS x
                INTERSECT
                SELECT UNNEST(t.tags) AS x
              ) s
              WHERE ($5::text[] IS NULL OR NOT (s.x = ANY($5::text[])))
            )
            OR EXISTS (
              SELECT 1 FROM "Attribution" a3
              WHERE a3."pageVerId" = pv.id
                AND a3."userId" = ANY(t.authors)
            )
          )
          AND ($3::boolean = false OR pv.category = t.category)
          AND ($4::boolean = false OR NOT (pv.tags && ARRAY['作者','段落','补充材料']::text[]))
        ORDER BY 
          tag_overlap_weighted DESC NULLS LAST,
          author_overlap DESC NULLS LAST,
          pv.rating DESC NULLS LAST, 
          pv."createdAt" DESC
        LIMIT $2::int
      `;

      const excludedTagsParam = (Array.isArray(excludedTags) && excludedTags.length > 0) ? excludedTags : null;
      const { rows } = await pool.query(sql, [context.effectiveVersionId, candidateLimit, sameCategoryOnly, excludeUserPages, excludedTagsParam]);

      // Node 层打分 + 过滤 + 多样性重排
      type Rec = any & { tag_overlap: number; tag_overlap_weighted?: number; author_overlap: number; matched_tags: string[]; matched_authors: Array<{userId:number;displayName:string|null;wikidotId:number|null}> };
      const candidates: Rec[] = rows.map((r: any) => ({
        ...r,
        tag_overlap: Number(r.tag_overlap || 0),
        tag_overlap_weighted: typeof r.tag_overlap_weighted === 'number' ? Number(r.tag_overlap_weighted) : undefined,
        author_overlap: Number(r.author_overlap || 0),
        matched_tags: Array.isArray(r.matched_tags) ? r.matched_tags : [],
        matched_authors: Array.isArray(r.matched_authors) ? r.matched_authors : []
      }));

      function passesStrategy(rec: Rec): boolean {
        if (strat === 'tags') return rec.tag_overlap >= minTagOverlap;
        if (strat === 'authors') return rec.author_overlap >= minAuthorOverlap;
        // both: 任一达到阈值即通过
        return (rec.tag_overlap >= minTagOverlap) || (rec.author_overlap >= minAuthorOverlap);
      }

      const scored = candidates
        .filter(passesStrategy)
        .map((r) => {
          const tagComponent = weighting === 'idf' ? (Number(r.tag_overlap_weighted || 0)) : r.tag_overlap;
          const score = (tagComponent * tagWeight) + (r.author_overlap * authorWeight);
          return { ...r, similarity: { score, tagOverlap: r.tag_overlap, tagWeighted: Number(r.tag_overlap_weighted || 0), authorOverlap: r.author_overlap, matchedTags: r.matched_tags, matchedAuthors: r.matched_authors } };
        })
        .sort((a, b) => {
          // 稳定排序：score desc, authorOverlap desc, tagOverlap desc, rating desc
          if (b.similarity.score !== a.similarity.score) return b.similarity.score - a.similarity.score;
          if (b.similarity.authorOverlap !== a.similarity.authorOverlap) return b.similarity.authorOverlap - a.similarity.authorOverlap;
          if (b.similarity.tagOverlap !== a.similarity.tagOverlap) return b.similarity.tagOverlap - a.similarity.tagOverlap;
          return (Number(b.rating ?? 0) - Number(a.rating ?? 0));
        });

      // 多样性重排：按“主作者”或“主标签”分簇，轮转抽取
      let finalList: any[] = [];
      if (diversity === 'simple') {
        const groups = new Map<string, any[]>();
        const order: Array<{ key: string; leadScore: number } > = [];
        for (const item of scored) {
          const matchedAuthors = Array.isArray(item.similarity.matchedAuthors) ? item.similarity.matchedAuthors : [];
          const matchedTags = Array.isArray(item.similarity.matchedTags) ? item.similarity.matchedTags : [];
          let key = 'misc';
          if (matchedAuthors.length > 0) {
            // 以最小 userId 作为簇键，稳定
            const minId = Math.min(...matchedAuthors.map((x: any) => Number(x.userId || 0)).filter((n: number) => Number.isFinite(n)));
            key = Number.isFinite(minId) ? `author:${minId}` : 'author:na';
          } else if (matchedTags.length > 0) {
            const firstTag = [...matchedTags].sort()[0];
            key = firstTag ? `tag:${firstTag}` : 'tag:na';
          }
          if (!groups.has(key)) {
            groups.set(key, []);
            order.push({ key, leadScore: item.similarity.score });
          }
          groups.get(key)!.push(item);
        }
        // 按簇的领头分数排序，保证强簇仍靠前
        order.sort((a, b) => b.leadScore - a.leadScore);
        // 轮转抽取直到达到 limit 或无更多
        while (finalList.length < limitInt) {
          let progressed = false;
          for (const { key } of order) {
            const arr = groups.get(key)!;
            if (arr && arr.length > 0) {
              finalList.push(arr.shift());
              progressed = true;
              if (finalList.length >= limitInt) break;
            }
          }
          if (!progressed) break; // 所有组都空了
        }
      } else if (diversity === 'mmr') {
        // Maximum Marginal Relevance 选取
        const normalize = (v: number, min: number, max: number) => {
          if (!Number.isFinite(v)) return 0;
          if (max <= min) return 0;
          return (v - min) / (max - min);
        };
        const scores = scored.map(s => s.similarity.score);
        const minScore = Math.min(...scores, 0);
        const maxScore = Math.max(...scores, 1);
        const excludedSet = new Set<string>(excludedTags);
        const tagSet = (arr: string[] | null | undefined) => {
          const s = new Set<string>();
          for (const t of Array.isArray(arr) ? arr : []) {
            if (!excludedSet.has(String(t))) s.add(String(t));
          }
          return s;
        };
        const authorSet = (arr: Array<{ userId: number }>) => new Set<number>((Array.isArray(arr) ? arr : []).map(a => Number(a.userId)).filter(n => Number.isFinite(n)));
        const jaccard = <T>(a: Set<T>, b: Set<T>) => {
          if (a.size === 0 && b.size === 0) return 0;
          let inter = 0;
          for (const x of a) if (b.has(x)) inter += 1;
          const uni = a.size + b.size - inter;
          return uni > 0 ? inter / uni : 0;
        };
        const simAB = (x: any, y: any) => {
          const xt = tagSet(x.tags);
          const yt = tagSet(y.tags);
          const xa = authorSet(x.authors_full || []);
          const ya = authorSet(y.authors_full || []);
          const tagSim = jaccard(xt, yt);
          let interA = 0;
          for (const u of xa) if (ya.has(u)) interA += 1;
          const authorSim = Math.min(1, interA);
          return 0.7 * tagSim + 0.3 * authorSim;
        };
        const selected: any[] = [];
        const remaining = [...scored];
        while (selected.length < limitInt && remaining.length > 0) {
          let bestIdx = 0;
          let bestScore = -Infinity;
          for (let i = 0; i < remaining.length; i++) {
            const cand = remaining[i];
            const rel = normalize(cand.similarity.score, minScore, maxScore);
            let div = 0;
            for (const s of selected) {
              div = Math.max(div, simAB(cand, s));
            }
            const mmr = mmrLambda * rel - (1 - mmrLambda) * div;
            if (mmr > bestScore) { bestScore = mmr; bestIdx = i; }
          }
          const picked = remaining.splice(bestIdx, 1)[0];
          selected.push(picked);
        }
        finalList = selected;
      } else {
        finalList = scored.slice(0, limitInt);
      }

      // 探索：轻度随机打乱相邻元素，避免列表过于稳定
      if (explore > 0 && finalList.length > 1) {
        const swaps = Math.floor(explore * finalList.length);
        for (let i = 0; i < swaps; i++) {
          const a = Math.floor(Math.random() * finalList.length);
          const b = Math.min(finalList.length - 1, Math.max(0, a + (Math.random() < 0.5 ? -1 : 1)));
          if (a !== b) {
            const tmp = finalList[a];
            finalList[a] = finalList[b];
            finalList[b] = tmp;
          }
        }
      }

      // 输出：去掉中间计算字段，保留 similarity
      const payload = finalList.map(({ tag_overlap, tag_overlap_weighted, author_overlap, matched_tags, matched_authors, ...rest }) => rest);
      res.json(payload);
    } catch (err) {
      next(err);
    }
  });

  // GET /api/wikidot-pages/:wikidotId/ratings/cumulative
  router.get('/:wikidotId/ratings/cumulative', async (req, res, next) => {
    try {
      const { wikidotId } = req.params as Record<string, string>;
      const context = await resolvePageContextByWikidotId(wikidotId);
      if (!context || !context.effectiveVersionId) return res.json([]);
      const sql = `
        WITH daily AS (
          SELECT date_trunc('day', v.timestamp) AS day, SUM(v.direction) AS delta
          FROM "Vote" v
          WHERE v."pageVersionId" = $1
          GROUP BY 1
        )
        SELECT day::timestamptz AS date,
               SUM(delta) OVER (ORDER BY day ASC ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS "cumulativeRating"
        FROM daily
        ORDER BY day ASC
      `;
      const { rows } = await pool.query(sql, [context.effectiveVersionId]);
      res.json(rows);
    } catch (err) {
      next(err);
    }
  });

  // GET /pages/{wikidotId}/attributions
  router.get('/:wikidotId/attributions', async (req, res, next) => {
    try {
      const { wikidotId } = req.params;
      const context = await resolvePageContextByWikidotId(wikidotId);
      if (!context || !context.effectiveVersionId) return res.json([]);
      const sql = `
        SELECT 
          a.type,
          a."order",
          a.date,
          a."userId",
          u."displayName",
          u."wikidotId" as "userWikidotId"
        FROM "Attribution" a
        LEFT JOIN "User" u ON a."userId" = u.id
        WHERE a."pageVerId" = $1
        ORDER BY a.type, a."order"
      `;
      const { rows } = await pool.query(sql, [context.effectiveVersionId]);
      res.json(rows);
    } catch (err) {
      next(err);
    }
  });

  // GET /pages/{wikidotId}/vote-distribution
  router.get('/:wikidotId/vote-distribution', async (req, res, next) => {
    try {
      const { wikidotId } = req.params;
      const context = await resolvePageContextByWikidotId(wikidotId);
      if (!context || !context.effectiveVersionId) return res.json({ upvotes: 0, downvotes: 0, novotes: 0, total: 0 });
      const sql = `
        SELECT 
          COUNT(CASE WHEN v.direction = 1 THEN 1 END) as upvotes,
          COUNT(CASE WHEN v.direction = -1 THEN 1 END) as downvotes,
          COUNT(CASE WHEN v.direction = 0 THEN 1 END) as novotes,
          COUNT(*) as total
        FROM "Vote" v
        WHERE v."pageVersionId" = $1
      `;
      const { rows } = await pool.query(sql, [context.effectiveVersionId]);
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
      const context = await resolvePageContextByWikidotId(wikidotId);
      if (!context || !context.pageId) return res.status(404).json({ error: 'not_found' });
      const pageId = context.pageId;
      
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
      const context = await resolvePageContextByWikidotId(wikidotIdInt);
      if (!context || !context.pageId) return res.json([]);
      
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
          WHERE pv."pageId" = $1
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
      const { rows } = await pool.query(sql, [context.pageId]);
      
      // 直接返回数据，前端会处理隐藏逻辑
      res.json(rows);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
