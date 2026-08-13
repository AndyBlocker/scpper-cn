/** 单次等待上限：超过即放弃该任务、留给下轮。 */
export const EXTERNAL_IMAGE_MAX_INLINE_WAIT_MS = 20_000;

export class ExternalHostDeferredError extends Error {
  constructor(readonly host: string, readonly waitMs: number) {
    super(`站外主机 ${host} 放行时间过远（${Math.round(waitMs / 1000)}s），本轮跳过`);
    this.name = 'ExternalHostDeferredError';
  }
}

/**
 * 站外图片 exact-hostname 自适应出口。
 *
 * 与 Wikidot 的 meta.egress_control 完全隔离：这里仅访问
 * meta.external_image_egress_*。每个 host 独立反馈/恢复；global 单例只负责站外总 pace
 * 与滚动总量，绝不消费失败，所以 host A 的 429 不会改变 host B 的档位。
 */

import type { Pool, PoolClient, QueryResultRow } from 'pg';

import {
  ADAPTIVE_EGRESS_POLICY,
  AdaptiveEgressUnavailableError,
  evaluateFailureWindow,
  evaluateRollingBudget,
  isAdaptivePressureFailure,
  type AdaptiveAttemptOutcome,
  type AdaptiveEgressGate,
  type AdaptiveEgressLevel,
  type AdaptiveEgressPermit,
  type AdaptiveEgressPolicy,
  type AdaptiveEgressRuntimeStats,
  type AdaptiveEgressSnapshot,
  type AdaptiveEgressTier,
  type AdaptiveEgressTransition,
  type FailureWindowState,
} from '../http/adaptiveEgress.js';
import { createPool, query, toPgTimestamptz, withTransaction } from '../store/db.js';
import { createLogger, type Logger } from '../util/log.js';
import {
  abortableSleep,
  isRuntimeBudgetExceededError,
  throwIfAborted,
} from '../util/runtimeBudget.js';

const CONTROL_LOCK_ID = 2_026_081_2;
const GLOBAL_BASE_INTERVAL_MS = 3_000;
const GLOBAL_BUDGET_BREACH_INTERVAL_MS = 30_000;
export const EXTERNAL_IMAGE_GLOBAL_HOURLY_BUDGET = 650;

export const EXTERNAL_IMAGE_EGRESS_POLICY: AdaptiveEgressPolicy = Object.freeze({
  windowRequests: 20,
  elevatedFailureRate: 0.10,
  severeFailureRate: 0.25,
  healthyFailureRate: 0.05,
  elevatedWindowsToBackoff: 2,
  healthyWindowsToRecover: 3,
  recoveryWindowMs: 5 * 60_000,
  rollingBudgetMinutes: 60,
  rollingBudgetRequests: 300,
  // 本 gate 不用 Wikidot 的稀疏 connection streak；字段保留为共享策略类型契约。
  connectionFailureStreakToBackoff: ADAPTIVE_EGRESS_POLICY.connectionFailureStreakToBackoff,
  connectionFailureStreakWindowMs: ADAPTIVE_EGRESS_POLICY.connectionFailureStreakWindowMs,
  connectionBackoffMinIntervalMs: ADAPTIVE_EGRESS_POLICY.connectionBackoffMinIntervalMs,
  tiers: Object.freeze([
    // 12s = 300/h：正常档本身即服从单 host 滚动预算；多 host 可由 global 3s 交错填满。
    { level: 0, name: 'normal', minIntervalMs: 12_000, minimumHoldMs: 0 },
    { level: 1, name: 'cautious', minIntervalMs: 30_000, minimumHoldMs: 30 * 60_000 },
    { level: 2, name: 'protective', minIntervalMs: 2 * 60_000, minimumHoldMs: 2 * 60 * 60_000 },
    { level: 3, name: 'cooldown', minIntervalMs: 10 * 60_000, minimumHoldMs: 6 * 60 * 60_000 },
  ] satisfies AdaptiveEgressTier[]),
});

export interface ExternalRateLimitDecision {
  state: FailureWindowState;
  transition: AdaptiveEgressTransition | null;
}

