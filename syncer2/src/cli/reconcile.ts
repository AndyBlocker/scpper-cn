/**
 * M10 单次短进程 CLI。
 *
 * stdout 始终恰好一行 JSON；`--qq-summary` 时该行就是 qqbot 可直接推送的紧凑摘要。
 * v1 连接只执行 BEGIN READ ONLY 内的 SELECT，CROM client 明确 proxyUrl=null，wikidot
 * client 明确走配置里的 127.0.0.1:7891。
 */

import { createLogger, emitSummary, redirectConsoleToStderr } from '../util/log.js';

redirectConsoleToStderr();

import { Command } from 'commander';
import type { Pool } from 'pg';
import { loadConfig } from '../config.js';
import { scanListPages } from '../collect/listpages.js';
import { amcProbePolicyFor, assertEgressContract, parseProbePolicy } from '../http/amc.js';
import { CircuitOpenError, HttpClient } from '../http/client.js';
import {
  evaluateAdaptiveSelfProtection,
  PostgresAdaptiveEgressGate,
} from '../http/adaptiveEgress.js';
import { assertTimezoneRoundTrip, createPool, query } from '../store/db.js';
import { finishIngestRun, startIngestRun } from '../store/meta.js';
import { compareCromCanary, fetchAllCromPages, fetchV2CanaryPages } from '../reconcile/crom.js';
import { runParity } from '../reconcile/parity.js';
import {
  assembleReport,
  assembleTriangleReport,
  buildQqSummary,
  persistReconcileReport,
  type FullReconcileReport,
  type ReconcileMode,
} from '../reconcile/report.js';
import { collectImReconcileReport } from '../reconcile/im.js';
import {
  inconclusiveActiveTriangle,
  loadEnumerationSnapshots,
  runTrianglePageChecks,
  selectTriangleRows,
  summarizeActiveTriangle,
  type EnumerationTriangleReport,
  type TriangleClaimRow,
} from '../reconcile/triangle.js';
import {
  errorMessage,
  isReconcileFailure,
  isReconcileToolFailure,
  unexplainedRatioRegressed,
} from '../reconcile/types.js';
import {
  applyAdaptiveSelfProtectionToRunHealth,
  evaluateRunHealth,
  type RunHealthDecision,
} from '../work/runHealth.js';

/**
 * 未解释占比相对上一轮的容差（绝对百分点）。
 * 迁移期占比本就会随归因推进上下浮动，0.5 个百分点足以滤掉噪声，
 * 又能抓住「新引入一整类分歧」这种真正的坏消息。
 */
const UNEXPLAINED_RATIO_TOLERANCE = 0.005;

const log = createLogger('reconcile');

interface CliOptions {
  mode: ReconcileMode;
  qqSummary: boolean;
  skipTzCheck: boolean;
  lagMinutes: number;
  trianglePages: number;
  liveListpagesBatches?: number;
  snapshotMaxAgeHours: number;
  cromBatchSize: number;
  cromMaxPages?: number;
  cromRequestDelayMs: number;
  concurrency: number;
  amcProbe?: string;
  proxyCheck?: string;
  v1DatabaseUrl?: string;
}

