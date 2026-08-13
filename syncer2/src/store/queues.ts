/**
 * 两条「未消化数据」队列的写入门面（TODO #14）：
 *   meta.pending_page      真·新页身份解析队列（slug 主键，page_id 尚不存在）
 *   meta.forum_scan_task   thread sitemap 新 id + category 周期枚举队列
 *
 * DDL 见 migrations/0012_collector_queues.sql（含"为什么不复用 meta.scan_task"的完整理由）。
 *
 * ── 全文件贯穿的一条纪律：发现侧 UPSERT 绝不覆盖执行侧状态 ────────────────────
 * 允许被发现侧改的列只有：last_seen_at / seen_count / reasons / priority(取大)。
 * `attempts` / `not_before` / `stable_count` / `status` / `locked_*` 一律不碰。
 * 理由不是洁癖：一个持续出现在 sitemap 里的坏 slug（例如私有页，永远解析不出 pageId）
 * 如果每轮发现都把 attempts 与 not_before 清零，就变成**每 10 分钟重试一次、永不退避**
 * 的死循环 —— 这正是 v1 DirtyPage 整表重建冲掉退避状态的同型病根（synthesis §5.4）。
 */

import type { Pool, PoolClient } from 'pg';
import { query, toPgTimestamptz, withTransaction } from './db.js';
import { toPgJson } from './pgText.js';
import { chunk } from '../util/concurrency.js';
import { createLogger } from '../util/log.js';

const log = createLogger('queues');

const UNDEFINED_TABLE = '42P01';

type PgExecutor = Pool | PoolClient;

function isMissingRelation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === UNDEFINED_TABLE;
}

// ─── meta.pending_page ───────────────────────────────────────────────────────

export interface PendingPageRow {
  slug: string;
  reasons: string[];
  priority?: number;
  discoveredBy?: string;
}

export interface PendingUpsertResult {
  available: boolean;
  /** 受影响行数（新插 + 刷新）。PG 的 ON CONFLICT DO UPDATE 无法区分两者，故只报总数。 */
  affected: number;
  /** 表中当前 pending/retry 的总数（冷启动闸的输入）。 */
  pendingTotal: number;
}

/**
 * 把「真·新页」slug 入队。幂等：ON CONFLICT (slug) 只刷发现侧列。
 */
export async function upsertPendingPages(
  pool: Pool,
  rows: readonly PendingPageRow[],
  seenAt: string,
): Promise<PendingUpsertResult> {
  if (rows.length === 0) {
    return { available: true, affected: 0, pendingTotal: await countPendingPages(pool) };
  }
  const ts = toPgTimestamptz(seenAt);
  let affected = 0;
  try {
    // 5 列 × 500 行 = 2500 参数（+1 时间戳），远低于 65535
    for (const part of chunk(rows, 500)) {
      const values: unknown[] = [];
      const tuples: string[] = [];
      const tsIndex = part.length * 4 + 1;
      part.forEach((r, i) => {
        const b = i * 4;
        tuples.push(
          `($${b + 1}, $${b + 2}::text[], $${b + 3}, $${b + 4}, $${tsIndex}::timestamptz, $${tsIndex}::timestamptz)`,
        );
        values.push(r.slug, r.reasons, r.priority ?? 0, r.discoveredBy ?? 'wikidot_sitemap');
      });
      values.push(ts);
      const res = await query(
        pool,
        'meta.pending_page:upsert',
        `INSERT INTO meta.pending_page AS pp
           (slug, reasons, priority, discovered_by, first_seen_at, last_seen_at)
         VALUES ${tuples.join(', ')}
         ON CONFLICT (slug) DO UPDATE
            SET last_seen_at = GREATEST(pp.last_seen_at, EXCLUDED.last_seen_at),
                seen_count   = pp.seen_count + 1,
                reasons      = ARRAY(SELECT DISTINCT e FROM unnest(pp.reasons || EXCLUDED.reasons) AS e),
                priority     = GREATEST(pp.priority, EXCLUDED.priority),
                -- gone 只是“当时 404”。resolved 也可能只解析到了后来被删的旧实体；
                -- 完整发现层再次看见且库内没有同 slug live 当前态时，必须重开身份解析。
                -- restricted v1 reuse 是受限分类 fullname→历史 canonical slug 的显式别名，
                -- 当前 live slug 本来就不同，不能被这条“同 slug 不存在”规则误重开。
                status       = CASE
                  WHEN pp.status IN ('gone', 'resolved')
                   AND pp.resolution_source IS DISTINCT FROM 'restricted_listpages_v1_reuse'
                   AND EXCLUDED.last_seen_at > COALESCE(pp.finished_at, pp.last_seen_at)
                   AND NOT EXISTS (
                     SELECT 1 FROM serve.page_current pc
                      WHERE pc.slug = pp.slug AND pc.status = 'live'
                   )
                    THEN 'pending'
                  ELSE pp.status
                END,
                state_changed_at = CASE
                  WHEN pp.status IN ('gone', 'resolved')
                   AND pp.resolution_source IS DISTINCT FROM 'restricted_listpages_v1_reuse'
                   AND EXCLUDED.last_seen_at > COALESCE(pp.finished_at, pp.last_seen_at)
                   AND NOT EXISTS (
                     SELECT 1 FROM serve.page_current pc
                      WHERE pc.slug = pp.slug AND pc.status = 'live'
                   )
                    THEN EXCLUDED.last_seen_at
                  ELSE pp.state_changed_at
                END,
                finished_at = CASE
                  WHEN pp.status IN ('gone', 'resolved')
                   AND pp.resolution_source IS DISTINCT FROM 'restricted_listpages_v1_reuse'
                   AND EXCLUDED.last_seen_at > COALESCE(pp.finished_at, pp.last_seen_at)
                   AND NOT EXISTS (
                     SELECT 1 FROM serve.page_current pc
                      WHERE pc.slug = pp.slug AND pc.status = 'live'
                   )
                    THEN NULL
                  ELSE pp.finished_at
                END,
                not_before = CASE
                  WHEN pp.status IN ('gone', 'resolved')
                   AND pp.resolution_source IS DISTINCT FROM 'restricted_listpages_v1_reuse'
                   AND EXCLUDED.last_seen_at > COALESCE(pp.finished_at, pp.last_seen_at)
                   AND NOT EXISTS (
                     SELECT 1 FROM serve.page_current pc
                      WHERE pc.slug = pp.slug AND pc.status = 'live'
                   )
                    THEN NULL
                  ELSE pp.not_before
                END`,
        values,
      );
      affected += res.rowCount ?? 0;
    }
    return { available: true, affected, pendingTotal: await countPendingPages(pool) };
  } catch (err) {
    if (isMissingRelation(err)) {
      log.warn('meta.pending_page 尚未建表（0012 未落地），跳过入队', { rows: rows.length });
      return { available: false, affected: 0, pendingTotal: 0 };
    }
    throw err;
  }
}

