-- =====================================================================================
-- 0030_slug_reuse_revision_regression.sql
-- 同 slug 的 revision_count 倒退先按 wikidotId 分流；不同身份原子完成生命周期接力。
-- =====================================================================================

\set ON_ERROR_STOP on

DO $guard$
BEGIN
  IF current_database() IN ('scpper-cn', 'scpper_cn', 'scpper-syncer', 'scpper_user') THEN
    RAISE EXCEPTION
      '[0030] 拒绝在受保护库 % 上写 slug 复用身份流程；目标必须是 scpper-v2',
      current_database()
      USING ERRCODE = '42501';
  END IF;
END
$guard$;

BEGIN;

/**
 * 已知旧 page_id + 同 slug 整页 GET 返回的新 wikidotId：
 *   1. 旧身份落 deleted 事件（已有则幂等）；
 *   2. 新 wikidotId 走 register_page，生成独立 page / created 事件；
 *   3. page_lineage 只落 rule 候选，不折叠事实，允许人工 DELETE 撤销；
 *   4. slug 级增量基线清空并改挂 successor，下一轮为新身份重建基线。
 *
 * 这是正面的身份替换证据，不走“完整全站 absence 才可推断删除”的 R9 路径。
 */
CREATE OR REPLACE FUNCTION ingest.apply_slug_reuse_identity(
  p_predecessor       int,
  p_observed_wikidot  int,
  p_slug              text,
  p_observed          timestamptz DEFAULT now(),
  p_run               bigint DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_predecessor_wikidot int;
  v_predecessor_status  text;
  v_successor           int;
  v_successor_slug      text;
  v_deleted_seq         bigint;
  v_lineage_rows        int := 0;
BEGIN
  IF p_predecessor IS NULL OR p_observed_wikidot IS NULL OR p_observed_wikidot <= 0 THEN
    RAISE EXCEPTION 'apply_slug_reuse_identity: predecessor / observed wikidotId 必填'
      USING ERRCODE = '22004';
  END IF;
  IF p_slug IS NULL OR btrim(p_slug) = '' THEN
    RAISE EXCEPTION 'apply_slug_reuse_identity: slug 必填'
      USING ERRCODE = '22004';
  END IF;

  PERFORM meta.assert_writes_allowed('identity');
  PERFORM meta.assert_writes_allowed('page');
  PERFORM meta.ingest_gate_open();
  PERFORM pg_advisory_xact_lock(meta.lock_class_page(), p_predecessor);

  SELECT p.wikidot_id, pc.status
    INTO v_predecessor_wikidot, v_predecessor_status
    FROM ingest.page p
    JOIN serve.page_current pc ON pc.page_id = p.id
   WHERE p.id = p_predecessor
     AND pc.slug = p_slug
   FOR UPDATE OF pc;
  IF NOT FOUND THEN
    RAISE EXCEPTION
      'apply_slug_reuse_identity: predecessor page_id=% 不存在或当前 slug 不是 %',
      p_predecessor, p_slug
      USING ERRCODE = '23503';
  END IF;
  IF v_predecessor_wikidot = p_observed_wikidot THEN
    RAISE EXCEPTION
      'apply_slug_reuse_identity: wikidotId 未变化（page_id=%, wikidot_id=%）；这是同页倒退异常',
      p_predecessor, p_observed_wikidot
      USING ERRCODE = '22023';
  END IF;

  -- 身份替换是旧页在这个 slug 上已消失的正证据；若旧页此前已 deleted 则不重复事件。
  IF v_predecessor_status <> 'deleted'
     OR NOT EXISTS (
       SELECT 1
         FROM ingest.page_life_event
        WHERE page_id = p_predecessor AND kind = 'deleted'
     )
  THEN
    INSERT INTO ingest.page_life_event(
      page_id, kind, occurred_at, occurred_precision, observed_at, source
    )
    VALUES (
      p_predecessor, 'deleted', p_observed, 'inferred', p_observed,
      'wikidot_identity_slug_reuse'
    )
    RETURNING seq INTO v_deleted_seq;

    UPDATE serve.page_current
       SET status = 'deleted',
           deleted_at = p_observed,
           deleted_at_precision = 'inferred',
           cursor_seq = GREATEST(cursor_seq, v_deleted_seq),
           updated_at = now()
     WHERE page_id = p_predecessor;
  END IF;

  v_successor := ingest.register_page(
    p_wikidot_id => p_observed_wikidot,
    p_slug       => p_slug,
    p_observed   => p_observed,
    p_source     => 'wikidot_identity_slug_reuse',
    p_run        => p_run
  );
  IF v_successor = p_predecessor THEN
    RAISE EXCEPTION 'apply_slug_reuse_identity: successor 与 predecessor 相同'
      USING ERRCODE = '23514';
  END IF;

  SELECT slug INTO v_successor_slug
    FROM ingest.page_slug_history
   WHERE page_id = v_successor AND valid_to IS NULL;
  IF v_successor_slug IS DISTINCT FROM p_slug THEN
    RAISE EXCEPTION
      'apply_slug_reuse_identity: wikidot_id=% 已绑定 page_id=% / slug=%，不能接管 slug=%',
      p_observed_wikidot, v_successor, COALESCE(v_successor_slug, '<null>'), p_slug
      USING ERRCODE = '23505';
  END IF;

  INSERT INTO ingest.page_lineage(
    successor_id, predecessor_id, kind, confidence, decided_by, decided_at
  )
  VALUES (
    v_successor, p_predecessor, 'recreate', 0.5,
    'rule:same-slug-wikidot-id-change', p_observed
  )
  ON CONFLICT (successor_id) DO NOTHING;
  GET DIAGNOSTICS v_lineage_rows = ROW_COUNT;

  UPDATE meta.incremental_page_state
     SET page_id = v_successor,
         last_l0_revision = NULL,
         last_l0_updated_at = NULL,
         last_l0_seen_at = NULL,
         last_l1_revision = NULL,
         last_l1_rating = NULL,
         last_l1_rating_votes = NULL,
         last_l1_seen_at = NULL,
         last_l1_run_id = NULL,
         updated_at = now()
   WHERE slug = p_slug;

  PERFORM meta.ingest_gate_close();
  RETURN jsonb_build_object(
    'predecessor_id', p_predecessor,
    'predecessor_wikidot_id', v_predecessor_wikidot,
    'successor_id', v_successor,
    'successor_wikidot_id', p_observed_wikidot,
    'slug', p_slug,
    'deleted_event_seq', v_deleted_seq,
    'lineage_candidate_inserted', v_lineage_rows > 0
  );
END;
$$;

COMMENT ON FUNCTION ingest.apply_slug_reuse_identity(int, int, text, timestamptz, bigint) IS
  '同 slug 整页身份由旧 wikidotId 变为新 wikidotId 时的原子接力：旧页 deleted、新页 '
  'register_page、page_lineage rule 候选、增量状态改挂并清基线。候选不合并事实，可人工撤销。';

REVOKE ALL ON FUNCTION
  ingest.apply_slug_reuse_identity(int, int, text, timestamptz, bigint)
FROM PUBLIC;

DO $grant$
BEGIN
  IF to_regrole('ingestor_role') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION
      ingest.apply_slug_reuse_identity(int, int, text, timestamptz, bigint)
    TO ingestor_role;
  END IF;
  IF to_regrole('migration_role') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION
      ingest.apply_slug_reuse_identity(int, int, text, timestamptz, bigint)
    TO migration_role;
  END IF;
END
$grant$;

COMMIT;
