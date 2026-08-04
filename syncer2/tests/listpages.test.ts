/**
 * M1 ListPages 解析与四道校验。
 *
 * 核心负向契约：合法空结果是 `ok + rows=[]`；WAF/空体/pager 丢失/selector 残留是
 * `failed`。两者在类型和值上都不可混淆。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  LISTPAGES_PARSE_DROP_LIMIT,
  LISTPAGES_SELECTORS,
  buildListPagesModuleBody,
  buildListPagesRequest,
  createListPagesSnapshot,
  deriveListPagesTriggers,
  diffListPages,
  finalizeListPagesRun,
  parseListPagesResponse,
  type ListPagesBatchOutcome,
  type ListPagesDiff,
} from '../src/collect/listpages.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const PROJECT_ROOT = path.dirname(path.dirname(FIXTURES));
const fixture = (name: string): string => fs.readFileSync(path.join(FIXTURES, name), 'utf-8');
const reconstructed = (): string => fixture('listpages_page_1.reconstructed.html');

describe('ListPages 请求构造', () => {
  it('逐字使用规格代码块列出的全部 selector，双百分号定界，且不含两个禁止项', () => {
    assert.deepEqual(LISTPAGES_SELECTORS, [
      'fullname',
      'category',
      'name',
      'title',
      'tags',
      '_tags',
      'parent_fullname',
      'created_at',
      'created_by',
      'created_by_id',
      'created_by_unix',
      'updated_at',
      'commented_at',
      'rating',
      'rating_votes',
      'comments',
      'size',
      'revisions',
      'total',
      'index',
    ]);
    // 权威正文写“21 个”，但逐项只有 20 个；本断言钉住实际代码块，避免偷偷加禁止项。
    assert.equal(LISTPAGES_SELECTORS.length, 20);
    const body = buildListPagesModuleBody();
    for (const selector of LISTPAGES_SELECTORS) {
      assert.ok(body.includes(`%%%%${selector}%%%%`), selector);
    }
    assert.equal((body.match(/\|\|\|/g) ?? []).length, LISTPAGES_SELECTORS.length - 1);
    assert.doesNotMatch(body, /page_id|rating_percent|created_by_linked/);
  });

  it('请求参数固定为 category=* / created_at desc / perPage=250 / offset', () => {
    const request = buildListPagesRequest(3);
    assert.equal(request.moduleName, 'list/ListPagesModule');
    assert.equal(request.params.category, '*');
    assert.equal(request.params.order, 'created_at desc');
    assert.equal(request.params.perPage, 250);
    assert.equal(request.params.offset, 500);
  });
});

describe('ListPages 固定 fixture 正向解析', () => {
  it('解析 20 字段、隐藏标签、epoch 日期与已注销创建者双空', () => {
    const outcome = parseListPagesResponse(reconstructed(), 1);
    assert.equal(outcome.status, 'ok');
    if (outcome.status !== 'ok') return;
    assert.equal(outcome.data.rows.length, 2);
    assert.deepEqual(outcome.data.rows[0]!.tags, ['euclid', 'scp', '原创']);
    assert.deepEqual(outcome.data.rows[0]!.hiddenTags, ['_2025新竞保护', '_cc']);
    assert.deepEqual(outcome.data.rows[0]!.mergedTags, [
      '_2025新竞保护',
      '_cc',
      'euclid',
      'scp',
      '原创',
    ]);
    assert.equal(outcome.data.rows[0]!.title, 'SCP-CN-4813 & Test');
    assert.equal(outcome.data.rows[0]!.createdAt, '2026-07-27T11:26:27.000Z');
    assert.equal(outcome.data.rows[1]!.createdBy, '(user deleted)');
    assert.equal(outcome.data.rows[1]!.createdById, null);
    assert.equal(outcome.data.rows[1]!.createdByUnix, null);
  });

  it('同时支持规格所述 span.odate time_<epoch> 日期形态', () => {
    const html = reconstructed().replace(
      '%%%%date|1785151587%%%%',
      '%%<span class="odate time_1785151587">27 Jul 2026</span>%%',
    );
    const outcome = parseListPagesResponse(html, 1);
    assert.equal(outcome.status, 'ok');
    if (outcome.status === 'ok') {
      assert.equal(outcome.data.rows[0]!.createdAt, '2026-07-27T11:26:27.000Z');
    }
  });

  it('真实值等于 selector 名时允许 Wikidot 二次展开的有限固定点', () => {
    const html = reconstructed()
      .replace(
        '%%scp-cn-4813%%|||%%_default%%|||%%scp-cn-4813%%',
        'name|||%%_default%%|||name',
      );
    const outcome = parseListPagesResponse(html, 1);
    assert.equal(outcome.status, 'ok');
    if (outcome.status === 'ok') {
      assert.equal(outcome.data.rows[0]!.fullname, 'name');
      assert.equal(outcome.data.rows[0]!.name, 'name');
    }
  });

  it('name 命中站点其它 selector 时必须由 fullname 末段反证', () => {
    const good = reconstructed().replace(
      '%%scp-cn-4813%%|||%%_default%%|||%%scp-cn-4813%%',
      '%%forum:forum%%|||%%forum%%|||forum',
    );
    const parsed = parseListPagesResponse(good, 1);
    assert.equal(parsed.status, 'ok');
    if (parsed.status === 'ok') assert.equal(parsed.data.rows[0]!.name, 'forum');

    const recoveredHtml = good.replace(
      '%%forum:forum%%|||%%forum%%|||forum',
      '%%forum:category%%|||%%forum%%|||forum',
    );
    const recovered = parseListPagesResponse(recoveredHtml, 1);
    assert.equal(recovered.status, 'ok');
    if (recovered.status === 'ok') assert.equal(recovered.data.rows[0]!.name, 'category');
  });

  it('末批无 pager 时只可由非空且一致的逐行 total 恢复', () => {
    const withoutPager = reconstructed().replace(/<div class="pager">[\s\S]*$/, '');
    const outcome = parseListPagesResponse(withoutPager, 1);
    assert.equal(outcome.status, 'ok');
    if (outcome.status === 'ok') {
      assert.equal(outcome.data.pager.source, 'row-total');
      assert.equal(outcome.data.pager.totalPages, 1);
    }
  });
});

describe('空结果与解析失败可区分', () => {
  it('结构完整且 pager 明确 page 1 of 1 的空集合是合法 ok', () => {
    const empty =
      '<div class="list-pages-box"></div>' +
      '<div class="pager"><span class="pager-no">page 1 of 1</span>' +
      '<span class="current">1</span></div>';
    const outcome = parseListPagesResponse(empty, 1);
    assert.equal(outcome.status, 'ok');
    if (outcome.status === 'ok') assert.deepEqual(outcome.data.rows, []);
  });

  for (const [name, body, reason] of [
    ['空响应', '', /body 为空/],
    ['WAF HTML', '<html><title>Access denied</title></html>', /pager 解析失败/],
  ] as const) {
    it(`${name} 明确 failed，绝不返回空数组`, () => {
      const outcome = parseListPagesResponse(body, 1);
      assert.equal(outcome.status, 'failed');
      if (outcome.status === 'failed') assert.match(outcome.error, reason);
    });
  }
});

describe('四道校验', () => {
  it('任一 selector 字面量残留即整批 failed', () => {
    const html = reconstructed().replace(
      '%%SCP-CN-4813 &amp; Test%%',
      '%%%%page_id%%%%',
    );
    const outcome = parseListPagesResponse(html, 1);
    assert.equal(outcome.status, 'failed');
    if (outcome.status === 'failed') {
      assert.match(outcome.error, /selector 字面量残留/);
      assert.equal(outcome.diagnostics?.selectorLiteralFields, 1);
    }
  });

  it('一行字段数不符必须计数，不静默 continue', () => {
    const html = reconstructed().replace('%%euclid scp 原创%%|||%%_cc', '%%euclid scp 原创%% %%_cc');
    const outcome = parseListPagesResponse(html, 1);
    assert.equal(outcome.status, 'failed');
    if (outcome.status === 'failed') {
      assert.equal(outcome.diagnostics?.droppedFieldCountRows, 1);
      assert.equal(outcome.diagnostics?.candidateRows, 2);
      assert.equal(outcome.diagnostics?.parseDropRate, 0.5);
    }
  });

  it('丢 1/250=0.4% 为 partial；丢 2/250=0.8% 超阈值为 failed', () => {
    const oneBad = buildBatch(250, new Set([100]));
    const partial = parseListPagesResponse(oneBad, 1);
    assert.equal(partial.status, 'partial');
    if (partial.status === 'partial') {
      assert.equal(partial.data?.diagnostics.parseDropRate, 1 / 250);
      assert.ok((partial.data?.diagnostics.parseDropRate ?? 1) <= LISTPAGES_PARSE_DROP_LIMIT);
    }

    const twoBad = parseListPagesResponse(buildBatch(250, new Set([100, 200])), 1);
    assert.equal(twoBad.status, 'failed');
    if (twoBad.status === 'failed') {
      assert.equal(twoBad.diagnostics?.parseDropRate, 2 / 250);
      assert.match(twoBad.error, /> 0\.5%/);
    }
  });

  it('rating 含小数点触发五星运行时断言并拒绝整页', () => {
    const html = buildBatch(250, new Set(), new Map([[37, '1.5']]));
    const outcome = parseListPagesResponse(html, 1);
    assert.equal(outcome.status, 'partial');
    if (outcome.status === 'partial') {
      assert.equal(outcome.data?.diagnostics.rejectedFiveStarRows, 1);
      assert.match(outcome.error, /拒绝 1 行/);
    }
  });

  it('跨批 index 连续为 sample partial；空洞/重叠也明确 partial', () => {
    const batch1 = parseListPagesResponse(buildBatch(2, new Set(), new Map(), 1, 4, 1, 2), 1, 1, 2);
    // offset 模式的原始 total 是“剩余条数”：第 2 批为 2，加回 offset=2 后得全量 4。
    const batch2 = parseListPagesResponse(buildBatch(2, new Set(), new Map(), 3, 2, 1, 2), 2, 1, 2);
    const good = finalizeListPagesRun(
      new Map([
        [1, batch1],
        [2, batch2],
      ]),
      2,
      2,
      2,
    );
    assert.equal(good.status, 'ok');
    assert.equal(good.validation.indexContinuous, true);

    const gapBatch = parseListPagesResponse(buildBatch(2, new Set(), new Map(), 4, 2, 1, 2), 2, 1, 2);
    const gap = finalizeListPagesRun(
      new Map([
        [1, batch1],
        [2, gapBatch],
      ]),
      2,
      2,
      2,
    );
    assert.equal(gap.status, 'partial');
    assert.equal(gap.validation.indexContinuous, false);
    assert.match(gap.validation.reasons.join(' '), /index/);

    const overlapBatch = parseListPagesResponse(
      buildBatch(2, new Set(), new Map(), 2, 2, 1, 2),
      2,
      1,
      2,
    );
    const overlap = finalizeListPagesRun(
      new Map([
        [1, batch1],
        [2, overlapBatch],
      ]),
      2,
      2,
      2,
    );
    assert.equal(overlap.status, 'partial');
    assert.ok(overlap.validation.duplicateIndexes > 0);
  });

  it('首批/末批 total 改变时整轮 partial', () => {
    const batch1 = parseListPagesResponse(buildBatch(2, new Set(), new Map(), 1, 4, 1, 2), 1, 1, 2);
    // raw=3 + offset=2 => 归一后 5，刻意制造首末漂移。
    const batch2 = parseListPagesResponse(buildBatch(2, new Set(), new Map(), 3, 3, 1, 2), 2, 1, 2);
    const run = finalizeListPagesRun(
      new Map<number, ListPagesBatchOutcome>([
        [1, batch1],
        [2, batch2],
      ]),
      2,
      2,
      2,
    );
    assert.equal(run.status, 'partial');
    assert.equal(run.validation.firstTotal, 4);
    assert.equal(run.validation.lastTotal, 5);
    assert.equal(run.validation.totalStable, false);
  });
});

describe('触发矩阵 diff', () => {
  it('tags/_tags 用集合比较，顺序变化不触发；评分/修订/评论各自独立', () => {
    const parsed = parseListPagesResponse(reconstructed(), 1);
    assert.equal(parsed.status, 'ok');
    if (parsed.status !== 'ok') return;
    const snapshot = createListPagesSnapshot(parsed.data.rows, 2, '2026-07-27T00:00:00.000Z');
    const current = structuredClone(parsed.data.rows);
    current[0]!.tags.reverse();
    current[0]!.hiddenTags.reverse();
    current[0]!.rating++;
    current[1]!.revisions++;
    current[1]!.comments++;
    const diff = diffListPages(current, snapshot);
    assert.equal(diff.changed.length, 2);
    assert.equal(diff.changed[0]!.votesChanged, true);
    assert.equal(diff.changed[0]!.tagsChanged, false);
    assert.equal(diff.changed[1]!.revisionsChanged, true);
    assert.equal(diff.changed[1]!.forumChanged, true);
  });

  it('§3.5 的四类 scan_task、标签直写与已注销创建者补偿逐项钉住', () => {
    const parsed = parseListPagesResponse(reconstructed(), 1);
    assert.equal(parsed.status, 'ok');
    if (parsed.status !== 'ok') return;

    const base = structuredClone(parsed.data.rows[0]!);
    const changed = structuredClone(base);
    changed.rating++;
    changed.revisions++;
    changed.comments++;
    changed.tags.push('new-tag');
    const deletedCreator = structuredClone(parsed.data.rows[1]!);
    assert.equal(deletedCreator.createdById, null);
    assert.equal(deletedCreator.createdByUnix, null);

    const diff: ListPagesDiff = {
      bootstrap: false,
      newFullnames: ['new-page', deletedCreator.fullname],
      changed: [
        {
          current: changed,
          previous: base,
          votesChanged: true,
          revisionsChanged: true,
          forumChanged: true,
          tagsChanged: true,
          parentChanged: false,
        },
      ],
      unchanged: 0,
    };
    const signals = deriveListPagesTriggers(diff, [changed, deletedCreator])
      .map(({ fullname, kind }) => `${fullname}:${kind}`)
      .sort();

    assert.deepEqual(signals, [
      `${changed.fullname}:forum`,
      `${changed.fullname}:revisions_full`,
      `${changed.fullname}:votes_full`,
      `${deletedCreator.fullname}:meta`,
      `${deletedCreator.fullname}:meta`,
      'new-page:meta',
    ].sort());
    assert.equal(signals.some((signal) => signal.includes('tags')), false);
  });

  it('未变化的已注销创建者页不会被每轮 Tier1 重复入队', () => {
    const parsed = parseListPagesResponse(reconstructed(), 1);
    assert.equal(parsed.status, 'ok');
    if (parsed.status !== 'ok') return;
    const deletedCreator = structuredClone(parsed.data.rows[1]!);
    assert.equal(deletedCreator.createdById, null);
    assert.equal(deletedCreator.createdByUnix, null);
    const signals = deriveListPagesTriggers(
      {
        bootstrap: false,
        newFullnames: [],
        changed: [],
        unchanged: 1,
      },
      [deletedCreator],
    );
    assert.deepEqual(signals, []);
  });

  it('只改 parent_fullname 也进入 changed，但不额外制造深扫任务', () => {
    const parsed = parseListPagesResponse(reconstructed(), 1);
    assert.equal(parsed.status, 'ok');
    if (parsed.status !== 'ok') return;
    const snapshot = createListPagesSnapshot(
      parsed.data.rows,
      parsed.data.rows.length,
      '2026-07-27T00:00:00.000Z',
    );
    const current = structuredClone(parsed.data.rows);
    current[0]!.parentFullname = 'new-parent';
    const diff = diffListPages(current, snapshot);
    assert.equal(diff.changed.length, 1);
    assert.equal(diff.changed[0]!.parentChanged, true);
    assert.equal(diff.unchanged, current.length - 1);
    assert.deepEqual(deriveListPagesTriggers(diff, current), []);
  });
});

describe('Tier1 revision 声明值与本地事实分权', () => {
  it('远端 revisions 只写 claim 证据，不覆盖 page_current.revision_count', () => {
    const tier1Source = fs.readFileSync(
      path.join(PROJECT_ROOT, 'src/cli/tier1-scan.ts'),
      'utf8',
    );
    assert.match(tier1Source, /kind:\s*'revisions'[\s\S]*status:\s*'partial'/);
    assert.match(tier1Source, /claimedTotal:\s*row\.revisions/);
    assert.doesNotMatch(tier1Source, /revision_count:\s*args\.row\.revisions/);

    const migrationSource = fs.readFileSync(
      path.join(PROJECT_ROOT, 'migrations/0006_functions.sql'),
      'utf8',
    );
    const start = migrationSource.indexOf(
      'CREATE OR REPLACE FUNCTION ingest.apply_page_meta(',
    );
    const end = migrationSource.indexOf(
      'COMMENT ON FUNCTION ingest.apply_page_meta',
      start,
    );
    assert.ok(start >= 0 && end > start);
    assert.doesNotMatch(migrationSource.slice(start, end), /revision_count\s*=/);
  });
});

function buildBatch(
  count: number,
  malformedRows: ReadonlySet<number>,
  ratingOverrides: ReadonlyMap<number, string> = new Map(),
  startIndex = 1,
  total = count,
  pagerCurrent = 1,
  pagerTotal = 1,
): string {
  const rows: string[] = [];
  for (let i = 0; i < count; i++) {
    const index = startIndex + i;
    const fields = [
      `page-${index}`,
      '_default',
      `page-${index}`,
      `Page ${index}`,
      'scp safe',
      index % 10 === 0 ? '_hidden' : '',
      '',
      '%%date|1600000000%%',
      'Author',
      '12345',
      'author',
      '%%date|1600000001%%',
      '',
      ratingOverrides.get(index) ?? '1',
      '1',
      '0',
      '100',
      '1',
      String(total),
      String(index),
    ];
    let delimited = fields.map((value) => `%%${value}%%`).join('|||');
    if (malformedRows.has(index)) delimited = delimited.replace('|||', ' ');
    rows.push(`<div class="syncer2-listpages-row"><p>${delimited}</p></div>`);
  }
  return (
    `<div class="list-pages-box">${rows.join('')}</div>` +
    `<div class="pager"><span class="pager-no">page ${pagerCurrent} of ${pagerTotal}</span>` +
    `<span class="current">${pagerCurrent}</span></div>`
  );
}
