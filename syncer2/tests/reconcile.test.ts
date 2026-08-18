import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { gzipSync } from 'node:zlib';

import {
  compareCromCanary,
  fetchAllCromPages,
  parseCromConnection,
  type CromFetchResult,
  type CromPage,
  type V2CanaryPage,
} from '../src/reconcile/crom.js';
import type { HttpClient } from '../src/http/client.js';
import {
  compareFrozenChecksum,
  compareStateAlignment,
  compareWhitelistMetrics,
  computeQualifiedDailyStreak,
  gateParityStatus,
  V1_SYNTHETIC_TEST_PAGE_ALLOWLIST,
  type ParityPageState,
} from '../src/reconcile/parity.js';
import {
  assembleReport,
  buildQqSummary,
} from '../src/reconcile/report.js';
import {
  applyEnumerationPageGetEvidence,
  loadEnumerationSnapshots,
  compareEnumerationSets,
  summarizeActiveTriangle,
  type TrianglePageOutcome,
} from '../src/reconcile/triangle.js';
import {
  writeListPagesSnapshot,
  type ListPageRecord,
  type ListPagesSnapshot,
} from '../src/collect/listpages.js';
import {
  snapshotPath,
  writeSnapshot,
  type SitemapSnapshot,
} from '../src/store/snapshot.js';
import { isReconcileFailure } from '../src/reconcile/types.js';
import {
  advanceDailyL1EnumerationSnapshot,
  createL1EnumerationSnapshot,
  l1EnumerationSnapshotPath,
  readL1EnumerationSnapshot,
  writeL1EnumerationSnapshot,
} from '../src/store/l1EnumerationSnapshot.js';
import type {
  IncrementalListPagesRun,
  L1ListPageRow,
} from '../src/collect/incrementalListPages.js';

test('CROM 解析：结构合法的空 connection 与解析失败可区分', () => {
  const empty = parseCromConnection(
    JSON.stringify({
      data: { pages: { edges: [], pageInfo: { hasNextPage: false, endCursor: null } } },
    }),
  );
  assert.equal(empty.status, 'ok');
  if (empty.status === 'ok') assert.equal(empty.data.pages.length, 0);

  const malformed = parseCromConnection('<html>WAF</html>');
  assert.equal(malformed.status, 'failed');
  if (malformed.status === 'failed') assert.match(malformed.error, /JSON/);
});

test('CROM 解析：hasNextPage=true 但空 edges/cursor 是失败，不是空批', () => {
  const parsed = parseCromConnection(
    JSON.stringify({
      data: { pages: { edges: [], pageInfo: { hasNextPage: true, endCursor: null } } },
    }),
  );
  assert.equal(parsed.status, 'failed');
  if (parsed.status === 'failed') assert.match(parsed.error, /endCursor|空/);
});

test('CROM 解析：六个廉价字段逐项解析', () => {
  const parsed = parseCromConnection(
    JSON.stringify({
      data: {
        pages: {
          edges: [
            {
              cursor: 'c1',
              node: {
                url: 'http://scp-wiki-cn.wikidot.com/scp-cn-100',
                wikidotId: '123',
                title: '标题',
                rating: 7,
                voteCount: 9,
                revisionCount: 11,
              },
            },
          ],
          pageInfo: { hasNextPage: false, endCursor: 'c1' },
        },
      },
    }),
  );
  assert.equal(parsed.status, 'ok');
  if (parsed.status === 'ok') {
    assert.deepEqual(parsed.data.pages[0], {
      wikidotId: 123,
      url: 'http://scp-wiki-cn.wikidot.com/scp-cn-100',
      slug: 'scp-cn-100',
      title: '标题',
      rating: 7,
      voteCount: 9,
      revisionCount: 11,
    });
  }
});

test('CROM 显式 maxPages 会下推到 GraphQL first，不会多抓一整批', async () => {
  const firstValues: number[] = [];
  const fakeHttp = {
    request: async (_url: string, options: { body?: string }) => {
      const body = JSON.parse(options.body ?? '{}') as {
        variables?: { first?: number };
      };
      firstValues.push(Number(body.variables?.first));
      return {
        text: () =>
          JSON.stringify({
            data: {
              pages: {
                edges: [1, 2, 3].map((id) => ({
                  cursor: `c${id}`,
                  node: {
                    url: `http://scp-wiki-cn.wikidot.com/p-${id}`,
                    wikidotId: id,
                    title: `p-${id}`,
                    rating: 0,
                    voteCount: 0,
                    revisionCount: 0,
                  },
                })),
                pageInfo: { hasNextPage: true, endCursor: 'c3' },
              },
            },
          }),
      };
    },
  } as unknown as HttpClient;
  const result = await fetchAllCromPages(fakeHttp, { batchSize: 100, maxPages: 3 });
  assert.deepEqual(firstValues, [3]);
  assert.equal(result.pages.size, 3);
  assert.equal(result.status, 'inconclusive');
});

