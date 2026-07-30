import express from 'express';
import request from 'supertest';
import type { Pool, PoolClient } from 'pg';
import type { RedisClientType } from 'redis';
import type { AuthUserPayload } from '../src/web/utils/auth';
import {
  pinCollectionOwnerBeforeIdentityTransition,
  resolveCollectionOwnerId
} from '../src/web/utils/collectionOwner';
import { usersRouter } from '../src/web/routes/users';

describe('collection guest owner privacy', () => {
  test('stores a fixed anonymous display name instead of account PII', async () => {
    const poolQuery = jest.fn(async () => ({ rows: [], rowCount: 0 }));
    const clientQuery = jest.fn(async (
      sqlValue: unknown,
      _values: unknown[] = []
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
        return { rows: [], rowCount: 0 };
      }
      if (
        sql.includes('INSERT INTO "User"')
        && sql.includes('"displayName", "isGuest"')
      ) {
        return { rows: [{ id: 700 }], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO "CollectionAccountOwner"')) {
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const client = {
      query: clientQuery,
      release: jest.fn()
    } as unknown as PoolClient;
    const pool = {
      query: poolQuery,
      connect: jest.fn(async () => client)
    } as unknown as Pool;
    const auth: AuthUserPayload = {
      id: 'account-with-private-data',
      email: 'private-email@example.com',
      displayName: 'Private Account Name',
      linkedWikidotId: null,
      lastLoginAt: null,
      qqBinding: {
        bound: false,
        addressMask: null,
        status: null,
        pendingChallenge: false,
        capabilities: {
          featureEnabled: false,
          createBinding: false,
          deliverNotifications: false,
          manageExistingBinding: false
        }
      }
    };

    await expect(resolveCollectionOwnerId(pool, auth)).resolves.toBe(700);

    const guestInsert = clientQuery.mock.calls.find(([sql]) =>
      String(sql).includes('INSERT INTO "User" ("displayName", "isGuest")')
    );
    expect(guestInsert?.[1]).toEqual(['SCPper 收藏用户']);
    expect(String(guestInsert?.[1]?.[0])).not.toContain('@');
    expect(guestInsert?.[1]).not.toContain(auth.email);
    expect(guestInsert?.[1]).not.toContain(auth.displayName);
  });

  test('pre-pin turns legacy provenance into a claimant before takeover', async () => {
    const users = new Map<number, { wikidotId: number | null }>([
      [99, { wikidotId: 42 }]
    ]);
    const mappings = new Map<string, number>();
    const collections: Array<{
      id: number;
      ownerId: number;
      slug: string;
      isDefault: boolean;
      visibility: 'PUBLIC' | 'PRIVATE';
      publishedAt: Date | null;
    }> = [{
      id: 501,
      ownerId: 99,
      slug: 'legacy-public',
      isDefault: true,
      visibility: 'PUBLIC',
      publishedAt: new Date('2026-07-01T00:00:00.000Z')
    }];
    let nextUserId = 700;

    const query = jest.fn(async (
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
        if (userId == null) return { rows: [], rowCount: 0 };
        return {
          rows: [{
            userId,
            wikidotId: users.get(userId)?.wikidotId ?? null
          }],
          rowCount: 1
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
        sql.includes('INSERT INTO "User"')
        && sql.includes('"displayName", "isGuest"')
      ) {
        const id = nextUserId;
        nextUserId += 1;
        users.set(id, { wikidotId: null });
        return { rows: [{ id }], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO "CollectionAccountOwner"')) {
        mappings.set(String(values[0]), Number(values[1]));
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('UPDATE "CollectionAccountOwner"')) {
        if (mappings.get(String(values[1])) !== Number(values[2])) {
          return { rows: [], rowCount: 0 };
        }
        mappings.set(String(values[1]), Number(values[0]));
        return { rows: [], rowCount: 1 };
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
          collection.publishedAt = null;
        }
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const client = {
      query,
      release: jest.fn()
    } as unknown as PoolClient;
    const pool = {
      query,
      connect: jest.fn(async () => client)
    } as unknown as Pool;

    const firstPin = await pinCollectionOwnerBeforeIdentityTransition(
      pool,
      'old-account',
      42
    );
    expect(firstPin).toEqual({
      accountId: 'old-account',
      wikidotId: 42,
      userId: 99,
      migrated: false
    });
    await expect(pinCollectionOwnerBeforeIdentityTransition(
      pool,
      'old-account',
      42
    )).resolves.toEqual(firstPin);
    expect(mappings.get('old-account')).toBe(99);

    const newAuth: AuthUserPayload = {
      id: 'new-account',
      email: 'new@example.com',
      displayName: 'New',
      linkedWikidotId: 42,
      lastLoginAt: null,
      qqBinding: {
        bound: false,
        addressMask: null,
        status: null,
        pendingChallenge: false,
        capabilities: {
          featureEnabled: false,
          createBinding: false,
          deliverNotifications: false,
          manageExistingBinding: false
        }
      }
    };
    await expect(resolveCollectionOwnerId(
      pool,
      newAuth,
      async () => newAuth
    )).resolves.toBe(99);

    // The old collection followed the pinned old-account claimant into an
    // isolated guest. The new claimant gets the canonical owner but cannot
    // inherit any mapping-less legacy data.
    expect(mappings.get('old-account')).toBe(700);
    expect(mappings.get('new-account')).toBe(99);
    expect(collections).toEqual([
      expect.objectContaining({
        id: 501,
        ownerId: 700,
        visibility: 'PRIVATE',
        publishedAt: null
      })
    ]);
  });

  test('legacy public id route bypasses old cache and excludes guest users', async () => {
    const leakedGuest = {
      id: 700,
      wikidotId: null,
      displayName: 'private-email@example.com',
      isGuest: true
    };
    const queryMock = jest.fn(async (sqlValue: unknown) => {
      const sql = String(sqlValue);
      const excludesGuest = sql.includes('COALESCE("isGuest", FALSE) = FALSE');
      const requiresWikidot = sql.includes('"wikidotId" IS NOT NULL');
      return {
        rows: excludesGuest && requiresWikidot ? [] : [leakedGuest],
        rowCount: excludesGuest && requiresWikidot ? 0 : 1
      };
    });
    const pool = {
      query: queryMock
    } as unknown as Pool;
    const oldCacheKey = 'scpcn:bff:users:profile:id:700';
    const redisGet = jest.fn(async (key: string) => (
      key === oldCacheKey ? JSON.stringify(leakedGuest) : null
    ));
    const redis = {
      get: redisGet,
      set: jest.fn(),
      del: jest.fn(),
      scanIterator: jest.fn()
    } as unknown as RedisClientType;
    const app = express();
    app.use('/users', usersRouter(pool, redis));

    const response = await request(app)
      .get('/users/700')
      .expect(404);

    expect(response.body).toEqual({ error: 'not_found' });
    expect(redisGet).toHaveBeenCalledWith(
      'scpcn:bff:users:profile:id:v2:700'
    );
    expect(redisGet).not.toHaveBeenCalledWith(oldCacheKey);
    expect(queryMock).toHaveBeenCalledTimes(1);
    const sql = String(queryMock.mock.calls[0]?.[0]);
    expect(sql).toContain('"wikidotId" IS NOT NULL');
    expect(sql).toContain('COALESCE("isGuest", FALSE) = FALSE');
  });
});
