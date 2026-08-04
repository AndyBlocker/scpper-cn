/**
 * 全 kind work-queue 消费入口。
 *
 * 单次短进程、最多 50 条；kind 在认领前过滤，绝不“认领后跳过”。
 * 每条任务都经 handler registry，成功删除、partial/failed 保留退避；
 * 页级失败按比例/跨轮连续性升级；零进展、连续 5 页 failed 或 HTTP 断路器非零退出。
 */

import { redirectConsoleToStderr, createLogger, emitSummary } from '../util/log.js';

redirectConsoleToStderr();

import os from 'node:os';
import { Command } from 'commander';

import { loadConfig } from '../config.js';
import { amcProbePolicyFor, assertEgressContract, parseProbePolicy } from '../http/amc.js';
import { CircuitOpenError, HttpClient } from '../http/client.js';
import { assertTimezoneRoundTrip, createPool, query } from '../store/db.js';
import { finishIngestRun, startIngestRun, type ScanTaskKind } from '../store/meta.js';
import {
  ALL_WORK_TASK_KINDS,
  claimIrreconcilableReviews,
  claimWorkTasks,
  CONSECUTIVE_PAGE_FAILURE_LIMIT,
  detectKindStarvation,
  finishWorkTask,
  releaseIrreconcilableReviewLocks,
  releaseWorkTaskLocks,
  seedConventionTasks,
  seedVoteTasks,
  WORK_QUEUE_LIMIT_MAX,
  type ClaimedWorkTask,
} from '../store/workQueue.js';
import {
  REGISTERED_WORK_KINDS,
  WORK_HANDLER_REGISTRY,
  pageScanKindForTask,
  recordUnhandledFailure,
  type WorkHandlerContext,
  type WorkHandlerOutcome,
} from '../work/handlers.js';
import {
  evaluateWorkQueueHealth,
  WORK_QUEUE_REPEATED_FAILURE_ATTEMPTS,
} from '../work/runHealth.js';

const log = createLogger('work-queue');

/** 任务种类最久等待超过该小时数即判排队饥饿。取 6 小时：远大于正常清空所需（约 11 分钟）。 */
const STARVATION_ALERT_HOURS = 6;
const SOURCE = 'wikidot_tier2';
/** 补账预算 0.10 QPS：所有业务请求（含重试与 revisions 分页）至少间隔 10 秒。 */
export const WORK_QUEUE_MIN_REQUEST_INTERVAL_MS = 10_000;

interface CliOptions {
  limit: number;
  concurrency: number;
  kinds: ScanTaskKind[];
  skipTzCheck: boolean;
  seed: boolean;
  probeOnly: boolean;
  amcProbe?: string;
  proxyCheck?: string;
}

interface Counters {
  claimed: number;
  processed: number;
  ok: number;
  partial: number;
  failed: number;
  repeatedFailures: number;
  writeFreezeSkipped: number;
  irreconcilable: number;
  consecutiveFailuresPeak: number;
  stoppedByFailureLimit: boolean;
  byKind: Record<string, {
    claimed: number;
    ok: number;
    partial: number;
    failed: number;
    irreconcilable: number;
    writeFreezeSkipped: number;
  }>;
}

