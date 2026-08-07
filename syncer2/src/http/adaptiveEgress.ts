/**
 * Wikidot 全站共享的自适应出口控制器。
 *
 * L0/L1/Tier2/sitemap 都是独立短进程，却共用同一代理入口与站点配额。任何只放在
 * HttpClient 内存里的反馈环都会漏掉其它进程，所以每个真实 HTTP attempt 都通过
 * meta.egress_control 的同一把事务 advisory lock 预留 permit，并把结果汇入同一个
 * 100-request 反馈窗口。
 *
 * 设计标定来自两组实测：2026-08-02 的安全水位 <1%、危险区 22.6%（随后 78.5%），
 * 以及 2026-08-07 剔除既有分类确认的确定性失败后约 0.76% 的常态压力噪声。因此：
 *   * 5% 连续两个窗口才退让，10% 单窗口立即退让，仍早于 22.6% 拒绝区；
 *   * 恢复需连续 6 个 <=3% 窗口并满足最低保持期，健康窗可在保持期内累计；
 *   * identity_absent 等既有分类可把伪装成 5xx 的确定性失败改记审计；
 *     no_permission / structural 等业务结果本来就不进站点压力分子；
 *   * 滚动 60 分钟 >3,500 attempt 无条件进入 0.125 QPS cooldown；该值仍低于
 *     实测最低安全水位 3,663/h；
 *   * 全站档位保持共享；通道只分账，不允许因共享 IP/站点而各自解除全局保护。
 */

import type { Pool, PoolClient, QueryResultRow } from 'pg';
import { createPool, query, toPgTimestamptz, withTransaction } from '../store/db.js';
import { createLogger, type Logger } from '../util/log.js';

export type AdaptiveEgressLevel = 0 | 1 | 2 | 3;

export interface AdaptiveEgressTier {
  level: AdaptiveEgressLevel;
  name: 'normal' | 'cautious' | 'protective' | 'cooldown';
  minIntervalMs: number;
  minimumHoldMs: number;
}

export interface AdaptiveEgressPolicy {
  windowRequests: number;
  elevatedFailureRate: number;
  severeFailureRate: number;
  healthyFailureRate: number;
  elevatedWindowsToBackoff: number;
  healthyWindowsToRecover: number;
  rollingBudgetMinutes: number;
  rollingBudgetRequests: number;
  tiers: readonly AdaptiveEgressTier[];
}

export const ADAPTIVE_EGRESS_POLICY: AdaptiveEgressPolicy = Object.freeze({
  windowRequests: 100,
  elevatedFailureRate: 0.05,
  severeFailureRate: 0.1,
  healthyFailureRate: 0.03,
  elevatedWindowsToBackoff: 2,
  healthyWindowsToRecover: 6,
  rollingBudgetMinutes: 60,
  rollingBudgetRequests: 3_500,
  tiers: Object.freeze([
    { level: 0, name: 'normal', minIntervalMs: 333, minimumHoldMs: 0 },
    { level: 1, name: 'cautious', minIntervalMs: 667, minimumHoldMs: 30 * 60_000 },
    { level: 2, name: 'protective', minIntervalMs: 2_000, minimumHoldMs: 45 * 60_000 },
    { level: 3, name: 'cooldown', minIntervalMs: 8_000, minimumHoldMs: 60 * 60_000 },
  ] satisfies AdaptiveEgressTier[]),
});

export interface FailureWindowState {
  level: AdaptiveEgressLevel;
  reason: string;
  changedAtMs: number;
  recoverNotBeforeMs: number | null;
  elevatedWindows: number;
  healthyWindows: number;
  budgetBreached: boolean;
}

export interface CompletedFailureWindow {
  requests: number;
  /** 只有站点容量/传输信号进入此分子。 */
  failures: number;
  /** 既有业务分类确认的确定性失败；保留在总请求分母与审计中。 */
  deterministicFailures?: number;
  completedAtMs: number;
}

export type AdaptiveEgressTransitionKind =
  | 'failure_backoff'
  | 'budget_breach'
  | 'recovery';

export interface AdaptiveEgressTransition {
  kind: AdaptiveEgressTransitionKind;
  fromLevel: AdaptiveEgressLevel;
  toLevel: AdaptiveEgressLevel;
  reason: string;
  failureRate: number | null;
  rollingHourRequests: number | null;
}

export interface FailureWindowDecision {
  state: FailureWindowState;
  transition: AdaptiveEgressTransition | null;
  failureRate: number;
}

export interface BudgetDecision {
  state: FailureWindowState;
  transition: AdaptiveEgressTransition | null;
}

