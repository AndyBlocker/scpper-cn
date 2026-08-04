/**
 * 采集层三项功能的纯函数单测（README「后续 TODO」#12 / #13 / #14）。
 *
 * 覆盖：
 *   · src/page/identity.ts   —— WIKIREQUEST.info 抽取 + slug→URL 编码 + 身份守卫的判据
 *   · src/http/amc.ts        —— AMC 响应解析（WikiCategoriesModule body → category 映射）
 *   · src/http/egress.ts     —— 出口 IP 形状校验（识破"代理返回 HTML 错误页"）
 *   · src/store/queues.ts    —— 退避阶梯
 *
 * 网络侧与库侧的验证不在这里（那是真的发请求/写库，见交付说明里的实跑记录），
 * 这里只固化**判据本身**：哪些输入必须被接受、哪些必须被拒绝。
 *
 * fixture 说明：identity_*.real.html 的片段是 2026-07-27 实测响应里 WIKIREQUEST 段的
 * 逐字副本（scp-cn-1000 走 _default 分类、component:image-block 带 category 前缀），
 * 只截了那一段 —— 整页 42 KB 的其余部分与本判据无关。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { extractPageIdentity, slugToUrl } from '../src/page/identity.js';
import { parseWikiCategories, parseProbePolicy, amcProbePolicyFor, randomToken7 } from '../src/http/amc.js';
import { isIpLike, proxyInboundPortFromUrl } from '../src/http/egress.js';
import { backoffFrom } from '../src/store/queues.js';

/** 2026-07-27 实测 scp-cn-1000 整页 GET 的 WIKIREQUEST 段（逐字）。 */
const REAL_DEFAULT_CATEGORY = `
WIKIREQUEST.info.domain = "scp-wiki-cn.wikidot.com";
WIKIREQUEST.info.siteId = 530812;
WIKIREQUEST.info.siteUnixName = "scp-wiki-cn";
WIKIREQUEST.info.categoryId = 3342264;
WIKIREQUEST.info.themeId = 1;
WIKIREQUEST.info.requestPageName = "scp-cn-1000";
WIKIREQUEST.info.lang = 'cn';
WIKIREQUEST.info.pageUnixName = "scp-cn-1000";
WIKIREQUEST.info.pageId = 287054594;
WIKIREQUEST.info.lang = "cn";
`;

/** 实测 component:image-block —— pageUnixName **含** category 前缀。 */
const REAL_PREFIXED_CATEGORY = `
WIKIREQUEST.info.categoryId = 4228703;
WIKIREQUEST.info.requestPageName = "component:image-block";
WIKIREQUEST.info.pageUnixName = "component:image-block";
WIKIREQUEST.info.pageId = 21562672;
`;

describe('page/identity: WIKIREQUEST.info 抽取', () => {
  it('抽出 pageId 与白送的 categoryId / siteId / themeId', () => {
    const id = extractPageIdentity(REAL_DEFAULT_CATEGORY);
    assert.ok(id);
    assert.equal(id.wikidotId, 287054594);
    assert.equal(id.categoryId, 3342264);
    assert.equal(id.siteId, 530812);
    assert.equal(id.themeId, 1);
    assert.equal(id.pageUnixName, 'scp-cn-1000');
    assert.equal(id.siteUnixName, 'scp-wiki-cn');
    // lang 在实测响应里出现两次（单引号一次、双引号一次），取第一次即可，两次同值
    assert.equal(id.lang, 'cn');
  });

  it('pageUnixName 含 category 前缀 —— 与 sitemap slug 同口径（身份守卫的前提）', () => {
    const id = extractPageIdentity(REAL_PREFIXED_CATEGORY);
    assert.ok(id);
    assert.equal(id.wikidotId, 21562672);
    assert.equal(id.pageUnixName, 'component:image-block');
  });

  it('抽不到 pageId 时返回 null，绝不返回一个 wikidotId=0 的假身份', () => {
    assert.equal(extractPageIdentity('<html>404 not found</html>'), null);
    // pageId=0 同样不可接受：0 会被 register_page 当成合法 id 铸出一个假身份
    assert.equal(extractPageIdentity('WIKIREQUEST.info.pageId = 0;'), null);
  });
});