async function main(): Promise<void> {
  const opts = parseArgs();
  const config = loadConfig();
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const workerId = `${os.hostname()}:${process.pid}:work`;
  const http = new HttpClient({
    userAgent: config.userAgent,
    referer: config.referer,
    proxyUrl: config.proxyUrl,
    timeoutMs: config.httpTimeoutMs,
    maxAttempts: Math.max(3, config.httpMaxAttempts),
    breaker503: Math.max(5, config.breaker503),
    breakerReset: Math.max(5, config.breakerReset),
    connections: Math.max(1, opts.concurrency),
    minRequestIntervalMs: WORK_QUEUE_MIN_REQUEST_INTERVAL_MS,
    logger: log.child('http'),
    egress: {
      probeUrl: config.exitIpProbeUrl,
      everyNRequests: config.exitIpProbeEvery,
      maxProbes: config.exitIpProbeMax,
      mihomoApi: config.mihomoApi,
      hostFilter: new URL(config.siteBaseUrl).host,
    },
  });
  http.assertHeaders();

  const pool = createPool(config.databaseUrl, { max: Math.max(4, opts.concurrency) });
  let runId: number | null = null;
  let claimed: ClaimedWorkTask[] = [];
  const finished = new Set<string>();
  const processed = new Set<string>();
  const samples: Array<Record<string, unknown>> = [];
  const counters: Counters = {
    claimed: 0,
    processed: 0,
    ok: 0,
    partial: 0,
    failed: 0,
    repeatedFailures: 0,
    writeFreezeSkipped: 0,
    irreconcilable: 0,
    consecutiveFailuresPeak: 0,
    stoppedByFailureLimit: false,
    byKind: {},
  };
  let revokePromotion: Record<string, unknown> | null = null;

  try {
    if (opts.skipTzCheck) {
      log.warn('--skip-tz-check：跳过时区回环自检（禁止用于正式调度）');
    } else {
      await assertTimezoneRoundTrip(pool);
    }

    const startupProbe = await assertEgressContract(http, {
      baseUrl: config.siteBaseUrl,
      amcPolicy: parseProbePolicy(
        opts.amcProbe ?? config.amcProbe,
        amcProbePolicyFor(SOURCE),
      ),
      proxyPolicy: parseProbePolicy(opts.proxyCheck ?? config.proxyCheck, 'warn'),
      ipProbeUrl: config.exitIpProbeUrl,
      logger: log.child('probe'),
    });

    if (opts.probeOnly) {
      runId = await startIngestRun(pool, `${SOURCE}:probe`, startedAt);
      await finishIngestRun(pool, runId, {
        status: startupProbe.ok ? 'ok' : 'failed',
        finishedAt: new Date().toISOString(),
        pagesEnumerated: 0,
        remoteTotal: null,
        remoteTotalSource: 'unknown',
        batchesTotal: 0,
        batchesFailed: 0,
        transportFailureRate: transportFailureRate(http),
        exitIpStats: exitIpStats(http),
        parseFingerprint: {
          http_status_dist: http.healthStats().business.statusBuckets,
          transport_failure_rate: transportFailureRate(http),
        },
        stats: {
          mode: 'tier2',
          domain: 'work_queue',
          registeredKinds: REGISTERED_WORK_KINDS,
          selectedKinds: opts.kinds,
          probeOnly: true,
          startupProbe,
          http: http.stats(),
          httpHealth: http.healthStats(),
        },
      });
      emitSummary({
        ok: startupProbe.ok,
        status: startupProbe.ok ? 'ok' : 'failed',
        probeOnly: true,
        runId,
        registeredKinds: REGISTERED_WORK_KINDS,
        startupProbe,
        http: http.stats(),
        httpHealth: http.healthStats(),
      });
      process.exitCode = startupProbe.ok ? 0 : 1;
      return;
    }

    runId = await startIngestRun(pool, SOURCE, startedAt);
    const voteKindsSelected = opts.kinds.some(
      (kind) => kind === 'votes_full' || kind === 'new_page_highfreq',
    );
    const voteSeeded =
      opts.seed && voteKindsSelected
        ? await seedVoteTasks(pool, startedAt)
        : { highFrequencyRetired: 0, highFrequencyAffected: 0, sweepAffected: 0 };
    const conventionSeeded =
      opts.seed && opts.kinds.includes('attributions')
        ? await seedConventionTasks(pool, startedAt)
        : { conventionAffected: 0 };
    const seeded = { ...voteSeeded, ...conventionSeeded };

    const reviews = await claimIrreconcilableReviews(
      pool,
      opts.limit,
      workerId,
      opts.kinds,
    );
    const regular = await claimWorkTasks(
      pool,
      opts.limit - reviews.length,
      workerId,
      opts.kinds,
    );
    claimed = [...reviews, ...regular];
    // Tier2 共用全站日预算；矛盾隔离复查也必须遵守 0.10 QPS，不能只给 drift 任务限速。
    http.setMinRequestIntervalMs(WORK_QUEUE_MIN_REQUEST_INTERVAL_MS);
    counters.claimed = claimed.length;
    for (const task of claimed) {
      const byKind = ensureKindCounters(counters, task.kind);
      byKind.claimed++;
    }
    log.info('任务已认领', {
      claimed: claimed.length,
      limit: opts.limit,
      kinds: opts.kinds,
      claimedByKind: Object.fromEntries(
        Object.entries(counters.byKind).map(([kind, value]) => [kind, value.claimed]),
      ),
      seeded,
      weeklyReviewsClaimed: reviews.length,
      minRequestIntervalMs: WORK_QUEUE_MIN_REQUEST_INTERVAL_MS,
    });

    const context: WorkHandlerContext = {
      pool,
      http,
      baseUrl: config.siteBaseUrl,
      runId,
      workerId,
      concurrency: opts.concurrency,
      cache: new Map(),
    };
    let consecutiveFailures = 0;

    for (const task of claimed) {
      if (http.breakerOpen || counters.stoppedByFailureLimit) break;
      let outcome: WorkHandlerOutcome;
      try {
        outcome = await WORK_HANDLER_REGISTRY[task.kind](task, context);
      } catch (err) {
        const error = String(err);
        if (pgCode(err) === 'PGF01') {
          await noteFreezeSkip(context, task, error);
          if (task.queueSource === 'irreconcilable') {
            await releaseIrreconcilableReviewLocks(pool, [task], workerId);
          } else {
            await releaseWorkTaskLocks(pool, [task.taskId], workerId);
          }
          finished.add(taskKey(task));
          counters.writeFreezeSkipped++;
          ensureKindCounters(counters, task.kind).writeFreezeSkipped++;
          if (samples.length < 30) {
            samples.push({
              taskId: task.taskId,
              pageId: task.pageId,
              taskKind: task.kind,
              status: 'skipped_write_freeze',
              error,
              code: 'PGF01',
            });
          }
          // PGF01 不算失败、不进 processed，也不推进连续失败熔断或任务退避。
          continue;
        }
        await recordUnhandledFailure(context, task, error).catch((scanErr) =>
          log.error('补写 failed page_scan 失败', {
            taskId: task.taskId,
            kind: task.kind,
            error: String(scanErr),
          }),
        );
        outcome = {
          status: 'failed',
          resultHash: null,
          sample: { error, code: pgCode(err) },
        };
      }

      let action = outcome.finalized ? 'handler_finalized' : 'unknown';
      if (!outcome.finalized) {
        const finish = await finishWorkTask(pool, task, {
          workerId,
          status: outcome.status,
          resultHash: outcome.resultHash,
          localValue: outcome.localValue,
          remoteValue: outcome.remoteValue,
          settledPartial: outcome.settledPartial,
          now: new Date().toISOString(),
        });
        action = finish.action;
      }
      finished.add(taskKey(task));
      processed.add(taskKey(task));
      counters.processed++;
      const terminal = action === 'irreconcilable';
      if (terminal) {
        counters.irreconcilable++;
        ensureKindCounters(counters, task.kind).irreconcilable++;
      } else {
        counters[outcome.status]++;
        ensureKindCounters(counters, task.kind)[outcome.status]++;
      }

      if (samples.length < 30) {
        samples.push({
          taskId: task.taskId,
          pageId: task.pageId,
          wikidotId: task.wikidotId,
          slug: task.slug,
          taskKind: task.kind,
          status: outcome.status,
          action,
          ...outcome.sample,
        });
      }

      if (outcome.status === 'failed') {
        if (task.attempts >= WORK_QUEUE_REPEATED_FAILURE_ATTEMPTS) {
          counters.repeatedFailures++;
        }
        if (!terminal) consecutiveFailures++;
        else consecutiveFailures = 0;
      } else {
        consecutiveFailures = 0;
      }
      counters.consecutiveFailuresPeak = Math.max(
        counters.consecutiveFailuresPeak,
        consecutiveFailures,
      );
      if (
        http.breakerOpen ||
        consecutiveFailures >= CONSECUTIVE_PAGE_FAILURE_LIMIT
      ) {
        counters.stoppedByFailureLimit =
          consecutiveFailures >= CONSECUTIVE_PAGE_FAILURE_LIMIT;
        break;
      }
    }

    const stopped = http.breakerOpen || counters.stoppedByFailureLimit;
    const voteTasksProcessed = claimed.some(
      (task) =>
        processed.has(taskKey(task)) &&
        (task.kind === 'votes_full' || task.kind === 'new_page_highfreq'),
    );
    if (!stopped && voteTasksProcessed) {
      const promoted = await query<{ result: Record<string, unknown> }>(
        pool,
        'ingest.promote_revoke_candidates:work_queue',
        `SELECT ingest.promote_revoke_candidates(
           $1, $2, $3::interval, $4, $5, $6
         ) AS result`,
        [2, 500, '30 days', 0.2, runId, 'wikidot_absence'],
      );
      revokePromotion = promoted.rows[0]?.result ?? null;
    }

    const unfinishedTasks = claimed.filter((task) => !finished.has(taskKey(task)));
    const unfinished = unfinishedTasks
      .filter((task) => task.queueSource !== 'irreconcilable')
      .map((task) => task.taskId);
    await Promise.all([
      releaseWorkTaskLocks(pool, unfinished, workerId),
      releaseIrreconcilableReviewLocks(pool, unfinishedTasks, workerId),
    ]);
    const health = evaluateWorkQueueHealth({
      claimed: counters.claimed,
      processed: counters.processed,
      partial: counters.partial,
      failed: counters.failed,
      writeFreezeSkipped: counters.writeFreezeSkipped,
      repeatedFailures: counters.repeatedFailures,
      breakerOpen: http.breakerOpen,
      stoppedByFailureLimit: counters.stoppedByFailureLimit,
    });
    const status = health.status;
    const durationMs = Date.now() - startedMs;
    await finishIngestRun(pool, runId, {
      status,
      finishedAt: new Date().toISOString(),
      pagesEnumerated: counters.processed,
      remoteTotal: null,
      remoteTotalSource: 'unknown',
      batchesTotal: counters.processed,
      batchesFailed: counters.failed,
      transportFailureRate: transportFailureRate(http),
      exitIpStats: exitIpStats(http),
      parseFingerprint: {
        avg_votes_per_page: averageSampleNumber(samples, 'parsedEntries'),
        avg_source_len: averageSampleNumber(samples, 'sourceChars'),
        avg_body_len: averageSampleNumber(samples, 'textChars'),
        http_status_dist: http.healthStats().business.statusBuckets,
        transport_failure_rate: transportFailureRate(http),
      },
      healthDecisionSkipReason:
        counters.processed === 0 && counters.writeFreezeSkipped > 0
          ? 'write_freeze_only'
          : null,
      stats: {
        mode: 'tier2',
        domain: 'work_queue',
        durationMs,
        registeredKinds: REGISTERED_WORK_KINDS,
        selectedKinds: opts.kinds,
        seeded,
        ...counters,
        health,
        healthExclusions: {
          write_freeze: counters.writeFreezeSkipped,
        },
        unprocessedReleased: unfinishedTasks.length,
        http: http.stats(),
        startupProbe,
        samples,
        revokePromotion,
        httpHealth: http.healthStats(),
      },
    });

    /*
     * 饥饿检测独立于 health：health 衡量「本轮做得怎么样」，饥饿问的是「谁一直没被做」。
     * 上一次 votes_full 被饿了 6.8 天，而每轮 50 个配额打满、全部成功、失败率为 0——
     * 常规指标全绿。只报警不改退出码：饥饿是排队公平性问题，本轮执行本身并没有失败。
     */
    const starvation = await detectKindStarvation(pool, STARVATION_ALERT_HOURS);
    if (starvation.length > 0) {
      log.error('存在长期未被认领的任务种类（排队饥饿）', { thresholdHours: STARVATION_ALERT_HOURS, starvation });
    }

    emitSummary({
      ...counters,
      ok: health.exitCode === 0,
      status,
      health,
      starvation,
      runId,
      durationMs,
      registeredKinds: REGISTERED_WORK_KINDS,
      selectedKinds: opts.kinds,
      seeded,
      unprocessedReleased: unfinishedTasks.length,
      http: http.stats(),
      httpHealth: http.healthStats(),
      samples,
      revokePromotion,
    });
    process.exitCode = health.exitCode;
  } catch (err) {
    const breaker = err instanceof CircuitOpenError || http.breakerOpen;
    const unfinishedTasks = claimed.filter((task) => !finished.has(taskKey(task)));
    const unfinished = unfinishedTasks
      .filter((task) => task.queueSource !== 'irreconcilable')
      .map((task) => task.taskId);
    await Promise.all([
      releaseWorkTaskLocks(pool, unfinished, workerId),
      releaseIrreconcilableReviewLocks(pool, unfinishedTasks, workerId),
    ]).catch(() => undefined);
    await finishIngestRun(pool, runId, {
      status: breaker ? 'aborted' : 'failed',
      finishedAt: new Date().toISOString(),
      pagesEnumerated: counters.processed,
      remoteTotal: null,
      remoteTotalSource: 'unknown',
      batchesTotal: counters.claimed,
      batchesFailed: Math.max(1, counters.failed),
      transportFailureRate: transportFailureRate(http),
      exitIpStats: exitIpStats(http),
      stats: {
        mode: 'tier2',
        domain: 'work_queue',
        error: String(err),
        breaker,
        selectedKinds: opts.kinds,
        ...counters,
        unfinishedReleased: unfinishedTasks.length,
        http: http.stats(),
        httpHealth: http.healthStats(),
      },
    }).catch(() => undefined);
    emitSummary({
      ...counters,
      ok: false,
      status: breaker ? 'aborted' : 'failed',
      runId,
      error: String(err),
      breaker,
      unfinishedReleased: unfinishedTasks.length,
    });
    process.exitCode = 1;
  } finally {
    await http.close();
    await pool.end().catch(() => undefined);
  }
}

