/**
 * v1 → v2 浏览类应用数据迁移。
 *
 * 两条互相独立的正确性边界：
 *   1. v1_id 唯一键负责幂等；cursor 只负责少扫描，绝不拿水位冒充去重键。
 *   2. pageId/userId 只作为 v1 侧 JOIN 键；落 v2 前必须经 v1 wikidotId → ingest 身份重映射。
 */

import { Client, type PoolClient, type QueryResultRow } from 'pg';

import { query } from '../store/db.js';
import { toPgJson } from '../store/pgText.js';

export const VIEW_SOURCE_TABLES = [
  'PageViewEvent',
  'UserPixelEvent',
  'UserPageView',
] as const;

export type ViewSourceTable = (typeof VIEW_SOURCE_TABLES)[number];
export type ViewMigrationMode = 'full' | 'incremental';
type ViewCursorKind = 'id' | 'updated_at_id';

type ViewMigrationRejectReason =
  | 'v1_source_missing'
  | 'v1_page_missing'
  | 'v1_page_wikidot_id_missing'
  | 'v2_page_not_found'
  | 'v2_page_ambiguous'
  | 'v1_user_missing'
  | 'v1_user_wikidot_id_missing'
  | 'v2_user_not_found'
  | 'v2_user_ambiguous';

export interface ViewSourceIdentity {
  v1_id: number;
  v1_page_id: number | null;
  v1_page_exists: boolean | null;
  v1_page_wikidot_id: number | null;
  v1_user_id: number | null;
  v1_user_exists: boolean | null;
  v1_user_wikidot_id: number | null;
  source_updated_at: string | null;
}

export interface PageViewSourceRow extends ViewSourceIdentity {
  wikidot_id: number;
  client_hash: string;
  client_ip: string | null;
  user_agent: string | null;
  component: string | null;
  source: string | null;
  referer_host: string | null;
  created_at: string;
  accept_language: string | null;
  ua_platform: string | null;
  ua_brand_major: string | null;
  ua_family: string | null;
  softprint: string | null;
  visitor_token: string | null;
  tls_fingerprint: string | null;
}

interface UserPixelSourceRow extends ViewSourceIdentity {
  wikidot_id: number | null;
  username: string;
  client_hash: string;
  client_ip: string | null;
  user_agent: string | null;
  component: string | null;
  source: string | null;
  referer_host: string | null;
  created_at: string;
  accept_language: string | null;
  ua_platform: string | null;
  ua_brand_major: string | null;
  ua_family: string | null;
  softprint: string | null;
  visitor_token: string | null;
  tls_fingerprint: string | null;
}

export interface UserPageViewSourceRow extends ViewSourceIdentity {
  wikidot_id: number | null;
  first_viewed_at: string;
  last_viewed_at: string;
  view_count: number;
  updated_at: string;
}

export type ViewSourceRow = PageViewSourceRow | UserPixelSourceRow | UserPageViewSourceRow;

export interface MappingDecision {
  reason: ViewMigrationRejectReason | null;
  allReasons: ViewMigrationRejectReason[];
  pageCandidates: number[];
  userCandidates: number[];
  mappedPageId: number | null;
  mappedUserId: number | null;
}

export interface ApplyViewBatchResult {
  scanned: number;
  mapped: number;
  insertedOrUpdated: number;
  rejected: number;
  rejectReasons: Partial<Record<ViewMigrationRejectReason, number>>;
  lastId: number | null;
  lastUpdatedAt: string | null;
}

export interface ViewMigrationCursor {
  sourceTable: ViewSourceTable;
  mode: ViewMigrationMode;
  cursorKind: ViewCursorKind;
  startAfterId: number;
  lastId: number;
  snapshotId: number;
  startAfterUpdatedAt: string | null;
  lastUpdatedAt: string | null;
  snapshotUpdatedAt: string | null;
  snapshotSourceCount: number;
  passCount: number;
  completedAt: string | null;
}

export interface ViewMigrationReconciliation {
  sourceTable: ViewSourceTable;
  sourceRows: number;
  migratedRows: number;
  rejectedRows: number;
  unaccountedRows: number;
  rejectReasons: Partial<Record<ViewMigrationRejectReason, number>>;
  snapshotId: number;
  snapshotUpdatedAt: string | null;
  completed: boolean;
}

export interface ViewMigrationRunOptions {
  mode: ViewMigrationMode;
  batchSize: number;
  maxBatches?: number;
  maxCatchupPasses?: number;
  retryFailures?: boolean;
  retryLimit?: number;
  tables?: readonly ViewSourceTable[];
  onBatch?: (table: ViewSourceTable, result: ApplyViewBatchResult) => void;
}

const PROTECTED_TARGET_DATABASES = new Set([
  'scpper-cn',
  'scpper_cn',
  'scpper-syncer',
  'scpper_syncer',
  'scpper_user',
  'postgres',
  'template0',
  'template1',
]);
const SOURCE_DATABASES = new Set(['scpper-cn', 'scpper_cn']);
const EPOCH = '1970-01-01T00:00:00.000000Z';
const TS_FORMAT = 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"';
const PROGRESS_DOMAIN = 'view_migration';

function databaseName(connectionString: string): string {
  const url = new URL(connectionString);
  return decodeURIComponent(url.pathname.replace(/^\/+/, ''));
}

export function assertV1ReadOnlyUrl(connectionString: string): void {
  const url = new URL(connectionString);
  const options = url.searchParams
    .getAll('options')
    .map((value) => decodeURIComponent(value))
    .join(' ');
  if (!/(?:^|\s)-c\s*default_transaction_read_only=on(?:\s|$)/.test(options)) {
    throw new Error(
      'SYNCER2_V1_DATABASE_URL 必须保留 options=-c default_transaction_read_only=on；拒绝连接 v1',
    );
  }
}

