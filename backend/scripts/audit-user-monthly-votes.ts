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
  const wikidotIdArg = process.argv[2];
  const monthArg = process.argv[3]; // YYYY-MM
  const limitArg = process.argv[4] || '30';
  if (!wikidotIdArg || !monthArg) {
    console.error('Usage: node --experimental-strip-types backend/scripts/audit-user-monthly-votes.ts <wikidotId> <YYYY-MM> [limit=30]');
    process.exit(1);
  }
  const wikidotId = parseInt(String(wikidotIdArg), 10);
  const limit = parseInt(String(limitArg), 10) || 30;
  const { start, end } = toMonthRange(monthArg);

  const rows = await prisma.$queryRaw<Array<{
    pageId: number;
    page_wid: number;
    title: string | null;
    up_month: number;
    down_month: number;
    up_total: number;
    down_total: number;
  }>>`
    WITH u AS (
      SELECT id FROM "User" WHERE "wikidotId" = ${wikidotId}
    ),
    user_pages AS (
      SELECT DISTINCT pv."pageId", pv."wikidotId" AS page_wid, pv.title
      FROM "Attribution" a
      JOIN "PageVersion" pv ON pv.id = a."pageVerId"
      JOIN u ON a."userId" = u.id
      WHERE pv."validTo" IS NULL
    )
    SELECT p."pageId" as "pageId", p.page_wid, p.title,
      COALESCE(SUM(CASE WHEN pds.date >= ${start}::date AND pds.date < ${end}::date THEN pds."votes_up" ELSE 0 END), 0)::int AS up_month,
      COALESCE(SUM(CASE WHEN pds.date >= ${start}::date AND pds.date < ${end}::date THEN pds."votes_down" ELSE 0 END), 0)::int AS down_month,
      COALESCE(SUM(pds."votes_up"), 0)::int AS up_total,
      COALESCE(SUM(pds."votes_down"), 0)::int AS down_total
    FROM user_pages p
    LEFT JOIN "PageDailyStats" pds ON pds."pageId" = p."pageId"
    GROUP BY p."pageId", p.page_wid, p.title
    ORDER BY up_month DESC, down_month DESC
    LIMIT ${limit}
  `;

  console.log(`Monthly votes per page for wikidotId=${wikidotId} month=${monthArg} (top ${limit} by up_month):`);
  console.table(rows.map(r => ({
    pageWid: r.page_wid,
    title: r.title || 'Untitled',
    up_month: r.up_month, down_month: r.down_month,
    up_total: r.up_total, down_total: r.down_total
  })));

  const sumPdsUp = rows.reduce((s, r) => s + (r.up_month || 0), 0);
  const sumPdsDown = rows.reduce((s, r) => s + (r.down_month || 0), 0);
  console.log(`\n[PageDailyStats] month sum: up=${sumPdsUp}, down=${sumPdsDown}`);

  // Cross-check using Vote table directly for the same month
  const vrows = await prisma.$queryRaw<Array<{
    page_wid: number;
    title: string | null;
    up_month: number;
    down_month: number;
  }>>`
    WITH u AS (
      SELECT id FROM "User" WHERE "wikidotId" = ${wikidotId}
    ),
    user_pages AS (
      SELECT DISTINCT pv."wikidotId" AS page_wid, pv.title
      FROM "Attribution" a
      JOIN "PageVersion" pv ON pv.id = a."pageVerId"
      JOIN u ON a."userId" = u.id
      WHERE pv."validTo" IS NULL
    )
    SELECT pv."wikidotId" AS page_wid, pv.title,
      COALESCE(SUM(CASE WHEN v.timestamp >= ${start}::timestamp AND v.timestamp < ${end}::timestamp AND v.direction > 0 THEN v.direction ELSE 0 END), 0)::int AS up_month,
      COALESCE(SUM(CASE WHEN v.timestamp >= ${start}::timestamp AND v.timestamp < ${end}::timestamp AND v.direction < 0 THEN -v.direction ELSE 0 END), 0)::int AS down_month
    FROM "Vote" v
    JOIN "PageVersion" pv ON pv.id = v."pageVersionId"
    WHERE pv."wikidotId" IN (SELECT page_wid FROM user_pages)
    GROUP BY pv."wikidotId", pv.title
    ORDER BY up_month DESC, down_month DESC
    LIMIT ${limit}
  `;
  console.log(`\n[Cross-check] Vote table monthly (wikidotId=${wikidotId} ${monthArg}):`);
  console.table(vrows.map(r => ({ pageWid: r.page_wid, title: r.title || 'Untitled', up_month: r.up_month, down_month: r.down_month })));
  const sumVUp = vrows.reduce((s, r) => s + (r.up_month || 0), 0);
  const sumVDown = vrows.reduce((s, r) => s + (r.down_month || 0), 0);
  console.log(`[Vote] month sum: up=${sumVUp}, down=${sumVDown}`);

  // If SCP-CN-963-J is among pages, print its lifetime totals explicitly if present
  const target = rows.find(r => (r.title || '').includes('SCP-CN-963-J'));
  if (!target) {
    // Try resolve by known wid if present historically
    // 53188006 from rating-history hint
    const wid = 53188006;
    const pageRow = await prisma.$queryRaw<Array<{ up_total: number; down_total: number }>>`
      SELECT COALESCE(SUM(pds."votes_up"),0)::int AS up_total,
             COALESCE(SUM(pds."votes_down"),0)::int AS down_total
      FROM "PageDailyStats" pds
      JOIN "PageVersion" pv ON pv."pageId" = pds."pageId"
      WHERE pv."wikidotId" = ${wid}
    `;
    if (pageRow.length > 0) {
      console.log(`\nTotals for SCP-CN-963-J (wikidotId=53188006): up=${pageRow[0].up_total}, down=${pageRow[0].down_total}`);
    }
  }
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
}).finally(async () => {
  try { await disconnectPrisma(); } catch {}
});