async function main(): Promise<void> {
  const opts = parseArgs();
  const config = loadConfig();
  assertDatabaseName(config.databaseUrl, ['scpper-v2'], 'v2 写入库');
  const observedAt = new Date().toISOString();
  const lagWindowSeconds = opts.lagMinutes * 60;
  const v2Pool = createPool(config.databaseUrl, { max: 4 });
  let v1Pool: Pool | null = null;
  let wikidotHttp: HttpClient | null = null;
  let cromHttp: HttpClient | null = null;
  let runId: number | null = null;
  let reportId: number | null = null;
  let finalReport: FullReconcileReport | null = null;

  try {
    if (opts.skipTzCheck) log.warn('--skip-tz-check 仅供本地诊断，调度器禁止使用');
    else await assertTimezoneRoundTrip(v2Pool);
    await assertV2Database(v2Pool);
    runId = await startIngestRun(v2Pool, 'reconcile', observedAt);

    let parity: Awaited<ReturnType<typeof runParity>> | undefined;
    let crom: ReturnType<typeof compareCromCanary> | undefined;
    let triangle: ReturnType<typeof assembleTriangleReport> | undefined;

    if (opts.mode === 'all' || opts.mode === 'parity') {
      const v1Url = opts.v1DatabaseUrl ?? process.env['SYNCER2_V1_DATABASE_URL'];
      if (!v1Url) {
        throw new Error(
          'parity 模式需要 SYNCER2_V1_DATABASE_URL 或 --v1-database-url；' +
            '该连接只会在 BEGIN READ ONLY 中执行 SELECT',
        );
      }
      assertDatabaseName(v1Url, ['scpper-cn', 'scpper_cn'], 'v1 只读库');
      v1Pool = createPool(v1Url, { max: 2 });
      await assertV1ReadOnlyTarget(v1Pool);
      parity = await runParity(
        v1Pool,
        v2Pool,
        observedAt,
        lagWindowSeconds * 1_000,
      );
    }

    if (opts.mode === 'all' || opts.mode === 'crom') {
      cromHttp = new HttpClient({
        userAgent: config.userAgent,
        referer: config.referer,
        proxyUrl: null,
        timeoutMs: Math.max(config.httpTimeoutMs, 90_000),
        maxAttempts: Math.max(config.httpMaxAttempts, 3),
        breaker503: Math.max(config.breaker503, 5),
        breakerReset: Math.max(config.breakerReset, 5),
        connections: Math.min(2, opts.concurrency),
        logger: log.child('crom-http'),
      });
      cromHttp.assertHeaders();
      const fetched = await fetchAllCromPages(cromHttp, {
        batchSize: opts.cromBatchSize,
        ...(opts.cromMaxPages === undefined ? {} : { maxPages: opts.cromMaxPages }),
        requestDelayMs: opts.cromRequestDelayMs,
      });
      const v2Pages = await fetchV2CanaryPages(v2Pool);
      crom = compareCromCanary(
        fetched,
        v2Pages,
        Date.parse(observedAt),
        lagWindowSeconds * 1_000,
      );
    }

    if (opts.mode === 'all' || opts.mode === 'triangle') {
      wikidotHttp = new HttpClient({
        userAgent: config.userAgent,
        referer: config.referer,
        proxyUrl: config.proxyUrl,
        timeoutMs: config.httpTimeoutMs,
        maxAttempts: Math.max(config.httpMaxAttempts, 3),
        breaker503: Math.max(config.breaker503, 5),
        breakerReset: Math.max(config.breakerReset, 5),
        connections: opts.concurrency,
        logger: log.child('wikidot-http'),
        adaptiveEgress: new PostgresAdaptiveEgressGate(config.databaseUrl, 'reconcile:wikidot'),
        egress: {
          probeUrl: config.exitIpProbeUrl,
          everyNRequests: config.exitIpProbeEvery,
          maxProbes: config.exitIpProbeMax,
          mihomoApi: config.mihomoApi,
          hostFilter: new URL(config.siteBaseUrl).host,
        },
      });
      wikidotHttp.assertHeaders();
      await assertEgressContract(wikidotHttp, {
        baseUrl: config.siteBaseUrl,
        amcPolicy: parseProbePolicy(
          opts.amcProbe ?? config.amcProbe,
          amcProbePolicyFor('wikidot'),
        ),
        proxyPolicy: parseProbePolicy(opts.proxyCheck ?? config.proxyCheck, 'warn'),
        ipProbeUrl: config.exitIpProbeUrl,
        logger: log.child('probe'),
      });

      let enumeration: EnumerationTriangleReport;
      let source: 'snapshots' | 'live_listpages_sample';
      let rows: TriangleClaimRow[];
      let activeInputComplete = true;
      if (opts.liveListpagesBatches !== undefined) {
        const live = await scanListPages(wikidotHttp, config.siteBaseUrl, {
          concurrency: opts.concurrency,
          maxBatches: opts.liveListpagesBatches,
          logger: log.child('triangle-listpages'),
        });
        rows = live.rows;
        source = 'live_listpages_sample';
        enumeration = {
          status: 'inconclusive',
          counts: { compared: 0, differences: 0, unexplained: 0 },
          alerts: [
            `本轮仅请求 ListPages 前 ${live.requestedBatches}/${live.expectedBatches ?? '?'} 批；` +
              '枚举轨 inconclusive，未计算 difference；该现场 claims 仅用于页级三角小样本',
          ],
          source: 'snapshots',
          differenceCountsAvailable: false,
          sitemapCount: 0,
          listPagesCount: live.pagesEnumerated,
          common: null,
          sitemapOnly: null,
          listPagesOnly: null,
          explainedSitemapOnly: null,
          explainedListPagesOnly: null,
          unexplainedSitemapOnly: null,
          unexplainedListPagesOnly: null,
          sitemapSnapshotAt: null,
          listPagesSnapshotAt: observedAt,
          samples: [],
        };
      } else {
        const loaded = loadEnumerationSnapshots(
          config.stateDir,
          Date.parse(observedAt),
          opts.snapshotMaxAgeHours * 3_600_000,
        );
        enumeration = loaded.report;
        activeInputComplete = loaded.status !== 'inconclusive';
        rows =
          activeInputComplete && loaded.listPages
            ? Object.values(loaded.listPages.rows)
            : [];
        source = 'snapshots';
      }
      const active = activeInputComplete
        ? summarizeActiveTriangle(
            await runTrianglePageChecks(
              wikidotHttp,
              v2Pool,
              config.siteBaseUrl,
              rows.length > 0 ? selectTriangleRows(rows, opts.trianglePages) : [],
              opts.concurrency,
            ),
          )
        : inconclusiveActiveTriangle(
            'ListPages claims 来自缺失、损坏或过旧的完整快照，禁止继续页级比对',
          );
      triangle = assembleTriangleReport(
        enumeration,
        active,
        source,
      );
    }

    const finishedAt = new Date().toISOString();
    finalReport = assembleReport({
      mode: opts.mode,
      observedAt,
      finishedAt,
      lagWindowSeconds,
      ...(parity ? { parity } : {}),
      ...(crom ? { crom } : {}),
      ...(triangle ? { triangle } : {}),
      http: {
        ...(wikidotHttp ? { wikidot: compactHttp(wikidotHttp) } : {}),
        ...(cromHttp ? { crom: compactHttp(cromHttp) } : {}),
      },
    });
    const qq = buildQqSummary(finalReport);
    // 基线必须在写入本轮之前读，否则读到的就是自己。
    const baseline = await readPreviousUnexplainedBaseline(v2Pool);
    reportId = await persistReconcileReport(v2Pool, runId, finalReport, qq);
    await finishRun(v2Pool, runId, finalReport, reportId, wikidotHttp, cromHttp);
    const regressed = unexplainedRatioRegressed(
      finalReport.counts,
      baseline,
      UNEXPLAINED_RATIO_TOLERANCE,
    );
    const toolFailed = isReconcileToolFailure(finalReport.status);
    if (regressed) {
      log.error('未解释占比相对上一轮显著恶化', {
        baseline,
        current: finalReport.counts,
        tolerancePoints: UNEXPLAINED_RATIO_TOLERANCE,
      });
    } else if (isReconcileFailure(finalReport.status)) {
      // 已知待归因差异：如实记录，但不占用「单元失败」这个信号位。
      log.warn('对账完成并发现未解释分歧（非工具故障，见报表）', {
        reportId,
        counts: finalReport.counts,
      });
    }
    const health = evaluateRunHealth({
      claimed: 1,
      processed: 1,
      partial: isReconcileFailure(finalReport.status) && !toolFailed ? 1 : 0,
      failed: 0,
      fatalReasons: [
        ...(toolFailed ? ['reconcile_tool_failure'] : []),
        ...(regressed ? ['unexplained_ratio_regressed'] : []),
      ],
    });
    if (opts.qqSummary) {
      emitSummary(await imSummaryOrFallback(v2Pool, qq, reportId));
    } else {
      emitSummary({
        ok: health.exitCode === 0,
        status: finalReport.status,
        health,
        reportId,
        runId,
        counts: finalReport.counts,
        alerts: finalReport.alerts,
        unexplainedBaseline: baseline,
        unexplainedRegressed: regressed,
        qqSummary: qq,
      });
    }
    process.exitCode = health.exitCode;
  } catch (err) {
    const aborted =
      err instanceof CircuitOpenError ||
      wikidotHttp?.breakerOpen === true ||
      cromHttp?.breakerOpen === true;
    const finishedAt = new Date().toISOString();
    const error = errorMessage(err);
    const baseHealth = evaluateRunHealth({
      claimed: 1,
      processed: 1,
      partial: 0,
      failed: 1,
      breakerOpen: aborted,
      fatalReasons: aborted ? [] : ['reconcile_exception'],
    });
    const adaptiveState = wikidotHttp?.stats().adaptiveEgress?.state ?? null;
    const health = adaptiveState === null
      ? baseHealth
      : applyAdaptiveSelfProtectionToRunHealth(
          baseHealth,
          evaluateAdaptiveSelfProtection(adaptiveState, Date.now()),
        );
    log.error('M10 对账失败', { error, aborted });
    finalReport = {
      ...assembleReport({
        mode: opts.mode,
        observedAt,
        finishedAt,
        lagWindowSeconds,
        http: {
          ...(wikidotHttp ? { wikidot: compactHttp(wikidotHttp) } : {}),
          ...(cromHttp ? { crom: compactHttp(cromHttp) } : {}),
        },
      }),
      status: aborted ? 'aborted' : 'failed',
      alerts: [error],
    };
    const qq = buildQqSummary(finalReport);
    try {
      reportId = await persistReconcileReport(v2Pool, runId, finalReport, qq);
      await finishRun(v2Pool, runId, finalReport, reportId, wikidotHttp, cromHttp, health);
    } catch (persistErr) {
      log.error('失败报告落 meta.reconcile_report/ingest_run 也失败', {
        error: errorMessage(persistErr),
      });
    }
    if (opts.qqSummary) {
      emitSummary(await imSummaryOrFallback(v2Pool, qq, reportId));
    } else {
      emitSummary({
        ok: health.exitCode === 0,
        status: finalReport.status,
        health,
        reportId,
        runId,
        error,
        qqSummary: qq,
      });
    }
    process.exitCode = health.exitCode;
  } finally {
    await wikidotHttp?.close();
    await cromHttp?.close();
    await v1Pool?.end().catch(() => undefined);
    await v2Pool.end().catch(() => undefined);
  }
}

