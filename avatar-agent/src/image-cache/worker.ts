import { randomUUID, createHash } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import { URL } from 'node:url';
import path from 'node:path';
import fs from 'fs-extra';
import { imageSize } from 'image-size';
import type { SharpOptions } from 'sharp';
import { Pool, PoolClient } from 'pg';
import { fetch } from 'undici';
import mime from 'mime-types';

import { cfg } from '../config.js';
import { log } from '../logger.js';

const IMAGE_OK_STATUSES = new Set([200, 201, 202, 203, 206]);
const LOW_VARIANT_NAME = 'low';
const LOW_VARIANT_EXTENSION = 'webp';
const UNSUPPORTED_VARIANT_TYPES = new Set([
  'image/gif',
  'image/svg+xml'
]);

type SharpFactory = (input?: Buffer | ArrayBufferView | string, options?: SharpOptions) => import('sharp').Sharp;

let sharpFactory: SharpFactory | null = null;
let sharpLoadFailed = false;

type ClaimedJobRow = {
  id: number;
  pageVersionImageId: number;
  status: string;
  priority: number;
  attempts: number;
  displayUrl: string;
  originUrl: string;
  normalizedUrl: string;
  failureCount: number;
  pageVersionId: number;
  imageAssetId: number | null;
};

type DownloadResult = {
  buffer: Buffer;
  contentType: string;
  finalUrl: string;
  status: number;
};

type FailureOptions = {
  halt?: boolean;
  metadata?: Record<string, unknown>;
};

type TaggedError = Error & { halt?: boolean; status?: number };

function backoffDelay(attempts: number): number {
  const base = cfg.imageCache.retryBaseMs;
  const max = cfg.imageCache.retryMaxMs;
  const exp = Math.min(max, base * Math.pow(2, Math.max(0, attempts - 1)));
  return exp;
}

function resolveHost(url: string): string | null {
  try {
    const u = new URL(url);
    return u.host.toLowerCase();
  } catch {
    return null;
  }
}

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

function pickExtension(contentType: string | null, fallbackUrl: string): string {
  if (contentType) {
    const ext = mime.extension(contentType);
    if (ext) return ext;
  }
  const parsed = path.parse(new URLSafePath(fallbackUrl).pathname);
  if (parsed.ext) return parsed.ext.replace(/^\./, '');
  return 'bin';
}

async function loadSharp(): Promise<SharpFactory | null> {
  if (sharpFactory) return sharpFactory;
  if (sharpLoadFailed) return null;
  try {
    const mod = await import('sharp');
    const candidate = (mod as any).default ?? mod;
    sharpFactory = candidate as SharpFactory;
    return sharpFactory;
  } catch (err) {
    sharpLoadFailed = true;
    log.warn({ err }, 'sharp not available; skipping page image variants');
    return null;
  }
}

function buildVariantPath(baseRelativePath: string, variantName: string, extension: string): string {
  const parsed = path.parse(baseRelativePath);
  const fileName = `${parsed.name}-${variantName}.${extension}`;
  return path.join(parsed.dir, fileName);
}

function shouldSkipVariant(contentType: string, dimensions: { width: number | null; height: number | null }): boolean {
  const normalized = (contentType || '').toLowerCase();
  if (UNSUPPORTED_VARIANT_TYPES.has(normalized)) return true;
  if (dimensions.width != null && dimensions.width <= cfg.imageCache.variantMaxWidth) return true;
  return false;
}

async function maybeGenerateVariant(
  relativePath: string | null,
  download: DownloadResult,
  dimensions: { width: number | null; height: number | null }
): Promise<string | null> {
  if (!cfg.imageCache.variantEnabled) return null;
  if (!relativePath) return null;
  if (shouldSkipVariant(download.contentType, dimensions)) return null;

  const variantRelativePath = buildVariantPath(relativePath, LOW_VARIANT_NAME, LOW_VARIANT_EXTENSION);
  const absolutePath = path.join(cfg.imageCache.assetRoot, variantRelativePath);
  if (await fs.pathExists(absolutePath)) return variantRelativePath;

  const sharp = await loadSharp();
  if (!sharp) return null;

  await fs.ensureDir(path.dirname(absolutePath));
  const tempPath = `${absolutePath}.tmp-${randomUUID()}`;
  try {
    await sharp(download.buffer, { failOn: 'none' })
      .resize({
        width: cfg.imageCache.variantMaxWidth,
        withoutEnlargement: true,
        fit: 'inside'
      })
      .toFormat(LOW_VARIANT_EXTENSION, { quality: cfg.imageCache.variantQuality })
      .toFile(tempPath);

    await fs.move(tempPath, absolutePath, { overwrite: true });
    return variantRelativePath;
  } catch (err) {
    await fs.remove(tempPath).catch(() => {});
    log.warn({ err, variant: LOW_VARIANT_NAME, imagePath: relativePath }, 'failed to generate page image variant');
    return null;
  }
}

