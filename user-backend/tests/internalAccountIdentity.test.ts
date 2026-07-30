import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import { prisma } from '../src/db.js';
import { internalAccountIdentityRouter } from '../src/routes/internalAccountIdentity.js';

test('internal account identity is protected and reflects unlink/takeover without cache', async () => {
  const previousKey = process.env.BFF_INTERNAL_API_KEY;
  process.env.BFF_INTERNAL_API_KEY = 'account-identity-test-key';

  const states = new Map([
    ['old-account', {
      id: 'old-account',
      linkedWikidotId: 42 as number | null,
      status: 'ACTIVE' as const
    }],
    ['new-account', {
      id: 'new-account',
      linkedWikidotId: null as number | null,
      status: 'ACTIVE' as const
    }]
  ]);
  let reads = 0;
  const userAccount = prisma.userAccount as unknown as {
    findUnique: (args: {
      where: { id: string };
      select: {
        id: true;
        linkedWikidotId: true;
        status: true;
      };
    }) => Promise<{
      id: string;
      linkedWikidotId: number | null;
      status: 'ACTIVE';
    } | null>;
  };
  const originalFindUnique = userAccount.findUnique;
  userAccount.findUnique = async ({ where }) => {
    reads += 1;
    return states.get(where.id) ?? null;
  };

  const app = express();
  app.use('/internal/account-identity', internalAccountIdentityRouter());
  const server = app.listen(0, '127.0.0.1');

  try {
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const baseUrl = `http://127.0.0.1:${address.port}/internal/account-identity`;

    delete process.env.BFF_INTERNAL_API_KEY;
    const unconfigured = await fetch(`${baseUrl}/old-account`);
    assert.equal(unconfigured.status, 503);
    assert.equal(unconfigured.headers.get('cache-control'), 'no-store');
    assert.equal(reads, 0);

    process.env.BFF_INTERNAL_API_KEY = 'account-identity-test-key';
    const forbidden = await fetch(`${baseUrl}/old-account`);
    assert.equal(forbidden.status, 403);
    assert.equal(reads, 0);

    const headers = { 'x-internal-key': 'account-identity-test-key' };
    const beforeUnlink = await fetch(`${baseUrl}/old-account`, { headers });
    assert.equal(beforeUnlink.status, 200);
    assert.equal(beforeUnlink.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await beforeUnlink.json(), {
      ok: true,
      account: {
        id: 'old-account',
        linkedWikidotId: 42,
        status: 'ACTIVE'
      }
    });

    // Simulate a committed takeover. No auth or private collection request is
    // made between these reads; the internal endpoint must hit the database.
    states.get('old-account')!.linkedWikidotId = null;
    states.get('new-account')!.linkedWikidotId = 42;

    const oldAfterTakeover = await fetch(`${baseUrl}/old-account`, { headers });
    assert.equal(oldAfterTakeover.status, 200);
    assert.equal((await oldAfterTakeover.json()).account.linkedWikidotId, null);

    const newAfterTakeover = await fetch(`${baseUrl}/new-account`, { headers });
    assert.equal(newAfterTakeover.status, 200);
    assert.equal((await newAfterTakeover.json()).account.linkedWikidotId, 42);
    assert.equal(reads, 3);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    userAccount.findUnique = originalFindUnique;
    if (previousKey === undefined) delete process.env.BFF_INTERNAL_API_KEY;
    else process.env.BFF_INTERNAL_API_KEY = previousKey;
  }
});
