import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';

import {
  applyMappedAttributionSnapshots,
  attributionFingerprint,
  discoverSeriesPages,
  parseAlternateTitleSource,
  parseAttributionSource,
  resolveAttributionPage,
  type ParsedAttributionEntry,
} from '../src/collect/conventions.js';

const here = path.dirname(fileURLToPath(import.meta.url));

function fixture(name: string): string {
  return readFileSync(path.join(here, 'fixtures', name), 'utf8');
}

test('M6 署名 fixture：按四列表头解析，别的两列表被忽略，残缺行显式 partial', () => {
  const result = parseAttributionSource(
    fixture('m6-attributions.synthetic.txt'),
    'attribution-metadata',
  );
  assert.equal(result.status, 'partial');
  assert.equal(result.data.entries.length, 2);
  assert.equal(result.data.rejectedRows.length, 1);
  assert.equal(result.data.attributionTables, 1);
  assert.equal(result.data.ignoredOtherTables, 1);

  const [first, second] = result.data.entries;
  assert.deepEqual(
    {
      slug: first?.pageSlug,
      user: first?.userName,
      role: first?.role,
      date: first?.atDate,
      precision: first?.datePrecision,
      ord: first?.ord,
    },
    {
      slug: 'scp-001',
      user: 'Alice',
      role: 'AUTHOR',
      date: '2020-01-02',
      precision: 'day',
      ord: 0,
    },
  );
  assert.equal(second?.role, 'TRANSLATOR');
  assert.equal(second?.atDate, null);
  assert.equal(second?.datePrecision, 'month');
  assert.match(result.data.warnings[0] ?? '', /只有月精度/);
  assert.match(result.error, /不得产生 removed/);
});

test('M6 署名负向：合法空四列表与解析失败可区分', () => {
  const empty = parseAttributionSource('||~ 标题||~ 用户||~ 类型||~ 时间||\n', 'empty');
  assert.equal(empty.status, 'ok');
  assert.deepEqual(empty.data.entries, []);

  const waf = parseAttributionSource('<html><title>Access denied</title></html>', 'waf');
  assert.equal(waf.status, 'failed');
  assert.match(waf.error, /找不到.*四列署名表头/);

  const blank = parseAttributionSource('  ', 'blank');
  assert.equal(blank.status, 'failed');
  assert.match(blank.error, /source 为空/);
});

test('M6 署名负向：未知 type 不做 lower-case 猜测', () => {
  const result = parseAttributionSource(
    '||~ 标题||~ 用户||~ 类型||~ 时间||\n||scp-001||Alice||神秘身份||2020-01-01||',
  );
  assert.equal(result.status, 'partial');
  assert.equal(result.data.entries.length, 0);
  assert.equal(result.data.rejectedRows.length, 1);
  assert.match(result.data.rejectedRows[0]?.reason ?? '', /未知署名类型/);
});

test('M6 备用标题 fixture：标题清理、占位空结果与坏候选行都可观察', () => {
  const result = parseAlternateTitleSource(
    fixture('m6-series.synthetic.txt'),
    'scp-series-test',
  );
  assert.equal(result.status, 'partial');
  assert.equal(result.data.candidateRows, 5);
  assert.deepEqual(
    result.data.entries.map((entry) => [entry.pageSlug, entry.alternateTitle]),
    [
      ['scp-001', '第一标题'],
      ['scp-002', '第二标题'],
    ],
  );
  assert.deepEqual(result.data.listedSlugs, ['scp-001', 'scp-002', 'scp-003', 'scp-004']);
  assert.equal(result.data.rejectedRows.length, 1);
});

test('M6 备用标题负向：合法占位空列表与 WAF/空响应可区分', () => {
  const empty = parseAlternateTitleSource(
    '* [[[scp-001]]] - [ACCESS DENIED]\n* [[[scp-002]]] - //尚未创建//',
  );
  assert.equal(empty.status, 'ok');
  assert.deepEqual(empty.data.entries, []);
  assert.deepEqual(empty.data.listedSlugs, ['scp-001', 'scp-002']);

  const waf = parseAlternateTitleSource('<html>challenge</html>');
  assert.equal(waf.status, 'failed');
  assert.match(waf.error, /没有任何.*列表候选行/);

  const blank = parseAlternateTitleSource('');
  assert.equal(blank.status, 'failed');
  assert.match(blank.error, /source 为空/);
});

test('M6 备用标题：冒号后的附注不能覆盖链接显示标题', () => {
  const result = parseAlternateTitleSource(
    [
      '* [[[SCP-CN-3201|谜题-3201]]]',
      '* [[[SCP-CN-3202|谜题-3202]]]',
      '* [[[SCP-CN-3203|谜题-3203]]]',
      '* [[[SCP-CN-3204|谜题-3204]]]：//老天爷//',
    ].join('\n'),
    'scp-series-cn-4',
  );
  assert.equal(result.status, 'ok');
  assert.deepEqual(
    result.data.entries.map((entry) => entry.alternateTitle),
    ['谜题-3201', '谜题-3202', '谜题-3203', '谜题-3204'],
  );
});

test('M6 系列页从顶栏动态发现：新增第 11 系列自动进入，不靠硬编码数组', () => {
  const result = discoverSeriesPages(fixture('m6-discovery.synthetic.html'));
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.data.sourcePageSlugs, [
    'scp-series',
    'scp-series-10',
    'scp-series-11',
    'joke-scps',
    'scp-series-cn',
    'scp-series-cn-6',
    'scp-ex-cn',
    'scp-international',
  ]);
  assert.ok(result.data.discoveredPrefixes.includes('scp-series'));
  assert.ok(result.data.discoveredPrefixes.includes('scp-series-cn'));
  assert.ok(!result.data.sourcePageSlugs.includes('scp-series-10-tales-edition'));
  assert.ok(!result.data.sourcePageSlugs.includes('log-of-anomalous-items-cn'));
});

