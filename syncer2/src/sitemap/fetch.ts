/**
 * sitemap 抓取。
 *
 * 实测账（2026-07-27，scp-wiki-cn）：
 *   sitemap.xml            → 4 × sitemap_page_N + 9 × sitemap_thread_N + 1 × sitemap_category_1
 *   sitemap_page_1.xml     → 1.14 MB 原始 / **gzip 180 KB / 1.16 s / 10,000 条**
 *   4 个 page sitemap 合计 → gzip ≈ 620 KB / ≈ 5 s / **35,983 个唯一 slug**
 *   lastmod                → 精确到秒的 UTC，实测 === ListPages %%updated_at%%（5/5 逐秒相等）
 *   排序                    → 最后活动（编辑∨投票∨评论），不是 lastmod 降序；
 *                            可比较 page_1 的相对位置做活动信号，但严禁 lastmod 早停
 *   缓存                    → cache-control: no-cache, must-revalidate；**无 ETag / 无 Last-Modified**
 *                            → 不支持条件 GET，每轮都是全量下载（gzip 后可忽略）
 *   枚举域                  → 排除 `deleted:` 分类；也不含 `forum:`
 *
 * 对比：内容变更发现，sitemap 4 请求 / 620 KB / 5 秒 vs ListPages 145 请求 / 6 MB / 430 秒。
 */

import type { HttpClient } from '../http/client.js';
import { createLogger, type Logger } from '../util/log.js';
import { mapWithConcurrency } from '../util/concurrency.js';
import {
  parseSitemapIndex,
  parseUrlset,
  type SitemapEntry,
  type SitemapIndexEntry,
  type SitemapKind,
} from './parse.js';

/** sitemap 枚举域中合法缺席的 slug 前缀 —— absence 推断必须先排除它们。 */
export const SITEMAP_EXCLUDED_PREFIXES = ['deleted:', 'forum:'] as const;

/** 该 slug 是否本来就不该出现在 sitemap 里（缺席不构成删除证据）。 */
export function isExcludedFromSitemap(slug: string): boolean {
  return SITEMAP_EXCLUDED_PREFIXES.some((p) => slug.startsWith(p));
}

export interface SitemapFile {
  url: string;
  kind: SitemapKind;
  index: number | null;
  entries: SitemapEntry[];
  wireBytes: number;
  decodedBytes: number;
  durationMs: number;
}

export interface SitemapFetchResult {
  files: SitemapFile[];
  /** 全部条目按抓取顺序拼接（未去重）。 */
  entries: SitemapEntry[];
  /** 索引里发现的全部子 sitemap（走 fallback 时为空）。 */
  index: SitemapIndexEntry[];
  /** 是否走了"按命名约定猜 URL"的 fallback（索引抓不到时）。 */
  usedFallback: boolean;
  wireBytes: number;
  decodedBytes: number;
  durationMs: number;
}

