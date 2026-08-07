import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { after, before, describe, it, test } from 'node:test';

import {
  evaluatePendingCollection,
  pendingPolicyFor,
  type PendingCollection,
  type PendingPoint,
} from '../src/observability/oldestPending.js';
import {
  findMissingSqlTuningBindings,
  loadTypeScriptSources,
} from '../src/health/sqlTuningCheck.js';
import { classifyRevisionSourceFailure } from '../src/store/revisionSource.js';
import { openSess, PROJECT_ROOT, type Sess } from './helpers/pg.js';

function current(
  collection: string,
  observedAt: string,
  oldestItemAt: string,
  pendingCount: number,
  oldestItemKey: string,
  catchup = false,
): PendingCollection {
  return {
    collection,
    family: collection.startsWith('scan_task:') ? 'scan_task' : 'test',
    observedAt,
    oldestItemAt,
    pendingCount,
    oldestItemKey,
    catchup,
    evidence: {},
  };
}

function point(
  observedAt: string,
  oldestItemAt: string,
  pendingCount: number,
  oldestItemKey: string,
  catchup = false,
): PendingPoint {
  return { observedAt, oldestItemAt, pendingCount, oldestItemKey, catchup };
}

describe('oldest-pending 趋势判定', () => {
  it('某集合最老项持续变老时告警，并保留首次越线样本作为恶化起点', () => {
    const oldest = '2026-08-05T00:00:00.000Z';
    const history = [
      point('2026-08-05T07:00:00.000Z', oldest, 3, 'task-1'),
      point('2026-08-05T08:00:00.000Z', oldest, 3, 'task-1'),
    ];
    const decision = evaluatePendingCollection(
      current('scan_task:content', '2026-08-05T09:00:00.000Z', oldest, 3, 'task-1'),
      history,
    );
    assert.equal(decision.severity, 'warn');
    assert.equal(decision.worseningStartedAt, '2026-08-05T07:00:00.000Z');
    assert.equal(decision.decision, 'age_threshold_exceeded');
  });

  it('已知一次性追平大量稳定下降，即使短窗内头部未换也不误报', () => {
    const oldest = '2026-07-28T00:00:00.000Z';
    const history = [
      point('2026-08-05T10:00:00.000Z', oldest, 30_000, 'task-a', true),
      point('2026-08-05T10:10:00.000Z', oldest, 29_000, 'task-a', true),
      point('2026-08-05T10:20:00.000Z', oldest, 28_000, 'task-a', true),
    ];
    const decision = evaluatePendingCollection(
      current(
        'scan_task:votes_full',
        '2026-08-05T10:30:00.000Z',
        oldest,
        27_000,
        'task-a',
        true,
      ),
      history,
    );
    assert.equal(decision.severity, 'ok');
    assert.equal(decision.decision, 'catchup_progressing');
  });

  it('论坛 catchup 看下降趋势、steady 看年龄，二者告警策略不混用', () => {
    const catchup = pendingPolicyFor(
      'forum_scan_task:catchup:thread',
      'forum_scan_task_catchup',
    );
    const steady = pendingPolicyFor(
      'forum_scan_task:steady:thread',
      'forum_scan_task_steady',
    );
    assert.ok(catchup.warnAfterSeconds > steady.warnAfterSeconds);
    const decision = evaluatePendingCollection(
      current(
        'forum_scan_task:catchup:thread',
        '2026-08-07T10:30:00.000Z',
        '2026-07-28T00:00:00.000Z',
        87_000,
        'thread-1',
        true,
      ),
      [
        point('2026-08-07T10:00:00.000Z', '2026-07-28T00:00:00.000Z', 88_000, 'thread-1', true),
        point('2026-08-07T10:15:00.000Z', '2026-07-28T00:00:00.000Z', 87_500, 'thread-1', true),
      ],
    );
    assert.equal(decision.decision, 'catchup_progressing');
    assert.equal(decision.severity, 'ok');
  });

  it('集合仅 1 项但长期不动也立即告警，不要求深度或失败率分母', () => {
    const decision = evaluatePendingCollection(
      current(
        'scan_task:attributions',
        '2026-08-06T00:00:00.000Z',
        '2026-07-29T02:00:00.000Z',
        1,
        'only-task',
      ),
      [],
    );
    assert.equal(decision.severity, 'critical');
    assert.equal(decision.worseningStartedAt, '2026-08-06T00:00:00.000Z');
  });

  it('追平头部跨严重窗口不换仍告警，数量持续下降不能永久掩盖饿死项', () => {
    const oldest = '2026-07-28T00:00:00.000Z';
    const history = [
      point('2026-08-04T10:00:00.000Z', oldest, 30_000, 'stuck', true),
      point('2026-08-05T10:10:00.000Z', oldest, 29_000, 'stuck', true),
    ];
    const decision = evaluatePendingCollection(
      current(
        'scan_task:votes_full',
        '2026-08-05T10:40:00.000Z',
        oldest,
        28_000,
        'stuck',
        true,
      ),
      history,
    );
    assert.equal(decision.severity, 'critical');
    assert.equal(decision.worseningStartedAt, '2026-08-04T10:00:00.000Z');
    assert.equal(decision.decision, 'catchup_head_stalled');
  });
});

