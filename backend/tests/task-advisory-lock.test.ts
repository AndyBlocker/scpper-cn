import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import {
  createTaskAdvisoryLockClient,
  withTaskAdvisoryLock,
  type TaskAdvisoryLockClient
} from '../src/utils/task-advisory-lock.js';

test('requires an explicit DATABASE_URL instead of falling back to another PostgreSQL database', () => {
  const original = process.env.DATABASE_URL;
  try {
    for (const value of [undefined, '', '   ']) {
      if (value === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = value;
      assert.throws(() => createTaskAdvisoryLockClient(), /DATABASE_URL.*required/);
    }
  } finally {
    if (original === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = original;
  }
});

class FakeLockClient extends EventEmitter {
  connected = false;
  ended = false;
  queries: Array<{ sql: string; values: string[] }> = [];
  connectError?: Error;
  acquireError?: Error;
  releaseError?: Error;
  endError?: Error;
  releaseResult = true;

  constructor(private readonly owners = new Map<string, FakeLockClient>()) {
    super();
  }

  async connect() {
    if (this.connectError) throw this.connectError;
    this.connected = true;
  }

  async query(sql: string, values: string[]) {
    assert.equal(this.connected, true);
    assert.equal(this.ended, false);
    this.queries.push({ sql, values });
    const key = values[0]!;
    if (sql.includes('pg_try_advisory_lock')) {
      if (this.acquireError) throw this.acquireError;
      const locked = !this.owners.has(key) || this.owners.get(key) === this;
      if (locked) this.owners.set(key, this);
      return { rows: [{ locked }] };
    }
    if (this.releaseError) throw this.releaseError;
    const unlocked = this.releaseResult && this.owners.get(key) === this;
    if (unlocked) this.owners.delete(key);
    return { rows: [{ unlocked }] };
  }

  async end() {
    this.ended = true;
    for (const [key, owner] of this.owners) {
      if (owner === this) this.owners.delete(key);
    }
    this.emit('end');
    if (this.endError) throw this.endError;
  }

  asClient(): TaskAdvisoryLockClient {
    return this as unknown as TaskAdvisoryLockClient;
  }
}

test('holds one session through the task and watermark; a competing session skips and closes', async () => {
  const owners = new Map<string, FakeLockClient>();
  const first = new FakeLockClient(owners);
  const competing = new FakeLockClient(owners);
  const events: string[] = [];
  const taskName = "page_stats'; SELECT 1; --";

  await withTaskAdvisoryLock(taskName, async (assertLockHeld) => {
    assert.equal(owners.get(taskName), first);
    events.push('changes');
    await withTaskAdvisoryLock(taskName, async () => {
      events.push('competing-task');
    }, () => competing.asClient());
    assert.equal(competing.ended, true);
    assert.equal(owners.get(taskName), first);
    assertLockHeld();
    events.push('task', 'watermark');
    assert.equal(first.ended, false);
  }, () => first.asClient());

  assert.deepEqual(events, ['changes', 'task', 'watermark']);
  assert.deepEqual(first.queries, [
    { sql: 'SELECT pg_try_advisory_lock(hashtext($1)) AS locked', values: [taskName] },
    { sql: 'SELECT pg_advisory_unlock(hashtext($1)) AS unlocked', values: [taskName] }
  ]);
  assert.equal(competing.queries.length, 1);
  assert.equal(first.ended, true);
  assert.equal(owners.size, 0);
});

test('an early task return still unlocks and closes its session', async () => {
  const client = new FakeLockClient();
  await withTaskAdvisoryLock('no_changes', async () => {}, () => client.asClient());
  assert.equal(client.queries.length, 2);
  assert.equal(client.ended, true);
});

test('preserves the original task error while releasing its lock', async () => {
  const client = new FakeLockClient();
  const taskError = new Error('analysis failed');
  await assert.rejects(
    withTaskAdvisoryLock('task_error', async () => { throw taskError; }, () => client.asClient()),
    (error) => error === taskError
  );
  assert.equal(client.queries.length, 2);
  assert.equal(client.ended, true);
});

for (const stage of ['connect', 'acquire'] as const) {
  test(`${stage} failure never starts the task and always closes the client`, async () => {
    const client = new FakeLockClient();
    const failure = new Error(`${stage} failed`);
    if (stage === 'connect') client.connectError = failure;
    else client.acquireError = failure;
    let ran = false;
    await assert.rejects(
      withTaskAdvisoryLock('unavailable', async () => { ran = true; }, () => client.asClient()),
      (error) => error === failure
    );
    assert.equal(ran, false);
    assert.equal(client.ended, true);
    assert.equal(client.queries.length, stage === 'connect' ? 0 : 1);
  });
}

test('a false unlock result is a failure and the connection is still closed', async () => {
  const client = new FakeLockClient();
  client.releaseResult = false;
  await assert.rejects(
    withTaskAdvisoryLock('bad_unlock', async () => {}, () => client.asClient()),
    /pg_advisory_unlock returned false/
  );
  assert.equal(client.ended, true);
});

test('cleanup failures retain the task error as the primary cause', async () => {
  const client = new FakeLockClient();
  const taskError = new Error('task failed');
  client.releaseError = new Error('unlock failed');
  client.endError = new Error('close failed');
  await assert.rejects(
    withTaskAdvisoryLock('all_errors', async () => { throw taskError; }, () => client.asClient()),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.cause, taskError);
      assert.deepEqual(error.errors, [taskError, client.releaseError, client.endError]);
      return true;
    }
  );
  assert.equal(client.ended, true);
});

test('a close error is surfaced even after a successful task and unlock', async () => {
  const client = new FakeLockClient();
  client.endError = new Error('close failed');
  await assert.rejects(
    withTaskAdvisoryLock('close_error', async () => {}, () => client.asClient()),
    (error) => error === client.endError
  );
});

for (const event of ['error', 'end'] as const) {
  test(`unexpected session ${event} prevents the next task phase and reports failure`, async () => {
    const client = new FakeLockClient();
    let watermarkUpdated = false;
    await assert.rejects(
      withTaskAdvisoryLock('lost_session', async (assertLockHeld) => {
        client.emit(event, new Error('network lost'));
        assertLockHeld();
        watermarkUpdated = true;
      }, () => client.asClient()),
      /Advisory lock connection lost/
    );
    assert.equal(watermarkUpdated, false);
    assert.equal(client.queries.length, 1);
    assert.equal(client.ended, true);
  });
}

test('lock loss waits for an in-flight task to settle instead of pretending to cancel it', async () => {
  const client = new FakeLockClient();
  let finishTask!: () => void;
  const inFlight = new Promise<void>((resolve) => { finishTask = resolve; });
  let started!: () => void;
  const taskStarted = new Promise<void>((resolve) => { started = resolve; });
  let settled = false;
  const result = withTaskAdvisoryLock('in_flight', async () => {
    client.emit('error', new Error('connection lost'));
    started();
    await inFlight;
  }, () => client.asClient()).finally(() => { settled = true; });

  await taskStarted;
  await new Promise<void>((resolve) => { setImmediate(resolve); });
  assert.equal(settled, false);
  assert.equal(client.ended, false);
  finishTask();
  await assert.rejects(result, /Advisory lock connection lost/);
  assert.equal(client.ended, true);
});
