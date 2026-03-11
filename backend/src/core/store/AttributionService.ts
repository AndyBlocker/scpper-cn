import { PrismaClient } from '@prisma/client';
import { Logger } from '../../utils/Logger.js';

export class AttributionService {
  private prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  async importAttributions(pageVersionId: number, attributions: any[]): Promise<{ inserted: number; updated: number; errors: number }> {
    const stats = { inserted: 0, updated: 0, errors: 0 };
    const normalizedEntries: Array<{
      userId: number | null;
      anonKey: string | null;
      type: string;
      order: number;
      date: Date | null;
    }> = [];

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
          normalizedEntries.push({
            userId,
            anonKey: null,
            type,
            order,
            date
          });
        } else if (anonKey || attr.anonKey) {
          const finalAnonKey = anonKey || attr.anonKey;
          normalizedEntries.push({
            userId: null,
            anonKey: finalAnonKey,
            type,
            order,
            date
          });
        } else {
          // Neither userId nor anonKey - ignore silently
          stats.updated++;
        }
      } catch (error) {
        stats.errors++;
        Logger.error('Attribution import error:', error);
      }
    }

    if (normalizedEntries.length === 0) {
      if (attributions.length === 0) {
        await this.prisma.attribution.deleteMany({
          where: { pageVerId: pageVersionId }
        });
      }
      return stats;
    }

    await this.prisma.$transaction(async (tx) => {
      const keepUserKeys = normalizedEntries
        .filter((entry) => entry.userId != null)
        .map((entry) => ({
          type: entry.type,
          order: entry.order,
          userId: entry.userId!
        }));
      const keepAnonKeys = normalizedEntries
        .filter((entry) => entry.anonKey)
        .map((entry) => ({
          type: entry.type,
          order: entry.order,
          anonKey: entry.anonKey!
        }));

      await tx.attribution.deleteMany({
        where: {
          pageVerId: pageVersionId,
          NOT: {
            OR: [
              ...keepUserKeys.map((entry) => ({
                type: entry.type,
                order: entry.order,
                userId: entry.userId
              })),
              ...keepAnonKeys.map((entry) => ({
                type: entry.type,
                order: entry.order,
                anonKey: entry.anonKey
              }))
            ]
          }
        }
      });

      for (const entry of normalizedEntries) {
        if (entry.userId != null) {
          await tx.attribution.upsert({
            where: {
              Attribution_unique_constraint: {
                pageVerId: pageVersionId,
                type: entry.type,
                order: entry.order,
                userId: entry.userId
              }
            },
            update: { date: entry.date },
            create: {
              pageVerId: pageVersionId,
              userId: entry.userId,
              type: entry.type,
              order: entry.order,
              date: entry.date
            }
          });
          stats.inserted++;
          continue;
        }

        if (!entry.anonKey) continue;

        await tx.attribution.upsert({
          where: {
            Attribution_anon_unique_constraint: {
              pageVerId: pageVersionId,
              type: entry.type,
              order: entry.order,
              anonKey: entry.anonKey
            }
          },
          update: { date: entry.date },
          create: {
            pageVerId: pageVersionId,
            anonKey: entry.anonKey,
            type: entry.type,
            order: entry.order,
            date: entry.date
          }
        });
        stats.inserted++;
      }
    });

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
