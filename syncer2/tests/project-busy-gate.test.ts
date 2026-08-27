/**
 * busy（摄入侧持有 gate 屏障锁）不得等同于投影失败。
 *
 * 事故：`safe_seq_watermark()` 的契约把 NULL 定义为「本轮不推进游标」的良性信号，
 * 但 CLI 曾把任何 busy 都算作 ok=false ⇒ exit 1。结果是摄入越忙、投影越爱失败：
 * 源码回填期间几乎每轮告警，告警通道随即失去意义。
 * 同时不能无条件放行——摄入侧若真的长期占锁，投影会静默停止推进。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { selectStalledBusy } from '../src/project/runner.js';
import type { ProjectionRunResult } from '../src/project/types.js';

const THRESHOLD = 30 * 60;

function row(
  projection: ProjectionRunResult['projection'],
  status: 'ok' | 'idle' | 'busy',
  lagBeforeSeconds: number,
): Pick<ProjectionRunResult, 'projection' | 'status' | 'lagBeforeSeconds'> {
  return { projection, status, lagBeforeSeconds };
}

describe('projector busy gate', () => {
  it('瞬时 busy 不升级为失败——这正是此前每轮误报的那一类', () => {
    const stalled = selectStalledBusy(
      [row('serve.user_tag_preference', 'busy', 12)],
      THRESHOLD,
    );
    assert.deepEqual(stalled, []);
  });

  it('busy 且游标长期未推进 ⇒ 必须升级，别把保护拆了', () => {
    const stalled = selectStalledBusy(
      [row('serve.user_stats', 'busy', THRESHOLD + 1)],
      THRESHOLD,
    );
    assert.deepEqual(stalled, ['serve.user_stats']);
  });

  it('恰好等于阈值不算停滞（阈值是严格大于）', () => {
    assert.deepEqual(
      selectStalledBusy([row('serve.site_stats', 'busy', THRESHOLD)], THRESHOLD),
      [],
    );
  });

  it('非 busy 的投影再怎么滞后也不由这条判据决定', () => {
    // ok/idle 的滞后由既有的 lag>60s 告警负责；这条判据只管 gate 争用。
    const stalled = selectStalledBusy(
      [
        row('serve.page_stats', 'ok', THRESHOLD * 10),
        row('serve.vote_daily', 'idle', THRESHOLD * 10),
      ],
      THRESHOLD,
    );
    assert.deepEqual(stalled, []);
  });

  it('混合场景只挑出真正停滞的那些', () => {
    const stalled = selectStalledBusy(
      [
        row('serve.page_stats', 'ok', 0),
        row('serve.user_page', 'busy', 5),
        row('serve.user_stats', 'busy', THRESHOLD + 60),
        row('serve.site_stats', 'busy', THRESHOLD + 1),
      ],
      THRESHOLD,
    );
    assert.deepEqual(stalled, ['serve.user_stats', 'serve.site_stats']);
  });

  it('阈值非法必须显式报错，不许静默当 0（否则一切 busy 都成停滞）', () => {
    assert.throws(
      () => selectStalledBusy([row('serve.user_stats', 'busy', 10)], -1),
      RangeError,
    );
    assert.throws(
      () => selectStalledBusy([row('serve.user_stats', 'busy', 10)], 1.5),
      RangeError,
    );
  });
});
