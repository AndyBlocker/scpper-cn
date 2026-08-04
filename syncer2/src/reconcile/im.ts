/**
 * 面向 IM 的对账快照。
 *
 * 这里刻意只读取 scpper-v2 的 meta 证据，不碰 v1，也不把连接串、代理地址、
 * 出口 IP/节点名或错误堆栈放进消息。调用方拿到的是一行可 JSON.stringify 的
 * 小对象；qqbot 只负责分“日报 / 告警”两个通道发送和去重。
 */

import type { Pool } from 'pg';
import { query } from '../store/db.js';

const RECONCILE_REQUIRED_FROM = '2026-07-29';
const MAX_ALERT_LINES = 6;

type JsonRecord = Record<string, unknown>;

interface ReconcileSnapshot {
  id: number;
  status: string;
  finishedAt: string;
  report: JsonRecord;
}

interface CoverageSnapshot {
  runId: number;
  missed: number;
  changes: number;
  coverageRate: number | null;
  rollingChanges: number;
  rollingCaptured: number;
  rollingCoverage: number | null;
  measuredAt: string;
}

export interface LayerHealth {
  layer: string;
  ok: number;
  total: number;
  successRate: number | null;
  averageTransportFailureRate: number | null;
  maxTransportFailureRate: number | null;
  latestRunId: number | null;
  latestStatus: string | null;
  consecutiveFailures: number;
  failureIncidentRunId: number | null;
  runningAgeSeconds: number | null;
}

interface EgressHealth {
  runId: number | null;
  distinctIps: number;
  distinctNodes: number;
  observations: number;
  topNodeShare: number | null;
  attributedFailures: number;
  mihomoReachable: boolean | null;
}

interface ParseDeviation {
  source: string;
  mode: string;
  metric: string;
  action: string;
  runId: number;
}

interface FreezeState {
  domain: string;
  frozenAt: string | null;
}

export interface QueueHealth {
  name: string;
  ready: number;
  total: number;
  oldestReadySeconds: number;
  staleLocks: number;
}

interface PageScanVolume {
  rowsEstimate: number;
  bytes: number;
}

interface AlertItem {
  key: string;
  detail: string;
}

export interface ImReconcileReport {
  type: 'syncer2-reconcile-im';
  version: 1;
  generatedAt: string;
  dailyKey: string;
  dailyReady: boolean;
  severity: 'ok' | 'alert';
  alertKeys: string[];
  reportId: number | null;
  dailyMessage: string;
  alertMessage: string | null;
  testMessage: string;
  metrics: {
    triangle: string;
    coverage: string;
    parity: string;
    layers: LayerHealth[];
    transportFailureRate: number | null;
    egress: EgressHealth;
    parseDeviationCount: number;
    frozenDomains: number;
    queues: QueueHealth[];
    pageScan: PageScanVolume;
  };
}

interface LayerAggregateRow {
  layer: string;
  ok_count: string;
  total_count: string;
  avg_transport: string | number | null;
  max_transport: string | number | null;
}

interface RecentRunRow {
  id: string;
  layer: string;
  status: string;
  started_at: Date | string;
}

export async function collectImReconcileReport(
  pool: Pool,
  now: Date = new Date(),
): Promise<ImReconcileReport> {
  const [
    reconcile,
    coverage,
    layerAggregates,
    recentRuns,
    egress,
    deviations,
    freezes,
    queues,
    pageScan,
  ] = await Promise.all([
    loadLatestReconcile(pool),
    loadCoverage(pool),
    loadLayerAggregates(pool),
    loadRecentRuns(pool),
    loadEgress(pool),
    loadActiveParseDeviations(pool),
    loadFreezes(pool),
    loadQueues(pool),
    loadPageScanVolume(pool),
  ]);

  const layers = assembleLayerHealth(layerAggregates, recentRuns, now);
  const alerts = buildAlerts({
    now,
    reconcile,
    coverage,
    layers,
    egress,
    deviations,
    freezes,
    queues,
    pageScan,
  });
  const dailyKey = shanghaiParts(now).day;
  const reportDay = reconcile ? shanghaiParts(new Date(reconcile.finishedAt)).day : null;
  const dailyReady = reportDay === dailyKey;
  const triangle = formatTriangle(reconcile);
  const coverageText = formatCoverage(coverage);
  const parity = formatParity(reconcile);
  const transportFailureRate = weightedTransport(layers);
  const dailyMessage = formatDailyMessage({
    day: dailyKey,
    reportId: reconcile?.id ?? null,
    triangle,
    coverage: coverageText,
    parity,
    layers,
    transportFailureRate,
    egress,
    deviations,
    freezes,
    queues,
    pageScan,
  });
  const alertMessage =
    alerts.length === 0
      ? null
      : formatAlertMessage({
          at: now,
          alerts,
          reportId: reconcile?.id ?? null,
          triangle,
          coverage: coverageText,
          parity,
          layers,
          transportFailureRate,
          egress,
          pageScan,
        });

  return {
    type: 'syncer2-reconcile-im',
    version: 1,
    generatedAt: now.toISOString(),
    dailyKey,
    dailyReady,
    severity: alerts.length === 0 ? 'ok' : 'alert',
    alertKeys: alerts.map((alert) => alert.key),
    reportId: reconcile?.id ?? null,
    dailyMessage,
    alertMessage,
    testMessage: `【测试｜syncer2 对账推送】\n${alertMessage ?? dailyMessage}\n（仅验证 QQ 通道，不计入正式告警）`,
    metrics: {
      triangle,
      coverage: coverageText,
      parity,
      layers,
      transportFailureRate,
      egress,
      parseDeviationCount: deviations.length,
      frozenDomains: freezes.length,
      queues,
      pageScan,
    },
  };
}

