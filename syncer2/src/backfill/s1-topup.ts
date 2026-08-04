/**
 * S1 identity top-up.
 *
 * v1 remains live during the backfill window.  This command is the repeatable
 * delta step: it inserts only v1 identities that are still absent from v2,
 * preserving Page.id/User.id verbatim.  The v1 connection is read-only from
 * the startup packet; the target is also read-only unless --execute is given.
 */

import { Command } from 'commander';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';

import { loadEnv } from '../config.js';
import {
  buildPagePlan,
  buildUserPlan,
  type PagePlan,
  type UserPlan,
  type V1PageRow,
  type V1UserRow,
} from './s1-model.js';

const PROTECTED_TARGETS = new Set(['scpper-cn', 'scpper_cn', 'scpper-syncer', 'scpper_user']);

interface Options {
  execute: boolean;
  batchSize: number;
  v1DatabaseUrl: string;
  targetDatabaseUrl: string;
  json: boolean;
}

interface TargetIdentity {
  id: number;
  wikidot_id: number | null;
  anon_key?: string | null;
}

interface SourceSnapshot {
  pages: PagePlan[];
  users: UserPlan[];
}

interface TargetSnapshot {
  pages: TargetIdentity[];
  users: TargetIdentity[];
  migrationReady: boolean;
}

interface TopUpPlan {
  pages: PagePlan[];
  users: UserPlan[];
  conflicts: string[];
}

function positiveInt(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`必须是正整数，拿到 ${value}`);
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
  if (!name) throw new Error('连接串缺数据库名');
  return name;
}

function parseArgs(): Options {
  loadEnv();
  const program = new Command();
  program
    .name('backfill-s1-topup')
    .description('S3 前置 identity top-up；默认只读，--execute 才补 v2 缺失身份')
    .option('--execute', '补写 v2 缺失身份', false)
    .option('--dry-run', '显式只读预演（默认）', false)
    .option('--batch-size <n>', '每事务身份数', positiveInt, 500)
    .option('--v1-database-url <url>', 'v1 scpper-cn（始终强制只读）')
    .option('--target-database-url <url>', 'v2 scpper-v2')
    .option('--json', '只输出 JSON', false);
  program.parse(process.argv);
  const raw = program.opts<{
    execute: boolean;
    dryRun: boolean;
    batchSize: number;
    v1DatabaseUrl?: string;
    targetDatabaseUrl?: string;
    json: boolean;
  }>();
  if (raw.execute && raw.dryRun) throw new Error('--execute 与 --dry-run 不能同时给');
  return {
    execute: raw.execute,
    batchSize: raw.batchSize,
    v1DatabaseUrl:
      raw.v1DatabaseUrl ?? mustEnv('SYNCER2_V1_DATABASE_URL', 'V1_DATABASE_URL', 'DATABASE_URL'),
    targetDatabaseUrl: raw.targetDatabaseUrl ?? mustEnv('SYNCER2_DATABASE_URL'),
    json: raw.json,
  };
}

function pool(
  connectionString: string,
  readOnly: boolean,
  applicationName: string,
): Pool {
  return new Pool({
    connectionString,
    max: 1,
    application_name: applicationName,
    options: readOnly
      ? '-c default_transaction_read_only=on -c statement_timeout=0'
      : '-c statement_timeout=0',
  });
}

async function rows<R extends QueryResultRow>(client: PoolClient, sql: string): Promise<R[]> {
  return (await client.query<R>(sql)).rows;
}

async function loadSource(client: PoolClient): Promise<SourceSnapshot> {
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await client.query(`SET LOCAL TIME ZONE 'UTC'`);
  const pageRows = await rows<V1PageRow>(
    client,
    `SELECT p.id, p."wikidotId" AS wikidot_id, p.url,
            p."currentUrl" AS current_url, p."urlHistory" AS url_history,
            CASE WHEN p."firstPublishedAt" IS NULL THEN NULL
                 ELSE to_char(p."firstPublishedAt", 'YYYY-MM-DD"T"HH24:MI:SS.US') || 'Z'
             END AS first_published_at,
            to_char(p."createdAt", 'YYYY-MM-DD"T"HH24:MI:SS.US') || 'Z' AS created_at
       FROM public."Page" p ORDER BY p.id`,
  );
  const userRows = await rows<V1UserRow>(
    client,
    `SELECT u.id, u."wikidotId" AS wikidot_id,
            u."displayName" AS display_name, u.username, u."isGuest" AS is_guest,
            EXISTS (SELECT 1 FROM public."CollectionAccountOwner" o
                     WHERE o."userId"=u.id) AS is_collection_synthetic
       FROM public."User" u ORDER BY u.id`,
  );
  return {
    pages: pageRows.map(buildPagePlan),
    users: userRows.map(buildUserPlan),
  };
}

