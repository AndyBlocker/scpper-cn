import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { HttpStatusError, type HttpClient } from '../src/http/client.js';
import { createPool, query } from '../src/store/db.js';
import {
  acceptSameIdentityRevisionRegression,
  reconcileRevisionRegressionIdentityStates,
  upsertRevisionRegressionIdentityStates,
} from '../src/store/incremental.js';
import {
  applyIdentityMissingDeletion,
  applySlugReuseIdentity,
} from '../src/store/queues.js';
import {
  claimWorkTasks,
  finishWorkTask,
  type ClaimedWorkTask,
} from '../src/store/workQueue.js';
import { enqueueScanTasks } from '../src/store/meta.js';
import {
  classifyWorkFailure,
  deterministicEgressFailureClass,
  identityReviewDue,
  reviewIdentityIfDue,
  workFailureHash,
} from '../src/work/failurePolicy.js';
import { reviewFailedTaskIdentity } from '../src/work/identityCheck.js';
import {
  OBSERVED_ISO,
  PAGE_WID_LO,
  cleanupAll,
} from './helpers/fixture.js';
import { openSess, resolveTestDatabaseUrl } from './helpers/pg.js';

const WORKER = 'identity-check-test';
const pool = createPool(resolveTestDatabaseUrl(), { max: 4 });
let testRunId: number;

before(async () => {
  const sess = await openSess('identity-check-clean-before');
  try {
    await cleanupAll(sess);
    testRunId = Number(await sess.val<string>(
      'identity-check-run',
      `INSERT INTO meta.ingest_run(source,status,started_at)
       VALUES ('test_syncer2','running',$1::timestamptz)
       RETURNING id::text`,
      [OBSERVED_ISO],
    ));
  } finally {
    await sess.end();
  }
});

after(async () => {
  const sess = await openSess('identity-check-clean-after');
  try {
    await cleanupAll(sess);
  } finally {
    await sess.end();
    await pool.end();
  }
});

