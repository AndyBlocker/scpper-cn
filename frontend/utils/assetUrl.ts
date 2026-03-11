export function normalizeBffBase(rawBase?: string | null): string {
  const base = typeof rawBase === 'string' ? rawBase.trim() : '/api';
  if (!base || base === '/') return '';
  return base.replace(/\/+$/u, '');
}

const HTTP_PREFIX = /^http:\/\//i;
const HTTPS_PREFIX = /^https?:\/\//i;
const PROTOCOL_RELATIVE_PREFIX = /^\/\//i;
const LOCAL_FILES_PREFIX = /^local--files\//i;
const DOMAIN_WITH_PATH_REGEX = /^(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,63}(?::\d+)?\/.+/;

function appendVariant(url: string, variant?: string | null): string {
  if (!variant) return url;
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}variant=${variant}`;
}

export function resolveAssetUrl(
  raw: string | null | undefined,
  base: string,
  options?: { variant?: 'low' | null }
): string {
  const candidate = String(raw ?? '').trim();
  if (!candidate) return '';

  if (/^https?:/i.test(candidate)) {
    if (options?.variant && candidate.includes('/page-images/')) {
      return appendVariant(candidate, options.variant);
    }
    return candidate;
  }
  if (candidate.startsWith('//')) return candidate;

  const suffix = candidate.startsWith('/') ? candidate : `/${candidate}`;
  const url = `${base}${suffix}`;
  if (options?.variant) return appendVariant(url, options.variant);
  return url;
}

export function resolveWithFallback(
  primary: string | null | undefined,
  fallback: string | null | undefined,
  base: string,
  options?: { variant?: 'low' | null }
): string {
  const first = resolveAssetUrl(primary, base, options);
  if (first) return first;
  return resolveAssetUrl(fallback, base, options);
}

export function resolveExternalAssetUrl(raw: string | null | undefined): string {
  const candidate = String(raw ?? '').trim();
  if (!candidate) return '';

  if (HTTP_PREFIX.test(candidate)) return candidate.replace(HTTP_PREFIX, 'https://');
  if (HTTPS_PREFIX.test(candidate)) return candidate;
  if (PROTOCOL_RELATIVE_PREFIX.test(candidate)) return `https:${candidate}`;
  if (LOCAL_FILES_PREFIX.test(candidate)) return `https://scp-wiki-cn.wdfiles.com/${candidate}`;
  if (DOMAIN_WITH_PATH_REGEX.test(candidate)) return `https://${candidate}`;
  return '';
}

export function pickExternalAssetUrl(...candidates: Array<string | null | undefined>): string {
  for (const candidate of candidates) {
    const resolved = resolveExternalAssetUrl(candidate);
    if (resolved) return resolved;
  }
  return '';
}
