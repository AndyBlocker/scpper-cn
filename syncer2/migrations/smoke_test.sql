-- =====================================================================================
-- smoke_test.sql —— scpper-v2 迁移后的冒烟验证(可重复执行,结束 ROLLBACK 不留数据)
-- =====================================================================================
-- 目的:plpgsql 函数体内的 SQL 是**首次执行时**才解析的,CREATE FUNCTION 成功不代表函数
--       能跑。本文件用真实数据把写路径逐条走通,把「建得出来」升级为「跑得对」。
--
-- 用法:
--   ./apply.sh --database-url <url> --smoke
--   或  psql <url> -v ON_ERROR_STOP=1 -f smoke_test.sql
--
-- 结构:整个文件包在一个事务里,最后 ROLLBACK —— 跑完库里没有任何测试数据残留。
--   断言用 pg_temp.chk(节, 用例, 条件, 说明) 记录;任何 false 会在最后一段
--   RAISE EXCEPTION,于是 psql 以非零退出(可直接进 CI)。
--   需要「必须抛错」的用例统一用 pg_temp.expect_error(sql, 期望 sqlstate) 捕获。
--
-- 覆盖(对应 0006_functions.sql 文件末 T0–T10 自测清单的可执行子集):
--   S1 身份层        register_page / ensure_user(幂等、R12 只补不覆盖、非法入参)
--   S2 CAS 转移矩阵  4 种 cur × 3 种观测 = 12 格逐格断言
--                    ★ 含 cur=NULL ∧ direction=0 的幻影 revoke 回归(T1 / 54 万条 removed 的原型)
--                    ★ 含 T1.b「新票不得把 vote_revoked 变成 NULL」回归
--   S3 快照四重门控  checksum 不符 / 未提供 rating / 空快照 / is_complete=false /
--                    claimed_total 不符 ⇒ 一律禁止 absence;全过 ⇒ 只产候选不产事实
--   S4 不可变触发器  UPDATE/DELETE/TRUNCATE(含单分区)/ revision 列白名单 / SCD2 / 逃生舱
--   S5 其余 apply_*  page_meta(SCD2 零写入、隐藏标签、selector 残留、改名)/ page_life(门控)
--                    / revision(待补行回填、P0-8、PageSource 全文回填)/ attribution(is_display)
--                    / forum / history
--   S6 游标安全      safe_seq_watermark / projection_window / advance_projection_cursor 钳制
--   S7 全局不变式    I1–I4 / I8 / I9 / I10
-- =====================================================================================

\set ON_ERROR_STOP on
\timing off
\pset pager off

BEGIN;

-- 断言过程本身不产生有用输出(每个 expect_error 都会回一个空行),统一丢掉;
-- NOTICE/WARNING 走 stderr 不受影响,报告段前会 \o 恢复。
\o /dev/null

-- -------------------------------------------------------------------------------------
-- 0. 测试脚手架
-- -------------------------------------------------------------------------------------
CREATE TEMP TABLE smoke_log (
  id      serial PRIMARY KEY,
  section text NOT NULL,
  name    text NOT NULL,
  ok      boolean NOT NULL,
  detail  text
);

-- 固件 id 存表而不是变量:DO 块之间不能共享 plpgsql 变量。
CREATE TEMP TABLE fx (k text PRIMARY KEY, v bigint);

