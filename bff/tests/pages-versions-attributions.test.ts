import express from 'express';
import request from 'supertest';
import type { Pool } from 'pg';
import { pagesRouter } from '../src/web/routes/pages';

describe('/pages versions + version attributions', () => {
  function createApp() {
    const capturedSql: string[] = [];
    const queryMock = jest.fn(async (sql: string, params?: any[]) => {
      capturedSql.push(String(sql));
      // versions list
      if (String(sql).includes('FROM "PageVersion" pv') && String(sql).includes('ORDER BY pv.id DESC') && Array.isArray(params) && params.length === 3) {
        return { rows: [] };
      }
      // version ownership check
      if (String(sql).includes('SELECT 1 FROM "PageVersion" pv') && Array.isArray(params) && params.length === 2) {
        return { rowCount: 1, rows: [{ '?column?': 1 }] } as any;
      }
      // version attributions
      if (String(sql).includes('FROM "Attribution" a') && String(sql).includes('ORDER BY u.id, a.type ASC') && Array.isArray(params) && params.length === 1) {
        return { rows: [] };
      }
      return { rows: [] };
    });

    const pool: Partial<Pool> = {
      query: queryMock as unknown as Pool['query']
    };

    const app = express();
    app.use('/pages', pagesRouter(pool as Pool, null));
    return { app, capturedSql };
  }

  test('versions endpoint selects validFrom, validTo and aggregates attributions', async () => {
    const { app, capturedSql } = createApp();
    await request(app).get('/pages/508551024/versions?limit=5').expect(200);
    const call = capturedSql.find((s) => s.includes('SELECT') && s.includes('FROM "PageVersion" pv') && s.includes('ORDER BY pv.id DESC'));
    expect(call).toBeTruthy();
    expect(call!).toContain('pv."validFrom"');
    expect(call!).toContain('pv."validTo"');
    expect(call!).toContain('FROM "Attribution" a');
  });

  test('versions/:versionId/attributions queries by pageVerId', async () => {
    const { app, capturedSql } = createApp();
    await request(app).get('/pages/508551024/versions/123/attributions').expect(200);
    const call = capturedSql.find((s) => s.includes('FROM "Attribution" a') && s.includes('WHERE a."pageVerId" = $1'));
    expect(call).toBeTruthy();
  });
});
