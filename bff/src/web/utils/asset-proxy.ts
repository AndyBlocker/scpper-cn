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

export function toProxyHref(proxyPath: string, raw: string): string {
  return `${proxyPath}?url=${encodeURIComponent(raw)}`;
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

/** 改写一段 CSS 里的 url() 与 @import */
export function rewriteCssUrls(css: string, baseUrl: string | URL, proxyPath: string): string {
  const base = baseUrl instanceof URL ? baseUrl : new URL(baseUrl);
  return css
    .replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi, (_all, quote, rawUrl) => {
      const rewritten = rewriteAssetRef(rawUrl, base, proxyPath);
      return `url(${quote}${rewritten}${quote})`;
    })
    .replace(
      /@import\s+url\(\s*(["']?)([^"')]+)\1\s*\)/gi,
      (_all, quote, rawUrl) =>
        `@import url(${quote}${rewriteAssetRef(rawUrl, base, proxyPath)}${quote})`,
    )
    .replace(
      /@import\s+(["'])([^"']+)\1/gi,
      (_all, quote, rawUrl) => `@import ${quote}${rewriteAssetRef(rawUrl, base, proxyPath)}${quote}`,
    );
}
