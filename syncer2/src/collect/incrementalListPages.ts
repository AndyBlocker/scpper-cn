/**
 * L0/L1 的窄字段 ListPages 采集器。
 *
 * L0 只看 updated_at 窗口，三字段；L1 必须完整翻完全站 pager，四字段且禁止早停。
 * 两者刻意不复用 20 字段 Tier1 解析器：字段集合、完整性口径和 PHFIX population
 * 都不同，混用会让“小窗口完整”和“全站完整”在类型上失去区别。
 */

import { amcRequest } from '../http/amc.js';
import {
  CircuitOpenError,
  HeaderContractError,
  HttpStatusError,
  type HttpClient,
} from '../http/client.js';
import {
  LISTPAGES_SPORADIC_FAILED_BATCHES,
  LISTPAGES_SPORADIC_FAILED_BATCH_RATIO,
} from './listpages.js';
import { decodeXmlEntities } from '../sitemap/parse.js';
import { createLogger, type Logger } from '../util/log.js';

export type IncrementalListPagesLayer = 'l0' | 'l1';

export const L0_SELECTORS = ['fullname', 'updated_at', 'revisions'] as const;
export const L1_SELECTORS = ['fullname', 'rating', 'rating_votes', 'revisions'] as const;
export const INCREMENTAL_LISTPAGES_PER_PAGE = 250;

type L0Selector = (typeof L0_SELECTORS)[number];
type L1Selector = (typeof L1_SELECTORS)[number];
type SlimSelector = L0Selector | L1Selector;

export interface L0ListPageRow {
  fullname: string;
  updatedAt: string;
  revisions: number;
}

export interface L1ListPageRow {
  fullname: string;
  rating: number;
  ratingVotes: number;
  revisions: number;
}

export type IncrementalListPageRow = L0ListPageRow | L1ListPageRow;

export interface IncrementalPager {
  currentPage: number;
  totalPages: number;
}

export interface IncrementalBatchDiagnostics {
  candidateRows: number;
  parsedRows: number;
  droppedRows: number;
  selectorLiteralFields: number;
  errors: string[];
}

export interface IncrementalBatchResult<T extends IncrementalListPageRow> {
  status: 'ok' | 'failed';
  batchNo: number;
  rows: T[];
  pager: IncrementalPager | null;
  diagnostics: IncrementalBatchDiagnostics;
  error: string | null;
}

export interface IncrementalListPagesRun<T extends IncrementalListPageRow> {
  status: 'ok' | 'partial' | 'failed';
  layer: IncrementalListPagesLayer;
  rows: T[];
  expectedBatches: number | null;
  requestedBatches: number;
  batchesFailed: number;
  pagesEnumerated: number;
  validation: {
    complete: boolean;
    duplicateFullnames: number;
    reasons: string[];
  };
  parseFingerprint: Record<string, unknown>;
}

export interface ScanIncrementalListPagesOptions {
  concurrency?: number;
  windowHours?: number;
  logger?: Logger;
}

const FIELD_SEPARATOR = '|||';
const RAW_DATE_RE = /^%%date\|(\d+)%%$/;

export function buildIncrementalModuleBody(layer: IncrementalListPagesLayer): string {
  const selectors = selectorsFor(layer);
  const fields = selectors.map((name) => `%%%%${name}%%%%`).join(FIELD_SEPARATOR);
  return `[[div class="${rowClassFor(layer)}"]]\n${fields}\n[[/div]]`;
}

