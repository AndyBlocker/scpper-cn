import { createHash } from 'node:crypto';
import type { Pool } from 'pg';

import {
  applyAlternateTitleObservations,
  applyNewAttributionEntriesBySlug,
  collectAlternateTitles,
  collectAttributions,
} from '../collect/conventions.js';
import { decideRevisionRegressionIdentity } from '../collect/revisionRegression.js';
import {
  processDeletionTask,
  type ClaimedDeletionTask,
} from '../collect/deletion.js';
import { recordFileResult, revisionNeedsFilesScan, scanFiles } from '../collect/files.js';
import {
  applyForumBatch,
  applyForumDiscussion,
  forumBatchResultHash,
  scanForumStart,
  scanPageDiscussions,
  type ForumDiscussionTarget,
} from '../collect/forum.js';
import { scanPageIds } from '../collect/pageid.js';
import { failed, partial, type CollectResult } from '../collect/result.js';
import { applyRevisionResult, scanRevisions, type RevisionBatch } from '../collect/revisions.js';
import { applyCurrentContent, scanCurrentContents } from '../collect/source.js';
import {
  applyCollectedVoteSnapshot,
  collectVoteSnapshots,
  recordVoteScanFailure,
  type VoteTarget,
} from '../collect/votes.js';
import type { HttpClient } from '../http/client.js';
import { query, toPgTimestamptz } from '../store/db.js';
import {
  enqueueScanTasks,
  recordPageScan as persistPageScan,
  type PageScanKind,
  type ScanTaskKind,
} from '../store/meta.js';
import { sanitizePageScanError } from '../store/pgText.js';
import { applySlugReuseIdentity } from '../store/queues.js';
import {
  reassignSlugReuseTasks,
  type ClaimedWorkTask,
} from '../store/workQueue.js';

export interface WorkHandlerContext {
  pool: Pool;
  http: HttpClient;
  baseUrl: string;
  runId: number | null;
  workerId: string;
  concurrency: number;
  cache: Map<string, Promise<unknown>>;
}

export interface WorkHandlerOutcome {
  status: 'ok' | 'partial' | 'failed';
  resultHash: Buffer | null;
  /** 已解释且已留证的 partial：事实单调 upsert 成功，队列应收尾而不是退避。 */
  settledPartial?: boolean;
  localValue?: Record<string, unknown>;
  remoteValue?: Record<string, unknown>;
  sample?: Record<string, unknown>;
  /**
   * confirm_deleted 的四门逻辑会在 collect/deletion.ts 内原子完成队列状态转换；
   * 其它 handler 一律由统一 finishWorkTask 收尾。
   */
  finalized?: boolean;
}

export type WorkHandler = (
  task: ClaimedWorkTask,
  context: WorkHandlerContext,
) => Promise<WorkHandlerOutcome>;

const voteHandler: WorkHandler = async (task, context) => {
  const target = toVoteTarget(task);
  if (
    task.claimedTotal === null ||
    task.claimedRating === null ||
    task.tier1RunId === null
  ) {
    const error =
      '缺少成功 L1/Tier1 ListPages 的 claimed_total/claimed_rating 证据；拒绝使用本地聚合值';
    await recordVoteScanFailure(context.pool, target, context.runId, error);
    return {
      status: 'failed',
      resultHash: null,
      remoteValue: tier1Claims(task),
      sample: { error, ...tier1Claims(task) },
    };
  }

  if (task.kind === 'new_page_highfreq') {
    await enqueueScanTasks(context.pool, [{
      pageId: task.pageId,
      kind: 'content',
      reasons: ['new_page_under_7d'],
      priority: 100,
      notBefore: new Date().toISOString(),
    }]);
  }

  const results = await collectVoteSnapshots(
    context.http,
    context.baseUrl,
    [target],
    1,
  );
  const result = results.get(task.pageId) ?? {
    status: 'failed' as const,
    error: '内部错误：投票结果 Map 缺项',
  };
  if (result.data === undefined) {
    const error =
      result.status === 'failed'
        ? result.error
        : '内部错误：非 failed 投票结果缺少 data';
    await recordVoteScanFailure(
      context.pool,
      target,
      context.runId,
      error,
      null,
      null,
      null,
    );
    return {
      status: 'failed',
      resultHash: null,
      remoteValue: tier1Claims(task),
      sample: {
        error,
        ...tier1Claims(task),
      },
    };
  }

  const applied = await applyCollectedVoteSnapshot(
    context.pool,
    result,
    context.runId,
    new Date().toISOString(),
  );
  return {
    status: applied.scanStatus,
    resultHash: applied.resultHash,
    localValue: applied.applyResult,
    remoteValue: tier1Claims(task),
    sample: {
      parsedEntries: result.data.entries.length,
      checksum: result.data.checksum,
      identityKinds: result.data.identityKinds,
      duplicateEntries: result.data.duplicateEntries,
      quarantined: applied.quarantined,
      identityCollisions: applied.identityCollisions,
      apply: applied.applyResult,
      error: result.status === 'failed' ? result.error : null,
    },
  };
};

