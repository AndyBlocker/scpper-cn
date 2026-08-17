import { load } from 'cheerio';

/** 只对已知 Wikimedia File 描述页启用 HTML 二跳；普通 HTML 绝不猜 URL。 */
export function isWikimediaFileDescriptionUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase();
    const decodedPath = safeDecodeURIComponent(url.pathname);
    return (host === 'commons.wikimedia.org' || host.endsWith('.wikipedia.org'))
      && /^\/wiki\/file:/i.test(decodedPath);
  } catch {
    return false;
  }
}

/**
 * Wikimedia 描述页的 og:image 是其公开图片 CDN URL。只接受 upload.wikimedia.org，
 * 从而不把任意站外 HTML 的 meta 标签变成开放重定向/SSRF 跳板。
 */
export function resolveWikimediaOgImageUrl(pageUrl: string, html: string): string | null {
  if (!isWikimediaFileDescriptionUrl(pageUrl)) return null;
  const content = load(html)('meta[property="og:image"], meta[name="og:image"]')
    .first()
    .attr('content')
    ?.trim();
  if (!content) return null;
  try {
    const resolved = new URL(content, pageUrl);
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return null;
    if (resolved.hostname.toLowerCase() !== 'upload.wikimedia.org') return null;
    if (resolved.username !== '' || resolved.password !== '') return null;
    resolved.protocol = 'https:';
    resolved.port = '';
    resolved.hash = '';
    return resolved.toString();
  } catch {
    return null;
  }
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