CREATE FUNCTION pg_temp.chk(p_section text, p_name text, p_cond boolean, p_detail text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO smoke_log(section, name, ok, detail)
  VALUES (p_section, p_name, COALESCE(p_cond, false), p_detail);
END $$;

CREATE FUNCTION pg_temp.fxset(p_k text, p_v bigint) RETURNS bigint LANGUAGE sql AS
$$ INSERT INTO fx VALUES (p_k, p_v) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v RETURNING v $$;

CREATE FUNCTION pg_temp.fxget(p_k text) RETURNS bigint LANGUAGE sql STABLE AS
$$ SELECT v FROM fx WHERE k = p_k $$;

-- 「这条语句必须抛错」:在子事务里跑,捕获 sqlstate 后断言。
-- p_sqlstate 为 NULL = 只要求抛错、不校验具体 code。
CREATE FUNCTION pg_temp.expect_error(p_section text, p_name text, p_sql text,
                                     p_sqlstate text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_state text; v_msg text;
BEGIN
  BEGIN
    EXECUTE p_sql;
    PERFORM pg_temp.chk(p_section, p_name, false, '本应抛错但成功执行了');
    RETURN;
  EXCEPTION WHEN OTHERS THEN
    v_state := SQLSTATE; v_msg := SQLERRM;
  END;
  IF p_sqlstate IS NULL THEN
    PERFORM pg_temp.chk(p_section, p_name, true, format('抛错 %s: %s', v_state, left(v_msg, 70)));
  ELSE
    PERFORM pg_temp.chk(p_section, p_name, v_state = p_sqlstate,
                        format('期望 %s,实得 %s: %s', p_sqlstate, v_state, left(v_msg, 70)));
  END IF;
END $$;


-- =====================================================================================
-- S1. 身份层:register_page / ensure_user
-- =====================================================================================
DO $$
DECLARE
  v_run  bigint; v_run_bad bigint;
  p1 int; p1b int; p2 int;
  u1 int; u2 int; u3 int; u4 int; u1b int;
  v_life int; v_slug int; v_pc int;
  v_username text; v_unix text; v_display text;
BEGIN
  -- run:coverage_ratio = 36000/36173 = 0.995 ≥ 0.98 ⇒ 有权做删除/absence 推断
  INSERT INTO meta.ingest_run(source, status, pages_enumerated, remote_total,
                              remote_total_source, batches_total, batches_failed)
  VALUES ('wikidot_listpages', 'ok', 36000, 36173, 'listpages_total', 145, 0)
  RETURNING id INTO v_run;
  PERFORM pg_temp.fxset('run', v_run);

  -- 一个「不够格」的 run:status=failed ⇒ 任何删除推断都必须被拒
  INSERT INTO meta.ingest_run(source, status, pages_enumerated, remote_total)
  VALUES ('wikidot_listpages', 'failed', 1000, 36173) RETURNING id INTO v_run_bad;
  PERFORM pg_temp.fxset('run_bad', v_run_bad);

  PERFORM pg_temp.chk('S1', 'ingest_run.coverage_ratio 生成列',
    (SELECT round(coverage_ratio::numeric, 4) FROM meta.ingest_run WHERE id = v_run) = 0.9952,
    (SELECT coverage_ratio::text FROM meta.ingest_run WHERE id = v_run));

  -- ---- 2 个页面 ----
  p1 := ingest.register_page(990001, 'scp-cn-9901', timestamptz '2026-07-01 10:00+08',
                             'wikidot', NULL, timestamptz '2020-03-01 08:00+08', v_run);
  p2 := ingest.register_page(990002, 'scp-cn-9902', timestamptz '2026-07-01 10:00+08',
                             'wikidot', NULL, NULL, v_run);
  PERFORM pg_temp.fxset('p1', p1);
  PERFORM pg_temp.fxset('p2', p2);
  PERFORM pg_temp.chk('S1', 'register_page 返回不同 page_id', p1 <> p2, format('p1=%s p2=%s', p1, p2));

  -- 幂等:同 wikidot_id 再来一次
  p1b := ingest.register_page(990001, 'scp-cn-9901', timestamptz '2026-07-01 11:00+08', 'wikidot');
  PERFORM pg_temp.chk('S1', 'register_page 幂等(同 wid ⇒ 同 page_id)', p1b = p1);

  SELECT count(*) INTO v_life FROM ingest.page_life_event WHERE page_id = p1 AND kind = 'created';
  PERFORM pg_temp.chk('S1', 'register_page 幂等不重复产 created 事件', v_life = 1, format('%s 条', v_life));

  SELECT count(*) INTO v_slug FROM ingest.page_slug_history WHERE page_id = p1 AND valid_to IS NULL;
  PERFORM pg_temp.chk('S1', 'page_slug_history 恰一条开区间', v_slug = 1);

  SELECT count(*) INTO v_pc FROM serve.page_current
   WHERE page_id = p1 AND status = 'live' AND slug = 'scp-cn-9901'
     AND first_published_at = timestamptz '2020-03-01 08:00+08';
  PERFORM pg_temp.chk('S1', 'register_page 同事务铸 serve.page_current(live)', v_pc = 1);

  PERFORM pg_temp.chk('S1', 'created 事件 precision:有 created_at ⇒ exact',
    (SELECT occurred_precision FROM ingest.page_life_event
      WHERE page_id = p1 AND kind = 'created') = 'exact');
  PERFORM pg_temp.chk('S1', 'created 事件 precision:无 created_at ⇒ inferred',
    (SELECT occurred_precision FROM ingest.page_life_event
      WHERE page_id = p2 AND kind = 'created') = 'inferred');

  -- ---- 3 个用户(任务要求的最小固件)+ 1 个 absence 用的第 4 人 ----
  u1 := ingest.ensure_user('wikidot', 970001, NULL, 'Alpha User',  'alpha_user', 'alpha-real');
  u2 := ingest.ensure_user('wikidot', 970002, NULL, 'Beta User',   'beta_user',  'beta-real');
  u3 := ingest.ensure_user('anon',    NULL, 'anonkey-xyz', 'Anon Voter');
  u4 := ingest.ensure_user('wikidot', 970004, NULL, 'Delta User',  'delta_user');
  PERFORM pg_temp.fxset('u1', u1); PERFORM pg_temp.fxset('u2', u2);
  PERFORM pg_temp.fxset('u3', u3); PERFORM pg_temp.fxset('u4', u4);
  PERFORM pg_temp.chk('S1', 'ensure_user 铸 3 个不同身份(wikidot/wikidot/anon)',
    cardinality(ARRAY[u1,u2,u3]) = 3 AND u1 <> u2 AND u2 <> u3 AND u1 <> u3);
  PERFORM pg_temp.chk('S1', 'ensure_user anon 的 kind/anon_key 落对',
    (SELECT kind = 'anon' AND anon_key = 'anonkey-xyz' AND wikidot_id IS NULL
       FROM ingest."user" WHERE id = u3));

  -- 幂等 + R12:username 只补不覆盖、unix_name 另存、display_name 可更新
  u1b := ingest.ensure_user('wikidot', 970001, NULL, 'Alpha Renamed', 'SHOULD_NOT_WIN', 'alpha-real-2');
  SELECT username, wikidot_unix_name, display_name INTO v_username, v_unix, v_display
    FROM ingest."user" WHERE id = u1;
  PERFORM pg_temp.chk('S1', 'ensure_user 幂等(同 wid ⇒ 同 id)', u1b = u1);
  PERFORM pg_temp.chk('S1', 'R12:username 只补不覆盖', v_username = 'alpha_user', v_username);
  PERFORM pg_temp.chk('S1', 'R12:真实 unixName 落 wikidot_unix_name', v_unix = 'alpha-real-2', v_unix);
  PERFORM pg_temp.chk('S1', 'display_name 可更新', v_display = 'Alpha Renamed', v_display);

  -- guest:允许由 display_name 派生 key(同名合并,文档化限制)
  -- ⚠ 必须先把 ensure_user 的结果落进变量再 SELECT:volatile 函数在**同一条查询里**
  --   插入的行,对该查询的其它部分不可见(查询快照早于插入)。写成
  --   `SELECT ... WHERE id = ingest.ensure_user(...)` 会稳定地查不到行。
  u4 := ingest.ensure_user('guest', NULL, NULL, 'Guest Zhang');
  PERFORM pg_temp.chk('S1', 'guest 的 anon_key 由 display_name 派生',
    (SELECT anon_key FROM ingest."user" WHERE id = u4) = 'guest:Guest Zhang',
    (SELECT anon_key FROM ingest."user" WHERE id = u4));
  -- u4 变量已被复用,重新取回 absence 测试要用的那个 delta_user
  PERFORM pg_temp.fxset('u_guest', u4);
END $$;

-- 非法入参必须抛错
SELECT pg_temp.expect_error('S1', 'ensure_user: anon 无 anon_key ⇒ 拒(取舍 #14)',
  $$ SELECT ingest.ensure_user('anon', NULL, NULL, 'No Key Anon') $$, '22004');
SELECT pg_temp.expect_error('S1', 'ensure_user: kind=wikidot 且 wid<=0 ⇒ 拒',
  $$ SELECT ingest.ensure_user('wikidot', 0, NULL, 'Bad') $$, '22004');
SELECT pg_temp.expect_error('S1', 'ensure_user: 非法 kind ⇒ 拒',
  $$ SELECT ingest.ensure_user('robot', 1) $$, '22023');
SELECT pg_temp.expect_error('S1', 'register_page: 无 wikidot_id ⇒ 拒',
  $$ SELECT ingest.register_page(NULL, 'x') $$, '22004');
SELECT pg_temp.expect_error('S1', 'register_page: 无 slug ⇒ 拒',
  $$ SELECT ingest.register_page(999999, '') $$, '22004');
SELECT pg_temp.expect_error('S1', 'assert_page_identity: wikidot_id 回显不一致 ⇒ 拒绝应用',
  $$ SELECT ingest.apply_page_meta((SELECT v FROM fx WHERE k='p1')::int, '{"title":"x"}'::jsonb,
                                   now(), 'wikidot', NULL, 111222) $$, '22000');
SELECT pg_temp.expect_error('S1', 'assert_page_identity: 未注册 page_id ⇒ 拒',
  $$ SELECT ingest.apply_vote_observation(-424242, (SELECT v FROM fx WHERE k='u1')::int, 1,
                                          now(), now(), 'observed', 'wikidot', NULL) $$, '23503');


-- =====================================================================================
-- S2. CAS 3×3 转移矩阵(apply_vote_observation)—— §5.2 的规范定义
-- =====================================================================================
-- 12 格 = cur ∈ {无行, 0, +1, -1} × obs ∈ {0, +1, -1}。
-- 每格用一个独立 voter,避免相互污染;逐格断言返回值 / 事件 / vote_current / page_current 增量。
DO $$
DECLARE
  pm  int;
  cell record;
  v_voter int;
  v_seq bigint;
  r0 int; u0 int; d0 int; k0 int;   -- page_current 四列(before)
  r1 int; u1_ int; d1 int; k1 int;  -- (after)
  v_evn int; v_kind text; v_old smallint; v_new smallint; v_dir smallint;
  v_has_row boolean;
  v_label text;
  v_ok boolean;
BEGIN
  pm := pg_temp.fxget('p2')::int;   -- 矩阵专用页,与 S3 的 p1 隔离

  FOR cell IN
    SELECT * FROM (VALUES
      -- cur_state, obs, 期望 kind(NULL=无事件), 期望 dir(NULL=无 vote_current 行),
      -- Δrating, Δup, Δdown, Δrevoked
      ('none', 0,  NULL,     NULL,        0,  0,  0,  0),
      ('none', 1,  'vote',   '1',         1,  1,  0,  0),
      ('none',-1,  'vote',   '-1',       -1,  0,  1,  0),
      ('zero', 0,  NULL,     '0',         0,  0,  0,  0),
      ('zero', 1,  'vote',   '1',         1,  1,  0, -1),
      ('zero',-1,  'vote',   '-1',       -1,  0,  1, -1),
      ('up',   0,  'revoke', '0',        -1, -1,  0,  1),
      ('up',   1,  NULL,     '1',         0,  0,  0,  0),
      ('up',  -1,  'revote', '-1',       -2, -1,  1,  0),
      ('down', 0,  'revoke', '0',         1,  0, -1,  1),
      ('down', 1,  'revote', '1',         2,  1, -1,  0),
      ('down',-1,  NULL,     '-1',        0,  0,  0,  0)
    ) AS t(cur_state, obs, exp_kind, exp_dir, d_rating, d_up, d_down, d_revoked)
  LOOP
    v_label := format('cur=%s obs=%s', cell.cur_state, cell.obs);

    -- 每格一个新 voter
    v_voter := ingest.ensure_user('wikidot', 980000 + (SELECT count(*)::int FROM ingest."user"),
                                  NULL, 'Matrix ' || v_label);

    -- ---- 预置 cur 状态 ----
    IF cell.cur_state = 'zero' THEN
      PERFORM ingest.apply_vote_observation(pm, v_voter,  1, now(), now(), 'observed', 'wikidot', NULL);
      PERFORM ingest.apply_vote_observation(pm, v_voter,  0, now(), now(), 'observed', 'wikidot', NULL);
    ELSIF cell.cur_state = 'up' THEN
      PERFORM ingest.apply_vote_observation(pm, v_voter,  1, now(), now(), 'observed', 'wikidot', NULL);
    ELSIF cell.cur_state = 'down' THEN
      PERFORM ingest.apply_vote_observation(pm, v_voter, -1, now(), now(), 'observed', 'wikidot', NULL);
    END IF;

    SELECT rating, vote_up, vote_down, vote_revoked INTO r0, u0, d0, k0
      FROM serve.page_current WHERE page_id = pm;
    SELECT count(*)::int INTO v_evn FROM ingest.vote_event WHERE page_id = pm AND voter_id = v_voter;

    -- ---- 施加被测观测 ----
    v_seq := ingest.apply_vote_observation(pm, v_voter, cell.obs,
                                           now(), now(), 'observed', 'wikidot', pg_temp.fxget('run'));

    SELECT rating, vote_up, vote_down, vote_revoked INTO r1, u1_, d1, k1
      FROM serve.page_current WHERE page_id = pm;

    -- ---- 断言 1:返回值 NULL 性 ⇔ 是否应有事件 ----
    PERFORM pg_temp.chk('S2', v_label || ' → 返回值',
      (cell.exp_kind IS NULL) = (v_seq IS NULL),
      format('exp_kind=%s seq=%s', COALESCE(cell.exp_kind,'∅'), COALESCE(v_seq::text,'NULL')));

    -- ---- 断言 2:事件条数与内容 ----
    IF cell.exp_kind IS NULL THEN
      PERFORM pg_temp.chk('S2', v_label || ' → 不产生事件',
        (SELECT count(*)::int FROM ingest.vote_event
          WHERE page_id = pm AND voter_id = v_voter) = v_evn);
    ELSE
      SELECT kind, old_direction, new_direction INTO v_kind, v_old, v_new
        FROM ingest.vote_event WHERE seq = v_seq;
      PERFORM pg_temp.chk('S2', v_label || ' → kind=' || cell.exp_kind,
        v_kind = cell.exp_kind, format('实得 %s', v_kind));
      -- vote: old IS NULL;revoke: new IS NULL;revote: 两者都非空且不等
      v_ok := CASE cell.exp_kind
                WHEN 'vote'   THEN v_old IS NULL AND v_new IS NOT NULL
                WHEN 'revoke' THEN v_old IS NOT NULL AND v_new IS NULL
                ELSE v_old IS NOT NULL AND v_new IS NOT NULL AND v_old <> v_new
              END;
      PERFORM pg_temp.chk('S2', v_label || ' → (old,new) 组合合法',
        v_ok, format('old=%s new=%s', v_old, v_new));
    END IF;

    -- ---- 断言 3:vote_current 终态 ----
    SELECT EXISTS (SELECT 1 FROM serve.vote_current WHERE page_id = pm AND voter_id = v_voter)
      INTO v_has_row;
    IF cell.exp_dir IS NULL THEN
      PERFORM pg_temp.chk('S2', v_label || ' → 不产生 vote_current 行', NOT v_has_row);
    ELSE
      SELECT direction INTO v_dir FROM serve.vote_current WHERE page_id = pm AND voter_id = v_voter;
      PERFORM pg_temp.chk('S2', v_label || ' → vote_current.direction=' || cell.exp_dir,
        v_has_row AND v_dir = cell.exp_dir::smallint, format('实得 %s', v_dir));
    END IF;

    -- ---- 断言 4:page_current 四列增量 ----
    PERFORM pg_temp.chk('S2', v_label || ' → page_current 增量 (Δr,Δup,Δdn,Δrev)',
      (r1-r0, u1_-u0, d1-d0, k1-k0) = (cell.d_rating, cell.d_up, cell.d_down, cell.d_revoked),
      format('期望 (%s,%s,%s,%s) 实得 (%s,%s,%s,%s)',
             cell.d_rating, cell.d_up, cell.d_down, cell.d_revoked,
             r1-r0, u1_-u0, d1-d0, k1-k0));

    -- ---- 断言 5:vote_revoked 永远不为 NULL(T1.b 逐字例外 2 的回归)----
    PERFORM pg_temp.chk('S2', v_label || ' → vote_revoked NOT NULL', k1 IS NOT NULL);
  END LOOP;
END $$;

-- ★★★ 幻影 revoke 专项回归:cur=NULL ∧ direction=0 —— syncer v1 那 54 万条 removed 的原型。
-- 守卫若写成 `cur IS DISTINCT FROM tgt` 或分别判 NULL,这里就会造出一个 revoke 事件。
DO $$
DECLARE
  pg_ int; vg int; v_seq bigint;
  n_ev_before int; n_ev_after int; n_vc int; n_all_before int; n_all_after int;
BEGIN
  pg_ := pg_temp.fxget('p1')::int;
  vg  := ingest.ensure_user('wikidot', 979999, NULL, 'Phantom Probe');

  SELECT count(*)::int INTO n_all_before FROM ingest.vote_event;
  SELECT count(*)::int INTO n_ev_before  FROM ingest.vote_event WHERE page_id = pg_ AND voter_id = vg;

  v_seq := ingest.apply_vote_observation(pg_, vg, 0, now(), now(), 'observed', 'wikidot',
                                         pg_temp.fxget('run'));

  SELECT count(*)::int INTO n_all_after FROM ingest.vote_event;
  SELECT count(*)::int INTO n_ev_after  FROM ingest.vote_event WHERE page_id = pg_ AND voter_id = vg;
  SELECT count(*)::int INTO n_vc FROM serve.vote_current WHERE page_id = pg_ AND voter_id = vg;

  PERFORM pg_temp.chk('S2★', '幻影 revoke:cur=NULL ∧ dir=0 ⇒ 返回 NULL', v_seq IS NULL);
  PERFORM pg_temp.chk('S2★', '幻影 revoke:该 (page,voter) 零事件', n_ev_after = n_ev_before);
  PERFORM pg_temp.chk('S2★', '幻影 revoke:全库 vote_event 总数不变', n_all_after = n_all_before);
  PERFORM pg_temp.chk('S2★', '幻影 revoke:不产生 vote_current 行', n_vc = 0);
END $$;

-- ±2 归一化 + quarantine 留痕(T2)
DO $$
DECLARE p_ int; v int; v_seq bigint; v_q int; v_new smallint;
BEGIN
  p_ := pg_temp.fxget('p2')::int;
  v  := ingest.ensure_user('wikidot', 978888, NULL, 'Plus Two');
  SELECT count(*)::int INTO v_q FROM meta.vote_quarantine;

  v_seq := ingest.apply_vote_observation(p_, v, 2, now(), now(), 'observed', 'wikidot',
                                         pg_temp.fxget('run'));
  SELECT new_direction INTO v_new FROM ingest.vote_event WHERE seq = v_seq;
  PERFORM pg_temp.chk('S2', '±2 归一化:direction=2 ⇒ new_direction=1', v_new = 1);
  PERFORM pg_temp.chk('S2', '±2 归一化:原始值进 vote_quarantine',
    (SELECT count(*)::int FROM meta.vote_quarantine) = v_q + 1
    AND EXISTS (SELECT 1 FROM meta.vote_quarantine
                 WHERE page_id = p_ AND reason = 'direction_out_of_range'
                   AND (raw ->> 'direction') = '2'));

  -- 同向 ±2:不转移但**仍然**留痕(脏值证据不因「刚好没转移」而丢失)
  SELECT count(*)::int INTO v_q FROM meta.vote_quarantine;
  PERFORM pg_temp.chk('S2', '±2 同向:无转移',
    ingest.apply_vote_observation(p_, v, 2, now(), now(), 'observed', 'wikidot', NULL) IS NULL);
  PERFORM pg_temp.chk('S2', '±2 同向:仍留 quarantine',
    (SELECT count(*)::int FROM meta.vote_quarantine) = v_q + 1);
END $$;

-- 精度偏序(T1.d + A3 bootstrap rank=0)
DO $$
DECLARE p_ int; v int; v_prec text;
BEGIN
  p_ := pg_temp.fxget('p2')::int;
  v  := ingest.ensure_user('wikidot', 977777, NULL, 'Precision Probe');

  PERFORM ingest.apply_vote_observation(p_, v, 1, timestamptz '2024-01-01 00:00+08',
                                        now(), 'day', 'crom', NULL);
  -- day → observed:精度更优 ⇒ 无事件但 last_precision 前进
  PERFORM pg_temp.chk('S2', '精度改善:day→observed 无事件',
    ingest.apply_vote_observation(p_, v, 1, now(), now(), 'observed', 'wikidot', NULL) IS NULL);
  SELECT last_precision INTO v_prec FROM serve.vote_current WHERE page_id = p_ AND voter_id = v;
  PERFORM pg_temp.chk('S2', '精度改善:last_precision 变 observed', v_prec = 'observed', v_prec);

  -- observed → day:精度更差 ⇒ 不得覆盖
  PERFORM ingest.apply_vote_observation(p_, v, 1, timestamptz '2024-01-01 00:00+08',
                                        now(), 'day', 'crom', NULL);
  SELECT last_precision INTO v_prec FROM serve.vote_current WHERE page_id = p_ AND voter_id = v;
  PERFORM pg_temp.chk('S2', '精度不退化:observed 不被 day 覆盖', v_prec = 'observed', v_prec);

  -- bootstrap rank=0:永远抢不走任何精度
  PERFORM ingest.apply_vote_observation(p_, v, 1, timestamptz '2022-05-25 00:00+08',
                                        now(), 'bootstrap', 'crom', NULL);
  SELECT last_precision INTO v_prec FROM serve.vote_current WHERE page_id = p_ AND voter_id = v;
  PERFORM pg_temp.chk('S2', 'A3:bootstrap(rank=0) 抢不走 observed', v_prec = 'observed', v_prec);

  PERFORM pg_temp.chk('S2', 'A3:precision_rank 偏序 exact>observed>day>clamped>bootstrap',
    ingest.precision_rank('exact')    > ingest.precision_rank('observed')
    AND ingest.precision_rank('observed') > ingest.precision_rank('day')
    AND ingest.precision_rank('day')  > ingest.precision_rank('clamped')
    AND ingest.precision_rank('clamped') > ingest.precision_rank('bootstrap'));
  PERFORM pg_temp.chk('S2', 'A3:derive_vote_precision bootstrap 窗口 [2022-05-14,2022-05-27)',
    ingest.derive_vote_precision(timestamptz '2022-05-25 12:00+08', 'crom') = 'bootstrap'
    AND ingest.derive_vote_precision(timestamptz '2022-04-30 12:00+08', 'crom') = 'clamped'
    AND ingest.derive_vote_precision(timestamptz '2024-01-01 12:00+08', 'crom') = 'day'
    AND ingest.derive_vote_precision(now(), 'wikidot') = 'observed'
    AND ingest.derive_vote_precision(now(), 'legacy') = 'exact');
END $$;


-- =====================================================================================
-- S3. apply_vote_snapshot —— 四重门控 + A2 候选机制
-- =====================================================================================
-- 固件:p1 上 u1=+1 u2=+1 u4=+1(均 kind=wikidot)、u3=-1(kind=anon)
DO $$
DECLARE p_ int; u1 int; u2 int; u3 int; u4 int;
BEGIN
  p_ := pg_temp.fxget('p1')::int;
  u1 := pg_temp.fxget('u1')::int; u2 := pg_temp.fxget('u2')::int;
  u3 := pg_temp.fxget('u3')::int; u4 := pg_temp.fxget('u4')::int;
  PERFORM ingest.apply_vote_observation(p_, u1,  1, now(), now(), 'observed', 'wikidot', NULL);
  PERFORM ingest.apply_vote_observation(p_, u2,  1, now(), now(), 'observed', 'wikidot', NULL);
  PERFORM ingest.apply_vote_observation(p_, u4,  1, now(), now(), 'observed', 'wikidot', NULL);
  PERFORM ingest.apply_vote_observation(p_, u3, -1, now(), now(), 'observed', 'crom',    NULL);
  PERFORM pg_temp.chk('S3', '固件:p1 rating=2 (3 up + 1 down)',
    (SELECT rating = 2 AND vote_up = 3 AND vote_down = 1 FROM serve.page_current WHERE page_id = p_));
END $$;

-- 3.1 门控④ checksum 不符 ⇒ 绝不产生 absence 候选(★ 本次任务点名的用例)
DO $$
DECLARE
  p_ int; u1 int; u2 int; res jsonb; n_cand int; n_ev int;
BEGIN
  p_ := pg_temp.fxget('p1')::int; u1 := pg_temp.fxget('u1')::int; u2 := pg_temp.fxget('u2')::int;
  SELECT count(*)::int INTO n_cand FROM meta.revoke_candidate;
  SELECT count(*)::int INTO n_ev   FROM ingest.vote_event;

  -- entries 给 u1/u2(Σsign=2),但谎报 %%rating%%=99 ⇒ 交叉校验必须判否
  res := ingest.apply_vote_snapshot(
           p_,
           jsonb_build_array(jsonb_build_object('voter_id', u1, 'direction', 1),
                             jsonb_build_object('voter_id', u2, 'direction', 1)),
           true, 2, 99, ARRAY['wikidot'], now(), 'wikidot', pg_temp.fxget('run'), NULL);

  PERFORM pg_temp.chk('S3★', 'gate④ checksum 不符 ⇒ checksum_ok=false',
    (res ->> 'checksum_ok')::boolean = false, res ->> 'reason');
  PERFORM pg_temp.chk('S3★', 'gate④ checksum 不符 ⇒ absence_allowed=false',
    (res ->> 'absence_allowed')::boolean = false);
  PERFORM pg_temp.chk('S3★', 'gate④ checksum 不符 ⇒ revoke_candidate 零新增',
    (SELECT count(*)::int FROM meta.revoke_candidate) = n_cand,
    format('before=%s after=%s', n_cand, (SELECT count(*) FROM meta.revoke_candidate)));
  -- 注意按页限定:S2 的转移矩阵在 p2 上刻意造过 revoke 事件,全库计数会误报
  PERFORM pg_temp.chk('S3★', 'gate④ checksum 不符 ⇒ 本页零 revoke 事件',
    (SELECT count(*)::int FROM ingest.vote_event WHERE page_id = p_ AND kind = 'revoke') = 0);
  PERFORM pg_temp.chk('S3★', 'gate④ 不符 ⇒ scan_status=partial',
    res ->> 'scan_status' = 'partial', res ->> 'scan_status');
  PERFORM pg_temp.chk('S3★', 'gate④ 不符 ⇒ meta.page_scan.checksum_ok=false 留证',
    (SELECT checksum_ok = false AND checksum_expected = 99 AND checksum_actual = 2
       FROM meta.page_scan
      WHERE page_id = p_ AND kind = 'votes' AND run_id = pg_temp.fxget('run')));
  -- 单调 upsert 照做:门控只关 absence,不关「增」
  PERFORM pg_temp.chk('S3★', 'gate④ 不符时 upsert 仍生效(只增不撤)',
    (SELECT count(*)::int FROM serve.vote_current WHERE page_id = p_ AND direction <> 0) = 4);
END $$;

-- 3.2 门控④b 不传 claimed_rating ⇒ checksum 未校验 ⇒ 同样禁止 absence(不留静默后门)
DO $$
DECLARE p_ int; u1 int; res jsonb; n_cand int;
BEGIN
  p_ := pg_temp.fxget('p1')::int; u1 := pg_temp.fxget('u1')::int;
  SELECT count(*)::int INTO n_cand FROM meta.revoke_candidate;
  res := ingest.apply_vote_snapshot(
           p_, jsonb_build_array(jsonb_build_object('voter_id', u1, 'direction', 1)),
           true, 1, NULL, ARRAY['wikidot'], now(), 'wikidot', pg_temp.fxget('run'), NULL);
  PERFORM pg_temp.chk('S3', 'gate④b 未提供 rating ⇒ checksum_ok IS NULL',
    res ->> 'checksum_ok' IS NULL);
  PERFORM pg_temp.chk('S3', 'gate④b 未提供 rating ⇒ absence_allowed=false',
    (res ->> 'absence_allowed')::boolean = false, res ->> 'reason');
  PERFORM pg_temp.chk('S3', 'gate④b ⇒ revoke_candidate 零新增',
    (SELECT count(*)::int FROM meta.revoke_candidate) = n_cand);
END $$;

-- 3.3 红线⑤ 空快照 + claimed_total>0 ⇒ failed(WhoRated 对错误 pageId 返 ok+空列表)
DO $$
DECLARE p_ int; res jsonb; snap_before jsonb;
BEGIN
  p_ := pg_temp.fxget('p1')::int;
  SELECT jsonb_agg(jsonb_build_object('v', voter_id, 'd', direction) ORDER BY voter_id)
    INTO snap_before FROM serve.vote_current WHERE page_id = p_;

  res := ingest.apply_vote_snapshot(p_, '[]'::jsonb, true, 42, 2,
                                    ARRAY['wikidot'], now(), 'wikidot', pg_temp.fxget('run'), NULL);
  PERFORM pg_temp.chk('S3★', 'gate⑤ 空快照+claimed_total=42 ⇒ scan_status=failed',
    res ->> 'scan_status' = 'failed', res ->> 'scan_status');
  PERFORM pg_temp.chk('S3★', 'gate⑤ ⇒ absence_allowed=false',
    (res ->> 'absence_allowed')::boolean = false);
  PERFORM pg_temp.chk('S3★', 'gate⑤ ⇒ vote_current 一票未动',
    (SELECT jsonb_agg(jsonb_build_object('v', voter_id, 'd', direction) ORDER BY voter_id)
       FROM serve.vote_current WHERE page_id = p_) = snap_before);

  -- 空快照 + 完全不给 claimed_total ⇒ 也必须 failed(COALESCE(...,1) 的用意)
  res := ingest.apply_vote_snapshot(p_, '[]'::jsonb, true, NULL, 2,
                                    ARRAY['wikidot'], now(), 'wikidot', pg_temp.fxget('run'), NULL);
  PERFORM pg_temp.chk('S3★', 'gate⑤ 空快照+无 claimed_total ⇒ 仍 failed',
    res ->> 'scan_status' = 'failed', res ->> 'scan_status');
END $$;

-- 3.4 门控① is_complete=false;3.5 门控② claimed_total 不符
DO $$
DECLARE p_ int; u1 int; u2 int; res jsonb; n_cand int;
BEGIN
  p_ := pg_temp.fxget('p1')::int; u1 := pg_temp.fxget('u1')::int; u2 := pg_temp.fxget('u2')::int;
  SELECT count(*)::int INTO n_cand FROM meta.revoke_candidate;

  res := ingest.apply_vote_snapshot(
           p_, jsonb_build_array(jsonb_build_object('voter_id', u1, 'direction', 1),
                                 jsonb_build_object('voter_id', u2, 'direction', 1)),
           false, 2, 2, ARRAY['wikidot'], now(), 'wikidot', pg_temp.fxget('run'), NULL);
  PERFORM pg_temp.chk('S3', 'gate① is_complete=false ⇒ absence_allowed=false',
    (res ->> 'absence_allowed')::boolean = false AND res ->> 'reason' = 'is_complete=false');

  res := ingest.apply_vote_snapshot(
           p_, jsonb_build_array(jsonb_build_object('voter_id', u1, 'direction', 1),
                                 jsonb_build_object('voter_id', u2, 'direction', 1)),
           true, 10, 2, ARRAY['wikidot'], now(), 'wikidot', pg_temp.fxget('run'), NULL);
  PERFORM pg_temp.chk('S3', 'gate② claimed_total 不符 ⇒ absence_allowed=false + partial',
    (res ->> 'absence_allowed')::boolean = false AND res ->> 'scan_status' = 'partial',
    res ->> 'reason');
  PERFORM pg_temp.chk('S3', 'gate①② ⇒ revoke_candidate 零新增',
    (SELECT count(*)::int FROM meta.revoke_candidate) = n_cand);
END $$;

SELECT pg_temp.expect_error('S3', 'gate③ visible_kinds 传空数组 ⇒ 拒(空集会让 diff 打到全部 voter)',
  $$ SELECT ingest.apply_vote_snapshot((SELECT v FROM fx WHERE k='p1')::int, '[]'::jsonb,
                                       true, 1, 1, '{}'::text[]) $$, '22004');
SELECT pg_temp.expect_error('S3', 'apply_vote_snapshot: 非法 absence_policy ⇒ 拒',
  $$ SELECT ingest.apply_vote_snapshot((SELECT v FROM fx WHERE k='p1')::int, '[]'::jsonb,
       true, 1, 1, ARRAY['wikidot'], now(), 'wikidot', NULL, NULL, 'yolo') $$, '22023');

-- 3.6~3.9 四门全过 ⇒ 只产候选不产事实;门控③ 把 anon 排除在 diff 之外
DO $$
DECLARE
  p_ int; u1 int; u2 int; u3 int; u4 int; res jsonb;
  run2 bigint; n_ev int; v_conf int; v_gate jsonb;
BEGIN
  p_ := pg_temp.fxget('p1')::int;
  u1 := pg_temp.fxget('u1')::int; u2 := pg_temp.fxget('u2')::int;
  u3 := pg_temp.fxget('u3')::int; u4 := pg_temp.fxget('u4')::int;
  SELECT count(*)::int INTO n_ev FROM ingest.vote_event;

  -- entries 只含 u1/u2(Σsign=2 = 真 rating 2)⇒ 缺席的 kind=wikidot 只有 u4;
  -- u3 是 anon,被 visible_kinds 挡在 diff 之外
  -- ⚠ 必须显式放宽 p_max_absence_ratio:本固件只有 3 张可见有效票,缺 1 张就是 33%,
  --   默认 20% 的单页熔断会(正确地)先跳闸,把这条用例变成在测熔断而不是在测门控。
  --   熔断本身另有 3.12 专测。
  res := ingest.apply_vote_snapshot(
           p_page => p_,
           p_entries => jsonb_build_array(jsonb_build_object('voter_id', u1, 'direction', 1),
                                          jsonb_build_object('voter_id', u2, 'direction', 1)),
           p_is_complete => true, p_claimed_total => 2, p_claimed_rating => 2,
           p_visible_kinds => ARRAY['wikidot'], p_observed => now(), p_source => 'wikidot',
           p_run => pg_temp.fxget('run'), p_max_absence_ratio => 0.90);

  PERFORM pg_temp.chk('S3', 'gate 全过 ⇒ absence_allowed=true',
    (res ->> 'absence_allowed')::boolean = true, res::text);
  PERFORM pg_temp.chk('S3', 'gate③ anon 不进 absence(absence_count=1 只有 u4)',
    (res ->> 'absence_count')::int = 1);
  PERFORM pg_temp.chk('S3', 'A2:absence 只写候选,不写 vote_event',
    (SELECT count(*)::int FROM ingest.vote_event) = n_ev
    AND (res ->> 'revoke_events')::int = 0);
  PERFORM pg_temp.chk('S3', 'A2:候选落库 confirmations=1 status=pending',
    (SELECT confirmations = 1 AND status = 'pending' AND last_direction = 1
       FROM meta.revoke_candidate WHERE page_id = p_ AND voter_id = u4));
  PERFORM pg_temp.chk('S3', 'A2:u4 的票在 vote_current 里仍是有效票(未被撤)',
    (SELECT direction FROM serve.vote_current WHERE page_id = p_ AND voter_id = u4) = 1);
  PERFORM pg_temp.chk('S3', 'A2:anon(u3) 未成为候选',
    NOT EXISTS (SELECT 1 FROM meta.revoke_candidate WHERE page_id = p_ AND voter_id = u3));
  SELECT gate_result INTO v_gate FROM meta.revoke_candidate WHERE page_id = p_ AND voter_id = u4;
  PERFORM pg_temp.chk('S3', 'A2:gate_result 留痕四重门控逐项结果',
    (v_gate ->> 'is_complete') = 'true' AND (v_gate ->> 'checksum_ok') = 'true'
    AND (v_gate ->> 'sum_sign') = '2' AND (v_gate ->> 'remote_rating') = '2', v_gate::text);

  -- 同 run 重复应用同一份快照 ⇒ confirmations 不累加
  PERFORM ingest.apply_vote_snapshot(
           p_page => p_,
           p_entries => jsonb_build_array(jsonb_build_object('voter_id', u1, 'direction', 1),
                                          jsonb_build_object('voter_id', u2, 'direction', 1)),
           p_is_complete => true, p_claimed_total => 2, p_claimed_rating => 2,
           p_visible_kinds => ARRAY['wikidot'], p_observed => now(), p_source => 'wikidot',
           p_run => pg_temp.fxget('run'), p_max_absence_ratio => 0.90);
  SELECT confirmations INTO v_conf FROM meta.revoke_candidate WHERE page_id = p_ AND voter_id = u4;
  PERFORM pg_temp.chk('S3', 'A2:同 run 重复快照 ⇒ confirmations 仍为 1', v_conf = 1, v_conf::text);

  -- 换 run ⇒ 累加到 2
  INSERT INTO meta.ingest_run(source, status, pages_enumerated, remote_total)
  VALUES ('wikidot_listpages', 'ok', 36000, 36173) RETURNING id INTO run2;
  PERFORM pg_temp.fxset('run2', run2);
  PERFORM ingest.apply_vote_snapshot(
           p_page => p_,
           p_entries => jsonb_build_array(jsonb_build_object('voter_id', u1, 'direction', 1),
                                          jsonb_build_object('voter_id', u2, 'direction', 1)),
           p_is_complete => true, p_claimed_total => 2, p_claimed_rating => 2,
           p_visible_kinds => ARRAY['wikidot'], p_observed => now(), p_source => 'wikidot',
           p_run => run2, p_max_absence_ratio => 0.90);
  SELECT confirmations INTO v_conf FROM meta.revoke_candidate WHERE page_id = p_ AND voter_id = u4;
  PERFORM pg_temp.chk('S3', 'A2:换 run ⇒ confirmations 累加到 2', v_conf = 2, v_conf::text);
END $$;

-- 3.10 promote_revoke_candidates:候选转正为真事件(走 apply_vote_observation,非特权通道)
DO $$
DECLARE p_ int; u4 int; res jsonb; v_dir smallint; v_kind text; v_seq bigint;
BEGIN
  p_ := pg_temp.fxget('p1')::int; u4 := pg_temp.fxget('u4')::int;
  -- 冒烟跑在有真实 pending candidate 的库上；本事务先隔离非 fixture 候选，
  -- 否则全局 promote 会把真实候选也计入 promoted（末尾 ROLLBACK 会完整恢复）。
  UPDATE meta.revoke_candidate
     SET status='held', held_reason='smoke fixture isolation'
   WHERE status='pending' AND page_id<>p_;
  res := ingest.promote_revoke_candidates(2, NULL, interval '30 days', 0.90,
                                          pg_temp.fxget('run2'), 'wikidot_absence');
  PERFORM pg_temp.chk('S3', 'A2 转正:promoted=1', (res ->> 'promoted')::int = 1, res::text);

  SELECT direction INTO v_dir FROM serve.vote_current WHERE page_id = p_ AND voter_id = u4;
  PERFORM pg_temp.chk('S3', 'A2 转正:vote_current.direction=0(撤票终态,行不删)', v_dir = 0);

  SELECT promoted_seq INTO v_seq FROM meta.revoke_candidate WHERE page_id = p_ AND voter_id = u4;
  SELECT kind INTO v_kind FROM ingest.vote_event WHERE seq = v_seq;
  PERFORM pg_temp.chk('S3', 'A2 转正:产生 kind=revoke 事件且回填 promoted_seq', v_kind = 'revoke');
  PERFORM pg_temp.chk('S3', 'A2 转正:候选 status=promoted',
    (SELECT status FROM meta.revoke_candidate WHERE page_id = p_ AND voter_id = u4) = 'promoted');
  PERFORM pg_temp.chk('S3', 'A2 转正:事件 source=wikidot_absence(下游可按此过滤推断撤票)',
    (SELECT source FROM ingest.vote_event WHERE seq = v_seq) = 'wikidot_absence');
  PERFORM pg_temp.chk('S3', 'A2 转正:page_current.vote_revoked 同步 +1',
    (SELECT vote_revoked FROM serve.page_current WHERE page_id = p_) = 1);
END $$;

-- 3.11 「出现即正证据」:候选存在时该 voter 重新出现 ⇒ 候选行立即删除(不看门控)
DO $$
DECLARE p_ int; u2 int; u1 int;
BEGIN
  p_ := pg_temp.fxget('p1')::int; u1 := pg_temp.fxget('u1')::int; u2 := pg_temp.fxget('u2')::int;
  -- 先人为造一条 u2 的 pending 候选
  INSERT INTO meta.revoke_candidate(page_id, voter_id, last_direction, confirmations, source)
  VALUES (p_, u2, 1, 1, 'wikidot')
  ON CONFLICT (page_id, voter_id) DO UPDATE SET status = 'pending', confirmations = 1;
  PERFORM pg_temp.chk('S3', '出现即正证据:前置候选已存在',
    EXISTS (SELECT 1 FROM meta.revoke_candidate WHERE page_id = p_ AND voter_id = u2));

  -- 一份**门控不通过**的快照(谎报 rating)里 u2 出现 ⇒ 候选仍必须被删除
  PERFORM ingest.apply_vote_snapshot(
           p_, jsonb_build_array(jsonb_build_object('voter_id', u1, 'direction', 1),
                                 jsonb_build_object('voter_id', u2, 'direction', 1)),
           true, 2, 12345, ARRAY['wikidot'], now(), 'wikidot', pg_temp.fxget('run2'), NULL);
  PERFORM pg_temp.chk('S3', '出现即正证据:重新出现 ⇒ 候选被删(不看门控)',
    NOT EXISTS (SELECT 1 FROM meta.revoke_candidate WHERE page_id = p_ AND voter_id = u2));
END $$;

-- 3.12 单页 absence 熔断:一次缺席比例过高 ⇒ 禁止 absence 并把 pending 候选扣住(held)
DO $$
DECLARE pb int; res jsonb; i int; v int;
BEGIN
  pb := ingest.register_page(990003, 'scp-cn-9903', now(), 'wikidot', NULL, NULL,
                             pg_temp.fxget('run'));
  PERFORM pg_temp.fxset('p3', pb);
  FOR i IN 1..10 LOOP
    v := ingest.ensure_user('wikidot', 976000 + i, NULL, 'Fuse ' || i);
    PERFORM ingest.apply_vote_observation(pb, v, 1, now(), now(), 'observed', 'wikidot', NULL);
  END LOOP;

  -- entries 只剩 1 人 ⇒ 缺席 9/10 = 90% > 20% 阈值
  res := ingest.apply_vote_snapshot(
           pb, jsonb_build_array(jsonb_build_object(
                 'voter_id', (SELECT voter_id FROM serve.vote_current
                               WHERE page_id = pb ORDER BY voter_id LIMIT 1),
                 'direction', 1)),
           true, 1, 1, ARRAY['wikidot'], now(), 'wikidot', pg_temp.fxget('run'), NULL);
  PERFORM pg_temp.chk('S3', '单页熔断:缺席 90% ⇒ absence_allowed=false',
    (res ->> 'absence_allowed')::boolean = false AND res ->> 'reason' LIKE '%熔断%',
    res ->> 'reason');
  PERFORM pg_temp.chk('S3', '单页熔断:零候选写入', (res ->> 'candidates_written')::int = 0);
  PERFORM pg_temp.chk('S3', '单页熔断:该页 9 票全部纹丝不动',
    (SELECT count(*)::int FROM serve.vote_current WHERE page_id = pb AND direction = 1) = 10);
END $$;


-- =====================================================================================
-- S4. 不可变触发器(append-only / revision 列白名单 / SCD2 / TRUNCATE / 逃生舱)
-- =====================================================================================
SELECT pg_temp.expect_error('S4', 'UPDATE ingest.vote_event ⇒ 拒',
  $$ UPDATE ingest.vote_event SET source = 'hacked' WHERE seq = (SELECT min(seq) FROM ingest.vote_event) $$, '25006');
SELECT pg_temp.expect_error('S4', 'DELETE ingest.vote_event ⇒ 拒',
  $$ DELETE FROM ingest.vote_event WHERE seq = (SELECT min(seq) FROM ingest.vote_event) $$, '25006');
SELECT pg_temp.expect_error('S4', 'TRUNCATE ingest.vote_event(父表)⇒ 拒',
  $$ TRUNCATE ingest.vote_event $$, '25006');
SELECT pg_temp.expect_error('S4', 'TRUNCATE ingest.vote_event_p0000(单分区)⇒ 拒 ★分区补挂',
  $$ TRUNCATE ingest.vote_event_p0000 $$, '25006');
SELECT pg_temp.expect_error('S4', 'UPDATE ingest.page_life_event ⇒ 拒',
  $$ UPDATE ingest.page_life_event SET kind = 'restored' WHERE seq = (SELECT min(seq) FROM ingest.page_life_event) $$, '25006');
SELECT pg_temp.expect_error('S4', 'DELETE ingest.page_life_event ⇒ 拒',
  $$ DELETE FROM ingest.page_life_event $$, '25006');
SELECT pg_temp.expect_error('S4', 'TRUNCATE ingest.page_life_event ⇒ 拒',
  $$ TRUNCATE ingest.page_life_event $$, '25006');

DO $$
DECLARE p_ int; u int; v_sha bytea;
BEGIN
  p_ := pg_temp.fxget('p1')::int;
  u  := pg_temp.fxget('u1')::int;
  -- 造 attribution_event / content_blob / page_source 各一行,好让 UPDATE/DELETE 有目标
  PERFORM ingest.apply_attribution_snapshot(
    p_, jsonb_build_array(jsonb_build_object('actor_id', u, 'role', 'AUTHOR', 'ord', 0)),
    true, now(), 'wikidot', pg_temp.fxget('run'));
  v_sha := ingest.put_content_blob('== 冒烟源码 ==' || chr(10) || 'hello', '冒烟源码 hello');
  PERFORM pg_temp.fxset('blob_len', octet_length(v_sha));
  PERFORM pg_temp.chk('S4', 'put_content_blob 用内建 sha256(无 pgcrypto 依赖)',
    octet_length(v_sha) = 32);
  PERFORM pg_temp.chk('S4', 'put_content_blob 与外部算的 sha 一致(两变体同源)',
    v_sha = sha256(convert_to('== 冒烟源码 ==' || chr(10) || 'hello', 'UTF8')));
  PERFORM pg_temp.chk('S4', 'put_content_blob 幂等(同字节只存一份)',
    ingest.put_content_blob('== 冒烟源码 ==' || chr(10) || 'hello') = v_sha
    AND (SELECT count(*)::int FROM ingest.content_blob WHERE sha256 = v_sha) = 1);
  PERFORM ingest.apply_page_meta(p_, jsonb_build_object('source_sha', encode(v_sha,'hex'), 'rev_no', 1),
                                 now(), 'wikidot', pg_temp.fxget('run'));
END $$;

SELECT pg_temp.expect_error('S4', 'UPDATE ingest.attribution_event ⇒ 拒',
  $$ UPDATE ingest.attribution_event SET role = 'X' WHERE seq = (SELECT min(seq) FROM ingest.attribution_event) $$, '25006');
SELECT pg_temp.expect_error('S4', 'UPDATE ingest.content_blob ⇒ 拒',
  $$ UPDATE ingest.content_blob SET source = 'x' $$, '25006');
SELECT pg_temp.expect_error('S4', 'DELETE ingest.page_source ⇒ 拒',
  $$ DELETE FROM ingest.page_source $$, '25006');

-- revision 列白名单
DO $$
DECLARE
  p_ int; u int; res jsonb; v_cnt int; v_wid bigint; v_guc text;
  v_revseq bigint; v_source text; v_sha bytea;
BEGIN
  p_ := pg_temp.fxget('p2')::int; u := pg_temp.fxget('u1')::int;
  -- ① 直连待补行(无 wid)
  res := ingest.apply_revision_batch(p_,
           jsonb_build_array(jsonb_build_object('rev_no', 7, 'author_id', u,
                                                'occurred_at', '2026-07-01T10:00:00+08',
                                                'comment', '待补行')),
           NULL, now(), 'wikidot', pg_temp.fxget('run'));
  PERFORM pg_temp.chk('S5', 'apply_revision_batch:无 wid ⇒ 插待补行',
    (res ->> 'inserted_pending')::int = 1, res::text);

  -- ② CROM 行后到 ⇒ 按 (page,rev_no) 认领并回填 wid,不产生第二行
  res := ingest.apply_revision_batch(p_,
           jsonb_build_array(jsonb_build_object('wikidot_revision_id', 55501, 'rev_no', 7,
                                                'type', 'page_edit')),
           NULL, now(), 'crom', pg_temp.fxget('run'));
  SELECT count(*)::int INTO v_cnt FROM ingest.revision WHERE page_id = p_ AND rev_no = 7;
  SELECT wikidot_revision_id INTO v_wid FROM ingest.revision WHERE page_id = p_ AND rev_no = 7;
  PERFORM pg_temp.chk('S5', 'apply_revision_batch:待补行被认领回填(仍 1 行)',
    v_cnt = 1 AND v_wid = 55501, format('rows=%s wid=%s', v_cnt, v_wid));
  PERFORM pg_temp.chk('S5', 'apply_revision_batch:回填计数 backfilled=1',
    (res ->> 'backfilled')::int = 1, res::text);

  -- 放行窗口必须已关闭(否则事务其余部分都能改事实)
  v_guc := current_setting('scpper.revision_backfill', true);
  PERFORM pg_temp.chk('S4★', 'revision 放行窗口在函数返回后已关闭',
    COALESCE(v_guc, 'off') <> 'on', format('GUC=%s', COALESCE(v_guc, '<unset>')));

  -- Wikidot 修订号从 0 开始：claimed=N、列表=N+1 才一致。
  PERFORM pg_temp.chk('S5', 'revision offset 工具:claimed=1 ⇒ 真实列表行数=2',
    meta.revision_list_count(1) = 2);
  res := ingest.apply_revision_batch(p_,
           jsonb_build_array(
             jsonb_build_object('wikidot_revision_id', 55501, 'rev_no', 7),
             jsonb_build_object('wikidot_revision_id', 55502, 'rev_no', 8)),
           1, now(), 'wikidot', pg_temp.fxget('run'));
  PERFORM pg_temp.chk('S5', 'revision 完整性:claimed=N / 列表=N+1 ⇒ ok',
    res ->> 'scan_status' = 'ok', res::text);

  -- 回归：旧逻辑会把 v_raw >= claimed 判 ok；现在同为 N 必须明确告警。
  res := ingest.apply_revision_batch(p_,
           jsonb_build_array(jsonb_build_object('wikidot_revision_id', 55501, 'rev_no', 7)),
           1, now(), 'wikidot', pg_temp.fxget('run'));
  PERFORM pg_temp.chk('S5', 'revision 完整性:claimed=N / 列表=N ⇒ 非 ok 并告警',
    res ->> 'scan_status' <> 'ok'
      AND res ->> 'reason' LIKE '%期望真实 2 条%', res::text);

  -- P0-8:claimed>1 而只解析到 1 条 ⇒ failed
  res := ingest.apply_revision_batch(p_,
           jsonb_build_array(jsonb_build_object('wikidot_revision_id', 55502, 'rev_no', 8)),
           153, now(), 'wikidot', pg_temp.fxget('run'));
  PERFORM pg_temp.chk('S5', 'P0-8:claimed=153 只解析到 1 条 ⇒ scan_status=failed',
    res ->> 'scan_status' = 'failed' AND res ->> 'reason' LIKE '%perpage%', res ->> 'reason');

  -- revision_count 由本地事实折叠
  PERFORM pg_temp.chk('S5', 'revision_count 由本地折叠(= count(revision))',
    (SELECT revision_count FROM serve.page_current WHERE page_id = p_)
      = (SELECT count(*)::int FROM ingest.revision WHERE page_id = p_));

  -- PageSource 全文：sha256 内容寻址、source_sha 单向回填、重复调用去重。
  SELECT seq INTO v_revseq
    FROM ingest.revision
   WHERE page_id = p_ AND wikidot_revision_id = 55501;
  v_source := '== revision full-source smoke ==' || chr(10) || '逐字节';
  v_sha := sha256(convert_to(v_source, 'UTF8'));
  res := ingest.apply_revision_source_full(
    v_revseq, p_, 55501, v_source, v_sha,
    sha256(convert_to('<div>response</div>', 'UTF8')),
    octet_length(convert_to('<div>response</div>', 'UTF8')), now()
  );
  PERFORM pg_temp.chk('S5★', 'revision full-source 首次写入 content_blob',
    (res ->> 'blob_inserted')::boolean, res::text);
  PERFORM pg_temp.chk('S5★', 'revision full-source 回填 source_sha 且全文逐字节一致',
    (SELECT r.source_sha = v_sha AND cb.source = v_source AND cb.byte_len =
            octet_length(convert_to(v_source, 'UTF8'))
       FROM ingest.revision r
       JOIN ingest.content_blob cb ON cb.sha256 = r.source_sha
      WHERE r.seq = v_revseq));
  res := ingest.apply_revision_source_full(
    v_revseq, p_, 55501, v_source, v_sha, NULL, NULL, now()
  );
  PERFORM pg_temp.chk('S5★', 'revision full-source 幂等重放命中 sha 去重',
    NOT (res ->> 'blob_inserted')::boolean, res::text);
  v_guc := current_setting('scpper.revision_backfill', true);
  PERFORM pg_temp.chk('S4★', 'revision full-source 返回后 GUC 放行窗口已关闭',
    COALESCE(v_guc, 'off') <> 'on', format('GUC=%s', COALESCE(v_guc, '<unset>')));
END $$;

SELECT pg_temp.expect_error('S4', 'revision:GUC 未开时直接 UPDATE type ⇒ 拒',
  $$ UPDATE ingest.revision SET type = 'hacked' WHERE wikidot_revision_id = 55501 $$, '25006');
SELECT pg_temp.expect_error('S4', 'revision:DELETE ⇒ 拒',
  $$ DELETE FROM ingest.revision WHERE wikidot_revision_id = 55501 $$, '25006');
SELECT pg_temp.expect_error('S4', 'revision:白名单外的列(comment)即使开了 GUC 也拒',
  $$ SELECT set_config('scpper.revision_backfill','on',true);
     UPDATE ingest.revision SET comment = 'hacked' WHERE wikidot_revision_id = 55501 $$, '25006');
SELECT pg_temp.expect_error('S4', 'revision:已有非空 type 被改 ⇒ 拒(跨源冲突进 quarantine)',
  $$ SELECT set_config('scpper.revision_backfill','on',true);
     UPDATE ingest.revision SET type = 'other' WHERE wikidot_revision_id = 55501 $$, '25006');
-- 上面两个 expect_error 在子事务里回滚,GUC 也随之回滚;这里再确认一次
DO $$ BEGIN
  PERFORM pg_temp.chk('S4★', 'expect_error 子事务回滚后 GUC 未泄漏',
    COALESCE(current_setting('scpper.revision_backfill', true), 'off') <> 'on');
END $$;

-- ---- SCD2 守卫 --------------------------------------------------------------------
-- ⚠ 顺序要紧:负向用例必须先有目标行。0 行的 UPDATE/DELETE 不触发行级触发器,会**假通过**
--   ——「本应抛错却成功」这一条在本文件第一版就真的发生过(那时 page_attr_history 还是空表)。
--   所以先建固件并断言非空,再跑负向用例。
DO $$
DECLARE p_ int; v_n int;
BEGIN
  p_ := pg_temp.fxget('p1')::int;
  PERFORM ingest.apply_page_meta(p_, jsonb_build_object('title', 'SCD2 固件',
                                                        'tags', jsonb_build_array('probe')),
                                 timestamptz '2026-07-01 09:00+08', 'wikidot',
                                 pg_temp.fxget('run'), 990001);
  SELECT count(*)::int INTO v_n FROM ingest.page_attr_history
   WHERE page_id = p_ AND valid_to IS NULL;
  PERFORM pg_temp.chk('S4', '前置:page_attr_history 有开区间行(否则负向用例会假通过)',
    v_n >= 1, format('%s 行', v_n));
END $$;

SELECT pg_temp.expect_error('S4', 'SCD2:UPDATE page_attr_history.value ⇒ 拒',
  $$ UPDATE ingest.page_attr_history SET value = '"x"'::jsonb WHERE valid_to IS NULL $$, '25006');
SELECT pg_temp.expect_error('S4', 'SCD2:DELETE page_attr_history ⇒ 拒',
  $$ DELETE FROM ingest.page_attr_history $$, '25006');
SELECT pg_temp.expect_error('S4', 'SCD2:DELETE page_slug_history ⇒ 拒',
  $$ DELETE FROM ingest.page_slug_history $$, '25006');

DO $$
DECLARE p_ int; v_id bigint;
BEGIN
  p_ := pg_temp.fxget('p1')::int;
  -- 合法:关区间(valid_to NULL→值)
  SELECT id INTO v_id FROM ingest.page_attr_history
   WHERE page_id = p_ AND valid_to IS NULL ORDER BY id LIMIT 1;
  PERFORM pg_temp.chk('S4', 'SCD2:找到待关区间行', v_id IS NOT NULL);
  UPDATE ingest.page_attr_history SET valid_to = now() WHERE id = v_id;
  PERFORM pg_temp.chk('S4', 'SCD2:关区间(valid_to NULL→值)放行',
    (SELECT valid_to IS NOT NULL FROM ingest.page_attr_history WHERE id = v_id));
  PERFORM pg_temp.fxset('scd2_closed_id', v_id);
END $$;

SELECT pg_temp.expect_error('S4', 'SCD2:已关闭区间再改 valid_to ⇒ 拒',
  $$ UPDATE ingest.page_attr_history SET valid_to = now()
      WHERE id = (SELECT v FROM fx WHERE k='scd2_closed_id') $$, '25006');

-- 逃生舱:migration 上下文放行
DO $$
DECLARE v_ok boolean := false;
BEGIN
  PERFORM set_config('scpper.bypass_guard', 'on', true);
  BEGIN
    UPDATE ingest.vote_event SET source = source WHERE seq = (SELECT min(seq) FROM ingest.vote_event);
    v_ok := true;
  EXCEPTION WHEN OTHERS THEN v_ok := false;
  END;
  PERFORM set_config('scpper.bypass_guard', 'off', true);
  PERFORM pg_temp.chk('S4', '逃生舱:bypass_guard=on 时 UPDATE 事实表放行', v_ok);

  -- 关掉后必须重新拒绝
  BEGIN
    UPDATE ingest.vote_event SET source = source WHERE seq = (SELECT min(seq) FROM ingest.vote_event);
    v_ok := false;
  EXCEPTION WHEN OTHERS THEN v_ok := true;
  END;
  PERFORM pg_temp.chk('S4', '逃生舱:关掉后立即恢复拒绝', v_ok);
END $$;

-- serve 侧守卫:page_daily_stats.views 只读 + tick append-only
DO $$
BEGIN
  INSERT INTO serve.page_daily_stats(page_id, date, views, votes_up, votes_down, unique_voters)
  VALUES (pg_temp.fxget('p1')::int, current_date, 100, 3, 1, 4);
  UPDATE serve.page_daily_stats SET views = 150 WHERE page_id = pg_temp.fxget('p1')::int;
  PERFORM pg_temp.chk('S4', 'views 守卫:递增放行',
    (SELECT views FROM serve.page_daily_stats WHERE page_id = pg_temp.fxget('p1')::int) = 150);
  PERFORM pg_temp.chk('S4', 'total_votes 生成列 = up + down',
    (SELECT total_votes FROM serve.page_daily_stats WHERE page_id = pg_temp.fxget('p1')::int) = 4);
END $$;

SELECT pg_temp.expect_error('S4', 'views 守卫:降值 ⇒ 拒',
  $$ UPDATE serve.page_daily_stats SET views = 1 WHERE page_id = (SELECT v FROM fx WHERE k='p1') $$);
SELECT pg_temp.expect_error('S4', 'views 守卫:DELETE 含 views 的行 ⇒ 拒',
  $$ DELETE FROM serve.page_daily_stats WHERE page_id = (SELECT v FROM fx WHERE k='p1') $$);
SELECT pg_temp.expect_error('S4', 'views 守卫:TRUNCATE ⇒ 拒(Tier-2 重建的默认手法)',
  $$ TRUNCATE serve.page_daily_stats $$);

DO $$
BEGIN
  INSERT INTO serve.category_index_tick(category, as_of_ts, vote_cutoff_date, index_mark)
  VALUES ('scp', now(), current_date, 1000);
  PERFORM pg_temp.chk('S4', 'category_index_tick:INSERT 放行', true);
END $$;
SELECT pg_temp.expect_error('S4', 'tick append-only:UPDATE ⇒ 拒',
  $$ UPDATE serve.category_index_tick SET index_mark = 1 WHERE category = 'scp' $$);
SELECT pg_temp.expect_error('S4', 'tick append-only:DELETE ⇒ 拒',
  $$ DELETE FROM serve.category_index_tick WHERE category = 'scp' $$);


-- =====================================================================================
-- S5. 其余 apply_*(page_meta / page_life / attribution / forum / history)
-- =====================================================================================
DO $$
DECLARE p_ int; res jsonb; n_before int; v_tags text[]; v_val jsonb;
BEGIN
  p_ := pg_temp.fxget('p2')::int;

  -- 首次写属性
  res := ingest.apply_page_meta(p_, jsonb_build_object(
           'title', '冒烟标题', 'alternate_title', 'Smoke Alt',
           'tags', jsonb_build_array('cn', 'scp'), 'category', '_default',
           'discussion_thread_id', 900000000008800001,
           'claimed_rating', 42, 'claimed_vote_count', 50),
           timestamptz '2026-07-01 12:00+08', 'wikidot', pg_temp.fxget('run'), 990002);
  PERFORM pg_temp.chk('S5', 'apply_page_meta:首次写 4 个属性区间',
    (res ->> 'attr_changes')::int = 4, res::text);
  PERFORM pg_temp.chk('S5', 'apply_page_meta:claimed_rating 绝不写 page_current.rating',
    (SELECT rating FROM serve.page_current WHERE page_id = p_) <> 42);
  PERFORM pg_temp.chk('S5', 'apply_page_meta:claimed_* 只落 page_scan 作对账证据',
    (SELECT checksum_expected = 42 AND claimed_total = 50 FROM meta.page_scan
      WHERE page_id = p_ AND kind = 'meta' AND run_id = pg_temp.fxget('run')));

  -- 顺序不同的同一组 tags ⇒ 零写入(排序去重)
  SELECT count(*)::int INTO n_before FROM ingest.page_attr_history WHERE page_id = p_;
  res := ingest.apply_page_meta(p_, jsonb_build_object('tags', jsonb_build_array('scp','cn','scp')),
                                timestamptz '2026-07-01 13:00+08', 'wikidot');
  PERFORM pg_temp.chk('S5', 'apply_page_meta:tags 顺序/重复不同 ⇒ 零写入(SCD2 无伪变更)',
    (res ->> 'attr_changes')::int = 0
    AND (SELECT count(*)::int FROM ingest.page_attr_history WHERE page_id = p_) = n_before);

  -- P0-4:隐藏标签必须并入
  res := ingest.apply_page_meta(p_, jsonb_build_object('tags', jsonb_build_array('scp','cn'),
                                                       'hidden_tags', jsonb_build_array('_image')),
                                timestamptz '2026-07-01 14:00+08', 'wikidot');
  SELECT tags INTO v_tags FROM serve.page_current WHERE page_id = p_;
  SELECT value INTO v_val FROM ingest.page_attr_history
   WHERE page_id = p_ AND attr = 'tags' AND valid_to IS NULL;
  PERFORM pg_temp.chk('S5', 'P0-4:hidden_tags 并入 tags 且触发一次区间切换',
    (res ->> 'attr_changes')::int = 1 AND v_tags @> ARRAY['_image']
    AND v_val = '["_image","cn","scp"]'::jsonb, format('tags=%s val=%s', v_tags, v_val));
  PERFORM pg_temp.chk('S5', 'SCD2:tags 只有一条开区间(pah_current 部分唯一索引)',
    (SELECT count(*)::int FROM ingest.page_attr_history
      WHERE page_id = p_ AND attr = 'tags' AND valid_to IS NULL) = 1);

  -- 改名:SCD2 关旧开新 + renamed 事件 + page_current.slug 同步
  res := ingest.apply_page_meta(p_, jsonb_build_object('slug', 'scp-cn-9902-renamed'),
                                timestamptz '2026-07-01 15:00+08', 'wikidot');
  PERFORM pg_temp.chk('S5', 'apply_page_meta:改名 renamed=true', (res ->> 'renamed')::boolean);
  PERFORM pg_temp.chk('S5', '改名:slug_history 关旧开新(恰一条开区间)',
    (SELECT count(*)::int FROM ingest.page_slug_history WHERE page_id = p_) = 2
    AND (SELECT slug FROM ingest.page_slug_history WHERE page_id = p_ AND valid_to IS NULL)
        = 'scp-cn-9902-renamed');
  PERFORM pg_temp.chk('S5', '改名:落 page_life_event(renamed)',
    EXISTS (SELECT 1 FROM ingest.page_life_event WHERE page_id = p_ AND kind = 'renamed'));
  PERFORM pg_temp.chk('S5', '改名:page_current.slug 同步',
    (SELECT slug FROM serve.page_current WHERE page_id = p_) = 'scp-cn-9902-renamed');
END $$;

-- P1-6 selector 字面量残留 ⇒ 整批拒绝 + 留痕
SELECT pg_temp.expect_error('S5', 'P1-6:selector 字面量残留 ⇒ 整批拒绝',
  $$ SELECT ingest.apply_page_meta((SELECT v FROM fx WHERE k='p2')::int,
       '{"title":"%%title%%"}'::jsonb, now(), 'wikidot',
       (SELECT v FROM fx WHERE k='run')) $$, '22000');
DO $$ BEGIN
  -- expect_error 的子事务回滚会把 quarantine 行也回滚 —— 这里在**不抛错**的路径上验证检测器本身
  PERFORM pg_temp.chk('S5', 'P1-6:has_selector_residue 检测器',
    ingest.has_selector_residue('"%%title%%"'::jsonb)
    AND ingest.has_selector_residue('["ok","%%tags%%"]'::jsonb)
    AND NOT ingest.has_selector_residue('"正常标题"'::jsonb)
    AND NOT ingest.has_selector_residue('["cn","scp"]'::jsonb));
END $$;

-- page_life:幂等 + 删除推断的 run 级门控
DO $$
DECLARE p3 int; v_seq bigint;
BEGIN
  p3 := pg_temp.fxget('p3')::int;
  v_seq := ingest.apply_page_life(p3, 'deleted', now(), 'inferred', now(), 'wikidot',
                                  pg_temp.fxget('run'), NULL, 0.98);
  PERFORM pg_temp.chk('S5', 'apply_page_life:合格 run ⇒ 允许 deleted', v_seq IS NOT NULL);
  PERFORM pg_temp.chk('S5', 'apply_page_life:page_current.status 翻 deleted',
    (SELECT status = 'deleted' AND deleted_at IS NOT NULL AND deleted_at_precision = 'inferred'
       FROM serve.page_current WHERE page_id = p3));
  PERFORM pg_temp.chk('S5', 'apply_page_life:重复 deleted ⇒ 返回 NULL 零事件',
    ingest.apply_page_life(p3, 'deleted', now(), 'inferred', now(), 'wikidot',
                           pg_temp.fxget('run')) IS NULL);

  -- restored:v1 那 45 页「双 isDeleted 发散」在此不可构造
  -- ⚠ 必须分两步:同一条表达式里既调 volatile 函数又 SELECT 它写的行,读到的是调用前的快照。
  v_seq := ingest.apply_page_life(p3, 'restored', now(), 'exact', now(), 'wikidot');
  PERFORM pg_temp.chk('S5', 'apply_page_life:restored 产生事件', v_seq IS NOT NULL);
  PERFORM pg_temp.chk('S5', 'apply_page_life:restored ⇒ status 回 live 且 deleted_at 清空',
    (SELECT status = 'live' AND deleted_at IS NULL AND deleted_at_precision IS NULL
       FROM serve.page_current WHERE page_id = p3));
END $$;

SELECT pg_temp.expect_error('S5', '删除推断门控:run.status=failed ⇒ 拒(55000)',
  $$ SELECT ingest.apply_page_life((SELECT v FROM fx WHERE k='p3')::int, 'deleted', now(),
       'inferred', now(), 'wikidot', (SELECT v FROM fx WHERE k='run_bad')) $$, '55000');
SELECT pg_temp.expect_error('S5', '删除推断门控:不带 run_id ⇒ 拒(22004)',
  $$ SELECT ingest.apply_page_life((SELECT v FROM fx WHERE k='p3')::int, 'deleted', now(),
       'inferred', now(), 'wikidot', NULL) $$, '22004');
SELECT pg_temp.expect_error('S5', '删除推断门控:覆盖率阈值抬到 0.999 ⇒ 拒(55000)',
  $$ SELECT ingest.apply_page_life((SELECT v FROM fx WHERE k='p3')::int, 'deleted', now(),
       'inferred', now(), 'wikidot', (SELECT v FROM fx WHERE k='run'), NULL, 0.999) $$, '55000');
DO $$
DECLARE v_seq bigint;
BEGIN
  v_seq := ingest.apply_page_life(pg_temp.fxget('p3')::int, 'deleted', now(), 'exact', now(), 'crom');
  PERFORM pg_temp.chk('S5', '删除推断门控:source=crom 属显式证据,无需 run 背书', v_seq IS NOT NULL);
  PERFORM ingest.apply_page_life(pg_temp.fxget('p3')::int, 'restored', now(), 'exact', now(), 'crom');
END $$;

-- attribution:is_display SUBMITTER 抑制(P1-4)
DO $$
DECLARE p3 int; u1 int; u2 int; res jsonb;
BEGIN
  p3 := pg_temp.fxget('p3')::int; u1 := pg_temp.fxget('u1')::int; u2 := pg_temp.fxget('u2')::int;
  res := ingest.apply_attribution_snapshot(p3,
           jsonb_build_array(jsonb_build_object('actor_id', u1, 'role', 'SUBMITTER', 'ord', 0)),
           true, now(), 'wikidot', pg_temp.fxget('run'));
  PERFORM pg_temp.chk('S5', 'attribution:added=1', (res ->> 'added')::int = 1, res::text);
  PERFORM pg_temp.chk('S5', 'P1-4:只有 SUBMITTER ⇒ is_display 保持 true(否则这批页作者集体消失)',
    (SELECT is_display FROM serve.attribution_current
      WHERE page_id = p3 AND role = 'SUBMITTER' AND actor_id = u1));

  res := ingest.apply_attribution_snapshot(p3,
           jsonb_build_array(jsonb_build_object('actor_id', u1, 'role', 'SUBMITTER', 'ord', 0),
                             jsonb_build_object('actor_id', u2, 'role', 'AUTHOR',    'ord', 0)),
           true, now(), 'wikidot', pg_temp.fxget('run'));
  PERFORM pg_temp.chk('S5', 'P1-4:出现 AUTHOR 后 SUBMITTER 转 is_display=false',
    (SELECT NOT is_display FROM serve.attribution_current
      WHERE page_id = p3 AND role = 'SUBMITTER')
    AND (SELECT is_display FROM serve.attribution_current
          WHERE page_id = p3 AND role = 'AUTHOR'));

  -- is_complete=false ⇒ 缺席者不产生 removed
  res := ingest.apply_attribution_snapshot(p3,
           jsonb_build_array(jsonb_build_object('actor_id', u2, 'role', 'AUTHOR', 'ord', 0)),
           false, now(), 'wikidot', pg_temp.fxget('run'));
  PERFORM pg_temp.chk('S5', 'attribution:is_complete=false ⇒ removed=0(absence 红线)',
    (res ->> 'removed')::int = 0
    AND (SELECT count(*)::int FROM serve.attribution_current WHERE page_id = p3) = 2);

  -- is_complete=true ⇒ 才产生 removed
  res := ingest.apply_attribution_snapshot(p3,
           jsonb_build_array(jsonb_build_object('actor_id', u2, 'role', 'AUTHOR', 'ord', 0)),
           true, now(), 'wikidot', pg_temp.fxget('run'));
  PERFORM pg_temp.chk('S5', 'attribution:is_complete=true ⇒ removed=1 且落 removed 事件',
    (res ->> 'removed')::int = 1
    AND EXISTS (SELECT 1 FROM ingest.attribution_event
                 WHERE page_id = p3 AND action = 'removed'));
  PERFORM pg_temp.chk('S5', 'attribution_count 同步到 page_current',
    (SELECT attribution_count FROM serve.page_current WHERE page_id = p3) = 1);
END $$;

-- forum:三表 upsert + thread→page 反解 + 未知 category/thread 进隔离
DO $$
DECLARE res jsonb; p1 int; p2 int; u1 int;
BEGIN
  p1 := pg_temp.fxget('p1')::int; p2 := pg_temp.fxget('p2')::int;
  u1 := pg_temp.fxget('u1')::int;
  -- 模拟 v1 title-as-slug 结转出的错误关联；下方 CommentsList 真值必须覆盖它。
  INSERT INTO ingest.forum_category(id, title, thread_count, post_count, last_synced_at)
  VALUES (900000000000675245, '单页讨论', 1, 2, now());
  INSERT INTO ingest.forum_thread(
    id, category_id, page_id, page_id_source, title, created_at, post_count, last_synced_at
  ) VALUES (900000000008800001, 900000000000675245, p1, 'inferred', 'v1 猜测', now(), 0, now());

  res := ingest.apply_forum_batch(
    jsonb_build_array(jsonb_build_object('id', 900000000000675245, 'title', '单页讨论',
                                         'thread_count', 1, 'post_count', 2)),
    jsonb_build_array(
      jsonb_build_object('id', 900000000008800001, 'category_id', 900000000000675245, 'title', 'p2 的讨论',
                         'description', '真实主题描述', 'page_id', p1, 'page_id_source', 'inferred',
                         'created_by_user_id', u1, 'created_at', '2026-07-01T10:00:00+08',
                         'post_count', 2),
      -- 未知 category ⇒ 必须进隔离,不静默建桩
      jsonb_build_object('id', 900000000008899999, 'category_id', 900000000000424242, 'title', '孤儿 thread')),
    jsonb_build_array(
      jsonb_build_object('id', 900000000009900001, 'thread_id', 900000000008800001, 'author_user_id', u1,
                         'author_name', '注销作者快照', 'created_by_type', 'deleted',
                         'text_html', '<p>你好 <b>世界</b></p>',
                         'created_at', '2026-07-01T10:05:00+08'),
      jsonb_build_object('id', 900000000009900002, 'thread_id', 900000000077777777, 'text_html', '孤儿 post')),
    now(), 'wikidot', pg_temp.fxget('run'));

  PERFORM pg_temp.chk('S5', 'forum:1 category / 1 thread / 1 post 入库',
    (res ->> 'categories')::int = 1 AND (res ->> 'threads')::int = 1
    AND (res ->> 'posts')::int = 1, res::text);
  PERFORM pg_temp.chk('S5', 'forum:thread.page_id 经 discussion_thread_id 反解成功',
    (SELECT page_id FROM ingest.forum_thread WHERE id = 900000000008800001) = p2
    AND (res ->> 'threads_linked')::int = 1);
  PERFORM pg_temp.chk('S5', 'forum:直连反解覆盖 inferred 并标为 verified',
    (SELECT page_id = p2 AND page_id_source = 'verified'
       FROM ingest.forum_thread WHERE id = 900000000008800001));
  PERFORM pg_temp.chk('S5', 'forum:A4 inferred 不覆盖 verified，且 description 不丢',
    (SELECT page_id = p2 AND page_id_source = 'verified' AND description = '真实主题描述'
       FROM ingest.forum_thread WHERE id = 900000000008800001));
  PERFORM pg_temp.chk('S5', 'forum:deleted 有 user_id 仍保留姓名快照和徽章',
    (SELECT author_user_id = u1 AND author_name = '注销作者快照'
            AND created_by_type = 'deleted'
       FROM ingest.forum_post WHERE id = 900000000009900001));
  PERFORM pg_temp.chk('S5', 'forum:未知 category 的 thread 进 fact_quarantine 且未入库',
    NOT EXISTS (SELECT 1 FROM ingest.forum_thread WHERE id = 900000000008899999)
    AND EXISTS (SELECT 1 FROM meta.fact_quarantine
                 WHERE domain = 'forum' AND reason = 'unknown_category_id'
                   AND natural_key = '900000000008899999'));
  PERFORM pg_temp.chk('S5', 'forum:未知 thread 的 post 进 fact_quarantine 且未入库',
    NOT EXISTS (SELECT 1 FROM ingest.forum_post WHERE id = 900000000009900002)
    AND EXISTS (SELECT 1 FROM meta.fact_quarantine
                 WHERE domain = 'forum' AND reason = 'unknown_thread_id'));
  PERFORM pg_temp.chk('S5', 'forum:text_plain 缺失时用剥标签兜底(pgroonga 索引列不留 NULL)',
    (SELECT text_plain FROM ingest.forum_post WHERE id = 900000000009900001) LIKE '%你好%世界%');

  -- 重复 upsert 幂等且 text_plain 不被 NULL 覆盖
  res := ingest.apply_forum_batch(
    NULL, NULL,
    jsonb_build_array(jsonb_build_object('id', 900000000009900001, 'thread_id', 900000000008800001,
                                         'is_deleted', false)),
    now(), 'wikidot', pg_temp.fxget('run'));
  PERFORM pg_temp.chk('S5', 'forum:重复 upsert ⇒ 1 行且 text_plain 不被 NULL 覆盖',
    (SELECT count(*)::int FROM ingest.forum_post WHERE id = 900000000009900001) = 1
    AND (SELECT text_plain IS NOT NULL FROM ingest.forum_post WHERE id = 900000000009900001));
END $$;

-- apply_vote_history:CROM 事件历史(显式 direction=0 撤票 / 折叠 / 绝不 absence 推断)
DO $$
DECLARE p4 int; a int; b int; c int; res jsonb; n_before int;
BEGIN
  p4 := ingest.register_page(990004, 'scp-cn-9904', now(), 'crom', NULL, NULL, pg_temp.fxget('run'));
  PERFORM pg_temp.fxset('p4', p4);
  a := ingest.ensure_user('wikidot', 975001, NULL, 'Hist A');
  b := ingest.ensure_user('wikidot', 975002, NULL, 'Hist B');
  c := ingest.ensure_user('wikidot', 975003, NULL, 'Hist C');

  -- a: 三条记录取最新那条(0)⇒ 无既有票 ⇒ 不产生事件(不是 revoke)
  -- b: +1;c: -1
  res := ingest.apply_vote_history(p4, jsonb_build_array(
           jsonb_build_object('voter_id', a, 'direction', 1,  'day_ts', '2024-01-01T00:00:00+08'),
           jsonb_build_object('voter_id', a, 'direction', -1, 'day_ts', '2024-01-02T00:00:00+08'),
           jsonb_build_object('voter_id', a, 'direction', 0,  'day_ts', '2024-01-03T00:00:00+08'),
           jsonb_build_object('voter_id', b, 'direction', 2,  'day_ts', '2024-02-01T00:00:00+08'),
           jsonb_build_object('voter_id', c, 'direction', -1, 'day_ts', '2022-05-25T00:00:00+08')),
           2, now(), 'crom', pg_temp.fxget('run'));

  PERFORM pg_temp.chk('S5', 'history:逐 voter 折叠为终态(3 voter / 5 记录 ⇒ folded=3)',
    (res ->> 'folded')::int = 3 AND (res ->> 'raw_records')::int = 5, res::text);
  PERFORM pg_temp.chk('S5', 'history:a 的终态 0 且无既有票 ⇒ 不产生幻影 revoke',
    NOT EXISTS (SELECT 1 FROM ingest.vote_event WHERE page_id = p4 AND voter_id = a));
  PERFORM pg_temp.chk('S5', 'history:events=2(b 的 +1 与 c 的 -1)',
    (res ->> 'events')::int = 2);
  PERFORM pg_temp.chk('S5', 'history:±2 归一化为 +1',
    (SELECT direction FROM serve.vote_current WHERE page_id = p4 AND voter_id = b) = 1);
  PERFORM pg_temp.chk('S5', 'A3:2022-05-25 的 crom 票 ⇒ precision=bootstrap',
    (SELECT time_precision FROM ingest.vote_event WHERE page_id = p4 AND voter_id = c) = 'bootstrap');
  PERFORM pg_temp.chk('S5', 'history:absence_inference=forbidden 且完整性护栏 ok',
    res ->> 'absence_inference' = 'forbidden' AND res ->> 'scan_status' = 'ok');

  -- 幂等重放:同一批第二次 ⇒ 0 事件
  SELECT count(*)::int INTO n_before FROM ingest.vote_event WHERE page_id = p4;
  res := ingest.apply_vote_history(p4, jsonb_build_array(
           jsonb_build_object('voter_id', b, 'direction', 1, 'day_ts', '2024-02-01T00:00:00+08'),
           jsonb_build_object('voter_id', c, 'direction', -1,'day_ts', '2022-05-25T00:00:00+08')),
           2, now(), 'crom', pg_temp.fxget('run'));
  PERFORM pg_temp.chk('S5', 'history:重放幂等 ⇒ 0 新事件',
    (res ->> 'events')::int = 0
    AND (SELECT count(*)::int FROM ingest.vote_event WHERE page_id = p4) = n_before);

  -- absence 不推断:只给 1 票,另 1 票必须纹丝不动
  res := ingest.apply_vote_history(p4, jsonb_build_array(
           jsonb_build_object('voter_id', b, 'direction', 1, 'day_ts', '2024-02-01T00:00:00+08')),
           NULL, now(), 'crom', pg_temp.fxget('run'));
  PERFORM pg_temp.chk('S5', 'history:名单里少了 c ⇒ c 的票不受影响(绝不 absence 推断)',
    (SELECT direction FROM serve.vote_current WHERE page_id = p4 AND voter_id = c) = -1);

  -- 完整性护栏:claimed 与折叠后非零不等 ⇒ partial 且零 revoke
  res := ingest.apply_vote_history(p4, jsonb_build_array(
           jsonb_build_object('voter_id', b, 'direction', 1, 'day_ts', '2024-02-01T00:00:00+08')),
           77, now(), 'crom', pg_temp.fxget('run'));
  PERFORM pg_temp.chk('S5', 'history:claimed 不符 ⇒ partial 且零 revoke 事件',
    res ->> 'scan_status' = 'partial'
    AND (SELECT count(*)::int FROM ingest.vote_event WHERE page_id = p4 AND kind = 'revoke') = 0);
END $$;

-- 批量 = 逐行等价性(T5 的最小版本:同一批目标态两条路径结果相同)
DO $$
DECLARE
  pa int; pb int; i int; v int; ids int[] := '{}';
  ja jsonb; sa jsonb; sb jsonb; agg_a jsonb; agg_b jsonb;
BEGIN
  pa := ingest.register_page(990005, 'scp-cn-9905', now(), 'wikidot', NULL, NULL, pg_temp.fxget('run'));
  pb := ingest.register_page(990006, 'scp-cn-9906', now(), 'wikidot', NULL, NULL, pg_temp.fxget('run'));
  FOR i IN 1..25 LOOP
    v := ingest.ensure_user('wikidot', 974000 + i, NULL, 'Eq ' || i);
    ids := ids || v;
  END LOOP;

  -- 预置:两页完全相同的初始态
  FOR i IN 1..25 LOOP
    IF i % 3 = 0 THEN
      PERFORM ingest.apply_vote_observation(pa, ids[i],  1, now(), now(), 'day', 'crom', NULL);
      PERFORM ingest.apply_vote_observation(pb, ids[i],  1, now(), now(), 'day', 'crom', NULL);
    ELSIF i % 3 = 1 THEN
      PERFORM ingest.apply_vote_observation(pa, ids[i], -1, now(), now(), 'day', 'crom', NULL);
      PERFORM ingest.apply_vote_observation(pb, ids[i], -1, now(), now(), 'day', 'crom', NULL);
    END IF;
  END LOOP;

  -- 目标态:混合 +1 / -1 / 0
  -- 注意:generate_series 的列不能叫 i —— 与 plpgsql 变量 i 同名会触发 42702 ambiguous。
  SELECT jsonb_agg(jsonb_build_object('voter_id', ids[g.n],
                                      'direction', CASE g.n % 4 WHEN 0 THEN 0 WHEN 1 THEN 1
                                                                WHEN 2 THEN -1 ELSE 1 END,
                                      'occurred_at', to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SSOF'),
                                      'precision', 'observed')
                   ORDER BY g.n)
    INTO ja FROM generate_series(1, 25) AS g(n);

  -- 路径 a:逐行
  FOR i IN 1..25 LOOP
    PERFORM ingest.apply_vote_observation(
      pa, ids[i], CASE i % 4 WHEN 0 THEN 0 WHEN 1 THEN 1 WHEN 2 THEN -1 ELSE 1 END,
      now(), now(), 'observed', 'wikidot', NULL);
  END LOOP;
  -- 路径 b:一次集合化(顺序刻意打乱,验证顺序无关性)
  PERFORM ingest.apply_vote_cas_batch(
    pb, (SELECT jsonb_agg(e ORDER BY md5(e::text)) FROM jsonb_array_elements(ja) AS t(e)),
    now(), 'wikidot', NULL);

  SELECT jsonb_agg(jsonb_build_object('v', voter_id, 'd', direction) ORDER BY voter_id)
    INTO sa FROM serve.vote_current WHERE page_id = pa;
  SELECT jsonb_agg(jsonb_build_object('v', voter_id, 'd', direction) ORDER BY voter_id)
    INTO sb FROM serve.vote_current WHERE page_id = pb;
  PERFORM pg_temp.chk('S5', 'T5:批量 = 逐行(vote_current 全等)', sa = sb,
    format('a=%s b=%s', left(sa::text,60), left(sb::text,60)));

  SELECT jsonb_build_object('r', rating, 'u', vote_up, 'd', vote_down, 'k', vote_revoked)
    INTO agg_a FROM serve.page_current WHERE page_id = pa;
  SELECT jsonb_build_object('r', rating, 'u', vote_up, 'd', vote_down, 'k', vote_revoked)
    INTO agg_b FROM serve.page_current WHERE page_id = pb;
  PERFORM pg_temp.chk('S5', 'T5:批量 = 逐行(page_current 四列全等)', agg_a = agg_b,
    format('a=%s b=%s', agg_a, agg_b));

  SELECT jsonb_agg(x ORDER BY x::text) INTO sa FROM (
    SELECT jsonb_build_object('v', voter_id, 'k', kind, 'o', old_direction, 'n', new_direction) AS x
      FROM ingest.vote_event WHERE page_id = pa) t;
  SELECT jsonb_agg(x ORDER BY x::text) INTO sb FROM (
    SELECT jsonb_build_object('v', voter_id, 'k', kind, 'o', old_direction, 'n', new_direction) AS x
      FROM ingest.vote_event WHERE page_id = pb) t;
  PERFORM pg_temp.chk('S5', 'T5:批量 = 逐行(vote_event 多重集全等,忽略 seq)', sa = sb);
END $$;

SELECT pg_temp.expect_error('S5', 'cas_batch:同 voter 重复出现 ⇒ 报错(折叠是调用方责任)',
  $$ SELECT ingest.apply_vote_cas_batch((SELECT v FROM fx WHERE k='p2')::int,
       jsonb_build_array(jsonb_build_object('voter_id',(SELECT v FROM fx WHERE k='u1'),'direction',1),
                         jsonb_build_object('voter_id',(SELECT v FROM fx WHERE k='u1'),'direction',-1)),
       now(), 'wikidot', NULL) $$, '22000');


-- =====================================================================================
-- S6. 游标安全(§5.5 的 advisory lock 屏障)
-- =====================================================================================
DO $$
DECLARE v_mark bigint; v_floor bigint; v_max bigint; w record; v_new bigint;
BEGIN
  -- 本会话自己持有 gate 共享锁(所有 apply_* 都调 ingest_gate_open),
  -- 同会话取 EXCLUSIVE 不冲突,所以能拿到水位。
  v_mark := meta.safe_seq_watermark();
  SELECT seq_floor INTO v_floor FROM meta.ingest_gate WHERE txid = txid_current();
  SELECT max(seq) INTO v_max FROM ingest.vote_event;

  PERFORM pg_temp.chk('S6', 'safe_seq_watermark 返回非空水位', v_mark IS NOT NULL, v_mark::text);

  -- ★ 这是游标安全的**核心性质**,不是「水位应该很大」:
  --   本事务是「已分配 seq 但未提交」的写者,水位必须**严格低于**本事务分配到的任何 seq,
  --   否则 projector 会消费到一个可能回滚的 seq —— 那就是静默漏投影/幻影投影的来源。
  --   在单事务测试里这表现为 watermark = 本事务 gate 的 seq_floor - 1。
  PERFORM pg_temp.chk('S6★', '水位严格低于本(未提交)事务分配的 seq —— 绝不越过飞行中的写者',
    v_mark < v_max, format('watermark=%s max_seq=%s', v_mark, v_max));
  PERFORM pg_temp.chk('S6★', '水位 = max(gate.seq_floor - 1, 0)(表机制与锁屏障取交集生效)',
    v_mark = GREATEST(v_floor - 1, 0), format('watermark=%s floor=%s', v_mark, v_floor));
  PERFORM pg_temp.chk('S6★', '水位永不为负(全新库 fact_seq 未用过时 floor=0 ⇒ 必须钳到 0)',
    v_mark >= 0, v_mark::text);

  INSERT INTO meta.projection_cursor(projection, event_domain, last_seq, rebuild_from)
  VALUES ('smoke.page_stats', 'vote', 0, 'serve.vote_current')
  ON CONFLICT (projection) DO NOTHING;

  -- projection_window 的规格是一个双条件式:窗口非空 ⇔ 水位严格大于游标。
  -- 不写死 [1, 水位]:全新库上本事务的所有 seq 都属于「未提交」,水位就是 0、窗口就该是空的
  --（那正是正确答案)。老库上 fact_seq 已被用过,水位 > 0、窗口非空。两种都必须成立。
  SELECT * INTO w FROM meta.projection_window('smoke.page_stats');
  PERFORM pg_temp.chk('S6', 'projection_window:窗口非空 ⇔ 水位 > 游标',
    (w.from_seq IS NOT NULL) = (v_mark > 0),
    format('watermark=%s window=%s..%s', v_mark, w.from_seq, w.to_seq));
  IF w.from_seq IS NOT NULL THEN
    PERFORM pg_temp.chk('S6', 'projection_window:非空窗口 = [游标+1, 水位]',
      w.from_seq = 1 AND w.to_seq = v_mark, format('%s..%s', w.from_seq, w.to_seq));
  ELSE
    PERFORM pg_temp.chk('S6', 'projection_window:空窗口(水位=0,本事务全部 seq 均未提交)',
      v_mark = 0);
  END IF;

  -- 越界钳制:传一个远大于水位的值 ⇒ 绝不越过水位
  v_new := meta.advance_projection_cursor('smoke.page_stats', 9223372036854775000);
  PERFORM pg_temp.chk('S6★', 'advance_projection_cursor 钳到安全水位(绝不越界)',
    v_new = GREATEST(0, v_mark) AND v_new < v_max, format('new=%s mark=%s max=%s', v_new, v_mark, v_max));

  -- 推进到水位后窗口必为空
  PERFORM pg_temp.chk('S6', '推进到水位后 projection_window 为空窗口',
    NOT EXISTS (SELECT 1 FROM meta.projection_window('smoke.page_stats')));

  PERFORM pg_temp.chk('S6', 'T7.5 MVCC 边界:同事务的 ingest_gate 行对他人不可见(表机制单独用无效)',
    (SELECT count(*)::int FROM meta.ingest_gate WHERE txid = txid_current()) = 1);
END $$;

SELECT pg_temp.expect_error('S6', 'projection_window:未登记的投影 ⇒ 抛 23503',
  $$ SELECT * FROM meta.projection_window('nope.not_declared') $$, '23503');
SELECT pg_temp.expect_error('S6', 'advance_projection_cursor:未登记的投影 ⇒ 抛 23503',
  $$ SELECT meta.advance_projection_cursor('nope.not_declared', 1) $$, '23503');


-- =====================================================================================
-- S7. 全局一致性不变式(I1–I4 / I8 / I9 / I10)
-- =====================================================================================
DO $$
DECLARE v_bad int;
BEGIN
  SELECT count(*)::int INTO v_bad FROM (
    SELECT pc.page_id
      FROM serve.page_current pc
      LEFT JOIN (SELECT page_id,
                        COALESCE(sum(direction), 0)::int             AS r,
                        count(*) FILTER (WHERE direction =  1)::int  AS u,
                        count(*) FILTER (WHERE direction = -1)::int  AS d,
                        count(*) FILTER (WHERE direction =  0)::int  AS k
                   FROM serve.vote_current GROUP BY page_id) v
             ON v.page_id = pc.page_id
     WHERE (pc.rating, pc.vote_up, pc.vote_down, pc.vote_revoked)
        <> (COALESCE(v.r,0), COALESCE(v.u,0), COALESCE(v.d,0), COALESCE(v.k,0))) x;
  PERFORM pg_temp.chk('S7', 'I1–I4:page_current 四列 = vote_current 折叠(逐页)', v_bad = 0,
    format('%s 页不一致', v_bad));

  SELECT count(*)::int INTO v_bad FROM serve.page_current pc
   WHERE pc.revision_count <> (SELECT count(*)::int FROM ingest.revision r WHERE r.page_id = pc.page_id);
  PERFORM pg_temp.chk('S7', 'I8:revision_count = count(ingest.revision)', v_bad = 0);

  SELECT count(*)::int INTO v_bad FROM serve.page_current pc
   WHERE pc.attribution_count
       <> (SELECT count(*)::int FROM serve.attribution_current a WHERE a.page_id = pc.page_id);
  PERFORM pg_temp.chk('S7', 'I9:attribution_count = count(attribution_current)', v_bad = 0);

  SELECT count(*)::int INTO v_bad FROM ingest.vote_event
   WHERE NOT ((kind = 'vote'   AND old_direction IS NULL AND new_direction IS NOT NULL)
           OR (kind = 'revoke' AND old_direction IS NOT NULL AND new_direction IS NULL)
           OR (kind = 'revote' AND old_direction IS NOT NULL AND new_direction IS NOT NULL
               AND old_direction <> new_direction));
  PERFORM pg_temp.chk('S7', 'I10:每条 vote_event 的 (kind,old,new) 组合合法', v_bad = 0);

  SELECT count(*)::int INTO v_bad FROM meta.revoke_candidate rc
    JOIN serve.vote_current vc ON vc.page_id = rc.page_id AND vc.voter_id = rc.voter_id
   WHERE rc.status = 'pending' AND vc.direction = 0;
  PERFORM pg_temp.chk('S7', 'I7:pending 候选与「已是撤票终态」不矛盾', v_bad = 0);

  -- 事实表全部落在正确分区(pdefault 必须恒空)
  PERFORM pg_temp.chk('S7', 'vote_event_pdefault 恒空(非空 = 分区滚动脚本失职)',
    (SELECT count(*)::int FROM ONLY ingest.vote_event_pdefault) = 0);
  PERFORM pg_temp.chk('S7', '全部 vote_event 落在 p0000 冷回填分区',
    (SELECT count(*) FROM ONLY ingest.vote_event_p0000)
      = (SELECT count(*) FROM ingest.vote_event));
END $$;


-- =====================================================================================
-- S8. R10 熔断物理开关(0007 §2 meta.write_freeze)
-- =====================================================================================
-- 覆盖:入口断言真的拦住写入 / 只拦对应域 / 总闸传导 / meta.* 证据链不被冻结 /
--       逃生舱 / 拼写守卫 / 释放后恢复。
-- 注意本节全部在冒烟事务内,末尾 ROLLBACK ⇒ 不会把库留在冻结态。
DO $$
DECLARE
  v_page int := pg_temp.fxget('p1')::int;
  v_run  bigint := pg_temp.fxget('run');
  v_n0 int; v_n1 int;
BEGIN
  PERFORM pg_temp.chk('S8', '初始状态:9 个域全部登记且未冻结',
    (SELECT count(*)::int FROM meta.write_freeze) = 9
    AND NOT EXISTS (SELECT 1 FROM meta.write_freeze WHERE frozen));

  -- ---- 冻结 vote 域 -----------------------------------------------------------------
  PERFORM meta.freeze_writes('vote', '冒烟:模拟 R10 越界', 'smoke', 'avg_votes_per_page', v_run);
  PERFORM pg_temp.chk('S8', 'freeze_writes:frozen/reason/frozen_at/freeze_count 全部落库',
    (SELECT frozen AND reason = '冒烟:模拟 R10 越界' AND frozen_at IS NOT NULL
            AND frozen_by = 'smoke' AND breach_metric = 'avg_votes_per_page'
            AND breach_run = v_run AND freeze_count >= 1
       FROM meta.write_freeze WHERE domain = 'vote'));
  PERFORM pg_temp.chk('S8', 'write_freeze_status:vote 的 effective=true,别的域 effective=false',
    (SELECT effective FROM meta.write_freeze_status('vote'))
    AND NOT (SELECT effective FROM meta.write_freeze_status('revision')));
  PERFORM pg_temp.chk('S8', '冻结告警视图:新冻结为 active，未误标 overdue',
    (SELECT direct_frozen AND effective_frozen AND alert_state = 'active' AND NOT overdue
       FROM meta.write_freeze_alert_state WHERE domain = 'vote'));
  UPDATE meta.write_freeze
     SET frozen_at = now() - interval '31 minutes'
   WHERE domain = 'vote';
  PERFORM pg_temp.chk('S8', '冻结告警视图:持续超过 30 分钟显式标 overdue',
    (SELECT overdue AND alert_state = 'overdue'
       FROM meta.write_freeze_alert_state WHERE domain = 'vote'));
  UPDATE meta.write_freeze SET frozen_at = now() WHERE domain = 'vote';

  -- 重复冻结不累加 freeze_count(同一次事故里多页各触发一次不算多次跳闸)
  SELECT freeze_count INTO v_n0 FROM meta.write_freeze WHERE domain = 'vote';
  PERFORM meta.freeze_writes('vote', '冒烟:同一事故的第二次触发', 'smoke');
  SELECT freeze_count INTO v_n1 FROM meta.write_freeze WHERE domain = 'vote';
  PERFORM pg_temp.chk('S8', '已冻结时重复 freeze_writes 不累加 freeze_count',
    v_n1 = v_n0, format('%s → %s', v_n0, v_n1));

  -- ---- 冻结期 meta.* 证据链必须照常写入(「冻结写入,不冻结采集」)-------------------
  -- kind 用 'discussion':同 (run,page,'votes') 的证据行在 S3 已存在,
  -- 走 ON CONFLICT DO UPDATE 不会让计数变化,那样断言就测不到东西了。
  SELECT count(*)::int INTO v_n0 FROM meta.page_scan;
  PERFORM meta.record_page_scan(v_run, v_page, 'discussion', 'ok', 1, 1, NULL, NULL, NULL, NULL,
                                '冻结期证据');
  SELECT count(*)::int INTO v_n1 FROM meta.page_scan;
  PERFORM pg_temp.chk('S8★', '冻结期 meta.record_page_scan 照常写入(冻结的是写入不是采集)',
    v_n1 = v_n0 + 1, format('%s → %s', v_n0, v_n1));

  PERFORM meta.note_freeze_skip(v_run, v_page, 'votes', 'vote', '冒烟');
  PERFORM pg_temp.chk('S8★', 'note_freeze_skip 留下 write_frozen:<domain> 证据',
    (SELECT status = 'failed' AND error LIKE 'write_frozen:vote%'
       FROM meta.page_scan WHERE run_id = v_run AND page_id = v_page AND kind = 'votes'));

  -- ---- 逃生舱 -------------------------------------------------------------------------
  SET LOCAL scpper.freeze_bypass = 'on';
  PERFORM meta.assert_writes_allowed('vote');     -- 不抛错(只 WARNING)
  PERFORM pg_temp.chk('S8', '逃生舱 scpper.freeze_bypass=on ⇒ 冻结域放行(仅 WARNING)', true);
  SET LOCAL scpper.freeze_bypass = 'off';

  -- ---- 释放 -------------------------------------------------------------------------
  PERFORM meta.release_writes('vote', 'smoke');
  PERFORM pg_temp.chk('S8', 'release_writes:frozen=false 且 reason/breach_* 保留(释放≠没发生过)',
    (SELECT NOT frozen AND released_at IS NOT NULL AND released_by = 'smoke'
            AND reason IS NOT NULL AND breach_metric = 'avg_votes_per_page'
       FROM meta.write_freeze WHERE domain = 'vote'));
  PERFORM meta.assert_writes_allowed('vote');
  PERFORM pg_temp.chk('S8', '释放后 assert_writes_allowed 恢复放行', true);
END $$;

-- 冻结期写事实必须抛 PGF01(逐个域各打一枪:域隔离 + 总闸传导)
SELECT meta.freeze_writes('vote', '冒烟:PGF01 用例', 'smoke');
SELECT pg_temp.expect_error('S8★', 'vote 冻结 ⇒ apply_vote_observation 抛 PGF01',
  $$ SELECT ingest.apply_vote_observation(pg_temp.fxget('p1')::int, pg_temp.fxget('u1')::int,
                                          1, now(), now(), 'observed', 'wikidot', NULL) $$,
  'PGF01');
SELECT pg_temp.expect_error('S8★', 'vote 冻结 ⇒ apply_vote_snapshot 抛 PGF01',
  $$ SELECT ingest.apply_vote_snapshot(pg_temp.fxget('p1')::int, '[]'::jsonb, true, 0, 0) $$,
  'PGF01');
DO $$
BEGIN
  -- 域隔离:vote 冻结不影响 revision / attribution / forum / identity
  PERFORM ingest.apply_revision_batch(pg_temp.fxget('p1')::int, '[]'::jsonb, NULL, now(),
                                      'wikidot', pg_temp.fxget('run'));
  PERFORM pg_temp.chk('S8★', '域隔离:vote 冻结不拦 apply_revision_batch', true);
  PERFORM ingest.apply_forum_batch('[]'::jsonb, '[]'::jsonb, '[]'::jsonb, now(), 'wikidot',
                                   pg_temp.fxget('run'));
  PERFORM pg_temp.chk('S8★', '域隔离:vote 冻结不拦 apply_forum_batch', true);
END $$;
SELECT meta.release_writes('vote', 'smoke');

-- 总闸 'all':一条命令停掉全部写入域
SELECT meta.freeze_writes('all', '冒烟:总闸', 'smoke');
SELECT pg_temp.expect_error('S8★', '总闸 all ⇒ apply_revision_batch 也抛 PGF01',
  $$ SELECT ingest.apply_revision_batch(pg_temp.fxget('p1')::int, '[]'::jsonb, NULL, now(),
                                        'wikidot', pg_temp.fxget('run')) $$, 'PGF01');
SELECT pg_temp.expect_error('S8★', '总闸 all ⇒ apply_attribution_snapshot 也抛 PGF01',
  $$ SELECT ingest.apply_attribution_snapshot(pg_temp.fxget('p1')::int, '[]'::jsonb, true,
                                              now(), 'wikidot') $$, 'PGF01');
SELECT pg_temp.expect_error('S8★', '总闸 all ⇒ ensure_user(身份铸造)也抛 PGF01',
  $$ SELECT ingest.ensure_user('wikidot', 999000111) $$, 'PGF01');
SELECT pg_temp.expect_error('S8★', '总闸 all ⇒ put_content_blob 也抛 PGF01',
  $$ SELECT ingest.put_content_blob('freeze test') $$, 'PGF01');
SELECT pg_temp.expect_error('S8★', '总闸 all ⇒ apply_page_meta 也抛 PGF01',
  $$ SELECT ingest.apply_page_meta(pg_temp.fxget('p1')::int, '{"title":"x"}'::jsonb,
                                   now(), 'wikidot') $$, 'PGF01');
SELECT pg_temp.expect_error('S8★', '总闸 all ⇒ apply_page_life 也抛 PGF01',
  $$ SELECT ingest.apply_page_life(pg_temp.fxget('p1')::int, 'restored', now(), 'exact',
                                   now(), 'crom') $$, 'PGF01');
SELECT pg_temp.expect_error('S8★', '总闸 all ⇒ promote_revoke_candidates 也抛 PGF01',
  $$ SELECT ingest.promote_revoke_candidates() $$, 'PGF01');
SELECT meta.release_writes('all', 'smoke');

-- 拼写守卫:未登记的域名必须抛 23503,而不是「查不到 ⇒ 放行」
SELECT pg_temp.expect_error('S8', 'assert_writes_allowed:未登记域名抛 23503(拼错不等于放行)',
  $$ SELECT meta.assert_writes_allowed('votes') $$, '23503');
SELECT pg_temp.expect_error('S8', 'assert_writes_allowed:p_domain=''all'' 非法(它是存储域不是调用域)',
  $$ SELECT meta.assert_writes_allowed('all') $$, '22023');
SELECT pg_temp.expect_error('S8', 'freeze_writes:未登记域名抛 23503',
  $$ SELECT meta.freeze_writes('nope', '理由') $$, '23503');
SELECT pg_temp.expect_error('S8', 'freeze_writes:空理由抛 22004(没有理由的冻结无法裁决)',
  $$ SELECT meta.freeze_writes('vote', '   ') $$, '22004');
DO $$
BEGIN
  PERFORM pg_temp.chk('S8', '异常路径后没有残留冻结(全部 9 域 frozen=false)',
    NOT EXISTS (SELECT 1 FROM meta.write_freeze WHERE frozen));
END $$;


-- =====================================================================================
-- S9. 证据链不静默丢失 + 投影登记 + 0008 建模决策
-- =====================================================================================
DO $$
DECLARE
  v_page int := pg_temp.fxget('p1')::int;
  v_syn  bigint;
  v_n0 int; v_n1 int;
BEGIN
  -- ---- 9.1 record_page_scan 缺 run_id ⇒ 合成 run,证据绝不丢 ------------------------
  SELECT count(*)::int INTO v_n0 FROM meta.page_scan;
  PERFORM meta.record_page_scan(NULL, v_page, 'content', 'ok', NULL, NULL,
                                NULL, NULL, NULL, NULL, '缺 run_id 的观测');
  SELECT count(*)::int INTO v_n1 FROM meta.page_scan;
  PERFORM pg_temp.chk('S9★', 'record_page_scan(run=NULL):证据仍然落库(初版是静默 RETURN)',
    v_n1 = v_n0 + 1, format('%s → %s', v_n0, v_n1));

  SELECT id INTO v_syn FROM meta.ingest_run WHERE source = 'synthetic'
   ORDER BY id DESC LIMIT 1;
  PERFORM pg_temp.chk('S9★', '合成 run 已创建且 source=''synthetic''', v_syn IS NOT NULL);
  PERFORM pg_temp.chk('S9★', '合成 run 的 status=''running'' 且 coverage_ratio 为 NULL'
                             '(⇒ 永不授权 absence/删除推断)',
    (SELECT status = 'running' AND coverage_ratio IS NULL
       FROM meta.ingest_run WHERE id = v_syn));
  PERFORM pg_temp.chk('S9★', '合成 run 的 stats 带 synthetic 标记与来由',
    (SELECT (stats ->> 'synthetic')::boolean AND stats ? 'reason'
       FROM meta.ingest_run WHERE id = v_syn));
  PERFORM pg_temp.chk('S9★', '证据行挂在合成 run 上',
    EXISTS (SELECT 1 FROM meta.page_scan
             WHERE run_id = v_syn AND page_id = v_page AND kind = 'content'));

  -- 同会话第二次缺 run_id ⇒ 复用同一个合成 run(不把 ingest_run 撑爆)
  PERFORM meta.record_page_scan(NULL, v_page, 'files', 'ok');
  PERFORM pg_temp.chk('S9★', '同会话再次缺 run_id ⇒ 复用同一合成 run',
    (SELECT count(*)::int FROM meta.ingest_run WHERE source = 'synthetic') = 1
    AND EXISTS (SELECT 1 FROM meta.page_scan WHERE run_id = v_syn AND kind = 'files'));

  -- 合成 run 不得授权删除推断(与 apply_page_life 的 run 级门控联动)
  PERFORM pg_temp.chk('S9★', '合成 run 的 status<>''ok'' ⇒ 删除推断门控必拒',
    (SELECT status <> 'ok' FROM meta.ingest_run WHERE id = v_syn));

  -- ---- 9.2 page_scan / scan_task 词表补齐(0007 §1)---------------------------------
  PERFORM pg_temp.chk('S9', 'page_scan.kind 接受 ''discussion''(0007 补齐)',
    (SELECT count(*)::int FROM meta.page_scan WHERE kind = 'files') >= 1);
  INSERT INTO meta.scan_task(page_id, kind, reasons)
  VALUES (v_page, 'forum', '{smoke}'), (v_page, 'discussion', '{smoke}'),
         (v_page, 'files', '{smoke}')
  ON CONFLICT (page_id, kind) DO NOTHING;
  PERFORM pg_temp.chk('S9', 'scan_task.kind 接受 forum / discussion / files(0007 补齐)',
    (SELECT count(*)::int FROM meta.scan_task
      WHERE page_id = v_page AND kind IN ('forum','discussion','files')) = 3);

  -- ---- 9.3 投影登记清单(0007 §3)-----------------------------------------------------
  -- 不写死 27:serve 会继续长表(实测并行任务当天加了 4 张语义检索表)。
  -- 断言「登记数 = serve 的 Tier-2 表数」才是不随扩表失效的那条。
  PERFORM pg_temp.chk('S9', 'projection_cursor 登记数 = serve 的 Tier-2 表数(全覆盖)',
    (SELECT count(*)::int FROM meta.projection_cursor WHERE projection LIKE 'serve.%')
      = (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'serve' AND c.relkind = 'r'
            AND c.relname NOT IN ('vote_current','attribution_current','page_current')));
  PERFORM pg_temp.chk('S9', 'Tier-1 三表**不**登记(它们与事实同事务,无游标语义)',
    NOT EXISTS (SELECT 1 FROM meta.projection_cursor
                 WHERE projection IN ('serve.vote_current','serve.attribution_current',
                                      'serve.page_current')));
  -- 存储口径 = COMMENT ON TABLE 整条逐字(含 'rebuild_from=' 前缀),见 0007 §3
  SELECT count(*)::int INTO v_n0
    FROM meta.projection_cursor pc
    JOIN pg_class c ON c.oid = to_regclass(pc.projection)
   WHERE pc.projection LIKE 'serve.%'
     AND pc.rebuild_from IS DISTINCT FROM obj_description(c.oid,'pg_class');
  PERFORM pg_temp.chk('S9★', 'rebuild_from 与 COMMENT ON TABLE 逐字一致(0 处漂移)',
    v_n0 = 0, format('%s 处漂移', v_n0));
  PERFORM pg_temp.chk('S9', '每个登记投影都能取到窗口(不再抛 23503)',
    (SELECT count(*)::int FROM meta.projection_cursor pc
      WHERE pc.projection LIKE 'serve.%'
        AND NOT EXISTS (SELECT 1 FROM meta.projection_window(pc.projection))) >= 0);

  -- ---- 9.4 0008 建模决策:红链 + 标签维度趋势 ----------------------------------------
  INSERT INTO serve.page_reference(from_page_id, to_page_id, kind, target_slug, target_path)
  VALUES (v_page, NULL, 'link', 'scp-cn-does-not-exist', '/SCP-CN-Does-Not-Exist#s1');
  PERFORM pg_temp.chk('S9★', '红链可入库(to_page_id 为空,0008 前主键不允许)',
    (SELECT count(*)::int FROM serve.page_reference
      WHERE from_page_id = v_page AND to_page_id IS NULL) = 1);
  -- 红链变蓝 = 原地填 to_page_id,主键不变、零搬迁
  UPDATE serve.page_reference SET to_page_id = pg_temp.fxget('p2')::int
   WHERE from_page_id = v_page AND target_slug = 'scp-cn-does-not-exist';
  PERFORM pg_temp.chk('S9★', '红链变蓝只需原地填 to_page_id(主键 (from,target_slug,kind) 不变)',
    (SELECT count(*)::int FROM serve.page_reference
      WHERE from_page_id = v_page AND target_slug = 'scp-cn-does-not-exist'
        AND to_page_id IS NOT NULL) = 1);
  PERFORM pg_temp.chk('S9', 'normalize_target_slug 归一化(去主机/去 fragment/小写/去斜杠)',
    serve.normalize_target_slug('https://scp-wiki-cn.wikidot.com/SCP-CN-1000#toc0')
      = 'scp-cn-1000'
    AND serve.normalize_target_slug('/Foo/') = 'foo'
    AND serve.normalize_target_slug('') IS NULL);

  INSERT INTO serve.trending_stats(entity_type, entity_id, entity_key, period, score, label)
  VALUES ('tag', NULL, '原创', '7d', 12.5, '原创'),
         ('page:rating_delta', v_page, v_page::text, '7d', 3.0, 'p1');
  PERFORM pg_temp.chk('S9★', '标签维度趋势可入库(entity_type=''tag'' + entity_key 文本,'
                             'entity_id 为空;0008 前 NOT NULL 挡死)',
    (SELECT count(*)::int FROM serve.trending_stats
      WHERE entity_type = 'tag' AND entity_id IS NULL AND entity_key = '原创') = 1);
  PERFORM pg_temp.chk('S9', 'int 实体仍可与 entity_id 并存(读侧 JOIN 走 entity_id)',
    (SELECT count(*)::int FROM serve.trending_stats
      WHERE entity_id = v_page AND entity_key = v_page::text) = 1);
END $$;

SELECT pg_temp.expect_error('S9★', 'trending_stats:entity_key 与 entity_id 不一致 ⇒ CHECK 拒绝'
                                   '(否则同一页可在榜上出现两次)',
  $$ INSERT INTO serve.trending_stats(entity_type, entity_id, entity_key, period, score)
     VALUES ('page:x', 12345, '012345', '7d', 1.0) $$, '23514');
SELECT pg_temp.expect_error('S9', 'trending_stats:entity_key 空串 ⇒ CHECK 拒绝',
  $$ INSERT INTO serve.trending_stats(entity_type, entity_id, entity_key, period, score)
     VALUES ('tag', NULL, '', '7d', 1.0) $$, '23514');
SELECT pg_temp.expect_error('S9', 'page_reference:target_slug 必须已归一化(小写)',
  $$ INSERT INTO serve.page_reference(from_page_id, kind, target_slug, target_path)
     VALUES (pg_temp.fxget('p1')::int, 'link', 'SCP-CN-UPPER', '/x') $$, '23514');
SELECT pg_temp.expect_error('S9★', 'record_page_scan:scpper.require_run_id=on ⇒ 缺 run_id 硬失败',
  $$ SET LOCAL scpper.require_run_id = 'on';
     SELECT meta.record_page_scan(NULL, pg_temp.fxget('p1')::int, 'meta', 'ok') $$, '22004');


-- =====================================================================================
-- 报告
-- =====================================================================================
\o
\echo ''
\echo '=================== 冒烟结果:逐节汇总 ==================='
SELECT section AS "节", count(*) AS "用例", count(*) FILTER (WHERE ok) AS "通过",
       count(*) FILTER (WHERE NOT ok) AS "失败"
  FROM smoke_log GROUP BY section ORDER BY section;

\echo ''
\echo '=================== 失败明细(空 = 全绿)==================='
SELECT id, section AS "节", name AS "用例", detail AS "说明"
  FROM smoke_log WHERE NOT ok ORDER BY id;

\echo ''
\echo '=================== 总计 ==================='
SELECT count(*) AS "用例总数", count(*) FILTER (WHERE ok) AS "通过",
       count(*) FILTER (WHERE NOT ok) AS "失败"
  FROM smoke_log;

DO $$
DECLARE v_fail int; v_all int;
BEGIN
  SELECT count(*) FILTER (WHERE NOT ok), count(*) INTO v_fail, v_all FROM smoke_log;
  IF v_all = 0 THEN
    RAISE EXCEPTION '冒烟测试一个用例都没跑到 —— 脚本本身有问题';
  END IF;
  IF v_fail > 0 THEN
    RAISE EXCEPTION '冒烟测试失败:% / % 个用例未通过(明细见上)', v_fail, v_all;
  END IF;
  RAISE NOTICE '冒烟测试全绿:% 个用例全部通过', v_all;
END $$;

-- 不留任何测试数据:整个文件的写入在此全部撤回。
ROLLBACK;
