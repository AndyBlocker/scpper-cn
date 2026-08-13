/**
 * 论坛两层增量发现：ForumStart 一次全局信号，只有变化分类才翻“最新回复”分页。
 * 本模块不抓 thread 正文；它只产出 post_count 变化的 thread id，交 steady 队列深扫。
 */

import type { Pool } from 'pg';

import type { HttpClient } from '../http/client.js';
import { query, toPgTimestamptz } from '../store/db.js';
import { toPgJson } from '../store/pgText.js';
import { scanForumCategoryPage, type ForumCategoryPage, type ForumCategoryRecord, type ForumThreadRecord } from './forum.js';
import type { CollectResult } from './result.js';

export interface ForumCategoryIncrementalState {
  categoryId: number;
  sweptThreadCount: number | null;
  sweptPostCount: number | null;
  sweptLastPostAt: string | null;
  sweptLastThreadId: number | null;
  sweptLastPostId: number | null;
  sweptAt: string | null;
}

export interface ForumIncrementalCategoryResult {
  categoryId: number;
  status: 'ok' | 'partial' | 'failed';
  changedThreadIds: number[];
  pagesFetched: number;
  totalPages: number | null;
  stoppedAtWatermark: boolean;
  baselineOnly: boolean;
  error: string | null;
}

export type ForumCategoryPageFetcher = (
  categoryId: number,
  pageNo: number,
) => Promise<CollectResult<ForumCategoryPage>>;

export interface ForumCategoryScanPlan {
  category: ForumCategoryRecord;
  maxPages: number;
}

function nullableNumber(value: string | number | null): number | null {
  return value === null ? null : Number(value);
}

