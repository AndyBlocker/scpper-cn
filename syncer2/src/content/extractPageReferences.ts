/**
 * Wikidot 源码中的页面引用。
 *
 * 这里只做纯字符串解析，不访问网络，也不查询数据库。目标 page_id 的裁决留给
 * projector：slug 是可复用的名称，只有 serve.page_current 才知道哪个身份当前 live。
 */

export type PageReferenceKind = 'TRIPLE' | 'SHORT' | 'DIRECT';
export type PageReferenceScope = 'internal' | 'external';

export interface PageReferenceCandidate {
  kind: PageReferenceKind;
  targetScope: PageReferenceScope;
  /** 内链是 slug，外链是去掉 fragment 后的规范 URL。 */
  targetKey: string;
  /** 内链是以 / 开头的规范路径，外链是去掉 fragment 后的规范 URL。 */
  targetPath: string;
  targetSlug: string | null;
  /** 空串表示没有 fragment；数据库主键因此不需要 NULL 哨兵表达式。 */
  targetFragment: string;
  displayTexts: string[];
  rawTarget: string;
  rawText: string;
  occurrence: number;
}

interface NormalizedTarget {
  scope: PageReferenceScope;
  key: string;
  path: string;
  slug: string | null;
  fragment: string;
  rawTarget: string;
}

interface CandidateAccumulator extends PageReferenceCandidate {
  displays: Set<string>;
}

interface Span {
  start: number;
  end: number;
}

const SITE_HOST = 'scp-wiki-cn.wikidot.com';
const HTTP_PREFIX_REGEX = /^https?:\/\//i;
const PROTOCOL_RELATIVE_REGEX = /^\/\//;
const INVALID_PREFIXES = /^(?:javascript:|mailto:)/i;
const URI_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const LOCAL_FILES_SEGMENT = /^local--files$/i;
const MAX_DISPLAY_VARIANTS = 10;

