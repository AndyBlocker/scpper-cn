import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import {
  isCompletableLatestBindingTask,
  selectLatestActionableBindingTask,
  validateBindingCompletionProof,
  type BindingCompletionProof,
  type BindingTaskProofSnapshot
} from '../src/services/wikidotBindingProof.js';
import {
  wikidotBindingInternalRouter,
  wikidotBindingRouter
} from '../src/routes/wikidotBinding.js';

const createdAt = new Date('2026-07-13T03:00:00.000Z');
const expiresAt = new Date('2026-07-15T03:00:00.000Z');
const task: BindingTaskProofSnapshot = {
  wikidotUserId: 12345,
  verificationCode: 'SCPPER-ABC234',
  createdAt,
  expiresAt
};

function proof(overrides: Partial<BindingCompletionProof> = {}): BindingCompletionProof {
  return {
    ...task,
    revisionId: 9001,
    timestamp: new Date('2026-07-13T03:01:00.000Z'),
    ...overrides
  };
}

test('accepts proof bound to the exact task snapshot within the allowed window', () => {
  assert.equal(validateBindingCompletionProof(task, proof()), true);
  assert.equal(validateBindingCompletionProof(task, proof({
    timestamp: new Date(createdAt.getTime() - 5 * 60 * 1000)
  })), true);
  assert.equal(validateBindingCompletionProof(task, proof({ timestamp: expiresAt })), true);
});

test('rejects proof outside the task timestamp window', () => {
  assert.equal(validateBindingCompletionProof(task, proof({
    timestamp: new Date(createdAt.getTime() - 5 * 60 * 1000 - 1)
  })), false);
  assert.equal(validateBindingCompletionProof(task, proof({
    timestamp: new Date(expiresAt.getTime() + 1)
  })), false);
});

test('rejects a proof copied from a different task snapshot', () => {
  assert.equal(validateBindingCompletionProof(task, proof({ wikidotUserId: 54321 })), false);
  assert.equal(validateBindingCompletionProof(task, proof({ verificationCode: 'SCPPER-XYZ789' })), false);
  assert.equal(validateBindingCompletionProof(task, proof({
    createdAt: new Date(createdAt.getTime() + 1)
  })), false);
  assert.equal(validateBindingCompletionProof(task, proof({
    expiresAt: new Date(expiresAt.getTime() + 1)
  })), false);
});

test('rejects malformed proof identity and timestamps', () => {
  assert.equal(validateBindingCompletionProof(task, proof({ revisionId: 0 })), false);
  assert.equal(validateBindingCompletionProof(task, proof({ revisionId: 1.5 })), false);
  assert.equal(validateBindingCompletionProof(task, proof({ verificationCode: ' SCPPER-ABC234 ' })), false);
  assert.equal(validateBindingCompletionProof(task, proof({ timestamp: new Date('invalid') })), false);
  const invertedTask = { ...task, createdAt: new Date(expiresAt.getTime() + 1) };
  assert.equal(validateBindingCompletionProof(invertedTask, {
    ...proof(),
    createdAt: invertedTask.createdAt
  }), false);
});

test('never revives an older actionable task behind a newer terminal task', () => {
  const oldExpired = {
    id: 'task-a',
    createdAt: new Date('2026-07-13T03:00:00.000Z'),
    status: 'EXPIRED' as const
  };
  const newCancelled = {
    id: 'task-b',
    createdAt: new Date('2026-07-13T04:00:00.000Z'),
    status: 'CANCELLED' as const
  };
  assert.equal(selectLatestActionableBindingTask([oldExpired, newCancelled]), null);

  const sameTimestamp = new Date('2026-07-13T05:00:00.000Z');
  assert.equal(selectLatestActionableBindingTask([
    { id: 'task-a', createdAt: sameTimestamp, status: 'PENDING' },
    { id: 'task-b', createdAt: sameTimestamp, status: 'CANCELLED' }
  ]), null);
});

test('only the absolute latest pending task can complete', () => {
  assert.equal(isCompletableLatestBindingTask('task-a', 'PENDING', 'task-b'), false);
  assert.equal(isCompletableLatestBindingTask('task-b', 'PENDING', 'task-b'), true);
  assert.equal(isCompletableLatestBindingTask('task-b', 'CANCELLED', 'task-b'), false);
});

test('binding routes reject legacy proof payloads and mark responses no-store', async () => {
  const previousInternalKey = process.env.INTERNAL_API_KEY;
  process.env.INTERNAL_API_KEY = 'wikidot-binding-test-key';

  const app = express();
  app.use(express.json());
  app.use('/wikidot-binding', wikidotBindingRouter());
  app.use('/internal/wikidot-binding', wikidotBindingInternalRouter());
  const server = app.listen(0, '127.0.0.1');

  try {
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const publicResponse = await fetch(`${baseUrl}/wikidot-binding/status`);
    assert.equal(publicResponse.status, 401);
    assert.equal(publicResponse.headers.get('cache-control'), 'no-store');

    const legacyCompleteResponse = await fetch(`${baseUrl}/internal/wikidot-binding/complete`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-internal-key': 'wikidot-binding-test-key'
      },
      body: JSON.stringify({
        taskId: 'legacy-task',
        revisionId: 9001,
        timestamp: '2026-07-13T03:01:00.000Z'
      })
    });
    assert.equal(legacyCompleteResponse.status, 400);
    assert.equal(legacyCompleteResponse.headers.get('cache-control'), 'no-store');
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    if (previousInternalKey === undefined) delete process.env.INTERNAL_API_KEY;
    else process.env.INTERNAL_API_KEY = previousInternalKey;
  }
});