export function buildIncrementalListPagesRequest(
  layer: IncrementalListPagesLayer,
  batchNo: number,
  options: { perPage?: number; windowHours?: number } = {},
): {
  moduleName: string;
  params: Record<string, string | number>;
} {
  const perPage = options.perPage ?? INCREMENTAL_LISTPAGES_PER_PAGE;
  if (!Number.isInteger(batchNo) || batchNo < 1) {
    throw new RangeError(`batchNo 必须是正整数，收到 ${batchNo}`);
  }
  if (!Number.isInteger(perPage) || perPage < 1 || perPage > INCREMENTAL_LISTPAGES_PER_PAGE) {
    throw new RangeError(`perPage 必须在 1..${INCREMENTAL_LISTPAGES_PER_PAGE}，收到 ${perPage}`);
  }
  const params: Record<string, string | number> = {
    category: '*',
    order: layer === 'l0' ? 'updated_at desc' : 'created_at desc',
    perPage,
    offset: (batchNo - 1) * perPage,
    module_body: buildIncrementalModuleBody(layer),
  };
  if (layer === 'l0') {
    const windowHours = options.windowHours ?? 2;
    if (!Number.isInteger(windowHours) || windowHours < 1 || windowHours > 24) {
      throw new RangeError(`L0 windowHours 必须是 1..24 的整数，收到 ${windowHours}`);
    }
    // Wikidot ListPages 的时间过滤参数名就是 updated_at；不要改成客户端字段名 updatedAt。
    params.updated_at = `last ${windowHours} hours`;
  }
  return { moduleName: 'list/ListPagesModule', params };
}

export function parseIncrementalListPagesResponse(
  body: string,
  layer: 'l0',
  batchNo: number,
): IncrementalBatchResult<L0ListPageRow>;
export function parseIncrementalListPagesResponse(
  body: string,
  layer: 'l1',
  batchNo: number,
): IncrementalBatchResult<L1ListPageRow>;
export function parseIncrementalListPagesResponse(
  body: string,
  layer: IncrementalListPagesLayer,
  batchNo: number,
): IncrementalBatchResult<IncrementalListPageRow> {
  const diagnostics: IncrementalBatchDiagnostics = {
    candidateRows: 0,
    parsedRows: 0,
    droppedRows: 0,
    selectorLiteralFields: 0,
    errors: [],
  };
  if (body.trim() === '') {
    return failedBatch(layer, batchNo, diagnostics, 'ListPages body 为空');
  }

  const pager = parsePager(body);
  const hasListPagesBox = hasHtmlClass(body, 'list-pages-box');
  const blocks = extractRowBlocks(body, rowClassFor(layer));
  diagnostics.candidateRows = blocks.length;
  const selectors = selectorsFor(layer);
  const rows: IncrementalListPageRow[] = [];

  for (let i = 0; i < blocks.length; i++) {
    try {
      const parts = blocks[i]!.split(FIELD_SEPARATOR);
      if (parts.length !== selectors.length) {
        throw new Error(`字段数 ${parts.length} != ${selectors.length}`);
      }
      const fields = parseDelimitedFields(parts, selectors, diagnostics);
      rows.push(layer === 'l0' ? parseL0Row(fields) : parseL1Row(fields));
    } catch (err) {
      diagnostics.droppedRows++;
      diagnostics.errors.push(`第 ${i + 1} 行：${String(err)}`);
    }
  }
  diagnostics.parsedRows = rows.length;

  if (diagnostics.droppedRows > 0 || diagnostics.selectorLiteralFields > 0) {
    return failedBatch(
      layer,
      batchNo,
      diagnostics,
      `本批拒绝 ${diagnostics.droppedRows} 行、selector 残留 ${diagnostics.selectorLiteralFields} 字段`,
      rows,
      pager,
    );
  }
  // Wikidot 在 0..249 行时不渲染 pager；合法空窗口仍会留下 list-pages-box。
  // 只有 L0 可以用这个结构证明单页/空页，L1 全站首批仍必须有可信 pager。
  if (rows.length === 0 && pager === null) {
    if (layer !== 'l0' || !hasListPagesBox) {
      return failedBatch(
        layer,
        batchNo,
        diagnostics,
        '无 row、无 pager 且缺少 L0 空窗口结构，不能证明是合法空结果',
      );
    }
  }
  return { status: 'ok', batchNo, rows, pager, diagnostics, error: null };
}

/**
 * 扫描 L0 窗口或 L1 全站。没有 max-batches/threshold 参数：
 * L1 的 targets 永远由首批 pager 的 2..N 全集生成，物理上不存在“翻到阈值早停”的入口。
 */
