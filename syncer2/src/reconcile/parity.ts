/**
 * M10 §3.2 三轨对账。
 *
 * - 状态对齐轨：只比较 live 当前态，v1 direction 先 sign()，tags 按集合；任一侧
 *   60 分钟内有更新的页先排除。
 * - 白名单轨：只跟踪三类已知正确差异；v1 活库的重复折叠量按至少七个完整日的
 *   滚动窗口判定，其余指标仍要求稳定不增长。
 * - 冻结轨：只比较上轮已经属于已删集合的 vote_current；本轮新删页进入下一轮基线，
 *   不把集合新增误报成历史内容变化。
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

/** 保留 RECON2 的 25x 形状红线，只把分母从单日改为至少七日滚动窗口。 */
export const V1_LATESTVOTE_FOLD_MAX_PER_NEW_VOTE = 25;
export const V1_LATESTVOTE_FOLD_WINDOW_DAYS = 7;

/**
 * v1 活库测试曾铸入、但站上不存在的图片测试页。名单与理由全部在源码中可枚举；
 * 回归测试锁定整个清单，任何新增都会先使测试失败。
 */
export const V1_SYNTHETIC_TEST_PAGE_ALLOWLIST = new Map<number, string>([
  [800019414, 'test-image-page-1759148576016'],
  [800080727, 'test-image-page-1759149352271'],
  [800041112, 'test-image-page-1759413342363'],
]);

/**
 * v2：page_id/voter_id/source_row_ordinal/sign(direction)，按前三列排序，LF 拼接后 MD5。
 * v1（历史、未显式编号）不含 source_row_ordinal。
 */
export const DELETED_VOTE_CHECKSUM_VERSION = 3;
export const DELETED_VOTE_CHECKSUM_ALGORITHM =
  'md5(lf-joined page_id:voter_id:source_row_ordinal:sign(direction); ' +
  'order=page_id,voter_id,source_row_ordinal); baseline=all deleted; ' +
  'comparison=members whose lifecycle status at previous report was deleted, ' +
  'including identities legitimately restored since that report';

export interface ParityPageState {
  wikidotId: number;
  slug: string;
  title: string | null;
  rating: number;
  tags: string[];
  /** 页面是否属于完整 ListPages 的可枚举域；隐藏系统页不参与 existence 缺失推断。 */
  enumerationScope: 'standard' | 'listpages_hidden';
  /** Wikidot L0 声明的站上更新时间，不是 v2 投影写入时钟。 */
  metaUpdatedEpochMs: number | null;
  /** 最近一次完整 ListPages 直接看到该 live slug 的时间。 */
  l1SeenEpochMs: number | null;
  titleDirectObserved: boolean;
  tagsDirectObserved: boolean;
  voteUpdatedEpochMs: number | null;
  voterCount: number;
  voteRating: number;
  voteChecksum: string;
  comparableVoterCount: number;
  comparableVoteRating: number;
  comparableVoteChecksum: string;
  anonymousVoterCount: number;
  anonymousVoteRating: number;
  /** 当前 v2 行逐条来自同一个完整 WhoRated 多重集快照，且行数/评分通过 L1 双门。 */
  verifiedMultisetSnapshot: boolean;
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
  v1LatestVoteFoldWindow: V1LatestVoteFoldWindowCriterion;
}

export interface V1LatestVoteFoldWindowInput {
  baselineObservedAt: string | null;
  baselineFoldDelta: number | null;
  observedAt: string;
  windowVoteRows: number | null;
}

export interface V1LatestVoteFoldWindowCriterion extends V1LatestVoteFoldWindowInput {
  multiplier: number;
  minimumWindowDays: number;
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
  protectedDeletedVoteCount: number;
  protectedChecksum: string;
  newMemberVoteCount: number;
  membershipCutoff: string | null;
  changed: boolean;
  baselineRebuilt: boolean;
}