export function assertDatabaseNames(v1Url: string, targetUrl: string): void {
  const source = databaseName(v1Url);
  const target = databaseName(targetUrl);
  if (!SOURCE_DATABASES.has(source)) {
    throw new Error(`v1 连接必须指向 scpper-cn，当前数据库名为 ${source || '<empty>'}`);
  }
  if (PROTECTED_TARGET_DATABASES.has(target) || target !== 'scpper-v2') {
    throw new Error(`迁移目标只允许 scpper-v2，当前数据库名为 ${target || '<empty>'}`);
  }
}

export function createV1ReadOnlyClient(connectionString: string): Client {
  assertV1ReadOnlyUrl(connectionString);
  return new Client({
    connectionString,
    application_name: 'syncer2-view-migration-v1-readonly',
    // 与 URL 中不可移除的参数同向再加一道启动参数；不是用客户端约定替代服务端只读。
    options: '-c default_transaction_read_only=on -c statement_timeout=0',
  });
}

export async function assertV1SessionReadOnly(client: Client): Promise<void> {
  const result = await client.query<{
    database: string;
    default_read_only: string;
    transaction_read_only: string;
  }>(
    `SELECT current_database() AS database,
            current_setting('default_transaction_read_only') AS default_read_only,
            current_setting('transaction_read_only') AS transaction_read_only`,
  );
  const row = result.rows[0];
  if (
    !row ||
    !SOURCE_DATABASES.has(row.database) ||
    row.default_read_only !== 'on' ||
    row.transaction_read_only !== 'on'
  ) {
    throw new Error(
      `v1 只读硬关卡失败：db=${row?.database ?? '<none>'}, ` +
        `default=${row?.default_read_only ?? '<none>'}, tx=${row?.transaction_read_only ?? '<none>'}`,
    );
  }
  await client.query(`SET TIME ZONE 'UTC'`);
}

function requiredIdentities(table: ViewSourceTable): { page: boolean; user: boolean } {
  return {
    page: table !== 'UserPixelEvent',
    user: table !== 'PageViewEvent',
  };
}

/** 稳定优先级让“每行一个 primary reason”的对账分母恒定；allReasons 保留复合失败。 */
export function classifyViewIdentity(
  table: ViewSourceTable,
  row: ViewSourceIdentity,
  pageCandidates: readonly number[],
  userCandidates: readonly number[],
): MappingDecision {
  const required = requiredIdentities(table);
  const reasons: ViewMigrationRejectReason[] = [];
  if (required.page) {
    if (row.v1_page_exists === false) reasons.push('v1_page_missing');
    else if (row.v1_page_wikidot_id === null) reasons.push('v1_page_wikidot_id_missing');
    else if (pageCandidates.length === 0) reasons.push('v2_page_not_found');
    else if (pageCandidates.length > 1) reasons.push('v2_page_ambiguous');
  }
  if (required.user) {
    if (row.v1_user_exists === false) reasons.push('v1_user_missing');
    else if (row.v1_user_wikidot_id === null) reasons.push('v1_user_wikidot_id_missing');
    else if (userCandidates.length === 0) reasons.push('v2_user_not_found');
    else if (userCandidates.length > 1) reasons.push('v2_user_ambiguous');
  }
  return {
    reason: reasons[0] ?? null,
    allReasons: reasons,
    pageCandidates: [...pageCandidates],
    userCandidates: [...userCandidates],
    mappedPageId: required.page && pageCandidates.length === 1 ? pageCandidates[0]! : null,
    mappedUserId: required.user && userCandidates.length === 1 ? userCandidates[0]! : null,
  };
}

async function loadCandidateMap(
  db: PoolClient,
  relation: 'ingest.page' | 'ingest."user"',
  wikidotIds: readonly number[],
): Promise<Map<number, number[]>> {
  const ids = [...new Set(wikidotIds)].sort((a, b) => a - b);
  if (ids.length === 0) return new Map();
  const result = await query<{ wikidot_id: number; id: number }>(
    db,
    `view_migration:candidates:${relation}`,
    `SELECT wikidot_id,id FROM ${relation} WHERE wikidot_id=ANY($1::int[]) ORDER BY wikidot_id,id`,
    [ids],
  );
  const mapped = new Map<number, number[]>();
  for (const row of result.rows) {
    const key = Number(row.wikidot_id);
    const group = mapped.get(key);
    if (group) group.push(Number(row.id));
    else mapped.set(key, [Number(row.id)]);
  }
  return mapped;
}

interface MappedPayload extends ViewSourceIdentity {
  [key: string]: unknown;
  failure_reason: ViewMigrationRejectReason | null;
  all_reasons: ViewMigrationRejectReason[];
  candidate_page_ids: number[];
  candidate_user_ids: number[];
  mapped_page_id: number | null;
  mapped_user_id: number | null;
}

function rejectCounts(payload: readonly MappedPayload[]): Partial<Record<ViewMigrationRejectReason, number>> {
  const counts: Partial<Record<ViewMigrationRejectReason, number>> = {};
  for (const row of payload) {
    if (row.failure_reason !== null) counts[row.failure_reason] = (counts[row.failure_reason] ?? 0) + 1;
  }
  return counts;
}

async function writePageViewBatch(db: PoolClient, payload: readonly MappedPayload[]): Promise<number> {
  const result = await query(
    db,
    'view_migration:insert:page_view_event',
    `WITH b AS (
       SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(
         v1_id bigint,mapped_page_id int,wikidot_id int,client_hash text,client_ip text,
         user_agent text,component text,source text,referer_host text,created_at timestamptz,
         accept_language text,ua_platform text,ua_brand_major text,ua_family text,
         softprint text,visitor_token text,tls_fingerprint text,failure_reason text
       )
     )
     INSERT INTO app.page_view_event(
       v1_id,page_id,wikidot_id,client_hash,client_ip,user_agent,component,source,referer_host,
       created_at,accept_language,ua_platform,ua_brand_major,ua_family,softprint,visitor_token,
       tls_fingerprint
     )
     SELECT v1_id,mapped_page_id,wikidot_id,client_hash,client_ip,user_agent,component,source,
            referer_host,created_at,accept_language,ua_platform,ua_brand_major,ua_family,
            softprint,visitor_token,tls_fingerprint
       FROM b WHERE failure_reason IS NULL
     ON CONFLICT (v1_id) WHERE v1_id IS NOT NULL DO NOTHING`,
    [toPgJson(payload, 'view_migration:page_view_event')],
  );
  return result.rowCount ?? 0;
}

