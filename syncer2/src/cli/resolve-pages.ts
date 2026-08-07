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
 * 3. **失败不丢也不静止。** 404 → 终态 gone；真实身份冲突 → conflict 并按周复查；
 *    传输/解析失败 → retry（1h/4h/24h），耗尽后转 irreconcilable 低频复查。
 *    adult:/wanderers-adult: 的匿名整页 GET 不能作身份证据；adult 改用 ListPages
 *    fullname + 固定 7890 的最小登录身份发现，wanderers-adult 保留 v1 服务端强制
 *    只读身份源；证据未到则 waiting_evidence 定时复查。
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
import {
  createRestrictedStableHttp,
  isRestrictedSlug,
  loadRestrictedWikidotCredentials,
  RESTRICTED_STABLE_PROXY_URL,
  RestrictedIdentitySession,
  RestrictedSessionUnavailableError,
} from '../http/restrictedSession.js';
import { PostgresAdaptiveEgressGate } from '../http/adaptiveEgress.js';
import { amcProbePolicyFor, assertEgressContract, parseProbePolicy } from '../http/amc.js';
import {
  fetchPageIdentity,
  findSharedPageIdentityCollisions,
  type IdentityOutcome,
} from '../page/identity.js';
import {
  scanRestrictedListPages,
  type RestrictedListPageRecord,
} from '../collect/restrictedListPages.js';
import { assertTimezoneRoundTrip, createPool } from '../store/db.js';
import { enqueueScanTasks, finishIngestRun, startIngestRun, type ScanTaskRow } from '../store/meta.js';
import {
  claimPendingPages,
  countPendingPages,
  finishPendingPage,
  lookupIdentityByWikidotId,
  pendingStatusBreakdown,
  registerPage,
  releasePendingPageClaim,
  type ClaimedPending,
} from '../store/queues.js';
import {
  assertRestrictedV1SessionReadOnly,
  createRestrictedV1Client,
  loadRestrictedV1Identities,
} from '../store/v1RestrictedIdentity.js';
import {
  identityConflictResolution,
  isRestrictedListPagesPending,
  pendingFailureResolution,
  resolveRestrictedPendingPage,
  type RestrictedV1Identity,
  waitingForRestrictedEvidence,
  waitingForRestrictedSession,
} from '../work/pendingPage.js';
import { applyRestrictedListPage } from '../work/restrictedPage.js';

const log = createLogger('resolve-pages');

/** 采集通道标签：进 meta.ingest_run.source。 */
const SOURCE = 'wikidot_page_identity';

interface CliOptions {
  limit: number;
  concurrency: number;
  skipTzCheck: boolean;
  forceColdStart: boolean;
  dryRun: boolean;
  adultBootstrap: boolean;
  amcProbe?: string;
  proxyCheck?: string;
}

