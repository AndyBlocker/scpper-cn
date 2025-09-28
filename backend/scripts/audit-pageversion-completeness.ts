#!/usr/bin/env node
import { getPrismaClient, disconnectPrisma } from '../src/utils/db-connection.ts';
import { Prisma } from '@prisma/client';

type Args = { all: boolean };
function parseArgs(argv: string[] = process.argv.slice(2)): Args {
  return { all: argv.includes('--all') };
}

type SummaryRow = {
  totalVersions: bigint;
  versionsWithVotes: bigint;
  versionsWithRevisions: bigint;
  versionsWithBoth: bigint;
  versionsWithNeither: bigint;
  versionsWithVoteMismatch: bigint;
  versionsWithRevisionMismatch: bigint;
};

type ProblemRow = {
  pageVersionId: number;
  pageId: number;
  wikidotId: number | null;
  url: string;
  title: string | null;
  storedVoteCount: number | null;
  actualVoteCount: number;
  storedRevisionCount: number | null;
  actualRevisionCount: number;
  voteDiff: number;
  revDiff: number;
};

async function main() {
  const args = parseArgs();
  const prisma = getPrismaClient();
  try {
    console.log(`=== PageVersion Completeness Audit (${args.all ? 'all versions' : 'current versions'}) ===`);
    const whereClause = args.all ? Prisma.sql`` : Prisma.sql`WHERE pv."validTo" IS NULL`;

    // Summary across all current PageVersions
    const summary = await prisma.$queryRaw<SummaryRow[]>(Prisma.sql`
      WITH counts AS (
        SELECT 
          pv.id AS pv_id,
          COUNT(DISTINCT v.id) AS actual_votes,
          COUNT(DISTINCT r.id) AS actual_revisions,
          pv."voteCount" AS stored_vote_count,
          pv."revisionCount" AS stored_revision_count
        FROM "PageVersion" pv
        LEFT JOIN "Vote" v ON v."pageVersionId" = pv.id
        LEFT JOIN "Revision" r ON r."pageVersionId" = pv.id
        ${whereClause}
        GROUP BY pv.id, pv."voteCount", pv."revisionCount"
      )
      SELECT
        COUNT(*)                               AS "totalVersions",
        COUNT(*) FILTER (WHERE actual_votes > 0)            AS "versionsWithVotes",
        COUNT(*) FILTER (WHERE actual_revisions > 0)        AS "versionsWithRevisions",
        COUNT(*) FILTER (WHERE actual_votes > 0 AND actual_revisions > 0) AS "versionsWithBoth",
        COUNT(*) FILTER (WHERE actual_votes = 0 AND actual_revisions = 0) AS "versionsWithNeither",
        COUNT(*) FILTER (WHERE COALESCE(stored_vote_count, 0) <> actual_votes) AS "versionsWithVoteMismatch",
        COUNT(*) FILTER (WHERE COALESCE(stored_revision_count, 0) <> actual_revisions) AS "versionsWithRevisionMismatch"
      FROM counts;
    `);

    const s = summary[0];
    console.log('Summary:');
    console.log(`  Total current versions: ${Number(s.totalVersions)}`);
    console.log(`  With votes: ${Number(s.versionsWithVotes)}`);
    console.log(`  With revisions: ${Number(s.versionsWithRevisions)}`);
    console.log(`  With both: ${Number(s.versionsWithBoth)}`);
    console.log(`  With neither: ${Number(s.versionsWithNeither)}`);
    console.log(`  Vote count mismatches: ${Number(s.versionsWithVoteMismatch)}`);
    console.log(`  Revision count mismatches: ${Number(s.versionsWithRevisionMismatch)}`);

    // Top mismatches list
    const list = await prisma.$queryRaw<ProblemRow[]>(Prisma.sql`
      WITH counts AS (
        SELECT 
          pv.id AS pv_id,
          pv."pageId" AS page_id,
          pv."wikidotId" AS wikidot_id,
          p."currentUrl" AS url,
          pv.title AS title,
          COUNT(DISTINCT v.id) AS actual_votes,
          COUNT(DISTINCT r.id) AS actual_revisions,
          pv."voteCount" AS stored_vote_count,
          pv."revisionCount" AS stored_revision_count
        FROM "PageVersion" pv
        JOIN "Page" p ON p.id = pv."pageId"
        LEFT JOIN "Vote" v ON v."pageVersionId" = pv.id
        LEFT JOIN "Revision" r ON r."pageVersionId" = pv.id
        ${whereClause}
        GROUP BY pv.id, pv."pageId", pv."wikidotId", p."currentUrl", pv.title, pv."voteCount", pv."revisionCount"
      )
      SELECT 
        pv_id           AS "pageVersionId",
        page_id         AS "pageId",
        wikidot_id      AS "wikidotId",
        url,
        title,
        stored_vote_count AS "storedVoteCount",
        actual_votes::int AS "actualVoteCount",
        stored_revision_count AS "storedRevisionCount",
        actual_revisions::int AS "actualRevisionCount",
        (actual_votes - COALESCE(stored_vote_count, 0))::int AS "voteDiff",
        (actual_revisions - COALESCE(stored_revision_count, 0))::int AS "revDiff"
      FROM counts
      WHERE COALESCE(stored_vote_count, 0) <> actual_votes
         OR COALESCE(stored_revision_count, 0) <> actual_revisions
      ORDER BY GREATEST(ABS(actual_votes - COALESCE(stored_vote_count, 0)), ABS(actual_revisions - COALESCE(stored_revision_count, 0))) DESC,
               actual_votes DESC
      LIMIT 100;
    `);

    if (list.length === 0) {
      console.log('\n✅ All current PageVersions have consistent voteCount and revisionCount with actual data.');
    } else {
      console.log(`\nTop ${list.length} PageVersions with mismatches:`);
      console.table(list.map(r => ({
        pvId: r.pageVersionId,
        wid: r.wikidotId,
        slug: r.url.substring(r.url.lastIndexOf('/') + 1),
        voteStored: r.storedVoteCount ?? 0,
        voteActual: r.actualVoteCount,
        voteDiff: r.voteDiff,
        revStored: r.storedRevisionCount ?? 0,
        revActual: r.actualRevisionCount,
        revDiff: r.revDiff
      })));
    }

    // Coverage by series/category (optional quick insight)
    const byCategory = await prisma.$queryRaw<Array<{ category: string | null; total: bigint; withVotes: bigint; withRevs: bigint; withBoth: bigint }>>(Prisma.sql`
      WITH per_pv AS (
        SELECT 
          pv.category,
          pv.id AS pv_id,
          (COUNT(DISTINCT v.id) > 0) AS has_votes,
          (COUNT(DISTINCT r.id) > 0) AS has_revs
        FROM "PageVersion" pv
        LEFT JOIN "Vote" v ON v."pageVersionId" = pv.id
        LEFT JOIN "Revision" r ON r."pageVersionId" = pv.id
        ${whereClause}
        GROUP BY pv.category, pv.id
      )
      SELECT category,
             COUNT(*)::bigint AS total,
             SUM(CASE WHEN has_votes THEN 1 ELSE 0 END)::bigint AS "withVotes",
             SUM(CASE WHEN has_revs THEN 1 ELSE 0 END)::bigint AS "withRevs",
             SUM(CASE WHEN has_votes AND has_revs THEN 1 ELSE 0 END)::bigint AS "withBoth"
      FROM per_pv
      GROUP BY category
      ORDER BY total DESC
      LIMIT 10;
    `);
    console.log('\nCoverage by category (top 10 by total):');
    console.table(byCategory.map(r => ({
      category: r.category ?? '(null)',
      total: Number(r.total),
      withVotes: Number(r.withVotes),
      withRevs: Number(r.withRevs),
      withBoth: Number(r.withBoth)
    })));

  } catch (error) {
    console.error('Error auditing completeness:', error);
  } finally {
    await disconnectPrisma();
  }
}

void main();


