import request from 'supertest';
import { createServer } from '../src/start';
import { __collectionOwnerTesting } from '../src/web/utils/collectionOwner';

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

interface FakeCollection {
  id: number;
  ownerId: number;
  title: string;
  slug: string;
  visibility: 'PUBLIC' | 'PRIVATE';
  description: string | null;
  notes: string | null;
  coverImageUrl: string | null;
  coverImageOffsetX: number;
  coverImageOffsetY: number;
  coverImageScale: number;
  isDefault: boolean;
  publishedAt: string | Date | null;
  createdAt: string;
  updatedAt: string;
  itemCount: number;
}

function installStatefulCollectionDb() {
  let linkedWikidotId: number | null = null;
  let mappingUserId: number | null = null;
  let nextUserId = 700;
  let nextCollectionId = 101;
  const users = new Map<number, { wikidotId: number | null }>([
    [99, { wikidotId: 42 }]
  ]);
  const collections: FakeCollection[] = [{
    id: 90,
    ownerId: 99,
    title: '历史公开收藏',
    slug: 'favorites',
    visibility: 'PUBLIC',
    description: '绑定前已经存在的公开收藏',
    notes: '历史所有者私有备注',
    coverImageUrl: null,
    coverImageOffsetX: 0,
    coverImageOffsetY: 0,
    coverImageScale: 1,
    isDefault: true,
    publishedAt: '2024-01-05T00:00:00.000Z',
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-05T00:00:00.000Z',
    itemCount: 0
  }];

  (global.fetch as jest.Mock).mockImplementation(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      ok: true,
      user: {
        id: 'acc_1',
        email: 'user@example.com',
        displayName: 'User',
        linkedWikidotId,
        lastLoginAt: null
      }
    })
  }));

  queryMock.mockImplementation(async (sqlValue: unknown, values: unknown[] = []) => {
    const sql = String(sqlValue).replace(/\s+/g, ' ').trim();

    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes('pg_advisory_xact_lock')) {
      return { rows: [], rowCount: 1 };
    }
    if (
      sql.includes('FROM "CollectionAccountOwner" cao')
      && sql.includes('JOIN "User" u')
    ) {
      if (mappingUserId == null) return { rows: [], rowCount: 0 };
      return {
        rows: [{
          userId: mappingUserId,
          wikidotId: users.get(mappingUserId)?.wikidotId ?? null
        }],
        rowCount: 1
      };
    }
    if (
      sql.includes('SELECT id FROM "User"')
      && sql.includes('"wikidotId" = $1')
    ) {
      const wikidotId = Number(values[0]);
      const found = [...users.entries()].find(([, user]) => user.wikidotId === wikidotId);
      return {
        rows: found ? [{ id: found[0] }] : [],
        rowCount: found ? 1 : 0
      };
    }
    if (
      sql.includes('INSERT INTO "User"')
      && sql.includes('"displayName", "isGuest"')
    ) {
      const id = nextUserId;
      nextUserId += 1;
      users.set(id, { wikidotId: null });
      return { rows: [{ id }], rowCount: 1 };
    }
    if (
      sql.includes('INSERT INTO "User"')
      && sql.includes('"wikidotId"')
    ) {
      const id = nextUserId;
      nextUserId += 1;
      users.set(id, { wikidotId: Number(values[0]) });
      return { rows: [{ id }], rowCount: 1 };
    }
    if (
      sql.includes('FROM "CollectionAccountOwner"')
      && sql.includes('"userId" = $1')
      && sql.includes('"accountId" <> $2')
    ) {
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes('INSERT INTO "CollectionAccountOwner"')) {
      mappingUserId = Number(values[1]);
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('UPDATE "CollectionAccountOwner"')) {
      expect(mappingUserId).toBe(Number(values[2]));
      mappingUserId = Number(values[0]);
      return { rows: [], rowCount: 1 };
    }
    if (
      sql.includes('SELECT id, slug, "isDefault"')
      && sql.includes('FROM "UserCollection"')
      && sql.includes('FOR UPDATE')
    ) {
      const ownerId = Number(values[0]);
      const rows = collections
        .filter(collection => collection.ownerId === ownerId)
        .map(collection => ({
          id: collection.id,
          slug: collection.slug,
          isDefault: collection.isDefault
        }));
      return { rows, rowCount: rows.length };
    }
    if (
      sql.includes('UPDATE "UserCollection"')
      && sql.includes('SET "ownerId" = $1')
    ) {
      const [targetOwnerId, slug, isDefault, collectionId, sourceOwnerId] = values;
      const collection = collections.find(item => item.id === Number(collectionId));
      expect(collection?.ownerId).toBe(Number(sourceOwnerId));
      if (collection) {
        collection.ownerId = Number(targetOwnerId);
        collection.slug = String(slug);
        collection.isDefault = Boolean(isDefault);
      }
      return { rows: [], rowCount: collection ? 1 : 0 };
    }
    if (
      sql.includes('SELECT COUNT(*)::text AS count')
      && sql.includes('FROM "UserCollection"')
    ) {
      const ownerId = Number(values[0]);
      return {
        rows: [{ count: String(collections.filter(item => item.ownerId === ownerId).length) }],
        rowCount: 1
      };
    }
    if (
      sql.startsWith('SELECT id FROM "UserCollection"')
      && sql.includes('"ownerId" = $1')
      && sql.includes('slug = $2')
    ) {
      const ownerId = Number(values[0]);
      const slug = String(values[1]);
      const excludedId = values.length > 2 ? Number(values[2]) : null;
      const found = collections.find(item => (
        item.ownerId === ownerId
        && item.slug === slug
        && (excludedId == null || item.id !== excludedId)
      ));
      return { rows: found ? [{ id: found.id }] : [], rowCount: found ? 1 : 0 };
    }
    if (sql.includes('FROM information_schema.columns')) {
      return {
        rows: [
          { column_name: 'coverImageOffsetX' },
          { column_name: 'coverImageOffsetY' },
          { column_name: 'coverImageScale' }
        ],
        rowCount: 3
      };
    }
    if (sql.includes('INSERT INTO "UserCollection"')) {
      const supportsTransforms = values.length === 12;
      const id = nextCollectionId;
      nextCollectionId += 1;
      const now = '2024-02-01T00:00:00.000Z';
      const collection: FakeCollection = {
        id,
        ownerId: Number(values[0]),
        title: String(values[1]),
        slug: String(values[2]),
        visibility: String(values[3]) as 'PUBLIC' | 'PRIVATE',
        description: values[4] == null ? null : String(values[4]),
        notes: values[5] == null ? null : String(values[5]),
        coverImageUrl: values[6] == null ? null : String(values[6]),
        coverImageOffsetX: supportsTransforms ? Number(values[7]) : 0,
        coverImageOffsetY: supportsTransforms ? Number(values[8]) : 0,
        coverImageScale: supportsTransforms ? Number(values[9]) : 1,
        isDefault: Boolean(values[supportsTransforms ? 10 : 7]),
        publishedAt: (values[supportsTransforms ? 11 : 8] as Date | null) ?? null,
        createdAt: now,
        updatedAt: now,
        itemCount: 0
      };
      collections.push(collection);
      return { rows: [collection], rowCount: 1 };
    }
    if (
      sql.includes('UPDATE "UserCollection"')
      && sql.includes('"isDefault" = FALSE')
      && sql.includes('id <> $2')
    ) {
      const ownerId = Number(values[0]);
      const keepId = Number(values[1]);
      for (const collection of collections) {
        if (collection.ownerId === ownerId && collection.id !== keepId) {
          collection.isDefault = false;
        }
      }
      return { rows: [], rowCount: 0 };
    }
    if (
      sql.includes('LEFT JOIN LATERAL')
      && sql.includes('LIMIT $2 OFFSET $3')
      && sql.includes('WHERE c."ownerId" = $1')
    ) {
      const ownerId = Number(values[0]);
      const rows = collections
        .filter(collection => collection.ownerId === ownerId)
        .sort((left, right) => Number(right.isDefault) - Number(left.isDefault));
      return { rows, rowCount: rows.length };
    }
    if (
      sql.includes('SELECT COUNT(*)::text AS total')
      && sql.includes('FROM "UserCollection"')
    ) {
      const ownerId = Number(values[0]);
      return {
        rows: [{ total: String(collections.filter(item => item.ownerId === ownerId).length) }],
        rowCount: 1
      };
    }
    if (
      sql.includes('SELECT c.*,')
      && sql.includes('WHERE c.id = $1')
    ) {
      const collection = collections.find(item => item.id === Number(values[0]));
      return {
        rows: collection ? [collection] : [],
        rowCount: collection ? 1 : 0
      };
    }
    if (sql.startsWith('DELETE FROM "UserCollection" WHERE id = $1')) {
      const index = collections.findIndex(item => item.id === Number(values[0]));
      if (index < 0) return { rows: [], rowCount: 0 };
      collections.splice(index, 1);
      return { rows: [], rowCount: 1 };
    }

    throw new Error(`Unexpected collection test SQL: ${sql}`);
  });

  return {
    collections,
    get mappingUserId() {
      return mappingUserId;
    },
    setLinkedWikidotId(value: number | null) {
      linkedWikidotId = value;
    }
  };
}

