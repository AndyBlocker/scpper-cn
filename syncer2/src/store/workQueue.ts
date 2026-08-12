/**
 * meta.scan_task 的统一消费门面。
 *
 * 发现侧与执行侧边界：
 *   - 这里认领/完成任务，会改 attempts/not_before/stable_count/locked_*；
 *   - enqueueScanTasks 与周期 seed 等发现侧入口绝不覆盖这些列。
 *
 * 调度预算：
 *   - 普通投票 sweep 仅覆盖 90 天内有活动的页，并按 page_id 稳定相位铺满 30 天；
 *   - 发布未满 7 天的页保留 new_page_highfreq，3 小时一次；
 *   - M6 全站约定页在成功证据过期 24 小时后补一个审计锚任务。
 */

import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

import { claimedRevisionCountFromListCount } from '../collect/revisionCount.js';
import { bindSqlTuning, SQL_TUNING_CONSTANTS } from '../health/sqlTuning.js';
import { query, toPgTimestamptz, withTransaction } from './db.js';
import { toPgJson } from './pgText.js';
import { backoffFrom } from './queues.js';
import type { ScanTaskKind } from './meta.js';

export const VOTE_SWEEP_ACTIVITY_DAYS: number =
  SQL_TUNING_CONSTANTS.VOTE_SWEEP_ACTIVITY_DAYS.defaultValue;
/*
 * 盲扫周期。角色已经改变：L1 每 15 分钟读一次全站计数器（145 请求）即可发现绝大多数
 * 投票变化，盲扫只兜底 L1 看不见的「补偿性变化」——一人撤 +1、另一人补 +1，
 * 票数与评分都不变。这类极罕见，且实测盲扫产出率仅 13%（771 次扫描只有 101 次
 * 真正产生票事件），把它当主要新鲜度来源是把预算花在确认「没有变化」上。
 */
export const VOTE_SWEEP_INTERVAL_DAYS: number =
  SQL_TUNING_CONSTANTS.VOTE_SWEEP_INTERVAL_DAYS.defaultValue;
export const NEW_PAGE_WINDOW_DAYS: number =
  SQL_TUNING_CONSTANTS.NEW_PAGE_WINDOW_DAYS.defaultValue;
export const NEW_PAGE_INTERVAL_HOURS: number =
  SQL_TUNING_CONSTANTS.NEW_PAGE_INTERVAL_HOURS.defaultValue;
/** 首轮 v2 真实 WhoRated 追平按实测持续吞吐封顶；紧急 L1 变化任务仍以更高优先级插队。 */
export const VOTE_CATCHUP_RATE_PER_HOUR = 832;
export const WORK_QUEUE_LIMIT_MAX = 50;
/** 运维重放时先用未来锁隔离旧版通用 worker；只有 adult-only 消费者可接管。 */
export const ADULT_STABLE_EGRESS_HOLD = 'adult-stable-egress-hold';
export const CONSECUTIVE_PAGE_FAILURE_LIMIT = 5;

/**
 * work-queue 不再叠加进程内固定 pace。每个真实 attempt 的唯一权威是
 * PostgresAdaptiveEgressGate：它同时看全站 pressure 档位与滚动小时总量。
 *
 * 保留这个显式 0 而不是魔法省略，为了让回归能直接断言「没有第二层独立节流」。
 */
export const WORK_QUEUE_LOCAL_REQUEST_INTERVAL_MS = 0;

/*
 * 单轮时间预算，必须显著小于 systemd 的 TimeoutStartSec=10min。
 * 取 6 分钟：恰好满足统一的「预算 <= 10 分钟硬超时的 60%」，留 4 分钟给最坏收尾。
 * 超预算是**正常收敛**而非失败——剩余任务下一轮继续。
 *
 * 由来：公平性修复让 votes_full 进入配额后单轮耗时上升，超过硬超时被 SIGTERM 杀死，
 * 任务认领了却无人做完，表现为「配额生效、队列反而越积越多」。
 */
export const RUN_BUDGET_MS = 6 * 60_000;

/** systemd timer 在上一轮结束 1min 后启动，AccuracySec=5s。 */
export const WORK_QUEUE_RESTART_DELAY_MS = 60_000;
export const WORK_QUEUE_TIMER_ACCURACY_MS = 5_000;
/** 无故障、调度器按时运行时，相邻两轮开始的可推导上界。 */
export const WORK_QUEUE_ROUND_UPPER_BOUND_MS =
  RUN_BUDGET_MS + WORK_QUEUE_RESTART_DELAY_MS + WORK_QUEUE_TIMER_ACCURACY_MS;

/**
 * 排序里被硬性置顶的 kind。置顶本身没错——确认删除与新页高频复查都需要及时性——
 * 错在置顶没有上限：`new_page_highfreq` 是自我补充的（新页 7 天内反复重排），
 * 于是它每轮吃满全部配额，`votes_full` 长期拿到 0 个（实测 524 个任务里 495 个
 * 从未被尝试，最久排队 6.8 天）。
 */
export const PINNED_KINDS: readonly ScanTaskKind[] = ['confirm_deleted', 'new_page_highfreq'];

/** 置顶 kind 每轮最多占用的配额比例；余下名额回到 priority 正常竞争。 */
export const PINNED_KIND_SHARE = 0.4;

