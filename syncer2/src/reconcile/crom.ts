/**
 * M10 §3.3 CROM 金丝雀。
 *
 * CROM 只取六个廉价字段，默认必须把游标走到 hasNextPage=false；`maxPages` 只用于
 * 显式小样本诊断。只要游标没走完，结果就是 inconclusive，绝不会用半截集合计算
 * 全局存在性或字段 difference。
 * HTTP 复用既有 HttpClient，但由调用方构造 proxyUrl=null 的直连实例，因此不占
 * wikidot 的 49 节点池，也不会绕开统一的请求遥测与 503 熔断。
 */

import type { Pool } from 'pg';
import type { HttpClient } from '../http/client.js';
import {
  revisionCountsMatch,
  revisionListCountFromClaimed,
} from '../collect/revisionCount.js';
import { query } from '../store/db.js';
import { MAX_REPORT_SAMPLES, errorMessage, type ReconcileSection } from './types.js';

export const CROM_ENDPOINT = 'https://apiv2.crom.avn.sh/graphql';
export const CROM_DEFAULT_BATCH_SIZE = 100;
const MAX_CURSOR_BATCHES = 1_000;

export interface CromPage {
  wikidotId: number;
  url: string;
  slug: string;
  title: string | null;
  rating: number | null;
  voteCount: number | null;
  revisionCount: number | null;
}

interface CromConnection {
  pages: CromPage[];
  hasNextPage: boolean;
  endCursor: string | null;
}

export type CromConnectionParseOutcome =
  | { status: 'ok'; data: CromConnection }
  | { status: 'failed'; error: string };

export type CromBatchOutcome =
  | { status: 'ok'; cursor: string | null; data: CromConnection }
  | { status: 'failed'; cursor: string | null; error: string };

export interface CromFetchResult {
  status: 'ok' | 'inconclusive' | 'failed';
  pages: Map<number, CromPage>;
  batches: Map<number, CromBatchOutcome>;
  isFull: boolean;
  intentionallyLimited: boolean;
  error: string | null;
}

export interface CromFetchOptions {
  batchSize?: number;
  /** 仅诊断；命中后强制 inconclusive。 */
  maxPages?: number;
  /** CROM 有请求频率限制；生产全量轮由 CLI 显式传入节流间隔。 */
  requestDelayMs?: number;
}

