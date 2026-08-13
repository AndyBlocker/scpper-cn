/**
 * M10 §3.4 站内三角验证。
 *
 * 枚举互校读取 sitemap 与 ListPages 各自完整轮留下的原子快照；页级两项则用同一条
 * ListPages 观测作为 claimed 值，再分别请求 WhoRated 与 RevisionList。每个目标都在
 * Map 中显式留下 ok/partial/failed，单页失败不会从结果里消失；上游 claims
 * 不完整时则整条输入轨为 inconclusive，不会构造空 Map 冒充已测量。
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Pool } from 'pg';
import { amcRequest } from '../http/amc.js';
import type { HttpClient } from '../http/client.js';
import {
  collectTargetedVoteClaim,
  gateParsedVotes,
  parseWhoRatedPage,
  timeoutForVoteCount,
  type VoteTarget,
} from '../collect/votes.js';
import {
  parseRevisionList,
  revisionRequestParams,
  type RevisionTarget,
} from '../collect/revisions.js';
import {
  revisionCountDelta,
  revisionCountsMatch,
  revisionListCountFromClaimed,
} from '../collect/revisionCount.js';
import {
  readListPagesSnapshot,
  type ListPagesSnapshot,
} from '../collect/listpages.js';
import { fetchPageIdentity, type IdentityOutcome } from '../page/identity.js';
import { snapshotPath, readSnapshot, type SitemapSnapshot } from '../store/snapshot.js';
import { query } from '../store/db.js';
import {
  l1EnumerationSnapshotPath,
  readL1EnumerationSnapshot,
  type L1EnumerationSnapshot,
} from '../store/l1EnumerationSnapshot.js';
import { mapWithConcurrency } from '../util/concurrency.js';
import {
  MAX_REPORT_SAMPLES,
  errorMessage,
  type ReconcileSection,
} from './types.js';

const SITEMAP_ALLOWED_MISSING_CATEGORIES = new Set([
  'deleted',
  'forum',
  'adult',
  'wanderers-adult',
]);
const HIDDEN_SITEMAP_ONLY_RE = /^(?:[^:]+:)?_/;

export interface EnumerationTriangleReport extends ReconcileSection {
  source: 'snapshots';
  /** false 时集合未形成完整可比输入，所有 difference 明细都是 null。 */
  differenceCountsAvailable: boolean;
  sitemapCount: number;
  listPagesCount: number;
  common: number | null;
  sitemapOnly: number | null;
  listPagesOnly: number | null;
  explainedSitemapOnly: number | null;
  explainedListPagesOnly: number | null;
  unexplainedSitemapOnly: number | null;
  unexplainedListPagesOnly: number | null;
  sitemapSnapshotAt: string | null;
  listPagesSnapshotAt: string | null;
  samples: Array<Record<string, unknown>>;
}

export interface LoadedEnumeration {
  status: 'ok' | 'inconclusive' | 'failed';
  report: EnumerationTriangleReport;
  listPages: EnumerationListPagesSnapshot | null;
}

export type EnumerationListPagesSnapshot = ListPagesSnapshot | L1EnumerationSnapshot;

/** L1 四字段快照与旧 L3 全字段快照供页级三角共同需要的最小 claims。 */
export interface TriangleClaimRow {
  fullname: string;
  category: string;
  rating: number;
  ratingVotes: number;
  revisions: number;
  index: number;
  createdAt?: string | null;
}

