import type { Command } from 'commander';

export interface RuntimeBudgetOptionSpec {
  /** 非 schedule 手工调用时的保守默认；生产调度仍必须显式传参。 */
  defaultSec: number;
  minSec?: number;
  maxSec?: number;
  description?: string;
}

export interface RuntimeBudgetSummary {
  maxRuntimeSec: number;
  stoppedByRuntimeBudget: boolean;
  runtimeBudgetElapsedMs: number;
  runtimeBudgetRemainingMs: number;
}

type Clock = () => number;

/**
 * 所有短进程 CLI 共用的 `--max-runtime-sec` 入口。
 *
 * systemd TimeoutStartSec 是最后一道 SIGTERM 硬闸；这里是更早的协作式软闸。
 * 调用方在任务/批次/事务边界调用 checkpoint()，并可把 assertRequestBoundary()
 * 注入 HttpClient：任务仍原子收尾，但重试/下一次真实出站不会越过软截止时间。
 */
export function addRuntimeBudgetOption(
  command: Command,
  spec: RuntimeBudgetOptionSpec,
): Command {
  const minSec = spec.minSec ?? 1;
  const maxSec = spec.maxSec ?? 24 * 60 * 60;
  const defaultSec = parseRuntimeBudgetSec(spec.defaultSec, { minSec, maxSec });
  return command.option(
    '--max-runtime-sec <n>',
    spec.description ?? `单轮墙钟预算（${minSec}-${maxSec} 秒）`,
    Number,
    defaultSec,
  );
}

export function parseRuntimeBudgetSec(
  value: number,
  bounds: { minSec?: number; maxSec?: number } = {},
): number {
  const minSec = bounds.minSec ?? 1;
  const maxSec = bounds.maxSec ?? 24 * 60 * 60;
  if (!Number.isSafeInteger(minSec) || !Number.isSafeInteger(maxSec) || minSec < 1 || maxSec < minSec) {
    throw new RangeError(`runtime budget 边界非法：${minSec}..${maxSec}`);
  }
  if (!Number.isSafeInteger(value) || value < minSec || value > maxSec) {
    throw new RangeError(`--max-runtime-sec 必须是 ${minSec}..${maxSec} 的整数，收到 ${String(value)}`);
  }
  return value;
}

export class RuntimeBudgetExceededError extends Error {
  override readonly name = 'RuntimeBudgetExceededError';

  constructor(readonly deadlineAtMs: number) {
    super(`runtime budget reached before HTTP attempt (deadline=${deadlineAtMs})`);
  }
}

export function isRuntimeBudgetExceededError(error: unknown): error is RuntimeBudgetExceededError {
  return error instanceof RuntimeBudgetExceededError;
}

export function rethrowRuntimeBudgetExceeded(error: unknown): void {
  if (isRuntimeBudgetExceededError(error)) throw error;
}

export class RuntimeBudget {
  readonly maxRuntimeSec: number;
  readonly startedAtMs: number;
  readonly deadlineAtMs: number;

  readonly #clock: Clock;
  #stopped = false;

  constructor(maxRuntimeSec: number, clock: Clock = Date.now) {
    this.maxRuntimeSec = parseRuntimeBudgetSec(maxRuntimeSec);
    this.#clock = clock;
    this.startedAtMs = clock();
    if (!Number.isFinite(this.startedAtMs)) {
      throw new RangeError(`runtime budget clock 非法：${String(this.startedAtMs)}`);
    }
    this.deadlineAtMs = this.startedAtMs + this.maxRuntimeSec * 1_000;
  }

  /** 命中后保持 latch=true，后续收尾阶段不会因时钟回拨重新启动工作。 */
  checkpoint(): boolean {
    if (!this.#stopped && this.#clock() >= this.deadlineAtMs) this.#stopped = true;
    return this.#stopped;
  }

  /** HttpClient 每次真实出站（含 retry/redirect）前调用；命中后由 CLI 走正常释放路径。 */
  assertRequestBoundary(): void {
    if (this.checkpoint()) throw new RuntimeBudgetExceededError(this.deadlineAtMs);
  }

  get stoppedByRuntimeBudget(): boolean {
    return this.#stopped;
  }

  summary(): RuntimeBudgetSummary {
    const elapsedMs = Math.max(0, this.#clock() - this.startedAtMs);
    return {
      maxRuntimeSec: this.maxRuntimeSec,
      stoppedByRuntimeBudget: this.#stopped,
      runtimeBudgetElapsedMs: elapsedMs,
      runtimeBudgetRemainingMs: Math.max(0, this.deadlineAtMs - this.#clock()),
    };
  }
}
