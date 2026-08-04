/**
 * Tier1 ListPages 单次短进程 CLI。
 *
 * 每次启动创建新的 HTTP client / DB pool，完成一轮即退出；没有常驻 loop。
 * stdout 只有最后一行 JSON，所有过程日志走 stderr。
 */

import { redirectConsoleToStderr, createLogger, emitSummary } from '../util/log.js';

redirectConsoleToStderr();

import { Command } from 'commander';
import path from 'node:path';
import type { Pool } from 'pg';

import { loadConfig } from '../config.js';
import {
  createListPagesSnapshot,
  deriveListPagesTriggers,
  diffListPages,
  listPagesResultHash,
  readListPagesSnapshot,
  scanListPages,
  scanListPagesRange,
  writeListPagesSnapshot,
  type ListPageRecord,
  type ListPagesDiff,
  type ListPagesRunResult,
} from '../collect/listpages.js';
import {
  chooseParentPageId,
  resolveParentFullnames,
  type ExistingParentRelation,
} from '../collect/parent.js';
import { amcProbePolicyFor, assertEgressContract, parseProbePolicy } from '../http/amc.js';
import { CircuitOpenError, HttpClient } from '../http/client.js';
import { evaluateParseHealth } from '../health/parseHealth.js';
import { assertTimezoneRoundTrip, createPool, query, toPgTimestamptz } from '../store/db.js';
import { toPgJson } from '../store/pgText.js';
import {
  enqueueScanTasks,
  finishIngestRun,
  insertPageScans,
  resolveSlugs,
  startIngestRun,
  type PageScanRow,
  type ScanTaskKind,
  type ScanTaskRow,
} from '../store/meta.js';
import { upsertPendingPages } from '../store/queues.js';
import { chunk } from '../util/concurrency.js';

const log = createLogger('tier1-scan');
const SOURCE = 'wikidot';
const MAX_PENDING_PER_RUN = 5_000;

interface CliOptions {
  dryRun: boolean;
  skipTzCheck: boolean;
  concurrency: number;
  maxBatches?: number;
  range?: { offset: number; limit: number };
  seedDeep: number;
  seedVotes: number;
  amcProbe?: string;
  proxyCheck?: string;
}

interface PersistTier1Options {
  rangeMode: boolean;
  seedDeep: number;
  seedVotes: number;
}

interface PersistenceResult {
  ok: boolean;
  bootstrap: boolean;
  resolvedPages: number;
  unresolvedPages: number;
  pendingEnqueued: number;
  pendingTruncated: number;
  pageScansWritten: number;
  creatorsEnsured: number;
  creatorsFailed: number;
  deletedCreatorPages: number;
  metadataApplied: number;
  metadataFailed: number;
  tagChangesApplied: number;
  parentFullnames: number;
  parentsResolvedCurrent: number;
  parentsResolvedHistoricalUnique: number;
  parentsPreservedExisting: number;
  unresolvedParentFullnames: number;
  tasksEnqueued: number;
  taskSignals: Record<string, number>;
  slugResolution: string;
  errors: Array<Record<string, unknown>>;
}