export function loadEnumerationSnapshots(
  stateDir: string,
  observedEpochMs: number,
  maxAgeMs: number,
): LoadedEnumeration {
  const sitemap = readSnapshot(snapshotPath(stateDir, 'sitemap-page'));
  const l1File = l1EnumerationSnapshotPath(stateDir);
  // 新 L1 文件一旦出现就成为唯一日快照入口：若它损坏/半截，必须拒绝使用，不能
  // 悄悄回退到可能过时的周级 L3，把完整性故障掩盖掉。
  const listPages = fs.existsSync(l1File)
    ? readL1EnumerationSnapshot(l1File)
    : readListPagesSnapshot(path.join(stateDir, 'listpages-tier1.snapshot.json.gz'));
  if (sitemap === null || listPages === null) {
    const missing = [
      sitemap === null ? 'sitemap full 快照' : null,
      listPages === null ? 'ListPages 完整快照' : null,
    ].filter((v): v is string => v !== null);
    return {
      status: 'inconclusive',
      listPages,
      report: inconclusiveEnumeration(
        `缺少/损坏：${missing.join('、')}；输入未完成，本轨 inconclusive，未计算 difference`,
        sitemap,
        listPages,
      ),
    };
  }
  const structuralError = validateSnapshots(sitemap, listPages);
  if (structuralError !== null) {
    return {
      status: 'inconclusive',
      listPages,
      report: inconclusiveEnumeration(
        `${structuralError}；完整性校验未通过，本轨 inconclusive，未计算 difference`,
        sitemap,
        listPages,
      ),
    };
  }
  const stale: string[] = [];
  const sitemapAt = Date.parse(sitemap.lastFullAt!);
  const listPagesAt = Date.parse(listPages.updatedAt);
  if (!Number.isFinite(sitemapAt) || observedEpochMs - sitemapAt > maxAgeMs) {
    stale.push(`sitemap full 快照过旧：${sitemap.lastFullAt}`);
  }
  if (!Number.isFinite(listPagesAt) || observedEpochMs - listPagesAt > maxAgeMs) {
    stale.push(`ListPages 快照过旧：${listPages.updatedAt}`);
  }
  if (stale.length > 0) {
    return {
      status: 'inconclusive',
      listPages,
      report: inconclusiveEnumeration(
        `${stale.join('；')}；快照时点不可比，本轨 inconclusive，未计算 difference`,
        sitemap,
        listPages,
      ),
    };
  }
  const report = compareEnumerationSets(sitemap, listPages);
  return { status: report.status === 'failed' ? 'failed' : 'ok', report, listPages };
}

export function compareEnumerationSets(
  sitemap: SitemapSnapshot,
  listPages: EnumerationListPagesSnapshot,
): EnumerationTriangleReport {
  const sitemapSlugs = new Set(Object.keys(sitemap.entries));
  const listRows = Object.values(listPages.rows);
  const listSlugs = new Set(listRows.map((row) => row.fullname));
  const bySlug = new Map(listRows.map((row) => [row.fullname, row]));
  const samples: Array<Record<string, unknown>> = [];
  let common = 0;
  let sitemapOnly = 0;
  let listPagesOnly = 0;
  let explainedSitemapOnly = 0;
  let explainedListPagesOnly = 0;
  let unexplainedSitemapOnly = 0;
  let unexplainedListPagesOnly = 0;

  for (const slug of sitemapSlugs) {
    if (listSlugs.has(slug)) {
      common++;
      continue;
    }
    sitemapOnly++;
    const explained = HIDDEN_SITEMAP_ONLY_RE.test(slug);
    if (explained) explainedSitemapOnly++;
    else unexplainedSitemapOnly++;
    if (samples.length < MAX_REPORT_SAMPLES) {
      samples.push({ slug, side: 'sitemap_only', explained, reason: explained ? 'hidden_prefix' : null });
    }
  }
  for (const slug of listSlugs) {
    if (sitemapSlugs.has(slug)) continue;
    listPagesOnly++;
    const category = bySlug.get(slug)?.category.toLowerCase() ?? '';
    const explained = SITEMAP_ALLOWED_MISSING_CATEGORIES.has(category);
    if (explained) explainedListPagesOnly++;
    else unexplainedListPagesOnly++;
    if (samples.length < MAX_REPORT_SAMPLES) {
      samples.push({
        slug,
        side: 'listpages_only',
        category,
        explained,
        reason: explained ? `sitemap_excludes_category:${category}` : null,
      });
    }
  }

  const differences = sitemapOnly + listPagesOnly;
  const unexplained = unexplainedSitemapOnly + unexplainedListPagesOnly;
  const alerts =
    unexplained === 0
      ? []
      : [
          `sitemap/ListPages 有 ${unexplained} 个未解释枚举差异` +
            `（sitemap-only=${unexplainedSitemapOnly}, ListPages-only=${unexplainedListPagesOnly}）`,
        ];
  return {
    status: unexplained === 0 ? 'ok' : 'failed',
    counts: {
      compared: sitemapSlugs.size + listPagesOnly,
      differences,
      unexplained,
    },
    alerts,
    source: 'snapshots',
    differenceCountsAvailable: true,
    sitemapCount: sitemapSlugs.size,
    listPagesCount: listSlugs.size,
    common,
    sitemapOnly,
    listPagesOnly,
    explainedSitemapOnly,
    explainedListPagesOnly,
    unexplainedSitemapOnly,
    unexplainedListPagesOnly,
    sitemapSnapshotAt: sitemap.lastFullAt,
    listPagesSnapshotAt: listPages.updatedAt,
    samples,
  };
}

