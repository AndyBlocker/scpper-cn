import type { Pool } from 'pg';

import type {
  L0ListPageRow,
  L1ListPageRow,
} from '../collect/incrementalListPages.js';
import { REVISION_REGRESSION_PENDING_TIMEOUT_MS } from '../collect/revisionRegression.js';
import { chunk } from '../util/concurrency.js';
import { query, toPgTimestamptz, withTransaction } from './db.js';
import { toPgJson } from './pgText.js';

export type IncrementalLayer = 'L0' | 'L1' | 'L2' | 'L3';

export interface IncrementalPageState {
  slug: string;
  pageId: number | null;
  lastL0Revision: number | null;
  lastL0UpdatedAt: string | null;
  lastL0SeenAt: string | null;
  lastL1Revision: number | null;
  lastL1Rating: number | null;
  lastL1RatingVotes: number | null;
  lastL1SeenAt: string | null;
  lastL1RunId: number | null;
}

interface IncrementalStateRow {
  slug: string;
  page_id: number | null;
  last_l0_revision: number | null;
  last_l0_updated_at: Date | string | null;
  last_l0_seen_at: Date | string | null;
  last_l1_revision: number | null;
  last_l1_rating: number | null;
  last_l1_rating_votes: number | null;
  last_l1_seen_at: Date | string | null;
  last_l1_run_id: string | number | null;
}

export interface IncrementalSignalRow {
  layer: IncrementalLayer;
  slug: string;
  pageId?: number | null;
  signal: string;
  detectedAt: string;
  details?: Record<string, unknown>;
}

export interface RevisionRegressionIdentityObservation {
  layer: 'L0' | 'L1';
  pageId: number;
  slug: string;
  previousRevision: number;
  observedRevision: number;
  observedUpdatedAt?: string | null;
  observedRating?: number | null;
  observedRatingVotes?: number | null;
}

export interface RevisionRegressionIdentityUpsertResult {
  affected: number;
  /** 只有新 episode 才需要派生一次身份确认；同一证据的周期重放只刷新 last_seen_at。 */
  newEpisodeKeys: Set<string>;
}

export interface RevisionRegressionReconcileResult {
  slugReused: number;
  deleted: number;
  manualReview: number;
  tasksRetired: number;
  statesRebased: number;
}

export function revisionRegressionEpisodeKey(pageId: number, layer: 'L0' | 'L1'): string {
  return `${pageId}:${layer}`;
}

export interface AcceptedRevisionRegressionIdentity {
  pageId: number;
  slug: string;
  wikidotId: number;
  accepted: number;
  layers: Array<{
    layer: 'L0' | 'L1';
    previousRevision: number;
    observedRevision: number;
  }>;
}

export interface RevisionCoverageMetric {
  l1RunId: number;
  windowStartedAt: string;
  windowEndedAt: string;
  isBaselineInit: boolean;
  baselineInitReason: string | null;
  l1RevisionChanges: number;
  l0CapturedChanges: number;
  l0MissedChanges: number;
  coverageRate: number | null;
  rolling7dChanges: number;
  rolling7dCaptured: number;
  rolling7dCoverage: number | null;
  sampleMissedSlugs: string[];
}

export interface RevisionCoverageBaselineContext {
  previousL1At: string | null;
  currentL1At: string;
  latestL0AtOrBeforePreviousL1: string | null;
  latestL0AtOrBeforeCurrentL1: string | null;
  frequencyMinutes: number;
  /** 比较窗口内阻断 L0 内容/修订落地的写入冻结域。 */
  blockingFreezeDomains?: readonly string[];
}

export interface RevisionCoverageBaselineClassification {
  isBaselineInit: boolean;
  reason: string | null;
  gapThresholdMinutes: number;
}

export interface RevisionCoverageCalculation {
  l0MissedChanges: number;
  coverageRate: number | null;
  rolling7dChanges: number;
  rolling7dCaptured: number;
  rolling7dCoverage: number | null;
}

/**
 * 覆盖率只有在 L1 比较窗口两端都有连续运行中的 L0 支撑时才可计量。
 * 允许 1.75 个调度周期的抖动；超过它说明至少漏了一轮，不把部署/停机间隔
 * 累积的旧变化伪装成当前 L0 漏抓。
 */
