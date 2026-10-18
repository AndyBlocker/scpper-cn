import express from 'express';
import request from 'supertest';

// 只验证 HTTP 路由，不读写生产磁盘缓存或访问任何上游服务。
process.env.CSS_PROXY_DISK_CACHE = '0';

const { cssProxyRouter } = require('../src/web/routes/css-proxy');

const AVATAR_URL = 'https://www.wikidot.com/avatar.php?userid=9869350&amp;size=small&amp;timestamp=1773559531';

describe('css-proxy avatars', () => {
  const app = express().use(cssProxyRouter());
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('/* upstream stylesheet */', {
        status: 200,
        headers: { 'Content-Type': 'text/css' },
      }),
    );
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  test.each(['/css-proxy', '/api/css-proxy'])('旧头像 URL 在 %s 跳转到站内头像缓存，无需回源', async (route) => {
    const res = await request(app)
      .get(route)
      .query({ url: AVATAR_URL })
      .set('Accept', 'image/avif,image/webp,image/*,*/*;q=0.8')
      .set('Sec-Fetch-Dest', 'image')
      .expect(302);

    expect(res.headers.location).toBe('/api/avatar/9869350');
    expect(res.headers['cache-control']).toBe('public, max-age=300');
    expect(res.headers.vary).toContain('Accept');
    expect(res.headers.vary).toContain('Sec-Fetch-Dest');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test.each([
    { Accept: 'text/css,*/*;q=0.1' },
    { 'Sec-Fetch-Dest': 'style' },
  ])('样式表请求保持原有处理：%j', async (headers) => {
    const res = await request(app).get('/css-proxy').query({ url: AVATAR_URL }).set(headers).expect(200);

    expect(res.headers.location).toBeUndefined();
    expect(res.headers['content-type']).toContain('text/css');
    expect(res.headers.vary).toContain('Accept');
    expect(res.headers.vary).toContain('Sec-Fetch-Dest');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  test('重复 userid 保持原有代理行为，不选择其中任意一个', async () => {
    const url = 'https://www.wikidot.com/avatar.php?userid=1&amp;userid=2';
    const res = await request(app).get('/css-proxy').query({ url }).expect(200);

    expect(res.headers.location).toBeUndefined();
    expect(fetchSpy).toHaveBeenCalledWith(url, expect.any(Object));
  });

  test('其他资源保持原有代理行为', async () => {
    const url = 'https://scp-wiki-cn.wikidot.com/local--code/theme/1';
    const res = await request(app).get('/css-proxy').query({ url }).expect(200);

    expect(res.headers.location).toBeUndefined();
    expect(fetchSpy).toHaveBeenCalledWith(url, expect.any(Object));
  });

  test('伪装 Wikidot 域名不会扩大代理白名单', async () => {
    await request(app).get('/css-proxy')
      .query({ url: 'https://www.wikidot.com.attacker.net/avatar.php?userid=9869350' })
      .expect(400);

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
