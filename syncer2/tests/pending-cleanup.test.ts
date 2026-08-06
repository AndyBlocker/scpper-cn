process.env.SYNCER2_LOG_LEVEL = 'error';

import assert from 'node:assert/strict';
import { after, before, describe, it, test } from 'node:test';
import type { Pool, PoolClient } from 'pg';

import { createPool } from '../src/store/db.js';
import {
  identityConflictResolution,
  pendingFailureResolution,
  resolveRestrictedPendingPage,
  restrictedLegacySlug,
  waitingForRestrictedEvidence,
} from '../src/work/pendingPage.js';
import {
  assertNoSyntheticServeIngestWrite,
  resolveTestDatabaseUrl,
  SyntheticTestWriteError,
} from './helpers/pg.js';

test('pending 失败/等待/冲突都有下一次动作，不会冻结在 attempts=1', () => {
  const now = Date.parse('2026-08-06T00:00:00Z');
  const retry = pendingFailureResolution('retry-me', 1, 'transport', null, now);
  assert.equal(retry.status, 'retry');
  assert.ok(Date.parse(retry.notBefore!) > now);

  const exhausted = pendingFailureResolution('review-me', 4, 'parse', 200, now);
  assert.equal(exhausted.status, 'irreconcilable');
  assert.ok(Date.parse(exhausted.notBefore!) > now);

  const waiting = waitingForRestrictedEvidence('adult:new-page', now);
  assert.equal(waiting.status, 'waiting_evidence');
  assert.ok(Date.parse(waiting.notBefore!) > now);

  const conflict = identityConflictResolution(
    { slug: 'requested', attempts: 1 },
    'redirect-target',
    123,
    200,
    now,
  );
  assert.equal(conflict.status, 'conflict');
  assert.ok(Date.parse(conflict.notBefore!) > now);
});

test('受限 fullname 到 v1 历史 URL 的映射精确且不扩散到普通分类', () => {
  assert.equal(restrictedLegacySlug('adult:foo'), 'foo');
  assert.equal(restrictedLegacySlug('wanderers-adult:foo'), 'wanderers:foo');
  assert.equal(restrictedLegacySlug('scp-cn-173'), null);
});

test('测试 pg 客户端按合成特征拒绝 serve/ingest 写入，不按 test- 前缀误伤', () => {
  assert.throws(
    () => assertNoSyntheticServeIngestWrite(
      `SELECT ingest.register_page($1,$2,now(),'test')`,
      [800099999, 'test-image-page-1760000000000'],
    ),
    SyntheticTestWriteError,
  );
  assert.doesNotThrow(() => assertNoSyntheticServeIngestWrite(
    `SELECT ingest.register_page($1,$2,now(),'test')`,
    [1312422282, 'test-log-046-de-03'],
  ));
});

describe('pending 收敛与生产写入门（事务回滚）', () => {
  let pool: Pool;
  let client: PoolClient;

  before(async () => {
    pool = createPool(resolveTestDatabaseUrl(), { max: 1 });
    client = await pool.connect();
    await client.query('BEGIN');
  });

  after(async () => {
    await client?.query('ROLLBACK').catch(() => undefined);
    client?.release();
    await pool?.end().catch(() => undefined);
  });

  it('新 adult 受限页用 ListPages + v1 只读候选自动铸身份并 resolved', async () => {
    const slug = 'adult:pendclean-restricted-fixture';
    const wikidotId = 2_109_998_001;
    await client.query(
      `INSERT INTO meta.pending_page(slug,reasons,discovered_by,status)
       VALUES ($1,$2,'wikidot','pending')`,
      [slug, ['listpages_new_fullname', 'listpages_fullname_without_identity']],
    );
    const result = await resolveRestrictedPendingPage(
      client,
      {
        slug,
        attempts: 1,
        seenCount: 1,
        reasons: ['listpages_new_fullname', 'listpages_fullname_without_identity'],
        discoveredBy: 'wikidot',
        wikidotId: null,
        observedSlug: null,
      },
      {
        v1PageId: 123_456,
        wikidotId,
        legacySlug: 'pendclean-restricted-fixture',
        sourceUrl: 'http://scp-wiki-cn.wikidot.com/pendclean-restricted-fixture',
      },
      '2026-08-06T00:00:00.000Z',
      null,
    );
    assert.equal(result.newlyRegistered, true);
    const state = await client.query<{
      status: string;
      page_id: number;
      resolution_source: string;
      finished: boolean;
    }>(
      `SELECT status,page_id,resolution_source,finished_at IS NOT NULL AS finished
         FROM meta.pending_page WHERE slug=$1`,
      [slug],
    );
    assert.deepEqual(state.rows[0], {
      status: 'resolved',
      page_id: result.pageId,
      resolution_source: 'restricted_listpages_v1_reuse',
      finished: true,
    });
  });

  it('数据库门拒绝合成页/用户，真实 test-* 页仍可带修订存在', async () => {
    await client.query('SAVEPOINT synthetic_page');
    await assert.rejects(
      client.query(
        `SELECT ingest.register_page($1,$2,now(),'test_pending_cleanup')`,
        [2_109_998_002, 'test-image-page-1760000000001'],
      ),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, 'P2T01');
        return true;
      },
    );
    await client.query('ROLLBACK TO SAVEPOINT synthetic_page');

    await client.query('SAVEPOINT synthetic_user');
    await assert.rejects(
      client.query(
        `SELECT ingest.ensure_user('synthetic',NULL,$1,$2,NULL,NULL,NULL)`,
        ['test-image-user-1760000000001', 'test-image-user-1760000000001'],
      ),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, 'P2T01');
        return true;
      },
    );
    await client.query('ROLLBACK TO SAVEPOINT synthetic_user');

    const real = await client.query<{ rating: number; revision_count: number }>(
      `SELECT rating,revision_count FROM serve.page_current
        WHERE slug='test-log-046-de-03'`,
    );
    assert.equal(real.rows.length, 1);
    assert.ok(Number(real.rows[0]!.revision_count) > 0);
  });
});

test('存量三类已到语义终态，生产合成页已清零', async () => {
  const pool = createPool(resolveTestDatabaseUrl(), { max: 1 });
  try {
    const result = await pool.query<{
      old_states: string;
      restricted_resolved: string;
      gone_finished: string;
      gone_total: string;
      synthetic_pages: string;
    }>(
      `SELECT
         (SELECT count(*) FROM meta.pending_page WHERE status IN ('failed','mismatch'))::text
           AS old_states,
         (SELECT count(*) FROM meta.pending_page
           WHERE status='resolved'
             AND resolution_source='restricted_listpages_v1_reuse')::text
           AS restricted_resolved,
         (SELECT count(*) FROM meta.pending_page
           WHERE status='gone' AND finished_at IS NOT NULL)::text AS gone_finished,
         (SELECT count(*) FROM meta.pending_page WHERE status='gone')::text AS gone_total,
         (SELECT count(*) FROM serve.page_current pc
           WHERE meta.is_synthetic_test_page(pc.wikidot_id,pc.slug))::text AS synthetic_pages`,
    );
    const row = result.rows[0]!;
    assert.equal(row.old_states, '0');
    assert.ok(Number(row.restricted_resolved) >= 138);
    assert.equal(row.gone_finished, row.gone_total);
    assert.equal(row.synthetic_pages, '0');
  } finally {
    await pool.end();
  }
});
