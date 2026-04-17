import { getSite } from '../client/WikidotDirectClient.js';

export type VoteRecord = {
  userId: number;
  userName: string;
  direction: number; // +1 or -1
};

export type VoteDetailMap = Map<string, VoteRecord[]>;

/**
 * Tier 2 扫描：对指定页面获取详细投票记录
 *
 * 内置断路器：连续失败 >= BREAKER_THRESHOLD 次后自动中止，
 * 避免 Wikidot API 不可用时浪费几十分钟等超时。
 */
const BREAKER_THRESHOLD = 5;

export async function scanVoteDetails(
  fullnames: string[],
  concurrency: number = 3
): Promise<VoteDetailMap> {
  const site = getSite();
  const result: VoteDetailMap = new Map();

  if (fullnames.length === 0) return result;

  console.log(`[tier2] Scanning vote details for ${fullnames.length} pages (concurrency: ${concurrency})...`);
  const startTime = Date.now();

  let completed = 0;
  let failed = 0;
  let consecutiveFails = 0;
  let aborted = false;

  // Promise 池模式并发控制
  let index = 0;
  const workers = Array.from({ length: Math.min(concurrency, fullnames.length) }, async () => {
    while (true) {
      if (aborted) return;
      const i = index++;
      if (i >= fullnames.length) return;

      const fullname = fullnames[i];
      try {
        const pageRes = await site.page.get(fullname);
        if (!pageRes.isOk() || !pageRes.value) {
          failed++;
          consecutiveFails++;
          if (consecutiveFails >= BREAKER_THRESHOLD && !aborted) {
            aborted = true;
            console.warn(`[tier2] Circuit breaker: ${consecutiveFails} consecutive failures, aborting remaining ${fullnames.length - i - 1} pages`);
          }
          continue;
        }

        const page = pageRes.value;
        const votesRes = await page.getVotes();
        if (!votesRes.isOk()) {
          failed++;
          consecutiveFails++;
          if (consecutiveFails >= BREAKER_THRESHOLD && !aborted) {
            aborted = true;
            console.warn(`[tier2] Circuit breaker: ${consecutiveFails} consecutive failures, aborting`);
          }
          continue;
        }

        // 成功 → 重置连续失败计数
        consecutiveFails = 0;

        const voteMap = new Map<number, VoteRecord>();
        for (const vote of votesRes.value) {
          voteMap.set(vote.user.id, {
            userId: vote.user.id,
            userName: vote.user.name,
            direction: vote.value,
          });
        }

        result.set(fullname, [...voteMap.values()]);
        completed++;
      } catch (err) {
        failed++;
        consecutiveFails++;
        if (consecutiveFails >= BREAKER_THRESHOLD && !aborted) {
          aborted = true;
          console.warn(`[tier2] Circuit breaker: ${consecutiveFails} consecutive failures, aborting`);
        }
      }
    }
  });

  await Promise.all(workers);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`[tier2] Done: ${completed} ok, ${failed} failed${aborted ? ' (breaker tripped)' : ''} in ${elapsed}s`);

  return result;
}
