/**
 * 受限分类的 ListPages 权威观测。
 *
 * adult 页面匿名整页 GET 会统一落到内容警告页；这里刻意只从 ListPages 读取
 * fullname 与页面级数据。%%content%% 是渲染 HTML，不是 wikitext，入库时走
 * ingest.rendered_content_blob，绝不冒充 ViewSource。
 */

import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';

import { extractSearchText, type ExtractResult } from '../content/extractText.js';
import { amcRequest } from '../http/amc.js';
import type { HttpClient } from '../http/client.js';
import { createLogger, type Logger } from '../util/log.js';
import { throwIfRuntimeBudgetExceeded } from '../util/runtimeBudget.js';
import {
  LISTPAGES_PER_PAGE,
  buildListPagesModuleBody,
  parseListPagesResponse,
  type ListPageRecord,
} from './listpages.js';

const RESTRICTED_CONTENT_ROW_CLASS = 'syncer2-restricted-content-row';
export const RESTRICTED_SLUG_START = 'SYNCER2_RESTRICTED_SLUG_7B1D6D91_START_';
export const RESTRICTED_SLUG_END = '_SYNCER2_RESTRICTED_SLUG_7B1D6D91_END';
export const RESTRICTED_CONTENT_START = 'SYNCER2_RESTRICTED_CONTENT_7B1D6D91_START_';
export const RESTRICTED_CONTENT_END = '_SYNCER2_RESTRICTED_CONTENT_7B1D6D91_END';

export interface RestrictedListPageRecord extends ListPageRecord {
  /** ListPages %%content%% 的渲染 HTML；不是 wikidot 源码。 */
  contentHtml: string;
  contentSha256Hex: string;
  textContent: string;
  textExtraction: ExtractResult;
}

export interface RestrictedRenderedContent {
  slug: string;
  contentHtml: string;
  contentSha256Hex: string;
  textContent: string;
  textExtraction: ExtractResult;
}

export type RestrictedListPagesOutcome =
  | {
      status: 'ok';
      rows: RestrictedListPageRecord[];
      remoteTotal: number;
      batches: number;
    }
  | { status: 'failed'; error: string; rows?: never };

/**
 * 标准 20 字段元数据行与 content 行分开。content 不能依赖 DOM 容器闭合：线上正文
 * 确有不平衡标签/残留 wiki 语法，会吞掉调用方追加的 [[div]]。长随机文字哨兵在原始
 * AMC 响应中按顺序切片，随后再单独规范化 HTML，正文中的 div/分隔符不污染边界。
 */
function buildRestrictedListPagesModuleBody(): string {
  return `${buildListPagesModuleBody()}\n` +
    `[[div class="${RESTRICTED_CONTENT_ROW_CLASS}"]]\n` +
    `${RESTRICTED_SLUG_START}%%fullname%%${RESTRICTED_SLUG_END}\n` +
    `${RESTRICTED_CONTENT_START}%%content%%${RESTRICTED_CONTENT_END}\n` +
    '[[/div]]';
}

export function buildRestrictedListPagesRequest(
  category: string,
  batchNo: number,
): { moduleName: string; params: Record<string, string | number> } {
  if (!/^[a-z0-9_-]+$/i.test(category)) {
    throw new RangeError(`受限 category 非法：${category}`);
  }
  if (!Number.isInteger(batchNo) || batchNo < 1) {
    throw new RangeError(`batchNo 必须为正整数，收到 ${batchNo}`);
  }
  return {
    moduleName: 'list/ListPagesModule',
    params: {
      category,
      order: 'created_at desc',
      perPage: LISTPAGES_PER_PAGE,
      offset: (batchNo - 1) * LISTPAGES_PER_PAGE,
      // 元数据与正文必须物理分离：一篇带不平衡标签的正文不能破坏后续元数据行。
      module_body: buildListPagesModuleBody(),
    },
  };
}

export function buildRestrictedContentRequest(
  category: string,
  name: string,
): { moduleName: string; params: Record<string, string | number> } {
  if (!/^[a-z0-9_-]+$/i.test(category) || name.trim() === '' || /[\r\n]/.test(name)) {
    throw new RangeError(`受限正文定位非法：category=${category}, name=${name}`);
  }
  return {
    moduleName: 'list/ListPagesModule',
    params: {
      category,
      name,
      perPage: 1,
      module_body: buildRestrictedListPagesModuleBody(),
    },
  };
}