export async function countPendingPages(pool: Pool): Promise<number> {
  try {
    const res = await query<{ n: string }>(
      pool,
      'meta.pending_page:count',
      `SELECT count(*)::text AS n
         FROM meta.pending_page
        WHERE status IN ('pending','retry')`,
    );
    return Number(res.rows[0]?.n ?? '0');
  } catch (err) {
    if (isMissingRelation(err)) return 0;
    throw err;
  }
}

export async function pendingStatusBreakdown(pool: Pool): Promise<Record<string, number>> {
  try {
    const res = await query<{ status: string; n: string }>(
      pool,
      'meta.pending_page:breakdown',
      `SELECT status, count(*)::text AS n FROM meta.pending_page GROUP BY status ORDER BY status`,
    );
    return Object.fromEntries(res.rows.map((r) => [r.status, Number(r.n)]));
  } catch (err) {
    if (isMissingRelation(err)) return {};
    throw err;
  }
}

export interface ClaimedPending {
  slug: string;
  attempts: number;
  seenCount: number;
  reasons: string[];
  discoveredBy: string;
  wikidotId: number | null;
  observedSlug: string | null;
}

/**
 * 认领待解析 slug。`FOR UPDATE SKIP LOCKED` + 立刻写 locked_by/attempts，
 * 所以两个并发消化者不会抢到同一行（这是"短进程 + 调度器重启"模型下的必要条件：
 * 上一轮被 SIGKILL 的进程会留下 locked_by，由 `lockStaleAfterMs` 回收）。
 */
export async function claimPendingPages(
  pool: PgExecutor,
  limit: number,
  workerId: string,
  lockStaleAfterMs = 15 * 60_000,
): Promise<ClaimedPending[]> {
  if (limit <= 0) return [];
  try {
    const res = await query<{
      slug: string;
      attempts: number;
      seen_count: number;
      reasons: string[];
      discovered_by: string;
      wikidot_id: number | null;
      observed_slug: string | null;
    }>(
      pool,
      'meta.pending_page:claim',
      `WITH picked AS (
         SELECT slug FROM meta.pending_page
          WHERE status IN (
                  'pending','retry','waiting_evidence','conflict','irreconcilable',
                  'failed','mismatch'
                )
            AND (not_before IS NULL OR not_before <= now())
            AND (locked_by IS NULL OR locked_at < now() - ($3::bigint || ' milliseconds')::interval)
          ORDER BY priority DESC, not_before NULLS FIRST, first_seen_at
          LIMIT $2
          FOR UPDATE SKIP LOCKED
       )
       UPDATE meta.pending_page pp
          SET locked_by = $1, locked_at = now(), attempts = pp.attempts + 1
         FROM picked
        WHERE pp.slug = picked.slug
        RETURNING pp.slug, pp.attempts, pp.seen_count, pp.reasons,
                  pp.discovered_by, pp.wikidot_id, pp.observed_slug`,
      [workerId, limit, String(lockStaleAfterMs)],
    );
    return res.rows.map((r) => ({
      slug: r.slug,
      attempts: r.attempts,
      seenCount: r.seen_count,
      reasons: r.reasons ?? [],
      discoveredBy: r.discovered_by,
      wikidotId: r.wikidot_id === null ? null : Number(r.wikidot_id),
      observedSlug: r.observed_slug,
    }));
  } catch (err) {
    if (isMissingRelation(err)) {
      log.warn('meta.pending_page 尚未建表，无法认领');
      return [];
    }
    throw err;
  }
}

export interface PendingResolution {
  slug: string;
  status:
    | 'pending'
    | 'retry'
    | 'waiting_evidence'
    | 'resolved'
    | 'gone'
    | 'conflict'
    | 'irreconcilable';
  wikidotId?: number | null;
  pageId?: number | null;
  categoryId?: number | null;
  observedSlug?: string | null;
  httpStatus?: number | null;
  error?: string | null;
  /** retry / waiting_evidence / conflict / irreconcilable 的下次复查时刻。 */
  notBefore?: string | null;
  resolutionSource?: string | null;
  resolutionEvidence?: Record<string, unknown> | null;
}

/** 回写单条解析结果。所有非终态都必须带下一次调度时刻，终态统一写 finished_at。 */
export async function finishPendingPage(pool: PgExecutor, r: PendingResolution): Promise<void> {
  try {
    await query(
      pool,
      'meta.pending_page:finish',
      `UPDATE meta.pending_page
          SET status = $2,
              wikidot_id = COALESCE($3, wikidot_id),
              page_id = COALESCE($4, page_id),
              category_id = COALESCE($5, category_id),
              observed_slug = COALESCE($6, observed_slug),
              http_status = $7,
              last_error = $8,
              not_before = $9::timestamptz,
              resolved_at = CASE WHEN $2 = 'resolved' THEN now() ELSE resolved_at END,
              finished_at = CASE WHEN $2 IN ('resolved','gone') THEN now() ELSE NULL END,
              state_changed_at = now(),
              resolution_source = $10,
              resolution_evidence = COALESCE($11::jsonb, '{}'::jsonb),
              locked_by = NULL,
              locked_at = NULL
        WHERE slug = $1`,
      [
        r.slug,
        r.status,
        r.wikidotId ?? null,
        r.pageId ?? null,
        r.categoryId ?? null,
        r.observedSlug ?? null,
        r.httpStatus ?? null,
        r.error ?? null,
        r.notBefore === undefined || r.notBefore === null ? null : toPgTimestamptz(r.notBefore),
        r.resolutionSource ?? null,
        r.resolutionEvidence === undefined || r.resolutionEvidence === null
          ? null
          : toPgJson(r.resolutionEvidence, 'pending_page.resolution_evidence'),
      ],
    );
  } catch (err) {
    if (isMissingRelation(err)) return;
    throw err;
  }
}

