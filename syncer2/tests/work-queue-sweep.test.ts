import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, test } from 'node:test';

import { SQL_TUNING_CONSTANTS } from '../src/health/sqlTuning.js';
import {
  activeVoteSeedLane,
  availableHourlySeedBudget,
  hourlyVoteSweepQuota,
  nextVoteSweepDueAt,
  VOTE_CATCHUP_RATE_PER_HOUR,
  VOTE_SWEEP_INTERVAL_DAYS,
  NEW_PAGE_INTERVAL_HOURS,
  NEW_PAGE_WINDOW_DAYS,
} from '../src/store/workQueue.js';

const SNAPSHOT = '2026-07-28T00:00:00.000Z';
const DAY_MS = 86_400_000;

function dueSet(pageIds: readonly number[], now: string, intervalDays: number): Set<number> {
  const nowMs = Date.parse(now);
  return new Set(
    pageIds.filter((pageId) => Date.parse(nextVoteSweepDueAt(SNAPSHOT, pageId, intervalDays)) <= nowMs),
  );
}

describe('vote sweep 稳定相位', () => {
  test('修改周期会改变实际合格页集合，SQL 周期来自参数而非字面量', async () => {
    const pageIds = Array.from({ length: 10_000 }, (_, index) => index + 1);
    const atDay12 = '2026-08-09T00:00:00.000Z';
    const configured = dueSet(pageIds, atDay12, VOTE_SWEEP_INTERVAL_DAYS);
    const shortened = dueSet(pageIds, atDay12, 15);

    assert.notDeepEqual([...configured], [...shortened]);
    assert.ok(shortened.size > configured.size);

    const source = await readFile(new URL('../src/store/workQueue.ts', import.meta.url), 'utf8');
    const seedSection = source.slice(
      source.indexOf('export async function seedVoteTasks'),
      source.indexOf('export async function seedConventionTasks'),
    );
    assert.match(seedSection, /\$3::bigint \* 86400000::bigint/);
    assert.match(
      seedSection,
      /bindSqlTuning\('NEW_PAGE_WINDOW_DAYS', newPageWindowDays\)/,
    );
    assert.match(
      seedSection,
      /bindSqlTuning\('VOTE_SWEEP_INTERVAL_DAYS', sweepIntervalDays\)/,
    );
    assert.match(seedSection, /FROM serve\.page_current pc/);
    assert.doesNotMatch(
      seedSection,
      /serve\.vote_current|recent_activity|last_vote_at|voteClaimEvidenceExists/,
      '30 天盲扫 cohort 必须由全部 live 页定义，不能用采集自身产生的投票活动反向过滤',
    );
    assert.match(
      seedSection,
      /ps\.kind = 'votes'[\s\S]*ps\.status = 'ok'[\s\S]*NEW_PAGE_INTERVAL_HOURS/,
      '高频播种必须有独立于快照字段的最近成功证据闸',
    );
    assert.doesNotMatch(seedSection, /interval '(?:90 days|7 days|3 hours)'/);
    assert.equal(NEW_PAGE_WINDOW_DAYS, 7);
    assert.equal(NEW_PAGE_INTERVAL_HOURS, 3);
    assert.match(
      SQL_TUNING_CONSTANTS.VOTE_SWEEP_INTERVAL_DAYS.reason,
      /全部 live 页.*最长兜底周期/,
    );
  });

  test('全站快照同一秒时，到期被铺满整个周期而不是同日惊群', () => {
    const total = 36_532;
    const daily = Array.from({ length: VOTE_SWEEP_INTERVAL_DAYS }, () => 0);
    const snapshotMs = Date.parse(SNAPSHOT);
    for (let pageId = 1; pageId <= total; pageId++) {
      const dueMs = Date.parse(nextVoteSweepDueAt(SNAPSHOT, pageId));
      const bucket = Math.min(
        daily.length - 1,
        Math.floor((dueMs - snapshotMs) / DAY_MS),
      );
      daily[bucket]!++;
    }

    const target = total / VOTE_SWEEP_INTERVAL_DAYS;
    assert.equal(daily.reduce((sum, count) => sum + count, 0), total);
    assert.ok(Math.max(...daily) < target * 1.12, `max=${Math.max(...daily)}, target=${target}`);
    assert.ok(Math.min(...daily) > target * 0.88, `min=${Math.min(...daily)}, target=${target}`);
    assert.ok(Math.max(...daily) < total / 20);
  });
});

describe('vote sweep 墙钟预算与车道切换', () => {
  function simulate(rounds: number, quota: number): number {
    let used = 0;
    for (let i = 0; i < rounds; i++) {
      used += availableHourlySeedBudget(quota, used, 100_000);
    }
    return used;
  }

  test('轮次频率翻倍不改变同一小时播种总量', () => {
    const quota = hourlyVoteSweepQuota(36_532, 30, '2026-08-04T12:00:00.000Z');
    assert.ok(quota === 50 || quota === 51);
    assert.equal(simulate(12, quota), quota);
    assert.equal(simulate(24, quota), quota);
    assert.equal(simulate(12, VOTE_CATCHUP_RATE_PER_HOUR), VOTE_CATCHUP_RATE_PER_HOUR);
    assert.equal(simulate(24, VOTE_CATCHUP_RATE_PER_HOUR), VOTE_CATCHUP_RATE_PER_HOUR);
  });

  test('整周期小时额度总和等于合格总量', () => {
    const total = 36_532;
    const start = Date.parse('2026-08-01T00:00:00.000Z');
    let granted = 0;
    for (let hour = 0; hour < 30 * 24; hour++) {
      granted += hourlyVoteSweepQuota(total, 30, start + hour * 3_600_000);
    }
    assert.equal(granted, total);
  });

  test('追平和稳态 reason/预算可区分，追平归零后自动降速', async () => {
    assert.equal(activeVoteSeedLane(1), 'catchup');
    assert.equal(activeVoteSeedLane(0), 'sweep');
    const steady = hourlyVoteSweepQuota(36_532, 30, '2026-08-04T12:00:00.000Z');
    assert.ok(VOTE_CATCHUP_RATE_PER_HOUR > steady * 16);

    const source = await readFile(new URL('../src/store/workQueue.ts', import.meta.url), 'utf8');
    assert.match(source, /votes_v2_initial_catchup/);
    assert.match(source, /votes_sweep_stable_phase/);
    assert.match(source, /activeLane === 'catchup'[\s\S]*catchupRate[\s\S]*hourlyVoteSweepQuota/);
    assert.match(source, /AS catchup_queued/);
    assert.match(source, /AS catchup_seedable/);
    assert.match(
      source,
      /activeLane === 'catchup' \? catchupSeedable : eligiblePages/,
      '已在队列的追平页不应被误当成本轮可新建需求',
    );

    const migration = await readFile(
      new URL('../migrations/0035_vote_sweep_scheduler.sql', import.meta.url),
      'utf8',
    );
    assert.match(migration, /ir\.stats ->> 'mode' = 'tier2'/);
    assert.match(migration, /ir\.stats ->> 'domain' = 'work_queue'/);
    assert.doesNotMatch(migration, /ir\.stats ->> 'mode' = 'tier2_replay'/);
  });
});
