import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

import {
  ADAPTIVE_EGRESS_POLICY,
  applyConnectionPressureBackoff,
  evaluateConnectionPressure,
  evaluateFailureWindow,
  evaluateL1FreshnessSlo,
  evaluateProportionalBudget,
  evaluateRecoveryEvidence,
  isAdaptivePressureFailure,
  type AdaptiveAttemptOutcome,
  type AdaptiveEgressGate,
  type AdaptiveEgressPermit,
  type AdaptiveEgressRuntimeStats,
  type FailureWindowState,
  type ConnectionPressureState,
  type BudgetControlState,
  type RecoveryWindowState,
} from '../src/http/adaptiveEgress.js';
import {
  assertEgressBudgetCapacity,
  channelQuotaMinIntervalMs,
  checkEgressBudgetCapacity,
  WIKIDOT_EGRESS_CHANNEL_QUOTAS,
  WIKIDOT_EGRESS_CHANNEL_QUOTA_TOTAL,
  wikidotEgressChannelQuota,
} from '../src/http/egressCapacity.js';
import { evaluateEgressAccountingReconciliation } from '../src/observability/egressAccounting.js';
import { HttpClient } from '../src/http/client.js';
import {
  classifyWorkFailure,
  deterministicEgressFailureClass,
} from '../src/work/failurePolicy.js';

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
  deterministicFailures = 0,
): ReturnType<typeof evaluateFailureWindow> {
  return evaluateFailureWindow(state, {
    requests: ADAPTIVE_EGRESS_POLICY.windowRequests,
    failures,
    deterministicFailures,
    completedAtMs,
  });
}

test('生产 pressure 合同固定为 5%/10%/3%，容量预算由链路计划推导为 5,400', () => {
  assert.equal(ADAPTIVE_EGRESS_POLICY.elevatedFailureRate, 0.05);
  assert.equal(ADAPTIVE_EGRESS_POLICY.severeFailureRate, 0.10);
  assert.equal(ADAPTIVE_EGRESS_POLICY.healthyFailureRate, 0.03);
  assert.equal(ADAPTIVE_EGRESS_POLICY.rollingBudgetRequests, 5_400);
  assert.equal(ADAPTIVE_EGRESS_POLICY.recoveryWindowMs, 5 * 60_000);
  assert.equal(ADAPTIVE_EGRESS_POLICY.connectionFailureStreakToBackoff, 5);
  assert.equal(ADAPTIVE_EGRESS_POLICY.connectionFailureStreakWindowMs, 120_000);
  assert.equal(ADAPTIVE_EGRESS_POLICY.connectionBackoffMinIntervalMs, 300_000);
});

test('五组通道配额由门统一决策，L1 预留不被 forum/work/image 借用', () => {
  assert.equal(WIKIDOT_EGRESS_CHANNEL_QUOTA_TOTAL, 5_400);
  assert.deepEqual(
    Object.fromEntries(WIKIDOT_EGRESS_CHANNEL_QUOTAS.map((item) => [item.group, item.requestsPerHour])),
    { l1: 2_100, forum: 900, 'work-queue': 1_300, image: 300, background: 800 },
  );
  assert.equal(wikidotEgressChannelQuota('l1').group, 'l1');
  assert.equal(wikidotEgressChannelQuota('forum').group, 'forum');
  assert.equal(wikidotEgressChannelQuota('work-queue:restricted-7890').group, 'work-queue');
  assert.equal(wikidotEgressChannelQuota('image-sample').group, 'image');
  assert.equal(wikidotEgressChannelQuota('revision-source').group, 'background');
  assert.equal(wikidotEgressChannelQuota('resolve-pages').group, 'background');
});

test('forum 提速后的正常档仍给 L1 五分钟轮次留下确定性门等待余量', () => {
  const l1 = wikidotEgressChannelQuota('l1');
  const l1IntervalMs = channelQuotaMinIntervalMs(l1.requestsPerHour);
  const l1AttemptsPerRound = 145;
  const gateSpanMs = (l1AttemptsPerRound - 1) * l1IntervalMs;
  assert.equal(l1IntervalMs, 1_715);
  assert.ok(gateSpanMs < 5 * 60_000);
  assert.ok(5 * 60_000 - gateSpanMs > 50_000, 'L1 正常档门等待应保留超过 50s 余量');
  assert.equal(wikidotEgressChannelQuota('forum').requestsPerHour, 900);
  assert.notEqual(wikidotEgressChannelQuota('forum').group, l1.group);
});

