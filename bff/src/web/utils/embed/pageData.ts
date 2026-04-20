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
  isDeleted: boolean;
  firstPublishedAt: Date | null;
}

/**
 * 拿到当前活跃版本（validTo IS NULL）的 PageVersion + PageStats，一次查询。
 */
export async function loadPageBadgeData(
  pool: Pool,
  wikidotId: number
): Promise<PageBadgeData | null> {
  const { rows } = await pool.query(
    `SELECT
       p.id AS "pageId",
       p."wikidotId",
       p."firstPublishedAt",
       p."isDeleted",
       pv.title,
       pv."alternateTitle",
       COALESCE(pv.rating, 0)::int AS rating,
       COALESCE(pv."voteCount", 0)::int AS "voteCount",
       ps.wilson95,
       ps.controversy
     FROM "Page" p
     JOIN "PageVersion" pv ON pv."pageId" = p.id AND pv."validTo" IS NULL
     LEFT JOIN "PageStats" ps ON ps."pageVersionId" = pv.id
     WHERE p."wikidotId" = $1`,
    [wikidotId]
  );
  if (!rows.length) return null;
  const r = rows[0];
  return {
    pageId: Number(r.pageId),
    wikidotId: Number(r.wikidotId),
    title: r.title ?? null,
    alternateTitle: r.alternateTitle ?? null,
    rating: Number(r.rating ?? 0),
    voteCount: Number(r.voteCount ?? 0),
    wilson95: r.wilson95 != null ? Number(r.wilson95) : null,
    controversy: r.controversy != null ? Number(r.controversy) : null,
    isDeleted: Boolean(r.isDeleted),
    firstPublishedAt: r.firstPublishedAt ? new Date(r.firstPublishedAt) : null
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