async function writeUserPixelBatch(db: PoolClient, payload: readonly MappedPayload[]): Promise<number> {
  const result = await query(
    db,
    'view_migration:insert:user_pixel_event',
    `WITH b AS (
       SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(
         v1_id bigint,mapped_user_id int,wikidot_id int,username text,client_hash text,
         client_ip text,user_agent text,component text,source text,referer_host text,
         created_at timestamptz,accept_language text,ua_platform text,ua_brand_major text,
         ua_family text,softprint text,visitor_token text,tls_fingerprint text,failure_reason text
       )
     )
     INSERT INTO app.user_pixel_event(
       v1_id,user_id,wikidot_id,username,client_hash,client_ip,user_agent,component,source,
       referer_host,created_at,accept_language,ua_platform,ua_brand_major,ua_family,softprint,
       visitor_token,tls_fingerprint
     )
     SELECT v1_id,mapped_user_id,wikidot_id,username,client_hash,client_ip,user_agent,component,
            source,referer_host,created_at,accept_language,ua_platform,ua_brand_major,ua_family,
            softprint,visitor_token,tls_fingerprint
       FROM b WHERE failure_reason IS NULL
     ON CONFLICT (v1_id) WHERE v1_id IS NOT NULL DO NOTHING`,
    [toPgJson(payload, 'view_migration:user_pixel_event')],
  );
  return result.rowCount ?? 0;
}

async function writeUserPageViewBatch(db: PoolClient, payload: readonly MappedPayload[]): Promise<number> {
  const result = await query(
    db,
    'view_migration:upsert:user_page_view',
    `WITH b AS (
       SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(
         v1_id bigint,mapped_user_id int,wikidot_id int,mapped_page_id int,
         first_viewed_at timestamptz,last_viewed_at timestamptz,view_count int,
         updated_at timestamptz,failure_reason text
       )
     )
     INSERT INTO app.user_page_view(
       v1_id,user_id,wikidot_id,page_id,first_viewed_at,last_viewed_at,view_count,updated_at
     )
     SELECT v1_id,mapped_user_id,wikidot_id,mapped_page_id,first_viewed_at,last_viewed_at,
            view_count,updated_at
       FROM b WHERE failure_reason IS NULL
     ON CONFLICT (user_id,page_id) DO UPDATE SET
       v1_id=EXCLUDED.v1_id,
       wikidot_id=EXCLUDED.wikidot_id,
       first_viewed_at=EXCLUDED.first_viewed_at,
       last_viewed_at=EXCLUDED.last_viewed_at,
       view_count=EXCLUDED.view_count,
       updated_at=EXCLUDED.updated_at
     WHERE app.user_page_view.v1_id IS NULL
        OR app.user_page_view.v1_id=EXCLUDED.v1_id`,
    [toPgJson(payload, 'view_migration:user_page_view')],
  );
  return result.rowCount ?? 0;
}

async function writeRejects(db: PoolClient, table: ViewSourceTable, payload: readonly MappedPayload[]): Promise<void> {
  if (!payload.some((row) => row.failure_reason !== null)) return;
  await query(
    db,
    'view_migration:rejects',
    `WITH b AS (
       SELECT * FROM jsonb_to_recordset($2::jsonb) AS x(
         v1_id bigint,v1_page_id int,v1_page_wikidot_id int,v1_user_id int,
         v1_user_wikidot_id int,failure_reason text,all_reasons text[],
         candidate_page_ids int[],candidate_user_ids int[],wikidot_id int
       )
     )
     INSERT INTO meta.view_migration_reject(
       source_table,v1_id,reason,v1_page_id,v1_page_wikidot_id,v1_user_id,
       v1_user_wikidot_id,candidate_page_ids,candidate_user_ids,details
     )
     SELECT $1,v1_id,failure_reason,v1_page_id,v1_page_wikidot_id,v1_user_id,
            v1_user_wikidot_id,candidate_page_ids,candidate_user_ids,
            jsonb_build_object('all_reasons',all_reasons,'source_row_wikidot_id',wikidot_id)
       FROM b WHERE failure_reason IS NOT NULL
     ON CONFLICT (source_table,v1_id) DO UPDATE SET
       reason=EXCLUDED.reason,
       v1_page_id=EXCLUDED.v1_page_id,
       v1_page_wikidot_id=EXCLUDED.v1_page_wikidot_id,
       v1_user_id=EXCLUDED.v1_user_id,
       v1_user_wikidot_id=EXCLUDED.v1_user_wikidot_id,
       candidate_page_ids=EXCLUDED.candidate_page_ids,
       candidate_user_ids=EXCLUDED.candidate_user_ids,
       details=EXCLUDED.details,
       last_seen_at=now(),
       attempt_count=meta.view_migration_reject.attempt_count+1,
       resolved_at=NULL`,
    [table, toPgJson(payload, `view_migration:rejects:${table}`)],
  );
}

async function resolveRejects(db: PoolClient, table: ViewSourceTable, ids: readonly number[]): Promise<void> {
  if (ids.length === 0) return;
  await query(
    db,
    'view_migration:resolve_rejects',
    `UPDATE meta.view_migration_reject
        SET resolved_at=COALESCE(resolved_at,now()),last_seen_at=now()
      WHERE source_table=$1 AND v1_id=ANY($2::bigint[]) AND resolved_at IS NULL`,
    [table, ids],
  );
}

