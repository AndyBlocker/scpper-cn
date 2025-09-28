#!/usr/bin/env node
import { getPrismaClient, disconnectPrisma } from '../src/utils/db-connection.ts';

function ymRange(ym: string) {
  const [y, m] = ym.split('-').map(s => parseInt(s, 10));
  const s = new Date(Date.UTC(y, m - 1, 1)).toISOString();
  const e = new Date(Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 1)).toISOString();
  return { s, e };
}

async function main() {
  const prisma = getPrismaClient();
  const monthArg = process.argv[2] || '2022-05';
  const { s, e } = ymRange(monthArg);

  // Overall classification counts
  const all = await prisma.$queryRaw<Array<{ total: number; user_rows: number; anon_rows: number; null_rows: number; both_rows: number }>>`
    SELECT 
      COUNT(*)::bigint AS total,
      COUNT(*) FILTER (WHERE v."userId" IS NOT NULL AND v."anonKey" IS NULL)::bigint AS user_rows,
      COUNT(*) FILTER (WHERE v."userId" IS NULL AND v."anonKey" IS NOT NULL)::bigint AS anon_rows,
      COUNT(*) FILTER (WHERE v."userId" IS NULL AND v."anonKey" IS NULL)::bigint AS null_rows,
      COUNT(*) FILTER (WHERE v."userId" IS NOT NULL AND v."anonKey" IS NOT NULL)::bigint AS both_rows
    FROM "Vote" v
  `;
  console.log('[ALL TIME] vote classification (rows):', all[0]);

  // Month classification
  const mon = await prisma.$queryRaw<Array<{ total: number; user_rows: number; anon_rows: number; null_rows: number; both_rows: number }>>`
    SELECT 
      COUNT(*)::bigint AS total,
      COUNT(*) FILTER (WHERE v."userId" IS NOT NULL AND v."anonKey" IS NULL)::bigint AS user_rows,
      COUNT(*) FILTER (WHERE v."userId" IS NULL AND v."anonKey" IS NOT NULL)::bigint AS anon_rows,
      COUNT(*) FILTER (WHERE v."userId" IS NULL AND v."anonKey" IS NULL)::bigint AS null_rows,
      COUNT(*) FILTER (WHERE v."userId" IS NOT NULL AND v."anonKey" IS NOT NULL)::bigint AS both_rows
    FROM "Vote" v
    WHERE v."timestamp" >= ${s}::timestamp AND v."timestamp" < ${e}::timestamp
  `;
  console.log(`[MONTH ${monthArg}] vote classification (rows):`, mon[0]);

  // Top pages by null-null votes (month)
  const topNull = await prisma.$queryRaw<Array<{ page_wid: number; title: string | null; rows: number }>>`
    SELECT pv."wikidotId" AS page_wid, pv.title, COUNT(*)::int AS rows
    FROM "Vote" v JOIN "PageVersion" pv ON pv.id = v."pageVersionId"
    WHERE v."timestamp" >= ${s}::timestamp AND v."timestamp" < ${e}::timestamp
      AND v."userId" IS NULL AND v."anonKey" IS NULL
    GROUP BY pv."wikidotId", pv.title
    ORDER BY rows DESC
    LIMIT 20
  `;
  console.log(`\n[MONTH ${monthArg}] top pages by NULL userId & NULL anonKey votes:`);
  console.table(topNull.map(r => ({ pageWid: r.page_wid, title: r.title || 'Untitled', rows: r.rows })));

  // For curiosity: share of null-null in that month
  const totalMonth = Number((mon[0]?.total || 0));
  const nullMonth = Number((mon[0]?.null_rows || 0));
  if (totalMonth > 0) {
    const pct = (nullMonth / totalMonth) * 100;
    console.log(`\n[MONTH ${monthArg}] NULL/NULL share: ${nullMonth} / ${totalMonth} = ${pct.toFixed(2)}%`);
  }
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
}).finally(async () => {
  try { await disconnectPrisma(); } catch {}
});


