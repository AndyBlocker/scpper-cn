-- =====================================================================================
-- 0033_vote_snapshot_multiplicity.sql
-- WhoRated 单次快照保留同一自然账号的多行；成功快照按页原子整体替换。
-- =====================================================================================

\set ON_ERROR_STOP on

DO $guard$
BEGIN
  IF current_database() IN ('scpper-cn', 'scpper_cn', 'scpper-syncer', 'scpper_user') THEN
    RAISE EXCEPTION
      '[0033] 拒绝在受保护库 % 上修改投票模型；目标必须是 scpper-v2',
      current_database()
      USING ERRCODE = '42501';
  END IF;
END
$guard$;

BEGIN;

-- 0 是历史事件/CAS 行的保留 ordinal；WhoRated 原始响应使用 1-based ordinal。
ALTER TABLE serve.vote_current
  ADD COLUMN IF NOT EXISTS source_row_ordinal int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS source_identity_key text,
  ADD COLUMN IF NOT EXISTS snapshot_hash bytea,
  ADD COLUMN IF NOT EXISTS snapshot_observed_at timestamptz,
  ADD COLUMN IF NOT EXISTS snapshot_source text;

DO $pk$
DECLARE v_definition text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO v_definition
    FROM pg_constraint
   WHERE conrelid='serve.vote_current'::regclass
     AND conname='vote_current_pkey';
  IF v_definition IS DISTINCT FROM
       'PRIMARY KEY (page_id, voter_id, source_row_ordinal)' THEN
    ALTER TABLE serve.vote_current DROP CONSTRAINT IF EXISTS vote_current_pkey;
    ALTER TABLE serve.vote_current ADD CONSTRAINT vote_current_pkey
      PRIMARY KEY (page_id, voter_id, source_row_ordinal);
  END IF;
END
$pk$;

ALTER TABLE serve.vote_current
  DROP CONSTRAINT IF EXISTS vote_current_source_row_ordinal_ck;
ALTER TABLE serve.vote_current
  ADD CONSTRAINT vote_current_source_row_ordinal_ck
  CHECK (source_row_ordinal >= 0);

CREATE UNIQUE INDEX IF NOT EXISTS vc_page_source_row
  ON serve.vote_current(page_id, source_row_ordinal)
  WHERE source_row_ordinal > 0;

COMMENT ON TABLE serve.vote_current IS
  'Tier-1 当前投票多重集。WhoRated 成功观测按页事务内整体替换；'
  'source_row_ordinal>0 逐行对应本次数据源响应，0 仅供历史事件/CAS 兼容路径。';
COMMENT ON COLUMN serve.vote_current.source_row_ordinal IS
  'WhoRated 响应中的 1-based 行序号；0 表示迁移前存量或非快照 CAS 行。';
COMMENT ON COLUMN serve.vote_current.source_identity_key IS
  '采集解析层身份键；与 source_row_ordinal/voter_id/direction 一起构成原始行追溯证据。';
COMMENT ON COLUMN serve.vote_current.snapshot_hash IS
  '整页规范化快照哈希；同一页所有 source_row_ordinal>0 行相同。';

ALTER TABLE serve.page_current
  ADD COLUMN IF NOT EXISTS unique_voter_rating int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS unique_voter_count int NOT NULL DEFAULT 0;

ALTER TABLE serve.user_stats
  ADD COLUMN IF NOT EXISTS voted_page_count int NOT NULL DEFAULT 0;

WITH per_voter AS (
  SELECT page_id, voter_id, sign(sum(direction))::int AS direction
    FROM serve.vote_current
   WHERE direction <> 0
   GROUP BY page_id, voter_id
), agg AS (
  SELECT page_id,
         COALESCE(sum(direction), 0)::int AS unique_voter_rating,
         count(*)::int AS unique_voter_count
    FROM per_voter
   GROUP BY page_id
)
UPDATE serve.page_current pc
   SET unique_voter_rating = COALESCE(a.unique_voter_rating, 0),
       unique_voter_count = COALESCE(a.unique_voter_count, 0)
  FROM (SELECT p.page_id,
               COALESCE(a.unique_voter_rating, 0) AS unique_voter_rating,
               COALESCE(a.unique_voter_count, 0) AS unique_voter_count
          FROM serve.page_current p
          LEFT JOIN agg a ON a.page_id = p.page_id) a
 WHERE pc.page_id = a.page_id
   AND (pc.unique_voter_rating, pc.unique_voter_count)
       IS DISTINCT FROM (a.unique_voter_rating, a.unique_voter_count);

