/**
 * v1 → v2 论坛当前态回填。
 *
 * 默认/--dry-run：源库与目标库都由 PostgreSQL startup option 强制只读。
 * --execute：源库仍强制只读；目标按 category/thread/post 三个 shard 分批提交，
 * 每批在同一事务里完成 ensure_user → apply_forum_batch → backfill_progress。
 */

import { Command } from 'commander';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';

import { loadEnv } from '../config.js';
import { normalizeV1Url } from './s1-model.js';
import {
  authorInput,
  postPayload,
  threadPayload,
  type ForumAuthorInput,
  type V1ForumPostRow,
  type V1ForumThreadRow,
} from './forum-model.js';

const PROTECTED_TARGETS = new Set(['scpper-cn', 'scpper_cn', 'scpper-syncer', 'scpper_user']);
const PROGRESS_DOMAIN = 'forum_v1';
const FREEZE_REASON = 'v1→v2 forum backfill：阻止在线论坛 upsert 与历史批次交错';
const SHARDS = ['category', 'thread', 'post'] as const;
type Shard = (typeof SHARDS)[number];

interface CliOptions {
  execute: boolean;
  batchSize: number;
  sampleSize: number;
  v1DatabaseUrl: string;
  targetDatabaseUrl: string;
  json: boolean;
}

interface SourceStats {
  categories: number;
  threads: number;
  posts: number;
  threadDescriptions: number;
  pageLinks: number;
  deletedPosts: number;
  deletedAuthors: number;
  postAuthorsUnresolved: number;
  threadAuthorsUnresolved: number;
  parentLinks: number;
  orphanParents: number;
  crossThreadParents: number;
  threadIdMax: number;
  postIdMax: number;
  categoryIdMax: number;
  htmlBytes: number;
  postTypeDistribution: Record<string, number>;
}

interface ProgressRow {
  shard: string;
  last_page_id: number;
  done_count: string;
  total_count: string | null;
}

interface LinkedPage {
  v1Id: number;
  wikidotId: number;
  slug: string;
}

interface TargetPreflight {
  counts: Record<Shard, number>;
  migrationReady: boolean;
  missingColumns: string[];
  linkedPagesMissing: number;
  linkedPagesRemapped: number;
  knownForumAuthors: number;
  forumAuthorsExpected: number;
  pageIdSources: Record<string, number>;
  progress: ProgressRow[];
}

interface DryRunReport {
  mode: 'dry-run' | 'execute';
  sourceDatabase: string;
  targetDatabase: string;
  expected: SourceStats;
  targetBefore: TargetPreflight;
  ddlAssessment: {
    forumThreadDescription: string;
    forumPostCreatedByType: string;
    pageIdPolicy: string;
  };
  assertions: Array<{ name: string; ok: boolean; actual: string }>;
  canExecute: boolean;
}

interface CategoryRow {
  id: number;
  title: string;
  description: string | null;
  thread_count: number;
  post_count: number;
}

interface ValidationReport {
  counts: Record<Shard, number>;
  pageId: {
    nonnull: number;
    inferred: number;
    verified: number;
    withoutSource: number;
    expectedInferred: number;
    expectedNonNull: number;
    inferredFingerprintEqual: boolean;
  };
  floorOrderFingerprintEqual: boolean;
  parentFingerprintEqual: boolean;
  orphanParents: number;
  crossThreadParents: number;
  threadDescriptions: number;
  threadDescriptionFingerprintEqual: boolean;
  postTypeDistribution: Record<string, number>;
  postTypeDistributionEqual: boolean;
  postAuthorsMissing: number;
  deletedAuthors: number;
  deletedAuthorNamesMissing: number;
  sample: {
    threads: number;
    posts: number;
    mismatches: number;
    examples: string[];
  };
  assertions: Array<{ name: string; ok: boolean; actual: string }>;
}

function positiveInt(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`必须是正整数，拿到 ${value}`);
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
  const parsed = new URL(connectionString);
  const name = decodeURIComponent(parsed.pathname.replace(/^\/+/, ''));
  if (name === '') throw new Error('连接串缺数据库名');
  return name;
}

function parseArgs(): CliOptions {
  loadEnv();
  const program = new Command();
  program
    .name('backfill-forum')
    .description('v1→v2 论坛回填；默认只读 dry-run，--execute 才写目标库')
    .option('--execute', '正式分批写 v2', false)
    .option('--dry-run', '显式只读预演（默认）', false)
    .option('--batch-size <n>', '每批 category/thread/post 行数', positiveInt, 1_000)
    .option('--sample-size <n>', '写后逐帖比对的主题样本数', positiveInt, 100)
    .option('--v1-database-url <url>', 'v1 scpper-cn 连接串（始终强制只读）')
    .option('--target-database-url <url>', 'v2 scpper-v2 连接串')
    .option('--json', '只输出 JSON', false);
  program.parse(process.argv);
  const raw = program.opts<{
    execute: boolean;
    dryRun: boolean;
    batchSize: number;
    sampleSize: number;
    v1DatabaseUrl?: string;
    targetDatabaseUrl?: string;
    json: boolean;
  }>();
  if (raw.execute && raw.dryRun) throw new Error('--execute 与 --dry-run 不能同时给');
  return {
    execute: raw.execute,
    batchSize: raw.batchSize,
    sampleSize: raw.sampleSize,
    v1DatabaseUrl: raw.v1DatabaseUrl ?? mustEnv('V1_DATABASE_URL', 'DATABASE_URL'),
    targetDatabaseUrl: raw.targetDatabaseUrl ?? mustEnv('SYNCER2_DATABASE_URL'),
    json: raw.json,
  };
}

function createBackfillPool(
  connectionString: string,
  opts: { readOnly: boolean; applicationName: string; max?: number },
): Pool {
  return new Pool({
    connectionString,
    max: opts.max ?? 2,
    idleTimeoutMillis: 5_000,
    connectionTimeoutMillis: 10_000,
    application_name: opts.applicationName,
    options: opts.readOnly
      ? '-c default_transaction_read_only=on -c statement_timeout=0'
      : '-c statement_timeout=0',
  });
}

function asNumber(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`不是安全整数：${String(value)}`);
  return parsed;
}

function parseDistribution(raw: unknown): Record<string, number> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return Object.fromEntries(
    Object.entries(raw as Record<string, unknown>)
      .map(([key, value]) => [key, asNumber(value)] as const)
      .sort(([a], [b]) => a.localeCompare(b)),
  );
}

