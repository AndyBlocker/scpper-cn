/**
 * v1 → v2 回填 S1（身份层）。
 *
 * 默认/--dry-run：两个连接都强制 default_transaction_read_only=on，只统计、不写。
 * --execute：源库仍由 startup option 强制只读；目标库按批事务提交，并在同一事务更新
 * meta.backfill_progress(domain='s1_identity', shard='page'|'user')。
 */

import { Command } from 'commander';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';

import { loadEnv } from '../config.js';
import {
  buildPagePlan,
  buildUserPlan,
  type BackfillUserKind,
  type PagePlan,
  type UserPlan,
  type V1PageRow,
  type V1UserRow,
} from './s1-model.js';

const PROTECTED_TARGETS = new Set(['scpper-cn', 'scpper_cn', 'scpper-syncer', 'scpper_user']);
const PROGRESS_DOMAIN = 's1_identity';
const REQUIRED_MIGRATION_COLUMN = 'username_is_legacy';

interface CliOptions {
  execute: boolean;
  batchSize: number;
  v1DatabaseUrl: string;
  targetDatabaseUrl: string;
  json: boolean;
}

interface TargetIdentity {
  id: number;
  wikidot_id: number | null;
}

interface TargetSlug {
  page_id: number;
  slug: string;
  valid_from: Date;
  valid_to: Date | null;
}

interface Assertion {
  name: string;
  ok: boolean;
  actual: string;
  samples?: string[];
}

interface DryRunReport {
  mode: 'dry-run' | 'execute';
  sourceDatabase: string;
  targetDatabase: string;
  expected: {
    pages: number;
    pageSlugHistory: number;
    users: number;
    userKinds: Record<BackfillUserKind, number>;
    pageIdMin: number | null;
    pageIdMax: number | null;
    userIdMin: number | null;
    userIdMax: number | null;
    currentUrlHttpsPrefix: number;
    anyUrlHttpsPrefix: number;
    normalizedSchemeDuplicatesRemoved: number;
    usernamesNonNull: number;
    usernamesMatchingLegacyFormula: number;
    ambiguousUserKindEvidence: number;
    anonymousVotes: number;
  };
  targetBefore: {
    pages: number;
    users: number;
    pageSlugHistory: number;
    migrationReady: boolean;
  };
  candidateAssertions: Assertion[];
  targetAssertions: Assertion[];
  readiness: Assertion[];
  canExecute: boolean;
}

interface LoadedSource {
  pages: V1PageRow[];
  users: V1UserRow[];
  anonymousVotes: number;
  usernamesMatchingLegacyFormula: number;
}

interface TargetState {
  pages: TargetIdentity[];
  users: TargetIdentity[];
  slugs: TargetSlug[];
  migrationReady: boolean;
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

function createBackfillPool(
  connectionString: string,
  opts: { readOnly: boolean; applicationName: string },
): Pool {
  return new Pool({
    connectionString,
    max: 1,
    idleTimeoutMillis: 5_000,
    connectionTimeoutMillis: 10_000,
    application_name: opts.applicationName,
    // startup packet 级写保护；即使未来误加一条 DML，也会由 PostgreSQL 拒绝。
    options: opts.readOnly
      ? '-c default_transaction_read_only=on -c statement_timeout=0'
      : '-c statement_timeout=0',
  });
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
    .name('backfill-s1')
    .description('v1→v2 S1 身份层回填；默认 dry-run，只允许 --execute 开启目标写入')
    .option('--execute', '正式按批写 v2；未给时永远是只读 dry-run', false)
    .option('--dry-run', '显式只读预演（默认行为）', false)
    .option('--batch-size <n>', '每个目标事务的身份数', intOption, 1_000)
    .option('--v1-database-url <url>', 'v1 scpper-cn 连接串（始终强制只读）')
    .option('--target-database-url <url>', 'v2 scpper-v2 连接串')
    .option('--json', '只输出 JSON 报告', false);
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
      raw.v1DatabaseUrl ?? mustEnv('V1_DATABASE_URL', 'DATABASE_URL'),
    targetDatabaseUrl:
      raw.targetDatabaseUrl ?? mustEnv('SYNCER2_DATABASE_URL'),
    json: raw.json,
  };
}

