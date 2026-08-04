/**
 * 页面图片提取与 URL 归一化。
 *
 * 渲染 HTML 是主信源：只扫描 `#page-content` 内真正的 `<img>`，与 search_text 共用同一次
 * 整页 GET。Wikidot 源码是补充信源：处理 `[[image]]` 的相对附件名、local--files，以及
 * 站内常用的 `component:image-block name=...`。这里不下载、不探测 URL，也不创建资产；
 * 下载后的字节 sha256 才是 serve.image_asset 的主键。
 */

import { decodeEntities, extractPageContentHtml } from './extractText.js';

export const IMAGE_EXTRACTION_VERSION = 2;

export type ImageCandidateSource =
  | 'html_img'
  | 'wikidot_image'
  | 'wikidot_image_block'
  | 'wikidot_url';

export interface ExtractedImageCandidate {
  /** 源文档中的原始值，用于审计。 */
  originUrl: string;
  /** worker 实际抓取的绝对 HTTPS URL；保留 query（部分图床依赖它）。 */
  displayUrl: string;
  /** URL 引用去重键；去 query/fragment、统一大小写与 wdfiles 等价主机。 */
  normalizedUrl: string;
  /** 同一 normalizedUrl 可能同时由 HTML 与源码命中。 */
  sources: ImageCandidateSource[];
}

export interface ExtractPageImagesOptions {
  html: string;
  source?: string | null;
  pageUrl: string;
  slug: string;
}

interface NormalizeOptions {
  pageUrl: string;
  slug: string;
  source: ImageCandidateSource;
  /** `[[image foo.png]]` 的 foo.png 是当前页附件；HTML 相对 URL 则按浏览器规则解析。 */
  wikiBareAttachment?: boolean;
}

interface NormalizedImageUrl {
  displayUrl: string;
  normalizedUrl: string;
}

const RAW_TEXT_TAGS = new Set(['script', 'style', 'template', 'textarea']);
const LOCAL_PATH_RE = /^\/?local--(?:files|resized-images)\//i;
const ABSOLUTE_HOST_RE = /^(?:[a-z0-9-]+\.)+[a-z]{2,63}(?::\d+)?\//i;
const UNSAFE_SCHEME_RE = /^(?:data|blob|javascript|file|ftp):/i;
const WIKIDOT_IMAGE_RE = /\[\[\s*=?image\b([\s\S]*?)\]\]/gi;
const IMAGE_BLOCK_RE =
  /\[\[\s*include\s+(?::[a-z0-9-]+:)?component:image-block[^\]]*?\bname\s*=\s*([\s\S]*?)\]\]/gi;
