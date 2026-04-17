/**
 * FastVoteLoop — 5 分钟间隔的快速投票监控
 *
 * 使用并发 RatingScanner（~30s）+ Tier 2 投票详情 + 轻量 Bridge
 * 只更新 rating/voteCount 和写入新投票，不做内容扫描和完整分析
 */

import { getSite } from '../client/WikidotDirectClient.js';
import { isSuccessResponse } from '@ukwhatn/wikidot';
import { scanVoteDetails } from '../scanner/VoteDetailScanner.js';
import { diffVotes } from './VoteDiffEngine.js';
import { loadCachedVotesBatch, updateCache, writeChangeEvents } from '../store/VoteSentinelStore.js';
import { getMainPool, getSyncerPrisma } from '../store/db.js';
import type { RatingMap } from '../scanner/RatingScanner.js';

type FastVoteLoopOptions = {
  intervalSeconds: number;
  runImmediately: boolean;
  concurrency: number;      // 并发 ListPagesModule 请求数
  tier2Concurrency: number; // 并发 Tier 2 投票扫描数
};

function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
}

export async function runFastVoteLoop(options: FastVoteLoopOptions): Promise<void> {
  const intervalMs = Math.max(30, Math.floor(options.intervalSeconds)) * 1000;

  let running = false;
  let stopping = false;
  let timer: NodeJS.Timeout | null = null;
  let resolveStop: (() => void) | null = null;
  const stopPromise = new Promise<void>(r => { resolveStop = r; });
  const finish = () => { if (resolveStop) { const r = resolveStop; resolveStop = null; r(); } };

  let lastRatings: RatingMap | null = null;

  const scheduleNext = () => {
    if (stopping) return;
    timer = setTimeout(() => void runOneCycle('scheduled'), intervalMs);
  };

  const handleStop = (sig: NodeJS.Signals) => {
    if (stopping) return;
    stopping = true;
    if (timer) { clearTimeout(timer); timer = null; }
    console.log(`[fast-vote] Received ${sig}, waiting...`);
    if (!running) finish();
  };

  const runOneCycle = async (reason: 'startup' | 'scheduled') => {
    if (running) { scheduleNext(); return; }
    running = true;
    const t0 = Date.now();

    try {
      // ── 1. 并发 Rating 扫描 ──
      const currentRatings = await scanRatingsConcurrent(options.concurrency);
      console.log(`[fast-vote] Scanned ${currentRatings.size} pages in ${formatDuration(Date.now() - t0)}`);

      if (!lastRatings) {
        // 首次运行：仅保存基准
        lastRatings = currentRatings;
        console.log(`[fast-vote] Baseline set (${currentRatings.size} pages), skipping diff`);
        return;
      }

      // ── 2. Diff：找出 rating/votesCount 变化的页面 ──
      const changed: string[] = [];
      for (const [fn, curr] of currentRatings) {
        const prev = lastRatings.get(fn);
        if (!prev || prev.rating !== curr.rating || prev.votesCount !== curr.votesCount) {
          changed.push(fn);
        }
      }

      if (changed.length === 0) {
        console.log(`[fast-vote] No rating changes`);
        lastRatings = currentRatings;
        return;
      }

      console.log(`[fast-vote] ${changed.length} pages with rating changes`);

      // ── 3. Tier 2 投票详情 ──
      // 内部 scanVoteDetails 有断路器：连续 5 次失败自动中止。
      const voteDetails = await scanVoteDetails(changed, options.tier2Concurrency);
      const cachedVotes = await loadCachedVotesBatch(changed);

      let totalEvents = 0;
      for (const fullname of changed) {
        const cached = cachedVotes.get(fullname) || [];
        const current = voteDetails.get(fullname) || [];
        const events = diffVotes(fullname, cached, current);
        if (events.length > 0) {
          totalEvents += await writeChangeEvents(events);
        }
        if (current.length > 0) {
          await updateCache(fullname, current);
        }
      }

      if (totalEvents > 0) {
        console.log(`[fast-vote] Vote events: ${totalEvents}`);
      }

      // ── 4. 轻量 Bridge：只更新 PageVersion.rating + voteCount ──
      const bridged = await lightweightBridge(changed, currentRatings);
      if (bridged > 0) {
        console.log(`[fast-vote] Bridge: ${bridged} pages updated`);
      }

      lastRatings = currentRatings;

    } catch (err) {
      console.error(`[fast-vote] Cycle failed:`, err instanceof Error ? err.message : err);
    } finally {
      console.log(`[fast-vote] Cycle (${reason}) done in ${formatDuration(Date.now() - t0)}`);
      running = false;
      if (stopping) finish(); else scheduleNext();
    }
  };

  process.on('SIGINT', handleStop);
  process.on('SIGTERM', handleStop);

  console.log(`[fast-vote] Loop started. interval=${Math.round(intervalMs / 1000)}s, concurrency=${options.concurrency}`);
  if (options.runImmediately) {
    void runOneCycle('startup');
  } else {
    scheduleNext();
  }

  await stopPromise;
}