async function main(): Promise<void> {
  const opts = parseArgs();
  const config = loadConfig({ requireDatabase: !opts.dryRun });
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const runMode = opts.range === undefined ? 'tier1' : 'tier1_range';
  const populationType =
    opts.maxBatches !== undefined || opts.range !== undefined
      ? 'bounded_sample'
      : 'l3_full_site_tier1';

  // §1.3：Tier1 的连续失败熔断下限固定为 5，配置不得把它降到 N=2/3。
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
  http.assertHeaders();

  let pool: Pool | null = null;
  let runId: number | null = null;
  let probeReport: unknown = null;
  try {
    if (!opts.dryRun) {
      pool = createPool(config.databaseUrl, { max: Math.max(4, opts.concurrency) });
      if (opts.skipTzCheck) {
        log.warn('--skip-tz-check：仅限本地调试，调度器禁止使用');
      } else {
        await assertTimezoneRoundTrip(pool);
      }
      // 在真实 AMC 探针之前开 run：启动闸失败也必须留下 ingest_run 证据。
      runId = await startIngestRun(pool, SOURCE, startedAt);
    } else {
      log.warn('--dry-run：不连库、不写 meta/ingest/serve，只跑生产网络与解析校验');
    }

    probeReport = await assertEgressContract(http, {
      baseUrl: config.siteBaseUrl,
      amcPolicy: parseProbePolicy(opts.amcProbe ?? config.amcProbe, amcProbePolicyFor(SOURCE)),
      proxyPolicy: parseProbePolicy(opts.proxyCheck ?? config.proxyCheck, 'warn'),
      ipProbeUrl: config.exitIpProbeUrl,
      logger: log.child('probe'),
    });

    const scan =
      opts.range === undefined
        ? await scanListPages(http, config.siteBaseUrl, {
            concurrency: opts.concurrency,
            ...(opts.maxBatches === undefined ? {} : { maxBatches: opts.maxBatches }),
            logger: log.child('collect'),
          })
        : await scanListPagesRange(http, config.siteBaseUrl, {
            ...opts.range,
            logger: log.child('collect'),
          });
    // R10 必须在本轮 apply_page_meta/ensure_user 之前判定；否则“检测到了改版”
    // 仍会先把这一轮脏观测写进 append-only 事实，再到收尾时才冻结。
    const earlyHealth =
      pool && runId !== null
        ? await evaluateParseHealth(pool, {
            runId,
            source: SOURCE,
            mode: runMode,
            populationType,
            fingerprint: {
              ...scan.parseFingerprint,
              http_status_dist: http.healthStats().business.statusBuckets,
              transport_failure_rate: transportFailureRate(http),
            },
            exitIpStats: exitIpStatsJson(http),
          })
        : null;

    const snapshotName =
      opts.range === undefined
        ? 'listpages-tier1'
        : `listpages-tier1.range-${opts.range.offset}-${opts.range.limit}`;
    const snapshotFile = path.join(
      config.stateDir,
      `${snapshotName}${opts.dryRun ? '.dryrun' : ''}.snapshot.json.gz`,
    );
    const previous = readListPagesSnapshot(snapshotFile);
    const diff = diffListPages(scan.rows, previous);
    const persistence = pool
      ? await persistTier1(pool, runId, scan, diff, startedAt, {
          rangeMode: opts.range !== undefined,
          seedDeep: opts.seedDeep,
          seedVotes: opts.seedVotes,
        })
      : dryPersistence(scan, diff);

    // 只有完整扫描 + 全部必要写入成功才推进快照。失败只会导致下轮重复报告，不会丢信号。
    const snapshotAdvanced =
      scan.status === 'ok' &&
      persistence.ok &&
      scan.remoteTotal !== null &&
      (opts.dryRun || runId !== null);
    if (snapshotAdvanced) {
      writeListPagesSnapshot(
        snapshotFile,
        createListPagesSnapshot(scan.rows, scan.remoteTotal!, new Date().toISOString()),
      );
    }

    const logicalStatus: 'ok' | 'partial' | 'failed' =
      !persistence.ok ? 'failed' : scan.status;
    const dbStatus =
      logicalStatus === 'ok'
        ? 'ok'
        : logicalStatus === 'partial'
          ? 'partial'
          : http.breakerOpen
            ? 'aborted'
            : 'failed';
    const durationMs = Date.now() - t0;
    const stats = {
      mode: runMode,
      layer: populationType === 'l3_full_site_tier1' ? 'L3' : null,
      population_type: populationType,
      range: opts.range ?? null,
      seedDeep: opts.seedDeep,
      seedVotes: opts.seedVotes,
      logicalStatus,
      validation: scan.validation,
      persistence,
      diff: compactDiff(diff),
      snapshotAdvanced,
      startupProbe: probeReport,
      parseHealth: earlyHealth,
      http: http.stats(),
      httpHealth: http.healthStats(),
      durationMs,
      dryRun: opts.dryRun,
      sampleLimited: opts.maxBatches !== undefined || opts.range !== undefined,
    };

    if (pool) {
      await finishIngestRun(pool, runId, {
        status: dbStatus,
        finishedAt: new Date().toISOString(),
        pagesEnumerated: scan.pagesEnumerated,
        remoteTotal: scan.remoteTotal,
        remoteTotalSource: scan.remoteTotal === null ? null : 'listpages_total',
        batchesTotal: scan.expectedBatches ?? scan.requestedBatches,
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
    }

    emitSummary({
      ok: logicalStatus === 'ok' || logicalStatus === 'partial',
      status: logicalStatus,
      runId,
      durationMs,
      pagesEnumerated: scan.pagesEnumerated,
      remoteTotal: scan.remoteTotal,
      expectedBatches: scan.expectedBatches,
      requestedBatches: scan.requestedBatches,
      batchesFailed: scan.batchesFailed,
      validation: scan.validation,
      diff: compactDiff(diff),
      persistence,
      parseHealth: earlyHealth,
      snapshotAdvanced,
      http: compactHttp(http),
      egress: compactEgress(http),
    });
    process.exitCode = logicalStatus === 'ok' || logicalStatus === 'partial' ? 0 : 1;
  } catch (err) {
    const breaker = err instanceof CircuitOpenError || http.breakerOpen;
    const durationMs = Date.now() - t0;
    log.error('Tier1 本轮失败', { error: String(err), breaker });
    if (pool) {
      await finishIngestRun(pool, runId, {
        status: breaker ? 'aborted' : 'failed',
        finishedAt: new Date().toISOString(),
        pagesEnumerated: null,
        remoteTotal: null,
        remoteTotalSource: null,
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
          mode: runMode,
          layer: populationType === 'l3_full_site_tier1' ? 'L3' : null,
          population_type: populationType,
          range: opts.range ?? null,
          logicalStatus: 'failed',
          error: String(err),
          breaker,
          startupProbe: probeReport,
          http: http.stats(),
          httpHealth: http.healthStats(),
          durationMs,
        },
      }).catch((finishErr) =>
        log.error('Tier1 失败收尾写 ingest_run 也失败', { error: String(finishErr) }),
      );
    }
    emitSummary({
      ok: false,
      status: breaker ? 'aborted' : 'failed',
      runId,
      durationMs,
      error: String(err),
      breaker,
      http: compactHttp(http),
      egress: compactEgress(http),
    });
    process.exitCode = 1;
  } finally {
    await http.close();
    await pool?.end().catch(() => undefined);
  }
}

/**
 * 落证据、补偿未知身份、按触发矩阵入队并调用 apply_page_meta。
 *
 * scan.status != ok 时只做 meta.* 的单调 upsert 与 page_scan 留证，不触碰事实/SCD2；
 * 这把 §1.2 “没有完整证据不得做改名/属性变更判定”变成了代码分支。
 */
async function persistTier1(
  pool: Pool,
  runId: number | null,
  scan: ListPagesRunResult,
  diff: ListPagesDiff,
  observedAt: string,
  options: PersistTier1Options,
): Promise<PersistenceResult> {
  const result: PersistenceResult = {
    ok: true,
    bootstrap: diff.bootstrap,
    resolvedPages: 0,
    unresolvedPages: 0,
    pendingEnqueued: 0,
    pendingTruncated: 0,
    pageScansWritten: 0,
    creatorsEnsured: 0,
    creatorsFailed: 0,
    deletedCreatorPages: 0,
    metadataApplied: 0,
    metadataFailed: 0,
    tagChangesApplied: diff.changed.filter((row) => row.tagsChanged).length,
    parentFullnames: 0,
    parentsResolvedCurrent: 0,
    parentsResolvedHistoricalUnique: 0,
    parentsPreservedExisting: 0,
    unresolvedParentFullnames: 0,
    tasksEnqueued: 0,
    taskSignals: {},
    slugResolution: 'unavailable',
    errors: [],
  };

  const fullnames = scan.rows.map((row) => row.fullname);
  const parentFullnames = scan.rows
    .map((row) => row.parentFullname)
    .filter((v): v is string => v !== null);
  const resolution = await resolveSlugs(pool, [...fullnames, ...parentFullnames]);
  result.slugResolution = resolution.source;
  const parentResolution = await resolveParentFullnames(pool, parentFullnames);
  result.parentFullnames = new Set(parentFullnames).size;
  result.parentsResolvedCurrent = parentResolution.resolvedCurrent;
  result.parentsResolvedHistoricalUnique = parentResolution.resolvedHistoricalUnique;
  result.unresolvedParentFullnames = parentResolution.unresolved.length;

  const resolvedRows: Array<{ row: ListPageRecord; pageId: number }> = [];
  const unresolvedRows: ListPageRecord[] = [];
  for (const row of scan.rows) {
    const pageId = resolution.map.get(row.fullname);
    if (pageId === undefined) unresolvedRows.push(row);
    else resolvedRows.push({ row, pageId });
  }
  result.resolvedPages = resolvedRows.length;
  result.unresolvedPages = unresolvedRows.length;

  // 未知 fullname 没有内部 page_id，不能伪造 scan_task；进入 pending_page 等整页 GET 取身份。
  const previousNames = new Set(diff.newFullnames);
  const pendingCandidates = [
    ...unresolvedRows.map((row) => ({
      slug: row.fullname,
      reasons: [
        ...(previousNames.has(row.fullname) ? ['listpages_new_fullname'] : []),
        'listpages_fullname_without_identity',
        ...(options.rangeMode ? ['tier1_range_bootstrap'] : []),
      ],
      priority: options.rangeMode ? 100 : previousNames.has(row.fullname) ? 20 : 10,
      discoveredBy: SOURCE,
    })),
    // 父页可能已删，因此不会再作为 ListPages 自身的一行出现；仍要把原 fullname
    // 交给 pending_page 的整页身份解析，不能永久把 parent_page_id 留成 NULL。
    ...parentResolution.unresolved.map((slug) => ({
      slug,
      reasons: ['listpages_parent_without_identity'],
      priority: options.rangeMode ? 100 : 20,
      discoveredBy: SOURCE,
    })),
  ];
  const pendingBySlug = new Map<string, (typeof pendingCandidates)[number]>();
  for (const candidate of pendingCandidates) {
    const current = pendingBySlug.get(candidate.slug);
    if (current === undefined) {
      pendingBySlug.set(candidate.slug, candidate);
      continue;
    }
    current.reasons = [...new Set([...current.reasons, ...candidate.reasons])].sort();
    current.priority = Math.max(current.priority, candidate.priority);
  }
  const pendingRows = [...pendingBySlug.values()];
  const pendingBatch = pendingRows.slice(0, MAX_PENDING_PER_RUN);
  const pending = await upsertPendingPages(pool, pendingBatch, observedAt);
  result.pendingEnqueued = pending.affected;
  result.pendingTruncated = pendingRows.length - pendingBatch.length;
  if (result.pendingTruncated > 0) {
    log.warn('未知 fullname 入 pending_page 被单轮上限截断；下轮全扫会继续报告', {
      candidates: pendingRows.length,
      cap: MAX_PENDING_PER_RUN,
    });
  }

  const pageScans: PageScanRow[] = resolvedRows.flatMap(({ row, pageId }) => [
    {
      pageId,
      kind: 'meta',
      status: scan.status === 'ok' ? 'ok' : 'partial',
      claimedTotal: row.ratingVotes,
      fetchedTotal: null,
      resultHash: listPagesResultHash(row),
      error:
        scan.status === 'ok'
          ? null
          : `Tier1 整轮 ${scan.status}：${scan.validation.reasons.join('；')}`,
    },
    {
      // 远端 revision 自报数是 work-queue 完整性门控的 claim，不是本地事实。
      // page_current.revision_count 是包含 revision 0 的真实行数；Tier1 row.revisions 是
      // 零基最大修订号，两者差固定 offset，不能用声明值覆盖本地事实。
      pageId,
      kind: 'revisions',
      status: 'partial',
      claimedTotal: row.revisions,
      fetchedTotal: null,
      resultHash: listPagesResultHash(row),
      error: 'tier1_claim_only:等待 revisions_full 完整抓取',
    },
  ]);
  result.pageScansWritten = await insertPageScans(pool, runId, pageScans, observedAt);

  if (scan.status !== 'ok') {
    // partial/failed 只允许单调 upsert；pending_page 与 page_scan 都属于 meta 管道状态。
    return result;
  }

  const wikidotIds = await fetchWikidotIds(pool, resolvedRows.map((row) => row.pageId));
  const existingParents = await fetchExistingParents(
    pool,
    resolvedRows.map((row) => row.pageId),
  );
  const effectiveParentIds = new Map<number, number | null>();
  for (const { row, pageId } of resolvedRows) {
    const existing = existingParents.get(pageId);
    const parentPageId = chooseParentPageId(
      row.parentFullname,
      row.parentFullname === null
        ? undefined
        : parentResolution.map.get(row.parentFullname),
      existing,
    );
    effectiveParentIds.set(pageId, parentPageId);
    if (
      row.parentFullname !== null
      && existing?.fullname === row.parentFullname
      && parentPageId === existing.pageId
    ) {
      result.parentsPreservedExisting++;
    }
  }
  for (const { pageId } of resolvedRows) {
    if (!wikidotIds.has(pageId)) {
      result.errors.push({ pageId, error: 'ingest.page 缺 wikidot_id，拒绝调用 apply_page_meta' });
    }
  }
  if (result.errors.length > 0) {
    result.ok = false;
    return result;
  }

  // created_by_id 只用于铸/补 wikidot 用户。双空的已注销创建者绝不合成 SUBMITTER。
  const creators = new Map<
    number,
    { wikidotId: number; displayName: string | null; unixName: string | null }
  >();
  for (const row of scan.rows) {
    if (row.createdById === null && row.createdByUnix === null) result.deletedCreatorPages++;
    if (row.createdById === null) continue;
    const prev = creators.get(row.createdById);
    creators.set(row.createdById, {
      wikidotId: row.createdById,
      displayName: row.createdBy ?? prev?.displayName ?? null,
      unixName: row.createdByUnix ?? prev?.unixName ?? null,
    });
  }
  const creatorErrors = await runSettled([...creators.values()], 4, async (creator) => {
    await ensureCreator(pool, creator);
  });
  result.creatorsEnsured = creators.size - creatorErrors.length;
  result.creatorsFailed = creatorErrors.length;
  result.errors.push(...creatorErrors);
  if (creatorErrors.length > 0) {
    result.ok = false;
    // 身份铸造未完成时不继续写页面属性；下一轮仍会重试，快照不会推进。
    return result;
  }

  let freezeSeen = false;
  const applyErrors = await runSettled(resolvedRows, 4, async ({ row, pageId }) => {
    if (freezeSeen) throw new Error('write_freeze 已触发，本轮剩余 apply_page_meta 跳过');
    try {
      await applyPageMeta(pool, {
        row,
        pageId,
        wikidotId: wikidotIds.get(pageId)!,
        parentPageId: effectiveParentIds.get(pageId) ?? null,
        runId,
        observedAt,
      });
    } catch (err) {
      if (pgCode(err) === 'PGF01') freezeSeen = true;
      throw err;
    }
  });
  result.metadataApplied = resolvedRows.length - applyErrors.length;
  result.metadataFailed = applyErrors.length;
  result.errors.push(...applyErrors);
  if (applyErrors.length > 0) {
    result.ok = false;
    return result;
  }

  const taskRows = buildTasks(diff, resolvedRows);
  if (options.rangeMode && options.seedDeep > 0) {
    for (const { pageId } of resolvedRows.slice(0, options.seedDeep)) {
      for (const kind of ['votes_full', 'content', 'revisions_full', 'meta'] as const) {
        taskRows.push({
          pageId,
          kind,
          reasons: ['tier1_range_bootstrap'],
          priority: 90,
          notBefore: observedAt,
        });
      }
    }
  }
  if (options.rangeMode && options.seedVotes > 0) {
    for (const { pageId } of resolvedRows.slice(0, options.seedVotes)) {
      taskRows.push({
        pageId,
        kind: 'votes_full',
        reasons: ['tier1_range_vote_bootstrap'],
        priority: 90,
        notBefore: observedAt,
      });
    }
  }
  const tasksToEnqueue = mergeScanTasks(taskRows);
  result.taskSignals = countTasks(tasksToEnqueue);
  result.tasksEnqueued = await enqueueScanTasks(pool, tasksToEnqueue);
  return result;
}

function buildTasks(
  diff: ListPagesDiff,
  resolvedRows: ReadonlyArray<{ row: ListPageRecord; pageId: number }>,
): ScanTaskRow[] {
  const byFullname = new Map(resolvedRows.map((entry) => [entry.row.fullname, entry]));
  const tasks = new Map<string, ScanTaskRow>();
  const add = (pageId: number, kind: ScanTaskKind, reason: string, priority: number): void => {
    const key = `${pageId}:${kind}`;
    const current = tasks.get(key);
    if (current) {
      current.reasons = [...new Set([...current.reasons, reason])].sort();
      current.priority = Math.max(current.priority ?? 0, priority);
    } else {
      tasks.set(key, { pageId, kind, reasons: [reason], priority });
    }
  };

  for (const trigger of deriveListPagesTriggers(
    diff,
    resolvedRows.map((entry) => entry.row),
  )) {
    const known = byFullname.get(trigger.fullname);
    if (known) add(known.pageId, trigger.kind, trigger.reason, trigger.priority);
  }
  return [...tasks.values()];
}

async function ensureCreator(
  pool: Pool,
  creator: { wikidotId: number; displayName: string | null; unixName: string | null },
): Promise<void> {
  await query(
    pool,
    'tier1:ensure_user',
    `SELECT ingest.ensure_user(
              p_kind         => 'wikidot',
              p_wikidot_id   => $1,
              p_display_name => $2,
              p_unix_name    => $3
            )`,
    [creator.wikidotId, creator.displayName, creator.unixName],
  );
}

async function applyPageMeta(
  pool: Pool,
  args: {
    row: ListPageRecord;
    pageId: number;
    wikidotId: number;
    parentPageId: number | null;
    runId: number | null;
    observedAt: string;
  },
): Promise<void> {
  const attrs = {
    slug: args.row.fullname,
    title: args.row.title,
    tags: args.row.tags,
    hidden_tags: args.row.hiddenTags,
    category: args.row.category,
    parent:
      args.row.parentFullname === null
        ? null
        : { page_id: args.parentPageId, slug: args.row.parentFullname },
    first_published_at: args.row.createdAt,
    comment_count: args.row.comments,
    claimed_rating: args.row.rating,
    claimed_vote_count: args.row.ratingVotes,
  };
  await query(
    pool,
    'tier1:apply_page_meta',
    `SELECT ingest.apply_page_meta(
              p_page       => $1,
              p_attrs      => $2::jsonb,
              p_observed   => $3::timestamptz,
              p_source     => 'wikidot',
              p_run        => $4,
              p_wikidot_id => $5
            )`,
    [
      args.pageId,
      toPgJson(attrs, `tier1.page_meta:${args.pageId}`),
      toPgTimestamptz(args.observedAt),
      args.runId,
      args.wikidotId,
    ],
  );
}

async function fetchWikidotIds(pool: Pool, pageIds: readonly number[]): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  for (const part of chunk([...new Set(pageIds)], 5_000)) {
    const res = await query<{ id: number; wikidot_id: number }>(
      pool,
      'tier1:page_identity',
      `SELECT id, wikidot_id FROM ingest.page WHERE id = ANY($1::int[])`,
      [part],
    );
    for (const row of res.rows) out.set(Number(row.id), Number(row.wikidot_id));
  }
  return out;
}

