/**
 * 置顶 kind 必须配额封顶，否则低优先 kind 会无限饥饿。
 *
 * 事故：`new_page_highfreq` 被无条件排在所有 kind 之前，且它是**自我补充**的
 * （新页 7 天内反复重排）。每轮 50 个配额被它与 content 吃光，`votes_full` 拿到 0 个——
 * 524 个任务里 495 个从未被尝试，最久排队 6.8 天，外部表现是「v2 评分落后 wikidot 两天」。
 *
 * 关键点：队列深度、每轮吞吐、失败率**全部正常**（50 个配额轮轮打满、全部成功）。
 * 常规健康指标衡量「做了多少」，饥饿要问「谁一直没被做」，两者正交。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  PINNED_KIND_SHARE,
  WORK_QUEUE_LIMIT_MAX,
  pinnedKindQuota,
} from '../src/store/workQueue.js';

describe('置顶 kind 配额', () => {
  it('生产配置 limit=50 时置顶最多占 20，至少 30 个名额留给其它 kind', () => {
    const quota = pinnedKindQuota(WORK_QUEUE_LIMIT_MAX);
    assert.equal(quota, 20);
    assert.ok(
      WORK_QUEUE_LIMIT_MAX - quota >= 30,
      `其它 kind 至少应剩 30 个名额，实得 ${WORK_QUEUE_LIMIT_MAX - quota}`,
    );
  });

  it('配额严格小于总额——否则置顶仍可吃满，等于没改', () => {
    for (const limit of [2, 5, 10, 25, 50]) {
      assert.ok(
        pinnedKindQuota(limit) < limit,
        `limit=${limit} 时配额 ${pinnedKindQuota(limit)} 必须小于总额`,
      );
    }
  });

  it('小 limit 下至少留 1 个名额给置顶 kind，避免反向饥饿', () => {
    // 1 * 0.4 = 0.4 → floor 为 0；确认删除这类及时性任务不能被完全饿死。
    assert.equal(pinnedKindQuota(1), 1);
    assert.equal(pinnedKindQuota(2), 1);
  });

  it('limit=0 时配额为 0，不构造出凭空的名额', () => {
    assert.equal(pinnedKindQuota(0), 0);
  });

  it('配额比例是有意的少数派，不能被改成 ≥1', () => {
    assert.ok(PINNED_KIND_SHARE > 0 && PINNED_KIND_SHARE < 1, '比例必须落在 (0,1)');
  });

  it('非法 limit 必须显式报错，不静默当 0（否则饥饿会以另一种形式回来）', () => {
    assert.throws(() => pinnedKindQuota(-1), RangeError);
    assert.throws(() => pinnedKindQuota(1.5), RangeError);
    assert.throws(() => pinnedKindQuota(Number.NaN), RangeError);
  });
});
