/**
 * 100 页验证样本的 rendered-HTML 图片刷新。
 *
 * 每页只发一次整页 GET；同一响应同时做 wikidotId 身份守卫、page-content 结构守卫与
 * `<img>` 提取。源码直接读 v2 content_blob，不另发 ViewSource 请求，也绝不下载图片。
 */

import { Command } from 'commander';
import { Client } from 'pg';

import { extractPageImages, imageCandidateToJson } from '../content/extractImages.js';
import { extractSearchText } from '../content/extractText.js';
import { loadConfig } from '../config.js';
import { HttpClient } from '../http/client.js';
import { extractPageIdentity, slugToUrl } from '../page/identity.js';
import { assertTimezoneRoundTrip, createPool, query, toPgTimestamptz } from '../store/db.js';
import { toPgJson } from '../store/pgText.js';
import { mapWithConcurrency } from '../util/concurrency.js';
import { emitSummary, redirectConsoleToStderr } from '../util/log.js';

redirectConsoleToStderr();

interface PageRow {
  page_id: number;
  wikidot_id: number;
  slug: string;
  status: string;
  source: string | null;
}

async function main(): Promise<void> {
  const opts = parseArgs();
  const config = loadConfig();
  const v1Url = opts.v1DatabaseUrl ?? process.env.SYNCER2_V1_DATABASE_URL;
  if (!v1Url) {
    throw new Error('缺 --v1-database-url 或 SYNCER2_V1_DATABASE_URL（v1 只读）');
  }
  const v1 = new Client({
    connectionString: v1Url,
    application_name: 'syncer2-image-sample-ro',
  });
  const v2 = createPool(config.databaseUrl, { max: Math.max(4, opts.concurrency) });
  const http = new HttpClient({
    userAgent: config.userAgent,
    referer: config.referer,
    proxyUrl: config.proxyUrl,
    timeoutMs: config.httpTimeoutMs,
    maxAttempts: Math.max(3, config.httpMaxAttempts),
    breaker503: Math.max(5, config.breaker503),
    breakerReset: Math.max(5, config.breakerReset),
    connections: opts.concurrency,
  });
  const counters = {
    requested: opts.sample,
    resolved: 0,
    refreshed: 0,
    failed: 0,
    references: 0,
    htmlRequests: 0,
  };
  try {
    await assertTimezoneRoundTrip(v2);
    await v1.connect();
    await v1.query('BEGIN READ ONLY');
    const sampled = await v1.query<{ page_id: number }>(
      `SELECT pv."pageId"::int AS page_id
         FROM "PageVersion" pv
         JOIN "PageVersionImage" image ON image."pageVersionId" = pv.id
        WHERE pv."validTo" IS NULL
          AND pv."isDeleted" = false
        GROUP BY pv."pageId"
        ORDER BY md5(pv."pageId"::text || $1::text)
        LIMIT $2::int`,
      [opts.seed, opts.sample],
    );
    await v1.query('COMMIT');
    const ids = sampled.rows.map((row) => row.page_id);
    const pages = await query<PageRow>(
      v2,
      'images.sample:pages',
      `SELECT pc.page_id, pc.wikidot_id, pc.slug, pc.status, blob.source
         FROM serve.page_current pc
         LEFT JOIN ingest.content_blob blob ON blob.sha256 = pc.source_sha
        WHERE pc.page_id = ANY($1::int[])`,
      [ids],
    );
    counters.resolved = pages.rows.length;

    await mapWithConcurrency(pages.rows, opts.concurrency, async (page) => {
      if (page.status !== 'live') {
        counters.failed++;
        return;
      }
      const pageUrl = slugToUrl(config.siteBaseUrl, page.slug);
      try {
        counters.htmlRequests++;
        const response = await http.get(pageUrl, 'images:sample-rendered', { maxAttempts: 3 });
        const html = response.text();
        const identity = extractPageIdentity(html);
        const text = extractSearchText(html);
        if (
          identity === null ||
          identity.wikidotId !== page.wikidot_id ||
          text.status !== 'ok'
        ) {
          counters.failed++;
          return;
        }
        const images = extractPageImages({
          html,
          source: page.source,
          pageUrl,
          slug: page.slug,
        });
        await query(
          v2,
          'images.sample:apply',
          `SELECT ingest.apply_page_images(
             $1::int, $2::jsonb, $3::timestamptz, true
           )`,
          [
            page.page_id,
            toPgJson(images.map(imageCandidateToJson), `image.sample:${page.page_id}`),
            toPgTimestamptz(new Date()),
          ],
        );
        counters.refreshed++;
        counters.references += images.length;
      } catch (error) {
        counters.failed++;
        process.stderr.write(
          `[image-sample] page_id=${page.page_id} ${page.slug}: ${String(error)}\n`,
        );
      }
    });

    emitSummary({
      ok: counters.failed === 0 && counters.refreshed === opts.sample,
      ...counters,
      seed: opts.seed,
      sourceRequests: 0,
      imageDownloads: 0,
      http: http.stats(),
      v1ReadOnly: true,
    });
    if (counters.failed > 0 || counters.refreshed !== opts.sample) process.exitCode = 1;
  } finally {
    await v1.query('ROLLBACK').catch(() => undefined);
    await v1.end().catch(() => undefined);
    await http.close();
    await v2.end();
  }
}

function parseArgs(): {
  sample: number;
  seed: string;
  concurrency: number;
  v1DatabaseUrl?: string;
} {
  const command = new Command()
    .name('image-sample-refresh')
    .description('用一次整页 GET 刷新稳定的 v1 对照样本；不下载图片')
    .option('--sample <n>', '抽样活跃有图页面数', '100')
    .option('--seed <text>', '稳定抽样 seed', 'syncer2-image-v1')
    .option('--concurrency <n>', '整页 GET 并发', '4')
    .option('--v1-database-url <url>', 'v1 主库连接串（事务强制 READ ONLY）')
    .parse();
  const raw = command.opts<{
    sample: string;
    seed: string;
    concurrency: string;
    v1DatabaseUrl?: string;
  }>();
  const sample = Number(raw.sample);
  const concurrency = Number(raw.concurrency);
  if (!Number.isInteger(sample) || sample < 1 || sample > 1_000) {
    throw new RangeError(`--sample 必须是 1..1000 的整数，收到 ${raw.sample}`);
  }
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) {
    throw new RangeError(`--concurrency 必须是 1..8 的整数，收到 ${raw.concurrency}`);
  }
  return {
    sample,
    seed: raw.seed,
    concurrency,
    v1DatabaseUrl: raw.v1DatabaseUrl,
  };
}

await main();
