import type { Pool } from 'pg';
import type { VotingSeries } from './userData.js';

export interface PageBadgeData {
  pageId: number;
  wikidotId: number;
  title: string | null;
  alternateTitle: string | null;
  rating: number;
  voteCount: number;
  wilson95: number | null;
  controversy: number | null;
  /** 返回的 PageVersion 本身是否为 tombstone（isDeleted=true）。常见用途：决定徽章是否加 "deleted" 前缀。 */
  isDeleted: boolean;
  /** 当前版本是 tombstone、已回退到最后一个非 deleted 版本时为 true。 */
  fromDeletedFallback: boolean;
  firstPublishedAt: Date | null;
}

/**
 * Badge 的 effective-version 选择：优先取 `validTo IS NULL` 的当前版本；若当前版本
 * 本身是 tombstone（isDeleted），回退到最近的非 deleted 版本。保持和
 * `/stats/pages/:wikidotId` 口径一致（参考 `bff/src/web/routes/stats.ts:442` 附近）。
 */
async function resolvePageBadgeVersion(
  pool: Pool,
  wikidotId: number
): Promise<{ pageId: number; versionId: number; fromDeleted: boolean; firstPublishedAt: Date | null } | null> {
  const pageRes = await pool.query(
    `SELECT id, "firstPublishedAt"
       FROM "Page"
      WHERE "wikidotId" = $1
      LIMIT 1`,
    [wikidotId]
  );
  if (!pageRes.rows.length) return null;
  const pageId = Number(pageRes.rows[0].id);
  const firstPublishedAt = pageRes.rows[0].firstPublishedAt
    ? new Date(pageRes.rows[0].firstPublishedAt)
    : null;

  const currentRes = await pool.query(
    `SELECT id, "isDeleted"
       FROM "PageVersion"
      WHERE "pageId" = $1 AND "validTo" IS NULL
      ORDER BY id DESC
      LIMIT 1`,
    [pageId]
  );
  const current = currentRes.rows[0] ?? null;
  let versionId: number | null = current?.id ?? null;
  const currentDeleted = current?.isDeleted === true;
  let fromDeleted = false;

  if (!versionId || currentDeleted) {
    const fallbackRes = await pool.query(
      `SELECT id
         FROM "PageVersion"
        WHERE "pageId" = $1 AND "isDeleted" = false
        ORDER BY "validFrom" DESC NULLS LAST, id DESC
        LIMIT 1`,
      [pageId]
    );
    if (fallbackRes.rows.length > 0) {
      versionId = Number(fallbackRes.rows[0].id);
      fromDeleted = true;
    }
  }

  if (!versionId) return null;
  return { pageId, versionId, fromDeleted, firstPublishedAt };
}

export async function loadPageBadgeData(
  pool: Pool,
  wikidotId: number
): Promise<PageBadgeData | null> {
  const resolved = await resolvePageBadgeVersion(pool, wikidotId);
  if (!resolved) return null;

  const { rows } = await pool.query(
    `SELECT
       pv.title,
       pv."alternateTitle",
       pv."isDeleted" AS "versionIsDeleted",
       COALESCE(pv.rating, 0)::int AS rating,
       COALESCE(pv."voteCount", 0)::int AS "voteCount",
       ps.wilson95,
       ps.controversy
     FROM "PageVersion" pv
     LEFT JOIN "PageStats" ps ON ps."pageVersionId" = pv.id
     WHERE pv.id = $1
     LIMIT 1`,
    [resolved.versionId]
  );
  if (!rows.length) return null;
  const r = rows[0];
  return {
    pageId: resolved.pageId,
    wikidotId,
    title: r.title ?? null,
    alternateTitle: r.alternateTitle ?? null,
    rating: Number(r.rating ?? 0),
    voteCount: Number(r.voteCount ?? 0),
    wilson95: r.wilson95 != null ? Number(r.wilson95) : null,
    controversy: r.controversy != null ? Number(r.controversy) : null,
    isDeleted: Boolean(r.versionIsDeleted),
    fromDeletedFallback: resolved.fromDeleted,
    firstPublishedAt: resolved.firstPublishedAt
  };
}

export async function loadPageVotingSeries(
  pool: Pool,
  wikidotId: number
): Promise<VotingSeries | null> {
  const { rows } = await pool.query(
    `SELECT "votingTimeSeriesCache" AS cache
     FROM "Page"
     WHERE "wikidotId" = $1`,
    [wikidotId]
  );
  const cache = rows[0]?.cache;
  if (!cache || typeof cache !== 'object') return null;
  const src = cache as Partial<VotingSeries>;
  if (!Array.isArray(src.dates) || src.dates.length === 0) return null;
  return {
    dates: src.dates.map(String),
    dailyUpvotes: (src.dailyUpvotes ?? []).map(Number),
    dailyDownvotes: (src.dailyDownvotes ?? []).map(Number),
    upvotes: (src.upvotes ?? []).map(Number),
    downvotes: (src.downvotes ?? []).map(Number),
    totalVotes: (src.totalVotes ?? []).map(Number)
  };
}
