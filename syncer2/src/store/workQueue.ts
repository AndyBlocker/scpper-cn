/**
 * meta.scan_task 的统一消费门面。
 *
 * 发现侧与执行侧边界：
 *   - 这里认领/完成任务，会改 attempts/not_before/stable_count/locked_*；
 *   - enqueueScanTasks 与周期 seed 等发现侧入口绝不覆盖这些列。
 *
 * 调度预算：
 *   - 普通投票 sweep 仅覆盖 90 天内有活动且距完整快照 ≥7 天的页；
 *   - 发布未满 7 天的页保留 new_page_highfreq，3 小时一次；
 *   - M6 全站约定页在成功证据过期 24 小时后补一个审计锚任务。
 */

import type { Pool } from 'pg';

import { claimedRevisionCountFromListCount } from '../collect/revisionCount.js';
import { query, toPgTimestamptz } from './db.js';
import { toPgJson } from './pgText.js';
import { backoffFrom } from './queues.js';
import type { ScanTaskKind } from './meta.js';

export const VOTE_SWEEP_ACTIVITY_DAYS = 90;
export const VOTE_SWEEP_INTERVAL_DAYS = 7;
export const NEW_PAGE_WINDOW_DAYS = 7;
export const NEW_PAGE_INTERVAL_HOURS = 3;
export const WORK_QUEUE_LIMIT_MAX = 50;
export const CONSECUTIVE_PAGE_FAILURE_LIMIT = 5;

/**
 * 排序里被硬性置顶的 kind。置顶本身没错——确认删除与新页高频复查都需要及时性——
 * 错在置顶没有上限：`new_page_highfreq` 是自我补充的（新页 7 天内反复重排），
 * 于是它每轮吃满全部配额，`votes_full` 长期拿到 0 个（实测 524 个任务里 495 个
 * 从未被尝试，最久排队 6.8 天）。
 */
export const PINNED_KINDS: readonly ScanTaskKind[] = ['confirm_deleted', 'new_page_highfreq'];

/** 置顶 kind 每轮最多占用的配额比例；余下名额回到 priority 正常竞争。 */
export const PINNED_KIND_SHARE = 0.4;

/** 至少留 1 个名额给置顶 kind，否则小 limit 下会造成反向饥饿。 */
export function pinnedKindQuota(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new RangeError(`认领上限必须是非负安全整数，收到 ${String(limit)}`);
  }
  if (limit === 0) return 0;
  return Math.max(1, Math.floor(limit * PINNED_KIND_SHARE));
}

export type VoteTaskKind = 'votes_full' | 'new_page_highfreq';

export const ALL_WORK_TASK_KINDS = [
  'confirm_deleted',
  'new_page_highfreq',
  'votes_full',
  'meta',
  'sitemap_delta',
  'content',
  'revisions_full',
  'files',
  'forum',
  'discussion',
  'attributions',
] as const satisfies readonly ScanTaskKind[];

/**
 * 投票深扫必须先有成功 ListPages 的远端声明。L1 的跨轮状态不是本地聚合：
 * last_l1_rating(_votes) 直接来自完整 L1 响应，且 last_l1_run_id 只在成功轮最后推进。
 */
function voteClaimEvidenceExists(pageIdSql: string): string {
  return `(
    EXISTS (
      SELECT 1
        FROM meta.page_scan ps
        JOIN meta.ingest_run ir ON ir.id = ps.run_id
       WHERE ps.page_id = ${pageIdSql}
         AND ps.kind = 'meta'
         AND ps.status = 'ok'
         AND ps.claimed_total IS NOT NULL
         AND ps.checksum_expected IS NOT NULL
         AND ir.status = 'ok'
         AND (
           ir.source LIKE '%listpages%'
           OR (ir.source = 'wikidot' AND ir.stats ->> 'mode' IN ('tier1', 'tier1_range'))
         )
    )
    OR EXISTS (
      SELECT 1
        FROM meta.incremental_page_state ips
        JOIN meta.ingest_run ir ON ir.id = ips.last_l1_run_id
       WHERE ips.page_id = ${pageIdSql}
         AND ips.last_l1_rating IS NOT NULL
         AND ips.last_l1_rating_votes IS NOT NULL
         AND ir.status = 'ok'
         AND ir.source = 'wikidot_listpages'
         AND ir.stats ->> 'mode' = 'l1_votes'
         AND ir.stats ->> 'population_type' = 'l1_full_site_minimal'
    )
  )`;
}

function voteClaimEvidence(pageIdSql: string): string {
  return `SELECT evidence.claimed_total,
                 evidence.claimed_rating,
                 evidence.run_id
            FROM (
              SELECT ps.claimed_total,
                     ps.checksum_expected AS claimed_rating,
                     ps.run_id,
                     ps.scanned_at AS observed_at
                FROM meta.page_scan ps
                JOIN meta.ingest_run ir ON ir.id = ps.run_id
               WHERE ps.page_id = ${pageIdSql}
                 AND ps.kind = 'meta'
                 AND ps.status = 'ok'
                 AND ps.claimed_total IS NOT NULL
                 AND ps.checksum_expected IS NOT NULL
                 AND ir.status = 'ok'
                 AND (
                   ir.source LIKE '%listpages%'
                   OR (
                     ir.source = 'wikidot'
                     AND ir.stats ->> 'mode' IN ('tier1', 'tier1_range')
                   )
                 )
              UNION ALL
              SELECT ips.last_l1_rating_votes AS claimed_total,
                     ips.last_l1_rating AS claimed_rating,
                     ips.last_l1_run_id AS run_id,
                     ips.last_l1_seen_at AS observed_at
                FROM meta.incremental_page_state ips
                JOIN meta.ingest_run ir ON ir.id = ips.last_l1_run_id
               WHERE ips.page_id = ${pageIdSql}
                 AND ips.last_l1_rating IS NOT NULL
                 AND ips.last_l1_rating_votes IS NOT NULL
                 AND ir.status = 'ok'
                 AND ir.source = 'wikidot_listpages'
                 AND ir.stats ->> 'mode' = 'l1_votes'
                 AND ir.stats ->> 'population_type' = 'l1_full_site_minimal'
            ) evidence
           ORDER BY evidence.observed_at DESC, evidence.run_id DESC
           LIMIT 1`;
}

