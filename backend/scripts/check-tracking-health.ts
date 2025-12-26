#!/usr/bin/env node
import fetch from 'node-fetch';
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
  username_count: bigint | number | null;
  sample_usernames: string[] | null;
  sample_username_events: (bigint | number | null)[] | null;
  sample_username_ips: (string | null)[] | null;
  sample_username_latest_seen: (Date | null)[] | null;
  event_count: bigint | number | null;
  ip_count: bigint | number | null;
  top_ip: string | null;
  top_ip_events: bigint | number | null;
  first_seen: Date | null;
  latest_seen: Date | null;
};

type PairRow = {
  user_a: string | null;
  user_b: string | null;
  shared_hashes: bigint | number | null;
  total_shared_events: bigint | number | null;
  events_user_a: bigint | number | null;
  events_user_b: bigint | number | null;
  latest_seen: Date | null;
  sample_ips: (string | null)[] | null;
  sample_ip_events: (bigint | number | null)[] | null;
  non_shared_events_user_a: bigint | number | null;
  non_shared_events_user_b: bigint | number | null;
};

type PageRow = {
  wikidot_id: number | null;
  descriptor: string | null;
  cnt: bigint | number | null;
};

let jsonMode = false;
let output: Record<string, unknown> = {};

const MATCH_WINDOW_SECONDS = 15;
const MAX_PAIR_DISPLAY = 5;
const MAX_PAGE_DISPLAY = 5;

type OverlapEvent = {
  userId: number | null;
  username: string;
  norm: string;
  clientHash: string;
  pageId: number;
  wikidotId: number;
  pageTitle: string;
};

type OverlapVote = {
  userId: number;
  pageId: number;
};

type PairOverlap = {
  userA: string;
  userB: string;
  sharedPages: Array<{
    pageId: number;
    wikidotId: number;
    pageTitle: string;
    hitsA: number;
    hitsB: number;
    userAVoted: boolean;
    userBVoted: boolean;
  }>;
  userAOnly: Array<{
    pageId: number;
    wikidotId: number;
    pageTitle: string;
    hits: number;
    voted: boolean;
  }>;
  userBOnly: Array<{
    pageId: number;
    wikidotId: number;
    pageTitle: string;
    hits: number;
    voted: boolean;
  }>;
  sharedCount: number;
  hashCount: number;
};

function toNumber(value: bigint | number | null | undefined): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'bigint') return Number(value);
  return 0;
}

function iso(value: Date | null | undefined): string {
  return value ? value.toISOString() : 'n/a';
}

const ipGeoCache = new Map<string, string>();

function normalizeUsername(username: string | null | undefined): string | null {
  if (!username) return null;
  const trimmed = username.trim();
  if (!trimmed) return null;
  const norm = trimmed.toLowerCase().replace(/[^a-z0-9]+/g, '');
  return norm || null;
}

function formatVote(voted: boolean): string {
  return voted ? '✓' : '×';
}

function printPairOverlap(pairs: PairOverlap[]): void {
  console.log(`\n=== 用户重叠访问（${MATCH_WINDOW_SECONDS}s 窗口，去符号差异） ===`);
  if (pairs.length === 0) {
    console.log('未找到跨用户名的共享页面访问。');
    return;
  }

  for (const pair of pairs.slice(0, MAX_PAIR_DISPLAY)) {
    console.log(`- ${pair.userA} ↔ ${pair.userB}（共同页面 ${pair.sharedPages.length}，指纹 ${pair.hashCount}）`);
    if (pair.sharedPages.length === 0) {
      console.log('  共同页面：无');
    } else {
      console.log('  共同页面（示例）：');
      pair.sharedPages.slice(0, MAX_PAGE_DISPLAY).forEach((page) => {
        console.log(
          `    • ${page.pageTitle} (${page.wikidotId}) A:${page.hitsA} / B:${page.hitsB} 投票 A:${formatVote(page.userAVoted)} B:${formatVote(page.userBVoted)}`
        );
      });
    }
    if (pair.userAOnly.length > 0) {
      console.log(
        `  仅 ${pair.userA}：` +
          pair.userAOnly
            .slice(0, MAX_PAGE_DISPLAY)
            .map((p) => `${p.pageTitle} (${p.wikidotId}) x${p.hits} ${formatVote(p.voted)}`)
            .join('； ')
      );
    }
    if (pair.userBOnly.length > 0) {
      console.log(
        `  仅 ${pair.userB}：` +
          pair.userBOnly
            .slice(0, MAX_PAGE_DISPLAY)
            .map((p) => `${p.pageTitle} (${p.wikidotId}) x${p.hits} ${formatVote(p.voted)}`)
            .join('； ')
      );
    }
  }
}

