/** ForumStart 廉价信号层：5 分钟短进程，只把变化 thread 投递到 steady 深扫队列。 */

import { createLogger, emitSummary, redirectConsoleToStderr } from '../util/log.js';

redirectConsoleToStderr();

import { Command } from 'commander';

import {
  applyForumBatch,
  scanForumStart,
  type ForumCategoryPage,
} from '../collect/forum.js';
import {
  discoverChangedForumThreads,
  fetchForumIncrementalStates,
  fetchForumThreadPostCounts,
  finishForumCategorySweep,
  forumCategoryPageFetcher,
  observeForumCategorySignals,
} from '../collect/forumIncremental.js';
import { failed, type CollectResult } from '../collect/result.js';
import { loadConfig } from '../config.js';
import { HttpClient } from '../http/client.js';
import { PostgresAdaptiveEgressGate } from '../http/adaptiveEgress.js';
import { assertTimezoneRoundTrip, createPool } from '../store/db.js';
import { finishIngestRun, startIngestRun } from '../store/meta.js';
import {
  enqueueForumTargets,
  forumQueueBreakdown,
  seedForumDiscussionLinkTasks,
} from '../store/queues.js';
import {
  classifyWorkFailure,
  isDeterministicWorkFailure,
} from '../work/failurePolicy.js';
import { evaluateRunHealth } from '../work/runHealth.js';
import {
  addRuntimeBudgetOption,
  parseRuntimeBudgetSec,
  RuntimeBudget,
} from '../util/runtimeBudget.js';

const log = createLogger('forum-incremental');
const SOURCE = 'wikidot_forum';

interface CliOptions {
  maxPages: number;
  maxRuntimeSec: number;
  skipTzCheck: boolean;
}