/**
 * sitemap 与 ListPages 都是派生枚举源；只对未解释差集逐页 GET，让站点页面本身裁决。
 * 请求失败、重定向或结论方向不符时保持 failed，绝不把“没验证到”当成白名单。
 */
export async function adjudicateEnumerationWithPageGet(
  http: HttpClient,
  baseUrl: string,
  report: EnumerationTriangleReport,
  concurrency = 2,
): Promise<EnumerationTriangleReport> {
  if (!report.differenceCountsAvailable || report.counts.unexplained === 0) return report;
  const candidates = report.samples.filter(
    (sample) =>
      sample['explained'] === false &&
      typeof sample['slug'] === 'string' &&
      (sample['side'] === 'sitemap_only' || sample['side'] === 'listpages_only'),
  );
  const outcomes = await mapWithConcurrency(candidates, concurrency, async (sample) => {
    const slug = sample['slug'] as string;
    return [slug, await fetchPageIdentity(http, baseUrl, slug)] as const;
  });
  return applyEnumerationPageGetEvidence(report, new Map(outcomes));
}

export function applyEnumerationPageGetEvidence(
  report: EnumerationTriangleReport,
  evidence: ReadonlyMap<string, IdentityOutcome>,
): EnumerationTriangleReport {
  let newlyExplainedSitemapOnly = 0;
  let newlyExplainedListPagesOnly = 0;
  const samples = report.samples.map((sample) => {
    if (sample['explained'] !== false || typeof sample['slug'] !== 'string') return sample;
    const outcome = evidence.get(sample['slug']);
    if (outcome === undefined) return sample;
    if (sample['side'] === 'listpages_only' && outcome.kind === 'ok') {
      newlyExplainedListPagesOnly++;
      return {
        ...sample,
        explained: true,
        reason: 'sitemap_omission_confirmed_by_page_get',
        pageGetWikidotId: outcome.identity.wikidotId,
      };
    }
    if (sample['side'] === 'sitemap_only' && outcome.kind === 'gone') {
      newlyExplainedSitemapOnly++;
      return {
        ...sample,
        explained: true,
        reason: 'listpages_stale_deletion_confirmed_by_page_get',
        pageGetHttpStatus: outcome.httpStatus,
      };
    }
    return {
      ...sample,
      pageGetOutcome: outcome.kind,
      ...(outcome.kind === 'failed' || outcome.kind === 'gone'
        ? { pageGetHttpStatus: outcome.httpStatus }
        : {}),
    };
  });
  const unexplainedSitemapOnly = Math.max(
    0,
    (report.unexplainedSitemapOnly ?? 0) - newlyExplainedSitemapOnly,
  );
  const unexplainedListPagesOnly = Math.max(
    0,
    (report.unexplainedListPagesOnly ?? 0) - newlyExplainedListPagesOnly,
  );
  const unexplained = unexplainedSitemapOnly + unexplainedListPagesOnly;
  const alerts = unexplained === 0
    ? []
    : [
        `sitemap/ListPages 有 ${unexplained} 个未解释枚举差异` +
          `（sitemap-only=${unexplainedSitemapOnly}, ListPages-only=${unexplainedListPagesOnly}）`,
      ];
  return {
    ...report,
    status: unexplained === 0 ? 'ok' : 'failed',
    counts: { ...report.counts, unexplained },
    alerts,
    explainedSitemapOnly:
      report.explainedSitemapOnly === null
        ? null
        : report.explainedSitemapOnly + newlyExplainedSitemapOnly,
    explainedListPagesOnly:
      report.explainedListPagesOnly === null
        ? null
        : report.explainedListPagesOnly + newlyExplainedListPagesOnly,
    unexplainedSitemapOnly,
    unexplainedListPagesOnly,
    samples,
  };
}

export interface TriangleSubcheck {
  status: 'ok' | 'partial' | 'failed';
  claimed: number;
  fetched: number | null;
  actual: number | null;
  /** actual 相对该模块期望值的偏差；修订模块的期望值是 claimed + offset。 */
  delta: number | null;
  error: string | null;
  /** 两个模块在先后请求间发生真实变化时，由第二次定向 ListPages 形成闭环。 */
  explanation?: string;
}

