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
import { readFile } from 'node:fs/promises';
import {
  ALL_WORK_TASK_KINDS,
  effectiveTaskPriority,
  fairShareGuaranteedQuota,
  FAIR_SHARE_GUARANTEED_SHARE,
  irreconcilableReviewQuota,
  kindClaimWaitUpperBoundMs,
  KIND_SERVICE_MIN_PER_ROUND,
  PINNED_KIND_SHARE,
  PRIORITY_AGING_BANDS,
  WORK_QUEUE_ROUND_UPPER_BOUND_MS,
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

describe('kind 公平服务下限', () => {
  it('生产 limit=50 足以每轮先给全部 11 kind 各1个 FIFO 名额', () => {
    const quota = fairShareGuaranteedQuota(WORK_QUEUE_LIMIT_MAX, ALL_WORK_TASK_KINDS.length);
    assert.equal(ALL_WORK_TASK_KINDS.length, 11);
    assert.equal(KIND_SERVICE_MIN_PER_ROUND, 1);
    assert.equal(quota, 25);
    assert.ok(quota >= ALL_WORK_TASK_KINDS.length);
    assert.equal(FAIR_SHARE_GUARANTEED_SHARE, 0.5);
  });

  it('等待上界只用每轮1个保底即可从代码推导', () => {
    assert.equal(WORK_QUEUE_ROUND_UPPER_BOUND_MS, 425_000);
    assert.equal(kindClaimWaitUpperBoundMs(0), 425_000);
    assert.equal(kindClaimWaitUpperBoundMs(9), 4_250_000);
    assert.ok(
      fairShareGuaranteedQuota(50, 11) >= 11,
      '最老到期任务必须在一轮内被认领',
    );
  });

  it('分带老化有可推导的上界，低带永远不能压过高带', () => {
    const now = Date.parse('2026-08-13T00:00:00.000Z');
    const policies = new Map(PRIORITY_AGING_BANDS.map((band) => [band.minimumPriority, band]));
    assert.equal(policies.get(200)?.maxWaitMs, 425_000);
    assert.equal(policies.get(100)?.maxWaitMs, 3_600_000);
    assert.equal(policies.get(20)?.maxWaitMs, 86_400_000);
    assert.equal(policies.get(10)?.maxWaitMs, 604_800_000);

    assert.equal(effectiveTaskPriority(200, now - 425_000, now), 299);
    assert.equal(effectiveTaskPriority(100, now - 3_600_000, now), 199);
    assert.equal(effectiveTaskPriority(20, now - 9 * 24 * 60 * 60_000, now), 99);
    assert.equal(effectiveTaskPriority(10, now - 7 * 24 * 60 * 60_000, now), 19);
    assert.ok(effectiveTaskPriority(20, now - 365 * 24 * 60 * 60_000, now) < 100);
    assert.ok(effectiveTaskPriority(100, now - 365 * 24 * 60 * 60_000, now) < 200);
    assert.ok(effectiveTaskPriority(10, now - 365 * 24 * 60 * 60_000, now) < 20);
  });

  it('终态复查有封顶，不会在常规认领之前吃光整轮', () => {
    assert.equal(irreconcilableReviewQuota(50, 11), 10);
    assert.equal(irreconcilableReviewQuota(11, 11), 0);
    assert.equal(irreconcilableReviewQuota(10, 2), 2);
  });

  it('生产 SQL 先做 kind FIFO 保底/饥饿纠偏，再用老化优先级填剩余名额', async () => {
    const source = await readFile(new URL('../src/store/workQueue.ts', import.meta.url), 'utf8');
    const claim = source.slice(
      source.indexOf('export async function claimWorkTasks'),
      source.indexOf('export async function claimIrreconcilableReviews'),
    );
    assert.match(claim, /PARTITION BY st\.kind[\s\S]*ORDER BY st\.created_at, st\.id/);
    assert.match(claim, /e\.fifo_rank = 1 OR e\.kind = ANY\(\$10::text\[\]\)/);
    assert.match(claim, /CROSS JOIN LATERAL[\s\S]*unnest\(\$12::integer\[\], \$13::integer\[\], \$14::bigint\[\]\)/);
    assert.match(claim, /st\.priority::bigint \+ LEAST/);
    assert.match(claim, /ORDER BY picked\.schedule_ord/);
    assert.match(claim, /\(e\.kind = 'confirm_deleted'\) DESC/);
    assert.match(claim, /\(e\.kind = 'new_page_highfreq'\) DESC/);
    const cli = await readFile(new URL('../src/cli/work-queue.ts', import.meta.url), 'utf8');
    assert.match(cli, /limit < selected\.length/);
    assert.match(cli, /无法保证每 kind 每轮至少 1 个名额/);
  });

  it('非法输入不能静默破坏上界', () => {
    assert.throws(() => fairShareGuaranteedQuota(-1, 1), RangeError);
    assert.throws(() => fairShareGuaranteedQuota(50, -1), RangeError);
    assert.throws(() => kindClaimWaitUpperBoundMs(-1), RangeError);
  });
});
