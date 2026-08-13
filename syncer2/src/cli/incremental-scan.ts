/**
 * 新分层的 L0/L1 单轮短进程：
 *   L0 = updated_at 窗口内容编辑（默认 last 2 hours）
 *   L1 = 同频四字段全站投票扫描（严格翻完 pager，不早停）
 */

import { redirectConsoleToStderr, createLogger, emitSummary } from '../util/log.js';

redirectConsoleToStderr();

import { createHash } from 'node:crypto';
import { Command } from 'commander';
import type { Pool } from 'pg';

import { diffL0Rows, diffL1Rows } from '../collect/incrementalDiff.js';
import {
  evaluateRevisionRegressionHealth,
  type RevisionRegressionHealth,
} from '../collect/revisionRegression.js';
import {
  scanIncrementalListPages,
  type IncrementalListPagesRun,
  type IncrementalListPagesLayer,
  type L0ListPageRow,
  type L1ListPageRow,
} from '../collect/incrementalListPages.js';
import { loadConfig } from '../config.js';
import { amcProbePolicyFor, assertEgressContract, parseProbePolicy } from '../http/amc.js';
import { CircuitOpenError, HttpClient } from '../http/client.js';
import {
  evaluateAdaptiveSelfProtection,
  observeL1FreshnessSlo,
  PostgresAdaptiveEgressGate,
  type L1FreshnessSloSignal,
} from '../http/adaptiveEgress.js';
import { assertTimezoneRoundTrip, createPool } from '../store/db.js';
import {
  observeL1ProjectionDrift,
  type L1DriftSummary,
} from '../store/drift.js';
import {
  classifyRevisionCoverageBaseline,
  hasL1Baseline,
  insertIncrementalSignals,
  loadIncrementalKnownPopulation,
  loadIncrementalPageStates,
  loadRevisionCoverageWriteFreezeDomains,
  loadSuccessfulL0Bounds,
  recordRevisionCoverage,
  shouldAlertRevisionCoverage,
  upsertL0States,
  upsertL1States,
  upsertRevisionRegressionIdentityStates,
  type RevisionCoverageMetric,
} from '../store/incremental.js';
import {
  enqueueScanTasks,
  finishIngestRun,
  insertPageScans,
  resolveSlugs,
  startIngestRun,
  type ScanTaskRow,
} from '../store/meta.js';
import { upsertPendingPages } from '../store/queues.js';
import {
  advanceDailyL1EnumerationSnapshot,
  l1EnumerationSnapshotPath,
} from '../store/l1EnumerationSnapshot.js';
import {
  applyAdaptiveSelfProtectionToRunHealth,
  evaluateRunHealth,
} from '../work/runHealth.js';
import {
  addRuntimeBudgetOption,
  isRuntimeBudgetExceededError,
  parseRuntimeBudgetSec,
  RuntimeBudget,
} from '../util/runtimeBudget.js';

const log = createLogger('incremental-scan');
const SOURCE = 'wikidot_listpages';
const POPULATION = {
  l0: 'l0_updated_at_window',
  l1: 'l1_full_site_minimal',
} as const;
const MODE = {
  l0: 'l0_content',
  l1: 'l1_votes',
} as const;
// L1 是新投票进入明细抓取的唯一廉价通道；实时变化必须排在历史回填债务之前。
// catch-up/sweep 仍分别使用 20/10，不会因本常量扩大回填流量。
export const L1_VOTE_CHANGE_PRIORITY = 200;

interface CliOptions {
  layer: IncrementalListPagesLayer;
  dryRun: boolean;
  skipTzCheck: boolean;
  concurrency: number;
  windowHours?: number;
  amcProbe?: string;
  proxyCheck?: string;
  maxRuntimeSec: number;
}

interface PersistResult {
  resolved: number;
  unresolved: number;
  pendingEnqueued: number;
  tasksEnqueued: number;
  pageScansWritten: number;
  signalsWritten: number;
  statesAdvanced: number;
  revisionCoverage: RevisionCoverageMetric | null;
  driftReconciliation: L1DriftSummary | null;
  coverageAlert: boolean;
  revisionRegressionHealth: RevisionRegressionHealth;
  systemicPageFailure: boolean;
  counters: Record<string, number | boolean>;
  skipReason?: string;
}

