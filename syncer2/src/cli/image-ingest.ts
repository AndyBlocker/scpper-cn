/** 图片引用队列消费者：短进程、有限预算；外站与 Wikidot 健康窗口严格分开。 */

import { createLogger, emitSummary, redirectConsoleToStderr } from '../util/log.js';

redirectConsoleToStderr();

import os from 'node:os';
import path from 'node:path';
import { Command } from 'commander';

import { loadConfig } from '../config.js';
import { HttpClient } from '../http/client.js';
import { PostgresAdaptiveEgressGate } from '../http/adaptiveEgress.js';
import { ExternalImageDownloadClient } from '../image/externalClient.js';
import {
  claimNextImageJob,
  processImageJob,
  type ImageWorkerOptions,
} from '../image/worker.js';
import {
  emptyImageRouteCounters,
  evaluateImagePipelineHealth,
  recordImageRouteResult,
} from '../image/health.js';
import { SHARED_IMAGE_ASSET_ROOT } from '../image/config.js';
import { assertTimezoneRoundTrip, createPool, query } from '../store/db.js';
import { evaluateRunHealth } from '../work/runHealth.js';
import {
  addRuntimeBudgetOption,
  isRuntimeBudgetExceededError,
  parseRuntimeBudgetSec,
  RuntimeBudget,
} from '../util/runtimeBudget.js';

const log = createLogger('image-ingest');

async function main(): Promise<void> {
  const cli = parseArgs();
  const config = loadConfig();
  const startedMs = Date.now();
  const budget = new RuntimeBudget(cli.maxRuntimeSec);
  const workerId = `${os.hostname()}:${process.pid}:image`;
  const pool = createPool(config.databaseUrl, { max: 4 });
  const siteHost = new URL(config.siteBaseUrl).hostname.toLowerCase();
  const options: ImageWorkerOptions = {
    siteHost,
    assetRoot: cli.assetRoot,
    maxBytes: cli.maxBytes,
    maxAttempts: cli.maxAttempts,
    allowedHosts: parsePatterns(
      process.env.SYNCER2_IMAGE_ALLOWED_HOSTS,
      ['*'],
    ),
    blockedHosts: parsePatterns(
      process.env.SYNCER2_IMAGE_BLOCKED_HOSTS,
      ['localhost', 'cdn.mer.run'],
    ),
    retryBaseMs: 60 * 60_000,
    retryMaxMs: 7 * 24 * 60 * 60_000,
  };

  // 只有这个 client 接全站共享 gate；站内图片与 L1/论坛共享当前全局滚动预算。
  const wikidot = new HttpClient({
    userAgent: config.userAgent,
    referer: config.referer,
    proxyUrl: config.proxyUrl,
    timeoutMs: config.httpTimeoutMs,
    maxAttempts: 2,
    breaker503: config.breaker503,
    breakerReset: config.breakerReset,
    connections: 1,
    signal: budget.signal,
    logger: log.child('wikidot'),
    adaptiveEgress: new PostgresAdaptiveEgressGate(config.databaseUrl, 'image'),
  });
  // exact hostname 各自 breaker + 站外专用 PG gate；global 仅控制站外总量，绝不写 Wikidot gate。
  const external = new ExternalImageDownloadClient({
    databaseUrl: config.databaseUrl,
    userAgent: config.userAgent,
    referer: config.referer,
    proxyUrl: config.proxyUrl,
    timeoutMs: config.httpTimeoutMs,
    breaker503: config.breaker503,
    breakerReset: config.breakerReset,
    globalMinIntervalMs: cli.externalIntervalMs,
    signal: budget.signal,
    logger: log.child('external'),
  });
  wikidot.assertHeaders();
  external.assertHeaders();
  const counters = {
    claimed: 0,
    completed: 0,
    retry: 0,
    failed: 0,
    wikidotSite: 0,
    external: 0,
    bytes: 0,
    external429: 0,
    external503: 0,
    externalOther5xx: 0,
  };
  const routes = {
    wikidot_site: emptyImageRouteCounters(),
    external: emptyImageRouteCounters(),
  };

  try {
    if (!cli.skipTzCheck) await assertTimezoneRoundTrip(pool);
    while (counters.claimed < cli.limit && !budget.checkpoint()) {
      const job = await claimNextImageJob(pool, workerId);
      if (job === null) break;
      counters.claimed++;
      let result: Awaited<ReturnType<typeof processImageJob>>;
      try {
        result = await processImageJob(pool, job, { wikidot, external }, options);
      } catch (error) {
        if (!isRuntimeBudgetExceededError(error)) throw error;
        await query(
          pool,
          'image:release_runtime_budget_job',
          `UPDATE meta.image_ingest_job
              SET status = 'pending', locked_by = NULL, locked_at = NULL,
                  attempts = GREATEST(0, attempts - 1), updated_at = now()
            WHERE id = $1 AND locked_by = $2`,
          [job.id, workerId],
        );
        break;
      }
      recordImageRouteResult(routes, result);
      counters[result.status]++;
      if (result.egressClass === 'wikidot_site') counters.wikidotSite++;
      else {
        counters.external++;
        if (result.httpStatus === 429) counters.external429++;
        else if (result.httpStatus === 503) counters.external503++;
        else if (result.httpStatus !== null && result.httpStatus >= 500) counters.externalOther5xx++;
      }
      counters.bytes += result.bytes;
    }
    const queue = await query<{ status: string; n: string }>(
      pool,
      'image:queue_summary',
      `SELECT status, count(*)::text AS n
         FROM meta.image_ingest_job GROUP BY status ORDER BY status`,
    );
    const pipelineHealth = evaluateImagePipelineHealth(routes, {
      wikidotSite: wikidot.breakerOpen,
      external: external.breakerOpen,
    });
    // CLI 入口仍直接接统一判据，并且不传 failureRateThreshold：这把 Wikidot 主站的
    // 0.25 默认阈值钉死。分链路 helper 若未来意外放宽主站，这个一致性断言会 fail closed。
    const wikidotMainHealth = evaluateRunHealth({
      claimed: routes.wikidot_site.claimed,
      processed: routes.wikidot_site.completed + routes.wikidot_site.retry + routes.wikidot_site.failed,
      partial: 0,
      failed: routes.wikidot_site.retry + routes.wikidot_site.failed,
      deterministicFailures: routes.wikidot_site.healthExcluded,
      breakerOpen: wikidot.breakerOpen,
    });
    if (JSON.stringify(wikidotMainHealth) !== JSON.stringify(pipelineHealth.wikidotSite)) {
      throw new Error('图片 Wikidot 分链路健康判据偏离统一默认阈值');
    }
    /*
     * 退出码改用分账结果：此前用合并计数走统一 25% 阈值，
     * 而站外图床实测瞬时失败率就在 25.5% 上下，于是每轮都判 failed
     * （实测 http_transient 456 / network 31 均为可重试，
     * 确定性的 invalid_content_type 68 / blocked_host 7 / http_permanent 6 已另计）。
     * pipelineHealth.unified 取两条链路各自判定后的较差者，且各用各的阈值——
     * wikidot 主站不放宽，站外用 EXTERNAL_IMAGE_FAILURE_RATE_THRESHOLD。
     */
    const health = pipelineHealth.unified;
    emitSummary({
      ok: health.exitCode === 0,
      status: health.status,
      health,
      pipelineHealth,
      wikidotMainHealth,
      routeCounters: routes,
      durationMs: Date.now() - startedMs,
      runtimeBudgetReached: budget.checkpoint(),
      ...budget.summary(),
      ...counters,
      queue: Object.fromEntries(queue.rows.map((row) => [row.status, Number(row.n)])),
      assetRoot: options.assetRoot,
      wikidotHttp: wikidot.stats(),
      wikidotHealth: wikidot.healthStats(),
      externalHttp: external.stats(),
      externalHealth: external.healthStats(),
      externalFailuresAffectWikidotHealth: false,
    });
    process.exitCode = health.exitCode;
  } catch (error) {
    const runtimeBudget = isRuntimeBudgetExceededError(error);
    if (runtimeBudget) budget.checkpoint();
    await query(
      pool,
      'image:release_worker_locks',
      `UPDATE meta.image_ingest_job
          SET status = 'pending', locked_by = NULL, locked_at = NULL,
              attempts = GREATEST(0, attempts - CASE WHEN $2 THEN 1 ELSE 0 END),
              not_before = CASE WHEN $2 THEN not_before
                                ELSE COALESCE(not_before, now() + interval '1 hour') END,
              updated_at = now()
        WHERE locked_by = $1`,
      [workerId, runtimeBudget],
    ).catch(() => undefined);
    emitSummary({
      ok: runtimeBudget,
      status: runtimeBudget ? 'partial' : 'failed',
      error: String(error),
      ...counters,
      ...budget.summary(),
    });
    process.exitCode = runtimeBudget ? 0 : 1;
  } finally {
    await Promise.all([wikidot.close(), external.close()]);
    await pool.end().catch(() => undefined);
  }
}