function connectionFailures(
  windowState: FailureWindowState,
  connectionState: ConnectionPressureState,
  count: number,
  firstAtMs: number,
): { windowState: FailureWindowState; connectionState: ConnectionPressureState } {
  let nextWindow = windowState;
  let nextConnection = connectionState;
  for (let i = 0; i < count; i++) {
    const atMs = firstAtMs + i;
    const observed = evaluateConnectionPressure(nextConnection, true, atMs);
    const applied = applyConnectionPressureBackoff(nextWindow, observed, 1, atMs);
    nextWindow = applied.state;
    nextConnection = applied.connectionState;
  }
  return { windowState: nextWindow, connectionState: nextConnection };
}

test('大批连接重置：100-request 窗未满也能看见并逐级降档', () => {
  const initialConnection: ConnectionPressureState = {
    failureStreak: 0,
    lastFailureAtMs: null,
    lastBackoffAtMs: null,
  };
  const firstBurst = connectionFailures(initialState(), initialConnection, 5, T0);
  assert.equal(firstBurst.windowState.level, 1, '第五个真实无响应 attempt 必须触发 L1');
  assert.match(firstBurst.windowState.reason, /connection_failure_streak_5/);

  const secondBurst = connectionFailures(
    firstBurst.windowState,
    firstBurst.connectionState,
    5,
    T0 + 5 * 60_000,
  );
  assert.equal(secondBurst.windowState.level, 2);
  const persistent = connectionFailures(
    secondBurst.windowState,
    secondBurst.connectionState,
    5,
    T0 + 10 * 60_000,
  );
  assert.equal(persistent.windowState.level, 3, '跨 10 分钟持续不可用最终必须可达 cooldown');
});

test('一次瞬时连接抖动：141 个派生失败也不会瞬间打到最高档或拿到长冷却', () => {
  const burst = connectionFailures(
    initialState(),
    { failureStreak: 0, lastFailureAtMs: null, lastBackoffAtMs: null },
    141,
    T0,
  );
  assert.equal(burst.windowState.level, 1);
  assert.equal(
    burst.windowState.recoverNotBeforeMs,
    T0 + 4 + 30 * 60_000,
    '同一 burst 只消费一次逐级降档，保持期只能是 L1 的 30 分钟',
  );
});

test('两视角失败率持续背离：441/2968 vs 5/3348 在巡检中成为 critical', () => {
  const decision = evaluateEgressAccountingReconciliation(
    { ingestFailures: 441, ingestTotal: 2_968, egressFailures: 5, egressTotal: 3_348 },
    T0 + 60 * 60_000,
    { status: 'divergent', divergentSinceMs: T0 },
  );
  assert.equal(decision.status, 'divergent');
  assert.equal(decision.severity, 'critical');
  assert.ok(decision.absoluteRateGap! > 0.14);
  assert.ok(decision.rateRatio! > 80);
});

test('失败率缓慢上升：连续两个 5%+ 窗口在危险区前降档', () => {
  const safe = window(initialState(), 1, T0 + 1_000);
  assert.equal(safe.state.level, 0, '1% 常态噪声不能降档');

  const elevated = window(safe.state, 5, T0 + 2_000);
  assert.equal(elevated.state.level, 0, '第一个 5% 窗口只建立趋势证据');
  assert.equal(elevated.state.elevatedWindows, 1);

  const rising = window(elevated.state, 5, T0 + 3_000);
  assert.equal(rising.state.level, 1);
  assert.equal(rising.transition?.kind, 'failure_backoff');
  assert.equal(rising.failureRate, 0.05);
  assert.ok(rising.failureRate < 0.226, '必须远早于实测 22.6% 危险区');
});

