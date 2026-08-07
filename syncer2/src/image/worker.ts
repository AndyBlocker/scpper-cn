/**
 * v2 图片资产 worker。复用 v1 的认领/校验/SHA-256/原子写盘/退避状态机，
 * 但以 v2 的 (page_id, normalized_url) 引用键和 bytea hash 资产表重写。
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Pool } from 'pg';

import {
  CircuitOpenError,
  HttpClient,
  HttpStatusError,
  TransportError,
  type HttpResponse,
} from '../http/client.js';
import { query, withTransaction } from '../store/db.js';
import { toPgJson } from '../store/pgText.js';

export type ImageEgressClass = 'wikidot_site' | 'external';
export type ImageFailureClass =
  | 'http_transient'
  | 'http_permanent'
  | 'timeout'
  | 'network'
  | 'too_large'
  | 'invalid_content_type'
  | 'invalid_url'
  | 'blocked_host'
  | 'storage'
  | 'unknown';

export interface ClaimedImageJob {
  id: number;
  pageId: number;
  normalizedUrl: string;
  displayUrl: string;
  attempts: number;
}

export interface ImageDownloadClients {
  /** 必须由调用方配置 PostgresAdaptiveEgressGate；站内请求计入全站 Wikidot 健康度。 */
  wikidot: Pick<HttpClient, 'get'>;
  /** 无 adaptive gate 的独立低速 client；其统计不得合入 Wikidot health。 */
  external: Pick<HttpClient, 'get'>;
}

export interface ImageWorkerOptions {
  siteHost: string;
  assetRoot: string;
  maxBytes: number;
  maxAttempts: number;
  allowedHosts: readonly string[];
  blockedHosts: readonly string[];
  retryBaseMs: number;
  retryMaxMs: number;
}

export interface ProcessImageResult {
  status: 'completed' | 'retry' | 'failed';
  egressClass: ImageEgressClass;
  failureClass: ImageFailureClass | null;
  bytes: number;
  hashHex: string | null;
}

class ImageValidationError extends Error {
  constructor(
    message: string,
    readonly failureClass: ImageFailureClass,
    readonly permanent: boolean,
  ) {
    super(message);
  }
}

export function classifyImageEgress(url: string, siteHost: string): ImageEgressClass {
  const host = new URL(url).hostname.toLowerCase();
  return host === siteHost.toLowerCase() ? 'wikidot_site' : 'external';
}

export function hostMatchesPattern(host: string, pattern: string): boolean {
  const normalized = pattern.trim().toLowerCase();
  if (normalized === '*') return true;
  if (normalized.startsWith('*.')) {
    return host === normalized.slice(2) || host.endsWith(normalized.slice(1));
  }
  return host === normalized;
}

export function imageHostAllowed(
  url: string,
  allowedHosts: readonly string[],
  blockedHosts: readonly string[],
): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (isPrivateLiteralHost(host)) return false;
  if (blockedHosts.some((pattern) => hostMatchesPattern(host, pattern))) return false;
  return allowedHosts.some((pattern) => hostMatchesPattern(host, pattern));
}

function isPrivateLiteralHost(host: string): boolean {
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (/^(?:127\.|10\.|0\.|169\.254\.|192\.168\.)/.test(host)) return true;
  const match = /^172\.(\d+)\./.exec(host);
  if (match && Number(match[1]) >= 16 && Number(match[1]) <= 31) return true;
  return host === '::1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80:');
}

export async function claimNextImageJob(
  pool: Pool,
  workerId: string,
  lockStaleAfterMs = 30 * 60_000,
): Promise<ClaimedImageJob | null> {
  return withTransaction(pool, 'image:claim', async (db) => {
    const result = await query<{
      id: string;
      page_id: number;
      normalized_url: string;
      display_url: string;
      attempts: number;
    }>(
      db,
      'image:claim_next',
      `WITH picked AS (
         SELECT job.id
           FROM meta.image_ingest_job job
           JOIN serve.page_image image
             ON image.page_id = job.page_id
            AND image.normalized_url = job.normalized_url
          WHERE (
                  job.status = 'pending'
                  OR (job.status = 'failed' AND job.not_before IS NOT NULL)
                )
            AND (job.not_before IS NULL OR job.not_before <= now())
            AND (
              job.locked_by IS NULL
              OR job.locked_at < now() - ($2::bigint || ' milliseconds')::interval
            )
            AND image.asset_sha IS NULL
          ORDER BY job.not_before NULLS FIRST, job.id
          LIMIT 1
          FOR UPDATE OF job SKIP LOCKED
       )
       UPDATE meta.image_ingest_job job
          SET status = 'processing',
              locked_by = $1,
              locked_at = now(),
              attempts = job.attempts + 1,
              updated_at = now()
         FROM picked, serve.page_image image
        WHERE job.id = picked.id
          AND image.page_id = job.page_id
          AND image.normalized_url = job.normalized_url
        RETURNING job.id::text, job.page_id, job.normalized_url,
                  image.display_url, job.attempts`,
      [workerId, String(lockStaleAfterMs)],
    );
    const row = result.rows[0];
    return row === undefined
      ? null
      : {
          id: Number(row.id),
          pageId: Number(row.page_id),
          normalizedUrl: row.normalized_url,
          displayUrl: row.display_url,
          attempts: Number(row.attempts),
        };
  });
}