async function main(): Promise<void> {
  const opts = parseArgs();
  const config = loadConfig();
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const workerId = `${os.hostname()}:${process.pid}`;
  const runSource = opts.adultBootstrap ? 'wikidot_listpages_adult_bootstrap' : SOURCE;

  const http = new HttpClient({
    userAgent: config.userAgent,
    referer: config.referer,
    // adult bootstrap 整个进程（包括启动探针）都只允许稳定出口；不能先在 7891
    // 暴露一次再把登录 session 切到 7890。
    proxyUrl: opts.adultBootstrap ? RESTRICTED_STABLE_PROXY_URL : config.proxyUrl,
    timeoutMs: config.httpTimeoutMs,
    maxAttempts: config.httpMaxAttempts,
    breaker503: config.breaker503,
    breakerReset: config.breakerReset,
    connections: Math.max(2, opts.concurrency),
    logger: log.child('http'),
    adaptiveEgress: new PostgresAdaptiveEgressGate(config.databaseUrl, 'resolve-pages'),
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
    conflict: 0,
    restrictedResolved: 0,
    adultListPagesObserved: 0,
    adultSessionFailed: 0,
    identityCollisions: 0,
    waitingEvidence: 0,
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
    if (pendingTotal > config.pendingColdStart && !opts.forceColdStart && !opts.adultBootstrap) {
      const msg =
        `pending_page 待解析 ${pendingTotal} 条 > 冷启动阈值 ${config.pendingColdStart}。` +
        `这是**冷启动/大回填**形态，不是日常增量（实测新页+改名合计 30–80/天）。` +
        `一页一个整页 GET 会变成上万次请求，与 field-matrix 的"绝不为全站 36k 页各打一次 GET"直接冲突。` +
        `请走 Phase 2 批量回填；确实要用本 CLI 顶上，加 --force-cold-start。`;
      log.error('冷启动闸拦截', { pendingTotal, threshold: config.pendingColdStart });
      runId = await startIngestRun(pool, runSource, startedAt);
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

    runId = await startIngestRun(pool, runSource, startedAt);

    // ── 认领 ────────────────────────────────────────────────────────────────
    const claimed = opts.adultBootstrap
      ? []
      : await claimPendingPages(pool, opts.limit, workerId);
    counters.claimed = claimed.length;
    log.info('已认领待解析 slug', { claimed: claimed.length, limit: opts.limit, pendingTotal });

    // ── 受限分类收敛 ──────────────────────────────────────────────────────
    // adult: 用 ListPages 页面证据 + 固定 7890 登录身份；账号不参与 WhoRated。
    // wanderers-adult: 暂保留既有 v1 服务端强制只读交叉证据，不移除只读约束。
    const adult = claimed.filter(
      (row) => row.slug.toLowerCase().startsWith('adult:') && isRestrictedListPagesPending(row),
    );
    const restricted = claimed.filter(
      (row) => !row.slug.toLowerCase().startsWith('adult:') && isRestrictedListPagesPending(row),
    );
    const restrictedSlugs = new Set([...adult, ...restricted].map((row) => row.slug));
    const httpClaimed = claimed.filter((row) => !restrictedSlugs.has(row.slug));

    if (adult.length > 0 || opts.adultBootstrap) {
      const adultResult = await resolveAdultPendingPages({
        pool,
        rows: adult,
        baseUrl: config.siteBaseUrl,
        userAgent: config.userAgent,
        referer: config.referer,
        timeoutMs: config.httpTimeoutMs,
        maxAttempts: config.httpMaxAttempts,
        breaker503: config.breaker503,
        breakerReset: config.breakerReset,
        runId,
        dryRun: opts.dryRun,
        bootstrapAll: opts.adultBootstrap,
      });
      if (opts.adultBootstrap) counters.claimed = adultResult.targeted;
      counters.resolved += adultResult.resolved;
      counters.alreadyRegistered += adultResult.alreadyRegistered;
      counters.restrictedResolved += adultResult.resolved + adultResult.alreadyRegistered;
      counters.waitingEvidence += adultResult.waitingEvidence;
      counters.conflict += adultResult.conflict;
      counters.failed += adultResult.failed;
      counters.tasksEnqueued += adultResult.tasksEnqueued;
      counters.adultListPagesObserved += adultResult.listPagesObserved;
      counters.adultSessionFailed += adultResult.sessionFailed;
      counters.identityCollisions += adultResult.identityCollisions;
      for (const sample of adultResult.samples) {
        if (samples.length < 20) samples.push(sample);
      }
    }

    if (restricted.length > 0) {
      let candidates = new Map<string, RestrictedV1Identity>();
      if (config.v1DatabaseUrl !== null) {
        const v1 = createRestrictedV1Client(config.v1DatabaseUrl);
        try {
          await v1.connect();
          await assertRestrictedV1SessionReadOnly(v1);
          candidates = await loadRestrictedV1Identities(v1, restricted.map((row) => row.slug));
        } finally {
          await v1.end().catch(() => undefined);
        }
      }
      for (const row of restricted) {
        const candidate = candidates.get(row.slug);
        if (candidate === undefined) {
          counters.waitingEvidence++;
          if (!opts.dryRun) {
            await finishPendingPage(
              pool,
              waitingForRestrictedEvidence(
                row.slug,
                Date.now(),
                config.v1DatabaseUrl === null
                  ? '受限分类不能用匿名整页 GET；SYNCER2_V1_DATABASE_URL 未配置，等待只读身份源'
                  : 'v1 暂无唯一 live URL/wikidotId，等待下一次只读复核',
              ),
            );
          }
          continue;
        }
        if (opts.dryRun) {
          counters.restrictedResolved++;
          samples.push({ slug: row.slug, restrictedFallback: true, dryRun: true });
          continue;
        }
        try {
          const settled = await resolveRestrictedPendingPage(
            pool,
            row,
            candidate,
            new Date().toISOString(),
            runId,
          );
          counters.restrictedResolved++;
          if (settled.newlyRegistered) counters.resolved++;
          else counters.alreadyRegistered++;
          if (samples.length < 20) {
            samples.push({
              slug: row.slug,
              wikidotId: candidate.wikidotId,
              pageId: settled.pageId,
              restrictedFallback: true,
              source: settled.source,
            });
          }
        } catch (err) {
          counters.conflict++;
          await finishPendingPage(pool, {
            slug: row.slug,
            status: 'conflict',
            error: String(err),
            notBefore: new Date(Date.now() + 7 * 24 * 60 * 60_000).toISOString(),
            resolutionSource: 'restricted_identity_conflict',
            resolutionEvidence: {
              v1PageId: candidate.v1PageId,
              v1WikidotId: candidate.wikidotId,
              v1ReadOnly: true,
            },
          });
        }
      }
    }

    // ── 逐页解析（先完整发现，再统一过共享 pageId 守卫，之后才允许任何写入）─────
    const httpOutcomes = new Map<string, IdentityOutcome>();
    await mapLimited(httpClaimed, opts.concurrency, async (row) => {
      try {
        httpOutcomes.set(
          row.slug,
          await fetchPageIdentity(http, config.siteBaseUrl, row.slug, log),
        );
      } catch (err) {
        if (err instanceof CircuitOpenError) throw err;
        httpOutcomes.set(row.slug, {
          kind: 'failed',
          httpStatus: null,
          error: `身份发现异常：${String(err)}`,
        });
      }
    });
    const identityCollisions = findSharedPageIdentityCollisions(
      [...httpOutcomes].flatMap(([slug, outcome]) =>
        outcome.kind === 'ok'
          ? [{ slug, wikidotId: outcome.identity.wikidotId }]
          : [],
      ),
    );
    const collisionBySlug = new Map<string, (typeof identityCollisions)[number]>();
    for (const collision of identityCollisions) {
      log.error('身份冲突守卫触发：多个 slug 共享同一 pageId，冲突组全部拒绝写入', {
        collision,
      });
      for (const slug of collision.slugs) collisionBySlug.set(slug, collision);
    }
    counters.identityCollisions += identityCollisions.reduce(
      (sum, collision) => sum + collision.slugs.length,
      0,
    );

    await mapLimited(httpClaimed, opts.concurrency, async (row) => {
      const observedAt = new Date().toISOString();
      try {
        const collision = collisionBySlug.get(row.slug.toLowerCase());
        if (collision !== undefined) {
          counters.conflict++;
          await finishPendingPage(pool, {
            slug: row.slug,
            status: 'conflict',
            wikidotId: collision.wikidotId,
            error:
              `身份冲突守卫：pageId=${collision.wikidotId} 同时解析自多个 slug=` +
              collision.slugs.join(',') + '；拒绝写入',
            notBefore: new Date(Date.now() + 7 * 24 * 60 * 60_000).toISOString(),
            resolutionSource: 'shared_page_id_collision',
            resolutionEvidence: { collision },
          });
          return;
        }
        const outcome = httpOutcomes.get(row.slug) ?? {
          kind: 'failed' as const,
          httpStatus: null,
          error: '内部错误：身份发现结果缺项',
        };

        if (outcome.kind === 'gone') {
          counters.gone++;
          await finishPendingPage(pool, {
            slug: row.slug,
            status: 'gone',
            httpStatus: outcome.httpStatus,
            error: outcome.error,
            resolutionSource: 'wikidot_http_404',
            resolutionEvidence: { attempts: row.attempts },
          });
          return;
        }
        if (outcome.kind === 'mismatch') {
          counters.conflict++;
          await finishPendingPage(
            pool,
            identityConflictResolution(
              row,
              outcome.observedSlug,
              outcome.identity.wikidotId,
              outcome.httpStatus,
            ),
          );
          return;
        }
        if (outcome.kind === 'failed') {
          counters.failed++;
          await finishPendingPage(
            pool,
            pendingFailureResolution(
              row.slug,
              row.attempts,
              outcome.error,
              outcome.httpStatus,
            ),
          );
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
            resolutionSource: 'wikidot_page_identity',
            resolutionEvidence: { identityDisposition: 'registered' },
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
            resolutionSource: 'wikidot_identity_rename_queued',
            resolutionEvidence: { previousSlug: existing.currentSlug },
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
            resolutionSource: 'wikidot_page_identity',
            resolutionEvidence: { identityDisposition: 'reused' },
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
        await finishPendingPage(
          pool,
          pendingFailureResolution(row.slug, row.attempts, String(err)),
        ).catch(() => undefined);
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
      counters.gone === 0 &&
      counters.waitingEvidence === 0 &&
      counters.conflict === 0;
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

interface AdultResolveResult {
  targeted: number;
  resolved: number;
  alreadyRegistered: number;
  waitingEvidence: number;
  conflict: number;
  failed: number;
  tasksEnqueued: number;
  listPagesObserved: number;
  sessionFailed: number;
  identityCollisions: number;
  samples: Array<Record<string, unknown>>;
}

async function resolveAdultPendingPages(args: {
  pool: Pool;
  rows: readonly ClaimedPending[];
  baseUrl: string;
  userAgent: string;
  referer: string;
  timeoutMs: number;
  maxAttempts: number;
  breaker503: number;
  breakerReset: number;
  runId: number | null;
  dryRun: boolean;
  bootstrapAll: boolean;
}): Promise<AdultResolveResult> {
  const result: AdultResolveResult = {
    targeted: 0,
    resolved: 0,
    alreadyRegistered: 0,
    waitingEvidence: 0,
    conflict: 0,
    failed: 0,
    tasksEnqueued: 0,
    listPagesObserved: 0,
    sessionFailed: 0,
    identityCollisions: 0,
    samples: [],
  };
  for (const row of args.rows) {
    if (!isRestrictedSlug(row.slug) || !row.slug.toLowerCase().startsWith('adult:')) {
      throw new Error(`adult resolver 收到非 adult slug：${row.slug}`);
    }
  }

  const stableHttp = createRestrictedStableHttp({
    userAgent: args.userAgent,
    referer: args.referer,
    timeoutMs: args.timeoutMs,
    maxAttempts: args.maxAttempts,
    breaker503: args.breaker503,
    breakerReset: args.breakerReset,
    connections: 2,
    logger: log.child('adult-7890'),
  });
  stableHttp.assertHeaders();
  let session: RestrictedIdentitySession | null = null;
  try {
    const listPages = await scanRestrictedListPages(
      stableHttp,
      args.baseUrl,
      'adult',
      log.child('adult-listpages'),
    );
    if (listPages.status === 'failed') {
      const error = `adult ListPages 权威观测失败，整批跳过且不产生空结果：${listPages.error}`;
      log.error(error, { claimed: args.rows.length, emptyResult: false });
      result.failed += args.rows.length;
      result.waitingEvidence += args.rows.length;
      if (!args.dryRun) {
        for (const row of args.rows) {
          await finishPendingPage(args.pool, waitingForRestrictedSession(row.slug, error));
        }
      }
      return result;
    }
    result.listPagesObserved = listPages.rows.length;
    const targetRows: ClaimedPending[] = args.bootstrapAll
      ? listPages.rows.map((row) => ({
          slug: row.fullname,
          attempts: 0,
          seenCount: 1,
          reasons: ['adult_listpages_bootstrap'],
          discoveredBy: 'adult_listpages_bootstrap',
          wikidotId: null,
          observedSlug: null,
        }))
      : [...args.rows];
    result.targeted = targetRows.length;
    const bySlug = new Map(listPages.rows.map((row) => [row.fullname, row]));
    const missingEvidence = targetRows.filter((row) => !bySlug.has(row.slug));
    if (missingEvidence.length > 0) {
      const error =
        `adult ListPages 完整轮没有 claimed slug：` +
        missingEvidence.slice(0, 10).map((row) => row.slug).join(',');
      log.error(error, { missing: missingEvidence.length, remoteTotal: listPages.remoteTotal });
      for (const row of missingEvidence) {
        result.waitingEvidence++;
        if (!args.dryRun) {
          await finishPendingPage(
            args.pool,
            waitingForRestrictedEvidence(row.slug, Date.now(), error),
          );
        }
      }
    }

    const readyRows = targetRows.filter((row) => bySlug.has(row.slug));
    if (readyRows.length === 0) return result;
    const credentials = loadRestrictedWikidotCredentials();
    if (credentials === null) {
      const error =
        'adult 身份发现缺少 WIKIDOT_USERNAME/WIKIDOT_PASSWORD；整批跳过且不产生空结果';
      log.error(error, { claimed: readyRows.length, emptyResult: false });
      result.sessionFailed = readyRows.length;
      result.waitingEvidence += readyRows.length;
      if (!args.dryRun) {
        for (const row of readyRows) {
          await finishPendingPage(args.pool, waitingForRestrictedSession(row.slug, error));
        }
      }
      return result;
    }

    session = new RestrictedIdentitySession(
      stableHttp,
      credentials,
      args.baseUrl,
      log.child('adult-session'),
    );
    const identities = new Map<string, IdentityOutcome>();
    let sessionError: string | null = null;
    // 同一账号 session 串行发现；避免并发过期时触发多次重登，也避免同 session 多连接突刺。
    for (const row of readyRows) {
      try {
        identities.set(row.slug, await session.fetchIdentity(row.slug));
      } catch (err) {
        sessionError =
          err instanceof RestrictedSessionUnavailableError
            ? err.message
            : `受限 session 请求异常：${String(err)}`;
        break;
      }
    }
    if (sessionError !== null) {
      const error = `adult session 失效/重登失败，整批跳过且不产生空结果：${sessionError}`;
      log.error(error, {
        claimed: readyRows.length,
        discoveredBeforeFailure: identities.size,
        emptyResult: false,
      });
      result.sessionFailed = readyRows.length;
      result.waitingEvidence += readyRows.length;
      if (!args.dryRun) {
        for (const row of readyRows) {
          await finishPendingPage(args.pool, waitingForRestrictedSession(row.slug, error));
        }
      }
      return result;
    }

    // 所有身份先发现完，再做批级共享 pageId 守卫；守卫前没有任何 register/apply。
    const collisions = findSharedPageIdentityCollisions(
      [...identities].flatMap(([slug, outcome]) =>
        outcome.kind === 'ok'
          ? [{ slug, wikidotId: outcome.identity.wikidotId }]
          : [],
      ),
    );
    const collisionBySlug = new Map<string, (typeof collisions)[number]>();
    for (const collision of collisions) {
      log.error('adult 身份冲突守卫触发：多个 slug 共享同一 pageId，整组拒绝写入', {
        collision,
      });
      for (const slug of collision.slugs) collisionBySlug.set(slug, collision);
    }
    result.identityCollisions = collisions.reduce(
      (sum, collision) => sum + collision.slugs.length,
      0,
    );

    for (const pending of readyRows) {
      const row = bySlug.get(pending.slug) as RestrictedListPageRecord;
      const collision = collisionBySlug.get(pending.slug.toLowerCase());
      if (collision !== undefined) {
        result.conflict++;
        if (!args.dryRun) {
          await finishPendingPage(args.pool, {
            slug: pending.slug,
            status: 'conflict',
            wikidotId: collision.wikidotId,
            error:
              `身份冲突守卫：pageId=${collision.wikidotId} 同时解析自多个 slug=` +
              collision.slugs.join(',') + '；拒绝写入',
            notBefore: new Date(Date.now() + 7 * 24 * 60 * 60_000).toISOString(),
            resolutionSource: 'shared_page_id_collision',
            resolutionEvidence: { collision, listpagesFullname: pending.slug },
          });
        }
        continue;
      }
      const outcome = identities.get(pending.slug);
      if (outcome === undefined || outcome.kind !== 'ok') {
        const error =
          outcome === undefined
            ? 'adult 身份发现结果缺项'
            : `adult 登录身份不是 ok（${outcome.kind}）：` +
              (outcome.kind === 'mismatch' ? outcome.observedSlug : outcome.error);
        result.waitingEvidence++;
        if (!args.dryRun) {
          await finishPendingPage(args.pool, waitingForRestrictedSession(pending.slug, error));
        }
        continue;
      }

      if (args.dryRun) {
        result.resolved++;
        result.samples.push({
          slug: pending.slug,
          wikidotId: outcome.identity.wikidotId,
          rating: row.rating,
          ratingVotes: row.ratingVotes,
          createdById: row.createdById,
          contentBytes: Buffer.byteLength(row.contentHtml),
          dryRun: true,
        });
        continue;
      }

      const observedAt = new Date().toISOString();
      try {
        const existing = await lookupIdentityByWikidotId(
          args.pool,
          outcome.identity.wikidotId,
        );
        const currentSlug = existing?.currentSlug?.toLowerCase() ?? null;
        const isAnonymousUnqualifiedAlias =
          currentSlug !== null && currentSlug === row.name.toLowerCase();
        if (
          existing !== null &&
          currentSlug !== null &&
          currentSlug !== pending.slug.toLowerCase()
        ) {
          // 匿名 sitemap/整页链路会丢 adult:，两个 old: 页面还会进一步重写旧名。
          // 登录态 pageUnixName 与 ListPages fullname 已双证据一致，且批级守卫证明
          // 目标集合内 ID 唯一；因此这是 canonical 修正，交 apply_page_meta 做 SCD2。
          log.info('adult 已有身份修正为登录态 + ListPages canonical fullname', {
            pageId: existing.pageId,
            wikidotId: outcome.identity.wikidotId,
            from: existing.currentSlug,
            to: pending.slug,
            exactUnqualifiedAlias: isAnonymousUnqualifiedAlias,
          });
        }
        const pageId =
          existing?.pageId ??
          await registerPage(args.pool, {
            wikidotId: outcome.identity.wikidotId,
            slug: pending.slug,
            observedAt,
            source: 'wikidot_listpages_authenticated_identity',
            runId: args.runId,
            createdAt: row.createdAt,
          });
        const applied = await applyRestrictedListPage(args.pool, {
          row,
          pageId,
          wikidotId: outcome.identity.wikidotId,
          observedAt,
          runId: args.runId,
        });
        await finishPendingPage(args.pool, {
          slug: pending.slug,
          status: 'resolved',
          wikidotId: outcome.identity.wikidotId,
          pageId,
          categoryId: outcome.identity.categoryId,
          observedSlug: outcome.identity.pageUnixName,
          httpStatus: outcome.httpStatus,
          error: null,
          resolutionSource: 'adult_listpages_authenticated_identity',
          resolutionEvidence: {
            listpagesFullname: row.fullname,
            listpagesRating: row.rating,
            listpagesRatingVotes: row.ratingVotes,
            listpagesCreatedById: row.createdById,
            listpagesCreatedAt: row.createdAt,
            contentSha256: applied.content['sha256'] ?? row.contentSha256Hex,
            authenticatedIdentityOnly: true,
            votesAnonymous: true,
            proxyUrl: stableHttp.proxyUrl,
          },
        });
        result.tasksEnqueued += await enqueueScanTasks(args.pool, [
          {
            pageId,
            kind: 'votes_full',
            reasons: ['adult_identity_registered_listpages_claim'],
            priority: 200,
            notBefore: observedAt,
          },
          {
            pageId,
            kind: 'revisions_full',
            reasons: ['adult_identity_registered_listpages_claim'],
            priority: 100,
            notBefore: observedAt,
          },
          {
            pageId,
            kind: 'content',
            reasons: ['adult_authenticated_viewsource_required'],
            priority: 150,
            notBefore: observedAt,
          },
          {
            pageId,
            kind: 'discussion',
            reasons: ['adult_comments_list_thread_discovery'],
            priority: 120,
            notBefore: observedAt,
          },
        ]);
        if (existing === null) result.resolved++;
        else result.alreadyRegistered++;
        if (result.samples.length < 20) {
          result.samples.push({
            slug: row.fullname,
            pageId,
            wikidotId: outcome.identity.wikidotId,
            rating: row.rating,
            ratingVotes: row.ratingVotes,
            createdById: row.createdById,
            ownerActorId: applied.ownerActorId,
            contentBytes: Buffer.byteLength(row.contentHtml),
            newlyRegistered: existing === null,
            proxyUrl: stableHttp.proxyUrl,
          });
        }
      } catch (err) {
        result.failed++;
        log.warn('adult 单页应用失败；保留 pending 等下轮重试', {
          slug: pending.slug,
          error: String(err),
        });
        await finishPendingPage(
          args.pool,
          pendingFailureResolution(pending.slug, pending.attempts, String(err)),
        );
      }
    }
    return result;
  } finally {
    await session?.logout();
    await stableHttp.close();
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
    .description('消化 pending_page：普通页整页 GET；adult 用 ListPages+7890 登录身份；其它受限页用 v1 只读证据')
    .option('--limit <n>', '本轮最多处理多少页（受限分类不发整页 GET）', (v) => Number(v), 50)
    .option('--concurrency <n>', '并发页数（保持个位数，出口礼貌）', (v) => Number(v), 2)
    .option('--skip-tz-check', '跳过时区回环自检（仅限本地调试）', false)
    .option('--force-cold-start', '越过冷启动闸（pending 超阈值时仍然跑）', false)
    .option('--dry-run', '只解析不写库（不 register_page、不回填 pending_page）', false)
    .option(
      '--adult-bootstrap',
      '以 adult ListPages 完整轮为集合，登录发现真实 ID 并补齐全部页面（全进程固定 7890）',
      false,
    )
    .option('--amc-probe <policy>', 'AMC 契约探针：require | warn | skip（本通道默认 skip）')
    .option('--proxy-check <policy>', '代理健康探测：require | warn | skip（默认 warn）');

  program.parse(process.argv);
  const raw = program.opts<{
    limit: number;
    concurrency: number;
    skipTzCheck: boolean;
    forceColdStart: boolean;
    dryRun: boolean;
    adultBootstrap: boolean;
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
    adultBootstrap: Boolean(raw.adultBootstrap),
    ...(raw.amcProbe ? { amcProbe: raw.amcProbe } : {}),
    ...(raw.proxyCheck ? { proxyCheck: raw.proxyCheck } : {}),
  };
}

main().catch((err) => {
  log.error('致命错误', { error: String(err) });
  emitSummary({ ok: false, status: 'failed', error: String(err) });
  process.exitCode = 1;
});
