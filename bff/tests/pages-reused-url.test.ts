import express from 'express';
import request from 'supertest';
import type { Pool } from 'pg';
import { createCache } from '../src/web/utils/cache';
import { pagesRouter } from '../src/web/routes/pages';

describe('deleted page with a reused URL', () => {
  beforeEach(async () => { await createCache(null).delByPrefix('pages:'); });
  function appFor(deleted: boolean, replacement: boolean, historical = false) {
    const query = jest.fn(async (sql: string) => {
      if (sql.includes('p."wikidotId" AS "pageWikidotId"')) return { rows: [{
        id: 339549, pageId: 100138, wikidotId: 1451202340,
        url: 'https://scp-wiki-cn.wikidot.com/scp-cn-3000',
        isDeleted: deleted, rating: 2024, alternateTitle: '众节点永垂不朽'
      }] };
      if (sql.includes('reused-url')) return { rows: replacement ? [{ wikidotId: 1452014507, title: 'SCP-CN-3000' }] : [] };
      if (sql.includes('pv."isDeleted" = false') && historical) return { rows: [{ pageVersionId: 10, alternateTitle: 'historical', rating: 12 }] };
      return { rows: [] };
    });
    const app = express();
    app.use('/pages', pagesRouter({ query } as unknown as Pool, null));
    return { app, query };
  }

  test.each([false, true])('suppresses mixed subtitle and identifies distinct replacement (historical=%s)', async (historical) => {
    const { app } = appFor(true, true, historical);
    const { body } = await request(app).get('/pages/by-id?wikidotId=1451202340').expect(200);
    expect(body.wikidotId).toBe(1451202340);
    expect(body.isDeleted).toBe(true);
    expect(body.alternateTitle).toBeNull();
    expect(body.urlReusedBy).toEqual({ wikidotId: 1452014507, title: 'SCP-CN-3000' });
    expect(body.rating).toBe(historical ? 12 : 2024);
  });

  test('does not discard historical subtitle without a replacement', async () => {
    const { app } = appFor(true, false);
    const { body } = await request(app).get('/pages/by-id?wikidotId=1451202340').expect(200);
    expect(body.alternateTitle).toBe('众节点永垂不朽');
    expect(body.urlReusedBy).toBeUndefined();
  });

  test('does not resolve replacement for a live page', async () => {
    const { app, query } = appFor(false, true);
    const { body } = await request(app).get('/pages/by-id?wikidotId=1451202340').expect(200);
    expect(body.alternateTitle).toBe('众节点永垂不朽');
    expect(query.mock.calls.some(([sql]) => sql.includes('reused-url'))).toBe(false);
  });
});