export interface TrianglePageData {
  fullname: string;
  wikidotId: number;
  pageId: number | null;
  identitySource: 'v2' | 'page_get';
  votes: TriangleSubcheck;
  revisions: TriangleSubcheck;
}

export type TrianglePageOutcome =
  | { status: 'ok' | 'partial'; data: TrianglePageData }
  | {
      status: 'failed';
      fullname: string;
      error: string;
      data?: TrianglePageData;
    };

export interface ActiveTriangleReport extends ReconcileSection {
  requestedPages: number;
  completedPages: number;
  voteMatches: number;
  voteMismatches: number;
  revisionMatches: number;
  revisionMismatches: number;
  pageResults: Array<Record<string, unknown>>;
}

interface ResolvedTriangleIdentity {
  pageId: number | null;
  wikidotId: number;
  source: 'v2' | 'page_get';
}

/**
 * 用投票量、修订量、零票页与新近页四个形态做确定性分层，不使用 Math.random，
 * 让同一快照重复跑时样本可复现。
 */
export function selectTriangleRows(rows: readonly TriangleClaimRow[], limit: number): TriangleClaimRow[] {
  if (!Number.isInteger(limit) || limit < 1 || limit > 15) {
    throw new RangeError(`triangle limit 必须是 1..15；15 页最坏 45 个 wikidot 请求，收到 ${limit}`);
  }
  const selected = new Map<string, TriangleClaimRow>();
  const take = (source: readonly TriangleClaimRow[]): void => {
    for (const row of source) {
      if (selected.size >= limit) return;
      selected.set(row.fullname, row);
    }
  };
  const quota = Math.max(1, Math.ceil(limit / 4));
  take([...rows].sort((a, b) => b.ratingVotes - a.ratingVotes || a.fullname.localeCompare(b.fullname)).slice(0, quota));
  take([...rows].sort((a, b) => b.revisions - a.revisions || a.fullname.localeCompare(b.fullname)).slice(0, quota));
  take(rows.filter((row) => row.ratingVotes === 0).slice(0, quota));
  take(
    rows
      .filter(
        (row) =>
          typeof row.createdAt === 'string' && Number.isFinite(Date.parse(row.createdAt)),
      )
      .sort((a, b) => Date.parse(b.createdAt!) - Date.parse(a.createdAt!))
      .slice(0, quota),
  );
  take([...rows].sort((a, b) => a.fullname.localeCompare(b.fullname)));
  return [...selected.values()].slice(0, limit);
}

export async function runTrianglePageChecks(
  http: HttpClient,
  pool: Pool,
  baseUrl: string,
  rows: readonly TriangleClaimRow[],
  concurrency = 2,
): Promise<Map<string, TrianglePageOutcome>> {
  const identities = await resolveTriangleIdentities(http, pool, baseUrl, rows, concurrency);
  const pairs = await mapWithConcurrency<
    TriangleClaimRow,
    readonly [string, TrianglePageOutcome]
  >(rows, concurrency, async (row): Promise<readonly [string, TrianglePageOutcome]> => {
    const identity = identities.get(row.fullname);
    if (identity === undefined || typeof identity === 'string') {
      return [
        row.fullname,
        {
          status: 'failed',
          fullname: row.fullname,
          error:
            typeof identity === 'string'
              ? identity
              : '内部错误：身份结果缺项（已补 failed，未解释为空页面）',
        },
      ] as const;
    }
    const pageKey = identity.pageId ?? row.index;
    const votes = await checkVoteTriangle(http, baseUrl, row, identity.wikidotId, pageKey);
    const revisions = await checkRevisionTriangle(http, baseUrl, row, identity.wikidotId, pageKey);
    const data: TrianglePageData = {
      fullname: row.fullname,
      wikidotId: identity.wikidotId,
      pageId: identity.pageId,
      identitySource: identity.source,
      votes,
      revisions,
    };
    const status: TrianglePageOutcome['status'] =
      votes.status === 'failed' || revisions.status === 'failed'
        ? 'failed'
        : votes.status === 'partial' || revisions.status === 'partial'
          ? 'partial'
          : 'ok';
    return [
      row.fullname,
      status === 'failed'
        ? {
            status: 'failed',
            fullname: row.fullname,
            error: [votes.error, revisions.error].filter(Boolean).join('；'),
            data,
          }
        : { status, data },
    ] as const;
  });
  const result = new Map<string, TrianglePageOutcome>(pairs);
  for (const row of rows) {
    if (!result.has(row.fullname)) {
      result.set(row.fullname, {
        status: 'failed',
        fullname: row.fullname,
        error: '内部错误：三角结果 Map 缺项，禁止把缺项解释成通过',
      });
    }
  }
  return result;
}

