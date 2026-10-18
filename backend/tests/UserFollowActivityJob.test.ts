import assert from 'node:assert/strict';
import test from 'node:test';
import type { PrismaClient } from '@prisma/client';

// The job is always given a mock store; module initialization must never resolve
// a production database URL, even when this test is run outside the worktree.
process.env.DATABASE_URL = 'postgresql://unused:unused@127.0.0.1:1/never_connect';
const { UserFollowActivityJob } = await import('../src/jobs/UserFollowActivityJob.js');

type AlertType = 'ATTRIBUTION' | 'ATTRIBUTION_REMOVED';
type Attribution = { attributionId: number; pvId: number; userId: number };
type Alert = {
  id: number;
  followId: number;
  followerId: number;
  targetUserId: number;
  pageId: number;
  type: AlertType;
  attributionId: number;
  pageVersionId: number;
  detectedAt: Date;
  acknowledgedAt: Date | null;
  createdAt: Date;
};
type Sql = { text: string; values: unknown[] };

const oldDetectedAt = new Date('2026-01-02T00:00:00.000Z');
const readAt = new Date('2026-01-03T00:00:00.000Z');

class MockStore {
  alerts: Alert[] = [];
  currentPvId = 20;
  previousPvId: number | null = 10;
  attributions: Attribution[] = [
    { attributionId: 100, pvId: 20, userId: 42 },
    { attributionId: 101, pvId: 20, userId: 43 },
    { attributionId: 99, pvId: 10, userId: 43 }
  ];
  appliedWrites = 0;
  insertAttempts = 0;
  beforeInsert?: (candidate: Omit<Alert, 'id' | 'acknowledgedAt'>) => void;
  sql: string[] = [];

  seed(overrides: Partial<Alert> = {}): Alert {
    const row: Alert = {
      id: this.alerts.length + 1,
      followId: 5,
      followerId: 77,
      targetUserId: 42,
      pageId: 1,
      type: 'ATTRIBUTION',
      attributionId: 100,
      pageVersionId: 20,
      detectedAt: oldDetectedAt,
      acknowledgedAt: readAt,
      createdAt: oldDetectedAt,
      ...overrides
    };
    this.alerts.push(row);
    return row;
  }

  private async queryRaw(strings: TemplateStringsArray | Sql): Promise<unknown[]> {
    const text = 'text' in strings ? strings.text : strings.join('?');
    if (text.includes('FROM "Revision" r')) return [];
    if (text.includes('AS "previousPvId"')) {
      return [{ pvId: this.currentPvId, pageId: 1, previousPvId: this.previousPvId, pvValidFrom: new Date('2026-01-01T00:00:00.000Z') }];
    }
    if (text.includes('effective_attributions')) return this.attributions;
    if (text.includes('FROM "UserFollow" f')) {
      return [{ id: 5, followerId: 77, targetUserId: 42, createdAt: new Date('2025-01-01T00:00:00.000Z') }];
    }
    throw new Error(`Unexpected read query: ${text}`);
  }

  private async executeRaw(query: Sql): Promise<number> {
    const text = query.text.replace(/\s+/g, ' ').trim();
    this.sql.push(text);
    const typeMatch = text.match(/(?:SET type = |, )'(ATTRIBUTION(?:_REMOVED)?)'/);
    assert.ok(typeMatch, 'only attribution writes are expected');
    const type = typeMatch[1] as AlertType;
    const v = query.values;
    if (text.startsWith('UPDATE')) {
      // Model the actual predicates present in the SQL. Without either new guard,
      // the original unconditional UPDATE/UPSERT reopens the seeded read alert.
      const guarded = /AND \(type IS DISTINCT FROM '[A-Z_]+' OR "pageVersionId" IS DISTINCT FROM \$8\)/.test(text);
      const matches = this.alerts.filter(row => row.followId === v[5] && row.attributionId === v[6]
        && (!guarded || row.type !== type || row.pageVersionId !== v[7]));
      for (const row of matches) {
        Object.assign(row, { type, followerId: v[0], targetUserId: v[1], pageId: v[2], pageVersionId: v[3], detectedAt: v[4], acknowledgedAt: null });
      }
      this.appliedWrites += matches.length;
      return matches.length;
    }
    assert.ok(text.startsWith('INSERT INTO "UserActivityAlert"'));
    const candidate: Omit<Alert, 'id' | 'acknowledgedAt'> = {
      followId: Number(v[0]), followerId: Number(v[1]), targetUserId: Number(v[2]), pageId: Number(v[3]),
      type, attributionId: Number(v[4]), pageVersionId: Number(v[5]), detectedAt: v[6] as Date, createdAt: v[7] as Date
    };
    if (text.includes('WHERE NOT EXISTS ( SELECT 1 FROM "UserActivityAlert"')) {
      const existingEvent = this.alerts.some(row => row.followId === v[8] && row.type === type && row.pageVersionId === v[9] && row.attributionId === v[10]);
      if (existingEvent) return 0;
    }
    this.insertAttempts += 1;
    const beforeInsert = this.beforeInsert;
    this.beforeInsert = undefined;
    beforeInsert?.(candidate);
    const conflict = this.alerts.find(row => row.followId === candidate.followId && row.type === candidate.type && row.pageVersionId === candidate.pageVersionId);
    if (conflict) {
      const guarded = text.includes('WHERE "UserActivityAlert"."attributionId" IS DISTINCT FROM EXCLUDED."attributionId"');
      if (guarded && conflict.attributionId === candidate.attributionId) return 0;
      const { createdAt: _createdAt, ...changes } = candidate;
      Object.assign(conflict, changes, { acknowledgedAt: null });
    } else {
      this.seed({ ...candidate, acknowledgedAt: null });
    }
    this.appliedWrites += 1;
    return 1;
  }