/** 纯状态机：测试用合成窗口验证，不需要碰活库。 */
export function evaluateFailureWindow(
  input: FailureWindowState,
  window: CompletedFailureWindow,
  policy: AdaptiveEgressPolicy = ADAPTIVE_EGRESS_POLICY,
): FailureWindowDecision {
  if (window.requests !== policy.windowRequests) {
    throw new RangeError(
      `反馈窗口必须恰好 ${policy.windowRequests} requests，收到 ${window.requests}`,
    );
  }
  if (window.failures < 0 || window.failures > window.requests) {
    throw new RangeError(`非法 failures=${window.failures}/${window.requests}`);
  }
  const deterministicFailures = window.deterministicFailures ?? 0;
  if (
    deterministicFailures < 0
    || window.failures + deterministicFailures > window.requests
  ) {
    throw new RangeError(
      `非法 deterministicFailures=${deterministicFailures}/${window.requests}`,
    );
  }

  const rate = window.failures / window.requests;
  const severe = rate >= policy.severeFailureRate;
  const elevated = rate >= policy.elevatedFailureRate;
  const elevatedWindows = elevated ? input.elevatedWindows + 1 : 0;
  const trend = elevatedWindows >= policy.elevatedWindowsToBackoff;

  if ((severe || trend) && input.level < 3) {
    const toLevel = (input.level + 1) as AdaptiveEgressLevel;
    const reason = severe
      ? `failure_rate_${formatRate(rate)}_gte_${formatRate(policy.severeFailureRate)}_single_window`
      : `failure_rate_${formatRate(rate)}_gte_${formatRate(policy.elevatedFailureRate)}_for_${elevatedWindows}_windows`;
    const next = downshiftState(input, toLevel, reason, window.completedAtMs, policy);
    return {
      state: next,
      transition: {
        kind: 'failure_backoff',
        fromLevel: input.level,
        toLevel,
        reason,
        failureRate: rate,
        rollingHourRequests: null,
      },
      failureRate: rate,
    };
  }

  // 已在最慢档时仍失败，或普通退让档出现任一 >3% 的不健康窗口：从“最后一次坏窗口”
  // 重新开始最低冷却。这样踩线后的持续失败不会周期性试探升档。
  if (input.level > 0 && rate > policy.healthyFailureRate) {
    const holdMs = tier(policy, input.level).minimumHoldMs;
    return {
      state: {
        ...input,
        recoverNotBeforeMs: Math.max(
          input.recoverNotBeforeMs ?? 0,
          window.completedAtMs + holdMs,
        ),
        elevatedWindows,
        healthyWindows: 0,
      },
      transition: null,
      failureRate: rate,
    };
  }

  if (input.level === 0) {
    return {
      state: { ...input, elevatedWindows, healthyWindows: 0 },
      transition: null,
      failureRate: rate,
    };
  }

  // 好窗口从降档后即可累计，但恢复必须同时满足“连续 6 窗”和最低保持期。
  // 这保留恢复慢于降档的迟滞，同时不再把保持期内的健康证据全部丢弃。
  const healthyWindows = Math.min(
    input.healthyWindows + 1,
    policy.healthyWindowsToRecover,
  );
  const holdComplete = input.recoverNotBeforeMs === null
    || window.completedAtMs >= input.recoverNotBeforeMs;
  if (healthyWindows < policy.healthyWindowsToRecover || !holdComplete) {
    return {
      state: { ...input, elevatedWindows, healthyWindows },
      transition: null,
      failureRate: rate,
    };
  }

  const toLevel = (input.level - 1) as AdaptiveEgressLevel;
  const reason = `recovered_after_${healthyWindows}_healthy_windows_lte_${formatRate(policy.healthyFailureRate)}`;
  const nextHold = toLevel === 0 ? null : window.completedAtMs + tier(policy, toLevel).minimumHoldMs;
  return {
    state: {
      ...input,
      level: toLevel,
      reason,
      changedAtMs: window.completedAtMs,
      recoverNotBeforeMs: nextHold,
      elevatedWindows: 0,
      healthyWindows: 0,
    },
    transition: {
      kind: 'recovery',
      fromLevel: input.level,
      toLevel,
      reason,
      failureRate: rate,
      rollingHourRequests: null,
    },
    failureRate: rate,
  };
}

/** 纯预算护栏：超过而不是等于 3,500，立即强制最慢档并持久告警。 */
export function evaluateRollingBudget(
  input: FailureWindowState,
  rollingHourRequests: number,
  atMs: number,
  policy: AdaptiveEgressPolicy = ADAPTIVE_EGRESS_POLICY,
): BudgetDecision {
  if (!Number.isInteger(rollingHourRequests) || rollingHourRequests < 0) {
    throw new RangeError(`非法滚动小时请求数 ${rollingHourRequests}`);
  }
  if (rollingHourRequests <= policy.rollingBudgetRequests) {
    return {
      state: input.budgetBreached ? { ...input, budgetBreached: false } : input,
      transition: null,
    };
  }

  const reason = `rolling_${policy.rollingBudgetMinutes}m_requests_${rollingHourRequests}_gt_${policy.rollingBudgetRequests}`;
  const holdUntil = atMs + tier(policy, 3).minimumHoldMs;
  const firstBreach = !input.budgetBreached;
  const next: FailureWindowState = {
    ...input,
    level: 3,
    reason,
    changedAtMs: input.level === 3 ? input.changedAtMs : atMs,
    recoverNotBeforeMs: Math.max(input.recoverNotBeforeMs ?? 0, holdUntil),
    elevatedWindows: 0,
    healthyWindows: 0,
    budgetBreached: true,
  };
  return {
    state: next,
    transition: firstBreach
      ? {
          kind: 'budget_breach',
          fromLevel: input.level,
          toLevel: 3,
          reason,
          failureRate: null,
          rollingHourRequests,
        }
      : null,
  };
}

export interface AdaptiveEgressSnapshot {
  siteKey: string;
  level: AdaptiveEgressLevel;
  levelName: AdaptiveEgressTier['name'];
  minRequestIntervalMs: number;
  reason: string;
  changedAt: string;
  recoverNotBefore: string | null;
  currentWindowRequests: number;
  /** 站点压力分子：transport / 429 / 5xx，已排除确定性业务失败。 */
  currentWindowFailures: number;
  currentWindowDeterministicFailures: number;
  elevatedWindows: number;
  healthyWindows: number;
  healthyWindowsRequired: number;
  lastWindowFailureRate: number | null;
  lastWindowDeterministicFailureRate: number | null;
  lastWindowCompletedAt: string | null;
  rollingHourRequests: number;
  budgetLimit: number;
  budgetBreached: boolean;
  l1LastStartedAt: string | null;
  l1SloDegradedSince: string | null;
  l1SloExpectedRecoveryAt: string | null;
  l1SloLastGapSeconds: number | null;
  l1SloOverdue: boolean;
  updatedAt: string;
}

