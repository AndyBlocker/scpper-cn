/**
 * M10 §3.2 三轨对账。
 *
 * - 状态对齐轨：只比较 live 当前态，v1 direction 先 sign()，tags 按集合；任一侧
 *   60 分钟内有更新的页先排除。
 * - 白名单轨：只跟踪三类已知正确差异；v1 活库的重复折叠量按日新增投票的
 *   相对增速判定，其余指标仍要求稳定不增长。
 * - 冻结轨：已删页 vote_current 每日 versioned checksum，同口径内任何变动都告警。
 *
 * v1 查询始终在 BEGIN READ ONLY 中执行。调用方传入的 v1 pool 只用于本文件的 SELECT。
 */

import type { Pool, PoolClient } from 'pg';
import { query } from '../store/db.js';
import {
  MAX_REPORT_SAMPLES,
  mergeStatus,
  sumCounts,
  type ReconcileSection,
} from './types.js';

/**
 * 2026-07-31..2026-08-04 五个完整日区间的实测 fold/new-vote 比为
 * 5.19x、6.78x、17.19x、1.97x、15.29x。25x 是实测最大值的 1.45 倍，
 * 既给活库批处理抖动留余量，也会把明显超出历史形状的折叠爆炸判红。
 */
export const V1_LATESTVOTE_FOLD_MAX_PER_NEW_VOTE = 25;

/**
 * v2：page_id/voter_id/source_row_ordinal/sign(direction)，按前三列排序，LF 拼接后 MD5。
 * v1（历史、未显式编号）不含 source_row_ordinal。
 */
export const DELETED_VOTE_CHECKSUM_VERSION = 2;
export const DELETED_VOTE_CHECKSUM_ALGORITHM =
  'md5(lf-joined page_id:voter_id:source_row_ordinal:sign(direction); order=page_id,voter_id,source_row_ordinal)';

export interface ParityPageState {
  wikidotId: number;
  slug: string;
  title: string | null;
  rating: number;
  tags: string[];
  metaUpdatedEpochMs: number | null;
  voteUpdatedEpochMs: number | null;
  voterCount: number;
  voteRating: number;
  voteChecksum: string;
  comparableVoterCount: number;
  comparableVoteRating: number;
  comparableVoteChecksum: string;
  anonymousVoterCount: number;
  anonymousVoteRating: number;
}

export interface StateAllowlistEntry {
  wikidotId: number;
  field: StateDifferenceField;
  reason: string;
  expiresAt: string | null;
}

export type StateDifferenceField = 'existence' | 'title' | 'rating' | 'tags' | 'vote_state';

export interface StateDifference {
  wikidotId: number;
  slug: string;
  fields: StateDifferenceField[];
  explainableFields: StateDifferenceField[];
  unexplainedFields: StateDifferenceField[];
  explanations: Partial<Record<StateDifferenceField, string>>;
  values: Record<string, unknown>;
}

export interface StateAlignmentReport extends ReconcileSection {
  v1Pages: number;
  v2Pages: number;
  comparablePages: number;
  lagExcludedPages: number;
  pagesWithDifferences: number;
  explainablePages: number;
  unexplainedPages: number;
  /** 全部原始差异页率；只用于归因，不参与红线。 */
  rawDiffRate: number;
  /** 未解释差异页率；0.1% 红线只作用于它。 */
  diffRate: number;
  threshold: number;
  qualified: boolean;
  fieldDifferences: Record<StateDifferenceField, number>;
  unexplainedFieldDifferences: Record<StateDifferenceField, number>;
  explanationCategoryPages: Record<string, number>;
  classificationPages: Record<string, number>;
  samples: StateDifference[];
}

export interface WhitelistTrackReport extends ReconcileSection {
  baselineEstablished: boolean;
  metrics: Record<string, number>;
  previousMetrics: Record<string, number> | null;
  growth: Record<string, number>;
  v1LatestVoteFoldDaily: V1LatestVoteFoldDailyCriterion;
}

export interface V1LatestVoteFoldDailyInput {
  baselineObservedAt: string | null;
  observedAt: string;
  newVoteRows: number | null;
}

export interface V1LatestVoteFoldDailyCriterion extends V1LatestVoteFoldDailyInput {
  multiplier: number;
  intervalDays: number | null;
  foldGrowth: number | null;
  allowedGrowth: number | null;
  exceeded: boolean | null;
}

export interface FreezeTrackReport extends ReconcileSection {
  baselineEstablished: boolean;
  deletedVoteCount: number;
  checksum: string;
  checksumVersion: number;
  checksumAlgorithm: string;
  previousDeletedVoteCount: number | null;
  previousChecksum: string | null;
  previousChecksumVersion: number | null;
  changed: boolean;
  baselineRebuilt: boolean;
}

export interface ParityReport extends ReconcileSection {
  stateAlignment: StateAlignmentReport;
  whitelist: WhitelistTrackReport;
  freeze: FreezeTrackReport;
  qualifiedDailyStreak: number;
  sevenDayGatePassed: boolean;
}