async function loadLatestReconcile(pool: Pool): Promise<ReconcileSnapshot | null> {
  const result = await query<{
    id: string;
    status: string;
    finished_at: Date | string;
    report: unknown;
  }>(
    pool,
    'im:latest-reconcile',
    `SELECT id::text, status, finished_at, report
       FROM meta.reconcile_report
      ORDER BY finished_at DESC, id DESC
      LIMIT 1`,
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: Number(row.id),
    status: row.status,
    finishedAt: iso(row.finished_at),
    report: asRecord(row.report),
  };
}

async function loadCoverage(pool: Pool): Promise<CoverageSnapshot | null> {
  const result = await query<{
    l1_run_id: string;
    l0_missed_changes: number;
    l1_revision_changes: number;
    coverage_rate: string | number | null;
    rolling_7d_changes: number;
    rolling_7d_captured: number;
    rolling_7d_coverage: string | number | null;
    measured_at: Date | string;
  }>(
    pool,
    'im:coverage',
    `SELECT l1_run_id::text, l0_missed_changes, l1_revision_changes,
            coverage_rate, rolling_7d_changes, rolling_7d_captured,
            rolling_7d_coverage, measured_at
       FROM meta.revision_coverage_metric
      ORDER BY measured_at DESC, l1_run_id DESC
      LIMIT 1`,
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    runId: Number(row.l1_run_id),
    missed: Number(row.l0_missed_changes),
    changes: Number(row.l1_revision_changes),
    coverageRate: nullableNumber(row.coverage_rate),
    rollingChanges: Number(row.rolling_7d_changes),
    rollingCaptured: Number(row.rolling_7d_captured),
    rollingCoverage: nullableNumber(row.rolling_7d_coverage),
    measuredAt: iso(row.measured_at),
  };
}

async function loadLayerAggregates(pool: Pool): Promise<LayerAggregateRow[]> {
  const result = await query<LayerAggregateRow>(
    pool,
    'im:layer-aggregates',
    `WITH classified AS (
       SELECT
         CASE
           WHEN stats->>'layer' IN ('L0','L1','L2','L3') THEN stats->>'layer'
           WHEN source = 'wikidot_tier2'
             AND COALESCE(stats->>'mode','') = 'tier2' THEN 'T2'
           WHEN source = 'reconcile' THEN 'R'
           ELSE NULL
         END AS layer,
         started_at, status, transport_failure_rate
       FROM meta.ingest_run
       WHERE started_at >= now() - interval '8 days'
     )
     SELECT layer,
            count(*) FILTER (WHERE status IN ('ok','partial'))::text AS ok_count,
            count(*) FILTER (WHERE status <> 'running')::text AS total_count,
            avg(transport_failure_rate) FILTER (WHERE status <> 'running') AS avg_transport,
            max(transport_failure_rate) FILTER (WHERE status <> 'running') AS max_transport
       FROM classified
      WHERE layer IS NOT NULL
        AND started_at >= now() -
          CASE WHEN layer IN ('L3','R') THEN interval '8 days' ELSE interval '24 hours' END
      GROUP BY layer
      ORDER BY layer`,
  );
  return result.rows;
}

