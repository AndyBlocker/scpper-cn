import { PrismaClient, Prisma } from '@prisma/client';
import { Logger } from '../../utils/Logger.js';

type DbClient = PrismaClient | Prisma.TransactionClient;

export const normalizeAttributionAnonKey = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

export const buildDisplayNameAnonKey = (value: unknown): string | null => {
  const normalized = normalizeAttributionAnonKey(value);
  return normalized ? `anon:${normalized}` : null;
};

export class AttributionService {
  private prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  /**
   * Batch-upsert all unique users from attribution entries, returning wikidotId → userId Map.
   */
  private async batchUpsertUsers(attributions: any[], outerTx?: DbClient): Promise<Map<number, number>> {
    const userDataMap = new Map<number, { wikidotId: number; displayName: string | null; username: string | null; isGuest: boolean | null }>();
    for (const attr of attributions) {
      let userData = attr.user;
      if (!userData) continue;
      if (userData.wikidotUser) userData = userData.wikidotUser;
      if (!userData.wikidotId) continue;
      const wid = parseInt(userData.wikidotId, 10);
      if (Number.isNaN(wid)) continue;
      userDataMap.set(wid, {
        wikidotId: wid,
        displayName: userData.displayName || userData.username,
        username: userData.username ?? null,
        isGuest: userData.isGuest ?? null
      });
    }

    const result = new Map<number, number>();
    if (userDataMap.size === 0) return result;

    const entries = [...userDataMap.values()];
    const wids = entries.map(e => e.wikidotId);
    const names = entries.map(e => e.displayName ?? e.username ?? `wd:${e.wikidotId}`);
    const usernames = entries.map(e => e.username);
    const guests = entries.map(e => e.isGuest);

    try {
      // Use COALESCE to avoid overwriting richer existing data with placeholder values.
      const db = outerTx ?? this.prisma;
      const rows: Array<{ id: number; wikidotId: number }> = await db.$queryRawUnsafe(
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
    } catch (error) {
      Logger.error('Batch user upsert failed, falling back to individual:', error);
      // Fallback: individual upserts
      for (const entry of entries) {
        try {
          // Fallback: only create if missing; do not overwrite existing data
          const fallbackDb = outerTx ?? this.prisma;
          const user = await fallbackDb.user.upsert({
            where: { wikidotId: entry.wikidotId },
            update: {},
            create: { wikidotId: entry.wikidotId, displayName: entry.displayName, username: entry.username, isGuest: entry.isGuest }
          });
          result.set(entry.wikidotId, user.id);
        } catch { /* skip */ }
      }
    }
    return result;
  }

  async importAttributions(pageVersionId: number, attributions: any[], outerTx?: DbClient): Promise<{ inserted: number; updated: number; errors: number }> {
    const stats = { inserted: 0, updated: 0, errors: 0 };
    const normalizedEntries: Array<{
      userId: number | null;
      anonKey: string | null;
      type: string;
      order: number;
      date: Date | null;
    }> = [];
    let canDeleteMissingRows = true;

    // Batch-upsert all users first (1 query instead of N)
    const userMap = await this.batchUpsertUsers(attributions, outerTx);

    for (const attr of attributions) {
      try {
        let userId: number | null = null;
        let anonKey: string | null = null;
        let userResolutionFailed = false;

        if (attr.user) {
          let userData = attr.user;
          if (userData.wikidotUser) {
            userData = userData.wikidotUser;
          }
          if (userData.wikidotId) {
            const wid = parseInt(userData.wikidotId, 10);
            const resolved = !Number.isNaN(wid) ? userMap.get(wid) : undefined;
            if (resolved != null) {
              userId = resolved;
            } else {
              userResolutionFailed = true;
              canDeleteMissingRows = false;
            }
          } else if (userData.displayName) {
            anonKey = buildDisplayNameAnonKey(userData.displayName);
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
        } else if (!userResolutionFailed && (anonKey || attr.anonKey)) {
          const finalAnonKey = anonKey || normalizeAttributionAnonKey(attr.anonKey);
          if (!finalAnonKey) {
            continue;
          }
          normalizedEntries.push({
            userId: null,
            anonKey: finalAnonKey,
            type,
            order,
            date
          });
        } else {
          if (userResolutionFailed) {
            Logger.warn('Attribution import skipped a Wikidot user entry; keeping existing rows to avoid destructive sync', {
              pageVersionId,
              type,
              order,
              wikidotId: attr?.user?.wikidotUser?.wikidotId ?? attr?.user?.wikidotId ?? null
            });
          }
          // Neither userId nor anonKey - skip this entry
        }
      } catch (error) {
        stats.errors++;
        Logger.error('Attribution import error:', error);
      }
    }

    const db = outerTx ?? this.prisma;

    if (normalizedEntries.length === 0) {
      if (attributions.length === 0) {
        await db.attribution.deleteMany({
          where: { pageVerId: pageVersionId }
        });
      }
      return stats;
    }

    const doWork = async (tx: DbClient) => {
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

      if (canDeleteMissingRows) {
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
      }

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
    };

    if (outerTx) {
      await doWork(outerTx);
    } else {
      await this.prisma.$transaction(async (tx) => doWork(tx));
    }

    return stats;
  }

}