  job(): InstanceType<typeof UserFollowActivityJob> {
    return new UserFollowActivityJob({
      $queryRaw: this.queryRaw.bind(this),
      $executeRaw: this.executeRaw.bind(this)
    } as unknown as PrismaClient);
  }

  removal() {
    this.attributions = [
      { attributionId: 100, pvId: 10, userId: 42 },
      { attributionId: 99, pvId: 10, userId: 43 },
      { attributionId: 101, pvId: 20, userId: 43 }
    ];
  }
}

for (const type of ['ATTRIBUTION', 'ATTRIBUTION_REMOVED'] as const) {
  for (const acknowledgedAt of [null, readAt]) {
    test(`unchanged ${type} preserves ${acknowledgedAt ? 'read' : 'unread'} state and timestamp across repeated scans`, async () => {
      const store = new MockStore();
      if (type === 'ATTRIBUTION_REMOVED') store.removal();
      const row = store.seed({ type, acknowledgedAt });
      const original = structuredClone(row);
      const job = store.job();
      await job.run([20]);
      await job.run([20]);
      assert.deepEqual(store.alerts, [original]);
      assert.equal(store.appliedWrites, 0);
      assert.equal(store.insertAttempts, 0);
    });
  }

  test(`new ${type} is created once and reading it survives the next scan`, async () => {
    const store = new MockStore();
    if (type === 'ATTRIBUTION_REMOVED') store.removal();
    const job = store.job();
    await job.run([20]);
    assert.equal(store.alerts.length, 1);
    assert.equal(store.alerts[0]!.type, type);
    assert.equal(store.alerts[0]!.acknowledgedAt, null);
    store.alerts[0]!.acknowledgedAt = readAt;
    const afterRead = structuredClone(store.alerts[0]);
    await job.run([20]);
    assert.deepEqual(store.alerts, [afterRead]);
    assert.equal(store.appliedWrites, 1);
  });

  test(`concurrent duplicate ${type} conflict preserves the winner's read state`, async () => {
    const store = new MockStore();
    if (type === 'ATTRIBUTION_REMOVED') store.removal();
    store.beforeInsert = candidate => store.seed({ ...candidate, detectedAt: oldDetectedAt, acknowledgedAt: readAt });
    await store.job().run([20]);
    assert.equal(store.alerts.length, 1);
    assert.equal(store.alerts[0]!.detectedAt, oldDetectedAt);
    assert.equal(store.alerts[0]!.acknowledgedAt, readAt);
    assert.equal(store.appliedWrites, 0);
  });
}

test('an addition changing to removal reopens once and repeated removal stays read', async () => {
  const store = new MockStore();
  store.removal();
  const row = store.seed({ type: 'ATTRIBUTION', pageVersionId: 10 });
  const job = store.job();
  await job.run([20]);
  assert.equal(row.type, 'ATTRIBUTION_REMOVED');
  assert.equal(row.pageVersionId, 20);
  assert.equal(row.acknowledgedAt, null);
  assert.notEqual(row.detectedAt, oldDetectedAt);
  row.acknowledgedAt = readAt;
  const changed = structuredClone(row);
  await job.run([20]);
  assert.deepEqual(row, changed);
  assert.equal(store.appliedWrites, 1);
});

test('a removal changing to addition reopens once', async () => {
  const store = new MockStore();
  const row = store.seed({ type: 'ATTRIBUTION_REMOVED' });
  await store.job().run([20]);
  assert.equal(row.type, 'ATTRIBUTION');
  assert.equal(row.acknowledgedAt, null);
  assert.equal(store.appliedWrites, 1);
});

test('the same attribution on a new page version produces a fresh notification', async () => {
  const store = new MockStore();
  const row = store.seed({ pageVersionId: 19 });
  await store.job().run([20]);
  assert.equal(row.pageVersionId, 20);
  assert.equal(row.acknowledgedAt, null);
  assert.equal(store.appliedWrites, 1);
});

for (const type of ['ATTRIBUTION', 'ATTRIBUTION_REMOVED'] as const) {
  test(`${type} conflict with a changed attribution produces a fresh notification`, async () => {
    const store = new MockStore();
    if (type === 'ATTRIBUTION_REMOVED') store.removal();
    const row = store.seed({ type, attributionId: 90 });
    await store.job().run([20]);
    assert.equal(row.attributionId, 100);
    assert.equal(row.acknowledgedAt, null);
    assert.notEqual(row.detectedAt, oldDetectedAt);
    assert.equal(store.appliedWrites, 1);
  });
}
