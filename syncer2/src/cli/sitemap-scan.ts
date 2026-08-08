/**
 * sitemap-scan —— **单次短进程** CLI。不是常驻 loop。为什么见 ../README.md §1。
 *
 * 模式：
 *   --mode delta     只抓 sitemap_page_1（实测 gzip 180 KB / 1.16 s / 10,000 条，
 *                    ≈ 最近 3.7 个月内被修改的全部页面），与上轮快照比对，
 *                    输出新增 slug 与 lastmod 前进的 slug，并入队 scan_task。
 *                    建议周期 10 分钟。**不做 absence 推断**（只看到全站的一个切片）。
 *   --mode full      抓全部 page sitemap（4 个 / gzip 620 KB / ≈5 s / 35,983 slug），
 *                    作为 absence 基准与全站 slug 快照。建议周期 4 小时。
 *   --mode threads   抓 thread 族（9 个 ≈ 90,000 thread id，无 lastmod，只给存在性）。
 *                    建议周期 1 天。
 *   --mode index     只抓索引，用来观察分片数量变化（新增第 5 个 page 分片是个信号）。
 *
 * 契约（沿用 monitor-bridge 已验证的那套，syncer/src/cli/monitor-bridge.ts:16）：
 *   · stdout **只有**最后一行 JSON 摘要，调度器可直接 JSON.parse
 *   · 一切日志走 stderr
 *   · 失败以非零码退出，交调度器重启（而不是自己在进程内 while(true) 重试）
 */

import { redirectConsoleToStderr, createLogger, emitSummary } from '../util/log.js';

// 必须在 import 任何会 console.log 的第三方库之前执行。
redirectConsoleToStderr();

import { Command } from 'commander';
import type { Pool } from 'pg';
import fs from 'node:fs';
import path from 'node:path';

import { loadConfig, type Syncer2Config } from '../config.js';
import { CircuitOpenError, HttpClient } from '../http/client.js';
import { PostgresAdaptiveEgressGate } from '../http/adaptiveEgress.js';
import {
  amcProbePolicyFor,
  assertEgressContract,
  parseProbePolicy,
  type EgressGateReport,
} from '../http/amc.js';
import {
  fetchAllPageSitemaps,
  fetchCategorySitemap,
  fetchPageSitemapDelta,
  fetchSitemapIndex,
  fetchThreadSitemaps,
  type SitemapFetchResult,
} from '../sitemap/fetch.js';
import {
  inferDeletionCandidates,
  type DeletionInferenceReport,
} from '../collect/deletion.js';
import type { SitemapEntry } from '../sitemap/parse.js';
import { normalizeSitemapEntries } from '../sitemap/normalize.js';
import { evaluateRunHealth } from '../work/runHealth.js';
import { assertTimezoneRoundTrip, createPool } from '../store/db.js';
import {
  enqueueScanTasks,
  finishIngestRun,
  insertPageScans,
  resolveSlugs,
  sitemapResultHash,
  startIngestRun,
  type PageScanRow,
  type RunStatus,
  type ScanTaskRow,
} from '../store/meta.js';
import {
  enqueueForumTargets,
  fetchKnownForumIds,
  forumQueueBreakdown,
  pendingStatusBreakdown,
  upsertPendingPages,
  type ForumEnqueueRow,
  type ForumTargetKind,
} from '../store/queues.js';
import {
  diffAgainstSnapshot,
  emptySnapshot,
  mergeIntoSnapshot,
  readSnapshot,
  replaceSnapshot,
  snapshotPath,
  writeSnapshot,
  type SitemapSnapshot,
  type SnapshotDiff,
} from '../store/snapshot.js';

const log = createLogger('sitemap-scan');

type Mode = 'delta' | 'full' | 'threads' | 'category' | 'index';

/**
 * 单轮最多往 meta.pending_page 塞多少条。
 * 空库 full 轮的候选量是 3.6 万 —— 一次全塞进去只是让一条 SQL 批变得很大，
 * 没有任何收益；截断是安全的，因为 sitemap 是**全量快照**，下一轮还会重新报告
 * （这与"diff 报过就没了"截然不同，所以这里可以截、diff 那里不能丢）。
 */
const MAX_PENDING_ENQUEUE_PER_RUN = 5_000;

interface CliOptions {
  mode: Mode;
  dryRun: boolean;
  skipTzCheck: boolean;
  pageScan: 'none' | 'changed' | 'all';
  emitEntries?: string;
  concurrency?: number;
  /** 启动自检 #3 的两个策略（require | warn | skip）。 */
  amcProbe?: string;
  proxyCheck?: string;
}