async function loadRecentRuns(pool: Pool): Promise<RecentRunRow[]> {
  const result = await query<RecentRunRow>(
    pool,
    'im:recent-runs',
    `WITH classified AS (
       SELECT id,
              CASE
                WHEN stats->>'layer' IN ('L0','L1','L2','L3') THEN stats->>'layer'
                WHEN source = 'wikidot_tier2'
                  AND COALESCE(stats->>'mode','') = 'tier2' THEN 'T2'
                WHEN source = 'reconcile' THEN 'R'
                ELSE NULL
              END AS layer,
              status, started_at
         FROM meta.ingest_run
        WHERE started_at >= now() - interval '8 days'
     ), ranked AS (
       SELECT id, layer, status, started_at,
              row_number() OVER (PARTITION BY layer ORDER BY started_at DESC, id DESC) AS rn
         FROM classified
        WHERE layer IS NOT NULL
     )
     SELECT id::text, layer, status, started_at
       FROM ranked
      WHERE rn <= 8
      ORDER BY layer, rn`,
  );
  return result.rows;
}

async function loadEgress(pool: Pool): Promise<EgressHealth> {
  const result = await query<{ id: string; exit_ip_stats: unknown }>(
    pool,
    'im:egress',
    `SELECT id::text, exit_ip_stats
       FROM meta.ingest_run
      WHERE stats->>'layer' = 'L1'
        AND finished_at IS NOT NULL
      ORDER BY started_at DESC, id DESC
      LIMIT 1`,
  );
  const row = result.rows[0];
  if (!row) return emptyEgress();
  const stats = asRecord(row.exit_ip_stats);
  const byNode = asRecord(stats['byNode']);
  const observations = Object.values(byNode).reduce<number>(
    (sum, value) => sum + numberFrom(asRecord(value)['observations']),
    0,
  );
  const top = Object.values(byNode).reduce<number>(
    (max, value) => Math.max(max, numberFrom(asRecord(value)['observations'])),
    0,
  );
  const failureByNode = asRecord(stats['transportFailureByNode']);
  const failures = Object.values(failureByNode).reduce<number>(
    (sum, value) => sum + failureCount(value),
    0,
  );
  const mihomo = asRecord(stats['mihomo']);
  return {
    runId: Number(row.id),
    distinctIps: numberFrom(stats['distinctIps']),
    distinctNodes: numberFrom(stats['distinctNodes']),
    observations,
    topNodeShare: observations > 0 ? top / observations : null,
    attributedFailures: failures,
    mihomoReachable:
      typeof mihomo['reachable'] === 'boolean' ? mihomo['reachable'] : null,
  };
}

async function loadActiveParseDeviations(pool: Pool): Promise<ParseDeviation[]> {
  const result = await query<{
    source: string;
    mode: string;
    metric: string;
    action: string;
    run_id: string;
  }>(
    pool,
    'im:parse-deviations',
    `WITH latest AS (
       SELECT DISTINCT ON (
                source,
                COALESCE(NULLIF(stats->>'mode',''),'unspecified'),
                COALESCE(NULLIF(stats->>'population_type',''),'unspecified')
              )
              id, source,
              COALESCE(NULLIF(stats->>'mode',''),'unspecified') AS mode,
              COALESCE(NULLIF(stats->>'population_type',''),'unspecified') AS population_type
         FROM meta.ingest_run
        WHERE finished_at IS NOT NULL
        ORDER BY source,
                 COALESCE(NULLIF(stats->>'mode',''),'unspecified'),
                 COALESCE(NULLIF(stats->>'population_type',''),'unspecified'),
                 started_at DESC, id DESC
     )
     SELECT b.source, b.mode, b.metric, b.action, l.id::text AS run_id
       FROM meta.parse_health_baseline b
       JOIN latest l
         ON l.source = b.source
        AND l.mode = b.mode
        AND l.population_type = b.population_type
        AND l.id = b.last_breach_run
      WHERE b.enabled
      ORDER BY b.action, b.source, b.mode, b.metric`,
  );
  return result.rows.map((row) => ({
    source: row.source,
    mode: row.mode,
    metric: row.metric,
    action: row.action,
    runId: Number(row.run_id),
  }));
}

async function loadFreezes(pool: Pool): Promise<FreezeState[]> {
  const result = await query<{
    domain: string;
    frozen_at: Date | string | null;
  }>(
    pool,
    'im:freezes',
    `SELECT domain, frozen_at
       FROM meta.write_freeze_status()
      WHERE effective
      ORDER BY domain`,
  );
  return result.rows.map((row) => ({
    domain: row.domain,
    frozenAt: row.frozen_at === null ? null : iso(row.frozen_at),
  }));
}