async function main(): Promise<void> {
  const opts = parseArgs();
  const config = loadConfig({ requireDatabase: !opts.dryRun });
  const windowHours = opts.windowHours ?? config.l0WindowHours;
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const budget = new RuntimeBudget(opts.maxRuntimeSec);
  const mode = MODE[opts.layer];
  const populationType = POPULATION[opts.layer];
  const http = new HttpClient({
    userAgent: config.userAgent,
    referer: config.referer,
    proxyUrl: config.proxyUrl,
    timeoutMs: config.httpTimeoutMs,
    maxAttempts: Math.max(3, config.httpMaxAttempts),
    breaker503: Math.max(5, config.breaker503),
    breakerReset: Math.max(5, config.breakerReset),
    connections: opts.concurrency,
    signal: budget.signal,
    logger: log.child('http'),
    adaptiveEgress: new PostgresAdaptiveEgressGate(config.databaseUrl, opts.layer),
    egress: {
      probeUrl: config.exitIpProbeUrl,
      everyNRequests: config.exitIpProbeEvery,
      maxProbes: config.exitIpProbeMax,
      mihomoApi: config.mihomoApi,
      hostFilter: new URL(config.siteBaseUrl).host,
    },
  });
  http.assertHeaders();

  let pool: Pool | null = null;
  let runId: number | null = null;
  let startupProbe: unknown = null;
  let egressSlo: L1FreshnessSloSignal | null = null;
  try {
    if (!opts.dryRun) {
      pool = createPool(config.databaseUrl, { max: Math.max(4, opts.concurrency) });
      if (opts.skipTzCheck) {
        log.warn('--skip-tz-check 仅限本地诊断，正式调度禁止');
      } else {
        await assertTimezoneRoundTrip(pool);
      }
      runId = await startIngestRun(pool, SOURCE, startedAt);
      if (opts.layer === 'l1') {
        egressSlo = await observeL1FreshnessSlo(pool, startedAt);
      }
    } else {
      log.warn('--dry-run：不连库、不写状态/任务/覆盖指标');
    }

    startupProbe = await assertEgressContract(http, {
      baseUrl: config.siteBaseUrl,
      amcPolicy: parseProbePolicy(opts.amcProbe ?? config.amcProbe, amcProbePolicyFor(SOURCE)),
      proxyPolicy: parseProbePolicy(opts.proxyCheck ?? config.proxyCheck, 'warn'),
      ipProbeUrl: config.exitIpProbeUrl,
      logger: log.child('probe'),
    });

    const scan =
      opts.layer === 'l0'
        ? await scanIncrementalListPages(http, config.siteBaseUrl, 'l0', {
            concurrency: opts.concurrency,
            windowHours,
            logger: log.child('l0'),
            shouldStop: () => budget.checkpoint(),
          })
        : await scanIncrementalListPages(http, config.siteBaseUrl, 'l1', {
            concurrency: opts.concurrency,
            logger: log.child('l1'),
            shouldStop: () => budget.checkpoint(),
          });
    budget.checkpoint();
    let l1EnumerationSnapshot: Record<string, unknown> | null = null;
    if (opts.layer === 'l1') {
      const baseSnapshotFile = l1EnumerationSnapshotPath(config.stateDir);
      const advanced = advanceDailyL1EnumerationSnapshot(
        opts.dryRun ? `${baseSnapshotFile}.dryrun` : baseSnapshotFile,
        scan as IncrementalListPagesRun<L1ListPageRow>,
        new Date().toISOString(),
      );
      l1EnumerationSnapshot = {
        advanced: advanced.advanced,
        reason: advanced.reason,
        updatedAt: advanced.snapshot?.updatedAt ?? null,
        rowCount: advanced.snapshot?.rowCount ?? null,
        contentChecksum: advanced.snapshot?.contentChecksum ?? null,
      };
    }

    let persistence: PersistResult;
    if (budget.stoppedByRuntimeBudget) {
      persistence = skippedPersistence(
        scan.rows.length,
        opts.layer,
        `达到 ${opts.maxRuntimeSec}s 单轮时间预算；不推进状态，下一轮完整重扫`,
      );
    } else if (scan.status !== 'ok') {
      // 多页 ListPages 没有事务快照；分页期间的单条移动会产生重复/空洞。
      // 整轮证据落为 partial，但不推进增量状态、不入队、不计算覆盖率。
      persistence = skippedPersistence(
        scan.rows.length,
        opts.layer,
        scan.validation.reasons.join('；'),
      );
    } else if (pool === null || runId === null) {
      persistence = dryPersistence(scan.rows.length, opts.layer);
    } else if (opts.layer === 'l0') {
      persistence = await persistL0(
        pool,
        runId,
        scan.rows as L0ListPageRow[],
        startedAt,
        config.minEnumeratedRatio,
      );
    } else {
      persistence = await persistL1(
        pool,
        runId,
        scan.rows as L1ListPageRow[],
        startedAt,
        config.incrementalFrequencyMinutes,
        config.minEnumeratedRatio,
      );
    }
    budget.checkpoint();

    const durationMs = Date.now() - t0;
    const baseHealth = evaluateRunHealth({
      claimed: scan.expectedBatches ?? scan.requestedBatches,
      processed: scan.requestedBatches,
      partial:
        budget.stoppedByRuntimeBudget || scan.status === 'partial'
          ? Math.max(1, scan.batchesFailed)
          : 0,
      failed: budget.stoppedByRuntimeBudget ? 0 : scan.batchesFailed,
      deferred: budget.stoppedByRuntimeBudget
        ? Math.max(1, (scan.expectedBatches ?? scan.requestedBatches + 1) - scan.requestedBatches)
        : 0,
      breakerOpen: http.breakerOpen,
      fatalReasons: [
        ...(scan.status === 'failed' && !budget.stoppedByRuntimeBudget
          ? ['scan_validation_failed']
          : []),
        ...(persistence.systemicPageFailure ? ['systemic_page_failure'] : []),
        ...(egressSlo?.exitCode === 1 ? ['adaptive_downshift_recovery_overdue'] : []),
      ],
    });
    const adaptiveState = http.stats().adaptiveEgress?.state ?? null;
    const health = adaptiveState === null
      ? baseHealth
      : applyAdaptiveSelfProtectionToRunHealth(
          baseHealth,
          evaluateAdaptiveSelfProtection(adaptiveState, Date.now()),
        );
    const runStatus = health.status;
    const stats = {
      mode,
      layer: opts.layer.toUpperCase(),
      population_type: populationType,
      frequencyMinutes: config.incrementalFrequencyMinutes,
      windowHours: opts.layer === 'l0' ? windowHours : null,
      earlyStop: false,
      validation: scan.validation,
      persistence,
      l1EnumerationSnapshot,
      http: http.stats(),
      egressSlo,
      startupProbe,
      durationMs,
      dryRun: opts.dryRun,
      httpHealth: http.healthStats(),
      health,
      ...budget.summary(),
    };
    const parseHealth =
      pool === null
        ? null
        : await finishIngestRun(pool, runId, {
            status: runStatus,
            finishedAt: new Date().toISOString(),
            pagesEnumerated: scan.pagesEnumerated,
            remoteTotal: scan.pagesEnumerated,
            remoteTotalSource: 'listpages_total',
            batchesTotal: scan.expectedBatches,
            batchesFailed: scan.batchesFailed,
            transportFailureRate: transportFailureRate(http),
            exitIpStats: exitIpStatsJson(http),
            parseFingerprint: {
              ...scan.parseFingerprint,
              http_status_dist: http.healthStats().business.statusBuckets,
              transport_failure_rate: transportFailureRate(http),
            },
            populationType,
            stats,
          });

    const exitCode = health.exitCode;
    emitSummary({
      ok: exitCode === 0,
      status: runStatus,
      layer: opts.layer.toUpperCase(),
      mode,
      populationType,
      runId,
      durationMs,
      pagesEnumerated: scan.pagesEnumerated,
      expectedBatches: scan.expectedBatches,
      requestedBatches: scan.requestedBatches,
      persistence,
      health,
      l1EnumerationSnapshot,
      parseHealth,
      egressSlo,
      http: compactHttp(http),
      ...budget.summary(),
    });
    process.exitCode = exitCode;
  } catch (err) {
    if (isRuntimeBudgetExceededError(err)) {
      budget.checkpoint();
      const durationMs = Date.now() - t0;
      const requests = http.healthStats().business.requests;
      const health = evaluateRunHealth({
        claimed: Math.max(1, requests),
        processed: requests,
        partial: 1,
        failed: 0,
        deferred: 1,
      });
      log.info('增量层在等待中命中单轮时间预算，按 partial 优雅收尾', {
        layer: opts.layer,
        requests,
      });
      if (pool !== null) {
        await finishIngestRun(pool, runId, {
          status: health.status,
          finishedAt: new Date().toISOString(),
          pagesEnumerated: 0,
          remoteTotal: null,
          batchesTotal: requests,
          batchesFailed: 0,
          transportFailureRate: transportFailureRate(http),
          exitIpStats: exitIpStatsJson(http),
          parseFingerprint: {
            http_status_dist: http.healthStats().business.statusBuckets,
            transport_failure_rate: transportFailureRate(http),
          },
          populationType,
          stats: {
            mode,
            layer: opts.layer.toUpperCase(),
            population_type: populationType,
            durationMs,
            health,
            http: http.stats(),
            egressSlo,
            ...budget.summary(),
          },
        }).catch((finishErr) =>
          log.error('预算收尾写 ingest_run 失败', { error: String(finishErr) }),
        );
      }
      emitSummary({
        ok: true,
        status: health.status,
        layer: opts.layer.toUpperCase(),
        mode,
        runId,
        durationMs,
        health,
        http: compactHttp(http),
        ...budget.summary(),
      });
      process.exitCode = 0;
      return;
    }
    const breaker = err instanceof CircuitOpenError || http.breakerOpen;
    const durationMs = Date.now() - t0;
    const baseHealth = evaluateRunHealth({
      claimed: Math.max(1, http.healthStats().business.requests),
      processed: http.healthStats().business.requests,
      partial: 0,
      failed: breaker ? Math.max(1, http.healthStats().business.transportFailures) : 1,
      breakerOpen: breaker,
      fatalReasons: breaker ? [] : ['incremental_scan_exception'],
    });
    const adaptiveState = http.stats().adaptiveEgress?.state ?? null;
    const health = adaptiveState === null
      ? baseHealth
      : applyAdaptiveSelfProtectionToRunHealth(
          baseHealth,
          evaluateAdaptiveSelfProtection(adaptiveState, Date.now()),
        );
    log.error('增量层本轮失败', { layer: opts.layer, error: String(err), breaker });
    if (pool !== null) {
      await finishIngestRun(pool, runId, {
        status: health.status,
        finishedAt: new Date().toISOString(),
        pagesEnumerated: null,
        remoteTotal: null,
        batchesTotal: http.stats().requests,
        batchesFailed: 1,
        transportFailureRate: transportFailureRate(http),
        exitIpStats: exitIpStatsJson(http),
        parseFingerprint: {
          http_status_dist: http.healthStats().business.statusBuckets,
          transport_failure_rate: transportFailureRate(http),
        },
        populationType,
        stats: {
          mode,
          layer: opts.layer.toUpperCase(),
          population_type: populationType,
          error: String(err),
          breaker,
          http: http.stats(),
          egressSlo,
          httpHealth: http.healthStats(),
          startupProbe,
          durationMs,
          health,
        },
      }).catch((finishErr) =>
        log.error('失败收尾写 ingest_run 也失败', { error: String(finishErr) }),
      );
    }
    emitSummary({
      ok: health.exitCode === 0,
      status: health.status,
      layer: opts.layer.toUpperCase(),
      mode,
      populationType,
      runId,
      durationMs,
      error: String(err),
      health,
      egressSlo,
      http: compactHttp(http),
    });
    process.exitCode = health.exitCode;
  } finally {
    await http.close();
    await pool?.end().catch(() => undefined);
  }
}

