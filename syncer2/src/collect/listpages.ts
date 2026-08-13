/**
 * ListPages Tier1 全站扫描。
 *
 * 本文件只做三件事：
 *   1. 构造规格 §3.1/§3.2 的 AMC 请求；
 *   2. 把响应解析为有类型的页面观测；
 *   3. 执行 §3.3/§3.4 的四道校验并给出整轮状态。
 *
 * 数据库写入留给单次短进程 CLI。这样解析器可以用固定 fixture 做纯离线测试，也让
 * “扫描失败”和“合法空结果”在类型上保持分离，不会再出现 `|| []` 后参与 diff 的路径。
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';

import { amcRequest } from '../http/amc.js';
import {
  CircuitOpenError,
  HeaderContractError,
  HttpStatusError,
  type HttpClient,
} from '../http/client.js';
import { decodeXmlEntities } from '../sitemap/parse.js';
import { createLogger, type Logger } from '../util/log.js';
import {
  abortableSleep,
  throwIfRuntimeBudgetExceeded,
} from '../util/runtimeBudget.js';

export const LISTPAGES_PER_PAGE = 250;
export const LISTPAGES_PARSE_DROP_LIMIT = 0.005;

/**
 * 零星批失败的上限：同时受绝对条数与占比约束，两者都满足才算「偶发」。
 *
 * 绝对条数挡住小规模扫描（L0 只有 1--3 批，占比判据在那里没有意义）；
 * 占比挡住全站扫描（145 批时 3 批 = 2.1%）。任一超限即回到 failed。
 */
export const LISTPAGES_SPORADIC_FAILED_BATCHES = 3;
export const LISTPAGES_SPORADIC_FAILED_BATCH_RATIO = 0.03;
export const LISTPAGES_SNAPSHOT_VERSION = 1;

/**
 * 规格 §3.2 逐字列出的 selector。
 *
 * 注意：规格正文称“21 个”，但代码块逐项只有 20 个唯一名字。这里不擅自加入正文明确
 * 认为具有 HTML/分隔符攻击面的 created_by_linked，也不加入被明确禁止的 page_id /
 * rating_percent；该计数矛盾在 build report 中留痕。
 */
export const LISTPAGES_SELECTORS = [
  'fullname',
  'category',
  'name',
  'title',
  'tags',
  '_tags',
  'parent_fullname',
  'created_at',
  'created_by',
  'created_by_id',
  'created_by_unix',
  'updated_at',
  'commented_at',
  'rating',
  'rating_votes',
  'comments',
  'size',
  'revisions',
  'total',
  'index',
] as const;

export type ListPagesSelector = (typeof LISTPAGES_SELECTORS)[number];

const ROW_CLASS = 'syncer2-listpages-row';
const FIELD_SEPARATOR = '|||';
const DATE_SELECTORS = new Set<ListPagesSelector>(['created_at', 'updated_at', 'commented_at']);
const SELECTOR_LITERAL_RE = /^%%.+%%$/s;
const RAW_DATE_RE = /^%%date\|(\d+)%%$/;

export interface ListPageRecord {
  fullname: string;
  category: string;
  name: string;
  title: string;
  tags: string[];
  hiddenTags: string[];
  /** visible + hidden 的去重排序集合，等同 v1/CROM 口径。 */
  mergedTags: string[];
  parentFullname: string | null;
  createdAt: string;
  createdBy: string | null;
  createdById: number | null;
  createdByUnix: string | null;
  updatedAt: string | null;
  commentedAt: string | null;
  rating: number;
  ratingVotes: number;
  comments: number;
  size: number;
  revisions: number;
  total: number;
  index: number;
}

export interface ListPagesPager {
  currentPage: number;
  totalPages: number;
  source: 'pager-no' | 'target-links' | 'row-total';
}

export interface ListPagesBatchDiagnostics {
  candidateRows: number;
  parsedRows: number;
  droppedFieldCountRows: number;
  droppedParseRows: number;
  rejectedFiveStarRows: number;
  selectorLiteralFields: number;
  parseDropRate: number;
  errors: string[];
}

export interface ListPagesBatchData {
  batchNo: number;
  pager: ListPagesPager;
  rows: ListPageRecord[];
  diagnostics: ListPagesBatchDiagnostics;
  amcAttempts: number;
}

/**
 * 铁律 §1.1 的物理形状：失败批不会从 Map 里消失，也不会退化成空数组。
 * intentionalOmission 只用于 `--max-batches` 小样本，明确表示“本批根本没请求”。
 */
export type ListPagesBatchOutcome =
  | { status: 'ok'; data: ListPagesBatchData }
  | { status: 'partial'; data?: ListPagesBatchData; error: string; intentionalOmission?: boolean }
  | { status: 'failed'; error: string; diagnostics?: ListPagesBatchDiagnostics };

export interface ListPagesRunValidation {
  selectorLiteralFree: boolean;
  parseDropWithinLimit: boolean;
  indexContinuous: boolean;
  fiveStarAbsent: boolean;
  totalStable: boolean;
  pagerMatchesRemoteTotal: boolean;
  duplicateFullnames: number;
  duplicateIndexes: number;
  expectedLastIndex: number | null;
  observedLastIndex: number | null;
  firstTotal: number | null;
  lastTotal: number | null;
  reasons: string[];
}

export interface ListPagesRunResult {
  status: 'ok' | 'partial' | 'failed';
  batches: Map<number, ListPagesBatchOutcome>;
  rows: ListPageRecord[];
  remoteTotal: number | null;
  expectedBatches: number | null;
  requestedBatches: number;
  batchesFailed: number;
  pagesEnumerated: number;
  parseFingerprint: Record<string, unknown>;
  validation: ListPagesRunValidation;
}

export interface ScanListPagesOptions {
  concurrency?: number;
  maxBatches?: number;
  perPage?: number;
  logger?: Logger;
  /** true 时不再启动新批次；已在飞的批次完成后由调用方按 partial 收尾。 */
  shouldStop?: () => boolean;
}

export interface ScanListPagesRangeOptions {
  /** 0-based offset；为保持 Wikidot 的 index/total 交叉校验，必须是 limit 的整数倍。 */
  offset: number;
  /** 有界演练硬上限由 CLI 收窄到 150；底层仍遵守 Wikidot 的 250 上限。 */
  limit: number;
  logger?: Logger;
}

export interface ScanUpdatedListPagesOptions {
  /** 服务端相对时间窗口；正式默认 2 小时，即 30 分钟周期的 4 倍重叠。 */
  windowHours: number;
  /** 成本硬上限。常态 70 页只需 1 批；突发时最多取 3 批，剩余留给重叠窗口追平。 */
  maxBatches?: number;
  concurrency?: number;
  logger?: Logger;
}

export interface ListPagesSnapshot {
  version: number;
  updatedAt: string;
  remoteTotal: number;
  /** fullname 只是 ListPages 的发现键，不被当作 ingest.page 身份键。 */
  rows: Record<string, ListPageRecord>;
}

export interface ListPagesDiffRow {
  current: ListPageRecord;
  previous: ListPageRecord;
  votesChanged: boolean;
  revisionsChanged: boolean;
  forumChanged: boolean;
  tagsChanged: boolean;
  parentChanged: boolean;
}

