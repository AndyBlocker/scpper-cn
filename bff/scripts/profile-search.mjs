#!/usr/bin/env node
import 'dotenv/config';
import pg from 'pg';

const { Client } = pg;

function getConnectionString() {
  const url = process.env.DATABASE_URL || process.env.PG_DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL or PG_DATABASE_URL must be set');
  }
  return url;
}

async function run() {
  const args = process.argv.slice(2);
  const searchTerm = args[0] ?? 'scp';
  const includeCount = args.includes('--count');
  const orderBy = 'relevance';
  const limit = 10;
  const offset = 0;
  const emptyArray = null;
  const ratingMin = null;
  const ratingMax = null;

  const pageSql = `
    EXPLAIN (ANALYZE, VERBOSE, BUFFERS)
    WITH url_hits AS (
      SELECT id
      FROM "Page"
      WHERE $1::text IS NOT NULL
        AND "currentUrl" &@~ $1
    ),
    base AS (
      SELECT 
        pv.id,
        COALESCE(pv."wikidotId", p."wikidotId") AS "wikidotId",
        pv."pageId",
        pv.title,
        pv."alternateTitle",
        p."currentUrl" AS url,
        p."firstPublishedAt" AS "firstRevisionAt",
        pv.rating,
        pv."voteCount",
        pv."revisionCount",
        pv."commentCount",
        pv.tags,
        pgroonga_score(pv.tableoid, pv.ctid) AS score,
        pv."validFrom",
        pv."isDeleted" AS "isDeleted",
        CASE WHEN pv."isDeleted" THEN pv."validFrom" ELSE NULL END AS "deletedAt",
        ps."wilson95",
        ps."controversy"
      FROM "PageVersion" pv
      JOIN "Page" p ON pv."pageId" = p.id
      LEFT JOIN "PageStats" ps ON ps."pageVersionId" = pv.id
      LEFT JOIN url_hits uh ON uh.id = pv."pageId"
      WHERE pv."validTo" IS NULL
        AND (
          pv.title &@~ $1
          OR (pv."alternateTitle" IS NOT NULL AND pv."alternateTitle" &@~ $1)
          OR uh.id IS NOT NULL
        )
        AND ($2::text[] IS NULL OR pv.tags @> $2::text[])
        AND ($3::text[] IS NULL OR NOT (pv.tags && $3::text[]))
        AND ($4::int IS NULL OR pv.rating >= $4)
        AND ($5::int IS NULL OR pv.rating <= $5)
    )
    SELECT * FROM base
    ORDER BY 
      CASE WHEN $8 = 'rating' THEN NULL END,
      CASE WHEN $8 = 'recent' THEN NULL END,
      CASE WHEN ($8 IS NULL OR $8 = 'relevance') AND $1 IS NOT NULL THEN (CASE WHEN lower(split_part(url, '/', 4)) = lower($1) THEN 1 ELSE 0 END) END DESC NULLS LAST,
      CASE WHEN ($8 IS NULL OR $8 = 'relevance') AND $1 IS NOT NULL THEN (CASE WHEN lower(url) = lower($1) THEN 1 ELSE 0 END) END DESC NULLS LAST,
      CASE WHEN ($8 IS NULL OR $8 = 'relevance') AND $1 IS NOT NULL THEN (CASE WHEN lower(title) = lower($1) THEN 1 ELSE 0 END) END DESC NULLS LAST,
      CASE WHEN ($8 IS NULL OR $8 = 'relevance') AND $1 IS NOT NULL THEN (CASE WHEN title &@~ $1 THEN 1 ELSE 0 END) END DESC NULLS LAST,
      CASE WHEN ($8 IS NULL OR $8 = 'relevance') AND $1 IS NOT NULL THEN (CASE WHEN "alternateTitle" IS NOT NULL AND "alternateTitle" &@~ $1 THEN 1 ELSE 0 END) END DESC NULLS LAST,
      CASE WHEN ($8 IS NULL OR $8 = 'relevance') THEN score END DESC NULLS LAST,
      CASE WHEN $8 = 'rating' THEN rating END DESC NULLS LAST,
      CASE WHEN $8 = 'recent' THEN COALESCE("firstRevisionAt", "validFrom") END DESC
    LIMIT $6::int OFFSET $7::int
  `;

  const countSql = `
    EXPLAIN (ANALYZE, VERBOSE, BUFFERS)
    WITH url_hits AS (
      SELECT id
      FROM "Page"
      WHERE $1::text IS NOT NULL
        AND "currentUrl" &@~ $1
    )
    SELECT COUNT(*) AS total
    FROM "PageVersion" pv
    JOIN "Page" p ON pv."pageId" = p.id
    LEFT JOIN url_hits uh ON uh.id = pv."pageId"
    WHERE pv."validTo" IS NULL
      AND (
        pv.title &@~ $1
        OR (pv."alternateTitle" IS NOT NULL AND pv."alternateTitle" &@~ $1)
        OR uh.id IS NOT NULL
      )
      AND ($2::text[] IS NULL OR pv.tags @> $2::text[])
      AND ($3::text[] IS NULL OR NOT (pv.tags && $3::text[]))
      AND ($4::int IS NULL OR pv.rating >= $4)
      AND ($5::int IS NULL OR pv.rating <= $5)
  `;

  const params = [
    searchTerm,
    emptyArray,
    emptyArray,
    ratingMin,
    ratingMax,
    limit,
    offset,
    orderBy
  ];

  const client = new Client({ connectionString: getConnectionString() });
  await client.connect();

  try {
    console.log(`\n=== Profiling /search/all page SQL for query "${searchTerm}" ===`);
    const pagePlan = await client.query(pageSql, params);
    pagePlan.rows.forEach((row) => console.log(row['QUERY PLAN']));

    if (includeCount) {
      console.log(`\n=== Profiling count(*) companion query ===`);
      const countPlan = await client.query(countSql, params.slice(0, 5));
      countPlan.rows.forEach((row) => console.log(row['QUERY PLAN']));
    }
  } finally {
    await client.end();
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
