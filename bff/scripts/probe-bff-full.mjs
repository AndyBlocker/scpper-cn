// Full probe for all BFF endpoints. Saves a JSON report to disk.
// Usage:
//   node bff/scripts/probe-bff-full.mjs --base http://localhost:4396 --out bff/probe-report.json

import fs from 'node:fs/promises';
import path from 'node:path';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const n = argv[i + 1];
    if (a === '--base' && n) { args.base = n; i++; }
    else if (a === '--out' && n) { args.out = n; i++; }
    else if (a === '--timeout' && n) { args.timeout = n; i++; }
  }
  return args;
}

async function httpGet(baseUrl, pathStr, timeoutMs) {
  const url = `${baseUrl.replace(/\/$/, '')}${pathStr.startsWith('/') ? '' : '/'}${pathStr}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    const ct = res.headers.get('content-type') || '';
    let data;
    if (ct.includes('application/json')) data = await res.json();
    else data = await res.text();
    return { ok: res.ok, status: res.status, url, data };
  } catch (e) {
    return { ok: false, status: 0, url, error: e?.message || String(e) };
  } finally {
    clearTimeout(timer);
  }
}

function safeParseInt(v, d = undefined) { const n = Number(v); return Number.isFinite(n) ? n : d; }

async function main() {
  const argv = parseArgs(process.argv.slice(2));
  const base = argv.base || process.env.BFF_BASE_URL || 'http://localhost:4396';
  const outPath = argv.out || 'probe-report.json';
  const timeoutMs = safeParseInt(argv.timeout || process.env.BFF_TIMEOUT_MS, 8000) ?? 8000;

  // Known endpoints and representative param sets
  const endpoints = [
    { name: 'health', path: '/healthz' },

    // pages
    { name: 'pages_list', path: '/pages?limit=5&sortKey=WIKIDOT_CREATED_AT&sortOrder=DESC' },
    { name: 'pages_by_url_missing_param', path: '/pages/by-url' },
    // will be filled after list fetch if possible
    { name: 'pages_by_id_placeholder', path: null },
    { name: 'pages_matching_sample', path: '/pages/matching?url=http://scp-wiki-cn.wikidot.com/scp-173&limit=5' },
    { name: 'pages_random', path: '/pages/random' },
    // revisions/votes/ratings set after we know a wikidotId
    { name: 'pages_revisions_placeholder', path: null },
    { name: 'pages_votes_fuzzy_placeholder', path: null },
    { name: 'pages_ratings_cumulative_placeholder', path: null },

    // aggregate
    { name: 'aggregate_pages', path: '/aggregate/pages?ratingGte=10' },

    // users
    { name: 'users_by_rank', path: '/users/by-rank?limit=5' },
    // per-user endpoints set after we know an id
    { name: 'users_id_placeholder', path: null },
    { name: 'users_id_stats_placeholder', path: null },
    { name: 'users_id_pages_placeholder', path: null },

    // search
    { name: 'search_pages', path: '/search/pages?query=SCP&limit=5' },
    { name: 'search_users', path: '/search/users?query=Dr&limit=5' },

    // stats
    { name: 'stats_site_latest', path: '/stats/site/latest' },
    { name: 'stats_series', path: '/stats/series' },
    // daily stats placeholders (need ids)
    { name: 'stats_pages_daily_placeholder', path: null },
    { name: 'stats_users_daily_placeholder', path: null },
    { name: 'stats_trending', path: '/stats/trending?statType=top_pages&period=30d&limit=5' },
    { name: 'stats_leaderboard_missing', path: '/stats/leaderboard?key=&period=' },
    // filled later if possible
    { name: 'stats_site_by_date_placeholder', path: null },
  ];

  const report = { base, generatedAt: new Date().toISOString(), results: {} };

  // 1st pass: call endpoints with static paths
  for (const ep of endpoints) {
    if (!ep.path) continue;
    report.results[ep.name] = await httpGet(base, ep.path, timeoutMs);
  }

  // derive dynamic ids
  const pagesList = report.results['pages_list'];
  let sampleWikidotId = null;
  let sampleDate = null;
  if (pagesList?.ok && Array.isArray(pagesList.data) && pagesList.data.length > 0) {
    sampleWikidotId = pagesList.data[0].wikidotId;
  }

  const usersByRank = report.results['users_by_rank'];
  let sampleUserId = null;
  if (usersByRank?.ok && Array.isArray(usersByRank.data) && usersByRank.data.length > 0) {
    sampleUserId = usersByRank.data[0].id;
  }

  const siteLatest = report.results['stats_site_latest'];
  if (siteLatest?.ok && siteLatest.data?.date) {
    // trim to YYYY-MM-DD
    sampleDate = String(siteLatest.data.date).slice(0, 10);
  }

  // fill dynamic endpoints
  const dynamicCalls = [];
  if (sampleWikidotId) {
    dynamicCalls.push(['pages_by_id', `/pages/by-id?wikidotId=${encodeURIComponent(String(sampleWikidotId))}`]);
    dynamicCalls.push(['pages_revisions', `/pages/${encodeURIComponent(String(sampleWikidotId))}/revisions?limit=5`]);
    dynamicCalls.push(['pages_votes_fuzzy', `/pages/${encodeURIComponent(String(sampleWikidotId))}/votes/fuzzy?limit=5`]);
    dynamicCalls.push(['pages_ratings_cumulative', `/pages/${encodeURIComponent(String(sampleWikidotId))}/ratings/cumulative`]);
    dynamicCalls.push(['stats_pages_daily', `/stats/pages/${encodeURIComponent(String(sampleWikidotId))}/daily?limit=5`]);
  }
  if (sampleUserId) {
    dynamicCalls.push(['users_id', `/users/${encodeURIComponent(String(sampleUserId))}`]);
    dynamicCalls.push(['users_id_stats', `/users/${encodeURIComponent(String(sampleUserId))}/stats`]);
    dynamicCalls.push(['users_id_pages', `/users/${encodeURIComponent(String(sampleUserId))}/pages?limit=5`]);
    dynamicCalls.push(['stats_users_daily', `/stats/users/${encodeURIComponent(String(sampleUserId))}/daily?limit=5`]);
  }
  if (sampleDate) {
    dynamicCalls.push(['stats_site_by_date', `/stats/site?date=${encodeURIComponent(sampleDate)}`]);
  }

  for (const [name, p] of dynamicCalls) {
    report.results[name] = await httpGet(base, p, timeoutMs);
  }

  // write report
  const abs = path.resolve(process.cwd(), outPath);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, JSON.stringify(report, null, 2), 'utf8');

  console.log(JSON.stringify({ ok: true, saved: abs, summary: Object.fromEntries(Object.entries(report.results).map(([k, v]) => [k, { ok: v.ok, status: v.status }])) }, null, 2));
}

main().catch((err) => { console.error(err); process.exit(1); });