// ─── 入口 ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const opts = parseArgs();
  const config = loadConfig({ requireDatabase: !opts.dryRun });
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const populationType = sitemapPopulationType(opts.mode);

  const siteHost = new URL(config.siteBaseUrl).host;
  const http = new HttpClient({
    userAgent: config.userAgent,
    referer: config.referer,
    proxyUrl: config.proxyUrl,
    timeoutMs: config.httpTimeoutMs,
    maxAttempts: config.httpMaxAttempts,
    breaker503: config.breaker503,
    breakerReset: config.breakerReset,
    connections: Math.max(2, opts.concurrency ?? config.httpConcurrency),
    logger: log.child('http'),
    adaptiveEgress: new PostgresAdaptiveEgressGate(config.databaseUrl, `sitemap:${opts.mode}`),
    // 出口归因（TODO #12）：每 N 个请求探一次出口 IP + mihomo 节点归因。
    // **不是**每请求都探 —— 成本纪律见 http/egress.ts 文件头。
    egress: {
      probeUrl: config.exitIpProbeUrl,
      everyNRequests: config.exitIpProbeEvery,
      maxProbes: config.exitIpProbeMax,
      mihomoApi: config.mihomoApi,
      hostFilter: siteHost,
    },
  });
  // 启动自检 #1：请求头契约。缺 UA/Referer 直接拒绝启动，绝不让它退化成 503 洪水。
  http.assertHeaders();

  let pool: Pool | null = null;
  if (!opts.dryRun) {
    pool = createPool(config.databaseUrl);
    // 启动自检 #2：时区回环。防 v1 MainDbBridge 的 8 小时偏移复发。
    if (opts.skipTzCheck) {
      log.warn('--skip-tz-check：跳过时区回环自检（仅限本地调试，禁止用于调度器）');
    } else {
      await assertTimezoneRoundTrip(pool);
    }
  } else {
    log.warn('--dry-run：不连库、不写 meta.*，只跑网络侧与 diff');
  }

  let runId: number | null = null;
  // meta.ingest_run.source 的词表由 schema 侧约定（'crom' / 'wikidot_sitemap' /
  // 'wikidot_listpages' / ...），下游门控按 source 过滤，所以这里用约定 token，
  // delta/full 的区分放进 stats.mode 而不是塞进 source。
  const source = 'wikidot_sitemap';
  let probeReport: EgressGateReport | null = null;
  try {
    // 启动自检 #3：AMC POST 契约探针 + 代理健康（TODO #13）。
    //   · AMC：sitemap 是纯 GET，不经 AMC ⇒ 本通道默认 skip（每 10 分钟白打一个 POST
    //     不划算）。接 ListPages 的那天把 amcProbePolicyFor() 里的判断改掉即可，
    //     或用 --amc-probe require / SYNCER2_AMC_PROBE=require 立刻打开。
    //   · 代理健康：默认 warn。它的主要目标不是"抓不到数据"（那会自己报错），
    //     而是"代理静默回落直连、我们用家宽 IP 抓站"这种**不报错的**故障。
    const amcPolicy = parseProbePolicy(opts.amcProbe ?? config.amcProbe, amcProbePolicyFor(source));
    const proxyPolicy = parseProbePolicy(opts.proxyCheck ?? config.proxyCheck, 'warn');
    probeReport = await assertEgressContract(http, {
      baseUrl: config.siteBaseUrl,
      amcPolicy,
      proxyPolicy,
      ipProbeUrl: config.exitIpProbeUrl,
      logger: log.child('probe'),
    });

    if (pool) runId = await startIngestRun(pool, source, startedAt);

    const outcome = await runMode(opts, config, http, pool, runId, startedAt);
    const health = evaluateRunHealth({
      claimed: outcome.batchesTotal,
      processed: outcome.batchesTotal,
      partial: outcome.status === 'partial' ? Math.max(1, outcome.batchesFailed) : 0,
      failed: outcome.batchesFailed,
      breakerOpen: http.breakerOpen,
      fatalReasons:
        outcome.status === 'failed' || outcome.status === 'aborted'
          ? [`mode_outcome_${outcome.status}`]
          : [],
    });

    const durationMs = Date.now() - t0;
    const stats = {
      mode: opts.mode,
      layer: opts.mode === 'full' ? 'L2' : null,
      population_type: populationType,
      // M7 删除推断只接受 full + all；把策略落进 run，不能靠 CLI 默认值猜证据完整性。
      pageScanPolicy: opts.pageScan,
      ...outcome.stats,
      durationMs,
      http: http.stats(),
      httpHealth: http.healthStats(),
      proxy: http.proxyUrl ?? null,
      // 启动自检 #3 的结论进 stats：探针通过与否、AMC status、拿到的 category 映射
      // （站点换皮/改分类时能定位时点），以及代理泄漏判据。
      startupProbe: probeReport,
      dryRun: opts.dryRun,
      health,
    };
    let parseHealth = null;
    if (pool) {
      parseHealth = await finishIngestRun(pool, runId, {
        status: health.status,
        finishedAt: new Date().toISOString(),
        pagesEnumerated: outcome.pagesEnumerated,
        remoteTotal: outcome.remoteTotal,
        remoteTotalSource: outcome.remoteTotalSource,
        batchesTotal: outcome.batchesTotal,
        batchesFailed: outcome.batchesFailed,
        transportFailureRate: transportFailureRate(http),
        exitIpStats: exitIpStatsJson(http),
        parseFingerprint: outcome.parseFingerprint,
        populationType,
        stats,
      });
    }
    let deletionInference: DeletionInferenceReport | null = null;
    if (pool && runId !== null && opts.mode === 'full' && health.status === 'ok') {
      // 必须等 ingest_run.status='ok' 落库后再做删除推断；模块内部还会要求
      // ListPages 独立完整轮 + 紧邻上一组双源缺席，首轮绝不下任务。
      deletionInference = await inferDeletionCandidates(pool, runId);
    }

    emitSummary({
      ok: health.exitCode === 0,
      mode: opts.mode,
      runId,
      status: health.status,
      health,
      durationMs,
      ...outcome.summary,
      parseHealth,
      deletionInference,
      http: compactHttpStats(http),
      egress: compactEgress(http),
    });
    process.exitCode = health.exitCode;
  } catch (err) {
    const durationMs = Date.now() - t0;
    const breaker = err instanceof CircuitOpenError;
    log.error('本轮失败', { error: String(err), breaker });
    if (pool) {
      await finishIngestRun(pool, runId, {
        // 断路器打开 = 我们主动停手（aborted）；其它 = 真失败（failed）。
        status: breaker ? 'aborted' : 'failed',
        finishedAt: new Date().toISOString(),
        pagesEnumerated: null,
        remoteTotal: null,
        remoteTotalSource: null,
        // 失败轮的批级账：至少有一批重试耗尽（否则不会走到这里）
        batchesTotal: http.stats().requests,
        batchesFailed: 1,
        transportFailureRate: transportFailureRate(http),
        // 失败轮**尤其**要落出口归因：整轮失败时"是哪几个节点坏了"正是唯一想知道的事
        exitIpStats: exitIpStatsJson(http),
        parseFingerprint: { http_status_dist: http.healthStats().business.statusBuckets },
        stats: {
          mode: opts.mode,
          layer: opts.mode === 'full' ? 'L2' : null,
          population_type: populationType,
          pageScanPolicy: opts.pageScan,
          error: String(err),
          breaker,
          durationMs,
          http: http.stats(),
          httpHealth: http.healthStats(),
          startupProbe: probeReport,
        },
        populationType,
      }).catch((e) => log.error('收尾写 ingest_run 也失败了', { error: String(e) }));
    }
    emitSummary({
      ok: false,
      mode: opts.mode,
      runId,
      status: breaker ? 'aborted' : 'failed',
      durationMs,
      error: String(err),
      breaker,
      http: compactHttpStats(http),
      egress: compactEgress(http),
    });
    // 非零退出：交调度器重启。短进程模型下这就是全部的"自愈"机制。
    process.exitCode = 1;
  } finally {
    await http.close();
    await pool?.end().catch(() => undefined);
  }
}

