/**
 * M3 内容/修订/附件采集测试。
 *
 * 红线集中在三处：
 *   · 合法空结果必须有明确结构，不能与 WAF/HTML 变形共用 `[]` / 空串；
 *   · revisions 的 claimed_total 与 pager 两道断言不可放宽；
 *   · 中文修订标记保留集合，多标记行不能压成单值。
 */

process.env.SYNCER2_LOG_LEVEL = 'error';

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool, PoolClient } from 'pg';

import { HttpClient } from '../src/http/client.js';
import { extractSearchText, extractTextContent } from '../src/content/extractText.js';
import {
  applyCurrentContent,
  parseSourceBody,
  scanCurrentContents,
  scanSources,
  type CurrentContentSnapshot,
} from '../src/collect/source.js';
import { ok } from '../src/collect/result.js';
import {
  REVISION_PERPAGE,
  applyRevisionResult,
  normalizeRevisionTypeSet,
  parseRevisionList,
  revisionRequestParams,
  scanRevisions,
  type RevisionTarget,
} from '../src/collect/revisions.js';
import {
  REVISION_COUNT_OFFSET,
  revisionCountDelta,
  revisionCountsMatch,
  revisionListCountFromClaimed,
} from '../src/collect/revisionCount.js';
import {
  parseFileSize,
  parseFilesBody,
  revisionNeedsFilesScan,
} from '../src/collect/files.js';
import {
  parseWikidotPageId,
  scanPageIds,
} from '../src/collect/pageid.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixture = (name: string): string => fs.readFileSync(path.join(FIXTURES, name), 'utf8');

const REV_HTML = fixture('m3-revisions.reconstructed.html');
const FILE_HTML = fixture('m3-files.reconstructed.html');
const target = (claimedTotal = 2): RevisionTarget => ({
  pageId: 7,
  wikidotId: 7007,
  claimedTotal,
});