interface PriorParityReport {
  observedAt: string;
  qualified: boolean;
  whitelistMetrics: Record<string, number> | null;
  freezeChecksum: string | null;
  freezeCount: number | null;
  freezeChecksumVersion: number | null;
}

export async function runParity(
  v1Pool: Pool,
  v2Pool: Pool,
  observedAt: string,
  lagWindowMs: number,
): Promise<ParityReport> {
  const prior = await loadPriorParityReports(v2Pool);
  const previous = prior[0] ?? null;
  const previousDaily = prior.find(
    (row) =>
      row.whitelistMetrics !== null &&
      shanghaiDay(row.observedAt) < shanghaiDay(observedAt),
  ) ?? null;
  const [v1Pages, v2Pages, allowlist, whitelistCurrent, freezeCurrent] = await Promise.all([
    fetchV1ParityStates(v1Pool),
    fetchV2ParityStates(v2Pool),
    loadStateAllowlist(v2Pool, observedAt),
    fetchWhitelistMetrics(v1Pool, v2Pool, previousDaily?.observedAt ?? null, observedAt),
    fetchDeletedVoteChecksum(v2Pool),
  ]);
  const alignment = compareStateAlignment(
    v1Pages,
    v2Pages,
    Date.parse(observedAt),
    lagWindowMs,
    allowlist,
  );
  const whitelist = compareWhitelistMetrics(
    whitelistCurrent.metrics,
    previousDaily?.whitelistMetrics ?? null,
    {
      baselineObservedAt: previousDaily?.observedAt ?? null,
      observedAt,
      newVoteRows: whitelistCurrent.v1NewVoteRows,
    },
  );
  const freeze = compareFrozenChecksum(
    freezeCurrent,
    previous?.freezeChecksum ?? null,
    previous?.freezeCount ?? null,
    previous?.freezeChecksumVersion ?? null,
  );
  const qualifiedDailyStreak = computeQualifiedDailyStreak(observedAt, alignment.qualified, prior);
  const sevenDayGatePassed = qualifiedDailyStreak >= 7;
  const sections = [alignment, whitelist, freeze];
  const status = gateParityStatus(
    mergeStatus(sections.map((section) => section.status)),
    sevenDayGatePassed,
  );
  const alerts = sections.flatMap((section) => section.alerts);
  if (alignment.qualified && !sevenDayGatePassed) {
    alerts.push(`状态对齐仅连续 ${qualifiedDailyStreak}/7 天达标；未满足七日放行门`);
  }
  return {
    status: status === 'aborted' ? 'failed' : status,
    counts: sumCounts(sections),
    alerts,
    stateAlignment: alignment,
    whitelist,
    freeze,
    qualifiedDailyStreak,
    sevenDayGatePassed,
  };
}

/** 单日三轨全绿也不能越过“连续七日”门；暖机期是 partial，不是真通过。 */
export function gateParityStatus(
  base: ReturnType<typeof mergeStatus>,
  sevenDayGatePassed: boolean,
): ReturnType<typeof mergeStatus> {
  return base === 'ok' && !sevenDayGatePassed ? 'partial' : base;
}

export async function fetchV1ParityStates(pool: Pool): Promise<Map<number, ParityPageState>> {
  return withReadOnlyClient(pool, 'reconcile:v1:state', async (db) => {
    const res = await query<ParityStateRow>(
      db,
      'reconcile:v1:state-select',
      `WITH current_pages AS (
         SELECT p.id AS page_id,
                p."wikidotId" AS wikidot_id,
                p."currentUrl" AS current_url,
                pv.id AS page_version_id,
                pv.title,
                pv.rating,
                pv.tags,
                (extract(epoch FROM (
                   GREATEST(p."updatedAt", pv."updatedAt") AT TIME ZONE 'Asia/Shanghai'
                 )) * 1000)::bigint::text AS meta_updated_epoch_ms
           FROM "Page" p
           JOIN "PageVersion" pv
             ON pv."pageId" = p.id
            AND pv."validTo" IS NULL
          WHERE NOT p."isDeleted"
            AND NOT pv."isDeleted"
            AND p."wikidotId" IS NOT NULL
       ),
       vote_rows AS (
         SELECT cp.page_id,
                ('wikidot:' || u."wikidotId"::text) AS actor_key,
                sign(lv.direction)::int AS direction,
                lv.timestamp
           FROM current_pages cp
           JOIN "LatestVote" lv ON lv."pageVersionId" = cp.page_version_id
           JOIN "User" u ON u.id = lv."userId"
          WHERE u."wikidotId" IS NOT NULL
       ),
       votes AS (
         SELECT page_id,
                count(*)::int AS voter_count,
                COALESCE(sum(direction), 0)::int AS vote_rating,
                md5(COALESCE(string_agg(actor_key || ':' || direction::text, E'\\n'
                    ORDER BY actor_key), '')) AS vote_checksum,
                (extract(epoch FROM (
                   max(timestamp) AT TIME ZONE 'Asia/Shanghai'
                 )) * 1000)::bigint::text AS vote_updated_epoch_ms
           FROM vote_rows
          GROUP BY page_id
       )
       SELECT cp.wikidot_id,
              regexp_replace(cp.current_url, '^https?://[^/]+/', '') AS slug,
              cp.title,
              cp.rating,
              cp.tags,
              cp.meta_updated_epoch_ms,
              v.vote_updated_epoch_ms,
              COALESCE(v.voter_count, 0)::int AS voter_count,
              COALESCE(v.vote_rating, 0)::int AS vote_rating,
              COALESCE(v.vote_checksum, md5('')) AS vote_checksum,
              COALESCE(v.voter_count, 0)::int AS comparable_voter_count,
              COALESCE(v.vote_rating, 0)::int AS comparable_vote_rating,
              COALESCE(v.vote_checksum, md5('')) AS comparable_vote_checksum,
              0::int AS anonymous_voter_count,
              0::int AS anonymous_vote_rating
         FROM current_pages cp
         LEFT JOIN votes v ON v.page_id = cp.page_id`,
    );
    return statesFromRows(res.rows);
  });
}

