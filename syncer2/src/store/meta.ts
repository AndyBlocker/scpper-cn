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

const log = createLogger('meta');

/** PG "relation does not exist"。schema 尚未由任务 A-D 落地时会命中。 */
const UNDEFINED_TABLE = '42P01';

function isMissingRelation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === UNDEFINED_TABLE;
}

export type RunStatus = 'running' | 'ok' | 'failed' | 'aborted';

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
  | 'files';       // 0007：页面附件列表
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

export async function startIngestRun(
  pool: Pool,
  source: string,
  startedAt: string,
): Promise<number | null> {
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
  /** 传输层失败率（失败请求 / 总请求）。实测基线 ≈0.023。 */
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
  stats: unknown;
}

export async function finishIngestRun(
  pool: Pool,
  runId: number | null,
  args: FinishRunArgs,
): Promise<void> {
  if (runId === null) return;
  try {
    await query(
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
        WHERE id = $1`,
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
        JSON.stringify(args.exitIpStats ?? {}),
        JSON.stringify(args.parseFingerprint ?? {}),
        JSON.stringify(args.stats ?? {}),
      ],
    );
  } catch (err) {
    if (isMissingRelation(err)) return;
    throw err;
  }
}

// ─── page_scan ───────────────────────────────────────────────────────────────

/**
 * 批量写扫描证据行。ON CONFLICT DO NOTHING —— 同一 run 内重复投递是幂等的
 * （CLI 崩溃后调度器重启会带新 run_id，不会撞上）。
 */
export async function insertPageScans(
  pool: Pool,
  runId: number | null,
  rows: readonly PageScanRow[],
  scannedAt: string,
): Promise<number> {
  if (runId === null || rows.length === 0) return 0;
  const ts = toPgTimestamptz(scannedAt);
  let written = 0;
  try {
    // 9 列 × 500 行 = 4500 参数，远低于 65535 上限。
    for (const part of chunk(rows, 500)) {
      const values: unknown[] = [];
      const tuples: string[] = [];
      part.forEach((r, i) => {
        const b = i * 8;
        tuples.push(
          `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, $${b + 7}, $${b + 8}, $${
            part.length * 8 + 1
          }::timestamptz)`,
        );
        values.push(runId, r.pageId, r.kind, r.status, r.claimedTotal ?? null, r.fetchedTotal ?? null, r.resultHash ?? null, r.error ?? null);
      });
      values.push(ts);
      const res = await query(
        pool,
        'meta.page_scan:insert',
        `INSERT INTO meta.page_scan
           (run_id, page_id, kind, status, claimed_total, fetched_total, result_hash, error, scanned_at)
         VALUES ${tuples.join(', ')}
         ON CONFLICT (run_id, page_id, kind) DO NOTHING`,
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
        tuples.push(`($${b + 1}, $${b + 2}, $${b + 3}::text[], $${b + 4}, $${b + 5}::timestamptz)`);
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
         VALUES ${tuples.join(', ')}
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
      `SELECT slug, page_id FROM ingest.page_slug_history
        WHERE valid_to IS NULL AND slug = ANY($1::text[])`,
    ],
    [
      'page_current',
      `SELECT slug, page_id FROM serve.page_current
        WHERE slug = ANY($1::text[])
        ORDER BY (status = 'live') DESC, deleted_at DESC NULLS LAST`,
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
          // by-slug 裁决：删除重建会让两行共享同一 slug，ORDER BY 已把 live 排前，先到先得。
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
