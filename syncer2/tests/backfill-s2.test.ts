import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { extractTextFromWikidotSource } from '../src/content/extractText.js';
import {
  buildContentBlobPlan,
  buildOverrideBlobPlan,
  sha256Hex,
} from '../src/backfill/s2-model.js';

describe('S2 content fallback', () => {
  it('源码兜底保留正文与链接显示名，丢掉 CSS/module/include', () => {
    const source = `
[!-- hidden --]
[[module rate]]
[[include component:license-box]]
+ 标题
**粗体**与[[[scp-cn-1000|显示名]]]
||~ 列一 ||~ 列二 ||
|| 值一 || 值二 ||
[[module css]]
.secret { display: block }
[[/module]]
[[div class="body"]]
正文段落
[[/div]]
`;
    const text = extractTextFromWikidotSource(source);
    assert.match(text, /标题/);
    assert.match(text, /粗体.*显示名/);
    assert.match(text, /列一.*列二/);
    assert.match(text, /正文段落/);
    assert.doesNotMatch(text, /module|include|secret|display/);
  });

  it('HTML 只在 source sha 与 v1 快照一致时绑定到该 blob', () => {
    const row = {
      canonical_page_id: 7,
      v1_page_version_id: 9,
      source: '[[div]]正文[[/div]]',
      text_content: null,
      wants_html: true,
    };
    const exact = buildContentBlobPlan(row, {
      pageId: 7,
      source: row.source,
      textContent: '渲染正文',
    });
    assert.equal(exact.basis, 'wikidot_html');
    assert.equal(exact.textContent, '渲染正文');

    const drifted = buildContentBlobPlan(row, {
      pageId: 7,
      source: 'changed',
      textContent: '新正文',
    });
    assert.equal(drifted.basis, 'v1_source_fallback');
    assert.notEqual(drifted.textContent, '新正文');
  });

  it('远端 drift 生成独立的 html blob', () => {
    const plan = buildOverrideBlobPlan({
      pageId: 7,
      source: 'new source',
      textContent: 'new text',
    });
    assert.equal(plan.sha256Hex, sha256Hex('new source'));
    assert.equal(plan.basis, 'wikidot_html');
    assert.equal(plan.v1PageVersionId, null);
  });
});
