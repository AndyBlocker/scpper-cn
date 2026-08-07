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
import {
  createRestrictedStableHttp,
  loadRestrictedWikidotCredentials,
  RESTRICTED_STABLE_PROXY_URL,
  RESTRICTED_TLS_MAX_VERSION,
  RestrictedIdentitySession,
} from '../http/restrictedSession.js';
import { PostgresAdaptiveEgressGate } from '../http/adaptiveEgress.js';
import { assertTimezoneRoundTrip, createPool, query } from '../store/db.js';
import { finishIngestRun, startIngestRun, type ScanTaskKind } from '../store/meta.js';
import {
  ALL_WORK_TASK_KINDS,
  claimIrreconcilableReviews,
  claimWorkTasks,
  ADULT_STABLE_EGRESS_HOLD,
  CONSECUTIVE_PAGE_FAILURE_LIMIT,
  detectKindStarvation,
  reapTasksOnNonLivePages,
  RUN_BUDGET_MS,
  WORK_QUEUE_MIN_REQUEST_INTERVAL_MS,
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
  httpForWorkTask,
  pageScanKindForTask,
  recordUnhandledFailure,
  type WorkHandlerContext,
  type WorkHandlerOutcome,
} from '../work/handlers.js';
import {
  classifyWorkFailure,
  reviewIdentityIfDue,
  workFailureHash,
  type WorkFailurePolicy,
} from '../work/failurePolicy.js';
import {
  reviewFailedTaskIdentity,
  type IdentityReviewResult,
} from '../work/identityCheck.js';
import {
  evaluateWorkQueueHealth,
  WORK_QUEUE_REPEATED_FAILURE_ATTEMPTS,
} from '../work/runHealth.js';

const log = createLogger('work-queue');

/** 任务种类最久等待超过该小时数即判排队饥饿。取 6 小时：远大于正常清空所需（约 11 分钟）。 */
const STARVATION_ALERT_HOURS = 6;

const SOURCE = 'wikidot_tier2';


interface CliOptions {
  limit: number;
  concurrency: number;
  kinds: ScanTaskKind[];
  skipTzCheck: boolean;
  seed: boolean;
  probeOnly: boolean;
  adultOnly: boolean;
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
  const runSource = opts.adultOnly ? 'wikidot_tier2_adult_stable' : SOURCE;
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const workerId = `${os.hostname()}:${process.pid}:work`;
  const http = new HttpClient({
    userAgent: config.userAgent,
    referer: config.referer,
    // 定向 adult 消费连启动探针也固定到 7890；不允许进程先从轮换池露出一次。
    proxyUrl: opts.adultOnly ? RESTRICTED_STABLE_PROXY_URL : config.proxyUrl,
    timeoutMs: config.httpTimeoutMs,
    maxAttempts: Math.max(3, config.httpMaxAttempts),
    breaker503: Math.max(5, config.breaker503),
    breakerReset: Math.max(5, config.breakerReset),
    connections: Math.max(1, opts.concurrency),
    ...(opts.adultOnly ? { tlsMaxVersion: RESTRICTED_TLS_MAX_VERSION } : {}),
    minRequestIntervalMs: WORK_QUEUE_MIN_REQUEST_INTERVAL_MS,
    logger: log.child('http'),
    adaptiveEgress: new PostgresAdaptiveEgressGate(config.databaseUrl, 'work-queue'),
    egress: {
      probeUrl: config.exitIpProbeUrl,
      everyNRequests: config.exitIpProbeEvery,
      maxProbes: config.exitIpProbeMax,
      mihomoApi: config.mihomoApi,
      hostFilter: new URL(config.siteBaseUrl).host,
    },
  });
  http.assertHeaders();
  // adult-only 时复用主客户端：它已经是 7890/TLS1.2，且带完整遥测、出口归因与
  // PostgreSQL 自适应预算。普通混合 worker 才需要单独的受限客户端隔离 7891。
  const restrictedHttp = opts.adultOnly
    ? http
    : createRestrictedStableHttp({
        userAgent: config.userAgent,
        referer: config.referer,
        timeoutMs: config.httpTimeoutMs,
        maxAttempts: Math.max(3, config.httpMaxAttempts),
        breaker503: Math.max(5, config.breaker503),
        breakerReset: Math.max(5, config.breakerReset),
        connections: Math.max(1, opts.concurrency),
        minRequestIntervalMs: WORK_QUEUE_MIN_REQUEST_INTERVAL_MS,
        logger: log.child('restricted-7890'),
        // 混合 worker 的 adult 专用 7890 客户端也必须参加全站共享门禁；固定出口
        // 不是绕过容量预算的理由。
        adaptiveEgress: new PostgresAdaptiveEgressGate(
          config.databaseUrl,
          'work-queue:restricted-7890',
        ),
        egress: {
          probeUrl: config.exitIpProbeUrl,
          everyNRequests: config.exitIpProbeEvery,
          maxProbes: config.exitIpProbeMax,
          mihomoApi: config.mihomoApi,
          hostFilter: new URL(config.siteBaseUrl).host,
        },
      });
  restrictedHttp.assertHeaders();
  const restrictedCredentials = loadRestrictedWikidotCredentials();
  const restrictedSession =
    restrictedCredentials === null
      ? undefined
      : new RestrictedIdentitySession(
          restrictedHttp,
          restrictedCredentials,
          config.siteBaseUrl,
          log.child('restricted-session'),
        );

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
      runId = await startIngestRun(pool, `${runSource}:probe`, startedAt);
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

