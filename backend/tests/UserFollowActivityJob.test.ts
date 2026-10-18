import assert from 'node:assert/strict';
import test from 'node:test';
import { Prisma, type PrismaClient } from '@prisma/client';
import { Client } from 'pg';

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
type VersionPair = { pvId: number; pageId: number; previousPvId: number | null; pvValidFrom: Date };

const oldDetectedAt = new Date('2026-01-02T00:00:00.000Z');
const readAt = new Date('2026-01-03T00:00:00.000Z');

class MockStore {
  alerts: Alert[] = [];
  currentPvId = 20;
  previousPvId: number | null = 10;
  pairs?: VersionPair[];
  versionDates = new Map([
    [10, new Date('2026-01-01')], [19, new Date('2026-01-01T12:00:00Z')],
    [20, new Date('2026-01-02')], [30, new Date('2026-01-03')], [90, new Date('2026-01-09')]
  ]);
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
      return this.pairs ?? [{ pvId: this.currentPvId, pageId: 1, previousPvId: this.previousPvId, pvValidFrom: this.versionDates.get(this.currentPvId) ?? new Date('2026-01-01') }];
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
    const v = query.values;
    if (text.startsWith('INSERT') && typeof v[4] === 'string') {
      const candidate: Omit<Alert, 'id' | 'acknowledgedAt'> = {
        followId: Number(v[0]), followerId: Number(v[1]), targetUserId: Number(v[2]), pageId: Number(v[3]),
        type: v[4] as AlertType, attributionId: Number(v[5]), pageVersionId: Number(v[6]), detectedAt: v[7] as Date, createdAt: v[8] as Date
      };
      const tupleGuard = text.includes('(existing_pv."validFrom", existing_pv.id) > (incoming_pv."validFrom", incoming_pv.id)');
      const guardsNewer = tupleGuard || text.includes('existing."pageVersionId" > $12');
      const guardsSame = tupleGuard
        ? text.includes('existing."pageVersionId" = incoming_pv.id AND existing.type = $13')
        : text.includes('existing."pageVersionId" = $13 AND existing.type = $14');
      const incomingId = Number(tupleGuard ? v[9] : v[11]);
      const dateFor = (id: number) => this.pairs?.find(pair => pair.pvId === id)?.pvValidFrom ?? this.versionDates.get(id) ?? new Date(0);
      const isNewer = (id: number) => tupleGuard
        ? dateFor(id).getTime() > dateFor(incomingId).getTime() || (dateFor(id).getTime() === dateFor(incomingId).getTime() && id > incomingId)
        : id > incomingId;
      const knownEvent = this.alerts.some(row => row.followId === (tupleGuard ? v[10] : v[9]) && row.pageId === (tupleGuard ? v[11] : v[10])
        && ((guardsNewer && isNewer(row.pageVersionId))
          || (guardsSame && row.pageVersionId === incomingId && row.type === (tupleGuard ? v[12] : v[13]))));
      if (knownEvent) return 0;
      this.insertAttempts += 1;
      const beforeInsert = this.beforeInsert;
      this.beforeInsert = undefined;
      beforeInsert?.(candidate);
      const conflict = this.alerts.find(row => row.followId === candidate.followId && row.type === candidate.type && row.pageVersionId === candidate.pageVersionId);
      if (conflict && text.endsWith('DO NOTHING')) return 0;
      assert.equal(conflict, undefined, 'unexpected conflict without DO NOTHING');
      this.seed({ ...candidate, acknowledgedAt: null });
      this.appliedWrites += 1;
      return 1;
    }
    // Preserve the old SQL model so the same regression suite can also run
    // against the original job and the first incomplete patch.
    const typeMatch = text.match(/(?:SET type = |, )'(ATTRIBUTION(?:_REMOVED)?)'/);
    assert.ok(typeMatch, 'only attribution writes are expected');
    const type = typeMatch[1] as AlertType;
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

test('a real removal appends a new unread event and preserves the read addition', async () => {
  const store = new MockStore();
  store.removal();
  const row = store.seed({ type: 'ATTRIBUTION', pageVersionId: 10 });
  const original = structuredClone(row);
  const job = store.job();
  await job.run([20]);
  assert.deepEqual(row, original);
  assert.equal(store.alerts.length, 2);
  const removal = store.alerts[1]!;
  assert.equal(removal.type, 'ATTRIBUTION_REMOVED');
  assert.equal(removal.pageVersionId, 20);
  assert.equal(removal.acknowledgedAt, null);
  removal.acknowledgedAt = readAt;
  const changed = structuredClone(store.alerts);
  await job.run([20]);
  assert.deepEqual(store.alerts, changed);
  assert.equal(store.appliedWrites, 1);
});

test('a distinct addition event preserves the read removal', async () => {
  const store = new MockStore();
  const row = store.seed({ type: 'ATTRIBUTION_REMOVED' });
  const original = structuredClone(row);
  await store.job().run([20]);
  assert.deepEqual(row, original);
  assert.equal(store.alerts[1]!.type, 'ATTRIBUTION');
  assert.equal(store.alerts[1]!.acknowledgedAt, null);
  assert.equal(store.appliedWrites, 1);
});

test('the same attribution on a new page version produces a fresh notification', async () => {
  const store = new MockStore();
  const row = store.seed({ pageVersionId: 19 });
  const original = structuredClone(row);
  await store.job().run([20]);
  assert.deepEqual(row, original);
  assert.equal(store.alerts[1]!.pageVersionId, 20);
  assert.equal(store.alerts[1]!.acknowledgedAt, null);
  assert.equal(store.appliedWrites, 1);
});

for (const type of ['ATTRIBUTION', 'ATTRIBUTION_REMOVED'] as const) {
  test(`${type} keeps its read state when only the referenced role row is replaced`, async () => {
    const store = new MockStore();
    if (type === 'ATTRIBUTION_REMOVED') store.removal();
    const row = store.seed({ type, attributionId: 90 });
    const original = structuredClone(row);
    await store.job().run([20]);
    assert.deepEqual(store.alerts, [original]);
    assert.equal(store.appliedWrites, 0);
    assert.equal(store.insertAttempts, 0);
  });
}

for (const reverse of [false, true]) {
  test(`multiple roles choose the minimum attribution id in ${reverse ? 'reverse' : 'forward'} query order and stay read when order changes`, async () => {
    const store = new MockStore();
    store.attributions.push({ attributionId: 200, pvId: 20, userId: 42 });
    if (reverse) store.attributions.reverse();
    const job = store.job();
    await job.run([20]);
    assert.equal(store.alerts[0]!.attributionId, 100);
    store.alerts[0]!.acknowledgedAt = readAt;
    const original = structuredClone(store.alerts);
    store.attributions.reverse();
    await job.run([20]);
    assert.deepEqual(store.alerts, original);
    assert.equal(store.appliedWrites, 1);
  });
}

function addedThenRemovedBatch(store: MockStore) {
  store.removal();
  store.pairs = [
    { pvId: 20, pageId: 1, previousPvId: 10, pvValidFrom: new Date('2026-01-02') },
    { pvId: 10, pageId: 1, previousPvId: null, pvValidFrom: new Date('2026-01-01') }
  ];
}

test('a fresh mixed-version batch only announces its latest state and stays read on replay', async () => {
  const store = new MockStore();
  addedThenRemovedBatch(store);
  const job = store.job();
  await job.run([20, 10]);
  assert.deepEqual(store.alerts.map(row => [row.type, row.pageVersionId]), [['ATTRIBUTION_REMOVED', 20]]);
  for (const row of store.alerts) row.acknowledgedAt = readAt;
  const original = structuredClone(store.alerts);
  await job.run([20, 10]);
  assert.deepEqual(store.alerts, original);
  assert.equal(store.appliedWrites, 1);
});

for (const attributionId of [100, 90]) {
  test(`an older addition cannot be reinserted after a newer read removal with attribution ${attributionId}`, async () => {
    const store = new MockStore();
    addedThenRemovedBatch(store);
    store.pairs = store.pairs!.filter(pair => pair.pvId === 10);
    const row = store.seed({ type: 'ATTRIBUTION_REMOVED', pageVersionId: 20, attributionId });
    const original = structuredClone(row);
    await store.job().run([10]);
    assert.deepEqual(store.alerts, [original]);
    assert.equal(store.appliedWrites, 0);
    assert.equal(store.insertAttempts, 0);
  });
}

test('a genuine later addition still notifies after a read removal', async () => {
  const store = new MockStore();
  store.currentPvId = 30;
  store.previousPvId = 20;
  store.attributions = [{ attributionId: 300, pvId: 30, userId: 42 }];
  const original = structuredClone(store.seed({ type: 'ATTRIBUTION_REMOVED', pageVersionId: 20 }));
  await store.job().run([30]);
  assert.deepEqual(store.alerts[0], original);
  assert.equal(store.alerts[1]!.type, 'ATTRIBUTION');
  assert.equal(store.alerts[1]!.pageVersionId, 30);
  assert.equal(store.alerts[1]!.acknowledgedAt, null);
});

test('a newer attribution event on another page does not suppress this page', async () => {
  const store = new MockStore();
  const original = structuredClone(store.seed({ pageId: 2, pageVersionId: 90 }));
  await store.job().run([20]);
  assert.deepEqual(store.alerts[0], original);
  assert.equal(store.alerts[1]!.pageId, 1);
  assert.equal(store.alerts[1]!.acknowledgedAt, null);
});

const testDatabaseUrl = process.env.COAUTH_TEST_DATABASE_URL;
async function withTestDatabase(run: (client: Client, job: InstanceType<typeof UserFollowActivityJob>) => Promise<void>) {
  const parsed = new URL(testDatabaseUrl!);
  assert.ok(parsed.searchParams.get('host')?.startsWith('/tmp/scpper-coauth-test-'), 'requires a dedicated task Unix socket');
  const client = new Client({ connectionString: testDatabaseUrl, connectionTimeoutMillis: 5000, query_timeout: 10000 });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query(`
      CREATE TEMP TABLE "PageVersion" (id int PRIMARY KEY, "pageId" int, "validFrom" timestamp);
      CREATE TEMP TABLE "Attribution" (id int PRIMARY KEY, "pageVerId" int, "userId" int, type text);
      CREATE TEMP TABLE "Revision" (id int, "pageVersionId" int, "userId" int, timestamp timestamp);
      CREATE TEMP TABLE "UserFollow" (id int, "followerId" int, "targetUserId" int, "createdAt" timestamp);
      CREATE TEMP TABLE "UserActivityAlert" (
        id serial PRIMARY KEY, "followId" int, "followerId" int, "targetUserId" int, "pageId" int,
        type text, "attributionId" int, "pageVersionId" int, "revisionId" int,
        "detectedAt" timestamp, "acknowledgedAt" timestamp, "createdAt" timestamp
      );
      CREATE UNIQUE INDEX ON "UserActivityAlert" ("followId", type, "pageVersionId") WHERE "pageVersionId" IS NOT NULL;
    `);
    const prisma = {
      $queryRaw: async (input: TemplateStringsArray | Sql, ...values: unknown[]) => {
        const sql = Array.isArray(input) ? Prisma.sql(input as TemplateStringsArray, ...values) : input as Sql;
        return (await client.query(sql.text, sql.values)).rows;
      },
      $executeRaw: async (sql: Sql) => (await client.query(sql.text, sql.values)).rowCount ?? 0
    } as unknown as PrismaClient;
    await run(client, new UserFollowActivityJob(prisma));
    await client.query('ROLLBACK');
  } finally {
    await client.end();
  }
}

