import { Router } from 'express';
import pg from 'pg';
import { rewriteCssUrls } from '../utils/asset-proxy.js';

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

/**
 * 插入解锁样式。
 *
 * 锚点用 <head> 开标签而不是 </head>：解锁规则带 !important，在层叠里优先级高于
 * 页面自带的普通声明，与源码顺序无关，所以不需要排到最后。锚在开标签上还顺带躲开了
 * 两个坑 —— </head> 可能出现在 head 里的 script 字符串字面量中，而"插到文档最前面"
 * 的兜底会把 style 放到 <!DOCTYPE> 之前，直接把文档打进 quirks mode。
 */
function withViewportUnlock(html: string): string {
  const headOpen = html.match(/<head\b[^>]*>/i);
  if (headOpen?.index !== undefined) {
    const at = headOpen.index + headOpen[0].length;
    return html.slice(0, at) + VIEWPORT_UNLOCK_STYLE + html.slice(at);
  }
  const bodyOpen = html.search(/<body\b/i);
  if (bodyOpen !== -1) {
    return html.slice(0, bodyOpen) + VIEWPORT_UNLOCK_STYLE + html.slice(bodyOpen);
  }
  // 既没有 head 也没有 body 的异常文档：追加到末尾（放在最前面会触发 quirks mode）
  return html + VIEWPORT_UNLOCK_STYLE;
}

// ── 内联 CSS 里的图片改写 ──

const DEFAULT_WIKI_BASE = 'https://scp-wiki-cn.wikidot.com/';
const PROXY_PATH_SUFFIX = '/api/css-proxy';

/**
 * 取出该文档使用的代理前缀。
 *
 * syncer 存储时会把资源链接改写成绝对地址（`https://<镜像域>/api/css-proxy?url=...`），
 * 因为文档里注入了 <base href="wikidot">，相对路径会被解析到 wikidot 去。
 * 这里直接从文档里认出已有的前缀，跟着它走，避免 BFF 再配一份镜像域名。
 */
let warnedMissingProxyPath = false;

function detectProxyPath(html: string): string | null {
  const found = html.match(/https?:\/\/[^"'\s)]+?\/api\/css-proxy(?=\?)/i);
  if (found) return found[0];
  const origin = process.env.MIRROR_ORIGIN || '';
  if (origin) return origin.replace(/\/+$/, '') + PROXY_PATH_SUFFIX;
  // 认不出前缀就只能整段跳过改写。这种情况下预览里的图片会退回直连源站，
  // 静默失效很难察觉，所以至少提醒一次。
  if (!warnedMissingProxyPath) {
    warnedMissingProxyPath = true;
    console.warn(
      '[page-preview] 无法确定 css-proxy 的绝对前缀，内联 CSS 的资源改写已跳过。' +
      '缓存 HTML 里没有绝对形式的代理链接（syncer 存储时 MIRROR_ORIGIN 为空），' +
      '请给 BFF 配置 MIRROR_ORIGIN。',
    );
  }
  return null;
}

function detectBaseHref(html: string): string {
  const found = html.match(/<base\b[^>]*\bhref="([^"]+)"/i);
  return found?.[1] || DEFAULT_WIKI_BASE;
}

const NAMED_ENTITIES: Record<string, string> = {
  quot: '"', apos: "'", amp: '&', lt: '<', gt: '>', nbsp: '\u00a0',
};

/**
 * style="" 属性里的 CSS 会先经过 HTML 实体解码，所以改写前要解码、改写后要重新编码。
 *
 * 关键是"解码得彻底"：如果只认识一部分实体却无条件把 & 重新编码成 &amp;，
 * 没被解码的实体（比如 &#x27;）会被 rewriteCssUrls 当成 URL 的一部分吃进去，
 * 解析成 https://…/&#x27;https:/… 这种垃圾，把本来能正常显示的图片改坏。
 * 这里数字实体与常见命名实体都解码；遇到不认识的实体就整段放弃改写，宁可不动。
 */
function rewriteStyleAttribute(value: string, base: string, proxyPath: string): string {
  let unknown = false;
  const decoded = value.replace(/&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g, (all, body: string) => {
    if (body.startsWith('#')) {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : all;
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    if (named !== undefined) return named;
    unknown = true;
    return all;
  });
  if (unknown) return value;

  const rewritten = rewriteCssUrls(decoded, base, proxyPath);
  return rewritten.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

/**
 * 把内联 CSS 引用的图片/字体也送进 css-proxy。
 *
 * syncer 的预处理只改写了 <img|source|video|audio src> 和 @import，
 * `background: url(...)` 这类完全没覆盖 —— 抽样 300 页有 1712 处这样的引用直连源站，
 * 其中 87% 指向的域本来就在代理白名单里。直连的后果是国内取不到图，
 * 而且其中的 http:// 明文引用在 https 页面里会被当成混合内容拦掉。
 *
 * 放在 BFF 出口而不是 syncer：存量三万多份缓存 HTML 都已经定型，出口改写立刻生效。
 * 改写本身是幂等的（已经是代理链接的会跳过），所以将来 syncer 补上也不会冲突。
 */
function withProxiedInlineAssets(html: string): string {
  const proxyPath = detectProxyPath(html);
  if (!proxyPath) return html;
  const base = detectBaseHref(html);

  return html
    // <style> 块里是原始 CSS，实体不参与解析
    .replace(
      /(<style\b[^>]*>)([\s\S]*?)(<\/style\s*>)/gi,
      (_all, open: string, css: string, close: string) =>
        open + rewriteCssUrls(css, base, proxyPath) + close,
    )
    // style="" 属性
    .replace(
      /(\sstyle=")([^"]*)(")/gi,
      (all: string, open: string, value: string, close: string) =>
        /url\(/i.test(value) ? open + rewriteStyleAttribute(value, base, proxyPath) + close : all,
    );
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

      // HTML 主体已在 syncer 存储时预处理完成，出口再补视口解锁样式与内联 CSS 的资源代理
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
      return res.send(withViewportUnlock(withProxiedInlineAssets(contentResult.rows[0].full_page_html)));
    } catch (err) {
      next(err);
    }
  });

  return router;
}