async function fetchExistingParents(
  pool: Pool,
  pageIds: readonly number[],
): Promise<Map<number, ExistingParentRelation>> {
  const out = new Map<number, ExistingParentRelation>();
  for (const part of chunk([...new Set(pageIds)], 5_000)) {
    const res = await query<{
      child_page_id: number;
      parent_page_id: number;
      parent_fullname: string;
    }>(
      pool,
      'tier1:existing_parent_relations',
      `SELECT child.page_id AS child_page_id,
              child.parent_page_id,
              attr.value ->> 'slug' AS parent_fullname
         FROM serve.page_current child
         JOIN ingest.page_attr_history attr
           ON attr.page_id = child.page_id
          AND attr.attr = 'parent'
          AND attr.valid_to IS NULL
        WHERE child.page_id = ANY($1::int[])
          AND child.parent_page_id IS NOT NULL
          AND jsonb_typeof(attr.value) = 'object'
          AND NULLIF(attr.value ->> 'slug', '') IS NOT NULL`,
      [part],
    );
    for (const row of res.rows) {
      out.set(Number(row.child_page_id), {
        pageId: Number(row.parent_page_id),
        fullname: row.parent_fullname,
      });
    }
  }
  return out;
}

async function runSettled<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<Array<Record<string, unknown>>> {
  const errors: Array<Record<string, unknown>> = [];
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, Math.max(1, items.length)) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      try {
        await fn(items[index] as T);
      } catch (err) {
        errors.push({ index, error: String(err), code: pgCode(err) });
      }
    }
  });
  await Promise.all(workers);
  return errors;
}

