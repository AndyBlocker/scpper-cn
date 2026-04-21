import type { PrismaClient } from '@prisma/client';
import { getPrismaClient } from '../utils/db-connection.js';
import { Logger } from '../utils/Logger.js';
import { EmbeddingClient, embeddingClientFromEnv } from '../services/embedding/EmbeddingClient.js';
import { preparePageText } from '../services/embedding/PageTextPreparer.js';
import {
  listEmbeddingCandidates,
  upsertEmbeddings,
  type EmbeddingCandidate
} from '../services/embedding/PageEmbeddingRepo.js';

export interface BackfillOptions {
  batchSize?: number;             // default 16（CPU 推理，不要太大）
  limit?: number;                 // 上限条数；不传=全量
  includeDeletedPages?: boolean;  // 是否回填已删除 Page（默认 true）
  dryRun?: boolean;
  onProgress?: (done: number, total: number, sample?: EmbeddingCandidate) => void;
  prisma?: PrismaClient;
  client?: EmbeddingClient;
}

export interface BackfillResult {
  total: number;
  written: number;
  truncatedCount: number;
  durationMs: number;
  skippedEmpty: number;
}

/**
 * 把当前还没 embedding 的 PageVersion 批量推过嵌入服务、落 DB。
 *
 * 说明：
 *   - 文本走 `preparePageText`，含 header + denoise + 8000 char 截断
 *   - 每批 N 个文档一发，失败的 batch 整批 skip 并 log；不影响后续批
 *   - 因为 upsertEmbeddings 有 ON CONFLICT DO UPDATE，中途崩了再跑是 resume-safe 的
 */
export async function runPageEmbeddingBackfill(options: BackfillOptions = {}): Promise<BackfillResult> {
  const prisma = options.prisma ?? getPrismaClient();
  const client = options.client ?? embeddingClientFromEnv();
  const batchSize = options.batchSize ?? 16;
  const includeDeletedPages = options.includeDeletedPages ?? true;
  const dryRun = options.dryRun === true;

  Logger.info('[embed-backfill] starting');
  const started = Date.now();

  // dry-run 路径提前取候选、不接触 HTTP，方便在 embedding server 还没就绪时检查
  // SQL 的召回是否合理。
  const candidates = await listEmbeddingCandidates(prisma, client.modelId, {
    limit: options.limit,
    includeDeletedPages
  });

  if (dryRun) {
    Logger.info(`[embed-backfill] dry run — ${candidates.length} candidate PageVersion(s) (model=${client.modelId}), no HTTP / DB write`);
    if (candidates.length > 0) {
      const sample = candidates.slice(0, Math.min(5, candidates.length));
      for (const c of sample) {
        Logger.info(`  pv=${c.pageVersionId} wid=${c.wikidotId} deleted=${c.isDeletedPage} title=${c.title ?? '—'}`);
      }
    }
    return {
      total: candidates.length,
      written: 0,
      truncatedCount: 0,
      durationMs: Date.now() - started,
      skippedEmpty: 0
    };
  }

  const health = await client.health().catch(err => {
    Logger.error(`[embed-backfill] embedding server health failed: ${err}`);
    throw err;
  });
  Logger.info(`[embed-backfill] server health: ${JSON.stringify(health)}`);

  const dim = Number(health.dim);
  if (!Number.isFinite(dim) || dim <= 0) {
    throw new Error(`invalid embedding dim from server: ${health.dim}`);
  }

  Logger.info(`[embed-backfill] ${candidates.length} candidate PageVersion(s) to embed (model=${client.modelId}, dim=${dim})`);

  let written = 0;
  let truncatedCount = 0;
  let skippedEmpty = 0;

  for (let offset = 0; offset < candidates.length; offset += batchSize) {
    const batch = candidates.slice(offset, offset + batchSize);
    const prepared = batch.map(c => ({
      pv: c,
      prepared: preparePageText(c)
    }));

    // 过滤空文本（某些 deleted 页 textContent 完全为空且 header 也为空）
    const nonEmpty = prepared.filter(p => p.prepared.text.trim().length > 0);
    skippedEmpty += prepared.length - nonEmpty.length;
    if (nonEmpty.length === 0) continue;

    const texts = nonEmpty.map(p => p.prepared.text);
    let vectors: number[][];
    try {
      vectors = await client.embed(texts);
    } catch (err) {
      Logger.error(`[embed-backfill] batch at offset=${offset} failed: ${err}; skipping batch`);
      continue;
    }
    if (vectors.length !== nonEmpty.length) {
      Logger.error(`[embed-backfill] shape mismatch at offset=${offset}: got ${vectors.length} vs ${nonEmpty.length}; skipping`);
      continue;
    }

    const rows = nonEmpty.map((p, i) => ({
      pageVersionId: p.pv.pageVersionId,
      embedding: vectors[i],
      sourceCharLen: p.prepared.sourceCharLen,
      sourceTruncated: p.prepared.truncated
    }));

    try {
      await upsertEmbeddings(prisma, client.modelId, dim, rows);
    } catch (err) {
      Logger.error(`[embed-backfill] upsert failed at offset=${offset}: ${err}`);
      continue;
    }

    written += rows.length;
    truncatedCount += prepared.filter(p => p.prepared.truncated).length;

    if (options.onProgress) {
      options.onProgress(offset + batch.length, candidates.length, batch[batch.length - 1]);
    } else if ((offset / batchSize) % 5 === 0) {
      Logger.info(`[embed-backfill] progress ${offset + batch.length}/${candidates.length} (+${rows.length}; truncated=${truncatedCount}; skippedEmpty=${skippedEmpty})`);
    }
  }

  const durationMs = Date.now() - started;
  Logger.info(`[embed-backfill] done: written=${written} truncated=${truncatedCount} skippedEmpty=${skippedEmpty} durationMs=${durationMs}`);
  return {
    total: candidates.length,
    written,
    truncatedCount,
    durationMs,
    skippedEmpty
  };
}

/**
 * 增量：和 backfill 同一个查询（`NOT EXISTS ... PageEmbedding`），
 * 没 embedding 的 PageVersion 都会被拉出来。所以"增量"和"全量"其实是同一个
 * 操作，只是量不同。外层自己决定用哪个 limit。
 *
 * 这里额外接受 `minIntervalMs`，用来在 cron/sync-hourly 钩子里做一次性滤流。
 */
export async function runPageEmbeddingIncremental(options: BackfillOptions = {}): Promise<BackfillResult> {
  return runPageEmbeddingBackfill({
    batchSize: 8,
    ...options
  });
}
