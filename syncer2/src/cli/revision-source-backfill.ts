/**
 * 存活页源码修订全文回填。
 *
 * --pilot 固定抓 1,000 个 PageSource：逐条 sha256 内容寻址入库、回填 source_sha，
 * 再从 content_blob 回读做 UTF-8 逐字节比较；其中 100 个当前版本额外与
 * ViewSourceModule 逐字节交叉验证。默认长跑为单并发、最多 4 req/s 的短进程。
 */

import { redirectConsoleToStderr, createLogger, emitSummary } from '../util/log.js';

redirectConsoleToStderr();

import { createHash } from 'node:crypto';
import { statfs } from 'node:fs/promises';
import os from 'node:os';
import { Command } from 'commander';
import type { Pool } from 'pg';

import {
  scanRevisionSourcesOnDemand,
  scanSources,
  type RevisionSourceSnapshot,
  type SourceSnapshot,
} from '../collect/source.js';
import { loadConfig } from '../config.js';
import { amcProbePolicyFor, assertEgressContract, parseProbePolicy } from '../http/amc.js';
import {
  businessTransportFailureRate,
  CircuitOpenError,
  HttpClient,
} from '../http/client.js';
import {
  evaluateAdaptiveSelfProtection,
  PostgresAdaptiveEgressGate,
} from '../http/adaptiveEgress.js';
import { assertTimezoneRoundTrip, createPool, query } from '../store/db.js';
import { finishIngestRun, startIngestRun } from '../store/meta.js';
import {
  applyAdaptiveSelfProtectionToRunHealth,
  evaluateRunHealth,
} from '../work/runHealth.js';
import {
  applyStoredRevisionSource,
  activeRevisionSourceWriteFreezes,
  assertPilotPassed,
  classifyRevisionSourceFailure,
  claimRevisionSourceJobs,
  finishRevisionSourceJob,
  loadPilotCandidates,
  loadRevisionSourceStorageStats,
  loadStoredRevisionSource,
  prepareRevisionSourceText,
  noteRevisionSourceFreezeSkip,
  realtimeCollectionActive,
  recordRevisionSourcePageScan,
  recoverStaleRevisionSourceJobs,
  refreshRevisionSourceProgress,
  releaseRevisionSourceClaims,
  REVISION_SOURCE_DOMAIN,
  REVISION_SOURCE_MODE,
  REVISION_SOURCE_POPULATION,
  REVISION_SOURCE_VERSION,
  seedRevisionSourceJobs,
  skipDeletedRevisionSourceJobs,
  writePilotGate,
  type ApplyRevisionSourceResult,
  type RevisionSourceCandidate,
  type RevisionSourceStorageStats,
  type StoredRevisionSource,
} from '../store/revisionSource.js';
import {
  addRuntimeBudgetOption,
  abortableSleep,
  isRuntimeBudgetExceededError,
  parseRuntimeBudgetSec,
  RuntimeBudget,
} from '../util/runtimeBudget.js';

const log = createLogger('revision-source-backfill');
const SOURCE = 'wikidot_tier2';
const PILOT_COUNT = 1_000;
const PILOT_CURRENT_CROSSCHECKS = 100;
const GIB = 1024 ** 3;

interface CliOptions {
  pilot: boolean;
  limit: number;
  seedLimit: number;
  delayMs: number;
  maxRuntimeSec: number;
  minimumFreeGb: number;
  skipTzCheck: boolean;
  amcProbe?: string;
  proxyCheck?: string;
}

interface PageEvidence {
  claimed: number;
  fetched: number;
  errors: string[];
  hashes: string[];
}

interface Counters {
  selected: number;
  processed: number;
  stored: number;
  blobsInserted: number;
  deduped: number;
  exactMatches: number;
  currentCrosschecks: number;
  retries: number;
  irreconcilable: number;
  failed: number;
  /** PGF01 是我方状态，不进入 processed/failed、退避或任何健康指标分母。 */
  writeFreezeSkipped: number;
  skippedDeleted: number;
  staleRecovered: number;
  resumedFromStorage: number;
  sourceBytes: number;
  responseBytes: number;
  textSanitized: number;
  nulCodeUnitsSanitized: number;
  loneSurrogatesSanitized: number;
}

class RequestPacer {
  #lastStarted = 0;