function pgCode(err: unknown): string | null {
  return typeof err === 'object' && err !== null
    ? String((err as { code?: unknown }).code ?? '') || null
    : null;
}

function dryPersistence(scan: ListPagesRunResult, diff: ListPagesDiff): PersistenceResult {
  return {
    ok: true,
    bootstrap: diff.bootstrap,
    resolvedPages: 0,
    unresolvedPages: scan.rows.length,
    pendingEnqueued: 0,
    pendingTruncated: 0,
    pageScansWritten: 0,
    creatorsEnsured: 0,
    creatorsFailed: 0,
    deletedCreatorPages: scan.rows.filter(
      (row) => row.createdById === null && row.createdByUnix === null,
    ).length,
    metadataApplied: 0,
    metadataFailed: 0,
    tagChangesApplied: diff.changed.filter((row) => row.tagsChanged).length,
    parentFullnames: new Set(
      scan.rows
        .map((row) => row.parentFullname)
        .filter((value): value is string => value !== null),
    ).size,
    parentsResolvedCurrent: 0,
    parentsResolvedHistoricalUnique: 0,
    parentsPreservedExisting: 0,
    unresolvedParentFullnames: 0,
    tasksEnqueued: 0,
    taskSignals: {},
    slugResolution: 'dry-run',
    errors: [],
  };
}