async function fetchOverlapEvents(prisma: ReturnType<typeof getPrismaClient>): Promise<OverlapEvent[]> {
  const rows = await prisma.$queryRawUnsafe<
    Array<{
      userId: bigint | number | null;
      username: string | null;
      norm_username: string | null;
      clientHash: string | null;
      pageId: bigint | number | null;
      wikidotId: bigint | number | null;
      pageTitle: string | null;
    }>
  >(
    `
    WITH filtered AS (
      SELECT "userId",
             username,
             LOWER(REGEXP_REPLACE(username, '[^a-z0-9]+', '', 'g')) AS norm_username,
             "clientHash",
             "createdAt"
        FROM "UserPixelEvent"
       WHERE "clientHash" IS NOT NULL
         AND TRIM("clientHash") <> ''
         AND username IS NOT NULL
         AND TRIM(username) <> ''
         AND LOWER(REGEXP_REPLACE(username, '[^a-z0-9]+', '', 'g')) IS NOT NULL
         AND TRIM(LOWER(REGEXP_REPLACE(username, '[^a-z0-9]+', '', 'g'))) <> ''
    ),
    eligible_hash AS (
      SELECT "clientHash"
        FROM filtered
       GROUP BY "clientHash"
      HAVING COUNT(DISTINCT norm_username) > 1
    )
    SELECT f."userId",
           f.username,
           f.norm_username,
           f."clientHash",
           p."pageId",
           p."wikidotId",
           COALESCE(NULLIF(pv.title, ''), pg."currentUrl", '(untitled)') AS pageTitle
      FROM filtered f
      JOIN eligible_hash eh ON eh."clientHash" = f."clientHash"
      JOIN "PageViewEvent" p
        ON p."clientHash" = f."clientHash"
       AND p."createdAt" BETWEEN f."createdAt" - INTERVAL '${MATCH_WINDOW_SECONDS} seconds'
                           AND f."createdAt" + INTERVAL '${MATCH_WINDOW_SECONDS} seconds'
      JOIN "Page" pg ON pg.id = p."pageId"
      LEFT JOIN "PageVersion" pv
        ON pv."pageId" = p."pageId" AND pv."validTo" IS NULL
    `
  );

  return rows
    .map((row) => ({
      userId: row.userId === null ? null : toNumber(row.userId),
      username: row.username ?? '(unknown)',
      norm: normalizeUsername(row.norm_username) ?? '(unknown)',
      clientHash: row.clientHash ?? '(unknown)',
      pageId: toNumber(row.pageId),
      wikidotId: toNumber(row.wikidotId),
      pageTitle: row.pageTitle ?? '(untitled)'
    }))
    .filter((row) => row.norm !== '(unknown)' && row.clientHash !== '(unknown)');
}

async function fetchOverlapVotes(prisma: ReturnType<typeof getPrismaClient>, userIds: number[]): Promise<OverlapVote[]> {
  if (userIds.length === 0) return [];
  const placeholders = userIds.map((_, idx) => `$${idx + 1}`).join(',');
  const sql = `
    SELECT v."userId", pv."pageId"
      FROM "Vote" v
      JOIN "PageVersion" pv ON pv.id = v."pageVersionId"
     WHERE v."userId" IN (${placeholders})
  `;
  const rows = await prisma.$queryRawUnsafe<Array<{ userId: bigint | number; pageId: bigint | number }>>(
    sql,
    ...userIds
  );
  return rows.map((row) => ({ userId: toNumber(row.userId), pageId: toNumber(row.pageId) }));
}

