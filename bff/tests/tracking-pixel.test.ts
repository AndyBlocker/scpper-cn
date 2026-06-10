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
});