export function classifyRevisionCoverageBaseline(
  context: RevisionCoverageBaselineContext,
): RevisionCoverageBaselineClassification {
  const gapThresholdMinutes = Math.max(1, context.frequencyMinutes * 1.75);
  const thresholdMs = gapThresholdMinutes * 60_000;
  const currentMs = Date.parse(context.currentL1At);
  const previousMs =
    context.previousL1At === null ? Number.NaN : Date.parse(context.previousL1At);
  if (!Number.isFinite(currentMs)) {
    throw new Error(`currentL1At 不是合法时间：${context.currentL1At}`);
  }
  if (!Number.isFinite(previousMs)) {
    return {
      isBaselineInit: true,
      reason: 'l1_baseline_created',
      gapThresholdMinutes,
    };
  }
  const blockingFreezeDomains = [
    ...new Set(
      (context.blockingFreezeDomains ?? [])
        .map((domain) => domain.trim())
        .filter(Boolean),
    ),
  ].sort();
  if (blockingFreezeDomains.length > 0) {
    return {
      isBaselineInit: true,
      reason: `write_freeze_overlap:${blockingFreezeDomains.join(',')}`,
      gapThresholdMinutes,
    };
  }
  if (currentMs - previousMs > thresholdMs) {
    return {
      isBaselineInit: true,
      reason: 'l1_gap_exceeded',
      gapThresholdMinutes,
    };
  }

  const precedingL0Ms =
    context.latestL0AtOrBeforePreviousL1 === null
      ? Number.NaN
      : Date.parse(context.latestL0AtOrBeforePreviousL1);
  if (!Number.isFinite(precedingL0Ms) || previousMs - precedingL0Ms > thresholdMs) {
    return {
      isBaselineInit: true,
      reason: 'l0_not_running_at_l1_baseline',
      gapThresholdMinutes,
    };
  }

  const latestL0Ms =
    context.latestL0AtOrBeforeCurrentL1 === null
      ? Number.NaN
      : Date.parse(context.latestL0AtOrBeforeCurrentL1);
  if (!Number.isFinite(latestL0Ms) || currentMs - latestL0Ms > thresholdMs) {
    return {
      isBaselineInit: true,
      reason: 'l0_gap_before_current_l1',
      gapThresholdMinutes,
    };
  }
  return { isBaselineInit: false, reason: null, gapThresholdMinutes };
}

export function calculateRevisionCoverage(args: {
  isBaselineInit: boolean;
  l1RevisionChanges: number;
  l0CapturedChanges: number;
  previousRollingChanges: number;
  previousRollingCaptured: number;
}): RevisionCoverageCalculation {
  if (args.l0CapturedChanges > args.l1RevisionChanges) {
    throw new Error('l0CapturedChanges 不能大于 l1RevisionChanges');
  }
  const currentChanges = args.isBaselineInit ? 0 : args.l1RevisionChanges;
  const currentCaptured = args.isBaselineInit ? 0 : args.l0CapturedChanges;
  const rolling7dChanges = args.previousRollingChanges + currentChanges;
  const rolling7dCaptured = args.previousRollingCaptured + currentCaptured;
  const l0MissedChanges = args.l1RevisionChanges - args.l0CapturedChanges;
  return {
    l0MissedChanges,
    coverageRate:
      args.l1RevisionChanges === 0
        ? null
        : args.l0CapturedChanges / args.l1RevisionChanges,
    rolling7dChanges,
    rolling7dCaptured,
    rolling7dCoverage:
      rolling7dChanges === 0 ? null : rolling7dCaptured / rolling7dChanges,
  };
}

export function shouldAlertRevisionCoverage(
  metric: Pick<RevisionCoverageMetric, 'isBaselineInit' | 'l0MissedChanges'>,
): boolean {
  return !metric.isBaselineInit && metric.l0MissedChanges > 0;
}

export async function loadSuccessfulL0Bounds(
  pool: Pool,
  previousL1At: string | null,
  currentL1At: string,
): Promise<{
  latestAtOrBeforePreviousL1: string | null;
  latestAtOrBeforeCurrentL1: string | null;
}> {
  if (previousL1At === null) {
    return {
      latestAtOrBeforePreviousL1: null,
      latestAtOrBeforeCurrentL1: null,
    };
  }
  const result = await query<{
    previous_l0_at: Date | string | null;
    current_l0_at: Date | string | null;
  }>(
    pool,
    'incremental:coverage_l0_bounds',
    `SELECT max(started_at) FILTER (WHERE started_at <= $1::timestamptz)
              AS previous_l0_at,
            max(started_at) FILTER (WHERE started_at <= $2::timestamptz)
              AS current_l0_at
       FROM meta.ingest_run
      WHERE source = 'wikidot_listpages'
        AND status = 'ok'
        AND stats ->> 'layer' = 'L0'
        AND started_at <= $2::timestamptz`,
    [toPgTimestamptz(previousL1At), toPgTimestamptz(currentL1At)],
  );
  return {
    latestAtOrBeforePreviousL1: isoOrNull(result.rows[0]?.previous_l0_at ?? null),
    latestAtOrBeforeCurrentL1: isoOrNull(result.rows[0]?.current_l0_at ?? null),
  };
}

/**
 * L0 的发现证据会继续写 meta，但 all/page/content/revision 冻结会阻断它派生的事实写入。
 * 这种窗口不能被 L1 解释为采集漏抓，也不能训练 rolling 覆盖率。
 *
 * write_freeze 保留最近一次 frozen_at/released_at，足以覆盖“冻结中运行的 L1”和释放后的
 * 首个跨界窗口；冻结期间每一轮 L1 都会在当时直接看到 active 区间。
 */
export async function loadRevisionCoverageWriteFreezeDomains(
  pool: Pool,
  windowStartedAt: string,
  windowEndedAt: string,
): Promise<string[]> {
  const result = await query<{ domains: string[] | null }>(
    pool,
    'incremental:coverage_write_freeze_overlap',
    `SELECT array_agg(domain ORDER BY domain) AS domains
       FROM meta.write_freeze
      WHERE domain = ANY($3::text[])
        AND frozen_at IS NOT NULL
        AND frozen_at < $2::timestamptz
        AND COALESCE(released_at, 'infinity'::timestamptz) > $1::timestamptz`,
    [
      toPgTimestamptz(windowStartedAt),
      toPgTimestamptz(windowEndedAt),
      ['all', 'page', 'content', 'revision'],
    ],
  );
  return result.rows[0]?.domains ?? [];
}