const SOURCE_URL_RE =
  /(?:https?:\/\/|\/\/)[^\s"'<>]+|(?:^|[\s([])(?:\/?local--(?:files|resized-images)\/[^\s"'<>\])]+)/gim;
const IMAGE_PATH_EXTENSION_RE =
  /\.(?:avif|apng|bmp|gif|heic|heif|ico|jpe?g|jfif|pjpeg|png|svgz?|tiff?|webp)$/i;

/**
 * 一次合并 HTML + source，按 normalizedUrl 去重。HTML 候选优先成为 displayUrl，
 * 因为它是 Wikidot 实际渲染后的可抓取地址；源码仍留在 sources 里。
 */
export function extractPageImages(options: ExtractPageImagesOptions): ExtractedImageCandidate[] {
  const candidates = [
    ...extractImagesFromHtml(options.html, options.pageUrl, options.slug),
    ...extractImagesFromWikidotSource(
      options.source ?? '',
      options.pageUrl,
      options.slug,
    ),
  ];
  const deduped = new Map<string, ExtractedImageCandidate>();
  for (const candidate of candidates) {
    const current = deduped.get(candidate.normalizedUrl);
    if (current === undefined) {
      deduped.set(candidate.normalizedUrl, candidate);
      continue;
    }
    const sources = [...new Set([...current.sources, ...candidate.sources])].sort();
    const preferred = compareCandidate(candidate, current) < 0 ? candidate : current;
    deduped.set(candidate.normalizedUrl, { ...preferred, sources });
  }
  return [...deduped.values()].sort((a, b) =>
    a.normalizedUrl.localeCompare(b.normalizedUrl),
  );
}

/**
 * 只扫描严格的正文容器。`data-src` 仅在 src 缺失或是内嵌占位图时回退，
 * 不把同一张 lazy-load 图片记两遍。
 */
export function extractImagesFromHtml(
  html: string,
  pageUrl: string,
  slug: string,
): ExtractedImageCandidate[] {
  const fragment = extractPageContentHtml(html);
  if (fragment === null) return [];

  const out: ExtractedImageCandidate[] = [];
  for (const tag of scanImageTags(fragment)) {
    const src = readHtmlAttr(tag, 'src');
    const lazy = readHtmlAttr(tag, 'data-src') ?? readHtmlAttr(tag, 'data-original');
    const raw = src === null || UNSAFE_SCHEME_RE.test(src.trim()) ? lazy : src;
    if (raw === null) continue;
    const normalized = normalizeImageUrl(raw, {
      pageUrl,
      slug,
      source: 'html_img',
    });
    if (normalized === null || isWikidotUiImage(normalized.displayUrl)) continue;
    out.push({
      originUrl: raw.trim(),
      ...normalized,
      sources: ['html_img'],
    });
  }
  return dedupeCandidates(out);
}

/**
 * 源码补充信源。先删掉注释/代码/CSS/HTML 转义区，避免文档示例里的 `[[image]]`
 * 进入真实下载队列。
 */
export function extractImagesFromWikidotSource(
  source: string,
  pageUrl: string,
  slug: string,
): ExtractedImageCandidate[] {
  if (source === '') return [];
  const searchable = stripNonRenderedWikitext(source);
  const out: ExtractedImageCandidate[] = [];

  WIKIDOT_IMAGE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = WIKIDOT_IMAGE_RE.exec(searchable)) !== null) {
    const raw = directiveTarget(match[1] ?? '');
    if (raw === null) continue;
    const normalized = normalizeImageUrl(raw, {
      pageUrl,
      slug,
      source: 'wikidot_image',
      wikiBareAttachment: true,
    });
    if (normalized === null) continue;
    out.push({
      originUrl: raw,
      ...normalized,
      sources: ['wikidot_image'],
    });
  }

  IMAGE_BLOCK_RE.lastIndex = 0;
  while ((match = IMAGE_BLOCK_RE.exec(searchable)) !== null) {
    const raw = includeAttributeValue(match[1] ?? '');
    if (raw === null) continue;
    const normalized = normalizeImageUrl(raw, {
      pageUrl,
      slug,
      source: 'wikidot_image_block',
      wikiBareAttachment: true,
    });
    if (normalized === null) continue;
    out.push({
      originUrl: raw,
      ...normalized,
      sources: ['wikidot_image_block'],
    });
  }

  // v1 还会捕获源码里明确写出的图片裸 URL（例如自定义 include 参数、图片来源）。
  // 保留这个覆盖面，但不复刻它“local--files 下 PDF/MP4 也算图片”和吞入 |caption 的误判。
  SOURCE_URL_RE.lastIndex = 0;
  while ((match = SOURCE_URL_RE.exec(searchable)) !== null) {
    const raw = sourceUrlToken(match[0] ?? '');
    if (raw === null) continue;
    const normalized = normalizeImageUrl(raw, {
      pageUrl,
      slug,
      source: 'wikidot_url',
    });
    if (normalized === null || !isLikelySourceImage(normalized.displayUrl)) continue;
    out.push({
      originUrl: raw,
      ...normalized,
      sources: ['wikidot_url'],
    });
  }

  return dedupeCandidates(out);
}

/**
 * URL 归一化规则：
 *   - HTTP / protocol-relative / 裸域名统一成 HTTPS；
 *   - local--files 与当前页相对附件名解析成绝对 URL；
 *   - `*.wikidot.com/local--files|local--resized-images` 统一成 `*.wdfiles.com`；
 *   - normalizedUrl 去 query/fragment 并转小写（兼容 v1 去重键）；
 *   - displayUrl 保留 query 和路径大小写，供 worker 正确下载。
 */