async function loadSourceStats(client: PoolClient): Promise<{
  stats: SourceStats;
  linkedPages: LinkedPage[];
  forumAuthorIds: number[];
}> {
  const summary = await client.query<{
    categories: string;
    threads: string;
    posts: string;
    thread_descriptions: string;
    page_links: string;
    deleted_posts: string;
    deleted_authors: string;
    post_authors_unresolved: string;
    thread_authors_unresolved: string;
    parent_links: string;
    orphan_parents: string;
    cross_thread_parents: string;
    thread_id_max: number;
    post_id_max: number;
    category_id_max: number;
    html_bytes: string;
    post_type_distribution: unknown;
  }>(
    `SELECT
       (SELECT count(*) FROM public."ForumCategory")::text AS categories,
       (SELECT count(*) FROM public."ForumThread")::text AS threads,
       (SELECT count(*) FROM public."ForumPost")::text AS posts,
       (SELECT count(*) FROM public."ForumThread"
         WHERE NULLIF(btrim(description),'') IS NOT NULL)::text
         AS thread_descriptions,
       (SELECT count(*) FROM public."ForumThread" WHERE "pageId" IS NOT NULL)::text AS page_links,
       (SELECT count(*) FROM public."ForumPost" WHERE "createdByType"='deleted')::text
         AS deleted_posts,
       (SELECT count(DISTINCT "createdByWikidotId") FROM public."ForumPost"
         WHERE "createdByType"='deleted')::text AS deleted_authors,
       (SELECT count(*) FROM public."ForumPost"
         WHERE COALESCE("createdByWikidotId",0)<=0)::text AS post_authors_unresolved,
       (SELECT count(*) FROM public."ForumThread"
         WHERE COALESCE("createdByWikidotId",0)<=0)::text AS thread_authors_unresolved,
       (SELECT count(*) FROM public."ForumPost" WHERE "parentId" IS NOT NULL)::text AS parent_links,
       (SELECT count(*) FROM public."ForumPost" child
          LEFT JOIN public."ForumPost" parent ON parent.id=child."parentId"
         WHERE child."parentId" IS NOT NULL AND parent.id IS NULL)::text AS orphan_parents,
       (SELECT count(*) FROM public."ForumPost" child
          JOIN public."ForumPost" parent ON parent.id=child."parentId"
         WHERE parent."threadId"<>child."threadId")::text AS cross_thread_parents,
       (SELECT COALESCE(max(id),0) FROM public."ForumThread") AS thread_id_max,
       (SELECT COALESCE(max(id),0) FROM public."ForumPost") AS post_id_max,
       (SELECT COALESCE(max(id),0) FROM public."ForumCategory") AS category_id_max,
       (SELECT COALESCE(sum(octet_length("textHtml")),0) FROM public."ForumPost")::text
         AS html_bytes,
       (SELECT COALESCE(jsonb_object_agg(kind,n),'{}'::jsonb)
          FROM (SELECT COALESCE("createdByType",'(null)') kind,count(*) n
                  FROM public."ForumPost" GROUP BY 1) d) AS post_type_distribution`,
  );
  const row = summary.rows[0]!;
  const [pageRows, authorRows] = await Promise.all([
    client.query<{ v1_id: number; wikidot_id: number; current_url: string }>(
      `SELECT DISTINCT p.id AS v1_id,p."wikidotId" AS wikidot_id,p."currentUrl" AS current_url
         FROM public."ForumThread" t
         JOIN public."Page" p ON p.id=t."pageId"
        WHERE t."pageId" IS NOT NULL
        ORDER BY p.id`,
    ),
    client.query<{ id: number }>(
      `SELECT DISTINCT id FROM (
         SELECT "createdByWikidotId" AS id FROM public."ForumThread"
          WHERE "createdByWikidotId">0
         UNION
         SELECT "createdByWikidotId" AS id FROM public."ForumPost"
          WHERE "createdByWikidotId">0
       ) s ORDER BY id`,
    ),
  ]);
  return {
    stats: {
      categories: asNumber(row.categories),
      threads: asNumber(row.threads),
      posts: asNumber(row.posts),
      threadDescriptions: asNumber(row.thread_descriptions),
      pageLinks: asNumber(row.page_links),
      deletedPosts: asNumber(row.deleted_posts),
      deletedAuthors: asNumber(row.deleted_authors),
      postAuthorsUnresolved: asNumber(row.post_authors_unresolved),
      threadAuthorsUnresolved: asNumber(row.thread_authors_unresolved),
      parentLinks: asNumber(row.parent_links),
      orphanParents: asNumber(row.orphan_parents),
      crossThreadParents: asNumber(row.cross_thread_parents),
      threadIdMax: asNumber(row.thread_id_max),
      postIdMax: asNumber(row.post_id_max),
      categoryIdMax: asNumber(row.category_id_max),
      htmlBytes: asNumber(row.html_bytes),
      postTypeDistribution: parseDistribution(row.post_type_distribution),
    },
    linkedPages: pageRows.rows.map((item) => ({
      v1Id: item.v1_id,
      wikidotId: item.wikidot_id,
      slug: normalizeV1Url(item.current_url),
    })),
    forumAuthorIds: authorRows.rows.map((item) => item.id),
  };
}