const CROM_QUERY = `
  query ReconcilePages($first: Int!, $after: ID) {
    pages(
      filter: { onWikidotPage: { url: { startsWith: "http://scp-wiki-cn.wikidot.com/" } } }
      first: $first
      after: $after
    ) {
      edges {
        node {
          url
          ... on WikidotPage {
            wikidotId
            title
            rating
            voteCount
            revisionCount
          }
        }
        cursor
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

/**
 * GraphQL connection 的纯解析入口。
 *
 * 结构完整的 `edges=[] + hasNextPage=false` 是合法空 connection；JSON 错误、缺字段、
 * hasNextPage=true 却无 cursor 等是 failed。全站金丝雀会在更外层把“首批合法空”
 * 再升级为 failed，因生产站不可能真有 0 页。
 */
export function parseCromConnection(body: string): CromConnectionParseOutcome {
  if (body.trim() === '') return { status: 'failed', error: 'CROM 响应为空字符串' };
  let root: unknown;
  try {
    root = JSON.parse(body);
  } catch (err) {
    return { status: 'failed', error: `CROM 响应不是合法 JSON：${errorMessage(err)}` };
  }
  if (!isRecord(root)) return { status: 'failed', error: 'CROM JSON 根不是 object' };
  if (Array.isArray(root['errors']) && root['errors'].length > 0) {
    return {
      status: 'failed',
      error: `CROM GraphQL errors：${JSON.stringify(root['errors']).slice(0, 1_000)}`,
    };
  }
  const data = root['data'];
  if (!isRecord(data) || !isRecord(data['pages'])) {
    return { status: 'failed', error: 'CROM 缺 data.pages connection' };
  }
  const connection = data['pages'];
  const edges = connection['edges'];
  const pageInfo = connection['pageInfo'];
  if (!Array.isArray(edges) || !isRecord(pageInfo)) {
    return { status: 'failed', error: 'CROM pages.edges/pageInfo 结构错误' };
  }
  if (typeof pageInfo['hasNextPage'] !== 'boolean') {
    return { status: 'failed', error: 'CROM pageInfo.hasNextPage 不是 boolean' };
  }
  const endCursor =
    pageInfo['endCursor'] === null || pageInfo['endCursor'] === undefined
      ? null
      : typeof pageInfo['endCursor'] === 'string'
        ? pageInfo['endCursor']
        : undefined;
  if (endCursor === undefined) {
    return { status: 'failed', error: 'CROM pageInfo.endCursor 不是 string|null' };
  }
  if (pageInfo['hasNextPage'] && (endCursor === null || endCursor === '')) {
    return { status: 'failed', error: 'CROM 声称 hasNextPage=true 但没有 endCursor' };
  }
  if (pageInfo['hasNextPage'] && edges.length === 0) {
    return { status: 'failed', error: 'CROM 声称还有下一页但当前 edges 为空，拒绝游标死循环' };
  }

  const pages: CromPage[] = [];
  const batchIds = new Set<number>();
  for (let i = 0; i < edges.length; i++) {
    const edge = edges[i];
    if (!isRecord(edge) || !isRecord(edge['node'])) {
      return { status: 'failed', error: `CROM edge[${i}] 缺 node object` };
    }
    const parsed = parseCromNode(edge['node'], i);
    if (typeof parsed === 'string') return { status: 'failed', error: parsed };
    if (batchIds.has(parsed.wikidotId)) {
      return { status: 'failed', error: `CROM 单批 wikidotId 重复：${parsed.wikidotId}` };
    }
    batchIds.add(parsed.wikidotId);
    pages.push(parsed);
  }
  return {
    status: 'ok',
    data: {
      pages,
      hasNextPage: pageInfo['hasNextPage'],
      endCursor,
    },
  };
}

export async function fetchAllCromPages(
  http: HttpClient,
  opts: CromFetchOptions = {},
): Promise<CromFetchResult> {
  const batchSize = opts.batchSize ?? CROM_DEFAULT_BATCH_SIZE;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1_000) {
    throw new RangeError(`CROM batchSize 必须是 1..1000，收到 ${batchSize}`);
  }
  if (
    opts.maxPages !== undefined &&
    (!Number.isInteger(opts.maxPages) || opts.maxPages < 1)
  ) {
    throw new RangeError(`CROM maxPages 必须是正整数，收到 ${opts.maxPages}`);
  }
  const requestDelayMs = opts.requestDelayMs ?? 0;
  if (!Number.isInteger(requestDelayMs) || requestDelayMs < 0 || requestDelayMs > 60_000) {
    throw new RangeError(`CROM requestDelayMs 必须是 0..60000 的整数，收到 ${requestDelayMs}`);
  }

  const pages = new Map<number, CromPage>();
  const batches = new Map<number, CromBatchOutcome>();
  const seenCursors = new Set<string>();
  let after: string | null = null;
  let intentionallyLimited = false;

  for (let batchNo = 1; batchNo <= MAX_CURSOR_BATCHES; batchNo++) {
    try {
      if (batchNo > 1 && requestDelayMs > 0) {
        await delay(requestDelayMs);
      }
      const remaining =
        opts.maxPages === undefined ? batchSize : Math.max(1, opts.maxPages - pages.size);
      const first = Math.min(batchSize, remaining);
      const res = await http.request(CROM_ENDPOINT, {
        mode: `reconcile:crom:${batchNo}`,
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          query: CROM_QUERY,
          variables: { first, after },
        }),
        timeoutMs: 90_000,
        maxAttempts: 3,
      });
      const parsed = parseCromConnection(res.text());
      if (parsed.status === 'failed') {
        batches.set(batchNo, { status: 'failed', cursor: after, error: parsed.error });
        return {
          status: 'inconclusive',
          pages,
          batches,
          isFull: false,
          intentionallyLimited: false,
          error: parsed.error,
        };
      }
      batches.set(batchNo, { status: 'ok', cursor: after, data: parsed.data });
      for (const page of parsed.data.pages) {
        const previous = pages.get(page.wikidotId);
        if (previous !== undefined) {
          const error =
            `CROM 跨批 wikidotId 重复：${page.wikidotId}，` +
            `${previous.slug} / ${page.slug}；拒绝静默覆盖`;
          batches.set(batchNo, { status: 'failed', cursor: after, error });
          return {
            status: 'inconclusive',
            pages,
            batches,
            isFull: false,
            intentionallyLimited: false,
            error,
          };
        }
        pages.set(page.wikidotId, page);
      }

      if (opts.maxPages !== undefined && pages.size >= opts.maxPages) {
        intentionallyLimited = parsed.data.hasNextPage;
        return {
          status: intentionallyLimited ? 'inconclusive' : 'ok',
          pages,
          batches,
          isFull: !parsed.data.hasNextPage,
          intentionallyLimited,
          error: intentionallyLimited
            ? `小样本上限 ${opts.maxPages} 页，未走完 CROM 游标`
            : null,
        };
      }
      if (!parsed.data.hasNextPage) {
        if (pages.size === 0) {
          const error = 'CROM 全站枚举结构合法但结果为 0 页；生产站不可能为空，整轮 failed';
          return {
            status: 'failed',
            pages,
            batches,
            isFull: true,
            intentionallyLimited: false,
            error,
          };
        }
        return {
          status: 'ok',
          pages,
          batches,
          isFull: true,
          intentionallyLimited: false,
          error: null,
        };
      }

      const next = parsed.data.endCursor!;
      if (seenCursors.has(next)) {
        const error = `CROM endCursor 重复：${next}；拒绝无限游标循环`;
        batches.set(batchNo, { status: 'failed', cursor: after, error });
        return {
          status: 'inconclusive',
          pages,
          batches,
          isFull: false,
          intentionallyLimited: false,
          error,
        };
      }
      seenCursors.add(next);
      after = next;
    } catch (err) {
      const error = `CROM 第 ${batchNo} 批请求失败：${errorMessage(err)}`;
      batches.set(batchNo, { status: 'failed', cursor: after, error });
      return {
        status: 'inconclusive',
        pages,
        batches,
        isFull: false,
        intentionallyLimited: false,
        error,
      };
    }
  }

  const error = `CROM 游标超过安全上限 ${MAX_CURSOR_BATCHES} 批，拒绝把半截结果当全量`;
  batches.set(MAX_CURSOR_BATCHES + 1, {
    status: 'failed',
    cursor: after,
    error,
  });
  return {
    status: 'inconclusive',
    pages,
    batches,
    isFull: false,
    intentionallyLimited,
    error,
  };
}

export interface V2CanaryPage {
  wikidotId: number;
  slug: string;
  title: string | null;
  rating: number;
  voteCount: number;
  revisionCount: number;
  updatedEpochMs: number | null;
  /** 最近一次完整当日 L1（Wikidot ListPages）的独立直接声明。 */
  l1Rating: number | null;
  l1VoteCount: number | null;
  l1RevisionClaimed: number | null;
  l1SeenEpochMs: number | null;
}

export interface CromFieldStats {
  compared: number;
  /** 枚举不完整时为 null，禁止把未测量伪装成 0。 */
  mismatches: number | null;
  actionableMismatches: number | null;
  explainedMismatches: number | null;
  nulls: number | null;
  uniqueValues: number | null;
  categories: Record<string, number>;
}

export interface CromCanaryReport extends ReconcileSection {
  isFull: boolean;
  cromPages: number;
  v2Pages: number;
  /** false 时 counts 固定为 0，下面三项与字段差异均为 null。 */
  differenceCountsAvailable: boolean;
  completedBatches: number;
  failedBatch: number | null;
  inputError: string | null;
  commonPages: number | null;
  cromOnly: number | null;
  v2Only: number | null;
  existenceCategories: Record<string, number>;
  actionableExistenceDifferences: number | null;
  lagExcluded: number;
  fields: Record<'title' | 'rating' | 'voteCount' | 'revisionCount', CromFieldStats>;
  collapseAlerts: string[];
  samples: Array<Record<string, unknown>>;
}

export async function fetchV2CanaryPages(pool: Pool): Promise<Map<number, V2CanaryPage>> {
  const res = await query<{
    wikidot_id: number;
    slug: string;
    title: string | null;
    rating: number;
    vote_count: number;
    revision_count: number;
    updated_epoch_ms: string | null;
    last_l1_rating: number | null;
    last_l1_rating_votes: number | null;
    last_l1_revision: number | null;
    last_l1_seen_epoch_ms: string | null;
  }>(
    pool,
    'reconcile:crom:v2-pages',
    `WITH live_pages AS (
       SELECT pc.*,
              count(*) OVER (PARTITION BY pc.slug)::int AS live_slug_count
         FROM serve.page_current pc
        WHERE pc.status = 'live'
     )
     SELECT pc.wikidot_id, pc.slug, pc.title, pc.rating,
            (pc.vote_up + pc.vote_down)::int AS vote_count,
            pc.revision_count,
            CASE WHEN pc.updated_at IS NULL THEN NULL
                 ELSE (extract(epoch FROM pc.updated_at) * 1000)::bigint::text
            END AS updated_epoch_ms,
            CASE WHEN pc.live_slug_count = 1 THEN ips.last_l1_rating END
              AS last_l1_rating,
            CASE WHEN pc.live_slug_count = 1 THEN ips.last_l1_rating_votes END
              AS last_l1_rating_votes,
            CASE WHEN pc.live_slug_count = 1 THEN ips.last_l1_revision END
              AS last_l1_revision,
            CASE WHEN pc.live_slug_count <> 1 OR ips.last_l1_seen_at IS NULL THEN NULL
                 ELSE (extract(epoch FROM ips.last_l1_seen_at) * 1000)::bigint::text
            END AS last_l1_seen_epoch_ms
       FROM live_pages pc
       LEFT JOIN meta.incremental_page_state ips
         ON ips.slug = pc.slug
        AND ips.page_id = pc.page_id`,
  );
  return new Map(
    res.rows.map((row) => [
      Number(row.wikidot_id),
      {
        wikidotId: Number(row.wikidot_id),
        slug: row.slug,
        title: row.title,
        rating: Number(row.rating),
        voteCount: Number(row.vote_count),
        revisionCount: Number(row.revision_count),
        updatedEpochMs:
          row.updated_epoch_ms === null ? null : Number(row.updated_epoch_ms),
        l1Rating: row.last_l1_rating === null ? null : Number(row.last_l1_rating),
        l1VoteCount:
          row.last_l1_rating_votes === null ? null : Number(row.last_l1_rating_votes),
        l1RevisionClaimed:
          row.last_l1_revision === null ? null : Number(row.last_l1_revision),
        l1SeenEpochMs:
          row.last_l1_seen_epoch_ms === null ? null : Number(row.last_l1_seen_epoch_ms),
      },
    ]),
  );
}

export function compareCromCanary(
  fetched: CromFetchResult,
  v2: ReadonlyMap<number, V2CanaryPage>,
  observedEpochMs: number,
  lagWindowMs: number,
): CromCanaryReport {
  const fieldNames = ['title', 'rating', 'voteCount', 'revisionCount'] as const;
  const unavailableFields = (): CromCanaryReport['fields'] =>
    Object.fromEntries(
      fieldNames.map((field) => [
        field,
        {
          compared: 0,
          mismatches: null,
          actionableMismatches: null,
          explainedMismatches: null,
          nulls: null,
          uniqueValues: null,
          categories: {},
        },
      ]),
    ) as CromCanaryReport['fields'];
  const completedBatches = [...fetched.batches.values()].filter(
    (batch) => batch.status === 'ok',
  ).length;
  const failedBatchEntry = [...fetched.batches.entries()].find(
    ([, batch]) => batch.status === 'failed',
  );
  if (!fetched.isFull) {
    const reason = fetched.error ?? 'CROM 游标未走到 hasNextPage=false';
    return {
      status: 'inconclusive',
      counts: { compared: 0, differences: 0, unexplained: 0 },
      alerts: [
        `CROM 枚举不完整：已完成 ${completedBatches} 批、取得 ${fetched.pages.size} 页；` +
          `${reason}；本轨 inconclusive，未计算存在性或字段 difference`,
      ],
      isFull: false,
      cromPages: fetched.pages.size,
      v2Pages: v2.size,
      differenceCountsAvailable: false,
      completedBatches,
      failedBatch: failedBatchEntry?.[0] ?? null,
      inputError: reason,
      commonPages: null,
      cromOnly: null,
      v2Only: null,
      existenceCategories: {},
      actionableExistenceDifferences: null,
      lagExcluded: 0,
      fields: unavailableFields(),
      collapseAlerts: [],
      samples: [],
    };
  }
  if (fetched.status === 'failed') {
    const reason = fetched.error ?? 'CROM 完整输入未通过结构校验';
    return {
      status: 'failed',
      counts: { compared: 1, differences: 1, unexplained: 1 },
      alerts: [reason],
      isFull: true,
      cromPages: fetched.pages.size,
      v2Pages: v2.size,
      differenceCountsAvailable: false,
      completedBatches,
      failedBatch: failedBatchEntry?.[0] ?? null,
      inputError: reason,
      commonPages: null,
      cromOnly: null,
      v2Only: null,
      existenceCategories: {},
      actionableExistenceDifferences: null,
      lagExcluded: 0,
      fields: unavailableFields(),
      collapseAlerts: [],
      samples: [],
    };
  }
  const fields = Object.fromEntries(
    fieldNames.map((field) => [
      field,
      {
        compared: 0,
        mismatches: 0,
        actionableMismatches: 0,
        explainedMismatches: 0,
        nulls: 0,
        uniqueValues: 0,
        categories: {},
      },
    ]),
  ) as CromCanaryReport['fields'];
  const values = Object.fromEntries(fieldNames.map((field) => [field, new Set<unknown>()])) as Record<
    (typeof fieldNames)[number],
    Set<unknown>
  >;
  // 存在性差异通常在字段样本之后才出现；分别留预算，避免前 100 个字段差异把它们挤掉。
  const fieldSamples: Array<Record<string, unknown>> = [];
  const existenceSamples: Array<Record<string, unknown>> = [];
  const cutoff = observedEpochMs - lagWindowMs;
  let commonPages = 0;
  let cromOnly = 0;
  let v2Only = 0;
  let actionableExistenceDifferences = 0;
  const existenceCategories: Record<string, number> = {};
  let lagExcluded = 0;

  for (const [wid, crom] of fetched.pages) {
    const local = v2.get(wid);
    if (local === undefined) {
      cromOnly++;
      actionableExistenceDifferences++;
      incrementCategory(existenceCategories, 'v2_missing_live_page_seen_by_crom');
      if (existenceSamples.length < MAX_REPORT_SAMPLES) {
        existenceSamples.push({
          wikidotId: wid,
          slug: crom.slug,
          field: 'existence',
          crom: true,
          v2: false,
          category: 'v2_missing_live_page_seen_by_crom',
          actionable: true,
        });
      }
      continue;
    }
    commonPages++;
    const recent = local.updatedEpochMs !== null && local.updatedEpochMs >= cutoff;
    if (recent) lagExcluded++;
    for (const field of fieldNames) {
      const stat = fields[field];
      const remoteValue = crom[field];
      const localValue = local[field];
      // CROM revisionCount 与 Wikidot %%revisions%% 同为零基最大修订号；本地保存真实行数。
      const matches =
        field === 'revisionCount' && crom.revisionCount !== null
          ? revisionCountsMatch(crom.revisionCount, local.revisionCount)
          : remoteValue === localValue;
      stat.compared++;
      if (remoteValue === null) stat.nulls = (stat.nulls ?? 0) + 1;
      values[field].add(remoteValue);
      if (!matches) {
        stat.mismatches = (stat.mismatches ?? 0) + 1;
        const classification = classifyFieldMismatch(
          field,
          crom,
          local,
          local.l1SeenEpochMs !== null && local.l1SeenEpochMs >= cutoff,
        );
        const category = recent ? 'lag_window_excluded' : classification.category;
        incrementCategory(stat.categories, category);
        const actionable = !recent && classification.actionable;
        if (!actionable) {
          stat.explainedMismatches = (stat.explainedMismatches ?? 0) + 1;
        } else {
          stat.actionableMismatches = (stat.actionableMismatches ?? 0) + 1;
        }
        if (fieldSamples.length < MAX_REPORT_SAMPLES) {
          fieldSamples.push({
            wikidotId: wid,
            slug: crom.slug,
            field,
            crom: remoteValue,
            v2: localValue,
            ...(field === 'revisionCount' && crom.revisionCount !== null
              ? { cromExpectedActual: revisionListCountFromClaimed(crom.revisionCount) }
              : {}),
            lagExcluded: recent,
            category,
          });
        }
      }
    }
  }
  for (const [wid, local] of v2) {
    if (!fetched.pages.has(wid)) {
      v2Only++;
      const recent = local.updatedEpochMs !== null && local.updatedEpochMs >= cutoff;
      const l1Fresh = local.l1SeenEpochMs !== null && local.l1SeenEpochMs >= cutoff;
      const category = recent
        ? 'lag_window_excluded'
        : /^(?:deleted|old):/.test(local.slug) && l1Fresh
          ? 'crom_excludes_deleted_category'
        : l1Fresh
          ? 'crom_stale_existence_vs_current_l1'
          : 'unresolved_existence_disagreement';
      const actionable = !recent && !l1Fresh;
      if (actionable) actionableExistenceDifferences++;
      incrementCategory(existenceCategories, category);
      if (existenceSamples.length < MAX_REPORT_SAMPLES) {
        existenceSamples.push({
          wikidotId: wid,
          slug: local.slug,
          field: 'existence',
          crom: false,
          v2: true,
          category,
          actionable,
        });
      }
    }
  }

  const collapseAlerts: string[] = [];
  for (const field of fieldNames) {
    fields[field].uniqueValues = values[field].size;
    if (commonPages >= 100 && values[field].size <= 1) {
      collapseAlerts.push(`CROM ${field} 在 ${commonPages} 个共有页上塌缩为单一值`);
    }
    if (
      fields[field].compared > 0 &&
      (fields[field].nulls ?? 0) / fields[field].compared > 0.01
    ) {
      collapseAlerts.push(
        `CROM ${field} 空值率 ${((fields[field].nulls ?? 0) / fields[field].compared * 100).toFixed(2)}% > 1%`,
      );
    }
  }

  const fieldDiffs = fieldNames.reduce((n, field) => n + (fields[field].mismatches ?? 0), 0);
  const actionableFieldDiffs = fieldNames.reduce(
    (n, field) => n + (fields[field].actionableMismatches ?? 0),
    0,
  );
  // 塌缩/异常空值率也是金丝雀发现的真实差异，必须同时进入 differences；
  // 否则会出现 unexplained > differences，既破坏计数语义也会被持久化 CHECK 拒绝。
  const differences = cromOnly + v2Only + fieldDiffs + collapseAlerts.length;
  const actionable =
    actionableExistenceDifferences + actionableFieldDiffs + collapseAlerts.length;
  const compared = fetched.pages.size + v2Only + commonPages * fieldNames.length;
  const alerts: string[] = [];
  if (actionableExistenceDifferences > 0) {
    alerts.push(
      `CROM/v2 可行动存在性差异 ${actionableExistenceDifferences}` +
        `（原始 CROM-only=${cromOnly}, v2-only=${v2Only}）`,
    );
  }
  if (actionableFieldDiffs > 0) alerts.push(`CROM 五项中可行动字段差异 ${actionableFieldDiffs}`);
  alerts.push(...collapseAlerts);

  return {
    status: collapseAlerts.length > 0 || actionable > 0 ? 'failed' : 'ok',
    counts: { compared, differences, unexplained: actionable },
    alerts,
    isFull: fetched.isFull,
    cromPages: fetched.pages.size,
    v2Pages: v2.size,
    differenceCountsAvailable: true,
    completedBatches,
    failedBatch: null,
    inputError: null,
    commonPages,
    cromOnly,
    v2Only,
    existenceCategories,
    actionableExistenceDifferences,
    lagExcluded,
    fields,
    collapseAlerts,
    samples: [...existenceSamples, ...fieldSamples].slice(0, MAX_REPORT_SAMPLES),
  };
}

type CromComparedField = 'title' | 'rating' | 'voteCount' | 'revisionCount';

function classifyFieldMismatch(
  field: CromComparedField,
  crom: CromPage,
  local: V2CanaryPage,
  l1Fresh: boolean,
): { category: string; actionable: boolean } {
  if (
    field === 'title' &&
    crom.title !== null &&
    local.title !== null &&
    normalizeSourceTitle(crom.title) === normalizeSourceTitle(local.title)
  ) {
    return { category: 'crom_title_source_normalization', actionable: false };
  }
  if (l1Fresh && field === 'rating' && local.l1Rating !== null) {
    if (crom.rating === local.l1Rating) {
      return { category: 'v2_stale_vs_current_l1', actionable: true };
    }
    if (local.rating === local.l1Rating) {
      return { category: 'crom_stale_vs_current_l1', actionable: false };
    }
  }
  if (l1Fresh && field === 'voteCount' && local.l1VoteCount !== null) {
    if (crom.voteCount === local.l1VoteCount) {
      return { category: 'v2_stale_vs_current_l1', actionable: true };
    }
    if (local.voteCount === local.l1VoteCount) {
      return { category: 'crom_stale_vs_current_l1', actionable: false };
    }
  }
  if (
    l1Fresh &&
    field === 'revisionCount' &&
    local.l1RevisionClaimed !== null &&
    crom.revisionCount !== null
  ) {
    if (crom.revisionCount === local.l1RevisionClaimed) {
      return { category: 'v2_stale_vs_current_l1', actionable: true };
    }
    if (revisionCountsMatch(local.l1RevisionClaimed, local.revisionCount)) {
      return { category: 'crom_stale_vs_current_l1', actionable: false };
    }
  }
  return { category: 'unresolved_source_disagreement', actionable: true };
}

/**
 * CROM 会把 Wikidot 标题里的 NBSP、wiki 斜杠标记和部分 Unicode 标点转成 ASCII。
 * 这里只编码逐字符可逆的来源归一，不做模糊相似度或页面白名单。
 */
function normalizeSourceTitle(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/\s+/gu, ' ')
    .replace(/…/gu, '...')
    .replace(/[—–]/gu, '--')
    .replace(/\/\//gu, '')
    .trim();
}

function incrementCategory(categories: Record<string, number>, category: string): void {
  categories[category] = (categories[category] ?? 0) + 1;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseCromNode(node: Record<string, unknown>, index: number): CromPage | string {
  const url = node['url'];
  if (typeof url !== 'string' || url.trim() === '') return `CROM node[${index}] url 缺失`;
  const slug = slugFromCromUrl(url);
  if (slug === null) return `CROM node[${index}] URL 不属于 scp-wiki-cn：${url}`;
  const wikidotId = positiveInteger(node['wikidotId']);
  if (wikidotId === null) return `CROM node[${index}] wikidotId 不是正整数：${String(node['wikidotId'])}`;
  const title = nullableString(node['title']);
  if (title === undefined) return `CROM node[${index}] title 不是 string|null`;
  const rating = nullableNumber(node['rating']);
  const voteCount = nullableNumber(node['voteCount']);
  const revisionCount = nullableNumber(node['revisionCount']);
  if (rating === undefined || voteCount === undefined || revisionCount === undefined) {
    return `CROM node[${index}] rating/voteCount/revisionCount 不是 number|null`;
  }
  return { wikidotId, url, slug, title, rating, voteCount, revisionCount };
}

function slugFromCromUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.hostname.toLowerCase() !== 'scp-wiki-cn.wikidot.com') return null;
    const slug = decodeURIComponent(url.pathname).replace(/^\/+|\/+$/g, '').toLowerCase();
    return slug === '' ? null : slug;
  } catch {
    return null;
  }
}

function positiveInteger(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function nullableString(value: unknown): string | null | undefined {
  return value === null ? null : typeof value === 'string' ? value : undefined;
}

function nullableNumber(value: unknown): number | null | undefined {
  if (value === null) return null;
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
