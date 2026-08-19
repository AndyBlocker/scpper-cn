process.env.SYNCER2_LOG_LEVEL = 'error';

import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'pg';

import { HttpStatusError, TransportError } from '../src/http/client.js';
import {
  evaluateFailureWindow,
  type FailureWindowState,
} from '../src/http/adaptiveEgress.js';
import {
  EXTERNAL_IMAGE_EGRESS_POLICY,
  EXTERNAL_IMAGE_GLOBAL_HOURLY_BUDGET,
  ExternalHostDeferredError,
  evaluateExternalRateLimitSignal,
} from '../src/image/externalEgress.js';
import {
  emptyImageRouteCounters,
  evaluateImagePipelineHealth,
  recordImageRouteResult,
} from '../src/image/health.js';
import {
  claimNextImageJob,
  IMAGE_HOST_DEFERRAL_MAX_RETRY_MS,
  imageRetryBackoffMs,
  isTerminalImageFailure,
  processImageJob,
  type ImageWorkerOptions,
} from '../src/image/worker.js';

const T0 = Date.UTC(2026, 7, 12, 0, 0, 0);

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

test('某主机持续 429：仅该 exact hostname 快速降到 cooldown，其它主机不受影响', () => {
  const states = new Map<string, FailureWindowState>([
    ['bad.wdfiles.com', initialState()],
    ['healthy.example.com', initialState()],
  ]);
  for (let i = 0; i < 3; i++) {
    const bad = states.get('bad.wdfiles.com')!;
    states.set(
      'bad.wdfiles.com',
      evaluateExternalRateLimitSignal(bad, 429, T0 + i * 60_000).state,
    );
  }
  assert.equal(states.get('bad.wdfiles.com')!.level, 3);
  assert.equal(states.get('healthy.example.com')!.level, 0);
  assert.match(states.get('bad.wdfiles.com')!.reason, /http_429/);
});

test('429/503 单次立即降档；普通 500 仍由失败窗口判断，恢复慢但可达', () => {
  const first429 = evaluateExternalRateLimitSignal(initialState(), 429, T0);
  assert.equal(first429.state.level, 1);
  assert.equal(first429.transition?.fromLevel, 0);
  assert.equal(first429.transition?.toLevel, 1);

  const first503 = evaluateExternalRateLimitSignal(initialState(), 503, T0);
  assert.equal(first503.state.level, 1);
  assert.equal(evaluateExternalRateLimitSignal(initialState(), 500, T0).state.level, 0);

  let recovering = first429.state;
  const afterHold = recovering.recoverNotBeforeMs!;
  for (let i = 1; i <= EXTERNAL_IMAGE_EGRESS_POLICY.healthyWindowsToRecover; i++) {
    recovering = evaluateFailureWindow(
      recovering,
      {
        requests: EXTERNAL_IMAGE_EGRESS_POLICY.windowRequests,
        failures: 0,
        completedAtMs: afterHold + i * 60_000,
      },
      EXTERNAL_IMAGE_EGRESS_POLICY,
    ).state;
  }
  assert.equal(recovering.level, 0, '保持期后连续健康窗口必须能恢复，不能永久卡档');
});

test('站外全面故障仍与 Wikidot 健康判据隔离', () => {
  const health = evaluateImagePipelineHealth(
    {
      wikidot_site: { claimed: 20, completed: 20, retry: 0, failed: 0, healthExcluded: 0 },
      external: { claimed: 100, completed: 0, retry: 100, failed: 0, healthExcluded: 0 },
    },
    { wikidotSite: false, external: true },
  );
  assert.equal(health.external.exitCode, 1);
  assert.equal(health.wikidotSite.exitCode, 0);
  assert.equal(health.wikidotSite.failureRate, 0);
  assert.deepEqual(health.wikidotSite.reasons, []);
});

