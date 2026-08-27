-- =====================================================================================
-- 0210_gate_debts.sql
--
-- 部署门禁首次全量执行（deploy 把 checks/ 全部纳入门禁）当场抓到三笔旧债。
-- 它们能存在这么久，正是因为这些 checks 此前不在任何门里——「写了没接线」的又一例。
--
--   0001: serve.image_asset_url_alias 投影未在 meta.projection_cursor 登记，
--         projection_window() 会对它抛 23503
--   0002: ingest.apply_vote_cas_batch 未接 R10 写冻结熔断——vote 域冻结对它无效
--   0005: 六张新表未做 pending 语义审计（外部图片出口四张 + L1 缺席观察 + 部分覆盖状态）
-- =====================================================================================

BEGIN;

-- 0001：登记投影（与 serve.image_asset 同域同起点）
INSERT INTO meta.projection_cursor(projection, event_domain, last_seq, updated_at, rebuild_from)
SELECT 'serve.image_asset_url_alias',
       (SELECT event_domain FROM meta.projection_cursor WHERE projection='serve.image_asset'),
       0, now(),
       (SELECT rebuild_from FROM meta.projection_cursor WHERE projection='serve.image_asset')
WHERE NOT EXISTS (
  SELECT 1 FROM meta.projection_cursor WHERE projection='serve.image_asset_url_alias');

-- 0005：六张表的 pending 语义审计。全部归 not_pending：
--   external_image_egress_control/global —— 站外主机闸的当前态配置，不是待消费集合
--   external_image_egress_request_bucket —— append-only 出口记账
--   external_image_egress_alert —— 档位变更事件流（同 egress_alert 的先例：
--     事件流按最老实例计龄会永久红，其可观测性由 episode 机制承担）
--   l1_absence_observation —— 缺席证据积累（append-only，由删除确认消费判据读取）
--   l1_partial_vote_state —— 降档期部分覆盖的当前态
INSERT INTO meta.pending_collection_audit_registry(schema_name, relation_name, classification, collection_families, rationale)
VALUES
  ('meta','external_image_egress_control','not_pending','{}','站外主机闸当前态；不是待消费集合'),
  ('meta','external_image_egress_global','not_pending','{}','站外出口全局当前态；不是待消费集合'),
  ('meta','external_image_egress_request_bucket','not_pending','{}','append-only 出口记账；历史证据'),
  ('meta','external_image_egress_alert','not_pending','{}','档位变更事件流；按最老实例计龄会永久红（同 egress_alert 先例）'),
  ('meta','l1_absence_observation','not_pending','{}','缺席证据积累（append-only）；由删除确认判据消费读取'),
  ('meta','l1_partial_vote_state','not_pending','{}','降档期部分覆盖当前态；不是待消费集合')
ON CONFLICT DO NOTHING;

-- 0002：apply_vote_cas_batch 接入写冻结（函数整体重放，仅加一行断言）
CREATE OR REPLACE FUNCTION ingest.apply_vote_cas_batch(p_page integer, p_targets jsonb, p_observed timestamp with time zone, p_source text, p_run bigint DEFAULT NULL::bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE
  r record;
  v_raw int;
  v_uniq int;
  v_events int := 0;
  v_ev bigint;
  v_before record;
  v_after record;
BEGIN
  -- R10 写冻结熔断：vote 域冻结时本函数必须同样停写。
  -- check 0002 曾抓到本函数缺此断言——冻结对它无效，是真实安全缺口。
  PERFORM meta.assert_writes_allowed('vote');
  IF p_targets IS NULL OR jsonb_typeof(p_targets)<>'array' THEN
    RAISE EXCEPTION 'apply_vote_cas_batch: p_targets 必须是 jsonb array'
      USING ERRCODE='22023';
  END IF;
  SELECT count(*)::int,count(DISTINCT r->>'voter_id')::int
    INTO v_raw,v_uniq FROM jsonb_array_elements(p_targets) e(r);
  IF v_raw<>v_uniq THEN
    RAISE EXCEPTION 'apply_vote_cas_batch: 同一 voter 出现多次(% 条/% 个 voter)',v_raw,v_uniq
      USING ERRCODE='22000';
  END IF;
  SELECT rating,vote_up,vote_down,vote_revoked
    INTO v_before FROM serve.page_current WHERE page_id=p_page;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'apply_vote_cas_batch: serve.page_current 缺 page_id=%',p_page
      USING ERRCODE='23503';
  END IF;
  FOR r IN
    SELECT (v->>'voter_id')::int AS voter_id,
           COALESCE((v->>'direction')::int,0) AS direction,
           NULLIF(v->>'occurred_at','')::timestamptz AS occurred_at,
           COALESCE(NULLIF(v->>'precision',''),'observed') AS precision
      FROM jsonb_array_elements(p_targets) e(v)
     ORDER BY (v->>'voter_id')::int
  LOOP
    v_ev := ingest.apply_vote_observation(
      p_page,r.voter_id,r.direction,r.occurred_at,p_observed,
      r.precision,p_source,p_run,NULL
    );
    IF v_ev IS NOT NULL THEN v_events:=v_events+1; END IF;
  END LOOP;
  SELECT rating,vote_up,vote_down,vote_revoked
    INTO v_after FROM serve.page_current WHERE page_id=p_page;
  RETURN jsonb_build_object(
    'events',v_events,'targets',v_raw,
    'rating_delta',v_after.rating-v_before.rating,
    'up_delta',v_after.vote_up-v_before.vote_up,
    'down_delta',v_after.vote_down-v_before.vote_down,
    'revoked_delta',v_after.vote_revoked-v_before.vote_revoked,
    'page_updated',CASE WHEN v_events>0 THEN 1 ELSE 0 END,
    'precision_improved',0
  );
END;
$function$;

COMMIT;