export async function processImageJob(
  pool: Pool,
  job: ClaimedImageJob,
  clients: ImageDownloadClients,
  options: ImageWorkerOptions,
): Promise<ProcessImageResult> {
  let egressClass: ImageEgressClass;
  try {
    egressClass = classifyImageEgress(job.displayUrl, options.siteHost);
  } catch {
    egressClass = 'external';
    return failJob(pool, job, egressClass,
      new ImageValidationError('图片 URL 非法', 'invalid_url', true), options);
  }
  if (!imageHostAllowed(job.displayUrl, options.allowedHosts, options.blockedHosts)) {
    return failJob(pool, job, egressClass,
      new ImageValidationError(`图片 host 不在 allowlist: ${safeHost(job.displayUrl)}`, 'blocked_host', true),
      options);
  }

  // 同一 normalized URL 常被多页引用；首个引用已解析后直接复用资产，不再重复下载。
  // 数据库异常不伪装成图片失败：这里及最终提交都在 HTTP catch 之外，交 CLI 非零退出。
  const known = await query<{ asset_sha: Buffer }>(
    pool,
    'image:known_asset_for_url',
    `SELECT pi.asset_sha
       FROM serve.page_image pi
       JOIN serve.image_asset asset ON asset.hash_sha256 = pi.asset_sha
      WHERE pi.normalized_url = $1
        AND pi.asset_sha IS NOT NULL
        AND asset.status = 'ready'
      ORDER BY pi.last_fetched_at DESC NULLS LAST
      LIMIT 1`,
    [job.normalizedUrl],
  );
  const knownHash = known.rows[0]?.asset_sha;
  if (knownHash !== undefined) {
    await resolveImageReference(pool, job, egressClass, knownHash, true);
    return {
      status: 'completed',
      egressClass,
      failureClass: null,
      bytes: 0,
      hashHex: knownHash.toString('hex'),
    };
  }

  let response: HttpResponse;
  let contentType: string;
  try {
    const client = egressClass === 'wikidot_site' ? clients.wikidot : clients.external;
    response = await client.get(job.displayUrl, `image:${egressClass}`, {
      headers: { accept: 'image/*' },
      maxAttempts: 5,
      maxRedirections: 3,
      redirectPolicy: egressClass === 'wikidot_site' ? 'same-host' : 'any',
    });
    contentType = normalizedContentType(response);
    if (!contentType.startsWith('image/')) {
      throw new ImageValidationError(
        `非图片 content-type: ${contentType || '(missing)'}`,
        'invalid_content_type',
        true,
      );
    }
    if (response.body.length > options.maxBytes) {
      throw new ImageValidationError(
        `图片超过 ${options.maxBytes} bytes: ${response.body.length}`,
        'too_large',
        true,
      );
    }
  } catch (error) {
    return failJob(pool, job, egressClass, normalizeFailure(error), options);
  }

  const hash = createHash('sha256').update(response.body).digest();
  const hashHex = hash.toString('hex');
  const extension = extensionFor(contentType);
  const existing = await query<{ storage_path: string | null }>(
    pool,
    'image:existing_asset_path',
    `SELECT storage_path FROM serve.image_asset WHERE hash_sha256 = $1`,
    [hash],
  );
  const relativePath = existing.rows[0]?.storage_path ?? assetRelativePath(hashHex, extension);
  try {
    await storeAssetBuffer(options.assetRoot, relativePath, response.body);
  } catch (error) {
    return failJob(pool, job, egressClass, normalizeFailure(error), options);
  }
  const dimensions = imageDimensions(response.body, contentType);
  await storeImageSuccess(
    pool,
    job,
    egressClass,
    hash,
    relativePath,
    contentType,
    response.body.length,
    dimensions,
  );
  return {
    status: 'completed',
    egressClass,
    failureClass: null,
    bytes: response.body.length,
    hashHex,
  };
}

