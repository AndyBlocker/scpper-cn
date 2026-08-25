/**
 * M5 论坛差集消费入口。
 *
 * 单次短进程，以公平微批同时消费页级 forum/discussion 与 thread/category sitemap 差集；
 * 最多完成 50 个目标、在途最多 4 个。所有远端读取都走匿名 AMC，绝不创建登录 session。
 */

import { redirectConsoleToStderr, createLogger, emitSummary } from '../util/log.js';

redirectConsoleToStderr();

import os from 'node:os';
import { Command } from 'commander';

import { loadConfig } from '../config.js';
import {
  applyForumBatch,
  applyForumCategorySnapshot,
  applyForumDiscussion,
  applyForumDiscussionLink,
  forumBatchResultHash,
  isDiscussionCountInconsistent,
  scanForumCategories,
  scanForumStart,
  scanForumThreads,
  scanPageDiscussionLinks,
  scanPageDiscussions,
  type ForumBatch,
  type ForumCategorySnapshot,
  type ForumCommentsPage,
  type ForumDiscussionSnapshot,
  type ForumDiscussionTarget,
  type ForumStartSnapshot,
  type ForumThreadSnapshot,
} from '../collect/forum.js';
import { failed, ok, type CollectResult } from '../collect/result.js';
import {
  amcProbePolicyFor,
  assertEgressContract,
  parseProbePolicy,
  type EgressGateReport,
} from '../http/amc.js';
import { CircuitOpenError, HttpClient } from '../http/client.js';
import { PostgresAdaptiveEgressGate } from '../http/adaptiveEgress.js';
import { evaluateParseHealth } from '../health/parseHealth.js';
import { fetchCategorySitemap } from '../sitemap/fetch.js';
import { normalizeSitemapEntries } from '../sitemap/normalize.js';
import { assertTimezoneRoundTrip, createPool, query } from '../store/db.js';
import { finishIngestRun, startIngestRun, type ScanTaskKind } from '../store/meta.js';
import {
  claimDiscussionTasks,
  claimForumTargets,
  enqueueForumTargets,
  finishDiscussionTask,
  finishForumTarget,
  releaseDiscussionTaskLocks,
  releaseForumTargetLocks,
  type ClaimedDiscussionTask,
  type ClaimedForumTarget,
} from '../store/queues.js';
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
  evaluateRunHealth,
  RUN_REPEATED_FAILURE_ATTEMPTS,
} from '../work/runHealth.js';
import {
  FORUM_CONSUME_MAX_IN_FLIGHT,
  assertForumConsumeFairLimit,
  forumConsumeWaveQuotas,
  runForumFairWave,
} from '../work/forumOrder.js';
import {
  addRuntimeBudgetOption,
  isRuntimeBudgetExceededError,
  parseRuntimeBudgetSec,
  RuntimeBudget,
} from '../util/runtimeBudget.js';

const log = createLogger('forum-scan');
const SOURCE = 'wikidot_forum';
const FAILURE_LIMIT = 5;
const TARGET_LIMIT_MAX = 50;

interface CliOptions {
  limit: number;
  concurrency: number;
  maxRuntimeSec: number;
  skipTzCheck: boolean;
  probeOnly: boolean;
  pageId: number | null;
  threadId: number | null;
  categoryId: number | null;
  amcProbe?: string;
  proxyCheck?: string;
}

interface Counters {
  claimed: number;
  discussionClaimed: number;
  forumClaimed: number;
  claimWaves: number;
  processed: number;
  discussionProcessed: number;
  forumProcessed: number;
  forumThreadProcessed: number;
  forumCatchupProcessed: number;
  forumSteadyProcessed: number;
  succeeded: number;
  partial: number;
  failed: number;
  categoriesApplied: number;
  threadsApplied: number;
  postsApplied: number;
  irreconcilable: number;
  repeatedFailures: number;
  consecutiveFailuresPeak: number;
  stoppedByFailureLimit: boolean;
  stoppedByRuntimeBudget: boolean;
}

