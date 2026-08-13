import type { Pool, PoolClient } from 'pg';

import { query, toPgTimestamptz, withTransaction } from '../store/db.js';
import { reapStaleIngestRuns } from '../store/meta.js';
import { toPgJson } from '../store/pgText.js';
import { observeEgressAccounting } from './egressAccounting.js';

const HOUR = 3_600;
const DAY = 24 * HOUR;
export const PIPELINE_SUCCESS_WINDOW_SECONDS = HOUR;
export const PIPELINE_SUCCESS_CRITICAL_MIN_SCANS = 10;

export type PendingSeverity = 'ok' | 'warn' | 'critical';

export interface PendingPoint {
  observedAt: string;
  pendingCount: number;
  oldestItemAt: string | null;
  oldestItemKey: string | null;
  catchup: boolean;
}

export interface PendingCollection extends PendingPoint {
  collection: string;
  family: string;
  evidence: Record<string, unknown>;
}

export interface PendingPolicy {
  warnAfterSeconds: number;
  criticalAfterSeconds: number;
  /** 一次性追平只有在连续 30 分钟无头部推进后才告警。 */
  catchupTrendSeconds: number;
  /** 总量下降也不能永久掩盖同一个饿死头部；最长观察窗按该集合严重阈值。 */
  catchupHeadStallSeconds: number;
  reason: string;
}

export interface PendingDecision {
  severity: PendingSeverity;
  oldestAgeSeconds: number | null;
  worseningStartedAt: string | null;
  decision: string;
  policy: PendingPolicy;
}

export interface PipelineSuccessDecision {
  severity: 'ok' | 'critical';
  decision:
    | 'no_tasks'
    | 'intermediate_only'
    | 'below_sample_threshold'
    | 'has_success'
    | 'rolling_zero_success';
  successRate: number | null;
}

/** 只用可判定扫描评价成功率；claim_only 中间态既不冒充成功，也不冒充失败。 */
export function evaluatePipelineSuccess(args: {
  scans: number;
  successes: number;
  intermediates?: number;
  criticalMinScans?: number;
}): PipelineSuccessDecision {
  const criticalMinScans = args.criticalMinScans ?? PIPELINE_SUCCESS_CRITICAL_MIN_SCANS;
  const intermediates = args.intermediates ?? 0;
  if (!Number.isInteger(args.scans) || args.scans < 0) {
    throw new RangeError(`scans 必须是非负整数，收到 ${args.scans}`);
  }
  if (!Number.isInteger(intermediates) || intermediates < 0 || intermediates > args.scans) {
    throw new RangeError(`intermediates 必须是 0..scans 的整数，收到 ${intermediates}`);
  }
  const evaluated = args.scans - intermediates;
  if (!Number.isInteger(args.successes) || args.successes < 0 || args.successes > evaluated) {
    throw new RangeError(
      `successes 必须是 0..evaluated 的整数，收到 ${args.successes}/${evaluated}`,
    );
  }
  if (!Number.isInteger(criticalMinScans) || criticalMinScans < 1) {
    throw new RangeError(`criticalMinScans 必须为正整数，收到 ${criticalMinScans}`);
  }
  if (args.scans === 0) {
    return { severity: 'ok', decision: 'no_tasks', successRate: null };
  }
  if (evaluated === 0) {
    return { severity: 'ok', decision: 'intermediate_only', successRate: null };
  }
  const successRate = args.successes / evaluated;
  if (args.successes > 0) {
    return { severity: 'ok', decision: 'has_success', successRate };
  }
  if (evaluated < criticalMinScans) {
    return { severity: 'ok', decision: 'below_sample_threshold', successRate };
  }
  return { severity: 'critical', decision: 'rolling_zero_success', successRate };
}

function policy(
  warnAfterSeconds: number,
  criticalAfterSeconds: number,
  reason: string,
): PendingPolicy {
  return {
    warnAfterSeconds,
    criticalAfterSeconds,
    catchupTrendSeconds: 30 * 60,
    catchupHeadStallSeconds: criticalAfterSeconds,
    reason,
  };
}

