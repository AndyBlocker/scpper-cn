-- =====================================================================================
-- 0072_provenance_and_existence_convergence.sql
--
-- 1. 成功 WhoRated 快照即使与当前有效票多重集相同，也必须把本次直接证据写到行级；
--    这条路径不签发新事实 seq，保留既有 last_seq，并保留不属于 rating_votes 口径的
--    direction=0 历史撤销行。
-- 2. 把 ListPages 系统性不可枚举的隐藏页显式归为 listpages_hidden，禁止拿它们做
--    absence/deletion 推断。
-- 3. 现代 L1 每 5 分钟完整枚举一次；只持久化每轮缺席的小集合，供 L1+L2 双源删除
--    确认使用，避免每轮重复写 3.6 万条正观测。
--
-- 本迁移必须先于依赖 enumeration_scope / l1_absence_observation 的 TS 代码生效。
-- =====================================================================================

\set ON_ERROR_STOP on

DO $guard$
BEGIN
  IF current_database() IN (
    'scpper-cn', 'scpper_cn', 'scpper-syncer', 'scpper_syncer', 'scpper_user'
  ) THEN
    RAISE EXCEPTION '[0072] 拒绝在受保护库 % 上修改采集收敛协议', current_database()
      USING ERRCODE = '42501';
  END IF;
  IF to_regclass('serve.page_current') IS NULL
     OR to_regclass('serve.vote_current') IS NULL
     OR to_regclass('meta.ingest_run') IS NULL
     OR to_regprocedure(
       'ingest.apply_vote_snapshot(integer,jsonb,boolean,integer,integer,text[],timestamptz,text,bigint,integer,text,integer,real)'
     ) IS NULL THEN
    RAISE EXCEPTION '[0072] 缺少 page/vote/L1 前置 schema'
      USING ERRCODE = '55000';
  END IF;
END
$guard$;

BEGIN;

SELECT pg_advisory_xact_lock(20260817);

-- ── 页面枚举域：显式区分“ListPages 应枚举”与“Wikidot 隐藏系统页” ──────────────
ALTER TABLE serve.page_current
  ADD COLUMN IF NOT EXISTS enumeration_scope text NOT NULL DEFAULT 'standard';

ALTER TABLE serve.page_current
  DROP CONSTRAINT IF EXISTS page_current_enumeration_scope_ck;
ALTER TABLE serve.page_current
  ADD CONSTRAINT page_current_enumeration_scope_ck
  CHECK (enumeration_scope IN ('standard', 'listpages_hidden'));

CREATE OR REPLACE FUNCTION serve.classify_page_enumeration_scope()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  NEW.enumeration_scope := CASE
    -- `_template` 与 `category:_template` 同属 Wikidot 的隐藏页域；完整 L1 的
    -- category='*' 不返回它们，缺席是产品语义而不是疑似删除。
    WHEN lower(btrim(NEW.slug)) ~ '(^|:)_' THEN 'listpages_hidden'
    ELSE 'standard'
  END;
  RETURN NEW;
END
$function$;

COMMENT ON COLUMN serve.page_current.enumeration_scope IS
  'standard=应由完整 ListPages L1 枚举；listpages_hidden=显式 Wikidot 隐藏系统/模板页，'
  '其 L1 缺席既不是采集缺口，也不得作为删除证据。';
COMMENT ON FUNCTION serve.classify_page_enumeration_scope() IS
  '按 slug 的 Wikidot 隐藏页语义维护 enumeration_scope；覆盖 INSERT、改名与存量回填。';

REVOKE ALL ON FUNCTION serve.classify_page_enumeration_scope() FROM PUBLIC;

DROP TRIGGER IF EXISTS trg_classify_page_enumeration_scope ON serve.page_current;
CREATE TRIGGER trg_classify_page_enumeration_scope
BEFORE INSERT OR UPDATE OF slug ON serve.page_current
FOR EACH ROW EXECUTE FUNCTION serve.classify_page_enumeration_scope();

CREATE INDEX IF NOT EXISTS pc_live_enumeration_scope
  ON serve.page_current(enumeration_scope, page_id)
  WHERE status = 'live';