describe('Collections routes', () => {
  beforeEach(() => {
    queryMock.mockReset();
    global.fetch = jest.fn();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  const mockAuthOk = (linkedWikidotId: number | null = 42) => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        user: {
          id: 'acc_1',
          email: 'user@example.com',
          displayName: 'User',
          linkedWikidotId,
          lastLoginAt: null
        }
      })
    });
  };

  test('owner merge slug conflict policy is deterministic and collision-safe', () => {
    const used = new Set(['favorites', 'favorites-migrated-101']);
    expect(__collectionOwnerTesting.mergedSlug('favorites', 101, used))
      .toBe('favorites-migrated-101-2');
    expect(__collectionOwnerTesting.mergedSlug('reading-list', 102, used))
      .toBe('reading-list');
  });

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
      .mockResolvedValueOnce({ rows: [{ userId: 99, wikidotId: 42 }] }) // stable account owner
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

  test('linked historical owner is claimed without replacing existing collections', async () => {
    mockAuthOk();
    const historical = {
      id: 88,
      ownerId: 99,
      title: '历史收藏',
      slug: 'history',
      visibility: 'PUBLIC',
      description: null,
      notes: '私有历史备注',
      coverImageUrl: null,
      coverImageOffsetX: 0,
      coverImageOffsetY: 0,
      coverImageScale: 1,
      isDefault: false,
      publishedAt: '2024-01-01T00:00:00.000Z',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-02T00:00:00.000Z',
      itemCount: 1
    };
    queryMock
      .mockResolvedValueOnce({ rows: [] }) // no account mapping yet
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // account advisory lock
      .mockResolvedValueOnce({ rows: [] }) // mapping still absent under lock
      .mockResolvedValueOnce({ rows: [{ id: 99 }] }) // canonical Wikidot User
      .mockResolvedValueOnce({ rows: [] }) // canonical owner advisory lock
      .mockResolvedValueOnce({ rows: [] }) // canonical owner is unclaimed
      .mockResolvedValueOnce({ rows: [] }) // insert account -> canonical mapping
      .mockResolvedValueOnce({ rows: [] }) // COMMIT
      .mockResolvedValueOnce({ rows: [historical] })
      .mockResolvedValueOnce({ rows: [{ total: '1' }] });

    const app = await createServer();
    const res = await request(app).get('/collections').expect(200);

    expect(res.body.items).toEqual([
      expect.objectContaining({ id: 88, ownerId: 99, title: '历史收藏' })
    ]);
    const mappingInsert = queryMock.mock.calls.find(([sql]) =>
      String(sql).includes('INSERT INTO "CollectionAccountOwner"')
    );
    expect(mappingInsert?.[1]).toEqual(['acc_1', 99]);
    expect(queryMock.mock.calls.some(([sql]) =>
      String(sql).includes('SET "ownerId" = $1')
    )).toBe(false);
  });

  test('canonical owner claimed by another account never leaks or absorbs private data', async () => {
    mockAuthOk();
    const privateCollection = {
      id: 77,
      ownerId: 700,
      title: '当前账号私有收藏',
      slug: 'private',
      visibility: 'PRIVATE',
      description: null,
      notes: '不能转给其他账号',
      coverImageUrl: null,
      coverImageOffsetX: 0,
      coverImageOffsetY: 0,
      coverImageScale: 1,
      isDefault: false,
      publishedAt: null,
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-02T00:00:00.000Z',
      itemCount: 0
    };
    queryMock
      .mockResolvedValueOnce({ rows: [{ userId: 700, wikidotId: null }] })
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // account lock
      .mockResolvedValueOnce({ rows: [{ userId: 700, wikidotId: null }] })
      .mockResolvedValueOnce({ rows: [{ id: 99 }] }) // canonical Wikidot User
      .mockResolvedValueOnce({ rows: [] }) // owner 99 lock
      .mockResolvedValueOnce({ rows: [] }) // owner 700 lock
      .mockResolvedValueOnce({ rows: [{ accountId: 'another-account' }] })
      .mockResolvedValueOnce({ rows: [] }) // COMMIT
      .mockResolvedValueOnce({ rows: [privateCollection] })
      .mockResolvedValueOnce({ rows: [{ total: '1' }] });

    const app = await createServer();
    const res = await request(app).get('/collections').expect(200);

    expect(res.body.items).toEqual([
      expect.objectContaining({ id: 77, ownerId: 700, notes: '不能转给其他账号' })
    ]);
    expect(queryMock.mock.calls.some(([sql]) =>
      String(sql).includes('SET "ownerId" = $1')
    )).toBe(false);
    expect(queryMock.mock.calls.some(([sql]) =>
      String(sql).includes('UPDATE "CollectionAccountOwner"')
    )).toBe(false);
    const claimSql = String(queryMock.mock.calls.find(([sql]) =>
      String(sql).includes('"accountId" <> $2')
    )?.[0] ?? '');
    expect(claimSql).not.toContain('FOR UPDATE');
  });

  test('PUBLIC create fails closed when the linked canonical owner belongs to another account', async () => {
    mockAuthOk();
    queryMock
      .mockResolvedValueOnce({ rows: [{ userId: 700, wikidotId: null }] })
      .mockResolvedValueOnce({ rows: [] }) // reconciliation BEGIN
      .mockResolvedValueOnce({ rows: [] }) // account lock
      .mockResolvedValueOnce({ rows: [{ userId: 700, wikidotId: null }] })
      .mockResolvedValueOnce({ rows: [{ id: 99 }] }) // canonical Wikidot User
      .mockResolvedValueOnce({ rows: [] }) // owner 99 lock
      .mockResolvedValueOnce({ rows: [] }) // owner 700 lock
      .mockResolvedValueOnce({ rows: [{ accountId: 'another-account' }] })
      .mockResolvedValueOnce({ rows: [] }) // reconciliation COMMIT
      .mockResolvedValueOnce({ rows: [] }) // create BEGIN
      .mockResolvedValueOnce({ rows: [] }) // create account lock
      .mockResolvedValueOnce({ rows: [{ userId: 700, wikidotId: null }] })
      .mockResolvedValueOnce({ rows: [] }); // create ROLLBACK

    const app = await createServer();
    const res = await request(app)
      .post('/collections')
      .set('x-scpper-expected-user-id', 'acc_1')
      .send({ title: '不能伪发布', visibility: 'PUBLIC' })
      .expect(409);

    expect(res.body.error).toBe('collection_owner_conflict');
    expect(queryMock.mock.calls.some(([sql]) =>
      String(sql).includes('INSERT INTO "UserCollection"')
    )).toBe(false);
  });

  test('POST /collections creates a public collection with publishedAt', async () => {
    mockAuthOk();
    queryMock
      .mockResolvedValueOnce({ rows: [{ userId: 99, wikidotId: 42 }] }) // stable account owner
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // account advisory lock
      .mockResolvedValueOnce({ rows: [{ userId: 99, wikidotId: 42 }] }) // locked owner
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
          visibility: 'PUBLIC',
          description: null,
          notes: null,
          coverImageUrl: null,
          coverImageOffsetX: 0,
          coverImageOffsetY: 0,
          coverImageScale: 1,
          isDefault: false,
          publishedAt: '2024-01-01T00:00:00.000Z',
          createdAt: '2024-01-01T00:00:00.000Z',
          updatedAt: '2024-01-01T00:00:00.000Z',
          itemCount: 0
        }]
      })
      .mockResolvedValueOnce({}); // COMMIT

    const app = await createServer();
    const res = await request(app)
      .post('/collections')
      .set('x-scpper-expected-user-id', 'acc_1')
      .send({ title: '新收藏夹', visibility: 'PUBLIC' })
      .expect(201);

    expect(res.body.ok).toBe(true);
    expect(res.body.collection.slug).toBe('xin-shoucangjia');
    expect(res.body.collection.visibility).toBe('PUBLIC');
    const insertCall = queryMock.mock.calls.find(([sql]) =>
      String(sql).includes('INSERT INTO "UserCollection"')
    );
    expect(insertCall?.[1]?.[3]).toBe('PUBLIC');
    expect(insertCall?.[1]?.[11]).toBeInstanceOf(Date);
    expect(queryMock).toHaveBeenCalledTimes(9);
    // Guard and route share one /auth/me lookup for the same request.
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test('POST re-reads the mapping under lock before inserting during a link race', async () => {
    mockAuthOk(null);
    let mappingReads = 0;
    queryMock.mockImplementation(async (sqlValue: unknown, values: unknown[] = []) => {
      const sql = String(sqlValue).replace(/\s+/g, ' ').trim();
      if (sql.includes('FROM "CollectionAccountOwner" cao')) {
        mappingReads += 1;
        return {
          rows: [mappingReads === 1
            ? { userId: 700, wikidotId: null }
            : { userId: 99, wikidotId: 42 }]
        };
      }
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql.includes('pg_advisory_xact_lock')) {
        return { rows: [] };
      }
      if (sql.includes('SELECT COUNT(*)::text AS count')) {
        expect(values[0]).toBe(99);
        return { rows: [{ count: '0' }] };
      }
      if (sql.startsWith('SELECT id FROM "UserCollection"')) {
        expect(values[0]).toBe(99);
        return { rows: [] };
      }
      if (sql.includes('FROM information_schema.columns')) {
        return {
          rows: [
            { column_name: 'coverImageOffsetX' },
            { column_name: 'coverImageOffsetY' },
            { column_name: 'coverImageScale' }
          ]
        };
      }
      if (sql.includes('INSERT INTO "UserCollection"')) {
        expect(values[0]).toBe(99);
        return {
          rows: [{
            id: 3,
            ownerId: 99,
            title: '并发绑定收藏',
            slug: 'collection-3',
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
            updatedAt: '2024-01-01T00:00:00.000Z'
          }]
        };
      }
      throw new Error(`Unexpected race test SQL: ${sql}`);
    });

    const app = await createServer();
    const res = await request(app)
      .post('/collections')
      .set('x-scpper-expected-user-id', 'acc_1')
      .send({ title: '并发绑定收藏' })
      .expect(201);

    expect(res.body.collection.ownerId).toBe(99);
    expect(mappingReads).toBe(2);
  });

  test('POST /collections rejects stale expected user before any database query', async () => {
    mockAuthOk();

    const app = await createServer();
    const res = await request(app)
      .post('/collections')
      .set('x-scpper-expected-user-id', 'acc_2')
      .send({ title: '不应写入' })
      .expect(409);

    expect(res.body).toEqual({
      ok: false,
      code: 'account_mismatch',
      error: '登录账号已切换，请刷新后重试。'
    });
    expect(queryMock).not.toHaveBeenCalled();
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test('POST /collections requires a Wikidot link before creating PUBLIC data', async () => {
    mockAuthOk(null);

    const app = await createServer();
    const res = await request(app)
      .post('/collections')
      .set('x-scpper-expected-user-id', 'acc_1')
      .send({ title: '公开收藏', visibility: 'PUBLIC' })
      .expect(400);

    expect(res.body.error).toBe('require_linked_wikidot');
    expect(queryMock).not.toHaveBeenCalled();
  });

  test('POST /collections keeps old clients compatible when expected user header is absent', async () => {
    mockAuthOk();
    queryMock
      .mockResolvedValueOnce({ rows: [{ userId: 99, wikidotId: 42 }] })
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // account advisory lock
      .mockResolvedValueOnce({ rows: [{ userId: 99, wikidotId: 42 }] }) // locked owner
      .mockResolvedValueOnce({ rows: [{ count: '20' }] })
      .mockResolvedValueOnce({}); // COMMIT

    const app = await createServer();
    const res = await request(app)
      .post('/collections')
      .send({ title: '旧客户端' })
      .expect(400);

    expect(res.body.error).toBe('collection_limit_reached');
    expect(queryMock).toHaveBeenCalledTimes(6);
  });

  test('GET /collections/:id returns detail with items', async () => {
    mockAuthOk();
    queryMock
      .mockResolvedValueOnce({ rows: [{ userId: 99, wikidotId: 42 }] }) // stable account owner
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

  test('private collections survive Wikidot linking and remain manageable alongside history', async () => {
    const database = installStatefulCollectionDb();
    const app = await createServer();

    const created = await request(app)
      .post('/collections')
      .set('x-scpper-expected-user-id', 'acc_1')
      .send({
        title: 'favorites',
        slug: 'favorites',
        visibility: 'PRIVATE',
        notes: '绑定前的私有整理',
        isDefault: true
      })
      .expect(201);
    const createdId = Number(created.body.collection.id);
    const temporaryOwnerId = database.mappingUserId;

    expect(temporaryOwnerId).toBe(700);
    expect(database.collections.find(item => item.id === createdId)?.ownerId).toBe(700);

    database.setLinkedWikidotId(42);
    const afterLink = await request(app).get('/collections').expect(200);

    expect(database.mappingUserId).toBe(99);
    expect(afterLink.body.items.map((item: { id: number }) => item.id)).toEqual(
      expect.arrayContaining([90, createdId])
    );
    expect(afterLink.body.total).toBe(2);

    const migrated = afterLink.body.items.find((item: { id: number }) => item.id === createdId);
    const historical = afterLink.body.items.find((item: { id: number }) => item.id === 90);
    expect(migrated.ownerId).toBe(99);
    expect(migrated.slug).toBe(`favorites-migrated-${createdId}`);
    expect(migrated.isDefault).toBe(false);
    expect(migrated.notes).toBe('绑定前的私有整理');
    expect(historical.title).toBe('历史公开收藏');
    expect(historical.slug).toBe('favorites');
    expect(historical.isDefault).toBe(true);

    database.setLinkedWikidotId(null);
    const afterUnlink = await request(app).get('/collections').expect(200);
    expect(afterUnlink.body.items.map((item: { id: number }) => item.id)).toEqual(
      expect.arrayContaining([90, createdId])
    );

    await request(app)
      .delete(`/collections/${createdId}`)
      .set('x-scpper-expected-user-id', 'acc_1')
      .expect(200);

    expect(database.collections.some(item => item.id === createdId)).toBe(false);
    expect(database.collections.some(item => item.id === 90)).toBe(true);

    const ownerUpdates = queryMock.mock.calls.filter(([sql]) =>
      String(sql).includes('SET "ownerId" = $1')
    );
    expect(ownerUpdates).toHaveLength(1);
    expect(ownerUpdates[0]?.[1]).toEqual([
      99,
      `favorites-migrated-${createdId}`,
      false,
      createdId,
      700
    ]);
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
          notes: '只有自己可见',
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
    expect(res.body.items[0]).not.toHaveProperty('notes');
    const publicListSql = String(queryMock.mock.calls[1]?.[0] ?? '');
    expect(publicListSql).not.toMatch(/\bc\.notes\b/);
  });

  test('GET /collections/public/user/:wikidotId/:slug never exposes private notes', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: 99 }] })
      .mockResolvedValueOnce({
        rows: [{
          id: 7,
          ownerId: 99,
          title: '公开详情',
          slug: 'public-detail',
          visibility: 'PUBLIC',
          description: '给访客看的简介',
          notes: '只有所有者能看的备注',
          coverImageUrl: null,
          coverImageOffsetX: 0,
          coverImageOffsetY: 0,
          coverImageScale: 1,
          isDefault: false,
          publishedAt: '2024-01-05T00:00:00.000Z',
          createdAt: '2024-01-01T00:00:00.000Z',
          updatedAt: '2024-01-05T00:00:00.000Z',
          itemCount: 0
        }]
      })
      .mockResolvedValueOnce({ rows: [] });

    const app = await createServer();
    const res = await request(app)
      .get('/collections/public/user/42/public-detail')
      .expect(200);

    expect(res.body.collection.description).toBe('给访客看的简介');
    expect(res.body.collection).not.toHaveProperty('notes');
    const publicDetailSql = String(queryMock.mock.calls[1]?.[0] ?? '');
    expect(publicDetailSql).not.toMatch(/\bc\.notes\b/);
  });
});
