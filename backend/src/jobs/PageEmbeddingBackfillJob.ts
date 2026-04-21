import type { PrismaClient } from '@prisma/client';
import { getPrismaClient } from '../utils/db-connection.js';
import { Logger } from '../utils/Logger.js';
import { EmbeddingClient, embeddingClientFromEnv } from '../services/embedding/EmbeddingClient.js';
import { preparePageChunks } from '../services/embedding/PageTextPreparer.js';
import {
  listEmbeddingCandidates,
  upsertEmbeddings,
  type EmbeddingCandidate
} from '../services/embedding/PageEmbeddingRepo.js';

export interface BackfillOptions {
  /** 发给 embedding server 的一次请求的 chunk 数；CPU 8 合适 */
  batchSize?: number;
  /** 并发请求数（对多 uvicorn-worker 的 server 有效，单 worker 下保持 1） */
  concurrency?: number;
  /** 处理的 PageVersion 上限；不传=全量 */
  limit?: number;
  includeDeletedPages?: boolean;
  dryRun?: boolean;
  onProgress?: (done: number, total: number, sample?: EmbeddingCandidate) => void;
  prisma?: PrismaClient;
  client?: EmbeddingClient;
}

export interface BackfillResult {
  totalPages: number;        // 候选 PV 数
  totalChunks: number;       // 切段后总 chunk 数
  written: number;           // 实际写入的 chunk 行数
  truncatedChunks: number;   // chunk 本身被模型 max_seq 截断的数量
  skippedEmptyPages: number; // 完全无可嵌入文本的 PV
  durationMs: number;
}

interface ChunkItem {
  pageVersionId: number;
  chunkIndex: number;
  chunkTotal: number;
  chunkCharStart: number;
  chunkCharEnd: number;
  text: string;
  sourceCharLen: number;
  sourceTruncated: boolean;
}

/**
 * 把当前还没 embedding 的 PageVersion 切段、批量推过嵌入服务、落 DB。
 *
 * 说明：
 *   - 每个 PV 走 `preparePageChunks` 切成 1-16 段（`MAX_CHUNKS`）
 *   - 所有 chunk 拍平后按 `batchSize` 打包发请求
 *   - `concurrency > 1` 时会并发发多个 batch；只有 server 跑多 uvicorn worker
 *     或主动 `--workers N` 时才有加速
 *   - 单个 batch 失败整批 skip 并 log；不影响后续批
 *   - ON CONFLICT DO UPDATE 使操作是 resume-safe
 */