async function loadQueues(pool: Pool): Promise<QueueHealth[]> {
  const result = await query<{
    name: string;
    ready: string;
    total: string;
    oldest_ready_seconds: string | number | null;
    stale_locks: string;
  }>(
    pool,
    'im:queues',
    `SELECT 'scan_task' AS name,
            count(*) FILTER (
              WHERE locked_by IS NULL AND COALESCE(not_before, now()) <= now()
            )::text AS ready,
            count(*)::text AS total,
            COALESCE(extract(epoch FROM now() - min(created_at) FILTER (
              WHERE locked_by IS NULL AND COALESCE(not_before, now()) <= now()
            )), 0)::text AS oldest_ready_seconds,
            count(*) FILTER (
              WHERE locked_by IS NOT NULL AND locked_at < now() - interval '15 minutes'
            )::text AS stale_locks
       FROM meta.scan_task
     UNION ALL
     SELECT 'pending_page',
            count(*) FILTER (
              WHERE status = 'pending' AND locked_by IS NULL
                AND COALESCE(not_before, now()) <= now()
            )::text,
            count(*) FILTER (WHERE status = 'pending')::text,
            COALESCE(extract(epoch FROM now() - min(first_seen_at) FILTER (
              WHERE status = 'pending' AND locked_by IS NULL
                AND COALESCE(not_before, now()) <= now()
            )), 0)::text,
            count(*) FILTER (
              WHERE locked_by IS NOT NULL AND locked_at < now() - interval '15 minutes'
            )::text
       FROM meta.pending_page
     UNION ALL
     SELECT 'forum_scan_task',
            count(*) FILTER (
              WHERE locked_by IS NULL AND COALESCE(not_before, now()) <= now()
            )::text,
            count(*)::text,
            COALESCE(extract(epoch FROM now() - min(first_seen_at) FILTER (
              WHERE locked_by IS NULL AND COALESCE(not_before, now()) <= now()
            )), 0)::text,
            count(*) FILTER (
              WHERE locked_by IS NOT NULL AND locked_at < now() - interval '30 minutes'
            )::text
       FROM meta.forum_scan_task
     UNION ALL
     SELECT 'observation_queue',
            count(*) FILTER (WHERE status <> 'done')::text,
            count(*) FILTER (WHERE status <> 'done')::text,
            COALESCE(extract(epoch FROM now() - min(enqueued_at) FILTER (
              WHERE status <> 'done'
            )), 0)::text,
            '0'
       FROM meta.observation_queue`,
  );
  return result.rows.map((row) => ({
    name: row.name,
    ready: Number(row.ready),
    total: Number(row.total),
    oldestReadySeconds: Math.max(0, Math.round(numberFrom(row.oldest_ready_seconds))),
    staleLocks: Number(row.stale_locks),
  }));
}

async function loadPageScanVolume(pool: Pool): Promise<PageScanVolume> {
  const result = await query<{ rows_estimate: string; bytes: string }>(
    pool,
    'im:page-scan-volume',
    `SELECT COALESCE(s.n_live_tup, 0)::bigint::text AS rows_estimate,
            pg_total_relation_size('meta.page_scan')::bigint::text AS bytes
       FROM pg_stat_user_tables s
      WHERE s.schemaname = 'meta' AND s.relname = 'page_scan'`,
  );
  const row = result.rows[0];
  return {
    rowsEstimate: Number(row?.rows_estimate ?? 0),
    bytes: Number(row?.bytes ?? 0),
  };
}

