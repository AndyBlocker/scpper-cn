/**
 * v1 → v2 S3 vote backfill.
 *
 * Source reads are held in one REPEATABLE READ READ ONLY transaction.  The
 * source cursor emits one JSON plan per page so the 6.3m raw v1 rows are
 * scanned once without retaining the full plan in Node.  Each target batch
 * commits facts, Tier-1 projections, audit rows, quarantine rows and
 * meta.backfill_progress atomically.
 */

import fs from 'node:fs';
import path from 'node:path';

import { Command } from 'commander';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';

import { loadEnv } from '../config.js';
import { normalizeV1Url } from './s1-model.js';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '../..');
const PROGRESS_DOMAIN = 's3_vote';
const PROGRESS_SHARD = 'history';
const SOURCE_NAME = 'backfill_s3';
const PROTECTED_TARGETS = new Set(['scpper-cn', 'scpper_cn', 'scpper-syncer', 'scpper_user']);

interface Options {
  execute: boolean;
  batchSize: number;
  fetchSize: number;
  pauseMs: number;
  expectedEvents: number;
  expectedCurrent: number;
  tolerance: number;
  stateFile: string;
  v1DatabaseUrl: string;
  targetDatabaseUrl: string;
  json: boolean;
}

interface PageSourceRow extends QueryResultRow {
  page_id: number;
  wikidot_id: number;
  current_url: string;
  is_deleted: boolean;
  first_published_at: string | null;
  title: string | null;
  alternate_title: string | null;
  tags: string[] | null;
  category: string | null;
  search_text: string | null;
  current_rating: number | null;
  current_vote_count: number | null;
  last_nonnull_rating: number | null;
}

interface PagePlan {
  pageId: number;
  wikidotId: number;
  slug: string;
  isDeleted: boolean;
  firstPublishedAt: string | null;
  title: string | null;
  alternateTitle: string | null;
  tags: string[];
  category: string | null;
  searchText: string | null;
  currentRating: number | null;
  currentVoteCount: number | null;
  lastNonnullRating: number | null;
}

interface EventPlan {
  voter_id: number;
  kind: 'vote' | 'revote' | 'revoke';
  old_direction: -1 | 1 | null;
  new_direction: -1 | 1 | null;
  occurred_at: string;
  time_precision: 'exact' | 'day' | 'bootstrap';
  source: 'legacy' | 'v1_backfill';
  source_ref: string;
  event_order: number;
}

interface AuditPlan {
  v1_vote_id: number;
  rule: 'R1' | 'R2' | 'R3' | 'R5';
  kept_ref: string | null;
  confidence: 'high' | 'medium' | 'low';
  note: string;
}

interface QuarantinePlan {
  voter_key: string | null;
  raw: Record<string, unknown>;
  reason: string;
  source: string;
  occurred_at: string | null;
}

interface SourcePacketRow extends QueryResultRow {
  page_id: number;
  packet_kind: 'event' | 'audit' | 'quarantine' | 'end';
  packet_no: number;
  rows: EventPlan[] | AuditPlan[] | QuarantinePlan[];
}

interface StoredSnapshot {
  version: number;
  pageId: number;
  acceptedAsSeed: boolean;
  target: {
    pageId: number;
    wikidotId: number;
    claimedTotal: number;
    claimedRating: number;
  };
  outcome?: {
    data?: {
      checksum?: number;
      entries?: unknown[];
    };
  };
}

interface PageMetric {
  currentRows: number;
  rating: number;
  up: number;
  down: number;
  revoked: number;
}

interface Totals {
  pages: number;
  events: number;
  currentRows: number;
  audits: number;
  quarantines: number;
  eventSources: Record<string, number>;
  eventKinds: Record<string, number>;
  auditRules: Record<string, number>;
  quarantineReasons: Record<string, number>;
}