function sitemapPopulationType(mode: Mode): string {
  switch (mode) {
    case 'full':
      return 'l2_sitemap_absence';
    case 'delta':
      return 'diagnostic_change_slice';
    case 'threads':
    case 'category':
      return 'forum_scoped_scan';
    case 'index':
      return 'sitemap_index_probe';
  }
}

// ─── 模式分发 ────────────────────────────────────────────────────────────────

interface ModeOutcome {
  status: RunStatus;
  pagesEnumerated: number | null;
  remoteTotal: number | null;
  remoteTotalSource: 'sitemap' | null;
  batchesTotal: number;
  batchesFailed: number;
  parseFingerprint: Record<string, unknown>;
  stats: Record<string, unknown>;
  summary: Record<string, unknown>;
}

async function runMode(
  opts: CliOptions,
  config: Syncer2Config,
  http: HttpClient,
  pool: Pool | null,
  runId: number | null,
  startedAt: string,
): Promise<ModeOutcome> {
  switch (opts.mode) {
    case 'index':
      return runIndex(http, config);
    case 'threads':
      return runExistenceOnly(http, config, 'thread', opts, pool, startedAt);
    case 'category':
      return runExistenceOnly(http, config, 'category', opts, pool, startedAt);
    case 'delta':
    case 'full':
      return runPageScan(opts, config, http, pool, runId, startedAt);
  }
}

async function runIndex(http: HttpClient, config: Syncer2Config): Promise<ModeOutcome> {
  const idx = await fetchSitemapIndex(http, config.siteBaseUrl, log);
  const byKind: Record<string, number> = {};
  for (const e of idx.entries) byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;
  return {
    status: 'ok',
    pagesEnumerated: null,
    remoteTotal: null,
    remoteTotalSource: null,
    batchesTotal: 1,
    batchesFailed: 0,
    parseFingerprint: {
      http_status_dist: http.healthStats().business.statusBuckets,
      parse_drop_rate: 0,
    },
    stats: { children: idx.entries.length, byKind, locs: idx.entries.map((e) => e.loc) },
    summary: { children: idx.entries.length, byKind },
  };
}

