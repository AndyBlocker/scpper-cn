/**
 * v2 当前图片引用与 v1 当前 PageVersionImage 的 100 页集合审计。
 *
 * v1 连接始终处于 READ ONLY 事务；本脚本不抓网页、不写任何库。
 */

import { Command } from 'commander';
import { Client } from 'pg';

import { normalizeImageUrl } from '../content/extractImages.js';
import { loadConfig } from '../config.js';
import { slugToUrl } from '../page/identity.js';
import { createPool, query } from '../store/db.js';
import { emitSummary, redirectConsoleToStderr } from '../util/log.js';

redirectConsoleToStderr();

interface V1ImageRow {
  page_id: number;
  url: string;
  status: string;
}

interface V2PageRow {
  page_id: number;
  slug: string;
  urls: string[];
}

interface PageAudit {
  pageId: number;
  slug: string;
  expected: number;
  actual: number;
  intersection: number;
  jaccard: number;
  missing: string[];
  unexpected: string[];
}

async function main(): Promise<void> {
  const opts = parseArgs();
  const config = loadConfig();
  const v1Url = opts.v1DatabaseUrl ?? process.env.SYNCER2_V1_DATABASE_URL;
  if (!v1Url) {
    throw new Error('缺 --v1-database-url 或 SYNCER2_V1_DATABASE_URL（v1 只读）');
  }
  const v1 = new Client({ connectionString: v1Url, application_name: 'syncer2-image-audit-ro' });
  const v2 = createPool(config.databaseUrl, { max: 2 });
  try {
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
    const ids = sampled.rows.map((row) => row.page_id);
    const pagesResult = await query<V2PageRow>(
      v2,
      'images.audit:v2',
      `SELECT pc.page_id,
              pc.slug,
              COALESCE(
                array_agg(image.normalized_url ORDER BY image.normalized_url)
                  FILTER (WHERE image.normalized_url IS NOT NULL),
                '{}'::text[]
              ) AS urls
         FROM serve.page_current pc
         LEFT JOIN serve.page_image image ON image.page_id = pc.page_id
        WHERE pc.page_id = ANY($1::int[])
        GROUP BY pc.page_id, pc.slug`,
      [ids],
    );
    const byPage = new Map(pagesResult.rows.map((row) => [row.page_id, row]));
    const v1Images = await v1.query<V1ImageRow>(
      `SELECT pv."pageId"::int AS page_id,
              COALESCE(image."displayUrl", image."originUrl") AS url,
              image.status::text AS status
         FROM "PageVersion" pv
         JOIN "PageVersionImage" image ON image."pageVersionId" = pv.id
        WHERE pv."validTo" IS NULL
          AND pv."pageId" = ANY($1::int[])`,
      [ids],
    );
    await v1.query('COMMIT');

    const expectedByPage = new Map<number, string[]>();
    const resolvedExpectedByPage = new Map<number, string[]>();
    for (const row of v1Images.rows) {
      const page = byPage.get(row.page_id);
      if (page === undefined) continue;
      // v1 的源码 token 化会把 `|caption=...` 误吞进 URL；集合审计比较真实 URL 部分。
      const raw = row.url.split('|', 1)[0]!.trim();
      const normalized = normalizeImageUrl(raw, {
        pageUrl: slugToUrl(config.siteBaseUrl, page.slug),
        slug: page.slug,
        source: 'wikidot_image',
      });
      if (normalized === null) continue;
      const list = expectedByPage.get(row.page_id) ?? [];
      list.push(normalized.normalizedUrl);
      expectedByPage.set(row.page_id, list);
      if (row.status === 'RESOLVED') {
        const resolved = resolvedExpectedByPage.get(row.page_id) ?? [];
        resolved.push(normalized.normalizedUrl);
        resolvedExpectedByPage.set(row.page_id, resolved);
      }
    }

    const audits: PageAudit[] = [];
    const resolvedAudits: PageAudit[] = [];
    for (const id of ids) {
      const page = byPage.get(id);
      if (page === undefined) continue;
      audits.push(comparePage(
        id,
        page.slug,
        new Set(expectedByPage.get(id) ?? []),
        new Set(page.urls),
      ));
      resolvedAudits.push(comparePage(
        id,
        page.slug,
        new Set(resolvedExpectedByPage.get(id) ?? []),
        new Set(page.urls),
      ));
    }
    const allMetrics = summarize(audits);
    const resolvedMetrics = summarize(resolvedAudits);
    emitSummary({
      ok: audits.length === opts.sample,
      requestedPages: opts.sample,
      comparedPages: audits.length,
      allV1: allMetrics,
      resolvedV1: resolvedMetrics,
      sampleDiffs: audits
        .filter((page) => page.missing.length > 0 || page.unexpected.length > 0)
        .slice(0, 20),
      seed: opts.seed,
      v1ReadOnly: true,
    });
    if (audits.length !== opts.sample) process.exitCode = 1;
  } finally {
    await v1.query('ROLLBACK').catch(() => undefined);
    await v1.end().catch(() => undefined);
    await v2.end();
  }
}

function summarize(audits: readonly PageAudit[]): Record<string, number> {
  const expected = audits.reduce((sum, page) => sum + page.expected, 0);
  const actual = audits.reduce((sum, page) => sum + page.actual, 0);
  const intersection = audits.reduce((sum, page) => sum + page.intersection, 0);
  return {
    exactPages: audits.filter(
      (page) => page.missing.length === 0 && page.unexpected.length === 0,
    ).length,
    expectedReferences: expected,
    actualReferences: actual,
    intersection,
    recall: expected === 0 ? 1 : intersection / expected,
    precision: actual === 0 ? (expected === 0 ? 1 : 0) : intersection / actual,
    meanJaccard:
      audits.length === 0
        ? 0
        : audits.reduce((sum, page) => sum + page.jaccard, 0) / audits.length,
  };
}

function comparePage(
  pageId: number,
  slug: string,
  expected: Set<string>,
  actual: Set<string>,
): PageAudit {
  const missing = [...expected].filter((url) => !actual.has(url));
  const unexpected = [...actual].filter((url) => !expected.has(url));
  const intersection = expected.size - missing.length;
  const union = expected.size + actual.size - intersection;
  return {
    pageId,
    slug,
    expected: expected.size,
    actual: actual.size,
    intersection,
    jaccard: union === 0 ? 1 : intersection / union,
    missing: missing.slice(0, 10),
    unexpected: unexpected.slice(0, 10),
  };
}

function parseArgs(): {
  sample: number;
  seed: string;
  v1DatabaseUrl?: string;
} {
  const command = new Command()
    .name('image-audit')
    .description('只读比较 v1/v2 当前页面图片 URL 集合')
    .option('--sample <n>', '抽样有图页面数', '100')
    .option('--seed <text>', '稳定抽样 seed', 'syncer2-image-v1')
    .option('--v1-database-url <url>', 'v1 主库连接串（事务强制 READ ONLY）')
    .parse();
  const raw = command.opts<{
    sample: string;
    seed: string;
    v1DatabaseUrl?: string;
  }>();
  const sample = Number(raw.sample);
  if (!Number.isInteger(sample) || sample < 1 || sample > 1_000) {
    throw new RangeError(`--sample 必须是 1..1000 的整数，收到 ${raw.sample}`);
  }
  return {
    sample,
    seed: raw.seed,
    v1DatabaseUrl: raw.v1DatabaseUrl,
  };
}

await main();
