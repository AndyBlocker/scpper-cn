/**
 * M5 论坛差集消费入口。
 *
 * 单次短进程，页级 forum/discussion 任务优先，然后消费 thread/category sitemap 差集；
 * 最多认领 50 个目标。所有远端读取都走匿名 AMC，绝不创建登录 session。
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
  forumBatchResultHash,
  scanForumCategories,
  scanForumStart,
  scanForumThreads,
  scanPageDiscussions,
  type ForumBatch,
  type ForumCategorySnapshot,
  type ForumDiscussionSnapshot,
  type ForumDiscussionTarget,
  type ForumStartSnapshot,
  type ForumThreadSnapshot,
} from '../collect/forum.js';
import { failed, type CollectResult } from '../collect/result.js';
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
import { finishIngestRun, startIngestRun } from '../store/meta.js';
import {
  claimDiscussionTasks,
  claimForumTargets,
  finishDiscussionTask,
  finishForumTarget,
  releaseDiscussionTaskLocks,
  releaseForumTargetLocks,
  type ClaimedDiscussionTask,
  type ClaimedForumTarget,
} from '../store/queues.js';

const log = createLogger('forum-scan');
const SOURCE = 'wikidot_forum';
const FAILURE_LIMIT = 5;
const TARGET_LIMIT_MAX = 50;

interface CliOptions {
  limit: number;
  concurrency: number;
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
  processed: number;
  succeeded: number;
  partial: number;
  failed: number;
  categoriesApplied: number;
  threadsApplied: number;
  postsApplied: number;
  irreconcilable: number;
  consecutiveFailuresPeak: number;
  stoppedByFailureLimit: boolean;
}

async function main(): Promise<void> {
  const opts = parseArgs();
  const config = loadConfig();
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
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
    processed: 0,
    succeeded: 0,
    partial: 0,
    failed: 0,
    categoriesApplied: 0,
    threadsApplied: 0,
    postsApplied: 0,
    irreconcilable: 0,
    consecutiveFailuresPeak: 0,
    stoppedByFailureLimit: false,
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

    // 页级变更是 Tier1 的新鲜事件，优先于 8.6 万条冷启动 thread 差集。
    if (opts.threadId === null && opts.categoryId === null) {
      discussionTasks = await claimDiscussionTasks(
        pool,
        opts.limit,
        workerId,
        opts.pageId,
      );
    }
    if (opts.pageId === null) {
      forumTasks = await claimForumTargets(
        pool,
        opts.limit - discussionTasks.length,
        workerId,
        { threadId: opts.threadId, categoryId: opts.categoryId },
      );
    }
    counters.discussionClaimed = discussionTasks.length;
    counters.forumClaimed = forumTasks.length;
    counters.claimed = discussionTasks.length + forumTasks.length;
    log.info('已认领论坛差集', {
      page: discussionTasks.length,
      forum: forumTasks.length,
      limit: opts.limit,
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
          startupProbe,
          http: http.stats(),
          httpHealth: http.healthStats(),
        },
      });
      emitSummary({ ok: true, status: 'ok', runId, durationMs, ...counters, samples });
      return;
    }

    const start = await scanForumStart(http, config.siteBaseUrl);
    const stagedCategories = new Map<number, CollectResult<ForumCategorySnapshot>>();
    const stagedThreads = new Map<number, CollectResult<ForumThreadSnapshot>>();
    const stagedDiscussions = new Map<number, CollectResult<ForumDiscussionSnapshot>>();
    let sitemapCategoryIds: Set<number> | null = null;
    let categoryCoverageError: string | null = null;
    let consecutiveFailures = start.status === 'failed' ? 1 : 0;
    if (start.status === 'failed') {
      counters.consecutiveFailuresPeak = 1;
      for (const task of discussionTasks) {
        stagedDiscussions.set(
          task.taskId,
          failed(`ForumStartModule 前置抓取失败：${start.error}`),
        );
      }
      for (const task of forumTasks) {
        if (task.kind === 'category') {
          stagedCategories.set(
            task.taskId,
            failed(`ForumStartModule 前置抓取失败：${start.error}`),
          );
        } else {
          stagedThreads.set(
            task.taskId,
            failed(`ForumStartModule 前置抓取失败：${start.error}`),
          );
        }
      }
    }

    if (start.status !== 'failed') {
      const categoryTasks = forumTasks.filter((task) => task.kind === 'category');
      const threadTasks = forumTasks.filter((task) => task.kind === 'thread');
      if (categoryTasks.length > 0) {
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
          const missingCategories = start.data.categories
            .map((category) => category.id)
            .filter((id) => !sitemapCategoryIds!.has(id));
          if (missingCategories.length > 0) {
            log.warn('category sitemap 覆盖不完整：缺席分类只记 partial，禁止判 thread 删除', {
              missingCategories,
              count: missingCategories.length,
            });
          }
        } catch (err) {
          categoryCoverageError = `category sitemap 抓取失败：${String(err)}`;
          log.warn('无法证明分类在 sitemap 中；本轮所有分类只保存正面观测，不判删除', {
            error: categoryCoverageError,
          });
        }
        const results = await scanForumCategories(
          http,
          config.siteBaseUrl,
          categoryTasks.map((task) => task.targetId),
          opts.concurrency,
        );
        for (const task of categoryTasks) {
          stagedCategories.set(
            task.taskId,
            results.get(task.targetId) ??
              failed<ForumCategorySnapshot>('内部错误：分类枚举结果 Map 缺项'),
          );
        }
      }
      scanGroups: for (let offset = 0; offset < discussionTasks.length; offset += opts.concurrency) {
        const group = discussionTasks.slice(offset, offset + opts.concurrency);
        const results = await scanPageDiscussions(
          http,
          config.siteBaseUrl,
          group.map(toDiscussionTarget),
          opts.concurrency,
        );
        for (const task of group) {
          const result =
            results.get(task.pageId) ??
            failed<ForumDiscussionSnapshot>('内部错误：页面讨论结果 Map 缺项');
          stagedDiscussions.set(task.taskId, result);
          consecutiveFailures = updateFailureStreak(result, consecutiveFailures, counters);
          if (http.breakerOpen || consecutiveFailures >= FAILURE_LIMIT) {
            counters.stoppedByFailureLimit = consecutiveFailures >= FAILURE_LIMIT;
            break scanGroups;
          }
        }
      }

      if (!http.breakerOpen && !counters.stoppedByFailureLimit) {
        for (let offset = 0; offset < threadTasks.length; offset += opts.concurrency) {
          const group = threadTasks.slice(offset, offset + opts.concurrency);
          const results = await scanForumThreads(
            http,
            config.siteBaseUrl,
            group.map((task) => task.targetId),
            opts.concurrency,
          );
          for (const task of group) {
            const result =
              results.get(task.targetId) ??
              failed<ForumThreadSnapshot>('内部错误：主题结果 Map 缺项');
            stagedThreads.set(task.taskId, result);
            consecutiveFailures = updateFailureStreak(result, consecutiveFailures, counters);
            if (http.breakerOpen || consecutiveFailures >= FAILURE_LIMIT) {
              counters.stoppedByFailureLimit = consecutiveFailures >= FAILURE_LIMIT;
              break;
            }
          }
          if (http.breakerOpen || counters.stoppedByFailureLimit) break;
        }
      }
    }

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
      const listedInSitemap = sitemapCategoryIds?.has(task.targetId) === true;
      let status: 'ok' | 'partial' | 'failed' = result.status;
      let error = result.status === 'ok' ? null : result.error;
      let applyResult: Record<string, unknown> | null = null;
      const resultHash =
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
      const finish = await finishForumTarget(pool, task, {
        workerId,
        status,
        resultHash,
        now: new Date().toISOString(),
      });
      finishedForum.add(task.taskId);
      countFinished(counters, status, finish.action === 'retried' ? null : finish.action);
      pushSample(samples, {
        kind: 'category',
        targetId: task.targetId,
        status,
        listedInSitemap,
        threads: result.status === 'failed' ? null : result.data.threads.length,
        pagesFetched: result.status === 'failed' ? null : result.data.pagesFetched,
        totalPages: result.status === 'failed' ? null : result.data.totalPages,
        action: finish.action,
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
      const finish = await finishForumTarget(pool, task, {
        workerId,
        status,
        resultHash,
        now: new Date().toISOString(),
      });
      finishedForum.add(task.taskId);
      countFinished(counters, status, null);
      pushSample(samples, {
        kind: 'thread',
        targetId: task.targetId,
        status,
        posts: result.status === 'failed' ? null : result.data.posts.length,
        categoryId: result.status === 'failed' ? null : result.data.thread.categoryId,
        action: finish.action,
        apply: applyResult,
        error,
      });
    }

    for (const task of discussionTasks) {
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
      const finish = await finishDiscussionTask(pool, task, {
        workerId,
        status,
        resultHash,
        localValue: applyResult ?? {},
        remoteValue: {
          claimed_total: task.claimedTotal,
          fetched_total: result.diagnostics.fetchedTotal,
          expected_thread_id: task.expectedThreadId,
        },
        now: new Date().toISOString(),
      });
      finishedDiscussion.add(task.taskId);
      countFinished(counters, status, finish.action);
      pushSample(samples, {
        kind: task.kind,
        pageId: task.pageId,
        wikidotId: task.wikidotId,
        slug: task.slug,
        status,
        threadId: result.status === 'failed' ? null : result.data.threadId,
        posts: result.status === 'failed' ? null : result.data.posts.length,
        action: finish.action,
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
    await releaseForumTargetLocks(pool, unprocessedForum, workerId);
    await releaseDiscussionTaskLocks(pool, unprocessedDiscussion, workerId);

    const stopped = http.breakerOpen || counters.stoppedByFailureLimit;
    const status =
      stopped
        ? http.breakerOpen
          ? 'aborted'
          : 'failed'
        : counters.failed > 0
          ? 'failed'
          : counters.partial > 0
            ? 'partial'
            : 'ok';
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
        unprocessedReleased: unprocessedForum.length + unprocessedDiscussion.length,
        startupProbe,
        parseHealth,
        http: http.stats(),
        httpHealth: http.healthStats(),
        samples,
      },
    });
    emitSummary({
      ok: status === 'ok' || status === 'partial',
      status,
      runId,
      durationMs,
      ...counters,
      unprocessedReleased: unprocessedForum.length + unprocessedDiscussion.length,
      parseHealth,
      http: http.stats(),
      httpHealth: http.healthStats(),
      samples,
    });
    process.exitCode = status === 'ok' || status === 'partial' ? 0 : 1;
  } catch (err) {
    const breaker = err instanceof CircuitOpenError || http.breakerOpen;
    const unfinishedForum = forumTasks
      .filter((task) => !finishedForum.has(task.taskId))
      .map((task) => task.taskId);
    const unfinishedDiscussion = discussionTasks
      .filter((task) => !finishedDiscussion.has(task.taskId))
      .map((task) => task.taskId);
    await releaseForumTargetLocks(pool, unfinishedForum, workerId).catch(() => undefined);
    await releaseDiscussionTaskLocks(pool, unfinishedDiscussion, workerId).catch(() => undefined);
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
  current: number,
  counters: Counters,
): number {
  const next = result.status === 'failed' ? current + 1 : 0;
  counters.consecutiveFailuresPeak = Math.max(counters.consecutiveFailuresPeak, next);
  return next;
}

function countFinished(
  counters: Counters,
  status: 'ok' | 'partial' | 'failed',
  action: string | null,
): void {
  counters.processed++;
  if (status === 'ok') counters.succeeded++;
  else counters[status]++;
  if (action === 'irreconcilable') counters.irreconcilable++;
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
  program.parse(process.argv);
  const raw = program.opts<{
    limit: number;
    concurrency: number;
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
  return {
    limit,
    concurrency,
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