/**
 * thread / category 族：只有存在性，没有 lastmod。
 *
 * 除计数外，这里做 **TODO #14 的队列入队**：
 *   · thread sitemap id ∖ ingest.forum_thread.id → 新 thread 抓取；
 *   · category sitemap 正向全集 → 周期分类级完整枚举。
 *
 * 反向差集（库里有、sitemap 没有）**刻意不产出任何东西**：实测 sitemap 对
 * `翻译预定区(归档)`(882986) 与 `垃圾桶`(2020429) 两个隐藏分类系统性失明
 * （sitemap 14 个 category vs 库内 16 个；thread 反向差 3,309 条，其中两类
 * 分别贡献 1,672 / 674，另有单页讨论 950），
 * 所以"sitemap 没有"根本不构成消失证据 —— 与 page 侧 absence 要过三重门控同一条纪律。
 */
async function runExistenceOnly(
  http: HttpClient,
  config: Syncer2Config,
  kind: ForumTargetKind,
  opts: CliOptions,
  pool: Pool | null,
  startedAt: string,
): Promise<ModeOutcome> {
  const result =
    kind === 'thread'
      ? await fetchThreadSitemaps(http, config.siteBaseUrl, opts.concurrency ?? config.httpConcurrency, log)
      : await fetchCategorySitemap(http, config.siteBaseUrl, log);
  // parse_drop_rate 的定义收敛到 sitemap/normalize.ts 一处。
  // 原来这里算的是 `1 - unique/total`，把"同一 id 重复出现"也当成了解析丢弃 ——
  // 与 runPageScan 的口径不一致，会让 R10 解析健康基线在两个模式间对不上。见 normalize.ts 文件头。
  const norm = normalizeSitemapEntries(result.entries);
  maybeEmitEntries(opts, result.entries);

  // ── id 提取 ────────────────────────────────────────────────────────────────
  // thread   slug = forum/t-<id>[/...]
  // category slug = forum/c-<id>[/...]
  // 解析不出数字 id 的（站点根 URL 等）计入 skippedNoId，绝不猜。
  const numericIds = new Set<number>();
  let skippedNoId = 0;
  const idRe = kind === 'thread' ? /(?:^|\/)forum\/t-(\d+)/ : /(?:^|\/)forum\/c-(\d+)/;
  for (const slug of norm.observed.keys()) {
    const m = idRe.exec(slug);
    if (!m) {
      skippedNoId++;
      continue;
    }
    numericIds.add(Number(m[1]));
  }

  // ── thread 新 id / category 周期枚举入队 ───────────────────────────────────
  const enqueue = {
    available: false,
    known: 0,
    missing: 0,
    revived: 0,
    affected: 0,
    sampleMissing: [] as number[],
  };
  const coverage: {
    status: 'ok' | 'partial';
    absenceInference: 'disabled_global_sitemap';
    localAbsent: number;
    sampleLocalAbsent: number[];
    warning: string | null;
  } = {
    status: 'ok',
    absenceInference: 'disabled_global_sitemap',
    localAbsent: 0,
    sampleLocalAbsent: [],
    warning: null,
  };
  if (pool && !opts.dryRun && numericIds.size > 0) {
    const local = await fetchKnownForumIds(pool, kind);
    if (local.available) {
      const missing: number[] = [];
      const revived: number[] = [];
      for (const id of numericIds) {
        if (!local.known.has(id)) missing.push(id);
        else if (local.deleted.has(id)) revived.push(id);
      }
      const localAbsent = [...local.known].filter((id) => !numericIds.has(id));
      coverage.localAbsent = localAbsent.length;
      coverage.sampleLocalAbsent = localAbsent.slice(0, 50);
      if (localAbsent.length > 0) {
        coverage.status = 'partial';
        coverage.warning =
          kind === 'category'
            ? `${localAbsent.length} 个库内分类在 category sitemap 整体缺席；` +
              '分类下 thread 一律不判删，存亡只交给分类级完整枚举'
            : `${localAbsent.length} 个库内 thread 不在 thread sitemap；` +
              '全站反向差集禁止判删，存亡只交给分类级完整枚举';
        log.warn('论坛 sitemap 覆盖为 partial；反向差仅告警，不产生删除', {
          kind,
          localAbsent: localAbsent.length,
          sample: coverage.sampleLocalAbsent,
        });
      }
      const rows: ForumEnqueueRow[] =
        kind === 'category'
          ? [...numericIds].map((id) => ({
              kind,
              targetId: id,
              reasons: local.known.has(id)
                ? ['sitemap_category_enumeration']
                : ['sitemap_unknown_category', 'sitemap_category_enumeration'],
              priority: local.known.has(id) ? 1 : 5,
            }))
          : [
              ...missing.map((id) => ({
                kind,
                targetId: id,
                reasons: ['sitemap_unknown_thread'],
                priority: 5,
              })),
              // 库里标了 is_deleted 而 sitemap 仍列出 ⇒ 复活或误标。优先级更高：
              // v1 有过"页面复活但 isDeleted 没复位"的成套 bug，论坛侧同型问题要在发现层就抓住。
              ...revived.map((id) => ({
                kind,
                targetId: id,
                reasons: ['sitemap_present_but_deleted'],
                priority: 10,
              })),
            ];
      const res = await enqueueForumTargets(pool, rows, startedAt);
      enqueue.available = res.available;
      enqueue.known = local.known.size;
      enqueue.missing = missing.length;
      enqueue.revived = revived.length;
      enqueue.affected = res.affected;
      enqueue.sampleMissing = missing.slice(0, 50);
      log.info('论坛发现/分类枚举入队完成', {
        kind,
        sitemap: numericIds.size,
        known: local.known.size,
        missing: missing.length,
        revived: revived.length,
        affected: res.affected,
      });
    }
  }
  const queue = pool && !opts.dryRun ? await forumQueueBreakdown(pool) : {};

  return {
    status: 'ok',
    pagesEnumerated: norm.observed.size,
    remoteTotal: norm.observed.size,
    remoteTotalSource: 'sitemap',
    batchesTotal: result.files.length + 1,
    batchesFailed: 0,
    parseFingerprint: {
      http_status_dist: http.healthStats().business.statusBuckets,
      parse_drop_rate: norm.parseDropRate,
      sitemap_dedupe_rate: norm.dedupeRate,
      // 解析不出 forum/{t,c}-<id> 的比例。从 ~0 跳起来 = 论坛 URL 形态变了，要人看。
      forum_id_drop_rate: norm.observed.size === 0 ? 0 : skippedNoId / norm.observed.size,
    },
    stats: {
      kind,
      files: result.files.length,
      entries: result.entries.length,
      unique: norm.observed.size,
      numericIds: numericIds.size,
      skippedNoId,
      skippedNoSlug: norm.skippedNoSlug,
      duplicateSlugs: norm.duplicateSlugs,
      usedFallback: result.usedFallback,
      wireBytes: result.wireBytes,
      decodedBytes: result.decodedBytes,
      forumEnqueue: enqueue,
      forumQueue: queue,
      forumCoverage: coverage,
    },
    summary: {
      files: result.files.length,
      unique: norm.observed.size,
      numericIds: numericIds.size,
      usedFallback: result.usedFallback,
      forumKnown: enqueue.known,
      forumMissing: enqueue.missing,
      forumRevived: enqueue.revived,
      forumEnqueued: enqueue.affected,
      coverageStatus: coverage.status,
      localAbsent: coverage.localAbsent,
    },
  };
}