/** 我方写冻结/进程停止不算目标失败：释放认领并退回本轮白烧的 attempt。 */
export async function releasePendingPageClaim(
  pool: PgExecutor,
  slug: string,
  workerId: string,
): Promise<void> {
  await query(
    pool,
    'meta.pending_page:release_claim',
    `UPDATE meta.pending_page
        SET locked_by = NULL,
            locked_at = NULL,
            attempts = GREATEST(0, attempts - 1),
            not_before = now()
      WHERE slug = $1 AND locked_by = $2
        AND status IN ('pending','retry','waiting_evidence','conflict','irreconcilable','failed','mismatch')`,
    [slug, workerId],
  );
}

/** 批量释放本 worker 尚未完成的 pending claim；已完成行因 locked_by=NULL 自动跳过。 */
export async function releasePendingPageClaims(
  pool: PgExecutor,
  slugs: readonly string[],
  workerId: string,
): Promise<number> {
  if (slugs.length === 0) return 0;
  const released = await query(
    pool,
    'meta.pending_page:release_claims',
    `UPDATE meta.pending_page
        SET locked_by = NULL,
            locked_at = NULL,
            attempts = GREATEST(0, attempts - 1),
            not_before = now()
      WHERE slug = ANY($1::text[]) AND locked_by = $2
        AND status IN ('pending','retry','waiting_evidence','conflict','irreconcilable','failed','mismatch')`,
    [[...new Set(slugs)], workerId],
  );
  return released.rowCount ?? 0;
}

/**
 * 指数退避：1h → 4h → 24h → 7d（与 meta.scan_task 的退避阶梯同口径）。
 * 上限 7 天而不是无限增长：私有页/永久坏 slug 应该**低频保留**而不是被丢掉，
 * 因为它们随时可能变公开。
 */
export function backoffFrom(attempts: number, now = Date.now()): string {
  const ladderMs = [60 * 60_000, 4 * 60 * 60_000, 24 * 60 * 60_000, 7 * 24 * 60 * 60_000];
  const idx = Math.min(Math.max(attempts, 1) - 1, ladderMs.length - 1);
  return new Date(now + ladderMs[idx]!).toISOString();
}

// ─── ingest.register_page ────────────────────────────────────────────────────

export interface ExistingIdentity {
  pageId: number;
  /** ingest.page_slug_history 里 valid_to IS NULL 的那一行（可能为 null：历史缺行）。 */
  currentSlug: string | null;
  status: 'live' | 'deleted';
}

/** 同 slug 最近的 deleted 前身；仅供已经站上整页 pageId 证明的复用接力。 */
export async function lookupLatestDeletedIdentityBySlug(
  pool: PgExecutor,
  slug: string,
): Promise<ExistingIdentity | null> {
  const res = await query<{ page_id: number; current_slug: string; status: 'deleted' }>(
    pool,
    'serve.page_current:latest_deleted_by_slug',
    `SELECT page_id, slug AS current_slug, status
       FROM serve.page_current
      WHERE slug = $1 AND status = 'deleted'
      ORDER BY deleted_at DESC NULLS LAST, page_id DESC
      LIMIT 1`,
    [slug],
  );
  const row = res.rows[0];
  return row === undefined
    ? null
    : { pageId: Number(row.page_id), currentSlug: row.current_slug, status: row.status };
}

/**
 * 先查 wikidot_id 是否已有身份行。
 *
 * **为什么不能只调 register_page 了事：** register_page 是幂等的身份查询/铸造，
 * 它对已存在的 wikidot_id **直接返回既有 page_id 且刻意不改 slug**
 * （"slug 变更走 apply_page_meta，那里才有 SCD2 + renamed 事件"）。
 * 于是"sitemap 报出一个新 slug，而这个 wikidot_id 已经在库里挂着旧 slug"这一情形——
 * 也就是**改名**——如果直接 register_page 并把 pending 标成 resolved，
 * 改名这件事就被静默吞掉了：page_slug_history 里当前 slug 还是旧的，
 * 而队列已经认为"这条处理完了"。
 * 所以这里先查一次（本地 SQL，零 wikidot 成本），改名走单独的分支。
 */
export async function lookupIdentityByWikidotId(
  pool: PgExecutor,
  wikidotId: number,
): Promise<ExistingIdentity | null> {
  const res = await query<{
    page_id: number;
    current_slug: string | null;
    status: 'live' | 'deleted';
  }>(
    pool,
    'ingest.page:lookup_by_wikidot_id',
    `SELECT p.id AS page_id, psh.slug AS current_slug, pc.status
       FROM ingest.page p
       JOIN serve.page_current pc ON pc.page_id = p.id
       LEFT JOIN ingest.page_slug_history psh
              ON psh.page_id = p.id AND psh.valid_to IS NULL
      WHERE p.wikidot_id = $1`,
    [wikidotId],
  );
  const row = res.rows[0];
  if (row === undefined) return null;
  return { pageId: Number(row.page_id), currentSlug: row.current_slug, status: row.status };
}