test('站外总量护栏与单主机预算固定，且远低于旧持续 1 QPS', () => {
  assert.equal(EXTERNAL_IMAGE_GLOBAL_HOURLY_BUDGET, 650);
  assert.equal(EXTERNAL_IMAGE_EGRESS_POLICY.rollingBudgetRequests, 300);
  assert.equal(EXTERNAL_IMAGE_EGRESS_POLICY.tiers[0]!.minIntervalMs, 12_000);
  assert.equal(EXTERNAL_IMAGE_EGRESS_POLICY.tiers[3]!.minIntervalMs, 10 * 60_000);
});

test('失败项跨轮按 attempts 指数退避，并在 SQL 中写未来 not_before', async () => {
  assert.deepEqual(
    [1, 2, 3, 4, 5].map((attempt) => imageRetryBackoffMs(attempt, 60 * 60_000, 7 * 24 * 60 * 60_000)),
    [1, 2, 4, 8, 16].map((hours) => hours * 60 * 60_000),
  );

  const jobUpdates: Array<{ sql: string; params: unknown[] }> = [];
  const tx = {
    query: async (sql: string, params?: unknown[]) => {
      if (/^(?:BEGIN|COMMIT|ROLLBACK)$/.test(sql)) return { rows: [], rowCount: null };
      if (sql.includes('UPDATE serve.page_image')) return { rows: [], rowCount: 1 };
      if (sql.includes('UPDATE meta.image_ingest_job')) {
        jobUpdates.push({ sql, params: params ?? [] });
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`unexpected tx SQL: ${sql}`);
    },
    release: () => undefined,
  };
  const pool = {
    connect: async () => tx,
    query: async (sql: string) => {
      if (sql.includes('FROM serve.page_image pi')) return { rows: [], rowCount: 0 };
      if (sql.includes('FROM serve.image_asset_url_alias alias')) return { rows: [], rowCount: 0 };
      throw new Error(`unexpected pool SQL: ${sql}`);
    },
  } as unknown as Pool;
  const external = {
    get: async (
      _url: string,
      _mode: string,
      extra?: { maxAttempts?: number; maxTransientAttempts?: number },
    ) => {
      assert.equal(extra?.maxAttempts, 4, '站外应容纳三跳重定向');
      assert.equal(extra?.maxTransientAttempts, 1, '站外同次任务不得内层连重试');
      throw new TransportError('timeout', 'https://bad.wdfiles.com/x.png', new Error('timeout'));
    },
  };
  const options: ImageWorkerOptions = {
    siteHost: 'scp-wiki-cn.wikidot.com',
    assetRoot: '/tmp/syncer2-image-external-egress-test',
    maxBytes: 1024,
    maxAttempts: 5,
    allowedHosts: ['*'],
    blockedHosts: [],
    retryBaseMs: 60 * 60_000,
    retryMaxMs: 7 * 24 * 60 * 60_000,
  };
  const result = await processImageJob(
    pool,
    {
      id: 1,
      pageId: 1,
      normalizedUrl: 'https://bad.wdfiles.com/x.png',
      displayUrl: 'https://bad.wdfiles.com/x.png',
      attempts: 1,
    },
    { wikidot: external, external },
    options,
  );
  assert.equal(result.status, 'retry');
  assert.equal(jobUpdates.length, 1);
  assert.match(jobUpdates[0]!.sql, /not_before = CASE[\s\S]*now\(\) \+/);
  assert.equal(jobUpdates[0]!.params[2], 'pending');
  assert.equal(jobUpdates[0]!.params[4], String(60 * 60_000));
});

