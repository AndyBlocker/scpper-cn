import { Router } from 'express';
import type { Pool } from 'pg';
import type { RedisClientType } from 'redis';
import { extractPreviewCandidates, pickPreview, toPreviewPick, extractExcerptFallback } from '../utils/preview.js';

export function usersRouter(pool: Pool, _redis: RedisClientType | null) {
  const router = Router();

  // GET /users/by-rank?category=overall|scp|story|goi|translation|wanderers|art
  router.get('/by-rank', async (req, res, next) => {
    try {
      const { limit = '20', offset = '0', category = 'overall', sortBy = 'rank', sortDir } = req.query as Record<string, string>;
      const categoryMap: Record<string, { rank: string; rating: string }> = {
        overall: { rank: 'overallRank', rating: 'overallRating' },
        scp: { rank: 'scpRank', rating: 'scpRating' },
        story: { rank: 'storyRank', rating: 'storyRating' },
        goi: { rank: 'goiRank', rating: 'goiRating' },
        translation: { rank: 'translationRank', rating: 'translationRating' },
        wanderers: { rank: 'wanderersRank', rating: 'wanderersRating' },
        art: { rank: 'artRank', rating: 'artRating' },
      };
      const fields = categoryMap[category] || categoryMap.overall;
      const countField = fields.rank === 'overallRank'
        ? 'pageCount'
        : fields.rank === 'scpRank' ? 'scpPageCount'
        : fields.rank === 'storyRank' ? 'storyPageCount'
        : fields.rank === 'goiRank' ? 'goiPageCount'
        : fields.rank === 'translationRank' ? 'translationPageCount'
        : fields.rank === 'wanderersRank' ? 'wanderersPageCount'
        : fields.rank === 'artRank' ? 'artPageCount'
        : 'pageCount';

      // Determine ORDER BY clause safely via whitelist
      const sort = (sortBy || 'rank').toLowerCase();
      const dir = (sortDir && sortDir.toLowerCase() === 'desc') ? 'DESC' : (sort === 'rank' ? 'ASC' : 'DESC');
      const orderMapping: Record<string, string> = {
        rank: 'rank',
        rating: 'rating',
        count: '"catCount"',
        mean: '"catMean"',
        up: '"totalUp"',
        down: '"totalDown"',
        name: 'u."displayName"'
      };
      const orderExpr = orderMapping[sort] || 'rank';

      const listSql = `
        SELECT 
          u.id, 
          u."displayName", 
          u."wikidotId", 
          us."${fields.rank}" AS rank, 
          us."${fields.rating}" AS rating,
          us."pageCount" AS "pageCount",
          us."totalRating" AS "totalRating",
          CASE 
            WHEN COALESCE(us."pageCount", 0) > 0 THEN (COALESCE(us."totalRating", 0))::float / NULLIF(us."pageCount", 0)::float
            ELSE 0::float
          END AS "meanRating",
          us."totalUp" AS "totalUp",
          us."totalDown" AS "totalDown",
          us."favTag" AS "favTag",
          us."scpPageCount" AS "scpPageCount",
          us."storyPageCount" AS "storyPageCount",
          us."goiPageCount" AS "goiPageCount",
          us."translationPageCount" AS "translationPageCount",
          us."wanderersPageCount" AS "wanderersPageCount",
          us."artPageCount" AS "artPageCount",
          us."ratingUpdatedAt" AS "ratingUpdatedAt",
          us."${countField}" AS "catCount",
          CASE WHEN COALESCE(us."${countField}", 0) > 0 THEN (COALESCE(us."${fields.rating}", 0))::float / NULLIF(us."${countField}", 0)::float ELSE 0::float END AS "catMean"
        FROM "User" u
        JOIN "UserStats" us ON us."userId" = u.id
        WHERE us."${fields.rank}" IS NOT NULL
        ORDER BY ${orderExpr} ${dir}, us."${fields.rank}" ASC
        LIMIT $1::int OFFSET $2::int
      `;
      const countSql = `
        SELECT COUNT(*)::int AS total
        FROM "UserStats" us
        WHERE us."${fields.rank}" IS NOT NULL
      `;
      const [{ rows: list }, { rows: countRows }] = await Promise.all([
        pool.query(listSql, [limit, offset]),
        pool.query(countSql)
      ]);
      const total = (countRows[0]?.total as number) || 0;
      res.json({ total, items: list });
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

      // Enrich with last activity details (latest of vote or revision)
      const lastActivitySql = `
        WITH last_vote AS (
          SELECT 
            v.timestamp,
            'VOTE'::text AS type,
            pv."wikidotId" AS "pageWikidotId",
            pv.title AS "pageTitle",
            pv."alternateTitle" AS "pageAlternateTitle",
            v.direction AS direction,
            NULL::text AS "revisionType",
            NULL::text AS comment
          FROM "Vote" v
          JOIN "PageVersion" pv ON v."pageVersionId" = pv.id
          JOIN "User" u ON v."userId" = u.id
          WHERE u."wikidotId" = $1 AND pv."validTo" IS NULL AND pv."isDeleted" = false
          ORDER BY v.timestamp DESC
          LIMIT 1
        ),
        last_rev AS (
          SELECT 
            r.timestamp,
            'REVISION'::text AS type,
            pv."wikidotId" AS "pageWikidotId",
            pv.title AS "pageTitle",
            pv."alternateTitle" AS "pageAlternateTitle",
            NULL::int AS direction,
            r.type::text AS "revisionType",
            r.comment::text AS comment
          FROM "Revision" r
          JOIN "PageVersion" pv ON r."pageVersionId" = pv.id
          JOIN "User" u ON r."userId" = u.id
          WHERE u."wikidotId" = $1 AND pv."validTo" IS NULL AND pv."isDeleted" = false
          ORDER BY r.timestamp DESC
          LIMIT 1
        )
        SELECT * FROM (
          SELECT * FROM last_vote
          UNION ALL
          SELECT * FROM last_rev
        ) t
        ORDER BY timestamp DESC
        LIMIT 1
      `;

      // Enrich with first activity details (earliest of vote or revision)
      const firstActivitySql = `
        WITH first_vote AS (
          SELECT 
            v.timestamp,
            'VOTE'::text AS type,
            pv."wikidotId" AS "pageWikidotId",
            pv.title AS "pageTitle",
            pv."alternateTitle" AS "pageAlternateTitle",
            v.direction AS direction,
            NULL::text AS "revisionType",
            NULL::text AS comment
          FROM "Vote" v
          JOIN "PageVersion" pv ON v."pageVersionId" = pv.id
          JOIN "User" u ON v."userId" = u.id
          WHERE u."wikidotId" = $1 AND pv."validTo" IS NULL AND pv."isDeleted" = false
          ORDER BY v.timestamp ASC
          LIMIT 1
        ),
        first_rev AS (
          SELECT 
            r.timestamp,
            'REVISION'::text AS type,
            pv."wikidotId" AS "pageWikidotId",
            pv.title AS "pageTitle",
            pv."alternateTitle" AS "pageAlternateTitle",
            NULL::int AS direction,
            r.type::text AS "revisionType",
            r.comment::text AS comment
          FROM "Revision" r
          JOIN "PageVersion" pv ON r."pageVersionId" = pv.id
          JOIN "User" u ON r."userId" = u.id
          WHERE u."wikidotId" = $1 AND pv."validTo" IS NULL AND pv."isDeleted" = false
          ORDER BY r.timestamp ASC
          LIMIT 1
        )
        SELECT * FROM (
          SELECT * FROM first_vote
          UNION ALL
          SELECT * FROM first_rev
        ) t
        ORDER BY timestamp ASC
        LIMIT 1
      `;

      let payload: any = rows[0];
      try {
        const [laRes, faRes] = await Promise.all([
          pool.query(lastActivitySql, [wikidotIdInt]),
          pool.query(firstActivitySql, [wikidotIdInt])
        ]);
        const la = laRes.rows[0];
        const fa = faRes.rows[0];
        if (la) {
          payload = {
            ...payload,
            lastActivityType: la.type,
            lastActivityPageWikidotId: la.pageWikidotId,
            lastActivityPageTitle: la.pageTitle,
            lastActivityDirection: la.direction,
            lastActivityRevisionType: la.revisionType,
            lastActivityComment: la.comment,
          };
        }
        if (fa) {
          payload = {
            ...payload,
            firstActivityPageWikidotId: fa.pageWikidotId,
            firstActivityPageTitle: fa.pageTitle,
            firstActivityDirection: fa.direction,
            firstActivityRevisionType: fa.revisionType,
            firstActivityComment: fa.comment,
          };
        }
      } catch (e) {
        // best-effort enrichment; ignore errors and return base payload
      }

      res.json(payload);
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
      const { tab = 'all', limit = '20', offset = '0', includeDeleted = 'true', sortBy = 'date', sortDir } = req.query as Record<string, string>;

      // Build tab-specific filters
      const excludedCats = ['log-of-anomalous-items-cn', 'short-stories'];
      const tabLower = String(tab).toLowerCase();
      let tabCond = '';
      const params: any[] = [wikidotIdInt, includeDeleted === 'true'];
      switch (tabLower) {
        case 'author':
          tabCond = ` AND a.type IN ('AUTHOR','SUBMITTER')
                      AND ('原创' = ANY(COALESCE(effective_pv.tags, ARRAY[]::text[])))
                      AND NOT ('掩盖页' = ANY(COALESCE(effective_pv.tags, ARRAY[]::text[])))
                      AND NOT ('段落' = ANY(COALESCE(effective_pv.tags, ARRAY[]::text[])))
                      AND NOT (effective_pv.category = ANY($3::text[]))`;
          params.push(excludedCats);
          break;
        case 'translator':
          tabCond = ` AND NOT ('原创' = ANY(COALESCE(effective_pv.tags, ARRAY[]::text[])))
                      AND NOT ('作者' = ANY(COALESCE(effective_pv.tags, ARRAY[]::text[])))
                      AND NOT ('掩盖页' = ANY(COALESCE(effective_pv.tags, ARRAY[]::text[])))
                      AND NOT ('段落' = ANY(COALESCE(effective_pv.tags, ARRAY[]::text[])))
                      AND NOT (effective_pv.category = ANY($3::text[]))`;
          params.push(excludedCats);
          break;
        case 'other':
          tabCond = ` AND (('作者' = ANY(COALESCE(effective_pv.tags, ARRAY[]::text[])))
                        OR ('掩盖页' = ANY(COALESCE(effective_pv.tags, ARRAY[]::text[])))
                        OR ('段落' = ANY(COALESCE(effective_pv.tags, ARRAY[]::text[]))))
                      AND NOT (effective_pv.category = ANY($3::text[]))`;
          params.push(excludedCats);
          break;
        case 'short_stories':
          tabCond = ` AND effective_pv.category = $3::text`;
          params.push('short-stories');
          break;
        case 'anomalous_log':
          tabCond = ` AND effective_pv.category = $3::text`;
          params.push('log-of-anomalous-items-cn');
          break;
        case 'all':
        default:
          tabCond = '';
          break;
      }

      // Server-side sorting
      const sort = String(sortBy || 'date').toLowerCase();
      const dir = (String(sortDir || '').toLowerCase() === 'asc') ? 'ASC' : 'DESC';
      const orderExpr = (sort === 'rating') ? 't.rating' : 't."createdAt"';

      const sql = `
        SELECT * FROM (
          SELECT DISTINCT ON (pv."pageId")
            COALESCE(pv."wikidotId", p."wikidotId") AS "wikidotId",
            p."currentUrl" AS url,
            COALESCE(effective_pv.title, live_pv.title, pv.title) AS title,
            COALESCE(effective_pv."alternateTitle", live_pv."alternateTitle", pv."alternateTitle") AS "alternateTitle",
            COALESCE(effective_pv.category, pv.category) AS category,
            COALESCE(effective_pv.rating, pv.rating) AS rating,
            COALESCE(effective_pv.tags, pv.tags) AS tags,
            COALESCE(effective_pv."voteCount", pv."voteCount") AS "voteCount",
            COALESCE(effective_pv."commentCount", pv."commentCount") AS "commentCount",
            SUBSTRING(COALESCE(effective_pv."textContent", pv."textContent") FOR 2000) AS "textSnippet",
            COALESCE(effective_pv.source, pv.source) AS source,
            -- Effective created date for this user and page with priority:
            -- (AUTHOR/SUBMITTER -> PAGE_CREATED) else -> earliest attribution date
            -- else -> earliest revision by this user
            -- fallback -> PAGE_CREATED
            COALESCE(
              CASE WHEN EXISTS (
                SELECT 1
                FROM "Attribution" aa
                JOIN "PageVersion" pvx ON aa."pageVerId" = pvx.id
                WHERE pvx."pageId" = pv."pageId" AND aa."userId" = u.id AND aa.type IN ('AUTHOR','SUBMITTER')
              ) THEN (
                SELECT MIN(r2.timestamp)
                FROM "Revision" r2
                JOIN "PageVersion" pva ON r2."pageVersionId" = pva.id
                WHERE pva."pageId" = pv."pageId" AND r2.type = 'PAGE_CREATED'
              ) ELSE NULL END,
              (
                SELECT MIN(a2.date)
                FROM "Attribution" a2
                JOIN "PageVersion" pvA ON a2."pageVerId" = pvA.id
                WHERE pvA."pageId" = pv."pageId" AND a2."userId" = u.id AND a2.date IS NOT NULL
              ),
              (
                SELECT MIN(r.timestamp)
                FROM "Revision" r
                JOIN "PageVersion" pvR ON r."pageVersionId" = pvR.id
                WHERE pvR."pageId" = pv."pageId" AND r."userId" = u.id
              ),
              (
                SELECT MIN(r3.timestamp)
                FROM "Revision" r3
                JOIN "PageVersion" pv3 ON r3."pageVersionId" = pv3.id
                WHERE pv3."pageId" = pv."pageId" AND r3.type = 'PAGE_CREATED'
              )
            ) AS "createdAt",
            pv."revisionCount",
            ps."wilson95",
            ps."controversy",
            COALESCE(p."isDeleted", COALESCE(latest."isDeleted", false)) AS "isDeleted",
            CASE 
              WHEN COALESCE(p."isDeleted", COALESCE(latest."isDeleted", false)) THEN COALESCE(latest."deletedAt", pv."validTo") 
              ELSE NULL 
            END AS "deletedAt",
            -- Server-side group classification used by frontend tabs (effective version)
            CASE 
              WHEN effective_pv.category = 'short-stories' THEN 'short_stories'
              WHEN effective_pv.category = 'log-of-anomalous-items-cn' THEN 'anomalous_log'
              WHEN ('作者' = ANY(COALESCE(effective_pv.tags, ARRAY[]::text[])))
                OR ('掩盖页' = ANY(COALESCE(effective_pv.tags, ARRAY[]::text[])))
                OR ('段落' = ANY(COALESCE(effective_pv.tags, ARRAY[]::text[]))) THEN 'other'
              WHEN ('原创' = ANY(COALESCE(effective_pv.tags, ARRAY[]::text[]))) THEN 'author'
              ELSE 'translator'
            END AS "groupKey"
          FROM "Attribution" a
          JOIN "PageVersion" pv ON pv.id = a."pageVerId"
          JOIN "Page" p ON p.id = pv."pageId"
          LEFT JOIN LATERAL (
            SELECT pv2.id, pv2.title, pv2."alternateTitle", pv2.category, pv2.rating, pv2.tags, pv2."voteCount", pv2."commentCount", pv2."textContent", pv2.source
            FROM "PageVersion" pv2
            WHERE pv2."pageId" = pv."pageId" AND pv2."isDeleted" = false
            ORDER BY (pv2."validTo" IS NULL) DESC, pv2."validFrom" DESC NULLS LAST, pv2.id DESC
            LIMIT 1
          ) effective_pv ON TRUE
          -- Current (live) snapshot for robust display fallback fields (no effect on inclusion)
          LEFT JOIN LATERAL (
            SELECT pv2.id, pv2.title, pv2."alternateTitle"
            FROM "PageVersion" pv2
            WHERE pv2."pageId" = pv."pageId" AND pv2."validTo" IS NULL
            ORDER BY pv2.id DESC
            LIMIT 1
          ) live_pv ON TRUE
          LEFT JOIN "PageStats" ps ON ps."pageVersionId" = effective_pv.id
          JOIN "User" u ON a."userId" = u.id
          LEFT JOIN LATERAL (
            SELECT pv2."isDeleted" AS "isDeleted", pv2."validFrom" AS "deletedAt"
            FROM "PageVersion" pv2
            WHERE pv2."pageId" = pv."pageId" AND pv2."validTo" IS NULL
            ORDER BY pv2.id DESC
            LIMIT 1
          ) latest ON TRUE
          WHERE u."wikidotId" = $1
            AND a."pageVerId" = effective_pv.id
            AND (
              $2::boolean = true
              OR COALESCE(p."isDeleted", COALESCE(latest."isDeleted", false)) = false
            )
            ${tabCond}
          ORDER BY pv."pageId", pv."createdAt" DESC
        ) t
        ORDER BY ${orderExpr} ${dir}, t."createdAt" DESC, t.rating DESC
        LIMIT $${params.length + 1}::int OFFSET $${params.length + 2}::int
      `;
      params.push(limit, offset);
      const { rows } = await pool.query(sql, params);
      // Inject preview snippet when present; otherwise fallback to excerpt extracted from textSnippet
      const items = rows.map((r: any) => {
        const previews = extractPreviewCandidates(r?.source || null);
        let snippetHtml: string | null = null;
        if (previews && previews.length > 0) {
          const picked = pickPreview(previews);
          if (picked) snippetHtml = toPreviewPick(picked).html;
        }
        if (!snippetHtml) {
          const ex = extractExcerptFallback(r?.textSnippet || null, 150);
          if (ex) snippetHtml = toPreviewPick(ex).html;
        }
        const { source, textSnippet, ...rest } = r;
        return snippetHtml ? { ...rest, snippet: snippetHtml } : rest;
      });
      res.json(items);
    } catch (err) {
      next(err);
    }
  });

  // GET /api/users/:wikidotId/page-counts
  // Returns precise counts for tabs used on the user page
  router.get('/:wikidotId/page-counts', async (req, res, next) => {
    try {
      const { wikidotId } = req.params as Record<string, string>;
      const wikidotIdInt = parseInt(wikidotId, 10);
      if (isNaN(wikidotIdInt)) {
        return res.status(400).json({ error: 'Invalid wikidotId' });
      }
      const { includeDeleted = 'true' } = req.query as Record<string, string>;
      const sql = `
        WITH latest_user_pages AS (
          SELECT DISTINCT ON (p."wikidotId")
            p."wikidotId" AS "wikidotId",
            effective_pv.tags AS tags,
            effective_pv.category AS category,
            effective_pv."validTo" AS "validTo",
            COALESCE(p."isDeleted", COALESCE(latest."isDeleted", false)) AS is_deleted
          FROM "Attribution" a
          JOIN "User" u ON a."userId" = u.id
          JOIN "PageVersion" pv ON pv.id = a."pageVerId"
          JOIN "Page" p ON p.id = pv."pageId"
          LEFT JOIN LATERAL (
            SELECT pv2.id AS id, pv2.tags, pv2.category, pv2."validTo", pv2."validFrom"
            FROM "PageVersion" pv2
            WHERE pv2."pageId" = p.id AND pv2."isDeleted" = false
            ORDER BY (pv2."validTo" IS NULL) DESC, pv2."validFrom" DESC NULLS LAST, pv2.id DESC
            LIMIT 1
          ) effective_pv ON TRUE
          LEFT JOIN LATERAL (
            SELECT pv2."isDeleted" AS "isDeleted"
            FROM "PageVersion" pv2
            WHERE pv2."pageId" = p.id AND pv2."validTo" IS NULL
            ORDER BY pv2.id DESC
            LIMIT 1
          ) latest ON TRUE
          WHERE u."wikidotId" = $1
            AND a."pageVerId" = effective_pv.id
          ORDER BY p."wikidotId", effective_pv.id DESC
        )
        SELECT 
          COUNT(*) AS total,
          COUNT(*) FILTER (
            WHERE ('原创' = ANY(COALESCE(tags, ARRAY[]::text[])))
              AND NOT ('掩盖页' = ANY(COALESCE(tags, ARRAY[]::text[])))
              AND NOT ('段落' = ANY(COALESCE(tags, ARRAY[]::text[])))
              AND NOT (category IN ('log-of-anomalous-items-cn','short-stories'))
          ) AS original,
          COUNT(*) FILTER (
            WHERE NOT ('原创' = ANY(COALESCE(tags, ARRAY[]::text[])))
              AND NOT ('作者' = ANY(COALESCE(tags, ARRAY[]::text[])))
              AND NOT ('掩盖页' = ANY(COALESCE(tags, ARRAY[]::text[])))
              AND NOT ('段落' = ANY(COALESCE(tags, ARRAY[]::text[])))
              AND NOT (category IN ('log-of-anomalous-items-cn','short-stories'))
          ) AS translation,
          COUNT(*) FILTER (
            WHERE category = 'short-stories'
          ) AS "shortStories",
          COUNT(*) FILTER (
            WHERE category = 'log-of-anomalous-items-cn'
          ) AS "anomalousLog",
          COUNT(*) FILTER (
            WHERE ('作者' = ANY(COALESCE(tags, ARRAY[]::text[])))
               OR ('掩盖页' = ANY(COALESCE(tags, ARRAY[]::text[])))
               OR ('段落' = ANY(COALESCE(tags, ARRAY[]::text[])))
               AND NOT (category IN ('log-of-anomalous-items-cn','short-stories'))
          ) AS other
        FROM latest_user_pages
        WHERE (
          $2::boolean = true
          OR COALESCE(is_deleted, false) = false
        )
      `;
      const { rows } = await pool.query(sql, [wikidotIdInt, includeDeleted === 'true']);
      const row = rows[0] || { total: 0, original: 0, translation: 0, shortStories: 0, anomalousLog: 0, other: 0 };
      res.json({
        total: Number(row.total || 0),
        original: Number(row.original || 0),
        translation: Number(row.translation || 0),
        shortStories: Number(row.shortStories || 0),
        anomalousLog: Number(row.anomalousLog || 0),
        other: Number(row.other || 0)
      });
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
      const limitInt = Math.max(1, Math.min(parseInt(limit, 10) || 50, 200));
      const offsetInt = Math.max(0, parseInt(offset, 10) || 0);
      const sql = `
        SELECT 
          v.timestamp,
          v.direction,
          pv."wikidotId" as "pageWikidotId",
          pv.title as "pageTitle",
          pv."alternateTitle" as "pageAlternateTitle",
          p."currentUrl" as "pageUrl"
        FROM "Vote" v
        JOIN "PageVersion" pv ON v."pageVersionId" = pv.id
        JOIN "Page" p ON pv."pageId" = p.id
        JOIN "User" u ON v."userId" = u.id
        WHERE u."wikidotId" = $1
          AND pv."validTo" IS NULL AND pv."isDeleted" = false
        ORDER BY v.timestamp DESC
        LIMIT $2::int OFFSET $3::int
      `;
      const countSql = `
        SELECT COUNT(*)::int AS total
        FROM "Vote" v
        JOIN "PageVersion" pv ON v."pageVersionId" = pv.id
        JOIN "User" u ON v."userId" = u.id
        WHERE u."wikidotId" = $1
          AND pv."validTo" IS NULL
          AND pv."isDeleted" = false
      `;
      const [listRes, countRes] = await Promise.all([
        pool.query(sql, [wikidotIdInt, limitInt, offsetInt]),
        pool.query(countSql, [wikidotIdInt])
      ]);
      const total = Number(countRes.rows?.[0]?.total || 0);
      res.json({
        items: listRes.rows,
        total,
        limit: limitInt,
        offset: offsetInt
      });
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
      const limitInt = Math.max(1, Math.min(parseInt(limit, 10) || 50, 200));
      const offsetInt = Math.max(0, parseInt(offset, 10) || 0);
      const sql = `
        SELECT 
          r.timestamp,
          r.type,
          r.comment,
          pv."wikidotId" as "pageWikidotId",
          pv.title as "pageTitle",
          pv."alternateTitle" as "pageAlternateTitle",
          p."currentUrl" as "pageUrl"
        FROM "Revision" r
        JOIN "PageVersion" pv ON r."pageVersionId" = pv.id
        JOIN "Page" p ON pv."pageId" = p.id
        JOIN "User" u ON r."userId" = u.id
        WHERE u."wikidotId" = $1
          AND pv."validTo" IS NULL AND pv."isDeleted" = false
        ORDER BY r.timestamp DESC
        LIMIT $2::int OFFSET $3::int
      `;
      const countSql = `
        SELECT COUNT(*)::int AS total
        FROM "Revision" r
        JOIN "PageVersion" pv ON r."pageVersionId" = pv.id
        JOIN "User" u ON r."userId" = u.id
        WHERE u."wikidotId" = $1
          AND pv."validTo" IS NULL
          AND pv."isDeleted" = false
      `;
      const [listRes, countRes] = await Promise.all([
        pool.query(sql, [wikidotIdInt, limitInt, offsetInt]),
        pool.query(countSql, [wikidotIdInt])
      ]);
      const total = Number(countRes.rows?.[0]?.total || 0);
      res.json({
        items: listRes.rows,
        total,
        limit: limitInt,
        offset: offsetInt
      });
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
          WHERE u."wikidotId" = $1 AND pv."validTo" IS NULL AND pv."isDeleted" = false
        ),
        user_related_pages AS (
          -- 包含该用户的所有归属类型，用于页面标记（按优先级推断标记日期）
          SELECT DISTINCT ON (pv."wikidotId")
                 pv."wikidotId",
                 pv.title,
                 pv."alternateTitle",
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
          WHERE u."wikidotId" = $1 AND pv."validTo" IS NULL AND pv."isDeleted" = false
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
            AND pv."validTo" IS NULL AND pv."isDeleted" = false
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

  // GET /api/users/:wikidotId/relations/users?direction=targets|sources&polarity=liker|hater&limit=&offset=
  // direction: targets -> 我喜欢谁 (我投给谁)；sources -> 谁喜欢我 (谁投给我)
  // Returns aggregated author interactions with liker/hater sorting
  router.get('/:wikidotId/relations/users', async (req, res, next) => {
    try {
      const { wikidotId } = req.params as Record<string, string>;
      const wikidotIdInt = parseInt(wikidotId, 10);
      if (isNaN(wikidotIdInt)) {
        return res.status(400).json({ error: 'Invalid wikidotId' });
      }
      const { polarity = 'liker', direction = 'targets', limit = '20', offset = '0' } = req.query as Record<string, string>;

      const dirInput = String(direction || 'targets').toLowerCase();
      const dir = ['sources', 'source', 'from', 'incoming'].includes(dirInput) ? 'sources' : 'targets';
      const polInput = String(polarity || 'liker').toLowerCase();
      const isHater = ['hater', 'haters', 'hate', 'down', 'dv', 'negative'].includes(polInput);
      const orderClause = isHater
        ? 'uvi."downvoteCount" DESC, uvi."upvoteCount" ASC, uvi."totalVotes" DESC, uvi."lastVoteAt" DESC NULLS LAST'
        : 'uvi."upvoteCount" DESC, uvi."downvoteCount" ASC, uvi."totalVotes" DESC, uvi."lastVoteAt" DESC NULLS LAST';

      let sql: string;
      if (dir === 'sources') {
        // 谁喜欢我：others -> me
        sql = `
          SELECT 
            uvi."fromUserId" AS "userId",
            uFromSrc."displayName",
            uFromSrc."wikidotId",
            uvi."upvoteCount",
            uvi."downvoteCount",
            uvi."totalVotes",
            uvi."lastVoteAt",
            uvi."upvoteCount" AS uv,
            uvi."downvoteCount" AS dv,
            JSON_BUILD_ARRAY(uvi."upvoteCount", uvi."downvoteCount") AS pair
          FROM "UserVoteInteraction" uvi
          JOIN "User" uMe ON uMe."wikidotId" = $1
          JOIN "User" uFromSrc ON uFromSrc.id = uvi."fromUserId"
          WHERE uvi."toUserId" = uMe.id
          ORDER BY ${orderClause}
          LIMIT $2::int OFFSET $3::int
        `;
      } else {
        // 我喜欢谁：me -> others
        sql = `
          SELECT 
            uvi."toUserId" AS "userId",
            uTo."displayName",
            uTo."wikidotId",
            uvi."upvoteCount",
            uvi."downvoteCount",
            uvi."totalVotes",
            uvi."lastVoteAt",
            uvi."upvoteCount" AS uv,
            uvi."downvoteCount" AS dv,
            JSON_BUILD_ARRAY(uvi."upvoteCount", uvi."downvoteCount") AS pair
          FROM "UserVoteInteraction" uvi
          JOIN "User" uMe ON uMe."wikidotId" = $1
          JOIN "User" uTo ON uTo.id = uvi."toUserId"
          WHERE uvi."fromUserId" = uMe.id
          ORDER BY ${orderClause}
          LIMIT $2::int OFFSET $3::int
        `;
      }
      const { rows } = await pool.query(sql, [wikidotIdInt, limit, offset]);
      res.json(rows);
    } catch (err) {
      next(err);
    }
  });

  // GET /api/users/:wikidotId/relations/tags?polarity=liker|hater&limit=&offset=
  // Returns tags that the given user has voted on (aggregated by tag), sorted by liker/hater rules
  router.get('/:wikidotId/relations/tags', async (req, res, next) => {
    try {
      const { wikidotId } = req.params as Record<string, string>;
      const wikidotIdInt = parseInt(wikidotId, 10);
      if (isNaN(wikidotIdInt)) {
        return res.status(400).json({ error: 'Invalid wikidotId' });
      }
      const { polarity = 'liker', limit = '20', offset = '0' } = req.query as Record<string, string>;

      const polInput = String(polarity || 'liker').toLowerCase();
      const isHater = ['hater', 'haters', 'hate', 'down', 'dv', 'negative'].includes(polInput);
      const orderClause = isHater
        ? 'utp."downvoteCount" DESC, utp."upvoteCount" ASC, utp."totalVotes" DESC, utp."lastVoteAt" DESC NULLS LAST'
        : 'utp."upvoteCount" DESC, utp."downvoteCount" ASC, utp."totalVotes" DESC, utp."lastVoteAt" DESC NULLS LAST';

      const sql = `
        SELECT 
          utp.tag,
          utp."upvoteCount",
          utp."downvoteCount",
          utp."totalVotes",
          utp."lastVoteAt",
          utp."upvoteCount" AS uv,
          utp."downvoteCount" AS dv,
          JSON_BUILD_ARRAY(utp."upvoteCount", utp."downvoteCount") AS pair
        FROM "UserTagPreference" utp
        JOIN "User" u ON u.id = utp."userId"
        WHERE u."wikidotId" = $1
          AND utp."tag" <> '原创'
        ORDER BY ${orderClause}
        LIMIT $2::int OFFSET $3::int
      `;
      const { rows } = await pool.query(sql, [wikidotIdInt, limit, offset]);
      res.json(rows);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
