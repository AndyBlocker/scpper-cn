import { runNotificationDispatch, type DispatchSummary } from '../jobs/NotificationDispatchJob.js';

type LoopOptions = {
  intervalSeconds: number;
  runImmediately: boolean;
  dryRun: boolean;
  resetCircuit: boolean;
};

function formatSummary(s: DispatchSummary): string {
  const parts = [
    `targets=${s.targets}`,
    `candidates=${s.candidates}`,
    `sent=${s.sent}`,
    `suppressed=${s.suppressed}`,
    `failed=${s.failed}`
  ];
  if (s.circuitTripped) parts.push('CIRCUIT_TRIPPED');
  if (s.skippedReason) parts.push(`skipped=${s.skippedReason}`);
  return parts.join(' ');
}

/**
 * 循环骨架照抄 wikidot-binding-verify-loop：单实例、不重入、收到信号后等当前轮跑完再退出。
 * 不重入很重要 —— 两轮并发扫描会在反连接与插入之间制造竞态，可能重复推送。
 */
export async function runNotifyDispatchLoop(options: LoopOptions): Promise<void> {
  const intervalSeconds = Number.isFinite(options.intervalSeconds)
    ? Math.max(15, Math.floor(options.intervalSeconds))
    : 60;
  const intervalMs = intervalSeconds * 1000;

  let running = false;
  let stopping = false;
  let timer: NodeJS.Timeout | null = null;
  let resolveStopPromise: (() => void) | null = null;
  // --reset-circuit 只在第一轮生效，避免每轮都把熔断复位掉（那等于没有熔断）
  let pendingReset = options.resetCircuit;

  const stopPromise = new Promise<void>((resolve) => { resolveStopPromise = resolve; });
  const resolveStop = () => {
    if (!resolveStopPromise) return;
    const r = resolveStopPromise;
    resolveStopPromise = null;
    r();
  };

  const scheduleNext = () => {
    if (stopping) return;
    timer = setTimeout(() => { void runOneCycle('scheduled'); }, intervalMs);
  };

  const handleStopSignal = (signal: NodeJS.Signals) => {
    if (stopping) return;
    stopping = true;
    if (timer) { clearTimeout(timer); timer = null; }
    console.log(`[notify] 收到 ${signal}，等待当前轮结束…`);
    if (!running) resolveStop();
  };

  const runOneCycle = async (reason: 'startup' | 'scheduled') => {
    if (running || stopping) return;
    running = true;
    const startedAt = Date.now();
    try {
      const summary = await runNotificationDispatch({
        dryRun: options.dryRun,
        resetCircuit: pendingReset
      });
      pendingReset = false;
      const ms = Date.now() - startedAt;
      // 无事可做的轮次不打日志，否则每分钟一行会把 pm2 日志刷满
      if (summary.candidates > 0 || summary.circuitTripped || summary.skippedReason) {
        console.log(`[notify] ${reason} 完成（${ms}ms）：${formatSummary(summary)}`);
      }
    } catch (error) {
      console.error('[notify] 本轮失败：', error instanceof Error ? error.message : error);
    } finally {
      running = false;
      if (stopping) resolveStop();
      else scheduleNext();
    }
  };

  process.on('SIGINT', handleStopSignal);
  process.on('SIGTERM', handleStopSignal);

  console.log(
    `[notify] 投递器启动：间隔 ${intervalSeconds}s`
    + `${options.dryRun ? '（dry-run，不会真的发送）' : ''}`
  );

  if (options.runImmediately) await runOneCycle('startup');
  else scheduleNext();

  await stopPromise;
  console.log('[notify] 已停止');
}

/** 单次运行（用于手工排查与 --dry-run 演练） */
export async function runNotifyDispatchOnce(options: { dryRun: boolean; resetCircuit: boolean }): Promise<void> {
  const summary = await runNotificationDispatch(options);
  console.log(`[notify] ${formatSummary(summary)}`);
}