test('PostgreSQL executes the real job SQL for replay, role replacement and later events', { skip: !testDatabaseUrl }, async () => {
  await withTestDatabase(async (client, job) => {
    await client.query(`
      INSERT INTO "PageVersion" VALUES (10, 1, '2026-01-01'), (20, 1, '2026-01-02'), (30, 1, '2026-01-03'), (40, 1, '2026-01-04');
      INSERT INTO "Attribution" VALUES (100, 10, 42, 'AUTHOR'), (101, 10, 42, 'TRANSLATOR'), (102, 10, 43, 'AUTHOR'), (200, 20, 43, 'AUTHOR'), (300, 30, 42, 'AUTHOR'), (301, 30, 42, 'TRANSLATOR'), (400, 40, 43, 'AUTHOR');
      INSERT INTO "UserFollow" VALUES (5, 77, 42, '2025-01-01');
    `);
    const rows = async () => (await client.query('SELECT * FROM "UserActivityAlert" ORDER BY id')).rows;

    await job.run([20, 10]);
    assert.deepEqual((await rows()).map(row => [row.type, row.pageVersionId, row.attributionId]), [['ATTRIBUTION_REMOVED', 20, 100]]);
    await client.query('UPDATE "UserActivityAlert" SET "acknowledgedAt" = $1', [readAt]);
    const readHistory = await rows();
    const sequenceBeforeReplay = (await client.query('SELECT last_value FROM "UserActivityAlert_id_seq"')).rows;
    await job.run([20, 10]);
    await job.run([10]);
    assert.deepEqual(await rows(), readHistory);
    assert.deepEqual((await client.query('SELECT last_value FROM "UserActivityAlert_id_seq"')).rows, sequenceBeforeReplay);

    await job.run([30]);
    assert.equal((await rows()).length, 2);
    assert.equal((await rows())[1]!.acknowledgedAt, null);
    await client.query('UPDATE "UserActivityAlert" SET "acknowledgedAt" = $1', [readAt]);
    const beforeReplacement = await rows();
    await client.query('DELETE FROM "Attribution" WHERE "pageVerId" = 30');
    await client.query("INSERT INTO \"Attribution\" VALUES (310, 30, 42, 'AUTHOR'), (311, 30, 42, 'TRANSLATOR')");
    await job.run([30]);
    assert.deepEqual(await rows(), beforeReplacement);

    await job.run([40]);
    const finalRows = await rows();
    assert.equal(finalRows.length, 3);
    assert.equal(finalRows[2]!.type, 'ATTRIBUTION_REMOVED');
    assert.equal(finalRows[2]!.pageVersionId, 40);
    assert.equal(finalRows[2]!.acknowledgedAt, null);
    assert.deepEqual(finalRows.slice(0, 2), beforeReplacement);
  });
});