/** 目标写入的最小事务单元；测试可直接重放同一个 batch 验证内容不变。 */
export async function applyViewMigrationBatch(
  db: PoolClient,
  table: ViewSourceTable,
  rows: readonly ViewSourceRow[],
): Promise<ApplyViewBatchResult> {
  if (rows.length === 0) {
    return {
      scanned: 0,
      mapped: 0,
      insertedOrUpdated: 0,
      rejected: 0,
      rejectReasons: {},
      lastId: null,
      lastUpdatedAt: null,
    };
  }
  const pageWikidotIds = rows
    .map((row) => row.v1_page_wikidot_id)
    .filter((id): id is number => id !== null);
  const userWikidotIds = rows
    .map((row) => row.v1_user_wikidot_id)
    .filter((id): id is number => id !== null);
  const pageMap = await loadCandidateMap(db, 'ingest.page', pageWikidotIds);
  const userMap = await loadCandidateMap(db, 'ingest."user"', userWikidotIds);

  const payload: MappedPayload[] = rows.map((row) => {
    const pageCandidates =
      row.v1_page_wikidot_id === null ? [] : (pageMap.get(row.v1_page_wikidot_id) ?? []);
    const userCandidates =
      row.v1_user_wikidot_id === null ? [] : (userMap.get(row.v1_user_wikidot_id) ?? []);
    const decision = classifyViewIdentity(table, row, pageCandidates, userCandidates);
    return {
      ...row,
      failure_reason: decision.reason,
      all_reasons: decision.allReasons,
      candidate_page_ids: decision.pageCandidates,
      candidate_user_ids: decision.userCandidates,
      mapped_page_id: decision.mappedPageId,
      mapped_user_id: decision.mappedUserId,
    };
  });
  const mapped = payload.filter((row) => row.failure_reason === null);
  const insertedOrUpdated =
    table === 'PageViewEvent'
      ? await writePageViewBatch(db, payload)
      : table === 'UserPixelEvent'
        ? await writeUserPixelBatch(db, payload)
        : await writeUserPageViewBatch(db, payload);
  if (table === 'UserPageView' && insertedOrUpdated !== mapped.length) {
    throw new Error(
      `UserPageView 自然键冲突：映射 ${mapped.length} 行但只 upsert ${insertedOrUpdated} 行；` +
        '可能有两个 v1 来源身份收敛到同一 v2(user_id,page_id)，拒绝静默覆盖',
    );
  }
  await writeRejects(db, table, payload);
  await resolveRejects(db, table, mapped.map((row) => row.v1_id));
  const last = rows.at(-1)!;
  return {
    scanned: rows.length,
    mapped: mapped.length,
    insertedOrUpdated,
    rejected: rows.length - mapped.length,
    rejectReasons: rejectCounts(payload),
    lastId: last.v1_id,
    lastUpdatedAt: last.source_updated_at,
  };
}

function normalizeIdentityRow<T extends QueryResultRow>(row: T): T & ViewSourceIdentity {
  return {
    ...row,
    v1_id: Number(row['v1_id']),
    v1_page_id: row['v1_page_id'] === null ? null : Number(row['v1_page_id']),
    v1_page_exists: row['v1_page_exists'] === null ? null : Boolean(row['v1_page_exists']),
    v1_page_wikidot_id:
      row['v1_page_wikidot_id'] === null ? null : Number(row['v1_page_wikidot_id']),
    v1_user_id: row['v1_user_id'] === null ? null : Number(row['v1_user_id']),
    v1_user_exists: row['v1_user_exists'] === null ? null : Boolean(row['v1_user_exists']),
    v1_user_wikidot_id:
      row['v1_user_wikidot_id'] === null ? null : Number(row['v1_user_wikidot_id']),
    source_updated_at: row['source_updated_at'] === null ? null : String(row['source_updated_at']),
  } as T & ViewSourceIdentity;
}

function selectFor(table: ViewSourceTable): string {
  if (table === 'PageViewEvent') {
    return `SELECT e.id::bigint::text AS v1_id,
                   e."pageId" AS v1_page_id,p.id IS NOT NULL AS v1_page_exists,
                   p."wikidotId" AS v1_page_wikidot_id,
                   NULL::int AS v1_user_id,NULL::boolean AS v1_user_exists,
                   NULL::int AS v1_user_wikidot_id,NULL::text AS source_updated_at,
                   e."wikidotId" AS wikidot_id,e."clientHash" AS client_hash,
                   e."clientIp" AS client_ip,e."userAgent" AS user_agent,e.component,
                   e.source,e."refererHost" AS referer_host,
                   to_char(e."createdAt",'${TS_FORMAT}') AS created_at,
                   e."acceptLanguage" AS accept_language,e."uaPlatform" AS ua_platform,
                   e."uaBrandMajor" AS ua_brand_major,e."uaFamily" AS ua_family,
                   e.softprint,e."visitorToken" AS visitor_token,
                   e."tlsFingerprint" AS tls_fingerprint
              FROM public."PageViewEvent" e
              LEFT JOIN public."Page" p ON p.id=e."pageId"`;
  }
  if (table === 'UserPixelEvent') {
    return `SELECT e.id::bigint::text AS v1_id,
                   NULL::int AS v1_page_id,NULL::boolean AS v1_page_exists,
                   NULL::int AS v1_page_wikidot_id,
                   e."userId" AS v1_user_id,u.id IS NOT NULL AS v1_user_exists,
                   u."wikidotId" AS v1_user_wikidot_id,NULL::text AS source_updated_at,
                   e."wikidotId" AS wikidot_id,e.username,e."clientHash" AS client_hash,
                   e."clientIp" AS client_ip,e."userAgent" AS user_agent,e.component,
                   e.source,e."refererHost" AS referer_host,
                   to_char(e."createdAt",'${TS_FORMAT}') AS created_at,
                   e."acceptLanguage" AS accept_language,e."uaPlatform" AS ua_platform,
                   e."uaBrandMajor" AS ua_brand_major,e."uaFamily" AS ua_family,
                   e.softprint,e."visitorToken" AS visitor_token,
                   e."tlsFingerprint" AS tls_fingerprint
              FROM public."UserPixelEvent" e
              LEFT JOIN public."User" u ON u.id=e."userId"`;
  }
  return `SELECT e.id::text AS v1_id,
                 e."pageId" AS v1_page_id,p.id IS NOT NULL AS v1_page_exists,
                 p."wikidotId" AS v1_page_wikidot_id,
                 e."userId" AS v1_user_id,u.id IS NOT NULL AS v1_user_exists,
                 u."wikidotId" AS v1_user_wikidot_id,
                 to_char(e."updatedAt" AT TIME ZONE 'UTC','${TS_FORMAT}') AS source_updated_at,
                 e."wikidotId" AS wikidot_id,
                 to_char(e."firstViewedAt" AT TIME ZONE 'UTC','${TS_FORMAT}') AS first_viewed_at,
                 to_char(e."lastViewedAt" AT TIME ZONE 'UTC','${TS_FORMAT}') AS last_viewed_at,
                 e."viewCount" AS view_count,
                 to_char(e."updatedAt" AT TIME ZONE 'UTC','${TS_FORMAT}') AS updated_at
            FROM public."UserPageView" e
            LEFT JOIN public."Page" p ON p.id=e."pageId"
            LEFT JOIN public."User" u ON u.id=e."userId"`;
}