class URLSafePath {
  pathname: string;
  constructor(url: string) {
    try {
      const u = new URL(url);
      this.pathname = u.pathname;
    } catch {
      this.pathname = url;
    }
  }
}

async function ensureDirForHash(hash: string): Promise<string> {
  const segments = [hash.slice(0, 2), hash.slice(2, 4), hash.slice(4, 6)];
  const dir = path.join(cfg.imageCache.assetRoot, ...segments);
  await fs.ensureDir(dir);
  return dir;
}

async function storeAssetBuffer(hash: string, extension: string, buffer: Buffer, existingRelativePath: string | null): Promise<string> {
  const root = cfg.imageCache.assetRoot;
  if (existingRelativePath) {
    const absolute = path.join(root, existingRelativePath);
    await fs.ensureDir(path.dirname(absolute));
    if (!(await fs.pathExists(absolute))) {
      const tempPath = `${absolute}.tmp-${randomUUID()}`;
      await fs.writeFile(tempPath, buffer);
      await fs.move(tempPath, absolute, { overwrite: true });
    }
    return existingRelativePath;
  }

  const dir = await ensureDirForHash(hash);
  const fileName = `${hash}.${extension}`;
  const finalPath = path.join(dir, fileName);
  const tempPath = `${finalPath}.tmp-${randomUUID()}`;
  await fs.writeFile(tempPath, buffer);
  await fs.move(tempPath, finalPath, { overwrite: true });
  return path.relative(root, finalPath);
}

async function withClient<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

async function claimNextJob(pool: Pool, workerId: string): Promise<ClaimedJobRow | null> {
  return withClient(pool, async client => {
    await client.query('BEGIN');
    try {
      const select = await client.query<ClaimedJobRow>(`
        SELECT ij.id,
               ij."pageVersionImageId",
               ij.status,
               ij.priority,
               ij.attempts,
               pvi."displayUrl",
               pvi."originUrl",
               pvi."normalizedUrl",
               pvi."failureCount",
               pvi."pageVersionId",
               pvi."imageAssetId"
        FROM "ImageIngestJob" ij
        INNER JOIN "PageVersionImage" pvi ON pvi.id = ij."pageVersionImageId"
        WHERE ij.status = 'PENDING'
          AND ij."nextRunAt" <= NOW()
        ORDER BY ij.priority ASC, ij."nextRunAt" ASC, ij.id ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      `);

      if (select.rowCount === 0) {
        await client.query('ROLLBACK');
        return null;
      }

      const job = select.rows[0];
      await client.query(
        `UPDATE "ImageIngestJob"
         SET status = 'PROCESSING',
             "lockedAt" = NOW(),
             "lockedBy" = $1,
             attempts = attempts + 1,
             "updatedAt" = NOW()
         WHERE id = $2`,
        [workerId, job.id]
      );
      await client.query('COMMIT');
      job.attempts += 1;
      return job;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
}

function fatalError(message: string, status?: number): TaggedError {
  const err = new Error(message) as TaggedError;
  err.halt = true;
  if (status !== undefined) err.status = status;
  return err;
}

async function downloadImage(url: string): Promise<DownloadResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), cfg.imageCache.requestTimeoutMs);
  try {
    const resp = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': cfg.imageCache.userAgent,
        'Accept': 'image/*'
      }
    });

    if (resp.status === 404) {
      throw fatalError(`HTTP 404 Not Found`, 404);
    }

    if (!IMAGE_OK_STATUSES.has(resp.status)) {
      const err = new Error(`Unexpected status ${resp.status}`) as TaggedError;
      err.status = resp.status;
      throw err;
    }

    const lengthHeader = resp.headers.get('content-length');
    if (lengthHeader) {
      const length = Number(lengthHeader);
      if (!Number.isNaN(length) && length > cfg.imageCache.maxBytes) {
        throw new Error(`Image exceeds max bytes (${length} > ${cfg.imageCache.maxBytes})`);
      }
    }

    const contentTypeHeader = resp.headers.get('content-type');
    const normalizedContentType = contentTypeHeader
      ? contentTypeHeader.split(';')[0].trim().toLowerCase()
      : '';
    if (!normalizedContentType.startsWith('image/')) {
      throw fatalError(`Non-image content-type: ${contentTypeHeader ?? 'unknown'}`, resp.status);
    }

    const arrayBuffer = await resp.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    if (buffer.length > cfg.imageCache.maxBytes) {
      throw new Error(`Image exceeds max bytes (${buffer.length} > ${cfg.imageCache.maxBytes})`);
    }

    return {
      buffer,
      contentType: normalizedContentType,
      finalUrl: resp.url || url,
      status: resp.status
    };
  } finally {
    clearTimeout(timeout);
  }
}

