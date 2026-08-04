import type { PoolClient } from 'pg';
import { exec } from './sql.js';
import type { ProjectionApplyResult, ProjectionWindow } from './types.js';

/**
 * user_page 是小体量当前态投影；每轮在同一事务里完整刷新。
 *
 * B2：默认排除已删作品，回答“谁的现存作品成就最高”。已删页 59% 的票是踩，
 * 把它们纳入作者排行等于惩罚删过稿的人。该语义与 B1 的累计站点总览有意不同。
 *
 * B5：`deleted:` / `old:` 只是 619 个归档活页使用的 slug/category 前缀，不是删除状态。
 * 本投影只允许按 page_current.status 判断，禁止增加 slug/category 前缀过滤。
 *
 * apply_page_meta 会把元数据变化映射到 page_current.cursor_seq，但本表还受
 * 「是否纳入已删页」运行时开关影响；完整刷新能让开关切换立即、原子地改变全表口径，
 * 也避免 page_attr_history 无原生 fact_seq 带来的历史兼容歧义。
 */
export async function projectUserPage(
  client: PoolClient,
  window: ProjectionWindow,
): Promise<ProjectionApplyResult> {
  if (window.rebuild) {
    await exec(client, 'project.user_page:truncate', `TRUNCATE TABLE serve.user_page`);
  } else {
    await exec(client, 'project.user_page:refresh_delete', `DELETE FROM serve.user_page`);
  }

  const rowsWritten = await exec(
    client,
    'project.user_page:refresh_insert',
    `WITH attrs AS (
       SELECT ac.actor_id AS user_id,
              ac.page_id,
              array_agg(DISTINCT ac.role ORDER BY ac.role) AS roles,
              min(ac.at_date) AS first_attr_date
         FROM serve.attribution_current ac
        WHERE ac.is_display
        GROUP BY ac.actor_id, ac.page_id
     ),
     revision_dates AS (
       SELECT r.page_id,
              r.author_id AS user_id,
              min(r.occurred_at) AS first_actor_revision
         FROM ingest.revision r
        WHERE r.author_id IS NOT NULL
        GROUP BY r.page_id, r.author_id
     ),
     page_created AS (
       SELECT r.page_id,
              min(r.occurred_at) FILTER (
                WHERE r.type IN ('PAGE_CREATED', 'N')
                   OR position('"PAGE_CREATED"' in COALESCE(r.type, '')) > 0
              ) AS first_created_revision
         FROM ingest.revision r
        GROUP BY r.page_id
     )
     INSERT INTO serve.user_page
       (user_id, page_id, roles, effective_created_at, group_key)
     SELECT a.user_id,
            a.page_id,
            a.roles,
            COALESCE(
              CASE WHEN a.roles && ARRAY['AUTHOR','SUBMITTER']::text[]
                   THEN COALESCE(pc.first_published_at, cr.first_created_revision)
              END,
              CASE WHEN a.first_attr_date IS NOT NULL
                   THEN a.first_attr_date::timestamp AT TIME ZONE 'Asia/Shanghai'
              END,
              rd.first_actor_revision,
              COALESCE(pc.first_published_at, cr.first_created_revision)
            ) AS effective_created_at,
            CASE
              WHEN pc.category = 'short-stories' THEN 'short_stories'
              WHEN pc.category = 'log-of-anomalous-items-cn' THEN 'anomalous_log'
              WHEN pc.tags && ARRAY['作者','掩盖页','段落']::text[] THEN 'other'
              WHEN pc.tags @> ARRAY['原创']::text[] THEN 'author'
              ELSE 'translator'
            END AS group_key
       FROM attrs a
       JOIN serve.page_current pc ON pc.page_id = a.page_id
       LEFT JOIN revision_dates rd
         ON rd.page_id = a.page_id AND rd.user_id = a.user_id
       LEFT JOIN page_created cr ON cr.page_id = a.page_id
      WHERE $1::boolean OR pc.status <> 'deleted'`,
    [window.includeDeletedPages],
  );

  return {
    affectedKeys: rowsWritten,
    rowsWritten,
    notes: [
      window.includeDeletedPages
        ? 'user_page 纳入已删页作品（显式开关）'
        : 'B2：user_page 默认排除已删作品，作者排行只回答现存作品成就',
      'B5：不按 deleted:/old: 前缀过滤，归档活页仍算页面',
      '四层 effective_created_at 已在投影时物化',
      '为保证已删页开关切换立即生效，本投影每轮事务内完整刷新',
    ],
  };
}