export interface ListPagesDiff {
  bootstrap: boolean;
  newFullnames: string[];
  changed: ListPagesDiffRow[];
  unchanged: number;
}

export interface ListPagesTrigger {
  fullname: string;
  kind: 'meta' | 'votes_full' | 'revisions_full' | 'forum';
  reason: string;
  priority: number;
}

/**
 * `%%%%name%%%%` 是规格要求的“双百分号”写法：ListPages 替换后保留一层
 * `%%value%%` 作为字段边界。字段间使用规格指定的 `|||`。
 */
export function buildListPagesModuleBody(): string {
  const fields = LISTPAGES_SELECTORS.map((name) => `%%%%${name}%%%%`).join(FIELD_SEPARATOR);
  // 换行不可删：wikidot 的 wiki 解析器需要它来正确闭合 [[div]]。
  return `[[div class="${ROW_CLASS}"]]\n${fields}\n[[/div]]`;
}

export function buildListPagesRequest(batchNo: number, perPage = LISTPAGES_PER_PAGE): {
  moduleName: string;
  params: Record<string, string | number>;
} {
  if (!Number.isInteger(batchNo) || batchNo <= 0) {
    throw new RangeError(`ListPages batchNo 必须是正整数，收到 ${batchNo}`);
  }
  if (!Number.isInteger(perPage) || perPage <= 0 || perPage > LISTPAGES_PER_PAGE) {
    throw new RangeError(`ListPages perPage 必须在 1..${LISTPAGES_PER_PAGE}，收到 ${perPage}`);
  }
  return {
    moduleName: 'list/ListPagesModule',
    params: {
      category: '*',
      order: 'created_at desc',
      perPage,
      offset: (batchNo - 1) * perPage,
      module_body: buildListPagesModuleBody(),
    },
  };
}

export function buildUpdatedListPagesRequest(
  batchNo: number,
  windowHours: number,
  perPage = LISTPAGES_PER_PAGE,
): {
  moduleName: string;
  params: Record<string, string | number>;
} {
  if (!Number.isInteger(windowHours) || windowHours < 1 || windowHours > 168) {
    throw new RangeError(`L0 windowHours 必须是 1..168 的整数，收到 ${windowHours}`);
  }
  const request = buildListPagesRequest(batchNo, perPage);
  return {
    ...request,
    params: {
      ...request.params,
      order: 'updated_at desc',
      // 已实测为服务端过滤，%%total%% 与返回条数完全吻合；绝不是客户端裁剪。
      updated_at: `last ${windowHours} hours`,
    },
  };
}

/**
 * 解析单批响应。所有预期中的解析故障都返回 `status:'failed'|'partial'`，不以空数组表达。
 * 合法空结果只有在响应结构与 pager 均完整且确实没有 row marker 时才返回 ok + rows=[]。
 */
export function parseListPagesResponse(
  body: string,
  batchNo: number,
  amcAttempts = 1,
  perPage = LISTPAGES_PER_PAGE,
  options: { allowEmptyWithoutPager?: boolean } = {},
): ListPagesBatchOutcome {
  const diagnostics: ListPagesBatchDiagnostics = {
    candidateRows: 0,
    parsedRows: 0,
    droppedFieldCountRows: 0,
    droppedParseRows: 0,
    rejectedFiveStarRows: 0,
    selectorLiteralFields: 0,
    parseDropRate: 0,
    errors: [],
  };

  if (body.trim() === '') {
    return { status: 'failed', error: 'ListPages body 为空；扫描失败不能解释为 0 页', diagnostics };
  }

  let pager = parsePager(body);
  // offset 翻页的实测响应里 pager-no 仍可能写 page 1；真正的跨批位置由 %%index%%
  // 校验。规格也只把 pager 用作总页数来源，不能反过来拿这个展示页码否决 offset。

  const rowBlocks = extractRowBlocks(body);
  diagnostics.candidateRows = countRowMarkers(body);
  if (diagnostics.candidateRows !== rowBlocks.length) {
    diagnostics.errors.push(
      `row marker=${diagnostics.candidateRows}，成功提取 div=${rowBlocks.length}；HTML 结构可能被截断/嵌套`,
    );
    diagnostics.droppedParseRows += diagnostics.candidateRows - rowBlocks.length;
  }

  const rows: ListPageRecord[] = [];
  for (let rowNo = 0; rowNo < rowBlocks.length; rowNo++) {
    const raw = rowBlocks[rowNo]!;
    const rawParts = raw.split(FIELD_SEPARATOR);
    if (rawParts.length !== LISTPAGES_SELECTORS.length) {
      diagnostics.droppedFieldCountRows++;
      diagnostics.errors.push(
        `第 ${rowNo + 1} 行字段数 ${rawParts.length} ≠ ${LISTPAGES_SELECTORS.length}`,
      );
      continue;
    }

    let fields: Record<ListPagesSelector, ParsedField>;
    try {
      fields = parseDelimitedFields(rawParts);
    } catch (err) {
      diagnostics.droppedParseRows++;
      diagnostics.errors.push(`第 ${rowNo + 1} 行字段定界失败：${String(err)}`);
      continue;
    }

    const residues = LISTPAGES_SELECTORS.filter((selector) => {
      const value = fields[selector].text;
      if (!SELECTOR_LITERAL_RE.test(value)) return false;
      // 直调 AMC 时双百分号日期的实测形状是 `%%%%date|epoch%%%%`：
      // 去掉外层边界后为 `%%date|epoch%%`。它是已替换日期，不是 selector 残留。
      return !(DATE_SELECTORS.has(selector) && RAW_DATE_RE.test(value));
    });
    if (residues.length > 0) {
      diagnostics.selectorLiteralFields += residues.length;
      diagnostics.errors.push(
        `第 ${rowNo + 1} 行 selector 字面量残留：${residues.join(', ')}`,
      );
      diagnostics.parseDropRate = dropRate(diagnostics);
      return {
        status: 'failed',
        error: `检测到 ${residues.length} 个 selector 字面量残留，整批拒绝，不做 diff`,
        diagnostics,
      };
    }

    try {
      rows.push(parseRecord(fields, (batchNo - 1) * perPage));
    } catch (err) {
      if (err instanceof FiveStarRatingError) {
        diagnostics.rejectedFiveStarRows++;
      } else {
        diagnostics.droppedParseRows++;
      }
      diagnostics.errors.push(`第 ${rowNo + 1} 行拒绝：${String(err)}`);
    }
  }

  diagnostics.parsedRows = rows.length;
  diagnostics.parseDropRate = dropRate(diagnostics);
  if (diagnostics.parseDropRate > LISTPAGES_PARSE_DROP_LIMIT) {
    return {
      status: 'failed',
      error:
        `ListPages 丢行率 ${(diagnostics.parseDropRate * 100).toFixed(3)}% > ` +
        `${LISTPAGES_PARSE_DROP_LIMIT * 100}%：整批失败`,
      diagnostics,
    };
  }

  // Wikidot 的 offset 末批有时省略整个 pager，但每一行仍带独立 %%total%% 与
  // %%index%%。只有成功解析出至少一行、且规范化 total 全部一致时，才允许从该
  // 独立字段恢复总批数；WAF/空体仍是 rows=0，因此绝不会被误判成合法空页。
  if (pager === null) {
    if (
      rows.length === 0 &&
      options.allowEmptyWithoutPager === true &&
      /\blist-pages-box\b/i.test(body)
    ) {
      // updated_at 服务端过滤合法命中 0 页时可能省略 pager。只有 AMC status=ok、
      // 结构化 list-pages-box 存在且零 row marker 才放行；WAF HTML 仍会失败。
      pager = { currentPage: 1, totalPages: 1, source: 'row-total' };
    }
  }
  if (pager === null) {
    const totals = new Set(rows.map((row) => row.total));
    const total = totals.size === 1 ? rows[0]?.total : undefined;
    if (total === undefined) {
      return {
        status: 'failed',
        error:
          'ListPages pager 解析失败，且没有一致的逐行 %%total%% 可恢复总批数；' +
          '禁止默认 totalPages=1。',
        diagnostics,
      };
    }
    pager = {
      currentPage: batchNo,
      totalPages: Math.ceil(total / perPage),
      source: 'row-total',
    };
  }

  const data: ListPagesBatchData = { batchNo, pager, rows, diagnostics, amcAttempts };
  const dropped =
    diagnostics.droppedFieldCountRows +
    diagnostics.droppedParseRows +
    diagnostics.rejectedFiveStarRows;
  if (dropped > 0) {
    return {
      status: 'partial',
      data,
      error: `本批拒绝 ${dropped} 行；整轮必须由 index 连续性继续判定，禁止当完整基线`,
    };
  }
  return { status: 'ok', data };
}

