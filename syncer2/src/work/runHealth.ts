/**
 * 所有采集 CLI 的整轮健康裁决。
 *
 * 对象级失败先分类、终结或退避；只有系统性信号才升级整轮失败。确定性失败会让
 * 本轮成为 partial，但不进入失败率分子，因为同代码重试不会成功、也不代表采集面失灵。
 */

import type { AdaptiveSelfProtectionDecision } from '../http/adaptiveEgress.js';

export const RUN_FAILURE_RATE_THRESHOLD = 0.25;
const RUN_FAILURE_RATE_MIN_FAILURES = 2;
export const RUN_REPEATED_FAILURE_ATTEMPTS = 3;

type CollectionRunStatus = 'ok' | 'partial' | 'failed' | 'aborted';

export interface RunHealthInput {
  /** 覆盖本次判定的失败率阈值；省略则用 RUN_FAILURE_RATE_THRESHOLD。 */
  failureRateThreshold?: number;
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

/**
 * 持久化整轮跳过不能伪装成正常 partial；交给统一 run health 产生 failed + exit 1。
 *
 * 但「跳过」有两种来源，只有一种是异常：
 *  - **不可信整轮**（缺批、结构损坏、重复异常放大）：证据本身不可用，必须响。
 *  - **自愈型跳过**：零星批失败（下轮重扫）与单轮时间预算收敛。
 *    两者都不推进状态、不入队、不喂缺失推断，下一轮自然补上，属于自我保护而非故障。
 *
 * 事故：此前该判据对所有跳过一律 fatal，同时撤销了两个既有设计——
 * 零星批失败本已从 failed 降级为 partial（避免站点偶发 503 产生必然自愈的告警，
 * L1 提频到 5 分钟后命中概率翻三倍），预算耗尽本已定为正常收敛 exit 0。
 * 于是「自我保护」再次被报成「故障」，正是该判据想解决的问题的反面。
 *
 * selfHealing **必填、无默认值**：本判据在 incremental-scan 有两个调用点
 * （正常分支与 RuntimeBudgetExceededError 的 catch 分支），第一次修复只改了正常分支，
 * 于是出口降档期间 L1 每 5 分钟仍报一次必然自愈的告警。同文件的既有注释早已写过
 * 这条教训——「验证了逻辑，没验证逻辑被用到」。给默认值等于允许调用点不表态，
 * 因此这里由类型系统强制每处显式声明。
 */
export function persistenceSkipFatalReasons(skipped: boolean, selfHealing: boolean): string[] {
  return skipped && !selfHealing ? ['persistence_skipped'] : [];
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
  // 全部 claim 因协作式时间预算/写冻结而主动释放时是正常 partial，不是零进展故障。
  const zeroProgress = input.claimed > deferred && input.processed === 0;
  /*
   * 阈值可按链路覆盖：站外图床（wdfiles 等）实测瞬时失败率稳定在 25% 上下，
   * 用主站的标准衡量它等于把「A 站健康线」当成「所有出站的健康线」。
   * 未显式传入时仍用统一阈值——wikidot 主站不放宽。
   */
  const threshold = input.failureRateThreshold ?? RUN_FAILURE_RATE_THRESHOLD;
  const highFailureRate =
    retryableFailures >= RUN_FAILURE_RATE_MIN_FAILURES &&
    failureRate !== null &&
    failureRate >= threshold;
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