/** 每轮先给所有活跃 kind 的队首各1个名额；剩余才进入优先级竞争。 */
export const KIND_SERVICE_MIN_PER_ROUND = 1;
/** 饥饿 kind 用 FIFO 轮转占用的纠偏车道上限；至少一半仍依优先级。 */
export const FAIR_SHARE_GUARANTEED_SHARE = 0.5;
/** 等待每跨过 30min，有效优先级 +1；新高优先仍快，老任务会逐步追上。 */
export const PRIORITY_AGING_INTERVAL_MS = 30 * 60_000;
/** 终态复查不得先于常规 scan_task 吃光整轮。 */
export const IRRECONCILABLE_REVIEW_SHARE = 0.2;

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} 必须是正安全整数，收到 ${String(value)}`);
  }
  return value;
}

/** page_id 的跨进程稳定相位；SQL 使用同一个 md5 前 60 bit 算法。 */
export function voteSweepPhaseMs(pageId: number, intervalDays = VOTE_SWEEP_INTERVAL_DAYS): number {
  if (!Number.isSafeInteger(pageId)) {
    throw new RangeError(`page_id 必须是安全整数，收到 ${String(pageId)}`);
  }
  const periodMs = positiveInteger(intervalDays, '盲扫周期天数') * DAY_MS;
  const hash60 = BigInt(
    `0x${createHash('md5').update(String(pageId), 'utf8').digest('hex').slice(0, 15)}`,
  );
  return Number(hash60 % BigInt(periodMs));
}

/**
 * 某页在上次完整快照之后的第一个稳定相位。
 *
 * 历史时间戳即使完全相同，next due 也会落在其后的整个周期内；成功抓取后仍以原
 * last_complete_vote_snapshot_at 推进，不需要伪造或重写历史时间。
 */
export function nextVoteSweepDueAt(
  lastCompleteSnapshot: string | number,
  pageId: number,
  intervalDays = VOTE_SWEEP_INTERVAL_DAYS,
): string {
  const snapshotMs = typeof lastCompleteSnapshot === 'number'
    ? lastCompleteSnapshot
    : Date.parse(lastCompleteSnapshot);
  if (!Number.isFinite(snapshotMs)) {
    throw new TypeError(`非法完整快照时间 ${String(lastCompleteSnapshot)}`);
  }
  const periodMs = positiveInteger(intervalDays, '盲扫周期天数') * DAY_MS;
  const phaseMs = voteSweepPhaseMs(pageId, intervalDays);
  const dueMs = (Math.floor((snapshotMs - phaseMs) / periodMs) + 1) * periodMs + phaseMs;
  return new Date(dueMs).toISOString();
}

/** 一个周期内各小时额度之和严格等于 eligiblePages，47/48 之类的小数速率自动抹匀。 */
export function hourlyVoteSweepQuota(
  eligiblePages: number,
  intervalDays = VOTE_SWEEP_INTERVAL_DAYS,
  now: string | number = Date.now(),
): number {
  if (!Number.isSafeInteger(eligiblePages) || eligiblePages < 0) {
    throw new RangeError(`合格页数必须是非负安全整数，收到 ${String(eligiblePages)}`);
  }
  const periodHours = positiveInteger(intervalDays, '盲扫周期天数') * 24;
  const nowMs = typeof now === 'number' ? now : Date.parse(now);
  if (!Number.isFinite(nowMs)) throw new TypeError(`非法预算时间 ${String(now)}`);
  const absoluteHour = Math.floor(nowMs / HOUR_MS);
  const cycleHour = ((absoluteHour % periodHours) + periodHours) % periodHours;
  return Math.floor((eligiblePages * (cycleHour + 1)) / periodHours)
    - Math.floor((eligiblePages * cycleHour) / periodHours);
}

/** 同一小时无论调用几轮，都只能拿到 quota-used；这是生产预算记账与频率回归的共同入口。 */
export function availableHourlySeedBudget(quota: number, used: number, demand: number): number {
  for (const [label, value] of [['quota', quota], ['used', used], ['demand', demand]] as const) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(`${label} 必须是非负安全整数，收到 ${String(value)}`);
    }
  }
  return Math.min(demand, Math.max(0, quota - used));
}

export type VoteSeedLane = 'catchup' | 'sweep';

/** 追平未完成时不混入稳态盲扫；归零后自动降到 eligible/周期 的稳态车道。 */
export function activeVoteSeedLane(catchupRemaining: number): VoteSeedLane {
  if (!Number.isSafeInteger(catchupRemaining) || catchupRemaining < 0) {
    throw new RangeError(`追平剩余数必须是非负安全整数，收到 ${String(catchupRemaining)}`);
  }
  return catchupRemaining > 0 ? 'catchup' : 'sweep';
}

/** 至少留 1 个名额给置顶 kind，否则小 limit 下会造成反向饥饿。 */
export function pinnedKindQuota(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new RangeError(`认领上限必须是非负安全整数，收到 ${String(limit)}`);
  }
  if (limit === 0) return 0;
  return Math.max(1, Math.floor(limit * PINNED_KIND_SHARE));
}

/**
 * FIFO 保底/饥饿纠偏车道的总上限。
 *
 * 只要 limit >= 活跃 kind 数，这个车道先放进每个 kind 的队首；饥饿 kind
 * 的后续行按 fifo_rank 轮转填到本上限。其他名额保留给置顶/有效优先级。
 */
export function fairShareGuaranteedQuota(limit: number, selectedKindCount: number): number {
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new RangeError(`认领上限必须是非负安全整数，收到 ${String(limit)}`);
  }
  if (!Number.isSafeInteger(selectedKindCount) || selectedKindCount < 0) {
    throw new RangeError(`kind 数必须是非负安全整数，收到 ${String(selectedKindCount)}`);
  }
  if (limit === 0 || selectedKindCount === 0) return 0;
  const baseline = Math.min(limit, selectedKindCount * KIND_SERVICE_MIN_PER_ROUND);
  return Math.min(
    limit,
    Math.max(baseline, Math.floor(limit * FAIR_SHARE_GUARANTEED_SHARE)),
  );
}

/** 为常规 scan_task 留足每 kind 一个名额后，终态复查所能占的最大名额。 */
export function irreconcilableReviewQuota(limit: number, selectedKindCount: number): number {
  const regularFloor = Math.min(limit, selectedKindCount * KIND_SERVICE_MIN_PER_ROUND);
  return Math.min(
    Math.max(0, limit - regularFloor),
    Math.floor(limit * IRRECONCILABLE_REVIEW_SHARE),
  );
}

/**
 * 某个已到期任务前面有 eligibleAhead 个同 kind 任务时的认领上界。
 * 上界只用每轮 1 个 FIFO 保底，不把饥饿纠偏和优先级车道的额外吞吐算进去。
 */
export function kindClaimWaitUpperBoundMs(eligibleAhead: number): number {
  if (!Number.isSafeInteger(eligibleAhead) || eligibleAhead < 0) {
    throw new RangeError(`同 kind 队前任务数必须是非负安全整数，收到 ${String(eligibleAhead)}`);
  }
  return (eligibleAhead + 1) * WORK_QUEUE_ROUND_UPPER_BOUND_MS;
}

/** SQL 认领排序的纯函数对照，便于对老化转折点做精确回归。 */
export function effectiveTaskPriority(
  priority: number,
  createdAt: string | number,
  now: string | number = Date.now(),
): number {
  if (!Number.isSafeInteger(priority)) {
    throw new RangeError(`优先级必须是安全整数，收到 ${String(priority)}`);
  }
  const createdMs = typeof createdAt === 'number' ? createdAt : Date.parse(createdAt);
  const nowMs = typeof now === 'number' ? now : Date.parse(now);
  if (!Number.isFinite(createdMs) || !Number.isFinite(nowMs)) {
    throw new TypeError(`非法老化时间 createdAt=${String(createdAt)} now=${String(now)}`);
  }
  return priority + Math.floor(Math.max(0, nowMs - createdMs) / PRIORITY_AGING_INTERVAL_MS);
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
  /** 与 revisionClaimedTotal 同一份 L1 快照，handler 用它排除抓取期间水位前进竞态。 */
  revisionTier1RunId?: number | null;
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
  catchupAffected: number;
  /** 尚无 v2 完整快照、但 votes_full 已在队列中的页数。 */
  catchupQueued: number;
  /** 尚无 v2 完整快照且尚未入队，本轮可真正新建的页数。 */
  catchupSeedable: number;
  sweepAffected: number;
  eligiblePages: number;
  catchupRemaining: number;
  activeLane: VoteSeedLane;
  hourlyBudget: number;
  hourlyBudgetUsed: number;
}

export interface SeedVoteTasksOptions {
  highFrequencyLimit?: number;
  /** 测试/人工小批的单次额外上限；生产默认只受墙钟小时预算约束。 */
  laneLimit?: number;
  activityDays?: number;
  sweepIntervalDays?: number;
  newPageWindowDays?: number;
  newPageIntervalHours?: number;
  catchupRatePerHour?: number;
  /** 测试使用 test:* 隔离账本；生产保持默认 vote。 */
  budgetKeyPrefix?: string;
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
  /** meta 身份任务成功收尾时排除自身；通用失败复核传 null，把当前失败任务也迁走。 */
  currentTaskId: number | null,
): Promise<number> {
  const result = await query<{ moved: string }>(
    pool,
    'meta.scan_task:reassign_slug_reuse',
    `WITH candidates AS MATERIALIZED (
       SELECT st.id, st.kind, st.reasons, st.priority
        FROM meta.scan_task st
       WHERE st.page_id = $1
          AND ($3::bigint IS NULL OR st.id <> $3)
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

/** 身份替换/直接删除后，旧 page 上的终态矛盾已失去对象，显式收口而非永久悬挂。 */
export async function resolveObsoletePageIrreconcilables(
  pool: Pool,
  pageId: number,
  resolvedAt: string,
): Promise<number> {
  const result = await query(
    pool,
    'meta.irreconcilable:resolve_obsolete_identity',
    `UPDATE meta.irreconcilable
        SET resolved_at = $2::timestamptz,
            last_checked = $2::timestamptz,
            next_review_at = NULL,
            locked_by = NULL,
            locked_at = NULL
      WHERE page_id = $1
        AND resolved_at IS NULL`,
    [pageId, toPgTimestamptz(resolvedAt)],
  );
  return result.rowCount ?? 0;
}

/** 直接身份证据确认删除后，所有旧页任务（含 confirm_deleted）都已完成使命。 */
export async function retireDeletedPageTasks(pool: Pool, pageId: number): Promise<number> {
  const result = await query(
    pool,
    'meta.scan_task:retire_identity_deleted',
    `DELETE FROM meta.scan_task WHERE page_id = $1`,
    [pageId],
  );
  return result.rowCount ?? 0;
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
  newPageWindowDays = NEW_PAGE_WINDOW_DAYS,
  slugPrefix: string | null = null,
  reservedLockOwner: string | null = null,
  starvedKinds: readonly ScanTaskKind[] = [],
): Promise<ClaimedWorkTask[]> {
  const limit = Math.min(WORK_QUEUE_LIMIT_MAX, Math.max(0, Math.floor(requestedLimit)));
  if (limit === 0 || kinds.length === 0) return [];
  const pinnedQuota = pinnedKindQuota(limit);
  const guaranteedQuota = fairShareGuaranteedQuota(limit, kinds.length);
  const shortLivedDays = positiveInteger(newPageWindowDays, '新页窗口天数');

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
    revision_tier1_run_id: string | null;
    actual_revision_count: number;
    comment_count: number;
    discussion_thread_id: string | null;
  }>(
    pool,
    'meta.scan_task:claim_all_work',
    `WITH eligible AS (
       SELECT st.id, st.kind, st.priority, st.not_before, st.created_at,
              (
                st.priority::bigint + floor(
                  GREATEST(0, extract(epoch FROM now() - st.created_at))
                  / $12::numeric
                )::bigint
              ) AS effective_priority,
              row_number() OVER (
                PARTITION BY st.kind
                ORDER BY st.created_at, st.id
              ) AS fifo_rank
         FROM meta.scan_task st
         JOIN serve.page_current pc ON pc.page_id = st.page_id
         JOIN ingest.page p ON p.id = st.page_id
        WHERE st.kind = ANY($4::text[])
          AND ($8::text IS NULL OR pc.slug LIKE $8 || '%')
          AND (
            pc.status = 'live'
            OR (
              st.kind = 'meta'
              AND 'revision_regression_identity_check' = ANY(st.reasons)
            )
          )
          AND (
            (
              st.kind = 'meta'
              AND 'revision_regression_identity_check' = ANY(st.reasons)
            )
            OR NOT EXISTS (
              SELECT 1
                FROM meta.irreconcilable i
               WHERE i.page_id = st.page_id
                 AND i.kind = st.kind
                 AND i.resolved_at IS NULL
            )
          )
          AND (
            st.kind NOT IN ('votes_full', 'new_page_highfreq')
            OR ${voteClaimEvidenceExists('st.page_id')}
          )
          AND (
            st.kind <> 'new_page_highfreq'
            OR COALESCE(pc.first_published_at, p.created_at, st.created_at)
                 > now() - ($7::integer * interval '1 day')
          )
          AND (st.not_before IS NULL OR st.not_before <= now())
          AND (
            ($9::text IS NOT NULL AND st.locked_by = $9)
            OR st.locked_by IS NULL
            OR st.locked_at < now() - ($3::bigint || ' milliseconds')::interval
          )
     ),
     /*
      * 层次一：每个活跃 kind 的最老到期任务先拿 1 个 FIFO 保底。
      * 检测器已报饥饿的 kind 可继续提供第 2/3/... 个候选，按 fifo_rank
      * 轮转填满纠偏车道。因此高优先 kind 每轮重新播种也抢不走别的 kind
      * 的队首名额；而饥饿报警会实际扩大该 kind 的认领数，不只是日志。
      */
     guaranteed_candidates AS (
       SELECT e.*,
              row_number() OVER (
                ORDER BY CASE WHEN e.fifo_rank = 1 THEN 0 ELSE 1 END,
                         e.fifo_rank,
                         (e.kind = 'confirm_deleted') DESC,
                         (e.kind = 'new_page_highfreq') DESC,
                         e.effective_priority DESC,
                         e.created_at,
                         e.id
              ) AS fair_ord
         FROM eligible e
        WHERE (e.fifo_rank = 1 OR e.kind = ANY($10::text[]))
          AND (
            e.kind <> ALL($5::text[])
            OR e.fifo_rank <= $6::int
          )
     ),
     guaranteed AS MATERIALIZED (
       SELECT id, kind, fair_ord
         FROM guaranteed_candidates
        ORDER BY fair_ord
        LIMIT $11
     ),
     guaranteed_counts AS (
       SELECT count(*)::int AS total,
              count(*) FILTER (WHERE kind = 'confirm_deleted')::int AS confirm_deleted,
              count(*) FILTER (WHERE kind = 'new_page_highfreq')::int AS new_page_highfreq
         FROM guaranteed
     ),
     /*
      * 层次二：剩余名额保留原有置顶语义，但置顶 kind 仍受每轮封顶。
      * 非置顶任务按 priority + wait/30min 的有效优先级竞争；这使持续到来
      * 的新高优先任务仍然更快，但不能永久压住已等待的低优先任务。
      */
     priority_candidates AS (
       SELECT e.*,
              row_number() OVER (
                PARTITION BY e.kind
                ORDER BY e.effective_priority DESC, e.created_at, e.id
              ) AS priority_rank_after_guarantee
         FROM eligible e
         LEFT JOIN guaranteed g ON g.id = e.id
        WHERE g.id IS NULL
     ),
     priority_eligible AS (
       SELECT p.*
         FROM priority_candidates p
         CROSS JOIN guaranteed_counts gc
        WHERE p.kind NOT IN ('confirm_deleted', 'new_page_highfreq')
           OR (
             p.kind = 'confirm_deleted'
             AND p.priority_rank_after_guarantee <= GREATEST(0, $6::int - gc.confirm_deleted)
           )
           OR (
             p.kind = 'new_page_highfreq'
             AND p.priority_rank_after_guarantee <= GREATEST(0, $6::int - gc.new_page_highfreq)
           )
     ),
     priority_ordered AS (
       SELECT p.id,
              row_number() OVER (
                ORDER BY (p.kind = 'confirm_deleted') DESC,
                         (p.kind = 'new_page_highfreq') DESC,
                         p.effective_priority DESC,
                         p.created_at,
                         p.id
              ) AS priority_ord
         FROM priority_eligible p
     ),
     priority_picked AS MATERIALIZED (
       SELECT id, priority_ord
         FROM priority_ordered
        ORDER BY priority_ord
        LIMIT GREATEST(0, $2::int - (SELECT total FROM guaranteed_counts))
     ),
     scheduled AS (
       SELECT g.id, g.fair_ord::bigint AS schedule_ord
         FROM guaranteed g
       UNION ALL
       SELECT p.id,
              ((SELECT total FROM guaranteed_counts) + p.priority_ord)::bigint AS schedule_ord
         FROM priority_picked p
     ),
     picked AS (
       SELECT st.id, scheduled.schedule_ord
         FROM scheduled
         JOIN meta.scan_task st ON st.id = scheduled.id
        ORDER BY scheduled.schedule_ord
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
            ips.last_l1_revision AS revision_claimed_total,
            ips.last_l1_run_id::text AS revision_tier1_run_id,
            pc.revision_count AS actual_revision_count,
            pc.comment_count,
            pc.discussion_thread_id::text,
            picked.schedule_ord
       FROM claimed st
       JOIN picked ON picked.id = st.id
       JOIN serve.page_current pc ON pc.page_id = st.page_id
       LEFT JOIN meta.incremental_page_state ips
         ON ips.page_id = st.page_id AND ips.slug = pc.slug
       LEFT JOIN LATERAL (
         ${voteClaimEvidence('st.page_id')}
       ) tier1 ON true
      ORDER BY picked.schedule_ord`,
    [
      workerId,
      limit,
      String(lockStaleAfterMs),
      kinds,
      PINNED_KINDS,
      pinnedQuota,
      bindSqlTuning('NEW_PAGE_WINDOW_DAYS', shortLivedDays),
      slugPrefix,
      reservedLockOwner,
      starvedKinds,
      guaranteedQuota,
      Math.floor(PRIORITY_AGING_INTERVAL_MS / 1_000),
    ],
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
    revisionTier1RunId:
      row.revision_tier1_run_id === null ? null : Number(row.revision_tier1_run_id),
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
  slugPrefix: string | null = null,
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
    revision_tier1_run_id: string | null;
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
          AND ($5::text IS NULL OR pc.slug LIKE $5 || '%')
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
            ips.last_l1_revision AS revision_claimed_total,
            ips.last_l1_run_id::text AS revision_tier1_run_id,
            pc.revision_count AS actual_revision_count,
            pc.comment_count,
            pc.discussion_thread_id::text
       FROM claimed i
       JOIN serve.page_current pc ON pc.page_id = i.page_id
       LEFT JOIN meta.incremental_page_state ips
         ON ips.page_id = i.page_id AND ips.slug = pc.slug
       LEFT JOIN LATERAL (
         ${voteClaimEvidence('i.page_id')}
       ) tier1 ON true
      ORDER BY i.next_review_at, i.page_id, i.kind`,
    [workerId, limit, String(lockStaleAfterMs), kinds, slugPrefix],
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
    revisionTier1RunId:
      row.revision_tier1_run_id === null ? null : Number(row.revision_tier1_run_id),
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
  /** 确定性结构/权限拒绝：本次即进入 irreconcilable，不经过指数退避。 */
  terminalFailure?: boolean;
  now: string;
}

/** 所有普通 handler 共用的完成状态机：成功删，失败/partial 保留并退避。 */
/**
 * 清理已不再 live 的页面上的待办任务。
 *
 * 认领查询要求 `pc.status = 'live'`，因此页面被删后其余待办**永远取不到**：
 * attempts 恒为 0、退避永不推进、stable_count 永不变化——它们对系统完全不可见地存在着，
 * 却持续污染每一项基于队列的观测。实测因此误判过两次：
 * 「realtime 任务平均等待 130 小时」实际上主体是已删页僵尸（74 个里 65 个），
 * 真正在等的只有 9 个；队列深度与最久等待也同样失真。
 *
 * `confirm_deleted` 必须保留——它正是用来确认删除本身的，属于 predecessor 生命周期。
 */
export async function reapTasksOnNonLivePages(
  pool: Pool,
): Promise<{ total: number; byKind: Record<string, number> }> {
  const res = await query<{ kind: ScanTaskKind }>(
    pool,
    'meta.scan_task:reap_non_live',
    `DELETE FROM meta.scan_task st
      WHERE st.kind <> 'confirm_deleted'
        AND NOT EXISTS (
          SELECT 1 FROM serve.page_current pc
           WHERE pc.page_id = st.page_id AND pc.status = 'live'
        )
      RETURNING st.kind`,
  );
  const byKind: Record<string, number> = {};
  for (const r of res.rows) byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;
  return { total: res.rows.length, byKind };
}

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
  const converged = args.terminalFailure === true || stableCount >= 3;
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
  releaseToOwner: string | null = null,
): Promise<number> {
  if (taskIds.length === 0) return 0;
  const result = await query(
    pool,
    'meta.scan_task:release_work_locks',
    `UPDATE meta.scan_task
        SET locked_by = $3::text,
            -- adult 定向重放用未来锁隔离通用 worker；定向 worker 通过 reservedLockOwner
            -- 仍可立即认领。普通释放保持 NULL/NULL。
            locked_at = CASE WHEN $3::text IS NULL
                             THEN NULL
                             ELSE clock_timestamp() + interval '4 hours' END,
            -- 本轮根本没执行到的任务不应被当成失败退避，也不应白烧一次 attempts。
            -- 只有 finishWorkTask 看见真实 partial/failed 后才有权推进退避。
            attempts = GREATEST(0, attempts - 1)
      WHERE id = ANY($1::bigint[]) AND locked_by = $2`,
    [taskIds, workerId, releaseToOwner],
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

function hourWindowStart(now: string): string {
  const nowMs = Date.parse(now);
  return new Date(Math.floor(nowMs / HOUR_MS) * HOUR_MS).toISOString();
}

interface BudgetedSeedResult {
  affected: number;
  used: number;
}

/** 预算行与候选 INSERT 共用一个事务；并发轮次也只能串行消耗同一小时的余额。 */
async function seedWithinHourlyBudget(
  pool: Pool,
  budgetKey: string,
  now: string,
  quota: number,
  demand: number,
  seed: (client: PoolClient, allowance: number) => Promise<number>,
): Promise<BudgetedSeedResult> {
  const windowStartedAt = hourWindowStart(now);
  return withTransaction(pool, `vote_seed_budget:${budgetKey}`, async (client) => {
    await query(
      client,
      'meta.vote_seed_budget:ensure',
      `INSERT INTO meta.vote_seed_budget
         (budget_key, window_started_at, used, updated_at)
       VALUES ($1, $2::timestamptz, 0, $3::timestamptz)
       ON CONFLICT (budget_key) DO NOTHING`,
      [budgetKey, windowStartedAt, now],
    );
    const budget = await query<{ used: number }>(
      client,
      'meta.vote_seed_budget:open_window',
      `UPDATE meta.vote_seed_budget
          SET used = CASE
                       WHEN window_started_at = $2::timestamptz THEN used
                       ELSE 0
                     END,
              window_started_at = $2::timestamptz,
              updated_at = $3::timestamptz
        WHERE budget_key = $1
      RETURNING used`,
      [budgetKey, windowStartedAt, now],
    );
    const usedBefore = Number(budget.rows[0]?.used ?? 0);
    const allowance = availableHourlySeedBudget(quota, usedBefore, demand);
    const affected = allowance === 0 ? 0 : await seed(client, allowance);
    if (affected > allowance) {
      throw new Error(`播种 ${affected} 条超过已核发额度 ${allowance}`);
    }
    if (affected > 0) {
      await query(
        client,
        'meta.vote_seed_budget:consume',
        `UPDATE meta.vote_seed_budget
            SET used = used + $2::integer,
                updated_at = $3::timestamptz
          WHERE budget_key = $1`,
        [budgetKey, affected, now],
      );
    }
    return { affected, used: usedBefore + affected };
  });
}

/**
 * 补齐投票周期任务。
 *
 * new_page_highfreq 是实时保护，不占盲扫预算；其余页先走 832/h 的 v2 首轮追平，全部
 * 有真实完整快照后自动切换到 eligible/周期 的稳态车道。两条车道都按持久墙钟小时
 * 记账，与 work-queue 一小时跑几轮无关。
 */
export async function seedVoteTasks(
  pool: Pool,
  now: string,
  opts: SeedVoteTasksOptions = {},
): Promise<SeedVoteTasksResult> {
  const ts = toPgTimestamptz(now);
  const highFrequencyLimit = positiveLimit(opts.highFrequencyLimit, WORK_QUEUE_LIMIT_MAX);
  const activityDays = positiveInteger(
    opts.activityDays ?? VOTE_SWEEP_ACTIVITY_DAYS,
    '盲扫活动窗口天数',
  );
  const sweepIntervalDays = positiveInteger(
    opts.sweepIntervalDays ?? VOTE_SWEEP_INTERVAL_DAYS,
    '盲扫周期天数',
  );
  const newPageWindowDays = positiveInteger(
    opts.newPageWindowDays ?? NEW_PAGE_WINDOW_DAYS,
    '新页窗口天数',
  );
  const newPageIntervalHours = positiveInteger(
    opts.newPageIntervalHours ?? NEW_PAGE_INTERVAL_HOURS,
    '新页重扫间隔小时数',
  );
  const catchupRate = positiveInteger(
    opts.catchupRatePerHour ?? VOTE_CATCHUP_RATE_PER_HOUR,
    '追平每小时额度',
  );
  const laneLimit = opts.laneLimit === undefined
    ? Number.MAX_SAFE_INTEGER
    : positiveInteger(opts.laneLimit, '单次车道上限');
  const budgetPrefix = opts.budgetKeyPrefix ?? 'vote';
  if (!/^[a-z0-9:_-]+$/i.test(budgetPrefix)) {
    throw new RangeError(`非法预算键前缀 ${budgetPrefix}`);
  }

  // 高频队列必须短命：跨过窗口边界后立即退役，不能让持续失败任务靠退避永久保留。
  // 2h 以前的锁视为死进程遗留；它是锁回收契约，不是新页窗口配置。
  const retired = await query(
    pool,
    'meta.scan_task:retire_vote_highfreq',
    `DELETE FROM meta.scan_task st
      USING serve.page_current pc, ingest.page p
      WHERE st.page_id = pc.page_id
        AND p.id = pc.page_id
        AND st.kind = 'new_page_highfreq'
        AND COALESCE(pc.first_published_at, p.created_at, st.created_at)
              <= $1::timestamptz - ($2::integer * interval '1 day')
        AND (
          st.locked_by IS NULL
          OR st.locked_at < $1::timestamptz - interval '2 hours'
        )`,
    [ts, bindSqlTuning('NEW_PAGE_WINDOW_DAYS', newPageWindowDays)],
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
                > $1::timestamptz - ($3::integer * interval '1 day')
          AND (
            pc.last_complete_vote_snapshot_at IS NULL
            OR pc.last_complete_vote_snapshot_at
                 <= $1::timestamptz - ($4::integer * interval '1 hour')
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
    [
      ts,
      highFrequencyLimit,
      bindSqlTuning('NEW_PAGE_WINDOW_DAYS', newPageWindowDays),
      bindSqlTuning('NEW_PAGE_INTERVAL_HOURS', newPageIntervalHours),
    ],
  );

  const population = await query<{
    eligible_pages: string;
    catchup_remaining: string;
    catchup_queued: string;
    catchup_seedable: string;
  }>(
    pool,
    'meta.scan_task:vote_seed_population',
    `WITH recent_activity AS (
       SELECT vc.page_id
         FROM serve.vote_current vc
        WHERE vc.last_voted_at
              >= $1::timestamptz - ($2::integer * interval '1 day')
        GROUP BY vc.page_id
     ),
     qualified AS (
       SELECT pc.page_id
         FROM recent_activity va
         JOIN serve.page_current pc ON pc.page_id = va.page_id
         JOIN ingest.page p ON p.id = pc.page_id
        WHERE pc.status = 'live'
          AND COALESCE(pc.first_published_at, p.created_at)
                <= $1::timestamptz - ($3::integer * interval '1 day')
          AND NOT EXISTS (
            SELECT 1
              FROM meta.irreconcilable i
             WHERE i.page_id = pc.page_id
               AND i.kind = 'votes_full'
               AND i.resolved_at IS NULL
          )
          AND ${voteClaimEvidenceExists('pc.page_id')}
     )
     SELECT count(*)::text AS eligible_pages,
            count(*) FILTER (WHERE state.page_id IS NULL)::text AS catchup_remaining,
            count(*) FILTER (
              WHERE state.page_id IS NULL AND task.page_id IS NOT NULL
            )::text AS catchup_queued,
            count(*) FILTER (
              WHERE state.page_id IS NULL AND task.page_id IS NULL
            )::text AS catchup_seedable
       FROM qualified q
       LEFT JOIN meta.vote_sweep_page_state state ON state.page_id = q.page_id
       LEFT JOIN meta.scan_task task
         ON task.page_id = q.page_id AND task.kind = 'votes_full'`,
    [
      ts,
      bindSqlTuning('VOTE_SWEEP_ACTIVITY_DAYS', activityDays),
      bindSqlTuning('NEW_PAGE_WINDOW_DAYS', newPageWindowDays),
    ],
  );
  const eligiblePages = Number(population.rows[0]?.eligible_pages ?? 0);
  const catchupRemaining = Number(population.rows[0]?.catchup_remaining ?? 0);
  const catchupQueued = Number(population.rows[0]?.catchup_queued ?? 0);
  const catchupSeedable = Number(population.rows[0]?.catchup_seedable ?? 0);
  const activeLane = activeVoteSeedLane(catchupRemaining);
  const hourlyBudget = activeLane === 'catchup'
    ? catchupRate
    : hourlyVoteSweepQuota(eligiblePages, sweepIntervalDays, ts);
  const demand = Math.min(laneLimit, activeLane === 'catchup' ? catchupSeedable : eligiblePages);

  let catchupAffected = 0;
  let sweepAffected = 0;
  let hourlyBudgetUsed = 0;
  if (activeLane === 'catchup') {
    const budgeted = await seedWithinHourlyBudget(
      pool,
      `${budgetPrefix}:catchup`,
      ts,
      hourlyBudget,
      demand,
      async (client, allowance) => {
        const seeded = await query(
          client,
          'meta.scan_task:seed_vote_catchup',
          `WITH recent_activity AS (
             SELECT vc.page_id, max(vc.last_voted_at) AS last_vote_at
               FROM serve.vote_current vc
              WHERE vc.last_voted_at
                    >= $1::timestamptz - ($2::integer * interval '1 day')
              GROUP BY vc.page_id
           ),
           candidates AS (
             SELECT pc.page_id
               FROM recent_activity va
               JOIN serve.page_current pc ON pc.page_id = va.page_id
               JOIN ingest.page p ON p.id = pc.page_id
               LEFT JOIN meta.vote_sweep_page_state state ON state.page_id = pc.page_id
              WHERE pc.status = 'live'
                AND state.page_id IS NULL
                AND COALESCE(pc.first_published_at, p.created_at)
                      <= $1::timestamptz - ($3::integer * interval '1 day')
                AND NOT EXISTS (
                  SELECT 1 FROM meta.scan_task st
                   WHERE st.page_id = pc.page_id AND st.kind = 'votes_full'
                )
                AND NOT EXISTS (
                  SELECT 1 FROM meta.irreconcilable i
                   WHERE i.page_id = pc.page_id
                     AND i.kind = 'votes_full'
                     AND i.resolved_at IS NULL
                )
                AND ${voteClaimEvidenceExists('pc.page_id')}
              ORDER BY va.last_vote_at DESC, pc.page_id
              LIMIT $4
           )
           INSERT INTO meta.scan_task
             (page_id, kind, reasons, priority, not_before)
           SELECT page_id, 'votes_full', ARRAY['votes_v2_initial_catchup'], 20,
                  $1::timestamptz
             FROM candidates
           ON CONFLICT (page_id, kind) DO NOTHING`,
          [
            ts,
            bindSqlTuning('VOTE_SWEEP_ACTIVITY_DAYS', activityDays),
            bindSqlTuning('NEW_PAGE_WINDOW_DAYS', newPageWindowDays),
            allowance,
          ],
        );
        return seeded.rowCount ?? 0;
      },
    );
    catchupAffected = budgeted.affected;
    hourlyBudgetUsed = budgeted.used;
  } else {
    const budgeted = await seedWithinHourlyBudget(
      pool,
      `${budgetPrefix}:sweep`,
      ts,
      hourlyBudget,
      demand,
      async (client, allowance) => {
        const seeded = await query(
          client,
          'meta.scan_task:seed_vote_sweep',
          `WITH recent_activity AS (
             SELECT vc.page_id, max(vc.last_voted_at) AS last_vote_at
               FROM serve.vote_current vc
              WHERE vc.last_voted_at
                    >= $1::timestamptz - ($2::integer * interval '1 day')
              GROUP BY vc.page_id
           ),
           scheduled AS (
             SELECT pc.page_id,
                    to_timestamp((
                      (
                        floor((
                          extract(epoch FROM pc.last_complete_vote_snapshot_at) * 1000
                          - phase.phase_ms
                        ) / cfg.period_ms) + 1
                      ) * cfg.period_ms + phase.phase_ms
                    ) / 1000.0) AS due_at,
                    va.last_vote_at
               FROM recent_activity va
               JOIN serve.page_current pc ON pc.page_id = va.page_id
               JOIN ingest.page p ON p.id = pc.page_id
               JOIN meta.vote_sweep_page_state state ON state.page_id = pc.page_id
               CROSS JOIN LATERAL (
                 SELECT ($4::bigint * 86400000::bigint) AS period_ms
               ) cfg
               CROSS JOIN LATERAL (
                 SELECT mod(
                   ('x' || substr(md5(pc.page_id::text), 1, 15))::bit(60)::bigint,
                   cfg.period_ms
                 ) AS phase_ms
               ) phase
              WHERE pc.status = 'live'
                AND pc.last_complete_vote_snapshot_at IS NOT NULL
                AND COALESCE(pc.first_published_at, p.created_at)
                      <= $1::timestamptz - ($3::integer * interval '1 day')
                AND NOT EXISTS (
                  SELECT 1 FROM meta.scan_task st
                   WHERE st.page_id = pc.page_id AND st.kind = 'votes_full'
                )
                AND NOT EXISTS (
                  SELECT 1 FROM meta.irreconcilable i
                   WHERE i.page_id = pc.page_id
                     AND i.kind = 'votes_full'
                     AND i.resolved_at IS NULL
                )
                AND ${voteClaimEvidenceExists('pc.page_id')}
           ),
           candidates AS (
             SELECT page_id
               FROM scheduled
              WHERE due_at <= $1::timestamptz
              ORDER BY due_at, last_vote_at DESC, page_id
              LIMIT $5
           )
           INSERT INTO meta.scan_task
             (page_id, kind, reasons, priority, not_before)
           SELECT page_id, 'votes_full', ARRAY['votes_sweep_stable_phase'], 10,
                  $1::timestamptz
             FROM candidates
           ON CONFLICT (page_id, kind) DO NOTHING`,
          [
            ts,
            bindSqlTuning('VOTE_SWEEP_ACTIVITY_DAYS', activityDays),
            bindSqlTuning('NEW_PAGE_WINDOW_DAYS', newPageWindowDays),
            bindSqlTuning('VOTE_SWEEP_INTERVAL_DAYS', sweepIntervalDays),
            allowance,
          ],
        );
        return seeded.rowCount ?? 0;
      },
    );
    sweepAffected = budgeted.affected;
    hourlyBudgetUsed = budgeted.used;
  }

  return {
    highFrequencyRetired: retired.rowCount ?? 0,
    highFrequencyAffected: highFrequency.rowCount ?? 0,
    catchupAffected,
    catchupQueued,
    catchupSeedable,
    sweepAffected,
    eligiblePages,
    catchupRemaining,
    activeLane,
    hourlyBudget,
    hourlyBudgetUsed,
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
  newPageWindowDays = NEW_PAGE_WINDOW_DAYS,
): Promise<ClaimedVoteTask[]> {
  const limit = Math.min(WORK_QUEUE_LIMIT_MAX, Math.max(0, Math.floor(requestedLimit)));
  if (limit === 0) return [];
  const shortLivedDays = positiveInteger(newPageWindowDays, '新页窗口天数');

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
                 > now() - ($4::integer * interval '1 day')
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
    [
      workerId,
      limit,
      String(lockStaleAfterMs),
      bindSqlTuning('NEW_PAGE_WINDOW_DAYS', shortLivedDays),
    ],
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
  /** 确定性结构/权限拒绝：本次即进入 irreconcilable，不经过指数退避。 */
  terminalFailure?: boolean;
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
    // 只有真正完整的 v2 WhoRated 才推进追平状态；settled partial 虽可收队，却不冒充完整快照。
    if (args.status === 'ok') {
      await query(
        pool,
        'meta.vote_sweep_page_state:complete',
        `INSERT INTO meta.vote_sweep_page_state AS state
           (page_id, first_v2_complete_at, last_v2_complete_at)
         VALUES ($1, $2::timestamptz, $2::timestamptz)
         ON CONFLICT (page_id) DO UPDATE
           SET first_v2_complete_at = LEAST(
                 state.first_v2_complete_at,
                 EXCLUDED.first_v2_complete_at
               ),
               last_v2_complete_at = GREATEST(
                 state.last_v2_complete_at,
                 EXCLUDED.last_v2_complete_at
               )`,
        [task.pageId, now],
      );
    }
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
  const converged = args.terminalFailure === true || stableCount >= 3;
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
