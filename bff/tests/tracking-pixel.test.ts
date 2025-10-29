import request from 'supertest';
import { createServer } from '../src/start';

const queryMock = jest.fn();

jest.mock('pg', () => ({
  Pool: jest.fn().mockImplementation(() => ({
    query: queryMock
  }))
}));

describe('Tracking pixel endpoint', () => {
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

    const app = await createServer();
    const res = await request(app)
      .get('/tracking/pixel')
      .set('User-Agent', 'jest-agent')
      .set('X-Forwarded-For', '203.0.113.1')
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

    const app = await createServer();
    const target = 'scp-173';
    const res = await request(app)
      .get('/tracking/pixel/by-url')
      .set('User-Agent', 'jest-agent')
      .set('X-Forwarded-For', '203.0.113.3')
      .query({ url: target })
      .expect(200);

    expect(res.headers['x-tracking-counted']).toBe('1');
    const historyCalls = queryMock.mock.calls.find(([sql]) => sql.includes('urlHistory'));
    expect(historyCalls).toBeTruthy();
    const arrParam = historyCalls?.[1]?.[0] as string[] | undefined;
    expect(Array.isArray(arrParam)).toBe(true);
    expect((arrParam || [])).toContain(`http://scp-wiki-cn.wikidot.com/${target}`);
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

    const app = await createServer();
    const res = await request(app)
      .get('/tracking/pixel')
      .set('User-Agent', 'jest-agent')
      .set('X-Forwarded-For', '203.0.113.2')
      .query({ wikidotId: '654321' })
      .expect(200);

    expect(res.headers['x-tracking-counted']).toBe('0');
    expect(dailyInsertCount).toBe(0);
  });

  test('handles missing wikidotId gracefully', async () => {
    const app = await createServer();
    const res = await request(app)
      .get('/tracking/pixel')
      .expect(200);

    expect(res.headers['x-tracking-error']).toBe('missing_wikidot_id');
    expect(queryMock).not.toHaveBeenCalled();
  });

  test('rejects absolute url in by-url endpoint', async () => {
    const app = await createServer();
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

    const app = await createServer();
    const res = await request(app)
      .get('/tracking/pixel/by-username')
      .set('User-Agent', 'jest-agent')
      .set('X-Forwarded-For', '203.0.113.5')
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

    const app = await createServer();
    const res = await request(app)
      .get('/tracking/pixel/by-username')
      .set('User-Agent', 'jest-agent')
      .set('X-Forwarded-For', '203.0.113.6')
      .query({ wikidotId: '4321' })
      .expect(200);

    expect(res.headers['x-tracking-counted']).toBe('0');
  });

  test('handles missing username gracefully', async () => {
    const app = await createServer();
    const res = await request(app)
      .get('/tracking/pixel/by-username')
      .expect(200);

    expect(res.headers['x-tracking-error']).toBe('missing_wikidot_id');
    expect(queryMock).not.toHaveBeenCalled();
  });

  test('returns not found when username is unknown', async () => {
    queryMock.mockImplementation((sql: string) => {
      if (sql.includes('FROM "User"') && sql.includes('"wikidotId"')) {
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });

    const app = await createServer();
    const res = await request(app)
      .get('/tracking/pixel/by-username')
      .query({ wikidotId: '999999' })
      .expect(200);

    expect(res.headers['x-tracking-error']).toBe('user_not_found');
  });
});
