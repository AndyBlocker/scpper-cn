import { createHash } from 'node:crypto';
import type { Pool } from 'pg';

import { fetchPageIdentity } from '../page/identity.js';
import { query, toPgTimestamptz } from '../store/db.js';
import { resolveRevisionRegressionIdentityStates } from '../store/incremental.js';
import { enqueueScanTasks, recordPageScan } from '../store/meta.js';
import {
  applyIdentityMissingDeletion,
  applySlugReuseIdentity,
  type SlugReuseIdentityResult,
} from '../store/queues.js';
import {
  reassignSlugReuseTasks,
  resolveObsoletePageIrreconcilables,
  retireDeletedPageTasks,
  type ClaimedWorkTask,
} from '../store/workQueue.js';
import type { HttpClient } from '../http/client.js';

export interface IdentityReviewContext {
  pool: Pool;
  http: HttpClient;
  baseUrl: string;
  runId: number | null;
}

export type IdentityReviewResult =
  | {
      status: 'unchanged';
      finalized: false;
      observedWikidotId: number;
    }
  | {
      status: 'slug_reused';
      finalized: true;
      observedWikidotId: number;
      successorPageId: number;
      tasksReassigned: number;
      tasksEnqueued: number;
      lineageCandidateInserted: boolean;
      resultHash: Buffer;
      lifecycle: SlugReuseIdentityResult;
      apply: Record<string, unknown>;
    }
  | {
      status: 'deleted';
      finalized: true;
      eventSeq: number | null;
      tasksRetired: number;
    }
  | {
      status: 'failed';
      finalized: false;
      error: string;
    };

/**
 * 失败后的通用身份复核。这里只接受 failurePolicy 已判定达到签名阈值的调用；普通抖动
 * 不应调用本函数。slug 仍在时按 wikidotId 分流，slug 404 则以“双直接信号”快速删除。
 */
export async function reviewFailedTaskIdentity(
  context: IdentityReviewContext,
  task: ClaimedWorkTask,
  observedAt = new Date().toISOString(),
): Promise<IdentityReviewResult> {
  const identity = await fetchPageIdentity(context.http, context.baseUrl, task.slug);
  if (identity.kind === 'ok') {
    if (identity.identity.wikidotId === task.wikidotId) {
      await recordIdentityScan(context.pool, context.runId, task.pageId, {
        status: 'ok',
        resultHash: identityHash(task.slug, task.wikidotId),
        error: 'failure_identity_review_same_wikidot_id',
      });
      return {
        status: 'unchanged',
        finalized: false,
        observedWikidotId: identity.identity.wikidotId,
      };
    }
    return applyConfirmedSlugReuse(context, task, identity.identity.wikidotId, observedAt, null);
  }

  if (identity.kind === 'gone') {
    const applied = await applyIdentityMissingDeletion(context.pool, {
      pageId: task.pageId,
      expectedWikidotId: task.wikidotId,
      slug: task.slug,
      observedAt,
      runId: context.runId,
    });
    const tasksRetired = await retireDeletedPageTasks(context.pool, task.pageId);
    await resolveObsoletePageIrreconcilables(context.pool, task.pageId, observedAt);
    await resolveRevisionRegressionIdentityStates(
      context.pool,
      task.pageId,
      'deleted',
      observedAt,
      'identity_missing_confirmed_http_404',
    );
    await recordIdentityScan(context.pool, context.runId, task.pageId, {
      status: 'ok',
      resultHash: identityHash(task.slug, task.wikidotId),
      error: 'identity_missing_confirmed_http_404',
    });
    return {
      status: 'deleted',
      finalized: true,
      eventSeq: applied.deleted_event_seq,
      tasksRetired,
    };
  }

  const error = identity.kind === 'mismatch'
    ? `身份复核被重定向到其它 slug=${identity.observedSlug}，拒绝注册或删除`
    : `身份复核失败：${identity.error}`;
  await recordIdentityScan(context.pool, context.runId, task.pageId, {
    status: 'failed',
    resultHash: null,
    error,
  });
  return { status: 'failed', finalized: false, error };
}