export function sitemapIndexUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/sitemap.xml`;
}

export function sitemapFileUrl(baseUrl: string, kind: SitemapKind, index: number): string {
  return `${baseUrl.replace(/\/+$/, '')}/sitemap_${kind}_${index}.xml`;
}

/** 抓索引，返回子 sitemap 清单。 */
export async function fetchSitemapIndex(
  http: HttpClient,
  baseUrl: string,
  log: Logger = createLogger('sitemap'),
): Promise<{ entries: SitemapIndexEntry[]; wireBytes: number; decodedBytes: number }> {
  const url = sitemapIndexUrl(baseUrl);
  const res = await http.get(url, 'sitemap:index');
  const entries = parseSitemapIndex(res.text(), url);
  log.info('索引抓取完成', {
    url,
    children: entries.length,
    byKind: countByKind(entries),
    wireBytes: res.telemetry.wireBytes,
    ms: Math.round(res.telemetry.durationMs),
  });
  return {
    entries,
    wireBytes: res.telemetry.wireBytes,
    decodedBytes: res.telemetry.decodedBytes,
  };
}

/** 抓单个 sitemap 文件并解析。 */
export async function fetchSitemapFile(
  http: HttpClient,
  entry: SitemapIndexEntry,
  log: Logger = createLogger('sitemap'),
): Promise<SitemapFile> {
  const mode = `sitemap:${entry.kind}${entry.index !== null ? `_${entry.index}` : ''}`;
  const res = await http.get(entry.loc, mode);
  const entries = parseUrlset(res.text(), entry.loc);
  log.info('文件抓取完成', {
    url: entry.loc,
    entries: entries.length,
    wireKB: Math.round(res.telemetry.wireBytes / 1024),
    decodedKB: Math.round(res.telemetry.decodedBytes / 1024),
    ms: Math.round(res.telemetry.durationMs),
    encoding: res.telemetry.contentEncoding,
  });
  return {
    url: entry.loc,
    kind: entry.kind,
    index: entry.index,
    entries,
    wireBytes: res.telemetry.wireBytes,
    decodedBytes: res.telemetry.decodedBytes,
    durationMs: res.telemetry.durationMs,
  };
}

export interface FetchFamilyOptions {
  kind: SitemapKind;
  /**
   * 只取前 N 个（按 index 升序）。
   *   delta 模式：limit=1 → 只抓 sitemap_page_1（约 1.2s），覆盖最近 3.7 个月内被修改的页面。
   *   full  模式：不传 → 抓全部 4 个。
   */
  limit?: number;
  concurrency?: number;
  logger?: Logger;
}

/**
 * 抓某一族 sitemap（page / thread / category）。
 *
 * 索引抓不到时**不静默降级**：只有当索引请求本身失败（而不是解析出 0 条）才走命名约定
 * fallback，且在结果里显式标 usedFallback=true —— 调用方据此禁止本轮做 absence 推断
 * （fallback 猜的 URL 可能漏掉刚新增的第 5 个分片，漏掉即等价于"1 万个页面消失"）。
 */
export async function fetchSitemapFamily(
  http: HttpClient,
  baseUrl: string,
  opts: FetchFamilyOptions,
): Promise<SitemapFetchResult> {
  const log = opts.logger ?? createLogger('sitemap');
  const startedAt = Date.now();
  let wireBytes = 0;
  let decodedBytes = 0;
  let usedFallback = false;
  let index: SitemapIndexEntry[] = [];

  try {
    const idx = await fetchSitemapIndex(http, baseUrl, log);
    index = idx.entries;
    wireBytes += idx.wireBytes;
    decodedBytes += idx.decodedBytes;
  } catch (err) {
    // 索引不可用：按命名约定构造。仅对 page 族有意义（实测 4 个分片）。
    log.warn('索引不可用，退回命名约定 fallback', { error: String(err) });
    usedFallback = true;
    const guessCount = opts.limit ?? 1;
    index = Array.from({ length: guessCount }, (_, i) => ({
      loc: sitemapFileUrl(baseUrl, opts.kind, i + 1),
      kind: opts.kind,
      index: i + 1,
    }));
  }

  let targets = index
    .filter((e) => e.kind === opts.kind)
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  if (opts.limit !== undefined) targets = targets.slice(0, opts.limit);

  if (targets.length === 0) {
    throw new Error(`sitemap 索引中没有 kind=${opts.kind} 的分片（索引共 ${index.length} 条）`);
  }

  const files = await mapWithConcurrency(targets, opts.concurrency ?? 2, (t) =>
    fetchSitemapFile(http, t, log),
  );

  const entries: SitemapEntry[] = [];
  for (const f of files) {
    entries.push(...f.entries);
    wireBytes += f.wireBytes;
    decodedBytes += f.decodedBytes;
  }

  return {
    files,
    entries,
    index,
    usedFallback,
    wireBytes,
    decodedBytes,
    durationMs: Date.now() - startedAt,
  };
}

/** delta 模式：只抓 sitemap_page_1（实测 gzip 180 KB / 1.16 s / 10,000 条）。 */
export function fetchPageSitemapDelta(
  http: HttpClient,
  baseUrl: string,
  logger?: Logger,
): Promise<SitemapFetchResult> {
  return fetchSitemapFamily(http, baseUrl, { kind: 'page', limit: 1, concurrency: 1, ...(logger ? { logger } : {}) });
}

/**
 * L1 固定成本入口：直接抓 sitemap_page_1，不先取 sitemap.xml。
 * 该函数的网络预算恒为 1 个 wiki GET；TTL 实测为 60 分钟。
 */
export function fetchPageSitemapActivityHead(
  http: HttpClient,
  baseUrl: string,
  logger?: Logger,
): Promise<SitemapFile> {
  const entry: SitemapIndexEntry = {
    loc: sitemapFileUrl(baseUrl, 'page', 1),
    kind: 'page',
    index: 1,
  };
  return fetchSitemapFile(http, entry, logger);
}

/** full 模式：抓全部 page sitemap（实测 4 个 / gzip 620 KB / ≈5 s / 35,983 slug）。 */
export function fetchAllPageSitemaps(
  http: HttpClient,
  baseUrl: string,
  concurrency = 2,
  logger?: Logger,
): Promise<SitemapFetchResult> {
  return fetchSitemapFamily(http, baseUrl, { kind: 'page', concurrency, ...(logger ? { logger } : {}) });
}

/** thread 族：9 个文件 ≈ 90,000 thread id，**无 lastmod**，只给存在性。 */
export function fetchThreadSitemaps(
  http: HttpClient,
  baseUrl: string,
  concurrency = 2,
  logger?: Logger,
): Promise<SitemapFetchResult> {
  return fetchSitemapFamily(http, baseUrl, { kind: 'thread', concurrency, ...(logger ? { logger } : {}) });
}

/** category 族：1 个文件 / 15 个 forum category。 */
export function fetchCategorySitemap(
  http: HttpClient,
  baseUrl: string,
  logger?: Logger,
): Promise<SitemapFetchResult> {
  return fetchSitemapFamily(http, baseUrl, { kind: 'category', concurrency: 1, ...(logger ? { logger } : {}) });
}

function countByKind(entries: readonly SitemapIndexEntry[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of entries) out[e.kind] = (out[e.kind] ?? 0) + 1;
  return out;
}
