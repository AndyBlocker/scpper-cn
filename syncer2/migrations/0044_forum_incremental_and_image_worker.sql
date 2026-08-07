-- =====================================================================================
-- 0044_forum_incremental_and_image_worker.sql
-- 论坛廉价信号水位/追平与稳态车道，以及图片 worker 的可退避认领字段。
--
-- 迁移必须先于依赖这些列的 5 分钟采集进程部署。
-- =====================================================================================

\set ON_ERROR_STOP on

DO $guard$
BEGIN
  IF current_database() IN ('scpper-cn', 'scpper_cn', 'scpper-syncer', 'scpper_user') THEN
    RAISE EXCEPTION '[0044] 拒绝在受保护库 % 上修改采集队列', current_database()
      USING ERRCODE = '42501';
  END IF;
END
$guard$;

BEGIN;

-- 87k 冷积压与“刚由分类信号发现有回复”的线程不能共用年龄告警和认领顺序。
-- 既有行全部是 sitemap 冷积压，默认 catchup；增量发现显式写 steady，并可把同一目标晋升。
ALTER TABLE meta.forum_scan_task
  ADD COLUMN IF NOT EXISTS lane text NOT NULL DEFAULT 'catchup';

DO $constraint$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'meta.forum_scan_task'::regclass
       AND conname = 'forum_scan_task_lane_ck'
  ) THEN
    ALTER TABLE meta.forum_scan_task
      ADD CONSTRAINT forum_scan_task_lane_ck CHECK (lane IN ('catchup', 'steady'));
  END IF;
END
$constraint$;

DROP INDEX IF EXISTS meta.fst_claim;
CREATE INDEX fst_claim
  ON meta.forum_scan_task(lane, kind, priority DESC, not_before NULLS FIRST, id)
  WHERE locked_by IS NULL;

COMMENT ON COLUMN meta.forum_scan_task.lane IS
  'catchup=一次性 sitemap/冷启动追平，只看队列下降趋势；steady=分类活动信号命中的日常增量，按年龄告警。';

-- ForumStartModule 是每轮一请求的全局信号。observed_* 记录最近观测，swept_* 只在
-- changed category 已成功翻到旧水位后推进；两组分开可避免“写了信号、进程崩溃”丢更新。
CREATE TABLE IF NOT EXISTS meta.forum_incremental_category_state (
  category_id              bigint PRIMARY KEY,
  observed_thread_count    int NOT NULL DEFAULT 0,
  observed_post_count      int NOT NULL DEFAULT 0,
  observed_last_post_at    timestamptz,
  observed_last_thread_id  bigint,
  observed_last_post_id    bigint,
  signal_observed_at       timestamptz NOT NULL,
  swept_thread_count       int,
  swept_post_count         int,
  swept_last_post_at       timestamptz,
  swept_last_thread_id     bigint,
  swept_last_post_id       bigint,
  swept_at                 timestamptz,
  last_error               text,
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fic_counts_ck CHECK (observed_thread_count >= 0 AND observed_post_count >= 0),
  CONSTRAINT fic_swept_counts_ck CHECK (
    (swept_thread_count IS NULL OR swept_thread_count >= 0)
    AND (swept_post_count IS NULL OR swept_post_count >= 0)
  )
);

CREATE INDEX IF NOT EXISTS fic_unswept
  ON meta.forum_incremental_category_state(signal_observed_at, category_id)
  WHERE swept_at IS NULL
     OR observed_thread_count IS DISTINCT FROM swept_thread_count
     OR observed_post_count IS DISTINCT FROM swept_post_count
     OR observed_last_post_at IS DISTINCT FROM swept_last_post_at
     OR observed_last_thread_id IS DISTINCT FROM swept_last_thread_id
     OR observed_last_post_id IS DISTINCT FROM swept_last_post_id;

COMMENT ON TABLE meta.forum_incremental_category_state IS
  'ForumStartModule 分类级廉价信号与已完成增量扫描水位。每轮只读 1 个全局模块；仅信号变化分类分页。';

-- v1 worker 的任务状态机需要“何时可重试”和稳定失败类别。外站失败单独标 external，
-- 不能进入 Wikidot 自适应出口健康窗口；wikidot_site 才走共享 PostgresAdaptiveEgressGate。
ALTER TABLE meta.image_ingest_job
  ADD COLUMN IF NOT EXISTS not_before timestamptz,
  ADD COLUMN IF NOT EXISTS failure_class text,
  ADD COLUMN IF NOT EXISTS egress_class text;

DO $constraint$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'meta.image_ingest_job'::regclass
       AND conname = 'image_ingest_job_failure_class_ck'
  ) THEN
    ALTER TABLE meta.image_ingest_job
      ADD CONSTRAINT image_ingest_job_failure_class_ck CHECK (
        failure_class IS NULL OR failure_class IN (
          'http_transient', 'http_permanent', 'timeout', 'network', 'too_large',
          'invalid_content_type', 'invalid_url', 'blocked_host', 'storage', 'unknown'
        )
      );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'meta.image_ingest_job'::regclass
       AND conname = 'image_ingest_job_egress_class_ck'
  ) THEN
    ALTER TABLE meta.image_ingest_job
      ADD CONSTRAINT image_ingest_job_egress_class_ck CHECK (
        egress_class IS NULL OR egress_class IN ('wikidot_site', 'external')
      );
  END IF;
