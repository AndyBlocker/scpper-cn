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
 *   * 降档仍由 100-request 窗判定；恢复改用连续 6 个非空 5 分钟 <=3% 证据窗，
 *     并满足最低保持期，避免低吞吐时因凑不满 100 requests 自锁；
 *   * identity_absent 等既有分类可把伪装成 5xx 的确定性失败改记审计；
 *     no_permission / structural 等业务结果本来就不进站点压力分子；
 *   * 无 HTTP 响应的 DNS/代理/connect/TLS/timeout/reset 仍是压力失败；连续 5 个
 *     发生在 2 分钟内即可在未满 100-request 时逐级退让，但两次连接降档至少隔 5 分钟，
 *     避免同一瞬时抖动被多个短进程放大后直接打到 cooldown；
 *   * 0062 起小时预算由五个连续补充令牌桶执行；合法 burst 不再被滚动总账重新翻译
 *     成固定间隔。rolling_hour_requests 只保留观测，pressure 档仍控制全站礼貌 pace；
 *   * 当前 5,400/h = 已启用链路稳态 4,657/h +15% 余量后向上取整；容量计划有
 *     独立检查，新增链路必须先登记预算；
 *   * 通道 token 先按组内 ticket FIFO 获取，再按 token_granted_at 进入全站 FIFO；
 *     新到高优先请求不能越过已经等待的低优先请求。
 */

import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient, QueryResultRow } from 'pg';
import { createPool, query, toPgTimestamptz, withTransaction } from '../store/db.js';
import { createLogger, type Logger } from '../util/log.js';
import {
  abortableSleep,
  isRuntimeBudgetExceededError,
  throwIfAborted,
} from '../util/runtimeBudget.js';
import {
  consumeTokenBucket,
  WIKIDOT_EGRESS_CHANNEL_QUOTA_TOTAL,
  WIKIDOT_EGRESS_REQUIRED_BUDGET_REQUESTS_PER_HOUR,
  wikidotEgressChannelQuota,
  type WikidotEgressChannelGroup,
  type WikidotEgressChannelQuota,
} from './egressCapacity.js';

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
  recoveryWindowMs: number;
  rollingBudgetMinutes: number;
  rollingBudgetRequests: number;
  connectionFailureStreakToBackoff: number;
  connectionFailureStreakWindowMs: number;
  connectionBackoffMinIntervalMs: number;
  tiers: readonly AdaptiveEgressTier[];
}

