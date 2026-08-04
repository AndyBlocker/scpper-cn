/**
 * 已有页面的图片 source-only 冷回填。
 *
 * v2 没有全量缓存整页 HTML；为 3.6 万活页单独补发 GET 会制造一次昂贵的全站扫。
 * 因此本入口只读取已经落库的 content_blob.source，不触网，补 `[[image]]` /
 * component:image-block 的确定性引用。默认 p_replace=false，保证它不会删掉增量链路已经
 * 从渲染 HTML 得到的引用；`--replace` 只供首次零状态重建。以后 L0/L1 触发的 content task
 * 会用 HTML+source 完整集合替换。
 */

import { Command } from 'commander';
import type { Pool } from 'pg';

import {
  extractImagesFromWikidotSource,
  imageCandidateToJson,
} from '../content/extractImages.js';
import { loadConfig } from '../config.js';
import { slugToUrl } from '../page/identity.js';
import { assertTimezoneRoundTrip, createPool, query, toPgTimestamptz } from '../store/db.js';
import { toPgJson } from '../store/pgText.js';
import { mapWithConcurrency } from '../util/concurrency.js';
import { emitSummary, redirectConsoleToStderr } from '../util/log.js';

redirectConsoleToStderr();

interface Options {
  execute: boolean;
  replace: boolean;
  batchSize: number;
  concurrency: number;
  afterPageId: number;
  limit?: number;
  skipTzCheck: boolean;
}

interface SourceRow {
  page_id: number;
  slug: string;
  source: string | null;
}

interface Counters {
  pagesScanned: number;
  pagesWithSource: number;
  pagesWithImages: number;
  references: number;
  appliedPages: number;
  errors: number;
  lastPageId: number;
}

async function main(): Promise<void> {
  const opts = parseArgs();
  const config = loadConfig();
  const pool = createPool(config.databaseUrl, { max: Math.max(4, opts.concurrency) });
  const counters: Counters = {
    pagesScanned: 0,
    pagesWithSource: 0,
    pagesWithImages: 0,
    references: 0,
    appliedPages: 0,
    errors: 0,
    lastPageId: opts.afterPageId,
  };
  const started = Date.now();
  try {
    if (!opts.skipTzCheck) await assertTimezoneRoundTrip(pool);
    while (opts.limit === undefined || counters.pagesScanned < opts.limit) {
      const remaining =
        opts.limit === undefined ? opts.batchSize : opts.limit - counters.pagesScanned;
      const rows = await loadBatch(
        pool,
        counters.lastPageId,
        Math.min(opts.batchSize, remaining),
      );
      if (rows.length === 0) break;

      await mapWithConcurrency(rows, opts.concurrency, async (row) => {
        counters.pagesScanned++;
        counters.lastPageId = Math.max(counters.lastPageId, row.page_id);
        if (row.source !== null) counters.pagesWithSource++;
        const images = extractImagesFromWikidotSource(
          row.source ?? '',
          slugToUrl(config.siteBaseUrl, row.slug),
          row.slug,
        );
        counters.references += images.length;
        if (images.length > 0) counters.pagesWithImages++;
        if (!opts.execute) return;
        if (images.length === 0 && !opts.replace) return;
        try {
          await query(
            pool,
            'images.backfill:apply',
            `SELECT ingest.apply_page_images(
               $1::int, $2::jsonb, $3::timestamptz, $4::boolean
             )`,
            [
              row.page_id,
              toPgJson(images.map(imageCandidateToJson), `image.backfill:${row.page_id}`),
              toPgTimestamptz(new Date()),
              opts.replace,
            ],
          );
          counters.appliedPages++;
        } catch (error) {
          counters.errors++;
          process.stderr.write(
            `[image-backfill] page_id=${row.page_id} apply failed: ${String(error)}\n`,
          );
        }
      });
      if (rows.length < Math.min(opts.batchSize, remaining)) break;
    }
    emitSummary({
      ok: counters.errors === 0,
      mode: 'source-only',
      execute: opts.execute,
      replace: opts.replace,
      ...counters,
      durationMs: Date.now() - started,
      renderedHtmlRequests: 0,
      nextAfterPageId: counters.lastPageId,
    });
    if (counters.errors > 0) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

async function loadBatch(pool: Pool, afterPageId: number, limit: number): Promise<SourceRow[]> {
  const result = await query<SourceRow>(
    pool,
    'images.backfill:load',
    `SELECT pc.page_id, pc.slug, blob.source
       FROM serve.page_current pc
       LEFT JOIN ingest.content_blob blob ON blob.sha256 = pc.source_sha
      WHERE pc.page_id > $1::int
      ORDER BY pc.page_id
      LIMIT $2::int`,
    [afterPageId, limit],
  );
  return result.rows;
}

function parseArgs(): Options {
  const command = new Command()
    .name('image-backfill')
    .description('从 v2 已有 wikitext 回填图片引用/待下载任务；不抓 HTML、不下载图片')
    .option('--execute', '实际写 serve.page_image + meta.image_ingest_job；默认 dry-run')
    .option('--replace', '以 source 集合替换现有引用；仅限首次重建，默认只单调补充')
    .option('--batch-size <n>', '读取批大小', '500')
    .option('--concurrency <n>', '写库并发', '8')
    .option('--after-page-id <n>', '从该 page_id 之后续跑', '0')
    .option('--limit <n>', '最多处理页数')
    .option('--skip-tz-check', '仅本地诊断：跳过 DB 时区回环')
    .parse();
  const raw = command.opts<{
    execute?: boolean;
    replace?: boolean;
    batchSize: string;
    concurrency: string;
    afterPageId: string;
    limit?: string;
    skipTzCheck?: boolean;
  }>();
  const batchSize = positiveInt(raw.batchSize, '--batch-size', 5_000);
  const concurrency = positiveInt(raw.concurrency, '--concurrency', 32);
  const afterPageId = nonnegativeInt(raw.afterPageId, '--after-page-id');
  const limit =
    raw.limit === undefined ? undefined : positiveInt(raw.limit, '--limit', 10_000_000);
  return {
    execute: raw.execute === true,
    replace: raw.replace === true,
    batchSize,
    concurrency,
    afterPageId,
    limit,
    skipTzCheck: raw.skipTzCheck === true,
  };
}

function positiveInt(raw: string, label: string, max: number): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new RangeError(`${label} 必须是 1..${max} 的整数，收到 ${raw}`);
  }
  return value;
}

function nonnegativeInt(raw: string, label: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${label} 必须是非负整数，收到 ${raw}`);
  }
  return value;
}

await main();