function assembleLayerHealth(
  aggregates: readonly LayerAggregateRow[],
  recent: readonly RecentRunRow[],
  now: Date,
): LayerHealth[] {
  const latestByLayer = new Map<string, RecentRunRow[]>();
  for (const row of recent) {
    const rows = latestByLayer.get(row.layer) ?? [];
    rows.push(row);
    latestByLayer.set(row.layer, rows);
  }
  const aggregateByLayer = new Map(aggregates.map((row) => [row.layer, row]));
  const ordered = ['L0', 'L1', 'L2', 'L3', 'T2', 'R'];
  return ordered
    .filter((layer) => aggregateByLayer.has(layer) || latestByLayer.has(layer))
    .map((layer) => {
      const aggregate = aggregateByLayer.get(layer);
      const rows = latestByLayer.get(layer) ?? [];
      const newest = rows[0] ?? null;
      const completed = rows.filter((row) => row.status !== 'running');
      let consecutiveFailures = 0;
      for (const row of completed) {
        if (row.status === 'ok' || row.status === 'partial') break;
        consecutiveFailures++;
      }
      const incidentRows = completed.slice(0, consecutiveFailures);
      const failureIncidentRunId =
        consecutiveFailures >= 2
          ? Math.min(...incidentRows.map((row) => Number(row.id)))
          : null;
      const total = Number(aggregate?.total_count ?? 0);
      const ok = Number(aggregate?.ok_count ?? 0);
      return {
        layer,
        ok,
        total,
        successRate: total > 0 ? ok / total : null,
        averageTransportFailureRate: nullableNumber(aggregate?.avg_transport ?? null),
        maxTransportFailureRate: nullableNumber(aggregate?.max_transport ?? null),
        latestRunId: newest ? Number(newest.id) : null,
        latestStatus: newest?.status ?? null,
        consecutiveFailures,
        failureIncidentRunId,
        runningAgeSeconds:
          newest?.status === 'running'
            ? Math.max(0, (now.getTime() - new Date(newest.started_at).getTime()) / 1_000)
            : null,
      };
    });
}

