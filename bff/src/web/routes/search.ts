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
  authorIds: number[] | null;
  authorMatch: 'any' | 'all';
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
  regexMode: boolean;
};

type PageSearchResult = {
  results: any[];
  total?: number;
};

export function searchRouter(pool: Pool, redis: RedisClientType | null) {
  const router = Router();

  // 读写分离：search 全部是读操作，使用从库
  const readPool = getReadPoolSync(pool);

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

  const parseNullableInt = (value: unknown): number | null => {
    if (value === undefined || value === null || value === '') return null;
    const raw = Array.isArray(value) ? value[0] : value;
    if (raw === undefined || raw === null || raw === '') return null;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return null;
    return Math.trunc(parsed);
  };

  const parseNullableFloat = (value: unknown): number | null => {
    if (value === undefined || value === null || value === '') return null;
    const raw = Array.isArray(value) ? value[0] : value;
    if (raw === undefined || raw === null || raw === '') return null;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return null;
    return parsed;
  };

  const parseNullableDate = (value: unknown): string | null => {
    if (value === undefined || value === null || value === '') return null;
    const raw = Array.isArray(value) ? value[0] : value;
    if (raw === undefined || raw === null || raw === '') return null;
    // 支持 YYYY-MM-DD 格式
    const dateMatch = String(raw).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!dateMatch) return null;
    const [, year, month, day] = dateMatch;
    const y = parseInt(year, 10);
    const m = parseInt(month, 10);
    const d = parseInt(day, 10);
    if (y < 1970 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
    const parsed = new Date(Date.UTC(y, m - 1, d));
    if (
      Number.isNaN(parsed.getTime())
      || parsed.getUTCFullYear() !== y
      || parsed.getUTCMonth() + 1 !== m
      || parsed.getUTCDate() !== d
    ) return null;
    return `${year}-${month}-${day}`;
  };

  const parseNullableIntArray = (value: unknown): number[] | null => {
    if (value === undefined || value === null || value === '') return null;
    const rawValues = Array.isArray(value) ? value : [value];
    const parsed = rawValues
      .flatMap((item) => String(item).split(','))
      .map((item) => Number.parseInt(item.trim(), 10))
      .filter((item) => Number.isInteger(item) && item > 0);
    const unique = Array.from(new Set(parsed));
    return unique.length > 0 ? unique : null;
  };

  const normalizeAuthorMatch = (value: unknown): 'any' | 'all' => {
    const normalized = String(value || 'any').toLowerCase();
    return normalized === 'all' ? 'all' : 'any';
  };

  const normalizeDeletedFilter = (raw: unknown): DeletedFilterMode => {
    const value = Array.isArray(raw) ? raw[0] : raw;
    const normalized = String(value || 'any').toLowerCase();
    if (normalized === 'only') return 'only';
    if (normalized === 'exclude') return 'exclude';
    return 'any';
  };

  const buildDeletedFilterClause = (mode: DeletedFilterMode): string => {
    if (mode === 'exclude') return ' AND pv."isDeleted" = false';
    if (mode === 'only') return ' AND pv."isDeleted" = true';
    return '';
  };

  // ── 正则搜索辅助 ──────────────────────────────
  const MAX_REGEX_LENGTH = 200;

  function validateRegex(pattern: string): { valid: boolean; error?: string } {
    if (!pattern || pattern.trim().length === 0) {
      return { valid: false, error: '正则表达式不能为空' };
    }
    if (pattern.length > MAX_REGEX_LENGTH) {
      return { valid: false, error: `正则表达式过长（最多 ${MAX_REGEX_LENGTH} 个字符）` };
    }
    return { valid: true };
  }

  async function withRegexTimeout<T>(fn: (client: any) => Promise<T>): Promise<T> {
    const client = await readPool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL statement_timeout = 20000');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

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

  function escapeHtml(str: string): string {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /**
   * 正则高亮摘要：在 search_text 中找到匹配位置，提取上下文窗口并用
   * <span class="keyword"> 包裹匹配文本，与 pgroonga_snippet_html 输出格式一致。
   * 如果 JS 引擎不支持该正则或无匹配，返回 null（调用方降级到 extractExcerpt）。
   */
  function highlightRegexSnippet(text: string | null, pattern: string, maxLength = 200): string | null {
    if (!text || !pattern) return null;
    try {
      // 先清理 wiki/HTML/CSS 标记
      const clean = text
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\[\[[^\]]*\]\]/g, '')
        .replace(/\{\{[^}]*\}\}/g, '')
        .replace(/<[^>]+>/g, '')
        .replace(/\{[^}]{0,500}\}/g, ' ')
        .replace(/[a-z-]+\s*:\s*[#\d.]+[a-z%]*\s*;/gi, ' ')
        .replace(/https?:\/\/\S+/g, '')
        .replace(/^[#*\-+>|\s]+/gm, '')
        .replace(/\n+/g, ' ')
        .replace(/\s{2,}/g, ' ')
        .trim();
      if (!clean) return null;

      const regex = new RegExp(pattern, 'gi');
      const firstMatch = regex.exec(clean);
      if (!firstMatch) return null;

      // 以首个匹配为中心提取窗口
      const start = Math.max(0, firstMatch.index - 10);
      const end = Math.min(clean.length, start + maxLength);
      const window = clean.slice(start, end);

      // 逐段构建 HTML：非匹配部分转义，匹配部分用 <span> 包裹
      const windowRegex = new RegExp(pattern, 'gi');
      let result = '';
      let lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = windowRegex.exec(window)) !== null) {
        result += escapeHtml(window.slice(lastIndex, m.index));
        result += '<span class="keyword">' + escapeHtml(m[0]) + '</span>';
        lastIndex = m.index + m[0].length;
        // 防止零长度匹配无限循环
        if (m[0].length === 0) { windowRegex.lastIndex++; }
      }
      result += escapeHtml(window.slice(lastIndex));

      if (start > 0) result = '...' + result;
      if (end < clean.length) result += '...';

      return result;
    } catch {
      // JS 引擎不支持该正则语法（如 PostgreSQL 特有的语法），静默降级
      return null;
    }
  }

  async function executePageSearch(args: PageSearchArgs, db: any = readPool): Promise<PageSearchResult> {
    const {
      trimmedQuery,
      limit,
      offset,
      includeTags,
      excludeTags,
      authorIds,
      authorMatch,
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
      regexMode,
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
    const authorIdsParam = authorIds && authorIds.length > 0 ? authorIds : null;
    const authorMatchParam: 'any' | 'all' = authorMatch === 'all' ? 'all' : 'any';
    const authorIdsCountParam = authorIdsParam ? authorIdsParam.length : null;
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

    const buildAuthorFilterClause = (
      versionExpr: string,
      authorIdsPlaceholder: number,
      authorMatchPlaceholder: number,
      authorCountPlaceholder: number
    ) => `
      AND (
        $${authorIdsPlaceholder}::int[] IS NULL
        OR (
          CASE WHEN $${authorMatchPlaceholder}::text = 'all' THEN (
            SELECT COUNT(DISTINCT u."wikidotId")
            FROM "Attribution" a
            JOIN "User" u ON u.id = a."userId"
            WHERE a."pageVerId" = ${versionExpr}
              AND u."wikidotId" IS NOT NULL
              AND u."wikidotId" = ANY($${authorIdsPlaceholder}::int[])
              AND (
                a.type <> 'SUBMITTER'
                OR NOT EXISTS (
                  SELECT 1
                  FROM "Attribution" ax
                  WHERE ax."pageVerId" = ${versionExpr}
                    AND ax.type <> 'SUBMITTER'
                )
              )
          ) >= COALESCE($${authorCountPlaceholder}::int, 0)
          ELSE EXISTS (
            SELECT 1
            FROM "Attribution" a
            JOIN "User" u ON u.id = a."userId"
            WHERE a."pageVerId" = ${versionExpr}
              AND u."wikidotId" IS NOT NULL
              AND u."wikidotId" = ANY($${authorIdsPlaceholder}::int[])
              AND (
                a.type <> 'SUBMITTER'
                OR NOT EXISTS (
                  SELECT 1
                  FROM "Attribution" ax
                  WHERE ax."pageVerId" = ${versionExpr}
                    AND ax.type <> 'SUBMITTER'
                )
              )
          )
          END
        )
      )
    `;

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
              ${buildAuthorFilterClause('pv.id', 19, 20, 21)}
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
              SELECT id, rating, "voteCount", "commentCount", tags
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
              ${buildAuthorFilterClause('COALESCE(prev.id, pv.id)', 19, 20, 21)}
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
        dateMaxParam,           // $18
        authorIdsParam,         // $19
        authorMatchParam,       // $20
        authorIdsCountParam     // $21
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
            ${buildAuthorFilterClause('pv.id', 16, 17, 18)}
        `;
        const deletedCountSql = `
          SELECT COUNT(*) AS cnt
          FROM "PageVersion" pv
          JOIN "Page" p ON pv."pageId" = p.id
          LEFT JOIN "PageStats" ps ON ps."pageVersionId" = pv.id
          LEFT JOIN LATERAL (
            SELECT id, rating, "voteCount", "commentCount", tags
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
            ${buildAuthorFilterClause('COALESCE(prev.id, pv.id)', 16, 17, 18)}
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
        dateMaxParam,           // $15
        authorIdsParam,         // $16
        authorMatchParam,       // $17
        authorIdsCountParam     // $18
      ];

      const [{ rows }, totalRes] = await Promise.all([
        db.query(finalSql, params),
        wantTotal
          ? db.query(buildTotalSql(), totalParams)
          : Promise.resolve(null as any)
      ]);

      const total = totalRes ? Number(totalRes.rows?.[0]?.total ?? totalRes.rows?.[0]?.cnt ?? 0) : undefined;

      let snippetMap: Map<number, string | null> = new Map();
      if (wantSnippet && rows.length > 0) {
        const pageIds = Array.from(
          new Set(
            rows
              .map((row: any) => Number(row.pageId))
              .filter((id: number) => Number.isInteger(id) && id > 0)
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
          const { rows: snippetRows } = await db.query(snippetSql, [pageIds]);
          snippetMap = new Map(
            snippetRows.map((row: any) => [
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

    // ── 正则模式：单次扫描 + OR 条件 ──────────────────
    // PGroonga 的 4-CTE 架构不适合正则：每个 CTE 都做全表扫描，4x 冗余
    // 正则模式改为单次 JOIN 扫描，OR 匹配所有列，直接分页
    if (regexMode) {
      const regexMatchCond = `(
        p."currentUrl" ~* $1
        OR pv.title ~* $1
        OR (pv."alternateTitle" IS NOT NULL AND pv."alternateTitle" ~* $1)
        OR (pv."search_text" <> '' AND pv."search_text" ~* $1)
      )`;

      const regexBaseSql = `
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
        JOIN "Page" p ON pv."pageId" = p.id
        LEFT JOIN "PageStats" ps ON ps."pageVersionId" = pv.id
        LEFT JOIN LATERAL (
          SELECT id, rating, "voteCount", "commentCount", tags
          FROM "PageVersion" pv_prev
          WHERE pv_prev."pageId" = pv."pageId"
            AND pv_prev."isDeleted" = false
          ORDER BY pv_prev."validTo" DESC NULLS LAST, pv_prev.id DESC
          LIMIT 1
        ) prev ON TRUE
        WHERE pv."validTo" IS NULL
          AND ${regexMatchCond}
          AND ($2::text[] IS NULL OR COALESCE(CASE WHEN pv."isDeleted" THEN prev.tags ELSE pv.tags END, ARRAY[]::text[]) @> $2::text[])
          AND ($3::text[] IS NULL OR NOT (COALESCE(CASE WHEN pv."isDeleted" THEN prev.tags ELSE pv.tags END, ARRAY[]::text[]) && $3::text[]))
          AND ($4::int IS NULL OR (CASE WHEN pv."isDeleted" THEN prev.rating ELSE pv.rating END) >= $4)
          AND ($5::int IS NULL OR (CASE WHEN pv."isDeleted" THEN prev.rating ELSE pv.rating END) <= $5)
          AND (($6)::boolean IS NOT TRUE OR $2::text[] IS NULL OR COALESCE(CASE WHEN pv."isDeleted" THEN prev.tags ELSE pv.tags END, ARRAY[]::text[]) <@ $2::text[])
          AND ($10::float IS NULL OR ps."wilson95" >= $10)
          AND ($11::float IS NULL OR ps."wilson95" <= $11)
          AND ($12::float IS NULL OR ps."controversy" >= $12)
          AND ($13::float IS NULL OR ps."controversy" <= $13)
          AND ($14::int IS NULL OR (CASE WHEN pv."isDeleted" THEN prev."commentCount" ELSE pv."commentCount" END) >= $14)
          AND ($15::int IS NULL OR (CASE WHEN pv."isDeleted" THEN prev."commentCount" ELSE pv."commentCount" END) <= $15)
          AND ($16::int IS NULL OR (CASE WHEN pv."isDeleted" THEN prev."voteCount" ELSE pv."voteCount" END) >= $16)
          AND ($17::int IS NULL OR (CASE WHEN pv."isDeleted" THEN prev."voteCount" ELSE pv."voteCount" END) <= $17)
          AND ($18::date IS NULL OR p."firstPublishedAt" >= $18::date)
          AND ($19::date IS NULL OR p."firstPublishedAt" <= $19::date)
          ${buildAuthorFilterClause('COALESCE(CASE WHEN pv."isDeleted" THEN prev.id ELSE pv.id END, pv.id)', 20, 21, 22)}
          ${deletedFilterClause}
        ORDER BY
          CASE WHEN $9 = 'rating' THEN (CASE WHEN pv."isDeleted" THEN prev.rating ELSE pv.rating END) END DESC NULLS LAST,
          CASE WHEN $9 = 'rating_asc' THEN (CASE WHEN pv."isDeleted" THEN prev.rating ELSE pv.rating END) END ASC NULLS LAST,
          CASE WHEN $9 = 'recent' THEN COALESCE(p."firstPublishedAt", pv."validFrom") END DESC NULLS LAST,
          CASE WHEN $9 = 'recent_asc' THEN COALESCE(p."firstPublishedAt", pv."validFrom") END ASC NULLS LAST,
          CASE WHEN $9 = 'wilson95' THEN ps."wilson95" END DESC NULLS LAST,
          CASE WHEN $9 = 'wilson95_asc' THEN ps."wilson95" END ASC NULLS LAST,
          CASE WHEN $9 = 'controversy' THEN ps."controversy" END DESC NULLS LAST,
          CASE WHEN $9 = 'controversy_asc' THEN ps."controversy" END ASC NULLS LAST,
          CASE WHEN $9 = 'comment_count' THEN (CASE WHEN pv."isDeleted" THEN prev."commentCount" ELSE pv."commentCount" END) END DESC NULLS LAST,
          CASE WHEN $9 = 'comment_count_asc' THEN (CASE WHEN pv."isDeleted" THEN prev."commentCount" ELSE pv."commentCount" END) END ASC NULLS LAST,
          CASE WHEN $9 = 'vote_count' THEN (CASE WHEN pv."isDeleted" THEN prev."voteCount" ELSE pv."voteCount" END) END DESC NULLS LAST,
          CASE WHEN $9 = 'vote_count_asc' THEN (CASE WHEN pv."isDeleted" THEN prev."voteCount" ELSE pv."voteCount" END) END ASC NULLS LAST,
          (CASE WHEN pv."isDeleted" THEN prev.rating ELSE pv.rating END) DESC NULLS LAST,
          pv.id DESC
        LIMIT $7::int OFFSET $8::int
      `;

      const regexTotalSql = wantTotal ? `
        SELECT COUNT(DISTINCT pv.id) AS total
        FROM "PageVersion" pv
        JOIN "Page" p ON pv."pageId" = p.id
        LEFT JOIN "PageStats" ps ON ps."pageVersionId" = pv.id
        LEFT JOIN LATERAL (
          SELECT id, rating, "voteCount", "commentCount", tags
          FROM "PageVersion" pv_prev
          WHERE pv_prev."pageId" = pv."pageId"
            AND pv_prev."isDeleted" = false
          ORDER BY pv_prev."validTo" DESC NULLS LAST, pv_prev.id DESC
          LIMIT 1
        ) prev ON TRUE
        WHERE pv."validTo" IS NULL
          AND ${regexMatchCond}
          AND ($2::text[] IS NULL OR COALESCE(CASE WHEN pv."isDeleted" THEN prev.tags ELSE pv.tags END, ARRAY[]::text[]) @> $2::text[])
          AND ($3::text[] IS NULL OR NOT (COALESCE(CASE WHEN pv."isDeleted" THEN prev.tags ELSE pv.tags END, ARRAY[]::text[]) && $3::text[]))
          AND ($4::int IS NULL OR (CASE WHEN pv."isDeleted" THEN prev.rating ELSE pv.rating END) >= $4)
          AND ($5::int IS NULL OR (CASE WHEN pv."isDeleted" THEN prev.rating ELSE pv.rating END) <= $5)
          AND (($6)::boolean IS NOT TRUE OR $2::text[] IS NULL OR COALESCE(CASE WHEN pv."isDeleted" THEN prev.tags ELSE pv.tags END, ARRAY[]::text[]) <@ $2::text[])
          AND ($7::float IS NULL OR ps."wilson95" >= $7)
          AND ($8::float IS NULL OR ps."wilson95" <= $8)
          AND ($9::float IS NULL OR ps."controversy" >= $9)
          AND ($10::float IS NULL OR ps."controversy" <= $10)
          AND ($11::int IS NULL OR (CASE WHEN pv."isDeleted" THEN prev."commentCount" ELSE pv."commentCount" END) >= $11)
          AND ($12::int IS NULL OR (CASE WHEN pv."isDeleted" THEN prev."commentCount" ELSE pv."commentCount" END) <= $12)
          AND ($13::int IS NULL OR (CASE WHEN pv."isDeleted" THEN prev."voteCount" ELSE pv."voteCount" END) >= $13)
          AND ($14::int IS NULL OR (CASE WHEN pv."isDeleted" THEN prev."voteCount" ELSE pv."voteCount" END) <= $14)
          AND ($15::date IS NULL OR p."firstPublishedAt" >= $15::date)
          AND ($16::date IS NULL OR p."firstPublishedAt" <= $16::date)
          ${buildAuthorFilterClause('COALESCE(CASE WHEN pv."isDeleted" THEN prev.id ELSE pv.id END, pv.id)', 17, 18, 19)}
          ${deletedFilterClause}
      ` : null;

      const regexParams = [
        trimmedQuery,           // $1
        includeTagsParam,       // $2
        excludeTagsParam,       // $3
        ratingMinParam,         // $4
        ratingMaxParam,         // $5
        enforceExactTags,       // $6
        limit,                  // $7
        offset,                 // $8
        normalizedOrder,        // $9
        wilson95MinParam,       // $10
        wilson95MaxParam,       // $11
        controversyMinParam,    // $12
        controversyMaxParam,    // $13
        commentCountMinParam,   // $14
        commentCountMaxParam,   // $15
        voteCountMinParam,      // $16
        voteCountMaxParam,      // $17
        dateMinParam,           // $18
        dateMaxParam,           // $19
        authorIdsParam,         // $20
        authorMatchParam,       // $21
        authorIdsCountParam     // $22
      ];

      const regexTotalParams = regexTotalSql ? [
        trimmedQuery,           // $1
        includeTagsParam,       // $2
        excludeTagsParam,       // $3
        ratingMinParam,         // $4
        ratingMaxParam,         // $5
        enforceExactTags,       // $6
        wilson95MinParam,       // $7
        wilson95MaxParam,       // $8
        controversyMinParam,    // $9
        controversyMaxParam,    // $10
        commentCountMinParam,   // $11
        commentCountMaxParam,   // $12
        voteCountMinParam,      // $13
        voteCountMaxParam,      // $14
        dateMinParam,           // $15
        dateMaxParam,           // $16
        authorIdsParam,         // $17
        authorMatchParam,       // $18
        authorIdsCountParam     // $19
      ] : null;

      const [{ rows }, totalRes] = await Promise.all([
        db.query(regexBaseSql, regexParams),
        regexTotalSql && regexTotalParams
          ? db.query(regexTotalSql, regexTotalParams)
          : Promise.resolve(null as any)
      ]);

      const total = totalRes ? Number(totalRes.rows?.[0]?.total || 0) : undefined;

      // 二次查询：为结果行精确提取匹配位置周围的上下文（而非依赖截断的前 2048 字符）
      let snippetMap: Map<number, string | null> = new Map();
      if (wantSnippet && rows.length > 0) {
        const snippetIds = Array.from(new Set(
          rows.map((r: any) => Number(r.id)).filter((id: number) => Number.isInteger(id) && id > 0)
        ));
        if (snippetIds.length > 0) {
          const regexSnippetSql = `
            SELECT pv.id,
              COALESCE(
                (SELECT substring(pv."search_text" FROM greatest(1, position(m[1] IN pv."search_text") - 10) FOR 300)
                 FROM regexp_matches(pv."search_text", $1, 'i') AS m LIMIT 1),
                LEFT(COALESCE(pv."search_text", ''), 300)
              ) AS context
            FROM "PageVersion" pv
            WHERE pv.id = ANY($2::int[])
          `;
          const { rows: snippetRows } = await db.query(regexSnippetSql, [trimmedQuery, snippetIds]);
          for (const sr of snippetRows) {
            const ctx = typeof sr.context === 'string' ? sr.context : null;
            snippetMap.set(Number(sr.id), highlightRegexSnippet(ctx, trimmedQuery) ?? extractExcerpt(ctx, 180));
          }
        }
      }

      const results = rows.map((row: any) => {
        const { search_preview: _searchPreview, ...rest } = row;
        const snippet = wantSnippet
          ? snippetMap.get(Number(row.id)) ?? null
          : null;
        const base = wantDate ? { ...rest } : (({ firstRevisionAt, ...restNoDate }: any) => restNoDate)(rest);
        return { ...base, snippet, excerpt: snippet, textScore: null };
      });

      return total !== undefined ? { results, total } : { results };
    }

    // ── PGroonga 模式：4-CTE 候选排序 ───────────────────
    // 根据 regexMode 条件化搜索操作符（下面仅用于 PGroonga 模式）
    const urlMatchSql = 'p."currentUrl" &@~ pgroonga_query_escape($1)';
    const titleMatchSql = 'pv.title &@~ pgroonga_query_escape($1)';
    const altTitleMatchSql = 'pv."alternateTitle" &@~ pgroonga_query_escape($1)';
    const textMatchSql = 'pv."search_text" &@~ pgroonga_query_escape($1)';
    const scoreExprSql = 'pgroonga_score(pv.tableoid, pv.ctid) AS score';
    const aTitleMatchSql = 'a.title &@~ pgroonga_query_escape($1)';
    const aAltMatchSql = 'a."alternateTitle" &@~ pgroonga_query_escape($1)';

    const baseSql = `
        WITH url_hits AS (
          SELECT pv.id AS pv_id,
                 1.0 AS weight,
                 NULL::double precision AS score,
                 'url'::text AS source
          FROM "Page" p
          JOIN "PageVersion" pv ON pv."pageId" = p.id AND pv."validTo" IS NULL
          WHERE $1::text IS NOT NULL
            AND ${urlMatchSql}
          LIMIT $10::int
        ),
        title_hits AS (
          SELECT pv.id AS pv_id,
                 0.9 AS weight,
                 ${scoreExprSql},
                 'title'::text AS source
          FROM "PageVersion" pv
          WHERE pv."validTo" IS NULL
            AND ${titleMatchSql}
          ORDER BY score DESC
          LIMIT $10::int
        ),
        alternate_hits AS (
          SELECT pv.id AS pv_id,
                 0.8 AS weight,
                 ${scoreExprSql},
                 'alternate'::text AS source
          FROM "PageVersion" pv
          WHERE pv."validTo" IS NULL
            AND pv."alternateTitle" IS NOT NULL
            AND ${altTitleMatchSql}
          ORDER BY score DESC
          LIMIT $10::int
        ),
        text_hits AS (
          SELECT pv.id AS pv_id,
                 0.5 AS weight,
                 ${scoreExprSql},
                 'text'::text AS source
          FROM "PageVersion" pv
          WHERE pv."validTo" IS NULL
            AND pv."search_text" <> ''
            AND ${textMatchSql}
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
            SELECT id, rating, "voteCount", "commentCount", tags
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
            ${buildAuthorFilterClause('COALESCE(CASE WHEN pv."isDeleted" THEN prev.id ELSE pv.id END, pv.id)', 21, 22, 23)}
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
          CASE WHEN a.title IS NOT NULL AND ${aTitleMatchSql} THEN 1 ELSE 0 END AS title_hit,
          CASE WHEN a."alternateTitle" IS NOT NULL AND ${aAltMatchSql} THEN 1 ELSE 0 END AS alt_hit
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
            AND ${urlMatchSql}
          LIMIT $7::int
        ),
        title_hits AS (
          SELECT pv.id AS pv_id
          FROM "PageVersion" pv
          WHERE pv."validTo" IS NULL
            AND ${titleMatchSql}
          LIMIT $7::int
        ),
        alternate_hits AS (
          SELECT pv.id AS pv_id
          FROM "PageVersion" pv
          WHERE pv."validTo" IS NULL
            AND pv."alternateTitle" IS NOT NULL
            AND ${altTitleMatchSql}
          LIMIT $7::int
        ),
        text_hits AS (
          SELECT pv.id AS pv_id
          FROM "PageVersion" pv
          WHERE pv."validTo" IS NULL
            AND pv."search_text" <> ''
            AND ${textMatchSql}
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
            SELECT id, rating, "voteCount", "commentCount", tags
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
            ${buildAuthorFilterClause('COALESCE(CASE WHEN pv."isDeleted" THEN prev.id ELSE pv.id END, pv.id)', 18, 19, 20)}
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
      dateMaxParam,           // $20
      authorIdsParam,         // $21
      authorMatchParam,       // $22
      authorIdsCountParam     // $23
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
          dateMaxParam,           // $17
          authorIdsParam,         // $18
          authorMatchParam,       // $19
          authorIdsCountParam     // $20
        ]
      : null;

    const [{ rows }, totalRes] = await Promise.all([
      db.query(baseSql, params),
      totalSql && totalParams ? db.query(totalSql, totalParams) : Promise.resolve(null as any)
    ]);

    let highlightMap: Map<number, string | null> = new Map();
    if (wantSnippet && snippetTop > 0 && rows.length > 0 && !regexMode) {
      const highlightIds = Array.from(
        new Set(
          rows
            .slice(0, snippetTop)
            .map((row: any) => Number(row.id))
            .filter((id: number) => Number.isInteger(id) && id > 0)
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
        const { rows: snippetRows } = await db.query(snippetSql, [trimmedQuery, highlightIds]);
        highlightMap = new Map(
          snippetRows.map((row: any) => [Number(row.id), typeof row.snippet === 'string' ? row.snippet : null])
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
    let regexMode = false;
    try {
      const {
        query,
        limit = '20',
        offset = '0',
        tags,
        excludeTags,
        authorIds,
        authorMatch,
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
        dateMax,
        isRegex
      } = req.query as Record<string, string | string[] | undefined>;

      const normalizedDeletedFilter = normalizeDeletedFilter(deletedFilter);
      const authorIdsArray = parseNullableIntArray(authorIds);
      const normalizedAuthorMatch = normalizeAuthorMatch(authorMatch);
      const hasFilters = tags || excludeTags || ratingMin || ratingMax ||
        wilson95Min || wilson95Max || controversyMin || controversyMax ||
        commentCountMin || commentCountMax || voteCountMin || voteCountMax ||
        dateMin || dateMax || normalizedDeletedFilter !== 'any' ||
        Boolean(authorIdsArray && authorIdsArray.length > 0);
      if (!query && !hasFilters) {
        return res.status(400).json({ error: 'query or filters are required' });
      }

      const normalizedQuery = Array.isArray(query) ? query[0] : query;
      const normalizedIsRegex = Array.isArray(isRegex) ? isRegex[0] : isRegex;
      const wantTotal = String(includeTotal).toLowerCase() === 'true';
      const wantSnippet = String(includeSnippet).toLowerCase() === 'true';
      const wantDate = String(includeDate).toLowerCase() === 'true';
      const trimmedQuery = normalizedQuery ? normalizedQuery.trim() : '';
      const hasQuery = trimmedQuery.length > 0;
      regexMode = ['true', '1', 'yes'].includes(String(normalizedIsRegex || '').toLowerCase()) && hasQuery;

      // 正则校验
      if (regexMode) {
        const validation = validateRegex(trimmedQuery);
        if (!validation.valid) {
          return res.status(400).json({ error: 'invalid_regex', message: validation.error });
        }
      }
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
      const rawOrder = (() => {
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
      // 正则模式下无 PGroonga 相关性分数，自动降级为 rating
      const normalizedOrder = regexMode && rawOrder === 'relevance' ? 'rating' : rawOrder;
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
        authorIds: authorIdsArray ?? undefined,
        authorMatch: authorIdsArray ? normalizedAuthorMatch : undefined,
        deleted: normalizedDeletedFilter,
        exactTags: enforceExactTags,
        isRegex: regexMode || undefined
      };

      const cacheKey = buildCacheKey(
        hasQuery ? 'search:pages:query' : 'search:pages:filters',
        cacheParamsBase
      );
      const cached = await readCache<{ results: any[]; total?: number }>(cacheKey);
      if (cached) {
        return res.json(cached);
      }

      const searchArgs: PageSearchArgs = {
        trimmedQuery,
        limit: limitInt,
        offset: offsetInt,
        includeTags: includeTagsArray,
        excludeTags: excludeTagsArray,
        authorIds: authorIdsArray,
        authorMatch: normalizedAuthorMatch,
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
        regexMode,
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
      };

      const pageData = regexMode
        ? await withRegexTimeout(client => executePageSearch(searchArgs, client))
        : await executePageSearch(searchArgs);

      const payload = pageData.total !== undefined
        ? { results: pageData.results, total: pageData.total }
        : { results: pageData.results };

      await writeCache(cacheKey, payload, defaultCacheTtl);
      return res.json(payload);
    } catch (err: any) {
      if (regexMode && err?.code === '2201B') {
        return res.status(400).json({
          error: 'invalid_regex',
          message: '无效的正则表达式：' + (err.message || '语法错误')
        });
      }
      if (regexMode && err?.message?.includes('statement timeout')) {
        return res.status(400).json({
          error: 'regex_timeout',
          message: '正则表达式执行超时，请简化表达式'
        });
      }
      next(err);
    }
  });

  // GET /search/users
  router.get('/users', async (req, res, next) => {
    let userRegexMode = false;
    try {
      const { query, limit = '20', offset = '0', includeTotal = 'true', isRegex } = req.query as Record<string, string>;
      if (!query) return res.status(400).json({ error: 'query is required' });
      const wantTotal = String(includeTotal).toLowerCase() === 'true';
      userRegexMode = ['true', '1', 'yes'].includes(String(isRegex || '').toLowerCase());

      if (userRegexMode) {
        const validation = validateRegex(query.trim());
        if (!validation.valid) {
          return res.status(400).json({ error: 'invalid_regex', message: validation.error });
        }
      }

      const userMatchSql = userRegexMode
        ? `u."displayName" ~* $1 OR u.username ~* $1 OR replace(u.username, '_', ' ') ~* $1`
        : `u."displayName" &@~ pgroonga_query_escape($1) OR u.username &@~ pgroonga_query_escape($1) OR replace(u.username, '_', ' ') &@~ pgroonga_query_escape($1)`;

      const sql = `
        SELECT
          u.id,
          u."wikidotId",
          COALESCE(u."displayName", u.username) AS "displayName",
          us."overallRank" AS rank,
          COALESCE(us."totalRating", 0) AS "totalRating",
          COALESCE(us."pageCount", 0) AS "pageCount"
        FROM "User" u
        LEFT JOIN "UserStats" us ON u.id = us."userId"
        WHERE u."wikidotId" IS NOT NULL
          AND (${userMatchSql})
        ORDER BY us."totalRating" DESC NULLS LAST
        LIMIT $2::int OFFSET $3::int
      `;
      const totalCountSql = `SELECT COUNT(*) AS total FROM "User" u WHERE u."wikidotId" IS NOT NULL AND (${userMatchSql})`;

      if (userRegexMode) {
        const result = await withRegexTimeout(async (client) => {
          const [rowsRes, totalRes] = await Promise.all([
            client.query(sql, [query, limit, offset]),
            wantTotal ? client.query(totalCountSql, [query]) : Promise.resolve(null as any)
          ]);
          return { rowsRes, totalRes };
        });
        const results = result.rowsRes.rows;
        const total = result.totalRes ? Number(result.totalRes.rows?.[0]?.total || 0) : undefined;
        res.json(total !== undefined ? { results, total } : { results });
      } else {
        const [rowsRes, totalRes] = await Promise.all([
          readPool.query(sql, [query, limit, offset]),
          wantTotal ? readPool.query(totalCountSql, [query]) : Promise.resolve(null as any)
        ]);
        const results = rowsRes.rows;
        const total = totalRes ? Number(totalRes.rows?.[0]?.total || 0) : undefined;
        res.json(total !== undefined ? { results, total } : { results });
      }
    } catch (err: any) {
      if (userRegexMode && err?.code === '2201B') {
        return res.status(400).json({
          error: 'invalid_regex',
          message: '无效的正则表达式：' + (err.message || '语法错误')
        });
      }
      if (userRegexMode && err?.message?.includes('statement timeout')) {
        return res.status(400).json({
          error: 'regex_timeout',
          message: '正则表达式执行超时，请简化表达式'
        });
      }
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
        authorIds,
        authorMatch,
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
      } = req.query as Record<string, string | string[] | undefined>;

      const normalizedQuery = Array.isArray(query) ? query[0] : query;
      if (!normalizedQuery) return res.status(400).json({ error: 'query is required' });

      const trimmedQuery = normalizedQuery.trim();
      const normalizedOrderBy = String(Array.isArray(orderBy) ? orderBy[0] : (orderBy || 'relevance'));
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
      const authorIdsArray = parseNullableIntArray(authorIds);
      const normalizedAuthorMatch = normalizeAuthorMatch(authorMatch);
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
        orderBy: normalizedOrderBy,
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
        authorIds: authorIdsArray ?? undefined,
        authorMatch: authorIdsArray ? normalizedAuthorMatch : undefined,
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
        authorIds: authorIdsArray,
        authorMatch: normalizedAuthorMatch,
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
        regexMode: false,
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
          COALESCE(u."displayName", u.username) AS "displayName",
          us."overallRank" AS rank,
          COALESCE(us."totalRating", 0) AS "totalRating",
          COALESCE(us."pageCount", 0) AS "pageCount",
          pgroonga_score(u.tableoid, u.ctid) AS score
        FROM "User" u
        LEFT JOIN "UserStats" us ON u.id = us."userId"
        WHERE u."wikidotId" IS NOT NULL
          AND (
            u."displayName" &@~ pgroonga_query_escape($1)
            OR u.username &@~ pgroonga_query_escape($1)
            OR replace(u.username, '_', ' ') &@~ pgroonga_query_escape($1)
          )
        ORDER BY score DESC NULLS LAST, us."totalRating" DESC NULLS LAST
        LIMIT $2::int OFFSET $3::int
      `;
      const userParams = [trimmedQuery, String(Math.max(userCap, 0)), '0'];

      const userCountSql = `
        SELECT COUNT(*) AS total
        FROM "User" u
        WHERE u."wikidotId" IS NOT NULL
          AND (
            u."displayName" &@~ pgroonga_query_escape($1)
            OR u.username &@~ pgroonga_query_escape($1)
            OR replace(u.username, '_', ' ') &@~ pgroonga_query_escape($1)
          )
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
      switch (normalizedOrderBy.toLowerCase()) {
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
          orderBy: normalizedOrderBy
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

  // ─── Forum post search ────────────────────────────────
  router.get('/forums', async (req, res, next) => {
    try {
      const query = String(req.query.query || '').trim();
      if (!query || query.length < 2) {
        return res.status(400).json({ error: 'query_too_short', message: '关键词至少需要 2 个字符' });
      }

      const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
      const offset = Math.max(0, Number(req.query.offset) || 0);
      const wantTotal = String(req.query.includeTotal || 'true') === 'true';

      const dateMin = req.query.dateMin ? String(req.query.dateMin) : null;
      const dateMax = req.query.dateMax ? String(req.query.dateMax) : null;

      const rawAuthorIds = req.query.authorIds;
      const authorIds: number[] = rawAuthorIds
        ? (Array.isArray(rawAuthorIds) ? rawAuthorIds : [rawAuthorIds])
            .flatMap((v) => String(v).split(','))
            .map((v) => Number.parseInt(v.trim(), 10))
            .filter((v) => Number.isInteger(v) && v > 0)
        : [];

      const escapedQuery = query.replace(/[%_\\]/g, '\\$&');
      const searchPattern = `%${escapedQuery}%`;

      // Build WHERE clauses
      const conditions: string[] = [
        'p."isDeleted" = false',
        't."isDeleted" = false',
        `(p."textHtml" ILIKE $1 OR p.title ILIKE $1 OR t.title ILIKE $1)`,
      ];
      const params: any[] = [searchPattern];
      let paramIdx = 2;

      if (dateMin) {
        conditions.push(`p."createdAt" >= $${paramIdx}`);
        params.push(dateMin);
        paramIdx++;
      }
      if (dateMax) {
        conditions.push(`p."createdAt" < ($${paramIdx}::date + interval '1 day')`);
        params.push(dateMax);
        paramIdx++;
      }
      if (authorIds.length > 0) {
        conditions.push(`p."createdByWikidotId" = ANY($${paramIdx}::int[])`);
        params.push(authorIds);
        paramIdx++;
      }

      const whereClause = conditions.join(' AND ');

      const baseFrom = `
        FROM "ForumPost" p
        JOIN "ForumThread" t ON t.id = p."threadId"
        LEFT JOIN "ForumCategory" c ON c.id = t."categoryId"
        WHERE ${whereClause}
      `;

      const queries: Promise<any>[] = [
        readPool.query(`
          SELECT p.id AS "postId", p.title, p."textHtml",
                 p."createdByName", p."createdByWikidotId", p."createdAt",
                 p."threadId",
                 t.title AS "threadTitle",
                 c.title AS "categoryTitle"
          ${baseFrom}
          ORDER BY p."createdAt" DESC NULLS LAST
          LIMIT $${paramIdx} OFFSET $${paramIdx + 1}
        `, [...params, limit, offset]),
      ];

      if (wantTotal) {
        queries.push(
          readPool.query(`SELECT COUNT(*)::int AS total ${baseFrom}`, params)
        );
      }

      const results = await Promise.all(queries);
      const rows = results[0].rows;

      const payload: { results: any[]; total?: number } = {
        results: rows,
      };
      if (wantTotal && results[1]) {
        payload.total = results[1].rows[0]?.total ?? 0;
      }

      return res.json(payload);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
