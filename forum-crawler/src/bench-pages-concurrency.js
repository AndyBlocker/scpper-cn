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

  const client = await createClient();
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
    });

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
