import request from 'supertest';
import { createServer } from '../src/start';

const queryMock = jest.fn();

jest.mock('pg', () => ({
  Pool: jest.fn().mockImplementation(() => ({
    query: queryMock
  }))
}));

describe('Alerts routes', () => {
  beforeEach(() => {
    queryMock.mockReset();
    global.fetch = jest.fn();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  test('GET /alerts returns 401 when unauthenticated', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ ok: false })
    });

    const app = await createServer();
    await request(app).get('/alerts').expect(401);
    expect(global.fetch).toHaveBeenCalled();
  });

  test('GET /alerts returns alert summary for authenticated user', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        user: {
          id: 'acc_1',
          email: 'user@example.com',
          displayName: 'User',
          linkedWikidotId: 42,
          lastLoginAt: null
        }
      })
    });

    queryMock
      .mockResolvedValueOnce({
        rows: [
          {
            id: 1,
            metric: 'COMMENT_COUNT',
            prevValue: 5,
            newValue: 7,
            diffValue: 2,
            detectedAt: '2024-01-01T00:00:00.000Z',
            acknowledgedAt: null,
            pageId: 101,
            pageWikidotId: 5555,
            pageUrl: 'http://example.com',
            pageTitle: '示例页面',
            pageAlternateTitle: null,
            source: 'AUTO_OWNERSHIP'
          }
        ]
      })
      .mockResolvedValueOnce({ rows: [{ count: 1 }] });

    const app = await createServer();
    const res = await request(app).get('/alerts').expect(200);

    expect(res.body.ok).toBe(true);
    expect(res.body.alerts).toHaveLength(1);
    expect(res.body.unreadCount).toBe(1);
    expect(queryMock).toHaveBeenCalledTimes(2);
  });
});
