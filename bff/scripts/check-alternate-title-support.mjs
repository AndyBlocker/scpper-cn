#!/usr/bin/env node
import { config as loadEnv } from 'dotenv';
import pg from 'pg';

loadEnv();

const { Pool } = pg;

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('❌ DATABASE_URL is not set. Source the environment used by the BFF first.');
    process.exit(1);
  }

  const pool = new Pool({ connectionString });

  try {
    const columnCheckSql = `
      SELECT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'PageVersion'
          AND column_name = 'alternateTitle'
      ) AS has_column;
    `;
    const columnCheck = await pool.query(columnCheckSql);
    const hasColumn = columnCheck.rows[0]?.has_column ?? false;

    console.log(`🔍 PageVersion.alternateTitle present: ${hasColumn ? 'yes' : 'no'}`);

    if (!hasColumn) {
      console.log('\n⚠️  Missing column detected. Any search touching "alternateTitle" will throw 42703.');
      console.log('👉 Run the following SQL against the BFF database to fix it:\n');
      console.log('  ALTER TABLE "PageVersion"');
      console.log('    ADD COLUMN IF NOT EXISTS "alternateTitle" TEXT;');
      console.log('\n  CREATE INDEX IF NOT EXISTS idx_pv_alternate_title_pgroonga');
      console.log('    ON "PageVersion" USING pgroonga ("alternateTitle");\n');
      return;
    }

    const statsSql = `
      SELECT COUNT(*)::bigint AS total,
             COUNT("alternateTitle")::bigint AS non_null
      FROM "PageVersion"
      WHERE "validTo" IS NULL;
    `;
    const stats = await pool.query(statsSql);
    const { total, non_null } = stats.rows[0];
    console.log(`📄 Current PageVersion rows: ${total}, with alternateTitle populated: ${non_null}`);

    const sampleSql = `
      SELECT pv.id, pv."alternateTitle"
      FROM "PageVersion" pv
      WHERE pv."validTo" IS NULL
      ORDER BY pv.id DESC
      LIMIT 3;
    `;
    try {
      const sample = await pool.query(sampleSql);
      console.log(`✅ Sample query referencing alternateTitle succeeded (rows: ${sample.rowCount}).`);
    } catch (err) {
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