export interface ClaimedWorkTask {
  /** 缺省视为常规 scan_task，兼容已有调用方与测试夹具。 */
  queueSource?: 'scan_task' | 'irreconcilable';
  taskId: number;
  pageId: number;
  wikidotId: number;
  slug: string;
  kind: ScanTaskKind;
  attempts: number;
  stableCount: number;
  lastResultHash: Buffer | null;
  reasons: string[];
  firstPublishedAt: string | null;
  taskCreatedAt: string;
  claimedTotal: number | null;
  claimedRating: number | null;
  tier1RunId: number | null;
  /** Wikidot/ListPages 的零基 %%revisions%% 声明值，不是本地真实修订行数。 */
  revisionClaimedTotal: number;
  commentCount: number;
  expectedThreadId: number | null;
  irreconcilableChecks?: number;
}

export interface ClaimedVoteTask {
  taskId: number;
  pageId: number;
  wikidotId: number;
  slug: string;
  kind: VoteTaskKind;
  attempts: number;
  stableCount: number;
  lastResultHash: Buffer | null;
  reasons: string[];
  firstPublishedAt: string | null;
  taskCreatedAt: string;
  claimedTotal: number | null;
  claimedRating: number | null;
  tier1RunId: number | null;
}

export interface SeedVoteTasksResult {
  highFrequencyRetired: number;
  highFrequencyAffected: number;
  sweepAffected: number;
}

export interface SeedConventionTasksResult {
  conventionAffected: number;
}

/**
 * slug 复用完成身份切换后，把旧身份上的待办合并到 successor。
 *
 * 当前正在执行的 meta 身份确认任务由 finishWorkTask 正常收尾；confirm_deleted
 * 属于 predecessor 生命周期，不能挪给新页。其余任务必须重置执行态，因为它们此前
 * 的 attempts/hash/backoff 都是旧页面的证据。
 */
export async function reassignSlugReuseTasks(
  pool: Pool,
  predecessorId: number,
  successorId: number,
  currentTaskId: number,
): Promise<number> {
  const result = await query<{ moved: string }>(
    pool,
    'meta.scan_task:reassign_slug_reuse',
    `WITH candidates AS MATERIALIZED (
       SELECT st.id, st.kind, st.reasons, st.priority
         FROM meta.scan_task st
        WHERE st.page_id = $1
          AND st.id <> $3
          AND st.kind <> 'confirm_deleted'
     ),
     reassigned AS (
       INSERT INTO meta.scan_task AS target
         (page_id, kind, reasons, priority, not_before)
       SELECT $2,
              c.kind,
              ARRAY(
                SELECT DISTINCT reason
                  FROM unnest(c.reasons || ARRAY['slug_reuse_identity_registered']) AS reason
              ),
              GREATEST(c.priority, 100),
              NULL
         FROM candidates c
       ON CONFLICT (page_id, kind) DO UPDATE
          SET reasons = ARRAY(
                SELECT DISTINCT reason
                  FROM unnest(target.reasons || EXCLUDED.reasons) AS reason
              ),
              priority = GREATEST(target.priority, EXCLUDED.priority),
              not_before = NULL
       RETURNING 1
     ),
     removed AS (
       DELETE FROM meta.scan_task st
        USING candidates c
        WHERE st.id = c.id
          AND (SELECT count(*) FROM reassigned) =
              (SELECT count(*) FROM candidates)
       RETURNING st.id
     )
     SELECT count(*)::text AS moved FROM removed`,
    [predecessorId, successorId, currentTaskId],
  );
  return Number(result.rows[0]?.moved ?? 0);
}

/**
 * 统一认领 meta.scan_task。kind 过滤发生在加锁之前，因此消费者绝不会“认领后跳过”。
 * Tier1 claimed 值只取成功的 ListPages run；有界 range run 也是独立、可审计的远端证据，
 * 但不会被删除推断当作全站完整 run。
 */
export interface KindStarvation {
  kind: ScanTaskKind;
  queued: number;
  neverAttempted: number;
  oldestWaitHours: number;
}

/**
 * 每个 kind 的最久等待。
 *
 * 这次饥饿事故的教训：队列深度、每轮吞吐、失败率**全部正常**——50 个配额轮轮打满、
 * 处理全部成功——只有「最久等待」能看见 `votes_full` 已经 6.8 天没被碰过。
 * 常规健康指标衡量的是「做了多少」，饥饿要问的是「谁一直没被做」，两者正交。
 */
export async function detectKindStarvation(
  pool: Pool,
  thresholdHours: number,
): Promise<KindStarvation[]> {
  if (!Number.isFinite(thresholdHours) || thresholdHours <= 0) {
    throw new RangeError(`饥饿阈值必须为正数小时，收到 ${String(thresholdHours)}`);
  }
  const res = await query<{
    kind: ScanTaskKind;
    queued: string;
    never_attempted: string;
    oldest_wait_hours: string;
  }>(
    pool,
    'meta.scan_task:detect_starvation',
    `SELECT st.kind,
            count(*)::text AS queued,
            count(*) FILTER (WHERE st.attempts = 0)::text AS never_attempted,
            (extract(epoch FROM now() - min(st.created_at)) / 3600)::text AS oldest_wait_hours
       FROM meta.scan_task st
      GROUP BY st.kind
     HAVING extract(epoch FROM now() - min(st.created_at)) / 3600 > $1::numeric
      ORDER BY min(st.created_at)`,
    [thresholdHours],
  );
  return res.rows.map((r) => ({
    kind: r.kind,
    queued: Number(r.queued),
    neverAttempted: Number(r.never_attempted),
    oldestWaitHours: Math.round(Number(r.oldest_wait_hours) * 10) / 10,
  }));
}

