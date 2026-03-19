import type { VoteRecord } from '../scanner/VoteDetailScanner.js';

export type VoteChangeEventData = {
  fullname: string;
  userId: number | null;
  userName: string | null;
  changeType: 'added' | 'removed' | 'changed';
  oldDirection: number | null;
  newDirection: number | null;
};

type CacheEntry = {
  userId: number;
  userName: string | null;
  direction: number;
};

/**
 * Tier 2 差异检测：比较 VoteSentinelCache 快照与最新扫描结果
 * 输出投票变化事件列表
 */
export function diffVotes(
  fullname: string,
  cached: CacheEntry[],
  current: VoteRecord[]
): VoteChangeEventData[] {
  const events: VoteChangeEventData[] = [];

  // 建立缓存 userId→entry 映射
  const cacheMap = new Map<number, CacheEntry>();
  for (const entry of cached) {
    cacheMap.set(entry.userId, entry);
  }

  // 建立当前 userId→record 映射
  const currentMap = new Map<number, VoteRecord>();
  for (const record of current) {
    currentMap.set(record.userId, record);
  }

  // 检测新增和变更
  for (const [userId, cur] of currentMap) {
    const prev = cacheMap.get(userId);
    if (!prev) {
      // 新增投票
      events.push({
        fullname,
        userId,
        userName: cur.userName || null,
        changeType: 'added',
        oldDirection: null,
        newDirection: cur.direction,
      });
    } else if (prev.direction !== cur.direction) {
      // 改变方向
      events.push({
        fullname,
        userId,
        userName: cur.userName || null,
        changeType: 'changed',
        oldDirection: prev.direction,
        newDirection: cur.direction,
      });
    }
  }

  // 检测移除
  for (const [userId, prev] of cacheMap) {
    if (!currentMap.has(userId)) {
      events.push({
        fullname,
        userId,
        userName: prev.userName || null,
        changeType: 'removed',
        oldDirection: prev.direction,
        newDirection: null,
      });
    }
  }

  return events;
}