export async function fetchV2ParityStates(pool: Pool): Promise<Map<number, ParityPageState>> {
  const res = await query<ParityStateRow>(
    pool,
    'reconcile:v2:state-select',
    `WITH vote_rows AS (
       SELECT vc.page_id,
              CASE
                WHEN u.wikidot_id IS NOT NULL THEN 'wikidot:' || u.wikidot_id::text
                WHEN u.anon_key IS NOT NULL THEN u.kind || ':' || u.anon_key
                ELSE 'internal:' || u.id::text
              END AS actor_key,
              (u.wikidot_id IS NOT NULL) AS actor_comparable,
              sign(vc.direction)::int AS direction,
              vc.last_voted_at
         FROM serve.vote_current vc
         JOIN ingest."user" u ON u.id = vc.voter_id
     ),
     votes AS (
       SELECT page_id,
              count(*)::int AS voter_count,
              COALESCE(sum(direction), 0)::int AS vote_rating,
              md5(COALESCE(string_agg(actor_key || ':' || direction::text, E'\\n'
                  ORDER BY actor_key), '')) AS vote_checksum,
              count(*) FILTER (WHERE actor_comparable)::int AS comparable_voter_count,
              COALESCE(sum(direction) FILTER (WHERE actor_comparable), 0)::int
                AS comparable_vote_rating,
              md5(COALESCE(
                string_agg(actor_key || ':' || direction::text, E'\\n' ORDER BY actor_key)
                  FILTER (WHERE actor_comparable),
                ''
              )) AS comparable_vote_checksum,
              count(*) FILTER (WHERE NOT actor_comparable)::int AS anonymous_voter_count,
              COALESCE(sum(direction) FILTER (WHERE NOT actor_comparable), 0)::int
                AS anonymous_vote_rating,
              (extract(epoch FROM max(last_voted_at)) * 1000)::bigint::text
                AS vote_updated_epoch_ms
         FROM vote_rows
        GROUP BY page_id
     )
     SELECT pc.wikidot_id,
            pc.slug,
            pc.title,
            pc.rating,
            pc.tags,
            CASE WHEN pc.updated_at IS NULL THEN NULL
                 ELSE (extract(epoch FROM pc.updated_at) * 1000)::bigint::text
            END AS meta_updated_epoch_ms,
            v.vote_updated_epoch_ms,
            COALESCE(v.voter_count, 0)::int AS voter_count,
            COALESCE(v.vote_rating, 0)::int AS vote_rating,
            COALESCE(v.vote_checksum, md5('')) AS vote_checksum,
            COALESCE(v.comparable_voter_count, 0)::int AS comparable_voter_count,
            COALESCE(v.comparable_vote_rating, 0)::int AS comparable_vote_rating,
            COALESCE(v.comparable_vote_checksum, md5('')) AS comparable_vote_checksum,
            COALESCE(v.anonymous_voter_count, 0)::int AS anonymous_voter_count,
            COALESCE(v.anonymous_vote_rating, 0)::int AS anonymous_vote_rating
       FROM serve.page_current pc
       LEFT JOIN votes v ON v.page_id = pc.page_id
      WHERE pc.status = 'live'`,
  );
  return statesFromRows(res.rows);
}

