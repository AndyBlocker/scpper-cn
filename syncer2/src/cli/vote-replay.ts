/**
 * 全站投票 CAS 验收重放。
 *
 * 这是一次性短进程，不是调度任务。它直接读取一轮完整 Tier1 的 live 页声明，
 * 不创建/认领/改写 meta.scan_task，因此不会为了验收重置真实 partial 的退避。
 */

import { redirectConsoleToStderr, createLogger, emitSummary } from '../util/log.js';

redirectConsoleToStderr();

import { Command } from 'commander';
import type { Pool } from 'pg';

import {
  applyCollectedVoteSnapshot,
  collectVoteSnapshots,
  recordVoteScanFailure,
  type VoteTarget,
} from '../collect/votes.js';
import { loadConfig } from '../config.js';
import { amcProbePolicyFor, assertEgressContract, parseProbePolicy } from '../http/amc.js';
import { HttpClient } from '../http/client.js';
import { assertTimezoneRoundTrip, createPool, query } from '../store/db.js';
import { finishIngestRun, startIngestRun } from '../store/meta.js';
import { chunk, mapWithConcurrency } from '../util/concurrency.js';

const log = createLogger('vote-replay');
const SOURCE = 'wikidot_tier2';

interface ReplayTarget extends VoteTarget {
  slug: string;
}

interface CliOptions {
  tier1Run: number;
  concurrency: number;
  amcProbe?: string;
  proxyCheck?: string;
}