export async function runPageEmbeddingBackfill(options: BackfillOptions = {}): Promise<BackfillResult> {
  const prisma = options.prisma ?? getPrismaClient();
  const client = options.client ?? embeddingClientFromEnv();
  const batchSize = Math.max(1, options.batchSize ?? 8);
  const concurrency = Math.max(1, options.concurrency ?? 1);
  const includeDeletedPages = options.includeDeletedPages ?? true;
  const dryRun = options.dryRun === true;

  Logger.info(`[embed-backfill] starting batchSize=${batchSize} concurrency=${concurrency}`);
  const started = Date.now();

  const candidates = await listEmbeddingCandidates(prisma, client.modelId, {
    limit: options.limit,
    includeDeletedPages
  });

  // 切段 + 平铺
  const chunks: ChunkItem[] = [];
  let skippedEmptyPages = 0;
  for (const pv of candidates) {
    const pageChunks = preparePageChunks(pv);
    if (pageChunks.length === 0) {
      skippedEmptyPages += 1;
      continue;
    }
    for (const ch of pageChunks) {
      chunks.push({
        pageVersionId: pv.pageVersionId,
        chunkIndex: ch.chunkIndex,
        chunkTotal: ch.chunkTotal,
        chunkCharStart: ch.contentStart,
        chunkCharEnd: ch.contentEnd,
        text: ch.text,
        sourceCharLen: ch.sourceCharLen,
        sourceTruncated: ch.truncated
      });
    }
  }

  if (dryRun) {
    Logger.info(`[embed-backfill] dry run — ${candidates.length} PV / ${chunks.length} chunk(s) (model=${client.modelId}) (skippedEmpty=${skippedEmptyPages}); no HTTP / DB write`);
    const byChunkCount: Record<number, number> = {};
    for (const c of chunks) {
      byChunkCount[c.chunkTotal] = (byChunkCount[c.chunkTotal] ?? 0) + 1;
    }
    Logger.info(`  chunk distribution (by chunkTotal): ${JSON.stringify(byChunkCount)}`);
    for (const c of candidates.slice(0, 3)) {
      Logger.info(`  pv=${c.pageVersionId} wid=${c.wikidotId} deleted=${c.isDeletedPage} title=${c.title ?? '—'}`);
    }
    return {
      totalPages: candidates.length,
      totalChunks: chunks.length,
      written: 0,
      truncatedChunks: 0,
      skippedEmptyPages,
      durationMs: Date.now() - started
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

  Logger.info(`[embed-backfill] ${candidates.length} PV / ${chunks.length} chunk(s) to embed (model=${client.modelId}, dim=${dim}, skippedEmpty=${skippedEmptyPages})`);

  let written = 0;
  let truncatedChunks = 0;

  // 把 chunk 按 batchSize 切成 batch
  const batches: ChunkItem[][] = [];
  for (let i = 0; i < chunks.length; i += batchSize) {
    batches.push(chunks.slice(i, i + batchSize));
  }

  // 并发 worker 模式：N 个异步 loop 从共享队列取 batch
  let nextBatchIdx = 0;
  const total = batches.length;

  async function workerLoop(workerId: number): Promise<void> {
    while (true) {
      const idx = nextBatchIdx;
      nextBatchIdx += 1;
      if (idx >= total) return;
      const batch = batches[idx];
      const texts = batch.map(c => c.text);

      let vectors: number[][];
      try {
        vectors = await client.embed(texts);
      } catch (err) {
        Logger.error(`[embed-backfill] w${workerId} batch ${idx} (${batch.length} chunks) failed: ${err}; skipping`);
        continue;
      }
      if (vectors.length !== batch.length) {
        Logger.error(`[embed-backfill] w${workerId} batch ${idx} shape mismatch: got ${vectors.length} vs ${batch.length}; skipping`);
        continue;
      }

      const rows = batch.map((c, i) => ({
        pageVersionId: c.pageVersionId,
        embedding: vectors[i],
        sourceCharLen: c.sourceCharLen,
        sourceTruncated: c.sourceTruncated,
        chunkIndex: c.chunkIndex,
        chunkTotal: c.chunkTotal,
        chunkCharStart: c.chunkCharStart,
        chunkCharEnd: c.chunkCharEnd
      }));

      try {
        await upsertEmbeddings(prisma, client.modelId, dim, rows);
      } catch (err) {
        Logger.error(`[embed-backfill] w${workerId} upsert failed at batch ${idx}: ${err}`);
        continue;
      }

      written += rows.length;
      truncatedChunks += rows.filter(r => r.sourceTruncated).length;

      if (idx % 5 === 0) {
        Logger.info(`[embed-backfill] progress ${Math.min((idx + 1) * batchSize, chunks.length)}/${chunks.length} chunks (+${rows.length}; truncated=${truncatedChunks})`);
      }
    }
  }

  await Promise.all(
    Array.from({ length: concurrency }, (_, i) => workerLoop(i))
  );

  const durationMs = Date.now() - started;
  Logger.info(`[embed-backfill] done: written=${written}/${chunks.length} chunks truncated=${truncatedChunks} skippedEmpty=${skippedEmptyPages} durationMs=${durationMs}`);
  return {
    totalPages: candidates.length,
    totalChunks: chunks.length,
    written,
    truncatedChunks,
    skippedEmptyPages,
    durationMs
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
    concurrency: 1,
    ...options
  });
}
