import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  applyRevisionPatch,
  parseRevisionDiffBody,
  revisionDiffRequestParams,
  REVISION_DIFF_PARSER_VERSION,
  type RevisionDiffTarget,
} from '../src/collect/revisionDiff.js';
import { parseSourceBody } from '../src/collect/source.js';

const target: RevisionDiffTarget = {
  pageId: 7,
  wikidotId: 7007,
  fromRevisionId: 101,
  toRevisionId: 102,
};
const here = path.dirname(fileURLToPath(import.meta.url));

function response(sourceBody: string, tags = true): string {
  return `
    <h2>页面修订版本比较</h2>
    <div class="diff-box">
      <table class="page-compare">
        <tr><th></th><th>修订版本 4</th><th>修订版本 5</th></tr>
        <tr>
          <td>修订时间:</td>
          <td><span class="odate time_1700000000">old</span></td>
          <td><span class="odate time_1700000060">new</span></td>
        </tr>
        ${tags ? '<tr><td>标签:</td><td>scp &amp; old</a></td><td>scp 新标签</a></td></tr>' : ''}
      </table>
      <h3>源代码变更:</h3>
      ${sourceBody}
    </div>`;
}

function sourceResponse(lines: readonly string[]): string {
  return `<div class="page-source">\n\t${lines.join('<br />\n')}\n</div>`;
}

test('inline diff：实体先去包装再解码，<br /> 精确还原换行并可双向应用', () => {
  const result = parseRevisionDiffBody(
    response(
      '<div class="inline-diff page-source">\n\t' +
        '[[div class=&quot;a&amp;b&quot;]]&nbsp;<br />\n' +
        'A &gt; <del>&quot;旧&quot; &amp; x</del><ins>&quot;新&quot; &amp; y</ins><br />\n' +
        '&lt;del&gt;源码字面量&lt;/del&gt;<br />\n' +
        '<del>尾</del><ins>末</ins>\n</div>',
    ),
    target,
  );
  assert.equal(result.status, 'ok');
  if (result.status !== 'ok') return;

  assert.equal(
    result.data.beforeSource,
    '[[div class="a&b"]] \n\nA > "旧" & x\n\n<del>源码字面量</del>\n\n尾',
  );
  assert.equal(
    result.data.afterSource,
    '[[div class="a&b"]] \n\nA > "新" & y\n\n<del>源码字面量</del>\n\n末',
  );
  assert.deepEqual(result.data.beforeTags, ['scp', '&', 'old']);
  assert.deepEqual(result.data.afterTags, ['scp', '新标签']);
  assert.equal(result.data.beforeOccurredAt, '2023-11-14T22:13:20.000Z');
  assert.equal(result.data.afterOccurredAt, '2023-11-14T22:14:20.000Z');
  assert.ok(result.data.markupFeatures.gt > 0);
  assert.ok(result.data.markupFeatures.quot > 0);
  assert.ok(result.data.markupFeatures.amp > 0);
  assert.ok(result.data.markupFeatures.nbsp > 0);
  assert.ok(result.data.markupFeatures.br > 0);
  assert.equal(result.data.patch.length, 2);
  assert.equal(
    applyRevisionPatch(result.data.beforeSource!, result.data.patch, 'forward'),
    result.data.afterSource,
  );
  assert.equal(
    applyRevisionPatch(result.data.afterSource!, result.data.patch, 'backward'),
    result.data.beforeSource,
  );
});

test('源码相同：保留标签与两侧时间，空 patch 不伪造源码', () => {
  const result = parseRevisionDiffBody(
    response('<p>页面源代码相同。</p>'),
    target,
  );
  assert.equal(result.status, 'ok');
  if (result.status !== 'ok') return;
  assert.equal(result.data.sourceChanged, false);
  assert.equal(result.data.beforeSource, null);
  assert.equal(result.data.afterSource, null);
  assert.deepEqual(result.data.patch, []);
  assert.deepEqual(result.data.beforeTags, ['scp', '&', 'old']);
  assert.deepEqual(result.data.afterTags, ['scp', '新标签']);
});

