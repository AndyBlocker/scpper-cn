import { Router } from 'express';
import type { Pool } from 'pg';
import type { RedisClientType } from 'redis';
import { getReadPoolSync } from '../utils/dbPool.js';

const CACHE_VERSION = 'v4';

type DeletedFilterMode = 'any' | 'only' | 'exclude';

type PageSearchArgs = {
  trimmedQuery: string;
  limit: number;
  offset: number;
  includeTags: string[] | null;
  excludeTags: string[] | null;
  ratingMin: number | null;
  ratingMax: number | null;
  enforceExactTags: boolean;
  normalizedOrder: string;
  deletedFilter: DeletedFilterMode;
  wantTotal: boolean;
  wantSnippet: boolean;
  wantDate: boolean;
  candidateLimit: number;
  snippetTop: number;
  // 新增过滤条件
  wilson95Min: number | null;
  wilson95Max: number | null;
  controversyMin: number | null;
  controversyMax: number | null;
  commentCountMin: number | null;
  commentCountMax: number | null;
  voteCountMin: number | null;
  voteCountMax: number | null;
  dateMin: string | null;
  dateMax: string | null;
};

type PageSearchResult = {
  results: any[];
  total?: number;
};

export function searchRouter(pool: Pool, redis: RedisClientType | null) {
  const router = Router();

  // 读写分离：search 全部是读操作，使用从库
  const readPool = getReadPoolSync();

  const defaultCacheTtl = (() => {
    const parsed = Number(process.env.SEARCH_CACHE_TTL ?? 30);
    if (!Number.isFinite(parsed) || parsed < 0) return 0;
    return Math.floor(parsed);
  })();

  const defaultSnippetTopK = (() => {
    const parsed = Number(process.env.SEARCH_SNIPPET_TOP_K ?? 10);
    if (!Number.isFinite(parsed) || parsed < 1) return 10;
    return Math.floor(parsed);
  })();

  function buildCacheKey(prefix: string, params: Record<string, unknown>): string | null {
    if (!redis) return null;
    const normalized = Object.entries(params)
      .filter(([, value]) => value !== undefined && value !== null && value !== '')
      .map(([key, value]) => {
        if (Array.isArray(value)) {
          const elements = value
            .map((v) => (v === undefined || v === null ? '' : String(v)))
            .sort()
            .join(',');
          return `${key}=${elements}`;
        }
        if (typeof value === 'object') {
          return `${key}=${JSON.stringify(value)}`;
        }
        return `${key}=${value}`;
      })
      .sort()
      .join('&');
    return `${prefix}:${CACHE_VERSION}:${normalized}`;
  }

  async function readCache<T>(key: string | null): Promise<T | null> {
    if (!redis || !key) return null;
    try {
      const cached = await redis.get(key);
      if (!cached) return null;
      return JSON.parse(cached) as T;
    } catch (err) {
      console.warn('[search-cache] Failed to read cache:', err);
      return null;
    }
  }

  async function writeCache<T>(key: string | null, payload: T, ttlSeconds: number): Promise<void> {
    if (!redis || !key || ttlSeconds <= 0) return;
    try {
      await redis.set(key, JSON.stringify(payload), { EX: ttlSeconds });
    } catch (err) {
      console.warn('[search-cache] Failed to write cache:', err);
    }
  }

  const parseNullableInt = (value: string | undefined): number | null => {
    if (value === undefined || value === null || value === '') return null;
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return null;
    return Math.trunc(parsed);
  };

  const parseNullableFloat = (value: string | undefined): number | null => {
    if (value === undefined || value === null || value === '') return null;
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return null;
    return parsed;
  };

  const parseNullableDate = (value: string | undefined): string | null => {
    if (value === undefined || value === null || value === '') return null;
    // 支持 YYYY-MM-DD 格式
    const dateMatch = String(value).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!dateMatch) return null;
    const [, year, month, day] = dateMatch;
    const y = parseInt(year, 10);
    const m = parseInt(month, 10);
    const d = parseInt(day, 10);
    if (y < 1970 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
    return `${year}-${month}-${day}`;
  };

  const normalizeDeletedFilter = (raw: string | undefined): DeletedFilterMode => {
    const normalized = String(raw || 'any').toLowerCase();
    if (normalized === 'only') return 'only';
    if (normalized === 'exclude') return 'exclude';
    return 'any';
  };

  const buildDeletedFilterClause = (mode: DeletedFilterMode): string => {
    if (mode === 'exclude') return ' AND pv."isDeleted" = false';
    if (mode === 'only') return ' AND pv."isDeleted" = true';
    return '';
  };

  function extractExcerpt(textContent: string | null, maxLength = 160): string | null {
    if (!textContent) return null;
    const cleanText = textContent
      .replace(/\[\[[^\]]*\]\]/g, '')
      .replace(/\{\{[^}]*\}\}/g, '')
      .replace(/<[^>]+>/g, '')
      .replace(/^[#*\-+>|\s]+/gm, '')
      .replace(/\n+/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();

    if (!cleanText) return null;

    const sentences = (cleanText.match(/[^。！？.!?]+[。！？.!?]+/g) || [])
      .map((s) => s.trim())
      .filter((s) => s.length > 12);
    const chosen = sentences.length > 0 ? sentences[Math.floor(Math.random() * sentences.length)] : cleanText;
    const normalized = chosen.trim();
    if (!normalized) return null;

    if (normalized.length <= maxLength) {
      return normalized;
    }
    return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
  }

  async function executePageSearch(args: PageSearchArgs): Promise<PageSearchResult> {
    const {
      trimmedQuery,
      limit,
      offset,
      includeTags,
      excludeTags,
      ratingMin,
      ratingMax,
      enforceExactTags,
      normalizedOrder,
      deletedFilter,
      wantTotal,
      wantSnippet,
      wantDate,
      candidateLimit,
      snippetTop,
      wilson95Min,
      wilson95Max,
      controversyMin,
      controversyMax,
      commentCountMin,
      commentCountMax,
      voteCountMin,
      voteCountMax,
      dateMin,
      dateMax
    } = args;

    const includeTagsParam = includeTags && includeTags.length > 0 ? includeTags : null;
    const excludeTagsParam = excludeTags && excludeTags.length > 0 ? excludeTags : null;
    const ratingMinParam = typeof ratingMin === 'number' ? ratingMin : null;
    const ratingMaxParam = typeof ratingMax === 'number' ? ratingMax : null;
    const wilson95MinParam = typeof wilson95Min === 'number' ? wilson95Min : null;
    const wilson95MaxParam = typeof wilson95Max === 'number' ? wilson95Max : null;
    const controversyMinParam = typeof controversyMin === 'number' ? controversyMin : null;
    const controversyMaxParam = typeof controversyMax === 'number' ? controversyMax : null;
    const commentCountMinParam = typeof commentCountMin === 'number' ? commentCountMin : null;
    const commentCountMaxParam = typeof commentCountMax === 'number' ? commentCountMax : null;
    const voteCountMinParam = typeof voteCountMin === 'number' ? voteCountMin : null;
    const voteCountMaxParam = typeof voteCountMax === 'number' ? voteCountMax : null;
    const dateMinParam = dateMin || null;
    const dateMaxParam = dateMax || null;
    const deletedFilterClause = buildDeletedFilterClause(deletedFilter);
    const hasQuery = trimmedQuery.length > 0;

    if (!hasQuery) {
      // 无查询模式：纯过滤
      // 优化：分两步处理，避免对非删除页面执行不必要的LATERAL子查询
      // 1. 先筛选非删除页面（直接使用索引）
      // 2. 再处理已删除页面（需要LATERAL子查询获取前一个版本数据）
      const baseSql = `
          WITH active_pages AS (
            -- 非删除页面：直接使用当前版本数据，利用索引
            SELECT
              pv.id,
              COALESCE(pv."wikidotId", p."wikidotId") AS "wikidotId",
              pv."pageId",
              pv.title,
              pv."alternateTitle",
              p."currentUrl" AS url,
              p."firstPublishedAt" AS "firstRevisionAt",
              pv.rating,
              pv."voteCount",
              pv."revisionCount",
              pv."commentCount",
              COALESCE(pv.tags, ARRAY[]::text[]) AS tags,
              false AS "isDeleted",
              NULL::timestamp AS "deletedAt",
              pv."validFrom",
              ps."wilson95",
              ps."controversy"
            FROM "PageVersion" pv
            JOIN "Page" p ON pv."pageId" = p.id
            LEFT JOIN "PageStats" ps ON ps."pageVersionId" = pv.id
            WHERE pv."validTo" IS NULL
              AND pv."isDeleted" = false
              AND ($1::text[] IS NULL OR COALESCE(pv.tags, ARRAY[]::text[]) @> $1::text[])
              AND ($2::text[] IS NULL OR NOT (COALESCE(pv.tags, ARRAY[]::text[]) && $2::text[]))
              AND ($3::int IS NULL OR pv.rating >= $3)
              AND ($4::int IS NULL OR pv.rating <= $4)
              AND (($5)::boolean IS NOT TRUE OR $1::text[] IS NULL OR COALESCE(pv.tags, ARRAY[]::text[]) <@ $1::text[])
              AND ($9::float IS NULL OR ps."wilson95" >= $9)
              AND ($10::float IS NULL OR ps."wilson95" <= $10)
              AND ($11::float IS NULL OR ps."controversy" >= $11)
              AND ($12::float IS NULL OR ps."controversy" <= $12)
              AND ($13::int IS NULL OR pv."commentCount" >= $13)
              AND ($14::int IS NULL OR pv."commentCount" <= $14)
              AND ($15::int IS NULL OR pv."voteCount" >= $15)
              AND ($16::int IS NULL OR pv."voteCount" <= $16)
              AND ($17::date IS NULL OR p."firstPublishedAt" >= $17::date)
              AND ($18::date IS NULL OR p."firstPublishedAt" <= $18::date)
          ),
          deleted_pages AS (
            -- 已删除页面：需要LATERAL子查询获取前一个有效版本
            SELECT
              pv.id,
              COALESCE(pv."wikidotId", p."wikidotId") AS "wikidotId",
              pv."pageId",
              pv.title,
              pv."alternateTitle",
              p."currentUrl" AS url,
              p."firstPublishedAt" AS "firstRevisionAt",
              prev.rating,
              prev."voteCount",
              pv."revisionCount",
              prev."commentCount",
              COALESCE(prev.tags, ARRAY[]::text[]) AS tags,
              true AS "isDeleted",
              pv."validFrom" AS "deletedAt",
              pv."validFrom",
              ps."wilson95",
              ps."controversy"
            FROM "PageVersion" pv
            JOIN "Page" p ON pv."pageId" = p.id
            LEFT JOIN "PageStats" ps ON ps."pageVersionId" = pv.id
            LEFT JOIN LATERAL (
              SELECT rating, "voteCount", "commentCount", tags
              FROM "PageVersion" pv_prev
              WHERE pv_prev."pageId" = pv."pageId"
                AND pv_prev."isDeleted" = false
              ORDER BY pv_prev."validTo" DESC NULLS LAST, pv_prev.id DESC
              LIMIT 1
            ) prev ON TRUE
            WHERE pv."validTo" IS NULL
              AND pv."isDeleted" = true
              AND ($1::text[] IS NULL OR COALESCE(prev.tags, ARRAY[]::text[]) @> $1::text[])
              AND ($2::text[] IS NULL OR NOT (COALESCE(prev.tags, ARRAY[]::text[]) && $2::text[]))
              AND ($3::int IS NULL OR prev.rating >= $3)
              AND ($4::int IS NULL OR prev.rating <= $4)
              AND (($5)::boolean IS NOT TRUE OR $1::text[] IS NULL OR COALESCE(prev.tags, ARRAY[]::text[]) <@ $1::text[])
              AND ($9::float IS NULL OR ps."wilson95" >= $9)
              AND ($10::float IS NULL OR ps."wilson95" <= $10)
              AND ($11::float IS NULL OR ps."controversy" >= $11)
              AND ($12::float IS NULL OR ps."controversy" <= $12)
              AND ($13::int IS NULL OR prev."commentCount" >= $13)
              AND ($14::int IS NULL OR prev."commentCount" <= $14)
              AND ($15::int IS NULL OR prev."voteCount" >= $15)
              AND ($16::int IS NULL OR prev."voteCount" <= $16)
              AND ($17::date IS NULL OR p."firstPublishedAt" >= $17::date)
              AND ($18::date IS NULL OR p."firstPublishedAt" <= $18::date)
          ),
          base AS (
            ${deletedFilter === 'only' ? 'SELECT * FROM deleted_pages' :
              deletedFilter === 'exclude' ? 'SELECT * FROM active_pages' :
              'SELECT * FROM active_pages UNION ALL SELECT * FROM deleted_pages'}
          )
        `;

      const finalSql = `${baseSql}
          SELECT b.*
          FROM base b
          ORDER BY
            CASE WHEN $6 = 'rating' THEN b.rating END DESC NULLS LAST,
            CASE WHEN $6 = 'rating_asc' THEN b.rating END ASC NULLS LAST,
            CASE WHEN $6 = 'recent' THEN COALESCE(b."firstRevisionAt", b."validFrom") END DESC NULLS LAST,
            CASE WHEN $6 = 'recent_asc' THEN COALESCE(b."firstRevisionAt", b."validFrom") END ASC NULLS LAST,
            CASE WHEN $6 = 'wilson95' THEN b."wilson95" END DESC NULLS LAST,
            CASE WHEN $6 = 'wilson95_asc' THEN b."wilson95" END ASC NULLS LAST,
            CASE WHEN $6 = 'controversy' THEN b."controversy" END DESC NULLS LAST,
            CASE WHEN $6 = 'controversy_asc' THEN b."controversy" END ASC NULLS LAST,
            CASE WHEN $6 = 'comment_count' THEN b."commentCount" END DESC NULLS LAST,
            CASE WHEN $6 = 'comment_count_asc' THEN b."commentCount" END ASC NULLS LAST,
            CASE WHEN $6 = 'vote_count' THEN b."voteCount" END DESC NULLS LAST,
            CASE WHEN $6 = 'vote_count_asc' THEN b."voteCount" END ASC NULLS LAST,
            b.rating DESC NULLS LAST,
            b."firstRevisionAt" DESC NULLS LAST,
            b.id DESC
          LIMIT $7::int OFFSET $8::int
        `;

      const params = [
        includeTagsParam,       // $1
        excludeTagsParam,       // $2
        ratingMinParam,         // $3
        ratingMaxParam,         // $4
        enforceExactTags,       // $5
        normalizedOrder,        // $6
        limit,                  // $7
        offset,                 // $8
        wilson95MinParam,       // $9
        wilson95MaxParam,       // $10
        controversyMinParam,    // $11
        controversyMaxParam,    // $12
        commentCountMinParam,   // $13
        commentCountMaxParam,   // $14
        voteCountMinParam,      // $15
        voteCountMaxParam,      // $16
        dateMinParam,           // $17
        dateMaxParam            // $18
      ];

      // 优化的 total 计数查询
      const buildTotalSql = () => {
        const activeCountSql = `
          SELECT COUNT(*) AS cnt
          FROM "PageVersion" pv
          JOIN "Page" p ON pv."pageId" = p.id
          LEFT JOIN "PageStats" ps ON ps."pageVersionId" = pv.id
          WHERE pv."validTo" IS NULL
            AND pv."isDeleted" = false
            AND ($1::text[] IS NULL OR COALESCE(pv.tags, ARRAY[]::text[]) @> $1::text[])
            AND ($2::text[] IS NULL OR NOT (COALESCE(pv.tags, ARRAY[]::text[]) && $2::text[]))
            AND ($3::int IS NULL OR pv.rating >= $3)
            AND ($4::int IS NULL OR pv.rating <= $4)
            AND (($5)::boolean IS NOT TRUE OR $1::text[] IS NULL OR COALESCE(pv.tags, ARRAY[]::text[]) <@ $1::text[])
            AND ($6::float IS NULL OR ps."wilson95" >= $6)
            AND ($7::float IS NULL OR ps."wilson95" <= $7)
            AND ($8::float IS NULL OR ps."controversy" >= $8)
            AND ($9::float IS NULL OR ps."controversy" <= $9)
            AND ($10::int IS NULL OR pv."commentCount" >= $10)
            AND ($11::int IS NULL OR pv."commentCount" <= $11)
            AND ($12::int IS NULL OR pv."voteCount" >= $12)
            AND ($13::int IS NULL OR pv."voteCount" <= $13)
            AND ($14::date IS NULL OR p."firstPublishedAt" >= $14::date)
            AND ($15::date IS NULL OR p."firstPublishedAt" <= $15::date)
        `;
        const deletedCountSql = `
          SELECT COUNT(*) AS cnt
          FROM "PageVersion" pv
          JOIN "Page" p ON pv."pageId" = p.id
          LEFT JOIN "PageStats" ps ON ps."pageVersionId" = pv.id
          LEFT JOIN LATERAL (
            SELECT rating, "voteCount", "commentCount", tags
            FROM "PageVersion" pv_prev
            WHERE pv_prev."pageId" = pv."pageId"
              AND pv_prev."isDeleted" = false
            ORDER BY pv_prev."validTo" DESC NULLS LAST, pv_prev.id DESC
            LIMIT 1
          ) prev ON TRUE
          WHERE pv."validTo" IS NULL
            AND pv."isDeleted" = true
            AND ($1::text[] IS NULL OR COALESCE(prev.tags, ARRAY[]::text[]) @> $1::text[])
            AND ($2::text[] IS NULL OR NOT (COALESCE(prev.tags, ARRAY[]::text[]) && $2::text[]))
            AND ($3::int IS NULL OR prev.rating >= $3)
            AND ($4::int IS NULL OR prev.rating <= $4)
            AND (($5)::boolean IS NOT TRUE OR $1::text[] IS NULL OR COALESCE(prev.tags, ARRAY[]::text[]) <@ $1::text[])
            AND ($6::float IS NULL OR ps."wilson95" >= $6)
            AND ($7::float IS NULL OR ps."wilson95" <= $7)
            AND ($8::float IS NULL OR ps."controversy" >= $8)
            AND ($9::float IS NULL OR ps."controversy" <= $9)
            AND ($10::int IS NULL OR prev."commentCount" >= $10)
            AND ($11::int IS NULL OR prev."commentCount" <= $11)
            AND ($12::int IS NULL OR prev."voteCount" >= $12)
            AND ($13::int IS NULL OR prev."voteCount" <= $13)
            AND ($14::date IS NULL OR p."firstPublishedAt" >= $14::date)
            AND ($15::date IS NULL OR p."firstPublishedAt" <= $15::date)
        `;
        if (deletedFilter === 'exclude') return activeCountSql;
        if (deletedFilter === 'only') return deletedCountSql;
        // any: 合并两个计数
        return `SELECT (active.cnt + deleted.cnt) AS total FROM (${activeCountSql}) active, (${deletedCountSql}) deleted`;
      };

      const totalParams = [
        includeTagsParam,       // $1
        excludeTagsParam,       // $2
        ratingMinParam,         // $3
        ratingMaxParam,         // $4
        enforceExactTags,       // $5
        wilson95MinParam,       // $6
        wilson95MaxParam,       // $7
        controversyMinParam,    // $8
        controversyMaxParam,    // $9
        commentCountMinParam,   // $10
        commentCountMaxParam,   // $11
        voteCountMinParam,      // $12
        voteCountMaxParam,      // $13
        dateMinParam,           // $14
        dateMaxParam            // $15
      ];

      const [{ rows }, totalRes] = await Promise.all([
        readPool.query(finalSql, params),
        wantTotal
          ? readPool.query(buildTotalSql(), totalParams)
          : Promise.resolve(null as any)
      ]);

      const total = totalRes ? Number(totalRes.rows?.[0]?.total ?? totalRes.rows?.[0]?.cnt ?? 0) : undefined;

      let snippetMap: Map<number, string | null> = new Map();
      if (wantSnippet && rows.length > 0) {
        const pageIds = Array.from(
          new Set(
            rows
              .map((row: any) => Number(row.pageId))
              .filter((id) => Number.isInteger(id) && id > 0)
          )
        );
        if (pageIds.length > 0) {
          const snippetSql = `
              SELECT pv."pageId" AS "pageId",
                     SUBSTRING(COALESCE(pv."search_text", '') FOR 2000) AS "textSnippet"
              FROM "PageVersion" pv
              WHERE pv."validTo" IS NULL
                AND pv."pageId" = ANY($1::int[])
                ${deletedFilterClause}
            `;
          const { rows: snippetRows } = await readPool.query(snippetSql, [pageIds]);
          snippetMap = new Map(
            snippetRows.map((row) => [
              Number(row.pageId),
              extractExcerpt(typeof row.textSnippet === 'string' ? row.textSnippet : null, 180)
            ])
          );
        }
      }

      const results = rows.map((r: any) => {
        const snippet = wantSnippet ? snippetMap.get(Number(r.pageId)) ?? null : null;
        const base = wantDate ? { ...r } : (({ firstRevisionAt, ...rest }) => rest)(r);
        return {
          ...base,
          snippet,
          excerpt: snippet,
          textScore: null
        };
      });

      return total !== undefined ? { results, total } : { results };
    }

    // 有查询模式：全文搜索 + 过滤
    const baseSql = `
        WITH url_hits AS (
          SELECT pv.id AS pv_id,
                 1.0 AS weight,
                 NULL::double precision AS score,
                 'url'::text AS source
          FROM "Page" p
          JOIN "PageVersion" pv ON pv."pageId" = p.id AND pv."validTo" IS NULL
          WHERE $1::text IS NOT NULL
            AND p."currentUrl" &@~ pgroonga_query_escape($1)
          LIMIT $10::int
        ),
        title_hits AS (
          SELECT pv.id AS pv_id,
                 0.9 AS weight,
                 pgroonga_score(pv.tableoid, pv.ctid) AS score,
                 'title'::text AS source
          FROM "PageVersion" pv
          WHERE pv."validTo" IS NULL
            AND pv.title &@~ pgroonga_query_escape($1)
          ORDER BY score DESC
          LIMIT $10::int
        ),
        alternate_hits AS (
          SELECT pv.id AS pv_id,
                 0.8 AS weight,
                 pgroonga_score(pv.tableoid, pv.ctid) AS score,
                 'alternate'::text AS source
          FROM "PageVersion" pv
          WHERE pv."validTo" IS NULL
            AND pv."alternateTitle" IS NOT NULL
            AND pv."alternateTitle" &@~ pgroonga_query_escape($1)
          ORDER BY score DESC
          LIMIT $10::int
        ),
        text_hits AS (
          SELECT pv.id AS pv_id,
                 0.5 AS weight,
                 pgroonga_score(pv.tableoid, pv.ctid) AS score,
                 'text'::text AS source
          FROM "PageVersion" pv
          WHERE pv."validTo" IS NULL
            AND pv."search_text" <> ''
            AND pv."search_text" &@~ pgroonga_query_escape($1)
          ORDER BY score DESC
          LIMIT $10::int
        ),
        candidates AS (
          SELECT * FROM url_hits
          UNION ALL
          SELECT * FROM title_hits
          UNION ALL
          SELECT * FROM alternate_hits
          UNION ALL
          SELECT * FROM text_hits
        ),
        enriched AS (
          SELECT
            pv.id,
            COALESCE(pv."wikidotId", p."wikidotId") AS "wikidotId",
            pv."pageId",
            pv.title,
            pv."alternateTitle",
            p."currentUrl" AS url,
            p."firstPublishedAt" AS "firstRevisionAt",
            CASE WHEN pv."isDeleted" THEN prev.rating ELSE pv.rating END AS rating,
            CASE WHEN pv."isDeleted" THEN prev."voteCount" ELSE pv."voteCount" END AS "voteCount",
            pv."revisionCount",
            CASE WHEN pv."isDeleted" THEN prev."commentCount" ELSE pv."commentCount" END AS "commentCount",
            CASE WHEN pv."isDeleted" THEN COALESCE(prev.tags, ARRAY[]::text[]) ELSE COALESCE(pv.tags, ARRAY[]::text[]) END AS tags,
            pv."isDeleted",
            CASE WHEN pv."isDeleted" THEN pv."validFrom" ELSE NULL END AS "deletedAt",
            pv."validFrom",
            ps."wilson95",
            ps."controversy",
            LEFT(COALESCE(pv."search_text", ''), 2048) AS search_preview
          FROM "PageVersion" pv
          JOIN candidates c ON c.pv_id = pv.id
          JOIN "Page" p ON pv."pageId" = p.id
          LEFT JOIN "PageStats" ps ON ps."pageVersionId" = pv.id
          LEFT JOIN LATERAL (
            SELECT rating, "voteCount", "commentCount", tags
            FROM "PageVersion" pv_prev
            WHERE pv_prev."pageId" = pv."pageId"
              AND pv_prev."isDeleted" = false
            ORDER BY pv_prev."validTo" DESC NULLS LAST, pv_prev.id DESC
            LIMIT 1
          ) prev ON TRUE
          WHERE pv."validTo" IS NULL
            AND ($2::text[] IS NULL OR COALESCE(CASE WHEN pv."isDeleted" THEN prev.tags ELSE pv.tags END, ARRAY[]::text[]) @> $2::text[])
            AND ($3::text[] IS NULL OR NOT (COALESCE(CASE WHEN pv."isDeleted" THEN prev.tags ELSE pv.tags END, ARRAY[]::text[]) && $3::text[]))
            AND ($4::int IS NULL OR (CASE WHEN pv."isDeleted" THEN prev.rating ELSE pv.rating END) >= $4)
            AND ($5::int IS NULL OR (CASE WHEN pv."isDeleted" THEN prev.rating ELSE pv.rating END) <= $5)
            AND (($6)::boolean IS NOT TRUE OR $2::text[] IS NULL OR COALESCE(CASE WHEN pv."isDeleted" THEN prev.tags ELSE pv.tags END, ARRAY[]::text[]) <@ $2::text[])
            AND ($11::float IS NULL OR ps."wilson95" >= $11)
            AND ($12::float IS NULL OR ps."wilson95" <= $12)
            AND ($13::float IS NULL OR ps."controversy" >= $13)
            AND ($14::float IS NULL OR ps."controversy" <= $14)
            AND ($15::int IS NULL OR (CASE WHEN pv."isDeleted" THEN prev."commentCount" ELSE pv."commentCount" END) >= $15)
            AND ($16::int IS NULL OR (CASE WHEN pv."isDeleted" THEN prev."commentCount" ELSE pv."commentCount" END) <= $16)
            AND ($17::int IS NULL OR (CASE WHEN pv."isDeleted" THEN prev."voteCount" ELSE pv."voteCount" END) >= $17)
            AND ($18::int IS NULL OR (CASE WHEN pv."isDeleted" THEN prev."voteCount" ELSE pv."voteCount" END) <= $18)
            AND ($19::date IS NULL OR p."firstPublishedAt" >= $19::date)
            AND ($20::date IS NULL OR p."firstPublishedAt" <= $20::date)
            ${deletedFilterClause}
        ),
        aggregated AS (
          SELECT
            e.*,
            MAX(c.weight) AS weight,
            MAX(c.score) AS score,
            MAX(CASE WHEN c.source = 'url' THEN 1 ELSE 0 END) AS has_url,
            MAX(CASE WHEN c.source = 'title' THEN 1 ELSE 0 END) AS has_title,
            MAX(CASE WHEN c.source = 'alternate' THEN 1 ELSE 0 END) AS has_alt,
            MAX(CASE WHEN c.source = 'text' THEN 1 ELSE 0 END) AS has_text
          FROM candidates c
          JOIN enriched e ON e.id = c.pv_id
          GROUP BY
            e.id, e."wikidotId", e."pageId", e.title, e."alternateTitle", e.url,
            e."firstRevisionAt", e.rating, e."voteCount", e."revisionCount", e."commentCount",
            e.tags, e."isDeleted", e."deletedAt", e."validFrom", e."wilson95", e."controversy",
            e.search_preview
        )
        SELECT
          a.id,
          a."wikidotId",
          a."pageId",
          a.title,
          a."alternateTitle",
          a.url,
          a."firstRevisionAt",
          a.rating,
          a."voteCount",
          a."revisionCount",
          a."commentCount",
          a.tags,
          a."isDeleted",
          a."deletedAt",
          a."validFrom",
          a."wilson95",
          a."controversy",
          a.search_preview,
          a.weight,
          a.score,
          a.has_url,
          a.has_title,
          a.has_alt,
          a.has_text,
          CASE WHEN lower(split_part(a.url, '/', 4)) = lower($1) THEN 1 ELSE 0 END AS host_match,
          CASE WHEN lower(a.url) = lower($1) THEN 1 ELSE 0 END AS exact_url,
          CASE WHEN a.title IS NOT NULL AND lower(a.title) = lower($1) THEN 1 ELSE 0 END AS exact_title,
          CASE WHEN a.title IS NOT NULL AND a.title &@~ pgroonga_query_escape($1) THEN 1 ELSE 0 END AS title_hit,
          CASE WHEN a."alternateTitle" IS NOT NULL AND a."alternateTitle" &@~ pgroonga_query_escape($1) THEN 1 ELSE 0 END AS alt_hit
        FROM aggregated a
        ORDER BY
          CASE WHEN $9 IN ('rating', 'rating_asc', 'wilson95', 'wilson95_asc', 'controversy', 'controversy_asc', 'comment_count', 'comment_count_asc', 'vote_count', 'vote_count_asc') THEN NULL END,
          CASE WHEN $9 IN ('recent', 'recent_asc') THEN NULL END,
          host_match DESC NULLS LAST,
          exact_url DESC NULLS LAST,
          exact_title DESC NULLS LAST,
          title_hit DESC NULLS LAST,
          alt_hit DESC NULLS LAST,
          has_url DESC NULLS LAST,
          has_title DESC NULLS LAST,
          has_alt DESC NULLS LAST,
          has_text DESC NULLS LAST,
          CASE WHEN ($9 IS NULL OR $9 = 'relevance') THEN COALESCE(score, 0) END DESC NULLS LAST,
          CASE WHEN $9 = 'rating' THEN rating END DESC NULLS LAST,
          CASE WHEN $9 = 'rating_asc' THEN rating END ASC NULLS LAST,
          CASE WHEN $9 = 'recent' THEN COALESCE("firstRevisionAt", "validFrom") END DESC NULLS LAST,
          CASE WHEN $9 = 'recent_asc' THEN COALESCE("firstRevisionAt", "validFrom") END ASC NULLS LAST,
          CASE WHEN $9 = 'wilson95' THEN "wilson95" END DESC NULLS LAST,
          CASE WHEN $9 = 'wilson95_asc' THEN "wilson95" END ASC NULLS LAST,
          CASE WHEN $9 = 'controversy' THEN "controversy" END DESC NULLS LAST,
          CASE WHEN $9 = 'controversy_asc' THEN "controversy" END ASC NULLS LAST,
          CASE WHEN $9 = 'comment_count' THEN "commentCount" END DESC NULLS LAST,
          CASE WHEN $9 = 'comment_count_asc' THEN "commentCount" END ASC NULLS LAST,
          CASE WHEN $9 = 'vote_count' THEN "voteCount" END DESC NULLS LAST,
          CASE WHEN $9 = 'vote_count_asc' THEN "voteCount" END ASC NULLS LAST,
          rating DESC NULLS LAST,
          id DESC
        LIMIT $7::int OFFSET $8::int
      `;

    const totalSql = wantTotal
      ? `
        WITH url_hits AS (
          SELECT pv.id AS pv_id
          FROM "Page" p
          JOIN "PageVersion" pv ON pv."pageId" = p.id AND pv."validTo" IS NULL
          WHERE $1::text IS NOT NULL
            AND p."currentUrl" &@~ pgroonga_query_escape($1)
          LIMIT $7::int
        ),
        title_hits AS (
          SELECT pv.id AS pv_id
          FROM "PageVersion" pv
          WHERE pv."validTo" IS NULL
            AND pv.title &@~ pgroonga_query_escape($1)
          LIMIT $7::int
        ),
        alternate_hits AS (
          SELECT pv.id AS pv_id
          FROM "PageVersion" pv
          WHERE pv."validTo" IS NULL
            AND pv."alternateTitle" IS NOT NULL
            AND pv."alternateTitle" &@~ pgroonga_query_escape($1)
          LIMIT $7::int
        ),
        text_hits AS (
          SELECT pv.id AS pv_id
          FROM "PageVersion" pv
          WHERE pv."validTo" IS NULL
            AND pv."search_text" <> ''
            AND pv."search_text" &@~ pgroonga_query_escape($1)
          LIMIT $7::int
        ),
        candidates AS (
          SELECT * FROM url_hits
          UNION
          SELECT * FROM title_hits
          UNION
          SELECT * FROM alternate_hits
          UNION
          SELECT * FROM text_hits
        ),
        filtered AS (
          SELECT DISTINCT pv.id
          FROM "PageVersion" pv
          JOIN candidates c ON c.pv_id = pv.id
          JOIN "Page" p ON pv."pageId" = p.id
          LEFT JOIN "PageStats" ps ON ps."pageVersionId" = pv.id
          LEFT JOIN LATERAL (
            SELECT rating, "voteCount", "commentCount", tags
            FROM "PageVersion" pv_prev
            WHERE pv_prev."pageId" = pv."pageId"
              AND pv_prev."isDeleted" = false
            ORDER BY pv_prev."validTo" DESC NULLS LAST, pv_prev.id DESC
            LIMIT 1
          ) prev ON TRUE
          WHERE pv."validTo" IS NULL
            AND ($2::text[] IS NULL OR COALESCE(CASE WHEN pv."isDeleted" THEN prev.tags ELSE pv.tags END, ARRAY[]::text[]) @> $2::text[])
            AND ($3::text[] IS NULL OR NOT (COALESCE(CASE WHEN pv."isDeleted" THEN prev.tags ELSE pv.tags END, ARRAY[]::text[]) && $3::text[]))
            AND ($4::int IS NULL OR (CASE WHEN pv."isDeleted" THEN prev.rating ELSE pv.rating END) >= $4)
            AND ($5::int IS NULL OR (CASE WHEN pv."isDeleted" THEN prev.rating ELSE pv.rating END) <= $5)
            AND (($6)::boolean IS NOT TRUE OR $2::text[] IS NULL OR COALESCE(CASE WHEN pv."isDeleted" THEN prev.tags ELSE pv.tags END, ARRAY[]::text[]) <@ $2::text[])
            AND ($8::float IS NULL OR ps."wilson95" >= $8)
            AND ($9::float IS NULL OR ps."wilson95" <= $9)
            AND ($10::float IS NULL OR ps."controversy" >= $10)
            AND ($11::float IS NULL OR ps."controversy" <= $11)
            AND ($12::int IS NULL OR (CASE WHEN pv."isDeleted" THEN prev."commentCount" ELSE pv."commentCount" END) >= $12)
            AND ($13::int IS NULL OR (CASE WHEN pv."isDeleted" THEN prev."commentCount" ELSE pv."commentCount" END) <= $13)
            AND ($14::int IS NULL OR (CASE WHEN pv."isDeleted" THEN prev."voteCount" ELSE pv."voteCount" END) >= $14)
            AND ($15::int IS NULL OR (CASE WHEN pv."isDeleted" THEN prev."voteCount" ELSE pv."voteCount" END) <= $15)
            AND ($16::date IS NULL OR p."firstPublishedAt" >= $16::date)
            AND ($17::date IS NULL OR p."firstPublishedAt" <= $17::date)
            ${deletedFilterClause}
        )
        SELECT COUNT(*) AS total FROM filtered
      `
        : null;

    const params = [
      trimmedQuery,           // $1
      includeTagsParam,       // $2
      excludeTagsParam,       // $3
      ratingMinParam,         // $4
      ratingMaxParam,         // $5
      enforceExactTags,       // $6
      limit,                  // $7
      offset,                 // $8
      normalizedOrder,        // $9
      candidateLimit,         // $10
      wilson95MinParam,       // $11
      wilson95MaxParam,       // $12
      controversyMinParam,    // $13
      controversyMaxParam,    // $14
      commentCountMinParam,   // $15
      commentCountMaxParam,   // $16
      voteCountMinParam,      // $17
      voteCountMaxParam,      // $18
      dateMinParam,           // $19
      dateMaxParam            // $20
    ];

    const totalParams = totalSql
      ? [
          trimmedQuery,           // $1
          includeTagsParam,       // $2
          excludeTagsParam,       // $3
          ratingMinParam,         // $4
          ratingMaxParam,         // $5
          enforceExactTags,       // $6
          candidateLimit,         // $7
          wilson95MinParam,       // $8
          wilson95MaxParam,       // $9
          controversyMinParam,    // $10
          controversyMaxParam,    // $11
          commentCountMinParam,   // $12
          commentCountMaxParam,   // $13
          voteCountMinParam,      // $14
          voteCountMaxParam,      // $15
          dateMinParam,           // $16
          dateMaxParam            // $17
        ]
      : null;

    const [{ rows }, totalRes] = await Promise.all([
      readPool.query(baseSql, params),
      totalSql && totalParams ? readPool.query(totalSql, totalParams) : Promise.resolve(null as any)
    ]);

    let highlightMap: Map<number, string | null> = new Map();
    if (wantSnippet && snippetTop > 0 && rows.length > 0) {
      const highlightIds = Array.from(
        new Set(
          rows
            .slice(0, snippetTop)
            .map((row: any) => Number(row.id))
            .filter((id) => Number.isInteger(id) && id > 0)
        )
      );

      if (highlightIds.length > 0) {
        const snippetSql = `
            SELECT pv.id,
                   array_to_string(pgroonga_snippet_html(pv."search_text", kw.keywords, 200), ' ') AS snippet
            FROM "PageVersion" pv
            LEFT JOIN LATERAL (
              SELECT pgroonga_query_extract_keywords(pgroonga_query_escape($1)) AS keywords
            ) kw ON TRUE
            WHERE pv.id = ANY($2::int[])
          `;
        const { rows: snippetRows } = await readPool.query(snippetSql, [trimmedQuery, highlightIds]);
        highlightMap = new Map(
          snippetRows.map((row) => [Number(row.id), typeof row.snippet === 'string' ? row.snippet : null])
        );
      }
    }

    const total = totalRes ? Number(totalRes.rows?.[0]?.total || 0) : undefined;

    const results = rows.map((row: any) => {
      const {
        weight,
        score,
        has_url,
        has_title,
        has_alt,
        has_text,
        host_match,
        exact_url,
        exact_title,
        title_hit,
        alt_hit,
        search_preview: searchPreview,
        ...rest
      } = row;

      const previewText = typeof searchPreview === 'string' ? searchPreview : null;
      const snippet = wantSnippet
        ? highlightMap.get(Number(row.id)) ?? extractExcerpt(previewText, 180)
        : null;

      const base = wantDate ? { ...rest } : (({ firstRevisionAt, ...restNoDate }) => restNoDate)(rest);

      return {
        ...base,
        snippet,
        excerpt: snippet,
        textScore: typeof score === 'number' ? score : null
      };
    });

    return total !== undefined ? { results, total } : { results };
  }

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
        deletedFilter,
        onlyIncludeTags,
        orderBy = 'relevance',
        includeTotal = 'true',
        includeSnippet = 'true',
        includeDate = 'true',
        // 新增过滤参数
        wilson95Min,
        wilson95Max,
        controversyMin,
        controversyMax,
        commentCountMin,
        commentCountMax,
        voteCountMin,
        voteCountMax,
        dateMin,
        dateMax
      } = req.query as Record<string, string>;

      const normalizedDeletedFilter = normalizeDeletedFilter(deletedFilter);
      const hasFilters = tags || excludeTags || ratingMin || ratingMax ||
        wilson95Min || wilson95Max || controversyMin || controversyMax ||
        commentCountMin || commentCountMax || voteCountMin || voteCountMax ||
        dateMin || dateMax || normalizedDeletedFilter !== 'any';
      if (!query && !hasFilters) {
        return res.status(400).json({ error: 'query or filters are required' });
      }

      const wantTotal = String(includeTotal).toLowerCase() === 'true';
      const wantSnippet = String(includeSnippet).toLowerCase() === 'true';
      const wantDate = String(includeDate).toLowerCase() === 'true';
      const trimmedQuery = query ? query.trim() : '';
      const hasQuery = trimmedQuery.length > 0;
      const limitInt = Math.max(0, Number(limit) | 0) || 20;
      const offsetInt = Math.max(0, Number(offset) | 0);
      const includeTagsArray = tags
        ? (Array.isArray(tags) ? (tags as string[]) : [tags as string])
        : null;
      const excludeTagsArray = excludeTags
        ? (Array.isArray(excludeTags) ? (excludeTags as string[]) : [excludeTags as string])
        : null;
      const enforceExactTags =
        ['true', '1', 'yes'].includes(String(onlyIncludeTags || '').toLowerCase()) &&
        !!(includeTagsArray && includeTagsArray.length > 0);
      const normalizedOrder = (() => {
        const key = String(orderBy || '').toLowerCase();
        if (key === 'rating_asc') return 'rating_asc';
        if (key === 'recent_asc') return 'recent_asc';
        if (key === 'rating_desc') return 'rating';
        if (key === 'recent_desc') return 'recent';
        if (key === 'rating') return 'rating';
        if (key === 'recent') return 'recent';
        // 新增排序选项
        if (key === 'wilson95') return 'wilson95';
        if (key === 'wilson95_asc') return 'wilson95_asc';
        if (key === 'wilson95_desc') return 'wilson95';
        if (key === 'controversy') return 'controversy';
        if (key === 'controversy_asc') return 'controversy_asc';
        if (key === 'controversy_desc') return 'controversy';
        if (key === 'comment_count') return 'comment_count';
        if (key === 'comment_count_asc') return 'comment_count_asc';
        if (key === 'comment_count_desc') return 'comment_count';
        if (key === 'vote_count') return 'vote_count';
        if (key === 'vote_count_asc') return 'vote_count_asc';
        if (key === 'vote_count_desc') return 'vote_count';
        return 'relevance';
      })();
      const ratingMinNumber = parseNullableInt(ratingMin);
      const ratingMaxNumber = parseNullableInt(ratingMax);
      const wilson95MinNumber = parseNullableFloat(wilson95Min);
      const wilson95MaxNumber = parseNullableFloat(wilson95Max);
      const controversyMinNumber = parseNullableFloat(controversyMin);
      const controversyMaxNumber = parseNullableFloat(controversyMax);
      const commentCountMinNumber = parseNullableInt(commentCountMin);
      const commentCountMaxNumber = parseNullableInt(commentCountMax);
      const voteCountMinNumber = parseNullableInt(voteCountMin);
      const voteCountMaxNumber = parseNullableInt(voteCountMax);
      const dateMinParsed = parseNullableDate(dateMin);
      const dateMaxParsed = parseNullableDate(dateMax);
      const candidateLimit = Math.max(limitInt * 4, 120);
      const snippetTop = wantSnippet ? Math.min(defaultSnippetTopK, Math.max(1, limitInt)) : 0;

      const cacheParamsBase = {
        query: hasQuery ? trimmedQuery : undefined,
        limit: limitInt,
        offset: offsetInt,
        orderBy: normalizedOrder,
        includeSnippet: wantSnippet,
        includeDate: wantDate,
        tags: includeTagsArray,
        excludeTags: excludeTagsArray,
        ratingMin: ratingMinNumber ?? undefined,
        ratingMax: ratingMaxNumber ?? undefined,
        wilson95Min: wilson95MinNumber ?? undefined,
        wilson95Max: wilson95MaxNumber ?? undefined,
        controversyMin: controversyMinNumber ?? undefined,
        controversyMax: controversyMaxNumber ?? undefined,
        commentCountMin: commentCountMinNumber ?? undefined,
        commentCountMax: commentCountMaxNumber ?? undefined,
        voteCountMin: voteCountMinNumber ?? undefined,
        voteCountMax: voteCountMaxNumber ?? undefined,
        dateMin: dateMinParsed ?? undefined,
        dateMax: dateMaxParsed ?? undefined,
        deleted: normalizedDeletedFilter,
        exactTags: enforceExactTags
      };

      const cacheKey = buildCacheKey(
        hasQuery ? 'search:pages:query' : 'search:pages:filters',
        cacheParamsBase
      );
      const cached = await readCache<{ results: any[]; total?: number }>(cacheKey);
      if (cached) {
        return res.json(cached);
      }

      const pageData = await executePageSearch({
        trimmedQuery,
        limit: limitInt,
        offset: offsetInt,
        includeTags: includeTagsArray,
        excludeTags: excludeTagsArray,
        ratingMin: ratingMinNumber,
        ratingMax: ratingMaxNumber,
        enforceExactTags,
        normalizedOrder,
        deletedFilter: normalizedDeletedFilter,
        wantTotal,
        wantSnippet,
        wantDate,
        candidateLimit,
        snippetTop,
        wilson95Min: wilson95MinNumber,
        wilson95Max: wilson95MaxNumber,
        controversyMin: controversyMinNumber,
        controversyMax: controversyMaxNumber,
        commentCountMin: commentCountMinNumber,
        commentCountMax: commentCountMaxNumber,
        voteCountMin: voteCountMinNumber,
        voteCountMax: voteCountMaxNumber,
        dateMin: dateMinParsed,
        dateMax: dateMaxParsed
      });

      const payload = pageData.total !== undefined
        ? { results: pageData.results, total: pageData.total }
        : { results: pageData.results };

      await writeCache(cacheKey, payload, defaultCacheTtl);
      return res.json(payload);
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
        WHERE u."displayName" &@~ pgroonga_query_escape($1)
        ORDER BY us."totalRating" DESC NULLS LAST
        LIMIT $2::int OFFSET $3::int
      `;
      const [rowsRes, totalRes] = await Promise.all([
        readPool.query(sql, [query, limit, offset]),
        wantTotal ? readPool.query(`SELECT COUNT(*) AS total FROM "User" WHERE "displayName" &@~ pgroonga_query_escape($1)`, [query]) : Promise.resolve(null as any)
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
        limit = '20',
        offset = '0',
        pageLimit,
        userLimit,
        tags,
        excludeTags,
        ratingMin,
        ratingMax,
        deletedFilter,
        onlyIncludeTags,
        includeSnippet = 'true',
        includeDate = 'true',
        orderBy = 'relevance',
        // 新增过滤参数
        wilson95Min,
        wilson95Max,
        controversyMin,
        controversyMax,
        commentCountMin,
        commentCountMax,
        voteCountMin,
        voteCountMax,
        dateMin,
        dateMax
      } = req.query as Record<string, string>;

      if (!query) return res.status(400).json({ error: 'query is required' });

      const trimmedQuery = query.trim();
      const totalLimit = Math.max(0, Number(limit) | 0);
      const totalOffset = Math.max(0, Number(offset) | 0);
      const defaultPageCap = Math.max(0, Math.min(totalLimit || 20, Math.ceil((totalLimit || 20) * 0.6)));
      const pageCap = Math.max(0, Number(pageLimit ?? defaultPageCap) | 0);
      const userCap = Math.max(0, Number(userLimit ?? ((totalLimit || 20) - pageCap)) | 0);
      const wantSnippet = String(includeSnippet).toLowerCase() === 'true';
      const wantDate = String(includeDate).toLowerCase() === 'true';

      const includeTagsArray = tags
        ? (Array.isArray(tags) ? (tags as string[]) : [tags as string])
        : null;
      const excludeTagsArray = excludeTags
        ? (Array.isArray(excludeTags) ? (excludeTags as string[]) : [excludeTags as string])
        : null;
      const ratingMinNumber = parseNullableInt(ratingMin);
      const ratingMaxNumber = parseNullableInt(ratingMax);
      const wilson95MinNumber = parseNullableFloat(wilson95Min);
      const wilson95MaxNumber = parseNullableFloat(wilson95Max);
      const controversyMinNumber = parseNullableFloat(controversyMin);
      const controversyMaxNumber = parseNullableFloat(controversyMax);
      const commentCountMinNumber = parseNullableInt(commentCountMin);
      const commentCountMaxNumber = parseNullableInt(commentCountMax);
      const voteCountMinNumber = parseNullableInt(voteCountMin);
      const voteCountMaxNumber = parseNullableInt(voteCountMax);
      const dateMinParsed = parseNullableDate(dateMin);
      const dateMaxParsed = parseNullableDate(dateMax);
      const normalizedDeletedFilter = normalizeDeletedFilter(deletedFilter);
      const enforceExactTags = ['true', '1', 'yes'].includes(String(onlyIncludeTags || '').toLowerCase()) && !!(includeTagsArray && includeTagsArray.length > 0);

      const cacheKey = buildCacheKey('search:all', {
        query: trimmedQuery,
        limit: totalLimit,
        offset: totalOffset,
        pageLimit: pageCap,
        userLimit: userCap,
        orderBy,
        tags: includeTagsArray,
        excludeTags: excludeTagsArray,
        ratingMin: ratingMinNumber ?? undefined,
        ratingMax: ratingMaxNumber ?? undefined,
        wilson95Min: wilson95MinNumber ?? undefined,
        wilson95Max: wilson95MaxNumber ?? undefined,
        controversyMin: controversyMinNumber ?? undefined,
        controversyMax: controversyMaxNumber ?? undefined,
        commentCountMin: commentCountMinNumber ?? undefined,
        commentCountMax: commentCountMaxNumber ?? undefined,
        voteCountMin: voteCountMinNumber ?? undefined,
        voteCountMax: voteCountMaxNumber ?? undefined,
        dateMin: dateMinParsed ?? undefined,
        dateMax: dateMaxParsed ?? undefined,
        deleted: normalizedDeletedFilter,
        includeSnippet: wantSnippet,
        includeDate: wantDate,
        exactTags: enforceExactTags
      });
      const cached = await readCache<{
        results: any[];
        meta: { counts: { pages: number; users: number }; usedCaps: { pageLimit: number; userLimit: number }; orderBy: string };
      }>(cacheKey);
      if (cached) {
        return res.json(cached);
      }

      const candidateLimit = Math.max(pageCap * 4, 120);
      const snippetTop = wantSnippet ? Math.min(defaultSnippetTopK, Math.max(1, pageCap || defaultPageCap || 10)) : 0;

      const pageData = await executePageSearch({
        trimmedQuery,
        limit: Math.max(pageCap, 0) || 0,
        offset: 0,
        includeTags: includeTagsArray,
        excludeTags: excludeTagsArray,
        ratingMin: ratingMinNumber,
        ratingMax: ratingMaxNumber,
        enforceExactTags,
        normalizedOrder: 'relevance',
        deletedFilter: normalizedDeletedFilter,
        wantTotal: true,
        wantSnippet,
        wantDate,
        candidateLimit,
        snippetTop,
        wilson95Min: wilson95MinNumber,
        wilson95Max: wilson95MaxNumber,
        controversyMin: controversyMinNumber,
        controversyMax: controversyMaxNumber,
        commentCountMin: commentCountMinNumber,
        commentCountMax: commentCountMaxNumber,
        voteCountMin: voteCountMinNumber,
        voteCountMax: voteCountMaxNumber,
        dateMin: dateMinParsed,
        dateMax: dateMaxParsed
      });

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
        WHERE u."displayName" &@~ pgroonga_query_escape($1)
        ORDER BY score DESC NULLS LAST, us."totalRating" DESC NULLS LAST
        LIMIT $2::int OFFSET $3::int
      `;
      const userParams = [trimmedQuery, String(Math.max(userCap, 0)), '0'];

      const userCountSql = `
        SELECT COUNT(*) AS total
        FROM "User" u
        WHERE u."displayName" &@~ pgroonga_query_escape($1)
      `;

      const [userRes, userCountRes] = await Promise.all([
        readPool.query(userSql, userParams),
        readPool.query(userCountSql, [trimmedQuery])
      ]);

      const pages = (pageData.results || []).map((r: any, index: number) => ({
        type: 'page' as const,
        id: r.id,
        wikidotId: r.wikidotId,
        pageId: r.pageId,
        title: r.title,
        alternateTitle: typeof r.alternateTitle === 'string' ? r.alternateTitle : null,
        url: r.url,
        rating: r.rating,
        voteCount: r.voteCount,
        revisionCount: r.revisionCount,
        commentCount: r.commentCount,
        tags: r.tags,
        isDeleted: r.isDeleted === true,
        deletedAt: r.deletedAt || null,
        snippet: r.snippet,
        wilson95: typeof r.wilson95 === 'number' ? r.wilson95 : null,
        controversy: typeof r.controversy === 'number' ? r.controversy : null,
        firstRevisionAt: wantDate ? r.firstRevisionAt || null : null,
        textScore: typeof r.textScore === 'number' ? r.textScore : null,
        popularityScore: typeof r.rating === 'number' ? r.rating : 0,
        orderIndex: index
      }));

      const users = (userRes.rows || []).map((r: any, index: number) => ({
        type: 'user' as const,
        id: r.id,
        wikidotId: r.wikidotId,
        displayName: r.displayName,
        rank: r.rank ?? null,
        totalRating: r.totalRating ?? 0,
        pageCount: r.pageCount ?? 0,
        textScore: typeof r.score === 'number' ? r.score : null,
        popularityScore: typeof r.totalRating === 'number' ? r.totalRating : 0,
        orderIndex: index
      }));

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
          sorted = hybrid.sort((a, b) =>
            a.type === b.type
              ? (a.orderIndex ?? 0) - (b.orderIndex ?? 0)
              : a.type === 'page'
                ? -1
                : 1
          );
          break;
      }

      const sliced = totalOffset > 0
        ? sorted.slice(totalOffset, totalOffset + (totalLimit || 20))
        : sorted.slice(0, (totalLimit || 20));

      const sanitizedResults = sliced.map((item) => {
        const { orderIndex, textScore, popularityScore, combinedScore, ...rest } = item as any;
        return rest;
      });

      const totalPages = pageData.total ?? pageData.results.length;
      const totalUsers = Number(userCountRes.rows?.[0]?.total || 0);

      const payload = {
        results: sanitizedResults,
        meta: {
          counts: { pages: totalPages, users: totalUsers },
          usedCaps: { pageLimit: pageCap, userLimit: userCap },
          orderBy
        }
      };

      await writeCache(cacheKey, payload, defaultCacheTtl);
      res.json(payload);
    } catch (err) {
      next(err);
    }
  });
  // GET /search/tags
  router.get('/tags', async (req, res, next) => {
    try {
      const { query, limit = '20' } = req.query as Record<string, string>;
      
      if (!query || query.trim().length < 1) {
        return res.json({ results: [] });
      }
      
      const searchQuery = query.trim();
      
      // 搜索匹配的标签，按使用频率排序
      const sql = `
        WITH tag_stats AS (
          SELECT 
            tag,
            COUNT(*) as usage_count,
            COUNT(DISTINCT pv."pageId") as page_count
          FROM "PageVersion" pv
          CROSS JOIN LATERAL UNNEST(pv.tags) AS t(tag)
          WHERE pv."validTo" IS NULL
            AND t.tag ILIKE '%' || $1 || '%'
          GROUP BY tag
        )
        SELECT 
          tag,
          usage_count,
          page_count
        FROM tag_stats
        ORDER BY 
          CASE WHEN LOWER(tag) = LOWER($1) THEN 0 ELSE 1 END,
          usage_count DESC,
          tag ASC
        LIMIT $2::int
      `;
      
      const { rows } = await readPool.query(sql, [searchQuery, limit]);
      
      const results = rows.map((row: any) => ({
        tag: row.tag,
        usageCount: Number(row.usage_count || 0),
        pageCount: Number(row.page_count || 0)
      }));
      
      res.json({ results });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
