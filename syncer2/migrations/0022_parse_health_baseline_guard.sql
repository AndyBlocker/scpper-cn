-- =====================================================================================
-- 0022_parse_health_baseline_guard.sql
-- 第五类解析健康误报收口：
--   1. 所有阈值必须先有 N 个同 (source,mode,population_type) 合格历史窗口；
--   2. 退役隐式/探针/非生产者策略，避免“有策略行”伪装成“有指标覆盖”；
--   3. 冻结超过可配置时长后，在库内视图显式呈现 overdue（不做任何消息推送）。
-- =====================================================================================

\set ON_ERROR_STOP on

DO $guard$
BEGIN
  IF current_database() IN ('scpper-cn', 'scpper_cn', 'scpper-syncer', 'scpper_user') THEN
    RAISE EXCEPTION
      '[0022] 拒绝在受保护库 % 上修改解析健康/冻结状态；目标必须是 scpper-v2',
      current_database()
      USING ERRCODE = '42501';
  END IF;
END
$guard$;

BEGIN;

ALTER TABLE meta.parse_health_baseline
  ADD COLUMN IF NOT EXISTS min_history_windows integer NOT NULL DEFAULT 3;

ALTER TABLE meta.parse_health_baseline
  DROP CONSTRAINT IF EXISTS phb_min_history_windows_ck;
ALTER TABLE meta.parse_health_baseline
  ADD CONSTRAINT phb_min_history_windows_ck
  CHECK (min_history_windows >= 3 AND min_history_windows <= 1000);

-- unspecified 是旧代码在 early-health 时没有传分层留下的污染行；probe、回填和没有对应
-- 生产者的指标也只应留在 ingest_run.parse_fingerprint，不应拥有可执行 gate。
UPDATE meta.parse_health_baseline
   SET enabled = false,
       computed_at = now()
 WHERE enabled
   AND NOT (
     (source = 'wikidot'
      AND mode = 'tier1'
      AND population_type IN ('full_scan','l3_full_site_tier1')
      AND metric IN (
        'http_status_dist','exit_ip_dist','transport_failure_rate',
        'parse_drop_rate','selector_empty_rate'
      ))
     OR
     (source = 'wikidot_listpages'
      AND mode = 'l1_votes'
      AND population_type = 'l1_full_site_minimal'
      AND metric IN (
        'http_status_dist','exit_ip_dist','transport_failure_rate','parse_drop_rate'
      ))
     OR
     (source = 'wikidot_sitemap'
      AND (
        (mode = 'full' AND population_type IN ('full_scan','l2_sitemap_absence'))
        OR (mode = 'threads' AND population_type = 'forum_scoped_scan')
      )
      AND metric = 'parse_drop_rate')
     OR
     (source = 'wikidot_forum'
      AND mode = 'forum'
      AND population_type = 'targeted_queue'
      AND metric IN ('http_status_dist','exit_ip_dist','transport_failure_rate'))
     OR
     (source = 'wikidot_tier2'
      AND (
        (mode = 'tier2' AND population_type = 'targeted_queue')
        OR (mode = 'tier2_replay' AND population_type = 'acceptance_replay')
      )
      AND metric IN (
        'http_status_dist','exit_ip_dist','transport_failure_rate',
        'fetched_claimed_ratio','checksum_ok_rate'
      ))
     OR
     (source = 'wikidot_page_identity'
      AND mode = 'resolve_pages'
      AND population_type = 'targeted_queue'
      AND metric IN ('http_status_dist','transport_failure_rate'))
   );

COMMENT ON COLUMN meta.parse_health_baseline.min_history_windows IS
  '同(source,mode,population_type,metric)至少需要多少个历史合格窗口才可判定；'
  '绝对上下界和相对阈值一视同仁。少于此数时只记录指纹，不产生 breach/warn/freeze。';

ALTER TABLE meta.write_freeze
  ADD COLUMN IF NOT EXISTS alert_after interval NOT NULL DEFAULT interval '30 minutes';

ALTER TABLE meta.write_freeze
  DROP CONSTRAINT IF EXISTS write_freeze_alert_after_ck;
ALTER TABLE meta.write_freeze
  ADD CONSTRAINT write_freeze_alert_after_ck
  CHECK (alert_after >= interval '1 minute' AND alert_after <= interval '7 days');

COMMENT ON COLUMN meta.write_freeze.alert_after IS
  '冻结持续多久后在 meta.write_freeze_alert_state 中标为 overdue；纯库内可见性，不触发消息推送。';

COMMENT ON COLUMN meta.write_freeze.domain IS
  '写入域。all 是人工/多域相关故障总闸；单来源单指标的自动解析健康熔断必须使用具体影响域，'
  '不得用 all 停掉无关写入。';

COMMENT ON FUNCTION meta.freeze_writes(text, text, text, text, bigint) IS
  '冻结某写入域。解析健康自动调用按生产者影响域传具体 p_domain；all 仅供人工或另行实现的'
  '多域相关性判据。p_reason 必填，重复冻结不累加 freeze_count。';

