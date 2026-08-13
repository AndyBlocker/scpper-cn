-- =====================================================================================
-- 0063_deferred_and_egress_episode_semantics.sql
--
-- 两组“事件/自我保护不等于故障”的可观测语义修正：
--   1. host_deferred 是出口闸主动推迟，保留原始观测但不进入图片成功率分母；
--   2. meta.egress_alert 是追加式档位变更审计流，不是待处理工单。当前真实出口异常由
--      meta.egress_control.pressure_level 形成可恢复 episode；我方预算节流不冒充站点故障。
--
-- 本迁移只替换视图/审计登记，不恢复 image_ingest_job 数据。任务恢复必须等依赖本语义的
-- worker 代码上线后执行，避免生产 timer 在滚动窗口中再次把 host_deferred 写回终态。
-- =====================================================================================

\set ON_ERROR_STOP on

DO $guard$
BEGIN
  IF current_database() IN (
    'scpper-cn', 'scpper_cn', 'scpper-syncer', 'scpper_syncer', 'scpper_user'
  ) THEN
    RAISE EXCEPTION '[0063] 拒绝在受保护库 % 上修改待处理语义', current_database()
      USING ERRCODE = '42501';
  END IF;
  IF to_regclass('meta.image_ingest_job') IS NULL
     OR to_regclass('meta.image_ingest_egress_health') IS NULL
     OR to_regclass('meta.pending_collection_current') IS NULL
     OR to_regclass('meta.pending_collection_audit_registry') IS NULL
     OR to_regclass('meta.egress_control') IS NULL
     OR NOT EXISTS (
       SELECT 1
         FROM information_schema.columns
        WHERE table_schema = 'meta' AND table_name = 'egress_control'
          AND column_name = 'pressure_level'
     ) THEN
    RAISE EXCEPTION '[0063] 缺少 0055/0058 pending 与出口状态前置 schema'
      USING ERRCODE = '55000';
  END IF;
END
$guard$;

BEGIN;

SELECT pg_advisory_xact_lock(20260813);

CREATE OR REPLACE VIEW meta.image_ingest_egress_health AS
WITH classes(egress_class) AS (
  VALUES ('wikidot_site'::text), ('external'::text)
), rollup AS (
  SELECT job.egress_class,
         count(*)::bigint AS observation_count,
         count(*) FILTER (
           WHERE job.status = 'processing'
              OR job.failure_class = 'host_deferred'
         )::bigint AS intermediate_count,
         count(*) FILTER (
           WHERE job.failure_class IS DISTINCT FROM 'host_deferred'
             AND (
               job.status = 'completed'
               OR (job.status IN ('pending','failed') AND job.attempts > 0)
             )
         )::bigint AS evaluated_count,
         count(*) FILTER (WHERE job.status = 'completed')::bigint AS success_count,
         count(*) FILTER (
           WHERE job.failure_class IS DISTINCT FROM 'host_deferred'
             AND job.status IN ('pending','failed')
             AND job.attempts > 0
         )::bigint AS failed_count,
         min(job.updated_at) FILTER (
           WHERE job.failure_class IS DISTINCT FROM 'host_deferred'
             AND (
               job.status = 'completed'
               OR (job.status IN ('pending','failed') AND job.attempts > 0)
             )
         ) AS first_evaluated_at,
         max(job.updated_at) AS last_observed_at
    FROM meta.image_ingest_job job
   WHERE job.updated_at >= now() - interval '1 hour'
     AND job.egress_class IS NOT NULL
   GROUP BY job.egress_class
)
SELECT c.egress_class,
       now() - interval '1 hour' AS window_started_at,
       now() AS window_ended_at,
       COALESCE(r.observation_count, 0)::bigint AS observation_count,
       COALESCE(r.intermediate_count, 0)::bigint AS intermediate_count,
       COALESCE(r.evaluated_count, 0)::bigint AS evaluated_count,
       COALESCE(r.success_count, 0)::bigint AS success_count,
       COALESCE(r.failed_count, 0)::bigint AS failed_count,
       CASE WHEN COALESCE(r.evaluated_count, 0) = 0 THEN NULL
            ELSE r.success_count::numeric / r.evaluated_count::numeric END AS success_rate,
       r.first_evaluated_at,
       r.last_observed_at,
       10::bigint AS critical_min_observations,
       CASE
         WHEN COALESCE(r.evaluated_count, 0) >= 10 AND COALESCE(r.success_count, 0) = 0
           THEN 'critical'
         ELSE 'ok'
       END::text AS severity,
       CASE
         WHEN COALESCE(r.observation_count, 0) = 0 THEN 'no_tasks'
         WHEN COALESCE(r.evaluated_count, 0) = 0 THEN 'intermediate_only'
         WHEN COALESCE(r.evaluated_count, 0) >= 10 AND COALESCE(r.success_count, 0) = 0
           THEN 'rolling_zero_success'
         ELSE 'has_success_or_below_sample_threshold'
       END::text AS decision
  FROM classes c
  LEFT JOIN rollup r USING (egress_class);

