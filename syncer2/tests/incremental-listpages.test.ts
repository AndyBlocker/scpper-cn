import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { diffL0Rows, diffL1Rows } from '../src/collect/incrementalDiff.js';
import {
  decideRevisionRegressionIdentity,
  evaluateRevisionRegressionHealth,
} from '../src/collect/revisionRegression.js';
import {
  L0_SELECTORS,
  L1_SELECTORS,
  batchTargets,
  buildIncrementalListPagesRequest,
  buildIncrementalModuleBody,
  parseIncrementalListPagesResponse,
  scanIncrementalListPages,
} from '../src/collect/incrementalListPages.js';
import type { HttpClient } from '../src/http/client.js';
import {
  calculateRevisionCoverage,
  classifyRevisionCoverageBaseline,
  shouldAlertRevisionCoverage,
} from '../src/store/incremental.js';

test('L0 是 updated_at 两小时窗口并携带 revisions 二次确认', () => {
  assert.deepEqual(L0_SELECTORS, ['fullname', 'updated_at', 'revisions']);
  const body = buildIncrementalModuleBody('l0');
  assert.match(body, /%%%%revisions%%%%/);
  assert.doesNotMatch(body, /rating_votes|title|tags/);
  const request = buildIncrementalListPagesRequest('l0', 2, { windowHours: 2 });
  assert.equal(request.params.updated_at, 'last 2 hours');
  assert.equal(request.params.order, 'updated_at desc');
  assert.equal(request.params.offset, 250);
});

test('L1 module_body 严格四字段，batchTargets 无早停入口并覆盖 2..N', () => {
  assert.deepEqual(L1_SELECTORS, ['fullname', 'rating', 'rating_votes', 'revisions']);
  const body = buildIncrementalModuleBody('l1');
  assert.equal((body.match(/%%%%/g) ?? []).length, 8);
  assert.doesNotMatch(body, /updated_at|total|index|title|tags/);
  assert.deepEqual(batchTargets(145), Array.from({ length: 144 }, (_, index) => index + 2));
});

test('窄字段响应严格解析日期/整数，WAF 不能伪装成空集合', () => {
  const l0 =
    '<div class="syncer2-incremental-l0-row"><p>' +
    '%%scp-cn-1%%|||%%%%date|1785196800%%%%|||%%7%%</p></div>' +
    '<span class="pager-no">page 1 of 1</span>';
  const parsedL0 = parseIncrementalListPagesResponse(l0, 'l0', 1);
  assert.equal(parsedL0.status, 'ok');
  assert.equal(parsedL0.rows[0]?.revisions, 7);
  assert.equal(parsedL0.rows[0]?.updatedAt, '2026-07-28T00:00:00.000Z');

  const l1 =
    '<div class="syncer2-incremental-l1-row"><p>' +
    '%%scp-cn-1%%|||%%-3%%|||%%9%%|||%%7%%</p></div>' +
    '<span class="pager-no">page 1 of 145</span>';
  const parsedL1 = parseIncrementalListPagesResponse(l1, 'l1', 1);
  assert.equal(parsedL1.status, 'ok');
  assert.deepEqual(parsedL1.rows[0], {
    fullname: 'scp-cn-1',
    rating: -3,
    ratingVotes: 9,
    revisions: 7,
  });
  assert.equal(
    parseIncrementalListPagesResponse('<html>Access denied</html>', 'l1', 1).status,
    'failed',
  );
  assert.equal(
    parseIncrementalListPagesResponse('<div class="list-pages-box"></div>', 'l0', 1).status,
    'ok',
  );
  assert.equal(
    parseIncrementalListPagesResponse('<html>Access denied</html>', 'l0', 1).status,
    'failed',
  );
});

test('L0 小于一页时 Wikidot 不渲染 pager，仍以单批完整成功', async () => {
  const body =
    '<div class="list-pages-box"><div class="syncer2-incremental-l0-row"><p>' +
    '%%scp-cn-1%%|||%%%%date|1785196800%%%%|||%%7%%</p></div></div>';
  const fakeHttp = {
    request: async () => ({
      status: 200,
      text: () => JSON.stringify({ status: 'ok', body }),
    }),
  } as unknown as HttpClient;
  const scan = await scanIncrementalListPages(
    fakeHttp,
    'https://scp-wiki-cn.wikidot.com',
    'l0',
  );
  assert.equal(scan.status, 'ok');
  assert.equal(scan.expectedBatches, 1);
  assert.equal(scan.requestedBatches, 1);
  assert.equal(scan.pagesEnumerated, 1);
});