async function loadTargetPreflight(
  pool: Pool,
  linkedPages: readonly LinkedPage[],
  forumAuthorIds: readonly number[],
): Promise<TargetPreflight> {
  const [state, columns, pageMatches, authorMatches, progress] = await Promise.all([
    pool.query<{
      categories: string;
      threads: string;
      posts: string;
      page_sources: unknown;
    }>(
      `SELECT
         (SELECT count(*) FROM ingest.forum_category)::text AS categories,
         (SELECT count(*) FROM ingest.forum_thread)::text AS threads,
         (SELECT count(*) FROM ingest.forum_post)::text AS posts,
         (SELECT COALESCE(jsonb_object_agg(source,n),'{}'::jsonb)
            FROM (SELECT COALESCE(page_id_source,'(null)') source,count(*) n
                    FROM ingest.forum_thread GROUP BY 1) d) AS page_sources`,
    ),
    pool.query<{ table_name: string; column_name: string }>(
      `SELECT table_name,column_name
         FROM information_schema.columns
        WHERE table_schema='ingest'
          AND (
            (table_name='forum_thread' AND column_name='description')
            OR (table_name='forum_post' AND column_name='created_by_type')
          )`,
    ),
    pool.query<{ id: number; wikidot_id: number }>(
      `SELECT id,wikidot_id FROM ingest.page WHERE wikidot_id=ANY($1::int[])`,
      [linkedPages.map((item) => item.wikidotId)],
    ),
    pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM ingest."user" WHERE wikidot_id=ANY($1::int[])`,
      [forumAuthorIds],
    ),
    pool.query<ProgressRow>(
      `SELECT shard,last_page_id,done_count::text,total_count::text
         FROM meta.backfill_progress
        WHERE domain=$1 ORDER BY shard`,
      [PROGRESS_DOMAIN],
    ),
  ]);
  const found = new Set(columns.rows.map((item) => `${item.table_name}.${item.column_name}`));
  const required = ['forum_thread.description', 'forum_post.created_by_type'];
  const row = state.rows[0]!;
  const v1ByWid = new Map(linkedPages.map((item) => [item.wikidotId, item.v1Id]));
  const matchedWids = new Set(pageMatches.rows.map((item) => item.wikidot_id));
  return {
    counts: {
      category: asNumber(row.categories),
      thread: asNumber(row.threads),
      post: asNumber(row.posts),
    },
    migrationReady: required.every((column) => found.has(column)),
    missingColumns: required.filter((column) => !found.has(column)),
    linkedPagesMissing: linkedPages.length - matchedWids.size,
    linkedPagesRemapped: pageMatches.rows.filter(
      (item) => v1ByWid.get(item.wikidot_id) !== item.id,
    ).length,
    knownForumAuthors: asNumber(authorMatches.rows[0]?.n ?? '0'),
    forumAuthorsExpected: forumAuthorIds.length,
    pageIdSources: parseDistribution(row.page_sources),
    progress: progress.rows,
  };
}

function makeDryRunReport(
  opts: CliOptions,
  sourceDb: string,
  targetDb: string,
  source: SourceStats,
  target: TargetPreflight,
): DryRunReport {
  const assertions = [
    {
      name: 'v1 帖子作者 wid 全部可解析',
      ok: source.postAuthorsUnresolved === 0,
      actual: `unresolved=${source.postAuthorsUnresolved}`,
    },
    {
      name: 'v1 parentId 不断链且不跨主题',
      ok: source.orphanParents === 0 && source.crossThreadParents === 0,
      actual: `orphan=${source.orphanParents}, cross_thread=${source.crossThreadParents}`,
    },
    {
      name: 'v1 推断 pageId 可按稳定 wikidot_id 映射到 v2',
      ok: true,
      actual:
        `existing=${source.pageLinks - target.linkedPagesMissing}/${source.pageLinks}, ` +
        `register_page=${target.linkedPagesMissing}, remapped_internal_id=${target.linkedPagesRemapped}`,
    },
    {
      name: '0205 保真列已应用',
      ok: target.migrationReady,
      actual: target.migrationReady ? 'ready' : `missing=${target.missingColumns.join(',')}`,
    },
  ];
  return {
    mode: opts.execute ? 'execute' : 'dry-run',
    sourceDatabase: sourceDb,
    targetDatabase: targetDb,
    expected: source,
    targetBefore: target,
    ddlAssessment: {
      forumThreadDescription:
        `必须加列：${source.threadDescriptions} 个非空 description 是真实用户内容，不能用其它列无损表达。`,
      forumPostCreatedByType:
        `必须加列：${source.deletedPosts} 帖需要 deleted 徽章；author_user_id IS NULL ` +
        '无法区分 deleted/guest/anonymous，且本批 deleted 都有正 wid。',
      pageIdPolicy:
        `${source.pageLinks} 个 v1 pageId 仅以 page_id_source=inferred 结转；verified 优先且禁止被覆盖。`,
    },
    assertions,
    canExecute: assertions.every((item) => item.ok),
  };
}

function printReport(report: unknown, jsonOnly: boolean, label: string): void {
  if (!jsonOnly) process.stdout.write(`${label}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

async function freezeForumWrites(pool: Pool): Promise<void> {
  const status = await pool.query<{
    domain: string;
    frozen: boolean;
    reason: string | null;
    effective: boolean;
  }>(
    `SELECT domain,frozen,reason,effective
       FROM meta.write_freeze_status()
      WHERE domain IN ('all','forum') ORDER BY domain`,
  );
  const all = status.rows.find((row) => row.domain === 'all');
  const forum = status.rows.find((row) => row.domain === 'forum');
  if (all?.effective) throw new Error(`总写闸已冻结（${all.reason ?? '无原因'}），论坛回填不得绕过`);
  if (forum?.frozen && forum.reason !== FREEZE_REASON) {
    throw new Error(`forum 写闸已因其它原因冻结：${forum.reason ?? '无原因'}`);
  }
  if (!forum?.frozen) {
    await pool.query(`SELECT meta.freeze_writes('forum',$1,'syncer2-backfill-forum')`, [
      FREEZE_REASON,
    ]);
  }

  // 等待 freeze 前已经进入 apply_forum_batch 的事务退出。
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `LOCK TABLE ingest.forum_category,ingest.forum_thread,ingest.forum_post IN SHARE MODE`,
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function releaseForumWrites(pool: Pool): Promise<void> {
  await pool.query(`SELECT meta.release_writes('forum','syncer2-backfill-forum')`);
}

function totalForShard(stats: SourceStats, shard: Shard): number {
  if (shard === 'category') return stats.categories;
  if (shard === 'thread') return stats.threads;
  return stats.posts;
}

async function ensureProgress(client: PoolClient, stats: SourceStats): Promise<void> {
  for (const shard of SHARDS) {
    await client.query(
      `INSERT INTO meta.backfill_progress AS bp(
         domain,shard,last_page_id,done_count,total_count
       )
       VALUES ($1,$2,0,0,$3)
       ON CONFLICT (domain,shard) DO UPDATE
         SET last_page_id=CASE
               -- 已完成旧快照后源总量变化：可能是“补抓旧 ID”，不能只追 max(id)。
               WHEN bp.done_count>=COALESCE(bp.total_count,0)
                AND bp.total_count IS DISTINCT FROM EXCLUDED.total_count
               THEN 0 ELSE bp.last_page_id END,
             done_count=CASE
               WHEN bp.done_count>=COALESCE(bp.total_count,0)
                AND bp.total_count IS DISTINCT FROM EXCLUDED.total_count
               THEN 0 ELSE bp.done_count END,
             total_count=EXCLUDED.total_count,
             updated_at=now()`,
      [PROGRESS_DOMAIN, shard, totalForShard(stats, shard)],
    );
  }

  // 恢复旧版本脚本留下的状态：游标已经到本快照 max，但 done_count 仍不足，证明有
  // late-arriving lower id 被越过。整 shard 重扫仍走幂等 upsert。
  const maxima: Record<Shard, number> = {
    category: stats.categoryIdMax,
    thread: stats.threadIdMax,
    post: stats.postIdMax,
  };
  for (const shard of SHARDS) {
    await client.query(
      `UPDATE meta.backfill_progress
          SET last_page_id=0,done_count=0,updated_at=now()
        WHERE domain=$1 AND shard=$2
          AND done_count<COALESCE(total_count,0)
          AND last_page_id>=$3`,
      [PROGRESS_DOMAIN, shard, maxima[shard]],
    );
  }
}

async function ensureLinkedPages(
  client: PoolClient,
  linkedPages: readonly LinkedPage[],
  observedAt: string,
): Promise<Map<number, number>> {
  const wids = linkedPages.map((item) => item.wikidotId);
  const existing = await client.query<{ id: number; wikidot_id: number }>(
    `SELECT id,wikidot_id FROM ingest.page WHERE wikidot_id=ANY($1::int[])`,
    [wids],
  );
  const targetByWid = new Map(existing.rows.map((item) => [item.wikidot_id, item.id]));
  const missing = linkedPages.filter((item) => !targetByWid.has(item.wikidotId));
  if (missing.length > 0) {
    const registered = await client.query<{
      v1_id: number;
      wikidot_id: number;
      target_id: number;
    }>(
      `WITH input AS (
         SELECT * FROM jsonb_to_recordset($1::jsonb)
           AS x(v1_id int,wikidot_id int,slug text)
       )
       SELECT v1_id,wikidot_id,
              ingest.register_page(
                p_wikidot_id => wikidot_id,
                p_slug       => slug,
                p_observed   => $2::timestamptz,
                p_source     => 'v1_backfill'
              ) AS target_id
         FROM input ORDER BY v1_id`,
      [JSON.stringify(missing.map((item) => ({
        v1_id: item.v1Id,
        wikidot_id: item.wikidotId,
        slug: item.slug,
      }))), observedAt],
    );
    for (const row of registered.rows) targetByWid.set(row.wikidot_id, row.target_id);
  }
  const result = new Map<number, number>();
  for (const item of linkedPages) {
    const targetId = targetByWid.get(item.wikidotId);
    if (targetId === undefined) {
      throw new Error(`page v1_id=${item.v1Id} wid=${item.wikidotId} 未完成 register_page`);
    }
    result.set(item.v1Id, targetId);
  }
  return result;
}

async function progressCursor(client: PoolClient, shard: Shard): Promise<number> {
  const result = await client.query<{ last_page_id: number }>(
    `SELECT last_page_id FROM meta.backfill_progress
      WHERE domain=$1 AND shard=$2 FOR UPDATE`,
    [PROGRESS_DOMAIN, shard],
  );
  if (!result.rows[0]) throw new Error(`缺 progress ${PROGRESS_DOMAIN}/${shard}`);
  return result.rows[0].last_page_id;
}

async function advanceProgress(
  client: PoolClient,
  shard: Shard,
  maxId: number,
  rows: number,
  total: number,
): Promise<void> {
  await client.query(
    `UPDATE meta.backfill_progress
        SET last_page_id=$3,
            done_count=LEAST($5::bigint,done_count+$4::bigint),
            total_count=$5,
            updated_at=now()
      WHERE domain=$1 AND shard=$2`,
    [PROGRESS_DOMAIN, shard, maxId, rows, total],
  );
}

function mergeAuthorInputs(
  rows: readonly ForumAuthorInput[],
  cache: ReadonlyMap<number, number>,
): ForumAuthorInput[] {
  const merged = new Map<number, ForumAuthorInput>();
  for (const item of rows) {
    if (cache.has(item.wikidotId)) continue;
    const prior = merged.get(item.wikidotId);
    if (!prior || (prior.displayName === null && item.displayName !== null)) {
      merged.set(item.wikidotId, item);
    }
  }
  return [...merged.values()];
}

async function ensureAuthors(
  client: PoolClient,
  authors: readonly ForumAuthorInput[],
  cache: Map<number, number>,
): Promise<void> {
  const pending = mergeAuthorInputs(authors, cache);
  if (pending.length === 0) return;
  const result = await client.query<{ wikidot_id: number; user_id: number }>(
    `WITH input AS (
       SELECT * FROM jsonb_to_recordset($1::jsonb)
         AS x(wikidot_id int,display_name text)
     ), state AS MATERIALIZED (
       SELECT i.*,u.id AS existing_id
         FROM input i LEFT JOIN ingest."user" u ON u.wikidot_id=i.wikidot_id
     )
     SELECT wikidot_id,
            ingest.ensure_user(
              p_kind         => 'wikidot',
              p_wikidot_id   => wikidot_id,
              p_display_name => CASE WHEN existing_id IS NULL THEN display_name ELSE NULL END
            ) AS user_id
       FROM state
      ORDER BY wikidot_id`,
    [
      JSON.stringify(
        pending.map((item) => ({
          wikidot_id: item.wikidotId,
          display_name: item.displayName,
        })),
      ),
    ],
  );
  for (const row of result.rows) cache.set(row.wikidot_id, row.user_id);
  if (result.rows.length !== pending.length) {
    throw new Error(`ensure_user 回显 ${result.rows.length}/${pending.length}`);
  }
}

async function callApplyForumBatch(
  client: PoolClient,
  categories: readonly Record<string, unknown>[],
  threads: readonly Record<string, unknown>[],
  posts: readonly Record<string, unknown>[],
  observedAt: string,
  runId: number,
): Promise<Record<string, unknown>> {
  const result = await client.query<{ result: Record<string, unknown> }>(
    `SELECT ingest.apply_forum_batch(
       $1::jsonb,$2::jsonb,$3::jsonb,$4::timestamptz,'v1_backfill',$5
     ) AS result`,
    [
      JSON.stringify(categories),
      JSON.stringify(threads),
      JSON.stringify(posts),
      observedAt,
      runId,
    ],
  );
  return result.rows[0]?.result ?? {};
}

async function executeCategoryShard(
  source: PoolClient,
  target: PoolClient,
  stats: SourceStats,
  batchSize: number,
  observedAt: string,
  runId: number,
): Promise<void> {
  let cursor = await progressCursor(target, 'category');
  while (true) {
    const fetched = await source.query<CategoryRow>(
      `SELECT id,title,description,
              "threadsCount" AS thread_count,"postsCount" AS post_count
         FROM public."ForumCategory"
        WHERE id>$1 ORDER BY id LIMIT $2`,
      [cursor, batchSize],
    );
    if (fetched.rows.length === 0) return;
    await target.query('BEGIN');
    try {
      await target.query(`SET LOCAL scpper.freeze_bypass='on'`);
      const payload = fetched.rows.map((row) => ({ ...row }));
      const applied = await callApplyForumBatch(target, payload, [], [], observedAt, runId);
      if (asNumber(applied.categories) !== payload.length) {
        throw new Error(`category apply=${String(applied.categories)} batch=${payload.length}`);
      }
      cursor = fetched.rows.at(-1)!.id;
      await advanceProgress(target, 'category', cursor, payload.length, stats.categories);
      await target.query('COMMIT');
    } catch (error) {
      await target.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
  }
}

async function executeThreadShard(
  source: PoolClient,
  target: PoolClient,
  stats: SourceStats,
  batchSize: number,
  observedAt: string,
  runId: number,
  authorCache: Map<number, number>,
  pageIdMap: ReadonlyMap<number, number>,
): Promise<void> {
  let cursor = await progressCursor(target, 'thread');
  while (true) {
    const fetched = await source.query<V1ForumThreadRow>(
      `SELECT id,"categoryId" AS category_id,title,
              CASE WHEN NULLIF(btrim(description),'') IS NULL THEN NULL ELSE description END
                AS description,
              "createdByName" AS created_by_name,
              "createdByWikidotId" AS created_by_wikidot_id,
              to_char("createdAt",'YYYY-MM-DD"T"HH24:MI:SS.US')||'Z' AS created_at,
              "postCount" AS post_count,"isDeleted" AS is_deleted,"pageId" AS page_id
         FROM public."ForumThread"
        WHERE id>$1 ORDER BY id LIMIT $2`,
      [cursor, batchSize],
    );
    if (fetched.rows.length === 0) return;
    await target.query('BEGIN');
    try {
      await target.query(`SET LOCAL scpper.freeze_bypass='on'`);
      const inputs = fetched.rows
        .map((row) => authorInput(row.created_by_wikidot_id, row.created_by_name, null))
        .filter((item): item is ForumAuthorInput => item !== null);
      await ensureAuthors(target, inputs, authorCache);
      const payload = fetched.rows.map((row) => {
        const userId =
          row.created_by_wikidot_id !== null
            ? authorCache.get(row.created_by_wikidot_id) ?? null
            : null;
        if (row.created_by_wikidot_id !== null && row.created_by_wikidot_id > 0 && userId === null) {
          throw new Error(`thread ${row.id} 作者 wid=${row.created_by_wikidot_id} 未归一`);
        }
        const targetPageId =
          row.page_id === null ? null : pageIdMap.get(row.page_id);
        if (row.page_id !== null && targetPageId === undefined) {
          throw new Error(`thread ${row.id} 的 v1 page_id=${row.page_id} 未映射`);
        }
        return threadPayload(row, userId, targetPageId ?? null);
      });
      const applied = await callApplyForumBatch(target, [], payload, [], observedAt, runId);
      if (asNumber(applied.threads) !== payload.length || asNumber(applied.quarantined) !== 0) {
        throw new Error(`thread apply 异常：${JSON.stringify(applied)} batch=${payload.length}`);
      }
      cursor = fetched.rows.at(-1)!.id;
      await advanceProgress(target, 'thread', cursor, payload.length, stats.threads);
      await target.query('COMMIT');
    } catch (error) {
      await target.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
  }
}

async function executePostShard(
  source: PoolClient,
  target: PoolClient,
  stats: SourceStats,
  batchSize: number,
  observedAt: string,
  runId: number,
  authorCache: Map<number, number>,
): Promise<void> {
  let cursor = await progressCursor(target, 'post');
  while (true) {
    const fetched = await source.query<V1ForumPostRow>(
      `SELECT id,"threadId" AS thread_id,"parentId" AS parent_post_id,
              NULLIF(title,'') AS title,
              "textHtml" AS text_html,"createdByName" AS created_by_name,
              "createdByWikidotId" AS created_by_wikidot_id,
              "createdByType" AS created_by_type,
              to_char("createdAt",'YYYY-MM-DD"T"HH24:MI:SS.US')||'Z' AS created_at,
              CASE WHEN "editedAt" IS NULL THEN NULL
                   ELSE to_char("editedAt",'YYYY-MM-DD"T"HH24:MI:SS.US')||'Z' END AS edited_at,
              "isDeleted" AS is_deleted
         FROM public."ForumPost"
        WHERE id>$1 ORDER BY id LIMIT $2`,
      [cursor, batchSize],
    );
    if (fetched.rows.length === 0) return;
    await target.query('BEGIN');
    try {
      await target.query(`SET LOCAL scpper.freeze_bypass='on'`);
      const inputs = fetched.rows
        .map((row) =>
          authorInput(row.created_by_wikidot_id, row.created_by_name, row.created_by_type),
        )
        .filter((item): item is ForumAuthorInput => item !== null);
      await ensureAuthors(target, inputs, authorCache);
      const payload = fetched.rows.map((row) => {
        const userId = authorCache.get(row.created_by_wikidot_id);
        if (userId === undefined) {
          throw new Error(`post ${row.id} 作者 wid=${row.created_by_wikidot_id} 未归一`);
        }
        return postPayload(row, userId);
      });
      const applied = await callApplyForumBatch(target, [], [], payload, observedAt, runId);
      if (asNumber(applied.posts) !== payload.length || asNumber(applied.quarantined) !== 0) {
        throw new Error(`post apply 异常：${JSON.stringify(applied)} batch=${payload.length}`);
      }
      cursor = fetched.rows.at(-1)!.id;
      await advanceProgress(target, 'post', cursor, payload.length, stats.posts);
      await target.query('COMMIT');
    } catch (error) {
      await target.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
  }
}

async function fingerprint(
  client: PoolClient | Pool,
  sql: string,
  params: readonly unknown[] = [],
): Promise<string> {
  const result = await client.query<{ fingerprint: string | null }>(sql, params as unknown[]);
  return result.rows[0]?.fingerprint ?? '';
}

interface SampleSourcePost extends QueryResultRow {
  id: number;
  thread_id: number;
  parent_post_id: number | null;
  title: string | null;
  text_html: string;
  created_by_name: string;
  author_wikidot_id: number;
  created_by_type: string;
  created_at: string;
  edited_at: string | null;
  is_deleted: boolean;
}

async function validateSample(
  source: PoolClient,
  target: Pool | PoolClient,
  sampleSize: number,
): Promise<ValidationReport['sample']> {
  const ids = await source.query<{ id: number }>(
    `SELECT id FROM public."ForumThread" ORDER BY md5(id::text),id LIMIT $1`,
    [sampleSize],
  );
  const threadIds = ids.rows.map((row) => row.id);
  const [sourcePosts, targetPosts] = await Promise.all([
    source.query<SampleSourcePost>(
      `SELECT id,"threadId" AS thread_id,"parentId" AS parent_post_id,
              NULLIF(title,'') AS title,
              "textHtml" AS text_html,"createdByName" AS created_by_name,
              "createdByWikidotId" AS author_wikidot_id,
              "createdByType" AS created_by_type,
              to_char("createdAt",'YYYY-MM-DD"T"HH24:MI:SS.US')||'Z' AS created_at,
              CASE WHEN "editedAt" IS NULL THEN NULL
                   ELSE to_char("editedAt",'YYYY-MM-DD"T"HH24:MI:SS.US')||'Z' END AS edited_at,
              "isDeleted" AS is_deleted
         FROM public."ForumPost"
        WHERE "threadId"=ANY($1::int[])
        ORDER BY "threadId","createdAt",id`,
      [threadIds],
    ),
    target.query<SampleSourcePost>(
      `SELECT fp.id::int,fp.thread_id::int,
              CASE WHEN fp.parent_post_id IS NULL THEN NULL ELSE fp.parent_post_id::int END
                AS parent_post_id,
              fp.title,fp.text_html,
              fp.author_name AS created_by_name,u.wikidot_id AS author_wikidot_id,
              fp.created_by_type,
              to_char(fp.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US')||'Z'
                AS created_at,
              CASE WHEN fp.edited_at IS NULL THEN NULL
                   ELSE to_char(fp.edited_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US')||'Z'
              END AS edited_at,
              fp.is_deleted
         FROM ingest.forum_post fp
         LEFT JOIN ingest."user" u ON u.id=fp.author_user_id
        WHERE fp.thread_id=ANY($1::bigint[])
        ORDER BY fp.thread_id,fp.created_at,fp.id`,
      [threadIds],
    ),
  ]);
  const targetById = new Map(targetPosts.rows.map((row) => [row.id, row]));
  const mismatches: string[] = [];
  for (const row of sourcePosts.rows) {
    const actual = targetById.get(row.id);
    if (!actual) {
      mismatches.push(`post=${row.id}:missing`);
      continue;
    }
    const commonEqual =
      actual.thread_id === row.thread_id &&
      actual.parent_post_id === row.parent_post_id &&
      actual.title === row.title &&
      actual.text_html === row.text_html &&
      actual.author_wikidot_id === row.author_wikidot_id &&
      actual.created_by_type === row.created_by_type &&
      actual.created_at === row.created_at &&
      actual.edited_at === row.edited_at &&
      actual.is_deleted === row.is_deleted;
    const deletedNameEqual =
      row.created_by_type !== 'deleted' || actual.created_by_name === row.created_by_name;
    if (!commonEqual || !deletedNameEqual) mismatches.push(`post=${row.id}:field_mismatch`);
    targetById.delete(row.id);
  }
  for (const extra of targetById.keys()) mismatches.push(`post=${extra}:extra`);
  return {
    threads: threadIds.length,
    posts: sourcePosts.rows.length,
    mismatches: mismatches.length,
    examples: mismatches.slice(0, 20),
  };
}

async function validateBackfill(
  source: PoolClient,
  target: Pool | PoolClient,
  stats: SourceStats,
  sampleSize: number,
  pageIdMap: ReadonlyMap<number, number>,
): Promise<ValidationReport> {
  // 同一个 PoolClient 上不并发 query：pg@9 将移除这种隐式排队行为。
  const sourceFloor = await fingerprint(
    source,
    `SELECT md5(string_agg("threadId"::text||':'||id::text,','
                ORDER BY "threadId","createdAt",id)) AS fingerprint
       FROM public."ForumPost"`,
  );
  const sourceParent = await fingerprint(
    source,
    `SELECT md5(string_agg(id::text||':'||COALESCE("parentId"::text,'null'),','
                ORDER BY id)) AS fingerprint
       FROM public."ForumPost"`,
  );
  const sourceDesc = await fingerprint(
    source,
    `SELECT md5(string_agg(
                id::text||':'||COALESCE(NULLIF(btrim(description),''),'<NULL>'),E'\\n'
                ORDER BY id)) AS fingerprint
       FROM public."ForumThread"`,
  );
  const targetState = await target.query<{
        categories: string;
        threads: string;
        posts: string;
        page_nonnull: string;
        page_inferred: string;
        page_verified: string;
        page_without_source: string;
        descriptions: string;
        orphan_parents: string;
        cross_thread_parents: string;
        post_authors_missing: string;
        deleted_authors: string;
        deleted_names_missing: string;
        post_types: unknown;
      }>(
        `SELECT
           (SELECT count(*) FROM ingest.forum_category)::text AS categories,
           (SELECT count(*) FROM ingest.forum_thread)::text AS threads,
           -- created_by_type 是 0205 后每个 v1 帖子的必填保真证据。用它计数并与下方
           -- 完整分布共同断言：既验证行数，也验证没有“已写行但漏徽章”的半成品。
           (SELECT count(created_by_type) FROM ingest.forum_post)::text AS posts,
           (SELECT count(*) FROM ingest.forum_thread WHERE page_id IS NOT NULL)::text
             AS page_nonnull,
           (SELECT count(*) FROM ingest.forum_thread WHERE page_id_source='inferred')::text
             AS page_inferred,
           (SELECT count(*) FROM ingest.forum_thread WHERE page_id_source='verified')::text
             AS page_verified,
           (SELECT count(*) FROM ingest.forum_thread
             WHERE page_id IS NOT NULL AND page_id_source IS NULL)::text AS page_without_source,
           (SELECT count(*) FROM ingest.forum_thread WHERE description IS NOT NULL)::text
             AS descriptions,
           (SELECT count(*) FROM ingest.forum_post child
              LEFT JOIN ingest.forum_post parent ON parent.id=child.parent_post_id
             WHERE child.parent_post_id IS NOT NULL AND parent.id IS NULL)::text AS orphan_parents,
           (SELECT count(*) FROM ingest.forum_post child
              JOIN ingest.forum_post parent ON parent.id=child.parent_post_id
             WHERE parent.thread_id<>child.thread_id)::text AS cross_thread_parents,
           (SELECT count(*) FROM ingest.forum_post WHERE author_user_id IS NULL)::text
             AS post_authors_missing,
           (SELECT count(DISTINCT author_user_id) FROM ingest.forum_post
             WHERE created_by_type='deleted')::text AS deleted_authors,
           (SELECT count(*) FROM ingest.forum_post
             WHERE created_by_type='deleted'
               AND (author_name IS NULL OR btrim(author_name)=''))::text AS deleted_names_missing,
           (SELECT COALESCE(jsonb_object_agg(kind,n),'{}'::jsonb)
              FROM (SELECT COALESCE(created_by_type,'(null)') kind,count(*) n
                      FROM ingest.forum_post GROUP BY 1) d) AS post_types`,
      );
  const targetFloor = await fingerprint(
    target,
    `SELECT md5(string_agg(thread_id::text||':'||id::text,','
                ORDER BY thread_id,created_at,id)) AS fingerprint
       FROM ingest.forum_post`,
  );
  const targetParent = await fingerprint(
    target,
    `SELECT md5(string_agg(id::text||':'||COALESCE(parent_post_id::text,'null'),','
                ORDER BY id)) AS fingerprint
       FROM ingest.forum_post`,
  );
  const targetDesc = await fingerprint(
    target,
    `SELECT md5(string_agg(id::text||':'||COALESCE(description,'<NULL>'),E'\\n'
                ORDER BY id)) AS fingerprint
       FROM ingest.forum_thread`,
  );
  const row = targetState.rows[0]!;
  const verifiedRows = await target.query<{ id: string }>(
    `SELECT id::text FROM ingest.forum_thread WHERE page_id_source='verified' ORDER BY id`,
  );
  const verifiedIds = verifiedRows.rows.map((item) => asNumber(item.id));
  const verifiedSource = await source.query<{ linked: string }>(
    `SELECT count(*)::text AS linked
       FROM public."ForumThread"
      WHERE "pageId" IS NOT NULL AND id=ANY($1::int[])`,
    [verifiedIds],
  );
  const verifiedAmongLinked = asNumber(verifiedSource.rows[0]?.linked ?? '0');
  const verifiedCount = asNumber(row.page_verified);
  const expectedInferred = stats.pageLinks - verifiedAmongLinked;
  const expectedNonNull = stats.pageLinks + verifiedCount - verifiedAmongLinked;
  const sourceInferredRows = await source.query<{ id: number; page_id: number }>(
    `SELECT id,"pageId" AS page_id FROM public."ForumThread"
      WHERE "pageId" IS NOT NULL AND NOT (id=ANY($1::int[])) ORDER BY id`,
    [verifiedIds],
  );
  const targetInferredRows = await target.query<{ id: string; page_id: number }>(
    `SELECT id::text,page_id FROM ingest.forum_thread
      WHERE page_id_source='inferred' ORDER BY id`,
  );
  const sample = await validateSample(source, target, sampleSize);
  const targetInferredById = new Map(
    targetInferredRows.rows.map((item) => [asNumber(item.id), item.page_id]),
  );
  const inferredMappingsEqual =
    sourceInferredRows.rows.length === targetInferredRows.rows.length &&
    sourceInferredRows.rows.every(
      (item) => targetInferredById.get(item.id) === pageIdMap.get(item.page_id),
    );
  const counts = {
    category: asNumber(row.categories),
    thread: asNumber(row.threads),
    post: asNumber(row.posts),
  };
  const typeDistribution = parseDistribution(row.post_types);
  const report: ValidationReport = {
    counts,
    pageId: {
      nonnull: asNumber(row.page_nonnull),
      inferred: asNumber(row.page_inferred),
      verified: verifiedCount,
      withoutSource: asNumber(row.page_without_source),
      expectedInferred,
      expectedNonNull,
      inferredFingerprintEqual: inferredMappingsEqual,
    },
    floorOrderFingerprintEqual: sourceFloor === targetFloor,
    parentFingerprintEqual: sourceParent === targetParent,
    orphanParents: asNumber(row.orphan_parents),
    crossThreadParents: asNumber(row.cross_thread_parents),
    threadDescriptions: asNumber(row.descriptions),
    threadDescriptionFingerprintEqual: sourceDesc === targetDesc,
    postTypeDistribution: typeDistribution,
    postTypeDistributionEqual:
      JSON.stringify(typeDistribution) === JSON.stringify(stats.postTypeDistribution),
    postAuthorsMissing: asNumber(row.post_authors_missing),
    deletedAuthors: asNumber(row.deleted_authors),
    deletedAuthorNamesMissing: asNumber(row.deleted_names_missing),
    sample,
    assertions: [],
  };
  report.assertions = [
    {
      name: '三表行数与 v1 一致',
      ok:
        counts.category === stats.categories &&
        counts.thread === stats.threads &&
        counts.post === stats.posts,
      actual: `category=${counts.category}/${stats.categories}, thread=${counts.thread}/${stats.threads}, post=${counts.post}/${stats.posts}`,
    },
    {
      name: 'page_id 来源分布与 A4 预期一致',
      ok:
        report.pageId.inferred === expectedInferred &&
        report.pageId.nonnull === expectedNonNull &&
        report.pageId.withoutSource === 0 &&
        report.pageId.inferredFingerprintEqual,
      actual: JSON.stringify(report.pageId),
    },
    {
      name: '楼层顺序 (thread_id,created_at,id) 与 v1 一致',
      ok: report.floorOrderFingerprintEqual,
      actual: String(report.floorOrderFingerprintEqual),
    },
    {
      name: 'parent_post_id 映射完整且逐行一致',
      ok:
        report.parentFingerprintEqual &&
        report.orphanParents === 0 &&
        report.crossThreadParents === 0,
      actual: `fingerprint=${report.parentFingerprintEqual}, orphan=${report.orphanParents}, cross=${report.crossThreadParents}`,
    },
    {
      name: `${sampleSize} 个主题逐帖内容与作者一致`,
      ok: sample.threads === sampleSize && sample.mismatches === 0,
      actual: `threads=${sample.threads}, posts=${sample.posts}, mismatches=${sample.mismatches}`,
    },
    {
      name: 'thread.description 全量保真',
      ok:
        report.threadDescriptions === stats.threadDescriptions &&
        report.threadDescriptionFingerprintEqual,
      actual: `nonnull=${report.threadDescriptions}/${stats.threadDescriptions}, fingerprint=${report.threadDescriptionFingerprintEqual}`,
    },
    {
      name: 'created_by_type 分布与注销作者身份保真',
      ok:
        report.postTypeDistributionEqual &&
        report.postAuthorsMissing === 0 &&
        report.deletedAuthors === stats.deletedAuthors &&
        report.deletedAuthorNamesMissing === 0,
      actual:
        `types=${JSON.stringify(report.postTypeDistribution)}, missing_actor=${report.postAuthorsMissing}, ` +
        `deleted_authors=${report.deletedAuthors}/${stats.deletedAuthors}, missing_name=${report.deletedAuthorNamesMissing}`,
    },
  ];
  return report;
}

async function run(): Promise<void> {
  const opts = parseArgs();
  const sourceDb = databaseName(opts.v1DatabaseUrl);
  const targetDb = databaseName(opts.targetDatabaseUrl);
  if (!['scpper-cn', 'scpper_cn'].includes(sourceDb)) {
    throw new Error(`v1 源库必须是 scpper-cn/scpper_cn，拿到 ${sourceDb}`);
  }
  if (PROTECTED_TARGETS.has(targetDb)) throw new Error(`拒绝把受保护库 ${targetDb} 当写入目标`);
  if (sourceDb === targetDb) throw new Error('源库与目标库不能相同');

  const sourcePool = createBackfillPool(opts.v1DatabaseUrl, {
    readOnly: true,
    applicationName: 'syncer2-backfill-forum-source-ro',
    max: 1,
  });
  const targetPool = createBackfillPool(opts.targetDatabaseUrl, {
    readOnly: !opts.execute,
    applicationName: opts.execute
      ? 'syncer2-backfill-forum-target'
      : 'syncer2-backfill-forum-target-ro',
    max: 3,
  });
  const sourceClient = await sourcePool.connect();
  let runId: number | null = null;
  try {
    await sourceClient.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await sourceClient.query(`SET LOCAL TIME ZONE 'UTC'`);
    const source = await loadSourceStats(sourceClient);
    const target = await loadTargetPreflight(
      targetPool,
      source.linkedPages,
      source.forumAuthorIds,
    );
    const report = makeDryRunReport(opts, sourceDb, targetDb, source.stats, target);
    printReport(report, opts.json, `forum ${report.mode}: ${sourceDb} → ${targetDb}`);
    if (!opts.execute) {
      await sourceClient.query('ROLLBACK');
      return;
    }
    if (!report.canExecute) {
      throw new Error('论坛回填执行前硬闸未通过；未写目标库');
    }

    await freezeForumWrites(targetPool);
    const frozenTarget = await loadTargetPreflight(
      targetPool,
      source.linkedPages,
      source.forumAuthorIds,
    );
    const frozenReport = makeDryRunReport(
      opts,
      sourceDb,
      targetDb,
      source.stats,
      frozenTarget,
    );
    if (!frozenReport.canExecute) {
      throw new Error(`forum 冻结后二次硬闸失败；写闸保持冻结：${JSON.stringify(frozenReport)}`);
    }

    const lockClient = await targetPool.connect();
    let pageIdMap = new Map<number, number>();
    try {
      await lockClient.query(`SELECT pg_advisory_lock(hashtext('backfill:forum_v1'))`);
      const run = await lockClient.query<{ id: string }>(
        `INSERT INTO meta.ingest_run(source,status,started_at,stats)
         VALUES ('v1_backfill','running',now(),
                 jsonb_build_object('domain','forum','source_database',$1::text))
         RETURNING id::text`,
        [sourceDb],
      );
      runId = asNumber(run.rows[0]!.id);
      await lockClient.query('BEGIN');
      await ensureProgress(lockClient, source.stats);
      await lockClient.query('COMMIT');

      const observedAt = new Date().toISOString();
      await lockClient.query('BEGIN');
      try {
        pageIdMap = await ensureLinkedPages(lockClient, source.linkedPages, observedAt);
        await lockClient.query('COMMIT');
      } catch (error) {
        await lockClient.query('ROLLBACK').catch(() => undefined);
        throw error;
      }
      const authorCache = new Map<number, number>();
      await executeCategoryShard(
        sourceClient,
        lockClient,
        source.stats,
        opts.batchSize,
        observedAt,
        runId,
      );
      await executeThreadShard(
        sourceClient,
        lockClient,
        source.stats,
        opts.batchSize,
        observedAt,
        runId,
        authorCache,
        pageIdMap,
      );
      await executePostShard(
        sourceClient,
        lockClient,
        source.stats,
        opts.batchSize,
        observedAt,
        runId,
        authorCache,
      );
    } finally {
      await lockClient
        .query(`SELECT pg_advisory_unlock(hashtext('backfill:forum_v1'))`)
        .catch(() => undefined);
      lockClient.release();
    }

    const validationClient = await targetPool.connect();
    let validation: ValidationReport;
    try {
      await validationClient.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      validation = await validateBackfill(
        sourceClient,
        validationClient,
        source.stats,
        opts.sampleSize,
        pageIdMap,
      );
      await validationClient.query('COMMIT');
    } catch (error) {
      await validationClient.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      validationClient.release();
    }
    printReport(validation, opts.json, 'forum validation');
    if (validation.assertions.some((item) => !item.ok)) {
      throw new Error(`论坛写后断言失败：${JSON.stringify(validation.assertions)}`);
    }
    await targetPool.query(
      `UPDATE meta.ingest_run
          SET status='ok',finished_at=now(),stats=stats||$2::jsonb
        WHERE id=$1`,
      [runId, JSON.stringify({ validation })],
    );
    await releaseForumWrites(targetPool);
    await sourceClient.query('COMMIT');
  } catch (error) {
    await sourceClient.query('ROLLBACK').catch(() => undefined);
    if (runId !== null) {
      await targetPool
        .query(
          `UPDATE meta.ingest_run
              SET status='failed',finished_at=now(),
                  stats=stats||jsonb_build_object('error',$2::text)
            WHERE id=$1 AND status='running'`,
          [runId, error instanceof Error ? error.message : String(error)],
        )
        .catch(() => undefined);
    }
    throw error;
  } finally {
    sourceClient.release();
    await Promise.all([sourcePool.end(), targetPool.end()]);
  }
}

run().catch((error) => {
  process.stderr.write(
    `[backfill-forum] ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
