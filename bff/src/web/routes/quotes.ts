import { Router } from 'express';
import type { Pool } from 'pg';
import type { RedisClientType } from 'redis';
import { createCache } from '../utils/cache.js';
import { getReadPoolSync } from '../utils/dbPool.js';

export function quotesRouter(pool: Pool, redis: RedisClientType | null) {
  const router = Router();
  const cache = createCache(redis);

  // 读写分离：quotes 全部是读操作，使用从库
  const readPool = getReadPoolSync();
  const SENTENCE_REGEX = /[^。！？.!?]+[。！？.!?]+/g;

  const normalizeBlock = (input: string): string => input.replace(/\s+/g, ' ').trim();

  const collectSentences = (content: string, minLen: number, maxLen: number): string[] =>
    (content.match(SENTENCE_REGEX) || [])
      .map(normalizeBlock)
      .filter((segment) => {
        const len = segment.length;
        return len >= minLen && len <= maxLen;
      });

  const collectParagraphs = (content: string, minLen: number, maxLen: number): string[] =>
    content
      .split(/\n\n+/g)
      .map(normalizeBlock)
      .filter((segment) => {
        const len = segment.length;
        return len >= minLen && len <= maxLen;
      });

  const fallbackSlice = (content: string, maxLen: number): string | null => {
    const normalized = normalizeBlock(content);
    if (!normalized) return null;
    if (normalized.length <= maxLen) return normalized;
    const start = Math.floor(Math.random() * Math.max(1, normalized.length - maxLen));
    const slice = normalized.slice(start, start + maxLen).trim();
    return slice || null;
  };

  const randomItem = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];

  const shuffleInPlace = <T>(arr: T[]): void => {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
  };

  const deriveQuote = (content: string, minLen: number, maxLen: number): string | null => {
    const sentences = collectSentences(content, minLen, maxLen);
    if (sentences.length > 0) {
      return randomItem(sentences);
    }
    const paragraphs = collectParagraphs(content, minLen, maxLen);
    if (paragraphs.length > 0) {
      return randomItem(paragraphs);
    }
    return fallbackSlice(content, maxLen);
  };

  const collectQuotes = (content: string, minLen: number, maxLen: number, count: number): string[] => {
    const sentences = collectSentences(content, minLen, maxLen);
    const paragraphs = collectParagraphs(content, minLen, maxLen);
    const base = sentences.length > 0 ? sentences : paragraphs;
    if (base.length === 0) {
      const fallback = fallbackSlice(content, maxLen);
      return fallback ? [fallback] : [];
    }
    const unique = Array.from(new Set(base));
    shuffleInPlace(unique);
    const desired = Math.max(1, count);
    const picked = unique.slice(0, desired);
    if (picked.length < desired) {
      const fallback = fallbackSlice(content, maxLen);
      if (fallback && !picked.includes(fallback)) {
        picked.push(fallback);
      }
    }
    return picked.slice(0, desired);
  };

  const buildSource = (page: any) => ({
    wikidotId: page.wikidotId,
    title: page.title,
    alternateTitle: page.alternateTitle,
    url: page.url,
    rating: page.rating
  });

  // GET /api/quotes/random
  router.get('/random', async (req, res, next) => {
    try {
      const { minLength = '50', maxLength = '500', minRating = '10' } = req.query as Record<string, string>;
      const minLen = Math.max(1, Number(minLength) || 1);
      const maxLen = Math.max(minLen, Number(maxLength) || minLen);
      const minRatingInt = Math.max(0, Number(minRating) || 0);
      const cacheKey = `quotes:random:${minLen}:${maxLen}:${minRatingInt}`;

      const candidates = await cache.remember(cacheKey, 300, async () => {
        const candidateLimit = 8;
        const pageSql = `
          SELECT 
            pv."wikidotId",
            pv.title,
            pv."alternateTitle",
            pv."textContent",
            pv.rating,
            p."currentUrl" AS url
          FROM "PageVersion" pv
          JOIN "Page" p ON pv."pageId" = p.id
          WHERE pv."validTo" IS NULL
            AND pv."textContent" IS NOT NULL
            AND LENGTH(pv."textContent") > $1::int
            AND pv.rating >= $2::int
            AND NOT pv."isDeleted"
          ORDER BY random()
          LIMIT $3::int
        `;

        const { rows } = await readPool.query(pageSql, [maxLen, minRatingInt, candidateLimit]);
        if (rows.length === 0) return null;

        const results: Array<{ quote: string; source: ReturnType<typeof buildSource> }> = [];
        for (const page of rows) {
          const quote = deriveQuote(page.textContent || '', minLen, maxLen);
          if (quote) {
            results.push({
              quote,
              source: buildSource(page)
            });
          }
        }
        return results.length > 0 ? results : null;
      });

      if (!Array.isArray(candidates) || candidates.length === 0) {
        return res.status(404).json({ error: 'No suitable pages found for quotes' });
      }

      const pick = randomItem(candidates);
      res.json(pick);
    } catch (err) {
      next(err);
    }
  });

  // GET /api/quotes/from-page/:wikidotId
  router.get('/from-page/:wikidotId', async (req, res, next) => {
    try {
      const { wikidotId } = req.params;
      const { minLength = '50', maxLength = '500', count = '1' } = req.query as Record<string, string>;
      const minLen = Math.max(1, Number(minLength) || 1);
      const maxLen = Math.max(minLen, Number(maxLength) || minLen);
      const countInt = Math.max(1, Math.min(Number(count) || 1, 20));
      const cacheKey = `quotes:page:${wikidotId}:${minLen}:${maxLen}:${countInt}`;

      const payload = await cache.remember(cacheKey, 600, async () => {
        const sql = `
          SELECT 
            pv."wikidotId",
            pv.title,
            pv."alternateTitle",
            pv."textContent",
            pv.rating,
            p."currentUrl" AS url
          FROM "PageVersion" pv
          JOIN "Page" p ON pv."pageId" = p.id
          WHERE pv."wikidotId" = $1::int
            AND pv."validTo" IS NULL
            AND pv."textContent" IS NOT NULL
          LIMIT 1
        `;
        const { rows } = await readPool.query(sql, [wikidotId]);
        if (rows.length === 0) return null;
        const page = rows[0];
        const quotes = collectQuotes(page.textContent || '', minLen, maxLen, countInt);
        const response: Record<string, unknown> = {
          quotes,
          source: buildSource(page)
        };
        if (!quotes.length) {
          response.message = 'No suitable quotes found in this page';
        }
        return response;
      });

      if (!payload) {
        return res.status(404).json({ error: 'Page not found or has no content' });
      }

      res.json(payload);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