export interface AdaptiveSelfProtectionDecision {
  status: 'normal' | 'downshift_expected' | 'downshift_overdue';
  active: boolean;
  overdue: boolean;
  exitCode: 0 | 1;
  level: AdaptiveEgressLevel;
  levelName: AdaptiveEgressTier['name'];
  reason: string;
  recoverNotBefore: string | null;
  expectedRecoveryAt: string | null;
}

/**
 * 把“护栏正在按设计限速”与“恢复状态机失效”分开。预计时间覆盖当前档及逐档恢复所需
 * 的健康窗口；recover_not_before 被后续坏窗口延长时，截止时间同步后移。
 */
export function evaluateAdaptiveSelfProtection(
  snapshot: AdaptiveEgressSnapshot,
  nowMs: number,
  policy: AdaptiveEgressPolicy = ADAPTIVE_EGRESS_POLICY,
): AdaptiveSelfProtectionDecision {
  if (!Number.isFinite(nowMs)) throw new RangeError(`非法 self-protection now=${nowMs}`);
  if (snapshot.level === 0) {
    return {
      status: 'normal', active: false, overdue: false, exitCode: 0,
      level: snapshot.level, levelName: snapshot.levelName, reason: snapshot.reason,
      recoverNotBefore: snapshot.recoverNotBefore, expectedRecoveryAt: null,
    };
  }
  const changedAtMs = Date.parse(snapshot.changedAt);
  const holdUntilMs = snapshot.recoverNotBefore === null
    ? changedAtMs
    : Date.parse(snapshot.recoverNotBefore);
  if (!Number.isFinite(changedAtMs) || !Number.isFinite(holdUntilMs)) {
    throw new RangeError('自适应出口快照含非法 changedAt/recoverNotBefore');
  }
  const currentTier = tier(policy, snapshot.level);
  const currentHealthyEvidenceMs =
    policy.windowRequests * policy.healthyWindowsToRecover * currentTier.minIntervalMs;
  let lowerTierRecoveryMs = 0;
  for (let level = snapshot.level - 1; level > 0; level--) {
    const selected = tier(policy, level as AdaptiveEgressLevel);
    lowerTierRecoveryMs += Math.max(
      selected.minimumHoldMs,
      policy.windowRequests * policy.healthyWindowsToRecover * selected.minIntervalMs,
    );
  }
  const currentEvidenceStartedAtMs = Math.max(
    changedAtMs,
    holdUntilMs - currentTier.minimumHoldMs,
  );
  const expectedRecoveryAtMs = Math.max(
    changedAtMs + expectedFullRecoveryDurationMs(snapshot.level, policy),
    Math.max(
      holdUntilMs,
      currentEvidenceStartedAtMs + currentHealthyEvidenceMs,
    ) + lowerTierRecoveryMs,
  );
  const overdue = nowMs > expectedRecoveryAtMs;
  return {
    status: overdue ? 'downshift_overdue' : 'downshift_expected',
    active: true,
    overdue,
    exitCode: overdue ? 1 : 0,
    level: snapshot.level,
    levelName: snapshot.levelName,
    reason: snapshot.reason,
    recoverNotBefore: snapshot.recoverNotBefore,
    expectedRecoveryAt: toPgTimestamptz(expectedRecoveryAtMs),
  };
}

export interface AdaptiveEgressPermit {
  bucketStart: string;
  channel: string;
  grantAt: string;
}

export interface AdaptiveAttemptOutcome {
  /** 对站点容量反馈而言是否健康；预期 3xx/4xx（429 除外）不冒充限流失败。 */
  ok: boolean;
  status: number | null;
  errorKind: string | null;
  /**
   * 只能由既有业务失败分类填写。非 null 表示该 attempt 虽在 HTTP 层像压力失败，
   * 但已确认重试不会改变且不代表站点拒绝；它会单独留账而不进入压力分子。
   */
  deterministicFailureClass?: string | null;
}

/**
 * 反馈环只吃“容量/传输失败”：无响应、429、5xx。404 等业务结果证明站点正常响应，
 * 若把删除页 404 混进失败率，会让 identity/backfill 的正常业务形状误触发全站退让。
 */
export function isAdaptivePressureFailure(status: number | null): boolean {
  return status === null || status === 429 || status >= 500;
}

export interface AdaptiveEgressRuntimeStats {
  channel: string;
  permits: number;
  totalDelayMs: number;
  transitionsObserved: number;
  state: AdaptiveEgressSnapshot | null;
}

export interface AdaptiveEgressGate {
  beforeAttempt(): Promise<AdaptiveEgressPermit>;
  afterAttempt(permit: AdaptiveEgressPermit, outcome: AdaptiveAttemptOutcome): Promise<void>;
  stats(): AdaptiveEgressRuntimeStats;
  close(): Promise<void>;
}

export class AdaptiveEgressUnavailableError extends Error {
  override readonly name = 'AdaptiveEgressUnavailableError';
  constructor(operation: string, override readonly cause: unknown) {
    super(`全站出口安全控制器 ${operation} 失败；为避免无护栏出站，拒绝继续请求：${String(cause)}`);
  }
}

interface ControlRow extends QueryResultRow {
  site_key: string;
  level: number;
  reason: string;
  changed_at: string;
  recover_not_before: string | null;
  next_permit_at: string;
  current_window_requests: number;
  current_window_failures: number;
  current_window_deterministic_failures: number;
  elevated_windows: number;
  healthy_windows: number;
  last_window_failure_rate: number | null;
  last_window_deterministic_failure_rate: number | null;
  last_window_completed_at: string | null;
  rolling_hour_requests: number;
  budget_limit: number;
  budget_breached: boolean;
  l1_last_started_at: string | null;
  l1_slo_degraded_since: string | null;
  l1_slo_expected_recovery_at: string | null;
  l1_slo_last_gap_seconds: number | null;
  l1_slo_overdue: boolean;
  last_pruned_at: string;
  updated_at: string;
}

