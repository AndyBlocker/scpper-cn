/**
 * meta schema 的写入门面：ingest_run / page_scan / scan_task。
 *
 * **本文件不建表。** 四 schema 的 DDL 由任务 A-D 产出，这里只按定稿的表名/列名写入
 * （docs/data-model-v2-redesign-2026-07-03.md §4.7）。表还没建时，各函数会以
 * `RELATION_MISSING` 优雅降级并让 CLI 在摘要里标出来 —— 采集层原型要能在 schema 落地
 * 之前就跑通网络侧。
 *
 * 语义映射（sitemap 通道 → meta 三表）：
 *
 *   meta.ingest_run   一次 CLI 执行 = 一行。source='sitemap:delta' / 'sitemap:full'。
 *                     pages_enumerated = 本轮 sitemap 实际枚举到的 slug 数；
 *                     remote_total     = 只有 full 轮才有意义（= 全站 slug 总数，
 *                                        它本身就是 remote_total 的一个独立信源，
 *                                        与 ListPages %%total%% 互为交叉证据）。
 *                     stats            = HTTP 分桶、耗时、字节、diff 明细、门控结论。
 *
 *   meta.page_scan    "这一轮确实看见了这个页面" 的证据行，kind='meta'、status='ok'。
 *                     这是 absence 推断（连续 ≥2 个完整 run 未见才落 deleted）唯一的
 *                     正面证据来源。result_hash = sha256(slug|lastmod)，同页同内容
 *                     跨轮哈希一致 → 直接服务 scan_task 的 stable_count 收敛检测。
 *                     写入量控制：delta 轮只写**变化页**（每 10 分钟写 1 万行没有意义），
 *                     full 轮写全部已解析页（36k 行 / 4 小时）。
 *
 *   meta.scan_task    发现层的产物，真队列（失败保留、成功即删、UNIQUE(page_id,kind) 防堆积）。
 *                     sitemap 只产出三种 kind：
 *                       lastmod 前进        → kind='content'          reason 'sitemap_lastmod_advanced'
 *                       出现未知 slug       → kind='meta'             reason 'sitemap_new_slug'
 *                       完整 full 轮中缺席  → kind='confirm_deleted'  reason 'sitemap_absent'
 *                     最后一种受三重门控，见 cli/sitemap-scan.ts。
 */

import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { query, toPgTimestamptz } from './db.js';
import { chunk } from '../util/concurrency.js';
import { createLogger } from '../util/log.js';
import {
  evaluateParseHealth,
  metricCurrentSampleCount,
  normalizeParseFingerprint,
  resolveParseHealthStratum,
  type ParseHealthReport,
} from '../health/parseHealth.js';
import { sanitizePageScanError, toPgJson } from './pgText.js';

const log = createLogger('meta');

/** PG "relation does not exist"。schema 尚未由任务 A-D 落地时会命中。 */
const UNDEFINED_TABLE = '42P01';

function isMissingRelation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === UNDEFINED_TABLE;
}

export type RunStatus = 'running' | 'ok' | 'partial' | 'failed' | 'aborted';

/**
 * 词表的**权威定义在 SQL 侧**（migrations/0003_meta.sql + 0007_meta_gaps.sql 的
 * page_scan_kind_ck / scan_task_kind_ck），这里必须与之逐项一致。
 *
 * 两边任一侧收窄都是运行期才发现的失败：
 *   TS 窄 → 编译期就拒绝一个数据库其实接受的 kind（本文件此前缺 sitemap_delta /
 *           new_page_highfreq，而 0003 早就加了）；
 *   TS 宽 → INSERT 时撞 CHECK 违规（23514），而那一刻扫描已经做完了。
 * 改这两个联合类型时必须同时改 0007 §1 的 CHECK，反之亦然。
 */
export type PageScanKind =
  | 'meta'
  | 'votes'
  | 'revisions'
  | 'content'
  | 'attributions'
  | 'forum'
  | 'discussion'   // 0007：单页讨论区（与 forum 分开，见 0007 §1 注释）
  | 'files'        // 0007：页面附件列表
  | 'revision_source';