export async function scanIncrementalListPages(
  http: HttpClient,
  baseUrl: string,
  layer: 'l0',
  options?: ScanIncrementalListPagesOptions,
): Promise<IncrementalListPagesRun<L0ListPageRow>>;
export async function scanIncrementalListPages(
  http: HttpClient,
  baseUrl: string,
  layer: 'l1',
  options?: ScanIncrementalListPagesOptions,
): Promise<IncrementalListPagesRun<L1ListPageRow>>;
export async function scanIncrementalListPages(
  http: HttpClient,
  baseUrl: string,
  layer: IncrementalListPagesLayer,
  options: ScanIncrementalListPagesOptions = {},
): Promise<IncrementalListPagesRun<IncrementalListPageRow>> {
  const log = options.logger ?? createLogger(`listpages-${layer}`);
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 5, 5));
  const batches = new Map<number, IncrementalBatchResult<IncrementalListPageRow>>();
  const first = await fetchBatch(http, baseUrl, layer, 1, options.windowHours, log);
  batches.set(1, first);
  if (first.status === 'failed') {
    return finalizeRun(layer, batches, null);
  }
  if (first.pager === null) {
    if (layer === 'l0' && first.rows.length < INCREMENTAL_LISTPAGES_PER_PAGE) {
      return finalizeRun(layer, batches, 1);
    }
    first.status = 'failed';
    first.error = '首批缺 pager 且行数不能证明 L0 单页；禁止猜测总批数';
    return finalizeRun(layer, batches, null);
  }

  const expectedBatches = first.pager.totalPages;
  const targets = batchTargets(expectedBatches);
  await mapLimited(targets, concurrency, async (batchNo) => {
    batches.set(
      batchNo,
      await fetchBatch(http, baseUrl, layer, batchNo, options.windowHours, log),
    );
  });
  return finalizeRun(layer, batches, expectedBatches);
}

/** 导出供回归测试钉死“1..N 全翻、无阈值早停”。 */
export function batchTargets(totalPages: number): number[] {
  if (!Number.isInteger(totalPages) || totalPages < 1) {
    throw new RangeError(`totalPages 必须是正整数，收到 ${totalPages}`);
  }
  return Array.from({ length: totalPages - 1 }, (_, i) => i + 2);
}

async function fetchBatch(
  http: HttpClient,
  baseUrl: string,
  layer: IncrementalListPagesLayer,
  batchNo: number,
  windowHours: number | undefined,
  log: Logger,
): Promise<IncrementalBatchResult<IncrementalListPageRow>> {
  const request = buildIncrementalListPagesRequest(layer, batchNo, { windowHours });
  let lastError = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await amcRequest(http, baseUrl, {
        moduleName: request.moduleName,
        params: request.params,
        mode: `listpages:${layer}:${batchNo}`,
        maxAttempts: 3,
      });
      if (response.status === 'ok') {
        if (response.body === null) {
          return failedBatch(layer, batchNo, emptyDiagnostics(), 'AMC status=ok 但 body=null');
        }
        return parseIncrementalListPagesResponse(
          response.body,
          layer as 'l0',
          batchNo,
        ) as IncrementalBatchResult<IncrementalListPageRow>;
      }
      lastError = `AMC status=${response.status}, message=${response.message ?? '-'}`;
      if (response.status !== 'try_again' || attempt === 3) {
        return failedBatch(layer, batchNo, emptyDiagnostics(), lastError);
      }
    } catch (err) {
      if (
        err instanceof CircuitOpenError ||
        err instanceof HeaderContractError ||
        (err instanceof HttpStatusError && (err.status === 429 || err.status === 503))
      ) {
        return failedBatch(layer, batchNo, emptyDiagnostics(), String(err));
      }
      lastError = String(err);
      if (attempt === 3) {
        return failedBatch(layer, batchNo, emptyDiagnostics(), `三次尝试耗尽：${lastError}`);
      }
    }
    const waitMs = 500 * 2 ** (attempt - 1) + Math.floor(Math.random() * 100);
    log.warn('窄字段 ListPages 批级退避', { layer, batchNo, attempt, waitMs, lastError });
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
  return failedBatch(layer, batchNo, emptyDiagnostics(), `重试耗尽：${lastError}`);
}