async function persistL0(
  pool: Pool,
  runId: number,
  rows: readonly L0ListPageRow[],
  observedAt: string,
  minCoverage: number,
): Promise<PersistResult> {
  const [states, resolution, knownPopulation] = await Promise.all([
    loadIncrementalPageStates(pool, rows.map((row) => row.fullname)),
    resolveSlugs(pool, rows.map((row) => row.fullname)),
    loadIncrementalKnownPopulation(pool),
  ]);
  const diff = diffL0Rows(rows, states);
  const regressionHealth = evaluateRevisionRegressionHealth({
    regressions: diff.revisionRegressions.length,
    pagesEnumerated: rows.length,
    knownPopulation,
    minCoverage,
  });
  const regressionSlugs = new Set(diff.revisionRegressions);
  const regressionTargets = revisionRegressionTargets(diff.revisionRegressions, states, resolution.map);
  if (diff.revisionRegressions.length > 0) {
    log.warn('L0 revisions 倒退页已隔离并进入身份确认，不中断其它页面', {
      count: diff.revisionRegressions.length,
      sample: diff.revisionRegressions.slice(0, 20),
      ...regressionHealth,
    });
  }

  const changedBySlug = new Map(diff.changed.map((row) => [row.current.fullname, row]));
  const resolved = rows
    .filter((row) => resolution.map.has(row.fullname))
    .map((row) => ({ row, pageId: resolution.map.get(row.fullname)! }));
  const unresolved = rows.filter((row) => !resolution.map.has(row.fullname));
  const tasks: ScanTaskRow[] = regressionTargets.map(({ pageId }) => ({
    pageId,
    kind: 'meta',
    reasons: ['revision_regression_identity_check', 'l0_revision_regression'],
    priority: 100,
  }));
  for (const { row, pageId } of resolved) {
    const changed = changedBySlug.get(row.fullname);
    if (changed === undefined) continue;
    tasks.push(
      {
        pageId,
        kind: 'content',
        reasons: ['l0_updated_at_revision_changed'],
        priority: 30,
      },
      {
        pageId,
        kind: 'revisions_full',
        reasons: ['l0_updated_at_revision_changed'],
        priority: 30,
      },
    );
  }
  const pending = await upsertPendingPages(
    pool,
    unresolved.map((row) => ({
      slug: row.fullname,
      reasons: regressionSlugs.has(row.fullname)
        ? ['revision_regression_identity_check', 'l0_revision_regression']
        : ['l0_updated_at_window', 'l0_new_or_renamed_page'],
      priority: regressionSlugs.has(row.fullname) ? 100 : 40,
      discoveredBy: SOURCE,
    })),
    observedAt,
  );
  const regressionIdentityStates = regressionHealth.systemic
    ? 0
    : await upsertRevisionRegressionIdentityStates(
        pool,
        runId,
        regressionTargets.map(({ slug, pageId }) => {
          const row = rows.find((candidate) => candidate.fullname === slug)!;
          return {
            layer: 'L0' as const,
            pageId,
            slug,
            previousRevision: states.get(slug)!.lastL0Revision!,
            observedRevision: row.revisions,
            observedUpdatedAt: row.updatedAt,
          };
        }),
        observedAt,
      );
  const tasksEnqueued = await enqueueScanTasks(pool, mergeTasks(tasks));
  const pageScansWritten = await insertPageScans(
    pool,
    runId,
    [
      ...regressionTargets.flatMap(({ slug, pageId }) => {
        const row = rows.find((candidate) => candidate.fullname === slug)!;
        const previous = states.get(slug)?.lastL0Revision ?? null;
        const error =
          `revision_regression_identity_pending:layer=L0;slug=${slug};` +
          `previous=${previous ?? 'null'};current=${row.revisions}`;
        return [
          {
            pageId,
            kind: 'meta' as const,
            status: 'partial' as const,
            claimedTotal: row.revisions,
            checksumExpected: previous,
            error,
            resultHash: observationHash(row),
          },
          {
            pageId,
            kind: 'revisions' as const,
            status: 'partial' as const,
            claimedTotal: row.revisions,
            checksumExpected: previous,
            error,
            resultHash: observationHash(row),
          },
        ];
      }),
      ...resolved
      .filter(({ row }) => changedBySlug.has(row.fullname))
      .map(({ row, pageId }) => ({
        pageId,
        kind: 'revisions' as const,
        status: 'partial' as const,
        claimedTotal: row.revisions,
        error: 'l0_claim_only:等待 revisions_full 完整抓取',
        resultHash: observationHash(row),
      })),
    ],
    observedAt,
  );
  const signalsWritten = await insertIncrementalSignals(
    pool,
    runId,
    diff.changed.flatMap((changed) => {
      const pageId = resolution.map.get(changed.current.fullname) ?? null;
      const details = {
        previous_revision: changed.previous?.lastL0Revision ?? null,
        current_revision: changed.current.revisions,
        previous_updated_at: changed.previous?.lastL0UpdatedAt ?? null,
        current_updated_at: changed.current.updatedAt,
      };
      return [
        {
          layer: 'L0' as const,
          slug: changed.current.fullname,
          pageId,
          signal: changed.revisionChanged
            ? 'revision_changed'
            : 'updated_at_without_revision_change',
          detectedAt: observedAt,
          details,
        },
      ];
    }),
  );
  const anomalyCount = diff.changed.filter((row) => row.updatedAtChangedWithoutRevision).length;
  if (anomalyCount > 0) {
    log.error('updated_at 前进但 revisions 未变；违反内容增量假设', { anomalyCount });
  }
  // 状态推进必须是最后一步；之前任一入队/证据写失败都会让下轮安全重报。
  const statesAdvanced = regressionHealth.systemic
    ? 0
    : await upsertL0States(
        pool,
        rows
          .filter((row) => !regressionSlugs.has(row.fullname))
          .map((row) => ({ row, pageId: resolution.map.get(row.fullname) ?? null })),
        observedAt,
      );
  return {
    resolved: resolved.length,
    unresolved: unresolved.length,
    pendingEnqueued: pending.affected,
    tasksEnqueued,
    pageScansWritten,
    signalsWritten,
    statesAdvanced,
    revisionCoverage: null,
    driftReconciliation: null,
    coverageAlert: anomalyCount > 0,
    revisionRegressionHealth: regressionHealth,
    systemicPageFailure: regressionHealth.systemic,
    counters: {
      changed: diff.changed.length,
      revisionChanged: diff.changed.filter((row) => row.revisionChanged).length,
      revisionRegressions: diff.revisionRegressions.length,
      revisionRegressionIdentityStates: regressionIdentityStates,
      revisionRegressionSystemic: regressionHealth.systemic,
      updatedAtWithoutRevision: anomalyCount,
      unchanged: diff.unchanged,
    },
  };
}