test('L1 offset 批次严格验证剩余集合 pager，并完整翻到末批', async () => {
  const row = (index: number) =>
    '<div class="syncer2-incremental-l1-row"><p>' +
    `%%page-${index}%%|||%%${index}%%|||%%${index + 1}%%|||%%${index + 2}%%` +
    '</p></div>';
  const firstBody =
    `<div class="list-pages-box">${Array.from({ length: 250 }, (_, i) => row(i + 1)).join('')}` +
    '</div><span class="pager-no">page 1 of 2</span>';
  const secondBody =
    `<div class="list-pages-box">${row(251)}</div>` +
    '<span class="pager-no">page 1 of 1</span>';
  const fakeHttp = {
    request: async (_url: string, options: { body?: string }) => {
      const offset = Number(new URLSearchParams(options.body).get('offset') ?? '0');
      return {
        status: 200,
        text: () => JSON.stringify({ status: 'ok', body: offset === 0 ? firstBody : secondBody }),
      };
    },
  } as unknown as HttpClient;
  const scan = await scanIncrementalListPages(
    fakeHttp,
    'https://scp-wiki-cn.wikidot.com',
    'l1',
  );
  assert.equal(scan.status, 'ok');
  assert.equal(scan.expectedBatches, 2);
  assert.equal(scan.requestedBatches, 2);
  assert.equal(scan.pagesEnumerated, 251);
});

test('L1 多批抓取期间单条跨页移动记 partial，不冒充请求/解析 failed', async () => {
  const row = (index: number) =>
    '<div class="syncer2-incremental-l1-row"><p>' +
    `%%page-${index}%%|||%%${index}%%|||%%${index + 1}%%|||%%${index + 2}%%` +
    '</p></div>';
  const firstBody =
    `<div class="list-pages-box">${Array.from({ length: 250 }, (_, i) => row(i + 1)).join('')}` +
    '</div><span class="pager-no">page 1 of 2</span>';
  const secondBody =
    `<div class="list-pages-box">${row(250)}${row(251)}</div>` +
    '<span class="pager-no">page 1 of 1</span>';
  const fakeHttp = {
    request: async (_url: string, options: { body?: string }) => {
      const offset = Number(new URLSearchParams(options.body).get('offset') ?? '0');
      return {
        status: 200,
        text: () => JSON.stringify({ status: 'ok', body: offset === 0 ? firstBody : secondBody }),
      };
    },
  } as unknown as HttpClient;

  const scan = await scanIncrementalListPages(
    fakeHttp,
    'https://scp-wiki-cn.wikidot.com',
    'l1',
  );
  assert.equal(scan.status, 'partial');
  assert.equal(scan.batchesFailed, 0);
  assert.equal(scan.validation.duplicateFullnames, 1);
  assert.match(scan.validation.reasons.join('；'), /跨批 fullname 重复 1/);
});

test('L0 按 revision 去重，L1 同时 diff vote 并核对 L0 revision', () => {
  const states = new Map([
    ['hit', {
      lastL0Revision: 3,
      lastL0UpdatedAt: '2026-07-28T00:00:00.000Z',
      lastL1Revision: 2,
      lastL1Rating: 1,
      lastL1RatingVotes: 1,
    }],
    ['miss', {
      lastL0Revision: 2,
      lastL0UpdatedAt: '2026-07-28T00:00:00.000Z',
      lastL1Revision: 2,
      lastL1Rating: 1,
      lastL1RatingVotes: 1,
    }],
  ]);
  const l0 = diffL0Rows([
    { fullname: 'hit', revisions: 3, updatedAt: '2026-07-28T00:30:00.000Z' },
  ], states);
  assert.equal(l0.changed.length, 1);
  assert.equal(l0.changed[0]?.updatedAtChangedWithoutRevision, true);

  const l1 = diffL1Rows([
    { fullname: 'hit', revisions: 3, rating: 2, ratingVotes: 2 },
    { fullname: 'miss', revisions: 3, rating: 1, ratingVotes: 1 },
  ], states, true);
  assert.equal(l1.voteChanges.length, 1);
  assert.equal(l1.revisionChanges.length, 2);
  assert.deepEqual(l1.revisionMisses.map((row) => row.current.fullname), ['miss']);
});

