#!/usr/bin/env node
import { getPrismaClient, disconnectPrisma } from '../src/utils/db-connection.ts';

function toRange(arg?: string): { start?: string; end?: string } {
  if (!arg) return {};
  // Accept YYYY-MM or YYYY-MM-DD..YYYY-MM-DD
  if (arg.includes('..')) {
    const [a, b] = arg.split('..');
    return { start: new Date(a).toISOString(), end: new Date(b).toISOString() };
  }
  const parts = arg.split('-');
  if (parts.length === 2) {
    const [y, m] = parts.map(s => parseInt(s, 10));
    const start = new Date(Date.UTC(y, m - 1, 1));
    const end = new Date(Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 1));
    return { start: start.toISOString(), end: end.toISOString() };
  }
  const d = new Date(arg);
  return { start: d.toISOString() };
}

async function main() {
  const prisma = getPrismaClient();
  const rangeArg = process.argv[2];
  const { start, end } = toRange(rangeArg);
  console.log(`[Scan spikes] range start=${start || 'ANY'} end=${end || 'ANY'}`);

  const baseWhere = `WHERE 1=1 ${start ? `AND v."timestamp" >= '${start}'` : ''} ${end ? `AND v."timestamp" < '${end}'` : ''}`;

  const spikes = await prisma.$queryRawUnsafe<Array<{ minute: Date; cnt: number }>>(`
    SELECT date_trunc('minute', v."timestamp") AS minute, COUNT(*)::int AS cnt
    FROM "Vote" v
    ${baseWhere}
    GROUP BY date_trunc('minute', v."timestamp")
    ORDER BY cnt DESC
    LIMIT 20
  `);
  console.log('\nTop 20 minute spikes:');
  console.table(spikes.map(s => ({ minute: s.minute.toISOString(), cnt: s.cnt })));

  if (spikes.length > 0) {
    // For the worst minute, show top pages contributing
    const worst = spikes[0].minute.toISOString();
    const details = await prisma.$queryRaw<Array<{ page_wid: number; title: string | null; cnt: number }>>`
      SELECT pv."wikidotId" AS page_wid, pv.title, COUNT(*)::int AS cnt
      FROM "Vote" v
      JOIN "PageVersion" pv ON pv.id = v."pageVersionId"
      WHERE date_trunc('minute', v."timestamp") = ${worst}::timestamp
      GROUP BY pv."wikidotId", pv.title
      ORDER BY cnt DESC
      LIMIT 20
    `;
    console.log(`\nWorst minute breakdown (${worst}):`);
    console.table(details.map(d => ({ pageWid: d.page_wid, title: d.title || 'Untitled', cnt: d.cnt })));
  }
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
}).finally(async () => {
  try { await disconnectPrisma(); } catch {}
});