async function failJob(
  pool: Pool,
  job: ClaimedImageJob,
  egressClass: ImageEgressClass,
  error: ImageValidationError,
  options: ImageWorkerOptions,
): Promise<ProcessImageResult> {
  const exhausted = job.attempts >= options.maxAttempts;
  const permanent = error.permanent || exhausted;
  const backoffMs = Math.min(
    options.retryMaxMs,
    options.retryBaseMs * (2 ** Math.max(0, job.attempts - 1)),
  );
  await withTransaction(pool, `image:failure:${job.id}`, async (db) => {
    await query(
      db,
      'image:page_failure',
      `UPDATE serve.page_image
          SET status = 'failed',
              failure_count = failure_count + 1,
              last_fetched_at = now(),
              last_error = $3,
              metadata = COALESCE(metadata, '{}'::jsonb) || $4::jsonb
        WHERE page_id = $1 AND normalized_url = $2`,
      [
        job.pageId,
        job.normalizedUrl,
        error.message.slice(0, 4_000),
        toPgJson({
          last_failure_class: error.failureClass,
          egress_class: egressClass,
          attempts: job.attempts,
        }, `image.failure:${job.id}`),
      ],
    );
    await query(
      db,
      'image:job_failure',
      `UPDATE meta.image_ingest_job
          SET status = $3,
              not_before = CASE WHEN $4::boolean
                                THEN NULL
                                ELSE now() + ($5::bigint || ' milliseconds')::interval END,
              failure_class = $6,
              egress_class = $7,
              error = $8,
              locked_by = NULL,
              locked_at = NULL,
              updated_at = now()
        WHERE id = $1 AND page_id = $2`,
      [
        job.id,
        job.pageId,
        permanent ? 'failed' : 'pending',
        permanent,
        String(backoffMs),
        error.failureClass,
        egressClass,
        error.message.slice(0, 4_000),
      ],
    );
  });
  return {
    status: permanent ? 'failed' : 'retry',
    egressClass,
    failureClass: error.failureClass,
    bytes: 0,
    hashHex: null,
  };
}

async function storeImageSuccess(
  pool: Pool,
  job: ClaimedImageJob,
  egressClass: ImageEgressClass,
  hash: Buffer,
  relativePath: string,
  mime: string,
  bytes: number,
  dimensions: { width: number | null; height: number | null },
): Promise<void> {
  const host = safeHost(job.displayUrl);
  await withTransaction(pool, `image:success:${job.id}`, async (db) => {
    await query(
      db,
      'image:upsert_asset',
      `INSERT INTO serve.image_asset(
         hash_sha256, mime, bytes, width, height, storage_path, canonical_url,
         source_hosts, status, first_seen_at, last_fetched_at, error_message,
         created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, ARRAY[$8], 'ready', now(), now(), NULL, now(), now()
       )
       ON CONFLICT (hash_sha256) DO UPDATE
         SET mime = COALESCE(serve.image_asset.mime, EXCLUDED.mime),
             bytes = EXCLUDED.bytes,
             width = COALESCE(serve.image_asset.width, EXCLUDED.width),
             height = COALESCE(serve.image_asset.height, EXCLUDED.height),
             storage_path = COALESCE(serve.image_asset.storage_path, EXCLUDED.storage_path),
             canonical_url = COALESCE(serve.image_asset.canonical_url, EXCLUDED.canonical_url),
             source_hosts = ARRAY(
               SELECT DISTINCT h FROM unnest(serve.image_asset.source_hosts || EXCLUDED.source_hosts) h
             ),
             status = 'ready',
             last_fetched_at = now(),
             error_message = NULL,
             updated_at = now()`,
      [
        hash,
        mime,
        bytes,
        dimensions.width,
        dimensions.height,
        relativePath,
        job.displayUrl,
        host,
      ],
    );
    await resolveImageReferenceTx(db, job, egressClass, hash, false, host);
  });
}

async function resolveImageReference(
  pool: Pool,
  job: ClaimedImageJob,
  egressClass: ImageEgressClass,
  hash: Buffer,
  reusedByUrl: boolean,
): Promise<void> {
  await withTransaction(pool, `image:reuse:${job.id}`, async (db) => {
    await resolveImageReferenceTx(
      db,
      job,
      egressClass,
      hash,
      reusedByUrl,
      safeHost(job.displayUrl),
    );
  });
}