function extractDimensions(buffer: Buffer): { width: number | null; height: number | null } {
  try {
    const info = imageSize(buffer);
    if (!info) return { width: null, height: null };
    return {
      width: info.width ?? null,
      height: info.height ?? null
    };
  } catch {
    return { width: null, height: null };
  }
}

async function storeSuccess(
  pool: Pool,
  job: ClaimedJobRow,
  hash: string,
  relativePath: string,
  download: DownloadResult,
  dimensions: { width: number | null; height: number | null },
  variantRelativePath: string | null
) {
  const host = resolveHost(download.finalUrl) ?? 'unknown';
  const metadata = {
    lastSuccessAt: new Date().toISOString(),
    lastSourceUrl: download.finalUrl,
    contentType: download.contentType,
    bytes: download.buffer.length,
    width: dimensions.width,
    height: dimensions.height,
    variantLowPath: variantRelativePath ?? undefined
  };

  await withClient(pool, async client => {
    await client.query('BEGIN');
    try {
      const existing = await client.query<{ id: number; storagePath: string | null }>(
        `SELECT id, "storagePath"
           FROM "ImageAsset"
          WHERE "hashSha256" = $1
          FOR UPDATE`,
        [hash]
      );

      let assetId: number;
      if (existing.rowCount === 0) {
        const inserted = await client.query<{ id: number }>(
          `INSERT INTO "ImageAsset" (
             "hashSha256", "perceptualHash", "mimeType", "width", "height", "bytes",
             "storagePath", "canonicalUrl", "sourceHosts", "status",
             "firstSeenAt", "lastFetchedAt", "errorMessage", "createdAt", "updatedAt"
           ) VALUES (
             $1, NULL, $2, $3, $4, $5,
             $6, $7, ARRAY[$8], 'READY',
             NOW(), NOW(), NULL, NOW(), NOW()
           ) RETURNING id`,
          [
            hash,
            download.contentType,
            dimensions.width,
            dimensions.height,
            download.buffer.length,
            relativePath,
            download.finalUrl,
            host
          ]
        );
        assetId = inserted.rows[0].id;
      } else {
        assetId = existing.rows[0].id;
        await client.query(
          `UPDATE "ImageAsset"
             SET "status" = 'READY',
                 "mimeType" = COALESCE($2, "mimeType"),
                 "width" = COALESCE($3, "width"),
                 "height" = COALESCE($4, "height"),
                 "bytes" = $5,
                 "storagePath" = COALESCE("storagePath", $6),
                 "canonicalUrl" = COALESCE("canonicalUrl", $7),
                 "sourceHosts" = (
                   SELECT ARRAY(SELECT DISTINCT unnest(COALESCE("sourceHosts", ARRAY[]::TEXT[]) || ARRAY[$8]))
                 ),
                 "lastFetchedAt" = NOW(),
                 "errorMessage" = NULL,
                 "updatedAt" = NOW()
           WHERE id = $1`,
          [
            assetId,
            download.contentType,
            dimensions.width,
            dimensions.height,
            download.buffer.length,
            relativePath,
            download.finalUrl,
            host
          ]
        );
      }

      await client.query(
        `UPDATE "PageVersionImage"
           SET "status" = 'RESOLVED',
               "imageAssetId" = $2,
               "lastFetchedAt" = NOW(),
               "failureCount" = 0,
               "lastError" = NULL,
               "metadata" = COALESCE("metadata", '{}'::jsonb) || $3::jsonb
         WHERE id = $1`,
        [job.pageVersionImageId, assetId, JSON.stringify(metadata)]
      );

      await client.query(
        `UPDATE "ImageIngestJob"
           SET status = 'COMPLETED',
               "lockedAt" = NULL,
               "lockedBy" = NULL,
               "nextRunAt" = NOW(),
               "updatedAt" = NOW()
         WHERE id = $1`,
        [job.id]
      );

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
}

async function storeFailure(
  pool: Pool,
  job: ClaimedJobRow,
  error: Error,
  options: FailureOptions = {}
) {
  const nowIso = new Date().toISOString();
  const metadata = {
    lastFailureAt: nowIso,
    lastError: error.message,
    ...(options.metadata ?? {})
  };

  await withClient(pool, async client => {
    await client.query('BEGIN');
    try {
      await client.query(
        `UPDATE "PageVersionImage"
           SET "status" = 'FAILED',
               "failureCount" = "failureCount" + 1,
               "lastError" = $2,
               "lastFetchedAt" = NOW(),
               "metadata" = COALESCE("metadata", '{}'::jsonb) || $3::jsonb
         WHERE id = $1`,
        [job.pageVersionImageId, error.message, JSON.stringify(metadata)]
      );

      if (options.halt) {
        await client.query(
          `UPDATE "ImageIngestJob"
             SET status = 'FAILED',
                 "lockedAt" = NULL,
                 "lockedBy" = NULL,
                 "nextRunAt" = NOW(),
                 "lastError" = $2,
                 "updatedAt" = NOW()
           WHERE id = $1`,
          [job.id, error.message]
        );
      } else {
        const delay = backoffDelay(job.attempts);
        await client.query(
          `UPDATE "ImageIngestJob"
             SET status = 'PENDING',
                 "lockedAt" = NULL,
                 "lockedBy" = NULL,
                 "nextRunAt" = NOW() + ($2 || ' milliseconds')::interval,
                 "lastError" = $3,
                 "updatedAt" = NOW()
           WHERE id = $1`,
          [job.id, delay.toString(), error.message]
        );
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  });
}

export class ImageCacheWorker {
  private pool: Pool | null = null;
  private running = false;
  private workerIds: string[] = [];
  private workerTasks: Promise<void>[] = [];

  async start() {
    if (!cfg.imageCache.enabled) {
      log.info('page image worker disabled');
      return;
    }
    if (!cfg.imageCache.databaseUrl) {
      log.warn('PAGE_IMAGE_DATABASE_URL not set; disabling page image worker');
      return;
    }

    await fs.ensureDir(cfg.imageCache.assetRoot);
    this.pool = new Pool({ connectionString: cfg.imageCache.databaseUrl, max: cfg.imageCache.concurrency });
    this.running = true;
    const concurrency = Math.max(1, cfg.imageCache.concurrency);
    this.workerIds = Array.from({ length: concurrency }, () => randomUUID());
    this.workerTasks = this.workerIds.map(id => this.loop(id));

    log.info({ concurrency }, 'page image worker started');
  }

  async stop() {
    this.running = false;
    if (this.workerTasks.length > 0) {
      await Promise.allSettled(this.workerTasks);
    }
    this.workerTasks = [];
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
    log.info('page image worker stopped');
  }

  private async loop(workerId: string) {
    while (this.running && this.pool) {
      try {
        const job = await claimNextJob(this.pool, workerId);
        if (!job) {
          await wait(cfg.imageCache.idleDelayMs);
          continue;
        }

        log.info({ workerId, imageId: job.pageVersionImageId, url: job.displayUrl }, 'processing page image');
        try {
          const download = await downloadImage(job.displayUrl);
          const hash = sha256(download.buffer);
          const extension = pickExtension(download.contentType, download.finalUrl);
          const dimensions = extractDimensions(download.buffer);
          const assetExists = await this.assetExists(hash);
          const relativePath = await storeAssetBuffer(hash, extension, download.buffer, assetExists?.storagePath ?? null);
          const variantRelativePath = await maybeGenerateVariant(relativePath, download, dimensions);

          await storeSuccess(this.pool, job, hash, relativePath, download, dimensions, variantRelativePath);
          await wait(cfg.imageCache.fetchDelayMs);
        } catch (err) {
          const errorObject = err instanceof Error ? err : new Error('Unknown error');
          const halt = (errorObject as TaggedError).halt === true;
          const status = (errorObject as TaggedError).status;
          const metadata: Record<string, unknown> = {};
          if (typeof status === 'number') metadata.httpStatus = status;
          const logPayload = { workerId, imageId: job.pageVersionImageId, err: errorObject, halt };
          if (halt) {
            log.warn(logPayload, 'page image fetch failed permanently');
          } else {
            log.warn(logPayload, 'page image fetch failed, will retry');
          }
          await storeFailure(this.pool, job, errorObject, { halt, metadata });
          await wait(cfg.imageCache.fetchDelayMs);
        }
      } catch (error) {
        log.error({ workerId, error }, 'image worker loop error');
        await wait(cfg.imageCache.idleDelayMs);
      }
    }
  }

  private async assetExists(hash: string): Promise<{ storagePath: string | null } | null> {
    if (!this.pool) return null;
    return withClient(this.pool, async client => {
      const res = await client.query<{ storagePath: string | null }>(
        'SELECT "storagePath" FROM "ImageAsset" WHERE "hashSha256" = $1',
        [hash]
      );
      if (res.rowCount === 0) return null;
      return res.rows[0];
    });
  }
}

export async function startImageCacheWorker(): Promise<ImageCacheWorker> {
  const worker = new ImageCacheWorker();
  await worker.start();
  return worker;
}
