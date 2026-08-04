import type { PoolClient } from 'pg';
import { exec } from './sql.js';
import type { ProjectionApplyResult, ProjectionWindow } from './types.js';

/**
 * B1 站点总览：回答“这个站累计产出过多少内容”，所以页面、票、修订、作者都包含
 * 已删页。该口径与 B2 作者排行、B3 标签导航有意不同，禁止复用它们的 live 过滤。
 *
 * B5：619 个 `deleted:` / `old:` 归档活页当然也属于页面。这里既不按 status 过滤，
 * 更不允许按 slug/category 前缀过滤。
 */
export async function projectSiteStats(
  client: PoolClient,
  window: ProjectionWindow,
): Promise<ProjectionApplyResult> {
  const rowsWritten = await exec(
    client,
    'project.site_stats:upsert_b1',
    `WITH created_life AS (
       SELECT page_id, min(COALESCE(occurred_at, observed_at)) AS created_at
         FROM ingest.page_life_event
        WHERE kind = 'created'
          AND seq <= $1::bigint
        GROUP BY page_id
     ),
     first_revision AS (
       SELECT page_id, min(occurred_at) AS created_at
         FROM ingest.revision
        WHERE seq <= $1::bigint
        GROUP BY page_id
     ),
     page_first AS (
       SELECT p.id AS page_id,
              COALESCE(
                pc.first_published_at,
                cl.created_at,
                fr.created_at,
                p.created_at
              ) AS first_at
         FROM ingest.page p
         JOIN serve.page_current pc ON pc.page_id = p.id
         LEFT JOIN created_life cl ON cl.page_id = p.id
         LEFT JOIN first_revision fr ON fr.page_id = p.id
     )
     INSERT INTO serve.site_stats (
       id, total_users, active_users, total_pages,
       total_votes_state, total_votes_events,
       new_users_today, new_pages_today, new_votes_today, updated_at
     )
     SELECT
       1,
       (SELECT count(*)::int FROM ingest."user"),
       (
         SELECT count(*)::int
           FROM serve.user_stats us
          WHERE us.last_activity_at >=
                ((now() AT TIME ZONE 'Asia/Shanghai')::date - INTERVAL '59 days')
       ),
       /*
        * B1：不写 pc.status 条件。删除只改变可访问性，不抹掉“曾经产出过”。
        * 全量回填验收锚点：state votes=1,327,555、revisions=518,274、
        * authors>=4,327（后两项由 site_overview_daily 汇总）。
        */
       (SELECT count(*)::int FROM serve.page_current),
       (
         SELECT count(*)::bigint
           FROM serve.vote_current
          WHERE direction <> 0
       ),
       (
         SELECT count(*)::bigint
           FROM ingest.vote_event
          WHERE seq <= $1::bigint
       ),
       (
         SELECT count(*)::int
           FROM serve.user_stats
          WHERE (first_activity_at AT TIME ZONE 'Asia/Shanghai')::date
                = (now() AT TIME ZONE 'Asia/Shanghai')::date
       ),
       (
         SELECT count(*)::int
           FROM page_first
          WHERE (first_at AT TIME ZONE 'Asia/Shanghai')::date
                = (now() AT TIME ZONE 'Asia/Shanghai')::date
       ),
       (
         SELECT count(*)::int
           FROM ingest.vote_event ve
          WHERE ve.seq <= $1::bigint
            AND ve.time_precision <> 'bootstrap'
            AND ve.occurred_at IS NOT NULL
            AND (ve.occurred_at AT TIME ZONE 'Asia/Shanghai')::date
                = (now() AT TIME ZONE 'Asia/Shanghai')::date
            AND COALESCE(ve.new_direction, 0) <> 0
       ),
       now()
     ON CONFLICT (id) DO UPDATE SET
       total_users = EXCLUDED.total_users,
       active_users = EXCLUDED.active_users,
       total_pages = EXCLUDED.total_pages,
       total_votes_state = EXCLUDED.total_votes_state,
       total_votes_events = EXCLUDED.total_votes_events,
       new_users_today = EXCLUDED.new_users_today,
       new_pages_today = EXCLUDED.new_pages_today,
       new_votes_today = EXCLUDED.new_votes_today,
       updated_at = EXCLUDED.updated_at`,
    [window.toSeq],
  );
  return {
    affectedKeys: 1,
    rowsWritten,
    notes: [
      'B1：站点累计总览计入已删页；验收锚点 votes=1,327,555、revisions=518,274、authors>=4,327',
      'B5：不按 deleted:/old: 前缀过滤，619 个归档活页仍算页面',
    ],
  };
}