async function fetchViewSourceBatch(
  client: Client,
  table: ViewSourceTable,
  cursor: ViewMigrationCursor,
  limit: number,
): Promise<ViewSourceRow[]> {
  const sql =
    cursor.cursorKind === 'id'
      ? `${selectFor(table)}
          WHERE e.id>$1::bigint AND e.id<=$2::bigint
          ORDER BY e.id LIMIT $3`
      : `${selectFor(table)}
          WHERE (e."updatedAt",e.id)>($1::timestamptz,$2::bigint)
            AND (e."updatedAt",e.id)<=($3::timestamptz,$4::bigint)
          ORDER BY e."updatedAt",e.id LIMIT $5`;
  const params =
    cursor.cursorKind === 'id'
      ? [cursor.lastId, cursor.snapshotId, limit]
      : [
          cursor.lastUpdatedAt,
          cursor.lastId,
          cursor.snapshotUpdatedAt,
          cursor.snapshotId,
          limit,
        ];
  const result = await client.query(sql, params);
  return result.rows.map((row) => normalizeIdentityRow(row) as ViewSourceRow);
}

async function fetchViewSourceRowsById(
  client: Client,
  table: ViewSourceTable,
  ids: readonly number[],
): Promise<ViewSourceRow[]> {
  if (ids.length === 0) return [];
  const result = await client.query(
    `${selectFor(table)} WHERE e.id=ANY($1::bigint[]) ORDER BY e.id`,
    [ids],
  );
  return result.rows.map((row) => normalizeIdentityRow(row) as ViewSourceRow);
}

interface SnapshotHead {
  cursorKind: ViewCursorKind;
  snapshotId: number;
  snapshotUpdatedAt: string | null;
  snapshotSourceCount: number;
  passCount: number;
}

async function loadSnapshotHead(
  client: Client,
  table: ViewSourceTable,
  startAfterId: number,
  startAfterUpdatedAt: string | null,
): Promise<SnapshotHead> {
  if (table !== 'UserPageView') {
    const result = await client.query<{
      snapshot_id: string;
      source_count: string;
      pass_count: string;
    }>(
      `WITH head AS (SELECT COALESCE(max(id),0)::bigint AS id FROM public."${table}")
       SELECT head.id::text AS snapshot_id,
              count(*) FILTER (WHERE e.id<=head.id)::text AS source_count,
              count(*) FILTER (WHERE e.id>$1::bigint AND e.id<=head.id)::text AS pass_count
         FROM public."${table}" e CROSS JOIN head GROUP BY head.id`,
      [startAfterId],
    );
    const row = result.rows[0]!;
    return {
      cursorKind: 'id',
      snapshotId: Number(row.snapshot_id),
      snapshotUpdatedAt: null,
      snapshotSourceCount: Number(row.source_count),
      passCount: Number(row.pass_count),
    };
  }
  const lowerUpdatedAt = startAfterUpdatedAt ?? EPOCH;
  const result = await client.query<{
    snapshot_id: string;
    snapshot_updated_at: string;
    source_count: string;
    pass_count: string;
  }>(
    `WITH head AS (
       SELECT id,"updatedAt" FROM public."UserPageView"
        ORDER BY "updatedAt" DESC,id DESC LIMIT 1
     ), bound AS (
       SELECT COALESCE(head.id,0)::bigint AS id,
              COALESCE(head."updatedAt",$1::timestamptz) AS updated_at
         FROM (SELECT 1) one LEFT JOIN head ON true
     )
     SELECT bound.id::text AS snapshot_id,
            to_char(bound.updated_at AT TIME ZONE 'UTC','${TS_FORMAT}') AS snapshot_updated_at,
            count(e.*) FILTER (WHERE (e."updatedAt",e.id)<=(bound.updated_at,bound.id))::text
              AS source_count,
            count(e.*) FILTER (
              WHERE (e."updatedAt",e.id)>($1::timestamptz,$2::bigint)
                AND (e."updatedAt",e.id)<=(bound.updated_at,bound.id)
            )::text AS pass_count
       FROM bound LEFT JOIN public."UserPageView" e ON true
      GROUP BY bound.id,bound.updated_at`,
    [lowerUpdatedAt, startAfterId],
  );
  const row = result.rows[0]!;
  return {
    cursorKind: 'updated_at_id',
    snapshotId: Number(row.snapshot_id),
    snapshotUpdatedAt: row.snapshot_updated_at,
    snapshotSourceCount: Number(row.source_count),
    passCount: Number(row.pass_count),
  };
}

