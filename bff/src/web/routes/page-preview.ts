import { Router } from 'express';
import pg from 'pg';

const SYNCER_DB_URL = process.env.SYNCER_DATABASE_URL || '';

let syncerPool: pg.Pool | null = null;

function getSyncerPool(): pg.Pool | null {
  if (!SYNCER_DB_URL) return null;
  if (!syncerPool) {
    syncerPool = new pg.Pool({ connectionString: SYNCER_DB_URL, max: 3 });
  }
  return syncerPool;
}

export function pagePreviewRouter(mainPool: pg.Pool) {
  const router = Router();

  // 轻量检查：预览内容是否可用
  router.get('/:wikidotId/preview-status', async (req, res, next) => {
    try {
      const wikidotId = parseInt(req.params.wikidotId, 10);
      if (!Number.isFinite(wikidotId)) {
        return res.json({ available: false });
      }

      const pool = getSyncerPool();
      if (!pool) {
        return res.json({ available: false });
      }

      const pageResult = await mainPool.query<{ fullname: string }>(`
        SELECT SUBSTRING(p."currentUrl" FROM '//[^/]+/(.+)$') AS fullname
        FROM "Page" p
        WHERE p."wikidotId" = $1 AND p."isDeleted" = false
        LIMIT 1
      `, [wikidotId]);

      if (pageResult.rows.length === 0) {
        return res.json({ available: false });
      }

      const contentResult = await pool.query<{ cnt: string }>(`
        SELECT COUNT(*)::text AS cnt
        FROM "PageContentCache"
        WHERE fullname = $1 AND "fullPageHtml" IS NOT NULL
        LIMIT 1
      `, [pageResult.rows[0].fullname]);

      const available = Number(contentResult.rows[0]?.cnt) > 0;
      res.setHeader('Cache-Control', 'private, max-age=60');
      return res.json({ available });
    } catch (err) {
      next(err);
    }
  });

  router.get('/:wikidotId/preview', async (req, res, next) => {
    try {
      const wikidotId = parseInt(req.params.wikidotId, 10);
      if (!Number.isFinite(wikidotId)) {
        return res.status(400).send('invalid wikidotId');
      }

      const pageResult = await mainPool.query<{ fullname: string }>(`
        SELECT SUBSTRING(p."currentUrl" FROM '//[^/]+/(.+)$') AS fullname
        FROM "Page" p
        WHERE p."wikidotId" = $1 AND p."isDeleted" = false
        LIMIT 1
      `, [wikidotId]);

      if (pageResult.rows.length === 0) {
        return res.status(404).send('page not found');
      }

      const pool = getSyncerPool();
      if (!pool) {
        return res.status(503).send('syncer db not configured');
      }

      const contentResult = await pool.query<{ full_page_html: string | null }>(`
        SELECT "fullPageHtml" AS full_page_html
        FROM "PageContentCache"
        WHERE fullname = $1
        LIMIT 1
      `, [pageResult.rows[0].fullname]);

      if (contentResult.rows.length === 0 || !contentResult.rows[0].full_page_html) {
        return res.status(404).send('content not cached');
      }

      // HTML 已在 syncer 存储时预处理完成，直接返回
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'private, max-age=300');
      res.setHeader('X-Frame-Options', 'SAMEORIGIN');
      res.setHeader('Content-Security-Policy', "script-src 'none'; style-src 'self' 'unsafe-inline'; img-src * data:; frame-ancestors 'self'; default-src 'none'");
      return res.send(contentResult.rows[0].full_page_html);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
