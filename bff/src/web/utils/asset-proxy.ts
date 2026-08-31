/**
 * 资源代理改写 —— css-proxy 路由与页面预览出口共用。
 *
 * 镜像页面里的静态资源（CSS、图片、字体）必须走 /api/css-proxy 回源，
 * 一方面利用磁盘缓存，一方面避免浏览器直连 wikidot/wdfiles（国内常不可达，
 * 且 http:// 明文引用在 https 页面里会被当成混合内容拦掉）。
 */

const ALLOWED_EXACT_HOSTS = [
  'd3g0gp89917ko0.cloudfront.net',
  'files.wikidot.com',
];

const ALLOWED_HOST_SUFFIXES = [
  'wikidot.com',
  'wdfiles.com',
  'scpwikicn.com',
];

/** 只允许代理 wikidot 生态内的域名，避免变成开放代理 */
export function isAllowedUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    const protocol = String(u.protocol || '').toLowerCase();
    if (protocol !== 'http:' && protocol !== 'https:') return false;
    if (u.username || u.password) return false;
    const host = String(u.hostname || '').toLowerCase();
    if (!host) return false;
    if (ALLOWED_EXACT_HOSTS.includes(host)) return true;
    return ALLOWED_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
  } catch {
    return false;
  }
}

/** 判断一个引用是否已经指向 css-proxy —— 改写必须幂等，否则会套娃 */
export function isAlreadyProxyRef(raw: string): boolean {
  const value = String(raw || '').trim();
  if (!value) return false;
  if (/^\/(?:api\/)?css-proxy(?:[/?#]|$)/i.test(value)) return true;
  try {
    const parsed = new URL(value, 'https://example.invalid');
    return /\/(?:api\/)?css-proxy$/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

/**
 * encodeURIComponent 不会转义 ( ) ' —— 但这三个字符必须转义：
 * 无引号的 `url(...)` 里出现 `)` 会让 CSS 解析器提前结束该 token，
 * 文件名带括号（wikidot 上很常见，例如 `image (1).png`）的图片就会整个失效。
 * 额外转义不改变服务端 decodeURIComponent 的结果。
 */
export function toProxyHref(proxyPath: string, raw: string): string {
  const encoded = encodeURIComponent(raw)
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29')
    .replace(/'/g, '%27');
  return `${proxyPath}?url=${encoded}`;
}

/**
 * 改写单个资源引用。
 * - 已经是代理链接 / data: 等伪协议 / CSS 变量 → 原样返回
 * - 白名单域 → 改写成代理链接（http:// 也会被吸收进代理，顺带解决混合内容）
 * - 其他域 → 只做绝对化，不代理
 */
export function rewriteAssetRef(rawUrl: string, base: URL, proxyPath: string): string {
  const value = String(rawUrl || '').trim();
  if (!value) return value;
  if (isAlreadyProxyRef(value)) return value;
  if (/^(?:data:|blob:|javascript:|mailto:|tel:|#)/i.test(value)) return value;
  if (/^var\(/i.test(value)) return value;

  try {
    const abs = new URL(value, base).href;
    return isAllowedUrl(abs) ? toProxyHref(proxyPath, abs) : abs;
  } catch {
    return value;
  }
}

/**
 * 改写一段 CSS 里的 url() 与 @import。
 *
 * url() 的取值按 CSS 语法分两种情况：带引号的可以包含括号（`url("image (1).png")`
 * 是合法的），不带引号的则不允许出现裸括号与空白。用一个字符类同时对付两者会在
 * 遇到第一个 `)` 时截断，导致这类引用整条匹配失败、被原样跳过。
 */
export function rewriteCssUrls(css: string, baseUrl: string | URL, proxyPath: string): string {
  const base = baseUrl instanceof URL ? baseUrl : new URL(baseUrl);
  const rewrite = (raw: string) => rewriteAssetRef(raw, base, proxyPath);

  return css
    .replace(
      /url\(\s*(?:"([^"]*)"|'([^']*)'|([^"'()\s]*))\s*\)/gi,
      (all, dq?: string, sq?: string, bare?: string) => {
        if (dq !== undefined) return `url("${rewrite(dq)}")`;
        if (sq !== undefined) return `url('${rewrite(sq)}')`;
        if (bare !== undefined && bare !== '') return `url(${rewrite(bare)})`;
        return all;
      },
    )
    .replace(
      /@import\s+(["'])([^"']+)\1/gi,
      (_all, quote: string, rawUrl: string) => `@import ${quote}${rewrite(rawUrl)}${quote}`,
    );
}
