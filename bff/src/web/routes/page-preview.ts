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

/**
 * 预览视口解锁样式。
 *
 * Wikidot 的页面 <head> 里带着一条 `data-wikidot-theme` 的 interwiki 样式表
 * (interwiki.scpwikicn.com/css/style.css)，那是给侧栏 interwiki 小 iframe 用的，
 * 其中的 `body { overflow: hidden }` 是整份文档里唯一的 body overflow 声明。
 * 由于 html 的 overflow 是默认的 visible，body 的 overflow 会按 CSS 规范传播到
 * viewport，于是整个预览文档被锁死：滚轮与触摸都滑不动（脚本改 scrollTop 仍有效）。
 *
 * 放在 BFF 出口而不是 syncer 预处理里，是因为 PageContentCache 中已存的三万多份
 * HTML 都带着这条样式表，服务端注入可以立刻对存量缓存生效，无需重跑同步。
 */
const VIEWPORT_UNLOCK_STYLE = `<style id="scpper-preview-viewport-unlock">
html { overflow: auto !important; }
body { overflow: visible !important; }
</style>`;

/** 把解锁样式插到 </head> 之前，确保它排在页面自带样式表之后 */
function withViewportUnlock(html: string): string {
  const headEnd = html.search(/<\/head\s*>/i);
  if (headEnd === -1) {
    // 没有 </head> 的异常文档：退化为插到最前面，配合 !important 依然生效
    return VIEWPORT_UNLOCK_STYLE + html;
  }
  return html.slice(0, headEnd) + VIEWPORT_UNLOCK_STYLE + html.slice(headEnd);
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

      // HTML 主体已在 syncer 存储时预处理完成，出口只补一层视口解锁样式
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'private, max-age=300');
      res.setHeader('X-Frame-Options', 'SAMEORIGIN');
      res.setHeader('Content-Security-Policy', [
        "default-src 'self'",
        "script-src 'unsafe-inline' 'self' https://d3g0gp89917ko0.cloudfront.net",
        "style-src 'self' 'unsafe-inline'",
        "img-src * data:",
        "font-src 'self' data: https://d3g0gp89917ko0.cloudfront.net https://*.wdfiles.com",
        "media-src * data:",
        "connect-src 'self'",
        "frame-src 'none'",
        "frame-ancestors 'self'",
        "form-action 'none'"
      ].join('; '));
      return res.send(withViewportUnlock(contentResult.rows[0].full_page_html));
    } catch (err) {
      next(err);
    }
  });

  return router;
}