async function main(): Promise<void> {
  const options = parseArgs();
  const config = loadConfig();
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const budget = new RuntimeBudget(options.maxRuntimeSec);
  const pool = createPool(config.databaseUrl, { max: 4 });
  const http = new HttpClient({
    userAgent: config.userAgent,
    referer: config.referer,
    proxyUrl: config.proxyUrl,
    timeoutMs: config.httpTimeoutMs,
    maxAttempts: Math.max(3, config.httpMaxAttempts),
    breaker503: Math.max(5, config.breaker503),
    breakerReset: Math.max(5, config.breakerReset),
    connections: 2,
    logger: log.child('http'),
    adaptiveEgress: new PostgresAdaptiveEgressGate(config.databaseUrl, 'forum'),
  });
  http.assertHeaders();
  let runId: number | null = null;

  try {
    if (!options.skipTzCheck) await assertTimezoneRoundTrip(pool);
    runId = await startIngestRun(pool, SOURCE, startedAt);
    const start = await scanForumStart(http, config.siteBaseUrl);
    if (start.status !== 'ok') throw new Error(start.error);

    // 必须先读旧 swept 水位，再写本轮 observed；否则崩溃恢复时会漏掉变化。
    const [states, knownPostCounts] = await Promise.all([
      fetchForumIncrementalStates(pool),
      fetchForumThreadPostCounts(pool),
    ]);
    await applyForumBatch(
      pool,
      { categories: start.data.categories, threads: [], posts: [] },
      new Date().toISOString(),
      runId,
    );
    await observeForumCategorySignals(pool, start.data.categories, new Date().toISOString());

    let pageRequests = 0;
    const baseFetcher = forumCategoryPageFetcher(http, config.siteBaseUrl);
    const fetchPage = async (
      categoryId: number,
      pageNo: number,
    ): Promise<CollectResult<ForumCategoryPage>> => {
      if (budget.checkpoint() || pageRequests >= options.maxPages) {
        return failed<ForumCategoryPage>(
          `论坛增量达到 ${options.maxRuntimeSec}s/${options.maxPages} 页单轮预算`,
        );
      }
      pageRequests++;
      return baseFetcher(categoryId, pageNo);
    };
    const discoveries = await discoverChangedForumThreads(
      start.data.categories,
      states,
      knownPostCounts,
      fetchPage,
      options.maxPages,
    );

    const changedThreadIds = [...new Set(
      discoveries.flatMap((result) => result.changedThreadIds),
    )];
    await enqueueForumTargets(
      pool,
      changedThreadIds.map((targetId) => ({
        kind: 'thread' as const,
        targetId,
        reasons: ['forum_category_activity_signal'],
        priority: 100,
        lane: 'steady' as const,
      })),
      new Date().toISOString(),
    );
    for (const result of discoveries) {
      const category = start.data.categories.find((item) => item.id === result.categoryId);
      if (category !== undefined) {
        await finishForumCategorySweep(pool, category, result, new Date().toISOString());
      }
    }

    // 只插入尚无页级任务的缺口；首轮 28k，此后通常为 0，不会每 5 分钟重写整队列。
    const linkTasksSeeded = await seedForumDiscussionLinkTasks(pool);
    const queue = await forumQueueBreakdown(pool);
    const failedResults = discoveries.filter((result) => result.status === 'failed');
    budget.checkpoint();
    const runtimeBudgetFailures = budget.stoppedByRuntimeBudget
      ? failedResults.filter((result) => result.error?.includes('单轮预算'))
      : [];
    const runtimeBudgetFailureSet = new Set(runtimeBudgetFailures);
    const countedFailedResults = failedResults.filter(
      (result) => !runtimeBudgetFailureSet.has(result),
    );
    const deterministicFailures = countedFailedResults.filter((result) =>
      isDeterministicWorkFailure(
        classifyWorkFailure('forum', result.error ?? '未提供论坛增量失败原因'),
      )
    ).length;
    const health = evaluateRunHealth({
      claimed: discoveries.length,
      processed: discoveries.length,
      partial: discoveries.filter((result) => result.status === 'partial').length,
      failed: countedFailedResults.length,
      deterministicFailures,
      deferred: runtimeBudgetFailures.length,
      breakerOpen: http.breakerOpen,
    });
    const status = health.status;
    const durationMs = Date.now() - startedMs;
    const stats = {
      mode: 'forum_incremental',
      categoriesObserved: start.data.categories.length,
      categoriesChanged: discoveries.length,
      categoryPagesFetched: pageRequests,
      threadsEnqueuedSteady: changedThreadIds.length,
      linkTasksSeeded,
      queue,
      discoveries,
      durationMs,
      http: http.stats(),
      httpHealth: http.healthStats(),
      health,
      ...budget.summary(),
    };
    await finishIngestRun(pool, runId, {
      status,
      finishedAt: new Date().toISOString(),
      pagesEnumerated: discoveries.length,
      remoteTotal: start.data.categories.length,
      remoteTotalSource: 'unknown',
      batchesTotal: http.stats().requests,
      batchesFailed: health.retryableFailures,
      transportFailureRate: transportFailureRate(http),
      exitIpStats: {},
      parseFingerprint: {
        categories: start.data.categories.length,
        changed_categories: discoveries.length,
      },
      stats,
    });
    emitSummary({ ok: health.exitCode === 0, status, runId, ...stats });
    process.exitCode = health.exitCode;
  } catch (error) {
    await finishIngestRun(pool, runId, {
      status: 'failed',
      finishedAt: new Date().toISOString(),
      pagesEnumerated: 0,
      remoteTotal: null,
      remoteTotalSource: 'unknown',
      batchesTotal: http.stats().requests,
      batchesFailed: 1,
      transportFailureRate: transportFailureRate(http),
      exitIpStats: {},
      parseFingerprint: {},
      stats: { mode: 'forum_incremental', error: String(error), http: http.stats() },
    }).catch(() => undefined);
    emitSummary({ ok: false, status: 'failed', runId, error: String(error) });
    process.exitCode = 1;
  } finally {
    await http.close();
    await pool.end().catch(() => undefined);
  }
}

function transportFailureRate(http: HttpClient): number | null {
  const stats = http.healthStats().business;
  return stats.requests === 0 ? null : stats.transportFailures / stats.requests;
}

function parseArgs(): CliOptions {
  const program = new Command();
  program
    .name('forum-incremental')
    .option('--max-pages <n>', '单轮分类页总预算', Number, 40)
    .option('--skip-tz-check', '仅本地调试', false);
  addRuntimeBudgetOption(program, { defaultSec: 420, minSec: 1, maxSec: 3_600 });
  program.parse(process.argv);
  const raw = program.opts<{ maxPages: number; maxRuntimeSec: number; skipTzCheck: boolean }>();
  return {
    maxPages: Math.min(200, Math.max(1, Math.floor(raw.maxPages))),
    maxRuntimeSec: parseRuntimeBudgetSec(raw.maxRuntimeSec, { minSec: 1, maxSec: 3_600 }),
    skipTzCheck: Boolean(raw.skipTzCheck),
  };
}

main().catch((error) => {
  log.error('致命错误', { error: String(error) });
  emitSummary({ ok: false, status: 'failed', error: String(error) });
  process.exitCode = 1;
});
