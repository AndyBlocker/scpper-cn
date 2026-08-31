import request from 'supertest';

const queryMock = jest.fn();

process.env.SYNCER_DATABASE_URL = 'postgresql://test:test@127.0.0.1:5432/syncer-test';

jest.mock('pg', () => ({
  Pool: jest.fn().mockImplementation(() => ({
    query: queryMock
  }))
}));

// Wikidot 页面自带的 interwiki 主题样式表把 body 设成 overflow:hidden，
// 该规则会传播到 viewport 让预览 iframe 无法滚动，所以出口必须补一层解锁样式。
const PROXY = 'https://mirror.example/api/css-proxy';

const CACHED_HTML = [
  '<!DOCTYPE html><html><head>',
  '<base href="https://scp-wiki-cn.wikidot.com/">',
  `<link rel="stylesheet" href="${PROXY}?url=interwiki" data-wikidot-theme="1">`,
  '<style>',
  '.a{background:url(https://scp-wiki.wdfiles.com/local--files/x/a.png)}',
  '.b{background:url(http://scp-wiki-cn.wdfiles.com/local--files/y/b.jpg)}',
  '.c{background:url(/local--files/z/c.gif)}',
  '.d{background:url(https://i.imgur.com/out.png)}',
  '</style>',
  '</head><body id="html-body">',
  '<div style="background:url(&quot;http://scp-wiki.wdfiles.com/local--files/x/d.png&quot;)">正文</div>',
  '<div style="background:URL(https://scp-wiki.wdfiles.com/local--files/x/e.png)">大写</div>',
  '</body></html>'
].join('');

describe('page preview viewport', () => {
  beforeEach(() => {
    queryMock.mockReset();
  });

  test('注入视口解锁样式，锚在 <head> 开标签之后', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ fullname: 'scp-1449' }] })
      .mockResolvedValueOnce({ rows: [{ full_page_html: CACHED_HTML }] });

    const { createServer } = await import('../src/start');
    const app = await createServer();

    const res = await request(app).get('/pages/21558311/preview').expect(200);
    const body = res.text;

    expect(body).toContain('id="scpper-preview-viewport-unlock"');
    expect(body).toContain('html { overflow: auto !important; }');
    expect(body).toContain('body { overflow: visible !important; }');

    // 锚在 <head> 开标签之后：解锁规则带 !important，不依赖源码顺序，
    // 而放在 <!DOCTYPE> 之前会把文档打进 quirks mode
    const doctype = body.indexOf('<!DOCTYPE html>');
    const unlock = body.indexOf('scpper-preview-viewport-unlock');
    expect(doctype).toBe(0);
    expect(unlock).toBeGreaterThan(body.indexOf('<head>'));
    expect(unlock).toBeLessThan(body.indexOf('</head>'));
  });

  test('内联 CSS 里的图片改走 css-proxy', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ fullname: 'scp-1449' }] })
      .mockResolvedValueOnce({ rows: [{ full_page_html: CACHED_HTML }] });

    const { createServer } = await import('../src/start');
    const app = await createServer();
    const body = (await request(app).get('/pages/21558311/preview').expect(200)).text;

    const enc = (u: string) => encodeURIComponent(u);
    // https / http / 相对路径三种写法都被代理
    expect(body).toContain(`${PROXY}?url=${enc('https://scp-wiki.wdfiles.com/local--files/x/a.png')}`);
    expect(body).toContain(`${PROXY}?url=${enc('http://scp-wiki-cn.wdfiles.com/local--files/y/b.jpg')}`);
    expect(body).toContain(`${PROXY}?url=${enc('https://scp-wiki-cn.wikidot.com/local--files/z/c.gif')}`);
    // 白名单外的域保持直连
    expect(body).toContain('url(https://i.imgur.com/out.png)');

    // style="" 属性里被 HTML 实体包裹的 url() 也要正确改写，且实体要保留
    expect(body).toContain(`&quot;${PROXY}?url=${enc('http://scp-wiki.wdfiles.com/local--files/x/d.png')}&quot;`);

    // CSS 函数名大小写不敏感，URL() 也要改写
    expect(body).toContain(`${PROXY}?url=${enc('https://scp-wiki.wdfiles.com/local--files/x/e.png')}`);

    // 已经是代理链接的不被二次包装
    expect(body).toContain(`${PROXY}?url=interwiki`);
    expect(body).not.toMatch(/css-proxy\?url=[^"'\s)]*css-proxy/i);
  });
});
