/**
 * 真实 meta.scan_task 认领 SQL 的公平性回归。
 *
 * 构造每轮都重新播种的 content@100 与长期积压的 discussion@10：
 * 低优先 kind 必须每轮非零，而高优先仍获得大多数名额。
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { createPool, query } from '../src/store/db.js';
import {
  claimWorkTasks,
  finishVoteTask,
  seedVoteTasks,
  type ClaimedVoteTask,
} from '../src/store/workQueue.js';
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

  it('零票页首次完整快照推进时钟；错误重播种仍被成功证据闸拒绝认领', async () => {
    await clearTasks();
    const pageId = highPages[2]!;
    const worker = `${WORKER}:zero-vote`;
    const startedAt = new Date().toISOString();
    const wikidot = await query<{ wikidot_id: number }>(
      pool,
      'test:spinloop:page_identity',
      `UPDATE serve.page_current
          SET first_published_at = clock_timestamp() + interval '1 minute',
              last_complete_vote_snapshot_at = NULL
        WHERE page_id = $1
      RETURNING wikidot_id`,
      [pageId],
    );
    const run = await query<{ id: string }>(
      pool,
      'test:spinloop:evidence_run',
      `INSERT INTO meta.ingest_run(source, status, started_at)
       VALUES ($1, 'ok', $2::timestamptz) RETURNING id::text`,
      [EVIDENCE_SOURCE, startedAt],
    );
    const runId = Number(run.rows[0]!.id);
    await query(
      pool,
      'test:spinloop:l1_zero_claim',
      `INSERT INTO meta.page_scan(
         run_id, page_id, kind, status, claimed_total, checksum_expected, scanned_at
       ) VALUES ($1, $2, 'meta', 'ok', 0, 0, $3::timestamptz)`,
      [runId, pageId, startedAt],
    );

    await seedVoteTasks(pool, startedAt, {
      highFrequencyLimit: 1,
      highFrequencyPageIds: [pageId],
      laneLimit: 0,
      budgetKeyPrefix: 'test:spinloop',
    });
    const claimed = await claimWorkTasks(
      pool,
      1,
      worker,
      ['new_page_highfreq'],
      undefined,
      undefined,
      PREFIX,
    );
    assert.equal(claimed.length, 1);
    assert.equal(claimed[0]!.pageId, pageId);

    const applied = await query<{ applied: Record<string, unknown> }>(
      pool,
      'test:spinloop:apply_empty_snapshot',
      `SELECT ingest.apply_vote_snapshot(
         $1, '[]'::jsonb, true, 0, 0, ARRAY['wikidot']::text[],
         $2::timestamptz, 'test_wikidot', $3, $4,
         'candidate', 500, 0.20::real
       ) AS applied`,
      [pageId, startedAt, runId, wikidot.rows[0]!.wikidot_id],
    );
    assert.equal(applied.rows[0]!.applied['scan_status'], 'ok');
    assert.equal(applied.rows[0]!.applied['idempotent_replay'], true,
      '初始空 current 与零票快照相等，必须覆盖该幂等短路');
    const advanced = await query<{ advanced: boolean; ok_scan: boolean }>(
      pool,
      'test:spinloop:clock_advanced',
      `SELECT pc.last_complete_vote_snapshot_at IS NOT NULL AS advanced,
              EXISTS (
                SELECT 1 FROM meta.page_scan ps
                 WHERE ps.page_id = pc.page_id
                   AND ps.kind = 'votes' AND ps.status = 'ok'
              ) AS ok_scan
         FROM serve.page_current pc
        WHERE pc.page_id = $1`,
      [pageId],
    );
    assert.deepEqual(advanced.rows[0], { advanced: true, ok_scan: true });

    const beforeConflict = await query<{ scanned_at: string }>(
      pool,
      'test:spinloop:before_conflict_scan',
      `SELECT scanned_at::text
         FROM meta.page_scan
        WHERE run_id = $1 AND page_id = $2 AND kind = 'votes'`,
      [runId, pageId],
    );
    await query(pool, 'test:spinloop:clock_tick', `SELECT pg_sleep(0.01)`);
    await query(
      pool,
      'test:spinloop:record_conflict_scan',
      `SELECT meta.record_page_scan(
         $1, $2, 'votes', 'ok', 0, 0, true, 0, 0, NULL, NULL
       )`,
      [runId, pageId],
    );
    const afterConflict = await query<{
      rows: number;
      scanned_at: string;
      clock_at: string;
      advanced: boolean;
    }>(
      pool,
      'test:spinloop:conflict_advanced',
      `SELECT count(*)::int AS rows,
              max(ps.scanned_at)::text AS scanned_at,
              max(pc.last_complete_vote_snapshot_at)::text AS clock_at,
              max(ps.scanned_at) > $3::timestamptz AS advanced
         FROM meta.page_scan ps
         JOIN serve.page_current pc ON pc.page_id = ps.page_id
        WHERE ps.run_id = $1 AND ps.page_id = $2 AND ps.kind = 'votes'`,
      [runId, pageId, beforeConflict.rows[0]!.scanned_at],
    );
    assert.equal(afterConflict.rows[0]!.rows, 1, '同一 run/page/kind 必须走 ON CONFLICT');
    assert.equal(afterConflict.rows[0]!.advanced, true);
    assert.equal(afterConflict.rows[0]!.clock_at, afterConflict.rows[0]!.scanned_at,
      'ON CONFLICT 更新 votes/ok 后时钟必须精确跟上 scanned_at');

    const voteTask = claimed[0] as ClaimedVoteTask;
    assert.equal((await finishVoteTask(pool, voteTask, {
      workerId: worker,
      status: 'ok',
      now: new Date().toISOString(),
    })).action, 'deleted');
    assert.equal(
      (await query<{ n: number }>(
        pool,
        'test:spinloop:no_task_after_finish',
        `SELECT count(*)::int AS n FROM meta.scan_task
          WHERE page_id = $1 AND kind = 'new_page_highfreq'`,
        [pageId],
      )).rows[0]!.n,
      0,
    );

    // 模拟投影/重建 UPSERT 不携带派生时钟；数据库保护必须把它夹回最新成功证据。
    await query(
      pool,
      'test:spinloop:simulate_projection_rebuild',
      `INSERT INTO serve.page_current(page_id, wikidot_id, slug, status, last_complete_vote_snapshot_at)
       SELECT page_id, wikidot_id, slug, 'live', NULL
         FROM serve.page_current
        WHERE page_id = $1
       ON CONFLICT (page_id) DO UPDATE
         SET slug = EXCLUDED.slug,
             status = EXCLUDED.status,
             last_complete_vote_snapshot_at = EXCLUDED.last_complete_vote_snapshot_at,
             updated_at = clock_timestamp()`,
      [pageId],
    );
    const rebuilt = await query<{ preserved: boolean }>(
      pool,
      'test:spinloop:projection_clock_preserved',
      `SELECT pc.last_complete_vote_snapshot_at = max_scan.scanned_at AS preserved
         FROM serve.page_current pc
         CROSS JOIN LATERAL (
           SELECT max(ps.scanned_at) AS scanned_at
             FROM meta.page_scan ps
            WHERE ps.page_id = pc.page_id AND ps.kind = 'votes' AND ps.status = 'ok'
         ) max_scan
        WHERE pc.page_id = $1`,
      [pageId],
    );
    assert.equal(rebuilt.rows[0]!.preserved, true,
      'page_current 重建 UPSERT 不得覆盖 votes/ok 时钟');
    await seedVoteTasks(pool, new Date(Date.now() + 60 * 60_000).toISOString(), {
      highFrequencyLimit: 1,
      highFrequencyPageIds: [pageId],
      laneLimit: 0,
      budgetKeyPrefix: 'test:spinloop',
    });
    assert.equal(
      (await query<{ n: number }>(
        pool,
        'test:spinloop:not_reseeded',
        `SELECT count(*)::int AS n FROM meta.scan_task
          WHERE page_id = $1 AND kind = 'new_page_highfreq'`,
        [pageId],
      )).rows[0]!.n,
      0,
      '最近 votes/ok 必须直接阻止重新播种，不能依赖快照字段',
    );

    await seedTasks([pageId], 'new_page_highfreq', 100, [new Date().toISOString()]);
    assert.deepEqual(
      await claimWorkTasks(
        pool,
        1,
        `${worker}:forced-reseed`,
        ['new_page_highfreq'],
        undefined,
        undefined,
        PREFIX,
      ),
      [],
      '即使绕过播种器强行插入任务，执行侧也必须在 3h 内拒绝扫描',
    );
  });
});
