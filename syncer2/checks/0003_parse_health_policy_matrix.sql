-- 解析健康策略矩阵结构断言：防止新增 source/population 后又盲目套用全局策略。
\set ON_ERROR_STOP on
\timing off
\pset pager off

DO $$
DECLARE
  v_bad text[];
  v_enabled int;
  v_ready int;
BEGIN
  IF to_regclass('meta.parse_health_baseline') IS NULL
     OR to_regclass('meta.write_freeze_alert_state') IS NULL THEN
    RAISE EXCEPTION '[health-1] 缺 0022 的基线守卫列或冻结告警视图';
  END IF;

  SELECT array_agg(format('%s/%s/%s/%s',source,mode,population_type,metric) ORDER BY 1)
    INTO v_bad
    FROM meta.parse_health_baseline
   WHERE enabled
     AND (
       min_history_windows < 3
       OR NOT (
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
         (source = 'wikidot_tier2'
          AND mode = 'revision_source_backfill'
          AND population_type = 'revision_source_full'
          AND metric IN (
            'http_status_dist','transport_failure_rate'
          ))
         OR
         (source = 'wikidot_page_identity'
          AND mode = 'resolve_pages'
          AND population_type = 'targeted_queue'
          AND metric IN ('http_status_dist','transport_failure_rate'))
       )
     );
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION '[health-2] enabled 策略超出已审计生产者/总体矩阵:%', v_bad;
  END IF;

  IF (SELECT count(*) FROM meta.write_freeze_alert_state) <>
     (SELECT count(*) FROM meta.write_freeze) THEN
    RAISE EXCEPTION '[health-3] write_freeze_alert_state 未覆盖全部冻结域';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM meta.revision_coverage_metric m
      JOIN meta.write_freeze w
        ON w.domain IN ('all','page','content','revision')
       AND w.frozen_at IS NOT NULL
       AND w.frozen_at < m.window_ended_at
       AND COALESCE(w.released_at, 'infinity'::timestamptz) > m.window_started_at
     WHERE m.is_baseline_init IS FALSE
  ) THEN
    RAISE EXCEPTION '[health-4] 写冻结重叠窗口仍在 L0/L1 rolling 覆盖分母中';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM meta.parse_health_baseline
     WHERE enabled
       AND metric IN ('http_status_dist', 'exit_ip_dist', 'transport_failure_rate')
       AND action <> 'warn'
  ) THEN
    RAISE EXCEPTION
      '[health-5] HTTP/出口拓扑/传输层是全局链路信号，只能告警，不能归因到数据域冻结';
  END IF;

  SELECT count(*)::int,
         count(*) FILTER (
           WHERE sample_count >= min_history_windows AND baseline_value IS NOT NULL
         )::int
    INTO v_enabled, v_ready
    FROM meta.parse_health_baseline
   WHERE enabled;

  RAISE NOTICE
    '[checks/0003] 通过:enabled 策略 % 项，缓存显示 ready % 项；精确分层 N>=3，HTTP/出口拓扑/传输只告警，冻结超时与 L0/L1 级联隔离均通过。',
    v_enabled, v_ready;
END
$$;
