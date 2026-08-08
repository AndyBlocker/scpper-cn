/**
 * 纯只读/零 HTTP 的 v1 图片资产复用率核算。
 *
 * 口径：v2 唯一 normalized_url → v1 PageVersionImage.normalizedUrl / ImageAsset.canonicalUrl
 * → READY SHA256 → storagePath 实际文件。多 SHA URL 另列为歧义，不计“安全可直接复用”。
 */

import { stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import dotenv from 'dotenv';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';

import { normalizeImageUrl } from '../src/content/extractImages.js';
import { mapWithConcurrency } from '../src/util/concurrency.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SYNCER2_ROOT = path.resolve(HERE, '..');
const REPO_ROOT = path.resolve(SYNCER2_ROOT, '..');
const V1_ASSET_ROOT = '/home/andyblocker/scpper-cn/.data/page-images';

dotenv.config({ path: path.join(SYNCER2_ROOT, '.env'), override: false });
const backendEnv = dotenv.parse(
  await import('node:fs/promises').then(({ readFile }) =>
    readFile(path.join(REPO_ROOT, 'backend', '.env'), 'utf8')
  ),
);
const v1Url = process.env['SYNCER2_V1_DATABASE_URL'];
const backendUrl = backendEnv['DATABASE_URL'];
if (!v1Url) throw new Error('缺少 SYNCER2_V1_DATABASE_URL');
if (!backendUrl) throw new Error('backend/.env 缺少 DATABASE_URL');
const v2Url = replaceDatabaseName(backendUrl, 'scpper-v2');

interface V2UrlRow extends QueryResultRow {
  normalized_url: string;
}

interface V1AssetRow extends QueryResultRow {
  hash_sha256: string;
  storage_path: string;
  canonical_url: string | null;
}

interface V1ReferenceRow extends QueryResultRow {
  normalized_url: string;
  hash_sha256: string;
}

interface Asset {
  hash: string;
  storagePath: string;
  exists: boolean;
  contentAddressPathValid: boolean;
}

type AssetMap = Map<string, Map<string, Asset>>;

const v1 = new Pool({ connectionString: v1Url, max: 1 });
const v2 = new Pool({ connectionString: v2Url, max: 1 });

try {
  const [v2Snapshot, v1Snapshot] = await Promise.all([
    withRepeatableRead(v2, async (client) => ({
      transactionStartedAt: await transactionStartedAt(client),
      rows: (
        await client.query<V2UrlRow>(
          'SELECT DISTINCT normalized_url FROM meta.image_ingest_job ORDER BY normalized_url',
        )
      ).rows,
      jobCount: await scalarCount(client, 'SELECT count(*)::text AS n FROM meta.image_ingest_job'),
    })),
    withRepeatableRead(v1, async (client) => ({
      transactionStartedAt: await transactionStartedAt(client),
      assets: (
        await client.query<V1AssetRow>(
          `SELECT "hashSha256" AS hash_sha256,
                  "storagePath" AS storage_path,
                  "canonicalUrl" AS canonical_url
             FROM "ImageAsset"
            WHERE status = 'READY'
              AND "hashSha256" IS NOT NULL
              AND "storagePath" IS NOT NULL`,
        )
      ).rows,
      references: (
        await client.query<V1ReferenceRow>(
          `SELECT pvi."normalizedUrl" AS normalized_url,
                  asset."hashSha256" AS hash_sha256
             FROM "PageVersionImage" pvi
             JOIN "ImageAsset" asset ON asset.id = pvi."imageAssetId"
            WHERE asset.status = 'READY'
              AND asset."hashSha256" IS NOT NULL
              AND asset."storagePath" IS NOT NULL`,
        )
      ).rows,
      readyCount: await scalarCount(
        client,
        `SELECT count(*)::text AS n FROM "ImageAsset" WHERE status = 'READY'`,
      ),
      referenceCount: await scalarCount(
        client,
        `SELECT count(*)::text AS n FROM "PageVersionImage" WHERE "imageAssetId" IS NOT NULL`,
      ),
    })),
  ]);
  const v2Rows = v2Snapshot.rows;
  const v2JobCount = v2Snapshot.jobCount;
  const v1Assets = v1Snapshot.assets;
  const v1References = v1Snapshot.references;
  const v1ReadyCount = v1Snapshot.readyCount;
  const v1ReferenceCount = v1Snapshot.referenceCount;

  const assets = new Map<string, Asset>();
  for (const row of v1Assets) {
    assets.set(row.hash_sha256, {
      hash: row.hash_sha256,
      storagePath: row.storage_path,
      exists: false,
      contentAddressPathValid: storagePathMatchesHash(row.storage_path, row.hash_sha256),
    });
  }
  await mapWithConcurrency([...assets.values()], 64, async (asset) => {
    const absolute = path.resolve(V1_ASSET_ROOT, asset.storagePath);
    if (absolute !== V1_ASSET_ROOT && !absolute.startsWith(`${V1_ASSET_ROOT}${path.sep}`)) {
      throw new Error(`storagePath 越界：${asset.storagePath}`);
    }
    asset.exists = await stat(absolute).then((item) => item.isFile()).catch(() => false);
  });

  const canonicalExact: AssetMap = new Map();
  const canonicalNormalized: AssetMap = new Map();
  const referenceExact: AssetMap = new Map();
  const referenceNormalized: AssetMap = new Map();
  const normalizedRawSamples = new Map<string, Set<string>>();

  for (const row of v1Assets) {
    const asset = assets.get(row.hash_sha256)!;
    if (!asset.exists || row.canonical_url === null) continue;
    addAsset(canonicalExact, row.canonical_url, asset);
    const normalized = normalizeV2(row.canonical_url);
    if (normalized !== null) {
      addAsset(canonicalNormalized, normalized, asset);
      addRaw(normalizedRawSamples, normalized, row.canonical_url);
    }
  }
  for (const row of v1References) {
    const asset = assets.get(row.hash_sha256);
    if (asset === undefined || !asset.exists) continue;
    addAsset(referenceExact, row.normalized_url, asset);
    const normalized = normalizeV2(row.normalized_url);
    if (normalized !== null) {
      addAsset(referenceNormalized, normalized, asset);
      addRaw(normalizedRawSamples, normalized, row.normalized_url);
    }
  }

  const urls = v2Rows.map((row) => row.normalized_url);
  const phaseMaps = [canonicalExact, canonicalNormalized, referenceExact, referenceNormalized];
  const phaseNames = [
    'image_asset_canonical_exact',
    'canonical_after_v2_normalization',
    'page_version_reference_exact',
    'reference_after_v2_normalization',
  ] as const;
  const cumulative = new Map<string, Asset>();
  const candidates = new Map<string, Map<string, Asset>>();
  const exclusiveAdds: Record<(typeof phaseNames)[number], number> = {
    image_asset_canonical_exact: 0,
    canonical_after_v2_normalization: 0,
    page_version_reference_exact: 0,
    reference_after_v2_normalization: 0,
  };
  const firstPhase = new Map<string, (typeof phaseNames)[number]>();

  for (let index = 0; index < phaseMaps.length; index++) {
    const phase = phaseMaps[index]!;
    const name = phaseNames[index]!;
    for (const url of urls) {
      const matched = phase.get(url);
      if (matched === undefined) continue;
      let all = candidates.get(url);
      if (all === undefined) {
        all = new Map();
        candidates.set(url, all);
      }
      for (const [hash, asset] of matched) all.set(hash, asset);
      if (!firstPhase.has(url)) {
        firstPhase.set(url, name);
        exclusiveAdds[name]++;
      }
    }
  }

  let grossReusable = 0;
  let safeReusable = 0;
  let ambiguous = 0;
  for (const url of urls) {
    const matched = candidates.get(url);
    if (matched === undefined || matched.size === 0) continue;
    grossReusable++;
    if (matched.size === 1) {
      safeReusable++;
      cumulative.set(url, matched.values().next().value!);
    } else {
      ambiguous++;
    }
  }

  const normalizationRuleCounts: Record<string, number> = {};
  for (const [url, phase] of firstPhase) {
    if (
      phase !== 'canonical_after_v2_normalization' &&
      phase !== 'reference_after_v2_normalization'
    ) continue;
    const raws = normalizedRawSamples.get(url) ?? new Set();
    const rules = new Set<string>();
    for (const raw of raws) {
      for (const rule of normalizationRules(raw, url)) rules.add(rule);
    }
    if (rules.size === 0) rules.add('url_serialization_other');
    for (const rule of rules) {
      normalizationRuleCounts[rule] = (normalizationRuleCounts[rule] ?? 0) + 1;
    }
  }

  const unmatchedHosts = new Map<string, number>();
  for (const url of urls) {
    if (candidates.has(url)) continue;
    const host = safeHost(url);
    unmatchedHosts.set(host, (unmatchedHosts.get(host) ?? 0) + 1);
  }

  const output = {
    analyzedAt: new Date().toISOString(),
    snapshots: {
      v1TransactionStartedAt: v1Snapshot.transactionStartedAt,
      v2TransactionStartedAt: v2Snapshot.transactionStartedAt,
    },
    denominator: {
      v2Jobs: v2JobCount,
      v2UniqueNormalizedUrls: urls.length,
    },
    v1: {
      readyAssetsReported: v1ReadyCount,
      readyAssetsWithHashAndPath: v1Assets.length,
      resolvedReferencesReported: v1ReferenceCount,
      resolvedReferenceRowsLoaded: v1References.length,
      assetFilesPresent: [...assets.values()].filter((asset) => asset.exists).length,
      assetFilesMissing: [...assets.values()].filter((asset) => !asset.exists).length,
      contentAddressPathsValid: [...assets.values()].filter(
        (asset) => asset.contentAddressPathValid,
      ).length,
      contentAddressPathsInvalid: [...assets.values()].filter(
        (asset) => !asset.contentAddressPathValid,
      ).length,
    },
    matching: {
      exclusiveAdds,
      grossReusable,
      grossReuseRate: grossReusable / urls.length,
      safeReusable,
      safeReuseRate: safeReusable / urls.length,
      ambiguousMultipleSha: ambiguous,
      unmatched: urls.length - grossReusable,
    },
    normalizationRuleCounts,
    unmatchedTopHosts: [...unmatchedHosts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 15)
      .map(([host, count]) => ({ host, count })),
  };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
} finally {
  await Promise.all([v1.end(), v2.end()]);
}

async function withRepeatableRead<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const result = await fn(client);
    await client.query('ROLLBACK');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function scalarCount(client: PoolClient, sql: string): Promise<number> {
  const result = await client.query<{ n: string }>(sql);
  return Number(result.rows[0]?.n ?? 0);
}

async function transactionStartedAt(client: PoolClient): Promise<string> {
  const result = await client.query<{ started_at: string }>(
    `SELECT transaction_timestamp()::text AS started_at`,
  );
  return result.rows[0]?.started_at ?? '(unknown)';
}

function replaceDatabaseName(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

function normalizeV2(raw: string): string | null {
  return normalizeImageUrl(raw, {
    pageUrl: 'https://scp-wiki-cn.wikidot.com/',
    slug: '_image-reuse-analysis',
    source: 'wikidot_url',
  })?.normalizedUrl ?? null;
}

function addAsset(map: AssetMap, key: string, asset: Asset): void {
  let byHash = map.get(key);
  if (byHash === undefined) {
    byHash = new Map();
    map.set(key, byHash);
  }
  byHash.set(asset.hash, asset);
}

function addRaw(map: Map<string, Set<string>>, key: string, raw: string): void {
  let values = map.get(key);
  if (values === undefined) {
    values = new Set();
    map.set(key, values);
  }
  if (values.size < 20) values.add(raw);
}

function normalizationRules(raw: string, normalized: string): string[] {
  const rules: string[] = [];
  if (/^http:\/\//i.test(raw) || raw.startsWith('//')) rules.push('http_or_protocol_relative_to_https');
  if (/[?#]/.test(raw)) rules.push('query_or_fragment_removed');
  if (/:80(?:\/|$)|:443(?:\/|$)/i.test(raw)) rules.push('default_port_removed');
  if (/\/{2,}/.test(raw.replace(/^https?:\/\//i, ''))) rules.push('duplicate_path_slashes_collapsed');
  if (/%3a|%2f/i.test(raw)) rules.push('wdfiles_encoded_colon_or_slash_decoded');
  if (/\.wikidot\.com/i.test(raw) && /\.wdfiles\.com/i.test(normalized)) {
    rules.push('wikidot_local_files_host_to_wdfiles');
  }
  if (raw !== raw.toLowerCase()) rules.push('host_or_path_case_folded');
  if (!/^(?:https?:)?\/\//i.test(raw)) rules.push('relative_or_bare_host_resolved');
  return rules;
}

function storagePathMatchesHash(storagePath: string, hash: string): boolean {
  const parts = storagePath.split('/');
  const filename = parts.at(-1)?.split('.')[0] ?? '';
  return parts[0] === hash.slice(0, 2)
    && parts[1] === hash.slice(2, 4)
    && parts[2] === hash.slice(4, 6)
    && filename === hash;
}

function safeHost(raw: string): string {
  try {
    return new URL(raw).hostname.toLowerCase();
  } catch {
    return '(invalid)';
  }
}
