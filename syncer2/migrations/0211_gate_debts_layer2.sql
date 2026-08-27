-- =====================================================================================
-- 0211_gate_debts_layer2.sql
--
-- 0210 清掉门禁第一层报错后，分层检查暴露第二层（这正是检查的分层设计意图）：
--   0001[drift-4]: image_asset_url_alias 的 rebuild_from 登记须与表注释逐字一致
--   0002[freeze-3]: 四个新增 ingest.apply_* 未接 R10 熔断也未进检查清单
--     （分别来自 TITLE/PROV/DEGRADE 波次——新增写入函数时没人跑这个检查，
--       部署门禁把 checks 全部纳入后才被抓到）
-- =====================================================================================

BEGIN;

-- 0001[drift-4]：登记必须与表注释**整串逐字一致（含 rebuild_from= 前缀）**。
-- 首版剥了前缀，检查照样红——它比的是全文。以注释为唯一事实源，机械复制。
UPDATE meta.projection_cursor
   SET rebuild_from = obj_description('serve.image_asset_url_alias'::regclass, 'pg_class'),
       updated_at = now()
 WHERE projection = 'serve.image_asset_url_alias';

-- 0002[freeze-3]：四个函数接入熔断（整体重放，各仅加一行断言）
CREATE OR REPLACE FUNCTION ingest.apply_current_page_source(p_page integer, p_source_wikitext text, p_text_content text, p_observed timestamp with time zone, p_observation_source text, p_run bigint DEFAULT NULL::bigint, p_wikidot_id integer DEFAULT NULL::integer, p_rev_no integer DEFAULT NULL::integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE
  v_sha bytea;
  v_inserted int := 0;
  v_hit int := 0;
BEGIN
  -- R10 写冻结熔断（check 0002 抓到缺失：content 域冻结曾对本函数无效）。
  PERFORM meta.assert_writes_allowed('content');
  IF p_source_wikitext IS NULL THEN
    RAISE EXCEPTION 'apply_current_page_source: source_wikitext 不得为 NULL'
      USING ERRCODE = '22004';
  END IF;
  IF p_observation_source NOT IN ('wikidot_anonymous', 'wikidot_authenticated') THEN
    RAISE EXCEPTION 'apply_current_page_source: 非法 v2 来源 %', p_observation_source
      USING ERRCODE = '22023';
  END IF;

  PERFORM meta.assert_writes_allowed('content');
  PERFORM meta.assert_writes_allowed('page');
  PERFORM meta.ingest_gate_open();
  PERFORM ingest.assert_page_identity(p_page, p_wikidot_id);
  PERFORM pg_advisory_xact_lock(meta.lock_class_page(), p_page);

  v_sha := ingest.put_content_blob(p_source_wikitext, p_text_content);

  IF p_rev_no IS NULL THEN
    INSERT INTO ingest.page_source(
      page_id, rev_no, blob_sha, observed_at, observation_source, run_id
    ) VALUES (
      p_page, NULL, v_sha, p_observed, p_observation_source, p_run
    )
    ON CONFLICT (page_id, blob_sha, observation_source) WHERE rev_no IS NULL
    DO NOTHING;
  ELSE
    INSERT INTO ingest.page_source(
      page_id, rev_no, blob_sha, observed_at, observation_source, run_id
    ) VALUES (
      p_page, p_rev_no, v_sha, p_observed, p_observation_source, p_run
    )
    ON CONFLICT (page_id, rev_no) WHERE rev_no IS NOT NULL DO NOTHING;
  END IF;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  UPDATE serve.page_current pc
     SET source_sha = v_sha,
         search_text = CASE
           WHEN p_text_content IS NULL OR p_text_content = '' THEN pc.search_text
           ELSE p_text_content
         END,
         updated_at = now()
   WHERE pc.page_id = p_page;
  GET DIAGNOSTICS v_hit = ROW_COUNT;
  IF v_hit = 0 THEN
    RAISE EXCEPTION 'apply_current_page_source: page_current 缺 page_id=%', p_page
      USING ERRCODE = '23503';
  END IF;

  RETURN jsonb_build_object(
    'source_sha', encode(v_sha, 'hex'),
    'page_source_inserted', v_inserted = 1,
    'observation_source', p_observation_source,
    'run_id', p_run
  );
END
$function$;
CREATE OR REPLACE FUNCTION ingest.apply_identity_missing_deletion(p_page integer, p_expected_wikidot integer, p_slug text, p_observed timestamp with time zone DEFAULT now(), p_run bigint DEFAULT NULL::bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE
  v_current_wikidot int;
  v_current_slug    text;
  v_status          text;
  v_deleted_seq     bigint;
BEGIN
  -- R10 写冻结熔断（check 0002 抓到缺失：identity 域冻结曾对本函数无效）。
  PERFORM meta.assert_writes_allowed('identity');
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
$function$;
CREATE OR REPLACE FUNCTION ingest.apply_listpages_rendered_content(p_page integer, p_sha bytea, p_rendered_html text, p_text_content text, p_observed timestamp with time zone, p_run bigint DEFAULT NULL::bigint, p_wikidot_id integer DEFAULT NULL::integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE
  v_inserted int := 0;
  v_hit int := 0;
BEGIN
  -- R10 写冻结熔断（check 0002 抓到缺失：content 域冻结曾对本函数无效）。
  PERFORM meta.assert_writes_allowed('content');
  IF p_sha IS NULL OR octet_length(p_sha) <> 32 THEN
    RAISE EXCEPTION 'apply_listpages_rendered_content: sha 必须是 32 字节 sha256'
      USING ERRCODE = '22023';
  END IF;
  IF p_rendered_html IS NULL THEN
    RAISE EXCEPTION 'apply_listpages_rendered_content: rendered_html 不得为 NULL'
      USING ERRCODE = '22004';
  END IF;
  IF sha256(convert_to(p_rendered_html, 'UTF8')) <> p_sha THEN
    RAISE EXCEPTION 'apply_listpages_rendered_content: sha 与 rendered_html UTF-8 字节不一致'
      USING ERRCODE = '22000';
  END IF;

  PERFORM meta.assert_writes_allowed('content');
  PERFORM meta.ingest_gate_open();
  PERFORM ingest.assert_page_identity(p_page, p_wikidot_id);
  PERFORM pg_advisory_xact_lock(meta.lock_class_page(), p_page);

  INSERT INTO ingest.rendered_content_blob(
    sha256, rendered_html, text_content, byte_len, text_len, source, created_at
  ) VALUES (
    p_sha, p_rendered_html, p_text_content,
    octet_length(p_rendered_html), COALESCE(length(p_text_content), 0),
    'wikidot_listpages', now()
  )
  ON CONFLICT (sha256) DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  -- sha 相同却正文不同只能是摘要碰撞/调用方 bug；不能借 ON CONFLICT 静默择一。
  IF NOT EXISTS (
    SELECT 1 FROM ingest.rendered_content_blob b
     WHERE b.sha256 = p_sha
       AND b.rendered_html IS NOT DISTINCT FROM p_rendered_html
       AND b.text_content IS NOT DISTINCT FROM p_text_content
  ) THEN
    RAISE EXCEPTION 'apply_listpages_rendered_content: sha 已存在但正文/纯文本不同'
      USING ERRCODE = '23505';
  END IF;

  UPDATE serve.page_current
     SET rendered_content_sha = p_sha,
         search_text = p_text_content,
         updated_at = now()
   WHERE page_id = p_page;
  GET DIAGNOSTICS v_hit = ROW_COUNT;
  IF v_hit = 0 THEN
    RAISE EXCEPTION 'apply_listpages_rendered_content: page_current 缺 page_id=%', p_page
      USING ERRCODE = '23503';
  END IF;

  PERFORM meta.record_page_scan(
    p_run, p_page, 'content', 'ok', 1, 1, true, NULL, NULL, p_sha, NULL
  );

  RETURN jsonb_build_object(
    'sha256', encode(p_sha, 'hex'),
    'inserted', v_inserted = 1,
    'html_bytes', octet_length(p_rendered_html),
    'text_chars', COALESCE(length(p_text_content), 0)
  );
END
$function$;
CREATE OR REPLACE FUNCTION ingest.apply_vote_snapshot_state_replace_v0072(p_page integer, p_entries jsonb, p_is_complete boolean, p_claimed_total integer, p_claimed_rating integer, p_visible_kinds text[] DEFAULT ARRAY['wikidot'::text], p_observed timestamp with time zone DEFAULT now(), p_source text DEFAULT 'wikidot'::text, p_run bigint DEFAULT NULL::bigint, p_wikidot_id integer DEFAULT NULL::integer, p_absence_policy text DEFAULT 'candidate'::text, p_max_absence integer DEFAULT 500, p_max_absence_ratio real DEFAULT 0.20)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE
  v_raw int := 0;
  v_uniq int := 0;
  v_checksum int := 0;
  v_unique_rating int := 0;
  v_gate1 boolean;
  v_gate2 boolean;
  v_gate4 boolean;
  v_gate5 boolean;
  v_success boolean;
  v_status text;
  v_reason text;
  v_hash bytea;
  v_old_hash bytea;
  v_old_rows int := 0;
  v_old_rating int := 0;
  v_old_up int := 0;
  v_old_down int := 0;
  v_old_revoked int := 0;
  v_event_rating_delta int := 0;
  v_event_up_delta int := 0;
  v_event_down_delta int := 0;
  v_events int := 0;
  v_revoke_events int := 0;
  v_absent int := 0;
  v_marker_seq bigint;
  v_page_hit int;
  v_source_rows_uniq int;
BEGIN
  -- R10 写冻结熔断（check 0002 抓到缺失：vote 域冻结曾对本函数无效）。
  PERFORM meta.assert_writes_allowed('vote');
  IF p_entries IS NULL OR jsonb_typeof(p_entries) <> 'array' THEN
    RAISE EXCEPTION 'apply_vote_snapshot: p_entries 必须是 jsonb array'
      USING ERRCODE = '22023';
  END IF;
  IF p_visible_kinds IS NULL OR array_length(p_visible_kinds, 1) IS NULL THEN
    RAISE EXCEPTION 'apply_vote_snapshot: visible_kinds 不能为空'
      USING ERRCODE = '22004';
  END IF;
  IF p_absence_policy NOT IN ('candidate','event','forbidden') THEN
    RAISE EXCEPTION 'apply_vote_snapshot: 非法 p_absence_policy %', p_absence_policy
      USING ERRCODE = '22023';
  END IF;

  PERFORM meta.assert_writes_allowed('vote');
  PERFORM meta.ingest_gate_open();
  PERFORM ingest.assert_page_identity(p_page, p_wikidot_id);
  PERFORM pg_advisory_xact_lock(meta.lock_class_page(), p_page);

  CREATE TEMP TABLE IF NOT EXISTS vote_snapshot_input (
    source_row_ordinal int PRIMARY KEY,
    voter_id int NOT NULL,
    direction smallint NOT NULL,
    identity_key text
  ) ON COMMIT DROP;
  TRUNCATE vote_snapshot_input;

  INSERT INTO meta.vote_quarantine(page_id, voter_key, raw, reason, source, occurred_at)
  SELECT p_page, r ->> 'identity_key', r, 'direction_out_of_range', p_source, p_observed
    FROM jsonb_array_elements(p_entries) AS e(r)
   WHERE abs(COALESCE((r ->> 'direction')::int, 0)) > 1;

  INSERT INTO vote_snapshot_input(source_row_ordinal, voter_id, direction, identity_key)
  SELECT COALESCE(NULLIF((r ->> 'source_ordinal')::int, 0), ord::int),
         (r ->> 'voter_id')::int,
         sign(COALESCE((r ->> 'direction')::int, 0))::smallint,
         NULLIF(r ->> 'identity_key', '')
    FROM jsonb_array_elements(p_entries) WITH ORDINALITY AS e(r, ord)
   WHERE (r ? 'voter_id') AND NULLIF(r ->> 'voter_id', '') IS NOT NULL;

  SELECT count(*)::int,
         count(DISTINCT voter_id)::int,
         count(DISTINCT source_row_ordinal)::int,
         COALESCE(sum(direction), 0)::int
    INTO v_raw, v_uniq, v_source_rows_uniq, v_checksum
    FROM vote_snapshot_input;

  IF v_raw <> jsonb_array_length(p_entries) THEN
    RAISE EXCEPTION 'apply_vote_snapshot: % 条输入中只有 % 条带 voter_id',
      jsonb_array_length(p_entries), v_raw USING ERRCODE = '22004';
  END IF;
  IF v_source_rows_uniq <> v_raw THEN
    RAISE EXCEPTION 'apply_vote_snapshot: source_ordinal 必须逐行唯一'
      USING ERRCODE = '22000';
  END IF;
  IF EXISTS (SELECT 1 FROM vote_snapshot_input WHERE source_row_ordinal <= 0) THEN
    RAISE EXCEPTION 'apply_vote_snapshot: WhoRated source_ordinal 必须 > 0'
      USING ERRCODE = '22000';
  END IF;

  SELECT COALESCE(sum(sign(net)), 0)::int
    INTO v_unique_rating
    FROM (
      SELECT voter_id, sum(direction)::int AS net
        FROM vote_snapshot_input
       WHERE direction <> 0
       GROUP BY voter_id
    ) u;

  SELECT decode(md5(COALESCE(string_agg(
           source_row_ordinal::text || ':' || voter_id::text || ':' || direction::text || ':' ||
             COALESCE(identity_key, ''), E'\n' ORDER BY source_row_ordinal), '')), 'hex')
    INTO v_hash
    FROM vote_snapshot_input;

  v_gate1 := COALESCE(p_is_complete, false);
  v_gate2 := p_claimed_total IS NULL OR v_raw = p_claimed_total;
  v_gate4 := p_claimed_rating IS NULL OR v_checksum = p_claimed_rating;
  v_gate5 := NOT (v_raw = 0 AND COALESCE(p_claimed_total, 1) > 0);
  -- claimed_rating 缺失时可以留下 partial 证据，但不能授权破坏性的整页替换。
  v_success := v_gate1 AND v_gate2 AND v_gate5
               AND p_claimed_rating IS NOT NULL AND v_gate4;

  v_status := CASE
    WHEN NOT v_gate5 THEN 'failed'
    WHEN v_success THEN 'ok'
    ELSE 'partial'
  END;
  IF NOT v_gate1 THEN v_reason := 'is_complete=false';
  ELSIF NOT v_gate5 THEN v_reason := format('entries=0 而 claimed_total=%s', COALESCE(p_claimed_total::text, 'NULL'));
  ELSIF NOT v_gate2 THEN v_reason := format('原始行数 %s ≠ claimed_total %s', v_raw, p_claimed_total);
  ELSIF p_claimed_rating IS NULL THEN v_reason := '未提供 claimed_rating，禁止 snapshot replace';
  ELSIF NOT v_gate4 THEN v_reason := format('全行 checksum 不符:Σsign=%s ≠ %%rating%%=%s', v_checksum, p_claimed_rating);
  END IF;

  IF NOT v_success THEN
    PERFORM meta.record_page_scan(
      p_run, p_page, 'votes', v_status, p_claimed_total, v_raw,
      CASE WHEN p_claimed_rating IS NULL THEN NULL ELSE v_gate4 END,
      p_claimed_rating, v_checksum, v_hash, v_reason
    );
    RETURN jsonb_build_object(
      'events', 0, 'snapshot_events', 0, 'snapshot_replaced', false,
      'idempotent_replay', false, 'raw_entries', v_raw, 'current_rows', NULL,
      'unique_voters', v_uniq, 'unique_voter_rating', v_unique_rating,
      'checksum_actual', v_checksum, 'checksum_expected', p_claimed_rating,
      'checksum_ok', CASE WHEN p_claimed_rating IS NULL THEN NULL ELSE v_gate4 END,
      'gate_is_complete', v_gate1, 'gate_claimed_total', v_gate2,
      'gate_visible_kinds', to_jsonb(p_visible_kinds), 'gate_checksum', v_gate4,
      'gate_nonempty', v_gate5, 'absence_allowed', false, 'absence_count', 0,
      'absence_policy', 'snapshot_replace', 'candidates_written', 0,
      'revoke_events', 0, 'scan_status', v_status, 'reason', v_reason
    );
  END IF;

  SELECT count(*)::int,
         COALESCE(sum(direction), 0)::int,
         count(*) FILTER (WHERE direction = 1)::int,
         count(*) FILTER (WHERE direction = -1)::int,
         count(*) FILTER (WHERE direction = 0)::int,
         decode(md5(COALESCE(string_agg(
           source_row_ordinal::text || ':' || voter_id::text || ':' || direction::text || ':' ||
             COALESCE(source_identity_key, ''), E'\n' ORDER BY source_row_ordinal), '')), 'hex')
    INTO v_old_rows, v_old_rating, v_old_up, v_old_down, v_old_revoked, v_old_hash
    FROM serve.vote_current
   WHERE page_id = p_page;

  -- 同一规范化快照不重新分配事实 seq，也不触碰 current 行：重放 M 次仍是 N 行。
  IF v_old_rows = v_raw AND v_old_hash = v_hash
     AND NOT EXISTS (
       SELECT 1 FROM serve.vote_current
        WHERE page_id = p_page AND source_row_ordinal = 0
     ) THEN
    PERFORM meta.record_page_scan(
      p_run, p_page, 'votes', 'ok', p_claimed_total, v_raw,
      true, p_claimed_rating, v_checksum, v_hash, NULL
    );
    RETURN jsonb_build_object(
      'events', 0, 'snapshot_events', 0, 'snapshot_replaced', false,
      'idempotent_replay', true, 'raw_entries', v_raw, 'current_rows', v_raw,
      'unique_voters', v_uniq, 'unique_voter_rating', v_unique_rating,
      'checksum_actual', v_checksum, 'checksum_expected', p_claimed_rating,
      'checksum_ok', true, 'gate_is_complete', true, 'gate_claimed_total', true,
      'gate_visible_kinds', to_jsonb(p_visible_kinds), 'gate_checksum', true,
      'gate_nonempty', true, 'absence_allowed', true, 'absence_count', 0,
      'absence_policy', 'snapshot_replace', 'candidates_written', 0,
      'revoke_events', 0, 'scan_status', 'ok', 'reason', NULL
    );
  END IF;

  CREATE TEMP TABLE IF NOT EXISTS vote_snapshot_old_meta (
    voter_id int PRIMARY KEY,
    direction smallint,
    first_voted_at timestamptz,
    last_voted_at timestamptz,
    last_precision text
  ) ON COMMIT DROP;
  TRUNCATE vote_snapshot_old_meta;
  INSERT INTO vote_snapshot_old_meta
  SELECT voter_id,
         NULLIF(sign(sum(direction)), 0)::smallint,
         min(first_voted_at), max(last_voted_at),
         (array_agg(last_precision ORDER BY last_voted_at DESC))[1]
    FROM serve.vote_current
   WHERE page_id = p_page
   GROUP BY voter_id;

  CREATE TEMP TABLE IF NOT EXISTS vote_snapshot_transition (
    voter_id int PRIMARY KEY,
    old_direction smallint,
    new_direction smallint
  ) ON COMMIT DROP;
  TRUNCATE vote_snapshot_transition;
  INSERT INTO vote_snapshot_transition(voter_id, old_direction, new_direction)
  WITH new_fold AS (
    SELECT voter_id, NULLIF(sign(sum(direction)), 0)::smallint AS direction
      FROM vote_snapshot_input GROUP BY voter_id
  ), all_voters AS (
    SELECT voter_id FROM vote_snapshot_old_meta
    UNION
    SELECT voter_id FROM new_fold
  )
  SELECT a.voter_id, o.direction, n.direction
    FROM all_voters a
    LEFT JOIN vote_snapshot_old_meta o USING (voter_id)
    LEFT JOIN new_fold n USING (voter_id)
   WHERE o.direction IS DISTINCT FROM n.direction;

  SELECT COALESCE(sum(COALESCE(new_direction, 0) - COALESCE(old_direction, 0)), 0)::int,
         (COALESCE(sum((new_direction = 1)::int), 0) - COALESCE(sum((old_direction = 1)::int), 0))::int,
         (COALESCE(sum((new_direction = -1)::int), 0) - COALESCE(sum((old_direction = -1)::int), 0))::int,
         count(*) FILTER (WHERE new_direction IS NULL)::int
    INTO v_event_rating_delta, v_event_up_delta, v_event_down_delta, v_revoke_events
    FROM vote_snapshot_transition;

  SELECT count(*)::int INTO v_absent
    FROM vote_snapshot_old_meta o
   WHERE o.direction IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM vote_snapshot_input n WHERE n.voter_id = o.voter_id);

  INSERT INTO ingest.vote_event(
    page_id, voter_id, kind, old_direction, new_direction,
    occurred_at, observed_at, time_precision, source, run_id
  )
  SELECT p_page, voter_id,
         CASE WHEN new_direction IS NULL THEN 'revoke'
              WHEN old_direction IS NULL THEN 'vote' ELSE 'revote' END,
         old_direction, new_direction,
         p_observed, p_observed, 'observed', p_source, p_run
    FROM vote_snapshot_transition
   ORDER BY voter_id;
  GET DIAGNOSTICS v_events = ROW_COUNT;

  INSERT INTO ingest.vote_snapshot_event(
    page_id, observed_at, source, run_id, snapshot_hash,
    row_count, rating, unique_voter_count, unique_voter_rating,
    rating_delta, up_delta, down_delta, affected_voter_ids
  )
  SELECT p_page, p_observed, p_source, p_run, v_hash,
         v_raw, v_checksum, v_uniq, v_unique_rating,
         (v_checksum - v_old_rating) - v_event_rating_delta,
         ((SELECT count(*) FROM vote_snapshot_input WHERE direction = 1) - v_old_up) - v_event_up_delta,
         ((SELECT count(*) FROM vote_snapshot_input WHERE direction = -1) - v_old_down) - v_event_down_delta,
         COALESCE(array_agg(voter_id ORDER BY voter_id), '{}'::int[])
    FROM (
      SELECT voter_id FROM vote_snapshot_old_meta
      UNION
      SELECT voter_id FROM vote_snapshot_input
    ) affected
  RETURNING seq INTO v_marker_seq;

  -- DELETE + INSERT 与 page_current 发布同属当前函数事务；读者看不到中间空窗。
  DELETE FROM serve.vote_current WHERE page_id = p_page;
  INSERT INTO serve.vote_current(
    page_id, voter_id, direction, first_voted_at, last_voted_at,
    last_precision, last_seq, source_row_ordinal, source_identity_key,
    snapshot_hash, snapshot_observed_at, snapshot_source
  )
  SELECT p_page, i.voter_id, i.direction,
         COALESCE(o.first_voted_at, p_observed),
         CASE WHEN o.direction IS NOT DISTINCT FROM NULLIF(sign(i.direction), 0)
              THEN COALESCE(o.last_voted_at, p_observed) ELSE p_observed END,
         'observed', v_marker_seq, i.source_row_ordinal, i.identity_key,
         v_hash, p_observed, p_source
    FROM vote_snapshot_input i
    LEFT JOIN vote_snapshot_old_meta o ON o.voter_id = i.voter_id
   ORDER BY i.source_row_ordinal;

  UPDATE serve.page_current
     SET rating = v_checksum,
         vote_up = (SELECT count(*) FROM vote_snapshot_input WHERE direction = 1),
         vote_down = (SELECT count(*) FROM vote_snapshot_input WHERE direction = -1),
         vote_revoked = (SELECT count(*) FROM vote_snapshot_input WHERE direction = 0),
         unique_voter_rating = v_unique_rating,
         unique_voter_count = v_uniq,
         cursor_seq = GREATEST(cursor_seq, v_marker_seq),
         last_complete_vote_snapshot_at = CASE WHEN status = 'live'
           THEN GREATEST(COALESCE(last_complete_vote_snapshot_at, p_observed), p_observed)
           ELSE last_complete_vote_snapshot_at END,
         updated_at = now()
   WHERE page_id = p_page;
  GET DIAGNOSTICS v_page_hit = ROW_COUNT;
  IF v_page_hit = 0 THEN
    RAISE EXCEPTION 'apply_vote_snapshot: serve.page_current 缺 page_id=%', p_page
      USING ERRCODE = '23503';
  END IF;

  DELETE FROM meta.revoke_candidate WHERE page_id = p_page;

  PERFORM meta.record_page_scan(
    p_run, p_page, 'votes', 'ok', p_claimed_total, v_raw,
    true, p_claimed_rating, v_checksum, v_hash, NULL
  );

  RETURN jsonb_build_object(
    'events', v_events, 'snapshot_events', 1, 'snapshot_replaced', true,
    'idempotent_replay', false, 'raw_entries', v_raw, 'current_rows', v_raw,
    'unique_voters', v_uniq, 'unique_voter_rating', v_unique_rating,
    'checksum_actual', v_checksum, 'checksum_expected', p_claimed_rating,
    'checksum_ok', true, 'gate_is_complete', true, 'gate_claimed_total', true,
    'gate_visible_kinds', to_jsonb(p_visible_kinds), 'gate_checksum', true,
    'gate_nonempty', true, 'absence_allowed', true, 'absence_count', v_absent,
    'absence_policy', 'snapshot_replace', 'candidates_written', 0,
    'revoke_events', v_revoke_events, 'scan_status', 'ok', 'reason', NULL,
    'snapshot_seq', v_marker_seq
  );
END;
$function$;

COMMIT;