async function main(): Promise<void> {
  const opts = parseArgs();
  const config = loadConfig();
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const budget = new RuntimeBudget(opts.maxRuntimeSec);
  const workerId = `${os.hostname()}:${process.pid}:forum`;
  const http = new HttpClient({
    userAgent: config.userAgent,
    referer: config.referer,
    proxyUrl: config.proxyUrl,
    timeoutMs: config.httpTimeoutMs,
    maxAttempts: Math.max(3, config.httpMaxAttempts),
    breaker503: Math.max(5, config.breaker503),
    breakerReset: Math.max(5, config.breakerReset),
    connections: Math.max(1, opts.concurrency),
    signal: budget.signal,
    logger: log.child('http'),
    adaptiveEgress: new PostgresAdaptiveEgressGate(config.databaseUrl, 'forum'),
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
  let forumTasks: ClaimedForumTarget[] = [];
  let discussionTasks: ClaimedDiscussionTask[] = [];
  const finishedForum = new Set<number>();
  const finishedDiscussion = new Set<number>();
  const counters: Counters = {
    claimed: 0,
    discussionClaimed: 0,
    forumClaimed: 0,
    claimWaves: 0,
    processed: 0,
    discussionProcessed: 0,
    forumProcessed: 0,
    forumThreadProcessed: 0,
    forumCatchupProcessed: 0,
    forumSteadyProcessed: 0,
    succeeded: 0,
    partial: 0,
    failed: 0,
    categoriesApplied: 0,
    threadsApplied: 0,
    postsApplied: 0,
    irreconcilable: 0,
    repeatedFailures: 0,
    consecutiveFailuresPeak: 0,
    stoppedByFailureLimit: false,
    stoppedByRuntimeBudget: false,
  };
  const samples: Array<Record<string, unknown>> = [];
  let startupProbe: EgressGateReport | null = null;

  try {
    if (opts.skipTzCheck) {
      log.warn('--skip-tz-check：仅限本地调试，正式调度禁止使用');
    } else {
      await assertTimezoneRoundTrip(pool);
    }
    runId = await startIngestRun(pool, opts.probeOnly ? `${SOURCE}:probe` : SOURCE, startedAt);
    startupProbe = await assertEgressContract(http, {
      baseUrl: config.siteBaseUrl,
      amcPolicy: parseProbePolicy(opts.amcProbe ?? config.amcProbe, amcProbePolicyFor(SOURCE)),
      proxyPolicy: parseProbePolicy(opts.proxyCheck ?? config.proxyCheck, 'warn'),
      ipProbeUrl: config.exitIpProbeUrl,
      logger: log.child('probe'),
    });

    if (opts.probeOnly) {
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
        parseFingerprint: fingerprint(http, null, [], [], 0),
        stats: {
          mode: 'forum',
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
        startupProbe,
        http: http.stats(),
        httpHealth: http.healthStats(),
      });
      process.exitCode = startupProbe.ok ? 0 : 1;
      return;
    }

    /*
     * 认领与执行必须是同一个微批循环：上一版虽然先认领 30/20，却把 30 个
     * discussion 全部跑完才碰 forum，导致 20 个 forum 每轮必然释放。
     *
     * 标准轮每波只认领 discussion=2 + forum=2，随后两类同时启动；上一波落到
     * staged Map 后才认领下一波。预算无论在哪一侧命中，在途上限恒为 4，另一侧
     * 已完成的结果仍由 allSettled 保留并在下面结账。
     */
    const standardClaim = opts.pageId === null && opts.threadId === null && opts.categoryId === null;
    let start: CollectResult<ForumStartSnapshot> = ok({ categories: [] });
    let startFetched = false;
    const stagedCategories = new Map<number, CollectResult<ForumCategorySnapshot>>();
    const stagedThreads = new Map<number, CollectResult<ForumThreadSnapshot>>();
    const stagedDiscussions = new Map<number, CollectResult<ForumDiscussionSnapshot>>();
    const stagedLinks = new Map<number, CollectResult<ForumCommentsPage>>();
    let sitemapCategoryIds: Set<number> | null = null;
    let categoryCoverageError: string | null = null;
    let categoryCoveragePromise: Promise<void> | null = null;
    let consecutiveFailures = 0;

    const ensureCategoryCoverage = (): Promise<void> => {
      categoryCoveragePromise ??= (async () => {
        try {
          const categorySitemap = await fetchCategorySitemap(
            http,
            config.siteBaseUrl,
            log.child('category-sitemap'),
          );
          const normalized = normalizeSitemapEntries(categorySitemap.entries);
          sitemapCategoryIds = new Set(
            [...normalized.observed.keys()]
              .map((slug) => /(?:^|\/)forum\/c-(\d+)/.exec(slug)?.[1])
              .filter((id): id is string => id !== undefined)
              .map(Number),
          );
          const missingCategories = start.status === 'failed'
            ? []
            : start.data.categories
                .map((category) => category.id)
                .filter((id) => !sitemapCategoryIds!.has(id));
          if (missingCategories.length > 0) {
            log.warn('category sitemap 覆盖不完整：缺席分类只记 partial，禁止判 thread 删除', {
              missingCategories,
              count: missingCategories.length,
            });
          }
        } catch (err) {
          if (isRuntimeBudgetExceededError(err)) throw err;
          categoryCoverageError = `category sitemap 抓取失败：${String(err)}`;
          log.warn('无法证明分类在 sitemap 中；本轮所有分类只保存正面观测，不判删除', {
            error: categoryCoverageError,
          });
        }
      })();
      return categoryCoveragePromise;
    };

    type DiscussionWaveResult =
      | { mode: 'link'; task: ClaimedDiscussionTask; result: CollectResult<ForumCommentsPage> }
      | {
          mode: 'deep';
          task: ClaimedDiscussionTask;
          result: CollectResult<ForumDiscussionSnapshot>;
        };
    type ForumWaveResult =
      | {
          mode: 'category';
          task: ClaimedForumTarget;
          result: CollectResult<ForumCategorySnapshot>;
        }
      | {
          mode: 'thread';
          task: ClaimedForumTarget;
          result: CollectResult<ForumThreadSnapshot>;
        };

    let discussionQueueAvailable = true;
    let forumQueueAvailable = true;

    const scanDiscussionTask = async (
      task: ClaimedDiscussionTask,
    ): Promise<DiscussionWaveResult> => {
      if (task.expectedThreadId === null) {
        const results = await scanPageDiscussionLinks(
          http,
          config.siteBaseUrl,
          [toDiscussionTarget(task)],
          1,
        );
        return {
          mode: 'link',
          task,
          result: results.get(task.pageId) ??
            failed<ForumCommentsPage>('内部错误：页面讨论串关联结果 Map 缺项'),
        };
      }
      if (start.status === 'failed') {
        return {
          mode: 'deep',
          task,
          result: failed(`ForumStartModule 前置抓取失败：${start.error}`),
        };
      }
      const results = await scanPageDiscussions(
        http,
        config.siteBaseUrl,
        [toDiscussionTarget(task)],
        opts.concurrency,
      );
      return {
        mode: 'deep',
        task,
        result: results.get(task.pageId) ??
          failed<ForumDiscussionSnapshot>('内部错误：页面讨论结果 Map 缺项'),
      };
    };

    const scanForumTask = async (task: ClaimedForumTarget): Promise<ForumWaveResult> => {
      if (start.status === 'failed') {
        return task.kind === 'category'
          ? {
              mode: 'category',
              task,
              result: failed<ForumCategorySnapshot>(
                `ForumStartModule 前置抓取失败：${start.error}`,
              ),
            }
          : {
              mode: 'thread',
              task,
              result: failed<ForumThreadSnapshot>(
                `ForumStartModule 前置抓取失败：${start.error}`,
              ),
            };
      }
      if (task.kind === 'category') {
        await ensureCategoryCoverage();
        const results = await scanForumCategories(
          http,
          config.siteBaseUrl,
          [task.targetId],
          opts.concurrency,
        );
        return {
          mode: 'category',
          task,
          result: results.get(task.targetId) ??
            failed<ForumCategorySnapshot>('内部错误：分类枚举结果 Map 缺项'),
        };
      }
      const results = await scanForumThreads(
        http,
        config.siteBaseUrl,
        [task.targetId],
        opts.concurrency,
      );
      return {
        mode: 'thread',
        task,
        result: results.get(task.targetId) ??
          failed<ForumThreadSnapshot>('内部错误：主题结果 Map 缺项'),
      };
    };

    claimWaves: while (counters.claimed < opts.limit) {
      if (budget.checkpoint()) {
        counters.stoppedByRuntimeBudget = true;
        break;
      }
      const remaining = opts.limit - counters.claimed;
      const quotas = standardClaim
        ? forumConsumeWaveQuotas(remaining, {
            discussion: discussionQueueAvailable,
            forum: forumQueueAvailable,
          })
        : {
            discussion: opts.pageId === null ? 0 : remaining,
            forum: opts.pageId === null ? remaining : 0,
          };
      const claimResults = await Promise.allSettled([
        opts.threadId === null && opts.categoryId === null
          ? claimDiscussionTasks(pool, quotas.discussion, workerId, opts.pageId)
          : Promise.resolve([]),
        opts.pageId === null
          ? claimForumTargets(
              pool,
              quotas.forum,
              workerId,
              { threadId: opts.threadId, categoryId: opts.categoryId },
            )
          : Promise.resolve([]),
      ]);
      const discussionWave = claimResults[0].status === 'fulfilled'
        ? claimResults[0].value
        : [];
      const forumWave = claimResults[1].status === 'fulfilled'
        ? claimResults[1].value
        : [];
      const claimError = claimResults.find(
        (result): result is PromiseRejectedResult => result.status === 'rejected',
      );
      if (claimError !== undefined) {
        // 两张表并行认领时，一侧 SQL 失败不代表另一侧没成功。先精确归还已成功
        // 的 claim，再抛原错误；否则局部赋值尚未发生，外层 catch 看不到这些锁。
        await Promise.all([
          releaseDiscussionTaskLocks(
            pool,
            discussionWave.map((task) => task.taskId),
            workerId,
          ),
          releaseForumTargetLocks(
            pool,
            forumWave.map((task) => task.taskId),
            workerId,
          ),
        ]);
        throw claimError.reason;
      }
      if (standardClaim) {
        if (discussionWave.length < quotas.discussion) discussionQueueAvailable = false;
        if (forumWave.length < quotas.forum) forumQueueAvailable = false;
      }
      if (discussionWave.length === 0 && forumWave.length === 0) break;

      discussionTasks.push(...discussionWave);
      forumTasks.push(...forumWave);
      counters.claimWaves++;
      counters.discussionClaimed += discussionWave.length;
      counters.forumClaimed += forumWave.length;
      counters.claimed += discussionWave.length + forumWave.length;

      const needsForumStart = forumWave.length > 0 ||
        discussionWave.some((task) => task.expectedThreadId !== null);
      if (needsForumStart && !startFetched) {
        startFetched = true;
        try {
          start = await scanForumStart(http, config.siteBaseUrl);
          if (start.status === 'failed') {
            consecutiveFailures = 1;
            counters.consecutiveFailuresPeak = 1;
          }
        } catch (err) {
          if (!isRuntimeBudgetExceededError(err)) throw err;
          counters.stoppedByRuntimeBudget = true;
          start = failed('ForumStartModule 被单轮时间预算中断');
        }
      }

      if (counters.stoppedByRuntimeBudget) break;
      const settled = await runForumFairWave(
        discussionWave,
        forumWave,
        scanDiscussionTask,
        scanForumTask,
      );
      for (const item of [...settled.discussion, ...settled.forum]) {
        if (item.status === 'rejected') {
          if (isRuntimeBudgetExceededError(item.reason)) {
            counters.stoppedByRuntimeBudget = true;
            continue;
          }
          throw item.reason;
        }
        const outcome = item.value;
        if (outcome.mode === 'link') {
          stagedLinks.set(outcome.task.taskId, outcome.result);
          consecutiveFailures = updateFailureStreak(
            outcome.result,
            outcome.task.kind,
            consecutiveFailures,
            counters,
          );
        } else if (outcome.mode === 'deep') {
          stagedDiscussions.set(outcome.task.taskId, outcome.result);
          consecutiveFailures = updateFailureStreak(
            outcome.result,
            outcome.task.kind,
            consecutiveFailures,
            counters,
          );
        } else if (outcome.mode === 'category') {
          stagedCategories.set(outcome.task.taskId, outcome.result);
        } else {
          stagedThreads.set(outcome.task.taskId, outcome.result);
          consecutiveFailures = updateFailureStreak(
            outcome.result,
            'forum',
            consecutiveFailures,
            counters,
          );
        }
      }
      if (budget.checkpoint()) counters.stoppedByRuntimeBudget = true;
      if (
        http.breakerOpen ||
        consecutiveFailures >= FAILURE_LIMIT ||
        counters.stoppedByRuntimeBudget ||
        start.status === 'failed' ||
        !standardClaim
      ) {
        counters.stoppedByFailureLimit = consecutiveFailures >= FAILURE_LIMIT;
        break claimWaves;
      }
    }

    log.info('论坛公平微批认领结束', {
      discussion: counters.discussionClaimed,
      forum: counters.forumClaimed,
      waves: counters.claimWaves,
      limit: opts.limit,
      maxInFlight: FORUM_CONSUME_MAX_IN_FLIGHT,
    });

    if (counters.claimed === 0) {
      const durationMs = Date.now() - startedMs;
      await finishIngestRun(pool, runId, {
        status: 'ok',
        finishedAt: new Date().toISOString(),
        pagesEnumerated: 0,
        remoteTotal: null,
        remoteTotalSource: 'unknown',
        batchesTotal: 0,
        batchesFailed: 0,
        transportFailureRate: transportFailureRate(http),
        exitIpStats: exitIpStats(http),
        parseFingerprint: fingerprint(http, null, [], [], 0),
        stats: {
          mode: 'forum',
          durationMs,
          ...counters,
          maxInFlight: FORUM_CONSUME_MAX_IN_FLIGHT,
          startupProbe,
          http: http.stats(),
          httpHealth: http.healthStats(),
        },
      });
      emitSummary({ ok: true, status: 'ok', runId, durationMs, ...counters, samples });
      return;
    }

    const linkOnlyTasks = discussionTasks.filter((task) => task.expectedThreadId === null);
    const deepDiscussionTasks = discussionTasks.filter((task) => task.expectedThreadId !== null);

    const earlyFingerprint = fingerprint(
      http,
      start,
      [...stagedThreads.values()],
      [...stagedDiscussions.values()],
      counters.claimed,
    );
    const parseHealth =
      runId === null
        ? null
        : await evaluateParseHealth(pool, {
            runId,
            source: SOURCE,
            mode: 'forum',
            populationType: 'targeted_queue',
            fingerprint: earlyFingerprint,
            exitIpStats: exitIpStats(http),
            decisionSkipReason:
              counters.claimed === 0 && http.healthStats().business.requests === 0
                ? 'empty_queue_no_business_requests'
                : null,
          });

    let categoriesApplied = false;
    let categoryApplyError: string | null = null;
    if (start.status !== 'failed') {
      try {
        const applied = await applyForumBatch(
          pool,
          { categories: start.data.categories, threads: [], posts: [] },
          new Date().toISOString(),
          runId,
        );
        addApplyCounts(counters, applied);
        categoriesApplied = true;
      } catch (err) {
        categoryApplyError = String(err);
        log.error('分类当前态应用失败', { error: categoryApplyError });
      }
    } else {
      categoryApplyError = start.error;
    }

    for (const task of forumTasks.filter((item) => item.kind === 'category')) {
      const result = stagedCategories.get(task.taskId);
      if (result === undefined) continue;
      // 该引用在 ensureCategoryCoverage 的异步闭包内赋值；显式保留可空类型，
      // 避免 TypeScript 把外层初值错误收窄成恒 null。
      const categoryIds = sitemapCategoryIds as Set<number> | null;
      const listedInSitemap = categoryIds?.has(task.targetId) === true;
      let status: 'ok' | 'partial' | 'failed' = result.status;
      let error = result.status === 'ok' ? null : result.error;
      let applyResult: Record<string, unknown> | null = null;
      let resultHash =
        result.status === 'failed'
          ? null
          : forumBatchResultHash({
              categories: [result.data.category],
              threads: result.data.threads,
              posts: [],
            });
      if (result.status === 'ok' && categoriesApplied) {
        try {
          applyResult = await applyForumCategorySnapshot(
            pool,
            result.data,
            new Date().toISOString(),
            runId,
            { allowThreadDeletion: listedInSitemap },
          );
          addApplyCounts(counters, applyResult);
          if (!listedInSitemap) {
            status = 'partial';
            error =
              categoryCoverageError ??
              `category ${task.targetId} 在 category sitemap 整体缺席；` +
                '已保存正面 thread，未从缺席推断删除';
          }
        } catch (err_) {
          status = 'failed';
          error = String(err_);
        }
      } else if (result.status === 'ok') {
        status = 'failed';
        error = categoryApplyError ?? '分类父表未成功应用';
      }
      const failurePolicy = classifyFinishedFailure('forum', status, error);
      if (failurePolicy?.action === 'irreconcilable') {
        resultHash = workFailureHash(failurePolicy);
      }
      const finish = await finishForumTarget(pool, task, {
        workerId,
        status,
        resultHash,
        terminalFailure: terminalForumFailure(failurePolicy, error),
        now: new Date().toISOString(),
      });
      finishedForum.add(task.taskId);
      countFinished(
        counters,
        status,
        finish.action === 'retried' ? null : finish.action,
        'forum',
        undefined,
        task.lane,
      );
      countRepeatedFailure(counters, task.attempts, status, finish.action);
      pushSample(samples, {
        kind: 'category',
        targetId: task.targetId,
        status,
        listedInSitemap,
        threads: result.status === 'failed' ? null : result.data.threads.length,
        pagesFetched: result.status === 'failed' ? null : result.data.pagesFetched,
        totalPages: result.status === 'failed' ? null : result.data.totalPages,
        action: finish.action,
        failurePolicy,
        apply: applyResult,
        error,
      });
    }

    for (const task of forumTasks.filter((item) => item.kind === 'thread')) {
      const result = stagedThreads.get(task.taskId);
      if (result === undefined) continue;
      let status = result.status;
      let error = result.status === 'ok' ? null : result.error;
      let resultHash: Buffer | null = result.status === 'failed'
        ? null
        : forumBatchResultHash(toForumBatch(result.data));
      let applyResult: Record<string, unknown> | null = null;
      if (result.status === 'ok' && categoriesApplied) {
        try {
          applyResult = await applyForumBatch(
            pool,
            toForumBatch(result.data),
            new Date().toISOString(),
            runId,
            { completeThreadIds: [result.data.thread.id] },
          );
          addApplyCounts(counters, applyResult);
        } catch (err) {
          status = 'failed';
          error = String(err);
        }
      } else if (result.status === 'ok') {
        status = 'failed';
        error = categoryApplyError ?? '分类父表未成功应用';
      }
      const deletedThread =
        result.status !== 'failed' && result.data.thread.isDeleted;
      const failurePolicy = classifyFinishedFailure('forum', status, error);
      if (failurePolicy?.action === 'irreconcilable') {
        resultHash = workFailureHash(failurePolicy);
      }
      const finish = await finishForumTarget(pool, task, {
        workerId,
        status,
        resultHash,
        terminalFailure: deletedThread
          ? {
              family: 'identity_absent',
              reason: error ?? `讨论串 ${task.targetId} 已删除`,
            }
          : terminalForumFailure(failurePolicy, error),
        now: new Date().toISOString(),
      });
      finishedForum.add(task.taskId);
      countFinished(counters, status, finish.action, 'forum', 'thread', task.lane);
      countRepeatedFailure(counters, task.attempts, status, finish.action);
      pushSample(samples, {
        kind: 'thread',
        targetId: task.targetId,
        status,
        posts: result.status === 'failed' ? null : result.data.posts.length,
        categoryId: result.status === 'failed' ? null : result.data.thread.categoryId,
        action: finish.action,
        failurePolicy,
        apply: applyResult,
        error,
      });
    }

    for (const task of linkOnlyTasks) {
      const result = stagedLinks.get(task.taskId);
      if (result === undefined) continue;
      let status = result.status;
      let error = result.status === 'ok' ? null : result.error;
      let resultHash: Buffer | null = null;
      let threadId: number | null = result.status === 'failed' ? null : result.data.threadId;
      let knownThreadLinked = false;
      try {
        const applied = await applyForumDiscussionLink(
          pool,
          toDiscussionTarget(task),
          result,
          new Date().toISOString(),
          runId,
        );
        if (applied !== null) {
          resultHash = applied.resultHash;
          threadId = applied.threadId;
          knownThreadLinked = applied.knownThreadLinked;
          await enqueueForumTargets(pool, [{
            kind: 'thread',
            targetId: applied.threadId,
            reasons: ['forum_page_link_discovered'],
            priority: 100,
            lane: 'steady',
          }], new Date().toISOString());
        }
      } catch (err) {
        status = 'failed';
        error = String(err);
        if (pgCode(err) === 'PGF01') {
          await noteFreezeSkip(pool, runId, task, error);
        }
      }
      const countInconsistent = isDiscussionCountInconsistent(result) && status === 'partial';
      const failurePolicy = countInconsistent
        ? classifyWorkFailure(task.kind, error ?? 'wikidot_discussion_count_inconsistent')
        : classifyFinishedFailure(task.kind, status, error);
      if (failurePolicy !== null && failurePolicy.action !== 'retry') {
        resultHash = workFailureHash(failurePolicy);
      }
      let identityReview: IdentityReviewResult | null = null;
      if (failurePolicy !== null && status === 'failed') {
        try {
          identityReview = await reviewIdentityIfDue(task, failurePolicy, () =>
            reviewFailedTaskIdentity(
              { pool, http, baseUrl: config.siteBaseUrl, runId },
              task,
            ),
          );
        } catch (err) {
          identityReview = {
            status: 'failed',
            finalized: false,
            error: `身份复核执行失败：${String(err)}`,
          };
        }
      }
      if (identityReview?.finalized === true) {
        finishedDiscussion.add(task.taskId);
        countFinished(counters, 'ok', null, 'discussion');
        pushSample(samples, {
          kind: 'discussion_link',
          lane: task.lane,
          pageId: task.pageId,
          status: 'identity_finalized',
          failurePolicy,
          identityReview,
          error,
        });
        continue;
      }
      const finish = await finishDiscussionTask(pool, task, {
        workerId,
        status,
        resultHash,
        terminalFailure: countInconsistent || failurePolicy?.action === 'irreconcilable',
        localValue: {
          discussion_thread_id: task.expectedThreadId,
          known_thread_linked: knownThreadLinked,
          stored_wikidot_id: task.wikidotId,
        },
        remoteValue: {
          classification: countInconsistent ? 'wikidot_discussion_count_inconsistent' : null,
          claimed_total: task.claimedTotal,
          expected_thread_id: task.expectedThreadId,
          thread_id: threadId,
          comments_posts: result.status === 'failed' ? null : result.data.posts.length,
          thread_reported_posts:
            result.status === 'failed' ? null : result.data.threadEvidence?.reportedPosts ?? null,
          thread_posts:
            result.status === 'failed' ? null : result.data.threadEvidence?.fetchedPosts ?? null,
        },
        now: new Date().toISOString(),
      });
      finishedDiscussion.add(task.taskId);
      countFinished(counters, status, finish.action, 'discussion');
      countRepeatedFailure(counters, task.attempts, status, finish.action);
      pushSample(samples, {
        kind: 'discussion_link',
        lane: task.lane,
        pageId: task.pageId,
        status,
        threadId,
        knownThreadLinked,
        action: finish.action,
        failurePolicy,
        identityReview: identityReview?.status ?? null,
        identityReviewError:
          identityReview?.status === 'failed' ? identityReview.error : null,
        error,
      });
    }

    for (const task of deepDiscussionTasks) {
      const result = stagedDiscussions.get(task.taskId);
      if (result === undefined) continue;
      let status = result.status;
      let error = result.status === 'ok' ? null : result.error;
      let resultHash: Buffer | null =
        result.status === 'failed'
          ? null
          : forumBatchResultHash(toForumBatch(result.data));
      let applyResult: Record<string, unknown> | null = null;
      try {
        const applied = await applyForumDiscussion(
          pool,
          toDiscussionTarget(task),
          result,
          start.status === 'failed' || categoriesApplied ? [] : start.data.categories,
          new Date().toISOString(),
          runId,
        );
        if (applied !== null) {
          applyResult = applied.forum;
          resultHash = applied.resultHash;
          addApplyCounts(counters, applied.forum);
        }
      } catch (err) {
        status = 'failed';
        error = String(err);
        if (pgCode(err) === 'PGF01') {
          await noteFreezeSkip(pool, runId, task, error);
        }
      }
      const deletedThread =
        result.status !== 'failed' && result.data.thread.isDeleted;
      const countInconsistent = isDiscussionCountInconsistent(result) && status === 'partial';
      const failurePolicy = countInconsistent
        ? classifyWorkFailure(task.kind, error ?? 'wikidot_discussion_count_inconsistent')
        : classifyFinishedFailure(task.kind, status, error);
      if (failurePolicy !== null && failurePolicy.action !== 'retry') {
        resultHash = workFailureHash(failurePolicy);
      }
      let identityReview: IdentityReviewResult | null = null;
      if (failurePolicy !== null && status === 'failed') {
        try {
          identityReview = await reviewIdentityIfDue(task, failurePolicy, () =>
            reviewFailedTaskIdentity(
              { pool, http, baseUrl: config.siteBaseUrl, runId },
              task,
            ),
          );
        } catch (err) {
          identityReview = {
            status: 'failed',
            finalized: false,
            error: `身份复核执行失败：${String(err)}`,
          };
        }
      }
      if (identityReview?.finalized === true) {
        finishedDiscussion.add(task.taskId);
        countFinished(counters, 'ok', null, 'discussion');
        pushSample(samples, {
          kind: task.kind,
          pageId: task.pageId,
          status: 'identity_finalized',
          failurePolicy,
          identityReview,
          error,
        });
        continue;
      }
      const finish = await finishDiscussionTask(pool, task, {
        workerId,
        status,
        resultHash,
        terminalFailure:
          deletedThread || countInconsistent || failurePolicy?.action === 'irreconcilable',
        localValue: applyResult ?? {},
        remoteValue: {
          classification: countInconsistent ? 'wikidot_discussion_count_inconsistent' : null,
          claimed_total: task.claimedTotal,
          fetched_total: result.diagnostics.fetchedTotal,
          expected_thread_id: task.expectedThreadId,
          thread_id: result.status === 'failed' ? null : result.data.threadId,
          thread_reported_posts:
            result.status === 'failed' ? null : result.data.thread.postCount,
        },
        now: new Date().toISOString(),
      });
      finishedDiscussion.add(task.taskId);
      countFinished(counters, status, finish.action, 'discussion');
      countRepeatedFailure(counters, task.attempts, status, finish.action);
      pushSample(samples, {
        kind: task.kind,
        pageId: task.pageId,
        wikidotId: task.wikidotId,
        slug: task.slug,
        status,
        threadId: result.status === 'failed' ? null : result.data.threadId,
        posts: result.status === 'failed' ? null : result.data.posts.length,
        action: finish.action,
        failurePolicy,
        identityReview: identityReview?.status ?? null,
        identityReviewError:
          identityReview?.status === 'failed' ? identityReview.error : null,
        apply: applyResult,
        error,
      });
    }

    const unprocessedForum = forumTasks
      .filter((task) => !finishedForum.has(task.taskId))
      .map((task) => task.taskId);
    const unprocessedDiscussion = discussionTasks
      .filter((task) => !finishedDiscussion.has(task.taskId))
      .map((task) => task.taskId);
    await releaseForumTargetLocks(
      pool,
      unprocessedForum,
      workerId,
      false,
      counters.stoppedByRuntimeBudget,
    );
    await releaseDiscussionTaskLocks(
      pool,
      unprocessedDiscussion,
      workerId,
      false,
      counters.stoppedByRuntimeBudget,
    );

    const unprocessedReleased = unprocessedForum.length + unprocessedDiscussion.length;
    if (budget.checkpoint()) counters.stoppedByRuntimeBudget = true;
    const health = evaluateRunHealth({
      claimed: counters.claimed,
      processed: counters.processed,
      partial: counters.partial,
      failed: counters.failed + counters.irreconcilable,
      deterministicFailures: counters.irreconcilable,
      deferred: unprocessedReleased,
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
      batchesTotal: http.stats().requests,
      batchesFailed: counters.failed,
      transportFailureRate: transportFailureRate(http),
      exitIpStats: exitIpStats(http),
      parseFingerprint: earlyFingerprint,
      stats: {
        mode: 'forum',
        durationMs,
        ...counters,
        maxInFlight: FORUM_CONSUME_MAX_IN_FLIGHT,
        unprocessedReleased,
        health,
        healthExclusions: {
          deterministic_failures: counters.irreconcilable,
        },
        startupProbe,
        parseHealth,
        http: http.stats(),
        httpHealth: http.healthStats(),
        samples,
        ...budget.summary(),
      },
    });
    emitSummary({
      ok: health.exitCode === 0,
      status,
      health,
      runId,
      durationMs,
      ...counters,
      maxInFlight: FORUM_CONSUME_MAX_IN_FLIGHT,
      unprocessedReleased,
      parseHealth,
      http: http.stats(),
      httpHealth: http.healthStats(),
      samples,
      ...budget.summary(),
    });
    process.exitCode = health.exitCode;
  } catch (err) {
    const breaker = err instanceof CircuitOpenError || http.breakerOpen;
    const unfinishedForum = forumTasks
      .filter((task) => !finishedForum.has(task.taskId))
      .map((task) => task.taskId);
    const unfinishedDiscussion = discussionTasks
      .filter((task) => !finishedDiscussion.has(task.taskId))
      .map((task) => task.taskId);
    await releaseForumTargetLocks(pool, unfinishedForum, workerId, true).catch(() => undefined);
    await releaseDiscussionTaskLocks(pool, unfinishedDiscussion, workerId, true).catch(() => undefined);
    await finishIngestRun(pool, runId, {
      status: breaker ? 'aborted' : 'failed',
      finishedAt: new Date().toISOString(),
      pagesEnumerated: counters.processed,
      remoteTotal: null,
      remoteTotalSource: 'unknown',
      batchesTotal: http.stats().requests,
      batchesFailed: Math.max(1, counters.failed),
      transportFailureRate: transportFailureRate(http),
      exitIpStats: exitIpStats(http),
      parseFingerprint: {
        http_status_dist: http.healthStats().business.statusBuckets,
        transport_failure_rate: transportFailureRate(http),
      },
      stats: {
        mode: 'forum',
        error: String(err),
        breaker,
        ...counters,
        unfinishedReleased: unfinishedForum.length + unfinishedDiscussion.length,
        startupProbe,
        http: http.stats(),
        httpHealth: http.healthStats(),
      },
    }).catch(() => undefined);
    emitSummary({
      ok: false,
      status: breaker ? 'aborted' : 'failed',
      runId,
      error: String(err),
      breaker,
      ...counters,
      unfinishedReleased: unfinishedForum.length + unfinishedDiscussion.length,
    });
    process.exitCode = 1;
  } finally {
    await http.close();
    await pool.end().catch(() => undefined);
  }
}

function toDiscussionTarget(task: ClaimedDiscussionTask): ForumDiscussionTarget {
  return {
    pageId: task.pageId,
    wikidotId: task.wikidotId,
    slug: task.slug,
    claimedTotal: task.claimedTotal,
    expectedThreadId: task.expectedThreadId,
    scanKind: task.kind,
  };
}

function toForumBatch(
  snapshot: ForumThreadSnapshot | ForumDiscussionSnapshot,
): ForumBatch {
  return {
    categories: [],
    threads: [snapshot.thread],
    posts: snapshot.posts,
  };
}

function updateFailureStreak<T>(
  result: CollectResult<T>,
  kind: ScanTaskKind,
  current: number,
  counters: Counters,
): number {
  const retryable = result.status === 'failed' &&
    classifyWorkFailure(kind, result.error).action === 'retry';
  const next = retryable ? current + 1 : 0;
  counters.consecutiveFailuresPeak = Math.max(counters.consecutiveFailuresPeak, next);
  return next;
}

function countFinished(
  counters: Counters,
  status: 'ok' | 'partial' | 'failed',
  action: string | null,
  taskClass: 'discussion' | 'forum',
  forumKind?: 'thread',
  forumLane?: 'catchup' | 'steady',
): void {
  counters.processed++;
  if (taskClass === 'discussion') counters.discussionProcessed++;
  else counters.forumProcessed++;
  if (forumKind === 'thread') counters.forumThreadProcessed++;
  if (forumLane === 'catchup') counters.forumCatchupProcessed++;
  if (forumLane === 'steady') counters.forumSteadyProcessed++;
  if (action === 'irreconcilable') {
    counters.irreconcilable++;
  } else if (status === 'ok') {
    counters.succeeded++;
  } else {
    counters[status]++;
  }
}

function countRepeatedFailure(
  counters: Counters,
  attempts: number,
  status: 'ok' | 'partial' | 'failed',
  action: string,
): void {
  if (
    status === 'failed' &&
    action === 'retried' &&
    attempts >= RUN_REPEATED_FAILURE_ATTEMPTS
  ) {
    counters.repeatedFailures++;
  }
}

function classifyFinishedFailure(
  kind: ScanTaskKind,
  status: 'ok' | 'partial' | 'failed',
  error: string | null,
): WorkFailurePolicy | null {
  return status === 'failed'
    ? classifyWorkFailure(kind, error ?? '未提供失败原因')
    : null;
}

function terminalForumFailure(
  policy: WorkFailurePolicy | null,
  error: string | null,
): { family: 'identity_absent' | 'structural'; reason: string } | null {
  if (policy?.action !== 'irreconcilable') return null;
  if (policy.family !== 'identity_absent' && policy.family !== 'structural') {
    throw new Error(`不可终结的 forum failure family：${policy.family}`);
  }
  return {
    family: policy.family,
    reason: error ?? policy.signature,
  };
}

function addApplyCounts(counters: Counters, result: Record<string, unknown>): void {
  counters.categoriesApplied += finiteCount(result['categories']);
  counters.threadsApplied += finiteCount(result['threads']);
  counters.postsApplied += finiteCount(result['posts']);
}

function finiteCount(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function pushSample(
  samples: Array<Record<string, unknown>>,
  sample: Record<string, unknown>,
): void {
  if (samples.length < 20) samples.push(sample);
}

function fingerprint(
  http: HttpClient,
  start: CollectResult<ForumStartSnapshot> | null,
  threads: readonly CollectResult<ForumThreadSnapshot>[],
  discussions: readonly CollectResult<ForumDiscussionSnapshot>[],
  claimed: number,
): Record<string, unknown> {
  const results: Array<CollectResult<ForumThreadSnapshot | ForumDiscussionSnapshot>> = [
    ...threads,
    ...discussions,
  ];
  let posts = 0;
  let bodyLength = 0;
  let parsed = 0;
  let parseFailures = 0;
  const authorKinds: Record<string, number> = {};
  for (const result of results) {
    if (result.status === 'failed') {
      if (isParseFailure(result.error)) parseFailures++;
      continue;
    }
    parsed++;
    posts += result.data.posts.length;
    for (const post of result.data.posts) {
      bodyLength += post.textPlain.length;
      const kind = post.author?.kind ?? 'missing';
      authorKinds[kind] = (authorKinds[kind] ?? 0) + 1;
    }
  }
  return {
    sample_counts: {
      forum_category_count:
        start === null || start.status === 'failed' ? 0 : start.data.categories.length,
      avg_posts_per_thread: parsed,
      forum_author_kind_dist: posts,
      avg_body_len: posts,
      parse_drop_rate: results.length,
    },
    forum_category_count: start === null || start.status === 'failed'
      ? null
      : start.data.categories.length,
    avg_posts_per_thread: parsed === 0 ? null : posts / parsed,
    forum_author_kind_dist: authorKinds,
    avg_body_len: posts === 0 ? null : bodyLength / posts,
    parse_drop_rate: results.length === 0 ? null : parseFailures / results.length,
    selector_empty_rate: null,
    http_status_dist: http.healthStats().business.statusBuckets,
    transport_failure_rate: transportFailureRate(http),
    targets_claimed: claimed,
  };
}

function isParseFailure(error: string): boolean {
  return /解析|结构|缺少|没有回显|body 为空|WAF|selector|pager|重复/.test(error);
}

async function noteFreezeSkip(
  pool: ReturnType<typeof createPool>,
  runId: number | null,
  task: ClaimedDiscussionTask,
  error: string,
): Promise<void> {
  await query(
    pool,
    'meta.note_freeze_skip:forum',
    `SELECT meta.note_freeze_skip($1, $2, $3, 'forum', $4)`,
    [runId, task.pageId, task.kind, error],
  ).catch((noteErr) =>
    log.error('冻结期论坛 page_scan 补写失败', { error: String(noteErr) }),
  );
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
    .name('forum-scan')
    .description('匿名消费页级论坛任务与 thread/category sitemap 差集（单次最多 50 个）')
    .option('--limit <n>', '本轮最多消费目标数（硬上限 50）', Number, 20)
    .option('--concurrency <n>', '并发数（1-5）', Number, 4)
    .option('--page-id <id>', '只认领指定 v2 page_id 的 forum/discussion 任务', Number)
    .option('--thread-id <id>', '只认领指定 sitemap thread_id 任务', Number)
    .option('--category-id <id>', '只认领指定 sitemap category_id 任务', Number)
    .option('--skip-tz-check', '跳过时区回环自检（仅本地调试）', false)
    .option('--probe-only', '只跑启动自检，不认领任务', false)
    .option('--amc-probe <policy>', 'AMC 探针 require | warn | skip（默认 require）')
    .option('--proxy-check <policy>', '代理健康 require | warn | skip（默认 warn）');
  addRuntimeBudgetOption(program, { defaultSec: 420, minSec: 1, maxSec: 3_600 });
  program.parse(process.argv);
  const raw = program.opts<{
    limit: number;
    concurrency: number;
    maxRuntimeSec: number;
    pageId?: number;
    threadId?: number;
    categoryId?: number;
    skipTzCheck: boolean;
    probeOnly: boolean;
    amcProbe?: string;
    proxyCheck?: string;
  }>();
  const ids = [raw.pageId, raw.threadId, raw.categoryId].filter(
    (value) => value !== undefined,
  );
  if (ids.length > 1) {
    throw new Error('--page-id / --thread-id / --category-id 互斥');
  }
  for (const id of ids) {
    if (!Number.isSafeInteger(id) || id! <= 0) throw new Error(`定向 id 非法：${String(id)}`);
  }
  const limit =
    Number.isFinite(raw.limit) && raw.limit > 0
      ? Math.min(TARGET_LIMIT_MAX, Math.floor(raw.limit))
      : 20;
  const concurrency =
    Number.isFinite(raw.concurrency) && raw.concurrency > 0
      ? Math.min(5, Math.floor(raw.concurrency))
      : 4;
  assertForumConsumeFairLimit(limit, ids.length > 0, Boolean(raw.probeOnly));
  const maxRuntimeSec = parseRuntimeBudgetSec(raw.maxRuntimeSec, {
    minSec: 1,
    maxSec: 3_600,
  });
  return {
    limit,
    concurrency,
    maxRuntimeSec,
    skipTzCheck: Boolean(raw.skipTzCheck),
    probeOnly: Boolean(raw.probeOnly),
    pageId: raw.pageId ?? null,
    threadId: raw.threadId ?? null,
    categoryId: raw.categoryId ?? null,
    ...(raw.amcProbe ? { amcProbe: raw.amcProbe } : {}),
    ...(raw.proxyCheck ? { proxyCheck: raw.proxyCheck } : {}),
  };
}

main().catch((err) => {
  log.error('致命错误', { error: String(err) });
  emitSummary({ ok: false, status: 'failed', error: String(err) });
  process.exitCode = 1;
});
