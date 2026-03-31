import { Router } from 'express';
import { getReadPoolSync } from '../utils/dbPool.js';
import { createCache } from '../utils/cache.js';

export function internalRouter() {
  const router = Router();
  const readPool = getReadPoolSync();
  const cache = createCache(null, 'internal:', { isolatedMemory: true, maxMemorySize: 200 });
  const MARKET_CATEGORIES = ['OVERALL', 'TRANSLATION', 'SCP', 'TALE', 'GOI', 'WANDERERS'] as const;
  type MarketCategory = typeof MARKET_CATEGORIES[number];
  type MarketTickRow = {
    category: string;
    asOfTs: Date;
    watermarkTs: Date | null;
    voteCutoffDate: string;
    voteRuleVersion: string;
    indexMark: string;
    crowdDrag: string | null;
    createdAt: Date;
  };
  const MARKET_TICK_CACHE_TTL_S = 8;

  type WikidotUserRow = {
    wikidotId: number | null;
    displayName: string | null;
    username: string | null;
  };
  type AuthorPageRow = {
    wikidotId: number | null;
    pageId: number | null;
  };

  const normalizeUsernameCandidates = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return [];
    const normalizedSpaceToUnderscore = trimmed.replace(/\s+/g, '_');
    const normalizedUnderscoreToSpace = trimmed.replace(/_+/g, ' ');
    return Array.from(
      new Set([trimmed, normalizedSpaceToUnderscore, normalizedUnderscoreToSpace].map(v => v.trim()).filter(Boolean))
    );
  };

  const parseQueryString = (value: unknown): string => {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return typeof value[0] === 'string' ? value[0] : '';
    return '';
  };

  const normalizeMarketCategory = (value: unknown): MarketCategory | null => {
    const normalized = parseQueryString(value).trim().toUpperCase();
    if (!normalized) return null;
    if ((MARKET_CATEGORIES as readonly string[]).includes(normalized)) {
      return normalized as MarketCategory;
    }
    return null;
  };

  const floorHourIso = (input: Date) => {
    const date = new Date(input);
    date.setUTCMinutes(0, 0, 0);
    return date.toISOString();
  };

  async function findUserByWikidotId(wikidotId: number): Promise<WikidotUserRow | null> {
    const { rows } = await readPool.query<WikidotUserRow>(
      `SELECT "wikidotId", "displayName", username
         FROM "User"
        WHERE "wikidotId" = $1
        LIMIT 1`,
      [wikidotId]
    );
    return rows[0] ?? null;
  }

  async function findUsersByCandidates(rawCandidates: string[]): Promise<WikidotUserRow[]> {
    const candidates = Array.from(new Set(rawCandidates.map(c => c.trim()).filter(Boolean)));
    if (candidates.length === 0) return [];

    const lowered = candidates.map(c => c.toLowerCase());
    const { rows } = await readPool.query<WikidotUserRow>(
      `SELECT "wikidotId", "displayName", username
         FROM "User"
        WHERE "wikidotId" IS NOT NULL
          AND "wikidotId" > 0
          AND (
            lower(trim(username)) = ANY($1::text[])
            OR lower(trim("displayName")) = ANY($1::text[])
            OR lower(regexp_replace(trim("displayName"), E'\\\\s+', '_', 'g')) = ANY($1::text[])
          )
        LIMIT 2`,
      [lowered]
    );
    return rows;
  }

  // GET /internal/wikidot-user?username=...
  router.get('/wikidot-user', async (req, res, next) => {
    try {
      const wikidotIdRaw = parseQueryString((req.query as Record<string, unknown>).wikidotId);
      if (wikidotIdRaw.trim()) {
        const wikidotId = Number.parseInt(wikidotIdRaw.trim(), 10);
        if (!Number.isFinite(wikidotId) || wikidotId <= 0) {
          return res.status(400).json({ error: 'wikidotId_invalid' });
        }

        const row = await findUserByWikidotId(wikidotId);
        if (!row) return res.status(404).json({ error: 'not_found' });

        return res.json({
          ok: true,
          user: {
            wikidotId,
            displayName: row.displayName ?? null,
            username: row.username ?? null
          }
        });
      }

      const username = parseQueryString((req.query as Record<string, unknown>).username).trim();
      if (!username) return res.status(400).json({ error: 'username_required' });

      const rows = await findUsersByCandidates([
        ...normalizeUsernameCandidates(username)
      ]);

      if (rows.length === 0) {
        return res.status(404).json({ error: 'not_found' });
      }

      if (rows.length > 1) {
        return res.status(409).json({ error: 'ambiguous' });
      }

      const row = rows[0]!;
      const wikidotId = Number(row.wikidotId);
      return res.json({
        ok: true,
        user: {
          wikidotId,
          displayName: row.displayName ?? null,
          username: row.username ?? null
        }
      });
    } catch (err) {
      next(err);
    }
  });

  // GET /internal/wikidot-user-search?query=...&limit=...
  router.get('/wikidot-user-search', async (req, res, next) => {
    try {
      const query = parseQueryString((req.query as Record<string, unknown>).query).trim();
      if (!query) return res.status(400).json({ error: 'query_required' });

      const limitRaw = parseQueryString((req.query as Record<string, unknown>).limit).trim();
      const limitParsed = limitRaw ? Number.parseInt(limitRaw, 10) : 8;
      const limit = Number.isFinite(limitParsed) ? Math.min(Math.max(limitParsed, 1), 20) : 8;

      const numeric = Number.parseInt(query, 10);
      if (/^\d+$/.test(query) && Number.isFinite(numeric) && numeric > 0) {
        const row = await findUserByWikidotId(numeric);
        if (!row) return res.json({ ok: true, users: [] });
        return res.json({
          ok: true,
          users: [
            {
              wikidotId: numeric,
              displayName: row.displayName ?? null,
              username: row.username ?? null
            }
          ]
        });
      }

      if (query.length < 2) {
        return res.json({ ok: true, users: [] });
      }

      const exactCandidates = normalizeUsernameCandidates(query).map(c => c.toLowerCase());
      const patterns = exactCandidates.map(c => `${c}%`);

      const { rows } = await readPool.query<WikidotUserRow>(
        `SELECT "wikidotId", "displayName", username
           FROM "User"
          WHERE "wikidotId" IS NOT NULL
            AND "wikidotId" > 0
            AND (
              lower(trim(username)) LIKE ANY($1::text[])
              OR lower(trim("displayName")) LIKE ANY($1::text[])
              OR lower(regexp_replace(trim("displayName"), E'\\\\s+', '_', 'g')) LIKE ANY($1::text[])
            )
          ORDER BY
            CASE
              WHEN lower(trim(username)) = ANY($2::text[]) THEN 0
              WHEN lower(trim("displayName")) = ANY($2::text[]) THEN 1
              WHEN lower(regexp_replace(trim("displayName"), E'\\\\s+', '_', 'g')) = ANY($2::text[]) THEN 2
              ELSE 3
            END,
            "wikidotId"
          LIMIT $3`,
        [patterns, exactCandidates, limit]
      );

      return res.json({
        ok: true,
        users: rows.map((row) => ({
          wikidotId: Number(row.wikidotId),
          displayName: row.displayName ?? null,
          username: row.username ?? null
        })).filter((user) => Number.isFinite(user.wikidotId) && user.wikidotId > 0)
      });
    } catch (err) {
      next(err);
    }
  });

  // GET /internal/gacha-author-pages?query=...&limit=...&userLimit=...
  // Resolve author keyword to candidate page ids for gacha author search.
  router.get('/gacha-author-pages', async (req, res, next) => {
    try {
      const query = parseQueryString((req.query as Record<string, unknown>).query).trim();
      if (!query) return res.status(400).json({ error: 'query_required' });

      const limitRaw = parseQueryString((req.query as Record<string, unknown>).limit).trim();
      const parsedLimit = limitRaw ? Number.parseInt(limitRaw, 10) : 1600;
      const limit = Number.isFinite(parsedLimit) ? Math.min(Math.max(parsedLimit, 1), 4000) : 1600;

      const userLimitRaw = parseQueryString((req.query as Record<string, unknown>).userLimit).trim();
      const parsedUserLimit = userLimitRaw ? Number.parseInt(userLimitRaw, 10) : 120;
      const userLimit = Number.isFinite(parsedUserLimit) ? Math.min(Math.max(parsedUserLimit, 1), 600) : 120;

      const normalizedCandidates = normalizeUsernameCandidates(query).map((item) => item.toLowerCase());
      const tokens = Array.from(new Set(
        normalizedCandidates.flatMap((item) => [
          item,
          item.replace(/_+/g, ' '),
          item.replace(/\s+/g, '_')
        ])
      )).filter(Boolean);
      const likePatterns = tokens.map((item) => `%${item}%`);
      if (likePatterns.length === 0) return res.json({ ok: true, items: [] });

      const { rows } = await readPool.query<AuthorPageRow>(
        `WITH matched_users AS (
           SELECT DISTINCT u.id
           FROM "User" u
           WHERE u."wikidotId" IS NOT NULL
             AND u."wikidotId" > 0
             AND (
               lower(trim(COALESCE(u."displayName", ''))) LIKE ANY($1::text[])
               OR lower(trim(COALESCE(u.username, ''))) LIKE ANY($1::text[])
               OR lower(regexp_replace(trim(COALESCE(u."displayName", '')), E'\\\\s+', '_', 'g')) LIKE ANY($1::text[])
               OR lower(replace(trim(COALESCE(u.username, '')), '_', ' ')) LIKE ANY($1::text[])
             )
           LIMIT $2
         ),
         matched_pages AS (
           SELECT DISTINCT
             COALESCE(pv."wikidotId", p."wikidotId") AS "wikidotId",
             pv."pageId" AS "pageId"
           FROM "Attribution" a
           JOIN matched_users mu ON mu.id = a."userId"
           JOIN "PageVersion" pv ON pv.id = a."pageVerId"
           LEFT JOIN "Page" p ON p.id = pv."pageId"
           WHERE COALESCE(pv."wikidotId", p."wikidotId") IS NOT NULL
         )
         SELECT "wikidotId", "pageId"
         FROM matched_pages
         ORDER BY "wikidotId" DESC NULLS LAST, "pageId" DESC NULLS LAST
         LIMIT $3`,
        [likePatterns, userLimit, limit]
      );

      return res.json({
        ok: true,
        items: rows.map((row) => ({
          wikidotId: row.wikidotId == null ? null : Number(row.wikidotId),
          pageId: row.pageId == null ? null : Number(row.pageId)
        })).filter((row) => (
          (Number.isFinite(row.wikidotId) && Number(row.wikidotId) > 0)
          || (Number.isFinite(row.pageId) && Number(row.pageId) > 0)
        ))
      });
    } catch (err) {
      next(err);
    }
  });

  // GET /internal/gacha-market/ticks?category=OVERALL&limit=96&asOfTs=...
  router.get('/gacha-market/ticks', async (req, res, next) => {
    try {
      const category = normalizeMarketCategory((req.query as Record<string, unknown>).category);
      if (!category) {
        return res.status(400).json({ error: 'category_invalid' });
      }
      const limitRaw = parseQueryString((req.query as Record<string, unknown>).limit).trim();
      const parsedLimit = limitRaw ? Number.parseInt(limitRaw, 10) : 96;
      const limit = Number.isFinite(parsedLimit) ? Math.min(Math.max(parsedLimit, 1), 1200) : 96;
      const asOfRaw = parseQueryString((req.query as Record<string, unknown>).asOfTs).trim();
      const asOfDate = asOfRaw ? new Date(asOfRaw) : null;
      const asOfTs = asOfDate && !Number.isNaN(asOfDate.getTime()) ? asOfDate : new Date();

      const cacheKey = `ticks:${category}:${limit}:${floorHourIso(asOfTs)}`;
      const cached = await cache.getJSON(cacheKey);
      if (cached) {
        return res.json(cached);
      }

      const { rows } = await readPool.query<MarketTickRow>(
        `SELECT
           category,
           ("as_of_ts" AT TIME ZONE 'UTC') AS "asOfTs",
           (CASE WHEN "watermark_ts" IS NULL THEN NULL ELSE ("watermark_ts" AT TIME ZONE 'UTC') END) AS "watermarkTs",
           to_char("vote_cutoff_date", 'YYYY-MM-DD') AS "voteCutoffDate",
           "vote_rule_version" AS "voteRuleVersion",
           "index_mark"::text AS "indexMark",
           "crowd_drag"::text AS "crowdDrag",
           ("created_at" AT TIME ZONE 'UTC') AS "createdAt"
         FROM "CategoryIndexTick"
         WHERE category = $1
           AND ("as_of_ts" AT TIME ZONE 'UTC') <= $2::timestamptz
         ORDER BY "as_of_ts" DESC
         LIMIT $3`,
        [category, asOfTs.toISOString(), limit]
      );

      rows.reverse();
      const payload = {
        ok: true,
        category,
        items: rows.map((row) => ({
          category: row.category,
          asOfTs: row.asOfTs.toISOString(),
          watermarkTs: row.watermarkTs ? row.watermarkTs.toISOString() : null,
          voteCutoffDate: row.voteCutoffDate,
          voteRuleVersion: row.voteRuleVersion,
          indexMark: Number(row.indexMark || 0),
          crowdDrag: Number(row.crowdDrag || 0),
          createdAt: row.createdAt.toISOString()
        }))
      };
      await cache.setJSON(cacheKey, payload, MARKET_TICK_CACHE_TTL_S);
      return res.json(payload);
    } catch (err) {
      next(err);
    }
  });

  // GET /internal/gacha-market/price-at?category=OVERALL&ts=...
  router.get('/gacha-market/price-at', async (req, res, next) => {
    try {
      const category = normalizeMarketCategory((req.query as Record<string, unknown>).category);
      if (!category) {
        return res.status(400).json({ error: 'category_invalid' });
      }
      const tsRaw = parseQueryString((req.query as Record<string, unknown>).ts).trim();
      if (!tsRaw) {
        return res.status(400).json({ error: 'ts_required' });
      }
      const ts = new Date(tsRaw);
      if (Number.isNaN(ts.getTime())) {
        return res.status(400).json({ error: 'ts_invalid' });
      }

      const cacheKey = `price:${category}:${floorHourIso(ts)}`;
      const cached = await cache.getJSON(cacheKey);
      if (cached) {
        return res.json(cached);
      }

      const { rows } = await readPool.query<MarketTickRow>(
        `SELECT
           category,
           ("as_of_ts" AT TIME ZONE 'UTC') AS "asOfTs",
           (CASE WHEN "watermark_ts" IS NULL THEN NULL ELSE ("watermark_ts" AT TIME ZONE 'UTC') END) AS "watermarkTs",
           to_char("vote_cutoff_date", 'YYYY-MM-DD') AS "voteCutoffDate",
           "vote_rule_version" AS "voteRuleVersion",
           "index_mark"::text AS "indexMark",
           "crowd_drag"::text AS "crowdDrag",
           ("created_at" AT TIME ZONE 'UTC') AS "createdAt"
         FROM "CategoryIndexTick"
         WHERE category = $1
           AND ("as_of_ts" AT TIME ZONE 'UTC') <= $2::timestamptz
         ORDER BY "as_of_ts" DESC
         LIMIT 1`,
        [category, ts.toISOString()]
      );
      const row = rows[0];
      if (!row) {
        return res.status(404).json({ error: 'not_found' });
      }
      const payload = {
        ok: true,
        tick: {
          category: row.category,
          asOfTs: row.asOfTs.toISOString(),
          watermarkTs: row.watermarkTs ? row.watermarkTs.toISOString() : null,
          voteCutoffDate: row.voteCutoffDate,
          voteRuleVersion: row.voteRuleVersion,
          indexMark: Number(row.indexMark || 0),
          crowdDrag: Number(row.crowdDrag || 0),
          createdAt: row.createdAt.toISOString()
        }
      };
      await cache.setJSON(cacheKey, payload, MARKET_TICK_CACHE_TTL_S);
      return res.json(payload);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
