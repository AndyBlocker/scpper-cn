import type { PoolClient } from 'pg';
import { exec, RATING_DELTA_SQL, rows, VOTE_DAY_SQL } from './sql.js';
import type { ProjectionApplyResult, ProjectionWindow } from './types.js';

interface CountRow {
  n: string;
}

async function countTemp(client: PoolClient, table: string, label: string): Promise<number> {
  const result = await rows<CountRow>(
    client,
    label,
    `SELECT count(*)::text AS n FROM pg_temp.${table}`,
  );
  return Number(result[0]?.n ?? 0);
}

export async function projectVoteDaily(
  client: PoolClient,
  window: ProjectionWindow,
): Promise<ProjectionApplyResult> {
  await exec(
    client,
    'project.vote_daily:create_affected',
    `CREATE TEMP TABLE project_vote_daily_pages
       (page_id int PRIMARY KEY) ON COMMIT DROP`,
  );
  await exec(
    client,
    'project.vote_daily:fill_affected',
    `INSERT INTO project_vote_daily_pages(page_id)
     SELECT DISTINCT page_id
       FROM (
         SELECT page_id FROM ingest.vote_event
          WHERE seq BETWEEN $1::bigint AND $2::bigint
         UNION ALL
         SELECT page_id FROM ingest.vote_snapshot_event
          WHERE seq BETWEEN $1::bigint AND $2::bigint
       ) changed`,
    [window.fromSeq, window.toSeq],
  );
  const affectedKeys = await countTemp(
    client,
    'project_vote_daily_pages',
    'project.vote_daily:affected_count',
  );

  if (window.rebuild) {
    await exec(client, 'project.vote_daily:truncate', `TRUNCATE TABLE serve.vote_daily`);
  } else if (affectedKeys > 0) {
    // 逐页重放而非只给当天加增量：历史回填会改动过去某日之后的全部 cum_rating。
    await exec(
      client,
      'project.vote_daily:delete_affected',
      `DELETE FROM serve.vote_daily vd
       USING project_vote_daily_pages a
       WHERE vd.page_id = a.page_id`,
    );
  }
  if (affectedKeys === 0) return { affectedKeys: 0, rowsWritten: 0 };

  const rowsWritten = await exec(
    client,
    'project.vote_daily:insert',
    `WITH raw_daily AS (
       SELECT ve.page_id,
              ${VOTE_DAY_SQL} AS day,
              count(*) FILTER (WHERE ve.new_direction > 0)::int AS up,
              count(*) FILTER (WHERE ve.new_direction < 0)::int AS down,
              count(*) FILTER (WHERE ve.kind = 'revoke')::int AS revoked,
              sum(${RATING_DELTA_SQL})::int AS rating_delta
         FROM ingest.vote_event ve
         JOIN project_vote_daily_pages a ON a.page_id = ve.page_id
        WHERE ve.seq <= $1::bigint
          AND ve.time_precision <> 'bootstrap'
          AND ve.occurred_at IS NOT NULL
        GROUP BY ve.page_id, ${VOTE_DAY_SQL}
       UNION ALL
       SELECT vse.page_id,
              (vse.observed_at AT TIME ZONE 'Asia/Shanghai')::date,
              vse.up_delta, vse.down_delta, 0, vse.rating_delta
         FROM ingest.vote_snapshot_event vse
         JOIN project_vote_daily_pages a ON a.page_id = vse.page_id
        WHERE vse.seq <= $1::bigint
     ),
     daily AS (
       SELECT page_id, day, sum(up)::int AS up, sum(down)::int AS down,
              sum(revoked)::int AS revoked, sum(rating_delta)::int AS rating_delta
         FROM raw_daily
        GROUP BY page_id, day
     ),
     folded AS (
       SELECT page_id, day, up, down, revoked,
              sum(rating_delta) OVER (
                PARTITION BY page_id ORDER BY day
                ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
              )::int AS cum_rating
         FROM daily
        WHERE day IS NOT NULL
     )
     INSERT INTO serve.vote_daily(page_id, day, up, down, revoked, cum_rating)
     SELECT page_id, day, up, down, revoked, cum_rating FROM folded
     ON CONFLICT (page_id, day) DO UPDATE SET
       up = EXCLUDED.up,
       down = EXCLUDED.down,
       revoked = EXCLUDED.revoked,
       cum_rating = EXCLUDED.cum_rating`,
    [window.toSeq],
  );
  return {
    affectedKeys,
    rowsWritten,
    notes: ['time_precision=bootstrap 已整体排除；snapshot 多重性补差并入观测日'],
  };
}

