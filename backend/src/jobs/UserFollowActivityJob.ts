import { Prisma, PrismaClient } from '@prisma/client';
import { getPrismaClient } from '../utils/db-connection.js';
import { Logger } from '../utils/Logger.js';

type RevisionEvent = { revisionId: number; pageId: number; pageVersionId: number; targetUserId: number; occurredAt: Date };
type AttributionAddEvent = { attributionId: number; pageId: number; pageVersionId: number; targetUserId: number; occurredAt: Date };
type AttributionRemoveEvent = { attributionId: number; pageId: number; pageVersionId: number; targetUserId: number; occurredAt: Date };

export class UserFollowActivityJob {
  private prisma: PrismaClient;

  constructor(prisma?: PrismaClient) {
    this.prisma = prisma || getPrismaClient();
  }

  async run(pageVersionIds: number[]): Promise<void> {
    if (!pageVersionIds || pageVersionIds.length === 0) return;

    // Collect revision events for these page versions
    const revisionRows = await this.prisma.$queryRaw<Array<{ revisionId: number; pageId: number; pageVersionId: number; targetUserId: number; occurredAt: Date }>>`
      SELECT r.id AS "revisionId", pv."pageId" AS "pageId", pv.id AS "pageVersionId", r."userId" AS "targetUserId", r."timestamp" AS "occurredAt"
      FROM "Revision" r
      JOIN "PageVersion" pv ON pv.id = r."pageVersionId"
      WHERE r."userId" IS NOT NULL AND r."pageVersionId" = ANY(${pageVersionIds}::int[])
    `;
    
    // Prepare attribution diff: current vs previous version
    const pvPairs = await this.prisma.$queryRaw<Array<{ pvId: number; pageId: number; previousPvId: number | null; pvValidFrom: Date }>>`
      SELECT pv.id AS "pvId", pv."pageId" AS "pageId",
             (SELECT id FROM "PageVersion" x WHERE x."pageId" = pv."pageId" AND x.id < pv.id ORDER BY x.id DESC LIMIT 1) AS "previousPvId",
             pv."validFrom" AS "pvValidFrom"
      FROM "PageVersion" pv
      WHERE pv.id = ANY(${pageVersionIds}::int[])
    `;
    const allPvIds: number[] = Array.from(new Set(pvPairs.flatMap(p => {
      const ids = [p.pvId];
      if (p.previousPvId != null) ids.push(p.previousPvId);
      return ids;
    })));
    const attributionRows = allPvIds.length === 0
      ? []
      : await this.prisma.$queryRaw<Array<{ attributionId: number; pvId: number; userId: number }>>`
          WITH effective_attributions AS (
            SELECT a.*
            FROM (
              SELECT 
                a.*,
                BOOL_OR(a.type <> 'SUBMITTER') OVER (PARTITION BY a."pageVerId") AS has_non_submitter
              FROM "Attribution" a
              WHERE a."pageVerId" = ANY(${allPvIds}::int[])
            ) a
            WHERE NOT (a.has_non_submitter AND a.type = 'SUBMITTER')
          )
          SELECT a.id AS "attributionId", a."pageVerId" AS "pvId", a."userId" AS "userId"
          FROM effective_attributions a
          WHERE a."pageVerId" = ANY(${allPvIds}::int[])
        `;

    const revEvents: RevisionEvent[] = revisionRows
      .filter(r => r.targetUserId != null)
      .map(r => ({
        revisionId: Number(r.revisionId),
        pageId: Number(r.pageId),
        pageVersionId: Number(r.pageVersionId),
        targetUserId: Number(r.targetUserId),
        occurredAt: r.occurredAt instanceof Date ? r.occurredAt : new Date(r.occurredAt)
      }))
      .filter(r => !Number.isNaN(r.occurredAt.getTime()));

    // Build attribution maps per pageVersion
    const curMap = new Map<number, Map<number, number>>(); // pvId -> (userId -> attributionId)
    for (const row of attributionRows) {
      if (row.userId == null) continue;
      const pvId = Number(row.pvId); const u = Number(row.userId); const aid = Number(row.attributionId);
      if (!curMap.has(pvId)) curMap.set(pvId, new Map());
      curMap.get(pvId)!.set(u, aid);
    }
    const pvValidFromMap = new Map<number, Date>();
    for (const pair of pvPairs) {
      if (!pair.pvValidFrom) continue;
      const pvId = Number(pair.pvId);
      if (pvValidFromMap.has(pvId)) continue;
      const validFrom = pair.pvValidFrom instanceof Date ? pair.pvValidFrom : new Date(pair.pvValidFrom);
      if (!Number.isNaN(validFrom.getTime())) {
        pvValidFromMap.set(pvId, validFrom);
      }
    }

    const addEvents: AttributionAddEvent[] = [];
    const removeEvents: AttributionRemoveEvent[] = [];
    for (const pair of pvPairs) {
      const pvId = Number(pair.pvId);
      const prevId = pair.previousPvId == null ? null : Number(pair.previousPvId);
      const pageId = Number(pair.pageId);
      const occurredAt = pvValidFromMap.get(pvId) ?? new Date();
      const curSet = curMap.get(pvId) || new Map<number, number>();
      const prevSet = prevId != null ? (curMap.get(prevId) || new Map<number, number>()) : new Map<number, number>();
      for (const [userId, aid] of curSet.entries()) {
        if (!prevSet.has(userId)) {
          addEvents.push({ attributionId: aid, pageId, pageVersionId: pvId, targetUserId: userId, occurredAt });
        }
      }
      for (const [userId, prevAid] of prevSet.entries()) {
        if (!curSet.has(userId)) {
          removeEvents.push({ attributionId: prevAid, pageId, pageVersionId: pvId, targetUserId: userId, occurredAt });
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
    const follows = await this.prisma.$queryRaw<Array<{ id: number; followerId: number; targetUserId: number; createdAt: Date }>>`
      SELECT f.id, f."followerId", f."targetUserId", f."createdAt"
      FROM "UserFollow" f
      WHERE f."targetUserId" = ANY(${targetIds}::int[])
    `;

    if (follows.length === 0) {
      Logger.debug('[follow-activity] No followers found for involved targets.');
      return;
    }

    const followsByTarget = new Map<number, Array<{ id: number; followerId: number; createdAt: Date }>>();
    for (const f of follows) {
      const list = followsByTarget.get(f.targetUserId) || [];
      const createdAt = f.createdAt instanceof Date ? f.createdAt : new Date(f.createdAt);
      list.push({ id: Number(f.id), followerId: Number(f.followerId), createdAt });
      followsByTarget.set(f.targetUserId, list);
    }

    const now = new Date();
    let created = 0;
    let updated = 0;

    // Prepare existing unread map for revision type
    const revFollowIds = Array.from(new Set(follows.map(f => f.id)));
    const revPageIds = Array.from(new Set(revEvents.map(e => e.pageId)));
    const existingRev = (revFollowIds.length > 0 && revPageIds.length > 0)
      ? await this.prisma.$queryRaw<Array<{ id: number; followId: number; pageId: number }>>`
          SELECT id, "followId", "pageId"
          FROM "UserActivityAlert"
          WHERE "acknowledgedAt" IS NULL AND type = 'REVISION'
            AND "followId" = ANY(${revFollowIds}::int[])
            AND "pageId" = ANY(${revPageIds}::int[])
        `
      : [];
    const existingRevMap = new Map<string, number>();
    for (const row of existingRev) {
      existingRevMap.set(`${row.followId}:${row.pageId}`, Number(row.id));
    }

    // Process revision events
    for (const e of revEvents) {
      const list = followsByTarget.get(e.targetUserId) || [];
      for (const f of list) {
        const eventTime = e.occurredAt instanceof Date && !Number.isNaN(e.occurredAt.getTime()) ? e.occurredAt : now;
        if (!Number.isNaN(f.createdAt.getTime()) && eventTime < f.createdAt) continue;
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
      ? await this.prisma.$queryRaw<Array<{ id: number; followId: number; pageId: number }>>`
          SELECT id, "followId", "pageId"
          FROM "UserActivityAlert"
          WHERE "acknowledgedAt" IS NULL AND type = 'ATTRIBUTION'
            AND "followId" = ANY(${revFollowIds}::int[])
            AND "pageId" = ANY(${attrPageIds}::int[])
        `
      : [];
    const existingAttrMap = new Map<string, number>();
    for (const row of existingAttr) {
      existingAttrMap.set(`${row.followId}:${row.pageId}`, Number(row.id));
    }

    // Process attribution additions
    for (const e of addEvents) {
      const list = followsByTarget.get(e.targetUserId) || [];
      for (const f of list) {
        const eventTime = e.occurredAt instanceof Date && !Number.isNaN(e.occurredAt.getTime()) ? e.occurredAt : now;
        if (!Number.isNaN(f.createdAt.getTime()) && eventTime < f.createdAt) continue;
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
      ? await this.prisma.$queryRaw<Array<{ id: number; followId: number; pageId: number }>>`
          SELECT id, "followId", "pageId"
          FROM "UserActivityAlert"
          WHERE "acknowledgedAt" IS NULL AND type = 'ATTRIBUTION_REMOVED'
            AND "followId" = ANY(${revFollowIds}::int[])
            AND "pageId" = ANY(${attrPageIds}::int[])
        `
      : [];
    const existingAttrRemovedMap = new Map<string, number>();
    for (const row of existingAttrRemoved) {
      existingAttrRemovedMap.set(`${row.followId}:${row.pageId}`, Number(row.id));
    }
    // Process attribution removals
    for (const e of removeEvents) {
      const list = followsByTarget.get(e.targetUserId) || [];
      for (const f of list) {
        const eventTime = e.occurredAt instanceof Date && !Number.isNaN(e.occurredAt.getTime()) ? e.occurredAt : now;
        if (!Number.isNaN(f.createdAt.getTime()) && eventTime < f.createdAt) continue;
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