function finalizeRun(
  layer: IncrementalListPagesLayer,
  batches: Map<number, IncrementalBatchResult<IncrementalListPageRow>>,
  expectedBatches: number | null,
): IncrementalListPagesRun<IncrementalListPageRow> {
  const hardReasons: string[] = [];
  const partialReasons: string[] = [];
  const ordered = [...batches.entries()].sort(([a], [b]) => a - b);
  const batchesFailed = ordered.filter(([, batch]) => batch.status === 'failed').length;
  /*
   * 零星批失败判 partial 而非 failed——与全站扫描路径（listpages.ts）同一判据。
   *
   * partial 本就不持久化、不推进增量状态、不入队、不喂缺失推断，所以改判在数据上零风险，
   * 只影响告警语义。此前任何一批失败即整轮 failed：站点侧偶发 http_503 就产生一次
   * 必然自愈的告警，L1 提频到 5 分钟后命中概率还翻了三倍。
   *
   * 教训：同一判据此前只加在全站路径上，7 个测试用例全部针对那条路径的常量，
   * **没有一个验证 L1 的真实调用链**——于是测试全绿而生产照挂。
   * 验证了逻辑，没验证逻辑被用到。
   */
  const sporadicBatchFailure =
    batchesFailed > 0
    && batchesFailed <= LISTPAGES_SPORADIC_FAILED_BATCHES
    && (expectedBatches === null
      ? false
      : batchesFailed / expectedBatches <= LISTPAGES_SPORADIC_FAILED_BATCH_RATIO);

  if (expectedBatches === null) hardReasons.push('首批没有可信 pager');
  if (expectedBatches !== null && batches.size !== expectedBatches) {
    // 批数对不上若纯粹由零星失败批造成，则与失败批同级处理，不再重复升级为 hard。
    const missing = expectedBatches - batches.size;
    if (sporadicBatchFailure && missing > 0 && missing <= batchesFailed) {
      partialReasons.push(`实际批数 ${batches.size} != pager ${expectedBatches}（零星失败批所致）`);
    } else {
      hardReasons.push(`实际批数 ${batches.size} != pager ${expectedBatches}`);
    }
  }
  if (batchesFailed > 0) {
    if (sporadicBatchFailure) {
      partialReasons.push(`${batchesFailed} 批零星失败（下轮重扫）`);
    } else {
      hardReasons.push(`${batchesFailed} 批失败`);
    }
  }

  for (const [batchNo, batch] of ordered) {
    if (batch.status !== 'ok' || expectedBatches === null) continue;
    if (batch.pager !== null) {
      // 请求用显式 offset，而不是 Wikidot 的 page 参数。服务端因此把每个 offset
      // 后的切片都当成“第 1 页”，totalPages 则是剩余页数：第 2 批为 1/(N-1)。
      const expectedRemainingPages = expectedBatches - batchNo + 1;
      if (batch.pager.currentPage !== 1 || batch.pager.totalPages !== expectedRemainingPages) {
        hardReasons.push(
          `第 ${batchNo} 批 pager=${batch.pager.currentPage}/${batch.pager.totalPages} ` +
            `!= offset 切片 1/${expectedRemainingPages}`,
        );
      }
    }
    if (batchNo < expectedBatches && batch.rows.length !== INCREMENTAL_LISTPAGES_PER_PAGE) {
      hardReasons.push(
        `非末批 ${batchNo} 行数 ${batch.rows.length} != ${INCREMENTAL_LISTPAGES_PER_PAGE}`,
      );
    }
    if (batchNo === expectedBatches && expectedBatches > 1 && batch.rows.length === 0) {
      hardReasons.push(`末批 ${batchNo} 为空，不能证明枚举完整`);
    }
    if (batchNo === expectedBatches && batch.rows.length > INCREMENTAL_LISTPAGES_PER_PAGE) {
      hardReasons.push(`末批行数 ${batch.rows.length} 超过上限`);
    }
  }

  const rows = ordered
    .filter(([, batch]) => batch.status === 'ok')
    .flatMap(([, batch]) => batch.rows);
  const duplicateFullnames = rows.length - new Set(rows.map((row) => row.fullname)).size;
  if (duplicateFullnames > 0) {
    // 多批抓取不是远端事务快照；抓取期间页面移动会让相邻 offset 重复一条。
    // 证据不完整，不能推进状态，但这不是请求耗尽或解析器失效。
    partialReasons.push(`跨批 fullname 重复 ${duplicateFullnames}`);
  }
  const candidateRows = ordered.reduce((sum, [, batch]) => sum + batch.diagnostics.candidateRows, 0);
  const droppedRows = ordered.reduce((sum, [, batch]) => sum + batch.diagnostics.droppedRows, 0);
  const literalFields = ordered.reduce(
    (sum, [, batch]) => sum + batch.diagnostics.selectorLiteralFields,
    0,
  );
  const reasons = [...hardReasons, ...partialReasons];
  const complete = reasons.length === 0;
  return {
    status:
      hardReasons.length > 0
        ? 'failed'
        : partialReasons.length > 0
          ? 'partial'
          : 'ok',
    layer,
    rows,
    expectedBatches,
    requestedBatches: batches.size,
    batchesFailed,
    pagesEnumerated: rows.length,
    validation: { complete, duplicateFullnames, reasons },
    parseFingerprint: {
      sample_counts: {
        parse_drop_rate: candidateRows,
      },
      parse_drop_rate: candidateRows === 0 ? 0 : droppedRows / candidateRows,
      selector_literal_rate:
        candidateRows === 0
          ? 0
          : literalFields / (candidateRows * selectorsFor(layer).length),
      duplicate_fullname_rate: rows.length === 0 ? 0 : duplicateFullnames / rows.length,
    },
  };
}

