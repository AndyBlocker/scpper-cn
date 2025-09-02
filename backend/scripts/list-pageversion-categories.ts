#!/usr/bin/env node
import { getPrismaClient, disconnectPrisma } from '../src/utils/db-connection.js';

async function main() {
  const prisma = getPrismaClient();
  try {
    console.log('=== PageVersion.category overview ===');

    // All distinct categories (including null)
    const all = await prisma.$queryRaw<Array<{ category: string | null; count: bigint }>>`
      SELECT category, COUNT(*)::bigint AS count
      FROM "PageVersion"
      GROUP BY category
      ORDER BY count DESC NULLS LAST, category ASC
    `;

    // Distinct categories for current (validTo IS NULL and not deleted)
    const current = await prisma.$queryRaw<Array<{ category: string | null; count: bigint }>>`
      SELECT category, COUNT(*)::bigint AS count
      FROM "PageVersion"
      WHERE "validTo" IS NULL AND NOT "isDeleted"
      GROUP BY category
      ORDER BY count DESC NULLS LAST, category ASC
    `;

    // Sample values including category and a slug
    const samples = await prisma.$queryRaw<Array<{ id: number; pageId: number; category: string | null; url: string | null }>>`
      SELECT pv.id, pv."pageId", pv.category, p."currentUrl" AS url
      FROM "PageVersion" pv
      JOIN "Page" p ON p.id = pv."pageId"
      WHERE pv."validTo" IS NULL AND NOT pv."isDeleted"
      ORDER BY pv.id ASC
      LIMIT 20
    `;

    const toTable = (rows: Array<{ category: string | null; count: bigint }>) =>
      rows.map(r => ({ category: r.category ?? 'NULL', count: Number(r.count) }));

    console.log('\nAll versions (by category):');
    console.table(toTable(all));

    console.log('\nCurrent versions (by category):');
    console.table(toTable(current));

    console.log('\nSample current records:');
    console.table(samples.map(s => ({ id: s.id, pageId: s.pageId, category: s.category ?? 'NULL', slug: s.url ? s.url.substring(s.url.lastIndexOf('/') + 1) : 'N/A' })));

  } catch (err) {
    console.error('Error listing PageVersion categories:', err);
  } finally {
    await disconnectPrisma();
  }
}

void main();


