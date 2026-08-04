/**
 * ListPages `%%parent_fullname%%` → page_id 的父关系专用解析。
 *
 * 普通 fullname 必须只按当前 slug 解析；父 fullname 有两个额外约束：
 * - 同 slug 同时有 live 与 deleted tombstone 时，首次解析必须唯一选择 live，不能依赖
 *   SQL 无序返回（存量曾因此把 61 条边随机挂到 deleted 同名页）。
 * - 父页改名后，已挂上的子页仍可能继续返回旧 fullname。当前 slug 无解时，只允许用
 *   page_slug_history 中“历史上始终属于同一个 page_id”的 slug 补解。
 *
 * 已经建立的关系是否保留由 chooseParentPageId 决定；被删除重建复用过、且没有唯一 live
 * 候选的歧义 slug 不猜。
 */

import type { Pool, PoolClient } from 'pg';

import { query } from '../store/db.js';
import { chunk } from '../util/concurrency.js';

export interface ParentFullnameResolution {
  map: Map<string, number>;
  resolvedCurrent: number;
  resolvedHistoricalUnique: number;
  unresolved: string[];
}

export async function resolveParentFullnames(
  pool: Pool | PoolClient,
  parentFullnames: readonly string[],
): Promise<ParentFullnameResolution> {
  const unique = [...new Set(parentFullnames.filter((slug) => slug.trim() !== ''))];
  const map = new Map<string, number>();

  // page_slug_history 的当前行只保证“每页一个 slug”，不保证“每 slug 一个 page”；
  // 删除重建后 live 与 tombstone 可以同名，所以这里必须自行做唯一 live 裁决。
  for (const part of chunk(unique, 5_000)) {
    const rows = await query<{ slug: string; page_id: number }>(
      pool,
      'parent:resolve_current_slug',
      `SELECT slug,
              CASE
                WHEN count(*) FILTER (WHERE status = 'live') = 1
                  THEN min(page_id) FILTER (WHERE status = 'live')
                WHEN count(DISTINCT page_id) = 1
                  THEN min(page_id)
                ELSE NULL
              END::int AS page_id
         FROM serve.page_current
        WHERE slug = ANY($1::text[])
        GROUP BY slug
       HAVING count(*) FILTER (WHERE status = 'live') = 1
           OR count(DISTINCT page_id) = 1`,
      [part],
    );
    for (const row of rows.rows) map.set(row.slug, Number(row.page_id));
  }

  const resolvedCurrent = map.size;
  const needsHistory = unique.filter((slug) => !map.has(slug));
  let resolvedHistoricalUnique = 0;
  for (const part of chunk(needsHistory, 5_000)) {
    const rows = await query<{ slug: string; page_id: number }>(
      pool,
      'parent:resolve_unique_historical_slug',
      `SELECT history.slug, min(history.page_id)::int AS page_id
         FROM ingest.page_slug_history history
         JOIN serve.page_current parent ON parent.page_id = history.page_id
        WHERE history.slug = ANY($1::text[])
        GROUP BY history.slug
       HAVING count(DISTINCT history.page_id) = 1`,
      [part],
    );
    for (const row of rows.rows) {
      if (map.has(row.slug)) continue;
      map.set(row.slug, Number(row.page_id));
      resolvedHistoricalUnique++;
    }
  }

  return {
    map,
    resolvedCurrent,
    resolvedHistoricalUnique,
    unresolved: unique.filter((slug) => !map.has(slug)),
  };
}

export interface ExistingParentRelation {
  pageId: number;
  fullname: string;
}

/**
 * 相同 parent fullname 的重复观测不重新做身份裁决。
 *
 * 这使“父页后来 deleted”仍保留 tombstone ID；即使该 slug 日后被新页复用，也不能仅凭
 * 同一个 `%%parent_fullname%%` 擅自 reparent。只有 fullname 真正变化时才采用新解析。
 */
export function chooseParentPageId(
  parentFullname: string | null,
  resolvedParentPageId: number | undefined,
  existing: ExistingParentRelation | undefined,
): number | null {
  if (parentFullname === null) return null;
  if (existing?.fullname === parentFullname) return existing.pageId;
  return resolvedParentPageId ?? null;
}