function parseDelimitedFields(
  parts: readonly string[],
  selectors: readonly SlimSelector[],
  diagnostics: IncrementalBatchDiagnostics,
): Map<SlimSelector, ParsedField> {
  const fields = new Map<SlimSelector, ParsedField>();
  selectors.forEach((selector, i) => {
    const rawHtml = parts[i]!;
    const text = htmlToText(rawHtml).trim();
    const boundary = /^%%([\s\S]*)%%$/.exec(text);
    if (boundary === null) {
      // fullname 可能因真实 slug 命中 selector 名而被 Wikidot 二次展开；只放行 slug 安全字节。
      if (selector === 'fullname' && /^[a-z0-9_:-]+$/i.test(text)) {
        fields.set(selector, { text, rawHtml });
        return;
      }
      throw new Error(`${selector} 缺少 %%...%% 定界`);
    }
    const value = boundary[1] ?? '';
    if (/^%%[\s\S]*%%$/.test(value) && !(selector === 'updated_at' && RAW_DATE_RE.test(value))) {
      diagnostics.selectorLiteralFields++;
      throw new Error(`${selector} 含 selector 字面量残留`);
    }
    fields.set(selector, { text: value, rawHtml });
  });
  return fields;
}

interface ParsedField {
  text: string;
  rawHtml: string;
}

function parseL0Row(fields: Map<SlimSelector, ParsedField>): L0ListPageRow {
  return {
    fullname: requiredFullname(fields.get('fullname')?.text),
    updatedAt: parseDate(fields.get('updated_at'), 'updated_at'),
    revisions: parseNonNegativeInt(fields.get('revisions')?.text, 'revisions'),
  };
}

function parseL1Row(fields: Map<SlimSelector, ParsedField>): L1ListPageRow {
  return {
    fullname: requiredFullname(fields.get('fullname')?.text),
    rating: parseInteger(fields.get('rating')?.text, 'rating'),
    ratingVotes: parseNonNegativeInt(fields.get('rating_votes')?.text, 'rating_votes'),
    revisions: parseNonNegativeInt(fields.get('revisions')?.text, 'revisions'),
  };
}

function requiredFullname(value: string | undefined): string {
  const fullname = value?.trim() ?? '';
  if (fullname === '') throw new Error('fullname 为空');
  return fullname;
}