async function main(): Promise<void> {
  const opts = parseArgs();
  const config = loadConfig();
  const pool = createPool(config.databaseUrl, { max: Math.max(4, opts.concurrency + 1) });
  const http = new HttpClient({
    userAgent: config.userAgent,
    referer: config.referer,
    proxyUrl: config.proxyUrl,
    timeoutMs: config.httpTimeoutMs,
    maxAttempts: Math.max(3, config.httpMaxAttempts),
    breaker503: Math.max(5, config.breaker503),
    breakerReset: Math.max(5, config.breakerReset),
    connections: opts.concurrency,
    logger: log.child('http'),
    egress: {
      probeUrl: config.exitIpProbeUrl,
      everyNRequests: config.exitIpProbeEvery,
      maxProbes: config.exitIpProbeMax,
      mihomoApi: config.mihomoApi,
      hostFilter: new URL(config.siteBaseUrl).host,
    },
  });
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  let runId: number | null = null;
  let targets: ReplayTarget[] = [];
  const counters = {
    processed: 0,
    okPages: 0,
    partialPages: 0,
    failedPages: 0,
    writeFreezeSkipped: 0,
    checksumBad: 0,
    applyEventsReported: 0,
  };
  const partialSamples: Array<Record<string, unknown>> = [];

  try {
    http.assertHeaders();
    await assertTimezoneRoundTrip(pool);
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
    await assertTier1Run(pool, opts.tier1Run);
    targets = await loadReplayTargets(pool, opts.tier1Run);
    if (targets.length === 0) {
      throw new Error(`Tier1 run ${opts.tier1Run} 没有可重放的 live 页`);
    }

    runId = await startIngestRun(pool, SOURCE, startedAt);
    const chunks = chunk(targets, 50);
    for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
      const targetChunk = chunks[chunkIndex]!;
      const outcomes = await collectVoteSnapshots(
        http,
        config.siteBaseUrl,
        targetChunk,
        opts.concurrency,
      );
      await mapWithConcurrency(targetChunk, opts.concurrency, async (target) => {
        const outcome = outcomes.get(target.pageId) ?? {
          status: 'failed' as const,
          error: '内部错误：全站重放结果 Map 缺项',
        };
        if (outcome.data === undefined) {
          const error = 'error' in outcome ? outcome.error : '投票结果缺少 data';
          await recordVoteScanFailure(pool, target, runId, error);
          counters.failedPages++;
          counters.processed++;
          rememberPartial(partialSamples, target, 'failed', error, null);
          return;
        }

        try {
          const applied = await applyCollectedVoteSnapshot(
            pool,
            outcome,
            runId,
            new Date().toISOString(),
          );
          if (applied.scanStatus === 'ok') counters.okPages++;
          else if (applied.scanStatus === 'partial') counters.partialPages++;
          else counters.failedPages++;
          counters.processed++;
          const checksumOk = applied.applyResult['gate_checksum'] === true;
          if (!checksumOk) counters.checksumBad++;
          counters.applyEventsReported += numberValue(applied.applyResult['events']);
          if (applied.scanStatus !== 'ok') {
            rememberPartial(
              partialSamples,
              target,
              applied.scanStatus,
              stringValue(applied.applyResult['reason']),
              applied.applyResult,
            );
          }
        } catch (err) {
          const error = String(err);
          if (pgCode(err) === 'PGF01') {
            await query(
              pool,
              'vote_replay:note_freeze_skip',
              `SELECT meta.note_freeze_skip($1, $2, 'votes', 'vote', $3)`,
              [runId, target.pageId, error],
            );
            counters.writeFreezeSkipped++;
            rememberPartial(
              partialSamples,
              target,
              'partial',
              'write_frozen:vote',
              null,
            );
            return;
          }
          await recordVoteScanFailure(pool, target, runId, error);
          counters.failedPages++;
          counters.processed++;
          rememberPartial(partialSamples, target, 'failed', error, null);
        }
      });

      if (
        counters.processed === targets.length ||
        counters.processed % 500 === 0
      ) {
        log.info('全站投票重放进度', {
          runId,
          tier1Run: opts.tier1Run,
          ...counters,
          total: targets.length,
          chunksDone: chunkIndex + 1,
          chunksTotal: chunks.length,
          http: compactHttp(http),
        });
      }
      if (http.breakerOpen) {
        throw new Error(`HTTP breaker 已打开：${http.breakerReason ?? 'unknown'}`);
      }
    }

    const eventBreakdown = await loadEventBreakdown(pool, runId!);
    const status =
      counters.failedPages > 0
        ? 'failed'
        : counters.partialPages > 0 || counters.writeFreezeSkipped > 0
          ? 'partial'
          : 'ok';
    const finishedAt = new Date().toISOString();
    const parseHealth = await finishIngestRun(pool, runId, {
      status,
      finishedAt,
      pagesEnumerated: counters.processed,
      remoteTotal: targets.length,
      remoteTotalSource: 'listpages_total',
      batchesTotal: counters.processed,
      batchesFailed: counters.failedPages,
      transportFailureRate: transportFailureRate(http),
      exitIpStats: http.exitIpStats() as unknown as Record<string, unknown>,
      parseFingerprint: {
        http_status_dist: http.healthStats().business.statusBuckets,
        transport_failure_rate: transportFailureRate(http),
      },
      populationType: 'acceptance_replay',
      healthDecisionSkipReason:
        counters.processed === 0 && counters.writeFreezeSkipped > 0
          ? 'write_freeze_only'
          : null,
      stats: {
        mode: 'tier2_replay',
        population_type: 'acceptance_replay',
        tier1Run: opts.tier1Run,
        scope: {
          pages: targets.length,
          firstPageId: targets[0]!.pageId,
          lastPageId: targets[targets.length - 1]!.pageId,
          liveOnly: true,
        },
        durationMs: Date.now() - startedMs,
        concurrency: opts.concurrency,
        ...counters,
        healthExclusions: {
          write_freeze: counters.writeFreezeSkipped,
        },
        eventBreakdown,
        partialSamples,
        startupProbe,
        http: http.stats(),
        httpHealth: http.healthStats(),
      },
    });
    emitSummary({
      ok: status === 'ok' || status === 'partial',
      status,
      runId,
      tier1Run: opts.tier1Run,
      scope: {
        pages: targets.length,
        firstPageId: targets[0]!.pageId,
        lastPageId: targets[targets.length - 1]!.pageId,
        liveOnly: true,
      },
      ...counters,
      eventBreakdown,
      partialSamples,
      durationMs: Date.now() - startedMs,
      http: http.stats(),
      httpHealth: http.healthStats(),
      parseHealth,
    });
    process.exitCode = status === 'ok' || status === 'partial' ? 0 : 1;
  } catch (err) {
    const error = String(err);
    await finishIngestRun(pool, runId, {
      status: 'failed',
      finishedAt: new Date().toISOString(),
      pagesEnumerated: counters.processed,
      remoteTotal: targets.length || null,
      remoteTotalSource: targets.length > 0 ? 'listpages_total' : 'unknown',
      batchesTotal: targets.length || null,
      batchesFailed: Math.max(1, counters.partialPages + counters.failedPages),
      transportFailureRate: transportFailureRate(http),
      exitIpStats: http.exitIpStats() as unknown as Record<string, unknown>,
      evaluateParseHealth: false,
      stats: {
        mode: 'tier2_replay',
        population_type: 'acceptance_replay',
        tier1Run: opts.tier1Run,
        error,
        ...counters,
        http: http.stats(),
        httpHealth: http.healthStats(),
      },
    }).catch(() => undefined);
    emitSummary({
      ok: false,
      status: 'failed',
      runId,
      tier1Run: opts.tier1Run,
      error,
      ...counters,
    });
    process.exitCode = 1;
  } finally {
    await http.close();
    await pool.end().catch(() => undefined);
  }
}

function pgCode(err: unknown): string | null {
  return typeof err === 'object' &&
    err !== null &&
    typeof (err as { code?: unknown }).code === 'string'
    ? String((err as { code: string }).code)
    : null;
}

