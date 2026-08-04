/**
 * MULTI 一次性存量收敛：只抓当前 rating 分歧页与遗留正负冲突页。
 * 不创建/消费 scan_task，不扩到全站；默认上限 600 页，低于日预算 8,600。
 */

import { Command } from 'commander';

import {
  applyCollectedVoteSnapshot,
  collectVoteSnapshots,
  recordVoteScanFailure,
  type VoteTarget,
} from '../collect/votes.js';
import { loadConfig } from '../config.js';
import { HttpClient } from '../http/client.js';
import { assertTimezoneRoundTrip, createPool, query } from '../store/db.js';
import { finishIngestRun, startIngestRun } from '../store/meta.js';
import { chunk, mapWithConcurrency } from '../util/concurrency.js';
import { createLogger, emitSummary, redirectConsoleToStderr } from '../util/log.js';

redirectConsoleToStderr();
const log = createLogger('vote-multiplicity-converge');
const SOURCE = 'wikidot_tier2';

interface Target extends VoteTarget {
  slug: string;
  cohortAbsOne: boolean;
  cohortConflict: boolean;
  cohortSameRows: boolean;
}

interface MetricRow {
  rating_diff: string;
  abs_one: string;
  l1_more_rows: string;
  v2_more_rows: string;
  same_rows: string;
  conflict_pages: string;
}

interface Options {
  concurrency: number;
  limit: number;
}

function parseArgs(): Options {
  const program = new Command()
    .name('vote-multiplicity-converge')
    .option('--concurrency <n>', '并发数', Number, 4)
    .option('--limit <n>', '请求页硬上限', Number, 600);
  program.parse();
  const opts = program.opts<Options>();
  if (!Number.isInteger(opts.concurrency) || opts.concurrency < 1 || opts.concurrency > 5) {
    throw new RangeError(`concurrency 必须是 1..5，收到 ${opts.concurrency}`);
  }
  if (!Number.isInteger(opts.limit) || opts.limit < 1 || opts.limit > 600) {
    throw new RangeError(`limit 必须是 1..600，收到 ${opts.limit}`);
  }
  return opts;
}

async function loadTargets(pool: ReturnType<typeof createPool>, limit: number): Promise<Target[]> {
  const result = await query<{
    page_id: number;
    wikidot_id: number;
    slug: string;
    claimed_total: number;
    claimed_rating: number;
    cohort_abs_one: boolean;
    cohort_conflict: boolean;
    cohort_same_rows: boolean;
  }>(
    pool,
    'multi:targets',
    `WITH vote_rows AS (
       SELECT page_id,count(*)::int AS rows FROM serve.vote_current GROUP BY page_id
     ), latest_scan AS (
       SELECT DISTINCT ON (page_id) page_id,status,error
         FROM meta.page_scan
        WHERE kind='votes'
        ORDER BY page_id,scanned_at DESC
     ), candidates AS (
       SELECT pc.page_id,pc.wikidot_id,pc.slug,
              ips.last_l1_rating_votes AS claimed_total,
              ips.last_l1_rating AS claimed_rating,
              abs(pc.rating-ips.last_l1_rating)=1 AS cohort_abs_one,
              COALESCE(ls.status='failed' AND ls.error ~
                '同时出现.*[+＋]/[−-]|identity_direction_conflict|identity_conflict',false)
                AS cohort_conflict,
              COALESCE(vr.rows,0)=ips.last_l1_rating_votes AS cohort_same_rows
         FROM serve.page_current pc
         JOIN meta.incremental_page_state ips ON ips.page_id=pc.page_id
         LEFT JOIN vote_rows vr ON vr.page_id=pc.page_id
         LEFT JOIN latest_scan ls ON ls.page_id=pc.page_id
        WHERE pc.status='live'
          AND ips.last_l1_rating IS NOT NULL
          AND ips.last_l1_rating_votes IS NOT NULL
          AND (pc.rating<>ips.last_l1_rating OR (
            ls.status='failed' AND ls.error ~
              '同时出现.*[+＋]/[−-]|identity_direction_conflict|identity_conflict'
          ))
     )
     SELECT * FROM candidates
      ORDER BY cohort_conflict DESC,cohort_abs_one DESC,page_id
      LIMIT $1`,
    [limit],
  );
  return result.rows.map((row) => ({
    pageId: Number(row.page_id),
    wikidotId: Number(row.wikidot_id),
    slug: row.slug,
    claimedTotal: Number(row.claimed_total),
    claimedRating: Number(row.claimed_rating),
    cohortAbsOne: row.cohort_abs_one,
    cohortConflict: row.cohort_conflict,
    cohortSameRows: row.cohort_same_rows,
  }));
}

