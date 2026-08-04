/**
 * v1 → v2 回填 S4（署名）+ S5（生命周期/legacy 血统）+ S6（冻结/序列）。
 *
 * 默认只读 dry-run；--execute 才写 scpper-v2。v1 连接从 startup packet 开始就是
 * default_transaction_read_only=on，并在一个 REPEATABLE READ READ ONLY 快照内完成。
 * 本文件不写 vote_event / vote_current。
 */

import { createHash } from 'node:crypto';

import { Command } from 'commander';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';

import { applyMappedAttributionSnapshots } from '../collect/conventions.js';
import { loadEnv } from '../config.js';
import { normalizeV1Url } from './s1-model.js';
import {
  anonymousActorSafety,
  V2_RESERVED_ANONYMOUS_ACTOR_ID_START,
  V1_USER_ID_SAFETY_FACTOR,
} from './id-policy.js';
import {
  buildAttributionCarryoverPlan,
  buildPageLifePlan,
  buildVersionMap,
  type AttributionCarryoverPlan,
  type ExistingAnonActor,
  type MappedAttributionPlan,
  type PageLifePlan,
  type V1AttributionRow,
  type V1PageLifeRow,
  type V1VersionRow,
  type VersionMapPlan,
} from './s456-model.js';

const PROTECTED_TARGETS = new Set(['scpper-cn', 'scpper_cn', 'scpper-syncer', 'scpper_user']);
const PROGRESS_DOMAIN = 's456_attribution_life';
const ATTR_SOURCE = 'v1_attribution_carryover';

interface CliOptions {
  execute: boolean;
  batchSize: number;
  snapshotBatchSize: number;
  v1DatabaseUrl: string;
  targetDatabaseUrl: string;
  json: boolean;
}

interface TargetState {
  migrationReady: boolean;
  pages: number;
  users: number;
  userAllocationHighWater: number;
  pageCurrent: number;
  attributionEvents: number;
  attributionCurrent: number;
  lifeEvents: number;
  versionMap: number;
  anonymousActors: ExistingAnonActor[];
  missingAttributionUsers: number;
  frozenArtifacts: Record<string, { row_count: string; fingerprint: string }>;
  snapshotManifest: Record<string, { row_count: string; source_fingerprint: string }>;
  frozenDomains: string[];
  sequences: Array<{
    sequence: string;
    data_type: string;
    last_value: string | null;
    table_max: string;
  }>;
}

interface LegacySnapshotStat {
  table: 'pages' | 'votes' | 'vote_history';
  rows: number;
  fingerprint: string;
}

interface SourceSnapshot {
  observedAt: string;
  maxV1UserId: number;
  attributions: V1AttributionRow[];
  pages: PageLifePlan[];
  versions: VersionMapPlan[];
  legacy: LegacySnapshotStat[];
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
  source: {
    attributionsRaw: number;
    attributionsCurrent: number;
    attributionPages: number;
    anonymousRows: number;
    anonymousKeys: number;
    anonymousActorsToCreate: number;
    submitterRows: number;
    deletedPageAttributions: number;
    pages: number;
    deletedPages: number;
    legacyImportedDeletedPages: number;
    activityFallbackDeletedPages: number;
    divergentLifeRows: number;
    archivedLivePagesIncluded: number;
    versions: number;
    legacySnapshot: LegacySnapshotStat[];
  };
  targetBefore: Omit<TargetState, 'anonymousActors'>;
  assertions: Assertion[];
  canExecute: boolean;
}

type AttributionRow = QueryResultRow & V1AttributionRow;
type PageRow = QueryResultRow & Omit<V1PageLifeRow, 'current_slug'> & {
  current_url: string;
};
type VersionRow = QueryResultRow & V1VersionRow;