function nullableIso(value: string | Date | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

function signal(category: ForumCategoryRecord): readonly unknown[] {
  return [
    category.threadCount,
    category.postCount,
    category.lastPostAt ?? null,
    category.lastThreadId ?? null,
    category.lastPostId ?? null,
  ];
}

function sweptSignal(state: ForumCategoryIncrementalState): readonly unknown[] {
  return [
    state.sweptThreadCount,
    state.sweptPostCount,
    state.sweptLastPostAt,
    state.sweptLastThreadId,
    state.sweptLastPostId,
  ];
}

export function forumCategorySignalChanged(
  category: ForumCategoryRecord,
  state: ForumCategoryIncrementalState | undefined,
): boolean {
  if (state === undefined || state.sweptAt === null) return true;
  return JSON.stringify(signal(category)) !== JSON.stringify(sweptSignal(state));
}

export function changedForumCategoryIds(
  categories: readonly ForumCategoryRecord[],
  states: ReadonlyMap<number, ForumCategoryIncrementalState>,
): number[] {
  return categories
    .filter((category) => forumCategorySignalChanged(category, states.get(category.id)))
    .map((category) => category.id);
}

export function changedThreadsOnCategoryPage(
  threads: readonly ForumThreadRecord[],
  knownPostCounts: ReadonlyMap<number, number>,
): number[] {
  return threads
    .filter((thread) => knownPostCounts.get(thread.id) !== thread.postCount)
    .map((thread) => thread.id);
}

function crossedWatermark(
  threads: readonly ForumThreadRecord[],
  watermark: string,
): boolean {
  const watermarkMs = Date.parse(watermark);
  if (!Number.isFinite(watermarkMs)) throw new TypeError(`非法 forum watermark ${watermark}`);
  // 置顶帖不参与停止判断：它们固定排在前面，最后回复可能远老于真正的最新普通帖。
  return threads.some((thread) => {
    if (thread.sticky === true) return false;
    const activityMs = Date.parse(thread.lastPostAt ?? thread.createdAt);
    return Number.isFinite(activityMs) && activityMs <= watermarkMs;
  });
}

/**
 * 只扫描一个已由 ForumStart 判定变化的分类。初次建水位只取第一页；历史冷数据由
 * catchup 队列负责，不能在第一次增量轮偷偷退化成全分类 87k 枚举。
 */
export async function scanChangedForumCategory(
  category: ForumCategoryRecord,
  state: ForumCategoryIncrementalState | undefined,
  knownPostCounts: ReadonlyMap<number, number>,
  fetchPage: ForumCategoryPageFetcher,
  maxPages = 25,
): Promise<ForumIncrementalCategoryResult> {
  const baselineOnly = state === undefined || state.sweptAt === null;
  const watermark = baselineOnly ? null : state.sweptLastPostAt;
  const changed = new Set<number>();
  let totalPages: number | null = null;
  let pagesFetched = 0;
  let stopped = false;

  for (let pageNo = 1; pageNo <= maxPages; pageNo++) {
    const page = await fetchPage(category.id, pageNo);
    if (page.status !== 'ok') {
      return {
        categoryId: category.id,
        status: page.status,
        changedThreadIds: [...changed],
        pagesFetched,
        totalPages,
        stoppedAtWatermark: false,
        baselineOnly,
        error: page.error,
      };
    }
    pagesFetched++;
    const pageTotal = page.data.pager.totalPages;
    if (
      !baselineOnly &&
      (
      page.data.claimedThreadCount !== category.threadCount ||
      page.data.claimedPostCount !== category.postCount ||
      (totalPages !== null && pageTotal !== totalPages)
      )
    ) {
      return {
        categoryId: category.id,
        status: 'partial',
        changedThreadIds: [...changed],
        pagesFetched,
        totalPages,
        stoppedAtWatermark: false,
        baselineOnly,
        error:
          `ForumStart(${category.threadCount}/${category.postCount}) 与 category page=${pageNo}` +
          `(${page.data.claimedThreadCount}/${page.data.claimedPostCount}) 计数漂移，保留旧水位下轮重试`,
      };
    }
    totalPages = pageTotal;
    for (const threadId of changedThreadsOnCategoryPage(page.data.threads, knownPostCounts)) {
      changed.add(threadId);
    }

    if (baselineOnly || pageNo >= totalPages) {
      stopped = true;
      break;
    }
    if (watermark !== null && crossedWatermark(page.data.threads, watermark)) {
      stopped = true;
      break;
    }
  }

  return {
    categoryId: category.id,
    status: stopped ? 'ok' : 'partial',
    changedThreadIds: [...changed],
    pagesFetched,
    totalPages,
    stoppedAtWatermark: stopped && !baselineOnly && watermark !== null,
    baselineOnly,
    error: stopped ? null : `超过单分类 ${maxPages} 页预算，未推进水位，下轮续扫`,
  };
}

/**
 * 把全局页预算先按变化分类公平切片，并旋转每轮的首分类。
 * 当 maxPages >= 分类数时每类本轮至少 1 页；分类数更多时，rotationOffset 仍保证
 * 任一分类至多等待 ceil(n/maxPages) 轮获得名额。剩余额按轮转顺序逐页分配。
 */
export function planForumIncrementalCategories(
  categories: readonly ForumCategoryRecord[],
  maxPages: number,
  rotationOffset = 0,
): ForumCategoryScanPlan[] {
  const pageBudget = Math.max(0, Math.floor(maxPages));
  if (categories.length === 0 || pageBudget === 0) return [];
  const start = ((Math.floor(rotationOffset) % categories.length) + categories.length) %
    categories.length;
  const rotated = [
    ...categories.slice(start),
    ...categories.slice(0, start),
  ];
  const allocations = new Array<number>(rotated.length).fill(0);
  for (let page = 0; page < pageBudget; page++) {
    allocations[page % rotated.length]!++;
  }
  return rotated.flatMap((category, index) => {
    const allocation = allocations[index]!;
    return allocation === 0 ? [] : [{ category, maxPages: allocation }];
  });
}

/** 回归友好的总规划器：没有变化的分类绝不会调用 fetchPage。 */
export async function discoverChangedForumThreads(
  categories: readonly ForumCategoryRecord[],
  states: ReadonlyMap<number, ForumCategoryIncrementalState>,
  knownPostCounts: ReadonlyMap<number, number>,
  fetchPage: ForumCategoryPageFetcher,
  maxPages = 25,
  rotationOffset = 0,
): Promise<ForumIncrementalCategoryResult[]> {
  const changed = categories.filter((category) =>
    forumCategorySignalChanged(category, states.get(category.id))
  );
  const plan = planForumIncrementalCategories(
    changed,
    maxPages,
    rotationOffset,
  );
  // 每个变化分类的第一页同时入共享 FIFO gate；只有各自第一页完成后才会申请第二页。
  // 因此在当前 16 分类、40 页生产预算下，任何一个大分类都不能在其余分类启动前
  // 串行吃完整轮墙钟预算。
  return Promise.all(plan.map(async ({ category, maxPages: categoryMaxPages }) => {
    const state = states.get(category.id);
    return scanChangedForumCategory(
      category,
      state,
      knownPostCounts,
      fetchPage,
      categoryMaxPages,
    );
  }));
}

export async function fetchForumIncrementalStates(
  pool: Pool,
): Promise<Map<number, ForumCategoryIncrementalState>> {
  const result = await query<{
    category_id: string;
    swept_thread_count: number | null;
    swept_post_count: number | null;
    swept_last_post_at: string | Date | null;
    swept_last_thread_id: string | null;
    swept_last_post_id: string | null;
    swept_at: string | Date | null;
  }>(
    pool,
    'forum_incremental:states',
    `SELECT category_id::text, swept_thread_count, swept_post_count,
            swept_last_post_at, swept_last_thread_id::text, swept_last_post_id::text, swept_at
       FROM meta.forum_incremental_category_state`,
  );
  return new Map(result.rows.map((row) => [
    Number(row.category_id),
    {
      categoryId: Number(row.category_id),
      sweptThreadCount: nullableNumber(row.swept_thread_count),
      sweptPostCount: nullableNumber(row.swept_post_count),
      sweptLastPostAt: nullableIso(row.swept_last_post_at),
      sweptLastThreadId: nullableNumber(row.swept_last_thread_id),
      sweptLastPostId: nullableNumber(row.swept_last_post_id),
      sweptAt: nullableIso(row.swept_at),
    },
  ]));
}

export async function fetchForumThreadPostCounts(pool: Pool): Promise<Map<number, number>> {
  const result = await query<{ id: string; post_count: number }>(
    pool,
    'forum_incremental:thread_post_counts',
    `SELECT id::text, post_count FROM ingest.forum_thread WHERE NOT is_deleted`,
  );
  return new Map(result.rows.map((row) => [Number(row.id), Number(row.post_count)]));
}

export async function observeForumCategorySignals(
  pool: Pool,
  categories: readonly ForumCategoryRecord[],
  observedAt: string,
): Promise<void> {
  if (categories.length === 0) return;
  await query(
    pool,
    'forum_incremental:observe_signals',
    `INSERT INTO meta.forum_incremental_category_state AS s(
       category_id, observed_thread_count, observed_post_count, observed_last_post_at,
       observed_last_thread_id, observed_last_post_id, signal_observed_at, updated_at
     )
     SELECT x.id, x.thread_count, x.post_count, x.last_post_at,
            x.last_thread_id, x.last_post_id, $2::timestamptz, now()
       FROM jsonb_to_recordset($1::jsonb) AS x(
         id bigint, thread_count int, post_count int, last_post_at timestamptz,
         last_thread_id bigint, last_post_id bigint
       )
     ON CONFLICT (category_id) DO UPDATE
       SET observed_thread_count = EXCLUDED.observed_thread_count,
           observed_post_count = EXCLUDED.observed_post_count,
           observed_last_post_at = EXCLUDED.observed_last_post_at,
           observed_last_thread_id = EXCLUDED.observed_last_thread_id,
           observed_last_post_id = EXCLUDED.observed_last_post_id,
           signal_observed_at = EXCLUDED.signal_observed_at,
           updated_at = now()`,
    [
      toPgJson(categories.map((category) => ({
        id: category.id,
        thread_count: category.threadCount,
        post_count: category.postCount,
        last_post_at: category.lastPostAt ?? null,
        last_thread_id: category.lastThreadId ?? null,
        last_post_id: category.lastPostId ?? null,
      })), 'forum.incremental.signals'),
      toPgTimestamptz(observedAt),
    ],
  );
}

export async function finishForumCategorySweep(
  pool: Pool,
  category: ForumCategoryRecord,
  result: ForumIncrementalCategoryResult,
  sweptAt: string,
): Promise<void> {
  await query(
    pool,
    'forum_incremental:finish_sweep',
    `UPDATE meta.forum_incremental_category_state
        SET swept_thread_count = CASE WHEN $2::boolean THEN $3 ELSE swept_thread_count END,
            swept_post_count = CASE WHEN $2::boolean THEN $4 ELSE swept_post_count END,
            swept_last_post_at = CASE WHEN $2::boolean THEN $5::timestamptz ELSE swept_last_post_at END,
            swept_last_thread_id = CASE WHEN $2::boolean THEN $6 ELSE swept_last_thread_id END,
            swept_last_post_id = CASE WHEN $2::boolean THEN $7 ELSE swept_last_post_id END,
            swept_at = CASE WHEN $2::boolean THEN $8::timestamptz ELSE swept_at END,
            last_error = $9,
            updated_at = now()
      WHERE category_id = $1`,
    [
      category.id,
      result.status === 'ok',
      category.threadCount,
      category.postCount,
      category.lastPostAt ?? null,
      category.lastThreadId ?? null,
      category.lastPostId ?? null,
      toPgTimestamptz(sweptAt),
      result.error,
    ],
  );
}

export function forumCategoryPageFetcher(
  http: HttpClient,
  baseUrl: string,
): ForumCategoryPageFetcher {
  return (categoryId, pageNo) => scanForumCategoryPage(http, baseUrl, categoryId, pageNo);
}