export type PageScanStatus = 'ok' | 'partial' | 'failed';
export type ScanTaskKind =
  | 'meta'
  | 'votes_full'
  | 'revisions_full'
  | 'content'
  | 'attributions'
  | 'confirm_deleted'
  | 'sitemap_delta'      // 0003：sitemap 一等发现通道的独立信号
  | 'new_page_highfreq'  // 0003：新页 2-4h 高频队列
  | 'forum'              // 0007：页级论坛数据重扫
  | 'discussion'         // 0007：单页讨论区 thread
  | 'files';             // 0007：页面附件列表

export interface PageScanRow {
  pageId: number;
  kind: PageScanKind;
  status: PageScanStatus;
  claimedTotal?: number | null;
  fetchedTotal?: number | null;
  checksumOk?: boolean | null;
  checksumExpected?: number | null;
  checksumActual?: number | null;
  resultHash?: Buffer | null;
  error?: string | null;
}

export interface ScanTaskRow {
  pageId: number;
  kind: ScanTaskKind;
  reasons: string[];
  priority?: number;
  notBefore?: string | null;
}

/** result_hash 的统一口径：同页同 lastmod ⇒ 同哈希（收敛检测直接可用）。 */
export function sitemapResultHash(slug: string, lastmod: string | null): Buffer {
  return createHash('sha256').update(`${slug}\n${lastmod ?? ''}`, 'utf-8').digest();
}

// ─── ingest_run ──────────────────────────────────────────────────────────────

/**
 * 把超时仍停在 running 的旧 run 收成 aborted。
 *
 * finish 只在优雅路径执行，进程被杀 / 数据库重启（如 openssl 安全更新触发的
 * postgres restart）时那一步根本没机会跑，行就永远停在 running。这些幽灵行既让
 * 「有多少轮真的死掉」不可见，也会污染任何按 status 统计的口径——同一天里
 * NUL 那个 bug 是「记录失败时自己失败」，这里是「连记录的机会都没有」，
 * 都属于系统无法如实描述自身状态。
 *
 * 阈值取 1 小时：15 个 systemd 短任务中最长配置为 25 分钟，留足两倍余量；
 * forum-consume 的正常 298 秒优雅收尾更不会被误伤。回填脚本自行维护其 run 生命周期。
 */
export async function reapStaleIngestRuns(
  pool: Pool,
  staleHours = 1,
): Promise<number> {
  if (!Number.isFinite(staleHours) || staleHours <= 0) {
    throw new RangeError(`悬挂 run 回收阈值必须为正数小时，收到 ${String(staleHours)}`);
  }
  try {
    const res = await query<{ id: string }>(
      pool,
      'meta.ingest_run:reap_stale',
      `UPDATE meta.ingest_run
          SET status = 'aborted',
              finished_at = now(),
              stats = stats || jsonb_build_object(
                'aborted_reason', 'stale_running_reaped',
                'stale_hours', $1::numeric,
                'reaped_at', now()
              )
        WHERE status = 'running'
          AND started_at < now() - make_interval(hours => $1::int)
        RETURNING id`,
      [staleHours],
    );
    if (res.rows.length > 0) {
      log.warn('回收悬挂 run（进程未能写回终态）', {
        count: res.rows.length,
        ids: res.rows.slice(0, 20).map((r) => Number(r.id)),
      });
    }
    return res.rows.length;
  } catch (err) {
    // 回收是尽力而为的清理，绝不能反过来阻断本轮采集。
    if (isMissingRelation(err)) return 0;
    log.warn('悬挂 run 回收失败，不阻断本轮', { error: String(err) });
    return 0;
  }
}

