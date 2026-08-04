import type { PoolClient } from 'pg';
import { exec, rows } from './sql.js';
import type { ProjectionApplyResult, ProjectionWindow } from './types.js';

interface CountRow {
  n: string;
}

async function tempCount(client: PoolClient, table: string, label: string): Promise<number> {
  const result = await rows<CountRow>(
    client,
    label,
    `SELECT count(*)::text AS n FROM pg_temp.${table}`,
  );
  return Number(result[0]?.n ?? 0);
}

export async function projectUserVoteInteraction(
  client: PoolClient,
  window: ProjectionWindow,
): Promise<ProjectionApplyResult> {
  await exec(
    client,
    'project.user_vote_interaction:create_affected',
    `CREATE TEMP TABLE project_interaction_pairs (
       from_user_id int NOT NULL,
       to_user_id int NOT NULL,
       PRIMARY KEY (from_user_id, to_user_id)
     ) ON COMMIT DROP`,
  );
  if (window.rebuild) {
    await exec(
      client,
      'project.user_vote_interaction:all_pairs',
      `INSERT INTO project_interaction_pairs(from_user_id, to_user_id)
       SELECT DISTINCT vc.voter_id, ac.actor_id
         FROM serve.vote_current vc
         JOIN serve.attribution_current ac
           ON ac.page_id = vc.page_id AND ac.is_display
        WHERE vc.direction <> 0`,
    );
    await exec(
      client,
      'project.user_vote_interaction:truncate',
      `TRUNCATE TABLE serve.user_vote_interaction`,
    );
  } else {
    await exec(
      client,
      'project.user_vote_interaction:window_pairs',
      `INSERT INTO project_interaction_pairs(from_user_id, to_user_id)
       SELECT DISTINCT from_user_id, to_user_id
         FROM (
           SELECT ve.voter_id AS from_user_id, ac.actor_id AS to_user_id
             FROM ingest.vote_event ve
             JOIN serve.attribution_current ac
               ON ac.page_id = ve.page_id AND ac.is_display
            WHERE ve.seq BETWEEN $1::bigint AND $2::bigint
           UNION ALL
           SELECT affected.voter_id, ac.actor_id
             FROM ingest.vote_snapshot_event vse
             CROSS JOIN LATERAL unnest(vse.affected_voter_ids) AS affected(voter_id)
             JOIN serve.attribution_current ac
               ON ac.page_id = vse.page_id AND ac.is_display
            WHERE vse.seq BETWEEN $1::bigint AND $2::bigint
           UNION ALL
           SELECT vc.voter_id, ae.actor_id
             FROM ingest.attribution_event ae
             JOIN serve.vote_current vc
               ON vc.page_id = ae.page_id AND vc.direction <> 0
            WHERE ae.seq BETWEEN $1::bigint AND $2::bigint
         ) s
       ON CONFLICT DO NOTHING`,
      [window.fromSeq, window.toSeq],
    );
  }

  const affectedKeys = await tempCount(
    client,
    'project_interaction_pairs',
    'project.user_vote_interaction:affected_count',
  );
  if (affectedKeys === 0) return { affectedKeys: 0, rowsWritten: 0 };

  let rowsDeleted = 0;
  if (!window.rebuild) {
    rowsDeleted = await exec(
      client,
      'project.user_vote_interaction:delete_affected',
      `DELETE FROM serve.user_vote_interaction uvi
       USING project_interaction_pairs a
       WHERE uvi.from_user_id = a.from_user_id
         AND uvi.to_user_id = a.to_user_id`,
    );
  }

  const rowsWritten = await exec(
    client,
    'project.user_vote_interaction:insert',
    `WITH display_authors AS MATERIALIZED (
       SELECT DISTINCT page_id, actor_id
         FROM serve.attribution_current
        WHERE is_display
     ), agg AS (
       SELECT vc.voter_id AS from_user_id,
              ac.actor_id AS to_user_id,
              count(*) FILTER (WHERE vc.direction > 0)::int AS up_count,
              count(*) FILTER (WHERE vc.direction < 0)::int AS down_count,
              count(*)::int AS total,
              max(vc.last_voted_at) AS last_vote_at
         FROM project_interaction_pairs a
         JOIN serve.vote_current vc
           ON vc.voter_id = a.from_user_id AND vc.direction <> 0
         JOIN display_authors ac
           ON ac.page_id = vc.page_id
          AND ac.actor_id = a.to_user_id
        GROUP BY vc.voter_id, ac.actor_id
     )
     INSERT INTO serve.user_vote_interaction
       (from_user_id, to_user_id, up_count, down_count, total, last_vote_at)
     SELECT from_user_id, to_user_id, up_count, down_count, total, last_vote_at
       FROM agg
     ON CONFLICT (from_user_id, to_user_id) DO UPDATE SET
       up_count = EXCLUDED.up_count,
       down_count = EXCLUDED.down_count,
       total = EXCLUDED.total,
       last_vote_at = EXCLUDED.last_vote_at`,
  );
  return {
    affectedKeys,
    rowsWritten,
    rowsDeleted,
    notes: [
      window.rebuild
        ? '仅显式 rebuild 做全表重放'
        : '增量仅重算事件窗口触及的 (voter, author) 对',
    ],
  };
}