function ensureKindCounters(
  counters: Counters,
  kind: ScanTaskKind,
): Counters['byKind'][string] {
  return counters.byKind[kind] ??= {
    claimed: 0,
    ok: 0,
    partial: 0,
    failed: 0,
    irreconcilable: 0,
    writeFreezeSkipped: 0,
  };
}

function taskKey(task: ClaimedWorkTask): string {
  return `${task.queueSource ?? 'scan_task'}:${task.taskId}:${task.pageId}:${task.kind}`;
}

async function noteFreezeSkip(
  context: WorkHandlerContext,
  task: ClaimedWorkTask,
  error: string,
): Promise<void> {
  const kind = pageScanKindForTask(task.kind);
  const domain =
    kind === 'votes'
      ? 'vote'
      : kind === 'revisions'
        ? 'revision'
        : kind === 'attributions'
          ? 'attribution'
          : kind === 'forum' || kind === 'discussion'
            ? 'forum'
            : kind === 'content'
              ? 'content'
              : 'page';
  await query(
    context.pool,
    'meta.note_freeze_skip:work_queue',
    `SELECT meta.note_freeze_skip($1, $2, $3, $4, $5)`,
    [context.runId, task.pageId, kind, domain, error],
  ).catch((noteErr) =>
    log.error('冻结期 note_freeze_skip 失败', { error: String(noteErr) }),
  );
}