export function compareStateAlignment(
  v1: ReadonlyMap<number, ParityPageState>,
  v2: ReadonlyMap<number, ParityPageState>,
  observedEpochMs: number,
  lagWindowMs: number,
  allowlist: ReadonlyMap<string, StateAllowlistEntry>,
): StateAlignmentReport {
  const cutoff = observedEpochMs - lagWindowMs;
  const allIds = new Set([...v1.keys(), ...v2.keys()]);
  const fieldDifferences: Record<StateDifferenceField, number> = {
    existence: 0,
    title: 0,
    rating: 0,
    tags: 0,
    vote_state: 0,
  };
  const unexplainedFieldDifferences: Record<StateDifferenceField, number> = {
    existence: 0,
    title: 0,
    rating: 0,
    tags: 0,
    vote_state: 0,
  };
  const explanationCategoryPages: Record<string, number> = {};
  const classificationPages: Record<string, number> = {};
  const samples: StateDifference[] = [];
  let comparablePages = 0;
  let lagExcludedPages = 0;
  let pagesWithDifferences = 0;
  let explainablePages = 0;
  let unexplainedPages = 0;

  for (const wid of allIds) {
    const left = v1.get(wid);
    const right = v2.get(wid);
    const recent =
      isRecent(left, cutoff) ||
      isRecent(right, cutoff);
    if (recent) {
      lagExcludedPages++;
      continue;
    }
    comparablePages++;
    const fields: StateDifferenceField[] = [];
    const values: Record<string, unknown> = {};
    if (left === undefined || right === undefined) {
      fields.push('existence');
      values['existence'] = { v1: left !== undefined, v2: right !== undefined };
    } else {
      if (left.title !== right.title) {
        fields.push('title');
        values['title'] = { v1: left.title, v2: right.title };
      }
      if (left.rating !== right.rating) {
        fields.push('rating');
        values['rating'] = { v1: left.rating, v2: right.rating };
      }
      if (!sameStringSet(left.tags, right.tags)) {
        fields.push('tags');
        values['tags'] = { v1: normalizeStringSet(left.tags), v2: normalizeStringSet(right.tags) };
      }
      if (
        left.voterCount !== right.voterCount ||
        left.voteRating !== right.voteRating ||
        left.voteChecksum !== right.voteChecksum
      ) {
        fields.push('vote_state');
        values['vote_state'] = {
          v1: {
            count: left.voterCount,
            rating: left.voteRating,
            checksum: left.voteChecksum,
          },
          v2: {
            count: right.voterCount,
            rating: right.voteRating,
            checksum: right.voteChecksum,
          },
        };
      }
    }
    if (fields.length === 0) continue;
    pagesWithDifferences++;
    for (const field of fields) fieldDifferences[field]++;
    const explanations: Partial<Record<StateDifferenceField, string>> = {};
    for (const field of fields) {
      const builtIn = builtInExplanation(field, left, right);
      const operator = allowlist.get(`${wid}:${field}`)?.reason;
      if (builtIn !== null) explanations[field] = builtIn;
      else if (operator !== undefined) explanations[field] = `operator_allowlist:${operator}`;
    }
    const explainableFields = fields.filter((field) => explanations[field] !== undefined);
    const unexplainedFields = fields.filter((field) => explanations[field] === undefined);
    for (const field of unexplainedFields) unexplainedFieldDifferences[field]++;
    const pageCategories = new Set(
      explainableFields.map((field) => explanationCategory(explanations[field]!)),
    );
    for (const category of pageCategories) incrementCount(explanationCategoryPages, category);
    const classification = [
      ...(pageCategories.size > 0 ? [`explained:${[...pageCategories].sort().join('+')}`] : []),
      ...(unexplainedFields.length > 0
        ? [`unexplained:${[...unexplainedFields].sort().join('+')}`]
        : []),
    ].join('|');
    incrementCount(classificationPages, classification);
    if (unexplainedFields.length === 0) explainablePages++;
    else unexplainedPages++;
    if (samples.length < MAX_REPORT_SAMPLES) {
      samples.push({
        wikidotId: wid,
        slug: right?.slug ?? left?.slug ?? `(wid:${wid})`,
        fields,
        explainableFields,
        unexplainedFields,
        explanations,
        values,
      });
    }
  }

  const rawDiffRate = comparablePages === 0 ? 1 : pagesWithDifferences / comparablePages;
  const diffRate = comparablePages === 0 ? 1 : unexplainedPages / comparablePages;
  const threshold = 0.001;
  const qualified = comparablePages > 0 && diffRate < threshold && unexplainedPages === 0;
  const alerts: string[] = [];
  if (comparablePages === 0) alerts.push('状态对齐没有可比较 live 页，拒绝真空通过');
  if (diffRate >= threshold) {
    alerts.push(`状态对齐未解释 diff ${(diffRate * 100).toFixed(4)}% 未低于 0.1%`);
  }
  if (unexplainedPages > 0) alerts.push(`状态对齐有 ${unexplainedPages} 页未解释差异`);

  return {
    status: qualified ? 'ok' : 'failed',
    counts: {
      compared: comparablePages,
      differences: pagesWithDifferences,
      unexplained: unexplainedPages,
    },
    alerts,
    v1Pages: v1.size,
    v2Pages: v2.size,
    comparablePages,
    lagExcludedPages,
    pagesWithDifferences,
    explainablePages,
    unexplainedPages,
    rawDiffRate,
    diffRate,
    threshold,
    qualified,
    fieldDifferences,
    unexplainedFieldDifferences,
    explanationCategoryPages,
    classificationPages,
    samples,
  };
}