COMMENT ON COLUMN serve.page_current.rating IS
  '页面所有当前投票行的 Σsign；保留同一投票人的数据源多重性，与 Wikidot 展示分一致。';
COMMENT ON COLUMN serve.page_current.unique_voter_rating IS
  '先按 voter 汇总并 sign，再跨 voter 求和；同向重复只计一次，正负相抵计 0。';
COMMENT ON COLUMN serve.page_current.unique_voter_count IS
  '当前至少有一条非零投票行的不同 voter 数；同一 voter 的正负相抵仍计一个独立读者。';
COMMENT ON COLUMN serve.user_stats.voted_page_count IS
  '该用户当前至少投过一行非零票的不同 page_id 数；与按来源行计的 votes_cast_up/down 分账。';

-- snapshot marker 只记录“行多重性相对自然账号事件流的补差”。普通无重复页补差恒为 0，
-- 但 marker 仍负责让当前态 projector 看见一次原子替换（尤其是只改变重复行数量时）。
CREATE TABLE IF NOT EXISTS ingest.vote_snapshot_event (
  seq                 bigint PRIMARY KEY DEFAULT nextval('ingest.fact_seq'),
  page_id             int NOT NULL REFERENCES ingest.page(id),
  observed_at         timestamptz NOT NULL,
  source              text NOT NULL,
  run_id              bigint,
  snapshot_hash       bytea NOT NULL,
  row_count           int NOT NULL CHECK (row_count >= 0),
  rating              int NOT NULL,
  unique_voter_count  int NOT NULL CHECK (unique_voter_count >= 0),
  unique_voter_rating int NOT NULL,
  rating_delta        int NOT NULL,
  up_delta            int NOT NULL,
  down_delta          int NOT NULL,
  affected_voter_ids  int[] NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS vse_page_seq ON ingest.vote_snapshot_event(page_id, seq);
CREATE INDEX IF NOT EXISTS vse_run ON ingest.vote_snapshot_event(run_id) WHERE run_id IS NOT NULL;

COMMENT ON TABLE ingest.vote_snapshot_event IS
  'WhoRated 成功快照替换 marker（append-only）。rating/up/down_delta 只保存相对 '
  'ingest.vote_event 自然账号转移的多重性补差；两类事实合并后恰等于页面行口径变化。';

-- rebuild_from 字符串同时是 projector 的运行时契约；注释与登记必须同事务更新。
COMMENT ON TABLE serve.page_stats IS
  'rebuild_from=serve.vote_current + ingest.vote_event + ingest.vote_snapshot_event';
COMMENT ON TABLE serve.vote_daily IS
  'rebuild_from=ingest.vote_event + ingest.vote_snapshot_event';
COMMENT ON TABLE serve.user_attr_daily IS
  'rebuild_from=(ingest.vote_event + ingest.vote_snapshot_event) ⋈ serve.attribution_current';
COMMENT ON TABLE serve.user_vote_interaction IS
  'rebuild_from=serve.vote_current ⋈ serve.attribution_current + ingest.vote_snapshot_event affected_voters';
COMMENT ON TABLE serve.user_tag_preference IS
  'rebuild_from=serve.vote_current ⋈ serve.page_current.tags + ingest.vote_snapshot_event affected_voters';
COMMENT ON TABLE serve.page_daily_stats IS
  'rebuild_from=ingest.vote_event + ingest.vote_snapshot_event + ingest.revision;views rebuild_from=NONE';

UPDATE meta.projection_cursor c
   SET rebuild_from = obj_description(c.projection::regclass, 'pg_class'),
       updated_at = now()
 WHERE c.projection IN (
   'serve.page_stats','serve.vote_daily','serve.user_attr_daily',
   'serve.user_vote_interaction','serve.user_tag_preference','serve.page_daily_stats'
 );

DROP TRIGGER IF EXISTS trg_immutable ON ingest.vote_snapshot_event;
CREATE TRIGGER trg_immutable
  BEFORE UPDATE OR DELETE ON ingest.vote_snapshot_event
  FOR EACH ROW EXECUTE FUNCTION ingest.fn_fact_immutable();
DROP TRIGGER IF EXISTS trg_no_truncate ON ingest.vote_snapshot_event;
CREATE TRIGGER trg_no_truncate
  BEFORE TRUNCATE ON ingest.vote_snapshot_event
  FOR EACH STATEMENT EXECUTE FUNCTION ingest.fn_no_truncate();

-- =====================================================================================
-- 当前快照协议：门控全过才整体替换；未过门控时零 current 写入。
-- =====================================================================================
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
AS $$
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
$$;

COMMENT ON FUNCTION ingest.apply_vote_snapshot(int, jsonb, boolean, int, int, text[], timestamptz, text, bigint, int, text, int, real) IS
  'WhoRated 页级多重集协议。claimed_total 对原始行数、claimed_rating 对全部行 Σsign；'
  '门控全过后在同一事务中整体替换 vote_current。重复重放按规范化快照哈希短路，'
  '多重性只能来自单次数据源快照，不能由跨轮累积产生。';

-- =====================================================================================
-- 事件/CAS 兼容入口：一次自然账号观测会把该 voter 的来源多行收敛为 ordinal=0。
-- WhoRated 不走这里；它只走上面的页级 snapshot replace。
-- =====================================================================================
CREATE OR REPLACE FUNCTION ingest.apply_vote_observation(
  p_page int, p_voter int, p_direction int,
  p_occurred timestamptz, p_observed timestamptz,
  p_precision text, p_source text, p_run bigint,
  p_wikidot_id int DEFAULT NULL
) RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  cur smallint;
  tgt smallint;
  ev bigint;
  v_dir smallint;
  v_old_first timestamptz;
  v_curprec text;
  v_hit int;
BEGIN
  PERFORM meta.assert_writes_allowed('vote');
  PERFORM meta.ingest_gate_open();
  PERFORM ingest.assert_page_identity(p_page, p_wikidot_id);
  PERFORM pg_advisory_xact_lock(meta.lock_class_page(), p_page);

  v_dir := ingest.norm_direction(
    p_direction, p_page, p_voter::text,
    jsonb_build_object('voter_id', p_voter, 'direction', p_direction),
    p_source, p_occurred
  );
  SELECT NULLIF(sign(sum(direction)), 0)::smallint,
         min(first_voted_at),
         (array_agg(last_precision ORDER BY last_voted_at DESC))[1]
    INTO cur, v_old_first, v_curprec
    FROM serve.vote_current
   WHERE page_id = p_page AND voter_id = p_voter;
  tgt := NULLIF(v_dir, 0);

  IF cur IS NOT DISTINCT FROM tgt THEN
    IF v_curprec IS NOT NULL
       AND ingest.precision_rank(p_precision) > ingest.precision_rank(v_curprec) THEN
      UPDATE serve.vote_current
         SET last_voted_at = COALESCE(p_occurred, p_observed),
             last_precision = p_precision
       WHERE page_id = p_page AND voter_id = p_voter;
    END IF;
    RETURN NULL;
  END IF;

  INSERT INTO ingest.vote_event(
    page_id,voter_id,kind,old_direction,new_direction,
    occurred_at,observed_at,time_precision,source,run_id
  ) VALUES (
    p_page,p_voter,
    CASE WHEN tgt IS NULL THEN 'revoke'
         WHEN cur IS NULL THEN 'vote' ELSE 'revote' END,
    cur,tgt,p_occurred,p_observed,p_precision,p_source,p_run
  ) RETURNING seq INTO ev;

  DELETE FROM serve.vote_current
   WHERE page_id = p_page AND voter_id = p_voter;
  INSERT INTO serve.vote_current(
    page_id,voter_id,direction,first_voted_at,last_voted_at,
    last_precision,last_seq,source_row_ordinal,snapshot_source
  ) VALUES (
    p_page,p_voter,COALESCE(tgt,0),
    COALESCE(v_old_first,p_occurred,p_observed),COALESCE(p_occurred,p_observed),
    p_precision,ev,0,p_source
  );

  WITH agg AS (
    SELECT COALESCE(sum(direction),0)::int AS rating,
           count(*) FILTER (WHERE direction=1)::int AS up,
           count(*) FILTER (WHERE direction=-1)::int AS down,
           count(*) FILTER (WHERE direction=0)::int AS revoked
      FROM serve.vote_current WHERE page_id=p_page
  ), uniq AS (
    SELECT COALESCE(sum(sign(net)),0)::int AS rating,
           count(*) FILTER (WHERE has_active)::int AS n
      FROM (
        SELECT voter_id,sum(direction)::int AS net,
               bool_or(direction<>0) AS has_active
          FROM serve.vote_current WHERE page_id=p_page GROUP BY voter_id
      ) u
  )
  UPDATE serve.page_current pc
     SET rating=a.rating,vote_up=a.up,vote_down=a.down,vote_revoked=a.revoked,
         unique_voter_rating=u.rating,unique_voter_count=u.n,
         cursor_seq=GREATEST(pc.cursor_seq,ev),updated_at=now()
    FROM agg a CROSS JOIN uniq u
   WHERE pc.page_id=p_page;
  GET DIAGNOSTICS v_hit = ROW_COUNT;
  IF v_hit=0 THEN
    RAISE EXCEPTION 'apply_vote_observation: serve.page_current 缺 page_id=%',p_page
      USING ERRCODE='23503';
  END IF;
  RETURN ev;
END;
$$;

CREATE OR REPLACE FUNCTION ingest.apply_vote_cas_batch(
  p_page int, p_targets jsonb, p_observed timestamptz,
  p_source text, p_run bigint DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  r record;
  v_raw int;
  v_uniq int;
  v_events int := 0;
  v_ev bigint;
  v_before record;
  v_after record;
BEGIN
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
$$;

COMMENT ON FUNCTION ingest.apply_vote_observation(int,int,int,timestamptz,timestamptz,text,text,bigint,int) IS
  '非 WhoRated 的单账号 CAS；若目标 voter 当前有来源多行，本观测会收敛为 ordinal=0 单行。';
COMMENT ON FUNCTION ingest.apply_vote_cas_batch(int,jsonb,timestamptz,text,bigint) IS
  '非 WhoRated 的兼容批量 CAS；逐 voter 调用规范单账号状态机，重复 voter 仍硬失败。';

-- 新对象沿用现有权限边界；函数是 SECURITY DEFINER，采集角色不直写事实/当前态。
REVOKE ALL ON ingest.vote_snapshot_event FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION ingest.apply_vote_snapshot(int, jsonb, boolean, int, int, text[], timestamptz, text, bigint, int, text, int, real) FROM PUBLIC;

DO $roles$
BEGIN
  IF to_regrole('bff_role') IS NOT NULL THEN
    GRANT SELECT ON serve.vote_current TO bff_role;
  END IF;
  IF to_regrole('ingestor_role') IS NOT NULL THEN
    GRANT SELECT ON serve.vote_current TO ingestor_role;
    GRANT EXECUTE ON FUNCTION ingest.apply_vote_snapshot(int, jsonb, boolean, int, int, text[], timestamptz, text, bigint, int, text, int, real) TO ingestor_role;
  END IF;
  IF to_regrole('projector_role') IS NOT NULL THEN
    GRANT SELECT ON ingest.vote_snapshot_event TO projector_role;
    GRANT SELECT ON serve.vote_current TO projector_role;
  END IF;
  IF to_regrole('migration_role') IS NOT NULL THEN
    GRANT SELECT, INSERT ON ingest.vote_snapshot_event TO migration_role;
  END IF;
END
$roles$;

COMMIT;