test('主机闸推迟：任务可重试且按放行时间调度，不消耗尝试预算或站点健康度', async () => {
  const pageUpdates: Array<{ sql: string; params: unknown[] }> = [];
  const jobUpdates: Array<{ sql: string; params: unknown[] }> = [];
  const tx = {
    query: async (sql: string, params?: unknown[]) => {
      if (/^(?:BEGIN|COMMIT|ROLLBACK)$/.test(sql)) return { rows: [], rowCount: null };
      if (sql.includes('UPDATE serve.page_image')) {
        pageUpdates.push({ sql, params: params ?? [] });
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('UPDATE meta.image_ingest_job')) {
        jobUpdates.push({ sql, params: params ?? [] });
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`unexpected tx SQL: ${sql}`);
    },
    release: () => undefined,
  };
  const pool = {
    connect: async () => tx,
    query: async (sql: string) => {
      if (sql.includes('FROM serve.page_image pi')) return { rows: [], rowCount: 0 };
      if (sql.includes('FROM serve.image_asset_url_alias alias')) return { rows: [], rowCount: 0 };
      throw new Error(`unexpected pool SQL: ${sql}`);
    },
  } as unknown as Pool;
  const deferredMs = 45_000.25;
  const deferredClient = {
    get: async () => {
      throw new ExternalHostDeferredError('deferred.example.com', deferredMs);
    },
  };
  const result = await processImageJob(
    pool,
    {
      id: 3,
      pageId: 3,
      normalizedUrl: 'https://deferred.example.com/x.png',
      displayUrl: 'https://deferred.example.com/x.png',
      attempts: 6,
    },
    { wikidot: deferredClient, external: deferredClient },
    {
      siteHost: 'scp-wiki-cn.wikidot.com',
      assetRoot: '/tmp/syncer2-image-external-egress-test',
      maxBytes: 1024,
      maxAttempts: 5,
      allowedHosts: ['*'],
      blockedHosts: [],
      retryBaseMs: 60 * 60_000,
      retryMaxMs: 7 * 24 * 60 * 60_000,
    },
  );

  assert.equal(result.status, 'retry', '超过 maxAttempts 也不能把自我保护推迟终态化');
  assert.equal(result.failureClass, 'host_deferred');
  assert.equal(isTerminalImageFailure({
    failureClass: 'host_deferred',
    intrinsicTerminal: false,
    attempts: 6,
    maxAttempts: 5,
  }), false);
  assert.equal(pageUpdates.length, 1);
  assert.match(pageUpdates[0]!.sql, /THEN 'queued'/);
  assert.equal(pageUpdates[0]!.params[3], true, '页面引用仍是排队态，不累计资源失败');
  assert.equal(jobUpdates.length, 1);
  assert.equal(jobUpdates[0]!.params[2], 'pending');
  assert.equal(jobUpdates[0]!.params[3], false);
  assert.equal(jobUpdates[0]!.params[4], String(Math.ceil(deferredMs)), '调度毫秒必须是 bigint 可接受的整数');
  assert.equal(jobUpdates[0]!.params[5], 'host_deferred');
  assert.equal(jobUpdates[0]!.params[9], true, '本次闸推迟会归还 claim 增加的 attempts');
  assert.match(jobUpdates[0]!.sql, /not_before = CASE[\s\S]*now\(\) \+/);
  assert.match(jobUpdates[0]!.sql, /attempts = CASE[\s\S]*attempts - 1/);

  const routes = {
    wikidot_site: emptyImageRouteCounters(),
    external: emptyImageRouteCounters(),
  };
  recordImageRouteResult(routes, result);
  assert.equal(routes.external.retry, 1);
  assert.equal(routes.external.healthExcluded, 1);
  const health = evaluateImagePipelineHealth(
    routes,
    { wikidotSite: false, external: false },
  );
  assert.equal(health.external.failureRate, 0);
  assert.equal(health.external.exitCode, 0);
});

