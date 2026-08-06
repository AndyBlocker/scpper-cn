import assert from 'node:assert/strict';
import test from 'node:test';

import { loadEnv } from '../src/config.js';
import {
  applyViewMigrationBatch,
  assertV1ReadOnlyUrl,
  assertV1SessionReadOnly,
  classifyViewIdentity,
  createV1ReadOnlyClient,
  loadViewMigrationCursor,
  type PageViewSourceRow,
  type UserPageViewSourceRow,
} from '../src/migrate/viewEvents.js';
import { createPool } from '../src/store/db.js';
import { OBSERVED_ISO } from './helpers/fixture.js';
import { resolveTestDatabaseUrl } from './helpers/pg.js';

const TEST_PAGE_WID_OLD = 2_109_990_101;
const TEST_PAGE_WID_NEW = 2_109_990_102;
const TEST_PAGE_WID_MISSING = 2_109_990_103;
const TEST_USER_WID = 2_119_990_101;
const V1_EVENT_ID = 2_146_800_001;
const V1_REJECT_ID = 2_146_800_002;
const V1_UPV_ID_A = 2_146_800_101;
const V1_UPV_ID_B = 2_146_800_102;

function pageEvent(v1Id: number, v1PageId: number, wikidotId: number): PageViewSourceRow {
  return {
    v1_id: v1Id,
    v1_page_id: v1PageId,
    v1_page_exists: true,
    v1_page_wikidot_id: wikidotId,
    v1_user_id: null,
    v1_user_exists: null,
    v1_user_wikidot_id: null,
    source_updated_at: null,
    wikidot_id: wikidotId,
    client_hash: `test-hash-${v1Id}`,
    client_ip: '192.0.2.1',
    user_agent: 'syncer2-view-migration-test',
    component: 'test',
    source: 'test',
    referer_host: 'example.invalid',
    created_at: '2026-08-01T01:02:03.456000Z',
    accept_language: 'zh-CN',
    ua_platform: 'test',
    ua_brand_major: 'test/1',
    ua_family: 'test',
    softprint: 'softprint-test',
    visitor_token: 'visitor-test',
    tls_fingerprint: 'tls-test',
  };
}

function userPageView(
  v1Id: number,
  v1PageId: number,
  pageWikidotId: number,
  v1UserId: number,
  viewCount: number,
  updatedAt: string,
): UserPageViewSourceRow {
  return {
    v1_id: v1Id,
    v1_page_id: v1PageId,
    v1_page_exists: true,
    v1_page_wikidot_id: pageWikidotId,
    v1_user_id: v1UserId,
    v1_user_exists: true,
    v1_user_wikidot_id: TEST_USER_WID,
    source_updated_at: updatedAt,
    wikidot_id: TEST_USER_WID,
    first_viewed_at: '2026-07-01T00:00:00.000000Z',
    last_viewed_at: '2026-08-01T00:00:00.000000Z',
    view_count: viewCount,
    updated_at: updatedAt,
  };
}

test('映射分类保留缺失/多候选，并只把唯一 wikidotId 候选判为成功', () => {
  const source = pageEvent(1, 99, 123);
  const exact = classifyViewIdentity('PageViewEvent', source, [7001], []);
  assert.equal(exact.reason, null);
  assert.equal(exact.mappedPageId, 7001);

  const missing = classifyViewIdentity('PageViewEvent', source, [], []);
  assert.equal(missing.reason, 'v2_page_not_found');
  assert.deepEqual(missing.allReasons, ['v2_page_not_found']);

  const ambiguous = classifyViewIdentity('PageViewEvent', source, [7001, 7002], []);
  assert.equal(ambiguous.reason, 'v2_page_ambiguous');
  assert.deepEqual(ambiguous.pageCandidates, [7001, 7002]);
});

test('UserPageView 游标从 PostgreSQL 读回时保留微秒，不把共享上界截成毫秒', async () => {
  const pool = createPool(resolveTestDatabaseUrl(), { max: 1 });
  const db = await pool.connect();
  await db.query('BEGIN');
  try {
    await db.query(
      `INSERT INTO meta.view_migration_cursor(
         source_table,mode,cursor_kind,start_after_id,last_id,snapshot_id,
         start_after_updated_at,last_updated_at,snapshot_updated_at,
         snapshot_source_count,pass_count,completed_at
       ) VALUES (
         'UserPageView','full','updated_at_id',0,0,74613,
         '1970-01-01T00:00:00.000000Z'::timestamptz,
         '1970-01-01T00:00:00.000000Z'::timestamptz,
         '2026-06-10T15:56:26.104893Z'::timestamptz,74613,74613,now()
       )
       ON CONFLICT (source_table) DO UPDATE SET
         cursor_kind=EXCLUDED.cursor_kind,start_after_id=EXCLUDED.start_after_id,
         last_id=EXCLUDED.last_id,snapshot_id=EXCLUDED.snapshot_id,
         start_after_updated_at=EXCLUDED.start_after_updated_at,
         last_updated_at=EXCLUDED.last_updated_at,
         snapshot_updated_at=EXCLUDED.snapshot_updated_at`,
    );
    const cursor = await loadViewMigrationCursor(db, 'UserPageView');
    assert.equal(cursor?.snapshotUpdatedAt, '2026-06-10T15:56:26.104893Z');
  } finally {
    await db.query('ROLLBACK').catch(() => undefined);
    db.release();
    await pool.end();
  }
});