test('CROM 429 截断：本轨 inconclusive 且不产生 difference 计数', async () => {
  let calls = 0;
  const fakeHttp = {
    request: async () => {
      calls++;
      if (calls === 2) throw new Error('HTTP 429');
      return {
        text: () =>
          JSON.stringify({
            data: {
              pages: {
                edges: [{
                  cursor: 'c1',
                  node: {
                    url: 'http://scp-wiki-cn.wikidot.com/a',
                    wikidotId: 1,
                    title: 'a',
                    rating: 0,
                    voteCount: 0,
                    revisionCount: 0,
                  },
                }],
                pageInfo: { hasNextPage: true, endCursor: 'c1' },
              },
            },
          }),
      };
    },
  } as unknown as HttpClient;
  const fetched = await fetchAllCromPages(fakeHttp);
  const report = compareCromCanary(
    fetched,
    new Map([[2, canaryPage(2)]]),
    Date.parse('2026-07-30T00:00:00.000Z'),
    3_600_000,
  );
  assert.equal(fetched.status, 'inconclusive');
  assert.equal(report.status, 'inconclusive');
  assert.equal(report.differenceCountsAvailable, false);
  assert.deepEqual(report.counts, { compared: 0, differences: 0, unexplained: 0 });
  assert.equal(report.cromOnly, null);
  assert.equal(report.v2Only, null);
  assert.equal(report.fields.title.mismatches, null);
  assert.match(report.alerts.join('\n'), /429[\s\S]*未计算.*difference/);
  const full = assembleReport({
    mode: 'crom',
    observedAt: '2026-07-30T00:00:00.000Z',
    finishedAt: '2026-07-30T00:00:01.000Z',
    lagWindowSeconds: 3_600,
    crom: report,
  });
  assert.equal(full.status, 'inconclusive');
  assert.equal(isReconcileFailure(full.status), false);
});

test('枚举三角：已知 deleted 分类与隐藏 _ 前缀差异可解释', () => {
  const listRows = [
    listRow('scp-cn-100', '_default'),
    listRow('deleted:old-page', 'deleted'),
  ];
  const report = compareEnumerationSets(
    sitemapSnapshot(['scp-cn-100', '_hidden-page']),
    listSnapshot(listRows),
  );
  assert.equal(report.status, 'ok');
  assert.equal(report.unexplainedListPagesOnly, 0);
  assert.equal(report.unexplainedSitemapOnly, 0);
  assert.equal(report.explainedListPagesOnly, 1);
  assert.equal(report.explainedSitemapOnly, 1);
});

test('枚举三角：未知差集不会被吞成允许项', () => {
  const report = compareEnumerationSets(
    sitemapSnapshot(['scp-cn-100']),
    listSnapshot([listRow('scp-cn-100', '_default'), listRow('mystery', '_default')]),
  );
  assert.equal(report.status, 'failed');
  assert.equal(report.counts.unexplained, 1);
});

test('枚举三角：仅 Page GET 方向闭合时解释派生枚举差，失败证据仍告警', () => {
  const original = compareEnumerationSets(
    sitemapSnapshot(['live', 'deleted-now']),
    listSnapshot([listRow('live', '_default'), listRow('sitemap-missed', '_default')]),
  );
  assert.equal(original.counts.unexplained, 2);
  const adjudicated = applyEnumerationPageGetEvidence(
    original,
    new Map([
      [
        'sitemap-missed',
        {
          kind: 'ok' as const,
          httpStatus: 200,
          identity: {
            wikidotId: 123,
            categoryId: null,
            siteId: null,
            siteUnixName: null,
            pageUnixName: 'sitemap-missed',
            requestPageName: 'sitemap-missed',
            themeId: null,
            lang: null,
          },
          wireBytes: 1,
          durationMs: 1,
        },
      ],
      ['deleted-now', { kind: 'gone' as const, httpStatus: 404, error: 'gone' }],
    ]),
  );
  assert.equal(adjudicated.status, 'ok');
  assert.equal(adjudicated.counts.unexplained, 0);
  assert.equal(adjudicated.explainedListPagesOnly, 1);
  assert.equal(adjudicated.explainedSitemapOnly, 1);

  const failedEvidence = applyEnumerationPageGetEvidence(
    original,
    new Map([['sitemap-missed', { kind: 'failed' as const, httpStatus: 503, error: 'busy' }]]),
  );
  assert.equal(failedEvidence.status, 'failed');
  assert.equal(failedEvidence.counts.unexplained, 2);
});