const contentHandler: WorkHandler = async (task, context) => {
  const target = { pageId: task.pageId, wikidotId: task.wikidotId, slug: task.slug };
  const results = await scanCurrentContents(context.http, context.baseUrl, [target], 1);
  const result =
    results.get(task.pageId) ??
    failed<never>('内部错误：当前内容结果 Map 缺项');
  const applied = await applyCurrentContent(context.pool, target, result, {
    observedAt: new Date().toISOString(),
    runId: context.runId,
    source: 'wikidot',
  });
  const resultHash =
    result.status === 'ok' &&
    typeof applied?.['source_sha'] === 'string' &&
    /^[0-9a-f]{64}$/i.test(applied['source_sha'])
      ? Buffer.from(applied['source_sha'], 'hex')
      : result.status === 'ok'
        ? Buffer.from(result.data.sha256Hex, 'hex')
        : hashFailureEvidence('content', result.error);
  return {
    status: result.status,
    resultHash,
    localValue: applied ?? {},
    sample: {
      sourceChars: result.status === 'ok' ? result.data.source.length : null,
      textChars: result.status === 'ok' ? result.data.textContent.length : null,
      images: result.status === 'ok' ? result.data.images.length : null,
      apply: applied,
      error: result.status === 'ok' ? null : result.error,
    },
  };
};

const revisionsHandler: WorkHandler = async (task, context) => {
  const target = {
    pageId: task.pageId,
    wikidotId: task.wikidotId,
    claimedTotal: task.revisionClaimedTotal,
  };
  const results = await scanRevisions(context.http, context.baseUrl, [target], 1);
  const result =
    results.get(task.pageId) ??
    failed<RevisionBatch>('内部错误：修订结果 Map 缺项');
  const applied = await applyRevisionResult(context.pool, target, result, {
    observedAt: new Date().toISOString(),
    runId: context.runId,
    source: 'wikidot',
  });
  if (
    result.status === 'ok' &&
    result.data.entries.some((entry) => revisionNeedsFilesScan(entry))
  ) {
    await enqueueScanTasks(context.pool, [{
      pageId: task.pageId,
      kind: 'files',
      reasons: ['revision_type_files_changed'],
      priority: 6,
      notBefore: new Date().toISOString(),
    }]);
  }
  const resultHash =
    result.status === 'failed'
      ? null
      : hashJson(result.data.entries);
  return {
    status: result.status,
    resultHash,
    localValue: applied ?? {},
    remoteValue: { claimed_total: task.revisionClaimedTotal },
    sample: {
      claimedTotal: task.revisionClaimedTotal,
      fetchedTotal: result.diagnostics.fetchedTotal,
      apply: applied,
      error: result.status === 'ok' ? null : result.error,
    },
  };
};

const filesHandler: WorkHandler = async (task, context) => {
  const target = { pageId: task.pageId, wikidotId: task.wikidotId };
  const results = await scanFiles(context.http, context.baseUrl, [target], 1);
  const result =
    results.get(task.pageId) ??
    failed<never>('内部错误：附件结果 Map 缺项');
  await recordFileResult(context.pool, target, result, context.runId);
  return {
    status: result.status,
    resultHash: result.status === 'ok' ? hashJson(result.data.files) : null,
    sample: {
      files: result.status === 'ok' ? result.data.files.length : null,
      error: result.status === 'ok' ? null : result.error,
    },
  };
};