export async function startIngestRun(
  pool: Pool,
  source: string,
  startedAt: string,
): Promise<number | null> {
  await reapStaleIngestRuns(pool);
  try {
    const res = await query<{ id: string }>(
      pool,
      'meta.ingest_run:start',
      `INSERT INTO meta.ingest_run (source, started_at, status)
       VALUES ($1, $2::timestamptz, 'running')
       RETURNING id`,
      [source, toPgTimestamptz(startedAt)],
    );
    const id = res.rows[0]?.id;
    return id === undefined ? null : Number(id);
  } catch (err) {
    if (isMissingRelation(err)) {
      log.warn('meta.ingest_run 尚未建表（任务 A-D 未落地），本轮不落库');
      return null;
    }
    throw err;
  }
}

export interface FinishRunArgs {
  status: RunStatus;
  finishedAt: string;
  pagesEnumerated: number | null;
  remoteTotal: number | null;
  /**
   * 本轮 remote_total 取自哪个计数源。sitemap 通道恒为 'sitemap'（35,983），
   * 与 ListPages 的 %%total%%（36,173）、库内计数（36,054）并列为三个独立计数之一 ——
   * 门控用了哪一个必须可追溯，否则 coverage_ratio 是个没有出处的数。
   */
  remoteTotalSource?: 'sitemap' | 'listpages_total' | 'both' | 'unknown' | null;
  /** 本轮分批请求总数（sitemap 通道 = 索引 1 + 各分片）。 */
  batchesTotal?: number | null;
  /** 重试 ≥N 次仍失败的批数。判据是"批级重试耗尽"，不是"任一请求失败"。 */
  batchesFailed?: number | null;
  /**
   * 业务逻辑请求最终因传输错误耗尽的比例。探针、内部重试次数和重试后成功的瞬时错误
   * 不进入分子/分母；逐尝试诊断仍保存在 stats.http。
   */
  transportFailureRate?: number | null;
  /**
   * 出口归因（TODO #12）。49 节点轮换池无 fallback 无健康检查，不记出口 IP 则
   * "某几个节点坏了"不可归因（synthesis P0-5 / findings#20）。
   * 形状由 http/egress.ts 的 ExitIpStats 定义：
   *   byIp                    采样得到的池构成（**不是**逐请求归因，探针每次换 IP）
   *   byNode                  mihomo /connections 的 chains[0]，按连接的真值
   *   transportFailureByNode  失败时刻的节点分布 ⇒ 这就是"哪个节点坏了"的答案
   *   attribution             口径声明（半年后看这张表的人靠它判断能不能下结论）
   * null / 未传 ⇒ 保持列默认值 '{}'，不写 SQL NULL（该列 NOT NULL DEFAULT '{}'）。
   */
  exitIpStats?: Record<string, unknown> | null;
  /** 解析分布指纹，键名须与 meta.parse_health_baseline.metric 对齐。 */
  parseFingerprint?: Record<string, unknown> | null;
  /** R10 第三维基线分层；未传时由 stats/mode/domain 按统一规则推导。 */
  populationType?: string | null;
  /** 测试/迁移可显式关闭；生产采集轮默认每轮都执行 R10 比对。 */
  evaluateParseHealth?: boolean;
  /** 我方写冻结等已知状态可让整轮只留证；不得反馈成新的健康判决。 */
  healthDecisionSkipReason?: string | null;
  stats: unknown;
}