test('枚举三角：快照过旧时 inconclusive，说明原因且不计算差异', () => {
  const stateDir = mkdtempSync(path.join(tmpdir(), 'reconcile-stale-'));
  try {
    writeSnapshot(snapshotPath(stateDir, 'sitemap-page'), sitemapSnapshot(['a']));
    writeListPagesSnapshot(
      path.join(stateDir, 'listpages-tier1.snapshot.json.gz'),
      listSnapshot([listRow('b', '_default')]),
    );
    const loaded = loadEnumerationSnapshots(
      stateDir,
      Date.parse('2026-07-30T00:00:00.000Z'),
      24 * 3_600_000,
    );
    assert.equal(loaded.status, 'inconclusive');
    assert.equal(loaded.report.status, 'inconclusive');
    assert.equal(loaded.report.differenceCountsAvailable, false);
    assert.deepEqual(loaded.report.counts, { compared: 0, differences: 0, unexplained: 0 });
    assert.equal(loaded.report.sitemapOnly, null);
    assert.equal(loaded.report.listPagesOnly, null);
    assert.match(loaded.report.alerts.join('\n'), /快照过旧[\s\S]*未计算.*difference/);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('每日 L1 枚举：半截快照明确拒绝，保持 inconclusive 且不计算 difference', () => {
  const stateDir = mkdtempSync(path.join(tmpdir(), 'reconcile-half-l1-'));
  try {
    writeSnapshot(snapshotPath(stateDir, 'sitemap-page'), sitemapSnapshot(['a']));
    writeFileSync(
      l1EnumerationSnapshotPath(stateDir),
      gzipSync(Buffer.from(JSON.stringify({
        version: 1,
        kind: 'l1_full_site_minimal',
        completeness: 'writing',
        updatedAt: '2026-07-27T00:00:00.000Z',
        rows: { a: { fullname: 'a' } },
      }))),
    );
    const loaded = loadEnumerationSnapshots(
      stateDir,
      Date.parse('2026-07-27T01:00:00.000Z'),
      24 * 3_600_000,
    );
    assert.equal(loaded.status, 'inconclusive');
    assert.equal(loaded.report.differenceCountsAvailable, false);
    assert.deepEqual(loaded.report.counts, { compared: 0, differences: 0, unexplained: 0 });
    assert.match(loaded.report.alerts.join('\n'), /缺少\/损坏.*ListPages.*inconclusive/);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('每日 L1 枚举：新鲜完整原子快照恢复枚举 difference，并允许页级三角计差', () => {
  const stateDir = mkdtempSync(path.join(tmpdir(), 'reconcile-complete-l1-'));
  try {
    writeSnapshot(snapshotPath(stateDir, 'sitemap-page'), sitemapSnapshot(['a']));
    const snapshot = createL1EnumerationSnapshot(
      l1Run([
        { fullname: 'a', rating: 0, ratingVotes: 0, revisions: 1 },
        { fullname: 'mystery', rating: 1, ratingVotes: 1, revisions: 2 },
      ]),
      '2026-07-27T00:30:00.000Z',
    );
    writeL1EnumerationSnapshot(l1EnumerationSnapshotPath(stateDir), snapshot);
    const loaded = loadEnumerationSnapshots(
      stateDir,
      Date.parse('2026-07-27T01:00:00.000Z'),
      24 * 3_600_000,
    );
    assert.equal(loaded.status, 'failed');
    assert.equal(loaded.report.differenceCountsAvailable, true);
    assert.equal(loaded.report.counts.differences, 1);
    assert.equal(loaded.report.unexplainedListPagesOnly, 1);

    const active = summarizeActiveTriangle(new Map<string, TrianglePageOutcome>([[
      'mystery',
      {
        status: 'partial',
        data: {
          fullname: 'mystery',
          wikidotId: 2,
          pageId: null,
          identitySource: 'page_get',
          votes: { status: 'partial', claimed: 1, fetched: 0, actual: 0, delta: -1, error: 'diff' },
          revisions: { status: 'ok', claimed: 2, fetched: 3, actual: 3, delta: 0, error: null },
        },
      },
    ]]));
    assert.equal(active.counts.differences, 1);
    assert.equal(active.status, 'failed');
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('每轮完整 L1 都替换同日旧快照，半截轮不覆盖最后完整证据', () => {
  const stateDir = mkdtempSync(path.join(tmpdir(), 'reconcile-l1-advance-'));
  const file = l1EnumerationSnapshotPath(stateDir);
  try {
    const first = l1Run([
      { fullname: 'old-page', rating: 1, ratingVotes: 1, revisions: 1 },
    ]);
    const second = l1Run([
      { fullname: 'new-page', rating: 2, ratingVotes: 2, revisions: 2 },
    ]);
    assert.equal(
      advanceDailyL1EnumerationSnapshot(file, first, '2026-08-13T00:05:00.000Z').advanced,
      true,
    );
    assert.equal(
      advanceDailyL1EnumerationSnapshot(file, second, '2026-08-13T00:10:00.000Z').advanced,
      true,
    );
    assert.deepEqual(Object.keys(readL1EnumerationSnapshot(file)?.rows ?? {}), ['new-page']);

    const incomplete = {
      ...l1Run([{ fullname: 'partial-page', rating: 3, ratingVotes: 3, revisions: 3 }]),
      status: 'partial' as const,
      validation: {
        complete: false,
        positiveEvidenceSafe: true,
        rawRowsEnumerated: 1,
        duplicateFullnames: 0,
        duplicateFullnameRate: 0,
        duplicateFullnameRateLimit: 0.0001,
        duplicateConvergence: 'last_occurrence_wins' as const,
        reasons: ['fixture'],
      },
    };
    assert.equal(
      advanceDailyL1EnumerationSnapshot(file, incomplete, '2026-08-13T00:15:00.000Z').reason,
      'scan_incomplete',
    );
    assert.deepEqual(Object.keys(readL1EnumerationSnapshot(file)?.rows ?? {}), ['new-page']);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('状态对齐：tags 顺序不构成差异，60 分钟内变更页被排除', () => {
  const now = Date.parse('2026-07-27T12:00:00.000Z');
  const stable = parityState(1, { tags: ['b', 'a'] });
  const same = parityState(1, { tags: ['a', 'b'] });
  const recentV1 = parityState(2, { rating: 1, metaUpdatedEpochMs: now - 1_000 });
  const recentV2 = parityState(2, { rating: 99 });
  const report = compareStateAlignment(
    new Map([[1, stable], [2, recentV1]]),
    new Map([[1, same], [2, recentV2]]),
    now,
    3_600_000,
    new Map(),
  );
  assert.equal(report.status, 'ok');
  assert.equal(report.comparablePages, 1);
  assert.equal(report.lagExcludedPages, 1);
  assert.equal(report.pagesWithDifferences, 0);
});

test('状态对齐：未解释 voter checksum 差异明确失败', () => {
  const left = parityState(1, { voteChecksum: 'left' });
  const right = parityState(1, { voteChecksum: 'right' });
  const report = compareStateAlignment(
    new Map([[1, left]]),
    new Map([[1, right]]),
    Date.parse('2026-07-27T12:00:00.000Z'),
    3_600_000,
    new Map(),
  );
  assert.equal(report.status, 'failed');
  assert.equal(report.fieldDifferences.vote_state, 1);
  assert.equal(report.unexplainedPages, 1);
});

test('状态对齐：只有完整源多重集与 L1 双门闭合才解释 v1 票态差异', () => {
  const left = parityState(1, { voteChecksum: 'v1-current' });
  const right = parityState(1, {
    voteChecksum: 'verified-source-multiset',
    verifiedMultisetSnapshot: true,
  });
  const report = compareStateAlignment(
    new Map([[1, left]]),
    new Map([[1, right]]),
    Date.parse('2026-07-27T12:00:00.000Z'),
    3_600_000,
    new Map(),
  );
  assert.equal(report.status, 'ok');
  assert.equal(report.pagesWithDifferences, 1);
  assert.equal(report.unexplainedPages, 0);
  assert.equal(report.explanationCategoryPages.v2_verified_multiset_snapshot, 1);
});

test('状态对齐：仅 v1 crom:* 派生标签有确定判据，原始差异仍留在归因计数', () => {
  const left = parityState(1, { tags: ['scp', 'crom:series'] });
  const right = parityState(1, { tags: ['scp'] });
  const report = compareStateAlignment(
    new Map([[1, left]]),
    new Map([[1, right]]),
    Date.parse('2026-07-27T12:00:00.000Z'),
    3_600_000,
    new Map(),
  );
  assert.equal(report.status, 'ok');
  assert.equal(report.pagesWithDifferences, 1);
  assert.equal(report.unexplainedPages, 0);
  assert.equal(report.explanationCategoryPages.v1_crom_synthetic_tags, 1);
  assert.equal(report.rawDiffRate, 1);
  assert.equal(report.diffRate, 0);
});

test('v1 历史测试页白名单整体锁定，新增任何项都会失败', () => {
  assert.deepEqual([...V1_SYNTHETIC_TEST_PAGE_ALLOWLIST], [
    [800019414, 'test-image-page-1759148576016'],
    [800080727, 'test-image-page-1759149352271'],
    [800041112, 'test-image-page-1759413342363'],
  ]);
  const id = 800019414;
  const report = compareStateAlignment(
    new Map([[id, parityState(id, { slug: V1_SYNTHETIC_TEST_PAGE_ALLOWLIST.get(id)! })]]),
    new Map(),
    Date.parse('2026-07-27T12:00:00.000Z'),
    3_600_000,
    new Map(),
  );
  assert.equal(report.status, 'ok');
  assert.equal(report.explanationCategoryPages.v1_synthetic_test_page_allowlist, 1);
});

test('状态对齐：新鲜 ListPages 存在性与空标题都能裁决 v1 历史态', () => {
  const now = Date.parse('2026-07-27T12:00:00.000Z');
  const v1 = parityState(1, { title: 'Historical title' });
  const v2 = parityState(1, { title: null, titleDirectObserved: true });
  const onlyV2 = parityState(2, { l1SeenEpochMs: now - 1_000 });
  const report = compareStateAlignment(
    new Map([[1, v1]]),
    new Map([[1, v2], [2, onlyV2]]),
    now,
    3_600_000,
    new Map(),
  );
  assert.equal(report.status, 'ok');
  assert.equal(report.explanationCategoryPages.v1_stale_title_vs_wikidot_observation, 1);
  assert.equal(report.explanationCategoryPages.v1_stale_existence_vs_current_l1, 1);
});

test('状态对齐：显式 listpages_hidden 系统页不进入 existence 差异', () => {
  const hidden = parityState(2, {
    slug: 'component:_template',
    enumerationScope: 'listpages_hidden',
  });
  const report = compareStateAlignment(
    new Map(),
    new Map([[2, hidden]]),
    Date.parse('2026-07-27T12:00:00.000Z'),
    3_600_000,
    new Map(),
  );
  assert.equal(report.fieldDifferences.existence, 0);
  assert.equal(report.unexplainedFieldDifferences.existence, 0);
  assert.equal(report.classificationPages['excluded:listpages_hidden'], 1);
});

test('白名单轨：普通指标仍只允许稳定不增长', () => {
  const stable = compareWhitelistMetrics({ a: 5, b: 3 }, { a: 5, b: 4 });
  assert.equal(stable.status, 'ok');
  const growing = compareWhitelistMetrics({ a: 6 }, { a: 5 });
  assert.equal(growing.status, 'failed');
  assert.deepEqual(growing.growth, { a: 1 });

  const newDeletedMember = compareWhitelistMetrics(
    { deleted_page_vote_pairs: 118 },
    { deleted_page_vote_pairs: 0 },
  );
  assert.equal(newDeletedMember.status, 'ok');
  assert.deepEqual(newDeletedMember.growth, { deleted_page_vote_pairs: 118 });

  const warmingButOtherMetricBroken = compareWhitelistMetrics(
    { v1_latestvote_fold_delta: 100, imprecise_vote_events: 6 },
    { v1_latestvote_fold_delta: 90, imprecise_vote_events: 5 },
  );
  assert.equal(warmingButOtherMetricBroken.status, 'failed');
  assert.equal(warmingButOtherMetricBroken.counts.differences, 1);
  assert.match(warmingButOtherMetricBroken.alerts.join('\n'), /imprecise_vote_events 增长/);
});

test('v1_latestvote_fold_delta：低投票日改用七日窗不误报，折叠逻辑突增仍告警', () => {
  const input = {
    baselineObservedAt: '2026-08-05T06:13:00.000+08:00',
    baselineFoldDelta: 4_755_696,
    observedAt: '2026-08-12T06:13:00.000+08:00',
    windowVoteRows: 8_948,
  };
  // 旧单日判据会把 8/11 的真实增长误报；新判据不再读取这个单日分母。
  assert.ok(28_021 > 1_069 * 25);
  const natural = compareWhitelistMetrics(
    { v1_latestvote_fold_delta: 4_894_675 },
    { v1_latestvote_fold_delta: 4_866_654 },
    input,
  );
  assert.equal(natural.status, 'ok');
  assert.equal(natural.v1LatestVoteFoldWindow.foldGrowth, 138_979);
  assert.equal(natural.v1LatestVoteFoldWindow.allowedGrowth, 223_700);
  assert.equal(natural.v1LatestVoteFoldWindow.exceeded, false);
  assert.deepEqual(natural.alerts, []);

  const abnormal = compareWhitelistMetrics(
    { v1_latestvote_fold_delta: 4_979_397 },
    { v1_latestvote_fold_delta: 4_866_654 },
    input,
  );
  assert.equal(abnormal.status, 'failed');
  assert.equal(abnormal.v1LatestVoteFoldWindow.exceeded, true);
  assert.match(abnormal.alerts.join('\n'), /滚动 7 日增长 \+223701 >.*8948 × 25/);
});

test('冻结 checksum：新删页只进入下轮基线，既有已删页内容变化仍告警', () => {
  const newMember = compareFrozenChecksum(
    {
      count: 3,
      checksum: 'all-with-new-page',
      protectedCount: 2,
      protectedChecksum: 'old-members',
      newMemberVoteCount: 1,
      membershipCutoff: '2026-08-11T22:13:00.000Z',
      version: 2,
      algorithm: 'test',
    },
    'old-members',
    2,
    2,
  );
  assert.equal(newMember.status, 'ok');
  assert.equal(newMember.changed, false);
  assert.equal(newMember.deletedVoteCount, 3);
  assert.equal(newMember.protectedDeletedVoteCount, 2);
  assert.equal(newMember.newMemberVoteCount, 1);
  assert.deepEqual(newMember.alerts, []);

  const changedOldMember = compareFrozenChecksum(
    {
      count: 3,
      checksum: 'all-after-old-member-change',
      protectedCount: 2,
      protectedChecksum: 'changed-old-members',
      newMemberVoteCount: 1,
      membershipCutoff: '2026-08-11T22:13:00.000Z',
      version: 2,
      algorithm: 'test',
    },
    'old-members',
    2,
    2,
  );
  assert.equal(changedOldMember.status, 'failed');
  assert.equal(changedOldMember.changed, true);
  assert.match(changedOldMember.alerts.join('\n'), /2\/old-members.*2\/changed-old-members/);
});

test('冻结 checksum：口径升级只重建基线；既有成员消失仍是真告警', () => {
  const rebuilt = compareFrozenChecksum(
    {
      count: 2, checksum: 'b', protectedCount: 2, protectedChecksum: 'b',
      newMemberVoteCount: 0, membershipCutoff: null, version: 2, algorithm: 'test',
    },
    'a',
    2,
    1,
  );
  assert.equal(rebuilt.status, 'partial');
  assert.equal(rebuilt.baselineRebuilt, true);
  assert.equal(rebuilt.changed, false);
  assert.deepEqual(rebuilt.counts, { compared: 2, differences: 0, unexplained: 0 });
  assert.match(rebuilt.alerts.join('\n'), /口径升级.*基线重建.*非数据变化告警/);

  const frozen = compareFrozenChecksum(
    {
      count: 2, checksum: 'b', protectedCount: 2, protectedChecksum: 'b',
      newMemberVoteCount: 0, membershipCutoff: null, version: 2, algorithm: 'test',
    },
    'a',
    2,
    2,
  );
  assert.equal(frozen.status, 'failed');
  assert.equal(frozen.changed, true);
  assert.equal(frozen.baselineRebuilt, false);

  const shrunkToZero = compareFrozenChecksum(
    {
      count: 0, checksum: 'empty', protectedCount: 0, protectedChecksum: 'empty',
      newMemberVoteCount: 0, membershipCutoff: null, version: 2, algorithm: 'test',
    },
    'old',
    1,
    2,
  );
  assert.equal(shrunkToZero.counts.compared, 1);
  assert.equal(shrunkToZero.counts.differences, 1);
});

test('连续七日判据按 Asia/Shanghai 日历去重，不被同日多跑垫高', () => {
  const current = '2026-07-27T16:30:00.000Z'; // 上海 7/28
  const previous = [
    { observedAt: '2026-07-27T01:00:00.000Z', qualified: true }, // 上海 7/27
    { observedAt: '2026-07-26T01:00:00.000Z', qualified: true },
    { observedAt: '2026-07-25T01:00:00.000Z', qualified: true },
    { observedAt: '2026-07-24T01:00:00.000Z', qualified: true },
    { observedAt: '2026-07-23T01:00:00.000Z', qualified: true },
    { observedAt: '2026-07-22T01:00:00.000Z', qualified: true },
    { observedAt: '2026-07-22T02:00:00.000Z', qualified: true },
  ];
  assert.equal(computeQualifiedDailyStreak(current, true, previous), 7);
  assert.equal(gateParityStatus('ok', false), 'partial');
  assert.equal(gateParityStatus('ok', true), 'ok');
  assert.equal(gateParityStatus('failed', false), 'failed');
});

test('CROM 五项：新近 v2 页仍全量计数，但字段噪音不进入 actionable', () => {
  const remote: CromPage = {
    wikidotId: 1,
    url: 'http://scp-wiki-cn.wikidot.com/a',
    slug: 'a',
    title: '远端',
    rating: 1,
    voteCount: 2,
    revisionCount: 3,
  };
  const fetched: CromFetchResult = {
    status: 'ok',
    pages: new Map([[1, remote]]),
    batches: new Map(),
    isFull: true,
    intentionallyLimited: false,
    error: null,
  };
  const local: V2CanaryPage = {
    wikidotId: 1,
    slug: 'a',
    title: '本地',
    rating: 9,
    voteCount: 9,
    revisionCount: 9,
    updatedEpochMs: 99_000,
    titleDirectObserved: false,
    voteDirectObservedEpochMs: null,
    revisionDirectObservedEpochMs: null,
    l1Rating: null,
    l1VoteCount: null,
    l1RevisionClaimed: null,
    l1SeenEpochMs: null,
  };
  const report = compareCromCanary(fetched, new Map([[1, local]]), 100_000, 10_000);
  assert.equal(report.fields.title.mismatches, 1);
  assert.equal(report.fields.title.actionableMismatches, 0);
  assert.equal(report.status, 'ok');
});

test('CROM revisionCount 按零基声明换算：N 对本地 N+1 一致，N 对本地 N 告警', () => {
  const remote: CromPage = {
    wikidotId: 1,
    url: 'http://scp-wiki-cn.wikidot.com/a',
    slug: 'a',
    title: 'same',
    rating: 1,
    voteCount: 2,
    revisionCount: 3,
  };
  const fetched: CromFetchResult = {
    status: 'ok',
    pages: new Map([[1, remote]]),
    batches: new Map(),
    isFull: true,
    intentionallyLimited: false,
    error: null,
  };
  const local: V2CanaryPage = {
    wikidotId: 1,
    slug: 'a',
    title: 'same',
    rating: 1,
    voteCount: 2,
    revisionCount: 4,
    updatedEpochMs: null,
    titleDirectObserved: false,
    voteDirectObservedEpochMs: null,
    revisionDirectObservedEpochMs: null,
    l1Rating: null,
    l1VoteCount: null,
    l1RevisionClaimed: null,
    l1SeenEpochMs: null,
  };

  const matched = compareCromCanary(fetched, new Map([[1, local]]), 100_000, 10_000);
  assert.equal(matched.fields.revisionCount.mismatches, 0);
  assert.equal(matched.status, 'ok');

  const mismatched = compareCromCanary(
    fetched,
    new Map([[1, { ...local, revisionCount: 3 }]]),
    100_000,
    10_000,
  );
  assert.equal(mismatched.fields.revisionCount.mismatches, 1);
  assert.equal(mismatched.fields.revisionCount.actionableMismatches, 1);
  assert.equal(mismatched.status, 'failed');
});

test('CROM 五项：新鲜 WhoRated/RevisionList 直接快照可判 CROM 旧，过期快照不可', () => {
  const remote: CromPage = {
    wikidotId: 1,
    url: 'http://scp-wiki-cn.wikidot.com/a',
    slug: 'a',
    title: 'same',
    rating: 1,
    voteCount: 1,
    revisionCount: 1,
  };
  const fetched: CromFetchResult = {
    status: 'ok',
    pages: new Map([[1, remote]]),
    batches: new Map(),
    isFull: true,
    intentionallyLimited: false,
    error: null,
  };
  const directlyVerified: V2CanaryPage = {
    ...canaryPage(1),
    title: 'same',
    rating: 2,
    voteCount: 2,
    revisionCount: 3,
    voteDirectObservedEpochMs: 99_000,
    revisionDirectObservedEpochMs: 99_000,
  };
  const explained = compareCromCanary(
    fetched,
    new Map([[1, directlyVerified]]),
    100_000,
    10_000,
  );
  assert.equal(explained.fields.rating.categories.crom_stale_vs_verified_whorated, 1);
  assert.equal(explained.fields.voteCount.categories.crom_stale_vs_verified_whorated, 1);
  assert.equal(
    explained.fields.revisionCount.categories.crom_stale_vs_verified_revision_list,
    1,
  );
  assert.equal(explained.counts.unexplained, 0);

  const staleEvidence = compareCromCanary(
    fetched,
    new Map([[
      1,
      {
        ...directlyVerified,
        voteDirectObservedEpochMs: 80_000,
        revisionDirectObservedEpochMs: 80_000,
      },
    ]]),
    100_000,
    10_000,
  );
  assert.equal(staleEvidence.fields.rating.categories.unresolved_source_disagreement, 1);
  assert.equal(staleEvidence.fields.voteCount.categories.unresolved_source_disagreement, 1);
  assert.equal(staleEvidence.fields.revisionCount.categories.unresolved_source_disagreement, 1);
  assert.equal(staleEvidence.counts.unexplained, 3);
});

test('CROM 存在性：新鲜 L1 确认的 v2-only 是 CROM 滞后，真实未知缺口仍 failed', () => {
  const remote: CromPage = {
    wikidotId: 1,
    url: 'http://scp-wiki-cn.wikidot.com/p-1',
    slug: 'p-1',
    title: 'p-1',
    rating: 0,
    voteCount: 0,
    revisionCount: 0,
  };
  const fetched: CromFetchResult = {
    status: 'ok',
    pages: new Map([[1, remote]]),
    batches: new Map(),
    isFull: true,
    intentionallyLimited: false,
    error: null,
  };
  const observed = 100_000;
  const confirmedByL1 = compareCromCanary(
    fetched,
    new Map([
      [1, canaryPage(1)],
      [2, { ...canaryPage(2), l1SeenEpochMs: 99_000 }],
    ]),
    observed,
    10_000,
  );
  assert.equal(confirmedByL1.v2Only, 1);
  assert.equal(confirmedByL1.actionableExistenceDifferences, 0);
  assert.equal(confirmedByL1.existenceCategories.crom_stale_existence_vs_current_l1, 1);
  assert.equal(confirmedByL1.status, 'ok');

  const deletedCategory = compareCromCanary(
    fetched,
    new Map([
      [1, canaryPage(1)],
      [2, { ...canaryPage(2), slug: 'deleted:p-2', l1SeenEpochMs: 99_000 }],
    ]),
    observed,
    10_000,
  );
  assert.equal(deletedCategory.existenceCategories.crom_excludes_deleted_category, 1);
  assert.equal(deletedCategory.actionableExistenceDifferences, 0);

  const unknown = compareCromCanary(
    fetched,
    new Map([[1, canaryPage(1)], [2, canaryPage(2)]]),
    observed,
    10_000,
  );
  assert.equal(unknown.actionableExistenceDifferences, 1);
  assert.equal(unknown.existenceCategories.unresolved_existence_disagreement, 1);
  assert.equal(unknown.status, 'failed');
});

test('CROM 有 100+ 存在性差异时仍保留字段样本，报告总样本继续有界', () => {
  const remote: CromPage = {
    wikidotId: 1,
    url: 'http://scp-wiki-cn.wikidot.com/p-1',
    slug: 'p-1',
    title: 'remote-title',
    rating: 0,
    voteCount: 0,
    revisionCount: 0,
  };
  const fetched: CromFetchResult = {
    status: 'ok',
    pages: new Map([[1, remote]]),
    batches: new Map(),
    isFull: true,
    intentionallyLimited: false,
    error: null,
  };
  const local = new Map<number, V2CanaryPage>([
    [1, { ...canaryPage(1), title: 'local-title' }],
  ]);
  for (let id = 1_000; id < 1_150; id++) local.set(id, canaryPage(id));

  const report = compareCromCanary(fetched, local, 100_000, 10_000);
  assert.equal(report.samples.length, 100);
  assert.ok(report.samples.some((sample) => sample['field'] === 'title'));
  assert.ok(report.samples.some((sample) => sample['field'] === 'existence'));
});

test('页级三角：failed 目标显式留在结果，不会被当作空通过', () => {
  const outcomes = new Map<string, TrianglePageOutcome>([
    ['a', { status: 'failed', fullname: 'a', error: 'identity failed' }],
  ]);
  const report = summarizeActiveTriangle(outcomes);
  assert.equal(report.status, 'failed');
  assert.equal(report.requestedPages, 1);
  assert.equal(report.counts.unexplained, 1);
});

test('页级三角：claimed=N、列表=N+1 判一致', () => {
  const outcomes = new Map<string, TrianglePageOutcome>([
    [
      'a',
      {
        status: 'ok',
        data: {
          fullname: 'a',
          wikidotId: 1,
          pageId: null,
          identitySource: 'page_get',
          votes: {
            status: 'ok',
            claimed: 0,
            fetched: 0,
            actual: 0,
            delta: 0,
            error: null,
          },
          revisions: {
            status: 'ok',
            claimed: 1,
            fetched: 2,
            actual: 2,
            delta: 0,
            error: null,
          },
        },
      },
    ],
  ]);
  const report = summarizeActiveTriangle(outcomes);
  assert.equal(report.status, 'ok');
  assert.equal(report.revisionMatches, 1);
  assert.equal(report.revisionMismatches, 0);
});

test('页级三角：claimed=N、列表也=N 必须 failed 并计入告警', () => {
  const outcomes = new Map<string, TrianglePageOutcome>([
    [
      'a',
      {
        status: 'partial',
        data: {
          fullname: 'a',
          wikidotId: 1,
          pageId: null,
          identitySource: 'page_get',
          votes: {
            status: 'ok',
            claimed: 0,
            fetched: 0,
            actual: 0,
            delta: 0,
            error: null,
          },
          revisions: {
            status: 'partial',
            claimed: 2,
            fetched: 2,
            actual: 2,
            delta: -1,
            error: 'RevisionList 2 ≠ claimed 2 + offset',
          },
        },
      },
    ],
  ]);
  const report = summarizeActiveTriangle(outcomes);
  assert.equal(report.status, 'failed');
  assert.equal(report.counts.unexplained, 1);
});

test('QQ 摘要序列化为单行 JSON', () => {
  const report = assembleReport({
    mode: 'triangle',
    observedAt: '2026-07-27T00:00:00.000Z',
    finishedAt: '2026-07-27T00:00:01.000Z',
    lagWindowSeconds: 3600,
  });
  const line = JSON.stringify(buildQqSummary(report));
  assert.equal(line.includes('\n'), false);
  assert.equal(JSON.parse(line).type, 'scpper-parity');
});

function listRow(fullname: string, category: string): ListPageRecord {
  return {
    fullname,
    category,
    name: fullname.split(':').at(-1) ?? fullname,
    title: fullname,
    tags: [],
    hiddenTags: [],
    mergedTags: [],
    parentFullname: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    createdBy: null,
    createdById: null,
    createdByUnix: null,
    updatedAt: null,
    commentedAt: null,
    rating: 0,
    ratingVotes: 0,
    comments: 0,
    size: 0,
    revisions: 0,
    total: 2,
    index: 1,
  };
}

function sitemapSnapshot(slugs: string[]): SitemapSnapshot {
  return {
    version: 1,
    updatedAt: '2026-07-27T00:00:00.000Z',
    lastFullAt: '2026-07-27T00:00:00.000Z',
    lastFullCount: slugs.length,
    entries: Object.fromEntries(slugs.map((slug) => [slug, '2026-01-01T00:00:00.000Z'])),
  };
}

function listSnapshot(rows: ListPageRecord[]): ListPagesSnapshot {
  return {
    version: 1,
    updatedAt: '2026-07-27T00:00:00.000Z',
    remoteTotal: rows.length,
    rows: Object.fromEntries(rows.map((row) => [row.fullname, row])),
  };
}

function l1Run(
  rows: L1ListPageRow[],
): IncrementalListPagesRun<L1ListPageRow> {
  return {
    status: 'ok',
    layer: 'l1',
    rows,
    expectedBatches: 1,
    requestedBatches: 1,
    batchesFailed: 0,
    pagesEnumerated: rows.length,
    stoppedByRuntimeBudget: false,
    coverage: {
      scope: 'full',
      completedBatches: 1,
      expectedBatches: 1,
      batchCoverageRatio: 1,
      completedBatchRanges: ['1'],
      missingBatchRanges: [],
    },
    validation: {
      complete: true,
      positiveEvidenceSafe: true,
      rawRowsEnumerated: rows.length,
      duplicateFullnames: 0,
      duplicateFullnameRate: 0,
      duplicateFullnameRateLimit: 0.0001,
      duplicateConvergence: 'last_occurrence_wins',
      reasons: [],
    },
    parseFingerprint: {},
  };
}

function parityState(
  wikidotId: number,
  overrides: Partial<ParityPageState> = {},
): ParityPageState {
  return {
    wikidotId,
    slug: `p-${wikidotId}`,
    title: 'same',
    rating: 0,
    tags: [],
    enumerationScope: 'standard',
    metaUpdatedEpochMs: 0,
    l1SeenEpochMs: null,
    titleDirectObserved: false,
    tagsDirectObserved: false,
    voteUpdatedEpochMs: 0,
    voterCount: 0,
    voteRating: 0,
    voteChecksum: 'same',
    comparableVoterCount: 0,
    comparableVoteRating: 0,
    comparableVoteChecksum: 'same',
    anonymousVoterCount: 0,
    anonymousVoteRating: 0,
    verifiedMultisetSnapshot: false,
    ...overrides,
  };
}

function canaryPage(wikidotId: number): V2CanaryPage {
  return {
    wikidotId,
    slug: `p-${wikidotId}`,
    title: `p-${wikidotId}`,
    rating: 0,
    voteCount: 0,
    revisionCount: 1,
    updatedEpochMs: null,
    titleDirectObserved: false,
    voteDirectObservedEpochMs: null,
    revisionDirectObservedEpochMs: null,
    l1Rating: null,
    l1VoteCount: null,
    l1RevisionClaimed: null,
    l1SeenEpochMs: null,
  };
}
