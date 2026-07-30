import test from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../src/db.js';
import {
  linkWikidotUser,
  unlinkWikidotUser
} from '../src/cli/linkWikidot.js';
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
  const prismaForTest = prisma as unknown as {
    $transaction: <T>(
      operation: (tx: typeof transactionClient) => Promise<T>,
      options?: unknown
    ) => Promise<T>;
    userAccount: {
      findUnique: (args: {
        where: { id?: string };
        select?: { updatedAt?: boolean };
      }) => Promise<StoredAccount | { updatedAt: Date } | null>;
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

  prismaForTest.$transaction = async (operation, options) => {
    transactionOptions.push(options);
    return operation(transactionClient);
  };
  prismaForTest.userAccount.findUnique = async (args) => {
    const account = args.where.id ? rows.get(args.where.id) : undefined;
    if (!account) return null;
    const versionOnly = args.select
      && args.select.updatedAt === true
      && Object.keys(args.select).length === 1;
    return versionOnly ? { updatedAt: account.updatedAt } : { ...account };
  };

  return {
    get(id: string) {
      const account = rows.get(id);
      assert.ok(account, `missing fake account ${id}`);
      return account;
    },
    transactionOptions,
    restore() {
      prismaForTest.$transaction = originalTransaction;
      prismaForTest.userAccount.findUnique = originalFindUnique;
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
  } finally {
    database.restore();
    __authCacheTesting.reset();
  }
});
