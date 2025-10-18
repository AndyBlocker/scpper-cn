import { Pool } from 'pg';
import { cfg } from '../src/config.js';

type Dict<T = unknown> = Record<string, T>;

function parseArgs(argv: string[]) {
  const args = { pretty: false, json: false, limit: 10, stalledMinutes: 10 } as {
    pretty: boolean;
    json: boolean;
    limit: number;
    stalledMinutes: number;
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--pretty') args.pretty = true;
    else if (a === '--json') args.json = true;
    else if (a === '--help' || a === '-h') {
      printHelp();
      process.exit(0);
    } else if (a.startsWith('--limit=')) {
      const v = Number(a.split('=')[1]);
      if (Number.isFinite(v) && v > 0) args.limit = Math.min(Math.floor(v), 100);
    } else if (a === '--limit' && i + 1 < argv.length) {
      const v = Number(argv[++i]);
      if (Number.isFinite(v) && v > 0) args.limit = Math.min(Math.floor(v), 100);
    } else if (a.startsWith('--stalled-min=')) {
      const v = Number(a.split('=')[1]);
      if (Number.isFinite(v) && v > 0) args.stalledMinutes = Math.min(Math.floor(v), 1440);
    } else if (a === '--stalled-min' && i + 1 < argv.length) {
      const v = Number(argv[++i]);
      if (Number.isFinite(v) && v > 0) args.stalledMinutes = Math.min(Math.floor(v), 1440);
    }
  }
  if (args.json) args.pretty = false;
  return args;
}

function printHelp() {
  console.log(`Usage: node image-stat.js [--pretty|--json] [--limit N] [--stalled-min M]\n\n` +
    `Reports Page Image ingestion status from the database.\n` +
    `Options:\n` +
    `  --pretty           Human-readable output (default if --json not set)\n` +
    `  --json             JSON output\n` +
    `  --limit N          Rows to show for latest sections (default: 10, max: 100)\n` +
    `  --stalled-min M    Minutes threshold to flag stalled PROCESSING jobs (default: 10)`);
}