function parseInteger(value: string | undefined, label: string): number {
  const text = value?.trim() ?? '';
  if (!/^[+-]?\d+$/.test(text)) throw new Error(`${label} 不是整数：${JSON.stringify(text)}`);
  const number = Number(text);
  if (!Number.isSafeInteger(number)) throw new Error(`${label} 超出安全整数范围`);
  return number;
}

function parseNonNegativeInt(value: string | undefined, label: string): number {
  const number = parseInteger(value, label);
  if (number < 0) throw new Error(`${label} 必须 >= 0`);
  return number;
}

function parseDate(field: ParsedField | undefined, label: string): string {
  if (field === undefined) throw new Error(`${label} 缺失`);
  const classEpoch = /\btime_(\d+)\b/.exec(field.rawHtml)?.[1];
  const rawEpoch = RAW_DATE_RE.exec(field.text.trim())?.[1];
  const epochText = classEpoch ?? rawEpoch;
  if (epochText === undefined) throw new Error(`${label} 找不到 epoch`);
  const epoch = Number(epochText);
  if (!Number.isSafeInteger(epoch) || epoch <= 0) throw new Error(`${label} epoch 非法`);
  return new Date(epoch * 1000).toISOString();
}

function parsePager(body: string): IncrementalPager | null {
  const pager = /<span\b[^>]*class=(?:"[^"]*\bpager-no\b[^"]*"|'[^']*\bpager-no\b[^']*')[^>]*>([\s\S]*?)<\/span>/i.exec(
    body,
  );
  const match = pager === null ? null : /\bpage\s+(\d+)\s+of\s+(\d+)\b/i.exec(htmlToText(pager[1] ?? ''));
  if (match === null) return null;
  const currentPage = Number(match[1]);
  const totalPages = Number(match[2]);
  return Number.isInteger(currentPage) &&
    Number.isInteger(totalPages) &&
    currentPage >= 1 &&
    totalPages >= currentPage
    ? { currentPage, totalPages }
    : null;
}

function hasHtmlClass(body: string, className: string): boolean {
  const escaped = className.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(
    `<[^>]+\\bclass=(?:"[^"]*\\b${escaped}\\b[^"]*"|'[^']*\\b${escaped}\\b[^']*')`,
    'i',
  ).test(body);
}

function extractRowBlocks(body: string, rowClass: string): string[] {
  const blocks: string[] = [];
  const divRe = /<div\b([^>]*)>/gi;
  let match: RegExpExecArray | null;
  while ((match = divRe.exec(body)) !== null) {
    const attrs = match[1] ?? '';
    const classMatch = /\bclass\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attrs);
    const classes = (classMatch?.[1] ?? classMatch?.[2] ?? '').split(/\s+/);
    if (!classes.includes(rowClass)) continue;
    const close = /<\/div\s*>/gi;
    close.lastIndex = divRe.lastIndex;
    const closeMatch = close.exec(body);
    if (closeMatch !== null) blocks.push(body.slice(divRe.lastIndex, closeMatch.index));
  }
  return blocks;
}

function htmlToText(html: string): string {
  return decodeXmlEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<[^>]+>/g, ''),
  );
}

function selectorsFor(layer: IncrementalListPagesLayer): readonly SlimSelector[] {
  return layer === 'l0' ? L0_SELECTORS : L1_SELECTORS;
}

function rowClassFor(layer: IncrementalListPagesLayer): string {
  return `syncer2-incremental-${layer}-row`;
}

function emptyDiagnostics(): IncrementalBatchDiagnostics {
  return {
    candidateRows: 0,
    parsedRows: 0,
    droppedRows: 0,
    selectorLiteralFields: 0,
    errors: [],
  };
}

function failedBatch(
  _layer: IncrementalListPagesLayer,
  batchNo: number,
  diagnostics: IncrementalBatchDiagnostics,
  error: string,
  rows: IncrementalListPageRow[] = [],
  pager: IncrementalPager | null = null,
): IncrementalBatchResult<IncrementalListPageRow> {
  diagnostics.errors.push(error);
  return { status: 'failed', batchNo, rows, pager, diagnostics, error };
}

async function mapLimited<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, Math.max(1, items.length)) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      await fn(items[index] as T);
    }
  });
  await Promise.all(workers);
}