export async function projectUserAttrDaily(
  client: PoolClient,
  window: ProjectionWindow,
): Promise<ProjectionApplyResult> {
  await exec(
    client,
    'project.user_attr_daily:create_affected',
    `CREATE TEMP TABLE project_user_attr_users
       (user_id int PRIMARY KEY) ON COMMIT DROP`,
  );
  await exec(
    client,
    'project.user_attr_daily:fill_affected',
    `INSERT INTO project_user_attr_users(user_id)
     SELECT DISTINCT actor_id
       FROM (
         SELECT ac.actor_id
           FROM ingest.vote_event ve
           JOIN serve.attribution_current ac
             ON ac.page_id = ve.page_id AND ac.is_display
          WHERE ve.seq BETWEEN $1::bigint AND $2::bigint
         UNION ALL
         SELECT ac.actor_id
           FROM ingest.vote_snapshot_event vse
           JOIN serve.attribution_current ac
             ON ac.page_id = vse.page_id AND ac.is_display
          WHERE vse.seq BETWEEN $1::bigint AND $2::bigint
         UNION ALL
         SELECT ae.actor_id
           FROM ingest.attribution_event ae
          WHERE ae.seq BETWEEN $1::bigint AND $2::bigint
         UNION ALL
         SELECT ac.actor_id
           FROM ingest.page_life_event ple
           JOIN serve.attribution_current ac
             ON ac.page_id = ple.page_id AND ac.is_display
          WHERE ple.seq BETWEEN $1::bigint AND $2::bigint
       ) s`,
    [window.fromSeq, window.toSeq],
  );
  const affectedKeys = await countTemp(
    client,
    'project_user_attr_users',
    'project.user_attr_daily:affected_count',
  );

  if (window.rebuild) {
    await exec(
      client,
      'project.user_attr_daily:truncate',
      `TRUNCATE TABLE serve.user_attr_daily`,
    );
  } else if (affectedKeys > 0) {
    // attribution removed 后旧作者已不在 current 里，必须先删其旧折叠结果。
    await exec(
      client,
      'project.user_attr_daily:delete_affected',
      `DELETE FROM serve.user_attr_daily uad
       USING project_user_attr_users a
       WHERE uad.user_id = a.user_id`,
    );
  }
  if (affectedKeys === 0) return { affectedKeys: 0, rowsWritten: 0 };

  const rowsWritten = await exec(
    client,
    'project.user_attr_daily:insert',
    `WITH display_authors AS MATERIALIZED (
       -- 同一作者/页可能同时有 REWRITE、REWRITER 等展示角色；评分只能归属一次。
       SELECT DISTINCT page_id, actor_id
         FROM serve.attribution_current
        WHERE is_display
     ), vote_daily_raw AS (
       SELECT ac.actor_id AS user_id,
              ${VOTE_DAY_SQL} AS day,
              count(*) FILTER (WHERE ve.new_direction > 0)::int AS up,
              count(*) FILTER (WHERE ve.new_direction < 0)::int AS down,
              sum(${RATING_DELTA_SQL})::int AS rating_delta
         FROM ingest.vote_event ve
         JOIN display_authors ac ON ac.page_id = ve.page_id
         JOIN project_user_attr_users a ON a.user_id = ac.actor_id
        WHERE ve.seq <= $1::bigint
          AND ve.time_precision <> 'bootstrap'
          AND ve.occurred_at IS NOT NULL
        GROUP BY ac.actor_id, ${VOTE_DAY_SQL}
       UNION ALL
       SELECT ac.actor_id,
              (vse.observed_at AT TIME ZONE 'Asia/Shanghai')::date,
              sum(vse.up_delta)::int,
              sum(vse.down_delta)::int,
              sum(vse.rating_delta)::int
         FROM ingest.vote_snapshot_event vse
         JOIN display_authors ac ON ac.page_id = vse.page_id
         JOIN project_user_attr_users a ON a.user_id = ac.actor_id
        WHERE vse.seq <= $1::bigint
        GROUP BY ac.actor_id, (vse.observed_at AT TIME ZONE 'Asia/Shanghai')::date
     ),
     vote_daily AS (
       SELECT user_id, day, sum(up)::int AS up, sum(down)::int AS down,
              sum(rating_delta)::int AS rating_delta
         FROM vote_daily_raw
        GROUP BY user_id, day
     ),
     current_deletions AS (
       /*
        * B4：用户评分曲线必须复刻 v1 的删除负柱。这里只为“当前仍 deleted”的页
        * 取最后一次 deleted；页面 restored 后负柱随全历史重放消失，正好恢复为现存
        * 作品评分。删除日来自 page_life_event，而不是拿最后投票日冒充。
        */
       SELECT DISTINCT ON (ple.page_id)
              ple.page_id,
              (COALESCE(ple.occurred_at, ple.observed_at)
                AT TIME ZONE 'Asia/Shanghai')::date AS day
         FROM ingest.page_life_event ple
         JOIN serve.page_current pc
           ON pc.page_id = ple.page_id AND pc.status = 'deleted'
        WHERE ple.kind = 'deleted'
          AND ple.seq <= $1::bigint
        ORDER BY ple.page_id, ple.seq DESC
     ),
     deletion_daily AS (
       /*
        * B4 语义：“作品被删当天”把该页完整票型扣回，而不是只减净 rating：
        *   up=-vote_up, down=-vote_down, rating_delta=-rating。
        * 这会保留 v1 的红/绿负柱响应形状；实测锚点为 2,372 位作者、
        * 5,486 个负柱日、累计 -123,762 upvote、最深单柱 -5,014。
        */
       SELECT ac.actor_id AS user_id,
              cd.day,
              -sum(pc.vote_up)::int AS up,
              -sum(pc.vote_down)::int AS down,
              -sum(pc.rating)::int AS rating_delta
         FROM current_deletions cd
         JOIN serve.page_current pc ON pc.page_id = cd.page_id
         JOIN display_authors ac ON ac.page_id = cd.page_id
         JOIN project_user_attr_users a ON a.user_id = ac.actor_id
        WHERE cd.day IS NOT NULL
        GROUP BY ac.actor_id, cd.day
     ),
     daily AS (
       SELECT user_id, day,
              sum(up)::int AS up,
              sum(down)::int AS down,
              sum(rating_delta)::int AS rating_delta
         FROM (
           SELECT user_id, day, up, down, rating_delta FROM vote_daily
           UNION ALL
           SELECT user_id, day, up, down, rating_delta FROM deletion_daily
         ) d
        WHERE day IS NOT NULL
        GROUP BY user_id, day
     ),
     opening_balance AS (
       /*
        * bootstrap 票仍然“不属于任何一天”，所以绝不进入 daily/up/down/rating_delta。
        * 但它是曲线开始前已经存在的真实余额，必须加到 cum_rating 的期初；否则即使
        * B4 正确扣回已删作品，末值也会与 B2 的现存作品 total_rating 相差整批冷启动票。
        * 极少数 occurred_at=NULL 的遗留事件同理：没有可诚实落柱的日期，只进期初余额。
        *
        * status=deleted 却没有 deleted life event 的页属于不完整/测试夹具状态：既没有
        * 可落负柱的日期，也不属于 B2 现存作品，故不把其 bootstrap 余额带进曲线。
        */
       SELECT ac.actor_id AS user_id,
              sum(${RATING_DELTA_SQL})::int AS rating
         FROM ingest.vote_event ve
         JOIN serve.page_current pc ON pc.page_id = ve.page_id
         JOIN display_authors ac ON ac.page_id = ve.page_id
         JOIN project_user_attr_users a ON a.user_id = ac.actor_id
        WHERE ve.seq <= $1::bigint
          AND (ve.time_precision = 'bootstrap' OR ve.occurred_at IS NULL)
          AND (
            pc.status = 'live'
            OR EXISTS (
              SELECT 1
                FROM ingest.page_life_event ple
               WHERE ple.page_id = pc.page_id
                 AND ple.kind = 'deleted'
                 AND ple.seq <= $1::bigint
            )
          )
        GROUP BY ac.actor_id
     ),
     folded AS (
       SELECT d.user_id, d.day, d.up, d.down, d.rating_delta,
              (
                COALESCE(b.rating, 0)
                + sum(d.rating_delta) OVER (
                    PARTITION BY d.user_id ORDER BY d.day
                    ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
                  )
              )::int AS cum_rating
         FROM daily d
         LEFT JOIN opening_balance b ON b.user_id = d.user_id
     )
     INSERT INTO serve.user_attr_daily
       (user_id, day, up, down, rating_delta, cum_rating)
     SELECT user_id, day, up, down, rating_delta, cum_rating FROM folded
     ON CONFLICT (user_id, day) DO UPDATE SET
       up = EXCLUDED.up,
       down = EXCLUDED.down,
       rating_delta = EXCLUDED.rating_delta,
       cum_rating = EXCLUDED.cum_rating`,
    [window.toSeq],
  );
  return {
    affectedKeys,
    rowsWritten,
    notes: [
      '仅 attribution_current.is_display=true；bootstrap 只作期初余额，snapshot 多重性补差落观测日',
      'B4：当前已删作品在 deleted 当天写入 up/down/rating_delta 完整负柱；restored 后重放移除',
    ],
  };
}

