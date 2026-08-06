import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ADAPTIVE_EGRESS_POLICY,
  evaluateFailureWindow,
  evaluateRollingBudget,
  isAdaptivePressureFailure,
  type AdaptiveAttemptOutcome,
  type AdaptiveEgressGate,
  type AdaptiveEgressPermit,
  type AdaptiveEgressRuntimeStats,
  type FailureWindowState,
} from '../src/http/adaptiveEgress.js';
import { HttpClient } from '../src/http/client.js';

const T0 = Date.UTC(2026, 7, 5, 0, 0, 0);

function initialState(): FailureWindowState {
  return {
    level: 0,
    reason: 'initial_normal',
    changedAtMs: T0,
    recoverNotBeforeMs: null,
    elevatedWindows: 0,
    healthyWindows: 0,
    budgetBreached: false,
  };
}

function window(
  state: FailureWindowState,
  failures: number,
  completedAtMs: number,
): ReturnType<typeof evaluateFailureWindow> {
  return evaluateFailureWindow(state, {
    requests: ADAPTIVE_EGRESS_POLICY.windowRequests,
    failures,
    completedAtMs,
  });
}

test('失败率缓慢上升：连续两个 2%+ 窗口在危险区前降档', () => {
  const safe = window(initialState(), 1, T0 + 1_000);
  assert.equal(safe.state.level, 0, '0.6% 安全点附近的一次失败不能降档');

  const elevated = window(safe.state, 2, T0 + 2_000);
  assert.equal(elevated.state.level, 0, '第一个 2% 窗口只建立趋势证据');
  assert.equal(elevated.state.elevatedWindows, 1);

  const rising = window(elevated.state, 3, T0 + 3_000);
  assert.equal(rising.state.level, 1);
  assert.equal(rising.transition?.kind, 'failure_backoff');
  assert.equal(rising.failureRate, 0.03);
  assert.ok(rising.failureRate < 0.226, '必须远早于实测 22.6% 危险区');
});

test('单轮抖动：4% 后恢复健康，不牺牲正常档新鲜度', () => {
  const jitter = window(initialState(), 4, T0 + 1_000);
  assert.equal(jitter.state.level, 0);
  assert.equal(jitter.state.elevatedWindows, 1);
  assert.equal(jitter.transition, null);

  const healthy = window(jitter.state, 0, T0 + 2_000);
  assert.equal(healthy.state.level, 0);
  assert.equal(healthy.state.elevatedWindows, 0);
  assert.equal(healthy.transition, null);
});

test('容量失败口径排除预期 404，但纳入 transport/429/5xx', () => {
  assert.equal(isAdaptivePressureFailure(null), true);
  assert.equal(isAdaptivePressureFailure(429), true);
  assert.equal(isAdaptivePressureFailure(500), true);
  assert.equal(isAdaptivePressureFailure(503), true);
  assert.equal(isAdaptivePressureFailure(200), false);
  assert.equal(isAdaptivePressureFailure(302), false);
  assert.equal(isAdaptivePressureFailure(404), false);
});

test('踩线后持续失败：冷却从最后坏窗口重算，六轮健康后也只升一档', () => {
  let state = initialState();
  for (let i = 1; i <= 3; i++) {
    state = window(state, 10, T0 + i * 1_000).state;
  }
  assert.equal(state.level, 3, '三个严重窗口逐档进入 cooldown');

  const firstRecoverAt = state.recoverNotBeforeMs!;
  const sustainedAt = T0 + 30 * 60_000;
  state = window(state, 20, sustainedAt).state;
  assert.equal(state.level, 3);
  assert.ok(state.recoverNotBeforeMs! > firstRecoverAt, '持续失败必须延后恢复时钟');

  // 冷却尚未结束：再多好窗口也不能预攒恢复积分。
  for (let i = 1; i <= 8; i++) {
    state = window(state, 0, sustainedAt + i * 1_000).state;
  }
  assert.equal(state.level, 3);
  assert.equal(state.healthyWindows, 0);

  const afterCooldown = state.recoverNotBeforeMs! + 1;
  for (let i = 1; i <= 5; i++) {
    state = window(state, 0, afterCooldown + i * 1_000).state;
    assert.equal(state.level, 3);
  }
  const recovered = window(state, 0, afterCooldown + 6_000);
  assert.equal(recovered.state.level, 2, '恢复一次只升一档，不能跳回 normal');
  assert.equal(recovered.transition?.kind, 'recovery');

  const immediateGood = window(recovered.state, 0, afterCooldown + 7_000);
  assert.equal(immediateGood.state.level, 2, '新档仍有独立冷却，禁止反复试探');
  assert.equal(immediateGood.state.healthyWindows, 0);
});

