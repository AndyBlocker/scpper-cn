import type { Pool } from 'pg';

export interface UserBasic {
  id: number;
  wikidotId: number;
  displayName: string | null;
  firstActivityAt: Date | null;
  lastActivityAt: Date | null;
}

export interface UserCardStats {
  rank: number | null;
  totalRating: number;
  meanRating: number;
  pageCount: number;
  votesUp: number;
  votesDown: number;
  totalUp: number;
  totalDown: number;
  favTag: string | null;
  categories: Array<{
    key: string;
    label: string;
    rank: number | null;
    rating: number;
    pageCount: number;
  }>;
}

export interface VotingSeries {
  dates: string[];
  dailyUpvotes: number[];
  dailyDownvotes: number[];
  upvotes: number[];
  downvotes: number[];
  totalVotes: number[];
}

const CATEGORY_MAP: Array<{ key: string; label: string; rankField: string; ratingField: string; countField: string }> = [
  { key: 'scp', label: 'SCP', rankField: 'scpRank', ratingField: 'scpRating', countField: 'scpPageCount' },
  { key: 'story', label: '故事', rankField: 'storyRank', ratingField: 'storyRating', countField: 'storyPageCount' },
  { key: 'translation', label: '翻译', rankField: 'translationRank', ratingField: 'translationRating', countField: 'translationPageCount' },
  { key: 'goi', label: 'GoI', rankField: 'goiRank', ratingField: 'goiRating', countField: 'goiPageCount' },
  { key: 'wanderers', label: '漫游者', rankField: 'wanderersRank', ratingField: 'wanderersRating', countField: 'wanderersPageCount' },
  { key: 'art', label: '艺术', rankField: 'artRank', ratingField: 'artRating', countField: 'artPageCount' }
];

export async function loadUserBasicByWikidotId(
  pool: Pool,
  wikidotId: number
): Promise<UserBasic | null> {
  const { rows } = await pool.query(
    `SELECT id, "wikidotId", "displayName", "firstActivityAt", "lastActivityAt"
     FROM "User"
     WHERE "wikidotId" = $1`,
    [wikidotId]
  );
  if (!rows.length) return null;
  const r = rows[0];
  return {
    id: Number(r.id),
    wikidotId: Number(r.wikidotId),
    displayName: r.displayName ?? null,
    firstActivityAt: r.firstActivityAt ? new Date(r.firstActivityAt) : null,
    lastActivityAt: r.lastActivityAt ? new Date(r.lastActivityAt) : null
  };
}

export async function loadUserCardStats(
  pool: Pool,
  wikidotId: number
): Promise<UserCardStats | null> {
  const { rows } = await pool.query(
    `SELECT
       us."overallRank" AS rank,
       COALESCE(us."totalRating", 0)::int AS "totalRating",
       COALESCE(us."overallRating", 0)::float AS "meanRating",
       COALESCE(us."pageCount", 0)::int AS "pageCount",
       COALESCE(us."votesCastUp", 0)::int AS "votesUp",
       COALESCE(us."votesCastDown", 0)::int AS "votesDown",
       COALESCE(us."totalUp", 0)::int AS "totalUp",
       COALESCE(us."totalDown", 0)::int AS "totalDown",
       us."favTag",
       us."scpRank", COALESCE(us."scpRating", 0)::float AS "scpRating", COALESCE(us."scpPageCount", 0)::int AS "scpPageCount",
       us."storyRank", COALESCE(us."storyRating", 0)::float AS "storyRating", COALESCE(us."storyPageCount", 0)::int AS "storyPageCount",
       us."translationRank", COALESCE(us."translationRating", 0)::float AS "translationRating", COALESCE(us."translationPageCount", 0)::int AS "translationPageCount",
       us."goiRank", COALESCE(us."goiRating", 0)::float AS "goiRating", COALESCE(us."goiPageCount", 0)::int AS "goiPageCount",
       us."wanderersRank", COALESCE(us."wanderersRating", 0)::float AS "wanderersRating", COALESCE(us."wanderersPageCount", 0)::int AS "wanderersPageCount",
       us."artRank", COALESCE(us."artRating", 0)::float AS "artRating", COALESCE(us."artPageCount", 0)::int AS "artPageCount"
     FROM "UserStats" us
     JOIN "User" u ON us."userId" = u.id
     WHERE u."wikidotId" = $1`,
    [wikidotId]
  );
  if (!rows.length) return null;
  const r = rows[0] as any;

  const categories = CATEGORY_MAP.map(({ key, label, rankField, ratingField, countField }) => ({
    key,
    label,
    rank: r[rankField] != null ? Number(r[rankField]) : null,
    rating: Number(r[ratingField] ?? 0),
    pageCount: Number(r[countField] ?? 0)
  }));

  return {
    rank: r.rank != null ? Number(r.rank) : null,
    totalRating: Number(r.totalRating ?? 0),
    meanRating: Number(r.meanRating ?? 0),
    pageCount: Number(r.pageCount ?? 0),
    votesUp: Number(r.votesUp ?? 0),
    votesDown: Number(r.votesDown ?? 0),
    totalUp: Number(r.totalUp ?? 0),
    totalDown: Number(r.totalDown ?? 0),
    favTag: r.favTag ?? null,
    categories
  };
}

export async function loadUserVotingSeries(
  pool: Pool,
  wikidotId: number
): Promise<VotingSeries | null> {
  const { rows } = await pool.query(
    `SELECT "attributionVotingTimeSeriesCache" AS cache
     FROM "User"
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

export async function loadUserActivityHeatmap(
  pool: Pool,
  userId: number,
  days: number
): Promise<Array<{ date: string; votes: number; pages: number }>> {
  const { rows } = await pool.query(
    `SELECT
       to_char(date::date, 'YYYY-MM-DD') AS date,
       COALESCE("votes_cast", 0)::int AS votes,
       COALESCE("pages_created", 0)::int AS pages
     FROM "UserDailyStats"
     WHERE "userId" = $1
       AND date >= CURRENT_DATE - ($2::int - 1) * INTERVAL '1 day'
     ORDER BY date ASC`,
    [userId, Math.max(1, Math.min(days, 366))]
  );
  return rows.map(r => ({
    date: String(r.date),
    votes: Number(r.votes),
    pages: Number(r.pages)
  }));
}