async function loadTarget(target: Pool): Promise<TargetSnapshot> {
  const [pages, users, migration] = await Promise.all([
    target.query<TargetIdentity>(`SELECT id, wikidot_id FROM ingest.page ORDER BY id`),
    target.query<TargetIdentity>(
      `SELECT id, wikidot_id, anon_key FROM ingest."user" ORDER BY id`,
    ),
    target.query<{ ok: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.columns
          WHERE table_schema='ingest' AND table_name='user'
            AND column_name='username_is_legacy'
       )
       AND to_regprocedure('meta.v2_reserved_page_id_start()') IS NOT NULL
       AND to_regprocedure('meta.v2_reserved_anonymous_actor_id_start()') IS NOT NULL
       AS ok`,
    ),
  ]);
  return {
    pages: pages.rows,
    users: users.rows,
    migrationReady: migration.rows[0]?.ok === true,
  };
}

function buildTopUpPlan(source: SourceSnapshot, target: TargetSnapshot): TopUpPlan {
  const conflicts: string[] = [];
  const pageById = new Map(target.pages.map((row) => [row.id, row]));
  const pageByWid = new Map(
    target.pages
      .filter((row) => row.wikidot_id !== null)
      .map((row) => [row.wikidot_id as number, row]),
  );
  const userById = new Map(target.users.map((row) => [row.id, row]));
  const userByWid = new Map(
    target.users
      .filter((row) => row.wikidot_id !== null)
      .map((row) => [row.wikidot_id as number, row]),
  );
  const userByAnon = new Map(
    target.users
      .filter((row) => row.anon_key !== null && row.anon_key !== undefined)
      .map((row) => [row.anon_key as string, row]),
  );

  const missingPages: PagePlan[] = [];
  for (const page of source.pages) {
    const sameId = pageById.get(page.id);
    if (sameId) {
      if (sameId.wikidot_id !== page.wikidotId) {
        conflicts.push(
          `page id=${page.id}: v1 wid=${page.wikidotId}, v2 wid=${String(sameId.wikidot_id)}`,
        );
      }
      continue;
    }
    const sameWid = pageByWid.get(page.wikidotId);
    if (sameWid) {
      conflicts.push(`page wid=${page.wikidotId}: v1 id=${page.id}, v2 id=${sameWid.id}`);
      continue;
    }
    missingPages.push(page);
  }

  const missingUsers: UserPlan[] = [];
  for (const user of source.users) {
    const sameId = userById.get(user.id);
    if (sameId) {
      if (sameId.wikidot_id !== user.wikidotId) {
        conflicts.push(
          `user id=${user.id}: v1 wid=${String(user.wikidotId)}, v2 wid=${String(sameId.wikidot_id)}`,
        );
      }
      continue;
    }
    if (user.wikidotId !== null) {
      const sameWid = userByWid.get(user.wikidotId);
      if (sameWid) {
        conflicts.push(`user wid=${user.wikidotId}: v1 id=${user.id}, v2 id=${sameWid.id}`);
        continue;
      }
    }
    if (user.anonKey !== null) {
      const sameAnon = userByAnon.get(user.anonKey);
      if (sameAnon) {
        conflicts.push(`user anon_key=${user.anonKey}: v1 id=${user.id}, v2 id=${sameAnon.id}`);
        continue;
      }
    }
    missingUsers.push(user);
  }
  return { pages: missingPages, users: missingUsers, conflicts };
}

async function freezeIdentity(target: Pool): Promise<void> {
  const status = await target.query<{
    domain: string;
    effective: boolean;
    frozen: boolean;
    reason: string | null;
  }>(
    `SELECT domain, effective, frozen, reason
       FROM meta.write_freeze_status() WHERE domain IN ('all','identity')`,
  );
  const all = status.rows.find((row) => row.domain === 'all');
  const identity = status.rows.find((row) => row.domain === 'identity');
  if (all?.effective) throw new Error(`总写闸已冻结：${all.reason ?? '无原因'}`);
  if (identity?.effective && !identity.reason?.startsWith('v1→v2 S1 identity top-up')) {
    throw new Error(`identity 写闸被其它流程占用：${identity.reason ?? '无原因'}`);
  }
  if (!identity?.frozen) {
    await target.query(
      `SELECT meta.freeze_writes(
         'identity',
         'v1→v2 S1 identity top-up：S3 前补齐活库窗口增量',
         'syncer2-backfill-s1-topup'
       )`,
    );
  }
  const client = await target.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `LOCK TABLE ingest.page, ingest.page_slug_history, ingest."user" IN SHARE MODE`,
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function writePageBatch(client: PoolClient, batch: readonly PagePlan[]): Promise<void> {
  if (batch.length === 0) return;
  const payload = JSON.stringify(batch);
  await client.query(
    `WITH b AS (
       SELECT * FROM jsonb_to_recordset($1::jsonb)
         AS x(id int, "wikidotId" int, "currentSlug" text, slugs jsonb)
     )
     INSERT INTO ingest.page(id, wikidot_id)
     SELECT id, "wikidotId" FROM b
     ON CONFLICT (id) DO NOTHING`,
    [payload],
  );
  await client.query(
    `WITH b AS (
       SELECT * FROM jsonb_to_recordset($1::jsonb)
         AS x(id int, "wikidotId" int, "currentSlug" text, slugs jsonb)
     ), h AS (
       SELECT b.id AS page_id, s.slug, s.valid_from, s.valid_to
         FROM b CROSS JOIN LATERAL jsonb_to_recordset(b.slugs)
           AS s(slug text, valid_from timestamptz, valid_to timestamptz)
     )
     INSERT INTO ingest.page_slug_history(page_id, slug, valid_from, valid_to)
     SELECT page_id, slug, valid_from, valid_to FROM h
     ON CONFLICT (page_id, slug, valid_from) DO NOTHING`,
    [payload],
  );
}

async function writeUserBatch(client: PoolClient, batch: readonly UserPlan[]): Promise<void> {
  if (batch.length === 0) return;
  await client.query(
    `WITH b AS (
       SELECT * FROM jsonb_to_recordset($1::jsonb)
         AS x(id int, kind text, "wikidotId" int, "anonKey" text, username text,
              "displayName" text, "usernameIsLegacy" boolean)
     )
     INSERT INTO ingest."user"(
       id, kind, wikidot_id, anon_key, username, display_name, username_is_legacy
     )
     SELECT id, kind, "wikidotId", "anonKey", username, "displayName", "usernameIsLegacy"
       FROM b
     ON CONFLICT (id) DO NOTHING`,
    [JSON.stringify(batch)],
  );
}

async function executePlan(target: Pool, plan: TopUpPlan, batchSize: number): Promise<void> {
  const client = await target.connect();
  try {
    await client.query(`SELECT pg_advisory_lock(hashtext('backfill:s1_identity'))`);
    for (let i = 0; i < plan.pages.length; i += batchSize) {
      await client.query('BEGIN');
      try {
        await client.query(`SET LOCAL scpper.bypass_guard='on'`);
        await writePageBatch(client, plan.pages.slice(i, i + batchSize));
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      }
    }
    for (let i = 0; i < plan.users.length; i += batchSize) {
      await client.query('BEGIN');
      try {
        await client.query(`SET LOCAL scpper.bypass_guard='on'`);
        await writeUserBatch(client, plan.users.slice(i, i + batchSize));
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      }
    }
    await client.query('BEGIN');
    await client.query(
      `SELECT setval('ingest.page_id_seq',
                     GREATEST((SELECT last_value FROM ingest.page_id_seq),
                              meta.v2_reserved_page_id_start()::bigint-1,
                              COALESCE((SELECT max(id) FROM ingest.page), 1)), true),
              setval('ingest.user_id_seq',
                     GREATEST((SELECT last_value FROM ingest.user_id_seq),
                              meta.v2_reserved_anonymous_actor_id_start()::bigint-1,
                              COALESCE((SELECT max(id) FROM ingest."user"), 1)), true)`,
    );
    await client.query(
      `UPDATE meta.backfill_progress p
          SET last_page_id=CASE p.shard
                WHEN 'page' THEN (SELECT max(id) FROM ingest.page)
                WHEN 'user' THEN (SELECT max(id) FROM ingest."user") END,
              done_count=CASE p.shard
                WHEN 'page' THEN (SELECT count(*) FROM ingest.page)
                WHEN 'user' THEN (SELECT count(*) FROM ingest."user") END,
              total_count=CASE p.shard
                WHEN 'page' THEN (SELECT count(*) FROM ingest.page)
                WHEN 'user' THEN (SELECT count(*) FROM ingest."user") END,
              updated_at=now()
        WHERE p.domain='s1_identity' AND p.shard IN ('page','user')`,
    );
    await client.query('COMMIT');
  } finally {
    await client
      .query(`SELECT pg_advisory_unlock(hashtext('backfill:s1_identity'))`)
      .catch(() => undefined);
    client.release();
  }
}

function report(
  mode: 'dry-run' | 'execute',
  sourceDb: string,
  targetDb: string,
  source: SourceSnapshot,
  target: TargetSnapshot,
  plan: TopUpPlan,
): Record<string, unknown> {
  return {
    mode,
    sourceDatabase: sourceDb,
    targetDatabase: targetDb,
    source: { pages: source.pages.length, users: source.users.length },
    targetBefore: { pages: target.pages.length, users: target.users.length },
    missing: {
      pages: plan.pages.length,
      users: plan.users.length,
      pageIds: plan.pages.map((row) => row.id),
      userIds: plan.users.map((row) => row.id),
    },
    migrationReady: target.migrationReady,
    conflicts: plan.conflicts,
    canExecute: target.migrationReady && plan.conflicts.length === 0,
  };
}

async function run(): Promise<void> {
  const opts = parseArgs();
  const sourceDb = databaseName(opts.v1DatabaseUrl);
  const targetDb = databaseName(opts.targetDatabaseUrl);
  if (!['scpper-cn', 'scpper_cn'].includes(sourceDb)) {
    throw new Error(`v1 源库必须是 scpper-cn/scpper_cn，拿到 ${sourceDb}`);
  }
  if (PROTECTED_TARGETS.has(targetDb)) throw new Error(`拒绝把受保护库 ${targetDb} 当目标`);

  const sourcePool = pool(opts.v1DatabaseUrl, true, 'syncer2-s1-topup-source-ro');
  const targetPool = pool(
    opts.targetDatabaseUrl,
    !opts.execute,
    opts.execute ? 'syncer2-s1-topup-target' : 'syncer2-s1-topup-target-ro',
  );
  let sourceClient: PoolClient | null = await sourcePool.connect();
  try {
    let source = await loadSource(sourceClient);
    let target = await loadTarget(targetPool);
    let plan = buildTopUpPlan(source, target);
    const before = report(
      opts.execute ? 'execute' : 'dry-run',
      sourceDb,
      targetDb,
      source,
      target,
      plan,
    );
    if (!opts.json) process.stdout.write(`S1 top-up ${opts.execute ? 'execute' : 'dry-run'}\n`);
    process.stdout.write(`${JSON.stringify(before, null, 2)}\n`);
    await sourceClient.query('ROLLBACK');
    sourceClient.release();
    sourceClient = null;

    if (!opts.execute) return;
    if (before.canExecute !== true) throw new Error('identity top-up 硬闸未通过；未写目标库');

    await freezeIdentity(targetPool);
    // Re-open both snapshots after the v2 identity freeze to close the collector race.
    sourceClient = await sourcePool.connect();
    source = await loadSource(sourceClient);
    target = await loadTarget(targetPool);
    plan = buildTopUpPlan(source, target);
    if (!target.migrationReady || plan.conflicts.length > 0) {
      throw new Error(`冻结后二次硬闸失败：${JSON.stringify(plan.conflicts)}`);
    }
    await executePlan(targetPool, plan, opts.batchSize);
    const after = await loadTarget(targetPool);
    const remaining = buildTopUpPlan(source, after);
    if (remaining.pages.length > 0 || remaining.users.length > 0 || remaining.conflicts.length > 0) {
      throw new Error(`identity top-up 写后仍有残差：${JSON.stringify(remaining)}`);
    }
    await targetPool.query(
      `SELECT meta.release_writes('identity','syncer2-backfill-s1-topup')`,
    );
    process.stdout.write(
      `${JSON.stringify({
        completed: true,
        inserted: { pages: plan.pages.length, users: plan.users.length },
        targetAfter: { pages: after.pages.length, users: after.users.length },
        remaining: { pages: 0, users: 0, conflicts: 0 },
      })}\n`,
    );
    await sourceClient.query('COMMIT');
  } finally {
    if (sourceClient !== null) {
      await sourceClient.query('ROLLBACK').catch(() => undefined);
      sourceClient.release();
    }
    await Promise.all([sourcePool.end(), targetPool.end()]);
  }
}

run().catch((error) => {
  process.stderr.write(
    `[backfill-s1-topup] ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
