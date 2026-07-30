import { registerShutdownBarrier } from '../utils/db-connection.js';
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
        resetCircuit: pendingReset,
        // 协作式取消：收到信号后本轮不再开始新的收件人，
        // 但当前那条投递（占位→发送→记账）一定跑完。
        // 这样关停屏障等待的是「一次原子投递」而不是「一整轮」，
        // 多收件人时才不会撞上 15 秒超时、反而在中途被砍断。
        shouldStop: () => stopping
      });
      pendingReset = false;
      const ms = Date.now() - startedAt;
      // 无事可做的轮次不打日志，否则每分钟一行会把 pm2 日志刷满。
      // feature_disabled 要单独排除：功能下线时**每一轮**都会带上这个
      // skippedReason，照原样打就是每分钟一行刷到底 —— 正好破坏了上面这条本意。
      // 它只需在投递器首轮提示一次（那次由 job 内部打印），之后保持安静。
      const quietSkip = summary.skippedReason === 'feature_disabled';
      if (!quietSkip && (summary.candidates > 0 || summary.circuitTripped || summary.skippedReason)) {
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
  // 光装信号监听不够：db-connection 也监听同一个信号，且它会
  // disconnectPrisma() 之后直接 process.exit(0) —— 上面那两个监听器
  // 只来得及把 stopping 置位，进程就没了。真正在投递中途被砍断的话，
  // 那批候选下轮会重新入选，等机器人 15 分钟去重窗口一过就重复推送。
  // 注册一个关停屏障，让断连接与退出等到本轮结束。
  const unregisterBarrier = registerShutdownBarrier(async () => {
    if (!running) return;
    console.log('[notify] 关停中，等待当前投递收尾…');
    await stopPromise;
  });

  console.log(
    `[notify] 投递器启动：间隔 ${intervalSeconds}s`
    + `${options.dryRun ? '（dry-run，不会真的发送）' : ''}`
  );

  if (options.runImmediately) await runOneCycle('startup');
  else scheduleNext();

  await stopPromise;
  unregisterBarrier();
  console.log('[notify] 已停止');
}

/** 单次运行（用于手工排查与 --dry-run 演练） */
export async function runNotifyDispatchOnce(options: { dryRun: boolean; resetCircuit: boolean }): Promise<void> {
  // --once 同样要受关停屏障保护。
  //
  // 它一样会走「占位 PENDING → 调机器人 → 记账」这条关键区，
  // 在中间被 Ctrl-C 或 SIGTERM 打断的话，db-connection 的信号处理会
  // disconnectPrisma 并立刻 process.exit —— 留下的 PENDING 稍后被恢复重发，
  // 等机器人 15 分钟去重窗口一过，用户就收到重复消息。
  // 循环模式早就挂了屏障，手工执行这条路径之前一直没有。
  let stopping = false;
  let finished = false;
  let resolveDone: () => void = () => {};
  const done = new Promise<void>((r) => { resolveDone = r; });

  const onSignal = () => {
    stopping = true;
    if (!finished) console.log('[notify] 收到停止信号，等待当前投递收尾…');
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  const unregisterBarrier = registerShutdownBarrier(async () => {
    if (finished) return;
    await done;
  });

  try {
    const summary = await runNotificationDispatch({ ...options, shouldStop: () => stopping });
    console.log(`[notify] ${formatSummary(summary)}`);
  } finally {
    finished = true;
    resolveDone();
    unregisterBarrier();
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
}