export function normalizeImageUrl(
  rawInput: string,
  options: NormalizeOptions,
): NormalizedImageUrl | null {
  let raw = decodeEntities(rawInput).trim();
  raw = unwrapQuotes(raw);
  if (
    raw === '' ||
    /[\u0000-\u001f\u007f]/.test(raw) ||
    /["']/.test(raw) ||
    UNSAFE_SCHEME_RE.test(raw) ||
    /\{\$[^}]+\}/.test(raw) ||
    /%7b\$[^%]+%7d/i.test(raw) ||
    /^:[a-z0-9_-]+$/i.test(raw) ||
    (options.wikiBareAttachment && /^[#*+={[\]<>]/.test(raw))
  ) {
    return null;
  }

  let absolute: URL;
  try {
    if (raw.startsWith('//')) {
      absolute = new URL(`https:${raw}`);
    } else if (/^https?:\/\//i.test(raw)) {
      absolute = new URL(raw);
    } else if (ABSOLUTE_HOST_RE.test(raw)) {
      absolute = new URL(`https://${raw}`);
    } else if (LOCAL_PATH_RE.test(raw)) {
      absolute = new URL(`/${raw.replace(/^\/+/, '')}`, siteRoot(options.pageUrl));
    } else if (options.wikiBareAttachment) {
      if (raw.includes('/')) {
        const localPath = raw
          .split('/')
          .map((segment) => encodeURIComponent(segment).replace(/%3A/gi, ':'))
          .join('/');
        absolute = new URL(`/local--files/${localPath}`, siteRoot(options.pageUrl));
      } else {
        const file = encodeURIComponent(raw).replace(/%3A/gi, ':');
        const encodedSlug = encodeURI(options.slug).replace(/#/g, '%23').replace(/\?/g, '%3F');
        absolute = new URL(`/local--files/${encodedSlug}/${file}`, siteRoot(options.pageUrl));
      }
    } else {
      absolute = new URL(raw, options.pageUrl);
    }
  } catch {
    return null;
  }

  if (absolute.protocol !== 'http:' && absolute.protocol !== 'https:') return null;
  absolute.protocol = 'https:';
  absolute.username = '';
  absolute.password = '';
  if (absolute.port === '80' || absolute.port === '443') absolute.port = '';
  absolute.pathname = canonicalImagePath(absolute.pathname);
  absolute.hostname = canonicalImageHost(absolute.hostname, absolute.pathname);
  absolute.hash = '';

  const displayUrl = absolute.toString();
  const key = new URL(displayUrl);
  key.search = '';
  key.hash = '';
  const normalizedUrl = key.toString().toLowerCase();
  if (normalizedUrl.length > 8_192 || displayUrl.length > 16_384) return null;
  return { displayUrl, normalizedUrl };
}

export function imageCandidateToJson(candidate: ExtractedImageCandidate): {
  normalized_url: string;
  origin_url: string;
  display_url: string;
  metadata: Record<string, unknown>;
} {
  return {
    normalized_url: candidate.normalizedUrl,
    origin_url: candidate.originUrl,
    display_url: candidate.displayUrl,
    metadata: {
      extraction_version: IMAGE_EXTRACTION_VERSION,
      sources: candidate.sources,
    },
  };
}

function siteRoot(pageUrl: string): string {
  const url = new URL(pageUrl);
  url.pathname = '/';
  url.search = '';
  url.hash = '';
  return url.toString();
}

function canonicalImageHost(hostname: string, pathname: string): string {
  const lower = hostname.toLowerCase().replace(/\.$/, '');
  if (
    lower.endsWith('.wikidot.com') &&
    /^\/local--(?:files|resized-images)\//i.test(pathname)
  ) {
    return `${lower.slice(0, -'.wikidot.com'.length)}.wdfiles.com`;
  }
  return lower;
}

function canonicalImagePath(pathname: string): string {
  let path = pathname.replace(/\/{2,}/g, '/');
  if (/^\/local--(?:files|resized-images)\//i.test(path)) {
    // Wikidot/wdfiles 对页面分类分隔符与层级斜杠同时存在编码/未编码两种输出。
    path = path.replace(/%3a/gi, ':').replace(/%2f/gi, '/');
  }
  return path;
}

function compareCandidate(a: ExtractedImageCandidate, b: ExtractedImageCandidate): number {
  const aHtml = Number(a.sources.includes('html_img'));
  const bHtml = Number(b.sources.includes('html_img'));
  if (aHtml !== bHtml) return bHtml - aHtml;
  if (a.displayUrl.length !== b.displayUrl.length) return a.displayUrl.length - b.displayUrl.length;
  return a.displayUrl.localeCompare(b.displayUrl);
}

function dedupeCandidates(candidates: ExtractedImageCandidate[]): ExtractedImageCandidate[] {
  const map = new Map<string, ExtractedImageCandidate>();
  for (const candidate of candidates) {
    const current = map.get(candidate.normalizedUrl);
    if (current === undefined || compareCandidate(candidate, current) < 0) {
      map.set(candidate.normalizedUrl, candidate);
    }
  }
  return [...map.values()];
}

function directiveTarget(body: string): string | null {
  let text = body.trim();
  if (text === '') return null;
  if (text[0] === '"' || text[0] === "'") {
    const quote = text[0];
    const end = text.indexOf(quote, 1);
    return end < 0 ? null : text.slice(1, end).trim() || null;
  }
  const attr = /\s+[^\s=]+\s*=/.exec(text);
  if (attr !== null) text = text.slice(0, attr.index);
  const pipe = text.indexOf('|');
  if (pipe >= 0) text = text.slice(0, pipe);
  text = text.trim().replace(/\s+\.{3}$/, '').trim();
  return text === '' ? null : text;
}

function includeAttributeValue(body: string): string | null {
  const text = body.trim();
  if (text === '') return null;
  if (text[0] === '"' || text[0] === "'") {
    const quote = text[0];
    const end = text.indexOf(quote, 1);
    return end < 0 ? null : text.slice(1, end).trim() || null;
  }
  const end = text.search(/[|\s]/);
  return (end < 0 ? text : text.slice(0, end)).trim() || null;
}

function sourceUrlToken(token: string): string | null {
  let text = token.trim().replace(/^[([]+/, '');
  const delimiter = text.search(/\||\]\]|\[\[|[，。；！？、]/u);
  if (delimiter >= 0) text = text.slice(0, delimiter);
  text = text.replace(/[),.;!?，。；！？、]+$/u, '').trim();
  return text === '' ? null : text;
}

function isLikelySourceImage(displayUrl: string): boolean {
  const url = new URL(displayUrl);
  const path = url.pathname;
  if (/^\/local--(?:files|resized-images)\//i.test(path)) {
    const final = path.split('/').pop() ?? '';
    // 无扩展名附件在 Wikidot 很常见；有明确非图片扩展名则拒绝。
    return !/\.[a-z0-9]{2,8}$/i.test(final) || IMAGE_PATH_EXTENSION_RE.test(final);
  }
  return IMAGE_PATH_EXTENSION_RE.test(path);
}

function isWikidotUiImage(displayUrl: string): boolean {
  const url = new URL(displayUrl);
  return (
    /^(?:www\.)?wikidot\.com$/i.test(url.hostname) &&
    /^\/avatar\.php$/i.test(url.pathname)
  );
}

function unwrapQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1).trim();
    }
  }
  return value;
}