const metaHandler: WorkHandler = async (task, context) => {
  const results = await scanPageIds(context.http, context.baseUrl, [task.slug], 1);
  const observedAt = new Date().toISOString();
  const regressionIdentityCheck = task.reasons.includes('revision_regression_identity_check');
  let result = results.get(task.slug);
  if (result === undefined) {
    result = failed('内部错误：pageId 结果 Map 缺项');
  } else if (
    result.status === 'ok' &&
    result.data.wikidotId !== task.wikidotId
  ) {
    if (
      !regressionIdentityCheck ||
      decideRevisionRegressionIdentity(task.wikidotId, result.data.wikidotId) !== 'slug_reuse'
    ) {
      result = failed(
        `pageId 身份不一致：任务=${task.wikidotId}，响应=${result.data.wikidotId}`,
        result.diagnostics,
      );
    } else {
      const observedWikidotId = result.data.wikidotId;
      const reuse = await applySlugReuseIdentity(context.pool, {
        predecessorId: task.pageId,
        observedWikidotId,
        slug: task.slug,
        observedAt,
        runId: context.runId,
      });
      const successorId = Number(reuse.successor_id);
      const resultHash = createHash('sha256')
        .update(`${task.slug}\n${observedWikidotId}`, 'utf8')
        .digest();
      const tasksReassigned = await reassignSlugReuseTasks(
        context.pool,
        task.pageId,
        successorId,
        task.taskId,
      );

      // 旧任务的“响应身份不属于旧页”是 partial 证据；同一个响应对 successor 是 ok 正证据。
      await recordPageScan(context.pool, context.runId, task.pageId, 'meta', {
        status: 'partial',
        claimed: 1,
        fetched: 1,
        checksumOk: false,
        resultHash,
        error:
          `slug_reuse_identity_replaced:expected=${task.wikidotId};` +
          `observed=${observedWikidotId};successor_page_id=${successorId}`,
      });
      await recordPageScan(context.pool, context.runId, successorId, 'meta', {
        status: 'ok',
        claimed: 1,
        fetched: 1,
        checksumOk: true,
        resultHash,
        error: null,
      });
      await recordPageScan(context.pool, context.runId, successorId, 'revisions', {
        status: 'partial',
        claimed: task.revisionClaimedTotal,
        fetched: null,
        checksumOk: null,
        resultHash,
        error: 'slug_reuse_identity_registered:等待 revisions_full 完整抓取',
      });

      const applied = await applyObservedPageMeta(
        context,
        successorId,
        task.slug,
        observedWikidotId,
        observedAt,
      );
      const tasksEnqueued = await enqueueScanTasks(context.pool, [
        {
          pageId: successorId,
          kind: 'new_page_highfreq',
          reasons: ['slug_reuse_identity_registered'],
          priority: 100,
        },
        {
          pageId: successorId,
          kind: 'content',
          reasons: ['slug_reuse_identity_registered'],
          priority: 100,
        },
        {
          pageId: successorId,
          kind: 'revisions_full',
          reasons: ['slug_reuse_identity_registered'],
          priority: 100,
        },
      ]);
      return {
        status: 'ok',
        resultHash,
        localValue: {
          ...reuse,
          tasks_reassigned: tasksReassigned,
          tasks_enqueued: tasksEnqueued,
          page_meta: applied,
        },
        sample: {
          identityReplaced: true,
          expectedWikidotId: task.wikidotId,
          observedWikidotId,
          successorPageId: successorId,
          lineageCandidateInserted: reuse.lineage_candidate_inserted,
          tasksReassigned,
          tasksEnqueued,
          apply: applied,
        },
      };
    }
  } else if (
    result.status === 'ok' &&
    regressionIdentityCheck &&
    decideRevisionRegressionIdentity(task.wikidotId, result.data.wikidotId) ===
      'same_identity_anomaly'
  ) {
    result = partial(
      result.data,
      `revision_count 倒退且 wikidotId 相同：page_id=${task.pageId};` +
        `wikidot_id=${task.wikidotId};slug=${task.slug}`,
      result.diagnostics,
    );
  }
  const status = result.status;
  const resultHash =
    status === 'failed'
      ? null
      : createHash('sha256')
          .update(`${task.slug}\n${result.data.wikidotId}`, 'utf8')
          .digest();
  await recordPageScan(context.pool, context.runId, task.pageId, 'meta', {
    status,
    claimed: 1,
    fetched: status === 'failed' ? 0 : 1,
    checksumOk: status === 'ok',
    resultHash,
    error: status === 'ok' ? null : result.error,
  });
  let applied: Record<string, unknown> | null = null;
  if (status === 'ok') {
    applied = await applyObservedPageMeta(
      context,
      task.pageId,
      task.slug,
      task.wikidotId,
      observedAt,
    );
  }
  return {
    status,
    resultHash,
    localValue: applied ?? {},
    sample: {
      observedWikidotId: status === 'failed' ? null : result.data.wikidotId,
      apply: applied,
      error: status === 'ok' ? null : result.error,
    },
  };
};