test('整行 ins 闭标签后的 <br /> 只属于新侧，不给旧版凭空多造空行', () => {
  const result = parseRevisionDiffBody(
    response(
      '<div class="inline-diff page-source">\n\t' +
        'before<br />\n<br />\n' +
        '<ins>new-1<br />\nnew-2<br />\n</ins><br />\n' +
        'after\n</div>',
      false,
    ),
    target,
  );
  assert.equal(result.status, 'ok');
  if (result.status !== 'ok') return;
  assert.equal(result.data.beforeSource, 'before\n\n\n\nafter');
  assert.equal(result.data.afterSource, 'before\n\n\n\nnew-1\n\nnew-2\n\n\n\nafter');
  assert.equal(
    applyRevisionPatch(result.data.beforeSource, result.data.patch),
    result.data.afterSource,
  );
});

test('多行 del 的外置 br 属于旧侧，单行 del 的外置 br 属于两侧', () => {
  const result = parseRevisionDiffBody(
    response(
      '<div class="inline-diff page-source">\n\t' +
        'before<br />\n<br />\n' +
        '<del>old-1<br />\nold-2</del><br />\n' +
        '<del>old-3</del><br />\n' +
        'after\n</div>',
      false,
    ),
    target,
  );
  assert.equal(result.status, 'ok');
  if (result.status !== 'ok') return;
  assert.equal(result.data.beforeSource, 'before\n\n\n\nold-1\n\nold-2\n\nold-3\n\nafter');
  assert.equal(result.data.afterSource, 'before\n\n\n\n\n\nafter');
  assert.equal(
    applyRevisionPatch(result.data.beforeSource, result.data.patch),
    result.data.afterSource,
  );
});

test('单行 ins 的外置 br 属于两侧，不会从旧侧吞掉空行', () => {
  const result = parseRevisionDiffBody(
    response(
      '<div class="inline-diff page-source">\n\t' +
        'before<br />\n<br />\n' +
        '<ins>new</ins><br />\n' +
        '<br />\n' +
        'after\n</div>',
      false,
    ),
    target,
  );
  assert.equal(result.status, 'ok');
  if (result.status !== 'ok') return;
  assert.equal(result.data.beforeSource, 'before\n\n\n\n\n\n\n\nafter');
  assert.equal(result.data.afterSource, 'before\n\n\n\nnew\n\n\n\nafter');
  assert.equal(
    applyRevisionPatch(result.data.beforeSource, result.data.patch),
    result.data.afterSource,
  );
});

test('停机反例：同形单行 ins 无法区分新增整行与空行改写', () => {
  /*
   * Wikidot 的公开 renderer 按行输出并由 semipre/nl2br 加 <br>。生产样本
   * 1525146282 -> 1525146346 又证明空行改成 x 时空 <del> 会被省略。因此：
   *
   *   old A = before / after       -- 新增整行 x，尾 br 仅属新侧
   *   old B = before / 空行 / after -- 空行改成 x，尾 br 属两侧
   *   new   = before / x / after
   *
   * 两条历史都可得到同一个 <ins>x</ins><br>。HTML 没有携带行级 op，
   * 逆向解析至多猜中一条；本测试固定这个非单射反例，禁止把抽样通过当覆盖证明。
   */
  const parsed = parseRevisionDiffBody(
    response(
      '<div class="inline-diff page-source">\n\t' +
        'before<br />\n' +
        '<ins>x</ins><br />\n' +
        'after\n</div>',
      false,
    ),
    target,
  );
  const addedLineBefore = parseSourceBody(sourceResponse(['before', 'after']), target);
  const emptyLineBefore = parseSourceBody(sourceResponse(['before', '', 'after']), target);
  const sharedAfter = parseSourceBody(sourceResponse(['before', 'x', 'after']), target);

  assert.equal(parsed.status, 'ok');
  assert.equal(addedLineBefore.status, 'ok');
  assert.equal(emptyLineBefore.status, 'ok');
  assert.equal(sharedAfter.status, 'ok');
  if (
    parsed.status !== 'ok' ||
    addedLineBefore.status !== 'ok' ||
    emptyLineBefore.status !== 'ok' ||
    sharedAfter.status !== 'ok'
  ) return;

  assert.notEqual(addedLineBefore.data.source, emptyLineBefore.data.source);
  assert.equal(parsed.data.afterSource, sharedAfter.data.source);
  assert.equal(parsed.data.beforeSource, emptyLineBefore.data.source);
  assert.notEqual(parsed.data.beforeSource, addedLineBefore.data.source);
});

