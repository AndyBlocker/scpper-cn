/**
 * 单轮时间预算必须显著小于 systemd 的硬超时，否则进程被 SIGTERM 杀死、无法优雅收尾。
 *
 * 事故链：work-queue 公平性修复让 votes_full 得以进入每轮配额 → 单轮实际耗时上升
 * → 超过 TimeoutStartSec=10min → 每轮被 SIGTERM 杀死、只消耗 5 秒 CPU
 * → 任务被认领（attempts+1）却无人做完 → 「配额生效了，队列反而越积越多」。
 *
 * 0.10 QPS 的限速决定了单轮下限：50 个任务光等待就是 500 秒。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  RUN_BUDGET_MS,
  WORK_QUEUE_LIMIT_MAX,
  WORK_QUEUE_MIN_REQUEST_INTERVAL_MS,
} from '../src/store/workQueue.js';

/** 与 deploy/systemd 的 syncer2-job@work-queue.service.d 保持一致。 */
const SYSTEMD_TIMEOUT_MS = 10 * 60_000;

describe('work-queue 单轮时间预算', () => {
  it('必须留出收尾余量，不能贴着 systemd 硬超时', () => {
    assert.ok(
      RUN_BUDGET_MS < SYSTEMD_TIMEOUT_MS,
      `预算 ${RUN_BUDGET_MS}ms 必须小于硬超时 ${SYSTEMD_TIMEOUT_MS}ms`,
    );
    const margin = SYSTEMD_TIMEOUT_MS - RUN_BUDGET_MS;
    assert.ok(
      margin >= 2 * 60_000,
      `收尾余量 ${margin}ms 不足 2 分钟：结账、finishIngestRun、释放锁都要时间`,
    );
  });

  it('满额一轮的纯限速等待会超预算——预算存在的理由正是它', () => {
    const pureWaitMs = WORK_QUEUE_LIMIT_MAX * WORK_QUEUE_MIN_REQUEST_INTERVAL_MS;
    assert.ok(
      pureWaitMs > RUN_BUDGET_MS,
      `满额纯等待 ${pureWaitMs}ms 应超过预算 ${RUN_BUDGET_MS}ms，否则预算永不触发、等于没加`,
    );
  });

  it('预算内至少能做完可观数量的任务，不能小到每轮几乎空转', () => {
    const minTasks = Math.floor(RUN_BUDGET_MS / WORK_QUEUE_MIN_REQUEST_INTERVAL_MS);
    assert.ok(minTasks >= 20, `预算内仅能处理 ${minTasks} 个任务，吞吐过低`);
  });
});
