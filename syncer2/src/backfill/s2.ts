/**
 * v1 → v2 回填 S2（内容与修订）。
 *
 * 默认/--dry-run：源库和目标库都由 startup option 强制只读，只报告当前快照。
 * --execute：源库仍强制只读；目标按 page_id 分批提交，并在同一事务推进
 * meta.backfill_progress(domain='s2_content_revision')。
 */

import { Command } from 'commander';
import type { PoolClient, QueryResultRow } from 'pg';
import { Pool } from 'pg';

import { loadConfig, loadEnv } from '../config.js';
import { HttpClient } from '../http/client.js';
import { scanCurrentContents } from '../collect/source.js';
import { normalizeV1Url } from './s1-model.js';
import {
  basisRank,
  buildContentBlobPlan,
  buildOverrideBlobPlan,
  sha256Hex,
  S2_PROGRESS_DOMAIN,
  type ContentBlobPlan,
  type HtmlOverride,
  type TextContentBasis,
  type V1ContentCandidate,
} from './s2-model.js';
import { REVISION_COUNT_OFFSET } from '../collect/revisionCount.js';

const PROTECTED_TARGETS = new Set(['scpper-cn', 'scpper_cn', 'scpper-syncer', 'scpper_user']);
const REQUIRED_MIGRATION_COLUMN = 'text_content_basis';
const SOURCE_NAME = 'v1_backfill';

type ProgressShard = 'content_blob' | 'page_source' | 'revision';

interface CliOptions {
  execute: boolean;
  batchSize: number;
  blobBatchSize: number;
  httpConcurrency: number;
  v1DatabaseUrl: string;
  targetDatabaseUrl: string;
  json: boolean;
}

interface SourceStats {
  pages: number;
  users: number;
  pageVersions: number;
  pageVersionsWithSource: number;
  contentBlobs: number;
  duplicateSourceRows: number;
  duplicateSourcePercent: number;
  pageSources: number;
  currentTextEmpty: number;
  currentSourceWithoutText: number;
  deletedTextEmpty: number;
  deletedSourceFallback: number;
  deletedUnrecoverable: number;
  liveHtmlRequired: number;
  canonicalHtmlBlobs: number;
  canonicalCromBlobs: number;
  canonicalFallbackBlobs: number;
  revisionRaw: number;
  revisionDistinctPairs: number;
  revisionAcceptedWids: number;
  revisionCrossPageConflicts: number;
  revisionUnknownRaw: number;
  revisionUnknownSelected: number;
  revisionUnknownAccepted: number;
  revisionPages: number;
  revisionClaimsChecked: number;
  revisionClaimsMatched: number;
  revisionClaimsMismatched: number;
  authorIdsMissingFromUsers: number;
}

interface TargetStats {
  pages: number;
  users: number;
  contentBlobs: number;
  pageSources: number;
  revisions: number;
  migrationReady: boolean;
  frozenDomains: string[];
  progress: Array<{
    shard: string;
    last_page_id: number;
    done_count: string;
    total_count: string | null;
  }>;
}

interface Assertion {
  name: string;
  ok: boolean;
  actual: string;
}

interface DryRunReport {
  mode: 'dry-run' | 'execute';
  sourceDatabase: string;
  targetDatabase: string;
  revisionCountOffset: number;
  expected: SourceStats;
  targetBefore: TargetStats;
  assertions: Assertion[];
  warnings: Assertion[];
  canExecute: boolean;
}

interface HtmlTargetRow {
  page_id: number;
  wikidot_id: number;
  current_url: string;
  source: string | null;
}

interface CanonicalBlobRow extends QueryResultRow, V1ContentCandidate {}

interface PageSourceRow extends QueryResultRow {
  page_id: number;
  rev_no: number | null;
  source_sha_hex: string;
  observed_at: string;
}

interface RevisionCursorRow extends QueryResultRow {
  page_id: number;
  page_wikidot_id: number;
  claimed_total: number | null;
  wikidot_revision_id: string;
  type: string;
  author_id: number | null;
  occurred_at: string;
  comment: string | null;
}

interface RevisionPayload {
  pageId: number;
  wikidotId: number;
  claimedTotal: number | null;
  revisions: Array<{
    wikidot_revision_id: string;
    rev_no: null;
    type: string;
    author_id: number | null;
    occurred_at: string;
    comment: string | null;
  }>;
}

function intOption(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`必须是正整数，拿到 ${value}`);
  }
  return parsed;
}

function databaseName(connectionString: string): string {
  const parsed = new URL(connectionString);
  const name = decodeURIComponent(parsed.pathname.replace(/^\/+/, ''));
  if (name === '') throw new Error('连接串缺数据库名');
  return name;
}

function mustEnv(...keys: string[]): string {
  for (const key of keys) {
    const value = process.env[key]?.trim();
    if (value) return value;
  }
  throw new Error(`缺连接串：设置 ${keys.join(' 或 ')}`);
}

function parseArgs(): CliOptions {
  loadEnv();
  const program = new Command();
  program
    .name('backfill-s2')
    .description('v1→v2 S2 内容/修订回填；默认 dry-run，--execute 才写目标库')
    .option('--execute', '正式按批写 v2', false)
    .option('--dry-run', '显式只读预演（默认）', false)
    .option('--batch-size <n>', '每个修订/page_source 目标事务最多页面数', intOption, 250)
    .option('--blob-batch-size <n>', '每个 content_blob 目标事务最多 blob 数', intOption, 50)
    .option('--http-concurrency <n>', '存活空正文整页抓取并发', intOption, 2)
    .option('--v1-database-url <url>', 'v1 scpper-cn 连接串（始终强制只读）')
    .option('--target-database-url <url>', 'v2 scpper-v2 连接串')
    .option('--json', '只输出 JSON 报告', false);
  program.parse(process.argv);
  const raw = program.opts<{
    execute: boolean;
    dryRun: boolean;
    batchSize: number;
    blobBatchSize: number;
    httpConcurrency: number;
    v1DatabaseUrl?: string;
    targetDatabaseUrl?: string;
    json: boolean;
  }>();
  if (raw.execute && raw.dryRun) throw new Error('--execute 与 --dry-run 不能同时给');
  return {
    execute: raw.execute,
    batchSize: raw.batchSize,
    blobBatchSize: raw.blobBatchSize,
    httpConcurrency: raw.httpConcurrency,
    v1DatabaseUrl:
      raw.v1DatabaseUrl ?? mustEnv('SYNCER2_V1_DATABASE_URL', 'V1_DATABASE_URL'),
    targetDatabaseUrl:
      raw.targetDatabaseUrl ?? mustEnv('SYNCER2_DATABASE_URL'),
    json: raw.json,
  };
}

