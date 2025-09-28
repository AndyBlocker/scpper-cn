#!/usr/bin/env node

// Quick inspection script for page/version data around deleted Wikidot pages.
// Usage: node scripts/check-deleted-page.mjs [wikidotId]

import 'dotenv/config';
import { Pool } from 'pg';

const wikidotIdArg = process.argv[2];
const wikidotId = Number(wikidotIdArg ?? '1460068552');

if (!Number.isInteger(wikidotId)) {
  console.error('Please provide a numeric wikidotId.');
  process.exit(1);
}

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. Did you populate bff/.env?');
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

function formatDate(value) {
  return value ? new Date(value).toISOString() : null;
}

async function main() {
  const pageRes = await pool.query(
    `SELECT 
        id,
        "wikidotId" AS "wikidot_id",
        "currentUrl" AS "current_url",
        "isDeleted" AS "is_deleted",
        "firstPublishedAt" AS "first_published_at",
        "createdAt" AS "created_at",
        "updatedAt" AS "updated_at"
       FROM "Page"
       WHERE "wikidotId" = $1`,
    [wikidotId]
  );

  if (pageRes.rows.length === 0) {
    console.log(`No Page row found for wikidotId ${wikidotId}.`);
    return;
  }

  const page = pageRes.rows[0];
  console.log('Page');
  console.log({
    id: page.id,
    wikidotId: page.wikidot_id,
    currentUrl: page.current_url,
    isDeleted: page.is_deleted,
    firstPublishedAt: formatDate(page.first_published_at),
    createdAt: formatDate(page.created_at),
    updatedAt: formatDate(page.updated_at)
  });

  const versionsRes = await pool.query(
    `SELECT 
        id,
        "validFrom" AS "valid_from",
        "validTo" AS "valid_to",
        "isDeleted" AS "is_deleted",
        rating,
        "voteCount" AS "vote_count",
        "revisionCount" AS "revision_count",
        "commentCount" AS "comment_count",
        "attributionCount" AS "attribution_count",
        tags,
        "createdAt" AS "created_at",
        "updatedAt" AS "updated_at"
       FROM "PageVersion"
       WHERE "pageId" = $1
       ORDER BY "validFrom" DESC`,
    [page.id]
  );

  if (versionsRes.rows.length === 0) {
    console.log('No PageVersion rows found for this page.');
  } else {
    console.log(`\nFound ${versionsRes.rows.length} version(s):`);
  }

  for (const version of versionsRes.rows) {
    const versionSummary = {
      id: version.id,
      validFrom: formatDate(version.valid_from),
      validTo: formatDate(version.valid_to),
      isDeleted: version.is_deleted,
      rating: version.rating,
      voteCount: version.vote_count,
      revisionCountRecorded: version.revision_count,
      commentCount: version.comment_count,
      attributionCount: version.attribution_count,
      tags: version.tags
    };

    console.log('\nPageVersion');
    console.log(versionSummary);

    const statsRes = await pool.query(
      `SELECT uv, dv, wilson95, controversy, "likeRatio" AS "like_ratio"
         FROM "PageStats"
         WHERE "pageVersionId" = $1`,
      [version.id]
    );
    if (statsRes.rows.length) {
      const stats = statsRes.rows[0];
      console.log('  Stats:', {
        uv: stats.uv,
        dv: stats.dv,
        wilson95: stats.wilson95,
        controversy: stats.controversy,
        likeRatio: stats.like_ratio
      });
    } else {
      console.log('  Stats: none');
    }

    const revisionCountRes = await pool.query(
      'SELECT COUNT(*)::int AS count FROM "Revision" WHERE "pageVersionId" = $1',
      [version.id]
    );
    const revisionPreviewRes = await pool.query(
      `SELECT "wikidotId" AS "wikidot_id", type, timestamp
         FROM "Revision"
         WHERE "pageVersionId" = $1
         ORDER BY timestamp DESC
         LIMIT 3`,
      [version.id]
    );

    console.log('  Revisions stored:', {
      expected: version.revision_count,
      actual: revisionCountRes.rows[0]?.count ?? 0,
      latestSamples: revisionPreviewRes.rows.map((row) => ({
        wikidotId: row.wikidot_id,
        type: row.type,
        timestamp: formatDate(row.timestamp)
      }))
    });
  }

  const dailyStatsRes = await pool.query(
    `SELECT 
        date,
        "votes_up" AS "votes_up",
        "votes_down" AS "votes_down",
        "total_votes" AS "total_votes",
        revisions
       FROM "PageDailyStats"
       WHERE "pageId" = $1
       ORDER BY date DESC
       LIMIT 5`,
    [page.id]
  );

  console.log('\nLatest PageDailyStats rows (rating trend proxy):');
  if (dailyStatsRes.rows.length === 0) {
    console.log('  none');
  } else {
    for (const row of dailyStatsRes.rows) {
      console.log(' ', {
        date: row.date?.toISOString?.() ?? formatDate(row.date),
        votesUp: row.votes_up,
        votesDown: row.votes_down,
        totalVotes: row.total_votes,
        revisions: row.revisions
      });
    }
  }
}

main()
  .catch((err) => {
    console.error('Script failed:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end().catch(() => {});
  });
