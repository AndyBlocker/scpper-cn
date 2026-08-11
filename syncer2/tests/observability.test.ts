import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { after, before, describe, it, test } from 'node:test';

import {
  evaluatePipelineSuccess,
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
import { createRun } from './helpers/fixture.js';
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
  it('分链路 100 次扫描 0 成功立即 critical；0 次任务明确不报警', () => {
    assert.deepEqual(evaluatePipelineSuccess({ scans: 100, successes: 0 }), {
      severity: 'critical',
      decision: 'rolling_zero_success',
      successRate: 0,
    });
    assert.deepEqual(evaluatePipelineSuccess({ scans: 0, successes: 0 }), {
      severity: 'ok',
      decision: 'no_tasks',
      successRate: null,
    });
    assert.deepEqual(
      evaluatePipelineSuccess({ scans: 100, intermediates: 100, successes: 0 }),
      {
        severity: 'ok',
        decision: 'intermediate_only',
        successRate: null,
      },
      '全是 claim_only 时这次没有测到成功或失败，不能判 critical',
    );

    const decision = evaluatePendingCollection({
      collection: 'page_scan_success:forum',
      family: 'page_scan_zero_success',
      observedAt: '2026-08-11T05:00:00.000Z',
      pendingCount: 100,
      oldestItemAt: '2026-08-11T04:30:00.000Z',
      oldestItemKey: 'forum',
      catchup: false,
      evidence: { scans: 100, successes: 0, critical_min_scans: 10 },
    }, []);
    assert.equal(decision.severity, 'critical');
    assert.equal(decision.decision, 'rolling_zero_success');
  });
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

test('0054 活库视图分账 claim_only；全真失败仍 critical，0 次任务仍 no_tasks', async () => {
  const db = await openSess('pipeline-kind-health');
  await db.begin();
  try {
    const runId = await createRun(db);
    await db.q(
      'isolate-window',
      `DELETE FROM meta.page_scan
        WHERE kind IN ('files','attributions','revisions')
          AND scanned_at >= now() - interval '1 hour'`,
    );
    await db.q(
      'seed-zero-success',
      `INSERT INTO meta.page_scan(run_id,page_id,kind,status,error,scanned_at)
       SELECT $1, 989500000 + g, 'files', 'failed', 'fix2 zero success', now()
         FROM generate_series(1,100) g`,
      [runId],
    );
    await db.q(
      'seed-intermediate-only',
      `INSERT INTO meta.page_scan(run_id,page_id,kind,status,error,scanned_at)
       SELECT $1, 989600000 + g, 'revisions', 'partial',
              'l1_claim_only:修订覆盖交叉核对', now()
         FROM generate_series(1,100) g`,
      [runId],
    );
    const rows = await db.q<{
      kind: string;
      scan_count: string;
      intermediate_count: string;
      evaluated_count: string;
      success_count: string;
      success_rate: number | null;
      severity: string;
      decision: string;
    }>(
      'health-view',
      `SELECT kind, scan_count::text, intermediate_count::text, evaluated_count::text,
              success_count::text, success_rate::float8 AS success_rate, severity, decision
         FROM meta.page_scan_kind_health
        WHERE kind IN ('files','attributions','revisions')
        ORDER BY kind`,
    );
    assert.deepEqual(rows, [
      {
        kind: 'attributions',
        scan_count: '0',
        intermediate_count: '0',
        evaluated_count: '0',
        success_count: '0',
        success_rate: null,
        severity: 'ok',
        decision: 'no_tasks',
      },
      {
        kind: 'files',
        scan_count: '100',
        intermediate_count: '0',
        evaluated_count: '100',
        success_count: '0',
        success_rate: 0,
        severity: 'critical',
        decision: 'rolling_zero_success',
      },
      {
        kind: 'revisions',
        scan_count: '100',
        intermediate_count: '100',
        evaluated_count: '0',
        success_count: '0',
        success_rate: null,
        severity: 'ok',
        decision: 'intermediate_only',
      },
    ]);
    assert.equal(
      await db.num(
        'pending-current',
        `SELECT count(*) FROM meta.pending_collection_current
          WHERE collection='page_scan_success:files'
            AND family='page_scan_zero_success'`,
      ),
      1,
    );
    assert.equal(
      await db.num(
        'no-task-not-pending',
        `SELECT count(*) FROM meta.pending_collection_current
          WHERE collection='page_scan_success:attributions'`,
      ),
      0,
    );
    assert.equal(
      await db.num(
        'intermediate-not-pending',
        `SELECT count(*) FROM meta.pending_collection_current
          WHERE collection='page_scan_success:revisions'`,
      ),
      0,
    );
  } finally {
    await db.rollback().catch(() => undefined);
    await db.end();
  }
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
