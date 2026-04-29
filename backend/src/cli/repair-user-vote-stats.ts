import type { PrismaClient } from '@prisma/client';
import { UserRatingSystem } from '../jobs/UserRatingJob.js';
import { UserSocialAnalysisJob } from '../jobs/UserSocialAnalysisJob.js';

export interface RepairUserVoteStatsOptions {
  batchSize: number;
  dryRun?: boolean;
  socialOnly?: boolean;
  userStatsOnly?: boolean;
}

function toInt(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function printStats(label: string, row: Record<string, unknown>) {
  console.log(`\n${label}`);
  for (const [key, value] of Object.entries(row)) {
    console.log(`  ${key}: ${String(value ?? 0)}`);
  }
}

async function dryRunTagPreferences(prisma: PrismaClient) {
  const rows = await prisma.$queryRaw<Array<Record<string, unknown>>>`
    WITH latest_vote_candidates AS (
      SELECT
        v.id,
        v."userId",
        pv."pageId",
        v.direction,
        v.timestamp,
        ROW_NUMBER() OVER (
          PARTITION BY v."userId", pv."pageId"
          ORDER BY v.timestamp DESC, v.id DESC
        ) AS rn
      FROM "Vote" v
      JOIN "PageVersion" pv ON pv.id = v."pageVersionId"
      WHERE v."userId" IS NOT NULL
    ),
    latest_user_page_votes AS (
      SELECT "userId", "pageId", direction, timestamp
      FROM latest_vote_candidates
      WHERE rn = 1
        AND direction != 0
    ),
    user_tag_votes AS (
      SELECT
        lupv."userId",
        unnest(pv_pick.tags) AS tag,
        lupv.direction,
        lupv.timestamp
      FROM latest_user_page_votes lupv
      JOIN LATERAL (
        SELECT pv2.tags, pv2."isDeleted"
        FROM "PageVersion" pv2
        WHERE pv2."pageId" = lupv."pageId"
        ORDER BY
          (pv2."validTo" IS NULL) DESC,
          (NOT pv2."isDeleted") DESC,
          pv2."validFrom" DESC NULLS LAST,
          pv2.id DESC
        LIMIT 1
      ) pv_pick ON TRUE
      WHERE pv_pick."isDeleted" = false
        AND pv_pick.tags IS NOT NULL
        AND array_length(pv_pick.tags, 1) > 0
    ),
    recomputed AS (
      SELECT
        "userId",
        tag,
        COUNT(*) FILTER (WHERE direction > 0)::int AS upvote_count,
        COUNT(*) FILTER (WHERE direction < 0)::int AS downvote_count,
        COUNT(*)::int AS total_votes
      FROM user_tag_votes
      WHERE tag NOT IN ('页面', '重定向', '管理', '_cc')
      GROUP BY "userId", tag
      HAVING COUNT(*) >= 3
    ),
    current_stats AS (
      SELECT
        COUNT(*)::bigint AS current_rows,
        COALESCE(SUM("totalVotes"), 0)::bigint AS current_total_votes,
        COALESCE(SUM("upvoteCount"), 0)::bigint AS current_upvotes,
        COALESCE(SUM("downvoteCount"), 0)::bigint AS current_downvotes
      FROM "UserTagPreference"
    ),
    recomputed_stats AS (
      SELECT
        COUNT(*)::bigint AS recomputed_rows,
        COALESCE(SUM(total_votes), 0)::bigint AS recomputed_total_votes,
        COALESCE(SUM(upvote_count), 0)::bigint AS recomputed_upvotes,
        COALESCE(SUM(downvote_count), 0)::bigint AS recomputed_downvotes
      FROM recomputed
    ),
    diff_stats AS (
      SELECT
        COUNT(*) FILTER (WHERE c."userId" IS NULL)::bigint AS rows_to_insert,
        COUNT(*) FILTER (WHERE r."userId" IS NULL)::bigint AS rows_to_delete,
        COUNT(*) FILTER (
          WHERE c."userId" IS NOT NULL
            AND r."userId" IS NOT NULL
            AND (
              c."upvoteCount" <> r.upvote_count
              OR c."downvoteCount" <> r.downvote_count
              OR c."totalVotes" <> r.total_votes
            )
        )::bigint AS rows_to_update
      FROM "UserTagPreference" c
      FULL OUTER JOIN recomputed r
        ON r."userId" = c."userId"
       AND r.tag = c.tag
    )
    SELECT *
    FROM current_stats
    CROSS JOIN recomputed_stats
    CROSS JOIN diff_stats
  `;

  printStats('UserTagPreference dry run', rows[0] ?? {});
}

async function dryRunVoteInteractions(prisma: PrismaClient) {
  const rows = await prisma.$queryRaw<Array<Record<string, unknown>>>`
    WITH effective_attributions AS (
      SELECT DISTINCT a."pageVerId", a."userId"
      FROM (
        SELECT
          a.*,
          BOOL_OR(a.type <> 'SUBMITTER') OVER (PARTITION BY a."pageVerId") AS has_non_submitter
        FROM "Attribution" a
      ) a
      WHERE NOT (a.has_non_submitter AND a.type = 'SUBMITTER')
        AND a."userId" IS NOT NULL
    ),
    latest_vote_candidates AS (
      SELECT
        v.id,
        v."userId" AS from_user_id,
        pv."pageId" AS page_id,
        v.direction,
        v.timestamp,
        ROW_NUMBER() OVER (
          PARTITION BY v."userId", pv."pageId"
          ORDER BY v.timestamp DESC, v.id DESC
        ) AS rn
      FROM "Vote" v
      JOIN "PageVersion" pv ON pv.id = v."pageVersionId"
      WHERE v."userId" IS NOT NULL
    ),
    latest_user_page_votes AS (
      SELECT from_user_id, page_id, direction, timestamp
      FROM latest_vote_candidates
      WHERE rn = 1
        AND direction != 0
    ),
    vote_interactions AS (
      SELECT
        lupv.from_user_id,
        a."userId" AS to_user_id,
        lupv.direction
      FROM latest_user_page_votes lupv
      JOIN LATERAL (
        SELECT pv2.id, pv2."isDeleted"
        FROM "PageVersion" pv2
        WHERE pv2."pageId" = lupv.page_id
        ORDER BY
          (pv2."validTo" IS NULL) DESC,
          (NOT pv2."isDeleted") DESC,
          pv2."validFrom" DESC NULLS LAST,
          pv2.id DESC
        LIMIT 1
      ) pv_pick ON TRUE
      JOIN effective_attributions a ON a."pageVerId" = pv_pick.id
      WHERE lupv.from_user_id != a."userId"
        AND pv_pick."isDeleted" = false
    ),
    recomputed AS (
      SELECT
        from_user_id,
        to_user_id,
        COUNT(*) FILTER (WHERE direction > 0)::int AS upvote_count,
        COUNT(*) FILTER (WHERE direction < 0)::int AS downvote_count,
        COUNT(*)::int AS total_votes
      FROM vote_interactions
      GROUP BY from_user_id, to_user_id
    ),
    current_stats AS (
      SELECT
        COUNT(*)::bigint AS current_rows,
        COALESCE(SUM("totalVotes"), 0)::bigint AS current_total_votes,
        COALESCE(SUM("upvoteCount"), 0)::bigint AS current_upvotes,
        COALESCE(SUM("downvoteCount"), 0)::bigint AS current_downvotes
      FROM "UserVoteInteraction"
    ),
    recomputed_stats AS (
      SELECT
        COUNT(*)::bigint AS recomputed_rows,
        COALESCE(SUM(total_votes), 0)::bigint AS recomputed_total_votes,
        COALESCE(SUM(upvote_count), 0)::bigint AS recomputed_upvotes,
        COALESCE(SUM(downvote_count), 0)::bigint AS recomputed_downvotes
      FROM recomputed
    ),
    diff_stats AS (
      SELECT
        COUNT(*) FILTER (WHERE c."fromUserId" IS NULL)::bigint AS rows_to_insert,
        COUNT(*) FILTER (WHERE r.from_user_id IS NULL)::bigint AS rows_to_delete,
        COUNT(*) FILTER (
          WHERE c."fromUserId" IS NOT NULL
            AND r.from_user_id IS NOT NULL
            AND (
              c."upvoteCount" <> r.upvote_count
              OR c."downvoteCount" <> r.downvote_count
              OR c."totalVotes" <> r.total_votes
            )
        )::bigint AS rows_to_update
      FROM "UserVoteInteraction" c
      FULL OUTER JOIN recomputed r
        ON r.from_user_id = c."fromUserId"
       AND r.to_user_id = c."toUserId"
    )
    SELECT *
    FROM current_stats
    CROSS JOIN recomputed_stats
    CROSS JOIN diff_stats
  `;

  printStats('UserVoteInteraction dry run', rows[0] ?? {});
}

async function dryRunUserStatsVoteTotals(prisma: PrismaClient) {
  const rows = await prisma.$queryRaw<Array<Record<string, unknown>>>`
    WITH effective_attributions AS (
      SELECT DISTINCT a."pageVerId", a."userId"
      FROM (
        SELECT
          a.*,
          BOOL_OR(a.type <> 'SUBMITTER') OVER (PARTITION BY a."pageVerId") AS has_non_submitter
        FROM "Attribution" a
      ) a
      WHERE NOT (a.has_non_submitter AND a.type = 'SUBMITTER')
        AND a."userId" IS NOT NULL
    ),
    votes_cast_raw AS (
      SELECT
        v.id,
        v."userId",
        pv."pageId",
        v.timestamp,
        v.direction
      FROM "Vote" v
      JOIN "PageVersion" pv ON pv.id = v."pageVersionId"
      WHERE v."userId" IS NOT NULL
    ),
    votes_cast_ranked AS (
      SELECT
        r.*,
        ROW_NUMBER() OVER (
          PARTITION BY r."userId", r."pageId"
          ORDER BY r.timestamp DESC, r.id DESC
        ) AS rn
      FROM votes_cast_raw r
    ),
    votes_cast AS (
      SELECT
        r."userId" AS "userId",
        COUNT(*) FILTER (WHERE r.direction > 0) AS votes_cast_up,
        COUNT(*) FILTER (WHERE r.direction < 0) AS votes_cast_down
      FROM votes_cast_ranked r
      WHERE r.rn = 1
      GROUP BY r."userId"
    ),
    votes_received_raw AS (
      SELECT
        v.id,
        v.timestamp,
        v.direction,
        pv."pageId" AS page_id,
        CASE
          WHEN v."userId" IS NOT NULL THEN 'u:' || v."userId"::text
          WHEN v."anonKey" IS NOT NULL THEN 'a:' || v."anonKey"
          ELSE 'g:' || v.id::text
        END AS actor_key
      FROM "Vote" v
      JOIN "PageVersion" pv ON pv.id = v."pageVersionId"
    ),
    votes_received_ranked AS (
      SELECT
        r.*,
        ROW_NUMBER() OVER (
          PARTITION BY r.page_id, r.actor_key
          ORDER BY r.timestamp DESC, r.id DESC
        ) AS rn
      FROM votes_received_raw r
    ),
    latest_received AS (
      SELECT page_id, direction
      FROM votes_received_ranked
      WHERE rn = 1
        AND direction <> 0
    ),
    votes_received_attrib AS (
      SELECT
        a."userId" AS "userId",
        lr.direction AS direction
      FROM latest_received lr
      LEFT JOIN LATERAL (
        SELECT pv3.id
        FROM "PageVersion" pv3
        WHERE pv3."pageId" = lr.page_id
        ORDER BY
          (pv3."validTo" IS NULL) DESC,
          (NOT pv3."isDeleted") DESC,
          pv3."validFrom" DESC NULLS LAST,
          pv3.id DESC
        LIMIT 1
      ) pv_pick ON TRUE
      JOIN effective_attributions a ON a."pageVerId" = pv_pick.id
    ),
    votes_received AS (
      SELECT
        vra."userId",
        COUNT(*) FILTER (WHERE vra.direction > 0) AS votes_received_up,
        COUNT(*) FILTER (WHERE vra.direction < 0) AS votes_received_down
      FROM votes_received_attrib vra
      GROUP BY vra."userId"
    ),
    recomputed AS (
      SELECT
        us."userId",
        COALESCE(vc.votes_cast_up, 0)::int AS votes_cast_up,
        COALESCE(vc.votes_cast_down, 0)::int AS votes_cast_down,
        COALESCE(vr.votes_received_up, 0)::int AS votes_received_up,
        COALESCE(vr.votes_received_down, 0)::int AS votes_received_down
      FROM "UserStats" us
      LEFT JOIN votes_cast vc ON vc."userId" = us."userId"
      LEFT JOIN votes_received vr ON vr."userId" = us."userId"
    )
    SELECT
      COUNT(*) FILTER (
        WHERE us."votesCastUp" <> r.votes_cast_up
           OR us."votesCastDown" <> r.votes_cast_down
           OR us."totalUp" <> r.votes_received_up
           OR us."totalDown" <> r.votes_received_down
      )::bigint AS rows_to_update,
      COALESCE(SUM(us."votesCastUp"), 0)::bigint AS current_votes_cast_up,
      COALESCE(SUM(r.votes_cast_up), 0)::bigint AS recomputed_votes_cast_up,
      COALESCE(SUM(us."votesCastDown"), 0)::bigint AS current_votes_cast_down,
      COALESCE(SUM(r.votes_cast_down), 0)::bigint AS recomputed_votes_cast_down,
      COALESCE(SUM(us."totalUp"), 0)::bigint AS current_votes_received_up,
      COALESCE(SUM(r.votes_received_up), 0)::bigint AS recomputed_votes_received_up,
      COALESCE(SUM(us."totalDown"), 0)::bigint AS current_votes_received_down,
      COALESCE(SUM(r.votes_received_down), 0)::bigint AS recomputed_votes_received_down
    FROM "UserStats" us
    JOIN recomputed r ON r."userId" = us."userId"
  `;

  printStats('UserStats vote totals dry run', rows[0] ?? {});
}

async function runDryRun(prisma: PrismaClient, options: RepairUserVoteStatsOptions) {
  console.log('DRY RUN: no writes will be performed; gacha market/category index ticks are not invoked.');

  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
    if (!options.userStatsOnly) {
      await dryRunTagPreferences(tx as PrismaClient);
      await dryRunVoteInteractions(tx as PrismaClient);
    }
    if (!options.socialOnly) {
      await dryRunUserStatsVoteTotals(tx as PrismaClient);
    }
  }, { timeout: 300_000 });
}

export async function runRepairUserVoteStats(prisma: PrismaClient, options: RepairUserVoteStatsOptions): Promise<void> {
  if (options.socialOnly && options.userStatsOnly) {
    throw new Error('--social-only and --user-stats-only cannot be used together');
  }

  if (options.dryRun) {
    await runDryRun(prisma, options);
    return;
  }

  if (!options.userStatsOnly) {
    const socialJob = new UserSocialAnalysisJob(prisma);
    await socialJob.execute({ forceFullAnalysis: true, batchSize: options.batchSize });
  }

  if (!options.socialOnly) {
    const ratingSystem = new UserRatingSystem(prisma);
    await ratingSystem.updateUserRatingsAndRankings();
  }
}
