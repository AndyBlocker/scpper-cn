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

describe('internal collection owner pre-pin', () => {
  const previousKey = process.env.BFF_INTERNAL_API_KEY;

  beforeEach(() => {
    queryMock.mockReset();
    process.env.BFF_INTERNAL_API_KEY = 'pin-test-key';
  });

  afterEach(() => {
    if (previousKey === undefined) delete process.env.BFF_INTERNAL_API_KEY;
    else process.env.BFF_INTERNAL_API_KEY = previousKey;
  });

  test('guarded endpoint migrates an old guest mapping and rejects a competing claimant', async () => {
    const users = new Map<number, { wikidotId: number | null }>([
      [99, { wikidotId: 42 }],
      [700, { wikidotId: null }]
    ]);
    const mappings = new Map<string, number>([
      ['old-account', 700]
    ]);
    const collections = [{
      id: 501,
      ownerId: 700,
      slug: 'old-private',
      isDefault: true,
      visibility: 'PUBLIC'
    }];

    queryMock.mockImplementation(async (
      sqlValue: unknown,
      values: unknown[] = []
    ) => {
      const sql = String(sqlValue).replace(/\s+/g, ' ').trim();
      if (
        sql === 'BEGIN'
        || sql === 'COMMIT'
        || sql === 'ROLLBACK'
        || sql.includes('pg_advisory_xact_lock')
      ) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes('FROM "CollectionAccountOwner" cao')) {
        const userId = mappings.get(String(values[0]));
        return {
          rows: userId == null
            ? []
            : [{
                userId,
                wikidotId: users.get(userId)?.wikidotId ?? null
              }],
          rowCount: userId == null ? 0 : 1
        };
      }
      if (
        sql.includes('SELECT id FROM "User"')
        && sql.includes('"wikidotId" = $1')
      ) {
        const found = [...users.entries()].find(
          ([, user]) => user.wikidotId === Number(values[0])
        );
        return {
          rows: found ? [{ id: found[0] }] : [],
          rowCount: found ? 1 : 0
        };
      }
      if (
        sql.includes('FROM "CollectionAccountOwner"')
        && sql.includes('"accountId" <> $2')
      ) {
        const claim = [...mappings.entries()].find(
          ([accountId, userId]) => (
            userId === Number(values[0])
            && accountId !== String(values[1])
          )
        );
        return {
          rows: claim
            ? [{ accountId: claim[0], userId: claim[1] }]
            : [],
          rowCount: claim ? 1 : 0
        };
      }
      if (
        sql.includes('SELECT id, slug, "isDefault"')
        && sql.includes('FROM "UserCollection"')
      ) {
        const rows = collections
          .filter(collection => collection.ownerId === Number(values[0]))
          .map(({ id, slug, isDefault }) => ({ id, slug, isDefault }));
        return { rows, rowCount: rows.length };
      }
      if (
        sql.includes('UPDATE "UserCollection"')
        && sql.includes('SET "ownerId" = $1')
      ) {
        const collection = collections.find(item => (
          item.id === Number(values[3])
          && item.ownerId === Number(values[4])
        ));
        if (!collection) return { rows: [], rowCount: 0 };
        collection.ownerId = Number(values[0]);
        collection.slug = String(values[1]);
        collection.isDefault = Boolean(values[2]);
        if (sql.includes("visibility = 'PRIVATE'")) {
          collection.visibility = 'PRIVATE';
        }
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('UPDATE "CollectionAccountOwner"')) {
        if (mappings.get(String(values[1])) !== Number(values[2])) {
          return { rows: [], rowCount: 0 };
        }
        mappings.set(String(values[1]), Number(values[0]));
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO "CollectionAccountOwner"')) {
        mappings.set(String(values[0]), Number(values[1]));
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });

    const app = await createServer();
    await request(app)
      .post('/internal/collection-owner/pin')
      .set('x-internal-key', 'wrong-key')
      .send({ accountId: 'old-account', wikidotId: 42 })
      .expect(403);
    expect(queryMock).not.toHaveBeenCalled();

    const pinned = await request(app)
      .post('/internal/collection-owner/pin')
      .set('x-internal-key', 'pin-test-key')
      .send({ accountId: 'old-account', wikidotId: 42 })
      .expect(200);
    expect(pinned.headers['cache-control']).toBe('no-store');
    expect(pinned.body).toEqual({
      ok: true,
      pinned: {
        accountId: 'old-account',
        wikidotId: 42,
        userId: 99,
        migrated: true
      }
    });
    expect(mappings.get('old-account')).toBe(99);
    expect(collections[0]).toEqual(expect.objectContaining({
      ownerId: 99,
      visibility: 'PRIVATE'
    }));

    const idempotent = await request(app)
      .post('/internal/collection-owner/pin')
      .set('x-internal-key', 'pin-test-key')
      .send({ accountId: 'old-account', wikidotId: 42 })
      .expect(200);
    expect(idempotent.body.pinned.migrated).toBe(false);

    const conflict = await request(app)
      .post('/internal/collection-owner/pin')
      .set('x-internal-key', 'pin-test-key')
      .send({ accountId: 'new-account', wikidotId: 42 })
      .expect(409);
    expect(conflict.body).toEqual({
      error: 'collection_owner_pin_conflict'
    });
    expect(mappings.has('new-account')).toBe(false);
  });
});
