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
 * 预览出口注入的修正样式。
 *
 * Wikidot 的页面 <head> 里带着一条 `data-wikidot-theme` 的 interwiki 样式表
 * (interwiki.scpwikicn.com/css/style.css)，那是给侧栏 interwiki 小 iframe 用的，
 * 其中的 `body { overflow: hidden }` 是整份文档里唯一的 body overflow 声明。
 * 由于 html 的 overflow 是默认的 visible，body 的 overflow 会按 CSS 规范传播到
 * viewport，于是整个预览文档被锁死：滚轮与触摸都滑不动（脚本改 scrollTop 仍有效）。
 *
 * 第二组是 .fader-mirror —— syncer 把 credit module 的 backmodule iframe 换成了这个
 * 点击捕获层，样式是 `position:fixed` 铺满视口。它平时不碍事，靠的是 wikidot 主题 CSS
 * 把祖先容器隐藏着；主题 CSS 一旦加载失败（上游 wdfiles 不可达时常发生），
 * 它就变成一块盖住整个视口的透明浮层，点哪里都触发 history.back()。
 * 实测同一页面：主题 CSS 正常时 0x0 不拦截，主题 CSS 失败时 1216x639 且吃掉所有点击。
 *
 * 两条规则各管一件事：
 *   display:none + [id^="u-credit"]:target  —— 只在模态框真的被打开时才让它存在。
 *     必须用 [id^="u-credit"] 而不是单个 id：credit module 有 #u-credit-view 与
 *     #u-credit-otherwise 两个模态框（后者见于 314 份缓存页面），只写前者会让后者的
 *     "点背景关闭"在主题 CSS 正常的页面上失效 —— 那是比原 bug 更常见的回归。
 *   position:absolute + inset:0            —— 打开时它填满自己的定位包含块
 *     （模态容器），而不是像原来的 position:fixed 那样无条件铺满视口。
 *
 * 为什么不能干脆不依赖 :target、只靠几何约束：主题 CSS 里给背景定尺寸的规则是
 *   [id*=u-credit] .fader, [id*=u-credit] .fader iframe { width:100vw; height:100% }
 * —— 它只认 iframe，而我们已经把 iframe 换成了 div，所以主题根本不会给这个 div
 * 任何尺寸；全屏背景一直是 MIRROR_CSS 自己提供的。试过改成"让 .fader 决定"，
 * 结果是背景在主题正常的页面上直接消失（实测点开模态后不再可点关闭）。
 *
 * 已知残留：主题 CSS 失败且用户主动点开模态时，包含块退化为初始包含块，
 * 捕获层仍会覆盖首屏 —— 但点一下就会 history.back() popping 掉 hash 而自愈，
 * 不再是加载即锁死。另外查过缓存里的主题 CSS，没有用 class 开合 credit 模态的
 * 写法（unfolded 的命中全是 collapsible-block），所以没有为此加投机性的选择器。
 *
 * 放在 BFF 出口而不是只改 syncer，是因为 PageContentCache 中已存的三万多份 HTML
 * 都已经定型，服务端注入可以立刻对存量缓存生效，无需重跑同步。
 */
const PREVIEW_OVERRIDE_STYLE = `<style id="scpper-preview-overrides">
html:root { overflow: auto !important; }
:root > body { overflow: visible !important; }
.fader-mirror { display: none !important; position: absolute !important; inset: 0 !important; }
[id^="u-credit"]:target .fader-mirror { display: block !important; }
iframe[src*="backmodule"] { display: none !important; }
</style>`;

/**
 * 插入解锁样式。
 *
 * 锚点用 <head> 开标签而不是 </head>，因为后者有两个坑：</head> 可能出现在 head 里的
 * script 字符串字面量中，而"插到文档最前面"的兜底会把 style 放到 <!DOCTYPE> 之前，
 * 直接把文档打进 quirks mode。
 *
 * 位置靠前意味着源码顺序上吃亏，所以选择器用 html:root / :root > body 抬高特异性：
 * !important 只在重要性层面取胜，同重要性下仍要比特异性、再比源码顺序。抬高之后，
 * 页面里哪怕出现 `html { overflow: hidden !important }` 这种同为 important 的规则也压不过。
 * （真正触发本 bug 的 interwiki 规则本身并不带 !important，这里只是加一层保险。）
 */