describe('source：合法空源码与解析失败可区分', () => {
  it('解码实体、NBSP→空格、只去掉开头一个制表符', () => {
    const result = parseSourceBody(
      '<div class="foo page-source bar">\n\t[[div]]&nbsp;A &amp; B&lt;br&gt;[[/div]]\n</div>',
      { pageId: 7, wikidotId: 7007 },
    );
    assert.equal(result.status, 'ok');
    if (result.status !== 'ok') return;
    assert.equal(result.data.source, '[[div]] A & B<br>[[/div]]');
    assert.equal(result.data.sha256Hex.length, 64);
  });

  it('有 page-source 容器但内容为空 = ok；缺容器 = failed', () => {
    const empty = parseSourceBody('<div class="page-source"></div>', {
      pageId: 7,
      wikidotId: 7007,
    });
    assert.equal(empty.status, 'ok');
    if (empty.status === 'ok') assert.equal(empty.data.source, '');

    const broken = parseSourceBody('<html><title>503</title></html>', {
      pageId: 7,
      wikidotId: 7007,
    });
    assert.equal(broken.status, 'failed');
    if (broken.status === 'failed') assert.match(broken.error, /没有 div\.page-source/);
  });

  it('回归：源码/正文含 NUL 与孤立代理项时，应用路径清洗后写入并在 page_scan 留痕', async () => {
    const captured: {
      scanError?: unknown;
      attrs?: unknown;
    } = {};
    const dbQuery = async (sql: string, params?: readonly unknown[]) => {
      if (sql.includes('meta.record_page_scan')) {
        captured.scanError = params?.[10];
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('ingest.apply_page_meta')) {
        captured.attrs = params?.[1];
        return { rows: [{ result: { source_sha: 'f'.repeat(64) } }], rowCount: 1 };
      }
      if (sql.includes('ingest.apply_page_images')) {
        return { rows: [{ result: { applied: 0 } }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    };
    const client = {
      query: dbQuery,
      release: () => undefined,
    } as unknown as PoolClient;
    const pool = {
      query: dbQuery,
      connect: async () => client,
    } as unknown as Pool;
    const extraction = extractSearchText('<div id="page-content">安全正文</div>');
    assert.equal(extraction.status, 'ok');
    if (extraction.status !== 'ok') return;
    const snapshot: CurrentContentSnapshot = {
      pageId: 7,
      wikidotId: 7007,
      slug: 'nulfix-test',
      source: '源码\u0000尾\uD800',
      textContent: '正文\u0000尾\uDC00',
      textExtraction: extraction.data,
      images: [],
      sha256Hex: '0'.repeat(64),
    };

    const applied = await applyCurrentContent(
      pool,
      { pageId: 7, wikidotId: 7007 },
      ok(snapshot),
      {
        observedAt: '2026-07-30T00:00:00.000Z',
        runId: 1,
      },
    );

    assert.match(String(captured.scanError), /content_text_sanitized/);
    assert.match(String(captured.scanError), /source_nul=1/);
    assert.match(String(captured.scanError), /text_lone_surrogate=1/);
    const attrs = JSON.parse(String(captured.attrs)) as Record<string, string>;
    assert.equal(attrs['source_wikitext'], '源码�尾�');
    assert.equal(attrs['text_content'], '正文�尾�');
    assert.doesNotMatch(String(captured.attrs), /\u0000/);
    assert.ok(applied?.['text_sanitization']);
  });
});

describe('revisions：perpage + claimed_total + pager', () => {
  it('零基修订声明统一换算：claimed=N、列表=N+1 才一致', () => {
    assert.equal(REVISION_COUNT_OFFSET, 1);
    assert.equal(revisionListCountFromClaimed(2), 3);
    assert.equal(revisionCountsMatch(2, 3), true);
    assert.equal(revisionCountDelta(2, 3), 0);
    assert.equal(revisionCountsMatch(3, 3), false);
    assert.equal(revisionCountDelta(3, 3), -1);
  });

  it('请求参数把 perpage=99999999 固化为显式契约', () => {
    assert.equal(REVISION_PERPAGE, 99_999_999);
    assert.deepEqual(revisionRequestParams(target()), {
      page_id: 7007,
      perpage: 99_999_999,
      options: '{"all":true}',
    });
  });

  it('真实中文标记按集合解析，多标记行保留两个 type', () => {
    const parsed = parseRevisionList(REV_HTML, target());
    assert.equal(parsed.status, 'ok');
    if (parsed.status !== 'ok') return;
    assert.equal(parsed.data.entries.length, 3);
    assert.deepEqual(parsed.data.entries[1]!.types, ['SOURCE_CHANGED', 'TITLE_CHANGED']);
    assert.deepEqual(
      normalizeRevisionTypeSet(parsed.data.entries[1]!.types),
      ['SOURCE_CHANGED', 'TITLE_CHANGED'],
    );
    assert.deepEqual(parsed.data.entries[1]!.author, {
      kind: 'deleted',
      wikidotId: 10356112,
      displayName: '(account deleted)',
      username: null,
    });
    assert.deepEqual(parsed.data.entries[2]!.types, ['PAGE_CREATED']);
    assert.equal(parsed.data.entries[0]!.occurredAt, '2026-06-09T18:00:02.000Z');
  });

  it('应用载荷把单元素/多元素 type 保持为数组，不再二次 JSON 序列化', async () => {
    let revisionPayload: unknown = null;
    const dbQuery = async (sql: string, params?: readonly unknown[]) => {
      if (sql.includes('ingest.ensure_user')) {
        return { rows: [{ id: 77 }], rowCount: 1 };
      }
      if (sql.includes('ingest.apply_revision_batch')) {
        revisionPayload = params?.[1];
        return { rows: [{ result: { inserted_with_wid: 3 } }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    };
    const client = { query: dbQuery, release: () => undefined } as unknown as PoolClient;
    const pool = {
      query: dbQuery,
      connect: async () => client,
    } as unknown as Pool;
    const parsed = parseRevisionList(REV_HTML, target());
    assert.equal(parsed.status, 'ok');
    if (parsed.status !== 'ok') return;

    await applyRevisionResult(pool, target(), parsed, {
      observedAt: '2026-08-04T00:00:00.000Z',
      runId: null,
    });

    const payload = JSON.parse(String(revisionPayload)) as Array<{ type: unknown }>;
    assert.deepEqual(payload.map((row) => row.type), [
      ['SOURCE_CHANGED'],
      ['SOURCE_CHANGED', 'TITLE_CHANGED'],
      ['PAGE_CREATED'],
    ]);
  });

  it('回归：claimed=N、列表也=N 必须 partial 并告警', () => {
    const parsed = parseRevisionList(REV_HTML, target(3));
    assert.equal(parsed.status, 'partial');
    if (parsed.status !== 'partial') return;
    assert.equal(parsed.data.entries.length, 3);
    assert.match(parsed.error, /解析 3 行.*claimed_total 3.*期望 4 行/);
  });

  it('检测到 class=pager 直接 failed，即使 3 行都能解析', () => {
    const parsed = parseRevisionList(
      `<div class="foo pager bar">page 1 of 2</div>${REV_HTML}`,
      target(),
    );
    assert.equal(parsed.status, 'failed');
    if (parsed.status === 'failed') assert.match(parsed.error, /分页截断/);
  });

  it('空历史表且 claimed=0 仍少 revision 0 = partial；缺 table = failed', () => {
    const empty = parseRevisionList(
      '<table class="page-history"><tbody></tbody></table>',
      target(0),
    );
    assert.equal(empty.status, 'partial');
    if (empty.status === 'partial') {
      assert.deepEqual(empty.data.entries, []);
      assert.match(empty.error, /期望 1 行/);
    }

    const broken = parseRevisionList('<html><title>WAF</title></html>', target(0));
    assert.equal(broken.status, 'failed');
    if (broken.status === 'failed') assert.match(broken.error, /没有 table\.page-history/);
  });

  it('任一行字段变形整页 failed，不静默 continue', () => {
    const malformed =
      '<table class="page-history"><tr id="revision-row-1"><td>0.</td></tr></table>';
    const result = parseRevisionList(malformed, target(1));
    assert.equal(result.status, 'failed');
    if (result.status === 'failed') assert.match(result.error, /只有 1 个 td/);
  });
});

describe('files：真实空结构与解析失败可区分', () => {
  it('正向 fixture 解析 id/name/url/mime/十进制 kB', () => {
    const result = parseFilesBody(FILE_HTML, 'https://scp-wiki-cn.wikidot.com', {
      pageId: 7,
      wikidotId: 1306894711,
    });
    assert.equal(result.status, 'ok');
    if (result.status !== 'ok') return;
    assert.equal(result.data.files.length, 2);
    assert.deepEqual(result.data.files[0], {
      wikidotFileId: 9509066,
      name: '096',
      url: 'https://scp-wiki-cn.wikidot.com/local--files/cole-13-s-art-page/096',
      mimeDescription: 'PNG image data, 1713 x 1245, 8-bit/color RGBA',
      sizeBytes: 697_740,
    });
  });

  it('站点真实“本页没有附件” + page id 回显 = ok 空集合；缺回显 = failed', () => {
    const empty =
      '<h1>附件</h1><p> 本页没有附件 </p>' +
      '<div id="files-page-id" style="display:none">7007</div>';
    const okEmpty = parseFilesBody(empty, 'https://scp-wiki-cn.wikidot.com', {
      pageId: 7,
      wikidotId: 7007,
    });
    assert.equal(okEmpty.status, 'ok');
    if (okEmpty.status === 'ok') assert.deepEqual(okEmpty.data.files, []);

    const broken = parseFilesBody('<h1>附件</h1><p>本页没有附件</p>', 'https://x', {
      pageId: 7,
      wikidotId: 7007,
    });
    assert.equal(broken.status, 'failed');
  });

  it('size 词表严格；附件触发读 revision type 集合', () => {
    assert.equal(parseFileSize('12 Bytes'), 12);
    assert.equal(parseFileSize('1.25 MB'), 1_250_000);
    assert.equal(parseFileSize('???'), null);
    assert.equal(
      revisionNeedsFilesScan({
        wikidotRevisionId: 1,
        revNo: 1,
        types: ['SOURCE_CHANGED', 'FILES_CHANGED'],
        rawMarkers: ['页面源代码已变更', '文件/附件操作'],
        author: null,
        occurredAt: '2026-01-01T00:00:00.000Z',
        comment: '',
      }),
      true,
    );
  });
});

describe('extractText/pageid：空与失败 + 逐页 Map 结果', () => {
  it('空 #page-content 是合法空正文；缺容器/截断容器是 failed', () => {
    const empty = extractSearchText('<html><div id="page-content"></div></html>');
    assert.equal(empty.status, 'ok');
    if (empty.status === 'ok') assert.equal(empty.data.text, '');

    assert.equal(extractSearchText('<html><nav>菜单</nav></html>').status, 'failed');
    assert.equal(extractSearchText('<html><div id="page-content"><p>正文').status, 'failed');
  });

  it('真实逆模因 hub：含 include/module 的源码近空，HTML 渲染正文显著更长', () => {
    const html = fixture('antimemetics-division-hub.real.html');
    const source = fixture('antimemetics-division-hub.real.source.txt');
    assert.match(source, /\[\[(?:include|module)\b/i);
    const rendered = extractTextContent(html);
    assert.equal(rendered.containerFound, true);
    assert.ok(
      rendered.text.length > source.length * 2,
      `rendered=${rendered.text.length}, source=${source.length}`,
    );
    assert.match(rendered.text, /欢迎来到逆模因部/);
  });

  it('pageId 必须有数字和分号，0/缺失都失败', () => {
    assert.equal(parseWikidotPageId('WIKIREQUEST.info.pageId = 12345;'), 12345);
    assert.equal(parseWikidotPageId('WIKIREQUEST.info.pageId=0;'), null);
    assert.equal(parseWikidotPageId('WIKIREQUEST.info.pageId = 12345'), null);
  });
});

interface LocalState {
  base: string;
  forms: URLSearchParams[];
  close(): Promise<void>;
}

async function startLocalServer(): Promise<LocalState> {
  const state: LocalState = {
    base: '',
    forms: [],
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
  const server = http.createServer((req, res) => {
    if (req.url === '/ajax-module-connector.php') {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
        state.forms.push(form);
        const moduleName = form.get('moduleName');
        const pageId = form.get('page_id');
        if (moduleName === 'history/PageRevisionListModule' && pageId === '7007') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok', body: REV_HTML }));
          return;
        }
        if (moduleName === 'viewsource/ViewSourceModule' && pageId === '7007') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok', body: '<div class="page-source"></div>' }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'no_page', body: null }));
      });
      return;
    }
    if (req.url === '/good/norender/true/noredirect/true') {
      res.writeHead(200);
      res.end('<script>WIKIREQUEST.info.pageId = 7007;</script>');
      return;
    }
    if (req.url === '/good') {
      res.writeHead(200);
      res.end(
        '<script>WIKIREQUEST.info.pageId = 7007;</script>' +
          '<div id="page-content"><h1>渲染正文</h1><p>include 展开后的内容</p>' +
          '<img src="/local--files/good/rendered.png"></div>',
      );
      return;
    }
    if (req.url === '/bad/norender/true/noredirect/true') {
      res.writeHead(200);
      res.end('<html>private page</html>');
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  state.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return state;
}

const local = await startLocalServer();
after(async () => {
  await local.close();
});

function client(): HttpClient {
  return new HttpClient({
    userAgent: 'syncer2-m3-test/0.1',
    referer: 'http://127.0.0.1/',
    timeoutMs: 2_000,
    maxAttempts: 1,
    breaker503: 5,
    breakerReset: 5,
    connections: 2,
  });
}

describe('真实 HttpClient + 本地 AMC：失败目标不从 Map 消失', () => {
  it('revisions 请求在线路上确实带 perpage，ok/failed 两页都留在 Map', async () => {
    const httpClient = client();
    try {
      const map = await scanRevisions(
        httpClient,
        local.base,
        [
          { pageId: 7, wikidotId: 7007, claimedTotal: 2 },
          { pageId: 8, wikidotId: 8008, claimedTotal: 2 },
        ],
        2,
      );
      assert.equal(map.size, 2);
      assert.equal(map.get(7)?.status, 'ok');
      assert.equal(map.get(8)?.status, 'failed');
      const revisionForms = local.forms.filter(
        (f) => f.get('moduleName') === 'history/PageRevisionListModule',
      );
      assert.equal(revisionForms.length, 2);
      assert.ok(revisionForms.every((f) => f.get('perpage') === '99999999'));
      assert.ok(revisionForms.every((f) => f.get('options') === '{"all":true}'));
    } finally {
      await httpClient.close();
    }
  });

  it('source 合法空与 no_page 仍分别是 ok/failed Map 行', async () => {
    const httpClient = client();
    try {
      const map = await scanSources(
        httpClient,
        local.base,
        [
          { pageId: 7, wikidotId: 7007 },
          { pageId: 8, wikidotId: 8008 },
        ],
        2,
      );
      assert.equal(map.size, 2);
      assert.equal(map.get(7)?.status, 'ok');
      assert.equal(map.get(8)?.status, 'failed');
    } finally {
      await httpClient.close();
    }
  });

  it('当前内容只发一次整页 GET：同一响应完成 wikidotId 守卫与正文提取', async () => {
    const httpClient = client();
    const formsBefore = local.forms.length;
    try {
      const map = await scanCurrentContents(
        httpClient,
        local.base,
        [{ pageId: 7, wikidotId: 7007, slug: 'good' }],
        1,
      );
      const result = map.get(7);
      assert.equal(result?.status, 'ok');
      if (result?.status === 'ok') {
        assert.equal(result.data.textContent, '渲染正文\n\ninclude 展开后的内容');
        assert.equal(result.data.images.length, 1);
        assert.equal(
          new URL(result.data.images[0]!.normalizedUrl).pathname,
          '/local--files/good/rendered.png',
          '图片必须复用这一份整页响应提取',
        );
      }
      assert.equal(httpClient.stats().requests, 2, '只允许 1 次源码 AMC + 1 次整页 GET');
      const forms = local.forms.slice(formsBefore);
      assert.equal(forms.length, 1);
      assert.equal(forms[0]?.get('moduleName'), 'viewsource/ViewSourceModule');
    } finally {
      await httpClient.close();
    }
  });

  it('pageId 两页逐页独立容错，失败页仍显式留在 Map', async () => {
    const httpClient = client();
    try {
      const map = await scanPageIds(httpClient, local.base, ['good', 'bad'], 2);
      assert.equal(map.size, 2);
      assert.equal(map.get('good')?.status, 'ok');
      assert.equal(map.get('bad')?.status, 'failed');
      const good = map.get('good');
      if (good?.status === 'ok') assert.equal(good.data.wikidotId, 7007);
    } finally {
      await httpClient.close();
    }
  });
});