END
$constraint$;

DROP INDEX IF EXISTS meta.iij_claim;
CREATE INDEX iij_claim
  ON meta.image_ingest_job(status, not_before NULLS FIRST, id)
  WHERE locked_by IS NULL AND status IN ('pending', 'failed');

COMMENT ON COLUMN meta.image_ingest_job.not_before IS 'worker 指数退避截止；认领必须排除未来时间。';
COMMENT ON COLUMN meta.image_ingest_job.failure_class IS '稳定失败分类；与面向人的 error 文本分离。';
COMMENT ON COLUMN meta.image_ingest_job.egress_class IS
  'wikidot_site 走全站共享自适应出口；external 使用图片独立限速且不污染 Wikidot 健康度。';

DO $grants$
BEGIN
  IF to_regrole('ingestor_role') IS NOT NULL THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON meta.forum_incremental_category_state TO ingestor_role;
    GRANT SELECT, UPDATE ON meta.image_ingest_job TO ingestor_role;
  END IF;
  IF to_regrole('projector_role') IS NOT NULL THEN
    GRANT SELECT ON meta.forum_incremental_category_state TO projector_role;
  END IF;
  IF to_regrole('avatar_worker_role') IS NOT NULL THEN
    GRANT SELECT, UPDATE ON meta.image_ingest_job TO avatar_worker_role;
  END IF;
END
$grants$;

COMMIT;

-- 0040 的大视图保留为底层快照，只替换论坛行。显式 lane 使冷追平按趋势抑制告警，
-- steady 则继续按最老年龄报警；不再用“行数 >= 100”猜测运行阶段。
DO $view$
BEGIN
  IF to_regclass('meta.pending_collection_current_pre0044') IS NULL THEN
    ALTER VIEW meta.pending_collection_current RENAME TO pending_collection_current_pre0044;
  END IF;
END
$view$;

CREATE OR REPLACE VIEW meta.pending_collection_current AS
SELECT p.collection, p.family, p.pending_count, p.oldest_item_at,
       p.oldest_item_key, p.catchup, p.evidence
 FROM meta.pending_collection_current_pre0044 p
 WHERE p.family <> 'forum_scan_task'
   AND p.collection NOT IN ('scan_task:discussion', 'scan_task:forum')
UNION ALL
SELECT 'forum_scan_task:' || fst.lane || ':' || fst.kind AS collection,
       CASE fst.lane
         WHEN 'catchup' THEN 'forum_scan_task_catchup'
         ELSE 'forum_scan_task_steady'
       END AS family,
       count(*)::bigint AS pending_count,
       min(fst.first_seen_at) AS oldest_item_at,
       (array_agg(fst.id::text ORDER BY fst.first_seen_at, fst.id))[1] AS oldest_item_key,
       (fst.lane = 'catchup') AS catchup,
       jsonb_build_object(
         'lane', fst.lane,
         'kind', fst.kind,
         'due', count(*) FILTER (WHERE fst.not_before IS NULL OR fst.not_before <= now()),
         'max_attempts', max(fst.attempts),
         'max_stable_count', max(fst.stable_count)
       ) AS evidence
  FROM meta.forum_scan_task fst
 GROUP BY fst.lane, fst.kind
UNION ALL
SELECT 'scan_task:discussion:' || lane.lane AS collection,
       CASE lane.lane
         WHEN 'catchup' THEN 'forum_link_catchup'
         ELSE 'forum_discussion_steady'
       END AS family,
       count(*)::bigint AS pending_count,
       min(st.created_at) AS oldest_item_at,
       (array_agg(st.id::text ORDER BY st.created_at, st.id))[1] AS oldest_item_key,
       (lane.lane = 'catchup') AS catchup,
       jsonb_build_object(
         'lane', lane.lane,
         'due', count(*) FILTER (WHERE st.not_before IS NULL OR st.not_before <= now()),
         'max_attempts', max(st.attempts),
         'oldest_reasons', (array_agg(to_jsonb(st.reasons) ORDER BY st.created_at, st.id))[1]
       ) AS evidence
  FROM meta.scan_task st
 CROSS JOIN LATERAL (
   SELECT CASE WHEN 'forum_link_initial_catchup' = ANY(st.reasons)
               THEN 'catchup' ELSE 'steady' END AS lane
 ) lane
 WHERE st.kind IN ('forum', 'discussion')
 GROUP BY lane.lane;

COMMENT ON VIEW meta.pending_collection_current IS
  '待处理集合当前态；0044 起论坛 catchup/steady 显式分组，分别使用趋势与年龄判据。';

DO $grants$
BEGIN
  IF to_regrole('ingestor_role') IS NOT NULL THEN
    GRANT SELECT ON meta.pending_collection_current TO ingestor_role;
  END IF;
  IF to_regrole('projector_role') IS NOT NULL THEN
    GRANT SELECT ON meta.pending_collection_current TO projector_role;
  END IF;
END
$grants$;
