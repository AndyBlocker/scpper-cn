-- =====================================================================================
-- 0028_parse_health_feedback_cascade.sql
-- 修复“冻结 → PGF01 → 失败率恶化 → 二次冻结”的反馈级联：
--   1. 绝对阈值只允许按完整 (source,mode,population_type,metric) 显式配置；
--   2. revision_source_full 的 parse_drop_rate 实为任务结果率（含 no_permission/写入），
--      不具备解析丢行语义，退为 evidence-only；
--   3. 修复 PGF01 给源码回填队列造成的 attempts/consecutive_failures 污染。
-- =====================================================================================

\set ON_ERROR_STOP on

DO $guard$
BEGIN
  IF current_database() IN ('scpper-cn', 'scpper_cn', 'scpper-syncer', 'scpper_user') THEN
    RAISE EXCEPTION
      '[0028] 拒绝在受保护库 % 上修改解析健康策略；目标必须是 scpper-v2',
      current_database()
      USING ERRCODE = '42501';
  END IF;
END
$guard$;

BEGIN;

-- 先清掉旧迁移按 metric 全局复制的绝对红线。后面的白名单逐项恢复真正审计过的组合；
-- 人工新增但未进入白名单的 population 从此只保留相对偏离，不再继承全局值。
UPDATE meta.parse_health_baseline
   SET lower_bound = NULL,
       upper_bound = NULL,
       max_rel_deviation = CASE metric
         WHEN 'http_status_dist'       THEN 1.00
         WHEN 'exit_ip_dist'           THEN 0.75
         WHEN 'transport_failure_rate' THEN 1.00
         WHEN 'parse_drop_rate'        THEN 1.00
         WHEN 'selector_empty_rate'    THEN 0.50
         WHEN 'fetched_claimed_ratio'  THEN 0.02
         WHEN 'checksum_ok_rate'       THEN 0.01
         ELSE max_rel_deviation
       END,
       computed_at = now()
 WHERE enabled;

WITH explicit_thresholds(
  source, mode, population_type, metric, lower_bound, upper_bound
) AS (
  VALUES
    ('wikidot','tier1','full_scan','http_status_dist',NULL::numeric,0.10::numeric),
    ('wikidot','tier1','full_scan','transport_failure_rate',NULL,0.10),
    ('wikidot','tier1','full_scan','parse_drop_rate',NULL,0.005),
    ('wikidot','tier1','full_scan','selector_empty_rate',NULL,0.15),
    ('wikidot','tier1','l3_full_site_tier1','http_status_dist',NULL,0.10),
    ('wikidot','tier1','l3_full_site_tier1','transport_failure_rate',NULL,0.10),
    ('wikidot','tier1','l3_full_site_tier1','parse_drop_rate',NULL,0.005),
    ('wikidot','tier1','l3_full_site_tier1','selector_empty_rate',NULL,0.15),
    ('wikidot_listpages','l1_votes','l1_full_site_minimal','http_status_dist',NULL,0.10),
    ('wikidot_listpages','l1_votes','l1_full_site_minimal','transport_failure_rate',NULL,0.10),
    ('wikidot_listpages','l1_votes','l1_full_site_minimal','parse_drop_rate',NULL,0.005),
    ('wikidot_sitemap','full','full_scan','parse_drop_rate',NULL,0.10),
    ('wikidot_sitemap','full','l2_sitemap_absence','parse_drop_rate',NULL,0.10),
    ('wikidot_sitemap','threads','forum_scoped_scan','parse_drop_rate',NULL,0.10),
    ('wikidot_forum','forum','targeted_queue','http_status_dist',NULL,0.10),
    ('wikidot_forum','forum','targeted_queue','transport_failure_rate',NULL,0.10),
    ('wikidot_tier2','tier2','targeted_queue','http_status_dist',NULL,0.10),
    ('wikidot_tier2','tier2','targeted_queue','transport_failure_rate',NULL,0.10),
    ('wikidot_tier2','tier2','targeted_queue','fetched_claimed_ratio',0.98,1.02),
    ('wikidot_tier2','tier2','targeted_queue','checksum_ok_rate',0.99,NULL),
    ('wikidot_tier2','tier2_replay','acceptance_replay','http_status_dist',NULL,0.10),
    ('wikidot_tier2','tier2_replay','acceptance_replay','transport_failure_rate',NULL,0.10),
    ('wikidot_tier2','tier2_replay','acceptance_replay','fetched_claimed_ratio',0.98,1.02),
    ('wikidot_tier2','tier2_replay','acceptance_replay','checksum_ok_rate',0.99,NULL),
    ('wikidot_page_identity','resolve_pages','targeted_queue','http_status_dist',NULL,0.10),
    ('wikidot_page_identity','resolve_pages','targeted_queue','transport_failure_rate',NULL,0.10),
    ('wikidot_tier2','revision_source_backfill','revision_source_full',
      'http_status_dist',NULL,0.10),
    ('wikidot_tier2','revision_source_backfill','revision_source_full',
      'transport_failure_rate',NULL,0.10)
)
UPDATE meta.parse_health_baseline b
   SET lower_bound = e.lower_bound,
       upper_bound = e.upper_bound,
       computed_at = now()
  FROM explicit_thresholds e
 WHERE b.source = e.source
   AND b.mode = e.mode
   AND b.population_type = e.population_type
   AND b.metric = e.metric
   AND b.enabled;

UPDATE meta.parse_health_baseline
   SET enabled = false,
       computed_at = now()
 WHERE source = 'wikidot_tier2'
   AND mode = 'revision_source_backfill'
   AND population_type = 'revision_source_full'
   AND metric = 'parse_drop_rate'
   AND enabled;

-- PGF01 是我方状态，不应消耗任务重试预算。每条受污染 job 只回退本次冻结造成的一次
-- consecutive failure；历史真实失败若存在仍保留在剩余计数中。
UPDATE meta.revision_source_backfill_job
   SET status = CASE
         WHEN status IN ('retry','irreconcilable') THEN 'pending'
         ELSE status
       END,
       attempts = GREATEST(0, attempts - 1),
       consecutive_failures = GREATEST(0, consecutive_failures - 1),
       not_before = now(),
       locked_by = NULL,
       locked_at = NULL,
       last_error = NULL,
       updated_at = now()
 WHERE last_error LIKE '%写入已冻结:%';

COMMENT ON COLUMN meta.parse_health_baseline.lower_bound IS
  '绝对下界；必须按(source,mode,population_type,metric)显式配置，NULL 表示只用相对偏离。';
COMMENT ON COLUMN meta.parse_health_baseline.upper_bound IS
  '绝对上界；必须按(source,mode,population_type,metric)显式配置，NULL 表示只用相对偏离。';

COMMIT;