function cursorFromRow(row: QueryResultRow): ViewMigrationCursor {
  const iso = (value: unknown): string | null =>
    value === null ? null : value instanceof Date ? value.toISOString() : String(value);
  return {
    sourceTable: row['source_table'] as ViewSourceTable,
    mode: row['mode'] as ViewMigrationMode,
    cursorKind: row['cursor_kind'] as ViewCursorKind,
    startAfterId: Number(row['start_after_id']),
    lastId: Number(row['last_id']),
    snapshotId: Number(row['snapshot_id']),
    startAfterUpdatedAt: iso(row['start_after_updated_at']),
    lastUpdatedAt: iso(row['last_updated_at']),
    snapshotUpdatedAt: iso(row['snapshot_updated_at']),
    snapshotSourceCount: Number(row['snapshot_source_count']),
    passCount: Number(row['pass_count']),
    completedAt: iso(row['completed_at']),
  };
}

export async function loadViewMigrationCursor(
  db: PoolClient,
  table: ViewSourceTable,
): Promise<ViewMigrationCursor | null> {
  const result = await query(
    db,
    'view_migration:load_cursor',
    `SELECT source_table,mode,cursor_kind,start_after_id,last_id,snapshot_id,
            CASE WHEN start_after_updated_at IS NULL THEN NULL
                 ELSE to_char(start_after_updated_at AT TIME ZONE 'UTC','${TS_FORMAT}') END
              AS start_after_updated_at,
            CASE WHEN last_updated_at IS NULL THEN NULL
                 ELSE to_char(last_updated_at AT TIME ZONE 'UTC','${TS_FORMAT}') END
              AS last_updated_at,
            CASE WHEN snapshot_updated_at IS NULL THEN NULL
                 ELSE to_char(snapshot_updated_at AT TIME ZONE 'UTC','${TS_FORMAT}') END
              AS snapshot_updated_at,
            snapshot_source_count,pass_count,started_at,updated_at,completed_at
       FROM meta.view_migration_cursor WHERE source_table=$1`,
    [table],
  );
  return result.rows[0] ? cursorFromRow(result.rows[0]) : null;
}

function shardFor(table: ViewSourceTable): string {
  return table === 'PageViewEvent'
    ? 'page_view_event'
    : table === 'UserPixelEvent'
      ? 'user_pixel_event'
      : 'user_page_view';
}

async function initializePass(
  source: Client,
  target: PoolClient,
  table: ViewSourceTable,
  mode: ViewMigrationMode,
  previous: ViewMigrationCursor | null,
): Promise<ViewMigrationCursor> {
  const incremental = mode === 'incremental' && previous !== null;
  const startAfterId = incremental ? previous.snapshotId : 0;
  const startAfterUpdatedAt =
    table === 'UserPageView' ? (incremental ? previous.snapshotUpdatedAt : EPOCH) : null;
  const head = await loadSnapshotHead(source, table, startAfterId, startAfterUpdatedAt);
  await query(
    target,
    'view_migration:initialize_cursor',
    `INSERT INTO meta.view_migration_cursor(
       source_table,mode,cursor_kind,start_after_id,last_id,snapshot_id,
       start_after_updated_at,last_updated_at,snapshot_updated_at,
       snapshot_source_count,pass_count,started_at,updated_at,completed_at
     ) VALUES ($1,$2,$3,$4,$4,$5,$6::timestamptz,$6::timestamptz,$7::timestamptz,
               $8,$9,now(),now(),CASE WHEN $9::bigint=0 THEN now() END)
     ON CONFLICT (source_table) DO UPDATE SET
       mode=EXCLUDED.mode,cursor_kind=EXCLUDED.cursor_kind,
       start_after_id=EXCLUDED.start_after_id,last_id=EXCLUDED.last_id,
       snapshot_id=EXCLUDED.snapshot_id,
       start_after_updated_at=EXCLUDED.start_after_updated_at,
       last_updated_at=EXCLUDED.last_updated_at,
       snapshot_updated_at=EXCLUDED.snapshot_updated_at,
       snapshot_source_count=EXCLUDED.snapshot_source_count,
       pass_count=EXCLUDED.pass_count,started_at=now(),updated_at=now(),
       completed_at=EXCLUDED.completed_at`,
    [
      table,
      mode,
      head.cursorKind,
      startAfterId,
      head.snapshotId,
      startAfterUpdatedAt,
      head.snapshotUpdatedAt,
      head.snapshotSourceCount,
      head.passCount,
    ],
  );
  if (head.snapshotId > 2_147_483_647) {
    throw new Error(`${table} snapshot id ${head.snapshotId} 超出 meta.backfill_progress.last_page_id int4`);
  }
  await query(
    target,
    'view_migration:initialize_progress',
    `INSERT INTO meta.backfill_progress(domain,shard,last_page_id,done_count,total_count,updated_at)
     VALUES ($1,$2,$3,0,$4,now())
     ON CONFLICT (domain,shard) DO UPDATE SET
       last_page_id=EXCLUDED.last_page_id,done_count=0,total_count=EXCLUDED.total_count,
       updated_at=now()`,
    [PROGRESS_DOMAIN, shardFor(table), startAfterId, head.passCount],
  );
  return (await loadViewMigrationCursor(target, table))!;
}