export async function projectSiteOverviewDaily(
  client: PoolClient,
  window: ProjectionWindow,
): Promise<ProjectionApplyResult> {
  // 站点日序列是跨全站的累计/日流量混合快照，任一历史回填都会影响其后所有天。
  await exec(
    client,
    'project.site_overview_daily:refresh_delete',
    `DELETE FROM serve.site_overview_daily`,
  );

  const rowsWritten = await exec(
    client,
    'project.site_overview_daily:refresh_insert_b1',
    `WITH created_life AS (
       SELECT page_id, min(COALESCE(occurred_at, observed_at)) AS created_at
         FROM ingest.page_life_event
        WHERE kind = 'created'
          AND seq <= $1::bigint
        GROUP BY page_id
     ),
     first_revision AS (
       SELECT page_id, min(occurred_at) AS created_at
         FROM ingest.revision
        WHERE seq <= $1::bigint
        GROUP BY page_id
     ),
     page_first AS (
       SELECT p.id AS page_id,
              COALESCE(
                pc.first_published_at,
                cl.created_at,
                fr.created_at,
                p.created_at
              ) AS first_at
         FROM ingest.page p
         JOIN serve.page_current pc ON pc.page_id = p.id
         LEFT JOIN created_life cl ON cl.page_id = p.id
         LEFT JOIN first_revision fr ON fr.page_id = p.id
     ),
     user_first AS (
       SELECT u.id AS user_id,
              COALESCE(us.first_activity_at, u.created_at) AS first_at
         FROM ingest."user" u
         LEFT JOIN serve.user_stats us ON us.user_id = u.id
     ),
     bounds AS (
       SELECT COALESCE(
                min(day),
                (now() AT TIME ZONE 'Asia/Shanghai')::date
              ) AS first_day,
              (now() AT TIME ZONE 'Asia/Shanghai')::date AS last_day
         FROM (
           SELECT (first_at AT TIME ZONE 'Asia/Shanghai')::date AS day FROM page_first
           UNION ALL
           SELECT (first_at AT TIME ZONE 'Asia/Shanghai')::date FROM user_first
           UNION ALL
           SELECT (occurred_at AT TIME ZONE 'Asia/Shanghai')::date
             FROM ingest.vote_event
            WHERE seq <= $1::bigint
              AND time_precision <> 'bootstrap'
              AND occurred_at IS NOT NULL
           UNION ALL
           SELECT (occurred_at AT TIME ZONE 'Asia/Shanghai')::date
             FROM ingest.revision
            WHERE seq <= $1::bigint
         ) dates
     ),
     days AS (
       SELECT gs::date AS day
         FROM bounds b
         CROSS JOIN LATERAL generate_series(
           b.first_day, b.last_day, INTERVAL '1 day'
         ) gs
     ),
     users_new AS (
       SELECT (first_at AT TIME ZONE 'Asia/Shanghai')::date AS day,
              count(*)::int AS n
         FROM user_first
        GROUP BY 1
     ),
     users_total AS (
       SELECT d.day,
              sum(COALESCE(un.n, 0)) OVER (ORDER BY d.day)::int AS n
         FROM days d
         LEFT JOIN users_new un ON un.day = d.day
     ),
     contributor_first AS (
       SELECT actor_id AS user_id, min(at) AS first_at
         FROM (
           SELECT r.author_id AS actor_id, r.occurred_at AS at
             FROM ingest.revision r
            WHERE r.seq <= $1::bigint
              AND r.author_id IS NOT NULL
           UNION ALL
           SELECT ae.actor_id,
                  COALESCE(
                    ae.at_date::timestamp AT TIME ZONE 'Asia/Shanghai',
                    ae.observed_at
                  )
             FROM ingest.attribution_event ae
            WHERE ae.seq <= $1::bigint
         ) c
        GROUP BY actor_id
     ),
     contributors_new AS (
       SELECT (first_at AT TIME ZONE 'Asia/Shanghai')::date AS day,
              count(*)::int AS n
         FROM contributor_first
        GROUP BY 1
     ),
     contributors_total AS (
       SELECT d.day,
              sum(COALESCE(cn.n, 0)) OVER (ORDER BY d.day)::int AS n
         FROM days d
         LEFT JOIN contributors_new cn ON cn.day = d.day
     ),
     author_first AS (
       /*
        * B1：作者累计同样包含已删原创页；这里故意没有 pc.status='live'。
        * B5 也因此天然保留 deleted:/old: 的归档活页。
        */
       SELECT ac.actor_id AS user_id,
              min(COALESCE(
                ac.at_date::timestamp AT TIME ZONE 'Asia/Shanghai',
                pf.first_at
              )) AS first_at
         FROM serve.attribution_current ac
         JOIN serve.page_current pc ON pc.page_id = ac.page_id
         JOIN page_first pf ON pf.page_id = ac.page_id
        WHERE ac.is_display
          AND pc.tags @> ARRAY['原创']::text[]
        GROUP BY ac.actor_id
     ),
     authors_new AS (
       SELECT (first_at AT TIME ZONE 'Asia/Shanghai')::date AS day,
              count(*)::int AS n
         FROM author_first
        GROUP BY 1
     ),
     authors_total AS (
       SELECT d.day,
              sum(COALESCE(an.n, 0)) OVER (ORDER BY d.day)::int AS n
         FROM days d
         LEFT JOIN authors_new an ON an.day = d.day
     ),
     pages_new AS (
       /*
        * B1/B5：所有 status、所有 slug/category 前缀都参加累计。
        * 这张表回答累计产出，不是“今天点得开的导航列表”。
        */
       SELECT (pf.first_at AT TIME ZONE 'Asia/Shanghai')::date AS day,
              count(*)::int AS total,
              count(*) FILTER (
                WHERE pc.tags @> ARRAY['原创']::text[]
              )::int AS originals,
              count(*) FILTER (
                WHERE NOT pc.tags @> ARRAY['原创']::text[]
              )::int AS translations
         FROM page_first pf
         JOIN serve.page_current pc ON pc.page_id = pf.page_id
        GROUP BY 1
     ),
     pages_total AS (
       SELECT d.day,
              sum(COALESCE(pn.total, 0)) OVER (ORDER BY d.day)::int AS total,
              sum(COALESCE(pn.originals, 0)) OVER (ORDER BY d.day)::int AS originals,
              sum(COALESCE(pn.translations, 0)) OVER (ORDER BY d.day)::int AS translations
         FROM days d
         LEFT JOIN pages_new pn ON pn.day = d.day
     ),
     activity_days AS (
       SELECT DISTINCT user_id, day
         FROM (
           SELECT ve.voter_id AS user_id,
                  (ve.occurred_at AT TIME ZONE 'Asia/Shanghai')::date AS day
             FROM ingest.vote_event ve
            WHERE ve.seq <= $1::bigint
              AND ve.time_precision <> 'bootstrap'
              AND ve.occurred_at IS NOT NULL
           UNION ALL
           SELECT r.author_id,
                  (r.occurred_at AT TIME ZONE 'Asia/Shanghai')::date
             FROM ingest.revision r
            WHERE r.seq <= $1::bigint
              AND r.author_id IS NOT NULL
           UNION ALL
           SELECT ae.actor_id,
                  COALESCE(
                    ae.at_date,
                    (ae.observed_at AT TIME ZONE 'Asia/Shanghai')::date
                  )
             FROM ingest.attribution_event ae
            WHERE ae.seq <= $1::bigint
           UNION ALL
           SELECT fp.author_user_id,
                  (fp.created_at AT TIME ZONE 'Asia/Shanghai')::date
             FROM ingest.forum_post fp
            WHERE fp.author_user_id IS NOT NULL
         ) a
        WHERE day IS NOT NULL
     ),
     activity_sorted AS (
       SELECT user_id, day,
              lag(day) OVER (PARTITION BY user_id ORDER BY day) AS previous_day
         FROM activity_days
     ),
     activity_marked AS (
       SELECT user_id, day,
              CASE
                WHEN previous_day IS NULL
                  OR day > previous_day + 59
                THEN 1 ELSE 0
              END AS starts_group
         FROM activity_sorted
     ),
     activity_grouped AS (
       SELECT user_id, day,
              sum(starts_group) OVER (
                PARTITION BY user_id ORDER BY day
              ) AS group_id
         FROM activity_marked
     ),
     active_intervals AS (
       SELECT user_id,
              min(day) AS starts_on,
              (max(day) + 59)::date AS ends_on
         FROM activity_grouped
        GROUP BY user_id, group_id
     ),
     active_events AS (
       SELECT starts_on AS day, count(*)::int AS delta
         FROM active_intervals
        GROUP BY starts_on
       UNION ALL
       SELECT (ends_on + 1)::date, -count(*)::int
         FROM active_intervals
        GROUP BY ends_on
     ),
     active_events_folded AS (
       SELECT day, sum(delta)::int AS delta
         FROM active_events
        GROUP BY day
     ),
     users_active AS (
       SELECT d.day,
              sum(COALESCE(ae.delta, 0)) OVER (ORDER BY d.day)::int AS n
         FROM days d
         LEFT JOIN active_events_folded ae ON ae.day = d.day
     ),
     votes_daily AS (
       SELECT (ve.occurred_at AT TIME ZONE 'Asia/Shanghai')::date AS day,
              count(*) FILTER (WHERE ve.new_direction > 0)::int AS up,
              count(*) FILTER (WHERE ve.new_direction < 0)::int AS down
         FROM ingest.vote_event ve
        WHERE ve.seq <= $1::bigint
          AND ve.time_precision <> 'bootstrap'
          AND ve.occurred_at IS NOT NULL
        GROUP BY 1
     ),
     revisions_daily AS (
       SELECT (r.occurred_at AT TIME ZONE 'Asia/Shanghai')::date AS day,
              count(*)::int AS n
         FROM ingest.revision r
        WHERE r.seq <= $1::bigint
        GROUP BY 1
     )
     INSERT INTO serve.site_overview_daily (
       date, users_total, users_contributors, users_authors, users_active,
       pages_total, pages_originals, pages_translations,
       votes_up, votes_down, revisions_total, computed_at
     )
     SELECT d.day,
            COALESCE(ut.n, 0),
            COALESCE(ct.n, 0),
            COALESCE(aut.n, 0),
            COALESCE(ua.n, 0),
            COALESCE(pt.total, 0),
            COALESCE(pt.originals, 0),
            COALESCE(pt.translations, 0),
            COALESCE(vd.up, 0),
            COALESCE(vd.down, 0),
            COALESCE(rd.n, 0),
            now()
       FROM days d
       LEFT JOIN users_total ut ON ut.day = d.day
       LEFT JOIN contributors_total ct ON ct.day = d.day
       LEFT JOIN authors_total aut ON aut.day = d.day
       LEFT JOIN users_active ua ON ua.day = d.day
       LEFT JOIN pages_total pt ON pt.day = d.day
       LEFT JOIN votes_daily vd ON vd.day = d.day
       LEFT JOIN revisions_daily rd ON rd.day = d.day
      ORDER BY d.day`,
    [window.toSeq],
  );
  return {
    affectedKeys: rowsWritten,
    rowsWritten,
    notes: [
      'B1：页面/作者累计与每日票、修订均包含已删页，回答全站累计产出',
      'B5：status 与 deleted:/old: 前缀都不作为站点总览过滤条件',
      'bootstrap 票不伪造每日流量；当前态总票数由 site_stats.total_votes_state 承载',
    ],
  };
}