export async function finishIngestRun(
  pool: Pool,
  runId: number | null,
  args: FinishRunArgs,
): Promise<ParseHealthReport | null> {
  if (runId === null) return null;
  try {
    const evidenceFingerprint = await pageScanHealthFingerprint(pool, runId);
    const suppliedSampleCounts = sampleCounts(args.parseFingerprint?.['sample_counts']);
    const pageSampleCount =
      args.pagesEnumerated !== null && args.pagesEnumerated >= 0
        ? args.pagesEnumerated
        : null;
    const fallbackSampleCounts =
      pageSampleCount === null
        ? {}
        : Object.fromEntries(
            Object.entries(args.parseFingerprint ?? {})
              .filter(
                ([metric, value]) =>
                  metric !== 'sample_counts' &&
                  metric !== 'http_status_dist' &&
                  metric !== 'transport_failure_rate' &&
                  metric !== 'exit_ip_dist' &&
                  metric !== 'revision_type_dist' &&
                  value !== null &&
                  value !== undefined &&
                  suppliedSampleCounts[metric] === undefined,
              )
              .map(([metric]) => [metric, pageSampleCount]),
          );
    const fingerprint = normalizeParseFingerprint(
      {
        ...(args.parseFingerprint ?? {}),
        ...evidenceFingerprint,
        sample_counts: {
          ...fallbackSampleCounts,
          ...suppliedSampleCounts,
          ...evidenceFingerprint.sample_counts,
        },
      },
      args.exitIpStats,
    );
    const finished = await query<{ source: string }>(
      pool,
      'meta.ingest_run:finish',
      `UPDATE meta.ingest_run
          SET status = $2,
              finished_at = $3::timestamptz,
              pages_enumerated = $4,
              remote_total = $5,
              remote_total_source = $6,
              batches_total = $7,
              batches_failed = $8,
              transport_failure_rate = $9,
              exit_ip_stats = $10::jsonb,
              parse_fingerprint = $11::jsonb,
              stats = $12::jsonb
        WHERE id = $1
        RETURNING source`,
      [
        runId,
        args.status,
        toPgTimestamptz(args.finishedAt),
        args.pagesEnumerated,
        args.remoteTotal,
        args.remoteTotalSource ?? null,
        args.batchesTotal ?? null,
        args.batchesFailed ?? null,
        args.transportFailureRate ?? null,
        toPgJson(args.exitIpStats ?? {}, 'meta.ingest_run.exit_ip_stats'),
        toPgJson(fingerprint, 'meta.ingest_run.parse_fingerprint'),
        toPgJson(args.stats ?? {}, 'meta.ingest_run.stats'),
      ],
    );
    if (args.evaluateParseHealth === false) return null;
    const source = finished.rows[0]?.source;
    if (!source) throw new Error(`finishIngestRun: run ${runId} 不存在`);
    const stats =
      typeof args.stats === 'object' && args.stats !== null && !Array.isArray(args.stats)
        ? (args.stats as Record<string, unknown>)
        : {};
    const stratum = resolveParseHealthStratum(
      source,
      typeof stats['mode'] === 'string' ? stats['mode'] : null,
      args.populationType,
      stats,
    );
    const decisionSkipReason =
      args.healthDecisionSkipReason?.trim() ||
      (stratum.populationType === 'probe'
        ? 'probe_only'
        : args.batchesTotal === 0 &&
            metricCurrentSampleCount(fingerprint, 'http_status_dist') === 0
          ? 'empty_queue_no_business_requests'
          : null);
    return evaluateParseHealth(pool, {
      runId,
      source,
      mode: stratum.mode,
      populationType: stratum.populationType,
      fingerprint,
      exitIpStats: args.exitIpStats,
      decisionSkipReason,
      // 测试/合成 run 不应在共享 v2 库永久留下十行默认策略。
      ensurePolicies: !/^(?:test|synthetic)(?:_|:|$)/.test(source),
    });
  } catch (err) {
    if (isMissingRelation(err)) return null;
    throw err;
  }
}

