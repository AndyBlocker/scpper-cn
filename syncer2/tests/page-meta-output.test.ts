/**
 * meta 完整产出契约回归：
 *   1. 仅注册身份（等价 L1 只有四字段、没有 title/tags）后，定向 meta 可补齐属性；
 *   2. meta=ok 但无属性行会进入 page_meta_output_gap，并由 oldest-pending 判为告警；
 *   3. standard 页远端明确空 title 投影为 ''，不重新折叠成未观测 NULL；
 *   4. 模板/系统页显式为 listpages_hidden，不进入真实内容缺口。
 *
 * 所有业务夹具都在单事务内 ROLLBACK，不向活库遗留测试页。
 */

process.env.TZ = 'Asia/Shanghai';
process.env.SYNCER2_LOG_LEVEL = 'error';

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool, PoolClient } from 'pg';

import type { ListPageRecord } from '../src/collect/listpages.js';
import {
  evaluatePendingCollection,
  pendingPolicyFor,
  type PendingCollection,
} from '../src/observability/oldestPending.js';
import { createPool, query } from '../src/store/db.js';
import { applyObservedListPageMeta } from '../src/work/identityCheck.js';
import { resolveTestDatabaseUrl } from './helpers/pg.js';

const STANDARD_WID = 2_109_990_731;
const HIDDEN_WID = 2_109_990_732;
const OBSERVED_AT = '2026-08-17T00:00:00.000Z';
const STANDARD_SLUG = 'meta-contract-page-2109990731';
const HIDDEN_SLUG = 'fragment:meta-contract-page-2109990732';

let pool: Pool;

before(() => {
  pool = createPool(resolveTestDatabaseUrl(), { max: 1 });
});

after(async () => {
  await pool?.end().catch(() => undefined);
});

async function rollbackFixture(fn: (client: PoolClient) => Promise<void>): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await fn(client);
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

async function registerPage(client: PoolClient, wikidotId: number, slug: string): Promise<number> {
  const row = await query<{ page_id: number }>(
    client,
    'test.page-meta-output:register',
    `SELECT ingest.register_page(
       $1::int, $2::text, $3::timestamptz, 'test_wikidot', NULL, $3::timestamptz, NULL
     ) AS page_id`,
    [wikidotId, slug, OBSERVED_AT],
  );
  return Number(row.rows[0]!.page_id);
}

async function createRun(client: PoolClient): Promise<number> {
  const row = await query<{ id: string }>(
    client,
    'test.page-meta-output:run',
    `INSERT INTO meta.ingest_run(source, status, started_at, finished_at, stats)
     VALUES ('test_syncer2', 'ok', $1::timestamptz, $1::timestamptz,
             '{"test":"page_meta_output"}'::jsonb)
     RETURNING id::text`,
    [OBSERVED_AT],
  );
  return Number(row.rows[0]!.id);
}

async function recordMetaOk(client: PoolClient, runId: number, pageId: number): Promise<void> {
  await query(
    client,
    'test.page-meta-output:record-ok',
    `SELECT meta.record_page_scan(
       $1::bigint, $2::int, 'meta', 'ok', 1, 1, true, NULL, NULL, NULL, NULL
     )`,
    [runId, pageId],
  );
}

function listPageRow(): ListPageRecord {
  return {
    fullname: STANDARD_SLUG,
    category: '_default',
    name: STANDARD_SLUG,
    title: '新建页完整标题',
    tags: ['原创', 'scp'],
    hiddenTags: ['_cc'],
    mergedTags: ['_cc', 'scp', '原创'],
    parentFullname: null,
    createdAt: OBSERVED_AT,
    createdBy: 'Test Author',
    createdById: null,
    createdByUnix: null,
    updatedAt: OBSERVED_AT,
    commentedAt: null,
    rating: 11,
    ratingVotes: 13,
    comments: 2,
    size: 1234,
    revisions: 3,
    total: 1,
    index: 1,
  };
}

