import assert from 'node:assert/strict';
import test from 'node:test';
import { inspect } from 'node:util';
import type { PrismaClient } from '@prisma/client';
import { WikidotBindingVerifyJob } from '../src/jobs/WikidotBindingVerifyJob.js';

const futureExpiry = '2099-01-01T00:00:00.000Z';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

test('checks every target-page incarnation and completes a matching recreated-page revision', async () => {
  const pageQueries: unknown[] = [];
  const revisionQueries: unknown[] = [];
  const internalPosts: Array<{ path: string; body: Record<string, unknown> }> = [];
  const originalFetch = globalThis.fetch;

  const prisma = {
    page: {
      findMany: async (query: unknown) => {
        pageQueries.push(query);
        return [
          { id: 106095, isDeleted: false },
          { id: 106092, isDeleted: true },
          { id: 34470, isDeleted: true }
        ];
      }
    },
    user: {
      findUnique: async () => ({ id: 42 })
    },
    revision: {
      findMany: async (query: unknown) => {
        revisionQueries.push(query);
        return [
          {
            id: 9002,
            comment: 'prefix SCPPER-ABC234 suffix',
            timestamp: new Date('2026-07-12T10:01:00.000Z')
          },
          {
            id: 9001,
            comment: '  \nSCPPER-ABC234\t ',
            timestamp: new Date('2026-07-12T10:00:00.000Z')
          }
        ];
      }
    }
  } as unknown as PrismaClient;

  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input));
    if (init?.method === 'GET') {
      return jsonResponse({
        ok: true,
        tasks: [{
          id: 'task-recreated-page',
          userId: 'account-1',
          wikidotUserId: 1234,
          verificationCode: 'SCPPER-ABC234',
          createdAt: '2026-07-12T09:58:00.000Z',
          expiresAt: futureExpiry,
          checkCount: 10,
          lastCheckedAt: null
        }]
      });
    }

    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    internalPosts.push({ path: url.pathname, body });
    return jsonResponse({ ok: true });
  }) as typeof fetch;

  try {
    await new WikidotBindingVerifyJob(prisma).run();
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(pageQueries.length, 1);
  assert.deepEqual(pageQueries[0], {
    where: {
      currentUrl: {
        in: [
          'http://scp-wiki-cn.wikidot.com/andyblocker',
          'https://scp-wiki-cn.wikidot.com/andyblocker'
        ]
      }
    },
    select: { id: true, isDeleted: true },
    orderBy: [
      { isDeleted: 'asc' },
      { updatedAt: 'desc' },
      { id: 'desc' }
    ]
  });
  assert.equal(revisionQueries.length, 1);
  assert.deepEqual(
    (revisionQueries[0] as { where: { pageVersion: unknown } }).where.pageVersion,
    { pageId: { in: [106095, 106092, 34470] } }
  );
  assert.deepEqual(
    (revisionQueries[0] as { where: { timestamp: unknown } }).where.timestamp,
    {
      gte: new Date('2026-07-12T09:53:00.000Z'),
      lte: new Date(futureExpiry)
    }
  );
  assert.deepEqual(internalPosts, [{
    path: '/internal/wikidot-binding/complete',
    body: {
      taskId: 'task-recreated-page',
      revisionId: 9001,
      timestamp: '2026-07-12T10:00:00.000Z',
      wikidotUserId: 1234,
      verificationCode: 'SCPPER-ABC234',
      createdAt: '2026-07-12T09:58:00.000Z',
      expiresAt: futureExpiry
    }
  }]);
});