async function fetchUpdatedListPagesBatch(
  http: HttpClient,
  baseUrl: string,
  batchNo: number,
  windowHours: number,
  perPage = LISTPAGES_PER_PAGE,
  log: Logger = createLogger('listpages:l0'),
): Promise<ListPagesBatchOutcome> {
  const request = buildUpdatedListPagesRequest(batchNo, windowHours, perPage);
  let lastError = '';
  for (let amcAttempt = 1; amcAttempt <= 3; amcAttempt++) {
    try {
      const response = await amcRequest(http, baseUrl, {
        moduleName: request.moduleName,
        params: request.params,
        mode: `listpages:l0:${batchNo}`,
        maxAttempts: 3,
      });
      if (response.status === 'ok') {
        if (response.body === null) {
          return { status: 'failed', error: `L0 第 ${batchNo} 批 AMC status=ok 但 body=null` };
        }
        return parseListPagesResponse(response.body, batchNo, amcAttempt, perPage, {
          allowEmptyWithoutPager: true,
        });
      }
      lastError = `AMC status=${response.status}, message=${response.message ?? '-'}`;
      if (response.status !== 'try_again' || amcAttempt === 3) {
        return { status: 'failed', error: `L0 第 ${batchNo} 批 ${lastError}` };
      }
      await abortableSleep(
        500 * 2 ** (amcAttempt - 1) + Math.floor(Math.random() * 100),
        http.signal,
      );
    } catch (err) {
      throwIfRuntimeBudgetExceeded(err);
      if (
        err instanceof CircuitOpenError ||
        err instanceof HeaderContractError ||
        (err instanceof HttpStatusError && (err.status === 503 || err.status === 429))
      ) {
        return { status: 'failed', error: `L0 第 ${batchNo} 批请求失败：${String(err)}` };
      }
      lastError = String(err);
      if (amcAttempt === 3) {
        return { status: 'failed', error: `L0 第 ${batchNo} 批重试耗尽：${lastError}` };
      }
      log.warn('L0 ListPages 批请求失败，外层退避', {
        batchNo,
        amcAttempt,
        error: lastError,
      });
      await abortableSleep(
        500 * 2 ** (amcAttempt - 1) + Math.floor(Math.random() * 100),
        http.signal,
      );
    }
  }
  return { status: 'failed', error: `L0 第 ${batchNo} 批重试耗尽：${lastError}` };
}

/** 抓一个批次；AMC status=try_again 才做外层退避，其它非 ok 状态不重试。 */
export async function fetchListPagesBatch(
  http: HttpClient,
  baseUrl: string,
  batchNo: number,
  perPage = LISTPAGES_PER_PAGE,
  log: Logger = createLogger('listpages'),
): Promise<ListPagesBatchOutcome> {
  const request = buildListPagesRequest(batchNo, perPage);
  let lastError = '';
  for (let amcAttempt = 1; amcAttempt <= 3; amcAttempt++) {
    try {
      const response = await amcRequest(http, baseUrl, {
        moduleName: request.moduleName,
        params: request.params,
        mode: `listpages:tier1:${batchNo}`,
        // HTTP 层对传输/500 做至少三次尝试；503/429 仍由 client.ts 保持零重试。
        maxAttempts: 3,
      });
      if (response.status === 'ok') {
        if (response.body === null) {
          return { status: 'failed', error: `第 ${batchNo} 批 AMC status=ok 但 body=null` };
        }
        return parseListPagesResponse(response.body, batchNo, amcAttempt, perPage);
      }
      lastError = `AMC status=${response.status}, message=${response.message ?? '-'}`;
      if (response.status !== 'try_again' || amcAttempt === 3) {
        return { status: 'failed', error: `第 ${batchNo} 批 ${lastError}` };
      }
      const waitMs = 500 * 2 ** (amcAttempt - 1) + Math.floor(Math.random() * 100);
      log.warn('ListPages 返回 try_again，批级退避重试', { batchNo, amcAttempt, waitMs });
      await abortableSleep(waitMs, http.signal);
    } catch (err) {
      throwIfRuntimeBudgetExceeded(err);
      // 503/429 与断路器必须立即停手；头契约错误也是配置错误，重试无意义。
      if (
        err instanceof CircuitOpenError ||
        err instanceof HeaderContractError ||
        (err instanceof HttpStatusError && (err.status === 503 || err.status === 429))
      ) {
        return { status: 'failed', error: `第 ${batchNo} 批请求失败：${String(err)}` };
      }
      lastError = String(err);
      if (amcAttempt === 3) {
        return { status: 'failed', error: `第 ${batchNo} 批 3 次外层尝试耗尽：${lastError}` };
      }
      // `/p/N` 偶发 Cloudflare 403 与连接池传输抖动在批级重建请求；三次都耗尽才让 run failed。
      const waitMs = 500 * 2 ** (amcAttempt - 1) + Math.floor(Math.random() * 100);
      log.warn('ListPages 批请求失败，外层退避重试', {
        batchNo,
        amcAttempt,
        waitMs,
        error: lastError,
      });
      await abortableSleep(waitMs, http.signal);
    }
  }
  return { status: 'failed', error: `第 ${batchNo} 批重试耗尽：${lastError}` };
}

/**
 * 全站扫描。先取第 1 批获得 pager，再受限并发抓其余批。
 * 返回 Map 中保留每个远端批号；小样本未请求的批也显式标 partial/intentionalOmission。
 */