async function advanceProgress(
  db: PoolClient,
  table: ViewSourceTable,
  result: ApplyViewBatchResult,
): Promise<void> {
  await query(
    db,
    'view_migration:advance_cursor',
    `UPDATE meta.view_migration_cursor
        SET last_id=$2,last_updated_at=CASE WHEN cursor_kind='updated_at_id'
                                           THEN $3::timestamptz ELSE NULL END,
            updated_at=now()
      WHERE source_table=$1 AND completed_at IS NULL`,
    [table, result.lastId, result.lastUpdatedAt],
  );
  await query(
    db,
    'view_migration:advance_progress',
    `UPDATE meta.backfill_progress
        SET last_page_id=$3,done_count=LEAST(done_count+$4,total_count),updated_at=now()
      WHERE domain=$1 AND shard=$2`,
    [PROGRESS_DOMAIN, shardFor(table), result.lastId, result.scanned],
  );
}

async function completePass(db: PoolClient, table: ViewSourceTable): Promise<void> {
  await query(
    db,
    'view_migration:complete_cursor',
    `UPDATE meta.view_migration_cursor
        SET last_id=snapshot_id,last_updated_at=snapshot_updated_at,
            completed_at=COALESCE(completed_at,now()),updated_at=now()
      WHERE source_table=$1`,
    [table],
  );
  await query(
    db,
    'view_migration:complete_progress',
    `UPDATE meta.backfill_progress
        SET done_count=total_count,updated_at=now()
      WHERE domain=$1 AND shard=$2`,
    [PROGRESS_DOMAIN, shardFor(table)],
  );
}

async function openRejectIds(
  db: PoolClient,
  table: ViewSourceTable,
  limit: number,
): Promise<number[]> {
  const result = await query<{ v1_id: string }>(
    db,
    'view_migration:open_reject_ids',
    `SELECT v1_id::text FROM meta.view_migration_reject
      WHERE source_table=$1 AND resolved_at IS NULL ORDER BY v1_id LIMIT $2`,
    [table, limit],
  );
  return result.rows.map((row) => Number(row.v1_id));
}

async function markMissingSourceRows(
  db: PoolClient,
  table: ViewSourceTable,
  ids: readonly number[],
): Promise<void> {
  if (ids.length === 0) return;
  await query(
    db,
    'view_migration:missing_source_rejects',
    `UPDATE meta.view_migration_reject
        SET reason='v1_source_missing',last_seen_at=now(),attempt_count=attempt_count+1,
            details=details || jsonb_build_object('source_missing_on_retry',true),resolved_at=NULL
      WHERE source_table=$1 AND v1_id=ANY($2::bigint[])`,
    [table, ids],
  );
}

