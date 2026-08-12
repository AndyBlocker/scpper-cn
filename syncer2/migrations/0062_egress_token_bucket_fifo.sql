-- =====================================================================================
-- 0062_egress_token_bucket_fifo.sql
--
-- 0061 的 quota 数值正确，但 next_permit_at 把小时配额错误实现成逐请求等间隔。本迁移
-- 先惰性扩 schema：每组改存连续补充的令牌桶，并增加两阶段 FIFO（组内等令牌、全局等
-- 礼貌门）。迁移本身不切换运行时代码；TypeScript 只能在本迁移成功后引用这些列/表。
-- =====================================================================================

\set ON_ERROR_STOP on

DO $guard$
BEGIN
  IF current_database() IN (
    'scpper-cn', 'scpper_cn', 'scpper-syncer', 'scpper_syncer', 'scpper_user'
  ) THEN
    RAISE EXCEPTION '[0062] 拒绝在受保护库 % 上修改出口令牌桶', current_database()
      USING ERRCODE = '42501';
  END IF;
  IF to_regclass('meta.egress_channel_control') IS NULL
     OR to_regclass('meta.egress_control') IS NULL THEN
    RAISE EXCEPTION '[0062] 缺少 0061/0037 出口控制前置 schema'
      USING ERRCODE = '55000';
  END IF;
END
$guard$;

BEGIN;

SELECT pg_advisory_xact_lock(20260805);

ALTER TABLE meta.egress_channel_control
  ADD COLUMN IF NOT EXISTS bucket_capacity int,
  ADD COLUMN IF NOT EXISTS available_tokens numeric(20,9),
  ADD COLUMN IF NOT EXISTS tokens_refilled_at timestamptz;

WITH configured(channel_group, bucket_capacity) AS (
  VALUES
    ('l1'::text, 175),       -- 2,100/h / 12：一轮 145 + 30 retry 余量
    ('forum', 75),           -- 900/h / 12：一个 5 分钟 catch-up 窗
    ('work-queue', 109),     -- ceil(1,300/h / 12)
    ('image', 25),           -- 300/h / 12
    ('background', 400)      -- 800/h / 2：容纳半小时一次的 300-request backfill
)
UPDATE meta.egress_channel_control c
   SET bucket_capacity = configured.bucket_capacity,
       available_tokens = configured.bucket_capacity,
       tokens_refilled_at = clock_timestamp(),
       next_permit_at = LEAST(c.next_permit_at, clock_timestamp()),
       policy = c.policy || jsonb_build_object(
         'bucket_capacity', configured.bucket_capacity,
         'refill', 'continuous quota_requests_per_hour',
         'empty_behavior', 'wait for next token; never reject'
       ),
       updated_at = clock_timestamp()
  FROM configured
 WHERE c.site_key = 'wikidot'
   AND c.channel_group = configured.channel_group;

ALTER TABLE meta.egress_channel_control
  ALTER COLUMN bucket_capacity SET NOT NULL,
  ALTER COLUMN available_tokens SET NOT NULL,
  ALTER COLUMN tokens_refilled_at SET NOT NULL,
  DROP CONSTRAINT IF EXISTS egress_channel_bucket_ck;

ALTER TABLE meta.egress_channel_control
  ADD CONSTRAINT egress_channel_bucket_ck CHECK (
    bucket_capacity > 0
    AND available_tokens >= 0
    AND available_tokens <= bucket_capacity
  );

CREATE TABLE IF NOT EXISTS meta.egress_permit_waiter (
  ticket_id       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  waiter_id       uuid NOT NULL UNIQUE,
  site_key        text NOT NULL,
  channel         text NOT NULL,
  channel_group   text NOT NULL,
  enqueued_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
  token_granted_at timestamptz,
  lease_expires_at timestamptz NOT NULL,
  CONSTRAINT egress_permit_waiter_channel_ck CHECK (
    channel ~ '^[A-Za-z0-9][A-Za-z0-9:_-]{0,79}$'
  ),
  CONSTRAINT egress_permit_waiter_lease_ck CHECK (lease_expires_at > enqueued_at),
  CONSTRAINT egress_permit_waiter_channel_fk
    FOREIGN KEY (site_key, channel_group)
    REFERENCES meta.egress_channel_control(site_key, channel_group)
    ON DELETE CASCADE
);

