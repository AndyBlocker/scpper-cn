import request from 'supertest';
import { createServer } from '../src/start';
const queryMock = jest.fn();

jest.mock('pg', () => ({
  Pool: jest.fn().mockImplementation(() => ({
    query: queryMock
  }))
}));

describe('Pages routes', () => {
  beforeEach(() => {
    queryMock.mockReset();
  });

  test('GET /pages returns list', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [{
        wikidotId: 123,
        url: 'http://scp-wiki-cn.wikidot.com/scp-001',
        title: 'SCP-001',
        rating: 100
      }]
    });
    const app = await createServer();
    const res = await request(app).get('/pages').expect(200);
    expect(res.body[0].wikidotId).toBe(123);
  });

  test('GET /pages/by-url requires url', async () => {
    queryMock.mockResolvedValue({ rows: [] });
    const app = await createServer();
    await request(app).get('/pages/by-url').expect(400);
  });

  test('GET /pages/by-id returns deleted page with fallback data', async () => {
    const deletedRow = {
      pageVersionId: 2048,
      pageId: 99,
      wikidotId: null,
      pageWikidotId: 1460481841,
      isDeleted: true,
      validFrom: '2024-01-02T03:04:05.000Z',
      deletedAt: '2024-01-02T03:04:05.000Z',
      tags: [],
      title: null,
      alternateTitle: null,
      category: null,
      rating: null,
      voteCount: null,
      revisionCount: null,
      commentCount: null,
      attributionCount: null
    } as const;

    const fallbackRow = {
      pageVersionId: 2047,
      rating: 12,
      voteCount: 34,
      revisionCount: 2,
      commentCount: 5,
      attributionCount: 1,
      tags: ['test-tag'],
      title: 'Live title',
      alternateTitle: 'Alt title',
      category: 'scp',
      wikidotId: 1460481841
    } as const;

    queryMock.mockImplementation((sql: string) => {
      if (sql.includes('"PageVersionImage"')) {
        return Promise.resolve({ rows: [] });
      }
      if (sql.includes('FROM "PageVersion" pv') && sql.includes('ORDER BY pv."validTo" IS NULL')) {
        return Promise.resolve({ rows: [deletedRow] });
      }
      if (sql.includes('FROM "PageVersion"') && sql.includes('"isDeleted" = false') && !sql.includes('JOIN')) {
        return Promise.resolve({ rows: [fallbackRow] });
      }
      return Promise.resolve({ rows: [] });
    });

    const app = await createServer();
    const res = await request(app)
      .get('/pages/by-id?wikidotId=1460481841')
      .expect(200);

    expect(res.body.isDeleted).toBe(true);
    expect(res.body.wikidotId).toBe(1460481841);
    expect(res.body.title).toBe('Live title');
    expect(res.body.tags).toEqual(['test-tag']);
    expect(res.body).not.toHaveProperty('pageWikidotId');
  });
});

describe('Tags routes', () => {
  beforeEach(() => {
    queryMock.mockReset();
  });

  test('GET /tags returns aggregated tags sorted by count desc by default', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        {
          tag: 'scp',
          page_count: 12,
          latest_activity: '2024-05-01T00:00:00.000Z',
          oldest_activity: '2010-01-01T00:00:00.000Z'
        }
      ]
    });
    const app = await createServer();
    const res = await request(app).get('/tags').expect(200);

    expect(queryMock).toHaveBeenCalledTimes(1);
    const [sql] = queryMock.mock.calls[0];
    expect(sql).toContain('WITH current_tags AS');
    expect(sql).toContain('JOIN "Page" p ON p.id = pv."pageId"');
    expect(sql).toContain('LEFT JOIN LATERAL');
    expect(sql).toContain('MIN(r."timestamp")');
    expect(sql).toContain('COUNT(*)::int AS page_count');
    expect(sql).toContain('ORDER BY page_count desc');
    expect(res.body.tags[0]).toEqual({
      tag: 'scp',
      pageCount: 12,
      latestActivity: '2024-05-01T00:00:00.000Z',
      oldestActivity: '2010-01-01T00:00:00.000Z'
    });
    expect(res.body.meta.sort).toBe('count');
    expect(res.body.meta.order).toBe('desc');
    expect(res.body.meta.limit).toBeNull();
    expect(res.body.meta.offset).toBeNull();
  });

  test('GET /tags supports alpha sort and pagination', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    const app = await createServer();
    await request(app).get('/tags?sort=alpha&order=asc&limit=5&offset=10').expect(200);

    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toContain('ORDER BY tag asc');
    expect(params).toEqual([5, 10]);
  });

  test('GET /tags rejects unsupported sort option', async () => {
    const app = await createServer();
    await request(app).get('/tags?sort=unknown').expect(400);
    expect(queryMock).not.toHaveBeenCalled();
  });
});
