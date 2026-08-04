/**
 * resolve-pages —— meta.pending_page 的**消化者**（TODO #14 的另一半），单次短进程。
 *
 * 链路：认领 N 条 pending slug → 整页 GET → 抽 `WIKIREQUEST.info.pageId`
 *      → `ingest.register_page(wikidot_id, slug)` → 回填 page_id / status='resolved'
 *      → 顺手给新铸的 page 下一个 `scan_task(kind='meta')`（元数据还没抓过）
 *        与 `scan_task(kind='new_page_highfreq')`（实测 37.9% 的被删页活不过 24 小时，
 *        83.2% 活不过 7 天，新页必须进 2–4h 高频队列而不是 sweep 轮转）。
 *        若发现原因来自 L0 updated_at 窗口，再补 content + revisions_full；这样改名/新页
 *        在拿到 page_id 前不会丢掉 L0 已发现的内容编辑。
 *
 * ── 三条硬纪律 ──────────────────────────────────────────────────────────────
 * 1. **逐页独立容错。** 实测 `@ukwhatn/wikidot` 的 acquirePageIds 是"批量"接口但
 *    物理上每页一个 GET，且**任一页正则匹配不到就 throw 整批失败**
 *    （api-survey#176）。sitemap 的 TTL≈60 min 意味着我们看到的 slug 里必然混着
 *    已被删掉的页 —— 那种"整批失败"语义在这里等于每轮都白跑。
 *    所以：一页一个结果，失败只影响它自己（`page/identity.ts` 用返回值而不是异常表达失败）。
 * 2. **冷启动闸。** pending 超过阈值（默认 2000）时**拒绝自动跑**：空库有 3.6 万条待解析，
 *    一页一个 GET = 3.6 万请求，而 field-matrix 的结论是"绝不为全站 36k 页各打一次 GET"。
 *    冷启动该走 Phase 2 批量回填。要强行跑得显式加 --force-cold-start。
 * 3. **失败不丢。** 404 → status='gone'（不是错误，是竞态）；200 但 pageUnixName 不匹配
 *    → status='mismatch' 且**不注册**；其它失败 → 保留在队列里 + 指数退避（1h/4h/24h/7d）。
 *
 * CLI 契约与 sitemap-scan 一致：stdout 只有最后一行 JSON 摘要，日志走 stderr，
 * 失败非零退出交调度器。
 */

import { redirectConsoleToStderr, createLogger, emitSummary } from '../util/log.js';

redirectConsoleToStderr();

import { Command } from 'commander';
import type { Pool } from 'pg';
import os from 'node:os';

import { loadConfig } from '../config.js';
import { CircuitOpenError, HttpClient } from '../http/client.js';
import { amcProbePolicyFor, assertEgressContract, parseProbePolicy } from '../http/amc.js';
import { fetchPageIdentity } from '../page/identity.js';
import { assertTimezoneRoundTrip, createPool } from '../store/db.js';
import { enqueueScanTasks, finishIngestRun, startIngestRun, type ScanTaskRow } from '../store/meta.js';
import {
  backoffFrom,
  claimPendingPages,
  countPendingPages,
  finishPendingPage,
  lookupIdentityByWikidotId,
  pendingStatusBreakdown,
  registerPage,
  releasePendingPageClaim,
} from '../store/queues.js';

const log = createLogger('resolve-pages');

/** 采集通道标签：进 meta.ingest_run.source。 */
const SOURCE = 'wikidot_page_identity';

interface CliOptions {
  limit: number;
  concurrency: number;
  skipTzCheck: boolean;
  forceColdStart: boolean;
  dryRun: boolean;
  amcProbe?: string;
  proxyCheck?: string;
}

