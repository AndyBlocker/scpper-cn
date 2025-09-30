import { resolve } from 'node:path';

const DEFAULT_ROUTE_PREFIX = '/page-images';

const normalizeRoutePrefix = (raw: string | undefined): string => {
  const trimmed = (raw ?? DEFAULT_ROUTE_PREFIX).trim();
  let candidate = trimmed || DEFAULT_ROUTE_PREFIX;
  if (!candidate.startsWith('/')) {
    candidate = `/${candidate}`;
  }
  candidate = candidate.replace(/\/+$/u, '');
  if (candidate === '') {
    candidate = DEFAULT_ROUTE_PREFIX;
  }
  if (candidate === '/') {
    candidate = DEFAULT_ROUTE_PREFIX;
  }
  return candidate;
};

export const PAGE_IMAGE_ROUTE_PREFIX = normalizeRoutePrefix(process.env.PAGE_IMAGE_ROUTE_PREFIX);

const resolveRoot = (input: string | undefined): string => {
  if (input && input.trim().length > 0) {
    return resolve(input.trim());
  }
  return resolve(process.cwd(), '../.data/page-images');
};

export const PAGE_IMAGE_ROOT = resolveRoot(process.env.PAGE_IMAGE_ROOT);

export const buildPageImagePath = (assetId: number | string): string => {
  return `${PAGE_IMAGE_ROUTE_PREFIX}/${assetId}`;
};