test('rejects non-canonical verification codes without completing a task', async () => {
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  const internalPosts: Array<{ path: string; body: Record<string, unknown> }> = [];
  const invalidCodes = [
    '',
    'SCPPER-ABC23I',
    'SCPPER-abc234',
    'SCPPER-ABC2347'
  ];

  const prisma = {
    page: {
      findMany: async () => [{ id: 106095, isDeleted: false }]
    },
    user: {
      findUnique: async () => {
        throw new Error('invalid code must be rejected before user lookup');
      }
    },
    revision: {
      findMany: async () => {
        throw new Error('invalid code must be rejected before revision lookup');
      }
    }
  } as unknown as PrismaClient;

  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input));
    if (init?.method === 'GET') {
      return jsonResponse({
        ok: true,
        tasks: invalidCodes.map((verificationCode, index) => ({
          id: `task-invalid-${index}`,
          userId: `account-invalid-${index}`,
          wikidotUserId: 2000 + index,
          verificationCode,
          createdAt: '2026-07-12T09:58:00.000Z',
          expiresAt: futureExpiry,
          checkCount: 0,
          lastCheckedAt: null
        }))
      });
    }

    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    internalPosts.push({ path: url.pathname, body });
    return jsonResponse({ ok: true });
  }) as typeof fetch;
  console.warn = () => undefined;

  try {
    await new WikidotBindingVerifyJob(prisma).run();
  } finally {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
  }

  assert.equal(internalPosts.length, invalidCodes.length);
  assert.ok(internalPosts.every(({ path }) => path === '/internal/wikidot-binding/update-check'));
  assert.ok(internalPosts.every(({ path }) => path !== '/internal/wikidot-binding/complete'));
});

test('does not complete when a canonical code is only a comment substring', async () => {
  const originalFetch = globalThis.fetch;
  const internalPosts: Array<{ path: string; body: Record<string, unknown> }> = [];

  const prisma = {
    page: {
      findMany: async () => [{ id: 106095, isDeleted: false }]
    },
    user: {
      findUnique: async () => ({ id: 55 })
    },
    revision: {
      findMany: async () => [{
        id: 9010,
        comment: 'prefix SCPPER-ABC234 suffix',
        timestamp: new Date('2026-07-12T10:00:00.000Z')
      }]
    }
  } as unknown as PrismaClient;

  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input));
    if (init?.method === 'GET') {
      return jsonResponse({
        ok: true,
        tasks: [{
          id: 'task-substring-only',
          userId: 'account-substring-only',
          wikidotUserId: 3456,
          verificationCode: 'SCPPER-ABC234',
          createdAt: '2026-07-12T09:58:00.000Z',
          expiresAt: futureExpiry,
          checkCount: 0,
          lastCheckedAt: null
        }]
      });
    }

    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    internalPosts.push({ path: url.pathname, body });
    return jsonResponse({ ok: true });
  }) as typeof fetch;

  try {
    await new WikidotBindingVerifyJob(prisma).run();
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(internalPosts, [{
    path: '/internal/wikidot-binding/update-check',
    body: { taskId: 'task-substring-only' }
  }]);
});

test('never includes a pending API non-2xx response body in errors or logs', async () => {
  const originalFetch = globalThis.fetch;
  const originalError = console.error;
  const sentinel = 'DO_NOT_LEAK_PENDING_BODY_7f96d913';
  const loggedErrors: unknown[][] = [];
  let caught: unknown;

  const prisma = {
    page: {
      findMany: async () => {
        throw new Error('page lookup must not run when pending API fails');
      }
    }
  } as unknown as PrismaClient;

  globalThis.fetch = (async () => new Response(sentinel, { status: 503 })) as typeof fetch;
  console.error = (...args: unknown[]) => {
    loggedErrors.push(args);
  };

  try {
    await new WikidotBindingVerifyJob(prisma).run();
  } catch (error) {
    caught = error;
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalError;
  }

  assert.ok(caught instanceof Error);
  const errorChain: string[] = [];
  let current: unknown = caught;
  while (current instanceof Error) {
    errorChain.push(`${current.message}\n${current.stack ?? ''}`);
    current = current.cause;
  }
  const errorText = errorChain.join('\n');
  const logText = inspect(loggedErrors, { depth: null });

  assert.match(errorText, /pending API returned HTTP 503/);
  assert.doesNotMatch(errorText, new RegExp(sentinel));
  assert.doesNotMatch(logText, new RegExp(sentinel));
});

