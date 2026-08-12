DO $check$
DECLARE
  v_quota int;
  v_capacity int;
BEGIN
  SELECT sum(quota_requests_per_hour)::int, sum(bucket_capacity)::int
    INTO v_quota, v_capacity
    FROM meta.egress_channel_control
   WHERE site_key='wikidot';
  IF v_quota <> 5400 OR v_capacity <> 784 THEN
    RAISE EXCEPTION '[checks/0014] 出口令牌桶漂移: quota=%/h capacity=%',
      v_quota, v_capacity;
  END IF;
  IF EXISTS (
    SELECT 1 FROM meta.egress_channel_control
     WHERE site_key='wikidot'
       AND (available_tokens < 0 OR available_tokens > bucket_capacity)
  ) THEN
    RAISE EXCEPTION '[checks/0014] 出口令牌数越界';
  END IF;
  IF coalesce((SELECT policy->>'channel_quota_version'
                 FROM meta.egress_control WHERE site_key='wikidot'), '') <> '2' THEN
    RAISE EXCEPTION '[checks/0014] 出口令牌桶 policy version 不是 2';
  END IF;
END
$check$;