const SOURCE_PLAN_SQL = String.raw`
WITH
v1_raw AS MATERIALIZED (
  SELECT v.id AS v1_id,
         v."pageVersionId" AS page_version_id,
         pv."pageId" AS page_id,
         COALESCE(v."userId"::text, 'a:' || v."anonKey") AS voter,
         v."userId" AS user_id,
         v.timestamp AS ts,
         v.direction AS raw_dir,
         sign(v.direction)::int AS dir,
         pv."validFrom" AS valid_from,
         p."isDeleted" AS is_deleted
    FROM public."Vote" v
    JOIN public."PageVersion" pv ON pv.id=v."pageVersionId"
    JOIN public."Page" p ON p.id=pv."pageId"
   WHERE pv."pageId" > $1
),
r1_ranked AS MATERIALIZED (
  SELECT *,
         row_number() OVER (
           PARTITION BY page_id,voter,ts
           ORDER BY valid_from DESC NULLS LAST,v1_id DESC
         ) AS rn,
         first_value(v1_id) OVER (
           PARTITION BY page_id,voter,ts
           ORDER BY valid_from DESC NULLS LAST,v1_id DESC
         ) AS kept_v1_id,
         count(*) OVER (PARTITION BY page_id,voter,ts) AS group_n,
         min(dir) OVER (PARTITION BY page_id,voter,ts) AS group_min_dir,
         max(dir) OVER (PARTITION BY page_id,voter,ts) AS group_max_dir
    FROM v1_raw
),
r1 AS MATERIALIZED (
  SELECT * FROM r1_ranked WHERE rn=1
),
r2_groups AS MATERIALIZED (
  SELECT page_id,voter,dir,
         array_agg(v1_id ORDER BY ts,v1_id) AS ids,
         array_agg(ts ORDER BY ts,v1_id) AS tses,
         bool_or(is_deleted) AS is_deleted,
         count(*)::int AS n
    FROM r1
   WHERE dir<>0
   GROUP BY page_id,voter,dir
),
r2_candidates AS MATERIALIZED (
  SELECT *
    FROM r2_groups
   WHERE n=2
     AND abs(extract(epoch FROM (tses[2]-tses[1]))-28800)<=1
),
r2_log_pages AS MATERIALIZED (
  SELECT DISTINCT pv."pageId" AS page_id
    FROM public.vote_tz_dup_cleanup_log l
    JOIN public."PageVersion" pv ON pv.id=l."pageVersionId"
),
r2_bounds AS MATERIALIZED (
  SELECT min(ts_kept) AS lo,max(ts_deleted) AS hi
    FROM public.vote_tz_dup_cleanup_log
),
r2_classified AS MATERIALIZED (
  SELECT c.*,
         EXISTS (SELECT 1 FROM r2_log_pages lp WHERE lp.page_id=c.page_id)
         AND c.tses[1]>=(SELECT lo FROM r2_bounds)
         AND c.tses[2]<=(SELECT hi FROM r2_bounds) AS has_evidence
    FROM r2_candidates c
),
r2_auto_delete AS MATERIALIZED (
  SELECT page_id,voter,ids[1] AS kept_v1_id,ids[2] AS v1_id,tses[2] AS ts
    FROM r2_classified
   WHERE has_evidence AND NOT is_deleted
),
r3_pairs AS MATERIALIZED (
  SELECT *
    FROM (
      SELECT page_id,voter,dir,ts,v1_id,
             lag(ts) OVER (
               PARTITION BY page_id,voter,dir ORDER BY ts,v1_id
             ) AS prev_ts,
             lag(v1_id) OVER (
               PARTITION BY page_id,voter,dir ORDER BY ts,v1_id
             ) AS prev_id
        FROM r1
       WHERE dir<>0
         AND ts>=timestamp '2022-05-14 00:00:00'
         AND ts< timestamp '2022-06-01 00:00:00'
    ) x
   WHERE ts-prev_ts BETWEEN interval '0' AND interval '48 hours'
),
legacy_raw AS MATERIALIZED (
  SELECT 'history'::text AS source_table,h."__Id" AS source_id,
         h."PageId" AS page_wid,h."UserId" AS user_wid,
         h."DateTime" AS ts,h."Value" AS raw_dir,0 AS priority
    FROM legacy_votes_cn.vote_history h
  UNION ALL
  SELECT 'votes',v."__Id",v."PageId",v."UserId",
         v."DateTime",v."Value",1
    FROM legacy_votes_cn.votes v
),
legacy_dedup AS MATERIALIZED (
  SELECT DISTINCT ON (page_wid,user_wid,ts) *
    FROM legacy_raw
   ORDER BY page_wid,user_wid,ts,priority DESC,source_id DESC
),
legacy_mapped AS MATERIALIZED (
  SELECT p.id AS page_id,u.id AS user_id,u.id::text AS voter,
         l.ts,sign(l.raw_dir)::int AS dir,l.raw_dir,
         l.source_table,l.source_id
    FROM legacy_dedup l
    JOIN public."Page" p ON p."wikidotId"=l.page_wid
    JOIN public."User" u ON u."wikidotId"=l.user_wid
   WHERE p.id>$1
),
observations AS MATERIALIZED (
  SELECT 0 AS segment,page_id,voter,user_id,ts,dir,raw_dir,
         ('legacy:'||source_table||':'||source_id)::text AS ref,
         'legacy'::text AS source,'exact'::text AS time_precision,
         NULL::bigint AS v1_vote_id
    FROM legacy_mapped
   WHERE ts<timestamptz '2022-06-01 00:00:00+00'
  UNION ALL
  SELECT 1,r.page_id,r.voter,r.user_id,
         r.ts AT TIME ZONE 'Asia/Shanghai',r.dir,r.raw_dir,
         ('v1:'||r.v1_id)::text,'v1_backfill',
         CASE WHEN r.ts=timestamp '2022-05-25 00:00:00'
              THEN 'bootstrap' ELSE 'day' END,
         r.v1_id
    FROM r1 r
   WHERE r.ts>=timestamp '2022-06-01 00:00:00'
     AND NOT EXISTS (SELECT 1 FROM r2_auto_delete d WHERE d.v1_id=r.v1_id)
),
ordered AS MATERIALIZED (
  SELECT *,
         lag(dir) OVER (
           PARTITION BY page_id,voter ORDER BY segment,ts,ref
         ) AS prev_dir,
         lag(ref) OVER (
           PARTITION BY page_id,voter ORDER BY segment,ts,ref
         ) AS prev_ref
    FROM observations
),
events0 AS MATERIALIZED (
  SELECT *,
         CASE WHEN dir=0 THEN 'revoke'
              WHEN coalesce(prev_dir,0)=0 THEN 'vote'
              ELSE 'revote' END AS kind
    FROM ordered
   WHERE dir<>coalesce(prev_dir,0)
),
events AS MATERIALIZED (
  SELECT *,
         row_number() OVER (
           ORDER BY page_id,segment,ts,ref,voter
         )::int AS event_order
    FROM events0
),
audits AS MATERIALIZED (
  SELECT page_id,v1_id::bigint AS v1_vote_id,'R1'::text AS rule,
         ('v1:'||kept_v1_id)::text AS kept_ref,'high'::text AS confidence,
         format('same page+voter+timestamp; kept latest PageVersion vote v1:%s',kept_v1_id) AS note
    FROM r1_ranked
   WHERE rn>1
  UNION ALL
  SELECT page_id,v1_id,'R2',('v1:'||kept_v1_id),'high',
         'proven +8h duplicate in vote_tz_dup_cleanup_log envelope; live page folded'
    FROM r2_auto_delete
  UNION ALL
  SELECT page_id,ids[2]::bigint,'R2',('v1:'||ids[1]),'low',
         'proven +8h duplicate on deleted page; audit only, not folded'
    FROM r2_classified
   WHERE has_evidence AND is_deleted
  UNION ALL
  SELECT page_id,v1_id,'R3',('v1:'||prev_id),'low',
         'same-direction pair within 48h in May seam; retained for review'
    FROM r3_pairs
  UNION ALL
  SELECT page_id,v1_vote_id,'R5',prev_ref,'high',
         'same-state CROM observation absorbed by seeded state machine'
    FROM ordered
   WHERE v1_vote_id IS NOT NULL
     AND dir=coalesce(prev_dir,0)
),
quarantines AS MATERIALIZED (
  SELECT page_id,voter AS voter_key,
         jsonb_build_object(
           'v1_vote_id',v1_id,'kept_v1_vote_id',kept_v1_id,
           'timestamp',ts,'min_direction',group_min_dir,
           'max_direction',group_max_dir,'group_rows',group_n
         ) AS raw,
         'r1_cross_version_direction_conflict'::text AS reason,
         'v1_backfill'::text AS source,
         ts AT TIME ZONE 'Asia/Shanghai' AS occurred_at
    FROM r1
   WHERE group_min_dir<>group_max_dir
  UNION ALL
  SELECT page_id,voter,
         jsonb_build_object('v1_vote_ids',ids,'timestamps',tses,'direction',dir),
         'unproven_8h_duplicate','v1_backfill',
         tses[2] AT TIME ZONE 'Asia/Shanghai'
    FROM r2_classified
   WHERE NOT has_evidence
  UNION ALL
  SELECT page_id,voter,
         jsonb_build_object('v1_vote_id',v1_id,'raw_direction',raw_dir),
         'direction_out_of_range','v1_backfill',
         ts AT TIME ZONE 'Asia/Shanghai'
    FROM v1_raw
   WHERE raw_dir IN (-2,2)
),
event_pages AS MATERIALIZED (
  SELECT page_id,
         jsonb_agg(
           jsonb_build_object(
             'voter_id',user_id,'kind',kind,
             'old_direction',NULLIF(prev_dir,0),'new_direction',NULLIF(dir,0),
             'occurred_at',to_char(ts AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
             'time_precision',time_precision,'source',source,
             'source_ref',ref,'event_order',event_order
           )
           ORDER BY event_order
         ) AS rows
    FROM events
   GROUP BY page_id
),
audit_ranked AS MATERIALIZED (
  SELECT *,
         ((row_number() OVER (
             PARTITION BY page_id ORDER BY rule,v1_vote_id,kept_ref
           )-1)/2000)::int AS packet_no
    FROM audits
),
audit_packets AS MATERIALIZED (
  SELECT page_id,packet_no,
         jsonb_agg(
           jsonb_build_object(
             'v1_vote_id',v1_vote_id,'rule',rule,'kept_ref',kept_ref,
             'confidence',confidence,'note',note
           )
           ORDER BY rule,v1_vote_id,kept_ref
         ) AS rows
    FROM audit_ranked
   GROUP BY page_id,packet_no
),
quarantine_pages AS MATERIALIZED (
  SELECT page_id,
         jsonb_agg(
           jsonb_build_object(
             'voter_key',voter_key,'raw',raw,'reason',reason,'source',source,
             'occurred_at',CASE WHEN occurred_at IS NULL THEN NULL
                                ELSE to_char(occurred_at AT TIME ZONE 'UTC',
                                             'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END
           )
           ORDER BY reason,voter_key
         ) AS rows
    FROM quarantines
   GROUP BY page_id
),
packets AS MATERIALIZED (
  SELECT page_id,'event'::text AS packet_kind,0::int AS packet_no,rows
    FROM event_pages
  UNION ALL
  SELECT page_id,'audit',packet_no,rows FROM audit_packets
  UNION ALL
  SELECT page_id,'quarantine',0,rows FROM quarantine_pages
  UNION ALL
  SELECT id,'end',0,'[]'::jsonb FROM public."Page" WHERE id>$1
)
SELECT page_id,packet_kind,packet_no,rows
  FROM packets
 ORDER BY page_id,
          CASE packet_kind WHEN 'event' THEN 0
                           WHEN 'audit' THEN 1
                           WHEN 'quarantine' THEN 2
                           ELSE 3 END,
          packet_no
`;

