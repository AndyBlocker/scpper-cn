#!/usr/bin/env node
import { getPrismaClient, disconnectPrisma } from '../src/utils/db-connection.ts';

async function main() {
  const prisma = getPrismaClient();
  try {
    console.log('=== Page → PageVersion distribution ===');

    // Count pages with exactly 1 version
    const single = await prisma.$queryRaw<Array<{ count: bigint }>>`
      WITH pv_per_page AS (
        SELECT pv."pageId", COUNT(*) AS versions
        FROM "PageVersion" pv
        GROUP BY pv."pageId"
      )
      SELECT COUNT(*)::bigint AS count
      FROM pv_per_page
      WHERE versions = 1;
    `;
    console.log(`Pages with exactly 1 version: ${Number(single[0]?.count ?? 0)}`);

    // Overall distribution (top 15 by versions number)
    const dist = await prisma.$queryRaw<Array<{ versions: number; pages: bigint }>>`
      WITH pv_per_page AS (
        SELECT pv."pageId", COUNT(*)::int AS versions
        FROM "PageVersion" pv
        GROUP BY pv."pageId"
      )
      SELECT versions, COUNT(*)::bigint AS pages
      FROM pv_per_page
      GROUP BY versions
      ORDER BY versions ASC
      LIMIT 15;
    `;
    console.log('\nDistribution (versions → pages) [first 15]:');
    console.table(dist.map(r => ({ versions: r.versions, pages: Number(r.pages) })));

    // Bucket for higher versions (e.g., >15)
    const high = await prisma.$queryRaw<Array<{ pages: bigint; max_versions: number }>>`
      WITH pv_per_page AS (
        SELECT pv."pageId", COUNT(*)::int AS versions
        FROM "PageVersion" pv
        GROUP BY pv."pageId"
      )
      SELECT COUNT(*)::bigint AS pages, MAX(versions)::int AS max_versions
      FROM pv_per_page
      WHERE versions > 15;
    `;
    if (high.length) {
      console.log(`\nPages with >15 versions: ${Number(high[0].pages)} (max versions on a single page: ${high[0].max_versions})`);
    }

    // Sample pages that have exactly 1 version
    const samples = await prisma.$queryRaw<Array<{ pageId: number; wikidotId: number; url: string; pvId: number; title: string | null }>>`
      WITH pv_per_page AS (
        SELECT pv."pageId", COUNT(*)::int AS versions
        FROM "PageVersion" pv
        GROUP BY pv."pageId"
      )
      SELECT p.id AS "pageId", p."wikidotId", p."currentUrl" AS url, pv.id AS "pvId", pv.title
      FROM pv_per_page s
      JOIN "Page" p ON p.id = s."pageId"
      JOIN "PageVersion" pv ON pv."pageId" = p.id
      WHERE s.versions = 1
      ORDER BY p.id ASC
      LIMIT 10;
    `;
    console.log('\nSample pages with exactly 1 version:');
    console.table(samples.map(s => ({ pageId: s.pageId, wid: s.wikidotId, slug: s.url.substring(s.url.lastIndexOf('/') + 1), pvId: s.pvId, title: s.title })));

  } catch (err) {
    console.error('Error computing distribution:', err);
  } finally {
    await disconnectPrisma();
  }
}

void main();