CREATE OR REPLACE VIEW meta.write_freeze_alert_state AS
WITH all_gate AS (
  SELECT frozen, frozen_at, reason, frozen_by, breach_metric, breach_run, alert_after
    FROM meta.write_freeze
   WHERE domain = 'all'
),
effective AS (
  SELECT w.domain,
         w.frozen AS direct_frozen,
         (w.frozen OR (w.domain <> 'all' AND a.frozen)) AS effective_frozen,
         CASE
           WHEN w.frozen THEN w.frozen_at
           WHEN w.domain <> 'all' AND a.frozen THEN a.frozen_at
           ELSE NULL
         END AS effective_frozen_at,
         CASE
           WHEN w.frozen THEN w.alert_after
           WHEN w.domain <> 'all' AND a.frozen THEN a.alert_after
           ELSE w.alert_after
         END AS effective_alert_after,
         CASE
           WHEN w.frozen THEN w.reason
           WHEN w.domain <> 'all' AND a.frozen THEN a.reason
           ELSE w.reason
         END AS reason,
         CASE
           WHEN w.frozen THEN w.frozen_by
           WHEN w.domain <> 'all' AND a.frozen THEN a.frozen_by
           ELSE w.frozen_by
         END AS frozen_by,
         CASE
           WHEN w.frozen THEN w.breach_metric
           WHEN w.domain <> 'all' AND a.frozen THEN a.breach_metric
           ELSE w.breach_metric
         END AS breach_metric,
         CASE
           WHEN w.frozen THEN w.breach_run
           WHEN w.domain <> 'all' AND a.frozen THEN a.breach_run
           ELSE w.breach_run
         END AS breach_run,
         w.freeze_count,
         w.released_at,
         w.released_by
    FROM meta.write_freeze w
   CROSS JOIN all_gate a
)
SELECT domain,
       direct_frozen,
       effective_frozen,
       effective_frozen_at,
       CASE
         WHEN effective_frozen_at IS NULL THEN interval '0'
         ELSE clock_timestamp() - effective_frozen_at
       END AS frozen_for,
       effective_alert_after AS alert_after,
       effective_frozen_at + effective_alert_after AS alert_due_at,
       (effective_frozen
        AND clock_timestamp() - effective_frozen_at >= effective_alert_after) AS overdue,
       CASE
         WHEN NOT effective_frozen THEN 'clear'
         WHEN clock_timestamp() - effective_frozen_at >= effective_alert_after THEN 'overdue'
         ELSE 'active'
       END AS alert_state,
       reason,
       frozen_by,
       breach_metric,
       breach_run,
       freeze_count,
       released_at,
       released_by
  FROM effective
 ORDER BY (domain = 'all') DESC, domain;

COMMENT ON VIEW meta.write_freeze_alert_state IS
  '写入冻结的库内告警状态。active=未超时，overdue=持续超过各域 alert_after，'
  'clear=未冻结；已计算 all 总闸对具体域的传导。不发送任何消息。';

DO $grants$
BEGIN
  IF to_regrole('ingestor_role') IS NOT NULL THEN
    GRANT SELECT ON meta.write_freeze_alert_state TO ingestor_role;
  END IF;
  IF to_regrole('projector_role') IS NOT NULL THEN
    GRANT SELECT ON meta.write_freeze_alert_state TO projector_role;
  END IF;
END
$grants$;

-- 写入冻结期间，L0 仍能留下 meta 发现证据，但派生的 page/content/revision 事实不能落地。
-- L1 在这种窗口看到的 miss 是冻结级联，不是采集漏抓：保留当轮明细用于审计，但从 rolling
-- 与告警分母中排除。释放后的首个跨界窗口也必须排除，不能只检查“当前是否 frozen”。
WITH overlapped AS (
  SELECT m.l1_run_id,
         array_agg(DISTINCT w.domain ORDER BY w.domain) AS domains
    FROM meta.revision_coverage_metric m
    JOIN meta.write_freeze w
      ON w.domain IN ('all','page','content','revision')
     AND w.frozen_at IS NOT NULL
     AND w.frozen_at < m.window_ended_at
     AND COALESCE(w.released_at, 'infinity'::timestamptz) > m.window_started_at
   WHERE m.is_baseline_init IS FALSE
   GROUP BY m.l1_run_id
)
UPDATE meta.revision_coverage_metric m
   SET is_baseline_init = true,
       baseline_init_reason =
         'write_freeze_overlap:' || array_to_string(overlapped.domains, ',')
  FROM overlapped
 WHERE m.l1_run_id = overlapped.l1_run_id;

-- rolling_* 是审计缓存而不是原始事实；分类修正后立即全量回算，避免要等 7 天才“自愈”。
WITH rolling AS (
  SELECT current.l1_run_id,
         COALESCE(sum(
           CASE WHEN history.is_baseline_init THEN 0 ELSE history.l1_revision_changes END
         ), 0)::int AS changes,
         COALESCE(sum(
           CASE WHEN history.is_baseline_init THEN 0 ELSE history.l0_captured_changes END
         ), 0)::int AS captured
    FROM meta.revision_coverage_metric current
    JOIN meta.revision_coverage_metric history
      ON history.measured_at > current.measured_at - interval '7 days'
     AND history.measured_at <= current.measured_at
   GROUP BY current.l1_run_id
)
UPDATE meta.revision_coverage_metric m
   SET rolling_7d_changes = rolling.changes,
       rolling_7d_captured = rolling.captured,
       rolling_7d_coverage = CASE
         WHEN rolling.changes = 0 THEN NULL
         ELSE rolling.captured::numeric / rolling.changes
       END
  FROM rolling
 WHERE rolling.l1_run_id = m.l1_run_id;

COMMENT ON COLUMN meta.revision_coverage_metric.is_baseline_init IS
  '比较基线早于 L0 启动、L1 间隔超阈值或比较窗口与 all/page/content/revision 写冻结重叠时'
  '为真；保留审计，但不进入 rolling 且不触发告警。';

COMMIT;