/** 阈值按集合的生产周期/退避契约设定，不使用会掩盖小集合的统一全站阈值。 */
export function pendingPolicyFor(collection: string, family: string): PendingPolicy {
  if (family === 'page_scan_zero_success') {
    return policy(1, 1, '最近 1h 同 kind 可判定扫描至少 10 次且成功数为 0，立即 critical');
  }
  if (family === 'revision_regression_identity') {
    return policy(30 * 60, 2 * HOUR, '身份复核每分钟消费；30 分钟未收敛已跨多轮');
  }
  if (collection === 'scan_task:attributions') {
    return policy(30 * HOUR, 72 * HOUR, '约定元数据每 24h 播种；留 6h 抖动，3 天为严重');
  }
  if (collection === 'scan_task:new_page_highfreq') {
    return policy(6 * HOUR, 12 * HOUR, '新页完整投票契约为 3h；两倍周期告警');
  }
  if (family === 'scan_task') {
    return policy(6 * HOUR, 24 * HOUR, 'work-queue 每分钟轮转且失败首退避 1h；6h 已跨多轮');
  }
  if (family === 'revision_source_backfill') {
    return policy(2 * HOUR, 6 * HOUR, '每半小时最多 300 条；非大批追平不应跨四轮无进展');
  }
  if (family === 'revision_source_backfill_processing') {
    return policy(30 * 60, HOUR, 'processing 锁回收契约为 15 分钟；两倍即告警');
  }
  if (family === 'irreconcilable') {
    return policy(8 * DAY, 14 * DAY, '终态每 7 天复查；留 1 天调度余量，两周为严重');
  }
  if (family === 'projection_cursor') {
    return policy(30 * 60, 2 * HOUR, '投影每 10 分钟；30 分钟已连续错过至少两轮');
  }
  if (family === 'ingest_run') {
    return policy(30 * 60, HOUR, '短进程最长配置 25 分钟；30 分钟提示、1 小时自动收口');
  }
  if (family === 'incremental_drift_state') {
    return policy(HOUR, 6 * HOUR, 'L1 五分钟级且 work-queue 每分钟；一小时足够形成多轮证据');
  }
  if (collection === 'pending_page:mismatch') {
    return policy(DAY, 7 * DAY, '身份不一致需人工/上游变化；一天提示、一周严重');
  }
  if (family === 'pending_page') {
    return policy(30 * 60, 2 * HOUR, '身份解析每 5 分钟；30 分钟已错过多轮');
  }
  if (family === 'forum_scan_task_catchup') {
    return policy(2 * HOUR, 6 * HOUR, '论坛冷追平只看下降趋势；停滞两小时提示、六小时严重');
  }
  if (family === 'forum_scan_task_steady') {
    return policy(30 * 60, 2 * HOUR, '论坛增量每 5 分钟发现、每分钟消费；按最老年龄告警');
  }
  if (family === 'forum_incremental_category_state') {
    return policy(30 * 60, 2 * HOUR, '分类信号每 5 分钟发现；半小时未 sweep 已连续漏过多轮');
  }
  if (family === 'forum_link_catchup') {
    return policy(2 * HOUR, 6 * HOUR, '讨论串关联冷启动只看队列下降趋势；停滞才告警');
  }
  if (family === 'forum_discussion_steady') {
    return policy(30 * 60, 2 * HOUR, '页面评论变化走稳态页级任务；按最老年龄告警');
  }
  if (family === 'observation_queue') {
    return policy(30 * 60, 2 * HOUR, '双写观测队列应由短进程持续消费');
  }
  if (family === 'image_ingest_job' || family === 'serve_page_image') {
    return policy(DAY, 3 * DAY, '图片为低优先异步管线；允许一天，三天无推进为严重');
  }
  if (family === 'serve_image_asset') {
    return policy(HOUR, DAY, '资产行已进入抓取态；不应长期停在 pending/fetching/failed');
  }
  if (family === 'serve_vote_snapshot_catchup') {
    return policy(6 * HOUR, DAY, '首轮追平 832/h；大集合下降时抑制，停滞 30m 后按年龄告警');
  }
  if (family === 'serve_vote_snapshot_stale') {
    return policy(36 * DAY, 45 * DAY, '盲扫契约 30 天；加 20% 调度余量');
  }
  if (family === 'incremental_page_state_l1') {
    return policy(30 * 60, HOUR, 'L1 五分钟全站枚举；30 分钟代表连续漏页');
  }
  if (family === 'ingest_gate') {
    return policy(15 * 60, HOUR, 'gate 是事务生命周期行；短事务结束后 15 分钟仍残留即异常');
  }
  if (family === 'revoke_candidate') {
    return policy(2 * HOUR, DAY, '完整快照连续确认后应转正/扣留；held 同样需要人工处理');
  }
  if (family === 'backfill_progress') {
    return policy(6 * HOUR, DAY, '只对 done<total 生效；大批追平下降时不报警，停滞才报警');
  }
  if (family === 'write_freeze') {
    return policy(HOUR, 6 * HOUR, '写冻结是待人工释放的运行态，不能成为常态');
  }
  if (family === 'egress_control') {
    return policy(15 * 60, HOUR, '真实站点 pressure 按分钟窗口恢复；15 分钟未清需值守关注');
  }
  if (family === 'egress_accounting_divergence') {
    return policy(
      15 * 60,
      HOUR,
      'ingest_run 与 gate 最近 1h 失败率已相差至少 5 个百分点且至少 3 倍；持续 15 分钟告警、1 小时 critical',
    );
  }
  if (family === 'serve_page_reference') {
    return policy(DAY, 7 * DAY, '歧义内链需身份变化或人工处理；红链 missing 不属于待处理');
  }
  if (family === 'app_tag_guide_sync') {
    return policy(DAY, 3 * DAY, '约定页同步失败/待同步不应跨多个日级维护周期');
  }
  return policy(6 * HOUR, DAY, '未专门覆盖的新集合使用保守默认；新增集合应补充依据');
}

