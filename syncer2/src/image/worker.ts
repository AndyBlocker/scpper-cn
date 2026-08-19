import { ExternalHostDeferredError } from './externalEgress.js';
/**
 * v2 图片资产 worker。复用 v1 的认领/校验/SHA-256/原子写盘/退避状态机，
 * 但以 v2 的 (page_id, normalized_url) 引用键和 bytea hash 资产表重写。
 */

import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, rename, stat, unlink } from 'node:fs/promises';
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
import { throwIfRuntimeBudgetExceeded } from '../util/runtimeBudget.js';
import { contentPrefixHex, sniffImageContent } from './contentValidation.js';
import {
  isWikimediaFileDescriptionUrl,
  resolveWikimediaOgImageUrl,
} from './descriptionPage.js';

export type ImageEgressClass = 'wikidot_site' | 'external';
export type ImageFailureClass =
  | 'http_transient'
  | 'http_permanent'
  | 'timeout'
  | 'network'
  | 'host_unresolvable'
  | 'host_deferred'
  | 'too_large'
  | 'invalid_content_type'
  | 'invalid_image_content'
  | 'description_page_unresolved'
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
  /** 按主机 breaker + 独立站外 adaptive gate；其统计不得合入 Wikidot health。 */
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
  /** 最近一次 HTTP 响应；transport/circuit-open/成功为 null。 */
  httpStatus: number | null;
  bytes: number;
  hashHex: string | null;
}

class ImageValidationError extends Error {
  constructor(
    message: string,
    readonly failureClass: ImageFailureClass,
    readonly intrinsicTerminal: boolean,
    readonly httpStatus: number | null = null,
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
  }
}

/**
 * 任务生命周期判据；与 health.ts 的“是否进入健康压力分子”刻意分离。
 * host_deferred 是我方闸主动推迟，即使 attempts 已到上限也不能被终态化。
 */