function compactDiff(diff: ListPagesDiff): Record<string, unknown> {
  return {
    bootstrap: diff.bootstrap,
    newFullnames: diff.newFullnames.length,
    changed: diff.changed.length,
    votesChanged: diff.changed.filter((row) => row.votesChanged).length,
    revisionsChanged: diff.changed.filter((row) => row.revisionsChanged).length,
    forumChanged: diff.changed.filter((row) => row.forumChanged).length,
    tagsChanged: diff.changed.filter((row) => row.tagsChanged).length,
    parentChanged: diff.changed.filter((row) => row.parentChanged).length,
    unchanged: diff.unchanged,
    sampleNew: diff.newFullnames.slice(0, 20),
  };
}

function countTasks(rows: readonly ScanTaskRow[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of rows) out[row.kind] = (out[row.kind] ?? 0) + 1;
  return out;
}

function mergeScanTasks(rows: readonly ScanTaskRow[]): ScanTaskRow[] {
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
    if (
      row.notBefore !== undefined &&
      row.notBefore !== null &&
      (current.notBefore === undefined ||
        current.notBefore === null ||
        row.notBefore < current.notBefore)
    ) {
      current.notBefore = row.notBefore;
    }
  }
  return [...merged.values()];
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
  };
}

function compactEgress(http: HttpClient): Record<string, unknown> | null {
  const stats = http.exitIpStats();
  if (stats === null) return null;
  return {
    exitIps: Object.keys(stats.byIp),
    nodes: Object.keys(stats.byNode),
    probes: stats.probe.ok,
    probeFailed: stats.probe.failed,
    failureByNode: stats.transportFailureByNode,
  };
}

