/**
 * 页面父子关系回归：历史 fullname 补解、SCD2 reparent、deleted 父页保留、
 * 直接/递归读取、深度上限与写时防环。
 *
 * 普通夹具单事务 ROLLBACK；并发用例提交两会话后按保留 wid 精确清理。只允许连接 scpper-v2。
 */

process.env.TZ = 'Asia/Shanghai';
process.env.SYNCER2_LOG_LEVEL = 'error';

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool, PoolClient } from 'pg';

import { loadConfig } from '../src/config.js';
import {
  chooseParentPageId,
  resolveParentFullnames,
} from '../src/collect/parent.js';
import { createPool, query } from '../src/store/db.js';

let pool: Pool;

before(() => {
  const config = loadConfig();
  assert.equal(
    decodeURIComponent(new URL(config.databaseUrl).pathname.slice(1)),
    'scpper-v2',
    '层级测试只允许写 scpper-v2；主库 scpper-cn 只读',
  );
  pool = createPool(config.databaseUrl, { max: 3 });
});

after(async () => {
  await pool?.end().catch(() => undefined);
});

async function rollbackFixture(fn: (client: PoolClient) => Promise<void>): Promise<void> {
  const client = await pool.connect();
  await client.query('BEGIN');
  try {
    await fn(client);
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

async function registerPage(
  client: PoolClient,
  wikidotId: number,
  slug: string,
): Promise<number> {
  const result = await query<{ page_id: number }>(
    client,
    'hierarchy:test:register_page',
    `SELECT ingest.register_page(
              p_wikidot_id => $1,
              p_slug       => $2,
              p_observed   => '2026-07-29T04:00:00.000Z'::timestamptz,
              p_source     => 'test_wikidot'
            ) AS page_id`,
    [wikidotId, slug],
  );
  return Number(result.rows[0]!.page_id);
}

async function applyMeta(
  client: PoolClient,
  pageId: number,
  wikidotId: number,
  attrs: Record<string, unknown>,
  observedAt: string,
): Promise<void> {
  await query(
    client,
    'hierarchy:test:apply_page_meta',
    `SELECT ingest.apply_page_meta(
              p_page       => $1,
              p_attrs      => $2::jsonb,
              p_observed   => $3::timestamptz,
              p_source     => 'test_wikidot',
              p_run        => NULL,
              p_wikidot_id => $4
            )`,
    [pageId, JSON.stringify(attrs), observedAt, wikidotId],
  );
}

async function expectPgError(
  client: PoolClient,
  label: string,
  sql: string,
  params: readonly unknown[],
  expectedCode: string,
): Promise<void> {
  await client.query(`SAVEPOINT ${label}`);
  try {
    await query(client, label, sql, params);
    assert.fail(`${label} 本应抛 ${expectedCode}`);
  } catch (err) {
    assert.equal((err as { code?: string }).code, expectedCode);
    await client.query(`ROLLBACK TO SAVEPOINT ${label}`);
  }
}

const CONCURRENT_WIDS = [2_106_100_101, 2_106_100_102] as const;

async function cleanupConcurrentFixture(client: PoolClient): Promise<void> {
  await client.query('BEGIN');
  try {
    await client.query(`SET LOCAL scpper.bypass_guard = 'on'`);
    await client.query(
      `UPDATE serve.page_current
          SET parent_page_id = NULL
        WHERE page_id IN (
          SELECT id FROM ingest.page WHERE wikidot_id = ANY($1::int[])
        )`,
      [CONCURRENT_WIDS],
    );
    await client.query(
      `DELETE FROM ingest.page_attr_history
        WHERE page_id IN (SELECT id FROM ingest.page WHERE wikidot_id = ANY($1::int[]))`,
      [CONCURRENT_WIDS],
    );
    await client.query(
      `DELETE FROM ingest.page_life_event
        WHERE page_id IN (SELECT id FROM ingest.page WHERE wikidot_id = ANY($1::int[]))`,
      [CONCURRENT_WIDS],
    );
    await client.query(
      `DELETE FROM ingest.page_slug_history
        WHERE page_id IN (SELECT id FROM ingest.page WHERE wikidot_id = ANY($1::int[]))`,
      [CONCURRENT_WIDS],
    );
    await client.query(
      `DELETE FROM serve.page_current
        WHERE page_id IN (SELECT id FROM ingest.page WHERE wikidot_id = ANY($1::int[]))`,
      [CONCURRENT_WIDS],
    );
    await client.query(
      `DELETE FROM ingest.page WHERE wikidot_id = ANY($1::int[])`,
      [CONCURRENT_WIDS],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  }
}

describe('serve 页面层级', () => {
  it('可反查/递归，reparent 记 SCD2，deleted 父页保留，并拒绝新环', async () => {
    await rollbackFixture(async (client) => {
      const rootWid = 2_106_100_001;
      const childWid = 2_106_100_002;
      const grandWid = 2_106_100_003;
      const spareWid = 2_106_100_004;
      const ambiguousPeerWid = 2_106_100_005;
      const root = await registerPage(client, rootWid, 'ts2test:hierarchy-old-root');
      const child = await registerPage(client, childWid, 'ts2test:hierarchy-child');
      const grand = await registerPage(client, grandWid, 'ts2test:hierarchy-grandchild');
      const spare = await registerPage(client, spareWid, 'ts2test:hierarchy-ambiguous-old');
      const ambiguousPeer = await registerPage(
        client,
        ambiguousPeerWid,
        'ts2test:hierarchy-ambiguous-old',
      );

      // live + deleted 同名时首次解析必须唯一选 live；已建立关系的同 fullname 重观测
      // 则保留 deleted tombstone ID，不能仅凭 slug 复用擅自 reparent。
      await query(
        client,
        'hierarchy:test:delete_duplicate_slug',
        `SELECT ingest.apply_page_life(
                  p_page       => $1,
                  p_kind       => 'deleted',
                  p_occurred   => '2026-07-29T04:05:00.000Z'::timestamptz,
                  p_precision  => 'exact',
                  p_observed   => '2026-07-29T04:05:00.000Z'::timestamptz,
                  p_source     => 'operator',
                  p_run        => NULL,
                  p_wikidot_id => $2
                )`,
        [spare, spareWid],
      );
      const currentDuplicate = await resolveParentFullnames(
        client,
        ['ts2test:hierarchy-ambiguous-old'],
      );
      assert.equal(currentDuplicate.map.get('ts2test:hierarchy-ambiguous-old'), ambiguousPeer);
      assert.equal(currentDuplicate.resolvedCurrent, 1);
      assert.equal(
        chooseParentPageId(
          'ts2test:hierarchy-ambiguous-old',
          ambiguousPeer,
          { pageId: spare, fullname: 'ts2test:hierarchy-ambiguous-old' },
        ),
        spare,
      );

      // 父页改名后，子页仍可能返回旧 parent_fullname；唯一历史 slug 必须能补解。
      await applyMeta(
        client,
        root,
        rootWid,
        { slug: 'ts2test:hierarchy-new-root' },
        '2026-07-29T04:10:00.000Z',
      );
      await applyMeta(
        client,
        spare,
        spareWid,
        { slug: 'ts2test:hierarchy-spare' },
        '2026-07-29T04:11:00.000Z',
      );
      await applyMeta(
        client,
        ambiguousPeer,
        ambiguousPeerWid,
        { slug: 'ts2test:hierarchy-ambiguous-peer' },
        '2026-07-29T04:12:00.000Z',
      );
      const historical = await resolveParentFullnames(
        client,
        [
          'ts2test:hierarchy-old-root',
          'ts2test:not-registered',
          'ts2test:hierarchy-ambiguous-old',
        ],
      );
      assert.equal(historical.map.get('ts2test:hierarchy-old-root'), root);
      assert.equal(historical.resolvedHistoricalUnique, 1);
      assert.deepEqual(historical.unresolved, [
        'ts2test:not-registered',
        'ts2test:hierarchy-ambiguous-old',
      ]);

      await applyMeta(
        client,
        child,
        childWid,
        { parent: { page_id: root, slug: 'ts2test:hierarchy-old-root' } },
        '2026-07-29T04:20:00.000Z',
      );
      await applyMeta(
        client,
        grand,
        grandWid,
        { parent: { page_id: child, slug: 'ts2test:hierarchy-child' } },
        '2026-07-29T04:30:00.000Z',
      );

      const children = await query<{ page_id: number }>(
        client,
        'hierarchy:test:children',
        `SELECT page_id FROM serve.page_children($1, true)`,
        [root],
      );
      assert.deepEqual(children.rows.map((row) => Number(row.page_id)), [child]);

      const subtree = await query<{
        page_id: number;
        depth: number;
        is_cycle: boolean;
        depth_limited: boolean;
      }>(
        client,
        'hierarchy:test:subtree',
        `SELECT page_id, depth, is_cycle, depth_limited
           FROM serve.page_subtree($1, 64, true)
          ORDER BY depth, page_id`,
        [root],
      );
      assert.deepEqual(
        subtree.rows.map((row) => [Number(row.page_id), row.depth, row.is_cycle]),
        [
          [root, 0, false],
          [child, 1, false],
          [grand, 2, false],
        ],
      );

      const limited = await query<{
        page_id: number;
        depth: number;
        depth_limited: boolean;
      }>(
        client,
        'hierarchy:test:depth_limit',
        `SELECT page_id, depth, depth_limited
           FROM serve.page_subtree($1, 1, true)
          ORDER BY depth, page_id`,
        [root],
      );
      assert.deepEqual(
        limited.rows.map((row) => [
          Number(row.page_id),
          row.depth,
          row.depth_limited,
        ]),
        [
          [root, 0, false],
          [child, 1, true],
        ],
      );

      // grand: child → root，必须正常关旧开新，而不是原地覆盖 parent 历史。
      await applyMeta(
        client,
        grand,
        grandWid,
        { parent: { page_id: root, slug: 'ts2test:hierarchy-new-root' } },
        '2026-07-29T04:40:00.000Z',
      );
      const history = await query<{ intervals: string; closed: string; current_parent: number }>(
        client,
        'hierarchy:test:parent_history',
        `SELECT count(*)::text AS intervals,
                count(*) FILTER (WHERE valid_to IS NOT NULL)::text AS closed,
                (
                  SELECT parent_page_id
                    FROM serve.page_current
                   WHERE page_id = $1
                ) AS current_parent
           FROM ingest.page_attr_history
          WHERE page_id = $1 AND attr = 'parent'`,
        [grand],
      );
      assert.deepEqual(
        [
          Number(history.rows[0]!.intervals),
          Number(history.rows[0]!.closed),
          Number(history.rows[0]!.current_parent),
        ],
        [2, 1, root],
      );

      // 有父 → 无父同样是一个显式 attr 变化：关闭旧区间、开启 JSON null 当前区间。
      await applyMeta(
        client,
        grand,
        grandWid,
        { parent: null },
        '2026-07-29T04:41:00.000Z',
      );
      const detached = await query<{
        intervals: string;
        closed: string;
        current_parent: number | null;
        current_value: unknown;
      }>(
        client,
        'hierarchy:test:parent_detached_history',
        `SELECT count(*)::text AS intervals,
                count(*) FILTER (WHERE valid_to IS NOT NULL)::text AS closed,
                (
                  SELECT parent_page_id
                    FROM serve.page_current
                   WHERE page_id = $1
                ) AS current_parent,
                (
                  SELECT value
                    FROM ingest.page_attr_history
                   WHERE page_id = $1
                     AND attr = 'parent'
                     AND valid_to IS NULL
                ) AS current_value
           FROM ingest.page_attr_history
          WHERE page_id = $1 AND attr = 'parent'`,
        [grand],
      );
      assert.deepEqual(
        [
          Number(detached.rows[0]!.intervals),
          Number(detached.rows[0]!.closed),
          detached.rows[0]!.current_parent,
          detached.rows[0]!.current_value,
        ],
        [3, 2, null, null],
      );
      await applyMeta(
        client,
        grand,
        grandWid,
        { parent: { page_id: root, slug: 'ts2test:hierarchy-new-root' } },
        '2026-07-29T04:42:00.000Z',
      );

      // 同一事务 root→spare→NULL，随后 spare→root 的最终图无环。deferred 队列里的
      // root→spare 已是中间态，提交前复核必须跳过它，不能误报旧事件构成的假环。
      await client.query(
        `UPDATE serve.page_current SET parent_page_id = $2 WHERE page_id = $1`,
        [root, spare],
      );
      await client.query(
        `UPDATE serve.page_current SET parent_page_id = NULL WHERE page_id = $1`,
        [root],
      );
      await client.query(
        `UPDATE serve.page_current SET parent_page_id = $2 WHERE page_id = $1`,
        [spare, root],
      );
      await client.query(`SET CONSTRAINTS ALL IMMEDIATE`);
      await client.query(`SET CONSTRAINTS ALL DEFERRED`);
      await client.query(
        `UPDATE serve.page_current SET parent_page_id = NULL WHERE page_id = $1`,
        [spare],
      );

      // 父页删除只翻 status；两条 child→root 边都必须保留。
      await query(
        client,
        'hierarchy:test:delete_parent',
        `SELECT ingest.apply_page_life(
                  p_page       => $1,
                  p_kind       => 'deleted',
                  p_occurred   => '2026-07-29T04:50:00.000Z'::timestamptz,
                  p_precision  => 'exact',
                  p_observed   => '2026-07-29T04:50:00.000Z'::timestamptz,
                  p_source     => 'operator',
                  p_run        => NULL,
                  p_wikidot_id => $2
                )`,
        [root, rootWid],
      );
      const retained = await query<{ n: string }>(
        client,
        'hierarchy:test:deleted_parent_retained',
        `SELECT count(*)::text AS n
           FROM serve.page_current
          WHERE page_id = ANY($1::int[]) AND parent_page_id = $2`,
        [[child, grand], root],
      );
      assert.equal(Number(retained.rows[0]!.n), 2);

      // include_deleted=false 过滤 deleted root 的输出，但仍穿过它返回 live 后代。
      const liveOnly = await query<{ page_id: number }>(
        client,
        'hierarchy:test:live_only',
        `SELECT page_id FROM serve.page_subtree($1, 64, false) ORDER BY page_id`,
        [root],
      );
      assert.deepEqual(
        liveOnly.rows.map((row) => Number(row.page_id)),
        [child, grand].sort((a, b) => a - b),
      );

      await expectPgError(
        client,
        'sp_self_parent',
        `UPDATE serve.page_current SET parent_page_id = $1 WHERE page_id = $1`,
        [spare],
        '23514',
      );
      await expectPgError(
        client,
        'sp_cycle_parent',
        `UPDATE serve.page_current SET parent_page_id = $2 WHERE page_id = $1`,
        [root, child],
        '23514',
      );
      await expectPgError(
        client,
        'sp_bad_depth',
        `SELECT * FROM serve.page_subtree($1, 1001, true)`,
        [root],
        '22023',
      );

      // 逃生舱只用于构造存量脏数据回归：递归必须标环并有限停止。
      await client.query(`SET LOCAL scpper.bypass_guard = 'on'`);
      await client.query(
        `UPDATE serve.page_current SET parent_page_id = $2 WHERE page_id = $1`,
        [root, child],
      );
      await client.query(`SET LOCAL scpper.bypass_guard = 'off'`);
      const cyclic = await query<{ page_id: number; depth: number; is_cycle: boolean }>(
        client,
        'hierarchy:test:cycle_safe',
        `SELECT page_id, depth, is_cycle
           FROM serve.page_subtree($1, 64, true)
          ORDER BY depth`,
        [root],
      );
      assert.equal(cyclic.rows.length, 4);
      assert.deepEqual(
        cyclic.rows
          .filter((row) => !row.is_cycle)
          .map((row) => Number(row.page_id))
          .sort((a, b) => a - b),
        [root, child, grand].sort((a, b) => a - b),
      );
      assert.deepEqual(
        cyclic.rows
          .filter((row) => row.is_cycle)
          .map((row) => [Number(row.page_id), row.depth]),
        [[root, 2]],
      );
    });
  });

  it('并发 A→B / B→A 的后提交者会被 deferred 复核拒绝', async () => {
    const setup = await pool.connect();
    const a = await pool.connect();
    const b = await pool.connect();
    let pageA = 0;
    let pageB = 0;
    try {
      await cleanupConcurrentFixture(setup);
      await setup.query('BEGIN');
      pageA = await registerPage(
        setup,
        CONCURRENT_WIDS[0],
        'ts2test:hierarchy-concurrent-a',
      );
      pageB = await registerPage(
        setup,
        CONCURRENT_WIDS[1],
        'ts2test:hierarchy-concurrent-b',
      );
      await setup.query('COMMIT');

      await a.query('BEGIN');
      await b.query('BEGIN');
      await b.query(`SET LOCAL statement_timeout = '5s'`);

      await a.query(
        `UPDATE serve.page_current SET parent_page_id = $2 WHERE page_id = $1`,
        [pageA, pageB],
      );
      const competing = b
        .query(
          `UPDATE serve.page_current SET parent_page_id = $2 WHERE page_id = $1`,
          [pageB, pageA],
        )
        .then(() => ({ stage: 'update' as const, code: null as string | null }))
        .catch((err: unknown) => ({
          stage: 'update' as const,
          code: (err as { code?: string }).code ?? null,
        }));

      // 给 B 足够时间走到 hierarchy advisory lock；A 提交后 B 才能继续校验。
      await new Promise((resolve) => setTimeout(resolve, 100));
      await a.query('COMMIT');
      const updateResult = await competing;

      if (updateResult.code === null) {
        try {
          await b.query('COMMIT');
          assert.fail('并发反向边本应在 deferred 复核时被拒');
        } catch (err) {
          assert.equal((err as { code?: string }).code, '23514');
          await b.query('ROLLBACK').catch(() => undefined);
        }
      } else {
        assert.equal(updateResult.code, '23514');
        await b.query('ROLLBACK');
      }

      const state = await setup.query<{ page_id: number; parent_page_id: number | null }>(
        `SELECT page_id, parent_page_id
           FROM serve.page_current
          WHERE page_id = ANY($1::int[])
          ORDER BY page_id`,
        [[pageA, pageB]],
      );
      assert.equal(state.rows.length, 2);
      assert.equal(
        state.rows.filter((row) => row.parent_page_id !== null).length,
        1,
        '最终只能保留一个方向，不能提交成双节点环',
      );
    } finally {
      await a.query('ROLLBACK').catch(() => undefined);
      await b.query('ROLLBACK').catch(() => undefined);
      await cleanupConcurrentFixture(setup).catch(() => undefined);
      await setup.query(`SELECT meta.ingest_gate_sweep()`).catch(() => undefined);
      a.release();
      b.release();
      setup.release();
    }
  });
});