export async function loadStateAllowlist(
  pool: Pool,
  observedAt: string,
): Promise<Map<string, StateAllowlistEntry>> {
  const res = await query<{ metric: string; detail: unknown }>(
    pool,
    'reconcile:allowlist',
    `SELECT metric, detail
       FROM meta.v2_baseline
      WHERE metric LIKE 'reconcile.allow.%'
        AND detail IS NOT NULL`,
  );
  const now = Date.parse(observedAt);
  const out = new Map<string, StateAllowlistEntry>();
  for (const row of res.rows) {
    if (!isRecord(row.detail)) continue;
    const wid = Number(row.detail['wikidotId']);
    const field = row.detail['field'];
    const reason = row.detail['reason'];
    const enabled = row.detail['enabled'] !== false;
    const expiresAt = typeof row.detail['expiresAt'] === 'string' ? row.detail['expiresAt'] : null;
    if (
      !enabled ||
      !Number.isSafeInteger(wid) ||
      wid <= 0 ||
      !isDifferenceField(field) ||
      typeof reason !== 'string' ||
      reason.trim() === '' ||
      (expiresAt !== null && Date.parse(expiresAt) <= now)
    ) {
      continue;
    }
    out.set(`${wid}:${field}`, {
      wikidotId: wid,
      field,
      reason: reason.trim(),
      expiresAt,
    });
  }
  return out;
}

export async function fetchWhitelistMetrics(
  v1Pool: Pool,
  v2Pool: Pool,
  baselineObservedAt: string | null,
  observedAt: string,
): Promise<{ metrics: Record<string, number>; v1NewVoteRows: number | null }> {
  const voteDayStart = baselineObservedAt === null ? null : shanghaiDay(baselineObservedAt);
  const voteDayEnd = shanghaiDay(observedAt);
  const [v1, v2] = await Promise.all([
    withReadOnlyClient(v1Pool, 'reconcile:v1:whitelist', async (db) => {
      const res = await query<{
        raw_rows: string;
        folded_pairs: string;
        new_vote_rows: string | null;
      }>(
        db,
        'reconcile:v1:whitelist-select',
        `SELECT
           (SELECT count(*)::bigint::text
              FROM "LatestVote" lv
              JOIN "PageVersion" pv ON pv.id = lv."pageVersionId") AS raw_rows,
           (SELECT count(DISTINCT (pv."pageId", lv."userId"))::bigint::text
              FROM "LatestVote" lv
              JOIN "PageVersion" pv ON pv.id = lv."pageVersionId") AS folded_pairs,
           CASE WHEN $1::date IS NULL OR $1::date >= $2::date THEN NULL
                ELSE (SELECT count(*)::bigint::text
                        FROM "Vote" v
                       WHERE v.timestamp >= $1::date
                         AND v.timestamp < $2::date)
            END AS new_vote_rows`,
        [voteDayStart, voteDayEnd],
      );
      return res.rows[0] ?? { raw_rows: '0', folded_pairs: '0', new_vote_rows: null };
    }),
    query<{
      deleted_vote_pairs: string;
      imprecise_events: string;
      bootstrap_events: string;
    }>(
      v2Pool,
      'reconcile:v2:whitelist-select',
      `SELECT
         (SELECT count(*)::bigint::text
            FROM serve.vote_current vc
            JOIN serve.page_current pc ON pc.page_id = vc.page_id
           WHERE pc.status = 'deleted') AS deleted_vote_pairs,
         (SELECT count(*)::bigint::text
            FROM ingest.vote_event
           WHERE time_precision IN ('day', 'clamped', 'bootstrap')) AS imprecise_events,
         (SELECT count(*)::bigint::text
            FROM ingest.vote_event
           WHERE time_precision = 'bootstrap') AS bootstrap_events`,
    ),
  ]);
  const v2row = v2.rows[0] ?? {
    deleted_vote_pairs: '0',
    imprecise_events: '0',
    bootstrap_events: '0',
  };
  return {
    metrics: {
      deleted_page_vote_pairs: Number(v2row.deleted_vote_pairs),
      v1_latestvote_fold_delta: Number(v1.raw_rows) - Number(v1.folded_pairs),
      imprecise_vote_events: Number(v2row.imprecise_events),
      bootstrap_vote_events: Number(v2row.bootstrap_events),
    },
    v1NewVoteRows: v1.new_vote_rows === null ? null : Number(v1.new_vote_rows),
  };
}

