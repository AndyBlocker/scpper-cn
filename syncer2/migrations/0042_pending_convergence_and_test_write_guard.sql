-- =====================================================================================
-- 0042_pending_convergence_and_test_write_guard.sql
-- pending_page 可调度状态机、受限分类冷启动证据收口、合成身份写入门与污染清理。
-- =====================================================================================

\set ON_ERROR_STOP on

DO $guard$
BEGIN
  IF current_database() IN ('scpper-cn', 'scpper_cn', 'scpper-syncer', 'scpper_user') THEN
    RAISE EXCEPTION '[0042] 拒绝在受保护库 % 上修改 v2 状态机', current_database()
      USING ERRCODE = '42501';
  END IF;
END
$guard$;

BEGIN;

-- -------------------------------------------------------------------------------------
-- 1. pending_page：把“待执行”“等待外部证据”“低频复查”与真正终态拆开。
-- -------------------------------------------------------------------------------------
ALTER TABLE meta.pending_page
  ADD COLUMN IF NOT EXISTS state_changed_at timestamptz,
  ADD COLUMN IF NOT EXISTS finished_at timestamptz,
  ADD COLUMN IF NOT EXISTS resolution_source text,
  ADD COLUMN IF NOT EXISTS resolution_evidence jsonb NOT NULL DEFAULT '{}'::jsonb;

UPDATE meta.pending_page
   SET state_changed_at = COALESCE(resolved_at, locked_at, first_seen_at, now())
 WHERE state_changed_at IS NULL;

ALTER TABLE meta.pending_page
  ALTER COLUMN state_changed_at SET DEFAULT now(),
  ALTER COLUMN state_changed_at SET NOT NULL;

ALTER TABLE meta.pending_page DROP CONSTRAINT IF EXISTS pending_page_status_ck;
ALTER TABLE meta.pending_page ADD CONSTRAINT pending_page_status_ck CHECK (status IN (
  -- failed/mismatch 只为滚动部署兼容旧二进制；0042 会立刻规范化存量，新代码不再写它们。
  'pending','retry','waiting_evidence','resolved','gone','conflict','irreconcilable',
  'failed','mismatch'
));

DROP INDEX IF EXISTS meta.pp_claim;
CREATE INDEX pp_claim
  ON meta.pending_page(priority DESC, not_before NULLS FIRST, state_changed_at, first_seen_at)
  WHERE status IN (
    'pending','retry','waiting_evidence','conflict','irreconcilable','failed','mismatch'
  ) AND locked_by IS NULL;

COMMENT ON COLUMN meta.pending_page.state_changed_at IS
  '当前状态开始时刻；pending 指标按它而非首次发现时刻计龄，复查完成后不会永久继承旧年龄。';
COMMENT ON COLUMN meta.pending_page.finished_at IS
  'resolved/gone 真正终态的完成时刻；其它状态必须由 not_before 给出下一次动作。';
COMMENT ON COLUMN meta.pending_page.resolution_source IS
  '状态/终态的语义来源，如 restricted_listpages_v1_reuse、wikidot_http_404、transient_retry。';
COMMENT ON COLUMN meta.pending_page.resolution_evidence IS
  '结构化证据；受限分类记录 ListPages fullname、v1 page/wikidotId 与只读会话事实。';
COMMENT ON COLUMN meta.pending_page.status IS
  'pending=新入队；retry=短退避；waiting_evidence=等待 v1/其它身份源；'
  'conflict=身份直接证据冲突并低频复查；irreconcilable=重试耗尽并低频复查；'
  'resolved/gone=终态。failed/mismatch 仅供滚动部署兼容，不是新写入口。';