function positiveInt(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`必须是正整数，拿到 ${value}`);
  return parsed;
}

function nonnegativeInt(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`必须是非负整数，拿到 ${value}`);
  return parsed;
}

function positiveNumber(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`必须是正数，拿到 ${value}`);
  return parsed;
}

function mustEnv(...keys: string[]): string {
  for (const key of keys) {
    const value = process.env[key]?.trim();
    if (value) return value;
  }
  throw new Error(`缺连接串：设置 ${keys.join(' 或 ')}`);
}

function databaseName(connectionString: string): string {
  return decodeURIComponent(new URL(connectionString).pathname.replace(/^\/+/, ''));
}

function parseArgs(): Options {
  loadEnv();
  const program = new Command();
  program
    .name('backfill-s3')
    .description('v1→v2 S3 投票历史回填；默认只读，--execute 才写目标库')
    .option('--execute', '正式分批写 v2', false)
    .option('--dry-run', '显式只读预演（默认）', false)
    .option('--batch-size <n>', '每个目标事务的页面数', positiveInt, 50)
    .option('--fetch-size <n>', '源 cursor 每次抓取的计划分片数', positiveInt, 200)
    .option('--pause-ms <n>', '目标批次间停顿', nonnegativeInt, 75)
    .option('--expected-events <n>', '签核预期事件数', positiveInt, 1_339_387)
    .option('--expected-current <n>', '签核预期 vote_current 行数', positiveInt, 1_329_867)
    .option('--tolerance <ratio>', '事件/终态硬停相对偏差', positiveNumber, 0.02)
    .option('--state-file <path>', '已签核 live gate NDJSON 种子')
    .option('--v1-database-url <url>', 'v1 scpper-cn（始终强制只读）')
    .option('--target-database-url <url>', 'v2 scpper-v2')
    .option('--json', '只输出 JSON', false);
  program.parse(process.argv);
  const raw = program.opts<{
    execute: boolean;
    dryRun: boolean;
    batchSize: number;
    fetchSize: number;
    pauseMs: number;
    expectedEvents: number;
    expectedCurrent: number;
    tolerance: number;
    stateFile?: string;
    v1DatabaseUrl?: string;
    targetDatabaseUrl?: string;
    json: boolean;
  }>();
  if (raw.execute && raw.dryRun) throw new Error('--execute 与 --dry-run 不能同时给');
  if (raw.tolerance >= 1) throw new Error('--tolerance 必须小于 1');
  return {
    execute: raw.execute,
    batchSize: raw.batchSize,
    fetchSize: raw.fetchSize,
    pauseMs: raw.pauseMs,
    expectedEvents: raw.expectedEvents,
    expectedCurrent: raw.expectedCurrent,
    tolerance: raw.tolerance,
    stateFile:
      raw.stateFile ?? path.join(PROJECT_ROOT, 'state', 's3-live-votes-2026-07-28.ndjson'),
    v1DatabaseUrl:
      raw.v1DatabaseUrl ?? mustEnv('SYNCER2_V1_DATABASE_URL', 'V1_DATABASE_URL', 'DATABASE_URL'),
    targetDatabaseUrl: raw.targetDatabaseUrl ?? mustEnv('SYNCER2_DATABASE_URL'),
    json: raw.json,
  };
}

function createPool(
  connectionString: string,
  readOnly: boolean,
  applicationName: string,
  max = 1,
): Pool {
  return new Pool({
    connectionString,
    max,
    idleTimeoutMillis: 5_000,
    connectionTimeoutMillis: 10_000,
    application_name: applicationName,
    options: readOnly
      ? '-c default_transaction_read_only=on -c statement_timeout=0'
      : '-c statement_timeout=0',
  });
}

function asNumber(value: string | number | null | undefined): number {
  return Number(value ?? 0);
}

function increment(target: Record<string, number>, key: string, amount = 1): void {
  target[key] = (target[key] ?? 0) + amount;
}

function emptyTotals(): Totals {
  return {
    pages: 0,
    events: 0,
    currentRows: 0,
    audits: 0,
    quarantines: 0,
    eventSources: {},
    eventKinds: {},
    auditRules: {},
    quarantineReasons: {},
  };
}

async function beginSourceSnapshot(client: PoolClient): Promise<string> {
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await client.query(`SET LOCAL TIME ZONE 'UTC'`);
  await client.query(`SET LOCAL work_mem='256MB'`);
  const result = await client.query<{ observed_at: string }>(
    `SELECT to_char(transaction_timestamp(),'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS observed_at`,
  );
  return result.rows[0]!.observed_at;
}

