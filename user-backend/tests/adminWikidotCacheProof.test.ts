import test from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../src/db.js';
import {
  linkWikidotUser,
  unlinkWikidotUser
} from '../src/cli/linkWikidot.js';
import { deleteAccountWithCollectionPin } from '../src/routes/admin.js';
import { __authCacheTesting } from '../src/middleware/requireAuth.js';

interface StoredAccount {
  id: string;
  email: string;
  displayName: string;
  linkedWikidotId: number | null;
  lastLoginAt: Date | null;
  updatedAt: Date;
  status: 'ACTIVE';
  passwordHash: string;
  channelBindings: [];
  channelChallenges: [];
}

function storedAccount(
  id: string,
  email: string,
  linkedWikidotId: number | null,
  updatedAt: string
): StoredAccount {
  return {
    id,
    email,
    displayName: email,
    linkedWikidotId,
    lastLoginAt: null,
    updatedAt: new Date(updatedAt),
    status: 'ACTIVE',
    passwordHash: `hash-${id}`,
    channelBindings: [],
    channelChallenges: []
  };
}

function installDatabaseHarness(initialAccounts: StoredAccount[]) {
  const rows = new Map(initialAccounts.map((account) => [account.id, { ...account }]));
  const transactionOptions: unknown[] = [];
  const deletePredicates: Array<{
    id: string;
    linkedWikidotId: number | null;
  }> = [];
  const pinCalls: Array<{ accountId: string; wikidotId: number }> = [];
  const originalFetch = globalThis.fetch;
  const previousBffBaseUrl = process.env.BFF_BASE_URL;
  const previousBffInternalKey = process.env.BFF_INTERNAL_API_KEY;
  process.env.BFF_BASE_URL = 'http://bff.test';
  process.env.BFF_INTERNAL_API_KEY = 'collection-owner-pin-test-key';
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    const payload = JSON.parse(String(init?.body || '{}')) as {
      accountId: string;
      wikidotId: number;
    };
    pinCalls.push(payload);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        pinned: payload
      })
    } as Response;
  }) as typeof fetch;
  const prismaForTest = prisma as unknown as {
    $transaction: <T>(
      operation: (tx: typeof transactionClient) => Promise<T>,
      options?: unknown
    ) => Promise<T>;
    userAccount: {
      findUnique: (args: {
        where: {
          id?: string;
          email?: string;
          linkedWikidotId?: number;
        };
        select?: { updatedAt?: boolean };
      }) => Promise<StoredAccount | { updatedAt: Date } | null>;
      deleteMany: (args: {
        where: {
          id: string;
          linkedWikidotId: number | null;
        };
      }) => Promise<{ count: number }>;
    };
  };

  const transactionClient = {
    userAccount: {
      async findUnique(args: {
        where: {
          id?: string;
          email?: string;
          linkedWikidotId?: number;
        };
      }) {
        const account = [...rows.values()].find((candidate) => {
          if (args.where.id !== undefined) return candidate.id === args.where.id;
          if (args.where.email !== undefined) return candidate.email === args.where.email;
          if (args.where.linkedWikidotId !== undefined) {
            return candidate.linkedWikidotId === args.where.linkedWikidotId;
          }
          return false;
        });
        return account ? { ...account } : null;
      },

      async update(args: {
        where: { id: string };
        data: {
          linkedWikidotId?: number | null;
          updatedAt?: Date;
        };
      }) {
        const current = rows.get(args.where.id);
        assert.ok(current, `missing fake account ${args.where.id}`);
        const updated: StoredAccount = {
          ...current,
          linkedWikidotId: args.data.linkedWikidotId ?? null,
          updatedAt: args.data.updatedAt ?? current.updatedAt
        };
        rows.set(updated.id, updated);
        return { ...updated };
      }
    }
  };

  const originalTransaction = prismaForTest.$transaction;
  const originalFindUnique = prismaForTest.userAccount.findUnique;
  const originalDeleteMany = prismaForTest.userAccount.deleteMany;

  prismaForTest.$transaction = async (operation, options) => {
    transactionOptions.push(options);
    return operation(transactionClient);
  };
  prismaForTest.userAccount.findUnique = async (args) => {
    const account = [...rows.values()].find((candidate) => {
      if (args.where.id !== undefined) return candidate.id === args.where.id;
      if (args.where.email !== undefined) return candidate.email === args.where.email;
      if (args.where.linkedWikidotId !== undefined) {
        return candidate.linkedWikidotId === args.where.linkedWikidotId;
      }
      return false;
    });
    if (!account) return null;
    const versionOnly = args.select
      && args.select.updatedAt === true
      && Object.keys(args.select).length === 1;
    return versionOnly ? { updatedAt: account.updatedAt } : { ...account };
  };
  prismaForTest.userAccount.deleteMany = async ({ where }) => {
    deletePredicates.push(where);
    const account = rows.get(where.id);
    if (!account || account.linkedWikidotId !== where.linkedWikidotId) {
      return { count: 0 };
    }
    rows.delete(where.id);
    return { count: 1 };
  };

  return {
    get(id: string) {
      const account = rows.get(id);
      assert.ok(account, `missing fake account ${id}`);
      return account;
    },
    has(id: string) {
      return rows.has(id);
    },
    deletePredicates,
    pinCalls,
    transactionOptions,
    restore() {
      prismaForTest.$transaction = originalTransaction;
      prismaForTest.userAccount.findUnique = originalFindUnique;
      prismaForTest.userAccount.deleteMany = originalDeleteMany;
      globalThis.fetch = originalFetch;
      if (previousBffBaseUrl === undefined) delete process.env.BFF_BASE_URL;
      else process.env.BFF_BASE_URL = previousBffBaseUrl;
      if (previousBffInternalKey === undefined) delete process.env.BFF_INTERNAL_API_KEY;
      else process.env.BFF_INTERNAL_API_KEY = previousBffInternalKey;
    }
  };
}