function slugifySegment(input: string, allowColon: boolean): string {
  const normalized = input
    .normalize('NFKC')
    .replace(/["'“”‘’`\[\]]+/g, ' ')
    .replace(/[^a-zA-Z0-9:\-]+/g, ' ')
    .trim()
    .toLowerCase();

  if (!normalized) return '';

  let slug = normalized
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  if (!allowColon) slug = slug.replace(/:/g, '-');
  else slug = slug.replace(/:-/g, ':');
  return slug;
}

function isSiteHost(hostname: string): boolean {
  return hostname.toLowerCase().replace(/^www\./, '') === SITE_HOST;
}

function normalizeInternalPath(rawPath: string): { path: string; slug: string } | null {
  const rawSegments = rawPath.replace(/^\/+|\/+$/g, '').split('/');
  const normalizedSegments: string[] = [];
  for (let i = 0; i < rawSegments.length; i += 1) {
    const segment = rawSegments[i]?.trim() ?? '';
    if (!segment) continue;
    if (LOCAL_FILES_SEGMENT.test(segment)) return null;
    const normalized = slugifySegment(segment, i === 0);
    if (normalized) normalizedSegments.push(normalized);
  }
  if (normalizedSegments.length === 0) return null;
  const slug = normalizedSegments.join('/');
  return { path: `/${slug}`, slug };
}

/**
 * v1 的内链归一化口径，加上 v2 明确要求的一等站外目标。
 * javascript:/mailto:/local--files/ 不是页面引用，返回 null。
 */
export function normalizePageReferenceTarget(rawTarget: string): NormalizedTarget | null {
  if (!rawTarget) return null;
  let working = rawTarget.trim();
  if (!working || INVALID_PREFIXES.test(working)) return null;

  if (PROTOCOL_RELATIVE_REGEX.test(working)) working = `https:${working}`;

  if (HTTP_PREFIX_REGEX.test(working)) {
    let url: URL;
    try {
      url = new URL(working);
    } catch {
      return null;
    }
    const fragment = url.hash.slice(1).trim();
    url.hash = '';
    if (!isSiteHost(url.hostname)) {
      const path = url.toString();
      return {
        scope: 'external',
        key: path,
        path,
        slug: null,
        fragment,
        rawTarget: rawTarget.trim(),
      };
    }
    // 本站 URL 的 query 不是页面身份的一部分。
    url.search = '';
    const normalized = normalizeInternalPath(url.pathname);
    if (!normalized) return null;
    return {
      scope: 'internal',
      key: normalized.slug,
      path: normalized.path,
      slug: normalized.slug,
      fragment,
      rawTarget: rawTarget.trim(),
    };
  }

  // ftp:/data: 等 URI 不能被误 slugify 成本站页面；当前只保留 http(s) 站外引用。
  if (URI_SCHEME.test(working)) return null;
  if (working.startsWith('*')) working = working.slice(1).trim();

  let fragment = '';
  const hashIndex = working.indexOf('#');
  if (hashIndex >= 0) {
    fragment = working.slice(hashIndex + 1).trim();
    working = working.slice(0, hashIndex);
  }
  // 与页面身份无关的 query 不参与 slug 裁决。
  const queryIndex = working.indexOf('?');
  if (queryIndex >= 0) working = working.slice(0, queryIndex);
  working = working.trim();
  if (!working) return null;

  const normalized = working.startsWith('/')
    ? normalizeInternalPath(working)
    : (() => {
        if (working.split('/').some((segment) => LOCAL_FILES_SEGMENT.test(segment))) return null;
        const slug = slugifySegment(working, true);
        return slug ? { path: `/${slug}`, slug } : null;
      })();
  if (!normalized) return null;
  return {
    scope: 'internal',
    key: normalized.slug,
    path: normalized.path,
    slug: normalized.slug,
    fragment,
    rawTarget: rawTarget.trim(),
  };
}

function overlaps(spans: readonly Span[], start: number, end: number): boolean {
  return spans.some((span) => start < span.end && end > span.start);
}

function addDisplayValue(set: Set<string>, value: string | undefined): void {
  const trimmed = value?.trim();
  if (!trimmed || set.has(trimmed) || set.size >= MAX_DISPLAY_VARIANTS) return;
  set.add(trimmed);
}

/** TRIPLE / SHORT / DIRECT 三类在各自口径内聚合，保留出现次数与最多十个显示变体。 */
export function extractPageReferences(source: string | null | undefined): PageReferenceCandidate[] {
  if (!source) return [];
  const map = new Map<string, CandidateAccumulator>();
  const structuredSpans: Span[] = [];

  const add = (
    kind: PageReferenceKind,
    normalized: NormalizedTarget,
    rawText: string,
    display?: string,
  ): void => {
    const key = [kind, normalized.scope, normalized.key, normalized.fragment].join('|');
    let entry = map.get(key);
    if (!entry) {
      entry = {
        kind,
        targetScope: normalized.scope,
        targetKey: normalized.key,
        targetPath: normalized.path,
        targetSlug: normalized.slug,
        targetFragment: normalized.fragment,
        displayTexts: [],
        rawTarget: normalized.rawTarget,
        rawText,
        occurrence: 0,
        displays: new Set<string>(),
      };
      map.set(key, entry);
    }
    entry.occurrence += 1;
    addDisplayValue(entry.displays, display);
  };

  const triplePattern = /\[\[\[([\s\S]*?)\]\]\]/g;
  let match: RegExpExecArray | null;
  while ((match = triplePattern.exec(source)) !== null) {
    const rawText = match[0];
    structuredSpans.push({ start: match.index, end: match.index + rawText.length });
    const inner = match[1] ?? '';
    const pipeIndex = inner.indexOf('|');
    const target = pipeIndex >= 0 ? inner.slice(0, pipeIndex) : inner;
    const display = pipeIndex >= 0 ? inner.slice(pipeIndex + 1) : undefined;
    const normalized = normalizePageReferenceTarget(target);
    if (normalized) add('TRIPLE', normalized, rawText, display);
  }

  // 两侧都必须是单方括号。v1 只有右向 (?!\[)，会从 [[div ...]] 的第二个 [
  // 开始匹配，把 div/include/module 等 Wikidot 指令误报成缺页 SHORT。
  const shortPattern = /(?<!\[)\[(?!\[)([^\]\s]+)\s+([^\]]+?)\](?!\])/g;
  while ((match = shortPattern.exec(source)) !== null) {
    const rawText = match[0];
    const start = match.index;
    const end = start + rawText.length;
    if (overlaps(structuredSpans, start, end)) continue;
    structuredSpans.push({ start, end });
    const normalized = normalizePageReferenceTarget(match[1] ?? '');
    if (normalized) add('SHORT', normalized, rawText, match[2]);
  }

  const directPattern = /https?:\/\/[^\s"'<>\[\]]+/gi;
  while ((match = directPattern.exec(source)) !== null) {
    const rawText = match[0];
    const start = match.index;
    if (overlaps(structuredSpans, start, start + rawText.length)) continue;
    const normalized = normalizePageReferenceTarget(rawText);
    if (normalized) add('DIRECT', normalized, rawText);
  }

  return [...map.values()].map(({ displays, ...entry }) => ({
    ...entry,
    displayTexts: [...displays],
  }));
}