test('批次重放幂等、slug 多代按 wikidotId 精确命中、失败显式落审计', async () => {
  const pool = createPool(resolveTestDatabaseUrl(), { max: 1 });
  const db = await pool.connect();
  await db.query('BEGIN');
  try {
    const slug = 'ts2test:view-migration-reused-slug';
    const oldPage = Number(
      (
        await db.query<{ id: number }>(
          `SELECT ingest.register_page($1,$2,$3::timestamptz,'test_view_migration',NULL,$3::timestamptz,NULL) AS id`,
          [TEST_PAGE_WID_OLD, slug, OBSERVED_ISO],
        )
      ).rows[0]!.id,
    );
    const newPage = Number(
      (
        await db.query<{ id: number }>(
          `SELECT ingest.register_page($1,$2,$3::timestamptz,'test_view_migration',NULL,$3::timestamptz,NULL) AS id`,
          [TEST_PAGE_WID_NEW, slug, OBSERVED_ISO],
        )
      ).rows[0]!.id,
    );
    assert.notEqual(oldPage, newPage);
    const generations = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM serve.page_current WHERE slug=$1`,
      [slug],
    );
    assert.equal(Number(generations.rows[0]!.n), 2, '固件必须真的包含同 slug 两代身份');

    const event = pageEvent(V1_EVENT_ID, 80_001, TEST_PAGE_WID_NEW);
    const first = await applyViewMigrationBatch(db, 'PageViewEvent', [event]);
    const fingerprintBefore = await db.query<{ n: string; fingerprint: string }>(
      `SELECT count(*)::text AS n,
              md5(string_agg((to_jsonb(e)-'id')::text,E'\\n' ORDER BY v1_id)) AS fingerprint
         FROM app.page_view_event e WHERE v1_id=$1`,
      [V1_EVENT_ID],
    );
    const replay = await applyViewMigrationBatch(db, 'PageViewEvent', [event]);
    const fingerprintAfter = await db.query<{ n: string; fingerprint: string }>(
      `SELECT count(*)::text AS n,
              md5(string_agg((to_jsonb(e)-'id')::text,E'\\n' ORDER BY v1_id)) AS fingerprint
         FROM app.page_view_event e WHERE v1_id=$1`,
      [V1_EVENT_ID],
    );
    assert.equal(first.insertedOrUpdated, 1);
    assert.equal(replay.insertedOrUpdated, 0);
    assert.deepEqual(fingerprintAfter.rows[0], fingerprintBefore.rows[0]);
    assert.equal(Number(fingerprintAfter.rows[0]!.n), 1);
    const mappedPage = await db.query<{ page_id: number }>(
      `SELECT page_id FROM app.page_view_event WHERE v1_id=$1`,
      [V1_EVENT_ID],
    );
    assert.equal(Number(mappedPage.rows[0]!.page_id), newPage, '不能按复用 slug 命中旧代');

    const rejectedSource = pageEvent(V1_REJECT_ID, 80_002, TEST_PAGE_WID_MISSING);
    const rejected = await applyViewMigrationBatch(db, 'PageViewEvent', [rejectedSource]);
    assert.equal(rejected.mapped, 0);
    assert.equal(rejected.rejectReasons.v2_page_not_found, 1);
    const audit = await db.query<{ reason: string; resolved_at: Date | null }>(
      `SELECT reason,resolved_at FROM meta.view_migration_reject
        WHERE source_table='PageViewEvent' AND v1_id=$1`,
      [V1_REJECT_ID],
    );
    assert.equal(audit.rows[0]!.reason, 'v2_page_not_found');
    assert.equal(audit.rows[0]!.resolved_at, null);
    assert.equal(
      Number(
        (
          await db.query<{ n: string }>(
            `SELECT count(*)::text AS n FROM app.page_view_event WHERE v1_id=$1`,
            [V1_REJECT_ID],
          )
        ).rows[0]!.n,
      ),
      0,
      '失败行不能静默落成猜测目标',
    );

    const recoveredPage = Number(
      (
        await db.query<{ id: number }>(
          `SELECT ingest.register_page($1,$2,$3::timestamptz,'test_view_migration',NULL,$3::timestamptz,NULL) AS id`,
          [TEST_PAGE_WID_MISSING, 'ts2test:view-migration-recovered', OBSERVED_ISO],
        )
      ).rows[0]!.id,
    );
    const recovered = await applyViewMigrationBatch(db, 'PageViewEvent', [rejectedSource]);
    assert.equal(recovered.mapped, 1);
    const resolved = await db.query<{ page_id: number; resolved: boolean }>(
      `SELECT e.page_id,r.resolved_at IS NOT NULL AS resolved
         FROM app.page_view_event e
         JOIN meta.view_migration_reject r
           ON r.source_table='PageViewEvent' AND r.v1_id=e.v1_id
        WHERE e.v1_id=$1`,
      [V1_REJECT_ID],
    );
    assert.equal(Number(resolved.rows[0]!.page_id), recoveredPage);
    assert.equal(resolved.rows[0]!.resolved, true);
  } finally {
    await db.query('ROLLBACK').catch(() => undefined);
    db.release();
    await pool.end();
  }
});

test('UserPageView 先半量再增量（含旧行更新）与一次性全迁内容一致', async () => {
  const pool = createPool(resolveTestDatabaseUrl(), { max: 1 });
  const db = await pool.connect();
  await db.query('BEGIN');
  try {
    const pageA = Number(
      (
        await db.query<{ id: number }>(
          `SELECT ingest.register_page($1,$2,$3::timestamptz,'test_view_migration',NULL,$3::timestamptz,NULL) AS id`,
          [TEST_PAGE_WID_OLD, 'ts2test:view-migration-upv-a', OBSERVED_ISO],
        )
      ).rows[0]!.id,
    );
    const pageB = Number(
      (
        await db.query<{ id: number }>(
          `SELECT ingest.register_page($1,$2,$3::timestamptz,'test_view_migration',NULL,$3::timestamptz,NULL) AS id`,
          [TEST_PAGE_WID_NEW, 'ts2test:view-migration-upv-b', OBSERVED_ISO],
        )
      ).rows[0]!.id,
    );
    const user = Number(
      (
        await db.query<{ id: number }>(
          `SELECT ingest.ensure_user('wikidot',$1,NULL,'test view migration user',NULL,NULL,NULL) AS id`,
          [TEST_USER_WID],
        )
      ).rows[0]!.id,
    );
    const finalA = userPageView(
      V1_UPV_ID_A,
      90_001,
      TEST_PAGE_WID_OLD,
      91_001,
      7,
      '2026-08-02T03:04:05.600000Z',
    );
    const oldA = { ...finalA, view_count: 2, updated_at: '2026-08-01T03:04:05.600000Z', source_updated_at: '2026-08-01T03:04:05.600000Z' };
    const finalB = userPageView(
      V1_UPV_ID_B,
      90_002,
      TEST_PAGE_WID_NEW,
      91_001,
      3,
      '2026-08-02T04:05:06.700000Z',
    );

    const fingerprint = async (): Promise<string> => {
      const result = await db.query<{ fingerprint: string }>(
        `SELECT md5(string_agg(
                  (to_jsonb(v)-'id')::text,E'\\n' ORDER BY v1_id
                )) AS fingerprint
           FROM app.user_page_view v WHERE v1_id=ANY($1::bigint[])`,
        [[V1_UPV_ID_A, V1_UPV_ID_B]],
      );
      return result.rows[0]!.fingerprint;
    };

    await db.query('SAVEPOINT one_shot');
    await applyViewMigrationBatch(db, 'UserPageView', [finalA, finalB]);
    const oneShot = await fingerprint();
    await db.query('ROLLBACK TO SAVEPOINT one_shot');

    await applyViewMigrationBatch(db, 'UserPageView', [oldA]);
    await applyViewMigrationBatch(db, 'UserPageView', [finalA, finalB]);
    const caughtUp = await fingerprint();
    assert.equal(caughtUp, oneShot);
    const mapped = await db.query<{ v1_id: string; user_id: number; page_id: number; view_count: number }>(
      `SELECT v1_id::text,user_id,page_id,view_count FROM app.user_page_view
        WHERE v1_id=ANY($1::bigint[]) ORDER BY v1_id`,
      [[V1_UPV_ID_A, V1_UPV_ID_B]],
    );
    assert.deepEqual(
      mapped.rows.map((row) => ({ ...row, user_id: Number(row.user_id), page_id: Number(row.page_id) })),
      [
        { v1_id: String(V1_UPV_ID_A), user_id: user, page_id: pageA, view_count: 7 },
        { v1_id: String(V1_UPV_ID_B), user_id: user, page_id: pageB, view_count: 3 },
      ],
    );
  } finally {
    await db.query('ROLLBACK').catch(() => undefined);
    db.release();
    await pool.end();
  }
});

test('v1 连接串与服务端事务均强制只读，写语句由 PostgreSQL 以 25006 拒绝', async () => {
  loadEnv();
  const url = process.env.SYNCER2_V1_DATABASE_URL;
  assert.ok(url, '测试需要 SYNCER2_V1_DATABASE_URL');
  assertV1ReadOnlyUrl(url);
  const parsed = new URL(url);
  parsed.searchParams.delete('options');
  assert.throws(() => assertV1ReadOnlyUrl(parsed.toString()), /必须保留/);

  const client = createV1ReadOnlyClient(url);
  await client.connect();
  try {
    await assertV1SessionReadOnly(client);
    await assert.rejects(
      client.query(`CREATE TEMP TABLE syncer2_view_migration_write_probe(id int)`),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, '25006');
        return true;
      },
    );
  } finally {
    await client.end();
  }
});
