/**
 * M8 首次全量 catch-up。
 *
 * 事实型投影按 seq 窗口逐事务提交；当前态与全局聚合最后各跑一次。进程被终止时，
 * meta.projection_cursor 就是断点，重跑本入口会从各投影自己的 last_seq 继续。
 *
 * 这里刻意不使用 --rebuild：首次上线的 cursor=0 且目标表为空；rebuild 会清表，
 * 无法在多个事务之间安全续跑。后续日常调度仍走 src/cli/project.ts 单轮增量。
 */

import { Command } from 'commander';
import type { Pool } from 'pg';
import { loadConfig } from '../config.js';
import { assertTimezoneRoundTrip, createPool } from '../store/db.js';
import { createLogger, emitSummary, redirectConsoleToStderr } from '../util/log.js';
import { DEFAULT_PROJECTION_ORDER, runProjection } from './runner.js';
import { asNumber } from './sql.js';
import type { ProjectionName, ProjectionRunResult } from './types.js';

redirectConsoleToStderr();

const log = createLogger('project.catch-up');

const CHUNKED_PROJECTIONS = new Set<ProjectionName>([
  'serve.page_stats',
  'serve.vote_daily',
  'serve.user_attr_daily',
  'serve.user_vote_interaction',
  'serve.user_tag_preference',
  'serve.page_daily_stats',
]);

interface CatchUpOptions {
  batchSeq: number;
  delayMs: number;
}

interface CursorRow {
  last_seq: string;
}

interface WatermarkRow {
  watermark: string | null;
}

interface CatchUpSummary {
  ok: true;
  targetSeq: number;
  batchSeq: number;
  delayMs: number;
  includeDeletedPages: false;
  batches: number;
  durationMs: number;
  projections: Array<{
    projection: ProjectionName;
    batches: number;
    advancedTo: number;
    rowsWritten: number;
  }>;
}

function parseArgs(): CatchUpOptions {
  const program = new Command();
  program
    .name('project:catch-up')
    .description('M8 首次全量：按 fact_seq 窗口限速、逐投影断点续跑')
    .option('--batch-seq <n>', '事实型投影每事务最多消费的 seq 数，默认 250000', Number, 250_000)
    .option('--delay-ms <n>', '成功批次之间的休眠毫秒，默认 2000', Number, 2_000);
  program.parse(process.argv);
  const raw = program.opts<{ batchSeq: number; delayMs: number }>();
  if (!Number.isSafeInteger(raw.batchSeq) || raw.batchSeq < 10_000 || raw.batchSeq > 1_000_000) {
    throw new RangeError(`--batch-seq 必须在 10000..1000000，收到 ${raw.batchSeq}`);
  }
  if (!Number.isSafeInteger(raw.delayMs) || raw.delayMs < 0 || raw.delayMs > 60_000) {
    throw new RangeError(`--delay-ms 必须在 0..60000，收到 ${raw.delayMs}`);
  }
  return raw;
}

async function readTargetWatermark(pool: Pool): Promise<number> {
  const result = await pool.query<WatermarkRow>(
    `SELECT meta.safe_seq_watermark()::text AS watermark`,
  );
  const raw = result.rows[0]?.watermark ?? null;
  if (raw === null) {
    throw new Error('摄入 gate 正在提交；无法取得首次全量的稳定目标水位，请稍后重跑');
  }
  return asNumber(raw, 'catch-up.target_watermark');
}

async function readCursor(pool: Pool, projection: ProjectionName): Promise<number> {
  const result = await pool.query<CursorRow>(
    `SELECT last_seq::text
       FROM meta.projection_cursor
      WHERE projection = $1`,
    [projection],
  );
  if (!result.rows[0]) {
    throw new Error(`${projection} 未登记在 meta.projection_cursor`);
  }
  return asNumber(result.rows[0].last_seq, `${projection}.last_seq`);
}

async function delay(ms: number): Promise<void> {
  if (ms === 0) return;
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function catchUpProjection(
  pool: Pool,
  projection: ProjectionName,
  targetSeq: number,
  options: CatchUpOptions,
): Promise<{ results: ProjectionRunResult[]; advancedTo: number }> {
  const results: ProjectionRunResult[] = [];
  let cursor = await readCursor(pool, projection);
  if (cursor > targetSeq) {
    throw new Error(`${projection} 游标 ${cursor} 已超过启动快照 ${targetSeq}`);
  }

  while (cursor < targetSeq) {
    const result = await runProjection(pool, projection, {
      includeDeletedPages: false,
      targetSeq,
      maxSeqSpan: CHUNKED_PROJECTIONS.has(projection)
        ? options.batchSeq
        : undefined,
    });
    if (result.status === 'busy') {
      log.warn('摄入 gate 忙，本批未写入，等待后重试', { projection, cursor });
      await delay(Math.max(options.delayMs, 2_000));
      continue;
    }
    if (result.advancedTo <= cursor) {
      throw new Error(
        `${projection} catch-up 未前进：before=${cursor} after=${result.advancedTo}`,
      );
    }
    results.push(result);
    cursor = result.advancedTo;
    log.info('投影批次已提交', {
      projection,
      batch: results.length,
      advancedTo: cursor,
      targetSeq,
      affectedKeys: result.affectedKeys,
      rowsWritten: result.rowsWritten,
      durationMs: result.durationMs,
    });
    if (cursor < targetSeq) await delay(options.delayMs);
  }
  return { results, advancedTo: cursor };
}

async function main(): Promise<void> {
  const options = parseArgs();
  const config = loadConfig();
  if (config.projectIncludeDeletedPages) {
    log.warn(
      '环境变量要求纳入已删作品，但 B2 已裁决为排除；首次全量将显式使用 false',
    );
  }
  const pool = createPool(config.databaseUrl, { max: 1 });
  const started = Date.now();
  try {
    await assertTimezoneRoundTrip(pool);
    const targetSeq = await readTargetWatermark(pool);
    const projections: CatchUpSummary['projections'] = [];
    let batches = 0;
    log.info('首次全量目标水位已固定', {
      targetSeq,
      batchSeq: options.batchSeq,
      delayMs: options.delayMs,
      includeDeletedPages: false,
    });

    // 顺序是依赖契约：B4 曲线先完整，B2 当前作品与 user_stats 才在末尾发布并断言。
    for (const projection of DEFAULT_PROJECTION_ORDER) {
      const result = await catchUpProjection(pool, projection, targetSeq, options);
      const rowsWritten = result.results.reduce((sum, item) => sum + item.rowsWritten, 0);
      batches += result.results.length;
      projections.push({
        projection,
        batches: result.results.length,
        advancedTo: result.advancedTo,
        rowsWritten,
      });
    }

    const summary: CatchUpSummary = {
      ok: true,
      targetSeq,
      batchSeq: options.batchSeq,
      delayMs: options.delayMs,
      includeDeletedPages: false,
      batches,
      durationMs: Date.now() - started,
      projections,
    };
    emitSummary(summary);
  } finally {
    await pool.end().catch(() => undefined);
  }
}

main().catch((err) => {
  log.error('首次全量失败；已提交批次可从 projection_cursor 续跑', {
    error: String(err),
  });
  emitSummary({ ok: false, status: 'failed', error: String(err) });
  process.exitCode = 1;
});