test('单轮抖动：4% 单窗后恢复健康，不牺牲正常档新鲜度', () => {
  const jitter = window(initialState(), 4, T0 + 1_000);
  assert.equal(jitter.state.level, 0);
  assert.equal(jitter.state.elevatedWindows, 0);
  assert.equal(jitter.transition, null);

  const healthy = window(jitter.state, 0, T0 + 2_000);
  assert.equal(healthy.state.level, 0);
  assert.equal(healthy.state.elevatedWindows, 0);
  assert.equal(healthy.transition, null);
});

test('确定性失败占多数但站点健康：不降档，已降档也能在六窗内恢复', () => {
  let healthy = initialState();
  for (let i = 1; i <= 2; i++) {
    const decision = window(healthy, 1, T0 + i * 1_000, 70);
    healthy = decision.state;
    assert.equal(decision.failureRate, 0.01);
    assert.equal(decision.transition, null);
    assert.equal(healthy.level, 0);
  }

  let recovering: FailureWindowState = {
    ...initialState(),
    level: 1,
    reason: 'test_backoff',
    recoverNotBeforeMs: T0 + 30 * 60_000,
  };
  for (let i = 1; i <= 6; i++) {
    recovering = window(
      recovering,
      1,
      T0 + 30 * 60_000 + i * 1_000,
      70,
    ).state;
  }
  assert.equal(recovering.level, 0, '确定性失败不清零冷却后的健康窗');
});