async function resolveImageReferenceTx(
  db: import('pg').PoolClient,
  job: ClaimedImageJob,
  egressClass: ImageEgressClass,
  hash: Buffer,
  reusedByUrl: boolean,
  host: string,
): Promise<void> {
  await query(
    db,
    'image:resolve_reference',
    `UPDATE serve.page_image
        SET status = 'resolved',
            asset_sha = $3,
            last_fetched_at = now(),
            failure_count = 0,
            last_error = NULL,
            metadata = COALESCE(metadata, '{}'::jsonb) || $4::jsonb
      WHERE page_id = $1 AND normalized_url = $2`,
    [
      job.pageId,
      job.normalizedUrl,
      hash,
      toPgJson(
        { egress_class: egressClass, source_host: host, reused_by_normalized_url: reusedByUrl },
        `image.resolve:${job.id}`,
      ),
    ],
  );
  await query(
    db,
    'image:complete_job',
    `UPDATE meta.image_ingest_job
        SET status = 'completed', not_before = NULL, failure_class = NULL,
            egress_class = $3, error = NULL, locked_by = NULL, locked_at = NULL,
            updated_at = now()
      WHERE id = $1 AND page_id = $2`,
    [job.id, job.pageId, egressClass],
  );
}

function normalizedContentType(response: HttpResponse): string {
  return (response.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
}

function normalizeFailure(error: unknown): ImageValidationError {
  if (error instanceof ImageValidationError) return error;
  if (error instanceof HttpStatusError) {
    const transient = error.status === 408 || error.status === 429 || error.status >= 500;
    return new ImageValidationError(
      error.message,
      transient ? 'http_transient' : 'http_permanent',
      !transient,
    );
  }
  if (error instanceof TransportError) {
    return new ImageValidationError(
      error.message,
      error.kind === 'timeout' ? 'timeout' : 'network',
      false,
    );
  }
  if (error instanceof CircuitOpenError) {
    return new ImageValidationError(error.message, 'http_transient', false);
  }
  return new ImageValidationError(
    error instanceof Error ? error.message : String(error),
    'unknown',
    false,
  );
}

function extensionFor(mime: string): string {
  const known: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/svg+xml': 'svg',
    'image/avif': 'avif',
    'image/bmp': 'bmp',
    'image/x-icon': 'ico',
  };
  return known[mime] ?? 'bin';
}

function assetRelativePath(hashHex: string, extension: string): string {
  return path.join(hashHex.slice(0, 2), hashHex.slice(2, 4), hashHex.slice(4, 6), `${hashHex}.${extension}`);
}

async function storeAssetBuffer(root: string, relativePath: string, buffer: Buffer): Promise<void> {
  const finalPath = path.resolve(root, relativePath);
  const resolvedRoot = path.resolve(root);
  if (!finalPath.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new ImageValidationError('资产路径逃逸 asset root', 'storage', true);
  }
  try {
    await stat(finalPath);
    return;
  } catch {
    // 不存在才写；其它 I/O 错误会在后续 mkdir/write 暴露并分类。
  }
  await mkdir(path.dirname(finalPath), { recursive: true });
  const tempPath = `${finalPath}.tmp-${randomUUID()}`;
  try {
    await writeFile(tempPath, buffer, { flag: 'wx' });
    await rename(tempPath, finalPath);
  } catch (error) {
    // 并发写相同 hash 时，赢家已经落盘也算成功。
    try {
      await stat(finalPath);
      await unlink(tempPath).catch(() => undefined);
      return;
    } catch {
      await unlink(tempPath).catch(() => undefined);
      throw new ImageValidationError(
        `资产写盘失败: ${error instanceof Error ? error.message : String(error)}`,
        'storage',
        false,
      );
    }
  }
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return 'invalid';
  }
}

/** 无额外依赖的常见格式尺寸探测；未知/损坏格式保留 null，不阻断资产摄取。 */
export function imageDimensions(
  buffer: Buffer,
  mime: string,
): { width: number | null; height: number | null } {
  if (mime === 'image/png' && buffer.length >= 24 && buffer.subarray(1, 4).toString() === 'PNG') {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (mime === 'image/gif' && buffer.length >= 10) {
    return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
  }
  if (mime === 'image/jpeg') {
    for (let offset = 2; offset + 9 < buffer.length;) {
      if (buffer[offset] !== 0xff) break;
      const marker = buffer[offset + 1]!;
      const length = buffer.readUInt16BE(offset + 2);
      if (length < 2) break;
      if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) ||
          (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
        return { width: buffer.readUInt16BE(offset + 7), height: buffer.readUInt16BE(offset + 5) };
      }
      offset += 2 + length;
    }
  }
  return { width: null, height: null };
}
