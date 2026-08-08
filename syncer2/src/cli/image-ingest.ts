/** 图片引用队列消费者：短进程、有限预算；外站与 Wikidot 健康窗口严格分开。 */

import { createLogger, emitSummary, redirectConsoleToStderr } from '../util/log.js';

redirectConsoleToStderr();

import os from 'node:os';
import path from 'node:path';
import { Command } from 'commander';

import { loadConfig, PROJECT_ROOT } from '../config.js';
import { HttpClient } from '../http/client.js';
import { PostgresAdaptiveEgressGate } from '../http/adaptiveEgress.js';
import {
  claimNextImageJob,
  processImageJob,
  type ImageWorkerOptions,
} from '../image/worker.js';
import { assertTimezoneRoundTrip, createPool, query } from '../store/db.js';
import { evaluateRunHealth } from '../work/runHealth.js';

const log = createLogger('image-ingest');

async function main(): Promise<void> {
  const cli = parseArgs();
  const config = loadConfig();
  const startedMs = Date.now();
  const deadlineMs = startedMs + cli.maxRuntimeSec * 1_000;
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
    minRequestIntervalMs: 7_200,
    logger: log.child('wikidot'),
    adaptiveEgress: new PostgresAdaptiveEgressGate(config.databaseUrl, 'image'),
  });
  // wdfiles/其它图床独立 1 req/s；其失败只出现在 externalHttp，不进入 Wikidot gate/health。
  const external = new HttpClient({
    userAgent: config.userAgent,
    referer: config.referer,
    proxyUrl: config.proxyUrl,
    timeoutMs: config.httpTimeoutMs,
    maxAttempts: 2,
    breaker503: config.breaker503,
    breakerReset: config.breakerReset,
    connections: 1,
    minRequestIntervalMs: cli.externalIntervalMs,
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
  };

  try {
    if (!cli.skipTzCheck) await assertTimezoneRoundTrip(pool);
    while (counters.claimed < cli.limit && Date.now() < deadlineMs) {
      const job = await claimNextImageJob(pool, workerId);
      if (job === null) break;
      counters.claimed++;
      const result = await processImageJob(pool, job, { wikidot, external }, options);
      counters[result.status]++;
      if (result.egressClass === 'wikidot_site') counters.wikidotSite++;
      else counters.external++;
      counters.bytes += result.bytes;
    }
    const queue = await query<{ status: string; n: string }>(
      pool,
      'image:queue_summary',
      `SELECT status, count(*)::text AS n
         FROM meta.image_ingest_job GROUP BY status ORDER BY status`,
    );
    const health = evaluateRunHealth({
      claimed: counters.claimed,
      processed: counters.completed + counters.retry + counters.failed,
      partial: 0,
      // retry 是本轮真实的可重试失败；只因它已重新入队，不能从整轮失败率消失。
      failed: counters.retry + counters.failed,
      breakerOpen: wikidot.breakerOpen || external.breakerOpen,
    });
    emitSummary({
      ok: health.exitCode === 0,
      status: health.status,
      health,
      durationMs: Date.now() - startedMs,
      runtimeBudgetReached: Date.now() >= deadlineMs,
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
    await query(
      pool,
      'image:release_worker_locks',
      `UPDATE meta.image_ingest_job
          SET status = 'pending', locked_by = NULL, locked_at = NULL,
              not_before = COALESCE(not_before, now() + interval '1 hour'), updated_at = now()
        WHERE locked_by = $1`,
      [workerId],
    ).catch(() => undefined);
    emitSummary({ ok: false, status: 'failed', error: String(error), ...counters });
    process.exitCode = 1;
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
    .option('--max-runtime-sec <n>', '单轮墙钟预算', Number, 420)
    .option('--max-bytes <n>', '单图解压后字节上限', Number, 20 * 1024 * 1024)
    .option('--max-attempts <n>', '瞬时失败最大尝试轮数', Number, 5)
    .option('--external-interval-ms <n>', '外站相邻请求间隔', Number, 1_000)
    .option('--asset-root <path>', '内容寻址资产目录')
    .option('--skip-tz-check', '仅本地调试', false)
    .parse();
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
    path.join(PROJECT_ROOT, 'data', 'image-assets');
  return {
    limit: Math.min(2_000, Math.max(1, Math.floor(raw.limit))),
    maxRuntimeSec: Math.min(540, Math.max(30, Math.floor(raw.maxRuntimeSec))),
    maxBytes: Math.min(100 * 1024 * 1024, Math.max(1_024, Math.floor(raw.maxBytes))),
    maxAttempts: Math.min(10, Math.max(1, Math.floor(raw.maxAttempts))),
    externalIntervalMs: Math.min(60_000, Math.max(250, Math.floor(raw.externalIntervalMs))),
    assetRoot: path.resolve(configuredRoot),
    skipTzCheck: Boolean(raw.skipTzCheck),
  };
}

await main();
