import express from 'express';
import request from 'supertest';
import type { Pool } from 'pg';
import { searchRouter } from '../src/web/routes/search';

describe('/search/all URL PGroonga matching', () => {
  function createApp() {
    const queryMock = jest.fn(async (sql: string, _params?: any[]) => {
      if (sql.includes('WITH base AS') && sql.includes('FROM "PageVersion"')) {
        return { rows: [] };
      }
      if (sql.includes('FROM "User" u') && sql.includes('UserStats')) {
        return { rows: [] };
      }
      if (sql.includes('SELECT COUNT(*) AS total') && sql.includes('JOIN "Page" p')) {
        return { rows: [{ total: 0 }] };
      }
      if (sql.includes('SELECT COUNT(*) AS total') && sql.includes('FROM "User" u')) {
        return { rows: [{ total: 0 }] };
      }
      return { rows: [] };
    });

    const pool: Partial<Pool> = {
      query: queryMock as unknown as Pool['query']
    };

    const app = express();
    app.use('/search', searchRouter(pool as Pool, null));
    return { app, queryMock };
  }

  test('always matches URLs via PGroonga regardless of query shape', async () => {
    const { app, queryMock } = createApp();

    await request(app)
      .get('/search/all')
      .query({ query: 'scp' })
      .expect(200);

    const pageCall = queryMock.mock.calls.find((call) => call[0]?.includes('WITH url_hits AS'));
    expect(pageCall).toBeTruthy();
    expect(pageCall?.[0]).toContain('"currentUrl" &@~ pgroonga_query_escape($1)');

    await request(app)
      .get('/search/all')
      .query({ query: 'scp-173' })
      .expect(200);

    const secondCall = queryMock.mock.calls.find((call) => call[0]?.includes('WITH url_hits AS') && call !== pageCall);
    expect(secondCall).toBeTruthy();
    expect(secondCall?.[0]).toContain('"currentUrl" &@~ pgroonga_query_escape($1)');
  });
});
