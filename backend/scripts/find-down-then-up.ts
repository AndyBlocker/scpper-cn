#!/usr/bin/env node
import { getPrismaClient, disconnectPrisma } from '../src/utils/db-connection.ts';

async function main() {
  const prisma = getPrismaClient();
  const wikidotIdArg = process.argv[2];
  const limitArg = process.argv[3] || '20';
  if (!wikidotIdArg) {
    console.error('Usage: tsx backend/scripts/find-down-then-up.ts <wikidotId> [limit=20]');
    process.exit(1);
  }
  const wikidotId = parseInt(String(wikidotIdArg), 10);
  const limit = parseInt(String(limitArg), 10) || 20;

  const rows = await prisma.$queryRaw<Array<{
    pageId: number;
    page_wid: number;
    title: string | null;
    max_down_date: Date | null;
    max_down_count: number | null;
    max_up_date: Date | null;
    max_up_count: number | null;
    up_after_down_days: number | null;
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
    ),
    daily AS (
      SELECT p."pageId", p.page_wid, p.title, pds.date, pds."votes_up" AS votesUp, pds."votes_down" AS votesDown
      FROM "PageDailyStats" pds
      JOIN user_pages p ON p."pageId" = pds."pageId"
    ),
    agg AS (
      SELECT d."pageId", d.page_wid, d.title,
        (SELECT date FROM daily dd WHERE dd."pageId"=d."pageId" ORDER BY dd.votesDown DESC, dd.date ASC LIMIT 1) AS max_down_date,
        (SELECT dd.votesDown FROM daily dd WHERE dd."pageId"=d."pageId" ORDER BY dd.votesDown DESC, dd.date ASC LIMIT 1) AS max_down_count,
        (SELECT date FROM daily dd WHERE dd."pageId"=d."pageId" ORDER BY dd.votesUp DESC, dd.date ASC LIMIT 1) AS max_up_date,
        (SELECT dd.votesUp FROM daily dd WHERE dd."pageId"=d."pageId" ORDER BY dd.votesUp DESC, dd.date ASC LIMIT 1) AS max_up_count
      FROM daily d
      GROUP BY d."pageId", d.page_wid, d.title
    ),
    filtered AS (
      SELECT *, (max_up_date - max_down_date) AS up_after_down_days
      FROM agg
      WHERE max_down_count IS NOT NULL AND max_up_count IS NOT NULL AND max_up_date > max_down_date
    )
    SELECT "pageId" as "pageId", page_wid, title, max_down_date, max_down_count, max_up_date, max_up_count, up_after_down_days
    FROM filtered
    ORDER BY max_down_count DESC
    LIMIT ${limit}
  `;

  console.log(`Top pages (down spike then up spike) for wikidotId=${wikidotId} (limit=${limit}):`);
  console.table(rows.map(r => ({
    pageWid: r.page_wid,
    title: r.title || 'Untitled',
    downCnt: r.max_down_count, downDate: r.max_down_date?.toISOString().slice(0,10),
    upCnt: r.max_up_count, upDate: r.max_up_date?.toISOString().slice(0,10),
    daysBetween: r.up_after_down_days
  })));

  // If there is a top page, show its daily series for context
  if (rows.length > 0) {
    const top = rows[0];
    const daily = await prisma.$queryRaw<Array<{ date: Date; votesUp: number; votesDown: number }>>`
      SELECT date, pds."votes_up" AS "votesUp", pds."votes_down" AS "votesDown"
      FROM "PageDailyStats" pds
      WHERE pds."pageId" = ${top.pageId}
      ORDER BY date
    `;
    console.log(`\nDaily votes for top page ${top.page_wid} (${top.title || 'Untitled'}):`);
    console.table(daily.map(d => ({ date: d.date.toISOString().slice(0,10), up: d.votesUp, down: d.votesDown })));
  }
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
}).finally(async () => {
  try { await disconnectPrisma(); } catch {}
});


