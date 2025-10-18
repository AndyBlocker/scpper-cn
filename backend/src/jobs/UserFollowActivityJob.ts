import { Prisma, PrismaClient } from '@prisma/client';
import { getPrismaClient } from '../utils/db-connection.js';
import { Logger } from '../utils/Logger.js';

type RevisionEvent = { revisionId: number; pageId: number; pageVersionId: number; targetUserId: number };
type AttributionAddEvent = { attributionId: number; pageId: number; pageVersionId: number; targetUserId: number };
type AttributionRemoveEvent = { attributionId: number; pageId: number; pageVersionId: number; targetUserId: number };

export class UserFollowActivityJob {
  private prisma: PrismaClient;

  constructor(prisma?: PrismaClient) {
    this.prisma = prisma || getPrismaClient();
  }

  async run(pageVersionIds: number[]): Promise<void> {
    if (!pageVersionIds || pageVersionIds.length === 0) return;
    const pvArray = Prisma.sql`ARRAY[${Prisma.join(pageVersionIds.map(id => Prisma.sql`${id}`))}]::int[]`;

    // Collect revision events for these page versions
    const revisionRows = await this.prisma.$queryRaw<Array<{ revisionId: number; pageId: number; pvId: number; targetUserId: number }>>(Prisma.sql`
      SELECT r.id AS revision_id, pv."pageId" AS page_id, pv.id AS pv_id, r."userId" AS target_user_id
      FROM "Revision" r
      JOIN "PageVersion" pv ON pv.id = r."pageVersionId"
      WHERE r."userId" IS NOT NULL AND r."pageVersionId" = ANY(${pvArray})
    `);
    
    // Prepare attribution diff: current vs previous version
    const pvPairs = await this.prisma.$queryRaw<Array<{ pv_id: number; page_id: number; prev_pv_id: number | null }>>(Prisma.sql`
      SELECT pv.id AS pv_id, pv."pageId" AS page_id,
             (SELECT id FROM "PageVersion" x WHERE x."pageId" = pv."pageId" AND x.id < pv.id ORDER BY x.id DESC LIMIT 1) AS prev_pv_id
      FROM "PageVersion" pv
      WHERE pv.id = ANY(${pvArray})
    `);
    const allPvIds: number[] = Array.from(new Set(pvPairs.flatMap(p => [p.pv_id, p.prev_pv_id || 0]).filter(Boolean))) as number[];
    const pvIdArray = Prisma.sql`ARRAY[${Prisma.join(allPvIds.map(id => Prisma.sql`${id}`))}]::int[]`;
    const attributionRows = await this.prisma.$queryRaw<Array<{ attributionId: number; pvId: number; userId: number }>>(Prisma.sql`
      SELECT a.id AS attribution_id, a."pageVerId" AS pv_id, a."userId" AS user_id
      FROM "Attribution" a
      WHERE a."pageVerId" = ANY(${pvIdArray})
    `);

    const revEvents: RevisionEvent[] = revisionRows
      .filter(r => r.targetUserId != null)
      .map(r => ({ revisionId: Number(r.revisionId), pageId: Number(r.pageId), pageVersionId: Number(r.pvId), targetUserId: Number(r.targetUserId) }));

    // Build attribution maps per pageVersion
    const curMap = new Map<number, Map<number, number>>(); // pvId -> (userId -> attributionId)
    for (const row of attributionRows) {
      const pvId = Number(row.pvId); const u = Number(row.userId); const aid = Number(row.attributionId);
      if (!curMap.has(pvId)) curMap.set(pvId, new Map());
      curMap.get(pvId)!.set(u, aid);
    }
    const addEvents: AttributionAddEvent[] = [];
    const removeEvents: AttributionRemoveEvent[] = [];
    for (const pair of pvPairs) {
      const pvId = Number(pair.pv_id); const prevId = pair.prev_pv_id == null ? null : Number(pair.prev_pv_id);
      const pageId = Number(pair.page_id);
      const curSet = curMap.get(pvId) || new Map<number, number>();
      const prevSet = prevId ? (curMap.get(prevId) || new Map<number, number>()) : new Map<number, number>();
      for (const [userId, aid] of curSet.entries()) {
        if (!prevSet.has(userId)) {
          addEvents.push({ attributionId: aid, pageId, pageVersionId: pvId, targetUserId: userId });
        }
      }
      for (const [userId, prevAid] of prevSet.entries()) {
        if (!curSet.has(userId)) {
          removeEvents.push({ attributionId: prevAid, pageId, pageVersionId: pvId, targetUserId: userId });
        }
      }
    }

    if (revEvents.length === 0 && addEvents.length === 0 && removeEvents.length === 0) {
      Logger.debug('[follow-activity] No relevant events for supplied pageVersionIds.');
      return;
    }

    const targetIds = Array.from(new Set([
      ...revEvents.map(e => e.targetUserId),
      ...addEvents.map(e => e.targetUserId),
      ...removeEvents.map(e => e.targetUserId)
    ]));
    if (targetIds.length === 0) return;

    // Load followers for these targets
    const follows = await this.prisma.$queryRaw<Array<{ id: number; followerId: number; targetUserId: number }>>(Prisma.sql`
      SELECT f.id, f."followerId", f."targetUserId"
      FROM "UserFollow" f
      WHERE f."targetUserId" = ANY(ARRAY[${Prisma.join(targetIds.map(id => Prisma.sql`${id}`))}]::int[])
    `);

    if (follows.length === 0) {
      Logger.debug('[follow-activity] No followers found for involved targets.');
      return;
    }

    const followsByTarget = new Map<number, Array<{ id: number; followerId: number }>>();
    for (const f of follows) {
      const list = followsByTarget.get(f.targetUserId) || [];
      list.push({ id: Number(f.id), followerId: Number(f.followerId) });
      followsByTarget.set(f.targetUserId, list);
    }

    const now = new Date();
    let created = 0;
    let updated = 0;

    // Prepare existing unread map for revision type
    const revFollowIds = Array.from(new Set(follows.map(f => f.id)));
    const revPageIds = Array.from(new Set(revEvents.map(e => e.pageId)));
    const existingRev = (revFollowIds.length > 0 && revPageIds.length > 0)
      ? await this.prisma.$queryRaw<Array<{ id: number; followId: number; pageId: number }>>(Prisma.sql`
          SELECT id, "followId", "pageId"
          FROM "UserActivityAlert"
          WHERE "acknowledgedAt" IS NULL AND type = 'REVISION'
            AND "followId" = ANY(ARRAY[${Prisma.join(revFollowIds.map(x => Prisma.sql`${x}`))}]::int[])
            AND "pageId" = ANY(ARRAY[${Prisma.join(revPageIds.map(x => Prisma.sql`${x}`))}]::int[])
        `)
      : [];
    const existingRevMap = new Map<string, number>();
    for (const row of existingRev) {
      existingRevMap.set(`${row.followId}:${row.pageId}`, Number(row.id));
    }

    // Process revision events
    for (const e of revEvents) {
      const list = followsByTarget.get(e.targetUserId) || [];
      for (const f of list) {
        const key = `${f.id}:${e.pageId}`;
        const unreadId = existingRevMap.get(key);
        if (unreadId) {
          await this.prisma.$executeRaw(Prisma.sql`
            UPDATE "UserActivityAlert"
            SET "revisionId" = ${e.revisionId}, "pageVersionId" = ${e.pageVersionId}, "detectedAt" = ${now}
            WHERE id = ${unreadId}
          `);
          updated += 1;
        } else {
          // Insert only if this (follow, revision) not already recorded
          await this.prisma.$executeRaw(Prisma.sql`
            INSERT INTO "UserActivityAlert" ("followId", "followerId", "targetUserId", "pageId", type, "revisionId", "pageVersionId", "detectedAt", "createdAt")
            SELECT ${f.id}, ${f.followerId}, ${e.targetUserId}, ${e.pageId}, 'REVISION', ${e.revisionId}, ${e.pageVersionId}, ${now}, ${now}
            WHERE NOT EXISTS (
              SELECT 1 FROM "UserActivityAlert"
              WHERE "followId" = ${f.id} AND type = 'REVISION' AND ("revisionId" = ${e.revisionId} OR "pageVersionId" = ${e.pageVersionId})
            )
          `);
          created += 1;
          // Mark as existing for subsequent events in same batch
          existingRevMap.set(key, -1); // placeholder to avoid multiple inserts in same batch
        }
      }
    }

    // Prepare existing unread map for attribution type
    const attrPageIds = Array.from(new Set([...addEvents.map(e => e.pageId), ...removeEvents.map(e => e.pageId)]));
    const existingAttr = (revFollowIds.length > 0 && attrPageIds.length > 0)
      ? await this.prisma.$queryRaw<Array<{ id: number; followId: number; pageId: number }>>(Prisma.sql`
          SELECT id, "followId", "pageId"
          FROM "UserActivityAlert"
          WHERE "acknowledgedAt" IS NULL AND type = 'ATTRIBUTION'
            AND "followId" = ANY(ARRAY[${Prisma.join(revFollowIds.map(x => Prisma.sql`${x}`))}]::int[])
            AND "pageId" = ANY(ARRAY[${Prisma.join(attrPageIds.map(x => Prisma.sql`${x}`))}]::int[])
        `)
      : [];
    const existingAttrMap = new Map<string, number>();
    for (const row of existingAttr) {
      existingAttrMap.set(`${row.followId}:${row.pageId}`, Number(row.id));
    }

    // Process attribution additions
    for (const e of addEvents) {
      const list = followsByTarget.get(e.targetUserId) || [];
      for (const f of list) {
        const key = `${f.id}:${e.pageId}`;
        const unreadId = existingAttrMap.get(key);
        if (unreadId) {
          await this.prisma.$executeRaw(Prisma.sql`
            UPDATE "UserActivityAlert"
            SET "attributionId" = ${e.attributionId}, "pageVersionId" = ${e.pageVersionId}, "detectedAt" = ${now}
            WHERE id = ${unreadId}
          `);
          updated += 1;
        } else {
          await this.prisma.$executeRaw(Prisma.sql`
            INSERT INTO "UserActivityAlert" ("followId", "followerId", "targetUserId", "pageId", type, "attributionId", "pageVersionId", "detectedAt", "createdAt")
            SELECT ${f.id}, ${f.followerId}, ${e.targetUserId}, ${e.pageId}, 'ATTRIBUTION', ${e.attributionId}, ${e.pageVersionId}, ${now}, ${now}
            WHERE NOT EXISTS (
              SELECT 1 FROM "UserActivityAlert"
              WHERE "followId" = ${f.id} AND type = 'ATTRIBUTION' AND ("attributionId" = ${e.attributionId} OR "pageVersionId" = ${e.pageVersionId})
            )
          `);
          created += 1;
          existingAttrMap.set(key, -1);
        }
      }
    }

    // Also existing unread for removed attribution
    const existingAttrRemoved = (revFollowIds.length > 0 && attrPageIds.length > 0)
      ? await this.prisma.$queryRaw<Array<{ id: number; followId: number; pageId: number }>>(Prisma.sql`
          SELECT id, "followId", "pageId"
          FROM "UserActivityAlert"
          WHERE "acknowledgedAt" IS NULL AND type = 'ATTRIBUTION_REMOVED'
            AND "followId" = ANY(ARRAY[${Prisma.join(revFollowIds.map(x => Prisma.sql`${x}`))}]::int[])
            AND "pageId" = ANY(ARRAY[${Prisma.join(attrPageIds.map(x => Prisma.sql`${x}`))}]::int[])
        `)
      : [];
    const existingAttrRemovedMap = new Map<string, number>();
    for (const row of existingAttrRemoved) {
      existingAttrRemovedMap.set(`${row.followId}:${row.pageId}`, Number(row.id));
    }
    // Process attribution removals
    for (const e of removeEvents) {
      const list = followsByTarget.get(e.targetUserId) || [];
      for (const f of list) {
        const key = `${f.id}:${e.pageId}`;
        const unreadId = existingAttrRemovedMap.get(key);
        if (unreadId) {
          await this.prisma.$executeRaw(Prisma.sql`
            UPDATE "UserActivityAlert"
            SET "attributionId" = ${e.attributionId}, "pageVersionId" = ${e.pageVersionId}, "detectedAt" = ${now}
            WHERE id = ${unreadId}
          `);
          updated += 1;
        } else {
          await this.prisma.$executeRaw(Prisma.sql`
            INSERT INTO "UserActivityAlert" ("followId", "followerId", "targetUserId", "pageId", type, "attributionId", "pageVersionId", "detectedAt", "createdAt")
            SELECT ${f.id}, ${f.followerId}, ${e.targetUserId}, ${e.pageId}, 'ATTRIBUTION_REMOVED', ${e.attributionId}, ${e.pageVersionId}, ${now}, ${now}
            WHERE NOT EXISTS (
              SELECT 1 FROM "UserActivityAlert"
              WHERE "followId" = ${f.id} AND type = 'ATTRIBUTION_REMOVED' AND "pageVersionId" = ${e.pageVersionId}
            )
          `);
          created += 1;
          existingAttrRemovedMap.set(key, -1);
        }
      }
    }

    if (created > 0 || updated > 0) {
      Logger.info(`[follow-activity] Created ${created} and updated ${updated} follow activity alerts.`);
    } else {
      Logger.debug('[follow-activity] No follow activity alerts to upsert.');
    }
  }
}
