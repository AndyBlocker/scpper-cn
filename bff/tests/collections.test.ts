import request from 'supertest';
import { createServer } from '../src/start';

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

describe('Collections routes', () => {
  beforeEach(() => {
    queryMock.mockReset();
    global.fetch = jest.fn();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  const mockAuthOk = () => {
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
  };

  test('GET /collections requires auth', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ ok: false })
    });
    const app = await createServer();
    await request(app).get('/collections').expect(401);
  });

  test('GET /collections returns list for owner', async () => {
    mockAuthOk();
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: 99 }] }) // ensureUserByWikidotId
      .mockResolvedValueOnce({
        rows: [{
          id: 1,
          ownerId: 99,
          title: '我的收藏',
          slug: 'my-collection',
          visibility: 'PRIVATE',
          description: null,
          notes: null,
          coverImageUrl: null,
          coverImageOffsetX: 0,
          coverImageOffsetY: 0,
          coverImageScale: 1,
          isDefault: false,
          publishedAt: null,
          createdAt: '2024-01-01T00:00:00.000Z',
          updatedAt: '2024-01-02T00:00:00.000Z',
          itemCount: 2
        }]
      })
      .mockResolvedValueOnce({ rows: [{ total: '1' }] });

    const app = await createServer();
    const res = await request(app).get('/collections').expect(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].title).toBe('我的收藏');
  });

  test('POST /collections creates new collection', async () => {
    mockAuthOk();
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: 99 }] }) // ensureUserByWikidotId
      .mockResolvedValueOnce({ rows: [{ count: '0' }] }) // countCollections
      .mockResolvedValueOnce({ rows: [] }) // ensureUniqueSlug
      .mockResolvedValueOnce({
        rows: [
          { column_name: 'coverImageOffsetX' },
          { column_name: 'coverImageOffsetY' },
          { column_name: 'coverImageScale' }
        ]
      })
      .mockResolvedValueOnce({
        rows: [{
          id: 2,
          ownerId: 99,
          title: '新收藏夹',
          slug: 'xin-shoucangjia',
          visibility: 'PRIVATE',
          description: null,
          notes: null,
          coverImageUrl: null,
          coverImageOffsetX: 0,
          coverImageOffsetY: 0,
          coverImageScale: 1,
          isDefault: false,
          publishedAt: null,
          createdAt: '2024-01-01T00:00:00.000Z',
          updatedAt: '2024-01-01T00:00:00.000Z',
          itemCount: 0
        }]
      });

    const app = await createServer();
    const res = await request(app)
      .post('/collections')
      .send({ title: '新收藏夹' })
      .expect(201);

    expect(res.body.ok).toBe(true);
    expect(res.body.collection.slug).toBe('xin-shoucangjia');
    expect(queryMock).toHaveBeenCalledTimes(5);
  });

  test('GET /collections/:id returns detail with items', async () => {
    mockAuthOk();
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: 99 }] }) // ensureUserByWikidotId
      .mockResolvedValueOnce({
        rows: [{
          id: 5,
          ownerId: 99,
          title: '公开合集',
          slug: 'open',
          visibility: 'PUBLIC',
          description: '精选',
          notes: null,
          coverImageUrl: null,
          coverImageOffsetX: 0,
          coverImageOffsetY: 0,
          coverImageScale: 1,
          isDefault: false,
          publishedAt: '2024-01-03T00:00:00.000Z',
          createdAt: '2024-01-01T00:00:00.000Z',
          updatedAt: '2024-01-04T00:00:00.000Z',
          itemCount: 1
        }]
      })
      .mockResolvedValueOnce({
        rows: [{
          id: 10,
          collectionId: 5,
          pageId: 123,
          annotation: '很棒的页面',
          order: 1,
          pinned: true,
          createdAt: '2024-01-02T00:00:00.000Z',
          updatedAt: '2024-01-02T00:00:00.000Z',
          pageWikidotId: 777,
          pageCurrentUrl: '/scp-777',
          pageSlug: 'scp-777',
          pageTitle: 'SCP-777',
          pageAlternateTitle: null,
          pageRating: 120
        }]
      });

    const app = await createServer();
    const res = await request(app).get('/collections/5').expect(200);
    expect(res.body.collection.title).toBe('公开合集');
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].page.title).toBe('SCP-777');
  });

  test('GET /collections/public/user/:wikidotId returns public list', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: 99 }] }) // resolve user by wikidot id
      .mockResolvedValueOnce({
        rows: [{
          id: 1,
          ownerId: 99,
          title: '公开收藏夹',
          slug: 'public',
          visibility: 'PUBLIC',
          description: null,
          notes: null,
          coverImageUrl: null,
          coverImageOffsetX: 0,
          coverImageOffsetY: 0,
          coverImageScale: 1,
          isDefault: false,
          publishedAt: '2024-01-05T00:00:00.000Z',
          createdAt: '2024-01-01T00:00:00.000Z',
          updatedAt: '2024-01-05T00:00:00.000Z',
          itemCount: 3
        }]
      });

    const app = await createServer();
    const res = await request(app).get('/collections/public/user/42').expect(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.items[0].visibility).toBe('PUBLIC');
  });
});