test('L1 首见 slug 只建修订基线，不污染 L0 跨轮覆盖率', () => {
  const l1 = diffL1Rows([
    { fullname: 'unresolved:legacy', revisions: 9, rating: 3, ratingVotes: 5 },
  ], new Map(), true);

  assert.equal(l1.voteChanges.length, 1);
  assert.equal(l1.revisionChanges.length, 0);
  assert.equal(l1.revisionMisses.length, 0);
});

test('同一 slug 修订倒退先隔离为身份待确认；单页不杀整轮', () => {
  const states = new Map([
    ['scp-cn-4885', {
      lastL0Revision: 3,
      lastL0UpdatedAt: '2026-07-30T00:00:00.000Z',
      lastL1Revision: 3,
      lastL1Rating: 0,
      lastL1RatingVotes: 0,
    }],
  ]);
  const l0 = diffL0Rows([
    { fullname: 'scp-cn-4885', revisions: 1, updatedAt: '2026-07-30T01:00:00.000Z' },
  ], states);
  const l1 = diffL1Rows([
    { fullname: 'scp-cn-4885', revisions: 1, rating: 0, ratingVotes: 0 },
  ], states, true);
  assert.deepEqual(l0.revisionRegressions, ['scp-cn-4885']);
  assert.deepEqual(l1.revisionRegressions, ['scp-cn-4885']);
  assert.equal(l0.changed.length, 0);
  assert.equal(l1.changed.length, 0);

  const health = evaluateRevisionRegressionHealth({
    regressions: 1,
    pagesEnumerated: 1,
    knownPopulation: 36_173,
    minCoverage: 0.98,
  });
  assert.equal(health.systemic, false);
  assert.equal(health.effectiveCoverage >= 0.98, true);
  assert.equal(decideRevisionRegressionIdentity(1_468_243_311, 1_468_243_311), 'same_identity_anomaly');
  assert.equal(decideRevisionRegressionIdentity(1_468_243_311, 1_500_000_000), 'slug_reuse');
});

test('大比例修订倒退仍升级整轮 failed；恰好 R9 边界不误杀', () => {
  const atBoundary = evaluateRevisionRegressionHealth({
    regressions: 20,
    pagesEnumerated: 1_000,
    minCoverage: 0.98,
  });
  assert.equal(atBoundary.effectiveCoverage, 0.98);
  assert.equal(atBoundary.systemic, false);

  const systemic = evaluateRevisionRegressionHealth({
    regressions: 21,
    pagesEnumerated: 1_000,
    minCoverage: 0.98,
  });
  assert.equal(systemic.effectiveCoverage < 0.98, true);
  assert.equal(systemic.systemic, true);
});

test('长间隔后首轮只初始化基线：保留窗口，但不污染 rolling 也不告警', () => {
  const classification = classifyRevisionCoverageBaseline({
    previousL1At: '2026-07-28T12:00:00.000Z',
    currentL1At: '2026-07-28T14:00:00.000Z',
    latestL0AtOrBeforePreviousL1: '2026-07-28T11:58:00.000Z',
    latestL0AtOrBeforeCurrentL1: '2026-07-28T13:58:00.000Z',
    frequencyMinutes: 30,
  });
  assert.equal(classification.isBaselineInit, true);
  assert.equal(classification.reason, 'l1_gap_exceeded');

  const metric = calculateRevisionCoverage({
    isBaselineInit: classification.isBaselineInit,
    l1RevisionChanges: 143,
    l0CapturedChanges: 4,
    previousRollingChanges: 20,
    previousRollingCaptured: 20,
  });
  assert.equal(metric.l0MissedChanges, 139);
  assert.equal(metric.rolling7dChanges, 20);
  assert.equal(metric.rolling7dCaptured, 20);
  assert.equal(metric.rolling7dCoverage, 1);
  assert.equal(
    shouldAlertRevisionCoverage({
      isBaselineInit: classification.isBaselineInit,
      l0MissedChanges: metric.l0MissedChanges,
    }),
    false,
  );
});