test('管理员 link、force 与 unlink 都在提交后立即清理目标账号缓存', async () => {
  __authCacheTesting.reset();
  const database = installDatabaseHarness([
    storedAccount(
      'target-account',
      'target@example.com',
      null,
      '2026-07-30T06:00:00.000Z'
    )
  ]);

  try {
    const beforeLinkVersion = database.get('target-account').updatedAt.getTime();
    await __authCacheTesting.fetchAndCacheUser('target-account');
    assert.ok(__authCacheTesting.getCachedUser('target-account'));

    await linkWikidotUser({
      email: 'target@example.com',
      wikidotId: 1001
    });
    assert.equal(database.get('target-account').linkedWikidotId, 1001);
    assert.ok(database.get('target-account').updatedAt.getTime() > beforeLinkVersion);
    assert.equal(__authCacheTesting.getCachedUser('target-account'), null);

    await __authCacheTesting.fetchAndCacheUser('target-account');
    const beforeForceVersion = database.get('target-account').updatedAt.getTime();
    await linkWikidotUser({
      email: 'target@example.com',
      wikidotId: 1002,
      force: true
    });
    assert.equal(database.get('target-account').linkedWikidotId, 1002);
    assert.ok(database.get('target-account').updatedAt.getTime() > beforeForceVersion);
    assert.equal(__authCacheTesting.getCachedUser('target-account'), null);

    await __authCacheTesting.fetchAndCacheUser('target-account');
    const beforeUnlinkVersion = database.get('target-account').updatedAt.getTime();
    await unlinkWikidotUser({ email: 'target@example.com' });
    assert.equal(database.get('target-account').linkedWikidotId, null);
    assert.ok(database.get('target-account').updatedAt.getTime() > beforeUnlinkVersion);
    assert.equal(__authCacheTesting.getCachedUser('target-account'), null);
    assert.equal(database.transactionOptions.length, 3);
    assert.deepEqual(database.pinCalls, [
      { accountId: 'target-account', wikidotId: 1001 },
      { accountId: 'target-account', wikidotId: 1002 }
    ]);
  } finally {
    database.restore();
    __authCacheTesting.reset();
  }
});

test('takeover 同时清理目标账号与原绑定账号的预热缓存', async () => {
  __authCacheTesting.reset();
  const database = installDatabaseHarness([
    storedAccount(
      'takeover-target',
      'new-owner@example.com',
      null,
      '2026-07-30T06:00:00.500Z'
    ),
    storedAccount(
      'previous-owner',
      'old-owner@example.com',
      2001,
      '2026-07-30T06:00:01.000Z'
    )
  ]);

  try {
    const targetOldVersion = database.get('takeover-target').updatedAt.getTime();
    const previousOwnerOldVersion = database.get('previous-owner').updatedAt.getTime();
    await Promise.all([
      __authCacheTesting.fetchAndCacheUser('takeover-target'),
      __authCacheTesting.fetchAndCacheUser('previous-owner')
    ]);
    assert.ok(__authCacheTesting.getCachedUser('takeover-target'));
    assert.ok(__authCacheTesting.getCachedUser('previous-owner'));

    const result = await linkWikidotUser({
      email: 'new-owner@example.com',
      wikidotId: 2001,
      takeover: true
    });

    assert.equal(result.clearedAccountEmail, 'old-owner@example.com');
    assert.equal(database.get('takeover-target').linkedWikidotId, 2001);
    assert.equal(database.get('previous-owner').linkedWikidotId, null);
    assert.equal(
      database.get('takeover-target').updatedAt.getTime(),
      database.get('previous-owner').updatedAt.getTime()
    );
    assert.ok(database.get('takeover-target').updatedAt.getTime() > targetOldVersion);
    assert.ok(database.get('takeover-target').updatedAt.getTime() > previousOwnerOldVersion);
    assert.equal(__authCacheTesting.getCachedUser('takeover-target'), null);
    assert.equal(__authCacheTesting.getCachedUser('previous-owner'), null);
    assert.deepEqual(database.pinCalls, [
      { accountId: 'previous-owner', wikidotId: 2001 }
    ]);
  } finally {
    database.restore();
    __authCacheTesting.reset();
  }
});

