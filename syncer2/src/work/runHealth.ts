/**
 * work-queue 整轮健康裁决。页级失败先留在页级；只有系统性信号才升级整轮失败。
 */

export const WORK_QUEUE_FAILURE_RATE_THRESHOLD = 0.25;
export const WORK_QUEUE_FAILURE_RATE_MIN_FAILURES = 2;
export const WORK_QUEUE_REPEATED_FAILURE_ATTEMPTS = 3;

export type WorkQueueRunStatus = 'ok' | 'partial' | 'failed' | 'aborted';

export interface WorkQueueHealthInput {
  claimed: number;
  processed: number;
  partial: number;
  failed: number;
  writeFreezeSkipped: number;
  repeatedFailures: number;
  breakerOpen: boolean;
  stoppedByFailureLimit: boolean;
}

export interface WorkQueueHealthDecision {
  status: WorkQueueRunStatus;
  exitCode: 0 | 1;
  failureRate: number | null;
  reasons: string[];
}

export function evaluateWorkQueueHealth(
  input: WorkQueueHealthInput,
): WorkQueueHealthDecision {
  const failureRate = input.processed === 0 ? null : input.failed / input.processed;
  const zeroProgress =
    input.claimed > 0 &&
    input.processed === 0;
  const highFailureRate =
    input.failed >= WORK_QUEUE_FAILURE_RATE_MIN_FAILURES &&
    failureRate !== null &&
    failureRate >= WORK_QUEUE_FAILURE_RATE_THRESHOLD;
  const reasons: string[] = [];

  if (input.breakerOpen) reasons.push('http_breaker_open');
  if (input.stoppedByFailureLimit) reasons.push('consecutive_failure_limit');
  if (zeroProgress) reasons.push('zero_progress');
  if (highFailureRate) reasons.push('high_failure_rate');
  if (input.repeatedFailures > 0) reasons.push('repeated_cross_run_failure');

  if (input.breakerOpen) {
    return { status: 'aborted', exitCode: 1, failureRate, reasons };
  }
  if (
    input.stoppedByFailureLimit ||
    zeroProgress ||
    highFailureRate ||
    input.repeatedFailures > 0
  ) {
    return { status: 'failed', exitCode: 1, failureRate, reasons };
  }
  if (
    input.failed > 0 ||
    input.partial > 0 ||
    input.writeFreezeSkipped > 0
  ) {
    return { status: 'partial', exitCode: 0, failureRate, reasons };
  }
  return { status: 'ok', exitCode: 0, failureRate, reasons };
}
