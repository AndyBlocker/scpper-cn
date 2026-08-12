/**
 * M4 work-queue 状态机测试。
 *
 * 只写 scpper-v2 的 meta.* 测试 id 段；helpers/pg.ts 会在连接前拒绝所有受保护主库。
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { parseWhoRatedPage } from '../src/collect/votes.js';
import { evaluateAdaptiveSelfProtection, type AdaptiveEgressSnapshot } from '../src/http/adaptiveEgress.js';
import { createPool, query } from '../src/store/db.js';
import { enqueueScanTasks } from '../src/store/meta.js';
import {
  ADULT_STABLE_EGRESS_HOLD,
  ALL_WORK_TASK_KINDS,
  CONSECUTIVE_PAGE_FAILURE_LIMIT,
  finishWorkTask,
  finishVoteTask,
  reassignSlugReuseTasks,
  releaseWorkTaskLocks,
  WORK_QUEUE_LIMIT_MAX,
  type ClaimedVoteTask,
} from '../src/store/workQueue.js';
import {
  REGISTERED_WORK_KINDS,
  WORK_HANDLER_REGISTRY,
} from '../src/work/handlers.js';
import {
  applyAdaptiveSelfProtectionToRunHealth,
  evaluateRunHealth,
  RUN_FAILURE_RATE_THRESHOLD,
  RUN_REPEATED_FAILURE_ATTEMPTS,
} from '../src/work/runHealth.js';
import { resolveTestDatabaseUrl } from './helpers/pg.js';

const PAGE_BASE = 981_400_000;
const FIXED_NOW = '2026-07-27T00:00:00.000Z';
const WORKER = 'm4-test-worker';
const pool = createPool(resolveTestDatabaseUrl(), { max: 2 });

async function cleanup(): Promise<void> {
  await query(
    pool,
    'test:m4:cleanup_vote_sweep_state',
    `DELETE FROM meta.vote_sweep_page_state WHERE page_id BETWEEN $1 AND $2`,
    [PAGE_BASE, PAGE_BASE + 999],
  );
  await query(
    pool,
    'test:m4:cleanup_tasks',
    `DELETE FROM meta.scan_task WHERE page_id BETWEEN $1 AND $2`,
    [PAGE_BASE, PAGE_BASE + 999],
  );
  await query(
    pool,
    'test:m4:cleanup_irr',
    `DELETE FROM meta.irreconcilable WHERE page_id BETWEEN $1 AND $2`,
    [PAGE_BASE, PAGE_BASE + 999],
  );
}

async function insertLockedTask(
  pageId: number,
  opts: {
    attempts?: number;
    stableCount?: number;
    resultHash?: Buffer | null;
    notBefore?: string | null;
  } = {},
): Promise<void> {
  await query(
    pool,
    'test:m4:insert_task',
    `INSERT INTO meta.scan_task
       (page_id, kind, reasons, priority, attempts, stable_count,
        last_result_hash, not_before, locked_by, locked_at)
     VALUES ($1, 'votes_full', '{m4_test}', 100, $2, $3, $4,
             $5::timestamptz, $6, $7::timestamptz)`,
    [
      pageId,
      opts.attempts ?? 1,
      opts.stableCount ?? 0,
      opts.resultHash ?? null,
      opts.notBefore ?? null,
      WORKER,
      FIXED_NOW,
    ],
  );
}

function task(
  pageId: number,
  overrides: Partial<Pick<ClaimedVoteTask, 'attempts' | 'stableCount' | 'lastResultHash'>> = {},
): ClaimedVoteTask {
  return {
    taskId: 0,
    pageId,
    wikidotId: 999_000_000 + (pageId - PAGE_BASE),
    slug: `m4-test-${pageId}`,
    kind: 'votes_full',
    attempts: overrides.attempts ?? 1,
    stableCount: overrides.stableCount ?? 0,
    lastResultHash: overrides.lastResultHash ?? null,
    reasons: ['m4_test'],
    firstPublishedAt: null,
    taskCreatedAt: FIXED_NOW,
    claimedTotal: 1,
    claimedRating: 1,
    tier1RunId: null,
  };
}

async function taskId(pageId: number): Promise<number> {
  const res = await query<{ id: string }>(
    pool,
    'test:m4:task_id',
    `SELECT id::text FROM meta.scan_task WHERE page_id = $1 AND kind = 'votes_full'`,
    [pageId],
  );
  return Number(res.rows[0]!.id);
}

async function relock(
  pageId: number,
  attempts: number,
): Promise<void> {
  await query(
    pool,
    'test:m4:relock',
    `UPDATE meta.scan_task
        SET attempts = $2,
            not_before = NULL,
            locked_by = $3,
            locked_at = $4::timestamptz
      WHERE page_id = $1 AND kind = 'votes_full'`,
    [pageId, attempts, WORKER, FIXED_NOW],
  );
}

before(cleanup);
after(async () => {
  await cleanup();
  await pool.end();
});

describe('M4 work-queue', () => {
  it('投票合法空结果与解析失败显式可区分', () => {
    const empty = parseWhoRatedPage(
      '<h2>Who rated this page?</h2><div style="column-count: 4"></div>',
    );
    assert.equal(empty.status, 'ok');
    assert.equal(empty.data?.entries.length, 0);

    const blank = parseWhoRatedPage('');
    assert.equal(blank.status, 'failed');
    assert.match(blank.error, /不是合法的 0 票响应/);

    const waf = parseWhoRatedPage('<html><title>Access denied</title></html>');
    assert.equal(waf.status, 'failed');
    assert.match(waf.error, /结构锚点/);
  });

  it('源码与 ecosystem 钉住 50/5/SKIP LOCKED/cron_restart 契约', async () => {
    assert.equal(WORK_QUEUE_LIMIT_MAX, 50);
    assert.equal(CONSECUTIVE_PAGE_FAILURE_LIMIT, 5);

    const storeSource = await readFile(
      new URL('../src/store/workQueue.ts', import.meta.url),
      'utf8',
    );
    const handlerSource = await readFile(
      new URL('../src/work/handlers.ts', import.meta.url),
      'utf8',
    );
    assert.match(storeSource, /FOR UPDATE OF st SKIP LOCKED/);
    assert.match(storeSource, /Math\.min\(WORK_QUEUE_LIMIT_MAX/);
    assert.match(storeSource, /ps\.claimed_total IS NOT NULL/);
    assert.match(storeSource, /meta\.incremental_page_state ips/);
    assert.match(storeSource, /l1_full_site_minimal/);
    assert.doesNotMatch(
      storeSource,
      /ps\.error = 'vote_claim_targeted_listpages'/,
      '定向 claim 不能跨轮复用；全站 L1 缺席页每次盲扫都必须刷新远端声明',
    );
    assert.match(handlerSource, /vote_claim_targeted_listpages/);
    assert.doesNotMatch(
      storeSource,
      /pc\.rating AS claimed_rating|pc\.vote_(?:up|down) AS claimed_total/,
      '缺 L1 页只能目标 ListPages 补证，不能把本地聚合伪装成远端 claim',
    );
    assert.match(storeSource, /attempts = GREATEST\(0, attempts - 1\)/);
    assert.doesNotMatch(storeSource, /release_work_locks[\s\S]{0,500}interval '1 hour'/);

    const cliSource = await readFile(
      new URL('../src/cli/work-queue.ts', import.meta.url),
      'utf8',
    );
    assert.match(
      cliSource,
      /process\.exitCode = health\.exitCode/,
    );
    assert.match(cliSource, /evaluateRunHealth/);
    assert.match(cliSource, /consecutiveFailures >= CONSECUTIVE_PAGE_FAILURE_LIMIT/);
    assert.match(cliSource, /const terminal = action === 'irreconcilable'/);
    assert.match(
      cliSource,
      /if \(terminal\) \{[\s\S]{0,240}counters\.irreconcilable\+\+[\s\S]{0,240}\} else \{[\s\S]{0,160}counters\[outcome\.status\]\+\+/,
    );
    assert.doesNotMatch(cliSource, /counters\.failed > 0[\s\S]{0,120}'failed'/);
    assert.match(cliSource, /batchesFailed:\s*counters\.failed/);
    assert.doesNotMatch(
      cliSource,
      /batchesFailed:\s*counters\.failed \+ counters\.partial/,
    );

    const ecosystem = await readFile(
      new URL('../ecosystem.work-queue.config.cjs', import.meta.url),
      'utf8',
    );
    assert.match(ecosystem, /cron_restart\s*:/);
    assert.match(ecosystem, /autorestart\s*:\s*false/);
    assert.match(ecosystem, /['"]--limit 50 --concurrency 4['"]/);
    assert.match(ecosystem, /禁止 restart_delay/);
    assert.doesNotMatch(ecosystem, /^\s*restart_delay\s*:/m);
  });

  it('页级失败按比例与跨轮连续性升级，孤立失败不拖垮整轮', () => {
    assert.equal(RUN_FAILURE_RATE_THRESHOLD, 0.25);
    assert.equal(RUN_REPEATED_FAILURE_ATTEMPTS, 3);

    const isolated = evaluateRunHealth({
      claimed: 9,
      processed: 9,
      partial: 2,
      failed: 1,
      writeFreezeSkipped: 0,
      repeatedFailures: 0,
      breakerOpen: false,
      stoppedByFailureLimit: false,
    });
    assert.deepEqual(
      { status: isolated.status, exitCode: isolated.exitCode },
      { status: 'partial', exitCode: 0 },
    );

    const highRate = evaluateRunHealth({
      claimed: 8,
      processed: 8,
      partial: 0,
      failed: 2,
      writeFreezeSkipped: 0,
      repeatedFailures: 0,
      breakerOpen: false,
      stoppedByFailureLimit: false,
    });
    assert.equal(highRate.status, 'failed');
    assert.equal(highRate.exitCode, 1);
    assert.ok(highRate.reasons.includes('high_failure_rate'));

    const zeroProgress = evaluateRunHealth({
      claimed: 5,
      processed: 0,
      partial: 0,
      failed: 0,
      writeFreezeSkipped: 0,
      repeatedFailures: 0,
      breakerOpen: false,
      stoppedByFailureLimit: false,
    });
    assert.equal(zeroProgress.status, 'failed');
    assert.equal(zeroProgress.exitCode, 1);
    assert.ok(zeroProgress.reasons.includes('zero_progress'));

    const repeated = evaluateRunHealth({
      claimed: 9,
      processed: 9,
      partial: 0,
      failed: 1,
      writeFreezeSkipped: 0,
      repeatedFailures: 1,
      breakerOpen: false,
      stoppedByFailureLimit: false,
    });
    assert.equal(repeated.status, 'failed');
    assert.equal(repeated.exitCode, 1);
    assert.ok(repeated.reasons.includes('repeated_cross_run_failure'));
  });

  it('自适应降档窗口内 exit 0 并给恢复时间；超过预计恢复窗口才 exit 1', () => {
    const base = evaluateRunHealth({
      claimed: 5, processed: 0, partial: 0, failed: 0,
      writeFreezeSkipped: 0, repeatedFailures: 0,
      breakerOpen: false, stoppedByFailureLimit: false,
    });
    const snapshot: AdaptiveEgressSnapshot = {
      siteKey: 'wikidot', level: 3, levelName: 'cooldown', minRequestIntervalMs: 8_000,
      reason: 'failure_rate_10.0pct_gte_10.0pct_single_window',
      changedAt: '2026-08-07T00:00:00.000Z',
      recoverNotBefore: '2026-08-07T01:00:00.000Z',
      pressureLevel: 3, pressureReason: 'failure_rate_10.0pct_gte_10.0pct_single_window',
      pressureChangedAt: '2026-08-07T00:00:00.000Z',
      pressureRecoverNotBefore: '2026-08-07T01:00:00.000Z',
      budgetLevel: 0, budgetReason: 'within_budget',
      budgetChangedAt: '2026-08-07T00:00:00.000Z',
      budgetMinRequestIntervalMs: 333, budgetThrottleRatio: 1,
      currentWindowRequests: 0, currentWindowFailures: 0,
      currentWindowConnectionFailures: 0, currentWindowDeterministicFailures: 0,
      connectionFailureStreak: 0, lastConnectionFailureAt: null,
      lastConnectionBackoffAt: null, elevatedWindows: 0, healthyWindows: 0,
      healthyWindowsRequired: 6, lastWindowFailureRate: 0,
      recoveryWindowMinutes: 5, recoveryWindowStartedAt: null,
      recoveryWindowRequests: 0, recoveryWindowFailures: 0,
      lastWindowConnectionFailureRate: 0, lastWindowDeterministicFailureRate: 0,
      lastWindowCompletedAt: null,
      rollingHourRequests: 444, budgetLimit: 5_400, budgetBreached: false,
      l1LastStartedAt: null, l1SloDegradedSince: null, l1SloExpectedRecoveryAt: null,
      l1SloLastGapSeconds: null, l1SloOverdue: false,
      updatedAt: '2026-08-07T00:00:00.000Z',
    };
    const expected = evaluateAdaptiveSelfProtection(
      snapshot,
      Date.parse('2026-08-07T01:10:00.000Z'),
    );
    const protectedHealth = applyAdaptiveSelfProtectionToRunHealth(base, expected);
    assert.equal(expected.status, 'downshift_expected');
    assert.equal(protectedHealth.exitCode, 0);
    assert.equal(protectedHealth.selfProtection.levelName, 'cooldown');
    assert.match(protectedHealth.selfProtection.reason, /failure_rate_10\.0pct/);
    assert.ok(protectedHealth.selfProtection.expectedRecoveryAt);

    const overdue = evaluateAdaptiveSelfProtection(
      snapshot,
      Date.parse('2026-08-07T05:00:00.000Z'),
    );
    const failed = applyAdaptiveSelfProtectionToRunHealth(base, overdue);
    assert.equal(overdue.status, 'downshift_overdue');
    assert.equal(failed.exitCode, 1);
    assert.ok(failed.reasons.includes('adaptive_downshift_recovery_overdue'));
  });

  it('11 种 scan_task kind 全部注册 handler，没有认领后跳过的空洞', () => {
    assert.deepEqual(
      [...REGISTERED_WORK_KINDS].sort(),
      [...ALL_WORK_TASK_KINDS].sort(),
    );
    for (const kind of ALL_WORK_TASK_KINDS) {
      assert.equal(typeof WORK_HANDLER_REGISTRY[kind], 'function', kind);
    }
  });

  it('11 种 kind 的成功出口均能关闭其入队驱动，周期 kind 不允许成功后原地自旋', async () => {
    const stateDriven = [
      'new_page_highfreq',
      'votes_full',
      'attributions',
      'discussion',
    ] as const;
    const observationDriven = [
      'confirm_deleted',
      'meta',
      'sitemap_delta',
      'content',
      'revisions_full',
      'files',
      'forum',
    ] as const;
    assert.deepEqual(
      [...stateDriven, ...observationDriven].sort(),
      [...ALL_WORK_TASK_KINDS].sort(),
      '新增 kind 必须显式归类为状态驱动或外部观测驱动，不能留下未建模的永久未完成态',
    );

    const [queueSource, handlerSource, forumQueueSource, forumSource, migration] =
      await Promise.all([
        readFile(new URL('../src/store/workQueue.ts', import.meta.url), 'utf8'),
        readFile(new URL('../src/work/handlers.ts', import.meta.url), 'utf8'),
        readFile(new URL('../src/store/queues.ts', import.meta.url), 'utf8'),
        readFile(new URL('../src/collect/forum.ts', import.meta.url), 'utf8'),
        readFile(
          new URL('../migrations/0059_vote_snapshot_success_clock.sql', import.meta.url),
          'utf8',
        ),
      ]);

    assert.match(
      migration,
      /NEW\.kind = 'votes' AND NEW\.status = 'ok'[\s\S]*last_complete_vote_snapshot_at/,
      'votes_full/new_page_highfreq 的成功证书必须推进共同的快照驱动字段',
    );
    assert.match(
      queueSource,
      /seed_vote_highfreq[\s\S]*ps\.kind = 'votes'[\s\S]*ps\.status = 'ok'/,
      '高频车道还必须有独立 page_scan 冷却闸，不能只依赖驱动字段',
    );
    assert.match(
      queueSource,
      /claim_all_work[\s\S]*st\.kind <> 'new_page_highfreq'[\s\S]*ps\.scanned_at > now\(\)/,
      '错误重播种必须在执行侧再次被拒绝',
    );
    assert.match(
      queueSource,
      /vote_sweep_page_state:complete[\s\S]*last_v2_complete_at = GREATEST/,
      'votes_full 成功还必须推进首轮追平/稳态切换状态',
    );
    assert.match(
      queueSource,
      /ps\.kind = 'attributions'[\s\S]*ps\.status = 'ok'[\s\S]*ps\.scanned_at > \$1/,
      'attributions 周期由自身成功 page_scan 直接关闭',
    );
    assert.match(
      handlerSource,
      /task\.pageId, 'attributions'[\s\S]*status: refresh\.status/,
    );
    assert.match(
      forumQueueSource,
      /pc\.discussion_thread_id IS NULL[\s\S]*forum_link_initial_catchup/,
      'discussion 首轮追平必须有可表达的缺失字段',
    );
    assert.match(
      forumSource,
      /forum:apply_page_meta_discussion_thread[\s\S]*discussion_thread_id: stored!\.value\.threadId/,
      'discussion 成功必须填入驱动播种的 thread id',
    );
  });

  it('普通成功即删', async () => {
    const pageId = PAGE_BASE;
    await insertLockedTask(pageId);
    const claimed = task(pageId);
    claimed.taskId = await taskId(pageId);

    const result = await finishVoteTask(pool, claimed, {
      workerId: WORKER,
      status: 'ok',
      now: FIXED_NOW,
    });
    assert.equal(result.action, 'deleted');
    assert.equal(
      await scalar(
        `SELECT count(*)::int AS n FROM meta.scan_task
          WHERE page_id = $1 AND kind = 'votes_full'`,
        [pageId],
      ),
      0,
    );
    assert.equal(
      await scalar(
        `SELECT count(*)::int AS n FROM meta.vote_sweep_page_state WHERE page_id = $1`,
        [pageId],
      ),
      1,
    );

    const highFrequencyPage = PAGE_BASE + 10;
    await query(
      pool,
      'test:m4:insert_highfreq',
      `INSERT INTO meta.scan_task
         (page_id, kind, reasons, priority, attempts, locked_by, locked_at)
       VALUES ($1, 'new_page_highfreq', '{m4_test}', 100, 1, $2, $3::timestamptz)`,
      [highFrequencyPage, WORKER, FIXED_NOW],
    );
    const highFrequency = {
      ...task(highFrequencyPage),
      taskId: await scalar(
        `SELECT id::int AS n FROM meta.scan_task
          WHERE page_id=$1 AND kind='new_page_highfreq'`,
        [highFrequencyPage],
      ),
      kind: 'new_page_highfreq' as const,
    };
    const highResult = await finishVoteTask(pool, highFrequency, {
      workerId: WORKER,
      status: 'ok',
      now: FIXED_NOW,
    });
    assert.equal(highResult.action, 'deleted');
    assert.equal(
      await scalar(
        `SELECT count(*)::int AS n FROM meta.scan_task
          WHERE page_id=$1 AND kind='new_page_highfreq'`,
        [highFrequencyPage],
      ),
      0,
    );
  });

  it('slug 复用只迁移新身份数据任务，并合并 successor 上已有任务', async () => {
    const predecessorId = PAGE_BASE + 20;
    const successorId = PAGE_BASE + 21;
    await query(
      pool,
      'test:m4:seed_slug_reuse_tasks',
      `INSERT INTO meta.scan_task
         (page_id, kind, reasons, priority, attempts, stable_count,
          not_before, locked_by, locked_at)
       VALUES
         ($1, 'meta',             '{revision_regression_identity_check}', 100, 1, 0, NULL, $3, $4::timestamptz),
         ($1, 'confirm_deleted',  '{old_lifecycle}',                         5, 0, 0, NULL, NULL, NULL),
         ($1, 'content',          '{old_content}',                          10, 3, 2, $4::timestamptz, NULL, NULL),
         ($1, 'revisions_full',   '{old_revisions}',                        20, 2, 1, $4::timestamptz, NULL, NULL),
         ($1, 'votes_full',       '{old_votes}',                            30, 1, 0, $4::timestamptz, NULL, NULL),
         ($2, 'content',          '{successor_content}',                    40, 1, 0, $4::timestamptz, NULL, NULL)`,
      [predecessorId, successorId, WORKER, FIXED_NOW],
    );
    const currentTaskId = await scalar(
      `SELECT id::int AS n FROM meta.scan_task WHERE page_id=$1 AND kind='meta'`,
      [predecessorId],
    );

    assert.equal(
      await reassignSlugReuseTasks(
        pool,
        predecessorId,
        successorId,
        currentTaskId,
      ),
      3,
    );
    assert.equal(
      await scalar(
        `SELECT count(*)::int AS n FROM meta.scan_task WHERE page_id=$1`,
        [predecessorId],
      ),
      2,
    );
    assert.equal(
      await scalar(
        `SELECT count(*)::int AS n
           FROM meta.scan_task
          WHERE page_id=$1
            AND kind IN ('content', 'revisions_full', 'votes_full')
            AND priority >= 100
            AND not_before IS NULL
            AND 'slug_reuse_identity_registered'=ANY(reasons)`,
        [successorId],
      ),
      3,
    );
    assert.equal(
      await scalar(
        `SELECT count(*)::int AS n
           FROM meta.scan_task
          WHERE page_id=$1 AND kind='content'
            AND 'old_content'=ANY(reasons)
            AND 'successor_content'=ANY(reasons)`,
        [successorId],
      ),
      1,
    );
  });

  it('抓完仍差 1 的相同 hash 会先退避，第 3 次进终态且发现侧不能无限重入队', async () => {
    const pageId = PAGE_BASE + 1;
    const hash = createHash('sha256').update('stable-remote-result').digest();
    await insertLockedTask(pageId);
    const claimed = task(pageId);
    claimed.taskId = await taskId(pageId);

    let result = await finishVoteTask(pool, claimed, {
      workerId: WORKER,
      status: 'partial',
      resultHash: hash,
      localValue: { rating: 6 },
      remoteValue: { rating: 7 },
      now: FIXED_NOW,
    });
    assert.equal(result.stableCount, 1);
    assert.equal(result.action, 'retried');
    assert.notEqual(result.notBefore, null);

    await relock(pageId, 2);
    result = await finishVoteTask(
      pool,
      { ...claimed, attempts: 2, stableCount: 1, lastResultHash: hash },
      {
        workerId: WORKER,
        status: 'partial',
        resultHash: hash,
        localValue: { rating: 6 },
        remoteValue: { rating: 7 },
        now: FIXED_NOW,
      },
    );
    assert.equal(result.stableCount, 2);
    assert.equal(result.action, 'retried');
    assert.notEqual(result.notBefore, null);

    await relock(pageId, 3);
    result = await finishVoteTask(
      pool,
      { ...claimed, attempts: 3, stableCount: 2, lastResultHash: hash },
      {
        workerId: WORKER,
        status: 'partial',
        resultHash: hash,
        localValue: { rating: 6 },
        remoteValue: { rating: 7 },
        now: FIXED_NOW,
      },
    );
    assert.equal(result.stableCount, 3);
    assert.equal(result.action, 'irreconcilable');
    assert.equal(result.notBefore, null);
    assert.equal(
      await scalar(
        `SELECT count(*)::int AS n
           FROM meta.scan_task
          WHERE page_id = $1 AND kind = 'votes_full'`,
        [pageId],
      ),
      0,
    );

    const irr = await query<{
      checks: number;
      local_value: { rating: number };
      remote_value: { rating: number };
      result_hash: Buffer;
      next_review_at: Date;
      resolved_at: Date | null;
    }>(
      pool,
      'test:m4:irr',
      `SELECT checks, local_value, remote_value, result_hash, next_review_at, resolved_at
         FROM meta.irreconcilable
        WHERE page_id = $1 AND kind = 'votes_full'`,
      [pageId],
    );
    assert.equal(irr.rows[0]!.checks, 1);
    assert.deepEqual(irr.rows[0]!.local_value, { rating: 6 });
    assert.deepEqual(irr.rows[0]!.remote_value, { rating: 7 });
    assert.equal(irr.rows[0]!.result_hash.toString('hex'), hash.toString('hex'));
    assert.equal(irr.rows[0]!.next_review_at.toISOString(), '2026-08-03T00:00:00.000Z');
    assert.equal(irr.rows[0]!.resolved_at, null);

    // 发现侧每天重复看到信号也不得把终态塞回常规队列。
    assert.equal(await enqueueScanTasks(pool, [{
      pageId,
      kind: 'votes_full',
      reasons: ['rediscovered_while_terminal'],
      priority: 999,
    }]), 0);

    await query(
      pool,
      'test:m4:lock_review_same',
      `UPDATE meta.irreconcilable
          SET locked_by = $2, locked_at = $3::timestamptz
        WHERE page_id = $1 AND kind = 'votes_full'`,
      [pageId, WORKER, '2026-08-03T00:00:00.000Z'],
    );
    const reviewTask = {
      ...claimed,
      queueSource: 'irreconcilable' as const,
      revisionClaimedTotal: 0,
      commentCount: 0,
      expectedThreadId: null,
      lastResultHash: hash,
      reasons: ['irreconcilable_weekly_review'],
    };
    const unchanged = await finishWorkTask(pool, reviewTask, {
      workerId: WORKER,
      status: 'partial',
      resultHash: hash,
      localValue: { rating: 6 },
      remoteValue: { rating: 7 },
      now: '2026-08-03T00:00:00.000Z',
    });
    assert.equal(unchanged.action, 'irreconcilable');
    assert.equal(
      await scalar(
        `SELECT count(*)::int AS n
           FROM meta.scan_task
          WHERE page_id = $1 AND kind = 'votes_full'`,
        [pageId],
      ),
      0,
    );

    const changedHash = createHash('sha256').update('changed-remote-result').digest();
    await query(
      pool,
      'test:m4:lock_review_changed',
      `UPDATE meta.irreconcilable
          SET locked_by = $2, locked_at = $3::timestamptz
        WHERE page_id = $1 AND kind = 'votes_full'`,
      [pageId, WORKER, '2026-08-10T00:00:00.000Z'],
    );
    const changed = await finishWorkTask(pool, reviewTask, {
      workerId: WORKER,
      status: 'partial',
      resultHash: changedHash,
      localValue: { rating: 7 },
      remoteValue: { rating: 8 },
      now: '2026-08-10T00:00:00.000Z',
    });
    assert.equal(changed.action, 'review_reopened');
    assert.equal(
      await scalar(
        `SELECT count(*)::int AS n
           FROM meta.scan_task
          WHERE page_id = $1
            AND kind = 'votes_full'
            AND stable_count = 1
            AND last_result_hash = $2`,
        [pageId, changedHash],
      ),
      1,
    );
    assert.equal(
      await scalar(
        `SELECT count(*)::int AS n
           FROM meta.irreconcilable
          WHERE page_id = $1 AND kind = 'votes_full' AND resolved_at IS NULL`,
        [pageId],
      ),
      0,
    );
  });

  it('发现侧重复入队不覆盖 attempts/stable_count/result_hash', async () => {
    const pageId = PAGE_BASE + 2;
    const hash = createHash('sha256').update('keep-executor-state').digest();
    await insertLockedTask(pageId, {
      attempts: 7,
      stableCount: 2,
      resultHash: hash,
      notBefore: '2026-07-28T00:00:00.000Z',
    });
    // 模拟执行者已释放锁、等待退避；发现侧再次看到同一信号。
    await query(
      pool,
      'test:m4:unlock',
      `UPDATE meta.scan_task SET locked_by=NULL, locked_at=NULL
        WHERE page_id=$1 AND kind='votes_full'`,
      [pageId],
    );
    await enqueueScanTasks(pool, [{
      pageId,
      kind: 'votes_full',
      reasons: ['rediscovered'],
      priority: 999,
      notBefore: '2026-07-27T00:30:00.000Z',
    }]);

    const state = await query<{
      attempts: number;
      stable_count: number;
      hash: string;
      not_before: Date;
    }>(
      pool,
      'test:m4:state',
      `SELECT attempts, stable_count, encode(last_result_hash,'hex') AS hash, not_before
         FROM meta.scan_task
        WHERE page_id=$1 AND kind='votes_full'`,
      [pageId],
    );
    assert.equal(state.rows[0]!.attempts, 7);
    assert.equal(state.rows[0]!.stable_count, 2);
    assert.equal(state.rows[0]!.hash, hash.toString('hex'));
    // 发现侧可以把执行时间提前，但不能清空/重置执行状态。
    assert.equal(state.rows[0]!.not_before.toISOString(), '2026-07-27T00:30:00.000Z');
  });

  it('未执行任务释放锁不退避，并归还 claim 消耗的 attempts', async () => {
    const pageId = PAGE_BASE + 3;
    await insertLockedTask(pageId, { attempts: 3 });
    const id = await taskId(pageId);
    assert.equal(await releaseWorkTaskLocks(pool, [id], WORKER), 1);
    const state = await query<{
      attempts: number;
      not_before: Date | null;
      locked_by: string | null;
    }>(
      pool,
      'test:m4:released_unprocessed',
      `SELECT attempts, not_before, locked_by
         FROM meta.scan_task
        WHERE id=$1`,
      [id],
    );
    assert.deepEqual(state.rows[0], {
      attempts: 2,
      not_before: null,
      locked_by: null,
    });
  });

  it('adult 未执行任务释放回专用 hold，不暴露给通用 worker', async () => {
    const pageId = PAGE_BASE + 33;
    await insertLockedTask(pageId, { attempts: 3 });
    const id = await taskId(pageId);
    assert.equal(
      await releaseWorkTaskLocks(pool, [id], WORKER, ADULT_STABLE_EGRESS_HOLD),
      1,
    );
    const state = await query<{
      attempts: number;
      locked_by: string | null;
      locked_at: Date | null;
      now: Date;
    }>(
      pool,
      'test:m4:released_to_adult_hold',
      `SELECT attempts, locked_by, locked_at, clock_timestamp() AS now
         FROM meta.scan_task
        WHERE id=$1`,
      [id],
    );
    assert.equal(state.rows[0]!.attempts, 2);
    assert.equal(state.rows[0]!.locked_by, ADULT_STABLE_EGRESS_HOLD);
    assert.ok(state.rows[0]!.locked_at! > state.rows[0]!.now);
  });
});

async function scalar(sql: string, params: readonly unknown[]): Promise<number> {
  const res = await query<{ n: number }>(pool, 'test:m4:scalar', sql, params);
  return Number(res.rows[0]!.n);
}
