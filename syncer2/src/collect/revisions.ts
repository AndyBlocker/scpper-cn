/**
 * PageRevisionListModule 采集与应用。
 *
 * 两道不能放宽的断言：
 *   1. 成功解析行数必须 = Tier1 claimed_total + REVISION_COUNT_OFFSET；
 *      Wikidot 修订号从 0 开始，任何其它差值都只能 partial，绝不写事实/投影。
 *   2. 响应出现 class="pager" 说明 perpage 仍被截断，直接 failed。
 *
 * 请求参数 `perpage=99999999` 是协议的一部分，不是性能选项：不传时本站实测只返 1 行。
 */

import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { amcRequest } from '../http/amc.js';
import type { HttpClient } from '../http/client.js';
import { decodeEntities } from '../content/extractText.js';
import { query, toPgTimestamptz, withTransaction } from '../store/db.js';
import { recordPageScan } from '../store/meta.js';
import { sanitizePgValue, toPgJson } from '../store/pgText.js';
import { mapWithConcurrency } from '../util/concurrency.js';
import { throwIfRuntimeBudgetExceeded } from '../util/runtimeBudget.js';
import {
  revisionCountsMatch,
  revisionListCountFromClaimed,
} from './revisionCount.js';
import {
  assertUniqueKeys,
  diagnostics,
  failed,
  ok,
  partial,
  type CollectResult,
  type PageCollectTarget,
} from './result.js';

export const REVISION_PERPAGE = 99_999_999;

export interface RevisionTarget extends PageCollectTarget {
  claimedTotal: number;
}

export type RevisionAuthorKind = 'wikidot' | 'deleted' | 'guest';

export interface RevisionAuthor {
  kind: RevisionAuthorKind;
  wikidotId: number | null;
  displayName: string | null;
  username: string | null;
}

export type RevisionType =
  | 'SOURCE_CHANGED'
  | 'TAGS_CHANGED'
  | 'TITLE_CHANGED'
  | 'PAGE_RENAMED'
  | 'META_CHANGED'
  | 'PAGE_CREATED'
  | 'FILES_CHANGED'
  | `UNKNOWN:${string}`;

export interface RevisionEntry {
  wikidotRevisionId: number;
  revNo: number;
  /** 规范化、去重、排序后的集合；同一修订可同时含多个值。 */
  types: RevisionType[];
  /** 站点中文 title 原样保留，便于解析健康与新增标记告警。 */
  rawMarkers: string[];
  author: RevisionAuthor | null;
  occurredAt: string;
  comment: string;
}

export interface RevisionBatch {
  pageId: number;
  wikidotId: number;
  claimedTotal: number;
  entries: RevisionEntry[];
  typeHistogram: Record<string, number>;
}

const TYPE_BY_REAL_MARKER: Readonly<Record<string, RevisionType>> = {
  页面源代码已变更: 'SOURCE_CHANGED',
  标签已变更: 'TAGS_CHANGED',
  标题已变更: 'TITLE_CHANGED',
  '页面已重命名/移动': 'PAGE_RENAMED',
  元信息已变更: 'META_CHANGED',
  创建新页面: 'PAGE_CREATED',
  '文件/附件操作': 'FILES_CHANGED',
};

const TYPE_ORDER: readonly RevisionType[] = [
  'PAGE_CREATED',
  'SOURCE_CHANGED',
  'TITLE_CHANGED',
  'TAGS_CHANGED',
  'PAGE_RENAMED',
  'META_CHANGED',
  'FILES_CHANGED',
];

function typeRank(v: RevisionType): number {
  const i = TYPE_ORDER.indexOf(v);
  return i < 0 ? TYPE_ORDER.length : i;
}

