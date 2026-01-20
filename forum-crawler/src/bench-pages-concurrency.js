import { performance } from 'node:perf_hooks';
import { Client } from '@ukwhatn/wikidot';
import { setupProxy } from './bootstrap-proxy.js';

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name} in environment`);
  return v;
}

function optEnv(name) {
  return process.env[name] || undefined;
}

function intEnv(name, fallback) {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function boolEnv(name, fallback) {
  const v = process.env[name];
  if (!v) return fallback;
  return v !== '0' && v.toLowerCase() !== 'false';
}

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h${minutes}m${seconds}s`;
  if (minutes > 0) return `${minutes}m${seconds}s`;
  return `${seconds}s`;
}

function truncate(text, maxLen) {
  if (!text) return '';
  if (text.length <= maxLen) return text;
  return `${text.slice(0, Math.max(0, maxLen - 3))}...`;
}

function buildBar(current, total, width = 24) {
  if (total <= 0) return '[------------------------]';
  const ratio = Math.min(1, Math.max(0, current / total));
  const filled = Math.round(ratio * width);
  const empty = Math.max(0, width - filled);
  return `[${'#'.repeat(filled)}${'-'.repeat(empty)}]`;
}

function createProgressReporter({ total, label, logEvery }) {
  const start = Date.now();
  let lastLen = 0;
  let lastPrinted = 0;

  const render = ({ processed, ok, fail, lastTitle }) => {
    const now = Date.now();
    if (processed !== total && processed % logEvery !== 0) return;
    if (now - lastPrinted < 100 && processed !== total) return;
    lastPrinted = now;

    const elapsedMs = Math.max(0, now - start);
    const rate = processed > 0 && elapsedMs > 0 ? processed / (elapsedMs / 1000) : 0;
    const remaining = Math.max(0, total - processed);
    const etaMs = rate > 0 ? Math.ceil((remaining / rate) * 1000) : 0;
    const percent = total > 0 ? ((processed / total) * 100).toFixed(1) : '0.0';
    const bar = buildBar(processed, total, 24);
    const title = truncate(lastTitle, 48);

    const line = `${label} ${bar} ${percent}% | ${processed}/${total} | ETA ${formatDuration(etaMs)} | ${rate.toFixed(2)} p/s | ok ${ok} fail ${fail} | last: ${title}`;
    const padded = line.padEnd(Math.max(lastLen, line.length), ' ');
    lastLen = padded.length;
    process.stdout.write(`\r${padded}`);
  };

  const stop = () => {
    process.stdout.write('\n');
  };

  return { render, stop };
}

async function createClient() {
  const username = optEnv('WIKIDOT_USERNAME');
  const password = optEnv('WIKIDOT_PASSWORD');
  const clientRes = username && password
    ? await Client.create({ username, password })
    : Client.createAnonymous();
  if (!clientRes.isOk()) throw clientRes.error;
  return clientRes.value;
}

async function fetchPageData(page, perPageParallel) {
  const tasks = {
    source: () => page.getSource(),
    revisions: () => page.getRevisions(),
    votes: () => page.getVotes(),
    metas: () => page.getMetas(),
    files: () => page.getFiles(),
    discussion: () => page.getDiscussion(),
  };

  const results = {};
  const errors = [];

  const runTask = async (key, fn) => {
    const started = performance.now();
    const res = await fn();
    const durationMs = performance.now() - started;
    if (res.isOk && res.isOk()) {
      results[key] = { ok: true, durationMs };
    } else {
      const err = res.error ?? res;
      errors.push({ key, message: err?.message || String(err) });
      results[key] = { ok: false, durationMs };
    }
  };

  if (perPageParallel) {
    await Promise.all(Object.entries(tasks).map(([key, fn]) => runTask(key, fn)));
  } else {
    for (const [key, fn] of Object.entries(tasks)) {
      await runTask(key, fn);
    }
  }

  return { results, errors };
}

async function runWithConcurrency(items, limit, worker) {
  let index = 0;
  const runners = Array.from({ length: limit }, async () => {
    while (true) {
      const i = index++;
      if (i >= items.length) return;
      await worker(items[i], i);
    }
  });
  await Promise.all(runners);
}

async function main() {
  setupProxy();
  const siteName = requireEnv('SITE_NAME');
  const concurrency = Math.max(1, intEnv('CONCURRENCY', 5));
  const maxPages = Math.max(0, intEnv('MAX_PAGES', 0));
  const perPageParallel = boolEnv('PER_PAGE_PARALLEL', true);
  const logEvery = Math.max(1, intEnv('LOG_EVERY', 1));
  const label = optEnv('PROGRESS_LABEL') || 'Bench';

  const client = await createClient();
  let progress = null;
  const stats = {
    total: 0,
    ok: 0,
    fail: 0,
    perMethod: {
      source: { ok: 0, err: 0 },
      revisions: { ok: 0, err: 0 },
      votes: { ok: 0, err: 0 },
      metas: { ok: 0, err: 0 },
      files: { ok: 0, err: 0 },
      discussion: { ok: 0, err: 0 },
    },
    durationsMs: [],
    errors: [],
  };

  const start = performance.now();

  try {
    const siteRes = await client.site.get(siteName);
    if (!siteRes.isOk()) throw siteRes.error;
    const site = siteRes.value;

    const pagesRes = await site.pages.all();
    if (!pagesRes.isOk()) throw pagesRes.error;
    const pages = pagesRes.value;

    const targetPages = maxPages > 0 ? pages.slice(0, maxPages) : pages;
    stats.total = targetPages.length;
    progress = createProgressReporter({ total: stats.total, label, logEvery });

    await runWithConcurrency(targetPages, concurrency, async (page) => {
      const pageStart = performance.now();
      const { results, errors } = await fetchPageData(page, perPageParallel);
      const elapsed = performance.now() - pageStart;

      stats.durationsMs.push(elapsed);
      if (errors.length === 0) {
        stats.ok += 1;
      } else {
        stats.fail += 1;
        stats.errors.push({ page: page.fullname ?? page.name ?? '(unknown)', errors });
      }

      for (const [key, result] of Object.entries(results)) {
        if (result.ok) stats.perMethod[key].ok += 1;
        else stats.perMethod[key].err += 1;
      }

      if (progress) {
        const processed = stats.ok + stats.fail;
        const lastTitle = page.title || page.fullname || page.name || '(unknown)';
        progress.render({ processed, ok: stats.ok, fail: stats.fail, lastTitle });
      }
    });

    if (progress) progress.stop();

    const totalMs = performance.now() - start;
    const avgMs = stats.durationsMs.length
      ? stats.durationsMs.reduce((a, b) => a + b, 0) / stats.durationsMs.length
      : 0;

    console.log(JSON.stringify({
      site: siteName,
      totalPages: stats.total,
      concurrency,
      perPageParallel,
      ok: stats.ok,
      fail: stats.fail,
      avgPageMs: Math.round(avgMs),
      totalMs: Math.round(totalMs),
      pagesPerSec: stats.total > 0 ? Number((stats.total / (totalMs / 1000)).toFixed(2)) : 0,
      perMethod: stats.perMethod,
      errorsSample: stats.errors.slice(0, 10),
    }, null, 2));
  } finally {
    if (progress) progress.stop();
    try {
      const closeRes = await client.close();
      if (!closeRes.isOk()) {
        console.warn('client.close failed:', closeRes.error?.message || closeRes.error);
      }
    } catch (err) {
      console.warn('client.close threw:', err);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