export const ADAPTIVE_EGRESS_POLICY: AdaptiveEgressPolicy = Object.freeze({
  windowRequests: 100,
  elevatedFailureRate: 0.05,
  severeFailureRate: 0.1,
  healthyFailureRate: 0.03,
  elevatedWindowsToBackoff: 2,
  healthyWindowsToRecover: 6,
  recoveryWindowMs: 5 * 60_000,
  rollingBudgetMinutes: 60,
  rollingBudgetRequests: WIKIDOT_EGRESS_REQUIRED_BUDGET_REQUESTS_PER_HOUR,
  connectionFailureStreakToBackoff: 5,
  connectionFailureStreakWindowMs: 2 * 60_000,
  connectionBackoffMinIntervalMs: 5 * 60_000,
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
  | 'budget_recovery'
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
  state: BudgetControlState;
  transition: AdaptiveEgressTransition | null;
}

export interface TieredBudgetDecision {
  state: FailureWindowState;
  transition: AdaptiveEgressTransition | null;
}

export interface BudgetControlState {
  level: 0 | 1;
  reason: string;
  changedAtMs: number;
  minRequestIntervalMs: number;
  throttleRatio: number;
}

export interface RecoveryWindowState {
  startedAtMs: number | null;
  requests: number;
  failures: number;
}

export interface RecoveryEvidenceDecision {
  state: FailureWindowState;
  window: RecoveryWindowState;
  transition: AdaptiveEgressTransition | null;
  completedWindowFailureRate: number | null;
}

export interface ConnectionPressureState {
  failureStreak: number;
  lastFailureAtMs: number | null;
  lastBackoffAtMs: number | null;
}

export interface ConnectionPressureDecision {
  state: ConnectionPressureState;
  saturated: boolean;
  backoffEligible: boolean;
  reason: string | null;
}

/**
 * 未满 100-request 窗口时的稀疏连接信号。只观察真正没有 HTTP 响应的 attempt；
 * CircuitOpen 是这些 attempt 触发的派生停手，不会再次累加 streak。
 */
export function evaluateConnectionPressure(
  input: ConnectionPressureState,
  connectionFailure: boolean,
  atMs: number,
  policy: AdaptiveEgressPolicy = ADAPTIVE_EGRESS_POLICY,
): ConnectionPressureDecision {
  if (!Number.isFinite(atMs)) throw new RangeError(`非法 connection pressure at=${atMs}`);
  if (!Number.isSafeInteger(input.failureStreak) || input.failureStreak < 0) {
    throw new RangeError(`非法 connection failure streak=${input.failureStreak}`);
  }
  if (!connectionFailure) {
    return {
      state: input.failureStreak === 0 ? input : { ...input, failureStreak: 0 },
      saturated: false,
      backoffEligible: false,
      reason: null,
    };
  }

  const sinceLast = input.lastFailureAtMs === null ? null : atMs - input.lastFailureAtMs;
  const sameBurst = sinceLast !== null
    && sinceLast >= 0
    && sinceLast <= policy.connectionFailureStreakWindowMs;
  const failureStreak = sameBurst
    ? Math.min(input.failureStreak + 1, policy.connectionFailureStreakToBackoff)
    : 1;
  const saturated = failureStreak >= policy.connectionFailureStreakToBackoff;
  const sinceBackoff = input.lastBackoffAtMs === null ? null : atMs - input.lastBackoffAtMs;
  const backoffEligible = saturated && (
    sinceBackoff === null
    || sinceBackoff < 0
    || sinceBackoff >= policy.connectionBackoffMinIntervalMs
  );
  return {
    state: { ...input, failureStreak, lastFailureAtMs: atMs },
    saturated,
    backoffEligible,
    reason: saturated
      ? `connection_failure_streak_${failureStreak}_within_${Math.round(policy.connectionFailureStreakWindowMs / 1_000)}s`
      : null,
  };
}

export interface ConnectionBackoffDecision {
  state: FailureWindowState;
  connectionState: ConnectionPressureState;
  transition: AdaptiveEgressTransition | null;
}

/** 消费一次已平滑的连接信号；无论多严重都只允许逐级下降一档。 */
export function applyConnectionPressureBackoff(
  input: FailureWindowState,
  connection: ConnectionPressureDecision,
  partialFailureRate: number,
  atMs: number,
  policy: AdaptiveEgressPolicy = ADAPTIVE_EGRESS_POLICY,
): ConnectionBackoffDecision {
  if (!connection.backoffEligible) {
    return { state: input, connectionState: connection.state, transition: null };
  }
  if (!Number.isFinite(partialFailureRate) || partialFailureRate < 0 || partialFailureRate > 1) {
    throw new RangeError(`非法 partial connection failure rate=${partialFailureRate}`);
  }
  const connectionState = { ...connection.state, lastBackoffAtMs: atMs };
  if (input.level === 3) {
    return {
      state: {
        ...input,
        recoverNotBeforeMs: Math.max(
          input.recoverNotBeforeMs ?? 0,
          atMs + tier(policy, 3).minimumHoldMs,
        ),
        elevatedWindows: 0,
        healthyWindows: 0,
      },
      connectionState,
      transition: null,
    };
  }
  const toLevel = (input.level + 1) as AdaptiveEgressLevel;
  const reason = `${connection.reason}_sparse_backoff`;
  return {
    state: downshiftState(input, toLevel, reason, atMs, policy),
    connectionState,
    transition: {
      kind: 'failure_backoff',
      fromLevel: input.level,
      toLevel,
      reason,
      failureRate: partialFailureRate,
      rollingHourRequests: null,
    },
  };
}

/** 纯状态机：测试用合成窗口验证，不需要碰活库。 */
export function evaluateFailureWindow(
  input: FailureWindowState,
  window: CompletedFailureWindow,
  policy: AdaptiveEgressPolicy = ADAPTIVE_EGRESS_POLICY,
  options: { allowRequestCountRecovery?: boolean } = {},
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

  // Wikidot 主 gate 的恢复证据由独立 5 分钟窗维护；100-request 窗只负责降档，
  // 不能再同时决定恢复速度。站外图片仍可保留原有按请求窗恢复合同。
  if (options.allowRequestCountRecovery === false) {
    return {
      state: { ...input, elevatedWindows },
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

/**
 * 低吞吐安全的 pressure 恢复证据：按固定 5 分钟桶结算，空桶不计数。
 *
 * 降档判据仍只看完整 100-request 窗；这里永不触发降档。小样本窗的 <=3% 意味着
 * 1..33 个请求必须全健康，因而缩短墙钟时间并未放宽健康定义。健康证据可在保持期内
 * 累计，但只有保持期结束且六窗连续健康时才逐级恢复。
 */
export function evaluateRecoveryEvidence(
  input: FailureWindowState,
  current: RecoveryWindowState,
  pressureFailure: boolean,
  atMs: number,
  policy: AdaptiveEgressPolicy = ADAPTIVE_EGRESS_POLICY,
): RecoveryEvidenceDecision {
  if (!Number.isFinite(atMs)) throw new RangeError(`非法 recovery evidence at=${atMs}`);
  if (!Number.isSafeInteger(current.requests) || current.requests < 0) {
    throw new RangeError(`非法 recovery requests=${current.requests}`);
  }
  if (
    !Number.isSafeInteger(current.failures)
    || current.failures < 0
    || current.failures > current.requests
  ) {
    throw new RangeError(`非法 recovery failures=${current.failures}/${current.requests}`);
  }
  if ((current.startedAtMs === null) !== (current.requests === 0 && current.failures === 0)) {
    throw new RangeError('recovery 空窗口必须同时清空 startedAt/requests/failures');
  }

  if (input.level === 0) {
    return {
      state: input.healthyWindows === 0 ? input : { ...input, healthyWindows: 0 },
      window: emptyRecoveryWindow(),
      transition: null,
      completedWindowFailureRate: null,
    };
  }

  const bucketStartMs = Math.floor(atMs / policy.recoveryWindowMs) * policy.recoveryWindowMs;
  if (current.startedAtMs === null) {
    return {
      state: input,
      window: {
        startedAtMs: bucketStartMs,
        requests: 1,
        failures: pressureFailure ? 1 : 0,
      },
      transition: null,
      completedWindowFailureRate: null,
    };
  }
  if (bucketStartMs < current.startedAtMs) {
    throw new RangeError(
      `recovery 时间倒退 ${bucketStartMs}<${current.startedAtMs}`,
    );
  }
  if (bucketStartMs === current.startedAtMs) {
    return {
      state: input,
      window: {
        ...current,
        requests: current.requests + 1,
        failures: current.failures + (pressureFailure ? 1 : 0),
      },
      transition: null,
      completedWindowFailureRate: null,
    };
  }

  const completedWindowFailureRate = current.failures / current.requests;
  const healthy = completedWindowFailureRate <= policy.healthyFailureRate;
  const healthyWindows = healthy
    ? Math.min(input.healthyWindows + 1, policy.healthyWindowsToRecover)
    : 0;
  let state: FailureWindowState = { ...input, healthyWindows };
  if (!healthy) {
    state = {
      ...state,
      recoverNotBeforeMs: Math.max(
        state.recoverNotBeforeMs ?? 0,
        current.startedAtMs + policy.recoveryWindowMs
          + tier(policy, state.level).minimumHoldMs,
      ),
    };
  }

  const nextWindow: RecoveryWindowState = {
    startedAtMs: bucketStartMs,
    requests: 1,
    failures: pressureFailure ? 1 : 0,
  };
  const holdComplete = state.recoverNotBeforeMs === null || atMs >= state.recoverNotBeforeMs;
  if (healthyWindows < policy.healthyWindowsToRecover || !holdComplete || pressureFailure) {
    return {
      state,
      window: nextWindow,
      transition: null,
      completedWindowFailureRate,
    };
  }

  const fromLevel = state.level;
  const toLevel = (fromLevel - 1) as AdaptiveEgressLevel;
  const reason = `recovered_after_${healthyWindows}_nonempty_${Math.round(policy.recoveryWindowMs / 60_000)}m_windows_lte_${formatRate(policy.healthyFailureRate)}`;
  state = {
    ...state,
    level: toLevel,
    reason,
    changedAtMs: atMs,
    recoverNotBeforeMs: toLevel === 0 ? null : atMs + tier(policy, toLevel).minimumHoldMs,
    elevatedWindows: 0,
    healthyWindows: 0,
  };
  return {
    state,
    window: nextWindow,
    transition: {
      kind: 'recovery',
      fromLevel,
      toLevel,
      reason,
      failureRate: completedWindowFailureRate,
      rollingHourRequests: null,
    },
    completedWindowFailureRate,
  };
}

function emptyRecoveryWindow(): RecoveryWindowState {
  return { startedAtMs: null, requests: 0, failures: 0 };
}

/**
 * Wikidot 主 gate 的比例预算控制器。
 *
 * rolling=R、limit=L 时，过去一小时观测均值是 R/window；目标 pace 设为 L/window，
 * 因而吞吐因子恰为 L/R。+1 只削去 1/R，大幅越界则按相同比例收缩。它只有独立的
 * budget level 1，不会污染 pressure level 2/3，也没有固定冷却；R<=L 立即解除。
 */
export function evaluateProportionalBudget(
  input: BudgetControlState,
  rollingHourRequests: number,
  atMs: number,
  policy: AdaptiveEgressPolicy = ADAPTIVE_EGRESS_POLICY,
): BudgetDecision {
  if (!Number.isInteger(rollingHourRequests) || rollingHourRequests < 0) {
    throw new RangeError(`非法滚动小时请求数 ${rollingHourRequests}`);
  }
  if (!Number.isFinite(atMs)) throw new RangeError(`非法 budget at=${atMs}`);
  const normalIntervalMs = tier(policy, 0).minIntervalMs;
  if (rollingHourRequests <= policy.rollingBudgetRequests) {
    if (input.level === 0) {
      return {
        state: input.minRequestIntervalMs === normalIntervalMs && input.throttleRatio === 1
          ? input
          : {
              ...input,
              minRequestIntervalMs: normalIntervalMs,
              throttleRatio: 1,
            },
        transition: null,
      };
    }
    const reason = `rolling_${policy.rollingBudgetMinutes}m_requests_${rollingHourRequests}_lte_${policy.rollingBudgetRequests}_budget_recovered`;
    return {
      state: {
        level: 0,
        reason,
        changedAtMs: atMs,
        minRequestIntervalMs: normalIntervalMs,
        throttleRatio: 1,
      },
      transition: {
        kind: 'budget_recovery',
        fromLevel: 1,
        toLevel: 0,
        reason,
        failureRate: null,
        rollingHourRequests,
      },
    };
  }

  const throttleRatio = policy.rollingBudgetRequests / rollingHourRequests;
  const minRequestIntervalMs = Math.ceil(
    policy.rollingBudgetMinutes * 60_000 / policy.rollingBudgetRequests,
  );
  const reason = `rolling_${policy.rollingBudgetMinutes}m_requests_${rollingHourRequests}_gt_${policy.rollingBudgetRequests}_proportional_${formatRate(throttleRatio)}_pace`;
  const firstBreach = input.level === 0;
  return {
    state: {
      level: 1,
      reason,
      changedAtMs: firstBreach ? atMs : input.changedAtMs,
      minRequestIntervalMs,
      throttleRatio,
    },
    transition: firstBreach
      ? {
          kind: 'budget_breach',
          fromLevel: 0,
          toLevel: 1,
          reason,
          failureRate: null,
          rollingHourRequests,
        }
      : null,
  };
}

/**
 * 0062 的小时总量权威是五个 refill 总和恰为 5,400/h 的令牌桶。滚动总账可能合法地
 * 包含至多一个总桶容量的 burst，不能再据此开启 667ms 固定 pace；这里只把旧状态
 * 收敛回 normal，rolling_hour_requests 继续作为观测值落库。
 */
export function evaluateTokenBucketBudget(
  input: BudgetControlState,
  atMs: number,
  policy: AdaptiveEgressPolicy = ADAPTIVE_EGRESS_POLICY,
): BudgetDecision {
  if (!Number.isFinite(atMs)) throw new RangeError(`非法 token bucket budget at=${atMs}`);
  const minRequestIntervalMs = tier(policy, 0).minIntervalMs;
  const state: BudgetControlState = {
    level: 0,
    reason: input.level === 0 ? input.reason : 'channel_token_buckets_authoritative',
    changedAtMs: input.level === 0 ? input.changedAtMs : atMs,
    minRequestIntervalMs,
    throttleRatio: 1,
  };
  return {
    state,
    transition: input.level === 0
      ? null
      : {
          kind: 'budget_recovery',
          fromLevel: 1,
          toLevel: 0,
          reason: state.reason,
          failureRate: null,
          rollingHourRequests: null,
        },
  };
}

/** 站外图片 host gate 的既有独立 tiered 预算合同；Wikidot 主 gate 不再调用它。 */
export function evaluateRollingBudget(
  input: FailureWindowState,
  rollingHourRequests: number,
  atMs: number,
  policy: AdaptiveEgressPolicy = ADAPTIVE_EGRESS_POLICY,
): TieredBudgetDecision {
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
  /** 兼容有效档位：max(pressureLevel,budgetLevel)。 */
  level: AdaptiveEgressLevel;
  levelName: AdaptiveEgressTier['name'];
  minRequestIntervalMs: number;
  reason: string;
  changedAt: string;
  recoverNotBefore: string | null;
  pressureLevel: AdaptiveEgressLevel;
  pressureReason: string;
  pressureChangedAt: string;
  pressureRecoverNotBefore: string | null;
  budgetLevel: 0 | 1;
  budgetReason: string;
  budgetChangedAt: string;
  budgetMinRequestIntervalMs: number;
  budgetThrottleRatio: number;
  currentWindowRequests: number;
  /** 站点压力分子：transport / 429 / 5xx，已排除确定性业务失败。 */
  currentWindowFailures: number;
  /** 当前压力分子中尚未取得 HTTP 响应的连接失败子集。 */
  currentWindowConnectionFailures: number;
  currentWindowDeterministicFailures: number;
  connectionFailureStreak: number;
  lastConnectionFailureAt: string | null;
  lastConnectionBackoffAt: string | null;
  elevatedWindows: number;
  healthyWindows: number;
  healthyWindowsRequired: number;
  recoveryWindowMinutes: number;
  recoveryWindowStartedAt: string | null;
  recoveryWindowRequests: number;
  recoveryWindowFailures: number;
  lastWindowFailureRate: number | null;
  lastWindowConnectionFailureRate: number | null;
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
  if (snapshot.pressureLevel === 0) {
    if (snapshot.budgetLevel > 0) {
      return {
        status: 'downshift_expected', active: true, overdue: false, exitCode: 0,
        level: snapshot.level, levelName: snapshot.levelName, reason: snapshot.budgetReason,
        recoverNotBefore: null, expectedRecoveryAt: null,
      };
    }
    return {
      status: 'normal', active: false, overdue: false, exitCode: 0,
      level: snapshot.level, levelName: snapshot.levelName, reason: snapshot.reason,
      recoverNotBefore: snapshot.recoverNotBefore, expectedRecoveryAt: null,
    };
  }
  const changedAtMs = Date.parse(snapshot.pressureChangedAt);
  const holdUntilMs = snapshot.pressureRecoverNotBefore === null
    ? changedAtMs
    : Date.parse(snapshot.pressureRecoverNotBefore);
  if (!Number.isFinite(changedAtMs) || !Number.isFinite(holdUntilMs)) {
    throw new RangeError('自适应出口快照含非法 changedAt/recoverNotBefore');
  }
  const currentTier = tier(policy, snapshot.pressureLevel);
  const currentHealthyEvidenceMs = policy.recoveryWindowMs * policy.healthyWindowsToRecover;
  let lowerTierRecoveryMs = 0;
  for (let level = snapshot.pressureLevel - 1; level > 0; level--) {
    const selected = tier(policy, level as AdaptiveEgressLevel);
    lowerTierRecoveryMs += Math.max(
      selected.minimumHoldMs,
      policy.recoveryWindowMs * policy.healthyWindowsToRecover,
    );
  }
  const currentEvidenceStartedAtMs = Math.max(
    changedAtMs,
    holdUntilMs - currentTier.minimumHoldMs,
  );
  const expectedRecoveryAtMs = Math.max(
    changedAtMs + expectedFullRecoveryDurationMs(snapshot.pressureLevel, policy),
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
    level: snapshot.pressureLevel,
    levelName: tier(policy, snapshot.pressureLevel).name,
    reason: snapshot.pressureReason,
    recoverNotBefore: snapshot.pressureRecoverNotBefore,
    expectedRecoveryAt: toPgTimestamptz(expectedRecoveryAtMs),
  };
}

export interface AdaptiveEgressPermit {
  bucketStart: string;
  channel: string;
  grantAt: string;
  /** 可选的精细分账键；站外图片用 exact hostname，Wikidot 单例不需要。 */
  scopeKey?: string;
}

export interface PermitFifoOrderKey {
  tokenGrantedAtMs: number;
  ticketId: number;
}

/** 代码侧镜像数据库 ORDER BY token_granted_at, ticket_id；priority 不参与插队。 */
export function comparePermitFifoOrder(a: PermitFifoOrderKey, b: PermitFifoOrderKey): number {
  if (!Number.isFinite(a.tokenGrantedAtMs) || !Number.isFinite(b.tokenGrantedAtMs)) {
    throw new RangeError('FIFO tokenGrantedAtMs 必须有限');
  }
  if (!Number.isSafeInteger(a.ticketId) || !Number.isSafeInteger(b.ticketId)) {
    throw new RangeError('FIFO ticketId 必须是安全整数');
  }
  return a.tokenGrantedAtMs - b.tokenGrantedAtMs || a.ticketId - b.ticketId;
}

/**
 * token 已就绪后的保守等待上界：把每个既有前序都按“恰在轮到时崩溃并占满
 * 一个 lease”计算，再加一个全站间隔和一次 poll 抖动。后到票据不计入
 * readyAhead，因而不能延长此上界。
 */
export function fifoPermitWaitUpperBoundMs(
  readyAhead: number,
  permitIntervalMs: number,
  pollMs = WAITER_POLL_MS,
  staleLeaseMs = WAITER_LEASE_MS,
): number {
  for (const [label, value] of [
    ['readyAhead', readyAhead],
    ['permitIntervalMs', permitIntervalMs],
    ['pollMs', pollMs],
    ['staleLeaseMs', staleLeaseMs],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(`${label} 必须是非负安全整数，收到 ${value}`);
    }
  }
  return (readyAhead + 1) * (staleLeaseMs + permitIntervalMs + pollMs);
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
  channelPolicy?: {
    group: WikidotEgressChannelGroup;
    quotaRequestsPerHour: number;
    bucketCapacity: number;
    priority: number;
  };
  permits: number;
  totalDelayMs: number;
  tokenDelayMs?: number;
  fifoDelayMs?: number;
  maxWaitMs?: number;
  maxQueueDepth?: number;
  transitionsObserved: number;
  state: AdaptiveEgressSnapshot | null;
}

export interface AdaptiveEgressGate {
  /** url 供按 origin/host 分账的 gate 使用；Wikidot 单例 gate 会忽略它。 */
  beforeAttempt(url?: string, signal?: AbortSignal): Promise<AdaptiveEgressPermit>;
  afterAttempt(
    permit: AdaptiveEgressPermit,
    outcome: AdaptiveAttemptOutcome,
    signal?: AbortSignal,
  ): Promise<void>;
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
  pressure_level: number;
  pressure_reason: string;
  pressure_changed_at: string;
  pressure_recover_not_before: string | null;
  budget_level: number;
  budget_reason: string;
  budget_changed_at: string;
  budget_min_interval_ms: number;
  budget_throttle_ratio: number;
  recovery_window_started_at: string | null;
  recovery_window_requests: number;
  recovery_window_failures: number;
  next_permit_at: string;
  current_window_requests: number;
  current_window_failures: number;
  current_window_connection_failures: number;
  current_window_deterministic_failures: number;
  connection_failure_streak: number;
  last_connection_failure_at: string | null;
  last_connection_backoff_at: string | null;
  elevated_windows: number;
  healthy_windows: number;
  last_window_failure_rate: number | null;
  last_window_connection_failure_rate: number | null;
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

interface ChannelControlRow extends QueryResultRow {
  site_key: string;
  channel_group: WikidotEgressChannelGroup;
  quota_requests_per_hour: number;
  bucket_capacity: number;
  available_tokens: string;
  tokens_refilled_at: string;
  priority: number;
}

interface WaiterRow extends QueryResultRow {
  ticket_id: string;
  waiter_id: string;
  token_granted_at: string | null;
}

const SITE_KEY = 'wikidot';
const CONTROL_LOCK_ID = 2_026_080_5;
const WAITER_LEASE_MS = 10_000;
const WAITER_POLL_MS = 200;
const WAITER_MAX_SLEEP_MS = 3_000;

export class PostgresAdaptiveEgressGate implements AdaptiveEgressGate {
  readonly #pool: Pool;
  readonly #channel: string;
  readonly #log: Logger;
  readonly #policy: AdaptiveEgressPolicy;
  readonly #channelPolicy: WikidotEgressChannelQuota;
  #latest: AdaptiveEgressSnapshot | null = null;
  #permits = 0;
  #totalDelayMs = 0;
  #tokenDelayMs = 0;
  #fifoDelayMs = 0;
  #maxWaitMs = 0;
  #maxQueueDepth = 0;
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
    if (WIKIDOT_EGRESS_CHANNEL_QUOTA_TOTAL !== this.#policy.rollingBudgetRequests) {
      throw new Error(
        `出口通道补充总量 ${WIKIDOT_EGRESS_CHANNEL_QUOTA_TOTAL}/h `
        + `不等于全站预算 ${this.#policy.rollingBudgetRequests}/h`,
      );
    }
    this.#channelPolicy = wikidotEgressChannelQuota(channel);
  }

  async beforeAttempt(_url?: string, signal?: AbortSignal): Promise<AdaptiveEgressPermit> {
    const waiterId = randomUUID();
    const startedAtMs = Date.now();
    try {
      for (;;) {
        throwIfAborted(signal);
        const reservation = await withTransaction(
          this.#pool,
          'adaptive-egress:permit',
          async (db) => {
            await lockControl(db, signal);
            const clock = await databaseClock(db);
            const leaseExpiresAt = toPgTimestamptz(clock.nowMs + WAITER_LEASE_MS);

            await query(
              db,
              'adaptive-egress:prune-waiters',
              `DELETE FROM meta.egress_permit_waiter
                WHERE site_key = $1 AND lease_expires_at <= clock_timestamp()`,
              [SITE_KEY],
            );
            const waiterResult = await query<WaiterRow>(
              db,
              'adaptive-egress:upsert-waiter',
              `INSERT INTO meta.egress_permit_waiter(
                 waiter_id, site_key, channel, channel_group, lease_expires_at
               ) VALUES ($1::uuid, $2, $3, $4, $5::timestamptz)
               ON CONFLICT (waiter_id) DO UPDATE
                 SET lease_expires_at = EXCLUDED.lease_expires_at
               RETURNING ticket_id::text, waiter_id::text, token_granted_at::text`,
              [
                waiterId,
                SITE_KEY,
                this.#channel,
                this.#channelPolicy.group,
                leaseExpiresAt,
              ],
            );
            let waiter = waiterResult.rows[0];
            if (waiter === undefined) throw new Error('出口 FIFO waiter UPSERT 未返回行');

            const depthResult = await query<{ depth: number }>(
              db,
              'adaptive-egress:waiter-depth',
              `SELECT count(*)::int AS depth
                 FROM meta.egress_permit_waiter WHERE site_key = $1`,
              [SITE_KEY],
            );
            const queueDepth = depthResult.rows[0]?.depth ?? 1;

            if (waiter.token_granted_at === null) {
              const tokenHead = await query<WaiterRow>(
                db,
                'adaptive-egress:token-head',
                `SELECT ticket_id::text, waiter_id::text, token_granted_at::text
                   FROM meta.egress_permit_waiter
                  WHERE site_key = $1 AND channel_group = $2
                    AND token_granted_at IS NULL
                  ORDER BY ticket_id
                  LIMIT 1`,
                [SITE_KEY, this.#channelPolicy.group],
              );
              if (tokenHead.rows[0]?.waiter_id !== waiterId) {
                return {
                  kind: 'wait' as const,
                  waitMs: WAITER_POLL_MS,
                  waitStage: 'token' as const,
                  queueDepth,
                };
              }

              const channel = await loadChannelControl(db, this.#channelPolicy);
              const token = consumeTokenBucket(
                {
                  availableTokens: Number(channel.available_tokens),
                  refilledAtMs: Date.parse(channel.tokens_refilled_at),
                },
                this.#channelPolicy,
                clock.nowMs,
              );
              await query(
                db,
                'adaptive-egress:update-token-bucket',
                `UPDATE meta.egress_channel_control
                    SET available_tokens = $3::numeric,
                        tokens_refilled_at = $4::timestamptz,
                        updated_at = clock_timestamp()
                  WHERE site_key = $1 AND channel_group = $2`,
                [
                  SITE_KEY,
                  this.#channelPolicy.group,
                  token.availableTokens.toFixed(9),
                  toPgTimestamptz(token.refilledAtMs),
                ],
              );
              if (!token.granted) {
                return {
                  kind: 'wait' as const,
                  waitMs: Math.min(token.waitMs, WAITER_MAX_SLEEP_MS),
                  waitStage: 'token' as const,
                  queueDepth,
                };
              }
              const granted = await query<WaiterRow>(
                db,
                'adaptive-egress:grant-token',
                `UPDATE meta.egress_permit_waiter
                    SET token_granted_at = clock_timestamp(),
                        lease_expires_at = $2::timestamptz
                  WHERE waiter_id = $1::uuid
                  RETURNING ticket_id::text, waiter_id::text, token_granted_at::text`,
                [waiterId, leaseExpiresAt],
              );
              waiter = granted.rows[0];
              if (waiter === undefined || waiter.token_granted_at === null) {
                throw new Error('出口 FIFO token grant 未返回行');
              }
            }

            const permitHead = await query<WaiterRow>(
              db,
              'adaptive-egress:permit-head',
              `SELECT ticket_id::text, waiter_id::text, token_granted_at::text
                 FROM meta.egress_permit_waiter
                WHERE site_key = $1 AND token_granted_at IS NOT NULL
                ORDER BY token_granted_at, ticket_id
                LIMIT 1`,
              [SITE_KEY],
            );
            if (permitHead.rows[0]?.waiter_id !== waiterId) {
              return {
                kind: 'wait' as const,
                waitMs: WAITER_POLL_MS,
                waitStage: 'fifo' as const,
                queueDepth,
              };
            }

            let row = await loadControl(db);
            const pressureState = rowToWindowState(row);
            const budget = evaluateTokenBucketBudget(
              rowToBudgetState(row),
              clock.nowMs,
              this.#policy,
            );
            const minRequestIntervalMs = Math.max(
              tier(this.#policy, pressureState.level).minIntervalMs,
              budget.state.minRequestIntervalMs,
            );
            const nextPermitMs = Date.parse(row.next_permit_at);
            if (!Number.isFinite(nextPermitMs)) {
              throw new Error(`全站 next_permit_at 非法: ${row.next_permit_at}`);
            }
            if (nextPermitMs > clock.nowMs) {
              return {
                kind: 'wait' as const,
                waitMs: Math.min(
                  Math.max(1, Math.ceil(nextPermitMs - clock.nowMs)),
                  WAITER_MAX_SLEEP_MS,
                ),
                waitStage: 'fifo' as const,
                queueDepth,
              };
            }

            const bucketStart = new Date(
              Math.floor(clock.nowMs / 60_000) * 60_000,
            ).toISOString();
            await query(
              db,
              'adaptive-egress:bucket-request',
              `INSERT INTO meta.egress_request_bucket(
                 site_key, bucket_start, channel, requests, failures,
                 connection_failures, updated_at
               ) VALUES ($1, $2::timestamptz, $3, 1, 0, 0, clock_timestamp())
               ON CONFLICT (site_key, bucket_start, channel) DO UPDATE
                 SET requests = meta.egress_request_bucket.requests + 1,
                     updated_at = clock_timestamp()`,
              [SITE_KEY, bucketStart, this.#channel],
            );
            const rolling = await rollingRequestCount(db, this.#policy.rollingBudgetMinutes);
            if (budget.transition !== null) {
              await insertAlert(db, budget.transition, rolling, this.#policy);
            }
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
              pressureState,
              budget.state,
              {
                rollingHourRequests: rolling,
                nextPermitAt: toPgTimestamptz(clock.nowMs + minRequestIntervalMs),
                lastPrunedAt: shouldPrune
                  ? toPgTimestamptz(clock.nowMs)
                  : row.last_pruned_at,
              },
              this.#policy,
            );
            await query(
              db,
              'adaptive-egress:consume-waiter',
              `DELETE FROM meta.egress_permit_waiter WHERE waiter_id = $1::uuid`,
              [waiterId],
            );
            return {
              kind: 'permit' as const,
              permit: {
                bucketStart,
                channel: this.#channel,
                grantAt: toPgTimestamptz(clock.nowMs),
              },
              queueDepth,
              snapshot: rowToSnapshot(row, this.#policy),
              transition: budget.transition,
            };
          },
        );

        this.#maxQueueDepth = Math.max(this.#maxQueueDepth, reservation.queueDepth);
        if (reservation.kind === 'wait') {
          this.#totalDelayMs += reservation.waitMs;
          if (reservation.waitStage === 'token') this.#tokenDelayMs += reservation.waitMs;
          else this.#fifoDelayMs += reservation.waitMs;
          await abortableSleep(reservation.waitMs, signal);
          continue;
        }

        this.#latest = reservation.snapshot;
        this.#permits++;
        this.#maxWaitMs = Math.max(this.#maxWaitMs, Date.now() - startedAtMs);
        if (reservation.transition !== null) {
          this.#transitionsObserved++;
          this.#log.warn('旧滚动预算 pace 已由通道令牌桶权威收敛（持久告警已落库）', {
            transition: reservation.transition,
            state: reservation.snapshot,
          });
        }
        return reservation.permit;
      }
    } catch (err) {
      await query(
        this.#pool,
        'adaptive-egress:abandon-waiter',
        `DELETE FROM meta.egress_permit_waiter WHERE waiter_id = $1::uuid`,
        [waiterId],
      ).catch(() => undefined);
      if (isRuntimeBudgetExceededError(err)) throw err;
      if (err instanceof AdaptiveEgressUnavailableError) throw err;
      throw new AdaptiveEgressUnavailableError('beforeAttempt', err);
    }
  }

  async afterAttempt(
    permit: AdaptiveEgressPermit,
    outcome: AdaptiveAttemptOutcome,
    signal?: AbortSignal,
  ): Promise<void> {
    try {
      throwIfAborted(signal);
      const result = await withTransaction(this.#pool, 'adaptive-egress:outcome', async (db) => {
        await lockControl(db, signal);
        const clock = await databaseClock(db);
        const deterministicFailure = outcome.deterministicFailureClass != null;
        const pressureFailure = !outcome.ok && !deterministicFailure;
        const connectionFailure = pressureFailure && outcome.status === null;
        if (pressureFailure || deterministicFailure) {
          const updated = await query(
            db,
            'adaptive-egress:bucket-failure',
            `UPDATE meta.egress_request_bucket
                SET failures = failures + $4::int,
                    deterministic_failures = deterministic_failures + $5::int,
                    connection_failures = connection_failures + $6::int,
                    updated_at = clock_timestamp()
              WHERE site_key = $1 AND bucket_start = $2::timestamptz AND channel = $3
                AND failures + deterministic_failures < requests`,
            [
              SITE_KEY,
              permit.bucketStart,
              permit.channel,
              pressureFailure ? 1 : 0,
              deterministicFailure ? 1 : 0,
              connectionFailure ? 1 : 0,
            ],
          );
          if (updated.rowCount !== 1) {
            throw new Error(`找不到 permit 对应的请求桶 ${permit.bucketStart}/${permit.channel}`);
          }
        }

        let row = await loadControl(db);
        const connection = evaluateConnectionPressure(
          rowToConnectionPressureState(row),
          connectionFailure,
          clock.nowMs,
          this.#policy,
        );
        let connectionState = connection.state;
        const requests = row.current_window_requests + 1;
        const failures = row.current_window_failures + (pressureFailure ? 1 : 0);
        const connectionFailures = row.current_window_connection_failures
          + (connectionFailure ? 1 : 0);
        const deterministicFailures = row.current_window_deterministic_failures
          + (deterministicFailure ? 1 : 0);
        let state = rowToWindowState(row);
        let recoveryWindow = rowToRecoveryWindowState(row);
        let transition: AdaptiveEgressTransition | null = null;
        let lastRate = row.last_window_failure_rate;
        let lastConnectionRate = row.last_window_connection_failure_rate;
        let lastDeterministicRate = row.last_window_deterministic_failure_rate;
        let lastCompletedAt = row.last_window_completed_at;
        let nextRequests = requests;
        let nextFailures = failures;
        let nextConnectionFailures = connectionFailures;
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
            { allowRequestCountRecovery: false },
          );
          state = decision.state;
          transition = decision.transition;
          lastRate = decision.failureRate;
          lastConnectionRate = connectionFailures / requests;
          lastDeterministicRate = deterministicFailures / requests;
          lastCompletedAt = toPgTimestamptz(clock.nowMs);
          nextRequests = 0;
          nextFailures = 0;
          nextConnectionFailures = 0;
          nextDeterministicFailures = 0;
        } else if (requests > this.#policy.windowRequests) {
          throw new Error(`反馈窗口计数越界 ${requests}/${this.#policy.windowRequests}`);
        }

        // 同一个 outcome 最多下降一级。若完整窗口已经消费了这次连接证据，就只更新时间戳；
        // 否则由稀疏 streak 在窗口未满时逐级退让。level 3 只延长保持，不制造伪 transition。
        if (connection.backoffEligible) {
          if (transition === null) {
            const sparse = applyConnectionPressureBackoff(
              state,
              connection,
              failures / requests,
              clock.nowMs,
              this.#policy,
            );
            state = sparse.state;
            connectionState = sparse.connectionState;
            transition = sparse.transition;
          } else {
            connectionState = { ...connectionState, lastBackoffAtMs: clock.nowMs };
          }
        }
        if (transition?.kind === 'failure_backoff') {
          recoveryWindow = emptyRecoveryWindow();
        } else {
          const recovery = evaluateRecoveryEvidence(
            state,
            recoveryWindow,
            pressureFailure,
            clock.nowMs,
            this.#policy,
          );
          state = recovery.state;
          recoveryWindow = recovery.window;
          transition = recovery.transition ?? transition;
        }
        if (transition !== null) {
          await insertAlert(db, transition, row.rolling_hour_requests, this.#policy);
        }

        row = await updateControl(
          db,
          row,
          state,
          rowToBudgetState(row),
          {
            currentWindowRequests: nextRequests,
            currentWindowFailures: nextFailures,
            currentWindowConnectionFailures: nextConnectionFailures,
            currentWindowDeterministicFailures: nextDeterministicFailures,
            connectionPressureState: connectionState,
            lastWindowFailureRate: lastRate,
            lastWindowConnectionFailureRate: lastConnectionRate,
            lastWindowDeterministicFailureRate: lastDeterministicRate,
            lastWindowCompletedAt: lastCompletedAt,
            recoveryWindowState: recoveryWindow,
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
      if (isRuntimeBudgetExceededError(err)) throw err;
      if (err instanceof AdaptiveEgressUnavailableError) throw err;
      throw new AdaptiveEgressUnavailableError('afterAttempt', err);
    }
  }

  stats(): AdaptiveEgressRuntimeStats {
    return {
      channel: this.#channel,
      channelPolicy: {
        group: this.#channelPolicy.group,
        quotaRequestsPerHour: this.#channelPolicy.requestsPerHour,
        bucketCapacity: this.#channelPolicy.bucketCapacity,
        priority: this.#channelPolicy.priority,
      },
      permits: this.#permits,
      totalDelayMs: this.#totalDelayMs,
      tokenDelayMs: this.#tokenDelayMs,
      fifoDelayMs: this.#fifoDelayMs,
      maxWaitMs: this.#maxWaitMs,
      maxQueueDepth: this.#maxQueueDepth,
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
            pressure_level, pressure_reason, pressure_changed_at::text,
            pressure_recover_not_before::text,
            budget_level, budget_reason, budget_changed_at::text,
            budget_min_interval_ms, budget_throttle_ratio,
            recovery_window_started_at::text, recovery_window_requests,
            recovery_window_failures,
            current_window_requests, current_window_failures,
            current_window_connection_failures,
            current_window_deterministic_failures,
            connection_failure_streak, last_connection_failure_at::text,
            last_connection_backoff_at::text,
            elevated_windows, healthy_windows, last_window_failure_rate,
            last_window_connection_failure_rate,
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
    const healthyEvidenceMs = policy.recoveryWindowMs * policy.healthyWindowsToRecover;
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

async function lockControl(db: PoolClient, signal?: AbortSignal): Promise<void> {
  if (signal === undefined) {
    await query(
      db,
      'adaptive-egress:lock',
      `SELECT pg_advisory_xact_lock($1)`,
      [CONTROL_LOCK_ID],
    );
    return;
  }
  for (;;) {
    throwIfAborted(signal);
    const locked = await query<{ locked: boolean }>(
      db,
      'adaptive-egress:try-lock',
      `SELECT pg_try_advisory_xact_lock($1) AS locked`,
      [CONTROL_LOCK_ID],
    );
    if (locked.rows[0]?.locked === true) return;
    await abortableSleep(25, signal);
  }
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
            pressure_level, pressure_reason, pressure_changed_at::text,
            pressure_recover_not_before::text,
            budget_level, budget_reason, budget_changed_at::text,
            budget_min_interval_ms, budget_throttle_ratio,
            recovery_window_started_at::text, recovery_window_requests,
            recovery_window_failures,
            current_window_requests, current_window_failures,
            current_window_connection_failures,
            current_window_deterministic_failures,
            connection_failure_streak, last_connection_failure_at::text,
            last_connection_backoff_at::text,
            elevated_windows, healthy_windows, last_window_failure_rate,
            last_window_connection_failure_rate,
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

async function loadChannelControl(
  db: PoolClient,
  expected: WikidotEgressChannelQuota,
): Promise<ChannelControlRow> {
  const result = await query<ChannelControlRow>(
    db,
    'adaptive-egress:load-channel-control',
    `SELECT site_key, channel_group, quota_requests_per_hour, bucket_capacity,
            available_tokens::text, tokens_refilled_at::text, priority
       FROM meta.egress_channel_control
      WHERE site_key = $1 AND channel_group = $2
      FOR UPDATE`,
    [SITE_KEY, expected.group],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error(`meta.egress_channel_control 缺少 ${expected.group}（0062 未迁移）`);
  }
  if (
    row.quota_requests_per_hour !== expected.requestsPerHour
    || row.bucket_capacity !== expected.bucketCapacity
    || row.priority !== expected.priority
  ) {
    throw new Error(
      `出口通道 ${expected.group} 配置漂移：库=${row.quota_requests_per_hour}/h,`
      + `capacity=${row.bucket_capacity},priority=${row.priority}；`
      + `代码=${expected.requestsPerHour}/h,capacity=${expected.bucketCapacity},`
      + `priority=${expected.priority}`,
    );
  }
  const availableTokens = Number(row.available_tokens);
  const refilledAtMs = Date.parse(row.tokens_refilled_at);
  if (
    !Number.isFinite(availableTokens)
    || availableTokens < 0
    || availableTokens > row.bucket_capacity + 1e-6
    || !Number.isFinite(refilledAtMs)
  ) {
    throw new Error(
      `出口通道 ${expected.group} 令牌桶状态非法：tokens=${row.available_tokens},`
      + `refilled_at=${row.tokens_refilled_at}`,
    );
  }
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
  currentWindowConnectionFailures?: number;
  currentWindowDeterministicFailures?: number;
  connectionPressureState?: ConnectionPressureState;
  lastWindowFailureRate?: number | null;
  lastWindowConnectionFailureRate?: number | null;
  lastWindowDeterministicFailureRate?: number | null;
  lastWindowCompletedAt?: string | null;
  recoveryWindowState?: RecoveryWindowState;
}

async function updateControl(
  db: PoolClient,
  old: ControlRow,
  state: FailureWindowState,
  budget: BudgetControlState,
  update: ControlUpdate,
  policy: AdaptiveEgressPolicy,
): Promise<ControlRow> {
  const effective = combineControlState(state, budget);
  const recoveryWindow = update.recoveryWindowState ?? rowToRecoveryWindowState(old);
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
            current_window_connection_failures = $9,
            current_window_deterministic_failures = $10,
            connection_failure_streak = $11,
            last_connection_failure_at = $12::timestamptz,
            last_connection_backoff_at = $13::timestamptz,
            elevated_windows = $14,
            healthy_windows = $15,
            last_window_failure_rate = $16,
            last_window_connection_failure_rate = $17,
            last_window_deterministic_failure_rate = $18,
            last_window_completed_at = $19::timestamptz,
            rolling_hour_requests = $20,
            budget_limit = $21,
            budget_breached = $22,
            last_pruned_at = $23::timestamptz,
            pressure_level = $24,
            pressure_reason = $25,
            pressure_changed_at = $26::timestamptz,
            pressure_recover_not_before = $27::timestamptz,
            budget_level = $28,
            budget_reason = $29,
            budget_changed_at = $30::timestamptz,
            budget_min_interval_ms = $31,
            budget_throttle_ratio = $32,
            recovery_window_started_at = $33::timestamptz,
            recovery_window_requests = $34,
            recovery_window_failures = $35,
            updated_at = clock_timestamp()
      WHERE site_key = $1
      RETURNING site_key, level, reason,
                changed_at::text, recover_not_before::text, next_permit_at::text,
                pressure_level, pressure_reason, pressure_changed_at::text,
                pressure_recover_not_before::text,
                budget_level, budget_reason, budget_changed_at::text,
                budget_min_interval_ms, budget_throttle_ratio,
                recovery_window_started_at::text, recovery_window_requests,
                recovery_window_failures,
                current_window_requests, current_window_failures,
                current_window_connection_failures,
                current_window_deterministic_failures,
                connection_failure_streak, last_connection_failure_at::text,
                last_connection_backoff_at::text,
                elevated_windows, healthy_windows, last_window_failure_rate,
                last_window_connection_failure_rate,
                last_window_deterministic_failure_rate,
                last_window_completed_at::text, rolling_hour_requests,
                budget_limit, budget_breached,
                l1_last_started_at::text, l1_slo_degraded_since::text,
                l1_slo_expected_recovery_at::text, l1_slo_last_gap_seconds,
                l1_slo_overdue, last_pruned_at::text, updated_at::text`,
    [
      SITE_KEY,
      effective.level,
      effective.reason,
      toPgTimestamptz(effective.changedAtMs),
      effective.recoverNotBeforeMs === null
        ? null
        : toPgTimestamptz(effective.recoverNotBeforeMs),
      update.nextPermitAt ?? old.next_permit_at,
      update.currentWindowRequests ?? old.current_window_requests,
      update.currentWindowFailures ?? old.current_window_failures,
      update.currentWindowConnectionFailures ?? old.current_window_connection_failures,
      update.currentWindowDeterministicFailures
        ?? old.current_window_deterministic_failures,
      update.connectionPressureState?.failureStreak ?? old.connection_failure_streak,
      update.connectionPressureState?.lastFailureAtMs === undefined
        ? old.last_connection_failure_at
        : update.connectionPressureState.lastFailureAtMs === null
          ? null
          : toPgTimestamptz(update.connectionPressureState.lastFailureAtMs),
      update.connectionPressureState?.lastBackoffAtMs === undefined
        ? old.last_connection_backoff_at
        : update.connectionPressureState.lastBackoffAtMs === null
          ? null
          : toPgTimestamptz(update.connectionPressureState.lastBackoffAtMs),
      state.elevatedWindows,
      state.healthyWindows,
      update.lastWindowFailureRate === undefined
        ? old.last_window_failure_rate
        : update.lastWindowFailureRate,
      update.lastWindowConnectionFailureRate === undefined
        ? old.last_window_connection_failure_rate
        : update.lastWindowConnectionFailureRate,
      update.lastWindowDeterministicFailureRate === undefined
        ? old.last_window_deterministic_failure_rate
        : update.lastWindowDeterministicFailureRate,
      update.lastWindowCompletedAt === undefined
        ? old.last_window_completed_at
        : update.lastWindowCompletedAt,
      update.rollingHourRequests ?? old.rolling_hour_requests,
      policy.rollingBudgetRequests,
      budget.level > 0,
      update.lastPrunedAt ?? old.last_pruned_at,
      state.level,
      state.reason,
      toPgTimestamptz(state.changedAtMs),
      state.recoverNotBeforeMs === null ? null : toPgTimestamptz(state.recoverNotBeforeMs),
      budget.level,
      budget.reason,
      toPgTimestamptz(budget.changedAtMs),
      budget.minRequestIntervalMs,
      budget.throttleRatio,
      recoveryWindow.startedAtMs === null
        ? null
        : toPgTimestamptz(recoveryWindow.startedAtMs),
      recoveryWindow.requests,
      recoveryWindow.failures,
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
    level: asLevel(row.pressure_level),
    reason: row.pressure_reason,
    changedAtMs: Date.parse(row.pressure_changed_at),
    recoverNotBeforeMs:
      row.pressure_recover_not_before === null
        ? null
        : Date.parse(row.pressure_recover_not_before),
    elevatedWindows: row.elevated_windows,
    healthyWindows: row.healthy_windows,
    budgetBreached: false,
  };
}

function rowToBudgetState(row: ControlRow): BudgetControlState {
  return {
    level: asBudgetLevel(row.budget_level),
    reason: row.budget_reason,
    changedAtMs: Date.parse(row.budget_changed_at),
    minRequestIntervalMs: row.budget_min_interval_ms,
    throttleRatio: row.budget_throttle_ratio,
  };
}

function rowToRecoveryWindowState(row: ControlRow): RecoveryWindowState {
  return {
    startedAtMs: row.recovery_window_started_at === null
      ? null
      : Date.parse(row.recovery_window_started_at),
    requests: row.recovery_window_requests,
    failures: row.recovery_window_failures,
  };
}

function combineControlState(
  pressure: FailureWindowState,
  budget: BudgetControlState,
): {
  level: AdaptiveEgressLevel;
  reason: string;
  changedAtMs: number;
  recoverNotBeforeMs: number | null;
} {
  if (pressure.level > 0 && pressure.level >= budget.level) {
    return {
      level: pressure.level,
      reason: pressure.reason,
      changedAtMs: pressure.changedAtMs,
      recoverNotBeforeMs: pressure.recoverNotBeforeMs,
    };
  }
  if (budget.level > 0) {
    return {
      level: budget.level,
      reason: budget.reason,
      changedAtMs: budget.changedAtMs,
      recoverNotBeforeMs: null,
    };
  }
  return {
    level: 0,
    reason: pressure.reason,
    changedAtMs: Math.max(pressure.changedAtMs, budget.changedAtMs),
    recoverNotBeforeMs: null,
  };
}

function rowToConnectionPressureState(row: ControlRow): ConnectionPressureState {
  return {
    failureStreak: row.connection_failure_streak,
    lastFailureAtMs: row.last_connection_failure_at === null
      ? null
      : Date.parse(row.last_connection_failure_at),
    lastBackoffAtMs: row.last_connection_backoff_at === null
      ? null
      : Date.parse(row.last_connection_backoff_at),
  };
}

function rowToSnapshot(
  row: ControlRow,
  policy: AdaptiveEgressPolicy,
): AdaptiveEgressSnapshot {
  const level = asLevel(row.level);
  const pressureLevel = asLevel(row.pressure_level);
  const budgetLevel = asBudgetLevel(row.budget_level);
  const selectedTier = tier(policy, level);
  return {
    siteKey: row.site_key,
    level,
    levelName: selectedTier.name,
    minRequestIntervalMs: Math.max(
      tier(policy, pressureLevel).minIntervalMs,
      row.budget_min_interval_ms,
    ),
    reason: row.reason,
    changedAt: new Date(row.changed_at).toISOString(),
    recoverNotBefore:
      row.recover_not_before === null ? null : new Date(row.recover_not_before).toISOString(),
    pressureLevel,
    pressureReason: row.pressure_reason,
    pressureChangedAt: new Date(row.pressure_changed_at).toISOString(),
    pressureRecoverNotBefore: isoOrNull(row.pressure_recover_not_before),
    budgetLevel,
    budgetReason: row.budget_reason,
    budgetChangedAt: new Date(row.budget_changed_at).toISOString(),
    budgetMinRequestIntervalMs: row.budget_min_interval_ms,
    budgetThrottleRatio: row.budget_throttle_ratio,
    currentWindowRequests: row.current_window_requests,
    currentWindowFailures: row.current_window_failures,
    currentWindowConnectionFailures: row.current_window_connection_failures,
    currentWindowDeterministicFailures: row.current_window_deterministic_failures,
    connectionFailureStreak: row.connection_failure_streak,
    lastConnectionFailureAt: isoOrNull(row.last_connection_failure_at),
    lastConnectionBackoffAt: isoOrNull(row.last_connection_backoff_at),
    elevatedWindows: row.elevated_windows,
    healthyWindows: row.healthy_windows,
    healthyWindowsRequired: policy.healthyWindowsToRecover,
    recoveryWindowMinutes: Math.round(policy.recoveryWindowMs / 60_000),
    recoveryWindowStartedAt: isoOrNull(row.recovery_window_started_at),
    recoveryWindowRequests: row.recovery_window_requests,
    recoveryWindowFailures: row.recovery_window_failures,
    lastWindowFailureRate: row.last_window_failure_rate,
    lastWindowConnectionFailureRate: row.last_window_connection_failure_rate,
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

function asBudgetLevel(value: number): 0 | 1 {
  if (value === 0 || value === 1) return value;
  throw new Error(`数据库含非法预算档位 ${value}`);
}