async function applyObservedPageMeta(
  context: WorkHandlerContext,
  pageId: number,
  slug: string,
  wikidotId: number,
  observedAt: string,
): Promise<Record<string, unknown>> {
  const response = await query<{ result: Record<string, unknown> }>(
    context.pool,
    'work.meta:apply_page_meta',
    `SELECT ingest.apply_page_meta(
       p_page       => $1::int,
       p_attrs      => jsonb_build_object('slug', $2::text),
       p_observed   => $3::timestamptz,
       p_source     => 'wikidot',
       p_run        => $4::bigint,
       p_wikidot_id => $5::int
     ) AS result`,
    [
      pageId,
      slug,
      toPgTimestamptz(observedAt),
      context.runId,
      wikidotId,
    ],
  );
  return response.rows[0]?.result ?? {};
}

const discussionHandler: WorkHandler = async (task, context) => {
  const start = await cached(context, 'forum-start', async () => {
    const result = await scanForumStart(context.http, context.baseUrl);
    if (result.status === 'ok') {
      await applyForumBatch(
        context.pool,
        { categories: result.data.categories, threads: [], posts: [] },
        new Date().toISOString(),
        context.runId,
      );
    }
    return result;
  });
  const target: ForumDiscussionTarget = {
    pageId: task.pageId,
    wikidotId: task.wikidotId,
    slug: task.slug,
    claimedTotal: task.commentCount,
    expectedThreadId: task.expectedThreadId,
    scanKind: task.kind === 'forum' ? 'forum' : 'discussion',
  };
  const result: CollectResult<Awaited<
    ReturnType<typeof scanPageDiscussions>
  > extends Map<number, CollectResult<infer T>> ? T : never> =
    start.status === 'failed'
      ? failed(`ForumStartModule 前置失败：${start.error}`)
      : (
          await scanPageDiscussions(context.http, context.baseUrl, [target], 1)
        ).get(task.pageId) ?? failed('内部错误：页面讨论结果 Map 缺项');
  const applied = await applyForumDiscussion(
    context.pool,
    target,
    result,
    [],
    new Date().toISOString(),
    context.runId,
  );
  const resultHash =
    applied?.resultHash ??
    (result.status === 'failed'
      ? null
      : forumBatchResultHash({
          categories: [],
          threads: [result.data.thread],
          posts: result.data.posts,
        }));
  return {
    status: result.status,
    resultHash,
    localValue: applied?.forum ?? {},
    remoteValue: {
      claimed_total: task.commentCount,
      expected_thread_id: task.expectedThreadId,
    },
    sample: {
      threadId: result.status === 'failed' ? null : result.data.threadId,
      posts: result.status === 'failed' ? null : result.data.posts.length,
      apply: applied,
      error: result.status === 'ok' ? null : result.error,
    },
  };
};

interface ConventionRefresh {
  status: 'ok' | 'partial' | 'failed';
  resultHash: Buffer | null;
  fetched: number;
  summary: Record<string, unknown>;
  error: string | null;
}

const attributionsHandler: WorkHandler = async (task, context) => {
  const refresh = await cached(context, 'conventions', () => refreshConventions(context));
  await recordPageScan(context.pool, context.runId, task.pageId, 'attributions', {
    status: refresh.status,
    claimed: null,
    fetched: refresh.fetched,
    checksumOk: refresh.status === 'ok',
    resultHash: refresh.resultHash,
    error: refresh.error,
  });
  return {
    status: refresh.status,
    resultHash: refresh.resultHash,
    localValue: refresh.summary,
    sample: refresh.summary,
  };
};