function formatBytes(n: number | null | undefined) {
  if (!n || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0; let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2)} ${units[i]}`;
}

function safeDate(v: unknown): string | null {
  if (!v) return null;
  try {
    const d = new Date(String(v));
    if (isNaN(d.getTime())) return null;
    return d.toISOString();
  } catch { return null; }
}

function trunc(s: unknown, max = 96): string | null {
  if (typeof s !== 'string') return s == null ? null : String(s);
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.pretty && !args.json) args.pretty = true;

  const dbUrl = cfg.imageCache.databaseUrl;
  if (!cfg.imageCache.enabled) {
    console.error('[image-stat] PAGE_IMAGE_WORKER_ENABLED is false; worker disabled.');
  }
  if (!dbUrl) {
    console.error('[image-stat] PAGE_IMAGE_DATABASE_URL is not set.');
    process.exit(2);
  }

  const pool = new Pool({ connectionString: dbUrl });
  try {
    const payload = await collect(pool, args.limit, args.stalledMinutes);
    if (args.pretty) printPretty(payload);
    else console.log(JSON.stringify(payload, null, 2));
  } finally {
    await pool.end().catch(() => {});
  }
}

async function collect(pool: Pool, limit: number, stalledMinutes: number) {
  const [jobCounts, pendingReady, pendingNotReady, oldestPending, nextNotReady, processingList, stalledProcessing,
    latestFailedJobs, pviCounts, latestResolvedPvi, latestFailedPvi, assetCounts, readyAssetAgg, latestAssets, missingStoragePath] = await Promise.all([
    qMap(pool, 'SELECT status, COUNT(*)::bigint AS count FROM "ImageIngestJob" GROUP BY status'),
    qOne(pool, 'SELECT COUNT(*)::bigint AS count FROM "ImageIngestJob" WHERE status = \'PENDING\' AND "nextRunAt" <= NOW()'),
    qOne(pool, 'SELECT COUNT(*)::bigint AS count FROM "ImageIngestJob" WHERE status = \'PENDING\' AND "nextRunAt" > NOW()'),
    qOne(pool, 'SELECT MIN("nextRunAt") AS min FROM "ImageIngestJob" WHERE status = \'PENDING\''),
    qOne(pool, 'SELECT MIN("nextRunAt") AS min FROM "ImageIngestJob" WHERE status = \'PENDING\' AND "nextRunAt" > NOW()'),
    qRows(pool, `SELECT id, "pageVersionImageId", "lockedAt", "lockedBy", attempts, "updatedAt"\n                FROM "ImageIngestJob"\n                WHERE status = 'PROCESSING'\n                ORDER BY "lockedAt" DESC NULLS LAST\n                LIMIT $1`, [limit]),
    qOne(pool, `SELECT COUNT(*)::bigint AS count\n                FROM "ImageIngestJob"\n                WHERE status = 'PROCESSING' AND "lockedAt" IS NOT NULL AND "lockedAt" < NOW() - ($1 || ' minutes')::interval`, [String(stalledMinutes)]),
    qRows(pool, `SELECT id, "pageVersionImageId", attempts, "lastError", "updatedAt"\n                FROM "ImageIngestJob"\n                WHERE status = 'FAILED'\n                ORDER BY "updatedAt" DESC NULLS LAST\n                LIMIT $1`, [limit]),
    qMap(pool, 'SELECT status, COUNT(*)::bigint AS count FROM "PageVersionImage" GROUP BY status'),
    qRows(pool, `SELECT id, "pageVersionId", "imageAssetId", "normalizedUrl", "lastFetchedAt"\n                FROM "PageVersionImage"\n                WHERE status = 'RESOLVED'\n                ORDER BY "lastFetchedAt" DESC NULLS LAST\n                LIMIT $1`, [limit]),
    qRows(pool, `SELECT id, "pageVersionId", "failureCount", "lastError", "normalizedUrl", "lastFetchedAt"\n                 FROM "PageVersionImage"\n                 WHERE status = 'FAILED'\n                 ORDER BY "lastFetchedAt" DESC NULLS LAST\n                 LIMIT $1`, [limit]),
    qMap(pool, 'SELECT status, COUNT(*)::bigint AS count FROM "ImageAsset" GROUP BY status'),
    qOne(pool, `SELECT COUNT(*)::bigint AS count, COALESCE(SUM(bytes),0)::bigint AS bytes\n                FROM "ImageAsset" WHERE status = 'READY'`),
    qRows(pool, `SELECT id, "mimeType", bytes, "canonicalUrl", "updatedAt"\n                FROM "ImageAsset"\n                WHERE status = 'READY'\n                ORDER BY "updatedAt" DESC NULLS LAST\n                LIMIT $1`, [limit]),
    qOne(pool, `SELECT COUNT(*)::bigint AS count\n                FROM "ImageAsset" WHERE status = 'READY' AND "storagePath" IS NULL`)
  ]);

  const jobTotals = toTotals(jobCounts);
  const pviTotals = toTotals(pviCounts);
  const assetTotals = toTotals(assetCounts);

  return {
    generatedAt: new Date().toISOString(),
    config: {
      enabled: cfg.imageCache.enabled,
      concurrency: cfg.imageCache.concurrency,
      fetchDelayMs: cfg.imageCache.fetchDelayMs,
      idleDelayMs: cfg.imageCache.idleDelayMs,
      requestTimeoutMs: cfg.imageCache.requestTimeoutMs,
      retryBaseMs: cfg.imageCache.retryBaseMs,
      retryMaxMs: cfg.imageCache.retryMaxMs,
      assetRoot: cfg.imageCache.assetRoot
    },
    jobs: {
      totals: jobTotals,
      pending: {
        total: (jobTotals.PENDING ?? 0),
        ready: Number(pendingReady.count || 0),
        notReady: Number(pendingNotReady.count || 0),
        oldestNextRunAt: safeDate(oldestPending.min),
        nextNotReadyAt: safeDate(nextNotReady.min)
      },
      processing: {
        total: (jobTotals.PROCESSING ?? 0),
        stalledMinutes,
        stalled: Number(stalledProcessing.count || 0)
      },
      latestProcessing: processingList.map(r => ({
        id: r.id,
        pageVersionImageId: r.pageVersionImageId,
        lockedAt: safeDate(r.lockedAt),
        lockedBy: r.lockedBy ?? null,
        attempts: r.attempts,
        updatedAt: safeDate(r.updatedAt)
      })),
      latestFailed: latestFailedJobs.map(r => ({
        id: r.id,
        pageVersionImageId: r.pageVersionImageId,
        attempts: r.attempts,
        lastError: r.lastError ?? null,
        updatedAt: safeDate(r.updatedAt)
      }))
    },
    images: {
      totalsByStatus: pviTotals,
      latestResolved: latestResolvedPvi.map(r => ({
        id: r.id,
        pageVersionId: r.pageVersionId,
        imageAssetId: r.imageAssetId,
        normalizedUrl: r.normalizedUrl,
        lastFetchedAt: safeDate(r.lastFetchedAt)
      })),
      latestFailed: latestFailedPvi.map(r => ({
        id: r.id,
        pageVersionId: r.pageVersionId,
        failureCount: r.failureCount,
        lastError: r.lastError ?? null,
        normalizedUrl: r.normalizedUrl,
        lastFetchedAt: safeDate(r.lastFetchedAt)
      }))
    },
    assets: {
      totalsByStatus: assetTotals,
      readyCount: Number(readyAssetAgg.count || 0),
      bytesReady: Number(readyAssetAgg.bytes || 0),
      latestReady: latestAssets.map(r => ({
        id: r.id,
        mimeType: r.mimeType ?? null,
        bytes: r.bytes ?? null,
        canonicalUrl: r.canonicalUrl ?? null,
        updatedAt: safeDate(r.updatedAt)
      })),
      missingStoragePath: Number(missingStoragePath.count || 0)
    }
  };
}

async function qMap(pool: Pool, sql: string, params: unknown[] = []): Promise<Dict<number>> {
  const res = await pool.query(sql, params);
  const m: Dict<number> = {};
  for (const row of res.rows) {
    const k = String(row.status ?? row.key ?? '');
    const v = Number(row.count ?? 0);
    if (k) m[k] = v;
  }
  return m;
}

async function qOne(pool: Pool, sql: string, params: unknown[] = []): Promise<Dict> {
  const res = await pool.query(sql, params);
  return res.rows[0] || {};
}

async function qRows(pool: Pool, sql: string, params: unknown[] = []): Promise<any[]> {
  const res = await pool.query(sql, params);
  return res.rows;
}

function toTotals(map: Dict<number>): Dict<number> & { ALL: number } {
  let sum = 0; for (const v of Object.values(map)) sum += v;
  return { ...map, ALL: sum };
}

function printPretty(payload: any) {
  const p = payload;
  console.log(`[page-image] generatedAt=${p.generatedAt}`);
  console.log(`[page-image] enabled=${p.config.enabled} concurrency=${p.config.concurrency} fetchDelayMs=${p.config.fetchDelayMs} idleDelayMs=${p.config.idleDelayMs}`);
  console.log(`[page-image] requestTimeoutMs=${p.config.requestTimeoutMs} retryBaseMs=${p.config.retryBaseMs} retryMaxMs=${p.config.retryMaxMs}`);
  console.log(`[page-image] assetRoot=${p.config.assetRoot}`);

  console.log('\nJobs:');
  console.log(`  totals: ${Object.entries(p.jobs.totals).map(([k,v]) => `${k}=${v}`).join(' ')}`);
  console.log(`  pending: total=${p.jobs.pending.total} ready=${p.jobs.pending.ready} notReady=${p.jobs.pending.notReady} oldestNextRunAt=${p.jobs.pending.oldestNextRunAt ?? 'n/a'} nextNotReadyAt=${p.jobs.pending.nextNotReadyAt ?? 'n/a'}`);
  console.log(`  processing: total=${p.jobs.processing.total} stalled(${p.jobs.processing.stalledMinutes}m)=${p.jobs.processing.stalled}`);
  if (p.jobs.latestProcessing.length > 0) {
    console.log('  latest processing:');
    for (const r of p.jobs.latestProcessing) {
      console.log(`    #${r.id} pvi=${r.pageVersionImageId} lockedAt=${r.lockedAt ?? 'n/a'} attempts=${r.attempts} by=${r.lockedBy ?? 'n/a'}`);
    }
  }
  if (p.jobs.latestFailed.length > 0) {
    console.log('  latest failed jobs:');
    for (const r of p.jobs.latestFailed) {
      console.log(`    #${r.id} pvi=${r.pageVersionImageId} attempts=${r.attempts} at=${r.updatedAt ?? 'n/a'} err=${trunc(r.lastError, 120)}`);
    }
  }

  console.log('\nImages:');
  console.log(`  totals: ${Object.entries(p.images.totalsByStatus).map(([k,v]) => `${k}=${v}`).join(' ')}`);
  if (p.images.latestResolved.length > 0) {
    console.log('  latest resolved:');
    for (const r of p.images.latestResolved) {
      console.log(`    pvi=${r.id} asset=${r.imageAssetId ?? 'n/a'} at=${r.lastFetchedAt ?? 'n/a'} url=${trunc(r.normalizedUrl, 120)}`);
    }
  }
  if (p.images.latestFailed.length > 0) {
    console.log('  latest failed images:');
    for (const r of p.images.latestFailed) {
      console.log(`    pvi=${r.id} failures=${r.failureCount} at=${r.lastFetchedAt ?? 'n/a'} err=${trunc(r.lastError, 120)}`);
    }
  }

  console.log('\nAssets:');
  console.log(`  totals: ${Object.entries(p.assets.totalsByStatus).map(([k,v]) => `${k}=${v}`).join(' ')}`);
  console.log(`  ready: count=${p.assets.readyCount} bytes=${p.assets.bytesReady} (${formatBytes(p.assets.bytesReady)}) missingStoragePath=${p.assets.missingStoragePath}`);
  if (p.assets.latestReady.length > 0) {
    console.log('  latest ready assets:');
    for (const r of p.assets.latestReady) {
      console.log(`    #${r.id} ${formatBytes(r.bytes)} ${r.mimeType ?? 'unknown'} at=${r.updatedAt ?? 'n/a'} url=${trunc(r.canonicalUrl, 120)}`);
    }
  }
}

// eslint-disable-next-line @typescript-eslint/no-floating-promises
main();
