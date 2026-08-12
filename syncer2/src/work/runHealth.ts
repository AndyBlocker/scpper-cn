/**
 * 所有采集 CLI 的整轮健康裁决。
 *
 * 对象级失败先分类、终结或退避；只有系统性信号才升级整轮失败。确定性失败会让
 * 本轮成为 partial，但不进入失败率分子，因为同代码重试不会成功、也不代表采集面失灵。
 */

import type { AdaptiveSelfProtectionDecision } from '../http/adaptiveEgress.js';

export const RUN_FAILURE_RATE_THRESHOLD = 0.25;
export const RUN_FAILURE_RATE_MIN_FAILURES = 2;
export const RUN_REPEATED_FAILURE_ATTEMPTS = 3;

/** 兼容既有运维/测试引用；判据只有上面这一份。 */
export const WORK_QUEUE_FAILURE_RATE_THRESHOLD = RUN_FAILURE_RATE_THRESHOLD;
export const WORK_QUEUE_FAILURE_RATE_MIN_FAILURES = RUN_FAILURE_RATE_MIN_FAILURES;
export const WORK_QUEUE_REPEATED_FAILURE_ATTEMPTS = RUN_REPEATED_FAILURE_ATTEMPTS;

export type CollectionRunStatus = 'ok' | 'partial' | 'failed' | 'aborted';

export interface RunHealthInput {
  /** 本轮获得、计划或应处理的对象/批次。空队列传 0。 */
  claimed: number;
  /** 已得到成功、partial、可重试失败或确定性终态的对象/批次。 */
  processed: number;
  /** 有正向进展但证据不完整的对象/批次。 */
  partial: number;
  /** 全部对象级失败；必须包含 deterministicFailures。 */
  failed: number;
  /** classifyWorkFailure 已归类为不可重试/身份不存在的失败子集。 */
  deterministicFailures?: number;
  /** 写冻结、时间预算等主动延后；只把状态降为 partial，不进入失败率。 */
  deferred?: number;
  /** @deprecated 使用 deferred。 */
  writeFreezeSkipped?: number;
  /** 同一仍可重试对象已跨轮达到重试阈值的数量。 */
  repeatedFailures?: number;
  breakerOpen?: boolean;
  stoppedByFailureLimit?: boolean;
  /** 解析覆盖、数据不变量等不能用对象比例表达的系统性红线。 */
  fatalReasons?: readonly string[];
}

export interface RunHealthDecision {
  status: CollectionRunStatus;
  exitCode: 0 | 1;
  /** 可重试失败 / processed；确定性失败明确不在分子。 */
  failureRate: number | null;
  retryableFailures: number;
  deterministicFailures: number;
  reasons: string[];
}

export function evaluateRunHealth(input: RunHealthInput): RunHealthDecision {
  assertRunHealthInput(input);
  const deterministicFailures = input.deterministicFailures ?? 0;
  const retryableFailures = input.failed - deterministicFailures;
  const repeatedFailures = input.repeatedFailures ?? 0;
  const deferred = (input.deferred ?? 0) + (input.writeFreezeSkipped ?? 0);
  const fatalReasons = [...new Set((input.fatalReasons ?? []).filter(Boolean))];
  const failureRate = input.processed === 0
    ? null
    : retryableFailures / input.processed;
  const zeroProgress = input.claimed > 0 && input.processed === 0;
  const highFailureRate =
    retryableFailures >= RUN_FAILURE_RATE_MIN_FAILURES &&
    failureRate !== null &&
    failureRate >= RUN_FAILURE_RATE_THRESHOLD;
  const reasons: string[] = [];

  if (input.breakerOpen === true) reasons.push('http_breaker_open');
  if (input.stoppedByFailureLimit === true) reasons.push('consecutive_failure_limit');
  if (zeroProgress) reasons.push('zero_progress');
  if (highFailureRate) reasons.push('high_failure_rate');
  if (repeatedFailures > 0) reasons.push('repeated_cross_run_failure');
  reasons.push(...fatalReasons);

  const base = { failureRate, retryableFailures, deterministicFailures, reasons };
  if (input.breakerOpen === true) {
    return { status: 'aborted', exitCode: 1, ...base };
  }
  if (
    input.stoppedByFailureLimit === true ||
    zeroProgress ||
    highFailureRate ||
    repeatedFailures > 0 ||
    fatalReasons.length > 0
  ) {
    return { status: 'failed', exitCode: 1, ...base };
  }
  if (input.failed > 0 || input.partial > 0 || deferred > 0) {
    return { status: 'partial', exitCode: 0, ...base };
  }
  return { status: 'ok', exitCode: 0, ...base };
}