async function loadPages(client: PoolClient): Promise<PagePlan[]> {
  const result = await client.query<PageSourceRow>(
    `WITH current_pv AS (
       SELECT DISTINCT ON (pv."pageId")
              pv."pageId" AS page_id,pv.title,pv."alternateTitle" AS alternate_title,
              pv.tags,pv.category,pv.search_text,pv.rating AS current_rating,
              pv."voteCount" AS current_vote_count
         FROM public."PageVersion" pv
        WHERE pv."validTo" IS NULL
        ORDER BY pv."pageId",pv."validFrom" DESC NULLS LAST,pv.id DESC
     ), last_nonnull AS (
       SELECT DISTINCT ON (pv."pageId") pv."pageId" AS page_id,pv.rating
         FROM public."PageVersion" pv
        WHERE pv.rating IS NOT NULL
        ORDER BY pv."pageId",pv."validFrom" DESC NULLS LAST,pv.id DESC
     )
     SELECT p.id AS page_id,p."wikidotId" AS wikidot_id,p."currentUrl" AS current_url,
            p."isDeleted" AS is_deleted,
            CASE WHEN p."firstPublishedAt" IS NULL THEN NULL
                 ELSE to_char(p."firstPublishedAt",
                              'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END AS first_published_at,
            cp.title,cp.alternate_title,cp.tags,cp.category,cp.search_text,
            cp.current_rating,cp.current_vote_count,ln.rating AS last_nonnull_rating
       FROM public."Page" p
       JOIN current_pv cp ON cp.page_id=p.id
       LEFT JOIN last_nonnull ln ON ln.page_id=p.id
      ORDER BY p.id`,
  );
  return result.rows.map((row) => ({
    pageId: asNumber(row.page_id),
    wikidotId: asNumber(row.wikidot_id),
    slug: normalizeV1Url(row.current_url),
    isDeleted: row.is_deleted,
    firstPublishedAt: row.first_published_at,
    title: row.title,
    alternateTitle: row.alternate_title,
    tags: row.tags ?? [],
    category: row.category,
    searchText: row.search_text,
    currentRating: row.current_rating === null ? null : asNumber(row.current_rating),
    currentVoteCount:
      row.current_vote_count === null ? null : asNumber(row.current_vote_count),
    lastNonnullRating:
      row.last_nonnull_rating === null ? null : asNumber(row.last_nonnull_rating),
  }));
}

async function targetPreflight(pool: Pool, execute: boolean): Promise<Record<string, number | boolean>> {
  const result = await pool.query<Record<string, string | boolean>>(
    `SELECT
       current_database()='scpper-v2' AS target_ok,
       to_regclass('ingest.vote_event') IS NOT NULL
         AND to_regclass('serve.vote_current') IS NOT NULL
         AND to_regclass('serve.page_current') IS NOT NULL
         AND to_regclass('meta.dedup_audit') IS NOT NULL
         AND to_regclass('meta.vote_quarantine') IS NOT NULL
         AND to_regclass('meta.backfill_progress') IS NOT NULL AS schema_ok,
       (SELECT count(*) FROM ingest.page)::text AS pages,
       (SELECT count(*) FROM ingest."user")::text AS users,
       (SELECT count(*) FROM ingest.vote_event)::text AS events,
       (SELECT count(*) FROM serve.vote_current)::text AS current_rows,
       (SELECT count(*) FROM serve.page_current)::text AS page_current,
       (SELECT count(*) FROM meta.dedup_audit)::text AS audits,
       (SELECT count(*) FROM meta.vote_quarantine)::text AS quarantines,
       (SELECT count(*) FROM meta.ingest_run
         WHERE source=$1)::text AS runs,
       (SELECT count(*) FROM meta.write_freeze_status()
         WHERE effective AND domain IN ('all','vote','page'))::text AS blocking_freezes`,
    [SOURCE_NAME],
  );
  const row = result.rows[0]!;
  const report = {
    targetOk: row.target_ok === true,
    schemaOk: row.schema_ok === true,
    pages: asNumber(row.pages as string),
    users: asNumber(row.users as string),
    events: asNumber(row.events as string),
    currentRows: asNumber(row.current_rows as string),
    pageCurrent: asNumber(row.page_current as string),
    audits: asNumber(row.audits as string),
    quarantines: asNumber(row.quarantines as string),
    runs: asNumber(row.runs as string),
    blockingFreezes: asNumber(row.blocking_freezes as string),
  };
  if (execute && (!report.targetOk || !report.schemaOk || report.blockingFreezes !== 0)) {
    throw new Error(`S3 target preflight 未通过：${JSON.stringify(report)}`);
  }
  return report;
}

async function readProgress(pool: Pool): Promise<{
  lastPageId: number;
  doneCount: number;
  totalCount: number | null;
}> {
  const result = await pool.query<{
    last_page_id: number;
    done_count: string;
    total_count: string | null;
  }>(
    `SELECT last_page_id,done_count::text,total_count::text
       FROM meta.backfill_progress
      WHERE domain=$1 AND shard=$2`,
    [PROGRESS_DOMAIN, PROGRESS_SHARD],
  );
  const row = result.rows[0];
  return {
    lastPageId: row?.last_page_id ?? 0,
    doneCount: asNumber(row?.done_count),
    totalCount: row?.total_count === null || row?.total_count === undefined
      ? null
      : asNumber(row.total_count),
  };
}

async function ensureProgress(pool: Pool, expectedEvents: number): Promise<void> {
  await pool.query(
    `INSERT INTO meta.backfill_progress(
       domain,shard,last_page_id,done_count,total_count
     ) VALUES ($1,$2,0,0,$3)
     ON CONFLICT(domain,shard) DO UPDATE
       SET total_count=CASE
         WHEN meta.backfill_progress.done_count=0 THEN EXCLUDED.total_count
         ELSE meta.backfill_progress.total_count
       END,
       updated_at=now()`,
    [PROGRESS_DOMAIN, PROGRESS_SHARD, expectedEvents],
  );
}

