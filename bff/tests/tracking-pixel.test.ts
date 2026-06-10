import request from 'supertest';
import express from 'express';
import { trackingRouter, pixelRateLimiter } from '../src/web/routes/tracking';

const queryMock = jest.fn();
// X-Tracking-Counted 只对持有 x-internal-key 的内部请求回显(防刷量 oracle),
// 测试通过设置同一 key 来观察计数语义。
const INTERNAL_KEY = 'test-internal-key';

function createTrackingTestServer() {
  const app = express();
  app.set('trust proxy', 1);
  app.use('/tracking', trackingRouter({ query: queryMock } as any));
  return app;
}

describe('Tracking pixel endpoint', () => {
  beforeAll(() => {
    process.env.BFF_INTERNAL_API_KEY = INTERNAL_KEY;
  });

  afterAll(() => {
    delete process.env.BFF_INTERNAL_API_KEY;
  });

  beforeEach(() => {
    queryMock.mockReset();
  });

  test('counts view when dedupe window missed', async () => {
    queryMock.mockImplementation((sql: string, _params?: unknown[]) => {
      if (sql.includes('FROM "Page" WHERE "wikidotId"')) {
        return Promise.resolve({ rows: [{ id: 42 }] });
      }
      if (sql.includes('FROM "PageViewEvent"') && sql.includes('"clientIp"')) {
        return Promise.resolve({ rows: [] });
      }
      if (sql.includes('INSERT INTO "PageViewEvent"')) {
        return Promise.resolve({ rows: [] });
      }
      if (sql.includes('INSERT INTO "PageDailyStats"')) {
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });

    const app = createTrackingTestServer();
    const res = await request(app)
      .get('/tracking/pixel')
      .set('User-Agent', 'jest-agent')
      .set('X-Forwarded-For', '203.0.113.1')
      .set('X-Internal-Key', INTERNAL_KEY)
      .query({ wikidotId: '123456' })
      .expect(200);

    expect(res.headers['content-type']).toBe('image/gif');
    expect(res.headers['cache-control']).toContain('no-store');
    expect(res.headers['x-tracking-counted']).toBe('1');
    const dailyInserts = queryMock.mock.calls.filter(([sql]: [string]) => sql.includes('INSERT INTO "PageDailyStats"'));
    expect(dailyInserts.length).toBe(1);
  });

  test('counts view via relative url lookup', async () => {
    queryMock.mockImplementation((sql: string, params?: unknown[]) => {
      if (sql.includes('FROM "Page"') && sql.includes('urlHistory')) {
        return Promise.resolve({ rows: [{ id: 84, wikidotId: 999 }] });
      }
      if (sql.includes('FROM "PageViewEvent"') && sql.includes('"clientIp"')) {
        return Promise.resolve({ rows: [] });
      }
      if (sql.includes('INSERT INTO "PageViewEvent"')) {
        return Promise.resolve({ rows: [] });
      }
      if (sql.includes('INSERT INTO "PageDailyStats"')) {
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });

    const app = createTrackingTestServer();
    const target = 'scp-173';
    const res = await request(app)
      .get('/tracking/pixel/by-url')
      .set('User-Agent', 'jest-agent')
      .set('X-Forwarded-For', '203.0.113.3')
      .set('X-Internal-Key', INTERNAL_KEY)
      .query({ url: target })
      .expect(200);

    expect(res.headers['x-tracking-counted']).toBe('1');
    const historyCalls = queryMock.mock.calls.find(([sql]) => sql.includes('urlHistory'));
    expect(historyCalls).toBeTruthy();
    const arrParam = historyCalls?.[1]?.[0] as string[] | undefined;
    expect(Array.isArray(arrParam)).toBe(true);
    expect((arrParam || [])).toContain(`http://scp-wiki-cn.wikidot.com/${target}`);
  });

  test('prefers active current-url page and short-circuits before urlHistory fallback', async () => {
    queryMock.mockImplementation((sql: string) => {
      if (sql.includes('FROM "Page"') && sql.includes('lower("currentUrl") = ANY') && !sql.includes('urlHistory')) {
        return Promise.resolve({ rows: [{ id: 103731, wikidotId: 1468359417 }] });
      }
      if (sql.includes('FROM "PageViewEvent"') && sql.includes('"clientIp"')) {
        return Promise.resolve({ rows: [] });
      }
      if (sql.includes('INSERT INTO "PageViewEvent"')) {
        return Promise.resolve({ rows: [] });
      }
      if (sql.includes('INSERT INTO "PageDailyStats"')) {
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });

    const app = createTrackingTestServer();
    const res = await request(app)
      .get('/tracking/pixel/by-url')
      .set('User-Agent', 'jest-agent')
      .set('X-Forwarded-For', '203.0.113.42')
      .set('X-Internal-Key', INTERNAL_KEY)
      .query({ url: 'scp-cn-4042' })
      .expect(200);

    expect(res.headers['x-tracking-counted']).toBe('1');
    const lookupCall = queryMock.mock.calls.find(
      ([sql]) => sql.includes('FROM "Page"') && sql.includes('lower("currentUrl") = ANY')
    );
    // 第一段只取在档页,已删页留给后续兜底段
    expect(lookupCall?.[0]).toContain('"isDeleted" = false');
    // currentUrl 精确命中后不应再触发 urlHistory 慢路径
    const historyCall = queryMock.mock.calls.find(([sql]) => sql.includes('urlHistory'));
    expect(historyCall).toBeUndefined();

    const insertCall = queryMock.mock.calls.find(([sql]) => sql.includes('INSERT INTO "PageViewEvent"'));
    const insertParams = insertCall?.[1] as unknown[] | undefined;
    expect(insertParams?.[0]).toBe(103731);
    expect(insertParams?.[1]).toBe(1468359417);
  });

  test('skips increment when recently counted', async () => {
    let dailyInsertCount = 0;
    queryMock.mockImplementation((sql: string, _params?: unknown[]) => {
      if (sql.includes('FROM "Page" WHERE "wikidotId"')) {
        return Promise.resolve({ rows: [{ id: 77 }] });
      }
      if (sql.includes('FROM "PageViewEvent"') && sql.includes('"clientIp"')) {
        return Promise.resolve({ rows: [{ exists: 1 }] });
      }
      if (sql.includes('INSERT INTO "PageViewEvent"')) {
        return Promise.resolve({ rows: [] });
      }
      if (sql.includes('INSERT INTO "PageDailyStats"')) {
        dailyInsertCount += 1;
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });

    const app = createTrackingTestServer();
    const res = await request(app)
      .get('/tracking/pixel')
      .set('User-Agent', 'jest-agent')
      .set('X-Forwarded-For', '203.0.113.2')
      .set('X-Internal-Key', INTERNAL_KEY)
      .query({ wikidotId: '654321' })
      .expect(200);

    expect(res.headers['x-tracking-counted']).toBe('0');
    expect(dailyInsertCount).toBe(0);
  });

  test('handles missing wikidotId gracefully', async () => {
    const app = createTrackingTestServer();
    const res = await request(app)
      .get('/tracking/pixel')
      .expect(200);

    expect(res.headers['x-tracking-error']).toBe('missing_wikidot_id');
    expect(queryMock).not.toHaveBeenCalled();
  });

  test('rejects absolute url in by-url endpoint', async () => {
    const app = createTrackingTestServer();
    const res = await request(app)
      .get('/tracking/pixel/by-url')
      .query({ url: 'http://scp-wiki-cn.wikidot.com/scp-173' })
      .expect(200);

    expect(res.headers['x-tracking-error']).toBe('invalid_url');
    expect(queryMock).not.toHaveBeenCalled();
  });

  test('tracks username pixel with counting indicator', async () => {
    queryMock.mockImplementation((sql: string, params?: unknown[]) => {
      if (sql.includes('FROM "User"') && sql.includes('"wikidotId"')) {
        return Promise.resolve({ rows: [{ id: 55, wikidotId: 1234, username: 'TestUser' }] });
      }
      if (sql.includes('FROM "UserPixelEvent"') && sql.includes('"clientIp"')) {
        return Promise.resolve({ rows: [] });
      }
      if (sql.includes('INSERT INTO "UserPixelEvent"')) {
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });

    const app = createTrackingTestServer();
    const res = await request(app)
      .get('/tracking/pixel/by-username')
      .set('User-Agent', 'jest-agent')
      .set('X-Forwarded-For', '203.0.113.5')
      .set('X-Internal-Key', INTERNAL_KEY)
      .query({ wikidotId: '1234', component: 'top-banner' })
      .expect(200);

    expect(res.headers['x-tracking-counted']).toBe('1');
    const insertCalls = queryMock.mock.calls.filter(([sql]: [string]) => sql.includes('INSERT INTO "UserPixelEvent"'));
    expect(insertCalls.length).toBe(1);
    const insertParams = insertCalls[0][1] as unknown[] | undefined;
    expect(insertParams?.[0]).toBe(55);
    expect(insertParams?.[1]).toBe(1234);
    expect(insertParams?.[2]).toBe('TestUser');
    expect(insertParams?.[3]).toBe('203.0.113.5|jest-agent');
    expect(insertParams?.[4]).toBe('203.0.113.5');
    expect(insertParams?.[5]).toBe('jest-agent');
  });

  test('honors dedupe window for username pixel per client fingerprint', async () => {
    queryMock.mockImplementation((sql: string) => {
      if (sql.includes('FROM "User"') && sql.includes('"wikidotId"')) {
        return Promise.resolve({ rows: [{ id: 66, wikidotId: 4321, username: 'AnotherUser' }] });
      }
      if (sql.includes('FROM "UserPixelEvent"') && sql.includes('"clientIp"')) {
        return Promise.resolve({ rows: [{ exists: 1 }] });
      }
      if (sql.includes('INSERT INTO "UserPixelEvent"')) {
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });

    const app = createTrackingTestServer();
    const res = await request(app)
      .get('/tracking/pixel/by-username')
      .set('User-Agent', 'jest-agent')
      .set('X-Forwarded-For', '203.0.113.6')
      .set('X-Internal-Key', INTERNAL_KEY)
      .query({ wikidotId: '4321' })
      .expect(200);

    expect(res.headers['x-tracking-counted']).toBe('0');
  });

  test('handles missing username gracefully', async () => {
    const app = createTrackingTestServer();
    const res = await request(app)
      .get('/tracking/pixel/by-username')
      .expect(200);

    expect(res.headers['x-tracking-error']).toBe('missing_wikidot_id');
    expect(queryMock).not.toHaveBeenCalled();
  });

  test('returns generic not_tracked when username is unknown', async () => {
    queryMock.mockImplementation((sql: string) => {
      if (sql.includes('FROM "User"') && sql.includes('"wikidotId"')) {
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });

    const app = createTrackingTestServer();
    const res = await request(app)
      .get('/tracking/pixel/by-username')
      .query({ wikidotId: '999999' })
      .expect(200);

    // 不区分 not_found 类型,避免无鉴权枚举页面/用户存在性
    expect(res.headers['x-tracking-error']).toBe('not_tracked');
  });

  test('hides counted header for non-internal requests', async () => {
    queryMock.mockImplementation((sql: string) => {
      if (sql.includes('FROM "Page" WHERE "wikidotId"')) {
        return Promise.resolve({ rows: [{ id: 42 }] });
      }
      return Promise.resolve({ rows: [] });
    });

    const app = createTrackingTestServer();
    const res = await request(app)
      .get('/tracking/pixel')
      .set('User-Agent', 'jest-agent')
      .set('X-Forwarded-For', '203.0.113.10')
      .query({ wikidotId: '123456' })
      .expect(200);

    expect(res.headers['content-type']).toBe('image/gif');
    expect(res.headers['x-tracking-counted']).toBeUndefined();
  });

  test('offsite referer records event but does not count views', async () => {
    let dailyInsertCount = 0;
    let dedupeQueryCount = 0;
    queryMock.mockImplementation((sql: string) => {
      if (sql.includes('FROM "Page" WHERE "wikidotId"')) {
        return Promise.resolve({ rows: [{ id: 42 }] });
      }
      if (sql.includes('FROM "PageViewEvent"') && sql.includes('"clientIp"')) {
        dedupeQueryCount += 1;
        return Promise.resolve({ rows: [] });
      }
      if (sql.includes('INSERT INTO "PageDailyStats"')) {
        dailyInsertCount += 1;
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });

    const app = createTrackingTestServer();
    const res = await request(app)
      .get('/tracking/pixel')
      .set('User-Agent', 'jest-agent')
      .set('X-Forwarded-For', '203.0.113.11')
      .set('Referer', 'https://evil.example.com/some-page')
      .set('X-Internal-Key', INTERNAL_KEY)
      .query({ wikidotId: '123456' })
      .expect(200);

    expect(res.headers['x-tracking-counted']).toBe('0');
    expect(dedupeQueryCount).toBe(0);
    expect(dailyInsertCount).toBe(0);
    // 事件行仍记录,便于事后审计灌量来源
    const eventInserts = queryMock.mock.calls.filter(([sql]: [string]) => sql.includes('INSERT INTO "PageViewEvent"'));
    expect(eventInserts.length).toBe(1);
  });

  test('allowlisted referer still counts views', async () => {
    let dailyInsertCount = 0;
    queryMock.mockImplementation((sql: string) => {
      if (sql.includes('FROM "Page" WHERE "wikidotId"')) {
        return Promise.resolve({ rows: [{ id: 42 }] });
      }
      if (sql.includes('FROM "PageViewEvent"') && sql.includes('"clientIp"')) {
        return Promise.resolve({ rows: [] });
      }
      if (sql.includes('INSERT INTO "PageDailyStats"')) {
        dailyInsertCount += 1;
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });

    const app = createTrackingTestServer();
    const res = await request(app)
      .get('/tracking/pixel')
      .set('User-Agent', 'jest-agent')
      .set('X-Forwarded-For', '203.0.113.12')
      .set('Referer', 'https://scp-wiki-cn.wikidot.com/scp-173')
      .set('X-Internal-Key', INTERNAL_KEY)
      .query({ wikidotId: '123456' })
      .expect(200);

    expect(res.headers['x-tracking-counted']).toBe('1');
    expect(dailyInsertCount).toBe(1);
  });

  test('pixel rate limiter answers with GIF when over budget', async () => {
    queryMock.mockResolvedValue({ rows: [] });
    const app = express();
    app.set('trust proxy', 1);
    app.use('/tracking/pixel', pixelRateLimiter({ max: 1, windowMs: 60_000 }));
    app.use('/tracking', trackingRouter({ query: queryMock } as any));

    await request(app)
      .get('/tracking/pixel')
      .set('X-Forwarded-For', '203.0.113.13')
      .query({ wikidotId: '1' })
      .expect(200);

    const res = await request(app)
      .get('/tracking/pixel')
      .set('X-Forwarded-For', '203.0.113.13')
      .query({ wikidotId: '1' })
      .expect(200);

    expect(res.headers['content-type']).toBe('image/gif');
    expect(res.headers['x-tracking-error']).toBe('rate_limited');
  });

  // ── 身份信号采集（image-only，被动请求头） ──

  function pageInsertParams(): unknown[] | undefined {
    const call = queryMock.mock.calls.find(([sql]: [string]) => sql.includes('INSERT INTO "PageViewEvent"'));
    return call?.[1] as unknown[] | undefined;
  }

  function mockPageHappyPath() {
    queryMock.mockImplementation((sql: string) => {
      if (sql.includes('FROM "Page" WHERE "wikidotId"')) return Promise.resolve({ rows: [{ id: 42 }] });
      if (sql.includes('FROM "PageViewEvent"') && sql.includes('"clientIp"')) return Promise.resolve({ rows: [] });
      return Promise.resolve({ rows: [] });
    });
  }

  test('captures Accept-Language / sec-ch-ua / softprint / uaFamily into the event row', async () => {
    mockPageHappyPath();
    const app = createTrackingTestServer();
    await request(app)
      .get('/tracking/pixel')
      .set('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36 Edg/136.0.0.0')
      .set('Accept-Language', 'zh-CN,zh;q=0.9,en-US;q=0.8')
      .set('Sec-CH-UA', '"Chromium";v="136", "Microsoft Edge";v="136", "Not/A)Brand";v="99"')
      .set('Sec-CH-UA-Platform', '"Windows"')
      .set('X-Forwarded-For', '203.0.113.20')
      .query({ wikidotId: '123456' })
      .expect(200);

    const p = pageInsertParams();
    // 顺序: ...refererHost(idx7), acceptLanguage(8), uaPlatform(9), uaBrandMajor(10), uaFamily(11), softprint(12), visitorToken(13), tlsFingerprint(14)
    expect(p?.[8]).toBe('zh-CN,zh;q=0.9,en-US;q=0.8');
    expect(p?.[9]).toBe('Windows');
    expect(p?.[10]).toBe('Microsoft Edge 136'); // GREASE 占位被剔除, 取真实品牌
    expect(p?.[11]).toBe('Edge/Windows');
    // softprint 现为可读复合键(纯数据,不哈希): /24|UA族|品牌|平台|语言
    expect(p?.[12]).toBe('203.0.113.0/24|Edge/Windows|Microsoft Edge 136|Windows|zh-CN,zh;q=0.9,en-US;q=0.8');
    expect(p?.[13]).toBeNull(); // visitorToken 默认关
  });

  test('softprint discriminates same IP+UA but different Accept-Language (kills VPN collision)', async () => {
    const softprints: string[] = [];
    const run = async (lang: string) => {
      queryMock.mockReset();
      mockPageHappyPath();
      const app = createTrackingTestServer();
      await request(app)
        .get('/tracking/pixel')
        .set('User-Agent', 'Mozilla/5.0 (Windows NT 10.0) Chrome/136.0.0.0')
        .set('Accept-Language', lang)
        .set('X-Forwarded-For', '198.51.100.7')
        .query({ wikidotId: '1' })
        .expect(200);
      softprints.push(pageInsertParams()?.[12] as string);
    };
    await run('zh-CN,zh;q=0.9');
    await run('en-US,en;q=0.9');
    await run('zh-CN,zh;q=0.9'); // 与第一次相同输入 → 软指纹应一致
    expect(softprints[0]).not.toBe(softprints[1]); // 同 IP+UA 不同语言 = 不同人
    expect(softprints[0]).toBe(softprints[2]);      // 相同输入 = 确定性一致
  });

  test('softprint folds same /24 across different last octet (de-fragmentation)', async () => {
    const sp: string[] = [];
    for (const ip of ['114.5.1.9', '114.5.1.250']) {
      queryMock.mockReset();
      mockPageHappyPath();
      await request(createTrackingTestServer())
        .get('/tracking/pixel')
        .set('User-Agent', 'Mozilla/5.0 (Windows NT 10.0) Chrome/136.0.0.0')
        .set('Accept-Language', 'zh-CN')
        .set('X-Forwarded-For', ip)
        .query({ wikidotId: '1' })
        .expect(200);
      sp.push(pageInsertParams()?.[12] as string);
    }
    expect(sp[0]).toBe(sp[1]); // 同 /24 不同末位 → 同一软指纹(合并移动 IP 漂移)
    expect(sp[0]).toContain('114.5.1.0/24');
  });

  test('softprint keeps Accept-Language even when sec-ch-ua brand is abusively long', async () => {
    const sp: string[] = [];
    const longBrand = '"' + 'X'.repeat(300) + '";v="9"'; // 构造超长品牌名
    for (const lang of ['zh-CN', 'en-US']) {
      queryMock.mockReset();
      mockPageHappyPath();
      await request(createTrackingTestServer())
        .get('/tracking/pixel')
        .set('User-Agent', 'Mozilla/5.0 (Windows NT 10.0) Chrome/136.0.0.0')
        .set('Accept-Language', lang)
        .set('Sec-CH-UA', longBrand)
        .set('X-Forwarded-For', '198.51.100.9')
        .query({ wikidotId: '1' })
        .expect(200);
      sp.push(pageInsertParams()?.[12] as string);
    }
    // 即便品牌串恶意超长, 末尾语言仍进入键 → 不同语言仍区分(不被截断挤掉)
    expect(sp[0]).not.toBe(sp[1]);
    expect(sp[0].endsWith('|zh-CN')).toBe(true);
  });

  test('captures full raw TLS fingerprint header (not truncated at 256)', async () => {
    mockPageHappyPath();
    // 模拟 openresty 注入的原始 ClientHello 信号(>256 字符,曲线列表在尾部)
    const longFp = 'TLSv1.3|TLS_AES_256_GCM_SHA384|' + Array.from({ length: 30 }, (_, i) => `ECDHE-CIPHER-${i}`).join(':') + '|X25519:secp256r1:secp384r1';
    await request(createTrackingTestServer())
      .get('/tracking/pixel')
      .set('User-Agent', 'Mozilla/5.0 (Windows NT 10.0) Chrome/136.0.0.0')
      .set('X-Forwarded-For', '203.0.113.21')
      .set('X-TLS-Fingerprint', longFp)
      .query({ wikidotId: '1' })
      .expect(200);
    const tls = pageInsertParams()?.[14] as string;
    expect(tls).toBe(longFp);                 // 全量存储,不截断
    expect(tls.length).toBeGreaterThan(256);  // 确认超过旧上限仍完整
    expect(tls).toContain('X25519:secp256r1'); // 尾部曲线列表保留
  });
});

describe('Tracking pixel with ETag visitor token enabled', () => {
  const INTERNAL_KEY = 'test-internal-key';
  let etagRouter: any;
  const tokenQueryMock = jest.fn();

  beforeAll(() => {
    process.env.BFF_INTERNAL_API_KEY = INTERNAL_KEY;
    process.env.TRACKING_VISITOR_TOKEN = 'true';
    jest.isolateModules(() => {
      // 在 env 设好后重新加载模块, 使 VISITOR_TOKEN_ENABLED 读到 true
      etagRouter = require('../src/web/routes/tracking').trackingRouter;
    });
  });
  afterAll(() => {
    delete process.env.BFF_INTERNAL_API_KEY;
    delete process.env.TRACKING_VISITOR_TOKEN;
  });
  beforeEach(() => tokenQueryMock.mockReset());

  function server() {
    const app = express();
    app.set('trust proxy', 1);
    app.use('/tracking', etagRouter({ query: tokenQueryMock } as any));
    return app;
  }
  function mockHappy() {
    tokenQueryMock.mockImplementation((sql: string) => {
      if (sql.includes('FROM "Page" WHERE "wikidotId"')) return Promise.resolve({ rows: [{ id: 42 }] });
      return Promise.resolve({ rows: [] });
    });
  }
  const pveInsert = () => tokenQueryMock.mock.calls.find(([sql]: [string]) => sql.includes('INSERT INTO "PageViewEvent"'));

  test('issues an ETag token and recovers it from If-None-Match', async () => {
    mockHappy();
    const app = server();
    const first = await request(app)
      .get('/tracking/pixel')
      .set('X-Forwarded-For', '203.0.113.30')
      .query({ wikidotId: '1' })
      .expect(200);
    const etag = first.headers['etag'];
    expect(etag).toMatch(/^"[0-9a-f]{32}"$/);
    expect(first.headers['cache-control']).toContain('no-cache');
    const token = etag.replace(/"/g, '');
    expect((pveInsert()?.[1] as unknown[])?.[13]).toBe(token); // 新 token 写入事件行

    tokenQueryMock.mockReset();
    mockHappy();
    // 命中 If-None-Match → Express 自动回 304(省带宽), 但我们的 INSERT/计数在 send 前已执行
    const second = await request(app)
      .get('/tracking/pixel')
      .set('X-Forwarded-For', '203.0.113.30')
      .set('If-None-Match', `"${token}"`)
      .query({ wikidotId: '1' })
      .expect(304);
    expect(second.headers['etag']).toBe(`"${token}"`);          // 恢复同一 token
    expect((pveInsert()?.[1] as unknown[])?.[13]).toBe(token);  // 仍计入事件(不丢计数)
  });

  test('rejects forged non-hex If-None-Match and mints a fresh token', async () => {
    mockHappy();
    const app = server();
    const res = await request(app)
      .get('/tracking/pixel')
      .set('X-Forwarded-For', '203.0.113.31')
      .set('If-None-Match', '"not-a-valid-token"')
      .query({ wikidotId: '1' })
      .expect(200);
    expect(res.headers['etag']).toMatch(/^"[0-9a-f]{32}"$/);
    expect(res.headers['etag']).not.toBe('"not-a-valid-token"');
  });
});
