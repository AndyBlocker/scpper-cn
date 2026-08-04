-- =====================================================================================
-- 0029_parse_health_rare_event_resolution.sql
-- 稀有事件率的相对判定分辨率由应用层统一要求“本轮至少 5 个坏事件”。
-- HTTP/出口拓扑/传输失败属于全局上游链路证据，保留 breach 告警但不再冻结数据写域。
-- =====================================================================================

\set ON_ERROR_STOP on

DO $guard$
BEGIN
  IF current_database() IN ('scpper-cn', 'scpper_cn', 'scpper-syncer', 'scpper_user') THEN
    RAISE EXCEPTION
      '[0029] 拒绝在受保护库 % 上修改解析健康策略；目标必须是 scpper-v2',
      current_database()
      USING ERRCODE = '42501';
  END IF;
END
$guard$;

BEGIN;

UPDATE meta.parse_health_baseline
   SET action = 'warn',
       computed_at = now()
 WHERE metric IN ('http_status_dist', 'exit_ip_dist', 'transport_failure_rate')
   AND action IS DISTINCT FROM 'warn';

COMMENT ON TABLE meta.parse_health_baseline IS
  'R10 解析健康策略与前 7 日基线。相对判定还受指标统计语义约束：稀有事件率本轮至少有 5 个坏事件；HTTP/出口拓扑/传输层只告警不冻结数据域。';

COMMIT;