async function retryOpenRejects(
  source: Client,
  target: PoolClient,
  table: ViewSourceTable,
  batchSize: number,
  limit: number,
  onBatch?: ViewMigrationRunOptions['onBatch'],
): Promise<void> {
  const ids = await openRejectIds(target, table, limit);
  for (let offset = 0; offset < ids.length; offset += batchSize) {
    const wanted = ids.slice(offset, offset + batchSize);
    const rows = await fetchViewSourceRowsById(source, table, wanted);
    const found = new Set(rows.map((row) => row.v1_id));
    const missing = wanted.filter((id) => !found.has(id));
    await target.query('BEGIN');
    try {
      const result = await applyViewMigrationBatch(target, table, rows);
      await markMissingSourceRows(target, table, missing);
      await target.query('COMMIT');
      onBatch?.(table, result);
    } catch (error) {
      await target.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
  }
}

async function runPass(
  source: Client,
  target: PoolClient,
  table: ViewSourceTable,
  cursor: ViewMigrationCursor,
  options: ViewMigrationRunOptions,
  budget: { batches: number },
): Promise<boolean> {
  if (cursor.completedAt !== null) return true;
  for (;;) {
    if (options.maxBatches !== undefined && budget.batches >= options.maxBatches) return false;
    const current = (await loadViewMigrationCursor(target, table))!;
    const rows = await fetchViewSourceBatch(source, table, current, options.batchSize);
    if (rows.length === 0) {
      await target.query('BEGIN');
      try {
        await completePass(target, table);
        await target.query('COMMIT');
      } catch (error) {
        await target.query('ROLLBACK').catch(() => undefined);
        throw error;
      }
      return true;
    }
    await target.query('BEGIN');
    try {
      const result = await applyViewMigrationBatch(target, table, rows);
      await advanceProgress(target, table, result);
      await target.query('COMMIT');
      budget.batches++;
      options.onBatch?.(table, result);
    } catch (error) {
      await target.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
  }
}

function sameHead(cursor: ViewMigrationCursor, head: SnapshotHead): boolean {
  return (
    cursor.snapshotId === head.snapshotId &&
    (cursor.cursorKind === 'id' || cursor.snapshotUpdatedAt === head.snapshotUpdatedAt)
  );
}

export async function reconcileViewMigration(
  db: PoolClient,
  tables: readonly ViewSourceTable[] = VIEW_SOURCE_TABLES,
): Promise<ViewMigrationReconciliation[]> {
  const output: ViewMigrationReconciliation[] = [];
  for (const table of tables) {
    const target =
      table === 'PageViewEvent'
        ? 'app.page_view_event'
        : table === 'UserPixelEvent'
          ? 'app.user_pixel_event'
          : 'app.user_page_view';
    const result = await query<{
      source_rows: string;
      migrated_rows: string;
      rejected_rows: string;
      unaccounted_rows: string;
      snapshot_id: string;
      snapshot_updated_at: Date | string | null;
      completed: boolean;
      reject_reasons: Record<string, number> | null;
    }>(
      db,
      'view_migration:reconcile',
      `WITH c AS (
         SELECT * FROM meta.view_migration_cursor WHERE source_table=$1
       ), migrated AS (
         SELECT count(*)::bigint AS n FROM ${target} WHERE v1_id IS NOT NULL
       ), rejected AS (
         SELECT COALESCE(sum(n),0)::bigint AS n,
                COALESCE(jsonb_object_agg(reason,n), '{}'::jsonb) AS reasons
           FROM (
             SELECT reason,count(*)::int AS n FROM meta.view_migration_reject
              WHERE source_table=$1 AND resolved_at IS NULL GROUP BY reason
           ) x
       )
       SELECT COALESCE(c.snapshot_source_count,0)::text AS source_rows,
              migrated.n::text AS migrated_rows,rejected.n::text AS rejected_rows,
              (COALESCE(c.snapshot_source_count,0)-migrated.n-rejected.n)::text AS unaccounted_rows,
              COALESCE(c.snapshot_id,0)::text AS snapshot_id,
              c.snapshot_updated_at,c.completed_at IS NOT NULL AS completed,
              rejected.reasons AS reject_reasons
         FROM migrated CROSS JOIN rejected LEFT JOIN c ON true`,
      [table],
    );
    const row = result.rows[0]!;
    output.push({
      sourceTable: table,
      sourceRows: Number(row.source_rows),
      migratedRows: Number(row.migrated_rows),
      rejectedRows: Number(row.rejected_rows),
      unaccountedRows: Number(row.unaccounted_rows),
      rejectReasons: (row.reject_reasons ?? {}) as Partial<Record<ViewMigrationRejectReason, number>>,
      snapshotId: Number(row.snapshot_id),
      snapshotUpdatedAt:
        row.snapshot_updated_at === null
          ? null
          : row.snapshot_updated_at instanceof Date
            ? row.snapshot_updated_at.toISOString()
            : new Date(row.snapshot_updated_at).toISOString(),
      completed: row.completed,
    });
  }
  return output;
}

export async function assertViewMigrationSchema(db: PoolClient): Promise<void> {
  const result = await query<{ ready: boolean }>(
    db,
    'view_migration:schema_guard',
    `SELECT to_regclass('app.user_page_view') IS NOT NULL
         AND to_regclass('meta.view_migration_cursor') IS NOT NULL
         AND to_regclass('meta.view_migration_reject') IS NOT NULL
         AND EXISTS (
           SELECT 1 FROM information_schema.columns
            WHERE table_schema='app' AND table_name='page_view_event' AND column_name='v1_id'
         )
         AND EXISTS (
           SELECT 1 FROM information_schema.columns
            WHERE table_schema='app' AND table_name='user_pixel_event' AND column_name='v1_id'
         ) AS ready`,
  );
  if (!result.rows[0]?.ready) {
    throw new Error('浏览迁移 schema 未就绪：先应用 migrations/0041_view_event_migration.sql');
  }
}

/**
 * 同一入口的 full / incremental：full 固定一次快照；incremental 会完成未完 pass，随后
 * 继续捕获新 head，直到高水位稳定。会话级 advisory lock 防止两实例同时推进游标。
 */
export async function runViewMigration(
  source: Client,
  target: PoolClient,
  options: ViewMigrationRunOptions,
): Promise<ViewMigrationReconciliation[]> {
  if (!Number.isInteger(options.batchSize) || options.batchSize <= 0) {
    throw new TypeError(`batchSize 必须是正整数，收到 ${options.batchSize}`);
  }
  const tables = options.tables ?? VIEW_SOURCE_TABLES;
  const maxCatchupPasses = options.maxCatchupPasses ?? 20;
  const budget = { batches: 0 };
  await assertViewMigrationSchema(target);
  await query(
    target,
    'view_migration:advisory_lock',
    `SELECT pg_advisory_lock(hashtextextended('syncer2:view-migration',0))`,
  );
  try {
    for (const table of tables) {
      if (options.retryFailures !== false) {
        await retryOpenRejects(
          source,
          target,
          table,
          options.batchSize,
          options.retryLimit ?? 10_000,
          options.onBatch,
        );
      }
      let cursor = await loadViewMigrationCursor(target, table);
      const hadIncomplete = cursor !== null && cursor.completedAt === null;
      if (hadIncomplete) {
        const complete = await runPass(source, target, table, cursor!, options, budget);
        if (!complete) continue;
        cursor = await loadViewMigrationCursor(target, table);
      }
      if (options.mode === 'full') {
        const current = (await reconcileViewMigration(target, [table]))[0]!;
        if (cursor === null || current.unaccountedRows !== 0) {
          cursor = await initializePass(source, target, table, 'full', null);
          await runPass(source, target, table, cursor, options, budget);
        }
        continue;
      }

      // incremental：未完成 full 被续完后也会立刻再取一次 delta，而不是要求人工再跑一遍。
      for (let pass = 0; pass < maxCatchupPasses; pass++) {
        cursor = await loadViewMigrationCursor(target, table);
        const lowerId = cursor?.snapshotId ?? 0;
        const lowerUpdatedAt =
          table === 'UserPageView' ? (cursor?.snapshotUpdatedAt ?? EPOCH) : null;
        const head = await loadSnapshotHead(source, table, lowerId, lowerUpdatedAt);
        if (cursor !== null && sameHead(cursor, head) && !hadIncomplete) break;
        const next = await initializePass(source, target, table, 'incremental', cursor);
        const complete = await runPass(source, target, table, next, options, budget);
        if (!complete) break;
        const completed = (await loadViewMigrationCursor(target, table))!;
        const newest = await loadSnapshotHead(
          source,
          table,
          completed.snapshotId,
          table === 'UserPageView' ? completed.snapshotUpdatedAt : null,
        );
        if (sameHead(completed, newest)) break;
        if (pass === maxCatchupPasses - 1) {
          throw new Error(`${table} 连续 ${maxCatchupPasses} 个增量 pass 仍未追平，请冻结 v1 写入后重跑`);
        }
      }
    }
    return reconcileViewMigration(target, tables);
  } finally {
    await query(
      target,
      'view_migration:advisory_unlock',
      `SELECT pg_advisory_unlock(hashtextextended('syncer2:view-migration',0))`,
    ).catch(() => undefined);
  }
}
