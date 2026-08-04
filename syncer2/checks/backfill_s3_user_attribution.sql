\set ON_ERROR_STOP on

-- S3 用户偏差逐人归因。连接 v1 scpper-cn，只读；结果是一行结构化 JSON。
-- old = v1 当前 PageVersion 上的 LatestVote，new = A3 换源/折叠后的终态。
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL TIME ZONE 'UTC';
SET LOCAL work_mem = '256MB';

DO $$
BEGIN
  IF current_database() NOT IN ('scpper-cn', 'scpper_cn') THEN
    RAISE EXCEPTION 'S3 user attribution 必须连接 v1 scpper-cn，当前为 %',
      current_database();
  END IF;
END $$;

WITH
v1_raw AS MATERIALIZED (
  SELECT v.id AS v1_id, v."pageVersionId" AS page_version_id,
         pv."pageId" AS page_id,
         COALESCE(v."userId"::text, 'a:' || v."anonKey") AS voter,
         v."userId" AS user_id, v.timestamp AS ts,
         v.direction AS raw_dir, sign(v.direction)::int AS dir,
         pv."validFrom" AS valid_from, p."isDeleted" AS is_deleted
    FROM public."Vote" v
    JOIN public."PageVersion" pv ON pv.id=v."pageVersionId"
    JOIN public."Page" p ON p.id=pv."pageId"
),
r1 AS MATERIALIZED (
  SELECT *
    FROM (
      SELECT v1_raw.*,
             row_number() OVER (
               PARTITION BY page_id,voter,ts
               ORDER BY valid_from DESC NULLS LAST,v1_id DESC
             ) AS rn
        FROM v1_raw
    ) ranked
   WHERE rn=1
),
r2_groups AS MATERIALIZED (
  SELECT page_id,voter,dir,
         array_agg(v1_id ORDER BY ts,v1_id) AS ids,
         array_agg(ts ORDER BY ts,v1_id) AS tses,
         bool_or(is_deleted) AS is_deleted,count(*)::int AS n
    FROM r1 WHERE dir<>0
   GROUP BY page_id,voter,dir
),
r2_log_pages AS MATERIALIZED (
  SELECT DISTINCT pv."pageId" AS page_id
    FROM public.vote_tz_dup_cleanup_log l
    JOIN public."PageVersion" pv ON pv.id=l."pageVersionId"
),
r2_bounds AS MATERIALIZED (
  SELECT min(ts_kept) AS lo,max(ts_deleted) AS hi
    FROM public.vote_tz_dup_cleanup_log
),
r2_auto_delete AS MATERIALIZED (
  SELECT ids[2] AS v1_id
    FROM r2_groups g
   WHERE n=2
     AND abs(extract(epoch FROM (tses[2]-tses[1]))-28800)<=1
     AND NOT is_deleted
     AND EXISTS (SELECT 1 FROM r2_log_pages p WHERE p.page_id=g.page_id)
     AND tses[1]>=(SELECT lo FROM r2_bounds)
     AND tses[2]<=(SELECT hi FROM r2_bounds)
),
legacy_raw AS MATERIALIZED (
  SELECT 'history'::text AS source_table,h."__Id" AS source_id,
         h."PageId" AS page_wid,h."UserId" AS user_wid,
         h."DateTime" AS ts,h."Value" AS raw_dir,0 AS priority
    FROM legacy_votes_cn.vote_history h
  UNION ALL
  SELECT 'votes',v."__Id",v."PageId",v."UserId",v."DateTime",v."Value",1
    FROM legacy_votes_cn.votes v
),
legacy_dedup AS MATERIALIZED (
  SELECT DISTINCT ON (page_wid,user_wid,ts) *
    FROM legacy_raw
   ORDER BY page_wid,user_wid,ts,priority DESC,source_id DESC
),
observations AS MATERIALIZED (
  SELECT 0 AS segment,p.id AS page_id,u.id::text AS voter,u.id AS user_id,
         l.ts,sign(l.raw_dir)::int AS dir,l.raw_dir,
         ('legacy:'||l.source_table||':'||l.source_id)::text AS ref,
         'legacy'::text AS source,NULL::int AS page_version_id
    FROM legacy_dedup l
    JOIN public."Page" p ON p."wikidotId"=l.page_wid
    JOIN public."User" u ON u."wikidotId"=l.user_wid
   WHERE l.ts<timestamptz '2022-06-01 00:00:00+00'
  UNION ALL
  SELECT 1,r.page_id,r.voter,r.user_id,
         r.ts AT TIME ZONE 'Asia/Shanghai',r.dir,r.raw_dir,
         ('v1:'||r.v1_id)::text,'v1_backfill',r.page_version_id
    FROM r1 r
   WHERE r.ts>=timestamp '2022-06-01 00:00:00'
     AND NOT EXISTS (SELECT 1 FROM r2_auto_delete d WHERE d.v1_id=r.v1_id)
),
ordered AS MATERIALIZED (
  SELECT *,
         lag(dir) OVER (
           PARTITION BY page_id,voter ORDER BY segment,ts,ref
         ) AS prev_dir
    FROM observations
),
events AS MATERIALIZED (
  SELECT *,
         CASE WHEN dir=0 THEN 'revoke'
              WHEN coalesce(prev_dir,0)=0 THEN 'vote'
              ELSE 'revote' END AS event_kind
    FROM ordered
   WHERE dir<>coalesce(prev_dir,0)
),
final_event AS MATERIALIZED (
  SELECT DISTINCT ON (page_id,voter)
         page_id,voter,user_id,dir,ts,ref,source,raw_dir,page_version_id
    FROM events
   ORDER BY page_id,voter,segment DESC,ts DESC,ref DESC
),
current_pv AS MATERIALIZED (
  SELECT DISTINCT ON ("pageId")
         id,"pageId" AS page_id,"isDeleted" AS pv_deleted
    FROM public."PageVersion"
   WHERE "validTo" IS NULL
   ORDER BY "pageId","validFrom" DESC NULLS LAST,id DESC
),
old_live AS MATERIALIZED (
  SELECT lv."userId" AS user_id,cp.page_id,
         sign(lv.direction)::int AS dir
    FROM public."LatestVote" lv
    JOIN current_pv cp ON cp.id=lv."pageVersionId"
    JOIN public."Page" p ON p.id=cp.page_id
   WHERE lv."userId" IS NOT NULL AND sign(lv.direction)<>0
     AND NOT p."isDeleted" AND NOT cp.pv_deleted
),
new_all AS MATERIALIZED (
  SELECT f.user_id,f.page_id,f.dir,p."isDeleted" AS is_deleted,
         f.source,f.ts,f.ref,f.page_version_id
    FROM final_event f
    JOIN public."Page" p ON p.id=f.page_id
   WHERE f.user_id IS NOT NULL AND f.dir<>0
),
new_stats AS MATERIALIZED (
  SELECT user_id,
         count(*)::int AS new_all,
         count(*) FILTER (WHERE NOT is_deleted)::int AS new_live,
         count(*) FILTER (WHERE is_deleted)::int AS new_deleted
    FROM new_all GROUP BY user_id
),
old_stats AS MATERIALIZED (
  SELECT user_id,count(*)::int AS old_live FROM old_live GROUP BY user_id
),
comparison AS MATERIALIZED (
  SELECT u.id AS user_id,
         coalesce(o.old_live,0) AS old_live,
         coalesce(n.new_all,0) AS new_all,
         coalesce(n.new_live,0) AS new_live,
         coalesce(n.new_deleted,0) AS new_deleted,
         abs(coalesce(n.new_all,0)-coalesce(o.old_live,0))::numeric
           / greatest(coalesce(o.old_live,0),1) AS all_drift,
         abs(coalesce(n.new_live,0)-coalesce(o.old_live,0))::numeric
           / greatest(coalesce(o.old_live,0),1) AS live_drift
    FROM public."User" u
    LEFT JOIN old_stats o ON o.user_id=u.id
    LEFT JOIN new_stats n ON n.user_id=u.id
),
over_five_all AS MATERIALIZED (
  SELECT * FROM comparison WHERE all_drift>.05
),
new_live AS MATERIALIZED (
  SELECT * FROM new_all WHERE NOT is_deleted
),
residual AS MATERIALIZED (
  SELECT * FROM comparison WHERE all_drift>.05 AND live_drift>.05
),
pair_diff AS MATERIALIZED (
  SELECT r.user_id,coalesce(o.page_id,n.page_id) AS page_id,
         o.dir AS old_dir,n.dir AS new_dir,
         f.ref AS final_ref,f.source AS final_source,
         CASE
           WHEN o.page_id IS NOT NULL AND n.page_id IS NULL
             AND f.page_id IS NULL THEN 'old_only_no_final'
           WHEN o.page_id IS NULL AND n.page_id IS NOT NULL
             AND n.source='legacy' THEN 'new_only_legacy'
           WHEN o.page_id IS NULL AND n.page_id IS NOT NULL
             AND n.source='v1_backfill'
             AND n.page_version_id IS DISTINCT FROM cp.id
             THEN 'new_only_crom_old_pageversion'
           WHEN o.page_id IS NOT NULL AND n.page_id IS NULL THEN 'old_only_other'
           WHEN o.page_id IS NULL AND n.page_id IS NOT NULL THEN 'new_only_other'
           ELSE 'direction_changed'
         END AS pair_reason
    FROM old_live o
    FULL JOIN new_live n
      ON n.user_id=o.user_id AND n.page_id=o.page_id
    JOIN residual r ON r.user_id=coalesce(o.user_id,n.user_id)
    LEFT JOIN current_pv cp ON cp.page_id=coalesce(o.page_id,n.page_id)
    LEFT JOIN final_event f
      ON f.user_id=coalesce(o.user_id,n.user_id)
     AND f.page_id=coalesce(o.page_id,n.page_id)
   WHERE o.page_id IS NULL OR n.page_id IS NULL OR o.dir<>n.dir
),
signals AS MATERIALIZED (
  SELECT r.user_id,
         EXISTS (
           SELECT 1 FROM r1 x
            WHERE x.user_id=r.user_id AND x.raw_dir IN (-2,2)
         ) AS has_pm2,
         EXISTS (
           SELECT 1 FROM r2_groups g
            WHERE g.voter=r.user_id::text AND g.n=2
              AND abs(extract(epoch FROM (g.tses[2]-g.tses[1]))-28800)<=1
         ) AS has_r2,
         EXISTS (
           SELECT 1 FROM events e
            WHERE e.user_id=r.user_id AND e.event_kind IN ('revote','revoke')
         ) AS has_intermediate_state
    FROM residual r
),
attributed AS MATERIALIZED (
  SELECT r.*,u."wikidotId" AS wikidot_id,u."displayName" AS display_name,
         CASE
           WHEN count(*) FILTER (WHERE d.pair_reason='old_only_no_final')>0
             THEN 'v1_latestvote_without_source_event'
           WHEN count(*) FILTER (WHERE d.pair_reason='new_only_legacy')>0
             THEN 'legacy_current_pv_scope'
           WHEN count(*) FILTER (
             WHERE d.pair_reason='new_only_crom_old_pageversion'
           )>0 THEN 'crom_old_pageversion_scope'
           ELSE 'unattributed'
         END AS attribution,
         count(*) FILTER (WHERE d.pair_reason='old_only_no_final')::int
           AS stale_latestvote_pairs,
         count(*) FILTER (WHERE d.pair_reason='new_only_legacy')::int
           AS legacy_scope_pairs,
         count(*) FILTER (
           WHERE d.pair_reason='new_only_crom_old_pageversion'
         )::int AS crom_old_pv_pairs,
         s.has_r2,s.has_pm2,s.has_intermediate_state,
         coalesce(
           jsonb_agg(
             jsonb_build_object(
               'pageId',d.page_id,'oldDirection',d.old_dir,
               'newDirection',d.new_dir,'reason',d.pair_reason,
               'finalRef',d.final_ref
             ) ORDER BY d.page_id
           ) FILTER (WHERE d.page_id IS NOT NULL),
           '[]'::jsonb
         ) AS pair_diffs
    FROM residual r
    JOIN public."User" u ON u.id=r.user_id
    JOIN signals s USING (user_id)
    LEFT JOIN pair_diff d USING (user_id)
   GROUP BY r.user_id,r.old_live,r.new_all,r.new_live,r.new_deleted,
            r.all_drift,r.live_drift,
            u."wikidotId",u."displayName",
            s.has_r2,s.has_pm2,s.has_intermediate_state
)
SELECT jsonb_pretty(jsonb_build_object(
  'generatedAt',now(),
  'definition','abs(new-old)/max(old,1)>5%; old=LatestVote@current live PageVersion; new=A3 final state',
  'overFiveAllUsers',(SELECT count(*) FROM over_five_all),
  'explainedByDeletedPages',
    (SELECT count(*) FROM over_five_all)-(SELECT count(*) FROM residual),
  'residualUsers',(SELECT count(*) FROM attributed),
  'anonymousResidualUsers',0,
  'unattributedUsers',(
    SELECT count(*) FROM attributed WHERE attribution='unattributed'
  ),
  'categories',(
    SELECT jsonb_object_agg(attribution,n)
      FROM (
        SELECT attribution,count(*) AS n
          FROM attributed GROUP BY attribution ORDER BY attribution
      ) x
  ),
  'candidateSignals',jsonb_build_object(
    'r2TimezoneUsers',(SELECT count(*) FROM attributed WHERE has_r2),
    'plusMinus2Users',(SELECT count(*) FROM attributed WHERE has_pm2),
    'revoteOrRevokeUsers',(
      SELECT count(*) FROM attributed WHERE has_intermediate_state
    )
  ),
  'users',(
    SELECT jsonb_agg(to_jsonb(a) ORDER BY attribution,user_id) FROM attributed a
  )
)) AS s3_user_attribution;

ROLLBACK;