export async function projectPageDailyStats(
  client: PoolClient,
  window: ProjectionWindow,
): Promise<ProjectionApplyResult> {
  await exec(
    client,
    'project.page_daily_stats:create_affected',
    `CREATE TEMP TABLE project_page_daily_pages
       (page_id int PRIMARY KEY) ON COMMIT DROP`,
  );
  await exec(
    client,
    'project.page_daily_stats:fill_affected',
    `INSERT INTO project_page_daily_pages(page_id)
     SELECT DISTINCT page_id
       FROM (
         SELECT page_id
           FROM ingest.vote_event
          WHERE seq BETWEEN $1::bigint AND $2::bigint
         UNION ALL
         SELECT page_id
           FROM ingest.vote_snapshot_event
          WHERE seq BETWEEN $1::bigint AND $2::bigint
         UNION ALL
         SELECT page_id
           FROM ingest.revision
          WHERE seq BETWEEN $1::bigint AND $2::bigint
       ) s`,
    [window.fromSeq, window.toSeq],
  );
  const affectedKeys = await countTemp(
    client,
    'project_page_daily_pages',
    'project.page_daily_stats:affected_count',
  );

  /*
   * 绝不能 TRUNCATE，也绝不能给 views 赋值。
   * 重建时先仅归零四个可再生列；views-only 的行保留，随后再逐列 upsert 事实聚合。
   */
  if (window.rebuild) {
    await exec(
      client,
      'project.page_daily_stats:reset_derived_all',
      `UPDATE serve.page_daily_stats
          SET votes_up = 0,
              votes_down = 0,
              unique_voters = 0,
              revisions = 0,
              updated_at = now()
        WHERE votes_up <> 0
           OR votes_down <> 0
           OR unique_voters <> 0
           OR revisions <> 0`,
    );
  } else if (affectedKeys > 0) {
    await exec(
      client,
      'project.page_daily_stats:reset_derived_affected',
      `UPDATE serve.page_daily_stats pds
          SET votes_up = 0,
              votes_down = 0,
              unique_voters = 0,
              revisions = 0,
              updated_at = now()
         FROM project_page_daily_pages a
        WHERE pds.page_id = a.page_id
          AND (pds.votes_up <> 0
            OR pds.votes_down <> 0
            OR pds.unique_voters <> 0
            OR pds.revisions <> 0)`,
    );
  }
  if (affectedKeys === 0) {
    return {
      affectedKeys: 0,
      rowsWritten: 0,
      notes: ['views 未读取、未赋值、未删除；重建未使用 TRUNCATE'],
    };
  }

  const rowsWritten = await exec(
    client,
    'project.page_daily_stats:upsert_derived',
    `WITH vote_agg_raw AS (
       SELECT ve.page_id,
              ${VOTE_DAY_SQL} AS day,
              count(*) FILTER (WHERE ve.new_direction > 0)::int AS votes_up,
              count(*) FILTER (WHERE ve.new_direction < 0)::int AS votes_down,
              count(DISTINCT ve.voter_id)::int AS unique_voters
         FROM ingest.vote_event ve
         JOIN project_page_daily_pages a ON a.page_id = ve.page_id
        WHERE ve.seq <= $1::bigint
          AND ve.time_precision <> 'bootstrap'
          AND ve.occurred_at IS NOT NULL
        GROUP BY ve.page_id, ${VOTE_DAY_SQL}
       UNION ALL
       SELECT vse.page_id,
              (vse.observed_at AT TIME ZONE 'Asia/Shanghai')::date,
              vse.up_delta, vse.down_delta, 0
         FROM ingest.vote_snapshot_event vse
         JOIN project_page_daily_pages a ON a.page_id = vse.page_id
        WHERE vse.seq <= $1::bigint
     ),
     vote_agg AS (
       SELECT page_id, day, sum(votes_up)::int AS votes_up,
              sum(votes_down)::int AS votes_down,
              sum(unique_voters)::int AS unique_voters
         FROM vote_agg_raw
        GROUP BY page_id, day
     ),
     revision_agg AS (
       SELECT r.page_id,
              (r.occurred_at AT TIME ZONE 'Asia/Shanghai')::date AS day,
              count(*)::int AS revisions
         FROM ingest.revision r
         JOIN project_page_daily_pages a ON a.page_id = r.page_id
        WHERE r.seq <= $1::bigint
        GROUP BY r.page_id, (r.occurred_at AT TIME ZONE 'Asia/Shanghai')::date
     ),
     keys AS (
       SELECT page_id, day FROM vote_agg WHERE day IS NOT NULL
       UNION
       SELECT page_id, day FROM revision_agg
     ),
     agg AS (
       SELECT k.page_id, k.day,
              COALESCE(v.votes_up, 0)::int AS votes_up,
              COALESCE(v.votes_down, 0)::int AS votes_down,
              COALESCE(v.unique_voters, 0)::int AS unique_voters,
              COALESCE(r.revisions, 0)::int AS revisions
         FROM keys k
         LEFT JOIN vote_agg v USING (page_id, day)
         LEFT JOIN revision_agg r USING (page_id, day)
     )
     INSERT INTO serve.page_daily_stats
       (page_id, date, votes_up, votes_down, unique_voters, revisions, created_at, updated_at)
     SELECT page_id, day, votes_up, votes_down, unique_voters, revisions, now(), now()
       FROM agg
     ON CONFLICT (page_id, date) DO UPDATE SET
       votes_up = EXCLUDED.votes_up,
       votes_down = EXCLUDED.votes_down,
       unique_voters = EXCLUDED.unique_voters,
       revisions = EXCLUDED.revisions,
       updated_at = EXCLUDED.updated_at`,
    [window.toSeq],
  );
  return {
    affectedKeys,
    rowsWritten,
    notes: [
      'views 未读取、未赋值、未删除；重建未使用 TRUNCATE',
      'bootstrap 票已从 votes_*/unique_voters 整体排除',
    ],
  };
}
