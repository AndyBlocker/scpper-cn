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

export class RuntimeBudgetExceededError extends Error {
  override readonly name = 'RuntimeBudgetExceededError';

  constructor(readonly deadlineAtMs: number) {
    super(`单轮墙钟预算已耗尽（deadline=${new Date(deadlineAtMs).toISOString()}）`);
  }
}

export function isRuntimeBudgetExceededError(error: unknown): boolean {
  return error instanceof RuntimeBudgetExceededError
    || (error instanceof Error && error.name === 'RuntimeBudgetExceededError');
}

export function throwIfRuntimeBudgetExceeded(error: unknown): void {
  if (isRuntimeBudgetExceededError(error)) throw error;
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) return;
  const reason = signal.reason;
  throw reason instanceof Error ? reason : new Error(String(reason ?? 'aborted'));
}

export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      signal?.removeEventListener('abort', aborted);
      resolve();
    }
    function aborted(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', aborted);
      try {
        throwIfAborted(signal);
      } catch (error) {
        reject(error);
      }
    }
    signal?.addEventListener('abort', aborted, { once: true });
    // AbortSignal 不会为“注册前已经触发”的 listener 补发事件；二次检查堵住
    // 首次 throwIfAborted 与 addEventListener 之间的极窄竞态。
    if (signal?.aborted === true) aborted();
  });
}

/**
 * 所有短进程 CLI 共用的 `--max-runtime-sec` 入口。
 *
 * systemd TimeoutStartSec 是最后一道 SIGTERM 硬闸；这里是更早的协作式软闸。
 * 调用方只在任务/批次/事务边界调用 checkpoint()，让正在执行的原子工作完成，
 * 随后结账并释放尚未开始的 claim。预算命中是正常收敛，不抛异常。
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

export class RuntimeBudget {
  readonly maxRuntimeSec: number;
  readonly startedAtMs: number;
  readonly deadlineAtMs: number;
  readonly signal: AbortSignal;

  readonly #clock: Clock;
  readonly #controller = new AbortController();
  #stopped = false;

  constructor(maxRuntimeSec: number, clock: Clock = Date.now) {
    this.maxRuntimeSec = parseRuntimeBudgetSec(maxRuntimeSec);
    this.#clock = clock;
    this.startedAtMs = clock();
    if (!Number.isFinite(this.startedAtMs)) {
      throw new RangeError(`runtime budget clock 非法：${String(this.startedAtMs)}`);
    }
    // maxRuntime 是整个进程的墙钟上限，不只是“开始新工作”的截止点。预留至多 2 秒
    // 给落 ingest_run、释放 claim 与关闭连接，避免摘要在 300.7s 才出现。
    const shutdownReserveMs = Math.min(2_000, this.maxRuntimeSec * 100);
    this.deadlineAtMs = this.startedAtMs + this.maxRuntimeSec * 1_000 - shutdownReserveMs;
    this.signal = this.#controller.signal;
    const timer = setTimeout(() => this.#stop(), Math.max(0, this.deadlineAtMs - clock()));
    timer.unref();
  }

  /** 命中后保持 latch=true，后续收尾阶段不会因时钟回拨重新启动工作。 */
  checkpoint(): boolean {
    if (!this.#stopped && this.#clock() >= this.deadlineAtMs) this.#stop();
    return this.#stopped;
  }

  #stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#controller.abort(new RuntimeBudgetExceededError(this.deadlineAtMs));
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