function assertRunHealthInput(input: RunHealthInput): void {
  const values = {
    claimed: input.claimed,
    processed: input.processed,
    partial: input.partial,
    failed: input.failed,
    deterministicFailures: input.deterministicFailures ?? 0,
    deferred: input.deferred ?? 0,
    writeFreezeSkipped: input.writeFreezeSkipped ?? 0,
    repeatedFailures: input.repeatedFailures ?? 0,
  };
  for (const [name, value] of Object.entries(values)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError(`run health ${name} 必须是非负安全整数，收到 ${value}`);
    }
  }
  if (values.deterministicFailures > input.failed) {
    throw new RangeError(
      `run health deterministicFailures=${values.deterministicFailures} 不能大于 failed=${input.failed}`,
    );
  }
}

export interface ProtectedRunHealthDecision extends RunHealthDecision {
  baseExitCode: 0 | 1;
  selfProtection: AdaptiveSelfProtectionDecision;
}

/**
 * 降档造成的“本轮来不及处理任何任务”是预期吞吐，不是 unit failure。连接 streak 已让
 * 共享 gate 降档后，本地 breaker 的 aborted 同样是可解释的停手动作：保留 aborted 与
 * 全部故障证据，但预期恢复期内 exit 0；恢复截止超期才非零。其它故障仍保留原判据。
 */
export function applyAdaptiveSelfProtectionToRunHealth(
  base: RunHealthDecision,
  selfProtection: AdaptiveSelfProtectionDecision,
): ProtectedRunHealthDecision {
  const throughputOnlyFailure =
    base.exitCode === 1 &&
    base.reasons.length > 0 &&
    base.reasons.every((reason) => reason === 'zero_progress');
  if (selfProtection.overdue) {
    return {
      ...base,
      status: 'failed',
      exitCode: 1,
      baseExitCode: base.exitCode,
      reasons: [...new Set([...base.reasons, 'adaptive_downshift_recovery_overdue'])],
      selfProtection,
    };
  }
  if (
    base.status === 'aborted'
    && base.reasons.includes('http_breaker_open')
    && selfProtection.active
  ) {
    return {
      ...base,
      status: 'aborted',
      exitCode: 0,
      baseExitCode: base.exitCode,
      reasons: [...new Set([...base.reasons, 'circuit_breaker_self_protection_expected'])],
      selfProtection,
    };
  }
  if (selfProtection.active && throughputOnlyFailure) {
    return {
      ...base,
      status: 'partial',
      exitCode: 0,
      baseExitCode: base.exitCode,
      reasons: [...base.reasons, 'adaptive_downshift_expected'],
      selfProtection,
    };
  }
  return { ...base, baseExitCode: base.exitCode, selfProtection };
}

/** @deprecated 新代码直接调用 evaluateRunHealth。 */
export const evaluateWorkQueueHealth = evaluateRunHealth;
/** @deprecated 新代码直接调用 applyAdaptiveSelfProtectionToRunHealth。 */
export const applyAdaptiveSelfProtectionToWorkQueueHealth =
  applyAdaptiveSelfProtectionToRunHealth;
export type WorkQueueRunStatus = CollectionRunStatus;
export type WorkQueueHealthInput = RunHealthInput;
export type WorkQueueHealthDecision = RunHealthDecision;
export type ProtectedWorkQueueHealthDecision = ProtectedRunHealthDecision;