export function summarizeActiveTriangle(
  outcomes: ReadonlyMap<string, TrianglePageOutcome>,
): ActiveTriangleReport {
  let completedPages = 0;
  let voteMatches = 0;
  let voteMismatches = 0;
  let revisionMatches = 0;
  let revisionMismatches = 0;
  let failedPages = 0;
  const pageResults: Array<Record<string, unknown>> = [];
  for (const [fullname, outcome] of outcomes) {
    if (outcome.status === 'failed' && outcome.data === undefined) {
      failedPages++;
      pageResults.push({ fullname, status: 'failed', error: outcome.error });
      continue;
    }
    const data = outcome.data!;
    completedPages++;
    if (data.votes.status === 'ok') voteMatches++;
    else voteMismatches++;
    if (data.revisions.status === 'ok') revisionMatches++;
    else revisionMismatches++;
    pageResults.push({
      fullname,
      status: outcome.status,
      wikidotId: data.wikidotId,
      identitySource: data.identitySource,
      votes: data.votes,
      revisions: data.revisions,
      ...(outcome.status === 'failed' ? { error: outcome.error } : {}),
    });
  }
  const mismatches = voteMismatches + revisionMismatches;
  const status =
    failedPages > 0 || mismatches > 0 ? 'failed' : outcomes.size > 0 ? 'ok' : 'failed';
  const alerts: string[] = [];
  if (outcomes.size === 0) alerts.push('三角页级校验没有目标；合法空集合不等于已验证');
  if (failedPages > 0) alerts.push(`三角页级校验 ${failedPages} 页请求/解析失败`);
  if (mismatches > 0) {
    alerts.push(`三角独立模块不一致：votes=${voteMismatches}, revisions=${revisionMismatches}`);
  }
  return {
    status,
    counts: {
      compared: completedPages * 2 + failedPages,
      differences: mismatches + failedPages,
      unexplained: mismatches + failedPages,
    },
    alerts,
    requestedPages: outcomes.size,
    completedPages,
    voteMatches,
    voteMismatches,
    revisionMatches,
    revisionMismatches,
    pageResults: pageResults.slice(0, MAX_REPORT_SAMPLES),
  };
}

/** 上游 claims 不完整时禁止把空 outcomes 当作“测到 0 个差异”。 */
export function inconclusiveActiveTriangle(reason: string): ActiveTriangleReport {
  return {
    status: 'inconclusive',
    counts: { compared: 0, differences: 0, unexplained: 0 },
    alerts: [`${reason}；页级三角 inconclusive，未计算 difference`],
    requestedPages: 0,
    completedPages: 0,
    voteMatches: 0,
    voteMismatches: 0,
    revisionMatches: 0,
    revisionMismatches: 0,
    pageResults: [],
  };
}

async function resolveTriangleIdentities(
  http: HttpClient,
  pool: Pool,
  baseUrl: string,
  rows: readonly TriangleClaimRow[],
  concurrency: number,
): Promise<Map<string, ResolvedTriangleIdentity | string>> {
  const slugs = rows.map((row) => row.fullname);
  const known = await query<{
    slug: string;
    page_id: number;
    wikidot_id: number;
    historical_page_count: number;
  }>(
    pool,
    'reconcile:triangle:known-identities',
    `WITH history_counts AS (
       SELECT slug, count(DISTINCT page_id)::int AS historical_page_count
         FROM ingest.page_slug_history
        WHERE slug = ANY($1::text[])
        GROUP BY slug
     )
     SELECT pc.slug, pc.page_id, pc.wikidot_id, hc.historical_page_count
       FROM serve.page_current pc
       JOIN history_counts hc ON hc.slug = pc.slug
      WHERE pc.status = 'live'
        AND pc.slug = ANY($1::text[])`,
    [slugs],
  );
  const result = new Map<string, ResolvedTriangleIdentity | string>();
  for (const row of known.rows) {
    // slug 曾被多页复用时，本地 current 映射不能充当独立身份来源；回源 page GET。
    if (Number(row.historical_page_count) > 1 || result.has(row.slug)) {
      result.delete(row.slug);
      continue;
    }
    result.set(row.slug, {
      pageId: Number(row.page_id),
      wikidotId: Number(row.wikidot_id),
      source: 'v2',
    });
  }
  const unknown = rows.filter((row) => !result.has(row.fullname));
  const fetched = await mapWithConcurrency(unknown, concurrency, async (row) => {
    const identity = await fetchPageIdentity(http, baseUrl, row.fullname);
    return [row, identity] as const;
  });
  for (const [row, identity] of fetched) {
    if (identity.kind === 'ok') {
      result.set(row.fullname, {
        pageId: null,
        wikidotId: identity.identity.wikidotId,
        source: 'page_get',
      });
    } else {
      result.set(
        row.fullname,
        `页面身份解析 ${identity.kind}：${'error' in identity ? identity.error : identity.observedSlug}`,
      );
    }
  }
  return result;
}

