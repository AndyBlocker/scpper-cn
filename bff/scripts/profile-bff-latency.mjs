#!/usr/bin/env node
import 'dotenv/config';
import { performance } from 'node:perf_hooks';

function parseArgs(argv) {
  const opts = {
    base: process.env.BFF_BASE_URL || process.env.BFF_BASE || 'http://127.0.0.1:3000',
    endpoint: '/search/all',
    query: 'scp',
    iterations: 5,
    params: [],
    headers: {}
  };

  const headerPrefix = '--header=';
  const paramPrefix = '--param=';

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--base' && argv[i + 1]) {
      opts.base = argv[++i];
    } else if (arg.startsWith('--base=')) {
      opts.base = arg.slice(7);
    } else if (arg === '--endpoint' && argv[i + 1]) {
      opts.endpoint = argv[++i];
    } else if (arg.startsWith('--endpoint=')) {
      opts.endpoint = arg.slice(11);
    } else if (arg === '--query' && argv[i + 1]) {
      opts.query = argv[++i];
    } else if (arg.startsWith('--query=')) {
      opts.query = arg.slice(8);
    } else if (arg === '--iterations' && argv[i + 1]) {
      opts.iterations = Number(argv[++i]);
    } else if (arg.startsWith('--iterations=')) {
      opts.iterations = Number(arg.slice(13));
    } else if (arg.startsWith(headerPrefix)) {
      const kv = arg.slice(headerPrefix.length);
      const [key, ...rest] = kv.split('=');
      if (key && rest.length) {
        opts.headers[key.trim()] = rest.join('=');
      }
    } else if (arg === '--header' && argv[i + 1]) {
      const kv = argv[++i];
      const [key, ...rest] = kv.split('=');
      if (key && rest.length) {
        opts.headers[key.trim()] = rest.join('=');
      }
    } else if (arg.startsWith(paramPrefix)) {
      opts.params.push(arg.slice(paramPrefix.length));
    } else if (arg === '--param' && argv[i + 1]) {
      opts.params.push(argv[++i]);
    } else if (!arg.startsWith('--') && !opts.freeArgUsed) {
      opts.query = arg;
      opts.freeArgUsed = true;
    }
  }

  opts.iterations = Number.isFinite(opts.iterations) && opts.iterations > 0 ? Math.floor(opts.iterations) : 5;
  return opts;
}

function buildUrl(base, endpoint, query, extraParams) {
  const url = new URL(endpoint, base.endsWith('/') ? base : `${base}/`);
  if (query) {
    url.searchParams.set('query', query);
  }
  for (const raw of extraParams) {
    const [key, ...rest] = raw.split('=');
    if (key) {
      url.searchParams.set(key, rest.length ? rest.join('=') : '');
    }
  }
  return url;
}

async function runProbe({ base, endpoint, query, iterations, params, headers }) {
  const url = buildUrl(base, endpoint, query, params);
  const runs = [];
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    let status = 0;
    let bodyText = '';
    let error = null;
    try {
      const res = await fetch(url, { headers: { accept: 'application/json', ...headers } });
      status = res.status;
      bodyText = await res.text();
    } catch (err) {
      error = err;
    }
    const duration = performance.now() - start;
    let size = Buffer.byteLength(bodyText, 'utf8');
    let snippet = bodyText.slice(0, 120).replace(/\s+/g, ' ');
    if (snippet.length === 120 && bodyText.length > 120) snippet += '…';
    runs.push({ index: i + 1, ms: duration, status, size, snippet, error });
    const statusLabel = error ? 'ERR' : status;
    console.log(`[${i + 1}/${iterations}] ${statusLabel} ${duration.toFixed(1)} ms ${size} bytes`);
    if (error) {
      console.error(`    ${error.message}`);
    }
  }
  return runs;
}

function summarize(runs) {
  const successful = runs.filter((r) => !r.error && r.status >= 200 && r.status < 500);
  if (!successful.length) {
    return null;
  }
  const times = successful.map((r) => r.ms);
  const avg = times.reduce((acc, n) => acc + n, 0) / times.length;
  const sorted = [...times].sort((a, b) => a - b);
  const p95 = sorted[Math.min(sorted.length - 1, Math.floor(0.95 * sorted.length))];
  const max = Math.max(...times);
  const min = Math.min(...times);
  return { min, max, avg, p95, count: successful.length };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  console.log('=== BFF latency probe ===');
  console.log(`Base URL    : ${options.base}`);
  console.log(`Endpoint    : ${options.endpoint}`);
  console.log(`Query       : ${options.query}`);
  console.log(`Iterations  : ${options.iterations}`);
  if (options.params.length) console.log(`Extra params: ${options.params.join(', ')}`);
  if (Object.keys(options.headers).length) console.log(`Headers     : ${JSON.stringify(options.headers)}`);

  const runs = await runProbe(options);
  const stats = summarize(runs);
  if (stats) {
    console.log('\n--- Summary ---');
    console.log(`Samples : ${stats.count}`);
    console.log(`Min     : ${stats.min.toFixed(1)} ms`);
    console.log(`Avg     : ${stats.avg.toFixed(1)} ms`);
    console.log(`P95     : ${stats.p95.toFixed(1)} ms`);
    console.log(`Max     : ${stats.max.toFixed(1)} ms`);
  } else {
    console.log('\nNo successful responses recorded.');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
