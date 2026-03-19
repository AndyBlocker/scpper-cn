import type { RatingMap, RatingEntry } from '../scanner/RatingScanner.js';

export type ChangedPage = {
  fullname: string;
  oldRating?: number;
  newRating: number;
  oldVotesCount?: number;
  newVotesCount: number;
};

/**
 * Tier 1 差异检测：比较两个 RatingMap，输出 rating 或 votesCount 有变化的页面
 */
export function diffRatings(
  previous: RatingMap,
  current: RatingMap
): ChangedPage[] {
  const changes: ChangedPage[] = [];

  for (const [fullname, cur] of current) {
    const prev = previous.get(fullname);
    if (!prev) {
      // 新页面（之前不存在）
      changes.push({
        fullname,
        newRating: cur.rating,
        newVotesCount: cur.votesCount,
      });
    } else if (prev.rating !== cur.rating || prev.votesCount !== cur.votesCount) {
      changes.push({
        fullname,
        oldRating: prev.rating,
        newRating: cur.rating,
        oldVotesCount: prev.votesCount,
        newVotesCount: cur.votesCount,
      });
    }
  }

  // 检测删除的页面（在 previous 中但不在 current 中）
  for (const [fullname, prev] of previous) {
    if (!current.has(fullname)) {
      changes.push({
        fullname,
        oldRating: prev.rating,
        newRating: 0,
        oldVotesCount: prev.votesCount,
        newVotesCount: 0,
      });
    }
  }

  return changes;
}
