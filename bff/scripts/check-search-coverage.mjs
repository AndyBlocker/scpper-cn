#!/usr/bin/env node
/**
 * Diagnose PGroonga search coverage for a given literal.
 * Compares the official search query (using PGroonga) with a raw substring scan
 * so we can spot pages that contain the literal but are missing from search results.
 */
import 'dotenv/config';
import process from 'node:process';
import pg from 'pg';

const { Client } = pg;

function parseArgs() {
  const args = process.argv.slice(2);
  const term = args[0] ?? 'local--files';
  const limitFlagIndex = args.findIndex((arg) => arg === '--limit');
  const limitValue = limitFlagIndex !== -1 ? Number(args[limitFlagIndex + 1]) : undefined;
  const sampleLimit = Number.isFinite(limitValue) && limitValue !== undefined ? Math.max(0, limitValue) : 20;
  return { term, sampleLimit };
}

function getConnectionString() {
  const url = process.env.DATABASE_URL || process.env.PG_DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL or PG_DATABASE_URL must be set');
  }
  return url;
}

const pgroongaCountSql = `
  WITH url_hits AS (
    SELECT pv.id
    FROM "Page" p
    JOIN "PageVersion" pv ON pv."pageId" = p.id AND pv."validTo" IS NULL
    WHERE $1::text IS NOT NULL
      AND p."currentUrl" &@~ pgroonga_query_escape($1)
  ),
  title_hits AS (
    SELECT pv.id
    FROM "PageVersion" pv
    WHERE pv."validTo" IS NULL
      AND pv.title &@~ pgroonga_query_escape($1)
  ),
  alternate_hits AS (
    SELECT pv.id
    FROM "PageVersion" pv
    WHERE pv."validTo" IS NULL
      AND pv."alternateTitle" IS NOT NULL
      AND pv."alternateTitle" &@~ pgroonga_query_escape($1)
  ),
  text_hits AS (
    SELECT pv.id
    FROM "PageVersion" pv
    WHERE pv."validTo" IS NULL
      AND pv."textContent" &@~ pgroonga_query_escape($1)
  ),
  hits AS (
    SELECT id FROM url_hits
    UNION
    SELECT id FROM title_hits
    UNION
    SELECT id FROM alternate_hits
    UNION
    SELECT id FROM text_hits
  )
  SELECT COUNT(*) AS total FROM hits
`;

const substringCountSql = `
  WITH substring_hits AS (
    SELECT DISTINCT pv.id
    FROM "PageVersion" pv
    JOIN "Page" p ON p.id = pv."pageId"
    WHERE pv."validTo" IS NULL
      AND (
        pv.title ILIKE '%' || $1 || '%'
        OR (pv."alternateTitle" IS NOT NULL AND pv."alternateTitle" ILIKE '%' || $1 || '%')
        OR pv."textContent" ILIKE '%' || $1 || '%'
        OR p."currentUrl" ILIKE '%' || $1 || '%'
      )
  )
  SELECT COUNT(*) AS total FROM substring_hits
`;

const missingSampleSql = `
  WITH pgroonga_hits AS (
    SELECT DISTINCT pv.id
    FROM "PageVersion" pv
    JOIN "Page" p ON p.id = pv."pageId"
    WHERE pv."validTo" IS NULL
      AND (
        p."currentUrl" &@~ pgroonga_query_escape($1)
        OR pv.title &@~ pgroonga_query_escape($1)
        OR (pv."alternateTitle" IS NOT NULL AND pv."alternateTitle" &@~ pgroonga_query_escape($1))
        OR pv."textContent" &@~ pgroonga_query_escape($1)
      )
  ),
  substring_hits AS (
    SELECT DISTINCT pv.id
    FROM "PageVersion" pv
    JOIN "Page" p ON p.id = pv."pageId"
    WHERE pv."validTo" IS NULL
      AND (
        pv.title ILIKE '%' || $1 || '%'
        OR (pv."alternateTitle" IS NOT NULL AND pv."alternateTitle" ILIKE '%' || $1 || '%')
        OR pv."textContent" ILIKE '%' || $1 || '%'
        OR p."currentUrl" ILIKE '%' || $1 || '%'
      )
  ),
  missing AS (
    SELECT sh.id
    FROM substring_hits sh
    LEFT JOIN pgroonga_hits ph ON ph.id = sh.id
    WHERE ph.id IS NULL
  )
  SELECT
    pv.id,
    pv."pageId",
    pv.title,
    p."currentUrl" AS url,
    LEFT(pv."textContent", 200) AS preview
  FROM missing m
  JOIN "PageVersion" pv ON pv.id = m.id
  JOIN "Page" p ON p.id = pv."pageId"
  ORDER BY pv."validFrom" DESC
  LIMIT $2::int
`;

async function main() {
  const { term, sampleLimit } = parseArgs();
  const client = new Client({ connectionString: getConnectionString() });
  await client.connect();

  try {
    const [pgResult, substringResult] = await Promise.all([
      client.query(pgroongaCountSql, [term]),
      client.query(substringCountSql, [term])
    ]);

    const pgroongaTotal = Number(pgResult.rows[0]?.total ?? 0);
    const substringTotal = Number(substringResult.rows[0]?.total ?? 0);

    console.log(`Query term: "${term}"`);
    console.log(`PGroonga /search/pages coverage: ${pgroongaTotal}`);
    console.log(`Substring scan coverage:       ${substringTotal}`);

    if (substringTotal <= pgroongaTotal) {
      console.log('\nNo missing pages detected via substring comparison.');
      return;
    }

    const gap = substringTotal - pgroongaTotal;
    console.log(`\nMissing pages (substring hits not returned by PGroonga): ${gap}`);

    if (sampleLimit === 0) {
      console.log('Sample limit is 0, skipping detailed listing.');
      return;
    }

    const sample = await client.query(missingSampleSql, [term, sampleLimit]);
    if (sample.rows.length === 0) {
      console.log('No missing page samples found.');
      return;
    }

    console.log(`\nSample of up to ${sampleLimit} missing page IDs:`);
    sample.rows.forEach((row, idx) => {
      console.log(`\n[${idx + 1}] PageVersion ID: ${row.id}`);
      console.log(`    Page ID: ${row.pageId}`);
      console.log(`    Title: ${row.title}`);
      console.log(`    URL: ${row.url}`);
      console.log(`    Preview: ${row.preview?.replace(/\s+/g, ' ').slice(0, 160)}...`);
    });
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