test('fails the cycle and records a check when the completion endpoint rejects proof', async () => {
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  const originalError = console.error;
  const internalPosts: Array<{ path: string; body: Record<string, unknown> }> = [];

  const prisma = {
    page: {
      findMany: async () => [{ id: 106095, isDeleted: false }]
    },
    user: {
      findUnique: async () => ({ id: 88 })
    },
    revision: {
      findMany: async () => [{
        id: 9020,
        comment: 'SCPPER-ABC234',
        timestamp: new Date('2026-07-12T10:00:00.000Z')
      }]
    }
  } as unknown as PrismaClient;

  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input));
    if (init?.method === 'GET') {
      return jsonResponse({
        ok: true,
        tasks: [{
          id: 'task-complete-rejected',
          userId: 'account-complete-rejected',
          wikidotUserId: 4567,
          verificationCode: 'SCPPER-ABC234',
          createdAt: '2026-07-12T09:58:00.000Z',
          expiresAt: futureExpiry,
          checkCount: 0,
          lastCheckedAt: null
        }]
      });
    }

    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    internalPosts.push({ path: url.pathname, body });
    return url.pathname.endsWith('/complete')
      ? jsonResponse({ error: 'proof rejected' }, 400)
      : jsonResponse({ ok: true });
  }) as typeof fetch;
  console.warn = () => undefined;
  console.error = () => undefined;

  try {
    await assert.rejects(
      new WikidotBindingVerifyJob(prisma).run(),
      /Failed to persist verification state for 1\/1 binding tasks/
    );
  } finally {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
    console.error = originalError;
  }

  assert.deepEqual(internalPosts.map(({ path }) => path), [
    '/internal/wikidot-binding/complete',
    '/internal/wikidot-binding/update-check'
  ]);
});

test('stuck-task warnings never include the Wikidot ID or verification code', async () => {
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  const warnings: string[] = [];
  const secretCode = 'SCPPER-SECRET';
  const wikidotUserId = 7654321;

  const prisma = {
    page: {
      findMany: async () => [{ id: 106095, isDeleted: false }]
    },
    user: {
      findUnique: async () => ({ id: 77 })
    },
    revision: {
      findMany: async () => []
    }
  } as unknown as PrismaClient;

  globalThis.fetch = (async (_input, init) => {
    if (init?.method === 'GET') {
      return jsonResponse({
        ok: true,
        tasks: [{
          id: 'task-stuck',
          userId: 'account-2',
          wikidotUserId,
          verificationCode: secretCode,
          createdAt: '2026-07-12T09:58:00.000Z',
          expiresAt: futureExpiry,
          checkCount: 60,
          lastCheckedAt: null
        }]
      });
    }
    return jsonResponse({ ok: true });
  }) as typeof fetch;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(' '));
  };

  try {
    await new WikidotBindingVerifyJob(prisma).run();
  } finally {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
  }

  const warningText = warnings.join('\n');
  assert.match(warningText, /task-stuck stuck after 60 checks/);
  assert.doesNotMatch(warningText, new RegExp(secretCode));
  assert.doesNotMatch(warningText, new RegExp(String(wikidotUserId)));
});

test('fails the cycle when no target-page incarnation exists', async () => {
  const originalFetch = globalThis.fetch;
  const originalError = console.error;
  const prisma = {
    page: {
      findMany: async () => []
    }
  } as unknown as PrismaClient;

  globalThis.fetch = (async () => jsonResponse({
    ok: true,
    tasks: [{
      id: 'task-no-page',
      userId: 'account-3',
      wikidotUserId: 2468,
      verificationCode: 'SCPPER-NOPAGE',
      createdAt: '2026-07-12T09:58:00.000Z',
      expiresAt: futureExpiry,
      checkCount: 0,
      lastCheckedAt: null
    }]
  })) as typeof fetch;
  console.error = () => undefined;

  try {
    await assert.rejects(
      new WikidotBindingVerifyJob(prisma).run(),
      /Target page "\/andyblocker" not found/
    );
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalError;
  }
});
