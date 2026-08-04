-- Row-producing deleted-page companion to backfill_s3_dryrun.sql.
-- Caller must use REPEATABLE READ READ ONLY on v1 scpper-cn and TimeZone=UTC.
WITH
v1_raw AS MATERIALIZED (
  SELECT v.id AS v1_id,v."pageVersionId" AS page_version_id,
         pv."pageId" AS page_id,
         coalesce(v."userId"::text,'a:'||v."anonKey") AS voter,
         v."userId" AS user_id,v.timestamp AS ts,
         sign(v.direction)::int AS dir,pv."validFrom" AS valid_from,
         p."isDeleted" AS is_deleted
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
    ) x
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
     AND EXISTS (
       SELECT 1 FROM r2_log_pages p WHERE p.page_id=g.page_id
     )
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
  SELECT 0 AS segment,p.id AS page_id,u.id::text AS voter,
         l.ts,sign(l.raw_dir)::int AS dir,
         ('legacy:'||l.source_table||':'||l.source_id)::text AS ref
    FROM legacy_dedup l
    JOIN public."Page" p ON p."wikidotId"=l.page_wid
    JOIN public."User" u ON u."wikidotId"=l.user_wid
   WHERE l.ts<timestamptz '2022-06-01 00:00:00+00'
  UNION ALL
  SELECT 1,r.page_id,r.voter,r.ts AT TIME ZONE 'Asia/Shanghai',r.dir,
         ('v1:'||r.v1_id)::text
    FROM r1 r
   WHERE r.ts>=timestamp '2022-06-01 00:00:00'
     AND NOT EXISTS (
       SELECT 1 FROM r2_auto_delete d WHERE d.v1_id=r.v1_id
     )
),
ordered AS MATERIALIZED (
  SELECT *,
         lag(dir) OVER (
           PARTITION BY page_id,voter ORDER BY segment,ts,ref
         ) AS prev_dir
    FROM observations
),
events AS MATERIALIZED (
  SELECT * FROM ordered WHERE dir<>coalesce(prev_dir,0)
),
final_event AS MATERIALIZED (
  SELECT DISTINCT ON (page_id,voter) page_id,voter,dir,ts
    FROM events
   ORDER BY page_id,voter,segment DESC,ts DESC,ref DESC
),
page_state AS MATERIALIZED (
  SELECT page_id,coalesce(sum(dir),0)::int AS v1_rating,
         count(*) FILTER (WHERE dir<>0)::int AS v1_active,
         max(ts) AS last_observation_at
    FROM final_event GROUP BY page_id
),
last_nonnull AS MATERIALIZED (
  SELECT DISTINCT ON ("pageId") "pageId" AS page_id,rating
    FROM public."PageVersion"
   WHERE rating IS NOT NULL
   ORDER BY "pageId","validFrom" DESC NULLS LAST,id DESC
),
legacy_terminal AS MATERIALIZED (
  SELECT p.id AS page_id,sum(sign(v."Value"))::int AS legacy_rating,
         count(*) FILTER (WHERE sign(v."Value")<>0)::int AS legacy_active
    FROM legacy_votes_cn.votes v
    JOIN public."Page" p ON p."wikidotId"=v."PageId"
   GROUP BY p.id
)
SELECT p.id AS page_id,p."wikidotId" AS wikidot_id,p."currentUrl" AS slug,
       coalesce(ps.v1_rating,0)::int AS v1_rating,
       coalesce(ps.v1_active,0)::int AS v1_active,
       ps.last_observation_at,
       ln.rating AS pageversion_rating,
       abs(coalesce(ps.v1_rating,0)-coalesce(ln.rating,0))::int
         AS correction_abs,
       lt.legacy_rating,lt.legacy_active
  FROM public."Page" p
  LEFT JOIN page_state ps ON ps.page_id=p.id
  LEFT JOIN last_nonnull ln ON ln.page_id=p.id
  LEFT JOIN legacy_terminal lt ON lt.page_id=p.id
 WHERE p."isDeleted"
 ORDER BY p.id;