const SITE_KEY = 'wikidot';
const CONTROL_LOCK_ID = 2_026_080_5;

export class PostgresAdaptiveEgressGate implements AdaptiveEgressGate {
  readonly #pool: Pool;
  readonly #channel: string;
  readonly #log: Logger;
  readonly #policy: AdaptiveEgressPolicy;
  #latest: AdaptiveEgressSnapshot | null = null;
  #permits = 0;
  #totalDelayMs = 0;
  #transitionsObserved = 0;

  constructor(
    databaseUrl: string,
    channel: string,
    opts: { logger?: Logger; policy?: AdaptiveEgressPolicy } = {},
  ) {
    if (databaseUrl.trim() === '') throw new Error('自适应出口控制器需要 v2 DATABASE_URL');
    if (!/^[a-z0-9][a-z0-9:_-]{0,79}$/i.test(channel)) {
      throw new Error(`非法出口通道名 ${channel}`);
    }
    this.#pool = createPool(databaseUrl, { max: 2 });
    this.#channel = channel;
    this.#log = opts.logger ?? createLogger(`adaptive-egress:${channel}`);
    this.#policy = opts.policy ?? ADAPTIVE_EGRESS_POLICY;
  }

  async beforeAttempt(): Promise<AdaptiveEgressPermit> {
    try {
      const reservation = await withTransaction(this.#pool, 'adaptive-egress:permit', async (db) => {
        await lockControl(db);
        const clock = await databaseClock(db);
        const bucketStart = new Date(Math.floor(clock.nowMs / 60_000) * 60_000).toISOString();

        await query(
          db,
          'adaptive-egress:bucket-request',
          `INSERT INTO meta.egress_request_bucket(
             site_key, bucket_start, channel, requests, failures, updated_at
           ) VALUES ($1, $2::timestamptz, $3, 1, 0, clock_timestamp())
           ON CONFLICT (site_key, bucket_start, channel) DO UPDATE
             SET requests = meta.egress_request_bucket.requests + 1,
                 updated_at = clock_timestamp()`,
          [SITE_KEY, bucketStart, this.#channel],
        );

        let row = await loadControl(db);
        const rolling = await rollingRequestCount(db, this.#policy.rollingBudgetMinutes);
        const budget = evaluateRollingBudget(rowToWindowState(row), rolling, clock.nowMs, this.#policy);
        if (budget.transition !== null) {
          await insertAlert(db, budget.transition, rolling, this.#policy);
        }

        const current = tier(this.#policy, budget.state.level);
        const nextPermitMs = Date.parse(row.next_permit_at);
        const grantMs = Math.max(clock.nowMs, nextPermitMs);
        const nextMs = grantMs + current.minIntervalMs;
        const shouldPrune = clock.nowMs - Date.parse(row.last_pruned_at) >= 60 * 60_000;
        if (shouldPrune) {
          await query(
            db,
            'adaptive-egress:prune-buckets',
            `DELETE FROM meta.egress_request_bucket
              WHERE site_key = $1
                AND bucket_start < clock_timestamp() - interval '48 hours'`,
            [SITE_KEY],
          );
        }

        row = await updateControl(
          db,
          row,
          budget.state,
          {
            rollingHourRequests: rolling,
            nextPermitAt: toPgTimestamptz(nextMs),
            lastPrunedAt: shouldPrune ? toPgTimestamptz(clock.nowMs) : row.last_pruned_at,
          },
          this.#policy,
        );
        return {
          permit: {
            bucketStart,
            channel: this.#channel,
            grantAt: toPgTimestamptz(grantMs),
          },
          waitMs: Math.max(0, grantMs - clock.nowMs),
          snapshot: rowToSnapshot(row, this.#policy),
          transition: budget.transition,
        };
      });

      this.#latest = reservation.snapshot;
      this.#permits++;
      this.#totalDelayMs += reservation.waitMs;
      if (reservation.transition !== null) {
        this.#transitionsObserved++;
        this.#log.error('滚动小时预算越界，已强制 cooldown（持久告警已落库）', {
          transition: reservation.transition,
          state: reservation.snapshot,
        });
      }
      if (reservation.waitMs > 0) await sleep(reservation.waitMs);
      return reservation.permit;
    } catch (err) {
      if (err instanceof AdaptiveEgressUnavailableError) throw err;
      throw new AdaptiveEgressUnavailableError('beforeAttempt', err);
    }
  }

  async afterAttempt(
    permit: AdaptiveEgressPermit,
    outcome: AdaptiveAttemptOutcome,
  ): Promise<void> {
    try {
      const result = await withTransaction(this.#pool, 'adaptive-egress:outcome', async (db) => {
        await lockControl(db);
        const clock = await databaseClock(db);
        const deterministicFailure = outcome.deterministicFailureClass != null;
        const pressureFailure = !outcome.ok && !deterministicFailure;
        if (pressureFailure || deterministicFailure) {
          const updated = await query(
            db,
            'adaptive-egress:bucket-failure',
            `UPDATE meta.egress_request_bucket
                SET failures = failures + $4::int,
                    deterministic_failures = deterministic_failures + $5::int,
                    updated_at = clock_timestamp()
              WHERE site_key = $1 AND bucket_start = $2::timestamptz AND channel = $3
                AND failures + deterministic_failures < requests`,
            [
              SITE_KEY,
              permit.bucketStart,
              permit.channel,
              pressureFailure ? 1 : 0,
              deterministicFailure ? 1 : 0,
            ],
          );
          if (updated.rowCount !== 1) {
            throw new Error(`找不到 permit 对应的请求桶 ${permit.bucketStart}/${permit.channel}`);
          }
        }

        let row = await loadControl(db);
        const requests = row.current_window_requests + 1;
        const failures = row.current_window_failures + (pressureFailure ? 1 : 0);
        const deterministicFailures = row.current_window_deterministic_failures
          + (deterministicFailure ? 1 : 0);
        let state = rowToWindowState(row);
        let transition: AdaptiveEgressTransition | null = null;
        let lastRate = row.last_window_failure_rate;
        let lastDeterministicRate = row.last_window_deterministic_failure_rate;
        let lastCompletedAt = row.last_window_completed_at;
        let nextRequests = requests;
        let nextFailures = failures;
        let nextDeterministicFailures = deterministicFailures;

        if (requests === this.#policy.windowRequests) {
          const decision = evaluateFailureWindow(
            state,
            {
              requests,
              failures,
              deterministicFailures,
              completedAtMs: clock.nowMs,
            },
            this.#policy,
          );
          state = decision.state;
          transition = decision.transition;
          lastRate = decision.failureRate;
          lastDeterministicRate = deterministicFailures / requests;
          lastCompletedAt = toPgTimestamptz(clock.nowMs);
          nextRequests = 0;
          nextFailures = 0;
          nextDeterministicFailures = 0;
          if (transition !== null) {
            await insertAlert(db, transition, row.rolling_hour_requests, this.#policy);
          }
        } else if (requests > this.#policy.windowRequests) {
          throw new Error(`反馈窗口计数越界 ${requests}/${this.#policy.windowRequests}`);
        }

        row = await updateControl(
          db,
          row,
          state,
          {
            currentWindowRequests: nextRequests,
            currentWindowFailures: nextFailures,
            currentWindowDeterministicFailures: nextDeterministicFailures,
            lastWindowFailureRate: lastRate,
            lastWindowDeterministicFailureRate: lastDeterministicRate,
            lastWindowCompletedAt: lastCompletedAt,
          },
          this.#policy,
        );
        return {
          snapshot: rowToSnapshot(row, this.#policy),
          transition,
        };
      });

      this.#latest = result.snapshot;
      if (result.transition !== null) {
        this.#transitionsObserved++;
        const severity = result.transition.kind === 'recovery' ? 'warn' : 'error';
        this.#log[severity]('出口反馈档位变化（持久告警已落库）', {
          transition: result.transition,
          outcome,
          state: result.snapshot,
        });
      }
    } catch (err) {
      if (err instanceof AdaptiveEgressUnavailableError) throw err;
      throw new AdaptiveEgressUnavailableError('afterAttempt', err);
    }
  }

  stats(): AdaptiveEgressRuntimeStats {
    return {
      channel: this.#channel,
      permits: this.#permits,
      totalDelayMs: this.#totalDelayMs,
      transitionsObserved: this.#transitionsObserved,
      state: this.#latest,
    };
  }

  async close(): Promise<void> {
    await this.#pool.end().catch(() => undefined);
  }
}

/** 供运维摘要/库内回归读取；不修改控制器状态。 */
export async function readAdaptiveEgressState(
  db: Pool,
  policy: AdaptiveEgressPolicy = ADAPTIVE_EGRESS_POLICY,
): Promise<AdaptiveEgressSnapshot> {
  const result = await query<ControlRow>(
    db,
    'adaptive-egress:read-state',
    `SELECT site_key, level, reason,
            changed_at::text, recover_not_before::text, next_permit_at::text,
            current_window_requests, current_window_failures,
            current_window_deterministic_failures,
            elevated_windows, healthy_windows, last_window_failure_rate,
            last_window_deterministic_failure_rate,
            last_window_completed_at::text, rolling_hour_requests,
            budget_limit, budget_breached,
            l1_last_started_at::text, l1_slo_degraded_since::text,
            l1_slo_expected_recovery_at::text, l1_slo_last_gap_seconds,
            l1_slo_overdue, last_pruned_at::text, updated_at::text
       FROM meta.egress_control WHERE site_key = $1`,
    [SITE_KEY],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`meta.egress_control 缺少 ${SITE_KEY} 单例`);
  return rowToSnapshot(row, policy);
}

export const L1_FRESHNESS_SLO_TARGET_MS = 5 * 60_000;
export const L1_FRESHNESS_SLO_GRACE_MS = 60_000;

export type L1FreshnessSloStatus =
  | 'insufficient_history'
  | 'met'
  | 'degraded_expected'
  | 'degraded_overdue'
  | 'degraded_unattributed';

export interface L1FreshnessSloDecision {
  status: L1FreshnessSloStatus;
  exitCode: 0 | 1;
  gapMs: number | null;
  degradedSinceMs: number | null;
  expectedRecoveryAtMs: number | null;
  overdue: boolean;
}

export interface L1FreshnessSloInput {
  previousStartedAtMs: number | null;
  currentStartedAtMs: number;
  level: AdaptiveEgressLevel;
  levelChangedAtMs: number;
  existingDegradedSinceMs?: number | null;
  existingExpectedRecoveryAtMs?: number | null;
}

/**
 * L1 轮次频率是用户 SLO，不以请求成功率代替。降档导致的预期内退化只发信号且 exit 0；
 * 超过按当前档位逐档恢复所需的窗口才 exit 1。没有活动降档却丢 SLO 不享受宽限。
 */
export function evaluateL1FreshnessSlo(
  input: L1FreshnessSloInput,
  policy: AdaptiveEgressPolicy = ADAPTIVE_EGRESS_POLICY,
): L1FreshnessSloDecision {
  if (!Number.isFinite(input.currentStartedAtMs) || !Number.isFinite(input.levelChangedAtMs)) {
    throw new RangeError('L1 SLO 时间必须是有限毫秒值');
  }
  if (input.previousStartedAtMs === null) {
    return {
      status: 'insufficient_history',
      exitCode: 0,
      gapMs: null,
      degradedSinceMs: null,
      expectedRecoveryAtMs: null,
      overdue: false,
    };
  }

  const gapMs = input.currentStartedAtMs - input.previousStartedAtMs;
  if (!Number.isFinite(gapMs) || gapMs < 0) {
    throw new RangeError(`L1 SLO 轮次时间倒退 ${gapMs}ms`);
  }
  if (gapMs <= L1_FRESHNESS_SLO_TARGET_MS + L1_FRESHNESS_SLO_GRACE_MS) {
    return {
      status: 'met',
      exitCode: 0,
      gapMs,
      degradedSinceMs: null,
      expectedRecoveryAtMs: null,
      overdue: false,
    };
  }

  const degradedSinceMs = input.existingDegradedSinceMs ?? input.currentStartedAtMs;
  if (input.level === 0) {
    return {
      status: 'degraded_unattributed',
      exitCode: 1,
      gapMs,
      degradedSinceMs,
      expectedRecoveryAtMs: null,
      overdue: true,
    };
  }

  const expectedRecoveryAtMs = input.existingExpectedRecoveryAtMs
    ?? input.levelChangedAtMs + expectedFullRecoveryDurationMs(input.level, policy);
  const overdue = input.currentStartedAtMs > expectedRecoveryAtMs;
  return {
    status: overdue ? 'degraded_overdue' : 'degraded_expected',
    exitCode: overdue ? 1 : 0,
    gapMs,
    degradedSinceMs,
    expectedRecoveryAtMs,
    overdue,
  };
}

export interface L1FreshnessSloSignal {
  status: L1FreshnessSloStatus;
  exitCode: 0 | 1;
  targetMinutes: 5;
  graceMinutes: 1;
  previousStartedAt: string | null;
  currentStartedAt: string;
  gapSeconds: number | null;
  egressLevel: AdaptiveEgressLevel;
  egressLevelName: AdaptiveEgressTier['name'];
  recoverNotBefore: string | null;
  expectedRecoveryAt: string | null;
  degradedSince: string | null;
  overdue: boolean;
}

/** 在 L1 run 启动后调用一次：更新 SLO 水位，并把首次退化/首次超期写入持久告警。 */
export async function observeL1FreshnessSlo(
  db: Pool,
  currentStartedAt: string,
  policy: AdaptiveEgressPolicy = ADAPTIVE_EGRESS_POLICY,
): Promise<L1FreshnessSloSignal> {
  const currentStartedAtMs = Date.parse(currentStartedAt);
  if (!Number.isFinite(currentStartedAtMs)) {
    throw new RangeError(`非法 L1 startedAt ${currentStartedAt}`);
  }

  return withTransaction(db, 'adaptive-egress:l1-slo', async (tx) => {
    await lockControl(tx);
    const row = await loadControl(tx);
    const previousStartedAtMs = row.l1_last_started_at === null
      ? null
      : Date.parse(row.l1_last_started_at);
    const decision = evaluateL1FreshnessSlo(
      {
        previousStartedAtMs,
        currentStartedAtMs,
        level: asLevel(row.level),
        levelChangedAtMs: Date.parse(row.changed_at),
        existingDegradedSinceMs: row.l1_slo_degraded_since === null
          ? null
          : Date.parse(row.l1_slo_degraded_since),
        existingExpectedRecoveryAtMs: row.l1_slo_expected_recovery_at === null
          ? null
          : Date.parse(row.l1_slo_expected_recovery_at),
      },
      policy,
    );
    const startingDegradation = decision.degradedSinceMs !== null
      && row.l1_slo_degraded_since === null;
    const newlyOverdue = decision.overdue && !row.l1_slo_overdue;

    await query(
      tx,
      'adaptive-egress:update-l1-slo',
      `UPDATE meta.egress_control
          SET l1_last_started_at = $2::timestamptz,
              l1_slo_degraded_since = $3::timestamptz,
              l1_slo_expected_recovery_at = $4::timestamptz,
              l1_slo_last_gap_seconds = $5,
              l1_slo_overdue = $6,
              updated_at = clock_timestamp()
        WHERE site_key = $1`,
      [
        SITE_KEY,
        currentStartedAt,
        decision.degradedSinceMs === null ? null : toPgTimestamptz(decision.degradedSinceMs),
        decision.expectedRecoveryAtMs === null
          ? null
          : toPgTimestamptz(decision.expectedRecoveryAtMs),
        decision.gapMs === null ? null : Math.round(decision.gapMs / 1_000),
        decision.overdue,
      ],
    );

    if (startingDegradation) {
      await insertL1SloAlert(tx, 'slo_degradation', row, decision, currentStartedAtMs);
    }
    if (newlyOverdue) {
      await insertL1SloAlert(
        tx,
        'slo_degradation_overdue',
        row,
        decision,
        currentStartedAtMs,
      );
    }

    const level = asLevel(row.level);
    return {
      status: decision.status,
      exitCode: decision.exitCode,
      targetMinutes: 5,
      graceMinutes: 1,
      previousStartedAt: previousStartedAtMs === null
        ? null
        : toPgTimestamptz(previousStartedAtMs),
      currentStartedAt: toPgTimestamptz(currentStartedAtMs),
      gapSeconds: decision.gapMs === null ? null : Math.round(decision.gapMs / 1_000),
      egressLevel: level,
      egressLevelName: tier(policy, level).name,
      recoverNotBefore: isoOrNull(row.recover_not_before),
      expectedRecoveryAt: decision.expectedRecoveryAtMs === null
        ? null
        : toPgTimestamptz(decision.expectedRecoveryAtMs),
      degradedSince: decision.degradedSinceMs === null
        ? null
        : toPgTimestamptz(decision.degradedSinceMs),
      overdue: decision.overdue,
    };
  });
}

function expectedFullRecoveryDurationMs(
  level: AdaptiveEgressLevel,
  policy: AdaptiveEgressPolicy,
): number {
  let durationMs = 0;
  for (let candidate = level; candidate > 0; candidate--) {
    const selected = tier(policy, candidate as AdaptiveEgressLevel);
    const healthyEvidenceMs = policy.windowRequests
      * policy.healthyWindowsToRecover
      * selected.minIntervalMs;
    durationMs += Math.max(selected.minimumHoldMs, healthyEvidenceMs);
  }
  return durationMs;
}

async function insertL1SloAlert(
  db: PoolClient,
  kind: 'slo_degradation' | 'slo_degradation_overdue',
  row: ControlRow,
  decision: L1FreshnessSloDecision,
  currentStartedAtMs: number,
): Promise<void> {
  const gapSeconds = decision.gapMs === null ? null : Math.round(decision.gapMs / 1_000);
  const reason = decision.status === 'degraded_unattributed'
    ? `l1_round_gap_${gapSeconds}s_without_active_egress_downshift`
    : `l1_round_gap_${gapSeconds}s_while_egress_level_${row.level}`;
  await query(
    db,
    `adaptive-egress:${kind}`,
    `INSERT INTO meta.egress_alert(
       site_key, kind, from_level, to_level, reason,
       rolling_hour_requests, failure_rate, details
     ) VALUES ($1, $2, $3, $3, $4, $5, NULL,
       jsonb_build_object(
         'slo_target_minutes', 5,
         'slo_grace_minutes', 1,
         'previous_l1_started_at', $6::timestamptz,
         'current_l1_started_at', $7::timestamptz,
         'gap_seconds', $8::int,
         'recover_not_before', $9::timestamptz,
         'expected_recovery_at', $10::timestamptz,
         'status', $11::text,
         'no_qq_delivery', true
       ))`,
    [
      SITE_KEY,
      kind,
      row.level,
      reason,
      row.rolling_hour_requests,
      row.l1_last_started_at,
      toPgTimestamptz(currentStartedAtMs),
      gapSeconds,
      row.recover_not_before,
      decision.expectedRecoveryAtMs === null
        ? null
        : toPgTimestamptz(decision.expectedRecoveryAtMs),
      decision.status,
    ],
  );
}

function downshiftState(
  input: FailureWindowState,
  toLevel: AdaptiveEgressLevel,
  reason: string,
  atMs: number,
  policy: AdaptiveEgressPolicy,
): FailureWindowState {
  return {
    ...input,
    level: toLevel,
    reason,
    changedAtMs: atMs,
    recoverNotBeforeMs: atMs + tier(policy, toLevel).minimumHoldMs,
    elevatedWindows: 0,
    healthyWindows: 0,
  };
}

function tier(policy: AdaptiveEgressPolicy, level: AdaptiveEgressLevel): AdaptiveEgressTier {
  const value = policy.tiers.find((candidate) => candidate.level === level);
  if (!value) throw new Error(`策略缺少 level=${level}`);
  return value;
}

function formatRate(value: number): string {
  return `${(value * 100).toFixed(1)}pct`;
}

async function lockControl(db: PoolClient): Promise<void> {
  await query(
    db,
    'adaptive-egress:lock',
    `SELECT pg_advisory_xact_lock($1)`,
    [CONTROL_LOCK_ID],
  );
}

async function databaseClock(db: PoolClient): Promise<{ nowMs: number }> {
  const result = await query<{ now_ms: string }>(
    db,
    'adaptive-egress:clock',
    `SELECT (extract(epoch FROM clock_timestamp()) * 1000)::text AS now_ms`,
  );
  const nowMs = Number(result.rows[0]?.now_ms);
  if (!Number.isFinite(nowMs)) throw new Error('数据库时钟读取失败');
  return { nowMs };
}

async function loadControl(db: PoolClient): Promise<ControlRow> {
  const result = await query<ControlRow>(
    db,
    'adaptive-egress:load-control',
    `SELECT site_key, level, reason,
            changed_at::text, recover_not_before::text, next_permit_at::text,
            current_window_requests, current_window_failures,
            current_window_deterministic_failures,
            elevated_windows, healthy_windows, last_window_failure_rate,
            last_window_deterministic_failure_rate,
            last_window_completed_at::text, rolling_hour_requests,
            budget_limit, budget_breached,
            l1_last_started_at::text, l1_slo_degraded_since::text,
            l1_slo_expected_recovery_at::text, l1_slo_last_gap_seconds,
            l1_slo_overdue, last_pruned_at::text, updated_at::text
       FROM meta.egress_control
      WHERE site_key = $1
      FOR UPDATE`,
    [SITE_KEY],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`meta.egress_control 缺少 ${SITE_KEY} 单例（0037 未迁移）`);
  return row;
}

async function rollingRequestCount(db: PoolClient, minutes: number): Promise<number> {
  const result = await query<{ requests: string }>(
    db,
    'adaptive-egress:rolling-budget',
    `SELECT coalesce(sum(requests), 0)::text AS requests
       FROM meta.egress_request_bucket
      WHERE site_key = $1
        AND bucket_start >= date_trunc('minute', clock_timestamp())
                               - ($2::int - 1) * interval '1 minute'`,
    [SITE_KEY, minutes],
  );
  const value = Number(result.rows[0]?.requests ?? '0');
  if (!Number.isInteger(value) || value < 0) throw new Error(`非法滚动预算计数 ${value}`);
  return value;
}

interface ControlUpdate {
  rollingHourRequests?: number;
  nextPermitAt?: string;
  lastPrunedAt?: string;
  currentWindowRequests?: number;
  currentWindowFailures?: number;
  currentWindowDeterministicFailures?: number;
  lastWindowFailureRate?: number | null;
  lastWindowDeterministicFailureRate?: number | null;
  lastWindowCompletedAt?: string | null;
}

async function updateControl(
  db: PoolClient,
  old: ControlRow,
  state: FailureWindowState,
  update: ControlUpdate,
  policy: AdaptiveEgressPolicy,
): Promise<ControlRow> {
  const result = await query<ControlRow>(
    db,
    'adaptive-egress:update-control',
    `UPDATE meta.egress_control
        SET level = $2,
            reason = $3,
            changed_at = $4::timestamptz,
            recover_not_before = $5::timestamptz,
            next_permit_at = $6::timestamptz,
            current_window_requests = $7,
            current_window_failures = $8,
            current_window_deterministic_failures = $9,
            elevated_windows = $10,
            healthy_windows = $11,
            last_window_failure_rate = $12,
            last_window_deterministic_failure_rate = $13,
            last_window_completed_at = $14::timestamptz,
            rolling_hour_requests = $15,
            budget_limit = $16,
            budget_breached = $17,
            last_pruned_at = $18::timestamptz,
            updated_at = clock_timestamp()
      WHERE site_key = $1
      RETURNING site_key, level, reason,
                changed_at::text, recover_not_before::text, next_permit_at::text,
                current_window_requests, current_window_failures,
                current_window_deterministic_failures,
                elevated_windows, healthy_windows, last_window_failure_rate,
                last_window_deterministic_failure_rate,
                last_window_completed_at::text, rolling_hour_requests,
                budget_limit, budget_breached,
                l1_last_started_at::text, l1_slo_degraded_since::text,
                l1_slo_expected_recovery_at::text, l1_slo_last_gap_seconds,
                l1_slo_overdue, last_pruned_at::text, updated_at::text`,
    [
      SITE_KEY,
      state.level,
      state.reason,
      toPgTimestamptz(state.changedAtMs),
      state.recoverNotBeforeMs === null ? null : toPgTimestamptz(state.recoverNotBeforeMs),
      update.nextPermitAt ?? old.next_permit_at,
      update.currentWindowRequests ?? old.current_window_requests,
      update.currentWindowFailures ?? old.current_window_failures,
      update.currentWindowDeterministicFailures
        ?? old.current_window_deterministic_failures,
      state.elevatedWindows,
      state.healthyWindows,
      update.lastWindowFailureRate === undefined
        ? old.last_window_failure_rate
        : update.lastWindowFailureRate,
      update.lastWindowDeterministicFailureRate === undefined
        ? old.last_window_deterministic_failure_rate
        : update.lastWindowDeterministicFailureRate,
      update.lastWindowCompletedAt === undefined
        ? old.last_window_completed_at
        : update.lastWindowCompletedAt,
      update.rollingHourRequests ?? old.rolling_hour_requests,
      policy.rollingBudgetRequests,
      state.budgetBreached,
      update.lastPrunedAt ?? old.last_pruned_at,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error('meta.egress_control 更新未返回行');
  return row;
}

async function insertAlert(
  db: PoolClient,
  transition: AdaptiveEgressTransition,
  rollingHourRequests: number,
  policy: AdaptiveEgressPolicy,
): Promise<void> {
  await query(
    db,
    'adaptive-egress:insert-alert',
    `INSERT INTO meta.egress_alert(
       site_key, kind, from_level, to_level, reason,
       rolling_hour_requests, failure_rate, details
     ) VALUES ($1, $2, $3, $4, $5, $6, $7,
       jsonb_build_object(
         'policy_window_requests', $8::int,
         'healthy_windows_required', $9::int,
         'no_qq_delivery', true
       ))`,
    [
      SITE_KEY,
      transition.kind,
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

function rowToWindowState(row: ControlRow): FailureWindowState {
  return {
    level: asLevel(row.level),
    reason: row.reason,
    changedAtMs: Date.parse(row.changed_at),
    recoverNotBeforeMs:
      row.recover_not_before === null ? null : Date.parse(row.recover_not_before),
    elevatedWindows: row.elevated_windows,
    healthyWindows: row.healthy_windows,
    budgetBreached: row.budget_breached,
  };
}

function rowToSnapshot(
  row: ControlRow,
  policy: AdaptiveEgressPolicy,
): AdaptiveEgressSnapshot {
  const level = asLevel(row.level);
  const selectedTier = tier(policy, level);
  return {
    siteKey: row.site_key,
    level,
    levelName: selectedTier.name,
    minRequestIntervalMs: selectedTier.minIntervalMs,
    reason: row.reason,
    changedAt: new Date(row.changed_at).toISOString(),
    recoverNotBefore:
      row.recover_not_before === null ? null : new Date(row.recover_not_before).toISOString(),
    currentWindowRequests: row.current_window_requests,
    currentWindowFailures: row.current_window_failures,
    currentWindowDeterministicFailures: row.current_window_deterministic_failures,
    elevatedWindows: row.elevated_windows,
    healthyWindows: row.healthy_windows,
    healthyWindowsRequired: policy.healthyWindowsToRecover,
    lastWindowFailureRate: row.last_window_failure_rate,
    lastWindowDeterministicFailureRate: row.last_window_deterministic_failure_rate,
    lastWindowCompletedAt:
      row.last_window_completed_at === null
        ? null
        : new Date(row.last_window_completed_at).toISOString(),
    rollingHourRequests: row.rolling_hour_requests,
    budgetLimit: row.budget_limit,
    budgetBreached: row.budget_breached,
    l1LastStartedAt: isoOrNull(row.l1_last_started_at),
    l1SloDegradedSince: isoOrNull(row.l1_slo_degraded_since),
    l1SloExpectedRecoveryAt: isoOrNull(row.l1_slo_expected_recovery_at),
    l1SloLastGapSeconds: row.l1_slo_last_gap_seconds,
    l1SloOverdue: row.l1_slo_overdue,
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function isoOrNull(value: string | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

function asLevel(value: number): AdaptiveEgressLevel {
  if (value === 0 || value === 1 || value === 2 || value === 3) return value;
  throw new Error(`数据库含非法出口档位 ${value}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
