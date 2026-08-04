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

  /*
   * 限速从 10s 放宽到 2s 后，预算的角色变了：
   * 此前满额一轮的纯等待就是 500s，预算是**必然触发**的收敛机制；
   * 现在满额纯等待仅 100s，预算退化为**病态情况的安全网**
   * （单个大页 60s 超时 + 分页重试仍可能吃掉数分钟）。
   * 断言随之改为「正常一轮必须能从容做完」，而不是「预算必然触发」。
   */
  it('正常满额一轮必须能在预算内从容做完，不该被预算截断', () => {
    const pureWaitMs = WORK_QUEUE_LIMIT_MAX * WORK_QUEUE_MIN_REQUEST_INTERVAL_MS;
    assert.ok(
      pureWaitMs < RUN_BUDGET_MS,
      `满额纯等待 ${pureWaitMs}ms 应小于预算 ${RUN_BUDGET_MS}ms，否则每轮都被截断、积压无法收敛`,
    );
    assert.ok(
      pureWaitMs * 2 < RUN_BUDGET_MS,
      '还应留出至少一倍余量给实际请求耗时与解析',
    );
  });

  it('预算仍必须存在：单个病态页的重试可以吃掉数分钟', () => {
    // 大页 WhoRated 超时上限 60s，配合重试与分页，几个页面即可逼近硬超时。
    assert.ok(RUN_BUDGET_MS >= 3 * 60_000, '预算过小会让正常轮次频繁被截断');
    assert.ok(RUN_BUDGET_MS <= 8 * 60_000, '预算过大则失去在硬超时前收敛的意义');
  });
});