export function isTerminalImageFailure(args: {
  failureClass: ImageFailureClass;
  intrinsicTerminal: boolean;
  attempts: number;
  maxAttempts: number;
}): boolean {
  if (args.failureClass === 'host_deferred') return false;
  return args.intrinsicTerminal || args.attempts >= args.maxAttempts;
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
          LEFT JOIN meta.external_image_egress_control external_gate
            ON external_gate.host = split_part(job.normalized_url, '/', 3)
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
          -- 已降档 host 的 next_permit 排后；未见过/其它 host 先走，避免坏主机头阻塞。
          ORDER BY COALESCE(external_gate.next_permit_at, '-infinity'::timestamptz),
                   job.not_before NULLS FIRST, job.id
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
  // 同一 normalized URL 常被多页引用；首个引用已解析后直接复用资产，不再重复下载。
  // 数据库异常不伪装成图片失败：这里及最终提交都在 HTTP catch 之外，交 CLI 非零退出。
  const known = await query<{ asset_sha: Buffer; storage_path: string | null }>(
    pool,
    'image:known_asset_for_url',
    `SELECT pi.asset_sha, asset.storage_path
       FROM serve.page_image pi
       JOIN serve.image_asset asset ON asset.hash_sha256 = pi.asset_sha
      WHERE pi.normalized_url = $1
        AND pi.asset_sha IS NOT NULL
        AND asset.status = 'ready'
      ORDER BY pi.last_fetched_at DESC NULLS LAST
      LIMIT 1`,
    [job.normalizedUrl],
  );
  const knownAsset = known.rows[0];
  if (knownAsset !== undefined && knownAsset.storage_path !== null) {
    const verified = await verifyStoredAsset(
      options.assetRoot,
      knownAsset.storage_path,
      knownAsset.asset_sha.toString('hex'),
    ).catch((error) => failJob(pool, job, egressClass, normalizeFailure(error), options));
    if (typeof verified !== 'string') return verified;
    if (verified === 'verified') {
      const knownHash = knownAsset.asset_sha;
      await resolveImageReference(pool, job, egressClass, knownHash, 'normalized_url');
      return {
        status: 'completed',
        egressClass,
        failureClass: null,
        httpStatus: null,
        bytes: 0,
        hashHex: knownHash.toString('hex'),
      };
    }
  }

  // 0055 导入的 v1 canonicalUrl/PageVersionImage 别名可以有多个 SHA。只有唯一候选且
  // 共享目录内文件当场重算 SHA 通过，才允许免下载建立引用；歧义与缺文件都不猜。
  const imported = await query<{ asset_sha: Buffer; storage_path: string }>(
    pool,
    'image:imported_asset_for_url',
    `WITH candidates AS (
       SELECT DISTINCT alias.asset_sha, asset.storage_path
         FROM serve.image_asset_url_alias alias
         JOIN serve.image_asset asset ON asset.hash_sha256 = alias.asset_sha
        WHERE alias.normalized_url = $1
          AND asset.status = 'ready'
          AND asset.storage_path IS NOT NULL
     )
     SELECT (array_agg(asset_sha))[1] AS asset_sha,
            (array_agg(storage_path))[1] AS storage_path
       FROM candidates
     HAVING count(*) = 1`,
    [job.normalizedUrl],
  );
  const importedAsset = imported.rows[0];
  if (importedAsset !== undefined) {
    const hashHex = importedAsset.asset_sha.toString('hex');
    const verified = await verifyStoredAsset(
      options.assetRoot,
      importedAsset.storage_path,
      hashHex,
    ).catch((error) => failJob(pool, job, egressClass, normalizeFailure(error), options));
    if (typeof verified !== 'string') return verified;
    if (verified === 'verified') {
      await resolveImageReference(pool, job, egressClass, importedAsset.asset_sha, 'v1_alias');
      return {
        status: 'completed',
        egressClass,
        failureClass: null,
        httpStatus: null,
        bytes: 0,
        hashHex,
      };
    }
  }

  // host allow/block 是出站边界，不应阻止已经过 SHA 校验的本地内容复用。
  if (!imageHostAllowed(job.displayUrl, options.allowedHosts, options.blockedHosts)) {
    return failJob(pool, job, egressClass,
      new ImageValidationError(`图片 host 不在 allowlist: ${safeHost(job.displayUrl)}`, 'blocked_host', true),
      options);
  }

  let response: HttpResponse;
  let declaredContentType: string;
  let downloadedFromUrl = job.displayUrl;
  let descriptionPageUrl: string | null = null;
  try {
    const client = egressClass === 'wikidot_site' ? clients.wikidot : clients.external;
    response = await client.get(job.displayUrl, `image:${egressClass}`, {
      headers: { accept: 'image/*' },
      // 站外失败必须跨轮走持久 not_before；禁止同一个 job 在几秒内连打 5 次。
      // 重定向仍逐跳过 gate，和瞬时失败重试预算分开；429/503 本来就是零重试。
      maxAttempts: egressClass === 'external' ? 4 : 2,
      maxTransientAttempts: egressClass === 'external' ? 1 : 2,
      maxRedirections: 3,
      redirectPolicy: egressClass === 'wikidot_site' ? 'same-host' : 'any',
    });
    if (response.body.length > options.maxBytes) {
      throw new ImageValidationError(
        `图片超过 ${options.maxBytes} bytes: ${response.body.length}`,
        'too_large',
        true,
      );
    }
    declaredContentType = normalizedContentType(response);
    let detected = sniffImageContent(response.body);

    if (detected === null && isWikimediaFileDescriptionUrl(job.displayUrl)) {
      descriptionPageUrl = job.displayUrl;
      const resolvedUrl = resolveWikimediaOgImageUrl(job.displayUrl, response.text());
      if (resolvedUrl === null) {
        throw new ImageValidationError(
          `Wikimedia 文件描述页缺少安全的 upload.wikimedia.org og:image: ${safeUrl(job.displayUrl)}`,
          'description_page_unresolved',
          true,
        );
      }
      if (!imageHostAllowed(resolvedUrl, options.allowedHosts, options.blockedHosts)) {
        throw new ImageValidationError(
          `描述页解析出的图片 host 不在 allowlist: ${safeHost(resolvedUrl)}`,
          'blocked_host',
          true,
        );
      }
      // 二跳仍走 external client：exact-host breaker、全局/单主机限速和失败归类均不绕过。
      response = await clients.external.get(resolvedUrl, 'image:external:description-resolved', {
        headers: { accept: 'image/*' },
        maxAttempts: 4,
        maxTransientAttempts: 1,
        maxRedirections: 3,
        redirectPolicy: 'any',
      });
      if (response.body.length > options.maxBytes) {
        throw new ImageValidationError(
          `图片超过 ${options.maxBytes} bytes: ${response.body.length}`,
          'too_large',
          true,
        );
      }
      downloadedFromUrl = resolvedUrl;
      declaredContentType = normalizedContentType(response);
      detected = sniffImageContent(response.body);
    }

    if (detected === null) {
      throw new ImageValidationError(
        `响应字节不是已支持图片：declared=${declaredContentType || '(missing)'};` +
          `prefix=${contentPrefixHex(response.body) || '(empty)'}`,
        'invalid_image_content',
        true,
      );
    }

    const hash = createHash('sha256').update(response.body).digest();
    const hashHex = hash.toString('hex');
    const existing = await query<{ storage_path: string | null }>(
      pool,
      'image:existing_asset_path',
      `SELECT storage_path FROM serve.image_asset WHERE hash_sha256 = $1`,
      [hash],
    );
    const relativePath = existing.rows[0]?.storage_path ??
      assetRelativePath(hashHex, detected.extension);
    try {
      await storeAssetBuffer(options.assetRoot, relativePath, response.body, hashHex);
    } catch (error) {
      return failJob(pool, job, egressClass, normalizeFailure(error), options);
    }
    const dimensions = imageDimensions(response.body, detected.mime);
    await storeImageSuccess(
      pool,
      job,
      egressClass,
      hash,
      relativePath,
      detected.mime,
      response.body.length,
      dimensions,
      {
        downloadedFromUrl,
        declaredContentType,
        descriptionPageUrl,
      },
    );
    return {
      status: 'completed',
      egressClass,
      failureClass: null,
      httpStatus: null,
      bytes: response.body.length,
      hashHex,
    };
  } catch (error) {
    throwIfRuntimeBudgetExceeded(error);
    return failJob(pool, job, egressClass, normalizeFailure(error), options);
  }
}