async function persistL1(
  pool: Pool,
  runId: number,
  rows: readonly L1ListPageRow[],
  observedAt: string,
  frequencyMinutes: number,
  minCoverage: number,
): Promise<PersistResult> {
  const [states, baseline, resolution, knownPopulation] = await Promise.all([
    loadIncrementalPageStates(pool, rows.map((row) => row.fullname)),
    hasL1Baseline(pool),
    resolveSlugs(pool, rows.map((row) => row.fullname)),
    loadIncrementalKnownPopulation(pool),
  ]);
  const diff = diffL1Rows(rows, states, baseline);
  const regressionHealth = evaluateRevisionRegressionHealth({
    regressions: diff.revisionRegressions.length,
    pagesEnumerated: rows.length,
    knownPopulation,
    minCoverage,
  });
  const regressionSlugs = new Set(diff.revisionRegressions);
  const regressionTargets = revisionRegressionTargets(diff.revisionRegressions, states, resolution.map);
  if (diff.revisionRegressions.length > 0) {
    log.warn('L1 revisions 倒退页已隔离并进入身份确认，不中断其它页面', {
      count: diff.revisionRegressions.length,
      sample: diff.revisionRegressions.slice(0, 20),
      ...regressionHealth,
    });
  }

  const resolved = rows
    .filter((row) => resolution.map.has(row.fullname))
    .map((row) => ({ row, pageId: resolution.map.get(row.fullname)! }));
  const unresolved = rows.filter((row) => !resolution.map.has(row.fullname));
  const driftReconciliation = await observeL1ProjectionDrift(
    pool,
    runId,
    resolved.map(({ row, pageId }) => ({
      row,
      pageId,
      previousL1RunId: states.get(row.fullname)?.lastL1RunId ?? null,
    })),
    observedAt,
  );
  const identityConflictSlugs = new Set(
    driftReconciliation.identityConflicts.map((row) => row.slug),
  );
  if (driftReconciliation.identityConflicts.length > 0) {
    log.warn('L1 对账身份不唯一，已隔离且不派生深扫', {
      count: driftReconciliation.identityConflicts.length,
      sample: driftReconciliation.identityConflicts.slice(0, 20),
    });
  }
  if (driftReconciliation.summary.gate.triggered) {
    log.error(driftReconciliation.summary.gate.message ?? 'L1 对账总量闸门触发', {
      ...driftReconciliation.summary.gate,
      voteMismatches: driftReconciliation.summary.voteMismatches,
      revisionMismatches: driftReconciliation.summary.revisionMismatches,
    });
  }
  const tasks: ScanTaskRow[] = regressionTargets.map(({ pageId }) => ({
    pageId,
    kind: 'meta',
    reasons: ['revision_regression_identity_check', 'l1_revision_regression'],
    priority: 100,
  }));
  for (const changed of diff.voteChanges) {
    if (identityConflictSlugs.has(changed.current.fullname)) continue;
    const pageId = resolution.map.get(changed.current.fullname);
    if (pageId !== undefined) {
      tasks.push({
        pageId,
        kind: 'votes_full',
        reasons: ['l1_rating_or_rating_votes_changed'],
        priority: L1_VOTE_CHANGE_PRIORITY,
      });
    }
  }
  // 覆盖证明发现漏捕获时立即告警，同时由独立 L1 安全补入深扫，避免证明本身只报不救。
  for (const missed of diff.revisionMisses) {
    if (identityConflictSlugs.has(missed.current.fullname)) continue;
    const pageId = resolution.map.get(missed.current.fullname);
    if (pageId === undefined) continue;
    tasks.push(
      {
        pageId,
        kind: 'content',
        reasons: ['l1_revision_crosscheck_miss'],
        priority: 100,
      },
      {
        pageId,
        kind: 'revisions_full',
        reasons: ['l1_revision_crosscheck_miss'],
        priority: 100,
      },
    );
  }
  tasks.push(...driftReconciliation.tasks);
  const pending = await upsertPendingPages(
    pool,
    unresolved.map((row) => ({
      slug: row.fullname,
      reasons: regressionSlugs.has(row.fullname)
        ? ['revision_regression_identity_check', 'l1_revision_regression']
        : ['l1_full_site_unresolved'],
      priority: regressionSlugs.has(row.fullname) ? 100 : 30,
      discoveredBy: SOURCE,
    })),
    observedAt,
  );
  const regressionIdentityStates = regressionHealth.systemic
    ? 0
    : await upsertRevisionRegressionIdentityStates(
        pool,
        runId,
        regressionTargets.map(({ slug, pageId }) => {
          const row = rows.find((candidate) => candidate.fullname === slug)!;
          return {
            layer: 'L1' as const,
            pageId,
            slug,
            previousRevision: states.get(slug)!.lastL1Revision!,
            observedRevision: row.revisions,
            observedRating: row.rating,
            observedRatingVotes: row.ratingVotes,
          };
        }),
        observedAt,
      );
  const tasksEnqueued = await enqueueScanTasks(pool, mergeTasks(tasks));
  const voteChanged = new Set(diff.voteChanges.map((row) => row.current.fullname));
  const revisionChanged = new Set(diff.revisionChanges.map((row) => row.current.fullname));
  const pageScansWritten = await insertPageScans(
    pool,
    runId,
    [
      ...regressionTargets.flatMap(({ slug, pageId }) => {
        const row = rows.find((candidate) => candidate.fullname === slug)!;
        const previous = states.get(slug)?.lastL1Revision ?? null;
        const error =
          `revision_regression_identity_pending:layer=L1;slug=${slug};` +
          `previous=${previous ?? 'null'};current=${row.revisions}`;
        return [
          {
            pageId,
            kind: 'meta' as const,
            status: 'partial' as const,
            claimedTotal: row.revisions,
            checksumExpected: previous,
            error,
            resultHash: observationHash(row),
          },
          {
            pageId,
            kind: 'revisions' as const,
            status: 'partial' as const,
            claimedTotal: row.revisions,
            checksumExpected: previous,
            error,
            resultHash: observationHash(row),
          },
        ];
      }),
      ...resolved.flatMap(({ row, pageId }) => [
      ...(voteChanged.has(row.fullname)
        ? [{
            pageId,
            kind: 'meta' as const,
            status: 'ok' as const,
            claimedTotal: row.ratingVotes,
            checksumExpected: row.rating,
            resultHash: observationHash(row),
          }]
        : []),
      ...(revisionChanged.has(row.fullname)
        ? [{
            pageId,
            kind: 'revisions' as const,
            status: 'partial' as const,
            claimedTotal: row.revisions,
            error: 'l1_claim_only:修订覆盖交叉核对',
            resultHash: observationHash(row),
          }]
        : []),
      ]),
    ],
    observedAt,
  );
  const missedSet = new Set(diff.revisionMisses.map((row) => row.current.fullname));
  const signalsWritten = await insertIncrementalSignals(
    pool,
    runId,
    [
      ...diff.changed.flatMap((changed) => {
        const signals = [];
        const details = {
          previous_revision: changed.previous?.lastL1Revision ?? null,
          current_revision: changed.current.revisions,
          previous_rating: changed.previous?.lastL1Rating ?? null,
          current_rating: changed.current.rating,
          previous_rating_votes: changed.previous?.lastL1RatingVotes ?? null,
          current_rating_votes: changed.current.ratingVotes,
        };
        if (changed.voteChanged) {
          signals.push({
            layer: 'L1' as const,
            slug: changed.current.fullname,
            pageId: resolution.map.get(changed.current.fullname) ?? null,
            signal: 'vote_changed',
            detectedAt: observedAt,
            details,
          });
        }
        if (changed.revisionChanged) {
          signals.push({
            layer: 'L1' as const,
            slug: changed.current.fullname,
            pageId: resolution.map.get(changed.current.fullname) ?? null,
            signal: missedSet.has(changed.current.fullname)
              ? 'revision_crosscheck_miss'
              : 'revision_crosscheck_hit',
            detectedAt: observedAt,
            details,
          });
        }
        return signals;
      }),
      ...driftReconciliation.identityConflicts.map((conflict) => ({
        layer: 'L1' as const,
        slug: conflict.slug,
        pageId: conflict.resolvedPageId,
        signal: 'projection_drift_identity_conflict',
        detectedAt: observedAt,
        details: {
          live_page_ids: conflict.livePageIds,
          action: 'isolated_no_deep_scan',
        },
      })),
    ],
  );

  const previousL1Times = [...states.values()]
    .map((state) => state.lastL1SeenAt)
    .filter((value): value is string => value !== null);
  const previousL1At =
    previousL1Times.length === 0
      ? null
      : new Date(Math.max(...previousL1Times.map((value) => Date.parse(value)))).toISOString();
  const windowStartedAt = previousL1At ?? observedAt;
  const [l0Bounds, blockingFreezeDomains] = await Promise.all([
    loadSuccessfulL0Bounds(pool, previousL1At, observedAt),
    loadRevisionCoverageWriteFreezeDomains(pool, windowStartedAt, observedAt),
  ]);
  const baselineClassification = classifyRevisionCoverageBaseline({
    previousL1At,
    currentL1At: observedAt,
    latestL0AtOrBeforePreviousL1: l0Bounds.latestAtOrBeforePreviousL1,
    latestL0AtOrBeforeCurrentL1: l0Bounds.latestAtOrBeforeCurrentL1,
    frequencyMinutes,
    blockingFreezeDomains,
  });
  const revisionCoverage = await recordRevisionCoverage(pool, {
    l1RunId: runId,
    windowStartedAt,
    windowEndedAt: observedAt,
    isBaselineInit: baselineClassification.isBaselineInit,
    baselineInitReason: baselineClassification.reason,
    l1RevisionChanges: diff.revisionChanges.length,
    l0CapturedChanges: diff.revisionChanges.length - diff.revisionMisses.length,
    sampleMissedSlugs: diff.revisionMisses.map((row) => row.current.fullname),
  });
  const revisionCoverageAlert = shouldAlertRevisionCoverage(revisionCoverage);
  if (revisionCoverage.isBaselineInit) {
    log.warn('L0/L1 覆盖窗口仅作基线初始化留痕，不进入 rolling 或告警', {
      runId,
      reason: revisionCoverage.baselineInitReason,
      windowStartedAt,
      windowEndedAt: observedAt,
      changes: revisionCoverage.l1RevisionChanges,
      apparentMisses: revisionCoverage.l0MissedChanges,
      gapThresholdMinutes: baselineClassification.gapThresholdMinutes,
    });
  }
  if (revisionCoverageAlert) {
    log.error('L0 修订覆盖交叉核对漏捕获', {
      runId,
      missed: revisionCoverage.l0MissedChanges,
      changes: revisionCoverage.l1RevisionChanges,
      sample: revisionCoverage.sampleMissedSlugs.slice(0, 20),
    });
  }
  // 未解析行也必须推进远端 L1 基线；否则永久 mismatch 的 namespace 会在每轮
  // 被重复当成修订变化，制造 L0 覆盖误报。后续身份解析由 resolver 自己下
  // new_page_highfreq/meta 任务，下一轮再补 page_id，不依赖重复制造变化。
  const driftFlood = driftReconciliation.summary.gate.triggered;
  const statesAdvanced = regressionHealth.systemic || driftFlood
    ? 0
    : await upsertL1States(
        pool,
        runId,
        rows
          .filter(
            (row) =>
              !regressionSlugs.has(row.fullname) &&
              !identityConflictSlugs.has(row.fullname),
          )
          .map((row) => ({ row, pageId: resolution.map.get(row.fullname) ?? null })),
        observedAt,
      );
  return {
    resolved: resolved.length,
    unresolved: unresolved.length,
    pendingEnqueued: pending.affected,
    tasksEnqueued,
    pageScansWritten,
    signalsWritten,
    statesAdvanced,
    revisionCoverage,
    driftReconciliation: driftReconciliation.summary,
    coverageAlert: revisionCoverageAlert || driftFlood,
    revisionRegressionHealth: regressionHealth,
    systemicPageFailure: regressionHealth.systemic || driftFlood,
    counters: {
      bootstrap: diff.bootstrap,
      voteChanges: diff.voteChanges.length,
      revisionChanges: diff.revisionChanges.length,
      revisionMisses: diff.revisionMisses.length,
      revisionRegressions: diff.revisionRegressions.length,
      revisionRegressionIdentityStates: regressionIdentityStates,
      revisionRegressionSystemic: regressionHealth.systemic,
      projectionDriftPages: driftReconciliation.summary.discoveredPages,
      projectionDriftVoteMismatches: driftReconciliation.summary.voteMismatches,
      projectionDriftRevisionMismatches: driftReconciliation.summary.revisionMismatches,
      projectionDriftPersistentPages: driftReconciliation.summary.persistentPages,
      projectionDriftTerminalSuppressed:
        driftReconciliation.summary.terminalSuppressedTasks,
      projectionDriftTerminalReopened:
        driftReconciliation.summary.terminalReopenedTasks,
      projectionDriftGateTriggered: driftFlood,
      projectionDriftTruncatedPages:
        driftReconciliation.summary.gate.truncatedPages,
      projectionDriftIdentityConflicts:
        driftReconciliation.summary.identityConflicts,
      unchanged: diff.unchanged,
      earlyStop: false,
    },
  };
}

