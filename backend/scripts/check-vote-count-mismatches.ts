import { getPrismaClient, disconnectPrisma } from '../src/utils/db-connection.js';
import { Prisma } from '@prisma/client';

type Args = {
  apply: boolean;
  limit: number | null;
};

function parseArgs(argv: string[] = process.argv.slice(2)): Args {
  let apply = false;
  let limit: number | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') apply = true;
    else if (a === '--limit' || a === '-n') {
      const v = parseInt(argv[i + 1] || '', 10);
      if (Number.isFinite(v) && v > 0) {
        limit = v;
        i++;
      }
    }
  }
  return { apply, limit };
}

type VoteMismatch = {
  pageId: number;
  wikidotId: number | null;
  url: string;
  title: string | null;
  storedVoteCount: number | null;
  actualVotes: number;
  distinctUsers: number;
  upvotes: number;
  downvotes: number;
  difference: number;
};

async function main() {
  const args = parseArgs();
  const prisma = getPrismaClient();

  try {
    console.log('=== Checking PageVersion.voteCount mismatches (current versions) ===');
    console.log(`Mode: ${args.apply ? 'APPLY (will update DB)' : 'DRY-RUN (no updates)'}`);
    if (args.limit) {
      console.log(`Limit: will ${args.apply ? 'update' : 'display'} up to ${args.limit} most-different pages`);
    }

    // Overall statistics across ALL current pages
    const overall = await prisma.$queryRaw<Array<{
      total_pages: bigint;
      mismatched_pages: bigint;
      total_actual_votes: bigint;
      total_stored_votes: bigint;
      diff_sum: bigint;
      abs_diff_sum: bigint;
      max_abs_diff: bigint;
    }>>`
      WITH actual AS (
        SELECT 
          pv.id AS page_version_id,
          pv."voteCount" AS stored_vote_count,
          COUNT(v.id) AS actual_votes
        FROM "PageVersion" pv
        LEFT JOIN "Vote" v ON v."pageVersionId" = pv.id
        WHERE pv."validTo" IS NULL
        GROUP BY pv.id, pv."voteCount"
      )
      SELECT 
        COUNT(*) AS total_pages,
        COUNT(*) FILTER (WHERE COALESCE(stored_vote_count, 0) <> actual_votes) AS mismatched_pages,
        SUM(actual_votes) AS total_actual_votes,
        SUM(COALESCE(stored_vote_count, 0)) AS total_stored_votes,
        SUM(actual_votes - COALESCE(stored_vote_count, 0)) AS diff_sum,
        SUM(ABS(actual_votes - COALESCE(stored_vote_count, 0))) AS abs_diff_sum,
        MAX(ABS(actual_votes - COALESCE(stored_vote_count, 0))) AS max_abs_diff
      FROM actual;
    `;

    if (overall.length > 0) {
      const s = overall[0];
      console.log('Overall:');
      console.log(`  Total pages: ${Number(s.total_pages)}`);
      console.log(`  Mismatched pages: ${Number(s.mismatched_pages)}`);
      console.log(`  Total actual votes: ${Number(s.total_actual_votes)}`);
      console.log(`  Total stored votes: ${Number(s.total_stored_votes)}`);
      console.log(`  Sum(actual - stored): ${Number(s.diff_sum)}`);
      console.log(`  Sum(|actual - stored|): ${Number(s.abs_diff_sum)}`);
      console.log(`  Max |actual - stored| on a page: ${Number(s.max_abs_diff)}`);
    }

    const listLimit = args.limit ? Prisma.sql`LIMIT ${args.limit}` : Prisma.sql``;
    const rows = await prisma.$queryRaw<VoteMismatch[]>(Prisma.sql`
      WITH actual AS (
        SELECT 
          pv.id AS page_version_id,
          pv."pageId" AS page_id,
          pv."wikidotId" AS wikidot_id,
          p."currentUrl" AS url,
          pv.title AS title,
          pv."voteCount" AS stored_vote_count,
          COUNT(v.id) AS actual_votes,
          COUNT(DISTINCT v."userId") FILTER (WHERE v."userId" IS NOT NULL) AS distinct_users,
          COUNT(*) FILTER (WHERE v.direction = 1) AS upvotes,
          COUNT(*) FILTER (WHERE v.direction = -1) AS downvotes
        FROM "PageVersion" pv
        INNER JOIN "Page" p ON p.id = pv."pageId"
        LEFT JOIN "Vote" v ON v."pageVersionId" = pv.id
        WHERE pv."validTo" IS NULL
        GROUP BY pv.id, pv."pageId", pv."wikidotId", p."currentUrl", pv.title, pv."voteCount"
      )
      SELECT 
        page_id AS "pageId",
        wikidot_id AS "wikidotId",
        url,
        title,
        stored_vote_count AS "storedVoteCount",
        actual_votes::int AS "actualVotes",
        distinct_users::int AS "distinctUsers",
        upvotes::int AS upvotes,
        downvotes::int AS downvotes,
        (actual_votes - COALESCE(stored_vote_count, 0))::int AS difference
      FROM actual
      WHERE COALESCE(stored_vote_count, 0) <> actual_votes
      ORDER BY ABS(actual_votes - COALESCE(stored_vote_count, 0)) DESC, actual_votes DESC
      ${listLimit};
    `);

    if (rows.length === 0) {
      console.log('✅ All current PageVersion rows have matching voteCount');
      return;
    }

    console.log(`\nFound ${rows.length} mismatched pages${args.limit ? ` (limited to ${args.limit})` : ''}:`);
    console.table(rows.map(r => ({
      pageId: r.pageId,
      wikidotId: r.wikidotId,
      slug: r.url.substring(r.url.lastIndexOf('/') + 1),
      stored: r.storedVoteCount ?? 0,
      actual: r.actualVotes,
      diff: r.difference,
      up: r.upvotes,
      down: r.downvotes,
      distinctUsers: r.distinctUsers
    })));

    if (args.apply) {
      console.log('\nApplying updates to set PageVersion.voteCount = actual vote counts...');
      // Update in a single SQL using CTEs; respect optional limit
      const updateLimit = args.limit ? Prisma.sql`LIMIT ${args.limit}` : Prisma.sql``;
      const updated = await prisma.$queryRaw<Array<{ pvId: number; pageId: number; newVoteCount: number }>>(Prisma.sql`
        WITH actual AS (
          SELECT pv2.id AS pv_id, COUNT(v.id) AS actual_votes
          FROM "PageVersion" pv2
          LEFT JOIN "Vote" v ON v."pageVersionId" = pv2.id
          WHERE pv2."validTo" IS NULL
          GROUP BY pv2.id
        ),
        targets AS (
          SELECT pv.id AS pv_id, pv."pageId" AS page_id, actual.actual_votes
          FROM "PageVersion" pv
          JOIN actual ON actual.pv_id = pv.id
          WHERE COALESCE(pv."voteCount", 0) <> actual.actual_votes
          ORDER BY ABS(actual.actual_votes - COALESCE(pv."voteCount", 0)) DESC, actual.actual_votes DESC
          ${updateLimit}
        )
        UPDATE "PageVersion" pv
        SET "voteCount" = targets.actual_votes, "updatedAt" = NOW()
        FROM targets
        WHERE pv.id = targets.pv_id
        RETURNING pv.id as "pvId", pv."pageId" as "pageId", pv."voteCount" as "newVoteCount";
      `);
      console.log(`✅ Updated ${updated.length} PageVersion rows.`);

      // Recompute overall summary after update
      const after = await prisma.$queryRaw<Array<{
        total_pages: bigint;
        mismatched_pages: bigint;
      }>>`
        WITH actual AS (
          SELECT 
            pv.id AS page_version_id,
            pv."voteCount" AS stored_vote_count,
            COUNT(v.id) AS actual_votes
          FROM "PageVersion" pv
          LEFT JOIN "Vote" v ON v."pageVersionId" = pv.id
          WHERE pv."validTo" IS NULL
          GROUP BY pv.id, pv."voteCount"
        )
        SELECT 
          COUNT(*) AS total_pages,
          COUNT(*) FILTER (WHERE COALESCE(stored_vote_count, 0) <> actual_votes) AS mismatched_pages
        FROM actual;
      `;
      const a = after[0];
      console.log(`Post-update: mismatched pages = ${Number(a.mismatched_pages)} / ${Number(a.total_pages)}`);
    }

    // Distribution summary across ALL mismatches
    const distribution = await prisma.$queryRaw<Array<{ difference: number; count: bigint }>>`
      WITH actual AS (
        SELECT 
          pv.id AS page_version_id,
          (COUNT(v.id) - COALESCE(pv."voteCount", 0)) AS difference
        FROM "PageVersion" pv
        LEFT JOIN "Vote" v ON v."pageVersionId" = pv.id
        WHERE pv."validTo" IS NULL
        GROUP BY pv.id, pv."voteCount"
      )
      SELECT difference, COUNT(*) AS count
      FROM actual
      WHERE difference <> 0
      GROUP BY difference
      ORDER BY COUNT(*) DESC, ABS(difference) DESC
      LIMIT 20;
    `;
    console.log('\nTop difference distribution (actual - stored) across all mismatches:');
    distribution.forEach(d => {
      console.log(`  ${String(d.difference).padStart(4, ' ')}: ${Number(d.count)}`);
    });

  } catch (error) {
    console.error('Error checking vote count mismatches:', error);
  } finally {
    await disconnectPrisma();
  }
}

void main();


