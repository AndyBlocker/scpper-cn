import http from 'node:http';
import request from 'supertest';
import { createServer } from '../src/start';

jest.mock('pg', () => ({
  Pool: jest.fn().mockImplementation(() => ({
    query: jest.fn()
  }))
}));

describe('Expected user proxy forwarding', () => {
  let upstream: http.Server;
  let upstreamBase = '';
  let receivedExpectedUser: string | undefined;
  const previousUserBackend = process.env.USER_BACKEND_BASE_URL;

  beforeAll(async () => {
    upstream = http.createServer((req, res) => {
      receivedExpectedUser = req.headers['x-scpper-expected-user-id'] as string | undefined;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) => {
      upstream.listen(0, '127.0.0.1', resolve);
    });
    const address = upstream.address();
    if (!address || typeof address === 'string') {
      throw new Error('failed to start test upstream');
    }
    upstreamBase = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    if (previousUserBackend === undefined) {
      delete process.env.USER_BACKEND_BASE_URL;
    } else {
      process.env.USER_BACKEND_BASE_URL = previousUserBackend;
    }
    await new Promise<void>((resolve, reject) => {
      upstream.close((error) => error ? reject(error) : resolve());
    });
  });

  test('forwards the expected account header to user-backend mutations', async () => {
    process.env.USER_BACKEND_BASE_URL = upstreamBase;
    const app = await createServer();

    await request(app)
      .patch('/auth/profile')
      .set('x-scpper-expected-user-id', 'acc_frontend_snapshot')
      .send({ displayName: 'New name' })
      .expect(200);

    expect(receivedExpectedUser).toBe('acc_frontend_snapshot');
  });

  test('forwards the expected account header to private user-backend reads', async () => {
    process.env.USER_BACKEND_BASE_URL = upstreamBase;
    const app = await createServer();

    await request(app)
      .get('/gacha/wallet')
      .set('x-scpper-expected-user-id', 'acc_private_read_snapshot')
      .expect(200);

    expect(receivedExpectedUser).toBe('acc_private_read_snapshot');
  });
});
