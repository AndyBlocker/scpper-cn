#!/usr/bin/env node
import { getPrismaClient, disconnectPrisma } from '../src/utils/db-connection.ts';

async function auditPage(wid: number) {
  const prisma = getPrismaClient();
  console.log(`\n=== Audit duplicates for page wikidotId=${wid} ===`);

  const totals = await prisma.$queryRaw<Array<{ up: number; down: number; total: number }>>`
    SELECT 
      COALESCE(SUM(CASE WHEN v.direction > 0 THEN v.direction ELSE 0 END),0)::int AS up,
      COALESCE(SUM(CASE WHEN v.direction < 0 THEN -v.direction ELSE 0 END),0)::int AS down,
      COUNT(*)::int AS total
    FROM "Vote" v
    JOIN "PageVersion" pv ON pv.id = v."pageVersionId"
    WHERE pv."wikidotId" = ${wid}
  `;
  console.log('Totals (Vote table):', totals[0]);

  // Per-user duplicate counts on this page
  const perUser = await prisma.$queryRaw<Array<{ userId: number; cnt: number; ups: number; downs: number; first: Date | null; last: Date | null }>>`
    SELECT v."userId"::int AS "userId",
           COUNT(*)::int AS cnt,
           SUM(CASE WHEN v.direction > 0 THEN 1 ELSE 0 END)::int AS ups,
           SUM(CASE WHEN v.direction < 0 THEN 1 ELSE 0 END)::int AS downs,
           MIN(v."timestamp") AS first,
           MAX(v."timestamp") AS last
    FROM "Vote" v
    JOIN "PageVersion" pv ON pv.id = v."pageVersionId"
    WHERE pv."wikidotId" = ${wid} AND v."userId" IS NOT NULL
    GROUP BY v."userId"
    HAVING COUNT(*) > 1
    ORDER BY cnt DESC, "userId" ASC
    LIMIT 50
  `;
  console.log('\nTop per-user multiple votes (cnt>1):');
  console.table(perUser.map(r => ({ userId: r.userId, cnt: r.cnt, ups: r.ups, downs: r.downs, first: r.first?.toISOString(), last: r.last?.toISOString() })));

  // Anonymous (anonKey) duplicate counts on this page
  const perAnon = await prisma.$queryRaw<Array<{ anonKey: string; cnt: number; ups: number; downs: number; first: Date | null; last: Date | null }>>`
    SELECT v."anonKey" AS "anonKey",
           COUNT(*)::int AS cnt,
           SUM(CASE WHEN v.direction > 0 THEN 1 ELSE 0 END)::int AS ups,
           SUM(CASE WHEN v.direction < 0 THEN 1 ELSE 0 END)::int AS downs,
           MIN(v."timestamp") AS first,
           MAX(v."timestamp") AS last
    FROM "Vote" v
    JOIN "PageVersion" pv ON pv.id = v."pageVersionId"
    WHERE pv."wikidotId" = ${wid} AND v."anonKey" IS NOT NULL
    GROUP BY v."anonKey"
    HAVING COUNT(*) > 1
    ORDER BY cnt DESC
    LIMIT 50
  `;
  console.log('\nTop anonymous multiple votes (cnt>1):');
  console.table(perAnon.map(r => ({ anonKey: r.anonKey, cnt: r.cnt, ups: r.ups, downs: r.downs, first: r.first?.toISOString(), last: r.last?.toISOString() })));

  // Per-minute spikes for same user (possible import duplicates within same minute)
  const spikes = await prisma.$queryRaw<Array<{ userId: number; minute: Date; cnt: number; ups: number; downs: number }>>`
    SELECT v."userId"::int AS "userId",
           date_trunc('minute', v."timestamp") AS minute,
           COUNT(*)::int AS cnt,
           SUM(CASE WHEN v.direction > 0 THEN 1 ELSE 0 END)::int AS ups,
           SUM(CASE WHEN v.direction < 0 THEN 1 ELSE 0 END)::int AS downs
    FROM "Vote" v
    JOIN "PageVersion" pv ON pv.id = v."pageVersionId"
    WHERE pv."wikidotId" = ${wid} AND v."userId" IS NOT NULL
    GROUP BY v."userId", date_trunc('minute', v."timestamp")
    HAVING COUNT(*) > 1
    ORDER BY cnt DESC, minute DESC
    LIMIT 50
  `;
  console.log('\nSame-minute multi-votes by the same user (cnt>1):');
  console.table(spikes.map(r => ({ userId: r.userId, minute: r.minute.toISOString(), cnt: r.cnt, ups: r.ups, downs: r.downs })));
}

async function main() {
  const args = process.argv.slice(2).map(a => parseInt(String(a), 10)).filter(n => Number.isFinite(n));
  if (args.length === 0) {
    console.error('Usage: node --experimental-strip-types backend/scripts/audit-duplicate-votes.ts <wikidotId> [wikidotId2 ...]');
    process.exit(1);
  }
  for (const wid of args) {
    await auditPage(wid);
  }
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
}).finally(async () => {
  try { await disconnectPrisma(); } catch {}
});