function stripNonRenderedWikitext(source: string): string {
  return source
    .replace(/\[!--[\s\S]*?--\]/g, '')
    .replace(
      /\[\[(?:module\s+css|css|code|html)\b[^\]]*\]\][\s\S]*?\[\[\/(?:module|css|code|html)\s*\]\]/gi,
      '',
    )
    .replace(/\{\{\{[\s\S]*?\}\}\}/g, '')
    .replace(/@@[\s\S]*?@@/g, '');
}

function scanImageTags(fragment: string): string[] {
  const tags: string[] = [];
  let i = 0;
  while (i < fragment.length) {
    const lt = fragment.indexOf('<', i);
    if (lt < 0) break;
    if (fragment.startsWith('<!--', lt)) {
      const end = fragment.indexOf('-->', lt + 4);
      i = end < 0 ? fragment.length : end + 3;
      continue;
    }
    const end = findTagEnd(fragment, lt);
    if (end < 0) {
      i = lt + 1;
      continue;
    }
    const raw = fragment.slice(lt, end + 1);
    const close = /^<\s*\//.test(raw);
    const name = readTagName(raw);
    if (!close && name === 'img') tags.push(raw);
    if (!close && RAW_TEXT_TAGS.has(name) && !/\/\s*>$/.test(raw)) {
      const closeAt = fragment.toLowerCase().indexOf(`</${name}`, end + 1);
      i = closeAt < 0 ? fragment.length : closeAt;
      continue;
    }
    i = end + 1;
  }
  return tags;
}

function findTagEnd(text: string, start: number): number {
  let quote = '';
  for (let i = start + 1; i < text.length; i++) {
    const char = text[i]!;
    if (quote !== '') {
      if (char === quote) quote = '';
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '>') {
      return i;
    } else if (char === '<') {
      return -1;
    }
  }
  return -1;
}

function readTagName(raw: string): string {
  const match = /^<\s*\/?\s*([a-z0-9:-]+)/i.exec(raw);
  return match?.[1]?.toLowerCase() ?? '';
}

function readHtmlAttr(raw: string, name: string): string | null {
  const re = new RegExp(
    `(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>` + '`' + `]+))`,
    'i',
  );
  const match = re.exec(raw);
  if (match === null) return null;
  return decodeEntities(match[1] ?? match[2] ?? match[3] ?? '');
}