export async function scanListPages(
  http: HttpClient,
  baseUrl: string,
  opts: ScanListPagesOptions = {},
): Promise<ListPagesRunResult> {
  const log = opts.logger ?? createLogger('listpages');
  const perPage = opts.perPage ?? LISTPAGES_PER_PAGE;
  const concurrency = Math.max(1, Math.min(opts.concurrency ?? 5, 5));
  const batches = new Map<number, ListPagesBatchOutcome>();

  if (opts.shouldStop?.() === true) {
    return finalizeListPagesRun(batches, null, 0, perPage);
  }
  const first = await fetchListPagesBatch(http, baseUrl, 1, perPage, log);
  batches.set(1, first);
  const firstData = outcomeData(first);
  if (firstData === null) {
    return finalizeListPagesRun(batches, null, 1, perPage);
  }

  const expectedBatches = firstData.pager.totalPages;
  const requestedBatches = Math.max(
    1,
    Math.min(expectedBatches, opts.maxBatches ?? expectedBatches),
  );
  const targets = Array.from({ length: Math.max(0, requestedBatches - 1) }, (_, i) => i + 2);
  await mapLimited(targets, concurrency, async (batchNo) => {
    const outcome = await fetchListPagesBatch(http, baseUrl, batchNo, perPage, log);
    batches.set(batchNo, outcome);
  }, opts.shouldStop);

  for (let batchNo = requestedBatches + 1; batchNo <= expectedBatches; batchNo++) {
    batches.set(batchNo, {
      status: 'partial',
      error: `小样本上限只请求前 ${requestedBatches} 批，本批未请求`,
      intentionalOmission: true,
    });
  }

  return finalizeListPagesRun(
    batches,
    expectedBatches,
    Math.min(requestedBatches, batches.size),
    perPage,
  );
}

/**
 * 只抓一个显式 offset/limit 范围，并把“该范围完整”与“全站完整”分开表达。
 *
 * 这不是 `--max-batches` 的换名：后者是诊断用残缺全站 run，禁止 apply；本入口把
 * mode 交给 CLI 标成 tier1_range，coverage_ratio 仍按全站 remote_total 计算，因此
 * 永远不能给删除推断提供完整性授权，但可以安全地做 ≤150 页冷启动演练。
 */
export async function scanListPagesRange(
  http: HttpClient,
  baseUrl: string,
  opts: ScanListPagesRangeOptions,
): Promise<ListPagesRunResult> {
  if (
    !Number.isInteger(opts.limit) ||
    opts.limit < 1 ||
    opts.limit > LISTPAGES_PER_PAGE
  ) {
    throw new RangeError(`range limit 必须在 1..${LISTPAGES_PER_PAGE}，收到 ${opts.limit}`);
  }
  if (
    !Number.isInteger(opts.offset) ||
    opts.offset < 0 ||
    opts.offset % opts.limit !== 0
  ) {
    throw new RangeError(
      `range offset 必须是非负且能被 limit 整除，收到 offset=${opts.offset}, limit=${opts.limit}`,
    );
  }
  const batchNo = opts.offset / opts.limit + 1;
  const outcome = await fetchListPagesBatch(
    http,
    baseUrl,
    batchNo,
    opts.limit,
    opts.logger,
  );
  const batches = new Map<number, ListPagesBatchOutcome>([[batchNo, outcome]]);
  const base = finalizeListPagesRun(batches, null, 1, opts.limit);
  const data = outcomeData(outcome);
  if (data === null) {
    return {
      ...base,
      status: 'failed',
      requestedBatches: 1,
      batchesFailed: 1,
    };
  }

  const rows = data.rows;
  const remoteTotal = rows[0]?.total ?? null;
  const expectedRows =
    remoteTotal === null
      ? null
      : Math.min(opts.limit, Math.max(0, remoteTotal - opts.offset));
  const indices = rows.map((row) => row.index);
  let indexContinuous =
    indices.length > 0 &&
    indices[0] === opts.offset + 1;
  for (let i = 1; i < indices.length; i++) {
    if (indices[i] !== indices[i - 1]! + 1) indexContinuous = false;
  }
  const duplicateIndexes = indices.length - new Set(indices).size;
  const duplicateFullnames =
    rows.length - new Set(rows.map((row) => row.fullname)).size;
  if (duplicateIndexes > 0 || duplicateFullnames > 0) indexContinuous = false;
  const rangeComplete = expectedRows !== null && rows.length === expectedRows;
  const pagerMatchesRemoteTotal =
    remoteTotal !== null &&
    data.pager.totalPages === Math.ceil(remoteTotal / opts.limit);
  const reasons: string[] = [];
  if (!base.validation.selectorLiteralFree) reasons.push('selector 字面量残留');
  if (!base.validation.parseDropWithinLimit) reasons.push('范围内丢行率超限');
  if (!indexContinuous) reasons.push('范围内 index 不连续、重叠或有空洞');
  if (!rangeComplete) {
    reasons.push(`范围行数 ${rows.length} ≠ 期望 ${expectedRows ?? 'unknown'}`);
  }
  if (!base.validation.fiveStarAbsent) reasons.push('范围内出现五星评分');
  if (!base.validation.totalStable) reasons.push('范围内 total 漂移');
  if (!pagerMatchesRemoteTotal) reasons.push('pager 与全站 total/perPage 不一致');
  if (outcome.status === 'partial') reasons.push(outcome.error);

  const criticalFailure =
    !base.validation.selectorLiteralFree ||
    !base.validation.parseDropWithinLimit ||
    !pagerMatchesRemoteTotal;
  const status: ListPagesRunResult['status'] =
    outcome.status === 'failed' || criticalFailure
      ? 'failed'
      : outcome.status === 'partial' ||
          !indexContinuous ||
          !rangeComplete ||
          !base.validation.fiveStarAbsent ||
          !base.validation.totalStable
        ? 'partial'
        : 'ok';
  return {
    ...base,
    status,
    rows,
    remoteTotal,
    expectedBatches:
      remoteTotal === null ? null : Math.ceil(remoteTotal / opts.limit),
    requestedBatches: 1,
    batchesFailed: outcome.status === 'failed' ? 1 : 0,
    pagesEnumerated: rows.length,
    validation: {
      ...base.validation,
      indexContinuous,
      pagerMatchesRemoteTotal,
      duplicateFullnames,
      duplicateIndexes,
      expectedLastIndex:
        expectedRows === null ? null : opts.offset + expectedRows,
      observedLastIndex: indices.at(-1) ?? null,
      reasons,
    },
  };
}

/**
 * L0 真增量：唯一边界是服务端 updated_at 相对时间过滤。
 *
 * 禁止任何“翻到 lastmod 阈值就停”的客户端早停；排序不是 lastmod 降序。超过三批时
 * 本轮显式 partial，但已取到的正向观测仍可留证，下一轮重叠窗口会继续追平。
 */
