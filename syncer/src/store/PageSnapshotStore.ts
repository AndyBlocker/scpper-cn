import { getSyncerPrisma, getMainPool } from './db.js';
import type { PageSnapshotEntry, PageSnapshotMap } from '../scanner/PageScanner.js';

/**
 * 从 syncer DB 加载上次 PageSnapshot（用于 diff 的基准）
 */
export async function loadSnapshots(): Promise<PageSnapshotMap> {
  const prisma = getSyncerPrisma();
  const rows = await prisma.pageSnapshot.findMany();
  const map: PageSnapshotMap = new Map();
  for (const r of rows as any[]) {
    map.set(r.fullname, {
      fullname: r.fullname,
      title: r.title ?? '',
      rating: r.rating,
      votesCount: r.votesCount,
      commentsCount: r.commentsCount,
      size: r.size,
      revisionsCount: r.revisionsCount,
      parentFullname: r.parentFullname ?? null,
      createdAtTs: r.createdAt ? Number(r.createdAt) : null,
      updatedAtTs: r.updatedAt ? Number(r.updatedAt) : null,
      tags: r.tags ?? [],
      createdBy: r.createdBy ?? null,
    });
  }
  return map;
}

/**
 * 从主库 PageVersion 引导 PageSnapshot 基准（首次启动时）
 */
export async function bootstrapFromMainDb(): Promise<PageSnapshotMap> {
  console.log('[snapshot] Bootstrapping from main DB...');
  const pool = getMainPool();
  const { rows } = await pool.query<{
    fullname: string;
    wikidot_id: string;
    title: string | null;
    rating: string | null;
    votes_count: string | null;
    comment_count: string | null;
    revision_count: string | null;
    tags: string[] | null;
    category: string | null;
  }>(`
    SELECT
      SUBSTRING(p."currentUrl" FROM '//[^/]+/(.+)$') AS fullname,
      p."wikidotId"::text AS wikidot_id,
      pv.title,
      pv.rating::text,
      pv."voteCount"::text AS votes_count,
      pv."commentCount"::text AS comment_count,
      pv."revisionCount"::text AS revision_count,
      pv.tags,
      pv.category
    FROM "PageVersion" pv
    JOIN "Page" p ON p.id = pv."pageId"
    WHERE pv."validTo" IS NULL
      AND p."isDeleted" = false
  `);

  const map: PageSnapshotMap = new Map();
  for (const r of rows) {
    if (!r.fullname) continue;
    map.set(r.fullname, {
      fullname: r.fullname,
      title: r.title ?? '',
      rating: r.rating != null ? parseInt(r.rating, 10) : 0,
      votesCount: r.votes_count != null ? parseInt(r.votes_count, 10) : 0,
      commentsCount: r.comment_count != null ? parseInt(r.comment_count, 10) : 0,
      size: 0, // 主库无此字段，首次 Tier 1 扫描后补充
      revisionsCount: r.revision_count != null ? parseInt(r.revision_count, 10) : 0,
      parentFullname: null, // 主库无此字段
      createdAtTs: null,
      updatedAtTs: null,
      tags: r.tags ?? [],
      createdBy: null,
    });
  }

  console.log(`[snapshot] Bootstrapped ${map.size} pages from main DB`);
  return map;
}

/**
 * 获取主库的 fullname → wikidotId 映射
 */
export async function loadWikidotIdMap(): Promise<Map<string, number>> {
  const pool = getMainPool();
  const { rows } = await pool.query<{ fullname: string; wikidot_id: string }>(`
    SELECT
      SUBSTRING(p."currentUrl" FROM '//[^/]+/(.+)$') AS fullname,
      p."wikidotId"::text AS wikidot_id
    FROM "Page" p
    WHERE p."isDeleted" = false AND p."wikidotId" IS NOT NULL
  `);
  const map = new Map<string, number>();
  for (const r of rows) {
    if (r.fullname && r.wikidot_id) {
      map.set(r.fullname, parseInt(r.wikidot_id, 10));
    }
  }
  console.log(`[snapshot] Loaded ${map.size} wikidotId mappings`);
  return map;
}

/**
 * 从 syncer DB 中删除已不存在的页面快照（避免重启后幻象 deleted_page）
 */
export async function removeDeletedSnapshots(deletedFullnames: string[]): Promise<number> {
  if (deletedFullnames.length === 0) return 0;
  const prisma = getSyncerPrisma();
  const result = await prisma.pageSnapshot.deleteMany({
    where: { fullname: { in: deletedFullnames } },
  });
  return result.count;
}

/**
 * 批量 upsert PageSnapshot 到 syncer DB
 */
export async function saveSnapshots(entries: PageSnapshotEntry[], wikidotIds: Map<string, number>): Promise<void> {
  const prisma = getSyncerPrisma();
  const now = new Date();

  // Prisma 没有高效的批量 upsert，用 raw SQL
  if (entries.length === 0) return;

  const BATCH = 500;
  for (let i = 0; i < entries.length; i += BATCH) {
    const batch = entries.slice(i, i + BATCH);
    await prisma.$transaction(
      batch.map((e: PageSnapshotEntry) =>
        prisma.pageSnapshot.upsert({
          where: { fullname: e.fullname },
          create: {
            fullname: e.fullname,
            wikidotId: wikidotIds.get(e.fullname) ?? null,
            title: e.title,
            rating: e.rating,
            votesCount: e.votesCount,
            commentsCount: e.commentsCount,
            size: e.size,
            revisionsCount: e.revisionsCount,
            parentFullname: e.parentFullname,
            tags: e.tags,
            createdBy: e.createdBy,
            createdAt: e.createdAtTs != null ? BigInt(e.createdAtTs) : null,
            updatedAt: e.updatedAtTs != null ? BigInt(e.updatedAtTs) : null,
            scannedAt: now,
          },
          update: {
            wikidotId: wikidotIds.get(e.fullname) ?? undefined,
            title: e.title,
            rating: e.rating,
            votesCount: e.votesCount,
            commentsCount: e.commentsCount,
            size: e.size,
            revisionsCount: e.revisionsCount,
            parentFullname: e.parentFullname,
            tags: e.tags,
            createdBy: e.createdBy,
            createdAt: e.createdAtTs != null ? BigInt(e.createdAtTs) : null,
            updatedAt: e.updatedAtTs != null ? BigInt(e.updatedAtTs) : null,
            scannedAt: now,
          },
        })
      )
    );
  }
}