async function metrics(pool: ReturnType<typeof createPool>): Promise<Record<string, number>> {
  const result = await query<MetricRow>(
    pool,
    'multi:metrics',
    `WITH vote_rows AS (
       SELECT page_id,count(*)::int AS rows FROM serve.vote_current GROUP BY page_id
     ), aligned AS (
       SELECT pc.page_id,pc.rating,ips.last_l1_rating,ips.last_l1_rating_votes,
              COALESCE(vr.rows,0) AS local_rows
         FROM serve.page_current pc
         JOIN meta.incremental_page_state ips ON ips.page_id=pc.page_id
         LEFT JOIN vote_rows vr ON vr.page_id=pc.page_id
        WHERE pc.status='live' AND ips.last_l1_rating IS NOT NULL
          AND ips.last_l1_rating_votes IS NOT NULL
     ), latest_scan AS (
       SELECT DISTINCT ON (page_id) page_id,status,error
         FROM meta.page_scan WHERE kind='votes'
        ORDER BY page_id,scanned_at DESC
     )
     SELECT count(*) FILTER (WHERE rating<>last_l1_rating)::text AS rating_diff,
            count(*) FILTER (WHERE abs(rating-last_l1_rating)=1)::text AS abs_one,
            count(*) FILTER (WHERE rating<>last_l1_rating AND last_l1_rating_votes>local_rows)::text AS l1_more_rows,
            count(*) FILTER (WHERE rating<>last_l1_rating AND last_l1_rating_votes<local_rows)::text AS v2_more_rows,
            count(*) FILTER (WHERE rating<>last_l1_rating AND last_l1_rating_votes=local_rows)::text AS same_rows,
            (SELECT count(*)::text FROM latest_scan WHERE status='failed' AND error ~
              '同时出现.*[+＋]/[−-]|identity_direction_conflict|identity_conflict') AS conflict_pages
       FROM aligned`,
  );
  const row = result.rows[0]!;
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, Number(value)]));
}

async function main(): Promise<void> {
  const opts = parseArgs();
  const config = loadConfig();
  const pool = createPool(config.databaseUrl, { max: opts.concurrency + 2 });
  const http = new HttpClient({
    userAgent: config.userAgent,
    referer: config.referer,
    proxyUrl: config.proxyUrl,
    timeoutMs: config.httpTimeoutMs,
    maxAttempts: Math.max(3, config.httpMaxAttempts),
    breaker503: config.breaker503,
    breakerReset: config.breakerReset,
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
  let runId: number | null = null;
  const counters = { processed: 0, ok: 0, partial: 0, failed: 0 };
  try {
    http.assertHeaders();
    await assertTimezoneRoundTrip(pool);
    const before = await metrics(pool);
    const targets = await loadTargets(pool, opts.limit);
    if (targets.length >= opts.limit) {
      throw new Error(`目标达到硬上限 ${opts.limit}，拒绝静默截断`);
    }
    runId = await startIngestRun(pool, SOURCE, startedAt);
    for (const [index, batch] of chunk(targets, 50).entries()) {
      const outcomes = await collectVoteSnapshots(
        http, config.siteBaseUrl, batch, opts.concurrency,
      );
      await mapWithConcurrency(batch, opts.concurrency, async (target) => {
        const outcome = outcomes.get(target.pageId) ?? {
          status: 'failed' as const,
          error: '收敛结果 Map 缺项',
        };
        try {
          if (outcome.data === undefined) {
            await recordVoteScanFailure(pool,target,runId,
              outcome.status==='failed' ? outcome.error : '投票结果缺 data');
            counters.failed++;
          } else {
            const applied = await applyCollectedVoteSnapshot(
              pool,outcome,runId,new Date().toISOString(),
            );
            if (applied.scanStatus==='ok') counters.ok++;
            else if (applied.scanStatus==='partial') counters.partial++;
            else counters.failed++;
          }
        } catch (error) {
          await recordVoteScanFailure(pool,target,runId,String(error));
          counters.failed++;
        } finally {
          counters.processed++;
        }
      });
      log.info('MULTI 收敛进度', {
        batch: index + 1,
        batches: Math.ceil(targets.length / 50),
        total: targets.length,
        ...counters,
      });
      if (http.breakerOpen) throw new Error(`HTTP breaker: ${http.breakerReason ?? 'unknown'}`);
    }
    const after = await metrics(pool);
    const status = counters.failed > 0 ? 'partial' : 'ok';
    await finishIngestRun(pool,runId,{
      status,
      finishedAt:new Date().toISOString(),
      pagesEnumerated:counters.processed,
      remoteTotal:targets.length,
      remoteTotalSource:'listpages_total',
      batchesTotal:targets.length,
      batchesFailed:counters.failed,
      evaluateParseHealth:false,
      stats:{mode:'vote_multiplicity_converge',before,after,counters,http:http.stats()},
    });
    emitSummary({
      ok:true,status,runId,
      targetPages:targets.length,
      cohorts:{
        absOne:targets.filter((row)=>row.cohortAbsOne).length,
        conflicts:targets.filter((row)=>row.cohortConflict).length,
        sameRows:targets.filter((row)=>row.cohortSameRows).length,
      },
      counters,before,after,http:http.stats(),httpHealth:http.healthStats(),
    });
  } finally {
    http.close();
    await pool.end();
  }
}

main().catch((error) => {
  log.error('MULTI 收敛失败',{error:String(error)});
  emitSummary({ok:false,error:String(error)});
  process.exitCode=1;
});