export interface DeletedVoteChecksum {
  /** 本轮全体已删成员；持久化为下一轮基线。 */
  count: number;
  checksum: string;
  /** 上轮时点为 deleted 的精确成员；本轮已恢复者仍须参与内容冻结复核。 */
  protectedCount: number;
  protectedChecksum: string;
  newMemberVoteCount: number;
  membershipCutoff: string | null;
  version: number;
  algorithm: string;
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
  const observedDayNumber = dayNumber(shanghaiDay(observedAt));
  const foldWindowBaseline = prior.find(
    (row) =>
      row.whitelistMetrics !== null &&
      dayNumber(shanghaiDay(row.observedAt)) <=
        observedDayNumber - V1_LATESTVOTE_FOLD_WINDOW_DAYS,
  ) ?? null;
  const [v1Pages, v2Pages, allowlist, whitelistCurrent, freezeCurrent] = await Promise.all([
    fetchV1ParityStates(v1Pool),
    fetchV2ParityStates(v2Pool),
    loadStateAllowlist(v2Pool, observedAt),
    fetchWhitelistMetrics(v1Pool, v2Pool, foldWindowBaseline?.observedAt ?? null, observedAt),
    fetchDeletedVoteChecksum(v2Pool, previous?.observedAt ?? null),
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
      baselineFoldDelta:
        foldWindowBaseline?.whitelistMetrics?.['v1_latestvote_fold_delta'] ?? null,
      baselineObservedAt: foldWindowBaseline?.observedAt ?? null,
      observedAt,
      windowVoteRows: whitelistCurrent.v1WindowVoteRows,
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
            AND lv.direction <> 0
       ),
       votes AS (
         SELECT page_id,
                count(*)::int AS voter_count,
                COALESCE(sum(direction), 0)::int AS vote_rating,
                md5(COALESCE(string_agg(actor_key || ':' || direction::text, E'\\n'
                    ORDER BY actor_key, direction), '')) AS vote_checksum,
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
              0::int AS anonymous_vote_rating,
              NULL::text AS l1_seen_epoch_ms,
              false AS title_direct_observed,
              false AS tags_direct_observed,
              'standard'::text AS enumeration_scope,
              false AS verified_multiset_snapshot
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
              vc.voter_id,
              vc.source_row_ordinal,
              vc.snapshot_hash,
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
        WHERE vc.direction <> 0
     ),
     votes AS (
       SELECT page_id,
              count(*)::int AS voter_count,
              COALESCE(sum(direction), 0)::int AS vote_rating,
              md5(COALESCE(string_agg(actor_key || ':' || direction::text, E'\\n'
                  ORDER BY actor_key, direction), '')) AS vote_checksum,
              count(*) FILTER (WHERE actor_comparable)::int AS comparable_voter_count,
              COALESCE(sum(direction) FILTER (WHERE actor_comparable), 0)::int
                AS comparable_vote_rating,
              md5(COALESCE(
                string_agg(
                  actor_key || ':' || direction::text,
                  E'\\n' ORDER BY actor_key, direction
                )
                  FILTER (WHERE actor_comparable),
                ''
              )) AS comparable_vote_checksum,
              count(*) FILTER (WHERE NOT actor_comparable)::int AS anonymous_voter_count,
              COALESCE(sum(direction) FILTER (WHERE NOT actor_comparable), 0)::int
                AS anonymous_vote_rating,
              bool_and(source_row_ordinal > 0) AS all_rows_ordinalled,
              count(DISTINCT snapshot_hash)::int AS snapshot_hash_count,
              min(encode(snapshot_hash, 'hex')) AS snapshot_hash_hex,
              (extract(epoch FROM max(last_voted_at)) * 1000)::bigint::text
                AS vote_updated_epoch_ms
         FROM vote_rows
        GROUP BY page_id
     ), latest_vote_scan AS (
       SELECT DISTINCT ON (ps.page_id)
              ps.page_id,
              ps.status,
              ps.claimed_total,
              ps.fetched_total,
              ps.checksum_ok,
              ps.checksum_actual,
              encode(ps.result_hash, 'hex') AS result_hash_hex
         FROM meta.page_scan ps
        WHERE ps.kind = 'votes'
        ORDER BY ps.page_id, ps.scanned_at DESC, ps.run_id DESC
     ), current_attrs AS (
       SELECT pah.page_id,
              bool_or(pah.attr = 'title' AND pah.source = 'observed')
                AS title_direct_observed,
              bool_or(pah.attr = 'tags' AND pah.source = 'observed')
                AS tags_direct_observed
         FROM ingest.page_attr_history pah
        WHERE pah.valid_to IS NULL
          AND pah.attr IN ('title', 'tags')
        GROUP BY pah.page_id
     ), latest_meta_scan AS (
       SELECT DISTINCT ON (ps.page_id) ps.page_id, ps.status, ps.scanned_at
         FROM meta.page_scan ps
        WHERE ps.kind = 'meta'
        ORDER BY ps.page_id, ps.scanned_at DESC, ps.run_id DESC
     )
     SELECT pc.wikidot_id,
            pc.slug,
            pc.title,
            pc.rating,
            pc.tags,
            pc.enumeration_scope,
            CASE WHEN ips.last_l0_updated_at IS NULL THEN NULL
                 ELSE (extract(epoch FROM ips.last_l0_updated_at) * 1000)::bigint::text
            END AS meta_updated_epoch_ms,
            CASE WHEN GREATEST(
                        ips.last_l1_seen_at,
                        CASE WHEN ms.status = 'ok' THEN ms.scanned_at END
                      ) IS NULL THEN NULL
                 ELSE (extract(epoch FROM GREATEST(
                         ips.last_l1_seen_at,
                         CASE WHEN ms.status = 'ok' THEN ms.scanned_at END
                       )) * 1000)::bigint::text
            END AS l1_seen_epoch_ms,
            COALESCE(ca.title_direct_observed, false) AS title_direct_observed,
            COALESCE(ca.tags_direct_observed, false) AS tags_direct_observed,
            v.vote_updated_epoch_ms,
            COALESCE(v.voter_count, 0)::int AS voter_count,
            COALESCE(v.vote_rating, 0)::int AS vote_rating,
            COALESCE(v.vote_checksum, md5('')) AS vote_checksum,
            COALESCE(v.comparable_voter_count, 0)::int AS comparable_voter_count,
            COALESCE(v.comparable_vote_rating, 0)::int AS comparable_vote_rating,
            COALESCE(v.comparable_vote_checksum, md5('')) AS comparable_vote_checksum,
            COALESCE(v.anonymous_voter_count, 0)::int AS anonymous_voter_count,
            COALESCE(v.anonymous_vote_rating, 0)::int AS anonymous_vote_rating,
            COALESCE(
              vs.status = 'ok'
              AND vs.claimed_total = v.voter_count
              AND vs.fetched_total = v.voter_count
              AND vs.checksum_ok
              AND vs.checksum_actual = v.vote_rating
              AND v.all_rows_ordinalled
              AND v.snapshot_hash_count = 1
              AND vs.result_hash_hex = v.snapshot_hash_hex,
              false
            ) AS verified_multiset_snapshot
       FROM serve.page_current pc
       LEFT JOIN votes v ON v.page_id = pc.page_id
       LEFT JOIN latest_vote_scan vs ON vs.page_id = pc.page_id
       LEFT JOIN meta.incremental_page_state ips
         ON ips.page_id = pc.page_id AND ips.slug = pc.slug
       LEFT JOIN current_attrs ca ON ca.page_id = pc.page_id
       LEFT JOIN latest_meta_scan ms ON ms.page_id = pc.page_id
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
    if (left === undefined && right?.enumerationScope === 'listpages_hidden') {
      incrementCount(classificationPages, 'excluded:listpages_hidden');
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
      const builtIn = builtInExplanation(field, left, right, cutoff);
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
  windowBaselineObservedAt: string | null,
  observedAt: string,
): Promise<{ metrics: Record<string, number>; v1WindowVoteRows: number | null }> {
  const voteDayStart =
    windowBaselineObservedAt === null ? null : shanghaiDay(windowBaselineObservedAt);
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
    v1WindowVoteRows: v1.new_vote_rows === null ? null : Number(v1.new_vote_rows),
  };
}

export function compareWhitelistMetrics(
  metrics: Record<string, number>,
  previous: Record<string, number> | null,
  foldInput: V1LatestVoteFoldWindowInput = {
    baselineObservedAt: null,
    baselineFoldDelta: null,
    observedAt: new Date(0).toISOString(),
    windowVoteRows: null,
  },
): WhitelistTrackReport {
  const foldWindow = buildFoldWindowCriterion(metrics, foldInput);
  if (previous === null) {
    return {
      status: 'partial',
      counts: { compared: Object.keys(metrics).length, differences: 0, unexplained: 0 },
      alerts: ['白名单轨首次建立日基线；需积累滚动窗口并验证稳定不增长判据'],
      baselineEstablished: false,
      metrics,
      previousMetrics: null,
      growth: {},
      v1LatestVoteFoldWindow: foldWindow,
    };
  }
  const growth: Record<string, number> = {};
  const alerts: string[] = [];
  for (const [metric, current] of Object.entries(metrics)) {
    const before = previous[metric];
    if (before === undefined || current <= before) continue;
    const delta = current - before;
    growth[metric] = delta;
    if (metric === 'v1_latestvote_fold_delta' || metric === 'deleted_page_vote_pairs') continue;
    alerts.push(`白名单指标 ${metric} 增长 +${delta}，不满足“稳定不增长”`);
  }
  const hasFoldMetric = metrics['v1_latestvote_fold_delta'] !== undefined;
  const criterionUnavailable = hasFoldMetric && foldWindow.allowedGrowth === null;
  if (criterionUnavailable) {
    alerts.push('v1_latestvote_fold_delta 尚无至少七日的完整滚动窗口，本轮只积累判据基线');
  } else if (foldWindow.exceeded) {
    alerts.push(
      `白名单指标 v1_latestvote_fold_delta 滚动 ${foldWindow.intervalDays} 日增长 ` +
        `+${foldWindow.foldGrowth} > 同窗 v1 新增投票 ${foldWindow.windowVoteRows} × ` +
        `${foldWindow.multiplier} = ${foldWindow.allowedGrowth}，折叠增长趋势异常`,
    );
  }
  const differenceCount = alerts.length - (criterionUnavailable ? 1 : 0);
  return {
    status: differenceCount > 0 ? 'failed' : criterionUnavailable ? 'partial' : 'ok',
    counts: {
      compared: Object.keys(metrics).length,
      differences: differenceCount,
      // 这些仍是已知白名单类型，不把它伪装成未知逻辑差异；增长单独以 status=failed 告警。
      unexplained: 0,
    },
    alerts,
    baselineEstablished: true,
    metrics,
    previousMetrics: previous,
    growth,
    v1LatestVoteFoldWindow: foldWindow,
  };
}

function buildFoldWindowCriterion(
  metrics: Record<string, number>,
  input: V1LatestVoteFoldWindowInput,
): V1LatestVoteFoldWindowCriterion {
  const current = metrics['v1_latestvote_fold_delta'];
  const foldGrowth =
    current === undefined || input.baselineFoldDelta === null
      ? null
      : Math.max(0, current - input.baselineFoldDelta);
  const validNewVotes =
    input.windowVoteRows !== null &&
    Number.isSafeInteger(input.windowVoteRows) &&
    input.windowVoteRows >= 0;
  const baselineDay =
    input.baselineObservedAt === null ? null : dayNumber(shanghaiDay(input.baselineObservedAt));
  const observedDay = dayNumber(shanghaiDay(input.observedAt));
  const intervalDays = baselineDay === null ? null : Math.max(0, observedDay - baselineDay);
  const windowComplete =
    intervalDays !== null && intervalDays >= V1_LATESTVOTE_FOLD_WINDOW_DAYS;
  const allowedGrowth = validNewVotes && windowComplete
    ? input.windowVoteRows! * V1_LATESTVOTE_FOLD_MAX_PER_NEW_VOTE
    : null;
  return {
    ...input,
    multiplier: V1_LATESTVOTE_FOLD_MAX_PER_NEW_VOTE,
    minimumWindowDays: V1_LATESTVOTE_FOLD_WINDOW_DAYS,
    intervalDays,
    foldGrowth,
    allowedGrowth,
    exceeded:
      foldGrowth === null || allowedGrowth === null ? null : foldGrowth > allowedGrowth,
  };
}

export async function fetchDeletedVoteChecksum(
  pool: Pool,
  membershipCutoff: string | null = null,
): Promise<DeletedVoteChecksum> {
  const res = await query<{
    vote_count: string;
    checksum: string;
    protected_vote_count: string;
    protected_checksum: string;
  }>(
    pool,
    'reconcile:freeze-checksum',
    `WITH current_deleted_pages AS (
       SELECT pc.page_id
         FROM serve.page_current pc
        WHERE pc.status = 'deleted'
     ), protected_pages AS (
       -- 按 cutoff 当时的生命周期重建上轮基线。合法 restored 本轮虽已 live，
       -- 其票仍必须参与冻结内容复核，不能因退出 deleted 集合而误报。
       SELECT pc.page_id
         FROM serve.page_current pc
         JOIN LATERAL (
           SELECT ple.kind
             FROM ingest.page_life_event ple
            WHERE ple.page_id = pc.page_id
              AND ($1::timestamptz IS NULL OR ple.observed_at <= $1::timestamptz)
            ORDER BY ple.observed_at DESC, ple.seq DESC
            LIMIT 1
         ) life ON true
        WHERE ($1::timestamptz IS NULL AND pc.status = 'deleted')
           OR ($1::timestamptz IS NOT NULL AND life.kind = 'deleted')
     ), material AS (
       SELECT vc.page_id,
              vc.voter_id,
              vc.source_row_ordinal,
              sign(vc.direction)::int AS direction,
              (cd.page_id IS NOT NULL) AS current_deleted,
              (pd.page_id IS NOT NULL) AS protected
         FROM serve.vote_current vc
         LEFT JOIN current_deleted_pages cd ON cd.page_id = vc.page_id
         LEFT JOIN protected_pages pd ON pd.page_id = vc.page_id
        WHERE cd.page_id IS NOT NULL OR pd.page_id IS NOT NULL
     )
     SELECT count(*) FILTER (WHERE current_deleted)::bigint::text AS vote_count,
            md5(COALESCE(string_agg(
              page_id::text || ':' || voter_id::text || ':' ||
                source_row_ordinal::text || ':' || direction::text,
              E'\\n' ORDER BY page_id, voter_id, source_row_ordinal
            ) FILTER (WHERE current_deleted), '')) AS checksum,
            count(*) FILTER (WHERE protected)::bigint::text AS protected_vote_count,
            md5(COALESCE(string_agg(
              page_id::text || ':' || voter_id::text || ':' ||
                source_row_ordinal::text || ':' || direction::text,
              E'\\n' ORDER BY page_id, voter_id, source_row_ordinal
            ) FILTER (WHERE protected), '')) AS protected_checksum
       FROM material`,
    [membershipCutoff],
  );
  const row = res.rows[0] ?? {
    vote_count: '0',
    checksum: '',
    protected_vote_count: '0',
    protected_checksum: '',
  };
  const count = Number(row.vote_count);
  const protectedCount = Number(row.protected_vote_count);
  return {
    count,
    checksum: row.checksum,
    protectedCount,
    protectedChecksum: row.protected_checksum,
    newMemberVoteCount: Math.max(0, count - protectedCount),
    membershipCutoff,
    version: DELETED_VOTE_CHECKSUM_VERSION,
    algorithm: DELETED_VOTE_CHECKSUM_ALGORITHM,
  };
}

export function compareFrozenChecksum(
  current: DeletedVoteChecksum,
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
      protectedDeletedVoteCount: current.protectedCount,
      protectedChecksum: current.protectedChecksum,
      newMemberVoteCount: current.newMemberVoteCount,
      membershipCutoff: current.membershipCutoff,
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
      protectedDeletedVoteCount: current.protectedCount,
      protectedChecksum: current.protectedChecksum,
      newMemberVoteCount: current.newMemberVoteCount,
      membershipCutoff: current.membershipCutoff,
      changed: false,
      baselineRebuilt: true,
    };
  }
  const changed =
    current.protectedChecksum !== previousChecksum || current.protectedCount !== previousCount;
  const compared = Math.max(current.protectedCount, previousCount, changed ? 1 : 0);
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
            `${current.protectedCount}/${current.protectedChecksum}`,
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
    protectedDeletedVoteCount: current.protectedCount,
    protectedChecksum: current.protectedChecksum,
    newMemberVoteCount: current.newMemberVoteCount,
    membershipCutoff: current.membershipCutoff,
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
  enumeration_scope: 'standard' | 'listpages_hidden';
  meta_updated_epoch_ms: string | null;
  l1_seen_epoch_ms: string | null;
  title_direct_observed: boolean;
  tags_direct_observed: boolean;
  vote_updated_epoch_ms: string | null;
  voter_count: number;
  vote_rating: number;
  vote_checksum: string;
  comparable_voter_count: number;
  comparable_vote_rating: number;
  comparable_vote_checksum: string;
  anonymous_voter_count: number;
  anonymous_vote_rating: number;
  verified_multiset_snapshot: boolean;
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
      enumerationScope: row.enumeration_scope,
      metaUpdatedEpochMs:
        row.meta_updated_epoch_ms === null ? null : Number(row.meta_updated_epoch_ms),
      l1SeenEpochMs:
        row.l1_seen_epoch_ms === null ? null : Number(row.l1_seen_epoch_ms),
      titleDirectObserved: row.title_direct_observed === true,
      tagsDirectObserved: row.tags_direct_observed === true,
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
      verifiedMultisetSnapshot: row.verified_multiset_snapshot === true,
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
  cutoff: number,
): string | null {
  if (
    field === 'existence' &&
    v1 !== undefined &&
    v2 === undefined &&
    V1_SYNTHETIC_TEST_PAGE_ALLOWLIST.get(v1.wikidotId) === v1.slug
  ) {
    return (
      'v1_synthetic_test_page_allowlist:v1 生产库历史测试铸入的 test-image-page；' +
      '站点完整 Sitemap/ListPages 均无该页，v2 正确不导入'
    );
  }
  if (
    field === 'existence' &&
    v1 === undefined &&
    v2 !== undefined &&
    v2.l1SeenEpochMs !== null &&
    v2.l1SeenEpochMs >= cutoff
  ) {
    return (
      'v1_stale_existence_vs_current_l1:v2 live 身份同时被最近完整 ' +
      'Wikidot ListPages L1 直接枚举；v1 缺失是历史滞后'
    );
  }
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
  if (field === 'title' && v2.titleDirectObserved) {
    return (
      'v1_stale_title_vs_wikidot_observation:v2 当前标题来自 Wikidot ListPages ' +
      '直接观测；v1/CROM 历史标题不作为一手源反证'
    );
  }
  if (field === 'tags' && v2.tagsDirectObserved) {
    return (
      'v1_stale_tags_vs_wikidot_observation:v2 当前标签来自 Wikidot ListPages ' +
      '直接观测；v1 历史标签不作为一手源反证'
    );
  }
  if (
    field === 'rating' &&
    v2.rating === v2.voteRating &&
    (v1.voteRating === v2.voteRating || v2.verifiedMultisetSnapshot)
  ) {
    return (
      'v1_pageversion_rating_stale:v2 rating 与当前票和一致，且票集已由完整 WhoRated ' +
      '快照验证（或 v1 票和同值）；仅 v1 PageVersion.rating 滞后'
    );
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
  if (field === 'vote_state' && v2.verifiedMultisetSnapshot) {
    return (
      'v2_verified_multiset_snapshot:v2 当前票逐条来自同一个完整 WhoRated 原始多重集快照；' +
      '原始行数与 signed sum 分别通过 L1 rating_votes/rating 双门，v1 current state 与该源证据不同'
    );
  }
  return null;
}

function normalizeSourceTitle(value: string | null): string | null {
  return value === null
    ? null
    : value
        .normalize('NFKC')
        .replace(/\s+/gu, ' ')
        .replace(/…/gu, '...')
        .replace(/[—–]/gu, '--')
        .replace(/\/\//gu, '')
        .replace(/»/gu, '>>')
        .replace(/«/gu, '<<')
        .trim();
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
