#!/usr/bin/env node
import { Prisma } from '@prisma/client';
import { getPrismaClient, disconnectPrisma } from '../src/utils/db-connection.js';

type Args = {
  apply: boolean;
  toleranceSec: number;
  limit: number | null;
  pageId: number | null;
};

function parseArgs(argv: string[] = process.argv.slice(2)): Args {
  let apply = false;
  let toleranceSec = 2; // default: ignore <= 2 seconds
  let limit: number | null = null;
  let pageId: number | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') apply = true;
    else if (a === '--tolerance' || a === '-t') {
      const v = parseInt(argv[i + 1] || '', 10);
      if (Number.isFinite(v) && v >= 0) { toleranceSec = v; i++; }
    } else if (a === '--limit' || a === '-n') {
      const v = parseInt(argv[i + 1] || '', 10);
      if (Number.isFinite(v) && v > 0) { limit = v; i++; }
    } else if (a === '--page-id') {
      const v = parseInt(argv[i + 1] || '', 10);
      if (Number.isFinite(v) && v > 0) { pageId = v; i++; }
    }
  }
  return { apply, toleranceSec, limit, pageId };
}

type PairRow = {
  pageId: number;
  currId: number;
  nextId: number;
  currValidTo: Date | null;
  nextValidFrom: Date | null;
  deltaSeconds: number | null;
};

async function main() {
  const args = parseArgs();
  const prisma = getPrismaClient();
  try {
    const pageFilter = args.pageId ? Prisma.sql`WHERE pv."pageId" = ${args.pageId}` : Prisma.sql``;
    const limitSql = args.limit ? Prisma.sql`LIMIT ${args.limit}` : Prisma.sql``;

    // Find boundary pairs with |delta| > tolerance
    const pairs = await prisma.$queryRaw<PairRow[]>(Prisma.sql`
      WITH ordered AS (
        SELECT 
          pv."pageId" AS page_id,
          pv.id AS curr_id,
          pv."validTo" AS curr_valid_to,
          LEAD(pv.id) OVER (PARTITION BY pv."pageId" ORDER BY pv."validFrom", pv.id) AS next_id,
          LEAD(pv."validFrom") OVER (PARTITION BY pv."pageId" ORDER BY pv."validFrom", pv.id) AS next_valid_from,
          CASE 
            WHEN pv."validTo" IS NOT NULL AND LEAD(pv."validFrom") OVER (PARTITION BY pv."pageId" ORDER BY pv."validFrom", pv.id) IS NOT NULL
            THEN EXTRACT(EPOCH FROM (LEAD(pv."validFrom") OVER (PARTITION BY pv."pageId" ORDER BY pv."validFrom", pv.id) - pv."validTo"))::int
            ELSE NULL
          END AS delta_seconds
        FROM "PageVersion" pv
        ${pageFilter}
      )
      SELECT 
        page_id AS "pageId",
        curr_id AS "currId",
        next_id AS "nextId",
        curr_valid_to AS "currValidTo",
        next_valid_from AS "nextValidFrom",
        delta_seconds AS "deltaSeconds"
      FROM ordered
      WHERE curr_valid_to IS NOT NULL
        AND next_valid_from IS NOT NULL
        AND ABS(COALESCE(delta_seconds, 0)) > ${args.toleranceSec}
      ORDER BY ABS(COALESCE(delta_seconds, 0)) DESC, curr_id ASC
      ${limitSql};
    `);

    if (!args.apply) {
      if (pairs.length === 0) return;
      console.log('Dry-run. Boundary mismatches to fix (prev.validTo -> next.validFrom):');
      console.table(pairs.map(p => ({
        pageId: p.pageId,
        currId: p.currId,
        nextId: p.nextId,
        currValidTo: p.currValidTo ? new Date(p.currValidTo).toISOString() : '-',
        nextValidFrom: p.nextValidFrom ? new Date(p.nextValidFrom).toISOString() : '-',
        deltaSec: p.deltaSeconds,
        action: 'set curr.validTo = next.validFrom'
      })));
      console.log(`Total pairs: ${pairs.length}. Re-run with --apply to write changes.`);
      return;
    }

    if (pairs.length === 0) {
      console.log('No boundary mismatches above tolerance. Nothing to update.');
      return;
    }

    // Apply in a single SQL UPDATE using CTE to avoid per-row chatter
    const updates = await prisma.$queryRaw<Array<{ updated: number }>>(Prisma.sql`
      WITH targets AS (
        SELECT curr_id, next_valid_from
        FROM (
          SELECT 
            pv.id AS curr_id,
            LEAD(pv."validFrom") OVER (PARTITION BY pv."pageId" ORDER BY pv."validFrom", pv.id) AS next_valid_from,
            CASE 
              WHEN pv."validTo" IS NOT NULL AND LEAD(pv."validFrom") OVER (PARTITION BY pv."pageId" ORDER BY pv."validFrom", pv.id) IS NOT NULL
              THEN EXTRACT(EPOCH FROM (LEAD(pv."validFrom") OVER (PARTITION BY pv."pageId" ORDER BY pv."validFrom", pv.id) - pv."validTo"))::int
              ELSE NULL
            END AS delta_seconds,
            pv."pageId" AS page_id
          FROM "PageVersion" pv
          ${pageFilter}
        ) o
        WHERE o.next_valid_from IS NOT NULL
          AND ABS(COALESCE(o.delta_seconds, 0)) > ${args.toleranceSec}
      )
      UPDATE "PageVersion" pv
      SET "validTo" = t.next_valid_from, "updatedAt" = NOW()
      FROM targets t
      WHERE pv.id = t.curr_id
      RETURNING 1 AS updated;
    `);

    console.log(`✅ Updated ${updates.length} PageVersion rows (set prev.validTo = next.validFrom).`);

    // Optional safety: ensure no row has validTo < validFrom after update (clamp)
    const clamped = await prisma.$queryRaw<Array<{ fixed: number }>>`
      UPDATE "PageVersion"
      SET "validTo" = "validFrom", "updatedAt" = NOW()
      WHERE "validTo" IS NOT NULL AND "validTo" < "validFrom"
      RETURNING 1 as fixed;
    `;
    if (clamped.length > 0) {
      console.log(`⚠️  Clamped ${clamped.length} rows where validTo < validFrom (set validTo = validFrom).`);
    }

  } catch (err) {
    console.error('Error fixing boundaries:', err);
    process.exitCode = 1;
  } finally {
    await disconnectPrisma();
  }
}

void main();

