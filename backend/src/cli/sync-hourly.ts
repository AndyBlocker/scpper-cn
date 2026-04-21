import { sync } from './sync.js';
import { syncGachaPool } from './gacha-sync.js';
import { ForumSyncProcessor } from '../core/processors/ForumSyncProcessor.js';
import { WikidotForumClient } from '../core/client/WikidotForumClient.js';
import { analyzeIncremental } from '../jobs/IncrementalAnalyzeJob.js';
import { runPageEmbeddingIncremental } from '../jobs/PageEmbeddingBackfillJob.js';

type SyncHourlySchedulerOptions = {
  concurrency: string;
  runImmediately: boolean;
  runGacha: boolean;
  runForum: boolean;
  runEmbed: boolean;
};

const STALE_PROGRESS_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes
const SYNC_RETRY_ATTEMPTS = Math.max(1, Math.floor(Number(process.env.SYNC_HOURLY_SYNC_RETRY_ATTEMPTS ?? '3') || 3));
const FORUM_RETRY_ATTEMPTS = Math.max(1, Math.floor(Number(process.env.SYNC_HOURLY_FORUM_RETRY_ATTEMPTS ?? '2') || 2));
const RETRY_BASE_DELAY_MS = Math.max(1000, Math.floor(Number(process.env.SYNC_HOURLY_RETRY_BASE_DELAY_MS ?? '15000') || 15000));

function nextTopOfHourDelayMs(now = new Date()): number {
  const next = new Date(now);
  next.setMinutes(0, 0, 0);
  next.setHours(next.getHours() + 1);
  return Math.max(1000, next.getTime() - now.getTime());
}

function formatDurationMs(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stringifyError(error: unknown): string {
  if (error instanceof Error) {
    const code = typeof (error as { code?: unknown }).code === 'string' ? ` ${(error as { code?: string }).code}` : '';
    return `${error.name}${code}: ${error.message}`;
  }
  return String(error);
}

function isTransientNetworkError(error: unknown): boolean {
  const code = (error && typeof error === 'object' && 'code' in error)
    ? String((error as { code?: unknown }).code || '').toUpperCase()
    : '';
  if (['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'UND_ERR_CONNECT_TIMEOUT'].includes(code)) {
    return true;
  }

  const rawMessage = stringifyError(error).toLowerCase();
  return (
    rawMessage.includes('fetch failed')
    || rawMessage.includes('socket hang up')
    || rawMessage.includes('network error')
    || rawMessage.includes('connect timeout')
    || rawMessage.includes('request timeout')
    || rawMessage.includes('timed out')
    || rawMessage.includes('bad gateway')
    || rawMessage.includes('gateway timeout')
    || rawMessage.includes('service unavailable')
    || rawMessage.includes('econnreset')
    || rawMessage.includes('econnrefused')
    || rawMessage.includes('etimedout')
    || rawMessage.includes('eai_again')
    || rawMessage.includes('enotfound')
    || rawMessage.includes(' 502')
    || rawMessage.includes(' 503')
    || rawMessage.includes(' 504')
  );
}

async function runWithTransientRetry<T>(label: string, attempts: number, task: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      lastError = error;
      const retryable = isTransientNetworkError(error);
      if (!retryable || attempt >= attempts) {
        throw error;
      }
      const delayMs = RETRY_BASE_DELAY_MS * attempt;
      console.error(
        `[sync-hourly] ${label} transient failure (attempt ${attempt}/${attempts}): ${stringifyError(error)}; retrying in ${Math.round(delayMs / 1000)}s`
      );
      await sleep(delayMs);
    }
  }
  throw lastError ?? new Error(`${label} failed after retries`);
}