async function pageScanHealthFingerprint(
  pool: Pool,
  runId: number,
): Promise<{
  fetched_claimed_ratio: number | null;
  checksum_ok_rate: number | null;
  sample_counts: Record<string, number>;
}> {
  const evidence = await query<{
    fetched_claimed_ratio: string | number | null;
    checksum_ok_rate: string | number | null;
    fetched_claimed_samples: string | number;
    checksum_samples: string | number;
  }>(
    pool,
    'parse_health:page_scan_fingerprint',
    `SELECT
       avg(
         CASE
           WHEN claimed_total = 0 THEN CASE WHEN fetched_total = 0 THEN 1.0 ELSE 0.0 END
           ELSE fetched_total::numeric / claimed_total
         END
       ) FILTER (
         WHERE kind = 'votes'
           AND claimed_total IS NOT NULL
           AND fetched_total IS NOT NULL
           AND COALESCE(error, '') NOT LIKE 'write_frozen:%'
       ) AS fetched_claimed_ratio,
       avg((checksum_ok::int)::numeric) FILTER (
         WHERE kind = 'votes'
           AND checksum_ok IS NOT NULL
           AND COALESCE(error, '') NOT LIKE 'write_frozen:%'
       ) AS checksum_ok_rate,
       count(*) FILTER (
         WHERE kind = 'votes'
           AND claimed_total IS NOT NULL
           AND fetched_total IS NOT NULL
           AND COALESCE(error, '') NOT LIKE 'write_frozen:%'
       ) AS fetched_claimed_samples,
       count(*) FILTER (
         WHERE kind = 'votes'
           AND checksum_ok IS NOT NULL
           AND COALESCE(error, '') NOT LIKE 'write_frozen:%'
       ) AS checksum_samples
     FROM meta.page_scan
    WHERE run_id = $1`,
    [runId],
  );
  const row = evidence.rows[0];
  return {
    fetched_claimed_ratio:
      row?.fetched_claimed_ratio === null || row?.fetched_claimed_ratio === undefined
        ? null
        : Number(row.fetched_claimed_ratio),
    checksum_ok_rate:
      row?.checksum_ok_rate === null || row?.checksum_ok_rate === undefined
        ? null
        : Number(row.checksum_ok_rate),
    sample_counts: {
      fetched_claimed_ratio: Number(row?.fetched_claimed_samples ?? 0),
      checksum_ok_rate: Number(row?.checksum_samples ?? 0),
    },
  };
}

function sampleCounts(value: unknown): Record<string, number> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .map(([key, raw]) => [key, Number(raw)] as const)
      .filter(([, count]) => Number.isFinite(count) && count >= 0),
  );
}

// ─── page_scan ───────────────────────────────────────────────────────────────

export interface RecordPageScanArgs extends PageScanRow {
  runId: number | null;
}

/**
 * 单页证据的唯一 TS 写入口。error 在这里统一清洗并按 16 KiB 截断，且追加清洗标记；
 * 调用方不再各自拼 meta.record_page_scan，以免失败内容本身卡死证据链。
 */
export async function recordPageScan(
  pool: Pool | PoolClient,
  args: RecordPageScanArgs,
): Promise<void> {
  await query(
    pool,
    `meta.record_page_scan:${args.kind}`,
    `SELECT meta.record_page_scan(
       $1::bigint, $2::int, $3::text, $4::text,
       $5::int, $6::int, $7::boolean, $8::int, $9::int, $10::bytea, $11::text
     )`,
    [
      args.runId,
      args.pageId,
      args.kind,
      args.status,
      args.claimedTotal ?? null,
      args.fetchedTotal ?? null,
      args.checksumOk ?? null,
      args.checksumExpected ?? null,
      args.checksumActual ?? null,
      args.resultHash ?? null,
      sanitizePageScanError(args.error, `page_scan:${args.kind}:${args.pageId}`),
    ],
  );
}

/**
 * 批量写扫描证据行。同一 run/page/kind 重放时覆盖本次观测列，语义与
 * meta.record_page_scan 一致；CLI 崩溃后调度器重启通常会带新 run_id。
 */