-- 冷启动 138 行的合法证据链：
--   ListPages 完整 fullname == pending observed_slug；v1 只读复用给出 wikidotId；
--   v2 已存在同一 wikidotId，且其当前 legacy slug 恰好等于受限分类的历史 URL 口径。
-- 不接受“仅因为 adult 前缀就成功”，每一项必须同时满足上述身份等式。
WITH verified AS (
  SELECT pp.slug, p.id AS page_id, p.wikidot_id, psh.slug AS legacy_slug
    FROM meta.pending_page pp
    JOIN ingest.page p ON p.wikidot_id = pp.wikidot_id
    JOIN ingest.page_slug_history psh
      ON psh.page_id = p.id AND psh.valid_to IS NULL
    JOIN serve.page_current pc
      ON pc.page_id = p.id AND pc.wikidot_id = p.wikidot_id AND pc.status = 'live'
   WHERE pp.status = 'mismatch'
     AND pp.slug = pp.observed_slug
     AND pp.last_error LIKE 'coldstart: ListPages%v1 只读%'
     AND (
       (pp.slug LIKE 'adult:%'
         AND psh.slug = substr(pp.slug, length('adult:') + 1)
         AND pc.slug = psh.slug)
       OR
       (pp.slug LIKE 'wanderers-adult:%'
         AND psh.slug = 'wanderers:' || substr(pp.slug, length('wanderers-adult:') + 1)
         AND pc.slug = psh.slug)
     )
)
UPDATE meta.pending_page pp
   SET status = 'resolved',
       page_id = v.page_id,
       observed_slug = pp.slug,
       not_before = NULL,
       locked_by = NULL,
       locked_at = NULL,
       state_changed_at = now(),
       resolved_at = now(),
       finished_at = now(),
       last_error = NULL,
       resolution_source = 'restricted_listpages_v1_reuse',
       resolution_evidence = jsonb_build_object(
         'listpages_fullname', pp.slug,
         'legacy_slug', v.legacy_slug,
         'v2_page_id', v.page_id,
         'v1_wikidot_id', v.wikidot_id,
         'v1_read_only', true,
         'v2_identity_reused', true,
         'stock_migration', '0042'
       )
  FROM verified v
 WHERE pp.slug = v.slug;

-- 未通过严格受限证据校验的 mismatch 是真实冲突，不伪装成功；一周后自动复查。
UPDATE meta.pending_page
   SET status = 'conflict',
       not_before = now() + interval '7 days',
       state_changed_at = now(),
       resolution_source = COALESCE(resolution_source, 'legacy_identity_conflict'),
       resolution_evidence = resolution_evidence || jsonb_build_object(
         'normalized_by', '0042', 'review_interval_days', 7
       ),
       locked_by = NULL,
       locked_at = NULL
 WHERE status = 'mismatch';

-- failed 从来不是终态。冻结已释放后应立即重试；后续代码会按 1h/4h/24h/周复查收口。
UPDATE meta.pending_page
   SET status = 'retry',
       not_before = now(),
       state_changed_at = now(),
       resolution_source = 'legacy_failed_requeued',
       resolution_evidence = resolution_evidence || jsonb_build_object('normalized_by', '0042'),
       locked_by = NULL,
       locked_at = NULL
 WHERE status = 'failed';

UPDATE meta.pending_page
   SET finished_at = COALESCE(finished_at, resolved_at, state_changed_at),
       resolution_source = COALESCE(resolution_source, 'registered_identity')
 WHERE status = 'resolved';

-- 早期本迁移误把 v2 surrogate page_id 标成 v1_page_id；幂等纠正证据键。
UPDATE meta.pending_page
   SET resolution_evidence = (resolution_evidence - 'v1_page_id')
       || jsonb_build_object('v2_page_id', page_id)
 WHERE resolution_source = 'restricted_listpages_v1_reuse'
   AND resolution_evidence ->> 'stock_migration' = '0042';

UPDATE meta.pending_page
   SET finished_at = COALESCE(finished_at, state_changed_at),
       state_changed_at = COALESCE(state_changed_at, first_seen_at),
       not_before = NULL,
       resolution_source = COALESCE(resolution_source, 'wikidot_http_404'),
       resolution_evidence = resolution_evidence || jsonb_build_object('terminal', true)
 WHERE status = 'gone';