async function main(): Promise<void> {
  const opts = parseArgs();
  const config = loadConfig();
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const workerId = `${os.hostname()}:${process.pid}`;

  const http = new HttpClient({
    userAgent: config.userAgent,
    referer: config.referer,
    proxyUrl: config.proxyUrl,
    timeoutMs: config.httpTimeoutMs,
    maxAttempts: config.httpMaxAttempts,
    breaker503: config.breaker503,
    breakerReset: config.breakerReset,
    connections: Math.max(2, opts.concurrency),
    logger: log.child('http'),
    egress: {
      probeUrl: config.exitIpProbeUrl,
      everyNRequests: config.exitIpProbeEvery,
      maxProbes: config.exitIpProbeMax,
      mihomoApi: config.mihomoApi,
      hostFilter: new URL(config.siteBaseUrl).host,
    },
  });
  http.assertHeaders(); // 自检 #1

  const pool = createPool(config.databaseUrl);
  let runId: number | null = null;
  const counters = {
    claimed: 0,
    resolved: 0,
    /** wikidot_id 已存在且 slug 一致 —— 幂等命中（不是新铸）。 */
    alreadyRegistered: 0,
    /** wikidot_id 已存在但当前 slug 不同 = **改名**，交 apply_page_meta 处理。 */
    renamed: 0,
    gone: 0,
    mismatch: 0,
    failed: 0,
    writeFreezeSkipped: 0,
    tasksEnqueued: 0,
  };
  const samples: Array<Record<string, unknown>> = [];

  try {
    if (opts.skipTzCheck) {
      log.warn('--skip-tz-check：跳过时区回环自检（仅限本地调试）');
    } else {
      await assertTimezoneRoundTrip(pool); // 自检 #2
    }

    // 自检 #3：整页 GET 也不经 AMC，所以本通道默认 skip；代理健康默认 warn。
    const probeReport = await assertEgressContract(http, {
      baseUrl: config.siteBaseUrl,
      amcPolicy: parseProbePolicy(opts.amcProbe ?? config.amcProbe, amcProbePolicyFor(SOURCE)),
      proxyPolicy: parseProbePolicy(opts.proxyCheck ?? config.proxyCheck, 'warn'),
      ipProbeUrl: config.exitIpProbeUrl,
      logger: log.child('probe'),
    });

    // ── 冷启动闸 ────────────────────────────────────────────────────────────
    const pendingTotal = await countPendingPages(pool);
    if (pendingTotal > config.pendingColdStart && !opts.forceColdStart) {
      const msg =
        `pending_page 待解析 ${pendingTotal} 条 > 冷启动阈值 ${config.pendingColdStart}。` +
        `这是**冷启动/大回填**形态，不是日常增量（实测新页+改名合计 30–80/天）。` +
        `一页一个整页 GET 会变成上万次请求，与 field-matrix 的"绝不为全站 36k 页各打一次 GET"直接冲突。` +
        `请走 Phase 2 批量回填；确实要用本 CLI 顶上，加 --force-cold-start。`;
      log.error('冷启动闸拦截', { pendingTotal, threshold: config.pendingColdStart });
      runId = await startIngestRun(pool, SOURCE, startedAt);
      await finishIngestRun(pool, runId, {
        status: 'aborted',
        finishedAt: new Date().toISOString(),
        pagesEnumerated: 0,
        remoteTotal: null,
        batchesTotal: 0,
        batchesFailed: 0,
        exitIpStats: http.exitIpStats() as unknown as Record<string, unknown>,
        stats: { coldStartBlocked: true, pendingTotal, threshold: config.pendingColdStart, startupProbe: probeReport },
      });
      emitSummary({
        ok: false,
        status: 'aborted',
        runId,
        coldStartBlocked: true,
        pendingTotal,
        threshold: config.pendingColdStart,
        message: msg,
      });
      process.exitCode = 1;
      return;
    }

    runId = await startIngestRun(pool, SOURCE, startedAt);

    // ── 认领 ────────────────────────────────────────────────────────────────
    const claimed = await claimPendingPages(pool, opts.limit, workerId);
    counters.claimed = claimed.length;
    log.info('已认领待解析 slug', { claimed: claimed.length, limit: opts.limit, pendingTotal });

    // ── 逐页解析（并发受限，出口礼貌）──────────────────────────────────────
    await mapLimited(claimed, opts.concurrency, async (row) => {
      const observedAt = new Date().toISOString();
      try {
        const outcome = await fetchPageIdentity(http, config.siteBaseUrl, row.slug, log);

        if (outcome.kind === 'gone') {
          counters.gone++;
          await finishPendingPage(pool, {
            slug: row.slug,
            status: 'gone',
            httpStatus: outcome.httpStatus,
            error: outcome.error,
          });
          return;
        }
        if (outcome.kind === 'mismatch') {
          counters.mismatch++;
          await finishPendingPage(pool, {
            slug: row.slug,
            status: 'mismatch',
            wikidotId: outcome.identity.wikidotId,
            categoryId: outcome.identity.categoryId,
            observedSlug: outcome.observedSlug,
            httpStatus: outcome.httpStatus,
            error: `pageUnixName=${outcome.observedSlug} ≠ 请求 slug=${row.slug}，拒绝注册`,
            // 别名/重定向不会自己消失，退避到最长一档，避免每轮都白打一次 GET
            notBefore: backoffFrom(4),
          });
          return;
        }
        if (outcome.kind === 'failed') {
          counters.failed++;
          await finishPendingPage(pool, {
            slug: row.slug,
            status: 'failed',
            httpStatus: outcome.httpStatus,
            error: outcome.error,
            notBefore: backoffFrom(row.attempts),
          });
          return;
        }

        // ── ok：铸身份 ────────────────────────────────────────────────────
        if (opts.dryRun) {
          counters.resolved++;
          samples.push({
            slug: row.slug,
            wikidotId: outcome.identity.wikidotId,
            categoryId: outcome.identity.categoryId,
            dryRun: true,
          });
          return;
        }
        // 先查这个 wikidot_id 是否已经有身份行（本地 SQL，零 wikidot 成本）。
        // 三种情形必须分开，否则**改名会被静默吞掉** —— 见 queues.ts
        // lookupIdentityByWikidotId 的注释（register_page 刻意不改 slug）。
        const existing = await lookupIdentityByWikidotId(pool, outcome.identity.wikidotId);
        let pageId: number;
        const tasks: ScanTaskRow[] = [];

        if (existing === null) {
          // (a) 真·新页：铸身份 + 两个任务（元数据从没抓过；新页进 2–4h 高频队列，R7）
          pageId = await registerPage(pool, {
            wikidotId: outcome.identity.wikidotId,
            slug: row.slug,
            observedAt,
            source: 'wikidot',
            runId,
          });
          counters.resolved++;
          tasks.push(
            { pageId, kind: 'meta', reasons: ['identity_registered'], priority: 10 },
            { pageId, kind: 'new_page_highfreq', reasons: ['identity_registered'], priority: 20 },
          );
          await finishPendingPage(pool, {
            slug: row.slug,
            status: 'resolved',
            wikidotId: outcome.identity.wikidotId,
            pageId,
            categoryId: outcome.identity.categoryId,
            observedSlug: outcome.identity.pageUnixName,
            httpStatus: outcome.httpStatus,
            error: null,
          });
        } else if (existing.currentSlug !== null && existing.currentSlug !== row.slug) {
          // (b) **改名**：wikidot_id 已在库里，但当前 slug 是另一个。
          //     身份是解析出来了（page_id 已知），但 slug 的 SCD2 关旧开新 +
          //     page_life_event('renamed') 只能由 ingest.apply_page_meta 做 ——
          //     本 CLI 无权替它决定。所以：pending 标 resolved（身份确实解析完了）、
          //     把改名事实写进 last_error 留痕、并下一个 kind='meta' 的高优任务。
          pageId = existing.pageId;
          counters.renamed++;
          tasks.push({
            pageId,
            kind: 'meta',
            reasons: ['identity_rename_detected'],
            priority: 20,
          });
          await finishPendingPage(pool, {
            slug: row.slug,
            status: 'resolved',
            wikidotId: outcome.identity.wikidotId,
            pageId,
            categoryId: outcome.identity.categoryId,
            observedSlug: outcome.identity.pageUnixName,
            httpStatus: outcome.httpStatus,
            error:
              `改名：wikidot_id=${outcome.identity.wikidotId} 当前 slug=${existing.currentSlug}，` +
              `本轮在 sitemap 见到 ${row.slug}。slug 的 SCD2 变更归 apply_page_meta，` +
              `已下 scan_task(kind='meta')。`,
          });
          log.warn('检测到改名，已交给 apply_page_meta 路径', {
            slug: row.slug,
            currentSlug: existing.currentSlug,
            pageId,
          });
        } else {
          // (c) 已注册且 slug 一致：幂等命中（并发/重复入队/上一轮崩在回写前）
          pageId = existing.pageId;
          counters.alreadyRegistered++;
          await finishPendingPage(pool, {
            slug: row.slug,
            status: 'resolved',
            wikidotId: outcome.identity.wikidotId,
            pageId,
            categoryId: outcome.identity.categoryId,
            observedSlug: outcome.identity.pageUnixName,
            httpStatus: outcome.httpStatus,
            error: null,
          });
        }

        if (row.reasons.includes('l0_updated_at_window')) {
          tasks.push(
            {
              pageId,
              kind: 'content',
              reasons: ['l0_updated_at_window_after_identity'],
              priority: 40,
            },
            {
              pageId,
              kind: 'revisions_full',
              reasons: ['l0_updated_at_window_after_identity'],
              priority: 40,
            },
          );
          const metaTask = tasks.find((task) => task.kind === 'meta');
          if (metaTask === undefined) {
            tasks.push({
              pageId,
              kind: 'meta',
              reasons: ['l0_new_or_renamed_page_after_identity'],
              priority: 40,
            });
          } else {
            metaTask.reasons = [
              ...new Set([...metaTask.reasons, 'l0_new_or_renamed_page_after_identity']),
            ];
            metaTask.priority = Math.max(metaTask.priority ?? 0, 40);
          }
        }
        counters.tasksEnqueued += await enqueueScanTasks(pool, tasks);

        if (samples.length < 20) {
          samples.push({
            slug: row.slug,
            wikidotId: outcome.identity.wikidotId,
            pageId,
            categoryId: outcome.identity.categoryId,
            themeId: outcome.identity.themeId,
            ms: Math.round(outcome.durationMs),
            wireBytes: outcome.wireBytes,
          });
        }
      } catch (err) {
        // CircuitOpenError 要中断整轮（出口坏了），其它异常只算这一页失败
        if (err instanceof CircuitOpenError) throw err;
        if (pgCode(err) === 'PGF01') {
          counters.writeFreezeSkipped++;
          await releasePendingPageClaim(pool, row.slug, workerId);
          log.warn('写冻结跳过 pending page；不计失败/健康分母', {
            slug: row.slug,
          });
          return;
        }
        counters.failed++;
        log.warn('单页解析异常（不影响其它页）', { slug: row.slug, error: String(err) });
        await finishPendingPage(pool, {
          slug: row.slug,
          status: 'failed',
          error: String(err),
          notBefore: backoffFrom(row.attempts),
        }).catch(() => undefined);
      }
    });

    const byStatus = await pendingStatusBreakdown(pool);
    const durationMs = Date.now() - t0;
    // 判定：认领了却一条都没成功（且不是"全是 gone"）= 本轮失败，交调度器重启
    const hardFailure =
      counters.claimed - counters.writeFreezeSkipped > 0 &&
      counters.resolved === 0 &&
      counters.alreadyRegistered === 0 &&
      counters.renamed === 0 &&
      counters.gone === 0;
    const status = hardFailure ? 'failed' : 'ok';

    await finishIngestRun(pool, runId, {
      status,
      finishedAt: new Date().toISOString(),
      pagesEnumerated: counters.resolved + counters.alreadyRegistered + counters.renamed,
      remoteTotal: null,
      batchesTotal: counters.claimed - counters.writeFreezeSkipped,
      batchesFailed: counters.failed,
      transportFailureRate: transportFailureRate(http),
      exitIpStats: http.exitIpStats() as unknown as Record<string, unknown>,
      parseFingerprint: {
        http_status_dist: http.healthStats().business.statusBuckets,
        // 解析丢弃率：抓到 200 却抽不出 pageId 的比例。跳起来 = 页面模板变了。
        identity_parse_drop_rate:
          counters.claimed - counters.writeFreezeSkipped === 0
            ? null
            : counters.failed / (counters.claimed - counters.writeFreezeSkipped),
        sample_counts: {
          identity_parse_drop_rate: counters.claimed - counters.writeFreezeSkipped,
        },
      },
      populationType: 'targeted_queue',
      healthDecisionSkipReason:
        counters.claimed > 0 &&
        counters.claimed === counters.writeFreezeSkipped
          ? 'write_freeze_only'
          : null,
      stats: {
        mode: 'resolve_pages',
        population_type: 'targeted_queue',
        ...counters,
        healthExclusions: {
          write_freeze: counters.writeFreezeSkipped,
        },
        durationMs,
        pendingBefore: pendingTotal,
        pendingByStatus: byStatus,
        http: http.stats(),
        httpHealth: http.healthStats(),
        startupProbe: probeReport,
        samples,
      },
    });

    emitSummary({
      ok: status === 'ok',
      status,
      runId,
      durationMs,
      ...counters,
      pendingBefore: pendingTotal,
      pendingByStatus: byStatus,
      http: {
        requests: http.stats().requests,
        statusBuckets: http.stats().statusBuckets,
        wireBytes: http.stats().wireBytes,
      },
      egress: {
        exitIps: Object.keys(http.exitIpStats()?.byIp ?? {}),
        nodes: Object.keys(http.exitIpStats()?.byNode ?? {}),
      },
    });
    process.exitCode = status === 'ok' ? 0 : 1;
  } catch (err) {
    const breaker = err instanceof CircuitOpenError;
    const durationMs = Date.now() - t0;
    log.error('本轮失败', { error: String(err), breaker });
    await finishIngestRun(pool, runId, {
      status: breaker ? 'aborted' : 'failed',
      finishedAt: new Date().toISOString(),
      pagesEnumerated: counters.resolved + counters.alreadyRegistered + counters.renamed,
      remoteTotal: null,
      batchesTotal: counters.claimed,
      batchesFailed: counters.failed,
      transportFailureRate: transportFailureRate(http),
      exitIpStats: http.exitIpStats() as unknown as Record<string, unknown>,
      stats: {
        ...counters,
        error: String(err),
        breaker,
        durationMs,
        http: http.stats(),
        httpHealth: http.healthStats(),
      },
    }).catch((e) => log.error('收尾写 ingest_run 也失败了', { error: String(e) }));
    emitSummary({
      ok: false,
      status: breaker ? 'aborted' : 'failed',
      runId,
      durationMs,
      error: String(err),
      breaker,
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

/**
 * 受限并发 map，**不因单个任务失败而拒绝整批**（fn 内部已自行处理失败；
 * 只有 CircuitOpenError 这类进程级错误会冒泡出来）。
 * 刻意不用 Promise.all(map) —— 那是 acquirePageIds"一页失败整批失败"的形状。
 */
async function mapLimited<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  const effective = Math.max(1, Math.min(limit, items.length || 1));
  let cursor = 0;
  const workers = Array.from({ length: effective }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      await fn(items[i] as T);
    }
  });
  await Promise.all(workers);
}

function transportFailureRate(http: HttpClient): number | null {
  const s = http.healthStats().business;
  if (s.requests === 0) return null;
  return s.transportFailures / s.requests;
}

function parseArgs(): CliOptions {
  const program = new Command();
  program.configureOutput({
    writeOut: (s) => process.stderr.write(s),
    writeErr: (s) => process.stderr.write(s),
  });
  program
    .name('resolve-pages')
    .description('消化 meta.pending_page：整页 GET 取 WIKIREQUEST.info.pageId → ingest.register_page')
    .option('--limit <n>', '本轮最多解析多少页（每页 1 次整页 GET）', (v) => Number(v), 50)
    .option('--concurrency <n>', '并发页数（保持个位数，出口礼貌）', (v) => Number(v), 2)
    .option('--skip-tz-check', '跳过时区回环自检（仅限本地调试）', false)
    .option('--force-cold-start', '越过冷启动闸（pending 超阈值时仍然跑）', false)
    .option('--dry-run', '只解析不写库（不 register_page、不回填 pending_page）', false)
    .option('--amc-probe <policy>', 'AMC 契约探针：require | warn | skip（本通道默认 skip）')
    .option('--proxy-check <policy>', '代理健康探测：require | warn | skip（默认 warn）');

  program.parse(process.argv);
  const raw = program.opts<{
    limit: number;
    concurrency: number;
    skipTzCheck: boolean;
    forceColdStart: boolean;
    dryRun: boolean;
    amcProbe?: string;
    proxyCheck?: string;
  }>();

  const limit = Number.isFinite(raw.limit) && raw.limit > 0 ? Math.floor(raw.limit) : 50;
  const concurrency = Number.isFinite(raw.concurrency) && raw.concurrency > 0 ? Math.floor(raw.concurrency) : 2;
  return {
    limit,
    concurrency,
    skipTzCheck: Boolean(raw.skipTzCheck),
    forceColdStart: Boolean(raw.forceColdStart),
    dryRun: Boolean(raw.dryRun),
    ...(raw.amcProbe ? { amcProbe: raw.amcProbe } : {}),
    ...(raw.proxyCheck ? { proxyCheck: raw.proxyCheck } : {}),
  };
}

main().catch((err) => {
  log.error('致命错误', { error: String(err) });
  emitSummary({ ok: false, status: 'failed', error: String(err) });
  process.exitCode = 1;
});
