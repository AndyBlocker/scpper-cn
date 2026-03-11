import { Prisma } from '@prisma/client';
import { getPrismaClient } from '../utils/db-connection.js';

const prisma = getPrismaClient();

const FIX_EXPR = Prisma.sql`(("as_of_ts" + INTERVAL '8 hour')::date - 1)`;

async function main() {
  const apply = process.argv.includes('--apply');

  const [summaryRows, sampleRows] = await Promise.all([
    prisma.$queryRaw<Array<{
      affected_count: bigint;
      min_as_of_ts: Date | null;
      max_as_of_ts: Date | null;
    }>>(Prisma.sql`
      SELECT
        COUNT(*)::bigint AS affected_count,
        MIN("as_of_ts") AS min_as_of_ts,
        MAX("as_of_ts") AS max_as_of_ts
      FROM "CategoryIndexTick"
      WHERE "vote_cutoff_date" <> ${FIX_EXPR}
    `),
    prisma.$queryRaw<Array<{
      category: string;
      as_of_ts: Date;
      stored_vote_cutoff_date: string;
      expected_vote_cutoff_date: string;
    }>>(Prisma.sql`
      SELECT
        category,
        "as_of_ts",
        "vote_cutoff_date"::text AS stored_vote_cutoff_date,
        ${FIX_EXPR}::text AS expected_vote_cutoff_date
      FROM "CategoryIndexTick"
      WHERE "vote_cutoff_date" <> ${FIX_EXPR}
      ORDER BY "as_of_ts" DESC
      LIMIT 12
    `)
  ]);

  const summary = summaryRows[0];
  const affectedCount = Number(summary?.affected_count ?? 0n);

  console.log(JSON.stringify({
    apply,
    affectedCount,
    minAsOfTs: summary?.min_as_of_ts?.toISOString() ?? null,
    maxAsOfTs: summary?.max_as_of_ts?.toISOString() ?? null,
    sampleRows: sampleRows.map((row) => ({
      category: row.category,
      asOfTs: row.as_of_ts.toISOString(),
      storedVoteCutoffDate: row.stored_vote_cutoff_date,
      expectedVoteCutoffDate: row.expected_vote_cutoff_date
    }))
  }, null, 2));

  if (!apply || affectedCount === 0) {
    return;
  }

  const updatedCount = await prisma.$executeRaw(Prisma.sql`
    UPDATE "CategoryIndexTick"
    SET "vote_cutoff_date" = ${FIX_EXPR}
    WHERE "vote_cutoff_date" <> ${FIX_EXPR}
  `);

  console.log(JSON.stringify({
    updatedCount
  }, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