export function parseRestrictedListPagesResponse(
  body: string,
  category: string,
  batchNo = 1,
):
  | { status: 'ok'; rows: RestrictedListPageRecord[]; pageCount: number }
  | { status: 'failed'; error: string } {
  const meta = parseListPagesResponse(body, batchNo, 1, LISTPAGES_PER_PAGE);
  if (meta.status !== 'ok') {
    return {
      status: 'failed',
      error: `受限 ListPages 元数据批 ${batchNo} ${meta.status}：${meta.error}`,
    };
  }

  const content = parseContentRows(body);
  if (content.status === 'failed') return content;
  const metaNames = new Set(meta.data.rows.map((row) => row.fullname));
  const contentNames = new Set(content.rows.keys());
  const missing = [...metaNames].filter((slug) => !contentNames.has(slug));
  const extra = [...contentNames].filter((slug) => !metaNames.has(slug));
  if (missing.length > 0 || extra.length > 0 || metaNames.size !== meta.data.rows.length) {
    return {
      status: 'failed',
      error:
        `受限 ListPages 元数据/content 身份集合不一致：meta=${meta.data.rows.length}, ` +
        `content=${content.rows.size}, missing=${missing.slice(0, 5).join(',') || '-'}, ` +
        `extra=${extra.slice(0, 5).join(',') || '-'}`,
    };
  }

  const rows: RestrictedListPageRecord[] = [];
  for (const row of meta.data.rows) {
    if (row.category.toLowerCase() !== category.toLowerCase()) {
      return {
        status: 'failed',
        error: `受限 ListPages category 漂移：请求=${category}, ${row.fullname}=${row.category}`,
      };
    }
    const contentHtml = content.rows.get(row.fullname)!;
    const extraction = extractSearchText(`<div id="page-content">${contentHtml}</div>`);
    if (extraction.status === 'failed') {
      return {
        status: 'failed',
        error: `${row.fullname} 的 %%content%% 结构不可用：${extraction.error}`,
      };
    }
    rows.push({
      ...row,
      contentHtml,
      contentSha256Hex: createHash('sha256').update(contentHtml, 'utf8').digest('hex'),
      textContent: extraction.data.text,
      textExtraction: extraction.data,
    });
  }
  return { status: 'ok', rows, pageCount: meta.data.pager.totalPages };
}

/**
 * 分类完整轮。任一批失败即整体 failed；调用方不得把 failed.rows 当空集合参与删除推断。
 */
export async function scanRestrictedListPages(
  http: HttpClient,
  baseUrl: string,
  category = 'adult',
  logger: Logger = createLogger(`restricted-listpages:${category}`),
): Promise<RestrictedListPagesOutcome> {
  const first = await fetchMetadataBatch(http, baseUrl, category, 1);
  if (first.status === 'failed') return first;
  const expectedBatches = first.pageCount;
  const batches = [first];
  for (let batchNo = 2; batchNo <= expectedBatches; batchNo++) {
    const batch = await fetchMetadataBatch(http, baseUrl, category, batchNo);
    if (batch.status === 'failed') return batch;
    batches.push(batch);
  }
  const metadata = batches.flatMap((batch) => batch.rows);
  const bySlug = new Set(metadata.map((row) => row.fullname));
  const totals = new Set(metadata.map((row) => row.total));
  const remoteTotal = metadata[0]?.total ?? 0;
  if (metadata.length === 0 || bySlug.size !== metadata.length || totals.size !== 1 || remoteTotal !== metadata.length) {
    return {
      status: 'failed',
      error:
        `受限 ListPages 完整性失败：rows=${metadata.length}, unique=${bySlug.size}, ` +
        `totals=${[...totals].join(',') || '-'}, remoteTotal=${remoteTotal}`,
    };
  }

  // 正文逐页隔离、低并发请求。一篇畸形正文吞掉尾哨兵时只影响自己的响应，绝不跨页。
  const content = await mapLimitedResults(metadata, 2, (row) =>
    fetchContent(http, baseUrl, category, row),
  );
  const failed = content.find((outcome) => outcome.status === 'failed');
  if (failed?.status === 'failed') return failed;
  const rows = metadata.map((row, i) => materializeRestrictedRow(
    row,
    (content[i] as { status: 'ok'; contentHtml: string }).contentHtml,
  ));
  logger.info('受限 ListPages 完整轮通过', {
    category,
    rows: rows.length,
    batches: expectedBatches,
    isolatedContentRequests: rows.length,
  });
  return { status: 'ok', rows, remoteTotal, batches: expectedBatches };
}

async function fetchMetadataBatch(
  http: HttpClient,
  baseUrl: string,
  category: string,
  batchNo: number,
): Promise<
  | { status: 'ok'; rows: ListPageRecord[]; pageCount: number }
  | { status: 'failed'; error: string }