export async function scanUpdatedListPages(
  http: HttpClient,
  baseUrl: string,
  opts: ScanUpdatedListPagesOptions,
): Promise<ListPagesRunResult> {
  const log = opts.logger ?? createLogger('listpages:l0');
  const concurrency = Math.max(1, Math.min(opts.concurrency ?? 3, 3));
  const cap = Math.max(1, Math.min(opts.maxBatches ?? 3, 3));
  const batches = new Map<number, ListPagesBatchOutcome>();

  const first = await fetchUpdatedListPagesBatch(
    http,
    baseUrl,
    1,
    opts.windowHours,
    LISTPAGES_PER_PAGE,
    log,
  );
  batches.set(1, first);
  const firstData = outcomeData(first);
  if (firstData === null) return finalizeListPagesRun(batches, null, 1, LISTPAGES_PER_PAGE);

  const expectedBatches = firstData.pager.totalPages;
  const requestedBatches = Math.min(expectedBatches, cap);
  const targets = Array.from({ length: Math.max(0, requestedBatches - 1) }, (_, i) => i + 2);
  await mapLimited(targets, concurrency, async (batchNo) => {
    batches.set(
      batchNo,
      await fetchUpdatedListPagesBatch(
        http,
        baseUrl,
        batchNo,
        opts.windowHours,
        LISTPAGES_PER_PAGE,
        log,
      ),
    );
  });
  for (let batchNo = requestedBatches + 1; batchNo <= expectedBatches; batchNo++) {
    batches.set(batchNo, {
      status: 'partial',
      error:
        `L0 成本上限为 ${cap} 批；本批留给下轮 ${opts.windowHours}h 重叠窗口追平`,
      intentionalOmission: true,
    });
  }
  return finalizeListPagesRun(
    batches,
    expectedBatches,
    requestedBatches,
    LISTPAGES_PER_PAGE,
  );
}

/** 从一次完整、成功的 run 构造本地快照。 */
export function createListPagesSnapshot(
  rows: readonly ListPageRecord[],
  remoteTotal: number,
  updatedAt: string,
): ListPagesSnapshot {
  const byFullname: Record<string, ListPageRecord> = {};
  for (const row of rows) byFullname[row.fullname] = row;
  return {
    version: LISTPAGES_SNAPSHOT_VERSION,
    updatedAt,
    remoteTotal,
    rows: byFullname,
  };
}

