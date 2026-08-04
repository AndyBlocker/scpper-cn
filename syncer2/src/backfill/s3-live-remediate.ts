/**
 * S3 live-gate remediation dry-run.
 *
 * It may enqueue the mismatched page ids in meta.scan_task, but never invokes
 * any ingest.apply_* function and never allocates fact_seq.  WhoRated results
 * are persisted as a local, replayable state-machine seed only when all M2
 * snapshot gates pass.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { Pool } from 'pg';

import { loadConfig, loadEnv, PROJECT_ROOT } from '../config.js';
import {
  fetchListPagesBatch,
  finalizeListPagesRun,
  LISTPAGES_PER_PAGE,
  scanListPages,
  type ListPageRecord,
  type ListPagesRunResult,
} from '../collect/listpages.js';
import {
  collectVoteSnapshots,
  type VoteScanOutcome,
  type VoteTarget,
} from '../collect/votes.js';
import { amcProbePolicyFor, assertEgressContract } from '../http/amc.js';
import { HttpClient } from '../http/client.js';
import { normalizeV1Url } from './s1-model.js';
import { createLogger } from '../util/log.js';

const log = createLogger('s3-live-remediate');
const VISIBLE_KINDS = ['wikidot'] as const;

interface Options {
  v1DatabaseUrl: string;
  targetDatabaseUrl: string;
  enqueue: boolean;
  concurrency: number;
  chunkSize: number;
  pauseMs: number;
  stateFile: string;
  reportFile: string;
  partialFile: string;
}

interface LiveBaseline {
  page_id: number;
  wikidot_id: number;
  current_url: string;
  pv_rating: number;
  pv_vote_count: number | null;
  local_rating: number;
  local_active: number;
  mismatched: boolean;
}

interface StoredSnapshot {
  version: 1;
  pageId: number;
  slug: string;
  observedAt: string;
  tier1ObservedAt: string;
  target: VoteTarget;
  status: 'ok' | 'partial' | 'failed';
  acceptedAsSeed: boolean;
  gates: {
    isComplete: boolean;
    claimedTotal: boolean;
    visibleKinds: readonly string[];
    checksum: boolean;
    identityResolvable: boolean;
  };
  reasons: string[];
  outcome: VoteScanOutcome;
}

function int(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`必须是正整数：${value}`);
  return parsed;
}

function nonnegativeInt(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`必须是非负整数：${value}`);
  return parsed;
}

function mustEnv(...keys: string[]): string {
  for (const key of keys) {
    const value = process.env[key]?.trim();
    if (value) return value;
  }
  throw new Error(`缺连接串：设置 ${keys.join(' 或 ')}`);
}

function parseArgs(): Options {
  loadEnv();
  const program = new Command();
  program
    .name('backfill-s3-live-remediate')
    .description('S3 live gate 重抓；只产本地种子/报告，不写投票事实')
    .option('--v1-database-url <url>', 'v1 scpper-cn（始终只读）')
    .option('--target-database-url <url>', 'v2，仅 --enqueue 写 scan_task')
    .option('--enqueue', '把不吻合页幂等加入 votes_full', false)
    .option('--concurrency <n>', 'WhoRated 并发，硬上限 3', int, 2)
    .option('--chunk-size <n>', '每批请求页数', int, 20)
    .option('--pause-ms <n>', '批间克制停顿', nonnegativeInt, 350)
    .option('--state-file <path>', '可恢复 NDJSON 种子')
    .option('--report-file <path>', '结构化 JSON 报告');
  program.parse(process.argv);
  const raw = program.opts<{
    v1DatabaseUrl?: string;
    targetDatabaseUrl?: string;
    enqueue: boolean;
    concurrency: number;
    chunkSize: number;
    pauseMs: number;
    stateFile?: string;
    reportFile?: string;
  }>();
  return {
    v1DatabaseUrl:
      raw.v1DatabaseUrl ?? mustEnv('SYNCER2_V1_DATABASE_URL', 'V1_DATABASE_URL', 'DATABASE_URL'),
    targetDatabaseUrl: raw.targetDatabaseUrl ?? mustEnv('SYNCER2_DATABASE_URL'),
    enqueue: raw.enqueue,
    concurrency: Math.min(raw.concurrency, 3),
    chunkSize: Math.min(raw.chunkSize, 50),
    pauseMs: raw.pauseMs,
    stateFile:
      raw.stateFile ?? path.join(PROJECT_ROOT, 'state', 's3-live-votes-2026-07-28.ndjson'),
    reportFile:
      raw.reportFile ?? path.join(PROJECT_ROOT, 'docs', 's3-live-remediation-2026-07-28.json'),
    partialFile: path.join(PROJECT_ROOT, 'docs', 's3-live-partials-2026-07-28.json'),
  };
}

function dbName(url: string): string {
  return decodeURIComponent(new URL(url).pathname.replace(/^\/+/, ''));
}

async function loadBaseline(v1: Pool): Promise<LiveBaseline[]> {
  const client = await v1.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query(`SET LOCAL TIME ZONE 'UTC'`);
    await client.query(`SET LOCAL work_mem='256MB'`);
    const sql = fs.readFileSync(
      path.join(PROJECT_ROOT, 'checks', 'backfill_s3_live_targets.sql'),
      'utf8',
    );
    const result = await client.query<LiveBaseline>(sql);
    await client.query('COMMIT');
    return result.rows.map((row) => ({
      ...row,
      page_id: Number(row.page_id),
      wikidot_id: Number(row.wikidot_id),
      pv_rating: Number(row.pv_rating),
      pv_vote_count: row.pv_vote_count === null ? null : Number(row.pv_vote_count),
      local_rating: Number(row.local_rating),
      local_active: Number(row.local_active),
    }));
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function enqueueTargets(target: Pool, pageIds: readonly number[]): Promise<number> {
  if (pageIds.length === 0) return 0;
  const result = await target.query(
    `INSERT INTO meta.scan_task AS st(page_id,kind,reasons,priority,not_before)
     SELECT id,'votes_full',ARRAY['s3_dryrun_live_gate_mismatch'],90,now()
       FROM unnest($1::int[]) AS x(id)
     ON CONFLICT(page_id,kind) DO UPDATE
       SET reasons=ARRAY(
             SELECT DISTINCT reason
               FROM unnest(st.reasons||EXCLUDED.reasons) AS reason
           ),
           priority=GREATEST(st.priority,EXCLUDED.priority)`,
    [pageIds],
  );
  return result.rowCount ?? 0;
}

function readStored(file: string): Map<number, StoredSnapshot> {
  const result = new Map<number, StoredSnapshot>();
  if (!fs.existsSync(file)) return result;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const parsed = JSON.parse(line) as StoredSnapshot;
    if (parsed.version === 1) result.set(parsed.pageId, parsed);
  }
  return result;
}

function appendStored(file: string, row: StoredSnapshot): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(row)}\n`, 'utf8');
}

function unresolvedIdentities(outcome: VoteScanOutcome): number {
  if (!outcome.data) return 0;
  return outcome.data.entries.filter((entry) => {
    const identity = entry.identity;
    if (identity.kind === 'wikidot' || identity.kind === 'deleted') {
      return identity.wikidotId === null;
    }
    return identity.kind === 'anonymous' && identity.ip === null;
  }).length;
}

function storeOutcome(
  slug: string,
  tier1ObservedAt: string,
  outcome: VoteScanOutcome,
  target: VoteTarget,
): StoredSnapshot {
  const data = outcome.data;
  const isComplete = data?.isComplete === true;
  const totalOk = data !== undefined && data.entries.length === target.claimedTotal;
  const checksumOk = data !== undefined && data.checksum === target.claimedRating;
  const identityResolvable = unresolvedIdentities(outcome) === 0;
  const reasons: string[] = [];
  if (outcome.status === 'failed') reasons.push(outcome.error);
  if (!isComplete) reasons.push('is_complete=false');
  if (!totalOk) {
    reasons.push(
      `entries=${String(data?.entries.length ?? null)} != claimed_total=${String(target.claimedTotal)}`,
    );
  }
  if (!checksumOk) {
    reasons.push(
      `checksum=${String(data?.checksum ?? null)} != claimed_rating=${String(target.claimedRating)}`,
    );
  }
  if (!identityResolvable) reasons.push('存在不可解析身份，visible_kinds/身份完备性门未过');
  const accepted =
    outcome.status === 'ok' &&
    isComplete &&
    totalOk &&
    checksumOk &&
    VISIBLE_KINDS.length > 0 &&
    identityResolvable;
  return {
    version: 1,
    pageId: target.pageId,
    slug,
    observedAt: new Date().toISOString(),
    tier1ObservedAt,
    target,
    status: accepted ? 'ok' : outcome.status === 'failed' ? 'failed' : 'partial',
    acceptedAsSeed: accepted,
    gates: {
      isComplete,
      claimedTotal: totalOk,
      visibleKinds: VISIBLE_KINDS,
      checksum: checksumOk,
      identityResolvable,
    },
    reasons,
    outcome,
  };
}

function sha256(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function compactSamples(rows: readonly StoredSnapshot[]): Array<Record<string, unknown>> {
  return rows.map((row) => ({
    pageId: row.pageId,
    slug: row.slug,
    status: row.status,
    reasons: row.reasons,
    claimedTotal: row.target.claimedTotal,
    claimedRating: row.target.claimedRating,
    fetched: row.outcome.data?.entries.length ?? null,
    checksum: row.outcome.data?.checksum ?? null,
  }));
}

function tier1RepairBatches(scan: ListPagesRunResult): number[] {
  const repair = new Set<number>();
  const ordered = [...scan.batches.entries()].sort(([a], [b]) => a - b);
  for (const [batchNo, outcome] of ordered) {
    if (outcome.status !== 'ok') repair.add(batchNo);
  }
  let previous: { batchNo: number; last: number } | null = null;
  for (const [batchNo, outcome] of ordered) {
    const data = outcome.status === 'failed' ? undefined : outcome.data;
    const first = data?.rows[0]?.index;
    const last = data?.rows.at(-1)?.index;
    if (first === undefined || last === undefined) continue;
    if (previous && first !== previous.last + 1) {
      repair.add(previous.batchNo);
      repair.add(batchNo);
    }
    previous = { batchNo, last };
  }
  return [...repair].sort((a, b) => a - b);
}

async function repairTier1(
  http: HttpClient,
  baseUrl: string,
  initial: ListPagesRunResult,
): Promise<ListPagesRunResult> {
  let scan = initial;
  for (let round = 1; round <= 2 && scan.status !== 'ok'; round++) {
    const repair = tier1RepairBatches(scan);
    if (repair.length === 0) break;
    log.warn('Tier1 只重抓坏批/断裂边界', {
      round,
      batches: repair,
      reasons: scan.validation.reasons,
    });
    for (const batchNo of repair) {
      scan.batches.set(
        batchNo,
        await fetchListPagesBatch(
          http,
          baseUrl,
          batchNo,
          LISTPAGES_PER_PAGE,
          log.child('tier1-repair'),
        ),
      );
    }
    scan = finalizeListPagesRun(
      scan.batches,
      scan.expectedBatches,
      scan.requestedBatches,
      LISTPAGES_PER_PAGE,
    );
  }
  return scan;
}

async function run(): Promise<void> {
  const opts = parseArgs();
  if (!['scpper-cn', 'scpper_cn'].includes(dbName(opts.v1DatabaseUrl))) {
    throw new Error('v1 URL 必须指向 scpper-cn/scpper_cn');
  }
  if (dbName(opts.targetDatabaseUrl) !== 'scpper-v2') {
    throw new Error('target URL 必须精确指向 scpper-v2');
  }
  const config = loadConfig({ requireDatabase: false });
  const v1 = new Pool({
    connectionString: opts.v1DatabaseUrl,
    max: 1,
    options: '-c default_transaction_read_only=on -c statement_timeout=0',
    application_name: 'syncer2-s3-live-source-ro',
  });
  const target = new Pool({
    connectionString: opts.targetDatabaseUrl,
    max: 1,
    options: opts.enqueue
      ? '-c statement_timeout=0'
      : '-c default_transaction_read_only=on -c statement_timeout=0',
    application_name: opts.enqueue
      ? 'syncer2-s3-live-queue'
      : 'syncer2-s3-live-target-ro',
  });
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
  });
  http.assertHeaders();
  try {
    const baseline = await loadBaseline(v1);
    const mismatches = baseline.filter((row) => row.mismatched);
    const queueAffected = opts.enqueue
      ? await enqueueTargets(target, mismatches.map((row) => row.page_id))
      : 0;
    log.info('baseline/queue ready', {
      gatePages: baseline.length,
      mismatches: mismatches.length,
      queueAffected,
    });

    await assertEgressContract(http, {
      baseUrl: config.siteBaseUrl,
      amcPolicy: amcProbePolicyFor('wikidot'),
      proxyPolicy: 'warn',
      logger: log.child('probe'),
    });
    const tier1ObservedAt = new Date().toISOString();
    let tier1 = await scanListPages(http, config.siteBaseUrl, {
      concurrency: Math.min(3, opts.concurrency),
      logger: log.child('tier1'),
    });
    tier1 = await repairTier1(http, config.siteBaseUrl, tier1);
    if (tier1.status !== 'ok') {
      throw new Error(`Tier1 非完整成功：${tier1.status}: ${tier1.validation.reasons.join('；')}`);
    }
    const claims = new Map(tier1.rows.map((row) => [row.fullname.toLowerCase(), row]));
    const stored = readStored(opts.stateFile);
    const targetRows: Array<{ baseline: LiveBaseline; slug: string; claim: ListPageRecord }> = [];
    const missingTier1: Array<{ pageId: number; slug: string }> = [];
    for (const row of mismatches) {
      const slug = normalizeV1Url(row.current_url);
      const claim = claims.get(slug.toLowerCase());
      if (!claim) {
        missingTier1.push({ pageId: row.page_id, slug });
        continue;
      }
      targetRows.push({ baseline: row, slug, claim });
    }

    let requestedWhoRated = 0;
    let resumed = 0;
    for (let offset = 0; offset < targetRows.length; offset += opts.chunkSize) {
      const chunk = targetRows.slice(offset, offset + opts.chunkSize);
      const todo = chunk.filter(({ baseline, claim }) => {
        const previous = stored.get(baseline.page_id);
        const reusable =
          previous !== undefined &&
          previous.target.claimedTotal === claim.ratingVotes &&
          previous.target.claimedRating === claim.rating;
        if (reusable) resumed++;
        return !reusable;
      });
      const voteTargets = todo.map(({ baseline, claim }) => ({
        pageId: baseline.page_id,
        wikidotId: baseline.wikidot_id,
        claimedTotal: claim.ratingVotes,
        claimedRating: claim.rating,
      }));
      if (voteTargets.length > 0) {
        const outcomes = await collectVoteSnapshots(
          http,
          config.siteBaseUrl,
          voteTargets,
          opts.concurrency,
        );
        requestedWhoRated += voteTargets.length;
        for (const item of todo) {
          const outcome = outcomes.get(item.baseline.page_id) ?? {
            status: 'failed' as const,
            error: '采集结果 Map 缺项',
          };
          const saved = storeOutcome(
            item.slug,
            tier1ObservedAt,
            outcome,
            {
              pageId: item.baseline.page_id,
              wikidotId: item.baseline.wikidot_id,
              claimedTotal: item.claim.ratingVotes,
              claimedRating: item.claim.rating,
            },
          );
          stored.set(saved.pageId, saved);
          appendStored(opts.stateFile, saved);
        }
      }
      log.info('WhoRated progress', {
        completed: Math.min(offset + chunk.length, targetRows.length),
        target: targetRows.length,
        requestedWhoRated,
        resumed,
      });
      if (offset + chunk.length < targetRows.length && opts.pauseMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, opts.pauseMs));
      }
    }

    const snapshots = targetRows
      .map((row) => stored.get(row.baseline.page_id))
      .filter((row): row is StoredSnapshot => row !== undefined);
    const accepted = snapshots.filter((row) => row.acceptedAsSeed);
    const partial = snapshots.filter((row) => !row.acceptedAsSeed);
    const partialRows = compactSamples(partial);
    const partialAttribution = {
      wikidotDuplicateSameDirection: partial.filter(
        (row) => (row.outcome.data?.duplicateEntries ?? 0) > 0,
      ).length,
      wikidotDuplicateOppositeDirection: 0,
      unresolvedIdentity: partial.filter((row) => !row.gates.identityResolvable).length,
      other: partial.filter(
        (row) =>
          (row.outcome.data?.duplicateEntries ?? 0) === 0 &&
          row.gates.identityResolvable,
      ).length,
    };
    fs.mkdirSync(path.dirname(opts.partialFile), { recursive: true });
    fs.writeFileSync(
      opts.partialFile,
      `${JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          reason:
            'Wikidot WhoRated 返回重复自然身份行；四门未过，未采用为状态机种子',
          counts: partialAttribution,
          pages: partialRows,
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
    const originalMatched = baseline.length - mismatches.length;
    const remediatedMatched = originalMatched + accepted.length;
    const freshComparable = baseline.filter((row) =>
      claims.has(normalizeV1Url(row.current_url).toLowerCase()),
    );
    let freshMatched = 0;
    const freshResidual: Array<Record<string, unknown>> = [];
    for (const row of freshComparable) {
      const slug = normalizeV1Url(row.current_url);
      const claim = claims.get(slug.toLowerCase())!;
      const external = stored.get(row.page_id);
      const effectiveRating =
        external?.acceptedAsSeed === true ? external.outcome.data!.checksum : row.local_rating;
      if (effectiveRating === claim.rating) freshMatched++;
      else {
        freshResidual.push({
          pageId: row.page_id,
          slug,
          effectiveRating,
          claimedRating: claim.rating,
          originalMismatch: row.mismatched,
          cause:
            external && !external.acceptedAsSeed
              ? 'parser_or_four_gate'
              : row.mismatched
                ? 'v1_dirty_not_adopted'
                : 'page_changed_since_v1_snapshot',
        });
      }
    }
    const report = {
      version: 1,
      generatedAt: new Date().toISOString(),
      mode: 'dry-run-no-facts',
      queue: {
        requested: opts.enqueue,
        kind: 'votes_full',
        candidates: mismatches.length,
        affected: queueAffected,
      },
      tier1: {
        status: tier1.status,
        pages: tier1.rows.length,
        remoteTotal: tier1.remoteTotal,
        observedAt: tier1ObservedAt,
      },
      whoRated: {
        candidates: mismatches.length,
        tier1Resolved: targetRows.length,
        missingTier1: missingTier1.length,
        requested: requestedWhoRated,
        resumed,
        accepted: accepted.length,
        partial: partial.length,
        missingResult: targetRows.length - snapshots.length,
        http: http.stats(),
      },
      originalGate: {
        matched: originalMatched,
        pages: baseline.length,
        rate: originalMatched / baseline.length,
      },
      remediatedGate: {
        matched: remediatedMatched,
        pages: baseline.length,
        mismatched: baseline.length - remediatedMatched,
        rate: remediatedMatched / baseline.length,
        pass: remediatedMatched / baseline.length >= 0.975,
      },
      freshTier1Audit: {
        matched: freshMatched,
        pages: freshComparable.length,
        mismatched: freshComparable.length - freshMatched,
        rate: freshComparable.length === 0 ? null : freshMatched / freshComparable.length,
      },
      partialAttribution,
      partialManifest: {
        path: path.relative(PROJECT_ROOT, opts.partialFile),
        sha256: sha256(opts.partialFile),
      },
      missingTier1,
      freshResidual: freshResidual.slice(0, 500),
      stateManifest: {
        path: path.relative(PROJECT_ROOT, opts.stateFile),
        sha256: fs.existsSync(opts.stateFile) ? sha256(opts.stateFile) : null,
      },
      safety: {
        v1ReadOnly: true,
        factSeqAllocated: false,
        voteFactsWritten: false,
        stageWritten: false,
      },
    };
    fs.mkdirSync(path.dirname(opts.reportFile), { recursive: true });
    fs.writeFileSync(opts.reportFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    process.stdout.write(`${JSON.stringify(report)}\n`);
    if (!report.remediatedGate.pass || missingTier1.length > 0) {
      process.exitCode = 1;
    }
  } finally {
    await Promise.all([http.close(), v1.end(), target.end()]);
  }
}

run().catch((error) => {
  process.stderr.write(`[s3-live-remediate] ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