UPDATE serve.page_current
   SET enumeration_scope = CASE
     WHEN lower(btrim(slug)) ~ '(^|:)_' THEN 'listpages_hidden'
     ELSE 'standard'
   END
 WHERE enumeration_scope IS DISTINCT FROM CASE
     WHEN lower(btrim(slug)) ~ '(^|:)_' THEN 'listpages_hidden'
     ELSE 'standard'
   END;

-- ── 完整 L1 只记录缺席小集合 ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS meta.l1_absence_observation (
  run_id      bigint      NOT NULL REFERENCES meta.ingest_run(id) ON DELETE CASCADE,
  page_id     int         NOT NULL REFERENCES ingest.page(id) ON DELETE CASCADE,
  slug        text        NOT NULL CHECK (btrim(slug) <> ''),
  observed_at timestamptz NOT NULL,
  PRIMARY KEY (run_id, page_id)
);

CREATE INDEX IF NOT EXISTS l1_absence_page_observed
  ON meta.l1_absence_observation(page_id, observed_at DESC, run_id DESC);

COMMENT ON TABLE meta.l1_absence_observation IS
  '现代完整 L1 每轮仅持久化 standard live 页的缺席小集合。行只能证明该轮没看到；'
  '删除仍需两组跨 TTL 的完整 L1+L2、期间无正观测、absence 熔断通过与最终 HTTP 404。';

-- 对最近 72h 的既有完整 L1 做保守回填。last_l1_seen_at 晚于某历史轮时一律视为
-- “可能见过”而不补 absence；宁可少报，绝不为验收制造幻影负证据。
INSERT INTO meta.l1_absence_observation(run_id, page_id, slug, observed_at)
SELECT ir.id, pc.page_id, pc.slug, ir.started_at
  FROM meta.ingest_run ir
  JOIN serve.page_current pc
    ON pc.status = 'live'
   AND pc.enumeration_scope = 'standard'
  JOIN ingest.page p ON p.id = pc.page_id
  LEFT JOIN meta.incremental_page_state ips
    ON ips.page_id = pc.page_id AND ips.slug = pc.slug
 WHERE ir.source = 'wikidot_listpages'
   AND ir.stats ->> 'mode' = 'l1_votes'
   AND ir.stats ->> 'layer' = 'L1'
   AND ir.status = 'ok'
   AND ir.coverage_ratio >= 0.98
   AND ir.batches_failed = 0
   AND ir.stats #>> '{coverage,scope}' = 'full'
   AND ir.stats #>> '{validation,complete}' = 'true'
   AND ir.started_at >= now() - interval '72 hours'
   AND p.created_at <= ir.started_at
   AND (ips.last_l1_seen_at IS NULL OR ips.last_l1_seen_at < ir.started_at)
ON CONFLICT (run_id, page_id) DO NOTHING;

-- ── 把 0033 的状态替换实现保留为后端；新同名入口先处理“状态相同、出身待建立” ──
DO $rename_backend$
BEGIN
  IF to_regprocedure(
       'ingest.apply_vote_snapshot_state_replace_v0072(integer,jsonb,boolean,integer,integer,text[],timestamptz,text,bigint,integer,text,integer,real)'
     ) IS NULL THEN
    ALTER FUNCTION ingest.apply_vote_snapshot(
      integer, jsonb, boolean, integer, integer, text[], timestamptz, text,
      bigint, integer, text, integer, real
    ) RENAME TO apply_vote_snapshot_state_replace_v0072;
  END IF;
END
$rename_backend$;

