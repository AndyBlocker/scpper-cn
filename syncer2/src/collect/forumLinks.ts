/**
 * v1 页面讨论关联的过渡结转。
 *
 * v1 的 33,633 条 ForumThread.pageId 是用“thread 标题当 slug”猜出来的，实测约 57%
 * 无法命中。它们不是权威值，但不能直接丢弃：回填完成前最多会让 32,872 页讨论区为空，
 * BFF slug 只能兜底救回 14,361 页，同期 PAGE_REPLY 提醒也会停发。
 *
 * 所以这里保留关联并明确标成 inferred。ForumCommentsListModule 以后反解到的值是
 * verified：verified 会覆盖 inferred；反方向永远不允许。
 */

import type { Pool } from 'pg';

import { query } from '../store/db.js';
import { toPgJson } from '../store/pgText.js';
import { chunk } from '../util/concurrency.js';

export interface InferredForumLink {
  threadId: number;
  pageId: number;
  wikidotId: number;
}

export interface InferredForumLinkApplySummary {
  selected: number;
  applied: number;
  skippedVerified: number;
  skippedUnmarkedExisting: number;
  missingThread: number;
  missingPage: number;
  identityMismatch: number;
}

interface ApplyRow {
  selected: number;
  applied: number;
  skipped_verified: number;
  skipped_unmarked_existing: number;
  missing_thread: number;
  missing_page: number;
  identity_mismatch: number;
}

/** 从 v1 只读事务取得已存在的猜测关联；不重新运行 title-as-slug 猜法。 */
export async function loadV1InferredForumLinks(pool: Pool): Promise<InferredForumLink[]> {
  const db = await pool.connect();
  try {
    await db.query('BEGIN READ ONLY');
    const result = await db.query<{
      thread_id: number;
      page_id: number;
      wikidot_id: number;
    }>(
      `SELECT ft.id AS thread_id,
              ft."pageId" AS page_id,
              p."wikidotId" AS wikidot_id
         FROM "ForumThread" ft
         JOIN "Page" p ON p.id = ft."pageId"
        WHERE ft."pageId" IS NOT NULL
        ORDER BY ft.id`,
    );
    await db.query('COMMIT');
    return result.rows.map((row) => ({
      threadId: Number(row.thread_id),
      pageId: Number(row.page_id),
      wikidotId: Number(row.wikidot_id),
    }));
  } catch (err) {
    await db.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    db.release();
  }
}

/**
 * 只更新已经回填存在的 forum_thread。
 *
 * 无标记但 page_id 与 v1 输入相同，视为“论坛实体已先回填、现在补来源标记”；若不同则
 * 按来源未知的既有值保守跳过。page_id 为空或已明确为 inferred 的行也可写。
 * pageId + wikidotId 双重校验防 S1 身份错位把讨论串挂到别的页面。
 */
export async function applyInferredForumLinks(
  pool: Pool,
  links: readonly InferredForumLink[],
): Promise<InferredForumLinkApplySummary> {
  assertValidLinks(links);
  const summary = emptySummary();
  for (const part of chunk(links, 500)) {
    const result = await query<ApplyRow>(
      pool,
      'forum:apply_inferred_page_links',
      `WITH incoming AS (
         SELECT *
           FROM jsonb_to_recordset($1::jsonb)
                AS x(thread_id bigint, page_id int, wikidot_id int)
       ),
       classified AS (
         SELECT i.*,
                p.id AS found_page_id,
                p.wikidot_id AS found_wikidot_id,
                ft.id AS found_thread_id,
                ft.page_id AS old_page_id,
                ft.page_id_source AS old_source
           FROM incoming i
           LEFT JOIN ingest.page p ON p.id = i.page_id
           LEFT JOIN ingest.forum_thread ft ON ft.id = i.thread_id
       ),
       updated AS (
         UPDATE ingest.forum_thread ft
            SET page_id = c.page_id,
                page_id_source = 'inferred'
           FROM classified c
          WHERE ft.id = c.thread_id
            AND c.found_page_id IS NOT NULL
            AND c.found_wikidot_id = c.wikidot_id
            AND (
              c.old_page_id IS NULL
              OR c.old_source = 'inferred'
              OR (c.old_source IS NULL AND c.old_page_id = c.page_id)
            )
          RETURNING ft.id
       )
       SELECT count(*)::int AS selected,
              (SELECT count(*)::int FROM updated) AS applied,
              count(*) FILTER (WHERE old_source = 'verified')::int AS skipped_verified,
              count(*) FILTER (
                WHERE old_page_id IS NOT NULL
                  AND old_source IS NULL
                  AND old_page_id <> page_id
              )::int AS skipped_unmarked_existing,
              count(*) FILTER (WHERE found_thread_id IS NULL)::int AS missing_thread,
              count(*) FILTER (WHERE found_page_id IS NULL)::int AS missing_page,
              count(*) FILTER (
                WHERE found_page_id IS NOT NULL AND found_wikidot_id <> wikidot_id
              )::int AS identity_mismatch
         FROM classified`,
      [
        toPgJson(
          part.map((link) => ({
            thread_id: link.threadId,
            page_id: link.pageId,
            wikidot_id: link.wikidotId,
          })),
          'forum.inferred_links',
        ),
      ],
    );
    const row = result.rows[0];
    if (!row) throw new Error('inferred forum link apply 未返回汇总');
    summary.selected += Number(row.selected);
    summary.applied += Number(row.applied);
    summary.skippedVerified += Number(row.skipped_verified);
    summary.skippedUnmarkedExisting += Number(row.skipped_unmarked_existing);
    summary.missingThread += Number(row.missing_thread);
    summary.missingPage += Number(row.missing_page);
    summary.identityMismatch += Number(row.identity_mismatch);
  }
  return summary;
}

function assertValidLinks(links: readonly InferredForumLink[]): void {
  const threadIds = new Set<number>();
  for (const link of links) {
    if (
      !Number.isSafeInteger(link.threadId) ||
      link.threadId <= 0 ||
      !Number.isSafeInteger(link.pageId) ||
      link.pageId <= 0 ||
      !Number.isSafeInteger(link.wikidotId) ||
      link.wikidotId <= 0
    ) {
      throw new Error(`非法 inferred forum link：${JSON.stringify(link)}`);
    }
    if (threadIds.has(link.threadId)) {
      throw new Error(`v1 ForumThread.id 重复：${link.threadId}`);
    }
    threadIds.add(link.threadId);
  }
}

function emptySummary(): InferredForumLinkApplySummary {
  return {
    selected: 0,
    applied: 0,
    skippedVerified: 0,
    skippedUnmarkedExisting: 0,
    missingThread: 0,
    missingPage: 0,
    identityMismatch: 0,
  };
}
