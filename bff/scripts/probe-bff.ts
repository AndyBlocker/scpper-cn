/*
Simple probe script for BFF endpoints.
Usage:
  BFF_BASE_URL=http://localhost:4396 npx ts-node bff/scripts/probe-bff.ts
or:
  npm run probe -- --base http://localhost:4396
*/

type Json = unknown;

interface ProbeResult<T = Json> {
  ok: boolean;
  status: number;
  url: string;
  data?: T;
  error?: string;
}

function parseArgs(argv: string[]) {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--base' && next) {
      args.base = next;
      i++;
    } else if (arg === '--timeout' && next) {
      args.timeout = next;
      i++;
    } else if (arg === '--verbose') {
      args.verbose = '1';
    }
  }
  return args;
}

async function httpGet<T = Json>(baseUrl: string, path: string, timeoutMs: number): Promise<ProbeResult<T>> {
  const url = `${baseUrl.replace(/\/$/, '')}${path.startsWith('/') ? '' : '/'}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    const ct = res.headers.get('content-type') || '';
    let data: any = undefined;
    if (ct.includes('application/json')) {
      data = await res.json();
    } else {
      data = await res.text();
    }
    return { ok: res.ok, status: res.status, url, data };
  } catch (e: any) {
    return { ok: false, status: 0, url, error: e?.message || String(e) };
  } finally {
    clearTimeout(timer);
  }
}

function pick<T extends object>(obj: T, keys: (keyof T)[]): Partial<T> {
  const out: Partial<T> = {};
  for (const k of keys) {
    if (k in obj) (out as any)[k] = (obj as any)[k];
  }
  return out;
}

function sampleArray<T>(arr: T[], n = 3): T[] {
  return Array.isArray(arr) ? arr.slice(0, n) : [];
}

async function main() {
  const argv = parseArgs(process.argv.slice(2));
  const base = argv.base || process.env.BFF_BASE_URL || 'http://localhost:4396';
  const timeoutMs = Number(argv.timeout || process.env.BFF_TIMEOUT_MS || 5000);
  const verbose = argv.verbose === '1';

  const probes: Array<{ name: string; path: string; process?: (data: any) => any }>
    = [
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

  const results: Record<string, ProbeResult> = {};
  for (const p of probes) {
    const res = await httpGet(base, p.path, timeoutMs);
    if (res.ok && res.data && !verbose) {
      // Reduce payloads for readability
      let data: any = res.data;
      if (Array.isArray(data)) {
        data = sampleArray(data, 3);
      } else if (data && typeof data === 'object') {
        // Common wrappers
        if ('results' in data && Array.isArray((data as any).results)) {
          data = { results: sampleArray((data as any).results, 3) };
        } else if ('payload' in data) {
          data = pick(data as any, ['updatedAt', 'expiresAt']);
        }
      }
      results[p.name] = { ...res, data } as ProbeResult;
    } else {
      results[p.name] = res as ProbeResult;
    }
  }

  // Pretty print summary
  const summary = Object.entries(results).map(([name, r]) => ({
    name,
    ok: r.ok,
    status: r.status,
    url: r.url,
    sample: r.data,
    error: r.error,
  }));
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ base, results: summary }, null, 2));
}

// Node 18+ has global fetch
// If not available, instruct the user
declare const fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
declare const RequestInfo: any;
declare const RequestInit: any;
declare const Response: any;

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});