export async function insertPageScans(
  pool: Pool,
  runId: number | null,
  rows: readonly PageScanRow[],
  scannedAt: string,
): Promise<number> {
  if (runId === null || rows.length === 0) return 0;
  // 调用方通常已按 fullname 收敛；这里仍防御同 run/page/kind 的其它来源重复，
  // 避免一条 INSERT 触发 PG cardinality violation。
  const uniqueRows = new Map<string, PageScanRow>();
  for (const row of rows) uniqueRows.set(`${row.pageId}:${row.kind}`, row);
  const ts = toPgTimestamptz(scannedAt);
  let written = 0;
  try {
    // 12 列 × 500 行（scanned_at 共用一个参数），远低于 65535 上限。
    for (const part of chunk([...uniqueRows.values()], 500)) {
      const values: unknown[] = [];
      const tuples: string[] = [];
      part.forEach((r, i) => {
        const b = i * 11;
        tuples.push(
          `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, $${b + 7}, $${b + 8}, $${b + 9}, $${b + 10}, $${b + 11}, $${
            part.length * 11 + 1
          }::timestamptz)`,
        );
        values.push(
          runId,
          r.pageId,
          r.kind,
          r.status,
          r.claimedTotal ?? null,
          r.fetchedTotal ?? null,
          r.checksumOk ?? null,
          r.checksumExpected ?? null,
          r.checksumActual ?? null,
          r.resultHash ?? null,
          sanitizePageScanError(r.error, `page_scan:${r.kind}:${r.pageId}`),
        );
      });
      values.push(ts);
      const res = await query(
        pool,
        'meta.page_scan:insert',
        `INSERT INTO meta.page_scan
           (run_id, page_id, kind, status, claimed_total, fetched_total, checksum_ok,
            checksum_expected, checksum_actual, result_hash, error, scanned_at)
         VALUES ${tuples.join(', ')}
         ON CONFLICT (run_id, page_id, kind) DO UPDATE
            SET status = EXCLUDED.status,
                claimed_total = EXCLUDED.claimed_total,
                fetched_total = EXCLUDED.fetched_total,
                checksum_ok = EXCLUDED.checksum_ok,
                checksum_expected = EXCLUDED.checksum_expected,
                checksum_actual = EXCLUDED.checksum_actual,
                result_hash = COALESCE(EXCLUDED.result_hash, meta.page_scan.result_hash),
                error = EXCLUDED.error,
                scanned_at = EXCLUDED.scanned_at`,
        values,
      );
      written += res.rowCount ?? 0;
    }
    return written;
  } catch (err) {
    if (isMissingRelation(err)) {
      log.warn('meta.page_scan 尚未建表，跳过证据写入', { rows: rows.length });
      return 0;
    }
    throw err;
  }
}

// ─── scan_task ───────────────────────────────────────────────────────────────

/**
 * 入队（真队列语义）。冲突时**合并 reasons、取更高优先级、取更早的 not_before**，
 * 绝不覆盖 attempts / stable_count / last_result_hash —— 那些是执行侧的状态，
 * 发现侧无权重置（v1 DirtyPage 破坏性重建丢 Phase C 任务就是这么丢的）。
 */
export async function enqueueScanTasks(
  pool: Pool,
  rows: readonly ScanTaskRow[],
): Promise<number> {
  if (rows.length === 0) return 0;
  let written = 0;
  try {
    for (const part of chunk(rows, 250)) {
      const values: unknown[] = [];
      const tuples: string[] = [];
      part.forEach((r, i) => {
        const b = i * 5;
        tuples.push(
          `($${b + 1}::int, $${b + 2}::text, $${b + 3}::text[], ` +
          `$${b + 4}::int, $${b + 5}::timestamptz)`,
        );
        values.push(
          r.pageId,
          r.kind,
          r.reasons,
          r.priority ?? 0,
          r.notBefore === undefined || r.notBefore === null ? null : toPgTimestamptz(r.notBefore),
        );
      });
      const res = await query(
        pool,
        'meta.scan_task:enqueue',
        `INSERT INTO meta.scan_task AS st (page_id, kind, reasons, priority, not_before)
         SELECT input.page_id, input.kind, input.reasons, input.priority, input.not_before
           FROM (VALUES ${tuples.join(', ')})
                AS input(page_id, kind, reasons, priority, not_before)
          WHERE (
            (
              input.kind = 'meta'
              AND 'revision_regression_identity_check' = ANY(input.reasons)
            )
            OR NOT EXISTS (
              SELECT 1
                FROM meta.irreconcilable i
               WHERE i.page_id = input.page_id
                 AND i.kind = input.kind
                 AND i.resolved_at IS NULL
            )
          )
         ON CONFLICT (page_id, kind) DO UPDATE
            SET reasons = ARRAY(SELECT DISTINCT e FROM unnest(st.reasons || EXCLUDED.reasons) AS e),
                priority = GREATEST(st.priority, EXCLUDED.priority),
                not_before = LEAST(
                  COALESCE(st.not_before, EXCLUDED.not_before),
                  COALESCE(EXCLUDED.not_before, st.not_before)
                )`,
        values,
      );
      written += res.rowCount ?? 0;
    }
    return written;
  } catch (err) {
    if (isMissingRelation(err)) {
      log.warn('meta.scan_task 尚未建表，跳过入队', { rows: rows.length });
      return 0;
    }
    throw err;
  }
}