test('PostgreSQL orders imported versions by validFrom then id and compresses late history', { skip: !testDatabaseUrl }, async () => {
  await withTestDatabase(async (client, job) => {
    await client.query(`
      INSERT INTO "PageVersion" VALUES (10, 1, '2026-01-01'), (20, 1, '2026-01-03'), (30, 1, '2026-01-02'), (40, 1, '2026-01-03'), (50, 1, '2026-01-04');
      INSERT INTO "Attribution" VALUES (100, 10, 43, 'AUTHOR'), (200, 20, 43, 'AUTHOR'), (300, 30, 42, 'AUTHOR'), (301, 30, 43, 'AUTHOR'), (400, 40, 42, 'AUTHOR'), (401, 40, 43, 'AUTHOR'), (500, 50, 43, 'AUTHOR');
      INSERT INTO "UserFollow" VALUES (5, 77, 42, '2025-01-01');
    `);
    const rows = async () => (await client.query('SELECT * FROM "UserActivityAlert" ORDER BY id')).rows;

    // The higher id is an older ADD; the Jan 3 REMOVE is the latest state.
    // Its predecessor must be Jan 2/PV30, not the smaller-id Jan 1/PV10.
    await job.run([30, 20]);
    assert.deepEqual((await rows()).map(row => [row.type, row.pageVersionId, row.attributionId]), [['ATTRIBUTION_REMOVED', 20, 300]]);
    await client.query('UPDATE "UserActivityAlert" SET "acknowledgedAt" = $1', [readAt]);
    const firstReadHistory = await rows();
    await job.run([30, 20]);
    await job.run([30]);
    assert.deepEqual(await rows(), firstReadHistory);

    // Equal timestamps use id as the tiebreaker, so PV40 is newer than PV20.
    await job.run([40]);
    assert.deepEqual((await rows()).map(row => [row.type, row.pageVersionId]), [['ATTRIBUTION_REMOVED', 20], ['ATTRIBUTION', 40]]);
    await client.query('UPDATE "UserActivityAlert" SET "acknowledgedAt" = $1', [readAt]);
    const beforeLateHistory = await rows();
    const sequenceBefore = (await client.query('SELECT last_value FROM "UserActivityAlert_id_seq"')).rows;

    // Import a same-time lower-id ADD and a higher-id but older REMOVE.
    // Both are historical states and must neither notify nor rewrite history.
    await client.query(`
      INSERT INTO "PageVersion" VALUES (35, 1, '2026-01-03'), (60, 1, '2026-01-02 12:00:00');
      INSERT INTO "Attribution" VALUES (350, 35, 42, 'AUTHOR'), (351, 35, 43, 'AUTHOR'), (600, 60, 43, 'AUTHOR');
    `);
    await job.run([35]);
    await job.run([60]);
    assert.deepEqual(await rows(), beforeLateHistory);
    assert.deepEqual((await client.query('SELECT last_value FROM "UserActivityAlert_id_seq"')).rows, sequenceBefore);

    // A genuine later REMOVE and subsequent ADD each append a fresh unread row.
    await job.run([50]);
    assert.equal((await rows())[2]!.type, 'ATTRIBUTION_REMOVED');
    assert.equal((await rows())[2]!.pageVersionId, 50);
    assert.equal((await rows())[2]!.acknowledgedAt, null);
    assert.deepEqual((await rows()).slice(0, 2), beforeLateHistory);
    await client.query('UPDATE "UserActivityAlert" SET "acknowledgedAt" = $1', [readAt]);
    const beforeNewAddition = await rows();
    await client.query(`
      INSERT INTO "PageVersion" VALUES (70, 1, '2026-01-05');
      INSERT INTO "Attribution" VALUES (700, 70, 42, 'AUTHOR');
    `);
    await job.run([70]);
    const finalRows = await rows();
    assert.equal(finalRows.length, 4);
    assert.equal(finalRows[3]!.type, 'ATTRIBUTION');
    assert.equal(finalRows[3]!.pageVersionId, 70);
    assert.equal(finalRows[3]!.acknowledgedAt, null);
    assert.deepEqual(finalRows.slice(0, 3), beforeNewAddition);
  });
});
