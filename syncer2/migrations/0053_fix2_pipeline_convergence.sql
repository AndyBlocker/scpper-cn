-- =====================================================================================
-- 0053_fix2_pipeline_convergence.sql
-- FIX2：论坛写入成功与 absence 授权分离、同身份修订倒退可收敛、分链路零成功告警。
--
-- 部署顺序硬约束：本迁移必须先于调用 7 参数 apply_forum_batch、写
-- revision_regression_identity_state 或读取 page_scan_kind_health 的代码。
-- =====================================================================================

\set ON_ERROR_STOP on

DO $guard$
BEGIN
  IF current_database() IN ('scpper-cn', 'scpper_cn', 'scpper-syncer', 'scpper_user') THEN
    RAISE EXCEPTION '[0053] 拒绝在受保护库 % 上修改 FIX2 契约', current_database()
      USING ERRCODE = '42501';
  END IF;
  IF to_regclass('meta.page_scan') IS NULL
     OR to_regclass('meta.incremental_page_state') IS NULL
     OR to_regprocedure(
       'ingest.apply_forum_batch(jsonb,jsonb,jsonb,timestamp with time zone,text,bigint)'
     ) IS NULL
     OR to_regclass('meta.pending_collection_current') IS NULL THEN
    RAISE EXCEPTION '[0053] 缺少 0003/0018/0040/0205 前置对象' USING ERRCODE = '55000';
  END IF;
END
$guard$;

BEGIN;

-- -------------------------------------------------------------------------------------
-- 1. 论坛：事实批次写成功与“可以从缺席推断删除”是两个正交结论。
-- -------------------------------------------------------------------------------------
ALTER TABLE meta.page_scan
  ADD COLUMN IF NOT EXISTS forum_completeness text,
  ADD COLUMN IF NOT EXISTS absence_authorized boolean NOT NULL DEFAULT false;

ALTER TABLE meta.page_scan DROP CONSTRAINT IF EXISTS page_scan_forum_completeness_ck;
ALTER TABLE meta.page_scan ADD CONSTRAINT page_scan_forum_completeness_ck CHECK (
  (
    kind = 'forum'
    AND (forum_completeness IS NULL OR forum_completeness IN ('targeted', 'complete'))
  )
  OR (
    kind <> 'forum'
    AND forum_completeness IS NULL
    AND NOT absence_authorized
  )
);

ALTER TABLE meta.page_scan DROP CONSTRAINT IF EXISTS page_scan_absence_authorized_ck;
ALTER TABLE meta.page_scan ADD CONSTRAINT page_scan_absence_authorized_ck CHECK (
  NOT absence_authorized
  OR (
    kind = 'forum'
    AND status = 'ok'
    AND forum_completeness = 'complete'
  )
);

COMMENT ON COLUMN meta.page_scan.forum_completeness IS
  'forum 专用：targeted=定向增量，只证明本批正面事实已应用；complete=调用方声明本批所列 '
  'thread 已完整枚举。NULL 是 0053 前历史证据或非 forum kind。';
COMMENT ON COLUMN meta.page_scan.absence_authorized IS
  'forum absence 的显式授权位。只有 status=ok 且 forum_completeness=complete 才允许 true；'
  '定向增量即使写入成功也恒为 false。其它 kind 继续使用各自既有完整性门禁。';
COMMENT ON TABLE meta.page_scan IS
  '页级扫描证据。扫描失败与空结果可区分；forum 从 0053 起必须额外检查 '
  'absence_authorized，不能再把 status=ok 单独解释为缺席推断授权。';