export async function loadIncrementalPageStates(
  pool: Pool,
  slugs: readonly string[],
): Promise<Map<string, IncrementalPageState>> {
  const out = new Map<string, IncrementalPageState>();
  for (const part of chunk([...new Set(slugs)], 5_000)) {
    if (part.length === 0) continue;
    const result = await query<IncrementalStateRow>(
      pool,
      'incremental:load_page_state',
      `SELECT slug, page_id,
              last_l0_revision, last_l0_updated_at, last_l0_seen_at,
              last_l1_revision, last_l1_rating, last_l1_rating_votes,
              last_l1_seen_at, last_l1_run_id
         FROM meta.incremental_page_state
        WHERE slug = ANY($1::text[])`,
      [part],
    );
    for (const row of result.rows) {
      out.set(row.slug, {
        slug: row.slug,
        pageId: row.page_id === null ? null : Number(row.page_id),
        lastL0Revision:
          row.last_l0_revision === null ? null : Number(row.last_l0_revision),
        lastL0UpdatedAt: isoOrNull(row.last_l0_updated_at),
        lastL0SeenAt: isoOrNull(row.last_l0_seen_at),
        lastL1Revision:
          row.last_l1_revision === null ? null : Number(row.last_l1_revision),
        lastL1Rating: row.last_l1_rating === null ? null : Number(row.last_l1_rating),
        lastL1RatingVotes:
          row.last_l1_rating_votes === null ? null : Number(row.last_l1_rating_votes),
        lastL1SeenAt: isoOrNull(row.last_l1_seen_at),
        lastL1RunId: row.last_l1_run_id === null ? null : Number(row.last_l1_run_id),
      });
    }
  }
  return out;
}

export async function hasL1Baseline(pool: Pool): Promise<boolean> {
  const result = await query<{ present: boolean }>(
    pool,
    'incremental:has_l1_baseline',
    `SELECT EXISTS(
       SELECT 1 FROM meta.incremental_page_state WHERE last_l1_revision IS NOT NULL
     ) AS present`,
  );
  return result.rows[0]?.present === true;
}

/**
 * L0 是小时间窗，页级异常率不能拿“本窗口恰好枚举到几页”作分母。
 * 最近建立过 L1 修订基线的 slug 数是跨轮已知人口；L1 自身仍会与本轮枚举量取较大值。
 */
export async function loadIncrementalKnownPopulation(pool: Pool): Promise<number> {
  const result = await query<{ n: string | number }>(
    pool,
    'incremental:known_population',
    `SELECT count(*) AS n
       FROM meta.incremental_page_state
      WHERE last_l1_revision IS NOT NULL`,
  );
  return Number(result.rows[0]?.n ?? 0);
}

/** L0 成功轮最后一步调用；失败轮绝不能推进它。 */
export async function upsertL0States(
  pool: Pool,
  rows: ReadonlyArray<{ row: L0ListPageRow; pageId?: number | null }>,
  observedAt: string,
): Promise<number> {
  let affected = 0;
  for (const part of chunk(rows, 1_000)) {
    if (part.length === 0) continue;
    const payload = part.map(({ row, pageId }) => ({
      slug: row.fullname,
      page_id: pageId ?? null,
      revision: row.revisions,
      updated_at: row.updatedAt,
    }));
    const result = await query(
      pool,
      'incremental:upsert_l0_state',
      `WITH input AS (
         SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(
           slug text, page_id int, revision int, updated_at timestamptz
         )
       )
       INSERT INTO meta.incremental_page_state
         (slug, page_id, last_l0_revision, last_l0_updated_at, last_l0_seen_at, updated_at)
       SELECT slug, page_id, revision, updated_at, $2::timestamptz, now()
         FROM input
       ON CONFLICT (slug) DO UPDATE
         SET page_id = COALESCE(EXCLUDED.page_id, meta.incremental_page_state.page_id),
             last_l0_revision = EXCLUDED.last_l0_revision,
             last_l0_updated_at = EXCLUDED.last_l0_updated_at,
             last_l0_seen_at = EXCLUDED.last_l0_seen_at,
             updated_at = now()`,
      [toPgJson(payload, 'incremental.l0_state'), toPgTimestamptz(observedAt)],
    );
    affected += result.rowCount ?? 0;
  }
  return affected;
}

/** L1 成功且任务/指标均落地后调用；只传已解析 page_id 的行。 */
export async function upsertL1States(
  pool: Pool,
  runId: number,
  rows: ReadonlyArray<{ row: L1ListPageRow; pageId?: number | null }>,
  observedAt: string,
): Promise<number> {
  let affected = 0;
  for (const part of chunk(rows, 1_000)) {
    if (part.length === 0) continue;
    const payload = part.map(({ row, pageId }) => ({
      slug: row.fullname,
      page_id: pageId ?? null,
      revision: row.revisions,
      rating: row.rating,
      rating_votes: row.ratingVotes,
    }));
    const result = await query(
      pool,
      'incremental:upsert_l1_state',
      `WITH input AS (
         SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(
           slug text, page_id int, revision int, rating int, rating_votes int
         )
       )
       INSERT INTO meta.incremental_page_state
         (slug, page_id, last_l1_revision, last_l1_rating, last_l1_rating_votes,
          last_l1_seen_at, last_l1_run_id, updated_at)
       SELECT slug, page_id, revision, rating, rating_votes,
              $2::timestamptz, $3::bigint, now()
         FROM input
       ON CONFLICT (slug) DO UPDATE
         SET page_id = COALESCE(EXCLUDED.page_id, meta.incremental_page_state.page_id),
             last_l1_revision = EXCLUDED.last_l1_revision,
             last_l1_rating = EXCLUDED.last_l1_rating,
             last_l1_rating_votes = EXCLUDED.last_l1_rating_votes,
             last_l1_seen_at = EXCLUDED.last_l1_seen_at,
             last_l1_run_id = EXCLUDED.last_l1_run_id,
             updated_at = now()`,
      [toPgJson(payload, 'incremental.l1_state'), toPgTimestamptz(observedAt), runId],
    );
    affected += result.rowCount ?? 0;
  }
  return affected;
}