export function compareWhitelistMetrics(
  metrics: Record<string, number>,
  previous: Record<string, number> | null,
  foldInput: V1LatestVoteFoldDailyInput = {
    baselineObservedAt: null,
    observedAt: new Date(0).toISOString(),
    newVoteRows: null,
  },
): WhitelistTrackReport {
  const foldDaily = buildFoldDailyCriterion(metrics, previous, foldInput);
  if (previous === null) {
    return {
      status: 'partial',
      counts: { compared: Object.keys(metrics).length, differences: 0, unexplained: 0 },
      alerts: ['白名单轨首次建立日基线；需下一日验证相对增量/稳定不增长判据'],
      baselineEstablished: false,
      metrics,
      previousMetrics: null,
      growth: {},
      v1LatestVoteFoldDaily: foldDaily,
    };
  }
  const growth: Record<string, number> = {};
  const alerts: string[] = [];
  for (const [metric, current] of Object.entries(metrics)) {
    const before = previous[metric];
    if (before === undefined || current <= before) continue;
    const delta = current - before;
    growth[metric] = delta;
    if (metric === 'v1_latestvote_fold_delta' && foldDaily.allowedGrowth !== null) {
      if (foldDaily.exceeded) {
        alerts.push(
          `白名单指标 v1_latestvote_fold_delta 日增量 +${delta} > ` +
            `v1 新增投票 ${foldDaily.newVoteRows} × ${foldDaily.multiplier} = ` +
            `${foldDaily.allowedGrowth}，折叠增长异常`,
        );
      }
      continue;
    }
    alerts.push(`白名单指标 ${metric} 增长 +${delta}，不满足“稳定不增长”`);
  }
  const criterionUnavailable =
    growth['v1_latestvote_fold_delta'] !== undefined && foldDaily.allowedGrowth === null;
  if (criterionUnavailable) {
    alerts.push('v1_latestvote_fold_delta 缺少上一日基线/新增投票分母，本轮只重建日判据基线');
  }
  return {
    status: criterionUnavailable ? 'partial' : alerts.length === 0 ? 'ok' : 'failed',
    counts: {
      compared: Object.keys(metrics).length,
      differences: criterionUnavailable ? 0 : alerts.length,
      // 这些仍是已知白名单类型，不把它伪装成未知逻辑差异；增长单独以 status=failed 告警。
      unexplained: 0,
    },
    alerts,
    baselineEstablished: true,
    metrics,
    previousMetrics: previous,
    growth,
    v1LatestVoteFoldDaily: foldDaily,
  };
}

function buildFoldDailyCriterion(
  metrics: Record<string, number>,
  previous: Record<string, number> | null,
  input: V1LatestVoteFoldDailyInput,
): V1LatestVoteFoldDailyCriterion {
  const current = metrics['v1_latestvote_fold_delta'];
  const before = previous?.['v1_latestvote_fold_delta'];
  const foldGrowth =
    current === undefined || before === undefined ? null : Math.max(0, current - before);
  const validNewVotes =
    input.newVoteRows !== null && Number.isSafeInteger(input.newVoteRows) && input.newVoteRows >= 0;
  const allowedGrowth = validNewVotes
    ? input.newVoteRows! * V1_LATESTVOTE_FOLD_MAX_PER_NEW_VOTE
    : null;
  const baselineDay =
    input.baselineObservedAt === null ? null : dayNumber(shanghaiDay(input.baselineObservedAt));
  const observedDay = dayNumber(shanghaiDay(input.observedAt));
  return {
    ...input,
    multiplier: V1_LATESTVOTE_FOLD_MAX_PER_NEW_VOTE,
    intervalDays: baselineDay === null ? null : Math.max(0, observedDay - baselineDay),
    foldGrowth,
    allowedGrowth,
    exceeded:
      foldGrowth === null || allowedGrowth === null ? null : foldGrowth > allowedGrowth,
  };
}

export async function fetchDeletedVoteChecksum(
  pool: Pool,
): Promise<{ count: number; checksum: string; version: number; algorithm: string }> {
  const res = await query<{ vote_count: string; checksum: string }>(
    pool,
    'reconcile:freeze-checksum',
    `SELECT count(*)::bigint::text AS vote_count,
            md5(COALESCE(string_agg(
              vc.page_id::text || ':' || vc.voter_id::text || ':' ||
                vc.source_row_ordinal::text || ':' || sign(vc.direction)::text,
              E'\\n' ORDER BY vc.page_id, vc.voter_id, vc.source_row_ordinal
            ), '')) AS checksum
       FROM serve.vote_current vc
       JOIN serve.page_current pc ON pc.page_id = vc.page_id
      WHERE pc.status = 'deleted'`,
  );
  const row = res.rows[0] ?? { vote_count: '0', checksum: '' };
  return {
    count: Number(row.vote_count),
    checksum: row.checksum,
    version: DELETED_VOTE_CHECKSUM_VERSION,
    algorithm: DELETED_VOTE_CHECKSUM_ALGORITHM,
  };
}

