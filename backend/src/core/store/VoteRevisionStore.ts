import { PrismaClient } from '@prisma/client';
import { Logger } from '../../utils/Logger.js';
import { MAX_FIRST } from '../../config/RateLimitConfig.js';

/**
 * 投票和修订记录存储类
 * 负责Vote和Revision表的操作
 */
export class VoteRevisionStore {
  constructor(private prisma: PrismaClient) {}

  /**
   * 导入投票和修订记录
   */
  async importVotesAndRevisions(pageVersionId: number, data: any) {
    const stats = {
      votes: { inserted: 0, updated: 0, errors: 0 },
      revisions: { inserted: 0, updated: 0, errors: 0 }
    };

    // 处理投票
    if (data.votes?.edges) {
      stats.votes = await this.importVotes(pageVersionId, data.votes.edges);
    }

    // 处理修订
    if (data.revisions?.edges) {
      stats.revisions = await this.importRevisions(pageVersionId, data.revisions.edges);
    }

    Logger.info(`📊 Import stats for pageVersion ${pageVersionId}:
      Votes: ${stats.votes.inserted} inserted, ${stats.votes.updated} updated, ${stats.votes.errors} errors
      Revisions: ${stats.revisions.inserted} inserted, ${stats.revisions.updated} updated, ${stats.revisions.errors} errors`);

    return stats;
  }

  /**
   * 导入投票记录
   */
  private async importVotes(pageVersionId: number, voteEdges: any[]) {
    const stats = { inserted: 0, updated: 0, errors: 0 };
    const batchSize = 100;
    const votes = voteEdges.map(edge => edge.node);

    for (let i = 0; i < votes.length; i += batchSize) {
      const batch = votes.slice(i, i + batchSize);
      
      try {
        // 准备投票数据
        const voteData = await Promise.all(batch.map(async (vote) => {
          let userId = null;
          if (vote.user) {
            const user = await this.upsertUser(vote.user);
            userId = user?.id || null;
          } else if (vote.userWikidotId) {
            // 兜底：只有 wikidotId 也建一个占位用户，避免丢票
            const user = await this.prisma.user.upsert({
              where: { wikidotId: parseInt(vote.userWikidotId, 10) },
              update: {},
              create: { 
                wikidotId: parseInt(vote.userWikidotId, 10), 
                displayName: `wd:${vote.userWikidotId}` 
              }
            });
            userId = user.id;
          }

          return {
            pageVersionId,
            userId,
            anonKey: vote.anonKey || null,
            direction: vote.direction,
            timestamp: new Date(vote.timestamp)
          };
        }));

        // 批量upsert
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
  private async importRevisions(pageVersionId: number, revisionEdges: any[]) {
    const stats = { inserted: 0, updated: 0, errors: 0 };
    const revisions = revisionEdges.map(edge => edge.node);

    for (const revision of revisions) {
      try {
        let userId = null;
        if (revision.user) {
          const user = await this.upsertUser(revision.user);
          userId = user?.id || null;
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

  /**
   * 创建或更新用户
   */
  private async upsertUser(userData: any): Promise<any | null> {
    if (!userData || !userData.wikidotId) {
      return null;
    }

    try {
      const user = await this.prisma.user.upsert({
        where: { wikidotId: parseInt(userData.wikidotId, 10) },
        update: {
          displayName: userData.displayName || userData.username,
          username: userData.username,
          isGuest: userData.isGuest || false
        },
        create: {
          wikidotId: parseInt(userData.wikidotId, 10),
          displayName: userData.displayName || userData.username,
          username: userData.username,
          isGuest: userData.isGuest || false
        }
      });
      return user;
    } catch (error) {
      Logger.error(`Failed to upsert user ${userData.wikidotId}: ${error}`);
      return null;
    }
  }
}