async function ensurePageCurrent(
  pool: Pool,
  pages: readonly PagePlan[],
  batchSize: number,
): Promise<void> {
  for (let i = 0; i < pages.length; i += batchSize) {
    const batch = pages.slice(i, i + batchSize);
    await pool.query(
      `WITH b AS (
         SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(
           "pageId" int,"wikidotId" int,slug text,title text,
           "alternateTitle" text,tags text[],category text,
           "searchText" text,"firstPublishedAt" timestamptz
         )
       )
       INSERT INTO serve.page_current(
         page_id,wikidot_id,slug,status,title,alternate_title,tags,category,
         search_text,first_published_at
       )
       SELECT "pageId","wikidotId",slug,'live',title,"alternateTitle",
              COALESCE(tags,'{}'),category,"searchText","firstPublishedAt"
         FROM b
       ON CONFLICT(page_id) DO NOTHING`,
      [JSON.stringify(batch)],
    );
  }
  const bad = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n
       FROM ingest.page p
       JOIN ingest.page_slug_history h ON h.page_id=p.id AND h.valid_to IS NULL
       LEFT JOIN serve.page_current pc ON pc.page_id=p.id
      WHERE pc.page_id IS NULL OR pc.wikidot_id<>p.wikidot_id OR pc.slug<>h.slug`,
  );
  if (asNumber(bad.rows[0]?.n) !== 0) {
    throw new Error(`S3 page_current 身份基线有 ${bad.rows[0]?.n} 行不一致`);
  }
}

function normalizePacket(row: SourcePacketRow): SourcePacketRow {
  return {
    page_id: asNumber(row.page_id),
    packet_kind: row.packet_kind,
    packet_no: asNumber(row.packet_no),
    rows: row.rows ?? [],
  };
}

function metricFor(events: readonly EventPlan[]): PageMetric {
  const final = new Map<number, number>();
  for (const event of events) final.set(event.voter_id, event.new_direction ?? 0);
  let rating = 0;
  let up = 0;
  let down = 0;
  let revoked = 0;
  for (const direction of final.values()) {
    rating += direction;
    if (direction === 1) up++;
    else if (direction === -1) down++;
    else revoked++;
  }
  return { currentRows: final.size, rating, up, down, revoked };
}

function accountPacket(
  totals: Totals,
  metrics: Map<number, PageMetric>,
  packet: SourcePacketRow,
): void {
  if (packet.packet_kind === 'end') {
    totals.pages++;
    return;
  }
  if (packet.packet_kind === 'event') {
    const events = packet.rows as EventPlan[];
    totals.events += events.length;
    const metric = metricFor(events);
    totals.currentRows += metric.currentRows;
    metrics.set(packet.page_id, metric);
    for (const event of events) {
      increment(totals.eventSources, event.source);
      increment(totals.eventKinds, event.kind);
    }
    return;
  }
  if (packet.packet_kind === 'audit') {
    const audits = packet.rows as AuditPlan[];
    totals.audits += audits.length;
    for (const audit of audits) increment(totals.auditRules, audit.rule);
    return;
  }
  const quarantines = packet.rows as QuarantinePlan[];
  totals.quarantines += quarantines.length;
  for (const item of quarantines) increment(totals.quarantineReasons, item.reason);
}

async function createOrReuseRun(
  pool: Pool,
  observedAt: string,
  sourceDatabase: string,
  progress: { lastPageId: number; doneCount: number },
): Promise<number> {
  const previous = await pool.query<{ id: string; status: string }>(
    `SELECT id::text,status
       FROM meta.ingest_run
      WHERE source=$1 AND stats->>'domain'=$2
      ORDER BY id DESC LIMIT 1`,
    [SOURCE_NAME, PROGRESS_DOMAIN],
  );
  const prior = previous.rows[0];
  if (prior && (progress.lastPageId > 0 || progress.doneCount > 0 || prior.status !== 'ok')) {
    await pool.query(
      `UPDATE meta.ingest_run
          SET status='running',finished_at=NULL,stats=stats-'error'
        WHERE id=$1`,
      [prior.id],
    );
    return asNumber(prior.id);
  }
  const created = await pool.query<{ id: string }>(
    `INSERT INTO meta.ingest_run(
       source,status,started_at,pages_enumerated,remote_total,
       remote_total_source,batches_failed,stats
     ) VALUES ($1,'running',$2::timestamptz,0,0,'unknown',0,
               jsonb_build_object('domain',$3::text,'source_database',$4::text))
     RETURNING id::text`,
    [SOURCE_NAME, observedAt, PROGRESS_DOMAIN, sourceDatabase],
  );
  return asNumber(created.rows[0]!.id);
}

class TargetBatchWriter {
  private client: PoolClient | null = null;
  private pageIds: number[] = [];
  private eventCount = 0;
  private lastPacketPage = 0;
  private pageEnded = true;

  constructor(
    private readonly pool: Pool,
    private readonly runId: number,
    private readonly observedAt: string,
    private readonly expectedEvents: number,
    private readonly batchSize: number,
    private readonly pauseMs: number,
  ) {}

  private async begin(): Promise<PoolClient> {
    if (this.client !== null) return this.client;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT meta.assert_writes_allowed('vote')`);
      await client.query(`SELECT meta.ingest_gate_open()`);
      this.client = client;
      return client;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
      throw error;
    }
  }

  private assertPacketOrder(packet: SourcePacketRow): void {
    if (packet.page_id < this.lastPacketPage) {
      throw new Error(`S3 source packet page_id 倒退：${packet.page_id}<${this.lastPacketPage}`);
    }
    if (packet.page_id > this.lastPacketPage) {
      if (!this.pageEnded) {
        throw new Error(`S3 source page=${this.lastPacketPage} 缺 end marker`);
      }
      this.lastPacketPage = packet.page_id;
      this.pageEnded = false;
    } else if (this.pageEnded) {
      throw new Error(`S3 source page=${packet.page_id} 在 end marker 后仍有 packet`);
    }
  }

  async consume(packet: SourcePacketRow): Promise<void> {
    this.assertPacketOrder(packet);
    const client = await this.begin();
    if (packet.packet_kind === 'event') {
      const events = (packet.rows as EventPlan[]).map((event) => ({
        page_id: packet.page_id,
        ...event,
      }));
      this.eventCount += events.length;
      if (events.length > 0) {
        await client.query(
          `WITH b AS (
             SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(
               page_id int,voter_id int,kind text,old_direction smallint,
               new_direction smallint,occurred_at timestamptz,
               time_precision text,source text,source_ref text,event_order int
             )
           )
           INSERT INTO ingest.vote_event(
             page_id,voter_id,kind,old_direction,new_direction,
             occurred_at,observed_at,time_precision,source,run_id
           )
           SELECT page_id,voter_id,kind,old_direction,new_direction,
                  occurred_at,$2::timestamptz,time_precision,source,$3::bigint
             FROM b
            ORDER BY event_order`,
          [JSON.stringify(events), this.observedAt, this.runId],
        );
      }
      return;
    }
    if (packet.packet_kind === 'audit') {
      const audits = (packet.rows as AuditPlan[]).map((audit) => ({
        page_id: packet.page_id,
        ...audit,
      }));
      if (audits.length > 0) {
        await client.query(
          `WITH b AS (
             SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(
               page_id int,v1_vote_id bigint,rule text,kept_ref text,
               confidence text,note text
             )
           )
           INSERT INTO meta.dedup_audit(
             v1_vote_id,rule,kept_ref,confidence,note
           )
           SELECT v1_vote_id,rule,kept_ref,confidence,
                  format('page_id=%s; %s',page_id,note)
             FROM b`,
          [JSON.stringify(audits)],
        );
      }
      return;
    }
    if (packet.packet_kind === 'quarantine') {
      const quarantines = (packet.rows as QuarantinePlan[]).map((item) => ({
        page_id: packet.page_id,
        ...item,
      }));
      if (quarantines.length > 0) {
        await client.query(
          `WITH b AS (
             SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(
               page_id int,voter_key text,raw jsonb,reason text,
               source text,occurred_at timestamptz
             )
           )
           INSERT INTO meta.vote_quarantine(
             page_id,voter_key,raw,reason,source,occurred_at
           )
           SELECT page_id,voter_key,raw,reason,source,occurred_at FROM b`,
          [JSON.stringify(quarantines)],
        );
      }
      return;
    }
    this.pageEnded = true;
    this.pageIds.push(packet.page_id);
    if (this.pageIds.length >= this.batchSize) await this.flush();
  }

  async flush(): Promise<void> {
    if (this.client === null || this.pageIds.length === 0) return;
    const client = this.client;
    const pageIds = this.pageIds;
    const eventCount = this.eventCount;
    const lastPageId = pageIds.at(-1)!;
    try {
      await client.query(
        `WITH grouped AS (
           SELECT page_id,voter_id,
                  (array_agg(COALESCE(occurred_at,observed_at)
                             ORDER BY seq))[1] AS first_voted_at,
                  (array_agg(COALESCE(new_direction,0)
                             ORDER BY seq DESC))[1]::smallint AS direction,
                  (array_agg(COALESCE(occurred_at,observed_at)
                             ORDER BY seq DESC))[1] AS last_voted_at,
                  (array_agg(time_precision ORDER BY seq DESC))[1] AS last_precision,
                  max(seq) AS last_seq
             FROM ingest.vote_event
            WHERE run_id=$1 AND page_id=ANY($2::int[])
            GROUP BY page_id,voter_id
         )
         INSERT INTO serve.vote_current AS vc(
           page_id,voter_id,direction,first_voted_at,last_voted_at,
           last_precision,last_seq,source_row_ordinal
         )
         SELECT page_id,voter_id,direction,first_voted_at,last_voted_at,
                last_precision,last_seq,0
           FROM grouped
         ON CONFLICT(page_id,voter_id,source_row_ordinal) DO UPDATE
           SET direction=EXCLUDED.direction,
               first_voted_at=COALESCE(vc.first_voted_at,EXCLUDED.first_voted_at),
               last_voted_at=EXCLUDED.last_voted_at,
               last_precision=EXCLUDED.last_precision,
               last_seq=EXCLUDED.last_seq`,
        [this.runId, pageIds],
      );
      await client.query(
        `WITH ids AS MATERIALIZED (
           SELECT unnest($1::int[]) AS page_id
         ), agg AS (
           SELECT i.page_id,
                  COALESCE(v.rating,0)::int AS rating,
                  COALESCE(v.vote_up,0)::int AS vote_up,
                  COALESCE(v.vote_down,0)::int AS vote_down,
                  COALESCE(v.vote_revoked,0)::int AS vote_revoked,
                  COALESCE(u.unique_voter_count,0)::int AS unique_voter_count,
                  COALESCE(u.unique_voter_rating,0)::int AS unique_voter_rating,
                  COALESCE(v.cursor_seq,0)::bigint AS cursor_seq
             FROM ids i
             LEFT JOIN LATERAL (
               SELECT sum(vc.direction)::int AS rating,
                      count(*) FILTER (WHERE vc.direction=1)::int AS vote_up,
                      count(*) FILTER (WHERE vc.direction=-1)::int AS vote_down,
                      count(*) FILTER (WHERE vc.direction=0)::int AS vote_revoked,
                      max(vc.last_seq)::bigint AS cursor_seq
                 FROM serve.vote_current vc
                WHERE vc.page_id=i.page_id
                OFFSET 0
             ) v ON true
             LEFT JOIN LATERAL (
               SELECT count(*)::int AS unique_voter_count,
                      COALESCE(sum(sign(net)),0)::int AS unique_voter_rating
                 FROM (
                   SELECT voter_id,sum(direction)::int AS net
                     FROM serve.vote_current
                    WHERE page_id=i.page_id AND direction<>0
                    GROUP BY voter_id
                 ) per_voter
             ) u ON true
         )
         UPDATE serve.page_current pc
            SET rating=a.rating,vote_up=a.vote_up,vote_down=a.vote_down,
                vote_revoked=a.vote_revoked,
                unique_voter_count=a.unique_voter_count,
                unique_voter_rating=a.unique_voter_rating,
                cursor_seq=a.cursor_seq,updated_at=now()
           FROM agg a
          WHERE pc.page_id=a.page_id`,
        [pageIds],
      );
      await client.query(
        `UPDATE meta.backfill_progress
            SET last_page_id=$3,done_count=done_count+$4,
                total_count=$5,updated_at=now()
          WHERE domain=$1 AND shard=$2`,
        [
          PROGRESS_DOMAIN,
          PROGRESS_SHARD,
          lastPageId,
          eventCount,
          this.expectedEvents,
        ],
      );
      await client.query(`SELECT meta.ingest_gate_close()`);
      await client.query('COMMIT');
      client.release();
      this.client = null;
      this.pageIds = [];
      this.eventCount = 0;
      if (this.pauseMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.pauseMs));
      }
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
      this.client = null;
      this.pageIds = [];
      this.eventCount = 0;
      throw error;
    }
  }

  async abort(): Promise<void> {
    if (this.client === null) return;
    const client = this.client;
    this.client = null;
    this.pageIds = [];
    this.eventCount = 0;
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

async function loadTargetMetrics(pool: Pool): Promise<Map<number, PageMetric>> {
  const result = await pool.query<{
    page_id: number;
    rating: number;
    vote_up: number;
    vote_down: number;
    vote_revoked: number;
  }>(
    `SELECT page_id,rating,vote_up,vote_down,vote_revoked
       FROM serve.page_current ORDER BY page_id`,
  );
  return new Map(
    result.rows.map((row) => [
      asNumber(row.page_id),
      {
        currentRows:
          asNumber(row.vote_up) + asNumber(row.vote_down) + asNumber(row.vote_revoked),
        rating: asNumber(row.rating),
        up: asNumber(row.vote_up),
        down: asNumber(row.vote_down),
        revoked: asNumber(row.vote_revoked),
      },
    ]),
  );
}

function readLiveSeeds(file: string): Map<number, StoredSnapshot> {
  const result = new Map<number, StoredSnapshot>();
  if (!fs.existsSync(file)) throw new Error(`live gate state file 不存在：${file}`);
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const row = JSON.parse(line) as StoredSnapshot;
    if (row.version === 1) result.set(row.pageId, row);
  }
  return result;
}

