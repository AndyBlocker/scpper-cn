import type { PoolClient } from 'pg';
import {
  assertDeletedAuthorRatingConsistency,
  assertWindowDeletedAuthorRatingConsistency,
} from './consistency.js';
import { exec } from './sql.js';
import type { ProjectionApplyResult, ProjectionWindow } from './types.js';

/**
 * user_stats 同时依赖全局排名与没有 fact_seq 的 forum_post 当前态，因此每轮完整刷新。
 * 刷新在单事务内完成，BFF 不会看到“删了一半”的中间态。
 *
 * B2：默认只按 user_page 中的现存作品计算评分和排行。已删页 59% 的票是踩，
 * 纳入等于惩罚删过稿的人；这与 B1 的“站点累计产出”语义刻意不同。
 */
export async function projectUserStats(
  client: PoolClient,
  window: ProjectionWindow,
): Promise<ProjectionApplyResult> {
  if (window.rebuild) {
    await exec(client, 'project.user_stats:truncate', `TRUNCATE TABLE serve.user_stats`);
  } else {
    await exec(client, 'project.user_stats:refresh_delete', `DELETE FROM serve.user_stats`);
  }

  const rowsWritten = await exec(
    client,
    'project.user_stats:refresh_insert',
    `WITH work AS (
       SELECT up.user_id,
              sum(pc.rating)::int AS total_rating,
              count(*)::int AS page_count,
              (
                sum(pc.rating) FILTER (
                  WHERE (
                    (cardinality(pc.tags) > 0 AND NOT pc.tags @> ARRAY['段落']::text[])
                    OR (
                      cardinality(pc.tags) = 0
                      AND pc.category IN ('log-of-anomalous-items-cn', 'short-stories')
                    )
                  )
                )::double precision
                / NULLIF(count(*) FILTER (
                  WHERE (
                    (cardinality(pc.tags) > 0 AND NOT pc.tags @> ARRAY['段落']::text[])
                    OR (
                      cardinality(pc.tags) = 0
                      AND pc.category IN ('log-of-anomalous-items-cn', 'short-stories')
                    )
                  )
                ), 0)
              )::real AS overall_rating,
              COALESCE(sum(pc.rating) FILTER (
                WHERE pc.tags @> ARRAY['原创','scp']::text[]
              ), 0)::int AS rating_scp,
              count(*) FILTER (
                WHERE pc.tags @> ARRAY['原创','scp']::text[]
              )::int AS count_scp,
              COALESCE(sum(pc.rating) FILTER (
                WHERE NOT pc.tags @> ARRAY['原创']::text[]
                  AND NOT pc.tags @> ARRAY['作者']::text[]
                  AND NOT pc.tags @> ARRAY['掩盖页']::text[]
                  AND NOT pc.tags @> ARRAY['段落']::text[]
                  AND NOT pc.tags @> ARRAY['补充材料']::text[]
                  AND pc.category NOT IN ('log-of-anomalous-items-cn', 'short-stories')
              ), 0)::int AS rating_translation,
              count(*) FILTER (
                WHERE NOT pc.tags @> ARRAY['原创']::text[]
                  AND NOT pc.tags @> ARRAY['作者']::text[]
                  AND NOT pc.tags @> ARRAY['掩盖页']::text[]
                  AND NOT pc.tags @> ARRAY['段落']::text[]
                  AND NOT pc.tags @> ARRAY['补充材料']::text[]
                  AND pc.category NOT IN ('log-of-anomalous-items-cn', 'short-stories')
              )::int AS count_translation,
              COALESCE(sum(pc.rating) FILTER (
                WHERE pc.tags @> ARRAY['原创','goi格式']::text[]
              ), 0)::int AS rating_goi,
              count(*) FILTER (
                WHERE pc.tags @> ARRAY['原创','goi格式']::text[]
              )::int AS count_goi,
              COALESCE(sum(pc.rating) FILTER (
                WHERE pc.tags @> ARRAY['原创','故事']::text[]
              ), 0)::int AS rating_story,
              count(*) FILTER (
                WHERE pc.tags @> ARRAY['原创','故事']::text[]
              )::int AS count_story,
              COALESCE(sum(pc.rating) FILTER (
                WHERE pc.tags @> ARRAY['原创','wanderers']::text[]
              ), 0)::int AS rating_wanderers,
              count(*) FILTER (
                WHERE pc.tags @> ARRAY['原创','wanderers']::text[]
              )::int AS count_wanderers,
              COALESCE(sum(pc.rating) FILTER (
                WHERE pc.tags @> ARRAY['原创','艺术作品']::text[]
              ), 0)::int AS rating_art,
              count(*) FILTER (
                WHERE pc.tags @> ARRAY['原创','艺术作品']::text[]
              )::int AS count_art
         FROM serve.user_page up
         JOIN serve.page_current pc ON pc.page_id = up.page_id
        GROUP BY up.user_id
     ),
     votes_cast AS (
       -- 当前投票行计数：同一自然账号在同页的来源多行全部计入，与站点票数一致。
       SELECT vc.voter_id AS user_id,
              count(*) FILTER (WHERE vc.direction > 0)::int AS votes_cast_up,
              count(*) FILTER (WHERE vc.direction < 0)::int AS votes_cast_down,
              count(DISTINCT vc.page_id) FILTER (WHERE vc.direction <> 0)::int
                AS voted_page_count
         FROM serve.vote_current vc
        GROUP BY vc.voter_id
     ),
     votes_received AS (
       SELECT up.user_id,
              count(*) FILTER (WHERE vc.direction > 0)::int AS votes_received_up,
              count(*) FILTER (WHERE vc.direction < 0)::int AS votes_received_down
         FROM serve.user_page up
         JOIN serve.vote_current vc
           ON vc.page_id = up.page_id AND vc.direction <> 0
        GROUP BY up.user_id
     ),
     forum AS (
       SELECT fp.author_user_id AS user_id,
              count(*) FILTER (WHERE NOT fp.is_deleted)::int AS forum_post_count
         FROM ingest.forum_post fp
        WHERE fp.author_user_id IS NOT NULL
        GROUP BY fp.author_user_id
     ),
     activity AS (
       SELECT ve.voter_id AS user_id,
              COALESCE(ve.occurred_at, ve.observed_at) AS activity_at,
              'vote'::text AS activity_type,
              jsonb_build_object(
                'page_id', ve.page_id,
                'seq', ve.seq,
                'kind', ve.kind,
                'direction', ve.new_direction
              ) AS activity_detail,
              1 AS source_order,
              ve.seq AS source_key
         FROM ingest.vote_event ve
        WHERE ve.time_precision <> 'bootstrap'
       UNION ALL
       SELECT r.author_id,
              r.occurred_at,
              'revision'::text,
              jsonb_build_object(
                'page_id', r.page_id,
                'seq', r.seq,
                'rev_no', r.rev_no,
                'type', r.type
              ),
              2,
              r.seq
         FROM ingest.revision r
        WHERE r.author_id IS NOT NULL
       UNION ALL
       SELECT ae.actor_id,
              COALESCE(
                ae.at_date::timestamp AT TIME ZONE 'Asia/Shanghai',
                ae.observed_at
              ),
              'attribution'::text,
              jsonb_build_object(
                'page_id', ae.page_id,
                'seq', ae.seq,
                'role', ae.role,
                'action', ae.action
              ),
              3,
              ae.seq
         FROM ingest.attribution_event ae
       UNION ALL
       SELECT fp.author_user_id,
              fp.created_at,
              'forum_post'::text,
              jsonb_build_object(
                'post_id', fp.id,
                'thread_id', fp.thread_id,
                'is_deleted', fp.is_deleted
              ),
              4,
              fp.id
         FROM ingest.forum_post fp
        WHERE fp.author_user_id IS NOT NULL
     ),
     first_activity AS (
       SELECT DISTINCT ON (user_id)
              user_id, activity_at, activity_type, activity_detail
         FROM activity
        WHERE activity_at IS NOT NULL
        ORDER BY user_id, activity_at, source_order, source_key
     ),
     last_activity AS (
       SELECT DISTINCT ON (user_id)
              user_id, activity_at, activity_type, activity_detail
         FROM activity
        WHERE activity_at IS NOT NULL
        ORDER BY user_id, activity_at DESC, source_order DESC, source_key DESC
     )
     INSERT INTO serve.user_stats (
       user_id, total_rating, overall_rating, page_count,
       votes_cast_up, votes_cast_down, voted_page_count,
       votes_received_up, votes_received_down,
       rating_scp, rating_translation, rating_goi, rating_story, rating_wanderers, rating_art,
       count_scp, count_translation, count_goi, count_story, count_wanderers, count_art,
       first_activity_at, first_activity_type, first_activity_detail,
       last_activity_at, last_activity_type, last_activity_detail,
       forum_post_count, computed_at
     )
     SELECT u.id,
            COALESCE(w.total_rating, 0),
            COALESCE(w.overall_rating, 0),
            COALESCE(w.page_count, 0),
            COALESCE(vc.votes_cast_up, 0),
            COALESCE(vc.votes_cast_down, 0),
            COALESCE(vc.voted_page_count, 0),
            COALESCE(vr.votes_received_up, 0),
            COALESCE(vr.votes_received_down, 0),
            COALESCE(w.rating_scp, 0),
            COALESCE(w.rating_translation, 0),
            COALESCE(w.rating_goi, 0),
            COALESCE(w.rating_story, 0),
            COALESCE(w.rating_wanderers, 0),
            COALESCE(w.rating_art, 0),
            COALESCE(w.count_scp, 0),
            COALESCE(w.count_translation, 0),
            COALESCE(w.count_goi, 0),
            COALESCE(w.count_story, 0),
            COALESCE(w.count_wanderers, 0),
            COALESCE(w.count_art, 0),
            fa.activity_at,
            fa.activity_type,
            fa.activity_detail,
            la.activity_at,
            la.activity_type,
            la.activity_detail,
            COALESCE(f.forum_post_count, 0),
            now()
       FROM ingest."user" u
       LEFT JOIN work w ON w.user_id = u.id
       LEFT JOIN votes_cast vc ON vc.user_id = u.id
       LEFT JOIN votes_received vr ON vr.user_id = u.id
       LEFT JOIN forum f ON f.user_id = u.id
       LEFT JOIN first_activity fa ON fa.user_id = u.id
       LEFT JOIN last_activity la ON la.user_id = u.id`,
  );

  await exec(
    client,
    'project.user_stats:ranks',
    `WITH eligible AS (
       /*
        * 回填为无账号署名保留了 kind=anon 的独立 actor；这些行要有主页统计，
        * 但不能挤进“用户排行榜”。v1 UserStats 的有分候选全都有真实 Wikidot
        * 身份，因此用 wikidot_id（而不是脆弱的 id 段/kind 枚举）定义榜单资格。
        */
       SELECT us.*
         FROM serve.user_stats us
         JOIN ingest."user" u ON u.id = us.user_id
        WHERE u.wikidot_id IS NOT NULL
     ),
     total_r AS (
       SELECT user_id, row_number() OVER (ORDER BY total_rating DESC, user_id)::int AS rank
         FROM eligible WHERE total_rating > 0
     ),
     scp_r AS (
       SELECT user_id, row_number() OVER (ORDER BY rating_scp DESC, user_id)::int AS rank
         FROM eligible WHERE rating_scp > 0
     ),
     translation_r AS (
       SELECT user_id, row_number() OVER (ORDER BY rating_translation DESC, user_id)::int AS rank
         FROM eligible WHERE rating_translation > 0
     ),
     goi_r AS (
       SELECT user_id, row_number() OVER (ORDER BY rating_goi DESC, user_id)::int AS rank
         FROM eligible WHERE rating_goi > 0
     ),
     story_r AS (
       SELECT user_id, row_number() OVER (ORDER BY rating_story DESC, user_id)::int AS rank
         FROM eligible WHERE rating_story > 0
     ),
     wanderers_r AS (
       SELECT user_id, row_number() OVER (ORDER BY rating_wanderers DESC, user_id)::int AS rank
         FROM eligible WHERE rating_wanderers > 0
     ),
     art_r AS (
       SELECT user_id, row_number() OVER (ORDER BY rating_art DESC, user_id)::int AS rank
         FROM eligible WHERE rating_art > 0
     ),
     ranked AS (
       SELECT us.user_id,
              tr.rank AS rank_total,
              sr.rank AS rank_scp,
              rr.rank AS rank_translation,
              gr.rank AS rank_goi,
              str.rank AS rank_story,
              wr.rank AS rank_wanderers,
              ar.rank AS rank_art
         FROM serve.user_stats us
         LEFT JOIN total_r tr ON tr.user_id = us.user_id
         LEFT JOIN scp_r sr ON sr.user_id = us.user_id
         LEFT JOIN translation_r rr ON rr.user_id = us.user_id
         LEFT JOIN goi_r gr ON gr.user_id = us.user_id
         LEFT JOIN story_r str ON str.user_id = us.user_id
         LEFT JOIN wanderers_r wr ON wr.user_id = us.user_id
         LEFT JOIN art_r ar ON ar.user_id = us.user_id
     )
     UPDATE serve.user_stats us SET
       rank_total = r.rank_total,
       rank_scp = r.rank_scp,
       rank_translation = r.rank_translation,
       rank_goi = r.rank_goi,
       rank_story = r.rank_story,
       rank_wanderers = r.rank_wanderers,
       rank_art = r.rank_art
     FROM ranked r
     WHERE r.user_id = us.user_id`,
  );

  /*
   * B2/B4 的运行时证明：默认口径下，稳定随机抽 N 位有已删作品作者，
   * 要求删除负柱后的曲线末值与主页现存作品总评分逐位相等。
   * includeDeletedPages=true 是保留的显式诊断开关，不属于 B2，故不套该断言。
   */
  let consistencySampled = 0;
  let windowConsistencySampled = 0;
  if (!window.includeDeletedPages) {
    consistencySampled = await assertDeletedAuthorRatingConsistency(client);
    windowConsistencySampled = await assertWindowDeletedAuthorRatingConsistency(
      client,
      window.fromSeq,
      window.toSeq,
    );
  }

  return {
    affectedKeys: rowsWritten,
    rowsWritten,
    notes: [
      'votes_cast_up/down 按 vote_current 行计数；voted_page_count 按 page_id 去重',
      '排行榜只纳入有 wikidot_id 的真实账号；匿名署名保留主页统计但 rank 为 NULL',
      window.includeDeletedPages
        ? '作品评分/收票纳入已删页；首末活动无条件包含已删页'
        : 'B2：作品评分/收票默认排除已删页，只衡量现存作品；首末活动仍包含已删页',
      window.includeDeletedPages
        ? 'B2/B4 末值断言因显式 includeDeletedPages 诊断口径而跳过'
        : `B2/B4：全量稳定随机抽样 ${consistencySampled} 位有已删作品作者，曲线末值全部等于 total_rating`,
      window.includeDeletedPages
        ? 'B2/B4 本轮删除断言因显式 includeDeletedPages 诊断口径而跳过'
        : `B2/B4 本轮删除：抽样 ${windowConsistencySampled} 位作者，曲线末值全部等于 total_rating`,
      'B5：作品统计不按 deleted:/old: 前缀过滤归档活页，只按 status 执行 B2',
      'bootstrap 票不参与首末活动时间；总量状态计数仍计入',
      'forum_post 无 fact_seq，因此 user_stats 每轮事务内完整刷新',
    ],
  };
}
