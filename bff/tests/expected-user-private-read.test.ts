import request from 'supertest';
import { createServer } from '../src/start';
import { isExpectedUserPrivateReadPath } from '../src/web/utils/auth';

const queryMock = jest.fn();

jest.mock('pg', () => ({
  Pool: jest.fn().mockImplementation(() => ({
    query: queryMock,
    connect: jest.fn().mockImplementation(() => ({
      query: queryMock,
      release: jest.fn()
    }))
  }))
}));

const accountBResponse = () => ({
  ok: true,
  status: 200,
  json: async () => ({
    ok: true,
    user: {
      id: 'account-b',
      email: 'b@example.com',
      displayName: 'Account B',
      linkedWikidotId: 42,
      lastLoginAt: null
    }
  })
});

describe('Expected user boundary for private reads', () => {
  beforeEach(() => {
    queryMock.mockReset();
    global.fetch = jest.fn().mockResolvedValue(accountBResponse());
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  test.each([
    '/collections',
    '/collections/9',
    '/follows',
    '/alerts',
    '/alerts/preferences',
    '/qq-binding/status',
    '/wikidot-binding/status',
    '/ftml-projects'
  ])('rejects stale account A snapshot before private route side effects: %s', async (path) => {
    const app = await createServer();
    const response = await request(app)
      .get(path)
      .set('cookie', 'session=account-b')
      .set('x-scpper-expected-user-id', 'account-a')
      .expect(409);

    expect(response.body).toEqual({
      ok: false,
      code: 'account_mismatch',
      error: '登录账号已切换，请刷新后重试。'
    });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(queryMock).not.toHaveBeenCalled();
  });

  test('keeps public collections anonymous even when a caller sends a stale header', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    const app = await createServer();

    const response = await request(app)
      .get('/collections/public/user/42')
      .set('x-scpper-expected-user-id', 'account-a')
      .expect(200);

    expect(response.body).toEqual({ ok: true, total: 0, items: [] });
    expect(global.fetch).not.toHaveBeenCalled();
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  test('explicitly exempts /auth/me because it re-resolves the cookie identity', () => {
    expect(isExpectedUserPrivateReadPath('/auth/me')).toBe(false);
    expect(isExpectedUserPrivateReadPath('/collections/public/user/42')).toBe(false);
  });

  test('fails closed before private reads when the cookie identity cannot be verified', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: async () => ({ ok: false })
    });
    const app = await createServer();

    await request(app)
      .get('/collections')
      .set('x-scpper-expected-user-id', 'account-a')
      .expect(409);

    expect(queryMock).not.toHaveBeenCalled();
  });

  test('keeps old clients compatible when a private GET has no expected-user header', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ userId: 99, wikidotId: 42 }] })
      .mockResolvedValueOnce({ rows: [] }) // access BEGIN
      .mockResolvedValueOnce({ rows: [] }) // account advisory lock
      .mockResolvedValueOnce({ rows: [{ userId: 99, wikidotId: 42 }] }) // locked mapping
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total: '0' }] })
      .mockResolvedValueOnce({ rows: [] }); // access COMMIT
    const app = await createServer();

    const response = await request(app)
      .get('/collections')
      .set('cookie', 'session=account-b')
      .expect(200);

    expect(response.body).toEqual({ ok: true, total: 0, items: [] });
    // The cached route identity is revalidated before owner resolution and
    // once more while the account mapping row is locked.
    expect(global.fetch).toHaveBeenCalledTimes(3);
    expect(queryMock).toHaveBeenCalledTimes(7);
  });
});