function averageSampleNumber(
  samples: readonly Record<string, unknown>[],
  key: string,
): number | null {
  const values = samples
    .map((sample) => Number(sample[key]))
    .filter((value) => Number.isFinite(value));
  return values.length === 0
    ? null
    : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function transportFailureRate(http: HttpClient): number | null {
  const stats = http.healthStats().business;
  return stats.requests === 0
    ? null
    : stats.transportFailures / stats.requests;
}

function exitIpStats(http: HttpClient): Record<string, unknown> {
  return http.exitIpStats() as unknown as Record<string, unknown>;
}

function pgCode(err: unknown): string | null {
  return typeof err === 'object' &&
    err !== null &&
    typeof (err as { code?: unknown }).code === 'string'
    ? String((err as { code: string }).code)
    : null;
}

function parseArgs(): CliOptions {
  const program = new Command();
  program.configureOutput({
    writeOut: (text) => process.stderr.write(text),
    writeErr: (text) => process.stderr.write(text),
  });
  program
    .name('work-queue')
    .description('单次消费全部 meta.scan_task kind（合计最多 50 条）')
    .option('--limit <n>', '本轮最多消费多少任务（硬上限 50）', Number, 50)
    .option('--concurrency <n>', 'HTTP 并发上限（1..5）', Number, 4)
    .option(
      '--kinds <csv>',
      `只消费指定 kind，逗号分隔；默认全部：${ALL_WORK_TASK_KINDS.join(',')}`,
    )
    .option('--skip-tz-check', '跳过时区回环自检（仅本地调试）', false)
    .option('--no-seed', '本轮不补齐 90d sweep / 7d 高频 / 24h 约定页任务')
    .option('--probe-only', '只跑启动自检，不认领任务', false)
    .option('--amc-probe <policy>', 'AMC 探针 require | warn | skip（默认 require）')
    .option('--proxy-check <policy>', '代理健康 require | warn | skip（默认 warn）');
  program.parse(process.argv);

  const raw = program.opts<{
    limit: number;
    concurrency: number;
    kinds?: string;
    skipTzCheck: boolean;
    seed: boolean;
    probeOnly: boolean;
    amcProbe?: string;
    proxyCheck?: string;
  }>();
  const selected = raw.kinds === undefined
    ? [...ALL_WORK_TASK_KINDS]
    : [...new Set(
        raw.kinds
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean),
      )];
  const invalid = selected.filter(
    (kind) => !REGISTERED_WORK_KINDS.includes(kind as ScanTaskKind),
  );
  if (selected.length === 0 || invalid.length > 0) {
    throw new Error(
      `--kinds 含未知/空 kind：${invalid.join(',') || '(empty)'}；` +
        `可选 ${REGISTERED_WORK_KINDS.join(',')}`,
    );
  }
  const limit = Math.min(
    WORK_QUEUE_LIMIT_MAX,
    Number.isFinite(raw.limit) && raw.limit > 0 ? Math.floor(raw.limit) : 50,
  );
  const concurrency =
    Number.isFinite(raw.concurrency) && raw.concurrency > 0
      ? Math.min(5, Math.floor(raw.concurrency))
      : 4;
  return {
    limit,
    concurrency,
    kinds: selected as ScanTaskKind[],
    skipTzCheck: Boolean(raw.skipTzCheck),
    seed: raw.seed !== false,
    probeOnly: Boolean(raw.probeOnly),
    ...(raw.amcProbe ? { amcProbe: raw.amcProbe } : {}),
    ...(raw.proxyCheck ? { proxyCheck: raw.proxyCheck } : {}),
  };
}

main().catch((err) => {
  log.error('致命错误', { error: String(err) });
  emitSummary({ ok: false, status: 'failed', error: String(err) });
  process.exitCode = 1;
});
