import { Router } from 'express';
import type { Pool } from 'pg';
import type { RedisClientType } from 'redis';
import { extractPreviewCandidates, pickPreview, toPreviewPick, extractExcerptFallback } from '../utils/preview.js';
import { buildPageImagePath } from '../pageImagesConfig.js';
import { createCache } from '../utils/cache.js';
import { getReadPoolSync } from '../utils/dbPool.js';
import { parsePositiveInt } from '../utils/helpers.js';

export function pagesRouter(pool: Pool, redis: RedisClientType | null) {
  const router = Router();
  const cache = createCache(redis);

  // 读写分离：pages 全部是读操作，使用从库
  const readPool = getReadPoolSync(pool);

  router.param('wikidotId', (req, res, next, value) => {
    if (parsePositiveInt(value) === null) {
      return res.status(400).json({ error: 'invalid_wikidotId' });
    }
    return next();
  });

  router.param('versionId', (req, res, next, value) => {
    if (parsePositiveInt(value) === null) {
      return res.status(400).json({ error: 'invalid_versionId' });
    }
    return next();
  });

  router.param('revisionId', (req, res, next, value) => {
    if (parsePositiveInt(value) === null) {
      return res.status(400).json({ error: 'invalid_revisionId' });
    }
    return next();
  });

  router.get('/vote-status', async (req, res, next) => {
    try {
      const idsParam = (req.query.ids ?? req.query.wikidotIds) as string | string[] | undefined;
      const viewerParam = (req.query.viewer ?? req.query.viewerWikidotId) as string | undefined;

      if (!idsParam) {
        return res.json({ votes: {} });
      }

      // Hard cap on array size so a caller passing thousands of ids can't
      // push PG's planner to a seq scan on Vote. 200 comfortably covers all
      // real page-list responses (default page size is 40).
      const MAX_VOTE_STATUS_IDS = 200;
      const parsedIds = (Array.isArray(idsParam) ? idsParam : String(idsParam).split(','))
        .map((value) => Number(String(value).trim()))
        .filter((value) => Number.isInteger(value) && value > 0);

      if (parsedIds.length === 0) {
        return res.json({ votes: {} });
      }

      if (parsedIds.length > MAX_VOTE_STATUS_IDS) {
        return res.status(400).json({ error: 'too_many_ids', max: MAX_VOTE_STATUS_IDS });
      }
      const ids = parsedIds;

      const viewerWikidotId = Number(viewerParam);
      if (!Number.isInteger(viewerWikidotId) || viewerWikidotId <= 0) {
        return res.json({ votes: {} });
      }

      // 缓存 key 包含 viewer 和 page ids（用户投票状态，60秒 TTL）
      const sortedIds = [...ids].sort((a, b) => a - b);
      const cacheKey = `vote-status:${viewerWikidotId}:${sortedIds.join(',')}`;

      const result = await cache.remember(cacheKey, 60, async () => {
        const userResult = await readPool.query<{ id: number }>(
          'SELECT id FROM "User" WHERE "wikidotId" = $1 LIMIT 1',
          [viewerWikidotId]
        );

        if (userResult.rowCount === 0) {
          return { votes: {} };
        }

        const userId = userResult.rows[0].id;

        const { rows } = await readPool.query<{ pageWikidotId: number; direction: number }>(
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

        return { votes };
      });

      return res.json(result);
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

  interface ImageSelectionRow {
    pageVersionId: number;
    pageVersionImageId: number;
    originUrl: string | null;
    displayUrl: string | null;
    normalizedUrl: string;
    assetId: number;
    mimeType: string | null;
    width: number | null;
    height: number | null;
    bytes: number | null;
    canonicalUrl: string | null;
  }

  interface PageImageEntry {
    pageVersionImageId: number;
    assetId: number;
    originUrl: string | null;
    displayUrl: string | null;
    normalizedUrl: string;
    mimeType: string | null;
    width: number | null;
    height: number | null;
    bytes: number | null;
    canonicalUrl: string | null;
    imageUrl: string;
    isFallback?: boolean;
    fallbackSourcePageVersionId?: number;
  }

  const toPageImageEntry = (row: ImageSelectionRow): PageImageEntry => ({
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
  });

  const extractPageVersionId = (row: any): number | null => {
    if (!row) return null;
    const raw = row.pageVersionId ?? row.id ?? null;
    if (raw === null || raw === undefined) return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  };

  const groupImagesByPageVersion = async (ids: number[]): Promise<Map<number, PageImageEntry[]>> => {
    if (ids.length === 0) {
      return new Map();
    }
    const { rows } = await readPool.query<ImageSelectionRow>(imageSelectionSql, [ids]);
    const grouped = new Map<number, PageImageEntry[]>();
    for (const row of rows) {
      const entry = toPageImageEntry(row);
      const list = grouped.get(row.pageVersionId);
      if (list) {
        list.push(entry);
      } else {
        grouped.set(row.pageVersionId, [entry]);
      }
    }
    return grouped;
  };

  interface TargetVersionImageRow {
    pageVersionImageId: number;
    pageVersionId: number;
    originUrl: string | null;
    displayUrl: string | null;
    normalizedUrl: string;
  }

  interface FallbackImageRow extends ImageSelectionRow {
    sourcePageVersionId: number;
  }

  const loadPageVersionImagesWithFallback = async (pageVersionId: number): Promise<PageImageEntry[]> => {
    // 并行执行：resolved 图像查询 + 全部图像 URL 查询（原为 4 步串行，现为 2 步）
    const [baseGrouped, { rows: targetRows }] = await Promise.all([
      groupImagesByPageVersion([pageVersionId]),
      readPool.query<TargetVersionImageRow>(
        `SELECT
           pvi.id AS "pageVersionImageId",
           pvi."pageVersionId" AS "pageVersionId",
           pvi."originUrl" AS "originUrl",
           pvi."displayUrl" AS "displayUrl",
           pvi."normalizedUrl" AS "normalizedUrl"
         FROM "PageVersionImage" pvi
         WHERE pvi."pageVersionId" = $1
         ORDER BY pvi.id`,
        [pageVersionId]
      )
    ]);
    const baseResolved = baseGrouped.get(pageVersionId) ?? [];

    if (targetRows.length === 0) {
      return baseResolved;
    }

    const resolvedByNormalized = new Map(baseResolved.map((item) => [item.normalizedUrl, item] as const));
    const unresolvedUrls = Array.from(new Set(
      targetRows
        .map((row) => row.normalizedUrl)
        .filter((url) => url && !resolvedByNormalized.has(url))
    ));

    if (unresolvedUrls.length === 0) {
      return baseResolved;
    }

    // pageId 查询折叠进 fallback 查询的子查询中（原为 2 步串行，现为 1 步）
    const { rows: fallbackRows } = await readPool.query<FallbackImageRow>(
      `SELECT DISTINCT ON (pvi."normalizedUrl")
         pvi.id AS "pageVersionImageId",
         pvi."pageVersionId" AS "pageVersionId",
         pvi."pageVersionId" AS "sourcePageVersionId",
         pvi."originUrl" AS "originUrl",
         pvi."displayUrl" AS "displayUrl",
         pvi."normalizedUrl" AS "normalizedUrl",
         ia.id AS "assetId",
         ia."mimeType" AS "mimeType",
         ia.width AS width,
         ia.height AS height,
         ia.bytes AS bytes,
         ia."canonicalUrl" AS "canonicalUrl"
       FROM "PageVersionImage" pvi
       JOIN "PageVersion" pv ON pv.id = pvi."pageVersionId"
       JOIN "ImageAsset" ia ON ia.id = pvi."imageAssetId"
       WHERE pv."pageId" = (SELECT "pageId" FROM "PageVersion" WHERE id = $1 LIMIT 1)
         AND pvi."normalizedUrl" = ANY($2::text[])
         AND pvi.status = 'RESOLVED'
         AND pvi."imageAssetId" IS NOT NULL
         AND ia."storagePath" IS NOT NULL
         AND ia."status" = 'READY'
       ORDER BY pvi."normalizedUrl", pvi."lastFetchedAt" DESC NULLS LAST, pvi.id DESC`,
      [pageVersionId, unresolvedUrls]
    );

    const fallbackByNormalized = new Map<string, PageImageEntry>();
    for (const row of fallbackRows) {
      const entry = toPageImageEntry(row);
      entry.isFallback = true;
      entry.fallbackSourcePageVersionId = row.sourcePageVersionId;
      fallbackByNormalized.set(row.normalizedUrl, entry);
    }

    const merged: PageImageEntry[] = [];
    const seen = new Set<string>();
    for (const row of targetRows) {
      const normalizedUrl = row.normalizedUrl;
      if (!normalizedUrl || seen.has(normalizedUrl)) continue;

      const resolved = resolvedByNormalized.get(normalizedUrl);
      if (resolved) {
        merged.push(resolved);
        seen.add(normalizedUrl);
        continue;
      }

      const fallback = fallbackByNormalized.get(normalizedUrl);
      if (fallback) {
        merged.push({
          ...fallback,
          pageVersionImageId: row.pageVersionImageId,
          originUrl: row.originUrl ?? fallback.originUrl,
          displayUrl: row.displayUrl ?? fallback.displayUrl,
          normalizedUrl
        });
        seen.add(normalizedUrl);
      }
    }

    // Keep any current resolved rows that were not mapped via target rows.
    for (const row of baseResolved) {
      if (seen.has(row.normalizedUrl)) continue;
      merged.push(row);
    }

    return merged;
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

    const { rows: prevRows } = await readPool.query(fallbackSql, [row.pageId]);
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
    const { rows } = await readPool.query(sql, params);
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

  async function resolvePageContextByPageId(pageId: number): Promise<PageContext | null> {
    const numericPageId = Number(pageId);
    if (!Number.isFinite(numericPageId) || numericPageId <= 0) return null;

    const { rows: currentRows } = await readPool.query(
      `SELECT id, "isDeleted"
         FROM "PageVersion"
         WHERE "pageId" = $1 AND "validTo" IS NULL
         ORDER BY id DESC
         LIMIT 1`,
      [numericPageId]
    );
    const current = currentRows[0] ?? null;

    let effective = current;
    if (!effective) {
      const { rows: anyRows } = await readPool.query(
        `SELECT id, "isDeleted"
           FROM "PageVersion"
           WHERE "pageId" = $1
           ORDER BY "validFrom" DESC NULLS LAST, id DESC
           LIMIT 1`,
        [numericPageId]
      );
      effective = anyRows[0] ?? null;
    } else if (effective.isDeleted) {
      const { rows: liveRows } = await readPool.query(
        `SELECT id, "isDeleted"
           FROM "PageVersion"
           WHERE "pageId" = $1 AND "isDeleted" = false
           ORDER BY "validFrom" DESC NULLS LAST, id DESC
           LIMIT 1`,
        [numericPageId]
      );
      if (liveRows.length > 0) {
        effective = liveRows[0];
      }
    }

    return {
      pageId: numericPageId,
      currentVersionId: current?.id ?? null,
      currentIsDeleted: Boolean(current?.isDeleted ?? false),
      effectiveVersionId: effective?.id ?? null,
      effectiveIsDeleted: Boolean(effective?.isDeleted ?? false)
    };
  }

  async function resolvePageContextByWikidotId(input: string | number): Promise<PageContext | null> {
    const wikidotId = parsePositiveInt(input);
    if (wikidotId === null) return null;

    const { rows: pageRows } = await readPool.query(
      'SELECT id FROM "Page" WHERE "wikidotId" = $1 LIMIT 1',
      [wikidotId]
    );
    if (pageRows.length === 0) return null;
    const pageId = pageRows[0].id;

    return resolvePageContextByPageId(pageId);
  }

  function parseBatchWikidotIds(input: string | string[] | undefined) {
    if (!input) return [];
    const rawValues = Array.isArray(input) ? input : [input];
    const ids = rawValues
      .flatMap((value) => String(value).split(','))
      .map((value) => parsePositiveInt(String(value).trim()))
      .filter((value): value is number => value !== null);
    return Array.from(new Set(ids));
  }

  // GET /pages/attributions/batch?ids=123,456
  router.get('/attributions/batch', async (req, res, next) => {
    try {
      const rawIds = parseBatchWikidotIds((req.query.ids ?? req.query.wikidotIds) as string | string[] | undefined);
      const ids = rawIds.slice(0, 200);
      if (ids.length === 0) return res.json({ items: [] });

      const sql = `
        WITH requested AS (
          SELECT DISTINCT UNNEST($1::int[]) AS "wikidotId"
        ),
        page_ctx AS (
          SELECT
            r."wikidotId",
            p.id AS "pageId"
          FROM requested r
          LEFT JOIN "Page" p ON p."wikidotId" = r."wikidotId"
        ),
        resolved AS (
          SELECT
            pc."wikidotId",
            CASE
              WHEN current_ver.id IS NULL THEN latest_any.id
              WHEN current_ver."isDeleted" THEN COALESCE(latest_live.id, current_ver.id)
              ELSE current_ver.id
            END AS "effectiveVersionId"
          FROM page_ctx pc
          LEFT JOIN LATERAL (
            SELECT pv.id, pv."isDeleted"
            FROM "PageVersion" pv
            WHERE pv."pageId" = pc."pageId" AND pv."validTo" IS NULL
            ORDER BY pv.id DESC
            LIMIT 1
          ) current_ver ON TRUE
          LEFT JOIN LATERAL (
            SELECT pv.id
            FROM "PageVersion" pv
            WHERE pv."pageId" = pc."pageId" AND pv."isDeleted" = false
            ORDER BY pv."validFrom" DESC NULLS LAST, pv.id DESC
            LIMIT 1
          ) latest_live ON TRUE
          LEFT JOIN LATERAL (
            SELECT pv.id
            FROM "PageVersion" pv
            WHERE pv."pageId" = pc."pageId"
            ORDER BY pv."validFrom" DESC NULLS LAST, pv.id DESC
            LIMIT 1
          ) latest_any ON TRUE
        ),
        attrs AS (
          SELECT
            r."wikidotId",
            a."pageVerId",
            a."userId" AS "attribUserId",
            a."anonKey",
            a.type,
            a."order",
            a.date,
            u.id AS "resolvedUserId",
            u."displayName" AS "userDisplayName",
            u."username" AS "userUsername",
            u."wikidotId" AS "userWikidotId",
            BOOL_OR(a.type <> 'SUBMITTER') OVER (
              PARTITION BY r."wikidotId", a."pageVerId"
            ) AS has_non_submitter
          FROM resolved r
          LEFT JOIN "Attribution" a ON a."pageVerId" = r."effectiveVersionId"
          LEFT JOIN "User" u ON u.id = a."userId"
        ),
        filtered AS (
          SELECT *
          FROM attrs
          WHERE "pageVerId" IS NOT NULL
            AND NOT (has_non_submitter AND type = 'SUBMITTER')
        ),
        dedup AS (
          SELECT DISTINCT ON ("wikidotId", COALESCE("resolvedUserId"::text, "anonKey"))
            "wikidotId",
            "attribUserId" AS "userId",
            CASE
              WHEN "userDisplayName" IS NOT NULL THEN "userDisplayName"
              WHEN "userUsername" IS NOT NULL THEN "userUsername"
              WHEN "anonKey" IS NOT NULL THEN regexp_replace("anonKey", '^anon:', '')
              ELSE NULL
            END AS "displayName",
            "userWikidotId",
            type,
            "order",
            date
          FROM filtered
          ORDER BY "wikidotId", COALESCE("resolvedUserId"::text, "anonKey"), type ASC, "order" ASC
        )
        SELECT
          "wikidotId",
          "userId",
          "displayName",
          "userWikidotId",
          type,
          "order",
          date
        FROM dedup
        ORDER BY "wikidotId" ASC, type ASC, "order" ASC
      `;

      const { rows } = await readPool.query(sql, [ids]);
      const byWikidotId = new Map<number, Array<{
        userId: number | null;
        displayName: string | null;
        userWikidotId: number | null;
        type: string | null;
        order: number | null;
        date: string | null;
      }>>();

      for (const row of rows) {
        const wikidotId = Number(row.wikidotId);
        if (!Number.isInteger(wikidotId) || wikidotId <= 0) continue;
        const list = byWikidotId.get(wikidotId) ?? [];
        list.push({
          userId: row.userId == null ? null : Number(row.userId),
          displayName: row.displayName ?? null,
          userWikidotId: row.userWikidotId == null ? null : Number(row.userWikidotId),
          type: row.type ?? null,
          order: row.order == null ? null : Number(row.order),
          date: row.date == null ? null : String(row.date)
        });
        byWikidotId.set(wikidotId, list);
      }

      res.json({
        items: ids.map((wikidotId) => ({
          wikidotId,
          attributions: byWikidotId.get(wikidotId) ?? []
        }))
      });
    } catch (err) {
      next(err);
    }
  });

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

      const { rows } = await readPool.query(sql, [context.effectiveVersionId]);

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
        // isHidden and isUserPage are accepted but not used in the query
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
          
        ORDER BY ${orderColumn} ${dir} NULLS LAST, p.id DESC
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
        Math.min(Math.max(0, Number(limit) | 0) || 20, 200),
        Math.max(0, Number(offset) | 0)
      ];

      const { rows } = await readPool.query(sql, params);
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
      const wikidotIdInt = parsePositiveInt(wikidotId);
      if (wikidotIdInt === null) {
        return res.status(400).json({ error: 'invalid_wikidotId' });
      }

      const cacheKey = `pages:by-id:${wikidotIdInt}`;
      const result = await cache.remember(cacheKey, 120, async () => {
        const row = await selectLatestPageVersion('p."wikidotId" = $1', [wikidotIdInt]);
        if (!row) return null;
        const merged = await mergeDeletedWithLatestLiveVersion(row);
        if (!merged.wikidotId && row.pageWikidotId) {
          merged.wikidotId = row.pageWikidotId;
        }
        delete merged.pageWikidotId;
        return merged;
      });

      if (!result) return res.status(404).json({ error: 'not_found' });
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  // GET /api/wikidot-pages/latest-source
  // query: wikidotId or url
  router.get('/latest-source', async (req, res, next) => {
    try {
      const { wikidotId, url } = req.query as Record<string, string>;
      if (!wikidotId && !url) {
        return res.status(400).json({ error: 'wikidotId_or_url_required' });
      }

      let pageRow: { id: number; wikidotId: number | null; currentUrl: string | null } | null = null;

      if (wikidotId) {
        const wikidotIdNum = Number(wikidotId);
        if (!Number.isInteger(wikidotIdNum) || wikidotIdNum <= 0) {
          return res.status(400).json({ error: 'invalid_wikidotId' });
        }
        const { rows } = await readPool.query<{ id: number; wikidotId: number | null; currentUrl: string | null }>(
          'SELECT id, "wikidotId", "currentUrl" FROM "Page" WHERE "wikidotId" = $1 LIMIT 1',
          [wikidotIdNum]
        );
        if (rows.length === 0) return res.status(404).json({ error: 'not_found' });
        pageRow = rows[0];
      } else if (url) {
        const { rows } = await readPool.query<{ id: number; wikidotId: number | null; currentUrl: string | null }>(
          'SELECT id, "wikidotId", "currentUrl" FROM "Page" WHERE "currentUrl" = $1 LIMIT 1',
          [url]
        );
        if (rows.length === 0) return res.status(404).json({ error: 'not_found' });
        pageRow = rows[0];
      }

      if (!pageRow) return res.status(404).json({ error: 'not_found' });

      const context = await resolvePageContextByPageId(pageRow.id);
      if (!context) return res.status(404).json({ error: 'not_found' });

      const targetVersionId = context.effectiveVersionId ?? context.currentVersionId;
      if (!targetVersionId) return res.status(404).json({ error: 'not_found' });

      const latestSource = await readPool.query<{
        sourceVersionId: number;
        revisionId: number | null;
        revisionNumber: number | null;
        source: string | null;
        timestamp: string | null;
        isLatest: boolean;
      }>(
        `SELECT
            sv.id AS "sourceVersionId",
            sv."revisionId",
            sv."revisionNumber",
            sv.source,
            sv.timestamp,
            sv."isLatest"
         FROM "SourceVersion" sv
         WHERE sv."pageVersionId" = $1
           AND sv.source IS NOT NULL
         ORDER BY sv."isLatest" DESC, sv.timestamp DESC
         LIMIT 1`,
        [targetVersionId]
      );

      const basePayload = {
        wikidotId: pageRow.wikidotId,
        url: pageRow.currentUrl ?? (url || null),
        pageId: context.pageId,
        pageVersionId: targetVersionId
      };

      if (latestSource.rows.length > 0) {
        const row = latestSource.rows[0];
        return res.json({
          ...basePayload,
          sourceVersionId: row.sourceVersionId,
          revisionId: row.revisionId,
          revisionNumber: row.revisionNumber,
          source: row.source,
          timestamp: row.timestamp,
          origin: 'sourceVersion'
        });
      }

      // SourceVersion 没有源码时，fallback 到 PageVersion.source
      const pageVersionSource = await readPool.query<{ source: string | null }>(
        'SELECT source FROM "PageVersion" WHERE id = $1 LIMIT 1',
        [targetVersionId]
      );
      const fallbackSource = pageVersionSource.rows[0]?.source ?? null;
      if (fallbackSource) {
        return res.json({
          ...basePayload,
          sourceVersionId: null,
          revisionId: null,
          revisionNumber: null,
          source: fallbackSource,
          timestamp: null,
          origin: 'pageVersion'
        });
      }

      return res.json({
        ...basePayload,
        sourceVersionId: null,
        revisionId: null,
        revisionNumber: null,
        source: null,
        timestamp: null,
        origin: 'none'
      });
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
      const { rows } = await readPool.query(sql, [url, limit]);
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
        const { rows } = await readPool.query(sampledSql, [limitValue]);
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
        const { rows: fallbackRows } = await readPool.query(fallbackSql, [limitValue]);
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
        // 只获取源码和文本的前 3000 字符用于摘要提取，避免响应体过大
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
          SUBSTRING(pv.source FOR 3000) AS source,
          SUBSTRING(pv."textContent" FOR 2000) AS "textContent",
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
              SELECT DISTINCT ON (COALESCE(u.id::text, a."anonKey"))
                CASE
                  WHEN u."displayName" IS NOT NULL THEN u."displayName"
                  WHEN a."anonKey" IS NOT NULL THEN regexp_replace(a."anonKey", '^anon:', '')
                  ELSE NULL
                END AS "displayName",
                u."wikidotId"   AS "userWikidotId",
                ROW_NUMBER() OVER (ORDER BY COALESCE(u.id::text, a."anonKey"), a.type ASC, a."order" ASC) AS rank
              FROM (
                SELECT 
                  a.*,
                  BOOL_OR(a.type <> 'SUBMITTER') OVER (PARTITION BY a."pageVerId") AS has_non_submitter
                FROM "Attribution" a
                WHERE a."pageVerId" = pv.id
              ) a
              LEFT JOIN "User" u ON u.id = a."userId"
              WHERE NOT (a.has_non_submitter AND a.type = 'SUBMITTER')
              ORDER BY COALESCE(u.id::text, a."anonKey"), a.type ASC, a."order" ASC
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
        const { rows } = await readPool.query(sql, [context.effectiveVersionId, limit, offset, type || null]);
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
      const { rows } = await readPool.query(sql, [context.pageId, limit, offset, type || null]);
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
        const { rows } = await readPool.query(
          `SELECT COUNT(*)::int AS total
             FROM "Revision" r
            WHERE r."pageVersionId" = $1
              AND ($2::text IS NULL OR r.type = $2::text)`,
          [context.effectiveVersionId, type || null]
        );
        return res.json(rows[0] || { total: 0 });
      }

      const { rows } = await readPool.query(
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
        WITH attrs AS (
          SELECT 
            a.*,
            BOOL_OR(a.type <> 'SUBMITTER') OVER (PARTITION BY a."pageVerId") AS has_non_submitter
          FROM "Attribution" a
          WHERE a."pageVerId" = $1
        ),
        filtered AS (
          SELECT * FROM attrs
          WHERE NOT (has_non_submitter AND type = 'SUBMITTER')
        )
        SELECT DISTINCT ON (COALESCE(u.id::text, a."anonKey"))
          a."userId" AS "userId",
          CASE
            WHEN u."displayName" IS NOT NULL THEN u."displayName"
            WHEN a."anonKey" IS NOT NULL THEN regexp_replace(a."anonKey", '^anon:', '')
            ELSE NULL
          END AS "displayName",
          u."wikidotId" AS "userWikidotId",
          a.type,
          a."order",
          a.date
        FROM filtered a
        LEFT JOIN "User" u ON u.id = a."userId"
        ORDER BY COALESCE(u.id::text, a."anonKey"), a.type ASC, a."order" ASC
      `;
      const { rows } = await readPool.query(sql, [context.effectiveVersionId]);
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
          SELECT COALESCE(JSON_AGG(j ORDER BY j_rank) FILTER (WHERE j IS NOT NULL), '[]'::json) AS attributions
          FROM (
            SELECT DISTINCT ON (COALESCE(u.id::text, a."anonKey"))
              JSON_BUILD_OBJECT(
                'userId', u.id,
                'displayName',
                  CASE
                    WHEN u."displayName" IS NOT NULL THEN u."displayName"
                    WHEN a."anonKey" IS NOT NULL THEN regexp_replace(a."anonKey", '^anon:', '')
                    ELSE NULL
                  END,
                'userWikidotId', u."wikidotId",
                'type', a.type
              ) AS j,
              ROW_NUMBER() OVER (ORDER BY COALESCE(u.id::text, a."anonKey"), a.type ASC, a."order" ASC) AS j_rank
            FROM (
              SELECT 
                a.*,
                BOOL_OR(a.type <> 'SUBMITTER') OVER (PARTITION BY a."pageVerId") AS has_non_submitter
              FROM "Attribution" a
              WHERE a."pageVerId" = pv.id
            ) a
            LEFT JOIN "User" u ON u.id = a."userId"
            WHERE NOT (a.has_non_submitter AND a.type = 'SUBMITTER')
            ORDER BY COALESCE(u.id::text, a."anonKey"), a.type ASC, a."order" ASC
          ) s
        ) attrs ON TRUE
        WHERE pv."wikidotId" = $1::int
        ORDER BY pv.id DESC
        LIMIT $2::int OFFSET $3::int
      `;
      const { rows } = await readPool.query(sql, [wikidotId, limit, offset]);
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
      const check = await readPool.query(
        `SELECT 1 FROM "PageVersion" pv WHERE pv.id = $1::int AND pv."wikidotId" = $2::int LIMIT 1`,
        [versionId, wikidotId]
      );
      if (check.rowCount === 0) return res.status(404).json({ error: 'not_found' });

      const sql = `
        WITH attrs AS (
          SELECT 
            a.*,
            BOOL_OR(a.type <> 'SUBMITTER') OVER (PARTITION BY a."pageVerId") AS has_non_submitter
          FROM "Attribution" a
          WHERE a."pageVerId" = $1
        ),
        filtered AS (
          SELECT * FROM attrs
          WHERE NOT (has_non_submitter AND type = 'SUBMITTER')
        )
        SELECT DISTINCT ON (COALESCE(u.id::text, a."anonKey"))
          a."userId" AS "userId",
          CASE
            WHEN u."displayName" IS NOT NULL THEN u."displayName"
            WHEN a."anonKey" IS NOT NULL THEN regexp_replace(a."anonKey", '^anon:', '')
            ELSE NULL
          END AS "displayName",
          u."wikidotId" AS "userWikidotId",
          a.type,
          a."order",
          a.date
        FROM filtered a
        LEFT JOIN "User" u ON u.id = a."userId"
        ORDER BY COALESCE(u.id::text, a."anonKey"), a.type ASC, a."order" ASC
      `;
      const { rows } = await readPool.query(sql, [versionId]);
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
      const { rows } = await readPool.query(sql, [wikidotId, versionId]);
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
      const { rows } = await readPool.query(sql, [context.effectiveVersionId, limit, offset]);
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
      const { rows } = await readPool.query(
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
      const base = await readPool.query(
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
      const primary = await readPool.query(
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
      const fallbackPrev = await readPool.query(
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
      const pvRow = await readPool.query(
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

      const primary = await readPool.query<{ textContent: string | null }>(
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

      const fallback = await readPool.query<{ textContent: string | null }>(
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

      const pv = await readPool.query(
        `SELECT pv.source
           FROM "PageVersion" pv
          WHERE pv.id = $1
          LIMIT 1`,
        [targetVersionId]
      );
      if (pv.rows.length === 0) return res.status(404).json({ error: 'not_found' });
      if (pv.rows[0].source) return res.json({ source: pv.rows[0].source, origin: 'pageVersion' });

      // 2) 否则回退到最新一条带源码的 SourceVersion
      const lastWithSource = await readPool.query(
        `SELECT sv.id AS "sourceVersionId", sv."revisionId", sv."revisionNumber", sv.source
         FROM "SourceVersion" sv
         WHERE sv."pageVersionId" = $1::int AND sv.source IS NOT NULL
         ORDER BY sv."isLatest" DESC, sv.timestamp DESC
         LIMIT 1`,
        [targetVersionId]
      );
      if (lastWithSource.rows.length > 0) {
        const sv = lastWithSource.rows[0];
        return res.json({
          source: sv.source,
          origin: 'sourceVersion',
          sourceVersionId: sv.sourceVersionId,
          revisionId: sv.revisionId,
          revisionNumber: sv.revisionNumber
        });
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

      // 使用 Redis 缓存（explore > 0 时跳过缓存，因为结果有随机性）
      const shouldCache = explore === 0;
      const cacheKey = shouldCache
        ? `recommendations:${wikidotId}:${limitInt}:${strat}:${tagWeight}:${authorWeight}:${minTagOverlap}:${minAuthorOverlap}:${sameCategoryOnly}:${excludeUserPages}:${diversity}:${weighting}:${excludeCommon}:${mmrLambda}:${excludedTags.sort().join('|')}`
        : null;

      if (cacheKey) {
        const cached = await cache.getJSON(cacheKey);
        if (cached) {
          return res.json(cached);
        }
      }

      // 取候选集合（打齐标签与作者重合信息）
      const context = await resolvePageContextByWikidotId(wikidotId);
      if (!context || !context.effectiveVersionId) return res.json([]);

      // Step 1: Fetch target page tags + authors
      const targetSql = `
        SELECT pv.tags,
               pv.category,
               (
                 SELECT COALESCE(ARRAY_AGG(DISTINCT a."userId") FILTER (WHERE a."userId" IS NOT NULL), ARRAY[]::int[])
                 FROM "Attribution" a
                 WHERE a."pageVerId" = pv.id
                   AND NOT (
                     a.type = 'SUBMITTER'
                     AND EXISTS (
                       SELECT 1 FROM "Attribution" ax
                       WHERE ax."pageVerId" = pv.id AND ax.type <> 'SUBMITTER'
                     )
                   )
               ) AS authors
        FROM "PageVersion" pv
        WHERE pv.id = $1
        LIMIT 1
      `;
      const targetResult = await readPool.query(targetSql, [context.effectiveVersionId]);
      if (targetResult.rowCount === 0) return res.json([]);
      const target = targetResult.rows[0];
      const targetTags: string[] = Array.isArray(target.tags) ? target.tags : [];
      const targetAuthors: number[] = Array.isArray(target.authors) ? target.authors : [];
      const excludedSet = new Set(excludedTags);
      const relevantTargetTags = targetTags.filter(t => !excludedSet.has(t));
      if (relevantTargetTags.length === 0 && targetAuthors.length === 0) return res.json([]);

      // Step 2: Compute tag IDF from tag_freq (only for relevant target tags)
      const tagIdf = new Map<string, number>();
      if (relevantTargetTags.length > 0) {
        const tagFreqSql = `
          SELECT t.tag, COUNT(*)::int AS cnt
          FROM UNNEST($1::text[]) AS t(tag)
          JOIN "PageVersion" pv ON pv."validTo" IS NULL AND pv.tags @> ARRAY[t.tag]::text[]
          GROUP BY t.tag
        `;
        const tagFreqResult = await readPool.query(tagFreqSql, [relevantTargetTags]);
        for (const row of tagFreqResult.rows) {
          tagIdf.set(row.tag, 1.0 / Math.log(Math.max(Number(row.cnt), 1) + 1));
        }
      }

      // Step 3: Fetch candidates — simple query, NO correlated subqueries
      const candidateSql = `
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
          (
            SELECT COALESCE(jsonb_agg(j) FILTER (WHERE j IS NOT NULL), '[]'::jsonb)
            FROM (
              SELECT DISTINCT ON (COALESCE(u."wikidotId"::text, a."anonKey"))
                jsonb_build_object(
                  'userId', u.id,
                  'displayName',
                    CASE
                      WHEN u."displayName" IS NOT NULL THEN u."displayName"
                      WHEN a."anonKey" IS NOT NULL THEN regexp_replace(a."anonKey", '^anon:', '')
                      ELSE NULL
                    END,
                  'wikidotId', u."wikidotId"
                ) AS j
              FROM "Attribution" a
              LEFT JOIN "User" u ON u.id = a."userId"
              WHERE a."pageVerId" = pv.id
                AND NOT (
                  a.type = 'SUBMITTER'
                  AND EXISTS (
                    SELECT 1 FROM "Attribution" ax
                    WHERE ax."pageVerId" = pv.id AND ax.type <> 'SUBMITTER'
                  )
                )
              ORDER BY COALESCE(u."wikidotId"::text, a."anonKey"), a.type ASC, a."order" ASC
            ) s
          ) AS authors_full
        FROM "PageVersion" pv
        JOIN "Page" p ON p.id = pv."pageId"
        LEFT JOIN "PageStats" ps ON ps."pageVersionId" = pv.id
        WHERE pv."validTo" IS NULL
          AND pv."pageId" <> $2
          AND (
            pv.tags && $3::text[]
            OR EXISTS (
              SELECT 1 FROM "Attribution" a3
              WHERE a3."pageVerId" = pv.id
                AND a3."userId" = ANY($4::int[])
                AND NOT (a3.type = 'SUBMITTER' AND EXISTS (
                  SELECT 1 FROM "Attribution" ax WHERE ax."pageVerId" = pv.id AND ax.type <> 'SUBMITTER'
                ))
            )
          )
          AND ($5::boolean = false OR pv.category = $6)
          AND ($7::boolean = false OR NOT (pv.tags && ARRAY['作者','段落','补充材料']::text[]))
        ORDER BY pv.rating DESC NULLS LAST, pv."createdAt" DESC
        LIMIT $1::int
      `;
      const { rows } = await readPool.query(candidateSql, [
        candidateLimit,
        context.pageId,
        relevantTargetTags.length > 0 ? relevantTargetTags : [],
        targetAuthors,
        sameCategoryOnly,
        target.category,
        excludeUserPages
      ]);

      // Step 4: Node-layer scoring — compute overlaps in memory
      const targetTagSet = new Set(relevantTargetTags);
      const targetAuthorSet = new Set(targetAuthors);

      type Rec = any & { tag_overlap: number; tag_overlap_weighted?: number; author_overlap: number; matched_tags: string[]; matched_authors: Array<{userId:number;displayName:string|null;wikidotId:number|null}> };
      const candidates: Rec[] = rows.map((r: any) => {
        const pageTags: string[] = Array.isArray(r.tags) ? r.tags : [];
        const matched_tags = pageTags.filter(t => targetTagSet.has(t));
        const tag_overlap = matched_tags.length;
        let tag_overlap_weighted = 0;
        for (const t of matched_tags) {
          tag_overlap_weighted += tagIdf.get(t) ?? 0;
        }

        const authorsFull: Array<{userId: number; displayName: string|null; wikidotId: number|null}> = Array.isArray(r.authors_full) ? r.authors_full : [];
        const matched_authors = authorsFull.filter((a: any) => targetAuthorSet.has(Number(a.userId)));
        const author_overlap = matched_authors.length;

        return {
          ...r,
          tag_overlap,
          tag_overlap_weighted,
          author_overlap,
          matched_tags,
          matched_authors
        };
      });

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

      // 写入缓存（TTL 7天 - 推荐内容变化较慢，长缓存减少数据库压力）
      if (cacheKey) {
        await cache.setJSON(cacheKey, payload, 7 * 24 * 60 * 60);
      }

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

      const images = await loadPageVersionImagesWithFallback(targetId);
      res.json(images);
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
      const { rows } = await readPool.query(sql, [context.effectiveVersionId]);
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

      const cacheKey = `pages:${wikidotId}:vote-distribution`;
      const result = await cache.remember(cacheKey, 180, async () => {
        const sql = `
          SELECT
            COUNT(CASE WHEN v.direction > 0 THEN 1 END) as upvotes,
            COUNT(CASE WHEN v.direction < 0 THEN 1 END) as downvotes,
            COUNT(CASE WHEN v.direction = 0 THEN 1 END) as novotes,
            COUNT(*) as total
          FROM "LatestVote" v
          WHERE v."pageVersionId" = $1
        `;
        const { rows } = await readPool.query(sql, [context.effectiveVersionId]);
        return rows[0] || { upvotes: 0, downvotes: 0, novotes: 0, total: 0 };
      });

      res.json(result);
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
      const { rows } = await readPool.query(sql, [pageId, limit]);
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

      const cacheKey = `pages:${wikidotId}:rating-history:${granularity}`;
      const result = await cache.remember(cacheKey, 300, async () => {
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
              (CASE WHEN current_direction > 0 THEN 1 ELSE 0 END) - (CASE WHEN COALESCE(prev_direction, 0) > 0 THEN 1 ELSE 0 END) AS up_delta,
              (CASE WHEN current_direction < 0 THEN 1 ELSE 0 END) - (CASE WHEN COALESCE(prev_direction, 0) < 0 THEN 1 ELSE 0 END) AS down_delta,
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
        const { rows } = await readPool.query(sql, [context.effectiveVersionId]);
        return rows;
      });

      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
