import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

import {
  classifyWorkFailure,
  isDeterministicWorkFailure,
} from '../src/work/failurePolicy.js';
import {
  applyAdaptiveSelfProtectionToRunHealth,
  evaluateRunHealth,
  RUN_FAILURE_RATE_THRESHOLD,
  RUN_REPEATED_FAILURE_ATTEMPTS,
} from '../src/work/runHealth.js';

describe('统一采集 run health', () => {
  it('45 成功 + 1 确定性失败只降为 partial，失败率分子为 0 且 exit 0', () => {
    const health = evaluateRunHealth({
      claimed: 46,
      processed: 46,
      partial: 0,
      failed: 1,
      deterministicFailures: 1,
    });
    assert.deepEqual(
      {
        status: health.status,
        exitCode: health.exitCode,
        retryableFailures: health.retryableFailures,
        deterministicFailures: health.deterministicFailures,
        failureRate: health.failureRate,
      },
      {
        status: 'partial',
        exitCode: 0,
        retryableFailures: 0,
        deterministicFailures: 1,
        failureRate: 0,
      },
    );
  });

  it('大比例失败、零进展、连续跨轮失败仍各自 exit 1', () => {
    const highRate = evaluateRunHealth({
      claimed: 20,
      processed: 20,
      partial: 0,
      failed: 5,
    });
    assert.equal(RUN_FAILURE_RATE_THRESHOLD, 0.25);
    assert.equal(highRate.exitCode, 1);
    assert.ok(highRate.reasons.includes('high_failure_rate'));

    const zeroProgress = evaluateRunHealth({
      claimed: 10,
      processed: 0,
      partial: 0,
      failed: 0,
    });
    assert.equal(zeroProgress.exitCode, 1);
    assert.ok(zeroProgress.reasons.includes('zero_progress'));

    const repeated = evaluateRunHealth({
      claimed: 10,
      processed: 10,
      partial: 0,
      failed: 1,
      repeatedFailures: 1,
    });
    assert.equal(RUN_REPEATED_FAILURE_ATTEMPTS, 3);
    assert.equal(repeated.exitCode, 1);
    assert.ok(repeated.reasons.includes('repeated_cross_run_failure'));
  });

  it('断路器 aborted 是预期内自我保护时 exit 0，恢复超期才 exit 1', () => {
    const aborted = evaluateRunHealth({
      claimed: 147,
      processed: 147,
      partial: 0,
      failed: 141,
      breakerOpen: true,
      fatalReasons: ['scan_validation_failed'],
    });
    const expected = applyAdaptiveSelfProtectionToRunHealth(aborted, {
      status: 'downshift_expected',
      active: true,
      overdue: false,
      exitCode: 0,
      level: 1,
      levelName: 'cautious',
      reason: 'connection_failure_streak_5_within_120s_sparse_backoff',
      recoverNotBefore: '2026-08-12T02:00:00.000Z',
      expectedRecoveryAt: '2026-08-12T02:30:00.000Z',
    });
    assert.equal(expected.status, 'aborted');
    assert.equal(expected.exitCode, 0);
    assert.ok(expected.reasons.includes('circuit_breaker_self_protection_expected'));

    const overdue = applyAdaptiveSelfProtectionToRunHealth(aborted, {
      ...expected.selfProtection,
      status: 'downshift_overdue',
      overdue: true,
      exitCode: 1,
    });
    assert.equal(overdue.status, 'failed');
    assert.equal(overdue.exitCode, 1);
    assert.ok(overdue.reasons.includes('adaptive_downshift_recovery_overdue'));
  });

  it('breadcrumbs 缺 category id 是 classifyWorkFailure 的 structural 终态', () => {
    const policy = classifyWorkFailure(
      'forum',
      'ForumViewThreadModule 请求失败：Error: thread breadcrumbs 缺 category id/title',
    );
    assert.equal(policy.family, 'structural');
    assert.equal(policy.action, 'irreconcilable');
    assert.equal(isDeterministicWorkFailure(policy), true);

    const gone = classifyWorkFailure(
      'forum',
      'ForumViewThreadModule status=no_thread：讨论串 1 已在站上删除',
    );
    assert.equal(gone.family, 'structural');
    assert.equal(gone.action, 'irreconcilable');
    assert.equal(isDeterministicWorkFailure(gone), true);
  });

  it('目标 ListPages 明确不可枚举时进入确定性终态，不触发跨轮失败告警', () => {
    const policy = classifyWorkFailure(
      'votes_full',
      'listpages_unenumerable：目标 ListPages 对 scp-sb 返回结构完整空集合；' +
        '缺少权威投票 claim，拒绝使用本地聚合值并进入显式终态',
    );
    assert.deepEqual(
      { family: policy.family, signature: policy.signature, action: policy.action },
      {
        family: 'structural',
        signature: 'vote_claim_listpages_unenumerable',
        action: 'irreconcilable',
      },
    );
    const health = evaluateRunHealth({
      claimed: 4,
      processed: 4,
      partial: 0,
      failed: 4,
      deterministicFailures: 4,
      repeatedFailures: 0,
    });
    assert.equal(health.exitCode, 0);
    assert.ok(!health.reasons.includes('repeated_cross_run_failure'));
  });
});