function epoch(value: string): number {
  const result = Date.parse(value);
  if (!Number.isFinite(result)) throw new TypeError(`非法时间 ${value}`);
  return result;
}

function isHeadProgress(previous: PendingPoint, current: PendingPoint): boolean {
  if (current.pendingCount === 0) return false;
  if (previous.oldestItemKey !== null && current.oldestItemKey !== previous.oldestItemKey) return true;
  if (previous.oldestItemAt === null || current.oldestItemAt === null) return false;
  return epoch(current.oldestItemAt) > epoch(previous.oldestItemAt);
}

function isCountProgress(previous: PendingPoint, current: PendingPoint): boolean {
  return current.pendingCount > 0 && current.pendingCount < previous.pendingCount;
}

function ageSeverity(ageSeconds: number, p: PendingPolicy): PendingSeverity {
  if (ageSeconds >= p.criticalAfterSeconds) return 'critical';
  if (ageSeconds >= p.warnAfterSeconds) return 'warn';
  return 'ok';
}

/**
 * 大批追平只要数量下降或最老实例换人，就证明本轮仍有进展，不因历史年龄误报；但同一个
 * 最老实例若跨过该集合的 critical 窗仍不换人，照样报警，避免多数吞吐掩盖少数饿死。
 * 非追平集合（包括只有 1 项）一旦越线立即告警。
 */