describe('通用失败签名与身份复核', () => {
  it('AMC 空实体/空体 500 阈值为 1；503、超时和有正文 500 不触发额外 slug 请求', async () => {
    const baseTask = taskShape(1, 1, PAGE_WID_LO + 1, 'ts2test:policy', 'votes_full');
    for (const error of [
      'WhoRated status=ok 但 body=null',
      'HttpStatusError: HTTP 500 for https://example.test/ajax-module-connector.php',
    ]) {
      const policy = classifyWorkFailure('votes_full', error);
      assert.equal(policy.family, 'identity_absent');
      assert.match(deterministicEgressFailureClass(policy) ?? '', /^work:identity_absent:/);
      assert.equal(policy.identityReviewThreshold, 1);
      assert.equal(identityReviewDue(baseTask, policy), true);
    }

    for (const error of [
      'HttpStatusError: HTTP 503 for https://example.test/ajax-module-connector.php',
      'TransportError: transport timeout for https://example.test/ajax-module-connector.php',
      'HttpStatusError: HTTP 500 for https://example.test/ajax-module-connector.php :: upstream overloaded',
    ]) {
      let reviews = 0;
      const policy = classifyWorkFailure('votes_full', error);
      const reviewed = await reviewIdentityIfDue(baseTask, policy, async () => ++reviews);
      assert.equal(policy.action, 'retry');
      assert.equal(deterministicEgressFailureClass(policy), null);
      assert.equal(reviewed, null);
      assert.equal(reviews, 0);
    }
  });

  it('非 votes_full 的 page-bound kind 使用同一判据；结构拒绝直接隔离', async () => {
    const task = taskShape(2, 2, PAGE_WID_LO + 2, 'ts2test:files-policy', 'files');
    const identityPolicy = classifyWorkFailure('files', 'PageFilesModule status=ok 但 body 缺失。');
    let reviews = 0;
    await reviewIdentityIfDue(task, identityPolicy, async () => ++reviews);
    assert.equal(identityPolicy.identityReviewThreshold, 1);
    assert.equal(reviews, 1);

    const structural = classifyWorkFailure(
      'files',
      '附件响应中没有 table.page-files；解析结构已变化',
    );
    assert.equal(structural.family, 'structural');
    assert.equal(
      deterministicEgressFailureClass(structural),
      null,
      '结构拒绝来自成功 HTTP 后判定，本就不在压力分子，不能抹掉同任务的瞬时链路失败',
    );
    assert.equal(structural.action, 'irreconcilable');
    assert.equal(structural.identityReviewThreshold, null);

    const sharedForumPreflight = classifyWorkFailure(
      'discussion',
      'ForumStartModule 前置失败：ForumStartModule status=ok 但 body 缺失',
    );
    assert.equal(sharedForumPreflight.action, 'irreconcilable');
    assert.equal(sharedForumPreflight.identityReviewThreshold, null);
  });

  it('discussion CommentsList no_page 首次即重解析身份；id 已变时迁移到 successor', async () => {
    const slug = 'ts2test:discussion-no-page-reused';
    const predecessorWid = PAGE_WID_LO + 9_880;
    const successorWid = PAGE_WID_LO + 9_881;
    const predecessorId = await register(predecessorWid, slug);
    const taskId = await insertTask(predecessorId, 'discussion', true);
    const task = taskShape(taskId, predecessorId, predecessorWid, slug, 'discussion');
    const policy = classifyWorkFailure(
      'discussion',
      'forum/ForumCommentsListModule status=no_page（message=无法找到相关页面）',
    );
    assert.equal(policy.action, 'review_identity');
    assert.equal(policy.identityReviewThreshold, 1);

    let reviews = 0;
    const reviewed = await reviewIdentityIfDue(task, policy, async () => {
      reviews++;
      return reviewFailedTaskIdentity(
        {
          pool,
          http: identityHttp(slug, successorWid),
          baseUrl: 'https://scp-wiki-cn.wikidot.com',
          runId: testRunId,
        },
        task,
        OBSERVED_ISO,
      );
    });
    assert.equal(reviews, 1, 'no_page 不能只拿旧 pageId 重试，必须额外按 slug GET');
    assert.equal(reviewed?.status, 'slug_reused');
    if (reviewed?.status !== 'slug_reused') throw new Error('预期 slug_reused');
    const row = await one<{ old_status: string; successor_tasks: number; predecessor_tasks: number }>(
      `SELECT old_pc.status AS old_status,
              (SELECT count(*)::int FROM meta.scan_task st
                JOIN serve.page_current next_pc ON next_pc.page_id=st.page_id
               WHERE next_pc.wikidot_id=$2 AND st.kind='discussion') AS successor_tasks,
              (SELECT count(*)::int FROM meta.scan_task
                WHERE page_id=$1 AND kind='discussion') AS predecessor_tasks
         FROM serve.page_current old_pc WHERE old_pc.page_id=$1`,
      [predecessorId, successorWid],
    );
    assert.deepEqual(row, { old_status: 'deleted', successor_tasks: 1, predecessor_tasks: 0 });
  });

  it('首次空体 500 + slug 上 wikidotId 已变：注册 lineage 并迁移当前及其它 kind 待办', async () => {
    const slug = 'ts2test:identity-reused';
    const predecessorWid = PAGE_WID_LO + 9_901;
    const successorWid = PAGE_WID_LO + 9_902;
    const predecessorId = await register(predecessorWid, slug);
    const currentTaskId = await insertTask(predecessorId, 'votes_full', true);
    await insertTask(predecessorId, 'files', false);
    const task = taskShape(currentTaskId, predecessorId, predecessorWid, slug, 'votes_full');
    const policy = classifyWorkFailure(
      task.kind,
      'HttpStatusError: HTTP 500 for https://scp-wiki-cn.wikidot.com/ajax-module-connector.php',
    );

    const reviewed = await reviewIdentityIfDue(task, policy, () =>
      reviewFailedTaskIdentity(
        {
          pool,
          http: identityHttp(slug, successorWid),
          baseUrl: 'https://scp-wiki-cn.wikidot.com',
          runId: testRunId,
        },
        task,
        OBSERVED_ISO,
      ),
    );
    assert.equal(reviewed?.status, 'slug_reused');
    assert.equal(reviewed?.finalized, true);
    if (reviewed?.status !== 'slug_reused') throw new Error('预期 slug_reused');
    assert.equal(reviewed.tasksReassigned, 2);

    const row = await one<{
      old_status: string;
      new_status: string;
      successor_id: number;
      lineage: number;
      old_data_tasks: number;
      moved_votes: number;
      moved_files: number;
    }>(
      `SELECT old_pc.status AS old_status,
              new_pc.status AS new_status,
              new_pc.page_id AS successor_id,
              (SELECT count(*)::int FROM ingest.page_lineage
                WHERE predecessor_id=$1 AND successor_id=new_pc.page_id) AS lineage,
              (SELECT count(*)::int FROM meta.scan_task
                WHERE page_id=$1 AND kind IN ('votes_full','files')) AS old_data_tasks,
              (SELECT count(*)::int FROM meta.scan_task
                WHERE page_id=new_pc.page_id AND kind='votes_full'
                  AND 'slug_reuse_identity_registered'=ANY(reasons)) AS moved_votes,
              (SELECT count(*)::int FROM meta.scan_task
                WHERE page_id=new_pc.page_id AND kind='files'
                  AND 'slug_reuse_identity_registered'=ANY(reasons)) AS moved_files
         FROM serve.page_current old_pc
         JOIN serve.page_current new_pc ON new_pc.wikidot_id=$2
        WHERE old_pc.page_id=$1`,
      [predecessorId, successorWid],
    );
    assert.deepEqual(
      {
        old: row.old_status,
        next: row.new_status,
        lineage: row.lineage,
        oldTasks: row.old_data_tasks,
        votes: row.moved_votes,
        files: row.moved_files,
      },
      { old: 'deleted', next: 'live', lineage: 1, oldTasks: 0, votes: 1, files: 1 },
    );
    assert.equal(row.successor_id, reviewed.successorPageId);
  });

  it('AMC 空实体 + slug 404：直接走删除生命事件，不注册 successor', async () => {
    const slug = 'ts2test:identity-deleted';
    const wikidotId = PAGE_WID_LO + 9_910;
    const pageId = await register(wikidotId, slug);
    const currentTaskId = await insertTask(pageId, 'content', true);
    await insertTask(pageId, 'revisions_full', false);
    const task = taskShape(currentTaskId, pageId, wikidotId, slug, 'content');
    const policy = classifyWorkFailure('content', 'ViewSourceModule status=ok 但 body 缺失');

    const reviewed = await reviewIdentityIfDue(task, policy, () =>
      reviewFailedTaskIdentity(
        {
          pool,
          http: goneHttp(),
          baseUrl: 'https://scp-wiki-cn.wikidot.com',
          runId: testRunId,
        },
        task,
        OBSERVED_ISO,
      ),
    );
    assert.equal(reviewed?.status, 'deleted');

    const row = await one<{ status: string; events: number; tasks: number; lineage: number }>(
      `SELECT pc.status,
              (SELECT count(*)::int FROM ingest.page_life_event
                WHERE page_id=$1 AND kind='deleted'
                  AND source='wikidot_identity_missing') AS events,
              (SELECT count(*)::int FROM meta.scan_task WHERE page_id=$1) AS tasks,
              (SELECT count(*)::int FROM ingest.page_lineage WHERE predecessor_id=$1) AS lineage
         FROM serve.page_current pc WHERE pc.page_id=$1`,
      [pageId],
    );
    assert.deepEqual(row, { status: 'deleted', events: 1, tasks: 0, lineage: 0 });
  });

  it('直接缺失签名复核后 wikidotId 未变：不改身份，原 kind 正常退避', async () => {
    const slug = 'ts2test:identity-unchanged';
    const wikidotId = PAGE_WID_LO + 9_920;
    const pageId = await register(wikidotId, slug);
    const currentTaskId = await insertTask(pageId, 'files', true);
    const task = taskShape(currentTaskId, pageId, wikidotId, slug, 'files');
    const policy = classifyWorkFailure('files', 'PageFilesModule status=ok 但 body 缺失');
    const reviewed = await reviewFailedTaskIdentity(
      {
        pool,
        http: identityHttp(slug, wikidotId),
        baseUrl: 'https://scp-wiki-cn.wikidot.com',
        runId: testRunId,
      },
      task,
      OBSERVED_ISO,
    );
    assert.equal(reviewed.status, 'unchanged');

    const finished = await finishWorkTask(pool, task, {
      workerId: WORKER,
      status: 'failed',
      resultHash: workFailureHash(policy),
      now: OBSERVED_ISO,
    });
    assert.equal(finished.action, 'retried');
    assert.notEqual(finished.notBefore, null);
    const row = await one<{ status: string; tasks: number; lineage: number }>(
      `SELECT pc.status,
              (SELECT count(*)::int FROM meta.scan_task WHERE page_id=$1 AND kind='files') AS tasks,
              (SELECT count(*)::int FROM ingest.page_lineage WHERE predecessor_id=$1) AS lineage
         FROM serve.page_current pc WHERE pc.page_id=$1`,
      [pageId],
    );
    assert.deepEqual(row, { status: 'live', tasks: 1, lineage: 0 });
  });

  it('同一身份的修订号 3→1 可 CAS 接受并终结 pending，不再每轮重建身份任务', async () => {
    const slug = 'ts2test:revision-regression-same-identity';
    const wikidotId = PAGE_WID_LO + 9_925;
    const pageId = await register(wikidotId, slug);
    const run = await one<{ id: string }>(
      `INSERT INTO meta.ingest_run(source,status,started_at)
       VALUES ('test_syncer2','ok',$1::timestamptz)
       RETURNING id::text`,
      [OBSERVED_ISO],
    );
    await query(
      pool,
      'test:seed_revision_regression_state',
      `INSERT INTO meta.incremental_page_state(
         slug, page_id, last_l1_revision, last_l1_rating, last_l1_rating_votes,
         last_l1_seen_at, last_l1_run_id
       ) VALUES ($1,NULL,3,0,0,$2::timestamptz,$3::bigint)
       ON CONFLICT (slug) DO UPDATE
         SET page_id=EXCLUDED.page_id,
             last_l1_revision=EXCLUDED.last_l1_revision,
             last_l1_rating=EXCLUDED.last_l1_rating,
             last_l1_rating_votes=EXCLUDED.last_l1_rating_votes,
             last_l1_seen_at=EXCLUDED.last_l1_seen_at,
             last_l1_run_id=EXCLUDED.last_l1_run_id`,
      [slug, OBSERVED_ISO, Number(run.id)],
    );
    await query(
      pool,
      'test:seed_obsolete_meta_irreconcilable',
      `INSERT INTO meta.irreconcilable(page_id,kind,local_value,remote_value)
       VALUES ($1,'meta','{}','{}')`,
      [pageId],
    );
    const observation = {
      layer: 'L1' as const,
      pageId,
      slug,
      previousRevision: 3,
      observedRevision: 1,
      observedRating: 0,
      observedRatingVotes: 0,
    };
    const firstEpisode = await upsertRevisionRegressionIdentityStates(
      pool,
      Number(run.id),
      [observation],
      OBSERVED_ISO,
    );
    assert.equal(firstEpisode.newEpisodeKeys.size, 1);
    const replay = await upsertRevisionRegressionIdentityStates(
      pool,
      Number(run.id),
      [observation],
      new Date(Date.parse(OBSERVED_ISO) + 5 * 60_000).toISOString(),
    );
    assert.equal(replay.newEpisodeKeys.size, 0, '同一 episode 重放不得再派生 claim/partial');
    assert.equal(await enqueueScanTasks(pool, [{
      pageId,
      kind: 'meta',
      reasons: ['revision_regression_identity_check', 'l1_revision_regression'],
      priority: 100,
    }]), 1);
    const [identityTask] = await claimWorkTasks(
      pool,
      1,
      WORKER,
      ['meta'],
      30 * 60_000,
      7,
      slug,
    );
    assert.notEqual(identityTask, undefined, '新倒退证据必须穿过旧 meta 终态的入队与认领门禁');
    assert.equal(
      Number((await one<{ n: string }>(
        `SELECT count(*)::text AS n FROM meta.irreconcilable
          WHERE page_id=$1 AND kind='meta' AND resolved_at IS NULL`,
        [pageId],
      )).n),
      1,
      'ListPages 证据不能提前关闭任意 meta 终态；须等真实身份 GET 成功',
    );

    const accepted = await acceptSameIdentityRevisionRegression(pool, {
      pageId,
      slug,
      wikidotId,
      observedAt: OBSERVED_ISO,
    });
    assert.deepEqual(accepted.layers, [{
      layer: 'L1',
      previousRevision: 3,
      observedRevision: 1,
    }]);
    assert.equal(accepted.accepted, 1);
    await finishWorkTask(pool, identityTask!, {
      workerId: WORKER,
      status: 'ok',
      now: OBSERVED_ISO,
    });

    const state = await one<{
      last_l1_revision: number;
      status: string;
      pending: number;
    }>(
      `SELECT ips.last_l1_revision, r.status,
              (SELECT count(*)::int
                 FROM meta.revision_regression_identity_state pending
                WHERE pending.page_id=$1 AND pending.status='pending') AS pending
         FROM meta.incremental_page_state ips
         JOIN meta.revision_regression_identity_state r
           ON r.page_id=ips.page_id AND r.layer='L1'
        WHERE ips.page_id=$1`,
      [pageId],
    );
    assert.deepEqual(state, {
      last_l1_revision: 1,
      status: 'accepted_same_identity',
      pending: 0,
    });
    assert.equal(
      Number((await one<{ n: string }>(
        `SELECT count(*)::text AS n FROM meta.irreconcilable
          WHERE page_id=$1 AND kind='meta' AND resolved_at IS NULL`,
        [pageId],
      )).n),
      0,
      '真实身份 GET 成功完成任务后才关闭旧 meta 终态',
    );
    assert.equal(
      (await acceptSameIdentityRevisionRegression(pool, {
        pageId,
        slug,
        wikidotId,
        observedAt: OBSERVED_ISO,
      })).accepted,
      0,
      '已收敛状态不得重复接受或无限 pending',
    );
  });

  it('同 slug 两代旧身份同时留有 regression：本地 live 后继证据将两条都收口为 slug_reused', async () => {
    const slug = 'ts2test:revision-regression-two-generations';
    const old1Wid = PAGE_WID_LO + 9_940;
    const old2Wid = PAGE_WID_LO + 9_941;
    const successorWid = PAGE_WID_LO + 9_942;
    const old1 = await register(old1Wid, slug);
    const second = await applySlugReuseIdentity(pool, {
      predecessorId: old1,
      observedWikidotId: old2Wid,
      slug,
      observedAt: OBSERVED_ISO,
      runId: testRunId,
    });
    const old2 = Number(second.successor_id);
    const nextObserved = new Date(Date.parse(OBSERVED_ISO) + 1_000).toISOString();
    await applySlugReuseIdentity(pool, {
      predecessorId: old2,
      observedWikidotId: successorWid,
      slug,
      observedAt: nextObserved,
      runId: testRunId,
    });
    await upsertRevisionRegressionIdentityStates(pool, testRunId, [
      { layer: 'L1', pageId: old1, slug, previousRevision: 8, observedRevision: 0 },
      { layer: 'L0', pageId: old2, slug, previousRevision: 3, observedRevision: 1 },
    ], nextObserved);

    const reconciled = await reconcileRevisionRegressionIdentityStates(
      pool,
      nextObserved,
      60 * 60_000,
      [old1, old2],
    );
    assert.equal(reconciled.slugReused, 2);
    const states = await query<{ page_id: number; status: string }>(
      pool,
      'test:two_generation_regression_states',
      `SELECT page_id,status
         FROM meta.revision_regression_identity_state
        WHERE page_id=ANY($1::int[])
        ORDER BY page_id`,
      [[old1, old2]],
    );
    assert.deepEqual(states.rows.map((row) => row.status), ['slug_reused', 'slug_reused']);
  });

  it('observed_revision=0 且旧身份已确认删除：自动进入 deleted 终态', async () => {
    const slug = 'ts2test:revision-regression-deleted-zero';
    const wikidotId = PAGE_WID_LO + 9_945;
    const pageId = await register(wikidotId, slug);
    await applyIdentityMissingDeletion(pool, {
      pageId,
      expectedWikidotId: wikidotId,
      slug,
      observedAt: OBSERVED_ISO,
      runId: testRunId,
    });
    await upsertRevisionRegressionIdentityStates(pool, testRunId, [{
      layer: 'L1',
      pageId,
      slug,
      previousRevision: 1,
      observedRevision: 0,
    }], OBSERVED_ISO);

    const reconciled = await reconcileRevisionRegressionIdentityStates(
      pool,
      OBSERVED_ISO,
      60 * 60_000,
      [pageId],
    );
    assert.equal(reconciled.deleted, 1);
    const row = await one<{ status: string; resolution: string }>(
      `SELECT status,resolution FROM meta.revision_regression_identity_state
        WHERE page_id=$1 AND layer='L1'`,
      [pageId],
    );
    assert.equal(row.status, 'deleted');
    assert.match(row.resolution, /observed_revision=0/);
  });

  it('pending 满一小时仍无可靠身份结论：升级 manual_review 并退役确认任务', async () => {
    const slug = 'ts2test:revision-regression-timeout';
    const wikidotId = PAGE_WID_LO + 9_950;
    const pageId = await register(wikidotId, slug);
    const firstSeen = new Date(Date.parse(OBSERVED_ISO) - 60 * 60_000).toISOString();
    await upsertRevisionRegressionIdentityStates(pool, testRunId, [{
      layer: 'L1',
      pageId,
      slug,
      previousRevision: 6,
      observedRevision: 1,
    }], firstSeen);
    await enqueueScanTasks(pool, [{
      pageId,
      kind: 'meta',
      reasons: ['revision_regression_identity_check', 'l1_revision_regression'],
      priority: 100,
    }]);

    const reconciled = await reconcileRevisionRegressionIdentityStates(
      pool,
      OBSERVED_ISO,
      60 * 60_000,
      [pageId],
    );
    assert.equal(reconciled.manualReview, 1);
    assert.equal(reconciled.tasksRetired, 1);
    const replay = await upsertRevisionRegressionIdentityStates(pool, testRunId, [{
      layer: 'L1',
      pageId,
      slug,
      previousRevision: 6,
      observedRevision: 1,
    }], new Date(Date.parse(OBSERVED_ISO) + 5 * 60_000).toISOString());
    assert.equal(replay.newEpisodeKeys.size, 0);
    const row = await one<{ status: string; tasks: number }>(
      `SELECT r.status,
              (SELECT count(*)::int FROM meta.scan_task WHERE page_id=$1) AS tasks
         FROM meta.revision_regression_identity_state r
        WHERE r.page_id=$1 AND r.layer='L1'`,
      [pageId],
    );
    assert.deepEqual(row, { status: 'manual_review', tasks: 0 });
  });

  it('确定性解析结构拒绝首次即进入 irreconcilable，不计算退避时间', async () => {
    const slug = 'ts2test:identity-structural';
    const wikidotId = PAGE_WID_LO + 9_930;
    const pageId = await register(wikidotId, slug);
    const currentTaskId = await insertTask(pageId, 'files', true);
    const task = taskShape(currentTaskId, pageId, wikidotId, slug, 'files');
    const policy = classifyWorkFailure('files', '附件响应中没有 table.page-files；解析结构已变化');
    const finished = await finishWorkTask(pool, task, {
      workerId: WORKER,
      status: 'failed',
      resultHash: workFailureHash(policy),
      terminalFailure: true,
      localValue: { error_family: policy.family },
      remoteValue: { signature: policy.signature },
      now: OBSERVED_ISO,
    });
    assert.equal(finished.action, 'irreconcilable');
    assert.equal(finished.notBefore, null);
    assert.equal(
      Number((await one<{ n: string }>(
        `SELECT count(*)::text AS n FROM meta.irreconcilable
          WHERE page_id=$1 AND kind='files' AND resolved_at IS NULL`,
        [pageId],
      )).n),
      1,
    );
  });
});