export async function claimWorkTasks(
  pool: Pool,
  requestedLimit: number,
  workerId: string,
  kinds: readonly ScanTaskKind[] = ALL_WORK_TASK_KINDS,
  lockStaleAfterMs = 30 * 60_000,
): Promise<ClaimedWorkTask[]> {
  const limit = Math.min(WORK_QUEUE_LIMIT_MAX, Math.max(0, Math.floor(requestedLimit)));
  if (limit === 0 || kinds.length === 0) return [];
  const pinnedQuota = pinnedKindQuota(limit);

  const result = await query<{
    id: string;
    page_id: number;
    wikidot_id: number;
    slug: string;
    kind: ScanTaskKind;
    attempts: number;
    stable_count: number;
    last_result_hash: Buffer | null;
    reasons: string[];
    first_published_at: Date | string | null;
    created_at: Date | string;
    claimed_total: number | null;
    claimed_rating: number | null;
    tier1_run_id: string | null;
    revision_claimed_total: number | null;
    actual_revision_count: number;
    comment_count: number;
    discussion_thread_id: string | null;
  }>(
    pool,
    'meta.scan_task:claim_all_work',
    `WITH eligible AS (
       SELECT st.id, st.kind, st.priority, st.not_before,
              row_number() OVER (
                PARTITION BY st.kind
                ORDER BY st.priority DESC, st.not_before NULLS FIRST, st.id
              ) AS rn_in_kind
         FROM meta.scan_task st
         JOIN serve.page_current pc ON pc.page_id = st.page_id
         JOIN ingest.page p ON p.id = st.page_id
        WHERE st.kind = ANY($4::text[])
          AND (
            pc.status = 'live'
            OR (
              st.kind = 'meta'
              AND 'revision_regression_identity_check' = ANY(st.reasons)
            )
          )
          AND NOT EXISTS (
            SELECT 1
              FROM meta.irreconcilable i
             WHERE i.page_id = st.page_id
               AND i.kind = st.kind
               AND i.resolved_at IS NULL
          )
          AND (
            st.kind NOT IN ('votes_full', 'new_page_highfreq')
            OR ${voteClaimEvidenceExists('st.page_id')}
          )
          AND (
            st.kind <> 'new_page_highfreq'
            OR COALESCE(pc.first_published_at, p.created_at, st.created_at)
                 > now() - interval '7 days'
          )
          AND (st.not_before IS NULL OR st.not_before <= now())
          AND (
            st.locked_by IS NULL
            OR st.locked_at < now() - ($3::bigint || ' milliseconds')::interval
          )
     ),
     /*
      * 置顶 kind 的每轮配额。
      *
      * 事故：new_page_highfreq 被无条件排在所有 kind 之前，而它是**自我补充**的
      * （新页 7 天内高频复查，处理完删除、随即重新入队）。于是每轮 50 个配额被它
      * 与 content 吃光，votes_full 拿到 0 个 —— 524 个投票任务里 495 个从未被尝试，
      * 最久排队 6.8 天，表现为「v2 评分莫名落后 wikidot 两天」。
      * 队列深度、吞吐、失败率全部正常，只有「最久等待」能看见它。
      *
      * 置顶 + 自我补充 = 低优先 kind 无限饥饿，且不会自愈、只随时间加剧。
      * 因此置顶只保留「同等条件下优先」，必须配额封顶；余下名额回到 priority 竞争。
      */
     capped AS (
       SELECT id,
              row_number() OVER (
                ORDER BY (kind = 'confirm_deleted') DESC,
                         (kind = 'new_page_highfreq') DESC,
                         priority DESC,
                         not_before NULLS FIRST,
                         id
              ) AS ord
         FROM eligible
        WHERE rn_in_kind <= CASE
                WHEN kind = ANY($5::text[]) THEN $6::int
                ELSE 2147483647
              END
     ),
     picked AS (
       SELECT st.id
         FROM capped c
         JOIN meta.scan_task st ON st.id = c.id
        ORDER BY c.ord
        LIMIT $2
        FOR UPDATE OF st SKIP LOCKED
     ),
     claimed AS (
       UPDATE meta.scan_task st
          SET locked_by = $1,
              locked_at = now(),
              attempts = st.attempts + 1
         FROM picked
        WHERE st.id = picked.id
        RETURNING st.*
     )
     SELECT st.id::text,
            st.page_id,
            pc.wikidot_id,
            pc.slug,
            st.kind,
            st.attempts,
            st.stable_count,
            st.last_result_hash,
            st.reasons,
            pc.first_published_at,
            st.created_at,
            tier1.claimed_total,
            tier1.claimed_rating,
            tier1.run_id::text AS tier1_run_id,
            tier1_revision.claimed_total AS revision_claimed_total,
            pc.revision_count AS actual_revision_count,
            pc.comment_count,
            pc.discussion_thread_id::text
       FROM claimed st
       JOIN serve.page_current pc ON pc.page_id = st.page_id
       LEFT JOIN LATERAL (
         ${voteClaimEvidence('st.page_id')}
       ) tier1 ON true
       LEFT JOIN LATERAL (
         SELECT ps.claimed_total
           FROM meta.page_scan ps
           JOIN meta.ingest_run ir ON ir.id = ps.run_id
          WHERE ps.page_id = st.page_id
            AND ps.kind = 'revisions'
            AND ps.claimed_total IS NOT NULL
            AND ir.status = 'ok'
            AND (
              (
                ir.source = 'wikidot'
                AND ir.stats ->> 'mode' IN ('tier1', 'tier1_range')
              )
              OR (
                ir.source = 'wikidot_listpages'
                AND ir.stats ->> 'mode' IN ('l0_content', 'l1_votes')
              )
            )
          ORDER BY ps.scanned_at DESC, ps.run_id DESC
          LIMIT 1
       ) tier1_revision ON true
      ORDER BY (st.kind = 'confirm_deleted') DESC,
               (st.kind = 'new_page_highfreq') DESC,
               st.priority DESC,
               st.id`,
    [workerId, limit, String(lockStaleAfterMs), kinds, PINNED_KINDS, pinnedQuota],
  );

  return result.rows.map((row) => ({
    queueSource: 'scan_task',
    taskId: Number(row.id),
    pageId: Number(row.page_id),
    wikidotId: Number(row.wikidot_id),
    slug: row.slug,
    kind: row.kind,
    attempts: Number(row.attempts),
    stableCount: Number(row.stable_count),
    lastResultHash: row.last_result_hash,
    reasons: row.reasons ?? [],
    firstPublishedAt: isoOrNull(row.first_published_at),
    taskCreatedAt: iso(row.created_at),
    claimedTotal: row.claimed_total === null ? null : Number(row.claimed_total),
    claimedRating: row.claimed_rating === null ? null : Number(row.claimed_rating),
    tier1RunId: row.tier1_run_id === null ? null : Number(row.tier1_run_id),
    revisionClaimedTotal:
      row.revision_claimed_total === null
        ? claimedRevisionCountFromListCount(Number(row.actual_revision_count))
        : Number(row.revision_claimed_total),
    commentCount: Number(row.comment_count),
    expectedThreadId:
      row.discussion_thread_id === null ? null : Number(row.discussion_thread_id),
  }));
}

