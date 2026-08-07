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
import { scanRestrictedListPageContent } from '../collect/restrictedListPages.js';
import { failed, partial, type CollectResult } from '../collect/result.js';
import { applyRevisionResult, scanRevisions, type RevisionBatch } from '../collect/revisions.js';
import {
  applyCurrentContent,
  scanCurrentContents,
  scanRestrictedCurrentContents,
} from '../collect/source.js';
import {
  applyCollectedVoteSnapshot,
  collectVoteSnapshots,
  recordVoteScanFailure,
  type VoteTarget,
} from '../collect/votes.js';
import type { HttpClient } from '../http/client.js';
import {
  isRestrictedSlug,
  RESTRICTED_STABLE_PROXY_URL,
  type RestrictedSourceSession,
} from '../http/restrictedSession.js';
import { query } from '../store/db.js';
import {
  enqueueScanTasks,
  recordPageScan as persistPageScan,
  type PageScanKind,
  type ScanTaskKind,
} from '../store/meta.js';
import { sanitizePageScanError } from '../store/pgText.js';
import { type ClaimedWorkTask } from '../store/workQueue.js';
import {
  applyConfirmedSlugReuse,
  applyObservedPageMeta,
} from './identityCheck.js';
import { applyRestrictedRenderedContent } from './restrictedPage.js';