describe('meta 完整属性产出契约', () => {
  it('L1 身份页可补 title/tags；伪绿被检测告警；系统页不误判', async () => {
    await rollbackFixture(async (client) => {
      const runId = await createRun(client);
      const pageId = await registerPage(client, STANDARD_WID, STANDARD_SLUG);

      const before = await query<{ title: string | null; attrs: string[] }>(
        client,
        'test.page-meta-output:before',
        `SELECT pc.title,
                COALESCE(array_agg(h.attr ORDER BY h.attr)
                  FILTER (WHERE h.attr IN ('title','tags')), ARRAY[]::text[]) AS attrs
           FROM serve.page_current pc
           LEFT JOIN ingest.page_attr_history h
             ON h.page_id=pc.page_id AND h.valid_to IS NULL AND h.source='observed'
          WHERE pc.page_id=$1
          GROUP BY pc.title`,
        [pageId],
      );
      assert.equal(before.rows[0]?.title, null);
      assert.deepEqual(before.rows[0]?.attrs, []);

      await recordMetaOk(client, runId, pageId);
      const gap = await query<{ missing_attrs: string[] }>(
        client,
        'test.page-meta-output:gap',
        `SELECT missing_attrs FROM meta.page_meta_output_gap WHERE page_id=$1`,
        [pageId],
      );
      assert.deepEqual(gap.rows[0]?.missing_attrs, ['title', 'tags']);

      const pending: PendingCollection = {
        collection: 'page_meta_output:missing_observed_attrs',
        family: 'page_scan_no_output',
        pendingCount: 1,
        oldestItemAt: OBSERVED_AT,
        oldestItemKey: String(pageId),
        catchup: false,
        evidence: { missing_title: 1, missing_tags: 1 },
        observedAt: '2026-08-18T03:00:00.000Z',
      };
      assert.equal(pendingPolicyFor(pending.collection, pending.family).warnAfterSeconds, 1800);
      assert.equal(evaluatePendingCollection(pending, []).severity, 'critical');

      const applied = await applyObservedListPageMeta(
        client,
        runId,
        pageId,
        STANDARD_WID,
        listPageRow(),
        OBSERVED_AT,
      );
      assert.equal(applied.output_verified, true);
      const afterApply = await query<{ title: string; tags: string[]; attr_count: string }>(
        client,
        'test.page-meta-output:after',
        `SELECT pc.title, pc.tags,
                count(*) FILTER (
                  WHERE h.attr IN ('title','tags') AND h.source='observed'
                )::text AS attr_count
           FROM serve.page_current pc
           JOIN ingest.page_attr_history h ON h.page_id=pc.page_id AND h.valid_to IS NULL
          WHERE pc.page_id=$1
          GROUP BY pc.title, pc.tags`,
        [pageId],
      );
      assert.equal(afterApply.rows[0]?.title, '新建页完整标题');
      // page_current.tags 是 visible + hidden 的既有合并口径；属性历史仍分别保存两者。
      assert.deepEqual(afterApply.rows[0]?.tags, ['_cc', 'scp', '原创']);
      assert.equal(Number(afterApply.rows[0]?.attr_count), 2);
      const resolved = await query<{ n: string }>(
        client,
        'test.page-meta-output:resolved',
        `SELECT count(*)::text AS n FROM meta.page_meta_output_gap WHERE page_id=$1`,
        [pageId],
      );
      assert.equal(Number(resolved.rows[0]?.n), 0);

      await applyObservedListPageMeta(
        client,
        runId,
        pageId,
        STANDARD_WID,
        { ...listPageRow(), title: '' },
        '2026-08-17T00:01:00.000Z',
      );
      const observedEmpty = await query<{ title: string | null; observed_title: string | null }>(
        client,
        'test.page-meta-output:observed-empty-title',
        `SELECT pc.title, h.value #>> '{}' AS observed_title
           FROM serve.page_current pc
           JOIN ingest.page_attr_history h
             ON h.page_id=pc.page_id
            AND h.attr='title'
            AND h.valid_to IS NULL
            AND h.source='observed'
          WHERE pc.page_id=$1`,
        [pageId],
      );
      assert.equal(observedEmpty.rows[0]?.observed_title, '');
      assert.equal(observedEmpty.rows[0]?.title, '');

      const hiddenPageId = await registerPage(client, HIDDEN_WID, HIDDEN_SLUG);
      await recordMetaOk(client, runId, hiddenPageId);
      const hidden = await query<{ enumeration_scope: string; gaps: string }>(
        client,
        'test.page-meta-output:hidden',
        `SELECT pc.enumeration_scope,
                count(g.page_id)::text AS gaps
           FROM serve.page_current pc
           LEFT JOIN meta.page_meta_output_gap g ON g.page_id=pc.page_id
          WHERE pc.page_id=$1
          GROUP BY pc.enumeration_scope`,
        [hiddenPageId],
      );
      assert.equal(hidden.rows[0]?.enumeration_scope, 'listpages_hidden');
      assert.equal(Number(hidden.rows[0]?.gaps), 0);
    });
  });
});