CREATE OR REPLACE FUNCTION ingest.apply_vote_snapshot(
  p_page           int,
  p_entries        jsonb,
  p_is_complete    boolean,
  p_claimed_total  int,
  p_claimed_rating int,
  p_visible_kinds  text[]      DEFAULT ARRAY['wikidot'],
  p_observed       timestamptz DEFAULT now(),
  p_source         text        DEFAULT 'wikidot',
  p_run            bigint      DEFAULT NULL,
  p_wikidot_id     int         DEFAULT NULL,
  p_absence_policy text        DEFAULT 'candidate',
  p_max_absence    int         DEFAULT 500,
  p_max_absence_ratio real     DEFAULT 0.20
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_raw int := 0;
  v_active_current int := 0;
  v_checksum int := 0;
  v_uniq int := 0;
  v_unique_rating int := 0;
  v_hash bytea;
  v_current_hash bytea;
  v_logical_match boolean := false;
  v_already_provenanced boolean := false;
  v_rewritten int := 0;
  v_current_rows int := 0;
BEGIN
  -- 非数组与非法协议仍交给原实现给出既有 SQLSTATE/错误文本。
  IF p_entries IS NULL OR jsonb_typeof(p_entries) <> 'array'
     OR p_visible_kinds IS NULL OR array_length(p_visible_kinds, 1) IS NULL
     OR p_absence_policy NOT IN ('candidate', 'event', 'forbidden')
     OR p_source IS NULL THEN
    RETURN ingest.apply_vote_snapshot_state_replace_v0072(
      p_page, p_entries, p_is_complete, p_claimed_total, p_claimed_rating,
      p_visible_kinds, p_observed, p_source, p_run, p_wikidot_id,
      p_absence_policy, p_max_absence, p_max_absence_ratio
    );
  END IF;

  PERFORM meta.assert_writes_allowed('vote');
  PERFORM meta.ingest_gate_open();
  PERFORM ingest.assert_page_identity(p_page, p_wikidot_id);
  PERFORM pg_advisory_xact_lock(meta.lock_class_page(), p_page);

  CREATE TEMP TABLE IF NOT EXISTS vote_snapshot_provenance_input (
    source_row_ordinal int PRIMARY KEY,
    voter_id int NOT NULL,
    direction smallint NOT NULL,
    identity_key text
  ) ON COMMIT DROP;
  TRUNCATE vote_snapshot_provenance_input;

  -- direction=0 不是 WhoRated 原始行；若调用方传入任何非标准行，让原实现负责隔离/报错。
  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(p_entries) AS e(r)
     WHERE abs(COALESCE((r ->> 'direction')::int, 0)) > 1
        OR COALESCE((r ->> 'direction')::int, 0) = 0
        OR NOT (r ? 'voter_id')
        OR NULLIF(r ->> 'voter_id', '') IS NULL
  ) THEN
    RETURN ingest.apply_vote_snapshot_state_replace_v0072(
      p_page, p_entries, p_is_complete, p_claimed_total, p_claimed_rating,
      p_visible_kinds, p_observed, p_source, p_run, p_wikidot_id,
      p_absence_policy, p_max_absence, p_max_absence_ratio
    );
  END IF;

  INSERT INTO vote_snapshot_provenance_input(
    source_row_ordinal, voter_id, direction, identity_key
  )
  SELECT COALESCE(NULLIF((r ->> 'source_ordinal')::int, 0), ord::int),
         (r ->> 'voter_id')::int,
         sign((r ->> 'direction')::int)::smallint,
         NULLIF(r ->> 'identity_key', '')
    FROM jsonb_array_elements(p_entries) WITH ORDINALITY AS e(r, ord);

  SELECT count(*)::int,
         COALESCE(sum(direction), 0)::int,
         count(DISTINCT voter_id)::int,
         decode(md5(COALESCE(string_agg(
           source_row_ordinal::text || ':' || voter_id::text || ':' || direction::text || ':' ||
             COALESCE(identity_key, ''), E'\n' ORDER BY source_row_ordinal), '')), 'hex')
    INTO v_raw, v_checksum, v_uniq, v_hash
    FROM vote_snapshot_provenance_input;

  IF EXISTS (
       SELECT 1 FROM vote_snapshot_provenance_input WHERE source_row_ordinal <= 0
     )
     OR v_raw <> jsonb_array_length(p_entries)
     OR NOT COALESCE(p_is_complete, false)
     OR (p_claimed_total IS NOT NULL AND v_raw <> p_claimed_total)
     OR p_claimed_rating IS NULL
     OR v_checksum <> p_claimed_rating
     OR (v_raw = 0 AND COALESCE(p_claimed_total, 1) > 0) THEN
    RETURN ingest.apply_vote_snapshot_state_replace_v0072(
      p_page, p_entries, p_is_complete, p_claimed_total, p_claimed_rating,
      p_visible_kinds, p_observed, p_source, p_run, p_wikidot_id,
      p_absence_policy, p_max_absence, p_max_absence_ratio
    );
  END IF;

  SELECT COALESCE(sum(sign(net)), 0)::int
    INTO v_unique_rating
    FROM (
      SELECT voter_id, sum(direction)::int AS net
        FROM vote_snapshot_provenance_input
       GROUP BY voter_id
    ) folded;

  SELECT count(*)::int,
         decode(md5(COALESCE(string_agg(
           source_row_ordinal::text || ':' || voter_id::text || ':' || direction::text || ':' ||
             COALESCE(source_identity_key, ''), E'\n' ORDER BY source_row_ordinal), '')), 'hex')
    INTO v_active_current, v_current_hash
    FROM serve.vote_current
   WHERE page_id = p_page AND direction <> 0;

  -- 多重集按 (voter_id,direction,count) 比；source ordinal / identity key / snapshot 字段
  -- 是本次要建立的证据，不得反过来阻止“内容相同”的幂等出身路径。
  SELECT v_active_current = v_raw
     AND NOT EXISTS (
       SELECT 1
         FROM (
           SELECT voter_id, direction, count(*)::int AS n
             FROM serve.vote_current
            WHERE page_id = p_page AND direction <> 0
            GROUP BY voter_id, direction
         ) old_rows
         FULL JOIN (
           SELECT voter_id, direction, count(*)::int AS n
             FROM vote_snapshot_provenance_input
            GROUP BY voter_id, direction
         ) new_rows USING (voter_id, direction)
        WHERE old_rows.n IS DISTINCT FROM new_rows.n
     )
    INTO v_logical_match;

  IF NOT v_logical_match THEN
    RETURN ingest.apply_vote_snapshot_state_replace_v0072(
      p_page, p_entries, p_is_complete, p_claimed_total, p_claimed_rating,
      p_visible_kinds, p_observed, p_source, p_run, p_wikidot_id,
      p_absence_policy, p_max_absence, p_max_absence_ratio
    );
  END IF;

  SELECT v_current_hash = v_hash
     AND NOT EXISTS (
       SELECT 1
         FROM serve.vote_current
        WHERE page_id = p_page
          AND direction <> 0
          AND (
            source_row_ordinal <= 0
            OR snapshot_hash IS DISTINCT FROM v_hash
            OR snapshot_observed_at IS NULL
            OR snapshot_source IS NULL
          )
     )
    INTO v_already_provenanced;

  IF NOT v_already_provenanced AND v_raw > 0 THEN
    CREATE TEMP TABLE IF NOT EXISTS vote_snapshot_provenance_old (
      voter_id int NOT NULL,
      direction smallint NOT NULL,
      occurrence int NOT NULL,
      first_voted_at timestamptz,
      last_voted_at timestamptz NOT NULL,
      last_precision text NOT NULL,
      last_seq bigint NOT NULL,
      PRIMARY KEY (voter_id, direction, occurrence)
    ) ON COMMIT DROP;
    TRUNCATE vote_snapshot_provenance_old;

    INSERT INTO vote_snapshot_provenance_old(
      voter_id, direction, occurrence, first_voted_at, last_voted_at, last_precision, last_seq
    )
    SELECT voter_id, direction,
           row_number() OVER (
             PARTITION BY voter_id, direction
             ORDER BY source_row_ordinal, last_seq, first_voted_at
           )::int,
           first_voted_at, last_voted_at, last_precision, last_seq
      FROM serve.vote_current
     WHERE page_id = p_page AND direction <> 0;

    DELETE FROM serve.vote_current
     WHERE page_id = p_page AND direction <> 0;

    INSERT INTO serve.vote_current(
      page_id, voter_id, direction, first_voted_at, last_voted_at,
      last_precision, last_seq, source_row_ordinal, source_identity_key,
      snapshot_hash, snapshot_observed_at, snapshot_source
    )
    SELECT p_page, incoming.voter_id, incoming.direction,
           old.first_voted_at, old.last_voted_at, old.last_precision, old.last_seq,
           incoming.source_row_ordinal, incoming.identity_key,
           v_hash, p_observed, p_source
      FROM (
        SELECT i.*,
               row_number() OVER (
                 PARTITION BY i.voter_id, i.direction ORDER BY i.source_row_ordinal
               )::int AS occurrence
          FROM vote_snapshot_provenance_input i
      ) incoming
      JOIN vote_snapshot_provenance_old old
        USING (voter_id, direction, occurrence)
     ORDER BY incoming.source_row_ordinal;
    GET DIAGNOSTICS v_rewritten = ROW_COUNT;

    IF v_rewritten <> v_raw THEN
      RAISE EXCEPTION 'apply_vote_snapshot: 出身映射只重写 %/% 行', v_rewritten, v_raw
        USING ERRCODE = '23514';
    END IF;
  END IF;

  PERFORM meta.record_page_scan(
    p_run, p_page, 'votes', 'ok', p_claimed_total, v_raw,
    true, p_claimed_rating, v_checksum, v_hash, NULL
  );

  SELECT count(*)::int INTO v_current_rows
    FROM serve.vote_current WHERE page_id = p_page;

  RETURN jsonb_build_object(
    'events', 0, 'snapshot_events', 0, 'snapshot_replaced', false,
    'idempotent_replay', true,
    'provenance_established', NOT v_already_provenanced,
    'provenance_rows_written', v_rewritten,
    'raw_entries', v_raw, 'current_rows', v_current_rows,
    'unique_voters', v_uniq, 'unique_voter_rating', v_unique_rating,
    'checksum_actual', v_checksum, 'checksum_expected', p_claimed_rating,
    'checksum_ok', true, 'gate_is_complete', true, 'gate_claimed_total', true,
    'gate_visible_kinds', to_jsonb(p_visible_kinds), 'gate_checksum', true,
    'gate_nonempty', true, 'absence_allowed', true, 'absence_count', 0,
    'absence_policy', 'snapshot_replace', 'candidates_written', 0,
    'revoke_events', 0, 'scan_status', 'ok', 'reason', NULL
  );