test('滚动小时超 3,200：强制 cooldown、只在首次越界告警', () => {
  const atLimit = evaluateRollingBudget(initialState(), 3_200, T0);
  assert.equal(atLimit.state.level, 0);
  assert.equal(atLimit.transition, null);

  const breached = evaluateRollingBudget(atLimit.state, 3_201, T0 + 1_000);
  assert.equal(breached.state.level, 3);
  assert.equal(breached.state.budgetBreached, true);
  assert.equal(breached.transition?.kind, 'budget_breach');
  assert.match(breached.state.reason, /3201_gt_3200/);

  const stillBreached = evaluateRollingBudget(breached.state, 3_250, T0 + 2_000);
  assert.equal(stillBreached.state.level, 3);
  assert.equal(stillBreached.transition, null, '同一越界期不能每请求重复告警');
  assert.ok(
    stillBreached.state.recoverNotBeforeMs! > breached.state.recoverNotBeforeMs!,
    '预算仍超限时继续后推冷却',
  );
});

test('HttpClient 摘要可读出档位、退让原因与最早恢复时刻', async () => {
  const fake = new ObservableFakeGate();
  const client = new HttpClient({
    userAgent: 'adaptive-egress-test/1',
    referer: 'https://example.test/',
    adaptiveEgress: fake,
  });
  try {
    const adaptive = client.stats().adaptiveEgress;
    assert.equal(adaptive?.state?.levelName, 'protective');
    assert.equal(adaptive?.state?.reason, 'test_failure_trend');
    assert.equal(adaptive?.state?.recoverNotBefore, '2026-08-05T01:00:00.000Z');
    assert.equal(adaptive?.state?.healthyWindows, 2);
    assert.equal(adaptive?.state?.healthyWindowsRequired, 6);
    assert.equal(adaptive?.state?.rollingHourRequests, 2_950);
    assert.equal(adaptive?.state?.budgetLimit, 3_200);
  } finally {
    await client.close();
  }
});

class ObservableFakeGate implements AdaptiveEgressGate {
  async beforeAttempt(): Promise<AdaptiveEgressPermit> {
    throw new Error('本测试不发请求');
  }

  async afterAttempt(
    _permit: AdaptiveEgressPermit,
    _outcome: AdaptiveAttemptOutcome,
  ): Promise<void> {
    throw new Error('本测试不发请求');
  }

  stats(): AdaptiveEgressRuntimeStats {
    return {
      channel: 'test',
      permits: 0,
      totalDelayMs: 0,
      transitionsObserved: 1,
      state: {
        siteKey: 'wikidot',
        level: 2,
        levelName: 'protective',
        minRequestIntervalMs: 2_000,
        reason: 'test_failure_trend',
        changedAt: '2026-08-05T00:00:00.000Z',
        recoverNotBefore: '2026-08-05T01:00:00.000Z',
        currentWindowRequests: 20,
        currentWindowFailures: 0,
        elevatedWindows: 0,
        healthyWindows: 2,
        healthyWindowsRequired: 6,
        lastWindowFailureRate: 0,
        lastWindowCompletedAt: '2026-08-05T00:30:00.000Z',
        rollingHourRequests: 2_950,
        budgetLimit: 3_200,
        budgetBreached: false,
        updatedAt: '2026-08-05T00:30:00.000Z',
      },
    };
  }

  async close(): Promise<void> {}
}