function stripHtml(html: string): string {
  return decodeEntities(
    html
      .replace(/<br\b[^>]*\/?>/gi, '\n')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t\r\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .trim();
}

/**
 * wikidot 的历史表 HTML 在 comment 单元格前存在不规范闭合；按 `<td>` 起点切片比
 * `/<td>(.*?)<\/td>/` 更可靠，也与浏览器修复后的 td[0..6] 口径一致。
 */
function splitCells(rowHtml: string): string[] {
  const starts = [...rowHtml.matchAll(/<td\b[^>]*>/gi)];
  return starts.map((m, i) => {
    const start = (m.index ?? 0) + m[0].length;
    const end = i + 1 < starts.length ? (starts[i + 1]!.index ?? rowHtml.length) : rowHtml.length;
    return rowHtml.slice(start, end).replace(/<\/td>\s*$/i, '');
  });
}

function attr(attrs: string, name: string): string | null {
  const m = new RegExp(
    `\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>` + '`' + `]+))`,
    'i',
  ).exec(attrs);
  return m?.[1] ?? m?.[2] ?? m?.[3] ?? null;
}

function parseAuthor(cell: string): RevisionAuthor | null {
  const spans = [...cell.matchAll(/<span\b([^>]*)>([\s\S]*?)<\/span>/gi)];
  const span = spans.find((m) => (attr(m[1] ?? '', 'class') ?? '').split(/\s+/).includes('printuser'));
  if (!span) return null;
  const attrs = span[1] ?? '';
  const inner = span[2] ?? '';
  const classes = (attr(attrs, 'class') ?? '').split(/\s+/);
  const dataId = Number(attr(attrs, 'data-id') ?? NaN);
  const listenerId = Number(/userInfo\((\d+)\)/i.exec(inner)?.[1] ?? NaN);
  const wikidotId =
    Number.isInteger(dataId) && dataId > 0
      ? dataId
      : Number.isInteger(listenerId) && listenerId > 0
        ? listenerId
        : null;
  const username =
    /\/user:info\/([^"'/?#\s]+)/i.exec(inner)?.[1]?.trim().toLowerCase() ?? null;
  const displayName = stripHtml(inner) || null;
  return {
    kind: classes.includes('deleted') ? 'deleted' : wikidotId !== null ? 'wikidot' : 'guest',
    wikidotId,
    displayName,
    username,
  };
}

function parseMarkers(cell: string): { raw: string[]; types: RevisionType[] } {
  const raw: string[] = [];
  for (const span of cell.matchAll(/<span\b([^>]*)>/gi)) {
    const attrs = span[1] ?? '';
    const classes = (attr(attrs, 'class') ?? '').split(/\s+/);
    if (!classes.includes('spantip')) continue;
    const title = decodeEntities(attr(attrs, 'title') ?? '').trim();
    if (title !== '') raw.push(title);
  }
  const uniqueRaw = [...new Set(raw)];
  const types = [...new Set(uniqueRaw.map((v) => TYPE_BY_REAL_MARKER[v] ?? (`UNKNOWN:${v}` as const)))]
    .sort((a, b) => typeRank(a) - typeRank(b) || a.localeCompare(b));
  return { raw: uniqueRaw, types };
}

function hasClass(html: string, className: string, tag?: string): boolean {
  const tagPart = tag ? tag : '[a-z][a-z0-9:-]*';
  const re = new RegExp(`<${tagPart}\\b([^>]*)>`, 'gi');
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const classes = (attr(m[1] ?? '', 'class') ?? '').split(/\s+/);
    if (classes.includes(className)) return true;
  }
  return false;
}

function parseRow(
  revisionIdRaw: string,
  rowHtml: string,
): { entry: RevisionEntry | null; error: string | null } {
  const revisionId = Number(revisionIdRaw);
  if (!Number.isSafeInteger(revisionId) || revisionId <= 0) {
    return { entry: null, error: `非法 revision-row id=${revisionIdRaw}` };
  }
  const cells = splitCells(rowHtml);
  if (cells.length < 7) {
    return { entry: null, error: `revision ${revisionId} 只有 ${cells.length} 个 td（期望至少 7）` };
  }
  const revNoRaw = /(\d+)/.exec(stripHtml(cells[0] ?? ''))?.[1];
  const revNo = Number(revNoRaw ?? NaN);
  if (!Number.isInteger(revNo) || revNo < 0) {
    return { entry: null, error: `revision ${revisionId} 的 revNo 无法解析` };
  }
  const markers = parseMarkers(cells[2] ?? '');
  if (markers.raw.length === 0) {
    return { entry: null, error: `revision ${revisionId} 没有任何 spantip 中文修订标记` };
  }
  const epoch = Number(/\btime_(\d{9,12})\b/.exec(cells[5] ?? '')?.[1] ?? NaN);
  if (!Number.isFinite(epoch) || epoch <= 0) {
    return { entry: null, error: `revision ${revisionId} 的 odate time_<epoch> 无法解析` };
  }
  return {
    entry: {
      wikidotRevisionId: revisionId,
      revNo,
      types: markers.types,
      rawMarkers: markers.raw,
      author: parseAuthor(cells[4] ?? ''),
      occurredAt: new Date(epoch * 1_000).toISOString(),
      comment: stripHtml(cells[6] ?? ''),
    },
    error: null,
  };
}

/** 纯解析入口；空表(claimed=0)与结构失败是两种不同返回状态。 */
export function parseRevisionList(
  body: string,
  target: RevisionTarget,
): CollectResult<RevisionBatch> {
  if (!Number.isInteger(target.claimedTotal) || target.claimedTotal < 0) {
    return failed(`claimed_total 非法：${target.claimedTotal}`);
  }
  if (hasClass(body, 'pager')) {
    return failed(
      '响应含 class="pager"：即使已显式传 perpage，远端仍发生分页截断，整页判 failed。',
    );
  }
  if (!hasClass(body, 'page-history', 'table')) {
    return failed(
      '响应中没有 table.page-history；不把 WAF/no_page/空 HTML 解释成“0 条修订”。',
    );
  }

  const rows = [...body.matchAll(/<tr\b[^>]*\bid\s*=\s*["']revision-row-(\d+)["'][^>]*>([\s\S]*?)<\/tr\s*>/gi)];
  const entries: RevisionEntry[] = [];
  const errors: string[] = [];
  for (const row of rows) {
    const parsed = parseRow(row[1] ?? '', row[2] ?? '');
    if (parsed.entry) entries.push(parsed.entry);
    if (parsed.error) errors.push(parsed.error);
  }
  if (errors.length > 0) {
    return failed(
      `修订行解析失败 ${errors.length}/${rows.length}：${errors.slice(0, 3).join('；')}`,
      diagnostics(target.claimedTotal, entries.length),
    );
  }

  const seen = new Set<number>();
  for (const entry of entries) {
    if (seen.has(entry.wikidotRevisionId)) {
      return failed(
        `响应内 wikidot_revision_id 重复：${entry.wikidotRevisionId}`,
        diagnostics(target.claimedTotal, entries.length),
      );
    }
    seen.add(entry.wikidotRevisionId);
  }

  const typeHistogram: Record<string, number> = {};
  for (const entry of entries) {
    for (const type of entry.types) typeHistogram[type] = (typeHistogram[type] ?? 0) + 1;
  }
  const batch: RevisionBatch = {
    pageId: target.pageId,
    wikidotId: target.wikidotId,
    claimedTotal: target.claimedTotal,
    entries,
    typeHistogram,
  };
  const d = diagnostics(target.claimedTotal, entries.length);
  if (!revisionCountsMatch(target.claimedTotal, entries.length)) {
    const expected = revisionListCountFromClaimed(target.claimedTotal);
    return partial(
      batch,
      `RevisionList 解析 ${entries.length} 行 ≠ Tier1 claimed_total ${target.claimedTotal}` +
        ` + offset（期望 ${expected} 行）；只留证，不写投影。`,
      d,
    );
  }
  return ok(batch, d);
}

/** 请求参数单独导出，让“perpage 绝不可删”成为可单测契约。 */
export function revisionRequestParams(target: RevisionTarget): Record<string, string | number> {
  return {
    page_id: target.wikidotId,
    perpage: REVISION_PERPAGE,
    options: JSON.stringify({ all: true }),
  };
}

export async function scanRevisions(
  http: HttpClient,
  baseUrl: string,
  targets: readonly RevisionTarget[],
  concurrency = 4,
): Promise<Map<number, CollectResult<RevisionBatch>>> {
  assertUniqueKeys(targets, (t) => t.pageId);
  const pairs = await mapWithConcurrency(targets, concurrency, async (target) => {
    try {
      const res = await amcRequest(http, baseUrl, {
        moduleName: 'history/PageRevisionListModule',
        params: revisionRequestParams(target),
        mode: 'tier2:revisions',
        maxAttempts: 3,
      });
      if (res.status !== 'ok') {
        return [
          target.pageId,
          failed<RevisionBatch>(
            `PageRevisionListModule status=${res.status}（message=${res.message ?? '-'}）`,
          ),
        ] as const;
      }
      if (res.body === null) {
        return [
          target.pageId,
          failed<RevisionBatch>('PageRevisionListModule status=ok 但 body 缺失。'),
        ] as const;
      }
      return [target.pageId, parseRevisionList(res.body, target)] as const;
    } catch (err) {
      throwIfRuntimeBudgetExceeded(err);
      return [
        target.pageId,
        failed<RevisionBatch>(`PageRevisionListModule 请求失败：${String(err)}`),
      ] as const;
    }
  });
  return new Map(pairs);
}

/** 生成数据库 `text[]` 的规范集合；JSONB 批载荷会保留这个数组形态。 */
export function normalizeRevisionTypeSet(types: readonly RevisionType[]): RevisionType[] {
  return [...new Set(types)].sort((a, b) => typeRank(a) - typeRank(b) || a.localeCompare(b));
}

async function ensureAuthor(db: PoolClient, author: RevisionAuthor | null): Promise<number | null> {
  if (author?.wikidotId === null || author?.wikidotId === undefined) return null;
  const row = await query<{ id: number }>(
    db,
    'm3.revisions:ensure_user',
    `SELECT ingest.ensure_user(
       'wikidot'::text, $1::int, NULL::text, $2::text, $3::text, $3::text, NULL::int
     ) AS id`,
    [
      author.wikidotId,
      // 已注销标记不是名字快照；传进去会覆盖库里已有的真实 display_name。
      author.kind === 'deleted' ? null : author.displayName,
      author.username,
    ],
  );
  return row.rows[0]?.id === undefined ? null : Number(row.rows[0].id);
}

export interface ApplyRevisionOptions {
  observedAt: string;
  runId: number | null;
  source?: string;
}

/**
 * 所有状态先独立写 page_scan。只有 status=ok 才调用 apply_revision_batch；
 * partial/failed 明确返回 null，不给“顺手把已解析部分写进去”留入口。
 */
export async function applyRevisionResult(
  pool: Pool,
  target: RevisionTarget,
  result: CollectResult<RevisionBatch>,
  opts: ApplyRevisionOptions,
): Promise<Record<string, unknown> | null> {
  const stored =
    result.status === 'failed'
      ? null
      : sanitizePgValue(result.data, {
          context: `revision_batch:${target.pageId}`,
        });
  const sanitationMarker =
    stored !== null && stored.sanitation.stringsChanged > 0
      ? `revision_text_sanitized strings=${stored.sanitation.stringsChanged}` +
        ` nul=${stored.sanitation.nulCodeUnits}` +
        ` lone_surrogate=${stored.sanitation.loneSurrogates}`
      : null;
  const hash =
    result.status === 'failed'
      ? null
      : createHash('sha256')
          .update(JSON.stringify(stored!.value.entries), 'utf8')
          .digest();
  await recordPageScan(
    pool,
    {
      runId: opts.runId,
      pageId: target.pageId,
      kind: 'revisions',
      status: result.status,
      claimedTotal: target.claimedTotal,
      fetchedTotal: result.diagnostics.fetchedTotal,
      resultHash: hash,
      error: [
        result.status === 'ok' ? null : result.error,
        sanitationMarker,
      ].filter((value): value is string => value !== null).join('\n') || null,
    },
  );
  if (result.status !== 'ok') return null;

  const observed = toPgTimestamptz(opts.observedAt);
  return withTransaction(pool, `m3.revisions:${target.pageId}`, async (db) => {
    const authorIds = new Map<string, number | null>();
    for (const entry of stored!.value.entries) {
      const a = entry.author;
      const key = a?.wikidotId ? `wid:${a.wikidotId}` : `none:${a?.displayName ?? ''}`;
      if (!authorIds.has(key)) authorIds.set(key, await ensureAuthor(db, a));
    }
    const payload = stored!.value.entries.map((entry) => {
      const a = entry.author;
      const key = a?.wikidotId ? `wid:${a.wikidotId}` : `none:${a?.displayName ?? ''}`;
      return {
        wikidot_revision_id: entry.wikidotRevisionId,
        rev_no: entry.revNo,
        type: normalizeRevisionTypeSet(entry.types),
        author_id: authorIds.get(key) ?? null,
        occurred_at: entry.occurredAt,
        comment: entry.comment,
      };
    });
    const applied = await query<{ result: Record<string, unknown> }>(
      db,
      'm3.revisions:apply_revision_batch',
      `SELECT ingest.apply_revision_batch(
         $1::int, $2::jsonb, $3::int, $4::timestamptz, $5::text, $6::bigint, $7::int
       ) AS result`,
      [
        target.pageId,
        toPgJson(payload, `m3.revisions.payload:${target.pageId}`),
        target.claimedTotal,
        observed,
        opts.source ?? 'wikidot',
        opts.runId,
        target.wikidotId,
      ],
    );
    return applied.rows[0]?.result ?? null;
  });
}