// ─── delta / full 主流程 ─────────────────────────────────────────────────────

async function runPageScan(
  opts: CliOptions,
  config: Syncer2Config,
  http: HttpClient,
  pool: Pool | null,
  runId: number | null,
  startedAt: string,
): Promise<ModeOutcome> {
  const isFull = opts.mode === 'full';
  const result: SitemapFetchResult = isFull
    ? await fetchAllPageSitemaps(http, config.siteBaseUrl, opts.concurrency ?? config.httpConcurrency, log)
    : await fetchPageSitemapDelta(http, config.siteBaseUrl, log);

  maybeEmitEntries(opts, result.entries);

  // slug 归一化 + 去重（同一 slug 在多分片里重复出现时取 lastmod 更新的那条）。
  // 逻辑本体在 sitemap/normalize.ts —— 提出去是为了能单测，它是 parse_drop_rate 的唯一产地。
  const norm = normalizeSitemapEntries(result.entries);
  const observed = norm.observed;
  const skippedNoSlug = norm.skippedNoSlug;
  const skippedNoLastmod = norm.skippedNoLastmod;

  // dry-run 用独立的快照文件：既让 --dry-run 之间自成一致（可以连跑两轮验证 diff），
  // 又保证它永远污染不到真实快照。
  const snapFile = snapshotPath(config.stateDir, opts.dryRun ? 'sitemap-page.dryrun' : 'sitemap-page');
  const previous = readSnapshot(snapFile);
  const bootstrap = previous === null;
  const base = previous ?? emptySnapshot();
  const diff: SnapshotDiff = bootstrap
    ? { newSlugs: [], advanced: [], regressed: [], unchanged: observed.size }
    : diffAgainstSnapshot(observed, base);

  log.info('diff 完成', {
    mode: opts.mode,
    bootstrap,
    observed: observed.size,
    new: diff.newSlugs.length,
    advanced: diff.advanced.length,
    regressed: diff.regressed.length,
    unchanged: diff.unchanged,
  });

  // ── 落库 ────────────────────────────────────────────────────────────────
  const changedSlugs = [...diff.newSlugs, ...diff.advanced.map((a) => a.slug)];
  let resolution = { source: 'skipped' as string, map: new Map<string, number>() };
  let pageScansWritten = 0;
  let tasksEnqueued = 0;
  const unresolvedSlugs: string[] = [];
  let pendingEnqueue = {
    available: false,
    candidates: 0,
    enqueued: 0,
    truncated: 0,
    pendingTotal: 0,
    byStatus: {} as Record<string, number>,
  };

  /** 本轮要入 meta.pending_page 的（slug → 入队理由）。 */
  const pendingReasons = new Map<string, Set<string>>();
  const noteUnresolved = (slug: string, reason: string): void => {
    unresolvedSlugs.push(slug);
    const s = pendingReasons.get(slug) ?? new Set<string>();
    s.add(reason);
    pendingReasons.set(slug, s);
  };

  if (pool && !opts.dryRun) {
    // 要解析哪些 slug：page_scan 写 all 时是全量，否则只解析变化页（省一次全表 ANY 查询）
    const toResolve = opts.pageScan === 'all' ? [...observed.keys()] : changedSlugs;
    resolution = await resolveSlugs(pool, toResolve);

    // (1) page_scan：本轮"确实看见了这个页面"的正面证据
    if (opts.pageScan !== 'none') {
      const scanSource = opts.pageScan === 'all' ? [...observed.keys()] : changedSlugs;
      const rows: PageScanRow[] = [];
      for (const slug of scanSource) {
        const pageId = resolution.map.get(slug);
        if (pageId === undefined) continue;
        rows.push({
          pageId,
          kind: 'meta',
          status: 'ok',
          claimedTotal: null,
          fetchedTotal: null,
          resultHash: sitemapResultHash(slug, observed.get(slug) ?? null),
        });
      }
      pageScansWritten = await insertPageScans(pool, runId, rows, startedAt);
    }

    // (2) scan_task：发现层产物
    const tasks: ScanTaskRow[] = [];
    for (const slug of diff.newSlugs) {
      const pageId = resolution.map.get(slug);
      if (pageId === undefined) {
        // 新 slug 在库里没有身份行 —— 这是**真·新页**，page_id 还不存在。
        // 不能进 scan_task（page_id NOT NULL），改进 meta.pending_page，
        // 由 resolve-pages CLI 整页 GET 取 WIKIREQUEST.info.pageId 后 register_page。
        noteUnresolved(slug, 'sitemap_new_slug');
        continue;
      }
      // 已有身份行却在快照里没见过 = 改名或页面重新进入 page_1 切片，都按 meta 重扫。
      tasks.push({ pageId, kind: 'meta', reasons: ['sitemap_new_slug'], priority: 10 });
    }
    for (const a of diff.advanced) {
      const pageId = resolution.map.get(a.slug);
      if (pageId === undefined) {
        noteUnresolved(a.slug, 'sitemap_lastmod_advanced_unresolved');
        continue;
      }
      tasks.push({ pageId, kind: 'content', reasons: ['sitemap_lastmod_advanced'], priority: 5 });
    }
    tasksEnqueued = await enqueueScanTasks(pool, tasks);

    // (3) pending_page：**本轮解析集里所有解析不到 page_id 的 slug**（TODO #14）
    //
    // 为什么不只收 diff.newSlugs：diff 是"与上一轮快照比"，而 pending 的判据是
    // "库里有没有身份行"。两者不是一回事 —— 冷启动/回填中断时，一个 slug 早就
    // 在快照里（于是永远不是 new），但库里始终没有 page_id。只收 newSlugs 会让
    // 这批页**永久**没人管，正是"发现了但没消化"的静默丢失。
    // 代价：全量 full 轮在空库上会一次性报出 3.6 万条 —— 这不是 bug，是真实积压，
    // 由消化侧的冷启动闸（config.pendingColdStart）决定"这活该不该由发现层的
    // 消化者干"，而不是在这里假装看不见。
    if (resolution.source !== 'unavailable') {
      for (const slug of toResolve) {
        if (!resolution.map.has(slug) && !pendingReasons.has(slug)) {
          noteUnresolved(slug, 'sitemap_slug_without_identity');
        }
      }
    }

    // 单轮入队上限：防止一次 full 轮把 3.6 万条塞成一条巨大的 INSERT 批。
    // 超出的部分不丢 —— 下一轮 full 还会重新报告（sitemap 是全量快照，
    // 不像 diff 那样"报过就没了"），所以截断是安全的、可收敛的。
    const all = [...pendingReasons.entries()].map(([slug, reasons]) => ({
      slug,
      reasons: [...reasons].sort(),
      // 真·新页（本轮才第一次出现）优先级更高：实测 37.9% 的最终被删页活不过 24 小时，
      // 新页的身份不早点铸出来，票/评论就永远挂不上（R7）。
      priority: reasons.has('sitemap_new_slug') ? 10 : 0,
      discoveredBy: 'wikidot_sitemap',
    }));
    const batch = all.slice(0, MAX_PENDING_ENQUEUE_PER_RUN);
    const res = await upsertPendingPages(pool, batch, startedAt);
    pendingEnqueue = {
      available: res.available,
      candidates: all.length,
      enqueued: res.affected,
      truncated: all.length - batch.length,
      pendingTotal: res.pendingTotal,
      byStatus: await pendingStatusBreakdown(pool),
    };
    if (pendingEnqueue.truncated > 0) {
      log.warn('pending_page 入队被截断（下一轮 full 会重新报告，不会丢）', {
        candidates: all.length,
        enqueued: batch.length,
        cap: MAX_PENDING_ENQUEUE_PER_RUN,
      });
    }
    log.info('pending_page 入队完成', pendingEnqueue);
  }

  // ── 写快照 ────────────────────────────────────────────────────────────────
  // 放在落库之后，且**只有本轮的发现确实被记录下来了**才推进：
  //   · 落库抛异常 → 走不到这里 → 快照不动 → 下一轮重算同一批 diff（不丢发现）
  //   · meta.* 表还没建（runId===null）→ 同样不推进，否则这批 diff 就永远消失了
  // "宁可重复报告，绝不静默丢弃" 是发现层的基本取向。
  const snapshotAdvanced = opts.dryRun || runId !== null;
  if (snapshotAdvanced) {
    const at = new Date().toISOString();
    const next: SitemapSnapshot = isFull
      ? replaceSnapshot(observed, at)
      : mergeIntoSnapshot(base, observed, at);
    writeSnapshot(snapFile, next);
  } else {
    log.warn('meta.ingest_run 不可用，本轮不推进快照（下一轮会重算同一批 diff，不丢发现）');
  }

  const summary = {
    bootstrap,
    entries: result.entries.length,
    uniqueSlugs: observed.size,
    files: result.files.length,
    usedFallback: result.usedFallback,
    newSlugs: diff.newSlugs.length,
    advanced: diff.advanced.length,
    regressed: diff.regressed.length,
    unchanged: diff.unchanged,
    unresolvedSlugs: unresolvedSlugs.length,
    // 删除推断必须等本 run 收尾成 status=ok 后由 collect/deletion.ts 执行；
    // 这里保留旧摘要键但不提前声称有资格。
    absentEligible: false,
    absent: 0,
    absenceCircuitTripped: false,
    pageScansWritten,
    tasksEnqueued,
    pendingEnqueued: pendingEnqueue.enqueued,
    pendingCandidates: pendingEnqueue.candidates,
    pendingTotal: pendingEnqueue.pendingTotal,
    snapshotAdvanced,
    slugResolution: resolution.source,
    wireBytes: result.wireBytes,
    decodedBytes: result.decodedBytes,
  };

  return {
    status: 'ok',
    pagesEnumerated: observed.size,
    // full 轮的 sitemap 计数本身就是 remote_total 的一个独立信源（与 %%total%% 交叉）。
    // delta 轮只覆盖切片，给 remote_total 赋值会让 coverage_ratio 变成一个假的 1.0。
    remoteTotal: isFull ? observed.size : null,
    remoteTotalSource: isFull ? 'sitemap' : null,
    batchesTotal: result.files.length + 1,
    batchesFailed: 0,
    parseFingerprint: {
      http_status_dist: http.healthStats().business.statusBuckets,
      // 解析丢弃率：被丢掉的条目（无 slug 的站点根）/ 总条目。
      // 这个数一旦从 ~0.0001 跳起来，说明 loc 格式变了，是 R10 全局解析健康熔断的输入。
      parse_drop_rate: norm.parseDropRate,
      sitemap_missing_lastmod_rate: norm.missingLastmodRate,
      sitemap_dedupe_rate: norm.dedupeRate,
    },
    stats: {
      ...summary,
      skippedNoSlug,
      skippedNoLastmod,
      duplicateSlugs: norm.duplicateSlugs,
      absenceReason: 'deferred_until_run_finished',
      pendingEnqueue,
      // 明细截断：ingest_run.stats 不该变成事实存储
      sampleNewSlugs: diff.newSlugs.slice(0, 50),
      sampleAdvanced: diff.advanced.slice(0, 50),
      sampleRegressed: diff.regressed.slice(0, 50),
      sampleAbsent: [],
      sampleUnresolvedSlugs: unresolvedSlugs.slice(0, 200),
      fileBreakdown: result.files.map((f) => ({
        url: f.url,
        entries: f.entries.length,
        wireBytes: f.wireBytes,
        decodedBytes: f.decodedBytes,
        ms: Math.round(f.durationMs),
      })),
    },
    summary,
  };
}