export async function runSyncHourlyScheduler(options: SyncHourlySchedulerOptions): Promise<void> {
  let running = false;
  let stopping = false;
  let timer: NodeJS.Timeout | null = null;
  let resolveStopPromise: (() => void) | null = null;

  const stopPromise = new Promise<void>((resolve) => {
    resolveStopPromise = resolve;
  });

  const resolveStop = () => {
    if (resolveStopPromise) {
      const resolve = resolveStopPromise;
      resolveStopPromise = null;
      resolve();
    }
  };

  const scheduleNext = () => {
    if (stopping) return;
    const now = new Date();
    const delayMs = nextTopOfHourDelayMs(now);
    const nextRunAt = new Date(now.getTime() + delayMs);
    console.log(`[sync-hourly] Next trigger at ${nextRunAt.toISOString()}`);
    timer = setTimeout(() => {
      scheduleNext();
      void runOneCycle('scheduled');
    }, delayMs);
  };

  const handleStopSignal = (signal: NodeJS.Signals) => {
    if (stopping) return;
    stopping = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    console.log(`[sync-hourly] Received ${signal}, waiting for current cycle to finish...`);
    if (!running) {
      resolveStop();
    }
  };

  const runOneCycle = async (reason: 'startup' | 'scheduled') => {
    if (running) {
      console.log(`[sync-hourly] Skip ${reason} trigger: previous cycle is still running.`);
      return;
    }
    running = true;
    const startedAt = Date.now();
    console.log(`[sync-hourly] Cycle started (${reason}) at ${new Date(startedAt).toISOString()}`);

    try {
      // Stale progress watchdog: abort if no progress for 15 minutes
      let lastProgressAt = Date.now();
      const onProgress = () => { lastProgressAt = Date.now(); };

      const syncPromise = runWithTransientRetry('sync', SYNC_RETRY_ATTEMPTS, async () => sync({
        phase: 'all',
        concurrency: options.concurrency,
        full: false,
        testMode: false,
        onProgress,
        analysisFatal: false
      }));

      const watchdogPromise = new Promise<never>((_, reject) => {
        const timer = setInterval(() => {
          const staleMs = Date.now() - lastProgressAt;
          if (staleMs > STALE_PROGRESS_TIMEOUT_MS) {
            clearInterval(timer);
            const staleMin = Math.round(staleMs / 60000);
            reject(new Error(
              `Sync stale timeout: no progress for ${staleMin} minutes, aborting cycle`
            ));
          }
        }, 30_000);
        timer.unref();
        // Observe both resolve/reject paths so a handled sync failure does not
        // re-surface as an unhandled rejection and crash the scheduler process.
        void syncPromise.then(
          () => clearInterval(timer),
          () => clearInterval(timer)
        );
      });

      const syncResult = await Promise.race([syncPromise, watchdogPromise]);

      if ((syncResult as { skipped?: boolean } | undefined)?.skipped) {
        console.log('[sync-hourly] Sync skipped by global sync lock. Skip gacha-sync for this cycle.');
        return;
      }

      // Forum sync (non-fatal)
      if (options.runForum) {
        try {
          const forumResult = await runWithTransientRetry('forum-sync', FORUM_RETRY_ATTEMPTS, async () => {
            WikidotForumClient.setupProxy();
            const forumProcessor = new ForumSyncProcessor({ full: false });
            return forumProcessor.run();
          });
          console.log(`[sync-hourly] Forum sync done: ${forumResult.categoriesSynced} categories, ${forumResult.postsSynced} posts`);
          await analyzeIncremental({ tasks: ['user_data_completeness'] });
          console.log('[sync-hourly] User activity completeness refreshed after forum sync.');
        } catch (forumErr: any) {
          const msg = forumErr instanceof Error ? forumErr.message : String(forumErr);
          console.error(`[sync-hourly] Forum sync failed (non-fatal): ${msg}`);
        }
      } else {
        console.log('[sync-hourly] forum-sync disabled by option, skipping.');
      }

      if (options.runGacha) {
        await syncGachaPool();
      } else {
        console.log('[sync-hourly] gacha-sync disabled by option, skipping.');
      }

      // Page embeddings incremental (non-fatal; embedding server may be offline).
      // `runPageEmbeddingIncremental` has its own cap (default 500) so one cycle
      // can't stall the scheduler — anything still behind is picked up next hour.
      if (options.runEmbed) {
        try {
          const embedResult = await runPageEmbeddingIncremental({ limit: 500, batchSize: 8 });
          console.log(`[sync-hourly] Embedding incremental done: PV=${embedResult.totalPages} chunks=${embedResult.totalChunks} written=${embedResult.written} (truncated=${embedResult.truncatedChunks}, skippedEmpty=${embedResult.skippedEmptyPages}, durationMs=${embedResult.durationMs}).`);
        } catch (embedErr: any) {
          const msg = embedErr instanceof Error ? embedErr.message : String(embedErr);
          console.error(`[sync-hourly] Embedding incremental failed (non-fatal): ${msg}`);
        }
      } else {
        console.log('[sync-hourly] embed-incremental disabled by option, skipping.');
      }
    } catch (error: any) {
      const message = error instanceof Error ? error.stack || error.message : String(error);
      console.error(`[sync-hourly] Cycle failed: ${message}`);
    } finally {
      const elapsed = Date.now() - startedAt;
      console.log(`[sync-hourly] Cycle finished in ${formatDurationMs(elapsed)}.`);
      running = false;
      if (stopping) {
        resolveStop();
      }
    }
  };

  process.on('SIGINT', handleStopSignal);
  process.on('SIGTERM', handleStopSignal);

  console.log('[sync-hourly] Scheduler started.');
  if (options.runImmediately) {
    void runOneCycle('startup');
  }
  scheduleNext();
  await stopPromise;
}