/** 同一 wikidotId 的页重新出现：先用直接身份证据更新 slug，再写 restored 生命事件。 */
export async function restorePageIdentity(
  pool: Pool,
  args: {
    pageId: number;
    wikidotId: number;
    slug: string;
    observedAt: string;
    runId?: number | null;
  },
): Promise<void> {
  await withTransaction(pool, 'restore-page-identity', async (db) => {
    await query(
      db,
      'ingest.apply_page_meta:restore_identity',
      `SELECT ingest.apply_page_meta(
         p_page       => $1::int,
         p_attrs      => jsonb_build_object('slug', $2::text),
         p_observed   => $3::timestamptz,
         p_source     => 'wikidot',
         p_run        => $4::bigint,
         p_wikidot_id => $5::int
       )`,
      [args.pageId, args.slug, toPgTimestamptz(args.observedAt), args.runId ?? null, args.wikidotId],
    );
    await query(
      db,
      'ingest.apply_page_life:restore_identity',
      `SELECT ingest.apply_page_life(
         p_page         => $1::int,
         p_kind         => 'restored',
         p_occurred     => $2::timestamptz,
         p_precision    => 'inferred',
         p_observed     => $2::timestamptz,
         p_source       => 'wikidot',
         p_run          => $3::bigint,
         p_wikidot_id   => $4::int
       )`,
      [args.pageId, toPgTimestamptz(args.observedAt), args.runId ?? null, args.wikidotId],
    );
  });
}

/**
 * 调 ingest.register_page 铸身份（幂等，已存在则直接返回既有 page_id）。
 * 用具名参数：签名有 7 个参数且中间有默认值，位置传参一改签名就会静默错位。
 */
export async function registerPage(
  pool: PgExecutor,
  args: {
    wikidotId: number;
    slug: string;
    observedAt: string;
    source?: string;
    runId?: number | null;
    /** ListPages 的站上创建时刻；有证据时让 created life event 直接落 exact。 */
    createdAt?: string | null;
  },
): Promise<number> {
  const res = await query<{ page_id: number }>(
    pool,
    'ingest.register_page',
    `SELECT ingest.register_page(
              p_wikidot_id => $1,
              p_slug       => $2,
              p_observed   => $3::timestamptz,
              p_source     => $4,
              p_run        => $5,
              p_created_at => $6::timestamptz
            ) AS page_id`,
    [
      args.wikidotId,
      args.slug,
      toPgTimestamptz(args.observedAt),
      args.source ?? 'wikidot',
      args.runId ?? null,
      args.createdAt === undefined || args.createdAt === null
        ? null
        : toPgTimestamptz(args.createdAt),
    ],
  );
  const id = res.rows[0]?.page_id;
  if (id === undefined || id === null) {
    throw new Error(`register_page 未返回 page_id（wikidot_id=${args.wikidotId}, slug=${args.slug}）`);
  }
  return Number(id);
}

export interface SlugReuseIdentityResult {
  predecessor_id: number;
  predecessor_wikidot_id: number;
  successor_id: number;
  successor_wikidot_id: number;
  slug: string;
  deleted_event_seq: number | null;
  lineage_candidate_inserted: boolean;
}

export interface IdentityMissingDeletionResult {
  page_id: number;
  wikidot_id: number;
  slug: string;
  deleted_event_seq: number | null;
}

/**
 * 同 slug 的整页身份与任务身份不一致时，原子完成旧→新生命周期接力。
 * 事实写入全部封装在 SECURITY DEFINER 函数内；采集角色不获得 ingest/serve 表 DML。
 */
export async function applySlugReuseIdentity(
  pool: Pool,
  args: {
    predecessorId: number;
    observedWikidotId: number;
    slug: string;
    observedAt: string;
    runId?: number | null;
  },
): Promise<SlugReuseIdentityResult> {
  const result = await query<{ result: SlugReuseIdentityResult }>(
    pool,
    'ingest.apply_slug_reuse_identity',
    `SELECT ingest.apply_slug_reuse_identity(
       $1::int, $2::int, $3::text, $4::timestamptz, $5::bigint
     ) AS result`,
    [
      args.predecessorId,
      args.observedWikidotId,
      args.slug,
      toPgTimestamptz(args.observedAt),
      args.runId ?? null,
    ],
  );
  const row = result.rows[0]?.result;
  if (row === undefined || row === null) {
    throw new Error(
      `apply_slug_reuse_identity 未返回结果（predecessor=${args.predecessorId}, slug=${args.slug}）`,
    );
  }
  return row;
}

/**
 * page-bound AMC 已证明旧 pageId 无实体，且同一轮 slug 整页 GET 又返回 404 时的删除入口。
 * 两个独立、同页、同轮的直接信号由调用方取得；数据库函数再次核对 page/wikidotId/slug。
 */
export async function applyIdentityMissingDeletion(
  pool: Pool,
  args: {
    pageId: number;
    expectedWikidotId: number;
    slug: string;
    observedAt: string;
    runId?: number | null;
  },
): Promise<IdentityMissingDeletionResult> {
  const result = await query<{ result: IdentityMissingDeletionResult }>(
    pool,
    'ingest.apply_identity_missing_deletion',
    `SELECT ingest.apply_identity_missing_deletion(
       $1::int, $2::int, $3::text, $4::timestamptz, $5::bigint
     ) AS result`,
    [
      args.pageId,
      args.expectedWikidotId,
      args.slug,
      toPgTimestamptz(args.observedAt),
      args.runId ?? null,
    ],
  );
  const row = result.rows[0]?.result;
  if (row === undefined || row === null) {
    throw new Error(
      `apply_identity_missing_deletion 未返回结果（page=${args.pageId}, slug=${args.slug}）`,
    );
  }
  return row;
}

// ─── meta.forum_scan_task ────────────────────────────────────────────────────

export type ForumTargetKind = 'thread' | 'category';

export interface ForumEnqueueRow {
  kind: ForumTargetKind;
  targetId: number;
  reasons: string[];
  priority?: number;
  lane?: 'catchup' | 'steady';
}

/** 取库内已知的 thread / category id（差集的本地一侧）。 */
export async function fetchKnownForumIds(
  pool: Pool,
  kind: ForumTargetKind,
): Promise<{ available: boolean; known: Set<number>; deleted: Set<number> }> {
  const table = kind === 'thread' ? 'ingest.forum_thread' : 'ingest.forum_category';
  // forum_category 没有 is_deleted 列（当前态表 + 不物理删除），故只有 thread 查它
  const sql =
    kind === 'thread'
      ? `SELECT id::text AS id, is_deleted FROM ingest.forum_thread`
      : `SELECT id::text AS id, false AS is_deleted FROM ingest.forum_category`;
  try {
    const res = await query<{ id: string; is_deleted: boolean }>(pool, `${table}:ids`, sql);
    const known = new Set<number>();
    const deleted = new Set<number>();
    for (const row of res.rows) {
      const id = Number(row.id);
      known.add(id);
      if (row.is_deleted) deleted.add(id);
    }
    return { available: true, known, deleted };
  } catch (err) {
    if (isMissingRelation(err)) {
      log.warn(`${table} 尚未建表，无法做差集`);
      return { available: false, known: new Set(), deleted: new Set() };
    }
    throw err;
  }
}

