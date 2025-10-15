import express from 'express';
import request from 'supertest';
import type { Pool } from 'pg';
import { usersRouter } from '../src/web/routes/users';

describe('/users pages and counts deletion filter', () => {
  function createApp() {
    const capturedSql: string[] = [];
    const queryMock = jest.fn(async (sql: string, _params?: any[]) => {
      capturedSql.push(sql);
      // pages list: return empty
      if (sql.includes('SELECT * FROM (') && sql.includes('FROM "Attribution" a') && sql.includes('ORDER BY t."createdAt" DESC')) {
        return { rows: [] };
      }
      // page-counts: return zeros
      if (sql.includes('WITH latest_user_pages AS') && sql.toLowerCase().includes('select count(*) as total')) {
        return { rows: [{ total: 0, original: 0, translation: 0, shortStories: 0, anomalousLog: 0, other: 0 }] };
      }
      return { rows: [] };
    });

    const pool: Partial<Pool> = {
      query: queryMock as unknown as Pool['query']
    };

    const app = express();
    app.use('/users', usersRouter(pool as Pool, null));
    return { app, capturedSql };
  }

  test('uses latest page deletion status for /users/:wikidotId/pages', async () => {
    const { app, capturedSql } = createApp();

    await request(app)
      .get('/users/7820392/pages')
      .expect(200);

    const call = capturedSql.find((s) => s.includes('FROM "Attribution" a') && s.includes('ORDER BY t."createdAt" DESC'));
    expect(call).toBeTruthy();
    // should filter by page/latest deletion status, not attributed version validity
    expect(call!).toContain('COALESCE(p."isDeleted", COALESCE(latest."isDeleted", false)) = false');
    expect(call!).not.toContain('AND ($2::boolean = true OR pv."validTo" IS NULL)');
  });

  test('uses latest page deletion status for /users/:wikidotId/page-counts', async () => {
    const { app, capturedSql } = createApp();

    await request(app)
      .get('/users/7820392/page-counts')
      .expect(200);

    const call = capturedSql.find((s) => s.includes('WITH latest_user_pages AS'));
    expect(call).toBeTruthy();
    // ensure final WHERE uses computed is_deleted flag rather than validTo
    expect(call!).toContain('OR COALESCE(is_deleted, false) = false');
    expect(call!).not.toContain('WHERE ($2::boolean = true OR "validTo" IS NULL)');
  });
});