function evaluateGates(
  pages: readonly PagePlan[],
  metrics: ReadonlyMap<number, PageMetric>,
  seeds: ReadonlyMap<number, StoredSnapshot>,
): {
  live: { pages: number; matched: number; mismatched: number; rate: number };
  c3: {
    correctedPages: number;
    deltaMin: number | null;
    deltaP50: number | null;
    deltaMax: number | null;
  };
} {
  let livePages = 0;
  let liveMatched = 0;
  const deltas: number[] = [];
  for (const page of pages) {
    const metric = metrics.get(page.pageId) ?? {
      currentRows: 0,
      rating: 0,
      up: 0,
      down: 0,
      revoked: 0,
    };
    if (
      !page.isDeleted &&
      page.currentRating !== null &&
      ((page.currentVoteCount ?? 0) > 0 || metric.up + metric.down > 0)
    ) {
      livePages++;
      const seed = seeds.get(page.pageId);
      const reusable =
        seed?.acceptedAsSeed === true &&
        seed.target.pageId === page.pageId &&
        seed.target.wikidotId === page.wikidotId &&
        seed.target.claimedRating === page.currentRating &&
        seed.outcome?.data?.checksum === page.currentRating;
      const effectiveRating = reusable ? seed.outcome!.data!.checksum! : metric.rating;
      if (effectiveRating === page.currentRating) liveMatched++;
    }
    if (
      page.isDeleted &&
      page.lastNonnullRating !== null &&
      metric.rating !== page.lastNonnullRating
    ) {
      deltas.push(metric.rating - page.lastNonnullRating);
    }
  }
  deltas.sort((a, b) => a - b);
  return {
    live: {
      pages: livePages,
      matched: liveMatched,
      mismatched: livePages - liveMatched,
      rate: livePages === 0 ? 0 : liveMatched / livePages,
    },
    c3: {
      correctedPages: deltas.length,
      deltaMin: deltas.at(0) ?? null,
      deltaP50: deltas.length === 0 ? null : deltas[Math.ceil(deltas.length * 0.5) - 1]!,
      deltaMax: deltas.at(-1) ?? null,
    },
  };
}