const deletionHandler: WorkHandler = async (task, context) => {
  const deletionTask: ClaimedDeletionTask = {
    taskId: task.taskId,
    pageId: task.pageId,
    wikidotId: task.wikidotId,
    slug: task.slug,
    attempts: task.attempts,
    reasons: task.reasons,
  };
  const result = await processDeletionTask(
    context.pool,
    context.http,
    context.baseUrl,
    deletionTask,
    context.runId,
    context.workerId,
    new Date().toISOString(),
  );
  return {
    status: result.status === 'failed' ? 'failed' : 'ok',
    resultHash: null,
    finalized: true,
    sample: {
      deletionStatus: result.status,
      confirmation: result.confirmation,
      evidenceRun: result.evidence?.current.sitemap.id ?? null,
      eventSeq: result.eventSeq,
      error: result.error ?? null,
    },
  };
};

export const WORK_HANDLER_REGISTRY = {
  confirm_deleted: deletionHandler,
  new_page_highfreq: voteHandler,
  votes_full: voteHandler,
  meta: metaHandler,
  sitemap_delta: metaHandler,
  content: contentHandler,
  revisions_full: revisionsHandler,
  files: filesHandler,
  forum: discussionHandler,
  discussion: discussionHandler,
  attributions: attributionsHandler,
} satisfies Record<ScanTaskKind, WorkHandler>;

export const REGISTERED_WORK_KINDS = Object.freeze(
  Object.keys(WORK_HANDLER_REGISTRY) as ScanTaskKind[],
);

export function pageScanKindForTask(kind: ScanTaskKind): PageScanKind {
  switch (kind) {
    case 'votes_full':
    case 'new_page_highfreq':
      return 'votes';
    case 'revisions_full':
      return 'revisions';
    case 'content':
      return 'content';
    case 'files':
      return 'files';
    case 'forum':
      return 'forum';
    case 'discussion':
      return 'discussion';
    case 'attributions':
      return 'attributions';
    case 'meta':
    case 'sitemap_delta':
    case 'confirm_deleted':
      return 'meta';
  }
}

export async function recordUnhandledFailure(
  context: WorkHandlerContext,
  task: ClaimedWorkTask,
  error: string,
): Promise<void> {
  if (task.kind === 'votes_full' || task.kind === 'new_page_highfreq') {
    await recordVoteScanFailure(
      context.pool,
      toVoteTarget(task),
      context.runId,
      error,
    );
    return;
  }
  await recordPageScan(
    context.pool,
    context.runId,
    task.pageId,
    pageScanKindForTask(task.kind),
    {
      status: 'failed',
      claimed:
        task.kind === 'revisions_full'
          ? task.revisionClaimedTotal
          : task.kind === 'forum' || task.kind === 'discussion'
            ? task.commentCount
            : null,
      fetched: null,
      checksumOk: false,
      resultHash: null,
      error,
    },
  );
}