/**
 * 修订号倒退不能只藏在 page_scan.error：身份 worker 需要一个可锁定、可 CAS 终结的输入。
 * 同一 (page,layer) 重复观测保留 first_seen_at；新一轮不同倒退则重新开始 episode。
 */
export async function upsertRevisionRegressionIdentityStates(
  pool: Pool,
  runId: number,
  rows: readonly RevisionRegressionIdentityObservation[],
  observedAt: string,
): Promise<RevisionRegressionIdentityUpsertResult> {
  if (rows.length === 0) return { affected: 0, newEpisodeKeys: new Set() };
  const payload = rows.map((row) => ({
    layer: row.layer,
    page_id: row.pageId,
    slug: row.slug,
    previous_revision: row.previousRevision,
    observed_revision: row.observedRevision,
    observed_updated_at: row.observedUpdatedAt ?? null,
    observed_rating: row.observedRating ?? null,
    observed_rating_votes: row.observedRatingVotes ?? null,
  }));
  const existing = await query<{
    page_id: number;
    layer: 'L0' | 'L1';
    slug: string;
    previous_revision: number;
    observed_revision: number;
  }>(
    pool,
    'incremental:load_revision_regression_episodes',
    `WITH input AS (
       SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(page_id int, layer text)
     )
     SELECT r.page_id, r.layer, r.slug, r.previous_revision, r.observed_revision
       FROM meta.revision_regression_identity_state r
       JOIN input i USING (page_id, layer)`,
    [toPgJson(payload, 'incremental.revision_regression_identity_keys')],
  );
  const existingByKey = new Map(
    existing.rows.map((row) => [revisionRegressionEpisodeKey(row.page_id, row.layer), row]),
  );
  const newEpisodeKeys = new Set<string>();
  for (const row of rows) {
    const key = revisionRegressionEpisodeKey(row.pageId, row.layer);
    const previous = existingByKey.get(key);
    if (
      previous === undefined ||
      previous.slug !== row.slug ||
      Number(previous.previous_revision) !== row.previousRevision ||
      Number(previous.observed_revision) !== row.observedRevision
    ) {
      newEpisodeKeys.add(key);
    }
  }
  const result = await query(
    pool,
    'incremental:upsert_revision_regression_identity',
    `WITH input AS (
       SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(
         layer text, page_id int, slug text,
         previous_revision int, observed_revision int,
         observed_updated_at timestamptz, observed_rating int, observed_rating_votes int
       )
     )
     INSERT INTO meta.revision_regression_identity_state AS r(
       page_id, layer, slug, expected_wikidot_id,
       previous_revision, observed_revision, observed_updated_at,
       observed_rating, observed_rating_votes, run_id, status,
       first_seen_at, last_seen_at, resolved_at, resolution
     )
     SELECT i.page_id, i.layer, i.slug, p.wikidot_id,
            i.previous_revision, i.observed_revision, i.observed_updated_at,
            i.observed_rating, i.observed_rating_votes, $2::bigint, 'pending',
            $3::timestamptz, $3::timestamptz, NULL, NULL
       FROM input i
       JOIN ingest.page p ON p.id = i.page_id
     ON CONFLICT (page_id, layer) DO UPDATE
       SET slug = EXCLUDED.slug,
           expected_wikidot_id = EXCLUDED.expected_wikidot_id,
           previous_revision = EXCLUDED.previous_revision,
           observed_revision = EXCLUDED.observed_revision,
           observed_updated_at = EXCLUDED.observed_updated_at,
           observed_rating = EXCLUDED.observed_rating,
           observed_rating_votes = EXCLUDED.observed_rating_votes,
           run_id = EXCLUDED.run_id,
           status = CASE
             WHEN r.slug = EXCLUDED.slug
              AND r.expected_wikidot_id = EXCLUDED.expected_wikidot_id
              AND r.previous_revision = EXCLUDED.previous_revision
              AND r.observed_revision = EXCLUDED.observed_revision
             THEN r.status
             ELSE 'pending'
           END,
           first_seen_at = CASE
             WHEN r.slug = EXCLUDED.slug
              AND r.expected_wikidot_id = EXCLUDED.expected_wikidot_id
              AND r.previous_revision = EXCLUDED.previous_revision
              AND r.observed_revision = EXCLUDED.observed_revision
             THEN r.first_seen_at
             ELSE EXCLUDED.first_seen_at
           END,
           last_seen_at = EXCLUDED.last_seen_at,
           resolved_at = CASE
             WHEN r.slug = EXCLUDED.slug
              AND r.expected_wikidot_id = EXCLUDED.expected_wikidot_id
              AND r.previous_revision = EXCLUDED.previous_revision
              AND r.observed_revision = EXCLUDED.observed_revision
             THEN r.resolved_at
             ELSE NULL
           END,
           resolution = CASE
             WHEN r.slug = EXCLUDED.slug
              AND r.expected_wikidot_id = EXCLUDED.expected_wikidot_id
              AND r.previous_revision = EXCLUDED.previous_revision
              AND r.observed_revision = EXCLUDED.observed_revision
             THEN r.resolution
             ELSE NULL
           END`,
    [
      toPgJson(payload, 'incremental.revision_regression_identity'),
      runId,
      toPgTimestamptz(observedAt),
    ],
  );
  return { affected: result.rowCount ?? 0, newEpisodeKeys };
}

