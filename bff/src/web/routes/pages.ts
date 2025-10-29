import { Router } from 'express';
import type { Pool } from 'pg';
import type { RedisClientType } from 'redis';
import { extractPreviewCandidates, pickPreview, toPreviewPick, extractExcerptFallback } from '../utils/preview.js';
import { buildPageImagePath } from '../pageImagesConfig.js';

export function pagesRouter(pool: Pool, _redis: RedisClientType | null) {
  const router = Router();

  router.get('/vote-status', async (req, res, next) => {
    try {
      const idsParam = (req.query.ids ?? req.query.wikidotIds) as string | string[] | undefined;
      const viewerParam = (req.query.viewer ?? req.query.viewerWikidotId) as string | undefined;

      if (!idsParam) {
        return res.json({ votes: {} });
      }

      const ids = (Array.isArray(idsParam) ? idsParam : String(idsParam).split(','))
        .map((value) => Number(String(value).trim()))
        .filter((value) => Number.isInteger(value) && value > 0);

      if (ids.length === 0) {
        return res.json({ votes: {} });
      }

      const viewerWikidotId = Number(viewerParam);
      if (!Number.isInteger(viewerWikidotId) || viewerWikidotId <= 0) {
        return res.json({ votes: {} });
      }

      const userResult = await pool.query<{ id: number }>(
        'SELECT id FROM "User" WHERE "wikidotId" = $1 LIMIT 1',
        [viewerWikidotId]
      );

      if (userResult.rowCount === 0) {
        return res.json({ votes: {} });
      }

      const userId = userResult.rows[0].id;

      const { rows } = await pool.query<{ pageWikidotId: number; direction: number }>(
        `SELECT DISTINCT ON (pv."pageId")
            pv."wikidotId" AS "pageWikidotId",
            v.direction
         FROM "Vote" v
         JOIN "PageVersion" pv ON pv.id = v."pageVersionId"
         WHERE v."userId" = $1
           AND pv."wikidotId" = ANY($2::int[])
         ORDER BY pv."pageId", v.timestamp DESC`,
        [userId, ids]
      );

      const votes: Record<number, number> = {};
      for (const row of rows) {
        if (row.pageWikidotId != null && Number.isFinite(row.pageWikidotId)) {
          votes[row.pageWikidotId] = Number(row.direction || 0);
        }
      }

      return res.json({ votes });
    } catch (error) {
      next(error);
    }
  });

  const imageSelectionSql = `
    SELECT
      pvi."pageVersionId" AS "pageVersionId",
      pvi.id                AS "pageVersionImageId",
      pvi."originUrl"      AS "originUrl",
      pvi."displayUrl"     AS "displayUrl",
      pvi."normalizedUrl"  AS "normalizedUrl",
      ia.id                 AS "assetId",
      ia."mimeType"        AS "mimeType",
      ia.width              AS width,
      ia.height             AS height,
      ia.bytes              AS bytes,
      ia."canonicalUrl"    AS "canonicalUrl"
    FROM "PageVersionImage" pvi
    JOIN "ImageAsset" ia ON ia.id = pvi."imageAssetId"
    WHERE pvi."pageVersionId" = ANY($1::int[])
      AND pvi.status = 'RESOLVED'
      AND pvi."imageAssetId" IS NOT NULL
      AND ia."storagePath" IS NOT NULL
      AND ia."status" = 'READY'
    ORDER BY pvi."pageVersionId", pvi.id
  `;

  const extractPageVersionId = (row: any): number | null => {
    if (!row) return null;
    const raw = row.pageVersionId ?? row.id ?? null;
    if (raw === null || raw === undefined) return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  };

  const groupImagesByPageVersion = async (ids: number[]): Promise<Map<number, any[]>> => {
    if (ids.length === 0) {
      return new Map();
    }
    const { rows } = await pool.query(imageSelectionSql, [ids]);
    const grouped = new Map<number, any[]>();
    for (const row of rows) {
      const entry = {
        pageVersionImageId: row.pageVersionImageId,
        assetId: row.assetId,
        originUrl: row.originUrl,
        displayUrl: row.displayUrl,
        normalizedUrl: row.normalizedUrl,
        mimeType: row.mimeType,
        width: row.width,
        height: row.height,
        bytes: row.bytes,
        canonicalUrl: row.canonicalUrl,
        imageUrl: buildPageImagePath(row.assetId)
      };
      const list = grouped.get(row.pageVersionId);
      if (list) {
        list.push(entry);
      } else {
        grouped.set(row.pageVersionId, [entry]);
      }
    }
    return grouped;
  };

  const hydrateRowsWithImages = async (rows: any[]): Promise<void> => {
    if (!rows || rows.length === 0) return;
    const ids = Array.from(new Set(
      rows
        .map(extractPageVersionId)
        .filter((id): id is number => id !== null)
    ));
    const grouped = await groupImagesByPageVersion(ids);
    for (const row of rows) {
      if (!row) continue;
      const id = extractPageVersionId(row);
      row.images = id != null ? (grouped.get(id) ?? []) : [];
    }
  };

  async function mergeDeletedWithLatestLiveVersion(row: any) {
    if (!row) return row;
    await hydrateRowsWithImages([row]);
    if (row.isDeleted !== true || !row.pageId) return row;

    const fallbackSql = `
      SELECT
        pv.id AS "pageVersionId",
        pv.rating,
        pv."voteCount",
        pv."revisionCount",
        pv."commentCount",
        pv."attributionCount",
        pv.tags,
        pv.title,
        pv."alternateTitle",
        pv.category,
        pv."wikidotId"
      FROM "PageVersion" pv
      WHERE pv."pageId" = $1 AND pv."isDeleted" = false
      ORDER BY pv."validFrom" DESC NULLS LAST, pv.id DESC
      LIMIT 1
    `;

    const { rows: prevRows } = await pool.query(fallbackSql, [row.pageId]);
    if (prevRows.length === 0) return row;

    const prev = prevRows[0];
    await hydrateRowsWithImages([prev]);
    const merged = { ...row };
    const fieldsToCopy = [
      'rating',
      'voteCount',
      'revisionCount',
      'commentCount',
      'attributionCount',
      'tags',
      'title',
      'alternateTitle',
      'category',
      'images'
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
    if (!Array.isArray(merged.images)) {
      merged.images = [];
    }
    return merged;
  }

  const selectLatestPageVersion = async (whereClause: string, params: unknown[]): Promise<any | null> => {
    const sql = `
      SELECT
        pv.id AS "pageVersionId",
        p."wikidotId" AS "pageWikidotId",
        p."currentUrl" AS url,
        pv.*,
        CASE WHEN pv."isDeleted" THEN pv."validFrom" ELSE NULL END AS "deletedAt"
      FROM "PageVersion" pv
      JOIN "Page" p ON pv."pageId" = p.id
      WHERE ${whereClause}
      ORDER BY pv."validTo" IS NULL DESC, pv."validFrom" DESC NULLS LAST, pv.id DESC
      LIMIT 1
    `;
    const { rows } = await pool.query(sql, params);
    if (rows.length === 0) return null;
    const row = rows[0];
    if (!row.wikidotId && row.pageWikidotId) {
      row.wikidotId = row.pageWikidotId;
    }
    return row;
  };

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
      currentIsDeleted: Boolean(current?.isDeleted ?? false),
      effectiveVersionId: effective?.id ?? null,
      effectiveIsDeleted: Boolean(effective?.isDeleted ?? false)
    };
  }

  router.get('/:wikidotId/references', async (req, res, next) => {
    try {
      const { wikidotId } = req.params;
      const context = await resolvePageContextByWikidotId(wikidotId);
      if (!context || !context.effectiveVersionId) {
        return res.status(404).json({ error: 'not_found' });
      }

      const sql = `
        SELECT
          id,
          "linkType",
          "targetPath",
          "targetFragment",
          "displayTexts",
          "rawTarget",
          "rawText",
          "occurrence",
          "createdAt",
          "updatedAt"
        FROM "PageReference"
        WHERE "pageVersionId" = $1
        ORDER BY "occurrence" DESC, "targetPath" ASC, "targetFragment" ASC NULLS FIRST, id ASC
      `;

      const { rows } = await pool.query(sql, [context.effectiveVersionId]);

      const references = rows.map((row) => ({
        id: row.id,
        linkType: row.linkType,
        targetPath: row.targetPath,
        targetFragment: row.targetFragment,
        displayTexts: Array.isArray(row.displayTexts) ? row.displayTexts : [],
        rawTarget: row.rawTarget,
        rawText: row.rawText,
        occurrence: Number(row.occurrence ?? 0),
        createdAt: row.createdAt,
        updatedAt: row.updatedAt
      }));

      res.json({
        wikidotId: Number(wikidotId),
        pageId: context.pageId,
        currentVersionId: context.currentVersionId,
        currentIsDeleted: context.currentIsDeleted,
        effectiveVersionId: context.effectiveVersionId,
        effectiveIsDeleted: context.effectiveIsDeleted,
        references
      });
    } catch (err) {
      next(err);
    }
  });

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
          pv."alternateTitle",
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
      const row = await selectLatestPageVersion('p."currentUrl" = $1', [url]);
      if (!row) return res.status(404).json({ error: 'not_found' });
      const merged = await mergeDeletedWithLatestLiveVersion(row);
      if (!merged.wikidotId && row.pageWikidotId) {
        merged.wikidotId = row.pageWikidotId;
      }
      delete merged.pageWikidotId;
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
      const row = await selectLatestPageVersion('p."wikidotId" = $1', [wikidotId]);
      if (!row) return res.status(404).json({ error: 'not_found' });
      const merged = await mergeDeletedWithLatestLiveVersion(row);
      if (!merged.wikidotId && row.pageWikidotId) {
        merged.wikidotId = row.pageWikidotId;
      }
      delete merged.pageWikidotId;
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
        SELECT COALESCE(pv."wikidotId", p."wikidotId") AS "wikidotId", p."currentUrl" AS url, pv.title, pv."alternateTitle", pv.rating, pv.tags
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

  const shuffleInPlace = <T>(arr: T[]): void => {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
  };

  // GET /api/pages/random
  router.get('/random', async (req, res, next) => {
    try {
      const { limit = '1' } = req.query as Record<string, string>;
      const limitInt = Math.max(1, Number(limit) || 1);
      const BASE_RANDOM_FILTER = `
        pv."validTo" IS NULL
        AND pv.rating IS NOT NULL
        AND COALESCE(array_length(pv.tags, 1), 0) > 0
        AND NOT (pv.tags && ARRAY['作者','段落','补充材料']::text[])
      `;

      const fetchSampledPages = async (
        selectClause: string,
        additionalFilter: string,
        extraJoins: string,
        limitValue: number
      ): Promise<any[]> => {
        const combinedFilter = `${BASE_RANDOM_FILTER}${additionalFilter ? ` AND ${additionalFilter}` : ''}`;
        const samplePercent = Math.min(50, Math.max(limitValue * 3, 5));
        const sampledSql = `
          WITH sampled AS (
            SELECT pv.id
            FROM "PageVersion" pv TABLESAMPLE SYSTEM (${samplePercent})
            WHERE ${combinedFilter}
          )
          SELECT ${selectClause}
          FROM sampled s
          JOIN "PageVersion" pv ON pv.id = s.id
          JOIN "Page" p ON pv."pageId" = p.id
          ${extraJoins}
          WHERE ${combinedFilter}
          ORDER BY random()
          LIMIT $1::int
        `;
        const { rows } = await pool.query(sampledSql, [limitValue]);
        if (rows.length >= limitValue) {
          return rows;
        }

        const fallbackSql = `
          SELECT ${selectClause}
          FROM "PageVersion" pv
          JOIN "Page" p ON pv."pageId" = p.id
          ${extraJoins}
          WHERE ${combinedFilter}
          ORDER BY random()
          LIMIT $1::int
        `;
        const { rows: fallbackRows } = await pool.query(fallbackSql, [limitValue]);
        return fallbackRows.length > 0 ? fallbackRows : rows;
      };

      if (limit === '1') {
        const selectClause = `
          COALESCE(pv."wikidotId", p."wikidotId") AS "wikidotId",
          p."currentUrl" AS url,
          pv.title,
          pv."alternateTitle",
          pv.rating,
          pv."commentCount",
          pv."voteCount",
          pv.category,
          pv.tags,
          pv."createdAt",
          pv."revisionCount",
          pv."attributionCount",
          pv.source,
          pv."isDeleted" AS "isDeleted",
          CASE WHEN pv."isDeleted" THEN pv."validFrom" ELSE NULL END AS "deletedAt"
        `;
        const rows = await fetchSampledPages(selectClause, '', '', 1);
        if (rows.length === 0) {
          return res.status(404).json({ error: 'not_found' });
        }
        const row: any = rows[0];
        const previews = extractPreviewCandidates(row?.source || null);
        if (previews && previews.length > 0) {
          const picked = pickPreview(previews);
          if (picked) {
            const pp = toPreviewPick(picked);
            return res.json({ ...row, excerpt: pp.text });
          }
        }
        return res.json(row);
      }

      if (limit === '6') {
        const selectClauseExtended = `
          COALESCE(pv."wikidotId", p."wikidotId") AS "wikidotId",
          p."currentUrl" AS url,
          pv.title,
          pv."alternateTitle",
          pv.rating,
          pv."commentCount",
          pv."voteCount",
          pv.category,
          pv.tags,
          pv."createdAt",
          pv."revisionCount",
          pv."attributionCount",
          pv.source,
          pv."textContent",
          pv."isDeleted" AS "isDeleted",
          CASE WHEN pv."isDeleted" THEN pv."validFrom" ELSE NULL END AS "deletedAt",
          p."firstPublishedAt" AS "firstRevisionAt",
          ps."controversy",
          ps."wilson95",
          COALESCE(attrs.authors, '[]'::json) AS authors
        `;

        const statsJoin = `
          LEFT JOIN "PageStats" ps ON ps."pageVersionId" = pv.id
          LEFT JOIN LATERAL (
            SELECT COALESCE(
              JSON_AGG(
                JSON_BUILD_OBJECT(
                  'displayName', j."displayName",
                  'userWikidotId', j."userWikidotId"
                )
                ORDER BY j.rank
              ) FILTER (WHERE j."displayName" IS NOT NULL),
              '[]'::json
            ) AS authors
            FROM (
              SELECT DISTINCT ON (u.id)
                u."displayName" AS "displayName",
                u."wikidotId"   AS "userWikidotId",
                ROW_NUMBER() OVER (ORDER BY u.id ASC, a.type ASC) AS rank
              FROM "Attribution" a
              JOIN "User" u ON u.id = a."userId"
              WHERE a."pageVerId" = pv.id
              ORDER BY u.id, a.type ASC
            ) j
          ) attrs ON TRUE
        `;

        const [highScoring, originals, translations] = await Promise.all([
          fetchSampledPages(selectClauseExtended, `pv.rating >= 50 AND '原创' = ANY(pv.tags)`, statsJoin, 1),
          fetchSampledPages(selectClauseExtended, `'原创' = ANY(pv.tags)`, statsJoin, 3),
          fetchSampledPages(selectClauseExtended, `NOT ('原创' = ANY(pv.tags))`, statsJoin, 2)
        ]);

        const normalizePage = (page: any) => {
          let excerpt = '';
          const candidates = extractPreviewCandidates(page?.source || null);
          if (candidates && candidates.length > 0) {
            const picked = pickPreview(candidates);
            if (picked) excerpt = toPreviewPick(picked).text;
          }
          if (!excerpt) {
            excerpt = extractExcerptFallback(page?.textContent ?? null, 150);
          }
          const { textContent, source, ...rest } = page;
          return { ...rest, excerpt };
        };

        let combined = [...highScoring, ...originals, ...translations].map(normalizePage);

        if (combined.length < 6) {
          const fillerNeeded = 6 - combined.length;
          if (fillerNeeded > 0) {
            const filler = await fetchSampledPages(selectClauseExtended, '', statsJoin, fillerNeeded);
            combined = combined.concat(filler.map(normalizePage));
          }
        }

        if (combined.length === 0) {
          return res.status(404).json({ error: 'not_found' });
        }

        const seen = new Set<number>();
        const deduped = combined.filter((item: any) => {
          const id = Number(item?.wikidotId);
          if (!Number.isFinite(id)) return true;
          if (seen.has(id)) return false;
          seen.add(id);
          return true;
        });

        if (deduped.length === 0) {
          return res.status(404).json({ error: 'not_found' });
        }

        shuffleInPlace(deduped);
        return res.json(deduped.slice(0, Math.min(6, deduped.length)));
      }

      const selectClause = `
        pv."wikidotId",
        p."currentUrl" AS url,
        pv.title,
        pv."alternateTitle",
        pv.rating,
        pv."voteCount",
        pv.category,
        pv.tags,
        pv."createdAt",
        pv."revisionCount",
        pv."attributionCount"
      `;
      const rows = await fetchSampledPages(selectClause, '', '', Math.max(limitInt, Math.min(limitInt * 2, 50)));
      if (rows.length === 0) {
        return res.status(404).json({ error: 'not_found' });
      }
      const poolRows = [...rows];
      shuffleInPlace(poolRows);
      res.json(poolRows.slice(0, Math.min(limitInt, poolRows.length)));
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
          pv."validFrom",
          pv."validTo",
          pv.title,
          pv."alternateTitle",
          pv.rating,
          pv."revisionCount",
          ${withSource ? 'pv.source AS source,' : ''}
          CASE WHEN pv.source IS NULL THEN false ELSE true END AS "hasSource",
          COALESCE(attrs.attributions, '[]'::json) AS attributions
        FROM "PageVersion" pv
        LEFT JOIN LATERAL (
          SELECT COALESCE(JSON_AGG(j) FILTER (WHERE j IS NOT NULL), '[]'::json) AS attributions
          FROM (
            SELECT DISTINCT ON (u.id)
              JSON_BUILD_OBJECT(
                'userId', u.id,
                'displayName', u."displayName",
                'userWikidotId', u."wikidotId",
                'type', a.type
              ) AS j
            FROM "Attribution" a
            JOIN "User" u ON u.id = a."userId"
            WHERE a."pageVerId" = pv.id
            ORDER BY u.id, a.type ASC
          ) s
        ) attrs ON TRUE
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

  // GET /api/wikidot-pages/:wikidotId/versions/:versionId/attributions
  // List attributions for a specific PageVersion id (scoped to the given wikidotId for safety)
  router.get('/:wikidotId/versions/:versionId/attributions', async (req, res, next) => {
    try {
      const { wikidotId, versionId } = req.params as Record<string, string>;
      // Ensure the version belongs to this wikidotId
      const check = await pool.query(
        `SELECT 1 FROM "PageVersion" pv WHERE pv.id = $1::int AND pv."wikidotId" = $2::int LIMIT 1`,
        [versionId, wikidotId]
      );
      if (check.rowCount === 0) return res.status(404).json({ error: 'not_found' });

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
      const { rows } = await pool.query(sql, [versionId]);
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

  // GET /api/wikidot-pages/:wikidotId/text-content - 获取页面正文文本内容（PageVersion.textContent 优先，其次 SourceVersion.textContent）
  router.get('/:wikidotId/text-content', async (req, res, next) => {
    try {
      const { wikidotId } = req.params as Record<string, string>;
      const context = await resolvePageContextByWikidotId(wikidotId);
      if (!context) return res.status(404).json({ error: 'not_found' });

      const targetVersionId = context.effectiveVersionId ?? context.currentVersionId;
      if (!targetVersionId) return res.status(404).json({ error: 'not_found' });

      const primary = await pool.query<{ textContent: string | null }>(
        `SELECT pv."textContent"
           FROM "PageVersion" pv
          WHERE pv.id = $1
          LIMIT 1`,
        [targetVersionId]
      );

      if (primary.rowCount === 0) {
        return res.status(404).json({ error: 'not_found' });
      }

      const primaryText = primary.rows[0]?.textContent ?? null;
      if (typeof primaryText === 'string') {
        return res.json({ textContent: primaryText, origin: 'pageVersion' });
      }

      const fallback = await pool.query<{ textContent: string | null }>(
        `SELECT s."textContent"
           FROM "SourceVersion" s
          WHERE s."pageVersionId" = $1
            AND s."textContent" IS NOT NULL
          ORDER BY s."isLatest" DESC, s.timestamp DESC
          LIMIT 1`,
        [targetVersionId]
      );

      const fallbackText = fallback.rows[0]?.textContent ?? null;
      if (typeof fallbackText === 'string') {
        return res.json({ textContent: fallbackText, origin: 'sourceVersion' });
      }

      return res.json({ textContent: null, origin: 'none' });
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
          pv."alternateTitle",
          pv.rating,
          pv."commentCount",
          pv."voteCount",
          pv.category,
          pv.tags,
          pv."createdAt",
          pv."createdAt" AS date,
          pv."revisionCount",
          pv."attributionCount",
          pv.source,
          SUBSTRING(pv."textContent" FOR 2000) AS "textSnippet",
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

      // 输出：去掉中间计算字段，保留 similarity，并注入 snippet：
      // 1) 优先使用 preview；2) 否则使用与首页随机一致的 excerpt 逻辑
      const payload = finalList.map(({ tag_overlap, tag_overlap_weighted, author_overlap, matched_tags, matched_authors, ...rest }: any) => {
        const previews = extractPreviewCandidates(rest?.source || null);
        let snippetHtml: string | null = null;
        if (previews && previews.length > 0) {
          const picked = pickPreview(previews);
          if (picked) snippetHtml = toPreviewPick(picked).html;
        }
        if (!snippetHtml) {
          const ex = extractExcerptFallback(rest?.textSnippet || null, 150);
          if (ex) snippetHtml = toPreviewPick(ex).html;
        }
        const { source, textSnippet, ...clean } = rest;
        return snippetHtml ? { ...clean, snippet: snippetHtml } : clean;
      });
      res.json(payload);
    } catch (err) {
      next(err);
    }
  });

  router.get('/:wikidotId/images', async (req, res, next) => {
    try {
      const { wikidotId } = req.params as Record<string, string>;
      const context = await resolvePageContextByWikidotId(wikidotId);
      if (!context) return res.json([]);

      const targetId = context.effectiveVersionId ?? context.currentVersionId;
      if (!targetId) return res.json([]);

      const grouped = await groupImagesByPageVersion([targetId]);
      res.json(grouped.get(targetId) ?? []);
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
        WITH ordered AS (
          SELECT
            date_trunc('day', v.timestamp) AS day,
            v.timestamp,
            v.direction,
            CASE
              WHEN v."userId" IS NOT NULL THEN 'u:' || v."userId"::text
              WHEN v."anonKey" IS NOT NULL THEN 'a:' || v."anonKey"
              ELSE 'g:' || v.id::text
            END AS actor_key,
            LAG(v.direction) OVER (
              PARTITION BY CASE
                WHEN v."userId" IS NOT NULL THEN 'u:' || v."userId"::text
                WHEN v."anonKey" IS NOT NULL THEN 'a:' || v."anonKey"
                ELSE 'g:' || v.id::text
              END
              ORDER BY v.timestamp, v.id
            ) AS prev_direction
          FROM "Vote" v
          WHERE v."pageVersionId" = $1
        ),
        deltas AS (
          SELECT
            day,
            (direction - COALESCE(prev_direction, 0)) AS delta
          FROM ordered
        ),
        daily AS (
          SELECT day, SUM(delta) AS delta
          FROM deltas
          GROUP BY day
        )
        SELECT
          day::timestamptz AS date,
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
        FROM "LatestVote" v
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
      if (!context || !context.effectiveVersionId) return res.json([]);
      
      // 获取页面的投票历史，按周或月聚合（无时间限制，获取全部历史数据）
      const dateLabel = granularity === 'month' ? 'YYYY-MM-DD' : 'YYYY-MM-DD';
      
      const sql = `
        WITH ordered AS (
          SELECT
            DATE_TRUNC('${granularity}', v.timestamp) AS period,
            v.timestamp,
            v.direction AS current_direction,
            CASE
              WHEN v."userId" IS NOT NULL THEN 'u:' || v."userId"::text
              WHEN v."anonKey" IS NOT NULL THEN 'a:' || v."anonKey"
              ELSE 'g:' || v.id::text
            END AS actor_key,
            LAG(v.direction) OVER (
              PARTITION BY CASE
                WHEN v."userId" IS NOT NULL THEN 'u:' || v."userId"::text
                WHEN v."anonKey" IS NOT NULL THEN 'a:' || v."anonKey"
                ELSE 'g:' || v.id::text
              END
              ORDER BY v.timestamp, v.id
            ) AS prev_direction
          FROM "Vote" v
          WHERE v."pageVersionId" = $1
        ),
        deltas AS (
          SELECT
            period,
            (CASE WHEN current_direction = 1 THEN 1 ELSE 0 END) - (CASE WHEN COALESCE(prev_direction, 0) = 1 THEN 1 ELSE 0 END) AS up_delta,
            (CASE WHEN current_direction = -1 THEN 1 ELSE 0 END) - (CASE WHEN COALESCE(prev_direction, 0) = -1 THEN 1 ELSE 0 END) AS down_delta,
            current_direction - COALESCE(prev_direction, 0) AS net_delta
          FROM ordered
        ),
        aggregated AS (
          SELECT
            period,
            SUM(up_delta) AS upvotes,
            SUM(down_delta) AS downvotes,
            SUM(net_delta) AS net_change
          FROM deltas
          GROUP BY period
        )
        SELECT
          TO_CHAR(period, '${dateLabel}') AS date,
          COALESCE(upvotes, 0) AS upvotes,
          COALESCE(downvotes, 0) AS downvotes,
          COALESCE(net_change, 0) AS net_change,
          SUM(COALESCE(net_change, 0)) OVER (ORDER BY period) AS cumulative_rating
        FROM aggregated
        ORDER BY period
      `;
      const { rows } = await pool.query(sql, [context.effectiveVersionId]);
      
      // 直接返回数据，前端会处理隐藏逻辑
      res.json(rows);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