function dryPersistence(rows: number, layer: IncrementalListPagesLayer): PersistResult {
  const revisionRegressionHealth = evaluateRevisionRegressionHealth({
    regressions: 0,
    pagesEnumerated: rows,
  });
  return {
    resolved: 0,
    unresolved: rows,
    pendingEnqueued: 0,
    tasksEnqueued: 0,
    pageScansWritten: 0,
    signalsWritten: 0,
    statesAdvanced: 0,
    revisionCoverage: null,
    driftReconciliation: null,
    coverageAlert: false,
    revisionRegressionHealth,
    systemicPageFailure: false,
    counters: { dryRun: true, layer: layer === 'l0' ? 0 : 1 },
  };
}

function revisionRegressionTargets(
  slugs: readonly string[],
  states: ReadonlyMap<string, { pageId: number | null }>,
  resolved: ReadonlyMap<string, number>,
): Array<{ slug: string; pageId: number }> {
  const targets: Array<{ slug: string; pageId: number }> = [];
  for (const slug of slugs) {
    // 倒退基线属于上一身份；优先把身份确认任务挂在 state 的旧 page_id。
    // 这对“旧页已经 deleted、同 slug 新建”尤其关键。
    const pageId = states.get(slug)?.pageId ?? resolved.get(slug) ?? null;
    if (pageId !== null) targets.push({ slug, pageId });
  }
  return targets;
}

