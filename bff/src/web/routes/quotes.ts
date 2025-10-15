import { Router } from 'express';
import type { Pool } from 'pg';
import type { RedisClientType } from 'redis';

export function quotesRouter(pool: Pool, _redis: RedisClientType | null) {
  const router = Router();

  // GET /api/quotes/random
  router.get('/random', async (req, res, next) => {
    try {
      const { minLength = '50', maxLength = '500', minRating = '10' } = req.query as Record<string, string>;
      
      // First get a random page with good rating and content
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
        LIMIT 1
      `;
      
      const { rows: pageRows } = await pool.query(pageSql, [maxLength, minRating]);
      
      if (pageRows.length === 0) {
        return res.status(404).json({ error: 'No suitable pages found for quotes' });
      }
      
      const page = pageRows[0];
      const content = page.textContent || '';
      
      // Extract sentences from the content
      // Split by common sentence endings (considering Chinese and English)
      const sentences = (content.match(/[^。！？.!?]+[。！？.!?]+/g) || [])
        .map((s: string) => s.trim())
        .filter((s: string) => {
          const len = s.length;
          return len >= Number(minLength) && len <= Number(maxLength);
        });
      
      if (sentences.length === 0) {
        // If no suitable sentences, try to get a paragraph
        const paragraphs = content
          .split(/\n\n+/g)
          .map((p: string) => p.trim())
          .filter((p: string) => {
            const len = p.length;
            return len >= Number(minLength) && len <= Number(maxLength);
          });
        
        if (paragraphs.length === 0) {
          // Last resort: get a substring
          const start = Math.floor(Math.random() * Math.max(0, content.length - Number(maxLength)));
          const quote = content.substring(start, start + Number(maxLength)).trim();
          
          return res.json({
            quote: quote || 'No suitable quote found',
            source: {
              wikidotId: page.wikidotId,
              title: page.title,
              alternateTitle: page.alternateTitle,
              url: page.url,
              rating: page.rating
            }
          });
        }
        
        const randomParagraph = paragraphs[Math.floor(Math.random() * paragraphs.length)];
        return res.json({
          quote: randomParagraph,
          source: {
            wikidotId: page.wikidotId,
            title: page.title,
            alternateTitle: page.alternateTitle,
            url: page.url,
            rating: page.rating
          }
        });
      }
      
      // Select a random sentence
      const randomSentence = sentences[Math.floor(Math.random() * sentences.length)];
      
      return res.json({
        quote: randomSentence,
        source: {
          wikidotId: page.wikidotId,
          title: page.title,
          alternateTitle: page.alternateTitle,
          url: page.url,
          rating: page.rating
        }
      });
      
    } catch (err) {
      next(err);
    }
  });

  // GET /api/quotes/from-page/:wikidotId
  router.get('/from-page/:wikidotId', async (req, res, next) => {
    try {
      const { wikidotId } = req.params;
      const { minLength = '50', maxLength = '500', count = '1' } = req.query as Record<string, string>;
      
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
      
      const { rows } = await pool.query(sql, [wikidotId]);
      
      if (rows.length === 0) {
        return res.status(404).json({ error: 'Page not found or has no content' });
      }
      
      const page = rows[0];
      const content = page.textContent || '';
      
      // Extract sentences
      const sentences = (content.match(/[^。！？.!?]+[。！？.!?]+/g) || [])
        .map((s: string) => s.trim())
        .filter((s: string) => {
          const len = s.length;
          return len >= Number(minLength) && len <= Number(maxLength);
        });
      
      if (sentences.length === 0) {
        return res.json({
          quotes: [],
          source: {
            wikidotId: page.wikidotId,
            title: page.title,
            alternateTitle: page.alternateTitle,
            url: page.url,
            rating: page.rating
          },
          message: 'No suitable quotes found in this page'
        });
      }
      
      // Shuffle and take requested count
      const shuffled = [...sentences].sort(() => Math.random() - 0.5);
      const selectedQuotes = shuffled.slice(0, Number(count));
      
      return res.json({
        quotes: selectedQuotes,
        source: {
          wikidotId: page.wikidotId,
          title: page.title,
          alternateTitle: page.alternateTitle,
          url: page.url,
          rating: page.rating
        }
      });
      
    } catch (err) {
      next(err);
    }
  });

  return router;
}