async function checkVoteTriangle(
  http: HttpClient,
  baseUrl: string,
  row: TriangleClaimRow,
  wikidotId: number,
  pageKey: number,
): Promise<TriangleSubcheck> {
  try {
    const response = await amcRequest(http, baseUrl, {
      moduleName: 'pagerate/WhoRatedPageModule',
      params: { pageId: wikidotId },
      mode: 'reconcile:triangle:votes',
      timeoutMs: timeoutForVoteCount(row.ratingVotes),
      maxAttempts: 3,
    });
    if (response.status !== 'ok' || response.body === null) {
      return {
        status: 'failed',
        claimed: row.rating,
        fetched: null,
        actual: null,
        delta: null,
        error: `WhoRated status=${response.status}, body=${response.body === null ? 'null' : 'present'}`,
      };
    }
    const target: VoteTarget = {
      pageId: pageKey,
      wikidotId,
      claimedTotal: row.ratingVotes,
      claimedRating: row.rating,
    };
    const parsed = gateParsedVotes(target, parseWhoRatedPage(response.body));
    if (parsed.status === 'failed') {
      return {
        status: 'failed',
        claimed: row.rating,
        fetched: parsed.data?.entries.length ?? null,
        actual: parsed.data?.checksum ?? null,
        delta:
          parsed.data === undefined ? null : parsed.data.checksum - row.rating,
        error: parsed.error,
      };
    }
    const exact =
      parsed.data.entries.length === row.ratingVotes && parsed.data.checksum === row.rating;
    if (!exact) {
      const recheck = await collectTargetedVoteClaim(http, baseUrl, row.fullname);
      if (
        recheck.status === 'ok' &&
        recheck.data.claimedTotal === parsed.data.entries.length &&
        recheck.data.claimedRating === parsed.data.checksum
      ) {
        return {
          status: 'ok',
          claimed: row.rating,
          fetched: parsed.data.entries.length,
          actual: parsed.data.checksum,
          delta: parsed.data.checksum - row.rating,
          error: null,
          explanation:
            `source_changed_during_triangle:初始 ListPages=${row.ratingVotes}/${row.rating}，` +
            `随后 WhoRated 与定向 ListPages 均为 ` +
            `${recheck.data.claimedTotal}/${recheck.data.claimedRating}`,
        };
      }
    }
    return {
      status: exact ? 'ok' : 'partial',
      claimed: row.rating,
      fetched: parsed.data.entries.length,
      actual: parsed.data.checksum,
      delta: parsed.data.checksum - row.rating,
      error: exact
        ? null
        : `WhoRated entries/checksum=${parsed.data.entries.length}/${parsed.data.checksum}，` +
          `ListPages=${row.ratingVotes}/${row.rating}`,
    };
  } catch (err) {
    return {
      status: 'failed',
      claimed: row.rating,
      fetched: null,
      actual: null,
      delta: null,
      error: errorMessage(err),
    };
  }
}