/** 损坏/版本不符返回 null；调用方按 bootstrap 处理，绝不把损坏快照当空站点。 */
export function readListPagesSnapshot(file: string): ListPagesSnapshot | null {
  if (!fs.existsSync(file)) return null;
  try {
    const raw = gunzipSync(fs.readFileSync(file)).toString('utf-8');
    const parsed = JSON.parse(raw) as ListPagesSnapshot;
    if (
      parsed.version !== LISTPAGES_SNAPSHOT_VERSION ||
      typeof parsed.rows !== 'object' ||
      parsed.rows === null ||
      !Number.isInteger(parsed.remoteTotal)
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/** gzip + 同目录原子 rename，避免 SIGKILL 留下半个 JSON。 */
export function writeListPagesSnapshot(file: string, snapshot: ListPagesSnapshot): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, gzipSync(Buffer.from(JSON.stringify(snapshot), 'utf-8')));
  fs.renameSync(tmp, file);
}

export function diffListPages(
  rows: readonly ListPageRecord[],
  previous: ListPagesSnapshot | null,
): ListPagesDiff {
  if (previous === null) {
    return {
      bootstrap: true,
      newFullnames: rows.map((row) => row.fullname),
      changed: [],
      unchanged: 0,
    };
  }

  const newFullnames: string[] = [];
  const changed: ListPagesDiffRow[] = [];
  let unchanged = 0;
  for (const current of rows) {
    const prev = previous.rows[current.fullname];
    if (prev === undefined) {
      newFullnames.push(current.fullname);
      continue;
    }
    const row: ListPagesDiffRow = {
      current,
      previous: prev,
      votesChanged: current.rating !== prev.rating || current.ratingVotes !== prev.ratingVotes,
      revisionsChanged: current.revisions !== prev.revisions || current.size !== prev.size,
      forumChanged: current.comments !== prev.comments || current.commentedAt !== prev.commentedAt,
      // 必须是集合比较，不能逐下标比较；排序只用于稳定落库，不参与语义。
      tagsChanged:
        !sameStringSet(current.tags, prev.tags) ||
        !sameStringSet(current.hiddenTags, prev.hiddenTags),
      parentChanged: current.parentFullname !== prev.parentFullname,
    };
    if (
      row.votesChanged ||
      row.revisionsChanged ||
      row.forumChanged ||
      row.tagsChanged ||
      row.parentChanged
    ) {
      changed.push(row);
    } else {
      unchanged++;
    }
  }
  return { bootstrap: false, newFullnames, changed, unchanged };
}

/**
 * §3.5 的触发矩阵。这里只生成以 fullname 为键的纯信号，CLI 在确认内部 page_id 后
 * 才能写 scan_task；无法解析身份的新 fullname 由 pending_page 接住，绝不伪造 page_id。
 */
export function deriveListPagesTriggers(
  diff: ListPagesDiff,
  rows: readonly ListPageRecord[],
): ListPagesTrigger[] {
  const triggers: ListPagesTrigger[] = [];
  const add = (
    fullname: string,
    kind: ListPagesTrigger['kind'],
    reason: string,
    priority: number,
  ): void => {
    // 同页同 kind 的多个 reason 故意都保留；CLI 的幂等 upsert 会合并 reasons，
    // 但绝不覆盖 attempts/stable_count 等执行侧状态。
    triggers.push({ fullname, kind, reason, priority });
  };

  // 没有基线的首轮只建立快照，不能把全站现存页面误报成“新页”。
  if (!diff.bootstrap) {
    for (const fullname of diff.newFullnames) {
      add(fullname, 'meta', 'listpages_new_fullname', 20);
    }
    for (const changed of diff.changed) {
      const fullname = changed.current.fullname;
      if (changed.votesChanged) {
        add(fullname, 'votes_full', 'listpages_rating_or_votes_changed', 10);
      }
      if (changed.revisionsChanged) {
        add(fullname, 'revisions_full', 'listpages_revisions_or_size_changed', 8);
      }
      if (changed.forumChanged) {
        add(fullname, 'forum', 'listpages_comments_or_commented_at_changed', 7);
      }
      // tags/_tags/parent 只由本轮 apply_page_meta 处理，不额外入队。
    }
  }

  // 已注销创建者的补偿只在 bootstrap 或该页本轮确有 new/change 信号时入队。
  // 若每轮对全站所有 deleted creator 都入队，hourly Tier1 会固定制造约 1.8k 个
  // 无变化任务，正好把短进程调度重新变成隐形常驻流量。
  const compensationDue = diff.bootstrap
    ? new Set(rows.map((row) => row.fullname))
    : new Set([
        ...diff.newFullnames,
        ...diff.changed.map((changed) => changed.current.fullname),
      ]);
  for (const row of rows) {
    if (
      compensationDue.has(row.fullname) &&
      row.createdById === null &&
      row.createdByUnix === null
    ) {
      add(row.fullname, 'meta', 'listpages_deleted_creator_needs_compensation', 20);
    }
  }
  return triggers;
}

/** page_scan.result_hash：稳定字段顺序，供 stable_count 收敛使用。 */
export function listPagesResultHash(row: ListPageRecord): Buffer {
  return createHash('sha256')
    .update(
      JSON.stringify({
        fullname: row.fullname,
        title: row.title,
        tags: row.tags,
        hiddenTags: row.hiddenTags,
        parentFullname: row.parentFullname,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        commentedAt: row.commentedAt,
        rating: row.rating,
        ratingVotes: row.ratingVotes,
        comments: row.comments,
        size: row.size,
        revisions: row.revisions,
      }),
      'utf-8',
    )
    .digest();
}

// ─── 解析内部实现 ────────────────────────────────────────────────────────────

interface ParsedField {
  text: string;
  rawHtml: string;
  unwrappedFixedPoint?: boolean;
}

class FiveStarRatingError extends Error {
  override readonly name = 'FiveStarRatingError';
}

function parseDelimitedFields(parts: readonly string[]): Record<ListPagesSelector, ParsedField> {
  const out = {} as Record<ListPagesSelector, ParsedField>;
  for (let i = 0; i < LISTPAGES_SELECTORS.length; i++) {
    const selector = LISTPAGES_SELECTORS[i]!;
    const rawHtml = parts[i]!;
    const textWithBoundary = htmlToText(rawHtml).trim();
    const match = /^%%([\s\S]*)%%$/.exec(textWithBoundary);
    if (match === null) {
      // 若真实值本身等于 selector 名（生产实例：fullname="name"），Wikidot 会把
      // `%%%%fullname%%%%` 先展开成 `%%name%%`，再把它当 selector 二次展开成
      // 无边界的 `name`。只放行这个有限固定点集合；任意其它无边界值仍拒绝。
      if ((LISTPAGES_SELECTORS as readonly string[]).includes(textWithBoundary)) {
        out[selector] = { text: textWithBoundary, rawHtml, unwrappedFixedPoint: true };
        continue;
      }
      // `name` 的真实值还可能命中 Wikidot 未列入本采集字段的 selector（生产实例
      // name="forum"）。仅允许 slug 安全字节，并在 parseRecord 中用 fullname 的
      // 最后一个 category 分段反向证明，不能把任意无边界字符串放进来。
      if (selector === 'name' && /^[a-z0-9_:-]+$/i.test(textWithBoundary)) {
        out[selector] = { text: textWithBoundary, rawHtml, unwrappedFixedPoint: true };
        continue;
      }
      throw new Error(`${selector} 缺少外层 %%...%% 定界：${textWithBoundary.slice(0, 80)}`);
    }
    out[selector] = { text: match[1] ?? '', rawHtml };
  }
  return out;
}

function parseRecord(
  fields: Record<ListPagesSelector, ParsedField>,
  totalOffset: number,
): ListPageRecord {
  const fullname = requiredText(fields.fullname.text, 'fullname');
  const category = requiredText(fields.category.text, 'category');
  let name = requiredText(fields.name.text, 'name');
  if (fields.name.unwrappedFixedPoint) {
    const expectedName = fullname.includes(':')
      ? fullname.slice(fullname.lastIndexOf(':') + 1)
      : fullname;
    // 二次展开后的字节可能已经变成另一个 selector 的值（生产实例
    // fullname=forum:category 时原 name=category，二次展开却得到 forum）。
    // fullname 是独立字段且保留完整 category:name，因此从它恢复原 name。
    name = expectedName;
  }
  const title = fields.title.text.trim();
  const tags = parseTags(fields.tags.text);
  const hiddenTags = parseTags(fields._tags.text);
  const ratingText = requiredText(fields.rating.text, 'rating');
  const parsedInt = Number.parseInt(ratingText, 10);
  const parsedFloat = Number.parseFloat(ratingText);
  if (
    ratingText.includes('.') ||
    !Number.isFinite(parsedInt) ||
    !Number.isFinite(parsedFloat) ||
    parsedInt !== parsedFloat
  ) {
    throw new FiveStarRatingError(
      `五星评分运行时断言失败：rating=${JSON.stringify(ratingText)}，整页拒绝`,
    );
  }

  return {
    fullname,
    category,
    name,
    title,
    tags,
    hiddenTags,
    mergedTags: sortedUnique([...tags, ...hiddenTags]),
    parentFullname: nullableText(fields.parent_fullname.text),
    createdAt: parseDateField(fields.created_at, 'created_at', false)!,
    createdBy: nullableText(fields.created_by.text),
    createdById: parseOptionalPositiveInt(fields.created_by_id.text, 'created_by_id'),
    createdByUnix: nullableText(fields.created_by_unix.text),
    updatedAt: parseDateField(fields.updated_at, 'updated_at', true),
    commentedAt: parseDateField(fields.commented_at, 'commented_at', true),
    rating: parsedInt,
    ratingVotes: parseNonNegativeInt(fields.rating_votes.text, 'rating_votes'),
    comments: parseNonNegativeInt(fields.comments.text, 'comments'),
    size: parseNonNegativeInt(fields.size.text, 'size'),
    revisions: parseNonNegativeInt(fields.revisions.text, 'revisions'),
    // 2026-07-27 实测：offset=250 的第 2 批原始 %%total%%=35923，而首批为
    // 36173，恰好相差 offset；即该 selector 在 offset 模式下返回“剩余条数”。
    // 加回 offset 后才是规格 §3.4 要比较的过滤条件全量。原始字段仍经过严格整数校验。
    total: parsePositiveInt(fields.total.text, 'total') + totalOffset,
    index: parsePositiveInt(fields.index.text, 'index'),
  };
}

function parseDateField(
  field: ParsedField,
  selector: string,
  nullable: boolean,
): string | null {
  if (field.text.trim() === '') {
    if (nullable) return null;
    throw new Error(`${selector} 为空`);
  }
  const classMatch = /\btime_(\d+)\b/.exec(field.rawHtml);
  const rawMatch = RAW_DATE_RE.exec(field.text.trim());
  const epochText = classMatch?.[1] ?? rawMatch?.[1];
  if (epochText === undefined) {
    throw new Error(`${selector} 找不到 span.odate time_<epoch> 或 %%date|<epoch>%%`);
  }
  const epoch = Number(epochText);
  if (!Number.isSafeInteger(epoch) || epoch <= 0) throw new Error(`${selector} epoch 非法：${epochText}`);
  return new Date(epoch * 1000).toISOString();
}

function parsePager(body: string): ListPagesPager | null {
  const pagerNo = /<span\b[^>]*class=(?:"[^"]*\bpager-no\b[^"]*"|'[^']*\bpager-no\b[^']*')[^>]*>([\s\S]*?)<\/span>/i.exec(
    body,
  );
  if (pagerNo) {
    const text = htmlToText(pagerNo[1] ?? '');
    const m = /\bpage\s+(\d+)\s+of\s+(\d+)\b/i.exec(text);
    if (m) {
      const currentPage = Number(m[1]);
      const totalPages = Number(m[2]);
      if (currentPage > 0 && totalPages >= currentPage) {
        return { currentPage, totalPages, source: 'pager-no' };
      }
    }
  }

  const currentMatch = /<span\b[^>]*class=(?:"[^"]*\bcurrent\b[^"]*"|'[^']*\bcurrent\b[^']*')[^>]*>([\s\S]*?)<\/span>/i.exec(
    body,
  );
  const currentPage = currentMatch ? Number.parseInt(htmlToText(currentMatch[1] ?? ''), 10) : NaN;
  const targets = [
    ...body.matchAll(
      /<span\b[^>]*class=(?:"[^"]*\btarget\b[^"]*"|'[^']*\btarget\b[^']*')[^>]*>[\s\S]*?<a\b[^>]*href=(?:"[^"]*\/p\/(\d+)[^"]*"|'[^']*\/p\/(\d+)[^']*')[^>]*>/gi,
    ),
  ];
  const pages = targets
    .map((m) => Number(m[1] ?? m[2]))
    .filter((n) => Number.isSafeInteger(n) && n > 0);
  if (!Number.isSafeInteger(currentPage) || currentPage <= 0 || pages.length === 0) return null;
  return { currentPage, totalPages: Math.max(currentPage, ...pages), source: 'target-links' };
}

function extractRowBlocks(body: string): string[] {
  const out: string[] = [];
  // 不能用 `<div...>(.*?)</div>` 一把扫：响应外层还有 list-pages-box，正则会先吞掉
  // 外层开标签到第一条 row 的闭标签，导致所有内层 row 都被跳过。这里先逐个找开标签，
  // 只对命中专用 class 的开标签找它后面的第一个闭标签；row 内字段只有 span/p，无 div。
  const divRe = /<div\b([^>]*)>/gi;
  let match: RegExpExecArray | null;
  while ((match = divRe.exec(body)) !== null) {
    const attrs = match[1] ?? '';
    const classMatch = /\bclass\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attrs);
    const classes = (classMatch?.[1] ?? classMatch?.[2] ?? '').split(/\s+/);
    if (!classes.includes(ROW_CLASS)) continue;
    const closeRe = /<\/div\s*>/gi;
    closeRe.lastIndex = divRe.lastIndex;
    const close = closeRe.exec(body);
    if (close !== null) out.push(body.slice(divRe.lastIndex, close.index));
  }
  return out;
}