-- 同组 token FIFO：token_granted_at IS NULL 时 ticket_id 决定不可越过的组内次序。
CREATE INDEX IF NOT EXISTS epw_channel_token_head
  ON meta.egress_permit_waiter(site_key, channel_group, ticket_id)
  WHERE token_granted_at IS NULL;

-- 全局礼貌门 FIFO：拿到 token 的时刻优先，完全同时再按 ticket_id。
CREATE INDEX IF NOT EXISTS epw_global_permit_head
  ON meta.egress_permit_waiter(site_key, token_granted_at, ticket_id)
  WHERE token_granted_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS epw_expired_lease
  ON meta.egress_permit_waiter(lease_expires_at);

INSERT INTO meta.pending_collection_audit_registry(
  schema_name, relation_name, classification, collection_families, rationale
) VALUES (
  'meta', 'egress_permit_waiter', 'not_pending', '{}',
  '出口礼貌门短租约 FIFO；进程崩溃后自动过期，不是业务待消费集合'
)
ON CONFLICT (schema_name, relation_name) DO UPDATE
SET classification = EXCLUDED.classification,
    collection_families = EXCLUDED.collection_families,
    rationale = EXCLUDED.rationale;

UPDATE meta.egress_control
   SET policy = policy || jsonb_build_object(
         'channel_quota_version', 2,
         'channel_quota_mechanism', 'continuous_token_bucket',
         'global_permit_order', 'leased_two_stage_fifo',
         'waiter_lease_seconds', 10
       ),
       updated_at = clock_timestamp()
 WHERE site_key = 'wikidot';

COMMENT ON COLUMN meta.egress_channel_control.next_permit_at IS
  '0061 旧逐请求通道时钟；0062 起运行时不得读取或推进，由令牌桶列取代。';
COMMENT ON COLUMN meta.egress_channel_control.bucket_capacity IS
  '允许的通道突发 attempts；补充速率仍严格等于 quota_requests_per_hour。';
COMMENT ON COLUMN meta.egress_channel_control.available_tokens IS
  '惰性连续补充后的可用令牌；每个真实 attempt 在进入全局 FIFO 前消费 1。';
COMMENT ON COLUMN meta.egress_channel_control.tokens_refilled_at IS
  'available_tokens 上次按数据库时钟结算的时刻。';
COMMENT ON TABLE meta.egress_permit_waiter IS
  '两阶段有租约 FIFO：先按 channel_group ticket 等令牌，再按 token_granted_at 等全站礼貌门；新到请求不能越过。';

DO $grants$
BEGIN
  IF to_regrole('ingestor_role') IS NOT NULL THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON meta.egress_permit_waiter TO ingestor_role;
    GRANT USAGE, SELECT ON SEQUENCE meta.egress_permit_waiter_ticket_id_seq TO ingestor_role;
  END IF;
END
$grants$;

DO $invariant$
DECLARE
  v_quota int;
  v_capacity int;
BEGIN
  SELECT sum(quota_requests_per_hour)::int, sum(bucket_capacity)::int
    INTO v_quota, v_capacity
    FROM meta.egress_channel_control
   WHERE site_key='wikidot';
  IF v_quota <> 5400 OR v_capacity <> 784 THEN
    RAISE EXCEPTION '[0062] 令牌桶参数漂移: quota=%/h capacity=%', v_quota, v_capacity
      USING ERRCODE = '23514';
  END IF;
END
$invariant$;

COMMIT;
