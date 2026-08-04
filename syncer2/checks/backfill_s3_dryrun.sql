\set ON_ERROR_STOP on

-- S3 投票域只读预演。必须连接 v1 scpper-cn；本文件不含任何 DDL/DML，也不触碰
-- ingest.fact_seq。A3 的 Jun-1 换源结论优先于旧 §3.1。
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL TIME ZONE 'UTC';
SET LOCAL work_mem = '256MB';

DO $$
BEGIN
  IF current_database() NOT IN ('scpper-cn', 'scpper_cn') THEN
    RAISE EXCEPTION 'S3 dry-run 必须连接 v1 scpper-cn，当前为 %', current_database();
  END IF;
END $$;

WITH
v1_raw AS MATERIALIZED (
  SELECT v.id AS v1_id,
         v."pageVersionId" AS page_version_id,
         pv."pageId" AS page_id,
         COALESCE(v."userId"::text, 'a:' || v."anonKey") AS voter,
         v."userId" AS user_id,
         v.timestamp AS ts,
         v.direction AS raw_dir,
         sign(v.direction)::int AS dir,
         pv."validFrom" AS valid_from,
         p."isDeleted" AS is_deleted
    FROM public."Vote" v
    JOIN public."PageVersion" pv ON pv.id = v."pageVersionId"
    JOIN public."Page" p ON p.id = pv."pageId"
),
r1_ranked AS MATERIALIZED (
  SELECT *,
         row_number() OVER (
           PARTITION BY page_id, voter, ts
           ORDER BY valid_from DESC NULLS LAST, v1_id DESC
         ) AS rn,
         count(*) OVER (PARTITION BY page_id, voter, ts) AS group_n,
         min(dir) OVER (PARTITION BY page_id, voter, ts) AS group_min_dir,
         max(dir) OVER (PARTITION BY page_id, voter, ts) AS group_max_dir,
         count(*) OVER (
           PARTITION BY page_id, voter, ts, page_version_id
         ) AS same_version_n,
         min(dir) OVER (
           PARTITION BY page_id, voter, ts, page_version_id
         ) AS same_version_min_dir,
         max(dir) OVER (
           PARTITION BY page_id, voter, ts, page_version_id
         ) AS same_version_max_dir
    FROM v1_raw
),
r1 AS MATERIALIZED (
  SELECT * FROM r1_ranked WHERE rn = 1
),
r2_groups AS MATERIALIZED (
  SELECT page_id,
         voter,
         dir,
         array_agg(v1_id ORDER BY ts, v1_id) AS ids,
         array_agg(ts ORDER BY ts, v1_id) AS tses,
         bool_or(is_deleted) AS is_deleted,
         count(*)::int AS n
    FROM r1
   WHERE dir <> 0
   GROUP BY page_id, voter, dir
  HAVING count(*) >= 2
),
r2_candidates AS MATERIALIZED (
  SELECT *
    FROM r2_groups
   WHERE n = 2
     AND abs(extract(epoch FROM (tses[2] - tses[1])) - 28800) <= 1
),
-- voteResyncAudit 的临时 schema 已清理；cleanup_log 是仍在主库的 durable 物证：
-- 同一事故批次、受影响 PageVersion 及 UTC/+8h 双时间戳。页面集合与其时间包络
-- 同时命中才视为高置信；已删页仍然绝不自动折叠。
r2_log_pages AS MATERIALIZED (
  SELECT DISTINCT pv."pageId" AS page_id
    FROM public.vote_tz_dup_cleanup_log l
    JOIN public."PageVersion" pv ON pv.id = l."pageVersionId"
),
r2_bounds AS MATERIALIZED (
  SELECT min(ts_kept) AS lo, max(ts_deleted) AS hi
    FROM public.vote_tz_dup_cleanup_log
),
r2_classified AS MATERIALIZED (
  SELECT c.*,
         EXISTS (
           SELECT 1 FROM r2_log_pages lp WHERE lp.page_id = c.page_id
         )
         AND c.tses[1] >= (SELECT lo FROM r2_bounds)
         AND c.tses[2] <= (SELECT hi FROM r2_bounds) AS has_evidence
    FROM r2_candidates c
),
r2_auto_delete AS MATERIALIZED (
  SELECT ids[2] AS v1_id
    FROM r2_classified
   WHERE has_evidence
     AND NOT is_deleted
),
r2_adjacent AS MATERIALIZED (
  SELECT *
    FROM (
      SELECT page_id,
             voter,
             dir,
             is_deleted,
             ts,
             v1_id,
             count(*) OVER (PARTITION BY page_id, voter, dir) AS n,
             lag(ts) OVER (
               PARTITION BY page_id, voter, dir ORDER BY ts, v1_id
             ) AS prev_ts
        FROM r1
       WHERE dir <> 0
    ) x
   WHERE abs(extract(epoch FROM (ts - prev_ts)) - 28800) <= 1
),
r3_pairs AS MATERIALIZED (
  SELECT *
    FROM (
      SELECT page_id,
             voter,
             dir,
             ts,
             v1_id,
             lag(ts) OVER (
               PARTITION BY page_id, voter, dir ORDER BY ts, v1_id
             ) AS prev_ts,
             lag(v1_id) OVER (
               PARTITION BY page_id, voter, dir ORDER BY ts, v1_id
             ) AS prev_id
        FROM r1
       WHERE dir <> 0
         AND ts >= timestamp '2022-05-14 00:00:00'
         AND ts <  timestamp '2022-06-01 00:00:00'
    ) x
   WHERE ts - prev_ts BETWEEN interval '0' AND interval '48 hours'
),
legacy_raw AS MATERIALIZED (
  SELECT 'history'::text AS source_table,
         h."__Id" AS source_id,
         h."PageId" AS page_wid,
         h."UserId" AS user_wid,
         h."DateTime" AS ts,
         h."Value" AS raw_dir,
         0 AS priority
    FROM legacy_votes_cn.vote_history h
  UNION ALL
  SELECT 'votes',
         v."__Id",
         v."PageId",
         v."UserId",
         v."DateTime",
         v."Value",
         1
    FROM legacy_votes_cn.votes v
),
legacy_dedup AS MATERIALIZED (
  SELECT DISTINCT ON (page_wid, user_wid, ts) *
    FROM legacy_raw
   ORDER BY page_wid, user_wid, ts, priority DESC, source_id DESC
),
legacy_mapped AS MATERIALIZED (
  SELECT p.id AS page_id,
         u.id AS user_id,
         u.id::text AS voter,
         l.ts,
         sign(l.raw_dir)::int AS dir,
         l.raw_dir,
         l.source_table,
         l.source_id
    FROM legacy_dedup l
    LEFT JOIN public."Page" p ON p."wikidotId" = l.page_wid
    LEFT JOIN public."User" u ON u."wikidotId" = l.user_wid
),
observations AS MATERIALIZED (
  SELECT 0 AS segment,
         page_id,
         voter,
         user_id,
         ts,
         dir,
         raw_dir,
         ('legacy:' || source_table || ':' || source_id)::text AS ref,
         'legacy'::text AS source,
         'exact'::text AS time_precision
    FROM legacy_mapped
   WHERE page_id IS NOT NULL
     AND user_id IS NOT NULL
     AND ts < timestamptz '2022-06-01 00:00:00+00'
  UNION ALL
  SELECT 1,
         r.page_id,
         r.voter,
         r.user_id,
         r.ts AT TIME ZONE 'Asia/Shanghai',
         r.dir,
         r.raw_dir,
         ('v1:' || r.v1_id)::text,
         'v1_backfill',
         CASE
           WHEN r.ts = timestamp '2022-05-25 00:00:00' THEN 'bootstrap'
           ELSE 'day'
         END
    FROM r1 r
   WHERE r.ts >= timestamp '2022-06-01 00:00:00'
     AND NOT EXISTS (
       SELECT 1 FROM r2_auto_delete d WHERE d.v1_id = r.v1_id
     )
),
ordered AS MATERIALIZED (
  SELECT *,
         lag(dir) OVER (
           PARTITION BY page_id, voter ORDER BY segment, ts, ref
         ) AS prev_dir
    FROM observations
),
events AS MATERIALIZED (
  SELECT *,
         CASE
           WHEN dir = 0 THEN 'revoke'
           WHEN coalesce(prev_dir, 0) = 0 THEN 'vote'
           ELSE 'revote'
         END AS kind
    FROM ordered
   WHERE dir <> coalesce(prev_dir, 0)
),
final_event AS MATERIALIZED (
  SELECT DISTINCT ON (page_id, voter)
         page_id, voter, user_id, dir, ts, time_precision, ref
    FROM events
   ORDER BY page_id, voter, segment DESC, ts DESC, ref DESC
),
page_state AS MATERIALIZED (
  SELECT page_id,
         coalesce(sum(dir), 0)::int AS rating,
         count(*) FILTER (WHERE dir = 1)::int AS up,
         count(*) FILTER (WHERE dir = -1)::int AS down,
         count(*) FILTER (WHERE dir = 0)::int AS revoked
    FROM final_event
   GROUP BY page_id
),
current_pv AS MATERIALIZED (
  SELECT DISTINCT ON (pv."pageId")
         pv."pageId" AS page_id,
         pv.rating,
         pv."voteCount" AS vote_count
    FROM public."PageVersion" pv
   WHERE pv."validTo" IS NULL
   ORDER BY pv."pageId", pv."validFrom" DESC NULLS LAST, pv.id DESC
),
last_nonnull AS MATERIALIZED (
  SELECT DISTINCT ON (pv."pageId")
         pv."pageId" AS page_id,
         pv.rating
    FROM public."PageVersion" pv
   WHERE pv.rating IS NOT NULL
   ORDER BY pv."pageId", pv."validFrom" DESC NULLS LAST, pv.id DESC
),
live_gate AS MATERIALIZED (
  SELECT p.id AS page_id,
         cp.rating AS remote_rating,
         coalesce(ps.rating, 0) AS local_rating
    FROM public."Page" p
    JOIN current_pv cp ON cp.page_id = p.id
    LEFT JOIN page_state ps ON ps.page_id = p.id
   WHERE NOT p."isDeleted"
     AND cp.rating IS NOT NULL
     AND (
       coalesce(cp.vote_count, 0) > 0
       OR coalesce(ps.up + ps.down, 0) > 0
     )
),
deleted_gate AS MATERIALIZED (
  SELECT p.id AS page_id,
         ln.rating AS baseline_rating,
         coalesce(ps.rating, 0) AS local_rating,
         coalesce(ps.rating, 0) - coalesce(ln.rating, 0) AS delta
    FROM public."Page" p
    LEFT JOIN last_nonnull ln ON ln.page_id = p.id
    LEFT JOIN page_state ps ON ps.page_id = p.id
   WHERE p."isDeleted"
),
legacy_terminal AS MATERIALIZED (
  SELECT p.id AS page_id, sum(sign(v."Value"))::int AS rating
    FROM legacy_votes_cn.votes v
    JOIN public."Page" p ON p."wikidotId" = v."PageId"
   GROUP BY p.id
)
SELECT jsonb_pretty(jsonb_build_object(
  'r1', jsonb_build_object(
    'raw', (SELECT count(*) FROM v1_raw),
    'kept', (SELECT count(*) FROM r1),
    'folded', (SELECT count(*) FROM r1_ranked WHERE rn > 1),
    'duplicateGroups', (SELECT count(*) FROM r1 WHERE group_n > 1),
    'conflictGroups', (
      SELECT count(*) FROM r1 WHERE group_min_dir <> group_max_dir
    ),
    'conflictRows', (
      SELECT coalesce(sum(group_n), 0)
        FROM r1 WHERE group_min_dir <> group_max_dir
    ),
    'sameVersionAmbiguous', (
      SELECT count(*)
        FROM r1
       WHERE same_version_n > 1
         AND same_version_min_dir <> same_version_max_dir
    )
  ),
  'r2', jsonb_build_object(
    'adjacent8hPairs', (SELECT count(*) FROM r2_adjacent),
    'n2Candidates', (SELECT count(*) FROM r2_candidates),
    'n3ReviewPairs', (SELECT count(*) FROM r2_adjacent WHERE n >= 3),
    'autoFold', (
      SELECT count(*) FROM r2_classified WHERE has_evidence AND NOT is_deleted
    ),
    'deletedAuditOnly', (
      SELECT count(*) FROM r2_classified WHERE has_evidence AND is_deleted
    ),
    'quarantine', (
      SELECT count(*) FROM r2_classified WHERE NOT has_evidence
    )
  ),
  'r3', jsonb_build_object('near48hPairs', (SELECT count(*) FROM r3_pairs)),
  'r4', jsonb_build_object(
    'rawPm2', (SELECT count(*) FROM v1_raw WHERE raw_dir IN (-2, 2)),
    'r1Pm2', (SELECT count(*) FROM r1 WHERE raw_dir IN (-2, 2))
  ),
  'legacy', jsonb_build_object(
    'raw', (SELECT count(*) FROM legacy_raw),
    'dedup', (SELECT count(*) FROM legacy_dedup),
    'mapped', (
      SELECT count(*) FROM legacy_mapped
       WHERE page_id IS NOT NULL AND user_id IS NOT NULL
    ),
    'missingPage', (SELECT count(*) FROM legacy_mapped WHERE page_id IS NULL),
    'missingUser', (SELECT count(*) FROM legacy_mapped WHERE user_id IS NULL),
    'postCutoff', (
      SELECT count(*) FROM legacy_mapped
       WHERE ts >= timestamptz '2022-06-01 00:00:00+00'
    ),
    'events', (SELECT count(*) FROM events WHERE source = 'legacy'),
    'revokes', (
      SELECT count(*) FROM events WHERE source = 'legacy' AND kind = 'revoke'
    )
  ),
  'bootstrap', jsonb_build_object(
    'rawExactMay25', (
      SELECT count(*) FROM v1_raw WHERE ts = timestamp '2022-05-25 00:00:00'
    ),
    'r1ExactMay25', (
      SELECT count(*) FROM r1 WHERE ts = timestamp '2022-05-25 00:00:00'
    ),
    'factEvents', (
      SELECT count(*) FROM events WHERE time_precision = 'bootstrap'
    )
  ),
  'r5', jsonb_build_object(
    'observations', (SELECT count(*) FROM observations),
    'events', (SELECT count(*) FROM events),
    'cromObservations', (
      SELECT count(*) FROM observations WHERE source = 'v1_backfill'
    ),
    'cromEvents', (
      SELECT count(*) FROM events WHERE source = 'v1_backfill'
    ),
    'cromNoops',
      (SELECT count(*) FROM observations WHERE source = 'v1_backfill')
      - (SELECT count(*) FROM events WHERE source = 'v1_backfill'),
    'vote', (SELECT count(*) FROM events WHERE kind = 'vote'),
    'revote', (SELECT count(*) FROM events WHERE kind = 'revote'),
    'revoke', (SELECT count(*) FROM events WHERE kind = 'revoke'),
    'currentRows', (SELECT count(*) FROM final_event),
    'currentNonzero', (SELECT count(*) FROM final_event WHERE dir <> 0),
    'currentRevoked', (SELECT count(*) FROM final_event WHERE dir = 0)
  ),
  'liveGate', jsonb_build_object(
    'pages', (SELECT count(*) FROM live_gate),
    'matched', (
      SELECT count(*) FROM live_gate WHERE local_rating = remote_rating
    ),
    'mismatched', (
      SELECT count(*) FROM live_gate WHERE local_rating <> remote_rating
    ),
    'matchRate', round(
      (SELECT count(*) FROM live_gate WHERE local_rating = remote_rating)::numeric
      / nullif((SELECT count(*) FROM live_gate), 0),
      6
    )
  ),
  'deletedGate', jsonb_build_object(
    'pages', (SELECT count(*) FROM deleted_gate),
    'ratingCorrected', (
      SELECT count(*) FROM deleted_gate
       WHERE local_rating IS DISTINCT FROM baseline_rating
    ),
    'legacyComparable', (
      SELECT count(*) FROM deleted_gate d JOIN legacy_terminal l USING (page_id)
    ),
    'legacyRatingMatched', (
      SELECT count(*)
        FROM deleted_gate d
        JOIN legacy_terminal l USING (page_id)
       WHERE d.local_rating = l.rating
    ),
    'deltaMin', (
      SELECT min(delta) FROM deleted_gate
       WHERE local_rating IS DISTINCT FROM baseline_rating
    ),
    'deltaP50', (
      SELECT percentile_disc(.5) WITHIN GROUP (ORDER BY delta)
        FROM deleted_gate
       WHERE local_rating IS DISTINCT FROM baseline_rating
    ),
    'deltaP95Abs', (
      SELECT percentile_disc(.95) WITHIN GROUP (ORDER BY abs(delta))
        FROM deleted_gate
       WHERE local_rating IS DISTINCT FROM baseline_rating
    ),
    'deltaMax', (
      SELECT max(delta) FROM deleted_gate
       WHERE local_rating IS DISTINCT FROM baseline_rating
    )
  )
)) AS s3_dryrun_report;

ROLLBACK;