// ─── 辅助 ────────────────────────────────────────────────────────────────────

function maybeEmitEntries(opts: CliOptions, entries: readonly SitemapEntry[]): void {
  if (!opts.emitEntries) return;
  const file = path.resolve(opts.emitEntries);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // NDJSON：给"sitemap 刷新周期实测"那一步直接消费，也方便 diff 两次快照。
  const out = entries
    .map((e) => JSON.stringify({ slug: e.slug, lastmod: e.lastmod, lastmodRaw: e.lastmodRaw, loc: e.loc }))
    .join('\n');
  fs.writeFileSync(file, out + '\n', 'utf-8');
  log.info('条目已导出', { file, entries: entries.length });
}

/** 传输层失败率（未拿到状态码的尝试 / 总尝试）。实测基线 ≈0.023，是 IP 池健康度的单一指标。 */
function transportFailureRate(http: HttpClient): number | null {
  const s = http.healthStats().business;
  if (s.requests === 0) return null;
  return s.transportFailures / s.requests;
}

/**
 * 出口归因落库形态（meta.ingest_run.exit_ip_stats）。
 * 未开启归因时返回 `{}` 而不是 null —— 该列 NOT NULL DEFAULT '{}'，
 * 而且"归因没开"与"归因开了但一个都没采到"必须能区分开：前者 `{}`，
 * 后者有 probe/mihomo 字段但 byIp/byNode 为空。
 */