/**
 * 入队 thread 发现差集 / category 周期枚举。
 * category 任务会周期重入，用完整分类分页裁决 thread 存亡；ON CONFLICT 只刷发现侧列。
 */
export async function enqueueForumTargets(
  pool: Pool,
  rows: readonly ForumEnqueueRow[],
  seenAt: string,
): Promise<{ available: boolean; affected: number }> {
  if (rows.length === 0) return { available: true, affected: 0 };
  const ts = toPgTimestamptz(seenAt);
  let affected = 0;
  try {
    for (const part of chunk(rows, 500)) {
      const values: unknown[] = [];
      const tuples: string[] = [];
      const tsIndex = part.length * 5 + 1;
      part.forEach((r, i) => {
        const b = i * 5;
        tuples.push(
          `($${b + 1}, $${b + 2}, $${b + 3}::text[], $${b + 4}, $${b + 5}, ` +
            `$${tsIndex}::timestamptz, $${tsIndex}::timestamptz)`,
        );
        values.push(r.kind, r.targetId, r.reasons, r.priority ?? 0, r.lane ?? 'catchup');
      });
      values.push(ts);
      const res = await query(
        pool,
        'meta.forum_scan_task:enqueue',
        `INSERT INTO meta.forum_scan_task AS fst
           (kind, target_id, reasons, priority, lane, first_seen_at, last_seen_at)
         VALUES ${tuples.join(', ')}
         ON CONFLICT (kind, target_id) DO UPDATE
            SET last_seen_at = GREATEST(fst.last_seen_at, EXCLUDED.last_seen_at),
                seen_count   = fst.seen_count + 1,
                reasons      = ARRAY(SELECT DISTINCT e FROM unnest(fst.reasons || EXCLUDED.reasons) AS e),
                priority     = CASE
                                 WHEN 'forum_runtime_budget_rotated' = ANY(fst.reasons)
                                   THEN fst.priority
                                 ELSE GREATEST(fst.priority, EXCLUDED.priority)
                               END,
                lane         = CASE
                                 WHEN fst.lane = 'steady' OR EXCLUDED.lane = 'steady'
                                   THEN 'steady'
                                 ELSE 'catchup'
                               END`,
        values,
      );
      affected += res.rowCount ?? 0;
    }
    return { available: true, affected };
  } catch (err) {
    if (isMissingRelation(err)) {
      log.warn('meta.forum_scan_task 尚未建表（0012 未落地），跳过入队', { rows: rows.length });
      return { available: false, affected: 0 };
    }
    throw err;
  }
}

export async function forumQueueBreakdown(pool: Pool): Promise<Record<string, number>> {
  try {
    const res = await query<{ kind: string; lane: string; n: string }>(
      pool,
      'meta.forum_scan_task:breakdown',
      `SELECT kind, lane, count(*)::text AS n
         FROM meta.forum_scan_task
        WHERE terminal_at IS NULL
        GROUP BY lane, kind ORDER BY lane, kind`,
    );
    return Object.fromEntries(res.rows.map((r) => [`${r.lane}:${r.kind}`, Number(r.n)]));
  } catch (err) {
    if (isMissingRelation(err)) return {};
    throw err;
  }
}

// ─── M5 forum-scan 消费侧 ───────────────────────────────────────────────────

export interface ClaimedForumTarget {
  taskId: number;
  kind: ForumTargetKind;
  targetId: number;
  attempts: number;
  stableCount: number;
  lastResultHash: Buffer | null;
  reasons: string[];
  lane: 'catchup' | 'steady';
}

export interface ForumTargetFilter {
  threadId?: number | null;
  categoryId?: number | null;
}

/**
 * 认领 thread 新 id / category 周期枚举任务。
 *
 * category 排在 thread 前：空库第一轮必须先把 FK 父表补齐，再允许 thread upsert。
 * exact filter 只用于定向修复/小样本，不改变正常调度语义。
 */
