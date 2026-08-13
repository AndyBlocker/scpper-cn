/** forum-consume 预算中断后的 claim 必须立即解锁并归还 attempt。 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { createPool, query } from '../src/store/db.js';
import { releaseForumTargetLocks } from '../src/store/queues.js';
import { resolveTestDatabaseUrl } from './helpers/pg.js';

const TARGET_ID = 9_001_991_759_296;
const WORKER = 'test:forum-runtime-budget';
const pool = createPool(resolveTestDatabaseUrl(), { max: 2 });

async function cleanup(): Promise<void> {
  await query(
    pool,
    'test:forum-budget-cleanup',
    `DELETE FROM meta.forum_scan_task WHERE kind='thread' AND target_id=$1`,
    [TARGET_ID],
  );
}

before(cleanup);
after(async () => {
  await cleanup();
  await pool.end();
});

describe('forum-consume runtime budget claim 收尾', () => {
  it('等待中断的任务不依赖 stale recovery：立即解锁且 attempts - 1', async () => {
    const inserted = await query<{ id: string }>(
      pool,
      'test:forum-budget-insert',
      `INSERT INTO meta.forum_scan_task(
         kind,target_id,reasons,priority,attempts,locked_by,locked_at
       ) VALUES ('thread',$1,ARRAY['runtime_budget_test'],999,7,$2,now())
       RETURNING id::text`,
      [TARGET_ID, WORKER],
    );
    const id = Number(inserted.rows[0]!.id);
    assert.equal(await releaseForumTargetLocks(pool, [id], WORKER, false, true), 1);
    const state = await query<{
      attempts: number;
      locked_by: string | null;
      locked_at: Date | null;
      priority: number;
      reasons: string[];
      not_before: Date | null;
    }>(
      pool,
      'test:forum-budget-state',
      `SELECT attempts,locked_by,locked_at,priority,reasons,not_before
         FROM meta.forum_scan_task WHERE id=$1`,
      [id],
    );
    const row = state.rows[0]!;
    assert.ok(row.not_before instanceof Date);
    assert.ok(row.not_before.getTime() > Date.now() + 55 * 60_000);
    assert.deepEqual({ ...row, not_before: 'future' }, {
      attempts: 6,
      locked_by: null,
      locked_at: null,
      priority: 998,
      reasons: ['runtime_budget_test', 'forum_runtime_budget_rotated'],
      not_before: 'future',
    });
  });
});
