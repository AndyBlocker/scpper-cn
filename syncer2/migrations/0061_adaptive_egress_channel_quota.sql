-- =====================================================================================
-- 0061_adaptive_egress_channel_quota.sql
--
-- Wikidot 5,400 attempts/h 不再只是一条全站总账：门内显式分成五个通道组，单独保存
-- next_permit_at。L1 预留 2,100/h（145 attempts/5min 的 20.7% attempt 余量）；其余
-- 3,300/h 分配给 forum/work-queue/image/background。CLI 固定 sleep 必须在本迁移后移除。
-- =====================================================================================

\set ON_ERROR_STOP on

DO $guard$
BEGIN
  IF current_database() IN (
    'scpper-cn', 'scpper_cn', 'scpper-syncer', 'scpper_syncer', 'scpper_user'
  ) THEN
    RAISE EXCEPTION '[0061] 拒绝在受保护库 % 上修改出口通道配额', current_database()
      USING ERRCODE = '42501';
  END IF;
  IF to_regclass('meta.egress_control') IS NULL
     OR to_regclass('meta.egress_request_bucket') IS NULL THEN
    RAISE EXCEPTION '[0061] 缺少 Wikidot 自适应出口前置 schema'
      USING ERRCODE = '55000';
  END IF;
END
$guard$;

BEGIN;

SELECT pg_advisory_xact_lock(20260805);

CREATE TABLE IF NOT EXISTS meta.egress_channel_control (
  site_key                text NOT NULL
                          REFERENCES meta.egress_control(site_key) ON DELETE CASCADE,
  channel_group           text NOT NULL,
  quota_requests_per_hour int NOT NULL,
  next_permit_at          timestamptz NOT NULL DEFAULT now(),
  priority                smallint NOT NULL DEFAULT 0,
  policy                  jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at              timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (site_key, channel_group),
  CONSTRAINT egress_channel_group_ck CHECK (
    channel_group IN ('l1','forum','work-queue','image','background')
  ),
  CONSTRAINT egress_channel_quota_ck CHECK (quota_requests_per_hour > 0),
  CONSTRAINT egress_channel_priority_ck CHECK (priority BETWEEN 0 AND 100)
);

INSERT INTO meta.pending_collection_audit_registry(
  schema_name, relation_name, classification, collection_families, rationale
) VALUES (
  'meta', 'egress_channel_control', 'not_pending', '{}',
  '出口通道配额与 permit 当前态配置；不是待消费集合'
)
ON CONFLICT (schema_name, relation_name) DO UPDATE
SET classification = EXCLUDED.classification,
    collection_families = EXCLUDED.collection_families,
    rationale = EXCLUDED.rationale;

INSERT INTO meta.egress_channel_control(
  site_key, channel_group, quota_requests_per_hour, next_permit_at, priority, policy
)
VALUES
  ('wikidot', 'l1',         2100, now(), 100,
   '{"role":"reserved_l1_freshness","basis":"145 attempts per 5m plus 20.7% retry headroom"}'),
  ('wikidot', 'forum',       900, now(),  60,
   '{"role":"forum_discovery_and_backlog","basis":"remaining site budget"}'),
  ('wikidot', 'work-queue', 1300, now(),  50,
   '{"role":"general_scan_queue","basis":"7-day active-hour p95 1282 rounded up"}'),
  ('wikidot', 'image',       300, now(),  30,
   '{"role":"wikidot_host_images","basis":"remaining site budget; external hosts use separate gate"}'),
  ('wikidot', 'background',  800, now(),  10,
   '{"role":"l0_sitemap_resolve_revision_backfill_and_manual","basis":"remaining site budget"}')
ON CONFLICT (site_key, channel_group) DO UPDATE
SET quota_requests_per_hour = EXCLUDED.quota_requests_per_hour,
    next_permit_at = LEAST(meta.egress_channel_control.next_permit_at, now()),
    priority = EXCLUDED.priority,
    policy = EXCLUDED.policy,
    updated_at = now();

UPDATE meta.egress_control
   SET policy = policy || jsonb_build_object(
         'channel_quota_version', 1,
         'channel_quota_total', 5400,
         'l1_reserved_requests_per_hour', 2100,
         'channel_quota_authority', 'meta.egress_channel_control'
       ),
       updated_at = now()
 WHERE site_key = 'wikidot';

DO $sum$
DECLARE
  v_sum int;
  v_budget int;
BEGIN
  SELECT sum(quota_requests_per_hour)::int
    INTO v_sum
    FROM meta.egress_channel_control
   WHERE site_key = 'wikidot';
  SELECT budget_limit INTO v_budget
    FROM meta.egress_control
   WHERE site_key = 'wikidot';
  IF v_sum <> v_budget OR v_sum <> 5400 THEN
    RAISE EXCEPTION '[0061] 通道配额 %/h 与全站预算 %/h 不相等', v_sum, v_budget
      USING ERRCODE = '23514';
  END IF;
END
$sum$;

COMMENT ON TABLE meta.egress_channel_control IS
  'Wikidot 门内通道配额与每组下一 permit；所有 CLI 只声明 channel，不得另设固定请求间隔。';
COMMENT ON COLUMN meta.egress_channel_control.quota_requests_per_hour IS
  '通道组硬配额；五组总和必须等于 meta.egress_control.budget_limit=5400/h。';
COMMENT ON COLUMN meta.egress_channel_control.next_permit_at IS
  '同组下一次可预留时刻；门先等待本组到期再抢全站 permit，避免慢组阻塞 L1。';

DO $grants$
BEGIN
  IF to_regrole('ingestor_role') IS NOT NULL THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON meta.egress_channel_control TO ingestor_role;
  END IF;
END
$grants$;

COMMIT;
