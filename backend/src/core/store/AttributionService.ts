import { PrismaClient } from '@prisma/client';
import { Logger } from '../../utils/Logger.js';

export class AttributionService {
  private prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  async importAttributions(pageVersionId: number, attributions: any[]): Promise<{ inserted: number; updated: number; errors: number }> {
    const stats = { inserted: 0, updated: 0, errors: 0 };
    for (const attr of attributions) {
      try {
        let userId: number | null = null;
        let anonKey: string | null = null;

        if (attr.user) {
          let userData = attr.user;
          if (userData.wikidotUser) {
            userData = userData.wikidotUser;
          }
          if (userData.wikidotId) {
            const user = await this.upsertUser(userData);
            userId = user?.id || null;
          } else if (userData.displayName) {
            anonKey = `anon:${userData.displayName}`;
          }
        }

        const type = attr.type || 'unknown';
        const order = attr.order ?? 0;
        const date = attr.date ? new Date(attr.date) : null;

        if (userId != null) {
          await this.prisma.attribution.upsert({
            where: {
              Attribution_unique_constraint: {
                pageVerId: pageVersionId,
                type,
                order,
                userId
              }
            },
            update: { date },
            create: {
              pageVerId: pageVersionId,
              userId,
              type,
              order,
              date
            }
          });
          stats.inserted++;
        } else if (anonKey || attr.anonKey) {
          const finalAnonKey = anonKey || attr.anonKey;
          await this.prisma.attribution.upsert({
            where: {
              Attribution_anon_unique_constraint: {
                pageVerId: pageVersionId,
                type,
                order,
                anonKey: finalAnonKey
              }
            },
            update: { date },
            create: {
              pageVerId: pageVersionId,
              anonKey: finalAnonKey,
              type,
              order,
              date
            }
          });
          stats.inserted++;
        } else {
          // Neither userId nor anonKey - ignore silently
          stats.updated++;
        }
      } catch (error) {
        stats.errors++;
        Logger.error('Attribution import error:', error);
      }
    }

    return stats;
  }

  private async upsertUser(userData: any): Promise<any | null> {
    if (!userData || !userData.wikidotId) return null;
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
      Logger.error(`Failed to upsert user ${userData.wikidotId}:`, error);
      return null;
    }
  }
}


