/** forum-consume 跨类公平性与认领背压回归。 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

import {
  FORUM_CONSUME_MAX_IN_FLIGHT,
  FORUM_CONSUME_TIMER_GAP_SEC,
  FORUM_CONSUME_WAVE_PER_CLASS,
  assertForumConsumeFairLimit,
  forumConsumeWaitUpperBoundMs,
  forumConsumeWaveQuotas,
  runForumFairWave,
} from '../src/work/forumOrder.js';

describe('forum-consume 公平微批', () => {
  it('一类任务耗尽预算时，另一类已同时启动且保留非零完成份额', async () => {
    const started: string[] = [];
    const budgetError = new Error('synthetic runtime budget');
    budgetError.name = 'RuntimeBudgetExceededError';
    const result = await runForumFairWave(
      ['discussion-1', 'discussion-2'],
      ['thread-1', 'thread-2'],
      async (task) => {
        started.push(task);
        throw budgetError;
      },
      async (task) => {
        started.push(task);
        return `${task}:ok`;
      },
    );
    assert.deepEqual(new Set(started), new Set([
      'discussion-1',
      'discussion-2',
      'thread-1',
      'thread-2',
    ]));
    assert.equal(result.discussion.filter((item) => item.status === 'fulfilled').length, 0);
    assert.equal(result.forum.filter((item) => item.status === 'fulfilled').length, 2);
  });

  it('预算只会留下当前微批，未处理数显著小于旧实现恒定 20', () => {
    assert.equal(FORUM_CONSUME_WAVE_PER_CLASS, 2);
    assert.equal(FORUM_CONSUME_MAX_IN_FLIGHT, 4);
    assert.ok(FORUM_CONSUME_MAX_IN_FLIGHT < 20);
    assert.deepEqual(forumConsumeWaveQuotas(50), { discussion: 2, forum: 2 });
    assert.deepEqual(forumConsumeWaveQuotas(2), { discussion: 1, forum: 1 });
    assert.deepEqual(
      forumConsumeWaveQuotas(50, { discussion: false, forum: true }),
      { discussion: 0, forum: 4 },
      'discussion 排空后，同波空闲名额必须回填给 forum',
    );
    assert.deepEqual(
      forumConsumeWaveQuotas(3, { discussion: true, forum: false }),
      { discussion: 3, forum: 0 },
    );
    assert.doesNotThrow(() => assertForumConsumeFairLimit(4, false, false));
    assert.throws(() => assertForumConsumeFairLimit(3, false, false), RangeError);
    assert.doesNotThrow(() => assertForumConsumeFairLimit(1, true, false));
    assert.doesNotThrow(() => assertForumConsumeFairLimit(1, false, true));
  });

  it('等待上界由首波保底和 systemd 周期直接推导', async () => {
    const [timer, queues] = await Promise.all([
      readFile(new URL('../deploy/systemd/syncer2-forum-consume.timer', import.meta.url), 'utf8'),
      readFile(new URL('../src/store/queues.ts', import.meta.url), 'utf8'),
    ]);
    assert.match(timer, /^OnUnitInactiveSec=1min$/m);
    assert.match(timer, /^AccuracySec=10s$/m);
    // reserved 必须先完整保留，再仅以剩余容量回填；若对 UNION 整体按 id LIMIT，
    // 旧 catchup id 会再次把 steady 预留名额截掉。
    assert.match(queues, /fill AS \([\s\S]*?LIMIT GREATEST\(0, \$2::int - \(SELECT count\(\*\)::int FROM reserved\)\)/);
    assert.match(queues, /WHEN 'catchup' THEN GREATEST\([\s\S]*?\$2::int - GREATEST\(1, floor\(\$2::int \* 0\.4\)::int\)/);
    assert.match(queues, /WHEN 'catchup' THEN GREATEST\(\s*0,/);
    assert.match(queues, /PARTITION BY fst\.lane\s+ORDER BY COALESCE\(fst\.not_before, fst\.first_seen_at\), fst\.id/);
    assert.match(queues, /PARTITION BY \('forum_link_initial_catchup' = ANY\(st\.reasons\)\)\s+ORDER BY COALESCE\(st\.not_before, st\.created_at\), st\.id/);
    assert.equal(FORUM_CONSUME_TIMER_GAP_SEC, 70);
    // 两张表各按 lane 每轮至少 1 个：前方 10 个时，第 11 轮获得执行尝试。
    assert.equal(forumConsumeWaitUpperBoundMs(10, 'discussion_lane', 300), 11 * 370_000);
    // forum 认领 SQL 对 catchup/steady 各保底 1 个：同 lane 前方 10 个时第 11 轮。
    assert.equal(forumConsumeWaitUpperBoundMs(10, 'forum_lane', 300), 11 * 370_000);
    assert.throws(() => forumConsumeWaitUpperBoundMs(-1, 'forum_lane', 300), RangeError);
    assert.throws(() => forumConsumeWaitUpperBoundMs(0, 'discussion_lane', 0), RangeError);
  });
});
