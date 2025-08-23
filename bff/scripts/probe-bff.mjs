// Simple probe script for BFF endpoints (pure ESM JS)
// Usage:
//   node bff/scripts/probe-bff.mjs --base http://localhost:4396
// or
//   BFF_BASE_URL=http://localhost:4396 npm --prefix bff run probe

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const n = argv[i + 1];
    if (a === '--base' && n) { args.base = n; i++; }
    else if (a === '--timeout' && n) { args.timeout = n; i++; }
    else if (a === '--verbose') { args.verbose = '1'; }
  }
  return args;
}

async function httpGet(baseUrl, path, timeoutMs) {
  const url = `${baseUrl.replace(/\/$/, '')}${path.startsWith('/') ? '' : '/'}${path}`;
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

function sampleArray(arr, n = 3) { return Array.isArray(arr) ? arr.slice(0, n) : []; }
function pick(obj, keys) { const o = {}; for (const k of keys) if (k in obj) o[k] = obj[k]; return o; }

async function main() {
  const argv = parseArgs(process.argv.slice(2));
  const base = argv.base || process.env.BFF_BASE_URL || 'http://localhost:4396';
  const timeoutMs = Number(argv.timeout || process.env.BFF_TIMEOUT_MS || 5000);
  const verbose = argv.verbose === '1';

  const probes = [
    { name: 'health', path: '/healthz' },
    { name: 'pages', path: '/pages?limit=3' },
    { name: 'pages_random', path: '/pages/random' },
    { name: 'pages_matching', path: '/pages/matching?url=http://scp-wiki-cn.wikidot.com/scp-173&limit=5' },
    { name: 'search_pages', path: '/search/pages?query=SCP&limit=3&orderBy=relevance' },
    { name: 'search_users', path: '/search/users?query=Dr&limit=3' },
    { name: 'users_by_rank', path: '/users/by-rank?limit=3' },
    { name: 'stats_site_latest', path: '/stats/site/latest' },
    { name: 'stats_series', path: '/stats/series' },
  ];

  const results = {};
  for (const p of probes) {
    const res = await httpGet(base, p.path, timeoutMs);
    if (res.ok && res.data && !verbose) {
      let data = res.data;
      if (Array.isArray(data)) data = sampleArray(data, 3);
      else if (data && typeof data === 'object') {
        if ('results' in data && Array.isArray(data.results)) data = { results: sampleArray(data.results, 3) };
        else if ('payload' in data) data = pick(data, ['updatedAt', 'expiresAt']);
      }
      results[p.name] = { ...res, data };
    } else {
      results[p.name] = res;
    }
  }

  console.log(JSON.stringify({ base, results: Object.entries(results).map(([name, r]) => ({ name, ...r })) }, null, 2));
}

main().catch((err) => { console.error(err); process.exit(1); });