function buildAlerts(input: {
  now: Date;
  reconcile: ReconcileSnapshot | null;
  coverage: CoverageSnapshot | null;
  layers: readonly LayerHealth[];
  egress: EgressHealth;
  deviations: readonly ParseDeviation[];
  freezes: readonly FreezeState[];
  queues: readonly QueueHealth[];
  pageScan: PageScanVolume;
}): AlertItem[] {
  const alerts: AlertItem[] = [];
  const parts = shanghaiParts(input.now);
  const report = input.reconcile?.report ?? {};
  const triangle = asRecord(report['triangle']);
  const enumeration = asRecord(triangle['enumeration']);
  const active = asRecord(triangle['active']);
  const parity = asRecord(report['parity']);
  const alignment = asRecord(parity['stateAlignment']);
  const whitelist = asRecord(parity['whitelist']);
  const freezeTrack = asRecord(parity['freeze']);
  const crom = asRecord(report['crom']);

  if (
    input.reconcile === null &&
    parts.day >= RECONCILE_REQUIRED_FROM &&
    parts.minutes >= 6 * 60 + 36
  ) {
    alerts.push({
      key: `reconcile:missing:${parts.day}`,
      detail: '06:13 对账未在 06:36 前产出报告',
    });
  } else if (
    input.reconcile &&
    shanghaiParts(new Date(input.reconcile.finishedAt)).day !== parts.day &&
    parts.day >= RECONCILE_REQUIRED_FROM &&
    parts.minutes >= 6 * 60 + 36
  ) {
    alerts.push({
      key: `reconcile:missing:${parts.day}`,
      detail: `今日 06:13 对账未产出（最新报告 #${input.reconcile.id}）`,
    });
  }
  if (input.reconcile?.status === 'failed' || input.reconcile?.status === 'aborted') {
    alerts.push({
      key: `reconcile:${input.reconcile.id}:${input.reconcile.status}`,
      detail: `对账 #${input.reconcile.id} ${input.reconcile.status}`,
    });
  }
  const enumMiss = numberFrom(asRecord(enumeration['counts'])['unexplained']);
  if (enumMiss > 0 && input.reconcile) {
    alerts.push({
      key: `triangle:enum:${input.reconcile.id}`,
      detail: `sitemap↔ListPages 未解释差 ${enumMiss}`,
    });
  }
  const requested = numberFrom(active['requestedPages']);
  const voteMatches = numberFrom(active['voteMatches']);
  const revisionMatches = numberFrom(active['revisionMatches']);
  if (requested > 0 && (voteMatches < requested || revisionMatches < requested) && input.reconcile) {
    alerts.push({
      key: `triangle:active:${input.reconcile.id}`,
      detail: `站内校验：票 ${voteMatches}/${requested}，修订 ${revisionMatches}/${requested}`,
    });
  }
  const parityRate = nullableNumber(alignment['diffRate']);
  const parityThreshold = nullableNumber(alignment['threshold']);
  const unexplained = numberFrom(alignment['unexplainedPages']);
  if (
    input.reconcile &&
    ((parityRate !== null && parityThreshold !== null && parityRate >= parityThreshold) ||
      unexplained > 0)
  ) {
    alerts.push({
      key: `parity:state:${input.reconcile.id}`,
      detail: `parity 状态轨 ${percent(parityRate)}（阈值 ${percent(parityThreshold)}），未解释 ${unexplained}`,
    });
  }
  if (input.reconcile && Object.keys(asRecord(whitelist['growth'])).length > 0) {
    alerts.push({
      key: `parity:whitelist:${input.reconcile.id}`,
      detail: `parity 白名单轨有 ${Object.keys(asRecord(whitelist['growth'])).length} 项增长`,
    });
  }
  if (input.reconcile && freezeTrack['changed'] === true) {
    alerts.push({
      key: `parity:freeze:${input.reconcile.id}`,
      detail: 'parity 已删页冻结轨 checksum 变化',
    });
  }
  const cromDiffs =
    numberFrom(crom['cromOnly']) +
    numberFrom(crom['v2Only']) +
    Object.values(asRecord(crom['fields'])).reduce<number>(
      (sum, field) => sum + numberFrom(asRecord(field)['actionableMismatches']),
      0,
    );
  if (input.reconcile && cromDiffs > 0) {
    alerts.push({
      key: `crom:${input.reconcile.id}`,
      detail: `CROM 金丝雀有 ${cromDiffs} 项可行动差异`,
    });
  }

  if (input.coverage?.missed && input.coverage.missed > 0) {
    alerts.push({
      key: `coverage:${input.coverage.runId}`,
      detail: `L0→L1 本轮 miss=${input.coverage.missed}（L1 run #${input.coverage.runId}）`,
    });
  }
  if (
    input.coverage &&
    input.coverage.rollingChanges > 0 &&
    input.coverage.rollingCaptured < input.coverage.rollingChanges
  ) {
    alerts.push({
      key: 'coverage:rolling-7d',
      detail:
        `L0→L1 近 7 日仍有 ` +
        `${input.coverage.rollingChanges - input.coverage.rollingCaptured} miss` +
        `（覆盖 ${percent(input.coverage.rollingCoverage)}）`,
    });
  }

  const maxRunningSeconds: Record<string, number> = {
    L0: 15 * 60,
    L1: 50 * 60,
    L2: 15 * 60,
    L3: 50 * 60,
    T2: 15 * 60,
    R: 25 * 60,
  };
  for (const layer of input.layers) {
    if (layer.consecutiveFailures >= 2 && layer.failureIncidentRunId !== null) {
      alerts.push({
        key: `runs:${layer.layer}:${layer.failureIncidentRunId}`,
        detail: `${layer.layer} 连续 ${layer.consecutiveFailures} 轮失败`,
      });
    }
    if (
      layer.runningAgeSeconds !== null &&
      layer.runningAgeSeconds > (maxRunningSeconds[layer.layer] ?? 3_600)
    ) {
      alerts.push({
        key: `run-stuck:${layer.layer}:${layer.latestRunId ?? 'unknown'}`,
        detail: `${layer.layer} run #${layer.latestRunId ?? '?'} 已运行 ${duration(layer.runningAgeSeconds)}`,
      });
    }
    if (
      layer.maxTransportFailureRate !== null &&
      layer.maxTransportFailureRate > 0.1
    ) {
      alerts.push({
        key: `transport:${layer.layer}`,
        detail: `${layer.layer} 近窗传输失败率最高 ${percent(layer.maxTransportFailureRate)}`,
      });
    }
  }

  if (input.egress.mihomoReachable === false) {
    alerts.push({
      key: 'egress:mihomo',
      detail: '出口归因控制器不可达',
    });
  }
  if (
    input.egress.observations >= 20 &&
    input.egress.topNodeShare !== null &&
    input.egress.topNodeShare > 0.75
  ) {
    alerts.push({
      key: 'egress:skew',
      detail: `出口节点分布集中，单节点占 ${percent(input.egress.topNodeShare)}`,
    });
  }
  if (input.egress.attributedFailures > 0) {
    alerts.push({
      key: 'egress:failures',
      detail: `出口节点归因到 ${input.egress.attributedFailures} 次传输失败`,
    });
  }
  for (const deviation of input.deviations) {
    alerts.push({
      key: `fingerprint:${deviation.runId}:${deviation.metric}`,
      detail:
        `解析指纹偏离：${deviation.source}/${deviation.mode} ` +
        `${deviation.metric}（${deviation.action}）`,
    });
  }
  for (const freeze of input.freezes) {
    alerts.push({
      key: `freeze:${freeze.domain}`,
      detail: `写入熔断生效：${freeze.domain}`,
    });
  }

  for (const queue of input.queues) {
    const backlogged =
      queue.staleLocks > 0 ||
      (queue.name === 'scan_task' &&
        (queue.ready > 200 || (queue.ready > 0 && queue.oldestReadySeconds > 2 * 3_600))) ||
      (queue.name === 'pending_page' &&
        (queue.ready > 100 || (queue.ready > 0 && queue.oldestReadySeconds > 30 * 60))) ||
      (queue.name === 'forum_scan_task' &&
        (queue.ready > 500 || (queue.ready > 0 && queue.oldestReadySeconds > 24 * 3_600))) ||
      (queue.name === 'observation_queue' &&
        (queue.ready > 100 || (queue.ready > 0 && queue.oldestReadySeconds > 30 * 60)));
    if (backlogged) {
      alerts.push({
        key: `queue:${queue.name}`,
        detail:
          `${queue.name} 可执行积压 ${queue.ready}` +
          `（最老 ${duration(queue.oldestReadySeconds)}，陈旧锁 ${queue.staleLocks}）`,
      });
    }
  }
  if (input.pageScan.rowsEstimate > 5_000_000 || input.pageScan.bytes > 2 * 1_024 ** 3) {
    alerts.push({
      key: 'page-scan:volume',
      detail:
        `page_scan 体积 ${compactInt(input.pageScan.rowsEstimate)} 行 / ` +
        `${bytes(input.pageScan.bytes)}`,
    });
  }
  return uniqueAlerts(alerts);
}

