import type { Pool } from 'pg';

import type {
  L0ListPageRow,
  L1ListPageRow,
} from '../collect/incrementalListPages.js';
import { chunk } from '../util/concurrency.js';
import { query, toPgTimestamptz } from './db.js';
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