END;
$function$;

COMMENT ON FUNCTION ingest.apply_vote_snapshot(
  int, jsonb, boolean, int, int, text[], timestamptz, text, bigint, int, text, int, real
) IS
  'WhoRated 页级多重集入口。有效票状态相同时以 scan 证据建立/刷新行级出身，保留 last_seq '
  '与 direction=0 历史行且不签发新 fact；状态变化时委托 0033 整体替换实现。';

REVOKE ALL ON FUNCTION ingest.apply_vote_snapshot(
  int, jsonb, boolean, int, int, text[], timestamptz, text, bigint, int, text, int, real
) FROM PUBLIC;
REVOKE ALL ON FUNCTION ingest.apply_vote_snapshot_state_replace_v0072(
  int, jsonb, boolean, int, int, text[], timestamptz, text, bigint, int, text, int, real
) FROM PUBLIC;

DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ingestor_role') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON meta.l1_absence_observation TO ingestor_role;
    GRANT EXECUTE ON FUNCTION ingest.apply_vote_snapshot(
      int, jsonb, boolean, int, int, text[], timestamptz, text, bigint, int, text, int, real
    ) TO ingestor_role;
    GRANT EXECUTE ON FUNCTION ingest.apply_vote_snapshot_state_replace_v0072(
      int, jsonb, boolean, int, int, text[], timestamptz, text, bigint, int, text, int, real
    ) TO ingestor_role;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'projector_role') THEN
    GRANT SELECT ON meta.l1_absence_observation TO projector_role;
  END IF;
END
$grants$;

COMMIT;

DO $invariant$
BEGIN
  IF EXISTS (
    SELECT 1 FROM serve.page_current
     WHERE (lower(btrim(slug)) ~ '(^|:)_') IS DISTINCT FROM
           (enumeration_scope = 'listpages_hidden')
  ) THEN
    RAISE EXCEPTION '[0072] enumeration_scope 存量分类不完整'
      USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM meta.l1_absence_observation a
      JOIN serve.page_current pc ON pc.page_id = a.page_id
     WHERE pc.enumeration_scope <> 'standard'
  ) THEN
    RAISE EXCEPTION '[0072] 隐藏页进入了 L1 absence 证据'
      USING ERRCODE = '23514';
  END IF;
END
$invariant$;
