/**
 * 「对账发现分歧」不等于「对账工具故障」——两者不能共用退出码。
 *
 * v1→v2 迁移期长期存在待归因差异，若 `failed` 常驻非零退出，reconcile 单元会永远红着，
 * 告警随即失去指示作用。分歧靠报表 + 占比回归判据反映；退出码只留给工具级故障
 * 与「未解释占比显著恶化」这类真正的新消息。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  isReconcileFailure,
  isReconcileToolFailure,
  unexplainedRatioRegressed,
} from '../src/reconcile/types.js';

describe('对账退出码语义', () => {
  it('发现分歧仍是 failure（用于报表与 ok 字段），但不是工具故障', () => {
    assert.equal(isReconcileFailure('failed'), true);
    assert.equal(isReconcileToolFailure('failed'), false);
  });

  it('只有 aborted 算工具故障', () => {
    assert.equal(isReconcileToolFailure('aborted'), true);
    for (const s of ['ok', 'partial', 'inconclusive'] as const) {
      assert.equal(isReconcileToolFailure(s), false);
    }
  });
});

describe('未解释占比回归判据', () => {
  const tol = 0.005;

  it('无基线时不判恶化——首轮不该仅因为没有对比对象就报警', () => {
    assert.equal(
      unexplainedRatioRegressed({ compared: 1000, differences: 0, unexplained: 500 }, null, tol),
      false,
    );
  });

  it('覆盖面翻倍导致绝对数上升，但占比下降 ⇒ 不算恶化', () => {
    // 这正是 id=8→id=9 的真实情形：2,904/195,489 (1.49%) → 4,049/376,082 (1.08%)。
    const regressed = unexplainedRatioRegressed(
      { compared: 376_082, differences: 11_960, unexplained: 4_049 },
      { compared: 195_489, unexplained: 2_904 },
      tol,
    );
    assert.equal(regressed, false);
  });

  it('占比上升超过容差 ⇒ 恶化', () => {
    const regressed = unexplainedRatioRegressed(
      { compared: 100_000, differences: 0, unexplained: 2_000 }, // 2.0%
      { compared: 100_000, unexplained: 1_000 }, // 1.0%
      tol,
    );
    assert.equal(regressed, true);
  });

  it('占比上升但在容差内 ⇒ 不算恶化（滤掉归因推进中的正常浮动）', () => {
    const regressed = unexplainedRatioRegressed(
      { compared: 100_000, differences: 0, unexplained: 1_400 }, // 1.4%
      { compared: 100_000, unexplained: 1_000 }, // 1.0%，差 0.4pp < 0.5pp
      tol,
    );
    assert.equal(regressed, false);
  });

  it('compared 为 0 时不做判断，避免除零后误判', () => {
    assert.equal(
      unexplainedRatioRegressed({ compared: 0, differences: 0, unexplained: 0 }, { compared: 100, unexplained: 1 }, tol),
      false,
    );
    assert.equal(
      unexplainedRatioRegressed({ compared: 100, differences: 0, unexplained: 50 }, { compared: 0, unexplained: 0 }, tol),
      false,
    );
  });

  it('容差非法必须显式报错', () => {
    assert.throws(
      () =>
        unexplainedRatioRegressed(
          { compared: 100, differences: 0, unexplained: 1 },
          { compared: 100, unexplained: 1 },
          -0.1,
        ),
      RangeError,
    );
  });
});