function formatDailyMessage(input: {
  day: string;
  reportId: number | null;
  triangle: string;
  coverage: string;
  parity: string;
  layers: readonly LayerHealth[];
  transportFailureRate: number | null;
  egress: EgressHealth;
  deviations: readonly ParseDeviation[];
  freezes: readonly FreezeState[];
  queues: readonly QueueHealth[];
  pageScan: PageScanVolume;
}): string {
  const due = input.queues.reduce((sum, queue) => sum + queue.ready, 0);
  return [
    `✅ syncer2 日报 ${input.day.slice(5)}${input.reportId ? ` #${input.reportId}` : ''}` +
      `｜三角 ${input.triangle}｜覆盖 ${input.coverage}｜parity ${input.parity}`,
    `采集 ${formatLayers(input.layers)}｜传输 ${percent(input.transportFailureRate)}` +
      `｜出口 ${formatEgress(input.egress)}｜指纹偏离 ${input.deviations.length}` +
      `｜熔断 ${input.freezes.length}｜队列 ${due}｜page_scan ` +
      `${compactInt(input.pageScan.rowsEstimate)}/${bytes(input.pageScan.bytes)}`,
  ].join('\n');
}

function formatAlertMessage(input: {
  at: Date;
  alerts: readonly AlertItem[];
  reportId: number | null;
  triangle: string;
  coverage: string;
  parity: string;
  layers: readonly LayerHealth[];
  transportFailureRate: number | null;
  egress: EgressHealth;
  pageScan: PageScanVolume;
}): string {
  const parts = shanghaiParts(input.at);
  const shown = input.alerts.slice(0, MAX_ALERT_LINES);
  const lines = [
    `🚨 syncer2 对账告警｜${parts.day.slice(5)} ${parts.time}`,
    ...shown.map((alert) => `• ${alert.detail}`),
  ];
  if (input.alerts.length > shown.length) {
    lines.push(`• 另有 ${input.alerts.length - shown.length} 项，见结构化摘要`);
  }
  lines.push(
    `概览：三角 ${input.triangle}｜覆盖 ${input.coverage}｜parity ${input.parity}`,
    `采集 ${formatLayers(input.layers)}｜传输 ${percent(input.transportFailureRate)}` +
      `｜出口 ${formatEgress(input.egress)}｜page_scan ` +
      `${compactInt(input.pageScan.rowsEstimate)}/${bytes(input.pageScan.bytes)}`,
  );
  if (input.reportId !== null) lines.push(`详情：meta.reconcile_report #${input.reportId}`);
  return lines.join('\n');
}

function formatTriangle(reconcile: ReconcileSnapshot | null): string {
  if (!reconcile) return '待首轮';
  const triangle = asRecord(reconcile.report['triangle']);
  if (Object.keys(triangle).length === 0) return '未执行';
  const enumeration = asRecord(triangle['enumeration']);
  const active = asRecord(triangle['active']);
  const enumMiss = numberFrom(asRecord(enumeration['counts'])['unexplained']);
  const requested = numberFrom(active['requestedPages']);
  return (
    `枚举差${enumMiss}・票${numberFrom(active['voteMatches'])}/${requested}` +
    `・修订${numberFrom(active['revisionMatches'])}/${requested}`
  );
}