> {
  try {
    const request = buildRestrictedListPagesRequest(category, batchNo);
    const response = await amcRequest(http, baseUrl, {
      ...request,
      mode: `listpages:restricted:${category}:${batchNo}`,
      maxAttempts: 3,
    });
    if (response.status !== 'ok' || response.body === null) {
      return {
        status: 'failed',
        error:
          `受限 ListPages AMC 批 ${batchNo} status=${response.status}, ` +
          `body=${response.body === null ? 'null' : 'present'}`,
      };
    }
    const parsed = parseListPagesResponse(response.body, batchNo, 1, LISTPAGES_PER_PAGE);
    if (parsed.status !== 'ok') {
      return {
        status: 'failed',
        error: `受限 ListPages 元数据批 ${batchNo} ${parsed.status}：${parsed.error}`,
      };
    }
    for (const row of parsed.data.rows) {
      if (row.category.toLowerCase() !== category.toLowerCase()) {
        return {
          status: 'failed',
          error: `受限 ListPages category 漂移：请求=${category}, ${row.fullname}=${row.category}`,
        };
      }
    }
    return {
      status: 'ok',
      rows: parsed.data.rows,
      pageCount: parsed.data.pager.totalPages,
    };
  } catch (err) {
    throwIfRuntimeBudgetExceeded(err);
    return { status: 'failed', error: `受限 ListPages 批 ${batchNo} 请求失败：${String(err)}` };
  }
}

async function fetchContent(
  http: HttpClient,
  baseUrl: string,
  category: string,
  row: ListPageRecord,
): Promise<{ status: 'ok'; contentHtml: string } | { status: 'failed'; error: string }> {
  try {
    const request = buildRestrictedContentRequest(category, row.name);
    const response = await amcRequest(http, baseUrl, {
      ...request,
      mode: `listpages:restricted-content:${row.fullname}`,
      maxAttempts: 3,
    });
    if (response.status !== 'ok' || response.body === null) {
      return {
        status: 'failed',
        error: `${row.fullname} 正文 ListPages status=${response.status}；不解释为空正文`,
      };
    }
    return parseSingleContentResponse(response.body, row.fullname);
  } catch (err) {
    throwIfRuntimeBudgetExceeded(err);
    return { status: 'failed', error: `${row.fullname} 正文 ListPages 请求失败：${String(err)}` };
  }
}

/**
 * 日常 content 任务只刷新目标页的 ListPages %%content%%。完整 133 页枚举属于身份/bootstrap
 * 协议，不应被每个短进程的首个源码任务重复执行。
 */
export async function scanRestrictedListPageContent(
  http: HttpClient,
  baseUrl: string,
  slug: string,
): Promise<
  | { status: 'ok'; data: RestrictedRenderedContent }
  | { status: 'failed'; error: string }
> {
  const separator = slug.indexOf(':');
  if (separator <= 0 || separator === slug.length - 1) {
    return { status: 'failed', error: `受限正文 slug 非法：${slug}` };
  }
  const category = slug.slice(0, separator).toLowerCase();
  const name = slug.slice(separator + 1);
  try {
    const request = buildRestrictedContentRequest(category, name);
    const response = await amcRequest(http, baseUrl, {
      ...request,
      mode: `listpages:restricted-content:${slug}`,
      maxAttempts: 3,
    });
    if (response.status !== 'ok' || response.body === null) {
      return {
        status: 'failed',
        error: `${slug} 正文 ListPages status=${response.status}；不解释为空正文`,
      };
    }
    const parsed = parseSingleContentResponse(response.body, slug);
    if (parsed.status === 'failed') return parsed;
    const extraction = extractSearchText(
      `<div id="page-content">${parsed.contentHtml}</div>`,
    );
    if (extraction.status === 'failed') {
      return { status: 'failed', error: `${slug} 的 %%content%% 结构不可用：${extraction.error}` };
    }
    return {
      status: 'ok',
      data: {
        slug,
        contentHtml: parsed.contentHtml,
        contentSha256Hex: createHash('sha256').update(parsed.contentHtml, 'utf8').digest('hex'),
        textContent: extraction.data.text,
        textExtraction: extraction.data,
      },
    };
  } catch (err) {
    throwIfRuntimeBudgetExceeded(err);
    return { status: 'failed', error: `${slug} 正文 ListPages 请求失败：${String(err)}` };
  }
}