/** 429/503 是明确停手信号：单次逐级降档，不等 20-request 失败率窗口。 */
export function evaluateExternalRateLimitSignal(
  input: FailureWindowState,
  status: number | null,
  atMs: number,
  policy: AdaptiveEgressPolicy = EXTERNAL_IMAGE_EGRESS_POLICY,
): ExternalRateLimitDecision {
  if (status !== 429 && status !== 503) return { state: input, transition: null };
  if (!Number.isFinite(atMs)) throw new RangeError(`非法 external rate-limit at=${atMs}`);
  const current = policyTier(policy, input.level);
  if (input.level === 3) {
    return {
      state: {
        ...input,
        reason: `http_${status}_rate_limit_signal_hold`,
        recoverNotBeforeMs: Math.max(
          input.recoverNotBeforeMs ?? 0,
          atMs + current.minimumHoldMs,
        ),
        elevatedWindows: 0,
        healthyWindows: 0,
      },
      transition: null,
    };
  }
  const toLevel = (input.level + 1) as AdaptiveEgressLevel;
  const reason = `http_${status}_rate_limit_signal_immediate`;
  return {
    state: {
      ...input,
      level: toLevel,
      reason,
      changedAtMs: atMs,
      recoverNotBeforeMs: atMs + policyTier(policy, toLevel).minimumHoldMs,
      elevatedWindows: 0,
      healthyWindows: 0,
      budgetBreached: false,
    },
    transition: {
      kind: 'failure_backoff',
      fromLevel: input.level,
      toLevel,
      reason,
      failureRate: null,
      rollingHourRequests: null,
    },
  };
}

export interface ExternalImageHostSnapshot {
  host: string;
  level: AdaptiveEgressLevel;
  levelName: string;
  minRequestIntervalMs: number;
  reason: string;
  recoverNotBefore: string | null;
  rollingHourRequests: number;
  budgetLimit: number;
  budgetBreached: boolean;
  currentWindowRequests: number;
  currentWindowFailures: number;
  lastWindowFailureRate: number | null;
  updatedAt: string;
}

interface HostControlRow extends QueryResultRow {
  host: string;
  level: number;
  reason: string;
  changed_at: string;
  recover_not_before: string | null;
  next_permit_at: string;
  current_window_requests: number;
  current_window_failures: number;
  elevated_windows: number;
  healthy_windows: number;
  last_window_failure_rate: number | null;
  last_window_completed_at: string | null;
  rolling_hour_requests: number;
  budget_limit: number;
  budget_breached: boolean;
  updated_at: string;
}

interface GlobalControlRow extends QueryResultRow {
  next_permit_at: string;
  rolling_hour_requests: number;
  budget_limit: number;
  budget_breached: boolean;
  last_pruned_at: string;
}

interface HostControlUpdate {
  nextPermitAt?: string;
  currentWindowRequests?: number;
  currentWindowFailures?: number;
  lastWindowFailureRate?: number | null;
  lastWindowCompletedAt?: string | null;
  rollingHourRequests?: number;
}

export class PostgresExternalImageEgressGate implements AdaptiveEgressGate {
  readonly #pool: Pool;
  readonly #log: Logger;
  readonly #policy: AdaptiveEgressPolicy;
  readonly #globalMinIntervalMs: number;
  #latest: ExternalImageHostSnapshot | null = null;
  readonly #hosts = new Map<string, ExternalImageHostSnapshot>();
  #permits = 0;
  #totalDelayMs = 0;
  #transitionsObserved = 0;