/**
 * pending 的周期收口：先消费已经落库的身份生命周期证据，再把超过一小时仍无可靠结论
 * 的页升级 manual_review。终态页上的 regression 专用任务同时退役，避免终态仍被认领。
 */
export async function reconcileRevisionRegressionIdentityStates(
  pool: Pool,
  observedAt: string,
  timeoutMs = REVISION_REGRESSION_PENDING_TIMEOUT_MS,
  pageIds: readonly number[] | null = null,
): Promise<RevisionRegressionReconcileResult> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError(`revision regression timeoutMs 必须是正安全整数，收到 ${timeoutMs}`);
  }
  return withTransaction(pool, 'revision-regression:reconcile', async (db) => {
    const transitioned = await query<{
      page_id: number;
      status: 'slug_reused' | 'deleted' | 'manual_review';
    }>(
      db,
      'revision_regression:reconcile_pending',
      `WITH evidence AS (
         SELECT r.page_id, r.layer, r.expected_wikidot_id, r.observed_revision,
                pc.status AS page_status,
                successor.page_id AS successor_page_id,
                successor.wikidot_id AS successor_wikidot_id
           FROM meta.revision_regression_identity_state r
           LEFT JOIN serve.page_current pc ON pc.page_id = r.page_id
           LEFT JOIN LATERAL (
             SELECT next_pc.page_id, next_p.wikidot_id
               FROM serve.page_current next_pc
               JOIN ingest.page next_p ON next_p.id = next_pc.page_id
              WHERE next_pc.slug = r.slug
                AND next_pc.status = 'live'
                AND next_p.wikidot_id <> r.expected_wikidot_id
              ORDER BY next_pc.page_id DESC
              LIMIT 1
           ) successor ON true
          WHERE r.status = 'pending'
            AND ($3::int[] IS NULL OR r.page_id = ANY($3::int[]))
       ), decided AS (
         SELECT e.*,
                CASE
                  WHEN e.successor_page_id IS NOT NULL THEN 'slug_reused'
                  WHEN e.page_status = 'deleted' THEN 'deleted'
                  WHEN r.first_seen_at <= $1::timestamptz
                       - ($2::bigint * interval '1 millisecond') THEN 'manual_review'
                  ELSE NULL
                END AS disposition
           FROM evidence e
           JOIN meta.revision_regression_identity_state r
             ON r.page_id = e.page_id AND r.layer = e.layer
       )
       UPDATE meta.revision_regression_identity_state r
          SET status = d.disposition,
              resolved_at = GREATEST($1::timestamptz, r.first_seen_at, r.last_seen_at),
              resolution = CASE d.disposition
                WHEN 'slug_reused' THEN
                  'local_lifecycle_successor:page_id=' || d.successor_page_id::text ||
                  ';wikidot_id=' || d.successor_wikidot_id::text
                WHEN 'deleted' THEN
                  'local_lifecycle_predecessor_deleted;observed_revision=' ||
                  d.observed_revision::text
                ELSE 'identity_confirmation_timeout:' || $2::text || 'ms;manual_review_required'
              END
         FROM decided d
        WHERE r.page_id = d.page_id
          AND r.layer = d.layer
          AND r.status = 'pending'
          AND d.disposition IS NOT NULL
       RETURNING r.page_id, r.status`,
      [toPgTimestamptz(observedAt), timeoutMs, pageIds === null ? null : [...pageIds]],
    );
    const terminalPageIds = [...new Set(transitioned.rows.map((row) => Number(row.page_id)))];
    let tasksRetired = 0;
    if (terminalPageIds.length > 0) {
      await query(
        db,
        'revision_regression:strip_terminal_task_reasons',
        `UPDATE meta.scan_task st
            SET reasons = ARRAY(
              SELECT reason
               FROM unnest(st.reasons) AS reason
               WHERE reason <> ALL($2::text[])
                 AND reason !~ '^l[01]_revision_regression$'
                 AND reason !~ '^l1_projection_drift_'
            )
          WHERE st.page_id = ANY($1::int[])
            AND (
              'revision_regression_identity_check' = ANY(st.reasons)
              OR 'same_identity_revision_regression_confirmed' = ANY(st.reasons)
            )`,
        [
          terminalPageIds,
          ['revision_regression_identity_check', 'same_identity_revision_regression_confirmed'],
        ],
      );
      const retired = await query(
        db,
        'revision_regression:retire_empty_terminal_tasks',
        `DELETE FROM meta.scan_task
          WHERE page_id = ANY($1::int[])
            AND cardinality(reasons) = 0`,
        [terminalPageIds],
      );
      tasksRetired = retired.rowCount ?? 0;
    }
    const rebased = await query(
      db,
      'revision_regression:rebase_slug_reused_incremental_state',
      `WITH terminal AS (
         SELECT DISTINCT ON (r.slug, r.page_id)
                r.slug,
                r.page_id AS predecessor_page_id,
                successor.page_id AS successor_page_id
           FROM meta.revision_regression_identity_state r
           JOIN LATERAL (
             SELECT pc.page_id
               FROM serve.page_current pc
               JOIN ingest.page p ON p.id = pc.page_id
              WHERE pc.slug = r.slug
                AND pc.status = 'live'
                AND p.wikidot_id <> r.expected_wikidot_id
              ORDER BY pc.page_id DESC
              LIMIT 1
           ) successor ON true
          WHERE r.status = 'slug_reused'
            AND ($1::int[] IS NULL OR r.page_id = ANY($1::int[]))
          ORDER BY r.slug, r.page_id, r.last_seen_at DESC
       ), observations AS (
         SELECT t.*,
                l0.observed_revision AS l0_revision,
                l0.observed_updated_at AS l0_updated_at,
                l0.last_seen_at AS l0_seen_at,
                l1.observed_revision AS l1_revision,
                l1.observed_rating AS l1_rating,
                l1.observed_rating_votes AS l1_rating_votes,
                l1.last_seen_at AS l1_seen_at,
                l1.run_id AS l1_run_id
           FROM terminal t
           LEFT JOIN LATERAL (
             SELECT r.observed_revision, r.observed_updated_at, r.last_seen_at
               FROM meta.revision_regression_identity_state r
              WHERE r.page_id = t.predecessor_page_id AND r.layer = 'L0'
              ORDER BY r.last_seen_at DESC
              LIMIT 1
           ) l0 ON true
           LEFT JOIN LATERAL (
             SELECT r.observed_revision, r.observed_rating, r.observed_rating_votes,
                    r.last_seen_at, r.run_id
               FROM meta.revision_regression_identity_state r
              WHERE r.page_id = t.predecessor_page_id AND r.layer = 'L1'
              ORDER BY r.last_seen_at DESC
              LIMIT 1
           ) l1 ON true
       )
       UPDATE meta.incremental_page_state ips
          SET page_id = o.successor_page_id,
              last_l0_revision = COALESCE(o.l0_revision, ips.last_l0_revision),
              last_l0_updated_at = COALESCE(o.l0_updated_at, ips.last_l0_updated_at),
              last_l0_seen_at = COALESCE(o.l0_seen_at, ips.last_l0_seen_at),
              last_l1_revision = COALESCE(o.l1_revision, ips.last_l1_revision),
              last_l1_rating = COALESCE(o.l1_rating, ips.last_l1_rating),
              last_l1_rating_votes = COALESCE(o.l1_rating_votes, ips.last_l1_rating_votes),
              last_l1_seen_at = COALESCE(o.l1_seen_at, ips.last_l1_seen_at),
              last_l1_run_id = COALESCE(o.l1_run_id, ips.last_l1_run_id),
              updated_at = GREATEST(
                ips.updated_at,
                COALESCE(o.l0_seen_at, '-infinity'::timestamptz),
                COALESCE(o.l1_seen_at, '-infinity'::timestamptz)
              )
         FROM observations o
        WHERE ips.slug = o.slug
          AND ips.page_id = o.predecessor_page_id`,
      [pageIds === null ? null : [...pageIds]],
    );
    return {
      slugReused: transitioned.rows.filter((row) => row.status === 'slug_reused').length,
      deleted: transitioned.rows.filter((row) => row.status === 'deleted').length,
      manualReview: transitioned.rows.filter((row) => row.status === 'manual_review').length,
      tasksRetired,
      statesRebased: rebased.rowCount ?? 0,
    };
  });
}