function createBackfillPool(
  connectionString: string,
  opts: { readOnly: boolean; applicationName: string; max?: number },
): Pool {
  return new Pool({
    connectionString,
    max: opts.max ?? 1,
    idleTimeoutMillis: 5_000,
    connectionTimeoutMillis: 10_000,
    application_name: opts.applicationName,
    options: opts.readOnly
      ? '-c default_transaction_read_only=on -c statement_timeout=0'
      : '-c statement_timeout=0',
  });
}

function n(value: string | number | null | undefined): number {
  return Number(value ?? 0);
}

async function loadSourceStats(client: PoolClient): Promise<SourceStats> {
  const content = await client.query<Record<string, string>>(
    `WITH pv_source AS (
       SELECT pv.*, p."isDeleted" AS page_deleted,
              sha256(convert_to(pv.source, 'UTF8')) AS sha
         FROM public."PageVersion" pv
         JOIN public."Page" p ON p.id = pv."pageId"
        WHERE pv.source IS NOT NULL
     ), canonical AS (
       SELECT DISTINCT ON (sha)
              sha, "pageId", id, source, "textContent", "validTo", page_deleted,
              ("validTo" IS NULL AND NOT page_deleted
                AND ("textContent" IS NULL OR "textContent" = '')) AS wants_html
         FROM pv_source
        ORDER BY sha,
          CASE
            WHEN "validTo" IS NULL AND NOT page_deleted
              AND ("textContent" IS NULL OR "textContent" = '') THEN 0
            WHEN "textContent" IS NOT NULL AND "textContent" <> '' THEN 1
            ELSE 2
          END,
          ("validTo" IS NULL) DESC, "validFrom" DESC, id DESC
     ), current_pv AS (
       SELECT pv.*, p."isDeleted" AS page_deleted
         FROM public."PageVersion" pv
         JOIN public."Page" p ON p.id = pv."pageId"
        WHERE pv."validTo" IS NULL
     )
     SELECT
       (SELECT count(*) FROM public."Page")::text AS pages,
       (SELECT count(*) FROM public."User")::text AS users,
       (SELECT count(*) FROM public."PageVersion")::text AS page_versions,
       (SELECT count(*) FROM pv_source)::text AS page_versions_with_source,
       (SELECT count(*) FROM canonical)::text AS content_blobs,
       ((SELECT count(*) FROM pv_source) - (SELECT count(*) FROM canonical))::text
         AS duplicate_source_rows,
       (SELECT count(DISTINCT ("pageId", "revisionCount")) FROM pv_source)::text
         AS page_sources,
       (SELECT count(*) FROM current_pv
         WHERE "textContent" IS NULL OR "textContent" = '')::text AS current_text_empty,
       (SELECT count(*) FROM current_pv
         WHERE source IS NOT NULL
           AND ("textContent" IS NULL OR "textContent" = ''))::text AS current_source_without_text,
       (SELECT count(*) FROM current_pv
         WHERE page_deleted AND ("textContent" IS NULL OR "textContent" = ''))::text
         AS deleted_text_empty,
       (SELECT count(*) FROM current_pv
         WHERE page_deleted AND source IS NOT NULL
           AND ("textContent" IS NULL OR "textContent" = ''))::text
         AS deleted_source_fallback,
       (SELECT count(*) FROM current_pv
         WHERE page_deleted AND source IS NULL
           AND ("textContent" IS NULL OR "textContent" = ''))::text
         AS deleted_unrecoverable,
       (SELECT count(*) FROM current_pv
         WHERE NOT page_deleted
           AND ("textContent" IS NULL OR "textContent" = ''))::text
         AS live_html_required,
       (SELECT count(*) FROM canonical WHERE wants_html)::text AS canonical_html_blobs,
       (SELECT count(*) FROM canonical
         WHERE NOT wants_html AND "textContent" IS NOT NULL AND "textContent" <> '')::text
         AS canonical_crom_blobs,
       (SELECT count(*) FROM canonical
         WHERE NOT wants_html AND ("textContent" IS NULL OR "textContent" = ''))::text
         AS canonical_fallback_blobs`,
  );
  const c = content.rows[0]!;

  const revision = await client.query<Record<string, string>>(
    `WITH selected AS MATERIALIZED (
       SELECT DISTINCT ON (pv."pageId", r."wikidotId")
              pv."pageId" AS page_id, r."wikidotId" AS wid, r.type, r."userId" AS author_id
         FROM public."Revision" r
         JOIN public."PageVersion" pv ON pv.id = r."pageVersionId"
        ORDER BY pv."pageId", r."wikidotId",
                 pv."validFrom" DESC, pv.id DESC, r.id DESC
     ), accepted AS MATERIALIZED (
       SELECT DISTINCT ON (wid) page_id, wid, type
         FROM selected
        ORDER BY wid, page_id
     ), actual AS (
       SELECT page_id, count(*)::int AS actual FROM selected GROUP BY page_id
     ), current_claim AS (
       SELECT DISTINCT ON (pv."pageId")
              pv."pageId" AS page_id, pv."revisionCount" AS claimed
         FROM public."PageVersion" pv
        ORDER BY pv."pageId", (pv."validTo" IS NULL) DESC,
                 pv."validFrom" DESC, pv.id DESC
     )
     SELECT
       (SELECT count(*) FROM public."Revision")::text AS revision_raw,
       (SELECT count(*) FROM selected)::text AS revision_distinct_pairs,
       (SELECT count(*) FROM accepted)::text AS revision_accepted_wids,
       ((SELECT count(*) FROM selected) - (SELECT count(*) FROM accepted))::text
         AS revision_cross_page_conflicts,
       (SELECT count(*) FROM public."Revision" WHERE type='unknown')::text
         AS revision_unknown_raw,
       (SELECT count(*) FROM selected WHERE type='unknown')::text
         AS revision_unknown_selected,
       (SELECT count(*) FROM accepted WHERE type='unknown')::text
         AS revision_unknown_accepted,
       (SELECT count(*) FROM actual)::text AS revision_pages,
       (SELECT count(*) FROM actual a JOIN current_claim c USING(page_id)
         WHERE c.claimed IS NOT NULL)::text AS revision_claims_checked,
       (SELECT count(*) FROM actual a JOIN current_claim c USING(page_id)
         WHERE c.claimed IS NOT NULL AND a.actual = c.claimed + $1::int)::text
         AS revision_claims_matched,
       (SELECT count(*) FROM actual a JOIN current_claim c USING(page_id)
         WHERE c.claimed IS NOT NULL AND a.actual <> c.claimed + $1::int)::text
         AS revision_claims_mismatched,
       (SELECT count(DISTINCT s.author_id) FROM selected s
         LEFT JOIN public."User" u ON u.id=s.author_id
        WHERE s.author_id IS NOT NULL AND u.id IS NULL)::text AS author_ids_missing`,
    [REVISION_COUNT_OFFSET],
  );
  const r = revision.rows[0]!;
  const withSource = n(c.page_versions_with_source);
  const dup = n(c.duplicate_source_rows);
  return {
    pages: n(c.pages),
    users: n(c.users),
    pageVersions: n(c.page_versions),
    pageVersionsWithSource: withSource,
    contentBlobs: n(c.content_blobs),
    duplicateSourceRows: dup,
    duplicateSourcePercent: withSource === 0 ? 0 : Number(((100 * dup) / withSource).toFixed(1)),
    pageSources: n(c.page_sources),
    currentTextEmpty: n(c.current_text_empty),
    currentSourceWithoutText: n(c.current_source_without_text),
    deletedTextEmpty: n(c.deleted_text_empty),
    deletedSourceFallback: n(c.deleted_source_fallback),
    deletedUnrecoverable: n(c.deleted_unrecoverable),
    liveHtmlRequired: n(c.live_html_required),
    canonicalHtmlBlobs: n(c.canonical_html_blobs),
    canonicalCromBlobs: n(c.canonical_crom_blobs),
    canonicalFallbackBlobs: n(c.canonical_fallback_blobs),
    revisionRaw: n(r.revision_raw),
    revisionDistinctPairs: n(r.revision_distinct_pairs),
    revisionAcceptedWids: n(r.revision_accepted_wids),
    revisionCrossPageConflicts: n(r.revision_cross_page_conflicts),
    revisionUnknownRaw: n(r.revision_unknown_raw),
    revisionUnknownSelected: n(r.revision_unknown_selected),
    revisionUnknownAccepted: n(r.revision_unknown_accepted),
    revisionPages: n(r.revision_pages),
    revisionClaimsChecked: n(r.revision_claims_checked),
    revisionClaimsMatched: n(r.revision_claims_matched),
    revisionClaimsMismatched: n(r.revision_claims_mismatched),
    authorIdsMissingFromUsers: n(r.author_ids_missing),
  };
}