export interface WorkHandlerContext {
  pool: Pool;
  http: HttpClient;
  /** adult:/wanderers-adult: 的所有页级出站固定走 7890；缺失时 fail closed。 */
  restrictedHttp?: HttpClient;
  /** 只允许受限 content handler 取 ViewSource；讨论/投票/修订不得调用。 */
  restrictedSession?: RestrictedSourceSession;
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
    httpForWorkTask(context, task),
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
  if (isRestrictedSlug(task.slug)) {
    const taskHttp = httpForWorkTask(context, task);
    const rendered = await scanRestrictedListPageContent(
      taskHttp,
      context.baseUrl,
      task.slug,
    );
    if (rendered.status === 'failed') {
      const error = `受限 ListPages 单页正文观测失败；不解释为空正文：${rendered.error}`;
      await recordPageScan(context.pool, context.runId, task.pageId, 'content', {
        status: 'failed',
        claimed: 1,
        fetched: null,
        checksumOk: false,
        resultHash: null,
        error,
      });
      return { status: 'failed', resultHash: null, sample: { error, emptyResult: false } };
    }
    if (context.restrictedSession === undefined) {
      const error =
        `受限源码登录 session 不可用；跳过 ${task.slug} ViewSource，emptyResult=false`;
      await recordPageScan(context.pool, context.runId, task.pageId, 'content', {
        status: 'failed',
        claimed: 1,
        fetched: null,
        checksumOk: false,
        resultHash: null,
        error,
      });
      return { status: 'failed', resultHash: null, sample: { error, emptyResult: false } };
    }
    const target = {
      pageId: task.pageId,
      wikidotId: task.wikidotId,
      slug: task.slug,
      rendered: rendered.data,
    };
    const sources = await scanRestrictedCurrentContents(
      context.restrictedSession,
      context.baseUrl,
      [target],
      1,
    );
    const sourceResult =
      sources.get(task.pageId) ?? failed<never>('内部错误：受限源码结果 Map 缺项');
    const observedAt = new Date().toISOString();
    if (sourceResult.status !== 'ok') {
      await applyCurrentContent(context.pool, target, sourceResult, {
        observedAt,
        runId: context.runId,
        observationSource: 'wikidot_authenticated',
      });
      return {
        status: 'failed',
        resultHash: null,
        sample: { error: sourceResult.error, emptyResult: false, proxyUrl: taskHttp.proxyUrl },
      };
    }
    const renderedApplied = await applyRestrictedRenderedContent(context.pool, {
      contentHtml: rendered.data.contentHtml,
      textContent: rendered.data.textContent,
      pageId: task.pageId,
      wikidotId: task.wikidotId,
      observedAt,
      runId: context.runId,
    });
    const sourceApplied = await applyCurrentContent(context.pool, target, sourceResult, {
      observedAt,
      runId: context.runId,
      observationSource: 'wikidot_authenticated',
    });
    return {
      status: 'ok',
      resultHash: Buffer.from(sourceResult.data.sha256Hex, 'hex'),
      localValue: { rendered: renderedApplied, source: sourceApplied },
      sample: {
        sourceChars: sourceResult.data.source.length,
        sourceSha: sourceResult.data.sha256Hex,
        contentBytes: Buffer.byteLength(rendered.data.contentHtml),
        textChars: rendered.data.textContent.length,
        images: sourceResult.data.images.length,
        observationSource: 'wikidot_authenticated',
        proxyUrl: taskHttp.proxyUrl,
      },
    };
  }
  const target = { pageId: task.pageId, wikidotId: task.wikidotId, slug: task.slug };
  const results = await scanCurrentContents(httpForWorkTask(context, task), context.baseUrl, [target], 1);
  const result =
    results.get(task.pageId) ??
    failed<never>('内部错误：当前内容结果 Map 缺项');
  const applied = await applyCurrentContent(context.pool, target, result, {
    observedAt: new Date().toISOString(),
    runId: context.runId,
    observationSource: 'wikidot_anonymous',
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
  const results = await scanRevisions(httpForWorkTask(context, task), context.baseUrl, [target], 1);
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
  const results = await scanFiles(httpForWorkTask(context, task), context.baseUrl, [target], 1);
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
  if (isRestrictedSlug(task.slug)) {
    if (!task.reasons.some((reason) => reason.includes('identity'))) {
      // 普通元数据刷新仍以 ListPages 为权威；复用受限 content 路径会同时刷新
      // title/tags/owner/createdAt/claims/rendered content，且不碰匿名 URL pageId。
      return contentHandler(task, context);
    }
    const error =
      '受限分类 meta 身份不得走匿名 URL；身份只允许由 ListPages + 固定 7890 登录发现链路更新';
    await recordPageScan(context.pool, context.runId, task.pageId, 'meta', {
      status: 'failed',
      claimed: 1,
      fetched: null,
      checksumOk: false,
      resultHash: null,
      error,
    });
    return { status: 'failed', resultHash: null, sample: { error, skippedEmptyResult: true } };
  }
  const results = await scanPageIds(httpForWorkTask(context, task), context.baseUrl, [task.slug], 1);
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
      const reuse = await applyConfirmedSlugReuse(
        context,
        task,
        observedWikidotId,
        observedAt,
        task.taskId,
      );
      return {
        status: 'ok',
        resultHash: reuse.resultHash,
        localValue: {
          ...reuse.lifecycle,
          tasks_reassigned: reuse.tasksReassigned,
          tasks_enqueued: reuse.tasksEnqueued,
          page_meta: reuse.apply,
        },
        sample: {
          identityReplaced: true,
          expectedWikidotId: task.wikidotId,
          observedWikidotId,
          successorPageId: reuse.successorPageId,
          lineageCandidateInserted: reuse.lineageCandidateInserted,
          tasksReassigned: reuse.tasksReassigned,
          tasksEnqueued: reuse.tasksEnqueued,
          apply: reuse.apply,
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
      context.pool,
      context.runId,
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

const discussionHandler: WorkHandler = async (task, context) => {
  const taskHttp = httpForWorkTask(context, task);
  const start = await cached(context, `forum-start:${taskHttp.proxyUrl ?? 'direct'}`, async () => {
    const result = await scanForumStart(taskHttp, context.baseUrl);
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
          await scanPageDiscussions(httpForWorkTask(context, task), context.baseUrl, [target], 1)
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
  const taskHttp = httpForWorkTask(context, task);
  const refresh = await cached(context, `conventions:${taskHttp.proxyUrl ?? 'direct'}`, () =>
    refreshConventions({ ...context, http: taskHttp }),
  );
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
    httpForWorkTask(context, task),
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

export function httpForWorkTask(
  context: Pick<WorkHandlerContext, 'http' | 'restrictedHttp'>,
  task: Pick<ClaimedWorkTask, 'slug'>,
): HttpClient {
  if (!isRestrictedSlug(task.slug)) return context.http;
  const restricted = context.restrictedHttp;
  if (restricted === undefined || restricted.proxyUrl !== RESTRICTED_STABLE_PROXY_URL) {
    throw new Error(
      `受限分类任务 ${task.slug} 缺少固定 ${RESTRICTED_STABLE_PROXY_URL} 客户端；拒绝回落通用出口`,
    );
  }
  return restricted;
}

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