/**
 * GET 与 norender pageId 都证明 slug 仍绑定同一 wikidotId 后，接受“修订被删除”这一合法
 * 单页形态。锁内再次核对身份，并仅在增量水位仍等于 previous 时 CAS 到较低观测值。
 */
export async function acceptSameIdentityRevisionRegression(
  pool: Pool,
  args: {
    pageId: number;
    slug: string;
    wikidotId: number;
    observedAt: string;
  },
): Promise<AcceptedRevisionRegressionIdentity> {
  return withTransaction(pool, `revision-regression:accept:${args.pageId}`, async (db) => {
    const identity = await query<{
      page_id: number;
      slug: string;
      wikidot_id: number;
      status: string;
      last_l0_revision: number | null;
      last_l1_revision: number | null;
    }>(
      db,
      'revision_regression:lock_identity',
      `SELECT p.id AS page_id, pc.slug, p.wikidot_id, pc.status,
              ips.last_l0_revision, ips.last_l1_revision
         FROM ingest.page p
         JOIN serve.page_current pc ON pc.page_id = p.id
         JOIN meta.incremental_page_state ips
           ON ips.slug = pc.slug
          AND (ips.page_id IS NULL OR ips.page_id = p.id)
        WHERE p.id = $1
        FOR UPDATE OF p, pc, ips`,
      [args.pageId],
    );
    const current = identity.rows[0];
    if (
      current === undefined ||
      current.slug !== args.slug ||
      Number(current.wikidot_id) !== args.wikidotId ||
      current.status !== 'live'
    ) {
      throw new Error(
        `修订倒退身份 CAS 前已变化：page=${args.pageId};` +
          `expected=${args.wikidotId}/${args.slug};` +
          `current=${current?.wikidot_id ?? 'missing'}/${current?.slug ?? 'missing'}/` +
          `${current?.status ?? 'missing'}`,
      );
    }

    const pending = await query<{
      layer: 'L0' | 'L1';
      previous_revision: number;
      observed_revision: number;
      observed_updated_at: Date | string | null;
      observed_rating: number | null;
      observed_rating_votes: number | null;
      run_id: string | null;
    }>(
      db,
      'revision_regression:pending',
      `SELECT layer, previous_revision, observed_revision, observed_updated_at,
              observed_rating, observed_rating_votes, run_id::text
         FROM meta.revision_regression_identity_state
        WHERE page_id = $1
          AND slug = $2
          AND expected_wikidot_id = $3
          AND status = 'pending'
        ORDER BY layer
        FOR UPDATE`,
      [args.pageId, args.slug, args.wikidotId],
    );
    const accepted = pending.rows.filter((row) => {
      const stateRevision = row.layer === 'L0'
        ? current.last_l0_revision
        : current.last_l1_revision;
      return stateRevision === row.previous_revision || stateRevision === row.observed_revision;
    });
    if (accepted.length === 0) {
      return {
        pageId: args.pageId,
        slug: args.slug,
        wikidotId: args.wikidotId,
        accepted: 0,
        layers: [],
      };
    }

    const l0 = accepted.find((row) => row.layer === 'L0');
    const l1 = accepted.find((row) => row.layer === 'L1');
    await query(
      db,
      'revision_regression:advance_state',
      `UPDATE meta.incremental_page_state
          SET page_id = $1,
              last_l0_revision = CASE WHEN $4::boolean THEN $5::int ELSE last_l0_revision END,
              last_l0_updated_at = CASE
                WHEN $4::boolean THEN COALESCE($6::timestamptz, last_l0_updated_at)
                ELSE last_l0_updated_at
              END,
              last_l0_seen_at = CASE
                WHEN $4::boolean THEN $3::timestamptz ELSE last_l0_seen_at
              END,
              last_l1_revision = CASE WHEN $7::boolean THEN $8::int ELSE last_l1_revision END,
              last_l1_rating = CASE
                WHEN $7::boolean THEN COALESCE($9::int, last_l1_rating) ELSE last_l1_rating
              END,
              last_l1_rating_votes = CASE
                WHEN $7::boolean THEN COALESCE($10::int, last_l1_rating_votes)
                ELSE last_l1_rating_votes
              END,
              last_l1_seen_at = CASE
                WHEN $7::boolean THEN $3::timestamptz ELSE last_l1_seen_at
              END,
              last_l1_run_id = CASE
                WHEN $7::boolean THEN $11::bigint ELSE last_l1_run_id
              END,
              updated_at = now()
        WHERE slug = $2 AND (page_id IS NULL OR page_id = $1)`,
      [
        args.pageId,
        args.slug,
        toPgTimestamptz(args.observedAt),
        l0 !== undefined,
        l0?.observed_revision ?? null,
        l0?.observed_updated_at === null || l0?.observed_updated_at === undefined
          ? null
          : toPgTimestamptz(l0.observed_updated_at),
        l1 !== undefined,
        l1?.observed_revision ?? null,
        l1?.observed_rating ?? null,
        l1?.observed_rating_votes ?? null,
        l1?.run_id ?? null,
      ],
    );
    await query(
      db,
      'revision_regression:resolve_same_identity',
      `UPDATE meta.revision_regression_identity_state
          SET status = 'accepted_same_identity',
              resolved_at = $2::timestamptz,
              resolution = 'same_wikidot_id_confirmed;lower_revision_watermark_accepted'
        WHERE page_id = $1
          AND layer = ANY($3::text[])
          AND status = 'pending'`,
      [args.pageId, toPgTimestamptz(args.observedAt), accepted.map((row) => row.layer)],
    );
    return {
      pageId: args.pageId,
      slug: args.slug,
      wikidotId: args.wikidotId,
      accepted: accepted.length,
      layers: accepted.map((row) => ({
        layer: row.layer,
        previousRevision: row.previous_revision,
        observedRevision: row.observed_revision,
      })),
    };
  });
}