export function compareFrozenChecksum(
  current: { count: number; checksum: string; version: number; algorithm?: string },
  previousChecksum: string | null,
  previousCount: number | null,
  previousVersion: number | null = null,
): FreezeTrackReport {
  const algorithm = current.algorithm ?? DELETED_VOTE_CHECKSUM_ALGORITHM;
  if (previousChecksum === null || previousCount === null) {
    return {
      status: 'partial',
      counts: { compared: current.count, differences: 0, unexplained: 0 },
      alerts: ['冻结轨首次建立已删页 vote_current checksum'],
      baselineEstablished: false,
      deletedVoteCount: current.count,
      checksum: current.checksum,
      checksumVersion: current.version,
      checksumAlgorithm: algorithm,
      previousDeletedVoteCount: null,
      previousChecksum: null,
      previousChecksumVersion: null,
      changed: false,
      baselineRebuilt: false,
    };
  }
  if (previousVersion !== current.version) {
    return {
      status: 'partial',
      counts: { compared: current.count, differences: 0, unexplained: 0 },
      alerts: [
        `已删页 vote_current 冻结 checksum 口径升级：` +
          `${previousVersion === null ? 'legacy-unversioned' : `v${previousVersion}`} → ` +
          `v${current.version}；按新口径基线重建，非数据变化告警`,
      ],
      baselineEstablished: false,
      deletedVoteCount: current.count,
      checksum: current.checksum,
      checksumVersion: current.version,
      checksumAlgorithm: algorithm,
      previousDeletedVoteCount: previousCount,
      previousChecksum,
      previousChecksumVersion: previousVersion,
      changed: false,
      baselineRebuilt: true,
    };
  }
  const changed = current.checksum !== previousChecksum || current.count !== previousCount;
  const compared = Math.max(current.count, previousCount, changed ? 1 : 0);
  return {
    status: changed ? 'failed' : 'ok',
    counts: {
      compared,
      differences: changed ? 1 : 0,
      unexplained: changed ? 1 : 0,
    },
    alerts: changed
      ? [
          `已删页 vote_current 冻结 checksum 变化：` +
            `v${current.version} ${previousCount}/${previousChecksum} → ` +
            `${current.count}/${current.checksum}`,
        ]
      : [],
    baselineEstablished: true,
    deletedVoteCount: current.count,
    checksum: current.checksum,
    checksumVersion: current.version,
    checksumAlgorithm: algorithm,
    previousDeletedVoteCount: previousCount,
    previousChecksum,
    previousChecksumVersion: previousVersion,
    changed,
    baselineRebuilt: false,
  };
}

export function computeQualifiedDailyStreak(
  currentObservedAt: string,
  currentQualified: boolean,
  previous: ReadonlyArray<{ observedAt: string; qualified: boolean }>,
): number {
  if (!currentQualified) return 0;
  const byDay = new Map<string, boolean>();
  byDay.set(shanghaiDay(currentObservedAt), true);
  for (const row of previous) {
    const day = shanghaiDay(row.observedAt);
    byDay.set(day, (byDay.get(day) ?? false) || row.qualified);
  }
  let streak = 0;
  let day = dayNumber(shanghaiDay(currentObservedAt));
  while (byDay.get(dayString(day)) === true) {
    streak++;
    day--;
  }
  return streak;
}

async function loadPriorParityReports(pool: Pool): Promise<PriorParityReport[]> {
  const res = await query<{ observed_at: string; report: unknown }>(
    pool,
    'reconcile:prior-reports',
    `SELECT observed_at::text, report
       FROM meta.reconcile_report
      WHERE mode IN ('all', 'parity')
      ORDER BY observed_at DESC
      LIMIT 40`,
  );
  const out: PriorParityReport[] = [];
  for (const row of res.rows) {
    if (!isRecord(row.report) || !isRecord(row.report['parity'])) continue;
    const parity = row.report['parity'];
    const alignment = isRecord(parity['stateAlignment']) ? parity['stateAlignment'] : {};
    const whitelist = isRecord(parity['whitelist']) ? parity['whitelist'] : {};
    const freeze = isRecord(parity['freeze']) ? parity['freeze'] : {};
    out.push({
      observedAt: row.observed_at,
      qualified: alignment['qualified'] === true,
      whitelistMetrics: numericRecord(whitelist['metrics']),
      freezeChecksum: typeof freeze['checksum'] === 'string' ? freeze['checksum'] : null,
      freezeCount:
        typeof freeze['deletedVoteCount'] === 'number' ? freeze['deletedVoteCount'] : null,
      freezeChecksumVersion:
        typeof freeze['checksumVersion'] === 'number' &&
        Number.isSafeInteger(freeze['checksumVersion'])
          ? freeze['checksumVersion']
          : null,
    });
  }
  return out;
}

interface ParityStateRow {
  wikidot_id: number;
  slug: string;
  title: string | null;
  rating: number;
  tags: string[];
  meta_updated_epoch_ms: string | null;
  vote_updated_epoch_ms: string | null;
  voter_count: number;
  vote_rating: number;
  vote_checksum: string;
  comparable_voter_count: number;
  comparable_vote_rating: number;
  comparable_vote_checksum: string;
  anonymous_voter_count: number;
  anonymous_vote_rating: number;
}