test('停机反例：同形单行 del 无法区分删除整行与改成空行', () => {
  const parsed = parseRevisionDiffBody(
    response(
      '<div class="inline-diff page-source">\n\t' +
        'before<br />\n' +
        '<del>x</del><br />\n' +
        'after\n</div>',
      false,
    ),
    target,
  );
  const sharedBefore = parseSourceBody(sourceResponse(['before', 'x', 'after']), target);
  const deletedLineAfter = parseSourceBody(sourceResponse(['before', 'after']), target);
  const emptyLineAfter = parseSourceBody(sourceResponse(['before', '', 'after']), target);

  assert.equal(parsed.status, 'ok');
  assert.equal(sharedBefore.status, 'ok');
  assert.equal(deletedLineAfter.status, 'ok');
  assert.equal(emptyLineAfter.status, 'ok');
  if (
    parsed.status !== 'ok' ||
    sharedBefore.status !== 'ok' ||
    deletedLineAfter.status !== 'ok' ||
    emptyLineAfter.status !== 'ok'
  ) return;

  assert.equal(parsed.data.beforeSource, sharedBefore.data.source);
  assert.notEqual(deletedLineAfter.data.source, emptyLineAfter.data.source);
  assert.equal(parsed.data.afterSource, emptyLineAfter.data.source);
  assert.notEqual(parsed.data.afterSource, deletedLineAfter.data.source);
});

test('缺 inline diff 且没有“源码相同”标记时 failed，不解释为空 patch', () => {
  const result = parseRevisionDiffBody(response('<p>revision_error</p>'), target);
  assert.equal(result.status, 'failed');
  if (result.status === 'failed') assert.match(result.error, /既没有.*inline-diff/);
});

test('解析器版本是 inline-v3', () => {
  assert.equal(REVISION_DIFF_PARSER_VERSION, 'inline-v3');
});

for (const regression of [
  {
    pageId: 23_676,
    wikidotId: 1_437_499_623,
    fromRevisionId: 1_497_968_220,
    toRevisionId: 1_497_968_268,
  },
  {
    pageId: 27_409,
    wikidotId: 822_940_057,
    fromRevisionId: 870_091_898,
    toRevisionId: 870_095_552,
  },
  {
    pageId: 23_900,
    wikidotId: 1_457_045_370,
    fromRevisionId: 1_525_146_282,
    toRevisionId: 1_525_146_346,
  },
] satisfies RevisionDiffTarget[]) {
  test(`真实回归 ${regression.toRevisionId}：diff 两侧与 PageSource 逐字节一致`, () => {
    const root = path.join(
      here,
      '..',
      'docs',
      `revision-diff-${regression.pageId}-${regression.toRevisionId}`,
    );
    const body = readFileSync(path.join(root, 'diff.raw.html'), 'utf8');
    const before = readFileSync(
      path.join(root, `source-${regression.fromRevisionId}.txt`),
      'utf8',
    );
    const after = readFileSync(
      path.join(root, `source-${regression.toRevisionId}.txt`),
      'utf8',
    );
    const result = parseRevisionDiffBody(body, regression);
    assert.equal(result.status, 'ok');
    if (result.status !== 'ok') return;
    assert.equal(
      Buffer.from(result.data.beforeSource ?? '', 'utf8').equals(
        Buffer.from(before, 'utf8'),
      ),
      true,
    );
    assert.equal(
      Buffer.from(result.data.afterSource ?? '', 'utf8').equals(
        Buffer.from(after, 'utf8'),
      ),
      true,
    );
    assert.equal(applyRevisionPatch(before, result.data.patch), after);
    assert.equal(applyRevisionPatch(after, result.data.patch, 'backward'), before);
  });
}

test('PageDiffModule 参数名固定为 from_revision_id/to_revision_id', () => {
  assert.deepEqual(revisionDiffRequestParams(target), {
    page_id: 7007,
    from_revision_id: 101,
    to_revision_id: 102,
  });
});

test('patch 拒绝错误基线，不能静默把错链继续向后传播', () => {
  assert.throws(
    () => applyRevisionPatch('abc', [{ at: 1, delete: 'x', insert: 'z' }]),
    /删除串不匹配/,
  );
});