function parseSingleContentResponse(
  body: string,
  expectedSlug: string,
): { status: 'ok'; contentHtml: string } | { status: 'failed'; error: string } {
  const slugStart = body.indexOf(RESTRICTED_SLUG_START);
  const slugValueStart = slugStart < 0 ? -1 : slugStart + RESTRICTED_SLUG_START.length;
  const slugEnd = slugValueStart < 0 ? -1 : body.indexOf(RESTRICTED_SLUG_END, slugValueStart);
  const contentStartMarker = slugEnd < 0
    ? -1
    : body.indexOf(RESTRICTED_CONTENT_START, slugEnd + RESTRICTED_SLUG_END.length);
  const contentStart = contentStartMarker < 0
    ? -1
    : contentStartMarker + RESTRICTED_CONTENT_START.length;
  if (slugStart < 0 || slugEnd < 0 || contentStart < 0) {
    return { status: 'failed', error: `${expectedSlug} 正文响应缺少起始哨兵；不解释为空正文` };
  }
  const observedSlug = body.slice(slugValueStart, slugEnd).trim();
  if (observedSlug.toLowerCase() !== expectedSlug.toLowerCase()) {
    return {
      status: 'failed',
      error: `${expectedSlug} 正文 ListPages 身份漂移为 ${observedSlug || '(empty)'}`,
    };
  }
  const explicitEnd = body.indexOf(RESTRICTED_CONTENT_END, contentStart);
  const contentEnd = explicitEnd < 0 ? body.length : explicitEnd;
  const fragment = cheerio.load(body.slice(contentStart, contentEnd), { xml: false }, false);
  return { status: 'ok', contentHtml: fragment.root().html() ?? '' };
}

function materializeRestrictedRow(
  row: ListPageRecord,
  contentHtml: string,
): RestrictedListPageRecord {
  const extraction = extractSearchText(`<div id="page-content">${contentHtml}</div>`);
  if (extraction.status === 'failed') {
    throw new Error(`${row.fullname} 的 %%content%% 结构不可用：${extraction.error}`);
  }
  return {
    ...row,
    contentHtml,
    contentSha256Hex: createHash('sha256').update(contentHtml, 'utf8').digest('hex'),
    textContent: extraction.data.text,
    textExtraction: extraction.data,
  };
}

async function mapLimitedResults<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.max(1, Math.min(concurrency, items.length || 1)) },
    async () => {
      for (;;) {
        const index = cursor++;
        if (index >= items.length) return;
        results[index] = await fn(items[index] as T);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

function parseContentRows(
  body: string,
): { status: 'ok'; rows: Map<string, string> } | { status: 'failed'; error: string } {
  const rows = new Map<string, string>();
  let cursor = 0;
  for (let i = 0; ; i++) {
    const slugStart = body.indexOf(RESTRICTED_SLUG_START, cursor);
    if (slugStart < 0) break;
    const slugValueStart = slugStart + RESTRICTED_SLUG_START.length;
    const slugEnd = body.indexOf(RESTRICTED_SLUG_END, slugValueStart);
    const contentStartMarker = slugEnd < 0
      ? -1
      : body.indexOf(RESTRICTED_CONTENT_START, slugEnd + RESTRICTED_SLUG_END.length);
    const contentStart = contentStartMarker < 0
      ? -1
      : contentStartMarker + RESTRICTED_CONTENT_START.length;
    const contentEnd = contentStart < 0
      ? -1
      : body.indexOf(RESTRICTED_CONTENT_END, contentStart);
    if (slugEnd < 0 || contentStartMarker < 0 || contentEnd < 0) {
      return { status: 'failed', error: `第 ${i + 1} 个 content 行哨兵不完整；不解释为短响应` };
    }
    const nextSlug = body.indexOf(RESTRICTED_SLUG_START, slugValueStart);
    if (nextSlug >= 0 && nextSlug < contentEnd) {
      return { status: 'failed', error: `第 ${i + 1} 个 content 行边界交错；不解释为正文` };
    }
    const slug = body.slice(slugValueStart, slugEnd).trim();
    if (slug === '' || !/^[^\s/]+$/.test(slug)) {
      return { status: 'failed', error: `第 ${i + 1} 个 content 行 slug 非法：${slug.slice(0, 80)}` };
    }
    if (rows.has(slug)) {
      return { status: 'failed', error: `content 行 fullname 重复：${slug}` };
    }
    // 哨兵是同一段 wiki 文本的一部分，块级正文会让首尾 <p> 落在哨兵之外。
    // 以 fragment 模式重解析可补齐/丢弃孤立闭合标签，保存的是等价渲染 HTML。
    const fragment = cheerio.load(body.slice(contentStart, contentEnd), { xml: false }, false);
    rows.set(slug, fragment.root().html() ?? '');
    cursor = contentEnd + RESTRICTED_CONTENT_END.length;
  }
  if (rows.size === 0) {
    return { status: 'failed', error: '受限 ListPages 响应没有 content 行；不解释为空分类' };
  }
  return { status: 'ok', rows };
}