describe('page/identity: slug → URL', () => {
  it('category 分隔符 `:` 不做百分号编码（编码后站点会返回别的页面/404）', () => {
    assert.equal(
      slugToUrl('https://scp-wiki-cn.wikidot.com', 'component:image-block'),
      'https://scp-wiki-cn.wikidot.com/component:image-block',
    );
  });

  it('非 ASCII slug 正常编码', () => {
    assert.equal(
      slugToUrl('https://scp-wiki-cn.wikidot.com/', '收容'),
      'https://scp-wiki-cn.wikidot.com/%E6%94%B6%E5%AE%B9',
    );
  });

  it('尾斜杠归一，不产生 // ', () => {
    assert.equal(slugToUrl('https://x.test///', 'a-b'), 'https://x.test/a-b');
  });
});

describe('http/amc: 响应结构断言', () => {
  it('从 WikiCategoriesModule body 解析出 category → id（实测形状）', () => {
    const body =
      '\t<div>\n\t\t<h3>_default</h3>\n\t\t<a id="category-pages-toggler-3342264" href="javascript:;">+ list pages</a>\n\t</div>' +
      '\t<div>\n\t\t<h3>admin</h3>\n\t\t<a id="category-pages-toggler-3342266">+ list pages</a>\n\t</div>';
    const map = parseWikiCategories(body);
    assert.equal(map['_default'], 3342264);
    assert.equal(map['admin'], 3342266);
    assert.equal(Object.keys(map).length, 2);
  });

  it('body 变形 ⇒ 解析出 0 条（探针据此判契约失败，而不是"通过但没数据"）', () => {
    assert.deepEqual(parseWikiCategories('<div>请先登录</div>'), {});
  });

  it('探针策略词表严格', () => {
    assert.equal(parseProbePolicy(undefined, 'skip'), 'skip');
    assert.equal(parseProbePolicy('  ', 'warn'), 'warn');
    assert.equal(parseProbePolicy('REQUIRE', 'skip'), 'require');
    assert.throws(() => parseProbePolicy('yes', 'skip'), /未知探针策略/);
  });

  it('通道默认策略：纯 GET 的通道 skip，走 AMC 的通道 require', () => {
    assert.equal(amcProbePolicyFor('wikidot_sitemap'), 'skip');
    assert.equal(amcProbePolicyFor('wikidot_page_identity'), 'skip');
    assert.equal(amcProbePolicyFor('wikidot_listpages'), 'require');
    assert.equal(amcProbePolicyFor('wikidot_tier2'), 'require');
  });

  it('wikidot_token7 是随机十六进制，不是库写死的 123456', () => {
    const a = randomToken7();
    const b = randomToken7();
    assert.match(a, /^[0-9a-f]{16}$/);
    assert.notEqual(a, b);
    assert.notEqual(a, '123456');
  });
});

describe('http/egress: 出口 IP 形状校验', () => {
  it('接受 IPv4 / IPv6', () => {
    assert.equal(isIpLike('188.253.120.136'), true);
    assert.equal(isIpLike('2407:cdc0:f001:0:103:229:180:21'), true);
  });

  it('拒绝 HTML 错误页与越界八位组（否则会把垃圾当成一个"出口 IP"记进归因表）', () => {
    assert.equal(isIpLike('<html><body>502 Bad Gateway</body></html>'), false);
    assert.equal(isIpLike('999.1.1.1'), false);
    assert.equal(isIpLike(''), false);
    assert.equal(isIpLike('not-an-ip'), false);
  });

  it('mihomo 归因钉住当前代理入口端口，不能混入另一入口的 DIRECT', () => {
    assert.equal(proxyInboundPortFromUrl('http://127.0.0.1:7891'), '7891');
    assert.equal(proxyInboundPortFromUrl('http://127.0.0.1'), '80');
    assert.equal(proxyInboundPortFromUrl(null), null);
  });
});

describe('store/queues: 退避阶梯', () => {
  it('1h → 4h → 24h → 7d，并在 7d 收敛（不无限增长：私有页应低频保留而不是丢弃）', () => {
    const t0 = Date.UTC(2026, 6, 27, 0, 0, 0);
    const h = (iso: string): number => (Date.parse(iso) - t0) / 3_600_000;
    assert.equal(h(backoffFrom(1, t0)), 1);
    assert.equal(h(backoffFrom(2, t0)), 4);
    assert.equal(h(backoffFrom(3, t0)), 24);
    assert.equal(h(backoffFrom(4, t0)), 168);
    assert.equal(h(backoffFrom(99, t0)), 168);
    // attempts=0 也不能算出"立刻重试"
    assert.equal(h(backoffFrom(0, t0)), 1);
  });
});
