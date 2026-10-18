import express from 'express';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';

// 使用临时 HTTP 头像服务；不读写生产缓存，也不访问 Wikidot。
process.env.CSS_PROXY_DISK_CACHE = '0';
const { cssProxyRouter } = require('../src/web/routes/css-proxy');

const AVATAR_URL = 'https://www.wikidot.com/avatar.php?userid=9869350&amp;size=small&amp;timestamp=1773559531';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0H8AAAAASUVORK5CYII=', 'base64');
const realFetch = globalThis.fetch.bind(globalThis);

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
}

describe('css-proxy avatars', () => {
  let avatarServer: Server;
  let bffServer: Server;
  let gatewayServer: Server;
  let bffOrigin: string;
  let gatewayOrigin: string;
  let avatarRequests: Array<{ url: string | undefined; headers: IncomingHttpHeaders }>;
  let fetchSpy: jest.SpyInstance;
  const previousAvatarBase = process.env.AVATAR_AGENT_BASE_URL;

  beforeAll(async () => {
    avatarRequests = [];
    avatarServer = createServer((req, res) => {
      avatarRequests.push({ url: req.url, headers: req.headers });
      res.writeHead(200, {
        'Content-Type': 'image/png',
        'Cache-Control': 'public, max-age=300',
        'X-Avatar-Source': 'local',
        Vary: 'Accept-Encoding',
      });
      res.end(PNG);
    });
    process.env.AVATAR_AGENT_BASE_URL = await listen(avatarServer);
    bffServer = createServer(express().use(cssProxyRouter()));
    bffOrigin = await listen(bffServer);
    // Nitro sendProxy 同样使用 fetch 默认跟随重定向；模拟其 /api 前缀剥离。
    gatewayServer = createServer(async (req, res) => {
      try {
        const upstream = await realFetch(new URL((req.url || '/').replace(/^\/api/, ''), bffOrigin), {
          headers: { Accept: String(req.headers.accept || '*/*'), 'Sec-Fetch-Dest': String(req.headers['sec-fetch-dest'] || '') },
        });
        res.statusCode = upstream.status;
        upstream.headers.forEach((value, name) => {
          if (!['connection', 'transfer-encoding'].includes(name)) res.setHeader(name, value);
        });
        res.end(Buffer.from(await upstream.arrayBuffer()));
      } catch {
        res.writeHead(500);
        res.end('gateway fetch failed');
      }
    });
    gatewayOrigin = await listen(gatewayServer);
  });

  afterAll(async () => {
    await close(gatewayServer);
    await close(bffServer);
    await close(avatarServer);
    if (previousAvatarBase === undefined) delete process.env.AVATAR_AGENT_BASE_URL;
    else process.env.AVATAR_AGENT_BASE_URL = previousAvatarBase;
  });

  beforeEach(() => {
    avatarRequests.length = 0;
    fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('/* upstream stylesheet */', { status: 200, headers: { 'Content-Type': 'text/css' } }),
    );
  });

  afterEach(() => fetchSpy.mockRestore());

  test.each(['/css-proxy', '/api/css-proxy'])('%s 直接返回头像，不向 Wikidot 回源', async (route) => {
    const res = await request(bffServer).get(route).query({ url: AVATAR_URL })
      .set('Accept', 'image/avif,image/webp,image/*,*/*;q=0.8').set('Sec-Fetch-Dest', 'image')
      .set('Cookie', 'session=private').set('Authorization', 'Bearer private')
      .set('X-Internal-Key', 'private').set('X-SCPPer-Expected-User-Id', 'private').expect(200);

    expect(res.headers.location).toBeUndefined();
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['x-avatar-source']).toBe('local');
    expect(res.body).toEqual(PNG);
    expect(res.headers.vary).toContain('Accept-Encoding');
    expect(res.headers.vary).toContain('Accept');
    expect(res.headers.vary).toContain('Sec-Fetch-Dest');
    expect(avatarRequests).toHaveLength(1);
    expect(avatarRequests[0].url).toBe('/avatar/9869350');
    for (const name of ['cookie', 'authorization', 'x-internal-key', 'x-scpper-expected-user-id']) {
      expect(avatarRequests[0].headers[name]).toBeUndefined();
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('默认跟随重定向的网关链路保留图片与 Vary', async () => {
    const response = await realFetch(`${gatewayOrigin}/api/css-proxy?url=${encodeURIComponent(AVATAR_URL)}`, {
      headers: { Accept: 'image/*', 'Sec-Fetch-Dest': 'image' },
    });

    expect(response.status).toBe(200);
    expect(response.redirected).toBe(false);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('vary')).toContain('Accept-Encoding');
    expect(response.headers.get('vary')).toContain('Accept');
    expect(response.headers.get('vary')).toContain('Sec-Fetch-Dest');
    expect(Buffer.from(await response.arrayBuffer())).toEqual(PNG);
    expect(avatarRequests.map((r) => r.url)).toEqual(['/avatar/9869350']);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('旧相对跳转会在 BFF 内跟随到错误前缀，确实不能用于网关', async () => {
    const oldServer = createServer(express().get('/css-proxy', (_req, res) => {
      res.vary('Accept').vary('Sec-Fetch-Dest').redirect(302, '/api/avatar/9869350');
    }));
    const origin = await listen(oldServer);
    try {
      const response = await realFetch(`${origin}/css-proxy`);
      expect(response.status).toBe(404);
      expect(response.url).toBe(`${origin}/api/avatar/9869350`);
      expect(response.headers.get('vary')).toBeNull();
      await response.arrayBuffer();
    } finally {
      await close(oldServer);
    }
  });

  test.each([{ Accept: 'text/css,*/*;q=0.1' }, { 'Sec-Fetch-Dest': 'style' }])('样式请求仍走原来的 CSS 代理：%j', async (headers) => {
    const res = await request(bffServer).get('/css-proxy').query({ url: AVATAR_URL }).set(headers).expect(200);
    expect(res.headers['content-type']).toContain('text/css');
    expect(res.headers.vary).toContain('Accept');
    expect(res.headers.vary).toContain('Sec-Fetch-Dest');
    expect(avatarRequests).toHaveLength(0);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  test('重复 userid 保持原有代理行为，不选择其中任意一个', async () => {
    const url = 'https://www.wikidot.com/avatar.php?userid=1&amp;userid=2';
    await request(bffServer).get('/css-proxy').query({ url }).expect(200);
    expect(avatarRequests).toHaveLength(0);
    expect(fetchSpy).toHaveBeenCalledWith(url, expect.any(Object));
  });

  test('其他资源保持原有代理行为', async () => {
    const url = 'https://scp-wiki-cn.wikidot.com/local--code/theme/1';
    await request(bffServer).get('/css-proxy').query({ url }).expect(200);
    expect(avatarRequests).toHaveLength(0);
    expect(fetchSpy).toHaveBeenCalledWith(url, expect.any(Object));
  });

  test('伪装 Wikidot 域名既不访问头像服务，也不扩大代理白名单', async () => {
    await request(bffServer).get('/css-proxy')
      .query({ url: 'https://www.wikidot.com.attacker.net/avatar.php?userid=9869350' }).expect(400);
    expect(avatarRequests).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('头像服务不可达时明确返回 502 JSON', async () => {
    const unavailable = createServer();
    const origin = await listen(unavailable);
    await close(unavailable);
    const activeBase = process.env.AVATAR_AGENT_BASE_URL;
    process.env.AVATAR_AGENT_BASE_URL = origin;
    const app = express().use(cssProxyRouter());
    process.env.AVATAR_AGENT_BASE_URL = activeBase;
    const res = await request(app).get('/css-proxy').query({ url: AVATAR_URL }).expect(502);
    expect(res.body).toEqual({ error: 'avatar_proxy_unavailable' });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers.vary).toContain('Sec-Fetch-Dest');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