test('SQL 装饰品常量：真实绑定通过，故意移除一个常量的全部 SQL 参数绑定后失败', async () => {
  const sources = await loadTypeScriptSources(path.join(PROJECT_ROOT, 'src'));
  assert.deepEqual(findMissingSqlTuningBindings(sources), []);

  const broken = sources.map((source) => ({
    ...source,
    source: source.source.replaceAll(
      "bindSqlTuning('VOTE_SWEEP_INTERVAL_DAYS'",
      "untrackedSqlTuning('VOTE_SWEEP_INTERVAL_DAYS'",
    ),
  }));
  assert.deepEqual(findMissingSqlTuningBindings(broken), ['VOTE_SWEEP_INTERVAL_DAYS']);
});

test('revision_source 只把确定性目标错误终结；5xx/链路错误可恢复', () => {
  assert.equal(classifyRevisionSourceFailure('status=no_permission'), 'deterministic');
  assert.equal(classifyRevisionSourceFailure('status=revision_error'), 'deterministic');
  assert.equal(classifyRevisionSourceFailure('HttpStatusError: HTTP 503'), 'transient');
  assert.equal(classifyRevisionSourceFailure('TransportError: ECONNRESET'), 'transient');
  assert.equal(classifyRevisionSourceFailure('CircuitOpenError: egress circuit open'), 'transient');
});

interface IrreconcilableState {
  rows: string;
  revision_source_rows: string;
  mixed_kind_rows: string;
  fingerprint: string;
}

async function irreconcilableState(db: Sess): Promise<IrreconcilableState> {
  return db.one<IrreconcilableState>(
    'irreconcilable-state',
    `SELECT count(*)::text AS rows,
            count(*) FILTER (WHERE kind='revision_source')::text AS revision_source_rows,
            count(*) FILTER (WHERE kind LIKE '%:%')::text AS mixed_kind_rows,
            md5(COALESCE(string_agg(
              concat_ws('|', id, page_id, kind, COALESCE(instance_id, -1),
                        local_value::text, remote_value::text),
              E'\\n' ORDER BY id
            ), '')) AS fingerprint
       FROM meta.irreconcilable`,
  );
}

test('0039 kind/instance 存量迁移连续重跑不丢行且不再产生混合 kind', async () => {
  const migration = (await readFile(
    path.join(PROJECT_ROOT, 'migrations', '0039_irreconcilable_kind_instance.sql'),
    'utf8',
  )).replace(/^\\set .*$/gm, '');
  const migrationDb = await openSess('observability-migration-idempotence');
  try {
    const before = await irreconcilableState(migrationDb);
    await migrationDb.q('migration-first', migration);
    const afterFirst = await irreconcilableState(migrationDb);
    await migrationDb.q('migration-second', migration);
    const afterSecond = await irreconcilableState(migrationDb);
    assert.deepEqual(afterFirst, before);
    assert.deepEqual(afterSecond, afterFirst);
    assert.equal(afterSecond.mixed_kind_rows, '0');
  } finally {
    await migrationDb.end();
  }
});

describe('irreconcilable kind/instance 数据库约束', () => {
  let db: Sess;
  const page = 989_390_001;

  before(async () => {
    db = await openSess('observability-kind-instance');
    await db.begin();
  });

  after(async () => {
    await db?.rollback().catch(() => undefined);
    await db?.end();
  });

  it('固定 kind 与 revision_source 实例可并存，且唯一性幂等', async () => {
    await db.q(
      'insert-fixed-kind',
      `INSERT INTO meta.irreconcilable(page_id,kind,local_value,remote_value)
       VALUES ($1,'content','{}','{}')`,
      [page],
    );
    await db.q(
      'insert-two-instances',
      `INSERT INTO meta.irreconcilable(page_id,kind,instance_id,local_value,remote_value)
       VALUES ($1,'revision_source',101,'{}','{}'),
              ($1,'revision_source',102,'{}','{}')`,
      [page],
    );
    const duplicate = await db.expectError(
      'duplicate-instance',
      `INSERT INTO meta.irreconcilable(page_id,kind,instance_id,local_value,remote_value)
       VALUES ($1,'revision_source',101,'{}','{}')`,
      [page],
      true,
    );
    assert.equal(duplicate.sqlstate, '23505');
  });

  it('kind 再混入实例 id 或实例列错配都会被 CHECK 拒绝', async () => {
    const mixed = await db.expectError(
      'mixed-kind',
      `INSERT INTO meta.irreconcilable(page_id,kind,local_value,remote_value)
       VALUES ($1,'revision_source:101','{}','{}')`,
      [page + 1],
      true,
    );
    assert.equal(mixed.sqlstate, '23514');

    const missingInstance = await db.expectError(
      'missing-instance',
      `INSERT INTO meta.irreconcilable(page_id,kind,local_value,remote_value)
       VALUES ($1,'revision_source','{}','{}')`,
      [page + 2],
      true,
    );
    assert.equal(missingInstance.sqlstate, '23514');
  });

  it('活库不存在带冒号 kind，且固定枚举约束已生效', async () => {
    assert.equal(
      await db.num('no-mixed-kind', `SELECT count(*) FROM meta.irreconcilable WHERE kind LIKE '%:%'`),
      0,
    );
    const definition = await db.val<string>(
      'kind-constraint',
      `SELECT pg_get_constraintdef(oid)
         FROM pg_constraint
        WHERE conrelid='meta.irreconcilable'::regclass
          AND conname='irreconcilable_kind_ck'`,
    );
    assert.match(definition, /revision_source/);
  });
});
