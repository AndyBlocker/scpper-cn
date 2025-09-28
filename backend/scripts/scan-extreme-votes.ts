#!/usr/bin/env node
import { getPrismaClient, disconnectPrisma } from '../src/utils/db-connection.ts';

function toMonthRange(ym: string): { start: string; end: string } {
  const [y, m] = ym.split('-').map(s => parseInt(s, 10));
  if (!y || !m || m < 1 || m > 12) throw new Error('Month must be YYYY-MM');
  const start = new Date(Date.UTC(y, m - 1, 1));
  const end = new Date(Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 1));
  const toIso = (d: Date) => d.toISOString().slice(0, 10);
  return { start: toIso(start), end: toIso(end) };
}

async function main() {
  const prisma = getPrismaClient();
  const thresholdArg = process.argv[2] || '5000';
  const monthArg = process.argv[3]; // optional YYYY-MM
  const threshold = parseInt(String(thresholdArg), 10) || 5000;

  // Lifetime extremes per page
  const life = await prisma.$queryRaw<Array<{ page_wid: number; title: string | null; up: number; down: number }>>`
    SELECT pv."wikidotId" AS page_wid, pv.title,
      COALESCE(SUM(CASE WHEN v.direction > 0 THEN v.direction ELSE 0 END),0)::int AS up,
      COALESCE(SUM(CASE WHEN v.direction < 0 THEN -v.direction ELSE 0 END),0)::int AS down
    FROM "Vote" v
    JOIN "PageVersion" pv ON pv.id = v."pageVersionId"
    GROUP BY pv."wikidotId", pv.title
    HAVING COALESCE(SUM(CASE WHEN v.direction > 0 THEN v.direction ELSE 0 END),0) >= ${threshold}
        OR COALESCE(SUM(CASE WHEN v.direction < 0 THEN -v.direction ELSE 0 END),0) >= ${threshold}
    ORDER BY up DESC, down DESC
  `;
  console.log(`[Lifetime extremes >= ${threshold}]`);
  console.table(life.map(r => ({ pageWid: r.page_wid, title: r.title || 'Untitled', up: r.up, down: r.down })));

  if (monthArg) {
    const { start, end } = toMonthRange(monthArg);
    const monthly = await prisma.$queryRaw<Array<{ page_wid: number; title: string | null; up: number; down: number }>>`
      SELECT pv."wikidotId" AS page_wid, pv.title,
        COALESCE(SUM(CASE WHEN v.timestamp >= ${start}::timestamp AND v.timestamp < ${end}::timestamp AND v.direction > 0 THEN v.direction ELSE 0 END),0)::int AS up,
        COALESCE(SUM(CASE WHEN v.timestamp >= ${start}::timestamp AND v.timestamp < ${end}::timestamp AND v.direction < 0 THEN -v.direction ELSE 0 END),0)::int AS down
      FROM "Vote" v
      JOIN "PageVersion" pv ON pv.id = v."pageVersionId"
      GROUP BY pv."wikidotId", pv.title
      HAVING COALESCE(SUM(CASE WHEN v.timestamp >= ${start}::timestamp AND v.timestamp < ${end}::timestamp AND v.direction > 0 THEN v.direction ELSE 0 END),0) >= ${threshold}
          OR COALESCE(SUM(CASE WHEN v.timestamp >= ${start}::timestamp AND v.timestamp < ${end}::timestamp AND v.direction < 0 THEN -v.direction ELSE 0 END),0) >= ${threshold}
      ORDER BY up DESC, down DESC
    `;
    console.log(`\n[Monthly extremes >= ${threshold} for ${monthArg}]`);
    console.table(monthly.map(r => ({ pageWid: r.page_wid, title: r.title || 'Untitled', up: r.up, down: r.down })));
  }
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
}).finally(async () => {
  try { await disconnectPrisma(); } catch {}
});