async function sourceQuery<R extends QueryResultRow>(
  client: PoolClient,
  sql: string,
): Promise<R[]> {
  const result = await client.query<R>(sql);
  return result.rows;
}

async function loadSourceSnapshot(client: PoolClient): Promise<LoadedSource> {
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await client.query(`SET LOCAL TIME ZONE 'UTC'`);

  const pages = await sourceQuery<V1PageRow>(
    client,
    `SELECT p.id,
            p."wikidotId" AS wikidot_id,
            p.url,
            p."currentUrl" AS current_url,
            p."urlHistory" AS url_history,
            CASE WHEN p."firstPublishedAt" IS NULL THEN NULL
                 ELSE to_char(p."firstPublishedAt", 'YYYY-MM-DD"T"HH24:MI:SS.US') || 'Z'
             END AS first_published_at,
            to_char(p."createdAt", 'YYYY-MM-DD"T"HH24:MI:SS.US') || 'Z' AS created_at
       FROM public."Page" p
      ORDER BY p.id`,
  );

  const users = await sourceQuery<V1UserRow>(
    client,
    `SELECT u.id,
            u."wikidotId" AS wikidot_id,
            u."displayName" AS display_name,
            u.username,
            u."isGuest" AS is_guest,
            EXISTS (
              SELECT 1 FROM public."CollectionAccountOwner" o WHERE o."userId" = u.id
            ) AS is_collection_synthetic
       FROM public."User" u
      ORDER BY u.id`,
  );

  const voteRows = await sourceQuery<{ n: string }>(
    client,
    `SELECT count(*)::text AS n FROM public."Vote" WHERE "anonKey" IS NOT NULL`,
  );
  const usernameRows = await sourceQuery<{ n: string }>(
    client,
    `SELECT count(*)::text AS n
       FROM public."User"
      WHERE username IS NOT NULL
        AND username = lower(replace("displayName", ' ', '_'))`,
  );

  return {
    pages,
    users,
    anonymousVotes: Number(voteRows[0]?.n ?? '0'),
    usernamesMatchingLegacyFormula: Number(usernameRows[0]?.n ?? '0'),
  };
}