export async function resolveRevisionRegressionIdentityStates(
  pool: Pool,
  pageId: number,
  status: 'slug_reused' | 'deleted',
  observedAt: string,
  resolution: string,
): Promise<number> {
  const result = await query(
    pool,
    'revision_regression:resolve_identity_replaced',
    `UPDATE meta.revision_regression_identity_state
        SET status = $2,
            resolved_at = $3::timestamptz,
            resolution = $4
      WHERE page_id = $1 AND status = 'pending'`,
    [pageId, status, toPgTimestamptz(observedAt), resolution],
  );
  return result.rowCount ?? 0;
}

export async function insertIncrementalSignals(
  pool: Pool,
  runId: number | null,
  rows: readonly IncrementalSignalRow[],
): Promise<number> {
  if (runId === null || rows.length === 0) return 0;
  let affected = 0;
  for (const part of chunk(rows, 1_000)) {
    const result = await query(
      pool,
      'incremental:insert_signals',
      `WITH input AS (
         SELECT * FROM jsonb_to_recordset($2::jsonb) AS x(
           layer text, slug text, page_id int, signal text,
           detected_at timestamptz, details jsonb
         )
       )
       INSERT INTO meta.incremental_signal
         (run_id, layer, slug, page_id, signal, detected_at, details)
       SELECT $1, layer, slug, page_id, signal, detected_at, COALESCE(details, '{}'::jsonb)
         FROM input
       ON CONFLICT (run_id, layer, slug, signal) DO UPDATE
         SET page_id = COALESCE(EXCLUDED.page_id, meta.incremental_signal.page_id),
             detected_at = EXCLUDED.detected_at,
             details = meta.incremental_signal.details || EXCLUDED.details`,
      [
        runId,
        toPgJson(
          part.map((row) => ({
            layer: row.layer,
            slug: row.slug,
            page_id: row.pageId ?? null,
            signal: row.signal,
            detected_at: row.detectedAt,
            details: row.details ?? {},
          })),
          'incremental.signals',
        ),
      ],
    );
    affected += result.rowCount ?? 0;
  }
  return affected;
}

