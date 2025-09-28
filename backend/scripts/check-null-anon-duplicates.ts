#!/usr/bin/env node
import { getPrismaClient, disconnectPrisma } from '../src/utils/db-connection.ts';

function toRange(monthOrRange?: string): { start?: string; end?: string } {
  if (!monthOrRange) return {};
  if (monthOrRange.includes('..')) {
    const [a, b] = monthOrRange.split('..');
    return { start: new Date(a).toISOString(), end: new Date(b).toISOString() };
  }
  const parts = monthOrRange.split('-');
  if (parts.length === 2) {
    const [y, m] = parts.map(s => parseInt(s, 10));
    const start = new Date(Date.UTC(y, m - 1, 1));
    const end = new Date(Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 1));
    return { start: start.toISOString(), end: end.toISOString() };
  }
  const d = new Date(monthOrRange);
  return { start: d.toISOString() };
}

async function main() {
  const prisma = getPrismaClient();
  const pages = process.argv.slice(2).filter(a => /^\d+/.test(a));
  const rangeArg = process.argv.find(a => a.includes('-')); // crude
  const { start, end } = toRange(rangeArg);
  if (pages.length === 0) {
    console.error('Usage: node --experimental-strip-types backend/scripts/check-null-anon-duplicates.ts <pageWid> [pageWid2 ...] [YYYY-MM or YYYY-MM-DD..YYYY-MM-DD]');
    process.exit(1);
  }
  for (const widStr of pages) {
    const wid = parseInt(widStr, 10);
    console.log(`\n=== Page ${wid} (range ${start || 'ANY'}..${end || 'ANY'}) ===`);
    const baseWhere = `pv."wikidotId" = ${wid} ${start ? `AND v."timestamp" >= '${start}'` : ''} ${end ? `AND v."timestamp" < '${end}'` : ''}`;
    // 1) Count total anon rows without userId and anonKey
    const [tot] = await prisma.$queryRawUnsafe<Array<{ rows: number }>>(`
      SELECT COUNT(*)::int AS rows
      FROM "Vote" v JOIN "PageVersion" pv ON pv.id = v."pageVersionId"
      WHERE ${baseWhere} AND v."userId" IS NULL AND v."anonKey" IS NULL
    `);
    console.log(`Anon rows with NULL userId & NULL anonKey: ${tot?.rows || 0}`);

    // 2) Duplicate groups on (timestamp, direction) among null-anon rows
    const dups = await prisma.$queryRawUnsafe<Array<{ ts: Date; direction: number; cnt: number }>>(`
      SELECT v."timestamp" AS ts, v.direction::int AS direction, COUNT(*)::int AS cnt
      FROM "Vote" v JOIN "PageVersion" pv ON pv.id = v."pageVersionId"
      WHERE ${baseWhere} AND v."userId" IS NULL AND v."anonKey" IS NULL
      GROUP BY v."timestamp", v.direction
      HAVING COUNT(*) > 1
      ORDER BY cnt DESC
      LIMIT 20
    `);
    console.log('Top duplicate groups among NULL-anon rows (same (timestamp,direction)):\n');
    console.table(dups.map(d => ({ timestamp: d.ts.toISOString(), direction: d.direction, cnt: d.cnt })));

    // 3) Compare to users with multiple rows on same (timestamp,direction)
    const userDups = await prisma.$queryRawUnsafe<Array<{ userId: number; ts: Date; direction: number; cnt: number }>>(`
      SELECT v."userId"::int AS "userId", v."timestamp" AS ts, v.direction::int AS direction, COUNT(*)::int AS cnt
      FROM "Vote" v JOIN "PageVersion" pv ON pv.id = v."pageVersionId"
      WHERE ${baseWhere} AND v."userId" IS NOT NULL
      GROUP BY v."userId", v."timestamp", v.direction
      HAVING COUNT(*) > 1
      ORDER BY cnt DESC
      LIMIT 20
    `);
    console.log('Per-user exact-duplicate groups (same (timestamp,direction)):\n');
    console.table(userDups.map(d => ({ userId: d.userId, timestamp: d.ts.toISOString(), direction: d.direction, cnt: d.cnt })));
  }
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
}).finally(async () => {
  try { await disconnectPrisma(); } catch {}
});


