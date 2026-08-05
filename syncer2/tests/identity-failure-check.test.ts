import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { HttpStatusError, type HttpClient } from '../src/http/client.js';
import { createPool, query } from '../src/store/db.js';
import {
  finishWorkTask,
  type ClaimedWorkTask,
} from '../src/store/workQueue.js';
import {
  classifyWorkFailure,
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

before(async () => {
  const sess = await openSess('identity-check-clean-before');
  try {
    await cleanupAll(sess);
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
    assert.equal(structural.action, 'irreconcilable');
    assert.equal(structural.identityReviewThreshold, null);

    const sharedForumPreflight = classifyWorkFailure(
      'discussion',
      'ForumStartModule 前置失败：ForumStartModule status=ok 但 body 缺失',
    );
    assert.equal(sharedForumPreflight.action, 'irreconcilable');
    assert.equal(sharedForumPreflight.identityReviewThreshold, null);
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
          runId: null,
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
          runId: null,
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
        runId: null,
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