-- -------------------------------------------------------------------------------------
-- 2. 合成身份写入门。app 的 BFF 合成用户语义不在这里；只拒绝测试生成器特征。
-- -------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION meta.is_synthetic_test_page(p_wikidot_id int, p_slug text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $fn$
  SELECT COALESCE(p_slug, '') ~ '^(test|synthetic)-(image-)?page-[0-9]{10,}$'
$fn$;

CREATE OR REPLACE FUNCTION meta.is_synthetic_test_user(
  p_kind text,
  p_anon_key text,
  p_username text,
  p_display_name text
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $fn$
  SELECT p_kind = 'synthetic'
     AND concat_ws('|', p_anon_key, p_username, p_display_name)
           ~* '(^|\|)(test|synthetic)-(image-)?(user|actor)-[0-9]{10,}($|\|)'
$fn$;

CREATE OR REPLACE FUNCTION meta.reject_synthetic_test_identity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_wikidot_id int;
BEGIN
  IF TG_TABLE_SCHEMA = 'ingest' AND TG_TABLE_NAME = 'page_slug_history' THEN
    SELECT wikidot_id INTO v_wikidot_id FROM ingest.page WHERE id = NEW.page_id;
    IF meta.is_synthetic_test_page(v_wikidot_id, NEW.slug) THEN
      RAISE EXCEPTION '拒绝测试合成页写入 ingest：wikidot_id=%, slug=%', v_wikidot_id, NEW.slug
        USING ERRCODE = 'P2T01';
    END IF;
  ELSIF TG_TABLE_SCHEMA = 'serve' AND TG_TABLE_NAME = 'page_current' THEN
    IF meta.is_synthetic_test_page(NEW.wikidot_id, NEW.slug) THEN
      RAISE EXCEPTION '拒绝测试合成页写入 serve：wikidot_id=%, slug=%', NEW.wikidot_id, NEW.slug
        USING ERRCODE = 'P2T01';
    END IF;
  ELSIF TG_TABLE_SCHEMA = 'ingest' AND TG_TABLE_NAME = 'user' THEN
    IF meta.is_synthetic_test_user(NEW.kind, NEW.anon_key, NEW.username, NEW.display_name) THEN
      RAISE EXCEPTION '拒绝测试合成用户写入 ingest：anon_key=%, username=%', NEW.anon_key, NEW.username
        USING ERRCODE = 'P2T01';
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;

REVOKE ALL ON FUNCTION meta.is_synthetic_test_page(int,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION meta.is_synthetic_test_user(text,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION meta.reject_synthetic_test_identity() FROM PUBLIC;

DROP TRIGGER IF EXISTS trg_reject_synthetic_test_page ON ingest.page_slug_history;
CREATE TRIGGER trg_reject_synthetic_test_page
BEFORE INSERT OR UPDATE OF slug ON ingest.page_slug_history
FOR EACH ROW EXECUTE FUNCTION meta.reject_synthetic_test_identity();

DROP TRIGGER IF EXISTS trg_reject_synthetic_test_page ON serve.page_current;
CREATE TRIGGER trg_reject_synthetic_test_page
BEFORE INSERT OR UPDATE OF slug, wikidot_id ON serve.page_current
FOR EACH ROW EXECUTE FUNCTION meta.reject_synthetic_test_identity();

DROP TRIGGER IF EXISTS trg_reject_synthetic_test_user ON ingest."user";
CREATE TRIGGER trg_reject_synthetic_test_user
BEFORE INSERT OR UPDATE OF kind, anon_key, username, display_name ON ingest."user"
FOR EACH ROW EXECUTE FUNCTION meta.reject_synthetic_test_identity();

COMMENT ON FUNCTION meta.is_synthetic_test_page(int,text) IS
  '测试合成页分类器：识别带 10+ 位生成时间/随机数的 test/synthetic image-page；'
  '不按 test- 前缀泛删，test-log-* 等真实站点页面不会命中。';
COMMENT ON FUNCTION meta.reject_synthetic_test_identity() IS
  'serve/ingest 身份写入门；P2T01 拒绝测试生成器特征。app schema 的 BFF 合成语义不受影响。';

-- -------------------------------------------------------------------------------------
-- 3. 精确清理三条已知污染。目标必须同时满足 exact slug+wikidotId 与零业务事实特征。
-- -------------------------------------------------------------------------------------
CREATE TEMP TABLE pendclean_synthetic_page ON COMMIT DROP AS
SELECT pc.page_id, pc.wikidot_id, pc.slug, pc.source_sha
  FROM serve.page_current pc
  JOIN (VALUES
    ('test-image-page-1759148576016'::text, 800019414::int),
    ('test-image-page-1759149352271'::text, 800080727::int),
    ('test-image-page-1759413342363'::text, 800041112::int)
  ) expected(slug, wikidot_id)
    ON expected.slug = pc.slug AND expected.wikidot_id = pc.wikidot_id
 WHERE pc.status = 'live'
   AND pc.rating = 0 AND pc.vote_up = 0 AND pc.vote_down = 0 AND pc.vote_revoked = 0
   AND pc.revision_count = 0 AND pc.attribution_count = 0
   AND NOT EXISTS (SELECT 1 FROM ingest.vote_event ve WHERE ve.page_id = pc.page_id)
   AND NOT EXISTS (SELECT 1 FROM ingest.revision r WHERE r.page_id = pc.page_id)
   AND NOT EXISTS (SELECT 1 FROM ingest.attribution_event ae WHERE ae.page_id = pc.page_id)
   AND EXISTS (SELECT 1 FROM serve.page_image pi WHERE pi.page_id = pc.page_id);

DO $validate_cleanup$
DECLARE
  v_unsafe int;
BEGIN
  SELECT count(*) INTO v_unsafe
    FROM serve.page_current pc
    JOIN (VALUES
      ('test-image-page-1759148576016'::text, 800019414::int),
      ('test-image-page-1759149352271'::text, 800080727::int),
      ('test-image-page-1759413342363'::text, 800041112::int)
    ) expected(slug, wikidot_id)
      ON expected.slug = pc.slug OR expected.wikidot_id = pc.wikidot_id
   WHERE NOT EXISTS (
     SELECT 1 FROM pendclean_synthetic_page t WHERE t.page_id = pc.page_id
   );
  IF v_unsafe > 0 THEN
    RAISE EXCEPTION '[0042] 已知污染键现在指向不满足合成特征的页面，拒绝清理（% 行）', v_unsafe;
  END IF;
END
$validate_cleanup$;

SET LOCAL scpper.bypass_guard = 'on';

-- 无 FK 的派生投影先删；带 FK 的事实/当前态随后按子→父顺序删除。
DELETE FROM serve.page_reference
 WHERE from_page_id IN (SELECT page_id FROM pendclean_synthetic_page)
    OR to_page_id IN (SELECT page_id FROM pendclean_synthetic_page)
    OR candidate_page_ids && ARRAY(SELECT page_id FROM pendclean_synthetic_page)
    OR live_candidate_page_ids && ARRAY(SELECT page_id FROM pendclean_synthetic_page);
DELETE FROM serve.page_image WHERE page_id IN (SELECT page_id FROM pendclean_synthetic_page);
DELETE FROM serve.page_semantic WHERE page_id IN (SELECT page_id FROM pendclean_synthetic_page);
DELETE FROM serve.page_version_display WHERE page_id IN (SELECT page_id FROM pendclean_synthetic_page);
DELETE FROM serve.page_daily_stats WHERE page_id IN (SELECT page_id FROM pendclean_synthetic_page);
DELETE FROM serve.page_stats WHERE page_id IN (SELECT page_id FROM pendclean_synthetic_page);
DELETE FROM serve.vote_daily WHERE page_id IN (SELECT page_id FROM pendclean_synthetic_page);
DELETE FROM serve.user_page WHERE page_id IN (SELECT page_id FROM pendclean_synthetic_page);
DELETE FROM serve.content_records WHERE page_id IN (SELECT page_id FROM pendclean_synthetic_page);
DELETE FROM serve.rating_records WHERE page_id IN (SELECT page_id FROM pendclean_synthetic_page);
DELETE FROM serve.tag_records WHERE page_id IN (SELECT page_id FROM pendclean_synthetic_page);
DELETE FROM serve.time_milestones WHERE page_id IN (SELECT page_id FROM pendclean_synthetic_page);
DELETE FROM serve.interesting_facts WHERE page_id IN (SELECT page_id FROM pendclean_synthetic_page);
DELETE FROM serve.vote_current WHERE page_id IN (SELECT page_id FROM pendclean_synthetic_page);
DELETE FROM serve.attribution_current WHERE page_id IN (SELECT page_id FROM pendclean_synthetic_page);

DELETE FROM meta.image_ingest_job WHERE page_id IN (SELECT page_id FROM pendclean_synthetic_page);
DELETE FROM meta.fact_quarantine WHERE page_id IN (SELECT page_id FROM pendclean_synthetic_page);
DELETE FROM meta.incremental_drift_state WHERE page_id IN (SELECT page_id FROM pendclean_synthetic_page);
DELETE FROM meta.incremental_page_state WHERE page_id IN (SELECT page_id FROM pendclean_synthetic_page);
DELETE FROM meta.incremental_signal WHERE page_id IN (SELECT page_id FROM pendclean_synthetic_page);
DELETE FROM meta.irreconcilable WHERE page_id IN (SELECT page_id FROM pendclean_synthetic_page);
DELETE FROM meta.observation_queue WHERE page_id IN (SELECT page_id FROM pendclean_synthetic_page);
DELETE FROM meta.page_scan WHERE page_id IN (SELECT page_id FROM pendclean_synthetic_page);
DELETE FROM meta.pending_page WHERE page_id IN (SELECT page_id FROM pendclean_synthetic_page);
DELETE FROM meta.revision_source_backfill_job WHERE page_id IN (SELECT page_id FROM pendclean_synthetic_page);
DELETE FROM meta.revoke_candidate WHERE page_id IN (SELECT page_id FROM pendclean_synthetic_page);
DELETE FROM meta.scan_task WHERE page_id IN (SELECT page_id FROM pendclean_synthetic_page);
-- v1_attribution_map / v1_version_map 是“v1 源当时确有这些污染行”的冻结来源凭据，
-- 不是由 v2 serve 页生成的当前态；v1 又被服务端强制只读，故保留审计原貌。
-- 所有会参与 v2 服务、队列与投影的行均在本清理中删除。
DELETE FROM meta.v1_page_life_divergence_audit WHERE page_id IN (SELECT page_id FROM pendclean_synthetic_page);
DELETE FROM meta.vote_quarantine WHERE page_id IN (SELECT page_id FROM pendclean_synthetic_page);
DELETE FROM meta.vote_sweep_page_state WHERE page_id IN (SELECT page_id FROM pendclean_synthetic_page);

DELETE FROM ingest.vote_snapshot_event WHERE page_id IN (SELECT page_id FROM pendclean_synthetic_page);
DELETE FROM ingest.vote_event WHERE page_id IN (SELECT page_id FROM pendclean_synthetic_page);
DELETE FROM ingest.attribution_event WHERE page_id IN (SELECT page_id FROM pendclean_synthetic_page);
DELETE FROM ingest.revision_source_delta WHERE page_id IN (SELECT page_id FROM pendclean_synthetic_page);
DELETE FROM ingest.revision WHERE page_id IN (SELECT page_id FROM pendclean_synthetic_page);
DELETE FROM ingest.page_source WHERE page_id IN (SELECT page_id FROM pendclean_synthetic_page);
DELETE FROM ingest.page_attr_history WHERE page_id IN (SELECT page_id FROM pendclean_synthetic_page);
DELETE FROM ingest.page_life_event WHERE page_id IN (SELECT page_id FROM pendclean_synthetic_page);
DELETE FROM ingest.page_lineage
 WHERE predecessor_id IN (SELECT page_id FROM pendclean_synthetic_page)
    OR successor_id IN (SELECT page_id FROM pendclean_synthetic_page);
DELETE FROM ingest.forum_thread WHERE page_id IN (SELECT page_id FROM pendclean_synthetic_page);

DELETE FROM serve.page_current WHERE page_id IN (SELECT page_id FROM pendclean_synthetic_page);
DELETE FROM ingest.page_slug_history WHERE page_id IN (SELECT page_id FROM pendclean_synthetic_page);
DELETE FROM ingest.page WHERE id IN (SELECT page_id FROM pendclean_synthetic_page);

DELETE FROM ingest.content_blob cb
 WHERE cb.sha256 IN (SELECT source_sha FROM pendclean_synthetic_page WHERE source_sha IS NOT NULL)
   AND NOT EXISTS (SELECT 1 FROM ingest.page_source ps WHERE ps.blob_sha = cb.sha256)
   AND NOT EXISTS (SELECT 1 FROM ingest.revision r WHERE r.source_sha = cb.sha256)
   AND NOT EXISTS (SELECT 1 FROM ingest.revision_source_delta d WHERE d.anchor_sha = cb.sha256)
   AND NOT EXISTS (SELECT 1 FROM serve.page_current pc WHERE pc.source_sha = cb.sha256)
   AND NOT EXISTS (SELECT 1 FROM meta.revision_source_backfill_job j WHERE j.source_sha = cb.sha256);

COMMIT;