/**
 * 到期终态走独立复查队列；不会重建 scan_task。只有复查结果发生变化时，
 * finishIrreconcilableReview 才把它重新放回常规队列。
 */
export async function claimIrreconcilableReviews(
  pool: Pool,
  requestedLimit: number,
  workerId: string,
  kinds: readonly ScanTaskKind[] = ALL_WORK_TASK_KINDS,
  lockStaleAfterMs = 30 * 60_000,
): Promise<ClaimedWorkTask[]> {
  const limit = Math.min(WORK_QUEUE_LIMIT_MAX, Math.max(0, Math.floor(requestedLimit)));
  if (limit === 0 || kinds.length === 0) return [];

  const result = await query<{
    page_id: number;
    wikidot_id: number;
    slug: string;
    kind: ScanTaskKind;
    checks: number;
    result_hash: Buffer;
    first_seen: Date | string;
    first_published_at: Date | string | null;
    claimed_total: number | null;
    claimed_rating: number | null;
    tier1_run_id: string | null;
    revision_claimed_total: number | null;
    actual_revision_count: number;
    comment_count: number;
    discussion_thread_id: string | null;
  }>(
    pool,
    'meta.irreconcilable:claim_reviews',
    `WITH picked AS (
       SELECT i.page_id, i.kind
         FROM meta.irreconcilable i
         JOIN serve.page_current pc ON pc.page_id = i.page_id
        WHERE i.resolved_at IS NULL
          AND i.result_hash IS NOT NULL
          AND i.next_review_at <= now()
          AND i.kind = ANY($4::text[])
          AND pc.status = 'live'
          AND (
            i.kind NOT IN ('votes_full', 'new_page_highfreq')
            OR ${voteClaimEvidenceExists('i.page_id')}
          )
          AND (
            i.locked_by IS NULL
            OR i.locked_at < now() - ($3::bigint || ' milliseconds')::interval
          )
        ORDER BY i.next_review_at, i.last_checked, i.page_id, i.kind
        LIMIT $2
        FOR UPDATE OF i SKIP LOCKED
     ),
     claimed AS (
       UPDATE meta.irreconcilable i
          SET locked_by = $1,
              locked_at = now()
         FROM picked
        WHERE i.page_id = picked.page_id
          AND i.kind = picked.kind
        RETURNING i.*
     )
     SELECT i.page_id,
            pc.wikidot_id,
            pc.slug,
            i.kind,
            i.checks,
            i.result_hash,
            i.first_seen,
            pc.first_published_at,
            tier1.claimed_total,
            tier1.claimed_rating,
            tier1.run_id::text AS tier1_run_id,
            tier1_revision.claimed_total AS revision_claimed_total,
            pc.revision_count AS actual_revision_count,
            pc.comment_count,
            pc.discussion_thread_id::text
       FROM claimed i
       JOIN serve.page_current pc ON pc.page_id = i.page_id
       LEFT JOIN LATERAL (
         ${voteClaimEvidence('i.page_id')}
       ) tier1 ON true
       LEFT JOIN LATERAL (
         SELECT ps.claimed_total
           FROM meta.page_scan ps
           JOIN meta.ingest_run ir ON ir.id = ps.run_id
          WHERE ps.page_id = i.page_id
            AND ps.kind = 'revisions'
            AND ps.claimed_total IS NOT NULL
            AND ir.status = 'ok'
            AND (
              (
                ir.source = 'wikidot'
                AND ir.stats ->> 'mode' IN ('tier1', 'tier1_range')
              )
              OR (
                ir.source = 'wikidot_listpages'
                AND ir.stats ->> 'mode' IN ('l0_content', 'l1_votes')
              )
            )
          ORDER BY ps.scanned_at DESC, ps.run_id DESC
          LIMIT 1
       ) tier1_revision ON true
      ORDER BY i.next_review_at, i.page_id, i.kind`,
    [workerId, limit, String(lockStaleAfterMs), kinds],
  );

  return result.rows.map((row) => ({
    queueSource: 'irreconcilable',
    taskId: Number(row.page_id),
    pageId: Number(row.page_id),
    wikidotId: Number(row.wikidot_id),
    slug: row.slug,
    kind: row.kind,
    attempts: Number(row.checks),
    stableCount: 3,
    lastResultHash: row.result_hash,
    reasons: ['irreconcilable_weekly_review'],
    firstPublishedAt: isoOrNull(row.first_published_at),
    taskCreatedAt: iso(row.first_seen),
    claimedTotal: row.claimed_total === null ? null : Number(row.claimed_total),
    claimedRating: row.claimed_rating === null ? null : Number(row.claimed_rating),
    tier1RunId: row.tier1_run_id === null ? null : Number(row.tier1_run_id),
    revisionClaimedTotal:
      row.revision_claimed_total === null
        ? claimedRevisionCountFromListCount(Number(row.actual_revision_count))
        : Number(row.revision_claimed_total),
    commentCount: Number(row.comment_count),
    expectedThreadId:
      row.discussion_thread_id === null ? null : Number(row.discussion_thread_id),
    irreconcilableChecks: Number(row.checks),
  }));
}

export interface FinishWorkTaskArgs {
  workerId: string;
  status: 'ok' | 'partial' | 'failed';
  settledPartial?: boolean;
  resultHash?: Buffer | null;
  localValue?: Record<string, unknown>;
  remoteValue?: Record<string, unknown>;
  now: string;
}