async function refreshConventions(
  context: WorkHandlerContext,
): Promise<ConventionRefresh> {
  const knownRows = await query<{ slug: string; wikidot_id: number }>(
    context.pool,
    'work.conventions:known_ids',
    `SELECT lower(slug) AS slug, wikidot_id
       FROM serve.page_current
      WHERE status = 'live'`,
  );
  const known = new Map(
    knownRows.rows.map((row) => [row.slug, Number(row.wikidot_id)] as const),
  );
  const [attributions, alternateTitles] = await Promise.all([
    collectAttributions(context.http, context.baseUrl, {
      knownWikidotIds: known,
      concurrency: Math.min(2, context.concurrency),
    }),
    collectAlternateTitles(context.http, context.baseUrl, {
      knownWikidotIds: known,
      concurrency: context.concurrency,
    }),
  ]);

  let attributionApply: Record<string, unknown> | null = null;
  let alternateApply: Record<string, unknown> | null = null;
  if (attributions.result.status !== 'failed') {
    attributionApply = await applyNewAttributionEntriesBySlug(
      context.pool,
      attributions.result.data.entries,
      {
        observedAt: new Date().toISOString(),
        runId: context.runId,
        source: 'wikidot_conventions',
      },
    ) as unknown as Record<string, unknown>;
  }
  if (alternateTitles.result.status !== 'failed') {
    alternateApply = await applyAlternateTitleObservations(
      context.pool,
      alternateTitles.result,
      {
        observedAt: new Date().toISOString(),
        runId: context.runId,
        source: 'wikidot_conventions',
      },
    ) as unknown as Record<string, unknown>;
  }

  const statuses = [attributions.result.status, alternateTitles.result.status];
  const status: ConventionRefresh['status'] =
    statuses.every((value) => value === 'ok')
      ? 'ok'
      : statuses.every((value) => value === 'failed')
        ? 'failed'
        : 'partial';
  const hashes = [
    attributions.result.status === 'failed'
      ? null
      : attributions.result.data.sourceHashes,
    alternateTitles.result.status === 'failed'
      ? null
      : alternateTitles.result.data.sourceHashes,
  ];
  const errors = [
    attributions.result.status === 'ok' ? null : attributions.result.error,
    alternateTitles.result.status === 'ok' ? null : alternateTitles.result.error,
  ].filter((value): value is string => value !== null);
  return {
    status,
    resultHash:
      status === 'failed' ? null : hashJson(hashes),
    fetched:
      (attributions.result.status === 'failed'
        ? 0
        : attributions.result.data.entries.length) +
      (alternateTitles.result.status === 'failed'
        ? 0
        : alternateTitles.result.data.entries.length),
    summary: {
      attributionStatus: attributions.result.status,
      alternateTitleStatus: alternateTitles.result.status,
      attributionApply,
      alternateApply,
      sourcePages:
        attributions.sources.size + alternateTitles.sources.size,
    },
    error: errors.length === 0 ? null : errors.join('；'),
  };
}

async function recordPageScan(
  pool: Pool,
  runId: number | null,
  pageId: number,
  kind: PageScanKind,
  args: {
    status: 'ok' | 'partial' | 'failed';
    claimed: number | null;
    fetched: number | null;
    checksumOk: boolean | null;
    resultHash: Buffer | null;
    error: string | null;
  },
): Promise<void> {
  await persistPageScan(
    pool,
    {
      runId,
      pageId,
      kind,
      status: args.status,
      claimedTotal: args.claimed,
      fetchedTotal: args.fetched,
      checksumOk: args.checksumOk,
      resultHash: args.resultHash,
      error: args.error,
    },
  );
}

function toVoteTarget(task: ClaimedWorkTask): VoteTarget {
  return {
    pageId: task.pageId,
    wikidotId: task.wikidotId,
    claimedTotal: task.claimedTotal,
    claimedRating: task.claimedRating,
  };
}

function tier1Claims(task: ClaimedWorkTask): Record<string, unknown> {
  return {
    claimed_total: task.claimedTotal,
    claimed_rating: task.claimedRating,
    tier1_run_id: task.tier1RunId,
  };
}

function hashJson(value: unknown): Buffer {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest();
}

/**
 * failed 也必须有稳定证据哈希，否则稳定失败永远把 stable_count 重置为 0，
 * 无法进入 irreconcilable 低频复查。哈希与实际可落库的清洗后证据同源。
 */
function hashFailureEvidence(domain: string, error: string): Buffer {
  const evidence = sanitizePageScanError(error, `${domain}:failure_hash`) ?? '';
  const httpStatus = /\bHTTP ([1-5]\d{2}) for https?:\/\//.exec(evidence)?.[1];
  // HTTP 状态是稳定矛盾类别；404 错误页正文可能带边缘节点/时间戳，不能让这些展示细节
  // 永久重置 stable_count。完整原文仍逐轮保存在 page_scan.error，不丢取证信息。
  const stableEvidence = httpStatus === undefined
    ? evidence
    : `http_status:${httpStatus}`;
  return createHash('sha256')
    .update(`${domain}:failed:v1\n`, 'utf8')
    .update(stableEvidence, 'utf8')
    .digest();
}

async function cached<T>(
  context: WorkHandlerContext,
  key: string,
  factory: () => Promise<T>,
): Promise<T> {
  let promise = context.cache.get(key) as Promise<T> | undefined;
  if (promise === undefined) {
    promise = factory();
    context.cache.set(key, promise);
  }
  return promise;
}