test('连续 L0/L1 窗口里的真实漏抓仍进入 rolling 并触发告警', () => {
  const classification = classifyRevisionCoverageBaseline({
    previousL1At: '2026-07-28T14:00:00.000Z',
    currentL1At: '2026-07-28T14:30:00.000Z',
    latestL0AtOrBeforePreviousL1: '2026-07-28T13:58:00.000Z',
    latestL0AtOrBeforeCurrentL1: '2026-07-28T14:28:00.000Z',
    frequencyMinutes: 30,
  });
  assert.equal(classification.isBaselineInit, false);

  const metric = calculateRevisionCoverage({
    isBaselineInit: false,
    l1RevisionChanges: 2,
    l0CapturedChanges: 1,
    previousRollingChanges: 20,
    previousRollingCaptured: 20,
  });
  assert.equal(metric.rolling7dChanges, 22);
  assert.equal(metric.rolling7dCaptured, 21);
  assert.equal(
    shouldAlertRevisionCoverage({
      isBaselineInit: false,
      l0MissedChanges: metric.l0MissedChanges,
    }),
    true,
  );
});

test('L1 比较窗口与内容写冻结重叠时只留证，不把级联阻断计作 L0 miss', () => {
  const classification = classifyRevisionCoverageBaseline({
    previousL1At: '2026-07-29T01:07:43.291Z',
    currentL1At: '2026-07-29T01:37:33.235Z',
    latestL0AtOrBeforePreviousL1: '2026-07-29T01:02:00.000Z',
    latestL0AtOrBeforeCurrentL1: '2026-07-29T01:32:00.000Z',
    frequencyMinutes: 30,
    blockingFreezeDomains: ['all'],
  });
  assert.equal(classification.isBaselineInit, true);
  assert.equal(classification.reason, 'write_freeze_overlap:all');

  const metric = calculateRevisionCoverage({
    isBaselineInit: classification.isBaselineInit,
    l1RevisionChanges: 3,
    l0CapturedChanges: 1,
    previousRollingChanges: 20,
    previousRollingCaptured: 20,
  });
  assert.equal(metric.l0MissedChanges, 2);
  assert.equal(metric.rolling7dChanges, 20);
  assert.equal(metric.rolling7dCaptured, 20);
  assert.equal(metric.rolling7dCoverage, 1);
  assert.equal(
    shouldAlertRevisionCoverage({
      isBaselineInit: classification.isBaselineInit,
      l0MissedChanges: metric.l0MissedChanges,
    }),
    false,
  );
});

test('修订覆盖证明持续写 meta，且 PHFIX population 四层独立', async () => {
  const migration = await readFile(
    new URL('../migrations/0018_layered_incremental.sql', import.meta.url),
    'utf8',
  );
  assert.match(migration, /CREATE TABLE IF NOT EXISTS meta\.revision_coverage_metric/);
  assert.match(migration, /rolling_7d_coverage/);
  assert.match(migration, /is_baseline_init/);
  assert.match(
    migration,
    /l0_captured_changes \+ l0_missed_changes = l1_revision_changes/,
  );

  const incremental = await readFile(
    new URL('../src/cli/incremental-scan.ts', import.meta.url),
    'utf8',
  );
  assert.match(incremental, /l0_updated_at_window/);
  assert.match(incremental, /l1_full_site_minimal/);
  assert.match(incremental, /recordRevisionCoverage/);
  assert.match(incremental, /loadRevisionCoverageWriteFreezeDomains/);
  assert.match(incremental, /l1_revision_crosscheck_miss/);
  assert.match(incremental, /revision_regression_identity_check/);
  assert.doesNotMatch(incremental, /revisions 倒退.*throw new Error/);

  const sitemap = await readFile(
    new URL('../src/cli/sitemap-scan.ts', import.meta.url),
    'utf8',
  );
  const tier1 = await readFile(
    new URL('../src/cli/tier1-scan.ts', import.meta.url),
    'utf8',
  );
  assert.match(sitemap, /l2_sitemap_absence/);
  assert.match(tier1, /l3_full_site_tier1/);
});