test('BFF pre-pin 失败时 unlink 不启动身份写事务', async () => {
  __authCacheTesting.reset();
  const database = installDatabaseHarness([
    storedAccount(
      'unlink-owner',
      'unlink-owner@example.com',
      3001,
      '2026-07-30T06:00:02.000Z'
    )
  ]);
  globalThis.fetch = (async () => ({
    ok: false,
    status: 503,
    json: async () => ({ error: 'unavailable' })
  }) as Response) as typeof fetch;

  try {
    await assert.rejects(
      unlinkWikidotUser({ email: 'unlink-owner@example.com' }),
      /收藏归属预固定失败，身份变更已取消/
    );
    assert.equal(database.get('unlink-owner').linkedWikidotId, 3001);
    assert.equal(database.transactionOptions.length, 0);
  } finally {
    database.restore();
    __authCacheTesting.reset();
  }
});

test('BFF pre-pin 拒绝 takeover 时两端身份都保持不变', async () => {
  __authCacheTesting.reset();
  const database = installDatabaseHarness([
    storedAccount(
      'new-owner',
      'new-owner-2@example.com',
      null,
      '2026-07-30T06:00:03.000Z'
    ),
    storedAccount(
      'old-owner',
      'old-owner-2@example.com',
      3002,
      '2026-07-30T06:00:04.000Z'
    )
  ]);
  globalThis.fetch = (async () => ({
    ok: false,
    status: 409,
    json: async () => ({ error: 'collection_owner_pin_conflict' })
  }) as Response) as typeof fetch;

  try {
    await assert.rejects(
      linkWikidotUser({
        email: 'new-owner-2@example.com',
        wikidotId: 3002,
        takeover: true
      }),
      /收藏归属预固定失败，身份变更已取消/
    );
    assert.equal(database.get('new-owner').linkedWikidotId, null);
    assert.equal(database.get('old-owner').linkedWikidotId, 3002);
    assert.equal(database.transactionOptions.length, 0);
  } finally {
    database.restore();
    __authCacheTesting.reset();
  }
});

test('删除 linked 账号先 pre-pin，失败不删且成功删除绑定快照', async () => {
  const database = installDatabaseHarness([
    storedAccount(
      'delete-owner',
      'delete-owner@example.com',
      4001,
      '2026-07-30T06:00:05.000Z'
    )
  ]);
  const failedPinCalls: Array<{ accountId: string; wikidotId: number }> = [];
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    failedPinCalls.push(JSON.parse(String(init?.body || '{}')));
    return {
      ok: false,
      status: 503,
      json: async () => ({ error: 'unavailable' })
    } as Response;
  }) as typeof fetch;

  try {
    await assert.rejects(
      deleteAccountWithCollectionPin('delete-owner', 'admin-account'),
      /收藏归属预固定失败，身份变更已取消/
    );
    assert.deepEqual(failedPinCalls, [{
      accountId: 'delete-owner',
      wikidotId: 4001
    }]);
    assert.equal(database.has('delete-owner'), true);
    assert.deepEqual(database.deletePredicates, []);

    const successfulPinCalls: Array<{ accountId: string; wikidotId: number }> = [];
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body || '{}')) as {
        accountId: string;
        wikidotId: number;
      };
      successfulPinCalls.push(payload);
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, pinned: payload })
      } as Response;
    }) as typeof fetch;
    await assert.doesNotReject(
      deleteAccountWithCollectionPin('delete-owner', 'admin-account')
    );
    assert.deepEqual(successfulPinCalls, [{
      accountId: 'delete-owner',
      wikidotId: 4001
    }]);
    assert.equal(database.has('delete-owner'), false);
    assert.deepEqual(database.deletePredicates, [{
      id: 'delete-owner',
      linkedWikidotId: 4001
    }]);
  } finally {
    database.restore();
  }
});
