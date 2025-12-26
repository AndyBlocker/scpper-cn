export function normalizeBffBase(rawBase?: string | null): string {
  const base = typeof rawBase === 'string' ? rawBase.trim() : '/api';
  if (!base || base === '/') return '';
  return base.replace(/\/+$/u, '');
}

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
