/**
 * 全页面 HTML 预处理器
 * 在 syncer 存储时运行一次，BFF 直接返回处理后的 HTML
 */

const WIKIDOT_PROXY_DOMAINS = [
  'wikidot.com',
  'wdfiles.com',
  'scpwikicn.com',
  'd3g0gp89917ko0.cloudfront.net',
  'cdnjs.cloudflare.com',
];

function shouldProxy(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return WIKIDOT_PROXY_DOMAINS.some(d => host === d || host.endsWith('.' + d));
  } catch { return false; }
}

// 镜像站的 origin — css-proxy URL 必须用绝对路径，因为 <base> 会干扰相对路径
const MIRROR_ORIGIN = process.env.MIRROR_ORIGIN || '';

function toCssProxyUrl(url: string): string {
  return `${MIRROR_ORIGIN}/api/css-proxy?url=${encodeURIComponent(url)}`;
}

// AJAX 拦截 + 锚点修复脚本
const MIRROR_INIT_SCRIPT = `<script>
(function(){
  var BLOCKED = ['/ajax-module-connector.php', '/quickmodule.php', '/default--flow/',
                 '/karma.php', '/userkarma.php'];
  function isBlocked(url) {
    var s = String(url || '');
    for (var i = 0; i < BLOCKED.length; i++) {
      if (s.indexOf(BLOCKED[i]) !== -1) return true;
    }
    return false;
  }
  var origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url) {
    if (isBlocked(url)) {
      this._blocked = true;
      return origOpen.call(this, method, 'data:application/json,{}');
    }
    return origOpen.apply(this, arguments);
  };
  try {
    Object.defineProperty(window, '__preventNav', {value: true});
    window.addEventListener('beforeunload', function(e) { e.preventDefault(); });
  } catch(e) {}
  if (window.fetch) {
    var origFetch = window.fetch;
    window.fetch = function(input) {
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      if (isBlocked(url)) {
        return Promise.resolve(new Response('{}', {status: 200, headers: {'Content-Type':'application/json'}}));
      }
      return origFetch.apply(this, arguments);
    };
  }
  document.addEventListener('click', function(e) {
    var a = e.target;
    while (a && a.tagName !== 'A') a = a.parentElement;
    if (!a) return;
    var href = a.getAttribute('href') || '';
    if (!href || href.indexOf('javascript:') === 0) return;
    if (href.charAt(0) === '#') {
      e.preventDefault();
      window.location.hash = href;
      return;
    }
    if (!a.getAttribute('target')) {
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer');
    }
  }, true);
})();
</script>`;

const MIRROR_CSS = `<style>
#edit-page-textarea, #edit-page-form,
#login-status, #search-top-box,
.page-options-bottom, #page-options-bottom,
.page-rate-widget-box,
#edit-page-comments,
.odialog-shader { display: none !important; }
.creditRate iframe[src*="backmodule"] { display: none !important; }
.fader-mirror {
  width: 100%; height: 100%; position: fixed;
  top: 0; left: 0; cursor: pointer; z-index: 999;
}
.credit-back-mirror {
  display: block; text-align: center; margin: 8px 0;
  font-size: 0.8em; cursor: pointer; color: #b01;
}
.credit-back-mirror:hover { text-decoration: underline; }
</style>`;

export function preprocessFullPageHtml(
  html: string,
  wikidotIds: Map<string, number>
): string {
  // ── 0. 清理 ──
  // 广告/分析脚本
  html = html.replace(/<script[^>]*(?:onesignal|nitropay|doubleclick|google-analytics|googletagmanager|_gat|_gaq)[^>]*>[\s\S]*?<\/script>/gi, '');
  html = html.replace(/<script[^>]*src="[^"]*(?:onesignal|nitropay|doubleclick|google-analytics|dc\.js)[^"]*"[^>]*><\/script>/gi, '');
  // 未渲染的 Wikidot 模板变量
  html = html.replace(/[&?](?:css|override|[a-z_]+)=\{\$[^}]+\}/gi, '');
  // 协议相对 URL → HTTPS
  html = html.replace(/src="\/\//g, 'src="https://');
  html = html.replace(/href="\/\//g, 'href="https://');

  // ── 1. 注入 init 脚本 + base + CSS ──
  html = html.replace(
    /<head([^>]*)>/i,
    `<head$1>${MIRROR_INIT_SCRIPT}<base href="https://scp-wiki-cn.wikidot.com/">${MIRROR_CSS}`
  );

  // ── 2. Credit module backmodule iframe → 本地元素 ──
  html = html.replace(
    /<iframe[^>]*src="[^"]*backmodule\/1"[^>]*><\/iframe>/gi,
    '<div class="fader-mirror" onclick="history.back()"></div>'
  );
  html = html.replace(
    /<iframe[^>]*src="[^"]*backmodule\/3"[^>]*><\/iframe>/gi,
    '<div class="fader-mirror" onclick="history.back()"></div>'
  );
  html = html.replace(
    /<iframe[^>]*src="[^"]*backmodule\/4"[^>]*><\/iframe>/gi,
    '<a class="credit-back-mirror" href="#" onclick="history.back();return false;">X</a>'
  );
  html = html.replace(
    /<iframe[^>]*src="[^"]*backmodule\/2"[^>]*><\/iframe>/gi,
    '<a class="credit-back-mirror" href="#" onclick="history.back();return false;">返回</a>'
  );

  // ── 3. 资源 URL → css-proxy（CSS、图片、字体等全部走代理缓存）──
  // <link href="https://...">
  html = html.replace(
    /(<link[^>]*href=")([^"]+)(")/gi,
    (_, pre, url, post) => {
      if (url.startsWith('http') && shouldProxy(url)) {
        return pre + toCssProxyUrl(url) + post;
      }
      return pre + url + post;
    }
  );
  // <img src="https://..."> 和其他 src
  html = html.replace(
    /(<(?:img|source|video|audio)[^>]*src=")([^"]+)(")/gi,
    (_, pre, url, post) => {
      if (url.startsWith('http') && shouldProxy(url)) {
        return pre + toCssProxyUrl(url) + post;
      }
      return pre + url + post;
    }
  );
  // <style> 中的 @import url(...)
  html = html.replace(
    /(@import\s+url\(\s*['"]?)([^'")]+)(['"]?\s*\))/gi,
    (_, pre, url, post) => {
      if (url.startsWith('http') && shouldProxy(url)) {
        return pre + toCssProxyUrl(url) + post;
      }
      return pre + url + post;
    }
  );

  // ── 4. 站内链接 → 镜像路由 ──
  // href="/scp-cn-xxx" → href="/page/{wikidotId}/preview"
  html = html.replace(
    /href="\/([^"#?]+)"/gi,
    (original, path) => {
      // 跳过资源路径
      if (path.startsWith('api/') || path.startsWith('local--') ||
          path.startsWith('common--') || path.startsWith('onesignal/')) {
        return original;
      }
      const wikidotId = wikidotIds.get(path);
      if (wikidotId) {
        return `href="${MIRROR_ORIGIN}/page/${wikidotId}/preview"`;
      }
      // 未知页面保持原样（会通过 base 解析到 Wikidot）
      return original;
    }
  );

  // ── 5. 清理首部空白 ──
  html = html.replace(/^\s+/, '');

  return html;
}