describe('采集 CLI 统一判据接入覆盖', () => {
  it('所有 ingest_run 入口和所有调度型采集入口都直接调用 evaluateRunHealth', async () => {
    const cliUrl = new URL('../src/cli/', import.meta.url);
    const packageJson = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { scripts: Record<string, string> };
    const files = (await readdir(cliUrl)).filter((name) => name.endsWith('.ts'));
    const sources = new Map(
      await Promise.all(files.map(async (name) => [
        name,
        await readFile(new URL(name, cliUrl), 'utf8'),
      ] as const)),
    );

    const required = new Set<string>();
    for (const [name, source] of sources) {
      if (/\bstartIngestRun\s*\(/.test(source)) required.add(name);
    }

    const nonCollectionSchedules = new Set([
      'schedule:oldest-pending',
      'schedule:page-scan-maintenance',
      'schedule:project',
    ]);
    for (const [name, command] of Object.entries(packageJson.scripts)) {
      if (!name.startsWith('schedule:') || nonCollectionSchedules.has(name)) continue;
      const match = /src\/cli\/([a-z0-9-]+\.ts)\b/.exec(command);
      if (match !== null) required.add(match[1]!);
    }

    assert.ok(required.has('work-queue.ts'));
    assert.ok(required.has('forum-scan.ts'));
    assert.ok(required.has('forum-incremental.ts'));
    assert.ok(required.has('incremental-scan.ts'));
    assert.ok(required.has('sitemap-scan.ts'));
    assert.ok(required.has('tier1-scan.ts'));
    assert.ok(required.has('image-ingest.ts'));

    const missing = [...required].filter((name) => {
      const source = sources.get(name) ?? '';
      return !/import\s*\{[\s\S]*?\bevaluateRunHealth\b[\s\S]*?\}\s*from\s*['"]\.\.\/work\/runHealth\.js['"]/.test(source)
        || !/\bevaluateRunHealth\s*\(/.test(source);
    });
    assert.deepEqual(
      missing,
      [],
      `新增采集 CLI 必须接入统一 run health；未接入：${missing.join(', ')}`,
    );
  });

  it('forum target 的确定性终态由迁移先落地，并从认领/pending 排除', async () => {
    const [migration, queues] = await Promise.all([
      readFile(
        new URL('../migrations/0052_forum_target_terminal_state.sql', import.meta.url),
        'utf8',
      ),
      readFile(new URL('../src/store/queues.ts', import.meta.url), 'utf8'),
    ]);
    assert.match(migration, /ADD COLUMN IF NOT EXISTS terminal_at/);
    assert.match(migration, /WHERE fst\.terminal_at IS NULL/);
    assert.match(queues, /meta\.forum_scan_task:finish_terminal/);
    assert.match(queues, /AND fst\.terminal_at IS NULL/);
  });
});