async function loadTargetState(pool: Pool): Promise<TargetState> {
  const [pageRows, userRows, slugRows, migrationRows] = await Promise.all([
    pool.query<TargetIdentity>(`SELECT id, wikidot_id FROM ingest.page ORDER BY id`),
    pool.query<TargetIdentity>(`SELECT id, wikidot_id FROM ingest."user" ORDER BY id`),
    pool.query<TargetSlug>(
      `SELECT page_id, slug, valid_from, valid_to
         FROM ingest.page_slug_history
        ORDER BY page_id, valid_from, id`,
    ),
    pool.query<{ ok: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.columns
          WHERE table_schema='ingest' AND table_name='user'
            AND column_name=$1
       ) AS ok`,
      [REQUIRED_MIGRATION_COLUMN],
    ),
  ]);
  return {
    pages: pageRows.rows,
    users: userRows.rows,
    slugs: slugRows.rows,
    migrationReady: migrationRows.rows[0]?.ok === true,
  };
}

function identityAssertions(
  entity: 'Page' | 'User',
  planned: readonly TargetIdentity[],
  actual: readonly TargetIdentity[],
): Assertion[] {
  const plannedById = new Map(planned.map((row) => [row.id, row.wikidot_id]));
  const actualById = new Map(actual.map((row) => [row.id, row.wikidot_id]));
  const missing = planned.filter((row) => !actualById.has(row.id));
  const extra = actual.filter((row) => !plannedById.has(row.id));
  const mismatch = planned.filter(
    (row) => actualById.has(row.id) && actualById.get(row.id) !== row.wikidot_id,
  );

  return [
    {
      name: `${entity}.id 集合逐行相等`,
      ok: missing.length === 0 && extra.length === 0,
      actual: `missing=${missing.length}, extra=${extra.length}`,
      samples: [
        ...missing.slice(0, 5).map((row) => `missing id=${row.id}`),
        ...extra.slice(0, 5).map((row) => `extra id=${row.id}`),
      ],
    },
    {
      name: `${entity}.id→wikidot_id 逐行相等`,
      ok: mismatch.length === 0,
      actual: `mismatch=${mismatch.length}`,
      samples: mismatch
        .slice(0, 5)
        .map(
          (row) =>
            `id=${row.id} v1_wid=${String(row.wikidot_id)} v2_wid=${String(actualById.get(row.id))}`,
        ),
    },
  ];
}

function readinessAssertion(
  entity: 'page' | 'user',
  planned: readonly TargetIdentity[],
  actual: readonly TargetIdentity[],
): Assertion {
  const sourceById = new Map(planned.map((row) => [row.id, row.wikidot_id]));
  const sourceByWid = new Map(
    planned
      .filter((row) => row.wikidot_id !== null)
      .map((row) => [row.wikidot_id as number, row.id]),
  );
  const conflicts: string[] = [];

  for (const row of actual) {
    const sourceWid = sourceById.get(row.id);
    if (sourceWid === undefined) {
      conflicts.push(`extra v2 ${entity}.id=${row.id}`);
      continue;
    }
    if (sourceWid !== row.wikidot_id) {
      conflicts.push(
        `id=${row.id} v1_wid=${String(sourceWid)} v2_wid=${String(row.wikidot_id)}`,
      );
    }
    if (row.wikidot_id !== null) {
      const sourceId = sourceByWid.get(row.wikidot_id);
      if (sourceId !== undefined && sourceId !== row.id) {
        conflicts.push(`wid=${row.wikidot_id} v1_id=${sourceId} v2_id=${row.id}`);
      }
    }
  }

  return {
    name: `${entity} 目标身份可无损并入`,
    ok: conflicts.length === 0,
    actual: `conflicts_or_extras=${conflicts.length}`,
    samples: conflicts.slice(0, 10),
  };
}

function sourceCandidateAssertions(
  source: LoadedSource,
  pages: readonly PagePlan[],
  users: readonly UserPlan[],
): Assertion[] {
  const pageMismatch = source.pages.filter((row, i) => {
    const plan = pages[i];
    return !plan || plan.id !== row.id || plan.wikidotId !== row.wikidot_id;
  });
  const userMismatch = source.users.filter((row, i) => {
    const plan = users[i];
    return !plan || plan.id !== row.id || plan.wikidotId !== row.wikidot_id;
  });
  const ambiguousKinds = source.users.filter(
    (row) =>
      row.wikidot_id === null &&
      row.is_guest === true &&
      row.is_collection_synthetic,
  );
  const syntheticPrecedenceMismatch = source.users.filter(
    (row, i) =>
      row.is_collection_synthetic &&
      users[i]?.kind !== 'synthetic',
  );
  return [
    {
      name: 'Page.id 与 wikidot_id 候选逐行对应',
      ok: pageMismatch.length === 0 && pages.length === source.pages.length,
      actual: `source=${source.pages.length}, planned=${pages.length}, mismatch=${pageMismatch.length}`,
    },
    {
      name: 'User.id 与 wikidot_id 候选逐行对应',
      ok: userMismatch.length === 0 && users.length === source.users.length,
      actual: `source=${source.users.length}, planned=${users.length}, mismatch=${userMismatch.length}`,
    },
    {
      name: 'CollectionAccountOwner synthetic 血统优先于历史 isGuest 标志',
      ok: syntheticPrecedenceMismatch.length === 0,
      actual:
        `synthetic=${source.users.filter((row) => row.is_collection_synthetic).length}, ` +
        `legacy_is_guest_overlap=${ambiguousKinds.length}, ` +
        `precedence_mismatch=${syntheticPrecedenceMismatch.length}`,
      samples: syntheticPrecedenceMismatch
        .slice(0, 10)
        .map((row) => `id=${row.id} display=${row.display_name ?? '(null)'}`),
    },
    {
      name: '投票域匿名票数 = 0',
      ok: source.anonymousVotes === 0,
      actual: String(source.anonymousVotes),
    },
  ];
}

function slugKey(row: {
  page_id: number;
  slug: string;
  valid_from: string | Date;
  valid_to: string | Date | null;
}): string {
  const from = row.valid_from instanceof Date ? row.valid_from.toISOString() : row.valid_from;
  const to =
    row.valid_to instanceof Date ? row.valid_to.toISOString() : row.valid_to;
  return `${row.page_id}\u0000${row.slug}\u0000${from}\u0000${to ?? ''}`;
}

function plannedSlugs(pages: readonly PagePlan[]): Array<{
  page_id: number;
  slug: string;
  valid_from: string;
  valid_to: string | null;
}> {
  return pages.flatMap((page) =>
    page.slugs.map((slug) => ({
      page_id: page.id,
      slug: slug.slug,
      valid_from: slug.valid_from,
      valid_to: slug.valid_to,
    })),
  );
}

function slugEqualityAssertion(
  planned: ReturnType<typeof plannedSlugs>,
  actual: readonly TargetSlug[],
): Assertion {
  const expected = new Set(planned.map(slugKey));
  const observed = new Set(actual.map(slugKey));
  const missing = planned.filter((row) => !observed.has(slugKey(row)));
  const extra = actual.filter((row) => !expected.has(slugKey(row)));
  return {
    name: 'page_slug_history SCD2 行逐行相等',
    ok: missing.length === 0 && extra.length === 0,
    actual: `missing=${missing.length}, extra=${extra.length}`,
    samples: [
      ...missing.slice(0, 5).map((row) => `missing page=${row.page_id} slug=${row.slug}`),
      ...extra.slice(0, 5).map((row) => `extra page=${row.page_id} slug=${row.slug}`),
    ],
  };
}

function slugCompatibilityAssertion(
  planned: ReturnType<typeof plannedSlugs>,
  actual: readonly TargetSlug[],
): Assertion {
  const expected = new Set(planned.map(slugKey));
  const incompatible = actual.filter((row) => !expected.has(slugKey(row)));
  return {
    name: '既有 page_slug_history 与 S1 候选兼容',
    ok: incompatible.length === 0,
    actual: `incompatible=${incompatible.length}`,
    samples: incompatible
      .slice(0, 10)
      .map((row) => `page=${row.page_id} slug=${row.slug} from=${row.valid_from.toISOString()}`),
  };
}

function makeReport(
  opts: CliOptions,
  sourceDb: string,
  targetDb: string,
  source: LoadedSource,
  pages: readonly PagePlan[],
  users: readonly UserPlan[],
  target: TargetState,
): DryRunReport {
  const sourcePageIdentity = pages.map((row) => ({ id: row.id, wikidot_id: row.wikidotId }));
  const sourceUserIdentity = users.map((row) => ({ id: row.id, wikidot_id: row.wikidotId }));
  const candidateAssertions = sourceCandidateAssertions(source, pages, users);
  const targetAssertions = [
    ...identityAssertions('Page', sourcePageIdentity, target.pages),
    ...identityAssertions('User', sourceUserIdentity, target.users),
    slugEqualityAssertion(plannedSlugs(pages), target.slugs),
  ];
  const readiness = [
    {
      name: '0200 S1 migration 已应用',
      ok: target.migrationReady,
      actual: target.migrationReady ? 'ready' : `missing ingest.user.${REQUIRED_MIGRATION_COLUMN}`,
    },
    readinessAssertion('page', sourcePageIdentity, target.pages),
    readinessAssertion('user', sourceUserIdentity, target.users),
    slugCompatibilityAssertion(plannedSlugs(pages), target.slugs),
  ];

  const kinds: Record<BackfillUserKind, number> = {
    wikidot: 0,
    guest: 0,
    anon: 0,
    synthetic: 0,
  };
  for (const user of users) kinds[user.kind] += 1;

  let normalizedSchemeDuplicatesRemoved = 0;
  for (let i = 0; i < source.pages.length; i++) {
    const row = source.pages[i]!;
    const rawCount = new Set([row.url, ...(row.url_history ?? []), row.current_url]).size;
    normalizedSchemeDuplicatesRemoved += rawCount - pages[i]!.slugs.length;
  }

  return {
    mode: opts.execute ? 'execute' : 'dry-run',
    sourceDatabase: sourceDb,
    targetDatabase: targetDb,
    expected: {
      pages: pages.length,
      pageSlugHistory: pages.reduce((sum, row) => sum + row.slugs.length, 0),
      users: users.length,
      userKinds: kinds,
      pageIdMin: pages[0]?.id ?? null,
      pageIdMax: pages.at(-1)?.id ?? null,
      userIdMin: users[0]?.id ?? null,
      userIdMax: users.at(-1)?.id ?? null,
      currentUrlHttpsPrefix: source.pages.filter((row) => /^https:\/\//i.test(row.current_url)).length,
      anyUrlHttpsPrefix: source.pages.filter((row) =>
        [row.url, ...(row.url_history ?? []), row.current_url].some((url) => /^https:\/\//i.test(url)),
      ).length,
      normalizedSchemeDuplicatesRemoved,
      usernamesNonNull: users.filter((row) => row.username !== null).length,
      usernamesMatchingLegacyFormula: source.usernamesMatchingLegacyFormula,
      ambiguousUserKindEvidence: source.users.filter(
        (row) =>
          row.wikidot_id === null &&
          row.is_guest === true &&
          row.is_collection_synthetic,
      ).length,
      anonymousVotes: source.anonymousVotes,
    },
    targetBefore: {
      pages: target.pages.length,
      users: target.users.length,
      pageSlugHistory: target.slugs.length,
      migrationReady: target.migrationReady,
    },
    candidateAssertions,
    targetAssertions,
    readiness,
    canExecute:
      candidateAssertions.every((item) => item.ok) &&
      readiness.every((item) => item.ok),
  };
}

function printReport(report: DryRunReport, jsonOnly: boolean): void {
  if (!jsonOnly) {
    process.stdout.write(
      [
        `S1 ${report.mode}: ${report.sourceDatabase} → ${report.targetDatabase}`,
        `expected page=${report.expected.pages}, slug_history=${report.expected.pageSlugHistory}, user=${report.expected.users}`,
        `target   page=${report.targetBefore.pages}, slug_history=${report.targetBefore.pageSlugHistory}, user=${report.targetBefore.users}`,
        `canExecute=${report.canExecute}`,
        '',
      ].join('\n'),
    );
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

async function ensureProgress(
  client: PoolClient,
  shard: 'page' | 'user',
  total: number,
): Promise<void> {
  await client.query(
    `INSERT INTO meta.backfill_progress(domain, shard, last_page_id, done_count, total_count)
     VALUES ($1, $2, 0, 0, $3)
     ON CONFLICT (domain, shard) DO UPDATE
       SET total_count = EXCLUDED.total_count,
           updated_at = now()`,
    [PROGRESS_DOMAIN, shard, total],
  );
}

async function progressLastId(
  client: PoolClient,
  shard: 'page' | 'user',
): Promise<number> {
  const result = await client.query<{ last_page_id: number }>(
    `SELECT last_page_id
       FROM meta.backfill_progress
      WHERE domain=$1 AND shard=$2
      FOR UPDATE`,
    [PROGRESS_DOMAIN, shard],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`缺 backfill_progress ${PROGRESS_DOMAIN}/${shard}`);
  return row.last_page_id;
}

async function writePageBatch(
  client: PoolClient,
  batch: readonly PagePlan[],
  total: number,
): Promise<void> {
  await client.query('BEGIN');
  try {
    await client.query(`SET LOCAL scpper.bypass_guard = 'on'`);
    const last = await progressLastId(client, 'page');
    if ((batch[0]?.id ?? 0) <= last) {
      throw new Error(`page batch 起点 ${batch[0]?.id} 未越过 progress.last_page_id=${last}`);
    }
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
           FROM b
           CROSS JOIN LATERAL jsonb_to_recordset(b.slugs)
             AS s(slug text, valid_from timestamptz, valid_to timestamptz)
       )
       INSERT INTO ingest.page_slug_history(page_id, slug, valid_from, valid_to)
       SELECT page_id, slug, valid_from, valid_to FROM h
       ON CONFLICT (page_id, slug, valid_from) DO NOTHING`,
      [payload],
    );
    const maxId = batch.at(-1)!.id;
    await client.query(
      `UPDATE meta.backfill_progress
          SET last_page_id=$3,
              done_count=(SELECT count(*) FROM ingest.page p
                           WHERE EXISTS (SELECT 1 FROM jsonb_to_recordset($4::jsonb)
                             AS x(id int) WHERE x.id=p.id))
                         + done_count,
              total_count=$5,
              updated_at=now()
        WHERE domain=$1 AND shard=$2`,
      [PROGRESS_DOMAIN, 'page', maxId, payload, total],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

async function writeUserBatch(
  client: PoolClient,
  batch: readonly UserPlan[],
  total: number,
): Promise<void> {
  await client.query('BEGIN');
  try {
    const last = await progressLastId(client, 'user');
    if ((batch[0]?.id ?? 0) <= last) {
      throw new Error(`user batch 起点 ${batch[0]?.id} 未越过 progress.last_page_id=${last}`);
    }
    const payload = JSON.stringify(batch);
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
      [payload],
    );
    const maxId = batch.at(-1)!.id;
    await client.query(
      `UPDATE meta.backfill_progress
          SET last_page_id=$3,
              done_count=(SELECT count(*) FROM ingest."user" u
                           WHERE EXISTS (SELECT 1 FROM jsonb_to_recordset($4::jsonb)
                             AS x(id int) WHERE x.id=u.id))
                         + done_count,
              total_count=$5,
              updated_at=now()
        WHERE domain=$1 AND shard=$2`,
      [PROGRESS_DOMAIN, 'user', maxId, payload, total],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

async function executeBatches(
  pool: Pool,
  pages: readonly PagePlan[],
  users: readonly UserPlan[],
  batchSize: number,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(`SELECT pg_advisory_lock(hashtext('backfill:s1_identity'))`);
    await client.query('BEGIN');
    await ensureProgress(client, 'page', pages.length);
    await ensureProgress(client, 'user', users.length);
    await client.query('COMMIT');

    const pageLast = await client.query<{ last_page_id: number }>(
      `SELECT last_page_id FROM meta.backfill_progress WHERE domain=$1 AND shard='page'`,
      [PROGRESS_DOMAIN],
    );
    const userLast = await client.query<{ last_page_id: number }>(
      `SELECT last_page_id FROM meta.backfill_progress WHERE domain=$1 AND shard='user'`,
      [PROGRESS_DOMAIN],
    );
    const remainingPages = pages.filter((row) => row.id > (pageLast.rows[0]?.last_page_id ?? 0));
    const remainingUsers = users.filter((row) => row.id > (userLast.rows[0]?.last_page_id ?? 0));

    for (let i = 0; i < remainingPages.length; i += batchSize) {
      await writePageBatch(client, remainingPages.slice(i, i + batchSize), pages.length);
    }
    for (let i = 0; i < remainingUsers.length; i += batchSize) {
      await writeUserBatch(client, remainingUsers.slice(i, i + batchSize), users.length);
    }
  } finally {
    await client.query(`SELECT pg_advisory_unlock(hashtext('backfill:s1_identity'))`).catch(() => undefined);
    client.release();
  }
}

async function freezeIdentityWrites(pool: Pool): Promise<void> {
  const status = await pool.query<{
    domain: string;
    frozen: boolean;
    reason: string | null;
    effective: boolean;
  }>(
    `SELECT domain, frozen, reason, effective
       FROM meta.write_freeze_status()
      WHERE domain IN ('all','identity')
      ORDER BY domain`,
  );
  const all = status.rows.find((row) => row.domain === 'all');
  const identity = status.rows.find((row) => row.domain === 'identity');
  if (all?.effective) {
    throw new Error(`总写闸已冻结（${all.reason ?? '无原因'}），S1 不得绕过事故现场`);
  }
  if (identity?.frozen && !identity.reason?.startsWith('v1→v2 S1 backfill')) {
    throw new Error(`identity 写闸已因其它原因冻结：${identity.reason ?? '无原因'}`);
  }
  if (!identity?.frozen) {
    await pool.query(
      `SELECT meta.freeze_writes(
         'identity',
         'v1→v2 S1 backfill：阻止 register_page/ensure_user 与批量身份 COPY 并发',
         'syncer2-backfill-s1'
       )`,
    );
  }

  // freeze 会挡住未来函数入口；这把短表锁负责等待 freeze 前已经进入的写事务全部退场。
  const client = await pool.connect();
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

async function releaseIdentityWrites(pool: Pool): Promise<void> {
  await pool.query(
    `SELECT meta.release_writes('identity', 'syncer2-backfill-s1')`,
  );
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
    applicationName: 'syncer2-backfill-s1-source-ro',
  });
  const targetPool = createBackfillPool(opts.targetDatabaseUrl, {
    // dry-run 的目标也由数据库强制只读；不是仅靠代码分支自觉。
    readOnly: !opts.execute,
    applicationName: opts.execute
      ? 'syncer2-backfill-s1-target'
      : 'syncer2-backfill-s1-target-ro',
  });
  const sourceClient = await sourcePool.connect();

  try {
    const source = await loadSourceSnapshot(sourceClient);
    const pages = source.pages.map(buildPagePlan);
    const users = source.users.map(buildUserPlan);
    const target = await loadTargetState(targetPool);
    const report = makeReport(opts, sourceDb, targetDb, source, pages, users, target);
    printReport(report, opts.json);

    if (!opts.execute) {
      await sourceClient.query('ROLLBACK');
      return;
    }
    if (!report.canExecute) {
      throw new Error('S1 执行前硬闸未通过；未写目标库。先处理 readiness 中的冲突');
    }

    await freezeIdentityWrites(targetPool);
    // 冻结后重读一次，闭合 dry-run/preflight 与第一批提交之间的竞态窗口。
    const frozenTarget = await loadTargetState(targetPool);
    const frozenReport = makeReport(opts, sourceDb, targetDb, source, pages, users, frozenTarget);
    if (!frozenReport.canExecute) {
      throw new Error(
        `identity 冻结后的二次硬闸失败；写闸保持冻结供人工检查：${JSON.stringify(frozenReport.readiness)}`,
      );
    }

    await executeBatches(targetPool, pages, users, opts.batchSize);
    const after = await loadTargetState(targetPool);
    const finalAssertions = [
      ...identityAssertions(
        'Page',
        pages.map((row) => ({ id: row.id, wikidot_id: row.wikidotId })),
        after.pages,
      ),
      ...identityAssertions(
        'User',
        users.map((row) => ({ id: row.id, wikidot_id: row.wikidotId })),
        after.users,
      ),
      slugEqualityAssertion(plannedSlugs(pages), after.slugs),
    ];
    if (finalAssertions.some((item) => !item.ok)) {
      throw new Error(`S1 写后身份断言失败：${JSON.stringify(finalAssertions)}`);
    }
    process.stdout.write(
      `${JSON.stringify({
        completed: true,
        pages: after.pages.length,
        users: after.users.length,
        pageSlugHistory: after.slugs.length,
        assertions: finalAssertions,
      })}\n`,
    );
    await releaseIdentityWrites(targetPool);
    await sourceClient.query('COMMIT');
  } catch (error) {
    await sourceClient.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    sourceClient.release();
    await Promise.all([sourcePool.end(), targetPool.end()]);
  }
}

run().catch((error) => {
  process.stderr.write(`[backfill-s1] ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