test('站点真的在拒绝：22% 单窗立即降档，连续严重窗口仍及时进入 cooldown', () => {
  let state = initialState();
  for (let i = 1; i <= 3; i++) {
    const decision = window(state, 22, T0 + i * 1_000);
    assert.equal(decision.transition?.kind, 'failure_backoff');
    state = decision.state;
  }
  assert.equal(state.level, 3);
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

test('HttpClient 等既有 work failure 分类后，空体 500 改记确定性而非压力', async () => {
  const server = createServer((_req, res) => {
    res.writeHead(500).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('测试 server 未监听 TCP');
  const gate = new RecordingGate();
  const client = new HttpClient({
    userAgent: 'adaptive-egress-classification-test/1',
    referer: 'https://example.test/',
    adaptiveEgress: gate,
    maxAttempts: 1,
  });
  try {
    client.beginAdaptiveOutcomeClassification();
    await assert.rejects(
      client.get(`http://127.0.0.1:${address.port}/ajax-module-connector.php`, 'votes:full'),
      /HTTP 500/,
    );
    assert.equal(gate.outcomes.length, 0, '既有业务分类前不能抢先污染压力窗口');

    const policy = classifyWorkFailure(
      'votes_full',
      `HttpStatusError: HTTP 500 for http://127.0.0.1:${address.port}/ajax-module-connector.php`,
    );
    await client.finishAdaptiveOutcomeClassification(
      deterministicEgressFailureClass(policy),
    );
    assert.equal(gate.outcomes.length, 1);
    assert.equal(gate.outcomes[0]?.ok, true);
    assert.match(gate.outcomes[0]?.deterministicFailureClass ?? '', /identity_absent/);
  } finally {
    await client.close();
    await new Promise<void>((resolve, reject) =>
      server.close((err) => err ? reject(err) : resolve()),
    );
  }
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

  // 保持期内累计健康证据，但绝不提前升档。
  for (let i = 1; i <= 6; i++) {
    state = window(state, 0, sustainedAt + i * 1_000).state;
  }
  assert.equal(state.level, 3);
  assert.equal(state.healthyWindows, 6);

  const afterCooldown = state.recoverNotBeforeMs! + 1;
  const recovered = window(state, 0, afterCooldown);
  assert.equal(recovered.state.level, 2, '恢复一次只升一档，不能跳回 normal');
  assert.equal(recovered.transition?.kind, 'recovery');

  const immediateGood = window(recovered.state, 0, afterCooldown + 1_000);
  assert.equal(immediateGood.state.level, 2, '新档仍有独立冷却，禁止反复试探');
  assert.equal(immediateGood.state.healthyWindows, 1);
});

test('超预算 1 个请求：只进独立 budget level 1，以恰好预算 pace 比例压回', () => {
  const initialBudget: BudgetControlState = {
    level: 0,
    reason: 'within_budget',
    changedAtMs: T0,
    minRequestIntervalMs: 333,
    throttleRatio: 1,
  };
  const atLimit = evaluateProportionalBudget(initialBudget, 5_400, T0);
  assert.equal(atLimit.state.level, 0);
  assert.equal(atLimit.transition, null);

  const breached = evaluateProportionalBudget(atLimit.state, 5_401, T0 + 1_000);
  assert.equal(breached.state.level, 1, '我方容量越界不得跳 pressure level 2/3');
  assert.equal(breached.transition?.kind, 'budget_breach');
  assert.equal(breached.state.minRequestIntervalMs, 667);
  assert.ok(3_600_000 / breached.state.minRequestIntervalMs <= 5_400);
  assert.equal(breached.state.throttleRatio, 5_400 / 5_401);
  assert.match(breached.state.reason, /5401_gt_5400_proportional/);

  const recovered = evaluateProportionalBudget(breached.state, 5_400, T0 + 2_000);
  assert.equal(recovered.state.level, 0, '预算回落立即解除，不等待 pressure 冷却/六窗');
  assert.equal(recovered.transition?.kind, 'budget_recovery');
});

test('大幅超预算：比例因子按越界程度收缩，目标 pace 仍不超过预算', () => {
  const initialBudget: BudgetControlState = {
    level: 0,
    reason: 'within_budget',
    changedAtMs: T0,
    minRequestIntervalMs: 333,
    throttleRatio: 1,
  };
  const doubled = evaluateProportionalBudget(initialBudget, 10_800, T0 + 1_000);
  assert.equal(doubled.state.level, 1);
  assert.equal(doubled.state.throttleRatio, 0.5);
  assert.ok(3_600_000 / doubled.state.minRequestIntervalMs <= 5_400);
  assert.notEqual(doubled.state.level, 3);
});

test('冷却结束后常态噪声 1%：六个窗口完成恢复', () => {
  let state: FailureWindowState = {
    ...initialState(),
    level: 1,
    reason: 'test_backoff',
    recoverNotBeforeMs: T0 + 30 * 60_000,
  };
  for (let i = 1; i <= 6; i++) {
    const decision = window(state, 1, T0 + 30 * 60_000 + i * 1_000);
    state = decision.state;
    if (i < 6) assert.equal(state.level, 1);
  }
  assert.equal(state.level, 0);
});

test('pressure 降档后低吞吐：六个非空 5 分钟窗在一小时保持期内积累并恢复', () => {
  let state: FailureWindowState = {
    ...initialState(),
    level: 3,
    reason: 'test_pressure_cooldown',
    changedAtMs: T0,
    recoverNotBeforeMs: T0 + 60 * 60_000,
  };
  let recovery: RecoveryWindowState = { startedAtMs: null, requests: 0, failures: 0 };

  // 只有 7 个健康请求，每 5 分钟一个；旧逻辑需要 600 个请求。
  for (let minute = 1; minute <= 31; minute += 5) {
    const decision = evaluateRecoveryEvidence(
      state,
      recovery,
      false,
      T0 + minute * 60_000,
    );
    state = decision.state;
    recovery = decision.window;
  }
  assert.equal(state.level, 3, '健康证据可在保持期内积累但不能提前恢复');
  assert.equal(state.healthyWindows, 6);

  const afterHold = evaluateRecoveryEvidence(
    state,
    recovery,
    false,
    T0 + 60 * 60_000 + 1,
  );
  assert.equal(afterHold.state.level, 2);
  assert.equal(afterHold.transition?.kind, 'recovery');
});

test('预算容量检查：4,200 无法容纳已启用链路，5,400 通过', () => {
  const insufficient = checkEgressBudgetCapacity(4_200);
  assert.equal(insufficient.steadyRequestsPerHour, 4_657);
  assert.equal(insufficient.requiredBudgetRequestsPerHour, 5_400);
  assert.equal(insufficient.sufficient, false);
  assert.equal(insufficient.shortfallRequestsPerHour, 1_200);
  assert.throws(() => assertEgressBudgetCapacity(4_200), /出口预算不足/);
  assert.equal(assertEgressBudgetCapacity(5_400).sufficient, true);
});

test('降档让 L1 轮次超过五分钟：预期恢复期内有 SLO 信号但 exit 0，超期才 exit 1', () => {
  const expected = evaluateL1FreshnessSlo({
    previousStartedAtMs: T0,
    currentStartedAtMs: T0 + 30 * 60_000,
    level: 3,
    levelChangedAtMs: T0,
  });
  assert.equal(expected.status, 'degraded_expected');
  assert.equal(expected.exitCode, 0);
  assert.equal(expected.gapMs, 30 * 60_000);
  assert.ok(expected.expectedRecoveryAtMs! > T0 + 30 * 60_000);

  const overdue = evaluateL1FreshnessSlo({
    previousStartedAtMs: T0 + 149 * 60_000,
    currentStartedAtMs: T0 + 156 * 60_000,
    level: 3,
    levelChangedAtMs: T0,
    existingDegradedSinceMs: expected.degradedSinceMs,
    existingExpectedRecoveryAtMs: expected.expectedRecoveryAtMs,
  });
  assert.equal(overdue.status, 'degraded_overdue');
  assert.equal(overdue.exitCode, 1);
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
    assert.equal(adaptive?.state?.budgetLimit, 5_400);
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
        pressureLevel: 2,
        pressureReason: 'test_failure_trend',
        pressureChangedAt: '2026-08-05T00:00:00.000Z',
        pressureRecoverNotBefore: '2026-08-05T01:00:00.000Z',
        budgetLevel: 0,
        budgetReason: 'within_budget',
        budgetChangedAt: '2026-08-05T00:00:00.000Z',
        budgetMinRequestIntervalMs: 333,
        budgetThrottleRatio: 1,
        currentWindowRequests: 20,
        currentWindowFailures: 0,
        currentWindowConnectionFailures: 0,
        currentWindowDeterministicFailures: 3,
        connectionFailureStreak: 0,
        lastConnectionFailureAt: null,
        lastConnectionBackoffAt: null,
        elevatedWindows: 0,
        healthyWindows: 2,
        healthyWindowsRequired: 6,
        recoveryWindowMinutes: 5,
        recoveryWindowStartedAt: '2026-08-05T00:25:00.000Z',
        recoveryWindowRequests: 20,
        recoveryWindowFailures: 0,
        lastWindowFailureRate: 0,
        lastWindowConnectionFailureRate: 0,
        lastWindowDeterministicFailureRate: 0.02,
        lastWindowCompletedAt: '2026-08-05T00:30:00.000Z',
        rollingHourRequests: 2_950,
        budgetLimit: 5_400,
        budgetBreached: false,
        l1LastStartedAt: '2026-08-05T00:00:00.000Z',
        l1SloDegradedSince: null,
        l1SloExpectedRecoveryAt: null,
        l1SloLastGapSeconds: 300,
        l1SloOverdue: false,
        updatedAt: '2026-08-05T00:30:00.000Z',
      },
    };
  }

  async close(): Promise<void> {}
}

class RecordingGate implements AdaptiveEgressGate {
  readonly outcomes: AdaptiveAttemptOutcome[] = [];

  async beforeAttempt(): Promise<AdaptiveEgressPermit> {
    return {
      bucketStart: '2026-08-05T00:00:00.000Z',
      channel: 'test',
      grantAt: '2026-08-05T00:00:00.000Z',
    };
  }

  async afterAttempt(
    _permit: AdaptiveEgressPermit,
    outcome: AdaptiveAttemptOutcome,
  ): Promise<void> {
    this.outcomes.push(outcome);
  }

  stats(): AdaptiveEgressRuntimeStats {
    return {
      channel: 'test',
      permits: 1,
      totalDelayMs: 0,
      transitionsObserved: 0,
      state: null,
    };
  }

  async close(): Promise<void> {}
}