/** REGRESS meta 路径与通用失败复核共用同一套 slug-reuse 写入及任务迁移。 */
export async function applyConfirmedSlugReuse(
  context: Pick<IdentityReviewContext, 'pool' | 'runId'>,
  task: ClaimedWorkTask,
  observedWikidotId: number,
  observedAt: string,
  /** meta 身份任务传自身 id；通用失败复核传 null，连当前失败任务一起迁走。 */
  currentTaskIdToExclude: number | null,
): Promise<Extract<IdentityReviewResult, { status: 'slug_reused' }>> {
  const reuse = await applySlugReuseIdentity(context.pool, {
    predecessorId: task.pageId,
    observedWikidotId,
    slug: task.slug,
    observedAt,
    runId: context.runId,
  });
  const successorPageId = Number(reuse.successor_id);
  const resultHash = identityHash(task.slug, observedWikidotId);
  const tasksReassigned = await reassignSlugReuseTasks(
    context.pool,
    task.pageId,
    successorPageId,
    currentTaskIdToExclude,
  );
  await resolveObsoletePageIrreconcilables(context.pool, task.pageId, observedAt);
  await resolveRevisionRegressionIdentityStates(
    context.pool,
    task.pageId,
    'slug_reused',
    observedAt,
    `wikidot_id_changed:${task.wikidotId}->${observedWikidotId}`,
  );

  await recordIdentityScan(context.pool, context.runId, task.pageId, {
    status: 'partial',
    resultHash,
    error:
      `slug_reuse_identity_replaced:expected=${task.wikidotId};` +
      `observed=${observedWikidotId};successor_page_id=${successorPageId}`,
  });
  await recordIdentityScan(context.pool, context.runId, successorPageId, {
    status: 'ok',
    resultHash,
    error: null,
  });
  await recordPageScan(context.pool, {
    runId: context.runId,
    pageId: successorPageId,
    kind: 'revisions',
    status: 'partial',
    claimedTotal: task.revisionClaimedTotal,
    resultHash,
    error: 'slug_reuse_identity_registered:等待 revisions_full 完整抓取',
  });

  const apply = await applyObservedPageMeta(
    context.pool,
    context.runId,
    successorPageId,
    task.slug,
    observedWikidotId,
    observedAt,
  );
  const tasksEnqueued = await enqueueScanTasks(context.pool, [
    {
      pageId: successorPageId,
      kind: 'new_page_highfreq',
      reasons: ['slug_reuse_identity_registered'],
      priority: 100,
    },
    {
      pageId: successorPageId,
      kind: 'content',
      reasons: ['slug_reuse_identity_registered'],
      priority: 100,
    },
    {
      pageId: successorPageId,
      kind: 'revisions_full',
      reasons: ['slug_reuse_identity_registered'],
      priority: 100,
    },
  ]);

  return {
    status: 'slug_reused',
    finalized: true,
    observedWikidotId,
    successorPageId,
    tasksReassigned,
    tasksEnqueued,
    lineageCandidateInserted: reuse.lineage_candidate_inserted,
    resultHash,
    lifecycle: reuse,
    apply,
  };
}

export async function applyObservedPageMeta(
  pool: Pool,
  runId: number | null,
  pageId: number,
  slug: string,
  wikidotId: number,
  observedAt: string,
): Promise<Record<string, unknown>> {
  const response = await query<{ result: Record<string, unknown> }>(
    pool,
    'work.meta:apply_page_meta',
    `SELECT ingest.apply_page_meta(
       p_page       => $1::int,
       p_attrs      => jsonb_build_object('slug', $2::text),
       p_observed   => $3::timestamptz,
       p_source     => 'wikidot',
       p_run        => $4::bigint,
       p_wikidot_id => $5::int
     ) AS result`,
    [pageId, slug, toPgTimestamptz(observedAt), runId, wikidotId],
  );
  return response.rows[0]?.result ?? {};
}

function identityHash(slug: string, wikidotId: number): Buffer {
  return createHash('sha256').update(`${slug}\n${wikidotId}`, 'utf8').digest();
}

async function recordIdentityScan(
  pool: Pool,
  runId: number | null,
  pageId: number,
  args: {
    status: 'ok' | 'partial' | 'failed';
    resultHash: Buffer | null;
    error: string | null;
  },
): Promise<void> {
  await recordPageScan(pool, {
    runId,
    pageId,
    kind: 'meta',
    status: args.status,
    claimedTotal: 1,
    fetchedTotal: args.status === 'failed' ? 0 : 1,
    checksumOk: args.status === 'ok',
    resultHash: args.resultHash,
    error: args.error,
  });
}