function withPreviewOverrides(html: string): string {
  const headOpen = html.match(/<head\b[^>]*>/i);
  if (headOpen?.index !== undefined) {
    const at = headOpen.index + headOpen[0].length;
    return html.slice(0, at) + PREVIEW_OVERRIDE_STYLE + html.slice(at);
  }
  const bodyOpen = html.search(/<body\b/i);
  if (bodyOpen !== -1) {
    return html.slice(0, bodyOpen) + PREVIEW_OVERRIDE_STYLE + html.slice(bodyOpen);
  }
  // 既没有 head 也没有 body 的异常文档：追加到末尾（放在最前面会触发 quirks mode）
  return html + PREVIEW_OVERRIDE_STYLE;
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

/**
 * 取出 <head> 区域 —— <body> 里是用户投稿的正文，不能当作可信输入。
 *
 * 找边界之前先把 script 与注释的内容抹掉：head 里的内联脚本可能在字符串字面量里
 * 出现 '</head>' 或 '<body'，直接搜会把区域提前截断（syncer 注入的 MIRROR_INIT_SCRIPT
 * 就在 head 里）。抹除时保留标签本身，边界判断只看真正的标记。
 */
function headRegion(html: string): string {
  const masked = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, (m) => ' '.repeat(m.length))
    .replace(/<!--[\s\S]*?-->/g, (m) => ' '.repeat(m.length));
  const end = masked.search(/<\/head\s*>|<body\b/i);
  return end === -1 ? masked.slice(0, 8192) : masked.slice(0, end);
}

function detectProxyPath(html: string): string | null {
  // 配了环境变量就以它为准，不去猜
  const origin = process.env.MIRROR_ORIGIN || '';
  if (origin) return origin.replace(/\/+$/, '') + PROXY_PATH_SUFFIX;

  // 回退：从 <head> 里已有的 <link href> / <script src> 认出前缀。
  // 必须同时限制在 head 内、且限制在属性值里 —— 早先的实现扫描整份文档，
  // 而 SCP 页面正文是用户投稿的：只要在正文里写一句
  // https://evil.example/api/css-proxy?x 且排在合法链接前面，
  // 这一页所有内联 CSS 资源都会被劫持到攻击者的域，泄露访问者 IP/UA。
  const head = headRegion(html);
  for (const m of head.matchAll(/\b(?:href|src)="(https?:\/\/[^"]+?\/api\/css-proxy)\?/gi)) {
    return m[1];
  }

  // 认不出前缀就整段跳过改写。这种情况下预览里的图片会退回直连源站，
  // 静默失效很难察觉，所以至少提醒一次。
  if (!warnedMissingProxyPath) {
    warnedMissingProxyPath = true;
    console.warn(
      '[page-preview] 无法确定 css-proxy 的绝对前缀，内联 CSS 的资源改写已跳过。' +
      '请给 BFF 配置 MIRROR_ORIGIN。',
    );
  }
  return null;
}

function detectBaseHref(html: string): string {
  // 同样只认 <head> 里的 <base>，正文里写的不算
  const found = headRegion(html).match(/<base\b[^>]*\bhref="([^"]+)"/i);
  const value = found?.[1] || DEFAULT_WIKI_BASE;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : DEFAULT_WIKI_BASE;
  } catch {
    return DEFAULT_WIKI_BASE;
  }
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
function rewriteStyleAttribute(value: string, base: string, proxyPath: string, quote = '"'): string {
  let unknown = false;
  const decoded = value.replace(/&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g, (all, body: string) => {
    if (body.startsWith('#')) {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      // 越界码点会让 String.fromCodePoint 抛 RangeError，
      // 异常从改写回调里逃出去会把整个预览打成 500 —— 保持原样即可
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return all;
      if (code >= 0xd800 && code <= 0xdfff) return all;
      return String.fromCodePoint(code);
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    if (named !== undefined) return named;
    unknown = true;
    return all;
  });
  if (unknown) return value;

  const rewritten = rewriteCssUrls(decoded, base, proxyPath);
  // 只需要转义定界用的那个引号
  return rewritten
    .replace(/&/g, '&amp;')
    .replace(quote === '"' ? /"/g : /'/g, quote === '"' ? '&quot;' : '&#39;');
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
    // style="" 与 style='' 两种写法都要处理
    .replace(
      /(\sstyle=)("([^"]*)"|'([^']*)')/gi,
      (all: string, prefix: string, _quoted: string, dq?: string, sq?: string) => {
        const quote = dq !== undefined ? '"' : "'";
        const value = dq !== undefined ? dq : (sq ?? '');
        if (!/url\(/i.test(value)) return all;
        return prefix + quote + rewriteStyleAttribute(value, base, proxyPath, quote) + quote;
      },
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

      // HTML 主体已在 syncer 存储时预处理完成，出口再补修正样式与内联 CSS 的资源代理
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
      return res.send(withPreviewOverrides(withProxiedInlineAssets(contentResult.rows[0].full_page_html)));
    } catch (err) {
      next(err);
    }
  });

  return router;
}