function parsePatterns(raw: string | undefined, fallback: string[]): string[] {
  if (raw === undefined) return fallback;
  return raw.split(',').map((item) => item.trim().toLowerCase()).filter(Boolean);
}

function parseArgs(): {
  limit: number;
  maxRuntimeSec: number;
  maxBytes: number;
  maxAttempts: number;
  externalIntervalMs: number;
  assetRoot: string;
  skipTzCheck: boolean;
} {
  const command = new Command()
    .name('image-ingest')
    .option('--limit <n>', '单轮最多任务', Number, 500)
    .option('--max-bytes <n>', '单图解压后字节上限', Number, 20 * 1024 * 1024)
    .option('--max-attempts <n>', '瞬时失败最大尝试轮数', Number, 5)
    .option('--external-interval-ms <n>', '站外 aggregate 相邻 attempt 间隔（安全下限 3000ms）', Number, 3_000)
    .option('--asset-root <path>', '内容寻址资产目录')
    .option('--skip-tz-check', '仅本地调试', false);
  addRuntimeBudgetOption(command, { defaultSec: 420, minSec: 1, maxSec: 3_600 });
  command.parse();
  const raw = command.opts<{
    limit: number;
    maxRuntimeSec: number;
    maxBytes: number;
    maxAttempts: number;
    externalIntervalMs: number;
    assetRoot?: string;
    skipTzCheck: boolean;
  }>();
  const configuredRoot = raw.assetRoot ?? process.env.SYNCER2_IMAGE_ASSET_ROOT ??
    SHARED_IMAGE_ASSET_ROOT;
  return {
    limit: Math.min(2_000, Math.max(1, Math.floor(raw.limit))),
    maxRuntimeSec: parseRuntimeBudgetSec(raw.maxRuntimeSec, { minSec: 1, maxSec: 3_600 }),
    maxBytes: Math.min(100 * 1024 * 1024, Math.max(1_024, Math.floor(raw.maxBytes))),
    maxAttempts: Math.min(10, Math.max(1, Math.floor(raw.maxAttempts))),
    externalIntervalMs: Math.min(60_000, Math.max(3_000, Math.floor(raw.externalIntervalMs))),
    assetRoot: path.resolve(configuredRoot),
    skipTzCheck: Boolean(raw.skipTzCheck),
  };
}

await main();