export function evaluatePendingCollection(
  current: PendingCollection,
  history: readonly PendingPoint[],
): PendingDecision {
  const p = pendingPolicyFor(current.collection, current.family);
  if (current.pendingCount === 0 || current.oldestItemAt === null) {
    return {
      severity: 'ok',
      oldestAgeSeconds: null,
      worseningStartedAt: null,
      decision: 'empty',
      policy: p,
    };
  }

  if (
    current.family === 'page_scan_zero_success' ||
    current.family === 'image_ingest_zero_success'
  ) {
    const scans = Number(current.evidence['scans'] ?? current.pendingCount);
    const intermediates = Number(current.evidence['intermediates'] ?? 0);
    const successes = Number(current.evidence['successes'] ?? 0);
    const minimum = Number(
      current.evidence['critical_min_scans'] ?? PIPELINE_SUCCESS_CRITICAL_MIN_SCANS,
    );
    const pipeline = evaluatePipelineSuccess({
      scans,
      successes,
      intermediates,
      criticalMinScans: minimum,
    });
    const ageSeconds = Math.max(
      0,
      Math.floor((epoch(current.observedAt) - epoch(current.oldestItemAt)) / 1_000),
    );
    return {
      severity: pipeline.severity,
      oldestAgeSeconds: ageSeconds,
      worseningStartedAt:
        pipeline.severity === 'critical' ? current.oldestItemAt : null,
      decision: pipeline.decision,
      policy: p,
    };
  }

  const observedMs = epoch(current.observedAt);
  const ageSeconds = Math.max(0, Math.floor((observedMs - epoch(current.oldestItemAt)) / 1_000));
  const severity = ageSeverity(ageSeconds, p);
  if (severity === 'ok') {
    return {
      severity,
      oldestAgeSeconds: ageSeconds,
      worseningStartedAt: null,
      decision: 'below_age_threshold',
      policy: p,
    };
  }

  const points = [...history, current]
    .filter((point) => epoch(point.observedAt) <= observedMs)
    .sort((a, b) => epoch(a.observedAt) - epoch(b.observedAt));

  if (current.catchup) {
    let lastCountProgressDestination = -1;
    let lastProgressDestination = -1;
    for (let index = 1; index < points.length; index++) {
      if (isHeadProgress(points[index - 1]!, points[index]!)) lastProgressDestination = index;
      if (isCountProgress(points[index - 1]!, points[index]!)) {
        lastCountProgressDestination = index;
      }
    }
    const headStallStart = points[Math.max(0, lastProgressDestination)]!;
    if (observedMs - epoch(headStallStart.observedAt) >= p.catchupHeadStallSeconds * 1_000) {
      return {
        severity,
        oldestAgeSeconds: ageSeconds,
        worseningStartedAt: headStallStart.observedAt,
        decision: 'catchup_head_stalled',
        policy: p,
      };
    }
    const latestProgressDestination = Math.max(
      lastProgressDestination,
      lastCountProgressDestination,
    );
    if (latestProgressDestination === points.length - 1) {
      return {
        severity: 'ok',
        oldestAgeSeconds: ageSeconds,
        worseningStartedAt: null,
        decision: 'catchup_progressing',
        policy: p,
      };
    }
    const stallStart = points[Math.max(0, latestProgressDestination)]!;
    if (observedMs - epoch(stallStart.observedAt) < p.catchupTrendSeconds * 1_000) {
      return {
        severity: 'ok',
        oldestAgeSeconds: ageSeconds,
        worseningStartedAt: null,
        decision: 'catchup_waiting_for_trend_evidence',
        policy: p,
      };
    }
    return {
      severity,
      oldestAgeSeconds: ageSeconds,
      worseningStartedAt: stallStart.observedAt,
      decision: 'catchup_stalled',
      policy: p,
    };
  }

  let worseningStartedAt = current.observedAt;
  for (let index = points.length - 1; index >= 0; index--) {
    const point = points[index]!;
    if (point.pendingCount === 0 || point.oldestItemAt === null) break;
    const pointAge = Math.max(0, Math.floor((epoch(point.observedAt) - epoch(point.oldestItemAt)) / 1_000));
    if (pointAge < p.warnAfterSeconds) break;
    worseningStartedAt = point.observedAt;
  }
  return {
    severity,
    oldestAgeSeconds: ageSeconds,
    worseningStartedAt,
    decision: 'age_threshold_exceeded',
    policy: p,
  };
}

interface CurrentRow {
  collection: string;
  family: string;
  pending_count: string;
  oldest_item_at: Date | string | null;
  oldest_item_key: string | null;
  catchup: boolean;
  evidence: Record<string, unknown>;
}

