/**
 * 真实 meta.scan_task 认领 SQL 的公平性回归。
 *
 * 构造每轮都重新播种的 content@100 与长期积压的 discussion@10：
 * 低优先 kind 必须每轮非零，而高优先仍获得大多数名额。
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { createPool, query } from '../src/store/db.js';
import { claimWorkTasks } from '../src/store/workQueue.js';
import type { ScanTaskKind } from '../src/store/meta.js';
import { cleanupAll, registerPage } from './helpers/fixture.js';
import { openSess, resolveTestDatabaseUrl, type Sess } from './helpers/pg.js';

const WORKER = 'test-fairshare-worker';
const PREFIX = 'ts2test:fairshare:';
const EVIDENCE_SOURCE = 'test_fairshare_listpages';
const BASE = 91_000;
const pool = createPool(resolveTestDatabaseUrl(), { max: 2 });
let sess: Sess;
let highPages: number[] = [];
let lowPages: number[] = [];

async function clearTasks(): Promise<void> {
  await query(
    pool,
    'test:fairshare:clear_tasks',
    `DELETE FROM meta.scan_task WHERE page_id = ANY($1::int[])`,
    [[...highPages, ...lowPages]],
  );
  await query(
    pool,
    'test:fairshare:clear_evidence_runs',
    `DELETE FROM meta.ingest_run WHERE source = $1`,
    [EVIDENCE_SOURCE],
  );
}

async function seedTasks(
  pages: readonly number[],
  kind: ScanTaskKind,
  priority: number,
  createdAts: readonly string[],
): Promise<void> {
  assert.equal(pages.length, createdAts.length);
  await query(
    pool,
    'test:fairshare:seed_tasks',
    `INSERT INTO meta.scan_task(page_id, kind, reasons, priority, not_before, created_at)
     SELECT input.page_id,
            $2::text,
            ARRAY['test_fairshare'],
            $3::int,
            now(),
            input.created_at
       FROM unnest($1::int[], $4::timestamptz[]) AS input(page_id, created_at)`,
    [pages, kind, priority, createdAts],
  );
}

async function deleteClaimed(taskIds: readonly number[]): Promise<void> {
  await query(
    pool,
    'test:fairshare:delete_claimed',
    `DELETE FROM meta.scan_task WHERE id = ANY($1::bigint[])`,
    [taskIds],
  );
}

async function oldestLowCreatedAt(): Promise<number | null> {
  const res = await query<{ oldest_ms: string | null }>(
    pool,
    'test:fairshare:oldest_low',
    `SELECT (extract(epoch FROM min(created_at)) * 1000)::bigint::text AS oldest_ms
       FROM meta.scan_task
      WHERE page_id = ANY($1::int[]) AND kind = 'discussion'`,
    [lowPages],
  );
  const value = res.rows[0]?.oldest_ms;
  return value === null || value === undefined ? null : Number(value);
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

before(async () => {
  sess = await openSess('work-queue-fairshare');
  await cleanupAll(sess);
  for (let index = 0; index < 12; index++) {
    highPages.push(await registerPage(sess, BASE + index, `${PREFIX}high-${index}`));
    lowPages.push(await registerPage(sess, BASE + 100 + index, `${PREFIX}low-${index}`));
  }
});

after(async () => {
  await clearTasks().catch(() => undefined);
  await cleanupAll(sess);
  await pool.end().catch(() => undefined);
  await sess.end();
});

describe('work-queue kind fair-share SQL', () => {
  it('高优先持续播种时低优先每轮仍非零，饥饿检测会扩大实际名额', async () => {
    const now = Date.now();
    await clearTasks();
    await seedTasks(
      lowPages,
      'discussion',
      10,
      lowPages.map((_pageId, index) => iso(now - (24 - index) * 60 * 60_000)),
    );

    let previousOldest = await oldestLowCreatedAt();
    assert.notEqual(previousOldest, null);
    let previousOldestWaitMs = Date.now() - previousOldest!;
    for (let round = 0; round < 3; round++) {
      // 每轮重建高优先 backlog，模拟 L1 持续新播种。
      await query(
        pool,
        'test:fairshare:refresh_high',
        `DELETE FROM meta.scan_task
          WHERE page_id = ANY($1::int[]) AND kind = 'content'`,
        [highPages],
      );
      await seedTasks(
        highPages,
        'content',
        100,
        highPages.map((_pageId, index) => iso(now + round * 1_000 + index)),
      );

      const claimed = await claimWorkTasks(
        pool,
        10,
        `${WORKER}:${round}`,
        ['content', 'discussion'],
        undefined,
        undefined,
        PREFIX,
      );
      const high = claimed.filter((task) => task.kind === 'content').length;
      const low = claimed.filter((task) => task.kind === 'discussion').length;
      assert.equal(claimed.length, 10);
      assert.equal(low, 1, `round=${round} 低优先 kind 必须获得一个 FIFO 保底`);
      assert.equal(high, 9, `round=${round} 高优先仍应更快`);
      await deleteClaimed(claimed.map((task) => task.taskId));

      const oldest = await oldestLowCreatedAt();
      assert.notEqual(oldest, null);
      const oldestWaitMs = Date.now() - oldest!;
      assert.ok(
        oldest! > previousOldest!,
        `round=${round} 最老任务应被 FIFO 消化，不得单调变老`,
      );
      assert.ok(
        oldestWaitMs < previousOldestWaitMs,
        `round=${round} oldestWait 应下降：${oldestWaitMs} !< ${previousOldestWaitMs}`,
      );
      previousOldest = oldest;
      previousOldestWaitMs = oldestWaitMs;
    }

    await query(
      pool,
      'test:fairshare:refresh_high_for_starvation',
      `DELETE FROM meta.scan_task
        WHERE page_id = ANY($1::int[]) AND kind = 'content'`,
      [highPages],
    );
    await seedTasks(
      highPages,
      'content',
      100,
      highPages.map((_pageId, index) => iso(now + 10_000 + index)),
    );
    const corrected = await claimWorkTasks(
      pool,
      10,
      `${WORKER}:corrected`,
      ['content', 'discussion'],
      undefined,
      undefined,
      PREFIX,
      null,
      ['discussion'],
    );
    const correctedHigh = corrected.filter((task) => task.kind === 'content').length;
    const correctedLow = corrected.filter((task) => task.kind === 'discussion').length;
    assert.equal(corrected.length, 10);
    assert.equal(correctedLow, 4, '检测器命中后应触发额外 FIFO 名额，不能仅日志');
    assert.equal(correctedHigh, 6, '纠偏只占一半车道，高优先仍更快');
    await deleteClaimed(corrected.map((task) => task.taskId));
  });

  it('confirm_deleted/new_page_highfreq 在同等条件下仍优先', async () => {
    await clearTasks();
    const createdAt = new Date().toISOString();
    await seedTasks([highPages[0]!], 'content', 50, [createdAt]);
    await seedTasks([lowPages[0]!], 'confirm_deleted', 50, [createdAt]);
    await query(
      pool,
      'test:fairshare:make_new_page',
      `UPDATE serve.page_current SET first_published_at = now() WHERE page_id = $1`,
      [lowPages[1]],
    );
    const run = await query<{ id: string }>(
      pool,
      'test:fairshare:evidence_run',
      `INSERT INTO meta.ingest_run(source, status, started_at)
       VALUES ($1, 'ok', now()) RETURNING id::text`,
      [EVIDENCE_SOURCE],
    );
    await query(
      pool,
      'test:fairshare:evidence_scan',
      `INSERT INTO meta.page_scan(
         run_id, page_id, kind, status, claimed_total, checksum_expected
       ) VALUES ($1::bigint, $2, 'meta', 'ok', 0, 0)`,
      [run.rows[0]!.id, lowPages[1]],
    );
    await seedTasks([lowPages[1]!], 'new_page_highfreq', 50, [createdAt]);
    const claimed = await claimWorkTasks(
      pool,
      3,
      `${WORKER}:pinned`,
      ['content', 'confirm_deleted', 'new_page_highfreq'],
      undefined,
      undefined,
      PREFIX,
    );
    assert.deepEqual(
      claimed.map((task) => task.kind),
      ['confirm_deleted', 'new_page_highfreq', 'content'],
    );
    await deleteClaimed(claimed.map((task) => task.taskId));
    await query(
      pool,
      'test:fairshare:remove_evidence_run',
      `DELETE FROM meta.ingest_run WHERE id = $1::bigint`,
      [run.rows[0]!.id],
    );
  });
});
