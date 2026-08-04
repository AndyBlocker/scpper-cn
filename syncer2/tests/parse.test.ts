/**
 * sitemap 解析层的结构断言测试（README「后续 TODO」#11 第二组）。
 *
 * 覆盖 src/sitemap/parse.ts + src/sitemap/normalize.ts。核心红线只有一条：
 *
 *   **"解析出 0 条" 与 "解析失败" 必须可区分，且成功路径永不返回空数组。**
 *
 * 为什么这条是全项目最重要的一条：absence（删除推断）拿的就是"这一轮枚举到的 slug 集合"。
 * 如果 WAF 拦截页 / 截断响应 / 空 urlset 任何一种被当成"合法的 0 条"，那么"全站页面
 * 都不在枚举结果里"就会被解释成"全站页面都被删了"。v1 syncer 的 54 万条幻影 removed
 * 正是这个形状。所以本文件里凡是坏输入，断言的都是 **throws**，而不是"返回了空"。
 *
 * fixture 出处：
 *   · sitemap_category_1.real.xml     —— 2026-07-27 实测原始响应逐字节副本
 *                                        （源 experiments/data/smc.t0.xml，该目录 gitignore）
 *   · sitemap_page_1.head.real.xml    —— 实测 sitemap_page_1 的真实条目节选（前 9 条按文档顺序
 *                                        + 2 条带 category 前缀的），加闭合标签
 *   · sitemap_index.reconstructed.xml —— 按实测结构重建（当时未落盘索引响应本体），
 *                                        只保证结构一致，文件内注了这一点
 *   · sitemap_page.edge.synthetic.xml —— 人造边缘形态，测归一化契约
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SitemapParseError,
  classifySitemapUrl,
  decodeXmlEntities,
  normalizeLastmod,
  parseSitemapIndex,
  parseUrlset,
  slugFromLoc,
} from '../src/sitemap/parse.js';
import { normalizeSitemapEntries } from '../src/sitemap/normalize.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixture = (name: string): string => fs.readFileSync(path.join(FIXTURES, name), 'utf-8');

const URL_INDEX = 'https://scp-wiki-cn.wikidot.com/sitemap.xml';
const URL_CAT = 'https://scp-wiki-cn.wikidot.com/sitemap_category_1.xml';
const URL_PAGE = 'https://scp-wiki-cn.wikidot.com/sitemap_page_1.xml';

// ─── 索引 ────────────────────────────────────────────────────────────────────

describe('parseSitemapIndex', () => {
  it('实测结构：14 个子 sitemap = 4 page + 9 thread + 1 category，顺序与分片号都保留', () => {
    const entries = parseSitemapIndex(fixture('sitemap_index.reconstructed.xml'), URL_INDEX);
    assert.equal(entries.length, 14);

    const byKind: Record<string, number> = {};
    for (const e of entries) byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;
    assert.deepEqual(byKind, { page: 4, thread: 9, category: 1 });

    // 顺序保留（fetchSitemapFamily 的 limit=1 依赖"按 index 升序取第一个"）
    assert.deepEqual(
      entries.filter((e) => e.kind === 'page').map((e) => e.index),
      [1, 2, 3, 4],
    );
    assert.equal(entries[0]!.loc, 'http://scp-wiki-cn.wikidot.com/sitemap_page_1.xml');
    assert.equal(entries.at(-1)!.kind, 'category');
    assert.equal(entries.at(-1)!.index, 1);
  });

  it('XML 注释不会被当成条目（fixture 里有大段注释）', () => {
    const xml = fixture('sitemap_index.reconstructed.xml');
    assert.ok(xml.includes('<!--'), 'fixture 应当带注释，否则这条断言没意义');
    assert.equal(parseSitemapIndex(xml, URL_INDEX).length, 14);
  });

  it('把 urlset 喂给索引解析器 → 抛错，而不是解析出 0 条', () => {
    assert.throws(
      () => parseSitemapIndex(fixture('sitemap_category_1.real.xml'), URL_INDEX),
      (err: unknown) => {
        assert.ok(err instanceof SitemapParseError);
        assert.match(err.message, /不是 <sitemapindex>/);
        return true;
      },
    );
  });
});

describe('classifySitemapUrl', () => {
  it('分片号 / 无号 / 不认识 三种形态', () => {
    assert.deepEqual(classifySitemapUrl('http://x/sitemap_page_3.xml'), { kind: 'page', index: 3 });
    assert.deepEqual(classifySitemapUrl('http://x/sitemap_thread_9.xml'), {
      kind: 'thread',
      index: 9,
    });
    assert.deepEqual(classifySitemapUrl('http://x/sitemap_category.xml'), {
      kind: 'category',
      index: null,
    });
    // 不认识的形态归 unknown，**不猜**。fetchSitemapFamily 会因为 targets 为空而抛错，
    // 这正是"索引里出现了没见过的分片命名"应该有的反应。
    assert.deepEqual(classifySitemapUrl('http://x/sitemap.xml'), { kind: 'unknown', index: null });
    assert.deepEqual(classifySitemapUrl('http://x/SITEMAP_PAGE_2.XML'), { kind: 'page', index: 2 });
  });
});

// ─── urlset：真实数据 ────────────────────────────────────────────────────────

describe('parseUrlset（实测原始响应）', () => {
  it('category 族：15 条 = 1 条站点根 + 14 个 forum/c-<id>，全部无 lastmod', () => {
    const entries = parseUrlset(fixture('sitemap_category_1.real.xml'), URL_CAT);
    assert.equal(entries.length, 15);

    // 站点根条目**留在数组里**，slug=null —— 丢弃与否是上层（normalize）的决定，
    // 解析层不许自己吞掉条目，否则 parse_drop_rate 永远是 0。
    assert.equal(entries[0]!.loc, 'http://scp-wiki-cn.wikidot.com/');
    assert.equal(entries[0]!.slug, null);
    assert.equal(entries.filter((e) => e.slug === null).length, 1);

    assert.equal(entries[1]!.slug, 'forum/c-675245'); // 实测 675245 = 单页讨论 category
    assert.ok(entries.slice(1).every((e) => e.slug!.startsWith('forum/c-')));
    // category/thread 族没有 lastmod（实测），必须是 null 而不是 '' 或 epoch 0
    assert.ok(entries.every((e) => e.lastmod === null && e.lastmodRaw === null));
  });

  it('page 族：lastmod 逐秒保留并归一化为 UTC ISO，category 前缀 slug 原样保留', () => {
    const entries = parseUrlset(fixture('sitemap_page_1.head.real.xml'), URL_PAGE);
    assert.equal(entries.length, 11); // 1 条站点根 + 10 条真实页面

    const bySlug = new Map(entries.filter((e) => e.slug).map((e) => [e.slug!, e]));
    assert.equal(bySlug.get('scp-cn-4233')!.lastmodRaw, '2026-07-27T08:05:47+00:00');
    // 秒级精度不许丢：sitemap 的 lastmod 实测 === ListPages %%updated_at%%（5/5 逐秒相等）
    assert.equal(bySlug.get('scp-cn-4233')!.lastmod, '2026-07-27T08:05:47.000Z');
    assert.equal(bySlug.get('scp-4485')!.lastmod, '2023-06-18T11:04:10.000Z');
    // wikidot 原生 fullname 形态（'category:name'）保留，与 ingest.page_slug_history.slug 同口径
    assert.ok(bySlug.has('wanderers:avril'));
    assert.ok(bySlug.has('fragment:scp-cn-2343-1'));
    assert.equal(entries[0]!.slug, null); // 站点根
  });
});

// ─── urlset：边缘形态 ────────────────────────────────────────────────────────

describe('parseUrlset（归一化边缘形态）', () => {
  const entries = parseUrlset(fixture('sitemap_page.edge.synthetic.xml'), URL_PAGE);
  const slugs = entries.map((e) => e.slug);

  it('协议 / 尾斜杠 / 大小写 都被归一化，站点根 → null', () => {
    assert.equal(entries.length, 14);
    assert.equal(slugs[0], null); // http://site/
    assert.equal(slugs[1], 'scp-cn-1000'); // http://
    assert.equal(slugs[2], 'scp-cn-1000'); // https:// —— 与 http 等价，同一个 slug
    assert.equal(slugs[3], 'scp-cn-1001'); // 尾斜杠剥掉
    assert.equal(slugs[4], 'scp-cn-1002'); // 大写归一化为小写
    assert.equal(slugs[5], 'wanderers:some-page');
  });

  it('百分号编码解码；非法编码退回原样而不是丢条目', () => {
    assert.equal(slugs[6], '测试');
    assert.equal(slugs[7], 'bad-%zz-escape');
  });

  it('XML 实体解码；奇怪标记（属性 + 大小写混写）仍能取到 loc/lastmod', () => {
    assert.equal(slugs[8], 'a&b');
    const weird = entries.find((e) => e.slug === 'weird-markup');
    assert.ok(weird, '<LOC xml:lang="zh"> 形态必须能被取到');
    assert.equal(weird.lastmod, '2026-07-22T02:00:00.000Z');
  });

  it('无 lastmod / 垃圾 lastmod / 非 UTC 偏移 三种时间形态', () => {
    const byslug = new Map(entries.filter((e) => e.slug).map((e) => [e.slug!, e]));
    // 无 lastmod：条目保留，lastmod=null（上层单独统计 missing_lastmod_rate）
    assert.equal(byslug.get('no-lastmod-page')!.lastmod, null);
    // 垃圾串：normalizeLastmod → null，**条目仍然保留**（丢条目会变成幻影删除）
    assert.equal(byslug.get('garbage-lastmod')!.lastmodRaw, 'not-a-date');
    assert.equal(byslug.get('garbage-lastmod')!.lastmod, null);
    // +08:00 偏移必须换算，不能截断偏移（截断就是 v1 那个 8 小时 bug 的解析层版本）
    assert.equal(byslug.get('offset-lastmod')!.lastmod, '2026-07-27T08:00:00.000Z');
  });

  it('loc/lastmod 内外空白被 trim', () => {
    const ws = entries.find((e) => e.slug === 'whitespace-page');
    assert.ok(ws);
    assert.equal(ws.loc, 'http://scp-wiki-cn.wikidot.com/whitespace-page');
    assert.equal(ws.lastmod, '2026-07-21T02:00:00.000Z');
  });
});

describe('slugFromLoc / normalizeLastmod / decodeXmlEntities 单元', () => {
  it('slugFromLoc：非 URL → null（不抛），站点根 → null（不猜 main）', () => {
    assert.equal(slugFromLoc('not a url'), null);
    assert.equal(slugFromLoc('/relative/path'), null); // 相对 URL：new URL 失败
    assert.equal(slugFromLoc('http://scp-wiki-cn.wikidot.com/'), null);
    assert.equal(slugFromLoc('http://scp-wiki-cn.wikidot.com///a///'), 'a');
    // query / fragment 不进 slug（wikidot canonical 不带，但站点某天加了也不该串味）
    assert.equal(slugFromLoc('http://x/scp-002?a=1#b'), 'scp-002');
  });

  it('normalizeLastmod：null/垃圾 → null；实测格式 → UTC ISO', () => {
    assert.equal(normalizeLastmod(null), null);
    assert.equal(normalizeLastmod('not-a-date'), null);
    assert.equal(normalizeLastmod(''), null);
    assert.equal(normalizeLastmod('2026-07-27T07:24:33+00:00'), '2026-07-27T07:24:33.000Z');
    assert.equal(normalizeLastmod(' 2026-07-27T07:24:33Z '), '2026-07-27T07:24:33.000Z');
  });

  it('decodeXmlEntities：命名 / 十进制 / 十六进制；不认识的实体原样留下', () => {
    assert.equal(decodeXmlEntities('a&amp;b'), 'a&b');
    assert.equal(decodeXmlEntities('&lt;x&gt;&quot;&apos;'), '<x>"\'');
    assert.equal(decodeXmlEntities('&#20013;&#x6587;'), '中文');
    assert.equal(decodeXmlEntities('a&nbsp;b'), 'a&nbsp;b');
  });
});

// ─── 核心红线：空 vs 失败 ────────────────────────────────────────────────────

describe('核心红线：空结果与解析失败必须可区分', () => {
  const WAF_HTML =
    '<!DOCTYPE html><html><head><title>503 Service Unavailable</title></head>' +
    '<body>The service is temporarily unavailable.</body></html>';

  /** 每一项：[名字, 坏输入, 期望错误里能认出病因的正则] */
  const BAD_INPUTS: Array<[string, string, RegExp]> = [
    ['WAF/HTML 错误页', WAF_HTML, /不是 <urlset>/],
    ['完全空响应', '', /不是 <urlset>/],
    ['只有空白', '   \n  ', /不是 <urlset>/],
    ['JSON 错误体', '{"error":"forbidden"}', /不是 <urlset>/],
    [
      '合法但空的 urlset',
      '<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>',
      /解析出 0 条 URL/,
    ],
    [
      '条目缺 loc',
      '<urlset><url><lastmod>2026-07-27T00:00:00+00:00</lastmod></url></urlset>',
      /无 <loc> 的条目/,
    ],
    ['条目 loc 为空串', '<urlset><url><loc>  </loc></url></urlset>', /无 <loc> 的条目/],
    [
      '被截断（无闭合标签）',
      '<urlset><url><loc>http://x/a</loc></url><url><loc>http://x/b',
      /缺少 <\/urlset> 闭合标签/,
    ],
  ];

  for (const [name, input, expected] of BAD_INPUTS) {
    it(`${name} → 抛 SitemapParseError（绝不返回空数组）`, () => {
      let returned: unknown = '(没有返回，抛了)';
      assert.throws(
        () => {
          returned = parseUrlset(input, URL_PAGE);
        },
        (err: unknown) => {
          assert.ok(err instanceof SitemapParseError, `应当是 SitemapParseError，实际 ${err}`);
          assert.match(err.message, expected); // 病因可区分，不是一句笼统"解析失败"
          assert.equal(err.url, URL_PAGE); // 出错的 URL 带在错误里，可归因到具体分片
          return true;
        },
      );
      assert.notDeepEqual(returned, []); // 双保险：不许有"返回 []"这条路
    });
  }

  it('八种坏输入的错误消息互不相同（否则运维只能看到"解析失败"）', () => {
    const messages = new Set<string>();
    for (const [, input] of BAD_INPUTS) {
      try {
        parseUrlset(input, URL_PAGE);
        assert.fail('不该解析成功');
      } catch (err) {
        messages.add((err as Error).message.split('（url=')[0]!);
      }
    }
    // '不是 <urlset>' 那 4 条共用同一句诊断（病因确实相同：根元素不对），
    // 剩下 4 条各有自己的诊断句 → 至少 5 个不同的病因描述。
    assert.ok(messages.size >= 5, `不同病因描述只有 ${messages.size} 种`);
  });

  it('截断守卫：把真实响应砍掉尾巴就必须炸（这是幻影删除的入口）', () => {
    const full = fixture('sitemap_page_1.head.real.xml');
    const ok = parseUrlset(full, URL_PAGE);
    assert.equal(ok.length, 11);

    // 砍掉最后 300 字符 = 少了闭合标签和最后两条。正则解析本来会"成功"返回 9 条，
    // 少掉的 2 条在 absence 推断里就是 2 个幻影删除 —— 所以必须抛。
    const truncated = full.slice(0, full.length - 300);
    assert.ok(truncated.includes('<urlset'), '前缀仍然像个合法 urlset —— 截断的特征就是这样');
    assert.throws(() => parseUrlset(truncated, URL_PAGE), /缺少 <\/urlset> 闭合标签/);

    // 索引侧同理
    const idx = fixture('sitemap_index.reconstructed.xml');
    assert.throws(
      () => parseSitemapIndex(idx.slice(0, idx.length - 100), URL_INDEX),
      /缺少 <\/sitemapindex> 闭合标签/,
    );
  });

  it('成功路径永不返回空数组（对全部好 fixture）', () => {
    for (const [name, url] of [
      ['sitemap_category_1.real.xml', URL_CAT],
      ['sitemap_page_1.head.real.xml', URL_PAGE],
      ['sitemap_page.edge.synthetic.xml', URL_PAGE],
    ] as const) {
      assert.ok(parseUrlset(fixture(name), url).length > 0, name);
    }
    assert.ok(parseSitemapIndex(fixture('sitemap_index.reconstructed.xml'), URL_INDEX).length > 0);
  });
});

