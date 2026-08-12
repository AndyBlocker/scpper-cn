-- 门内五组配额必须完整、总和等于全站 5,400/h，且 L1 预留足以承载 145/5min。
DO $check$
DECLARE
  v_groups int;
  v_sum int;
  v_budget int;
  v_l1 int;
BEGIN
  SELECT count(*)::int, sum(quota_requests_per_hour)::int,
         max(quota_requests_per_hour) FILTER (WHERE channel_group = 'l1')
    INTO v_groups, v_sum, v_l1
    FROM meta.egress_channel_control
   WHERE site_key = 'wikidot';

  SELECT budget_limit INTO v_budget
    FROM meta.egress_control
   WHERE site_key = 'wikidot';

  IF v_groups <> 5 OR v_sum <> 5400 OR v_sum <> v_budget OR v_l1 < 145 * 12 THEN
    RAISE EXCEPTION '出口通道配额非法: groups=%, sum=%, budget=%, l1=%',
      v_groups, v_sum, v_budget, v_l1
      USING ERRCODE = '23514';
  END IF;
END
$check$;