/**
 * L1 用自己的 revisions 全站快照持续证明 L0 覆盖。分子/分母按“变化页”计，
 * rolling 7d 也按变化页加权，不能把小样本轮与大样本轮等权平均。
 */
export async function recordRevisionCoverage(
  pool: Pool,
  args: {
    l1RunId: number;
    windowStartedAt: string;
    windowEndedAt: string;
    isBaselineInit: boolean;
    baselineInitReason?: string | null;
    l1RevisionChanges: number;
    l0CapturedChanges: number;
    sampleMissedSlugs: readonly string[];
  },
): Promise<RevisionCoverageMetric> {
  const previous = await query<{ changes: string | number; captured: string | number }>(
    pool,
    'incremental:revision_coverage_rolling',
    `SELECT COALESCE(sum(l1_revision_changes), 0) AS changes,
            COALESCE(sum(l0_captured_changes), 0) AS captured
      FROM meta.revision_coverage_metric
      WHERE l1_run_id <> $1
        AND is_baseline_init IS FALSE
        AND measured_at > $2::timestamptz - interval '7 days'
        AND measured_at <= $2::timestamptz`,
    [args.l1RunId, toPgTimestamptz(args.windowEndedAt)],
  );
  const calculation = calculateRevisionCoverage({
    isBaselineInit: args.isBaselineInit,
    l1RevisionChanges: args.l1RevisionChanges,
    l0CapturedChanges: args.l0CapturedChanges,
    previousRollingChanges: Number(previous.rows[0]?.changes ?? 0),
    previousRollingCaptured: Number(previous.rows[0]?.captured ?? 0),
  });
  const {
    l0MissedChanges,
    coverageRate,
    rolling7dChanges,
    rolling7dCaptured,
    rolling7dCoverage,
  } = calculation;
  const sampleMissedSlugs = [...args.sampleMissedSlugs].slice(0, 100);

  await query(
    pool,
    'incremental:record_revision_coverage',
    `INSERT INTO meta.revision_coverage_metric
       (l1_run_id, window_started_at, window_ended_at,
        is_baseline_init, baseline_init_reason,
        l1_revision_changes, l0_captured_changes, l0_missed_changes, coverage_rate,
        rolling_7d_changes, rolling_7d_captured, rolling_7d_coverage,
        sample_missed_slugs, measured_at)
     VALUES
       ($1, $2::timestamptz, $3::timestamptz,
        $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::text[], $3::timestamptz)
     ON CONFLICT (l1_run_id) DO UPDATE
       SET window_started_at = EXCLUDED.window_started_at,
           window_ended_at = EXCLUDED.window_ended_at,
           is_baseline_init = EXCLUDED.is_baseline_init,
           baseline_init_reason = EXCLUDED.baseline_init_reason,
           l1_revision_changes = EXCLUDED.l1_revision_changes,
           l0_captured_changes = EXCLUDED.l0_captured_changes,
           l0_missed_changes = EXCLUDED.l0_missed_changes,
           coverage_rate = EXCLUDED.coverage_rate,
           rolling_7d_changes = EXCLUDED.rolling_7d_changes,
           rolling_7d_captured = EXCLUDED.rolling_7d_captured,
           rolling_7d_coverage = EXCLUDED.rolling_7d_coverage,
           sample_missed_slugs = EXCLUDED.sample_missed_slugs,
           measured_at = EXCLUDED.measured_at`,
    [
      args.l1RunId,
      toPgTimestamptz(args.windowStartedAt),
      toPgTimestamptz(args.windowEndedAt),
      args.isBaselineInit,
      args.baselineInitReason ?? null,
      args.l1RevisionChanges,
      args.l0CapturedChanges,
      l0MissedChanges,
      coverageRate,
      rolling7dChanges,
      rolling7dCaptured,
      rolling7dCoverage,
      sampleMissedSlugs,
    ],
  );

  return {
    l1RunId: args.l1RunId,
    windowStartedAt: args.windowStartedAt,
    windowEndedAt: args.windowEndedAt,
    isBaselineInit: args.isBaselineInit,
    baselineInitReason: args.baselineInitReason ?? null,
    l1RevisionChanges: args.l1RevisionChanges,
    l0CapturedChanges: args.l0CapturedChanges,
    l0MissedChanges,
    coverageRate,
    rolling7dChanges,
    rolling7dCaptured,
    rolling7dCoverage,
    sampleMissedSlugs,
  };
}

function isoOrNull(value: Date | string | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}
