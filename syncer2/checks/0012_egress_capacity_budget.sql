-- 已启用 Wikidot 链路稳态 4,657/h +15% 余量 => 5,400/h；同时钉住 0058 双状态。
DO $check$
DECLARE
  c meta.egress_control%ROWTYPE;
BEGIN
  SELECT * INTO c FROM meta.egress_control WHERE site_key='wikidot';
  IF NOT FOUND THEN
    RAISE EXCEPTION '[checks/0012] 缺少 wikidot egress_control 单例';
  END IF;
  IF c.budget_limit < 5400 THEN
    RAISE EXCEPTION
      '[checks/0012] 出口预算不足: configured=%/h, steady=4657/h, headroom=15%%, required=5400/h',
      c.budget_limit;
  END IF;
  IF coalesce((c.policy->>'rolling_budget_requests')::int, 0) < 5400
     OR coalesce((c.policy->>'capacity_steady_requests_per_hour')::int, 0) <> 4657
     OR coalesce((c.policy->>'capacity_headroom_ratio')::numeric, -1) <> 0.15 THEN
    RAISE EXCEPTION '[checks/0012] policy 容量依据与 0058/代码计划漂移: %', c.policy;
  END IF;
  IF c.pressure_level NOT BETWEEN 0 AND 3 OR c.budget_level NOT BETWEEN 0 AND 1 THEN
    RAISE EXCEPTION '[checks/0012] pressure/budget 独立档位非法: %/%',
      c.pressure_level, c.budget_level;
  END IF;
  RAISE NOTICE
    '[checks/0012] 出口容量通过: configured=%/h, steady=4657/h, headroom=15%%, required=5400/h',
    c.budget_limit;
END
$check$;