    runId = await startIngestRun(pool, runSource, startedAt);
    const voteKindsSelected = opts.kinds.some(
      (kind) => kind === 'votes_full' || kind === 'new_page_highfreq',
    );
    const voteSeeded =
      opts.seed && voteKindsSelected
        ? await seedVoteTasks(pool, startedAt)
        : {
            highFrequencyRetired: 0,
            highFrequencyAffected: 0,
            catchupAffected: 0,
            sweepAffected: 0,
            eligiblePages: 0,
            catchupRemaining: 0,
            activeLane: 'sweep' as const,
            hourlyBudget: 0,
            hourlyBudgetUsed: 0,
          };
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
      undefined,
      opts.adultOnly ? 'adult:' : null,
    );
    const regular = await claimWorkTasks(
      pool,
      opts.limit - reviews.length,
      workerId,
      opts.kinds,
      undefined,
      undefined,
      opts.adultOnly ? 'adult:' : null,
      opts.adultOnly ? ADULT_STABLE_EGRESS_HOLD : null,
    );
    claimed = [...reviews, ...regular];
    // Tier2 共用全站出口预算；矛盾隔离复查也必须遵守 0.5 QPS，不能只给 drift 任务限速。
    http.setMinRequestIntervalMs(WORK_QUEUE_MIN_REQUEST_INTERVAL_MS);
    restrictedHttp.setMinRequestIntervalMs(WORK_QUEUE_MIN_REQUEST_INTERVAL_MS);
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
      restrictedHttp,
      restrictedSession,
      baseUrl: config.siteBaseUrl,
      runId,
      workerId,
      concurrency: opts.concurrency,
      cache: new Map(),
    };
    let consecutiveFailures = 0;
    let stoppedByRuntimeBudget = false;

    for (const task of claimed) {
      if (http.breakerOpen || counters.stoppedByFailureLimit) break;
      /*
       * 时间预算优先于条数预算。
       *
       * 时间预算仍要兜住慢响应/重试；即使 0.5 QPS 的纯限速只占约 100 秒，异常轮次
       * 加上请求与解析仍可能逼近 systemd 的 TimeoutStartSec=10min。此前队列几乎只有 new_page_highfreq
       * （新页小、快）才勉强压得进去；work-queue 公平性修好、votes_full 得以进入之后
       * 立刻超时，每轮被 SIGTERM 杀死、只消耗 5 秒 CPU 就退出，任务认领了却没人做完——
       * 表现为「配额生效了但队列反而越积越多」。
       *
       * 被信号杀死时无法优雅收尾：未完成任务只能等锁陈旧回收，本轮进度全部作废。
       * 因此必须在硬超时之前自己停下来，把已完成的部分正常结账。
       */
      if (Date.now() - startedMs >= RUN_BUDGET_MS) {
        stoppedByRuntimeBudget = true;
        log.info('达到单轮时间预算，提前收尾（剩余任务下轮继续）', {
          budgetSec: RUN_BUDGET_MS / 1000,
          processed: counters.processed,
          remaining: claimed.length - counters.processed,
        });
        break;
      }
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
            await releaseWorkTaskLocks(
              pool,
              [task.taskId],
              workerId,
              opts.adultOnly ? ADULT_STABLE_EGRESS_HOLD : null,
            );
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

      let failurePolicy: WorkFailurePolicy | null = null;
      let identityReview: IdentityReviewResult | null = null;
      let terminalFailure = false;
      if (!outcome.finalized && outcome.status === 'failed') {
        const failureError = outcomeFailureError(outcome);
        failurePolicy = classifyWorkFailure(task.kind, failureError);
        if (failurePolicy.action === 'retry') {
          // 瞬时/前置条件失败绝不能借稳定 hash 在第 3 次悄悄变成永久矛盾。
          outcome.resultHash = null;
        } else {
          outcome.resultHash = workFailureHash(failurePolicy);
        }
        terminalFailure = failurePolicy.action === 'irreconcilable';

        try {
          identityReview = await reviewIdentityIfDue(task, failurePolicy, () =>
            reviewFailedTaskIdentity(
              { ...context, http: httpForWorkTask(context, task) },
              task,
            ),
          );
        } catch (err) {
          // 复核自身的瞬时失败不覆盖原始签名；保留原任务，下轮仍会按该签名再次复核。
          identityReview = {
            status: 'failed',
            finalized: false,
            error: `身份复核执行失败：${String(err)}`,
          };
        }

        if (identityReview?.status === 'slug_reused') {
          outcome = {
            status: 'ok',
            resultHash: identityReview.resultHash,
            finalized: true,
            localValue: {
              ...identityReview.lifecycle,
              page_meta: identityReview.apply,
            },
            sample: {
              failurePolicy,
              identityReview: identityReview.status,
              expectedWikidotId: task.wikidotId,
              observedWikidotId: identityReview.observedWikidotId,
              successorPageId: identityReview.successorPageId,
              tasksReassigned: identityReview.tasksReassigned,
              tasksEnqueued: identityReview.tasksEnqueued,
              lineageCandidateInserted: identityReview.lineageCandidateInserted,
            },
          };
        } else if (identityReview?.status === 'deleted') {
          outcome = {
            status: 'ok',
            resultHash: null,
            finalized: true,
            sample: {
              failurePolicy,
              identityReview: identityReview.status,
              deletionEventSeq: identityReview.eventSeq,
              tasksRetired: identityReview.tasksRetired,
            },
          };
        } else if (failurePolicy !== null) {
          outcome.sample = {
            ...outcome.sample,
            failurePolicy,
            identityReview: identityReview?.status ?? null,
            identityReviewError:
              identityReview?.status === 'failed' ? identityReview.error : null,
          };
        }
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
          terminalFailure,
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
      releaseWorkTaskLocks(
        pool,
        unfinished,
        workerId,
        opts.adultOnly ? ADULT_STABLE_EGRESS_HOLD : null,
      ),
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
    // 先清死任务再测饥饿：已删页上的僵尸任务会让「最久等待」永久失真，
    // 那正是这个指标刚上线就会遇到的第一类假阳性。
    const reaped = opts.adultOnly
      ? { total: 0, byKind: {} as Record<string, number> }
      : await reapTasksOnNonLivePages(pool);
    if (reaped.total > 0) {
      log.info('清理已非 live 页面上的待办任务', reaped);
    }
    const starvation = opts.adultOnly
      ? []
      : await detectKindStarvation(pool, STARVATION_ALERT_HOURS);
    if (starvation.length > 0) {
      log.error('存在长期未被认领的任务种类（排队饥饿）', { thresholdHours: STARVATION_ALERT_HOURS, starvation });
    }

    emitSummary({
      ...counters,
      ok: health.exitCode === 0,
      status,
      health,
      starvation,
      reapedNonLiveTasks: reaped,
      stoppedByRuntimeBudget,
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
      releaseWorkTaskLocks(
        pool,
        unfinished,
        workerId,
        opts.adultOnly ? ADULT_STABLE_EGRESS_HOLD : null,
      ),
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
    await restrictedSession?.logout().catch(() => undefined);
    await (restrictedHttp === http
      ? http.close()
      : Promise.all([http.close(), restrictedHttp.close()]).then(() => undefined));
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

function outcomeFailureError(outcome: WorkHandlerOutcome): string {
  const sampleError = outcome.sample?.['error'];
  if (typeof sampleError === 'string' && sampleError.trim() !== '') return sampleError;
  return 'handler 返回 failed 但未提供错误细节';
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
    .option('--no-seed', '本轮不补齐投票追平/稳态 sweep、高频或约定页任务')
    .option('--probe-only', '只跑启动自检，不认领任务', false)
    .option('--adult-only', '只认领 adult: 页面任务，且整个进程（含探针）固定 7890', false)
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
    adultOnly: boolean;
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
    adultOnly: Boolean(raw.adultOnly),
    ...(raw.amcProbe ? { amcProbe: raw.amcProbe } : {}),
    ...(raw.proxyCheck ? { proxyCheck: raw.proxyCheck } : {}),
  };
}

main().catch((err) => {
  log.error('致命错误', { error: String(err) });
  emitSummary({ ok: false, status: 'failed', error: String(err) });
  process.exitCode = 1;
});
