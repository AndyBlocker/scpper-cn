import { Router } from 'express';
import type { Pool } from 'pg';
import type { RedisClientType } from 'redis';

export function searchRouter(pool: Pool, _redis: RedisClientType | null) {
  const router = Router();

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
        onlyIncludeTags,
        orderBy = 'relevance',
        includeTotal = 'true',
        includeSnippet = 'true',
        includeDate = 'true'
      } = req.query as Record<string, string>;
      
      // 如果没有query但有其他过滤条件（如tags），则允许搜索
      const hasFilters = tags || excludeTags || ratingMin || ratingMax;
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
      const candidateLimit = Math.max(limitInt * 8, 200);
      const includeTagsArray = tags
        ? (Array.isArray(tags) ? (tags as string[]) : [tags as string])
        : null;
      const excludeTagsArray = excludeTags
        ? (Array.isArray(excludeTags) ? (excludeTags as string[]) : [excludeTags as string])
        : null;
      const enforceExactTags = ['true', '1', 'yes'].includes(String(onlyIncludeTags || '').toLowerCase()) && !!(includeTagsArray && includeTagsArray.length > 0);
      const normalizedOrder = (() => {
        const key = String(orderBy || '').toLowerCase();
        if (key === 'rating_asc') return 'rating_asc';
        if (key === 'recent_asc') return 'recent_asc';
        if (key === 'rating_desc') return 'rating';
        if (key === 'recent_desc') return 'recent';
        if (key === 'rating') return 'rating';
        if (key === 'recent') return 'recent';
        return 'relevance';
      })();

      if (!hasQuery) {
      const baseSql = `
          WITH base AS (
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
              pv."isDeleted" AS "isDeleted",
              CASE WHEN pv."isDeleted" THEN pv."validFrom" ELSE NULL END AS "deletedAt",
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
              AND ($1::text[] IS NULL OR COALESCE(CASE WHEN pv."isDeleted" THEN prev.tags ELSE pv.tags END, ARRAY[]::text[]) @> $1::text[])
              AND ($2::text[] IS NULL OR NOT (COALESCE(CASE WHEN pv."isDeleted" THEN prev.tags ELSE pv.tags END, ARRAY[]::text[]) && $2::text[]))
              AND ($3::int IS NULL OR pv.rating >= $3)
              AND ($4::int IS NULL OR pv.rating <= $4)
              AND (($5)::boolean IS NOT TRUE OR $1::text[] IS NULL OR COALESCE(CASE WHEN pv."isDeleted" THEN prev.tags ELSE pv.tags END, ARRAY[]::text[]) <@ $1::text[])
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
            b.rating DESC NULLS LAST,
            b."firstRevisionAt" DESC NULLS LAST,
            b.id DESC
          LIMIT $7::int OFFSET $8::int
        `;

        const params = [
          includeTagsArray,
          excludeTagsArray,
          ratingMin || null,
          ratingMax || null,
          enforceExactTags,
          normalizedOrder,
          limitInt,
          offsetInt
        ];

        const [{ rows }, totalRes] = await Promise.all([
          pool.query(finalSql, params),
          wantTotal
            ? pool.query(
                `SELECT COUNT(*) AS total
                 FROM "PageVersion" pv
                 LEFT JOIN LATERAL (
                   SELECT tags
                   FROM "PageVersion" pv_prev
                   WHERE pv_prev."pageId" = pv."pageId"
                     AND pv_prev."isDeleted" = false
                   ORDER BY pv_prev."validTo" DESC NULLS LAST, pv_prev.id DESC
                   LIMIT 1
                 ) prev ON TRUE
                 WHERE pv."validTo" IS NULL
                  AND ($1::text[] IS NULL OR COALESCE(CASE WHEN pv."isDeleted" THEN prev.tags ELSE pv.tags END, ARRAY[]::text[]) @> $1::text[])
                  AND ($2::text[] IS NULL OR NOT (COALESCE(CASE WHEN pv."isDeleted" THEN prev.tags ELSE pv.tags END, ARRAY[]::text[]) && $2::text[]))
                  AND ($3::int IS NULL OR pv.rating >= $3)
                  AND ($4::int IS NULL OR pv.rating <= $4)
                  AND (($5)::boolean IS NOT TRUE OR $1::text[] IS NULL OR COALESCE(CASE WHEN pv."isDeleted" THEN prev.tags ELSE pv.tags END, ARRAY[]::text[]) <@ $1::text[])`,
                [includeTagsArray, excludeTagsArray, ratingMin || null, ratingMax || null, enforceExactTags]
              )
            : Promise.resolve(null as any)
        ]);

        const total = totalRes ? Number(totalRes.rows?.[0]?.total || 0) : undefined;

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
                     SUBSTRING(pv."textContent" FOR 2000) AS "textSnippet"
              FROM "PageVersion" pv
              WHERE pv."validTo" IS NULL
                AND pv."pageId" = ANY($1::int[])
            `;
            const { rows: snippetRows } = await pool.query(snippetSql, [pageIds]);
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
          if (!wantDate) {
            const { firstRevisionAt, ...rest } = r;
            return {
              ...rest,
              snippet,
              excerpt: snippet
            };
          }
          return {
            ...r,
            snippet,
            excerpt: snippet
          };
        });

        return res.json(total !== undefined ? { results, total } : { results });
      }

      const baseSql = `
        WITH url_hits AS (
          SELECT pv.id AS pv_id,
                 1.0 AS weight,
                 NULL::double precision AS score,
                 'url'::text AS source
          FROM "Page" p
          JOIN "PageVersion" pv ON pv."pageId" = p.id AND pv."validTo" IS NULL
          LEFT JOIN LATERAL (
            SELECT tags
            FROM "PageVersion" pv_prev
            WHERE pv_prev."pageId" = pv."pageId"
              AND pv_prev."isDeleted" = false
            ORDER BY pv_prev."validTo" DESC NULLS LAST, pv_prev.id DESC
            LIMIT 1
          ) prev ON TRUE
          WHERE $1::text IS NOT NULL
            AND p."currentUrl" &@~ pgroonga_query_escape($1)
            AND ($2::text[] IS NULL OR COALESCE(CASE WHEN pv."isDeleted" THEN prev.tags ELSE pv.tags END, ARRAY[]::text[]) @> $2::text[])
            AND ($3::text[] IS NULL OR NOT (COALESCE(CASE WHEN pv."isDeleted" THEN prev.tags ELSE pv.tags END, ARRAY[]::text[]) && $3::text[]))
            AND ($4::int IS NULL OR pv.rating >= $4)
            AND ($5::int IS NULL OR pv.rating <= $5)
            AND (($6)::boolean IS NOT TRUE OR $2::text[] IS NULL OR COALESCE(CASE WHEN pv."isDeleted" THEN prev.tags ELSE pv.tags END, ARRAY[]::text[]) <@ $2::text[])
          LIMIT $10::int
        ),
        title_hits AS (
          SELECT pv.id AS pv_id,
                 0.9 AS weight,
                 pgroonga_score(pv.tableoid, pv.ctid) AS score,
                 'title'::text AS source
          FROM "PageVersion" pv
          LEFT JOIN LATERAL (
            SELECT tags
            FROM "PageVersion" pv_prev
            WHERE pv_prev."pageId" = pv."pageId"
              AND pv_prev."isDeleted" = false
            ORDER BY pv_prev."validTo" DESC NULLS LAST, pv_prev.id DESC
            LIMIT 1
          ) prev ON TRUE
          WHERE pv."validTo" IS NULL
            AND pv.title &@~ pgroonga_query_escape($1)
            AND ($2::text[] IS NULL OR COALESCE(CASE WHEN pv."isDeleted" THEN prev.tags ELSE pv.tags END, ARRAY[]::text[]) @> $2::text[])
            AND ($3::text[] IS NULL OR NOT (COALESCE(CASE WHEN pv."isDeleted" THEN prev.tags ELSE pv.tags END, ARRAY[]::text[]) && $3::text[]))
            AND ($4::int IS NULL OR pv.rating >= $4)
            AND ($5::int IS NULL OR pv.rating <= $5)
            AND (($6)::boolean IS NOT TRUE OR $2::text[] IS NULL OR COALESCE(CASE WHEN pv."isDeleted" THEN prev.tags ELSE pv.tags END, ARRAY[]::text[]) <@ $2::text[])
          ORDER BY score DESC
          LIMIT $10::int
        ),
        alternate_hits AS (
          SELECT pv.id AS pv_id,
                 0.8 AS weight,
                 pgroonga_score(pv.tableoid, pv.ctid) AS score,
                 'alternate'::text AS source
          FROM "PageVersion" pv
          LEFT JOIN LATERAL (
            SELECT tags
            FROM "PageVersion" pv_prev
            WHERE pv_prev."pageId" = pv."pageId"
              AND pv_prev."isDeleted" = false
            ORDER BY pv_prev."validTo" DESC NULLS LAST, pv_prev.id DESC
            LIMIT 1
          ) prev ON TRUE
          WHERE pv."validTo" IS NULL
            AND pv."alternateTitle" IS NOT NULL
            AND pv."alternateTitle" &@~ pgroonga_query_escape($1)
            AND ($2::text[] IS NULL OR COALESCE(CASE WHEN pv."isDeleted" THEN prev.tags ELSE pv.tags END, ARRAY[]::text[]) @> $2::text[])
            AND ($3::text[] IS NULL OR NOT (COALESCE(CASE WHEN pv."isDeleted" THEN prev.tags ELSE pv.tags END, ARRAY[]::text[]) && $3::text[]))
            AND ($4::int IS NULL OR pv.rating >= $4)
            AND ($5::int IS NULL OR pv.rating <= $5)
            AND (($6)::boolean IS NOT TRUE OR $2::text[] IS NULL OR COALESCE(CASE WHEN pv."isDeleted" THEN prev.tags ELSE pv.tags END, ARRAY[]::text[]) <@ $2::text[])
          ORDER BY score DESC
          LIMIT $10::int
        ),
        text_hits AS (
          SELECT pv.id AS pv_id,
                 0.5 AS weight,
                 pgroonga_score(pv.tableoid, pv.ctid) AS score,
                 'text'::text AS source
          FROM "PageVersion" pv
          LEFT JOIN LATERAL (
            SELECT tags
            FROM "PageVersion" pv_prev
            WHERE pv_prev."pageId" = pv."pageId"
              AND pv_prev."isDeleted" = false
            ORDER BY pv_prev."validTo" DESC NULLS LAST, pv_prev.id DESC
            LIMIT 1
          ) prev ON TRUE
          WHERE pv."validTo" IS NULL
            AND pv."textContent" &@~ pgroonga_query_escape($1)
            AND ($2::text[] IS NULL OR COALESCE(CASE WHEN pv."isDeleted" THEN prev.tags ELSE pv.tags END, ARRAY[]::text[]) @> $2::text[])
            AND ($3::text[] IS NULL OR NOT (COALESCE(CASE WHEN pv."isDeleted" THEN prev.tags ELSE pv.tags END, ARRAY[]::text[]) && $3::text[]))
            AND ($4::int IS NULL OR pv.rating >= $4)
            AND ($5::int IS NULL OR pv.rating <= $5)
            AND (($6)::boolean IS NOT TRUE OR $2::text[] IS NULL OR COALESCE(CASE WHEN pv."isDeleted" THEN prev.tags ELSE pv.tags END, ARRAY[]::text[]) <@ $2::text[])
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
        filtered AS (
          SELECT
            c.pv_id,
            MAX(c.weight) AS weight,
            MAX(c.score) AS score,
            MAX(CASE WHEN c.source = 'url' THEN 1 ELSE 0 END) AS has_url,
            MAX(CASE WHEN c.source = 'title' THEN 1 ELSE 0 END) AS has_title,
            MAX(CASE WHEN c.source = 'alternate' THEN 1 ELSE 0 END) AS has_alt,
            MAX(CASE WHEN c.source = 'text' THEN 1 ELSE 0 END) AS has_text
          FROM candidates c
          JOIN "PageVersion" pv ON pv.id = c.pv_id
          LEFT JOIN LATERAL (
            SELECT tags
            FROM "PageVersion" pv_prev
            WHERE pv_prev."pageId" = pv."pageId"
              AND pv_prev."isDeleted" = false
            ORDER BY pv_prev."validTo" DESC NULLS LAST, pv_prev.id DESC
            LIMIT 1
          ) prev ON TRUE
          WHERE pv."validTo" IS NULL
            AND ($2::text[] IS NULL OR COALESCE(CASE WHEN pv."isDeleted" THEN prev.tags ELSE pv.tags END, ARRAY[]::text[]) @> $2::text[])
            AND ($3::text[] IS NULL OR NOT (COALESCE(CASE WHEN pv."isDeleted" THEN prev.tags ELSE pv.tags END, ARRAY[]::text[]) && $3::text[]))
            AND ($4::int IS NULL OR pv.rating >= $4)
            AND ($5::int IS NULL OR pv.rating <= $5)
            AND (($6)::boolean IS NOT TRUE OR $2::text[] IS NULL OR COALESCE(CASE WHEN pv."isDeleted" THEN prev.tags ELSE pv.tags END, ARRAY[]::text[]) <@ $2::text[])
          GROUP BY c.pv_id
        ),
        ranked AS (
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
            pv."isDeleted" AS "isDeleted",
            CASE WHEN pv."isDeleted" THEN pv."validFrom" ELSE NULL END AS "deletedAt",
            pv."validFrom",
            ps."wilson95",
            ps."controversy",
            f.weight,
            f.score,
            f.has_url,
            f.has_title,
            f.has_alt,
            f.has_text,
            CASE WHEN lower(split_part(p."currentUrl", '/', 4)) = lower($1) THEN 1 ELSE 0 END AS host_match,
            CASE WHEN lower(p."currentUrl") = lower($1) THEN 1 ELSE 0 END AS exact_url,
            CASE WHEN lower(pv.title) = lower($1) THEN 1 ELSE 0 END AS exact_title,
            CASE WHEN pv.title &@~ pgroonga_query_escape($1) THEN 1 ELSE 0 END AS title_hit,
            CASE WHEN pv."alternateTitle" IS NOT NULL AND pv."alternateTitle" &@~ pgroonga_query_escape($1) THEN 1 ELSE 0 END AS alt_hit
          FROM filtered f
          JOIN "PageVersion" pv ON pv.id = f.pv_id
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
        )
      `;

      const finalSql = wantSnippet
        ? `${baseSql}
          SELECT r.*, sn.snippet
          FROM ranked r
          LEFT JOIN LATERAL (
            SELECT COALESCE(
              CASE WHEN r.title_hit = 1 THEN array_to_string(pgroonga_snippet_html(pv.title, kw.keywords, 200), ' ') END,
              CASE WHEN r.alt_hit = 1 THEN array_to_string(pgroonga_snippet_html(pv."alternateTitle", kw.keywords, 200), ' ') END,
              CASE WHEN r.has_text = 1 THEN array_to_string(pgroonga_snippet_html(pv."textContent", kw.keywords, 200), ' ') END,
              CASE WHEN r.has_url = 1 THEN array_to_string(pgroonga_snippet_html(p."currentUrl", kw.keywords, 200), ' ') END,
              array_to_string(pgroonga_snippet_html(pv.title, kw.keywords, 200), ' '),
              array_to_string(pgroonga_snippet_html(pv."alternateTitle", kw.keywords, 200), ' '),
              array_to_string(pgroonga_snippet_html(pv."textContent", kw.keywords, 200), ' '),
              LEFT(pv."textContent", 200),
              pv.title
            ) AS snippet
            FROM "PageVersion" pv
            JOIN "Page" p ON p.id = pv."pageId"
            LEFT JOIN LATERAL (
              SELECT pgroonga_query_extract_keywords(pgroonga_query_escape($1)) AS keywords
            ) kw ON TRUE
            WHERE pv.id = r.id
              AND $1 IS NOT NULL
          ) sn ON TRUE
          ORDER BY 
            CASE WHEN $9 IN ('rating', 'rating_asc') THEN NULL END,
            CASE WHEN $9 IN ('recent', 'recent_asc') THEN NULL END,
            r.host_match DESC NULLS LAST,
            r.exact_url DESC NULLS LAST,
            r.exact_title DESC NULLS LAST,
            r.title_hit DESC NULLS LAST,
            r.alt_hit DESC NULLS LAST,
            r.has_url DESC NULLS LAST,
            r.has_title DESC NULLS LAST,
            r.has_alt DESC NULLS LAST,
            r.has_text DESC NULLS LAST,
            CASE WHEN ($9 IS NULL OR $9 = 'relevance') THEN COALESCE(r.score, 0) END DESC NULLS LAST,
            CASE WHEN $9 = 'rating' THEN r.rating END DESC NULLS LAST,
            CASE WHEN $9 = 'rating_asc' THEN r.rating END ASC NULLS LAST,
            CASE WHEN $9 = 'recent' THEN COALESCE(r."firstRevisionAt", r."validFrom") END DESC NULLS LAST,
            CASE WHEN $9 = 'recent_asc' THEN COALESCE(r."firstRevisionAt", r."validFrom") END ASC NULLS LAST,
            r.rating DESC NULLS LAST,
            r.id DESC
          LIMIT $7::int OFFSET $8::int
        `
        : `${baseSql}
          SELECT r.*
          FROM ranked r
          ORDER BY 
            CASE WHEN $9 IN ('rating', 'rating_asc') THEN NULL END,
            CASE WHEN $9 IN ('recent', 'recent_asc') THEN NULL END,
            r.host_match DESC NULLS LAST,
            r.exact_url DESC NULLS LAST,
            r.exact_title DESC NULLS LAST,
            r.title_hit DESC NULLS LAST,
            r.alt_hit DESC NULLS LAST,
            r.has_url DESC NULLS LAST,
            r.has_title DESC NULLS LAST,
            r.has_alt DESC NULLS LAST,
            r.has_text DESC NULLS LAST,
            CASE WHEN ($9 IS NULL OR $9 = 'relevance') THEN COALESCE(r.score, 0) END DESC NULLS LAST,
            CASE WHEN $9 = 'rating' THEN r.rating END DESC NULLS LAST,
            CASE WHEN $9 = 'rating_asc' THEN r.rating END ASC NULLS LAST,
            CASE WHEN $9 = 'recent' THEN COALESCE(r."firstRevisionAt", r."validFrom") END DESC NULLS LAST,
            CASE WHEN $9 = 'recent_asc' THEN COALESCE(r."firstRevisionAt", r."validFrom") END ASC NULLS LAST,
            r.rating DESC NULLS LAST,
            r.id DESC
          LIMIT $7::int OFFSET $8::int
        `;

      const params = [
        trimmedQuery,
        includeTagsArray,
        excludeTagsArray,
        ratingMin || null,
        ratingMax || null,
        enforceExactTags,
        limitInt,
        offsetInt,
        normalizedOrder,
        candidateLimit
      ];

      const [{ rows }, totalRes] = await Promise.all([
        pool.query(finalSql, params),
        wantTotal
          ? pool.query(
               `WITH url_hits AS (
                 SELECT pv.id AS pv_id
                 FROM "Page" p
                 JOIN "PageVersion" pv ON pv."pageId" = p.id AND pv."validTo" IS NULL
                 LEFT JOIN LATERAL (
                   SELECT tags
                   FROM "PageVersion" pv_prev
                   WHERE pv_prev."pageId" = pv."pageId"
                     AND pv_prev."isDeleted" = false
                   ORDER BY pv_prev."validTo" DESC NULLS LAST, pv_prev.id DESC
                   LIMIT 1
                 ) prev ON TRUE
                 WHERE $1::text IS NOT NULL
                   AND p."currentUrl" &@~ pgroonga_query_escape($1)
                   AND ($2::text[] IS NULL OR COALESCE(CASE WHEN pv."isDeleted" THEN prev.tags ELSE pv.tags END, ARRAY[]::text[]) @> $2::text[])
                   AND ($3::text[] IS NULL OR NOT (COALESCE(CASE WHEN pv."isDeleted" THEN prev.tags ELSE pv.tags END, ARRAY[]::text[]) && $3::text[]))
                   AND ($4::int IS NULL OR pv.rating >= $4)
                   AND ($5::int IS NULL OR pv.rating <= $5)
                   AND (($6)::boolean IS NOT TRUE OR $2::text[] IS NULL OR COALESCE(CASE WHEN pv."isDeleted" THEN prev.tags ELSE pv.tags END, ARRAY[]::text[]) <@ $2::text[])
               ),
                title_hits AS (
                  SELECT pv.id AS pv_id
                  FROM "PageVersion" pv
                  LEFT JOIN LATERAL (
                    SELECT tags
                    FROM "PageVersion" pv_prev
                    WHERE pv_prev."pageId" = pv."pageId"
                      AND pv_prev."isDeleted" = false
                    ORDER BY pv_prev."validTo" DESC NULLS LAST, pv_prev.id DESC
                    LIMIT 1
                  ) prev ON TRUE
                  WHERE pv."validTo" IS NULL
                    AND pv.title &@~ pgroonga_query_escape($1)
                    AND ($2::text[] IS NULL OR COALESCE(CASE WHEN pv."isDeleted" THEN prev.tags ELSE pv.tags END, ARRAY[]::text[]) @> $2::text[])
                    AND ($3::text[] IS NULL OR NOT (COALESCE(CASE WHEN pv."isDeleted" THEN prev.tags ELSE pv.tags END, ARRAY[]::text[]) && $3::text[]))
                    AND ($4::int IS NULL OR pv.rating >= $4)
                    AND ($5::int IS NULL OR pv.rating <= $5)
                    AND (($6)::boolean IS NOT TRUE OR $2::text[] IS NULL OR COALESCE(CASE WHEN pv."isDeleted" THEN prev.tags ELSE pv.tags END, ARRAY[]::text[]) <@ $2::text[])
                ),
                alternate_hits AS (
                  SELECT pv.id AS pv_id
                  FROM "PageVersion" pv
                  LEFT JOIN LATERAL (
                    SELECT tags
                    FROM "PageVersion" pv_prev
                    WHERE pv_prev."pageId" = pv."pageId"
                      AND pv_prev."isDeleted" = false
                    ORDER BY pv_prev."validTo" DESC NULLS LAST, pv_prev.id DESC
                    LIMIT 1
                  ) prev ON TRUE
                  WHERE pv."validTo" IS NULL
                    AND pv."alternateTitle" IS NOT NULL
                    AND pv."alternateTitle" &@~ pgroonga_query_escape($1)
                    AND ($2::text[] IS NULL OR COALESCE(CASE WHEN pv."isDeleted" THEN prev.tags ELSE pv.tags END, ARRAY[]::text[]) @> $2::text[])
                    AND ($3::text[] IS NULL OR NOT (COALESCE(CASE WHEN pv."isDeleted" THEN prev.tags ELSE pv.tags END, ARRAY[]::text[]) && $3::text[]))
                    AND ($4::int IS NULL OR pv.rating >= $4)
                    AND ($5::int IS NULL OR pv.rating <= $5)
                    AND (($6)::boolean IS NOT TRUE OR $2::text[] IS NULL OR COALESCE(CASE WHEN pv."isDeleted" THEN prev.tags ELSE pv.tags END, ARRAY[]::text[]) <@ $2::text[])
                ),
                text_hits AS (
                  SELECT pv.id AS pv_id
                  FROM "PageVersion" pv
                  LEFT JOIN LATERAL (
                    SELECT tags
                    FROM "PageVersion" pv_prev
                    WHERE pv_prev."pageId" = pv."pageId"
                      AND pv_prev."isDeleted" = false
                    ORDER BY pv_prev."validTo" DESC NULLS LAST, pv_prev.id DESC
                    LIMIT 1
                  ) prev ON TRUE
                  WHERE pv."validTo" IS NULL
                    AND pv."textContent" &@~ pgroonga_query_escape($1)
                    AND ($2::text[] IS NULL OR COALESCE(CASE WHEN pv."isDeleted" THEN prev.tags ELSE pv.tags END, ARRAY[]::text[]) @> $2::text[])
                    AND ($3::text[] IS NULL OR NOT (COALESCE(CASE WHEN pv."isDeleted" THEN prev.tags ELSE pv.tags END, ARRAY[]::text[]) && $3::text[]))
                    AND ($4::int IS NULL OR pv.rating >= $4)
                    AND ($5::int IS NULL OR pv.rating <= $5)
                    AND (($6)::boolean IS NOT TRUE OR $2::text[] IS NULL OR COALESCE(CASE WHEN pv."isDeleted" THEN prev.tags ELSE pv.tags END, ARRAY[]::text[]) <@ $2::text[])
                ),
               candidates AS (
                 SELECT pv_id FROM url_hits
                 UNION
                 SELECT pv_id FROM title_hits
                 UNION
                 SELECT pv_id FROM alternate_hits
                 UNION
                 SELECT pv_id FROM text_hits
               ),
               filtered AS (
                 SELECT pv.id
                 FROM "PageVersion" pv
                 JOIN candidates c ON c.pv_id = pv.id
                 LEFT JOIN LATERAL (
                   SELECT tags
                   FROM "PageVersion" pv_prev
                   WHERE pv_prev."pageId" = pv."pageId"
                     AND pv_prev."isDeleted" = false
                   ORDER BY pv_prev."validTo" DESC NULLS LAST, pv_prev.id DESC
                   LIMIT 1
                 ) prev ON TRUE
                 WHERE pv."validTo" IS NULL
                   AND ($2::text[] IS NULL OR COALESCE(CASE WHEN pv."isDeleted" THEN prev.tags ELSE pv.tags END, ARRAY[]::text[]) @> $2::text[])
                   AND ($3::text[] IS NULL OR NOT (COALESCE(CASE WHEN pv."isDeleted" THEN prev.tags ELSE pv.tags END, ARRAY[]::text[]) && $3::text[]))
                   AND ($4::int IS NULL OR pv.rating >= $4)
                   AND ($5::int IS NULL OR pv.rating <= $5)
                   AND (($6)::boolean IS NOT TRUE OR $2::text[] IS NULL OR COALESCE(CASE WHEN pv."isDeleted" THEN prev.tags ELSE pv.tags END, ARRAY[]::text[]) <@ $2::text[])
               )
               SELECT COUNT(*) AS total FROM filtered`,
              [trimmedQuery, includeTagsArray, excludeTagsArray, ratingMin || null, ratingMax || null, enforceExactTags]
            )
          : Promise.resolve(null as any)
      ]);

      const total = totalRes ? Number(totalRes.rows?.[0]?.total || 0) : undefined;
      const results = rows.map((r: any) => {
        const {
          firstRevisionAt,
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
          ...rest
        } = r;
        if (!wantDate) {
          return rest;
        }
        return { firstRevisionAt, ...rest };
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
        WHERE u."displayName" &@~ pgroonga_query_escape($1)
        ORDER BY us."totalRating" DESC NULLS LAST
        LIMIT $2::int OFFSET $3::int
      `;
      const [rowsRes, totalRes] = await Promise.all([
        pool.query(sql, [query, limit, offset]),
        wantTotal ? pool.query(`SELECT COUNT(*) AS total FROM "User" WHERE "displayName" &@~ pgroonga_query_escape($1)`, [query]) : Promise.resolve(null as any)
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
        WITH url_hits AS (
          SELECT id
          FROM "Page"
          WHERE $1::text IS NOT NULL
            AND "currentUrl" &@~ pgroonga_query_escape($1)
        ),
        base AS (
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
            pv.tags,
            pgroonga_score(pv.tableoid, pv.ctid) AS score,
            pv."validFrom",
            pv."isDeleted" AS "isDeleted",
            CASE WHEN pv."isDeleted" THEN pv."validFrom" ELSE NULL END AS "deletedAt",
            ps."wilson95",
            ps."controversy"
          FROM "PageVersion" pv
          JOIN "Page" p ON pv."pageId" = p.id
          LEFT JOIN "PageStats" ps ON ps."pageVersionId" = pv.id
          LEFT JOIN url_hits uh ON uh.id = pv."pageId"
          WHERE pv."validTo" IS NULL
            AND (
              pv.title &@~ pgroonga_query_escape($1)
              OR (pv."alternateTitle" IS NOT NULL AND pv."alternateTitle" &@~ pgroonga_query_escape($1))
              OR uh.id IS NOT NULL
            )
            AND ($2::text[] IS NULL OR pv.tags @> $2::text[])
            AND ($3::text[] IS NULL OR NOT (pv.tags && $3::text[]))
            AND ($4::int IS NULL OR pv.rating >= $4)
            AND ($5::int IS NULL OR pv.rating <= $5)
        )
        SELECT * FROM base
        ORDER BY 
          CASE WHEN $8 = 'rating' THEN NULL END,
          CASE WHEN $8 = 'recent' THEN NULL END,
          CASE WHEN ($8 IS NULL OR $8 = 'relevance') AND $1 IS NOT NULL THEN (CASE WHEN lower(split_part(url, '/', 4)) = lower($1) THEN 1 ELSE 0 END) END DESC NULLS LAST,
          CASE WHEN ($8 IS NULL OR $8 = 'relevance') AND $1 IS NOT NULL THEN (CASE WHEN lower(url) = lower($1) THEN 1 ELSE 0 END) END DESC NULLS LAST,
          CASE WHEN ($8 IS NULL OR $8 = 'relevance') AND $1 IS NOT NULL THEN (CASE WHEN lower(title) = lower($1) THEN 1 ELSE 0 END) END DESC NULLS LAST,
          CASE WHEN ($8 IS NULL OR $8 = 'relevance') AND $1 IS NOT NULL THEN (CASE WHEN title &@~ pgroonga_query_escape($1) THEN 1 ELSE 0 END) END DESC NULLS LAST,
          CASE WHEN ($8 IS NULL OR $8 = 'relevance') AND $1 IS NOT NULL THEN (CASE WHEN "alternateTitle" IS NOT NULL AND "alternateTitle" &@~ pgroonga_query_escape($1) THEN 1 ELSE 0 END) END DESC NULLS LAST,
          CASE WHEN $8 IS NULL OR $8 = 'relevance' THEN score END DESC NULLS LAST,
          CASE WHEN $8 = 'rating' THEN rating END DESC NULLS LAST,
          CASE WHEN $8 = 'recent' THEN COALESCE("firstRevisionAt", "validFrom") END DESC
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
        WHERE u."displayName" &@~ pgroonga_query_escape($1)
        ORDER BY score DESC NULLS LAST, us."totalRating" DESC NULLS LAST
        LIMIT $2::int OFFSET $3::int
      `;
      const userParams = [query, String(userCap), '0'];

      // total counts (without LIMIT/OFFSET)
      const pageCountSql = `
        WITH url_hits AS (
          SELECT id
          FROM "Page"
          WHERE $1::text IS NOT NULL
            AND "currentUrl" &@~ pgroonga_query_escape($1)
        )
        SELECT COUNT(*) AS total
        FROM "PageVersion" pv
        JOIN "Page" p ON pv."pageId" = p.id
        LEFT JOIN url_hits uh ON uh.id = pv."pageId"
        WHERE pv."validTo" IS NULL
          AND (
            pv.title &@~ pgroonga_query_escape($1)
            OR (pv."alternateTitle" IS NOT NULL AND pv."alternateTitle" &@~ pgroonga_query_escape($1))
            OR uh.id IS NOT NULL
          )
          AND ($2::text[] IS NULL OR pv.tags @> $2::text[])
          AND ($3::text[] IS NULL OR NOT (pv.tags && $3::text[]))
          AND ($4::int IS NULL OR pv.rating >= $4)
          AND ($5::int IS NULL OR pv.rating <= $5)
      `;
      const userCountSql = `
        SELECT COUNT(*) AS total
        FROM "User" u
        WHERE u."displayName" &@~ pgroonga_query_escape($1)
      `;

      const [pageRes, userRes, pageCountRes, userCountRes] = await Promise.all([
        pool.query(pageSql, pageParams),
        pool.query(userSql, userParams),
        pool.query(pageCountSql, [query, pageParams[1], pageParams[2], pageParams[3], pageParams[4]]),
        pool.query(userCountSql, [query])
      ]);

      const pages = (pageRes.rows || []).map((r, index) => ({
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
        firstRevisionAt: r.firstRevisionAt || null,
        textScore: typeof r.score === 'number' ? r.score : null,
        popularityScore: typeof r.rating === 'number' ? r.rating : 0,
        orderIndex: index
      }));
      const users = (userRes.rows || []).map((r, index) => ({
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
          sorted = hybrid.sort((a, b) =>
            a.type === b.type
              ? (a.orderIndex ?? 0) - (b.orderIndex ?? 0)
              : a.type === 'page'
                ? -1
                : 1
          );
          break;
      }

      const sliced = totalOffset > 0 ? sorted.slice(totalOffset, totalOffset + (totalLimit || 20)) : sorted.slice(0, (totalLimit || 20));

      const sanitizedResults = sliced.map((item) => {
        const { orderIndex, ...rest } = item as any;
        return rest;
      });

      const totalPages = Number(pageCountRes.rows?.[0]?.total || 0);
      const totalUsers = Number(userCountRes.rows?.[0]?.total || 0);
      res.json({
        results: sanitizedResults,
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
      
      const { rows } = await pool.query(sql, [searchQuery, limit]);
      
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