// ─── slug → page_id 解析 ─────────────────────────────────────────────────────

export type SlugResolutionSource = 'page_slug_history' | 'page_current' | 'unavailable';

export interface SlugResolution {
  source: SlugResolutionSource;
  map: Map<string, number>;
}

/**
 * 解析当前 slug → page_id。
 *
 * 主路径 ingest.page_slug_history(valid_to IS NULL)（SCD2 的当前行，psh_current 部分唯一索引
 * 保证每页只有一个当前 slug）；退化路径 serve.page_current.slug。两张表都不在时返回
 * source='unavailable'，全部 slug 视为未解析 —— **不猜、不造 page_id**。
 *
 * 解析不到的新 slug 不会变成 scan_task（page_id 是 NOT NULL），而是原样进
 * ingest_run.stats.unresolved_slugs，由后续"未知 fullname → 整页 GET 取 pageId"
 * 那一步（field-matrix 的身份解析规则）消化。
 */
export async function resolveSlugs(
  pool: Pool,
  slugs: readonly string[],
): Promise<SlugResolution> {
  const map = new Map<string, number>();
  if (slugs.length === 0) return { source: 'page_slug_history', map };

  const unique = [...new Set(slugs)];
  for (const [source, sql] of [
    [
      'page_slug_history',
      `SELECT psh.slug, psh.page_id
         FROM ingest.page_slug_history psh
         JOIN serve.page_current pc ON pc.page_id = psh.page_id
        WHERE psh.valid_to IS NULL
          AND psh.slug = ANY($1::text[])
          AND pc.status = 'live'
        ORDER BY psh.id DESC`,
    ],
    [
      'page_current',
      `SELECT slug, page_id FROM serve.page_current
        WHERE slug = ANY($1::text[])
          AND status = 'live'`,
    ],
  ] as const) {
    try {
      for (const part of chunk(unique, 5_000)) {
        const res = await query<{ slug: string; page_id: number }>(
          pool,
          `resolveSlugs:${source}`,
          sql,
          [part],
        );
        for (const row of res.rows) {
          // by-slug 裁决只允许 live 当前态。deleted 旧身份不是“已解析”：
          // 同 slug 删除重建时必须让 pending_page 重新取站上 pageId。
          if (!map.has(row.slug)) map.set(row.slug, Number(row.page_id));
        }
      }
      return { source, map };
    } catch (err) {
      if (isMissingRelation(err)) {
        log.warn(`${source} 不可用，尝试下一条解析路径`);
        map.clear();
        continue;
      }
      throw err;
    }
  }
  log.warn('slug→page_id 解析不可用（两张表都不存在），全部 slug 记为未解析');
  return { source: 'unavailable', map };
}

/** 取当前被认为存活的全部 slug（absence 推断的本地一侧）。 */
export async function fetchLiveSlugs(
  pool: Pool,
): Promise<{ available: boolean; rows: Array<{ slug: string; pageId: number }> }> {
  try {
    const res = await query<{ slug: string; page_id: number }>(
      pool,
      'serve.page_current:live',
      `SELECT slug, page_id FROM serve.page_current WHERE status = 'live'`,
    );
    return {
      available: true,
      rows: res.rows.map((r) => ({ slug: r.slug, pageId: Number(r.page_id) })),
    };
  } catch (err) {
    if (isMissingRelation(err)) {
      log.warn('serve.page_current 尚未建表，本轮不做 absence 推断');
      return { available: false, rows: [] };
    }
    throw err;
  }
}

export type { Pool, PoolClient };