/**
 * 上一轮可比的未解释基线。
 *
 * 只取 status 为 ok/partial/failed 的轮次：inconclusive 表示输入枚举本身不完整
 * （CROM 429 截断、快照过旧），拿它当基线等于用没测到的一轮定义「正常水平」。
 * compared=0 的轮次同样排除。
 */
async function readPreviousUnexplainedBaseline(
  pool: Pool,
): Promise<{ compared: number; unexplained: number } | null> {
  const res = await query<{ compared_count: string; unexplained_count: string }>(
    pool,
    'reconcile:unexplained_baseline',
    `SELECT compared_count, unexplained_count
       FROM meta.reconcile_report
      WHERE status IN ('ok','partial','failed')
        AND compared_count > 0
      ORDER BY id DESC
      LIMIT 1`,
  );
  const row = res.rows[0];
  if (row === undefined) return null;
  return {
    compared: Number(row.compared_count),
    unexplained: Number(row.unexplained_count),
  };
}

async function imSummaryOrFallback(
  pool: Pool,
  fallback: ReturnType<typeof buildQqSummary>,
  reportId: number | null,
): Promise<unknown> {
  try {
    return await collectImReconcileReport(pool);
  } catch (err) {
    // IM 聚合失败不能把已经成功落库的对账 run 反向判失败；保留原有紧凑摘要兜底。
    log.error('IM 健康摘要生成失败，回退到本轮对账摘要', {
      error: errorMessage(err),
    });
    return { ...fallback, reportId };
  }
}

