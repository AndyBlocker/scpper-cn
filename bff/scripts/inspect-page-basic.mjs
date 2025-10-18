#!/usr/bin/env node
import 'dotenv/config';
import { Pool } from 'pg';

const wikidotId = Number(process.argv[2] || '0');
if (!Number.isFinite(wikidotId) || wikidotId <= 0) {
  console.error('Usage: node scripts/inspect-page-basic.mjs <wikidotId>');
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL || process.env.PG_DATABASE_URL });

async function main() {
  const pageRes = await pool.query(
    'SELECT id, "wikidotId", "currentUrl", "isDeleted", "firstPublishedAt", "createdAt", "updatedAt" FROM "Page" WHERE "wikidotId" = $1 LIMIT 1',
    [wikidotId]
  );
  if (pageRes.rowCount === 0) {
    console.log('No Page found for wikidotId', wikidotId);
    return;
  }
  const page = pageRes.rows[0];
  console.log('Page row:');
  console.log(page);

  const pvRes = await pool.query(
    `SELECT pv.id, pv.title, pv."alternateTitle", pv.category, pv.tags, pv.rating, pv."voteCount", pv."commentCount", pv."revisionCount",
            pv."validFrom", pv."validTo", pv."isDeleted", pv."createdAt", pv."updatedAt"
       FROM "PageVersion" pv
       WHERE pv."pageId" = $1
       ORDER BY pv."validTo" IS NULL DESC, pv."validFrom" DESC NULLS LAST, pv.id DESC
       LIMIT 2`,
    [page.id]
  );

  console.log('\nTop PageVersion rows (current first):');
  for (const row of pvRes.rows) {
    console.log(row);
  }
}

main().finally(() => pool.end());