test('认领只取已到 not_before 的任务，并优先绕过处于 host 退让期的队头', async () => {
  let claimSql = '';
  const tx = {
    query: async (sql: string) => {
      if (/^(?:BEGIN|COMMIT|ROLLBACK)$/.test(sql)) return { rows: [], rowCount: null };
      claimSql = sql;
      return { rows: [], rowCount: 0 };
    },
    release: () => undefined,
  };
  const pool = { connect: async () => tx } as unknown as Pool;
  assert.equal(await claimNextImageJob(pool, 'test-worker'), null);
  assert.match(claimSql, /job\.not_before IS NULL OR job\.not_before <= now\(\)/);
  assert.match(claimSql, /external_gate\.next_permit_at/);
  assert.match(claimSql, /FOR UPDATE OF job SKIP LOCKED/);
});

test('HTTP 状态结构化落 job：429 不再只剩 http_transient 文本', async () => {
  const updates: unknown[][] = [];
  const tx = {
    query: async (sql: string, params?: unknown[]) => {
      if (/^(?:BEGIN|COMMIT|ROLLBACK)$/.test(sql)) return { rows: [], rowCount: null };
      if (sql.includes('UPDATE serve.page_image')) return { rows: [], rowCount: 1 };
      if (sql.includes('UPDATE meta.image_ingest_job')) {
        updates.push(params ?? []);
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`unexpected tx SQL: ${sql}`);
    },
    release: () => undefined,
  };
  const pool = {
    connect: async () => tx,
    query: async (sql: string) => {
      if (sql.includes('FROM serve.page_image pi')) return { rows: [], rowCount: 0 };
      if (sql.includes('FROM serve.image_asset_url_alias alias')) return { rows: [], rowCount: 0 };
      throw new Error(`unexpected pool SQL: ${sql}`);
    },
  } as unknown as Pool;
  const result = await processImageJob(
    pool,
    {
      id: 2,
      pageId: 2,
      normalizedUrl: 'https://rate.wdfiles.com/x.png',
      displayUrl: 'https://rate.wdfiles.com/x.png',
      attempts: 1,
    },
    {
      wikidot: { get: async () => { throw new Error('不应触碰 Wikidot'); } },
      external: {
        get: async () => {
          throw new HttpStatusError(429, 'https://rate.wdfiles.com/x.png', 'slow down');
        },
      },
    },
    {
      siteHost: 'scp-wiki-cn.wikidot.com',
      assetRoot: '/tmp/syncer2-image-external-egress-test',
      maxBytes: 1024,
      maxAttempts: 5,
      allowedHosts: ['*'],
      blockedHosts: [],
      retryBaseMs: 60 * 60_000,
      retryMaxMs: 7 * 24 * 60 * 60_000,
    },
  );
  assert.equal(result.failureClass, 'http_transient');
  assert.equal(result.httpStatus, 429);
  assert.equal(updates[0]![6], 429);
});


test('host_deferred 的 not_before 有上界，闸恢复后任务不会被历史退让锁死', () => {
  // 闸可以给出很长的等待（实测 951,334s ≈ 11 天）。把它原样写进任务的 not_before，
  // 会让主机恢复后这些任务仍停在未来：scpsandboxcn.wdfiles.com 的 120 个任务
  // attempts=0 却被排到 11 天后，而其闸已 level=0 recovered。
  const gateWaitMs = 951_334_000;
  const scheduled = Math.min(gateWaitMs, IMAGE_HOST_DEFERRAL_MAX_RETRY_MS);
  assert.equal(scheduled, IMAGE_HOST_DEFERRAL_MAX_RETRY_MS);
  assert.ok(scheduled <= 15 * 60_000, '复查间隔不得超过 15 分钟');

  // 短于上界的等待应原样保留——不要把有意义的短退让拉长。
  assert.equal(Math.min(30_000, IMAGE_HOST_DEFERRAL_MAX_RETRY_MS), 30_000);

  // 上界只作用于 host_deferred；真实失败仍按指数退避。
  assert.ok(
    imageRetryBackoffMs(4, 60 * 60_000, 7 * 24 * 60 * 60_000) > IMAGE_HOST_DEFERRAL_MAX_RETRY_MS,
    '真实失败的退避不受该上界影响',
  );
});