export async function claimForumTargets(
  pool: Pool,
  requestedLimit: number,
  workerId: string,
  filter: ForumTargetFilter = {},
  lockStaleAfterMs = 30 * 60_000,
): Promise<ClaimedForumTarget[]> {
  const limit = Math.min(50, Math.max(0, Math.floor(requestedLimit)));
  if (limit === 0) return [];
  const res = await query<{
    id: string;
    kind: ForumTargetKind;
    target_id: string;
    attempts: number;
    stable_count: number;
    last_result_hash: Buffer | null;
    reasons: string[];
    lane: 'catchup' | 'steady';
  }>(
    pool,
    'meta.forum_scan_task:claim',
    `WITH candidates AS MATERIALIZED (
       SELECT fst.id, fst.lane,
              row_number() OVER (
                PARTITION BY fst.lane
                ORDER BY COALESCE(fst.not_before, fst.first_seen_at), fst.id
              ) AS lane_rank
        FROM meta.forum_scan_task fst
        WHERE (fst.not_before IS NULL OR fst.not_before <= now())
          AND fst.terminal_at IS NULL
          AND (
            fst.locked_by IS NULL
            OR fst.locked_at < now() - ($3::bigint || ' milliseconds')::interval
          )
          AND ($4::bigint IS NULL OR (fst.kind = 'thread' AND fst.target_id = $4))
          AND ($5::bigint IS NULL OR (fst.kind = 'category' AND fst.target_id = $5))
     ), reserved AS (
       SELECT c.id
         FROM candidates c
        WHERE c.lane_rank <= CASE c.lane
          WHEN 'steady' THEN GREATEST(1, ceil($2::int * 0.4)::int)
          ELSE GREATEST(0, floor($2::int * 0.6)::int)
        END
     ), fill AS (
       SELECT c.id
         FROM candidates c
        WHERE NOT EXISTS (SELECT 1 FROM reserved r WHERE r.id = c.id)
        ORDER BY c.lane_rank, c.id
        LIMIT GREATEST(0, $2::int - (SELECT count(*)::int FROM reserved))
     ), chosen AS (
       SELECT id FROM reserved
       UNION ALL
       SELECT id FROM fill
     ), picked AS (
       SELECT fst.id
         FROM meta.forum_scan_task fst
         JOIN chosen c ON c.id = fst.id
        WHERE (
          fst.locked_by IS NULL
          OR fst.locked_at < now() - ($3::bigint || ' milliseconds')::interval
        )
          AND fst.terminal_at IS NULL
        ORDER BY (fst.lane = 'steady') DESC, fst.priority DESC, fst.id
        FOR UPDATE OF fst SKIP LOCKED
     )
     UPDATE meta.forum_scan_task fst
        SET locked_by = $1,
            locked_at = now(),
            attempts = fst.attempts + 1
       FROM picked
      WHERE fst.id = picked.id
      RETURNING fst.id::text, fst.kind, fst.target_id::text, fst.attempts,
                fst.stable_count, fst.last_result_hash, fst.reasons, fst.lane`,
    [
      workerId,
      limit,
      String(lockStaleAfterMs),
      filter.threadId ?? null,
      filter.categoryId ?? null,
    ],
  );
  return res.rows.map((row) => ({
    taskId: Number(row.id),
    kind: row.kind,
    targetId: Number(row.target_id),
    attempts: Number(row.attempts),
    stableCount: Number(row.stable_count),
    lastResultHash: row.last_result_hash,
    reasons: row.reasons,
    lane: row.lane,
  }));
}

export interface FinishForumTargetArgs {
  workerId: string;
  status: 'ok' | 'partial' | 'failed';
  resultHash?: Buffer | null;
  terminalFailure?: {
    family: 'identity_absent' | 'structural';
    reason: string;
  } | null;
  now: string;
}

export interface FinishForumTargetResult {
  action: 'deleted' | 'retried' | 'irreconcilable';
  stableCount: number;
  notBefore: string | null;
}

/** 成功即删；partial/failed 保留并按 1h→4h→24h→7d 退避。 */
export async function finishForumTarget(
  pool: Pool,
  task: ClaimedForumTarget,
  args: FinishForumTargetArgs,
): Promise<FinishForumTargetResult> {
  if (args.status === 'ok') {
    await query(
      pool,
      'meta.forum_scan_task:finish_success',
      `DELETE FROM meta.forum_scan_task WHERE id = $1 AND locked_by = $2`,
      [task.taskId, args.workerId],
    );
    return { action: 'deleted', stableCount: 0, notBefore: null };
  }

  if (args.terminalFailure !== undefined && args.terminalFailure !== null) {
    const reason = args.terminalFailure.reason.trim();
    if (reason === '') throw new TypeError('forum target terminal reason 不能为空');
    await query(
      pool,
      'meta.forum_scan_task:finish_terminal',
      `UPDATE meta.forum_scan_task
          SET terminal_at = $3::timestamptz,
              terminal_family = $4,
              terminal_reason = $5,
              last_result_hash = COALESCE($6, last_result_hash),
              stable_count = GREATEST(stable_count, 1),
              not_before = NULL,
              locked_by = NULL,
              locked_at = NULL
        WHERE id = $1 AND locked_by = $2`,
      [
        task.taskId,
        args.workerId,
        toPgTimestamptz(args.now),
        args.terminalFailure.family,
        reason,
        args.resultHash ?? null,
      ],
    );
    return { action: 'irreconcilable', stableCount: Math.max(task.stableCount, 1), notBefore: null };
  }

  const sameHash =
    args.resultHash !== undefined &&
    args.resultHash !== null &&
    task.lastResultHash !== null &&
    task.lastResultHash.equals(args.resultHash);
  const stableCount = args.resultHash ? (sameHash ? task.stableCount + 1 : 1) : 0;
  const notBefore = backoffFrom(
    stableCount >= 3 ? stableCount - 2 : task.attempts,
    Date.parse(toPgTimestamptz(args.now)),
  );
  await query(
    pool,
    'meta.forum_scan_task:finish_retry',
    `UPDATE meta.forum_scan_task
        SET stable_count = $3,
            last_result_hash = COALESCE($4, last_result_hash),
            not_before = $5::timestamptz,
            locked_by = NULL,
            locked_at = NULL
      WHERE id = $1 AND locked_by = $2`,
    [task.taskId, args.workerId, stableCount, args.resultHash ?? null, notBefore],
  );
  return { action: 'retried', stableCount, notBefore };
}

/**
 * 正常时间预算释放归还 claim attempt；已真正开始却超预算的头部任务再降一级优先级，
 * 避免同一超大目标每轮重回 FIFO 队首。异常/熔断保留 attempt 并延后。
 */
export async function releaseForumTargetLocks(
  pool: Pool,
  taskIds: readonly number[],
  workerId: string,
  deferAfterCrash = false,
  rotateAfterBudget = false,
): Promise<number> {
  if (taskIds.length === 0) return 0;
  const result = await query(
    pool,
    'meta.forum_scan_task:release_locks',
    `UPDATE meta.forum_scan_task
        SET locked_by = NULL,
            locked_at = NULL,
            attempts = CASE WHEN $3::boolean THEN attempts ELSE GREATEST(0, attempts - 1) END,
            priority = CASE
              WHEN $4::boolean AND priority > -2147483648 THEN priority - 1
              ELSE priority
            END,
            reasons = CASE WHEN $4::boolean
              THEN ARRAY(
                SELECT DISTINCT reason
                  FROM unnest(reasons || ARRAY['forum_runtime_budget_rotated']) AS reason
              )
              ELSE reasons
            END,
            not_before = CASE WHEN $3::boolean
              THEN COALESCE(not_before, now() + interval '1 hour')
              WHEN $4::boolean THEN now() + interval '1 hour'
              ELSE not_before
            END
      WHERE id = ANY($1::bigint[]) AND locked_by = $2`,
    [taskIds, workerId, deferAfterCrash, rotateAfterBudget],
  );
  return result.rowCount ?? 0;
}

