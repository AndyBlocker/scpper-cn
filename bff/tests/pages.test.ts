import request from 'supertest';
import { createServer } from '../src/start';
import { Pool } from 'pg';

jest.mock('pg', () => {
  const rows = [{ wikidotId: 123, url: 'http://scp-wiki-cn.wikidot.com/scp-001', title: 'SCP-001', rating: 100 }];
  return {
    Pool: jest.fn().mockImplementation(() => ({
      query: jest.fn().mockResolvedValue({ rows })
    }))
  };
});

describe('Pages routes', () => {
  test('GET /pages returns list', async () => {
    const app = await createServer();
    const res = await request(app).get('/pages').expect(200);
    expect(res.body[0].wikidotId).toBe(123);
  });

  test('GET /pages/by-url requires url', async () => {
    const app = await createServer();
    await request(app).get('/pages/by-url').expect(400);
  });
});