async function assertTier1Run(pool: Pool, tier1Run: number): Promise<void> {
  const result = await query<{
    status: string;
    source: string;
    pages_enumerated: number | null;
    remote_total: number | null;
    coverage_ratio: number | null;
    batches_failed: number | null;
    mode: string | null;
    snapshot_advanced: string | null;
  }>(
    pool,
    'vote_replay:tier1_gate',
    `SELECT status, source, pages_enumerated, remote_total, coverage_ratio,
            batches_failed, stats->>'mode' AS mode,
            stats->>'snapshotAdvanced' AS snapshot_advanced
       FROM meta.ingest_run
      WHERE id=$1`,
    [tier1Run],
  );
  const row = result.rows[0];
  if (
    row === undefined ||
    row.status !== 'ok' ||
    row.source !== 'wikidot' ||
    row.mode !== 'tier1' ||
    Number(row.coverage_ratio) < 0.98 ||
    Number(row.batches_failed ?? 0) !== 0 ||
    row.snapshot_advanced !== 'true'
  ) {
    throw new Error(`Tier1 run ${tier1Run} 不满足全站重放 gate：${JSON.stringify(row ?? null)}`);
  }
}

async function loadReplayTargets(pool: Pool, tier1Run: number): Promise<ReplayTarget[]> {
  const result = await query<{
    page_id: number;
    wikidot_id: number;
    slug: string;
    claimed_total: number;
    claimed_rating: number;
  }>(
    pool,
    'vote_replay:targets',
    `SELECT ps.page_id, pc.wikidot_id, pc.slug,
            ps.claimed_total, ps.checksum_expected AS claimed_rating
       FROM meta.page_scan ps
       JOIN serve.page_current pc ON pc.page_id=ps.page_id
      WHERE ps.run_id=$1
        AND ps.kind='meta'
        AND ps.status='ok'
        AND ps.claimed_total IS NOT NULL
        AND ps.checksum_expected IS NOT NULL
        AND pc.status='live'
      ORDER BY ps.page_id`,
    [tier1Run],
  );
  return result.rows.map((row) => ({
    pageId: Number(row.page_id),
    wikidotId: Number(row.wikidot_id),
    slug: row.slug,
    claimedTotal: Number(row.claimed_total),
    claimedRating: Number(row.claimed_rating),
  }));
}

async function loadEventBreakdown(
  pool: Pool,
  runId: number,
): Promise<Record<string, number>> {
  const result = await query<{ kind: string; events: string }>(
    pool,
    'vote_replay:event_breakdown',
    `SELECT kind, count(*)::text AS events
       FROM ingest.vote_event
      WHERE run_id=$1
      GROUP BY kind`,
    [runId],
  );
  const breakdown: Record<string, number> = {};
  for (const row of result.rows) breakdown[row.kind] = Number(row.events);
  return breakdown;
}

function rememberPartial(
  samples: Array<Record<string, unknown>>,
  target: ReplayTarget,
  status: 'partial' | 'failed',
  error: string | null,
  apply: Record<string, unknown> | null,
): void {
  if (samples.length >= 100) return;
  samples.push({
    pageId: target.pageId,
    wikidotId: target.wikidotId,
    slug: target.slug,
    status,
    error,
    claimedTotal: target.claimedTotal,
    claimedRating: target.claimedRating,
    checksumActual: apply?.['checksum_actual'] ?? null,
    gateChecksum: apply?.['gate_checksum'] ?? null,
    gateComplete: apply?.['gate_is_complete'] ?? null,
  });
}

function compactHttp(http: HttpClient): Record<string, unknown> {
  const stats = http.stats();
  return {
    requests: stats.requests,
    attempts: stats.attempts,
    retries: stats.retries,
    statusBuckets: stats.statusBuckets,
    breakerOpen: stats.breakerOpen,
  };
}

function transportFailureRate(http: HttpClient): number | null {
  const stats = http.healthStats().business;
  return stats.requests === 0
    ? null
    : stats.transportFailures / stats.requests;
}

function numberValue(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function parseArgs(): CliOptions {
  const program = new Command();
  program
    .name('vote-replay')
    .requiredOption('--tier1-run <id>', '完整 Tier1 run id', Number)
    .option('--concurrency <n>', 'HTTP/应用并发（1..4）', Number, 4)
    .option('--amc-probe <policy>', 'AMC 探针 require | warn | skip')
    .option('--proxy-check <policy>', '代理健康 require | warn | skip');
  program.parse(process.argv);
  const raw = program.opts<{
    tier1Run: number;
    concurrency: number;
    amcProbe?: string;
    proxyCheck?: string;
  }>();
  if (!Number.isSafeInteger(raw.tier1Run) || raw.tier1Run <= 0) {
    throw new Error(`--tier1-run 必须是正整数；收到 ${raw.tier1Run}`);
  }
  const concurrency =
    Number.isFinite(raw.concurrency) && raw.concurrency > 0
      ? Math.min(4, Math.floor(raw.concurrency))
      : 4;
  return {
    tier1Run: raw.tier1Run,
    concurrency,
    ...(raw.amcProbe ? { amcProbe: raw.amcProbe } : {}),
    ...(raw.proxyCheck ? { proxyCheck: raw.proxyCheck } : {}),
  };
}

main().catch((err) => {
  emitSummary({ ok: false, status: 'failed', error: String(err) });
  process.exitCode = 1;
});