test('M6 系列页发现负向：空结果与模板结构失败显式 failed', () => {
  const noBar = discoverSeriesPages('<html><body><a href="/scp-series">series</a></body></html>');
  assert.equal(noBar.status, 'failed');
  assert.match(noBar.error, /缺少 #top-bar/);

  const emptyBar = discoverSeriesPages(
    '<div id="top-bar"><div class="top-bar"><ul><li>网站<ul><li>x</li></ul></li></ul></div></div>',
  );
  assert.equal(emptyBar.status, 'failed');
  assert.match(emptyBar.error, /未发现 SCP 系列组/);
});

test('M6 新署名 by-slug：单候选无需日期；多候选必须由日期唯一命中生命周期', () => {
  const oldPage = {
    pageId: 10,
    wikidotId: 1010,
    life: [
      { kind: 'created' as const, occurredAt: '2020-01-01T00:00:00.000Z' },
      { kind: 'deleted' as const, occurredAt: '2021-12-31T12:00:00.000Z' },
    ],
  };
  const newPage = {
    pageId: 20,
    wikidotId: 2020,
    life: [{ kind: 'created' as const, occurredAt: '2022-01-01T00:00:00.000Z' }],
  };

  assert.deepEqual(
    resolveAttributionPage({ atDate: null, datePrecision: 'none' }, [oldPage]),
    { status: 'resolved', pageId: 10, wikidotId: 1010, reason: 'unique_slug' },
  );
  assert.deepEqual(
    resolveAttributionPage({ atDate: null, datePrecision: 'none' }, [oldPage, newPage]),
    {
      status: 'rejected',
      reason: 'reused_slug_without_day_date',
      candidatePageIds: [10, 20],
    },
  );
  assert.deepEqual(
    resolveAttributionPage(
      { atDate: '2020-06-01', datePrecision: 'day' },
      [oldPage, newPage],
    ),
    { status: 'resolved', pageId: 10, wikidotId: 1010, reason: 'dated_lifecycle' },
  );
  assert.deepEqual(
    resolveAttributionPage(
      { atDate: '2023-06-01', datePrecision: 'day' },
      [oldPage, newPage],
    ),
    { status: 'resolved', pageId: 20, wikidotId: 2020, reason: 'dated_lifecycle' },
  );
});

test('M6 新署名 by-slug：生命周期重叠/同日交接时多候选即拒绝', () => {
  const first = {
    pageId: 1,
    wikidotId: 101,
    life: [
      { kind: 'created' as const, occurredAt: '2020-01-01T00:00:00.000Z' },
      { kind: 'deleted' as const, occurredAt: '2021-01-02T01:00:00.000Z' },
    ],
  };
  const second = {
    pageId: 2,
    wikidotId: 102,
    life: [{ kind: 'created' as const, occurredAt: '2021-01-02T20:00:00.000Z' }],
  };
  const result = resolveAttributionPage(
    { atDate: '2021-01-02', datePrecision: 'day' },
    [first, second],
  );
  assert.equal(result.status, 'rejected');
  assert.equal(result.reason, 'date_matches_multiple_lifecycles');
});

test('M6 存量映射入口在触库前拒绝任何 slug 字段', async () => {
  const bad = {
    pageId: 1,
    wikidotId: 101,
    actorId: 201,
    role: 'AUTHOR',
    ord: 0,
    atDate: null,
    v1PageVersionId: 301,
    pageSlug: 'scp-reused',
  };
  await assert.rejects(
    applyMappedAttributionSnapshots({} as Pool, [bad], {
      observedAt: '2026-07-27T00:00:00.000Z',
      runId: null,
      source: 'v1_attribution_carryover',
      isComplete: true,
    }),
    /存量入口禁止按 slug 重解析/,
  );
});

test('M6 完整空署名页必须显式给 page 身份，传给 apply_* 的确是空数组', async () => {
  let capturedParams: unknown[] | undefined;
  const fakePool = {
    query: async (_sql: string, params?: unknown[]) => {
      capturedParams = params;
      return {
        rows: [{ applied: { added: 0, updated: 0, removed: 2 } }],
        rowCount: 1,
      };
    },
  } as unknown as Pool;

  const summary = await applyMappedAttributionSnapshots(fakePool, [], {
    observedAt: '2026-07-27T00:00:00.000Z',
    runId: 9,
    source: 'v1_attribution_carryover',
    isComplete: true,
    emptyTargets: [{ pageId: 10, wikidotId: 1010 }],
  });

  assert.equal(capturedParams?.[0], 10);
  assert.deepEqual(JSON.parse(String(capturedParams?.[1])), []);
  assert.equal(capturedParams?.[2], true);
  assert.equal(capturedParams?.[6], 1010);
  assert.deepEqual(summary, {
    pages: 1,
    entries: 0,
    added: 0,
    updated: 0,
    removed: 2,
    results: { '10': { added: 0, updated: 0, removed: 2 } },
  });
});

test('M6 署名行指纹稳定且包含 ord，重复同名作者不会塌缩', () => {
  const base: ParsedAttributionEntry = {
    sourceSlug: 'attribution-metadata',
    line: 10,
    pageSlug: 'scp-001',
    userName: 'Alice',
    rawType: '作者',
    role: 'AUTHOR',
    atDate: null,
    rawDate: '',
    datePrecision: 'none',
    isForumOrigin: false,
    ord: 0,
  };
  assert.equal(attributionFingerprint(base), attributionFingerprint({ ...base, line: 999 }));
  assert.notEqual(attributionFingerprint(base), attributionFingerprint({ ...base, ord: 1 }));
});