export interface ClaimedDiscussionTask {
  taskId: number;
  pageId: number;
  wikidotId: number;
  slug: string;
  kind: 'forum' | 'discussion';
  claimedTotal: number;
  expectedThreadId: number | null;
  attempts: number;
  stableCount: number;
  lastResultHash: Buffer | null;
  reasons: string[];
  lane: 'catchup' | 'steady';
}

/**
 * 全站讨论串关联冷启动。只播种 live + 有评论声明 + 尚无 thread id 的页面；
 * ON CONFLICT 保留执行侧 attempts/not_before/lock，仅合并发现原因。
 */
export async function seedForumDiscussionLinkTasks(
  pool: Pool,
  limit: number | null = null,
): Promise<number> {
  const result = await query(
    pool,
    'meta.scan_task:seed_forum_links',
    `WITH candidates AS (
       SELECT pc.page_id
         FROM serve.page_current pc
        WHERE pc.status = 'live'
          AND pc.comment_count > 0
          AND pc.discussion_thread_id IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM meta.scan_task st
             WHERE st.page_id = pc.page_id AND st.kind IN ('forum', 'discussion')
          )
        ORDER BY pc.page_id
        LIMIT COALESCE($1::int, 2147483647)
     )
     INSERT INTO meta.scan_task AS st(page_id, kind, reasons, priority, not_before)
     SELECT c.page_id, 'discussion', ARRAY['forum_link_initial_catchup'], 90, NULL
       FROM candidates c
     ON CONFLICT (page_id, kind) DO UPDATE
        SET reasons = ARRAY(
              SELECT DISTINCT e FROM unnest(st.reasons || EXCLUDED.reasons) AS e
            ),
            priority = CASE
              WHEN 'forum_runtime_budget_rotated' = ANY(st.reasons) THEN st.priority
              ELSE GREATEST(st.priority, EXCLUDED.priority)
            END,
            not_before = LEAST(
              COALESCE(st.not_before, EXCLUDED.not_before),
              COALESCE(EXCLUDED.not_before, st.not_before)
            )`,
    [limit],
  );
  return result.rowCount ?? 0;
}

/** 认领 Tier1 评论变化产生的页级论坛任务。 */
export async function claimDiscussionTasks(
  pool: Pool,
  requestedLimit: number,
  workerId: string,
  pageId: number | null = null,
  lockStaleAfterMs = 30 * 60_000,
): Promise<ClaimedDiscussionTask[]> {
  const limit = Math.min(50, Math.max(0, Math.floor(requestedLimit)));
  if (limit === 0) return [];
  const result = await query<{
    id: string;
    page_id: number;
    wikidot_id: number;
    slug: string;
    kind: 'forum' | 'discussion';
    comment_count: number;
    discussion_thread_id: string | null;
    attempts: number;
    stable_count: number;
    last_result_hash: Buffer | null;
    reasons: string[];
    lane: 'catchup' | 'steady';
  }>(
    pool,
    'meta.scan_task:claim_discussion',
    `WITH candidates AS MATERIALIZED (
       SELECT st.id,
              CASE WHEN 'forum_link_initial_catchup' = ANY(st.reasons)
                   THEN 'catchup' ELSE 'steady' END AS lane,
              row_number() OVER (
                PARTITION BY ('forum_link_initial_catchup' = ANY(st.reasons))
                ORDER BY COALESCE(st.not_before, st.created_at), st.id
              ) AS lane_rank
         FROM meta.scan_task st
         JOIN serve.page_current pc ON pc.page_id = st.page_id
        WHERE st.kind IN ('forum', 'discussion')
          AND pc.status = 'live'
          AND ($4::int IS NULL OR st.page_id = $4)
          AND (st.not_before IS NULL OR st.not_before <= now())
          AND (
            st.locked_by IS NULL
            OR st.locked_at < now() - ($3::bigint || ' milliseconds')::interval
          )
     ), reserved AS (
       SELECT c.id
         FROM candidates c
        WHERE $4::int IS NOT NULL
           OR c.lane_rank <= CASE c.lane
                WHEN 'catchup' THEN GREATEST(
                  0,
                  $2::int - GREATEST(1, floor($2::int * 0.4)::int)
                )
                ELSE GREATEST(1, floor($2::int * 0.4)::int)
              END
     ), fill AS (
       SELECT c.id FROM candidates c
        WHERE NOT EXISTS (SELECT 1 FROM reserved r WHERE r.id = c.id)
       ORDER BY c.lane_rank, c.id
       LIMIT GREATEST(0, $2::int - (SELECT count(*)::int FROM reserved))
     ), chosen AS (
       SELECT id FROM reserved
       UNION ALL
       SELECT id FROM fill
     ), picked AS (
       SELECT st.id
         FROM meta.scan_task st
         JOIN chosen c ON c.id = st.id
        WHERE (
          st.locked_by IS NULL
          OR st.locked_at < now() - ($3::bigint || ' milliseconds')::interval
        )
        ORDER BY st.priority DESC, st.id
        FOR UPDATE OF st SKIP LOCKED
     )
     UPDATE meta.scan_task st
        SET locked_by = $1,
            locked_at = now(),
            attempts = st.attempts + 1
       FROM picked, serve.page_current pc
      WHERE st.id = picked.id
        AND pc.page_id = st.page_id
      RETURNING st.id::text, st.page_id, pc.wikidot_id, pc.slug, st.kind,
                pc.comment_count, pc.discussion_thread_id::text,
                st.attempts, st.stable_count, st.last_result_hash, st.reasons,
                CASE WHEN 'forum_link_initial_catchup' = ANY(st.reasons)
                     THEN 'catchup' ELSE 'steady' END AS lane`,
    [workerId, limit, String(lockStaleAfterMs), pageId],
  );
  return result.rows.map((row) => ({
    taskId: Number(row.id),
    pageId: Number(row.page_id),
    wikidotId: Number(row.wikidot_id),
    slug: row.slug,
    kind: row.kind,
    claimedTotal: Number(row.comment_count),
    expectedThreadId:
      row.discussion_thread_id === null ? null : Number(row.discussion_thread_id),
    attempts: Number(row.attempts),
    stableCount: Number(row.stable_count),
    lastResultHash: row.last_result_hash,
    reasons: row.reasons,
    lane: row.lane,
  }));
}