function relativeDeviation(actual: number, expected: number): number {
  return Math.abs(actual - expected) / expected;
}

async function verifyTarget(
  pool: Pool,
  runId: number,
): Promise<Record<string, number | Record<string, number>>> {
  const result = await pool.query<Record<string, string>>(
    `WITH vote_agg AS (
       SELECT page_id,COALESCE(sum(direction),0)::int AS rating,
              count(*) FILTER (WHERE direction=1)::int AS up,
              count(*) FILTER (WHERE direction=-1)::int AS down,
              count(*) FILTER (WHERE direction=0)::int AS revoked
         FROM serve.vote_current GROUP BY page_id
     )
     SELECT
       (SELECT count(*) FROM ingest.vote_event)::text AS events,
       (SELECT count(*) FROM ingest.vote_event WHERE run_id=$1)::text AS run_events,
       (SELECT count(*) FROM serve.vote_current)::text AS current_rows,
       (SELECT count(*) FROM serve.page_current)::text AS page_current,
       (SELECT count(*) FROM meta.dedup_audit)::text AS audits,
       (SELECT count(*) FROM meta.vote_quarantine)::text AS quarantines,
       (SELECT count(*) FROM serve.page_current pc
         LEFT JOIN vote_agg a ON a.page_id=pc.page_id
        WHERE pc.rating<>COALESCE(a.rating,0))::text AS rating_bad,
       (SELECT count(*) FROM serve.page_current pc
         LEFT JOIN vote_agg a ON a.page_id=pc.page_id
        WHERE pc.vote_up<>COALESCE(a.up,0)
           OR pc.vote_down<>COALESCE(a.down,0)
           OR pc.vote_revoked<>COALESCE(a.revoked,0))::text AS direction_bad,
       (SELECT count(*) FROM (
          SELECT page_id,voter_id,source_row_ordinal FROM serve.vote_current
          GROUP BY page_id,voter_id,source_row_ordinal HAVING count(*)>1
        ) d)::text AS primary_conflicts`,
    [runId],
  );
  const row = result.rows[0]!;
  const distributions = await pool.query<{ kind: string; n: string }>(
    `SELECT 'event_source:'||source AS kind,count(*)::text AS n
       FROM ingest.vote_event GROUP BY source
     UNION ALL
     SELECT 'event_kind:'||kind,count(*)::text FROM ingest.vote_event GROUP BY kind
     UNION ALL
     SELECT 'audit_rule:'||rule,count(*)::text FROM meta.dedup_audit GROUP BY rule
     UNION ALL
     SELECT 'quarantine_reason:'||reason,count(*)::text
       FROM meta.vote_quarantine GROUP BY reason
     ORDER BY kind`,
  );
  return {
    events: asNumber(row.events),
    runEvents: asNumber(row.run_events),
    currentRows: asNumber(row.current_rows),
    pageCurrent: asNumber(row.page_current),
    audits: asNumber(row.audits),
    quarantines: asNumber(row.quarantines),
    ratingBad: asNumber(row.rating_bad),
    directionBad: asNumber(row.direction_bad),
    primaryConflicts: asNumber(row.primary_conflicts),
    distributions: Object.fromEntries(
      distributions.rows.map((item) => [item.kind, asNumber(item.n)]),
    ),
  };
}

