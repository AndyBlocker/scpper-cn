#!/usr/bin/env node
import { getPrismaClient, disconnectPrisma } from '../src/utils/db-connection.ts';

async function runForPageWid(wid: number) {
  const prisma = getPrismaClient();
  console.log(`\n=== Cross-version duplicate audit for page wid=${wid} ===`);
  // Count duplicates where the same (userId,timestamp,direction) appears on multiple pageVersionIds of the same pageId
  const dups = await prisma.$queryRaw<Array<{
    pageId: number;
    userId: number | null;
    ts: Date;
    direction: number;
    versions: number;
    rows: number;
  }>>`
    WITH votes_with_pid AS (
      SELECT v."pageVersionId", pv."pageId", v."userId", v."timestamp", v.direction
      FROM "Vote" v
      JOIN "PageVersion" pv ON pv.id = v."pageVersionId"
      WHERE pv."wikidotId" = ${wid}
    ), grouped AS (
      SELECT "pageId", "userId", "timestamp" AS ts, direction,
             COUNT(DISTINCT "pageVersionId")::int AS versions,
             COUNT(*)::int AS rows
      FROM votes_with_pid
      GROUP BY "pageId", "userId", "timestamp", direction
      HAVING COUNT(DISTINCT "pageVersionId") > 1
    )
    SELECT * FROM grouped ORDER BY versions DESC, rows DESC LIMIT 50
  `;
  console.log('Top cross-version duplicates (same (pageId,userId,timestamp,direction) across multiple versions):');
  console.table(dups.map(r => ({ pageId: r.pageId, userId: r.userId, ts: r.ts.toISOString(), dir: r.direction, versions: r.versions, rows: r.rows })));
}

async function main() {
  const args = process.argv.slice(2).map(a => parseInt(String(a), 10)).filter(n => Number.isFinite(n));
  if (args.length === 0) {
    console.error('Usage: node --experimental-strip-types backend/scripts/check-cross-version-duplicates.ts <pageWid> [pageWid2 ...]');
    process.exit(1);
  }
  for (const wid of args) {
    await runForPageWid(wid);
  }
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
}).finally(async () => {
  try { await disconnectPrisma(); } catch {}
});