export interface FinishDiscussionTaskArgs {
  workerId: string;
  status: 'ok' | 'partial' | 'failed';
  resultHash?: Buffer | null;
  terminalFailure?: boolean;
  localValue?: Record<string, unknown>;
  remoteValue?: Record<string, unknown>;
  now: string;
}

/** 页级任务遵守 scan_task 的成功删除 + stable_count 收敛语义。 */
export async function finishDiscussionTask(
  pool: Pool,
  task: ClaimedDiscussionTask,
  args: FinishDiscussionTaskArgs,
): Promise<{ action: 'deleted' | 'retried' | 'irreconcilable'; stableCount: number; notBefore: string | null }> {
  const now = toPgTimestamptz(args.now);
  if (args.status === 'ok') {
    await query(
      pool,
      'meta.irreconcilable:discussion_resolve',
      `UPDATE meta.irreconcilable
          SET resolved_at = $3::timestamptz,
              last_checked = $3::timestamptz
        WHERE page_id = $1 AND kind = $2 AND resolved_at IS NULL`,
      [task.pageId, task.kind, now],
    );
    await query(
      pool,
      'meta.scan_task:finish_discussion_success',
      `DELETE FROM meta.scan_task WHERE id = $1 AND locked_by = $2`,
      [task.taskId, args.workerId],
    );
    return { action: 'deleted', stableCount: 0, notBefore: null };
  }

  const sameHash =
    args.resultHash !== undefined &&
    args.resultHash !== null &&
    task.lastResultHash !== null &&
    task.lastResultHash.equals(args.resultHash);
  const stableCount = args.resultHash ? (sameHash ? task.stableCount + 1 : 1) : 0;
  const converged = args.terminalFailure === true || stableCount >= 3;
  const notBefore = backoffFrom(
    converged ? stableCount - 2 : task.attempts,
    Date.parse(now),
  );
  if (converged) {
    await query(
      pool,
      'meta.irreconcilable:discussion_converge',
      `WITH terminal AS (
         INSERT INTO meta.irreconcilable AS i
           (page_id, kind, local_value, remote_value, result_hash,
            first_seen, last_checked, checks, next_review_at,
            resolved_at, locked_by, locked_at)
         VALUES ($1, $2, $3::jsonb, $4::jsonb, $5,
                 $6::timestamptz, $6::timestamptz, 1,
                 $6::timestamptz + interval '7 days',
                 NULL, NULL, NULL)
         ON CONFLICT (page_id, kind, instance_id) DO UPDATE
           SET local_value = EXCLUDED.local_value,
               remote_value = EXCLUDED.remote_value,
               result_hash = EXCLUDED.result_hash,
               first_seen = CASE
                 WHEN i.resolved_at IS NOT NULL THEN EXCLUDED.first_seen
                 ELSE i.first_seen
               END,
               last_checked = EXCLUDED.last_checked,
               checks = CASE
                 WHEN i.resolved_at IS NOT NULL THEN 1
                 ELSE i.checks + 1
               END,
               next_review_at = EXCLUDED.next_review_at,
               resolved_at = NULL,
               locked_by = NULL,
               locked_at = NULL
         RETURNING 1
       )
       DELETE FROM meta.scan_task st
        WHERE st.id = $7
          AND st.locked_by = $8
          AND EXISTS (SELECT 1 FROM terminal)`,
      [
        task.pageId,
        task.kind,
        toPgJson(args.localValue ?? {}, 'queues.irreconcilable.local_value'),
        toPgJson(args.remoteValue ?? {}, 'queues.irreconcilable.remote_value'),
        args.resultHash,
        now,
        task.taskId,
        args.workerId,
      ],
    );
    return { action: 'irreconcilable', stableCount, notBefore: null };
  }
  await query(
    pool,
    'meta.scan_task:finish_discussion_retry',
    `UPDATE meta.scan_task
        SET stable_count = $3,
            last_result_hash = COALESCE($4, last_result_hash),
            not_before = $5::timestamptz,
            locked_by = NULL,
            locked_at = NULL
      WHERE id = $1 AND locked_by = $2`,
    [task.taskId, args.workerId, stableCount, args.resultHash ?? null, notBefore],
  );
  return {
    action: 'retried',
    stableCount,
    notBefore,
  };
}

export async function releaseDiscussionTaskLocks(
  pool: Pool,
  taskIds: readonly number[],
  workerId: string,
  deferAfterCrash = false,
  rotateAfterBudget = false,
): Promise<number> {
  if (taskIds.length === 0) return 0;
  const result = await query(
    pool,
    'meta.scan_task:release_discussion_locks',
    `UPDATE meta.scan_task
        SET locked_by = NULL,
            locked_at = NULL,
            attempts = CASE WHEN $3::boolean THEN attempts ELSE GREATEST(0, attempts - 1) END,
            priority = CASE
              WHEN $4::boolean AND priority > -2147483648 THEN priority - 1
              ELSE priority
            END,
            reasons = CASE WHEN $4::boolean
              THEN ARRAY(
                SELECT DISTINCT reason
                  FROM unnest(reasons || ARRAY['forum_runtime_budget_rotated']) AS reason
              )
              ELSE reasons
            END,
            not_before = CASE WHEN $3::boolean
              THEN COALESCE(not_before, now() + interval '1 hour')
              WHEN $4::boolean THEN now() + interval '1 hour'
              ELSE not_before
            END
      WHERE id = ANY($1::bigint[]) AND locked_by = $2`,
    [taskIds, workerId, deferAfterCrash, rotateAfterBudget],
  );
  return result.rowCount ?? 0;
}