// ─── parse_drop_rate ─────────────────────────────────────────────────────────

describe('normalizeSitemapEntries：站点根被计入 parse_drop_rate 而不是静默丢弃', () => {
  it('category 族（实测 15 条）：drop = 1/15，unique = 14，missing_lastmod = 1.0', () => {
    const entries = parseUrlset(fixture('sitemap_category_1.real.xml'), URL_CAT);
    const n = normalizeSitemapEntries(entries);

    assert.equal(n.total, 15);
    assert.equal(n.skippedNoSlug, 1); // ← 站点根。被**计数**了，不是消失了
    assert.equal(n.parseDropRate, 1 / 15);
    assert.equal(n.observed.size, 14);
    assert.equal(n.duplicateSlugs, 0);
    assert.equal(n.dedupeRate, 0);
    // 该族本来就没有 lastmod：14 条有 slug 的全部缺 lastmod
    assert.equal(n.skippedNoLastmod, 14);
    assert.equal(n.missingLastmodRate, 14 / 15);
    // 账要平：总数 = 丢弃 + 唯一 + 重复
    assert.equal(n.skippedNoSlug + n.observed.size + n.duplicateSlugs, n.total);
  });

  it('page 族（实测节选 11 条）：drop = 1/11，10 条全带 lastmod', () => {
    const n = normalizeSitemapEntries(parseUrlset(fixture('sitemap_page_1.head.real.xml'), URL_PAGE));
    assert.equal(n.skippedNoSlug, 1);
    assert.equal(n.parseDropRate, 1 / 11);
    assert.equal(n.skippedNoLastmod, 0);
    assert.equal(n.missingLastmodRate, 0);
    assert.equal(n.observed.size, 10);
    // 实测比例量级：page_1 是 1/10000 = 0.0001。这里是节选，只断言"远小于 1"的量级关系
    assert.ok(n.parseDropRate < 0.1);
  });

  it('去重**不算进** drop_rate（两者是不同的病，混在一起指标就没法报警了）', () => {
    const n = normalizeSitemapEntries(parseUrlset(fixture('sitemap_page.edge.synthetic.xml'), URL_PAGE));
    assert.equal(n.total, 14);
    assert.equal(n.skippedNoSlug, 1); // 只有站点根
    assert.equal(n.parseDropRate, 1 / 14);
    assert.equal(n.duplicateSlugs, 1); // scp-cn-1000 出现两次（http + https）
    assert.equal(n.dedupeRate, 1 / 14);
    assert.equal(n.observed.size, 12);
    assert.equal(n.skippedNoSlug + n.observed.size + n.duplicateSlugs, n.total);
    // 重复 slug 取 lastmod 更新的那条
    assert.equal(n.observed.get('scp-cn-1000'), '2026-07-27T09:00:00.000Z');
  });

  it('loc 格式整体变了（drop_rate 飙到 1.0）能被看见 —— R10 熔断的输入就是这个数', () => {
    // 假想站点改成输出相对 URL：slugFromLoc 全部 null。
    const xml =
      '<urlset>' +
      ['/scp-001', '/scp-002', '/scp-003'].map((p) => `<url><loc>${p}</loc></url>`).join('') +
      '</urlset>';
    const n = normalizeSitemapEntries(parseUrlset(xml, URL_PAGE));
    // 注意：解析层是"成功"的（根对、有条目、每条有 loc），是 drop_rate=1.0 在报警。
    // 两层守卫各管一段：结构断言管"响应不是 sitemap"，drop_rate 管"是 sitemap 但字段变了"。
    assert.equal(n.total, 3);
    assert.equal(n.skippedNoSlug, 3);
    assert.equal(n.parseDropRate, 1);
    assert.equal(n.observed.size, 0);
  });

  it('空输入：rate 一律 0（不是 NaN）—— NaN 进 JSON 会变 null，指标就静音了', () => {
    const n = normalizeSitemapEntries([]);
    assert.equal(n.total, 0);
    assert.equal(n.parseDropRate, 0);
    assert.equal(n.missingLastmodRate, 0);
    assert.equal(n.dedupeRate, 0);
    assert.equal(n.observed.size, 0);
    // 说明：normalize 允许空输入（它是纯函数），"空不许当成合法结果"这道关在
    // parseUrlset 里就已经拦住了 —— 上面 BAD_INPUTS 的 '合法但空的 urlset' 那条。
  });

  it('无 lastmod 的重复条目：先到者胜（NaN 比较语义），且不会把已有值覆盖成空', () => {
    const n = normalizeSitemapEntries([
      { loc: 'http://x/a', slug: 'a', lastmod: '2026-01-01T00:00:00.000Z', lastmodRaw: null },
      { loc: 'http://x/a', slug: 'a', lastmod: null, lastmodRaw: null },
      { loc: 'http://x/b', slug: 'b', lastmod: null, lastmodRaw: null },
      { loc: 'http://x/b', slug: 'b', lastmod: '2026-01-01T00:00:00.000Z', lastmodRaw: null },
    ]);
    assert.equal(n.duplicateSlugs, 2);
    assert.equal(n.observed.get('a'), '2026-01-01T00:00:00.000Z'); // 不被 null 覆盖
    // 已知的、刻意保留的行为：b 先到的是空，后来的有值也不覆盖（NaN 比较恒 false）。
    // 对实测数据无影响（page 族除站点根外 100% 带 lastmod），钉在这里免得将来当成新 bug。
    assert.equal(n.observed.get('b'), '');
  });
});
