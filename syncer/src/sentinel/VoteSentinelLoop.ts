import { scanAllRatings, type RatingMap } from '../scanner/RatingScanner.js';
import { scanVoteDetails } from '../scanner/VoteDetailScanner.js';
import { diffRatings } from './RatingDiffEngine.js';
import { diffVotes } from './VoteDiffEngine.js';
import { loadCachedVotesBatch, updateCache, writeChangeEvents } from '../store/VoteSentinelStore.js';
import { getMainPool } from '../store/db.js';

type SentinelLoopOptions = {
  intervalSeconds: number;
  runImmediately: boolean;
  tier2Concurrency: number;
};

function formatDurationMs(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

/**
 * 从主库 PageVersion（最新版本）引导初始 RatingMap
 * 只取 validTo IS NULL 的最新版本
 */
async function bootstrapRatingMap(): Promise<RatingMap> {
  console.log('[sentinel] Bootstrapping rating map from PageVersion...');
  const pool = getMainPool();

  // currentUrl 格式: http://scp-wiki-cn.wikidot.com/scp-cn-100
  // Wikidot fullname 格式: scp-cn-100
  // 用 SQL 提取路径部分作为 fullname
  const { rows } = await pool.query<{
    fullname: string;
    rating: string | null;
    vote_count: string | null;
  }>(`
    SELECT
      SUBSTRING(p."currentUrl" FROM '//[^/]+/(.+)$') AS fullname,
      pv.rating::text,
      pv."voteCount"::text AS vote_count
    FROM "PageVersion" pv
    JOIN "Page" p ON p.id = pv."pageId"
    WHERE pv."validTo" IS NULL
      AND p."isDeleted" = false
  `);

  const map: RatingMap = new Map();
  for (const row of rows) {
    const rating = row.rating != null ? parseInt(row.rating, 10) : 0;
    const votesCount = row.vote_count != null ? parseInt(row.vote_count, 10) : 0;
    if (row.fullname) {
      map.set(row.fullname, { rating, votesCount });
    }
  }

  console.log(`[sentinel] Bootstrapped ${map.size} pages from PageVersion`);
  return map;
}

export async function runVoteSentinelLoop(options: SentinelLoopOptions): Promise<void> {
  const intervalSeconds = Number.isFinite(options.intervalSeconds)
    ? Math.max(60, Math.floor(options.intervalSeconds))
    : 300;
  const intervalMs = intervalSeconds * 1000;

  let running = false;
  let stopping = false;
  let timer: NodeJS.Timeout | null = null;
  let resolveStopPromise: (() => void) | null = null;
  let lastRatingMap: RatingMap | null = null;

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
    console.log(`[sentinel] Next cycle at ${nextRunAt.toISOString()}`);
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
    console.log(`[sentinel] Received ${signal}, waiting for current cycle to finish...`);
    if (!running) {
      resolveStop();
    }
  };

  const runOneCycle = async (reason: 'startup' | 'scheduled') => {
    if (running) {
      console.log(`[sentinel] Skip ${reason} trigger: previous cycle is still running.`);
      scheduleNext();
      return;
    }

    running = true;
    const startedAt = Date.now();
    console.log(`\n[sentinel] ══════════════════════════════════════`);
    console.log(`[sentinel] Cycle started (${reason}) at ${new Date(startedAt).toISOString()}`);

    try {
      // 1. Tier 1 扫描
      const ratingMap = await scanAllRatings();

      // 2. 如果没有上次数据，用本次作为基准
      if (!lastRatingMap) {
        console.log('[sentinel] First cycle — using bootstrap data as baseline');
        lastRatingMap = await bootstrapRatingMap();
        // 如果 bootstrap 也是空的，用 scan 结果作为基准
        if (lastRatingMap.size === 0) {
          console.log('[sentinel] Bootstrap empty, using scan result as baseline');
          lastRatingMap = ratingMap;
          return;
        }
      }

      // 3. Diff
      const changedPages = diffRatings(lastRatingMap, ratingMap);
      console.log(`[sentinel] Tier 1 diff: ${changedPages.length} changed pages`);

      if (changedPages.length > 0) {
        // 4. Tier 2 扫描变化页面
        const changedFullnames = changedPages.map(p => p.fullname);
        const voteDetails = await scanVoteDetails(changedFullnames, options.tier2Concurrency);

        // 5. 加载缓存并 diff
        const cachedVotes = await loadCachedVotesBatch(changedFullnames);
        let totalEvents = 0;

        for (const fullname of changedFullnames) {
          const cached = cachedVotes.get(fullname) || [];
          const current = voteDetails.get(fullname) || [];

          const events = diffVotes(fullname, cached, current);

          if (events.length > 0) {
            const written = await writeChangeEvents(events);
            totalEvents += written;
          }

          // 更新缓存（不管有没有 events，都更新为最新快照）
          if (current.length > 0) {
            await updateCache(fullname, current);
          }
        }

        console.log(`[sentinel] Wrote ${totalEvents} vote change events`);
      }

      // 6. 更新 lastRatingMap
      lastRatingMap = ratingMap;

    } catch (error) {
      const message = error instanceof Error ? error.stack || error.message : String(error);
      console.error(`[sentinel] Cycle failed: ${message}`);
    } finally {
      const elapsed = Date.now() - startedAt;
      console.log(`[sentinel] Cycle finished in ${formatDurationMs(elapsed)}`);
      console.log(`[sentinel] ══════════════════════════════════════\n`);
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

  console.log(`[sentinel] Scheduler started. interval=${intervalSeconds}s`);
  if (options.runImmediately) {
    void runOneCycle('startup');
  } else {
    scheduleNext();
  }

  await stopPromise;
}
