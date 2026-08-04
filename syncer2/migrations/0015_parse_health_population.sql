-- =====================================================================================
-- 0015_parse_health_population.sql
-- R10 首次真实误报修复：population-sensitive 均值退役 + 三维基线分层。
--
-- 事故：run 201 是定向重放的高票页 cohort，avg_votes_per_page=131.333；
--       它被拿去和通用 Tier2 均值 64.3667 比较，误冻 all。
-- 原则：只有与抓取页面构成无关的完整性/传输指标进入默认 gate；基线严格按
--       (source, mode, population_type) 隔离。
-- =====================================================================================

\set ON_ERROR_STOP on

DO $guard$
BEGIN
  IF current_database() IN ('scpper-cn', 'scpper_cn', 'scpper-syncer', 'scpper_user') THEN
    RAISE EXCEPTION
      '[0015] 拒绝在受保护库 % 上修改 R10；目标必须是 scpper-v2',
      current_database()
      USING ERRCODE = '42501';
  END IF;
END
$guard$;

BEGIN;

ALTER TABLE meta.parse_health_baseline
  ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'unspecified',
  ADD COLUMN IF NOT EXISTS population_type text NOT NULL DEFAULT 'unspecified';

ALTER TABLE meta.parse_health_baseline
  DROP CONSTRAINT IF EXISTS parse_health_baseline_pkey;
ALTER TABLE meta.parse_health_baseline
  ADD CONSTRAINT parse_health_baseline_pkey
  PRIMARY KEY (source, mode, population_type, metric);

ALTER TABLE meta.parse_health_baseline
  DROP CONSTRAINT IF EXISTS phb_stratum_nonempty_ck;
ALTER TABLE meta.parse_health_baseline
  ADD CONSTRAINT phb_stratum_nonempty_ck CHECK (
    btrim(source) <> ''
    AND btrim(mode) <> ''
    AND btrim(population_type) <> ''
    AND btrim(metric) <> ''
  );

-- 把历史 run 的第三维写成显式证据。新代码会在每轮 finish 时继续写此键。
UPDATE meta.ingest_run
   SET stats = stats || jsonb_build_object(
     'population_type',
     CASE
       WHEN source LIKE '%:probe' OR COALESCE(stats->>'probeOnly', 'false') = 'true'
         THEN 'probe'
       WHEN stats->>'domain' = 'work_queue'
         THEN 'targeted_queue'
       WHEN stats->>'mode' = 'tier1_range'
            OR COALESCE(stats->>'sampleLimited', 'false') = 'true'
         THEN 'bounded_sample'
       WHEN stats->>'mode' IN ('tier1', 'full')
         THEN 'full_scan'
       WHEN stats->>'mode' = 'delta'
         THEN 'change_slice'
       WHEN stats->>'mode' IN ('category', 'threads')
         THEN 'scoped_scan'
       WHEN stats->>'mode' = 'forum'
         THEN 'targeted_queue'
       ELSE 'unspecified'
     END
   )
 WHERE NOT (stats ? 'population_type');

-- 历史 page_scan 已经保存了独立声明值/抓取值/校验结果；把两项不随票数大小变化的
-- 指标补进历史指纹，事故 run 201 会得到 1.0 / 1.0，而不是靠人工描述证明健康。
WITH per_run AS (
  SELECT run_id,
         avg(
           CASE
             WHEN claimed_total = 0 THEN CASE WHEN fetched_total = 0 THEN 1.0 ELSE 0.0 END
             ELSE fetched_total::numeric / claimed_total
           END
         ) FILTER (
           WHERE kind = 'votes'
             AND claimed_total IS NOT NULL
             AND fetched_total IS NOT NULL
         ) AS fetched_claimed_ratio,
         avg((checksum_ok::int)::numeric) FILTER (
           WHERE kind = 'votes' AND checksum_ok IS NOT NULL
         ) AS checksum_ok_rate
    FROM meta.page_scan
   GROUP BY run_id
)
UPDATE meta.ingest_run r
   SET parse_fingerprint = r.parse_fingerprint || jsonb_build_object(
     'fetched_claimed_ratio', p.fetched_claimed_ratio,
     'checksum_ok_rate', p.checksum_ok_rate
   )
  FROM per_run p
 WHERE p.run_id = r.id;