COMMENT ON VIEW meta.image_ingest_egress_health IS
  '图片 worker 最近 1h 分链路成功率；processing 与 host_deferred 是未测量中间态，'
  '不进入成功率分母；wikidot_site 与 external 完全分账。';

UPDATE meta.pending_collection_audit_registry
   SET classification = 'not_pending',
       collection_families = '{}',
       rationale = '追加式出口档位变更审计流；当前异常由 egress_control pressure episode 表达'
 WHERE schema_name = 'meta' AND relation_name = 'egress_alert';

DO $view$
BEGIN
  IF to_regclass('meta.pending_collection_current_pre0063') IS NULL THEN
    ALTER VIEW meta.pending_collection_current RENAME TO pending_collection_current_pre0063;
  END IF;
END
$view$;

CREATE OR REPLACE VIEW meta.pending_collection_current AS
SELECT p.collection, p.family, p.pending_count, p.oldest_item_at,
       p.oldest_item_key, p.catchup, p.evidence
  FROM meta.pending_collection_current_pre0063 p
 WHERE p.family NOT IN ('egress_alert', 'egress_control')
UNION ALL
SELECT 'egress_control:' || c.site_key AS collection,
       'egress_control'::text AS family,
       1::bigint AS pending_count,
       c.pressure_changed_at AS oldest_item_at,
       c.site_key AS oldest_item_key,
       false AS catchup,
       jsonb_build_object(
         'pressure_level', c.pressure_level,
         'pressure_reason', c.pressure_reason,
         'pressure_recover_not_before', c.pressure_recover_not_before,
         'rolling_hour_requests', c.rolling_hour_requests,
         'failure_rate', c.last_window_failure_rate,
         'budget_level', c.budget_level,
         'budget_breached', c.budget_breached,
         'budget_is_capacity_protection_not_site_failure', true
       ) AS evidence
  FROM meta.egress_control c
 WHERE c.pressure_level > 0;

COMMENT ON VIEW meta.pending_collection_current IS
  '0063：追加式 egress_alert 不作 pending；只有可恢复的站点 pressure 当前态进入 episode。'
  '预算节流与 host_deferred 等自我保护动作不冒充站点故障。';

DO $grants$
BEGIN
  IF to_regrole('ingestor_role') IS NOT NULL THEN
    GRANT SELECT ON meta.image_ingest_egress_health,
      meta.pending_collection_current TO ingestor_role;
  END IF;
  IF to_regrole('projector_role') IS NOT NULL THEN
    GRANT SELECT ON meta.image_ingest_egress_health,
      meta.pending_collection_current TO projector_role;
  END IF;
END
$grants$;

DO $verify$
BEGIN
  IF EXISTS (
    SELECT 1 FROM meta.pending_collection_current
     WHERE family = 'egress_alert'
  ) THEN
    RAISE EXCEPTION '[0063] 追加式 egress_alert 仍被暴露为 pending';
  END IF;
  IF EXISTS (
    SELECT 1 FROM meta.pending_collection_current
     WHERE family = 'egress_control'
       AND COALESCE((evidence->>'pressure_level')::int, 0) <= 0
  ) THEN
    RAISE EXCEPTION '[0063] 非 pressure 出口控制状态被误报为异常';
  END IF;
END
$verify$;

COMMIT;