function taskShape(
  taskId: number,
  pageId: number,
  wikidotId: number,
  slug: string,
  kind: ClaimedWorkTask['kind'],
): ClaimedWorkTask {
  return {
    queueSource: 'scan_task',
    taskId,
    pageId,
    wikidotId,
    slug,
    kind,
    attempts: 1,
    stableCount: 0,
    lastResultHash: null,
    reasons: ['identity_failure_test'],
    firstPublishedAt: null,
    taskCreatedAt: OBSERVED_ISO,
    claimedTotal: 1,
    claimedRating: 1,
    tier1RunId: null,
    revisionClaimedTotal: 1,
    commentCount: 0,
    expectedThreadId: null,
  };
}

async function register(wikidotId: number, slug: string): Promise<number> {
  const row = await one<{ page_id: number }>(
    `SELECT ingest.register_page(
       $1::int, $2::text, $3::timestamptz, 'test_wikidot', NULL, $3::timestamptz, NULL
     ) AS page_id`,
    [wikidotId, slug, OBSERVED_ISO],
  );
  return Number(row.page_id);
}

async function insertTask(
  pageId: number,
  kind: ClaimedWorkTask['kind'],
  locked: boolean,
): Promise<number> {
  const row = await one<{ id: string }>(
    `INSERT INTO meta.scan_task(
       page_id, kind, reasons, priority, attempts, locked_by, locked_at
     ) VALUES (
       $1, $2, '{identity_failure_test}', 100, 1,
       CASE WHEN $3::boolean THEN $4 ELSE NULL END,
       CASE WHEN $3::boolean THEN $5::timestamptz ELSE NULL END
     ) RETURNING id::text`,
    [pageId, kind, locked, WORKER, OBSERVED_ISO],
  );
  return Number(row.id);
}

function identityHttp(slug: string, wikidotId: number): HttpClient {
  const html = Buffer.from(
    `<script>
       WIKIREQUEST.info.pageId = ${wikidotId};
       WIKIREQUEST.info.pageUnixName = ${JSON.stringify(slug)};
       WIKIREQUEST.info.requestPageName = ${JSON.stringify(slug)};
     </script>`,
    'utf8',
  );
  return {
    get: async () => ({
      status: 200,
      headers: {},
      body: html,
      text: () => html.toString('utf8'),
      telemetry: { wireBytes: html.byteLength, durationMs: 1 },
    }),
  } as unknown as HttpClient;
}

function goneHttp(): HttpClient {
  return {
    get: async (url: string) => {
      throw new HttpStatusError(404, url, '');
    },
  } as unknown as HttpClient;
}

async function one<T extends Record<string, unknown>>(
  sql: string,
  params: readonly unknown[] = [],
): Promise<T> {
  const result = await query<T>(pool, 'test:identity_failure', sql, params);
  assert.equal(result.rows.length, 1);
  return result.rows[0]!;
}