  constructor(
    databaseUrl: string,
    opts: { logger?: Logger; policy?: AdaptiveEgressPolicy; globalMinIntervalMs?: number } = {},
  ) {
    if (databaseUrl.trim() === '') throw new Error('站外图片出口控制器需要 v2 DATABASE_URL');
    this.#pool = createPool(databaseUrl, { max: 2 });
    this.#log = opts.logger ?? createLogger('external-image-egress');
    this.#policy = opts.policy ?? EXTERNAL_IMAGE_EGRESS_POLICY;
    this.#globalMinIntervalMs = Math.max(
      GLOBAL_BASE_INTERVAL_MS,
      Math.floor(opts.globalMinIntervalMs ?? GLOBAL_BASE_INTERVAL_MS),
    );
  }

  async beforeAttempt(url?: string, signal?: AbortSignal): Promise<AdaptiveEgressPermit> {
    const host = externalHostname(url);
    try {
      throwIfAborted(signal);
      const reservation = await withTransaction(
        this.#pool,
        `external-image-egress:permit:${host}`,
        async (db) => {
          await lockControl(db, signal);
          const nowMs = await databaseClock(db);
          const bucketStart = new Date(Math.floor(nowMs / 60_000) * 60_000).toISOString();
          await ensureHost(db, host, this.#policy);
          let row = await loadHost(db, host);
          const global = await loadGlobal(db);
          const grantMs = Math.max(
            nowMs,
            Date.parse(row.next_permit_at),
            Date.parse(global.next_permit_at),
          );
          const waitMs = Math.max(0, grantMs - nowMs);
          if (!Number.isFinite(waitMs)) {
            throw new Error(
              `站外图片放行时间非法 host=${row.next_permit_at} global=${global.next_permit_at}`,
            );
          }
          /*
           * 只有本轮能够实际等待并发出 HTTP 的请求才消费 permit/滚动预算。
           * host_deferred 是闸的退让结果；若先写 bucket、推进 next_permit_at 再抛出，
           * 每次重试都会为一个根本没发生的请求继续排队，最终形成数天的虚假债务。
           */
          if (waitMs > EXTERNAL_IMAGE_MAX_INLINE_WAIT_MS) {
            return {
              deferred: true as const,
              permit: null,
              waitMs,
              snapshot: rowToHostSnapshot(row, this.#policy),
              transition: null,
              globalBreached: global.budget_breached,
            };
          }
          await query(
            db,
            'external-image-egress:bucket-request',
            `INSERT INTO meta.external_image_egress_request_bucket(
               host, bucket_start, requests, updated_at
             ) VALUES ($1, $2::timestamptz, 1, clock_timestamp())
             ON CONFLICT (host, bucket_start) DO UPDATE
               SET requests = meta.external_image_egress_request_bucket.requests + 1,
                   updated_at = clock_timestamp()`,
            [host, bucketStart],
          );

          const [hostRolling, totalRolling] = await rollingCounts(
            db,
            host,
            this.#policy.rollingBudgetMinutes,
          );
          const budget = evaluateRollingBudget(
            rowToState(row),
            hostRolling,
            nowMs,
            this.#policy,
          );
          if (budget.transition !== null) {
            await insertAlert(db, host, budget.transition, hostRolling, this.#policy, 'budget_breach');
          }

          const globalBreached = totalRolling > EXTERNAL_IMAGE_GLOBAL_HOURLY_BUDGET;
          const hostTier = policyTier(this.#policy, budget.state.level);
          const globalInterval = globalBreached
            ? GLOBAL_BUDGET_BREACH_INTERVAL_MS
            : this.#globalMinIntervalMs;
          row = await updateHost(
            db,
            row,
            budget.state,
            {
              nextPermitAt: toPgTimestamptz(grantMs + hostTier.minIntervalMs),
              rollingHourRequests: hostRolling,
            },
            this.#policy,
          );
          const shouldPrune = nowMs - Date.parse(global.last_pruned_at) >= 60 * 60_000;
          await query(
            db,
            'external-image-egress:update-global',
            `UPDATE meta.external_image_egress_global
                SET next_permit_at = $1::timestamptz,
                    rolling_hour_requests = $2,
                    budget_limit = $3,
                    budget_breached = $4,
                    last_pruned_at = CASE WHEN $5::boolean THEN clock_timestamp() ELSE last_pruned_at END,
                    updated_at = clock_timestamp()
              WHERE singleton`,
            [
              toPgTimestamptz(grantMs + globalInterval),
              totalRolling,
              EXTERNAL_IMAGE_GLOBAL_HOURLY_BUDGET,
              globalBreached,
              shouldPrune,
            ],
          );
          if (shouldPrune) {
            await query(
              db,
              'external-image-egress:prune-buckets',
              `DELETE FROM meta.external_image_egress_request_bucket
                WHERE bucket_start < clock_timestamp() - interval '48 hours'`,
            );
          }
          return {
            deferred: false as const,
            permit: {
              bucketStart,
              channel: 'external-image',
              grantAt: toPgTimestamptz(grantMs),
              scopeKey: host,
            },
            waitMs,
            snapshot: rowToHostSnapshot(row, this.#policy),
            transition: budget.transition,
            globalBreached,
          };
        },
      );
      this.#recordSnapshot(reservation.snapshot);
      /*
       * 等待必须有上限，否则一个被降档的主机会拖垮整轮。
       *
       * 事故：images-wixmp-….wixmp.com 降到 level 3、next_permit_at 排到 20 分钟后，
       * worker 认领到该主机的任务后就在这里无限期 sleep，最终被 systemd 以
       * TimeoutStartSec 杀死（result=timeout）——整轮进度作废，且日志在
       * 「client 就绪」之后毫无输出，看起来像卡死在网络上。
       * 把单轮预算从 420 降到 300 秒毫无效果，因为阻塞根本不在预算的检查点上。
       *
       * 按主机限速是对的，等待方式错了：应当放弃该任务留给下轮，
       * 让 worker 去处理其它主机——队列里还有两万多个别的主机的任务。
       */
      if (reservation.deferred) {
        this.#log.info('主机放行时间过远，跳过本轮改由后续轮次处理', {
          host,
          waitMs: reservation.waitMs,
          maxInlineWaitMs: EXTERNAL_IMAGE_MAX_INLINE_WAIT_MS,
        });
        throw new ExternalHostDeferredError(host, reservation.waitMs);
      }
      this.#permits++;
      this.#totalDelayMs += reservation.waitMs;
      if (reservation.transition !== null) this.#transitionsObserved++;
      if (reservation.globalBreached) {
        this.#log.warn('站外图片滚动总量越界，aggregate pace 已进入保护档', {
          limit: EXTERNAL_IMAGE_GLOBAL_HOURLY_BUDGET,
        });
      }
      if (reservation.waitMs > 0) await abortableSleep(reservation.waitMs, signal);
      return reservation.permit;
    } catch (error) {
      if (isRuntimeBudgetExceededError(error)) throw error;
      if (error instanceof AdaptiveEgressUnavailableError) throw error;
      // 主动跳过是**限速层的正常输出**，不是「限速层不可用」；
      // 包装成 AdaptiveEgressUnavailableError 会让上层认不出来，落成 unknown 失败。
      if (error instanceof ExternalHostDeferredError) throw error;
      throw new AdaptiveEgressUnavailableError(`external-image beforeAttempt(${host})`, error);
    }
  }

  async afterAttempt(
    permit: AdaptiveEgressPermit,
    outcome: AdaptiveAttemptOutcome,
    signal?: AbortSignal,
  ): Promise<void> {
    const host = permit.scopeKey;
    if (host === undefined) throw new Error('站外图片 permit 缺 scopeKey(host)');
    try {
      throwIfAborted(signal);
      const result = await withTransaction(
        this.#pool,
        `external-image-egress:outcome:${host}`,
        async (db) => {
          await lockControl(db, signal);
          const nowMs = await databaseClock(db);
          const pressureFailure = !outcome.ok && isAdaptivePressureFailure(outcome.status);
          if (pressureFailure) {
            const category = pressureCategory(outcome.status);
            const updated = await query(
              db,
              'external-image-egress:bucket-failure',
              `UPDATE meta.external_image_egress_request_bucket
                  SET failures = failures + 1,
                      status_429 = status_429 + $3::int,
                      status_503 = status_503 + $4::int,
                      other_5xx = other_5xx + $5::int,
                      transport_failures = transport_failures + $6::int,
                      updated_at = clock_timestamp()
                WHERE host = $1 AND bucket_start = $2::timestamptz
                  AND failures < requests`,
              [
                host,
                permit.bucketStart,
                category === '429' ? 1 : 0,
                category === '503' ? 1 : 0,
                category === 'other_5xx' ? 1 : 0,
                category === 'transport' ? 1 : 0,
              ],
            );
            if (updated.rowCount !== 1) {
              throw new Error(`找不到或已结算站外图片 permit ${host}/${permit.bucketStart}`);
            }
          }

          let row = await loadHost(db, host);
          const requests = row.current_window_requests + 1;
          const failures = row.current_window_failures + (pressureFailure ? 1 : 0);
          let state = rowToState(row);
          let transition: AdaptiveEgressTransition | null = null;
          let alertKind: ExternalAlertKind = 'failure_backoff';
          const immediate = evaluateExternalRateLimitSignal(
            state,
            outcome.status,
            nowMs,
            this.#policy,
          );
          state = immediate.state;
          transition = immediate.transition;
          if (transition !== null) alertKind = 'rate_limit_backoff';

          let nextRequests = requests;
          let nextFailures = failures;
          let lastRate = row.last_window_failure_rate;
          let lastCompletedAt = row.last_window_completed_at;
          if (requests === this.#policy.windowRequests) {
            // 同一 429/503 outcome 最多降一级；该窗口仍结账，但不再消费第二次降档。
            if (transition === null) {
              const decision = evaluateFailureWindow(
                state,
                { requests, failures, completedAtMs: nowMs },
                this.#policy,
              );
              state = decision.state;
              transition = decision.transition;
            }
            lastRate = failures / requests;
            lastCompletedAt = toPgTimestamptz(nowMs);
            nextRequests = 0;
            nextFailures = 0;
          } else if (requests > this.#policy.windowRequests) {
            throw new Error(`站外图片反馈窗口越界 ${requests}/${this.#policy.windowRequests}`);
          }

          if (transition !== null) {
            await insertAlert(
              db,
              host,
              transition,
              row.rolling_hour_requests,
              this.#policy,
              alertKind,
            );
          }
          const newTier = policyTier(this.#policy, state.level);
          const currentNext = Date.parse(row.next_permit_at);
          const minimumNext = (outcome.status === 429 || outcome.status === 503)
            ? nowMs + newTier.minIntervalMs
            : currentNext;
          row = await updateHost(
            db,
            row,
            state,
            {
              nextPermitAt: toPgTimestamptz(Math.max(currentNext, minimumNext)),
              currentWindowRequests: nextRequests,
              currentWindowFailures: nextFailures,
              lastWindowFailureRate: lastRate,
              lastWindowCompletedAt: lastCompletedAt,
            },
            this.#policy,
          );
          return {
            snapshot: rowToHostSnapshot(row, this.#policy),
            transition,
          };
        },
      );
      this.#recordSnapshot(result.snapshot);
      if (result.transition !== null) {
        this.#transitionsObserved++;
        this.#log.warn('站外图片主机出口档位变化', {
          host,
          transition: result.transition,
          state: result.snapshot,
          noQqDelivery: true,
        });
      }
    } catch (error) {
      if (isRuntimeBudgetExceededError(error)) throw error;
      if (error instanceof AdaptiveEgressUnavailableError) throw error;
      throw new AdaptiveEgressUnavailableError(`external-image afterAttempt(${host})`, error);
    }
  }

  stats(): AdaptiveEgressRuntimeStats {
    return {
      channel: 'external-image',
      permits: this.#permits,
      totalDelayMs: this.#totalDelayMs,
      transitionsObserved: this.#transitionsObserved,
      state: this.#latest === null ? null : asAdaptiveSnapshot(this.#latest, this.#policy),
    };
  }

  hostSnapshots(): Record<string, ExternalImageHostSnapshot> {
    return Object.fromEntries([...this.#hosts.entries()].sort(([a], [b]) => a.localeCompare(b)));
  }

  async close(): Promise<void> {
    await this.#pool.end().catch(() => undefined);
  }

  #recordSnapshot(snapshot: ExternalImageHostSnapshot): void {
    this.#latest = snapshot;
    this.#hosts.set(snapshot.host, snapshot);
  }
}

type ExternalAlertKind = 'rate_limit_backoff' | 'failure_backoff' | 'budget_breach' | 'recovery';

function externalHostname(url: string | undefined): string {
  if (url === undefined) throw new Error('站外图片出口控制器需要 request URL');
  const host = new URL(url).hostname.toLowerCase();
  if (host === '' || host.length > 253) throw new Error(`非法站外图片 host ${host}`);
  return host;
}

function pressureCategory(status: number | null): '429' | '503' | 'other_5xx' | 'transport' {
  if (status === 429) return '429';
  if (status === 503) return '503';
  if (status === null) return 'transport';
  return 'other_5xx';
}

async function lockControl(db: PoolClient, signal?: AbortSignal): Promise<void> {
  if (signal === undefined) {
    await query(db, 'external-image-egress:lock', 'SELECT pg_advisory_xact_lock($1)', [CONTROL_LOCK_ID]);
    return;
  }
  for (;;) {
    throwIfAborted(signal);
    const locked = await query<{ locked: boolean }>(
      db,
      'external-image-egress:try-lock',
      `SELECT pg_try_advisory_xact_lock($1) AS locked`,
      [CONTROL_LOCK_ID],
    );
    if (locked.rows[0]?.locked === true) return;
    await abortableSleep(25, signal);
  }
}

async function databaseClock(db: PoolClient): Promise<number> {
  const result = await query<{ now_ms: string }>(
    db,
    'external-image-egress:clock',
    `SELECT (extract(epoch FROM clock_timestamp()) * 1000)::text AS now_ms`,
  );
  const nowMs = Number(result.rows[0]?.now_ms);
  if (!Number.isFinite(nowMs)) throw new Error('数据库时钟读取失败');
  return nowMs;
}

async function ensureHost(
  db: PoolClient,
  host: string,
  policy: AdaptiveEgressPolicy,
): Promise<void> {
  await query(
    db,
    'external-image-egress:ensure-host',
    `INSERT INTO meta.external_image_egress_control(host, budget_limit, policy)
     VALUES ($1, $2, jsonb_build_object(
       'window_requests', $3::int,
       'elevated_failure_rate', $4::real,
       'severe_failure_rate', $5::real,
       'healthy_failure_rate', $6::real,
       'healthy_windows_to_recover', $7::int,
       'exact_hostname', true,
       'no_wikidot_budget_sharing', true
     ))
     ON CONFLICT (host) DO UPDATE
       SET budget_limit = EXCLUDED.budget_limit,
           policy = EXCLUDED.policy,
           updated_at = clock_timestamp()`,
    [
      host,
      policy.rollingBudgetRequests,
      policy.windowRequests,
      policy.elevatedFailureRate,
      policy.severeFailureRate,
      policy.healthyFailureRate,
      policy.healthyWindowsToRecover,
    ],
  );
}

async function loadHost(db: PoolClient, host: string): Promise<HostControlRow> {
  const result = await query<HostControlRow>(
    db,
    'external-image-egress:load-host',
    `SELECT host, level, reason, changed_at::text, recover_not_before::text,
            next_permit_at::text, current_window_requests, current_window_failures,
            elevated_windows, healthy_windows, last_window_failure_rate,
            last_window_completed_at::text, rolling_hour_requests, budget_limit,
            budget_breached, updated_at::text
       FROM meta.external_image_egress_control
      WHERE host = $1
      FOR UPDATE`,
    [host],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error(`站外图片出口缺 host=${host}`);
  return row;
}

async function loadGlobal(db: PoolClient): Promise<GlobalControlRow> {
  const result = await query<GlobalControlRow>(
    db,
    'external-image-egress:load-global',
    `SELECT next_permit_at::text, rolling_hour_requests, budget_limit,
            budget_breached, last_pruned_at::text
       FROM meta.external_image_egress_global
      WHERE singleton
      FOR UPDATE`,
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('站外图片 global 单例缺失（0057 未迁移）');
  return row;
}

async function rollingCounts(
  db: PoolClient,
  host: string,
  minutes: number,
): Promise<[number, number]> {
  const result = await query<{ host_requests: string; total_requests: string }>(
    db,
    'external-image-egress:rolling-counts',
    `SELECT coalesce(sum(requests) FILTER (WHERE host = $1), 0)::text AS host_requests,
            coalesce(sum(requests), 0)::text AS total_requests
       FROM meta.external_image_egress_request_bucket
      WHERE bucket_start >= date_trunc('minute', clock_timestamp())
                              - ($2::int - 1) * interval '1 minute'`,
    [host, minutes],
  );
  const hostRequests = Number(result.rows[0]?.host_requests ?? '0');
  const totalRequests = Number(result.rows[0]?.total_requests ?? '0');
  if (!Number.isInteger(hostRequests) || !Number.isInteger(totalRequests)) {
    throw new Error(`非法站外图片滚动计数 host=${hostRequests} total=${totalRequests}`);
  }
  return [hostRequests, totalRequests];
}

async function updateHost(
  db: PoolClient,
  old: HostControlRow,
  state: FailureWindowState,
  update: HostControlUpdate,
  policy: AdaptiveEgressPolicy,
): Promise<HostControlRow> {
  const result = await query<HostControlRow>(
    db,
    'external-image-egress:update-host',
    `UPDATE meta.external_image_egress_control
        SET level = $2, reason = $3, changed_at = $4::timestamptz,
            recover_not_before = $5::timestamptz, next_permit_at = $6::timestamptz,
            current_window_requests = $7, current_window_failures = $8,
            elevated_windows = $9, healthy_windows = $10,
            last_window_failure_rate = $11,
            last_window_completed_at = $12::timestamptz,
            rolling_hour_requests = $13, budget_limit = $14,
            budget_breached = $15, updated_at = clock_timestamp()
      WHERE host = $1
      RETURNING host, level, reason, changed_at::text, recover_not_before::text,
                next_permit_at::text, current_window_requests, current_window_failures,
                elevated_windows, healthy_windows, last_window_failure_rate,
                last_window_completed_at::text, rolling_hour_requests, budget_limit,
                budget_breached, updated_at::text`,
    [
      old.host,
      state.level,
      state.reason,
      toPgTimestamptz(state.changedAtMs),
      state.recoverNotBeforeMs === null ? null : toPgTimestamptz(state.recoverNotBeforeMs),
      update.nextPermitAt ?? old.next_permit_at,
      update.currentWindowRequests ?? old.current_window_requests,
      update.currentWindowFailures ?? old.current_window_failures,
      state.elevatedWindows,
      state.healthyWindows,
      update.lastWindowFailureRate === undefined
        ? old.last_window_failure_rate
        : update.lastWindowFailureRate,
      update.lastWindowCompletedAt === undefined
        ? old.last_window_completed_at
        : update.lastWindowCompletedAt,
      update.rollingHourRequests ?? old.rolling_hour_requests,
      policy.rollingBudgetRequests,
      state.budgetBreached,
    ],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error(`站外图片出口更新 host=${old.host} 未返回行`);
  return row;
}

async function insertAlert(
  db: PoolClient,
  host: string,
  transition: AdaptiveEgressTransition,
  rollingHourRequests: number,
  policy: AdaptiveEgressPolicy,
  kind: ExternalAlertKind,
): Promise<void> {
  const actualKind: ExternalAlertKind = transition.kind === 'recovery' ? 'recovery' : kind;
  await query(
    db,
    'external-image-egress:insert-alert',
    `INSERT INTO meta.external_image_egress_alert(
       host, kind, from_level, to_level, reason,
       rolling_hour_requests, failure_rate, details
     ) VALUES ($1, $2, $3, $4, $5, $6, $7,
       jsonb_build_object(
         'window_requests', $8::int,
         'healthy_windows_required', $9::int,
         'exact_hostname', true,
         'no_qq_delivery', true,
         'wikidot_budget_affected', false
       ))`,
    [
      host,
      actualKind,
      transition.fromLevel,
      transition.toLevel,
      transition.reason,
      transition.rollingHourRequests ?? rollingHourRequests,
      transition.failureRate,
      policy.windowRequests,
      policy.healthyWindowsToRecover,
    ],
  );
}

function rowToState(row: HostControlRow): FailureWindowState {
  return {
    level: asLevel(row.level),
    reason: row.reason,
    changedAtMs: Date.parse(row.changed_at),
    recoverNotBeforeMs: row.recover_not_before === null ? null : Date.parse(row.recover_not_before),
    elevatedWindows: row.elevated_windows,
    healthyWindows: row.healthy_windows,
    budgetBreached: row.budget_breached,
  };
}

function rowToHostSnapshot(
  row: HostControlRow,
  policy: AdaptiveEgressPolicy,
): ExternalImageHostSnapshot {
  const level = asLevel(row.level);
  const tier = policyTier(policy, level);
  return {
    host: row.host,
    level,
    levelName: tier.name,
    minRequestIntervalMs: tier.minIntervalMs,
    reason: row.reason,
    recoverNotBefore: row.recover_not_before === null
      ? null
      : new Date(row.recover_not_before).toISOString(),
    rollingHourRequests: row.rolling_hour_requests,
    budgetLimit: row.budget_limit,
    budgetBreached: row.budget_breached,
    currentWindowRequests: row.current_window_requests,
    currentWindowFailures: row.current_window_failures,
    lastWindowFailureRate: row.last_window_failure_rate,
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function asAdaptiveSnapshot(
  snapshot: ExternalImageHostSnapshot,
  policy: AdaptiveEgressPolicy,
): AdaptiveEgressSnapshot {
  return {
    siteKey: `external-image:${snapshot.host}`,
    level: snapshot.level,
    levelName: policyTier(policy, snapshot.level).name,
    minRequestIntervalMs: snapshot.minRequestIntervalMs,
    reason: snapshot.reason,
    changedAt: snapshot.updatedAt,
    recoverNotBefore: snapshot.recoverNotBefore,
    pressureLevel: snapshot.level,
    pressureReason: snapshot.reason,
    pressureChangedAt: snapshot.updatedAt,
    pressureRecoverNotBefore: snapshot.recoverNotBefore,
    budgetLevel: snapshot.budgetBreached ? 1 : 0,
    budgetReason: snapshot.budgetBreached ? snapshot.reason : 'within_host_budget',
    budgetChangedAt: snapshot.updatedAt,
    budgetMinRequestIntervalMs: snapshot.minRequestIntervalMs,
    budgetThrottleRatio: snapshot.budgetBreached
      ? Math.min(1, snapshot.budgetLimit / Math.max(1, snapshot.rollingHourRequests))
      : 1,
    currentWindowRequests: snapshot.currentWindowRequests,
    currentWindowFailures: snapshot.currentWindowFailures,
    currentWindowConnectionFailures: 0,
    currentWindowDeterministicFailures: 0,
    connectionFailureStreak: 0,
    lastConnectionFailureAt: null,
    lastConnectionBackoffAt: null,
    elevatedWindows: 0,
    healthyWindows: 0,
    healthyWindowsRequired: policy.healthyWindowsToRecover,
    recoveryWindowMinutes: Math.round(policy.recoveryWindowMs / 60_000),
    recoveryWindowStartedAt: null,
    recoveryWindowRequests: 0,
    recoveryWindowFailures: 0,
    lastWindowFailureRate: snapshot.lastWindowFailureRate,
    lastWindowConnectionFailureRate: null,
    lastWindowDeterministicFailureRate: null,
    lastWindowCompletedAt: null,
    rollingHourRequests: snapshot.rollingHourRequests,
    budgetLimit: snapshot.budgetLimit,
    budgetBreached: snapshot.budgetBreached,
    l1LastStartedAt: null,
    l1SloDegradedSince: null,
    l1SloExpectedRecoveryAt: null,
    l1SloLastGapSeconds: null,
    l1SloOverdue: false,
    updatedAt: snapshot.updatedAt,
  };
}

function policyTier(policy: AdaptiveEgressPolicy, level: AdaptiveEgressLevel) {
  const tier = policy.tiers.find((candidate) => candidate.level === level);
  if (tier === undefined) throw new Error(`站外图片策略缺 level=${level}`);
  return tier;
}

function asLevel(value: number): AdaptiveEgressLevel {
  if (value !== 0 && value !== 1 && value !== 2 && value !== 3) {
    throw new Error(`非法站外图片出口 level=${value}`);
  }
  return value;
}