/** 所有普通 handler 共用的完成状态机：成功删，失败/partial 保留并退避。 */
export async function finishWorkTask(
  pool: Pool,
  task: ClaimedWorkTask,
  args: FinishWorkTaskArgs,
): Promise<FinishVoteTaskResult> {
  if (task.queueSource === 'irreconcilable') {
    return finishIrreconcilableReview(pool, task, args);
  }

  const voteCompatible: ClaimedVoteTask = {
    taskId: task.taskId,
    pageId: task.pageId,
    wikidotId: task.wikidotId,
    slug: task.slug,
    kind:
      task.kind === 'new_page_highfreq'
        ? 'new_page_highfreq'
        : 'votes_full',
    attempts: task.attempts,
    stableCount: task.stableCount,
    lastResultHash: task.lastResultHash,
    reasons: task.reasons,
    firstPublishedAt: task.firstPublishedAt,
    taskCreatedAt: task.taskCreatedAt,
    claimedTotal: task.claimedTotal,
    claimedRating: task.claimedRating,
    tier1RunId: task.tier1RunId,
  };
  if (task.kind === 'votes_full' || task.kind === 'new_page_highfreq') {
    return finishVoteTask(pool, voteCompatible, args);
  }

  const now = toPgTimestamptz(args.now);
  if (args.status === 'ok' || args.settledPartial === true) {
    await query(
      pool,
      'meta.irreconcilable:work_resolve',
      `UPDATE meta.irreconcilable
          SET resolved_at = $3::timestamptz,
              last_checked = $3::timestamptz
        WHERE page_id = $1 AND kind = $2 AND resolved_at IS NULL`,
      [task.pageId, task.kind, now],
    );
    await query(
      pool,
      'meta.scan_task:finish_work_success',
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
  const converged = stableCount >= 3;
  const notBefore = backoffFrom(
    converged ? stableCount - 2 : task.attempts,
    Date.parse(now),
  );
  if (converged) {
    await query(
      pool,
      'meta.irreconcilable:work_converge',
      `WITH terminal AS (
         INSERT INTO meta.irreconcilable AS i
           (page_id, kind, local_value, remote_value, result_hash,
            first_seen, last_checked, checks, next_review_at,
            resolved_at, locked_by, locked_at)
         VALUES ($1, $2, $3::jsonb, $4::jsonb, $5,
                 $6::timestamptz, $6::timestamptz, 1,
                 $6::timestamptz + interval '7 days',
                 NULL, NULL, NULL)
         ON CONFLICT (page_id, kind) DO UPDATE
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
        toPgJson(args.localValue ?? {}, 'work_queue.irreconcilable.local_value'),
        toPgJson(args.remoteValue ?? {}, 'work_queue.irreconcilable.remote_value'),
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
    'meta.scan_task:finish_work_retry',
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

async function finishIrreconcilableReview(
  pool: Pool,
  task: ClaimedWorkTask,
  args: FinishWorkTaskArgs,
): Promise<FinishVoteTaskResult> {
  const now = toPgTimestamptz(args.now);
  if (args.status === 'ok' || args.settledPartial === true) {
    await query(
      pool,
      'meta.irreconcilable:review_resolved',
      `UPDATE meta.irreconcilable
          SET local_value = $4::jsonb,
              remote_value = $5::jsonb,
              resolved_at = $3::timestamptz,
              last_checked = $3::timestamptz,
              next_review_at = NULL,
              checks = checks + 1,
              locked_by = NULL,
              locked_at = NULL
        WHERE page_id = $1
          AND kind = $2
          AND locked_by = $6
          AND resolved_at IS NULL`,
      [
        task.pageId,
        task.kind,
        now,
        toPgJson(args.localValue ?? {}, 'work_queue.review.local_value'),
        toPgJson(args.remoteValue ?? {}, 'work_queue.review.remote_value'),
        args.workerId,
      ],
    );
    return { action: 'deleted', stableCount: 0, notBefore: null };
  }

  if (args.resultHash === undefined || args.resultHash === null) {
    const retryAt = backoffFrom(1, Date.parse(now));
    await query(
      pool,
      'meta.irreconcilable:review_transient_retry',
      `UPDATE meta.irreconcilable
          SET last_checked = $3::timestamptz,
              next_review_at = $4::timestamptz,
              checks = checks + 1,
              locked_by = NULL,
              locked_at = NULL
        WHERE page_id = $1
          AND kind = $2
          AND locked_by = $5
          AND resolved_at IS NULL`,
      [task.pageId, task.kind, now, retryAt, args.workerId],
    );
    return { action: 'review_retried', stableCount: 0, notBefore: retryAt };
  }

  const sameHash =
    task.lastResultHash !== null && task.lastResultHash.equals(args.resultHash);
  if (sameHash) {
    const nextReviewAt = new Date(Date.parse(now) + 7 * 24 * 60 * 60_000).toISOString();
    await query(
      pool,
      'meta.irreconcilable:review_unchanged',
      `UPDATE meta.irreconcilable
          SET local_value = $4::jsonb,
              remote_value = $5::jsonb,
              last_checked = $3::timestamptz,
              next_review_at = $6::timestamptz,
              checks = checks + 1,
              locked_by = NULL,
              locked_at = NULL
        WHERE page_id = $1
          AND kind = $2
          AND locked_by = $7
          AND resolved_at IS NULL`,
      [
        task.pageId,
        task.kind,
        now,
        toPgJson(args.localValue ?? {}, 'work_queue.review.local_value'),
        toPgJson(args.remoteValue ?? {}, 'work_queue.review.remote_value'),
        nextReviewAt,
        args.workerId,
      ],
    );
    return { action: 'irreconcilable', stableCount: 3, notBefore: nextReviewAt };
  }

  await query(
    pool,
    'meta.irreconcilable:review_changed_reopen',
    `WITH resolved AS (
       UPDATE meta.irreconcilable
          SET local_value = $4::jsonb,
              remote_value = $5::jsonb,
              resolved_at = $3::timestamptz,
              last_checked = $3::timestamptz,
              next_review_at = NULL,
              checks = checks + 1,
              locked_by = NULL,
              locked_at = NULL
        WHERE page_id = $1
          AND kind = $2
          AND locked_by = $7
          AND resolved_at IS NULL
       RETURNING page_id, kind
     )
     INSERT INTO meta.scan_task AS st
       (page_id, kind, reasons, priority, not_before, attempts,
        stable_count, last_result_hash)
     SELECT page_id, kind, ARRAY['irreconcilable_review_changed'], 50,
            $3::timestamptz, 1, 1, $6
       FROM resolved
     ON CONFLICT (page_id, kind) DO UPDATE
       SET reasons = ARRAY(
             SELECT DISTINCT reason
               FROM unnest(st.reasons || EXCLUDED.reasons) AS reason
           ),
           priority = GREATEST(st.priority, EXCLUDED.priority),
           not_before = LEAST(
             COALESCE(st.not_before, EXCLUDED.not_before),
             COALESCE(EXCLUDED.not_before, st.not_before)
           )`,
    [
      task.pageId,
      task.kind,
      now,
      toPgJson(args.localValue ?? {}, 'work_queue.review.local_value'),
      toPgJson(args.remoteValue ?? {}, 'work_queue.review.remote_value'),
      args.resultHash,
      args.workerId,
    ],
  );
  return { action: 'review_reopened', stableCount: 1, notBefore: now };
}

export async function releaseWorkTaskLocks(
  pool: Pool,
  taskIds: readonly number[],
  workerId: string,
): Promise<number> {
  if (taskIds.length === 0) return 0;
  const result = await query(
    pool,
    'meta.scan_task:release_work_locks',
    `UPDATE meta.scan_task
        SET locked_by = NULL,
            locked_at = NULL,
            -- 本轮根本没执行到的任务不应被当成失败退避，也不应白烧一次 attempts。
            -- 只有 finishWorkTask 看见真实 partial/failed 后才有权推进退避。
            attempts = GREATEST(0, attempts - 1)
      WHERE id = ANY($1::bigint[]) AND locked_by = $2`,
    [taskIds, workerId],
  );
  return result.rowCount ?? 0;
}

export async function releaseIrreconcilableReviewLocks(
  pool: Pool,
  tasks: readonly ClaimedWorkTask[],
  workerId: string,
): Promise<number> {
  const reviews = tasks
    .filter((task) => task.queueSource === 'irreconcilable')
    .map((task) => ({ page_id: task.pageId, kind: task.kind }));
  if (reviews.length === 0) return 0;
  const result = await query(
    pool,
    'meta.irreconcilable:release_review_locks',
    `WITH input AS (
       SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(page_id int, kind text)
     )
     UPDATE meta.irreconcilable i
        SET locked_by = NULL,
            locked_at = NULL
       FROM input
      WHERE i.page_id = input.page_id
        AND i.kind = input.kind
        AND i.locked_by = $2
        AND i.resolved_at IS NULL`,
    [toPgJson(reviews, 'work_queue.release_reviews'), workerId],
  );
  return result.rowCount ?? 0;
}

/**
 * 补齐两类周期任务。ON CONFLICT 只合并 reasons/priority，刻意不碰执行侧退避。
 * `last_complete_vote_snapshot_at` 由 apply_vote_snapshot 在四门全过时推进；
 * 删除后函数不再更新它，因而值自然冻结。
 */
export async function seedVoteTasks(
  pool: Pool,
  now: string,
  opts: { highFrequencyLimit?: number; sweepLimit?: number } = {},
): Promise<SeedVoteTasksResult> {
  const ts = toPgTimestamptz(now);
  const highFrequencyLimit = positiveLimit(opts.highFrequencyLimit, WORK_QUEUE_LIMIT_MAX);
  const sweepLimit = positiveLimit(opts.sweepLimit, WORK_QUEUE_LIMIT_MAX);

  // 高频队列必须短命：跨过 7 天边界后立即退役，不能让一个持续失败的任务靠退避
  // 永久保留 new_page_highfreq 身份。2h 以前的锁视为死进程遗留；正常短进程远短于它。
  const retired = await query(
    pool,
    'meta.scan_task:retire_vote_highfreq',
    `DELETE FROM meta.scan_task st
      USING serve.page_current pc, ingest.page p
      WHERE st.page_id = pc.page_id
        AND p.id = pc.page_id
        AND st.kind = 'new_page_highfreq'
        AND COALESCE(pc.first_published_at, p.created_at, st.created_at)
              <= $1::timestamptz - interval '7 days'
        AND (
          st.locked_by IS NULL
          OR st.locked_at < $1::timestamptz - interval '2 hours'
        )`,
    [ts],
  );

  const highFrequency = await query(
    pool,
    'meta.scan_task:seed_vote_highfreq',
    `WITH candidates AS (
       SELECT pc.page_id
         FROM serve.page_current pc
         JOIN ingest.page p ON p.id = pc.page_id
        WHERE pc.status = 'live'
          AND NOT EXISTS (
            SELECT 1
              FROM meta.irreconcilable i
             WHERE i.page_id = pc.page_id
               AND i.kind = 'new_page_highfreq'
               AND i.resolved_at IS NULL
          )
          AND COALESCE(pc.first_published_at, p.created_at)
                > $1::timestamptz - interval '7 days'
          AND (
            pc.last_complete_vote_snapshot_at IS NULL
            OR pc.last_complete_vote_snapshot_at
                 <= $1::timestamptz - interval '3 hours'
          )
          AND ${voteClaimEvidenceExists('pc.page_id')}
        ORDER BY COALESCE(pc.first_published_at, p.created_at) DESC
        LIMIT $2
     )
     INSERT INTO meta.scan_task AS st
       (page_id, kind, reasons, priority, not_before)
     SELECT page_id, 'new_page_highfreq',
            ARRAY['new_page_under_7d'], 100, $1::timestamptz
       FROM candidates
     ON CONFLICT (page_id, kind) DO UPDATE
       SET reasons = ARRAY(
             SELECT DISTINCT reason
               FROM unnest(st.reasons || EXCLUDED.reasons) AS reason
           ),
           priority = GREATEST(st.priority, EXCLUDED.priority)`,
    [ts, highFrequencyLimit],
  );

  const sweep = await query(
    pool,
    'meta.scan_task:seed_vote_sweep',
    `WITH recent_activity AS (
       SELECT vc.page_id, max(vc.last_voted_at) AS last_vote_at
         FROM serve.vote_current vc
        WHERE vc.last_voted_at >= $1::timestamptz - interval '90 days'
        GROUP BY vc.page_id
     ),
     candidates AS (
       SELECT pc.page_id
         FROM recent_activity va
         JOIN serve.page_current pc ON pc.page_id = va.page_id
         JOIN ingest.page p ON p.id = pc.page_id
        WHERE pc.status = 'live'
          AND NOT EXISTS (
            SELECT 1
              FROM meta.irreconcilable i
             WHERE i.page_id = pc.page_id
               AND i.kind = 'votes_full'
               AND i.resolved_at IS NULL
          )
          AND COALESCE(pc.first_published_at, p.created_at)
                <= $1::timestamptz - interval '7 days'
          AND (
            pc.last_complete_vote_snapshot_at IS NULL
            OR pc.last_complete_vote_snapshot_at
                 <= $1::timestamptz - interval '7 days'
          )
          AND ${voteClaimEvidenceExists('pc.page_id')}
        ORDER BY va.last_vote_at DESC
        LIMIT $2
     )
     INSERT INTO meta.scan_task AS st
       (page_id, kind, reasons, priority, not_before)
     SELECT page_id, 'votes_full',
            ARRAY['votes_sweep_active_90d'], 10, $1::timestamptz
       FROM candidates
     ON CONFLICT (page_id, kind) DO UPDATE
       SET reasons = ARRAY(
             SELECT DISTINCT reason
               FROM unnest(st.reasons || EXCLUDED.reasons) AS reason
           ),
           priority = GREATEST(st.priority, EXCLUDED.priority)`,
    [ts, sweepLimit],
  );

  return {
    highFrequencyRetired: retired.rowCount ?? 0,
    highFrequencyAffected: highFrequency.rowCount ?? 0,
    sweepAffected: sweep.rowCount ?? 0,
  };
}

/**
 * M6 约定页是全站级采集，但 scan_task 的契约要求绑定 page_id。优先用约定页本身，
 * 冷启动尚未解析到它时退化到任一 live 页作为审计锚点。已有任务冲突时只合并发现侧
 * reasons/priority，绝不重置 attempts、stable_count、not_before 或锁。
 */
export async function seedConventionTasks(
  pool: Pool,
  now: string,
  intervalHours = 24,
): Promise<SeedConventionTasksResult> {
  const ts = toPgTimestamptz(now);
  const hours = Math.max(1, Math.min(168, Math.floor(intervalHours)));
  const seeded = await query(
    pool,
    'meta.scan_task:seed_conventions',
    `WITH anchor AS (
       SELECT pc.page_id
         FROM serve.page_current pc
        WHERE pc.status = 'live'
        ORDER BY
          CASE pc.slug
            WHEN 'attribution-metadata' THEN 0
            WHEN 'attribution-metadata-translation' THEN 1
            ELSE 2
          END,
          pc.page_id
        LIMIT 1
     ),
     due AS (
       SELECT page_id
         FROM anchor
        WHERE NOT EXISTS (
          SELECT 1
            FROM meta.page_scan ps
            JOIN meta.ingest_run ir ON ir.id = ps.run_id
           WHERE ps.kind = 'attributions'
             AND ps.status = 'ok'
             AND ir.status = 'ok'
             AND ps.scanned_at > $1::timestamptz
                   - ($2::integer || ' hours')::interval
        )
          AND NOT EXISTS (
            SELECT 1
              FROM meta.irreconcilable i
             WHERE i.page_id = anchor.page_id
               AND i.kind = 'attributions'
               AND i.resolved_at IS NULL
          )
     )
     INSERT INTO meta.scan_task AS st
       (page_id, kind, reasons, priority, not_before)
     SELECT page_id, 'attributions',
            ARRAY['conventions_periodic_24h'], 20, $1::timestamptz
       FROM due
     ON CONFLICT (page_id, kind) DO UPDATE
       SET reasons = ARRAY(
             SELECT DISTINCT reason
               FROM unnest(st.reasons || EXCLUDED.reasons) AS reason
           ),
           priority = GREATEST(st.priority, EXCLUDED.priority)`,
    [ts, hours],
  );

  return { conventionAffected: seeded.rowCount ?? 0 };
}

/**
 * 认领最多 50 个投票任务。Tier1 claimed 值来自最近一个“已成功结束”的
 * ListPages ingest_run 对应的 page_scan(kind=meta)，不从本地 rating 反推。
 */
export async function claimVoteTasks(
  pool: Pool,
  requestedLimit: number,
  workerId: string,
  lockStaleAfterMs = 30 * 60_000,
): Promise<ClaimedVoteTask[]> {
  const limit = Math.min(WORK_QUEUE_LIMIT_MAX, Math.max(0, Math.floor(requestedLimit)));
  if (limit === 0) return [];

  const res = await query<{
    id: string;
    page_id: number;
    wikidot_id: number;
    slug: string;
    kind: VoteTaskKind;
    attempts: number;
    stable_count: number;
    last_result_hash: Buffer | null;
    reasons: string[];
    first_published_at: Date | string | null;
    created_at: Date | string;
    claimed_total: number | null;
    claimed_rating: number | null;
    tier1_run_id: string | null;
  }>(
    pool,
    'meta.scan_task:claim_votes',
    `WITH picked AS (
       SELECT st.id
         FROM meta.scan_task st
         JOIN serve.page_current pc ON pc.page_id = st.page_id
         JOIN ingest.page p ON p.id = st.page_id
        WHERE st.kind IN ('votes_full', 'new_page_highfreq')
          AND pc.status = 'live'
          AND ${voteClaimEvidenceExists('st.page_id')}
          AND (
            st.kind <> 'new_page_highfreq'
            OR COALESCE(pc.first_published_at, p.created_at, st.created_at)
                 > now() - interval '7 days'
          )
          AND (st.not_before IS NULL OR st.not_before <= now())
          AND (
            st.locked_by IS NULL
            OR st.locked_at < now() - ($3::bigint || ' milliseconds')::interval
          )
        ORDER BY st.priority DESC,
                 (st.kind = 'new_page_highfreq') DESC,
                 st.not_before NULLS FIRST,
                 st.id
        LIMIT $2
        FOR UPDATE OF st SKIP LOCKED
     ),
     claimed AS (
       UPDATE meta.scan_task st
          SET locked_by = $1,
              locked_at = now(),
              attempts = st.attempts + 1
         FROM picked
        WHERE st.id = picked.id
        RETURNING st.*
     )
     SELECT st.id::text,
            st.page_id,
            pc.wikidot_id,
            pc.slug,
            st.kind,
            st.attempts,
            st.stable_count,
            st.last_result_hash,
            st.reasons,
            pc.first_published_at,
            st.created_at,
            tier1.claimed_total,
            tier1.claimed_rating,
            tier1.run_id::text AS tier1_run_id
       FROM claimed st
       JOIN serve.page_current pc ON pc.page_id = st.page_id
       LEFT JOIN LATERAL (
         ${voteClaimEvidence('st.page_id')}
       ) tier1 ON true
      ORDER BY st.priority DESC,
               (st.kind = 'new_page_highfreq') DESC,
               st.id`,
    [workerId, limit, String(lockStaleAfterMs)],
  );

  return res.rows.map((row) => ({
    taskId: Number(row.id),
    pageId: Number(row.page_id),
    wikidotId: Number(row.wikidot_id),
    slug: row.slug,
    kind: row.kind,
    attempts: Number(row.attempts),
    stableCount: Number(row.stable_count),
    lastResultHash: row.last_result_hash,
    reasons: row.reasons ?? [],
    firstPublishedAt: isoOrNull(row.first_published_at),
    taskCreatedAt: iso(row.created_at),
    claimedTotal: row.claimed_total === null ? null : Number(row.claimed_total),
    claimedRating: row.claimed_rating === null ? null : Number(row.claimed_rating),
    tier1RunId: row.tier1_run_id === null ? null : Number(row.tier1_run_id),
  }));
}

export interface FinishVoteTaskArgs {
  workerId: string;
  status: 'ok' | 'partial' | 'failed';
  settledPartial?: boolean;
  resultHash?: Buffer | null;
  localValue?: Record<string, unknown>;
  remoteValue?: Record<string, unknown>;
  now: string;
}

export interface FinishVoteTaskResult {
  action:
    | 'deleted'
    | 'retried'
    | 'irreconcilable'
    | 'review_retried'
    | 'review_reopened';
  stableCount: number;
  notBefore: string | null;
}

/**
 * ok 一律成功即删。短命页的下一次任务由 seedVoteTasks 根据
 * last_complete_vote_snapshot_at 在 3h 后重新入队，不能让成功任务伪装成失败保留。
 * 未解释的 partial/failed 保留并退避；连续 3 次同 result_hash 仍对不上则进入 irreconcilable。
 * settledPartial 是已通过矛盾身份守恒式且 page_scan 已留证的终态 partial，按成功收队。
 */
export async function finishVoteTask(
  pool: Pool,
  task: ClaimedVoteTask,
  args: FinishVoteTaskArgs,
): Promise<FinishVoteTaskResult> {
  const now = toPgTimestamptz(args.now);
  if (args.status === 'ok' || args.settledPartial === true) {
    await query(
      pool,
      'meta.irreconcilable:votes_resolve',
      `UPDATE meta.irreconcilable
          SET resolved_at = $3::timestamptz,
              last_checked = $3::timestamptz
        WHERE page_id = $1 AND kind = $2 AND resolved_at IS NULL`,
      [task.pageId, task.kind, now],
    );

    await query(
      pool,
      'meta.scan_task:finish_vote_success',
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
  const converged = stableCount >= 3;
  const backoffAttempt = converged ? stableCount - 2 : task.attempts;
  const notBefore = backoffFrom(backoffAttempt, Date.parse(now));

  if (converged) {
    await query(
      pool,
      'meta.irreconcilable:votes_converge',
      `WITH terminal AS (
         INSERT INTO meta.irreconcilable AS i
           (page_id, kind, local_value, remote_value, result_hash,
            first_seen, last_checked, checks, next_review_at,
            resolved_at, locked_by, locked_at)
         VALUES ($1, $2, $3::jsonb, $4::jsonb, $5,
                 $6::timestamptz, $6::timestamptz, 1,
                 $6::timestamptz + interval '7 days',
                 NULL, NULL, NULL)
         ON CONFLICT (page_id, kind) DO UPDATE
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
        toPgJson(args.localValue ?? {}, 'work_queue.vote_irreconcilable.local_value'),
        toPgJson(args.remoteValue ?? {}, 'work_queue.vote_irreconcilable.remote_value'),
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
    'meta.scan_task:finish_vote_retry',
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

/** 进程级熔断/异常时释放尚未完成的锁，但不回滚 attempts。失败必须保留。 */
export async function releaseVoteTaskLocks(
  pool: Pool,
  taskIds: readonly number[],
  workerId: string,
): Promise<number> {
  if (taskIds.length === 0) return 0;
  const res = await query(
    pool,
    'meta.scan_task:release_vote_locks',
    `UPDATE meta.scan_task
        SET locked_by = NULL,
            locked_at = NULL,
            not_before = COALESCE(not_before, now() + interval '1 hour')
      WHERE id = ANY($1::bigint[]) AND locked_by = $2`,
    [taskIds, workerId],
  );
  return res.rowCount ?? 0;
}

/** first_published_at 未补齐时以任务入队时刻兜住 7 天窗口，避免高频任务永久常驻。 */
export function isShortLivedTaskActive(task: ClaimedVoteTask, nowMs = Date.now()): boolean {
  const publishedMs = Date.parse(task.firstPublishedAt ?? task.taskCreatedAt);
  return Number.isFinite(publishedMs) && publishedMs > nowMs - NEW_PAGE_WINDOW_DAYS * 24 * 60 * 60_000;
}

function positiveLimit(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && (value ?? 0) > 0 ? Math.floor(value!) : fallback;
}

function isoOrNull(value: Date | string | null): string | null {
  return value === null ? null : iso(value);
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