function buildPairOverlaps(events: OverlapEvent[], votes: OverlapVote[]): PairOverlap[] {
  const voteSet = new Set(votes.map((v) => `${v.userId}|${v.pageId}`));
  const userMeta = new Map<
    string,
    { display: string; variants: Set<string>; userId: number | null; count: number }
  >();

  events.forEach((ev) => {
    const meta = userMeta.get(ev.norm);
    if (!meta) {
      userMeta.set(ev.norm, {
        display: ev.username,
        variants: new Set([ev.username]),
        userId: ev.userId,
        count: 1
      });
    } else {
      meta.variants.add(ev.username);
      meta.count += 1;
      if (meta.count === 1 || (ev.username && ev.username.length < meta.display.length)) {
        meta.display = ev.username;
      }
      if (meta.userId === null && ev.userId !== null) {
        meta.userId = ev.userId;
      }
    }
  });

  const hashUsers = new Map<string, Set<string>>();
  events.forEach((ev) => {
    if (!hashUsers.has(ev.clientHash)) hashUsers.set(ev.clientHash, new Set());
    hashUsers.get(ev.clientHash)?.add(ev.norm);
  });

  const pairData = new Map<
    string,
    {
      normA: string;
      normB: string;
      clientHashes: Set<string>;
      perUserPages: Map<string, Map<number, { pageId: number; wikidotId: number; pageTitle: string; hits: number }>>;
    }
  >();

  for (const [clientHash, norms] of hashUsers.entries()) {
    const normList = Array.from(norms).sort();
    for (let i = 0; i < normList.length; i++) {
      for (let j = i + 1; j < normList.length; j++) {
        const a = normList[i];
        const b = normList[j];
        const key = `${a}|||${b}`;
        if (!pairData.has(key)) {
          pairData.set(key, {
            normA: a,
            normB: b,
            clientHashes: new Set(),
            perUserPages: new Map()
          });
        }
        pairData.get(key)?.clientHashes.add(clientHash);
      }
    }
  }

  const pairedHashes = new Set<string>();
  pairData.forEach((data) => data.clientHashes.forEach((h) => pairedHashes.add(h)));

  events.forEach((ev) => {
    if (!pairedHashes.has(ev.clientHash)) return;
    pairData.forEach((data) => {
      if (!data.clientHashes.has(ev.clientHash)) return;
      if (ev.norm !== data.normA && ev.norm !== data.normB) return;
      let userMap = data.perUserPages.get(ev.norm);
      if (!userMap) {
        userMap = new Map();
        data.perUserPages.set(ev.norm, userMap);
      }
      const entry =
        userMap.get(ev.pageId) || { pageId: ev.pageId, wikidotId: ev.wikidotId, pageTitle: ev.pageTitle, hits: 0 };
      entry.hits += 1;
      userMap.set(ev.pageId, entry);
    });
  });

  const results: PairOverlap[] = [];
  pairData.forEach((data) => {
    const aMap = data.perUserPages.get(data.normA) || new Map();
    const bMap = data.perUserPages.get(data.normB) || new Map();
    const userAId = userMeta.get(data.normA)?.userId ?? null;
    const userBId = userMeta.get(data.normB)?.userId ?? null;

    const shared = [];
    for (const [pageId, aEntry] of aMap.entries()) {
      const bEntry = bMap.get(pageId);
      if (bEntry) {
        shared.push({
          pageId,
          wikidotId: aEntry.wikidotId,
          pageTitle: aEntry.pageTitle,
          hitsA: aEntry.hits,
          hitsB: bEntry.hits,
          userAVoted: userAId !== null ? voteSet.has(`${userAId}|${pageId}`) : false,
          userBVoted: userBId !== null ? voteSet.has(`${userBId}|${pageId}`) : false
        });
      }
    }

    const aOnly = [];
    for (const [pageId, aEntry] of aMap.entries()) {
      if (!bMap.has(pageId)) {
        aOnly.push({
          pageId,
          wikidotId: aEntry.wikidotId,
          pageTitle: aEntry.pageTitle,
          hits: aEntry.hits,
          voted: userAId !== null ? voteSet.has(`${userAId}|${pageId}`) : false
        });
      }
    }

    const bOnly = [];
    for (const [pageId, bEntry] of bMap.entries()) {
      if (!aMap.has(pageId)) {
        bOnly.push({
          pageId,
          wikidotId: bEntry.wikidotId,
          pageTitle: bEntry.pageTitle,
          hits: bEntry.hits,
          voted: userBId !== null ? voteSet.has(`${userBId}|${pageId}`) : false
        });
      }
    }

    shared.sort((x, y) => y.hitsA + y.hitsB - (x.hitsA + x.hitsB));
    aOnly.sort((x, y) => y.hits - x.hits);
    bOnly.sort((x, y) => y.hits - x.hits);

    results.push({
      userA: userMeta.get(data.normA)?.display ?? data.normA,
      userB: userMeta.get(data.normB)?.display ?? data.normB,
      sharedPages: shared.slice(0, MAX_PAGE_DISPLAY),
      userAOnly: aOnly.slice(0, MAX_PAGE_DISPLAY),
      userBOnly: bOnly.slice(0, MAX_PAGE_DISPLAY),
      sharedCount: shared.length,
      hashCount: data.clientHashes.size
    });
  });

  results.sort((x, y) => y.sharedCount - x.sharedCount || y.hashCount - x.hashCount);
  return results.slice(0, MAX_PAIR_DISPLAY);
}