function printReport(report: Record<string, unknown>, jsonOnly: boolean): void {
  if (!jsonOnly) {
    process.stdout.write(
      `S3 ${String(report.mode)} complete: events=${String(
        (report.plan as Totals).events,
      )}, current=${String((report.plan as Totals).currentRows)}\n`,
    );
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

async function run(): Promise<void> {
  const opts = parseArgs();
  const sourceDatabase = databaseName(opts.v1DatabaseUrl);
  const targetDatabase = databaseName(opts.targetDatabaseUrl);
  if (!['scpper-cn', 'scpper_cn'].includes(sourceDatabase)) {
    throw new Error(`S3 source 必须是 scpper-cn/scpper_cn，实际 ${sourceDatabase}`);
  }
  if (targetDatabase !== 'scpper-v2' || PROTECTED_TARGETS.has(targetDatabase)) {
    throw new Error(`S3 target 必须精确为 scpper-v2，实际 ${targetDatabase}`);
  }

  const sourcePool = createPool(
    opts.v1DatabaseUrl,
    true,
    'syncer2-backfill-s3-source-ro',
  );
  const targetPool = createPool(
    opts.targetDatabaseUrl,
    !opts.execute,
    opts.execute ? 'syncer2-backfill-s3-target' : 'syncer2-backfill-s3-target-ro',
    opts.execute ? 2 : 1,
  );
  const source = await sourcePool.connect();
  let lock: PoolClient | null = null;
  let runId: number | null = null;
  let writer: TargetBatchWriter | null = null;
  const totals = emptyTotals();
  const metrics = new Map<number, PageMetric>();
  try {
    const observedAt = await beginSourceSnapshot(source);
    const pages = await loadPages(source);
    const targetBefore = await targetPreflight(targetPool, opts.execute);
    if (asNumber(targetBefore.pages as number) !== pages.length) {
      throw new Error(
        `S3 identity page 数不一致：source=${pages.length} target=${String(targetBefore.pages)}`,
      );
    }
    const seeds = readLiveSeeds(opts.stateFile);
    let progress = { lastPageId: 0, doneCount: 0, totalCount: null as number | null };

    if (opts.execute) {
      lock = await targetPool.connect();
      await lock.query(`SELECT pg_advisory_lock(hashtext('backfill:s3'))`);
      await ensureProgress(targetPool, opts.expectedEvents);
      progress = await readProgress(targetPool);
      if (
        progress.lastPageId === 0 &&
        (asNumber(targetBefore.events as number) !== 0 ||
          asNumber(targetBefore.currentRows as number) !== 0 ||
          asNumber(targetBefore.audits as number) !== 0 ||
          asNumber(targetBefore.quarantines as number) !== 0)
      ) {
        throw new Error(
          `S3 fresh progress 但目标已有投票事实/审计：${JSON.stringify(targetBefore)}`,
        );
      }
      await ensurePageCurrent(targetPool, pages, Math.max(opts.batchSize, 250));
      runId = await createOrReuseRun(targetPool, observedAt, sourceDatabase, progress);
      writer = new TargetBatchWriter(
        targetPool,
        runId,
        observedAt,
        opts.expectedEvents,
        opts.batchSize,
        opts.pauseMs,
      );
    }

    await source.query(
      `DECLARE s3_plan_cursor NO SCROLL CURSOR FOR ${SOURCE_PLAN_SQL}`,
      [progress.lastPageId],
    );
    for (;;) {
      const fetched = await source.query<SourcePacketRow>(
        `FETCH FORWARD ${opts.fetchSize} FROM s3_plan_cursor`,
      );
      if (fetched.rows.length === 0) break;
      const normalized = fetched.rows.map(normalizePacket);
      for (const packet of normalized) {
        accountPacket(totals, metrics, packet);
        if (writer !== null) await writer.consume(packet);
      }
      if (!opts.json && totals.pages % 500 < opts.fetchSize) {
        process.stderr.write(
          `[backfill-s3] pages=${totals.pages} events=${totals.events} ` +
            `audits=${totals.audits} quarantine=${totals.quarantines}\n`,
        );
      }
    }
    if (writer !== null) await writer.flush();
    await source.query('CLOSE s3_plan_cursor');
    await source.query('COMMIT');

    // Resume runs only scan the remaining source suffix.  Target verification is
    // authoritative for final totals; a fresh run can also compare the plan directly.
    if (progress.lastPageId === 0) {
      if (relativeDeviation(totals.events, opts.expectedEvents) > opts.tolerance) {
        throw new Error(
          `S3 event plan 偏差超过 ${opts.tolerance * 100}%：` +
            `${totals.events} vs ${opts.expectedEvents}`,
        );
      }
      if (relativeDeviation(totals.currentRows, opts.expectedCurrent) > opts.tolerance) {
        throw new Error(
          `S3 vote_current plan 偏差超过 ${opts.tolerance * 100}%：` +
            `${totals.currentRows} vs ${opts.expectedCurrent}`,
        );
      }
    }
    const gateMetrics = opts.execute ? await loadTargetMetrics(targetPool) : metrics;
    const gates = evaluateGates(pages, gateMetrics, seeds);
    if (gates.live.rate < 0.975) {
      throw new Error(`S3 live gate=${gates.live.rate} < 0.975`);
    }

    let targetAfter: Record<string, unknown> | null = null;
    if (opts.execute) {
      targetAfter = await verifyTarget(targetPool, runId!);
      const actualEvents = asNumber(targetAfter.events as number);
      const actualCurrent = asNumber(targetAfter.currentRows as number);
      if (
        relativeDeviation(actualEvents, opts.expectedEvents) > opts.tolerance ||
        relativeDeviation(actualCurrent, opts.expectedCurrent) > opts.tolerance
      ) {
        throw new Error(
          `S3 写后数量偏差超过 ${opts.tolerance * 100}%：` +
            `events=${actualEvents}/${opts.expectedEvents}, ` +
            `current=${actualCurrent}/${opts.expectedCurrent}`,
        );
      }
      if (
        asNumber(targetAfter.ratingBad as number) !== 0 ||
        asNumber(targetAfter.directionBad as number) !== 0 ||
        asNumber(targetAfter.primaryConflicts as number) !== 0
      ) {
        throw new Error(`S3 写后不变式违例：${JSON.stringify(targetAfter)}`);
      }
      const finalProgress = await readProgress(targetPool);
      await targetPool.query(
        `UPDATE meta.backfill_progress
            SET total_count=done_count,updated_at=now()
          WHERE domain=$1 AND shard=$2`,
        [PROGRESS_DOMAIN, PROGRESS_SHARD],
      );
      await targetPool.query(
        `UPDATE meta.ingest_run
            SET status='ok',finished_at=now(),
                pages_enumerated=$2,remote_total=$2,
                stats=stats||$3::jsonb
          WHERE id=$1`,
        [
          runId,
          pages.length,
          JSON.stringify({
            completed: true,
            observed_at: observedAt,
            progress: finalProgress,
            plan: totals,
            gates,
            verified: targetAfter,
          }),
        ],
      );
    }
    printReport(
      {
        mode: opts.execute ? 'execute' : 'dry-run',
        sourceDatabase,
        targetDatabase,
        observedAt,
        sourcePages: pages.length,
        targetBefore,
        resumeFrom: progress,
        plan: totals,
        gates,
        targetAfter,
      },
      opts.json,
    );
  } catch (error) {
    await writer?.abort().catch(() => undefined);
    await source.query('ROLLBACK').catch(() => undefined);
    if (runId !== null) {
      await targetPool
        .query(
          `UPDATE meta.ingest_run
              SET status='failed',finished_at=now(),
                  stats=stats||jsonb_build_object('error',$2::text)
            WHERE id=$1`,
          [runId, error instanceof Error ? error.message : String(error)],
        )
        .catch(() => undefined);
    }
    throw error;
  } finally {
    if (lock !== null) {
      await lock
        .query(`SELECT pg_advisory_unlock(hashtext('backfill:s3'))`)
        .catch(() => undefined);
      lock.release();
    }
    source.release();
    await Promise.all([sourcePool.end(), targetPool.end()]);
  }
}

run().catch((error) => {
  process.stderr.write(
    `[backfill-s3] ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
