#!/usr/bin/env node
import { getPrismaClient, disconnectPrisma } from '../src/utils/db-connection.ts';

type SummaryRow = {
  total: bigint | number | null;
  earliest: Date | null;
  latest: Date | null;
};

type DailyDiffRow = {
  day: Date;
  events: bigint | number | null;
  stats_views: bigint | number | null;
  diff: bigint | number | null;
};

type CountRow = {
  label: string | null;
  cnt: bigint | number | null;
};

type FingerprintRow = {
  client_hash: string | null;
  client_ip: string | null;
  user_agent: string | null;
  username_count: bigint | number | null;
  sample_usernames: string[] | null;
  latest_seen: Date | null;
};

type PageRow = {
  wikidot_id: number | null;
  descriptor: string | null;
  cnt: bigint | number | null;
};

function toNumber(value: bigint | number | null | undefined): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'bigint') return Number(value);
  return 0;
}

function iso(value: Date | null | undefined): string {
  return value ? value.toISOString() : 'n/a';
}

async function main(): Promise<void> {
  const prisma = getPrismaClient();

  const [pageSummary] = await prisma.$queryRawUnsafe<SummaryRow[]>(`
    SELECT COUNT(*)::bigint AS total,
           MIN("createdAt") AS earliest,
           MAX("createdAt") AS latest
      FROM "PageViewEvent"
  `);

  const [userSummary] = await prisma.$queryRawUnsafe<SummaryRow[]>(`
    SELECT COUNT(*)::bigint AS total,
           MIN("createdAt") AS earliest,
           MAX("createdAt") AS latest
      FROM "UserPixelEvent"
  `);

  console.log('=== Tracking Event Overview ===');
  console.table([
    {
      table: 'PageViewEvent',
      total: toNumber(pageSummary?.total),
      earliest: iso(pageSummary?.earliest ?? null),
      latest: iso(pageSummary?.latest ?? null)
    },
    {
      table: 'UserPixelEvent',
      total: toNumber(userSummary?.total),
      earliest: iso(userSummary?.earliest ?? null),
      latest: iso(userSummary?.latest ?? null)
    }
  ]);

  const dayDiffs = await prisma.$queryRawUnsafe<DailyDiffRow[]>(`
    WITH events AS (
      SELECT date_trunc('day', "createdAt")::date AS day,
             COUNT(*)::bigint AS events
        FROM "PageViewEvent"
       WHERE "createdAt" >= CURRENT_DATE - INTERVAL '30 days'
       GROUP BY 1
    ),
    stats AS (
      SELECT date,
             SUM(views)::bigint AS stats_views
        FROM "PageDailyStats"
       WHERE date >= CURRENT_DATE - INTERVAL '30 days'
       GROUP BY date
    )
    SELECT d.day,
           COALESCE(e.events, 0)::bigint AS events,
           COALESCE(s.stats_views, 0)::bigint AS stats_views,
           (COALESCE(e.events, 0) - COALESCE(s.stats_views, 0))::bigint AS diff
      FROM generate_series(CURRENT_DATE - INTERVAL '30 days', CURRENT_DATE, INTERVAL '1 day') AS d(day)
      LEFT JOIN events e ON e.day = d.day
      LEFT JOIN stats s ON s.date = d.day
     ORDER BY d.day DESC
  `);

  console.log('\n=== PageDailyStats vs PageViewEvent (last 30 days) ===');
  console.table(
    dayDiffs.map((row) => ({
      day: row.day.toISOString().slice(0, 10),
      events: toNumber(row.events),
      statsViews: toNumber(row.stats_views),
      diff: toNumber(row.diff)
    }))
  );

  const anomalyThreshold = (row: DailyDiffRow): number => Math.max(0.1 * toNumber(row.events), 1000);
  const diffAnomalies = dayDiffs.filter((row) => Math.abs(toNumber(row.diff)) > anomalyThreshold(row));
  if (diffAnomalies.length > 0) {
    console.log('\n⚠️  Potential inconsistencies detected:');
    console.table(
      diffAnomalies.map((row) => ({
        day: row.day.toISOString().slice(0, 10),
        events: toNumber(row.events),
        statsViews: toNumber(row.stats_views),
        diff: toNumber(row.diff),
        threshold: anomalyThreshold(row)
      }))
    );
  } else {
    console.log('\n✅ No major day-level discrepancies between raw events and PageDailyStats.');
  }

  const topPages = await prisma.$queryRawUnsafe<PageRow[]>(`
    SELECT p."wikidotId" AS wikidot_id,
           COALESCE(NULLIF(pv.title, ''), p."currentUrl", '(untitled)') AS descriptor,
           COUNT(*)::bigint AS cnt
      FROM "PageViewEvent" ev
      JOIN "Page" p ON p.id = ev."pageId"
      LEFT JOIN "PageVersion" pv ON pv."pageId" = p.id AND pv."validTo" IS NULL
     WHERE ev."createdAt" >= CURRENT_DATE - INTERVAL '7 days'
     GROUP BY 1, 2
     ORDER BY cnt DESC
     LIMIT 10
  `);

  console.log('\n=== Top Pages by Views (last 7 days) ===');
  console.table(
    topPages.map((row) => ({
      wikidotId: row.wikidot_id ?? 'n/a',
      descriptor: row.descriptor ?? '(unknown)',
      views: toNumber(row.cnt)
    }))
  );

  const topClientHashes = await prisma.$queryRawUnsafe<CountRow[]>(`
    SELECT "clientHash" AS label, COUNT(*)::bigint AS cnt
      FROM "PageViewEvent"
     WHERE "createdAt" >= CURRENT_DATE - INTERVAL '14 days'
     GROUP BY "clientHash"
     ORDER BY cnt DESC
     LIMIT 10
  `);

  console.log('\n=== Heavy Client Fingerprints (last 14 days) ===');
  console.table(
    topClientHashes.map((row) => ({
      clientHash: row.label,
      hits: toNumber(row.cnt)
    }))
  );

  const suspiciousClientHits = topClientHashes.filter((row) => toNumber(row.cnt) >= 5000);
  if (suspiciousClientHits.length > 0) {
    console.log('\n⚠️  High-volume client fingerprints detected:');
    console.table(
      suspiciousClientHits.map((row) => ({
        clientHash: row.label,
        hits: toNumber(row.cnt)
      }))
    );
  }

  const topReferers = await prisma.$queryRawUnsafe<CountRow[]>(`
    SELECT COALESCE("refererHost", '(none)') AS label, COUNT(*)::bigint AS cnt
      FROM "PageViewEvent"
     WHERE "createdAt" >= CURRENT_DATE - INTERVAL '14 days'
     GROUP BY COALESCE("refererHost", '(none)')
     ORDER BY cnt DESC
     LIMIT 10
  `);

  console.log('\n=== Top Referer Hosts (last 14 days) ===');
  console.table(
    topReferers.map((row) => ({
      refererHost: row.label,
      hits: toNumber(row.cnt)
    }))
  );

  const topUsers = await prisma.$queryRawUnsafe<CountRow[]>(`
    SELECT COALESCE(username, '(unknown)') AS label, COUNT(*)::bigint AS cnt
      FROM "UserPixelEvent"
     WHERE "createdAt" >= CURRENT_DATE - INTERVAL '14 days'
     GROUP BY COALESCE(username, '(unknown)')
     ORDER BY cnt DESC
     LIMIT 10
  `);

  console.log('\n=== User Pixel Activity (last 14 days) ===');
  console.table(
    topUsers.map((row) => ({
      username: row.label,
      hits: toNumber(row.cnt)
    }))
  );

  const suspiciousUsers = topUsers.filter((row) => toNumber(row.cnt) >= 2000);
  if (suspiciousUsers.length > 0) {
    console.log('\n⚠️  High-volume username pixel events detected:');
    console.table(
      suspiciousUsers.map((row) => ({
        username: row.label,
        hits: toNumber(row.cnt)
      }))
    );
  }

  const sharedFingerprintRows = await prisma.$queryRawUnsafe<FingerprintRow[]>(`
    WITH recent_events AS (
      SELECT DISTINCT ON ("clientHash", username)
             "clientHash" AS client_hash,
             "clientIp" AS client_ip,
             "userAgent" AS user_agent,
             username,
             "createdAt"
        FROM "UserPixelEvent"
       WHERE "createdAt" >= CURRENT_DATE - INTERVAL '14 days'
         AND "clientHash" IS NOT NULL
         AND TRIM("clientHash") <> ''
         AND username IS NOT NULL
         AND TRIM(username) <> ''
       ORDER BY "clientHash", username, "createdAt" DESC
    ),
    aggregated AS (
      SELECT client_hash,
             MAX(client_ip) AS client_ip,
             MAX(user_agent) AS user_agent,
             COUNT(*)::bigint AS username_count,
             ARRAY_AGG(username ORDER BY username) AS usernames,
             MAX("createdAt") AS latest_seen
        FROM recent_events
       GROUP BY client_hash
      HAVING COUNT(*) > 1
    )
    SELECT client_hash,
           client_ip,
           user_agent,
           username_count,
           usernames[:5] AS sample_usernames,
           latest_seen
      FROM aggregated
     ORDER BY username_count DESC,
              latest_seen DESC
     LIMIT 20
  `);

  console.log('\n=== Shared Fingerprints Across Multiple Usernames (last 14 days) ===');
  if (sharedFingerprintRows.length === 0) {
    console.log('未发现同一指纹（IP + UA）对应多个用户名的情况。');
  } else {
    console.table(
      sharedFingerprintRows.map((row) => ({
        clientHash: row.client_hash ?? '(未提供)',
        clientIp: row.client_ip ?? '(未知)',
        userAgent: row.user_agent ?? '(未提供)',
        usernameCount: toNumber(row.username_count),
        sampleUsernames: (row.sample_usernames ?? []).join(', '),
        latestSeen: iso(row.latest_seen ?? null)
      }))
    );
    const highOverlap = sharedFingerprintRows.filter((row) => toNumber(row.username_count) >= 3);
    if (highOverlap.length > 0) {
      console.log('\n⚠️  以下指纹对应的用户名数量较多，请关注潜在共用：');
      console.table(
        highOverlap.map((row) => ({
          clientHash: row.client_hash ?? '(未提供)',
          clientIp: row.client_ip ?? '(未知)',
          userAgent: row.user_agent ?? '(未提供)',
          usernameCount: toNumber(row.username_count),
          sampleUsernames: (row.sample_usernames ?? []).join(', '),
          latestSeen: iso(row.latest_seen ?? null)
        }))
      );
    }
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await disconnectPrisma();
    } catch {
      // ignore
    }
  });
