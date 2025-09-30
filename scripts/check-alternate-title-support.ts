#!/usr/bin/env ts-node
import { config as loadEnv } from 'dotenv';
import { Pool } from 'pg';

loadEnv();

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('❌ DATABASE_URL is not set. Source the environment used by the BFF first.');
    process.exit(1);
  }

  const pool = new Pool({ connectionString });

  try {
    const columnCheck = await pool.query(
      `SELECT EXISTS (
         SELECT 1
         FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'PageVersion'
           AND column_name = 'alternateTitle'
       ) AS has_column;`
    );

    const hasColumn: boolean = columnCheck.rows[0]?.has_column ?? false;
    console.log(`🔍 PageVersion.alternateTitle present: ${hasColumn ? 'yes' : 'no'}`);

    if (!hasColumn) {
      console.log('\n⚠️  Missing column detected. Any search touching "alternateTitle" will throw 42703.');
      console.log('👉 Run the following SQL against the BFF database to fix it:\n');
      console.log('  ALTER TABLE "PageVersion"\n    ADD COLUMN IF NOT EXISTS "alternateTitle" TEXT;');
      console.log('\n  CREATE INDEX IF NOT EXISTS idx_pv_alternate_title_pgroonga\n    ON "PageVersion" USING pgroonga ("alternateTitle");\n');
    } else {
      const countResult = await pool.query(
        'SELECT COUNT(*)::bigint AS total, COUNT("alternateTitle")::bigint AS non_null FROM "PageVersion" WHERE "validTo" IS NULL;'
      );
      const { total, non_null } = countResult.rows[0];
      console.log(`📄 Current PageVersion rows: ${total}, with alternateTitle populated: ${non_null}`);
    }

    // Try running a minimal search-style query to surface runtime errors explicitly.
    try {
      const sampleQuery = `
        SELECT pv.id, pv."alternateTitle"
        FROM "PageVersion" pv
        WHERE pv."validTo" IS NULL
        ORDER BY pv.id DESC
        LIMIT 3;
      `;
      const sample = await pool.query(sampleQuery);
      console.log(`✅ Sample query referencing alternateTitle succeeded (rows: ${sample.rowCount}).`);
    } catch (err: any) {
      console.error('\n❌ Sample query failed when referencing "alternateTitle".');
      console.error(`   ${err?.message ?? err}`);
      console.log('\nSuggested fix: ensure the column exists using the SQL above.');
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Unexpected failure while checking alternateTitle support:', err);
  process.exit(1);
});

