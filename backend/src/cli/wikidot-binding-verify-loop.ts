import { analyzeIncremental } from '../jobs/IncrementalAnalyzeJob.js';

type WikidotBindingVerifyLoopOptions = {
  intervalSeconds: number;
  runImmediately: boolean;
};

function formatDurationMs(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

export async function runWikidotBindingVerifyLoop(options: WikidotBindingVerifyLoopOptions): Promise<void> {
  const intervalSeconds = Number.isFinite(options.intervalSeconds)
    ? Math.max(30, Math.floor(options.intervalSeconds))
    : 300;
  const intervalMs = intervalSeconds * 1000;

  let running = false;
  let stopping = false;
  let timer: NodeJS.Timeout | null = null;
  let resolveStopPromise: (() => void) | null = null;

  const stopPromise = new Promise<void>((resolve) => {
    resolveStopPromise = resolve;
  });

  const resolveStop = () => {
    if (!resolveStopPromise) return;
    const resolve = resolveStopPromise;
    resolveStopPromise = null;
    resolve();
  };

  const scheduleNext = () => {
    if (stopping) return;
    const nextRunAt = new Date(Date.now() + intervalMs);
    console.log(`[wikidot-binding-verify] Next trigger at ${nextRunAt.toISOString()}`);
    timer = setTimeout(() => {
      void runOneCycle('scheduled');
    }, intervalMs);
  };

  const handleStopSignal = (signal: NodeJS.Signals) => {
    if (stopping) return;
    stopping = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    console.log(`[wikidot-binding-verify] Received ${signal}, waiting for current cycle to finish...`);
    if (!running) {
      resolveStop();
    }
  };

  const runOneCycle = async (reason: 'startup' | 'scheduled') => {
    if (running) {
      console.log(`[wikidot-binding-verify] Skip ${reason} trigger: previous cycle is still running.`);
      scheduleNext();
      return;
    }

    running = true;
    const startedAt = Date.now();
    console.log(`[wikidot-binding-verify] Cycle started (${reason}) at ${new Date(startedAt).toISOString()}`);

    try {
      await analyzeIncremental({ tasks: ['wikidot_binding_verify'] });
    } catch (error) {
      const message = error instanceof Error ? error.stack || error.message : String(error);
      console.error(`[wikidot-binding-verify] Cycle failed: ${message}`);
    } finally {
      const elapsed = Date.now() - startedAt;
      console.log(`[wikidot-binding-verify] Cycle finished in ${formatDurationMs(elapsed)}.`);
      running = false;
      if (stopping) {
        resolveStop();
      } else {
        scheduleNext();
      }
    }
  };

  process.on('SIGINT', handleStopSignal);
  process.on('SIGTERM', handleStopSignal);

  console.log(`[wikidot-binding-verify] Scheduler started. interval=${intervalSeconds}s`);
  if (options.runImmediately) {
    void runOneCycle('startup');
  } else {
    scheduleNext();
  }

  await stopPromise;
}