async function checkRevisionTriangle(
  http: HttpClient,
  baseUrl: string,
  row: TriangleClaimRow,
  wikidotId: number,
  pageKey: number,
): Promise<TriangleSubcheck> {
  const target: RevisionTarget = {
    pageId: pageKey,
    wikidotId,
    claimedTotal: row.revisions,
  };
  try {
    const response = await amcRequest(http, baseUrl, {
      moduleName: 'history/PageRevisionListModule',
      params: revisionRequestParams(target),
      mode: 'reconcile:triangle:revisions',
      maxAttempts: 3,
    });
    if (response.status !== 'ok' || response.body === null) {
      return {
        status: 'failed',
        claimed: row.revisions,
        fetched: null,
        actual: null,
        delta: null,
        error: `RevisionList status=${response.status}, body=${response.body === null ? 'null' : 'present'}`,
      };
    }
    const parsed = parseRevisionList(response.body, target);
    if (parsed.status === 'failed') {
      return {
        status: 'failed',
        claimed: row.revisions,
        fetched: parsed.diagnostics.fetchedTotal,
        actual: parsed.diagnostics.fetchedTotal,
        delta:
          parsed.diagnostics.fetchedTotal === null
            ? null
            : revisionCountDelta(row.revisions, parsed.diagnostics.fetchedTotal),
        error: parsed.error,
      };
    }
    const fetched = parsed.data.entries.length;
    const exact = revisionCountsMatch(row.revisions, fetched);
    const expected = revisionListCountFromClaimed(row.revisions);
    if (!exact) {
      const recheck = await collectTargetedVoteClaim(http, baseUrl, row.fullname);
      if (recheck.status === 'ok' && revisionCountsMatch(recheck.data.revisions, fetched)) {
        return {
          status: 'ok',
          claimed: row.revisions,
          fetched,
          actual: fetched,
          delta: revisionCountDelta(row.revisions, fetched),
          error: null,
          explanation:
            `source_changed_during_triangle:初始 ListPages revisions=${row.revisions}，` +
            `随后 RevisionList 行数=${fetched} 与定向 ListPages revisions=` +
            `${recheck.data.revisions}（+offset）一致`,
        };
      }
    }
    return {
      status: exact ? 'ok' : 'partial',
      claimed: row.revisions,
      fetched,
      actual: fetched,
      delta: revisionCountDelta(row.revisions, fetched),
      error: exact
        ? null
        : `RevisionList 行数 ${fetched} ≠ ListPages %%revisions%% ${row.revisions}` +
          ` + offset（期望 ${expected}）`,
    };
  } catch (err) {
    return {
      status: 'failed',
      claimed: row.revisions,
      fetched: null,
      actual: null,
      delta: null,
      error: errorMessage(err),
    };
  }
}

function validateSnapshots(
  sitemap: SitemapSnapshot,
  listPages: EnumerationListPagesSnapshot,
): string | null {
  const sitemapCount = Object.keys(sitemap.entries).length;
  const listPagesCount = Object.keys(listPages.rows).length;
  if (sitemapCount === 0) return 'sitemap full 快照结构存在但 entries=0，拒绝当空站点';
  if (listPagesCount === 0) return 'ListPages 完整快照结构存在但 rows=0，拒绝当空站点';
  if (sitemap.lastFullAt === null || sitemap.lastFullCount === null) {
    return 'sitemap 快照没有 lastFullAt/lastFullCount，不是完整轮';
  }
  if (sitemap.lastFullCount !== sitemapCount) {
    return `sitemap lastFullCount=${sitemap.lastFullCount} ≠ entries=${sitemapCount}`;
  }
  if (listPages.remoteTotal !== listPagesCount) {
    return `ListPages remoteTotal=${listPages.remoteTotal} ≠ rows=${listPagesCount}，快照不是完整轮`;
  }
  return null;
}

function inconclusiveEnumeration(
  error: string,
  sitemap: SitemapSnapshot | null,
  listPages: EnumerationListPagesSnapshot | null,
): EnumerationTriangleReport {
  return {
    status: 'inconclusive',
    counts: { compared: 0, differences: 0, unexplained: 0 },
    alerts: [error],
    source: 'snapshots',
    differenceCountsAvailable: false,
    sitemapCount: sitemap === null ? 0 : Object.keys(sitemap.entries).length,
    listPagesCount: listPages === null ? 0 : Object.keys(listPages.rows).length,
    common: null,
    sitemapOnly: null,
    listPagesOnly: null,
    explainedSitemapOnly: null,
    explainedListPagesOnly: null,
    unexplainedSitemapOnly: null,
    unexplainedListPagesOnly: null,
    sitemapSnapshotAt: sitemap?.lastFullAt ?? null,
    listPagesSnapshotAt: listPages?.updatedAt ?? null,
    samples: [],
  };
}
