import { PrismaClient, Prisma } from '@prisma/client';
import { Logger } from '../../utils/Logger.js';

type DbClient = PrismaClient | Prisma.TransactionClient;

/**
 * 投票和修订记录存储类
 * 负责Vote和Revision表的操作
 */
export class VoteRevisionStore {
  constructor(private prisma: DbClient) {}

  /**
   * Batch-upsert all unique users from vote + revision edges, returning a wikidotId → userId Map.
   */
  private async batchUpsertUsers(voteEdges: any[], revisionEdges: any[]): Promise<Map<number, number>> {
    const userDataMap = new Map<number, { wikidotId: number; displayName: string | null; username: string | null; isGuest: boolean | null }>();
    for (const edge of voteEdges) {
      const v = edge.node;
      if (v.user?.wikidotId) {
        const wid = parseInt(v.user.wikidotId, 10);
        if (!Number.isNaN(wid)) {
          userDataMap.set(wid, { wikidotId: wid, displayName: v.user.displayName || v.user.username, username: v.user.username, isGuest: v.user.isGuest ?? null });
        }
      } else if (v.userWikidotId) {
        const wid = parseInt(v.userWikidotId, 10);
        if (!Number.isNaN(wid) && !userDataMap.has(wid)) {
          userDataMap.set(wid, { wikidotId: wid, displayName: `wd:${v.userWikidotId}`, username: null, isGuest: null });
        }
      }
    }
    for (const edge of revisionEdges) {
      const r = edge.node;
      if (r.user?.wikidotId) {
        const wid = parseInt(r.user.wikidotId, 10);
        if (!Number.isNaN(wid)) {
          userDataMap.set(wid, { wikidotId: wid, displayName: r.user.displayName || r.user.username, username: r.user.username, isGuest: r.user.isGuest ?? null });
        }
      }
    }

    const result = new Map<number, number>();
    if (userDataMap.size === 0) return result;

    const entries = [...userDataMap.values()];
    const wids = entries.map(e => e.wikidotId);
    const names = entries.map(e => e.displayName ?? e.username ?? `wd:${e.wikidotId}`);
    const usernames = entries.map(e => e.username ?? null);
    const guests = entries.map(e => e.isGuest);

    // Use COALESCE to avoid overwriting richer existing data with placeholder values.
    // EXCLUDED has the incoming row; "User" refers to the existing row.
    const rows: Array<{ id: number; wikidotId: number }> = await this.prisma.$queryRawUnsafe(
      `INSERT INTO "User" ("wikidotId", "displayName", "username", "isGuest")
       SELECT wid, dn, un, ig
       FROM unnest($1::int[], $2::text[], $3::text[], $4::bool[]) AS t(wid, dn, un, ig)
       ON CONFLICT ("wikidotId") DO UPDATE SET
         "displayName" = COALESCE(NULLIF(EXCLUDED."displayName", 'wd:' || "User"."wikidotId"::text), "User"."displayName", EXCLUDED."displayName"),
         "username" = COALESCE(EXCLUDED."username", "User"."username"),
         "isGuest" = COALESCE(EXCLUDED."isGuest", "User"."isGuest")
       RETURNING id, "wikidotId"`,
      wids, names, usernames, guests
    );

    for (const row of rows) {
      result.set(row.wikidotId, row.id);
    }
    return result;
  }

  /**
   * 导入投票和修订记录
   */
  async importVotesAndRevisions(pageVersionId: number, data: any) {
    const stats = {
      votes: { inserted: 0, updated: 0, skipped: 0, errors: 0 },
      revisions: { inserted: 0, updated: 0, errors: 0 }
    };

    const voteEdges = data.votes?.edges ?? [];
    const revisionEdges = data.revisions?.edges ?? [];

    // Batch-upsert all users first (1 query instead of N)
    const userMap = await this.batchUpsertUsers(voteEdges, revisionEdges);

    // 处理投票
    if (voteEdges.length > 0) {
      stats.votes = await this.importVotes(pageVersionId, voteEdges, userMap);
    }

    // 处理修订
    if (revisionEdges.length > 0) {
      stats.revisions = await this.importRevisions(pageVersionId, revisionEdges, userMap);
    }

    Logger.info(`📊 Import stats for pageVersion ${pageVersionId}:
      Votes: ${stats.votes.inserted} inserted, ${stats.votes.updated} updated, ${stats.votes.skipped} skipped, ${stats.votes.errors} errors
      Revisions: ${stats.revisions.inserted} inserted, ${stats.revisions.updated} updated, ${stats.revisions.errors} errors`);

    return stats;
  }

