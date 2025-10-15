#!/usr/bin/env node
import { Prisma, PrismaClient } from '@prisma/client';
import { getPrismaClient, disconnectPrisma } from '../src/utils/db-connection.js';

type Args = { limit: number | null; json: boolean };

function parseArgs(argv: string[] = process.argv.slice(2)): Args {
  let limit: number | null = null;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--limit' || a === '-n') {
      const v = parseInt(argv[i + 1] || '', 10);
      if (Number.isFinite(v) && v > 0) {
        limit = v;
        i++;
      }
    } else if (a === '--json') {
      json = true;
    }
  }
  return { limit, json };
}

// Only boundary mismatches are reported now.

type BoundaryRow = {
  pageId: number;
  url: string;
  currId: number;
  nextId: number;
  currValidTo: Date | null;
  nextValidFrom: Date | null;
  deltaSeconds: number | null; // next_valid_from - curr_valid_to
};

async function main() {
  const args = parseArgs();
  const prisma: PrismaClient = getPrismaClient();

  try {
    const limitSql = args.limit ? Prisma.sql`LIMIT ${args.limit}` : Prisma.sql``;
    // Only output misaligned boundary pairs (no headers/summary)
    const boundaryRows = await prisma.$queryRaw<BoundaryRow[]>(Prisma.sql`
      WITH ordered AS (
        SELECT 
          p."currentUrl" AS url,
          pv."pageId" AS page_id,
          pv.id AS curr_id,
          pv."validTo" AS curr_valid_to,
          LEAD(pv.id) OVER (PARTITION BY pv."pageId" ORDER BY pv."validFrom") AS next_id,
          LEAD(pv."validFrom") OVER (PARTITION BY pv."pageId" ORDER BY pv."validFrom") AS next_valid_from,
          CASE 
            WHEN pv."validTo" IS NOT NULL AND LEAD(pv."validFrom") OVER (PARTITION BY pv."pageId" ORDER BY pv."validFrom") IS NOT NULL
            THEN EXTRACT(EPOCH FROM (LEAD(pv."validFrom") OVER (PARTITION BY pv."pageId" ORDER BY pv."validFrom") - pv."validTo"))::int
            ELSE NULL
          END AS delta_seconds
        FROM "PageVersion" pv
        JOIN "Page" p ON p.id = pv."pageId"
      )
      SELECT 
        page_id AS "pageId",
        url,
        curr_id AS "currId",
        next_id AS "nextId",
        curr_valid_to AS "currValidTo",
        next_valid_from AS "nextValidFrom",
        delta_seconds AS "deltaSeconds"
      FROM ordered
      WHERE curr_valid_to IS NOT NULL
        AND next_valid_from IS NOT NULL
        AND (curr_valid_to <> next_valid_from)
        AND COALESCE(delta_seconds, 0) <> 0
      ORDER BY 
        CASE WHEN delta_seconds IS NULL THEN 1 ELSE 0 END,
        ABS(COALESCE(delta_seconds, 0)) DESC,
        curr_id ASC
      ${limitSql};
    `);

    if (args.json) {
      console.log(JSON.stringify(boundaryRows, null, 2));
    } else if (boundaryRows.length > 0) {
      console.table(boundaryRows.map(r => ({
        pageId: r.pageId,
        slug: r.url.substring(r.url.lastIndexOf('/') + 1),
        currId: r.currId,
        nextId: r.nextId,
        currValidTo: r.currValidTo ? new Date(r.currValidTo).toISOString() : '-',
        nextValidFrom: r.nextValidFrom ? new Date(r.nextValidFrom).toISOString() : '-',
        deltaSec: r.deltaSeconds,
        type: r.deltaSeconds === null ? 'unknown' : (r.deltaSeconds < 0 ? 'overlap' : (r.deltaSeconds > 0 ? 'gap' : 'aligned')),
      })));
    }

  } catch (error) {
    console.error('Error auditing validity windows:', error);
    process.exitCode = 1;
  } finally {
    await disconnectPrisma();
  }
}

void main();
