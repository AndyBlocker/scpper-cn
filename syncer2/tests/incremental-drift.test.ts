import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Pool } from 'pg';

import {
  advanceDriftObservation,
  applyL1DriftFloodGate,
  buildL1DriftDispatch,
  classifyL1ProjectionDrift,
  irreconcilableRemoteEvidenceChanged,
  L1_DRIFT_REPAIR_PRIORITY,
} from '../src/collect/l1Drift.js';
import { PRIORITY_AGING_BANDS } from '../src/store/workQueue.js';
import {
  resolveAlignedVoteDriftState,
  resolveNonLiveDriftStates,
} from '../src/store/drift.js';

describe('L1 projection drift reconciliation', () => {
  it('持久漂移修复优先级越过 catch-up 老化带', () => {
    const catchupCeiling = PRIORITY_AGING_BANDS.find((band) => band.minimumPriority === 20)
      ?.ceilingPriority;
    assert.equal(catchupCeiling, 99);
    assert.equal(L1_DRIFT_REPAIR_PRIORITY, 200);
    assert.ok(L1_DRIFT_REPAIR_PRIORITY > catchupCeiling!);
  });

  it('静态差额在 L1 本轮无变化时仍于第二次连续观测入队', () => {
    const first = classifyL1ProjectionDrift(
      { rating: 10, voteCount: 12, revisionCount: 4 },
      { rating: 11, voteCount: 13, revisionClaim: 3 },
    );
    const second = classifyL1ProjectionDrift(
      { rating: 10, voteCount: 12, revisionCount: 4 },
      // 与上一轮完全相同：这正是旧 diff.voteChanges 永远看不到的静态差额。
      { rating: 11, voteCount: 13, revisionClaim: 3 },
    );
    assert.deepEqual(second, first);
    assert.deepEqual(second.map((row) => row.kind), ['votes_full']);

    const advanced = advanceDriftObservation(
      {
        consecutiveObservations: 1,
        lastObservationRunId: 100,
        resolved: false,
      },
      101,
      100,
    );
    assert.deepEqual(advanced, { consecutiveObservations: 2, eligible: true });
  });

  it('单次漂移也生成 p200 延迟确认任务，消解入口最迟一小时到期', () => {
    const first = '2026-08-13T04:49:00.000Z';
    const observed = '2026-08-13T04:49:00.000Z';
    const dispatch = buildL1DriftDispatch(
      ['l1_projection_drift_vote_count'],
      false,
      first,
      observed,
    );
    assert.equal(dispatch.priority, 200);
    assert.equal(dispatch.notBefore, '2026-08-13T05:49:00.000Z');
    assert.ok(dispatch.reasons.includes('l1_projection_drift_confirmation_due'));

    const persistent = buildL1DriftDispatch(
      ['l1_projection_drift_vote_count'],
      true,
      first,
      '2026-08-13T04:54:00.000Z',
    );
    assert.equal(persistent.notBefore, '2026-08-13T04:54:00.000Z');
    assert.ok(persistent.reasons.includes('l1_projection_drift_persistent'));
  });

  it('抓完仍差 1 不使用容差；执行状态机会退避并最终进 irreconcilable', () => {
    const drift = classifyL1ProjectionDrift(
      { rating: 6, voteCount: 9, revisionCount: 1 },
      { rating: 7, voteCount: 9, revisionClaim: 0 },
    );
    assert.equal(drift.length, 1);
    assert.equal(drift[0]!.kind, 'votes_full');
    assert.ok(drift[0]!.reasons.includes('l1_projection_drift_rating'));
    // 三次同哈希的退避/终态由 work-queue.test.ts 的数据库状态机回归覆盖。
  });

  it('终态只在 L1 声明真实变化时重开，run id 变化或缺字段都不重开', () => {
    assert.equal(
      irreconcilableRemoteEvidenceChanged(
        'votes_full',
        { claimed_rating: 7, claimed_total: 9, tier1_run_id: 10 },
        { rating: 7, vote_count: 9 },
      ),
      false,
    );
    assert.equal(
      irreconcilableRemoteEvidenceChanged(
        'votes_full',
        { claimed_rating: 7, claimed_total: 9 },
        { rating: 8, vote_count: 9 },
      ),
      true,
    );
    assert.equal(
      irreconcilableRemoteEvidenceChanged(
        'revisions_full',
        { claimed_total: 3 },
        { revision_claim: 4, expected_revision_count: 5 },
      ),
      true,
    );
    assert.equal(
      irreconcilableRemoteEvidenceChanged(
        'votes_full',
        { tier1_run_id: 10 },
        { rating: 7, vote_count: 9 },
      ),
      false,
    );
  });

  it('超总量闸门时告警、按页面截断且消息写明截断量', () => {
    const candidates = Array.from({ length: 5 }, (_, index) => ({
      pageId: index + 1,
      kind: 'votes_full',
    }));
    // 100 页的 2% 上限是 2；发现 5 页时只放 2 页。
    const gate = applyL1DriftFloodGate(candidates, 100, 5);
    assert.equal(gate.triggered, true);
    assert.equal(gate.limitPages, 2);
    assert.equal(gate.selectedPages, 2);
    assert.equal(gate.truncatedPages, 3);
    assert.match(gate.message ?? '', /明确截断 3 页/);
  });

  it('全部计数一致时不产生任何深扫', () => {
    assert.deepEqual(
      classifyL1ProjectionDrift(
        { rating: 7, voteCount: 9, revisionCount: 4 },
        { rating: 7, voteCount: 9, revisionClaim: 3 },
      ),
      [],
    );
  });

  it('已删/非 live 页的旧 drift 有明确收敛路径', async () => {
    let sql = '';
    let params: unknown[] | undefined;
    const pool = {
      query: async (statement: string, values?: unknown[]) => {
        sql = statement;
        params = values;
        return { rows: [], rowCount: 17 };
      },
    } as unknown as Pool;
    const resolved = await resolveNonLiveDriftStates(
      pool,
      '2026-08-07T12:00:00.000Z',
    );
    assert.equal(resolved, 17);
    assert.match(sql, /NOT EXISTS/);
    assert.match(sql, /pc\.status = 'live'/);
    assert.match(sql, /consecutive_observations = 0/);
    assert.deepEqual(params, ['2026-08-07T12:00:00.000Z']);
  });

  it('完整票扫描后仅在本地投影与 L1 保存值精确相等时立即结账', async () => {
    let sql = '';
    let params: unknown[] | undefined;
    const pool = {
      query: async (statement: string, values?: unknown[]) => {
        sql = statement;
        params = values;
        return { rows: [], rowCount: 1 };
      },
    } as unknown as Pool;
    assert.equal(
      await resolveAlignedVoteDriftState(pool, 123, '2026-08-13T12:30:00.000Z'),
      1,
    );
    assert.match(sql, /pc\.rating = CASE/);
    assert.match(sql, /pc\.vote_up \+ pc\.vote_down = CASE/);
    assert.match(sql, /ds\.remote_value->>'rating'/);
    assert.match(sql, /ds\.resolved_at IS NULL/);
    assert.deepEqual(params, [123, '2026-08-13T12:30:00.000Z']);
  });
});
