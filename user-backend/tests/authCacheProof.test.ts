import test from 'node:test';
import assert from 'node:assert/strict';
import type { NextFunction, Request, Response } from 'express';
import { prisma } from '../src/db.js';
import {
  __authCacheTesting,
  invalidateAuthCache,
  requireAuth
} from '../src/middleware/requireAuth.js';
import { config } from '../src/config.js';
import { issueAuthToken } from '../src/utils/auth-token.js';
import { EXPECTED_USER_ID_HEADER } from '../src/utils/expectedUser.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function account(displayName: string) {
  return {
    id: 'auth-cache-user',
    email: 'cache@example.com',
    displayName,
    linkedWikidotId: null,
    lastLoginAt: null,
    status: 'ACTIVE',
    passwordHash: `hash-${displayName}`,
    channelBindings: [],
    channelChallenges: []
  };
}

test('查询期间失效时旧结果既不返回也不重新写入缓存', async () => {
  __authCacheTesting.reset();
  const firstQuery = deferred<ReturnType<typeof account>>();
  const secondQuery = deferred<ReturnType<typeof account>>();
  const userAccount = prisma.userAccount as unknown as {
    findUnique: (...args: unknown[]) => Promise<ReturnType<typeof account> | null>;
  };
  const originalFindUnique = userAccount.findUnique;
  let queryCount = 0;

  userAccount.findUnique = async () => {
    queryCount += 1;
    return queryCount === 1 ? firstQuery.promise : secondQuery.promise;
  };

  try {
    const staleLookup = __authCacheTesting.fetchAndCacheUser('auth-cache-user');
    assert.equal(queryCount, 1);

    invalidateAuthCache('auth-cache-user');
    const freshLookup = __authCacheTesting.fetchAndCacheUser('auth-cache-user');
    assert.equal(queryCount, 2);

    firstQuery.resolve(account('旧昵称'));
    secondQuery.resolve(account('新昵称'));

    const [staleCallerResult, freshCallerResult] = await Promise.all([
      staleLookup,
      freshLookup
    ]);
    assert.equal(staleCallerResult?.displayName, '新昵称');
    assert.equal(freshCallerResult?.displayName, '新昵称');
    assert.equal(__authCacheTesting.getCachedUser('auth-cache-user')?.displayName, '新昵称');
    assert.equal(queryCount, 2);
  } finally {
    userAccount.findUnique = originalFindUnique;
    __authCacheTesting.reset();
  }
});

test('账号 Cookie 与预期账号不一致时在路由写入前返回 409', async () => {
  __authCacheTesting.reset();
  const cachedAccount = account('可信昵称');
  const userAccount = prisma.userAccount as unknown as {
    findUnique: (...args: unknown[]) => Promise<ReturnType<typeof account> | null>;
  };
  const originalFindUnique = userAccount.findUnique;
  userAccount.findUnique = async () => cachedAccount;

  const token = issueAuthToken(cachedAccount.id, cachedAccount.passwordHash);
  let statusCode = 200;
  let responseBody: unknown;
  let routeWriteReached = false;
  const req = {
    method: 'PATCH',
    headers: {
      cookie: `${config.session.cookieName}=${token}`,
      [EXPECTED_USER_ID_HEADER]: 'another-user'
    }
  } as unknown as Request;
  const res = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(body: unknown) {
      responseBody = body;
      return this;
    }
  } as unknown as Response;
  const next = (() => {
    routeWriteReached = true;
  }) as NextFunction;

  try {
    await requireAuth(req, res, next);
    assert.equal(statusCode, 409);
    assert.deepEqual(responseBody, {
      code: 'account_mismatch',
      error: '登录账号已切换，请刷新后重试。'
    });
    assert.equal(routeWriteReached, false);
    assert.equal(req.authUser, undefined);
  } finally {
    userAccount.findUnique = originalFindUnique;
    __authCacheTesting.reset();
  }
});

test('预期账号匹配的新客户端与未带 header 的旧客户端都可通过 requireAuth', async () => {
  __authCacheTesting.reset();
  const cachedAccount = account('兼容昵称');
  const userAccount = prisma.userAccount as unknown as {
    findUnique: (...args: unknown[]) => Promise<ReturnType<typeof account> | null>;
  };
  const originalFindUnique = userAccount.findUnique;
  userAccount.findUnique = async () => cachedAccount;

  const token = issueAuthToken(cachedAccount.id, cachedAccount.passwordHash);

  try {
    for (const expected of [undefined, cachedAccount.id]) {
      const headers: Record<string, string> = {
        cookie: `${config.session.cookieName}=${token}`
      };
      if (expected) headers[EXPECTED_USER_ID_HEADER] = expected;
      const req = {
        method: 'PATCH',
        headers
      } as unknown as Request;
      const res = {
        status() {
          assert.fail('compatible request should not be rejected');
        },
        json() {
          assert.fail('compatible request should not receive an error response');
        }
      } as unknown as Response;
      let nextCalled = false;

      await requireAuth(req, res, (() => {
        nextCalled = true;
      }) as NextFunction);
      assert.equal(nextCalled, true);
      assert.equal(req.authUser?.id, cachedAccount.id);
    }
  } finally {
    userAccount.findUnique = originalFindUnique;
    __authCacheTesting.reset();
  }
});
