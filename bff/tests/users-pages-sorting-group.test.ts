import express from 'express';
import request from 'supertest';
import type { Pool } from 'pg';
import { usersRouter } from '../src/web/routes/users';

describe('/users pages sorting and groupKey', () => {
  function createApp() {
    const capturedSql: string[] = [];
    const queryMock = jest.fn(async (sql: string) => {
      capturedSql.push(String(sql));
      return { rows: [] };
    });
    const pool: Partial<Pool> = { query: queryMock as unknown as Pool['query'] };
    const app = express();
    app.use('/users', usersRouter(pool as Pool, null));
    return { app, capturedSql };
  }

  test('orders by rating when sortBy=rating and includes groupKey', async () => {
    const { app, capturedSql } = createApp();
    await request(app).get('/users/7820392/pages?sortBy=rating').expect(200);
    const sql = capturedSql.find(s => s.includes('SELECT * FROM (') && s.includes('ORDER BY'));
    expect(sql).toBeTruthy();
    expect(sql!).toContain('ORDER BY t.rating DESC');
    expect(sql!).toContain('CASE'); // groupKey CASE expression
  });

  test('orders by date when sortBy=date', async () => {
    const { app, capturedSql } = createApp();
    await request(app).get('/users/7820392/pages?sortBy=date&sortDir=asc').expect(200);
    const sql = capturedSql.find(s => s.includes('SELECT * FROM (') && s.includes('ORDER BY'));
    expect(sql).toBeTruthy();
    expect(sql!).toContain('ORDER BY t."createdAt" ASC');
  });
});