function intOption(value: string): number {
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
    .name('backfill-s456')
    .description('v1→v2 S4/S5/S6；默认只读 dry-run，--execute 才写目标库')
    .option('--execute', '正式写 v2', false)
    .option('--dry-run', '显式只读预演（默认）', false)
    .option('--batch-size <n>', '署名/生命周期/版本映射批大小', intOption, 500)
    .option('--snapshot-batch-size <n>', 'legacy typed snapshot 批大小', intOption, 5_000)
    .option('--v1-database-url <url>', 'v1 scpper-cn 连接串（始终强制只读）')
    .option('--target-database-url <url>', 'v2 scpper-v2 连接串')
    .option('--json', '只输出 JSON', false);
  program.parse(process.argv);
  const raw = program.opts<{
    execute: boolean;
    dryRun: boolean;
    batchSize: number;
    snapshotBatchSize: number;
    v1DatabaseUrl?: string;
    targetDatabaseUrl?: string;
    json: boolean;
  }>();
  if (raw.execute && raw.dryRun) throw new Error('--execute 与 --dry-run 不能同时给');
  return {
    execute: raw.execute,
    batchSize: raw.batchSize,
    snapshotBatchSize: raw.snapshotBatchSize,
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

function asNumber(value: string | number | null | undefined): number {
  return Number(value ?? 0);
}

async function loadTargetState(pool: Pool): Promise<TargetState> {
  const ready = await pool.query<{ ok: boolean }>(
    `SELECT to_regclass('meta.v1_legacy_snapshot') IS NOT NULL
         AND to_regclass('meta.v1_attribution_map') IS NOT NULL
         AND to_regclass('meta.v1_page_life_divergence_audit') IS NOT NULL
         AND to_regclass('meta.v1_backfill_artifact_freeze') IS NOT NULL
         AND to_regclass('meta.v1_anonymous_actor_remap_audit') IS NOT NULL
         AND to_regprocedure('meta.v2_reserved_anonymous_actor_id_start()') IS NOT NULL
         AS ok`,
  );
  const counts = await pool.query<Record<string, string>>(
    `SELECT
       (SELECT count(*) FROM ingest.page)::text AS pages,
       (SELECT count(*) FROM ingest."user")::text AS users,
       (SELECT GREATEST(
          COALESCE(max(id),0),
          (SELECT CASE WHEN is_called THEN last_value ELSE last_value-1 END
             FROM ingest.user_id_seq)
        ) FROM ingest."user")::text AS user_allocation_high_water,
       (SELECT count(*) FROM serve.page_current)::text AS page_current,
       (SELECT count(*) FROM ingest.attribution_event)::text AS attribution_events,
       (SELECT count(*) FROM serve.attribution_current)::text AS attribution_current,
       (SELECT count(*) FROM ingest.page_life_event)::text AS life_events,
       (SELECT count(*) FROM meta.v1_version_map)::text AS version_map`,
  );
  const anonymousActors = await pool.query<ExistingAnonActor & QueryResultRow>(
    `SELECT id, anon_key
       FROM ingest."user"
      WHERE anon_key LIKE 'anon:%'
      ORDER BY anon_key`,
  );
  const missingUsers = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n
       FROM meta.v1_identity i
      WHERE i.entity='user'
        AND NOT EXISTS (SELECT 1 FROM ingest."user" u WHERE u.id=i.v1_id)`,
  );
  const frozenArtifacts = ready.rows[0]?.ok
    ? await pool.query<{ artifact: string; row_count: string; fingerprint: string }>(
        `SELECT artifact, row_count::text, fingerprint
           FROM meta.v1_backfill_artifact_freeze ORDER BY artifact`,
      )
    : { rows: [] as Array<{ artifact: string; row_count: string; fingerprint: string }> };
  const snapshotManifest = ready.rows[0]?.ok
    ? await pool.query<{
        source_table: string;
        row_count: string;
        source_fingerprint: string;
      }>(
        `SELECT source_table, row_count::text, source_fingerprint
           FROM meta.v1_legacy_snapshot ORDER BY source_table`,
      )
    : {
        rows: [] as Array<{
          source_table: string;
          row_count: string;
          source_fingerprint: string;
        }>,
      };
  const frozenDomains = await pool.query<{ domain: string }>(
    `SELECT domain FROM meta.write_freeze_status()
      WHERE effective AND domain IN ('all','identity','attribution','page')
      ORDER BY domain`,
  );
  const sequences = await pool.query<{
    sequence: string;
    data_type: string;
    last_value: string | null;
    table_max: string;
  }>(
    `WITH identity_tables AS (
       SELECT 'ingest.page_id_seq'::text seq, 'ingest.page'::regclass tbl, 'id'::name col
       UNION ALL
       SELECT 'ingest.user_id_seq', 'ingest."user"'::regclass, 'id'::name
       UNION ALL
       SELECT pg_get_serial_sequence(format('app.%I', c.relname), a.attname),
              c.oid::regclass, a.attname
         FROM pg_class c
         JOIN pg_namespace n ON n.oid=c.relnamespace
         JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
        WHERE n.nspname='app' AND c.relkind='r' AND a.attidentity <> ''
     )
     SELECT i.seq AS sequence, s.data_type::text,
            s.last_value::text,
            (xpath('/row/max/text()', query_to_xml(
              format('SELECT COALESCE(max(%I),0) AS max FROM %s', i.col, i.tbl),
              false, true, '')))[1]::text AS table_max
       FROM identity_tables i
       JOIN pg_sequences s
         ON s.schemaname=split_part(i.seq,'.',1)
        AND s.sequencename=split_part(i.seq,'.',2)
      ORDER BY i.seq`,
  );
  const c = counts.rows[0]!;
  return {
    migrationReady: ready.rows[0]?.ok === true,
    pages: asNumber(c.pages),
    users: asNumber(c.users),
    userAllocationHighWater: asNumber(c.user_allocation_high_water),
    pageCurrent: asNumber(c.page_current),
    attributionEvents: asNumber(c.attribution_events),
    attributionCurrent: asNumber(c.attribution_current),
    lifeEvents: asNumber(c.life_events),
    versionMap: asNumber(c.version_map),
    anonymousActors: anonymousActors.rows,
    missingAttributionUsers: asNumber(missingUsers.rows[0]?.n),
    frozenArtifacts: Object.fromEntries(
      frozenArtifacts.rows.map((row) => [
        row.artifact,
        { row_count: row.row_count, fingerprint: row.fingerprint },
      ]),
    ),
    snapshotManifest: Object.fromEntries(
      snapshotManifest.rows.map((row) => [
        row.source_table,
        { row_count: row.row_count, source_fingerprint: row.source_fingerprint },
      ]),
    ),
    frozenDomains: frozenDomains.rows.map((row) => row.domain),
    sequences: sequences.rows,
  };
}

async function beginSourceSnapshot(client: PoolClient): Promise<string> {
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await client.query(`SET LOCAL TIME ZONE 'UTC'`);
  const row = await client.query<{ observed_at: string }>(
    `SELECT to_char(transaction_timestamp(), 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS observed_at`,
  );
  return row.rows[0]!.observed_at;
}

async function legacyFingerprint(
  client: PoolClient,
  table: LegacySnapshotStat['table'],
): Promise<LegacySnapshotStat> {
  const columns = table === 'pages'
    ? `"__Id", "WikidotId", "SiteId", "Name", "Title"`
    : `"__Id", "PageId", "UserId", "Value", "DateTime", "DeltaFromPrev"`;
  // table 来自封闭联合类型，不接收 CLI/环境输入。
  const result = await client.query<{ n: string; fingerprint: string }>(
    `SELECT count(*)::text AS n,
            md5(COALESCE(string_agg(md5(row_to_json(x)::text), '' ORDER BY x."__Id"), ''))
              AS fingerprint
       FROM (SELECT ${columns} FROM legacy_votes_cn.${table}) x`,
  );
  return {
    table,
    rows: asNumber(result.rows[0]?.n),
    fingerprint: result.rows[0]?.fingerprint ?? '',
  };
}

async function loadSourceSnapshot(
  client: PoolClient,
  observedAt: string,
): Promise<Omit<SourceSnapshot, 'observedAt'>> {
  // 同一个 REPEATABLE READ client 上严格串行；node-pg 9 将拒绝并发 client.query。
  const attributions = await client.query<AttributionRow>(
      `SELECT a.id,
              a."pageVerId" AS page_version_id,
              pv."pageId" AS page_id,
              p."wikidotId" AS page_wikidot_id,
              a."userId" AS user_id,
              a."anonKey" AS anon_key,
              a.type AS role,
              a."order" AS ord,
              CASE WHEN a.date IS NULL THEN NULL
                   ELSE to_char(a.date, 'YYYY-MM-DD') END AS at_date
         FROM public."Attribution" a
         JOIN public."PageVersion" pv ON pv.id=a."pageVerId"
         JOIN public."Page" p ON p.id=pv."pageId"
        ORDER BY a.id`,
    );
  const pages = await client.query<PageRow>(
      `WITH current_pv AS (
         SELECT DISTINCT ON (pv."pageId")
                pv.id, pv."pageId", pv."isDeleted", pv."validFrom",
                pv.title, pv."alternateTitle", pv.tags, pv.category, pv.search_text
           FROM public."PageVersion" pv
          WHERE pv."validTo" IS NULL
          ORDER BY pv."pageId", pv."validFrom" DESC, pv.id DESC
       ), activity AS (
         SELECT pv."pageId",
                max(v.timestamp) AS last_vote_at
           FROM public."Vote" v
           JOIN public."PageVersion" pv ON pv.id=v."pageVersionId"
          GROUP BY pv."pageId"
       ), revision_activity AS (
         SELECT pv."pageId",
                max(r.timestamp) AS last_revision_at
           FROM public."Revision" r
           JOIN public."PageVersion" pv ON pv.id=r."pageVersionId"
          GROUP BY pv."pageId"
       )
       SELECT p.id AS page_id,
              p."wikidotId" AS wikidot_id,
              p."currentUrl" AS current_url,
              p."isDeleted" AS page_is_deleted,
              cp."isDeleted" AS current_version_is_deleted,
              CASE WHEN p."firstPublishedAt" IS NULL THEN NULL
                   ELSE to_char(p."firstPublishedAt", 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END
                AS first_published_at,
              to_char(p."createdAt", 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS page_created_at,
              CASE WHEN cp."validFrom" IS NULL THEN NULL
                   ELSE to_char(cp."validFrom", 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END
                AS tombstone_at,
              CASE WHEN a.last_vote_at IS NULL THEN NULL
                   ELSE to_char(a.last_vote_at, 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END
                AS last_vote_at,
              CASE WHEN ra.last_revision_at IS NULL THEN NULL
                   ELSE to_char(ra.last_revision_at, 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END
                AS last_revision_at,
              (p.url LIKE 'https://%'
                AND EXISTS (SELECT 1 FROM legacy_votes_cn.pages lp
                             WHERE lp."WikidotId"=p."wikidotId")) AS legacy_fingerprint,
              cp.id AS current_version_id,
              cp.title,
              cp."alternateTitle" AS alternate_title,
              cp.tags,
              cp.category,
              cp.search_text
         FROM public."Page" p
         JOIN current_pv cp ON cp."pageId"=p.id
         LEFT JOIN activity a ON a."pageId"=p.id
         LEFT JOIN revision_activity ra ON ra."pageId"=p.id
        ORDER BY p.id`,
    );
  const versions = await client.query<VersionRow>(
      `SELECT pv.id,
              pv."pageId" AS page_id,
              to_char(pv."validFrom", 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS valid_from,
              CASE WHEN pv."validTo" IS NULL THEN NULL
                   ELSE to_char(pv."validTo", 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END AS valid_to,
              pv."isDeleted" AS is_deleted,
              pv.title,
              pv."alternateTitle" AS alternate_title,
              pv.tags,
              pv.category
         FROM public."PageVersion" pv
        ORDER BY pv."pageId", pv."validFrom", pv.id`,
    );
  const userWatermark = await client.query<{ max_v1_user_id: number }>(
    `SELECT COALESCE(max(id),0)::int AS max_v1_user_id FROM public."User"`,
  );
  const legacy = [
    await legacyFingerprint(client, 'pages'),
    await legacyFingerprint(client, 'votes'),
    await legacyFingerprint(client, 'vote_history'),
  ];

  const pagePlans = pages.rows.map((row) =>
    buildPageLifePlan({
      ...row,
      current_slug: normalizeV1Url(row.current_url),
    }),
  );
  // B5：没有任何 deleted:/old: 过滤；这里还反向证明源 Page 与计划行数一模一样。
  if (pagePlans.length !== pages.rowCount) throw new Error('B5 全量 Page 计划行数不一致');
  return {
    maxV1UserId: userWatermark.rows[0]!.max_v1_user_id,
    attributions: attributions.rows,
    pages: pagePlans,
    versions: buildVersionMap(versions.rows),
    legacy,
  };
}

function artifactFingerprint(rows: readonly unknown[]): string {
  const hash = createHash('sha256');
  for (const row of rows) hash.update(`${JSON.stringify(row)}\n`);
  return hash.digest('hex');
}

function buildReport(
  opts: CliOptions,
  sourceDb: string,
  targetDb: string,
  source: SourceSnapshot,
  target: TargetState,
  attribution: AttributionCarryoverPlan,
): DryRunReport {
  const attributionFingerprint = artifactFingerprint(attribution.mappedRows);
  const versionFingerprint = artifactFingerprint(source.versions);
  const attrFrozen = target.frozenArtifacts.v1_attribution_map;
  const versionFrozen = target.frozenArtifacts.v1_version_map;
  const anonSafety = anonymousActorSafety(
    attribution.mappedRows
      .filter((row) => row.v1UserId === null)
      .map((row) => row.actorId),
    source.maxV1UserId,
  );
  const assertions: Assertion[] = [
    {
      name: '0203/0204 S4/S5/S6 与保留身份段支撑迁移已应用',
      ok: target.migrationReady,
      actual: String(target.migrationReady),
    },
    {
      name: 'v1 Page 与 v2 ingest.page 数量一致（B5 不过滤归档活页）',
      ok: source.pages.length === target.pages,
      actual: `v1=${source.pages.length}, v2=${target.pages}`,
    },
    {
      name: '署名引用的 v1 User.id 已全部由 S1 搬入',
      ok: target.missingAttributionUsers === 0,
      actual: `${target.missingAttributionUsers} missing`,
    },
    {
      name: '匿名署名全部保留原始 anon: key',
      ok: source.attributions
        .filter((row) => row.user_id === null)
        .every((row) => row.anon_key?.startsWith('anon:')),
      actual: `${source.attributions.filter((row) => row.user_id === null).length} rows`,
    },
    {
      name: '匿名 actor 位于保留段且严格高于 v1 User.max(id) × 安全系数',
      ok: anonSafety.ok,
      actual:
        `min=${anonSafety.minimumActorId ?? '-'}, reserve=` +
        `${V2_RESERVED_ANONYMOUS_ACTOR_ID_START}, v1_max=${source.maxV1UserId}, ` +
        `factor=${V1_USER_ID_SAFETY_FACTOR}, floor>${anonSafety.requiredExclusiveFloor}`,
    },
    {
      name: '目标写闸没有其它事故冻结',
      ok: target.frozenDomains.length === 0,
      actual: target.frozenDomains.join(',') || 'open',
    },
    {
      name: '已冻结署名映射不超前于活 v1（execute 将逐行验证后原子 top-up）',
      ok:
        attrFrozen === undefined ||
        asNumber(attrFrozen.row_count) <= attribution.mappedRows.length,
      actual: attrFrozen
        ? `frozen=${attrFrozen.row_count}/${attrFrozen.fingerprint.slice(0, 12)}, ` +
          `source=${attribution.mappedRows.length}/${attributionFingerprint.slice(0, 12)}`
        : 'not frozen',
    },
    {
      name: '已冻结版本映射不超前于活 v1（execute 将逐行验证后原子 top-up）',
      ok:
        versionFrozen === undefined ||
        asNumber(versionFrozen.row_count) <= source.versions.length,
      actual: versionFrozen
        ? `frozen=${versionFrozen.row_count}/${versionFrozen.fingerprint.slice(0, 12)}, ` +
          `source=${source.versions.length}/${versionFingerprint.slice(0, 12)}`
        : 'not frozen',
    },
    {
      name: 'legacy 三张快照 manifest 若存在则与源指纹一致',
      ok: source.legacy.every((row) => {
        const found = target.snapshotManifest[row.table];
        return found === undefined ||
          (asNumber(found.row_count) === row.rows &&
            found.source_fingerprint === row.fingerprint);
      }),
      actual: source.legacy
        .map((row) => `${row.table}:${row.rows}/${row.fingerprint.slice(0, 8)}`)
        .join(', '),
    },
  ];
  const archivedLivePagesIncluded = source.pages.filter(
    (row) =>
      !row.resolvedDeleted &&
      (row.current_slug.startsWith('deleted:') || row.current_slug.startsWith('old:')),
  ).length;
  const deletedPageIds = new Set(
    source.pages.filter((row) => row.resolvedDeleted).map((row) => row.page_id),
  );

  const { anonymousActors: _anonymousActors, ...targetWithoutActors } = target;
  return {
    mode: opts.execute ? 'execute' : 'dry-run',
    sourceDatabase: sourceDb,
    targetDatabase: targetDb,
    source: {
      attributionsRaw: source.attributions.length,
      attributionsCurrent: attribution.currentRows.length,
      attributionPages: new Set(attribution.currentRows.map((row) => row.pageId)).size,
      anonymousRows: source.attributions.filter((row) => row.user_id === null).length,
      anonymousKeys: new Set(
        source.attributions
          .filter((row) => row.user_id === null)
          .map((row) => row.anon_key),
      ).size,
      anonymousActorsToCreate: attribution.anonymousActors.length,
      submitterRows: source.attributions.filter((row) => row.role.toUpperCase() === 'SUBMITTER').length,
      deletedPageAttributions: source.attributions.filter((row) =>
        deletedPageIds.has(row.page_id)).length,
      pages: source.pages.length,
      deletedPages: source.pages.filter((row) => row.resolvedDeleted).length,
      legacyImportedDeletedPages: source.pages.filter(
        (row) => row.resolvedDeleted && row.legacy_fingerprint,
      ).length,
      activityFallbackDeletedPages: source.pages.filter(
        (row) => row.usedActivityFallback,
      ).length,
      divergentLifeRows: source.pages.filter((row) => row.divergent).length,
      archivedLivePagesIncluded,
      versions: source.versions.length,
      legacySnapshot: source.legacy,
    },
    targetBefore: targetWithoutActors,
    assertions,
    canExecute: assertions.every((item) => item.ok),
  };
}

function printReport(report: DryRunReport, jsonOnly: boolean): void {
  if (!jsonOnly) {
    process.stdout.write(
      [
        `S4/S5/S6 ${report.mode}: ${report.sourceDatabase} → ${report.targetDatabase}`,
        `S4 attribution raw=${report.source.attributionsRaw}, current=${report.source.attributionsCurrent}, ` +
          `anon=${report.source.anonymousRows}/${report.source.anonymousKeys} keys, ` +
          `new actors=${report.source.anonymousActorsToCreate}`,
        `S5 page=${report.source.pages}, deleted=${report.source.deletedPages}, ` +
          `legacy=${report.source.legacyImportedDeletedPages}, ` +
          `activity_fallback=${report.source.activityFallbackDeletedPages}, ` +
          `divergence=${report.source.divergentLifeRows}, ` +
          `B5 archived_live=${report.source.archivedLivePagesIncluded}`,
        `S6 versions=${report.source.versions}, canExecute=${report.canExecute}`,
        '',
      ].join('\n'),
    );
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

async function freezeWrites(pool: Pool): Promise<void> {
  // 匿名署名需要显式插入 ingest.user，所以身份域必须先冻结。
  // attribution/page 不能冻结：正式装载刻意走 apply_attribution_snapshot /
  // apply_page_life，而这两个函数的第一道门就是 assert_writes_allowed(domain)。
  // 页面级并发由 apply_* 自己的 advisory xact lock 收口；目标库在迁移窗口尚未承接线上写。
  await pool.query(
    `SELECT meta.freeze_writes(
       'identity', 'v1→v2 S4/S5/S6 backfill：固定匿名署名 actor 分配窗口',
       'syncer2-backfill-s456'
     )`,
  );
}

async function releaseWrites(pool: Pool): Promise<void> {
  await pool.query(
    `SELECT meta.release_writes('identity', 'syncer2-backfill-s456')`,
  );
}

interface SnapshotTableConfig {
  source: LegacySnapshotStat['table'];
  target: string;
  columns: string;
  recordColumns: string;
}

const SNAPSHOT_TABLES: SnapshotTableConfig[] = [
  {
    source: 'pages',
    target: 'meta.v1_legacy_snapshot_pages',
    columns: `"__Id", "WikidotId", "SiteId", "Name", "Title"`,
    recordColumns: `"__Id" bigint, "WikidotId" bigint, "SiteId" bigint, "Name" text, "Title" text`,
  },
  {
    source: 'votes',
    target: 'meta.v1_legacy_snapshot_votes',
    columns: `"__Id", "PageId", "UserId", "Value", "DateTime", "DeltaFromPrev"`,
    recordColumns:
      `"__Id" bigint, "PageId" bigint, "UserId" bigint, "Value" smallint, ` +
      `"DateTime" timestamptz, "DeltaFromPrev" smallint`,
  },
  {
    source: 'vote_history',
    target: 'meta.v1_legacy_snapshot_vote_history',
    columns: `"__Id", "PageId", "UserId", "Value", "DateTime", "DeltaFromPrev"`,
    recordColumns:
      `"__Id" bigint, "PageId" bigint, "UserId" bigint, "Value" smallint, ` +
      `"DateTime" timestamptz, "DeltaFromPrev" smallint`,
  },
];

async function copyLegacySnapshot(
  sourceClient: PoolClient,
  targetPool: Pool,
  stats: readonly LegacySnapshotStat[],
  batchSize: number,
  sourceDatabase: string,
): Promise<void> {
  for (const config of SNAPSHOT_TABLES) {
    const expected = stats.find((row) => row.table === config.source)!;
    const manifest = await targetPool.query<{
      row_count: string;
      source_fingerprint: string;
      target_fingerprint: string;
    }>(
      `SELECT row_count::text, source_fingerprint, target_fingerprint
         FROM meta.v1_legacy_snapshot WHERE source_table=$1`,
      [config.source],
    );
    if (manifest.rowCount === 1) {
      const row = manifest.rows[0]!;
      if (
        asNumber(row.row_count) !== expected.rows ||
        row.source_fingerprint !== expected.fingerprint ||
        row.target_fingerprint !== expected.fingerprint
      ) {
        throw new Error(`legacy snapshot ${config.source} 已冻结但与源快照不一致`);
      }
      continue;
    }

    const targetClient = await targetPool.connect();
    try {
      await targetClient.query('BEGIN');
      await targetClient.query(`SET LOCAL TIME ZONE 'UTC'`);
      let lastId = '-1';
      let copied = 0;
      while (true) {
        // config 全部来自上方封闭常量；SQL 中没有用户输入。
        const batch = await sourceClient.query(
          `SELECT ${config.columns}
             FROM legacy_votes_cn.${config.source}
            WHERE "__Id" > $1::bigint
            ORDER BY "__Id"
            LIMIT $2`,
          [lastId, batchSize],
        );
        if (batch.rowCount === 0) break;
        await targetClient.query(
          `WITH b AS (
             SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(${config.recordColumns})
           )
           INSERT INTO ${config.target}(${config.columns})
           SELECT ${config.columns} FROM b
           ON CONFLICT ("__Id") DO NOTHING`,
          [JSON.stringify(batch.rows)],
        );
        copied += batch.rowCount ?? 0;
        lastId = String(batch.rows.at(-1)?.__Id);
      }

      const targetCheck = await targetClient.query<{ n: string; fingerprint: string }>(
        `SELECT count(*)::text AS n,
                md5(COALESCE(string_agg(md5(row_to_json(x)::text), '' ORDER BY x."__Id"), ''))
                  AS fingerprint
           FROM (SELECT ${config.columns} FROM ${config.target}) x`,
      );
      const actual = targetCheck.rows[0]!;
      if (asNumber(actual.n) !== expected.rows || actual.fingerprint !== expected.fingerprint) {
        throw new Error(
          `legacy snapshot ${config.source} 对账失败：copied=${copied}, ` +
            `target=${actual.n}/${actual.fingerprint}, ` +
            `source=${expected.rows}/${expected.fingerprint}`,
        );
      }
      await targetClient.query(
        `INSERT INTO meta.v1_legacy_snapshot(
           source_table,row_count,source_fingerprint,target_fingerprint,source_database
         ) VALUES ($1,$2,$3,$3,$4)`,
        [config.source, expected.rows, expected.fingerprint, sourceDatabase],
      );
      await targetClient.query('COMMIT');
    } catch (error) {
      await targetClient.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      targetClient.release();
    }
  }
}

async function insertAnonymousActors(
  pool: Pool,
  plan: AttributionCarryoverPlan,
): Promise<void> {
  for (let i = 0; i < plan.anonymousActors.length; i += 500) {
    const payload = JSON.stringify(plan.anonymousActors.slice(i, i + 500));
    await pool.query(
      `WITH b AS (
         SELECT * FROM jsonb_to_recordset($1::jsonb)
           AS x(id int, "anonKey" text, "displayName" text)
       )
       INSERT INTO ingest."user"(
         id,kind,wikidot_id,anon_key,username,display_name,username_is_legacy
       )
       SELECT id,'anon',NULL,"anonKey",NULL,"displayName",false FROM b
       ON CONFLICT (anon_key) DO NOTHING`,
      [payload],
    );
  }
  const mismatches = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n
       FROM meta.v1_identity i
      WHERE i.entity='user'
        AND NOT EXISTS (SELECT 1 FROM ingest."user" u WHERE u.id=i.v1_id)`,
  );
  if (asNumber(mismatches.rows[0]?.n) !== 0) {
    throw new Error('匿名 actor 插入后破坏了 v1 User.id 一一对应');
  }
}

async function loadAttributionMap(
  pool: Pool,
  plan: AttributionCarryoverPlan,
  batchSize: number,
): Promise<string> {
  const fingerprint = artifactFingerprint(plan.mappedRows);
  const frozen = await pool.query<{ row_count: string; fingerprint: string }>(
    `SELECT row_count::text, fingerprint
       FROM meta.v1_backfill_artifact_freeze WHERE artifact='v1_attribution_map'`,
  );
  if (frozen.rowCount === 1) {
    const row = frozen.rows[0]!;
    if (asNumber(row.row_count) > plan.mappedRows.length) {
      throw new Error('v1_attribution_map 冻结行数超前于当前 v1 快照');
    }
    if (asNumber(row.row_count) === plan.mappedRows.length && row.fingerprint === fingerprint) {
      return fingerprint;
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // v1 是活库：freeze 保护的是“已核对前缀不可改”，不是禁止以后追加。
    // 删除旧 manifest、逐行核对/补齐、写新 fingerprint 必须同事务，外部看不到解冻窗口。
    await client.query(
      `DELETE FROM meta.v1_backfill_artifact_freeze
        WHERE artifact='v1_attribution_map'`,
    );
    for (let i = 0; i < plan.mappedRows.length; i += batchSize) {
      const batch = plan.mappedRows.slice(i, i + batchSize);
      const payload = JSON.stringify(batch);
      await client.query(
        `WITH b AS (
           SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(
             "v1AttributionId" int, "v1PageVersionId" int, "pageId" int,
             "v1UserId" int, "anonKey" text, "actorId" int, role text, ord int, "atDate" date
           )
         )
         INSERT INTO meta.v1_attribution_map(
           v1_attribution_id,v1_page_version_id,page_id,v1_user_id,anon_key,
           actor_id,role,ord,at_date
         )
         SELECT "v1AttributionId","v1PageVersionId","pageId","v1UserId","anonKey",
                "actorId",role,ord,"atDate"
           FROM b
         ON CONFLICT (v1_attribution_id) DO NOTHING`,
        [payload],
      );
      const mismatch = await client.query<{ n: string }>(
        `WITH b AS (
           SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(
             "v1AttributionId" int, "v1PageVersionId" int, "pageId" int,
             "v1UserId" int, "anonKey" text, "actorId" int, role text, ord int, "atDate" date
           )
         )
         SELECT count(*)::text AS n
           FROM b
           LEFT JOIN meta.v1_attribution_map m
             ON m.v1_attribution_id=b."v1AttributionId"
          WHERE m.v1_attribution_id IS NULL
             OR (m.v1_page_version_id,m.page_id,m.v1_user_id,m.anon_key,m.actor_id,
                 m.role,m.ord,m.at_date)
                IS DISTINCT FROM
                (b."v1PageVersionId",b."pageId",b."v1UserId",b."anonKey",b."actorId",
                 b.role,b.ord,b."atDate")`,
        [payload],
      );
      if (asNumber(mismatch.rows[0]?.n) !== 0) {
        throw new Error(`v1_attribution_map batch ${i} 有历史冲突`);
      }
    }
    const count = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM meta.v1_attribution_map`,
    );
    if (asNumber(count.rows[0]?.n) !== plan.mappedRows.length) {
      throw new Error(
        `v1_attribution_map 行数 ${count.rows[0]?.n} != source ${plan.mappedRows.length}`,
      );
    }
    await client.query(
      `INSERT INTO meta.v1_backfill_artifact_freeze(artifact,row_count,fingerprint)
       VALUES ('v1_attribution_map',$1,$2)`,
      [plan.mappedRows.length, fingerprint],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  return fingerprint;
}

async function ensurePageCurrent(
  pool: Pool,
  pages: readonly PageLifePlan[],
  batchSize: number,
): Promise<void> {
  for (let i = 0; i < pages.length; i += batchSize) {
    const payload = JSON.stringify(pages.slice(i, i + batchSize));
    await pool.query(
      `WITH b AS (
         SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(
           page_id int, wikidot_id int, current_slug text, title text,
           alternate_title text, tags text[], category text, search_text text,
           first_published_at timestamptz
         )
       )
       INSERT INTO serve.page_current(
         page_id,wikidot_id,slug,status,title,alternate_title,tags,category,
         search_text,first_published_at
       )
       SELECT page_id,wikidot_id,current_slug,'live',title,alternate_title,
              COALESCE(tags,'{}'),category,search_text,first_published_at
         FROM b
       ON CONFLICT (page_id) DO NOTHING`,
      [payload],
    );
    await pool.query(
      `WITH b AS (
         SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(
           page_id int, wikidot_id int, current_slug text, title text,
           alternate_title text, tags text[], category text, search_text text,
           first_published_at timestamptz
         )
       )
       UPDATE serve.page_current pc
          SET title=COALESCE(pc.title,b.title),
              alternate_title=COALESCE(pc.alternate_title,b.alternate_title),
              tags=CASE WHEN cardinality(pc.tags)=0 THEN COALESCE(b.tags,'{}') ELSE pc.tags END,
              category=COALESCE(pc.category,b.category),
              search_text=COALESCE(pc.search_text,b.search_text),
              first_published_at=COALESCE(pc.first_published_at,b.first_published_at)
         FROM b
        WHERE pc.page_id=b.page_id
          AND pc.wikidot_id=b.wikidot_id
          AND pc.slug=b.current_slug
          AND (
            pc.title IS DISTINCT FROM COALESCE(pc.title,b.title)
            OR pc.alternate_title IS DISTINCT FROM
                 COALESCE(pc.alternate_title,b.alternate_title)
            OR pc.tags IS DISTINCT FROM
                 CASE WHEN cardinality(pc.tags)=0 THEN COALESCE(b.tags,'{}') ELSE pc.tags END
            OR pc.category IS DISTINCT FROM COALESCE(pc.category,b.category)
            OR pc.search_text IS DISTINCT FROM COALESCE(pc.search_text,b.search_text)
            OR pc.first_published_at IS DISTINCT FROM
                 COALESCE(pc.first_published_at,b.first_published_at)
          )`,
      [payload],
    );
  }
  await pool.query(
    `WITH latest AS (
       SELECT DISTINCT ON (ps.page_id) ps.page_id, ps.blob_sha, cb.text_content
         FROM ingest.page_source ps
         JOIN ingest.content_blob cb ON cb.sha256=ps.blob_sha
        ORDER BY ps.page_id, ps.observed_at DESC, ps.id DESC
     )
     UPDATE serve.page_current pc
        SET source_sha=COALESCE(pc.source_sha,l.blob_sha),
            search_text=COALESCE(pc.search_text,l.text_content)
       FROM latest l
      WHERE pc.page_id=l.page_id
        AND (pc.source_sha IS NULL OR pc.search_text IS NULL)`,
  );
  const bad = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n
       FROM ingest.page p
       JOIN ingest.page_slug_history h ON h.page_id=p.id AND h.valid_to IS NULL
       LEFT JOIN serve.page_current pc ON pc.page_id=p.id
      WHERE pc.page_id IS NULL OR pc.wikidot_id<>p.wikidot_id OR pc.slug<>h.slug`,
  );
  if (asNumber(bad.rows[0]?.n) !== 0) {
    throw new Error(`page_current 身份/slug 基线有 ${bad.rows[0]?.n} 行不一致`);
  }
}

async function ensureProgress(
  pool: Pool,
  shard: string,
  total: number,
): Promise<number> {
  await pool.query(
    `INSERT INTO meta.backfill_progress(domain,shard,last_page_id,done_count,total_count)
     VALUES ($1,$2,0,0,$3)
     ON CONFLICT (domain,shard) DO UPDATE
       SET total_count=EXCLUDED.total_count,updated_at=now()`,
    [PROGRESS_DOMAIN, shard, total],
  );
  const row = await pool.query<{ last_page_id: number }>(
    `SELECT last_page_id FROM meta.backfill_progress WHERE domain=$1 AND shard=$2`,
    [PROGRESS_DOMAIN, shard],
  );
  return row.rows[0]?.last_page_id ?? 0;
}

async function applyAttributions(
  pool: Pool,
  plan: AttributionCarryoverPlan,
  observedAt: string,
  runId: number,
  batchSize: number,
): Promise<void> {
  const byPage = new Map<number, MappedAttributionPlan[]>();
  for (const row of plan.currentRows) {
    const group = byPage.get(row.pageId);
    if (group) group.push(row);
    else byPage.set(row.pageId, [row]);
  }
  const pageIds = [...byPage.keys()].sort((a, b) => a - b);
  const last = await ensureProgress(pool, 'attribution', pageIds.length);
  const remaining = pageIds.filter((pageId) => pageId > last);
  for (let i = 0; i < remaining.length; i += batchSize) {
    const ids = remaining.slice(i, i + batchSize);
    const rows = ids.flatMap((pageId) => byPage.get(pageId) ?? []);
    await applyMappedAttributionSnapshots(
      pool,
      rows.map((row) => ({
        pageId: row.pageId,
        wikidotId: row.wikidotId,
        actorId: row.actorId,
        role: row.role,
        ord: row.ord,
        atDate: row.atDate,
        v1PageVersionId: row.v1PageVersionId,
      })),
      {
        observedAt,
        runId,
        source: ATTR_SOURCE,
        isComplete: true,
      },
    );
    await pool.query(
      `UPDATE meta.backfill_progress
          SET last_page_id=$3,done_count=done_count+$4,total_count=$5,updated_at=now()
        WHERE domain=$1 AND shard=$2`,
      [PROGRESS_DOMAIN, 'attribution', ids.at(-1), ids.length, pageIds.length],
    );
  }
}

async function applyLifeShard(
  pool: Pool,
  pages: readonly PageLifePlan[],
  shard: 'life_created' | 'life_deleted',
  observedAt: string,
  batchSize: number,
): Promise<void> {
  const selected = pages
    .filter((row) => shard === 'life_created' || row.resolvedDeleted)
    .sort((a, b) => a.page_id - b.page_id);
  const last = await ensureProgress(pool, shard, selected.length);
  const remaining = selected.filter((row) => row.page_id > last);
  for (let i = 0; i < remaining.length; i += batchSize) {
    const batch = remaining.slice(i, i + batchSize);
    const payload = JSON.stringify(batch.map((row) => ({
      page_id: row.page_id,
      wikidot_id: row.wikidot_id,
      kind: shard === 'life_created' ? 'created' : 'deleted',
      occurred_at: shard === 'life_created' ? row.createdAt : row.deletedAt,
      precision: shard === 'life_created' ? row.createdPrecision : row.deletedPrecision,
      source: shard === 'life_created' ? 'v1_backfill' : row.deletionSource,
    })));
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `WITH b AS (
           SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(
             page_id int,wikidot_id int,kind text,occurred_at timestamptz,
             precision text,source text
           )
         )
         SELECT ingest.apply_page_life(
           p_page=>page_id,p_kind=>kind,p_occurred=>occurred_at,p_precision=>precision,
           p_observed=>$2::timestamptz,p_source=>source,p_wikidot_id=>wikidot_id
         )
           FROM b ORDER BY page_id`,
        [payload, observedAt],
      );
      await client.query(
        `UPDATE meta.backfill_progress
            SET last_page_id=$3,done_count=done_count+$4,total_count=$5,updated_at=now()
          WHERE domain=$1 AND shard=$2`,
        [PROGRESS_DOMAIN, shard, batch.at(-1)!.page_id, batch.length, selected.length],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

async function writeLifeAudit(
  pool: Pool,
  pages: readonly PageLifePlan[],
): Promise<void> {
  const divergent = pages.filter((row) => row.divergent);
  if (divergent.length === 0) return;
  await pool.query(
    `WITH b AS (
       SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(
         page_id int,page_is_deleted boolean,current_version_id int,
         current_version_is_deleted boolean,resolved_deleted boolean
       )
     )
     INSERT INTO meta.v1_page_life_divergence_audit(
       page_id,v1_page_is_deleted,v1_current_version_id,v1_current_version_deleted,
       resolved_deleted,resolution
     )
     SELECT page_id,page_is_deleted,current_version_id,current_version_is_deleted,
            resolved_deleted,'page_life_event_from_v1_page_state'
       FROM b
     ON CONFLICT (page_id) DO NOTHING`,
    [JSON.stringify(divergent)],
  );
}

async function loadVersionMap(
  pool: Pool,
  versions: readonly VersionMapPlan[],
  batchSize: number,
): Promise<string> {
  const fingerprint = artifactFingerprint(versions);
  const frozen = await pool.query<{ row_count: string; fingerprint: string }>(
    `SELECT row_count::text,fingerprint FROM meta.v1_backfill_artifact_freeze
      WHERE artifact='v1_version_map'`,
  );
  if (frozen.rowCount === 1) {
    const row = frozen.rows[0]!;
    if (asNumber(row.row_count) > versions.length) {
      throw new Error('v1_version_map 冻结行数超前于当前 v1 快照');
    }
    if (asNumber(row.row_count) === versions.length && row.fingerprint === fingerprint) {
      return fingerprint;
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `DELETE FROM meta.v1_backfill_artifact_freeze WHERE artifact='v1_version_map'`,
    );
    for (let i = 0; i < versions.length; i += batchSize) {
      const payload = JSON.stringify(versions.slice(i, i + batchSize));
      // 活 v1 追加 PageVersion 时允许两类单向变化：上一条 current 的 valid_to
      // 从 NULL 关闭到新版本时刻；display 的空字段被 CROM 补成非空。其它历史字段
      // 逐字不变。关闭开区间必须先于插入新 current，否则会撞 pvd_current 部分唯一索引。
      const historicalConflict = await client.query<{ n: string }>(
        `WITH b AS (
           SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(
             id int,page_id int,valid_from timestamptz,valid_to timestamptz,is_deleted boolean,
             title text,alternate_title text,tags text[],category text,"versionNo" int
           )
         )
         SELECT count(*)::text AS n
           FROM b
           JOIN meta.v1_version_map m ON m.v1_page_version_id=b.id
           LEFT JOIN serve.page_version_display d
             ON d.page_id=b.page_id AND d.version_no=b."versionNo"
          WHERE (m.page_id,m.valid_from,m.is_deleted,m.version_no)
                  IS DISTINCT FROM
                (b.page_id,b.valid_from,b.is_deleted,b."versionNo")
             OR NOT (
                  m.valid_to IS NOT DISTINCT FROM b.valid_to
                  OR (m.valid_to IS NULL AND b.valid_to IS NOT NULL)
                )
             OR d.page_id IS NULL
             OR d.valid_from IS DISTINCT FROM b.valid_from
             OR d.life_kind IS DISTINCT FROM
                  CASE WHEN b."versionNo"=1 THEN 'created' ELSE NULL END
             OR NOT (
                  d.title IS NOT DISTINCT FROM b.title
                  OR (d.title IS NULL AND b.title IS NOT NULL)
                )
             OR NOT (
                  d.alternate_title IS NOT DISTINCT FROM b.alternate_title
                  OR (d.alternate_title IS NULL AND b.alternate_title IS NOT NULL)
                )
             OR NOT (
                  d.tags IS NOT DISTINCT FROM b.tags
                  OR (
                    COALESCE(cardinality(d.tags),0)=0
                    AND COALESCE(cardinality(b.tags),0)>0
                  )
                )
             OR NOT (
                  d.category IS NOT DISTINCT FROM b.category
                  OR (d.category IS NULL AND b.category IS NOT NULL)
                )
             OR NOT (
                  d.valid_to IS NOT DISTINCT FROM b.valid_to
                  OR (d.valid_to IS NULL AND b.valid_to IS NOT NULL)
                )`,
        [payload],
      );
      if (asNumber(historicalConflict.rows[0]?.n) !== 0) {
        throw new Error(`v1_version_map batch ${i} 有非开区间关闭/空字段补全型历史冲突`);
      }
      await client.query(
        `WITH b AS (
           SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(
             id int,page_id int,valid_from timestamptz,valid_to timestamptz,is_deleted boolean,
             title text,alternate_title text,tags text[],category text,"versionNo" int
           )
         )
         UPDATE meta.v1_version_map m
            SET valid_to=b.valid_to
           FROM b
          WHERE m.v1_page_version_id=b.id
            AND m.valid_to IS NULL
            AND b.valid_to IS NOT NULL`,
        [payload],
      );
      await client.query(
        `WITH b AS (
           SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(
             id int,page_id int,valid_from timestamptz,valid_to timestamptz,is_deleted boolean,
             title text,alternate_title text,tags text[],category text,"versionNo" int
           )
         )
         UPDATE serve.page_version_display d
            SET valid_to=CASE
                           WHEN d.valid_to IS NULL AND b.valid_to IS NOT NULL
                           THEN b.valid_to ELSE d.valid_to
                         END,
                title=COALESCE(d.title,b.title),
                alternate_title=COALESCE(d.alternate_title,b.alternate_title),
                tags=CASE
                       WHEN COALESCE(cardinality(d.tags),0)=0
                        AND COALESCE(cardinality(b.tags),0)>0
                       THEN b.tags ELSE d.tags
                     END,
                category=COALESCE(d.category,b.category)
           FROM b
          WHERE d.page_id=b.page_id
            AND d.version_no=b."versionNo"
            AND (
              (d.valid_to IS NULL AND b.valid_to IS NOT NULL)
              OR (d.title IS NULL AND b.title IS NOT NULL)
              OR (d.alternate_title IS NULL AND b.alternate_title IS NOT NULL)
              OR (
                COALESCE(cardinality(d.tags),0)=0
                AND COALESCE(cardinality(b.tags),0)>0
              )
              OR (d.category IS NULL AND b.category IS NOT NULL)
            )`,
        [payload],
      );
      await client.query(
        `WITH b AS (
           SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(
             id int,page_id int,valid_from timestamptz,valid_to timestamptz,is_deleted boolean,
             title text,alternate_title text,tags text[],category text,"versionNo" int
           )
         )
         INSERT INTO meta.v1_version_map(
           v1_page_version_id,page_id,valid_from,valid_to,is_deleted,version_no
         )
         SELECT id,page_id,valid_from,valid_to,is_deleted,"versionNo" FROM b
         ON CONFLICT (v1_page_version_id) DO NOTHING`,
        [payload],
      );
      await client.query(
        `WITH b AS (
           SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(
             id int,page_id int,valid_from timestamptz,valid_to timestamptz,is_deleted boolean,
             title text,alternate_title text,tags text[],category text,"versionNo" int
           )
         )
         INSERT INTO serve.page_version_display(
           page_id,version_no,valid_from,valid_to,title,alternate_title,tags,category,life_kind
         )
         SELECT page_id,"versionNo",valid_from,valid_to,title,alternate_title,tags,category,
                CASE WHEN "versionNo"=1 THEN 'created' ELSE NULL END
           FROM b
         ON CONFLICT (page_id,version_no) DO NOTHING`,
        [payload],
      );
      const mismatch = await client.query<{ n: string }>(
        `WITH b AS (
           SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(
             id int,page_id int,valid_from timestamptz,valid_to timestamptz,is_deleted boolean,
             title text,alternate_title text,tags text[],category text,"versionNo" int
           )
         )
         SELECT count(*)::text AS n
           FROM b
           LEFT JOIN meta.v1_version_map m ON m.v1_page_version_id=b.id
           LEFT JOIN serve.page_version_display d
             ON d.page_id=b.page_id AND d.version_no=b."versionNo"
          WHERE m.v1_page_version_id IS NULL
             OR (m.page_id,m.valid_from,m.valid_to,m.is_deleted,m.version_no)
                IS DISTINCT FROM
                (b.page_id,b.valid_from,b.valid_to,b.is_deleted,b."versionNo")
             OR d.page_id IS NULL
             OR (d.valid_from,d.valid_to,d.title,d.alternate_title,d.tags,d.category,d.life_kind)
                IS DISTINCT FROM
                (b.valid_from,b.valid_to,b.title,b.alternate_title,b.tags,b.category,
                 CASE WHEN b."versionNo"=1 THEN 'created' ELSE NULL END)`,
        [payload],
      );
      if (asNumber(mismatch.rows[0]?.n) !== 0) {
        throw new Error(`v1_version_map batch ${i} 有历史冲突`);
      }
    }
    const count = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM meta.v1_version_map`,
    );
    if (asNumber(count.rows[0]?.n) !== versions.length) {
      throw new Error(`v1_version_map 行数 ${count.rows[0]?.n} != source ${versions.length}`);
    }
    await client.query(
      `INSERT INTO meta.v1_backfill_artifact_freeze(artifact,row_count,fingerprint)
       VALUES ('v1_version_map',$1,$2)`,
      [versions.length, fingerprint],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  return fingerprint;
}

async function resetIdentitySequences(pool: Pool): Promise<void> {
  await pool.query(
    `DO $$
     DECLARE r record; v_last bigint; v_called boolean; v_high bigint; v_max bigint; v_target bigint;
     BEGIN
       FOR r IN
         SELECT 'ingest.page_id_seq'::text seq,'ingest.page'::text tbl,'id'::text col,
                meta.v2_reserved_page_id_start()::bigint-1 floor
         UNION ALL
         SELECT 'ingest.user_id_seq','ingest."user"','id',
                meta.v2_reserved_anonymous_actor_id_start()::bigint-1
         UNION ALL
         SELECT pg_get_serial_sequence(format('app.%I',c.relname),a.attname),
                format('app.%I',c.relname),a.attname,0::bigint
           FROM pg_class c
           JOIN pg_namespace n ON n.oid=c.relnamespace
           JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
          WHERE n.nspname='app' AND c.relkind='r' AND a.attidentity<>''
       LOOP
         EXECUTE format('SELECT last_value,is_called FROM %s',r.seq) INTO v_last,v_called;
         v_high := CASE WHEN v_called THEN v_last ELSE v_last-1 END;
         EXECUTE format('SELECT COALESCE(max(%I),0) FROM %s',r.col,r.tbl) INTO v_max;
         v_target := GREATEST(v_high,v_max,r.floor,0);
         IF v_target=0 THEN
           PERFORM setval(r.seq,1,false);
         ELSIF v_target>v_high THEN
           PERFORM setval(r.seq,v_target,true);
         END IF;
       END LOOP;
     END $$`,
  );
}

async function finalVerify(
  pool: Pool,
  source: SourceSnapshot,
  attribution: AttributionCarryoverPlan,
): Promise<Record<string, number>> {
  const actual = await pool.query<Record<string, string>>(
    `SELECT
       (SELECT count(*) FROM meta.v1_attribution_map)::text AS attr_map,
       (SELECT count(*) FROM serve.attribution_current)::text AS attr_current,
       (SELECT count(*) FROM serve.attribution_current ac
         WHERE ac.is_display <> NOT (
           upper(ac.role)='SUBMITTER' AND EXISTS (
             SELECT 1 FROM serve.attribution_current o
              WHERE o.page_id=ac.page_id AND upper(o.role)<>'SUBMITTER'
           )))::text AS display_bad,
       (SELECT count(*) FROM serve.page_current)::text AS page_current,
       (SELECT count(*) FROM serve.page_current WHERE status='deleted')::text AS deleted,
       (SELECT count(*) FROM ingest.page_life_event
         WHERE kind='deleted' AND source='legacy_import_2025_11')::text AS legacy_deleted,
       (SELECT count(*) FROM serve.page_current
         WHERE status='deleted' AND deleted_at_precision='inferred')::text AS inferred_deleted,
       (SELECT count(*) FROM meta.v1_page_life_divergence_audit)::text AS divergence,
       (SELECT count(*) FROM meta.v1_version_map)::text AS version_map,
       (SELECT count(*) FROM meta.v1_legacy_snapshot)::text AS legacy_manifests`,
  );
  const row = actual.rows[0]!;
  const expected = {
    attr_map: source.attributions.length,
    attr_current: attribution.currentRows.length,
    display_bad: 0,
    page_current: source.pages.length,
    deleted: source.pages.filter((item) => item.resolvedDeleted).length,
    legacy_deleted: source.pages.filter(
      (item) => item.resolvedDeleted && item.legacy_fingerprint,
    ).length,
    inferred_deleted: source.pages.filter((item) => item.resolvedDeleted).length,
    divergence: source.pages.filter((item) => item.divergent).length,
    version_map: source.versions.length,
    legacy_manifests: 3,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (asNumber(row[key]) !== value) {
      throw new Error(`S4/S5/S6 写后断言 ${key}：target=${row[key]} source=${value}`);
    }
  }
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, asNumber(value)]));
}

async function executeAll(
  sourceClient: PoolClient,
  targetPool: Pool,
  source: SourceSnapshot,
  attribution: AttributionCarryoverPlan,
  opts: CliOptions,
  sourceDb: string,
): Promise<Record<string, number>> {
  const lockClient = await targetPool.connect();
  let completed = false;
  try {
    await lockClient.query(`SELECT pg_advisory_lock(hashtext('backfill:s456'))`);
    await freezeWrites(targetPool);

    // 血统必须先于任何不可逆事实 seq；三张 manifest 全绿后才进入署名/生命周期。
    await copyLegacySnapshot(
      sourceClient,
      targetPool,
      source.legacy,
      opts.snapshotBatchSize,
      sourceDb,
    );

    await insertAnonymousActors(targetPool, attribution);
    await loadAttributionMap(targetPool, attribution, opts.batchSize);
    await ensurePageCurrent(targetPool, source.pages, opts.batchSize);

    const run = await targetPool.query<{ id: string }>(
      `INSERT INTO meta.ingest_run(source,status,started_at,stats)
       VALUES ('v1_backfill','running',$1::timestamptz,
               jsonb_build_object('domain','s456','source_database',$2::text))
       RETURNING id::text`,
      [source.observedAt, sourceDb],
    );
    const runId = asNumber(run.rows[0]!.id);
    await applyAttributions(
      targetPool,
      attribution,
      source.observedAt,
      runId,
      opts.batchSize,
    );
    await writeLifeAudit(targetPool, source.pages);
    await applyLifeShard(
      targetPool,
      source.pages,
      'life_created',
      source.observedAt,
      opts.batchSize,
    );
    await applyLifeShard(
      targetPool,
      source.pages,
      'life_deleted',
      source.observedAt,
      opts.batchSize,
    );
    await loadVersionMap(targetPool, source.versions, opts.batchSize);
    await resetIdentitySequences(targetPool);

    const verified = await finalVerify(targetPool, source, attribution);
    await targetPool.query(
      `UPDATE meta.ingest_run
          SET status='ok',finished_at=now(),stats=stats||$2::jsonb
        WHERE id=$1`,
      [runId, JSON.stringify({ verified })],
    );
    await releaseWrites(targetPool);
    completed = true;
    return verified;
  } finally {
    if (!completed) {
      process.stderr.write(
        '[backfill-s456] 执行未完成；identity 写闸保持冻结，供人工检查后续跑。\n',
      );
    }
    await lockClient.query(`SELECT pg_advisory_unlock(hashtext('backfill:s456'))`).catch(() => undefined);
    lockClient.release();
  }
}

async function run(): Promise<void> {
  const opts = parseArgs();
  const sourceDb = databaseName(opts.v1DatabaseUrl);
  const targetDb = databaseName(opts.targetDatabaseUrl);
  if (!['scpper-cn', 'scpper_cn'].includes(sourceDb)) {
    throw new Error(`v1 源库必须是 scpper-cn/scpper_cn，拿到 ${sourceDb}`);
  }
  if (PROTECTED_TARGETS.has(targetDb)) throw new Error(`拒绝把受保护库 ${targetDb} 当目标`);
  if (sourceDb === targetDb) throw new Error('源库与目标库不能相同');

  const sourcePool = createBackfillPool(opts.v1DatabaseUrl, {
    readOnly: true,
    applicationName: 'syncer2-backfill-s456-source-ro',
  });
  const targetPool = createBackfillPool(opts.targetDatabaseUrl, {
    readOnly: !opts.execute,
    // 正式执行保留一条 advisory-lock 会话，实际批处理走另一条连接。
    max: opts.execute ? 2 : 1,
    applicationName: opts.execute
      ? 'syncer2-backfill-s456-target'
      : 'syncer2-backfill-s456-target-ro',
  });
  const sourceClient = await sourcePool.connect();
  try {
    const observedAt = await beginSourceSnapshot(sourceClient);
    const [loadedSource, target] = await Promise.all([
      loadSourceSnapshot(sourceClient, observedAt),
      loadTargetState(targetPool),
    ]);
    const source: SourceSnapshot = { observedAt, ...loadedSource };
    const attribution = buildAttributionCarryoverPlan(
      source.attributions,
      target.anonymousActors,
      target.userAllocationHighWater,
    );
    const report = buildReport(opts, sourceDb, targetDb, source, target, attribution);
    printReport(report, opts.json);
    if (!opts.execute) {
      await sourceClient.query('ROLLBACK');
      return;
    }
    if (!report.canExecute) {
      throw new Error('S4/S5/S6 执行前硬闸未通过；未写目标库');
    }

    const verified = await executeAll(
      sourceClient,
      targetPool,
      source,
      attribution,
      opts,
      sourceDb,
    );
    await sourceClient.query('COMMIT');
    process.stdout.write(`${JSON.stringify({ completed: true, verified })}\n`);
  } catch (error) {
    await sourceClient.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    sourceClient.release();
    await Promise.all([sourcePool.end(), targetPool.end()]);
  }
}

run().catch((error) => {
  process.stderr.write(
    `[backfill-s456] ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