-- 五项 population-sensitive 指标继续留在 parse_fingerprint 做取证，但不再参与 gate。
-- revision_type_dist 如要恢复，只能在业务定义更细的固定 cohort 内显式配置。
UPDATE meta.parse_health_baseline
   SET enabled = false,
       computed_at = now()
 WHERE metric IN (
   'revision_type_dist',
   'avg_votes_per_page',
   'avg_tags_len',
   'avg_source_len',
   'avg_body_len'
 )
   AND enabled;

-- 为已经出现过的三维 stratum 登记 population-invariant 默认策略。绝对完整性红线
-- 第一轮就生效；相对基线仍按原规则至少积累 3 个成功样本。
WITH strata AS (
  SELECT DISTINCT
         source,
         COALESCE(NULLIF(stats->>'mode', ''), 'unspecified') AS mode,
         COALESCE(NULLIF(stats->>'population_type', ''), 'unspecified') AS population_type
    FROM meta.ingest_run
   WHERE source !~ '^(test|synthetic)(_|:|$)'
),
policies(metric, lower_bound, upper_bound, max_rel_deviation, direction, action) AS (
  VALUES
    ('http_status_dist',       NULL::numeric, 0.10::numeric, NULL::numeric, 'up',   'freeze_write'),
    ('exit_ip_dist',           NULL::numeric, NULL::numeric, 0.75::numeric, 'up',  'freeze_write'),
    ('transport_failure_rate', NULL::numeric, 0.10::numeric, NULL::numeric, 'up',   'freeze_write'),
    ('parse_drop_rate',        NULL::numeric, 0.005::numeric,NULL::numeric, 'up',   'freeze_write'),
    ('selector_empty_rate',    NULL::numeric, 0.15::numeric, NULL::numeric, 'up',   'freeze_write'),
    ('fetched_claimed_ratio',  0.98::numeric, 1.02::numeric, NULL::numeric, 'both', 'freeze_write'),
    ('checksum_ok_rate',       0.99::numeric, NULL::numeric, NULL::numeric, 'down', 'freeze_write')
)
INSERT INTO meta.parse_health_baseline
  (source, mode, population_type, metric, window_days,
   lower_bound, upper_bound, max_rel_deviation, direction, action, enabled)
SELECT s.source,
       s.mode,
       s.population_type,
       p.metric,
       7,
       p.lower_bound,
       CASE
         WHEN s.source = 'wikidot_sitemap' AND p.metric = 'parse_drop_rate' THEN 0.10
         ELSE p.upper_bound
       END,
       p.max_rel_deviation,
       p.direction,
       p.action,
       true
  FROM strata s
 CROSS JOIN policies p
ON CONFLICT (source, mode, population_type, metric) DO NOTHING;

COMMENT ON TABLE meta.parse_health_baseline IS
  'R10 解析健康策略与前 7 日基线。主键按(source,mode,population_type,metric)隔离；'
  '全站扫描、范围样本与定向队列永不共享基线。';
COMMENT ON COLUMN meta.parse_health_baseline.mode IS
  '采集模式分层，例如 tier1/full/tier2/category；不得跨 mode 借用基线。';
COMMENT ON COLUMN meta.parse_health_baseline.population_type IS
  '抓取总体类型，例如 full_scan/bounded_sample/targeted_queue；mode 相同也不得跨总体比较。';
COMMENT ON COLUMN meta.parse_health_baseline.metric IS
  '默认 gate 只启用 population-invariant 指标。avg_votes/source/body/tags 与 revision 分布'
  '仍可留在 ingest_run.parse_fingerprint 取证，但不得作为通用总体的绝对均值熔断。';

COMMIT;