export async function projectUserTagPreference(
  client: PoolClient,
  window: ProjectionWindow,
): Promise<ProjectionApplyResult> {
  await exec(
    client,
    'project.user_tag_preference:create_affected',
    `CREATE TEMP TABLE project_tag_users
       (user_id int PRIMARY KEY) ON COMMIT DROP`,
  );
  if (window.rebuild) {
    await exec(
      client,
      'project.user_tag_preference:all_users',
      `INSERT INTO project_tag_users(user_id)
       SELECT DISTINCT voter_id
         FROM serve.vote_current
        WHERE direction <> 0`,
    );
    await exec(
      client,
      'project.user_tag_preference:truncate',
      `TRUNCATE TABLE serve.user_tag_preference`,
    );
  } else {
    await exec(
      client,
      'project.user_tag_preference:window_users',
      `INSERT INTO project_tag_users(user_id)
       SELECT DISTINCT user_id
         FROM (
           SELECT ve.voter_id AS user_id
             FROM ingest.vote_event ve
            WHERE ve.seq BETWEEN $1::bigint AND $2::bigint
           UNION ALL
           SELECT affected.voter_id
             FROM ingest.vote_snapshot_event vse
             CROSS JOIN LATERAL unnest(vse.affected_voter_ids) AS affected(voter_id)
            WHERE vse.seq BETWEEN $1::bigint AND $2::bigint
           UNION ALL
           SELECT vc.voter_id
             FROM serve.page_current pc
             JOIN serve.vote_current vc
               ON vc.page_id = pc.page_id AND vc.direction <> 0
            WHERE pc.cursor_seq BETWEEN $1::bigint AND $2::bigint
         ) s
       ON CONFLICT DO NOTHING`,
      [window.fromSeq, window.toSeq],
    );
  }

  const affectedKeys = await tempCount(
    client,
    'project_tag_users',
    'project.user_tag_preference:affected_count',
  );
  if (affectedKeys === 0) return { affectedKeys: 0, rowsWritten: 0 };

  let rowsDeleted = 0;
  if (!window.rebuild) {
    rowsDeleted = await exec(
      client,
      'project.user_tag_preference:delete_affected',
      `DELETE FROM serve.user_tag_preference utp
       USING project_tag_users a
       WHERE utp.user_id = a.user_id`,
    );
  }

  const rowsWritten = await exec(
    client,
    'project.user_tag_preference:insert',
    `WITH agg AS (
       SELECT vc.voter_id AS user_id,
              tag,
              count(*) FILTER (WHERE vc.direction > 0)::int AS up_count,
              count(*) FILTER (WHERE vc.direction < 0)::int AS down_count,
              count(*)::int AS total,
              max(vc.last_voted_at) AS last_vote_at
         FROM project_tag_users a
         JOIN serve.vote_current vc
           ON vc.voter_id = a.user_id AND vc.direction <> 0
         JOIN serve.page_current pc
           ON pc.page_id = vc.page_id
          /*
           * B3：标签统计只算活页。标签的用途是点进去找文章，deleted 页会 404，
           * 所以它与 B1 的“累计产出”站点总览口径有意不同，禁止顺手统一。
           *
           * B5：619 个 deleted:/old: 归档活页仍是页面；这里只看 status='live'，
           * 绝不按 slug/category 前缀排除它们。
           */
          AND pc.status = 'live'
         CROSS JOIN LATERAL unnest(pc.tags) AS t(tag)
        GROUP BY vc.voter_id, tag
     )
     INSERT INTO serve.user_tag_preference
       (user_id, tag, up_count, down_count, total, last_vote_at)
     SELECT user_id, tag, up_count, down_count, total, last_vote_at
       FROM agg
     ON CONFLICT (user_id, tag) DO UPDATE SET
       up_count = EXCLUDED.up_count,
       down_count = EXCLUDED.down_count,
       total = EXCLUDED.total,
       last_vote_at = EXCLUDED.last_vote_at`,
  );
  return {
    affectedKeys,
    rowsWritten,
    rowsDeleted,
    notes: [
      'B3：只聚合 status=live 的页面标签；已删页点击会 404',
      'B5：deleted:/old: 前缀不参与过滤，status=live 的 619 个归档活页照常计入',
      'tag 直接读取 page_current.tags（包含隐藏标签）',
      window.rebuild ? '仅显式 rebuild 做全表重放' : '增量按受影响 voter 重算其 (voter, tag) 对',
    ],
  };
}