async function failJob(
  pool: Pool,
  job: ClaimedImageJob,
  egressClass: ImageEgressClass,
  error: ImageValidationError,
  options: ImageWorkerOptions,
): Promise<ProcessImageResult> {
  const terminal = isTerminalImageFailure({
    failureClass: error.failureClass,
    intrinsicTerminal: error.intrinsicTerminal,
    attempts: job.attempts,
    maxAttempts: options.maxAttempts,
  });
  const deferred = error.failureClass === 'host_deferred';
  const rawRetryAfterMs = error.retryAfterMs ??
    imageRetryBackoffMs(job.attempts, options.retryBaseMs, options.retryMaxMs);
  if (!Number.isFinite(rawRetryAfterMs) || rawRetryAfterMs <= 0) {
    throw new RangeError(`图片 retryAfterMs 非法: ${rawRetryAfterMs}`);
  }
  /*
   * host_deferred 的 waitMs 是闸在**当时**的估计；原样写进 not_before 会把一个瞬时
   * 退让烤成长期停摆，而闸恢复后没有任何机制回头修正这些任务。
   *
   * 实测：scpsandboxcn.wdfiles.com 的 120 个任务被排到 08-24（11 天后、attempts=0），
   * 而同一个主机的闸在数小时内就已 recovered_after_3_healthy_windows、level=0，
   * 任务却仍停在未来——健康主机被自己的历史退让锁死。
   *
   * 闸在认领时会重新裁决，且 claim 的 ORDER BY 已按 next_permit_at 把降档主机排后，
   * 因此任务侧只需要一个有界的复查间隔，不需要复刻闸的长等待。
   */
  const cappedRetryAfterMs = deferred
    ? Math.min(rawRetryAfterMs, IMAGE_HOST_DEFERRAL_MAX_RETRY_MS)
    : rawRetryAfterMs;
  // PostgreSQL bigint 不接受 databaseClock() 产生的亚毫秒小数；向上取整避免提前放行。
  const retryAfterMs = Math.ceil(cappedRetryAfterMs);
  await withTransaction(pool, `image:failure:${job.id}`, async (db) => {
    await query(
      db,
      'image:page_failure',
      `UPDATE serve.page_image
          SET status = CASE WHEN $4::boolean THEN 'queued' ELSE 'failed' END,
              failure_count = failure_count + CASE WHEN $4::boolean THEN 0 ELSE 1 END,
              last_fetched_at = CASE WHEN $4::boolean THEN last_fetched_at ELSE now() END,
              last_error = $3,
              metadata = COALESCE(metadata, '{}'::jsonb) || $5::jsonb
        WHERE page_id = $1 AND normalized_url = $2`,
      [
        job.pageId,
        job.normalizedUrl,
        error.message.slice(0, 4_000),
        deferred,
        toPgJson({
          last_failure_class: error.failureClass,
          last_http_status: error.httpStatus,
          egress_class: egressClass,
          attempts: job.attempts,
          self_protection_deferred: deferred,
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
              http_status = $7,
              egress_class = $8,
              error = $9,
              attempts = CASE WHEN $10::boolean THEN GREATEST(0, attempts - 1)
                              ELSE attempts END,
              locked_by = NULL,
              locked_at = NULL,
              updated_at = now()
        WHERE id = $1 AND page_id = $2`,
      [
        job.id,
        job.pageId,
        terminal ? 'failed' : 'pending',
        terminal,
        String(retryAfterMs),
        error.failureClass,
        error.httpStatus,
        egressClass,
        error.message.slice(0, 4_000),
        deferred,
      ],
    );
  });
  return {
    status: terminal ? 'failed' : 'retry',
    egressClass,
    failureClass: error.failureClass,
    httpStatus: error.httpStatus,
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
  evidence: {
    downloadedFromUrl: string;
    declaredContentType: string;
    descriptionPageUrl: string | null;
  },
): Promise<void> {
  const host = safeHost(evidence.downloadedFromUrl);
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
        evidence.downloadedFromUrl,
        host,
      ],
    );
    await resolveImageReferenceTx(db, job, egressClass, hash, null, host, evidence);
  });
}

async function resolveImageReference(
  pool: Pool,
  job: ClaimedImageJob,
  egressClass: ImageEgressClass,
  hash: Buffer,
  reuseSource: 'normalized_url' | 'v1_alias',
): Promise<void> {
  await withTransaction(pool, `image:reuse:${job.id}`, async (db) => {
    await resolveImageReferenceTx(
      db,
      job,
      egressClass,
      hash,
      reuseSource,
      safeHost(job.displayUrl),
    );
  });
}

async function resolveImageReferenceTx(
  db: import('pg').PoolClient,
  job: ClaimedImageJob,
  egressClass: ImageEgressClass,
  hash: Buffer,
  reuseSource: 'normalized_url' | 'v1_alias' | null,
  host: string,
  evidence?: {
    downloadedFromUrl: string;
    declaredContentType: string;
    descriptionPageUrl: string | null;
  },
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
        {
          egress_class: egressClass,
          source_host: host,
          reused_by_normalized_url: reuseSource === 'normalized_url',
          reused_by_v1_alias: reuseSource === 'v1_alias',
          reuse_sha_verified: reuseSource !== null,
          ...(evidence === undefined
            ? {}
            : {
                content_detected_by: 'magic_bytes',
                declared_content_type: evidence.declaredContentType || null,
                downloaded_from_url: evidence.downloadedFromUrl,
                description_page_url: evidence.descriptionPageUrl,
              }),
        },
        `image.resolve:${job.id}`,
      ),
    ],
  );
  await query(
    db,
    'image:complete_job',
    `UPDATE meta.image_ingest_job
        SET status = 'completed', not_before = NULL, failure_class = NULL, http_status = NULL,
            egress_class = $3, error = NULL, locked_by = NULL, locked_at = NULL,
            updated_at = now()
      WHERE id = $1 AND page_id = $2`,
    [job.id, job.pageId, egressClass],
  );
}

function normalizedContentType(response: HttpResponse): string {
  return (response.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
}

/** DNS 无法解析 / 主机不可达：域名已消失，重试无意义。 */
function isHostUnresolvable(error: { message?: string; cause?: unknown }): boolean {
  const code = (error as { cause?: { code?: unknown } }).cause?.code;
  const text = `${String(code ?? '')} ${error.message ?? ''}`;
  return /ENOTFOUND|EAI_AGAIN|ERR_NAME_NOT_RESOLVED|getaddrinfo/i.test(text);
}

function normalizeFailure(error: unknown): ImageValidationError {
  if (error instanceof ImageValidationError) return error;
  if (error instanceof HttpStatusError) {
    const transient = error.status === 408 || error.status === 429 || error.status >= 500;
    return new ImageValidationError(
      error.message,
      transient ? 'http_transient' : 'http_permanent',
      !transient,
      error.status,
    );
  }
  if (error instanceof TransportError) {
    /*
     * 站外图床的「主机不存在」是确定性的，不该无限重试。
     *
     * 实测这一轮 network 25 / timeout 4，逐主机看每个只失败 1-2 次
     * （acsurlexample.com 直连 HTTP 000 连 DNS 都解析不了——那是文章里的示例占位 URL；
     * a3.att.hudong.com、article.fd.zol-img.com.cn 等都是多年前的第三方图床）。
     * 不是有人在限流我们，是这些站点本身已经不存在。
     *
     * 同一个「连接失败」在主站与站外图床含义不同：wikidot 连不上通常是瞬时的，
     * 而 acsurlexample.com 这种域名不会某天突然复活。
     * 因此按 DNS 解析失败与否细分：解析不了 ⇒ 确定性；超时/重置 ⇒ 仍可重试。
     */
    if (isHostUnresolvable(error)) {
      return new ImageValidationError(error.message, 'host_unresolvable', true);
    }
    return new ImageValidationError(
      error.message,
      error.kind === 'timeout' ? 'timeout' : 'network',
      false,
    );
  }
  if (error instanceof ExternalHostDeferredError) {
    /*
     * 主机放行时间过远、本轮主动跳过——这不是失败，下轮会重新认领。
     * 归为 host_deferred、按主机实际放行时间调度后续重试；它本就是退让的结果，
     * 不消耗失败尝试预算，也不进入站点健康压力分子。
     */
    return new ImageValidationError(error.message, 'host_deferred', false, null, error.waitMs);
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

/**
 * host_deferred 的 not_before 上界。闸才是放行的权威，任务侧只需定期回来复查；
 * 超过该上界的等待一律截断，避免把闸的瞬时状态固化成任务的长期停摆。
 */
export const IMAGE_HOST_DEFERRAL_MAX_RETRY_MS = 15 * 60_000;

/** attempts 在 claim 时已 +1：第 1/2/3/4 次失败分别退 1/2/4/8 个 base。 */
export function imageRetryBackoffMs(attempts: number, baseMs: number, maxMs: number): number {
  if (!Number.isSafeInteger(attempts) || attempts < 1) {
    throw new RangeError(`图片重试 attempts 必须是正整数，收到 ${attempts}`);
  }
  if (!Number.isFinite(baseMs) || baseMs <= 0 || !Number.isFinite(maxMs) || maxMs <= 0) {
    throw new RangeError(`图片重试 base/max 非法 ${baseMs}/${maxMs}`);
  }
  return Math.min(maxMs, baseMs * (2 ** Math.max(0, attempts - 1)));
}

function assetRelativePath(hashHex: string, extension: string): string {
  return path.join(hashHex.slice(0, 2), hashHex.slice(2, 4), hashHex.slice(4, 6), `${hashHex}.${extension}`);
}

export async function storeAssetBuffer(
  root: string,
  relativePath: string,
  buffer: Buffer,
  expectedHashHex = createHash('sha256').update(buffer).digest('hex'),
): Promise<void> {
  const finalPath = path.resolve(root, relativePath);
  const resolvedRoot = path.resolve(root);
  if (!finalPath.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new ImageValidationError('资产路径逃逸 asset root', 'storage', true);
  }
  const existing = await verifyStoredAsset(root, relativePath, expectedHashHex);
  if (existing === 'verified') return;
  await mkdir(path.dirname(finalPath), { recursive: true });
  const tempPath = `${finalPath}.tmp-${randomUUID()}`;
  let tempHandle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    tempHandle = await open(tempPath, 'wx', 0o664);
    await tempHandle.writeFile(buffer);
    await tempHandle.sync();
    await tempHandle.close();
    tempHandle = null;

    // 缩小 stat→rename 的覆盖窗口；若另一个 v1/v2 worker 已发布同 SHA，验证后复用。
    const raced = await verifyStoredAsset(root, relativePath, expectedHashHex);
    if (raced === 'verified') {
      await unlink(tempPath);
      return;
    }
    await rename(tempPath, finalPath);
    await fsyncDirectory(path.dirname(finalPath));
  } catch (error) {
    await tempHandle?.close().catch(() => undefined);
    // 并发写相同 hash 时，赢家已经原子落盘且内容匹配才算成功。
    try {
      const raced = await verifyStoredAsset(root, relativePath, expectedHashHex);
      if (raced !== 'verified') throw error;
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

export async function verifyStoredAsset(
  root: string,
  relativePath: string,
  expectedHashHex: string,
): Promise<'verified' | 'missing'> {
  if (!/^[0-9a-f]{64}$/i.test(expectedHashHex)) {
    throw new ImageValidationError(`非法资产 SHA256: ${expectedHashHex}`, 'storage', true);
  }
  const finalPath = path.resolve(root, relativePath);
  const resolvedRoot = path.resolve(root);
  if (!finalPath.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new ImageValidationError('资产路径逃逸 asset root', 'storage', true);
  }
  try {
    const item = await stat(finalPath);
    if (!item.isFile()) {
      throw new ImageValidationError(`资产路径不是普通文件: ${relativePath}`, 'storage', true);
    }
    const actualHash = createHash('sha256');
    for await (const part of createReadStream(finalPath)) actualHash.update(part as Buffer);
    const actualHex = actualHash.digest('hex');
    if (actualHex !== expectedHashHex.toLowerCase()) {
      throw new ImageValidationError(
        `共享资产 SHA 不匹配: path=${relativePath}, expected=${expectedHashHex}, actual=${actualHex}`,
        'storage',
        true,
      );
    }
    return 'verified';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    if (error instanceof ImageValidationError) throw error;
    throw new ImageValidationError(
      `共享资产校验失败: ${error instanceof Error ? error.message : String(error)}`,
      'storage',
      false,
    );
  }
}

async function fsyncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return 'invalid';
  }
}

function safeUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.username = '';
    url.password = '';
    return url.toString();
  } catch {
    return '(invalid-url)';
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
