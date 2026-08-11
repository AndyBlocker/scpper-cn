/**
 * v1 ImageAsset → v2 内容寻址资产导入。
 *
 * v1 连接由 URL 参数、连接 options、服务端 session 和 READ ONLY 事务四层锁死；
 * v2 写入先落 0055 schema，再以 SHA 为幂等键 upsert。文件失败不会被丢弃：元数据仍迁移，
 * 但资产在 v2 标为 failed 并带稳定 failure class，因而绝不会被免下载复用。
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { Client, Pool, type PoolClient, type QueryResultRow } from 'pg';

import { normalizeImageUrl } from '../content/extractImages.js';
import { SHARED_IMAGE_ASSET_ROOT } from './config.js';
import {
  assertDatabaseNames,
  assertV1SessionReadOnly,
  createV1ReadOnlyClient,
} from '../migrate/viewEvents.js';
import { query } from '../store/db.js';
import { toPgJson } from '../store/pgText.js';
import { chunk, mapWithConcurrency } from '../util/concurrency.js';

export { SHARED_IMAGE_ASSET_ROOT } from './config.js';

export type V1AssetFileFailureClass =
  | 'invalid_sha256'
  | 'invalid_storage_path'
  | 'file_missing'
  | 'not_regular_file'
  | 'byte_count_mismatch'
  | 'sha256_mismatch'
  | 'file_io';

interface V1AssetRow extends QueryResultRow {
  v1_id: number;
  hash_sha256: string | null;
  perceptual_hash: string | null;
  mime: string | null;
  width: number | null;
  height: number | null;
  bytes: number | null;
  storage_path: string | null;
  canonical_url: string | null;
  source_hosts: string[];
  first_seen_at: string;
  last_fetched_at: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

interface V1ReferenceRow extends QueryResultRow {
  v1_asset_id: number;
  normalized_url: string;
  first_seen_at: string;
}

export interface V1AssetFileVerification {
  status: 'ready' | 'failed' | 'unimportable';
  failureClass: V1AssetFileFailureClass | null;
  detail: string | null;
  actualBytes: number | null;
  actualSha256: string | null;
}

interface ImportAsset {
  v1Id: number;
  hashSha256: string;
  perceptualHash: string | null;
  mime: string | null;
  width: number | null;
  height: number | null;
  bytes: number | null;
  storagePath: string | null;
  canonicalUrl: string | null;
  sourceHosts: string[];
  status: 'ready' | 'failed';
  firstSeenAt: string;
  lastFetchedAt: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  verification: V1AssetFileVerification;
}

interface ImportAlias {
  normalizedUrl: string;
  assetSha: string;
  source: 'v1_canonical' | 'v1_page_version';
  sourceUrl: string;
  firstSeenAt: string;
}

export interface V1ImageImportReport {
  sourceSnapshotAt: string;
  v1ReadOnly: {
    database: string;
    defaultTransactionReadOnly: 'on';
    transactionReadOnly: 'on';
    writeProbeSqlstate: '25006';
  };
  source: {
    readyMetadataRows: number;
    referenceRows: number;
  };
  metadata: {
    importedRows: number;
    readyRows: number;
    failedRows: number;
    unimportableRows: number;
    failureClasses: Partial<Record<V1AssetFileFailureClass, number>>;
    failureSamples: Array<{ v1Id: number; hashSha256: string | null; failureClass: string; detail: string }>;
  };
  aliases: {
    importedRows: number;
    invalidUrlRows: number;
    invalidUrlSamples: string[];
  };
  reuse: {
    denominatorUniqueUrls: number;
    safeUniqueUrls: number;
    safeReuseRate: number;
    ambiguousMultipleSha: number;
    needDownloadUniqueUrls: number;
    needDownloadExternal: number;
    needDownloadWikidotSite: number;
    resolvedReferenceRows: number;
    completedJobs: number;
    pendingJobs: number;
  };
  write: {
    assetRowsTouched: number;
    aliasRowsTouched: number;
    referenceRowsResolvedThisRun: number;
    jobsCompletedThisRun: number;
  };
  estimatedDownloadSeconds: number;
}

export interface V1ImageImportOptions {
  v1DatabaseUrl: string;
  v2DatabaseUrl: string;
  assetRoot?: string;
  verifyConcurrency?: number;
  externalIntervalMs?: number;
  wikidotIntervalMs?: number;
  onProgress?: (completed: number, total: number) => void;
}

/** 真实读文件并核对内容地址；worker 的命中快路径也使用同一套 SHA 口径。 */
export async function verifyV1AssetFile(
  row: Pick<V1AssetRow, 'hash_sha256' | 'storage_path' | 'bytes'>,
  assetRoot: string,
): Promise<V1AssetFileVerification> {
  const hash = row.hash_sha256?.trim().toLowerCase() ?? '';
  if (!/^[0-9a-f]{64}$/.test(hash)) {
    return failedVerification('unimportable', 'invalid_sha256', `非法 SHA256: ${hash || '(null)'}`);
  }
  if (row.storage_path === null || !storagePathMatchesHash(row.storage_path, hash)) {
    return failedVerification(
      'failed',
      'invalid_storage_path',
      `storagePath 与 SHA 不一致: ${row.storage_path ?? '(null)'}`,
    );
  }
  let absolute: string;
  try {
    absolute = resolveInsideRoot(assetRoot, row.storage_path);
  } catch (error) {
    return failedVerification('failed', 'invalid_storage_path', String(error));
  }
  try {
    const file = await stat(absolute);
    if (!file.isFile()) {
      return failedVerification('failed', 'not_regular_file', `${row.storage_path} 不是普通文件`);
    }
    if (row.bytes !== null && file.size !== row.bytes) {
      return {
        ...failedVerification(
          'failed',
          'byte_count_mismatch',
          `数据库 bytes=${row.bytes}，文件 bytes=${file.size}`,
        ),
        actualBytes: file.size,
      };
    }
    const actualSha256 = await sha256File(absolute);
    if (actualSha256 !== hash) {
      return {
        ...failedVerification(
          'failed',
          'sha256_mismatch',
          `期望 ${hash}，文件为 ${actualSha256}`,
        ),
        actualBytes: file.size,
        actualSha256,
      };
    }
    return {
      status: 'ready',
      failureClass: null,
      detail: null,
      actualBytes: file.size,
      actualSha256,
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return failedVerification(
      'failed',
      code === 'ENOENT' ? 'file_missing' : 'file_io',
      error instanceof Error ? error.message : String(error),
    );
  }
}

export async function runV1ImageAssetImport(
  options: V1ImageImportOptions,
): Promise<V1ImageImportReport> {
  const assetRoot = path.resolve(options.assetRoot ?? SHARED_IMAGE_ASSET_ROOT);
  const verifyConcurrency = Math.max(1, Math.min(options.verifyConcurrency ?? 4, 32));
  assertDatabaseNames(options.v1DatabaseUrl, options.v2DatabaseUrl);

  const source = createV1ReadOnlyClient(options.v1DatabaseUrl);
  const targetPool = new Pool({
    connectionString: options.v2DatabaseUrl,
    max: 1,
    idleTimeoutMillis: 5_000,
    connectionTimeoutMillis: 10_000,
    application_name: 'syncer2-v1-image-import-v2',
    options: '-c statement_timeout=0',
  });
  try {
    await source.connect();
    await assertV1SessionReadOnly(source);
    const writeProbeSqlstate = await verifyV1WriteRejected(source);
    const snapshot = await loadV1Snapshot(source);
    await assertTargetSchema(targetPool);

    let verified = 0;
    const verifications = await mapWithConcurrency(snapshot.assets, verifyConcurrency, async (row) => {
      const result = await verifyV1AssetFile(row, assetRoot);
      verified++;
      if (verified === snapshot.assets.length || verified % 1_000 === 0) {
        options.onProgress?.(verified, snapshot.assets.length);
      }
      return result;
    });

    const failureClasses: Partial<Record<V1AssetFileFailureClass, number>> = {};
    const failureSamples: V1ImageImportReport['metadata']['failureSamples'] = [];
    const assets: ImportAsset[] = [];
    const assetsByV1Id = new Map<number, ImportAsset>();
    let unimportableRows = 0;
    for (let index = 0; index < snapshot.assets.length; index++) {
      const row = snapshot.assets[index]!;
      const verification = verifications[index]!;
      if (verification.failureClass !== null) {
        failureClasses[verification.failureClass] = (failureClasses[verification.failureClass] ?? 0) + 1;
        if (failureSamples.length < 20) {
          failureSamples.push({
            v1Id: row.v1_id,
            hashSha256: row.hash_sha256,
            failureClass: verification.failureClass,
            detail: verification.detail ?? '(no detail)',
          });
        }
      }
      const normalizedHash = row.hash_sha256?.trim().toLowerCase() ?? '';
      if (verification.status === 'unimportable' || !/^[0-9a-f]{64}$/.test(normalizedHash)) {
        unimportableRows++;
        continue;
      }
      const asset: ImportAsset = {
        v1Id: row.v1_id,
        hashSha256: normalizedHash,
        perceptualHash: row.perceptual_hash,
        mime: row.mime,
        width: row.width,
        height: row.height,
        bytes: row.bytes,
        storagePath: row.storage_path,
        canonicalUrl: row.canonical_url,
        sourceHosts: row.source_hosts,
        status: verification.status,
        firstSeenAt: row.first_seen_at,
        lastFetchedAt: row.last_fetched_at,
        errorMessage: verification.failureClass === null
          ? row.error_message
          : `v1_import:${verification.failureClass}:${verification.detail ?? ''}`.slice(0, 4_000),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        verification,
      };
      assets.push(asset);
      assetsByV1Id.set(row.v1_id, asset);
    }

    const aliasResult = buildAliases(assets, snapshot.references, assetsByV1Id);
    const write = await applyImport(targetPool, assets, aliasResult.aliases);
    const reuse = await loadReuseReport(targetPool);
    const estimatedDownloadSeconds = Math.ceil(
      (
        reuse.needDownloadExternal * (options.externalIntervalMs ?? 1_000) +
        reuse.needDownloadWikidotSite * (options.wikidotIntervalMs ?? 7_200)
      ) / 1_000,
    );
    return {
      sourceSnapshotAt: snapshot.snapshotAt,
      v1ReadOnly: {
        database: 'scpper-cn',
        defaultTransactionReadOnly: 'on',
        transactionReadOnly: 'on',
        writeProbeSqlstate,
      },
      source: {
        readyMetadataRows: snapshot.assets.length,
        referenceRows: snapshot.references.length,
      },
      metadata: {
        importedRows: assets.length,
        readyRows: assets.filter((asset) => asset.status === 'ready').length,
        failedRows: assets.filter((asset) => asset.status === 'failed').length,
        unimportableRows,
        failureClasses,
        failureSamples,
      },
      aliases: {
        importedRows: aliasResult.aliases.length,
        invalidUrlRows: aliasResult.invalidUrlRows,
        invalidUrlSamples: aliasResult.invalidUrlSamples,
      },
      reuse,
      write,
      estimatedDownloadSeconds,
    };
  } finally {
    await source.end().catch(() => undefined);
    await targetPool.end().catch(() => undefined);
  }
}

export async function verifyV1WriteRejected(client: Client): Promise<'25006'> {
  try {
    // WHERE false 保证即使外层防线被误删也不会改变任何行；正确 session 会在执行前以
    // read_only_sql_transaction 拒绝该 UPDATE，这是报告中的数据库侧零写入证据。
    await client.query(`UPDATE "ImageAsset" SET "updatedAt" = "updatedAt" WHERE false`);
  } catch (error) {
    if ((error as { code?: string }).code === '25006') return '25006';
    throw new Error(`v1 写探针未按 25006 拒绝：${error instanceof Error ? error.message : String(error)}`);
  }
  throw new Error('v1 写探针未被拒绝；拒绝继续迁移');
}

async function loadV1Snapshot(source: Client): Promise<{
  snapshotAt: string;
  assets: V1AssetRow[];
  references: V1ReferenceRow[];
}> {
  await source.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    const snapshotAt = (
      await source.query<{ value: string }>(`SELECT transaction_timestamp()::text AS value`)
    ).rows[0]?.value ?? '(unknown)';
    const assets = (
      await source.query<V1AssetRow>(
        `SELECT id AS v1_id,
                "hashSha256" AS hash_sha256,
                "perceptualHash" AS perceptual_hash,
                "mimeType" AS mime,
                width, height, bytes,
                "storagePath" AS storage_path,
                "canonicalUrl" AS canonical_url,
                "sourceHosts" AS source_hosts,
                "firstSeenAt"::text AS first_seen_at,
                "lastFetchedAt"::text AS last_fetched_at,
                "errorMessage" AS error_message,
                "createdAt"::text AS created_at,
                "updatedAt"::text AS updated_at
           FROM "ImageAsset"
          WHERE status = 'READY'
          ORDER BY id`,
      )
    ).rows;
    const references = (
      await source.query<V1ReferenceRow>(
        `SELECT pvi."imageAssetId" AS v1_asset_id,
                pvi."normalizedUrl" AS normalized_url,
                pvi."extractedAt"::text AS first_seen_at
           FROM "PageVersionImage" pvi
           JOIN "ImageAsset" asset ON asset.id = pvi."imageAssetId"
          WHERE asset.status = 'READY'
          ORDER BY pvi."imageAssetId", pvi.id`,
      )
    ).rows;
    await source.query('ROLLBACK');
    return { snapshotAt, assets, references };
  } catch (error) {
    await source.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

function buildAliases(
  assets: readonly ImportAsset[],
  references: readonly V1ReferenceRow[],
  assetsByV1Id: ReadonlyMap<number, ImportAsset>,
): { aliases: ImportAlias[]; invalidUrlRows: number; invalidUrlSamples: string[] } {
  const aliases = new Map<string, ImportAlias>();
  const invalidUrlSamples: string[] = [];
  let invalidUrlRows = 0;
  const add = (
    raw: string,
    asset: ImportAsset,
    source: ImportAlias['source'],
    firstSeenAt: string,
  ): void => {
    const normalizedUrl = normalizeImportedUrl(raw);
    if (normalizedUrl === null) {
      invalidUrlRows++;
      if (invalidUrlSamples.length < 20) invalidUrlSamples.push(raw.slice(0, 500));
      return;
    }
    const key = `${normalizedUrl}\u0000${asset.hashSha256}\u0000${source}`;
    const current = aliases.get(key);
    const candidate: ImportAlias = {
      normalizedUrl,
      assetSha: asset.hashSha256,
      source,
      sourceUrl: raw,
      firstSeenAt,
    };
    if (
      current === undefined ||
      candidate.firstSeenAt < current.firstSeenAt ||
      (candidate.firstSeenAt === current.firstSeenAt && candidate.sourceUrl < current.sourceUrl)
    ) {
      aliases.set(key, candidate);
    }
  };
  for (const asset of assets) {
    if (asset.canonicalUrl !== null) {
      add(asset.canonicalUrl, asset, 'v1_canonical', asset.firstSeenAt);
    }
  }
  for (const reference of references) {
    const asset = assetsByV1Id.get(Number(reference.v1_asset_id));
    if (asset !== undefined) {
      add(reference.normalized_url, asset, 'v1_page_version', reference.first_seen_at);
    }
  }
  return {
    aliases: [...aliases.values()].sort((a, b) =>
      a.normalizedUrl.localeCompare(b.normalizedUrl) ||
      a.assetSha.localeCompare(b.assetSha) ||
      a.source.localeCompare(b.source)
    ),
    invalidUrlRows,
    invalidUrlSamples,
  };
}

function normalizeImportedUrl(raw: string): string | null {
  return normalizeImageUrl(raw, {
    pageUrl: 'https://scp-wiki-cn.wikidot.com/',
    slug: '_v1-image-import',
    source: 'wikidot_url',
  })?.normalizedUrl ?? null;
}

async function assertTargetSchema(pool: Pool): Promise<void> {
  const result = await query<{
    database: string;
    read_only: string;
    alias_table: string | null;
  }>(
    pool,
    'v1_image_import:target_guard',
    `SELECT current_database() AS database,
            current_setting('transaction_read_only') AS read_only,
            to_regclass('serve.image_asset_url_alias')::text AS alias_table`,
  );
  const row = result.rows[0];
  if (row?.database !== 'scpper-v2' || row.read_only !== 'off') {
    throw new Error(
      `v2 写入硬关卡失败：db=${row?.database ?? '<none>'}, read_only=${row?.read_only ?? '<none>'}`,
    );
  }
  if (row.alias_table !== 'serve.image_asset_url_alias') {
    throw new Error('缺少 0055_v1_image_asset_reuse.sql；迁移必须先于导入代码生效');
  }
}

async function applyImport(
  pool: Pool,
  assets: readonly ImportAsset[],
  aliases: readonly ImportAlias[],
): Promise<V1ImageImportReport['write']> {
  const client = await pool.connect();
  let assetRowsTouched = 0;
  let aliasRowsTouched = 0;
  try {
    await client.query('BEGIN');
    for (const batch of chunk(assets, 500)) {
      const result = await query(
        client,
        'v1_image_import:upsert_assets',
        `INSERT INTO serve.image_asset(
           hash_sha256, perceptual_hash, mime, bytes, width, height, storage_path,
           canonical_url, source_hosts, status, first_seen_at, last_fetched_at,
           error_message, created_at, updated_at
         )
         SELECT decode(x.hash_sha256, 'hex'), x.perceptual_hash, x.mime, x.bytes,
                x.width, x.height, x.storage_path, x.canonical_url,
                ARRAY(SELECT jsonb_array_elements_text(COALESCE(x.source_hosts, '[]'::jsonb))),
                x.status, x.first_seen_at::timestamptz, x.last_fetched_at::timestamptz,
                x.error_message, x.created_at::timestamptz, x.updated_at::timestamptz
           FROM jsonb_to_recordset($1::jsonb) AS x(
             hash_sha256 text, perceptual_hash text, mime text, bytes int, width int, height int,
             storage_path text, canonical_url text, source_hosts jsonb, status text,
             first_seen_at text, last_fetched_at text, error_message text,
             created_at text, updated_at text
           )
         ON CONFLICT (hash_sha256) DO UPDATE
           SET perceptual_hash = COALESCE(EXCLUDED.perceptual_hash, serve.image_asset.perceptual_hash),
               mime = COALESCE(EXCLUDED.mime, serve.image_asset.mime),
               bytes = COALESCE(EXCLUDED.bytes, serve.image_asset.bytes),
               width = COALESCE(EXCLUDED.width, serve.image_asset.width),
               height = COALESCE(EXCLUDED.height, serve.image_asset.height),
               storage_path = COALESCE(EXCLUDED.storage_path, serve.image_asset.storage_path),
               canonical_url = COALESCE(EXCLUDED.canonical_url, serve.image_asset.canonical_url),
               source_hosts = ARRAY(
                 SELECT DISTINCT host
                   FROM unnest(serve.image_asset.source_hosts || EXCLUDED.source_hosts) host
                  ORDER BY host
               ),
               status = CASE WHEN serve.image_asset.status = 'ready' THEN 'ready'
                             ELSE EXCLUDED.status END,
               first_seen_at = LEAST(serve.image_asset.first_seen_at, EXCLUDED.first_seen_at),
               last_fetched_at = GREATEST(
                 serve.image_asset.last_fetched_at, EXCLUDED.last_fetched_at
               ),
               error_message = CASE WHEN serve.image_asset.status = 'ready' THEN NULL
                                    ELSE EXCLUDED.error_message END,
               created_at = LEAST(serve.image_asset.created_at, EXCLUDED.created_at),
               updated_at = GREATEST(serve.image_asset.updated_at, EXCLUDED.updated_at)
         WHERE ROW(
                 serve.image_asset.perceptual_hash, serve.image_asset.mime,
                 serve.image_asset.bytes, serve.image_asset.width, serve.image_asset.height,
                 serve.image_asset.storage_path, serve.image_asset.canonical_url,
                 serve.image_asset.source_hosts, serve.image_asset.status,
                 serve.image_asset.first_seen_at, serve.image_asset.last_fetched_at,
                 serve.image_asset.error_message, serve.image_asset.created_at,
                 serve.image_asset.updated_at
               ) IS DISTINCT FROM ROW(
                 COALESCE(EXCLUDED.perceptual_hash, serve.image_asset.perceptual_hash),
                 COALESCE(EXCLUDED.mime, serve.image_asset.mime),
                 COALESCE(EXCLUDED.bytes, serve.image_asset.bytes),
                 COALESCE(EXCLUDED.width, serve.image_asset.width),
                 COALESCE(EXCLUDED.height, serve.image_asset.height),
                 COALESCE(EXCLUDED.storage_path, serve.image_asset.storage_path),
                 COALESCE(EXCLUDED.canonical_url, serve.image_asset.canonical_url),
                 ARRAY(
                   SELECT DISTINCT host
                     FROM unnest(serve.image_asset.source_hosts || EXCLUDED.source_hosts) host
                    ORDER BY host
                 ),
                 CASE WHEN serve.image_asset.status = 'ready' THEN 'ready'
                      ELSE EXCLUDED.status END,
                 LEAST(serve.image_asset.first_seen_at, EXCLUDED.first_seen_at),
                 GREATEST(serve.image_asset.last_fetched_at, EXCLUDED.last_fetched_at),
                 CASE WHEN serve.image_asset.status = 'ready' THEN NULL
                      ELSE EXCLUDED.error_message END,
                 LEAST(serve.image_asset.created_at, EXCLUDED.created_at),
                 GREATEST(serve.image_asset.updated_at, EXCLUDED.updated_at)
               )`,
        [toPgJson(batch.map(assetToJson), 'v1_image_import.assets')],
      );
      assetRowsTouched += result.rowCount ?? 0;
    }
    for (const batch of chunk(aliases, 1_000)) {
      const result = await query(
        client,
        'v1_image_import:upsert_aliases',
        `INSERT INTO serve.image_asset_url_alias(
           normalized_url, asset_sha, source, source_url, first_seen_at, created_at, updated_at
         )
         SELECT x.normalized_url, decode(x.asset_sha, 'hex'), x.source, x.source_url,
                x.first_seen_at::timestamptz, x.first_seen_at::timestamptz,
                x.first_seen_at::timestamptz
           FROM jsonb_to_recordset($1::jsonb) AS x(
             normalized_url text, asset_sha text, source text, source_url text, first_seen_at text
           )
         ON CONFLICT (normalized_url, asset_sha, source) DO UPDATE
           SET source_url = CASE
                 WHEN serve.image_asset_url_alias.source_url IS NULL THEN EXCLUDED.source_url
                 ELSE LEAST(serve.image_asset_url_alias.source_url, EXCLUDED.source_url)
               END,
               first_seen_at = LEAST(
                 serve.image_asset_url_alias.first_seen_at, EXCLUDED.first_seen_at
               ),
               updated_at = LEAST(
                 serve.image_asset_url_alias.updated_at, EXCLUDED.updated_at
               )
         WHERE ROW(
                 serve.image_asset_url_alias.source_url,
                 serve.image_asset_url_alias.first_seen_at,
                 serve.image_asset_url_alias.updated_at
               ) IS DISTINCT FROM ROW(
                 CASE
                   WHEN serve.image_asset_url_alias.source_url IS NULL THEN EXCLUDED.source_url
                   ELSE LEAST(serve.image_asset_url_alias.source_url, EXCLUDED.source_url)
                 END,
                 LEAST(serve.image_asset_url_alias.first_seen_at, EXCLUDED.first_seen_at),
                 LEAST(serve.image_asset_url_alias.updated_at, EXCLUDED.updated_at)
               )`,
        [toPgJson(batch.map(aliasToJson), 'v1_image_import.aliases')],
      );
      aliasRowsTouched += result.rowCount ?? 0;
    }

    const references = await query(
      client,
      'v1_image_import:resolve_references',
      `${uniqueReadyAliasCte()}
       UPDATE serve.page_image image
          SET asset_sha = unique_alias.asset_sha,
              status = 'resolved',
              last_fetched_at = now(),
              failure_count = 0,
              last_error = NULL,
              metadata = COALESCE(image.metadata, '{}'::jsonb) || jsonb_build_object(
                'reused_by_v1_import', true,
                'reuse_sha_verified', true,
                'reuse_normalization_version', 2
              )
         FROM unique_alias
        WHERE image.normalized_url = unique_alias.normalized_url
          AND image.asset_sha IS NULL`,
    );
    const jobs = await query(
      client,
      'v1_image_import:complete_jobs',
      `${uniqueReadyAliasCte()}
       UPDATE meta.image_ingest_job job
          SET status = 'completed',
              not_before = NULL,
              failure_class = NULL,
              egress_class = CASE
                WHEN job.normalized_url LIKE 'https://scp-wiki-cn.wikidot.com/%'
                  THEN 'wikidot_site'
                ELSE 'external'
              END,
              error = NULL,
              locked_by = NULL,
              locked_at = NULL,
              updated_at = now()
         FROM unique_alias
        WHERE job.normalized_url = unique_alias.normalized_url
          AND EXISTS (
            SELECT 1 FROM serve.page_image image
             WHERE image.page_id = job.page_id
               AND image.normalized_url = job.normalized_url
               AND image.asset_sha = unique_alias.asset_sha
          )
          AND job.status <> 'completed'`,
    );
    await client.query('COMMIT');
    return {
      assetRowsTouched,
      aliasRowsTouched,
      referenceRowsResolvedThisRun: references.rowCount ?? 0,
      jobsCompletedThisRun: jobs.rowCount ?? 0,
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function uniqueReadyAliasCte(): string {
  return `WITH candidates AS (
            SELECT DISTINCT alias.normalized_url, alias.asset_sha
              FROM serve.image_asset_url_alias alias
              JOIN serve.image_asset asset ON asset.hash_sha256 = alias.asset_sha
             WHERE asset.status = 'ready'
           ), unique_alias AS (
            SELECT normalized_url, (array_agg(asset_sha))[1] AS asset_sha
              FROM candidates
             GROUP BY normalized_url
            HAVING count(*) = 1
           )`;
}

async function loadReuseReport(pool: Pool): Promise<V1ImageImportReport['reuse']> {
  const result = await query<{
    denominator_unique_urls: string;
    safe_unique_urls: string;
    ambiguous_multiple_sha: string;
    need_download_unique_urls: string;
    need_download_external: string;
    need_download_wikidot_site: string;
    resolved_reference_rows: string;
    completed_jobs: string;
    pending_jobs: string;
  }>(
    pool,
    'v1_image_import:reuse_report',
    `WITH job_urls AS (
       SELECT DISTINCT normalized_url FROM meta.image_ingest_job
     ), candidates AS (
       SELECT DISTINCT alias.normalized_url, alias.asset_sha
         FROM serve.image_asset_url_alias alias
         JOIN serve.image_asset asset ON asset.hash_sha256 = alias.asset_sha
        WHERE asset.status = 'ready'
     ), counts AS (
       SELECT url.normalized_url, count(c.asset_sha)::int AS candidate_count
         FROM job_urls url
         LEFT JOIN candidates c USING (normalized_url)
        GROUP BY url.normalized_url
     ), unique_alias AS (
       SELECT normalized_url, (array_agg(asset_sha))[1] AS asset_sha
         FROM candidates
        GROUP BY normalized_url
       HAVING count(*) = 1
     )
     SELECT count(*)::text AS denominator_unique_urls,
            count(*) FILTER (WHERE candidate_count = 1)::text AS safe_unique_urls,
            count(*) FILTER (WHERE candidate_count > 1)::text AS ambiguous_multiple_sha,
            count(*) FILTER (WHERE candidate_count <> 1)::text AS need_download_unique_urls,
            count(*) FILTER (
              WHERE candidate_count <> 1
                AND normalized_url NOT LIKE 'https://scp-wiki-cn.wikidot.com/%'
            )::text AS need_download_external,
            count(*) FILTER (
              WHERE candidate_count <> 1
                AND normalized_url LIKE 'https://scp-wiki-cn.wikidot.com/%'
            )::text AS need_download_wikidot_site,
            (SELECT count(*)::text
               FROM serve.page_image image
               JOIN unique_alias alias USING (normalized_url)
              WHERE image.asset_sha = alias.asset_sha) AS resolved_reference_rows,
            (SELECT count(*)::text FROM meta.image_ingest_job WHERE status = 'completed')
              AS completed_jobs,
            (SELECT count(*)::text FROM meta.image_ingest_job WHERE status = 'pending')
              AS pending_jobs
       FROM counts`,
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('图片复用报告查询返回 0 行');
  const denominatorUniqueUrls = Number(row.denominator_unique_urls);
  const safeUniqueUrls = Number(row.safe_unique_urls);
  return {
    denominatorUniqueUrls,
    safeUniqueUrls,
    safeReuseRate: denominatorUniqueUrls === 0 ? 0 : safeUniqueUrls / denominatorUniqueUrls,
    ambiguousMultipleSha: Number(row.ambiguous_multiple_sha),
    needDownloadUniqueUrls: Number(row.need_download_unique_urls),
    needDownloadExternal: Number(row.need_download_external),
    needDownloadWikidotSite: Number(row.need_download_wikidot_site),
    resolvedReferenceRows: Number(row.resolved_reference_rows),
    completedJobs: Number(row.completed_jobs),
    pendingJobs: Number(row.pending_jobs),
  };
}

function assetToJson(asset: ImportAsset): Record<string, unknown> {
  return {
    hash_sha256: asset.hashSha256,
    perceptual_hash: asset.perceptualHash,
    mime: asset.mime,
    bytes: asset.bytes,
    width: asset.width,
    height: asset.height,
    storage_path: asset.storagePath,
    canonical_url: asset.canonicalUrl,
    source_hosts: asset.sourceHosts,
    status: asset.status,
    first_seen_at: asset.firstSeenAt,
    last_fetched_at: asset.lastFetchedAt,
    error_message: asset.errorMessage,
    created_at: asset.createdAt,
    updated_at: asset.updatedAt,
  };
}

function aliasToJson(alias: ImportAlias): Record<string, unknown> {
  return {
    normalized_url: alias.normalizedUrl,
    asset_sha: alias.assetSha,
    source: alias.source,
    source_url: alias.sourceUrl,
    first_seen_at: alias.firstSeenAt,
  };
}

function failedVerification(
  status: 'failed' | 'unimportable',
  failureClass: V1AssetFileFailureClass,
  detail: string,
): V1AssetFileVerification {
  return { status, failureClass, detail, actualBytes: null, actualSha256: null };
}

function resolveInsideRoot(root: string, relativePath: string): string {
  const resolvedRoot = path.resolve(root);
  const absolute = path.resolve(resolvedRoot, relativePath);
  if (absolute === resolvedRoot || !absolute.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`storagePath 越界 asset root: ${relativePath}`);
  }
  return absolute;
}

function storagePathMatchesHash(storagePath: string, hash: string): boolean {
  const normalized = storagePath.replaceAll('\\', '/');
  const parts = normalized.split('/');
  const filename = parts.at(-1)?.split('.')[0]?.toLowerCase() ?? '';
  return !path.isAbsolute(storagePath)
    && parts.length === 4
    && parts[0]?.toLowerCase() === hash.slice(0, 2)
    && parts[1]?.toLowerCase() === hash.slice(2, 4)
    && parts[2]?.toLowerCase() === hash.slice(4, 6)
    && filename === hash;
}

async function sha256File(filename: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const part of createReadStream(filename)) hash.update(part as Buffer);
  return hash.digest('hex');
}
