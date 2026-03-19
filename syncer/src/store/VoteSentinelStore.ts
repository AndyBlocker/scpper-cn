import { getSyncerPrisma } from './db.js';
import type { VoteChangeEventData } from '../sentinel/VoteDiffEngine.js';
import type { VoteRecord } from '../scanner/VoteDetailScanner.js';

type CacheEntry = {
  userId: number;
  userName: string | null;
  direction: number;
};

/**
 * 从 VoteSentinelCache 加载指定页面的投票快照
 */
export async function loadCachedVotes(fullname: string): Promise<CacheEntry[]> {
  const prisma = getSyncerPrisma();
  const rows: Array<{ userId: number; userName: string | null; direction: number }> =
    await prisma.voteSentinelCache.findMany({ where: { fullname } });
  return rows.map((r: { userId: number; userName: string | null; direction: number }) => ({
    userId: r.userId,
    userName: r.userName,
    direction: r.direction,
  }));
}

/**
 * 批量加载多个页面的投票快照
 */
export async function loadCachedVotesBatch(fullnames: string[]): Promise<Map<string, CacheEntry[]>> {
  const prisma = getSyncerPrisma();
  const rows: Array<{ fullname: string; userId: number; userName: string | null; direction: number }> =
    await prisma.voteSentinelCache.findMany({
      where: { fullname: { in: fullnames } },
    });

  const result = new Map<string, CacheEntry[]>();
  for (const r of rows) {
    const arr = result.get(r.fullname) || [];
    arr.push({ userId: r.userId, userName: r.userName, direction: r.direction });
    result.set(r.fullname, arr);
  }
  return result;
}

/**
 * 更新 VoteSentinelCache：用最新扫描结果替换指定页面的缓存
 */
export async function updateCache(fullname: string, votes: VoteRecord[]): Promise<void> {
  const prisma = getSyncerPrisma();
  const now = new Date();

  // 按 userId 去重（Wikidot 偶尔返回重复投票记录）
  const deduped = new Map<number, VoteRecord>();
  for (const v of votes) {
    deduped.set(v.userId, v);
  }
  const uniqueVotes = [...deduped.values()];

  await prisma.$transaction(async (tx: any) => {
    await tx.voteSentinelCache.deleteMany({ where: { fullname } });

    if (uniqueVotes.length > 0) {
      await tx.voteSentinelCache.createMany({
        data: uniqueVotes.map((v: VoteRecord) => ({
          fullname,
          userId: v.userId,
          userName: v.userName || null,
          direction: v.direction,
          lastSeenAt: now,
        })),
        skipDuplicates: true,
      });
    }
  });
}

/**
 * 批量写入 VoteChangeEvent
 */
export async function writeChangeEvents(events: VoteChangeEventData[]): Promise<number> {
  if (events.length === 0) return 0;

  const prisma = getSyncerPrisma();
  const now = new Date();

  const result = await prisma.voteChangeEvent.createMany({
    data: events.map((e: VoteChangeEventData) => ({
      fullname: e.fullname,
      userId: e.userId,
      userName: e.userName,
      changeType: e.changeType,
      oldDirection: e.oldDirection,
      newDirection: e.newDirection,
      detectedAt: now,
    })),
  });

  return result.count;
}