interface HistoryRow extends CurrentRow {
  observed_at: Date | string;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function point(row: HistoryRow): PendingPoint {
  return {
    observedAt: iso(row.observed_at),
    pendingCount: Number(row.pending_count),
    oldestItemAt: row.oldest_item_at === null ? null : iso(row.oldest_item_at),
    oldestItemKey: row.oldest_item_key,
    catchup: row.catchup,
  };
}

export interface CaptureOldestPendingResult {
  observedAt: string;
  collections: number;
  warnings: number;
  critical: number;
  openedOrUpdated: number;
  resolved: number;
  alerts: Array<{
    collection: string;
    severity: Exclude<PendingSeverity, 'ok'>;
    worseningStartedAt: string;
    oldestAgeHours: number;
    pendingCount: number;
  }>;
}

async function captureInTransaction(
  db: PoolClient,
  observedAt: string,
): Promise<CaptureOldestPendingResult> {
  await query(
    db,
    'oldest_pending:lock',
    `SELECT pg_advisory_xact_lock(hashtextextended('syncer2:oldest-pending', 0))`,
  );
  const database = await query<{ database: string }>(
    db,
    'oldest_pending:database_guard',
    `SELECT current_database() AS database`,
  );
  const databaseName = database.rows[0]?.database ?? '';
  if (['scpper-cn', 'scpper_cn', 'scpper-syncer', 'scpper_user'].includes(databaseName)) {
    throw new Error(`拒绝在受保护库 ${databaseName} 写 oldest-pending 时间序列`);
  }

  // 先刷新“真实 run 结果 vs gate attempt”滚动对账，随后 current view 才能把本次状态
  // 与其它待处理集合一起采样、累积 episode 并在恢复后明确收口。
  await observeEgressAccounting(db, observedAt);

  const currentRows = await query<CurrentRow>(
    db,
    'oldest_pending:current',
    `SELECT collection, family, pending_count::text, oldest_item_at,
            oldest_item_key, catchup, evidence
       FROM meta.pending_collection_current
      ORDER BY collection`,
  );
  const historyRows = await query<HistoryRow>(
    db,
    'oldest_pending:history',
    `SELECT observed_at, collection, family, pending_count::text, oldest_item_at,
            oldest_item_key, catchup, evidence
       FROM meta.pending_collection_sample
      WHERE observed_at >= $1::timestamptz - interval '7 days'
      ORDER BY collection, observed_at`,
    [observedAt],
  );
  const latestRows = await query<HistoryRow>(
    db,
    'oldest_pending:latest',
    `SELECT DISTINCT ON (collection)
            observed_at, collection, family, pending_count::text, oldest_item_at,
            oldest_item_key, catchup, evidence
       FROM meta.pending_collection_sample
      ORDER BY collection, observed_at DESC`,
  );

  const historyByCollection = new Map<string, PendingPoint[]>();
  for (const row of historyRows.rows) {
    const values = historyByCollection.get(row.collection) ?? [];
    values.push(point(row));
    historyByCollection.set(row.collection, values);
  }

  const collections = new Map<string, PendingCollection>();
  for (const row of currentRows.rows) {
    collections.set(row.collection, {
      collection: row.collection,
      family: row.family,
      observedAt,
      pendingCount: Number(row.pending_count),
      oldestItemAt: row.oldest_item_at === null ? null : iso(row.oldest_item_at),
      oldestItemKey: row.oldest_item_key,
      catchup: row.catchup,
      evidence: row.evidence ?? {},
    });
  }
  // 消失的集合也写 0 点，告警 episode 才有可审计的明确收口，而不是“后来查不到了”。
  for (const row of latestRows.rows) {
    if (Number(row.pending_count) <= 0 || collections.has(row.collection)) continue;
    collections.set(row.collection, {
      collection: row.collection,
      family: row.family,
      observedAt,
      pendingCount: 0,
      oldestItemAt: null,
      oldestItemKey: null,
      catchup: false,
      evidence: { cleared_after: iso(row.observed_at) },
    });
  }

  const samples = [...collections.values()].map((current) => {
    const decision = evaluatePendingCollection(
      current,
      historyByCollection.get(current.collection) ?? [],
    );
    return { current, decision };
  });
  if (samples.length > 0) {
    await query(
      db,
      'oldest_pending:insert_samples',
      `INSERT INTO meta.pending_collection_sample(
         observed_at, collection, family, pending_count, oldest_item_at, oldest_item_key,
         oldest_age_seconds, catchup, severity, worsening_started_at,
         warn_after_seconds, critical_after_seconds, decision, policy_reason, evidence
       )
       SELECT $1::timestamptz, x.collection, x.family, x.pending_count,
              x.oldest_item_at, x.oldest_item_key, x.oldest_age_seconds,
              x.catchup, x.severity, x.worsening_started_at,
              x.warn_after_seconds, x.critical_after_seconds,
              x.decision, x.policy_reason, x.evidence
         FROM jsonb_to_recordset($2::jsonb) AS x(
           collection text, family text, pending_count bigint,
           oldest_item_at timestamptz, oldest_item_key text, oldest_age_seconds bigint,
           catchup boolean, severity text, worsening_started_at timestamptz,
           warn_after_seconds bigint, critical_after_seconds bigint,
           decision text, policy_reason text, evidence jsonb
         )`,
      [
        observedAt,
        toPgJson(
          samples.map(({ current, decision }) => ({
            collection: current.collection,
            family: current.family,
            pending_count: current.pendingCount,
            oldest_item_at: current.oldestItemAt,
            oldest_item_key: current.oldestItemKey,
            oldest_age_seconds: decision.oldestAgeSeconds,
            catchup: current.catchup,
            severity: decision.severity,
            worsening_started_at: decision.worseningStartedAt,
            warn_after_seconds: decision.policy.warnAfterSeconds,
            critical_after_seconds: decision.policy.criticalAfterSeconds,
            decision: decision.decision,
            policy_reason: decision.policy.reason,
            evidence: current.evidence,
          })),
          'oldest_pending.samples',
        ),
      ],
    );
  }

  const alerting = samples.filter(
    (sample): sample is typeof sample & {
      decision: PendingDecision & {
        severity: 'warn' | 'critical';
        worseningStartedAt: string;
        oldestAgeSeconds: number;
      };
    } => sample.decision.severity !== 'ok'
      && sample.decision.worseningStartedAt !== null
      && sample.decision.oldestAgeSeconds !== null,
  );
  for (const { current, decision } of alerting) {
    await query(
      db,
      'oldest_pending:upsert_alert',
      `INSERT INTO meta.pending_collection_alert(
         collection, family, severity, started_at, first_alerted_at, last_alerted_at,
         max_pending_count, max_oldest_age_seconds, latest_oldest_item_key,
         latest_decision, evidence
       ) VALUES (
         $1, $2, $3, $4::timestamptz, $5::timestamptz, $5::timestamptz,
         $6, $7, $8, $9, $10::jsonb
       )
       ON CONFLICT (collection) WHERE resolved_at IS NULL DO UPDATE
         SET severity = CASE
                          WHEN meta.pending_collection_alert.severity = 'critical'
                            OR EXCLUDED.severity = 'critical' THEN 'critical'
                          ELSE 'warn'
                        END,
             started_at = LEAST(meta.pending_collection_alert.started_at, EXCLUDED.started_at),
             last_alerted_at = EXCLUDED.last_alerted_at,
             samples = meta.pending_collection_alert.samples + 1,
             max_pending_count = GREATEST(
               meta.pending_collection_alert.max_pending_count, EXCLUDED.max_pending_count
             ),
             max_oldest_age_seconds = GREATEST(
               meta.pending_collection_alert.max_oldest_age_seconds,
               EXCLUDED.max_oldest_age_seconds
             ),
             latest_oldest_item_key = EXCLUDED.latest_oldest_item_key,
             latest_decision = EXCLUDED.latest_decision,
             evidence = EXCLUDED.evidence`,
      [
        current.collection,
        current.family,
        decision.severity,
        decision.worseningStartedAt,
        observedAt,
        current.pendingCount,
        decision.oldestAgeSeconds,
        current.oldestItemKey,
        decision.decision,
        toPgJson(current.evidence, `oldest_pending.alert:${current.collection}`),
      ],
    );
  }

  const activeAlerts = alerting.map(({ current }) => current.collection);
  const resolved = await query(
    db,
    'oldest_pending:resolve_alerts',
    `UPDATE meta.pending_collection_alert
        SET resolved_at = $1::timestamptz
      WHERE resolved_at IS NULL
        AND NOT (collection = ANY($2::text[]))`,
    [observedAt, activeAlerts],
  );

  return {
    observedAt,
    collections: samples.length,
    warnings: alerting.filter(({ decision }) => decision.severity === 'warn').length,
    critical: alerting.filter(({ decision }) => decision.severity === 'critical').length,
    openedOrUpdated: alerting.length,
    resolved: resolved.rowCount ?? 0,
    alerts: alerting.map(({ current, decision }) => ({
      collection: current.collection,
      severity: decision.severity,
      worseningStartedAt: decision.worseningStartedAt,
      oldestAgeHours: Math.round((decision.oldestAgeSeconds / HOUR) * 10) / 10,
      pendingCount: current.pendingCount,
    })),
  };
}

export async function captureOldestPending(
  pool: Pool,
  observedAt: string = new Date().toISOString(),
): Promise<CaptureOldestPendingResult> {
  const timestamp = toPgTimestamptz(observedAt);
  // 巡检本身每 5 分钟运行：即使没有新的采集 run 启动，也能收口异常退出留下的孤儿。
  await reapStaleIngestRuns(pool);
  return withTransaction(pool, 'oldest_pending:capture', (db) =>
    captureInTransaction(db, timestamp));
}