function skippedPersistence(
  rows: number,
  layer: IncrementalListPagesLayer,
  reason: string,
): PersistResult {
  return {
    ...dryPersistence(rows, layer),
    skipReason: reason,
    counters: {
      persistenceSkipped: true,
      partialEvidence: true,
      layer: layer === 'l0' ? 0 : 1,
    },
  };
}

function mergeTasks(rows: readonly ScanTaskRow[]): ScanTaskRow[] {
  const merged = new Map<string, ScanTaskRow>();
  for (const row of rows) {
    const key = `${row.pageId}:${row.kind}`;
    const current = merged.get(key);
    if (current === undefined) {
      merged.set(key, { ...row, reasons: [...row.reasons] });
      continue;
    }
    current.reasons = [...new Set([...current.reasons, ...row.reasons])].sort();
    current.priority = Math.max(current.priority ?? 0, row.priority ?? 0);
  }
  return [...merged.values()];
}

function observationHash(row: L0ListPageRow | L1ListPageRow): Buffer {
  return createHash('sha256').update(JSON.stringify(row), 'utf8').digest();
}

function transportFailureRate(http: HttpClient): number | null {
  const stats = http.healthStats().business;
  if (stats.requests === 0) return null;
  return stats.transportFailures / stats.requests;
}

function exitIpStatsJson(http: HttpClient): Record<string, unknown> {
  return (http.exitIpStats() as unknown as Record<string, unknown> | null) ?? {};
}