// ── 并发 Rating 扫描 ──

const MODULE_BODY = '%%%%fullname%%%%|%%%%rating%%%%|%%%%rating_votes%%%%';

async function scanRatingsConcurrent(concurrency: number): Promise<RatingMap> {
  const site = getSite();
  const result: RatingMap = new Map();

  // 先获取第一批来确定总批次数
  const firstRes = await site.amcRequestSingle({
    moduleName: 'list/ListPagesModule',
    category: '*',
    perPage: '250',
    order: 'created_at desc',
    p: '1',
    module_body: MODULE_BODY,
  });

  if (!firstRes.isOk() || !isSuccessResponse(firstRes.value)) {
    throw new Error('First batch failed');
  }

  const totalMatch = firstRes.value.body.match(/page\s+\d+\s+of\s+(\d+)/i);
  const totalBatches = totalMatch ? parseInt(totalMatch[1], 10) : 138;

  parseRatingEntries(firstRes.value.body, result);

  // 并发扫描剩余批次
  let nextPage = 2;
  const workers = Array.from({ length: Math.min(concurrency, totalBatches - 1) }, async () => {
    while (true) {
      const p = nextPage++;
      if (p > totalBatches) return;

      try {
        const res = await site.amcRequestSingle({
          moduleName: 'list/ListPagesModule',
          category: '*',
          perPage: '250',
          order: 'created_at desc',
          p: String(p),
          module_body: MODULE_BODY,
        });

        if (res.isOk() && isSuccessResponse(res.value)) {
          parseRatingEntries(res.value.body, result);
        }
      } catch {
        // 单批失败不阻塞
      }
    }
  });

  await Promise.all(workers);
  return result;
}

function parseRatingEntries(html: string, result: RatingMap): void {
  const pattern = /%%([^%]+)%%\|%%([^%]+)%%\|%%([^%]+)%%/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) !== null) {
    const fullname = match[1].trim();
    const rating = parseInt(match[2].trim(), 10);
    const votesCount = parseInt(match[3].trim(), 10);
    if (fullname && !isNaN(rating) && !isNaN(votesCount)) {
      result.set(fullname, { rating, votesCount });
    }
  }
}

// ── 轻量 Bridge ──

async function lightweightBridge(
  changed: string[],
  ratings: RatingMap,
): Promise<number> {
  const pool = getMainPool();

  // 批量更新 PageVersion.rating + voteCount
  const fullnames: string[] = [];
  const ratingVals: number[] = [];
  const voteCountVals: number[] = [];

  for (const fn of changed) {
    const r = ratings.get(fn);
    if (!r) continue;
    fullnames.push(fn);
    ratingVals.push(r.rating);
    voteCountVals.push(r.votesCount);
  }

  if (fullnames.length === 0) return 0;

  const result = await pool.query(`
    UPDATE "PageVersion" pv
    SET rating = u.rating, "voteCount" = u.vote_count, "updatedAt" = NOW()
    FROM (
      SELECT
        unnest($1::text[]) AS fullname,
        unnest($2::int[]) AS rating,
        unnest($3::int[]) AS vote_count
    ) u
    JOIN "Page" p ON SUBSTRING(p."currentUrl" FROM '//[^/]+/(.+)$') = u.fullname
    WHERE pv."pageId" = p.id AND pv."validTo" IS NULL
      AND (pv.rating != u.rating OR pv."voteCount" != u.vote_count)
  `, [fullnames, ratingVals, voteCountVals]);

  return result.rowCount ?? 0;
}