-- 6 参数函数继续服务旧回填器并保持保守 partial。在线代码改用本 7 参数重载：
-- p_complete_thread_ids 是逐 thread 的完整枚举声明；未列出的 thread 是 targeted。
CREATE OR REPLACE FUNCTION ingest.apply_forum_batch(
  p_categories          jsonb,
  p_threads             jsonb,
  p_posts               jsonb,
  p_observed            timestamptz,
  p_source              text,
  p_run                 bigint,
  p_complete_thread_ids jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_result              jsonb;
  v_run                 bigint := p_run;
  v_quarantined         int := 0;
  v_evidence_pages      int := 0;
  v_authorized_pages    int := 0;
  v_duplicate_complete  bigint;
  v_unknown_complete    bigint;
BEGIN
  IF p_complete_thread_ids IS NULL
     OR jsonb_typeof(p_complete_thread_ids) <> 'array' THEN
    RAISE EXCEPTION 'apply_forum_batch: p_complete_thread_ids 必须是 jsonb array'
      USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(p_complete_thread_ids) AS e(v)
     WHERE jsonb_typeof(v) <> 'number'
        OR (v #>> '{}') !~ '^[1-9][0-9]*$'
  ) THEN
    RAISE EXCEPTION 'apply_forum_batch: complete thread id 必须为正整数'
      USING ERRCODE = '22023';
  END IF;

  SELECT count(*) - count(DISTINCT (v #>> '{}')::bigint)
    INTO v_duplicate_complete
    FROM jsonb_array_elements(p_complete_thread_ids) AS e(v);
  IF v_duplicate_complete > 0 THEN
    RAISE EXCEPTION 'apply_forum_batch: p_complete_thread_ids 含重复 id'
      USING ERRCODE = '22023';
  END IF;

  SELECT count(*) INTO v_unknown_complete
    FROM jsonb_array_elements(p_complete_thread_ids) AS e(v)
   WHERE NOT EXISTS (
     SELECT 1
       FROM jsonb_array_elements(COALESCE(p_threads, '[]'::jsonb)) AS t(r)
      WHERE NULLIF(r ->> 'id', '')::bigint = (v #>> '{}')::bigint
   );
  IF v_unknown_complete > 0 THEN
    RAISE EXCEPTION 'apply_forum_batch: 完整性声明含不在本批 threads 中的 id'
      USING ERRCODE = '22023';
  END IF;

  -- 本重载自身也接 R10；随后 6 参数实现会再次断言，双重只读检查无副作用。
  PERFORM meta.assert_writes_allowed('forum');
  v_result := ingest.apply_forum_batch(
    p_categories, p_threads, p_posts, p_observed, p_source, p_run
  );
  v_quarantined := COALESCE((v_result ->> 'quarantined')::int, 0);

  -- 6 参数 core 为 touched page 先写保守 partial。本层拿到显式 thread 范围后，
  -- 把“事实应用成功”改成 ok，并单独保存 absence 授权；二者不再共用 status 一个位。
  IF v_run IS NULL THEN
    v_run := NULLIF(current_setting('scpper.synthetic_run_id', true), '')::bigint;
  END IF;
  WITH complete_ids AS (
    SELECT (v #>> '{}')::bigint AS thread_id
      FROM jsonb_array_elements(p_complete_thread_ids) AS e(v)
  ), payload_threads AS (
    SELECT DISTINCT (r ->> 'id')::bigint AS thread_id
      FROM jsonb_array_elements(COALESCE(p_threads, '[]'::jsonb)) AS e(r)
     WHERE NULLIF(r ->> 'id', '') IS NOT NULL
  ), touched AS (
    SELECT ft.page_id,
           bool_and(ci.thread_id IS NOT NULL) AS all_touched_threads_complete
      FROM payload_threads pt
      JOIN ingest.forum_thread ft ON ft.id = pt.thread_id
      LEFT JOIN complete_ids ci ON ci.thread_id = pt.thread_id
     WHERE ft.page_id IS NOT NULL
     GROUP BY ft.page_id
  ), updated AS (
    UPDATE meta.page_scan ps
       SET status = CASE WHEN v_quarantined = 0 THEN 'ok' ELSE 'partial' END,
           forum_completeness = CASE
             WHEN t.all_touched_threads_complete THEN 'complete' ELSE 'targeted'
           END,
           absence_authorized = (
             v_quarantined = 0 AND t.all_touched_threads_complete
           ),
           error = CASE
             WHEN v_quarantined > 0 THEN
               format('forum 批次有 %s 条隔离事实；不授权 absence 推断', v_quarantined)
             WHEN t.all_touched_threads_complete THEN NULL
             ELSE 'targeted_incremental:正面事实写入成功；未声明完整枚举，不授权 absence 推断'
           END,
           scanned_at = now()
      FROM touched t
     WHERE ps.run_id = v_run
       AND ps.page_id = t.page_id
       AND ps.kind = 'forum'
    RETURNING ps.absence_authorized
  )
  SELECT count(*)::int,
         count(*) FILTER (WHERE absence_authorized)::int
    INTO v_evidence_pages, v_authorized_pages
    FROM updated;

  RETURN v_result || jsonb_build_object(
    'forum_evidence_pages', v_evidence_pages,
    'absence_authorized_pages', v_authorized_pages,
    'complete_thread_ids', jsonb_array_length(p_complete_thread_ids)
  );
END;
$$;

COMMENT ON FUNCTION ingest.apply_forum_batch(
  jsonb, jsonb, jsonb, timestamptz, text, bigint, jsonb
) IS
  '0053 在线论坛入口。p_complete_thread_ids 逐 thread 声明完整枚举；targeted 与 complete '
  '都可形成 status=ok 的写入成功证据，但只有 complete 同时设置 absence_authorized=true。';

REVOKE ALL ON FUNCTION ingest.apply_forum_batch(
  jsonb, jsonb, jsonb, timestamptz, text, bigint, jsonb
) FROM PUBLIC;

DO $forum_grants$
DECLARE v_role text;
BEGIN
  FOREACH v_role IN ARRAY ARRAY['ingestor_role', 'migration_role'] LOOP
    IF to_regrole(v_role) IS NOT NULL THEN
      EXECUTE format(
        'GRANT EXECUTE ON FUNCTION ingest.apply_forum_batch'
        '(jsonb,jsonb,jsonb,timestamptz,text,bigint,jsonb) TO %I',
        v_role
      );
    END IF;
  END LOOP;
END
$forum_grants$;

-- -------------------------------------------------------------------------------------
-- 2. 修订倒退：把“等待身份复核”建成显式、可 CAS 收敛的状态，不再只藏在 error 文本里。
-- -------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS meta.revision_regression_identity_state (
  page_id              int         NOT NULL,
  layer                text        NOT NULL,
  slug                 text        NOT NULL,
  expected_wikidot_id  int         NOT NULL,
  previous_revision    int         NOT NULL,
  observed_revision    int         NOT NULL,
  observed_updated_at  timestamptz,
  observed_rating      int,
  observed_rating_votes int,
  run_id               bigint REFERENCES meta.ingest_run(id) ON DELETE SET NULL,
  status               text        NOT NULL DEFAULT 'pending',
  first_seen_at        timestamptz NOT NULL DEFAULT now(),
  last_seen_at         timestamptz NOT NULL DEFAULT now(),
  resolved_at          timestamptz,
  resolution           text,
  PRIMARY KEY (page_id, layer),
  CONSTRAINT rris_layer_ck CHECK (layer IN ('L0', 'L1')),
  CONSTRAINT rris_identity_ck CHECK (expected_wikidot_id > 0 AND btrim(slug) <> ''),
  CONSTRAINT rris_revision_ck CHECK (
    observed_revision >= 0 AND previous_revision > observed_revision
  ),
  CONSTRAINT rris_status_ck CHECK (
    status IN ('pending', 'accepted_same_identity', 'slug_reused', 'deleted')
  ),
  CONSTRAINT rris_resolution_ck CHECK (
    (status = 'pending' AND resolved_at IS NULL AND resolution IS NULL)
    OR (status <> 'pending' AND resolved_at IS NOT NULL AND btrim(resolution) <> '')
  )
);

CREATE INDEX IF NOT EXISTS rris_pending_age
  ON meta.revision_regression_identity_state(first_seen_at, page_id, layer)
  WHERE status = 'pending';

COMMENT ON TABLE meta.revision_regression_identity_state IS
  'ListPages 修订号倒退的显式身份复核状态。同 wikidotId 可 CAS 接受较低新水位并派生完整修订抓取；'
  'wikidotId 改变/slug 消失仍走既有 lineage/删除流程。';

-- -------------------------------------------------------------------------------------
-- 3. 最近一小时逐 kind 成功率。0 次扫描明确是 ok/no_tasks，不与“有任务但全失败”混淆。
-- -------------------------------------------------------------------------------------
CREATE OR REPLACE VIEW meta.page_scan_kind_health AS
WITH kinds(kind) AS (
  VALUES ('meta'::text), ('votes'), ('revisions'), ('content'), ('attributions'),
         ('forum'), ('discussion'), ('files'), ('revision_source')
), rollup AS (
  SELECT ps.kind,
         count(*)::bigint AS scan_count,
         count(*) FILTER (WHERE ps.status = 'ok')::bigint AS success_count,
         count(*) FILTER (WHERE ps.status = 'partial')::bigint AS partial_count,
         count(*) FILTER (WHERE ps.status = 'failed')::bigint AS failed_count,
         min(ps.scanned_at) AS first_scan_at,
         max(ps.scanned_at) AS last_scan_at
    FROM meta.page_scan ps
   WHERE ps.scanned_at >= now() - interval '1 hour'
   GROUP BY ps.kind
)
SELECT k.kind,
       now() - interval '1 hour' AS window_started_at,
       now() AS window_ended_at,
       COALESCE(r.scan_count, 0)::bigint AS scan_count,
       COALESCE(r.success_count, 0)::bigint AS success_count,
       COALESCE(r.partial_count, 0)::bigint AS partial_count,
       COALESCE(r.failed_count, 0)::bigint AS failed_count,
       CASE WHEN COALESCE(r.scan_count, 0) = 0 THEN NULL
            ELSE r.success_count::numeric / r.scan_count::numeric END AS success_rate,
       r.first_scan_at,
       r.last_scan_at,
       10::bigint AS critical_min_scans,
       CASE
         WHEN COALESCE(r.scan_count, 0) >= 10 AND COALESCE(r.success_count, 0) = 0
           THEN 'critical'
         ELSE 'ok'
       END::text AS severity,
       CASE
         WHEN COALESCE(r.scan_count, 0) = 0 THEN 'no_tasks'
         WHEN COALESCE(r.scan_count, 0) >= 10 AND COALESCE(r.success_count, 0) = 0
           THEN 'rolling_zero_success'
         ELSE 'has_success_or_below_sample_threshold'
       END::text AS decision
  FROM kinds k
  LEFT JOIN rollup r USING (kind);

COMMENT ON VIEW meta.page_scan_kind_health IS
  '逐 page_scan kind 的最近 1h 成功率；scan_count>=10 且 success_count=0 为 critical。'
  'scan_count=0 显式 decision=no_tasks，不误报没有该类任务的轮次。';

-- 0040/0044/0051/0052 的最终视图先保留为底座；0053 只叠加新集合，避免复制大视图。
DO $pending_view$
BEGIN
  IF to_regclass('meta.pending_collection_current_pre0053') IS NULL THEN
    ALTER VIEW meta.pending_collection_current RENAME TO pending_collection_current_pre0053;
  END IF;
END
$pending_view$;

CREATE OR REPLACE VIEW meta.pending_collection_current AS
SELECT p.collection, p.family, p.pending_count, p.oldest_item_at,
       p.oldest_item_key, p.catchup, p.evidence
  FROM meta.pending_collection_current_pre0053 p
UNION ALL
SELECT 'page_scan_success:' || h.kind AS collection,
       'page_scan_zero_success'::text AS family,
       h.scan_count AS pending_count,
       h.first_scan_at AS oldest_item_at,
       h.kind AS oldest_item_key,
       false AS catchup,
       jsonb_build_object(
         'window', '1 hour',
         'scans', h.scan_count,
         'successes', h.success_count,
         'partial', h.partial_count,
         'failed', h.failed_count,
         'success_rate', h.success_rate,
         'critical_min_scans', h.critical_min_scans,
         'decision', h.decision
       ) AS evidence
  FROM meta.page_scan_kind_health h
 WHERE h.severity = 'critical'
UNION ALL
SELECT 'revision_regression_identity:' || r.layer AS collection,
       'revision_regression_identity'::text AS family,
       count(*)::bigint AS pending_count,
       min(r.first_seen_at) AS oldest_item_at,
       (array_agg(r.page_id::text ORDER BY r.first_seen_at, r.page_id))[1]
         AS oldest_item_key,
       false AS catchup,
       jsonb_build_object(
         'layer', r.layer,
         'oldest_slug', (array_agg(r.slug ORDER BY r.first_seen_at, r.page_id))[1],
         'oldest_previous_revision',
           (array_agg(r.previous_revision ORDER BY r.first_seen_at, r.page_id))[1],
         'oldest_observed_revision',
           (array_agg(r.observed_revision ORDER BY r.first_seen_at, r.page_id))[1]
       ) AS evidence
  FROM meta.revision_regression_identity_state r
 WHERE r.status = 'pending'
 GROUP BY r.layer;

COMMENT ON VIEW meta.pending_collection_current IS
  '0053：既有 oldest-pending 集合 + 分 kind 滚动零成功 + 修订倒退身份复核状态。';

INSERT INTO meta.pending_collection_audit_registry(
  schema_name, relation_name, classification, collection_families, rationale
) VALUES (
  'meta', 'revision_regression_identity_state', 'covered',
  ARRAY['revision_regression_identity'],
  'status=pending 的同身份修订倒退复核；接受/复用/删除后显式终结'
)
ON CONFLICT (schema_name, relation_name) DO UPDATE
  SET classification = EXCLUDED.classification,
      collection_families = EXCLUDED.collection_families,
      rationale = EXCLUDED.rationale;

DO $grants$
BEGIN
  IF to_regrole('ingestor_role') IS NOT NULL THEN
    GRANT SELECT, INSERT, UPDATE ON meta.revision_regression_identity_state TO ingestor_role;
    GRANT SELECT ON meta.page_scan_kind_health,
      meta.pending_collection_current TO ingestor_role;
  END IF;
  IF to_regrole('projector_role') IS NOT NULL THEN
    GRANT SELECT ON meta.revision_regression_identity_state,
      meta.page_scan_kind_health, meta.pending_collection_current TO projector_role;
  END IF;
END
$grants$;

COMMIT;