  constructor(
    private readonly minimumGapMs: number,
    private readonly signal?: AbortSignal,
  ) {}

  async wait(): Promise<void> {
    const wait = this.#lastStarted + this.minimumGapMs - Date.now();
    if (wait > 0) await abortableSleep(wait, this.signal);
    this.#lastStarted = Date.now();
  }
}

function bytesEqual(a: string, b: string): boolean {
  return Buffer.from(a, 'utf8').equals(Buffer.from(b, 'utf8'));
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function evidenceFor(map: Map<number, PageEvidence>, pageId: number): PageEvidence {
  let value = map.get(pageId);
  if (value === undefined) {
    value = { claimed: 0, fetched: 0, errors: [], hashes: [] };
    map.set(pageId, value);
  }
  return value;
}

async function fetchFullSource(
  http: HttpClient,
  baseUrl: string,
  row: RevisionSourceCandidate,
  pacer: RequestPacer,
): Promise<RevisionSourceSnapshot> {
  await pacer.wait();
  const result = await scanRevisionSourcesOnDemand(
    http,
    baseUrl,
    [
      {
        pageId: row.pageId,
        wikidotId: row.wikidotId,
        revisionId: row.wikidotRevisionId,
      },
    ],
    1,
  );
  const source = result.get(row.wikidotRevisionId);
  if (source?.status !== 'ok') {
    throw new Error(
      `PageSource revision=${row.wikidotRevisionId} failed: ` +
        (source?.status === 'failed' ? source.error : 'result missing'),
    );
  }
  return source.data;
}

async function fetchCurrentSource(
  http: HttpClient,
  baseUrl: string,
  row: RevisionSourceCandidate,
  pacer: RequestPacer,
): Promise<SourceSnapshot> {
  await pacer.wait();
  const result = await scanSources(
    http,
    baseUrl,
    [{ pageId: row.pageId, wikidotId: row.wikidotId }],
    1,
  );
  const source = result.get(row.pageId);
  if (source?.status !== 'ok') {
    throw new Error(
      `ViewSource page=${row.pageId} failed: ` +
        (source?.status === 'failed' ? source.error : 'result missing'),
    );
  }
  return source.data;
}

function storedValue(
  row: RevisionSourceCandidate,
  snapshot: RevisionSourceSnapshot,
  observedAt: string,
): StoredRevisionSource {
  const prepared = prepareRevisionSourceText(
    snapshot.source,
    `revision_source.source:${row.pageId}:${row.wikidotRevisionId}`,
  );
  return {
    candidate: row,
    source: prepared.source,
    sourceSha256Hex: prepared.sourceSha256Hex,
    responseSha256Hex: snapshot.responseSha256Hex ?? null,
    responseBytes: snapshot.responseBytes ?? null,
    observedAt,
    textSanitization: prepared.sanitation,
  };
}

function addApplied(counters: Counters, applied: ApplyRevisionSourceResult): void {
  counters.processed++;
  counters.stored++;
  counters.sourceBytes += applied.sourceBytes;
  counters.responseBytes += applied.responseBytes ?? 0;
  if (applied.textSanitized) counters.textSanitized++;
  counters.nulCodeUnitsSanitized += applied.nulCodeUnits;
  counters.loneSurrogatesSanitized += applied.loneSurrogates;
  if (applied.blobInserted) counters.blobsInserted++;
  else counters.deduped++;
}

async function availableDiskBytes(): Promise<number> {
  const value = await statfs('/', { bigint: true });
  return Number(value.bavail * value.bsize);
}

async function assertDiskReserve(minimumFreeGb: number): Promise<number> {
  const free = await availableDiskBytes();
  const minimum = minimumFreeGb * GIB;
  if (free < minimum) {
    throw new Error(
      `磁盘余量 ${Math.floor(free / GIB)} GiB < ${minimumFreeGb} GiB，停止全文回填`,
    );
  }
  return free;
}

async function runPilot(args: {
  pool: Pool;
  http: HttpClient;
  baseUrl: string;
  runId: number | null;
  observedAt: string;
  pacer: RequestPacer;
  evidence: Map<number, PageEvidence>;
  counters: Counters;
}): Promise<void> {
  const rows = await loadPilotCandidates(
    args.pool,
    PILOT_COUNT,
    PILOT_CURRENT_CROSSCHECKS,
  );
  args.counters.selected = rows.length;
  const uniqueHashes = new Set<string>();
  let minimumSourceBytes = Number.POSITIVE_INFINITY;
  let maximumSourceBytes = 0;

  for (const row of rows) {
    const pageEvidence = evidenceFor(args.evidence, row.pageId);
    pageEvidence.claimed++;
    try {
      let source: string;
      let sourceShaHex: string;
      const existing = await loadStoredRevisionSource(args.pool, row.revisionSeq);
      if (existing !== null) {
        source = existing.source;
        sourceShaHex = existing.sourceShaHex;
        if (
          sha256Hex(source) !== sourceShaHex ||
          existing.sourceBytes !== Buffer.byteLength(source, 'utf8')
        ) {
          throw new Error(
            `断点 blob/source_sha 自校验不等 page=${row.pageId} revision=${row.wikidotRevisionId}`,
          );
        }
        args.counters.processed++;
        args.counters.stored++;
        args.counters.resumedFromStorage++;
        args.counters.sourceBytes += existing.sourceBytes;
      } else {
        const snapshot = await fetchFullSource(
          args.http,
          args.baseUrl,
          row,
          args.pacer,
        );
        const stored = storedValue(row, snapshot, args.observedAt);
        const applied = await applyStoredRevisionSource(args.pool, stored);
        const readback = await loadStoredRevisionSource(args.pool, row.revisionSeq);
        if (
          readback === null ||
          readback.sourceShaHex !== stored.sourceSha256Hex ||
          readback.sourceBytes !== Buffer.byteLength(stored.source, 'utf8') ||
          !bytesEqual(readback.source, stored.source)
        ) {
          throw new Error(
            `content_blob/source_sha 回读不等 page=${row.pageId} revision=${row.wikidotRevisionId}`,
          );
        }
        source = stored.source;
        sourceShaHex = stored.sourceSha256Hex;
        addApplied(args.counters, applied);
      }

      if (row.isLatest) {
        const current = await fetchCurrentSource(
          args.http,
          args.baseUrl,
          row,
          args.pacer,
        );
        const preparedCurrent = prepareRevisionSourceText(
          current.source,
          `revision_source.current_crosscheck:${row.pageId}`,
        );
        if (
          preparedCurrent.sourceSha256Hex !== sourceShaHex ||
          !bytesEqual(preparedCurrent.source, source)
        ) {
          throw new Error(
            `PageSource/ViewSource 字节不等 page=${row.pageId} revision=${row.wikidotRevisionId}`,
          );
        }
        args.counters.currentCrosschecks++;
      }

      args.counters.exactMatches++;
      uniqueHashes.add(sourceShaHex);
      const sourceBytes = Buffer.byteLength(source, 'utf8');
      minimumSourceBytes = Math.min(minimumSourceBytes, sourceBytes);
      maximumSourceBytes = Math.max(maximumSourceBytes, sourceBytes);
      pageEvidence.fetched++;
      pageEvidence.hashes.push(sourceShaHex);
    } catch (err) {
      const error = String(err);
      pageEvidence.errors.push(`revision=${row.wikidotRevisionId}: ${error}`);
      throw err;
    }
  }

  if (
    args.counters.processed !== PILOT_COUNT ||
    args.counters.exactMatches !== PILOT_COUNT ||
    args.counters.currentCrosschecks !== PILOT_CURRENT_CROSSCHECKS
  ) {
    throw new Error(
      `pilot 计数不闭合 processed=${args.counters.processed} ` +
        `exact=${args.counters.exactMatches} ` +
        `current=${args.counters.currentCrosschecks}/${PILOT_CURRENT_CROSSCHECKS}`,
    );
  }

  await writePilotGate(args.pool, {
    runId: args.runId,
    sampleCount: PILOT_COUNT,
    exactMatches: PILOT_COUNT,
    failedCount: 0,
    passed: true,
    detail: {
      strategy: 'PageSource full text for every eligible revision',
      storageCommitted: true,
      comparison: 'utf8_byte_exact_after_content_blob_readback',
      sampling: {
        historical: PILOT_COUNT - PILOT_CURRENT_CROSSCHECKS,
        currentWithViewSourceCrosscheck: PILOT_CURRENT_CROSSCHECKS,
        distinctPages: args.evidence.size,
        accessibilityPrecondition:
          'current source known and public namespace (slug not deleted:*); long-run still queues every eligible live page',
      },
      sourceBytes: {
        total: args.counters.sourceBytes,
        min: minimumSourceBytes,
        max: maximumSourceBytes,
      },
      responseBytes: args.counters.responseBytes,
      contentAddressing: {
        uniqueHashes: uniqueHashes.size,
        blobsInserted: args.counters.blobsInserted,
        dedupedAgainstExistingOrEarlierPilot: args.counters.deduped,
        resumedFromStorage: args.counters.resumedFromStorage,
        newFetchDedupeRate:
          args.counters.blobsInserted + args.counters.deduped === 0
            ? null
            : args.counters.deduped /
              (args.counters.blobsInserted + args.counters.deduped),
        withinPilotDuplicateRate: 1 - uniqueHashes.size / PILOT_COUNT,
      },
    },
  });
  await query(
    args.pool,
    'revision_source:pilot_progress',
    `INSERT INTO meta.backfill_progress(
       domain, shard, last_page_id, done_count, total_count, updated_at
     )
     VALUES ($1,$2,$3,$4,$4,now())
     ON CONFLICT (domain, shard) DO UPDATE
       SET last_page_id=EXCLUDED.last_page_id, done_count=EXCLUDED.done_count,
           total_count=EXCLUDED.total_count, updated_at=now()`,
    [
      REVISION_SOURCE_DOMAIN,
      `pilot-${REVISION_SOURCE_VERSION}`,
      Math.max(...rows.map((row) => row.pageId)),
      PILOT_COUNT,
    ],
  );
}

async function flushEvidence(
  pool: Pool,
  runId: number | null,
  evidence: ReadonlyMap<number, PageEvidence>,
): Promise<void> {
  for (const [pageId, value] of evidence) {
    await recordRevisionSourcePageScan(pool, {
      runId,
      pageId,
      claimed: value.claimed,
      fetched: value.fetched,
      errors: value.errors,
      resultHashes: value.hashes,
    });
  }
}

function parseArgs(): CliOptions {
  const program = new Command()
    .name('revision-source-backfill')
    .description('存活页历史源码：每个 eligible revision 抓取并保存 PageSource 全文')
    .option('--pilot', '执行 1,000 条抓取/落库/回读门禁；失败绝不开放长跑')
    .option('--limit <n>', '长跑本轮最多处理的修订数', Number, 100)
    .option('--seed-limit <n>', '本轮最多补入的 job 元数据数', Number, 5_000)
    .option('--delay-ms <n>', '逻辑 HTTP 请求最小间隔；250ms=最多4 req/s', Number, 250)
    .option('--minimum-free-gb <n>', '根文件系统余量低于此值立即停手', Number, 100)
    .option('--skip-tz-check', '仅本地诊断：跳过数据库时区回环')
    .option('--amc-probe <policy>', 'require | warn | skip')
    .option('--proxy-check <policy>', 'require | warn | skip');
  addRuntimeBudgetOption(program, {
    defaultSec: 240,
    minSec: 1,
    maxSec: 3_600,
    description: '长跑时间预算；调度默认需避开下一轮 L0',
  });
  program.parse();
  const raw = program.opts<CliOptions>();
  for (const [name, value, min, max] of [
    ['limit', raw.limit, 1, 20_000],
    ['seed-limit', raw.seedLimit, 1, 500_000],
    ['delay-ms', raw.delayMs, 250, 60_000],
    ['minimum-free-gb', raw.minimumFreeGb, 100, 10_000],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < min || value > max) {
      throw new RangeError(`--${name} 必须是 ${min}..${max} 整数，收到 ${value}`);
    }
  }
  return {
    ...raw,
    maxRuntimeSec: parseRuntimeBudgetSec(raw.maxRuntimeSec, { minSec: 1, maxSec: 3_600 }),
  };
}

function storageDelta(
  before: RevisionSourceStorageStats,
  after: RevisionSourceStorageStats,
): Record<string, number> {
  return {
    databaseBytes: after.databaseBytes - before.databaseBytes,
    contentBlobRelationBytes:
      after.contentBlobRelationBytes - before.contentBlobRelationBytes,
    done: after.done - before.done,
    sourceBytes: after.sourceBytes - before.sourceBytes,
    responseBytes: after.responseBytes - before.responseBytes,
    blobsInserted: after.blobsInserted - before.blobsInserted,
  };
}

async function main(): Promise<void> {
  const opts = parseArgs();
  const config = loadConfig();
  const observedAt = new Date().toISOString();
  const startedMs = Date.now();
  const budget = new RuntimeBudget(opts.maxRuntimeSec);
  const workerId = `${os.hostname()}:${process.pid}:revision-source`;
  const pool = createPool(config.databaseUrl, { max: 4 });
  const http = new HttpClient({
    userAgent: config.userAgent,
    referer: config.referer,
    proxyUrl: config.proxyUrl,
    timeoutMs: config.httpTimeoutMs,
    maxAttempts: Math.max(3, config.httpMaxAttempts),
    breaker503: Math.max(5, config.breaker503),
    breakerReset: Math.max(5, config.breakerReset),
    connections: 1,
    signal: budget.signal,
    logger: log.child('http'),
    adaptiveEgress: new PostgresAdaptiveEgressGate(config.databaseUrl, 'revision-source'),
    egress: {
      probeUrl: config.exitIpProbeUrl,
      everyNRequests: config.exitIpProbeEvery,
      maxProbes: config.exitIpProbeMax,
      mihomoApi: config.mihomoApi,
      hostFilter: new URL(config.siteBaseUrl).host,
    },
  });
  const pacer = new RequestPacer(opts.delayMs, budget.signal);
  const evidence = new Map<number, PageEvidence>();
  const counters: Counters = {
    selected: 0,
    processed: 0,
    stored: 0,
    blobsInserted: 0,
    deduped: 0,
    exactMatches: 0,
    currentCrosschecks: 0,
    retries: 0,
    irreconcilable: 0,
    failed: 0,
    writeFreezeSkipped: 0,
    skippedDeleted: 0,
    staleRecovered: 0,
    resumedFromStorage: 0,
    sourceBytes: 0,
    responseBytes: 0,
    textSanitized: 0,
    nulCodeUnitsSanitized: 0,
    loneSurrogatesSanitized: 0,
  };
  let runId: number | null = null;
  let stopping = false;
  let pilotGateWritten = false;
  let eligible = 0;
  let activeRevisionSeq: number | null = null;
  let startStorage: RevisionSourceStorageStats | null = null;
  let endStorage: RevisionSourceStorageStats | null = null;
  let diskFreeStart = 0;
  let diskFreeEnd = 0;
  let diskStopped = false;
  const stop = (): void => {
    stopping = true;
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);

  try {
    if (opts.skipTzCheck) log.warn('--skip-tz-check 仅限诊断，正式调度禁止');
    else await assertTimezoneRoundTrip(pool);
    diskFreeStart = await assertDiskReserve(opts.minimumFreeGb);
    startStorage = await loadRevisionSourceStorageStats(pool);
    runId = await startIngestRun(pool, SOURCE, observedAt);

    const active = await realtimeCollectionActive(pool);
    if (active.length > 0) {
      const stats = {
        mode: REVISION_SOURCE_MODE,
        population_type: REVISION_SOURCE_POPULATION,
        skipped: 'l0_l1_active',
        active,
      };
      await finishIngestRun(pool, runId, {
        status: 'ok',
        finishedAt: new Date().toISOString(),
        pagesEnumerated: 0,
        remoteTotal: null,
        remoteTotalSource: 'unknown',
        batchesTotal: 0,
        batchesFailed: 0,
        transportFailureRate: null,
        populationType: REVISION_SOURCE_POPULATION,
        stats,
      });
      emitSummary({ ok: true, status: 'skipped', ...stats });
      return;
    }

    const activeWriteFreezes = await activeRevisionSourceWriteFreezes(pool);
    if (activeWriteFreezes.length > 0) {
      const reason = `write_freeze_active:${activeWriteFreezes.join(',')}`;
      const stats = {
        mode: REVISION_SOURCE_MODE,
        population_type: REVISION_SOURCE_POPULATION,
        skipped: reason,
        healthExclusions: { write_freeze: 0 },
      };
      await finishIngestRun(pool, runId, {
        status: 'aborted',
        finishedAt: new Date().toISOString(),
        pagesEnumerated: 0,
        remoteTotal: null,
        remoteTotalSource: 'unknown',
        batchesTotal: 0,
        batchesFailed: 0,
        transportFailureRate: null,
        populationType: REVISION_SOURCE_POPULATION,
        healthDecisionSkipReason: reason,
        stats,
      });
      emitSummary({ ok: true, status: 'skipped', ...stats });
      return;
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

    if (opts.pilot) {
      await runPilot({
        pool,
        http,
        baseUrl: config.siteBaseUrl,
        runId,
        observedAt,
        pacer,
        evidence,
        counters,
      });
      pilotGateWritten = true;
    } else {
      await assertPilotPassed(pool);
      counters.staleRecovered = await recoverStaleRevisionSourceJobs(pool);
      counters.skippedDeleted = await skipDeletedRevisionSourceJobs(pool);
      const seeded = await seedRevisionSourceJobs(pool, opts.seedLimit);
      eligible = seeded.eligible;
      log.info('低优先全文队列已准备', {
        ...seeded,
        staleRecovered: counters.staleRecovered,
        skippedDeleted: counters.skippedDeleted,
      });

      while (
        counters.processed < opts.limit &&
        !budget.checkpoint() &&
        !stopping &&
        !http.breakerOpen
      ) {
        if (counters.processed % 100 === 0) {
          const free = await availableDiskBytes();
          if (free < opts.minimumFreeGb * GIB) {
            diskStopped = true;
            log.error('磁盘低水位，停止认领新 job', {
              freeGiB: free / GIB,
              minimumFreeGiB: opts.minimumFreeGb,
            });
            break;
          }
        }
        const claimed = await claimRevisionSourceJobs(pool, 1, workerId);
        const row = claimed[0];
        if (row === undefined) break;
        activeRevisionSeq = row.revisionSeq;
        counters.selected++;
        const pageEvidence = evidenceFor(evidence, row.pageId);
        pageEvidence.claimed++;
        try {
          const snapshot = await fetchFullSource(
            http,
            config.siteBaseUrl,
            row,
            pacer,
          );
          const stored = storedValue(row, snapshot, observedAt);
          const applied = await applyStoredRevisionSource(pool, stored);
          await finishRevisionSourceJob(pool, row, workerId, {
            status: 'done',
            sourceShaHex: applied.sourceShaHex,
            sourceBytes: applied.sourceBytes,
            responseBytes: applied.responseBytes,
            blobInserted: applied.blobInserted,
          });
          activeRevisionSeq = null;
          addApplied(counters, applied);
          pageEvidence.fetched++;
          pageEvidence.hashes.push(applied.sourceShaHex);
        } catch (err) {
          if (isRuntimeBudgetExceededError(err)) {
            pageEvidence.claimed = Math.max(0, pageEvidence.claimed - 1);
            await releaseRevisionSourceClaims(pool, [row.revisionSeq], workerId);
            activeRevisionSeq = null;
            break;
          }
          const error = String(err);
          if (pgCode(err) === 'PGF01') {
            pageEvidence.claimed = Math.max(0, pageEvidence.claimed - 1);
            if (
              pageEvidence.claimed === 0 &&
              pageEvidence.fetched === 0 &&
              pageEvidence.errors.length === 0 &&
              pageEvidence.hashes.length === 0
            ) {
              evidence.delete(row.pageId);
            }
            await releaseRevisionSourceClaims(
              pool,
              [row.revisionSeq],
              workerId,
            );
            await noteRevisionSourceFreezeSkip(pool, runId, row, error).catch(
              (noteErr) =>
                log.error('源码回填冻结证据补写失败', {
                  revisionSeq: row.revisionSeq,
                  error: String(noteErr),
                }),
            );
            activeRevisionSeq = null;
            counters.writeFreezeSkipped++;
            // 同一 worker 的后续 job 会撞同一个闸；停在当前边界，等 release_writes。
            break;
          }
          const action = await finishRevisionSourceJob(pool, row, workerId, {
            status: 'failed',
            error,
            disposition: classifyRevisionSourceFailure(error),
            resultHashHex: createHash('sha256').update(error).digest('hex'),
          });
          activeRevisionSeq = null;
          counters.processed++;
          counters.failed++;
          if (action === 'retry') counters.retries++;
          else counters.irreconcilable++;
          pageEvidence.errors.push(`revision=${row.wikidotRevisionId}: ${error}`);
          if (http.breakerOpen) break;
        }
      }
      await refreshRevisionSourceProgress(pool, eligible);
    }

    await flushEvidence(pool, runId, evidence);
    diskFreeEnd = await availableDiskBytes();
    endStorage = await loadRevisionSourceStorageStats(pool);
    const baseHealth = evaluateRunHealth({
      claimed: counters.processed + counters.writeFreezeSkipped,
      processed: counters.processed,
      partial: 0,
      failed: counters.failed,
      deterministicFailures: counters.irreconcilable,
      deferred:
        counters.writeFreezeSkipped
        + Number(diskStopped)
        + Number(budget.stoppedByRuntimeBudget),
      breakerOpen: http.breakerOpen,
    });
    const adaptiveState = http.stats().adaptiveEgress?.state ?? null;
    const health = adaptiveState === null
      ? baseHealth
      : applyAdaptiveSelfProtectionToRunHealth(
          baseHealth,
          evaluateAdaptiveSelfProtection(adaptiveState, Date.now()),
        );
    const parseDropRate =
      counters.processed === 0 ? null : counters.failed / counters.processed;
    const elapsedSec = (Date.now() - startedMs) / 1_000;
    const stats = {
      mode: REVISION_SOURCE_MODE,
      population_type: REVISION_SOURCE_POPULATION,
      pilot: opts.pilot,
      version: REVISION_SOURCE_VERSION,
      delayMs: opts.delayMs,
      ...counters,
      elapsedSec,
      revisionsPerSecond:
        elapsedSec === 0 ? 0 : counters.processed / elapsedSec,
      dedupeRate:
        counters.blobsInserted + counters.deduped === 0
          ? null
          : counters.deduped / (counters.blobsInserted + counters.deduped),
      byKind: {
        revisions_full: { claimed: counters.processed },
        content: { claimed: counters.stored },
      },
      storage: {
        before: startStorage,
        after: endStorage,
        delta:
          startStorage === null || endStorage === null
            ? null
            : storageDelta(startStorage, endStorage),
      },
      disk: {
        freeStartBytes: diskFreeStart,
        freeEndBytes: diskFreeEnd,
        deltaBytes: diskFreeEnd - diskFreeStart,
        minimumFreeBytes: opts.minimumFreeGb * GIB,
        stoppedAtLowWatermark: diskStopped,
      },
      http: http.stats(),
      httpHealth: http.healthStats(),
      startupProbe,
      stoppedBySignal: stopping,
      timeBudgetReached: budget.checkpoint(),
      ...budget.summary(),
      healthExclusions: {
        write_freeze: counters.writeFreezeSkipped,
        deterministic_failures: counters.irreconcilable,
      },
      health,
    };
    const parseHealth = await finishIngestRun(pool, runId, {
      status: health.status,
      finishedAt: new Date().toISOString(),
      pagesEnumerated: counters.processed,
      remoteTotal: opts.pilot ? PILOT_COUNT : eligible || null,
      remoteTotalSource: 'unknown',
      batchesTotal: http.healthStats().business.requests,
      batchesFailed: health.retryableFailures,
      transportFailureRate: businessTransportFailureRate(http),
      exitIpStats: http.exitIpStats() as unknown as Record<string, unknown>,
      parseFingerprint: {
        // 兼容历史字段名；此值是“任务失败率”而非纯解析丢行率，本 population 已只留证。
        parse_drop_rate: parseDropRate,
        revision_source_failure_rate: parseDropRate,
        http_status_dist: http.healthStats().business.statusBuckets,
        transport_failure_rate: businessTransportFailureRate(http),
        sample_counts: {
          parse_drop_rate: counters.processed,
          http_status_dist: http.healthStats().business.requests,
          transport_failure_rate: http.healthStats().business.requests,
        },
      },
      populationType: REVISION_SOURCE_POPULATION,
      healthDecisionSkipReason:
        counters.writeFreezeSkipped > 0 && counters.processed === 0
          ? 'write_freeze_only'
          : null,
      stats,
    });
    emitSummary({
      ok: health.exitCode === 0,
      status: health.status,
      health,
      runId,
      ...counters,
      version: REVISION_SOURCE_VERSION,
      elapsedSec,
      dedupeRate:
        counters.blobsInserted + counters.deduped === 0
          ? null
          : counters.deduped / (counters.blobsInserted + counters.deduped),
      diskFreeGiB: diskFreeEnd / GIB,
      storageDelta:
        startStorage === null || endStorage === null
          ? null
          : storageDelta(startStorage, endStorage),
      parseHealth,
      http: http.stats(),
      ...budget.summary(),
    });
    process.exitCode = health.exitCode;
  } catch (err) {
    const runtimeBudget = isRuntimeBudgetExceededError(err);
    if (runtimeBudget) budget.checkpoint();
    const error = String(err);
    if (!runtimeBudget) counters.failed++;
    if (!runtimeBudget && opts.pilot && !pilotGateWritten) {
      await writePilotGate(pool, {
        runId,
        sampleCount: counters.selected,
        exactMatches: counters.exactMatches,
        failedCount: 1,
        passed: false,
        detail: {
          error,
          stoppedBeforeLongRun: true,
          storageCommittedForSuccessfulPrefix: counters.stored,
          currentCrosschecks: counters.currentCrosschecks,
        },
      }).catch((gateErr) =>
        log.error('pilot 失败门禁留证也失败', { error: String(gateErr) }),
      );
    }
    await flushEvidence(pool, runId, evidence).catch((scanErr) =>
      log.error('失败 page_scan 留证失败', { error: String(scanErr) }),
    );
    const breaker = err instanceof CircuitOpenError || http.breakerOpen;
    const baseHealth = evaluateRunHealth({
      claimed: Math.max(1, counters.processed),
      processed: counters.processed,
      partial: runtimeBudget ? 1 : 0,
      failed: runtimeBudget ? counters.failed : Math.max(1, counters.failed),
      deterministicFailures: Math.min(counters.irreconcilable, Math.max(1, counters.failed)),
      deferred: runtimeBudget ? 1 : 0,
      breakerOpen: breaker,
      fatalReasons: breaker || runtimeBudget ? [] : ['revision_source_exception'],
    });
    const adaptiveState = http.stats().adaptiveEgress?.state ?? null;
    const health = adaptiveState === null
      ? baseHealth
      : applyAdaptiveSelfProtectionToRunHealth(
          baseHealth,
          evaluateAdaptiveSelfProtection(adaptiveState, Date.now()),
        );
    await finishIngestRun(pool, runId, {
      status: health.status,
      finishedAt: new Date().toISOString(),
      pagesEnumerated: counters.processed,
      remoteTotal: opts.pilot ? PILOT_COUNT : eligible || null,
      remoteTotalSource: 'unknown',
      batchesTotal: http.healthStats().business.requests,
      batchesFailed: runtimeBudget ? counters.failed : Math.max(1, counters.failed),
      transportFailureRate: businessTransportFailureRate(http),
      populationType: REVISION_SOURCE_POPULATION,
      parseFingerprint: {
        parse_drop_rate:
          counters.processed === 0 ? null : counters.failed / counters.processed,
        revision_source_failure_rate:
          counters.processed === 0 ? null : counters.failed / counters.processed,
        http_status_dist: http.healthStats().business.statusBuckets,
        transport_failure_rate: businessTransportFailureRate(http),
      },
      stats: {
        mode: REVISION_SOURCE_MODE,
        population_type: REVISION_SOURCE_POPULATION,
        pilot: opts.pilot,
        version: REVISION_SOURCE_VERSION,
        error,
        breaker,
        health,
        ...counters,
        byKind: {
          revisions_full: { claimed: counters.processed },
          content: { claimed: counters.stored },
        },
        http: http.stats(),
        ...budget.summary(),
      },
    }).catch((finishErr) =>
      log.error('失败 ingest_run 收尾也失败', { error: String(finishErr) }),
    );
    emitSummary({
      ok: health.exitCode === 0,
      status: health.status,
      error,
      health,
      ...counters,
      ...budget.summary(),
    });
    process.exitCode = health.exitCode;
  } finally {
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
    if (activeRevisionSeq !== null) {
      await releaseRevisionSourceClaims(pool, [activeRevisionSeq], workerId).catch(
        (releaseErr) =>
          log.error('释放未完成 revision source claim 失败', {
            revisionSeq: activeRevisionSeq,
            error: String(releaseErr),
          }),
      );
    }
    await http.close();
    await pool.end().catch(() => undefined);
  }
}

await main();

function pgCode(err: unknown): string | null {
  return typeof err === 'object' &&
    err !== null &&
    typeof (err as { code?: unknown }).code === 'string'
    ? String((err as { code: string }).code)
    : null;
}