function statesFromRows(rows: readonly ParityStateRow[]): Map<number, ParityPageState> {
  const out = new Map<number, ParityPageState>();
  for (const row of rows) {
    const wid = Number(row.wikidot_id);
    if (out.has(wid)) throw new Error(`对账状态出现重复 wikidot_id=${wid}，拒绝静默覆盖`);
    out.set(wid, {
      wikidotId: wid,
      slug: row.slug,
      title: row.title,
      rating: Number(row.rating),
      tags: Array.isArray(row.tags) ? row.tags : [],
      metaUpdatedEpochMs:
        row.meta_updated_epoch_ms === null ? null : Number(row.meta_updated_epoch_ms),
      voteUpdatedEpochMs:
        row.vote_updated_epoch_ms === null ? null : Number(row.vote_updated_epoch_ms),
      voterCount: Number(row.voter_count),
      voteRating: Number(row.vote_rating),
      voteChecksum: row.vote_checksum,
      comparableVoterCount: Number(row.comparable_voter_count),
      comparableVoteRating: Number(row.comparable_vote_rating),
      comparableVoteChecksum: row.comparable_vote_checksum,
      anonymousVoterCount: Number(row.anonymous_voter_count),
      anonymousVoteRating: Number(row.anonymous_vote_rating),
    });
  }
  return out;
}

async function withReadOnlyClient<T>(
  pool: Pool,
  label: string,
  fn: (db: PoolClient) => Promise<T>,
): Promise<T> {
  const db = await pool.connect();
  try {
    await db.query('BEGIN READ ONLY');
    const value = await fn(db);
    await db.query('COMMIT');
    return value;
  } catch (err) {
    await db.query('ROLLBACK').catch(() => undefined);
    throw new Error(`${label} 失败（v1 事务保持 READ ONLY）：${String(err)}`);
  } finally {
    db.release();
  }
}

function isRecent(state: ParityPageState | undefined, cutoff: number): boolean {
  if (state === undefined) return false;
  return [state.metaUpdatedEpochMs, state.voteUpdatedEpochMs].some(
    (value) => value !== null && Number.isFinite(value) && value >= cutoff,
  );
}

function normalizeStringSet(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function sameStringSet(a: readonly string[], b: readonly string[]): boolean {
  const aa = normalizeStringSet(a);
  const bb = normalizeStringSet(b);
  return aa.length === bb.length && aa.every((value, index) => value === bb[index]);
}

function builtInExplanation(
  field: StateDifferenceField,
  v1: ParityPageState | undefined,
  v2: ParityPageState | undefined,
): string | null {
  if (v1 === undefined || v2 === undefined) return null;
  if (
    field === 'tags' &&
    sameStringSet(
      v1.tags.filter((tag) => !tag.startsWith('crom:')),
      v2.tags.filter((tag) => !tag.startsWith('crom:')),
    )
  ) {
    return 'v1_crom_synthetic_tags:仅 v1 含 crom:* 来源派生标签；Wikidot 直接标签集合一致';
  }
  if (
    field === 'title' &&
    normalizeSourceTitle(v1.title) === normalizeSourceTitle(v2.title)
  ) {
    return 'source_title_unicode_whitespace:v1/CROM 与 Wikidot 直接标题仅 Unicode/空白归一不同';
  }
  if (
    field === 'rating' &&
    v1.voteRating === v2.voteRating &&
    v2.rating === v2.voteRating
  ) {
    return 'v1_pageversion_rating_stale:两侧当前票和与 v2 rating 一致，仅 v1 PageVersion.rating 滞后';
  }
  if (
    field === 'vote_state' &&
    v2.anonymousVoterCount > 0 &&
    v1.comparableVoterCount === v2.comparableVoterCount &&
    v1.comparableVoteRating === v2.comparableVoteRating &&
    v1.comparableVoteChecksum === v2.comparableVoteChecksum
  ) {
    return (
      'v2_anonymous_actor_space:共享 Wikidot actor 子集完全一致；' +
      `v2 另有匿名 actor ${v2.anonymousVoterCount} 人/${v2.anonymousVoteRating} 分`
    );
  }
  return null;
}

function normalizeSourceTitle(value: string | null): string | null {
  return value === null ? null : value.replace(/\s+/gu, ' ').trim();
}

function explanationCategory(explanation: string): string {
  return explanation.split(':', 1)[0] ?? explanation;
}

function incrementCount(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

function isDifferenceField(value: unknown): value is StateDifferenceField {
  return (
    value === 'existence' ||
    value === 'title' ||
    value === 'rating' ||
    value === 'tags' ||
    value === 'vote_state'
  );
}

function numericRecord(value: unknown): Record<string, number> | null {
  if (!isRecord(value)) return null;
  const out: Record<string, number> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'number' || !Number.isFinite(item)) return null;
    out[key] = item;
  }
  return out;
}

function shanghaiDay(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`非法对账时间：${value}`);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function dayNumber(day: string): number {
  const [year, month, date] = day.split('-').map(Number);
  return Math.floor(Date.UTC(year!, month! - 1, date!) / 86_400_000);
}

function dayString(day: number): string {
  return new Date(day * 86_400_000).toISOString().slice(0, 10);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