async function finishRun(
  pool: Pool,
  runId: number | null,
  report: FullReconcileReport,
  reportId: number,
  wikidotHttp: HttpClient | null,
  cromHttp: HttpClient | null,
  health?: RunHealthDecision,
): Promise<void> {
  const combined = combinedHttp(wikidotHttp, cromHttp);
  await finishIngestRun(pool, runId, {
    status:
      report.status === 'ok'
        ? 'ok'
        : report.status === 'partial'
          ? 'partial'
          : report.status === 'inconclusive'
            ? 'partial'
          : report.status === 'aborted'
            ? 'aborted'
            : 'failed',
    finishedAt: report.finishedAt,
    pagesEnumerated: report.counts.compared,
    remoteTotal: null,
    remoteTotalSource: null,
    batchesTotal: combined.requests,
    batchesFailed: combined.failedRequests,
    transportFailureRate:
      combined.requests === 0 ? null : combined.transportFailures / combined.requests,
    exitIpStats:
      (wikidotHttp?.exitIpStats() as unknown as Record<string, unknown> | null) ?? {},
    parseFingerprint: {},
    evaluateParseHealth: false,
    stats: {
      mode: `reconcile:${report.mode}`,
      reportId,
      status: report.status,
      counts: report.counts,
      alerts: report.alerts,
      ...(health === undefined ? {} : { health }),
    },
  });
}