async function loadTargetStats(pool: Pool): Promise<TargetStats> {
  const [counts, migration, freezes, progress] = await Promise.all([
    pool.query<Record<string, string>>(
      `SELECT
         (SELECT count(*) FROM ingest.page)::text AS pages,
         (SELECT count(*) FROM ingest."user")::text AS users,
         (SELECT count(*) FROM ingest.content_blob)::text AS content_blobs,
         (SELECT count(*) FROM ingest.page_source)::text AS page_sources,
         (SELECT count(*) FROM ingest.revision)::text AS revisions`,
    ),
    pool.query<{ ok: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.columns
          WHERE table_schema='ingest' AND table_name='content_blob' AND column_name=$1
       ) AS ok`,
      [REQUIRED_MIGRATION_COLUMN],
    ),
    pool.query<{ domain: string }>(
      `SELECT domain FROM meta.write_freeze_status()
        WHERE effective AND domain IN ('all','content','revision')
        ORDER BY domain`,
    ),
    pool.query<{
      shard: string;
      last_page_id: number;
      done_count: string;
      total_count: string | null;
    }>(
      `SELECT shard,last_page_id,done_count::text,total_count::text
         FROM meta.backfill_progress WHERE domain=$1 ORDER BY shard`,
      [S2_PROGRESS_DOMAIN],
    ),
  ]);
  const row = counts.rows[0]!;
  return {
    pages: n(row.pages),
    users: n(row.users),
    contentBlobs: n(row.content_blobs),
    pageSources: n(row.page_sources),
    revisions: n(row.revisions),
    migrationReady: migration.rows[0]?.ok === true,
    frozenDomains: freezes.rows.map((x) => x.domain),
    progress: progress.rows,
  };
}

function buildReport(
  opts: CliOptions,
  sourceDb: string,
  targetDb: string,
  source: SourceStats,
  target: TargetStats,
): DryRunReport {
  const assertions: Assertion[] = [
    {
      name: '0201 S2 migration 已应用',
      ok: target.migrationReady,
      actual: target.migrationReady ? 'ready' : `missing ingest.content_blob.${REQUIRED_MIGRATION_COLUMN}`,
    },
    {
      name: 'S1 page 身份已完整',
      ok: target.pages === source.pages,
      actual: `v1=${source.pages}, v2=${target.pages}`,
    },
    {
      name: 'S1 user 身份已完整',
      ok: target.users === source.users,
      actual: `v1=${source.users}, v2=${target.users}`,
    },
    {
      name: 'Revision author_id 全可归属',
      ok: source.authorIdsMissingFromUsers === 0,
      actual: `missing=${source.authorIdsMissingFromUsers}`,
    },
    {
      name: 'content/revision 写闸未冻结',
      ok: target.frozenDomains.length === 0,
      actual: target.frozenDomains.join(',') || 'open',
    },
  ];
  const warnings: Assertion[] = [
    {
      name: `修订列表行数 = 声称数 + REVISION_COUNT_OFFSET(${REVISION_COUNT_OFFSET})`,
      ok: source.revisionClaimsMismatched === 0,
      actual:
        `checked=${source.revisionClaimsChecked}, matched=${source.revisionClaimsMatched}, ` +
        `mismatched=${source.revisionClaimsMismatched}`,
    },
    {
      name: '已删空正文有可恢复 source',
      ok: source.deletedUnrecoverable === 0,
      actual:
        `fallback=${source.deletedSourceFallback}, unrecoverable=${source.deletedUnrecoverable}`,
    },
  ];
  return {
    mode: opts.execute ? 'execute' : 'dry-run',
    sourceDatabase: sourceDb,
    targetDatabase: targetDb,
    revisionCountOffset: REVISION_COUNT_OFFSET,
    expected: source,
    targetBefore: target,
    assertions,
    warnings,
    canExecute: assertions.every((item) => item.ok),
  };
}

function printReport(report: DryRunReport, jsonOnly: boolean): void {
  if (!jsonOnly) {
    process.stdout.write(
      [
        `S2 ${report.mode}: ${report.sourceDatabase} → ${report.targetDatabase}`,
        `content: PageVersion(source)=${report.expected.pageVersionsWithSource}, ` +
          `blob=${report.expected.contentBlobs}, page_source=${report.expected.pageSources}, ` +
          `byte_dup=${report.expected.duplicateSourceRows} (${report.expected.duplicateSourcePercent}%)`,
        `text fix: live_html=${report.expected.liveHtmlRequired}, ` +
          `deleted_source_fallback=${report.expected.deletedSourceFallback}, ` +
          `deleted_unrecoverable=${report.expected.deletedUnrecoverable}`,
        `revision: raw=${report.expected.revisionRaw}, pair_distinct=${report.expected.revisionDistinctPairs}, ` +
          `accepted_wid=${report.expected.revisionAcceptedWids}, ` +
          `cross_page_quarantine=${report.expected.revisionCrossPageConflicts}`,
        `revision claims: +${REVISION_COUNT_OFFSET}, matched=${report.expected.revisionClaimsMatched}, ` +
          `mismatched=${report.expected.revisionClaimsMismatched}`,
        `canExecute=${report.canExecute}`,
        '',
      ].join('\n'),
    );
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

async function beginSourceSnapshot(client: PoolClient): Promise<string> {
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await client.query(`SET LOCAL TIME ZONE 'UTC'`);
  const result = await client.query<{ observed_at: string }>(
    `SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC',
                    'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS observed_at`,
  );
  return result.rows[0]!.observed_at;
}

async function ensureProgress(
  client: PoolClient,
  shard: ProgressShard,
  total: number,
): Promise<void> {
  await client.query(
    `INSERT INTO meta.backfill_progress(domain,shard,last_page_id,done_count,total_count)
     VALUES ($1,$2,0,0,$3)
     ON CONFLICT (domain,shard) DO UPDATE
       SET total_count=EXCLUDED.total_count, updated_at=now()`,
    [S2_PROGRESS_DOMAIN, shard, total],
  );
}

async function lockProgress(
  client: PoolClient,
  shard: ProgressShard,
): Promise<{ lastPageId: number; doneCount: number }> {
  const result = await client.query<{ last_page_id: number; done_count: string }>(
    `SELECT last_page_id,done_count::text
       FROM meta.backfill_progress
      WHERE domain=$1 AND shard=$2
      FOR UPDATE`,
    [S2_PROGRESS_DOMAIN, shard],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`缺 backfill_progress ${S2_PROGRESS_DOMAIN}/${shard}`);
  return { lastPageId: row.last_page_id, doneCount: n(row.done_count) };
}

async function readProgress(pool: Pool, shard: ProgressShard): Promise<number> {
  const result = await pool.query<{ last_page_id: number }>(
    `SELECT last_page_id FROM meta.backfill_progress WHERE domain=$1 AND shard=$2`,
    [S2_PROGRESS_DOMAIN, shard],
  );
  return result.rows[0]?.last_page_id ?? 0;
}

async function updateProgress(
  client: PoolClient,
  shard: ProgressShard,
  lastPageId: number,
  processedRows: number,
  total: number,
): Promise<void> {
  const progress = await lockProgress(client, shard);
  if (lastPageId < progress.lastPageId) {
    throw new Error(
      `${shard} progress 倒退：${lastPageId} < ${progress.lastPageId}`,
    );
  }
  await client.query(
    `UPDATE meta.backfill_progress
        SET last_page_id=$3,done_count=done_count+$4,total_count=$5,updated_at=now()
      WHERE domain=$1 AND shard=$2`,
    [S2_PROGRESS_DOMAIN, shard, lastPageId, processedRows, total],
  );
}

/**
 * server-side cursor 按 page_id 排序；只有确认读到下一个 page 后才交付前一页。
 * 因而 progress 永远落在完整 page 边界，崩溃恢复不会跳掉被 FETCH 切开的最后一页。
 */
async function* completePageBatches<R extends QueryResultRow>(
  client: PoolClient,
  cursor: string,
  fetchSize: number,
  pageId: (row: R) => number,
): AsyncGenerator<R[]> {
  let carry: R[] = [];
  for (;;) {
    const fetched = await client.query<R>(`FETCH FORWARD ${fetchSize} FROM ${cursor}`);
    const all = [...carry, ...fetched.rows];
    if (fetched.rows.length === 0) {
      if (all.length > 0) yield all;
      return;
    }
    const lastPage = pageId(all.at(-1)!);
    let split = all.length;
    while (split > 0 && pageId(all[split - 1]!) === lastPage) split--;
    if (split === 0) {
      carry = all;
      continue;
    }
    yield all.slice(0, split);
    carry = all.slice(split);
  }
}

async function loadHtmlOverrides(
  sourcePool: Pool,
  opts: CliOptions,
): Promise<Map<number, HtmlOverride>> {
  const rows = await sourcePool.query<HtmlTargetRow>(
    `SELECT p.id AS page_id,p."wikidotId" AS wikidot_id,p."currentUrl" AS current_url,
            pv.source
       FROM public."PageVersion" pv
       JOIN public."Page" p ON p.id=pv."pageId"
      WHERE pv."validTo" IS NULL
        AND NOT p."isDeleted"
        AND (pv."textContent" IS NULL OR pv."textContent"='')
      ORDER BY p.id`,
  );
  if (rows.rows.length === 0) return new Map();

  const config = loadConfig();
  const http = new HttpClient({
    userAgent: config.userAgent,
    referer: config.referer,
    proxyUrl: config.proxyUrl,
    timeoutMs: config.httpTimeoutMs,
    maxAttempts: config.httpMaxAttempts,
    breaker503: config.breaker503,
    breakerReset: config.breakerReset,
    connections: opts.httpConcurrency,
  });
  http.assertHeaders();
  try {
    const targets = rows.rows.map((row) => ({
      pageId: row.page_id,
      wikidotId: row.wikidot_id,
      slug: normalizeV1Url(row.current_url),
    }));
    const scanned = await scanCurrentContents(
      http,
      config.siteBaseUrl,
      targets,
      opts.httpConcurrency,
    );
    const failures: string[] = [];
    const overrides = new Map<number, HtmlOverride>();
    for (const row of rows.rows) {
      const result = scanned.get(row.page_id);
      if (!result || result.status !== 'ok') {
        failures.push(`page=${row.page_id}: ${result?.error ?? 'missing result'}`);
        continue;
      }
      overrides.set(row.page_id, {
        pageId: row.page_id,
        source: result.data.source,
        textContent: result.data.textContent,
      });
    }
    if (failures.length > 0) {
      throw new Error(
        `A1 整页 HTML 提取失败 ${failures.length}/${rows.rows.length}；零写入停止。` +
          `样本：${failures.slice(0, 8).join(' | ')}`,
      );
    }
    process.stderr.write(
      `[S2] A1 整页 HTML ${overrides.size}/${rows.rows.length} 成功；` +
        `HTTP=${JSON.stringify(http.stats())}\n`,
    );
    return overrides;
  } finally {
    await http.close();
  }
}

async function writeBlobBatch(
  pool: Pool,
  plans: readonly ContentBlobPlan[],
  lastPageId: number,
  total: number,
  advanceProgress: boolean,
): Promise<void> {
  if (plans.length === 0) return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL scpper.bypass_guard='on'`);
    const payload = JSON.stringify(
      plans.map((plan) => ({
        sha: plan.sha256Hex,
        source: plan.source,
        text_content: plan.textContent,
        basis: plan.basis,
      })),
    );
    await client.query(
      `WITH b AS (
         SELECT * FROM jsonb_to_recordset($1::jsonb)
           AS x(sha text,source text,text_content text,basis text)
       )
       INSERT INTO ingest.content_blob(
         sha256,source,text_content,byte_len,text_len,text_content_basis,created_at
       )
       SELECT decode(sha,'hex'),source,text_content,octet_length(source),
              length(text_content),basis,now()
         FROM b
       ON CONFLICT (sha256) DO NOTHING`,
      [payload],
    );
    const checked = await client.query<{
      sha: string;
      source_same: boolean;
      existing_basis: TextContentBasis;
      incoming_basis: TextContentBasis;
    }>(
      `WITH b AS (
         SELECT * FROM jsonb_to_recordset($1::jsonb)
           AS x(sha text,source text,text_content text,basis text)
       )
       SELECT b.sha,(cb.source IS NOT DISTINCT FROM b.source) AS source_same,
              cb.text_content_basis AS existing_basis,b.basis AS incoming_basis
         FROM b JOIN ingest.content_blob cb ON cb.sha256=decode(b.sha,'hex')`,
      [payload],
    );
    const bad = checked.rows.filter(
      (row) =>
        !row.source_same ||
        basisRank(row.existing_basis) < basisRank(row.incoming_basis),
    );
    if (bad.length > 0) {
      throw new Error(
        `content_blob sha 冲突/口径倒退 ${bad.length}：${JSON.stringify(bad.slice(0, 5))}`,
      );
    }
    if (advanceProgress) {
      await updateProgress(client, 'content_blob', lastPageId, plans.length, total);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function executeContentBlobs(
  sourcePool: Pool,
  targetPool: Pool,
  opts: CliOptions,
  stats: SourceStats,
  overrides: Map<number, HtmlOverride>,
): Promise<void> {
  const target = await targetPool.connect();
  try {
    await target.query('BEGIN');
    await ensureProgress(target, 'content_blob', stats.contentBlobs);
    await target.query('COMMIT');
  } finally {
    target.release();
  }

  // HTML 是最高口径，先写可保证后续同 sha 的 CROM/源码候选不会先占槽。
  const overridePlans = [...overrides.values()].map(buildOverrideBlobPlan);
  for (let i = 0; i < overridePlans.length; i += opts.blobBatchSize) {
    await writeBlobBatch(
      targetPool,
      overridePlans.slice(i, i + opts.blobBatchSize),
      0,
      stats.contentBlobs,
      false,
    );
  }

  const source = await sourcePool.connect();
  try {
    await beginSourceSnapshot(source);
    const last = await readProgress(targetPool, 'content_blob');
    await source.query(
      `DECLARE s2_blob_cursor NO SCROLL CURSOR FOR
       WITH candidates AS (
         SELECT pv.id AS v1_page_version_id,pv."pageId" AS canonical_page_id,
                pv.source,pv."textContent" AS text_content,
                pv."validTo",pv."validFrom",p."isDeleted" AS page_deleted,
                sha256(convert_to(pv.source,'UTF8')) AS sha,
                (pv."validTo" IS NULL AND NOT p."isDeleted"
                  AND (pv."textContent" IS NULL OR pv."textContent"='')) AS wants_html
           FROM public."PageVersion" pv
           JOIN public."Page" p ON p.id=pv."pageId"
          WHERE pv.source IS NOT NULL
       ), canonical AS (
         SELECT DISTINCT ON (sha)
                canonical_page_id,v1_page_version_id,source,text_content,wants_html,sha
           FROM candidates
          ORDER BY sha,
            CASE
              WHEN wants_html THEN 0
              WHEN text_content IS NOT NULL AND text_content<>'' THEN 1
              ELSE 2
            END,
            ("validTo" IS NULL) DESC,"validFrom" DESC,v1_page_version_id DESC
       )
       SELECT canonical_page_id,v1_page_version_id,source,text_content,wants_html
         FROM canonical
        WHERE canonical_page_id > $1
        ORDER BY canonical_page_id,sha`,
      [last],
    );
    for await (const rows of completePageBatches<CanonicalBlobRow>(
      source,
      's2_blob_cursor',
      opts.blobBatchSize,
      (row) => row.canonical_page_id,
    )) {
      const plans = rows.map((row) =>
        buildContentBlobPlan(row, overrides.get(row.canonical_page_id)),
      );
      await writeBlobBatch(
        targetPool,
        plans,
        rows.at(-1)!.canonical_page_id,
        stats.contentBlobs,
        true,
      );
    }
    await source.query('CLOSE s2_blob_cursor');
    await source.query('COMMIT');
  } catch (error) {
    await source.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    source.release();
  }
}

async function writePageSourceBatch(
  pool: Pool,
  rows: readonly PageSourceRow[],
  total: number,
): Promise<void> {
  if (rows.length === 0) return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL scpper.bypass_guard='on'`);
    const payload = JSON.stringify(rows);
    await client.query(
      `WITH b AS (
         SELECT * FROM jsonb_to_recordset($1::jsonb)
           AS x(page_id int,rev_no int,source_sha_hex text,observed_at timestamptz)
       )
       INSERT INTO ingest.page_source(page_id,rev_no,blob_sha,observed_at)
       SELECT page_id,rev_no,decode(source_sha_hex,'hex'),observed_at FROM b
       ON CONFLICT DO NOTHING`,
      [payload],
    );
    const conflict = await client.query<{
      page_id: number;
      rev_no: number;
      expected: string;
      actual: string;
    }>(
      `WITH b AS (
         SELECT * FROM jsonb_to_recordset($1::jsonb)
           AS x(page_id int,rev_no int,source_sha_hex text,observed_at timestamptz)
       )
       SELECT b.page_id,b.rev_no,b.source_sha_hex AS expected,encode(ps.blob_sha,'hex') AS actual
         FROM b JOIN ingest.page_source ps
           ON ps.page_id=b.page_id AND ps.rev_no=b.rev_no
        WHERE b.rev_no IS NOT NULL AND ps.blob_sha<>decode(b.source_sha_hex,'hex')`,
      [payload],
    );
    if (conflict.rows.length > 0) {
      throw new Error(
        `page_source 同 (page,rev_no) 指向不同 sha：${JSON.stringify(conflict.rows.slice(0, 5))}`,
      );
    }
    await updateProgress(
      client,
      'page_source',
      rows.at(-1)!.page_id,
      rows.length,
      total,
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function insertOverridePageSources(
  targetPool: Pool,
  overrides: Map<number, HtmlOverride>,
  observedAt: string,
): Promise<void> {
  const rows: PageSourceRow[] = [...overrides.values()]
    .sort((a, b) => a.pageId - b.pageId)
    .map((row) => ({
      page_id: row.pageId,
      rev_no: null,
      source_sha_hex: sha256Hex(row.source),
      observed_at: observedAt,
    }));
  if (rows.length === 0) return;
  const client = await targetPool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL scpper.bypass_guard='on'`);
    await client.query(
      `WITH b AS (
         SELECT * FROM jsonb_to_recordset($1::jsonb)
           AS x(page_id int,rev_no int,source_sha_hex text,observed_at timestamptz)
       )
       INSERT INTO ingest.page_source(page_id,rev_no,blob_sha,observed_at)
       SELECT page_id,NULL,decode(source_sha_hex,'hex'),observed_at FROM b
       ON CONFLICT DO NOTHING`,
      [JSON.stringify(rows)],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function executePageSources(
  sourcePool: Pool,
  targetPool: Pool,
  opts: CliOptions,
  stats: SourceStats,
  overrides: Map<number, HtmlOverride>,
): Promise<void> {
  const init = await targetPool.connect();
  try {
    await init.query('BEGIN');
    await ensureProgress(init, 'page_source', stats.pageSources);
    await init.query('COMMIT');
  } finally {
    init.release();
  }

  const source = await sourcePool.connect();
  try {
    const observedAt = await beginSourceSnapshot(source);
    await insertOverridePageSources(targetPool, overrides, observedAt);
    const last = await readProgress(targetPool, 'page_source');
    await source.query(
      `DECLARE s2_page_source_cursor NO SCROLL CURSOR FOR
       WITH chosen AS (
         SELECT DISTINCT ON (pv."pageId",pv."revisionCount")
                pv."pageId" AS page_id,pv."revisionCount" AS rev_no,
                encode(sha256(convert_to(pv.source,'UTF8')),'hex') AS source_sha_hex,
                to_char(pv."validFrom",'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS observed_at,
                pv.id
           FROM public."PageVersion" pv
          WHERE pv.source IS NOT NULL AND pv."pageId" > $1
          ORDER BY pv."pageId",pv."revisionCount",
                   (pv."validTo" IS NULL) DESC,pv."validFrom" DESC,pv.id DESC
       )
       SELECT page_id,rev_no,source_sha_hex,observed_at
         FROM chosen ORDER BY page_id,rev_no NULLS LAST,id`,
      [last],
    );
    for await (const rows of completePageBatches<PageSourceRow>(
      source,
      's2_page_source_cursor',
      Math.max(opts.batchSize, 500),
      (row) => row.page_id,
    )) {
      await writePageSourceBatch(targetPool, rows, stats.pageSources);
    }
    await source.query('CLOSE s2_page_source_cursor');
    await source.query('COMMIT');
  } catch (error) {
    await source.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    source.release();
  }
}

function groupRevisionRows(rows: readonly RevisionCursorRow[]): RevisionPayload[] {
  const pages: RevisionPayload[] = [];
  for (const row of rows) {
    let page = pages.at(-1);
    if (!page || page.pageId !== row.page_id) {
      page = {
        pageId: row.page_id,
        wikidotId: row.page_wikidot_id,
        claimedTotal: row.claimed_total,
        revisions: [],
      };
      pages.push(page);
    }
    page.revisions.push({
      wikidot_revision_id: row.wikidot_revision_id,
      rev_no: null,
      type: row.type,
      author_id: row.author_id,
      occurred_at: row.occurred_at,
      comment: row.comment,
    });
  }
  return pages;
}

async function writeRevisionBatch(
  pool: Pool,
  pages: readonly RevisionPayload[],
  runId: string,
  observedAt: string,
  total: number,
): Promise<void> {
  if (pages.length === 0) return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const payload = JSON.stringify(pages);
    await client.query(
      `WITH b AS (
         SELECT * FROM jsonb_to_recordset($1::jsonb)
           AS x("pageId" int,"wikidotId" int,"claimedTotal" int,revisions jsonb)
       )
       SELECT ingest.apply_revision_batch(
         "pageId",revisions,"claimedTotal",$2::timestamptz,$3,$4::bigint,"wikidotId"
       ) FROM b ORDER BY "pageId"`,
      [payload, observedAt, SOURCE_NAME, runId],
    );
    const rows = pages.reduce((sum, page) => sum + page.revisions.length, 0);
    await updateProgress(
      client,
      'revision',
      pages.at(-1)!.pageId,
      rows,
      total,
    );
    await client.query(`SELECT meta.ingest_gate_close()`);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function createBackfillRun(
  db: Pool | PoolClient,
  stats: SourceStats,
): Promise<string> {
  const result = await db.query<{ id: string }>(
    `INSERT INTO meta.ingest_run(source,status,started_at,pages_enumerated,remote_total,
                                 remote_total_source,batches_failed,stats)
     VALUES ($1,'running',now(),$2,$2,'unknown',0,$3::jsonb)
     RETURNING id::text`,
    [
      'v1_backfill_s2',
      stats.revisionPages,
      JSON.stringify({
        domain: S2_PROGRESS_DOMAIN,
        remote_total_basis: 'v1_snapshot',
        revision_count_offset: REVISION_COUNT_OFFSET,
        revision_distinct_pairs: stats.revisionDistinctPairs,
      }),
    ],
  );
  return result.rows[0]!.id;
}

async function executeRevisions(
  sourcePool: Pool,
  targetPool: Pool,
  opts: CliOptions,
  stats: SourceStats,
): Promise<string> {
  const init = await targetPool.connect();
  let runId: string | null = null;
  let alreadyComplete = false;
  try {
    await init.query('BEGIN');
    await ensureProgress(init, 'revision', stats.revisionDistinctPairs);
    await init.query('COMMIT');
    const progress = await init.query<{
      last_page_id: number;
      done_count: string;
      total_count: string;
    }>(
      `SELECT last_page_id,done_count::text,total_count::text
         FROM meta.backfill_progress
        WHERE domain=$1 AND shard='revision'`,
      [S2_PROGRESS_DOMAIN],
    );
    const p = progress.rows[0]!;
    alreadyComplete =
      p.last_page_id > 0 && n(p.done_count) >= n(p.total_count);

    // 部分失败后必须复用原 run：前面已提交的 page_scan 都挂在它上面。若另建 run，
    // 最终 62 个 partial 会被拆在多个 run 中，验收与事实都失去“一轮快照”的语义。
    const previous = await init.query<{ id: string; status: string }>(
      `SELECT id::text,status
         FROM meta.ingest_run
        WHERE source='v1_backfill_s2'
          AND stats ->> 'domain' = $1
        ORDER BY id DESC LIMIT 1`,
      [S2_PROGRESS_DOMAIN],
    );
    const prior = previous.rows[0];
    if (prior && (alreadyComplete || n(p.done_count) > 0 || prior.status === 'failed')) {
      runId = prior.id;
      if (!alreadyComplete) {
        await init.query(
          `UPDATE meta.ingest_run
              SET status='running',finished_at=NULL,
                  stats=stats - 'error'
            WHERE id=$1::bigint`,
          [runId],
        );
      }
    } else {
      // executeAll 另持 advisory-lock 连接；复用当前 worker，避免索取第三条连接。
      runId = await createBackfillRun(init, stats);
    }
  } finally {
    init.release();
  }
  if (alreadyComplete) return runId!;

  const source = await sourcePool.connect();
  try {
    const observedAt = await beginSourceSnapshot(source);
    const last = await readProgress(targetPool, 'revision');
    await source.query(
      `DECLARE s2_revision_cursor NO SCROLL CURSOR FOR
       WITH chosen AS (
         SELECT DISTINCT ON (pv."pageId",r."wikidotId")
                pv."pageId" AS page_id,p."wikidotId" AS page_wikidot_id,
                r."wikidotId"::text AS wikidot_revision_id,r.type,
                r."userId" AS author_id,
                to_char(r.timestamp,'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS occurred_at,
                r.comment
           FROM public."Revision" r
           JOIN public."PageVersion" pv ON pv.id=r."pageVersionId"
           JOIN public."Page" p ON p.id=pv."pageId"
          WHERE pv."pageId" > $1
          ORDER BY pv."pageId",r."wikidotId",
                   pv."validFrom" DESC,pv.id DESC,r.id DESC
       ), claims AS (
         SELECT DISTINCT ON (pv."pageId")
                pv."pageId" AS page_id,pv."revisionCount" AS claimed_total
           FROM public."PageVersion" pv
          WHERE pv."pageId" > $1
          ORDER BY pv."pageId",(pv."validTo" IS NULL) DESC,
                   pv."validFrom" DESC,pv.id DESC
       )
       SELECT c.*,cl.claimed_total
         FROM chosen c LEFT JOIN claims cl USING(page_id)
        ORDER BY c.page_id,c.wikidot_revision_id::bigint`,
      [last],
    );
    for await (const rows of completePageBatches<RevisionCursorRow>(
      source,
      's2_revision_cursor',
      5_000,
      (row) => row.page_id,
    )) {
      const pages = groupRevisionRows(rows);
      for (let i = 0; i < pages.length; i += opts.batchSize) {
        await writeRevisionBatch(
          targetPool,
          pages.slice(i, i + opts.batchSize),
          runId!,
          observedAt,
          stats.revisionDistinctPairs,
        );
      }
    }
    await source.query('CLOSE s2_revision_cursor');
    await source.query('COMMIT');
    await targetPool.query(
      `UPDATE meta.ingest_run
          SET status='ok',finished_at=now(),
              stats=stats || $2::jsonb
        WHERE id=$1::bigint`,
      [
        runId,
        JSON.stringify({
          completed: true,
          expected_distinct_pairs: stats.revisionDistinctPairs,
          expected_accepted_wids: stats.revisionAcceptedWids,
        }),
      ],
    );
    return runId!;
  } catch (error) {
    await source.query('ROLLBACK').catch(() => undefined);
    if (runId !== null) {
      await targetPool
        .query(
          `UPDATE meta.ingest_run
              SET status='failed',finished_at=now(),
                  stats=stats || jsonb_build_object('error',$2::text)
            WHERE id=$1::bigint`,
          [runId, String(error).slice(0, 2_000)],
        )
        .catch(() => undefined);
    }
    throw error;
  } finally {
    source.release();
  }
}

async function finalizeAndVerify(
  targetPool: Pool,
  stats: SourceStats,
  overrides: Map<number, HtmlOverride>,
  runId: string,
): Promise<Record<string, unknown>> {
  const client = await targetPool.connect();
  try {
    await client.query('BEGIN');
    const actual = await client.query<Record<string, string>>(
      `SELECT
         (SELECT count(*) FROM ingest.content_blob)::text AS blobs,
         (SELECT count(*) FROM ingest.page_source)::text AS page_sources,
         (SELECT count(*) FROM ingest.revision)::text AS revisions,
         (SELECT count(*) FROM ingest.revision WHERE type='unknown')::text AS unknown,
         (SELECT count(*) FROM ingest.revision
           WHERE source=$1 AND rev_no IS NOT NULL)::text AS nonnull_rev_no,
         (SELECT count(*) FROM ingest.content_blob
           WHERE text_content_basis='v1_source_fallback')::text AS source_fallback,
         (SELECT count(*) FROM ingest.content_blob
           WHERE text_content_basis='wikidot_html')::text AS html,
         (SELECT count(*) FROM meta.fact_quarantine
           WHERE domain='revision' AND source=$1
             AND reason='wid_bound_to_other_page')::text AS cross_page_quarantine,
         (SELECT count(*) FROM meta.page_scan
           WHERE run_id=$2::bigint AND kind='revisions' AND status='partial')::text
           AS partial_claims`,
      [SOURCE_NAME, runId],
    );
    const row = actual.rows[0]!;
    const failures: string[] = [];
    if (n(row.revisions) !== stats.revisionAcceptedWids) {
      failures.push(`revision=${row.revisions}, expected=${stats.revisionAcceptedWids}`);
    }
    if (n(row.unknown) !== stats.revisionUnknownAccepted) {
      failures.push(`unknown=${row.unknown}, expected=${stats.revisionUnknownAccepted}`);
    }
    if (n(row.nonnull_rev_no) !== 0) {
      failures.push(`v1_backfill rev_no 非空=${row.nonnull_rev_no}`);
    }
    if (n(row.cross_page_quarantine) !== stats.revisionCrossPageConflicts) {
      failures.push(
        `cross_page_quarantine=${row.cross_page_quarantine}, ` +
          `expected=${stats.revisionCrossPageConflicts}`,
      );
    }
    if (n(row.partial_claims) !== stats.revisionClaimsMismatched) {
      failures.push(
        `partial_claims=${row.partial_claims}, expected=${stats.revisionClaimsMismatched}`,
      );
    }
    if (n(row.blobs) < stats.contentBlobs) {
      failures.push(`content_blob=${row.blobs}, expected_at_least=${stats.contentBlobs}`);
    }
    if (n(row.page_sources) < stats.pageSources) {
      failures.push(`page_source=${row.page_sources}, expected_at_least=${stats.pageSources}`);
    }
    if (failures.length > 0) {
      throw new Error(`S2 验收失败：${failures.join('；')}`);
    }

    const metrics: Array<[string, number, Record<string, unknown>]> = [
      [
        'baseline.s2.content_blob',
        n(row.blobs),
        {
          v1_unique_source: stats.contentBlobs,
          // 完成后重跑会刻意跳过 364 次 HTTP；此时 overrides Map 为空，但事实表中
          // v1 mapping 之外的 page_source 正是此前成功提交的 HTML 当前观测。
          html_overrides: Math.max(0, n(row.page_sources) - stats.pageSources),
          duplicate_source_percent: stats.duplicateSourcePercent,
        },
      ],
      [
        'baseline.s2.page_source',
        n(row.page_sources),
        { v1_mappings: stats.pageSources },
      ],
      [
        'baseline.s2.revision_distinct',
        n(row.revisions),
        {
          pair_distinct: stats.revisionDistinctPairs,
          cross_page_quarantine: stats.revisionCrossPageConflicts,
        },
      ],
      [
        'baseline.s2.revision_count_offset',
        REVISION_COUNT_OFFSET,
        {
          claims_checked: stats.revisionClaimsChecked,
          claims_mismatched: stats.revisionClaimsMismatched,
        },
      ],
    ];
    await client.query(
      `WITH b AS (
         SELECT * FROM jsonb_to_recordset($1::jsonb)
           AS x(metric text,value numeric,detail jsonb)
       )
       INSERT INTO meta.v2_baseline(metric,value,detail,captured_at)
       SELECT metric,value,detail,now() FROM b
       ON CONFLICT (metric) DO UPDATE
         SET value=EXCLUDED.value,detail=EXCLUDED.detail,captured_at=EXCLUDED.captured_at`,
      [
        JSON.stringify(
          metrics.map(([metric, value, detail]) => ({ metric, value, detail })),
        ),
      ],
    );
    await client.query('COMMIT');
    return {
      contentBlobs: n(row.blobs),
      pageSources: n(row.page_sources),
      revisions: n(row.revisions),
      unknownTypes: n(row.unknown),
      htmlBlobs: n(row.html),
      sourceFallbackBlobs: n(row.source_fallback),
      crossPageQuarantine: n(row.cross_page_quarantine),
      claimMismatches: n(row.partial_claims),
      runId,
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function executeAll(
  sourcePool: Pool,
  targetPool: Pool,
  opts: CliOptions,
  stats: SourceStats,
): Promise<Record<string, unknown>> {
  const lock = await targetPool.connect();
  try {
    await lock.query(`SELECT pg_advisory_lock(hashtext('backfill:s2_content_revision'))`);
    const contentProgress = await lock.query<{ complete: boolean }>(
      `SELECT count(*)=2
              AND bool_and(done_count >= total_count)
              AND bool_and(last_page_id > 0) AS complete
         FROM meta.backfill_progress
        WHERE domain=$1 AND shard IN ('content_blob','page_source')`,
      [S2_PROGRESS_DOMAIN],
    );
    // 两个内容分片都完成时，重跑直接续 revision；重复打 364 次 Wikidot 请求既浪费，
    // 也会让“可重跑”变成对外部站点不幂等。
    const overrides = contentProgress.rows[0]?.complete
      ? new Map<number, HtmlOverride>()
      : await loadHtmlOverrides(sourcePool, opts);
    await executeContentBlobs(sourcePool, targetPool, opts, stats, overrides);
    await executePageSources(sourcePool, targetPool, opts, stats, overrides);
    const runId = await executeRevisions(sourcePool, targetPool, opts, stats);
    return await finalizeAndVerify(targetPool, stats, overrides, runId);
  } finally {
    await lock
      .query(`SELECT pg_advisory_unlock(hashtext('backfill:s2_content_revision'))`)
      .catch(() => undefined);
    lock.release();
  }
}

async function run(): Promise<void> {
  const opts = parseArgs();
  const sourceDb = databaseName(opts.v1DatabaseUrl);
  const targetDb = databaseName(opts.targetDatabaseUrl);
  if (!['scpper-cn', 'scpper_cn'].includes(sourceDb)) {
    throw new Error(`v1 源库必须是 scpper-cn/scpper_cn，拿到 ${sourceDb}`);
  }
  if (PROTECTED_TARGETS.has(targetDb)) {
    throw new Error(`拒绝把受保护库 ${targetDb} 当写入目标`);
  }
  if (sourceDb === targetDb) throw new Error('源库与目标库不能相同');

  const sourcePool = createBackfillPool(opts.v1DatabaseUrl, {
    readOnly: true,
    applicationName: 'syncer2-backfill-s2-source-ro',
  });
  const targetPool = createBackfillPool(opts.targetDatabaseUrl, {
    readOnly: !opts.execute,
    // executeAll 持一条 session advisory-lock 连接；第二条连接逐批事务写入。
    max: opts.execute ? 2 : 1,
    applicationName: opts.execute
      ? 'syncer2-backfill-s2-target'
      : 'syncer2-backfill-s2-target-ro',
  });
  let stats: SourceStats;
  const source = await sourcePool.connect();
  try {
    await beginSourceSnapshot(source);
    stats = await loadSourceStats(source);
    await source.query('COMMIT');
  } catch (error) {
    await source.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    // dry-run 统计快照到这里已经结束。execute 的 HTML/content/revision 各自再开
    // 独立只读快照；若把这条 max=1 连接一直握到函数末尾，下一阶段会连接超时。
    source.release();
  }

  try {
    const target = await loadTargetStats(targetPool);
    const report = buildReport(opts, sourceDb, targetDb, stats, target);
    printReport(report, opts.json);
    if (!opts.execute) return;
    if (!report.canExecute) {
      throw new Error(
        `S2 execute readiness 未通过：${report.assertions
          .filter((item) => !item.ok)
          .map((item) => `${item.name}(${item.actual})`)
          .join('；')}`,
      );
    }
    const result = await executeAll(sourcePool, targetPool, opts, stats);
    process.stdout.write(`${JSON.stringify({ executeResult: result }, null, 2)}\n`);
  } finally {
    await Promise.all([sourcePool.end(), targetPool.end()]);
  }
}

run().catch((error) => {
  process.stderr.write(`[S2] FAILED: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
