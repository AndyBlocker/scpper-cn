-- =====================================================================================
-- 0036_identity_failure_recheck.sql
-- page-bound AMC 直接证明旧 pageId 无实体，且同轮 slug GET=404 时的快速删除入口。
-- =====================================================================================

\set ON_ERROR_STOP on

DO $guard$
BEGIN
  IF current_database() IN ('scpper-cn', 'scpper_cn', 'scpper-syncer', 'scpper_user') THEN
    RAISE EXCEPTION
      '[0036] 拒绝在受保护库 % 上写身份缺失删除；目标必须是 scpper-v2',
      current_database()
      USING ERRCODE = '42501';
  END IF;
END
$guard$;

BEGIN;

/**
 * 这不是“单次抓取失败 => 删除”。调用方必须先得到 page-bound AMC 的无实体签名，随后用
 * slug 整页 GET 得到 404；函数本身再锁定并核对当前 page/wikidotId/slug，防止复核期间
 * 身份已经被其它 worker 更新。与 apply_slug_reuse_identity 对称，这类直接身份证据不依赖
 * 全站两轮 absence；后者仍负责没有定向失败信号时的慢速兜底发现。
 */
CREATE OR REPLACE FUNCTION ingest.apply_identity_missing_deletion(
  p_page              int,
  p_expected_wikidot  int,
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
  v_current_wikidot int;
  v_current_slug    text;
  v_status          text;
  v_deleted_seq     bigint;
BEGIN
  IF p_page IS NULL OR p_expected_wikidot IS NULL OR p_expected_wikidot <= 0 THEN
    RAISE EXCEPTION 'apply_identity_missing_deletion: page / expected wikidotId 必填'
      USING ERRCODE = '22004';
  END IF;
  IF p_slug IS NULL OR btrim(p_slug) = '' THEN
    RAISE EXCEPTION 'apply_identity_missing_deletion: slug 必填'
      USING ERRCODE = '22004';
  END IF;

  PERFORM meta.assert_writes_allowed('page');
  PERFORM meta.ingest_gate_open();
  PERFORM pg_advisory_xact_lock(meta.lock_class_page(), p_page);

  SELECT p.wikidot_id, pc.slug, pc.status
    INTO v_current_wikidot, v_current_slug, v_status
    FROM ingest.page p
    JOIN serve.page_current pc ON pc.page_id = p.id
   WHERE p.id = p_page
   FOR UPDATE OF pc;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'apply_identity_missing_deletion: page_id=% 不存在', p_page
      USING ERRCODE = '23503';
  END IF;
  IF v_current_wikidot IS DISTINCT FROM p_expected_wikidot
     OR v_current_slug IS DISTINCT FROM p_slug THEN
    RAISE EXCEPTION
      'apply_identity_missing_deletion: 当前身份已变化（page=%, expected=%/%, current=%/%）',
      p_page, p_expected_wikidot, p_slug, v_current_wikidot, v_current_slug
      USING ERRCODE = '40001';
  END IF;

  IF v_status <> 'deleted'
     OR NOT EXISTS (
       SELECT 1
         FROM ingest.page_life_event
        WHERE page_id = p_page AND kind = 'deleted'
     )
  THEN
    INSERT INTO ingest.page_life_event(
      page_id, kind, occurred_at, occurred_precision, observed_at, source
    )
    VALUES (
      p_page, 'deleted', p_observed, 'inferred', p_observed,
      'wikidot_identity_missing'
    )
    RETURNING seq INTO v_deleted_seq;

    UPDATE serve.page_current
       SET status = 'deleted',
           deleted_at = p_observed,
           deleted_at_precision = 'inferred',
           cursor_seq = GREATEST(cursor_seq, v_deleted_seq),
           updated_at = now()
     WHERE page_id = p_page;
  END IF;

  PERFORM meta.ingest_gate_close();
  RETURN jsonb_build_object(
    'page_id', p_page,
    'wikidot_id', p_expected_wikidot,
    'slug', p_slug,
    'deleted_event_seq', v_deleted_seq,
    'confirmation_run_id', p_run
  );
END;
$$;

COMMENT ON FUNCTION ingest.apply_identity_missing_deletion(int, int, text, timestamptz, bigint) IS
  'page-bound AMC 无实体 + 同轮 slug GET 404 的直接删除：再次核对当前身份后落 deleted；'
  '不把单次传输/503/有正文 500 当成授权。';

REVOKE ALL ON FUNCTION
  ingest.apply_identity_missing_deletion(int, int, text, timestamptz, bigint)
FROM PUBLIC;

DO $grant$
BEGIN
  IF to_regrole('ingestor_role') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION
      ingest.apply_identity_missing_deletion(int, int, text, timestamptz, bigint)
    TO ingestor_role;
  END IF;
  IF to_regrole('migration_role') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION
      ingest.apply_identity_missing_deletion(int, int, text, timestamptz, bigint)
    TO migration_role;
  END IF;
END
$grant$;

COMMIT;