function combinedHttp(wikidot: HttpClient | null, crom: HttpClient | null): {
  requests: number;
  attempts: number;
  failedRequests: number;
  transportFailures: number;
} {
  const stats = [wikidot?.healthStats().business, crom?.healthStats().business].filter(
    (value): value is ReturnType<HttpClient['healthStats']>['business'] =>
      value !== undefined,
  );
  return stats.reduce(
    (sum, current) => ({
      requests: sum.requests + current.requests,
      attempts: sum.attempts + current.attempts,
      failedRequests:
        sum.failedRequests +
        Object.entries(current.statusBuckets)
          .filter(([key]) => key === 'transport' || Number(key) >= 400)
          .reduce((n, [, count]) => n + count, 0),
      transportFailures: sum.transportFailures + (current.statusBuckets['transport'] ?? 0),
    }),
    { requests: 0, attempts: 0, failedRequests: 0, transportFailures: 0 },
  );
}

function compactHttp(http: HttpClient): Record<string, unknown> {
  const stats = http.stats();
  return {
    requests: stats.requests,
    attempts: stats.attempts,
    retries: stats.retries,
    wireBytes: stats.wireBytes,
    decodedBytes: stats.decodedBytes,
    statusBuckets: stats.statusBuckets,
    breakerOpen: stats.breakerOpen,
    direct: http.proxyUrl === null,
  };
}

async function assertV2Database(pool: Pool): Promise<void> {
  const res = await query<{ db: string }>(
    pool,
    'reconcile:v2-target',
    `SELECT current_database() AS db`,
  );
  if (res.rows[0]?.db !== 'scpper-v2') {
    throw new Error(`M10 写入目标必须是 scpper-v2，实际为 ${res.rows[0]?.db ?? '(unknown)'}`);
  }
}

async function assertV1ReadOnlyTarget(pool: Pool): Promise<void> {
  const db = await pool.connect();
  try {
    await db.query('BEGIN READ ONLY');
    const res = await db.query<{ name: string; read_only: string }>(
      `SELECT current_database() AS name,
              current_setting('transaction_read_only') AS read_only`,
    );
    await db.query('ROLLBACK');
    const row = res.rows[0];
    if (!row || !['scpper-cn', 'scpper_cn'].includes(row.name) || row.read_only !== 'on') {
      throw new Error(
        `v1 目标/只读闸不成立：db=${row?.name ?? '?'}, transaction_read_only=${row?.read_only ?? '?'}`,
      );
    }
  } finally {
    db.release();
  }
}

function assertDatabaseName(url: string, allowed: readonly string[], label: string): void {
  let name: string;
  try {
    const parsed = new URL(url);
    name = decodeURIComponent(parsed.pathname.replace(/^\/+/, ''));
  } catch {
    throw new Error(`${label} 连接串不是合法 URL`);
  }
  if (!allowed.includes(name)) {
    throw new Error(`${label} 库名必须是 ${allowed.join('|')}，实际 ${name || '(empty)'}`);
  }
}