function compactHttp(http: HttpClient): Record<string, unknown> {
  const stats = http.stats();
  return {
    requests: stats.requests,
    attempts: stats.attempts,
    retries: stats.retries,
    wireBytes: stats.wireBytes,
    decodedBytes: stats.decodedBytes,
    statusBuckets: stats.statusBuckets,
    breakerOpen: stats.breakerOpen,
    adaptiveEgress: stats.adaptiveEgress,
  };
}

function parseArgs(): CliOptions {
  const program = new Command();
  program.configureOutput({
    writeOut: (text) => process.stderr.write(text),
    writeErr: (text) => process.stderr.write(text),
  });
  program
    .name('incremental-scan')
    .requiredOption('--layer <l0|l1>', 'L0 内容编辑窗口或 L1 投票全站扫描')
    .option('--dry-run', '不连库、不写状态/任务/指标', false)
    .option('--skip-tz-check', '跳过时区回环（仅限本地诊断）', false)
    .option('--concurrency <n>', 'AMC 并发批数 1..5（默认 5）', (value) => Number(value), 5)
    .option('--window-hours <n>', '仅 L0：updated_at 回看小时数（默认读配置）', (value) => Number(value))
    .option('--amc-probe <policy>', 'AMC 契约探针：require | warn | skip')
    .option('--proxy-check <policy>', '代理健康：require | warn | skip');
  addRuntimeBudgetOption(program, { defaultSec: 180, minSec: 1, maxSec: 3_600 });
  program.parse(process.argv);
  const raw = program.opts<{
    layer: string;
    dryRun: boolean;
    skipTzCheck: boolean;
    concurrency: number;
    windowHours?: number;
    amcProbe?: string;
    proxyCheck?: string;
    maxRuntimeSec: number;
  }>();
  if (raw.layer !== 'l0' && raw.layer !== 'l1') {
    throw new Error(`--layer 只允许 l0|l1，收到 ${raw.layer}`);
  }
  if (!Number.isInteger(raw.concurrency) || raw.concurrency < 1 || raw.concurrency > 5) {
    throw new Error(`--concurrency 必须是 1..5，收到 ${raw.concurrency}`);
  }
  if (
    raw.windowHours !== undefined &&
    (!Number.isInteger(raw.windowHours) || raw.windowHours < 1 || raw.windowHours > 24)
  ) {
    throw new Error(`--window-hours 必须是 1..24 的整数，收到 ${raw.windowHours}`);
  }
  if (raw.layer === 'l1' && raw.windowHours !== undefined) {
    throw new Error('--window-hours 只适用于 L0');
  }
  return {
    layer: raw.layer,
    dryRun: Boolean(raw.dryRun),
    skipTzCheck: Boolean(raw.skipTzCheck),
    concurrency: raw.concurrency,
    maxRuntimeSec: parseRuntimeBudgetSec(raw.maxRuntimeSec, { minSec: 1, maxSec: 3_600 }),
    ...(raw.windowHours === undefined ? {} : { windowHours: raw.windowHours }),
    ...(raw.amcProbe === undefined ? {} : { amcProbe: raw.amcProbe }),
    ...(raw.proxyCheck === undefined ? {} : { proxyCheck: raw.proxyCheck }),
  };
}

main().catch((err) => {
  log.error('致命错误', { error: String(err) });
  emitSummary({ ok: false, status: 'failed', error: String(err) });
  process.exitCode = 1;
});