function formatCoverage(coverage: CoverageSnapshot | null): string {
  if (!coverage) return '无证据';
  const rollingMiss = coverage.rollingChanges - coverage.rollingCaptured;
  return (
    `miss=${coverage.missed}` +
    `（7d ${percent(coverage.rollingCoverage)} / miss=${Math.max(0, rollingMiss)}）`
  );
}

function formatParity(reconcile: ReconcileSnapshot | null): string {
  if (!reconcile) return '待首轮';
  const parity = asRecord(reconcile.report['parity']);
  if (Object.keys(parity).length === 0) return '未执行';
  const alignment = asRecord(parity['stateAlignment']);
  const whitelist = asRecord(parity['whitelist']);
  const freeze = asRecord(parity['freeze']);
  const growth = Object.keys(asRecord(whitelist['growth'])).length;
  return (
    `状态${percent(nullableNumber(alignment['diffRate']))}` +
    `・白名单+${growth}・冻结${freeze['changed'] === true ? '变' : '稳'}`
  );
}

function formatLayers(layers: readonly LayerHealth[]): string {
  if (layers.length === 0) return '无 run';
  return layers
    .filter((layer) => layer.layer !== 'R')
    .map((layer) => `${layer.layer} ${layer.ok}/${layer.total}`)
    .join(' ');
}

function formatEgress(egress: EgressHealth): string {
  if (egress.runId === null) return '无样本';
  const top = egress.topNodeShare === null ? '—' : percent(egress.topNodeShare);
  return `${egress.distinctNodes}节点/${egress.distinctIps}IP top=${top}`;
}

function weightedTransport(layers: readonly LayerHealth[]): number | null {
  let weighted = 0;
  let total = 0;
  for (const layer of layers) {
    if (layer.layer === 'R' || layer.averageTransportFailureRate === null || layer.total === 0) {
      continue;
    }
    weighted += layer.averageTransportFailureRate * layer.total;
    total += layer.total;
  }
  return total === 0 ? null : weighted / total;
}

function emptyEgress(): EgressHealth {
  return {
    runId: null,
    distinctIps: 0,
    distinctNodes: 0,
    observations: 0,
    topNodeShare: null,
    attributedFailures: 0,
    mihomoReachable: null,
  };
}

function asRecord(value: unknown): JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function numberFrom(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function failureCount(value: unknown): number {
  if (typeof value === 'number' || typeof value === 'string') return numberFrom(value);
  const record = asRecord(value);
  return numberFrom(record['failures'] ?? record['count'] ?? record['observationsAfterFailure']);
}

function iso(value: Date | string): string {
  const parsed = value instanceof Date ? value : new Date(value);
  return parsed.toISOString();
}

function percent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—';
  const digits = value > 0 && value < 0.001 ? 3 : 1;
  return `${(value * 100).toFixed(digits)}%`;
}

function duration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0m';
  if (seconds < 3_600) return `${Math.ceil(seconds / 60)}m`;
  if (seconds < 86_400) return `${(seconds / 3_600).toFixed(1)}h`;
  return `${(seconds / 86_400).toFixed(1)}d`;
}

function compactInt(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(Math.max(0, Math.round(value)));
}

function bytes(value: number): string {
  if (value >= 1_024 ** 3) return `${(value / 1_024 ** 3).toFixed(1)}GB`;
  if (value >= 1_024 ** 2) return `${Math.round(value / 1_024 ** 2)}MB`;
  if (value >= 1_024) return `${Math.round(value / 1_024)}KB`;
  return `${Math.max(0, Math.round(value))}B`;
}

function uniqueAlerts(alerts: readonly AlertItem[]): AlertItem[] {
  const seen = new Set<string>();
  return alerts.filter((alert) => {
    if (seen.has(alert.key)) return false;
    seen.add(alert.key);
    return true;
  });
}

function shanghaiParts(date: Date): { day: string; time: string; minutes: number } {
  const formatter = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const parts = Object.fromEntries(
    formatter
      .formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );
  const hour = Number(parts['hour']);
  const minute = Number(parts['minute']);
  return {
    day: `${parts['year']}-${parts['month']}-${parts['day']}`,
    time: `${parts['hour']}:${parts['minute']}`,
    minutes: hour * 60 + minute,
  };
}