function parseArgs(): CliOptions {
  const program = new Command();
  program.configureOutput({
    writeOut: (text) => process.stderr.write(text),
    writeErr: (text) => process.stderr.write(text),
  });
  program
    .name('reconcile')
    .description('M10：v1/v2 三轨、CROM 全量五项、站内三角与 QQ 单行 JSON 摘要')
    .option('--mode <mode>', 'all | parity | crom | triangle', 'all')
    .option('--qq-summary', 'stdout 只输出 qqbot 可直接推送的紧凑 JSON', false)
    .option('--skip-tz-check', '跳过 v2 时区回环（仅本地诊断）', false)
    .option('--lag-minutes <n>', '状态对齐滞后窗，规格下限 60 分钟', Number, 60)
    .option('--triangle-pages <n>', '页级三角目标数 1..15；最坏不超过 45 个请求', Number, 10)
    .option(
      '--live-listpages-batches <n>',
      '显式小样本：现场取前 N 批 claims；枚举轨为 inconclusive，不伪装成全量',
      Number,
    )
    .option('--snapshot-max-age-hours <n>', '完整快照最大年龄', Number, 26)
    .option('--crom-batch-size <n>', 'CROM 游标每批页数', Number, 100)
    .option(
      '--crom-request-delay-ms <n>',
      'CROM 批间节流毫秒；默认 1300，避免触发公开 API 速率限制',
      Number,
      1_300,
    )
    .option(
      '--crom-max-pages <n>',
      '显式 CROM 小样本诊断；命中上限时强制 inconclusive，不算全量金丝雀',
      Number,
    )
    .option('--concurrency <n>', 'wikidot 并发 1..4', Number, 2)
    .option('--amc-probe <policy>', 'require | warn | skip（triangle 默认 require）')
    .option('--proxy-check <policy>', 'require | warn | skip（默认 warn）')
    .option('--v1-database-url <url>', 'v1 scpper-cn 连接串；仅 BEGIN READ ONLY SELECT');
  program.parse(process.argv);
  const raw = program.opts<Record<string, unknown>>();
  const mode = raw['mode'];
  if (mode !== 'all' && mode !== 'parity' && mode !== 'crom' && mode !== 'triangle') {
    throw new Error(`--mode 非法：${String(mode)}`);
  }
  const intIn = (key: string, min: number, max: number): number => {
    const value = Number(raw[key]);
    if (!Number.isInteger(value) || value < min || value > max) {
      throw new Error(`--${key.replace(/[A-Z]/g, (v) => `-${v.toLowerCase()}`)} 必须是 ${min}..${max} 的整数`);
    }
    return value;
  };
  const lagMinutes = intIn('lagMinutes', 60, 24 * 60);
  const trianglePages = intIn('trianglePages', 1, 15);
  const concurrency = intIn('concurrency', 1, 4);
  const cromBatchSize = intIn('cromBatchSize', 1, 1_000);
  const cromRequestDelayMs = intIn('cromRequestDelayMs', 0, 60_000);
  const snapshotMaxAgeHours = intIn('snapshotMaxAgeHours', 1, 24 * 14);
  const liveListpagesBatches =
    raw['liveListpagesBatches'] === undefined
      ? undefined
      : intIn('liveListpagesBatches', 1, 2);
  const cromMaxPages =
    raw['cromMaxPages'] === undefined ? undefined : intIn('cromMaxPages', 1, 1_000_000);
  return {
    mode,
    qqSummary: Boolean(raw['qqSummary']),
    skipTzCheck: Boolean(raw['skipTzCheck']),
    lagMinutes,
    trianglePages,
    snapshotMaxAgeHours,
    cromBatchSize,
    cromRequestDelayMs,
    concurrency,
    ...(liveListpagesBatches === undefined ? {} : { liveListpagesBatches }),
    ...(cromMaxPages === undefined ? {} : { cromMaxPages }),
    ...(typeof raw['amcProbe'] === 'string' ? { amcProbe: raw['amcProbe'] } : {}),
    ...(typeof raw['proxyCheck'] === 'string' ? { proxyCheck: raw['proxyCheck'] } : {}),
    ...(typeof raw['v1DatabaseUrl'] === 'string'
      ? { v1DatabaseUrl: raw['v1DatabaseUrl'] }
      : {}),
  };
}

main().catch((err) => {
  log.error('M10 致命错误', { error: errorMessage(err) });
  emitSummary({ ok: false, status: 'failed', error: errorMessage(err) });
  process.exitCode = 1;
});