  /**
   * 导入投票记录
   *
   * 直接依赖 schema 上的唯一约束 (Vote_unique_constraint / Vote_anon_unique_constraint)
   * 进行 upsert，避免人工去重时把上游新 timestamp 误判为「已存在」而丢弃。
   * 既无 userId 又无 anonKey 的票无法去重（schema 无对应唯一索引），直接跳过避免无限膨胀。
   */
  private async importVotes(pageVersionId: number, voteEdges: any[], userMap: Map<number, number>) {
    const stats = { inserted: 0, updated: 0, skipped: 0, errors: 0 };
    const batchSize = 100;
    const votes = voteEdges.map(edge => edge.node);

    for (let i = 0; i < votes.length; i += batchSize) {
      const batch = votes.slice(i, i + batchSize);

      try {
        // 准备投票数据
        const voteData: Array<{ pageVersionId: number; userId: number | null; anonKey: string | null; direction: number; timestamp: Date }> = [];
        for (const vote of batch) {
          let userId: number | null = null;
          const wid = vote.user?.wikidotId
            ? parseInt(vote.user.wikidotId, 10)
            : (vote.userWikidotId ? parseInt(vote.userWikidotId, 10) : NaN);
          if (!Number.isNaN(wid)) {
            userId = userMap.get(wid) ?? null;
          }

          const direction = typeof vote.direction === 'number' ? vote.direction : Number.parseInt(String(vote.direction ?? '0'), 10);
          if (Number.isNaN(direction)) {
            Logger.warn(`Skipping vote with invalid direction (pageVersionId=${pageVersionId})`);
            stats.errors++;
            continue;
          }

          const timestampValue = new Date(vote.timestamp);
          const timestampTime = timestampValue.getTime();
          if (Number.isNaN(timestampTime)) {
            Logger.warn(`Skipping vote with invalid timestamp (pageVersionId=${pageVersionId})`);
            stats.errors++;
            continue;
          }

          voteData.push({
            pageVersionId,
            userId,
            anonKey: vote.anonKey || null,
            direction,
            timestamp: timestampValue
          });
        }

        // 依赖唯一约束 upsert：(pageVersionId, userId, timestamp) 或 (pageVersionId, anonKey, timestamp)
        for (const data of voteData) {
          try {
            if (data.userId != null) {
              await this.prisma.vote.upsert({
                where: {
                  Vote_unique_constraint: {
                    pageVersionId: data.pageVersionId,
                    userId: data.userId,
                    timestamp: data.timestamp
                  }
                },
                update: {
                  direction: data.direction
                },
                create: {
                  pageVersionId: data.pageVersionId,
                  userId: data.userId,
                  direction: data.direction,
                  timestamp: data.timestamp
                }
              });
              stats.inserted++;
            } else if (data.anonKey) {
              await this.prisma.vote.upsert({
                where: {
                  Vote_anon_unique_constraint: {
                    pageVersionId: data.pageVersionId,
                    anonKey: data.anonKey,
                    timestamp: data.timestamp
                  }
                },
                update: {
                  direction: data.direction
                },
                create: {
                  pageVersionId: data.pageVersionId,
                  anonKey: data.anonKey,
                  direction: data.direction,
                  timestamp: data.timestamp
                }
              });
              stats.inserted++;
            } else {
              // 既无 userId 又无 anonKey：schema 没有对应唯一约束，直接 create 会在重复跑时无限膨胀，跳过
              Logger.debug(`Skipping vote with neither userId nor anonKey (pageVersionId=${pageVersionId}, timestamp=${data.timestamp.toISOString()})`);
              stats.skipped++;
            }
          } catch (error) {
            stats.errors++;
            Logger.error(`Vote import error: ${error}`);
          }
        }
      } catch (error) {
        stats.errors += batch.length;
        Logger.error(`Batch vote import error: ${error}`);
      }
    }

    return stats;
  }

  /**
   * 导入修订记录
   */
  private async importRevisions(pageVersionId: number, revisionEdges: any[], userMap: Map<number, number>) {
    const stats = { inserted: 0, updated: 0, errors: 0 };
    const revisions = revisionEdges.map(edge => edge.node);

    for (const revision of revisions) {
      try {
        let userId: number | null = null;
        if (revision.user?.wikidotId) {
          const wid = parseInt(revision.user.wikidotId, 10);
          userId = !Number.isNaN(wid) ? (userMap.get(wid) ?? null) : null;
        }

        await this.prisma.revision.upsert({
          where: {
            pageVersionId_wikidotId: {
              pageVersionId,
              wikidotId: parseInt(revision.wikidotId || revision.revisionNumber, 10)
            }
          },
          update: {
            userId,
            type: revision.type || 'unknown',
            comment: revision.comment || '',
            timestamp: new Date(revision.timestamp)
          },
          create: {
            pageVersionId,
            wikidotId: parseInt(revision.wikidotId || revision.revisionNumber, 10),
            userId,
            type: revision.type || 'unknown',
            comment: revision.comment || '',
            timestamp: new Date(revision.timestamp)
          }
        });
        stats.inserted++;
      } catch (error) {
        stats.errors++;
        Logger.error(`Revision import error: ${error}`);
      }
    }

    return stats;
  }

}