function parseArgs(): CliOptions {
  const program = new Command();
  program.configureOutput({
    writeOut: (text) => process.stderr.write(text),
    writeErr: (text) => process.stderr.write(text),
  });
  program
    .name('tier1-scan')
    .description('单次短进程：ListPages Tier1 全站扫描、四道校验、diff、入队与 apply_page_meta')
    .option('--dry-run', '不连库、不写任何表；使用独立 dry-run 快照', false)
    .option('--skip-tz-check', '跳过时区回环（仅限本地调试）', false)
    .option('--concurrency <n>', '并发批数，范围 1..5（默认 5）', (value) => Number(value), 5)
    .option(
      '--max-batches <n>',
      '只请求前 N 批的小样本诊断；整轮显式为 partial，绝不应用事实/SCD2',
      (value) => Number(value),
    )
    .option(
      '--range <offset:limit>',
      '有界真实范围（最多 150 页）；范围完整可 apply，但不构成全站删除证据',
    )
    .option(
      '--seed-deep <n>',
      'range 模式为前 N 个已解析页面入队 votes/content/revisions/meta（默认 0）',
      (value) => Number(value),
      0,
    )
    .option(
      '--seed-votes <n>',
      'range 模式额外为前 N 个已解析页面入队 votes（用于请求受限验收，默认 0）',
      (value) => Number(value),
      0,
    )
    .option('--amc-probe <policy>', 'AMC 契约探针：require | warn | skip（默认 require）')
    .option('--proxy-check <policy>', '代理健康探测：require | warn | skip（默认 warn）');
  program.parse(process.argv);

  const raw = program.opts<{
    dryRun: boolean;
    skipTzCheck: boolean;
    concurrency: number;
    maxBatches?: number;
    range?: string;
    seedDeep: number;
    seedVotes: number;
    amcProbe?: string;
    proxyCheck?: string;
  }>();
  if (!Number.isInteger(raw.concurrency) || raw.concurrency < 1 || raw.concurrency > 5) {
    throw new Error(`--concurrency 必须是 1..5 的整数，收到 ${raw.concurrency}`);
  }
  if (
    raw.maxBatches !== undefined &&
    (!Number.isInteger(raw.maxBatches) || raw.maxBatches < 1 || raw.maxBatches > 49)
  ) {
    // 启动 AMC 契约探针还会占 1 个 wikidot 请求，所以小样本上限为 49 批。
    throw new Error(`--max-batches 必须是 1..49 的整数，收到 ${raw.maxBatches}`);
  }
  if (raw.maxBatches !== undefined && raw.range !== undefined) {
    throw new Error('--max-batches 与 --range 互斥');
  }
  let range: { offset: number; limit: number } | undefined;
  if (raw.range !== undefined) {
    const match = /^(\d+):(\d+)$/.exec(raw.range.trim());
    if (match === null) {
      throw new Error(`--range 必须是 offset:limit，收到 ${raw.range}`);
    }
    const offset = Number(match[1]);
    const limit = Number(match[2]);
    if (
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(limit) ||
      offset < 0 ||
      limit < 1 ||
      limit > 150 ||
      offset % limit !== 0
    ) {
      throw new Error(
        `--range 要求 0<=offset、1<=limit<=150 且 offset 能被 limit 整除；` +
          `收到 ${raw.range}`,
      );
    }
    range = { offset, limit };
  }
  if (
    !Number.isInteger(raw.seedDeep) ||
    raw.seedDeep < 0 ||
    (range === undefined && raw.seedDeep !== 0) ||
    (range !== undefined && raw.seedDeep > range.limit)
  ) {
    throw new Error(
      `--seed-deep 只能用于 --range，且必须在 0..limit；收到 ${raw.seedDeep}`,
    );
  }
  if (
    !Number.isInteger(raw.seedVotes) ||
    raw.seedVotes < 0 ||
    (range === undefined && raw.seedVotes !== 0) ||
    (range !== undefined && raw.seedVotes > range.limit)
  ) {
    throw new Error(
      `--seed-votes 只能用于 --range，且必须在 0..limit；收到 ${raw.seedVotes}`,
    );
  }
  return {
    dryRun: Boolean(raw.dryRun),
    skipTzCheck: Boolean(raw.skipTzCheck),
    concurrency: raw.concurrency,
    seedDeep: raw.seedDeep,
    seedVotes: raw.seedVotes,
    ...(raw.maxBatches === undefined ? {} : { maxBatches: raw.maxBatches }),
    ...(range === undefined ? {} : { range }),
    ...(raw.amcProbe ? { amcProbe: raw.amcProbe } : {}),
    ...(raw.proxyCheck ? { proxyCheck: raw.proxyCheck } : {}),
  };
}

main().catch((err) => {
  log.error('致命错误', { error: String(err) });
  emitSummary({ ok: false, status: 'failed', error: String(err) });
  process.exitCode = 1;
});
