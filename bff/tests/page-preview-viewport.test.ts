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
const CACHED_HTML = [
  '<html><head>',
  '<link rel="stylesheet" href="/api/css-proxy?url=interwiki" data-wikidot-theme="1">',
  '</head><body id="html-body">正文</body></html>'
].join('');

describe('page preview viewport', () => {
  beforeEach(() => {
    queryMock.mockReset();
  });

  test('注入视口解锁样式，且排在页面自带样式表之后', async () => {
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

    // 必须在 </head> 之前、且晚于页面自带的样式表，否则拼不过 body{overflow:hidden}
    const themeLink = body.indexOf('data-wikidot-theme');
    const unlock = body.indexOf('scpper-preview-viewport-unlock');
    const headEnd = body.indexOf('</head>');
    expect(themeLink).toBeGreaterThanOrEqual(0);
    expect(unlock).toBeGreaterThan(themeLink);
    expect(unlock).toBeLessThan(headEnd);

    // 原始文档内容保持不变
    expect(body).toContain('<body id="html-body">正文</body>');
  });
});