async function fetchIpGeo(ip: string, timeoutMs = 2000): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(
      `http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,country,regionName,city,isp,org,message`,
      { signal: controller.signal }
    );
    if (!resp.ok) return null;
    const data = (await resp.json()) as {
      status?: string;
      city?: string;
      regionName?: string;
      country?: string;
      isp?: string;
      org?: string;
      message?: string;
    };
    if (data.status !== 'success') return null;
    const parts = [data.country, data.regionName, data.city, data.isp ?? data.org].filter(Boolean);
    return parts.join(' / ') || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function lookupIpGeos(ips: (string | null | undefined)[]): Promise<Record<string, string>> {
  const uniqueIps = Array.from(
    new Set(ips.map((ip) => ip?.trim()).filter((ip): ip is string => Boolean(ip)))
  );
  const results: Record<string, string> = {};

  for (const ip of uniqueIps) {
    if (ipGeoCache.has(ip)) {
      results[ip] = ipGeoCache.get(ip) ?? 'n/a';
      continue;
    }
    const geo = await fetchIpGeo(ip);
    const normalized = geo ?? 'n/a';
    ipGeoCache.set(ip, normalized);
    results[ip] = normalized;
  }

  return results;
}

async function main(): Promise<void> {
  jsonMode = process.argv.includes('--json');
  output = {};
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

  const trackingOverview = [
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
  ];

  output.trackingOverview = trackingOverview;
  if (!jsonMode) {
    console.log('=== Tracking Event Overview ===');
    console.table(trackingOverview);
  }

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

  const dayDiffDisplay = dayDiffs.map((row) => ({
    day: row.day.toISOString().slice(0, 10),
    events: toNumber(row.events),
    statsViews: toNumber(row.stats_views),
    diff: toNumber(row.diff)
  }));

  output.dayDiffs = dayDiffDisplay;
  if (!jsonMode) {
    console.log('\n=== PageDailyStats vs PageViewEvent (last 30 days) ===');
    console.table(dayDiffDisplay);
  }

  const anomalyThreshold = (row: DailyDiffRow): number => Math.max(0.1 * toNumber(row.events), 1000);
  const diffAnomalies = dayDiffs.filter((row) => Math.abs(toNumber(row.diff)) > anomalyThreshold(row));
  const diffAnomaliesDisplay = diffAnomalies.map((row) => ({
    day: row.day.toISOString().slice(0, 10),
    events: toNumber(row.events),
    statsViews: toNumber(row.stats_views),
    diff: toNumber(row.diff),
    threshold: anomalyThreshold(row)
  }));
  output.dayDiffAnomalies = diffAnomaliesDisplay;
  if (!jsonMode) {
    if (diffAnomalies.length > 0) {
      console.log('\n⚠️  Potential inconsistencies detected:');
      console.table(diffAnomaliesDisplay);
    } else {
      console.log('\n✅ No major day-level discrepancies between raw events and PageDailyStats.');
    }
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

  const topPagesDisplay = topPages.map((row) => ({
    wikidotId: row.wikidot_id ?? 'n/a',
    descriptor: row.descriptor ?? '(unknown)',
    views: toNumber(row.cnt)
  }));
  output.topPages = topPagesDisplay;
  if (!jsonMode) {
    console.log('\n=== Top Pages by Views (last 7 days) ===');
    console.table(topPagesDisplay);
  }

  const topClientHashes = await prisma.$queryRawUnsafe<CountRow[]>(`
    SELECT "clientHash" AS label, COUNT(*)::bigint AS cnt
      FROM "PageViewEvent"
     GROUP BY "clientHash"
     ORDER BY cnt DESC
     LIMIT 10
  `);

  const topClientDisplay = topClientHashes.map((row) => ({
    clientHash: row.label,
    hits: toNumber(row.cnt)
  }));
  output.topClientFingerprints = topClientDisplay;
  if (!jsonMode) {
    console.log('\n=== Heavy Client Fingerprints (all time) ===');
    console.table(topClientDisplay);
  }

  const suspiciousClientHits = topClientHashes.filter((row) => toNumber(row.cnt) >= 5000);
  const suspiciousClientDisplay = suspiciousClientHits.map((row) => ({
    clientHash: row.label,
    hits: toNumber(row.cnt)
  }));
  output.suspiciousClientFingerprints = suspiciousClientDisplay;
  if (!jsonMode && suspiciousClientHits.length > 0) {
    console.log('\n⚠️  High-volume client fingerprints detected:');
    console.table(suspiciousClientDisplay);
  }

  const topReferers = await prisma.$queryRawUnsafe<CountRow[]>(`
    SELECT COALESCE("refererHost", '(none)') AS label, COUNT(*)::bigint AS cnt
      FROM "PageViewEvent"
     GROUP BY COALESCE("refererHost", '(none)')
     ORDER BY cnt DESC
     LIMIT 10
  `);

  const topReferersDisplay = topReferers.map((row) => ({
    refererHost: row.label,
    hits: toNumber(row.cnt)
  }));
  output.topReferers = topReferersDisplay;
  if (!jsonMode) {
    console.log('\n=== Top Referer Hosts (all time) ===');
    console.table(topReferersDisplay);
  }

  const topUsers = await prisma.$queryRawUnsafe<CountRow[]>(`
    SELECT COALESCE(username, '(unknown)') AS label, COUNT(*)::bigint AS cnt
      FROM "UserPixelEvent"
     GROUP BY COALESCE(username, '(unknown)')
     ORDER BY cnt DESC
     LIMIT 10
  `);

  const topUsersDisplay = topUsers.map((row) => ({
    username: row.label,
    hits: toNumber(row.cnt)
  }));
  output.topUsers = topUsersDisplay;
  if (!jsonMode) {
    console.log('\n=== User Pixel Activity (all time) ===');
    console.table(topUsersDisplay);
  }

  const suspiciousUsers = topUsers.filter((row) => toNumber(row.cnt) >= 2000);
  const suspiciousUsersDisplay = suspiciousUsers.map((row) => ({
    username: row.label,
    hits: toNumber(row.cnt)
  }));
  output.suspiciousUsers = suspiciousUsersDisplay;
  if (!jsonMode && suspiciousUsers.length > 0) {
    console.log('\n⚠️  High-volume username pixel events detected:');
    console.table(suspiciousUsersDisplay);
  }

  const sharedFingerprintRows = await prisma.$queryRawUnsafe<FingerprintRow[]>(`
    WITH filtered AS (
      SELECT "clientHash" AS client_hash,
             "clientIp" AS client_ip,
             LOWER(REGEXP_REPLACE(username, '[^a-z0-9]+', '', 'g')) AS norm_username,
             username,
             "createdAt"
        FROM "UserPixelEvent"
       WHERE "clientHash" IS NOT NULL
         AND TRIM("clientHash") <> ''
         AND username IS NOT NULL
         AND TRIM(username) <> ''
         AND LOWER(REGEXP_REPLACE(username, '[^a-z0-9]+', '', 'g')) IS NOT NULL
         AND TRIM(LOWER(REGEXP_REPLACE(username, '[^a-z0-9]+', '', 'g'))) <> ''
    ),
    per_hash AS (
      SELECT client_hash,
             COUNT(*)::bigint AS event_count,
             COUNT(DISTINCT norm_username)::bigint AS username_count,
             MIN("createdAt") AS first_seen,
             MAX("createdAt") AS latest_seen,
             COUNT(DISTINCT client_ip)::bigint AS ip_count
        FROM filtered
       GROUP BY client_hash
      HAVING COUNT(DISTINCT norm_username) > 1
    ),
    per_username AS (
      SELECT client_hash,
             username,
             COUNT(*)::bigint AS events_for_user,
             MAX("createdAt") AS latest_seen_for_user
        FROM filtered
       GROUP BY client_hash, username
    ),
    per_username_last_ip AS (
      SELECT DISTINCT ON (client_hash, username)
             client_hash,
             username,
             client_ip AS last_ip
        FROM filtered
       WHERE client_ip IS NOT NULL
         AND TRIM(client_ip) <> ''
       ORDER BY client_hash, username, "createdAt" DESC
    ),
    username_arrays AS (
      SELECT pu.client_hash,
             ARRAY_AGG(pu.username ORDER BY pu.events_for_user DESC, pu.username) AS usernames,
             ARRAY_AGG(pu.events_for_user ORDER BY pu.events_for_user DESC, pu.username) AS username_events,
             ARRAY_AGG(lip.last_ip ORDER BY pu.events_for_user DESC, pu.username) AS username_ips,
             ARRAY_AGG(pu.latest_seen_for_user ORDER BY pu.events_for_user DESC, pu.username) AS username_latest_seen
        FROM per_username pu
        LEFT JOIN per_username_last_ip lip
          ON lip.client_hash = pu.client_hash
         AND lip.username = pu.username
       GROUP BY pu.client_hash
    ),
    top_ip AS (
      SELECT DISTINCT ON (client_hash)
             client_hash,
             client_ip AS top_ip,
             COUNT(*)::bigint AS top_ip_events
        FROM filtered
       WHERE client_ip IS NOT NULL
         AND TRIM(client_ip) <> ''
       GROUP BY client_hash, client_ip
       ORDER BY client_hash, top_ip_events DESC, client_ip
    )
    SELECT ph.client_hash,
           ph.username_count,
           ph.event_count,
           ph.ip_count,
           ph.first_seen,
           ph.latest_seen,
           ua.usernames[:5] AS sample_usernames,
           ua.username_events[:5] AS sample_username_events,
           ua.username_ips[:5] AS sample_username_ips,
           ua.username_latest_seen[:5] AS sample_username_latest_seen,
           ti.top_ip,
           ti.top_ip_events
      FROM per_hash ph
      JOIN username_arrays ua ON ua.client_hash = ph.client_hash
      LEFT JOIN top_ip ti ON ti.client_hash = ph.client_hash
     ORDER BY ph.username_count DESC,
              ph.event_count DESC
     LIMIT 20
  `);

  if (!jsonMode) {
    console.log('\n=== Shared Fingerprints Across Multiple Usernames (all time) ===');
  }
  if (sharedFingerprintRows.length === 0) {
    output.sharedFingerprints = [];
    output.sharedFingerprintHighOverlap = [];
    if (!jsonMode) {
      console.log('未发现同一指纹对应多个用户名的情况。');
    }
  } else {
    const ipsForLookup = new Set<string>();
    sharedFingerprintRows.forEach((row) => {
      const normalizedTopIp = row.top_ip?.trim();
      if (normalizedTopIp) ipsForLookup.add(normalizedTopIp);
      (row.sample_username_ips ?? []).forEach((ip) => {
        const normalized = ip?.trim();
        if (normalized) ipsForLookup.add(normalized);
      });
    });
    const ipGeoMap = await lookupIpGeos([...ipsForLookup]);

    const sharedFingerprintDisplay = sharedFingerprintRows.map((row) => {
      const perUserBreakdown = (row.sample_usernames ?? []).map((username, idx) => {
        const usernameLabel = username ?? '(未知用户)';
        const eventCount = toNumber(row.sample_username_events?.[idx]);
        const rawIp = row.sample_username_ips?.[idx];
        const lastIp = rawIp?.trim() ?? '(未知)';
        const geoKey = rawIp?.trim();
        const lastIpGeo = geoKey && ipGeoMap[geoKey] && ipGeoMap[geoKey] !== 'n/a' ? ` | ${ipGeoMap[geoKey]}` : '';
        const lastSeen = iso(row.sample_username_latest_seen?.[idx] ?? null);
        return `${usernameLabel} (${eventCount} 次, last: ${lastSeen}, ip: ${lastIp}${lastIpGeo})`;
      });
      const topIp = row.top_ip?.trim();
      const topIpGeo = topIp ? ipGeoMap[topIp] : null;

      return {
        clientHash: row.client_hash ?? '(未提供)',
        usernames: perUserBreakdown.join(' | '),
        usernameCount: toNumber(row.username_count),
        totalEvents: toNumber(row.event_count),
        ipCount: toNumber(row.ip_count),
        topIp: topIp ?? '(未知)',
        topIpGeo: topIpGeo && topIpGeo !== 'n/a' ? topIpGeo : 'n/a',
        topIpEvents: toNumber(row.top_ip_events),
        firstSeen: iso(row.first_seen ?? null),
        latestSeen: iso(row.latest_seen ?? null)
      };
    });

    const highOverlap = sharedFingerprintRows.filter(
      (row) => toNumber(row.username_count) >= 3 || toNumber(row.event_count) >= 500
    );
    const highOverlapDisplay = highOverlap.map((row) => ({
      clientHash: row.client_hash ?? '(未提供)',
      usernameCount: toNumber(row.username_count),
      totalEvents: toNumber(row.event_count),
      topIp: row.top_ip?.trim() ?? '(未知)',
      topIpGeo:
        row.top_ip?.trim() && ipGeoMap[row.top_ip.trim()] && ipGeoMap[row.top_ip.trim()] !== 'n/a'
          ? ipGeoMap[row.top_ip.trim()]
          : 'n/a',
      latestSeen: iso(row.latest_seen ?? null)
    }));

    output.sharedFingerprints = sharedFingerprintDisplay;
    output.sharedFingerprintHighOverlap = highOverlapDisplay;

    if (!jsonMode) {
      console.table(sharedFingerprintDisplay);
      if (highOverlapDisplay.length > 0) {
        console.log('\n⚠️  以下指纹对应的用户名或事件数量较多，请关注潜在共用：');
        console.table(highOverlapDisplay);
      }
    }
  }

  const sharedPairRows = await prisma.$queryRawUnsafe<PairRow[]>(`
    WITH filtered AS (
      SELECT "clientHash" AS client_hash,
             "clientIp" AS client_ip,
             "userAgent" AS user_agent,
             username,
             LOWER(REGEXP_REPLACE(username, '[^a-z0-9]+', '', 'g')) AS norm_username,
             "createdAt"
        FROM "UserPixelEvent"
       WHERE "clientHash" IS NOT NULL
         AND TRIM("clientHash") <> ''
         AND username IS NOT NULL
         AND TRIM(username) <> ''
         AND LOWER(REGEXP_REPLACE(username, '[^a-z0-9]+', '', 'g')) IS NOT NULL
         AND TRIM(LOWER(REGEXP_REPLACE(username, '[^a-z0-9]+', '', 'g'))) <> ''
    ),
    eligible_hash AS (
      SELECT client_hash
        FROM filtered
       GROUP BY client_hash
      HAVING COUNT(DISTINCT norm_username) > 1
    ),
    user_hash AS (
      SELECT client_hash,
             username,
             norm_username,
             COUNT(*)::bigint AS events_for_user,
             MIN("createdAt") AS first_seen,
             MAX("createdAt") AS latest_seen
        FROM filtered
       WHERE client_hash IN (SELECT client_hash FROM eligible_hash)
       GROUP BY client_hash, username, norm_username
    ),
    pair_hash AS (
      SELECT LEAST(u1.username, u2.username) AS user_a,
             GREATEST(u1.username, u2.username) AS user_b,
             u1.client_hash,
             u1.events_for_user AS events_user_a,
             u2.events_for_user AS events_user_b,
             (u1.events_for_user + u2.events_for_user)::bigint AS events_pair,
             GREATEST(u1.latest_seen, u2.latest_seen) AS latest_seen
        FROM user_hash u1
        JOIN user_hash u2
          ON u1.client_hash = u2.client_hash
         AND u1.norm_username < u2.norm_username
    ),
    pair_summary AS (
      SELECT user_a,
             user_b,
             COUNT(DISTINCT client_hash)::bigint AS shared_hashes,
             SUM(events_pair)::bigint AS total_shared_events,
             SUM(events_user_a)::bigint AS events_user_a,
             SUM(events_user_b)::bigint AS events_user_b,
             MAX(latest_seen) AS latest_seen
        FROM pair_hash
       GROUP BY user_a, user_b
    ),
    pair_ip_stats AS (
      SELECT ph.user_a,
             ph.user_b,
             fe.client_ip,
             COUNT(*)::bigint AS events_on_ip
        FROM pair_hash ph
        JOIN filtered fe
          ON fe.client_hash = ph.client_hash
         AND fe.username IN (ph.user_a, ph.user_b)
       WHERE fe.client_ip IS NOT NULL
         AND TRIM(fe.client_ip) <> ''
       GROUP BY ph.user_a, ph.user_b, fe.client_ip
    ),
    pair_ip_arrays AS (
      SELECT user_a,
             user_b,
             ARRAY_AGG(client_ip ORDER BY events_on_ip DESC, client_ip) AS ips,
             ARRAY_AGG(events_on_ip ORDER BY events_on_ip DESC, client_ip) AS ip_events
        FROM pair_ip_stats
       GROUP BY user_a, user_b
    ),
    pair_events AS (
      SELECT ph.user_a,
             ph.user_b,
             fe.username,
             fe.client_ip,
             fe.user_agent
        FROM pair_hash ph
        JOIN filtered fe
          ON fe.client_hash = ph.client_hash
         AND fe.username IN (ph.user_a, ph.user_b)
    ),
    shared_ipua AS (
      SELECT user_a,
             user_b,
             client_ip,
             user_agent
        FROM pair_events
       GROUP BY user_a, user_b, client_ip, user_agent
      HAVING COUNT(DISTINCT username) = 2
    ),
    non_shared_user_a AS (
      SELECT pe.user_a,
             pe.user_b,
             COUNT(*)::bigint AS non_shared_events_user_a
        FROM pair_events pe
        LEFT JOIN shared_ipua s
          ON s.user_a = pe.user_a
         AND s.user_b = pe.user_b
         AND s.client_ip IS NOT DISTINCT FROM pe.client_ip
         AND s.user_agent IS NOT DISTINCT FROM pe.user_agent
       WHERE pe.username = pe.user_a
         AND s.client_ip IS NULL
       GROUP BY pe.user_a, pe.user_b
    ),
    non_shared_user_b AS (
      SELECT pe.user_a,
             pe.user_b,
             COUNT(*)::bigint AS non_shared_events_user_b
        FROM pair_events pe
        LEFT JOIN shared_ipua s
          ON s.user_a = pe.user_a
         AND s.user_b = pe.user_b
         AND s.client_ip IS NOT DISTINCT FROM pe.client_ip
         AND s.user_agent IS NOT DISTINCT FROM pe.user_agent
       WHERE pe.username = pe.user_b
         AND s.client_ip IS NULL
       GROUP BY pe.user_a, pe.user_b
    )
    SELECT ps.user_a,
           ps.user_b,
           ps.shared_hashes,
           ps.total_shared_events,
           ps.events_user_a,
           ps.events_user_b,
           ps.latest_seen,
           pia.ips[:5] AS sample_ips,
           pia.ip_events[:5] AS sample_ip_events,
           COALESCE(nsa.non_shared_events_user_a, 0)::bigint AS non_shared_events_user_a,
           COALESCE(nsb.non_shared_events_user_b, 0)::bigint AS non_shared_events_user_b
      FROM pair_summary ps
      LEFT JOIN pair_ip_arrays pia
        ON pia.user_a = ps.user_a
       AND pia.user_b = ps.user_b
      LEFT JOIN non_shared_user_a nsa
        ON nsa.user_a = ps.user_a
       AND nsa.user_b = ps.user_b
      LEFT JOIN non_shared_user_b nsb
        ON nsb.user_a = ps.user_a
       AND nsb.user_b = ps.user_b
     ORDER BY ps.total_shared_events DESC,
              ps.shared_hashes DESC
     LIMIT 30
  `);

  if (!jsonMode) {
    console.log('\n=== Username Associations via Shared Client Hash (deduped) ===');
  }
  if (sharedPairRows.length === 0) {
    output.usernameAssociations = [];
    if (!jsonMode) {
      console.log('未发现存在指纹共用关联的用户名对。');
    }
  } else {
    const pairIps = new Set<string>();
    sharedPairRows.forEach((row) => {
      (row.sample_ips ?? []).forEach((ip) => {
        const normalized = ip?.trim();
        if (normalized) pairIps.add(normalized);
      });
    });
    const pairGeoMap = await lookupIpGeos([...pairIps]);

    const associationByUser = new Map<string, { items: string[]; latest: Date | null }>();

    sharedPairRows.forEach((row) => {
      const baseUser = row.user_a ?? '(未知)';
      const associatedUser = row.user_b ?? '(未知)';
      const ipHits = (row.sample_ips ?? []).map((ip, idx) => {
        const ipLabel = ip?.trim() ?? '(未知IP)';
        const geo = ipLabel && pairGeoMap[ipLabel] && pairGeoMap[ipLabel] !== 'n/a' ? ` | ${pairGeoMap[ipLabel]}` : '';
        const hits = toNumber(row.sample_ip_events?.[idx]);
        return `${ipLabel}${geo} x${hits}`;
      });

      const nonSharedInfo = `nonSharedIP+UA: ${toNumber(row.non_shared_events_user_a)}/${toNumber(
        row.non_shared_events_user_b
      )}`;

      const entry = `${associatedUser} (sharedEvents: ${toNumber(
        row.total_shared_events
      )}, perUser: ${toNumber(row.events_user_a)}/${toNumber(row.events_user_b)}, sharedHashes: ${toNumber(
        row.shared_hashes
      )}, ips: ${ipHits.join('; ') || 'n/a'}, ${nonSharedInfo})`;

      const existing = associationByUser.get(baseUser);
      const latest = row.latest_seen ?? null;
      if (!existing) {
        associationByUser.set(baseUser, { items: [entry], latest });
      } else {
        existing.items.push(entry);
        if (latest && (!existing.latest || latest > existing.latest)) {
          existing.latest = latest;
        }
      }
    });

    const associationRows = Array.from(associationByUser.entries()).map(([user, data]) => ({
      user,
      associates: data.items.join(' || '),
      latestSeen: iso(data.latest)
    }));

    output.usernameAssociations = associationRows;

    if (!jsonMode) {
      console.table(associationRows);
    }
  }

  // Pretty overlap output (15s window, normalized usernames)
  const overlapEvents = await fetchOverlapEvents(prisma);
  const overlapUserIds = Array.from(
    new Set(overlapEvents.map((ev) => ev.userId).filter((id): id is number => typeof id === 'number'))
  );
  const overlapVotes = await fetchOverlapVotes(prisma, overlapUserIds);
  const pairOverlaps = buildPairOverlaps(overlapEvents, overlapVotes);
  output.usernameOverlapPretty = pairOverlaps;
  if (!jsonMode) {
    printPairOverlap(pairOverlaps);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (jsonMode && Object.keys(output).length > 0) {
      console.log(JSON.stringify(output, null, 2));
    }
    try {
      await disconnectPrisma();
    } catch {
      // ignore
    }
  });
