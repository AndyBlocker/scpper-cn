import { getSite } from '../client/WikidotDirectClient.js';

export type VoteRecord = {
  userId: number;
  userName: string;
  direction: number; // +1 or -1
};

export type VoteDetailMap = Map<string, VoteRecord[]>;

/**
 * Tier 2 扫描：对指定页面获取详细投票记录
 */
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

  // Promise 池模式并发控制
  let index = 0;
  const workers = Array.from({ length: Math.min(concurrency, fullnames.length) }, async () => {
    while (true) {
      const i = index++;
      if (i >= fullnames.length) return;

      const fullname = fullnames[i];
      try {
        const pageRes = await site.page.get(fullname);
        if (!pageRes.isOk()) {
          console.warn(`[tier2] Failed to get page ${fullname}:`, pageRes.error);
          failed++;
          continue;
        }

        const page = pageRes.value;
        if (!page) {
          console.warn(`[tier2] Page ${fullname} not found`);
          failed++;
          continue;
        }

        const votesRes = await page.getVotes();
        if (!votesRes.isOk()) {
          console.warn(`[tier2] Failed to get votes for ${fullname}:`, votesRes.error);
          failed++;
          continue;
        }

        // 按 userId 去重（取最后一条）
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
        console.warn(`[tier2] Error scanning ${fullname}:`, err);
        failed++;
      }
    }
  });

  await Promise.all(workers);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`[tier2] Done: ${completed} ok, ${failed} failed in ${elapsed}s`);

  return result;
}