function exitIpStatsJson(http: HttpClient): Record<string, unknown> {
  const s = http.exitIpStats();
  return s === null ? {} : (s as unknown as Record<string, unknown>);
}

/** 摘要里的出口归因（只留能一眼看懂的几项）。 */
function compactEgress(http: HttpClient): Record<string, unknown> | null {
  const s = http.exitIpStats();
  if (s === null) return null;
  return {
    exitIps: Object.keys(s.byIp),
    nodes: Object.keys(s.byNode),
    probes: s.probe.ok,
    probeFailed: s.probe.failed,
    mihomo: s.mihomo.reachable,
    failureByNode: s.transportFailureByNode,
  };
}

function compactHttpStats(http: HttpClient): Record<string, unknown> {
  const s = http.stats();
  return {
    requests: s.requests,
    attempts: s.attempts,
    retries: s.retries,
    wireBytes: s.wireBytes,
    decodedBytes: s.decodedBytes,
    statusBuckets: s.statusBuckets,
    breakerOpen: s.breakerOpen,
  };
}

function parseArgs(): CliOptions {
  const program = new Command();
  // commander 默认把 help/错误写 stdout，会污染 JSON 摘要 —— 全部改道 stderr。
  program.configureOutput({
    writeOut: (s) => process.stderr.write(s),
    writeErr: (s) => process.stderr.write(s),
  });
  program
    .name('sitemap-scan')
    .description('单次短进程：抓 sitemap、与上轮快照 diff、写 meta.ingest_run / page_scan / scan_task')
    .requiredOption('--mode <mode>', 'delta | full | threads | category | index')
    .option('--dry-run', '不连库、不写 meta.*、不推进快照，只跑网络侧与 diff', false)
    .option('--skip-tz-check', '跳过时区回环自检（仅限本地调试）', false)
    .option(
      '--page-scan <policy>',
      'page_scan 写入策略：none | changed | all（默认 delta=changed, full=all）',
    )
    .option('--emit-entries <file>', '把本轮条目导出为 NDJSON（供刷新周期实测用）')
    .option('--concurrency <n>', 'sitemap 并发请求数', (v) => Number(v))
    .option(
      '--amc-probe <policy>',
      '启动自检 #3 的 AMC POST 契约探针：require | warn | skip（sitemap 通道默认 skip，纯 GET 不经 AMC）',
    )
    .option(
      '--proxy-check <policy>',
      '启动自检 #3 的代理健康探测：require | warn | skip（默认 warn；抓"代理静默回落直连"）',
    );

  program.parse(process.argv);
  const raw = program.opts<{
    mode: string;
    dryRun: boolean;
    skipTzCheck: boolean;
    pageScan?: string;
    emitEntries?: string;
    concurrency?: number;
    amcProbe?: string;
    proxyCheck?: string;
  }>();

  const mode = raw.mode as Mode;
  if (!['delta', 'full', 'threads', 'category', 'index'].includes(mode)) {
    throw new Error(`未知 --mode: ${raw.mode}`);
  }
  const pageScan = (raw.pageScan ?? (mode === 'full' ? 'all' : 'changed')) as CliOptions['pageScan'];
  if (!['none', 'changed', 'all'].includes(pageScan)) {
    throw new Error(`未知 --page-scan: ${raw.pageScan}`);
  }

  return {
    mode,
    dryRun: Boolean(raw.dryRun),
    skipTzCheck: Boolean(raw.skipTzCheck),
    pageScan,
    ...(raw.emitEntries ? { emitEntries: raw.emitEntries } : {}),
    ...(raw.concurrency !== undefined && Number.isFinite(raw.concurrency)
      ? { concurrency: raw.concurrency }
      : {}),
    ...(raw.amcProbe ? { amcProbe: raw.amcProbe } : {}),
    ...(raw.proxyCheck ? { proxyCheck: raw.proxyCheck } : {}),
  };
}

main().catch((err) => {
  // main() 内部已经处理了绝大多数失败；能到这里的是参数解析/配置类错误。
  log.error('致命错误', { error: String(err) });
  emitSummary({ ok: false, status: 'failed', error: String(err) });
  process.exitCode = 1;
});