function countRowMarkers(body: string): number {
  return [...body.matchAll(new RegExp(`\\b${ROW_CLASS}\\b`, 'g'))].length;
}

function htmlToText(html: string): string {
  return decodeXmlEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<[^>]+>/g, ''),
  );
}

function dropRate(d: ListPagesBatchDiagnostics): number {
  if (d.candidateRows === 0) return 0;
  const dropped = d.droppedFieldCountRows + d.droppedParseRows + d.rejectedFiveStarRows;
  return dropped / d.candidateRows;
}

function requiredText(value: string, label: string): string {
  const v = value.trim();
  if (v === '') throw new Error(`${label} 为空`);
  return v;
}

function nullableText(value: string): string | null {
  const v = value.trim();
  return v === '' ? null : v;
}

function parseTags(value: string): string[] {
  return sortedUnique(value.split(/\s+/).map((v) => v.trim()).filter(Boolean));
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function parseOptionalPositiveInt(value: string, label: string): number | null {
  if (value.trim() === '') return null;
  return parsePositiveInt(value, label);
}

function parsePositiveInt(value: string, label: string): number {
  const n = parseInteger(value, label);
  if (n <= 0) throw new Error(`${label} 必须 > 0，收到 ${value}`);
  return n;
}

function parseNonNegativeInt(value: string, label: string): number {
  const n = parseInteger(value, label);
  if (n < 0) throw new Error(`${label} 必须 >= 0，收到 ${value}`);
  return n;
}

function parseInteger(value: string, label: string): number {
  const v = value.trim();
  if (!/^[+-]?\d+$/.test(v)) throw new Error(`${label} 不是十进制整数：${JSON.stringify(value)}`);
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw new Error(`${label} 超出安全整数范围：${value}`);
  return n;
}

function sameStringSet(a: readonly string[], b: readonly string[]): boolean {
  const aa = new Set(a);
  const bb = new Set(b);
  if (aa.size !== bb.size) return false;
  for (const value of aa) {
    if (!bb.has(value)) return false;
  }
  return true;
}

function outcomeData(outcome: ListPagesBatchOutcome): ListPagesBatchData | null {
  return outcome.status === 'ok'
    ? outcome.data
    : outcome.status === 'partial'
      ? (outcome.data ?? null)
      : null;
}

/** 将批级 Map 折叠为整轮四道校验结论；导出是为了固定跨批竞态的离线回归测试。 */
export function finalizeListPagesRun(
  batches: Map<number, ListPagesBatchOutcome>,
  expectedBatches: number | null,
  requestedBatches: number,
  perPage: number,
): ListPagesRunResult {
  const ordered = [...batches.entries()].sort(([a], [b]) => a - b);
  const data = ordered
    .map(([, outcome]) => outcomeData(outcome))
    .filter((v): v is ListPagesBatchData => v !== null);
  const rows = data.flatMap((batch) => batch.rows);
  const actualFailed = ordered.filter(([, o]) => o.status === 'failed').length;
  const omitted = ordered.filter(
    ([, o]) => o.status === 'partial' && o.intentionalOmission === true,
  ).length;
  const partialBatches = ordered.filter(
    ([, o]) => o.status === 'partial' && o.intentionalOmission !== true,
  ).length;

  const candidateRows = data.reduce((n, b) => n + b.diagnostics.candidateRows, 0);
  const droppedRows = data.reduce(
    (n, b) =>
      n +
      b.diagnostics.droppedFieldCountRows +
      b.diagnostics.droppedParseRows +
      b.diagnostics.rejectedFiveStarRows,
    0,
  );
  const literalFields = ordered.reduce((n, [, o]) => {
    if (o.status === 'failed') return n + (o.diagnostics?.selectorLiteralFields ?? 0);
    return n + (o.data?.diagnostics.selectorLiteralFields ?? 0);
  }, 0);
  const fiveStarRows = data.reduce((n, b) => n + b.diagnostics.rejectedFiveStarRows, 0);
  const parseDropRate = candidateRows === 0 ? 0 : droppedRows / candidateRows;

  const totals = rows.map((row) => row.total);
  const firstTotal = totals[0] ?? null;
  const lastTotal = totals.at(-1) ?? null;
  const structurallyEmpty =
    data.length === 1 &&
    rows.length === 0 &&
    data[0]!.pager.totalPages === 1 &&
    data[0]!.diagnostics.candidateRows === 0;
  const remoteTotal = structurallyEmpty ? 0 : firstTotal;
  const indices = rows.map((row) => row.index);
  const observedLastIndex = indices.at(-1) ?? null;
  const expectedLastIndex = remoteTotal;
  let indexContinuous = structurallyEmpty || (indices.length > 0 && indices[0] === 1);
  for (let i = 1; i < indices.length; i++) {
    if (indices[i] !== indices[i - 1]! + 1) indexContinuous = false;
  }
  if (
    !structurallyEmpty &&
    expectedBatches !== null &&
    omitted === 0 &&
    observedLastIndex !== expectedLastIndex
  ) {
    indexContinuous = false;
  }

  const duplicateIndexes = indices.length - new Set(indices).size;
  const fullnames = rows.map((row) => row.fullname);
  const duplicateFullnames = fullnames.length - new Set(fullnames).size;
  if (duplicateIndexes > 0 || duplicateFullnames > 0) indexContinuous = false;

  const totalStable = structurallyEmpty || (totals.length > 0 && totals.every((n) => n === firstTotal));
  const pagerMatchesRemoteTotal =
    structurallyEmpty ||
    (expectedBatches !== null &&
      remoteTotal !== null &&
      expectedBatches === Math.ceil(remoteTotal / perPage));
  const reasons: string[] = [];
  if (literalFields > 0) reasons.push(`selector 字面量残留 ${literalFields} 字段`);
  if (parseDropRate > LISTPAGES_PARSE_DROP_LIMIT) {
    reasons.push(`整轮丢行率 ${(parseDropRate * 100).toFixed(3)}% > 0.5%`);
  }
  if (!indexContinuous) reasons.push('跨批 index 不连续、重叠或有空洞');
  if (fiveStarRows > 0) reasons.push(`五星评分断言拒绝 ${fiveStarRows} 页`);
  if (!totalStable && totals.length > 0) {
    reasons.push(`首/末 total 漂移：${firstTotal} → ${lastTotal}`);
  }
  if (!pagerMatchesRemoteTotal && remoteTotal !== null && expectedBatches !== null) {
    reasons.push(
      `pager=${expectedBatches} 批，但 ceil(total/perPage)=` +
        `${Math.ceil(remoteTotal / perPage)} 批`,
    );
  }
  if (omitted > 0) reasons.push(`小样本主动省略 ${omitted} 批`);
  if (partialBatches > 0) reasons.push(`${partialBatches} 批为 partial`);
  if (actualFailed > 0) reasons.push(`${actualFailed} 批重试/解析失败`);

  /*
   * 零星批失败判 partial 而不是 failed。
   *
   * partial 本就「不持久化、不推进增量状态、不入队、不算覆盖率」，缺失推断拿不到
   * 这一轮数据，因此不存在把没抓到的页误判为已删的风险——改判在数据上是零风险的，
   * 只影响告警语义。此前一批失败即整轮 failed + exit 1：站点侧偶发 http_503
   * （回填期尤其常见）就会产生一次必然自愈的告警，通道被这类噪音稀释。
   *
   * 但比例高就不是偶发而是系统性故障，必须保留 failed：
   * 抓不到大半个站却安静退出，正是最危险的失败形态。
   */
  const failedBatchRatio =
    expectedBatches !== null && expectedBatches > 0
      ? actualFailed / expectedBatches
      : actualFailed > 0
        ? 1
        : 0;
  const sporadicBatchFailure =
    actualFailed > 0
    && actualFailed <= LISTPAGES_SPORADIC_FAILED_BATCHES
    && failedBatchRatio <= LISTPAGES_SPORADIC_FAILED_BATCH_RATIO;

  let status: ListPagesRunResult['status'];
  if (
    (actualFailed > 0 && !sporadicBatchFailure) ||
    literalFields > 0 ||
    parseDropRate > LISTPAGES_PARSE_DROP_LIMIT ||
    !pagerMatchesRemoteTotal
  ) {
    status = 'failed';
  } else if (
    sporadicBatchFailure ||
    omitted > 0 ||
    partialBatches > 0 ||
    !indexContinuous ||
    fiveStarRows > 0 ||
    !totalStable
  ) {
    status = 'partial';
  } else {
    status = 'ok';
  }

  const emptyRates: Record<string, number> = {};
  for (const selector of LISTPAGES_SELECTORS) {
    const empty = rows.reduce((n, row) => n + (selectorValue(row, selector) === '' ? 1 : 0), 0);
    emptyRates[selector] = rows.length === 0 ? 0 : empty / rows.length;
  }
  const avg = (sum: number): number => (rows.length === 0 ? 0 : sum / rows.length);

  return {
    status,
    batches,
    rows,
    remoteTotal,
    expectedBatches,
    requestedBatches,
    batchesFailed: actualFailed,
    pagesEnumerated: rows.length,
    parseFingerprint: {
      sample_counts: {
        parse_drop_rate: candidateRows,
        selector_empty_rate: rows.length,
        avg_tags_len: rows.length,
        avg_votes_per_page: rows.length,
      },
      parse_drop_rate: parseDropRate,
      selector_literal_rate:
        candidateRows === 0 ? 0 : literalFields / (candidateRows * LISTPAGES_SELECTORS.length),
      selector_empty_rate: emptyRates,
      avg_tags_len: avg(rows.reduce((n, row) => n + row.mergedTags.length, 0)),
      avg_votes_per_page: avg(rows.reduce((n, row) => n + row.ratingVotes, 0)),
      five_star_rejected: fiveStarRows,
      duplicate_fullname_rate:
        rows.length === 0 ? 0 : duplicateFullnames / rows.length,
    },
    validation: {
      selectorLiteralFree: literalFields === 0,
      parseDropWithinLimit: parseDropRate <= LISTPAGES_PARSE_DROP_LIMIT,
      indexContinuous,
      fiveStarAbsent: fiveStarRows === 0,
      totalStable,
      pagerMatchesRemoteTotal,
      duplicateFullnames,
      duplicateIndexes,
      expectedLastIndex,
      observedLastIndex,
      firstTotal,
      lastTotal,
      reasons,
    },
  };
}

function selectorValue(row: ListPageRecord, selector: ListPagesSelector): string {
  switch (selector) {
    case 'fullname':
      return row.fullname;
    case 'category':
      return row.category;
    case 'name':
      return row.name;
    case 'title':
      return row.title;
    case 'tags':
      return row.tags.join(' ');
    case '_tags':
      return row.hiddenTags.join(' ');
    case 'parent_fullname':
      return row.parentFullname ?? '';
    case 'created_at':
      return row.createdAt;
    case 'created_by':
      return row.createdBy ?? '';
    case 'created_by_id':
      return row.createdById?.toString() ?? '';
    case 'created_by_unix':
      return row.createdByUnix ?? '';
    case 'updated_at':
      return row.updatedAt ?? '';
    case 'commented_at':
      return row.commentedAt ?? '';
    case 'rating':
      return String(row.rating);
    case 'rating_votes':
      return String(row.ratingVotes);
    case 'comments':
      return String(row.comments);
    case 'size':
      return String(row.size);
    case 'revisions':
      return String(row.revisions);
    case 'total':
      return String(row.total);
    case 'index':
      return String(row.index);
  }
}

async function mapLimited<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>,
  shouldStop?: () => boolean,
): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, Math.max(1, items.length)) }, async () => {
    for (;;) {
      if (shouldStop?.() === true) return;
      const i = cursor++;
      if (i >= items.length) return;
      await fn(items[i] as T);
    }
  });
  await Promise.all(workers);
}
